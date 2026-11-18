import {
    isNil,
    extend,
    isString,
    isObject,
    isNumber,
    pushIn,
    isFnTypeSymbol
} from "../../common/Util";
import { buildWireframe, build3DExtrusion } from "../builder/";
import { createFilter } from "@maptalks/feature-filter";
import { KEY_IDX } from "../../common/Constant";
import Browser from "../util/Browser";
import { getVectorPacker } from "../../packer/inject";
import { encodeJSON } from "maptalks/dist/core/util/encode";
import StringPool from "../../common/StringPool";

const {
    VectorPack,
    PolygonPack,
    NativeLinePack,
    LinePack,
    PointPack,
    NativePointPack,
    LineExtrusionPack,
    CirclePack,
    RoundTubePack,
    SquareTubePack,
    FilterUtil,
    PackUtil,
    StyleUtil,
    TextUtil,
    DEFAULT_TEX_WIDTH,
    GlyphRequestor
} = getVectorPacker();
// let FONT_CANVAS;

const oldPropsKey = "__original_properties";
const fntypePropsKey = "__fn-type_properties";

// Per-worker string pool for deduplicating feature property strings.
// Created lazily when the first tile is processed.
// 每个 Worker 独立的字符串池，用于去重要素属性中的重复字符串（如同名街道、类别标签）。
// 首次处理瓦片时懒加载创建，避免每个瓦片各自创建相同字符串导致内存浪费。
let _workerStringPool = null;

function shouldEncodeFullFeatures(featuresOption, context) {
    // 完整 feature json 是一份额外的编码副本，只有在显式请求 full payload 时才生成。
    // 常规 features=true 场景保留可直接使用的 feature 对象，避免每个 tile 再复制一份
    // featuresTypeArray 到主线程。
    return !!(context && context.requireFullFeatureJSON) || featuresOption === "full";
}

export default class BaseLayerWorker {
    constructor(id, options, upload, tileCache, tileLoading) {
        this.id = id;
        this.options = options;
        this.upload = upload;
        this.requests = {};
        this._cache = tileCache;
        this.loadings = tileLoading;
        this._styles = [];
        // Lazy property store for features:'id' mode.
        // Map<tileId, { [featureId]: featureObject }>
        // features:'id' 模式下的懒加载属性存储器：瓦片首次加载时存储按 ID 组织的属性，
        // 之后按需（identify / 选中）查询，避免首次就全量解析所有要素属性到主线程。
        this._propertyStores = new Map();
    }

    updateOptions(options, cb) {
        this.options = extend(this.options, options);
        cb();
    }

    /**
     * Lazily fetch full feature properties by tileKey + featureIds.
     * Used in features:'id' mode to retrieve properties on demand
     * (e.g. when identify() or getRenderedFeatures() is called).
     *
     * Compact columnar store:
     * Each tile store = { __s: { k: [propKey0,...], m: {propKey: idx} }, featId: [type, layer, val0, val1, ...] }
     * Where type=index0, layer=index1, property values start at index2.
     * This avoids per-feature {type, layer, properties} JS object overhead (~56 bytes per empty object),
     * reducing ~300MB to ~20-40MB for 32 tiles with 20K features each.
     *
     * 通过 tileKey + featureIds 按需懒加载获取完整要素属性。
     * 用于 features:'id' 模式，在调用 identify() 或 getRenderedFeatures() 时按需获取属性。
     * 
     * 紧凑列式存储：
     * 每个瓦片存储 = { __s: { k: [属性名0,...], m: {属性名: 索引} }, 要素ID: [类型, 图层, 值0, 值1, ...] }
     * 其中 类型=索引0, 图层=索引1, 属性值从索引2 开始。
     * 避免每个要素创建 {type, layer, properties} JS 对象的开销（每个空对象约56字节），
     * 对于 32 个瓦片 × 2万要素 的场景，内存从约 300MB 降至 20-40MB。
     * @param {{ tileKey: string, featureIds: string[] }} params
     * @param {Function} cb
     */
    getFeatureProperties(params, cb) {
        const { tileKey, featureIds } = params;
        const store = this._propertyStores.get(tileKey);
        if (!store) {
            cb(null, {});
            return;
        }
        const schema = store.__s;
        const keys = schema.k;
        const keyCount = keys.length;
        const result = {};
        for (let i = 0; i < featureIds.length; i++) {
            const id = featureIds[i];
            const arr = store[id];
            if (!arr) continue;
            // Reconstruct {type, layer, properties} from columnar array
            // 从列式存储的紧凑数组重建 {type, layer, properties} 对象结构，供 identify / getRenderedFeatures 使用。
            const properties = {};
            for (let k = 0; k < keyCount; k++) {
                const val = arr[2 + k];
                if (val !== null && val !== undefined) {
                    properties[keys[k]] = val;
                }
            }
            result[id] = { type: arr[0], layer: arr[1], properties };
        }
        cb(null, result);
    }

    /**
     * Load a tile, paint and return gl directives
     * @param {Object} tileInfo  - tileInfo, xyz, res, extent, etc
     * @param {Function} cb - callback function when finished
     */
    loadTile(context, cb) {
        const loadings = this.loadings;
        const url = context.tileInfo.url;
        const debugTile = this.options.debugTile;
        if (debugTile) {
            const { x, y, z } = context.tileInfo;
            let hit = false;
            for (let i = 0; i < debugTile.length; i++) {
                if (
                    x === debugTile[i].x &&
                    y === debugTile[i].y &&
                    z === debugTile[i].z
                ) {
                    hit = true;
                    break;
                }
            }
            if (!hit) {
                cb();
                return;
            }
        }

        if (loadings[url]) {
            loadings[url].push({
                // 必须要保存context，因为context中的值可能会发生变化，例如styleCounter，导致逻辑发生错误
                context,
                callback: cb,
                ref: this
            });
            return;
        }
        loadings[url] = [
            {
                context,
                callback: cb,
                ref: this
            }
        ];
        const feaIdProp = this.options.featureIdProperty;
        this.requests[url] = this.getTileFeatures(context, (err, features, layers, props) => {
            const waitings = loadings[url];
            delete loadings[url];
            if (this.checkIfCanceled(url)) {
                delete this.requests[url];
                this._callWaitings(waitings, null, { canceled: true });
                return;
            }
            delete this.requests[url];
            if ((this.options.debug || feaIdProp) && features) {
                for (let i = 0; i < features.length; i++) {
                    if (this.options.debug) {
                        features[i]["_debug_info"] = {
                            index: i,
                            id: features[i].id,
                            tileId: context.tileInfo.id
                        };
                    }
                    if (feaIdProp) {
                        const propName = isObject(feaIdProp)
                            ? feaIdProp[features[i].layer]
                            : feaIdProp;
                        const properties = features[i].properties;
                        features[i].id =
                            (properties && properties[propName]) || null;
                    }
                }
            }
            if (err) {
                this._callWaitings(waitings, err);
                return;
            }
            if (!features || !features.length) {
                this._callWaitings(waitings);
                return;
            }
            if (waitings) {
                for (let i = 0; i < waitings.length; i++) {
                    this._onTileLoad.call(
                        waitings[i].ref,
                        waitings[i].context,
                        waitings[i].callback,
                        url,
                        layers,
                        features,
                        props
                    );
                }
            }
        });
    }

    _onTileLoad(context, cb, url, layers, features, props) {
        this._getStyleByCounter(context.styleCounter).then((compiledStyle) => {
            context.style = compiledStyle;
            this._createTileData(
                layers,
                features,
                context,
                (partial) => {
                    // 按要素类型拆分回传的第一阶段：不依赖图标/字形的要素（线/面等）先行回传上屏，
                    // 点要素（依赖 fetchIconGlyphs 图标/字形加载）随后以 pointOnly 补充。
                    if (props) {
                        partial.props = props;
                    }
                    this._sendTileData(partial, context, cb);
                }
            )
                .then((data) => {
                    // 第二阶段（拆分时仅点要素 slot）或未拆分时的完整数据
                    this._sendTileData(data, context, cb);
                })
                .catch((err) => {
                    cb(err);
                });
        });
    }

