const assert = require('assert');
const { readPixel } = require('../common/Util');
const maptalks = require('maptalks');
const { GeoJSONVectorTileLayer } = require('../../dist/maptalks.vt.js');
const { GroupGLLayer } = require('@maptalks/gl');
require('@maptalks/gpu');
const startServer = require('./server.js');
const { replaceTestPortDeep } = require('./server.js');
const PORT = 4398;

const mapRenderer = window.mapRenderer;

maptalks.Map.mergeOptions({
    renderer: mapRenderer || 'gl',
    preserveGpuDrawingBuffer: true
});

const DEFAULT_VIEW = {
    center: [91.14478,29.658272],
    zoom: 12,
    pitch: 0,
    bearing: 0,
    devicePixelRatio: 1,
    lights: {
        ambient: {
            color: [0.1, 0.1, 0.1]
        },
        directional: {
            color: [0.1, 0.1, 0.1],
            direction: [1, 0, -1],
        }
    }
};

const line = {
    type: 'FeatureCollection',
    features: [
        { type: 'Feature', id: 0, geometry: { type: 'LineString', coordinates: [[91.13178,29.658272], [91.15678,29.658272]] }, properties: { type: 1 } }
    ]
};

const terrain = {
    type: 'mapbox',
    tileSize: 512,
    urlTemplate: 'http://localhost:' + PORT + '/mapbox-terrain/{z}/{x}/{y}.webp',
    tileStackDepth: 0,
    tileLimitPerFrame: 0,
    requireSkuToken: false,
    fadeAnimation: false,
    shader: 'lit'
};

