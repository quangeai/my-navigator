// ==================== 权哥导航 - Cloudflare Pages Functions 环境变量注入 ====================
//
// 功能：
//   1. 在 Cloudflare Pages 部署时，从环境变量读取 SUPABASE_URL 和 SUPABASE_ANON_KEY
//   2. 将配置注入到 HTML 页面中，作为内联脚本 window.__CF_CONFIG__
//   3. 本地开发（或未配置 Cloudflare 环境变量）时，自动降级，页面仍然可以通过 config.js 工作
//
// 使用方法：
//   在 Cloudflare Pages 控制台中设置以下环境变量：
//   - SUPABASE_URL:     https://your-project-ref.supabase.co
//   - SUPABASE_ANON_KEY: your-anon-key-here
//   - ADMIN_EMAIL:      your-admin@example.com  (可选，管理员邮箱，拥有管理面板权限)
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
            const adminEmail = env.ADMIN_EMAIL || '';
            const debugMode = env.DEBUG || 'false';

            // 生成配置注入脚本
            // 必须在任何其他脚本之前执行，所以注入到 <head> 标签后的第一个位置
            const configScript = `<script>
        // Cloudflare Pages 环境变量注入（由 functions/_middleware.js 自动生成）
        // 必须在 config-loader.js 之前执行，否则配置无法被读取
        window.__CF_CONFIG__ = {
            SUPABASE_URL: ${JSON.stringify(supabaseUrl)},
            SUPABASE_ANON_KEY: ${JSON.stringify(supabaseAnonKey)},
            ADMIN_EMAIL: ${JSON.stringify(adminEmail)},
            DEBUG: ${JSON.stringify(debugMode)}
        };
    </script>`;

            // 策略：在 <head> 标签后立即注入，确保它是第一个执行的脚本
            // 使用多种可能的 head 标签格式作为匹配目标
            let injected = false;
            const headPatterns = [
                /<head[^>]*>/i,
                /<HEAD[^>]*>/,
            ];
            for (const pattern of headPatterns) {
                if (pattern.test(html)) {
                    html = html.replace(pattern, match => match + '\n    ' + configScript);
                    injected = true;
                    break;
                }
            }

            // 兜底策略：如果没找到 <head> 标签，回退到 </head> 之前注入
            // 同时在脚本中添加延迟检查，保证即使位置不对也能生效
            if (!injected) {
                html = html.replace('</head>', configScript + '\n    </head>');
            }

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
            console.error('[CF Functions] 配置注入失败:', error);
            return await env.ASSETS.fetch(request);
        }
    }
};