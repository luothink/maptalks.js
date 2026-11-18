/* eslint-disable @typescript-eslint/ban-types */
import { isFunction } from "../util/common.js";
import { getWorkerPool, pushAdapterCreated } from "./CoreWorkers.js";

type AdapterFunction = (
    exports: {
        initialize: Function;
        onmessage: (message: any, postResponse: Function) => void;
    },
    global: any,
) => void;

type Adapter = string | AdapterFunction;

let adapters: {
    [key: string]: Adapter;
} = {};
/**
 * Register a worker adapter
 * @param {String} workerKey  - an unique key name of the worker adapter
 * @param {Function} adapter  - the worker adapter function, it must be a complete packaged function with no dependency of other functions
 * @example
 * maptalks.registerWorkerAdapter('foo', function (exports, global) {
        //will be called only for once when loaded in worker thread
        exports.initialize = function () {
          console.log('[worker] initialized');
        };
        //to receive message from main thread sent by maptalks.worker.Actor
        exports.onmessage = function (message, postResponse) {
          const data = message.data;
          console.log(`[worker] received data : ` + data);
          //send message back to main thread
          //the parameters:
          //error, data, buffers (arraybuffers in data)
          postResponse(null, 'message from worker thread', null);
        };
     });
    @global
    @static
 */
export function registerWorkerAdapter(workerKey: string, adapter: Adapter) {
    adapters[workerKey] = adapter;
}

const header = `
    var adapters = {};
    // Dynamic Create Adapter
    function createAdapter(key,code){
        if(adapters[key]||!code){
            return;
        }
        var func=new Function('exports',code+'(exports)');
        var workerExports={};
        func(workerExports,self);
        adapters[key]=workerExports;
        workerExports.initialize && workerExports.initialize(self);

    }
    onmessage = function (msg) {
        msg = msg.data;
        //createAdapter
        if (msg.messageType === 'createAdapter') {
           var key=msg.key;
           var code=msg.code;
           createAdapter(key,code);
           postMessage({adapterName:key});
           return;
        }
        // postMessage when main thread idle
        if(msg.messageType==='idle'){
            var messageRatio = msg.messageRatio;
            handleMessageQueue(messageRatio);
            return;
        }
        if (msg.messageType === 'batch') {
            const messages = msg.messages;
            if (messages) {
                for (let i = 0; i < messages.length; i++) {
                    dispatch(messages[i]);
                }
            }
        } else {
            dispatch(msg);
        }
    };

    function dispatch(msg) {
        var workerKey = msg.workerKey;
        var adapter = adapters[workerKey];
        if (!adapter) {
            post(msg.callback, 'Unregistered worker adapters for ' + workerKey);
            return;
        }
        try {
            adapter.onmessage(msg, wrap(msg.callback));
        } catch (err) {
            post(msg.callback, workerKey + ':' + err.message);
            console.error(err);
            throw err;
        }
    }

    var messageResultQueue = [];
    var queuedBytes = 0;
    // 大消息如果继续等待 idle 批量冲刷，会在 worker 侧形成明显的 ArrayBuffer 堆积，
    // 导致子线程长期维持高内存占用，因此直接发送给主线程。
    var DIRECT_POST_THRESHOLD = 2 * 1024 * 1024;
    // 小消息仍然允许合批，但要限制总排队体积，避免主线程忙时无限积压。
    var MAX_QUEUED_BYTES = 16 * 1024 * 1024;

    function estimateTransferBytes(buffers, data) {
        var bytes = 0;
        if (buffers && buffers.length) {
            for (var i = 0; i < buffers.length; i++) {
                if (buffers[i] && buffers[i].byteLength) {
                    bytes += buffers[i].byteLength;
                }
            }
            return bytes;
        }
        if (data && data.byteLength) {
            return data.byteLength;
        }
        return bytes;
    }

    function handleMessageQueue(messageRatio){
       if(messageResultQueue.length===0){
          return;
       }
       var count = Math.ceil((messageRatio || 1) * messageResultQueue.length);
       var queues = messageResultQueue.slice(0, count);
       queues.forEach(function(queue){
          post(queue.callback,queue.err,queue.data,queue.buffers);
          queuedBytes -= queue.bytes || 0;
       });
       if(queuedBytes < 0){
          queuedBytes = 0;
       }
       messageResultQueue=messageResultQueue.slice(count, Infinity);
    }

    function post(callback, err, data, buffers) {
        var msg = {
            callback : callback
        };
        if (err) {
            msg.error = err;
        } else {
            msg.data = data;
        }
        if (buffers && buffers.length > 0) {
            postMessage(msg, buffers);
        } else {
            postMessage(msg);
        }
    }

    function joinQueue(callback,err,data,buffers){
        var bytes = estimateTransferBytes(buffers, data);
        if (bytes >= DIRECT_POST_THRESHOLD) {
            // 大 payload 直接出队，避免 idle 调度变成 buffer 的滞留点。
            post(callback, err, data, buffers);
            return;
        }
        // ImageBitmap 是 transferable 对象且没有 byteLength（恒被估算为 0 字节），
        // 若走 messageResultQueue，会被 idle 消息按 ~30%/帧 的比例节流回传，
        // 瓦片解码结果会长时间滞留在 worker 端：既放大了上屏延迟（白块），
        // 又在 worker 端持续堆积位图内存（且不受 MAX_QUEUED_BYTES 限制）。
        // 瓦片位图直接发回主线程，同时转移所有权，消除滞留与堆积。
        if (data && typeof data === 'object' && typeof data.close === 'function' &&
            typeof data.width === 'number' && typeof data.height === 'number') {
            post(callback, err, data, buffers);
            return;
        }
        if (queuedBytes + bytes > MAX_QUEUED_BYTES) {
            // 队列体积达到上限时优先清空一轮，避免 worker 端持续扩容。
            handleMessageQueue(1);
        }
        messageResultQueue.push({
            callback:callback,
            err:err,
            data:data,
            buffers:buffers,
            bytes:bytes
        });
        queuedBytes += bytes;
    }

    function wrap(callback) {
        return function (err, data, buffers) {
            joinQueue(callback, err, data, buffers);
        };
    }
    var workerExports;
`;

