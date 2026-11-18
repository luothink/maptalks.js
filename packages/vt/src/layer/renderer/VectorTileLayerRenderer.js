import * as maptalks from 'maptalks';
import { mat4, vec3, GroundPainter, CanvasCompatible } from '@maptalks/gl';
import WorkerConnection from './worker/WorkerConnection';
import { EMPTY_VECTOR_TILE } from '../core/Constant';
import DebugPainter from './utils/DebugPainter';
import TileStencilRenderer from './stencil/TileStencilRenderer';
import { extend, pushIn, getCentiMeterScale, isNil, isFunction, wrapVTFeatureGeometryInfo } from '../../common/Util';
import { default as convertToPainterFeatures, oldPropsKey, clearStringPool } from './utils/convert_to_painter_features';
import { isFunctionDefinition } from '@maptalks/function-type';
import { meterToPoint } from '../plugins/Util';
import { getVectorPacker } from '../../packer/inject';

const { TileLayerRendererable, LayerAbstractRenderer } = maptalks.renderer;

const { FilterUtil } = getVectorPacker();

// const DEFAULT_PLUGIN_ORDERS = ['native-point', 'native-line', 'fill'];
// 待解析队列上限：限制多 Worker 集中回传时主线程持有的解析数据峰值（内存有界）
const MAX_PENDING_PARSE = 128;
// 主线程每帧瓦片解析时间预算（ms）兜底值：GlobalConfig.maxTileParseTimePerFrame 未配置时使用。
// 相比数量配额，时间配额直接限制大瓦片/多瓦片集中回传时单帧 CPU 峰值，
// 把解析工作摊平到后续帧，避免 rAF/事件处理超时掉帧。
const DEFAULT_PARSE_TIME_BUDGET_PER_FRAME = 8;
const EMPTY_ARRAY = [];
const CLEAR_COLOR = [0, 0, 0, 0];
const TILE_POINT = new maptalks.Point(0, 0);
const MINMAX = [];

const TERRAIN_CLEAR = {
    color: CLEAR_COLOR,
    depth: 1,
    stencil: 0
};

const terrainSkinFilter = plugin => {
    return plugin.isTerrainSkin();
}

const terrainVectorFilter = plugin => {
    return plugin.isTerrainVector();
}

/**
 * 粗略估算一个矢量瓦片数据在渲染器（主线程）中的真实内存占用（字节）。
 * 构成：
 *  1. worker 传输来的 attribute ArrayBuffer（tileData.buffers）
 *  2. 解析出的 feature 对象数组（属性 + 坐标数组）
 *  3. 各 layer 的 painter feature wrapper
 * 该值被写入 tileData._memSize，供主线程 tileCache 的 LRU 内存预算驱逐使用。
 */
function estimateTileDataMemory(tileData) {
    let size = 4096; // 对象/数组基础开销
    const buffers = tileData.buffers;
    if (buffers) {
        for (let i = 0; i < buffers.length; i++) {
            const b = buffers[i];
            if (b && b.byteLength) {
                size += b.byteLength;
            }
        }
    }
    const features = tileData.features;
    if (features) {
        // 每个 feature 对象（geometry 坐标数组 + properties）的粗略估算
        size += features.length * 512;
    }
    const dataArr = tileData.data;
    if (dataArr && dataArr.length) {
        for (let i = 0; i < dataArr.length; i++) {
            const d = dataArr[i];
            if (d && d.features) {
                size += 256 * Object.keys(d.features).length; // painter feature wrapper
            }
        }
    }
    return size;
}

class VectorTileLayerRenderer extends CanvasCompatible(TileLayerRendererable(LayerAbstractRenderer)) {

    supportRenderMode() {
        return true;
    }

    constructor(layer) {
        super(layer);
        this._workerCacheIndex = 0;
        this.ready = false;
        this._styleCounter = 1;
        this._styles = [];
        this._requestingMVT = {};
        // 多 Worker 并行解码时，解码结果可能短时间集中回传主线程；
        // 解析（_parseTileData/_compileStyle/feature 转换）是主线程 CPU 大头，
        // 通过每帧解析配额（_drainParseQueue）平滑负载，避免单帧解析过多瓦片导致 FPS 下降。
        // 上屏侧已有 _consumeTileQueue 的每帧配额，这里补齐入队前的解析侧。
        this._pendingParseQueue = [];
        this._pendingParseSet = new Set();
        this._parseBudget = 0;
        // 按要素类型拆分回传（Worker 端 point/native-point 慢组补充）：
        // _partialTileData: url -> { data, tiles, features }，第一阶段 partial 缓存
        // _pendingPointData: url -> data，pointOnly 早于 partial 到达时的暂存
        this._partialTileData = {};
        this._pendingPointData = {};
        // 复用对象，避免 drawTile 每帧每个瓦片分配 renderContext
        this._tileRenderContext = {
            regl: null,
            layer: null,
            gl: null,
            sceneConfig: null,
            pluginIndex: null,
            tileCache: null,
            tileData: null,
            tileTransform: null,
            tileVectorTransform: null,
            tileTranslationMatrix: null,
            tileExtent: null,
            timestamp: 0,
            tileInfo: null,
            tileZoom: 0,
            bloom: false,
            isRenderingTerrain: false,
            isRenderingTerrainSkin: null,
            renderTarget: null,
            tileOpacity: 1.0
        };
        this._plugins = {};
        this._featurePlugins = {};
        // For features:'id' mode: tileId → tileInfo lookup so
        // pick/identify can resolve tile metadata without relying on
        // feature.tile (which is lost when features are sent as strings).
        this._tileByIdMap = new Map();
        // featureId → tileInfo mapping for features:'id' lazy fetch.
        // Populated in _onReceiveMVTData, used by fillFeatureProperties.
        this._featureTileMap = new Map();
        this.init();
    }

    getTileLevelValue(tileInfo, currentTileZoom) {
        if (!this.isBackTile(tileInfo.id)) {
            return 0;
        } else {
            const z = tileInfo.z;
            const maxChildDepth = 5;
            // 如果瓦片zoom比currentTileZoom大，则设为0-5之间的值，瓦片zoom越大，值越小
            // 如果瓦片zoom比currentTileZoom小，则设为5以上的值，越接近，值越小
            return (z - currentTileZoom >= 0) ? (currentTileZoom + maxChildDepth - z) : (maxChildDepth + (currentTileZoom - z));
        }
    }

    getWorkerConnection() {
        return this._workerConn;
    }

    getStyleCounter() {
        return this._styleCounter;
    }

    _shouldRequestFullFeatureJSON() {
        // full 模式才主动向 worker 请求额外的 featuresTypeArray。
        // 其他模式直接使用运行时 feature 数据，避免每个 tile 再复制一份完整 JSON。
        return this.layer.options.features === 'full';
    }

    clearData() {
        this.clear();
        this._tileByIdMap.clear();
        this._featureTileMap.clear();
        if (!this._workerConn) {
            this.layer.fire('cleardata');
            return;
        }
        this._workersyncing = true;
        this._workerConn.clearData(() => {
            this._workersyncing = false;
            this._needRetire = true;
            this.setToRedraw();

            this.layer.fire('cleardata');
        });
    }

    clear() {
        this.clearTileCaches();
        super.clear();
    }

    setStyle(styles, onLoad) {
        if (this._groundPainter) {
            this._groundPainter.update();
        }
        if (this._workerConn) {
            if (this._workerUpdateTimeout) {
                clearTimeout(this._workerUpdateTimeout);
            }
            this._styles[this._styleCounter] = this.layer._getComputedStyle();
            this._styleCounter++;
            this._preservePrevTiles();
            if (onLoad) {
                onLoad();
                if (this._groundPainter) {
                    this._groundPainter.update();
                }
            }
            this._styles[this._styleCounter] = this.layer._getComputedStyle();
            this._needRetire = true;
            // 裁剪过期的样式版本缓存，防止频繁 setStyle 时 _styles 数组无限增长导致主进程内存泄漏
            this._trimStyles();
            // this.clear();
            // this._clearPlugin();
            this._initPlugins();
            this.setToRedraw();
            this.layer.fire('refreshstyle');
        } else {
            if (onLoad) {
                onLoad();
                if (this._groundPainter) {
                    this._groundPainter.update();
                }
            }
            this._initPlugins();
        }
    }

    getStyleByCounter(styleCounter) {
        let style = this._styles[styleCounter];
        if (!style) {
            // 该版本样式尚未生成，或已被 _trimStyles 裁剪（瓦片加载窗口已过）。
            // 裁剪后的版本退回当前样式，避免 worker 侧编译样式失败；
            // 对应瓦片数据到达主进程时也会因 styleCounter 不匹配而被丢弃。
            style = styleCounter === this._styleCounter ? this.layer._getComputedStyle() : this._styles[this._styleCounter];
            if (!style) {
                style = this.layer._getComputedStyle();
            }
            if (styleCounter === this._styleCounter) {
                this._styles[styleCounter] = style;
            }
        }
        return JSON.parse(JSON.stringify(style));
    }

    // 裁剪过期的样式版本缓存：仅保留最近 MAX_STYLE_VERSIONS 个版本。
    // 每个版本是完整计算样式（可能几十 KB），若无限保留会随 setStyle 次数
    // 线性增长，造成主进程内存泄漏。旧版本仅服务于仍在加载的瓦片，
    // 超过窗口后对应的瓦片数据到达时会被 styleCounter 校验丢弃，样式不再被使用。
    _trimStyles() {
        const MAX_STYLE_VERSIONS = 8;
        const oldestToKeep = this._styleCounter - MAX_STYLE_VERSIONS + 1;
        if (oldestToKeep <= 1) {
            return;
        }
        for (let i = 1; i < oldestToKeep; i++) {
            delete this._styles[i];
        }
    }

    // 为了解决阴影更新的闪烁问题，保留之前的绘制，当前数据载入后再删除
    _preservePrevTiles() {
        // if (this._prevTilesInView) {
        //     for (const p in this._prevTilesInView) {
        //         const tile = this._prevTilesInView[p];
        //         if (tile) {
        //             this.deleteTile(tile);
        //         }
        //     }
        // }
        // this._prevTilesInView = this.tilesInView;
        const tileCache = this.tileCache;
        // for (const p in this._prevTilesInView) {
        //     const tile = this._prevTilesInView[p];
        //     if (tile && tile.info) {
        //         tileCache.getAndRemove(tile.info.id);
        //     }
        // }
        tileCache.reset();
        this.tilesInView = {};
        this.tilesLoading = {};
        // 如果这里不清空 requestingMVT，updateStyle后的loadTile方法中，requestingMVT中会留有上次请求的缓存，导致不会调用worker的loadTile方法请求瓦片
        this._requestingMVT = {};
        this._partialTileData = {};
        this._pendingPointData = {};
        this['_parentTiles'] = [];
        this['_childTiles'] = [];
        // 让 currentTilesFirst 起作用
        this['_tileZoom'] = undefined;
    }

    updateOptions(conf) {
        if (this._workerConn) {
            this._workerConn.updateOptions(this.layer.getWorkerOptions(), err => {
                if (err) throw new Error(err);
                //需要重新生成瓦片的设置
                if (conf && (conf['features'] || conf['pickingGeometry'] || conf['altitudeProperty'])) {
                    this.clear();
                    this._clearPlugin();
                    this._initPlugins();
                }
                this.setToRedraw();
            });
        }
    }

    updateSceneConfig(type, idx, sceneConfig) {
        const plugins = type === 0 ? this._getStylePlugins() : this._getFeaturePlugins();
        if (!plugins || !plugins[idx]) {
            return;
        }
        this._needRetire = true;
        const allStyles = this.layer._getComputedStyle();
        const styles = this.layer._getTargetStyle(type, allStyles);
        plugins[idx].config = styles[idx].renderPlugin;
        plugins[idx].updateSceneConfig({
            sceneConfig: sceneConfig
        });
        this.setToRedraw();
    }

    updateDataConfig(type, idx, dataConfig, old) {
        const plugins = type === 0 ? this._getStylePlugins() : this._getFeaturePlugins();
        if (!plugins || !plugins[idx]) {
            return;
        }
        this._needRetire = true;
        if (plugins[idx].updateDataConfig(dataConfig, old)) {
            this.setStyle();
        } else {
            this.setToRedraw();
        }
    }

    updateSymbol(type, idx, symbol) {
        const plugins = type === 0 ? this._getStylePlugins() : this._getFeaturePlugins();
        if (!plugins || !plugins[idx]) {
            return false;
        }
        const allStyles = this.layer._getComputedStyle();
        const styles = this.layer._getTargetStyle(type, allStyles);
        // const symbol = styles[idx].symbol;
        const plugin = plugins[idx];
        plugin.style = styles[idx];
        const needRefresh = plugin.updateSymbol(symbol, styles[idx].symbol);
        if (!needRefresh && needRefreshStyle(symbol)) {
            this.setStyle();
        }
        this.setToRedraw();
        return needRefresh;
    }

    //always redraw when map is interacting
    testIfNeedRedraw() {
        const tilesInViewCount = this.tilesInView ? Object.keys(this.tilesInView).length : 0;
        const tilesLoadingCount = this.tilesLoading ? Object.keys(this.tilesLoading).length : 0;
        const plugins = this._getFramePlugins();
        for (let i = 0; i < plugins.length; i++) {
            if (plugins[i] && plugins[i].needToRedraw()) {
                const pluginType = plugins[i] && plugins[i].config && plugins[i].config.type;
                const suppressAnimatedPluginRedraw = (pluginType === 'line' || pluginType === 'text' || pluginType === 'icon') &&
                    (tilesInViewCount === 0 || tilesLoadingCount > 0);
                if (suppressAnimatedPluginRedraw) {
                    continue;
                }
                return true;
            }
        }
        return super.testIfNeedRedraw();
    }

    needRetireFrames() {
        if (this._needRetire) {
            return true;
        }
        const plugins = this._getFramePlugins();
        for (let i = 0; i < plugins.length; i++) {
            if (plugins[i] && plugins[i].needToRetireFrames()) {
                return true;
            }
        }
        return false;
    }

    getCurrentTiles() {
        return this._vtCurrentTiles;
    }

    isAnimating() {
        // maptalks/issues#712
        // 当highlight更新时，在当前帧（通过frametimestamp来识别）一直返回animating为true，让所有瓦片渲染时都能正确的渲染更新
        const mapRenderer = this.getMap().getRenderer();
        // 老版本核心库的mapRenderer上没有定义getFrameTimestamp
        const timestamp = mapRenderer.getFrameTimestamp && mapRenderer.getFrameTimestamp() || mapRenderer['_frameTimestamp'];
        if (this._highlightUpdated) {
            this._highlightFrametime = timestamp;
            delete this._highlightUpdated;
        }
        if (this._highlightFrametime === timestamp) {
            return true;
        }
        const plugins = this._getFramePlugins();
        for (let i = 0; i < plugins.length; i++) {
            if (plugins[i] && plugins[i].isAnimating()) {
                return true;
            }
        }
        return false;
    }

    needToRefreshTerrainTileOnZooming() {
        const plugins = this._getFramePlugins();
        for (let i = 0; i < plugins.length; i++) {
            if (plugins[i] && plugins[i].needToRefreshTerrainTileOnZooming()) {
                return true;
            }
        }
        return false;
    }

