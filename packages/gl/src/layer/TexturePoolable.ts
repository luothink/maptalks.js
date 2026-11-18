import * as maptalks from 'maptalks';
import * as reshader from '../reshader';

const TexturePoolable = function <T extends maptalks.MixinConstructor>(Base: T) {
    const poolable = class extends Base {
        _textures: reshader.Texture2D[] = [];

        /**
         * Get a texture from cache or create one if cache is empty
         */
        getTexture(): maptalks.WithNull<reshader.Texture2D> {
            if (!this._textures) {
                this._textures = [];
            }
            const textures = this._textures;
            return textures && textures.length > 0 ? textures.pop() : null;
        }

        /**
         * Save a texture to the cache. Pool is capped to prevent unbounded VRAM growth
         * and accumulation of Texture2D wrapper objects on the JS heap.
         * 将纹理保存到缓存。纹理池设有上限，防止显存无限增长
         * 以及 JS 堆上 Texture2D 包装对象的持续累积。
         */
        saveTexture(texture: reshader.Texture2D) {
            // cap texture pool to control GPU memory.
            // Each RGBA 256x256 texture ≈ 256KB VRAM.
            // 256 textures ≈ 64MB VRAM → 128 textures ≈ 32MB (32MB savings).
            // Texture recycle frequency is high during pan/zoom; 128 still provides ample reuse
            // while significantly reducing GPU memory pressure under concurrent layers.
            // Configurable via GlobalConfig.texturePoolSize.
            // 为纹理池设置上限以控制 GPU 显存。
            // 每张 RGBA 256x256 纹理约占 256KB 显存。
            // 256 张 ≈ 64MB 显存 → 128 张 ≈ 32MB（节省 32MB）。
            // 平移/缩放期间纹理回收频率很高，128 张仍能提供充足的复用，
            // 同时在多图层并发场景下显著降低 GPU 显存压力。
            // 可通过 GlobalConfig.texturePoolSize 配置。
            const MAX_POOL = (maptalks as any).GlobalConfig?.texturePoolSize ?? 128;
            if (this._textures.length >= MAX_POOL) {
                const stale = this._textures.shift();
                if (stale && stale.dispose) {
                    stale.dispose();
                }
            }
            this._textures.push(texture);
        }

        disposeTexturePool() {
            const textures = this._textures;
            for (let i = 0; i < textures.length; i++) {
                textures[i].dispose();
            }
            this._textures = [];
        }
    };
    return poolable;
}

export default TexturePoolable;
