/* eslint-disable no-console */
/* eslint-env node */
const express = require('express');
const compression = require('compression');
const fs = require('fs');
const url = require('url');
const request = require('request');
const yargs = require('yargs').options({
    port: {
        default: 8080,
        description: 'Port to listen on.'
    },
    public: {
        type: 'boolean',
        description: 'Run a public server that listens on all interfaces.'
    },
    'upstream-proxy': {
        description:
            'A standard proxy server that will be used to retrieve data.  Specify a URL including port, e.g. "http://proxy:8000".'
    },
    'bypass-upstream-proxy-hosts': {
        description:
            'A comma separated list of hosts that will bypass the specified upstream_proxy, e.g. "lanhost1,lanhost2"'
    },
    help: {
        alias: 'h',
        type: 'boolean',
        description: 'Show this help.'
    }
});

(() => {
    const gzipHeader = Buffer.from('1F8B08', 'hex');

    const { argv } = yargs;

    function checkGzipAndNext(req, res, next) {
        const reqUrl = url.parse(req.url, true);
        const filePath = reqUrl.pathname.substring(1);

        const readStream = fs.createReadStream(filePath, { start: 0, end: 2 });
        // readStream.on('error', (err) => {
        readStream.on('error', () => {
            // console.log(err);
            next();
        });

        readStream.on('data', (chunk) => {
            if (chunk.equals(gzipHeader)) {
                res.header('Content-Encoding', 'gzip');
            }
            next();
        });
    }

    function getRemoteUrlFromParam(req) {
        let remoteUrl = req.params[0];
        if (remoteUrl) {
            // add http:// to the URL if no protocol is present
            if (!/^https?:\/\//.test(remoteUrl)) {
                remoteUrl = `http://${remoteUrl}`;
            }
            remoteUrl = url.parse(remoteUrl);
            // copy query string
            remoteUrl.search = url.parse(req.url).search;
        }
        return remoteUrl;
    }

    const dontProxyHeaderRegex = /^(?:Host|Proxy-Connection|Connection|Keep-Alive|Transfer-Encoding|TE|Trailer|Proxy-Authorization|Proxy-Authenticate|Upgrade)$/i;

    function filterHeaders(req, headers) {
        const result = {};
        // filter out headers that are listed in the regex above
        Object.keys(headers).forEach((name) => {
            if (!dontProxyHeaderRegex.test(name)) {
                result[name] = headers[name];
            }
        });
        return result;
    }

    if (argv.help) {
        yargs.showHelp();
    } else {
        // eventually this mime type configuration will need to change
        // https://github.com/visionmedia/send/commit/d2cb54658ce65948b0ed6e5fb5de69d022bef941
        // *NOTE* Any changes you make here must be mirrored in web.config.
        const { mime } = express.static;
        mime.define(
            {
                'application/json': ['mcj', 'czml', 'json', 'geojson', 'topojson'],
                'application/wasm': ['wasm'],
                'image/crn': ['crn'],
                'image/ktx': ['ktx'],
                'model/gltf+json': ['gltf'],
                'model/gltf-binary': ['bgltf', 'glb'],
                'application/octet-stream': ['m3d', 'b3dm', 'pnts', 'i3dm', 'cmpt', 'geom', 'vctr'],
                'text/plain': ['glsl']
            },
            true
        );

        const app = express();
        app.use(compression());
        app.use((req, res, next) => {
            res.header('Access-Control-Allow-Origin', '*');
            res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
            next();
        });

        const knownTilesetFormats = [
            /\.m3d/,
            /\.mcj/,
            /\.b3dm/,
            /\.pnts/,
            /\.i3dm/,
            /\.cmpt/,
            /\.glb/,
            /\.geom/,
            /\.vctr/,
            /tileset.*\.json$/
        ];
        app.get(knownTilesetFormats, checkGzipAndNext);

        app.use(express.static(__dirname));

        const upstreamProxy = argv['upstream-proxy'];
        const bypassUpstreamProxyHosts = {};
        if (argv['bypass-upstream-proxy-hosts']) {
            argv['bypass-upstream-proxy-hosts'].split(',').forEach((host) => {
                bypassUpstreamProxyHosts[host.toLowerCase()] = true;
            });
        }

        // app.get('/proxy/*', (req, res, next) => {
        app.get('/proxy/*', (req, res) => {
            // look for request like http://localhost:8080/proxy/http://example.com/file?query=1
            let remoteUrl = getRemoteUrlFromParam(req);
            if (!remoteUrl) {
                // look for request like http://localhost:8080/proxy/?http%3A%2F%2Fexample.com%2Ffile%3Fquery%3D1
                const tmpRemoteUrl = Object.keys(req.query)[0];
                if (tmpRemoteUrl) {
                    remoteUrl = url.parse(tmpRemoteUrl);
                }
            }

            if (!remoteUrl) {
                return res.status(400).send('No url specified.');
            }

            if (!remoteUrl.protocol) {
                remoteUrl.protocol = 'http:';
            }

            let proxy;
            if (upstreamProxy && !(remoteUrl.host in bypassUpstreamProxyHosts)) {
                proxy = upstreamProxy;
            }

            // encoding : null means "body" passed to the callback will be raw bytes

            return request.get(
                {
                    url: url.format(remoteUrl),
                    headers: filterHeaders(req, req.headers),
                    encoding: null,
                    proxy
                },
                (error, response, body) => {
                    let code = 500;

                    if (response) {
                        code = response.statusCode;
                        res.header(filterHeaders(req, response.headers));
                    }

                    res.status(code).send(body);
                }
            );
        });

        const server = app.listen(argv.port, argv.public ? undefined : 'localhost', () => {
            if (argv.public) {
                console.log(
                    'Cesium development server running publicly.  Connect to http://localhost:%d/',
                    server.address().port
                );
            } else {
                console.log(
                    'Cesium development server running locally.  Connect to http://localhost:%d/',
                    server.address().port
                );
            }
        });

        server.on('error', (e) => {
            if (e.code === 'EADDRINUSE') {
                console.log('Error: Port %d is already in use, select a different port.', argv.port);
                console.log('Example: node server.cjs --port %d', argv.port + 1);
            } else if (e.code === 'EACCES') {
                console.log('Error: This process does not have permission to listen on port %d.', argv.port);
                if (argv.port < 1024) {
                    console.log('Try a port number higher than 1024.');
                }
            }
            console.log(e);
            process.exit(1);
        });

        server.on('close', () => {
            console.log('Cesium development server stopped.');
        });

        let isFirstSig = true;
        process.on('SIGINT', () => {
            if (isFirstSig) {
                console.log('Cesium development server shutting down.');
                server.close(() => {
                    process.exit(0);
                });
                isFirstSig = false;
            } else {
                console.log('Cesium development server force kill.');
                process.exit(1);
            }
        });
    }
})();
