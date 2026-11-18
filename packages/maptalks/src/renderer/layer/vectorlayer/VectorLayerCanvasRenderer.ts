/* eslint-disable @typescript-eslint/ban-types */
import { getExternalResources, now, getPointsResultPts, type Vector3, isNil } from '../../../core/util';
import VectorLayer from '../../../layer/VectorLayer';
import { OverlayLayerCanvasRenderer } from './OverlayLayerCanvasRenderer';
import Extent from '../../../geo/Extent';
import PointExtent from '../../../geo/PointExtent';
import * as vec3 from '../../../core/util/vec3';
import Canvas from '../../../core/Canvas';
import type { Painter, CollectionPainter } from '../../geometry';
import { Point } from '../../../geo';
import { Geometries, Marker } from '../../../geometry';
import type { WithUndef } from '../../../types/typings';

const TEMP_EXTENT = new PointExtent();
const TEMP_VEC3: Vector3 = [] as unknown as Vector3;
const TEMP_FIXEDEXTENT = new PointExtent();
const PLACEMENT_CENTER = 'center';

function clearCanvas(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
    if (!canvas) {
        return null;
    }
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    return ctx;
}

function isDebug(layer: any) {
    return layer && layer.options.progressiveRender && layer.options.progressiveRenderDebug;
}

/**
 * 基于 `HTML5 Canvas2D` 的渲染器类，用于矢量层
 *
 * @english
 * Renderer class based on HTML5 Canvas2D for VectorLayers
 * @protected
 * @group renderer
 * @name VectorLayerCanvasRenderer
 * @extends renderer.OverlaylayerCanvasRenderer
 * @param layer - layer to render
 */
class VectorLayerRenderer extends OverlayLayerCanvasRenderer {
    //@internal
    _lastRenderTime: number;
    //@internal
    _lastCollisionTime: number;
    //@internal
    _imageData: ImageData;
    //@internal
    _geosToDraw: Geometries[];
    //@internal
    _lastGeosToDraw: Geometries[];
    //@internal
    _hasPoint: boolean;
    //@internal
    _onlyHasPoint: WithUndef<boolean>;
    //@internal
    _displayExtent: Extent;
    //@internal
    _drawnRes: number;
    //@internal
    _progressiveBgTransform?: { scale: number; dx: number; dy: number };

    renderEnd: boolean;
    pageGeos: Geometries[];
    page: number;
    maxTolerance: number;
    geoPainterList: (Painter | CollectionPainter)[];
    snapshotCanvas: HTMLCanvasElement;

    setToRedraw(): this {
        super.setToRedraw();
        //总是重置渐进分页状态：每帧仅绘制 progressiveRenderCount 个几何，避免视图变化后一次同步全量
        //绘制大数据量几何导致的单帧卡顿；若渐进已完成（renderEnd=true）且刚结束 zoom/pan，
        //_resetProgressiveRender 会把旧完整画面按视图变换（缩放/平移）作为渐进首帧背景，
        //画面无缝过渡，不会出现"重新绘制过程"从空白逐页出现的闪烁
        //注意：仅在 layer 真正开启 progressiveRender 时才重置分页状态。
        //未开启时（例如 Geometry.RemoveHide 等常规测试）若调用 _resetProgressiveRender，
        //会在 layerload 监听尚未就位时清空 pageGeos/geoPainterList，并可能因
        //_useCanvasAsProgressiveBg 拷贝旧画面导致测试断言失败。
        if (this.isProgressiveRender()) {
            this._resetProgressiveRender();
        }
        return this;
    }


    //@internal
    _geoIsCollision(geo: GeoType, collisionIndex: any) {
        if (!geo) {
            return false;
        }
        const collision = geo.options.collision;
        if (!collision) {
            return false;
        }
        // const type = geo.getType();
        if (geo.isPoint && geo.getContainerExtent) {
            if (!geo.bbox) {
                geo.bbox = [0, 0, 0, 0];
            }
            const bufferSize = this.layer.options['collisionBufferSize'];
            const extent = geo.getContainerExtent();
            if (!extent) {
                return false;
            }
            geo.bbox[0] = extent.xmin - bufferSize;
            geo.bbox[1] = extent.ymin - bufferSize;
            geo.bbox[2] = extent.xmax + bufferSize;
            geo.bbox[3] = extent.ymax + bufferSize;
            if (collisionIndex.collides(geo.bbox)) {
                geo._collided = true;
                return true;
            }
            collisionIndex.insertBox(geo.bbox);
        }
        return false;
    }

