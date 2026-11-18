import * as maptalks from 'maptalks';
import { RenderContext, Tile, TileLayer } from 'maptalks';
import * as reshader from '../reshader';
import TexturePoolable from './TexturePoolable';
import { createImageMesh, updateFilter, updateImageMeshLocalTransform } from './util/imageMesh';
import { isNil } from './util/util';
import CanvasCompatible from './CanvasCompatible';

const { TileLayerRendererable, LayerAbstractRenderer, testNeedUpdateAltitude } = maptalks.renderer;

const positionData = new Int16Array([
    0, 0, 0, -1, 1, 0, 1, -1
]);

const texCoords = new Uint16Array([
    0.0, 0.0, 0.0, 1.0, 1.0, 0.0, 1.0, 1.0
]);

const MESH_TO_TEST = { properties: {} };


const DEBUG_POINT = new maptalks.Point(20, 20);

class TileLayerGLRenderer2 extends TexturePoolable(CanvasCompatible(TileLayerRendererable(LayerAbstractRenderer))) {
    //@internal
    _tileGeometry: reshader.Geometry;
    //@internal
    _shader: reshader.ImageShader;
    //@internal
    _tileScene: reshader.Scene;
    //@internal
    _tileMeshes: reshader.Mesh[];
    //@internal
    _renderer: reshader.Renderer;
    _debugInfoCanvas: HTMLCanvasElement;

    constructor(layer: TileLayer) {
        super(layer);
        this.init();
    }

    onResize(param: any): void {
        super.onResize(param);
        this.resizeCanvas();
    }

    onDrawTileStart(context, parentContext: RenderContext) {
        if (!this._tileGeometry) {
            this._shader = new reshader.ImageShader({
                extraCommandProps: this._getCommandProps()
            });
            this._tileGeometry = new reshader.Geometry(
                {
                    aPosition: positionData,
                    aTexCoord: texCoords
                },
                4,
                0,
                {
                    positionSize: 2,
                    primitive: 'triangle strip'
                }
            );
            const { regl, device } = this.context as any;
            this._tileGeometry.generateBuffers(regl || device);
            this._tileMeshes = [];
            this._tileScene = new reshader.Scene(this._tileMeshes);
            this._renderer = new reshader.Renderer(regl || device);
        }
        this._tileMeshes.length = 0;
        this.clearStencil(parentContext);
    }

    clearStencil(parentContext: RenderContext) {
        let fbo;
        if (parentContext && parentContext.renderTarget) {
            fbo = parentContext.renderTarget.fbo;
        }
        const { regl, device } = this.context as any;
        (regl || device).clear({
            stencil: 0xFF,
            fbo
        });
    }

    _drawCurrentTiles(tiles, parentTiles) {
        super._drawCurrentTiles(tiles, parentTiles);
        // Defer submission - meshes are accumulated and submitted once in onDrawTileEnd
        // to reduce WebGL draw calls from 3-4 per frame to 1.
        // The stencil test (per-mesh zoom ref) ensures correct depth ordering
        // even within a single batched draw call.
        // 延迟提交——网格先累积，统一在 onDrawTileEnd 中一次性提交，
        // 将每帧 WebGL 绘制调用从 3-4 次降为 1 次。
        // 模板测试（每个 mesh 的 zoom ref）保证即使在单次批量绘制中
        // 也能维持正确的深度顺序。
    }

    _drawChildTiles(childTiles, parentContext) {
        super._drawChildTiles(childTiles, parentContext);
        // 只做瓦片内容绘制，mesh 累积统一推迟到 onDrawTileEnd 批量提交。
        // Only paints child tile contents; mesh accumulation submission is deferred to onDrawTileEnd in one batched call.
    }

    _drawParentTiles(parentTiles, parentContext) {
        super._drawParentTiles(parentTiles, parentContext);
        // 同上，父瓦片 mesh 不单独提交，与 current/child 合并后批量绘制。
        // Same as child tiles — parent meshes aren't submitted alone; all three tile sets get batched together.
    }

    onDrawTileEnd(_, parentContext: RenderContext) {
        // Single batched draw call: all current + child + parent tile meshes
        // are accumulated in _tileMeshes and submitted together.
        // 单次批量绘制调用：current + child + parent 瓦片的所有网格
        // 先累积到 _tileMeshes 中，再统一提交。
        this._submitMeshes(parentContext);
    }

    _submitMeshes(parentContext) {
        const uniformValues = this._getUniformValues();
        let fbo;
        if (parentContext && parentContext.renderTarget) {
            fbo = parentContext.renderTarget.fbo;
        }
        this._tileScene.setMeshes(this._tileMeshes);
        this._renderer.render(this._shader, uniformValues, this._tileScene, fbo);
        this._tileMeshes.length = 0;
    }