    initContext() {
        super.initContext();
        const { regl, device, reglGL } = this.context;
        const graphics = regl || device;
        this.regl = regl;
        this.gl = reglGL;
        this.device = device || regl;

        const isWebGPU = !!this.device.wpu;
        const fboOptions = {
            colorFormat: isWebGPU ? 'bgra8unorm' : 'rgba',
            depthStencil: true,
            width: this.canvas.width,
            height: this.canvas.height
        };
        this.canvas.pickingFBO = this.canvas.pickingFBO || graphics.framebuffer(fboOptions);
        this.pickingFBO = this.canvas.pickingFBO;
        this._debugPainter = new DebugPainter(graphics, this.getMap());
        this._prepareWorker();
        this._groundPainter = new GroundPainter(graphics, this.layer);
        this.layer.fire('contextcreate', { regl, device });
    }

    _prepareWorker() {
        if (!this._workerConn) {
            this._workerConn = new WorkerConnection('@maptalks/vt', this.layer);
        }
        const workerConn = this._workerConn;
        //setTimeout in case layer's style is set to layer after layer's creating.
        workerConn.addLayer((err, params) => {
            if (!this.layer) return;
            this.ready = true;
            this.layer.onWorkerReady(err, params);
            this.layer.fire('workerready');
            this.setToRedraw();
        });
    }

    _incrWorkerCacheIndex() {
        this._workerCacheIndex++;
    }

    isDrawable() {
        return true;
    }

    checkResources() {
        const result = EMPTY_ARRAY;
        return result;
    }

    _drawTiles(tiles, parentTiles, childTiles, placeholders, context) {
        super['_drawTiles'](tiles, parentTiles, childTiles, placeholders, context);
        if (this._prevTilesInView) {
            if (!Object.keys(this._prevTilesInView).length) {
                this._deletePrevPlugins();
                delete this._prevTilesInView;
            } else {
                for (const p in this._prevTilesInView) {
                    const tile = this._prevTilesInView[p];
                    if (tile && tile.info && tile.info.id && !this.tileCache.has(tile.info.id)) {
                        this['_drawTile'](tile.info, tile.image, context);
                    }
                }
            }
        }
    }

    _deletePrevPlugins() {
        const styleCounter = this._styleCounter;
        const retired = [];
        const retiredFeaPlulgin = [];
        for (const p in this._plugins) {
            if (+p !== styleCounter) {
                retired.push(p);
                const oldPlugins = this._getStylePlugins(p);
                oldPlugins.forEach(plugin => {
                    plugin.remove();
                });
            }
        }
        for (const p in this._featurePlugins) {
            if (+p !== styleCounter) {
                retiredFeaPlulgin.push(p);
                const oldFeaturePlugins = this._getFeaturePlugins(p);
                oldFeaturePlugins.forEach(plugin => {
                    plugin.remove();
                });
            }
        }
        for (let i = 0; i < retired.length; i++) {
            delete this._plugins[retired[i]];
        }
        for (let i = 0; i < retiredFeaPlulgin.length; i++) {
            delete this._featurePlugins[retiredFeaPlulgin[i]];
        }
    }

    draw(timestamp, parentContext) {
        if (this._currentTimestamp !== timestamp) {
            this._needRetire = false;
            this._setPluginIndex();
        }
        const layer = this.layer;
        this.prepareCanvas();
        if (!this.ready || !layer.ready) {
            // this.completeRender();
            return;
        }
        const { plugins, featurePlugins } = this._preparePlugins();

        if (!layer.isDefaultRender() && (!plugins.length && !featurePlugins.length)) {
            this.completeRender();
            return;
        }
        if (layer.options['collision']) {
            layer.clearCollisionIndex();
            // layer.clearBackgroundCollisionIndex();
        }
        this._frameTime = timestamp;
        this._zScale = this._getCentiMeterScale(this.getMap().getGLRes()); // scale to convert centi-meter to gl point
        this._parentContext = parentContext || {};
        this._startFrame(timestamp);
        super.draw(timestamp);
        if (this._currentTimestamp !== timestamp) {
            // 每帧按配额解析待处理瓦片，平滑多 Worker 集中回传带来的主线程解析峰值
            this._drainParseQueue();
            this._prepareRender(timestamp);
        }

        this._endFrame(timestamp);
        // this.completeRender();
        this._currentTimestamp = timestamp;
    }

    _preparePlugins() {
        let plugins = this._plugins[this._styleCounter];
        if (!plugins) {
            this._initPlugins();
            this._setPluginIndex();
            plugins = this._getStylePlugins();
        }
        const featurePlugins = this._getFeaturePlugins();
        return { plugins, featurePlugins };
    }

    _setPluginIndex() {
        const plugins = this._getFramePlugins();
        //按照plugin顺序更新collision索引
        plugins.forEach((plugin, idx) => {
            if (!plugin) {
                return;
            }
            plugin.renderIndex = idx;
        });
    }

    _prepareRender() {
        const plugins = this._getFramePlugins();
        this._pluginOffsets = this._pluginOffsets || [];
        let polygonOffsetIndex = 0;
        const len = plugins.length;
        for (let i = len - 1; i >= 0; i--) {
            const plugin = plugins[i];
            if (!plugin.isVisible() || !plugin.hasMesh()) {
                continue;
            }
            this._pluginOffsets[i] = polygonOffsetIndex;
            if (plugin.needPolygonOffset()) {
                polygonOffsetIndex++;
            }
        }
        if (this._groundPainter.isEnable()) {
            polygonOffsetIndex++;
        }
        this._polygonOffsetIndex = polygonOffsetIndex;
    }

    getFrameTimestamp() {
        return this._frameTime;
    }

    drawOnInteracting(event, timestamp, parentContext) {
        this.draw(timestamp, parentContext);
    }

    drawOutline(fbo) {
        if (!this._outline && !this._outlineAll) {
            return;
        }
        if (this._outlineAll) {
            this.paintOutlineAll(fbo);
            return;
        }
        this._outline.forEach(outline => {
            this[outline[0]](fbo, ...outline[1]);
        });
    }

    getAnalysisMeshes() {
        return this.getShadowMeshes();
    }

    getShadowMeshes() {
        const meshes = [];
        const plugins = this._getAllPlugins();
        plugins.forEach((plugin) => {
            if (!plugin) {
                return;
            }
            const visible = this._isVisible(plugin);
            if (!visible) {
                return;
            }
            const shadowMeshes = plugin.getShadowMeshes();
            if (Array.isArray(shadowMeshes)) {
                for (let i = 0; i < shadowMeshes.length; i++) {
                    meshes.push(shadowMeshes[i]);
                }
            }
        });
        return meshes;
    }

    isForeground(mesh) {
        return !!(this._vtCurrentTiles && this._vtCurrentTiles[mesh.properties.tile.id]);
    }

    _getTileZoomDiff(mesh) {
        const layer = this.layer;
        const map = this.getMap();
        const cache = maptalks.MapStateCache[map.id];

        let zoom = layer['_getTileZoom'](cache ? cache.zoom : map.getZoom());
        const minZoom = layer.getMinZoom(),
            maxZoom = layer.getMaxZoom();
        zoom = maptalks.Util.clamp(zoom, minZoom, maxZoom);
        const gap = zoom - mesh.properties.tile.z;
        return gap;
    }

    isTileNearCamera(mesh) {
        const gap = this._getTileZoomDiff(mesh);
        return gap <= 1;
    }

    isBackTile(id) {
        return !!(this._vtBgTiles && this._vtBgTiles[id]);
    }

    loadTileQueue(tileQueue) {
        // worker与主线程同步期间，不再请求瓦片，避免出现瓦片与样式不同步的问题
        if (this._workersyncing) {
            return;
        }
        super.loadTileQueue(tileQueue);
    }



    loadTile(tileInfo) {
        const { url } = tileInfo;
        const cached = this._requestingMVT[url];
        if (!cached) {
            const map = this.getMap();
            const tilePoint = TILE_POINT.set(tileInfo.extent2d.xmin, tileInfo.extent2d.ymax);
            const tileCoord = map.pointAtResToCoord(new maptalks.Point(tilePoint), tileInfo.res);
            const centimeterToPoint = [meterToPoint(map, 1, tileCoord, tileInfo.res) / 100, meterToPoint(map, 1, tileCoord, tileInfo.res, 1) / 100];
            const verticalCentimeterToPoint = this.getCentimeterToPoint(tileInfo.z);
            // const centimeterToPoint = this.getCentimeterToPoint(tileInfo.z);
            // console.log(centimeterToPoint, centimeterToPoint1);
            const glScale = this.getTileGLScale(tileInfo.z);
            this._requestingMVT[url] = {
                keys: {},
                // 一个url可能对应了好几个tile，例如 repeatWorld 时
                tiles: [tileInfo]
            };
            this._requestingMVT[url].keys[tileInfo.id] = 1;

            if (this.layer._dataExtent && this.layer._getTileBBox) {
                const tileBBOX = this.layer._getTileBBox(tileInfo);
                const dataBBOX = this.layer._dataExtent.toBBOX();
                const bboxIntersect = maptalks.BBOXUtil.bboxIntersect;
                //when data extent and tile extent not Intersect,return empty
                if (tileBBOX && dataBBOX && !bboxIntersect(tileBBOX, dataBBOX)) {
                    this._onReceiveMVTData(url, null, null);
                    return { _empty: true };
                }
            }

            const fetchOptions = this.layer.options['fetchOptions'];
            const referrer = window && window.location.href;
            const altitudePropertyName = this.layer.options['altitudePropertyName'];
            const disableAltitudeWarning = this.layer.options['disableAltitudeWarning'];
            const loadTileErrorLog = this.layer.options.loadTileErrorLog;
            const loadTileErrorLogIgnoreCodes = this.layer.options.loadTileErrorLogIgnoreCodes;
            const loadTileCachMaxSize = this.layer.options.loadTileCachMaxSize;
            const loadTileCacheLog = this.layer.options.loadTileCacheLog;
            const requireFullFeatureJSON = this._shouldRequestFullFeatureJSON();
            const loadTileOpitons = {
                tileInfo: {
                    res: tileInfo.res,
                    x: tileInfo.x,
                    y: tileInfo.y,
                    z: tileInfo.z,
                    url: getTileAbsoluteUrl(tileInfo),
                    id: tileInfo.id,
                    extent2d: tileInfo.extent2d,
                },
                glScale,
                disableAltitudeWarning,
                loadTileErrorLog,
                loadTileErrorLogIgnoreCodes,
                loadTileCachMaxSize,
                loadTileCacheLog,
                altitudePropertyName,
                zScale: this._zScale,
                centimeterToPoint,
                verticalCentimeterToPoint,
                fetchOptions,
                referrer,
                requireFullFeatureJSON,
                styleCounter: this._styleCounter,
                workerCacheIndex: this._workerCacheIndex,
                command: 'loadTile'
            }
            //user custom ,data can from indexedDB
            if (this.loadTileArrayBuffer && isFunction(this.loadTileArrayBuffer)) {
                this.loadTileArrayBuffer(loadTileOpitons.tileInfo.url, tileInfo, (err, data) => {
                    //fail
                    if (err) {
                        this._onReceiveMVTData(url, err)
                    } else if (data && data instanceof ArrayBuffer) {
                        loadTileOpitons.tileArrayBuffer = data;
                        this._workerConn.loadTile(loadTileOpitons, this._onReceiveMVTData.bind(this, url));
                    } else {
                        console.error(`loadTileArrayBuffer return data is not ArrayBuffer:`, data);
                    }
                }, loadTileOpitons)
            } else {
                this._workerConn.loadTile(loadTileOpitons, this._onReceiveMVTData.bind(this, url));
            }
        } else if (!cached.keys[tileInfo.id]) {
            cached.tiles.push(tileInfo);
            cached.keys[tileInfo.id] = 1;
        }
        return {};
    }

    getTileGLScale(z) {
        const map = this.getMap();
        const sr = this.layer.getSpatialReference();
        return sr.getResolution(z) / map.getGLRes();
    }

    getCentimeterToPoint(z) {
        const map = this.getMap();
        const sr = this.layer.getSpatialReference();
        const res = sr.getResolution(z);
        return getCentiMeterScale(res, map);
    }

    getRenderedFeatures() {
        const keys = this.tileCache.keys();
        return this._getFeaturesByKeys(keys);
    }

    getCurrentRenderedFeatures() {
        const keys = this._vtCurrentTiles && Object.keys(this._vtCurrentTiles);
        return this._getFeaturesByKeys(keys);
    }

    _getFeaturesByKeys(keys) {
        const renderedFeatures = [];
        for (let i = 0; i < keys.length; i++) {
            const cache = this.tileCache.get(keys[i]);
            if (!cache || !cache.info || !cache.image) {
                continue;
            }
            const { info, image } = cache;
            const features = findFeatures(this.layer, image);
            renderedFeatures.push({
                tile: { id: info.id, x: info.x, y: info.y, z: info.z, url: info.url },
                current: !!this.tilesInView[info.id],
                features
            });
        }
        return renderedFeatures;
    }

    _onReceiveMVTData(url, err, data) {
        this.setToRedraw();
        if (data && data.pointOnly) {
            // 按要素类型拆分回传的第二阶段：仅点要素 slot。
            // 第一阶段（partial）的 _requestingMVT[url] 已被删除，这里直接走合并：
            // 若 partial 已解析则立即合并，否则暂存 _pendingPointData 待 partial 解析后合并。
            this._mergePointData(url, data);
            return;
        }
        if (!this._requestingMVT[url]) {
            return;
        }
        if (data && data.canceled) {
            return;
        }
        if (data && data.styleCounter !== this._styleCounter) {
            //返回的是上一个style的tileData
            return;
        }
        if (this._parseBudget <= 0) {
            // 本帧解析配额已用完：先把数据挂入待解析队列，由 _drainParseQueue 在后续帧
            // 按每帧配额解析，把主线程 CPU 峰值摊平到多帧（多 Worker 并行解码时回传集中，
            // 若每帧都立即解析会撑爆单帧主线程负载导致 FPS 下降）。
            // 排队期间 _requestingMVT[url] 保留占用，同 url 的后续 tile（repeatWorld 等）
            // 仍会合并到同一批解析。
            const queue = this._pendingParseQueue;
            if (queue.length >= MAX_PENDING_PARSE) {
                // 队列有界，超限丢弃最旧（该瓦片保持"简化显示"背景兜底）
                const dropped = queue.shift();
                this._pendingParseSet.delete(dropped.url);
                // 【修复】被丢弃的数据不再解析，必须同步清除其 _requestingMVT 条目；
                // 否则残留条目会让同 url 的后续 tile 被合并进已丢弃的加载批次而不再
                // 发起请求，该瓦片永久停留在未上屏/缺数据状态。
                if (dropped.url !== url) {
                    delete this._requestingMVT[dropped.url];
                }
            }
            if (this._pendingParseSet.has(url)) {
                // 同 url 已排队，用新数据替换旧数据
                for (let i = queue.length - 1; i >= 0; i--) {
                    if (queue[i].url === url) {
                        queue[i] = { url, err, data };
                        break;
                    }
                }
            } else {
                this._pendingParseSet.add(url);
                queue.push({ url, err, data });
            }
            return;
        }
        this._parseBudget--;
        this._parseMVTData(url, err, data, performance.now(), this._getParseTimeBudget());
    }

