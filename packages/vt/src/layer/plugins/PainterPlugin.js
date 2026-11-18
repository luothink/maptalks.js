import easing from 'animation-easings';
import { createFilter } from '@maptalks/feature-filter';
import VectorTilePlugin from '@maptalks/vt-plugin';
import Color from 'color';

const DEFAULT_ANIMATION_DURATION = 800;

const NO_REDRAW = {
    redraw: false,
    retire: false
};

const EMPTY_ARRAY = [];

// 跨帧复用 mesh 时，离开视口的瓦片原本只在"相机完全静止且无瓦片加载"的帧才清理；
// 持续拖动/旋转/加载时该条件几乎永不成立，导致 scene 中的 mesh 无界增长，
// 每帧排序/绘制/求交开销随 mesh 数持续上升，最终表现为掉帧乃至浏览器无响应。
// 因此增加两道兜底：
//  1) STALE_FRAME_LIMIT：连续若干帧未被绘制且不在视口内的 mesh 视为陈旧，可安全移除；
//  2) MAX_RETAINED_TILE_MESHES：保留数量上限，超出时按最久未绘制优先移除。
// 缩放过渡期间（isZooming）仍保留旧 zoom 背景瓦片，不执行以上清理以免画面闪空。
const STALE_FRAME_LIMIT = 60;
const MAX_RETAINED_TILE_MESHES = 256;

let meshUID = 1;
/**
 * Create a VT Plugin with a given painter
 * 【中文】使用指定的 Painter 类创建一个矢量瓦片渲染插件（VT Plugin），
 * 【中文】用于将该 painter 的绘制结果（mesh / stencil / 纹理）合并到图层的场景中。
 */
