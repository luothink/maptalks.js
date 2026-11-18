import { isFunctionDefinition, interpolated } from '@maptalks/function-type';
import Color from 'color';

export function now() {
    return Date.now();
}

/**
 * @classdesc
 * Utilities methods used internally. It is static and should not be initiated.
 * @class
 * @static
 * @category core
 * @name Util
 */

/**
 * Merges the properties of sources into destination object.
 * @param  {Object} dest   - object to extend
 * @param  {...Object} src - sources
 * @return {Object}
 * @memberOf Util
 */
export function extend(dest) { // (Object[, Object, ...]) ->
    for (let i = 1; i < arguments.length; i++) {
        const src = arguments[i];
        for (const k in src) {
            dest[k] = src[k];
        }
    }
    return dest;
}

/**
 * Whether the object is null or undefined.
 * @param  {Object}  obj - object
 * @return {Boolean}
 * @memberOf Util
 */
export function isNil(obj) {
    return obj == null;
}

/**
 * Whether val is a number and not a NaN.
 * @param  {Object}  val - val
 * @return {Boolean}
 * @memberOf Util
 */
export function isNumber(val) {
    return (typeof val === 'number') && !isNaN(val);
}

/**
 * Whether a number is an integer
 * @param  {Number}  n
 * @return {Boolean}
 * @memberOf Util
 */
export function isInteger(n) {
    return (n | 0) === n;
}

/**
 * Whether the obj is a javascript object.
 * @param  {Object}  obj  - object
 * @return {Boolean}
 * @memberOf Util
 */
export function isObject(obj) {
    return typeof obj === 'object' && !!obj;
}

/**
 * Check whether the object is a string
 * @param {Object} obj
 * @return {Boolean}
 * @memberOf Util
 */
export function isString(obj) {
    if (isNil(obj)) {
        return false;
    }
    return typeof obj === 'string' || (obj.constructor !== null && obj.constructor === String);
}

/**
 * Check whether the object is a function
 * @param {Object} obj
 * @return {Boolean}
 * @memberOf Util
 */
export function isFunction(obj) {
    if (isNil(obj)) {
        return false;
    }
    return typeof obj === 'function' || (obj.constructor !== null && obj.constructor === Function);
}

const hasOwnProperty = Object.prototype.hasOwnProperty;
/**
 * Check whether the object owns the property.
 * @param  {Object}  obj - object
 * @param  {String}  key - property
 * @return {Boolean}
 * @memberOf Util
 */
export function hasOwn(obj, key) {
    return hasOwnProperty.call(obj, key);
}

/**
 * Join an array, standard or a typed one.
 * @param  {Object[]} arr       array to join
 * @param  {String} seperator  seperator
 * @return {String}           result string
 * @private
 * @memberOf Util
 */
export function join(arr, seperator) {
    if (arr.join) {
        return arr.join(seperator || ',');
    } else {
        return Array.prototype.join.call(arr, seperator || ',');
    }
}

const pi = Math.PI / 180;

export function toRadian(d) {
    return d * pi;
}

export function toDegree(r) {
    return r / pi;
}

export function evaluate(prop, properties, zoom) {
    if (isFunction(prop)) {
        if (zoom !== undefined) {
            return prop(zoom, properties);
        } else {
            return prop(null, properties);
        }
    } else {
        return prop;
    }
}

export function isFnTypeSymbol(v) {
    return v && isFunctionDefinition(v) && v.property;
}

// MapLibre style expression 操作符白名单，用于识别 style 中的 MapLibre expression，
// 例如 ["step", ["number", ["get", "caliber"], 0], 1, 100, 1.2]。
// 这些数组若直接当作普通常量传给 function-type，会导致线宽/颜色无法按要素属性求值。
const MAPLIBRE_EXPRESSION_OPS = {
    'step': 1,         // 阶梯/分段常量函数：不同输入区间返回不同常量
    'interpolate': 1,  // 插值函数（线性/指数）：在输入点之间进行平滑插值
    'match': 1,        // 模式匹配/分类函数：按输入值精确匹配或默认返回
    'get': 1,          // 获取要素属性值（按属性名）
    'number': 1,       // 强制转为数字类型（可带默认值，用于属性缺省兜底）
    'to-number': 1,    // 转换为数字
    'to-color': 1,     // 转换为颜色值（字符串/数组 → RGBA）
    'to-string': 1,    // 转换为字符串
    'to-boolean': 1,   // 转换为布尔值
    'zoom': 1,         // 获取当前地图缩放级别（作为 expression 输入）
    'case': 1,         // 多条件分支（if-elseif-else 链）
    'coalesce': 1,     // 返回首个非 null/undefined 值（链式兜底取值）
    'let': 1,          // 定义局部变量（expression 作用域内可复用）
    'var': 1,          // 引用 'let' 定义的局部变量
    'literal': 1       // 声明字面量数组/对象（不被当作 expression 递归解析）
};

