import { vec3 } from 'gl-matrix';
import Mesh from './Mesh';

// 临时向量，用于在 _sortTransparentsByDistance 中复用，避免逐次分配内存。
// Temporary scratch vector reused inside _sortTransparentsByDistance to avoid per-call memory allocations.
const TEMP_CENTER: vec3 = [0, 0, 0];
let uid = 0;

// 预计算的透明mesh排序数据，避免在compare函数中频繁计算OBB中心和距离。
// Pre-computed distance cache for transparent mesh sorting, avoids per-comparison OBB center + distance recalculation inside Array.sort()'s compare callback.
let _distCache: Float64Array = new Float64Array(256);
let _distCacheSize = 256;

// 复用的排序索引 / 结果暂存数组，避免每帧为排序分配新数组（仅按需扩容）。
// Reused index / scratch arrays for the index-based sort, avoiding per-frame allocations (grown on demand only).
const _sortIndices: number[] = [];
const _sortScratch: Mesh[] = [];

// 动态扩容距离缓存数组，保证 _sortTransparentsByDistance 写操作不越界。
// Dynamically expands the distance buffer so _sortTransparentsByDistance never writes out-of-bounds.
function ensureDistCacheSize(size: number) {
    if (size > _distCacheSize) {
        _distCache = new Float64Array(size);
        _distCacheSize = size;
    }
}

class Scene {
    //@internal
    _cameraPosition?: vec3
    //@internal
    _id: number
    sortedMeshes: { opaques?: Mesh[], transparents?: Mesh[] }
    sortFunction?: (a: Mesh, b: Mesh) => number
    meshes?: Mesh[]
    //@internal 用于 O(1) 判定 mesh 是否已存在，替代原 indexOf 线性扫描。
    //@internal O(1) membership set, replaces the previous O(n) indexOf linear scan in addMesh/removeMesh.
    _meshSet?: Set<Mesh>
    //@internal
    _dirty: boolean
    //@internal 缓存上一次透明的mesh排序使用的相机位置
    _lastSortCamPos?: vec3

    constructor(meshes) {
        this._id = uid++;
        this.sortedMeshes = {};
        this.setMeshes(meshes);
        this.dirty();
    }

    setMeshes(meshes?: Mesh | Mesh[]) {
        this.clear();
        if (!meshes || (Array.isArray(meshes) && !meshes.length) || meshes === this.meshes) {
            return this;
        }
        meshes = Array.isArray(meshes) ? meshes : [meshes];
        this.meshes = [];
        // 复用 _meshSet（clear() 中已清空），避免每次调用都 new Set()
        // Reuse _meshSet (already cleared in clear()) to avoid allocating a new Set every call.
        const set = this._meshSet;
        for (let i = 0; i < meshes.length; i++) {
            const mesh = meshes[i] as any;
            // 过滤掉未初始化完成（无 properties 对象）的 mesh，避免后续写 set / properties 访问异常。
            // Skip uninitialized meshes that don't yet carry a .properties bag, which we rely on for per-mesh cache slots.
            if (!mesh || !mesh.properties) {
                continue;
            }
            this.meshes.push(mesh);
            set.add(mesh);
        }
        this.dirty();
        return this;
    }

    addMesh(mesh: Mesh | Mesh[]) {
        if (!mesh || (Array.isArray(mesh) && !mesh.length)) {
            return this;
        }
        const meshes = Array.isArray(mesh) ? mesh : [mesh];
        // 懒初始化 _meshSet：首次 addMesh 才分配，减少空 Scene 的内存占用。
        // Lazy-init _meshSet only on first add to keep empty Scenes lightweight.
        const set = this._meshSet || (this._meshSet = new Set<Mesh>());
        for (let i = 0, len = meshes.length; i < len; i++) {
            const mesh = meshes[i];
            // Set.has 去重 + properties 守卫，确保不会把同一 mesh / 未初始化 mesh 重复压入 meshes 数组。
            // Dedupe via Set.has plus the .properties guard, so the same mesh (or an incomplete one) never gets pushed twice.
            if (mesh && mesh.properties && !set.has(mesh)) {
                set.add(mesh);
                this.meshes.push(mesh);
                this.dirty();
            }
        }
        return this;
    }

    removeMesh(mesh?: Mesh | Mesh[]) {
        if (!mesh || (Array.isArray(mesh) && !mesh.length)) {
            return this;
        }
        const meshes = Array.isArray(mesh) ? mesh : [mesh];
        const set = this._meshSet;
        // 没有 _meshSet 意味着从未 add 过任何 mesh，直接短路返回。
        // Short-circuit when _meshSet was never allocated — nothing was added so nothing to remove.
        if (!set) {
            return this;
        }
        // 命中标记：只要删除了至少一个 mesh，才重新构建 meshes 数组 + 置 dirty。
        // Hit flag — rebuild .meshes and flip dirty only when at least one mesh was actually removed.
        let hit = false;
        for (let i = 0; i < meshes.length; i++) {
            const mesh = meshes[i];
            if (mesh && set.has(mesh)) {
                hit = true;
                set.delete(mesh);
            }
        }
        if (hit) {
            const filterMeshes = [];
            const srcMeshes = this.meshes;
            for (let i = 0; i < srcMeshes.length; i++) {
                const mesh = srcMeshes[i];
                // 以 Set 为真值源重建 meshes，同时再次校验 properties 以过滤残留的脏引用。
                // Rebuild .meshes using the Set as source of truth; re-check .properties to drop any stale references.
                if (mesh && mesh.properties && set.has(mesh)) {
                    filterMeshes.push(mesh);
                }
            }
            this.meshes = filterMeshes;
            this.dirty();
        }
        return this;
    }