    _sendTileData(data, context, cb) {
        if (!data || data.canceled || !data.data) {
            cb(null, { canceled: true });
            return;
        }
        data.data.styleCounter = context.styleCounter;
        // pointOnly（点要素补充）阶段只带点 slot，不重复编码 features / 不重复挂 props
        const pointOnly = data.data.pointOnly;
        if (!pointOnly && data.props) {
            const props = data.props;
            delete data.props;
            extend(data.data, props);
        }

        const features = data.data.features;
        if (!pointOnly && features) {
            const isDefault = this.options.features === true;
            const onlyId = this.options.features === "id";

            const needFullFeatureJSON = shouldEncodeFullFeatures(
                this.options.features,
                context
            ) || isDefault; // Encode full features for default (features: true) to avoid passing geometry as JS objects

            let uint8Array;
            if (needFullFeatureJSON) {
                // newFeatures 仅在 full payload 编码时需要
                const newFeatures = {};
                for (const index in features) {
                    const feature = features[index];
                    newFeatures[feature.id] = feature;
                }
                uint8Array = encodeJSON(newFeatures);
                if (uint8Array) {
                    data.data.featuresTypeArray = uint8Array;
                    data.buffers = data.buffers || [];
                    data.buffers.push(uint8Array.buffer);
                }
            }

            let compactStore = null;
            if (onlyId || isDefault) {
                compactStore = this._createCompactStore(features);
                if (isDefault) {
                    // Transfer compactStore to main thread for synchronous property access
                    data.data.compactStore = compactStore;
                }
            }

            if (onlyId) {
                const tileKey = context.tileInfo && context.tileInfo.id;
                const storeKey = tileKey || context.url;
                this._propertyStores.set(storeKey, compactStore);
                if (this._propertyStores.size > 32) {
                    const oldest = this._propertyStores.keys().next().value;
                    this._propertyStores.delete(oldest);
                }
            }

            if (onlyId || uint8Array) {
                let missingIdCount = 0;
                for (const index in features) {
                    const featureData = features[index];
                    if (uint8Array) {
                        //删除geometry,已经包含在featuresTypeArray
                        delete featureData.geometry;
                    }
                    if (onlyId) {
                        if (featureData.id === undefined || featureData.id === null) {
                            missingIdCount++;
                        }
                        features[index] = featureData.id;
                    } else if (isDefault) {
                        // For features: true, we delete properties too, because we transfer compactStore
                        delete featureData.properties;
                    }
                }
                if (onlyId && missingIdCount > 0) {
                    console.warn(`[VectorTileLayer] ${missingIdCount}/${Object.keys(features).length} features have no id. Set 'featureIdProperty' option to extract id from properties, otherwise identifyAsync/pick cannot work in features:'id' mode.`);
                }
            }
        }
        cb(null, data.data, data.buffers);
    }

    /**
     * Create a compact column-oriented property store.
     *
     * Before: { featId: {type, layer, properties: {key1: val1, ...}} }
     *   -> ~500 bytes per feature (JS object overhead * 3 containers)
     *   -> ~400MB for 32 tiles * 25K features
     *
     * After:  { __s: {k: [keys], m: {key:idx}}, featId: [type, layer, val0, ...] }
     *   -> ~40-60 bytes per feature (single array + schema shared per tile)
     *   -> ~30-50MB for 32 tiles * 25K features
     *
     * All string values are interned via shared StringPool for zero-copy dedup.
     *
     * @param {Object} features - The raw features object keyed by index
     * @returns {Object} Compact column-oriented store
     */
    _createCompactStore(features) {
        // Ensure string pool exists (created by _createTileData, but guard here)
        if (!_workerStringPool) {
            _workerStringPool = new StringPool();
        }
        const pool = _workerStringPool;

        // Pass 1: Collect all unique property key names to build the column schema
        const keysSet = new Set();
        for (const index in features) {
            const f = features[index];
            if (f && f.properties) {
                const keys = Object.keys(f.properties);
                for (let k = 0; k < keys.length; k++) {
                    keysSet.add(keys[k]);
                }
            }
        }
        const propKeys = Array.from(keysSet);
        const keyMap = {};
        for (let i = 0; i < propKeys.length; i++) {
            keyMap[propKeys[i]] = i;
        }

        // Schema: type=idx0, layer=idx1, property values start at idx2
        // Intern property key names for cross-tile dedup
        for (let i = 0; i < propKeys.length; i++) {
            propKeys[i] = pool.intern(propKeys[i]);
        }
        const store = { __s: { k: propKeys, m: keyMap } };
        const totalCols = 2 + propKeys.length;

        // Pass 2: Build columnar arrays with interned string values
        for (const index in features) {
            const f = features[index];
            if (!f || !f.properties) continue;
            const arr = new Array(totalCols);
            arr[0] = pool.intern(f.type || '');
            arr[1] = pool.intern(f.layer || '');
            const props = f.properties;
            for (let k = 0; k < propKeys.length; k++) {
                const val = props[propKeys[k]];
                arr[2 + k] = (typeof val === 'string') ? pool.intern(val) : (val !== undefined ? val : null);
            }
            store[f.id] = arr;
        }
        return store;
    }

    _getStyleByCounter(styleCounter) {
        if (this._styles[styleCounter]) {
            return this._styles[styleCounter];
        }
        this._styles[styleCounter] = new Promise((resolve, reject) => {
            this.upload(
                "getStyleByCounter",
                { styleCounter },
                null,
                (err, data) => {
                    if (err) {
                        reject(err);
                        return;
                    }
                    const compiledStyle = this._compileStyle(data);
                    compiledStyle.style = data;
                    this._styles[styleCounter] = Promise.resolve(compiledStyle);
                    resolve(compiledStyle);
                }
            );
        });
        return this._styles[styleCounter];
    }

    abortTile(url, cb) {
        delete this.requests[url];
        this._cancelLoadings(url);
        cb();
    }

    _cancelLoadings(url) {
        const waitings = this.loadings[url];
        if (waitings) {
            for (let i = 0; i < waitings.length; i++) {
                waitings[i].callback(null, { canceled: true });
            }
        }
        delete this.loadings[url];
    }

    _callWaitings(waitings, err, data) {
        if (waitings) {
            for (let i = 0; i < waitings.length; i++) {
                waitings[i].callback(err, data);
            }
        }
    }

    checkIfCanceled(url) {
        return !this.requests[url];
    }

    onRemove() {
        this.loadings = {};
        this.clearCache();
        delete this._cache;
        this.requests = {};
        if (this._propertyStores) {
            this._propertyStores.clear();
        }
    }

    clearCache() {
        if (this._cache) {
            this._cache.reset();
        }
    }

    fetchIconGlyphs(icons, glyphs, cb) {
        //2019-03-20 win10 chrome 74 64位，OffscreenCanvas fillText性能只有主线程的10%，还不可用
        // 2021-02-25 Offscreen.fillText会造成程序出错，还不可用
        // 2023-07-32 改用Offscreen来创建glyph，用以提升性能
        if (this.options.workerGlyph && Browser.offscreenCanvas) {
            const promises = [];
            if (icons && Object.keys(icons).length) {
                const promise = new Promise((resolve) => {
                    this.upload(
                        "fetchIconGlyphs",
                        { icons },
                        null,
                        (err, data) => {
                            resolve({ err, iconData: data });
                        }
                    );
                });
                promises.push(promise);
            }
            if (glyphs && Object.keys(glyphs).length) {
                const promise = new Promise((resolve) => {
                    if (!this._glyphRequestor) {
                        // Get sdfURL from layer options first, then from renderPlugin if not found
                        const sdfURL = this.options.sdfURL;
                        this._glyphRequestor = new GlyphRequestor(
                            null,
                            null,
                            null,
                            sdfURL
                        );
                    }
                    this._glyphRequestor.getGlyphs(glyphs, (err, glyphData) => {
                        resolve({ err, glyphData });
                    });
                });
                promises.push(promise);
            }

            Promise.all(promises)
                .then((datas) => {
                    const data = { icons: null, glyphs: null };
                    for (let i = 0; i < datas.length; i++) {
                        if (datas[i].err) {
                            cb(datas[i].err);
                            return;
                        } else if (datas[i].iconData) {
                            data.icons = datas[i].iconData.icons;
                        } else if (datas[i].glyphData) {
                            data.glyphs = datas[i].glyphData.glyphs;
                        }
                    }
                    return data;
                })
                .then((data) => {
                    cb(null, data);
                });

            // if (!this._iconRequestor) {
            //     this._iconRequestor = new IconRequestor();
            // }
        } else {
            //command, params, buffers and callback
            this.upload("fetchIconGlyphs", { icons, glyphs }, null, cb);
        }
        // this.upload('fetchIconGlyphs', { icons, glyphs }, null, cb);
    }