// 判断输入值是否为合法的 MapLibre style expression 格式：
// 必须是非空数组，且首元素为字符串并存在于操作符白名单 MAPLIBRE_EXPRESSION_OPS 中。
export function isMapLibreExpression(v) {
    return Array.isArray(v) && v.length > 0 && typeof v[0] === 'string' && !!MAPLIBRE_EXPRESSION_OPS[v[0]];
}

// 解析 MapLibre expression 的输入表达式，识别其依赖的要素属性或 zoom
function parseMapLibreInputExpr(expr) {
    if (Array.isArray(expr)) {
        const op = expr[0];
        if (op === 'get') {
            return { property: expr[1] };
        } else if (op === 'number' || op === 'to-number') {
            const inner = parseMapLibreInputExpr(expr[1]);
            if (inner) {
                inner.default = expr.length > 2 ? expr[2] : inner.default;
            }
            return inner;
        } else if (op === 'zoom') {
            return { zoom: true };
        }
        return null;
    } else if (typeof expr === 'string') {
        return { property: expr };
    }
    return null;
}

// 将 MapLibre style expression（["step", ...]、["interpolate", ...]、["match", ...]）
// 转换为 maptalks 支持的 function-type（{type, property, default, stops}）格式。
// 转换失败时返回 fallback（默认为原数组）。
export function mapLibreExpressionToFnType(expr, fallback) {
    if (!Array.isArray(expr)) {
        return expr === undefined || expr === null ? fallback : expr;
    }
    const op = expr[0];
    if (op === 'step') {
        // ["step", input, base, stop1, val1, stop2, val2, ...]
        const input = parseMapLibreInputExpr(expr[1]);
        const base = expr[2];
        const stops = [];
        for (let i = 3; i < expr.length; i += 2) {
            stops.push([expr[i], mapLibreExpressionToFnType(expr[i + 1])]);
        }
        // 前置 [0, base] 使 maptalks interval 的语义与 MapLibre step 一致：
        // input < 第一个 stop 时返回 base，而不是返回第一个 stop 的值
        const fullStops = [[0, base]].concat(stops);
        if (input && input.property) {
            return {
                type: 'interval',
                property: input.property,
                default: base,
                stops: fullStops
            };
        } else if (input && input.zoom) {
            return {
                type: 'interval',
                default: base,
                stops: fullStops
            };
        }
        return fallback;
    } else if (op === 'interpolate') {
        // ["interpolate", ["linear" | ["exponential", base]], input, stop1, val1, ...]
        const input = parseMapLibreInputExpr(expr[2]);
        const stops = [];
        for (let i = 3; i < expr.length; i += 2) {
            stops.push([expr[i], mapLibreExpressionToFnType(expr[i + 1])]);
        }
        if (stops.length && input && input.property) {
            return {
                type: 'exponential',
                property: input.property,
                default: stops[0][1],
                stops
            };
        }
        return fallback;
    } else if (op === 'match') {
        // ["match", input, case1, val1, case2, val2, ..., fallback]
        const input = parseMapLibreInputExpr(expr[1]);
        const fallbackVal = expr[expr.length - 1];
        const stops = [];
        for (let i = 2; i < expr.length - 1; i += 2) {
            const cases = expr[i];
            const vals = expr[i + 1];
            if (Array.isArray(cases)) {
                for (let j = 0; j < cases.length; j++) {
                    stops.push([cases[j], mapLibreExpressionToFnType(vals)]);
                }
            } else {
                stops.push([cases, mapLibreExpressionToFnType(vals)]);
            }
        }
        if (input && input.property && stops.length) {
            return {
                type: 'categorical',
                property: input.property,
                default: mapLibreExpressionToFnType(fallbackVal),
                stops
            };
        }
        return fallback;
    }
    return fallback;
}

