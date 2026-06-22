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
//
// 调试方法：
//   - 部署后打开浏览器开发者工具（F12），在 Console 中输入：window.__CF_CONFIG__
//   - 或者在 HTML 源代码中搜索 "CF_CONFIG_INJECTED" 检查注入是否成功

export async function onRequest(context) {
    try {
        const { request, env, next } = context;

        // 只处理 HTML 页面请求（index.html）
        const url = new URL(request.url);
        const accept = request.headers.get('Accept') || '';
        const isHTMLRequest = url.pathname === '/' ||
            url.pathname.endsWith('.html') ||
            accept.includes('text/html');

        // 如果不是 HTML 请求，直接传递给下一个处理器
        if (!isHTMLRequest) {
            return await next();
        }

        // 从环境变量获取配置
        const supabaseUrl = env.SUPABASE_URL || '';
        const supabaseAnonKey = env.SUPABASE_ANON_KEY || '';
        const adminEmail = env.ADMIN_EMAIL || '';
        const debugMode = env.DEBUG || 'false';

        // 获取原始响应
        const response = await next();

        // 如果不是 HTML 响应，直接返回
        const contentType = response.headers.get('Content-Type') || '';
        if (!contentType.includes('text/html')) {
            return response;
        }

        // 读取 HTML 内容
        const html = await response.text();

        // 生成配置注入脚本（放在最前面，确保在 config.js 之前执行）
        // 这个脚本会在 <head> 标签后立即执行，设置 window.__CF_CONFIG__
        const configScript = `<!-- CF_CONFIG_INJECTED -->
    <script>
        // Cloudflare Pages 环境变量注入（由 functions/_middleware.js 自动生成）
        // 必须在 config-loader.js 之前执行，否则配置无法被读取
        window.__CF_CONFIG__ = {
            SUPABASE_URL: ${JSON.stringify(supabaseUrl)},
            SUPABASE_ANON_KEY: ${JSON.stringify(supabaseAnonKey)},
            ADMIN_EMAIL: ${JSON.stringify(adminEmail)},
            DEBUG: ${JSON.stringify(debugMode)}
        };
        console.log('[Cloudflare Functions] 配置已注入:', {
            urlConfigured: !!window.__CF_CONFIG__.SUPABASE_URL,
            keyConfigured: !!window.__CF_CONFIG__.SUPABASE_ANON_KEY
        });
    </script>`;

        // 策略：在 <head> 标签后立即注入，确保它是第一个执行的脚本
        // 使用多种可能的 head 标签格式作为匹配目标
        let injected = false;
        const headPatterns = [
            /<head[^>]*>/i,
            /<HEAD[^>]*>/,
        ];
        let newHtml = html;
        for (const pattern of headPatterns) {
            if (pattern.test(html)) {
                newHtml = html.replace(pattern, match => match + '\n    ' + configScript);
                injected = true;
                break;
            }
        }

        // 兜底策略：如果没找到 <head> 标签，回退到 </head> 之前注入
        if (!injected) {
            newHtml = html.replace('</head>', configScript + '\n    </head>');
        }

        // 返回修改后的 HTML 响应
        return new Response(newHtml, {
            status: response.status,
            statusText: response.statusText,
            headers: {
                'Content-Type': 'text/html; charset=utf-8',
                'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
                'X-Content-Type-Options': 'nosniff',
                'X-Frame-Options': 'SAMEORIGIN'
            }
        });
    } catch (error) {
        // 出错时，降级到原始响应（确保站点不会因为配置问题而完全不可用）
        console.error('[CF Functions] 配置注入失败:', error);
        return await context.next();
    }
}