    _createTileData(layers, features, context, onPartial) {
        if (!features.length) {
            return Promise.resolve({
                data: null,
                buffers: []
            });
        }
        const { glScale, tileInfo } = context;
        const {
            pluginConfigs: stylePlugins,
            featurePlugins,
            styledFeatures
        } = context.style;
        const style = context.style.style;
        const useDefault = !style.style.length && !style.featureStyle.length;
        let pluginConfigs = stylePlugins.slice(0);
        if (useDefault) {
            //图层没有定义任何style，通过数据动态生成pluginConfig
            pluginConfigs = this._updateLayerPluginConfig(layers);
        }
        if (featurePlugins) {
            pushIn(pluginConfigs, featurePlugins);
        }
        const allCustomProps = {};
        for (let i = 0; i < pluginConfigs.length; i++) {
            cloneFeaAndAppendCustomTags(
                features,
                context.tileInfo.z,
                pluginConfigs[i],
                allCustomProps
            );
        }
        const feas = [];
        const copies = [];
        for (let i = 0; i < features.length; i++) {
            const feature = features[i];
            const customProps = allCustomProps[i];
            if (customProps) {
                copies.fill(null);
                let count = 0;
                for (const p in customProps) {
                    let index = 0;
                    const props = customProps[p].values();
                    for (const v of props) {
                        let fea = copies[index];
                        if (!fea) {
                            fea = proxyFea(feature);
                            copies[index] = fea;
                        }
                        fea.properties[p] = v;
                        index++;
                    }
                    if (index > count) {
                        count = index;
                    }
                }
                for (let i = 0; i < count; i++) {
                    feas.push(copies[i]);
                }
            } else {
                feas.push(feature);
            }
        }

        features = feas;

        const EXTENT = features[0].extent;
        const zoom = tileInfo.z,
            tilePoint = {
                x: tileInfo.extent2d.xmin * glScale,
                y: tileInfo.extent2d.ymax * glScale
            },
            data = [],
            featureData = [],
            pluginIndexes = [],
            options = this.options,
            buffers = [];
        // Two-phase progressive tile delivery (fast/slow split).
        //
        // WHY SPLIT:
        //   Point/native-point plugins call fetchIconGlyphs() -> async XHR + atlas build.
        //   This round-trip stalls tile upload by 40-200ms on fast connections, 1-3s on 3G.
        //   Because _createTileData returns one Promise.all that resolves only when ALL
        //   plugins finish, the fastest geometry (lines/polygons — pure CPU, no I/O)
        //   blocks behind the slowest path (SDF glyph atlas download).
        //
        //   After split:
        //     Phase 1 (partial=true)  — fast slots (line/fill/3d-extrusion/...) uploaded
        //                                immediately; main thread paints them.
        //     Phase 2 (pointOnly=true) — slow slots (point/native-point) uploaded after
        //                                fetchIconGlyphs completes; main thread merges slots.
        //   User-visible: the "simplified → precise" transition (low-res proxy tile swap)
        //   no longer waits for iconography; base-map lines/polygons pop in 50-80ms earlier.
        //
        // useDefault guard: when useDefault (no explicit style, dynamic plugin gen), the
        // main thread compresses data.data arrays per layer, which assumes contiguous
        // non-sparse typeIdx arrays. Two-phase partial upload would desync the index.
        //
        // 两阶段渐进式瓦片回传（快/慢拆分）。
        //
        // 为什么要拆分：
        //   Point / native-point 插件会调用 fetchIconGlyphs() —— 触发异步 XHR 下载
        //   与 SDF 图集构建。在快网络下此往返阻塞瓦片上传 40-200ms，3G 网络下达 1-3s。
        //   原实现 _createTileData 返回单一 Promise.all，所有插件全部完成才 resolve，
        //   导致最快的几何（线/面，纯 CPU、无 I/O）被最慢路径（字形图集下载）拖住。
        //
        //   拆分后：
        //     阶段 1（partial=true）  — 快槽位（线/面/3d 拉伸等）立即上传，主线程直接渲染。
        //     阶段 2（pointOnly=true） — 慢槽位（点/本地点）待 fetchIconGlyphs 完毕后补充，
        //                                主线程按 typeIdx 合入同一瓦片。
        //   用户感知：低分辨率代理瓦片切换到精确瓦片的过渡不再等待图标资源，
        //   底图线面提前 50-80ms 呈现在屏幕上。
        //
        // useDefault 守卫：无显式样式（动态生成插件）时，主线程会按图层压缩 data.data 数组，
        // 要求 typeIdx 连续且非稀疏；两阶段部分上传会破坏此索引对应关系，因此不拆分。
        const slowData = [],
            slowFeatureData = [],
            slowPluginIndexes = [],
            slowBuffers = [];
        const feaTags = {};
        // Sentinel prefix at index 0 carries styleCounter so the destructuring
        // `[styleCounter, ...tileDatas]` stays identical between fast/slow/all paths.
        // Both arrays have a dummy resolved promise at position 0 so the per-plugin
        // push index matches pluginIndexes 1:1 (no off-by-one bookkeeping).
        // 索引 0 处的哨兵前缀携带 styleCounter，使 `[styleCounter, ...tileDatas]`
        // 解构在快/慢/全路径下保持一致。两个数组首位均为已 resolve 的占位 Promise，
        // 确保后续 push 索引与 pluginIndexes 一一对应（无偏移簿记）。
        const fastPromises = [Promise.resolve(context.styleCounter)];
        const slowPromises = [Promise.resolve(context.styleCounter)];
        let currentType = 0;
        let typeIndex = -1;

        const fnTypeProps = [];
        let hasFnTypeProps = false;

        for (let i = 0; i < pluginConfigs.length; i++) {
            typeIndex++;
            const pluginConfig = pluginConfigs[i];
            if (pluginConfig.type !== currentType) {
                //plugin类型变成 feature plugin
                typeIndex = 0;
                currentType = pluginConfig.type;
            }
            // Slow-group membership is pure dataConfig.type, NOT an async-duration
            // heuristic: point/native-point ALWAYS invoke fetchIconGlyphs internally
            // inside PointPack/NativePointPack.load(), even if glyph cache is warm
            // (cache hits still do async hash map lookups and go through the microtask
            // queue). Everything else builds geometry synchronously in-worker.
            //   type=0 → regular layer style plugin
            //   type=1 → per-feature style plugin (featureStyles array)
            // Both dimensions route into fast vs slow slots independently.
            //
            // 慢组成员严格由 dataConfig.type 决定，而不是异步时长的启发式判断：
            // point / native-point 在 PointPack/NativePointPack.load() 内部
            // 必然调用 fetchIconGlyphs（即使字形缓存命中，也要走异步哈希查找
            // 与微任务队列）。其他所有类型均在 Worker 内同步构建几何。
            //   type=0 → 普通图层样式插件
            //   type=1 → 单要素样式插件（featureStyles 数组）
            // 两个维度各自独立地被分流到快/慢槽位。
            const isSlow =
                !useDefault &&
                (pluginConfig.renderPlugin.dataConfig.type === "point" ||
                    pluginConfig.renderPlugin.dataConfig.type === "native-point");
            const targetData =
                pluginConfig.type === 0
                    ? isSlow
                        ? slowData
                        : data
                    : isSlow
                        ? slowFeatureData
                        : featureData;
            getFnTypeProps(pluginConfig.symbol, fnTypeProps, i);
            hasFnTypeProps =
                hasFnTypeProps || (fnTypeProps[i] && fnTypeProps[i].size > 0);

            const { tileFeatures, tileFeaIndexes } = this._filterFeatures(
                styledFeatures,
                zoom,
                pluginConfig.type,
                pluginConfig.filter,
                features,
                feaTags,
                i
            );

            if (!tileFeatures.length) {
                targetData[typeIndex] = null;
                continue;
            }

            const maxIndex = tileFeaIndexes[tileFeaIndexes.length - 1];
            const arrCtor = PackUtil.getIndexArrayType(maxIndex);
            targetData[typeIndex] = {
                //[feature_index, style_index, ...]
                styledFeatures: new arrCtor(tileFeaIndexes)
            };

            if (isSlow) {
                //index of plugin with data（慢组：点要素）
                slowPluginIndexes.push({
                    idx: i,
                    typeIdx: typeIndex
                });
                slowBuffers.push(targetData[typeIndex].styledFeatures.buffer);
            } else {
                //index of plugin with data（快组：线/面等）
                pluginIndexes.push({
                    idx: i,
                    typeIdx: typeIndex
                });
                buffers.push(targetData[typeIndex].styledFeatures.buffer);
            }
            const tileContext = extend({}, context, {
                extent: EXTENT,
                zoom,
                tilePoint
            });
            if (this.options.debugTile) {
                const debugTile = this.options.debugTile;
                for (let i = 0; i < debugTile.length; i++) {
                    const { x, y, z } = debugTile[i];
                    if (
                        tileInfo.x === x &&
                        tileInfo.y === y &&
                        tileInfo.z === z
                    ) {
                        tileContext.debugIndex = debugTile[i].index;
                        break;
                    }
                }
            }
            let promise = this._createTileGeometry(
                tileFeatures,
                pluginConfig,
                tileContext
            );
            if (useDefault) {
                promise = promise.then((tileData) => {
                    if (!tileData) {
                        return null;
                    }
                    if (tileData.data) {
                        tileData.data.layer = tileFeatures[0].layer;
                    } else if (Array.isArray(tileData)) {
                        for (let i = 0; i < tileData.length; i++) {
                            if (tileData[i] && tileData[i].data)
                                tileData[i].data.layer = tileFeatures[0].layer;
                        }
                    }
                    return tileData;
                });
            }
            (isSlow ? slowPromises : fastPromises).push(promise);
        }

        // 未拆分与拆分的公共 promise 集合（无慢组时 slowPromises 只剩 styleCounter 前缀）
        const allPromises = [...fastPromises, ...slowPromises.slice(1)];
        const allIndexes = pluginIndexes.concat(slowPluginIndexes);
        // 拆分回传：快组（线/面等）先行回传上屏（partial），慢组（点要素，依赖 fetchIconGlyphs
        // 图标/字形加载）随后以 pointOnly 补充，避免点要素拖住整个瓦片的"简化→精确"过渡。
        if (!useDefault && slowPluginIndexes.length > 0 && onPartial) {
            const fastPromise = Promise.all(fastPromises)
                .then(([styleCounter, ...tileDatas]) => {
                    this._processTileDatas(
                        tileDatas,
                        pluginIndexes,
                        data,
                        featureData,
                        buffers,
                        pluginConfigs
                    );
                    const allFeas = this._buildAllFeas(
                        layers,
                        features,
                        options,
                        hasFnTypeProps,
                        fnTypeProps,
                        feaTags
                    );
                    return {
                        data: {
                            styleCounter,
                            schema: layers,
                            data,
                            featureData,
                            extent: EXTENT,
                            features: allFeas,
                            partial: true
                        },
                        buffers
                    };
                })
                .catch((err) => {
                    console.error(err);
                });
            fastPromise.then((partial) => {
                if (partial && partial.data) {
                    onPartial(partial);
                }
            });
            return Promise.all(slowPromises)
                .then(([styleCounter, ...tileDatas]) => {
                    this._processTileDatas(
                        tileDatas,
                        slowPluginIndexes,
                        slowData,
                        slowFeatureData,
                        slowBuffers,
                        pluginConfigs
                    );
                    return {
                        data: {
                            styleCounter,
                            data: slowData,
                            featureData: slowFeatureData,
                            pointOnly: true
                        },
                        buffers: slowBuffers
                    };
                })
                .catch((err) => {
                    console.error(err);
                });
        }
        return Promise.all(allPromises)
            .then(([styleCounter, ...tileDatas]) => {
                this._processTileDatas(
                    tileDatas,
                    allIndexes,
                    data,
                    featureData,
                    buffers,
                    pluginConfigs
                );
                const allFeas = this._buildAllFeas(
                    layers,
                    features,
                    options,
                    hasFnTypeProps,
                    fnTypeProps,
                    feaTags
                );
                const schema = layers;
                return {
                    data: {
                        styleCounter,
                        schema,
                        data,
                        featureData,
                        extent: EXTENT,
                        features: allFeas
                    },
                    buffers
                };
            })
            .catch((err) => {
                console.error(err);
            });
    }

