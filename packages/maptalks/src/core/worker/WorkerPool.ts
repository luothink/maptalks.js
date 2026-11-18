// import { requestAnimFrame } from '../util';
import { setWorkerPool, setWorkersCreated } from "./CoreWorkers";
import { getWorkerSourcePath } from "./Worker";
import GlobalConfig from "../../GlobalConfig";
import { type Message } from "./Actor";

const DEFAULT_MAX_WORKER_COUNT = 2;

function getDefaultWorkerCount() {
    if (typeof window === "undefined") {
        return 0;
    }
    // 默认使用 2 个 Worker（基于原有评估，权衡并行吞吐与内存峰值）：
    // 1. 所有 Worker 同构（identical），无角色分工，多 Worker 仅提供并行吞吐；
    // 2. Tile 加载瓶颈通常在网络/主线程渲染，Worker 端 CPU 解码很少成为瓶颈；
    // 3. 多 Worker 会放大瞬时内存峰值（每份解码数据 + 消息队列堆积），
    //    对缩放/平移时的流畅性弊大于利。
    // 之所以仍默认保留 2 个 Worker：
    // 1. 矢量瓦片从"简化显示（低 zoom 父级瓦片放大）"切换到"精确显示（目标 zoom 瓦片）"的
    //    过渡时间，主要受 Worker 端串行解码排队的影响。单 Worker 下所有瓦片按到达顺序排队解码，
    //    一次缩放/平移产生的数十个瓦片只能逐个处理，过渡时间随队列长度线性增长；
    // 2. 双 Worker 下，loadTile 通过 (x + y) % workerCount 哈希分发，相邻瓦片天然分布到不同
    //    Worker 并行解码，可将过渡期的解码排队时间近似减半（受限网络下载与主线程渲染）；
    // 3. 代价是瞬时内存峰值上升（每份解码中间数据 + 结果回传队列），低内存环境可通过
    //    MAPTALKS_WORKER_COUNT=1 覆盖，仍保持单 Worker 的省内存模式。
    return DEFAULT_MAX_WORKER_COUNT;
}

class MessageBatch {
    //@internal
    _limit: number;
    //@internal
    _messages: Message[];
    //@internal
    _bufferSet: Set<ArrayBuffer>;
    buffers: ArrayBuffer[];
    constructor(limit = 50) {
        this._limit = limit;
        this._messages = [];
        this._bufferSet = new Set();
        this.buffers = [];
    }

    addMessage(msg: Message, buffers: ArrayBuffer[]) {
        this._messages.push(msg);
        if (!Array.isArray(buffers)) {
            return;
        }
        for (let i = 0; i < buffers.length; i++) {
            const buffer = buffers[i];
            // 用 Set 去重避免线性查找：瓦片洪峰期（缩放/平移）一次批量消息
            // 可能携带数十个 buffer，原 indexOf 实现为 O(n^2)，造成主线程 CPU 尖峰
            if (!this._bufferSet.has(buffer)) {
                this._bufferSet.add(buffer);
                this.buffers.push(buffer);
            }
        }
    }

    isFull() {
        return this._messages.length >= this._limit;
    }

    getMessage() {
        return { messageType: "batch", messages: this._messages };
    }
}

/**
 * Worker Pool
 * contains code from [mapbox-gl-js](https://github.com/mapbox/mapbox-gl-js)
 * @private
 */
export default class WorkerPool {
    active: {
        [key: number]: boolean;
    };
    workerCount: number;
    //@internal
    _messages: MessageBatch[][];
    workers: Worker[];
    constructor() {
        this.active = {};
        this.workerCount =
            typeof window !== "undefined"
                ? GlobalConfig.workerCount > 0
                    ? GlobalConfig.workerCount
                    : getDefaultWorkerCount()
                : 0;
        this._messages = [];
    }

    acquire(id: number) {
        if (!this.workers) {
            this.workers = [];
            const url = getWorkerSourcePath();
            for (let i = 0; i < this.workerCount; i++) {
                const worker = new Worker(url);
                // eslint-disable-next-line @typescript-eslint/ban-ts-comment
                // @ts-expect-error
                worker.id = i;
                this.workers.push(worker);
            }
            URL.revokeObjectURL(url);
            setWorkersCreated();
        }
        this.active[id] = true;

        return this.workers.slice();
    }

    release(id: number) {
        delete this.active[id];
        if (Object.keys(this.active).length === 0) {
            this.workers.forEach((w) => {
                w.terminate();
            });
            this.workers = null;
        }
    }

    addMessage(workerId: number, data: any, buffers: ArrayBuffer[]) {
        let batches = this._messages[workerId];
        if (!batches || !batches.length) {
            batches = this._messages[workerId] = [new MessageBatch()];
        }
        let batch = batches[batches.length - 1];
        if (batch.isFull()) {
            batch = new MessageBatch();
            this._messages[workerId].push(batch);
        }
        batch.addMessage(data, buffers);
    }

    commit() {
        if (!this.workers) {
            return;
        }
        if (this._messages.length) {
            for (let i = 0; i < this._messages.length; i++) {
                if (!this._messages[i] || !this._messages[i].length) {
                    continue;
                }
                const batch = this._messages[i].shift();
                this.workers[i].postMessage(batch.getMessage(), batch.buffers);
            }
        }
    }

    getWorkers() {
        return this.workers || [];
    }

    broadcastIdleMessage(messageRatio: number) {
        const workers = this.getWorkers();
        workers.forEach((worker) => {
            worker.postMessage({ messageType: "idle", messageRatio });
        });
        return this;
    }
}

let globalWorkerPool: WorkerPool;
export function getGlobalWorkerPool() {
    if (!globalWorkerPool) {
        globalWorkerPool = new WorkerPool();
        setWorkerPool(globalWorkerPool);
    }
    return globalWorkerPool;
}

// function frameLoop() {
//     getGlobalWorkerPool().commit();
//     requestAnimFrame(frameLoop);
// }
// if (requestAnimFrame) {
//     requestAnimFrame(frameLoop);
// }