describe('update vt on terrain specs', () => {
    let container, map, server;
    before(done => {
        container = document.createElement('div');
        container.style.width = '512px';
        container.style.height = '512px';
        document.body.appendChild(container);
        server = startServer(PORT, () => {
            replaceTestPortDeep(terrain);
            done();
        });
    });

    beforeEach(() => {
        map = new maptalks.Map(container, DEFAULT_VIEW);
    });

    afterEach(() => {
        map.remove();
    });

    after(() => {
        server.close();
    });

    it('isolates terrain skin render context from the main pass', () => {
        const layer = new GeoJSONVectorTileLayer('gvt', { data: line });
        new GroupGLLayer('group', [layer]).addTo(map);
        const renderer = layer.getRenderer();
        const parent = renderer._parentContext;
        try {
            renderer._parentContext = {
                renderTarget: { fbo: {} },
                viewport: { width: 512, height: 512 },
                terrainMaskFBO: {},
                tile: {}
            };
            const skin = renderer._createTempRenderContext(1, true);
            renderer._parentContext = { renderMode: 'default' };
            const main = renderer._createTempRenderContext(1, true);
            assert.notStrictEqual(main, skin);
            for (const key of ['renderTarget', 'viewport', 'terrainMaskFBO', 'tile']) {
                assert.strictEqual(main[key], undefined, `${key} leaked from terrain skin`);
                assert(skin[key], `${key} was removed from the previous pass`);
            }
        } finally {
            renderer._parentContext = parent;
        }
    });

    it('keeps extrusion visible across repeated terrain toggles', async function () {
        this.timeout(30000);
        const fixture = require('../integration/fixtures/terrain/terrain-extrusion');
        const layer = new GeoJSONVectorTileLayer('building_layer', {
            data: fixture.data,
            style: fixture.style,
            tileLimitPerFrame: 0,
            tileStackDepth: 0,
            loadingLimit: 0,
            fadeAnimation: false
        });
        const group = new GroupGLLayer('group', [layer]);
        group.addTo(map);
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        const waitForBuildings = (withTerrain, stage) => new Promise((resolve, reject) => {
            const deadline = Date.now() + 6500;
            const check = () => {
                const renderer = layer.getRenderer();
                const meshes = renderer._getAllPlugins().flatMap(plugin =>
                    plugin.painter ? plugin.painter.scene.getMeshes() : []);
                const ready = meshes.length && meshes.every(mesh =>
                    !!mesh.defines.HAS_TERRAIN_ALTITUDE === withTerrain);
                const source = map.getRenderer().canvas;
                canvas.width = source.width;
                canvas.height = source.height;
                ctx.drawImage(source, 0, 0);
                const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
                let colored = 0;
                for (let i = 0; i < pixels.length; i += 4) {
                    if (pixels[i + 3] && (pixels[i] > pixels[i + 1] + 20 ||
                        pixels[i + 1] > pixels[i] + 20)) {
                        colored++;
                    }
                }
                if (ready && colored > 10) {
                    resolve();
                } else if (Date.now() >= deadline) {
                    reject(new Error(`${stage}: meshes=${meshes.length}, coloredPixels=${colored}, ready=${ready}`));
                } else {
                    group.getRenderer().setToRedraw();
                    setTimeout(check, 80);
                }
            };
            setTimeout(check, 300);
        });
        await waitForBuildings(false, 'initial');
        group.setTerrain(terrain);
        await waitForBuildings(true, 'terrain enabled');
        group.setTerrain(null);
        await waitForBuildings(false, 'terrain disabled');
        group.setTerrain(terrain);
        await waitForBuildings(true, 'terrain re-enabled');
    });


    context('should can update terrain with line render plugin, fuzhenn/maptalks-ide#3152', () => {

        const lineTerrainRunner = (done, isPostProcessOn) => {
            const style = [
                {
                    filter: true,
                    renderPlugin: {
                        type: 'line',
                        dataConfig: { type: 'line' },
                    },
                    symbol: { lineColor: '#f00', lineWidth: 8, lineOpacity: 1 }
                }
            ];
            const layer = new GeoJSONVectorTileLayer('gvt', {
                tileLimitPerFrame: 0,
                data: line,
                style,
                tileStackDepth: 0,
                loadingLimit: 0
            });
            const sceneConfig = {
                postProcess: {
                    enable: !!isPostProcessOn,
                    antialias: { enable: true }
                }
            };
            const group = new GroupGLLayer('group', [layer], { sceneConfig });
            const renderer = map.getRenderer();
            const x = renderer.canvas.width, y = renderer.canvas.height;
            setTimeout(() => {
                group.setTerrain(terrain);
            }, 100);
            setTimeout(() => {
                let pixel = readPixel(renderer.canvas, x / 2, y / 2);
                assert.deepEqual(pixel, [255, 0, 0, 255]);
                done();
            }, 3000);
            group.addTo(map);
        }
        it('without post process', done => {
            lineTerrainRunner(done, false);
        });

        it('with post process', done => {
            lineTerrainRunner(done, true);
        });

    });

    it('should can setIndex on terrain, maptalks/issues#939', done => {
        const styleRed = [
            {
                filter: true,
                renderPlugin: {
                    type: 'line',
                    dataConfig: { type: 'line' },
                },
                symbol: { lineColor: '#f00', lineWidth: 8, lineOpacity: 1 }
            }
        ];
        const styleGreen = [
            {
                filter: true,
                renderPlugin: {
                    type: 'line',
                    dataConfig: { type: 'line' },
                },
                symbol: { lineColor: '#0f0', lineWidth: 8, lineOpacity: 1 }
            }
        ];
        const layerRed = new GeoJSONVectorTileLayer('gvt0', {
            tileLimitPerFrame: 0,
            data: line,
            style: styleRed,
            tileStackDepth: 0,
            loadingLimit: 0
        });
        const layerGreen = new GeoJSONVectorTileLayer('gvt1', {
            tileLimitPerFrame: 0,
            data: line,
            style: styleGreen,
            tileStackDepth: 0,
            loadingLimit: 0
        });
        const group = new GroupGLLayer('group', [layerGreen, layerRed], { terrain });
        group.addTo(map);
        const renderer = map.getRenderer();
        const x = renderer.canvas.width, y = renderer.canvas.height;
        setTimeout(() => {
            let pixel = readPixel(renderer.canvas, x / 2, y / 2);
            assert.deepEqual(pixel, [255, 0, 0, 255]);
            layerGreen.setZIndex(1);
            setTimeout(() => {
                let pixel = readPixel(renderer.canvas, x / 2, y / 2);
                assert.deepEqual(pixel, [0, 255, 0, 255]);
                done();
            }, 1000);
        }, 3000);
    });

    it('should can remove layer on terrain, maptalks/issues#939', done => {
        const styleRed = [
            {
                filter: true,
                renderPlugin: {
                    type: 'line',
                    dataConfig: { type: 'line' },
                },
                symbol: { lineColor: '#f00', lineWidth: 8, lineOpacity: 1 }
            }
        ];
        const styleGreen = [
            {
                filter: true,
                renderPlugin: {
                    type: 'line',
                    dataConfig: { type: 'line' },
                },
                symbol: { lineColor: '#0f0', lineWidth: 8, lineOpacity: 1 }
            }
        ];
        const layerRed = new GeoJSONVectorTileLayer('gvt-red', {
            tileLimitPerFrame: 0,
            data: line,
            style: styleRed,
            tileStackDepth: 0,
            loadingLimit: 0
        });
        const layerGreen = new GeoJSONVectorTileLayer('gvt-green', {
            tileLimitPerFrame: 0,
            data: line,
            style: styleGreen,
            tileStackDepth: 0,
            loadingLimit: 0
        });
        const group = new GroupGLLayer('group', [layerGreen, layerRed], { terrain });
        group.addTo(map);
        const renderer = map.getRenderer();
        const x = renderer.canvas.width, y = renderer.canvas.height;
        setTimeout(() => {
            let pixel = readPixel(renderer.canvas, x / 2, y / 2);
            assert.deepEqual(pixel, [255, 0, 0, 255]);
            const terrainRenderer = group.getTerrainLayer().getRenderer();
            const tiles = terrainRenderer.tilesInView;
            assert(Object.values(tiles)[0].image.skinImages[layerRed.getId()] !== undefined);
            layerRed.remove();
            setTimeout(() => {
                assert(Object.values(tiles)[0].image.skinImages[layerRed.getId()] === undefined);
                let pixel = readPixel(renderer.canvas, x / 2, y / 2);
                assert.deepEqual(pixel, [0, 255, 0, 255]);
                done();
            }, 1000);
        }, 3000);
    });

});

