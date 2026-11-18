
#ifdef HAS_MASK_EXTENT
    uniform sampler2D mask_colorExtent;
    uniform sampler2D mask_modeExtent;
    uniform float mask_hasClipOut;
    varying float vHeightRatio;
    varying float vHeightOffset;
    varying vec2 vUVInExtent;
    varying vec4 vWorldPosition;

    // =====================================================================
    // 【掩膜模式量化误差说明——修改边界常量前必读】
    //
    // 数据流：JS 侧（Mask.js 的 MASK_MODES）将模式值经 maskModeExtent.frag
    // 写入 RGBA8（8bit 无符号整数）纹理的 R 通道；本 shader 采样读回 maskMode
    // 后，用下面的常量做区间比较来区分掩膜模式。
    //
    // 问题根源：8bit 纹理每通道只能存 0~255 的整数，浮点模式值乘以 255 后需舍入：
    //   - 0.2 / 0.4 / 0.6 × 255 = 51 / 102 / 153，恰为整数，任何 GPU 均无误差；
    //   - 0.1 / 0.3 / 0.7 × 255 = 25.5 / 76.5 / 178.5，处于进位临界值，
    //     不同平台舍入方向不一致：
    //       Windows GPU 多向下舍入 → 读回 0.098 / 0.298 / 0.698
    //       Mac（Metal）向上舍入  → 读回 0.102 / 0.302 / 0.702
    //
    // 历史 bug：修复前边界常量直接取模式值本身（如 CLIPINSIDE_MODE = 0.1），
    // 精确比较在 Mac 上失败：clip-inside（挖方分析）被误判入 clip-outside 分支，
    // 且未设 heightRange 时该分支不裁剪任何像素，
    // 表现为"Mac 上挖方静默失效、无任何报错"（Windows 正常）。
    //
    // 修复方案：边界常量取相邻模式值的中点（模式值 ± 0.05），远大于 1LSB
    // 量化误差（0.5/255 ≈ 0.002），从而对任何 GPU 的舍入方向都免疫。
    // 注意：JS 侧 MASK_MODES 的写入值（0.1~0.7）保持不变，仅此处边界调整。
    // =====================================================================
    const float CLIPINSIDE_MODE = 0.15;  // clip-inside(0.1) 与 clip-outside(0.2) 的中点
    const float CLIPOUTSIDE_MODE = 0.25; // clip-outside(0.2) 与 flat-inside(0.3) 的中点
    const float FLATINSIDE_MODE = 0.35;  // flat-inside(0.3) 与 flat-outside(0.4) 的中点
    const float FLATOUTSIDE_MODE = 0.45; // flat-outside(0.4) 与 color(0.5) 的中点
    const float COLOR_MODE = 0.55;       // color(0.5) 与 texture/video(0.6) 的中点
    const float VIDEO_MODE = 0.65;       // texture/video(0.6) 与 elevate(0.7) 的中点
    bool isInExtent(vec4 color) {
        return length(color.rgb) > 0.0;
    }

    vec4 setMask(vec4 glFragColor) {
        vec4 extentColor = texture2D(mask_colorExtent, vUVInExtent);
        // mask可能重叠
        vec4 modeColor = texture2D(mask_modeExtent, vUVInExtent);
        float maskMode = modeColor.r;
        float minHeight = modeColor.b / vHeightRatio + vHeightOffset;
        float maxHeight = modeColor.a / vHeightRatio + vHeightOffset;
        // clip-outside 分支：区间判断（中点边界），可容忍 8bit 纹理的 ±1LSB 量化误差（详见顶部注释）
        if (maskMode > CLIPINSIDE_MODE && maskMode <= CLIPOUTSIDE_MODE) {
            if (minHeight == 0.0 && maxHeight == 0.0) {
                return glFragColor;
            } else if (vWorldPosition.z >= minHeight && vWorldPosition.z <= maxHeight) {
                return glFragColor;
            } else {
              discard;
            }
        } else if (mask_hasClipOut == 1.0) {
            discard;
        }
        if (isInExtent(extentColor) == true && maskMode <= CLIPINSIDE_MODE && maskMode > 0.0) {
            if (minHeight == 0.0 && maxHeight == 0.0) {
                discard;
            } else if (vWorldPosition.z >= minHeight && vWorldPosition.z <= maxHeight) {
                discard;
            } else {
              return glFragColor;
            }
        } else if (isInExtent(extentColor) == true && maskMode <= VIDEO_MODE && maskMode > FLATOUTSIDE_MODE) {
            if (minHeight == 0.0 && maxHeight == 0.0) {
                glFragColor = vec4(mix(extentColor.rgb, glFragColor.rgb, 1.0 - extentColor.a), glFragColor.a);
            } else if (vWorldPosition.z >= minHeight && vWorldPosition.z <= maxHeight) {
                glFragColor = vec4(mix(extentColor.rgb, glFragColor.rgb, 1.0 - extentColor.a), glFragColor.a);
            }
        }
        return glFragColor;
    }
#endif