    _getUniformValues() {
        const map = this.getMap();
        return {
            'projViewMatrix': map.projViewMatrix
        };
    }

    consumeTile(tileImage: Tile['image'], tileInfo: Tile['info']) {
        let mesh: reshader.Mesh = (tileImage as any).mesh;
        const needUpdates = testNeedUpdateAltitude(this.layer, tileInfo);
        if (!mesh) {
            mesh = this._createTileMesh(tileInfo, tileImage);
            (tileImage as any).mesh = mesh;
        }
        const map = this.getMap();
        if (needUpdates && map) {
            updateImageMeshLocalTransform(mesh, tileInfo.extent2d, tileInfo.offset, tileInfo.res / map.getGLRes(), tileInfo);
        }
        return super.consumeTile(tileImage, tileInfo);
    }

    drawTile(tileInfo: Tile['info'], tileImage: Tile['image'], parentContext: RenderContext): void {
        if (parentContext && parentContext.sceneFilter) {
            if (!parentContext.sceneFilter(MESH_TO_TEST)) {
                return;
            }
        }
        const map = this.getMap();
        if (!tileInfo || !map || !tileImage) {
            return;
        }
         const needUpdates = testNeedUpdateAltitude(this.layer, tileInfo);
        let mesh: reshader.Mesh = (tileImage as any).mesh;
        if (!mesh) {
            mesh = this._createTileMesh(tileInfo, tileImage);
            (tileImage as any).mesh = mesh;
        }
        if (needUpdates && map) {
            updateImageMeshLocalTransform(mesh, tileInfo.extent2d, tileInfo.offset, tileInfo.res / map.getGLRes(), tileInfo);
        }

        const defines = mesh.getDefines();
        if (this.layer.options['debug']) {
            let debugTexture = mesh.material.get('debugTexture');
            if (!debugTexture) {
                debugTexture = this._createDebugTexture(tileInfo, tileImage.width, tileImage.height);
                mesh.material.set('debugTexture', debugTexture);
                (tileImage as any).debugTexture = debugTexture;
            }
            if (!defines['HAS_DEBUG']) {
                mesh.setDefines({
                    'HAS_DEBUG': 1
                });
            }
        } else if (defines['HAS_DEBUG']) {
            mesh.setDefines({});
        }

        // 传入缩放/惯性态标志，让 imageMesh 的过滤器选择在视图变化期间保持稳定，
        // 避免 LINEAR ↔ NEAREST 逐帧切换造成的瓦片边缘闪烁。
        // Forward the zooming/settling flag so imageMesh's filter selection stays stable while the view is in motion.
        updateFilter(mesh, map, tileInfo.res, (this as any)._isZoomingOrSettling);

        let opacity = this.getTileOpacity(tileImage, tileInfo);
        let layerOpacity = this.layer.options['opacity'];
        if (isNil(layerOpacity)) {
            layerOpacity = 1;
        }
        opacity *= layerOpacity;

        // Cache opacity per-mesh: only call material.set() when value actually changes.
        // Avoids triggering uniform dirty flags and recomputation every frame.
        // 逐网格缓存透明度：仅当值真正变化时才调用 material.set()，
        // 避免每帧都触发 uniform 脏标记和重复计算。
        const props = mesh.properties;
        if (props._lastOpacity !== opacity) {
            props._lastOpacity = opacity;
            mesh.material.set('opacity', opacity);
        }
        // 同样缓存 isCurrentTiles uniform，避免每帧都走一次 uniform 脏标记刷新路径。
        // Same caching pattern for isCurrentTiles uniform — skips the uniform dirty-flag refresh on unchanged frames.
        const isCurrent = +!!this.drawingCurrentTiles;
        if (props._lastIsCurrentTiles !== isCurrent) {
            props._lastIsCurrentTiles = isCurrent;
            mesh.setUniform('isCurrentTiles', isCurrent);
        }
        this._tileMeshes.push(mesh);
        if ((this as any).getTileFadingOpacity(tileImage) < 1) {
            this.setToRedraw();
        }
    }

