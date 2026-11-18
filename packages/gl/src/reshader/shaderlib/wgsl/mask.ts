const vert = /* wgsl */`
#ifdef HAS_MASK_EXTENT
struct MaskUniforms {
    mask_extent: vec4f,
    mask_maskMode: f32,
    mask_hasFlatOut: f32,
    viewMatrix: mat4x4f,
    mask_heightRatio: f32,
    mask_heightOffset: f32,
};

@group(0) @binding($b) var<uniform> maskUniforms: MaskUniforms;
@group(0) @binding($b) var mask_colorExtentSampler: sampler;
@group(0) @binding($b) var mask_colorExtent: texture_2d<f32>;
@group(0) @binding($b) var mask_modeExtentSampler: sampler;
@group(0) @binding($b) var mask_modeExtent: texture_2d<f32>;

// =====================================================================
// 【掩膜模式量化误差说明——修改边界常量前必读】详细背景见 glsl/mask.frag 顶部注释。
//
// 模式值（Mask.js 的 MASK_MODES：0.1~0.7）经 maskModeExtent 写入
// RGBA8（8bit）纹理后存在量化误差：其中 0.1 / 0.3 / 0.7 × 255 = 25.5 / 76.5 / 178.5
// 为进位临界值，不同 GPU 舍入方向不同（Windows 多向下舍入、Mac Metal 向上舍入），
// 读回值会偏离写入值 ±1/255。
//
// 历史 bug：修复前边界常量直接取模式值本身（如 CLIPINSIDE_MODE = 0.2），
// 精确比较在舍入方向不同的 GPU 上行为不一致，
// 曾导致 flat-inside（压平）、elevate（抬升）在 Mac 上静默失效。
//
// 修复方案：边界常量取相邻模式值的中点（±0.05），远大于 1LSB 误差（0.5/255 ≈ 0.002），
// 对任何 GPU 的舍入方向都免疫。JS 侧 MASK_MODES 的写入值保持不变。
// =====================================================================
const CLIPINSIDE_MODE: f32 = 0.25;  // clip-outside(0.2) 与 flat-inside(0.3) 的中点
const FLATINSIDE_MODE: f32 = 0.35;  // flat-inside(0.3) 与 flat-outside(0.4) 的中点
const FLATOUTSIDE_MODE: f32 = 0.45; // flat-outside(0.4) 与 color(0.5) 的中点
const ELEVATE_MODE: f32 = 0.75;     // elevate(0.7) 的上界中点

fn random(st: vec2f) -> f32 {
    return fract(sin(dot(st, vec2f(12.9898, 78.233))) * 43758.5453123) * 0.1;
}

fn isInExtent(color: vec4f) -> bool {
    return length(color.rgb) > 0.0;
}

fn getFlatHeight(maskMode: f32, flatHeight: f32, height: f32) -> f32 {
    // 0.65 为 texture/video(0.6) 与 elevate(0.7) 的中点，容忍 8bit 纹理量化误差（详见顶部注释）
    if (maskMode <= ELEVATE_MODE && maskMode > 0.65) {
        return flatHeight + height;
    } else {
        return flatHeight;
    }
}

fn getNoErrorPosition(position: vec4f, wPosition: vec4f) -> vec4f {
    let realPos = uniforms.modelViewMatrix * position; // 未压平，采用 vm 矩阵的坐标
    let pos = maskUniforms.viewMatrix * wPosition; // 压平的坐标
    let tempPos = maskUniforms.viewMatrix * uniforms.modelMatrix * position; // 未压平而采用 v*m 矩阵的坐标
    let deltaX = realPos.x - tempPos.x;
    let deltaY = realPos.y - tempPos.y;
    let deltaZ = realPos.z - tempPos.z;
    pos.x = pos.x + deltaX;
    pos.y = pos.y + deltaY;
    pos.z = pos.z + deltaZ;
    return pos;
}

fn getMaskPosition(position: vec4f, modelMatrix: mat4x4f, vertexOutput: VertexOutput) -> vec4f {
    vertexOutput.vWorldPosition = modelMatrix * position;
    let w = maskUniforms.mask_extent.z - maskUniforms.mask_extent.x;
    let h = maskUniforms.mask_extent.y - maskUniforms.mask_extent.w;
    let uvInExtent = vec2f((vertexOutput.vWorldPosition.x - maskUniforms.mask_extent.x) / abs(w), 1.0 - (vertexOutput.vWorldPosition.y - maskUniforms.mask_extent.w) / h);
    let extentColor = textureSample(mask_colorExtent, mask_colorExtentSampler, uvInExtent);
    let maskOptionColor = textureSample(mask_modeExtent, mask_modeExtentSampler, uvInExtent).rgb;
    let maskMode = maskOptionColor.r;
    let flatHeight = maskOptionColor.g / maskUniforms.mask_heightRatio + maskUniforms.mask_heightOffset;
    let height = getFlatHeight(maskMode, flatHeight, vertexOutput.vWorldPosition.z);
    let wPosition = vec4f(vertexOutput.vWorldPosition.x, vertexOutput.vWorldPosition.y, height, vertexOutput.vWorldPosition.w);
    vertexOutput.vUVInExtent = uvInExtent;
    vertexOutput.vHeightRatio = maskUniforms.mask_heightRatio;
    vertexOutput.vHeightOffset = maskUniforms.mask_heightOffset;
    if (maskMode <= FLATOUTSIDE_MODE && maskMode > FLATINSIDE_MODE) {
        return uniforms.modelViewMatrix * position;
    } else if (maskUniforms.mask_hasFlatOut == 1.0) {
        return getNoErrorPosition(position, wPosition);
    }
    if (isInExtent(extentColor) && maskMode <= FLATINSIDE_MODE && maskMode > CLIPINSIDE_MODE) {
        return getNoErrorPosition(position, wPosition);
    }
    if (isInExtent(extentColor) && maskMode <= ELEVATE_MODE && maskMode > 0.65) {
        // elevate 分支：下界 0.65 为 texture/video(0.6) 与 elevate(0.7) 的中点（详见顶部注释）
        return getNoErrorPosition(position, wPosition);
    } else {
        return uniforms.modelViewMatrix * position;
    }
}
#endif
`;

const varyings = [
    {
        name: 'vWorldPosition',
        type: 'vec4f'
    },
    {
        name: 'vUVInExtent',
        type: 'vec2f'
    },
    {
        name: 'vHeightRatio',
        type: 'f32'
    },
    {
        name: 'vHeightOffset',
        type: 'f32'
    }
];

export default {
    defines: ['HAS_MASK_EXTENT'],
    vert,
    varyings
};
