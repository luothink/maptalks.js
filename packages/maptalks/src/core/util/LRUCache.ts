/* eslint-disable @typescript-eslint/ban-types */
/**
 * LRU Cache with memory-aware eviction and true LRU semantics.
 *
 * Key improvements over the original:
 * 1. True LRU: get() moves the accessed entry to the most-recently-used end.
 * 2. Memory budgeting: tracks estimated byte size per entry, evicts based on memory
 *    not just item count. This prevents unbounded memory growth on high-DPI devices.
 * 3. Aggressive disposal: onRemove callback receives entries that can then release
 *    image data (canvas/image bytes), GL textures, and mesh resources.
 * 4. Batch eviction: shrink() evicts multiple entries per call to reduce churn.
 * 5. O(1) LRU ordering: the Map's own insertion order is used as the LRU list
 *    (evict = first key, "move to MRU" = delete + set). The previous parallel
 *    `_usageOrder` array required indexOf()+splice() on every get/add/remove,
 *    degrading those hot paths to O(n) — with a 50000-entry text-texture cache
 *    that alone caused per-frame stalls.
 *
 * LRU 缓存，具备内存感知驱逐和真正的 LRU 语义。
 *
 * 相比原实现的关键改进：
 * 1. 真正的 LRU：get() 会将被访问的条目移动到最近使用端。
 * 2. 内存预算：追踪每个条目的预估字节大小，基于内存而不仅是
 *    条目数进行驱逐。防止高 DPI 设备上的内存无限增长。
 * 3. 激进的资源释放：onRemove 回调接收条目后，可释放
 *    图像数据（canvas/图像字节）、GL 纹理和网格资源。
 * 4. 批量驱逐：shrink() 每次调用驱逐多个条目，以减少抖动。
 * 5. O(1) 的 LRU 顺序：直接复用 Map 自身的插入顺序作为 LRU 链
 *    （驱逐 = 取第一个键，"移到 MRU" = delete 后 set）。此前的并行
 *    `_usageOrder` 数组使每次 get/add/remove 都要 indexOf()+splice()，
 *    退化为 O(n)——在 50000 条目的文字纹理缓存上会直接造成逐帧卡顿。
 */
class LRUCache {
    max: number;
    maxMemory: number;
    onRemove: Function;
    // Map 的插入顺序即 LRU 顺序：第一个键 = 最久未使用，最后一个键 = 最近使用。
    // Map insertion order doubles as the LRU order: first key = LRU, last key = MRU.
    data: Map<any, any>;
    private _currentSize: number;

    constructor(max: number, onRemove?: Function) {
        const nullOnRemove = () => {};
        this.max = max;
        this.onRemove = onRemove || nullOnRemove;
        this.reset();
        // Default memory limit: 128MB, can be tuned per-layer
        // 默认内存上限：128MB，可按图层调整
        this.maxMemory = 128 * 1024 * 1024;
    }

    reset() {
        if (this.data) {
            const values = this.data.values();
            for (const p of values) {
                this.onRemove(p);
            }
        }
        this.data = new Map();
        this._currentSize = 0;
        return this;
    }

    clear() {
        this.reset();
        delete this.onRemove;
    }

    /**
     * Estimate memory consumption of a cached entry.
     * 1. If the data producer attached a real memory estimate (`_memSize`,
     *    e.g. vector-tile layers sum transferred ArrayBuffers + parsed features),
     *    use it directly. Without this, VT tiles were estimated as 256x256 RGBA
     *    (~263KB) even when they actually hold multiple MB of buffers, so the
     *    memory budget never triggered eviction and memory grew unboundedly.
     * 2. For raster tile images: width * height * 4 bytes (RGBA).
     * 3. Fallback: 256x256 tile * 4 bytes RGBA + info overhead.
     *
     * 估算缓存条目的内存消耗。
     * 1. 若数据生产方附加了真实的内存估计（`_memSize`，
     *    如矢量瓦片图层汇总传输的 ArrayBuffer + 已解析要素），则直接使用。
     *    若无此字段，VT 瓦片会被按 256x256 RGBA（约 263KB）估算，
     *    而其实际持有数 MB 的缓冲区，导致内存预算永不触发驱逐、内存无限增长。
     * 2. 栅格瓦片图像：宽 × 高 × 4 字节（RGBA）。
     * 3. 兜底：256x256 瓦片 × 4 字节 RGBA + info 对象开销。
     */
    private _estimateSize(data: any): number {
        if (!data) return 0;
        const img = data.image || data;
        if (img && typeof img._memSize === 'number' && img._memSize > 0) {
            return img._memSize;
        }
        if (img && img.width && img.height) {
            // RGBA pixel data + small overhead for the info object
            // RGBA 像素数据 + info 对象的少量开销
            return img.width * img.height * 4 + 1024;
        }
        // Default: 256x256 tile * 4 bytes RGBA
        // 兜底：256x256 瓦片 × 4 字节 RGBA
        return 256 * 256 * 4 + 1024;
    }