    getMeshes() {
        return this.meshes || [];
    }


    clear() {
        this.meshes = [];
        if (this._meshSet) {
            this._meshSet.clear();
        } else {
            this._meshSet = new Set<Mesh>();
        }
        this.sortedMeshes.opaques = [];
        this.sortedMeshes.transparents = [];
        // 清空相机位置缓存，下次 sortMeshes 必定重排。
        // Drop the cached camera position so the next sortMeshes call will re-sort from scratch.
        this._lastSortCamPos = undefined;
        return this;
    }

    dirty() {
        this._dirty = true;
        return this;
    }

    sortMeshes(cameraPosition?: vec3) {
        const meshes = this.meshes;
        if (this.sortFunction) {
            meshes.sort(this.sortFunction);
        }

        let transparents = this.sortedMeshes.transparents;
        if (this._dirty) {
            const opaques = this.sortedMeshes.opaques = [];
            transparents = this.sortedMeshes.transparents = [];
            for (let i = 0, l = meshes.length; i < l; i++) {
                if (meshes[i].transparent) {
                    transparents.push(meshes[i]);
                } else {
                    opaques.push(meshes[i]);
                }
            }
            this._lastSortCamPos = undefined;
        }

        if (cameraPosition && transparents.length > 1) {
            // 检查相机位置是否与上次排序时相同（允许微小误差），避免静态帧下执行 O(n log n) 重排。
            // Skip re-sort if camera hasn't moved (within epsilon); avoids O(n log n) work on static frames.
            const lastPos = this._lastSortCamPos;
            const sameCam = lastPos &&
                Math.abs(lastPos[0] - cameraPosition[0]) < 1e-6 &&
                Math.abs(lastPos[1] - cameraPosition[1]) < 1e-6 &&
                Math.abs(lastPos[2] - cameraPosition[2]) < 1e-6;

            if (!sameCam) {
                // 预计算每个透明mesh到相机的距离，避免compare函数中重复计算OBB中心，
                // 完成排序后快照相机位置供下一帧判定。
                // Pre-compute distances then sort in one pass, and snapshot the camera position for next frame.
                this._sortTransparentsByDistance(transparents, cameraPosition);
                if (!this._lastSortCamPos) {
                    this._lastSortCamPos = vec3.create();
                }
                vec3.copy(this._lastSortCamPos, cameraPosition);
            }
        }

        this._dirty = false;
    }

    // 预计算距离并按距相机远近排序透明mesh（远→近）。
    // Pre-compute per-mesh distances and sort transparents back-to-front (far → near).
    // 使用索引数组 + 原生 Array.sort：复杂度 O(n log n)，避免对大 n（三维管网/建筑等
    // 大量透明mesh）做 O(n²) 插入排序导致拖动/旋转时单帧耗时暴涨。
    // Uses an index array plus native Array.sort — O(n log n) instead of O(n²) insertion sort,
    // which matters when many transparent meshes are present (3D pipes / buildings).
    _sortTransparentsByDistance(transparents: Mesh[], cameraPosition: vec3) {
        const len = transparents.length;
        // 确保距离缓存足够容纳当前所有透明 mesh。
        // Ensure the scratch distance buffer fits every transparent mesh we are about to sort.
        ensureDistCacheSize(len);

        // 预计算每个mesh的OBB中心到相机的距离（平方距离，避免开方）
        // Pass 1: transform each mesh's OBB center to world space and store squared distance to camera.
        for (let i = 0; i < len; i++) {
            const mesh = transparents[i];
            const center = mesh.geometry.boundingBox.getCenter();
            vec3.transformMat4(TEMP_CENTER, center, mesh.localTransform);
            _distCache[i] = vec3.sqrDist(TEMP_CENTER, cameraPosition);
        }

        // Pass 2: 对索引按距离降序排序（远处先渲染），避免在大数组上做 O(n²) 原地插入排序。
        // Index array sorted by descending distance via native sort (O(n log n)); index tiebreak keeps it deterministic.
        _sortIndices.length = len;
        for (let i = 0; i < len; i++) {
            _sortIndices[i] = i;
        }
        _sortIndices.sort((a, b) => {
            const diff = _distCache[b] - _distCache[a];
            return diff !== 0 ? diff : a - b;
        });

        // Pass 3: 按排序后的索引重排 transparents（借用暂存数组，原地写回）。
        // Reorder transparents according to the sorted indices via a reused scratch array.
        _sortScratch.length = len;
        for (let i = 0; i < len; i++) {
            _sortScratch[i] = transparents[_sortIndices[i]];
        }
        for (let i = 0; i < len; i++) {
            transparents[i] = _sortScratch[i];
        }
    }

    getSortedMeshes(): { opaques?: Mesh[], transparents?: Mesh[] } {
        if (this._dirty) {
            this.sortMeshes();
        }
        return this.sortedMeshes || {};
    }

}

export default Scene;
