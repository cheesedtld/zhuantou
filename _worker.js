export default {
    async fetch(request, env) {
        const url = new URL(request.url);

        // 处理跨域预检请求 (OPTIONS)
        if (request.method === "OPTIONS") {
            return new Response(null, {
                headers: {
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
                    "Access-Control-Allow-Headers": "*",
                    "Access-Control-Max-Age": "86400"
                }
            });
        }

        // 专属自建代理通道
        if (url.pathname.startsWith('/proxy/')) {
            // 例如: /proxy/https://api.minimax.chat/...
            const targetUrlStr = request.url.substring(request.url.indexOf('/proxy/') + 7);
            let targetUrl;
            try {
                targetUrl = new URL(targetUrlStr);
            } catch (e) {
                return new Response('Invalid proxy URL', { status: 400 });
            }

            const newRequestInit = {
                method: request.method,
                headers: new Headers(request.headers),
                redirect: 'follow',
            };

            if (request.method !== 'GET' && request.method !== 'HEAD') {
                newRequestInit.body = request.body;
            }

            // 移除原有的可能引起跨域拒绝的头
            newRequestInit.headers.delete('Host');
            newRequestInit.headers.delete('Origin');
            newRequestInit.headers.delete('Referer');

            try {
                const upResponse = await fetch(targetUrl, newRequestInit);

                const newResponseInit = {
                    status: upResponse.status,
                    statusText: upResponse.statusText,
                    headers: new Headers(upResponse.headers)
                };

                // 覆写跨域头允许所有前端访问
                newResponseInit.headers.set('Access-Control-Allow-Origin', '*');
                newResponseInit.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
                newResponseInit.headers.set('Access-Control-Allow-Headers', '*');

                return new Response(upResponse.body, newResponseInit);
            } catch (e) {
                return new Response('Proxy Error: ' + e.message, { status: 500 });
            }
        }

        // 默认回退给 Cloudflare Pages 本身的文件系统来处理其它页面比如 index.html 和 script.js
        return env.ASSETS.fetch(request);
    }
};
