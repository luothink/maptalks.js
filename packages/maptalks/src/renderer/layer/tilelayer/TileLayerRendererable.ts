/* eslint-disable @typescript-eslint/no-unused-vars */
import {
    isNil,
    loadImage,
    emptyImageUrl,
    now,
    isFunction,
    getImageBitMap,
    isString,
    getAbsoluteURL,
    pushIn,
    mergeArray,
    isNumber
} from '../../../core/util';
import Browser from '../../../core/Browser';
import { default as TileLayer } from '../../../layer/tile/TileLayer';
import WMSTileLayer from '../../../layer/tile/WMSTileLayer';
import Point from '../../../geo/Point';
import Extent from '../../../geo/Extent';
import LRUCache from '../../../core/util/LRUCache';
import Canvas from '../../../core/Canvas';
import Actor from '../../../core/worker/Actor';
import { imageFetchWorkerKey } from '../../../core/worker/CoreWorkers';
import { TileImageBuffer, TileImageTexture } from '../../types';
import type { WithUndef } from '../../../types/typings';
import { MixinConstructor } from '../../../core/Mixin';
import GlobalConfig from '../../../GlobalConfig';


const TEMP_POINT1 = new Point(0, 0);
const TEMP_POINT2 = new Point(0, 0);

const EMPTY_ARRAY = [];

// P0 修复：VT 缩小场景"旧要素暂留"。目标 zoom 与旧瓦片 z 的差距达到该阈值时，
// 目标层级大概率无同源数据（如服务 z<=14 无数据），旧瓦片放大作背景只会造成
// "简化图形/旧要素暂留"，且不存在"出图后消失"风险。此时不保留、不注入旧瓦片背景，
// 将暂留时间压到接近 0ms。
const VT_STALE_ZOOM_GAP_MAX = 2;

class TileWorkerConnection extends Actor {
    constructor() {
        super(imageFetchWorkerKey);
    }

    checkUrl(url: string) {
        if (!url || !isString(url)) {
            return url;
        }
        //The URL is processed. Here, only the relative protocol is processed
        return getAbsoluteURL(url);

    }

    // eslint-disable-next-line @typescript-eslint/ban-types
    fetchImage(url: string, workerId: number, cb: Function, fetchOptions: any) {
        url = this.checkUrl(url);
        const data = {
            url,
            fetchOptions
        };
        this.send(data, EMPTY_ARRAY, cb, workerId);
    }
}

/**
 * 瓦片图层的渲染器抽象类，实现瓦片的遍历功能，可以继承并实现 drawTile 等方法来实现瓦片图层渲染
 *
 * @english
 * Abstract renderer class for TileLayers in maptalks-gl
 * @class
 * @protected
 * @group renderer
 * @extends {renderer.LayerAbstractRenderer}
 */
