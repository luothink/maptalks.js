#ifdef HAS_MASK_EXTENT
    uniform vec4 mask_extent;
    uniform sampler2D mask_colorExtent;
    uniform sampler2D mask_modeExtent;
    uniform float mask_maskMode;
    uniform float mask_hasFlatOut;
    uniform mat4 viewMatrix;
    uniform float mask_heightRatio;
    uniform float mask_heightOffset;
    varying vec4 vWorldPosition;
    varying vec2 vUVInExtent;
    varying float vHeightRatio;
    varying float vHeightOffset;

    // =====================================================================
    // 【掩膜模式量化误差说明——修改边界常量前必读】详细背景见 mask.frag 顶部注释。
    //
    // 模式值（Mask.js 的 MASK_MODES：0.1~0.7）经 maskModeExtent.frag 写入
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
    const float CLIPINSIDE_MODE = 0.25;  // clip-outside(0.2) 与 flat-inside(0.3) 的中点
    const float FLATINSIDE_MODE = 0.35;  // flat-inside(0.3) 与 flat-outside(0.4) 的中点
    const float FLATOUTSIDE_MODE = 0.45; // flat-outside(0.4) 与 color(0.5) 的中点
    const float ELEVATE_MODE = 0.75;     // elevate(0.7) 的上界中点

    float random (vec2 st) {
        return fract(sin(dot(st.xy,vec2(12.9898,78.233)))*43758.5453123) * 0.1;
    }

    bool isInExtent(vec4 color) {
        return length(color.rgb) > 0.0;
    }

    float getFlatHeight(float maskMode, float flatHeight, float height) {
      // 0.65 为 texture/video(0.6) 与 elevate(0.7) 的中点，容忍 8bit 纹理量化误差（详见顶部注释）
      if (maskMode <= ELEVATE_MODE && maskMode > 0.65) {
          return flatHeight + height;
      } else {
        return flatHeight;
      }
    }

    vec4 getNoErrorPosition(vec4 position, vec4 wPosition) {
      vec4 realPos = modelViewMatrix * position;//未压平，采用vm矩阵的坐标
      vec4 pos = viewMatrix * wPosition; //压平的坐标
      vec4 tempPos = viewMatrix * modelMatrix * position;//未压平而采用v*m矩阵的坐标
      float deltaX = realPos.x - tempPos.x;
      float deltaY = realPos.y - tempPos.y;
      float deltaZ = realPos.z - tempPos.z;
      pos.x = pos.x + deltaX;
      pos.y = pos.y + deltaY;
      pos.z = pos.z + deltaZ;
      return pos;
    }

    vec4 getMaskPosition(vec4 position, mat4 modelMatrix) {
        vWorldPosition = modelMatrix * position;
        float w = mask_extent.z - mask_extent.x;
        float h = mask_extent.y - mask_extent.w;
        vec2 uvInExtent = vec2((vWorldPosition.x - mask_extent.x) / abs(w), 1.0 - (vWorldPosition.y - mask_extent.w) / h);
        vec4 extentColor = texture2D(mask_colorExtent, uvInExtent);
        vec3 maskOptionColor = texture2D(mask_modeExtent, uvInExtent).rgb;
        float maskMode = maskOptionColor.r;
        float flatHeight = maskOptionColor.g / mask_heightRatio + mask_heightOffset;
        float height = getFlatHeight(maskMode, flatHeight, vWorldPosition.z);
        vec4 wPosition = vec4(vWorldPosition.x, vWorldPosition.y, height, vWorldPosition.w);
        vUVInExtent = uvInExtent;
        vHeightRatio = mask_heightRatio;
        vHeightOffset = mask_heightOffset;
        if (maskMode <= FLATOUTSIDE_MODE && maskMode > FLATINSIDE_MODE) {
            return modelViewMatrix * position;;
        } else if (mask_hasFlatOut == 1.0) {
            return getNoErrorPosition(position, wPosition);
        }
        if (isInExtent(extentColor) == true && maskMode <= FLATINSIDE_MODE && maskMode > CLIPINSIDE_MODE) {
            return getNoErrorPosition(position, wPosition);
        } if (isInExtent(extentColor) == true && maskMode <= ELEVATE_MODE && maskMode > 0.65) {
            // elevate 分支：下界 0.65 为 texture/video(0.6) 与 elevate(0.7) 的中点（详见顶部注释）
            return getNoErrorPosition(position, wPosition);
        } else {
            return modelViewMatrix * position;
        }
    }
#endif