    _getParseTimeBudget() {
        // 主线程每帧瓦片解析时间预算（ms）：图层配置优先，其次全局配置，最后兜底常量。
        let budget = this.layer.options['tileParseTimePerFrame'];
        if (budget == null) {
            budget = maptalks.GlobalConfig.maxTileParseTimePerFrame;
        }
        if (budget == null || budget <= 0) {
            budget = DEFAULT_PARSE_TIME_BUDGET_PER_FRAME;
        }
        return Math.max(1, budget);
    }

    _drainParseQueue() {
        // 每帧重置解析配额：图层配置优先，其次全局 maxTileParsePerFrame；
        // 交互/宽限期内放大，保证过渡期解析跟得上、不拖慢"简化→精确"切换
        // （与 _consumeTileQueue 的每帧预算策略一致）。
        let baseLimit = Math.max(1,
            this.layer.options['tileParseLimitPerFrame'] != null
                ? this.layer.options['tileParseLimitPerFrame']
                : maptalks.GlobalConfig.maxTileParsePerFrame
        );
        const map = this.map || this.getMap();
        if (map && map.isInteracting() && baseLimit > 1) {
            baseLimit = Math.ceil(baseLimit * Math.max(maptalks.GlobalConfig.panLoadLimitMultiplier || 1, 1));
        }
        this._parseBudget = baseLimit;
        // 时间预算：每帧解析主线程总耗时上限（ms）。数量配额无法约束"单瓦片/多瓦片
        // 集中回传"时单次解析本身耗时过长的问题（一次 postMessage 解析可达数百 ms），
        // 时间配额把 per-tile 工作切到后续帧，保证单帧 CPU 峰值有界。
        const timeStart = performance.now();
        const timeBudget = this._getParseTimeBudget();
        // 优先恢复上一帧未完成的 per-tile 分片（repeatWorld 多瓦片场景）
        if (this._parsingTile) {
            this._processTileBatch(timeStart, timeBudget);
        }
        const queue = this._pendingParseQueue;
        while (queue.length && this._parseBudget > 0 && (performance.now() - timeStart) < timeBudget) {
            const { url, err, data } = queue.shift();
            this._pendingParseSet.delete(url);
            this._parseBudget--;
            this._parseMVTData(url, err, data, timeStart, timeBudget);
        }
    }

    _parseMVTData(url, err, data, timeStart, timeBudget) {
        if (timeStart == null) {
            timeStart = performance.now();
        }
        if (timeBudget == null) {
            timeBudget = this._getParseTimeBudget();
        }
        // 出队解析时瓦片可能已被取消/移除（平移/缩放触发 abort），重新校验
        if (!this._requestingMVT[url]) {
            return;
        }
        // 新瓦片数据就绪，非交互渲染时会通过 _collisionTimestamp 机制触发碰撞更新，无需额外标记
        const layer = this.layer;
        const useDefault = layer.isDefaultRender();
        const { tiles } = this._requestingMVT[url];
        delete this._requestingMVT[url];
        if (this._parsingTile && this._parsingTile.url === url) {
            // 同 url 正在 per-tile 分片处理中（_requestingMVT[url] 刚被删除）。
            // 把新数据放回等待队列并恢复 _requestingMVT 引用：待旧 entry 分片完成后，
            // 由 _drainParseQueue 出队重新解析并 onTileLoad 覆盖瓦片内容；
            // 若直接解析会覆盖 _parsingTile，导致旧 entry 剩余瓦片永久丢失（瓦片不上屏）。
            this._requestingMVT[url] = { keys: {}, tiles };
            this._pendingParseSet.add(url);
            this._pendingParseQueue.push({ url, err, data });
            return;
        }
        if (err) {
            if (err.status && (err.status === 404 || err.status === 204)) {
                //只处理404
                for (let i = 0; i < tiles.length; i++) {
                    const tileInfo = tiles[i];
                    this.onTileError(EMPTY_VECTOR_TILE, tileInfo);
                }

            }
            return;
        }
        if (!data) {
            for (let i = 0; i < tiles.length; i++) {
                const tileInfo = tiles[i];
                this.consumeTile({ _empty: true }, tileInfo);
            }
            return;
        }

        let needCompile = false;
        //restore features for plugin data
        const features = data.features;
        const layers = [];
        for (let i = 0; i < data.data.length; i++) {
            const pluginData = data.data[i]; // { data, featureIndex }
            if (!pluginData || !pluginData.data || !pluginData.styledFeatures.length) {
                continue;
            }
            const { isUpdated, layer } = this._parseTileData(0, i, pluginData, features, data.compactStore);
            if (layer) {
                layers.push(layer);
            }
            if (isUpdated) {
                needCompile = isUpdated;
            }
        }
        //iterate plugins
        for (let i = 0; i < data.featureData.length; i++) {
            const pluginData = data.featureData[i]; // { data, featureIndex }
            if (!pluginData || !pluginData.data || !pluginData.styledFeatures.length) {
                continue;
            }
            this._parseTileData(1, i, pluginData, features, data.compactStore);
        }

        if (needCompile) {
            layer._compileStyle();
        }

        const tileZoom = tiles[0].z;
        const schema = this.layer.getDataSchema(tileZoom);
        this._updateSchema(schema, data.schema);

        // 标注瓦片真实内存占用（transferred buffers + parsed features），
        // 供主线程 tileCache 的 LRU 内存预算驱逐使用。若不标注，LRUCache 会按
        // 256x256 RGBA(~263KB) 估算，而真实 VT 瓦片常达数 MB，导致 96MB 内存
        // 预算无法触发驱逐，拖动/缩放时缓存无限堆积、内存持续上升。
        data._memSize = estimateTileDataMemory(data);

        // 按要素类型拆分回传的第一阶段（partial）：保留 data 引用与 features，
        // 等 pointOnly 阶段（点要素 slot）到达后合并，见 _mergePointData。
        // 注意 features 在下一行被 delete，需在此前缓存引用。
        if (data.partial) {
            // tileDatas 收集该 url 下所有 copyTileData 出的独立 tileData 引用，
            // 供 _mergePointData 在 pointOnly 到达后把点要素 slot 同步到所有瓦片。
            // tileInfos 收集对应的 tileInfo 引用，供 _mergePointData 重调
            // _createOneTile 初始化点插件 cache 和 geometry。
            // parsing 标记：per-tile 分片尚未全部完成时置 true，_mergePointData 见该标记
            // 会把 pointOnly 数据暂存 _pendingPointData，待 _processTileBatch 全部完成后
            // 再合并，避免 merge 只同步到已处理的瓦片而漏掉后续瓦片。
            this._partialTileData[url] = { data, tiles, features, tileDatas: [], tileInfos: [], parsing: true };
        }
        // data.features会在_parseTileData方法中被转化为 { [key_idx]: fea, .... } 的形式
        delete data.features;
        if (useDefault && data.data.length !== layers.length) {
            //因为默认绘制时，renderPlugin是以tileData中的图层顺序初始化的
            //当某个图层data为空时，需要将它从tileData中剔除，否则layer的renderPlugin就无法对应到数据
            // 【重要】partial 分阶段回传时，点要素 slot 尚未到达，不能在此 compaction，
            // 否则 _mergePointData 中的 mainData.data[i] = pluginData 会因为索引
            // 移位而写入错误位置。compact 工作推迟到 _mergePointData 完成所有
            // slot 合并后统一处理。
            if (!data.partial) {
                const oldData = data.data;
                data.data = [];
                for (let i = 0; i < oldData.length; i++) {
                    if (!oldData[i] || !oldData[i].features) {
                        continue;
                    }
                    data.data.push(oldData[i]);
                }
            }
        }
        // data.layers 必须在 _mergePointData 之前赋值，否则 _mergePointData
        // 内部以 mainData.layers 起步时拿不到 partial 阶段的图层信息，
        // 合并后会丢失线面图层。
        data.layers = layers;
        // 点要素补充（pointOnly）若在 partial 解析前到达（解析队列挤压场景），
        // 暂存于 _pendingPointData，partial 解析完成后在此合并。
        const pendingPoint = this._pendingPointData[url];
        if (pendingPoint) {
            delete this._pendingPointData[url];
            this._mergePointData(url, pendingPoint);
        }
        // 【性能】per-tile 处理（copyTileData 深拷贝 + features wrapper 遍历 + onTileLoad
        // 几何构建）是主线程解析的主要耗时点，且单个 url 可能对应多个 tile（repeatWorld）。
        // 拆分为可恢复分片：每帧在时间预算内处理若干 tile，剩余下帧继续，
        // 避免一次回调把主线程卡住数百毫秒（长任务/rAF 超时）。
        this._parsingTile = {
            url,
            data,
            tiles,
            parsedFeatures: features,
            tileIndex: 0
        };
        this._processTileBatch(timeStart, timeBudget);
    }

    _processTileBatch(timeStart, timeBudget) {
        const entry = this._parsingTile;
        if (!entry) {
            return;
        }
        const { url, data, tiles, parsedFeatures } = entry;
        const layer = this.layer;
        const debugTileData = layer.options['debugTileData'];
        while (entry.tileIndex < tiles.length) {
            if (timeBudget > 0 && performance.now() - timeStart >= timeBudget) {
                // 本帧时间预算耗尽，保留 entry 状态（tileIndex 已推进），
                // 下帧由 _drainParseQueue 继续处理
                // 【修复】地图静止时渲染循环可能停止，若不主动唤醒下一帧，
                // per-tile 分片将永远无法完成：partial.parsing 恒为 true，
                // pointOnly 阶段数据被 _mergePointData 暂存后永不合并，
                // 表现为部分点要素不显示（放大触发渲染后才恢复）。
                this.setToRedraw();
                return;
            }
            const i = entry.tileIndex++;
            const tileInfo = tiles[i];
            if (i === 0) {
                if (debugTileData) {
                    const { x, y, z } = tileInfo;
                    if (debugTileData === true || debugTileData.x === x && debugTileData.y === y && debugTileData.z === z) {
                        console.log('tile', {
                            'layerId': layer.getId(),
                            x,
                            y,
                            z,
                            layers: groupFeatures(Object.values(parsedFeatures))
                        });
                    }
                }
            }
            const tileData = i === 0 ? data : copyTileData(data);
            // 收集所有瓦片引用（第一个瓦片用原始 data，后续用 copyTileData 创建的独立数组），
            // 后续 _mergePointData 需要遍历它们把点要素 slot 同步到每个瓦片。
            if (data.partial) {
                const partial = this._partialTileData[url];
                if (partial && partial.tileDatas) {
                    partial.tileDatas.push(tileData);
                    partial.tileInfos.push(tileInfo);
                }
            }
            // Keep tileId→tileInfo mapping for features:'id' lazy property fetch
            if (tileInfo && tileInfo.id) {
                this._tileByIdMap.set(tileInfo.id, tileInfo);
                // GC: keep at most 512 entries
                if (this._tileByIdMap.size > 512) {
                    const oldest = this._tileByIdMap.keys().next().value;
                    this._tileByIdMap.delete(oldest);
                }
            }
            for (let j = 0; j < tileData.data.length; j++) {
                if (!tileData.data[j]) {
                    continue;
                }
                const feas = tileData.data[j].features;
                for (const p in feas) {
                    const wrapper = feas[p];
                    // Store tile reference on the painter feature wrapper.
                    // In features:'id' mode, wrapper.feature is a string; otherwise it's
                    // a full feature object.  The tile is needed by pick → identifyAsync.
                    wrapper.tile = tileInfo;
                    // Build featureId→tileInfo index only in features:'id' mode (lazy property fetch).
                    // Normal mode pick → identifyAsync reads wrapper.tile directly, so keeping a
                    // 65K-entry Map per tile here is pure overhead (Map.set + batch cleanup).
                    if (layer.options['features'] === 'id' && tileInfo && tileInfo.id) {
                        const inner = wrapper.feature;
                        const fid = (typeof inner === 'string') ? inner : (inner && inner.id);
                        if (fid) {
                            this._featureTileMap.set(fid, tileInfo);
                            if (this._featureTileMap.size > 65536) {
                                // Iterator-based batch cleanup to avoid full keys array
                                // allocation (~512KB for 65K entries). Map iterator gives
                                // insertion-order traversal (oldest first).
                                const iter = this._featureTileMap.keys();
                                const removeCount = Math.floor(this._featureTileMap.size * 0.25);
                                for (let k = 0; k < removeCount; k++) {
                                    this._featureTileMap.delete(iter.next().value);
                                }
                            }
                        }
                    }
                }
            }
            tileInfo.extent = tileData.extent;
            if (!this._receivedTileExtent) {
                this._receivedTileExtent = tileInfo.extent;
            }
            // In features:'id' mode, the worker only sends feature ID strings, so
            // `features` is an array of strings.  For picking we need the wrapper
            // objects built by convertToPainterFeatures (keyed by original feature
            // index), which already contain {feature, symbol}.  Normal mode keeps
            // the full feature objects from the worker payload.
            if (layer.options['features'] === 'id') {
                const mergedFeatures = {};
                for (let k = 0; k < tileData.data.length; k++) {
                    const pluginFeas = tileData.data[k] && tileData.data[k].features;
                    if (pluginFeas) {
                        for (const key in pluginFeas) {
                            mergedFeatures[key] = pluginFeas[key];
                        }
                    }
                }
                tileData.features = mergedFeatures;
            } else {
                tileData.features = Object.values(parsedFeatures);
            }
            tileData.styleCounter = data.styleCounter;
            this.onTileLoad(tileData, tileInfo)
        }
        // 该 url 所有 tile 处理完成
        this._parsingTile = null;
        const partial = this._partialTileData[url];
        if (partial) {
            // per-tile 分片完成，解除 parsing 标记，允许 pointOnly 合并
            partial.parsing = false;
        }
        // 若 pointOnly 在分片期间到达（被 _mergePointData 暂存），此时一并合并
        const pendingPoint = this._pendingPointData[url];
        if (pendingPoint) {
            delete this._pendingPointData[url];
            this._mergePointData(url, pendingPoint);
        }
        layer.fire('datareceived', { url });
    }

