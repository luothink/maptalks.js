describe('WMSTileLayer', function () {

    var container;
    var map;
    var center = new maptalks.Coordinate(118.846825, 32.046534);

    beforeEach(function () {
        container = document.createElement('div');
        container.style.width = '3px';
        container.style.height = '3px';
        document.body.appendChild(container);
        var option = {
            zoom: 17,
            center: center
        };
        map = new maptalks.Map(container, option);
    });

    function recreateMap(w, h) {
        if (map) {
            map.remove();
        }
        REMOVE_CONTAINER(container);
        container = document.createElement('div');
        container.style.width = w || '180px';
        container.style.height = h || '180px';
        document.body.appendChild(container);
        map = new maptalks.Map(container, {
            zoom: 17,
            center: center
        });
    }

    function captureInteractionTileSamples(layer, delay) {
        var renderer = layer.getRenderer();
        var originalLoadTileImage = renderer.loadTileImage;
        var originalDrawTiles = renderer._drawTiles;
        var samples = [];
        renderer.loadTileImage = function (tileImage, url, tileInfo) {
            setTimeout(function () {
                if (!renderer || !renderer.layer || !renderer.getMap || !renderer.getMap()) {
                    return;
                }
                originalLoadTileImage.call(renderer, tileImage, url, tileInfo);
            }, delay || 60);
            return tileImage;
        };
        renderer._drawTiles = function () {
            var tiles = arguments[0];
            var parentTiles = arguments[1];
            var childTiles = arguments[2];
            var map = layer.getMap();
            if (map && (map.isZooming() || map.isMoving() || map.isRotating())) {
                samples.push({
                    zooming: !!(map.isZooming && map.isZooming()),
                    moving: !!(map.isMoving && map.isMoving()),
                    rotating: !!(map.isRotating && map.isRotating()),
                    zoomDirection: renderer._zoomTransitionDirection,
                    zoomSnapshotTiles: renderer._zoomSnapshotTiles ? renderer._zoomSnapshotTiles.length : 0,
                    snapshotDominantZoom: renderer._zoomSnapshotDominantZoom,
                    stableZoomFrameTiles: renderer._stableZoomFrameTiles ? renderer._stableZoomFrameTiles.length : 0,
                    rendererParentTiles: renderer._parentTiles ? renderer._parentTiles.length : 0,
                    rendererChildTiles: renderer._childTiles ? renderer._childTiles.length : 0,
                    currentTiles: tiles ? tiles.length : 0,
                    parentTiles: parentTiles ? parentTiles.length : 0,
                    childTiles: childTiles ? childTiles.length : 0,
                    tilesLoading: renderer.tilesLoading ? Object.keys(renderer.tilesLoading).length : 0
                });
            }
            return originalDrawTiles.apply(renderer, arguments);
        };
        return {
            samples: samples,
            restore: function () {
                renderer.loadTileImage = originalLoadTileImage;
                renderer._drawTiles = originalDrawTiles;
            }
        };
    }

    function expectNoBlankInteractionFrame(samples) {
        expect(samples.length > 0).to.be.ok();
        expect(samples.some(function (sample) {
            return sample.tilesLoading > 0;
        })).to.be.ok();
        expect(samples.some(function (sample) {
            return sample.tilesLoading > 0 &&
                (sample.currentTiles > 0 || sample.parentTiles > 0 || sample.childTiles > 0);
        })).to.be.ok();
        expect(samples.some(function (sample) {
            return sample.tilesLoading > 0 &&
                sample.currentTiles === 0 &&
                sample.parentTiles === 0 &&
                sample.childTiles === 0;
        })).not.to.be.ok();
    }

    function expectZoomOutFallbackFrames(samples) {
        var zoomOutLoadingFrames = samples.filter(function (sample) {
            return sample.zooming &&
                sample.zoomDirection === -1 &&
                sample.tilesLoading > 0;
        });
        expect(zoomOutLoadingFrames.length > 0).to.be.ok();
        expect(zoomOutLoadingFrames.some(function (sample) {
            return sample.parentTiles > 0 || sample.rendererParentTiles > 0;
        })).to.be.ok();
        expect(zoomOutLoadingFrames.some(function (sample) {
            return sample.currentTiles === 0 &&
                (sample.parentTiles > 0 || sample.rendererParentTiles > 0);
        })).to.be.ok();
    }

    function runInterruptedZoomSequence(map, callback) {
        var startZoom = map.getZoom();
        map.animateTo({ zoom: startZoom + 1 }, { duration: 240 });
        setTimeout(function () {
            map.once('animateend', function () {
                setTimeout(callback, 180);
            });
            map.animateTo({ zoom: startZoom }, { duration: 240 });
        }, 90);
    }

    afterEach(function () {
        map.remove();
        REMOVE_CONTAINER(container);
    });

    it('set tile size', function () {
        var tile1 = new maptalks.WMSTileLayer('tile', {
            urlTemplate : '/resources/tile.png',
            'layers' : 'layer',
            'styles' : 'styles',
            'version' : '1.3.0',
            'format': 'image/png',
            'transparent' : true,
            'uppercase' : true,
            'crs' : 'EPSG:4490',
            'renderer' : 'canvas',
            tileSize : [1, 2]
        });
        expect(tile1.getTileSize().toArray()).to.be.eql([1, 2]);

        var tile2 = new maptalks.WMSTileLayer('tile', {
            urlTemplate : '/resources/tile.png',
            'layers' : 'layer',
            'styles' : 'styles',
            'version' : '1.3.0',
            'format': 'image/png',
            'transparent' : true,
            'uppercase' : true,
            'crs' : 'EPSG:4490',
            'renderer' : 'canvas',
            tileSize : { width : 1, height : 2 }
        });

        expect(tile2.getTileSize().toArray()).to.be.eql([1, 2]);
    });

    /* it('add with dom renderer', function (done) {
        var tile = new maptalks.WMSTileLayer('tile', {
            urlTemplate : '/resources/tile.png',
            'layers' : 'layer',
            'styles' : 'styles',
            'version' : '1.3.0',
            'format': 'image/png',
            'transparent' : true,
            'uppercase' : true,
            'crs' : 'EPSG:4490',
            'renderer' : 'dom'
        });
        tile.once('layerload', function () {
            expect(tile.getTileUrl(1, 2, 1)).to.be.eql('/resources/tile.png?SERVICE=WMS&REQUEST=GetMap&LAYERS=layer&STYLES=styles&FORMAT=image%2Fpng&TRANSPARENT=true&VERSION=1.3.0&WIDTH=256&HEIGHT=256&CRS=EPSG%3A4490&BBOX=0.002789244055747986,-40075016.688367724,20037508.345578488,-20037508.34557848');
            done();
        });
        map.addLayer(tile);
    }); */

    it('add with canvas renderer', function () {
        var tile = new maptalks.WMSTileLayer('tile', {
            urlTemplate : '/resources/tile.png',
            'layers' : 'layer',
            'styles' : 'styles',
            'version' : '1.3.0',
            'format': 'image/png',
            'transparent' : true,
            'uppercase' : true,
            'crs' : 'EPSG:4490',
            'renderer' : 'canvas'
        });
        map.addLayer(tile);
        var expected = '/resources/tile.png?SERVICE=WMS&REQUEST=GetMap&LAYERS=layer&STYLES=styles&FORMAT=image%2Fpng&TRANSPARENT=true&VERSION=1.3.0&WIDTH=256&HEIGHT=256&CRS=EPSG%3A4490&BBOX=-40075016.68557848,0,-20037508.342789244,20037508.342789244';
        expect(tile.getTileUrl(1, 2, 1)).to.be.eql(expected);
    });

    it('map with crs EPSG:4326', function () {
        map.setSpatialReference({
            'projection' : 'EPSG:4326'
        });
        var tile = new maptalks.WMSTileLayer('tile', {
            urlTemplate : '/resources/tile.png',
            'layers' : 'layer',
            'styles' : 'styles',
            'version' : '1.3.0',
            'format': 'image/png',
            'transparent' : true,
            'uppercase' : true,
            'renderer' : 'canvas'
        });
        map.addLayer(tile);
        expect(tile.getTileUrl(0, 0, 1)).to.be.eql('/resources/tile.png?SERVICE=WMS&REQUEST=GetMap&LAYERS=layer&STYLES=styles&FORMAT=image%2Fpng&TRANSPARENT=true&VERSION=1.3.0&WIDTH=256&HEIGHT=256&CRS=EPSG%3A4326&BBOX=-90,-180,90,0');
    });

    it('map with crs EPSG:4326 in version 1.1.1', function () {
        map.setSpatialReference({
            'projection' : 'EPSG:4326'
        });
        var tile = new maptalks.WMSTileLayer('tile', {
            urlTemplate : '/resources/tile.png',
            'layers' : 'layer',
            'styles' : 'styles',
            'version' : '1.1.1',
            'format': 'image/png',
            'transparent' : true,
            'uppercase' : true,
            'renderer' : 'canvas'
        });
        map.addLayer(tile);
        expect(tile.getTileUrl(0, 0, 1)).to.be.eql('/resources/tile.png?SERVICE=WMS&REQUEST=GetMap&LAYERS=layer&STYLES=styles&FORMAT=image%2Fpng&TRANSPARENT=true&VERSION=1.1.1&WIDTH=256&HEIGHT=256&SRS=EPSG%3A4326&BBOX=-180,-90,0,90');
    });

    it('set crs to EPSG:4326 in options', function () {
        map.setSpatialReference({
            'projection' : 'EPSG:4326'
        });
        var tile = new maptalks.WMSTileLayer('tile', {
            urlTemplate : '/resources/tile.png',
            'layers' : 'layer',
            'styles' : 'styles',
            'version' : '1.3.0',
            'format': 'image/png',
            'transparent' : true,
            'uppercase' : true,
            'crs' : 'EPSG:4326',
            'renderer' : 'canvas'
        });
        map.addLayer(tile);
        expect(tile.getTileUrl(0, 0, 1)).to.be.eql('/resources/tile.png?SERVICE=WMS&REQUEST=GetMap&LAYERS=layer&STYLES=styles&FORMAT=image%2Fpng&TRANSPARENT=true&VERSION=1.3.0&WIDTH=256&HEIGHT=256&CRS=EPSG%3A4326&BBOX=-90,-180,90,0');
    });

    it('toJSON', function () {
        var tile = new maptalks.WMSTileLayer('tile', {
            urlTemplate : '/resources/tile.png',
            'layers' : 'layer',
            'styles' : 'styles',
            'version' : '1.3.0',
            'format': 'image/png',
            'transparent' : true,
            'uppercase' : true,
            'crs' : 'EPSG:4326',
            'renderer' : 'canvas'
        });
        expect(tile.toJSON()).to.be.eql({
            type: 'WMSTileLayer',
            id: 'tile',
            options: {
                urlTemplate: '/resources/tile.png',
                layers: 'layer',
                styles: 'styles',
                version: '1.3.0',
                format: 'image/png',
                transparent: true,
                uppercase: true,
                crs: 'EPSG:4326',
                renderer: 'canvas'
            }
        });
    });

    it('fromJSON', function () {
        var json = {
            type: 'WMSTileLayer',
            id: 'tile',
            options: {
                urlTemplate: '/resources/tile.png',
                layers: 'layer',
                styles: 'styles',
                version: '1.3.0',
                format: 'image/png',
                transparent: true,
                uppercase: true,
                renderer: 'canvas'
            }
        };
        var layer = maptalks.Layer.fromJSON(json);
        map.addLayer(layer);
        expect(layer.getTileUrl(1, 2, 1)).to.be.eql('/resources/tile.png?SERVICE=WMS&REQUEST=GetMap&LAYERS=layer&STYLES=styles&FORMAT=image%2Fpng&TRANSPARENT=true&VERSION=1.3.0&WIDTH=256&HEIGHT=256&CRS=EPSG%3A3857&BBOX=0,-40075016.68557848,20037508.342789244,-20037508.342789244');
    });

    describe('interaction tile loading', function () {
        function createAsyncWMSTileLayer() {
            return new maptalks.WMSTileLayer('tile', {
                urlTemplate: '/resources/tile.png',
                layers: 'layer',
                styles: 'styles',
                version: '1.3.0',
                format: 'image/png',
                transparent: true,
                uppercase: true,
                renderer: 'canvas',
                loadingLimitOnInteracting: 2
            });
        }

        it('keeps parent fallback coverage while zooming back out', function (done) {
            recreateMap('180px', '180px');
            var tile = createAsyncWMSTileLayer();
            tile.once('layerload', function () {
                var capture = captureInteractionTileSamples(tile, 140);
                runInterruptedZoomSequence(map, function () {
                    try {
                        expectNoBlankInteractionFrame(capture.samples);
                        expectZoomOutFallbackFrames(capture.samples);
                        capture.restore();
                        done();
                    } catch (err) {
                        capture.restore();
                        done(err);
                    }
                });
            });
            map.setBaseLayer(tile);
        });

        it('keeps tile coverage while panning with pending tile loads', function (done) {
            recreateMap('180px', '180px');
            var tile = createAsyncWMSTileLayer();
            tile.once('layerload', function () {
                var capture = captureInteractionTileSamples(tile, 120);
                map.once('animateend', function () {
                    setTimeout(function () {
                        try {
                            expectNoBlankInteractionFrame(capture.samples);
                            expect(capture.samples.some(function (sample) {
                                return sample.moving && sample.tilesLoading > 0;
                            })).to.be.ok();
                            capture.restore();
                            done();
                        } catch (err) {
                            capture.restore();
                            done(err);
                        }
                    }, 120);
                });
                map.animateTo({ center: map.getCenter().add(0.03, 0.02) }, { duration: 240 });
            });
            map.setBaseLayer(tile);
        });

        it('keeps tile coverage while rotating with continued tile loads', function (done) {
            recreateMap('220px', '220px');
            var tile = createAsyncWMSTileLayer();
            tile.once('layerload', function () {
                var capture = captureInteractionTileSamples(tile, 120);
                map.once('animateend', function () {
                    setTimeout(function () {
                        try {
                            expectNoBlankInteractionFrame(capture.samples);
                            expect(capture.samples.some(function (sample) {
                                return sample.rotating && sample.tilesLoading > 0;
                            })).to.be.ok();
                            capture.restore();
                            done();
                        } catch (err) {
                            capture.restore();
                            done(err);
                        }
                    }, 120);
                });
                map.animateTo({ center: map.getCenter().add(0.015, 0.008), bearing: 60 }, { duration: 240 });
            });
            map.setBaseLayer(tile);
        });
    });
});