const TileLayerRenderable = function <T extends MixinConstructor>(Base: T) {
    const renderable = class extends Base {
        [x: string]: any;
        tilesInView: TilesInViewType;
        tilesLoading: { [key: string]: any };
        //@internal
        _parentTiles: any[];
        //@internal
        _childTiles: any[];
        //@internal
        _tileZoom: number;
        //@internal
        _tileQueue: {
            tileInfo: any;
            tileData: any;
        }[];
        //@internal
        _tileQueueIds: Set<LayerId>;
        tileCache: LRUCache;
        //@internal
        _compareTiles: any;
        //@internal
        _tileImageWorkerConn: TileWorkerConnection;
        //@internal
        _renderTimestamp: number;
        //@internal
        _frameTiles: {
            empty: boolean;
            timestamp: number;
        };

        //@internal
        _terrainHelper: TerrainHelper;
        //@internal
        _tilePlaceHolder: any;
        //@internal
        _frameTileGrids: TileGrids;

        drawingCurrentTiles: WithUndef<boolean>;
        drawingChildTiles: WithUndef<boolean>;
        drawingParentTiles: WithUndef<boolean>;
        _backgroundSettleStart: number;
        _backgroundSettleUntil: number;
        _backgroundTileOpacity: number;
        _zoomSnapshotDominantZoom: number;
        avgMinAltitude: number;
        avgMaxAltitude: number;

        init() {
            this.version = 0;
            this.tilesInView = {};
            this.tilesLoading = {};
            this._parentTiles = [];
            this._childTiles = [];
            this._tileQueue = [];
            this._tileQueueIds = new Set();
            const tileSize = this.layer.getTileSize().width;
            // P0: Tile-size-proportional cache scaling can produce dangerously small
            // caches for small tiles (e.g. 256px tiles → 64 slots at default maxCache=256).
            // At high zoom (15+), the viewport alone can require 50-80 tiles, and with
            // preload margins and parent/child tiles the working set needs 120-200+ slots.
            // A floor of 128 prevents count-based eviction thrashing for small tiles,
            // while memory-budget eviction (maxTileCacheMemoryMB) still caps actual memory.
            // P0：按瓦片尺寸比例缩放缓存可能产生危险的小缓存
            // （如 256px 瓦片在默认 maxCache=256 下只有 64 个槽位）。
            // 高 zoom（15+）时仅视口就可能需要 50-80 个瓦片，加上预加载
            // 边距和父/子瓦片，工作集需要 120-200+ 个槽位。
            // 下限 128 防止小瓦片出现基于数量的驱逐抖动，
            // 同时内存预算驱逐（maxTileCacheMemoryMB）仍会封顶实际内存。
            const cacheSize = Math.max(128, this.layer.options['maxCacheSize'] * tileSize / 512 * tileSize / 512);
            this.tileCache = new LRUCache(cacheSize, (tile: Tile) => {
                this.deleteTile(tile);
            });
            // Memory-budget-based eviction: evict tiles when they exceed
            // a configurable memory limit (default 96MB), not just when count exceeds cacheSize.
            // This prevents unbounded memory growth from high-DPI or large tiles.
            // 基于内存预算的驱逐：当瓦片超过可配置的内存上限
            // （默认 96MB）时进行驱逐，而不仅仅在数量超过 cacheSize 时。
            // 防止高 DPI 或大尺寸瓦片导致的内存无限增长。
            if (GlobalConfig.memoryBudgetEviction && GlobalConfig.maxTileCacheMemoryMB > 0) {
                this.tileCache.setMaxMemory(GlobalConfig.maxTileCacheMemoryMB * 1024 * 1024);
            }
            this._tileCacheBaseMax = this.tileCache.max;
            if (Browser.decodeImageInWorker && this.layer.options['decodeImageInWorker'] && (this.layer.options['renderer'] === 'gl' || !Browser.safari && !Browser.iosWeixin)) {
                this._tileImageWorkerConn = new TileWorkerConnection();
            }
            this._compareTiles = compareTiles.bind(this);
        }


        getCurrentTileZoom(): number {
            return this._tileZoom;
        }

        onZoomStart(param: any): void {
            this._updateZoomTransitionDirection(param);
        }

        onZooming(param: any): void {
            this._updateZoomTransitionDirection(param);
        }

        onZoomEnd(param: any): void {
            delete this._zoomTransitionDirection;
            // Release zoom snapshot resources when zooming ends
            // These are only needed during zoom transitions for background rendering
            // 缩放结束时释放 zoom 快照资源。
            // 这些资源仅在缩放过渡期间用于背景渲染。
            this._clearZoomSnapshots();
            // P0: Vector tile grace period. After zoom ends, new-zoom tiles may still
            // be loading, but retireTiles' preserveStaleInViewOnVectorZooming guard
            // becomes false immediately. Without a grace period, the old tiles in
            // tilesInView are deleted on the next retireTiles call, causing the layer
            // to go completely blank ("出图后消失"). Keep them alive for 500ms after
            // zoom ends so the transition is seamless.
            // P0：矢量瓦片宽限期。缩放结束后，新 zoom 瓦片可能仍在加载，
            // 但 retireTiles 的 preserveStaleInViewOnVectorZooming 守卫会立即变 false。
            // 若无宽限期，tilesInView 中的旧瓦片会在下一次 retireTiles 调用时被删除，
            // 导致图层完全空白（"出图后消失"）。缩放结束后保留 500ms，
            // 使过渡无缝衔接。
            if ((this.layer as any).isVectorTileLayer) {
                this._vtZoomEndGraceUntil = now() + 300;
                this._vtZoomEndGraceStart = now();
            }
            this.setToRedraw();
        }

        _clearZoomSnapshots() {
            if (this._zoomSnapshotTiles && this._zoomSnapshotTiles.length) {
                this._zoomSnapshotTiles.length = 0;
            }
            if (this._stableZoomFrameTiles && this._stableZoomFrameTiles.length) {
                this._stableZoomFrameTiles.length = 0;
            }
        }

        draw(timestamp: number, context): number {
            const map = this.getMap();
            if ((this as any).isDrawable && !(this as any).isDrawable()) {
                return;
            }
            const mask2DExtent = this.prepareCanvas();
            if (mask2DExtent) {
                const layer = this.layer || {};
                const layerParent = layer.parent || {};
                if (layerParent.isMap && !mask2DExtent.intersects(this.canvasExtent2D)) {
                    this.completeRender();
                    return;
                }
            }

            if (this._renderTimestamp !== timestamp) {
                // maptalks/issues#10
                // 如果consumeTileQueue方法在每个renderMode都会调用，但多边形只在fxaa mode下才会绘制。
                // 导致可能出现consumeTileQueue在fxaa阶段后调用，之后的阶段就不再绘制。
                // 改为consumeTileQueue只在finalRender时调用即解决问题
                this._consumeTileQueue();
                this._computeAvgTileAltitude();
                this._renderTimestamp = timestamp;
            }


            let currentTiles;
            let hasFreshTiles = false;
            const frameTiles = this._frameTiles;
            if (frameTiles && timestamp === frameTiles.timestamp) {
                if (frameTiles.empty) {
                    return;
                }
                currentTiles = frameTiles;
            } else {
                // Recomputes the tile cover on every frame during any camera
                // change. The previous interactionTileCache skipped getTiles() when the
                // view center moved less than the tolerance, reusing the old tile grid
                // and its tileQueue. That left newly exposed areas blank during slow
                // drags and cursor-centered wheel zooms because the tiles covering those
                // regions were never requested. Performance is maintained through Tile
                // object idempotency (same key = same tile, no duplicate loads) rather
                // than skipping cover computation.
                // 在相机发生任何变化的每一帧都重新计算瓦片覆盖。
                // 之前的 interactionTileCache 在视图中心移动小于容差时跳过 getTiles()，
                // 复用旧的瓦片网格及其 tileQueue。这导致慢速拖拽和以光标为中心的
                // 滚轮缩放期间，新暴露的区域出现空白——因为这些区域的瓦片从未被请求。
                // 性能通过 Tile 对象的幂等性保证（相同 key = 相同瓦片，不会重复加载），
                // 而非跳过覆盖计算。
                if (!currentTiles) {
                    currentTiles = this._getTilesInCurrentFrame();
                    if (!currentTiles) {
                        this._frameTiles = { empty: true, timestamp };
                        this.completeRender();
                        return;
                    }
                    hasFreshTiles = true;
                    this._frameTiles = currentTiles;
                    this._frameTiles.timestamp = timestamp;
                    if (currentTiles.loadingCount) {
                        this.loadTileQueue(currentTiles.tileQueue);
                    }
                }
            }
            const { tiles, childTiles, parentTiles, placeholders, loading, loadingCount, missedTiles, incompleteTiles, panCoverageRisk } = currentTiles;

            this._drawTiles(tiles, parentTiles, childTiles, placeholders, context, missedTiles, incompleteTiles, panCoverageRisk);
            if (!loadingCount) {
                if (!loading) {
                    const holdBackgroundOnSettle = !!(
                        this._backgroundSettleUntil &&
                        this._backgroundSettleUntil > now() &&
                        (this._parentTiles.length || this._childTiles.length)
                    );
                    if (holdBackgroundOnSettle) {
                        // settling blend 的尾段里，继续保留旧层一两个短帧，
                        // 避免 current 已 ready 但背景刚好被清掉时出现细碎闪动。
                        this.setToRedraw();
                        return;
                    }
                    //redraw to remove parent tiles if any left in last paint
                    if (!map.isAnimating() && (this._parentTiles.length || this._childTiles.length)) {
                        this._parentTiles = [];
                        this._childTiles = [];
                        delete this._backgroundSettleStart;
                        delete this._backgroundSettleUntil;
                        this.setToRedraw();
                    }
                    this.completeRender();
                }
            }
            if (hasFreshTiles) {
                this.retireTiles();
            }
        }

        getTileGridsInCurrentFrame(): TileGrids {
            return this._frameTileGrids;
        }

        getCurrentTimestamp(): number {
            return this._renderTimestamp || 0;
        }

        //@internal
        _getTilesInCurrentFrame() {
            const map = this.getMap();
            this.map = map;
            const layer = this.layer;
            /**
             * record spatial reference of current frame to avoid A large number of function(getSpatialReference) calls
             * 瓦片计算里会用到大量的 getSpatialReference 调用，这里记录当前帧的空间参考，避免重复调用
             * 其他的大量的重复函数调用,也可以采用类似的策略来提高性能
             */
            layer._spatialRef = layer.getSpatialReference();
            const terrainTileMode = layer._isPyramidMode() && layer.options['terrainTileMode'];
            const panCoverageRisk = false;
            let tileGrids = layer.getTiles();
            this._frameTileGrids = tileGrids;
            tileGrids = tileGrids.tileGrids;
            if (!tileGrids || !tileGrids.length) {
                layer._spatialRef = null;
                this.map = null;
                return null;
            }
            const count = tileGrids.reduce((acc, curr) => acc + (curr && curr.tiles && curr.tiles.length || 0), 0);
            const nowTs = now();
            const baseMax = this._tileCacheBaseMax || this.tileCache.max;
            if (map && map.isInteracting && map.isInteracting()) {
                this._dynamicCacheLastInteracting = nowTs;
            } else if (this.layer.options['dynamicCache'] !== false && this.tileCache.max > baseMax) {
                const lastInteracting = this._dynamicCacheLastInteracting || 0;
                const lastExpand = this._dynamicCacheLastExpand || 0;
                const idleTime = nowTs - Math.max(lastInteracting, lastExpand);
                if (idleTime > 5000) {
                    this.tileCache.setMaxSize(baseMax);
                }
            }
            if (this.layer.options['dynamicCache'] !== false && count >= (this.tileCache.max / 2)) {
                // 动态缓存：根据缩放级别自适应扩容上限。
                // 低缩放级别（0-11）：容量需求小，1.5x 够用。
                // 中缩放级别（12-14）：视口瓦片数开始指数增长，2.0x 缓冲。
                // 高缩放级别（15+）：视口需要 50-120 个瓦片，2.5x 避免频繁驱逐。
                // 扩容后静置 5s 会回落到 baseMax，不会长期推高峰值。
                const currentZoom = map && map.getZoom && map.getZoom() || 0;
                const capMultiplier = currentZoom >= 15 ? 2.5 : (currentZoom >= 12 ? 2.0 : 1.5);
                const maxCap = Math.max(baseMax, Math.ceil(baseMax * capMultiplier));
                const headroom = Math.max(8, Math.ceil(baseMax / 4));
                const expectedMax = Math.min(count + headroom, maxCap);
                if (expectedMax > this.tileCache.max) {
                    this.tileCache.setMaxSize(expectedMax);
                    this._dynamicCacheLastExpand = nowTs;
                }
            }
            let loadingCount = 0;
            let loading = false;
            const checkedTiles = {};
            const tiles = [],
                parentTiles = [], parentKeys = {},
                childTiles = [], childKeys = {},
                placeholders = [], placeholderKeys = {};
            //visit all the tiles
            const tileQueue = {};
            // Missing tile candidates collected per frame, then sorted by viewport
            // priority before the loadingLimit budget is consumed.
            // 缺失瓦片候选按帧收集，在消耗 loadingLimit 预算之前
            // 按视口优先级排序。
            const missingCandidates: { tile: any, isParentTile: boolean, distance: number }[] = [];
            const preLoadingCount = this.markTiles();
            const loadingLimit = this._getLoadLimit();

            const l = tileGrids.length;
            // !this._terrainHelper can't be deleted as parent tiles are part of terrain skin, maptalks/issues#608
            const isFirstRender = this._tileZoom === undefined && layer.options['currentTilesFirst'] && !this._terrainHelper;
            // main tile grid is the last one (draws on top)
            this._tileZoom = tileGrids[0]['zoom'];

            // let dirtyParentTiles = null;
            let missingTiles = null;
            let incompleteTiles = null;
            if (terrainTileMode) {
                // dirtyParentTiles = new Set();
                missingTiles = [];
                incompleteTiles = new Map();
            }

            for (let i = 0; i < l; i++) {
                const tileGrid = tileGrids[i];
                const gridTiles = tileGrid['tiles'];
                const parents = tileGrid['parents'] || EMPTY_ARRAY;
                // Always prioritize current-level tiles over parent fallback tiles.
                // Loads center viewport tiles first; parent tiles are only used
                // when already available or after current tiles have been requested.
                // Previously parents were loaded first during pan, which saturated the
                // loadingLimit budget with low-resolution fallback tiles and left the
                // actual viewport tiles blank (white screen).
                // 始终优先加载当前层级的瓦片，而非父级回退瓦片。
                // 先加载视口中心瓦片；父级瓦片仅在已可用或
                // 当前瓦片已请求之后才使用。
                // 此前平移时优先加载父级瓦片，导致低分辨率回退瓦片
                // 占满 loadingLimit 预算，实际视口瓦片反而空白（白屏）。
                const allTiles = isFirstRender ? gridTiles : mergeArray(gridTiles, parents);

                let placeholder;
                if (allTiles.length) {
                    placeholder = this._generatePlaceHolder(allTiles[0].res);
                }

                for (let j = 0, l = allTiles.length; j < l; j++) {
                    const tile = allTiles[j];
                    layer._debugTile(tile, '_getTilesInCurrentFrame');
                    const tileId = tile.id;
                    const isParentTile = !isFirstRender && j >= gridTiles.length;
                    //load tile in cache at first if it has.
                    let tileLoading = false;
                    const tilesCount = tiles.length;
                    if (this._isLoadingTile(tileId)) {
                        tileLoading = loading = true;
                        this.markCurrent(this.tilesLoading[tileId], true);
                    } else {
                        const cached = this.getCachedTile(tile, isParentTile);
                        if (cached) {
                            if (!isParentTile) {
                                if (cached.image && this.isTileFadingIn(cached.image)) {
                                    tileLoading = loading = true;
                                    this.setToRedraw();
                                }

                                if (this.isTileComplete(cached)) {
                                    tiles.push(cached);
                                } else {
                                    tileLoading = true;
                                    if (terrainTileMode) {
                                        incompleteTiles.set(tileId, cached);
                                    }
                                }
                            } else if (this.isTileComplete(cached)) {
                                // Render cached parent tiles as background during zoom
                                // Without this, during zoom there's nothing to show where new tiles haven't loaded yet
                                // 缩放期间将缓存的父级瓦片渲染为背景。
                                // 否则缩放时，新瓦片尚未加载的区域将无内容可显示。
                                parentKeys[tileId] = parentTiles.length;
                                parentTiles.push(cached);
                            }
                        } else {
                            tileLoading = loading = true;
                            // Defer queue insertion until after all tiles have been
                            // visited. This lets us sort missing tiles by viewport
                            // priority (current before parent, center before edge)
                            // before the loadingLimit budget is consumed.
                            // 推迟入队，直到所有瓦片访问完毕。
                            // 这样可以在消耗 loadingLimit 预算之前，按视口优先级
                            // （当前层优先于父级、中心优先于边缘）对缺失瓦片排序。
                            if (!this._tileQueueIds.has(tile.id)) {
                                missingCandidates.push({
                                    tile,
                                    isParentTile,
                                    distance: this._getTileDistanceToViewportCenter(tile, tileGrid)
                                });
                            }
                        }
                    }

                    if (terrainTileMode && !isParentTile) {
                        if (tiles.length === tilesCount) {
                            missingTiles.push(tile);
                        } else {
                            checkedTiles[tile.id] = 1;
                            // if (tile.parent) {
                            //     dirtyParentTiles.add(tile.parent);
                            // }
                        }
                    }

                    if (terrainTileMode) continue;
                    if (isParentTile) continue;
                    if (!tileLoading) continue;
                    if (checkedTiles[tileId]) continue;

                    checkedTiles[tileId] = 1;
                    if (placeholder && !placeholderKeys[tileId]) {
                        //tell gl renderer not to bind gl buffer with image
                        tile.cache = false;
                        placeholders.push({
                            image: placeholder,
                            info: tile
                        });

                        placeholderKeys[tileId] = 1;
                    }

                    const children = this._findChildTiles(tile);
                    if (children.length) {
                        children.forEach(c => {
                            if (!childKeys[c.info.id]) {
                                childTiles.push(c);
                                childKeys[c.info.id] = 1;
                            }
                        });
                    }
                    // (children.length !== 4) means it's not complete, we still need a parent tile
                    if (!children.length || children.length !== 4) {
                        const parentTile = this._findParentTile(tile);
                        if (parentTile) {
                            const parentId = parentTile.info.id;
                            if (parentKeys[parentId] === undefined) {
                                parentKeys[parentId] = parentTiles.length;
                                parentTiles.push(parentTile);
                            }/* else {
                                //replace with parentTile of above tiles
                                parentTiles[parentKeys[parentId]] = parentTile;
                            } */
                        }
                    }
                }
            }

            // Sort missing tile candidates so viewport-center current tiles load
            // before edge tiles and parent fallback tiles. This is the key change
            // that eliminates white-screen flashes during panning.
            // During zoom-out: the viewport EXPANDS, revealing new areas at the edges.
            // Edge tiles are the most visible new gaps — prioritize them first by
            // sorting in descending distance order (edge-first).
            // During normal zoom/idle: center tiles remain most visible (center-first).
            // 对缺失瓦片候选排序，使视口中心的当前层瓦片先于
            // 边缘瓦片和父级回退瓦片加载。这是消除平移期间
            // 白屏闪烁的关键改动。
            // 缩小时：视口扩张，边缘暴露出新区域。边缘瓦片是最显眼的新空隙——
            // 按距离降序排序（边缘优先）。
            // 正常缩放/空闲时：中心瓦片最显眼（中心优先）。
            if (missingCandidates.length) {
                // P0: During zoom-out, the viewport EXPANDS and the new edge tiles
                // are the most visible gaps. All layer types (raster + vector) must
                // use edge-first sort during zoom-out so the newly exposed margins
                // fill first. Previously vector tiles used center-first even during
                // zoom-out, causing blank edges at high zoom levels.
                // P0：缩小时视口扩张，新的边缘瓦片是最显眼的空隙。
                // 所有图层类型（栅格 + 矢量）在缩小时都必须使用边缘优先排序，
                // 让新暴露的边缘先被填充。此前矢量瓦片即使在缩小时也用中心优先，
                // 导致高 zoom 级别出现空白边缘。
                const isZoomOut = map && map.isZooming && map.isZooming() &&
                    this._zoomTransitionDirection === -1;
                missingCandidates.sort((a, b) => {
                    // current tiles always win over parent fallback tiles
                    // 当前层瓦片始终优先于父级回退瓦片
                    if (a.isParentTile !== b.isParentTile) {
                        return a.isParentTile ? 1 : -1;
                    }
                    // During zoom-out, load edge tiles first (descending distance)
                    // to fill the newly exposed viewport margins.
                    // 缩小时先加载边缘瓦片（距离降序），填充新暴露的视口边缘。
                    return isZoomOut ? (b.distance - a.distance) : (a.distance - b.distance);
                });
                const maxNew = loadingLimit > 0 ? Math.max(0, loadingLimit - preLoadingCount[0]) : missingCandidates.length;
                for (let i = 0; i < missingCandidates.length && (loadingLimit <= 0 || loadingCount < maxNew); i++) {
                    const { tile } = missingCandidates[i];
                    if (!this._tileQueueIds.has(tile.id)) {
                        tileQueue[tile.id] = tile;
                        loadingCount++;
                    }
                }
            }

            // 遍历 missingTiles ，
            const missedTiles = [];
            if (terrainTileMode) {
                for (let i = 0; i < missingTiles.length; i++) {
                    const tile = missingTiles[i].info ? missingTiles[i].info : missingTiles[i];
                    if (!tile.parent || checkedTiles[tile.id]) {
                        continue;
                    }

                    const { tiles: children, missedTiles: childMissedTiles } = this._findChildTiles(tile);
                    if (children.length) {
                        pushIn(tiles, children);
                        pushIn(missedTiles, childMissedTiles);
                        continue;
                    } else if (incompleteTiles.has(tile.id)) {
                        tiles.push(incompleteTiles.get(tile.id));
                        incompleteTiles.delete(tile.id);
                        continue;
                    }

                    checkedTiles[tile.id] = 1;
                    missedTiles.push(tile);
                    // continue;

                    // // 以下是瓦片合并的优化，但一方面优化效果并不明显，且让渲染逻辑变得复杂，故暂时放弃
                    // if (dirtyParentTiles.has(tile.parent) || tile.z < this._tileZoom) {
                    //     // 如果sibling tile已经被加载过，或者是远处的上级瓦片，则直接加入missedTiles
                    //     checkedTiles[tile.id] = 1;
                    //     missedTiles.push(tile);
                    // } else {
                    //     // 遍历当前级别瓦片，如果四个sibling tile都没有加载，则把parentTile加入到missedTiles，减少要处理的瓦片数量
                    //     let parentTile = parentKeys[tile.parent];
                    //     if (parentTile || parentTile === null) {
                    //         // parentTile已被处理过
                    //         // 1. parentTile存在，则parentTile已经被加入到missedTile，作为parentTile的儿子瓦片的tile可以忽略
                    //         // 2. parentTile不存在，则把当前瓦片加入到missedTile
                    //         if (parentTile === null) {
                    //             checkedTiles[tile.id] = 1;
                    //             missedTiles.push(tile);
                    //         }
                    //         continue;
                    //     }
                    //     // 只查询上一级的parentTile
                    //     parentTile = this._findParentTile(tile, 1) || undefined;
                    //     if (parentTile && parentTile.image) {
                    //         // 父级瓦片存在，则把parentTile放入到tiles列表直接绘制
                    //         tiles.push(parentTile);
                    //         parentKeys[tile.parent] = parentTile;
                    //     } else {
                    //         const parentTileInfo = layer.tileInfoCache.get(tile.parent);
                    //         // 根据parentTileInfo是否存在，选择把parentTileInfo或者tile加入到missedTiles
                    //         if (parentTileInfo) {
                    //             if (!checkedTiles[parentTileInfo.id]) {
                    //                 checkedTiles[parentTileInfo.id] = 1;
                    //                 missedTiles.push(parentTileInfo);
                    //             }
                    //             parentKeys[tile.parent] = parentTileInfo;
                    //         } else {
                    //             checkedTiles[tile.id] = 1;
                    //             missedTiles.push(tile);
                    //             parentKeys[tile.parent] = null;
                    //         }
                    //     }
                    // }
                }
            }

            this.tileCache.shrink();

            // if (parentTiles.length) {
            //     childTiles.length = 0;
            //     this._childTiles.length = 0;
            // }
            layer._spatialRef = null;
            this.map = null;
            return {
                childTiles, missedTiles, parentTiles, tiles, incompleteTiles: incompleteTiles && Array.from(incompleteTiles.values()), placeholders, loading, loadingCount, tileQueue, panCoverageRisk
            };
        }

        /**
         * Compute squared distance from a tile's center to the current tile grid's
         * viewport center. Used to prioritize loading center tiles first.
         * @internal
         */
        _getTileDistanceToViewportCenter(tile: any, tileGrid: any): number {
            const center = tileGrid.extent ? tileGrid.extent.getCenter() : null;
            if (!center || !tile.extent2d) return Infinity;
            const tx = (tile.extent2d.xmin + tile.extent2d.xmax) / 2;
            const ty = (tile.extent2d.ymin + tile.extent2d.ymax) / 2;
            const dx = tx - center.x;
            const dy = ty - center.y;
            return dx * dx + dy * dy;
        }

        removeTileCache(tileId: TileId) {
            delete this.tilesInView[tileId];
            this.tileCache.remove(tileId);
        }

        isTileCachedOrLoading(tileId: TileId) {
            return this.tileCache.get(tileId) || this.tilesInView[tileId] || this.tilesLoading[tileId];
        }

        isTileCached(tileId: TileId) {
            return !!(this.tileCache.get(tileId) || this.tilesInView[tileId]);
        }

        isTileFadingIn(tileImage: Tile['image']) {
            return this.getTileFadingOpacity(tileImage) < 1;
        }

        //@internal
        _drawTiles(tiles, parentTiles, childTiles, placeholders, parentContext, missedTiles, incompleteTiles, panCoverageRisk) {
            let deferCurrentTilesOnZoom = false;
            let progressiveCurrentOpacity = 1;
            let zoomSnapshotActive = false;
            let progressiveReason = 'coverage-ready';
            const isVectorTileLayer = !!(this.layer as any).isVectorTileLayer;
            const isRasterTileLayer = !isVectorTileLayer;

            // FPS optimization: skip re-sorting and snapshot analysis
            // when tile composition hasn't changed since last frame
            // FPS 优化：当瓦片组成与上一帧相比无变化时，
            // 跳过重排序和快照分析。
            const map = this.getMap();
            const tilesLoadingCount = this.tilesLoading ? Object.keys(this.tilesLoading).length : 0;
            const drawStateKey = (tiles ? tiles.length : 0) + '|' +
                (parentTiles ? parentTiles.length : 0) + '|' +
                (childTiles ? childTiles.length : 0) + '|' +
                tilesLoadingCount + '|' +
                this._tileZoom;
            const sameDrawState = this._lastDrawStateKey === drawStateKey;

            if (parentTiles.length) {
                if (!sameDrawState || !this._parentTiles) {
                    parentTiles.sort(this._compareTiles);
                    this._parentTiles = parentTiles;
                }
            }
            if (childTiles.length) {
                if (!sameDrawState || !this._childTiles) {
                    this._childTiles = childTiles;
                    this._childTiles.sort(this._compareTiles);
                }
            }

            // Invalidate cached snapshot state when tile composition changes
            // 瓦片组成变化时，使缓存的快照状态失效
            if (!sameDrawState) {
                delete this._cachedSnapshotState;
                delete this._cachedSnapshotBackgroundTiles;
            }

            if (isRasterTileLayer && tiles && tiles.length) {
                const zoomDirection = this._zoomTransitionDirection;
                const captureStableOnSettledFrame = (!map || !map.isInteracting || !map.isInteracting()) && tilesLoadingCount === 0;
                const captureStableOnReadyZoomFrame = map && map.isZooming && map.isZooming() &&
                    tilesLoadingCount <= 1 &&
                    tiles.length >= 16;
                const captureStableOnZoomOutFrame = map && map.isZooming && map.isZooming() &&
                    zoomDirection === -1 &&
                    tilesLoadingCount <= 3 &&
                    tiles.length >= Math.max(12, parentTiles && parentTiles.length ? Math.ceil(parentTiles.length * 0.75) : 12);
                if (captureStableOnSettledFrame) {
                    this._captureStableZoomFrameTiles(tiles, 'settled-frame');
                } else if (captureStableOnZoomOutFrame) {
                    // zoom-out 的目标层级瓦片更稀疏，通常在"还没完全收齐"时就已经足够稳定。
                    // 提前把这批较低层级的 current tiles 记录成 stable frame，
                    // 能减少后续继续回缩时仍拿高 zoom 旧片做 snapshot 的块状感。
                    this._captureStableZoomFrameTiles(tiles, 'zoom-out-ready-frame');
                } else if (captureStableOnReadyZoomFrame) {
                    this._captureStableZoomFrameTiles(tiles, 'zoom-ready-frame');
                }
            }
            const useStableZoomSnapshot = map && map.isZooming && map.isZooming() && isRasterTileLayer;
            const keepSnapshotWhileSettling = !useStableZoomSnapshot &&
                isRasterTileLayer &&
                this._zoomSnapshotTiles && this._zoomSnapshotTiles.length &&
                tilesLoadingCount > 0;
            const shouldKeepSnapshot = useStableZoomSnapshot || keepSnapshotWhileSettling;
            const preferSnapshotBackgroundOnZoom = useStableZoomSnapshot &&
                this._zoomSnapshotTiles && this._zoomSnapshotTiles.length > 0;
            if (shouldKeepSnapshot) {
                // FPS optimization: skip heavy snapshot collection when tile state unchanged
                // FPS 优化：瓦片状态无变化时跳过繁重的快照收集
                let snapshotState;
                if (sameDrawState && this._cachedSnapshotState && this._cachedSnapshotBackgroundTiles) {
                    snapshotState = this._cachedSnapshotState;
                } else {
                    snapshotState = this._collectZoomSnapshotTiles(tiles, this._stableZoomFrameTiles);
                    if (sameDrawState) {
                        this._cachedSnapshotState = snapshotState;
                    }
                }
                const shouldFreezeSnapshotRefreshOnZoom = useStableZoomSnapshot &&
                    this._zoomSnapshotTiles && this._zoomSnapshotTiles.length > 0 &&
                    tilesLoadingCount > 1 &&
                    !(snapshotState.source === 'stable-frame' &&
                        tilesLoadingCount <= 2 &&
                        snapshotState.tiles.length >= Math.max(12, Math.floor(this._zoomSnapshotTiles.length * 0.9)));
                if (snapshotState.tiles.length &&
                    !shouldFreezeSnapshotRefreshOnZoom &&
                    !this._hasSameTileSet(this._zoomSnapshotTiles, snapshotState.tiles)) {
                    this._zoomSnapshotTiles = snapshotState.tiles;
                    this._zoomSnapshotDominantZoom = snapshotState.dominantZoom;
                }
            } else if (this._zoomSnapshotTiles && this._zoomSnapshotTiles.length) {
                delete this._zoomSnapshotTiles;
                delete this._zoomSnapshotDominantZoom;
            }
            const noFrameTiles = (!tiles || !tiles.length) &&
                (((!parentTiles || !parentTiles.length) || preferSnapshotBackgroundOnZoom)) &&
                (!childTiles || !childTiles.length);
            const partialCoverageRisk = shouldKeepSnapshot &&
                tiles && tiles.length &&
                (((!parentTiles || !parentTiles.length) || preferSnapshotBackgroundOnZoom)) &&
                (!childTiles || !childTiles.length) &&
                this.tilesLoading && Object.keys(this.tilesLoading).length;
            // During panning (not zoom), show retained/stale tiles from
            // the previous viewport as fallback while new tiles are loading. Without this,
            // fast panning results in large white gaps because old tiles are removed from
            // the draw list before new ones arrive.
            // M平移（非缩放）期间，在新瓦片加载时，将上一个视口
            // 保留的旧瓦片作为回退显示。否则快速平移会产生大片白缝，
            // 因为旧瓦片在新瓦片到达之前就已从绘制列表中移除。
            panCoverageRisk = !shouldKeepSnapshot &&
                isRasterTileLayer &&
                map && map.isMoving && map.isMoving() &&
                !map.isZooming && !map.isZooming() &&
                tiles && tiles.length &&
                (!parentTiles || !parentTiles.length) &&
                (!childTiles || !childTiles.length) &&
                tilesLoadingCount > 0 &&
                this.tilesInView;
            // P0: Vector tile zoom coverage fallback. During zoom transitions, vector
            // tile layers often have no current-zoom tiles loaded yet, and unlike raster
            // they don't benefit from the snapshot/stable-frame system. Without this
            // fallback, the vector layer renders blank (white screen) for multiple
            // frames until new tiles arrive, causing severe flickering and the
            // "appears then disappears" bug. Use preserved tilesInView entries (kept
            // alive by retireTiles' preserveStaleInViewOnVectorZooming) as a scaled
            // background so there is never a blank frame during zoom.
            // Also extends into the 500ms grace period after zoom ends to prevent
            // the "出图后消失" gap.
            // P0：矢量瓦片缩放覆盖回退。缩放过渡期间，矢量瓦片图层往往还没有
            // 加载任何当前 zoom 的瓦片，且与栅格不同，它们无法受益于
            // 快照/稳定帧系统。若没有此回退，矢量图层在新瓦片到达前会
            // 连续多帧渲染空白（白屏），造成严重闪烁和"出现后又消失"的 bug。
            // 使用被保留的 tilesInView 条目（由 retireTiles 的
            // preserveStaleInViewOnVectorZooming 保活）作为缩放背景，
            // 保证缩放期间不出现空白帧。
            // 同时延伸到缩放结束后 500ms 宽限期内，防止"出图后消失"的空档。
            const inVectorGracePeriod = isVectorTileLayer &&
                !!(this._vtZoomEndGraceUntil) && now() < this._vtZoomEndGraceUntil;
            // P0 根本性修复（FPS 优化引入的缺陷）：VT 瓦片是渐进式加载（按视口
            // 距离排序，一次只补缺片），"部分覆盖"（tiles.length > 0 但未完全
            // 覆盖视口）是缩放停后的常态。原条件要求 (noFrameTiles || !tiles.length)
            // ——只要有一片 current 瓦片加载完成，背景注入即被切断，未加载区域
            // 直接白屏，已加载瓦片孤立显示，表现为"渲染异常 / 显示简化图形 /
            // 缩放闪烁后消失"。
            // 改为：VT 在缩放 / 宽限期内只要还有瓦片在加载且 tilesInView 有素材，
            // 就持续注入旧瓦片背景。current 瓦片绘制在背景之上（背景=非 current
            // 的旧 zoom 瓦片），已加载区域被精确覆盖，未加载区域显示旧 zoom 放大图，
            // 直到宽限期结束瓦片全部就位。
            const vectorZoomCoverageRisk = isVectorTileLayer &&
                (map && map.isZooming && map.isZooming() || inVectorGracePeriod) &&
                tilesLoadingCount > 0 &&
                this.tilesInView;
            // P0: 缩放停止（onZoomEnd）时 map.isInteracting() 会立即变 false（isZooming 已置 false），
            // 但此时新层级瓦片往往还在加载。如果背景注入仍要求 isInteracting，
            // 宽限期内的旧瓦片背景会直接失效，导致"瓦片出现后闪一下就消失"。
            // 宽限期（onZoomEnd 后 500ms+）内同样允许注入保留的旧瓦片背景。
            const interactingOrVectorGrace = !!(map && map.isInteracting && map.isInteracting()) || inVectorGracePeriod;
            if ((noFrameTiles || partialCoverageRisk || panCoverageRisk || vectorZoomCoverageRisk) && interactingOrVectorGrace) {
                const staleTiles = [];
                const currentTileIds = new Set((tiles || []).map(tile => tile && tile.id).filter(Boolean));
                const targetZoom = isNumber(this._tileZoom) ? this._tileZoom :
                    (tiles && tiles.length && tiles[0] && tiles[0].info ? tiles[0].info.z : undefined);
                const zoomDirection = this._zoomTransitionDirection;
                // During zoom-out, always allow zoom snapshot tiles as background.
                // Previously, high-zoom snapshots were blocked when parent tiles existed,
                // which caused blank/white areas when parent tiles provided insufficient
                // coverage. The snapshot tiles (from the previous higher zoom level) can
                // be scaled to fill the viewport and provide continuous visual content
                // while target-zoom tiles load. They will fade out as new tiles arrive.
                // 缩小时始终允许 zoom 快照瓦片作为背景。
                // 此前当父级瓦片存在时会阻止高 zoom 快照，在父级瓦片覆盖不足时
                // 造成空白/白区。快照瓦片（来自之前的更高 zoom 级别）可被缩放
                // 以填充视口，在目标 zoom 瓦片加载期间提供连续的视觉内容，
                // 并随新瓦片到达而淡出。
                const blockHighZoomSnapshotOnZoomOut = false;
                const backgroundSource = blockHighZoomSnapshotOnZoomOut ? null :
                    (preferSnapshotBackgroundOnZoom && this._zoomSnapshotTiles && this._zoomSnapshotTiles.length ?
                        this._zoomSnapshotTiles :
                        shouldKeepSnapshot && this._zoomSnapshotTiles && this._zoomSnapshotTiles.length ?
                            this._zoomSnapshotTiles : this.tilesInView);
                zoomSnapshotActive = backgroundSource === this._zoomSnapshotTiles;
                if (backgroundSource) {
                    for (const id in backgroundSource) {
                        const staleTile = backgroundSource[id];
                        if (!staleTile || currentTileIds.has(staleTile.id)) {
                            continue;
                        }
                        // P0 修复：VT 缩小场景 zoom 差距过滤。目标 zoom 与旧瓦片 z 差距
                        // >= VT_STALE_ZOOM_GAP_MAX（如 z16 -> z12，服务 z<=14 无数据）时，
                        // 旧瓦片放大作背景只会造成"旧要素暂留"，且该层级无数据不存在
                        // "出图后消失"风险，直接跳过不注入。
                        if (vectorZoomCoverageRisk && staleTile.info) {
                            const staleZ = staleTile.info.z;
                            if (isNumber(staleZ) && isNumber(targetZoom) &&
                                Math.abs(staleZ - targetZoom) >= VT_STALE_ZOOM_GAP_MAX) {
                                continue;
                            }
                        }
                        if (this.isValidCachedTile(staleTile)) {
                            staleTiles.push(staleTile);
                        }
                    }
                    // During fast panning, tilesInView may not cover
                    // all recently-visible areas after the viewport jumps by multiple
                    // tile widths. Fall back to the LRU tileCache for extra stale tiles
                    // within 1 zoom level of the current zoom to fill coverage gaps.
                    // 快速平移时，视口跳跃多个瓦片宽度后，
                    // tilesInView 可能无法覆盖所有刚可见的区域。
                    // 回退到 LRU tileCache，寻找与当前 zoom 相差 1 级以内的
                    // 额外旧瓦片来填补覆盖空隙。
                    if (panCoverageRisk && !zoomSnapshotActive && this.tileCache) {
                        const staleSet = new Set(staleTiles.map(t => t.id));
                        const staleZoom = Math.round(isNumber(targetZoom) ? targetZoom :
                            (map && map.getZoom ? map.getZoom() : 0));
                        // Iterate tileCache entries that may have been recently visible
                        // but already evicted from tilesInView. Limit search to avoid
                        // blocking the frame.
                        // 遍历 tileCache 中可能刚可见但已被逐出 tilesInView 的条目。
                        // 限制搜索量以避免阻塞当前帧。
                        let cacheChecked = 0;
                        const cacheKeys = this.tileCache.keys();
                        // Iterate from most-recent (end of usage order) for efficiency
                        // 为提高效率，从最近使用端（使用顺序末尾）开始遍历
                        for (let i = cacheKeys.length - 1; i >= 0 && cacheChecked < 24; i--) {
                            const entry = this.tileCache.peek(cacheKeys[i]);
                            cacheChecked++;
                            if (!entry || !entry.info) continue;
                            const tileZ = entry.info.z;
                            if (tileZ == null || Math.abs(tileZ - staleZoom) > 1) continue;
                            if (!staleSet.has(entry.id) && !currentTileIds.has(entry.id)) {
                                if (this.isValidCachedTile(entry)) {
                                    staleTiles.push(entry);
                                    staleSet.add(entry.id);
                                    if (staleTiles.length >= 48) break;
                                }
                            }
                        }
                    }
                }
                if (staleTiles.length) {
                    const staleTargetZoom = isNumber(this._tileZoom) ? this._tileZoom :
                        (tiles && tiles.length && tiles[0] && tiles[0].info ? tiles[0].info.z : undefined);
                    const filteredStaleTiles = map && map.isZooming && map.isZooming() ?
                        this._pickDirectionalSnapshotTiles(staleTiles, staleTargetZoom).tiles :
                        this._pickDominantZoomTiles(staleTiles).tiles;
                    childTiles = (filteredStaleTiles.length ? filteredStaleTiles : staleTiles).sort(this._compareTiles);
                    this._childTiles = childTiles;
                    if (partialCoverageRisk) {
                        const currentTileCount = tiles ? tiles.length : 0;
                        const staleTileCount = childTiles.length;
                        const loadingCount = this.tilesLoading ? Object.keys(this.tilesLoading).length : 0;
                        const estimatedTargetTileCount = Math.max(
                            staleTileCount,
                            currentTileCount + loadingCount,
                            currentTileCount
                        );
                        const coverageRatio = estimatedTargetTileCount ? currentTileCount / estimatedTargetTileCount : 1;
                        const freezeCurrentTilesOnZoom = zoomSnapshotActive && isRasterTileLayer && map && map.isZooming && map.isZooming();
                        const zoomingOut = freezeCurrentTilesOnZoom && this._zoomTransitionDirection === -1;
                        const visualTargetZoom = map && map.getZoom ? map.getZoom() : staleTargetZoom;
                        const highZoomSnapshotOnZoomOut = !!(
                            zoomingOut &&
                            isNumber(this._zoomSnapshotDominantZoom) &&
                            (
                                (isNumber(staleTargetZoom) && this._zoomSnapshotDominantZoom > staleTargetZoom) ||
                                (isNumber(visualTargetZoom) && this._zoomSnapshotDominantZoom > visualTargetZoom + 0.25)
                            )
                        );
                        // 进一步向 Leaflet 的 raster 交互策略靠拢：
                        // 只要仍处于交互期，就保持旧层 snapshot 稳定显示，
                        // 当前层级继续后台加载，但不在交互中参与上屏。
                        const readyByCoverage = currentTileCount >= Math.max(1, Math.ceil(estimatedTargetTileCount * 0.85));
                        const freezeCurrentTilesOnInteraction = freezeCurrentTilesOnZoom;
                        const settleReadyOnZoom = !highZoomSnapshotOnZoomOut &&
                            coverageRatio >= 0.95 &&
                            currentTileCount >= Math.max(8, Math.ceil(estimatedTargetTileCount * 0.9)) &&
                            loadingCount <= 2;
                        // Paints each loaded tile immediately at full opacity
                        // and fills uncovered areas with parent tiles. It never gates
                        // the whole current layer behind a coverage threshold: gating
                        // makes the visible map freeze on the old snapshot for a long
                        // time and then replace the entire layer at once when coverage
                        // finally passes - the classic "sudden whole-layer swap"
                        // flicker and unnatural loading feedback.
                        // Only freeze when there is literally nothing to paint yet.
                        // 将每个已加载的瓦片立即以全不透明绘制，
                        // 并用父级瓦片填充未覆盖区域。它从不在覆盖率阈值后
                        // 才放行整个当前层：门控会让可见地图长时间冻结在旧快照上，
                        // 待覆盖率最终达标时一次性替换整层——这就是典型的
                        // "整层突换"闪烁和不自然的加载反馈。
                        // 只有确实没有任何内容可绘制时才冻结。
                        const mustFreezeOnZoom = freezeCurrentTilesOnInteraction && currentTileCount === 0;
                        deferCurrentTilesOnZoom = mustFreezeOnZoom ||
                            (currentTileCount === 0 && loadingCount > 0);
                        // 安全兜底：冻结 current 的前提是背景（stale/child + parent）足以覆盖视口。
                        // 若背景不足，冻结会导致整屏空白直到瓦片补齐，此时必须退化为直接上屏
                        // current（已加载的瓦片立即显示 + 渐进透明度），未覆盖区域等待加载即可。
                        if (deferCurrentTilesOnZoom && currentTileCount > 0) {
                            const backgroundEstimateCount = childTiles.length +
                                (this._parentTiles ? this._parentTiles.length : 0);
                            if (backgroundEstimateCount < Math.max(4, Math.ceil(estimatedTargetTileCount * 0.6))) {
                                deferCurrentTilesOnZoom = false;
                                progressiveReason = 'background-insufficient';
                            }
                        }
                        // Paints every loaded tile at full opacity (1.0) during
                        // zoom. Partial opacity blending on current tiles (previous
                        // progressiveCurrentOpacity of 0.35-0.96) causes visual flicker
                        // because load-completion is uneven across tiles: some draw
                        // semi-transparent on top of fully opaque background tiles while
                        // others haven't loaded yet. The patchwork of opacity differences
                        // across the viewport reads as "blinking".
                        // Fix: current tiles always paint at full opacity. Cross-fade
                        // between zoom levels is handled exclusively by the background
                        // layer via backgroundTileOpacity settle animation, not by
                        // fading the foreground.
                        // 在缩放期间将每个已加载瓦片以全不透明（1.0）绘制。
                        // 对当前层瓦片做部分透明混合（此前的 progressiveCurrentOpacity
                        // 为 0.35-0.96）会导致视觉闪烁，因为瓦片加载完成时间不均：
                        // 一些瓦片半透明地绘制在全不透明背景瓦片之上，而另一些
                        // 尚未加载。视口中透明度的拼图式差异表现为"闪烁"。
                        // 修复：当前层瓦片始终以全不透明绘制。zoom 级别之间的
                        // 交叉淡变完全由背景层通过 backgroundTileOpacity 的
                        // settle 动画处理，而非淡出前景。
                        progressiveCurrentOpacity = 1;
                        if (freezeCurrentTilesOnInteraction && !mustFreezeOnZoom) {
                            if (settleReadyOnZoom) {
                                progressiveReason = 'zoom-settling-blend';
                            } else {
                                progressiveReason = 'interaction-snapshot-blend';
                            }
                        } else if (freezeCurrentTilesOnInteraction) {
                            progressiveReason = currentTileCount === 0 ? 'coverage-empty' : 'interaction-snapshot-freeze';
                        } else if (!deferCurrentTilesOnZoom) {
                            progressiveReason = 'coverage-and-loading-ready';
                        } else if (currentTileCount === 0) {
                            progressiveReason = 'coverage-empty';
                        } else if (!readyByCoverage) {
                            progressiveReason = 'coverage-incomplete';
                        } else {
                            progressiveReason = 'loading-busy';
                        }
                    }
                }
            }
            const currentTileCount = tiles ? tiles.length : 0;
            // Pan progressive opacity: when panCoverageRisk indicates
            // that stale tiles from the previous viewport were injected as gap fillers
            // into the current tile set, fade new current tiles in gradually to smooth
            // the transition and eliminate the jarring "pop-in" at the expanding edge.
            // Unlike zoom's multi-stage progressive blending, pan blend is simpler:
            // it only activates when coverage gaps exist and loading is active.
            // 平移渐进透明度：当 panCoverageRisk 表明上一视口的
            // 旧瓦片被注入当前瓦片集作为空隙填充时，将新的当前层瓦片逐渐淡入，
            // 以平滑过渡并消除扩展边缘突兀的"弹出"。
            // 与缩放的多阶段渐进混合不同，平移混合更简单：
            // 仅在存在覆盖空隙且加载进行中时激活。
            if (panCoverageRisk && currentTileCount > 0 && !deferCurrentTilesOnZoom) {
                const isPanningOnly = map && map.isInteracting() &&
                    !(map.isZooming && map.isZooming());
                if (isPanningOnly && tilesLoadingCount > 0 &&
                    missedTiles && missedTiles.length > 0) {
                    // Coverage of new viewport tiles vs total needed:
                    // fade starts at ~0.65 and approaches 1.0 as more tiles load.
                    // 新视口瓦片覆盖率 vs 总需求量：
                    // 淡入从约 0.65 开始，随瓦片加载逐渐趋近 1.0。
                    const panCoverageRatio = Math.min(1, currentTileCount /
                        (currentTileCount + missedTiles.length + tilesLoadingCount * 0.5));
                    progressiveCurrentOpacity = Math.max(0.65,
                        Math.min(0.92, 0.55 + panCoverageRatio * 0.4));
                    progressiveReason = 'pan-progressive-blend';
                }
            }
            const zoomingOutWithSnapshot = !!(
                map && map.isZooming && map.isZooming() &&
                isRasterTileLayer &&
                this._zoomTransitionDirection === -1 &&
                zoomSnapshotActive
            );
            // Always keeps parent tiles as a fallback underneath the current
            // level during zoom: uncovered regions show the closest cached ancestor
            // instead of blank white. Suppressing parent fallback while a zoom snapshot
            // is active (previous code) left large holes whenever the snapshot tiles
            // (captured around the old view center) could not cover areas newly exposed
            // by cursor-centered wheel zoom. Keep the parent fallback unconditionally.
            // 在缩放期间始终将父级瓦片作为当前层之下的回退保留：
            // 未覆盖区域显示最近的缓存祖先瓦片，而非空白。
            // 此前代码在 zoom 快照激活时抑制父级回退，每当快照瓦片
            // （围绕旧视图中心捕获）无法覆盖以光标为中心的滚轮缩放
            // 新暴露的区域时，就会留下大洞。无条件保留父级回退。
            const backgroundParentSource = this._parentTiles;
            const backgroundParentTiles = map && map.isZooming && map.isZooming() && backgroundParentSource && backgroundParentSource.length ?
                (
                    this._zoomTransitionDirection === -1 ?
                        this._pickDirectionalSnapshotTiles(backgroundParentSource, isNumber(this._tileZoom) ? this._tileZoom : undefined).tiles :
                        this._pickDominantZoomTiles(backgroundParentSource).tiles
                ) :
                backgroundParentSource;
            const backgroundLoadingCount = this.tilesLoading ? Object.keys(this.tilesLoading).length : 0;
            const backgroundEstimatedTargetTileCount = Math.max(
                childTiles ? childTiles.length : 0,
                currentTileCount + backgroundLoadingCount,
                currentTileCount
            );
            const backgroundCoverageRatio = backgroundEstimatedTargetTileCount ? currentTileCount / backgroundEstimatedTargetTileCount : 1;
            const suppressChildBackgroundOnZoomOut = zoomingOutWithSnapshot &&
                !!(backgroundParentTiles && backgroundParentTiles.length) &&
                (
                    currentTileCount === 0 ||
                    deferCurrentTilesOnZoom ||
                    backgroundLoadingCount > 2 ||
                    backgroundCoverageRatio < 0.95 ||
                    currentTileCount < Math.max(backgroundParentTiles.length * 2, Math.ceil(backgroundEstimatedTargetTileCount * 0.75))
                );
            const backgroundChildTiles = suppressChildBackgroundOnZoomOut ? EMPTY_ARRAY : childTiles;
            const hasProgressiveBackground = !!(
                (backgroundChildTiles && backgroundChildTiles.length) ||
                (backgroundParentTiles && backgroundParentTiles.length)
            );
            if (map && map.isZooming && map.isZooming() &&
                isRasterTileLayer &&
                !deferCurrentTilesOnZoom &&
                currentTileCount > 0 &&
                tilesLoadingCount <= 2 &&
                progressiveCurrentOpacity === 1 &&
                progressiveReason === 'coverage-ready' &&
                !(zoomingOutWithSnapshot &&
                    isNumber(this._zoomSnapshotDominantZoom) &&
                    (
                        (isNumber(this._tileZoom) && this._zoomSnapshotDominantZoom > this._tileZoom) ||
                        (map && map.getZoom && this._zoomSnapshotDominantZoom > map.getZoom() + 0.25)
                    )) &&
                hasProgressiveBackground) {
                // Keeps the foreground at full opacity during the whole
                // transition and only fades the background layer out (via parent
                // mix in shader, via backgroundTileOpacity here).
                // Foreground opacity < 1 lets the background show through and adds
                // luminance on top of it (0.92 foreground + background alpha), which
                // reads as brightness pulsing while the background fades - the
                // remaining flicker after the defer-gate fix.
                // The foreground stays 1; the background alone fades to 0.
                // 在整个过渡期间保持前景全不透明，仅淡出背景层
                // （shader 中通过 parent mix 实现，这里通过
                // backgroundTileOpacity 实现）。
                // 前景透明度 < 1 会让背景透出并在其上叠加亮度
                // （0.92 前景 + 背景透明度），在背景淡出时表现为亮度脉动——
                // 这是 defer 门控修复后残留的闪烁。
                // 前景保持 1；仅背景单独淡出至 0。
                progressiveReason = 'zoom-settling-blend';
            }
            const nowTs = now();
            let backgroundTileOpacity = 1;
            // ---- Background tile cross-fade for VECTOR layers during zoom ----
            // The existing "settle" mechanism only activates for raster layers
            // (progressiveReason === 'zoom-settling-blend' requires isRasterTileLayer).
            // Vector layers previously had no background fade at all → text/symbol/
            // lines from parent/child zoom levels overlapped and never faded out.
            //
            // We use a clean two-phase approach (independent of raster settle):
            //   Phase 1 (zoom active): opacity 1 → 0.15 over 80 ms, then hold at 0.15
            //   Phase 2 (zoom ended):  opacity from → 1  over 80 ms (fade back in)
            // This avoids the raster settle's sawtooth flicker (reset every 120 ms).
            // ---- 矢量图层缩放期间的背景瓦片交叉淡变 ----
            // 现有的 "settle" 机制仅对栅格图层生效
            // （progressiveReason === 'zoom-settling-blend' 要求 isRasterTileLayer）。
            // 矢量图层此前完全没有背景淡变 → 来自父/子 zoom 级别的
            // 文本/符号/线重叠且永不淡出。
            //
            // 采用干净的两阶段方案（独立于栅格 settle）：
            //   阶段 1（缩放进行中）：透明度 1 → 0.15，历时 80ms，随后保持 0.15
            //   阶段 2（缩放结束后）：透明度 from → 1，历时 80ms（淡回）
            // 避免了栅格 settle 的锯齿闪烁（每 120ms 重置）。
            const isVectorZoomingWithBg = !isRasterTileLayer &&
                (map && map.isZooming && map.isZooming()) &&
                hasProgressiveBackground;

            if (isVectorZoomingWithBg) {
                // ---- ZOOM ACTIVE: fade out background tiles ----
                // ---- 缩放进行中：淡出背景瓦片 ----
                if (!this._bgFadeOutStart) {
                    this._bgFadeOutStart = nowTs;
                }
                const fadeElapsed = nowTs - this._bgFadeOutStart;
                // Faster fade (80ms instead of 120ms) with lower floor (0.15 instead
                // of 0.3) so that simplified geometry from parent/child zoom levels is
                // less visible during zoom.  Mirrors rapid cross-fade where
                // the background contribution drops quickly.
                // 更快的淡出（80ms 代替 120ms）与更低的下限（0.15 代替 0.3），
                // 使缩放期间父/子 zoom 级别的简化几何更不可见。
                // 快速交叉淡变一致——背景贡献迅速下降。
                const fadeProgress = Math.min(1, fadeElapsed / 80);
                backgroundTileOpacity = Math.max(0.15, 1 - fadeProgress);  // 1 → 0.15
                // Clear any pending fade-in (user started zooming again mid-fade)
                // 清除任何待处理的淡入（用户在淡出中途再次开始缩放）
                delete this._bgFadeInStart;
            } else if (this._bgFadeOutStart != null && !this._bgFadeInStart) {
                // ---- ZOOM ENDED: start fade-in ----
                // ---- 缩放结束：开始淡入 ----
                // Use renderer's stored opacity from the PREVIOUS frame (not the
                // local variable which was just initialized to 1). This ensures the
                // fade-in starts from the actual fade-out end-point (near 0).
                // 使用渲染器上一帧存储的透明度（而非刚被初始化为 1 的局部变量）。
                // 这确保淡入从淡出实际结束点（接近 0）开始。
                this._bgFadeInStartValue = this._backgroundTileOpacity != null
                    ? this._backgroundTileOpacity : 0;
                this._bgFadeInStart = nowTs;
            }

            if (this._bgFadeInStart != null) {
                // ---- FADE-IN active: bring background tiles back ----
                // ---- 淡入进行中：将背景瓦片淡回 ----
                const fadeElapsed = nowTs - this._bgFadeInStart;
                const fadeProgress = Math.min(1, fadeElapsed / 80);
                const from = this._bgFadeInStartValue != null ? this._bgFadeInStartValue : 0;
                backgroundTileOpacity = from + (1 - from) * fadeProgress;  // from → 1
                if (fadeProgress >= 1) {
                    // Fade-in complete → return to idle
                    // 淡入完成 → 回到空闲状态
                    backgroundTileOpacity = 1;
                    delete this._bgFadeOutStart;
                    delete this._bgFadeInStart;
                    delete this._bgFadeInStartValue;
                }
            }

            // ---- Raster-layer settle (unchanged) ----
            // ---- 栅格图层 settle（保持不变） ----
            if (progressiveReason === 'zoom-settling-blend' && hasProgressiveBackground) {
                if (!this._backgroundSettleUntil || this._backgroundSettleUntil <= nowTs) {
                    this._backgroundSettleStart = nowTs;
                    this._backgroundSettleUntil = nowTs + 120;
                }
            } else if (!isVectorZoomingWithBg && this._bgFadeInStart == null && this._bgFadeOutStart == null) {
                delete this._backgroundSettleStart;
                delete this._backgroundSettleUntil;
            }

            if (this._backgroundSettleStart && this._backgroundSettleUntil && this._backgroundSettleUntil > nowTs) {
                const settleDuration = Math.max(1, this._backgroundSettleUntil - this._backgroundSettleStart);
                const settleProgress = Math.min(1, Math.max(0, (nowTs - this._backgroundSettleStart) / settleDuration));
                // Only let raster settle override if vector fade hasn't already set a value
                // 仅当矢量淡变尚未设置值时，才允许栅格 settle 覆盖
                if (!isVectorZoomingWithBg && this._bgFadeInStart == null && this._bgFadeOutStart == null) {
                    backgroundTileOpacity = Math.max(0, 0.72 * (1 - settleProgress));
                }
            }
            const mapCanvas = map.getRenderer().canvas;
            let drawBackground = true;
            let frameTileState = mapCanvas._frameTileState;
            if (!frameTileState) {
                frameTileState = mapCanvas._frameTileState = { timestamp: 0, count: 0 };
            }
            const mustDrawBackgroundOnZoom = !!(map && map.isZooming && map.isZooming() && hasProgressiveBackground);
            // P0: Layers with zero current tiles MUST draw background (parent/snapshot) tiles.
            // Suppressing background draw on a layer with no other content causes blank white
            // gaps on screen. The counter only limits redundant backgrounds on layers that
            // already have current-zoom coverage.
            // P0：当前瓦片数为零的图层必须绘制背景（父级/快照）瓦片。
            // 对没有其他内容的图层抑制背景绘制会导致屏幕出现空白白区。
            // 计数器仅限制已具备当前 zoom 覆盖的图层上的冗余背景。
            const hasNoCurrentTiles = currentTileCount === 0;
            if (this.layer.constructor === TileLayer || this.layer.constructor === WMSTileLayer) {

                // background tiles are only painted once for TileLayer and WMSTileLayer per frame.
                if (!mustDrawBackgroundOnZoom &&
                    !hasNoCurrentTiles &&
                    this._renderTimestamp === frameTileState.timestamp &&
                    frameTileState.count > map.options['tileBackgroundLimitPerFrame']) {
                    drawBackground = false;
                } else {
                    if (this._renderTimestamp !== frameTileState.timestamp) {
                        frameTileState.timestamp = this._renderTimestamp;
                        frameTileState.count = 1;
                    } else if (!hasNoCurrentTiles) {
                        frameTileState.count++;
                    }
                }
            }

            const context = { tiles, parentTiles: this._parentTiles, childTiles: this._childTiles, parentContext };
            this.onDrawTileStart(context, parentContext);

            // During zoom and the subsequent background settle,
            // suppress ALL per-tile fade-animation so that loaded tiles appear
            // at full opacity instantly. Per-tile fade-in (getTileFadingOpacity)
            // over a fading background produces double-blend flicker: new tiles
            // ramp 0→1 while background ramps 0.72→0.18, causing visible pulsing.
            // 缩放及随后的背景 settle 期间，
            // 抑制所有逐瓦片的淡入动画，让已加载瓦片立即以全不透明显示。
            // 在正在淡出的背景之上再做逐瓦片淡入（getTileFadingOpacity）
            // 会产生双重混合闪烁：新瓦片 0→1 爬坡的同时背景 0.72→0.18 下降，
            // 造成可见的脉动。
            const isZoomingOrSettling = !!(map && (map.isZooming && map.isZooming() ||
                this._backgroundSettleUntil ||
                this._bgFadeOutStart != null || this._bgFadeInStart != null));
            // Expose the zoom/settle state to the GL renderer so updateFilter can keep
            // a stable mipmap-linear filter during the transition.
            // 将缩放/settle 状态暴露给 GL 渲染器，使 updateFilter 在过渡期间
            // 保持稳定的 mipmap-linear 过滤器。
            this._isZoomingOrSettling = isZoomingOrSettling;
            const originalFadeAnimation = isZoomingOrSettling ? this.layer.options['fadeAnimation'] : undefined;
            if (isZoomingOrSettling) {
                this.layer.options['fadeAnimation'] = false;
            }

            if (drawBackground) {
                this.layer._silentConfig = true;
                this._backgroundTileOpacity = backgroundTileOpacity;

                this._drawChildTiles(backgroundChildTiles, parentContext);
                this._drawParentTiles(backgroundParentTiles, parentContext);

                delete this._backgroundTileOpacity;
                this.layer._silentConfig = false;
            }

            // Always paints loaded tiles. Hiding already-loaded current-level
            // tiles behind a "defer" gate, even when a background fallback exists,
            // produces jarring white gaps when the background (snapshot / parent) does
            // not perfectly cover every recently exposed pixel - which is the norm
            // during cursor-centered wheel zoom and slow pan drags. Loaded tiles are
            // drawn at progressiveCurrentOpacity (faded when background is rich, full
            // when background is thin), never hidden.
            // 始终绘制已加载的瓦片。即使存在背景回退，
            // 将已加载的当前层瓦片藏在 "defer" 门控之后，当背景（快照/父级）
            // 无法完美覆盖每个新暴露的像素时会产生刺眼的白缝——
            // 这在以光标为中心的滚轮缩放和慢速平移拖拽中是常态。
            // 已加载瓦片按 progressiveCurrentOpacity 绘制
            // （背景丰富时淡显，背景稀薄时全显），从不隐藏。
            this.drawingCurrentTiles = true;
            this._progressiveCurrentOpacity = progressiveCurrentOpacity;
            tiles.sort(this._compareTiles);
            this._drawCurrentTiles(tiles, parentContext);
            delete this._progressiveCurrentOpacity;
            delete this.drawingCurrentTiles;

            if (isZoomingOrSettling) {
                this.layer.options['fadeAnimation'] = originalFadeAnimation;
            }
            delete this._isZoomingOrSettling;

            // placeholders.forEach(t => this._drawTile(t.info, t.image, parentContext));

            this.onDrawTileEnd(context, parentContext);

            // Cache the current draw state for the next frame to skip redundant computation
            // 缓存当前绘制状态供下一帧使用，跳过冗余计算
            this._lastDrawStateKey = drawStateKey;
        }

        _drawCurrentTiles(tiles, parentContext) {
            for (let i = 0, l = tiles.length; i < l; i++) {
                this._drawTileAndCache(tiles[i], parentContext);
            }
        }

        //@internal
        _drawChildTiles(childTiles, parentContext) {
            // _hasOwnSR 时，瓦片之间会有重叠，会产生z-fighting，所以背景瓦片要后绘制
            this.drawingChildTiles = true;
            childTiles.forEach(t => this._drawTile(t.info, t.image, parentContext));
            delete this.drawingChildTiles;
        }

        //@internal
        _drawParentTiles(parentTiles, parentContext) {
            this.drawingParentTiles = true;
            parentTiles.forEach(t => this._drawTile(t.info, t.image, parentContext));
            delete this.drawingParentTiles;
        }

        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        onDrawTileStart(context: RenderContext, parentContext: RenderContext) { }
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        onDrawTileEnd(context: RenderContext, parentContext: RenderContext) { }

        //@internal
        _drawTile(info, image, parentContext) {
            if (image) {
                this.drawTile(info, image, parentContext);
            }
        }

        drawTile(tileInfo: Tile['info'], tileImage: Tile['image'], parentContext?: RenderContext) {
        }

        //@internal
        _drawTileAndCache(tile: Tile, parentContext) {
            if (this.isValidCachedTile(tile)) {
                this.tilesInView[tile.info.id] = tile;
            }
            this._drawTile(tile.info, tile.image, parentContext);
        }

        drawOnInteracting(event: any, timestamp: number, context) {
            this.draw(timestamp, context);
        }

        checkIfNeedRedraw(): boolean {
            return !!this._tileQueue.length;
        }

        hitDetect(): boolean {
            return false;
        }

        /**
         * @private
         * limit tile number to load when map is interacting
         */
        //@internal
        _getLoadLimit(): number {
            const map = this.map || this.getMap();
            const maxConcurrent = GlobalConfig.maxConcurrentTileLoads;
            if (map.isInteracting()) {
                if (map.isZooming && map.isZooming()) {
                    const isVectorTileLayer = !!(this.layer as any).isVectorTileLayer;
                    if (!isVectorTileLayer) {
                        // Load aggressively during zoom to avoid white tiles
                        // but cap at maxConcurrent to prevent overwhelming the network/browser.
                        // During zoom-out, lower-zoom parent tiles are likely evicted from cache
                        // and must be fetched from network – apply a multiplier similar to pan
                        // to minimize blank areas during zoom-out transitions.
                        // 缩放期间激进加载以避免白瓦片，
                        // 但以 maxConcurrent 封顶，防止压垮网络/浏览器。
                        // 缩小时，低 zoom 父级瓦片很可能已被逐出缓存，
                        // 必须从网络获取——应用与平移类似的倍率，
                        // 尽量减少缩小过渡期间的空白区域。
                        const zoomOutMultiplier = this._zoomTransitionDirection === -1
                            ? Math.max(GlobalConfig.zoomOutLoadLimitMultiplier || 2.5, 1)
                            : 1;
                        const zoomLimit = maxConcurrent > 0
                            ? Math.min(Math.ceil(maxConcurrent * zoomOutMultiplier), maxConcurrent)
                            : 0;
                        return Math.max(zoomLimit, maxConcurrent > 0 ? Math.min(maxConcurrent, 16) : 0);
                    }
                    // P0: Vector tile layers need aggressive concurrency during zoom
                    // because each tile requires network fetch + parsing/decoding, and
                    // the default loadingLimitOnInteracting (6) causes severe queuing
                    // delays. Match raster behavior by using maxConcurrent with zoom-out
                    // multiplier, but use loadingLimitOnInteracting as a configurable
                    // floor so users can still cap it if needed.
                    // P0：矢量瓦片图层在缩放期间需要激进的并发，
                    // 因为每个瓦片都需要网络获取 + 解析/解码，
                    // 而默认的 loadingLimitOnInteracting（6）会造成严重的排队延迟。
                    // 与栅格行为对齐：使用 maxConcurrent 配合缩小倍率，
                    // 但以 loadingLimitOnInteracting 作为可配置下限，
                    // 用户仍可按需封顶。
                    const vtZoomOutMultiplier = this._zoomTransitionDirection === -1
                        ? Math.max(GlobalConfig.zoomOutLoadLimitMultiplier || 2.5, 1)
                        : 1;
                    const vtBaseLimit = Math.max(
                        this.layer.options['loadingLimitOnInteracting'] || 6,
                        Math.min(maxConcurrent > 0 ? maxConcurrent : 20, 16)
                    );
                    const vtZoomLimit = maxConcurrent > 0
                        ? Math.min(Math.ceil(vtBaseLimit * vtZoomOutMultiplier), maxConcurrent)
                        : vtBaseLimit;
                    return Math.max(vtZoomLimit, vtBaseLimit);
                }
                // During pan/rotate, multiply concurrent load limit by
                // panLoadLimitMultiplier to prefetch preload-margin tiles faster and
                // minimize white gaps during user interaction.
                // 平移/旋转期间，将并发加载上限乘以
                // panLoadLimitMultiplier，更快地预取预加载边距瓦片，
                // 尽量减少用户交互期间的白缝。
                const panMultiplier = Math.max(GlobalConfig.panLoadLimitMultiplier || 1, 1);
                return maxConcurrent > 0 ? Math.ceil(maxConcurrent * panMultiplier) : 0;
            }
            const staticLimit = this.layer.options['loadingLimit'] || 0;
            return maxConcurrent > 0 && staticLimit > 0 ? Math.min(staticLimit, maxConcurrent) : (staticLimit || maxConcurrent);
        }

        //@internal
        _isLoadingTile(tileId: TileId): boolean {
            return !!this.tilesLoading[tileId];
        }

        loadTileQueue(tileQueue): void {
            for (const p in tileQueue) {
                if (tileQueue.hasOwnProperty(p)) {
                    const tile = tileQueue[p];
                    const tileImage = this.loadTile(tile);
                    if (tileImage && tileImage.loadTime === undefined) {
                        // tile image's loading may not be async
                        // if empty not add to tilesLoading, it is not async
                        //空的瓦片不加入加载队列，因为不是异步的
                        if (!(tileImage as any)._empty) {
                            this.tilesLoading[tile['id']] = {
                                image: tileImage,
                                current: true,
                                info: tile
                            };
                        }
                    }
                }
            }
        }

        loadTile(tile: Tile['info']): Tile['image'] {
            const maxAvailableZoom = this.layer.options['maxAvailableZoom'];
            if (isNumber(maxAvailableZoom) && tile.z > maxAvailableZoom) {
                return null;
            }
            let tileImage = {} as Tile['image'];
            // fixme: 无相关定义，是否实现？
            if (this.loadTileBitmap && isFunction(this.loadTileBitmap)) {
                const onLoad = (bitmap) => {
                    this.onTileLoad(bitmap, tile);
                };
                const onError = (error, image) => {
                    this.onTileError(image, tile, error);
                };
                this.loadTileBitmap(tile['url'], tile, onLoad, onError);
            } else if (this._tileImageWorkerConn && this.loadTileImage === this.constructor.prototype.loadTileImage) {
                this._fetchImage(tileImage, tile);
            } else {
                // Use fetch + createImageBitmap to avoid double Image+ImageBitmap memory
                // Image.decode() holds decoded RGBA bitmap (~256KB per 256x256 tile) in CPU memory.
                // ImageBitmap avoids the CPU-side decode, yielding 40-60% lower memory per tile.
                // 使用 fetch + createImageBitmap，避免 Image + ImageBitmap 双份内存。
                // Image.decode() 会在 CPU 内存中持有解码后的 RGBA 位图
                // （每个 256x256 瓦片约 256KB）。ImageBitmap 避免了 CPU 侧解码，
                // 每瓦片内存降低 40-60%。
                const tileSize = this.layer.getTileSize(tile.layer);
                tileImage = new Image() as Tile['image'];

                // @ts-expect-error todo
                tileImage.width = tileSize['width'];
                // @ts-expect-error todo
                tileImage.height = tileSize['height'];

                (tileImage as any).onload = () => {
                    if (typeof createImageBitmap === 'function') {
                        const img = tileImage as HTMLImageElement;
                        createImageBitmap(img).then(imagebit => {
                            // Immediately release the Image's decoded bitmap to save ~256KB per tile
                            // 立即释放 Image 的解码位图，每瓦片节省约 256KB
                            img.src = emptyImageUrl;
                            img.onload = null;
                            img.onerror = null;
                            this.onTileLoad(imagebit as TileImage, tile);
                        }).catch((error) => {
                            console.error(error);
                            img.src = emptyImageUrl;
                            img.onload = null;
                            img.onerror = null;
                            this.onTileError(tileImage, tile, error);
                        });
                    } else {
                        this.onTileLoad(tileImage, tile);
                    }
                };
                (tileImage as any).onerror = this.onTileError.bind(this, tileImage, tile);

                this.loadTileImage(tileImage, tile['url'], tile);
            }
            return tileImage;
        }

        //@internal
        _fetchImage(image: any, tile: Tile['info']) {
            if (image instanceof Image) {
                image.src = tile.url;
            } else {
                const { x, y } = tile;
                const workerId = Math.abs(x + y) % this._tileImageWorkerConn.workers.length;
                // Track pending fetch so we can ignore stale results on abort
                // 追踪进行中的 fetch，以便中止时忽略过期结果
                if (!this._pendingFetches) {
                    this._pendingFetches = new Map<number, boolean>();
                }
                this._pendingFetches.set(tile.id, true);
                this._tileImageWorkerConn.fetchImage(tile.url, workerId, (err, data) => {
                    if (!this._pendingFetches?.has(tile.id)) {
                        // Fetch was cancelled (tile no longer needed): release transferred bitmap
                        // fetch 已被取消（瓦片不再需要）：释放已转移的位图
                        if (data && data.data && (data.data as any).close) {
                            (data.data as any).close();
                        }
                        return;
                    }
                    this._pendingFetches?.delete(tile.id);
                    if (err) {
                        this.onTileError(image, tile, err);
                    } else {
                        getImageBitMap(data, (bitmap: Tile['image']) => {
                            this.onTileLoad(bitmap, tile);
                        });
                    }
                }, this.layer.options['fetchOptions'] || {
                    referrer: document.location.href,
                    headers: { accept: 'image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8' }
                });
            }
        }

        loadTileImage(tileImage, url: string, tile: Tile['info']) {
            const crossOrigin = this.layer.options['crossOrigin'];
            if (!isNil(crossOrigin)) {
                tileImage.crossOrigin = crossOrigin;
            }
            return loadImage(tileImage, [url]);
        }

        abortTileLoading(tileImage: Tile['image'], tileInfo: Tile['info']): void {
            if (tileInfo && tileInfo.id !== undefined) {
                this.removeTileLoading(tileInfo);
                // Cancel any pending worker fetch for this tile to avoid
                // processing stale results and wasting rendering resources
                // 取消该瓦片所有进行中的 worker fetch，
                // 避免处理过期结果、浪费渲染资源
                if (this._pendingFetches) {
                    this._pendingFetches.delete(tileInfo.id);
                }
            }
            if (!tileImage) return;
            if (tileImage instanceof Image) {
                tileImage.onload = falseFn;
                tileImage.onerror = falseFn;
                tileImage.src = emptyImageUrl;
            }
            if (this.loadTileBitmap && isFunction(this.loadTileBitmap)) {
                const url = tileInfo.url;
                this.loadTileBitmap(url, tileInfo, () => {

                }, {
                    command: 'abortTile'
                })
            }
        }

        onTileLoad(tileImage: Tile['image'], tileInfo: Tile['info']): void {
            this.removeTileLoading(tileInfo);
            // Cap queue to prevent unbounded ImageBitmap accumulation when loading
            // outpaces consumption. Each queued tile holds a decoded bitmap (~256KB+).
            // P0: At high zoom (15+), network parallelism can load 28+ tiles per frame
            // while per-frame consumption caps at 32-96, causing the queue to grow rapidly.
            // With the old 2x multiplier (maxQueue = 512 for cacheSize=256), tiles could
            // get silently dropped after network load + decode, wasting bandwidth and CPU.
            // A 4x multiplier (maxQueue = 1024) accommodates high-zoom burst loading.
            const maxQueue = Math.max(64, (this.tileCache && this.tileCache.max || 64) * 4);
            while (this._tileQueue.length >= maxQueue) {
                const dropped = this._tileQueue.shift();
                this._tileQueueIds.delete(dropped.tileInfo.id);
                const data = dropped.tileData;
                if (data && (data as any).close) {
                    (data as any).close();
                }
            }
            this._tileQueue.push({ tileInfo: tileInfo, tileData: tileImage });
            this._tileQueueIds.add(tileInfo.id);
            this.setToRedraw();
        }

        removeTileLoading(tileInfo: Tile['info']): void {
            if (this.tilesLoading[tileInfo.id]) {
                delete this.tilesLoading[tileInfo.id];
            } else {
                // console.warn('Tile not found in tilesLoading:', tileInfo.id);
            }
            // need to setToRedraw to let tiles blocked by loadingLimit continue to load
            this.setToRedraw();
        }

        //@internal
        _consumeTileQueue(): void {
            let count = 0;
            // Frame budget: limit tiles consumed per frame to prevent
            // the main thread from being blocked by tile uploads/decode during rapid pan.
            // Uses layer-level tileLimitPerFrame first, falls back to global maxTilesPerFrame.
            // 帧预算：限制每帧消费的瓦片数量，防止快速平移期间
            // 主线程被瓦片上传/解码阻塞。优先使用图层级 tileLimitPerFrame，
            // 否则回退到全局 maxTilesPerFrame。
            let baseLimit = Math.max(0,
                this.layer.options['tileLimitPerFrame'] != null
                    ? this.layer.options['tileLimitPerFrame']
                    : GlobalConfig.maxTilesPerFrame
            );
            // During interaction (pan/zoom), increase per-frame tile
            // consumption to accelerate tile visibility and eliminate white gaps.
            // Only boost when panMultiplier is > 1 and limit is finite.
            // 交互期间（平移/缩放）提高每帧瓦片消费量，
            // 加速瓦片可见化并消除白斑。仅在 panMultiplier > 1 且 limit 有限时提升。
            const map = this.map || this.getMap();
            // P0: Vector tile grace period boost. After zoom ends, new-zoom tiles are
            // still loading and arriving in the queue. Apply the interaction boost
            // during the 500ms grace window so tiles get consumed (uploaded to GPU)
            // quickly instead of at idle pace, preventing delayed rendering.
            // Dynamic extension: keep extending while tiles are still loading so the
            // fast consumption pace (and the background/opacity protections in other
            // methods) survive until the new-zoom tiles actually arrive.
            // P0：矢量瓦片宽限期加速。缩放结束后，新 zoom 的瓦片仍在加载并入队。
            // 在 500ms 宽限窗口内应用交互加速，使瓦片快速被消费（上传 GPU），
            // 而非按空闲节奏处理，避免渲染延迟。
            // 动态延长：只要瓦片仍在加载就持续延长宽限期，让快速消费节奏
            // （以及其他方法中的背景/透明度保护）保持到新 zoom 瓦片真正到达。
            const _consumeGraceNow = now();
            if (this._vtZoomEndGraceUntil && _consumeGraceNow >= this._vtZoomEndGraceUntil) {
                // 宽限期动态延长防止缩放 stop 后旧 zoom 背景立即消失（突然白屏）。
                // 硬上限 600ms：从缩放结束起最多保留旧背景 600ms，
                // 600ms 后即使 tilesLoading 非空（网络慢/缓存 miss），也强制退出宽限期，
                // 避免"简化图形暂留时间过长"。
                // P0 修复：目标 zoom 与旧瓦片差距 >= VT_STALE_ZOOM_GAP_MAX 时
                // （服务该层级无数据），旧瓦片无保留价值，直接退出宽限期。
                const graceStart = this._vtZoomEndGraceStart || this._vtZoomEndGraceUntil;
                if (this._vtStaleZoomGapTooLarge()) {
                    delete this._vtZoomEndGraceUntil;
                    delete this._vtZoomEndGraceStart;
                } else if (this.tilesLoading && Object.keys(this.tilesLoading).length && (_consumeGraceNow - graceStart) < 600) {
                    this._vtZoomEndGraceUntil = _consumeGraceNow + 200;
                } else {
                    delete this._vtZoomEndGraceUntil;
                }
            }
            const inVectorGracePeriod = !!(this._vtZoomEndGraceUntil) && now() < this._vtZoomEndGraceUntil;
            if ((map && map.isInteracting() || inVectorGracePeriod) && baseLimit > 0) {
                const panMultiplier = Math.max(GlobalConfig.panLoadLimitMultiplier || 1, 1);
                baseLimit = Math.ceil(baseLimit * panMultiplier);
                // During zoom-out, apply an additional multiplier to consume new tiles
                // faster. The zoom-out viewport EXPANDS, exposing many new edge tiles
                // that must be consumed quickly to eliminate white gaps.
                // 缩小时施加额外倍率以更快消费新瓦片。缩小期间视口扩张，
                // 暴露出大量新的边缘瓦片，必须快速消费以消除白斑。
                if (map.isZooming && map.isZooming() && this._zoomTransitionDirection === -1) {
                    const zoomOutConsumeMultiplier = Math.max(
                        GlobalConfig.zoomOutTilesPerFrameMultiplier || 2, 1
                    );
                    baseLimit = Math.ceil(baseLimit * zoomOutConsumeMultiplier);
                }
            }
            const limit = baseLimit;
            const queue = this._tileQueue;

            // P0: Sort queue for consumption priority.
            // When zooming OUT, the viewport EXPANDS — edge tiles are newly visible and
            // cause white gaps. Use edge-first priority (like pan mode) so that new
            // border-area tiles get consumed before already-loaded center tiles.
            // During zoom IN, center tiles are most visible first (center-first).
            // During pan: edge-first (tiles at the leading edge are newly visible and
            //   cause white gaps; center tiles are already loaded).
            // During interaction: always sort (not just when queue exceeds limit) to
            //   ensure new edge tiles get consumed before already-loaded center tiles.
            // P0：对队列排序以确定消费优先级。
            // 缩小时视口扩张——边缘瓦片是新可见的并会产生白斑，
            // 因此使用边缘优先策略（类似平移模式），让新的边界区域瓦片
            // 在已加载的中心瓦片之前被消费。
            // 放大时，中心瓦片最先可见（中心优先）。
            // 平移时：边缘优先（前缘的瓦片是新可见的并会产生白斑；中心瓦片已加载）。
            // 交互期间：始终排序（而非仅在队列超限时），确保新的边缘瓦片
            //   先于已加载的中心瓦片被消费。
            const isZoomOutSortMode = map && map.isZooming && map.isZooming() &&
                this._zoomTransitionDirection === -1;
            const isPanSortMode = (map && map.isMoving && map.isMoving() &&
                !(map.isZooming && map.isZooming())) || isZoomOutSortMode;
            const shouldSortQueue = queue.length > 1 && limit > 0 &&
                (queue.length > limit || isPanSortMode);
            if (shouldSortQueue) {
                const tileGrids = this._frameTileGrids;
                let center = null;
                if (tileGrids) {
                    // Use the last (main) tile grid for the viewport center reference
                    // 使用最后一个（主）瓦片网格作为视口中心参考
                    for (let i = (tileGrids as any).length - 1; i >= 0; i--) {
                        const g = tileGrids[i];
                        if (g && g.extent && typeof g.extent.getCenter === 'function') {
                            center = g.extent.getCenter();
                            if (center) break;
                        }
                    }
                }
                if (center) {
                    const cx = center.x, cy = center.y;
                    if (isPanSortMode) {
                        // Pan mode: edge-first (furthest from center = highest priority).
                        // Reverse sort so the most-distant tiles get consumed first.
                        // This directly eliminates white gaps at the leading pan edge
                        // because those tiles are furthest from the viewport center.
                        // 平移模式：边缘优先（距中心最远 = 最高优先级）。
                        // 反向排序使最远的瓦片最先被消费。
                        // 由于平移前缘的瓦片距视口中心最远，
                        // 这样可直接消除平移前缘的白斑。
                        queue.sort((a, b) => {
                            const ea = a.tileInfo && a.tileInfo.extent2d;
                            const eb = b.tileInfo && b.tileInfo.extent2d;
                            if (!ea && !eb) return 0;
                            if (!ea) return -1;
                            if (!eb) return 1;
                            const dxa = (ea.xmin + ea.xmax) / 2 - cx;
                            const dya = (ea.ymin + ea.ymax) / 2 - cy;
                            const dxb = (eb.xmin + eb.xmax) / 2 - cx;
                            const dyb = (eb.ymin + eb.ymax) / 2 - cy;
                            return (dxb * dxb + dyb * dyb) - (dxa * dxa + dya * dya);
                        });
                    } else {
                        // Zoom/idle mode: center-first (current behavior).
                        // Closest to center = highest priority.
                        // 缩放/空闲模式：中心优先（现有行为）。
                        // 距中心最近 = 最高优先级。
                        queue.sort((a, b) => {
                            const ea = a.tileInfo && a.tileInfo.extent2d;
                            const eb = b.tileInfo && b.tileInfo.extent2d;
                            if (!ea && !eb) return 0;
                            if (!ea) return 1;
                            if (!eb) return -1;
                            const dxa = (ea.xmin + ea.xmax) / 2 - cx;
                            const dya = (ea.ymin + ea.ymax) / 2 - cy;
                            const dxb = (eb.xmin + eb.xmax) / 2 - cx;
                            const dyb = (eb.ymin + eb.ymax) / 2 - cy;
                            return (dxa * dxa + dya * dya) - (dxb * dxb + dyb * dyb);
                        });
                    }
                }
            }

            /* eslint-disable no-unmodified-loop-condition */
            while (queue.length && (limit <= 0 || count < limit)) {
                const { tileData, tileInfo } = queue.shift();
                if (!this._tileQueueIds.has(tileInfo.id)) {
                    // Tile was aborted after queueing: release its decoded bitmap immediately
                    // 瓦片入队后被中止：立即释放其已解码的位图
                    if (tileData && (tileData as any).close) {
                        (tileData as any).close();
                    }
                    continue;
                }
                this._tileQueueIds.delete(tileInfo.id);
                if (!this.checkTileInQueue(tileData, tileInfo)) {
                    if (tileData && (tileData as any).close) {
                        (tileData as any).close();
                    }
                    continue;
                }
                this.consumeTile(tileData, tileInfo);
                count++;
            }
            /* eslint-enable no-unmodified-loop-condition */
        }

        //@internal
        _computeAvgTileAltitude() {
            let sumMin = 0;
            let sumMax = 0;
            let count = 0;
            for (const p in this.tilesInView) {
                const info = this.tilesInView[p] && this.tilesInView[p].info;
                if (info) {
                    sumMin += info.minAltitude || 0;
                    sumMax += info.maxAltitude || 0;
                    count++;
                }
            }
            this.avgMinAltitude = sumMin / count;
            this.avgMaxAltitude = sumMax / count;
        }

        // Parameters tileImage and tileInfo are required in VectorTileLayerRenderer
        checkTileInQueue(tileImage: Tile['image'], tileInfo: Tile['info']): boolean {
            return true;
        }

        consumeTile(tileImage: Tile['image'], tileInfo: Tile['info']): void {
            if (!this.layer) {
                return;
            }
            if (!this.tilesInView) {
                // removed
                return;
            }
            const e = { tile: tileInfo, tileImage: tileImage };
            // let user update tileImage in listener if needed
            tileImage = e.tileImage;
            this.resetTileLoadTime(tileImage);
            this.removeTileLoading(tileInfo);
            this._addTileToCache(tileInfo, tileImage);
            /**
             * tileload event, fired when tile is loaded.
             *
             * @event TileLayer#tileload
             * @type {Object}
             * @property {String} type - tileload
             * @property {TileLayer} target - tile layer
             * @property {Object} tileInfo - tile info
             * @property {Image} tileImage - tile image
             */
            this.layer.fire('tileload', e);
            this.setToRedraw();
        }

        resetTileLoadTime(tileImage: Tile['image']): void {
            // loadTime = 0 means a tile from onTileError
            if (tileImage.loadTime !== 0) {
                tileImage.loadTime = now();
            }
        }

        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        onTileError(tileImage: Tile['image'], tileInfo: Tile['info'], error?: any) {
            if (!this.layer) {
                return;
            }
            // example:
            /* reloadErrorTileFunction: (layer, renderer, tileInfo, tileImage) => {
                const url = tileInfo.url;
                // check if need to reload, e.g. server return 500 status code temporarily
                if (needReload) {
                renderer.loadTile(tileInfo, tileImage);
                }
            } */
            const reloadErrorTileFunction = this.layer.options['reloadErrorTileFunction'];
            if (reloadErrorTileFunction) {
                reloadErrorTileFunction.call(this, this.layer, this, tileInfo, tileImage);
                return;
            }
            // tileImage.onerrorTick = tileImage.onerrorTick || 0;
            // const tileRetryCount = this.layer.options['tileRetryCount'];
            // if (tileRetryCount > tileImage.onerrorTick) {
            //     tileImage.onerrorTick++;
            //     this._fetchImage(tileImage, tileInfo);
            //     this.removeTileLoading(tileInfo);
            //     return;
            // }
            const errorUrl = this.layer.options['errorUrl'];
            const isFetchError = !(tileImage instanceof Image);
            if (errorUrl) {
                if ((tileImage instanceof Image) && tileImage.src !== errorUrl) {
                    tileImage.src = errorUrl;
                    this.removeTileLoading(tileInfo);
                    return;
                } else {
                    tileImage = new Image() as any;
                    (tileImage as HTMLImageElement).src = errorUrl;
                }
            }
            this.abortTileLoading(tileImage, tileInfo);

            tileImage.loadTime = 0;
            if (isFetchError) {
                tileImage.fetchErrorTime = now();
            }
            this.removeTileLoading(tileInfo);
            this._addTileToCache(tileInfo, tileImage);
            this.setToRedraw();
            /**
             * tileerror event, fired when tile loading has error.
             *
             * @event TileLayer#tileerror
             * @type {Object}
             * @property {String} type - tileerror
             * @property {TileLayer} target - tile layer
             * @property {Object} tileInfo - tile info
             */
            this.layer.fire('tileerror', { tile: tileInfo });
        }

        getDebugInfo(tileId: TileId): string {
            const xyz = tileId.split('_');
            const length = xyz.length;
            return xyz[length - 3] + '/' + xyz[length - 2] + '/' + xyz[length - 1];
        }

        findChildTiles(info: Tile['info']) {
            return this._findChildTiles(info);
        }

        _getReusableBackgroundTile(tileId: TileId) {
            let tile = this.tileCache.getAndRemove(tileId);
            if (!tile && this.tilesInView) {
                tile = this.tilesInView[tileId];
            }
            // During zoom-out, lower-zoom parent tiles are frequently evicted from
            // the LRU cache during zoom-in. Search the zoom snapshot as an additional
            // source to find fallback tiles that can fill coverage gaps.
            if (!tile && this._zoomSnapshotTiles && this._zoomTransitionDirection === -1) {
                tile = this._zoomSnapshotTiles[tileId];
            }
            if (tile && this.isValidCachedTile(tile)) {
                tile.current = true;
                this.tileCache.add(tileId, tile);
                return tile;
            }
            return null;
        }

        //@internal
        _findChildTiles(info: Tile['info']): Tile[] | any {
            const layer = this._getLayerOfTile(info.layer);
            const isPyramidMode = layer._isPyramidMode();
            const terrainTileMode = layer && layer.options['terrainTileMode'] && isPyramidMode;
            if (!layer || !layer.options['background'] && !terrainTileMode || info.z > this.layer.getMaxZoom()) {
                return EMPTY_ARRAY;
            }
            const map = this.map || this.getMap();
            const children = [];
            if (isPyramidMode) {
                if (!terrainTileMode) {
                    // a faster one
                    // const layer = this._getLayerOfTile(info.layer);
                    const zoomDiff = 2;
                    const cx = info.x * 2;
                    const cy = info.y * 2;
                    const cz = info.z + 1;
                    const queue = [];
                    for (let j = 0; j < 2; j++) {
                        for (let jj = 0; jj < 2; jj++) {
                            queue.push(cx + j, cy + jj, cz);
                        }
                    }
                    while (queue.length) {
                        const z = queue.pop();
                        const y = queue.pop();
                        const x = queue.pop();
                        const id = layer._getTileId(x, y, z, info.layer);
                        const canVisit = z + 1 <= info.z + zoomDiff;
                        const tile = this._getReusableBackgroundTile(id);
                        if (tile) {
                            children.push(tile);
                        } else if (canVisit) {
                            for (let j = 0; j < 2; j++) {
                                for (let jj = 0; jj < 2; jj++) {
                                    queue.push(x * 2 + j, y * 2 + jj, z + 1);
                                }
                            }
                        }
                    }
                    return children;
                }
                let missedTiles;
                if (terrainTileMode) {
                    missedTiles = [];
                }
                // const zoomDiff = 2;
                const cx = info.x * 2;
                const cy = info.y * 2;
                const cz = info.z + 1;
                // const queue = [];
                // for the sake of performance, we only traverse next 2 levels of children tiles
                const candidates = [];
                for (let i = 0; i < 2; i++) {
                    for (let ii = 0; ii < 2; ii++) {
                        const x = cx + i;
                        const y = cy + ii;
                        const z = cz;
                        const id = layer._getTileId(x, y, z, info.layer);
                            const tile = this._getReusableBackgroundTile(id);
                            if (tile) {
                            children.push(tile);
                            candidates.push(null);
                        } else {
                            // 缺少offset
                            candidates.push(id);
                        }
                    }
                }

                // children.length等于4时，说明4个一级子瓦片都放入了children中
                if (children.length < 4) {
                    let index = 0;
                    for (let i = 0; i < 2; i++) {
                        for (let ii = 0; ii < 2; ii++) {
                            const id = candidates[index++];
                            if (!id) {
                                continue;
                            }
                            const x = cx + i;
                            const y = cy + ii;
                            const z = cz;
                            const childrenCount = children.length;
                            const childCandidates = [];
                            for (let j = 0; j < 2; j++) {
                                for (let jj = 0; jj < 2; jj++) {
                                    const xx = x * 2 + j;
                                    const yy = y * 2 + jj;
                                    const zz = z + 1;
                                    const id = layer._getTileId(xx, yy, zz, info.layer);
                                    const childTile = this._getReusableBackgroundTile(id);
                                    if (childTile) {
                                        children.push(childTile);
                                        childCandidates.push(null);
                                    } else {
                                        childCandidates.push(id);
                                    }
                                }
                            }
                            if (!terrainTileMode) {
                                continue;
                            }
                            if (children.length - childrenCount < 4) {
                                const childTileInfo = layer.tileInfoCache.get(id) || layer._createChildNode(info, i, ii, [0, 0], id);
                                if (children.length - childrenCount === 0) {
                                    // 四个二级子瓦片都没有被缓存，直接将当前的一级子瓦片tileInfo放入missedTiles
                                    missedTiles.push(childTileInfo);
                                } else {
                                    // 四个二级子瓦片有被缓存的，将没有被缓存的tileInfo加入missedTiles
                                    let index = 0;
                                    for (let j = 0; j < 2; j++) {
                                        for (let jj = 0; jj < 2; jj++) {
                                            const id = childCandidates[index++];
                                            if (!id) {
                                                // 这个二级子瓦片已经被加入到了children
                                                continue;
                                            }
                                            const grandsonTileInfo = this.layer.tileInfoCache.get(id) || layer._createChildNode(childTileInfo, j, jj, [0, 0], id);
                                            missedTiles.push(grandsonTileInfo);
                                        }
                                    }
                                }
                            }

                        }
                    }
                }
                return terrainTileMode ? { tiles: children, missedTiles } : children;
            }
            const zoomDiff = 1;
            const res = info.res;
            const min = info.extent2d.getMin(),
                max = info.extent2d.getMax(),
                pmin = layer._project(map._pointToPrjAtRes(min, res, TEMP_POINT1), TEMP_POINT1),
                pmax = layer._project(map._pointToPrjAtRes(max, res, TEMP_POINT2), TEMP_POINT2);

            for (let i = 1; i < zoomDiff; i++) {
                this._findChildTilesAt(children, pmin, pmax, layer, info.z + i);
            }

            return children;
        }

        //@internal
        _findChildTilesAt(children: Tile[], pmin: number, pmax: number, layer: any, childZoom: number) {
            const sr = layer._spatialRef || layer.getSpatialReference();
            const layerId = layer.getId(),
                res = sr.getResolution(childZoom);
            if (!res) {
                return;
            }
            const getTileConfig = layer._getTileConfig();
            const dmin = getTileConfig.getTileIndex(pmin, res),
                dmax = getTileConfig.getTileIndex(pmax, res);
            const sx = Math.min(dmin.idx, dmax.idx), ex = Math.max(dmin.idx, dmax.idx);
            const sy = Math.min(dmin.idy, dmax.idy), ey = Math.max(dmin.idy, dmax.idy);
            let id, tile;
            for (let i = sx; i < ex; i++) {
                for (let ii = sy; ii < ey; ii++) {
                    id = layer._getTileId(i, ii, childZoom, layerId);
                    tile = this._getReusableBackgroundTile(id);
                    if (tile) {
                        children.push(tile);
                    }
                }
            }
        }

        findParentTile(info: Tile['info'], targetDiff?: number): Tile {
            return this._findParentTile(info, targetDiff);
        }

        //@internal
        _findParentTile(info: Tile['info'], targetDiff?: number): Tile {
            const map = this.map || this.getMap(),
                layer = this._getLayerOfTile(info.layer);
            if (!layer || !layer.options['background'] && !layer.options['terrainTileMode']) {
                return null;
            }
            const minZoom = layer.getMinZoom();
            const zoomDiff: number = targetDiff || info.z - minZoom;
            if (layer._isPyramidMode()) {
                const endZoom = info.z - zoomDiff;
                for (let z = info.z - 1; z >= endZoom; z--) {
                    const diff = info.z - z;
                    const scale = Math.pow(2, diff);
                    const x = Math.floor(info.x / scale);
                    const y = Math.floor(info.y / scale);
                    let id;
                    if (z === info.z - 1) {
                        id = info.parent;
                    } else {
                        id = layer._getTileId(x, y, z, info.layer);
                    }
                    const tile = this._getReusableBackgroundTile(id);
                    if (tile) {
                        return tile;
                    }
                }
                return null;
            }
            const sr = layer.getSpatialReference();
            // const zoomOffset = layer.options['zoomOffset'];
            const d = sr.getZoomDirection();
            const res = info.res;
            const center = info.extent2d.getCenter(),
                prj = layer._project(map._pointToPrjAtRes(center, res));
            for (let diff = 1; diff <= zoomDiff; diff++) {
                const z = info.z - d * diff;
                const res = sr.getResolution(z);
                if (!res) continue;
                const tileIndex = layer._getTileConfig().getTileIndex(prj, res);
                const id = layer._getTileId(tileIndex.x, tileIndex.y, z, info.layer);
                const tile = this._getReusableBackgroundTile(id);
                if (tile) {
                    return tile;
                }
            }
            return null;
        }

        isValidCachedTile(tile: Tile): boolean {
            return !!tile.image;
        }

        //@internal
        _pickDominantZoomTiles(sourceTiles: Tile[]): { tiles: Tile[]; dominantZoom: number | undefined } {
            if (!sourceTiles || !sourceTiles.length) {
                return { tiles: EMPTY_ARRAY, dominantZoom: undefined };
            }
            const zoomGroups = {};
            let dominantZoom = sourceTiles[0] && sourceTiles[0].info ? sourceTiles[0].info.z : undefined;
            let dominantTiles = null;
            for (let i = 0; i < sourceTiles.length; i++) {
                const tile = sourceTiles[i];
                const z = tile && tile.info ? tile.info.z : undefined;
                if (z === undefined) {
                    continue;
                }
                if (!zoomGroups[z]) {
                    zoomGroups[z] = [];
                }
                zoomGroups[z].push(tile);
                if (!dominantTiles || zoomGroups[z].length > dominantTiles.length) {
                    dominantTiles = zoomGroups[z];
                    dominantZoom = z;
                }
            }
            const dominantThreshold = Math.max(4, Math.ceil(sourceTiles.length * 0.45));
            return {
                tiles: dominantTiles && dominantTiles.length >= dominantThreshold ? dominantTiles : sourceTiles,
                dominantZoom
            };
        }

        //@internal
        _updateZoomTransitionDirection(param: any): void {
            if (!param || isNil(param.from) || isNil(param.to)) {
                return;
            }
            if (param.to > param.from) {
                this._zoomTransitionDirection = 1;
            } else if (param.to < param.from) {
                this._zoomTransitionDirection = -1;
            } else {
                this._zoomTransitionDirection = 0;
            }
        }

        //@internal
        _pickDirectionalSnapshotTiles(sourceTiles: Tile[], targetZoom?: number): { tiles: Tile[]; dominantZoom: number | undefined } {
            const dominant = this._pickDominantZoomTiles(sourceTiles);
            const zoomDirection = this._zoomTransitionDirection;
            if (!sourceTiles || !sourceTiles.length || !isNumber(targetZoom) || zoomDirection !== -1) {
                return dominant;
            }
            const zoomGroups = {};
            for (let i = 0; i < sourceTiles.length; i++) {
                const tile = sourceTiles[i];
                const z = tile && tile.info ? tile.info.z : undefined;
                if (!isNumber(z) || z > targetZoom) {
                    continue;
                }
                if (!zoomGroups[z]) {
                    zoomGroups[z] = [];
                }
                zoomGroups[z].push(tile);
            }
            let bestZoom: number | undefined;
            let bestTiles: Tile[] | null = null;
            for (const zKey in zoomGroups) {
                const z = +zKey;
                const tiles = zoomGroups[z];
                if (!tiles || tiles.length < 4) {
                    continue;
                }
                if (!bestTiles) {
                    bestZoom = z;
                    bestTiles = tiles;
                    continue;
                }
                const currentDistance = Math.abs(targetZoom - z);
                const bestDistance = Math.abs(targetZoom - bestZoom);
                if (currentDistance < bestDistance ||
                    (currentDistance === bestDistance && tiles.length > bestTiles.length)) {
                    bestZoom = z;
                    bestTiles = tiles;
                }
            }
            if (!bestTiles) {
                return dominant;
            }
            return {
                tiles: bestTiles,
                dominantZoom: bestZoom
            };
        }

        //@internal
        _captureStableZoomFrameTiles(currentTiles: Tile[], reason: string): void {
            const validCurrentTiles = (currentTiles || []).filter(tile => tile && this.isValidCachedTile(tile));
            if (!validCurrentTiles.length) {
                return;
            }
            let stableSourceTiles = validCurrentTiles;
            if (reason === 'zoom-out-ready-frame' && this._zoomTransitionDirection === -1) {
                let zoomOutTargetZoom = isNumber(this._zoomSnapshotDominantZoom) ? this._zoomSnapshotDominantZoom - 1 : undefined;
                if (!isNumber(zoomOutTargetZoom) && isNumber(this._tileZoom)) {
                    zoomOutTargetZoom = this._tileZoom - 1;
                }
                if (isNumber(zoomOutTargetZoom)) {
                    const directionalStable = this._pickDirectionalSnapshotTiles(validCurrentTiles, zoomOutTargetZoom);
                    if (!directionalStable.tiles.length ||
                        (isNumber(this._zoomSnapshotDominantZoom) &&
                            (!isNumber(directionalStable.dominantZoom) || directionalStable.dominantZoom >= this._zoomSnapshotDominantZoom))) {
                        return;
                    }
                    stableSourceTiles = directionalStable.tiles;
                }
            }
            const stableTiles = stableSourceTiles.slice().sort(this._compareTiles);
            if (this._hasSameTileSet(this._stableZoomFrameTiles, stableTiles)) {
                return;
            }
            this._stableZoomFrameTiles = stableTiles;
        }

        //@internal
        _collectZoomSnapshotTiles(currentTiles?: Tile[], stableTiles?: Tile[]): { tiles: Tile[]; source: string; dominantZoom: number | undefined } {
            const validCurrentTiles = (currentTiles || []).filter(tile => tile && this.isValidCachedTile(tile));
            const validPreviousSnapshotTiles = (this._zoomSnapshotTiles || []).filter(tile => tile && this.isValidCachedTile(tile));
            let validCachedTiles = [];
            if (stableTiles && stableTiles.length) {
                validCachedTiles = stableTiles.filter(tile => tile && this.isValidCachedTile(tile));
            } else if (this.tilesInView) {
                for (const id in this.tilesInView) {
                    const snapshotTile = this.tilesInView[id];
                    if (snapshotTile && this.isValidCachedTile(snapshotTile)) {
                        validCachedTiles.push(snapshotTile);
                    }
                }
            }
            const dominantCurrentRaw = this._pickDominantZoomTiles(validCurrentTiles);
            const map = this.getMap();
            const zoomDirection = this._zoomTransitionDirection;
            let targetZoom = isNumber(this._tileZoom) ? this._tileZoom :
                dominantCurrentRaw && isNumber(dominantCurrentRaw.dominantZoom) ? dominantCurrentRaw.dominantZoom : undefined;
            if (zoomDirection === -1) {
                if (isNumber(this._zoomSnapshotDominantZoom)) {
                    if (!isNumber(targetZoom) || targetZoom >= this._zoomSnapshotDominantZoom) {
                        targetZoom = this._zoomSnapshotDominantZoom - 1;
                    }
                } else if (isNumber(targetZoom)) {
                    targetZoom = targetZoom - 1;
                }
            }
            let dominantCached = this._pickDirectionalSnapshotTiles(validCachedTiles, targetZoom);
            let dominantCurrent = this._pickDirectionalSnapshotTiles(validCurrentTiles, targetZoom);
            const dominantPreviousSnapshot = this._pickDirectionalSnapshotTiles(validPreviousSnapshotTiles, targetZoom);
            if (zoomDirection === -1 && isNumber(this._zoomSnapshotDominantZoom)) {
                if (!isNumber(dominantCached.dominantZoom) || dominantCached.dominantZoom >= this._zoomSnapshotDominantZoom) {
                    dominantCached = { tiles: EMPTY_ARRAY, dominantZoom: undefined };
                }
                if (!isNumber(dominantCurrent.dominantZoom) || dominantCurrent.dominantZoom >= this._zoomSnapshotDominantZoom) {
                    dominantCurrent = { tiles: EMPTY_ARRAY, dominantZoom: undefined };
                }
            }
            const zooming = !!(map && map.isZooming && map.isZooming());
            const tilesLoadingCount = this.tilesLoading ? Object.keys(this.tilesLoading).length : 0;
            const isRasterTileLayer = !((this.layer as any)?.isVectorTileLayer);
            const estimatedTargetTileCount = Math.max(
                dominantCurrent.tiles.length + tilesLoadingCount,
                dominantCurrent.tiles.length,
                dominantCached.tiles.length,
                dominantPreviousSnapshot.tiles.length
            );
            const snapshotRefreshThreshold = Math.max(
                12,
                Math.ceil((estimatedTargetTileCount || dominantCurrent.tiles.length || 1) * (zooming && isRasterTileLayer ? 0.88 : 0.75))
            );
            if (zooming &&
                isRasterTileLayer &&
                dominantPreviousSnapshot.tiles.length &&
                (
                    tilesLoadingCount > 0 ||
                    dominantCurrent.tiles.length < snapshotRefreshThreshold
                )) {
                return {
                    tiles: dominantPreviousSnapshot.tiles.slice().sort(this._compareTiles),
                    source: 'previous-snapshot',
                    dominantZoom: dominantPreviousSnapshot.dominantZoom
                };
            }
            if (dominantCurrent.tiles.length && !dominantCached.tiles.length) {
                if (zooming &&
                    isRasterTileLayer &&
                    dominantCurrent.tiles.length < snapshotRefreshThreshold &&
                    dominantPreviousSnapshot.tiles.length) {
                    return {
                        tiles: dominantPreviousSnapshot.tiles.slice().sort(this._compareTiles),
                        source: 'previous-snapshot',
                        dominantZoom: dominantPreviousSnapshot.dominantZoom
                    };
                }
                return {
                    tiles: dominantCurrent.tiles.slice().sort(this._compareTiles),
                    source: 'current-dominant',
                    dominantZoom: dominantCurrent.dominantZoom
                };
            }
            const currentAdoptThreshold = Math.max(8, Math.ceil(dominantCached.tiles.length * 0.55));
            const zoomAdoptThreshold = Math.max(
                currentAdoptThreshold,
                Math.ceil(dominantCached.tiles.length * (isRasterTileLayer ? 0.92 : 0.8))
            );
            const canAdoptCurrentOnZoom = isRasterTileLayer ?
                (tilesLoadingCount <= 1 ||
                    (tilesLoadingCount <= 2 && dominantCurrent.tiles.length >= zoomAdoptThreshold)) :
                (tilesLoadingCount <= 2 ||
                    (tilesLoadingCount <= 4 && dominantCurrent.tiles.length >= zoomAdoptThreshold));
            if ((!zooming && dominantCurrent.tiles.length >= currentAdoptThreshold) ||
                (zooming && canAdoptCurrentOnZoom && dominantCurrent.tiles.length >= zoomAdoptThreshold)) {
                // zooming 过程中优先保留上一帧稳定底图，只在目标层级已经接近成型时
                // 才允许用 current tiles 刷新 snapshot，避免块状过渡和中途发虚。
                return {
                    tiles: dominantCurrent.tiles.slice().sort(this._compareTiles),
                    source: 'current-dominant',
                    dominantZoom: dominantCurrent.dominantZoom
                };
            }
            return {
                tiles: dominantCached.tiles.length ? dominantCached.tiles.slice().sort(this._compareTiles) : EMPTY_ARRAY,
                source: stableTiles && stableTiles.length ? 'stable-frame' : 'cached-dominant',
                dominantZoom: dominantCached.dominantZoom
            };
        }

        //@internal
        _hasSameTileSet(previousTiles: Tile[] | undefined, nextTiles: Tile[] | undefined): boolean {
            if (previousTiles === nextTiles) {
                return true;
            }
            if (!previousTiles || !nextTiles || previousTiles.length !== nextTiles.length) {
                return false;
            }
            for (let i = 0; i < previousTiles.length; i++) {
                if (!previousTiles[i] || !nextTiles[i] || previousTiles[i].id !== nextTiles[i].id) {
                    return false;
                }
            }
            return true;
        }

        //@internal
        _isTileReservedForZoomSnapshot(tile: Tile): boolean {
            const tileId = tile && tile.info ? tile.info.id : undefined;
            if (!tileId) {
                return false;
            }
            const zoomSnapshotTiles = this._zoomSnapshotTiles;
            if (zoomSnapshotTiles && zoomSnapshotTiles.some(snapshotTile => snapshotTile && snapshotTile.info && snapshotTile.info.id === tileId)) {
                return true;
            }
            const stableZoomFrameTiles = this._stableZoomFrameTiles;
            if (stableZoomFrameTiles && stableZoomFrameTiles.some(snapshotTile => snapshotTile && snapshotTile.info && snapshotTile.info.id === tileId)) {
                return true;
            }
            return false;
        }

        isTileComplete(tile: Tile) {
            return true;
        }

        //@internal
        _getLayerOfTile(layerId: LayerId) {
            return this.layer.getChildLayer ? this.layer.getChildLayer(layerId) : this.layer;
        }

        getCachedTile(tile: Tile, isParent: boolean) {
            const tileId = tile.id;
            const tilesInView = this.tilesInView;
            let cached = this.tileCache.getAndRemove(tileId);
            if (cached) {
                if (!isParent) {
                    tilesInView[tileId] = cached;
                }
                const tilesLoading = this.tilesLoading;
                if (tilesLoading && tilesLoading[tileId]) {
                    this.markCurrent(tilesLoading[tileId], false);
                    const { image, info } = tilesLoading[tileId];
                    this.abortTileLoading(image, info);
                    delete tilesLoading[tileId];
                }
            } else {
                cached = tilesInView[tileId];
            }
            if (cached) {
                cached.current = true;
                if (this.isValidCachedTile(cached)) {
                    this.tileCache.add(tileId, cached);
                }
            }
            return cached;
        }

        //@internal
        _addTileToCache(tileInfo: Tile['info'], tileImage: Tile['image']) {
            if (this.isValidCachedTile({ info: tileInfo, image: tileImage } as Tile)) {
                const cached = {
                    image: tileImage,
                    info: tileInfo
                } as Tile;
                this.tileCache.add(tileInfo.id, cached);
            }
        }

        getTileOpacity(tileImage: Tile['image'], tileInfo: Tile['info']): number {
            let opacity = this.getTileFadingOpacity(tileImage);
            if (this.drawingCurrentTiles && this._progressiveCurrentOpacity !== undefined) {
                opacity *= this._progressiveCurrentOpacity;
            } else if ((this.drawingChildTiles || this.drawingParentTiles) && this._backgroundTileOpacity !== undefined) {
                opacity *= this._backgroundTileOpacity;
            }
            if (this.layer.getChildLayer) {
                // in GroupTileLayer
                const childLayer = this.layer.getLayer(tileInfo.layer);
                if (childLayer) {
                    opacity *= childLayer.options['opacity'];
                }
            }
            return opacity;
        }

        getTileFadingOpacity(tileImage: Tile['image']): number {
            if (!this.layer.options['fadeAnimation'] || !tileImage.loadTime) {
                return 1;
            }
            const map = this.getMap();
            const nowTime = now();
            // 交互期间直接显示目标瓦片，避免缩放放大时出现明显的"扩散式"淡入。
            if (map && map.isInteracting && map.isInteracting()) {
                this._interactingTimestamp = nowTime;
                return 1;
            }
            // P0: 矢量瓦片缩放结束宽限期（onZoomEnd 后 500ms+）内保持全不透。
            // isInteracting 变 false 后，若新层级瓦片 loadTime 落在淡入期，fade 计算
            // 会把已显示的瓦片打回半透明，视觉上表现为"瓦片出现后闪一下就变淡/消失"。
            // 宽限期内保持 opacity=1，直到新层级瓦片稳定后再恢复淡入计算。
            if (this._vtZoomEndGraceUntil && nowTime < this._vtZoomEndGraceUntil) {
                this._interactingTimestamp = nowTime;
                return 1;
            }
            // 交互刚结束时，在交互期间已显示的瓦片继续保持全不透，
            // 避免因 loadTime 尚在淡入期内导致的"全不透→半透明→全不透"闪烁跳变。
            const { _interactingTimestamp, layer: { options: { fadeDuration } } } = this;
            if (_interactingTimestamp && tileImage.loadTime <= _interactingTimestamp) {
                if (nowTime - _interactingTimestamp < (fadeDuration || 167)) {
                    return 1;
                }
            }
            return Math.min(1, (nowTime - tileImage.loadTime) / (fadeDuration || 167));
        }

        clearTileCaches(): void {
            this.version++;
            this.retireTiles(true);
            this.tileCache.reset();
            this.tilesInView = {};
            this.tilesLoading = {};
            delete this._zoomSnapshotTiles;
            delete this._zoomSnapshotDominantZoom;
            delete this._stableZoomFrameTiles;
            delete this._vtZoomEndGraceUntil;
            delete this._vtZoomEndGraceStart;
            this._tileQueue = [];
            this._tileQueueIds.clear();
            this._parentTiles = [];
            this._childTiles = [];
        }

        removeTileCaches() {
            delete this.tileCache;
            delete this._tilePlaceHolder;
            delete this._tileZoom;
            delete this._zoomSnapshotTiles;
            delete this._zoomSnapshotDominantZoom;
            delete this._stableZoomFrameTiles;
            delete this._vtZoomEndGraceUntil;
            delete this._vtZoomEndGraceStart;
        }

        markCurrent(tile: Tile, isCurrent?: boolean): void {
            tile.current = isCurrent;
        }

        markTiles(): number[] {
            let a = 0, b = 0;
            if (this.tilesLoading) {
                for (const p in this.tilesLoading) {
                    this.markCurrent(this.tilesLoading[p], false);
                    a++;
                }
            }
            if (this.tilesInView) {
                for (const p in this.tilesInView) {
                    this.markCurrent(this.tilesInView[p], false);
                    b++;
                }
            }
            return [a, b];
        }

        // --- interaction frame cache helpers ---
        // During pan/zoom, camera moves by sub-pixel increments each frame.
        // Running the expensive getTiles() tree traversal (quadtree + frustum + SSE)
        // at 60fps is the #1 CPU bottleneck. We cache across frames with a
        // view-change threshold, only recomputing when the camera has moved meaningfully.

        retireTiles(force?: boolean): void {
            const map = this.getMap();
            const isVectorTileLayer = !!(this.layer as any).isVectorTileLayer;
            const isRasterTileLayer = !isVectorTileLayer;
            const preserveLoadingOnRasterZooming = !force && isRasterTileLayer && map && map.isZooming && map.isZooming();
            const preserveSnapshotTilesOnRasterZooming = !force && isRasterTileLayer && (
                (this._zoomSnapshotTiles && this._zoomSnapshotTiles.length) ||
                (this._stableZoomFrameTiles && this._stableZoomFrameTiles.length)
            );
            const preserveLoadingOnVectorZooming = !force && isVectorTileLayer && map && map.isZooming && map.isZooming();
            // P0: After zoom ends, keep stale vector tiles in tilesInView for a short
            // grace period (500ms) so the layer doesn't go blank while new-zoom tiles
            // are still loading. Without this, "出图后消失" (tiles appear then disappear)
            // occurs because retireTiles removes old tiles immediately after onZoomEnd.
            // Dynamic extension: if the initial 500ms grace window expires while tiles
            // are STILL loading (high zoom loads can take seconds), extend the window
            // so stale tiles keep acting as background until the new-zoom tiles arrive
            // (hard cap at 3.5s after the original grace start to bound memory).
            const _graceNow = now();
            if (!force && isVectorTileLayer && this._vtZoomEndGraceUntil && _graceNow >= this._vtZoomEndGraceUntil) {
                // 硬上限 600ms，与 _consumeTileQueue 保持一致。
                // P0 修复：目标 zoom 与旧瓦片差距 >= VT_STALE_ZOOM_GAP_MAX 时
                // （服务该层级无数据），旧瓦片无保留价值，直接退出宽限期。
                const graceStart = this._vtZoomEndGraceStart || this._vtZoomEndGraceUntil;
                if (this._vtStaleZoomGapTooLarge()) {
                    delete this._vtZoomEndGraceUntil;
                    delete this._vtZoomEndGraceStart;
                } else if (this.tilesLoading && Object.keys(this.tilesLoading).length && (_graceNow - graceStart) < 600) {
                    this._vtZoomEndGraceUntil = _graceNow + 200;
                } else {
                    delete this._vtZoomEndGraceUntil;
                }
            }
            const inVectorZoomGracePeriod = !force && isVectorTileLayer &&
                !!(this._vtZoomEndGraceUntil) && now() < this._vtZoomEndGraceUntil;
            const preserveStaleInViewOnVectorZooming = !force && isVectorTileLayer && (map && map.isZooming && map.isZooming() || inVectorZoomGracePeriod);
        // During interaction (pan/zoom/rotate), retain loading
        // requests for tiles that are no longer in the current viewport so
        // they can serve as cached fallback when the camera moves back.
        // During raster zooming, also preserve non-current tiles in tilesInView
        // so old tiles act as a stable background while target-level tiles load,
        // preventing the white flash when zooming fast. Only abort when force=true
        // (layer removal etc).
        const preserveNonCurrentOnInteracting = !force && isRasterTileLayer && map && map.isInteracting && map.isInteracting();
            // During zoom-out, lower-zoom parent tiles often need to be fetched from
            // network because they've been evicted from the LRU cache during zoom-in.
            // Keep non-current tiles with valid images in tilesInView so they can
            // serve as scaled-down background while new tiles load, eliminating the
            // white/blank flash during zoom-out transitions.
            const preserveNonCurrentOnZoomOut = !force && isRasterTileLayer &&
                map && map.isZooming && map.isZooming() &&
                this._zoomTransitionDirection === -1;
            for (const i in this.tilesLoading) {
                const tile = this.tilesLoading[i];
                if (preserveLoadingOnRasterZooming) {
                    // 对 raster 底图的缩放阶段，尽量不要打断已发出的目标层级请求。
                    // 目标层级继续后台加载，由独立 snapshot 托底承接显示。
                    continue;
                }
                if (preserveLoadingOnVectorZooming) {
                    // 对 VT 图层，缩放期间优先保留已发出的加载请求，
                    // 避免反复 abort/reload 造成的叠加闪动和无效开销。
                    continue;
                }
                if (preserveNonCurrentOnInteracting && !tile.current) {
                    // 对 raster 底图，在交互期间尽量保留已发出的瓦片请求。
                    // 这样缩放/平移时不会频繁 abort 后再重发，底图过渡会更稳定。
                    continue;
                }
                if (preserveNonCurrentOnZoomOut && !tile.current) {
                    // 缩小过程中保留已发出的加载请求，避免 abort 后重发造成延迟。
                    continue;
                }
                if (force || !tile.current) {
                    // abort loading tiles
                    if (tile.image) {
                        this.abortTileLoading(tile.image, tile.info);
                    }
                    this.deleteTile(tile);
                    this.removeTileLoading(tile.info);
                }
            }
            for (const i in this.tilesInView) {
                const tile = this.tilesInView[i];
                if (preserveSnapshotTilesOnRasterZooming && this._isTileReservedForZoomSnapshot(tile)) {
                    // 独立 snapshot 已经单独记录了稳定底图，只保留这部分必要旧瓦片，
                    // 避免 tilesInView 在连续缩放时无限堆高，拖出块状过渡。
                    continue;
                }
                if (preserveStaleInViewOnVectorZooming && !tile.current) {
                    // 对 VT 图层，在缩放期间保留上一批仍可见的旧瓦片，
                    // 避免图层在目标层级尚未成形时直接掉成空层。
                    // P0 修复：目标 zoom 与旧瓦片 z 差距 >= VT_STALE_ZOOM_GAP_MAX
                    // （如 z16 -> z12，服务 z<=14 无数据）时，目标层级无同源数据
                    // 可加载，保留只会造成"旧要素暂留"，不保留，直接走删除分支。
                    const staleZ = tile.info && tile.info.z;
                    const retireTargetZoom = isNumber(this._tileZoom) ? this._tileZoom :
                        (map && map.getZoom ? map.getZoom() : 0);
                    if (isNumber(staleZ) && isNumber(retireTargetZoom) &&
                        Math.abs(staleZ - retireTargetZoom) >= VT_STALE_ZOOM_GAP_MAX) {
                        // 差距过大，不保留（落入下方 force || !current 删除分支）
                    } else {
                        continue;
                    }
                }
                if (preserveNonCurrentOnZoomOut && !tile.current) {
                    // 缩小过程中保留已加载的旧瓦片，它们可以作为缩小后的临时背景，
                    // 避免目标层级新瓦片未加载完成时出现白底。
                    continue;
                }
                if (preserveNonCurrentOnInteracting && !tile.current) {
                    // 交互期间保留旧层可见瓦片，给 zoom snapshot / stale background 更多稳定素材。
                    continue;
                }
                if (force || !tile.current) {
                    delete this.tilesInView[i];
                    if (!this.tileCache.has(i)) {
                        this.deleteTile(tile);
                    }
                }
            }
        }

        // P0 修复辅助：VT 缩放/宽限期间，目标 zoom 与 tilesInView 中保留的
        // 非 current 旧瓦片 zoom 差距是否全部 >= VT_STALE_ZOOM_GAP_MAX。
        // 差距足够大（如 z16 旧瓦片 vs 目标 z12，服务 z<=14 无数据）时，
        // 旧瓦片放大作背景无意义且造成"旧要素暂留"，应提前终止宽限期，
        // 使 retireTiles 正常清理旧瓦片。
        //@internal
        _vtStaleZoomGapTooLarge(): boolean {
            const map = this.map || this.getMap();
            const targetZoom = isNumber(this._tileZoom) ? this._tileZoom :
                (map && map.getZoom ? map.getZoom() : 0);
            if (!isNumber(targetZoom) || !this.tilesInView) {
                return false;
            }
            for (const i in this.tilesInView) {
                const tile = this.tilesInView[i];
                if (!tile || tile.current) {
                    continue;
                }
                const z = tile.info && tile.info.z;
                if (!isNumber(z)) {
                    continue;
                }
                if (Math.abs(z - targetZoom) < VT_STALE_ZOOM_GAP_MAX) {
                    // 仍有差距较小的旧瓦片，宽限期保留它们仍有意义。
                    return false;
                }
            }
            // 无值得保留的旧瓦片（或全部差距过大），宽限期应终止。
            return true;
        }

        deleteTile(tile: Tile): void {
            if (!tile || !tile.image) {
                return;
            }
            // P0 根本性修复：LRU 内存驱逐（onRemove = deleteTile）不得销毁当前正在显示的瓦片。
            // 高 zoom(15+) VT 瓦片单片 _memSize 4-8MB，视口 40-60+ 片远超 256MB 内存预算，
            // 缩放停止后新 zoom 瓦片批量 add 进 tileCache，内存超过 maxMemory*1.1 触发
            // shrink() 从 LRU 最旧端批量逐出——若命中 tilesInView 中已显示的瓦片，
            // deleteTile 销毁其 image/buffers/GL 资源，下一帧 getCachedTile 取不到，
            // 表现为"瓦片一闪就消失"。
            // 这里对 tilesInView 中 current=true 的瓦片跳过资源销毁：LRU 引用已移除、
            // 内存计数已下降，瓦片对象仍被 tilesInView 持有，下一帧 getCachedTile
            // 会从 tilesInView 找回并重新 add 回 cache 继续显示；待其退出视口
            // （current 变 false）后由 retireTiles 正常清理销毁，形成闭环。
            const tileId = tile.info && tile.info.id;
            if (tileId != null && this.tilesInView && (this.tilesInView as any)[tileId] === tile && (tile as any).current) {
                return;
            }
            if (this._tileQueueIds.has(tileId)) {
                this._tileQueueIds.delete(tileId);
            }
            const tileImage = tile.image;
            if ((tileImage as any).close) {
                (tileImage as any).close();
            }
            if (tileImage instanceof Image) {
                tileImage.onload = null;
                tileImage.onerror = null;
                tileImage.src = emptyImageUrl;
            }
            // Release object URLs created from blob/arraybuffer image sources
            if ((tileImage as any).src && isString((tileImage as any).src) && (tileImage as any).src.indexOf('blob:') === 0) {
                URL.revokeObjectURL((tileImage as any).src);
            }
            const layer = this.layer;
            if (layer) {
                /**
                 * tiledelete event, fired when tile is delete.
                 *
                 * @event TileLayer#tiledelete
                 * @type {Object}
                 * @property {String} type - tiledelete
                 * @property {TileLayer} target - tile layer
                 * @property {Object} tileInfo - tile info
                 * @property {Image} tileImage - tile image
                 */
                layer.fire('tiledelete', { tile: tile.info, tileImage: tile.image });
            }
            // Drop the image reference so the closed ImageBitmap/Image can be GC'd.
            // Without this, tiles retained in snapshot arrays or other references keep
            // the native image memory alive longer than necessary.
            tile.image = null;
        }

        //@internal
        _generatePlaceHolder(res: number): HTMLCanvasElement {
            const map = this.map || this.getMap();
            const placeholder = this.layer.options['placeholder'];
            if (!placeholder || map.getPitch()) {
                return null;
            }
            const tileSize = this.layer.getTileSize();
            const scale = res / map._getResolution();
            const canvas = this._tilePlaceHolder = this._tilePlaceHolder || Canvas.createCanvas(1, 1, map.CanvasClass);
            canvas.width = tileSize.width * scale;
            canvas.height = tileSize.height * scale;
            if (isFunction(placeholder)) {
                placeholder(canvas);
            } else {
                defaultPlaceholder(canvas);
            }
            return canvas;
        }

        setTerrainHelper(helper: TerrainHelper) {
            this._terrainHelper = helper;
        }

        _validateTileImage(image) {
            if (!image) {
                return;
            }
            if (image.fetchErrorTime) {
                return false;
            }
            return true;
        }
    }
    return renderable;
}