    // 按要素类型拆分回传的第二阶段（pointOnly）合并：把点要素 slot 并入第一阶段
    // （partial）已解析的 data，首个 tile 直接引用该 data，重绘后点要素即时上屏。
    // 若 partial 尚未解析（解析队列挤压），则暂存 _pendingPointData，由
    // _parseMVTData 在 partial 解析完成后调用本方法。
    _mergePointData(url, data) {
        if (!data || data.styleCounter !== this._styleCounter) {
            delete this._pendingPointData[url];
            return;
        }
        const partial = this._partialTileData[url];
        if (!partial) {
            this._pendingPointData[url] = data;
            return;
        }
        if (partial.parsing) {
            // partial 阶段仍在 per-tile 分片处理中（_processTileBatch 未完成）：
            // 此时 tileDatas 只收集了已处理的瓦片，立即合并会漏掉后续瓦片。
            // 暂存 _pendingPointData，待 _processTileBatch 全部完成后统一合并。
            this._pendingPointData[url] = data;
            // 【修复】确保分片在后续帧持续推进（配合 _processTileBatch
            // 时间预算耗尽的 setToRedraw），避免地图静止时点要素永远滞留暂存。
            this.setToRedraw();
            return;
        }
        delete this._partialTileData[url];
        delete this._pendingPointData[url];
        const mainData = partial.data;
        // 兜底：若 mainData.data/featureData 为 null（极端竞态：deleteTile 已释放
        // 但 _partialTileData 条目仍存），按 pointOnly 数据长度重新初始化为空数组，
        // 避免下方 mainData.data[i] = pluginData 抛 "Cannot set properties of null"。
        // 线面 slot 已丢失但点 slot 仍能正常合并上屏。
        if (mainData.data == null) {
            mainData.data = new Array(data.data.length);
        }
        if (mainData.featureData == null) {
            mainData.featureData = new Array(data.featureData.length);
        }
        const layer = this.layer;
        const features = partial.features;
        const layers = mainData.layers || [];
        let needCompile = false;
        for (let i = 0; i < data.data.length; i++) {
            const pluginData = data.data[i];
            if (!pluginData || !pluginData.data || !pluginData.styledFeatures.length) {
                continue;
            }
            mainData.data[i] = pluginData;
            const { isUpdated, layer: parsedLayer } = this._parseTileData(0, i, pluginData, features, mainData.compactStore);
            if (parsedLayer) {
                layers.push(parsedLayer);
            }
            if (isUpdated) {
                needCompile = isUpdated;
            }
        }
        for (let i = 0; i < data.featureData.length; i++) {
            const pluginData = data.featureData[i];
            if (!pluginData || !pluginData.data || !pluginData.styledFeatures.length) {
                continue;
            }
            mainData.featureData[i] = pluginData;
            const { isUpdated } = this._parseTileData(1, i, pluginData, features, mainData.compactStore);
            if (isUpdated) {
                needCompile = isUpdated;
            }
        }
        if (needCompile) {
            layer._compileStyle();
        }
        // 【关键】本函数通过 _parseTileData 新增了点/文本插件（就地写入
        // _plugins[styleCounter] / _featurePlugins[styleCounter]），而
        // _getFramePlugins / _getAllPlugins 的按 styleCounter 缓存（存在 feature
        // 插件时 _framePluginsCache 是 slice 副本，_allPluginsCache 恒为副本数组）
        // 不含新插件。若不失效，下面重调 _createOneTile 时点插件 cache 不会被创建，
        // 绘制/碰撞遍历也拿不到点插件，导致点要素与文本永不渲染。
        // _updatePluginIfNecessary 新增插件时已清一次，这里再清一次兜底。
        this._framePluginsCache = null;
        this._allPluginsCache = null;
        // 因为 _parseMVTData partial 阶段跳过了 compaction（避免点 slot
        // 被移除导致后续索引错位），所以现在所有 slot（线/面/点）都齐全后，
        // 需要执行 compaction 让 data 数组对齐 layers 数组，确保
        // _getFramePlugins → plugins 的 idx 与 pluginData[idx] 一致。
        // compaction 仅用于 default render（与 _parseMVTData 中 useDefault
        // 分支一致）：default 模式下 renderPlugin 以 tileData 中的图层顺序
        // 初始化，需剔除空 slot 保证索引对齐。拆分回传（非 default）模式下
        // data.data 按 style 插件索引存储，绝对不能 compaction，否则与
        // _getStylePlugins 返回的插件数组索引错位，点插件永远拿不到数据。
        // 【关键】partial 阶段 _createOneTile 已把线面 slot 替换为
        // 'geometry created' 占位符字符串（代表该 slot 已完成 geometry 化），
        // compaction 必须保留它，否则会误删线面数据导致同样的索引错位。
        mainData.layers = layers;
        const useDefault = layer.isDefaultRender();
        if (useDefault) {
            const compactedData = [];
            for (let i = 0; i < mainData.data.length; i++) {
                const d = mainData.data[i];
                if (d === 'geometry created' || (d && d.features)) {
                    compactedData.push(d);
                }
            }
            mainData.data = compactedData;
        }
        // 慢组（点要素）slot 合并后重新估算瓦片真实内存占用，
        // 供主线程 tileCache 的 LRU 内存预算驱逐使用
        mainData._memSize = estimateTileDataMemory(mainData);
        // 点要素 slot 合并到 mainData 后，需要同步到所有 copyTileData 创建
        // 的独立瓦片数组。否则 i>0 瓦片（repeatWorld 多世界场景）渲染时
        // tileData.data[i] 仍为 undefined，导致点要素丢失。
        // copy tiles 也需要 compaction 和 layers 同步。
        if (partial.tileDatas) {
            for (let ti = 1; ti < partial.tileDatas.length; ti++) {
                const copyData = partial.tileDatas[ti];
                if (!copyData) continue;
                // 先同步原始数据
                for (let i = 0; i < data.data.length; i++) {
                    const slot = data.data[i];
                    if (slot && slot.data) {
                        copyData.data[i] = slot;
                    }
                }
                for (let i = 0; i < data.featureData.length; i++) {
                    const slot = data.featureData[i];
                    if (slot && slot.data) {
                        copyData.featureData[i] = slot;
                    }
                }
                // compact copyData.data 对齐 layers（与 mainData 相同的规则：
                // 仅 default render 时执行，且必须保留 'geometry created' 占位符）
                if (useDefault) {
                    const copyCompacted = [];
                    for (let i = 0; i < copyData.data.length; i++) {
                        const d = copyData.data[i];
                        if (d === 'geometry created' || (d && d.features)) {
                            copyCompacted.push(d);
                        }
                    }
                    copyData.data = copyCompacted;
                }
                // 同步 layers：copyData 也需要包含点插件图层信息，
                // 否则 _getFramePlugins(tileData) 不会返回点插件，
                // drawTile 也无法渲染点要素。
                copyData.layers = layers;
            }
        }
        // 点要素数据已合并到各瓦片 data 数组中，但 _createOneTile 在
        // partial 阶段因 point slot 为空（!pluginData[idx]）跳过了
        // tileData.cache[idx] 的初始化。drawTile 依赖 cache 存在，
        // 因此需要为已有 cache 的瓦片重调 _createOneTile 以初始化
        // 点插件的 cache 条目并调用 createTile 创建 geometry。
        // _createOneTile 内 createTile 对已有 geometry 的插件会
        // 直接返回（idempotent），不会重建非点插件的 geometry。
        if (partial.tileDatas && partial.tileInfos) {
            for (let ti = 0; ti < partial.tileDatas.length; ti++) {
                const tileData = partial.tileDatas[ti];
                const tileInfo = partial.tileInfos[ti];
                // tileData.cache 存在说明 _createOneTile 已在
                // partial 阶段执行过，需要补建点插件 cache。
                if (!tileData || !tileInfo || !tileData.cache) continue;
                this._createOneTile(tileInfo, tileData);
            }
        }
        this.setToRedraw();
    }

    _parseTileData(styleType, i, pluginData, features, dataCompactStore) {
        const { style, isUpdated } = this._updatePluginIfNecessary(styleType, i, pluginData.data);

        const layer = this.layer;
        const useDefault = layer.isDefaultRender();

        const symbol = style.symbol;
        const feaIndexes = pluginData.styledFeatures;
        //pFeatures是一个和features相同容量的数组，只存放有样式的feature数据，其他为undefined
        //这样featureIndexes中的序号能从pFeatures取得正确的数据
        // GeoJSONVectorTileLayer上的features需要复制，以保留原有的数据
        // layer.getData() 在同一样式批次内结果稳定，缓存布尔值避免每瓦片每插件重复调用
        if (this._hasGetData === undefined) {
            this._hasGetData = !!(layer.getData && layer.getData());
        }
        const pluginFeas = convertToPainterFeatures(features, feaIndexes, i, symbol, layer, this._hasGetData, dataCompactStore);
        // const pluginFeas = {};
        // if (hasFeature(features)) {
        //     //[feature index, style index]
        //     for (let ii = 0, ll = feaIndexes.length; ii < ll; ii++) {
        //         let feature = features[feaIndexes[ii]];
        //         if (layer.options['features'] === 'id' && layer.getFeature) {
        //             feature = layer.getFeature(feature);
        //             feature.layer = i;
        //         }
        //         pluginFeas[feaIndexes[ii]] = {
        //             feature,
        //             symbol
        //         };
        //     }
        // }
        delete pluginData.styledFeatures;
        pluginData.features = pluginFeas;
        let data = pluginData.data;
        if (Array.isArray(data)) {
            // 多symbol返回的数据
            data = data[0];
        }
        return {
            isUpdated,
            layer: useDefault ? { layer: data.layer, type: data.type } : null
        };
    }

    _updateSchema(target, source) {
        // const useDefault = this.layer.isDefaultRender();
        for (const layer in source) {
            if (!target[layer]) {
                target[layer] = {
                    types: source[layer].types,
                    properties: {}
                };
                // if (useDefault && this._layerPlugins) {
                //     target[layer].symbol = this._layerPlugins[layer].symbol;
                // }
            }
            const srcProps = source[layer].properties;
            const targetProps = target[layer].properties;
            for (const type in srcProps) {
                if (!targetProps[type] ||
                    //之前的瓦片里，target[layer][type]的值是null或undefined时，类型被判断为object
                    targetProps[type] && srcProps[type] !== 'object' && targetProps[type] === 'object') {
                    targetProps[type] = srcProps[type];
                }
            }
        }
    }

    _updatePluginIfNecessary(styleType, i, data) {
        if (Array.isArray(data)) {
            // 是个多symbol数据
            data = data[0];
        }
        const layer = this.layer;
        let isUpdated = false;
        let style;
        const useDefault = layer.isDefaultRender();
        if (useDefault && styleType === 0) {
            let layerPlugins = this._layerPlugins;
            if (!layerPlugins) {
                layerPlugins = this._layerPlugins = {};
            }
            //没有定义任何图层，采用图层默认的plugin渲染
            const layerId = data.layer;
            const type = data.type;
            if (!layerPlugins[layerId]) {
                layerPlugins[layerId] = [];
            }
            const pluginTypeName = ('plugin_' + type).trim();
            if (!layerPlugins[layerId][pluginTypeName]) {
                style = this._getDefaultRenderPlugin(type);
                style.filter = data.filter;
                layerPlugins[layerId].push(style);
                layerPlugins[layerId][pluginTypeName] = style;
                isUpdated = true;
                // 新增插件后同样需要使 _getFramePlugins/_getAllPlugins 的缓存失效
                this._framePluginsCache = null;
                this._allPluginsCache = null;
                // layerStyles.push(style);
            } else {
                style = layerPlugins[layerId][pluginTypeName];
            }
        } else {
            // 同一样式批次内（styleCounter 未变，不匹配的瓦片已在到达时被丢弃）样式配置稳定，
            // 缓存 _getTargetStyle 的结果，避免每瓦片每插件重复构建 styles 数组
            let styleInfo = this._styleInfoCache;
            if (
                !styleInfo ||
                styleInfo.styleCounter !== this._styleCounter ||
                styleInfo.styleType !== styleType
            ) {
                const allStyles = layer._getComputedStyle();
                styleInfo = this._styleInfoCache = {
                    styleCounter: this._styleCounter,
                    styleType,
                    styles: layer._getTargetStyle(styleType, allStyles)
                };
            }
            const styles = styleInfo.styles;
            const plugins = this._getStylePlugins();
            style = styles[i];
            if (!style.renderPlugin) {
                isUpdated = true;
                const { plugin, symbol, renderPlugin } = this._getDefaultRenderPlugin(data.type);
                plugins[i] = plugin;
                style.symbol = symbol;
                style.renderPlugin = renderPlugin;
                // 新增插件后，_getFramePlugins / _getAllPlugins 的按 styleCounter 缓存
                // 可能不含新插件（_framePluginsCache 在存在 feature 插件时是 slice 副本，
                // _allPluginsCache 恒为副本数组），必须失效，否则点/文本要素永不渲染。
                this._framePluginsCache = null;
                this._allPluginsCache = null;
            }
        }
        return { style, isUpdated };
    }

    _getFramePlugins(tileData) {
        // 无参调用（testIfNeedRedraw/_setPluginIndex/_prepareRender等）使用当前 styleCounter，
        // 与携带 tileData 的调用（_prepareTile/_drawTile）在非 default render 下结果一致，
        // 统一 key 避免无参(key=-1)/有参(key=styleCounter)交替导致缓存每帧失效重建数组。
        // default render 且携带 tileData 时拼装结果依赖 tileData.layers（各瓦片可能不同），不能缓存。
        if (!this.layer) {
            return [];
        }
        const styleCounter = tileData && !isNil(tileData.styleCounter) ? tileData.styleCounter : this._styleCounter;
        const isDefaultWithData = this.layer.isDefaultRender() && tileData;
        if (!isDefaultWithData && this._framePluginsCache && this._framePluginsCache[0] === styleCounter) {
            return this._framePluginsCache[1];
        }
        let plugins = this._getStylePlugins(styleCounter) || [];
        if (this.layer.isDefaultRender() && this._layerPlugins) {
            plugins = [];
            if (tileData) {
                if (tileData.layers) {
                    tileData.layers.forEach(info => {
                        if (!info) {
                            return;
                        }
                        const pluginTypeName = ('plugin_' + info.type).trim();
                        plugins.push(this._layerPlugins[info.layer][pluginTypeName].plugin);
                    });
                }
            } else {
                Object.keys(this._layerPlugins).forEach(layer => {
                    for (let i = 0; i < this._layerPlugins[layer].length; i++) {
                        plugins.push(this._layerPlugins[layer][i].plugin);
                    }
                });
            }
        }
        const featurePlugins = this._getFeaturePlugins(styleCounter);
        if (featurePlugins && featurePlugins.length) {
            plugins = plugins.slice();
            pushIn(plugins, featurePlugins);
        }
        if (!isDefaultWithData) {
            this._framePluginsCache = [styleCounter, plugins];
        }
        return plugins;
    }

    _getAllPlugins() {
        // 按 styleCounter 缓存拼装结果，style 未变化时直接复用，避免每帧重复创建数组
        const styleCounter = this._styleCounter;
        const isDefaultRender = this.layer.isDefaultRender();
        if (this._allPluginsCache &&
            this._allPluginsCacheStyleCounter === styleCounter &&
            this._allPluginsCacheIsDefault === isDefaultRender) {
            return this._allPluginsCache;
        }
        let plugins;
        if (isDefaultRender && this._layerPlugins) {
            plugins = [];
            Object.keys(this._layerPlugins).forEach(layer => {
                for (let i = 0; i < this._layerPlugins[layer].length; i++) {
                    plugins.push(this._layerPlugins[layer][i].plugin);
                }
            });
        } else {
            plugins = [];
            for (const p in this._plugins) {
                plugins.push(...this._plugins[p]);
            }
            for (const p in this._featurePlugins) {
                plugins.push(...this._featurePlugins[p]);
            }
        }
        this._allPluginsCache = plugins;
        this._allPluginsCacheStyleCounter = styleCounter;
        this._allPluginsCacheIsDefault = isDefaultRender;
        return plugins;
    }

    _getStylePlugins(styleCounter) {
        if (isNil(styleCounter)) {
            styleCounter = this._styleCounter;
        }
        return this._plugins[styleCounter] || EMPTY_ARRAY;
    }

    _getFeaturePlugins(styleCounter) {
        if (isNil(styleCounter)) {
            styleCounter = this._styleCounter;
        }
        return this._featurePlugins[styleCounter] || EMPTY_ARRAY;
    }

