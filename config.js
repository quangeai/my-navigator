// ==================== 权哥导航 - 本地配置 ====================
// 重要提示：
//   1. 本文件已加入 .gitignore，不会被提交到 Git 仓库
//   2. 部署到 Cloudflare Pages 时，无需编辑本文件，直接在 Cloudflare 控制台设置环境变量即可
//      （_worker.js 会自动读取 SUPABASE_URL、SUPABASE_ANON_KEY、ADMIN_EMAIL、DEBUG 等环境变量并注入页面）
//   3. 仅本地开发/私有部署时，才需要修改本文件填入真实配置
//   4. config.js 的优先级高于 Cloudflare 环境变量（本地优先）
//
// 使用方法：
//   - 复制 config.example.js 为 config.js（若不存在）
//   - 填入你的实际 Supabase URL 和 anon key（service_role key 严禁使用！）
//   - 保存后刷新页面即可

window.QUANGE_CONFIG = {
    DEBUG: false,
    SUPABASE_URL: '',
    SUPABASE_ANON_KEY: '',
    ADMIN_EMAIL: ''
};