    getImageData(): ImageData {
        //如果不开启geometry event 或者 渲染频率很高 不要取缓存了，因为getImageData是个很昂贵的操作
        if ((!this._lastRenderTime) || (now() - this._lastRenderTime) < 32) {
            return null;
        }
        if (!this.context || !this.context.canvas) {
            return null;
        }
        if (!this._imageData) {
            const { width, height } = this.context.canvas;
            try {
                const ctx = this.screenshotRenderResult(0, 0, width, height);
                if (ctx) {
                    this._imageData = ctx.getImageData(0, 0, width, height);
                }
            } catch (error) {
                console.warn('hit detect failed with tainted canvas, some geometries have external resources in another domain:\n', error);
            }
        }
        return this._imageData;
    }

    clearImageData(): void {
        //每次渲染完成清除缓存的imageData
        this._imageData = null;
        delete this._imageData;
        this._lastRenderTime = now();
    }

    checkResources(...args: any[]) {
        const resources = super.checkResources.apply(this, args);
        let style = this.layer.getStyle();
        if (style) {
            if (!Array.isArray(style)) {
                style = [style];
            }
            style.forEach(s => {
                const res = getExternalResources(s['symbol'], true);
                for (let i = 0, l = res.length; i < l; i++) {
                    if (!this.resources.isResourceLoaded(res[i])) {
                        resources.push(res[i]);
                    }
                }
            });
        }
        return resources;
    }

    needToRedraw(): boolean {
        if (this.isProgressiveRender() && !this.renderEnd) {
            return true;
        }
        const map = this.getMap();
        if (map.isInteracting() && this.layer.options['enableAltitude']) {
            return true;
        }
        // don't redraw when map is zooming without pitch and layer doesn't have any point symbolizer.
        if (map.isZooming() && !map.isRotating() && !map.getPitch() && this.layer.constructor === VectorLayer) {
            if (this.isProgressiveRender()) {
                //progressive 首屏已完成：zoom 走矩阵变换（MapCanvasRenderer 用 _zoomMatrix 变换图层画布），
                //避免交互帧重绘导致的逐页闪烁或全量重绘卡顿；zoom 结束后 view 变化会触发一次全量 render 重绘
                if (this.renderEnd) {
                    return false;
                }
            } else if (!this._hasPoint) {
                return false;
            }
        }
        return super.needToRedraw();
    }

    /**
     * render layer
     */
    draw(): void {
        if (!this.getMap()) {
            return;
        }
        if (!this.layer.isVisible() || this.layer.isEmpty()) {
            this.clearCanvas();
            this.completeRender();
            return;
        }

        this.prepareCanvas();

        this.drawGeos();

        this.completeRender();
    }

    isBlank(): boolean {
        if (!this.context) {
            return false;
        }
        if (this.isProgressiveRender()) {
            return false;
        }
        return !(this.context.canvas as any)._drawn;
    }