    /**
     * True LRU add: if key exists, move to end (MRU); otherwise insert at end.
     * Immediately evicts old entries when either count or memory exceeds limits.
     * During rapid zoom transitions, this prevents memory spikes from burst tile loads.
     *
     * 真正的 LRU 添加：若键已存在，移动到末尾（MRU）；否则插入末尾。
     * 当条目数或内存任一超限时，立即驱逐旧条目。
     * 在快速缩放过渡期间，可防止突发瓦片加载造成的内存尖峰。
     */
    add(key, data) {
        if (!data) {
            return this;
        }
        const estimatedSize = this._estimateSize(data);

        if (this.has(key)) {
            // Remove old entry (will be re-inserted as MRU)
            // 移除旧条目（随后会作为 MRU 重新插入）
            this._currentSize -= this._dataSize(key);
            this.data.delete(key);
        }

        this.data.set(key, data);
        this._currentSize += estimatedSize;

        // Eager eviction when we're over count or memory limits
        // P0: Memory trigger uses 110% of maxMemory (10% hysteresis band)
        // so minor overages from a single VT tile load don't trigger a full
        // shrink cycle. Combined with the 90% target in shrink(), this
        // provides a clean 20% band that prevents thrashing at high zoom.
        // 条目数或内存超限时的立即驱逐
        // P0：内存触发使用 maxMemory 的 110%（10% 迟滞带），
        // 使单个 VT 瓦片加载造成的轻微超额不会触发完整的 shrink 周期。
        // 与 shrink() 中的 90% 目标配合，形成干净的 20% 区间，
        // 防止高 zoom 时的频繁抖动（thrashing）。
        if (this.data.size > this.max ||
            this._currentSize > this.maxMemory * 1.1) {
            // During memory overflow, scale eviction batch proportional to
            // excess to converge faster — 2x budget → 2x batch, etc.
            // 内存溢出时，驱逐批量按超额比例缩放以更快收敛——
            // 预算 2 倍 → 批量 2 倍，以此类推。
            const memRatio = this._currentSize / this.maxMemory;
            const aggressiveBatch = memRatio > 1.5 ? Math.ceil(64 * memRatio) : 32;
            this.shrink(aggressiveBatch);
        }

        return this;
    }

    private _dataSize(key: any): number {
        const data = this.data.get(key);
        return data ? this._estimateSize(data) : 0;
    }

    keys() {
        return Array.from(this.data.keys());
    }

    /**
     * Evict the least-recently-used entry (the first key in Map insertion order).
     * O(1) removal, replacing the previous indexOf()+splice() bookkeeping on a
     * parallel usage-order array.
     *
     * 驱逐最久未使用的条目（Map 插入顺序中的第一个键）。
     * 删除为 O(1)，替代此前在并行 usage-order 数组上 indexOf()+splice() 的开销。
     */
    private _evictOldest(): boolean {
        const iterator = this.data.keys().next();
        if (iterator.done) {
            return false;
        }
        const key = iterator.value;
        const data = this.data.get(key);
        this._currentSize -= this._estimateSize(data);
        this.data.delete(key);
        this.onRemove(data);
        return true;
    }

