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
        SUPABASE_ANON_KEY: '',
        ADMIN_EMAIL: ''
    };

    // 尝试从多个来源加载配置
    function loadConfig() {
        var finalConfig = Object.assign({}, defaultConfig);

        // --- 公共辅助函数 ---
        // 检查配置值是否有效（非空、非占位符）
        function isValidConfigValue(val) {
            if (!val) return false;
            if (typeof val !== 'string') return !!val;
            var trimmed = val.trim();
            if (!trimmed) return false;
            if (/your-project|your-anon|YOUR_|placeholder|示例|replace|your-admin/i.test(trimmed)) return false;
            return true;
        }

        // --- 来源1: 优先从 Cloudflare Pages Functions 注入的配置读取 ---
        if (typeof window.__CF_CONFIG__ !== 'undefined' && window.__CF_CONFIG__) {
            if (window.__CF_CONFIG__.SUPABASE_URL) {
                finalConfig.SUPABASE_URL = window.__CF_CONFIG__.SUPABASE_URL;
            }
            if (window.__CF_CONFIG__.SUPABASE_ANON_KEY) {
                finalConfig.SUPABASE_ANON_KEY = window.__CF_CONFIG__.SUPABASE_ANON_KEY;
            }
            if (window.__CF_CONFIG__.ADMIN_EMAIL) {
                finalConfig.ADMIN_EMAIL = window.__CF_CONFIG__.ADMIN_EMAIL;
            }
            if (typeof window.__CF_CONFIG__.DEBUG !== 'undefined') {
                finalConfig.DEBUG = window.__CF_CONFIG__.DEBUG === 'true' || window.__CF_CONFIG__.DEBUG === true;
            }
        }

        // --- 来源2: 从 config.js 中读取（本地部署时使用，config.js 不提交到 Git） ---
        // 只有当 config.js 中的值为有效值时才会覆盖，避免空的 config.js 意外覆盖 __CF_CONFIG__
        if (typeof window.QUANGE_CONFIG !== 'undefined' && window.QUANGE_CONFIG) {
            if (isValidConfigValue(window.QUANGE_CONFIG.SUPABASE_URL)) {
                finalConfig.SUPABASE_URL = window.QUANGE_CONFIG.SUPABASE_URL;
            }
            if (isValidConfigValue(window.QUANGE_CONFIG.SUPABASE_ANON_KEY)) {
                finalConfig.SUPABASE_ANON_KEY = window.QUANGE_CONFIG.SUPABASE_ANON_KEY;
            }
            if (isValidConfigValue(window.QUANGE_CONFIG.ADMIN_EMAIL)) {
                finalConfig.ADMIN_EMAIL = window.QUANGE_CONFIG.ADMIN_EMAIL;
            }
            if (typeof window.QUANGE_CONFIG.DEBUG !== 'undefined') {
                finalConfig.DEBUG = window.QUANGE_CONFIG.DEBUG === 'true' ||
                                    window.QUANGE_CONFIG.DEBUG === true;
            }
        }

        // --- 验证配置是否有效 ---
        finalConfig.isConfigured = function () {
            return isValidConfigValue(this.SUPABASE_URL) &&
                   isValidConfigValue(this.SUPABASE_ANON_KEY);
        };

        // --- 添加 preconnect 动态注入 ---
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

        // --- 将最终配置暴露到全局 ---
        window.QUANGE_CONFIG = finalConfig;
        window.__QUANGE_CONFIG_LOADED = true;

        // --- 调试输出 ---
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

    // --- 兜底机制: 如果第一次执行时 __CF_CONFIG__ 尚未被设置 ---
    // (例如注入脚本在本脚本之后才执行，或 Cloudflare Worker 出错延迟注入)
    // 在 DOMContentLoaded 后重新检查一次，确保配置最终能被应用
    function recheckConfig() {
        var hasCFConfig = typeof window.__CF_CONFIG__ !== 'undefined' &&
                          window.__CF_CONFIG__ &&
                          (window.__CF_CONFIG__.SUPABASE_URL || window.__CF_CONFIG__.SUPABASE_ANON_KEY);

        var currentConfig = window.QUANGE_CONFIG || {};
        var hasValues = currentConfig.SUPABASE_URL && currentConfig.SUPABASE_ANON_KEY;

        if (hasCFConfig && !hasValues) {
            console.log('[config-loader] 发现延迟加载的 Cloudflare 配置，重新应用...');
            loadConfig();
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', recheckConfig);
    } else {
        // DOM 已经就绪，立即检查
        recheckConfig();
    }

    // --- 兜底机制 2: 处理浏览器 bfcache（往返缓存）恢复 ---
    // 当用户通过浏览器前进/后退按钮返回页面时，页面可能从 bfcache 恢复
    // 此时 DOMContentLoaded 不会重新触发，但 __CF_CONFIG__ 可能已被清除
    window.addEventListener('pageshow', function (event) {
        if (event.persisted) {
            // 页面从 bfcache 恢复，重新检查配置
            var hasCFConfig = typeof window.__CF_CONFIG__ !== 'undefined' &&
                              window.__CF_CONFIG__ &&
                              (window.__CF_CONFIG__.SUPABASE_URL || window.__CF_CONFIG__.SUPABASE_ANON_KEY);
            var currentConfig = window.QUANGE_CONFIG || {};
            var hasValues = currentConfig.SUPABASE_URL && currentConfig.SUPABASE_ANON_KEY;
            if (!hasValues) {
                if (hasCFConfig) {
                    loadConfig();
                }
            }
        }
    });

    // --- 兜底机制 3: 页面可见性变化时重新检查 ---
    // 用户切换标签页回来时，确保配置仍然有效
    document.addEventListener('visibilitychange', function () {
        if (!document.hidden) {
            var currentConfig = window.QUANGE_CONFIG || {};
            if (!currentConfig.isConfigured || !currentConfig.isConfigured()) {
                var hasCFConfig = typeof window.__CF_CONFIG__ !== 'undefined' &&
                                  window.__CF_CONFIG__ &&
                                  (window.__CF_CONFIG__.SUPABASE_URL || window.__CF_CONFIG__.SUPABASE_ANON_KEY);
                if (hasCFConfig) {
                    loadConfig();
                }
            }
        }
    });
})();
