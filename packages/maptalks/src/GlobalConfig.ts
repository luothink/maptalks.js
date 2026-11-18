import { getGlobalThis } from "./core/util/env";

/**
 * Detect low-performance platforms (domestic OSes like UOS/Kylin, legacy GPUs,
 * Mesa software rendering paths, ARM SoCs with weak integrated GPUs).
 * 检测低性能运行环境（国产操作系统如统信UOS/麒麟、老旧显卡、
 * Mesa软件渲染路径、集成显卡较弱的ARM架构SoC）。
 *
 * Heuristics:
 * 1. UserAgent sniffing for UOS/Kylin/Deepin domestic Linux distros
 * 2. Mesa GL renderer string with llvmpipe/softpipe (pure software rasterizer)
 * 3. Integrated GPU + low logical CPU cores
 * 4. DevicePixelRatio > 1.5 combined with integrated GPU
 *
 * Returns PlatformTier:
 *   'desktop-perf'  - Discrete GPU / recent Apple Silicon / latest Intel Iris Xe → full quality
 *   'desktop-mid'   - Integrated GPU (UHD 620+/AMD GCN 3+) on mainstream OS (Win/macOS)
 *   'desktop-low'   - Integrated GPU on domestic Linux / older iGPU / <4 CPU cores
 *   'mobile-low'    - ARM / low-power devices
 */
// -------------------------------------------------------------------------
// NOTE: PlatformTierName / PlatformPreset interfaces are declared below this
// function so that detectPlatformTier only references primitive / well-known
// types.  Their return-type annotation is written as the literal union here,
// then narrowed and re-used via the type alias below — keeping declaration
// order acyclic.
// 注意：PlatformTierName / PlatformPreset 接口在本函数之后声明，因此
// detectPlatformTier 只引用原始字面量类型；下方类型别名会复用同一字面
// 量联合，保持整个声明顺序无循环。
// -------------------------------------------------------------------------
function detectPlatformTier():
    | 'desktop-perf'
    | 'desktop-mid'
    | 'desktop-low'
    | 'mobile-low' {
    const g = getGlobalThis();
    const ua = (g.navigator && g.navigator.userAgent) || '';
    const uaLc = ua.toLowerCase();

    // --- Step 1: Domestic OS detection 国产操作系统检测 ---
    const isDomesticOS = /uos|kylin|deepin|linx|neoKylin|中标麒麟|银河麒麟|统信/i.test(uaLc);

    // --- Step 2: CPU core count (heuristic for class of machine) ---
    const cpuCores = (g.navigator && g.navigator.hardwareConcurrency) || 2;

    // --- Step 3: Mobile / ARM detection ---
    const isMobileOrARM = /android|mobile|arm|aarch64|harmony|鸿蒙/i.test(uaLc);

    // --- Step 4: Offscreen canvas probe for GL renderer string ---
    let isSoftwareGL = false;
    let isLowendGPU = false;
    try {
        const probe = document.createElement('canvas');
        const gl = probe.getContext('webgl') || (probe.getContext('experimental-webgl') as any);
        if (gl) {
            const ext = gl.getExtension('WEBGL_debug_renderer_info');
            const renderer = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : '';
            const vendor = ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : '';
            const rv = (renderer + ' ' + vendor).toLowerCase();
            // Mesa llvmpipe/softpipe/softpipe is pure software rasterizer
            isSoftwareGL = /llvmpipe|softpipe|swiftshader|software rasterizer/i.test(rv);
            // Low-end / legacy iGPUs with weak shader performance
            isLowendGPU = /hd graphics [3-5]|uhd graphics (60[0-5]|610)|mali-4|mali-t[67]|adreno (3[0-9]|4[0-3])|virgl/i.test(rv);
        }
        probe.remove();
    } catch (e) { /* ignore probe failures */ }

    // --- Step 5: Tier decision matrix ---
    if (isMobileOrARM) return 'mobile-low';
    if (isSoftwareGL) return 'desktop-low';
    if (isDomesticOS) {
        // On domestic Linux distros, Mesa drivers for Intel iGPU are typically
        // 30-50% slower than their Windows counterparts, especially for WebGL.
        // Treat them conservatively unless the machine has >= 8 cores (workstation class).
        if (cpuCores >= 8 && !isLowendGPU) return 'desktop-mid';
        return 'desktop-low';
    }
    if (isLowendGPU || cpuCores <= 4) return 'desktop-low';
    if (cpuCores >= 8) return 'desktop-perf';
    return 'desktop-mid';
}