const footer = `
    workerExports = null;
`;

function compileWorkerSource() {
    let source = header;
    for (const p in adapters) {
        let adapter = adapters[p];
        pushAdapterCreated(p);
        if (isFunction(adapter)) {
            if (adapter.length === 0) {
                // new definition form of worker source
                // eslint-disable-next-line @typescript-eslint/ban-ts-comment
                // @ts-expect-error
                adapter = adapter();
            }
        }
        source += `
    workerExports = {};
    (${adapter})(workerExports, self);
    adapters['${p}'] = workerExports`;
        source += `
    workerExports.initialize && workerExports.initialize(self);
        `;
    }
    source += footer;
    return source;
}

let url: string;

export function getWorkerSourcePath() {
    if (typeof window === "undefined") {
        return null;
    }
    if (!url) {
        const source = compileWorkerSource();
        url = window.URL.createObjectURL(
            new Blob([source], { type: "text/javascript" }),
        );
        //clear cached worker adapters
        adapters = {};
    }
    return url;
}

// Dynamic Create Adapter
//利用worker通信向每个workerPool里的每个worker注入新的code
//注意注入的代码在worker code里不是明文的，是个匿名函数挂到adapters,代码层面是看不到改段代码的
export function createAdapter(key: string, cb: Function) {
    if (!adapters[key]) {
        console.error(`not find ${key} adapter`);
        return;
    }
    let adapter = adapters[key];
    if (isFunction(adapter)) {
        if (adapter.length === 0) {
            // new definition form of worker source
            // eslint-disable-next-line @typescript-eslint/ban-ts-comment
            // @ts-expect-error
            adapter = adapter();
        }
    }
    adapter = `(${adapter})`;
    const workerPool = getWorkerPool();
    if (!workerPool) {
        return;
    }
    const workers = workerPool.workers || [];
    if (workers.length === 0) {
        console.error("workerpool workers count is 0");
    }
    let count = 0;
    const messageCB = (msg: any) => {
        msg = msg.data || {};
        if (msg.adapterName === key) {
            count++;
            if (count === workers.length) {
                workers.forEach((worker) => {
                    worker.removeEventListener("message", messageCB);
                });
                delete adapters[key];
                cb();
            }
        }
    };
    workers.forEach((worker: Worker) => {
        worker.addEventListener("message", messageCB);
        worker.postMessage({
            key,
            code: adapter,
            messageType: "createAdapter",
        });
    });
}
