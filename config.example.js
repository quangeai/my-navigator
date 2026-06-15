// ==================== 权哥导航 - 配置文件模板 ====================
//
// 使用方法（两种部署模式，二选一）：
//
// ┌────────────────────────────────────────────────────────────────────────┐
// │  模式 A：Cloudflare Pages 部署（推荐用于公开站点）                        │
// │────────────────────────────────────────────────────────────────────────│
// │  1. 复制本文件到 config.js（config.js 已在 .gitignore 中，不会被提交） │
// │  2. 或者直接在 Cloudflare Pages 控制台设置环境变量（不需要创建 config.js）│
// │  3. 在 Cloudflare Pages 项目设置中，添加以下环境变量：                   │
// │     - SUPABASE_URL        = https://your-project-ref.supabase.co       │
// │     - SUPABASE_ANON_KEY  = your-anon-public-key-here                   │
// │     - DEBUG              = false                                        │
// │  4. 重新部署（_worker.js 会自动从环境变量读取并注入到页面）              │
// │                                                                        │
// │  优点：敏感信息完全在 Cloudflare 控制台管理，Git 仓库中无任何密钥        │
// └────────────────────────────────────────────────────────────────────────┘
//
// ┌────────────────────────────────────────────────────────────────────────┐
// │  模式 B：本地/私有部署（适用于本地测试或私有服务器）                      │
// │────────────────────────────────────────────────────────────────────────│
// │  1. 复制本文件为 config.js                                              │
// │  2. 在 config.js 中填入你的实际配置                                     │
// │  3. 确保 config.js 已在 .gitignore 中（默认已配置）                     │
// │  4. 直接在本地或私有服务器上部署                                        │
// │                                                                        │
// │  注意：如果部署到公开可访问的位置，config.js 中的内容会被公开可见！      │
// │  此时应改用模式 A（Cloudflare Pages）或自行实现后端代理。                │
// └────────────────────────────────────────────────────────────────────────┘
//
// 安全说明（重要！请务必阅读）：
// ──────────────────────────────────────────────────────────────────────────
// 1. SUPABASE_ANON_KEY（匿名密钥）
//    - 按 Supabase 的设计，这个 key 是公开的
//    - 它只能用于执行用户自己的数据操作，受 RLS 策略限制
//    - 即使别人拿到这个 key，没有正确的登录凭证，也无法读写他人数据
//    - 真正的安全依赖：Supabase 的 RLS（行级安全策略）必须正确配置
//
// 2. SUPABASE_URL（项目地址）
//    - 虽然不是超级敏感信息，但建议不要暴露在公共 Git 仓库中
//    - 原因：避免不必要的扫描、骚扰、针对特定项目的攻击
//
// 3. 配置文件
//    - config.js 包含敏感信息，已在 .gitignore 中，绝对不要提交到 Git！
//    - _worker.js 不包含敏感信息，只负责注入逻辑，可以安全提交
//    - config-loader.js 不包含敏感信息，只是加载逻辑，可以安全提交
//    - config.example.js 是公共模板，不包含实际密钥，可以安全提交
//
// 4. RLS 策略检查清单
//    - ✅ bookmarks 表：启用 RLS，设置策略 "Users manage own bookmarks"
//    - ✅ admin_cards 表：启用 RLS，设置策略 "Anyone read admin cards"
//    - ✅ 禁用 service_role key 的公开使用（service_role key 绝不能出现在前端）
//    - ✅ 定期在 Supabase Dashboard 检查策略是否正常工作
// ──────────────────────────────────────────────────────────────────────────

window.QUANGE_CONFIG = {

    // ───────────── 调试开关 ─────────────
    // 设为 true 会在控制台打印详细日志，便于调试排查问题
    DEBUG: false,

    // ───────────── Supabase 配置 ─────────────
    // 说明：
    //   - Anon Key 按设计是公开的，真正的安全依赖 RLS（行级安全策略）
    //   - 即使别人拿到 Anon Key，没有正确的 RLS 策略，也无法读写数据
    //   - 请勿将 service_role key（管理密钥）放入此处！
    //   - service_role key 只能在安全的后端服务器上使用，绝不能出现在前端
    //
    // 获取方式：
    //   Supabase Dashboard → Project Settings → API →
    //   URL: Project URL
    //   anon public: anon public key
    //
    // 注意：以下是示例值，请替换为你自己的实际配置
    // 或者：如果你使用 Cloudflare Pages 部署，可以删除 config.js
    // 直接在 Cloudflare Pages 控制台设置环境变量 SUPABASE_URL 和 SUPABASE_ANON_KEY
    SUPABASE_URL: 'https://your-project-ref.supabase.co',
    SUPABASE_ANON_KEY: 'your-anon-public-key-here',

    // ───────────── 功能开关（可选，未来扩展用） ─────────────
    FEATURES: {
        cloudSync: true,      // 是否启用云端同步（设为 false 则完全本地运行）
        exportImport: true,   // 是否启用书签导入导出
        themeSwitcher: true,  // 是否启用主题切换
    },

    // ───────────── 本地存储键名（统一管理，避免硬编码） ─────────────
    STORAGE_KEYS: {
        data: 'qnav_data',
        stars: 'qnav_stars',
        wallpaper: 'qnav_wallpaper',
        searchEngine: 'qnav_search_engine',
        editPassword: 'qnav_edit_password',
        homeCardStyle: 'qnav_home_card_style',
        aiToolCardStyle: 'qnav_ai_tool_card_style',
        bookmarkCardStyle: 'cardStyle',
        theme: 'theme'
    },

    // ───────────── CDN 资源地址（如需自建，可以替换为自托管地址） ─────────────
    CDN: {
        supabase: 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2'
    }

};