    _createTempRenderContext(timestamp, isRenderingTerrain) {
        const regl = this.regl || this.device;
        const gl = this.gl;
        // Terrain skin passes carry an offscreen target and viewport that must
        // not survive into the main pass when its parent omits those fields.
        const context = {
            regl,
            layer: this.layer,
            gl,
            isRenderingTerrain,
            timestamp
        };
        const parentContext = this._parentContext;
        if (parentContext) {
            extend(context, parentContext);
        }
        return context;

    }

    _startFrame(timestamp, filter) {
        const isRenderingTerrain = this._isRenderingTerrain();
        const useDefault = this.layer.isDefaultRender() && this._layerPlugins;
        const plugins = this._getAllPlugins();
        const renderContext = this._createTempRenderContext(timestamp, isRenderingTerrain);
        renderContext.sceneConfig = null;
        renderContext.dataConfig = null;
        renderContext.pluginIndex = null;
        renderContext.symbol = null;

        for (let i = 0, len = plugins.length; i < len; i++) {
            const plugin = plugins[i];
            const idx = i;

            if (!plugin || filter && !filter(plugin)) {
                continue;
            }
            const visible = this._isVisible(idx);
            if (!visible) {
                continue;
            }
            const symbol = useDefault ? plugin.defaultSymbol : plugin.style && plugin.style.symbol;
            const sceneConfig = plugin.config ? plugin.config.sceneConfig : null;
            const dataConfig = plugin.config ? plugin.config.dataConfig : null;

            renderContext.symbol = null;
            renderContext.sceneConfig = null;
            renderContext.dataConfig = null;
            renderContext.pluginIndex = null;

            renderContext.pluginIndex = idx;
            renderContext.symbol = symbol;
            renderContext.sceneConfig = sceneConfig;
            renderContext.dataConfig = dataConfig;

            // const context = {
            //     regl,
            //     layer: this.layer,
            //     symbol,
            //     gl,
            //     isRenderingTerrain,
            //     sceneConfig: plugin.config ? plugin.config.sceneConfig : null,
            //     dataConfig: plugin.config ? plugin.config.dataConfig : null,
            //     pluginIndex: idx,
            //     timestamp
            // };
            // if (parentContext) {
            //     extend(context, parentContext);
            // }
            plugin.startFrame(renderContext);
        }
    }

    _endFrame(timestamp) {
        const parentContext = this._parentContext;
        const mode = parentContext.renderMode;
        const targetFBO = parentContext && parentContext.renderTarget && parentContext.renderTarget.fbo;
        const cameraPosition = this.getMap().cameraPosition;
        const plugins = this._getAllPlugins();
        // terrain skin的相关数据已经在renderTerrainSkin中绘制，这里就不再绘制
        const isRenderingTerrain = this._isRenderingTerrain();
        const isFinalRender = !parentContext.timestamp || parentContext.isFinalRender;


        const renderContext = this._createTempRenderContext(timestamp, isRenderingTerrain);
        renderContext.sceneConfig = null;
        renderContext.pluginIndex = null;

        const map = this.getMap();
        // 获取当前地图交互状态（平移/缩放/旋转），isInteracting=true 时仅平移，碰撞结果可复用。
        // Capture the current map interaction state so we can decide whether collision index rebuilding can be skipped for this frame.
        const isInteracting = map && map.isInteracting && map.isInteracting();
        const isZooming = map && map.isZooming && map.isZooming();
        const isRotating = map && map.isRotating && map.isRotating();
        // 平移交互中，标注的相对屏幕位置不变，碰撞结果可复用上一帧，无需每帧全量重建碰撞索引。
        // 仅当首帧、非交互（瓦片加载/动画后的重绘）、缩放、旋转、或瓦片到达/移除（mesh 集合变化）时更新碰撞，
        // 大幅降低交互（尤其是拖动地图）时的 CPU 开销，提升帧率。
        // 注意：平移中若瓦片到达却不更新碰撞，新瓦片中的点/标注因从未参与碰撞检测
        // （aOpacity 保持 0）而漏渲染。因此 mesh 集合变化（_meshesDirty，addMesh/deleteMesh 时置位）
        // 时仍需更新碰撞；碰撞更新仅处理新增 mesh（_meshesToCheck）并受 collisionFrameLimit
        // 时间片限制，不会导致每帧全量碰撞更新。
        // 遍历所有插件，检查是否有瓦片到达/移除导致的 mesh 集合变更（_meshesDirty 标记）。
        // Walk all plugins to detect whether any tile arrival/removal caused the mesh bag to change (via the _meshesDirty flag).
        let hasMeshChanges = false;
        for (let i = 0, len = plugins.length; i < len; i++) {
            if (plugins[i]._meshesDirty) {
                hasMeshChanges = true;
                break;
            }
        }
        // 碰撞更新判断条件：首帧 / 时间戳变化且（非交互 或 正在缩放 或 正在旋转 或 mesh集合有变化）。
        // Collision-update decision: first frame, OR timestamp changed AND (not-interacting OR zooming OR rotating OR mesh-set changed).
        const needUpdateCollision = !this._collisionTimestamp ||
            (this._collisionTimestamp !== timestamp &&
                (!isInteracting || isZooming || isRotating || hasMeshChanges));

        // maptalks/issues#202, finalRender后不再更新collision，以免后处理（如bloom）阶段继续更新collision造成bug
        if (this.layer.options.collision && !parentContext.isPostProcess && needUpdateCollision) {
            //按照plugin顺序更新collision索引
            for (let i = 0, len = plugins.length; i < len; i++) {
                const plugin = plugins[i];

                if (!this._isVisible(plugin) || !plugin.hasMesh()) {
                    continue;
                }
                if (mode && mode !== 'default' && !plugin.supportRenderMode(mode)) {
                    continue;
                }
                if (isRenderingTerrain && !terrainVectorFilter(plugin)) {
                    continue;
                }
                const context = this._getPluginContext(plugin, 0, cameraPosition, timestamp, renderContext);
                plugin.prepareRender(context);
                plugin.updateCollision(context);
            }
        } else {
            for (let i = 0, len = plugins.length; i < len; i++) {
                const plugin = plugins[i];

                if (!this._isVisible(plugin) || !plugin.hasMesh()) {
                    continue;
                }
                if (mode && mode !== 'default' && !plugin.supportRenderMode(mode)) {
                    continue;
                }
                if (isRenderingTerrain && !terrainVectorFilter(plugin)) {
                    continue;
                }
                const context = this._getPluginContext(plugin, 0, cameraPosition, timestamp, renderContext);
                plugin.prepareRender(context);
            }
        }

        if (this.layer.options.collision && isFinalRender) {
            // 记录本次最终渲染的时间戳，用于碰撞重建窗口判定，避免同一帧反复做 collision update。
            // Timestamp of the latest final render used as a watermark for collision rebuild throttling — avoids redoing collision update inside the same frame.
            this._collisionTimestamp = timestamp;
        }

        const isFirstRender = this._currentTimestamp !== parentContext.timestamp;

        let dirty = false;
        //只在需要的时候才增加polygonOffset
        // Apply polygon offset only once on the first render of the frame (skip during terrain sub-passes)
        // to avoid growing offsets and depth-test issues on every re-entrant draw call.
        if (isFirstRender && !isRenderingTerrain) {
            const groundOffset = this.layer.getPolygonOffset() + this.layer.getPolygonOffsetCount();
            const groundContext = this._getPluginContext(null, groundOffset, cameraPosition, timestamp);
            groundContext.offsetFactor = groundOffset;
            groundContext.offsetUnits = groundOffset
            this._groundPainter.paint(groundContext);
        }
        // 视口内瓦片数 / 加载中瓦片数，用于后续判定动画型 plugin 的 redraw 是否可以被抑制。
        // Track the counts of tiles currently in view vs still loading — used later to decide if we can suppress
        // line/text/icon plugin redraws while the tile set hasn't fully settled.
        const tilesInViewCount = this.tilesInView ? Object.keys(this.tilesInView).length : 0;
        const tilesLoadingCount = this.tilesLoading ? Object.keys(this.tilesLoading).length : 0;
        // 同一图层的所有 painter 共享同一组 stencil tiles（this._stencilTiles），
        // 且 tileInfo.stencilRef 由最后一次 _drawTileStencil 写入、mesh 的 stencilRef 为懒读取，
        // 因此 stencil 方案（isUniqueStencilRefPerTile 相同）一致的 painter 可以复用同一次 stencil 渲染，
        // 避免每个 plugin 都重复 clear + 绘制一遍 stencil，显著减少 draw call 与状态切换。
        let stencilState = -1; // -1: 尚未绘制；0: level-ref 方案；1: unique-ref 方案
        for (let i = 0, len = plugins.length; i < len; i++) {
            const plugin = plugins[i];
            const idx = i;
            const hasMesh = this._isVisitable(plugin);
            if (!hasMesh) {
                continue;
            }
            if (mode && mode !== 'default' && !plugin.supportRenderMode(mode)) {
                continue;
            }
            if (isRenderingTerrain && !terrainVectorFilter(plugin)) {
                continue;
            }
            const polygonOffsetIndex = this._pluginOffsets[idx] || 0;
            const context = this._getPluginContext(plugin, polygonOffsetIndex, cameraPosition, timestamp, renderContext);
            if (plugin.painter && plugin.painter.isEnableTileStencil(context)) {
                const stencilKey = plugin.painter.isUniqueStencilRefPerTile() ? 1 : 0;
                if (stencilState === -1) {
                    this.device.clear({
                        stencil: 0xFF,
                        framebuffer: targetFBO
                    });
                    this._drawTileStencil(targetFBO, plugin.painter);
                    stencilState = stencilKey;
                } else if (stencilState !== stencilKey) {
                    // stencil 方案变化的 painter 按自己的 ref 方案重画（replace 覆盖旧值，无需再 clear）
                    this._drawTileStencil(targetFBO, plugin.painter);
                    stencilState = stencilKey;
                }
            }
            const status = plugin.endFrame(context);
            if (status && status.redraw) {
                const pluginType = plugin && plugin.config && plugin.config.type;
                // 抑制 line / text / icon 动画型 plugin 的额外 redraw：
                //  - 视口中没有瓦片（图层还没加载完），或仍有瓦片在加载中时，
                //    动画帧暂时让位于瓦片成形 / 空层恢复，避免与下载/解析抢主线程。
                // Suppress extra redraws from animated line/text/icon plugins while the tile set is unsettled:
                //   - no tiles in view yet, or tiles are still loading → keep the frame budget free
                //     for tile rasterization and layer recovery instead of racing animation frames with I/O.
                const suppressAnimatedPluginRedraw = (pluginType === 'line' || pluginType === 'text' || pluginType === 'icon') &&
                    (tilesInViewCount === 0 || tilesLoadingCount > 0);
                // 交互过程中地图已经在持续出帧，这里不再让 text/icon 额外触发 redraw，
                // 图层还没站稳时，也先不让 line/text/icon 继续抢帧，
                // 把帧预算留给瓦片成形和空层恢复。
                if (!suppressAnimatedPluginRedraw &&
                    (!isInteracting || (pluginType !== 'text' && pluginType !== 'icon'))) {
                    //let plugin to determine when to redraw
                    this.setToRedraw();
                }
            }
            dirty = true;
        }
        if (dirty) {
            this.layer.fire('canvasisdirty');
        }
        if (isFinalRender) {
            this._drawDebug();
        }
    }

    getPolygonOffsetCount() {
        return this._polygonOffsetIndex || 0;
    }

    _drawDebug() {
        const layer = this.layer;
        if (layer.options['debug']) {
            const parentContext = this._parentContext;
            const mat = [];
            const projViewMatrix = this.getMap().projViewMatrix;
            for (const p in this.tilesInView) {
                const info = this.tilesInView[p].info;
                const tileImage = this.tilesInView[p].image;
                if (tileImage._empty) {
                    continue;
                }
                const transform = info.transform;
                const extent = tileImage.extent;
                const renderTarget = parentContext && parentContext.renderTarget;
                if (transform && extent) {
                    const debugInfo = this.getDebugInfo(info.id);
                    const matrix = mat4.multiply(mat, projViewMatrix, transform);
                    const tileSize = this.layer.getTileSize().width;
                    this._debugPainter.draw(
                        debugInfo, matrix,
                        tileSize, extent,
                        renderTarget && renderTarget.fbo
                    );
                }
            }
        }
    }

    _isVisitable(plugin) {
        if (!plugin) {
            return true;
        }
        const parentContext = this._parentContext;
        const visible = this._isVisible(plugin);
        const includesChanged = parentContext && parentContext.states && parentContext.states.includesChanged;
        const hasMesh = this._hasMesh(plugin.painter.scene.getMeshes());
        const empty = !visible || !includesChanged && !hasMesh;
        if (empty) {
            return 0;
        } else {
            return hasMesh ? 2 : 1;
        }
    }

    _getPluginContext(plugin, polygonOffsetIndex, cameraPosition, timestamp, renderContext) {
        const isRenderingTerrain = this._isRenderingTerrain();
        const isRenderingTerrainSkin = isRenderingTerrain && plugin && terrainSkinFilter(plugin);
        if (renderContext) {
            renderContext.isRenderingTerrain = isRenderingTerrain;
            renderContext.isRenderingTerrainSkin = isRenderingTerrainSkin;
            renderContext.polygonOffsetIndex = polygonOffsetIndex;
            renderContext.cameraPosition = cameraPosition;
            renderContext.timestamp = timestamp;

            renderContext.sceneConfig = null;
            renderContext.pluginIndex = null;
            renderContext.sceneConfig = plugin && plugin.config.sceneConfig;
            renderContext.pluginIndex = plugin && plugin.renderIndex;
            return renderContext;
        }
        const regl = this.regl || this.device;
        const gl = this.gl;
        const context = {
            regl,
            layer: this.layer,
            gl,
            isRenderingTerrain,
            isRenderingTerrainSkin,
            sceneConfig: plugin && plugin.config.sceneConfig,
            pluginIndex: plugin && plugin.renderIndex,
            polygonOffsetIndex,
            cameraPosition,
            timestamp
        };
        const parentContext = this._parentContext;
        if (parentContext) {
            extend(context, parentContext);
        }
        if (plugin && plugin.isTerrainMask() && context.renderTarget) {
            context.renderTarget = {
                fbo: parentContext.terrainMaskFBO
            }
        }
        return context;
    }

    _hasMesh(meshes) {
        if (!meshes) {
            return false;
        }
        const filter = this._parentContext && this._parentContext.sceneFilter;
        if (!filter) {
            return meshes.length > 0;
        }
        // 还要检查是否存在 hlBloomMesh
        for (let i = 0, len = meshes.length; i < len; i++) {
            const mesh = meshes[i];
            if (filter(mesh) || mesh.properties.hlBloomMesh && filter(mesh.properties.hlBloomMesh)) {
                return true;
            }
        }
        return false;
    }