    drawOnInteracting() {
        if (!this._geosToDraw) {
            return;
        }
        const drawStart = now();
        this._updateMapStateCache();
        this._updateDisplayExtent();
        const map = this.getMap();
        //refresh geometries on zooming
        const count = this.layer.getCount();
        const res = this.rendererStateCache.resolution;
        if (map.isZooming() &&
            map.options['seamlessZoom'] && this._drawnRes !== undefined && res > this._drawnRes * 1.5 &&
            this._geosToDraw.length < count || map.isMoving() || map.isInteracting()) {
            this.prepareToDraw();
            this._batchConversionMarkers(this.rendererStateCache.glRes);
            if (!this._onlyHasPoint) {
                this._checkGeos();
            }
            this._batchConversionLines(this.rendererStateCache.glRes);
            this._drawnRes = res;
        }
        this._sortByDistanceToCamera(map.cameraPosition);
        const { collision, collisionDelay } = this.layer.options;
        if (collision) {
            const time = now();
            if (!this._lastCollisionTime) {
                this._lastCollisionTime = time;
            }
            if (time - this._lastCollisionTime <= collisionDelay) {
                this._geosToDraw = this._lastGeosToDraw || this._geosToDraw;
            } else {
                this._collidesGeos();
                this._lastCollisionTime = time;
            }
        }

        for (let i = 0, l = this._geosToDraw.length; i < l; i++) {
            const geo = this._geosToDraw[i];
            if (!geo._isCheck) {
                if (!geo.isVisible()) {
                    delete geo._cPoint;
                    delete geo._inCurrentView;
                    continue;
                }
            }
            geo._paint(this._displayExtent);
            // https://richardartoul.github.io/jekyll/update/2015/04/26/hidden-classes.html
            // https://juejin.cn/post/6972702293636415519
            this._geosToDraw[i]._cPoint = undefined;
            this._geosToDraw[i]._inCurrentView = undefined;
        }
        this.clearImageData();
        this._lastGeosToDraw = this._geosToDraw;
        if (isDebug(this.layer)) {
            console.log('progressiveRender on drawOnInteracting page:', this.page);
        }
        //如实上报本次交互帧的绘制耗时：交互路径不走 _tryToDraw/_drawAndRecord，_drawTime 会一直停留在旧值，
        //使 MapCanvasRenderer 的 fpsOnInteracting 帧预算判断（inTime）恒为真，导致每帧都执行全量重绘、帧率崩溃。
        //更新后，全量绘制开销大时下一帧会自动切换为矩阵变换路径，画面完整且交互流畅。
        this._drawTime = now() - drawStart;
    }

    /**
     * Show and render
     * @override
     */
    show(...args: any[]) {
        this.layer.forEach(function (geo) {
            geo._repaint();
        });
        super.show.apply(this, args);
    }

    forEachGeo(fn: Function, context?: any) {
        this.layer.forEach(fn, context);
    }

    //@internal
    _checkGeos() {
        const geos = this.getCurrentNeedRenderGeos();
        for (let i = 0, len = geos.length; i < len; i++) {
            this.checkGeo(geos[i]);
        }
        return this;
    }

    drawGeos() {
        //渐进分页绘制：每帧仅绘制 progressiveRenderCount 个几何，保证大数据量下的每帧耗时可控。
        //zoom/pan 结束后 setToRedraw 会重置分页状态，并以旧完整画面（经视图变换）为首帧背景，
        //画面无缝过渡，既不卡顿也不闪烁
        this._drawSnapshot();
        this._updateMapStateCache();
        this._drawnRes = this.rendererStateCache.resolution;
        this._updateDisplayExtent();
        this.prepareToDraw();
        this._batchConversionMarkers(this.rendererStateCache.glRes);
        if (!this._onlyHasPoint) {
            this._checkGeos();
        }
        this._batchConversionLines(this.rendererStateCache.glRes);
        this._sortByDistanceToCamera(this.getMap().cameraPosition);
        this._collidesGeos();
        for (let i = 0, len = this._geosToDraw.length; i < len; i++) {
            this._geosToDraw[i]._paint();
            this._geosToDraw[i]._cPoint = undefined;
            this._geosToDraw[i]._inCurrentView = undefined;
        }
        this.clearImageData();
        this._lastGeosToDraw = this._geosToDraw;
        if (isDebug(this.layer)) {
            console.log('progressiveRender drawGeos page:', this.page);
        }
        this._snapshot();
        this._setDrawGeosDrawTime();
    }

    prepareToDraw() {
        this.layer._drawTime = now();
        this._hasPoint = false;
        this._geosToDraw = [];
        return this;
    }