    _createDebugTexture(tileInfo: Tile['info'], width, height) {
        const debugInfo = this.getDebugInfo(tileInfo.id);
        const dpr = this.getMap().getDevicePixelRatio() > 1 ? 2 : 1;
        // reuse debug canvas to avoid per-frame canvas allocation.
        // Previously a new canvas was created every frame, leaking 256KB+ per debug tile.
        // 复用 debug canvas，避免每帧新建 canvas。
        // 之前每帧都会创建一个新 canvas，每个 debug 瓦片泄漏 256KB+ 内存。
        let canvas = this._debugInfoCanvas;
        if (!canvas || canvas.width !== width * dpr || canvas.height !== height * dpr) {
            canvas = this._debugInfoCanvas = document.createElement('canvas');
            canvas.width = width * dpr;
            canvas.height = height * dpr;
        }
        const ctx = canvas.getContext('2d');
        // 复用 canvas 前必须清空，否则上一帧 debug 文字/边框会残留在新帧。
        // Mandatory clear before reusing the canvas; otherwise the previous frame's debug text and border bleed through.
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.font = '20px monospace';
        ctx.scale(dpr, dpr);
        const color = this.layer.options['debugOutline'];
        ctx.fillStyle = color;
        ctx.strokeStyle = color;
        ctx.lineWidth = 3;
        ctx.fillText(debugInfo, 20, height - 12);
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(width, 0);
        ctx.lineTo(width, height);
        ctx.lineTo(0, height);
        ctx.lineTo(0, 0);
        ctx.stroke();
        const config = {
            data: canvas,
            width: canvas.width,
            height: canvas.height
        };
        let texture = this.getTexture();
        if (!texture) {
            texture = new reshader.Texture2D(config);
        } else {
            texture.setConfig(config);
        }
        const { device, regl } = (this.context as any);
        texture.getREGLTexture(device || regl);
        return texture;
    }

    _createTileMesh(tileInfo: Tile['info'], tileImage: Tile['image']): any {
        const map = this.getMap();

        const scale = tileInfo.res / map.getGLRes();
        const uniforms = {
            zoom: tileInfo.z,
        };
        const mesh = createImageMesh.call(this, this._tileGeometry, tileImage, tileInfo.extent2d, tileInfo.offset, scale, uniforms, tileInfo);
        const texture = mesh.material.get('baseColorTexture') as reshader.Texture2D;
        (tileImage as any).texture = texture;
        return mesh;
    }

    loadTileImage(tileImage: HTMLImageElement, url: string) {
        // image must set cors in webgl
        const crossOrigin = this.layer.options['crossOrigin'];
        tileImage.crossOrigin = crossOrigin !== null ? crossOrigin : '';
        tileImage.src = url;
        return;
    }

    deleteTile(tile: Tile) {
        if (!tile || !tile.image) {
            return super.deleteTile(tile);
        }
        const image = tile.image as any;
        if (image.texture) {
            // Prevent pooled textures from retaining the closed tile ImageBitmap reference.
            // The GPU data is uploaded; clearing CPU-side image refs saves JS heap.
            // 防止纹理池中的纹理保留已关闭的瓦片 ImageBitmap 引用。
            // GPU 数据已上传完毕，清除 CPU 侧的图像引用可节省 JS 堆内存。
            const cfg = image.texture.config;
            if (cfg) {
                if (cfg.data && (cfg.data as any).close) {
                    cfg.data = null;
                }
                cfg.image = null;
            }
            this.saveTexture(image.texture as any);
        }
        if (image.debugTexture) {
            const cfg = image.debugTexture.config;
            if (cfg) {
                if (cfg.data && (cfg.data as any).close) {
                    cfg.data = null;
                }
                cfg.image = null;
            }
            this.saveTexture(image.debugTexture as any);
        }
        delete image.texture;
        delete image.debugTexture;
        const mesh = image.mesh;
        if (mesh) {
            // 因为meterial中的texture是在TexturePoolable中集中管理的，不能在material.dispose中销毁
            mesh.material.set('baseColorTexture', null, false);
            mesh.material.set('debugTexture', null, false);
            mesh.material.dispose();
            mesh.dispose();
            delete image.mesh;
        }
        return super.deleteTile(tile);
    }

    onRemove(): void {
        if (this._tileGeometry) {
            this._shader.dispose();
            this._tileGeometry.dispose();
            delete this._shader;
            delete this._tileGeometry;
            delete this._renderer;
            delete this._tileScene;
            delete this._tileMeshes;
        }
        this.disposeTexturePool();
        super.onRemove();
    }