// 遍历 symbol，将其中 MapLibre expression 数组转换为 maptalks function-type 对象，
// 使 lineColor/lineWidth 等属性能按要素属性（如 caliber 管径）正确求值。
export function convertExpressionInSymbol(symbol) {
    if (!symbol || typeof symbol !== 'object') {
        return symbol;
    }
    for (const p in symbol) {
        const v = symbol[p];
        if (Array.isArray(v) && isMapLibreExpression(v)) {
            symbol[p] = mapLibreExpressionToFnType(v, v);
        }
    }
    return symbol;
}

export function getAltitudeToLocal(options) {
    const { verticalCentimeterToPoint, tileRatio } = options;
    const altitudeToLocal = verticalCentimeterToPoint * tileRatio;
    return altitudeToLocal;
}

export function getTubeSizeScale(metric) {
    if (metric === 'centimeter' || metric === 'cm') {
        return 1;
    } else if (metric === 'millimeter' || metric === 'mm') {
        return 0.1;
    } else {
        return 100;
    }
}

const colorCache = {};

export function normalizeColor(out, color) {
    if (!Array.isArray(color)) {
        if (color && color.r !== undefined && color.g !== undefined && color.b !== undefined) {
            // a object containing r, g, b, a
            out[0] = color.r * 255;
            out[1] = color.g * 255;
            out[2] = color.b * 255;
            if (color.a !== undefined) {
                out[3] = color.a * 255;
            } else {
                out[3] = 255;
            }
            return out;
        }
        const key = color;
        color = colorCache[key] = colorCache[key] || Color(color).unitArray();
    }
    for (let i = 0; i < color.length; i++) {
        out[i] = color[i] * 255;
    }
    if (color.length === 3) {
        out[3] = 255;
    }
    return out;
}

const SYMBOLS_SUPPORT_IDENTITY_FN_TYPE = {
    'textFill': 1,
    'textSize': 1,
    'textOpacity': 1,
    'textDx': 1,
    'textDy': 1,
    'markerWidth': 1,
    'markerHeight': 1,
    'markerOpacity': 1,
    'markerDx': 1,
    'markerDy': 1,
    'lineWidth': 1,
    'lineColor': 1,
    'lineOpacity': 1,
    'polygonFill': 1,
    'polygonOpacity': 1,
    'polygonPatternFileWidth': 1,
    'polygonPatternFileOrigin': 1,
    'rotationX': 1,
    'rotationY': 1,
    'rotationZ': 1,
    'scaleX': 1,
    'scaleY': 1,
    'scaleZ': 1,
    'translationX': 1,
    'translationY': 1,
    'translationZ': 1
};

// 遍历features，检查 symbolName 对应的属性中，是否有fn-type类型的值，而且和zoom相关
export function checkIfIdentityZoomDependent(symbolName, prop, features) {
    if (!Array.isArray(features)) {
        features = Object.values(features);
    }
    if (!features || !features.length) {
        return false;
    }
    if (!SYMBOLS_SUPPORT_IDENTITY_FN_TYPE[symbolName]) {
        return false;
    }
    for (let i = 0; i < features.length; i++) {
        const fea = features[i] && (features[i].feature || features[i]);
        if (!fea) {
            continue;
        }
        const v = fea.properties && fea.properties[prop];
        if (!v) {
            continue;
        }
        if (isFunctionDefinition(v) && !interpolated(v).isZoomConstant) {
            return true;
        }
    }
    return false;
}

const SYMBOLS_NEEDS_CHECK = {
    // textName如果是property，传到painter来计算textFit
    'textName': 1,
    // 以下两个属性如果和property有关，需要传到painter来计算textFit
    'markerTextFitPadding': 1,
    'markerTextFit': 1,
    // 需要把这个property传给painter来生成gradient
    'lineGradientProperty': 1
}

export function checkIfZoomFnTypeSymbol(symbolName) {
    return !!SYMBOLS_SUPPORT_IDENTITY_FN_TYPE[symbolName] || !!SYMBOLS_NEEDS_CHECK[symbolName];
}