export default TileLayerRenderable;

function falseFn(): boolean { return false; }

function defaultPlaceholder(canvas: HTMLCanvasElement): void {
    const ctx = canvas.getContext('2d'),
        cw = canvas.width, ch = canvas.height,
        w = cw / 16, h = ch / 16;
    ctx.beginPath();
    for (let i = 0; i < 16; i++) {
        ctx.moveTo(0, i * h);
        ctx.lineTo(cw, i * h);
        ctx.moveTo(i * w, 0);
        ctx.lineTo(i * w, ch);
    }
    ctx.strokeStyle = 'rgba(180, 180, 180, 0.1)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.beginPath();
    const path = [
        [0, 0], [cw, 0], [0, ch], [cw, ch], [0, 0], [0, ch], [cw, 0], [cw, ch], [0, ch / 2], [cw, ch / 2], [cw / 2, 0], [cw / 2, ch]
    ];
    for (let i = 1; i < path.length; i += 2) {
        ctx.moveTo(path[i - 1][0], path[i - 1][1]);
        ctx.lineTo(path[i][0], path[i][1]);
    }
    ctx.lineWidth = 1 * 4;
    ctx.stroke();
}

function compareTiles(a: Tile, b: Tile): number {
    return Math.abs(this._tileZoom - a.info.z) - Math.abs(this._tileZoom - b.info.z);
}

export type TileId = string;
export type LayerId = string | number;
export type TerrainHelper = any;
export type TileImage = (HTMLImageElement | HTMLCanvasElement | ImageBitmap) & {
    loadTime: number;
    fetchErrorTime: number;
    glBuffer?: TileImageBuffer;
    texture?: TileImageTexture;
    // onerrorTick?: number;
}

export interface Tile {
    id: TileId;
    info: {
        x: number;
        y: number;
        z: number;
        idx: number;
        idy: number;
        id: TileId;
        layer: number | string;
        children: [];
        error: number;
        offset: [number, number];
        extent2d: Extent;
        res: number;
        url: string;
        parent: any;
        cache?: boolean;
        // todo：检查是否存在定义
        minAltitude?: number;
        maxAltitude?: number;
        //@internal
        _glScale: number;
        layerAltitude?: number;
        layerAlt?: number;
    };

    image: TileImage;
    current?: boolean;
}

export type RenderContext = any;

export type TilesInViewType = {
    [key: string]: Tile;
}

export interface TileGrid {
    extent: Extent;
    count: number;
    tiles: Tile[];
    parents: any[];
    offset: number[];
    zoom: number;
}

export interface TileGrids {
    count: number;
    tileGrids: TileGrid[];
}