    _getCommandProps() {
        const canvas = this.getMap().getRenderer().canvas;
        const viewport = {
            x: 0,
            y: 0,
            width: () => {
                return canvas ? canvas.width : 1;
            },
            height: () => {
                return canvas ? canvas.height : 1;
            }
        };
        const offsetFactor = {
            units: 0,
            factor: 0
        };
        return {
            stencil: {
                enable: true,
                func: {
                    cmp: '<=',
                    ref: (_, props) => {
                        const ref = Math.abs(this.getCurrentTileZoom() - props.zoom);
                        return ref;
                    }
                },
                op: {
                    fail: 'keep',
                    zfail: 'keep',
                    zpass: 'replace'
                }
            },
            depth: {
                enable: true,
                func: '<=',
                mask: () => {
                    return !!this.layer.options['depthMask'];
                }
            },
            blend: {
                enable: true,
                func: {
                    src: 1,
                    dst: 'one minus src alpha'
                },
                equation: 'add'
            },
            viewport,
            polygonOffset: {
                enable: true,
                offset: (_, props) => {
                    let polygonOffset = this.layer.getPolygonOffset();
                    polygonOffset = props.isCurrentTiles ? polygonOffset : polygonOffset + 1;
                    offsetFactor.factor = polygonOffset;
                    offsetFactor.units = polygonOffset;
                    return offsetFactor;
                }
            }
        }
    }

    renderTerrainSkin(regl, terrainLayer, skinImages) {
        const tileSize = this.layer.getTileSize().width;
        const debug = terrainLayer.options['debug'];
        for (let i = 0; i < skinImages.length; i++) {
            const { tile, texture } = skinImages[i];
            if (!tile.image) {
                continue;
            }
            // 优化：重用已有的 canvas，避免每帧创建新对象导致 GC 压力
            let canvas = skinImages[i].canvas;
            if (!canvas || canvas.width !== tileSize || canvas.height !== tileSize) {
                canvas = document.createElement('canvas');
                canvas.width = tileSize;
                canvas.height = tileSize;
                skinImages[i].canvas = canvas;
            }
            const ctx = canvas.getContext('2d');
            // 复用皮肤 canvas 前清空，防止旧瓦片图像与新瓦片叠加出脏像素。
            // Clear the reused skin canvas before drawing so pixels from the previous tile don't composite with the new one.
            ctx.clearRect(0, 0, tileSize, tileSize);
            ctx.drawImage(tile.image, 0, 0);
            if (debug) {
                const { x, y, z } = tile.info;
                drawDebug(ctx, `${x}/${y}/${z}`, 'yellow', 1, 0, 0, tileSize, tileSize, -18);
            }
            const config = {
                data: canvas,
                width: tileSize,
                height: tileSize,
                flipY: true,
                // 皮肤合成使用 src: one 的预乘混合，纹理数据必须显式预乘 alpha，
                // 否则注记等透明图层的透明像素/抗锯齿边缘会被整值叠加，产生亮度不一致。
                // Premultiply alpha explicitly required because skin composite uses src=ONE blending;
                // without it transparent pixels / anti-aliased edges on labels get additively doubled
                // and brightness varies across frames.
                premultiplyAlpha: true,
                min: 'linear mipmap linear',
                mag: 'linear'
            };
            if (texture.update) {
                //webgpu
                texture.update(config);
            } else {
                //webgl
                texture(config);
            }

        }
    }

    createTerrainTexture(regl) {
        const tileSize = this.layer.getTileSize().width;
        const config = {
            width: tileSize,
            height: tileSize,
            flipY: true,
            min: 'linear mipmap linear',
            mag: 'linear',
            depthStencil: false,
            depth: false,
            stencil: false
        };
        return regl.texture(config);
    }

    deleteTerrainTexture(texture) {
        texture.destroy();
    }

    clear() {
        this.clearTileCaches();
        super.clear();
    }
}

maptalks.TileLayer.registerRenderer<typeof TileLayerGLRenderer2>('gl', TileLayerGLRenderer2);
maptalks.TileLayer.registerRenderer<typeof TileLayerGLRenderer2>('gpu', TileLayerGLRenderer2);

export default TileLayerGLRenderer2;


function drawDebug(ctx, debugInfo, color, lineWidth, left, top, width, height, textOffsetY = 0) {
    ctx.font = '20px monospace';
    ctx.fillStyle = color;
    DEBUG_POINT.y = height - 30;
    ctx.globalAlpha = 1;
    ctx.fillText(debugInfo, DEBUG_POINT.x + left, DEBUG_POINT.y + top + textOffsetY);
    ctx.globalAlpha = 0.6;
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.beginPath();
    ctx.moveTo(left, top);
    ctx.lineTo(left + width, top);
    ctx.lineTo(left + width, top + height);
    ctx.lineTo(left, top + height);
    ctx.lineTo(left, top);
    ctx.stroke();
    ctx.globalAlpha = 1;
}
