import * as maptalks from 'maptalks';
import { KEY_IDX } from '../../../common/Constant';
import { extend, isObject, isNil } from '../../../common/Util';
import StringPool from '../../../common/StringPool';

const KEY_IDX_NAME = (KEY_IDX + '').trim();

// feaIndexes是VectorTileLayer中设置过filter时，符合条件的feature的编号，可以为null
export default function convertToPainterFeatures(features, feaIndexes, layerId, symbol, layer, copy, compactStore) {
    const pluginFeas = {};
    if (hasFeature(features)) {
        const data = feaIndexes || features;
        //[feature index, style index]
        for (let ii = 0, ll = data.length; ii < ll; ii++) {
            let feature = feaIndexes ? features[feaIndexes[ii]] : features[ii];
            const isObj = feature && isObject(feature);
            //is GeoJSONVectorTileLayer
            if (layer.getFeature && !isNil(feature)) {
                const featureId = isObj ? feature.id : feature;
                //query feature from main thread,it may be null
                const queryFeature = layer.getFeature(featureId);
                //it may be null
                if (queryFeature) {
                    //customProperties
                    let properties, customProps;
                    if (isObj) {
                        //get properties from worker data
                        properties = feature.properties;
                        customProps = feature.customProps;
                    }
                    feature = queryFeature;
                    feature.layer = layerId;
                    //merge properties
                    mergeFeatureProperties(feature, properties, customProps);
                }
            }
            if (layer instanceof maptalks.TileLayer) {
                if (!isObj && !isNil(feature)) {
                    feature = {
                        id: feature,
                        type: null,
                        properties: {},
                        customProps: {},
                        layer: layerId
                    };
                } else {
                    feature = proxyFea(feature, copy, compactStore);
                }
            }
            const keyIdxValue = feaIndexes ? feaIndexes[ii] : (isObject(feature) && !isNil(feature[KEY_IDX_NAME]) ? feature[KEY_IDX_NAME] : ii);
            pluginFeas[keyIdxValue] = {
                feature,
                symbol
            };
        }
    }
    return pluginFeas;
}

function mergeFeatureProperties(feature, properties, customProps) {
    if (properties || customProps) {
        feature.properties = feature.properties || {};
        //merge customProperties
        extend(feature.properties, properties || {}, customProps || {});
    }
}

function hasFeature(features) {
    if (!features) {
        return false;
    }

    for (const p in features) {
        if (features[p] !== undefined && features[p] !== null) {
            return true;
        }
    }
    return false;
}

export const oldPropsKey = '__original_properties';
export const externalPropsKey = '__external_properties';
export const compactStoreKey = '__compact_store';
export const featureIdKey = '__feature_id';

/**
 * 【性能优化核心：透明代理与属性懒加载】
 * 针对海量管网数据加载时，主线程因反序列化创建巨大 properties 对象而导致的严重阻塞（卡顿）问题，
 * 引入基于 JS Proxy 的列式存储（Compact Store）机制。
 * 1. 拦截对 feature.properties 的 get/has/ownKeys 操作。
 * 2. 渲染管线需要读取属性时，以 O(1) 复杂度从 flat array (store) 中按需读取，实现 Zero Allocation。
 * 3. 兼容 externalPropsKey，无缝支持 setFeatureState 的动态更新，业务层代码零侵入。
 */
const proxyGetter = {
    get: function (obj, prop) {
        if (prop in obj) return obj[prop];
        if (prop in obj[oldPropsKey]) return obj[oldPropsKey][prop];
        if (obj[externalPropsKey] && (prop in obj[externalPropsKey])) {
            return obj[externalPropsKey][prop];
        }
        
        // Read from compactStore
        const store = obj[compactStoreKey];
        if (store && store.__s) {
            const fid = obj[featureIdKey];
            const arr = store[fid];
            if (arr) {
                const schemaMap = store.__s.m;
                if (prop in schemaMap) {
                    const idx = schemaMap[prop];
                    return arr[2 + idx];
                }
            }
        }
        return undefined;
    },
    has: function (obj, prop) {
        if ((prop in obj) || (prop in obj[oldPropsKey]) || (obj[externalPropsKey] && (prop in obj[externalPropsKey]))) return true;
        const store = obj[compactStoreKey];
        if (store && store.__s && (prop in store.__s.m)) {
            const fid = obj[featureIdKey];
            return !!store[fid];
        }
        return false;
    },
    ownKeys: function (obj) {
        const keys = new Set();
        Reflect.ownKeys(obj).forEach(k => {
            if (k !== oldPropsKey && k !== externalPropsKey && k !== compactStoreKey && k !== featureIdKey) keys.add(k);
        });
        if (obj[oldPropsKey]) {
            Object.keys(obj[oldPropsKey]).forEach(k => keys.add(k));
        }
        if (obj[externalPropsKey]) {
            Object.keys(obj[externalPropsKey]).forEach(k => keys.add(k));
        }
        const store = obj[compactStoreKey];
        if (store && store.__s) {
            const fid = obj[featureIdKey];
            if (store[fid]) {
                store.__s.k.forEach(k => keys.add(k));
            }
        }
        return Array.from(keys);
    },
    getOwnPropertyDescriptor: function(obj, prop) {
        if (prop === oldPropsKey || prop === externalPropsKey || prop === compactStoreKey || prop === featureIdKey) {
            return Object.getOwnPropertyDescriptor(obj, prop);
        }
        const hasProp = this.has(obj, prop);
        if (hasProp) {
            return {
                enumerable: true,
                configurable: true,
                value: this.get(obj, prop)
            };
        }
        return undefined;
    }
};

const EMPTY_PROPS = {};

// Shared string pool per process.
// Each VT renderer calls clearStringPool() on destroy to free memory.
let _stringPool = null;
function _getStringPool() {
    if (!_stringPool) {
        _stringPool = new StringPool();
    }
    return _stringPool;
}
export function clearStringPool() {
    if (_stringPool) {
        _stringPool.clear();
        _stringPool = null;
    }
}

// eslint-disable-next-line no-unused-vars
function proxyFea(feature, copy, compactStore) {
    if (!feature || !isObject(feature)) {
        feature = {
            id: feature,
            type: null,
            properties: {},
            customProps: {}
        };
    }
    const originalProperties = feature.properties;
    if (originalProperties && originalProperties[oldPropsKey]) {
        // 已经proxy过了
        return feature;
    }
    // Deduplicate property keys AND values via interning.
    // VT features share the same keys ("name","class","highway") across
    // millions of instances. Without key interning, each feature stores its
    // own string copy, adding ~56 bytes per key in v8 hidden class overhead.
    if (originalProperties) {
        _getStringPool().internAllInPlace(originalProperties);
    }
    if (copy) {
        feature = extend({}, feature);
    }
    feature.customProps = feature.customProps || {};
    const properties = feature.customProps;
    properties['$layer'] = feature.layer;
    properties['$type'] = feature.type;
    properties[oldPropsKey] = originalProperties || EMPTY_PROPS;
    if (compactStore) {
        properties[compactStoreKey] = compactStore;
        properties[featureIdKey] = feature.id;
    }
    // Intern custom properties (keys + values) from fn-type plugins
    if (feature.customProps) {
        _getStringPool().internAllInPlace(feature.customProps);
    }
    feature.properties = new Proxy(properties, proxyGetter);
    return feature;
}