    //@internal
    _setDrawGeosDrawTime() {
        const time = now();
        const drawTime = this.layer._drawTime;
        const painterList = this.getGeoPainterList();
        for (let i = 0, len = painterList.length; i < len; i++) {
            const painter = painterList[i];
            if (painter && painter._setDrawTime) {
                painter._setDrawTime(drawTime);
            }
        }
        if (isDebug(this.layer)) {
            console.log('_setDrawGeosDrawTime time:', (now() - time) + 'ms');
        }
        return this;
    }

    checkGeo(geo: Geometries) {
        //点的话已经在批量处理里判断过了
        if (geo.isPoint && this._onlyHasPoint !== undefined) {
            if (geo._inCurrentView || geo.hasAltitude()) {
                this._hasPoint = true;
                geo._isCheck = true;
                this._geosToDraw.push(geo);
            }
            return;
        }
        // LineString ,Polygon,Circle etc
        geo._isCheck = false;
        if (!geo || !geo.isVisible() || !geo.getMap() ||
            !geo.getLayer() || (!geo.getLayer().isCanvasRender())) {
            return;
        }

        const painter = geo._getPainter();
        if (!painter) {
            return;
        }
        let inCurrentView = true;
        if (geo._inCurrentView || !isNil(geo.options.arcDegree) || geo.hasAltitude()) {
            inCurrentView = true;
        } else if (geo._inCurrentView === false) {
            inCurrentView = false;
        } else {
            const extent2D = painter.get2DExtent(this.resources, TEMP_EXTENT);
            if (!extent2D || !extent2D.intersects(this._displayExtent)) {
                inCurrentView = false;
            }
        }
        if (!inCurrentView) {
            return;
        }
        if (painter.hasPoint()) {
            this._hasPoint = true;
        }
        geo._isCheck = true;
        this._geosToDraw.push(geo);
    }

    //@internal
    _collidesGeos() {
        const geos = this._geosToDraw;
        const collision = this.layer.options['collision'];
        if (!collision) {
            //reset points _collided
            for (let i = 0, len = geos.length; i < len; i++) {
                const geo = geos[i];
                if (geo.isPoint) {
                    (geo as Marker)._collided = false;
                }
            }
            return this;
        }
        const collisionScope = this.layer.options['collisionScope'];
        const collisionIndex = this.layer.getCollisionIndex();
        if (collisionScope === 'layer') {
            collisionIndex.clear();
        }
        this._geosToDraw = [];
        for (let i = 0, len = geos.length; i < len; i++) {
            const geo = geos[i];
            if (geo.isPoint) {
                (geo as Marker)._collided = false;
                if (this._geoIsCollision(geo, collisionIndex)) {
                    (geo as Marker)._collided = true;
                    continue;
                }
            }
            this._geosToDraw.push(geos[i]);
        }
        return this;
    }

    onZoomEnd(...args: any[]) {
        delete this.canvasExtent2D;
        //记录 zoom 结束时的视图变换，渐进重绘以旧画面缩放为背景，画面无缝过渡
        const t = this._calcProgressiveBgTransform();
        if (t) {
            this._progressiveBgTransform = t;
        }
        super.onZoomEnd.apply(this, args);
    }

    onMoveEnd(...args: any[]) {
        //记录 pan 结束时的视图变换，渐进重绘以旧画面平移为背景，画面无缝过渡
        const t = this._calcProgressiveBgTransform();
        if (t) {
            this._progressiveBgTransform = t;
        }
        super.onMoveEnd.apply(this, args);
    }

    onRemove() {
        this.forEachGeo(function (g) {
            g.onHide();
        });
        delete this._geosToDraw;
        delete this.snapshotCanvas;
        delete this.pageGeos;
        delete this.geoPainterList;
    }

    onGeometryPropertiesChange(param: any) {
        if (param) {
            this.layer._styleGeometry(param['target']);
        }
        super.onGeometryPropertiesChange(param);
    }

    //@internal
    _updateDisplayExtent() {
        let extent2D = this.canvasExtent2D;
        if (this._maskExtent) {
            if (!this._maskExtent.intersects(extent2D)) {
                this.completeRender();
                return;
            }
            extent2D = extent2D.intersection(this._maskExtent);
        }
        this._displayExtent = extent2D;
    }

