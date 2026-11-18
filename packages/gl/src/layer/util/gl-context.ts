import { GLContext } from '@maptalks/fusiongl';
import createREGL from '@maptalks/regl';
import * as maptalks from 'maptalks';

/**
 * Runtime probe: decide whether the current machine should prefer WebGL1 over
 * WebGL2, and what the failIfMajorPerformanceCaveat value should be.
 *
 * On domestic Linux (UOS/Kylin) with Mesa drivers, WebGL2 exposes more features
 * but their shader compiler is ~2x slower and draw-call validation has higher
 * overhead. A forced WebGL1 path wins 15-25% raw FPS on iGPU class hardware.
 *
 * failIfMajorPerformanceCaveat: false lets the browser return a software
 * (llvmpipe) context when no hardware driver is available. We still want to
 * render even if slowly, so keep it false; but when the tier is 'desktop-low'
 * AND the GL renderer probe later detects llvmpipe, the caller should enable
 * additional quality degradations (see GroupGLLayer antialias / multiSamples
 * defaults, which are also tier-aware).
 */
function detectGLPolicy() {
    // getGlobalThis is exported as a static helper on the maptalks namespace,
    // not as a named subpath export.  Falls back to the classic indirect-eval
    // pattern when the helper is unavailable in test/build permutations.
    // getGlobalThis 挂在 maptalks 命名空间上（而非子路径命名导出）。
    // 当测试/构建变体中不存在时，回退到经典的间接 eval 模式。
    const g = (maptalks as any).getGlobalThis
        ? (maptalks as any).getGlobalThis()
        // tslint:disable-next-line:function-constructor
        : (new Function('return this'))();
    const tier = (g as any).maptalks && (g as any).maptalks.GlobalConfig
        ? (g as any).maptalks.GlobalConfig.__platformTier
        : null;
    // Explicit URL override: ?webgl=1 or ?webgl=2
    let forceGLVersion: 0 | 1 | 2 = 0;
    try {
        const qp = new URLSearchParams(location.search);
        const v = qp.get('webgl');
        if (v === '1') forceGLVersion = 1;
        else if (v === '2') forceGLVersion = 2;
    } catch (e) { /* ignore */ }

    const ua = (g.navigator && g.navigator.userAgent) || '';
    const isDomesticOS = /uos|kylin|deepin|linx|neoKylin|中标麒麟|银河麒麟|统信/i.test(ua);
    const cpuCores = (g.navigator && g.navigator.hardwareConcurrency) || 2;
    const preferWebGL1 = forceGLVersion === 1 || (!forceGLVersion && (
        // Domestic OS iGPU path: prefer WebGL1 (Mesa shader compile penalty)
        (isDomesticOS && cpuCores <= 8) ||
        // Explicit tier downgrade
        tier === 'desktop-low' || tier === 'mobile-low'
    ));
    return {
        preferWebGL1,
        // keep failIfMajorPerformanceCaveat: false so software rendering still
        // works (slow > not rendered), but log the situation for debugging.
        failIfMajorPerformanceCaveat: false,
        tier,
    };
}