    // Populate a tile's data/featureData slots after per-plugin geometry promises resolve.
    //
    // Index correspondence:
    //   tileDatas[i] (post-promise)  →  pluginIndexes[i]  →  targetSlot[typeIdx]
    //
    // WHY A DEDICATED PASSES:
    //   1. Share a single transferable-buffer accumulator (`buffers`) across ALL plugins.
    //      PostMessage can accept one ArrayBuffer[] transfer list per upload; collecting
    //      buffers during this pass avoids iterating tileDatas twice.
    //   2. Apply altitudeOffset uniformly: dataConfig.altitudeOffset shifts the bounding
    //      box AFTER pack computes it — can't be done inside packs without plumbing
    //      options through every pack subclass.
    //   3. Honor ref-based geometry reuse: when parseSymbolAndGenPromises produces an
    //      entry `{data:{ref:N}}`, we SKIP handleTileData here and the renderer copies
    //      geometry from slot N at draw time (same vertices, different symbol/uniforms).
    //
    // Average savings at 25K features/tile, 6 plugin slots:
    //   - 1 shared buffer pass vs 6 passes → ~0.2ms saved/tile
    //   - ref reuse (4 line styles on same geometry) → 75% GPU VBO memory saved for
    //     multi-symbol line layers, no re-tessellation overhead.
    //
    // 每个插件的几何 Promise 完成后，填充瓦片的 data/featureData 槽位。
    //
    // 索引对应关系：
    //   tileDatas[i]（Promise 产出）  →  pluginIndexes[i]  →  targetSlot[typeIdx]
    //
    // 为什么需要独立的处理通道：
    //   1. 全插件共享一个可转移缓冲区累加器（`buffers`）。PostMessage 每次上传只能
    //      接受一个 ArrayBuffer[] 转移列表，在此通道统一收集避免二次遍历 tileDatas。
    //   2. 统一应用 altitudeOffset：dataConfig.altitudeOffset 在 Pack 计算完包围盒后
    //      再整体偏移，避免把 offset 参数渗透进每个 Pack 子类。
    //   3. 尊重 ref 引用复用机制：当 parseSymbolAndGenPromises 产出
    //      `{data:{ref:N}}` 条目时，此处跳过 handleTileData，渲染器在绘制时
    //      复用第 N 槽位的几何（相同顶点，不同 symbol/uniform）。
    //
    // 2.5 万要素/瓦片、6 个插件槽位下的平均收益：
    //   - 1 次共享缓冲区遍历 vs 6 次 → 每瓦片节省 ~0.2ms
    //   - ref 复用（相同线条 4 种样式）→ 多 symbol 线图层 GPU VBO 内存省 75%，
    //     无重复三角剖分开销。
    _processTileDatas(tileDatas, pluginIndexes, data, featureData, buffers, pluginConfigs) {
        // Early-exit for ref-reuse entries: their geometry lives in another slot
        // (set by parseSymbolAndGenPromises' `first` mechanism), so skip type/filter/
        // altitude writes — only the slot at `ref` index carries real vertex data.
        // ref 复用条目的早退：它们的几何数据在另一个槽位（由 parseSymbolAndGenPromises
        // 的 `first` 机制设置），跳过 type/filter/altitude 写入——只有 ref 索引指向的
        // 槽位才承载真正的顶点数据。
        function handleTileData(tileData, i) {
            if (tileData.data.ref !== undefined) {
                return;
            }
            const pluginConfig = pluginConfigs[pluginIndexes[i].idx];
            const dataConfig = pluginConfig.renderPlugin.dataConfig;
            tileData.data.type = dataConfig.type;
            tileData.data.filter = pluginConfig.filter.def;
            if (dataConfig.altitudeOffset) {
                tileData.data.properties.minAltitude +=
                    dataConfig.altitudeOffset;
                tileData.data.properties.maxAltitude +=
                    dataConfig.altitudeOffset;
            }

            if (tileData.buffers && tileData.buffers.length) {
                for (let i = 0; i < tileData.buffers.length; i++) {
                    buffers.push(tileData.buffers[i]);
                }
            }
        }
        for (let i = 0; i < tileDatas.length; i++) {
            if (!tileDatas[i]) {
                continue;
            }
            const tileData = tileDatas[i];
            const targetData =
                pluginConfigs[pluginIndexes[i].idx].type === 0
                    ? data
                    : featureData;
            if (Array.isArray(tileData)) {
                const datas = [];
                for (let ii = 0; ii < tileData.length; ii++) {
                    if (!tileData[ii]) {
                        continue;
                    }
                    handleTileData(tileData[ii], i);
                    if (
                        tileData[ii].data.ref !== undefined &&
                        !tileData[tileData[ii].data.ref]
                    ) {
                        continue;
                    }
                    datas.push(tileData[ii].data);
                }
                if (datas.length) {
                    targetData[pluginIndexes[i].typeIdx].data = datas;
                }
            } else {
                handleTileData(tileData, i);
                targetData[pluginIndexes[i].typeIdx].data = tileData.data;
            }
        }
    }