    identifyAtPoint(point: Point, options = {}) {
        const geometries = this.getGeosForIdentify();
        if (!geometries) {
            return [];
        }
        return this.layer._hitGeos(geometries, point, options);
    }

    //@internal
    _updateMapStateCache() {
        const map = this.getMap();
        const offset = map._pointToContainerPoint(this.middleWest)._add(0, -map.height / 2);
        const resolution = map.getResolution();
        const pitch = map.getPitch();
        const bearing = map.getBearing();
        const glScale = map.getGLScale();
        const glRes = map.getGLRes();
        const containerExtent = map.getGroundExtent();
        const _2DExtent = map.get2DExtent();
        const glExtent = map.get2DExtentAtRes(glRes);
        this.rendererStateCache = {
            resolution,
            pitch,
            bearing,
            glScale,
            glRes,
            //@internal
            _2DExtent,
            glExtent,
            containerExtent,
            offset
        };
        return this;
    }

    /**
     * 使用批量坐标转换提升性能
     * 优化前 11fps
     * 优化后 15fps
     * Better performance of batch coordinate conversion
     * @param glRes
     */
    //@internal
    _batchConversionMarkers(glRes: number) {
        this._onlyHasPoint = undefined;
        if (!this._constructorIsThis()) {
            return [];
        }
        const cPoints = [];
        const markers = [];
        const altitudes = [];
        const altitudeCache = {};
        const layer = this.layer;
        const layerOpts = layer.options;
        const layerAltitude = layer.getAltitude ? layer.getAltitude() : 0;
        const isCanvasRender = layer.isCanvasRender();
        this._onlyHasPoint = true;
        //Traverse all Geo
        let idx = 0;
        const geos = this.getCurrentNeedRenderGeos();
        for (let i = 0, len = geos.length; i < len; i++) {
            const geo = geos[i];
            // const type = geo.getType();
            if (geo.isPoint) {
                let painter = geo._painter as Painter;
                if (!painter) {
                    painter = geo._getPainter();
                }
                const point = painter.getRenderPoints(PLACEMENT_CENTER)[0][0];
                const altitude = layerOpts['enableAltitude'] ? geo._getAltitude() : layerAltitude;
                //减少方法的调用
                if (altitudeCache[altitude] === undefined) {
                    altitudeCache[altitude] = painter.getAltitude();
                }
                cPoints[idx] = point;
                altitudes[idx] = altitudeCache[altitude];
                markers[idx] = geo;
                idx++;
            } else {
                this._onlyHasPoint = false;
            }
        }
        if (idx === 0) {
            return [];
        }
        const map = this.getMap();
        let pts = getPointsResultPts(cPoints, '_pt');
        pts = map._pointsAtResToContainerPoints(cPoints, glRes, altitudes, pts);
        const containerExtent = map.getGroundExtent();
        const { xmax, ymax, xmin, ymin } = containerExtent;
        const extentCache = {};
        for (let i = 0, len = markers.length; i < len; i++) {
            const geo = markers[i];
            geo._cPoint = pts[i];
            if (!geo._cPoint) {
                geo._inCurrentView = false;
                continue;
            }
            const { x, y } = pts[i];
            //Is the point in view
            geo._inCurrentView = (x >= xmin && y >= ymin && x <= xmax && y <= ymax) || geo.hasAltitude();
            //不在视野内的，再用fixedExtent 精确判断下
            if (!geo._inCurrentView) {
                const symbolkey = geo.getSymbolHash();
                let fixedExtent;
                if (symbolkey) {
                    //相同的symbol 不要重复计算
                    fixedExtent = extentCache[symbolkey] = (extentCache[symbolkey] || geo._painter.getFixedExtent());
                } else {
                    fixedExtent = geo._painter.getFixedExtent();
                }
                TEMP_FIXEDEXTENT.set(fixedExtent.xmin, fixedExtent.ymin, fixedExtent.xmax, fixedExtent.ymax);
                TEMP_FIXEDEXTENT._add(pts[i]);
                geo._inCurrentView = TEMP_FIXEDEXTENT.intersects(containerExtent);
            }
            if (geo._inCurrentView) {
                if (!geo.isVisible() || !isCanvasRender) {
                    geo._inCurrentView = false;
                }
                //如果当前图层上只有点，整个checkGeo都不用执行了,这里已经把所有的点都判断了
                if (this._onlyHasPoint && geo._inCurrentView) {
                    this._hasPoint = true;
                    geo._isCheck = true;
                    this._geosToDraw.push(geo);
                }
            }
        }
        return pts;
    }

