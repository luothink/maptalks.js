import REGL, { Uniforms } from "@maptalks/regl";
import Scene from "./Scene";

const EMPTY_UNIFORMS = {};
/**
 * A basic renderer to render meshes in fashion of forward rendering
 */
class Renderer {
    device: any

    constructor(device: any) {
        this.device = device;
    }

    render(shader, uniforms: Uniforms, scene: Scene, framebuffer: REGL.Framebuffer) {
        //rendering of large number of lights can be accelarated by clip-space quadtree
        //https://stackoverflow.com/questions/30594511/webgl-fragment-shader-for-multiple-light-sources

        uniforms = uniforms || EMPTY_UNIFORMS;
        // MeshShader 通过 getter 动态读取 shader.context 上的属性值，
        // 因此当 uniforms 引用与上一次相同时，即使其属性值被就地修改，
        // 渲染时也会取到最新值，无需重复 setUniforms。
        // 典型场景：vt painter 的 current/background 两阶段共享同一 uniforms 对象，
        // 仅 layerOpacity 数值被 _bgOpacityFactor 就地调整，第二次渲染可直接跳过。
        if (shader.context !== uniforms) {
            shader.setUniforms(uniforms);
            shader.setFramebuffer(framebuffer);
        } else if (shader.context.framebuffer !== framebuffer) {
            shader.setFramebuffer(framebuffer);
        }
        let count = 0;
        if (scene) {
            const { opaques, transparents } = scene.getSortedMeshes();
            if (opaques && opaques.length) {
                count += shader.draw(this.device, opaques);
            }
            if (transparents && transparents.length) {
                count += shader.draw(this.device, transparents);
            }
        } else {
            count += shader.draw(this.device);
        }
        return count;
    }

    clear(options: REGL.ClearOptions) {
        this.device.clear(options);
    }

    isWebGPU() {
        return !!this.device.wgpu;
    }
}

export default Renderer;
