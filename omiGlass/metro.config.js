const { getDefaultConfig } = require('expo/metro-config');
const { scanWindowsWifi } = require('./scripts/local-wifi.cjs');

const config = getDefaultConfig(__dirname);

const defaultEnhanceMiddleware = config.server?.enhanceMiddleware;
config.server = {
    ...config.server,
    enhanceMiddleware: middleware => {
        const enhanced = defaultEnhanceMiddleware ? defaultEnhanceMiddleware(middleware) : middleware;
        return async (request, response, next) => {
            if (request.url?.split('?')[0] !== '/api/local-wifi') {
                return enhanced(request, response, next);
            }
            response.setHeader('Content-Type', 'application/json; charset=utf-8');
            response.setHeader('Cache-Control', 'no-store');
            try {
                const result = process.platform === 'win32'
                    ? await scanWindowsWifi()
                    : { currentSsid: '', networks: [], unsupported: true };
                response.statusCode = 200;
                response.end(JSON.stringify(result));
            } catch (error) {
                response.statusCode = 503;
                response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
            }
        };
    },
};

module.exports = config;