    /**
     * 线/面的批量坐标转换优化
     * 将当前需要渲染的线/面的投影点一次性通过 map._pointsAtResToContainerPoints 转换为容器坐标，
     * 转换结果写入各几何投影点的 _pt 缓存，Painter 绘制时可直接复用，避免逐几何重复转换。
     * 与 _batchConversionMarkers 的点批量转换相互补充。
     * @internal
     * @param glRes
     */
    _batchConversionLines(glRes: number) {
        if (this._onlyHasPoint || !this._constructorIsThis()) {
            return;
        }
        const map = this.getMap();
        if (!map) {
            return;
        }
        const rendererStateCache = this.rendererStateCache;
        if (!rendererStateCache) {
            return;
        }
        // 只对可见（_geosToDraw）的线/面做批量转换
        const geos = this._geosToDraw;
        if (!geos || !geos.length) {
            return;
        }
        // 收集线/面的投影点（painter 已按当前分辨率缓存，直接复用）
        const allPts = [];
        const batches = [];
        for (let i = 0, len = geos.length; i < len; i++) {
            const geo = geos[i];
            if (geo.isPoint) {
                continue;
            }
            const painter = geo._painter;
            if (!painter) {
                continue;
            }
            // 集合几何（MultiLineString/MultiPolygon/GeometryCollection 等）使用 CollectionPainter，
            // 它没有 getProjectionPoints 方法，跳过批量转换，走各自子 painter 的常规绘制路径
            if (typeof painter.getProjectionPoints !== 'function') {
                continue;
            }
            const points = painter.getProjectionPoints();
            if (!points || !Array.isArray(points)) {
                continue;
            }
            // 带洞多边形等复合几何（points[0] 为数组）跳过批量转换
            if (Array.isArray(points[0])) {
                continue;
            }
            const start = allPts.length;
            for (let j = 0, l = points.length; j < l; j++) {
                allPts[start + j] = points[j];
            }
            batches.push({ painter, points, start });
        }
        if (!allPts.length) {
            return;
        }
        const resultPts = getPointsResultPts(allPts, '_pt');
        // _pointsAtResToContainerPoints 就地填充并返回 resultPts，返回值无需再赋值
        map._pointsAtResToContainerPoints(allPts, glRes, null, resultPts);
        for (let i = 0, len = batches.length; i < len; i++) {
            const batch = batches[i];
            const painter = batch.painter;
            painter._batchApplied = true;
            painter._batchGlRes = glRes;
            painter._batchPitch = rendererStateCache.pitch;
            painter._batchBearing = rendererStateCache.bearing;
            painter._batchOffset = rendererStateCache.offset;
        }
    }

    //@internal
    _sortByDistanceToCamera(cameraPosition: Vector3) {
        if (!this.layer.options['sortByDistanceToCamera']) {
            return;
        }
        if (!this._geosToDraw.length) {
            return;
        }
        const map = this.getMap();
        const p = map.distanceToPoint(1000, 0, map.getGLScale()).x;
        const meterScale = p / 1000;
        const placement = 'center';
        this._geosToDraw.sort((a, b) => {
            // const type0 = a.getType();
            // const type1 = b.getType();
            if (!a.isPoint || !b.isPoint) {
                return 0;
            }
            const painter0 = a._painter;
            const painter1 = b._painter;
            if (!painter0 || !painter1) {
                return 0;
            }
            const point0 = painter0.getRenderPoints(placement)[0][0];
            const point1 = painter1.getRenderPoints(placement)[0][0];
            const alt0 = painter0.getAltitude() * meterScale;
            const alt1 = painter1.getAltitude() * meterScale;
            vec3.set(TEMP_VEC3, point0.x, point0.y, alt0);
            const dist0 = vec3.distance(TEMP_VEC3, cameraPosition);
            vec3.set(TEMP_VEC3, point1.x, point1.y, alt1);
            const dist1 = vec3.distance(TEMP_VEC3, cameraPosition);
            return dist1 - dist0;
        });
    }

