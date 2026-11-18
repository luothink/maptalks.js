import * as maptalks from 'maptalks';
import * as reshader from '../../reshader';
import { WebGLConstants } from '../../reshader';
import { mat4 } from 'gl-matrix';
import { extend } from './util';

const TILE_POINT = new maptalks.Point(0, 0);
const DEFAULT_BASE_COLOR = [1, 1, 1, 1];

export function createImageMesh(geometry, image, extent2d, offset, scale, uniforms, tileInfo) {
    // const width = extent2d.xmax - extent2d.xmin;
    // const height = extent2d.ymax - extent2d.ymin;

    // offset = offset || [0, 0];
    // const point = TILE_POINT.set(extent2d.xmin - offset[0], extent2d.ymax - offset[1]);
    // const x = point.x * scale,
    //     y = point.y * scale;

    const config = {
        data: image,
        mag: 'nearest',
        mipmap: true,
        premultiplyAlpha: true
    } as any;
    if (!image || image.width === 0 || image.height === 0) {
        image = new Uint8Array([0, 0, 0, 0]);
        config.width = 1;
        config.height = 1;
        config.data = image;
    }
    let texture = this.getTexture();
    if (!texture) {
        texture = new reshader.Texture2D(config);
    } else {
        texture.setConfig(config);
    }
    // image.texture = texture;

    uniforms = extend(uniforms || {}, {
        opacity: 1,
        debugLine: 0,
        alphaTest: 0,
        baseColor: DEFAULT_BASE_COLOR,
        baseColorTexture: texture
    });
    const material = new reshader.Material(uniforms);
    const mesh = new reshader.Mesh(geometry, material);
    mesh.properties.minFilter = WebGLConstants.GL_NEAREST;
    // const localTransform = mat4.identity([] as any);
    // mat4.translate(localTransform, localTransform, [x || 0, y || 0, 0]);
    // mat4.scale(localTransform, localTransform, [scale * width, scale * height, 1]);
    // mesh.localTransform = localTransform;
    updateImageMeshLocalTransform(mesh, extent2d, offset, scale, tileInfo);
    return mesh;
}

export function updateImageMeshLocalTransform(mesh, extent2d, offset, scale, tileInfo) {
    const width = extent2d.xmax - extent2d.xmin;
    const height = extent2d.ymax - extent2d.ymin;

    offset = offset || [0, 0];
    const point = TILE_POINT.set(extent2d.xmin - offset[0], extent2d.ymax - offset[1]);
    const x = point.x * scale,
        y = point.y * scale,
        z = tileInfo && tileInfo.layerAlt || 0;
    const localTransform = mat4.identity([] as any);
    mat4.translate(localTransform, localTransform, [x || 0, y || 0, z]);
    mat4.scale(localTransform, localTransform, [scale * width, scale * height, 1]);
    mesh.localTransform = localTransform;
}

/**
 * 按当前视图状态和缩放/惯性标志为瓦片 mesh 设置最优的纹理 MIN/MAG 过滤器。
 * Chooses optimal texture MIN/MAG filters for the tile mesh based on the current view state
 * and the zooming-or-settling flag, keeping filter state stable during motion to avoid flicker.
 * @param mesh 瓦片纹理对应的 mesh，其 baseColorTexture 将被更新过滤器
 * @param map  Map 实例，用于取交互状态/缩放/朝向/俯仰/分辨率
 * @param res  创建 mesh 时的瓦片原始分辨率，检测是否需要重新缩放
 * @param isZoomingOrSettling  是否处于缩放或惯性阶段（TileLayerGLRenderer 传入）；
 *                             true 时强制使用线性过滤器，避免 NEAREST 产生边缘抖动
 */