    _drawTileStencil(fbo, painter) {
        const uniqueRef = painter.isUniqueStencilRefPerTile();
        const tileZoom = this.getCurrentTileZoom();
        let stencilRenderer = this._stencilRenderer;
        if (!stencilRenderer) {
            stencilRenderer = this._stencilRenderer = new TileStencilRenderer(this.regl || this.device, this.canvas, this.getMap());
        }
        stencilRenderer.start();
        const { tiles } = this._stencilTiles;
        let { parentTiles, childTiles } = this._stencilTiles;
        let ref = 1;
        childTiles = childTiles.sort(sortByLevel);
        for (let i = 0; i < childTiles.length; i++) {
            const stencilRef = uniqueRef ? ref : this.getTileLevelValue(childTiles[i].info, tileZoom);
            this._addTileStencil(childTiles[i].info, stencilRef);
            ref++;
        }
        parentTiles = parentTiles.sort(sortByLevel);
        for (let i = 0; i < parentTiles.length; i++) {
            const stencilRef = uniqueRef ? ref : this.getTileLevelValue(parentTiles[i].info, tileZoom);
            this._addTileStencil(parentTiles[i].info, stencilRef);
            ref++;
        }
        //默认情况下瓦片是按照level从小到大排列的，所以倒序排列，让level较小的tile最后画（优先级最高）
        const currentTiles = tiles.sort(sortByLevel);
        for (let i = currentTiles.length - 1; i >= 0; i--) {
            const stencilRef = uniqueRef ? ref : this.getTileLevelValue(currentTiles[i].info, tileZoom);
            this._addTileStencil(currentTiles[i].info, stencilRef);
            ref++;
        }

        stencilRenderer.render(fbo);
    }

    _addTileStencil(tileInfo, ref) {
        const tilePoint = TILE_POINT.set(tileInfo.extent2d.xmin, tileInfo.extent2d.ymax);
        const extent = tileInfo.extent || this._receivedTileExtent || 8192;
        const tileTransform = tileInfo.transform = tileInfo.transform || this.calculateTileMatrix(tilePoint, tileInfo.z, extent);
        tileInfo.stencilRef = ref;
        this._stencilRenderer.add(ref, extent, tileTransform);
    }

    onDrawTileStart(context) {
        super.onDrawTileStart(context);
        // 不在这里重置 _lastBackgroundTileOpacity 为 undefined，
        // 因为后续 Painter.callShader 需要此值来控制背景瓦片几何体的不透明度渐隐。
        // 如果当前帧有背景瓦片（childTiles/parentTiles），则在 onDrawTileStart 阶段
        // 就将 _lastBackgroundTileOpacity 设置为背景瓦片的不透明度值，
        // 确保即使是当前瓦片渲染时，callBackgroundTileShader 也能获取到正确的渐隐系数。
        const hasBgTiles = (context.childTiles && context.childTiles.length > 0) ||
                           (context.parentTiles && context.parentTiles.length > 0);
        if (!hasBgTiles) {
            this._lastBackgroundTileOpacity = undefined;
        }
        const { tiles, childTiles, parentTiles } = context;
        this._vtCurrentTiles = {};
        this._vtBgTiles = {};
        for (let i = 0; i < tiles.length; i++) {
            this._vtCurrentTiles[tiles[i].info.id] = 1;
        }
        for (let i = 0; i < childTiles.length; i++) {
            this._vtBgTiles[childTiles[i].info.id] = 1;
        }
        for (let i = 0; i < parentTiles.length; i++) {
            this._vtBgTiles[parentTiles[i].info.id] = 1;
        }
        this._stencilTiles = context;
    }

    isEnableTileStencil() {
        if (this.layer.options.altitude) {
            return false;
        }
        const plugins = this._getFramePlugins();
        for (let i = 0; i < plugins.length; i++) {
            if (!plugins[i] || !plugins[i].painter) {
                continue;
            }
            if (!plugins[i].painter.isOnly2D()) {
                return false;
            }
        }
        return true;
    }

    setTerrainHelper(terrainLayer) {
        const changed = !!this._terrainLayer !== !!terrainLayer;
        this._terrainLayer = terrainLayer;
        if (changed && this.layer.options['awareOfTerrain']) {
            this.clear();
            this.setToRedraw();
        }
    }

    getTerrainHelper() {
        return this._terrainLayer;
    }

    // 有地形时的tile draw 方法
    drawTileOnTerrain(...args) {
        // drawTile 有可能在GroupGLLayer被替换，但prototype上的定义是不会被替换的
        // VectorTileLayerRenderer.prototype.drawTile.call(this, tileInfo, tileData, terrainSkinFilter);
        VectorTileLayerRenderer.prototype.drawTile.call(this, ...args);
    }

    createTerrainTexture(regl) {
        const tileSkinScale = this.getTerrainHelper().options.skinScale;
        const tileSize = this.layer.getTileSize().width;
        const width = tileSize * tileSkinScale;
        const height = tileSize * tileSkinScale;
        const color = regl.texture({
            min: 'linear',
            mag: 'linear',
            type: 'uint8',
            width,
            height
        });
        if (!this._terrainDepthStencil) {
            this._terrainDepthStencil = regl.texture({
                width,
                height,
                format: 'depth stencil'
            });
        }
        const fboInfo = {
            width,
            height,
            colors: [color],
            // stencil: true,
            // colorCount,
            colorFormat: 'rgba',
            ignoreStatusCheck: true
        };
        fboInfo.depthStencil = this._terrainDepthStencil;
        const texture = regl.framebuffer(fboInfo)
        texture.colorTex = color;
        // 单独创建的 color 必须要手动destroy回收，光destroy framebuffer，color是不会销毁的
        return texture;
    }

    deleteTerrainTexture(texture) {
        texture.destroy();
        if (texture.colorTex) {
            texture.colorTex.destroy();
            delete texture.colorTex;
        }
    }

    renderTerrainSkin(terrainRegl, terrainLayer, skinImages) {
        if (!this.ready) {
            return;
        }
        const { plugins, featurePlugins } = this._preparePlugins();
        if (!this.layer.isDefaultRender() && (!plugins.length && !featurePlugins.length)) {
            return;
        }
        const skinScale = this.getTerrainHelper().options.skinScale;
        this.isRenderingTerrainSkin = true;
        const timestamp = this._currentTimestamp;
        const parentContext = this._parentContext;
        const tileSize = this.layer.getTileSize().width;
        const filter = plugin => {
            return terrainSkinFilter(plugin) && this.layer.options.awareOfTerrain;
        }
        for (let i = 0; i < skinImages.length; i++) {
            this._startFrame(timestamp, filter);
            const skinImage = skinImages[i];
            const texture = skinImage.texture;
            this._parentContext = {
                tile: skinImage.tile,
                terrainMaskFBO: skinImage.terrainMaskFBO,
                renderTarget: {
                    fbo: texture
                }
            };
            TERRAIN_CLEAR.framebuffer = texture;
            terrainRegl.clear(TERRAIN_CLEAR);
            this._parentContext.maskViewport = getTileViewport(skinImage.terrainMaskFBO.width);
            this._parentContext.viewport = getTileViewport(tileSize * skinScale);
            // 如果矢量瓦片的目标绘制尺寸过大，拉伸后会过于失真，还不如不去绘制
            this._drawTerrainTile(skinImage.tile);
            this._endTerrainFrame(skinImage);
        }

        this._parentContext = parentContext;
        this.isRenderingTerrainSkin = false;
    }

    _drawTerrainTile(tile) {
        const { info, image } = tile;
        this.drawTile(info, image, terrainSkinFilter);
    }

    _endTerrainFrame(skinImage) {
        const plugins = this._getAllPlugins();
        const cameraPosition = this.getMap().cameraPosition;
        const timestamp = this._currentTimestamp || 0;

        if (this.layer.options.collision) {
            //按照plugin顺序更新collision索引
            plugins.forEach((plugin) => {
                if (!this._isVisible(plugin) || !plugin.hasMesh()) {
                    return;
                }
                if (!terrainSkinFilter(plugin) || !this.layer.options.awareOfTerrain) {
                    return;
                }
                const context = this._getPluginContext(plugin, 0, cameraPosition, timestamp);
                context.isRenderingTerrainSkin = true;
                plugin.prepareRender(context);
                plugin.updateCollision(context);
            });
        } else {
            plugins.forEach((plugin) => {
                if (!this._isVisible(plugin) || !plugin.hasMesh()) {
                    return;
                }
                if (!terrainSkinFilter(plugin) || !this.layer.options.awareOfTerrain) {
                    return;
                }
                const context = this._getPluginContext(plugin, 0, cameraPosition, timestamp);
                context.isRenderingTerrainSkin = true;
                plugin.prepareRender(context);
            });
        }

        plugins.forEach((plugin, idx) => {
            const hasMesh = this._isVisitable(plugin);
            if (!hasMesh || !terrainSkinFilter(plugin)) {
                return;
            }
            const texture = skinImage.texture;
            this.device.clear({
                stencil: 0xFF,
                framebuffer: texture
            });
            const polygonOffsetIndex = this._pluginOffsets[idx] || 0;
            const context = this._getPluginContext(plugin, polygonOffsetIndex, [0, 0, 0], this._currentTimestamp);
            context.isRenderingTerrainSkin = true;
            plugin.endFrame(context);
        });
    }

    drawTile(tileInfo, tileData, filter) {
        if (!tileData.cache) return;
        const isRenderingTerrain = this._isRenderingTerrain();
        const tileCache = tileData.cache;
        const tilePoint = TILE_POINT.set(tileInfo.extent2d.xmin, tileInfo.extent2d.ymax);
        const extent = tileInfo.extent || this._receivedTileExtent || 8192;
        const tileTransform = tileInfo.transform = tileInfo.transform || this.calculateTileMatrix(tilePoint, tileInfo.z, extent);
        const tileTranslationMatrix = tileInfo.tileTranslationMatrix = tileInfo.tileTranslationMatrix || this.calculateTileTranslationMatrix(tilePoint, tileInfo.z);
        const terrainTileTransform = tileInfo.terrainTransform = tileInfo.terrainTransform || this.calculateTerrainTileMatrix(tilePoint, tileInfo.z, extent);

        const parentContext = this._parentContext;
        const pluginData = [];
        pushIn(pluginData, tileData.data);
        pushIn(pluginData, tileData.featureData);

        const plugins = this._getFramePlugins(tileData);

        // isRenderingTerrain为true，但isRenderingTerrainSkin为false，说明是 terrainVector 的绘制阶段
        if (!filter && isRenderingTerrain && !this.isRenderingTerrainSkin) {
            filter = terrainVectorFilter;
        }
        const regl = this.regl || this.device;
        const gl = this.gl;
        // 复用持久化的 renderContext 对象，避免每帧每个瓦片分配新对象
        // 注意：与 _getPluginContext 使用的 this._renderContext 区分开，避免帧内互相覆盖
        const renderContext = this._tileRenderContext;
        renderContext.regl = regl;
        renderContext.layer = this.layer;
        renderContext.gl = gl;
        renderContext.sceneConfig = null;
        renderContext.pluginIndex = null;
        renderContext.tileCache = null;
        renderContext.tileData = null;
        renderContext.tileTransform = null;
        renderContext.tileVectorTransform = tileTransform;
        renderContext.tileTranslationMatrix = tileTranslationMatrix;
        renderContext.tileExtent = tileData.extent;
        renderContext.timestamp = this._frameTime;
        renderContext.tileInfo = tileInfo;
        renderContext.tileZoom = this['_tileZoom'];
        renderContext.bloom = this._parentContext && this._parentContext.bloom;
        renderContext.isRenderingTerrain = isRenderingTerrain;
        renderContext.isRenderingTerrainSkin = null;
        renderContext.renderTarget = null;
        // 传递背景瓦片透明度以在 GL 着色器中实现渐隐效果
        if (this.drawingParentTiles || this.drawingChildTiles) {
            renderContext.tileOpacity = this._backgroundTileOpacity || 0.3;
            this._lastBackgroundTileOpacity = this._backgroundTileOpacity || 0.3;
        } else {
            renderContext.tileOpacity = 1.0;
        }
        if (isRenderingTerrain && parentContext && parentContext.terrainMaskFBO) {
            parentContext.terrainMaskFBO.clearTerrainMask();
        }
        for (let i = 0, len = plugins.length; i < len; i++) {
            const plugin = plugins[i];
            const idx = i;
            if (!plugin || filter && !filter(plugin)) {
                continue;
            }
            if (!pluginData[idx]) {
                continue;
            }
            if (!tileCache[idx]) {
                continue;
            }
            if (tileCache[idx].plugin !== plugin) {
                if (tileCache[idx]) {
                    plugin.deleteTile({
                        pluginIndex: idx,
                        regl: this.regl,
                        layer: this.layer,
                        gl: this.gl,
                        tileCache: tileCache[idx],
                        tileInfo: tileInfo
                    });
                }
                continue;
            }
            if (this.drawingParentTiles && !plugin.painter.shouldDrawParentTile()) {
                continue;
            }
            const isRenderingTerrainSkin = isRenderingTerrain && terrainSkinFilter(plugin);

            // renderContext.sceneConfig = null;
            // renderContext.pluginIndex = null;
            // renderContext.tileData = null;
            // renderContext.tileCache = null;
            // renderContext.tileTransform = null;
            // renderContext.isRenderingTerrainSkin = null;
            renderContext.renderTarget = null;

            renderContext.sceneConfig = plugin.config.sceneConfig;
            renderContext.pluginIndex = idx;
            renderContext.tileCache = tileCache[idx];
            renderContext.tileData = pluginData[idx];
            renderContext.tileTransform = isRenderingTerrainSkin ? terrainTileTransform : tileTransform;
            renderContext.isRenderingTerrainSkin = isRenderingTerrainSkin;

            // const context = {
            //     regl,
            //     layer: this.layer,
            //     gl,
            //     sceneConfig: plugin.config.sceneConfig,
            //     pluginIndex: idx,
            //     tileCache: tileCache[idx],
            //     tileData: pluginData[idx],
            //     tileTransform: isRenderingTerrainSkin ? terrainTileTransform : tileTransform,
            //     tileVectorTransform: tileTransform,
            //     tileTranslationMatrix,
            //     tileExtent: tileData.extent,
            //     timestamp: this._frameTime,
            //     tileInfo,
            //     tileZoom: this['_tileZoom'],
            //     bloom: this._parentContext && this._parentContext.bloom,
            //     isRenderingTerrain,
            //     isRenderingTerrainSkin
            // };
            if (isRenderingTerrainSkin && parentContext && parentContext.renderTarget) {
                // 渲染 terrain skin 时，每个瓦片需要绘制到各自的renderTarget里（terrain texture）
                renderContext.renderTarget = parentContext.renderTarget;
                if (plugin.isTerrainMask()) {
                    renderContext.renderTarget = {
                        fbo: parentContext.terrainMaskFBO
                    }
                }
            }
            const status = plugin.paintTile(renderContext);
            if (!this._needRetire && (status.retire || status.redraw) && plugin.supportRenderMode('taa')) {
                this._needRetire = true;
            }
            if (status.redraw) {
                //let plugin to determine when to redraw
                this.setToRedraw();
            }
        }
        if (tileData && tileData.style === this._styleCounter) {
            this._retirePrevTile(tileInfo);
        }
    }