    //@internal
    _constructorIsThis(): boolean {
        return this.constructor === VectorLayerRenderer;
    }

    isProgressiveRender(): boolean {
        const layer = this.layer;
        if (!layer) {
            return false;
        }
        const { progressiveRender, collision } = layer.options || {};
        if (collision) {
            return false;
        }
        return progressiveRender;
    }

    getGeosForIdentify(): Geometries[] {
        if (!this.isProgressiveRender()) {
            return this._geosToDraw || [];
        }
        return this.pageGeos || [];
    }

    getGeoPainterList(): (Painter | CollectionPainter)[] {
        if (!this.isProgressiveRender()) {
            const list = [];
            const geos = this._geosToDraw || [];
            for (let i = 0, len = geos.length; i < len; i++) {
                list.push(geos[i]._painter);
            }
            return list;
        }
        return this.geoPainterList || [];
    }

    //@internal
    _checkSnapshotCanvas() {
        if (!this.isProgressiveRender()) {
            delete this.snapshotCanvas;
            return null;
        }
        const canvas = this.canvas;
        if (!canvas) {
            delete this.snapshotCanvas;
            return null;
        }
        if (!this.snapshotCanvas) {
            this.snapshotCanvas = Canvas.createCanvas(1, 1);
        }
        const snapshotCanvas = this.snapshotCanvas;
        const { width, height, style } = canvas;
        if (snapshotCanvas.width !== width || snapshotCanvas.height !== height) {
            snapshotCanvas.width = width;
            snapshotCanvas.height = height;
        }
        if (snapshotCanvas.style.width !== style.width || snapshotCanvas.style.height !== style.height) {
            snapshotCanvas.style.width = style.width;
            snapshotCanvas.style.height = style.height;
        }

        return snapshotCanvas;

    }

    //@internal
    _getCurrentNeedRenderGeos(): Geometries[] {
        const geos = this.layer._geoList || [];
        if (!this.isProgressiveRender()) {
            return geos;
        }
        const layer = this.layer;
        const { progressiveRenderCount } = layer.options;
        const pageSize = progressiveRenderCount;
        const page = this.page;
        const start = (page - 1) * pageSize, end = page * pageSize;
        const pageGeos = geos.slice(start, end);
        return pageGeos;
    }

    getCurrentNeedRenderGeos(): Geometries[] {
        return this._getCurrentNeedRenderGeos();
    }

    //@internal
    _resetProgressiveRender() {
        if (isDebug(this.layer)) {
            console.log('progressiveRender resetProgressiveRender');
        }
        const lastRenderEnd = this.renderEnd;
        this.renderEnd = false;
        this.page = 1;
        this.pageGeos = [];
        this.geoPainterList = [];
        this.maxTolerance = 0;
        if (lastRenderEnd && this._progressiveBgTransform) {
            //渐进首屏已完成且刚结束 zoom/pan：把旧完整画面按视图变换（缩放+平移）绘制为渐进首帧背景，
            //画面从旧视图无缝过渡到新视图，避免"重新绘制过程"从空白逐页出现的闪烁；
            //随后仍按页渐进覆盖新几何，每帧只画 progressiveRenderCount 个，交互结束不卡顿
            const t = this._progressiveBgTransform;
            delete this._progressiveBgTransform;
            this._useCanvasAsProgressiveBg(t.scale, t.dx, t.dy);
        } else {
            //首屏渐进中或数据变化：不需要旧画面背景，清空快照从空白开始分页绘制
            delete this._progressiveBgTransform;
            this._clearSnapshotCanvas();
        }
    }