export function updateFilter(mesh: reshader.Mesh, map: maptalks.Map, res: number, isZoomingOrSettling?: boolean) {
    const cache = maptalks.MapStateCache[map.id];
    const zoom = cache ? cache.zoom : map.getZoom();
    const dpr = cache ? cache.devicePixelRatio : map.getDevicePixelRatio();
    const minFilter = getTexMinFilter(map, zoom, isZoomingOrSettling);

    if (mesh.properties.minFilter !== minFilter) {
        const baseColorTexture = (mesh.material.get('baseColorTexture') as any);
        baseColorTexture.setMinFilter(minFilter);
        mesh.properties.minFilter = minFilter;
    }
    const resized = map.getResolution() !== res;

    // keeps a stable filter while the view is moving/zooming/settling,
    // so tiles never flip between LINEAR and NEAREST frame-to-frame (the source
    // of edge flicker during zoom). NEAREST is only applied once the map is
    // fully static AND the viewport matches the tile resolution exactly.
    // 在视图移动/缩放/惯性滑动的过程中保持过滤器稳定，
    // 瓦片不会逐帧在 LINEAR 和 NEAREST 之间切换（这正是缩放时边缘闪烁的根源）。
    // 只有当地图完全静止且视口与瓦片分辨率精确匹配时才使用 NEAREST。
    const viewChanging = isZoomingOrSettling ||
        (map.isInteracting && map.isInteracting()) ||
        (map.isMoving && map.isMoving()) ||
        (map.getRenderer() && map.getRenderer().isViewChanged && map.getRenderer().isViewChanged());
    // 默认 MAG 过滤器使用线性采样，缩放/移动态平滑。
    // Default MAG filter is linear for smooth interpolation during scaling / motion.
    let magFilter: number = WebGLConstants.GL_LINEAR;
    // 视图静止 + 1:1 DPR + 分辨率无差异 + 无旋转俯仰：切换到 NEAREST 获得锐利像素级瓦片显示。
    // Switch to NEAREST only when view is static, DPR=1, resolution matches, no rotation and no pitch — gives crisp pixel-perfect tiles.
    if (!viewChanging && dpr === 1 && !resized && !map.getBearing() && !map.getPitch()) {
        magFilter = WebGLConstants.GL_NEAREST;
    }
    if (mesh.properties.magFilter !== magFilter) {
        const baseColorTexture = (mesh.material.get('baseColorTexture') as any);
        baseColorTexture.setMagFilter(magFilter);
        mesh.properties.magFilter = magFilter;
    }
}

function getTexMinFilter(map: maptalks.Map, zoom: number, isZoomingOrSettling?: boolean) {
    // never toggles the raster min filter while the view changes:
    // LINEAR_MIPMAP_LINEAR is kept during pan/zoom/settle so mipmaps smooth out
    // the scaled-up tiles and no filter-state switch happens between frames.
    // Note: scroll-wheel zooming does not set map._moving (only _zooming), so
    // map.isMoving() alone cannot detect zoom transitions - check interacting
    // state and view change as well.
    // 在视图变化时从不切换栅格纹理的 min filter：
    // 平移/缩放/惯性滑动期间保持 LINEAR_MIPMAP_LINEAR，让 mipmap 平滑放大瓦片，
    // 避免帧间发生过滤器状态切换。
    // 注意：滚轮缩放不会置位 map._moving（只置位 _zooming），
    // 因此仅靠 map.isMoving() 无法检测缩放过渡——还需检查交互状态和视图变化。
    const viewChanging = isZoomingOrSettling ||
        (map.isInteracting && map.isInteracting()) ||
        (map.isMoving && map.isMoving()) ||
        (map.getRenderer() && map.getRenderer().isViewChanged && map.getRenderer().isViewChanged());
    // 视图变化期间使用 mipmap 三线性过滤，保证放大/缩小时平滑过渡。
    // Use trilinear mipmap filtering while the view is in motion for smooth minification transitions.
    if (viewChanging) {
        return WebGLConstants.GL_LINEAR_MIPMAP_LINEAR;
    }
    // 无旋转俯仰且缩放到整数级：使用 NEAREST 获得最锐利的瓦片图像。
    // Integer zoom with no pitch / bearing — NEAREST gives the sharpest possible tile output.
    if (!map.getBearing() && !map.getPitch() && Number.isInteger(zoom)) {
        return WebGLConstants.GL_NEAREST;
    }
    // 其余静止情形（非整数zoom / 旋转 / 俯仰）使用线性双线性过滤。
    // Otherwise (non-integer zoom, rotation, or pitch on a static view) use plain bilinear filtering.
    return WebGLConstants.GL_LINEAR;
}
