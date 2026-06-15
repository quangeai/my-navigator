// ==================== 权哥导航 - 智能配置加载器 ====================
// 支持两种部署模式：
// 1. Cloudflare Pages 部署模式：从 Cloudflare 环境变量读取（由 Functions/_worker.js 注入）
// 2. 本地部署模式：从 config.js 文件读取（config.js 不提交到 Git）
//
// 安全说明：
//   - SUPABASE_ANON_KEY 按 Supabase 设计是公开的（anonymous key）
//   - 真正的安全依赖 Supabase 的 RLS（行级安全策略）
//   - 即使别人拿到 anon key，没有正确的 RLS 策略，也无法读写数据
//   - 但我们仍然不建议将具体配置暴露在公共 Git 仓库中，避免不必要的骚扰
(function () {
    'use strict';

    // 默认配置（空值，需要用户填充或从 Cloudflare 注入）
    var defaultConfig = {
        DEBUG: false,
        SUPABASE_URL: '',
        SUPABASE_ANON_KEY: ''
    };

    // 尝试从多个来源加载配置
    function loadConfig() {
        var finalConfig = Object.assign({}, defaultConfig);

        // 来源1: 优先从 Cloudflare Pages Functions 注入的配置读取
        // （通过 _worker.js 或 functions/ 目录中的脚本注入 window.__CF_CONFIG__）
        if (typeof window.__CF_CONFIG__ !== 'undefined' && window.__CF_CONFIG__) {
            if (window.__CF_CONFIG__.SUPABASE_URL) {
                finalConfig.SUPABASE_URL = window.__CF_CONFIG__.SUPABASE_URL;
            }
            if (window.__CF_CONFIG__.SUPABASE_ANON_KEY) {
                finalConfig.SUPABASE_ANON_KEY = window.__CF_CONFIG__.SUPABASE_ANON_KEY;
            }
            if (typeof window.__CF_CONFIG__.DEBUG !== 'undefined') {
                finalConfig.DEBUG = window.__CF_CONFIG__.DEBUG === 'true' || window.__CF_CONFIG__.DEBUG === true;
            }
        }

        // 来源2: 从 config.js 中读取（本地部署时使用，config.js 不提交到 Git）
        // 注意：config.js 中的配置会覆盖 Cloudflare 注入的配置（允许本地覆盖）
        if (typeof window.QUANGE_CONFIG !== 'undefined' && window.QUANGE_CONFIG) {
            if (window.QUANGE_CONFIG.SUPABASE_URL) {
                finalConfig.SUPABASE_URL = window.QUANGE_CONFIG.SUPABASE_URL;
            }
            if (window.QUANGE_CONFIG.SUPABASE_ANON_KEY) {
                finalConfig.SUPABASE_ANON_KEY = window.QUANGE_CONFIG.SUPABASE_ANON_KEY;
            }
            if (typeof window.QUANGE_CONFIG.DEBUG !== 'undefined') {
                finalConfig.DEBUG = window.QUANGE_CONFIG.DEBUG;
            }
        }

        // 验证配置是否有效
        finalConfig.isConfigured = function () {
            return !!this.SUPABASE_URL &&
                this.SUPABASE_URL !== 'https://your-project-ref.supabase.co' &&
                !!this.SUPABASE_ANON_KEY;
        };

        // 添加 preconnect 动态注入
        if (finalConfig.SUPABASE_URL) {
            var link = document.createElement('link');
            link.rel = 'preconnect';
            link.href = finalConfig.SUPABASE_URL;
            link.crossOrigin = 'anonymous';
            document.head.appendChild(link);

            var dnsPrefetch = document.createElement('link');
            dnsPrefetch.rel = 'dns-prefetch';
            dnsPrefetch.href = finalConfig.SUPABASE_URL;
            document.head.appendChild(dnsPrefetch);
        }

        // 将最终配置暴露到全局
        window.QUANGE_CONFIG = finalConfig;

        // 配置状态标记
        window.__QUANGE_CONFIG_LOADED = true;

        // 调试输出
        if (finalConfig.DEBUG) {
            console.log('[config-loader] 配置已加载:', {
                SUPABASE_URL: finalConfig.SUPABASE_URL ? '已配置' : '未配置',
                SUPABASE_ANON_KEY: finalConfig.SUPABASE_ANON_KEY ? '已配置' : '未配置',
                source: (typeof window.__CF_CONFIG__ !== 'undefined') ? 'Cloudflare' : 'Local Config'
            });
        }
    }

    // 立即执行配置加载
    loadConfig();
})();