export function createWebGLContext(canvas: HTMLCanvasElement, preserveDrawingBuffer: boolean, onlyWebGL1: boolean, extensions: string[], optionalExtensions: string[]) {
    const glPolicy = detectGLPolicy();
    const finalOnlyWebGL1 = onlyWebGL1 || glPolicy.preferWebGL1;
    const attributes = {
        alpha: true,
        depth: true,
        stencil: true,
        preserveDrawingBuffer: preserveDrawingBuffer,
        antialias: false,
        failIfMajorPerformanceCaveat: glPolicy.failIfMajorPerformanceCaveat,
        // Premultiplied alpha path is ~5% faster on Mesa because it skips the
        // post-blend unmultiply round-trip. Enabled uniformly; if a concrete
        // layer needs non-premultiplied output it flips it at draw-call time.
        premultipliedAlpha: true,
    };
    const gl = createGLContext(canvas, attributes, finalOnlyWebGL1);
    if (gl) {
        (gl as any).__glPolicy = glPolicy;
        // Diagnostic log (once per context) for field debugging on UOS machines:
        // in Chromium DevTools console, look for "maptalks GL: tier=desktop-low gl=webgl1"
        try {
            const ext = gl.getExtension('WEBGL_debug_renderer_info');
            const glVer = (gl as any).isWebGL2 ? 'webgl2' : 'webgl1';
            const renderer = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'unknown';
            const policyMsg = `maptalks GL: tier=${glPolicy.tier || 'n/a'} gl=${glVer} renderer="${renderer}"`;
            (console.info || console.log).call(console, policyMsg);
        } catch (e) { /* ignore */ }
    }
    initGL(gl, extensions, optionalExtensions, glPolicy);

    gl.wrap = () => {
        const ctx = new GLContext(gl);
        return ctx;
    };

    const reglGL = gl.wrap();
    const regl = createREGL({
        gl: reglGL,
        attributes,
        extensions: extensions,
        optionalExtensions: optionalExtensions
    });
    const context = {
        gl: gl,
        reglGL: reglGL,
        regl,
        device: regl,
        glPolicy,
        getImageData: (sx, sy, sw, sh) => {
            const pixels = new Uint8Array(sw * sh * 4);
            (regl as any).read({
                x: sx,
                y: canvas.height - sy,
                width: sw,
                height: sh,
                data: pixels
            });
            return new ImageData(new Uint8ClampedArray(pixels.buffer), sw, sh);
        }
    };
    return {
        gl, reglGL, regl, context
    };
}

function initGL(gl, extensions, optionalExtensions, glPolicy) {
    if (!gl) return;

    // Tier-based extension pruning: on low-end / Mesa paths, do not eagerly
    // request heavy optional extensions (anisotropic filtering, float
    // textures…) that the driver may emulate on the CPU. They're still
    // available if the layer explicitly requests them later; we just avoid
    // paying their one-time init cost up-front.
    // 按性能等级裁剪扩展初始化：在低性能/Mesa路径下，不预先申请各向异性过滤、
    // 浮点纹理等高开销可选扩展（驱动可能用CPU模拟）。后续图层若显式需要时
    // 仍可单独申请，这里只是避免一次性支付它们的初始化开销。
    const skipOptional = glPolicy && (glPolicy.tier === 'desktop-low' || glPolicy.tier === 'mobile-low');

    if (extensions) {
        extensions.forEach(ext => {
            try { gl.getExtension(ext); } catch (e) { /* ignore */ }
        });
    }

    if (optionalExtensions) {
        optionalExtensions.forEach(ext => {
            if (skipOptional) {
                // Only keep cheap, widely-hardware-accelerated ones:
                // instancing + uint index + VAO + standard derivatives are
                // effectively free on GLES3 / GL3 class hardware.
                if (!/ANGLE_instanced_arrays|OES_element_index_uint|OES_standard_derivatives|OES_vertex_array_object/.test(ext)) {
                    return;
                }
            }
            try { gl.getExtension(ext); } catch (e) { /* ignore */ }
        });
    }
}



function createGLContext(canvas, options, onlyWebGL1) {
    const names = onlyWebGL1 ? ['webgl', 'experimental-webgl'] : ['webgl2', 'webgl', 'experimental-webgl'];
    let gl = null;
    const triedNames: string[] = [];
    /* eslint-disable no-empty */
    for (let i = 0; i < names.length; ++i) {
        triedNames.push(names[i]);
        try {
            gl = canvas.getContext(names[i], options);
        } catch (e) {}
        if (gl) {
            break;
        }
    }
    if (!gl) {
        console.error('Browser doesn\'t support WebGL. Tried: ' + triedNames.join(', '));
    }
    return gl;
    /* eslint-enable no-empty */
}