    //@internal
    _useCanvasAsProgressiveBg(scale: number, dx: number, dy: number) {
        const snapshotCanvas = this._checkSnapshotCanvas();
        if (!snapshotCanvas || !this.canvas) {
            return;
        }
        const ctx = clearCanvas(snapshotCanvas);
        const w = snapshotCanvas.width;
        const h = snapshotCanvas.height;
        //zoom：绕画布中心缩放（newRes/_drawnRes）；pan：按视图中心偏移平移
        ctx.save();
        ctx.translate(w / 2 + dx, h / 2 + dy);
        ctx.scale(scale, scale);
        ctx.translate(-w / 2, -h / 2);
        ctx.drawImage(this.canvas, 0, 0);
        ctx.restore();
    }

    //@internal
    _calcProgressiveBgTransform(): { scale: number; dx: number; dy: number } {
        if (!this.isProgressiveRender() || !this.canvas) {
            return null;
        }
        const map = this.getMap();
        if (!map) {
            return null;
        }
        const oldRes = this._drawnRes;
        const newRes = map.getResolution();
        const scale = oldRes && newRes && oldRes !== newRes ? newRes / oldRes : 1;
        //zoom/pan 结束后视图中心相对画布中心的容器偏移（换算为位图像素），pan 时旧画面据此平移对齐
        const cur = map._pointToContainerPoint(map.getCenter());
        const dpr = this.mapDPR || map.getDevicePixelRatio() || 1;
        const dx = (cur.x - map.width / 2) * dpr;
        const dy = (cur.y - map.height / 2) * dpr;
        if (scale === 1 && dx === 0 && dy === 0) {
            return null;
        }
        return { scale, dx, dy };
    }

    //@internal
    _clearSnapshotCanvas() {
        const snapshotCanvas = this._checkSnapshotCanvas();
        if (snapshotCanvas) {
            clearCanvas(snapshotCanvas);
        }
    }

    //@internal
    _snapshot() {
        const progressiveRender = this.isProgressiveRender();
        const geosToDraw = this._geosToDraw || [];
        for (let i = 0, len = geosToDraw.length; i < len; i++) {
            const geo = geosToDraw[i];
            const t = geo._hitTestTolerance() || 0;
            this.maxTolerance = Math.max(this.maxTolerance, t);
            if (progressiveRender) {
                this.pageGeos.push(geo);
                const painter = geo._painter;
                this.geoPainterList.push(painter);
            }
        }
        if (!progressiveRender) {
            return this;
        }
        const time = now();
        const snapshotCanvas = this._checkSnapshotCanvas();
        if (snapshotCanvas && this.canvas) {
            const ctx = clearCanvas(snapshotCanvas);
            ctx.drawImage(this.canvas, 0, 0);
        }
        const layer = this.layer;
        const { progressiveRenderCount } = layer.options;
        const geos = layer._geoList || [];
        const pages = Math.ceil(geos.length / progressiveRenderCount);
        this.renderEnd = this.page >= pages;
        if (this.renderEnd) {
            this._setDrawGeosDrawTime();
        }
        if (isDebug(this.layer)) {
            console.log('snapshot time:', (now() - time) + 'ms');
        }
        if (!this.renderEnd) {
            this.page++;
        }
        return this;
    }

    //@internal
    _drawSnapshot() {
        if (!this.isProgressiveRender()) {
            return this;
        }
        const { snapshotCanvas, context } = this;
        if (!snapshotCanvas || !context) {
            return this;
        }
        const map = this.getMap();
        if (!map) {
            return this;
        }
        const dpr = this.mapDPR || map.getDevicePixelRatio() || 1;
        const rScale = 1 / dpr;
        this._canvasContextScale(context, rScale);
        context.drawImage(snapshotCanvas, 0, 0);
        this._canvasContextScale(context, dpr);
        return this;
    }
}

VectorLayer.registerRenderer<typeof VectorLayerRenderer>('canvas', VectorLayerRenderer);

type GeoType = any;

export default VectorLayerRenderer;