function createPainterPlugin(type, Painter) {
    const PainterPlugin = VectorTilePlugin.extend(type, {

        init: function () {
            this._meshCache = {};
            // 缓存每个瓦片 key 对应的 stencil level 值，跨帧复用 mesh 场景下，
            // 当 level 未变化时跳过对每个 mesh 的属性写入操作，降低 CPU 开销。
            this._tileLevels = {};
            // 递增的帧计数，用于记录每个 mesh 最近一次被绘制的帧，供陈旧清理判断。
            this._frameIndex = 0;
        },

        isVisible() {
            return this.painter && this.painter.isVisible();
        },

        supportRenderMode: function (mode) {
            return this.painter.supportRenderMode(mode);
        },

        hasMesh() {
            return this.painter && this.painter.hasMesh();
        },

        startFrame: function (context) {
            const layer = context.layer,
                regl = context.regl,
                sceneConfig = context.sceneConfig,
                dataConfig = context.dataConfig,
                symbol = context.symbol;
            let painter = this.painter;
            if (!painter) {
                const pluginIndex = context.pluginIndex;
                painter = this.painter = new Painter(regl, layer, symbol, sceneConfig, pluginIndex, dataConfig);
            }
            if (!this._meshCache) {
                this._meshCache = {};
            }
            const excludes = sceneConfig.excludes;
            if (!this._excludes) {
                if (excludes) {
                    this._excludes = excludes;
                }
            } else if (excludes !== this._excludes) {
                this._excludesFunc = excludes ? createFilter(excludes) : null;
                this._excludes = excludes;
            }
            //无入场动画且非地形矢量时，mesh 跨帧持久保留（仅新增/删除 tile 时更新），
            //避免每帧全量 clear + 重新 addMesh + 排序，显著降低拖动/静止时的 CPU 开销
            const hasAnimation = !!sceneConfig.animation;
            const isTerrainVector = !!(painter.isTerrainVector && painter.isTerrainVector());
            this._hasAnimation = hasAnimation;
            this._frameIndex = (this._frameIndex || 0) + 1;
            if (hasAnimation || isTerrainVector) {
                //有入场动画或地形矢量时，维持每帧重建 mesh 的旧行为
                painter.startFrame(context);
                this._frameCache = {};
                this._paintedKeys = null;
            } else {
                painter.startFrame(context, true);
                if (!this._frameCache) {
                    this._frameCache = {};
                }
                this._paintedKeys = {};
            }
        },

        updateCollision: function (context) {
            const painter = this.painter;
            if (painter && painter.isVisible()) {
                return painter.updateCollision(context);
            }
            return null;
        },

        prepareRender: function (context) {
            const painter = this.painter;
            if (painter && painter.isVisible()) {
                return painter.prepareRender(context);
            }
            return null;
        },

        endFrame: function (context) {
            const painter = this.painter;
            if (painter && painter.isVisible()) {
                // 移除本帧未绘制的 tile mesh（tile 离开视口），保留 mesh 缓存以便复用。
                // 以下两种情况本帧未绘制的 tile 可能仍在视口，不能清理：
                // 1. 交互/动画过程中（旧 zoom 过渡瓦片仍作为背景显示）；
                // 2. 相机已静止但瓦片仍在异步加载（tilesLoading 非空）：
                //    此时旧 zoom 的背景 mesh 不再被 paintTile，但新瓦片尚未就绪，
                //    一旦清理会把仍在屏幕上的背景瓦片移除，造成出图后消失/大面积空白。
                // 因此：
                //  - 完全静止且无加载：全量清理（原有行为）；
                //  - 交互(拖动/旋转)/加载中：执行有限清理（仅移除长期未绘制且不在视口内的
                //    mesh，并限制保留数量上限），避免持续交互时 mesh 无界增长；
                //  - 缩放过渡中：保留旧 zoom 背景瓦片，不清理以免画面闪空。
                if (this._paintedKeys) {
                    const map = context.layer && context.layer.getMap && context.layer.getMap();
                    const isInteracting = !!(map && map.isInteracting && map.isInteracting());
                    const isMoving = !!(map && map.isMoving && map.isMoving());
                    const isZooming = !!(map && map.isZooming && map.isZooming());
                    const renderer = context.layer && context.layer.getRenderer && context.layer.getRenderer();
                    const tilesLoadingCount = renderer && renderer.tilesLoading ? Object.keys(renderer.tilesLoading).length : 0;
                    const isStill = !isInteracting && !isMoving && !isZooming && tilesLoadingCount === 0;
                    if (isStill) {
                        this._removeStaleTileMeshes(context, true);
                    } else if (!isZooming) {
                        this._removeStaleTileMeshes(context, false);
                    }
                    this._paintedKeys = null;
                }
                this._flushDisposeQueue();
                return painter.render(context);
            }
            return null;
        },

        // 清理瓦片数据刷新时延迟 dispose 的旧 mesh（新 mesh 已加入 scene 后再释放，
        // 避免缩放重解析期间出现帧间空白）
        _flushDisposeQueue() {
            const queue = this._disposeQueue;
            if (queue && queue.length) {
                this._disposeQueue = [];
                for (let i = 0; i < queue.length; i++) {
                    if (queue[i]) {
                        this.painter.deleteMesh(queue[i]);
                    }
                }
            }
        },

        // aggressive=true：全量清理本帧未绘制的 mesh（相机完全静止时使用，原有行为）。
        // aggressive=false：有限清理，仅移除已连续多帧未绘制（STALE_FRAME_LIMIT）且不在
        //   视口内的 mesh；若保留数量仍超过上限（MAX_RETAINED_TILE_MESHES），
        //   再按最久未绘制优先继续移除，保证 scene 中的 mesh 规模有界。
        _removeStaleTileMeshes(context, aggressive) {
            const frameCache = this._frameCache;
            const paintedKeys = this._paintedKeys;
            const meshCache = this._meshCache;
            if (!frameCache) {
                return;
            }
            // 第二道防线：瓦片 id 级别判断。
            // 某些情况下瓦片仍位于当前视口（tilesInView）但本帧未被 paintTile
            // （例如瓦片数据重解析的过渡帧），此时必须保留其 mesh 作为背景，
            // 否则会出现局部区域出图后消失。
            const renderer = context && context.layer && context.layer.getRenderer && context.layer.getRenderer();
            const tilesInView = renderer && renderer.tilesInView;
            const currentFrame = this._frameIndex || 0;
            const staleBefore = currentFrame - STALE_FRAME_LIMIT;

            let total = 0;
            const stale = [];
            const pending = [];
            for (const key in frameCache) {
                total++;
                if (paintedKeys && paintedKeys[key]) {
                    continue;
                }
                const meshes = meshCache[key];
                if (tilesInView && meshes && meshes.length) {
                    const tile = meshes[0].properties && meshes[0].properties.tile;
                    if (tile && tile.id && tilesInView[tile.id]) {
                        // 瓦片仍在视口内，仅本帧未绘制（数据加载/过渡），保留背景 mesh
                        continue;
                    }
                }
                if (aggressive || frameCache[key] <= staleBefore) {
                    stale.push(key);
                } else {
                    pending.push(key);
                }
            }

            // 数量上限兜底：交互期间即使尚未达到陈旧阈值，也不允许保留量无界增长，
            // 超出上限时按最久未绘制优先补充移除。
            let toRemove = stale;
            const excess = total - MAX_RETAINED_TILE_MESHES;
            if (!aggressive && excess > 0 && stale.length < excess && pending.length) {
                pending.sort((a, b) => frameCache[a] - frameCache[b]);
                toRemove = stale.concat(pending.slice(0, excess - stale.length));
            }
            if (!toRemove.length) {
                return;
            }

            const meshesToRemove = [];
            for (let i = 0; i < toRemove.length; i++) {
                const key = toRemove[i];
                const meshes = meshCache[key];
                if (meshes && meshes.length) {
                    meshesToRemove.push(meshes);
                }
                delete frameCache[key];
                if (this._tileLevels) {
                    delete this._tileLevels[key];
                }
            }
            for (let i = 0; i < meshesToRemove.length; i++) {
                this.painter.removeMeshFromScene(meshesToRemove[i]);
            }
        },

        getShadowMeshes() {
            const painter = this.painter;
            if (!painter || !painter.getShadowMeshes) {
                return EMPTY_ARRAY;
            }
            return painter.getShadowMeshes() || EMPTY_ARRAY;
        },

        createTile: function (context) {
            const {
                tileCache,
                tileData,
                tileInfo
            } = context;
            let retire = false;
            const painter = this.painter;
            if (!painter) {
                return { retire };
            }
            let geometries = tileCache.geometry;
            if (!geometries) {
                const features = tileData.features;
                const glData = tileData.data;
                if (!glData || !glData.length) {
                    return { retire };
                }
                const data = glData;
                for (let i = 0; i < glData.length; i++) {
                    data[i].tileInfo = tileInfo;
                }
                // 目前只有native-line和wireframe会用到
                if (this.painter.colorSymbol && !isObjectEmpty(features)) {
                    for (let i = 0; i < glData.length; i++) {
                        const colors = this._generateColorArray(features, glData[i].data.aPickingId, glData[i].indices, glData[i].data.aPosition, glData[i].positionSize);
                        glData[i].data.aColor = colors;
                    }
                }
                geometries = tileCache.geometry = painter.createGeometries(data, features);
                for (let i = 0; i < geometries.length; i++) {
                    if (geometries[i] && geometries[i].geometry) {
                        retire = true;
                        geometries[i].geometry.properties.features = features;
                        this._fillCommonProps(geometries[i].geometry, context);
                    }
                }
            }

            let meshes = tileCache.meshes;
            if (!meshes) {
                // 当前 zoom 不在 sceneConfig 的 [minZoom, maxZoom] 范围内时跳过 mesh 构建
                // geometry 已构建,当 zoom 回到范围内时 paintTile 会懒加载构建 mesh
                if (!painter.isVisible()) {
                    return { retire };
                }
                const result = this._createMeshes(geometries, context);
                this._cacheMeshes(context, result && result.meshes);
                if (!result) {
                    return { retire, loading: true };
                }
            }
            return { retire };
        },

        _cacheMeshes(context, meshes) {
            const { tileCache } = context;
            const meshKey = this._getMeshKey(context);
            const oldMeshes = this._getMesh(meshKey);
            if (oldMeshes) {
                if (meshes && meshes.length) {
                    // 瓦片数据刷新（缩放重解析等）时新 mesh 尚未加入场景，
                    // 延迟到新 mesh 加入 scene 后的 endFrame 再 dispose 旧 mesh，
                    // 避免本帧出现空白（旧数据继续显示直到新 mesh 就位）。
                    if (!this._disposeQueue) {
                        this._disposeQueue = [];
                    }
                    this._disposeQueue.push(oldMeshes);
                } else {
                    // 新 mesh 不可用，直接释放旧 mesh
                    this.painter.deleteMesh(oldMeshes);
                }
            }
            tileCache.meshes = meshes;
            this._meshCache[meshKey] = meshes;
            if (this._frameCache) {
                // 重新创建的 mesh 需要重新加入场景
                delete this._frameCache[meshKey];
            }
            if (this._tileLevels) {
                delete this._tileLevels[meshKey];
            }
        },

        _createMeshes(geometries, context) {
            const {
                tileInfo,
                tileExtent,
                tileTransform,
                tileTranslationMatrix,
                tileVectorTransform,
                tileZoom,
                sceneConfig
            } = context;
            let retire = false;
            const painter = this.painter;
            const tilePoint = [tileInfo.extent2d.xmin, tileInfo.extent2d.ymax];
            const meshes = painter.createMeshes(geometries, tileTransform, { tileExtent, tilePoint, tileZoom, tileTranslationMatrix, tileVectorTransform }, context);
            if (!meshes) {
                return null;
            }
            if (meshes.length) {
                for (let i = 0; i < meshes.length; i++) {
                    if (meshes[i]) {
                        retire = true;
                        this._fillMeshProps(meshes[i], tileTransform, context.timestamp, meshUID++, painter.isEnableTileStencil());
                    }
                }
                if (sceneConfig.animation) {
                    meshes._animationTime = context.timestamp;
                }
            }
            return { meshes, retire };
        },

        paintTile: function (context) {
            const {
                tileCache,
                tileInfo,
                tileZoom,
                sceneConfig
            } = context;
            const painter = this.painter;
            if (!painter) {
                return NO_REDRAW;
            }

            let geometries = tileCache.geometry;
            if (!geometries) {
                return NO_REDRAW;
            }
            // 当前 zoom 不在 sceneConfig 的 [minZoom, maxZoom] 范围内时跳过 mesh 构建和添加
            // 已有 mesh 不会添加到场景,endFrame 也会跳过 render
            if (!painter.isVisible()) {
                return NO_REDRAW;
            }
            let retire = false;
            const key = this._getMeshKey(context);
            let meshes = this._getMesh(key);
            if (!meshes) {
                const result  = this._createMeshes(geometries, context);
                this._cacheMeshes(context, result && result.meshes);
                if (!result) {
                    return NO_REDRAW;
                }
                const { meshes: newMeshes, retire: isRetire } = result;
                if (!retire) {
                    retire = isRetire;
                }
                meshes = newMeshes;
            }
            if (!meshes.length) {
                return NO_REDRAW;
            }
            if (this._paintedKeys) {
                this._paintedKeys[key] = 1;
            }

            //更新stencil level值，不同zoom会发生变化
            // level 未变化时跳过 per-mesh 属性更新（跨帧复用 mesh 场景时，避免每帧对每个 mesh 写属性）
            const level = painter.getTileLevelValue(tileInfo, tileZoom);//getUniformLevel(tileInfo.z, tileZoom);
            if (!this._tileLevels || this._tileLevels[key] !== level) {
                if (!this._tileLevels) {
                    this._tileLevels = {};
                }
                for (let i = 0, len = meshes.length; i < len; i++) {
                    const m = meshes[i];
                    // 保留一些有用的信息
                    m.properties.tile = tileInfo;
                    m.properties.level = level;
                }
                this._tileLevels[key] = level;
            }

            let redraw = false;
            if (!this._frameCache[key]) {
                let progress = null;
                let animation = sceneConfig.animation;
                const map = context.layer && context.layer.getMap && context.layer.getMap();
                const isInteracting = map && map.isInteracting && map.isInteracting();
                // 交互过程中优先保证缩放/平移流畅度，跳过 tile 的入场动画，
                // 避免文字/图标在持续加载时反复申请 redraw。
                if (animation && !isInteracting) {
                    const duration = context.sceneConfig.animationDuration || DEFAULT_ANIMATION_DURATION;
                    const t = (context.timestamp - meshes._animationTime) / duration;
                    const createTime = meshes[0].properties.createTime;
                    if (meshes._animationTime - createTime < duration && t < 1) {
                        if (animation === true || animation === 1) {
                            animation = 'linear';
                        }
                        progress = animation === 'linear' ? t : easing(animation, t);
                        redraw = true;
                    }
                }

                painter.addMesh(meshes, progress, context);
                // 记录最近一次绘制该 mesh 的帧号，供陈旧清理（_removeStaleTileMeshes）判断。
                this._frameCache[key] = this._frameIndex || 0;
            }

            return {
                redraw,
                retire
            };
        },

        _fillMeshProps: function (mesh, tileTransform, timestamp, key, enableTileStencil) {
            mesh.properties.tileTransform = tileTransform;
            mesh.properties.createTime = timestamp;
            mesh.properties.meshKey = key;
            mesh.needUpdateShadow = true;
            if (enableTileStencil) {
                const defines = mesh.defines || {};
                defines['ENABLE_TILE_STENCIL'] = 1;
                mesh.setDefines(defines);
            }
            if (!('stencilRef' in mesh.uniforms)) {
                Object.defineProperty(mesh.uniforms, 'stencilRef', {
                    enumerable: true,
                    get: function () {
                        // return mesh.properties.tile ? mesh.properties.tile.stencilRef : 255;
                        if (mesh.properties.tile && mesh.properties.tile.stencilRef !== undefined) {
                            return mesh.properties.tile.stencilRef;
                        }
                        // return maxZoom - mesh.properties.tile.z;
                        return mesh.properties.level;
                    }
                });
            }
        },

        _fillCommonProps: function (geometry, context) {
            const { layer, tileInfo } = context;
            const map = layer.getMap(),
                sr = layer.getSpatialReference ? layer.getSpatialReference() : map.getSpatialReference(),
                tileResolution = sr.getResolution(tileInfo.z),
                tileRatio = context.tileExtent / layer.getTileSize().width;
            geometry.properties.tile = tileInfo;
            geometry.properties.tileResolution = tileResolution;
            geometry.properties.tileRatio = tileRatio;
            geometry.properties.z = tileInfo.z;
            geometry.properties.tileExtent = context.tileExtent;
        },

        updateSceneConfig: function (context) {
            const painter = this.painter;
            if (painter) {
                painter.updateSceneConfig(context.sceneConfig);
            }
        },

        // 返回true，则重刷图层，重新构造瓦片mesh
        // 返回false，则只是请求重绘
        updateDataConfig: function (dataConfig, old) {
            const painter = this.painter;
            if (painter) {
                return painter.updateDataConfig(dataConfig, old);
            }
            return true;
        },

        updateSymbol: function (symbol, all) {
            const painter = this.painter;
            if (!painter) {
                return false;
            }
            if (painter.shouldDeleteMeshOnUpdateSymbol(symbol)) {
                if (this._meshCache) {
                    for (const key in this._meshCache) {
                        painter.deleteMesh(this._meshCache[key], true);
                    }
                }
                delete this._meshCache;
                delete this._frameCache;
                delete this._tileLevels;
            }
            return painter.updateSymbol(symbol, all);
        },

        pick: function (x, y, tolerance) {
            if (this.painter && this.painter.pick) {
                return this.painter.pick(x, y, tolerance);
            }
            return null;
        },

        deleteTile: function (context) {
            if (!this._meshCache) {
                return;
            }
            const key = this._getMeshKey(context);
            const mesh = this._meshCache[key];
            if (mesh && this.painter) {
                this.painter.deleteMesh(mesh);
            }
            delete this._meshCache[key];
            if (this._frameCache) {
                delete this._frameCache[key];
            }
            if (this._tileLevels) {
                delete this._tileLevels[key];
            }
        },

        remove: function () {
            const painter = this.painter;
            if (painter && this._meshCache) {
                // 先释放延迟 dispose 队列中的旧 mesh
                this._flushDisposeQueue();
                for (const key in this._meshCache) {
                    painter.deleteMesh(this._meshCache[key]);
                }
                painter.delete();
                delete this.painter;
            }
            delete this._meshCache;
            delete this._frameCache;
            delete this._tileLevels;
            delete this._disposeQueue;
        },

        resize: function (width, height) {
            const painter = this.painter;
            if (painter) {
                painter.resize(width, height);
            }
        },

        needToRedraw: function () {
            if (!this.painter) {
                return false;
            }
            return this.painter.needToRedraw();
        },

        needToRetireFrames: function () {
            if (!this.painter) {
                return false;
            }
            return this.painter.needToRetireFrames();
        },

        isAnimating() {
            if (!this.painter) {
                return false;
            }
            return this.painter.isAnimating();
        },

        needToRefreshTerrainTileOnZooming: function () {
            if (!this.painter) {
                return false;
            }
            return this.painter.needToRefreshTerrainTileOnZooming();
        },

        isTerrainSkin: function () {
            if (!this.painter) {
                return false;
            }
            return this.painter.isTerrainSkin();
        },

        isTerrainVector: function () {
            if (!this.painter) {
                return false;
            }
            return this.painter.isTerrainVector();
        },

        isTerrainMask: function () {
            if (!this.painter) {
                return false;
            }
            return this.painter.isTerrainMask();
        },

        _generateColorArray: function (features, featureIndexes, indices, vertices, positionSize = 3) {
            if (!vertices || !features || !featureIndexes.length) {
                return null;
            }
            // const myColors = ['#313695', '#4575b4', '#74add1', '#abd9e9', '#e0f3f8', '#ffffbf', '#fee090', '#fdae61', '#f46d43', '#d73027', '#a50026'];
            const colors = new Uint8Array(vertices.length / positionSize * 4);
            let symbol, rgb;
            const colorSymbol = this.painter.colorSymbol;
            const visitedColors = {};
            let pos;
            for (let i = 0, l = featureIndexes.length; i < l; i++) {
                const idx = featureIndexes[i];
                symbol = features[idx].symbol;
                rgb = visitedColors[idx];
                if (!rgb) {
                    // const color = Color(myColors[features[idx].feature.id % myColors.length]);
                    // rgb = visitedColors[idx] = color.array();
                    // if (symbol[this.painter.colorSymbol]) {
                    //     const color = Color(symbol[this.painter.colorSymbol]);
                    //     rgb = visitedColors[idx] = color.array();
                    // } else {
                    //     rgb = visitedColors[idx] = [255, 255, 255];
                    // }

                    if (colorSymbol) {
                        let color;
                        if (typeof colorSymbol === 'function') {
                            color = colorSymbol(features[idx].feature && features[idx].feature.properties);
                        } else {
                            color = colorSymbol;
                        }
                        color = Color(color);
                        rgb = visitedColors[idx] = color.array();
                    } else {
                        rgb = visitedColors[idx] = [255, 255, 255];
                    }
                }
                pos = i * 4;
                colors[pos] = rgb[0];
                colors[pos + 1] = rgb[1];
                colors[pos + 2] = rgb[2];
                colors[pos + 3] = 255 * (symbol[this.painter.opacitySymbol] || 1);
            }
            return colors;
        },

        _getMeshKey: function (context) {
            const tileInfo = context.tileInfo;
            // const pluginIndex = context.pluginIndex;
            const meshKey = tileInfo.meshKey;
            if (!meshKey) {
                tileInfo.meshKey = meshUID++;
            }
            return tileInfo.meshKey;
        },

        _getMesh: function (key) {
            return this._meshCache[key];
        },

        _filterElements(geometry, glData) {
            if (Array.isArray(geometry)) {
                geometry.forEach((g, idx) => {
                    const { features } = g.properties;
                    this._filterGeoElements(g, glData[idx], features);
                });
            } else {
                const { features } = geometry.properties;
                this._filterGeoElements(geometry, Array.isArray(glData) ? glData[0] : glData, features);
            }
        },

        _filterGeoElements(geometry, glData, features) {
            const featureIndexes = glData.featureIndexes || glData.data.featureIndexes;
            if (!featureIndexes) return;
            if (this._excludesFunc) {
                const indices = glData.indices;
                let pre = null,
                    excluded = false;
                const elements = [];
                for (let i = 0; i < indices.length; i++) {
                    const feature = features[featureIndexes[indices[i]]];
                    if (pre === null || pre !== indices[i]) {
                        excluded = this._excludesFunc(feature.feature);
                        pre = indices[i];
                    }
                    if (!excluded) {
                        elements.push(indices[i]);
                    }
                }
                geometry.setElements(new glData.indices.constructor(elements));
            } else {
                geometry.setElements(glData.indices);
            }
        },

        outline(fbo, featureIds) {
            const painter = this.painter;
            if (painter) {
                painter.outline(fbo, featureIds);
            }
        },

        outlineAll(fbo) {
            const painter = this.painter;
            if (painter) {
                painter.outlineAll(fbo);
            }
        },

        needPolygonOffset() {
            const painter = this.painter;
            return painter && painter.needPolygonOffset();
        },

        highlight(highlights) {
            const painter = this.painter;
            const name = this.style.name;
            const pluginIndex = this.renderIndex;
            if (highlights) {
                const excludes = [];
                highlights.forEach((value, key) => {
                    if (value.plugin !== undefined && value.plugin !== null) {
                        if (Array.isArray(value.plugin)) {
                            if (value.plugin.length && value.plugin.indexOf(name) < 0 && value.plugin.indexOf(pluginIndex) < 0) {
                                excludes.push(key)
                            }
                        } else if (value.plugin !== name && value.plugin !== pluginIndex) {
                            excludes.push(key)
                        }
                    }
                });
                if (excludes.length) {
                    const filtered = new Map(highlights);
                    for (let i = 0; i < excludes.length; i++) {
                        filtered.delete(excludes[i]);
                    }
                    highlights = filtered;
                }
            }
            return painter && painter.highlight(highlights);
        },

        cancelAllHighlight() {
            const painter = this.painter;
            return painter && painter.cancelAllHighlight();
        }
    });

    return PainterPlugin;
}

export default createPainterPlugin;

export function extend(dest) {
    for (let i = 1; i < arguments.length; i++) {
        const src = arguments[i];
        for (const k in src) {
            dest[k] = src[k];
        }
    }
    return dest;
}

function isObjectEmpty(obj) {
    if (!obj) {
        return true;
    }
    for (const p in obj) return false;
    return true;
}