    _createOneTile(tileInfo, tileData) {
        if (!tileData.loadTime || tileData._empty) return;
        // const parentContext = this._parentContext;
        let tileCache = tileData.cache;
        if (!tileCache) {
            tileCache = tileData.cache = {};
        }
        const isRenderingTerrain = this._isRenderingTerrain();
        const tilePoint = TILE_POINT.set(tileInfo.extent2d.xmin, tileInfo.extent2d.ymax);
        const tileTransform = tileInfo.transform = tileInfo.transform || this.calculateTileMatrix(tilePoint, tileInfo.z, tileData.extent);
        const tileTranslationMatrix = tileInfo.tileTranslationMatrix = tileInfo.tileTranslationMatrix || this.calculateTileTranslationMatrix(tilePoint, tileInfo.z);
        const terrainTileTransform = tileInfo.terrainTransform = tileInfo.terrainTransform || this.calculateTerrainTileMatrix(tilePoint, tileInfo.z, tileInfo.extent);
        const pluginData = [];
        pushIn(pluginData, tileData.data);
        pushIn(pluginData, tileData.featureData);

        const plugins = this._getFramePlugins(tileData);

        plugins.forEach((plugin, idx) => {
            if (!plugin) {
                return;
            }
            if (!pluginData[idx]) {
                return;
            }
            const isRenderingTerrainSkin = isRenderingTerrain && terrainSkinFilter(plugin);
            const regl = this.regl || this.device;
            const gl = this.gl;
            if (!tileCache[idx] || tileCache[idx].plugin !== plugin) {
                if (tileCache[idx]) {
                    plugin.deleteTile({
                        pluginIndex: idx,
                        regl: this.regl,
                        layer: this.layer,
                        gl: this.gl,
                        tileCache: tileCache[idx],
                        tileInfo: tileInfo
                    });
                }
                tileCache[idx] = {
                    plugin
                };
            }
            const context = {
                regl,
                layer: this.layer,
                gl,
                sceneConfig: plugin.config.sceneConfig,
                pluginIndex: idx,
                tileCache: tileCache[idx],
                tileData: pluginData[idx],
                tileTransform: isRenderingTerrainSkin ? terrainTileTransform : tileTransform,
                tileVectorTransform: tileTransform,
                isRenderingTerrain,
                isRenderingTerrainSkin,
                tileTranslationMatrix,
                tileExtent: tileData.extent,
                timestamp: this._frameTime,
                tileInfo,
                tileZoom: this['_tileZoom']
            };
            const status = plugin.createTile(context);
            if (!status.loading && tileCache[idx].geometry) {
                //插件数据以及经转化为geometry，可以删除原始数据以节省内存
                if (idx < tileData.data.length) {
                    tileData.data[idx] = 'geometry created';
                }
                // feature plugins 的数据存储在 featureData 数组中，geometry 创建后同样需要释放
                if (tileData.featureData && idx >= tileData.data.length) {
                    tileData.featureData[idx - tileData.data.length] = 'geometry created';
                }
            }
        });
    }

    checkTileInQueue(tileData) {
        return tileData.styleCounter === this._styleCounter;
    }

    pick(x, y, options) {
        const hits = [];
        if (!this.layer.isVisible()) {
            return hits;
        }
        const plugins = this._getFramePlugins();
        plugins.forEach((plugin) => {
            if (!plugin) {
                return;
            }
            const sceneConfig = plugin.painter && plugin.painter.sceneConfig;
            if (sceneConfig.picking === false) {
                return;
            }
            const visible = plugin.isVisible();
            if (!visible) {
                return;
            }
            const picked = plugin.pick(x, y, options.tolerance);
            if (picked) {
                picked.type = plugin.getType();
                hits.push(picked);
            }
        });
        hits.forEach(item => {
            const data = item.data || {};
            const tile = data.tile;
            if (tile) {
                const tileCacheItem = this.tileCache.get(tile.id) || {};
                wrapVTFeatureGeometryInfo(this.layer.options.features, tileCacheItem.image, [data])
            }
        });
        return hits;
    }

    /**
     * Lazily fetch full feature properties by tileInfo + featureIds.
     * Used in features:'id' mode when identify/getRenderedFeatures needs
     * to resolve properties on demand.
     *
     * 【中文】按需懒加载获取指定瓦片（tileInfo）中指定 featureIds 的完整要素属性。
     * 【中文】用于 features:'id' 模式下，调用 identify() / getRenderedFeatures() 时按需解析属性。
     *
     * @param {Object} tileInfo - tile info with url/key
     * @param {string[]} featureIds
     * @returns {Promise<Object>} propsById
     */
    fetchFeatureProperties(tileInfo, featureIds) {
        return new Promise((resolve) => {
            if (!this._workerConn) {
                resolve({});
                return;
            }
            const tileKey = tileInfo && (tileInfo.id || tileInfo.url);
            if (!tileKey || !featureIds || !featureIds.length) {
                resolve({});
                return;
            }
            // Pass x,y from tileInfo so getFeatureProperties can route to
            // the same worker that loaded the tile (same (x+y)%count hash).
            // 【中文】传递 tileInfo 的 x,y 坐标，确保请求路由到加载该瓦片的同一个 Worker
            // 【中文】（使用 (x+y)%Worker数量 的相同哈希算法，保证数据在同一个 Worker 中可查询）。
            const wx = tileInfo.x, wy = tileInfo.y;
            this._workerConn.getFeatureProperties(tileKey, featureIds, wx, wy, (err, result) => {
                if (err) {
                    console.warn('[VT] fetchFeatureProperties error:', err);
                    resolve({});
                } else {
                    resolve(result || {});
                }
            });
        });
    }

    deleteTile(tile) {
        if (!tile) {
            return;
        }
        // 与基类 deleteTile 一致：LRU 内存驱逐不得销毁当前正在显示的瓦片。
        // 高 zoom VT 瓦片单片 4-8MB，内存预算不足时 shrink() 从 LRU 最旧端批量驱逐，
        // 若命中 tilesInView 中 current=true 的可见瓦片，在此销毁 buffers/GL 资源
        // 会导致下一帧 getCachedTile 找不到 → "瓦片一闪就消失"。
        // 可见瓦片仅解除 LRU 引用（内存计数已减），由 tilesInView 继续持有，
        // 退出视口（current=false）后由 retireTiles 走正常销毁路径。
        const tileId = tile.info && tile.info.id;
        if (tileId != null && this.tilesInView && this.tilesInView[tileId] === tile && tile.current) {
            return;
        }
        if (tile.image && !tile.image._empty) {
            const buffers = [];
            if (tile.image.buffers) {
                for (let i = 0; i < tile.image.buffers.length; i++) {
                    if (tile.image.buffers[i] instanceof ArrayBuffer) {
                        buffers.push(tile.image.buffers[i]);
                    }
                }
            }
            if (buffers.length > 0 && this._workerConn) {
                this._workerConn.returnBuffers(buffers, tile.image.workerId);
            }

            delete tile.image.featuresTypeArray;
            delete tile.image.featuresFullJSON;
            const styleCounter = tile.image && tile.image.style;
            const plugins = this._getStylePlugins(styleCounter);
            if (plugins) {
                plugins.forEach((plugin, idx) => {
                    if (!plugin) {
                        return;
                    }
                    plugin.deleteTile({
                        pluginIndex: idx,
                        regl: this.regl,
                        layer: this.layer,
                        gl: this.gl,
                        tileCache: tile.image.cache ? tile.image.cache[idx] : {},
                        tileInfo: tile.info,
                        tileData: tile.image
                    });
                });
            }
            tile.image.cache = {};
            // 显式释放主线程保留的大对象引用，帮助 GC 尽快回收 ArrayBuffer/Feature 数据
            tile.image.buffers = [];
            // 若该 image 仍被 _partialTileData 引用（pointOnly 阶段尚未合并），
            // 不能置空 data/featureData：_mergePointData 会以 mainData = partial.data
            // 读取 mainData.data[i] = pluginData，置空后抛 "Cannot set properties of null"。
            // _mergePointData 完成后会自行 delete _partialTileData[url]，届时数据随
            // 该引用一起释放；若 pointOnly 永不到达，由 abortTileLoading / 同 url
            // 重新请求时的覆盖逻辑清理。
            const partialUrl = tile.info && tile.info.url;
            const partialEntry = partialUrl ? this._partialTileData[partialUrl] : null;
            const isPartialRef = partialEntry && partialEntry.data === tile.image;
            if (!isPartialRef) {
                tile.image.data = null;
                tile.image.featureData = null;
            }
            tile.image.features = null;
            tile.image.workerId = null;
            tile.image.style = null;
            tile.image.error = null;
            tile.image._empty = true;
        }
        if (tile.info) {
            delete tile.info.completeTerrainQuery;
            delete tile.info.terrainQueryStatus;
        }
        //ask plugin to clear caches
        super.deleteTile(tile);
    }

    abortTileLoading(tileImage, tileInfo) {
        const tileUrl = tileInfo ? getTileAbsoluteUrl(tileInfo) : '';
        if (tileInfo && tileInfo.url) {
            if (this._workerConn) {
                this._workerConn.abortTile(tileUrl);
            }
            delete this._requestingMVT[tileInfo.url];
            const partial = this._partialTileData[tileInfo.url];
            if (partial && partial.tileDatas && partial.tileDatas.length > 0) {
                // 【修复】partial 已解析并有瓦片上屏，拆分回传第二阶段 pointOnly
                // 可能仍在途：保留 partial/pending，使到达的 pointOnly 仍能合并到
                // 已上屏瓦片，避免点要素被 abort 永久丢弃（表现为配置层级下部分点
                // 首次不显示、放大缩小后才恢复）。同 url 重新请求时会被新数据覆盖，
                // 瓦片销毁时 tileData 由 deleteTile 清空，残留引用随之失效。
                if (partial.parsing) {
                    // 中断的 per-tile 分片不再继续，解除 parsing 标记，
                    // 使 pointOnly 到达后能直接合并到已上屏瓦片
                    partial.parsing = false;
                    // 【修复】若 pointOnly 已在分片期间到达并暂存 _pendingPointData，
                    // 分片终止后 _processTileBatch 末尾的合并逻辑不再执行，
                    // 必须在此立即合并，否则暂存数据永久滞留、点要素丢失。
                    const pendingPoint = this._pendingPointData[tileInfo.url];
                    if (pendingPoint) {
                        this._mergePointData(tileInfo.url, pendingPoint);
                    }
                }
            } else {
                // 数据尚未上屏（无瓦片被解析过），正常清理避免状态残留
                delete this._partialTileData[tileInfo.url];
                delete this._pendingPointData[tileInfo.url];
            }
            // 若该 url 正处于 per-tile 分片处理中，直接终止，防止残留 entry 引用大块数据
            if (this._parsingTile && this._parsingTile.url === tileInfo.url) {
                this._parsingTile = null;
            }
        }
        if (this.loadTileArrayBuffer && isFunction(this.loadTileArrayBuffer)) {
            this.loadTileArrayBuffer(tileUrl, tileInfo, () => {

            }, {
                command: 'abortTile'
            })
        } else {
            super.abortTileLoading(tileImage, tileInfo);
        }
    }

    resizeCanvas(canvasSize) {
        super.resizeCanvas(canvasSize);
        const canvas = this.canvas;
        if (!canvas) {
            return;
        }
        if (this.pickingFBO && (this.pickingFBO.width !== canvas.width || this.pickingFBO.height !== canvas.height)) {
            this.pickingFBO.resize(canvas.width, canvas.height);
            this._getFramePlugins().forEach(plugin => {
                if (!plugin) {
                    return;
                }
                plugin.resize(canvas.width, canvas.height);
            });
        }
    }

    onRemove() {
        if (this._stencilRenderer) {
            this._stencilRenderer.remove();
        }
        // const map = this.getMap();
        if (this._workerConn) {
            this._workerConn.removeLayer(err => {
                if (err) throw err;
            });
            this._workerConn.remove();
            delete this._workerConn;
        }
        if (this.pickingFBO) {
            if (!this.canvas.pickingFBO) {
                this.pickingFBO.destroy();
            }
            delete this.pickingFBO;
        }
        if (this._debugPainter) {
            this._debugPainter.delete();
            delete this._debugPainter;
        }
        if (this._terrainDepthStencil) {
            this._terrainDepthStencil.destroy();
            delete this._terrainDepthStencil;
        }
        if (this._groundPainter) {
            this._groundPainter.dispose();
            delete this._groundPainter;
        }
        delete this.gl;
        delete this.regl;
        // Release id-mode lookup maps and string pool so removed layers don't leak memory.
        // 【中文】释放 features:'id' 模式下的查找映射表和字符串池，防止图层从地图移除后仍然持续占用内存导致泄漏。
        if (this._tileByIdMap) {
            this._tileByIdMap.clear();
        }
        if (this._featureTileMap) {
            this._featureTileMap.clear();
        }
        clearStringPool();
        if (super.onRemove) super.onRemove();
        this._clearPlugin();
    }

    _clearPlugin() {
        this._getAllPlugins().forEach(plugin => {
            plugin.remove();
        });
        this.plugins = {};
    }