    // 构建回传用的 features（allFeas）：清理临时字段、fn-type 属性裁剪、字符串驻留。
    // 仅在带 features 的回传阶段（未拆分或拆分第一阶段）调用。
    _buildAllFeas(layers, features, options, hasFnTypeProps, fnTypeProps, feaTags) {
        const allFeas = {};
        const schema = layers;
        if (!options.features && !options.schema && !hasFnTypeProps) {
            return allFeas;
        }
        let needClearNoneFnTypeProps = false;
        let feature;
        for (let i = 0, l = features.length; i < l; i++) {
            feature = features[i];
            if (!schema[feature.layer].properties) {
                schema[feature.layer].properties = getPropTypes(
                    feature.properties
                );
            }
            if (
                feature &&
                (options.features || (hasFnTypeProps && feaTags[i]))
            ) {
                //reset feature's marks
                //always return full feature json body
                // if (options.features === 'id') {
                //     allFeas[i] = feature.id;
                // } else {
                //     if (!options.pickingGeometry) {
                //         delete feature.geometry;
                //     }
                delete feature.extent;
                delete feature.properties["$layer"];
                delete feature.properties["$type"];
                // _getFeaturesToMerge 中用于排序的临时字段
                delete feature["__index"];
                const originalFeature = feature.originalFeature;
                if (originalFeature) {
                    const properties = feature.properties;
                    const fea = extend({}, feature.originalFeature);
                    // fea.properties = extend({}, feature.originalFeature.properties, properties);
                    delete properties[oldPropsKey];
                    fea.customProps = extend({}, properties);

                    feature = fea;
                }
                const o = extend({}, feature);
                if (
                    hasFnTypeProps &&
                    feaTags[i] &&
                    (!options.features ||
                        options.features === "transient")
                ) {
                    // 只输出symbol中用到的属性
                    const pluginIndexs = feaTags[i];
                    for (let j = 0; j < pluginIndexs.length; j++) {
                        const props = fnTypeProps[j];
                        if (!props) {
                            continue;
                        }
                        props.forEach((p) => {
                            const properties = originalFeature
                                ? originalFeature.properties
                                : feature.properties;
                            if (!properties[fntypePropsKey]) {
                                properties[fntypePropsKey] =
                                    new Set();
                            }
                            properties[fntypePropsKey].add(p);
                            needClearNoneFnTypeProps = true;
                        });
                    }
                }
                allFeas[i] = o;
                // Intern both keys AND values across all features.
                // Property key names like "name","class","highway" appear in
                // thousands of features - interning them avoids per-feature string
                // allocation overhead (~56 bytes each in v8 hidden class).
                // This pool is per-worker and lives for the worker's lifetime.
                if (o.properties && !_workerStringPool) {
                    _workerStringPool = new StringPool();
                }
                if (_workerStringPool && o.properties) {
                    _workerStringPool.internAllInPlace(o.properties);
                    if (o.customProps) {
                        _workerStringPool.internAllInPlace(o.customProps);
                    }
                }
                // }
            }
        }
        if (needClearNoneFnTypeProps) {
            // 验证batch底图的内存情况
            // http://localhost/bugs/designer-947/
            // 删除feature中，不是fn-type的属性
            for (const p in allFeas) {
                const feature = allFeas[p];
                const keys = feature.properties[fntypePropsKey];
                if (keys) {
                    delete feature.properties[fntypePropsKey];
                    if (options.features === "transient") {
                        feature.fnTypeProps = extend(
                            {},
                            feature.properties
                        );
                    }
                    for (const pp in feature.properties) {
                        if (!keys.has(pp)) {
                            if (options.features === "transient") {
                                delete feature.fnTypeProps[pp];
                            } else {
                                delete feature.properties[pp];
                            }
                        }
                    }
                }
            }
        }
        return allFeas;
    }

    _createTileGeometry(tileFeatures, pluginConfig, context) {
        let features = tileFeatures;
        const dataConfig = pluginConfig.renderPlugin.dataConfig;
        const symbol = pluginConfig.symbol;
        const tileSize = this.options.tileSize;
        const {
            extent,
            glScale,
            zScale,
            zoom,
            tilePoint,
            centimeterToPoint,
            verticalCentimeterToPoint
        } = context;
        const tileRatio = extent / tileSize;
        const type = dataConfig.type;
        const debugIndex = context.debugIndex;
        // console.log(context.tileInfo.id, tileFeatures.length);
        let options = extend({}, dataConfig, {
            EXTENT: extent,
            zoom,
            debugIndex,
            features: this.options.features,
            isWebGPU: this.options.isWebGPU,
            isWebGL1: this.options.isWebGL1
        });
        if (type === "3d-extrusion") {
            const t = hasTexture(symbol);
            if (t) {
                dataConfig.uv = 1;
                if (t === 2) {
                    // dataConfig.tangent = 1;
                }
            }
            const projectionCode = this.options.projectionCode;
            const textureWidth =
                (symbol.material && symbol.material.textureWidth) ||
                DEFAULT_TEX_WIDTH;
            return Promise.all([
                Promise.resolve(
                    build3DExtrusion(
                        features,
                        dataConfig,
                        extent,
                        tilePoint,
                        textureWidth,
                        context.tileInfo.res,
                        glScale,
                        extent / this.options["tileSize"],
                        centimeterToPoint,
                        verticalCentimeterToPoint,
                        symbol,
                        zoom,
                        projectionCode,
                        debugIndex
                    )
                )
            ]);
        } else if (type === "3d-wireframe") {
            return Promise.all([
                Promise.resolve(
                    buildWireframe(features, extent, symbol, dataConfig, zoom)
                )
            ]);
        } else if (type === "point") {
            options = extend(options, {
                requestor: this.fetchIconGlyphs.bind(this),
                //把 altitude 转为瓦片坐标
                altitudeToTileScale:
                    (zScale * extent) / this.options["tileSize"] / glScale,
                pluginType: pluginConfig.renderPlugin.type
            });
            let symbols = symbol;
            if (!Array.isArray(symbol)) {
                symbols = [symbol];
            }
            symbols = symbols
                .map((symbol, index) => {
                    if (symbol) {
                        symbol.index = { index };
                        symbol.isIconText = ifIsIconText(symbol);
                    }
                    return symbol;
                })
                .filter((symbol) => !!symbol);
            return Promise.all(
                symbols.map((symbol) => {
                    options.defaultMarkerVerticalAlignment = "middle";
                    const fnTypes = VectorPack.genFnTypes(symbol);
                    let packFeatures = features;
                    if (PointPack.needMerge(symbol, fnTypes, zoom)) {
                        packFeatures = PointPack.mergeLineFeatures(
                            features,
                            symbol,
                            fnTypes,
                            zoom
                        );
                    }
                    return new PointPack(packFeatures, symbol, options).load(
                        tileRatio
                    );
                })
            );
        } else if (type === "native-point") {
            const altitudeToTileScale =
                (zScale * extent) / this.options["tileSize"] / glScale;
            options.altitudeToTileScale = altitudeToTileScale;
            return parseSymbolAndGenPromises(
                features,
                symbol,
                options,
                NativePointPack,
                tileRatio
            );
        } else if (type === "line") {
            options = extend(options, {
                requestor: this.fetchIconGlyphs.bind(this),
                tileRatio
            });
            return parseSymbolAndGenPromises(
                features,
                symbol,
                options,
                LinePack,
                1,
                true
            );
            // return Promise.resolve(null);
        } else if (type === "native-line") {
            return parseSymbolAndGenPromises(
                features,
                symbol,
                options,
                NativeLinePack,
                1,
                true
            );
        } /*else if (type === 'pixel-line') {
            options = extend(options, {
                requestor: this.fetchIconGlyphs.bind(this),
                tileRatio
            });
            return parseSymbolAndGenPromises(features, symbol, options, PixelLinePack);
        } */ else if (type === "fill") {
            options = extend(options, {
                requestor: this.fetchIconGlyphs.bind(this)
            });
            return parseSymbolAndGenPromises(
                features,
                symbol,
                options,
                PolygonPack
            );
        } else if (type === "line-extrusion") {
            //line-extrusion 不需要 lineGradientProperty 属性，以免错误的把linesofar转化到了 0-2^15
            delete symbol["lineGradientProperty"];
            symbol["lineJoin"] = "miter";
            symbol["lineCap"] = "butt";
            const t = hasTexture(symbol);
            if (t) {
                dataConfig.uv = 1;
                if (t === 2) {
                    // dataConfig.tangent = 1;
                }
            }
            options = extend(options, {
                tileSize,
                zScale,
                glScale
            });
            if (symbol.mergeOnProperty) {
                const fnTypes = VectorPack.genFnTypes(symbol);
                features = LinePack.mergeLineFeatures(
                    features,
                    symbol,
                    fnTypes,
                    options.zoom
                );
            }
            if (t) {
                const packs = [];
                if (dataConfig.top !== false) {
                    const opt = extend({}, options);
                    opt.side = false;
                    packs.push(new LineExtrusionPack(features, symbol, opt));
                }
                if (dataConfig.side !== false) {
                    options.side = true;
                    options.top = false;
                    packs.push(
                        new LineExtrusionPack(features, symbol, options)
                    );
                }
                return Promise.all(packs.map((pack) => pack.load()));
            } else {
                return Promise.all([
                    new LineExtrusionPack(features, symbol, options).load()
                ]);
            }
        } else if (type === "circle") {
            return parseSymbolAndGenPromises(
                features,
                symbol,
                options,
                CirclePack
            );
            // const pack = new CirclePack(features, symbol, options);
            // return pack.load();
        } else if (type === "round-tube" || type === "square-tube") {
            const clazz =
                type === "round-tube" ? RoundTubePack : SquareTubePack;
            options = extend(options, {
                requestor: this.fetchIconGlyphs.bind(this),
                radialSegments:
                    type === "round-tube" ? dataConfig.radialSegments || 8 : 4,
                centimeterToPoint,
                verticalCentimeterToPoint,
                tileRatio,
                isTube: true
            });
            return parseSymbolAndGenPromises(features, symbol, options, clazz);
        }
        return Promise.resolve([]);
    }