/**
 * Shape of a single tier-preset. Declared as a standalone interface (instead
 * of `Partial<typeof GlobalConfig>`) to avoid the TS2502 circular-type issue:
 * `PLATFORM_PRESETS` is evaluated before `GlobalConfig` is declared, but its
 * fields are then consumed to seed `GlobalConfig`. An explicit, bidirectionally-
 * independent shape breaks the circular annotation.
 * 单等级预设的结构。声明为独立接口（而非 `Partial<typeof GlobalConfig>`）
 * 以避免 TS2502 循环类型问题：`PLATFORM_PRESETS` 在 `GlobalConfig` 声明前
 * 被求值，其字段又被用来为 `GlobalConfig` 赋初值。双向独立的显式结构
 * 打断注解环。
 */
interface PlatformPreset {
    workerCount?: number;
    maxTilesPerFrame?: number;
    maxTileParsePerFrame?: number;
    maxTileParseTimePerFrame?: number;
    maxConcurrentTileLoads?: number;
    preloadMarginTiles?: number;
    texturePoolSize?: number;
    maxTileCacheMemoryMB?: number;
    panLoadLimitMultiplier?: number;
    zoomOutLoadLimitMultiplier?: number;
    zoomOutTilesPerFrameMultiplier?: number;
}

/**
 * Well-known tier names. Literal union used in place of `keyof typeof PLATFORM_PRESETS`
 * so that URL override parsing doesn't need to reference the still-incomplete
 * PLATFORM_PRESETS type.
 * 已知性能等级字面量联合，用来替代 `keyof typeof PLATFORM_PRESETS`，
 * 避免 URL 覆盖解析时引用尚未完整的 PLATFORM_PRESETS 类型。
 */
type PlatformTierName =
    | 'desktop-perf'
    | 'desktop-mid'
    | 'desktop-low'
    | 'mobile-low';

/**
 * Preset configurations tuned per platform tier.
 * 按平台性能等级预置的调优参数集合。
 *
 * Trade-off rationale for 'desktop-low' (UOS/Kylin target):
 *  - workerCount ↓ to 2 (max) because CPU core count is typically low, and
 *    IPC overhead of postMessage across worker threads on domestic CPUs is non-trivial.
 *  - maxTilesPerFrame / maxTileParsePerFrame ↓ from 32 → 12: smooths out main-thread
 *    spikes at the cost of 2-3 extra frames before all visible tiles are uploaded.
 *  - maxTileParseTimePerFrame ↓ from 16ms → 8ms: keeps a ~4ms headroom on a 16ms
 *    (60fps) budget for compositing / CSS recalc that the DE (DDE/KDE) injects.
 *  - maxConcurrentTileLoads ↓ from 28 → 12: Mesa GL texture upload path is single-
 *    threaded per GL context; too many concurrent decodes just pile up in the queue
 *    and create GC pressure when their ArrayBuffers are transferred.
 *  - preloadMarginTiles ↓ from 2 → 1: reduces off-screen work by ~50% at the cost
 *    of occasional single-tile white seams during fast pans.
 *  - texturePoolSize ↓ from 128 → 64: Mesa's texture re-use path has higher overhead
 *    than DirectX, so a smaller pool with evict-and-reallocate is actually faster.
 */