    hitDetect(point) {
        if (!this.gl || !this.layer.options['hitDetect']) {
            return false;
        }
        const gl = this.gl;
        const pixels = new Uint8Array(1 * 1 * 4);
        const h = this.canvas.height;
        gl.readPixels(point.x, h - point.y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        return (pixels[3] > 0);
    }

    _initPlugins() {
        const { style, featureStyle } = this.layer._getComputedStyle();
        const plugins = style.map((style, idx) => {
            const config = style.renderPlugin;
            if (!config) {
                return null;
            }
            if (!config.type) {
                throw new Error('invalid plugin type for style at ' + idx);
            }
            const plugin = this._createRenderPlugin(config);
            plugin.styleCounter = this._styleCounter;
            plugin.style = style;
            return plugin;
        });
        const featurePlugins = [];
        featureStyle.forEach((featureStyle, idx) => {
            const config = featureStyle.renderPlugin;
            if (!config) {
                return null;
            }
            if (!config.type) {
                throw new Error('invalid plugin type for features at ' + idx);
            }
            const plugin = this._createRenderPlugin(config);
            plugin.style = featureStyle;
            plugin.styleCounter = this._styleCounter;
            featurePlugins.push(plugin);
            return plugin;
        });
        const styleCounter = this._styleCounter;
        this._plugins[styleCounter] = plugins;
        this._featurePlugins[styleCounter] = featurePlugins;
        // style 重建，插件缓存与碰撞结果全部失效，需在渲染时重新拼装插件数组并更新碰撞
        this._allPluginsCache = null;
        this._allPluginsCacheStyleCounter = -1;
        this._framePluginsCache = null;
        this._collisionTimestamp = undefined;
        this.layer.fire('pluginsinited');

        if (this._highlighted && this._highlighted.size || this.layer._highlighted) {
            if (this.layer._highlighted) {
                this.layer._resumeHighlights();
            }
            const map = this.getMap();
            const renderer = map.getRenderer();
            renderer.callInNextFrame(() => {
                const plugins = this._getFramePlugins();
                plugins.forEach(plugin => {
                    plugin.highlight(this._highlighted);
                });
            });
        }

        return plugins;
    }

    _createRenderPlugin(config) {
        const pluginClazz = this.layer.constructor.getPlugins();
        const P = pluginClazz[config.type];
        if (!P) {
            throw new Error(`Plugin for (${config.type}) is not loaded.`);
        }
        const p = new P();
        p.config = config;
        if (!p.config.sceneConfig) {
            p.config.sceneConfig = {};
        }
        return p;
    }

    _createGLContext(canvas, options) {
        const names = ['webgl', 'experimental-webgl'];
        let context = null;
        /* eslint-disable no-empty */
        for (let i = 0; i < names.length; ++i) {
            try {
                context = canvas.getContext(names[i], options);
            } catch (e) { }
            if (context) {
                break;
            }
        }
        return context;
        /* eslint-enable no-empty */
    }

    _getCentiMeterScale(res) {
        const map = this.getMap();
        return getCentiMeterScale(res, map);
    }

    debugFBO(id, fbo) {
        const canvas = document.getElementById(id);
        const width = fbo.width, height = fbo.height;
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        const pixels = this.regl.read({
            framebuffer: fbo
        });

        const halfHeight = height / 2 | 0;  // the | 0 keeps the result an int
        const bytesPerRow = width * 4;

        for (let i = 0; i < pixels.length; i++) {
            pixels[i] *= 255;
        }

        // make a temp buffer to hold one row
        const temp = new Uint8Array(width * 4);
        for (let y = 0; y < halfHeight; ++y) {
            const topOffset = y * bytesPerRow;
            const bottomOffset = (height - y - 1) * bytesPerRow;

            // make copy of a row on the top half
            temp.set(pixels.subarray(topOffset, topOffset + bytesPerRow));

            // copy a row from the bottom half to the top
            pixels.copyWithin(topOffset, bottomOffset, bottomOffset + bytesPerRow);

            // copy the copy of the top half row to the bottom half
            pixels.set(temp, bottomOffset);
        }

        // This part is not part of the answer. It's only here
        // to show the code above worked
        // copy the pixels in a 2d canvas to show it worked
        const imgdata = new ImageData(width, height);
        imgdata.data.set(pixels);
        ctx.putImageData(imgdata, 0, 0);
    }

    //TODO 可以把图层合并为只用这三个默认插件绘制
    _getDefaultRenderPlugin(type) {
        let renderPlugin;
        switch (type) {
            case 'native-line':
                renderPlugin = {
                    type: 'native-line',
                    dataConfig: { type: 'native-line', only2D: true }
                };
                break;
            case 'native-point':
                renderPlugin = {
                    type: 'native-point',
                    dataConfig: { type: 'native-point', only2D: true }
                };
                break;
            case 'fill':
                renderPlugin = {
                    type: 'fill',
                    dataConfig: { type: 'fill', only2D: true },
                    sceneConfig: { antialias: true }
                };
                break;
            default:
                renderPlugin = null;
        }
        const symbol = getDefaultSymbol(type);
        const plugin = this._createRenderPlugin(renderPlugin);
        plugin.defaultSymbol = symbol;
        return {
            plugin, symbol, renderPlugin
        };
    }

    _isVisible() {
        // return plugin.isVisible();
        return true;
    }

    isEnableWorkAround(key) {
        if (key === 'win-intel-gpu-crash') {
            return this.layer.options['workarounds']['win-intel-gpu-crash'] && isWinIntelGPU(this.gl);
        }
        return false;
    }

    getZScale() {
        return this._zScale;
    }

    outline(idx, featureIds) {
        if (!featureIds) {
            return;
        }
        if (!Array.isArray(featureIds)) {
            featureIds = [featureIds];
        }
        if (!this._outline) {
            this._outline = [];
        }
        this._outline.push(['paintOutline', [idx, featureIds]]);
        this.setToRedraw();
    }

    outlineFeatures(featureIds) {
        if (!featureIds) {
            return;
        }
        if (!Array.isArray(featureIds)) {
            featureIds = [featureIds];
        }
        if (!this._outline) {
            this._outline = [];
        }
        this._outline.push(['paintOutline', [null, featureIds]]);
        this.setToRedraw();
    }

    outlineBatch(idx) {
        if (!this._outline) {
            this._outline = [];
        }
        this._outline.push(['paintBatchOutline', [idx]]);
        this.setToRedraw();
    }

    outlineAll() {
        this._outlineAll = true;
        this.setToRedraw();
    }

    paintOutlineAll(fbo) {
        const plugins = this._getFramePlugins();
        for (let i = 0; i < plugins.length; i++) {
            plugins[i].outlineAll(fbo);
        }
    }

    paintOutline(fbo, idx, featureIds) {
        if (!isNil(idx)) {
            const pluginIdx = idx;
            const plugins = this._getFramePlugins();
            if (!plugins[pluginIdx] || plugins[pluginIdx].painter && !plugins[pluginIdx].painter.isVisible()) {
                return;
            }
            plugins[pluginIdx].outline(fbo, featureIds);
            return;
        }
        const feaPlugins = this._getFramePlugins();
        for (let i = 0; i < featureIds.length; i++) {
            const feaId = featureIds[i];
            for (let j = 0; j < feaPlugins.length; j++) {
                if (feaPlugins[j].style && feaPlugins[j].style.id === feaId) {
                    feaPlugins[j].outline(fbo, [feaId]);
                }
            }
        }
    }

    paintBatchOutline(fbo, idx) {
        const plugins = this._getFramePlugins();
        if (!plugins[idx] || plugins[idx].painter && !plugins[idx].painter.isVisible()) {
            return;
        }
        plugins[idx].outlineAll(fbo);
    }

    cancelOutline() {
        delete this._outline;
        delete this._outlineAll;
        this.setToRedraw();
    }

    setZIndex() {
        this.setToRedraw();
        // 不retire的话，taa的图层不会更新，fuzhenn/maptalks-studio#1112
        this._needRetire = true;
        return super.setZIndex.apply(this, arguments);
    }

    consumeTile(tileImage, tileInfo) {
        if (tileImage && !tileImage._empty) {
            const [minAltitude, maxAltitude] = this._findTileAltitude(tileImage);
            tileInfo.minAltitude = minAltitude;
            tileInfo.maxAltitude = maxAltitude;
        }
        this._retirePrevTile(tileInfo);
        super.consumeTile(tileImage, tileInfo);
        if (this.layer.options.features === 'transient' && tileImage.data) {
            for (let j = 0; j < tileImage.data.length; j++) {
                if (!tileImage.data[j]) {
                    continue;
                }
                const features = tileImage.data[j].features;
                if (!features) {
                    continue;
                }
                for (const p in features) {
                    const feature = features[p] && features[p].feature;
                    if (!feature) {
                        continue;
                    }
                    if (feature.fnTypeProps) {
                        feature.customProps[oldPropsKey] = feature.fnTypeProps;
                    } else {
                        features[p] = null;
                    }
                }
            }
            this.layer.fire('_transientfeature', { tileImage });
        }
        if (tileImage && tileImage.features) {
            tileImage.features = [];
        }
        this._createOneTile(tileInfo, tileImage);
    }

    _findTileAltitude(tileImage) {
        const data = tileImage.data;
        let max = -Infinity;
        let min = Infinity;
        for (let i = 0; i < data.length; i++) {
            if (!data[i]) {
                continue;
            }
            const packs = data[i].data;
            if (!packs) {
                continue;
            }
            for (let ii = 0; ii < packs.length; ii++) {
                const pack = packs[ii];
                if (!pack || !pack.properties) {
                    continue;
                }
                const { maxAltitude, minAltitude } = pack.properties;
                if (maxAltitude > max) {
                    max = maxAltitude;
                }
                if (minAltitude < min) {
                    min = minAltitude;
                }
            }
        }
        MINMAX[0] = min === Infinity ? 0 : min;
        MINMAX[1] = max === -Infinity ? 0 : max;
        return MINMAX;
    }

    onTileError(tileImage, tileInfo) {
        this._retirePrevTile(tileInfo);
        super.onTileError(tileImage, tileInfo);
    }

    _retirePrevTile(tileInfo) {
        const { id } = tileInfo;
        if (this._prevTilesInView && this._prevTilesInView[id]) {
            const oldTile = this._prevTilesInView[id];
            this.deleteTile(oldTile);
            delete this._prevTilesInView[id];
        }
    }

    highlight(highlights) {
        if (!this._highlighted) {
            this._highlighted = new Map();
        }
        if (Array.isArray(highlights)) {
            for (let i = 0; i < highlights.length; i++) {
                if (isNil(highlights[i].name) && !isNil(highlights[i].id)) {
                    highlights[i] = extend({}, highlights[i]);
                    highlights[i].name = highlights[i].id;
                }
                this._highlighted.set(highlights[i].name, highlights[i]);
            }
        } else {
            if (isNil(highlights.name) && !isNil(highlights.id)) {
                highlights = extend({}, highlights);
                highlights.name = highlights.id;
            }
            this._highlighted.set(highlights.name, highlights);
        }

        const plugins = this._getFramePlugins();
        plugins.forEach(plugin => {
            plugin.highlight(this._highlighted);
        });
        this._highlightUpdated = true;
    }

    cancelHighlight(names) {
        if (!this._highlighted) {
            return;
        }
        if (Array.isArray(names)) {
            for (let i = 0; i < names.length; i++) {
                this._highlighted.delete(names[i]);
            }
        } else {
            this._highlighted.delete(names);
        }
        const plugins = this._getFramePlugins();
        plugins.forEach(plugin => {
            plugin.highlight(this._highlighted);
        });
        this._highlightUpdated = true;
    }

    cancelAllHighlight() {
        if (!this._highlighted) {
            return;
        }
        delete this._highlighted;
        const plugins = this._getFramePlugins();
        plugins.forEach(plugin => {
            plugin.cancelAllHighlight();
        });
        this._highlightUpdated = true;
    }

    _getLayerOpacity() {
        const layerOpacity = this.layer.options['opacity'];
        return (isNil(layerOpacity) ? 1 : layerOpacity);
    }

    _isRenderingTerrain() {
        return !!this._terrainLayer && this.layer.options['awareOfTerrain'];
    }
}

VectorTileLayerRenderer.include({
    calculateTileMatrix: function () {
        const v0 = new Array(3);
        const v1 = new Array(3);
        const v2 = new Array(3);
        return function (point, z, EXTENT) {
            const glScale = this.getTileGLScale(z);
            const tilePos = point;
            const tileSize = this.layer.getTileSize().width;
            const posMatrix = mat4.identity([]);
            //TODO 计算zScale时，zoom可能和tileInfo.z不同
            mat4.scale(posMatrix, posMatrix, vec3.set(v0, glScale, glScale, this._zScale));
            mat4.translate(posMatrix, posMatrix, vec3.set(v1, tilePos.x, tilePos.y, 0));
            mat4.scale(posMatrix, posMatrix, vec3.set(v2, tileSize / EXTENT, -tileSize / EXTENT, 1));

            return posMatrix;
        };
    }(),

    calculateTerrainTileMatrix: function () {
        const v0 = new Array(3);
        return function (point, z, EXTENT) {
            const posMatrix = mat4.identity([]);
            const halfExtent = EXTENT / 2;
            mat4.scale(posMatrix, posMatrix, vec3.set(v0, 1 / halfExtent, -1 / halfExtent, 0));
            mat4.translate(posMatrix, posMatrix, vec3.set(v0, -halfExtent, -halfExtent, 0));
            return posMatrix;
        };
    }(),

    calculateTileTranslationMatrix: function () {
        // GLTF_Mixin中用到的
        const v0 = new Array(3);
        return function (point, z) {
            const glScale = this.getTileGLScale(z);
            const tilePos = point;
            const posMatrix = mat4.identity([]);
            mat4.translate(posMatrix, posMatrix, vec3.set(v0, tilePos.x * glScale, tilePos.y * glScale, 0));
            return posMatrix;
        };
    }()
});

export default VectorTileLayerRenderer;


function getDefaultSymbol(type) {
    switch (type) {
        case 'native-point':
            return {
                markerFill: '#f00',
                markerSize: 6,
                markerOpacity: 0.5
            };
        case 'native-line':
            return {
                lineColor: '#bbb',
                lineOpacity: 0.5
            };
        case 'fill':
            return {
                polygonFill: '#76a6f0',
                polygonOpacity: 0.8
            };
    }
    return null;
}

export function evaluate(prop, properties, zoom) {
    if (maptalks.Util.isFunction(prop)) {
        if (zoom !== undefined) {
            return prop(zoom, properties);
        } else {
            return prop(null, properties);
        }
    } else {
        return prop;
    }
}

function isWinIntelGPU(gl) {
    const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
    if (debugInfo && typeof navigator !== 'undefined') {
        //e.g. ANGLE (Intel(R) HD Graphics 620
        const gpu = gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL);
        const win = navigator.platform === 'Win32' || navigator.platform === 'Win64';
        if (gpu && gpu.toLowerCase().indexOf('intel') >= 0 && win) {
            return true;
        }
    }
    return false;
}

function copyTileData(data) {
    let arrays;
    if (Array.isArray(data.data)) {
        arrays = [];
        pushIn(arrays, data.data);
    } else {
        arrays = {};
        extend(arrays, data.data);
    }
    const tileData = extend({}, data);
    tileData.data = arrays;
    return tileData;
}

//z小的排在后面
function sortByLevel(m0, m1) {
    return m1.info.z - m0.info.z;
}

function groupFeatures(features) {
    const group = {};
    for (let i = 0; i < features.length; i++) {
        const layer = features[i].layer || 'default';
        if (!group[layer]) {
            group[layer] = [];
        }
        group[layer].push(features[i]);
    }
    return group;
}


function needRefreshStyle(symbol) {
    if (Array.isArray(symbol)) {
        const symbols = symbol;
        for (let i = 0; i < symbols.length; i++) {
            if (needRefreshStyle(symbols[i])) {
                return true;
            }
        }
    }
    for (const p in symbol) {
        if (isFunctionDefinition(symbol[p]) || FilterUtil.isExpression(symbol[p])) {
            return true;
        }
    }
    return false;
}

// function getTileViewport(tile, terrainTileInfo) {
//     const { extent2d: extent, res, offset: terrainOffset } = terrainTileInfo;
//     const scale = tile.info.res / res;
//     const { info } = tile;
//     const offset = info.offset;
//     const width = info.extent2d.getWidth() * scale;
//     const height = info.extent2d.getHeight() * scale;
//     const xmin = info.extent2d.xmin * scale;
//     const ymax = info.extent2d.ymax * scale;
//     const left = xmin - extent.xmin;
//     const top = extent.ymax - ymax;
//     const dx = terrainOffset[0] - offset[0];
//     const dy = offset[1] - terrainOffset[1];
//     return {
//         x: (left + dx) * 2,
//         y: (extent.getHeight() - (top + dy + height)) * 2,
//         width: width * 2,
//         height: height * 2
//     };
// }

function getTileViewport(tileSize) {
    return {
        x: 0,
        y: 0,
        width: tileSize,
        height: tileSize
    };
}

function findFeatures(layer, image) {
    if (!image.cache) {
        return [];
    }
    const result = [];

    for (const p in image.cache) {
        const data = image.cache[p];
        if (!data.geometry) {
            continue;
        }
        for (let i = 0; i < data.geometry.length; i++) {
            const geometry = data.geometry[i] && data.geometry[i].geometry;
            if (geometry && geometry.properties && geometry.properties.features) {
                const empty = geometry.properties.features.empty;
                delete geometry.properties.features.empty;
                const features = Object.values(geometry.properties.features);
                if (empty !== undefined) {
                    geometry.properties.features.empty = empty;
                }
                wrapVTFeatureGeometryInfo(layer.options.features, image, features);
                maptalks.Util.pushIn(result, features);
                // return features;
            }
        }

    }
    return result;
}

function getTileAbsoluteUrl(tile) {
    return maptalks.Util.getAbsoluteURL(tile.url);
}