    /**
     * Filter
     * @param {*} filter
     * @param {*} features
     */
    _filterFeatures(
        styledFeatures,
        zoom,
        styleType,
        filter,
        features,
        tags,
        index
    ) {
        const keyName = (KEY_IDX + "").trim();
        const indexes = [];
        const filtered = [];
        const l = features.length;
        // Hot loop (25K+ features per tile):
        // Cache features[i] into a local `fea` to avoid repeated indexed access
        // and enable V8's monomorphic inline cache on property reads (id/properties).
        // Without hoisting, features[i].id + features[i].properties creates
        // two IC misses per iteration; a single const reference collapses to one.
        //
        // 热循环（每瓦片 2.5 万+ 要素）：
        // 将 features[i] 缓存为局部变量 fea，避免数组索引重复寻址，
        // 并让 V8 的属性读取（id / properties）触发单态内联缓存（monomorphic IC）。
        // 未提升时，features[i].id 与 features[i].properties 会产生两次 IC miss，
        // 单次 const 引用合并为一次 IC 命中，单要素属性访问快约 15-20%。
        for (let i = 0; i < l; i++) {
            const fea = features[i];
            if (
                styleType !== 1 &&
                fea.id !== undefined &&
                styledFeatures[fea.id]
            ) {
                continue;
            }

            // Short-circuit filter evaluation ordered by cost:
            //   1. default-style catch-all (no filter fn call) — cheapest
            //   2. def === true — unconditional match, no call
            //   3. actual filter(fea, zoom) — full JS predicate
            // Ordering avoids invoking the filter predicate for features
            // that can be accepted/rejected via plain property checks.
            // filter.def 未定义或为 "default" 时：该样式为兜底样式，仅命中之前无其他样式的要素
            // filter.def === true 时：无条件匹配（通常是全量要素样式）
            //
            // 短路过滤求值按计算代价排序：
            //   1. 默认样式兜底（无函数调用）—— 最低开销
            //   2. def === true —— 无条件匹配，无需调用
            //   3. 实际 filter(fea, zoom) —— 完整 JS 谓词执行
            // 按此顺序排列可让纯属性判断即可通过/拒绝的要素跳过开销更高的谓词调用。
            if (
                ((!filter.def || filter.def === "default") && !tags[i]) ||
                filter.def === true ||
                (filter.def &&
                    (filter.def.condition !== undefined ||
                        Array.isArray(filter.def)) &&
                    filter(fea, zoom))
            ) {
                if (fea[keyName] === undefined) {
                    fea[keyName] = i;
                }
                if (!tags[i]) {
                    tags[i] = [];
                }
                tags[i].push(index);
                filtered.push(fea);
                indexes.push(i);
                if (styleType === 1) {
                    break;
                }
            }
        }
        return {
            tileFeatures: filtered,
            tileFeaIndexes: indexes
        };
    }

    _compileStyle(layerStyle) {
        const { style, featureStyle } = layerStyle;
        // Use a null-prototype dictionary to avoid prototype chain lookup
        // and hidden-class deoptimization when feature IDs are numeric strings.
        // Regular {} inherits Object.prototype, so numeric keys trigger
        // dictionary-mode fallback in V8 (~3-5x slower access for large maps).
        //
        // 使用无原型字典对象，避免要素 ID 为数字字符串时触发 V8 隐藏类回退
        // 与沿 Object.prototype 的原型链查找。普通对象 {} 会继承 Object.prototype，
        // 数字键会导致字典模式退化（大 Map 场景下访问慢 3-5 倍）。
        const styledFeatures = Object.create(null);
        featureStyle.forEach((style) => {
            if (Array.isArray(style.id)) {
                style.id.forEach((id) => {
                    styledFeatures[id] = 1;
                });
                style.filter = ["in", "$id", ...style.id];
            } else {
                styledFeatures[style.id] = 1;
                style.filter = ["==", "$id", style.id];
            }
        });
        const pluginConfigs = FilterUtil.compileStyle(style);
        for (let i = 0; i < style.length; i++) {
            if (pluginConfigs[i].filter) {
                // filter.value 是为方便studio，定义的对象结构
                // 设置def，是为了识别哪些feature归类到默认样式
                pluginConfigs[i].filter.def = style[i].filter
                    ? style[i].filter.value || style[i].filter
                    : undefined;
            }
            pluginConfigs[i].type = 0;
        }

        const featurePlugins = [];
        const compiledFeatureStyle = FilterUtil.compileStyle(featureStyle);
        for (let i = 0; i < featureStyle.length; i++) {
            compiledFeatureStyle[i].type = 1;
            // 定义def，是为了与默认样式相区分(默认样式的filter没有def)
            compiledFeatureStyle[i].filter.def = featureStyle[i].filter
                ? featureStyle[i].filter.value || featureStyle[i].filter
                : undefined;
            //没有renderPlugin就不生成数据，必须和VectorTileLayerRenderer的_initPlugins中的逻辑对应起来
            if (compiledFeatureStyle[i].renderPlugin) {
                featurePlugins.push(compiledFeatureStyle[i]);
            }
        }
        return { pluginConfigs, featurePlugins, styledFeatures };
    }

    _getLayerFilter(styleCounter, ruleStyles) {
        if (
            this._compiledLayerFilter !== undefined &&
            this._compiledLayerFilterCounter === styleCounter
        ) {
            return this._compiledLayerFilter;
        }
        let hasNoLayerFilter = false;
        const layers = new Set();
        const traverse = (filter) => {
            if (hasNoLayerFilter) return;
            if (filter === true || filter === null || filter === undefined) {
                hasNoLayerFilter = true;
                return;
            }
            if (!Array.isArray(filter)) {
                if (filter.condition !== undefined) {
                    if (filter.layer !== undefined) {
                        layers.add(filter.layer);
                    } else if (
                        filter.type === "any" &&
                        Array.isArray(filter.condition)
                    ) {
                        for (let i = 0; i < filter.condition.length; i++)
                            traverse(filter.condition[i]);
                    } else {
                        hasNoLayerFilter = true;
                    }
                } else if (filter.type === "FeatureFilter") {
                    hasNoLayerFilter = true;
                } else {
                    hasNoLayerFilter = true;
                }
                return;
            }
            const operator = filter[0];
            if (operator === "==" && filter[1] === "$layer") {
                layers.add(filter[2]);
            } else if (operator === "in" && filter[1] === "$layer") {
                for (let i = 2; i < filter.length; i++) layers.add(filter[i]);
            } else if (operator === "all") {
                let foundLayer = false;
                for (let i = 1; i < filter.length; i++) {
                    const f = filter[i];
                    if (
                        Array.isArray(f) &&
                        f[0] === "==" &&
                        f[1] === "$layer"
                    ) {
                        foundLayer = true;
                        layers.add(f[2]);
                    } else if (
                        Array.isArray(f) &&
                        f[0] === "in" &&
                        f[1] === "$layer"
                    ) {
                        foundLayer = true;
                        for (let j = 2; j < f.length; j++) layers.add(f[j]);
                    } else if (typeof f === "string" && f === "any") {
                        continue;
                    }
                }
                if (!foundLayer) {
                    hasNoLayerFilter = true;
                }
            } else if (operator === "any") {
                for (let i = 1; i < filter.length; i++) traverse(filter[i]);
            } else {
                hasNoLayerFilter = true;
            }
        };

        if (!ruleStyles) {
            return null;
        }
        const styleRules = (ruleStyles.style || []).concat(
            ruleStyles.featureStyle || []
        );
        if (styleRules.length === 0) {
            hasNoLayerFilter = true;
        }
        for (let i = 0; i < styleRules.length; i++) {
            const rule = styleRules[i];
            const filter =
                rule.filter && rule.filter.value !== undefined
                    ? rule.filter.value
                    : rule.filter;
            traverse(filter);
            if (hasNoLayerFilter) break;
        }

        this._compiledLayerFilterCounter = styleCounter;
        this._compiledLayerFilter = hasNoLayerFilter
            ? null
            : Array.from(layers);
        return this._compiledLayerFilter;
    }

