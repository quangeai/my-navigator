// ==================== 权哥导航 - Cloudflare Pages Workers 环境变量注入 ====================
//
// 功能：
//   1. 在 Cloudflare Pages 部署时，从环境变量读取 SUPABASE_URL 和 SUPABASE_ANON_KEY
//   2. 将配置注入到 HTML 页面中，作为内联脚本 window.__CF_CONFIG__
//   3. 本地开发（或未配置 Cloudflare 环境变量）时，自动降级，页面仍然可以通过 config.js 工作
//
// 使用方法：
//   在 Cloudflare Pages 控制台中设置以下环境变量：
//   - SUPABASE_URL:    https://your-project-ref.supabase.co
//   - SUPABASE_ANON_KEY: your-anon-key-here
//   - DEBUG:            false
//
// 注意：
//   - 此文件应该提交到 Git（它不包含任何敏感信息，只是注入逻辑）
//   - 实际的密钥值在 Cloudflare Pages 控制台中设置，不会出现在代码或 Git 中
//   - Supabase 的 anon key 按设计是公开的，真正的安全依赖 RLS
//   - 但是仍然建议不要将具体的 key 暴露在 Git 中，避免骚扰

export default {
    async fetch(request, env, ctx) {
        try {
            // 只处理 HTML 页面请求（index.html）
            const url = new URL(request.url);
            const accept = request.headers.get('Accept') || '';
            const isHTMLRequest = url.pathname === '/' ||
                url.pathname.endsWith('.html') ||
                accept.includes('text/html');

            // 如果不是 HTML 请求，直接传递给静态资源处理
            if (!isHTMLRequest) {
                return await env.ASSETS.fetch(request);
            }

            // 获取原始 HTML 内容
            const response = await env.ASSETS.fetch(request);

            // 如果不是 HTML 响应，直接返回
            const contentType = response.headers.get('Content-Type') || '';
            if (!contentType.includes('text/html')) {
                return response;
            }

            // 读取 HTML 内容
            let html = await response.text();

            // 从环境变量获取配置
            // env 对象包含 Cloudflare Pages 控制台设置的所有环境变量
            const supabaseUrl = env.SUPABASE_URL || '';
            const supabaseAnonKey = env.SUPABASE_ANON_KEY || '';
            const debugMode = env.DEBUG || 'false';

            // 生成配置注入脚本
            // 将配置作为内联脚本注入到 <head> 中，config-loader.js 会读取它
            const configScript = `
    <!-- Cloudflare Pages 环境变量注入（由 _worker.js 自动生成） -->
    <script>
        window.__CF_CONFIG__ = {
            SUPABASE_URL: ${JSON.stringify(supabaseUrl)},
            SUPABASE_ANON_KEY: ${JSON.stringify(supabaseAnonKey)},
            DEBUG: ${JSON.stringify(debugMode)}
        };
    </script>`;

            // 将配置脚本注入到 </head> 之前
            // 确保它在 config-loader.js 和 app.js 之前加载
            html = html.replace('</head>', configScript + '\n</head>');

            // 返回修改后的 HTML 响应
            return new Response(html, {
                status: response.status,
                statusText: response.statusText,
                headers: {
                    'Content-Type': 'text/html; charset=utf-8',
                    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
                    // 安全相关的 headers（可选，但推荐）
                    'X-Content-Type-Options': 'nosniff',
                    'X-Frame-Options': 'SAMEORIGIN'
                }
            });
        } catch (error) {
            // 出错时，降级到原始响应（确保站点不会因为配置问题而完全不可用）
            console.error('[CF Worker] 配置注入失败:', error);
            return await env.ASSETS.fetch(request);
        }
    }
};