    /**
     * Evict entries from LRU (oldest access) until within limits.
     * Evicts in batches to amortize cost across frames.
     * When memory is critically over budget, scales batch proportionally
     * to the overshoot ratio so that evictions converge faster.
     *
     * P0: Memory eviction uses a 10% hysteresis band:
     *   - Trigger: currentSize > maxMemory * 1.10 (10% overage)
     *   - Target:  currentSize ≤ maxMemory * 0.90 (10% under, buffer room)
     * Without this band, each over-budget tile addition triggers immediate
     * LRU eviction, causing catastrophic thrashing at high zoom where VT
     * tiles are 4-8MB each and many tiles load per frame.
     *
     * 从 LRU（最久未访问端）驱逐条目，直至回到限额之内。
     * 分批驱逐以将开销均摊到多帧。
     * 内存严重超限时，按超额比例缩放批量，使驱逐更快收敛。
     *
     * P0：内存驱逐使用 10% 迟滞带：
     *   - 触发：currentSize > maxMemory * 1.10（超出 10%）
     *   - 目标：currentSize ≤ maxMemory * 0.90（留出 10% 余量）
     * 若无此区间，每个超预算瓦片的添加都会立即触发 LRU 驱逐，
     * 在高 zoom（VT 瓦片单个 4-8MB、每帧加载多个瓦片）下
     * 会造成灾难性的抖动。
     */
    shrink(batchSize?: number) {
        // If memory is over budget, automatically scale the batch size
        // proportional to the excess. e.g. 2x budget → 64 evictions, 3x → 96.
        // 若内存超预算，自动按超额比例缩放批量。
        // 例如预算 2 倍 → 驱逐 64 个，3 倍 → 96 个。
        let maxEvictions = batchSize || 32;
        if (this._currentSize > this.maxMemory) {
            const memRatio = this._currentSize / this.maxMemory;
            if (memRatio > 1.25) {
                maxEvictions = Math.max(maxEvictions, Math.ceil(32 * memRatio));
            }
        }
        let evicted = 0;

        // Evict from the front (least recently used) until within count limits
        // 从头部（最久未使用）开始驱逐，直至回到条目数限额内
        while (this.data.size > this.max && evicted < maxEvictions) {
            if (!this._evictOldest()) {
                break;
            }
            evicted++;
        }

        // Also evict if over memory budget.
        // P0: Target 90% of maxMemory (not 100%) to leave buffer for tile
        // loads in subsequent frames. Combined with the 110% trigger in add(),
        // this 20% hysteresis band prevents the cache from oscillating between
        // full and near-full, which at high zoom causes in-viewport tiles to be
        // evicted on every frame.
        // 内存超预算时同样执行驱逐。
        // P0：目标为 maxMemory 的 90%（而非 100%），为后续帧的瓦片加载留出缓冲。
        // 与 add() 中的 110% 触发配合，这 20% 的迟滞带防止缓存在
        // "满"与"接近满"之间震荡——高 zoom 下这种震荡会导致
        // 视口内的瓦片每帧都被驱逐。
        while (this._currentSize > Math.floor(this.maxMemory * 0.90) &&
               evicted < maxEvictions) {
            if (!this._evictOldest()) {
                break;
            }
            evicted++;
        }

        return this;
    }

    has(key) {
        return this.data.has(key);
    }

    getAndRemove(key) {
        if (!this.has(key)) {
            return null;
        }
        const data = this.data.get(key);
        this._currentSize -= this._estimateSize(data);
        this.data.delete(key);
        return data;
    }

    /**
     * True LRU get: returns data AND moves key to MRU end.
     * This is the key difference from the original naive Map implementation.
     * Without this, frequently-rendered tiles can be evicted before
     * rarely-used tiles just because they were added first.
     *
     * Moving to MRU is a delete + set on the Map, both O(1); the previous
     * implementation did indexOf()+splice() on a parallel array, which made
     * every cache hit O(n) and stalled the frame on large caches.
     *
     * 真正的 LRU get：返回数据并将键移动到 MRU 端。
     * 这是与原始朴素 Map 实现的关键区别。
     * 若无此机制，频繁渲染的瓦片可能仅因先添加
     * 而在极少使用的瓦片之前被驱逐。
     *
     * 移到 MRU 通过 Map 的 delete + set 完成，均为 O(1)；
     * 此前的实现在并行数组上做 indexOf()+splice()，
     * 使每次缓存命中都退化为 O(n)，在大缓存上会卡住当前帧。
     */
    get(key) {
        if (!this.has(key)) {
            return null;
        }
        // Move to end (most recently used)
        // 移动到末尾（最近使用）
        const data = this.data.get(key);
        this.data.delete(key);
        this.data.set(key, data);
        return data;
    }

    /**
     * Like get() but returns data without updating LRU order.
     * Use for validation checks that shouldn't affect eviction priority.
     *
     * 类似 get()，但返回数据时不更新 LRU 顺序。
     * 用于不应影响驱逐优先级的校验检查。
     */
    peek(key) {
        if (!this.has(key)) {
            return null;
        }
        return this.data.get(key);
    }

    remove(key) {
        if (!this.has(key)) {
            return this;
        }
        const data = this.data.get(key);
        this._currentSize -= this._estimateSize(data);
        this.data.delete(key);
        this.onRemove(data);
        return this;
    }

    setMaxSize(max) {
        this.max = max;
        if (this.data.size > this.max) {
            this.shrink();
        }
        return this;
    }

    /**
     * Set memory limit for the cache. Entries will be evicted
     * when total estimated memory exceeds this value.
     *
     * 设置缓存的内存上限。当总预估内存超过该值时将驱逐条目。
     */
    setMaxMemory(bytes: number) {
        this.maxMemory = bytes;
        if (this._currentSize > this.maxMemory) {
            this.shrink();
        }
        return this;
    }

    /** @internal */
    get size(): number {
        return this.data.size;
    }

    /** @internal - estimated memory consumption in bytes */
    /** @internal - 预估内存消耗（字节） */
    get currentMemory(): number {
        return this._currentSize;
    }
}

export default LRUCache;