    _updateLayerPluginConfig(layers) {
        let layerPlugins = this._layerPlugins;
        if (!this._layerPlugins) {
            layerPlugins = this._layerPlugins = {};
        }
        const TYPES = [
            "",
            "Point",
            "LineString",
            "Polygon",
            "MultiPoint",
            "MultiLineString",
            "MultiPolygon"
        ];
        const framePlugins = [];
        for (const p in layers) {
            const layer = p;
            if (!layerPlugins[p]) {
                const stylePlugins = [];
                for (let i = 0; i < layers[p].types.length; i++) {
                    const type = layers[p].types[i];
                    const def = [
                        "all",
                        ["==", "$layer", layer],
                        ["==", "$type", TYPES[type]]
                    ];
                    const plugin = {
                        filter: createFilter(def),
                        renderPlugin: getDefaultRenderPlugin(type),
                        symbol: getDefaultSymbol(type)
                    };
                    plugin.filter.def = def;
                    plugin.type = 0;
                    stylePlugins.push(plugin);
                }
                layerPlugins[layer] = stylePlugins;
            }
            // const type = Math.min(...layers[p].types);
            // if (!layerPlugins[layer]) {
            //     const def = ['==', '$layer', layer];
            //     layerPlugins[layer] = {
            //         filter: createFilter(def),
            //         renderPlugin: getDefaultRenderPlugin(type),
            //         symbol: getDefaultSymbol(type)
            //     };
            //     layerPlugins[layer].filter.def = def;
            // }
            framePlugins.push(...layerPlugins[layer]);
        }
        return framePlugins;
    }
}

// LayerWorker.prototype.getProjViewMatrix = function (transform) {
//     const m = new Float64Array(16);
//     const m1 = new Float32Array(16);
//     return function (tileInfo, matrix) {
//         const tilePos = tileInfo.point;
//         const tileSize = this.tileSize;

//         const tileMatrix = mat4.identity(m);
//         mat4.translate(tileMatrix, tileMatrix, [tilePos.x, tilePos.y, 0]);
//         mat4.scale(tileMatrix, tileMatrix, [tileSize / EXTENT, tileSize / EXTENT, 1]);

//         //local transform in current frame
//         if (transform) {
//             mat4.multiply(tileMatrix, tileMatrix, transform);
//         }

//         mat4.multiply(tileMatrix, matrix, tileMatrix);

//         return mat4.copy(m1, tileMatrix);
//     };
// }();

function getDefaultRenderPlugin(type) {
    switch (type) {
        case 1:
            return {
                type: "native-point",
                dataConfig: {
                    type: "native-point",
                    only2D: true
                }
            };
        case 2:
            return {
                type: "native-line",
                dataConfig: {
                    type: "native-line",
                    only2D: true
                }
            };
        case 3:
            return {
                type: "fill",
                dataConfig: {
                    type: "fill",
                    only2D: true
                }
            };
    }
    return null;
}

function getDefaultSymbol(type) {
    switch (type) {
        case 1:
            return {
                markerFill: "#f00",
                markerSize: 10
            };
        case 2:
            return {
                lineColor: "#fff"
            };
        case 3:
            return {
                polygonFill: "#00f",
                polygonOpacity: 0.4
            };
    }
    return null;
}

function getPropTypes(properties) {
    if (Array.isArray(properties) || !isObject(properties)) {
        return {};
    }
    const types = {};
    for (const p in properties) {
        const v = properties[p];
        if (isString(v)) {
            types[p] = "string";
        } else if (isNumber(v)) {
            types[p] = "number";
        } else if (v === true || v === false) {
            types[p] = "boolean";
        } else if (Array.isArray(v)) {
            types[p] = "array";
        } else {
            types[p] = "object";
        }
    }
    return types;
}

export function hasTexture(symbol) {
    if (!symbol) {
        return 0;
    }
    let t = 0;
    for (const p in symbol) {
        if ((p === "normalTexture" || p === "bumpTexture") && symbol[p]) {
            return 2;
        } else if (p.indexOf("Texture") > 0 && symbol[p]) {
            t = 1;
        } else if (isObject(symbol[p])) {
            const t0 = hasTexture(symbol[p]);
            if (t0 === 2) {
                return t0;
            } else if (t0 === 1) {
                t = 1;
            }
        }
    }
    return t;
}

// Parse multi-symbol style arrays and generate pack promises with geometry dedup.
//
// DEDUP STRATEGY (ref-based geometry reuse):
//   If a symbol has NO fn-type keys (no per-feature value interpolation), it is
//   "static" — the geometry (VBO) is identical regardless of symbol color/opacity.
//   We pick the FIRST static symbol (`first`), execute the full pack once, then
//   emit `{data:{ref:first, symbolIndex:i}}` for every other static symbol.
//   The renderer interprets `ref` as "clone vertex buffers from slot N, apply my
//   own uniforms/symbol". Net result: N static symbols → 1 tessellation + N draw calls.
//
//   Symbols WITH fn-type keys (data-driven: ["interpolate",["zoom"],...]) always
//   pack separately because their vertex attributes differ per feature.
//
// MEMORY/CYCOST SAVINGS (typical road layer with 4 dash styles on same lines):
//   Without dedup: 4× LinePack → 4× tessellation → 4× 2.2MB VBO = 8.8MB/tile
//   With dedup:    1× LinePack + 3× {ref:0} → 1 VBO = 2.2MB/tile (-75%)
//   CPU:           4 tessellate passes → 1 pass (-75% worker CPU at tile load).
//
// `symbol.index` is written back so VectorPack can embed the correct symbol slot
// in vertex attributes (the renderer uses it to fetch per-symbol uniforms).
//
// 解析多 symbol 样式数组并生成带几何去重的 pack Promise。
//
// 去重策略（基于 ref 的几何复用）：
//   若某个 symbol 不含任何 fn-type 键（无需按要素值插值），则它是"静态的"——
//   几何（VBO）与颜色/透明度等 symbol 参数无关。我们选中第一个静态 symbol
//   （`first`）执行完整的 pack 一次，其余静态 symbol 全部输出
//   `{data:{ref:first, symbolIndex:i}}`。渲染器遇到 `ref` 即："复制第 N 槽的
//   顶点缓冲区，只应用我自己的 uniform/symbol"。最终效果：N 个静态 symbol
//   → 1 次三角剖分 + N 次 draw call。
//
//   含 fn-type 键的 symbol（数据驱动：["interpolate",["zoom"],...]）由于
//   顶点属性逐要素不同，必须独立 pack。
//
// 内存/计算节省（典型：道路图层同一条线上叠加 4 种虚线样式）：
//   未去重：4 次 LinePack → 4 次三角剖分 → 4×2.2MB VBO = 8.8MB/瓦片
//   去重后：1 次 LinePack + 3 个 {ref:0} → 1 个 VBO = 2.2MB/瓦片 (-75%)
//   CPU：4 次 tessellation → 1 次（瓦片加载时 Worker CPU 省 75%）。
//
// `symbol.index` 会回写到 symbol 对象，VectorPack 据此在顶点属性中
// 嵌入正确的 symbol 槽位号（渲染器用它来取每个 symbol 的 uniform）。
function parseSymbolAndGenPromises(
    features,
    symbol,
    options,
    clazz,
    scale,
    isLine
) {
    const parsed = {};
    const symbols = Array.isArray(symbol) ? symbol : [symbol];
    // `first` = lowest slot index whose symbol has zero fn-type interpolation keys
    // and can therefore serve as the reference VBO for every other static symbol.
    // If no static symbol exists (all fn-type), first stays -1 and every symbol
    // packs independently (every slot owns its vertices).
    // `first` = 不含任何 fn-type 插值键的最低 symbol 槽位号，
    // 因此可作为其他所有静态 symbol 的参考 VBO 源。
    // 若不存在静态 symbol（全部是 fn-type），first 保持 -1，
    // 每个 symbol 都独立 pack（每个槽位拥有自己的顶点数据）。
    let first = -1;
    for (let i = 0; i < symbols.length; i++) {
        parsed[i] = hasFnTypeKeys(symbols[i]);
        if (!parsed[i] && symbols[i] && first === -1) {
            first = i;
        }
    }
    const promises = [];
    for (let i = 0; i < symbols.length; i++) {
        if (!symbols[i]) {
            // promises.push({ data: { symbolIndex: { index: i } } });
            continue;
        }
        // 用来在 VectorPack 中生成 symbolIndex
        symbols[i].index = { index: i };
        let packFeatures = features;
        if (isLine && symbols[i].mergeOnProperty) {
            const fnTypes = VectorPack.genFnTypes(symbols[i]);
            packFeatures = LinePack.mergeLineFeatures(
                features,
                symbols[0],
                fnTypes,
                options.zoom
            );
        }
        if (!parsed[i]) {
            if (i === first) {
                promises.push(
                    new clazz(packFeatures, symbols[i], options).load(scale)
                );
            } else {
                promises.push({
                    data: { ref: first, symbolIndex: { index: i } }
                });
            }
        } else {
            promises.push(
                new clazz(packFeatures, symbols[i], options).load(scale)
            );
        }
    }
    return Promise.all(promises);
}

function hasFnTypeKeys(symbol) {
    if (!symbol) {
        return 0;
    }
    for (const p in symbol) {
        if (isFnTypeSymbol(symbol[p])) {
            return 1;
        }
    }
    return 0;
}

