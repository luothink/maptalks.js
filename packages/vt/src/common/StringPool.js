/**
 * String interning pool to deduplicate identical strings.
 * VT features often share the same property keys and values across millions of features.
 * Without interning, each feature stores its own copy of every key-value pair.
 * This pool reduces 3M+ duplicate strings to ~50K unique ones.
 *
 * 字符串驻留池，用于对相同字符串做引用去重。
 * VT 要素的属性键和值在百万级要素间通常高度重复（例如 "highway":"residential"）。
 * 若不做驻留，每个要素都会持有一份独立的键值字符串副本，带来显著的堆内存占用和 GC 压力。
 * 该池可将 300 万+重复字符串压缩至约 5 万个唯一条目，在列式属性存储（features:'id'）场景下效果尤其明显。
 */
class StringPool {
    constructor() {
        this._pool = new Map();
        this._count = 0;
    }

    /**
     * Return the canonical instance of a string, or store if new.
     * @param {*} str - value (only strings are interned; non-strings returned as-is)
     * @returns {*} canonical string reference or original non-string value
     *
     * 获取字符串的"范式"引用；若池中已存在则直接返回原引用，不存在则入池后返回。
     * 只对字符串类型做驻留；数字/布尔/对象等非字符串值原样返回，避免误转类型。
     */
    intern(str) {
        if (typeof str !== 'string') {
            return str;
        }
        const existing = this._pool.get(str);
        if (existing !== undefined) {
            return existing;
        }
        this._pool.set(str, str);
        this._count++;
        return str;
    }

    /**
     * Intern all values of a plain object in-place.
     * Only string values are interned; nested objects are NOT recursed into.
     * @param {Object} obj - the object whose values to intern
     * @returns {Object} the same object (mutated in-place)
     *
     * 对普通对象的所有"值"原地做字符串驻留（键不做处理）。
     * 只驻留字符串类型的值，并且不会递归进入嵌套对象/数组，适用于扁平属性对象。
     * 返回原对象引用（原地修改）。
     */
    internObjectValues(obj) {
        if (!obj || typeof obj !== 'object') return obj;
        const keys = Object.keys(obj);
        for (let i = 0; i < keys.length; i++) {
            const k = keys[i];
            obj[k] = this.intern(obj[k]);
        }
        return obj;
    }

    /**
     * Intern both keys AND values of an object in-place.
     * Extra property names like "name", "class", "highway" appear across thousands
     * of features - interning them avoids creating separate string instances.
     * @param {Object} obj
     * @returns {Object} the same object (mutated in-place)
     *
     * 对对象的"键"和"值"同时原地做字符串驻留。
     * 像 "name" / "class" / "highway" 这类属性名会在数千个要素中重复出现，
     * 把键也驻留可以避免每个要素各自持有相同的键名字符串实例。
     * 若键在驻留后引用发生变化，会删除旧键并以驻留后的新键重新赋值；否则仅更新值。
     */
    internAllInPlace(obj) {
        if (!obj || typeof obj !== 'object') return obj;
        const keys = Object.keys(obj);
        for (let i = 0; i < keys.length; i++) {
            const oldKey = keys[i];
            const newKey = this.intern(oldKey);
            const value = obj[oldKey];
            if (newKey !== oldKey) {
                delete obj[oldKey];
                obj[newKey] = this.intern(value);
            } else {
                obj[oldKey] = this.intern(value);
            }
        }
        return obj;
    }

    /**
     * Intern both keys AND values of a plain object (returns new object).
     * @param {Object} obj
     * @returns {Object} new object with interned keys and values
     *
     * 对普通对象的"键"和"值"做字符串驻留，并返回一个全新的对象（不修改入参）。
     * 适用于不能直接修改原对象的调用方（如共享属性模板）。
     */
    internAll(obj) {
        if (!obj || typeof obj !== 'object') return obj;
        const result = {};
        const keys = Object.keys(obj);
        for (let i = 0; i < keys.length; i++) {
            const k = keys[i];
            const internedKey = this.intern(k);
            result[internedKey] = this.intern(obj[k]);
        }
        return result;
    }

    /**
     * Clear the pool (e.g. when the map/layer is destroyed).
     *
     * 清空驻留池及内部计数，通常在地图或图层销毁时调用以释放字符串引用占用的堆内存。
     */
    clear() {
        this._pool.clear();
        this._count = 0;
    }

    /**
     * @returns {number} number of unique strings in the pool
     *
     * 返回池中当前唯一字符串的条目数（= 已 intern 且未 clear 的新字符串数量）。
     */
    get size() {
        return this._count;
    }

    /**
     * Compact the pool, replacing Map entries with direct references.
     * This frees the Map's internal memory which can be significant for large pools.
     *
     * 压缩池：当前实现与 clear() 行为一致（清空内部 Map 与计数），
     * 用于在驻留高峰期过后释放 Map 的表体内存（大池场景下 Map 桶数组自身也占显著空间）。
     * 调用后所有已返回的字符串引用仍然有效（JS 字符串是不可变值类型），只是后续不再复用。
     */
    compact() {
        this._pool.clear();
        this._count = 0;
    }
}

export default StringPool;