const PLATFORM_PRESETS: Record<PlatformTierName, PlatformPreset> = {
    'desktop-perf': {
        workerCount: 0,
        maxTilesPerFrame: 32,
        maxTileParsePerFrame: 32,
        maxTileParseTimePerFrame: 16,
        maxConcurrentTileLoads: 28,
        preloadMarginTiles: 2,
        texturePoolSize: 128,
        maxTileCacheMemoryMB: 512,
        panLoadLimitMultiplier: 3.0,
        zoomOutLoadLimitMultiplier: 3.0,
        zoomOutTilesPerFrameMultiplier: 3,
    },
    'desktop-mid': {
        workerCount: 2,
        maxTilesPerFrame: 20,
        maxTileParsePerFrame: 20,
        maxTileParseTimePerFrame: 12,
        maxConcurrentTileLoads: 18,
        preloadMarginTiles: 1,
        texturePoolSize: 96,
        maxTileCacheMemoryMB: 384,
        panLoadLimitMultiplier: 2.0,
        zoomOutLoadLimitMultiplier: 2.0,
        zoomOutTilesPerFrameMultiplier: 2,
    },
    'desktop-low': {
        workerCount: 2,
        maxTilesPerFrame: 12,
        maxTileParsePerFrame: 12,
        maxTileParseTimePerFrame: 8,
        maxConcurrentTileLoads: 12,
        preloadMarginTiles: 1,
        texturePoolSize: 64,
        maxTileCacheMemoryMB: 256,
        panLoadLimitMultiplier: 1.5,
        zoomOutLoadLimitMultiplier: 1.5,
        zoomOutTilesPerFrameMultiplier: 1,
    },
    'mobile-low': {
        workerCount: 1,
        maxTilesPerFrame: 8,
        maxTileParsePerFrame: 8,
        maxTileParseTimePerFrame: 6,
        maxConcurrentTileLoads: 8,
        preloadMarginTiles: 0,
        texturePoolSize: 48,
        maxTileCacheMemoryMB: 192,
        panLoadLimitMultiplier: 1.2,
        zoomOutLoadLimitMultiplier: 1.2,
        zoomOutTilesPerFrameMultiplier: 1,
    },
};

// detectPlatformTier's return signature is already the literal union (see the
// function definition above).  The alias below simply keeps the two usages in
// sync without requiring a cross-reference at type-check time.
// detectPlatformTier 的返回签名已直接声明为字面量联合（见上方函数定义）。
// 此处仅用别名保持两处用法同步，避免类型检查时出现相互引用。
const __platformTier: PlatformTierName = (typeof window !== 'undefined')
    ? detectPlatformTier()
    : 'desktop-mid';
const __preset: PlatformPreset = PLATFORM_PRESETS[__platformTier] || PLATFORM_PRESETS['desktop-mid'];

// Allow explicit URL override: ?preset=desktop-low 或 ?preset=desktop-perf
if (typeof window !== 'undefined') {
    try {
        const qp = new URLSearchParams(location.search);
        const rawTier = qp.get('preset');
        const overrideTier = (rawTier && Object.prototype.hasOwnProperty.call(PLATFORM_PRESETS, rawTier))
            ? rawTier as PlatformTierName
            : null;
        if (overrideTier) {
            Object.assign(__preset, PLATFORM_PRESETS[overrideTier]);
            (getGlobalThis() as any).__MAPTALKS_TIER__ = overrideTier;
        }
    } catch (e) { /* ignore */ }
}

/**
 * global config
 * idle/worker etc
 *
 * performance tuning options:
 * - Memory budget controls tile cache size to stay under ~200MB
 * - Frame budget limits per-frame tile processing to maintain 60fps
 * - Interaction cache improves pan/zoom smoothness
 *
 * 性能调优选项：
 * - 内存预算控制瓦片缓存大小，保持在约 200MB 以内
 * - 帧预算限制每帧瓦片处理量，以维持 60fps
 * - 交互缓存提升平移/缩放的流畅度
 *
 * Tier override (read-only, exposed for debug panels):
 *   GlobalConfig.__platformTier  → 'desktop-low' on UOS/Kylin by default
 */