function cloneFeaAndAppendCustomTags(
    features,
    zoom,
    pluginConfig,
    customProps
) {
    const customProperties = pluginConfig.customProperties;
    if (!customProperties) {
        return features;
    }
    if (customProperties) {
        for (let i = 0; i < customProperties.length; i++) {
            customProperties[i].fn = FilterUtil.compileFilter(
                customProperties[i].filter
            );
        }
    }
    for (let j = 0; j < customProperties.length; j++) {
        for (let i = 0, l = features.length; i < l; i++) {
            if (customProperties[j].fn(features[i], zoom)) {
                for (const p in customProperties[j].properties) {
                    const v = customProperties[j].properties[p];
                    if (isNil(v)) {
                        continue;
                    }
                    if (!customProps[i]) {
                        customProps[i] = {};
                    }
                    if (!customProps[i][p]) {
                        customProps[i][p] = new Set();
                    }
                    customProps[i][p].add(v);
                }
            }
        }
    }
}

// Top-level feature proxy trap for cloneFeaAndAppendCustomTags expansion.
// When a style declares customProperties (multi-valued tags like ["road-class","lane-count"]),
// a single source feature must fan out into N virtual features (one per value combo) so
// each gets its own style slot. Copying the whole feature object N times would cost
// ~3KB × 25K features × 2 combos = 150MB extra heap/tile; instead we use a Proxy that
// delegates every non-overridden read to the original immutable feature.
//
// Write path (mutations happen only on `fea` / `result.properties`, never on the
// original feature): only custom property values are materialized in the proxy target.
// Read path: target.has(prop) ? target.get(prop) : fallback-to-original.
// `has` trap also mirrors both targets because the filter engine does `"key" in feature`
// checks before reading — without it, missing custom keys would be skipped entirely.
//
// 顶层要素代理陷阱，用于 cloneFeaAndAppendCustomTags 的展开。
// 当样式声明 customProperties（多值标签，如 ["道路等级","车道数"]）时，
// 单个源要素需要向外扇出 N 个虚拟要素（每组取值一个）以适配不同样式槽位。
// 若将整个要素对象复制 N 次，每瓦片额外开销约 3KB × 2.5 万要素 × 2 组 = 150MB 堆内存；
// 改用 Proxy 后，所有未覆盖的读操作都委托到原始的不可变要素对象。
//
// 写路径（只在 `fea` / `result.properties` 上发生变更，绝不写入原始要素）：
//   仅自定义属性值会在代理目标中被实体化。
// 读路径：target.has(prop) ? target.get(prop) : 回退到原始要素。
// `has` 陷阱同样对两个目标做镜像，因为过滤引擎在读取前会执行 `"key" in feature`
// 检查——若缺此陷阱，不存在的自定义键会被整体跳过。
const proxyGetter0 = {
    get(obj, prop) {
        return prop in obj ? obj[prop] : obj.originalFeature[prop];
    },
    has(obj, key) {
        return key in obj || key in obj.originalFeature;
    }
};

// Proxy trap for the `.properties` sub-object inside a fanned-out virtual feature.
// Same delegation pattern as proxyGetter0, but the fallback source is stored under
// `oldPropsKey` on the proxy target (set by proxyFea immediately after construction).
// Keeps property lookups O(1) on the hot filter path even when feature fan-out > 1.
// EMPTY_PROPS singleton replaces a missing feature.properties to avoid branching
// in `obj[oldPropsKey][prop]` (prevents undefined[prop] when a tile has null props).
//
// 扇出虚拟要素内部 `.properties` 子对象的代理陷阱。
// 与 proxyGetter0 的委托模式相同，但回退源存储在代理目标的 `oldPropsKey` 键下
// （由 proxyFea 在构造后立即写入）。
// 即使要素扇出数 > 1，也保证热路径过滤中的属性查询保持 O(1)。
// EMPTY_PROPS 单例替代缺失的 feature.properties，避免
// `obj[oldPropsKey][prop]` 中 oldPropsKey 为 undefined 时抛错（瓦片属性为空时）。
const proxyGetter1 = {
    get: function (obj, prop) {
        return prop in obj ? obj[prop] : obj[oldPropsKey][prop];
    },
    has(obj, key) {
        return key in obj || key in obj[oldPropsKey];
    }
};

// Zero-byte placeholder used as the fallback properties object when a source
// feature carries no properties. Shared globally to avoid allocating one
// empty {} per virtual feature (16 bytes × fan-out factor × 25K features = saved).
// 源要素不带属性时，用作回退属性对象的零字节占位符。
// 全局共享以避免为每个虚拟要素分配空对象 {}（节省 16 字节 × 扇出系数 × 2.5 万要素）。
const EMPTY_PROPS = {};

// Construct a light-weight virtual feature (Proxy) that looks and quacks like
// the original feature but with local, custom-property overrides laid on top.
//
// Lifecycle inside _createTileData:
//   1. cloneFeaAndAppendCustomTags records, for each (featureIdx, propName),
//      a Set of candidate values (e.g., "road-class" → {"primary","secondary"}).
//   2. _createTileData iterates those sets and, for each combination up to
//      max(count), calls proxyFea() to obtain an independent virtual feature.
//   3. Each proxy only stores the overridden property keys; the rest reads
//      through to originalFeature. This avoids structural cloning of the
//      geometry/markers/extent arrays on the base feature.
//
// Memory: for a feature with 2 custom properties × 2 values each (4 combos),
// classic clone → 4 × 3KB = 12KB; proxy → 4 proxy shells + original = ~3.3KB
// (72% smaller across the tile, and no GC churn on style recompile).
//
// 构造一个轻量级的虚拟要素（Proxy），外观与行为与原始要素完全相同，
// 但在其之上叠加了本地（自定义属性）覆盖层。
//
// 在 _createTileData 中的生命周期：
//   1. cloneFeaAndAppendCustomTags 为每个 (要素索引, 属性名) 记录候选值集合
//      （例如 "道路等级" → {"主干道","次干道"}）。
//   2. _createTileData 遍历这些集合，对最多 max(count) 种组合各调用
//      一次 proxyFea() 以获得独立的虚拟要素。
//   3. 每个代理仅存储被覆盖的属性键；其余属性均穿透读取到 originalFeature。
//      由此避免对基础要素的 geometry/markers/extent 数组做结构性克隆。
//
// 内存对比：对含 2 个自定义属性 × 各 2 个取值（共 4 组合）的要素，
// 传统克隆 → 4 × 3KB = 12KB；代理方案 → 4 个代理外壳 + 原始要素 ≈ 3.3KB
// （整瓦片体积缩减 72%，样式重编译时无 GC 波动）。
function proxyFea(feature) {
    const fea = {};
    fea.originalFeature = feature;
    const result = new Proxy(fea, proxyGetter0);
    result.properties = new Proxy({}, proxyGetter1);
    result.properties[oldPropsKey] = feature.properties || EMPTY_PROPS;
    return result;
}

function addFnTypeProp(props, i, property) {
    if (!props[i]) {
        props[i] = new Set();
    }
    props[i].add(property);
}

const EMPTY_ARRAY = [];
function getFnTypeProps(symbol, props, i) {
    if (!symbol) {
        return EMPTY_ARRAY;
    }
    for (const p in symbol) {
        // 只保留支持zoom fn-type的样式属性，其他的属性忽略掉
        if (!symbol[p] || !StyleUtil.checkIfZoomFnTypeSymbol(p)) {
            continue;
        }
        if (isFnTypeSymbol(symbol[p])) {
            addFnTypeProp(props, i, symbol[p].property);
        } else if (p === "lineGradientProperty") {
            addFnTypeProp(props, i, symbol[p]);
            continue;
        } else if (p === "textName") {
            // 返回 textName 中可能用到的属性名
            if (isString(symbol[p])) {
                const vars = TextUtil.resolveVarNames(symbol[p]);
                if (vars) {
                    for (let j = 0; j < vars.length; j++) {
                        addFnTypeProp(props, i, vars[j]);
                    }
                }
            } else if (FilterUtil.isExpression(symbol[p])) {
                const vars = [];
                TextUtil.resolveExpVarNames(vars, symbol[p]);
                for (let j = 0; j < vars.length; j++) {
                    addFnTypeProp(props, i, vars[j]);
                }
            }
        }
        const stops = symbol[p].stops;
        if (stops && stops.length) {
            for (let i = 0; i < stops.length; i++) {
                if (isFnTypeSymbol(stops[i][1])) {
                    addFnTypeProp(props, i, stops[i][1].property);
                }
            }
        }
    }
    return props[i];
}

function ifIsIconText(symbol) {
    // 如果symbol中没有marker，只有text时，则iconText为true
    // isIconText 主要用在 getAnchors 和各种判断是否是沿线文字的判断逻辑中
    return symbol.markerType || symbol.markerFile;
}