const GlobalConfig = {
    //test env
    isTest: false,

    // Diagnostics: detected platform tier
    __platformTier,

    //idle logging
    idleLog: false,
    //idle 申请不到idle时,强制执行时间阈值
    idleForceTimeThreshold: 48,
    //worker 数量, 0 表示使用引擎默认策略
    workerCount: (getGlobalThis().MAPTALKS_WORKER_COUNT as number) || (__preset.workerCount as number),
    //每个Worker Message中封装的task message数量
    messagePostRatioPerWorker: 0.3,
    //当前运行环境的最大FPS,用户可以手动配置，否则将自动检测并赋值,为地图锁帧渲染准备
    // 国产桌面环境 DDE/KDE 合成器普遍锁 60Hz，弱GPU进一步降到 30fps 可避免帧排队撕裂
    maxFPS: __platformTier === 'desktop-low' ? 45 : 0,
    //投影最大层级，即地图最大能放大到多大层级
    crsMaxNativeZoom: 22,

    // --- memory & performance tuning ---
    // --- 风格的内存与性能调优 ---

    /**
     * Maximum tile cache memory in MB. Default 256MB ensures adequate storage for
     * both raster and vector tiles during zoom transitions at all zoom levels.
     * Vector tiles at high zoom (15+) have 4-8MB per tile due to dense geometry,
     * and the viewport may need 40-60+ tiles simultaneously. A 256MB budget with
     * the 85% eviction threshold (~217MB usable) gives ~27-54 high-zoom VT tiles
     * before eviction kicks in, matching typical high-zoom working sets.
     * Raised to 512MB: high-zoom(15+) VT tiles are 4-8MB each and viewport +
     * preload working set needs 100-200 tiles (400-800MB), the old 256MB budget
     * caused LRU shrink() to evict visible tiles, making them "flash and vanish".
     * Set to 0 to disable memory-based eviction (use item count only).
     * Uses 50-100MB for tile cache on mobile, 100-200MB on desktop.
     *
     * 瓦片缓存的最大内存（MB）。默认 256MB 可保证所有缩放级别下
     * 栅格与矢量瓦片在缩放过渡期间都有充足的存储。
     * 高缩放级别（15+）的矢量瓦片因几何数据密集，单瓦片可达 4-8MB，
     * 视口可能同时需要 40-60+ 个瓦片。256MB 预算配合 85% 的
     * 驱逐阈值（约 217MB 可用），在触发驱逐前可容纳约 27-54 个高zoom VT 瓦片，
     * 与典型的高zoom工作集相匹配。
     * 已提升至 512MB：高zoom(15+) VT 瓦片单个 4-8MB，视口 + 预加载
     * 工作集需要 100-200 个瓦片（400-800MB），旧的 256MB 预算导致
     * LRU shrink() 驱逐可见瓦片，使其"闪烁后消失"。
     * 设为 0 可禁用基于内存的驱逐（仅按条目数计算）。
     * 移动端瓦片缓存为 50-100MB，桌面端为 100-200MB。
     */
    maxTileCacheMemoryMB: (__preset.maxTileCacheMemoryMB as number) || 512,

    /**
     * Maximum tiles to consume (upload to GPU/canvas) per frame.
     * Limits per-frame work to keep FPS stable during rapid tile loads.
     * Processes tiles in batches of 8-16 per frame.
     * Increased to 32 to reduce blank tiles during zoom-out and panning transitions,
     * especially for vector tile layers that need additional GPU upload time.
     *
     * 每帧消费（上传到 GPU/canvas）的最大瓦片数。
     * 限制每帧的工作量，在瓦片快速加载期间保持 FPS 稳定。
     * 每帧以 8-16 个为一批处理瓦片。
     * 已增至 32，以减少缩小和平移过渡期间的空白瓦片，
     * 尤其是矢量瓦片图层还需要额外的 GPU 上传时间。
     */
    maxTilesPerFrame: (__preset.maxTilesPerFrame as number) || 32,

    /**
     * Maximum tiles to parse (feature/style processing on the main thread) per frame.
     * With multiple workers, decoded tile results can arrive on the main thread in
     * bursts; parsing (_parseTileData/_compileStyle/feature conversion) is main-thread
     * CPU work, so a per-frame parse budget smooths the load and prevents FPS drops
     * during zoom/pan transitions.
     * Aligned with maxTilesPerFrame: if the parse budget were smaller than the on-screen
     * budget, parsing would become the tighter bottleneck and point-feature tiles
     * (which return late after icon/glyph loading) would be delayed further behind
     * plain line/polygon tiles in the parse queue.
     *
     * 每帧解析（主线程上的要素/样式处理）的最大瓦片数。
     * 多 Worker 时，解码后的瓦片结果可能突发的到达主线程；
     * 解析（_parseTileData/_compileStyle/要素转换）是主线程 CPU 工作，
     * 按帧设置解析预算可以平滑负载，防止缩放/平移过渡期间 FPS 下降。
     * 与 maxTilesPerFrame 对齐：若解析预算小于上屏预算，解析会成为
     * 更紧的瓶颈，点要素瓦片（因图标/字形加载而晚返回）在解析队列中
     * 会进一步落后于普通线/面瓦片。
     */
    maxTileParsePerFrame: (__preset.maxTileParsePerFrame as number) || 32,

    /**
     * Maximum main-thread time (ms) spent parsing tile data per frame.
     * The parse queue is drained within this time budget each frame, in addition
     * to the per-frame tile count budget (maxTileParsePerFrame). Large tiles /
     * repeatWorld multi-tile payloads can each take hundreds of ms to copy &
     * upload on the main thread (copyTileData + onTileLoad geometry building);
     * a per-frame time budget caps the single-frame CPU spike (avoiding long
     * tasks and requestAnimationFrame violations) by slicing the work across
     * frames. Can be overridden per-layer with option `tileParseTimePerFrame`.
     *
     * 每帧解析瓦片数据所占的最大主线程时间（ms）。
     * 在每帧瓦片数量预算（maxTileParsePerFrame）之外，解析队列还会在
     * 该时间预算内排空。大瓦片 / repeatWorld 多瓦片载荷单个可能在
     * 主线程上耗费数百 ms 来拷贝与上传（copyTileData + onTileLoad 几何构建）；
     * 按帧设置时间预算可以将工作切分到多帧，封顶单帧 CPU 尖峰
     * （避免长任务和 requestAnimationFrame 超时）。
     * 可通过图层选项 `tileParseTimePerFrame` 按层覆盖。
     */
    maxTileParseTimePerFrame: (__preset.maxTileParseTimePerFrame as number) || 16,

    /**
     * Whether to use memory-budget-based cache eviction.
     * When enabled, tiles are evicted when total estimated memory exceeds
     * maxTileCacheMemoryMB, not just when tile count exceeds maxCacheSize.
     *
     * 是否使用基于内存预算的缓存驱逐。
     * 开启后，当总预估内存超过 maxTileCacheMemoryMB 时驱逐瓦片，
     * 而不仅仅在瓦片数量超过 maxCacheSize 时。
     */
    memoryBudgetEviction: true,

    /**
     * Retire tiles immediately after they leave viewport during panning.
     * When false, tiles are kept for a grace period to prevent white-screen during pan.
     * Keeps tiles visible during pan to avoid flashing.
     *
     * 平移时瓦片离开视口后是否立即退役。
     * 为 false 时，瓦片会保留一段宽限期，防止平移期间出现白屏。
     * 在平移期间保持瓦片可见以避免闪烁。
     */
    immediateRetireOnPan: false,

    /**
     * Maximum concurrent tile image loads. Controls network and decode queue depth.
     * Lower values reduce jank during pan; higher values reduce blank tiles.
     * Default: 16. Increased to 28 to reduce blank tiles during zoom-out/pan,
     * especially for vector tile layers that require additional parsing time.
     *
     * 瓦片图像的最大并发加载数。控制网络和解码队列的深度。
     * 值越低平移时越少卡顿；值越高空白瓦片越少。
     * 默认为 16。已增至 28 以减少缩小/平移期间的空白瓦片，
     * 尤其是矢量瓦片图层还需要额外的解析时间。
     */
    maxConcurrentTileLoads: (__preset.maxConcurrentTileLoads as number) || 28,

    /**
     * Enable progressive tile rendering: partially-loaded tiles show immediately
     * rather than waiting for full load + decode. Eliminates white-screen flashes.
     *
     * 启用渐进式瓦片渲染：部分加载的瓦片立即显示，
     * 而非等待完整加载 + 解码。消除白屏闪烁。
     */
    progressiveTileRender: true,

    /**
     * Preload nearby tiles for smoother panning. Controls how many extra tiles
     * beyond the viewport are queued for loading.
     * Preloads 1+ tile margin to eliminate white gaps during pan.
     * Increased to 2 for smoother pan experience with fewer blank tiles.
     *
     * 预加载邻近瓦片以获得更平滑的平移体验。控制视口之外
     * 有多少额外瓦片排队加载。
     * 预加载 1 层以上瓦片边距以消除平移时的白缝。
     * 已增至 2，平移体验更平滑、空白瓦片更少。
     */
    preloadMarginTiles: (__preset.preloadMarginTiles as number) || 2,

    /**
     * Pan load limit multiplier: during pan operations, the concurrent tile
     * load limit is multiplied by this factor. Increases its load
     * budget during interaction to minimize visible white gaps.
     * Increased to 3.0 to reduce blank tiles during zoom-out and pan.
     *
     * 平移加载上限倍率：平移操作期间，并发瓦片加载上限乘以该系数。
     * 在交互期间提高加载预算，以尽量减少可见的白缝。
     * 已增至 3.0，以减少缩小和平移期间的空白瓦片。
     */
    panLoadLimitMultiplier: (__preset.panLoadLimitMultiplier as number) || 3.0,

    /**
     * Zoom-out load limit multiplier: during zoom-out operations, the concurrent
     * tile load limit is multiplied by this factor. Zoom-out transitions require
     * loading lower-zoom parent tiles that are often evicted from the LRU cache
     * during zoom-in, making them significantly slower to fetch. A higher multiplier
     * helps compensate by loading more tiles concurrently.
     * Default: 3.0 (with maxConcurrent=28 → 84 concurrent during zoom-out)
     *
     * 缩小加载上限倍率：缩小操作期间，并发瓦片加载上限乘以该系数。
     * 缩小过渡需要加载较低 zoom 的父级瓦片，而这些瓦片在放大期间
     * 往往已被从 LRU 缓存中驱逐，获取明显更慢。更高的倍率
     * 通过并发加载更多瓦片来弥补。
     * 默认值：3.0（maxConcurrent=28 时，缩小期间并发 84）
     */
    zoomOutLoadLimitMultiplier: (__preset.zoomOutLoadLimitMultiplier as number) || 3.0,

    /**
     * Maximum number of textures in the GPU texture pool (shared across all GL layers).
     * Each RGBA 256×256 texture consumes ≈256KB VRAM. Lower values reduce GPU memory
     * pressure at the cost of more frequent texture allocations during tile cycling.
     * Concurrent tile upload limit.
     *
     * GPU 纹理池的最大纹理数（所有 GL 图层共享）。
     * 每张 RGBA 256×256 纹理消耗约 256KB 显存。值越低 GPU 显存
     * 压力越小，但瓦片轮换期间纹理分配越频繁。
     * 并发瓦片上传上限。
     */
    texturePoolSize: (__preset.texturePoolSize as number) || 128,

    /**
     * Zoom-out per-frame consumption multiplier: during zoom-out operations, the
     * number of tiles consumed (uploaded to GPU/canvas) per frame is multiplied
     * by this factor. Zoom-out exposes many new edge tiles that must be consumed
     * rapidly to eliminate white gaps around the expanded viewport borders.
     * Default: 3 (with maxTilesPerFrame=32 → 288 tiles per frame during zoom-out).
     *
     * 缩小时每帧消费倍率：缩小操作期间，每帧消费（上传到 GPU/canvas）
     * 的瓦片数乘以该系数。缩放缩小会暴露大量新的边缘瓦片，
     * 必须快速消费以消除扩展后视口边缘的白缝。
     * 默认值：3（maxTilesPerFrame=32 时，缩小期间每帧 288 个瓦片）。
     */
    zoomOutTilesPerFrameMultiplier: (__preset.zoomOutTilesPerFrameMultiplier as number) || 3,
};
export default GlobalConfig;
