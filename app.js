// ==================== 配置 ====================
// 注意：所有配置集中在 config.js 中管理，这里只从配置对象读取
const CONFIG = window.QUANGE_CONFIG || {
    DEBUG: false,
    SUPABASE_URL: '',
    SUPABASE_ANON_KEY: '',
    ADMIN_EMAIL: ''
};

const DEBUG = CONFIG.DEBUG;
const log = (...args) => { if (DEBUG) console.log(...args); };
const warn = (...args) => { if (DEBUG) console.warn(...args); };
const error = (...args) => { if (DEBUG) error(...args); };

const SUPABASE_URL = CONFIG.SUPABASE_URL;
const SUPABASE_ANON_KEY = CONFIG.SUPABASE_ANON_KEY;

const SETUP_SQL = `
CREATE TABLE IF NOT EXISTS bookmarks (
    id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id       UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    parent_id     UUID REFERENCES bookmarks(id) ON DELETE CASCADE,
    name          TEXT NOT NULL,
    url           TEXT,
    icon          TEXT,
    is_folder     BOOLEAN DEFAULT false,
    starred       BOOLEAN DEFAULT false,
    pinned        BOOLEAN DEFAULT false,
    sort_order    INTEGER DEFAULT 0,
    deleted       BOOLEAN DEFAULT false,
    deleted_at    TIMESTAMPTZ,
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    updated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS admin_cards (
    id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    name          TEXT NOT NULL,
    url           TEXT NOT NULL,
    icon          TEXT DEFAULT '🔗',
    sort_order    INTEGER DEFAULT 0,
    created_at    TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE bookmarks ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_cards ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own bookmarks" ON bookmarks
    FOR ALL USING (auth.uid() = user_id);

CREATE POLICY "Anyone read admin cards" ON admin_cards
    FOR SELECT USING (true);

CREATE INDEX IF NOT EXISTS idx_bookmarks_user ON bookmarks(user_id);
CREATE INDEX IF NOT EXISTS idx_bookmarks_parent ON bookmarks(parent_id);
`.trim();



// ==================== 全局 DOM 引用 ====================
const homeView = document.getElementById('homeView');
const bookmarksView = document.getElementById('bookmarksView');
const treeContainer = document.getElementById('treeContainer');
const bookmarkGrid = document.getElementById('bookmarkGrid');
const cardsBody = document.querySelector('.cards-body');
const heroBreadcrumb = document.getElementById('heroBreadcrumb');
const quickGrid = document.getElementById('homeQuickGrid');
const aiContainer = document.getElementById('aiToolsContainer');
const syncStatus = document.getElementById('syncStatus');
const syncDot = document.getElementById('syncDot');
const authModal = document.getElementById('authModal');
const settingsOverlay = document.getElementById('settingsOverlay');
const recycleBinOverlay = document.getElementById('recycleBinOverlay');
const moveToFolderOverlay = document.getElementById('moveToFolderOverlay');
const setupModal = document.getElementById('setupModal');
const ctxMenu = document.getElementById('contextMenu');
const userArea = document.getElementById('userArea');
const toastContainer = document.getElementById('toastContainer');

// ==================== 状态 ====================
let currentUser = null;
let isEditing = false;
let editPassword = null; // 存储编辑密码（简单存储，实际项目建议加密）
let editPasswordVerified = false; // 会话内是否已验证密码
let data = [];
let allBookmarks = [];
let stars = new Set();
let currentPath = [];
let supabaseClient = null;
let isCloudReady = false;
let isSyncing = false;
let currentWallpaper = '';
let currentSearchEngine = 'baidu';
let moveTargetNode = null;
let moveSelectedParentId = null;

// ==================== Toast 通知 ====================
function showToast(msg, type = 'info', duration = 3000) {
    const toast = document.createElement('div');
    toast.className = 'toast ' + type;
    toast.textContent = msg;
    toastContainer.appendChild(toast);
    setTimeout(() => { toast.style.opacity = '0'; toast.style.transition = 'opacity 0.3s'; }, duration - 300);
    setTimeout(() => toast.remove(), duration);
}

// ==================== 工具函数 ====================
function randomId() { return crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2, 11); }
function getDomain(url) { try { return new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return url; } }
function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }



function flattenTree(nodes, path = [], parentId = null) {
    let res = [];
    nodes.forEach(n => {
        const cur = [...path, n.name];
        if (n.isFolder || (n.children !== undefined)) {
            // 是文件夹，无论是否为空
            res.push({ ...n, path: cur, _parentId: parentId });
            if (n.children) res = res.concat(flattenTree(n.children, cur, n.id));
        } else if (n.url) {
            // 是书签
            res.push({ ...n, path: cur, _parentId: parentId });
        }
    });
    return res;
}

function getAllFolders(nodes, parentPath = '', excludeId = null) {
    let folders = [];
    nodes.forEach(n => {
        if (n.isFolder || (n.children !== undefined)) {
            if (n.id !== excludeId) {
                const p = parentPath ? parentPath + ' / ' + n.name : n.name;
                folders.push({ id: n.id, name: n.name, path: p });
            }
            if (n.children && n.id !== excludeId) {
                folders = folders.concat(getAllFolders(n.children, parentPath ? parentPath + ' / ' + n.name : n.name, excludeId));
            }
        }
    });
    return folders;
}

function findNodeById(nodes, id) {
    for (const n of nodes) {
        if (n.id === id) return n;
        if (n.children) {
            const found = findNodeById(n.children, id);
            if (found) return found;
        }
    }
    return null;
}

function removeNodeById(nodes, id) {
    return nodes.filter(node => {
        if (node.id === id) return false;
        if (node.children) node.children = removeNodeById(node.children, id);
        return true;
    });
}

function addNodeToParent(nodes, parentId, newNode) {
    if (!parentId) {
        nodes.push(newNode);
        return true;
    }
    for (const n of nodes) {
        if (n.id === parentId) {
            if (!n.children) n.children = [];
            n.children.push(newNode);
            return true;
        }
        if (n.children && addNodeToParent(n.children, parentId, newNode)) {
            return true;
        }
    }
    return false;
}

function generateId() {
    // 生成符合 UUID v4 格式的 ID
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

function findNodeByPath(nodes, path) {
    if (!path || path.length === 0) return null;
    let current = nodes;
    let result = null;
    for (const name of path) {
        const found = current.find(n => n.name === name);
        if (!found) return null;
        result = found;
        current = found.children || [];
    }
    return result;
}

function moveNodeById(nodes, nodeId, newParentId) {
    let movedNode = null;
    function extract(arr) {
        for (let i = 0; i < arr.length; i++) {
            if (arr[i].id === nodeId) {
                movedNode = arr.splice(i, 1)[0];
                return true;
            }
            if (arr[i].children && extract(arr[i].children)) return true;
        }
        return false;
    }
    function insert(arr) {
        for (const n of arr) {
            if (n.id === newParentId) {
                if (!n.children) n.children = [];
                n.children.push(movedNode);
                return true;
            }
            if (n.children && insert(n.children)) return true;
        }
        return false;
    }
    extract(nodes);
    if (!movedNode) return false;
    if (!newParentId) {
        nodes.push(movedNode);
        return true;
    }
    return insert(nodes);
}

function defaultData() {
    return [
        { id: randomId(), name: "工作", children: [
            { id: randomId(), name: "项目 Alpha", children: [
                { id: randomId(), name: "设计", children: [
                    { id: randomId(), name: "Figma", url: "https://figma.com" },
                    { id: randomId(), name: "图标", url: "https://iconify.design" }
                ]},
                { id: randomId(), name: "文档", url: "https://notion.so" }
            ]},
            { id: randomId(), name: "GitHub", url: "https://github.com" }
        ]},
        { id: randomId(), name: "学习", children: [
            { id: randomId(), name: "前端", url: "https://react.dev" },
            { id: randomId(), name: "后端", url: "https://nodejs.org" }
        ]},
        { id: randomId(), name: "生活", children: [{ id: randomId(), name: "购物", url: "https://amazon.com" }] }
    ];
}

// ==================== 数据加载与存储 ====================
function loadLocalData() {
    try {
        const stored = localStorage.getItem('qnav_data');
        if (stored) {
            data = JSON.parse(stored);
            // 确保所有ID都是有效的UUID格式
            ensureValidUUIDs(data);
        } else {
            data = defaultData();
        }
        const storedStars = localStorage.getItem('qnav_stars');
        stars = new Set(storedStars ? JSON.parse(storedStars) : []);
        allBookmarks = flattenTree(data);
    } catch (e) {
        data = defaultData();
        allBookmarks = flattenTree(data);
    }
}

function ensureValidUUIDs(nodes) {
    const idMap = {};
    // 第一步：检查并替换所有无效的ID
    function replaceIds(arr) {
        arr.forEach(node => {
            if (!isValidUUID(node.id)) {
                const oldId = node.id;
                const newId = generateId();
                node.id = newId;
                idMap[oldId] = newId;
                warn('[ensureValidUUIDs] 替换非UUID格式ID:', oldId, '->', newId);
            }
            if (node.children) {
                replaceIds(node.children);
            }
        });
    }
    replaceIds(nodes);
    // 如果有ID被替换，重新保存数据
    if (Object.keys(idMap).length > 0) {
        saveLocalData();
    }
}

function isValidUUID(uuid) {
    if (!uuid) return false;
    const regex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    return regex.test(uuid);
}

function saveLocalData() {
    try {
        localStorage.setItem('qnav_data', JSON.stringify(data));
        localStorage.setItem('qnav_stars', JSON.stringify([...stars]));
    } catch (e) {}
}

function loadSettings() {
    try {
        currentWallpaper = localStorage.getItem('qnav_wallpaper') || '';
        currentSearchEngine = localStorage.getItem('qnav_search_engine') || 'baidu';
        editPassword = localStorage.getItem('qnav_edit_password') || null;
        editPasswordVerified = false; // 每次加载重置验证状态
    } catch (e) {
        currentWallpaper = '';
        currentSearchEngine = 'baidu';
        editPassword = null;
        editPasswordVerified = false;
    }
}

function saveSettings() {
    try {
        localStorage.setItem('qnav_wallpaper', currentWallpaper);
        localStorage.setItem('qnav_search_engine', currentSearchEngine);
        if (editPassword) {
            localStorage.setItem('qnav_edit_password', editPassword);
        } else {
            localStorage.removeItem('qnav_edit_password');
        }
    } catch (e) {}
}

// ==================== Supabase 初始化 ====================
function initSupabaseClient() {
    // 使用统一的配置检查逻辑（由 config-loader.js 提供的 isConfigured）
    // 支持多种部署模式：Cloudflare 环境变量注入 / 本地 config.js / 空配置
    const configured = typeof CONFIG.isConfigured === 'function'
        ? CONFIG.isConfigured()
        : (!!SUPABASE_URL && !!SUPABASE_ANON_KEY &&
            SUPABASE_URL !== 'https://your-project.supabase.co' &&
            SUPABASE_URL !== 'https://your-project-ref.supabase.co');

    if (typeof supabase !== 'undefined' && configured) {
        try {
            supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
                auth: {
                    persistSession: true,
                    autoRefreshToken: true
                }
            });
            isCloudReady = true;
            log('[initSupabaseClient] Supabase 初始化成功，URL:', SUPABASE_URL);
            return true;
        } catch (e) {
            warn('[initSupabaseClient] Supabase 初始化失败，将使用离线模式', e);
        }
    } else {
        warn('[initSupabaseClient] Supabase 未配置或库未加载，supabase 库:', typeof supabase,
             'URL 已设置:', !!SUPABASE_URL, 'ANON_KEY 已设置:', !!SUPABASE_ANON_KEY);
    }
    return false;
}

// 获取配置诊断信息（用于帮助用户排查问题）
function getConfigDiagnostics() {
    const fromCF = typeof window.__CF_CONFIG__ !== 'undefined';
    const fromLocal = typeof window.QUANGE_CONFIG !== 'undefined' && CONFIG.SUPABASE_URL;
    const configured = typeof CONFIG.isConfigured === 'function' ? CONFIG.isConfigured() : false;
    const urlMasked = SUPABASE_URL ? (SUPABASE_URL.substring(0, 20) + '...') : '(空)';
    const keyMasked = SUPABASE_ANON_KEY ? (SUPABASE_ANON_KEY.substring(0, 10) + '...') : '(空)';
    return {
        配置来源: fromCF ? 'Cloudflare 环境变量注入' : (fromLocal ? '本地 config.js' : '未找到任何配置'),
        URL已设置: !!SUPABASE_URL,
        ANON_KEY已设置: !!SUPABASE_ANON_KEY,
        URL值预览: urlMasked,
        ANON_KEY值预览: keyMasked,
        配置是否有效: configured,
        Supabase库是否加载: typeof supabase !== 'undefined'
    };
}

async function safeSupabaseCall(promise) {
    if (!isCloudReady || !supabaseClient) return null;
    try {
        return await promise;
    } catch (e) {
        warn('Supabase 请求失败，继续离线模式', e);
        return null;
    }
}

// ==================== 自动建表检查 ====================
async function ensureTables() {
    log('[ensureTables] 开始检查数据表...');
    if (!isCloudReady) {
        log('[ensureTables] 未配置云服务，跳过检查');
        return { ok: true, reason: 'offline' };
    }
    
    // 先尝试查询 admin_cards 表（任何人可读）
    log('[ensureTables] 尝试查询 admin_cards 表...');
    const adminRes = await safeSupabaseCall(
        supabaseClient.from('admin_cards').select('id').limit(1)
    );
    if (adminRes && !adminRes.error) {
        log('[ensureTables] admin_cards 表查询成功，说明表已存在');
        return { ok: true, reason: 'exists' };
    }
    log('[ensureTables] admin_cards 查询结果：', adminRes);
    
    // 再尝试查询 bookmarks 表
    log('[ensureTables] 尝试查询 bookmarks 表...');
    const res = await safeSupabaseCall(
        supabaseClient.from('bookmarks').select('id').limit(1)
    );
    log('[ensureTables] bookmarks 查询结果：', res);
    
    if (res && !res.error) {
        log('[ensureTables] bookmarks 表查询成功');
        return { ok: true, reason: 'exists' };
    }
    
    if (!res) {
        log('[ensureTables] 查询返回 null/undefined，网络问题');
        return { ok: false, reason: 'network', detail: '无法连接 Supabase 服务器' };
    }
    
    if (res.error) {
        log('[ensureTables] 错误详情：', res.error);
        
        if (res.error.code === '42P01' || (res.error.message && (res.error.message.includes('relation') && res.error.message.includes('does not exist')))) {
            log('[ensureTables] 表不存在');
            return { ok: false, reason: 'no_table', detail: 'bookmarks 或 admin_cards 表不存在' };
        }
        
        if (res.error.code === '42501' || (res.error.message && res.error.message.includes('permission'))) {
            log('[ensureTables] RLS 权限问题，但表应该已存在');
            // 如果是 RLS 权限问题，说明表已存在，只是用户没权限读
            // 这其实是正常的（未登录时），我们允许通过
            return { ok: true, reason: 'rls_allow', detail: '表已存在（RLS 权限正常）' };
        }
        
        return { ok: false, reason: 'error', detail: res.error.message || res.error.code || '未知错误' };
    }
    return { ok: false, reason: 'unknown', detail: '未知错误' };
}

function showSetupModal() {
    document.getElementById('setupSqlBox').textContent = SETUP_SQL;
    const projectRef = SUPABASE_URL.match(/https:\/\/([^.]+)/)?.[1] || '';
    document.getElementById('supabaseSqlLink').href = `https://supabase.com/dashboard/project/${projectRef}/sql/new`;
    setupModal.classList.add('show');
}

document.getElementById('copySqlBtn').addEventListener('click', () => {
    navigator.clipboard.writeText(SETUP_SQL).then(() => {
        showToast('SQL 已复制到剪贴板', 'success');
    }).catch(() => {
        const ta = document.createElement('textarea');
        ta.value = SETUP_SQL;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        showToast('SQL 已复制到剪贴板', 'success');
    });
});

document.getElementById('skipSetupBtn').addEventListener('click', () => {
    setupModal.classList.remove('show');
    showToast('已切换到离线模式，数据仅保存在本地', 'info');
});

document.getElementById('retrySetupBtn').addEventListener('click', async () => {
    const result = await ensureTables();
    if (result.ok) {
        setupModal.classList.remove('show');
        if (result.reason === 'rls_allow') {
            showToast('✅ 表已创建（RLS 权限正常）！请刷新页面或直接登录。', 'success', 4000);
        } else {
            showToast('✅ 数据表已就绪！', 'success');
        }
        log('[retrySetupBtn] 检查通过，result:', result);
        if (currentUser) {
            await threeWayMergeSync();
            await loadCloudData();
            renderAll();
        }
    } else {
        log('[retrySetupBtn] 检查失败，result:', result);
        if (result.reason === 'network') {
            showToast('❌ ' + result.detail + '，请检查网络或 Supabase 项目状态（浏览器控制台有详细日志）', 'error', 6000);
        } else if (result.reason === 'no_table') {
            showToast('📋 ' + result.detail + '，请先复制 SQL 到 Supabase 执行（浏览器控制台有详细日志）', 'warning', 6000);
        } else {
            showToast('⚠️ 检查失败：' + (result.detail || '未知原因') + '（浏览器控制台有详细日志）', 'error', 6000);
        }
    }
});

// ==================== 云端数据操作 ====================
function treeToFlat(nodes, userId, parentId = null, sortOrder = 0) {
    let flat = [];
    let order = sortOrder;
    nodes.forEach(n => {
        const isFolder = !!(n.isFolder || n.children !== undefined);
        flat.push({
            id: n.id,
            user_id: userId,
            parent_id: parentId,
            name: n.name,
            url: n.url || null,
            icon: n.icon || null,
            is_folder: isFolder,
            starred: n.url ? stars.has(n.url) : false,
            sort_order: order++,
            deleted: false,
            deleted_at: null
        });
        if (n.children && n.children.length > 0) {
            const childFlat = treeToFlat(n.children, userId, n.id, 0);
            flat = flat.concat(childFlat);
        }
    });
    return flat;
}

function flatToTree(flatList) {
    const map = {};
    const roots = [];
    flatList.forEach(item => {
        map[item.id] = {
            id: item.id,
            name: item.name,
            url: item.url || undefined,
            icon: item.icon || undefined,
            isFolder: item.is_folder,
            children: item.is_folder ? [] : undefined
        };
    });
    flatList.forEach(item => {
        const node = map[item.id];
        if (item.parent_id && map[item.parent_id]) {
            if (!map[item.parent_id].children) {
                map[item.parent_id].children = [];
            }
            map[item.parent_id].children.push(node);
        } else if (!item.parent_id) {
            roots.push(node);
        }
    });
    function cleanEmptyChildren(nodes) {
        nodes.forEach(n => {
            if (n.children && n.children.length === 0 && !n.isFolder) {
                delete n.children;
            } else if (n.children) {
                cleanEmptyChildren(n.children);
            }
        });
    }
    cleanEmptyChildren(roots);
    return roots;
}

async function syncAllToCloud() {
    if (!isCloudReady || !currentUser) {
        warn('[syncAllToCloud] 云端未就绪，跳过同步', 'isCloudReady:', isCloudReady, 'currentUser:', currentUser);
        return;
    }
    isSyncing = true;
    updateSyncIndicator('syncing');
    log('[syncAllToCloud] 开始同步，云端已就绪');
    try {
        const flat = treeToFlat(data, currentUser.id);
        log('[syncAllToCloud] 准备同步数据:', flat.length, '个节点');
        log('[syncAllToCloud] 数据详情:', JSON.stringify(flat, null, 2));
        
        // 删除旧数据
        log('[syncAllToCloud] 开始删除旧数据...');
        const { error: delErr } = await supabaseClient.from('bookmarks').delete().eq('user_id', currentUser.id);
        if (delErr) { 
            error('[syncAllToCloud] 清理旧数据失败', delErr); 
            throw delErr; // 如果删除失败，抛出错误
        } else {
            log('[syncAllToCloud] 旧数据删除成功');
        }
        
        // 插入新数据
        if (flat.length > 0) {
            log('[syncAllToCloud] 开始插入新数据，共', Math.ceil(flat.length / 50), '批');
            const batchSize = 50;
            for (let i = 0; i < flat.length; i += batchSize) {
                const batch = flat.slice(i, i + batchSize);
                log('[syncAllToCloud] 上传批次:', Math.floor(i / batchSize) + 1, '/', Math.ceil(flat.length / batchSize), '包含', batch.length, '条数据');
                const { data: upsertData, error } = await supabaseClient.from('bookmarks').upsert(batch, { onConflict: 'id' });
                if (error) { 
                    error('[syncAllToCloud] 批次上传失败', error);
                    throw error; // 如果上传失败，抛出错误
                } else {
                    log('[syncAllToCloud] 批次上传成功');
                }
            }
        } else {
            log('[syncAllToCloud] 没有数据需要上传');
        }
        
        // 验证数据是否上传成功
        log('[syncAllToCloud] 验证数据...');
        const verifyRes = await supabaseClient.from('bookmarks').select('id,name,url').eq('user_id', currentUser.id);
        log('[syncAllToCloud] 验证结果:', verifyRes);
        
        if (verifyRes.error) {
            error('[syncAllToCloud] 验证查询失败', verifyRes.error);
            throw verifyRes.error;
        }
        
        updateSyncIndicator('online');
        const recordCount = verifyRes.data?.length || 0;
        log('[syncAllToCloud] 同步完成！云端现在有', recordCount, '条记录');
        showToast(`☁️ 已同步到云端（共 ${recordCount} 条记录）`, 'success', 2000);
    } catch (e) {
        error('[syncAllToCloud] 同步失败:', e);
        updateSyncIndicator('offline');
        showToast('⚠️ 同步失败: ' + (e.message || e.code || '未知错误'), 'error', 5000);
    }
    isSyncing = false;
}

async function syncSingleBookmark(bookmark, operation) {
    if (!isCloudReady || !currentUser) return;
    try {
        log('[syncSingleBookmark]', operation, bookmark.id, bookmark.name, 'parentId:', bookmark._parentId);
        if (operation === 'update' || operation === 'star') {
            const isFolder = !!(bookmark.isFolder || bookmark.children !== undefined);
            const { error: upsertError } = await supabaseClient.from('bookmarks').upsert({
                id: bookmark.id,
                user_id: currentUser.id,
                parent_id: bookmark._parentId || null,
                name: bookmark.name,
                url: bookmark.url || null,
                icon: bookmark.icon || null,
                is_folder: isFolder,
                starred: bookmark.url ? stars.has(bookmark.url) : false,
                sort_order: bookmark.sort_order || 0,
                deleted: false,
                deleted_at: null,
                updated_at: new Date().toISOString()
            }, { onConflict: 'id' });
            
            if (upsertError) {
                error('[syncSingleBookmark] 更新/标记失败', upsertError);
                throw upsertError;
            }
            
            // 记录版本
            await recordVersion(bookmark, operation, ['name', 'url', 'icon', 'starred']);
        } else if (operation === 'delete') {
            log('[syncSingleBookmark] 执行软删除，ID:', bookmark.id);
            const { error: deleteError } = await supabaseClient.from('bookmarks').update({
                deleted: true,
                deleted_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            }).eq('id', bookmark.id);
            
            if (deleteError) {
                error('[syncSingleBookmark] 软删除失败', deleteError);
                throw deleteError;
            }
            log('[syncSingleBookmark] 软删除成功');
            
            // 记录版本
            await recordVersion(bookmark, operation, ['deleted']);
        } else if (operation === 'move') {
            const { error: moveError } = await supabaseClient.from('bookmarks').update({
                parent_id: bookmark._newParentId || null,
                updated_at: new Date().toISOString()
            }).eq('id', bookmark.id);
            
            if (moveError) {
                error('[syncSingleBookmark] 移动失败', moveError);
                throw moveError;
            }
            
            // 记录版本
            await recordVersion(bookmark, operation, ['parent_id']);
        }
        log('[syncSingleBookmark] 同步完成');
    } catch (e) {
        error('[syncSingleBookmark] 单项同步失败:', e);
        throw e; // 抛出错误，让调用方知道同步失败了
    }
}

// ==================== 数据加载策略 ====================

/**
 * 备份本地数据
 */
function backupLocalData() {
    try {
        const backup = {
            data: JSON.parse(JSON.stringify(data)),
            stars: [...stars],
            timestamp: new Date().toISOString()
        };
        localStorage.setItem('qnav_local_backup', JSON.stringify(backup));
        log('[backupLocalData] 本地数据已备份');
    } catch (e) {
        error('[backupLocalData] 备份失败:', e);
    }
}

/**
 * 策略1：加载云端数据（推荐）
 */
async function loadCloudDataOnly() {
    log('[loadCloudDataOnly] 开始加载云端数据...');
    
    // 先备份本地数据
    backupLocalData();
    
    // 从云端加载
    await loadCloudData();
    
    showToast('已从云端加载数据，本地数据已备份', 'success', 2000);
}

/**
 * 策略2：合并本地数据到云端
 */
async function mergeLocalToCloud() {
    log('[mergeLocalToCloud] 开始合并本地数据到云端...');
    
    const localData = treeToFlat(data, currentUser.id);
    const localCount = localData.filter(b => !b.deleted).length;
    
    // 获取云端数据
    const cloudRes = await safeSupabaseCall(
        supabaseClient.from('bookmarks').select('*').eq('user_id', currentUser.id).order('sort_order')
    );
    const cloudData = cloudRes?.data || [];
    const cloudMap = new Map(cloudData.map(b => [b.id, b]));
    
    // 合并策略：只添加本地有但云端没有的数据
    let addedCount = 0;
    const toAdd = localData.filter(local => {
        if (cloudMap.has(local.id)) {
            // 云端已有，不添加
            return false;
        }
        // 本地有但云端没有，需要添加
        addedCount++;
        return true;
    });
    
    log(`[mergeLocalToCloud] 本地 ${localCount} 条，云端 ${cloudData.length} 条，需添加 ${addedCount} 条`);
    
    // 批量上传新增数据
    if (toAdd.length > 0) {
        const batchSize = 50;
        for (let i = 0; i < toAdd.length; i += batchSize) {
            const batch = toAdd.slice(i, i + batchSize);
            await safeSupabaseCall(
                supabaseClient.from('bookmarks').upsert(batch, { onConflict: 'id' })
            );
        }
    }
    
    // 加载合并后的云端数据
    await loadCloudData();
    
    showToast(`合并完成！新增 ${addedCount} 条数据到云端`, 'success', 2000);
}

/**
 * 策略3：使用本地数据覆盖云端
 */
async function overwriteCloudWithLocal() {
    log('[overwriteCloudWithLocal] 开始用本地数据覆盖云端...');
    
    const localData = treeToFlat(data, currentUser.id);
    const localCount = localData.filter(b => !b.deleted).length;
    
    // 先删除云端所有数据（软删除）
    const { error: delErr } = await supabaseClient.from('bookmarks').delete().eq('user_id', currentUser.id);
    if (delErr) {
        error('[overwriteCloudWithLocal] 删除云端数据失败:', delErr);
        throw delErr;
    }
    
    // 上传本地数据
    if (localData.length > 0) {
        const batchSize = 50;
        for (let i = 0; i < localData.length; i += batchSize) {
            const batch = localData.slice(i, i + batchSize);
            await safeSupabaseCall(
                supabaseClient.from('bookmarks').upsert(batch, { onConflict: 'id' })
            );
        }
    }
    
    // 更新基准快照
    localStorage.setItem(`qnav_base_snapshot_${currentUser.id}`, JSON.stringify(localData));
    
    // 重新加载数据
    loadLocalData();
    
    showToast(`已用本地 ${localCount} 条数据覆盖云端`, 'warning', 3000);
}

async function loadCloudData() {
    if (!currentUser || !isCloudReady) return;
    log('[loadCloudData] 开始加载云端数据...');
    const res = await safeSupabaseCall(
        supabaseClient.from('bookmarks').select('*').eq('user_id', currentUser.id).order('sort_order')
    );
    if (!res || res.error) {
        warn('[loadCloudData] 加载云端数据失败', res?.error);
        return;
    }
    const bookmarks = res.data;
    log('[loadCloudData] 从云端获取到', bookmarks.length, '个节点');
    const active = bookmarks.filter(b => !b.deleted);
    log('[loadCloudData] 有效节点', active.length, '个');
    data = flatToTree(active);
    stars.clear();
    active.forEach(b => { if (b.starred && b.url) stars.add(b.url); });
    allBookmarks = flattenTree(data);
    saveLocalData();
    renderAll();
    log('[loadCloudData] 云端数据加载完成，本地数据已更新');
    showToast('已从云端加载数据', 'success', 2000);
}

// ==================== 三路合并同步 ====================

/**
 * 记录版本历史
 * @param {Object} bookmark - 书签对象
 * @param {string} operation - 操作类型: create/update/delete/move
 * @param {Array} changedFields - 变更的字段列表
 */
async function recordVersion(bookmark, operation, changedFields = []) {
    if (!currentUser || !isCloudReady) return;
    
    try {
        // 获取当前最新版本号
        const versionRes = await safeSupabaseCall(
            supabaseClient
                .from('bookmark_versions')
                .select('version_number')
                .eq('bookmark_id', bookmark.id)
                .order('version_number', { ascending: false })
                .limit(1)
        );
        
        const currentVersion = versionRes?.data?.[0]?.version_number || 0;
        const newVersion = currentVersion + 1;
        
        // 生成变更摘要
        let summary = '';
        switch(operation) {
            case 'create':
                summary = `创建书签: ${bookmark.name}`;
                break;
            case 'update':
                summary = `更新书签: ${bookmark.name} (${changedFields.join(', ')})`;
                break;
            case 'delete':
                summary = `删除书签: ${bookmark.name}`;
                break;
            case 'move':
                summary = `移动书签: ${bookmark.name}`;
                break;
        }
        
        // 插入版本记录
        await safeSupabaseCall(
            supabaseClient.from('bookmark_versions').insert({
                bookmark_id: bookmark.id,
                user_id: currentUser.id,
                version_number: newVersion,
                operation: operation,
                snapshot: JSON.parse(JSON.stringify(bookmark)), // 深拷贝为JSONB
                changed_fields: changedFields,
                change_summary: summary
            })
        );
        
        log(`[recordVersion] 记录版本 v${newVersion}: ${summary}`);
    } catch (e) {
        error('[recordVersion] 记录版本失败:', e);
        // 不抛出错误，避免影响主流程
    }
}

/**
 * 三路合并同步算法
 * 比较基准版本、云端版本和本地版本，智能合并冲突
 */
async function threeWayMergeSync() {
    if (!isCloudReady || !currentUser) {
        warn('[threeWayMergeSync] 云端未就绪，跳过同步');
        return;
    }
    
    isSyncing = true;
    updateSyncIndicator('syncing');
    log('[threeWayMergeSync] 开始三路合并同步...');
    
    try {
        // 1. 获取基准版本（上次同步时的状态）
        const baseSnapshot = localStorage.getItem(`qnav_base_snapshot_${currentUser.id}`);
        const baseData = baseSnapshot ? JSON.parse(baseSnapshot) : null;
        
        // 2. 获取云端最新版本
        const cloudRes = await safeSupabaseCall(
            supabaseClient.from('bookmarks').select('*').eq('user_id', currentUser.id).order('sort_order')
        );
        const cloudData = cloudRes?.data || [];
        
        // 3. 获取本地当前数据
        const localData = treeToFlat(data, currentUser.id);
        
        log('[threeWayMergeSync]', {
            baseCount: baseData?.length || 0,
            cloudCount: cloudData.length,
            localCount: localData.length
        });
        
        // 4. 如果没有基准版本，首次同步，直接上传
        if (!baseData || baseData.length === 0) {
            log('[threeWayMergeSync] 首次同步，直接上传本地数据');
            await syncAllToCloud();
            // 保存基准版本
            localStorage.setItem(`qnav_base_snapshot_${currentUser.id}`, JSON.stringify(localData));
            updateSyncIndicator('online');
            isSyncing = false;
            return;
        }
        
        // 5. 构建索引映射
        const baseMap = new Map(baseData.map(b => [b.id, b]));
        const cloudMap = new Map(cloudData.map(b => [b.id, b]));
        const localMap = new Map(localData.map(b => [b.id, b]));
        
        // 6. 检测变化
        const changes = detectChanges(baseMap, cloudMap, localMap);
        
        log('[threeWayMergeSync] 检测到变化:', changes);
        
        // 7. 应用合并策略
        const mergedData = applyMergeStrategy(baseMap, cloudMap, localMap, changes);
        
        // 8. 上传合并后的数据到云端
        if (mergedData.length > 0) {
            const batchSize = 50;
            for (let i = 0; i < mergedData.length; i += batchSize) {
                const batch = mergedData.slice(i, i + batchSize);
                await safeSupabaseCall(
                    supabaseClient.from('bookmarks').upsert(batch, { onConflict: 'id' })
                );
            }
        }
        
        // 9. 更新本地数据
        const activeMerged = mergedData.filter(b => !b.deleted);
        data = flatToTree(activeMerged);
        stars.clear();
        activeMerged.forEach(b => { if (b.starred && b.url) stars.add(b.url); });
        allBookmarks = flattenTree(data);
        saveLocalData();
        
        // 10. 保存新的基准版本
        localStorage.setItem(`qnav_base_snapshot_${currentUser.id}`, JSON.stringify(mergedData));
        
        updateSyncIndicator('online');
        showToast('☁️ 同步成功', 'success', 2000);
        log('[threeWayMergeSync] 同步完成');
        
    } catch (e) {
        error('[threeWayMergeSync] 同步失败:', e);
        updateSyncIndicator('offline');
        showToast('⚠️ 同步失败: ' + (e.message || '未知错误'), 'error', 5000);
    }
    
    isSyncing = false;
}

/**
 * 检测三个版本之间的变化
 */
function detectChanges(baseMap, cloudMap, localMap) {
    const changes = {
        created: [],      // 新增的
        deleted: [],      // 删除的
        updated: [],      // 修改的
        conflicts: []     // 冲突的
    };
    
    const allIds = new Set([...baseMap.keys(), ...cloudMap.keys(), ...localMap.keys()]);
    
    for (const id of allIds) {
        const inBase = baseMap.has(id);
        const inCloud = cloudMap.has(id);
        const inLocal = localMap.has(id);
        
        const baseItem = baseMap.get(id);
        const cloudItem = cloudMap.get(id);
        const localItem = localMap.get(id);
        
        // 情况1：本地新增
        if (!inBase && !inCloud && inLocal) {
            changes.created.push(localItem);
        }
        // 情况2：云端新增
        else if (!inBase && inCloud && !inLocal) {
            changes.created.push(cloudItem);
        }
        // 情况3：两端都新增（冲突）
        else if (!inBase && inCloud && inLocal) {
            changes.conflicts.push({ type: 'both_created', cloud: cloudItem, local: localItem });
        }
        // 情况4：本地删除
        else if (inBase && inCloud && !inLocal) {
            changes.deleted.push({ id, item: cloudItem });
        }
        // 情况5：云端删除
        else if (inBase && !inCloud && inLocal) {
            changes.deleted.push({ id, item: localItem });
        }
        // 情况6：两端都删除
        else if (inBase && !inCloud && !inLocal) {
            changes.deleted.push({ id, item: baseItem });
        }
        // 情况7：本地修改
        else if (inBase && inCloud && inLocal) {
            const cloudChanged = isItemChanged(baseItem, cloudItem);
            const localChanged = isItemChanged(baseItem, localItem);
            
            if (localChanged && !cloudChanged) {
                changes.updated.push({ id, source: 'local', item: localItem });
            } else if (!localChanged && cloudChanged) {
                changes.updated.push({ id, source: 'cloud', item: cloudItem });
            } else if (localChanged && cloudChanged) {
                // 两端都修改了，检查是否冲突
                if (isConflict(baseItem, cloudItem, localItem)) {
                    changes.conflicts.push({ type: 'both_modified', cloud: cloudItem, local: localItem });
                } else {
                    // 没有冲突，可以合并
                    changes.updated.push({ id, source: 'merged', item: mergeItems(baseItem, cloudItem, localItem) });
                }
            }
        }
    }
    
    return changes;
}

/**
 * 检查项目是否有变化
 */
function isItemChanged(base, current) {
    if (!base || !current) return true;
    return JSON.stringify(base) !== JSON.stringify(current);
}

/**
 * 检查是否有冲突（同一字段被两端修改）
 */
function isConflict(base, cloud, local) {
    if (!base || !cloud || !local) return false;
    
    // 简单策略：如果两端都修改了，就认为有冲突
    // 可以优化为只检查关键字段
    const cloudChanged = isItemChanged(base, cloud);
    const localChanged = isItemChanged(base, local);
    
    return cloudChanged && localChanged;
}

/**
 * 合并没有冲突的项目
 */
function mergeItems(base, cloud, local) {
    // 简单策略：以本地为准
    // 可以优化为逐字段合并
    return local;
}

/**
 * 应用合并策略
 */
function applyMergeStrategy(baseMap, cloudMap, localMap, changes) {
    const result = [];
    const processedIds = new Set();
    
    // 处理新增
    changes.created.forEach(item => {
        result.push(item);
        processedIds.add(item.id);
    });
    
    // 处理删除（从结果中排除）
    changes.deleted.forEach(({ id }) => {
        processedIds.add(id);
    });
    
    // 处理更新
    changes.updated.forEach(({ item }) => {
        result.push(item);
        processedIds.add(item.id);
    });
    
    // 处理冲突（暂时以本地为准，未来可以提示用户选择）
    changes.conflicts.forEach(({ local }) => {
        if (local) {
            result.push(local);
            processedIds.add(local.id);
        }
    });
    
    // 保留未变化的项目
    const allIds = new Set([...baseMap.keys(), ...cloudMap.keys(), ...localMap.keys()]);
    for (const id of allIds) {
        if (!processedIds.has(id)) {
            // 从未处理的来源中获取
            const item = localMap.get(id) || cloudMap.get(id) || baseMap.get(id);
            if (item) {
                result.push(item);
            }
        }
    }
    
    return result;
}

async function loadDeletedBookmarks() {
    if (!currentUser || !isCloudReady) {
        warn('[loadDeletedBookmarks] 云端未就绪，currentUser:', currentUser, 'isCloudReady:', isCloudReady);
        return [];
    }
    log('[loadDeletedBookmarks] 开始加载已删除的书签...');
    const res = await safeSupabaseCall(
        supabaseClient.from('bookmarks').select('*').eq('user_id', currentUser.id).eq('deleted', true).order('deleted_at', { ascending: false })
    );
    log('[loadDeletedBookmarks] 查询结果:', res);
    if (!res || res.error) {
        error('[loadDeletedBookmarks] 查询失败:', res?.error);
        return [];
    }
    log('[loadDeletedBookmarks] 找到', res.data?.length || 0, '条已删除的记录');
    return res.data;
}

function updateSyncIndicator(state) {
    if (!syncDot) return;
    syncDot.className = 'sync-dot';
    if (state === 'online') syncDot.classList.add('online');
    else if (state === 'syncing') syncDot.classList.add('syncing');
}

// ==================== 渲染功能 ====================
function renderSidebar() {
    if (!treeContainer) return;
    treeContainer.innerHTML = '';
    const allDiv = document.createElement('div');
    allDiv.className = 'all-bookmarks-item';
    allDiv.style.display = 'flex';
    allDiv.style.justifyContent = 'space-between';
    allDiv.style.alignItems = 'center';
    const totalBookmarks = allBookmarks.filter(b => b.url).length;
    const toggleTitle = isAllCollapsed ? '全部展开' : '全部收起';
    const togglePoints = isAllCollapsed ? '9 6 15 12 9 18' : '6 9 12 15 18 9';
    allDiv.innerHTML = `<div style="display:flex;align-items:center;cursor:pointer;flex:1;">
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:inline-flex;margin-right:6px;vertical-align:middle;">
                                <rect x="3" y="3" width="7" height="7"/>
                                <rect x="14" y="3" width="7" height="7"/>
                                <rect x="14" y="14" width="7" height="7"/>
                                <rect x="3" y="14" width="7" height="7"/>
                            </svg> 全部书签 <span class="tree-badge">${totalBookmarks}</span>
                        </div>
                        <div id="toggleAllFolders" style="cursor:pointer;padding:12px;border-radius:10px;transition:background 0.2s;display:flex;align-items:center;justify-content:center;" title="${toggleTitle}">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <polyline points="${togglePoints}" id="toggleAllIcon"/>
                            </svg>
                        </div>`;
    // 点击左侧部分：选择全部书签
    const leftPart = allDiv.firstElementChild;
    leftPart.onclick = () => selectPath([]);
    leftPart.oncontextmenu = (e) => { e.preventDefault(); };
    // 点击右侧图标：切换全部展开/折叠
    const toggleIcon = allDiv.querySelector('#toggleAllFolders');
    toggleIcon.onclick = (e) => {
        e.stopPropagation();
        toggleAllFolders();
    };
    toggleIcon.onmouseenter = (e) => {
        e.currentTarget.style.background = 'var(--bg-surface)';
    };
    toggleIcon.onmouseleave = (e) => {
        e.currentTarget.style.background = 'transparent';
    };
    treeContainer.appendChild(allDiv);

    function renderNodes(nodes, depth = 0, path = []) {
        const ul = document.createElement('ul');
        ul.style.listStyle = 'none';
        nodes.forEach(node => {
            // 只要是文件夹就显示（有 isFolder 或者 children 存在）
            if (!(node.isFolder || node.children !== undefined)) return;
            
            const curPath = [...path, node.name];
            const li = document.createElement('li');
            const div = document.createElement('div');
            div.className = 'tree-item';
            div.style.paddingLeft = (12 * (depth + 1)) + 'px';
            div.dataset.path = JSON.stringify(curPath);
            div.dataset.nodeId = node.id;
            div.draggable = isEditing;
            
            const hasChildren = node.children && node.children.length > 0;
            // 渲染图标：支持 emoji、图片 URL 和默认图标
            function renderIcon(n, isFolder = false) {
                if (isFolder) {
                    return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                                <line x1="2" y1="10" x2="22" y2="10"/>
                            </svg>`;
                }
                if (n.icon) {
                    // 检查是否是图片 URL
                    if (n.icon.startsWith('http://') || n.icon.startsWith('https://') || n.icon.startsWith('data:')) {
                        return `<img src="${n.icon}" loading="lazy" style="width:18px;height:18px;object-fit:contain;flex-shrink:0;" onerror="this.style.display='none';this.nextSibling.style.display='inline';">
                                <span style="display:none;">🌐</span>`;
                    }
                    return esc(n.icon);
                }
                return '🌐';
            }
            
            div.innerHTML = `
                <span class="tree-toggle" style="cursor:pointer;display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;margin-right:4px;visibility:${hasChildren ? 'visible' : 'hidden'}" data-collapsed="false" title="折叠">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <polyline points="6 9 12 15 18 9"></polyline>
                    </svg>
                </span>
                <span class="tree-icon" style="font-size:16px;display:inline-flex;align-items:center;min-width:18px;justify-content:center;">
                    ${renderIcon(node, node.isFolder || (node.children !== undefined))}
                </span>
                <span class="tree-name">${esc(node.name)}</span>
                <span class="tree-badge">${countDesc(node)}</span>`;
            div.onclick = (e) => { 
                if (e.target.closest('.tree-toggle')) {
                    // 点击了折叠/展开按钮
                    const toggle = e.target.closest('.tree-toggle');
                    const isCollapsed = toggle.dataset.collapsed === 'true';
                    toggle.dataset.collapsed = !isCollapsed;
                    
                    // 更新图标
                    const svg = toggle.querySelector('svg');
                    if (svg) {
                        if (!isCollapsed) {
                            svg.innerHTML = '<polyline points="9 6 15 12 9 18"></polyline>';
                            toggle.title = '展开';
                        } else {
                            svg.innerHTML = '<polyline points="6 9 12 15 18 9"></polyline>';
                            toggle.title = '折叠';
                        }
                    }
                    
                    // 折叠/展开子元素
                    const childUl = li.querySelector('.expandable');
                    if (childUl) {
                        childUl.style.display = isCollapsed ? '' : 'none';
                    }
                    return;
                }
                e.stopPropagation(); selectPath(curPath); 
            };
            div.oncontextmenu = (e) => { e.preventDefault(); showContextMenu(e, node); };
            if (isEditing) {
                div.addEventListener('dragstart', (e) => {
                    e.dataTransfer.setData('text/plain', node.id);
                    e.dataTransfer.effectAllowed = 'move';
                });
                div.addEventListener('dragover', (e) => {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'move';
                    div.classList.add('drag-over');
                });
                div.addEventListener('dragleave', () => div.classList.remove('drag-over'));
                div.addEventListener('drop', async (e) => {
                    e.preventDefault();
                    div.classList.remove('drag-over');
                    const draggedId = e.dataTransfer.getData('text/plain');
                    if (draggedId === node.id) return;
                    const moved = moveNodeById(data, draggedId, node.id);
                    if (moved) {
                        allBookmarks = flattenTree(data);
                        saveLocalData();
                        renderAll();
                        const draggedNode = allBookmarks.find(b => b.id === draggedId);
                        if (draggedNode) {
                            draggedNode._newParentId = node.id;
                            await syncSingleBookmark(draggedNode, 'move');
                        }
                        showToast('已移动', 'success');
                    }
                });
            }
            li.appendChild(div);
            const childUl = renderNodes(node.children, depth + 1, curPath);
            childUl.classList.add('expandable');
            li.appendChild(childUl);
            ul.appendChild(li);
        });
        return ul;
    }
    if (data.length) treeContainer.appendChild(renderNodes(data));
}

function countDesc(node) {
    // 递归统计所有后代书签
    if (!node.children && !node.url) return 0;
    if (!node.children) return node.url ? 1 : 0;
    
    let count = 0;
    // 如果节点本身是书签
    if (node.url) count++;
    
    // 递归统计子节点
    node.children.forEach(ch => {
        if (ch.url) {
            // 子节点是书签
            count++;
        } else if (ch.children) {
            // 子节点是文件夹，递归统计
            count += countDesc(ch);
        }
    });
    
    return count;
}

function selectPath(path) {
    currentPath = path;
    updateBreadcrumb();
    document.querySelectorAll('.tree-item').forEach(el => el.classList.remove('active'));
    const allBtn = document.querySelector('.all-bookmarks-item');
    if (allBtn) allBtn.classList.remove('active');
    if (path.length === 0) {
        allBtn?.classList.add('active');
    } else {
        const el = document.querySelector(`.tree-item[data-path='${CSS.escape(JSON.stringify(path))}']`);
        if (el) el.classList.add('active');
    }
    renderCards();
}

function updateBreadcrumb() {
    if (!heroBreadcrumb) return;
    heroBreadcrumb.innerHTML = '<span style="cursor:pointer;" id="bcHome"><svg width="20" height="20" viewBox="0 0 24 24" fill="none"><defs><linearGradient id="homeGrad" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="var(--accent)"/><stop offset="100%" stop-color="var(--accent-secondary)"/></linearGradient></defs><path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z" fill="url(#homeGrad)"/></svg> 全部</span>';
    document.getElementById('bcHome').addEventListener('click', () => selectPath([]));
    currentPath.forEach((seg, idx) => {
        heroBreadcrumb.appendChild(document.createTextNode(' / '));
        const span = document.createElement('span');
        span.textContent = seg;
        span.addEventListener('click', () => selectPath(currentPath.slice(0, idx + 1)));
        heroBreadcrumb.appendChild(span);
    });
}

function getCurrentPathNodes(nodes, path) {
    if (path.length === 0) return allBookmarks.filter(b => b.url); // 返回所有书签（扁平列表）
    
    // 导航到目标文件夹
    let current = nodes;
    for (let i = 0; i < path.length; i++) {
        const name = path[i];
        const found = current.find(n => n.name === name);
        if (!found) return [];
        if (i === path.length - 1) {
            // 到达目标文件夹，递归收集所有书签
            return collectAllBookmarks(found);
        }
        current = found.children || [];
    }
    return [];
}

// 递归收集文件夹及其所有子文件夹中的书签
function collectAllBookmarks(folder) {
    const bookmarks = [];
    
    function traverse(node) {
        if (node.url && !node.isFolder) {
            // 是书签
            bookmarks.push(node);
        } else if (node.children) {
            // 是文件夹，递归遍历
            node.children.forEach(child => traverse(child));
        }
    }
    
    // 从文件夹的子节点开始遍历
    if (folder.children) {
        folder.children.forEach(child => traverse(child));
    }
    
    return bookmarks;
}

function renderCards() {
    if (!bookmarkGrid) return;
    
    const currentNodes = getCurrentPathNodes(data, currentPath);
    const bookmarks = currentNodes.filter(n => !n.isFolder && n.url);
    
    // 获取当前主题名称
    const themeName = document.documentElement.dataset.theme?.split('-')[0] || 'aurora';
    
    // 获取书签卡片样式设置
    const bookmarkCardStyle = localStorage.getItem('qnav_bookmark_card_style') || 'mobile';
    
    // 更新网格样式类
    let gridClass = 'bookmark-grid';
    if (themeName) {
        gridClass += ` theme-${themeName}`;
    }
    if (bookmarkCardStyle !== 'mobile') {
        gridClass += ` card-style-${bookmarkCardStyle}`;
    }
    bookmarkGrid.className = gridClass;
    
    bookmarkGrid.innerHTML = '';
    if (bookmarks.length === 0) {
        bookmarkGrid.innerHTML = '<div style="text-align:center;padding:40px;grid-column:1/-1;">📭 暂无书签</div>';
        return;
    }
    // 渲染卡片图标
    function renderCardIcon(n) {
        if (n.icon) {
            if (n.icon.startsWith('http://') || n.icon.startsWith('https://') || n.icon.startsWith('data:')) {
                return `<img src="${n.icon}" onerror="this.parentElement.innerHTML='<span style=font-size:1.5rem;>📄</span>'" style="width:24px;height:24px;object-fit:contain;">`;
            }
            return `<span style="font-size:1.5rem;">${esc(n.icon)}</span>`;
        }
        return `<span style="font-size:1.5rem;">🌐</span>`;
    }
    
    bookmarks.forEach((bm, idx) => {
        const a = document.createElement('a');
        // 添加主题卡片样式类
        let cardClass = 'bookmark-card';
        if (themeName) {
            cardClass += ` theme-${themeName}`;
        }
        a.className = cardClass;
        a.href = bm.url;
        a.target = '_blank';
        a.dataset.bookmarkId = bm.id;
        a.draggable = isEditing;
        const domain = getDomain(bm.url);
        a.innerHTML = `
            <div class="card-favicon">
                ${renderCardIcon(bm)}
            </div>
            <div class="card-info"><div class="card-title">${esc(bm.name)}</div><div class="card-domain">${domain}</div></div>
            ${isEditing ? `<button class="edit-btn" data-action="edit" data-id="${bm.id}">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/>
                </svg>
            </button>` : ''}
        `;
        if (isEditing) {
            const editBtn = a.querySelector('.edit-btn');
            if (editBtn) {
                editBtn.addEventListener('click', (e) => {
                    e.preventDefault(); e.stopPropagation();
                    editBookmark(bm.id);
                });
            }
            a.addEventListener('dragstart', (e) => {
                e.dataTransfer.setData('text/plain', bm.id);
                e.dataTransfer.effectAllowed = 'move';
            });
            a.addEventListener('dragover', (e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                a.classList.add('drag-over');
            });
            a.addEventListener('dragleave', () => a.classList.remove('drag-over'));
            a.addEventListener('drop', async (e) => {
                e.preventDefault();
                a.classList.remove('drag-over');
                const draggedId = e.dataTransfer.getData('text/plain');
                if (draggedId === bm.id) return;
                const draggedNode = findNodeById(data, draggedId);
                const targetNode = findNodeById(data, bm.id);
                if (!draggedNode || !targetNode) return;
                const targetParentId = targetNode._parentId || null;
                const moved = moveNodeById(data, draggedId, targetParentId);
                if (moved) {
                    allBookmarks = flattenTree(data);
                    saveLocalData();
                    renderAll();
                    const dn = allBookmarks.find(b => b.id === draggedId);
                    if (dn) {
                        dn._newParentId = targetParentId;
                        await syncSingleBookmark(dn, 'move');
                    }
                    showToast('已移动', 'success');
                }
            });
        }
        a.addEventListener('contextmenu', (e) => { e.preventDefault(); showContextMenu(e, bm); });
        bookmarkGrid.appendChild(a);
    });
    
    // 为书签网格添加空白区域右键事件
    bookmarkGrid.oncontextmenu = (e) => {
        // 如果点击的是书签卡片，不处理（已经由卡片的事件处理）
        if (e.target.closest('.bookmark-card')) return;
        // 只在编辑模式下才阻止默认菜单
        if (isEditing) {
            e.preventDefault();
            showContextMenu(e, null);
        }
        // 非编辑模式下，让浏览器显示默认菜单
    };
    
    // 为 cards-body 添加右键事件，覆盖更大的空白区域
    if (cardsBody) {
        cardsBody.oncontextmenu = (e) => {
            // 如果点击的是书签卡片、快速访问卡片或其他交互元素，不处理
            if (e.target.closest('.bookmark-card') || 
                e.target.closest('.quick-access-item') ||
                e.target.closest('.hero-breadcrumb') ||
                e.target.closest('button') ||
                e.target.closest('input') ||
                e.target.closest('select')) {
                return;
            }
            // 只在编辑模式下才阻止默认菜单
            if (isEditing) {
                e.preventDefault();
                showContextMenu(e, null);
            }
            // 非编辑模式下，让浏览器显示默认菜单
        };
    }
}

async function toggleStar(url) {
    if (stars.has(url)) stars.delete(url);
    else stars.add(url);
    if (isCloudReady && currentUser) {
        const bm = allBookmarks.find(b => b.url === url);
        if (bm) await syncSingleBookmark(bm, 'star');
    }
    saveLocalData();
}

function renderHomeQuickSites() {
    if (!quickGrid) return;
    
    // 获取首页显示数量设置（默认12个）
    const homeDisplayCount = parseInt(localStorage.getItem('qnav_home_display_count') || '12');
    
    // 获取首页卡片样式设置
    const homeCardStyle = localStorage.getItem('qnav_home_card_style') || 'default';
    
    // 应用样式类
    quickGrid.className = 'home-quick-grid';
    if (homeCardStyle !== 'default') {
        quickGrid.classList.add(`style-${homeCardStyle}`);
    }
    
    // 只显示有url的书签，不显示文件夹
    const urlBookmarks = allBookmarks.filter(b => b.url);
    
    // 智能排序：固定的 > 收藏的 > 其他
    const pinnedBms = urlBookmarks.filter(b => b.pinned);
    const starBms = urlBookmarks.filter(b => !b.pinned && stars.has(b.url));
    const others = urlBookmarks.filter(b => !b.pinned && !stars.has(b.url));
    
    // 合并并按优先级排序
    const combined = [...pinnedBms, ...starBms, ...others].slice(0, homeDisplayCount);
    
    quickGrid.innerHTML = '';
    if (combined.length === 0) {
        quickGrid.innerHTML = '<div style="grid-column:1/-1;text-align:center;color:var(--text-secondary);">收藏一些书签后这里会自动显示</div>';
        return;
    }
    
    function renderQuickIcon(n) {
        if (n.icon) {
            if (n.icon.startsWith('http://') || n.icon.startsWith('https://') || n.icon.startsWith('data:')) {
                return `<img src="${n.icon}" onerror="this.parentElement.innerHTML='<span style=font-size:1.5rem;>🔗</span>'" style="width:28px;height:28px;object-fit:contain;">`;
            }
            return `<span style="font-size:1.5rem;">${esc(n.icon)}</span>`;
        }
        return `<span style="font-size:1.5rem;">🌐</span>`;
    }
    
    combined.forEach(bm => {
        const a = document.createElement('a');
        a.className = 'home-quick-card';
        a.href = bm.url;
        a.target = '_blank';
        // 如果是固定的书签，添加标记
        const pinIndicator = bm.pinned ? '<div style="position:absolute;top:4px;right:4px;font-size:0.7rem;opacity:0.6;">📌</div>' : '';
        a.innerHTML = `${pinIndicator}<div class="home-quick-icon">${renderQuickIcon(bm)}</div><div class="home-quick-name">${esc(bm.name)}</div>`;
        quickGrid.appendChild(a);
    });
}

function renderAll() {
    renderSidebar();
    renderCards();
    renderHomeQuickSites();
    updateBreadcrumb();
}

// ==================== 编辑与右键菜单 ====================
let currentEditBookmarkId = null;
let currentEditFolderId = null;

function showEditFolderModal(node) {
    if (!isEditing) {
        showToast('请先进入编辑模式', 'error');
        return;
    }
    currentEditFolderId = node.id;
    document.getElementById('editFolderName').value = node.name || '';
    document.getElementById('editFolderIcon').value = node.icon || '';
    
    const folderSelect = document.getElementById('editFolderParent');
    const excludeIds = new Set([node.id]);
    const descendants = getDescendantIds(node);
    descendants.forEach(id => excludeIds.add(id));
    const parentNode = findParentNode(data, node.id);
    populateFolderSelect(folderSelect, excludeIds, parentNode?.id || null);
    
    document.getElementById('editFolderOverlay').classList.add('show');
}

async function editBookmark(id) {
    if (!isEditing) {
        showToast('请先进入编辑模式', 'error');
        return;
    }
    const bm = allBookmarks.find(b => b.id === id);
    if (!bm) return;
    
    // 检查是否是文件夹
    const node = findNodeById(data, id);
    if (node && (node.isFolder || node.children !== undefined)) {
        showEditFolderModal(node);
        return;
    }
    
    currentEditBookmarkId = id;
    document.getElementById('editBookmarkName').value = bm.name || '';
    document.getElementById('editBookmarkUrl').value = bm.url || '';
    document.getElementById('editBookmarkIcon').value = bm.icon || '';
    
    document.getElementById('editBookmarkOverlay').classList.add('show');
}

function findParentNode(nodes, targetId, parent = null) {
    for (const n of nodes) {
        if (n.id === targetId) return parent;
        if (n.children) {
            const found = findParentNode(n.children, targetId, n);
            if (found !== undefined) return found;
        }
    }
    return undefined;
}

let ctxNode = null;
let ctxIsBlankArea = false; // 标记是否是空白区域
let ctxIsFolder = false; // 标记是否是文件夹
function showContextMenu(e, node) {
    ctxNode = node;
    ctxIsBlankArea = !node; // 如果没有传入节点，说明是空白区域
    ctxIsFolder = false;
    
    // 获取所有菜单项
    const ctxOpen = ctxMenu.querySelector('[data-action="open"]');
    const ctxNewTab = ctxMenu.querySelector('[data-action="new-tab"]');
    const ctxCopyUrl = ctxMenu.querySelector('[data-action="copy-url"]');
    const ctxEditDivider = document.getElementById('ctxEditDivider');
    const ctxRename = document.getElementById('ctxRename');
    const ctxMove = document.getElementById('ctxMove');
    const ctxPin = document.getElementById('ctxPin');
    const ctxDeleteDivider = document.getElementById('ctxDeleteDivider');
    const ctxDelete = document.getElementById('ctxDelete');
    const ctxBlankDivider = document.getElementById('ctxBlankDivider');
    const ctxAddBookmarkBlank = document.getElementById('ctxAddBookmarkBlank');
    const ctxAddFolderBlank = document.getElementById('ctxAddFolderBlank');
    
    if (ctxIsBlankArea) {
        // 空白区域右键：只显示添加书签/文件夹选项（仅在编辑模式下）
        if (!isEditing) {
            // 非编辑模式下，空白区域不显示任何菜单
            return;
        }
        
        ctxOpen.style.display = 'none';
        ctxNewTab.style.display = 'none';
        ctxCopyUrl.style.display = 'none';
        ctxEditDivider.style.display = 'none';
        ctxRename.style.display = 'none';
        ctxMove.style.display = 'none';
        ctxDeleteDivider.style.display = 'none';
        ctxDelete.style.display = 'none';
        
        ctxBlankDivider.style.display = 'block';
        ctxAddBookmarkBlank.style.display = 'block';
        ctxAddFolderBlank.style.display = 'block';
    } else {
        // 判断是否是文件夹
        ctxIsFolder = (node.isFolder || node.children !== undefined) && !node.url;
        
        if (ctxIsFolder) {
            // 文件夹右键：只显示编辑操作（仅在编辑模式下）
            ctxOpen.style.display = 'none';
            ctxNewTab.style.display = 'none';
            ctxCopyUrl.style.display = 'none';
            ctxBlankDivider.style.display = 'none';
            ctxAddBookmarkBlank.style.display = 'none';
            ctxAddFolderBlank.style.display = 'none';
            
            if (isEditing) {
                ctxEditDivider.style.display = 'block';
                ctxRename.style.display = 'block';
                ctxMove.style.display = 'block';
                ctxDeleteDivider.style.display = 'block';
                ctxDelete.style.display = 'block';
            } else {
                // 非编辑模式下，文件夹不显示右键菜单
                return;
            }
        } else {
            // 书签卡片右键：显示链接操作和编辑操作
            // 隐藏空白区域操作
            ctxBlankDivider.style.display = 'none';
            ctxAddBookmarkBlank.style.display = 'none';
            ctxAddFolderBlank.style.display = 'none';
            
            // 根据编辑模式显示/隐藏编辑类选项
            if (isEditing) {
                ctxEditDivider.style.display = 'block';
                ctxRename.style.display = 'block';
                ctxMove.style.display = 'block';
                ctxPin.style.display = 'block';
                // 根据是否已固定显示不同文本
                const isPinned = node.pinned || false;
                ctxPin.textContent = isPinned ? '❌ 取消固定' : '📌 固定到首页';
                ctxDeleteDivider.style.display = 'block';
                ctxDelete.style.display = 'block';
            } else {
                ctxEditDivider.style.display = 'none';
                ctxRename.style.display = 'none';
                ctxMove.style.display = 'none';
                ctxPin.style.display = 'none';
                ctxDeleteDivider.style.display = 'none';
                ctxDelete.style.display = 'none';
            }
            
            // 显示链接操作
            ctxOpen.style.display = 'block';
            ctxNewTab.style.display = 'block';
            ctxCopyUrl.style.display = 'block';
        }
    }
    
    ctxMenu.style.display = 'block';
    ctxMenu.style.left = Math.min(e.clientX, window.innerWidth - 190) + 'px';
    ctxMenu.style.top = Math.min(e.clientY, window.innerHeight - 220) + 'px';
}
document.addEventListener('click', (e) => {
    if (!ctxMenu.contains(e.target)) ctxMenu.style.display = 'none';
});

ctxMenu.querySelector('[data-action="open"]').addEventListener('click', () => {
    if (ctxNode && ctxNode.url) {
        window.location.href = ctxNode.url;
    }
    ctxMenu.style.display = 'none';
});

ctxMenu.querySelector('[data-action="new-tab"]').addEventListener('click', () => {
    if (ctxNode && ctxNode.url) {
        window.open(ctxNode.url, '_blank');
    }
    ctxMenu.style.display = 'none';
});

ctxMenu.querySelector('[data-action="copy-url"]').addEventListener('click', () => {
    if (ctxNode && ctxNode.url) {
        navigator.clipboard.writeText(ctxNode.url).then(() => {
            showToast('URL已复制', 'success');
        });
    }
    ctxMenu.style.display = 'none';
});

ctxMenu.querySelector('[data-action="rename"]').addEventListener('click', () => {
    if (ctxNode && isEditing) editBookmark(ctxNode.id);
    ctxMenu.style.display = 'none';
});

ctxMenu.querySelector('[data-action="move"]').addEventListener('click', () => {
    if (ctxNode && isEditing) showMoveToFolder(ctxNode);
    ctxMenu.style.display = 'none';
});

// 递归获取节点及其所有子节点
function getAllNodes(node) {
    let nodes = [node];
    if (node.children) {
        node.children.forEach(child => {
            nodes = nodes.concat(getAllNodes(child));
        });
    }
    return nodes;
}

// 递归删除节点及其所有子节点
async function deleteNodeRecursive(node, isCloudMode) {
    const allNodes = getAllNodes(node);
    
    if (isCloudMode) {
        // 云端模式：递归软删除所有节点
        for (const n of allNodes) {
            await syncSingleBookmark(n, 'delete');
        }
        await loadCloudData();
    } else {
        // 本地模式：直接删除节点
        data = removeNodeById(data, node.id);
        allBookmarks = flattenTree(data);
        saveLocalData();
        renderAll();
    }
}

ctxMenu.querySelector('[data-action="delete"]').addEventListener('click', async () => {
    if (!ctxNode || !isEditing) return;
    
    // 根据模式显示不同的提示信息
    const isCloudMode = isCloudReady && currentUser;
    const ctxIsFolder = (ctxNode.isFolder || ctxNode.children !== undefined) && !ctxNode.url;
    const title = isCloudMode ? (ctxIsFolder ? '删除文件夹' : '删除书签') : (ctxIsFolder ? '永久删除文件夹' : '永久删除书签');
    const message = isCloudMode 
        ? (ctxIsFolder ? '确定删除整个文件夹及其内容？可在回收站中恢复' : '确定删除？可在回收站中恢复')
        : (ctxIsFolder ? '⚠️ 本地模式下删除将<b>无法恢复</b>！确定要删除整个文件夹及其内容吗？' : '⚠️ 本地模式下删除将<b>无法恢复</b>！确定要删除吗？');
    
    const confirmed = await showConfirmDialog('🗑️', title, message);
    if (!confirmed) return;
    
    try {
        await deleteNodeRecursive(ctxNode, isCloudMode);
        ctxMenu.style.display = 'none';
        showToast(isCloudMode ? '已移至回收站' : '已永久删除', isCloudMode ? 'info' : 'warning');
    } catch (e) {
        error('删除同步失败:', e);
        showToast('⚠️ 删除同步失败，请重试', 'error');
    }
});

// 空白区域右键菜单项处理
ctxMenu.querySelector('[data-action="add-bookmark-blank"]').addEventListener('click', () => {
    if (!isEditing) return;
    ctxMenu.style.display = 'none';
    showAddBookmarkModal();
});

ctxMenu.querySelector('[data-action="add-folder-blank"]').addEventListener('click', () => {
    if (!isEditing) return;
    ctxMenu.style.display = 'none';
    showAddFolderModal();
});

// 固定到首页功能
ctxMenu.querySelector('[data-action="pin"]').addEventListener('click', async () => {
    if (!ctxNode || !isEditing) return;
    
    try {
        // 切换固定状态
        ctxNode.pinned = !ctxNode.pinned;
        
        if (isCloudReady && currentUser) {
            await syncSingleBookmark(ctxNode, 'update');
            await loadCloudData();
        } else {
            saveLocalData();
        }
        
        renderAll();
        ctxMenu.style.display = 'none';
        showToast(ctxNode.pinned ? '📌 已固定到首页' : '❌ 已取消固定', 'success');
    } catch (e) {
        error('固定操作失败:', e);
        showToast('⚠️ 操作失败，请重试', 'error');
    }
});

function getDescendantIds(node) {
    let ids = new Set();
    if (node.children) {
        node.children.forEach(child => {
            ids.add(child.id);
            const childIds = getDescendantIds(child);
            childIds.forEach(id => ids.add(id));
        });
    }
    return ids;
}

function showMoveToFolder(node) {
    if (!isEditing) {
        showToast('请先进入编辑模式', 'error');
        return;
    }
    moveTargetNode = node;
    moveSelectedParentId = null;
    
    // 获取自身及其所有后代ID
    const excludeIds = new Set([node.id]);
    const descendants = getDescendantIds(node);
    descendants.forEach(id => excludeIds.add(id));
    
    const folders = getAllFolders(data);
    const folderList = document.getElementById('folderSelectList');
    folderList.innerHTML = '';
    const rootItem = document.createElement('div');
    rootItem.className = 'folder-select-item' + (moveSelectedParentId === null ? ' selected' : '');
    rootItem.innerHTML = '📂 <span>根目录（顶层）</span>';
    rootItem.onclick = () => {
        moveSelectedParentId = null;
        folderList.querySelectorAll('.folder-select-item').forEach(el => el.classList.remove('selected'));
        rootItem.classList.add('selected');
    };
    folderList.appendChild(rootItem);
    folders.forEach(f => {
        if (excludeIds.has(f.id)) return;
        const item = document.createElement('div');
        item.className = 'folder-select-item';
        item.innerHTML = `📁 <span>${esc(f.path)}</span>`;
        item.onclick = () => {
            moveSelectedParentId = f.id;
            folderList.querySelectorAll('.folder-select-item').forEach(el => el.classList.remove('selected'));
            item.classList.add('selected');
        };
        folderList.appendChild(item);
    });
    moveToFolderOverlay.classList.add('show');
}

document.getElementById('cancelMoveBtn').addEventListener('click', () => {
    moveToFolderOverlay.classList.remove('show');
    moveTargetNode = null;
});

document.getElementById('confirmMoveBtn').addEventListener('click', async () => {
    if (!moveTargetNode) return;
    const moved = moveNodeById(data, moveTargetNode.id, moveSelectedParentId);
    if (moved) {
        allBookmarks = flattenTree(data);
        saveLocalData();
        renderAll();
        if (isCloudReady && currentUser) {
            const dn = allBookmarks.find(b => b.id === moveTargetNode.id);
            if (dn) {
                dn._newParentId = moveSelectedParentId;
                await syncSingleBookmark(dn, 'move');
            }
        }
        showToast('已移动', 'success');
    }
    moveToFolderOverlay.classList.remove('show');
    moveTargetNode = null;
});

// ==================== 回收站 ====================
// 云同步分类按钮事件
document.getElementById('recycleBinBtnCloud').addEventListener('click', async () => {
    settingsOverlay.classList.remove('show');
    await renderRecycleBin();
    recycleBinOverlay.classList.add('show');
});

document.getElementById('exportBtnCloud').addEventListener('click', () => {
    // 直接执行导出功能
    exportBookmarks();
});

document.getElementById('importBtnCloud').addEventListener('click', () => {
    // 直接触发文件输入
    document.getElementById('importFileInput').click();
});

// 数据恢复功能
function checkBackupData() {
    const backupStr = localStorage.getItem('qnav_local_backup');
    const restoreGroup = document.getElementById('dataRestoreGroup');
    
    if (backupStr) {
        try {
            const backup = JSON.parse(backupStr);
            restoreGroup.style.display = 'block';
            
            // 显示备份时间
            const timestamp = backup.timestamp ? new Date(backup.timestamp).toLocaleString('zh-CN') : '未知';
            document.getElementById('backupTimestamp').textContent = timestamp;
        } catch (e) {
            error('[checkBackupData] 解析备份数据失败:', e);
            restoreGroup.style.display = 'none';
        }
    } else {
        restoreGroup.style.display = 'none';
    }
}

// 恢复备份数据
document.getElementById('restoreBackupBtn').addEventListener('click', async () => {
    const confirmed = await showConfirmDialog('️', '恢复备份', '这将用备份数据替换当前数据，确定要恢复吗？');
    if (!confirmed) return;
    
    try {
        const backupStr = localStorage.getItem('qnav_local_backup');
        if (!backupStr) {
            showToast('没有找到备份数据', 'error');
            return;
        }
        
        const backup = JSON.parse(backupStr);
        data = backup.data;
        stars = new Set(backup.stars);
        allBookmarks = flattenTree(data);
        saveLocalData();
        renderAll();
        
        // 如果已登录，同步到云端
        if (currentUser && isCloudReady) {
            await threeWayMergeSync();
        }
        
        showToast('数据恢复成功！', 'success');
        checkBackupData();
    } catch (e) {
        error('[restoreBackupBtn] 恢复失败:', e);
        showToast('恢复失败: ' + e.message, 'error');
    }
});

// 清除备份
document.getElementById('clearBackupBtn').addEventListener('click', async () => {
    const confirmed = await showConfirmDialog('️', '清除备份', '确定要清除本地备份数据吗？');
    if (!confirmed) return;
    
    localStorage.removeItem('qnav_local_backup');
    showToast('备份已清除', 'info');
    checkBackupData();
});

document.getElementById('closeRecycleBinBtn').addEventListener('click', () => {
    recycleBinOverlay.classList.remove('show');
});

document.getElementById('emptyRecycleBinBtn').addEventListener('click', async () => {
    const confirmed = await showConfirmDialog('⚠️', '清空回收站', '确定要永久删除回收站中的所有书签吗？<br><strong style="color:#ef4444;">此操作不可恢复！</strong>');
    if (!confirmed) return;
    
    if (isCloudReady && currentUser) {
        await safeSupabaseCall(
            supabaseClient.from('bookmarks').delete().eq('user_id', currentUser.id).eq('deleted', true)
        );
    }
    showToast('回收站已清空', 'success');
    await renderRecycleBin();
});

async function renderRecycleBin() {
    const list = document.getElementById('recycleBinList');
    list.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-secondary);">加载中...</div>';
    let deletedItems = [];
    log('[renderRecycleBin] isCloudReady:', isCloudReady, 'currentUser:', currentUser);
    if (isCloudReady && currentUser) {
        deletedItems = await loadDeletedBookmarks();
        log('[renderRecycleBin] 加载到的已删除项目:', deletedItems);
    } else {
        deletedItems = [];
    }
    if (deletedItems.length === 0) {
        list.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-secondary);">回收站为空 🎉</div>';
        return;
    }
    const now = new Date();
    list.innerHTML = '';
    deletedItems.forEach(item => {
        const div = document.createElement('div');
        div.className = 'recycle-item';
        const deletedDate = item.deleted_at ? new Date(item.deleted_at) : new Date();
        const daysLeft = Math.max(0, 30 - Math.floor((now - deletedDate) / (1000 * 60 * 60 * 24)));
        const dateStr = deletedDate.toLocaleDateString('zh-CN');
        div.innerHTML = `
            <div class="recycle-item-info">
                <div class="recycle-item-name">
                    ${item.is_folder ? 
                        `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="display:inline-flex;vertical-align:middle;margin-right:4px;">
                            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                        </svg>` : 
                        `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="display:inline-flex;vertical-align:middle;margin-right:4px;">
                            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
                            <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
                        </svg>`
                    }
                    ${esc(item.name)}
                </div>
                <div class="recycle-item-date">删除于 ${dateStr} · ${daysLeft}天后自动清理</div>
            </div>
            <div class="recycle-item-actions">
                <button class="btn btn-success btn-sm restore-btn" data-id="${item.id}">恢复</button>
                <button class="btn btn-danger btn-sm perm-delete-btn" data-id="${item.id}">彻底删除</button>
            </div>
        `;
        div.querySelector('.restore-btn').addEventListener('click', async () => {
            if (isCloudReady && currentUser) {
                await safeSupabaseCall(
                    supabaseClient.from('bookmarks').update({ deleted: false, deleted_at: null, updated_at: new Date().toISOString() }).eq('id', item.id)
                );
                await loadCloudData();
            }
            renderAll();
            await renderRecycleBin();
            showToast('已恢复', 'success');
        });
        div.querySelector('.perm-delete-btn').addEventListener('click', async () => {
            const confirmed = await showConfirmDialog('🗑️', '永久删除', '确定要永久删除此书签吗？<br><strong style="color:#ef4444;">此操作不可恢复！</strong>');
            if (!confirmed) return;
            
            if (isCloudReady && currentUser) {
                await safeSupabaseCall(
                    supabaseClient.from('bookmarks').delete().eq('id', item.id)
                );
            }
            await renderRecycleBin();
            showToast('已永久删除', 'info');
        });
        list.appendChild(div);
    });
}

// ==================== 导入导出 ====================
// 导出书签功能
function exportBookmarks() {
    const defaultName = 'bookmarks_' + new Date().toISOString().slice(0, 10) + '.html';
    const fileName = prompt('请输入导出文件名（不含扩展名）:', defaultName.replace('.html', ''));
    
    if (fileName === null) return; // 用户取消
    
    const finalFileName = fileName.trim() ? fileName.trim().replace(/\.html$/, '') + '.html' : defaultName;
    
    const html = `<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">\n<TITLE>Bookmarks</TITLE>\n<H1>Bookmarks</H1>\n<DL><p>\n${convertToHTML(data)}\n</DL><p>\n`;
    const blob = new Blob([html], { type: 'text/html' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = finalFileName;
    a.click();
    showToast('书签已导出', 'success');
}

function convertToHTML(nodes) {
    let html = '';
    nodes.forEach(node => {
        if (node.children && node.children.length > 0) {
            html += `<DT><H3>${esc(node.name)}</H3>\n<DL><p>\n${convertToHTML(node.children)}</DL><p>\n`;
        } else if (node.url) {
            html += `<DT><A HREF="${node.url}">${esc(node.name)}</A>\n`;
        }
    });
    return html;
}

// ==================== 书签导入功能（重构版）====================

// 全局变量存储当前导入会话
let currentImportSession = null;

// 导入功能由云同步分类中的 importBtnCloud 触发
document.getElementById('importFileInput').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    
    try {
        // 解析书签文件
        const text = await file.text();
        const parser = new DOMParser();
        const doc = parser.parseFromString(text, 'text/html');
        const rawBookmarks = parseBookmarks(doc.querySelector('dl'));
        
        if (rawBookmarks.length === 0) {
            showToast('未找到有效的书签数据', 'warning');
            e.target.value = '';
            return;
        }
        
        // 准备导入会话
        currentImportSession = createImportSession(rawBookmarks);
        
        // 显示预览
        showImportPreview();
        
    } catch (err) {
        warn('导入解析失败', err);
        showToast('导入失败，请检查文件格式', 'error');
    }
    
    e.target.value = '';
});

// 创建导入会话（包含数据快照）
function createImportSession(rawBookmarks) {
    // 创建数据快照用于回滚
    const dataSnapshot = JSON.stringify(data);
    
    // 获取所有现有URL用于去重
    const existingUrls = getAllExistingUrls();
    
    // 处理导入数据
    const { bookmarks, folders, duplicates, invalid } = processImportData(rawBookmarks, existingUrls);
    
    return {
        rawBookmarks,
        bookmarks,
        folders,
        duplicates,
        invalid,
        dataSnapshot,
        importFolderName: getImportFolderName()
    };
}

// 获取所有现有书签的URL
function getAllExistingUrls() {
    const urls = new Set();
    const allItems = flattenTree(data);
    allItems.forEach(item => {
        if (item.url) {
            urls.add(normalizeUrl(item.url));
        }
    });
    return urls;
}

// 标准化URL（用于去重比较）
function normalizeUrl(url) {
    try {
        const urlObj = new URL(url);
        // 移除尾部斜杠和参数
        let normalized = `${urlObj.protocol}//${urlObj.host}${urlObj.pathname}`;
        return normalized.replace(/\/$/, '');
    } catch {
        return url.toLowerCase();
    }
}

// 处理导入数据（去重、格式验证）
function processImportData(nodes, existingUrls) {
    const bookmarks = [];  // 只包含顶层书签（不在文件夹中的）
    const folders = [];
    const duplicates = [];
    const invalid = [];
    
    function processNode(node, isTopLevel = false) {
        if (node.children && node.children.length > 0) {
            // 文件夹
            const folder = {
                id: randomId(),
                name: node.name,
                children: [],
                isFolder: true
            };
            folders.push(folder);
            
            // 递归处理子节点（子节点不是顶层）
            node.children.forEach(child => {
                const result = processNode(child, false);
                if (result) folder.children.push(result);
            });
            
            return folder;
        } else if (node.url) {
            // 书签
            const normalizedUrl = normalizeUrl(node.url);
            
            // 检查URL格式
            if (!isValidUrl(node.url)) {
                invalid.push({ name: node.name, url: node.url, reason: 'URL格式无效' });
                return null;
            }
            
            // 检查是否重复
            if (existingUrls.has(normalizedUrl)) {
                duplicates.push({ name: node.name, url: node.url });
                return null;
            }
            
            // 只有顶层书签才添加到bookmarks数组
            if (isTopLevel) {
                bookmarks.push({
                    id: randomId(),
                    name: node.name,
                    url: node.url,
                    isFolder: false
                });
            }
            
            // 将URL加入已存在集合（用于检测本次导入中的重复）
            existingUrls.add(normalizedUrl);
            
            return { id: node.id, name: node.name, url: node.url };
        }
        return null;
    }
    
    // 顶层节点处理
    nodes.forEach(node => processNode(node, true));
    
    return { bookmarks, folders, duplicates, invalid };
}

// 检查URL格式是否有效
function isValidUrl(url) {
    try {
        const urlObj = new URL(url);
        return ['http:', 'https:'].includes(urlObj.protocol);
    } catch {
        return false;
    }
}

// 获取导入文件夹名称（自动处理冲突）
function getImportFolderName() {
    let importName = '导入的收藏';
    let counter = 1;
    while (data.some(d => d.name === importName)) {
        counter++;
        importName = '导入的收藏_' + counter;
    }
    return importName;
}

// 统计书签和文件夹数量
function countBookmarksAndFolders(nodes) {
    let bookmarks = 0;
    let folders = 0;
    
    function count(node) {
        if (node.children && node.children.length > 0) {
            folders++;
            node.children.forEach(child => count(child));
        } else if (node.url) {
            bookmarks++;
        }
    }
    
    nodes.forEach(node => count(node));
    return { bookmarks, folders };
}

// 显示导入预览弹窗
function showImportPreview() {
    if (!currentImportSession) return;
    
    const { bookmarks, folders, duplicates, invalid, importFolderName } = currentImportSession;
    const total = bookmarks.length + folders.length;
    
    // 更新统计数据
    document.getElementById('importTotalCount').textContent = total;
    document.getElementById('importBookmarkCount').textContent = bookmarks.length;
    document.getElementById('importFolderCount').textContent = folders.length;
    document.getElementById('importDuplicateCount').textContent = duplicates.length;
    document.getElementById('importInvalidCount').textContent = invalid.length;
    
    // 更新警告信息
    const warningEl = document.getElementById('importWarning');
    if (duplicates.length > 0 || invalid.length > 0) {
        let warningText = '';
        if (duplicates.length > 0) {
            warningText += `将跳过 ${duplicates.length} 个重复书签（URL已存在）`;
        }
        if (invalid.length > 0) {
            if (warningText) warningText += '；';
            warningText += `将跳过 ${invalid.length} 个无效链接`;
        }
        warningEl.textContent = warningText;
        warningEl.style.display = 'block';
    } else {
        warningEl.style.display = 'none';
    }
    
    // 更新预览列表
    renderImportPreviewList();
    
    // 显示/隐藏操作按钮
    document.getElementById('importRemoveDuplicatesBtn').style.display = duplicates.length > 0 ? 'inline-block' : 'none';
    document.getElementById('importClearBtn').style.display = total > 0 ? 'inline-block' : 'none';
    
    // 显示弹窗
    document.getElementById('importPreviewOverlay').classList.add('show');
}

// 渲染导入预览列表
function renderImportPreviewList() {
    if (!currentImportSession) return;
    
    const { bookmarks, folders, duplicates, invalid } = currentImportSession;
    const listEl = document.getElementById('importPreviewList');
    
    let html = '';
    
    // 显示有效书签
    if (bookmarks.length > 0) {
        html += `<div style="margin-bottom:12px;">
            <div style="font-size:0.85rem;color:var(--text-secondary);margin-bottom:8px;">📥 将导入的书签 (${bookmarks.length})</div>`;
        
        bookmarks.forEach(bookmark => {
            html += `<div style="display:flex;align-items:center;gap:8px;padding:8px;border-radius:8px;background:var(--bg-surface);margin-bottom:4px;">
                <span style="width:20px;text-align:center;">🔗</span>
                <div style="flex:1;overflow:hidden;">
                    <div style="font-size:0.9rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(bookmark.name)}</div>
                    <div style="font-size:0.7rem;color:var(--text-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(bookmark.url)}</div>
                </div>
            </div>`;
        });
        html += '</div>';
    }
    
    // 显示文件夹
    if (folders.length > 0) {
        html += `<div style="margin-bottom:12px;">
            <div style="font-size:0.85rem;color:var(--text-secondary);margin-bottom:8px;">📁 将导入的文件夹 (${folders.length})</div>`;
        
        folders.forEach(folder => {
            const childCount = countBookmarksAndFolders(folder.children);
            html += `<div style="display:flex;align-items:center;gap:8px;padding:8px;border-radius:8px;background:var(--bg-surface);margin-bottom:4px;">
                <span style="width:20px;text-align:center;">📁</span>
                <div style="flex:1;">
                    <div style="font-size:0.9rem;">${esc(folder.name)}</div>
                    <div style="font-size:0.7rem;color:var(--text-secondary);">包含 ${childCount.bookmarks} 个书签，${childCount.folders} 个文件夹</div>
                </div>
            </div>`;
        });
        html += '</div>';
    }
    
    // 显示重复项（灰色标记）
    if (duplicates.length > 0) {
        html += `<div style="margin-bottom:12px;">
            <div style="font-size:0.85rem;color:#f59e0b;margin-bottom:8px;">⏭️ 将跳过的重复项 (${duplicates.length})</div>`;
        
        duplicates.forEach(item => {
            html += `<div style="display:flex;align-items:center;gap:8px;padding:8px;border-radius:8px;background:rgba(251,191,36,0.1);margin-bottom:4px;opacity:0.7;">
                <span style="width:20px;text-align:center;color:#f59e0b;">⚠️</span>
                <div style="flex:1;overflow:hidden;">
                    <div style="font-size:0.9rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(item.name)}</div>
                    <div style="font-size:0.7rem;color:var(--text-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(item.url)}</div>
                </div>
            </div>`;
        });
        html += '</div>';
    }
    
    // 显示无效链接（红色标记）
    if (invalid.length > 0) {
        html += `<div style="margin-bottom:12px;">
            <div style="font-size:0.85rem;color:#ef4444;margin-bottom:8px;">❌ 将跳过的无效链接 (${invalid.length})</div>`;
        
        invalid.forEach(item => {
            html += `<div style="display:flex;align-items:center;gap:8px;padding:8px;border-radius:8px;background:rgba(239,68,68,0.1);margin-bottom:4px;">
                <span style="width:20px;text-align:center;color:#ef4444;">❌</span>
                <div style="flex:1;overflow:hidden;">
                    <div style="font-size:0.9rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(item.name)}</div>
                    <div style="font-size:0.7rem;color:var(--text-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(item.url || '(无URL)')}</div>
                </div>
            </div>`;
        });
        html += '</div>';
    }
    
    if (!html) {
        html = '<div style="text-align:center;color:var(--text-secondary);padding:40px;">没有可导入的内容</div>';
    }
    
    listEl.innerHTML = html;
}

// 执行导入
async function performImport() {
    if (!currentImportSession) return false;
    
    const { bookmarks, folders, importFolderName, dataSnapshot } = currentImportSession;
    // 统计总数：文件夹 + 顶层书签（bookmarks现在只包含顶层书签）
    const totalToImport = bookmarks.length + folders.length;
    
    if (totalToImport === 0) {
        showToast('没有可导入的内容', 'warning');
        return false;
    }
    
    try {
        // 开始导入，创建顶层文件夹
        const folderNode = {
            id: randomId(),
            name: importFolderName,
            children: []
        };
        
        // 将处理后的文件夹（包含所有子书签）添加到导入文件夹
        // 添加文件夹结构（递归函数）
        function addFolderToNode(folder) {
            const newFolder = {
                id: folder.id,
                name: folder.name,
                children: []
            };
            folder.children.forEach(child => {
                if (child.url) {
                    newFolder.children.push({ id: child.id, name: child.name, url: child.url });
                } else {
                    newFolder.children.push(addFolderToNode(child));
                }
            });
            return newFolder;
        }
        
        // 添加文件夹（包含所有子书签）
        folders.forEach(folder => {
            folderNode.children.push(addFolderToNode(folder));
        });
        
        // 添加顶层书签（不在任何文件夹中的）
        bookmarks.forEach(bookmark => {
            folderNode.children.push({ id: bookmark.id, name: bookmark.name, url: bookmark.url });
        });
        
        // 执行导入
        data.push(folderNode);
        
        // 同步到云端
        if (isCloudReady && currentUser) {
            await uploadRecursive([folderNode], null, currentUser.id);
        }
        
        // 更新全局变量并保存
        allBookmarks = flattenTree(data);
        saveLocalData();
        renderAll();
        
        // 显示成功提示
        const { duplicates, invalid } = currentImportSession;
        let message = `成功导入 ${totalToImport} 个项目`;
        if (duplicates.length > 0) message += `，跳过 ${duplicates.length} 个重复项`;
        if (invalid.length > 0) message += `，跳过 ${invalid.length} 个无效链接`;
        showToast(message, 'success');
        
        return true;
        
    } catch (err) {
        error('导入执行失败', err);
        
        // 回滚到快照
        try {
            data = JSON.parse(dataSnapshot);
            showToast('导入失败，已回滚数据', 'error');
        } catch (rollbackErr) {
            error('回滚失败', rollbackErr);
            showToast('导入失败且回滚失败，请刷新页面', 'error');
        }
        
        return false;
    }
}

// 取消导入
function cancelImport() {
    // 清理会话数据（数据未改变，无需回滚）
    currentImportSession = null;
    document.getElementById('importPreviewOverlay').classList.remove('show');
}

// 移除重复项（从当前会话中）
function removeDuplicatesFromSession() {
    if (!currentImportSession) return;
    currentImportSession.duplicates = [];
    document.getElementById('importDuplicateCount').textContent = '0';
    document.getElementById('importRemoveDuplicatesBtn').style.display = 'none';
    document.getElementById('importWarning').style.display = 'none';
    renderImportPreviewList();
    showToast('已移除所有重复项', 'success');
}

// 清空本次导入
function clearCurrentImport() {
    currentImportSession = null;
    document.getElementById('importPreviewOverlay').classList.remove('show');
    showToast('已清空本次导入内容', 'info');
}

// 绑定预览弹窗事件
document.getElementById('cancelImportBtn').addEventListener('click', cancelImport);
document.getElementById('confirmImportBtn').addEventListener('click', async () => {
    const success = await performImport();
    if (success) {
        cancelImport();
    }
});
document.getElementById('importRemoveDuplicatesBtn').addEventListener('click', removeDuplicatesFromSession);
document.getElementById('importClearBtn').addEventListener('click', clearCurrentImport);

// 解析书签HTML
function parseBookmarks(dl) {
    if (!dl) return [];
    const nodes = [];
    Array.from(dl.children).forEach(child => {
        if (child.tagName === 'DT') {
            const h3 = child.querySelector('h3');
            const a = child.querySelector('a');
            if (h3) {
                const folder = { id: randomId(), name: h3.textContent, children: [] };
                const subDl = child.querySelector('dl');
                if (subDl) folder.children = parseBookmarks(subDl);
                nodes.push(folder);
            } else if (a) {
                nodes.push({ id: randomId(), name: a.textContent, url: a.href });
            }
        }
    });
    return nodes;
}

async function uploadRecursive(nodes, parentId, userId) {
    if (!isCloudReady) return;
    for (const node of nodes) {
        const isFolder = !!(node.children && node.children.length > 0);
        const res = await safeSupabaseCall(supabaseClient.from('bookmarks').insert({
            id: node.id, user_id: userId, parent_id: parentId,
            name: node.name, url: node.url || null,
            is_folder: isFolder
        }).select('id').single());
        if (res && res.data && node.children && node.children.length > 0) {
            await uploadRecursive(node.children, res.data.id, userId);
        }
    }
}

// ==================== 视图切换 ====================
let isHomeView = true; // 默认首页（全局变量）
const viewToggleBtn = document.getElementById('viewToggleBtn');
if (viewToggleBtn) {
    viewToggleBtn.addEventListener('click', () => {
        isHomeView = !isHomeView;
        
        if (isHomeView) {
            viewToggleBtn.textContent = '🏠';
            viewToggleBtn.title = '首页';
            homeView.style.display = 'flex';
            bookmarksView.style.display = 'none';
            document.body.classList.remove('page-bookmarks');
            renderHomeQuickSites();
        } else {
            viewToggleBtn.textContent = '📁';
            viewToggleBtn.title = '收藏夹';
            homeView.style.display = 'none';
            bookmarksView.style.display = 'flex';
            document.body.classList.add('page-bookmarks');
        }
        
        // 更新侧边栏折叠按钮的显示状态
        if (typeof updateSidebarToggleBtn === 'function') {
            const sidebar = document.getElementById('sidebar');
            updateSidebarToggleBtn(sidebar.classList.contains('hidden'));
        }
        
        if (window.innerWidth <= 768) {
            document.getElementById('sidebar').classList.remove('open');
        }
    });
}

// 全局更新侧边栏折叠按钮的函数
let updateSidebarToggleBtn = null;

// ==================== 多主题系统 ====================
const lightDarkToggle = document.getElementById('lightDarkToggle');
const themeSelectorBtn = document.getElementById('themeSelectorBtn');

// 主题配置 - 每种主题都有自己的明暗模式
/**
 * 10套主题系统 - 完整JavaScript配置
 * 使用方法：将此代码替换 index.html 中约第6790行的旧themes数组及相关函数
 */

// ==================== 极光流光主题配置 ====================

const themes = [
    // 方案一：极光流光
    {
        id: 'aurora-light',
        name: '极光流光',
        icon: '🌈',
        type: 'light',
        themeGroup: 'aurora'
    },
    {
        id: 'aurora-dark',
        name: '极光流光',
        icon: '✨',
        type: 'dark',
        themeGroup: 'aurora'
    },
    // 方案二：简约商务
    {
        id: 'minimal-light',
        name: '简约商务',
        icon: '💼',
        type: 'light',
        themeGroup: 'minimal'
    },
    {
        id: 'minimal-dark',
        name: '简约商务',
        icon: '🌙',
        type: 'dark',
        themeGroup: 'minimal'
    },
    // 方案三：优雅质感
    {
        id: 'elegance-light',
        name: '优雅质感',
        icon: '💎',
        type: 'light',
        themeGroup: 'elegance'
    },
    {
        id: 'elegance-dark',
        name: '优雅质感',
        icon: '🌌',
        type: 'dark',
        themeGroup: 'elegance'
    },
    // 方案五：石板灰
    {
        id: 'slate-light',
        name: '石板灰',
        icon: '🪨',
        type: 'light',
        themeGroup: 'slate'
    },
    {
        id: 'slate-dark',
        name: '石板灰',
        icon: '🌑',
        type: 'dark',
        themeGroup: 'slate'
    },
    // 方案十一：极地冰原
    {
        id: 'arctic-light',
        name: '极地冰原',
        icon: '❄️',
        type: 'light',
        themeGroup: 'arctic'
    },
    {
        id: 'arctic-dark',
        name: '极地冰原',
        icon: '🌨️',
        type: 'dark',
        themeGroup: 'arctic'
    },
    // 方案十二：黑白胶片
    {
        id: 'noir-light',
        name: '黑白胶片',
        icon: '🎞️',
        type: 'light',
        themeGroup: 'noir'
    },
    {
        id: 'noir-dark',
        name: '黑白胶片',
        icon: '🖤',
        type: 'dark',
        themeGroup: 'noir'
    },
    // 方案十三：蒸波霓虹
    {
        id: 'synthwave-light',
        name: '蒸波霓虹',
        icon: '🔮',
        type: 'light',
        themeGroup: 'synthwave'
    },
    {
        id: 'synthwave-dark',
        name: '蒸波霓虹',
        icon: '💗',
        type: 'dark',
        themeGroup: 'synthwave'
    },
    // 方案十四：矩阵终端
    {
        id: 'matrix-light',
        name: '矩阵终端',
        icon: '💚',
        type: 'light',
        themeGroup: 'matrix'
    },
    {
        id: 'matrix-dark',
        name: '矩阵终端',
        icon: '🧑‍💻',
        type: 'dark',
        themeGroup: 'matrix'
    },
    // 方案十一：霓虹酸液
    {
        id: 'neonacid-light',
        name: '霓虹酸液',
        icon: '⚡',
        type: 'light',
        themeGroup: 'neonacid'
    },
    {
        id: 'neonacid-dark',
        name: '霓虹酸液',
        icon: '💀',
        type: 'dark',
        themeGroup: 'neonacid'
    },
    // 方案十八：星云尘埃
    {
        id: 'nebula-light',
        name: '星云尘埃',
        icon: '🪐',
        type: 'light',
        themeGroup: 'nebula'
    },
    {
        id: 'nebula-dark',
        name: '星云尘埃',
        icon: '🌌',
        type: 'dark',
        themeGroup: 'nebula'
    },
    // 方案十九：Vital Flow
    {
        id: 'vital-light',
        name: 'Vital Flow',
        icon: '💫',
        type: 'light',
        themeGroup: 'vital'
    },
    {
        id: 'vital-dark',
        name: 'Vital Flow',
        icon: '🌀',
        type: 'dark',
        themeGroup: 'vital'
    },
    // 方案二十：余烬辉光
    {
        id: 'ember-light',
        name: '余烬辉光',
        icon: '🔥',
        type: 'light',
        themeGroup: 'ember'
    },
    {
        id: 'ember-dark',
        name: '余烬辉光',
        icon: '🌋',
        type: 'dark',
        themeGroup: 'ember'
    },
    // 方案二十一：棱镜色移
    {
        id: 'prism-light',
        name: '棱镜色移',
        icon: '💎',
        type: 'light',
        themeGroup: 'prism'
    },
    {
        id: 'prism-dark',
        name: '棱镜色移',
        icon: '🔮',
        type: 'dark',
        themeGroup: 'prism'
    },

    // 方案二十三：绿野仙踪
    {
        id: 'forest-light',
        name: '绿野仙踪',
        icon: '🌲',
        type: 'light',
        themeGroup: 'forest'
    },
    {
        id: 'forest-dark',
        name: '绿野仙踪',
        icon: '🌿',
        type: 'dark',
        themeGroup: 'forest'
    },
    // 方案二十四：星际穿越
    {
        id: 'space-light',
        name: '星际穿越',
        icon: '🚀',
        type: 'light',
        themeGroup: 'space'
    },
    {
        id: 'space-dark',
        name: '星际穿越',
        icon: '🌌',
        type: 'dark',
        themeGroup: 'space'
    },
    // 方案二十五：数字迷城
    {
        id: 'glitch-light',
        name: '数字迷城',
        icon: '⚡',
        type: 'light',
        themeGroup: 'glitch'
    },
    {
        id: 'glitch-dark',
        name: '数字迷城',
        icon: '💥',
        type: 'dark',
        themeGroup: 'glitch'
    },
    // ========== 新增主题开始 ==========
    // 1. 玄黑经典（Classic Noir）
    {
        id: 'classic-noir-light',
        name: '玄黑经典',
        icon: '🖤',
        type: 'light',
        themeGroup: 'classic-noir'
    },
    {
        id: 'classic-noir-dark',
        name: '玄黑经典',
        icon: '◼️',
        type: 'dark',
        themeGroup: 'classic-noir'
    },
    // 2. 沙丘奢金（Luxury Dune）
    {
        id: 'luxury-dune-light',
        name: '沙丘奢金',
        icon: '🏜️',
        type: 'light',
        themeGroup: 'luxury-dune'
    },
    {
        id: 'luxury-dune-dark',
        name: '沙丘奢金',
        icon: '🌙',
        type: 'dark',
        themeGroup: 'luxury-dune'
    },
    // 3. 赛博脉冲（Cyber Pulse）
    {
        id: 'cyber-pulse-light',
        name: '赛博脉冲',
        icon: '💠',
        type: 'light',
        themeGroup: 'cyber-pulse'
    },
    {
        id: 'cyber-pulse-dark',
        name: '赛博脉冲',
        icon: '⚡',
        type: 'dark',
        themeGroup: 'cyber-pulse'
    },
    // 4. 森屿静雅（Nature Calm）
    {
        id: 'nature-calm-light',
        name: '森屿静雅',
        icon: '🌿',
        type: 'light',
        themeGroup: 'nature-calm'
    },
    {
        id: 'nature-calm-dark',
        name: '森屿静雅',
        icon: '🌲',
        type: 'dark',
        themeGroup: 'nature-calm'
    },
    // 5. 荒岩雅境（Stone Realm）
    {
        id: 'stone-realm-light',
        name: '荒岩雅境',
        icon: '🪨',
        type: 'light',
        themeGroup: 'stone-realm'
    },
    {
        id: 'stone-realm-dark',
        name: '荒岩雅境',
        icon: '🏔️',
        type: 'dark',
        themeGroup: 'stone-realm'
    },
    // 6. 纸艺空间（Paper Fold）
    {
        id: 'paper-fold-light',
        name: '纸艺空间',
        icon: '📄',
        type: 'light',
        themeGroup: 'paper-fold'
    },
    {
        id: 'paper-fold-dark',
        name: '纸艺空间',
        icon: '📋',
        type: 'dark',
        themeGroup: 'paper-fold'
    },
    // 7. 冷冽锋影（Brushed Metal）
    {
        id: 'brushed-metal-light',
        name: '冷冽锋影',
        icon: '⚙️',
        type: 'light',
        themeGroup: 'brushed-metal'
    },
    {
        id: 'brushed-metal-dark',
        name: '冷冽锋影',
        icon: '🔩',
        type: 'dark',
        themeGroup: 'brushed-metal'
    },
    // 8. 雾影层境（Misty Layer）
    {
        id: 'misty-layer-light',
        name: '雾影层境',
        icon: '🌫️',
        type: 'light',
        themeGroup: 'misty-layer'
    },
    {
        id: 'misty-layer-dark',
        name: '雾影层境',
        icon: '🌄',
        type: 'dark',
        themeGroup: 'misty-layer'
    },
    // 9. 线条秩序（Line Geometry）
    {
        id: 'line-geometry-light',
        name: '线条秩序',
        icon: '📐',
        type: 'light',
        themeGroup: 'line-geometry'
    },
    {
        id: 'line-geometry-dark',
        name: '线条秩序',
        icon: '✏️',
        type: 'dark',
        themeGroup: 'line-geometry'
    },
    // 10. 温陶釉色（Ceramic Glaze）
    {
        id: 'ceramic-glaze-light',
        name: '温陶釉色',
        icon: '🏺',
        type: 'light',
        themeGroup: 'ceramic-glaze'
    },
    {
        id: 'ceramic-glaze-dark',
        name: '温陶釉色',
        icon: '🍶',
        type: 'dark',
        themeGroup: 'ceramic-glaze'
    }
    // ========== 新增主题结束 ==========
];

// ==================== 主题组分类 ====================

const themeGroups = {};
themes.forEach(theme => {
    if (!themeGroups[theme.themeGroup]) {
        themeGroups[theme.themeGroup] = {
            name: theme.name,
            icon: theme.icon,
            lightId: theme.type === 'light' ? theme.id : null,
            darkId: theme.type === 'dark' ? theme.id : null
        };
    } else {
        if (theme.type === 'light') {
            themeGroups[theme.themeGroup].lightId = theme.id;
        } else {
            themeGroups[theme.themeGroup].darkId = theme.id;
        }
    }
});
// ==================== 全局变量 ====================

let currentTheme = 'aurora-light';

// ==================== 核心函数 ====================

// 判断是否为暗色模式
function isDarkMode() {
    const theme = themes.find(t => t.id === currentTheme);
    return theme ? theme.type === 'dark' : false;
}

// 获取同主题组的另一个明暗版本
function getToggleTheme() {
    const current = themes.find(t => t.id === currentTheme);
    if (!current) return 'aurora-light';
    
    const group = themeGroups[current.themeGroup];
    if (!group) return 'aurora-light';
    
    return isDarkMode() ? group.lightId : group.darkId;
}

// 应用主题
function applyTheme(themeId, save = true, keepCurrentMode = true) {
    let targetThemeId = themeId;
    
    // 获取当前主题信息（在修改之前）
    const currentThemeObj = themes.find(t => t.id === currentTheme);
    const currentGroupId = currentThemeObj ? currentThemeObj.themeGroup : null;
    
    // 如果需要保持当前明暗模式（切换主题时）
    if (keepCurrentMode) {
        // 判断当前是否是暗色模式
        const currentIsDark = isDarkMode();
        
        // 获取新主题的信息
        const newTheme = themes.find(t => t.id === themeId);
        if (newTheme) {
            // 获取新主题的主题组
            const newGroup = themeGroups[newTheme.themeGroup];
            if (newGroup) {
                // 根据当前的明暗模式，选择新主题的对应明暗版本
                if (currentIsDark && newGroup.darkId) {
                    // 当前是暗色模式，新主题有暗色版本，用暗色版本
                    targetThemeId = newGroup.darkId;
                } else if (!currentIsDark && newGroup.lightId) {
                    // 当前是亮色模式，新主题有亮色版本，用亮色版本
                    targetThemeId = newGroup.lightId;
                }
            }
        }
    }
    
    currentTheme = targetThemeId;
    document.documentElement.setAttribute('data-theme', targetThemeId);
    
    // 移除所有旧的 theme 类并添加新的
    const theme = themes.find(t => t.id === targetThemeId);
    if (theme) {
        // 移除所有 theme- 开头的类
        const classesToRemove = [];
        for (let i = 0; i < document.documentElement.classList.length; i++) {
            const cls = document.documentElement.classList[i];
            if (cls.startsWith('theme-')) {
                classesToRemove.push(cls);
            }
        }
        classesToRemove.forEach(cls => document.documentElement.classList.remove(cls));
        // 添加新的 theme 类
        document.documentElement.classList.add(`theme-${theme.themeGroup}`);
        
        // 检查是否切换到了不同的主题组
        if (currentGroupId && currentGroupId !== theme.themeGroup) {
            // 切换到了新主题组，重置所有卡片样式为默认
            localStorage.setItem('qnav_home_card_style', 'default');
            localStorage.setItem('qnav_ai_tool_card_style', 'default');

            localStorage.setItem('qnav_bookmark_card_style', 'mobile');
            // 重新应用书签卡片样式
            applyCardStyle('mobile', false);
        }
    }
    
    if (save) {
        localStorage.setItem('qnav_theme', targetThemeId);
    }
    
    updateLightDarkToggleIcon();
    renderThemeGrid();
    renderThemeDropdown();
    renderDropdownCardStyles();
    
    // 确保壁纸模式不受主题切换影响
    if (currentWallpaper && !document.body.classList.contains('has-wallpaper')) {
        applyWallpaper(currentWallpaper);
    }
    
    if (typeof renderCards === 'function') {
        renderCards();
    }
    renderHomeQuickSites();
    loadAdminCards();
}

// 应用卡片方案
function applyCardStyle(style, save = true) {
    const bookmarkGrid = document.getElementById('bookmarkGrid');
    if (!bookmarkGrid) return;

    // 移除所有卡片方案类
    bookmarkGrid.classList.remove('card-style-icon', 'card-style-text', 'card-style-glass', 'card-style-big', 'card-style-mobile', 'card-style-compact', 'card-style-list', 'card-style-minimal', 'card-style-ticket', 'card-style-hexagon', 'card-style-wavy', 'card-style-capsule', 'card-style-diagonal', 'card-style-rounded', 'card-style-neon', 'card-style-origami', 'card-style-stacked', 'card-style-gradient', 'card-style-glass', 'card-style-vertical', 'card-style-flip', 'card-style-tilt', 'card-style-badge', 'card-style-sticky', 'card-style-tech', 'card-style-letter');
    
    // 添加新的卡片方案类（注意：mobile是默认样式，不需要添加类）
    if (style !== 'mobile') {
        bookmarkGrid.classList.add(`card-style-${style}`);
    }

    if (save) {
        localStorage.setItem('qnav_bookmark_card_style', style);
    }

    // 更新设置面板中的选择状态
    updateCardStyleOptions(style);
}

// 更新卡片方案选择器状态
function updateCardStyleOptions(activeStyle) {
    const options = document.querySelectorAll('.card-style-option');
    options.forEach(opt => {
        if (opt.dataset.style === activeStyle) {
            opt.classList.add('active');
        } else {
            opt.classList.remove('active');
        }
    });
}

// 初始化卡片方案
function initCardStyle() {
    const savedStyle = localStorage.getItem('qnav_bookmark_card_style') || 'mobile';
    applyCardStyle(savedStyle, false);
}

// 更新明暗切换按钮图标
function updateLightDarkToggleIcon() {
    const dark = isDarkMode();
    if (typeof lightDarkToggle !== 'undefined' && lightDarkToggle) {
        lightDarkToggle.textContent = dark ? '☀️' : '🌙';
        lightDarkToggle.title = dark ? '切换到亮色模式' : '切换到暗色模式';
    }
}

// 明暗模式切换按钮点击事件
if (lightDarkToggle) {
    lightDarkToggle.addEventListener('click', function() {
        const toggleTheme = getToggleTheme();
        applyTheme(toggleTheme, true, false); // keepCurrentMode = false，不保持当前模式
        updateLightDarkToggleIcon();
        showToast(`已切换到${isDarkMode() ? '暗色' : '亮色'}模式`, 'success');
    });
}

// 主题选择按钮点击事件
if (themeSelectorBtn) {
    themeSelectorBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        const dropdown = document.getElementById('themeDropdown');
        if (dropdown) {
            // 切换显示状态
            if (dropdown.style.display === 'block') {
                dropdown.style.display = 'none';
                this.style.background = '';
            } else {
                // 先渲染主题下拉菜单
                renderThemeDropdown();
                dropdown.style.display = 'block';
                this.style.background = 'var(--bg-hover)';
                
                // 面板显示后统一更新所有壁纸输入框
                requestAnimationFrame(() => {
                    updateAllWallpaperInputs();
                });
            }
        }
    });
    
    // 点击外部关闭下拉菜单
    document.addEventListener('click', function(e) {
        const dropdown = document.getElementById('themeDropdown');
        if (dropdown && !e.target.closest('#themeDropdown') && !e.target.closest('#themeSelectorBtn')) {
            dropdown.style.display = 'none';
            if (themeSelectorBtn) themeSelectorBtn.style.background = '';
        }
    });
    
    // 关闭按钮点击事件
    const themeDropdownCloseBtn = document.getElementById('themeDropdownCloseBtn');
    if (themeDropdownCloseBtn) {
        themeDropdownCloseBtn.addEventListener('click', function(e) {
            e.stopPropagation();
            const dropdown = document.getElementById('themeDropdown');
            if (dropdown) dropdown.style.display = 'none';
            if (themeSelectorBtn) themeSelectorBtn.style.background = '';
        });
    }
}

// 事件委托：监听主题选项和卡片方案点击
document.addEventListener('click', function(e) {
    // 检查是否点击了主题下拉菜单中的主题选项
    const themeItem = e.target.closest('.dropdown-theme-item');
    if (themeItem) {
        const themeId = themeItem.getAttribute('data-theme');
        if (themeId) {
            e.stopPropagation();
            applyTheme(themeId);
        }
    }
    
    // 检查是否点击了设置页面中的主题选项
    const settingsThemeItem = e.target.closest('.theme-option');
    if (settingsThemeItem) {
        const themeId = settingsThemeItem.getAttribute('data-theme');
        if (themeId) {
            e.stopPropagation();
            applyTheme(themeId);
        }
    }
});



// 统一的主题渲染函数
// mode: 'dropdown' - 快捷弹窗样式 | 'grid' - 设置页面网格样式
function renderThemes(container, mode = 'grid') {
    if (!container) return;
    
    const uniqueThemes = Object.values(themeGroups).map(group => {
        return themes.find(t => t.id === group.lightId);
    }).filter(Boolean);
    
    // 获取当前主题所属的主题组
    const currentThemeObj = themes.find(t => t.id === currentTheme);
    const currentGroup = currentThemeObj ? currentThemeObj.themeGroup : '';
    
    // 根据模式选择不同的样式类和HTML结构
    const itemClass = mode === 'dropdown' ? 'dropdown-theme-item' : 'theme-option';
    const previewClass = mode === 'dropdown' ? 'dropdown-theme-preview' : 'theme-preview';
    const labelClass = mode === 'dropdown' ? 'dropdown-theme-name' : 'theme-label';
    
    container.innerHTML = uniqueThemes.map(theme => {
        const isActive = theme.themeGroup === currentGroup;
        // 根据主题是亮色还是暗色，选择合适的文字颜色
        const textColor = theme.id.endsWith('-dark') ? '#ffffff' : '#1f2937';
        
        if (mode === 'dropdown') {
            return `
            <div class="${itemClass} ${isActive ? 'active' : ''}" 
                 data-theme="${theme.id}"
                 style="background: ${getThemePreview(theme.id)};cursor:pointer;">
                <div class="${labelClass}" style="color: ${textColor}">${theme.icon} ${theme.name}</div>
            </div>
            `;
        } else {
            return `
            <div class="${itemClass} ${isActive ? 'active' : ''}" 
                 data-theme="${theme.id}"
                 style="background: ${getThemePreview(theme.id)};cursor:pointer;">
                ${isActive ? '<span class="theme-badge">✓</span>' : ''}
                <div class="${labelClass}" style="color: ${textColor}">${theme.icon} ${theme.name}</div>
            </div>
            `;
        }
    }).join('');
}

// 渲染主题下拉菜单（快捷弹窗）
function renderThemeDropdown() {
    const lightContainer = document.getElementById('themeDropdownLight');
    renderThemes(lightContainer, 'dropdown');
    
    // 渲染三区卡片方案下拉选项
    renderDropdownCardStyles();
    
    // 初始化标签页切换
    initDropdownTabs();
}

// 初始化弹窗标签页切换
function initDropdownTabs() {
    const tabs = document.querySelectorAll('.theme-dropdown-tab');
    const panels = document.querySelectorAll('.theme-dropdown-panel');
    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            const targetId = tab.getAttribute('data-tab');
            tabs.forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            panels.forEach(p => {
                p.classList.remove('active');
                p.style.display = 'none';
            });
            const targetPanel = document.getElementById(targetId);
            if (targetPanel) {
                targetPanel.classList.add('active');
                targetPanel.style.display = 'block';
            }
        });
    });
}

// 首页/推荐应用卡片方案选项
const cardStyleOptions = [
    { value: 'default', label: '主题默认' },
    { value: 'glass-stack', label: '毛玻璃堆叠' },
    { value: 'neo-brutal', label: '新粗野主义' },
    { value: 'bento', label: '便当盒' },
    { value: 'swiss', label: '瑞士风格' },
    { value: 'gradient-shift', label: '渐变幻彩' },
    { value: 'retro-wave', label: '复古波' },
    { value: 'soft-emboss', label: '软浮雕' },
    { value: 'holo-frame', label: '全息框体' },
    { value: 'luxe-line', label: '奢金线' },
    { value: 'panorama', label: '全景浮岛' },
    { value: 'geo-cutout', label: '几何镂空' },
    { value: 'polaroid', label: '堆叠宝丽来' },
    { value: 'hex-honey', label: '六边形蜂巢' },
    { value: 'float-tag', label: '浮动标签' },
    { value: 'diamond-mesh', label: '菱形网格' },
    { value: 'layer-ticket', label: '分层票根' },
    { value: 'curved-diag', label: '曲线对角' },
    { value: 'origami', label: '折纸折痕' }
];

// 收藏夹书签卡片样式选项
const bookmarkCardStyleList = [
    { value: 'mobile', label: '默认图标' },
    { value: 'list', label: '横向列表' },
    { value: 'minimal', label: '极简文字' },
    { value: 'ticket', label: '票根型' },
    { value: 'hexagon', label: '六边形' },
    { value: 'wavy', label: '波浪边' },
    { value: 'capsule', label: '胶囊标签' },
    { value: 'diagonal', label: '斜切角' },
    { value: 'rounded', label: '圆角矩形' },
    { value: 'neon', label: '霓虹光边' },
    { value: 'origami', label: '折纸折痕' },
    { value: 'stacked', label: '堆叠阴影' },
    { value: 'gradient', label: '渐变边框' },
    { value: 'glass', label: '玻璃态' },
    { value: 'vertical', label: '垂直图标' },
    { value: 'flip', label: '悬停翻页' },
    { value: 'tilt', label: '倾斜卡片' },
    { value: 'badge', label: '带角标' },
    { value: 'sticky', label: '复古便签' },
    { value: 'tech', label: '科技感' },
    { value: 'letter', label: '信笺式' }
];

// 渲染卡片方案按钮选项（同时处理主题选择弹窗和设置中心）
function renderDropdownCardStyles() {
    // ============= 主题选择弹窗 =============
    // 常用书签（弹窗）
    const quickContainer = document.getElementById('quickDropdownCardStyle');
    if (quickContainer) {
        const savedQuick = localStorage.getItem('qnav_home_card_style') || 'default';
        quickContainer.innerHTML = cardStyleOptions.map(s => 
            `<button class="card-style-option ${s.value === savedQuick ? 'active' : ''}" data-style="${s.value}" style="padding:8px 10px;font-size:0.78rem;">${s.label}</button>`
        ).join('');
    }
    
    // 推荐应用（弹窗）
    const aiContainer = document.getElementById('aiDropdownCardStyle');
    if (aiContainer) {
        const savedAi = localStorage.getItem('qnav_ai_tool_card_style') || 'default';
        aiContainer.innerHTML = cardStyleOptions.map(s => 
            `<button class="card-style-option ${s.value === savedAi ? 'active' : ''}" data-style="${s.value}" style="padding:8px 10px;font-size:0.78rem;">${s.label}</button>`
        ).join('');
    }
    
    // 收藏夹书签（弹窗）
    const bookmarkContainer = document.getElementById('bookmarkDropdownCardStyle');
    if (bookmarkContainer) {
        const savedBookmark = localStorage.getItem('qnav_bookmark_card_style') || 'mobile';
        bookmarkContainer.innerHTML = bookmarkCardStyleList.map(s => 
            `<button class="card-style-option ${s.value === savedBookmark ? 'active' : ''}" data-style="${s.value}" style="padding:8px 10px;font-size:0.78rem;">${s.label}</button>`
        ).join('');
    }
    
    // ============= 设置中心 - 主题标签页 =============
    // 收藏夹书签（主题标签页）
    const themeBookmarkContainer = document.getElementById('cardStyleOptions');
    if (themeBookmarkContainer) {
        const savedBookmark = localStorage.getItem('qnav_bookmark_card_style') || 'mobile';
        themeBookmarkContainer.innerHTML = bookmarkCardStyleList.map(s => 
            `<button class="card-style-option ${s.value === savedBookmark ? 'active' : ''}" data-style="${s.value}" style="padding:10px 12px;">${s.label}</button>`
        ).join('');
    }
    
    // ============= 设置中心 - 卡片样式标签页 =============
    // 常用书签（设置中心）
    const settingsQuickContainer = document.getElementById('homeCardStyleOptions');
    if (settingsQuickContainer) {
        const savedQuick = localStorage.getItem('qnav_home_card_style') || 'default';
        settingsQuickContainer.innerHTML = cardStyleOptions.map(s => 
            `<button class="card-style-option ${s.value === savedQuick ? 'active' : ''}" data-style="${s.value}" style="padding:10px 12px;">${s.label}</button>`
        ).join('');
    }
    
    // 推荐应用（设置中心）
    const settingsAiContainer = document.getElementById('aiToolCardStyleOptions');
    if (settingsAiContainer) {
        const savedAi = localStorage.getItem('qnav_ai_tool_card_style') || 'default';
        settingsAiContainer.innerHTML = cardStyleOptions.map(s => 
            `<button class="card-style-option ${s.value === savedAi ? 'active' : ''}" data-style="${s.value}" style="padding:10px 12px;">${s.label}</button>`
        ).join('');
    }
    
    // 收藏夹书签（设置中心）
    const settingsBookmarkContainer = document.getElementById('bookmarkCardStyleOptions');
    if (settingsBookmarkContainer) {
        const savedBookmark = localStorage.getItem('qnav_bookmark_card_style') || 'mobile';
        settingsBookmarkContainer.innerHTML = bookmarkCardStyleList.map(s => 
            `<button class="card-style-option ${s.value === savedBookmark ? 'active' : ''}" data-style="${s.value}" style="padding:10px 12px;">${s.label}</button>`
        ).join('');
    }
}

// 初始化弹窗卡片方案切换事件
function initDropdownCardStyleEvents() {
    // 常用书签切换
    const quickContainer = document.getElementById('quickDropdownCardStyle');
    if (quickContainer) {
        quickContainer.addEventListener('click', (e) => {
            const option = e.target.closest('.card-style-option');
            if (option) {
                const style = option.dataset.style;
                localStorage.setItem('qnav_home_card_style', style);
                renderHomeQuickSites();
                
                // 更新按钮状态
                quickContainer.querySelectorAll('.card-style-option').forEach(opt => {
                    opt.classList.remove('active');
                });
                option.classList.add('active');
                
                // 同步设置面板
                const panelOptions = document.getElementById('homeCardStyleOptions');
                if (panelOptions) {
                    panelOptions.querySelectorAll('.card-style-option').forEach(opt => {
                        opt.classList.toggle('active', opt.dataset.style === style);
                    });
                }
            }
        });
    }
    
    // 推荐应用切换
    const aiContainer = document.getElementById('aiDropdownCardStyle');
    if (aiContainer) {
        aiContainer.addEventListener('click', (e) => {
            const option = e.target.closest('.card-style-option');
            if (option) {
                const style = option.dataset.style;
                localStorage.setItem('qnav_ai_tool_card_style', style);
                loadAdminCards();
                
                // 更新按钮状态
                aiContainer.querySelectorAll('.card-style-option').forEach(opt => {
                    opt.classList.remove('active');
                });
                option.classList.add('active');
                
                // 同步设置面板
                const panelOptions = document.getElementById('aiToolCardStyleOptions');
                if (panelOptions) {
                    panelOptions.querySelectorAll('.card-style-option').forEach(opt => {
                        opt.classList.toggle('active', opt.dataset.style === style);
                    });
                }
            }
        });
    }
    
    // 收藏夹书签切换
    const bookmarkContainer = document.getElementById('bookmarkDropdownCardStyle');
    if (bookmarkContainer) {
        bookmarkContainer.addEventListener('click', (e) => {
            const option = e.target.closest('.card-style-option');
            if (option) {
                const style = option.dataset.style;
                applyCardStyle(style);
                showToast('✅ 收藏夹样式已更新', 'success');
            }
        });
    }
}

// 渲染主题选择器网格（设置页面）
function renderThemeGrid() {
    const grid = document.getElementById('themeGrid');
    renderThemes(grid, 'grid');
}

// 获取主题预览背景
function getThemePreview(themeId) {
    const previews = {
        'aurora-light': 'linear-gradient(160deg, #e8f4f8 0%, #f0e8f5 40%, #e8f0f8 100%)',
        'aurora-dark': 'linear-gradient(160deg, #0a1628 0%, #1a0a28 40%, #0a1a28 100%)',
        'minimal-light': 'linear-gradient(160deg, #f8f9fa 0%, #e9ecef 100%)',
        'minimal-dark': 'linear-gradient(160deg, #121212 0%, #1e1e1e 100%)',
        'elegance-light': 'linear-gradient(160deg, #faf5ff 0%, #f3e8ff 100%)',
        'elegance-dark': 'linear-gradient(160deg, #0f172a 0%, #1e293b 50%, #0f172a 100%)',
        'ocean-light': 'linear-gradient(160deg, #d4ebf2 0%, #e0f0f5 50%, #d0eef5 100%)',
        'ocean-dark': 'linear-gradient(160deg, #0a1628 0%, #081a2e 50%, #061a2a 100%)',
        'slate-light': 'linear-gradient(160deg, #f5f6f8 0%, #eef0f4 100%)',
        'slate-dark': 'linear-gradient(160deg, #18181b 0%, #1a1a1e 100%)',
        'arctic-light': 'linear-gradient(160deg, #f0f7fc 0%, #e3f0f8 100%)',
        'arctic-dark': 'linear-gradient(160deg, #0a1628 0%, #0c1a2e 100%)',
        'noir-light': 'linear-gradient(160deg, #ffffff 0%, #f0f0f0 100%)',
        'noir-dark': 'linear-gradient(160deg, #0a0a0a 0%, #141414 100%)',
        'synthwave-light': 'linear-gradient(160deg, #fef4ff 0%, #fce8f8 100%)',
        'synthwave-dark': 'linear-gradient(160deg, #0a0418 0%, #150525 100%)',
        'matrix-light': 'linear-gradient(160deg, #eafbea 0%, #d8f8d8 100%)',
        'matrix-dark': 'linear-gradient(160deg, #020502 0%, #010801 100%)',
        'neonacid-light': 'linear-gradient(160deg, #f4fef4 0%, #e8fce8 100%)',
        'neonacid-dark': 'linear-gradient(160deg, #000000 0%, #020202 100%)',
        'nebula-light': 'linear-gradient(160deg, #f4f0ff 0%, #ece4fc 100%)',
        'nebula-dark': 'linear-gradient(160deg, #060115 0%, #040818 100%)',
        'vital-light': 'linear-gradient(160deg, #f0f8ff 0%, #f5e8ff 100%)',
        'vital-dark': 'linear-gradient(160deg, #060814 0%, #0a0620 100%)',
        'ember-light': 'linear-gradient(160deg, #faf6f0 0%, #f4e8d8 100%)',
        'ember-dark': 'linear-gradient(160deg, #0c0806 0%, #160e0a 100%)',
        'prism-light': 'linear-gradient(160deg, #f0f0f0 0%, #f8f4fa 100%)',
        'prism-dark': 'linear-gradient(160deg, #0a0a12 0%, #0e0a18 100%)',
        'forest-light': 'linear-gradient(135deg, #F0FFF4 0%, #E6FFFA 50%, #FFFBEB 100%)',
        'forest-dark': 'linear-gradient(135deg, #0A1510 0%, #0A1015 50%, #15100A 100%)',
        'space-light': 'linear-gradient(135deg, #F0F9FF 0%, #EEF2FF 50%, #FFF7ED 100%)',
        'space-dark': 'linear-gradient(135deg, #020617 0%, #0F172A 50%, #111827 100%)',
        'glitch-light': 'linear-gradient(135deg, #FFF1F2 0%, #F0FDFA 50%, #F1F5F9 100%)',
        'glitch-dark': 'linear-gradient(135deg, #0F0205 0%, #020A0F 50%, #02050F 100%)'
    };
    return previews[themeId] || 'linear-gradient(160deg, #f0f0f0 0%, #e0e0e0 100%)';
}



function initTheme() {
    const savedTheme = localStorage.getItem('qnav_theme') || 'aurora-light';
    
    currentTheme = savedTheme;
    
    applyTheme(savedTheme, false);
    updateLightDarkToggleIcon();
    renderThemeDropdown();
}

// 初始化主题
initTheme();


// ==================== 壁纸 ====================
function applyWallpaper(url) {
    currentWallpaper = url || '';
    if (currentWallpaper) {
        // 使用 CSS 变量设置壁纸背景，通过伪元素显示
        document.documentElement.style.setProperty('--wallpaper-url', `url('${currentWallpaper}')`);
        document.body.classList.add('has-wallpaper');
        // 确保壁纸背景设置在正确的伪元素上
        const style = document.createElement('style');
        style.id = 'wallpaper-style';
        style.textContent = `
            .has-wallpaper::before {
                background-image: var(--wallpaper-url) !important;
            }
        `;
        const existingStyle = document.getElementById('wallpaper-style');
        if (existingStyle) existingStyle.remove();
        document.head.appendChild(style);
        log('✅ 壁纸模式已启用');
    } else {
        document.body.classList.remove('has-wallpaper');
        document.documentElement.style.removeProperty('--wallpaper-url');
        const existingStyle = document.getElementById('wallpaper-style');
        if (existingStyle) existingStyle.remove();
        log('壁纸模式已关闭');
    }
    saveSettings();
}





// 绑定首页显示数量设置
const homeDisplayCountSelect = document.getElementById('homeDisplayCount');
if (homeDisplayCountSelect) {
    // 加载保存的设置
    const savedCount = localStorage.getItem('qnav_home_display_count') || '12';
    homeDisplayCountSelect.value = savedCount;
    
    // 监听变化
    homeDisplayCountSelect.addEventListener('change', () => {
        localStorage.setItem('qnav_home_display_count', homeDisplayCountSelect.value);
        renderHomeQuickSites();
        showToast('✅ 首页设置已保存', 'success');
    });
}

// 绑定常用书签样式设置（可视化按钮）
const homeCardStyleOptions = document.getElementById('homeCardStyleOptions');
if (homeCardStyleOptions) {
    const savedStyle = localStorage.getItem('qnav_home_card_style') || 'default';
    
    // 初始化按钮状态
    homeCardStyleOptions.querySelectorAll('.card-style-option').forEach(opt => {
        if (opt.dataset.style === savedStyle) {
            opt.classList.add('active');
        } else {
            opt.classList.remove('active');
        }
    });
    
    // 绑定按钮点击事件
    homeCardStyleOptions.addEventListener('click', (e) => {
        const option = e.target.closest('.card-style-option');
        if (option) {
            e.stopPropagation(); // 阻止事件冒泡，避免触发全局事件
            const style = option.dataset.style;
            localStorage.setItem('qnav_home_card_style', style);
            renderHomeQuickSites();
            
            // 更新按钮状态
            homeCardStyleOptions.querySelectorAll('.card-style-option').forEach(opt => {
                opt.classList.remove('active');
            });
            option.classList.add('active');
            
            // 同步弹窗按钮
            const dropdownOptions = document.getElementById('quickDropdownCardStyle');
            if (dropdownOptions) {
                dropdownOptions.querySelectorAll('.card-style-option').forEach(opt => {
                    opt.classList.toggle('active', opt.dataset.style === style);
                });
            }
            
            showToast('✅ 常用书签样式已更新', 'success');
        }
    });
}

// 绑定推荐应用样式设置（可视化按钮）
const aiToolCardStyleOptions = document.getElementById('aiToolCardStyleOptions');
if (aiToolCardStyleOptions) {
    const savedStyle = localStorage.getItem('qnav_ai_tool_card_style') || 'default';
    
    // 初始化按钮状态
    aiToolCardStyleOptions.querySelectorAll('.card-style-option').forEach(opt => {
        if (opt.dataset.style === savedStyle) {
            opt.classList.add('active');
        } else {
            opt.classList.remove('active');
        }
    });
    
    // 绑定按钮点击事件
    aiToolCardStyleOptions.addEventListener('click', (e) => {
        const option = e.target.closest('.card-style-option');
        if (option) {
            e.stopPropagation(); // 阻止事件冒泡，避免触发全局事件
            const style = option.dataset.style;
            localStorage.setItem('qnav_ai_tool_card_style', style);
            loadAdminCards();
            
            // 更新按钮状态
            aiToolCardStyleOptions.querySelectorAll('.card-style-option').forEach(opt => {
                opt.classList.remove('active');
            });
            option.classList.add('active');
            
            // 同步弹窗按钮
            const dropdownOptions = document.getElementById('aiDropdownCardStyle');
            if (dropdownOptions) {
                dropdownOptions.querySelectorAll('.card-style-option').forEach(opt => {
                    opt.classList.toggle('active', opt.dataset.style === style);
                });
            }
            
            showToast('✅ 推荐应用样式已更新', 'success');
        }
    });
}

// 绑定收藏夹页卡片样式设置（可视化按钮）
const bookmarkCardStyleOptions = document.getElementById('bookmarkCardStyleOptions');
if (bookmarkCardStyleOptions) {
    const savedStyle = localStorage.getItem('qnav_bookmark_card_style') || 'mobile';
    
    // 初始化按钮状态
    bookmarkCardStyleOptions.querySelectorAll('.card-style-option').forEach(opt => {
        if (opt.dataset.style === savedStyle) {
            opt.classList.add('active');
        } else {
            opt.classList.remove('active');
        }
    });
    
    // 绑定按钮点击事件
    bookmarkCardStyleOptions.addEventListener('click', (e) => {
        const option = e.target.closest('.card-style-option');
        if (option) {
            const style = option.dataset.style;
            applyCardStyle(style);
            
            // 更新按钮状态 - 这里不需要单独更新，因为 applyCardStyle 会调用 updateCardStyleOptions 更新所有按钮
            
            showToast('✅ 收藏夹样式已更新', 'success');
        }
    });
}

// ==================== 搜索引擎 ====================
const defaultSearchEngine = document.getElementById('defaultSearchEngine');
defaultSearchEngine.addEventListener('change', () => {
    currentSearchEngine = defaultSearchEngine.value;
    saveSettings();
    document.getElementById('homeSearchSelect').value = currentSearchEngine;
    document.getElementById('heroSearchSelect').value = currentSearchEngine;
});

// ==================== 编辑模式开关 ====================
document.getElementById('editModeToggle').addEventListener('click', () => {
    // 如果正在退出编辑模式，直接退出
    if (isEditing) {
        isEditing = false;
        editPasswordVerified = false; // 重置验证状态
        document.body.classList.remove('editing');
        document.querySelector('.topbar').classList.remove('editing');
        
        const editBtn = document.getElementById('editModeToggle');
        editBtn.textContent = '✏️';
        editBtn.title = '编辑模式';
        
        document.querySelectorAll('.bookmark-card').forEach(card => card.classList.remove('editing'));
        renderAll();
        return;
    }
    
    // 进入编辑模式，检查是否有密码
    if (editPassword && !editPasswordVerified) {
        // 显示密码验证弹窗
        const overlay = document.getElementById('editPasswordOverlay');
        const input = document.getElementById('verifyEditPasswordInput');
        const error = document.getElementById('verifyPasswordError');
        error.style.display = 'none';
        input.value = '';
        input.focus();
        overlay.classList.add('show');
        return;
    }
    
    // 无密码或已验证，直接进入
    enterEditMode();
});

function enterEditMode() {
    isEditing = true;
    document.body.classList.add('editing');
    document.querySelector('.topbar').classList.add('editing');

    const sidebar = document.getElementById('sidebar');
    if (sidebar.classList.contains('hidden')) {
        sidebar.classList.remove('hidden');
        document.body.classList.remove('sidebar-hidden');
    }
    
    const editBtn = document.getElementById('editModeToggle');
    editBtn.textContent = '🔓';
    editBtn.title = '退出编辑模式';
    
    document.querySelectorAll('.bookmark-card').forEach(card => card.classList.add('editing'));
    renderAll();
    if (editPassword) showToast('已解锁编辑模式', 'success');
}

// 密码验证弹窗事件
document.getElementById('editPasswordOverlay').addEventListener('click', (e) => {
    if (e.target === document.getElementById('editPasswordOverlay')) {
        document.getElementById('editPasswordOverlay').classList.remove('show');
    }
});
document.getElementById('cancelVerifyPasswordBtn').addEventListener('click', () => {
    document.getElementById('editPasswordOverlay').classList.remove('show');
});
document.getElementById('confirmVerifyPasswordBtn').addEventListener('click', () => {
    const input = document.getElementById('verifyEditPasswordInput');
    const error = document.getElementById('verifyPasswordError');
    
    if (input.value === editPassword) {
        editPasswordVerified = true;
        document.getElementById('editPasswordOverlay').classList.remove('show');
        enterEditMode();
    } else {
        error.textContent = '❌ 密码错误，请检查后重试';
        error.style.display = 'block';
    }
});
document.getElementById('verifyEditPasswordInput').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        document.getElementById('confirmVerifyPasswordBtn').click();
    }
});

// 显示/隐藏登录密码
document.getElementById('toggleAuthPassword').addEventListener('click', () => {
    const input = document.getElementById('authPassword');
    const toggleBtn = document.getElementById('toggleAuthPassword');
    if (input.type === 'password') {
        input.type = 'text';
        toggleBtn.textContent = '🙈';
    } else {
        input.type = 'password';
        toggleBtn.textContent = '👁';
    }
});

// 显示/隐藏确认密码
document.getElementById('toggleConfirmPassword').addEventListener('click', () => {
    const input = document.getElementById('authConfirmPassword');
    const toggleBtn = document.getElementById('toggleConfirmPassword');
    if (input.type === 'password') {
        input.type = 'text';
        toggleBtn.textContent = '🙈';
    } else {
        input.type = 'password';
        toggleBtn.textContent = '👁';
    }
});

// 显示/隐藏验证密码
document.getElementById('showVerifyPasswordCheck').addEventListener('change', (e) => {
    const input = document.getElementById('verifyEditPasswordInput');
    input.type = e.target.checked ? 'text' : 'password';
});

// 显示/隐藏第一个密码输入框
let showEditPasswordInput = false;
document.getElementById('toggleEditPasswordInput').addEventListener('click', () => {
    showEditPasswordInput = !showEditPasswordInput;
    const input = document.getElementById('editPasswordInput');
    const btn = document.getElementById('toggleEditPasswordInput');
    input.type = showEditPasswordInput ? 'text' : 'password';
    btn.textContent = showEditPasswordInput ? '🙈' : '👁';
});

// 显示/隐藏第二个密码输入框
let showEditPasswordConfirmInput = false;
document.getElementById('toggleEditPasswordConfirmInput').addEventListener('click', () => {
    showEditPasswordConfirmInput = !showEditPasswordConfirmInput;
    const input = document.getElementById('editPasswordConfirmInput');
    const btn = document.getElementById('toggleEditPasswordConfirmInput');
    input.type = showEditPasswordConfirmInput ? 'text' : 'password';
    btn.textContent = showEditPasswordConfirmInput ? '🙈' : '👁';
});

// 设置密码
document.getElementById('setEditPasswordBtn').addEventListener('click', () => {
    const pwd1 = document.getElementById('editPasswordInput').value;
    const pwd2 = document.getElementById('editPasswordConfirmInput').value;
    
    if (!pwd1 || !pwd2) {
        showToast('请输入密码', 'error');
        return;
    }
    if (pwd1.length < 6) {
        showToast('密码至少6位', 'error');
        return;
    }
    if (pwd1 !== pwd2) {
        showToast('两次输入的密码不一致', 'error');
        return;
    }
    
    editPassword = pwd1;
    editPasswordVerified = false;
    saveSettings();
    document.getElementById('editPasswordInput').value = '';
    document.getElementById('editPasswordConfirmInput').value = '';
    showToast('编辑密码已设置', 'success');
    updatePasswordStatusPanel();
});

// 清空密码
document.getElementById('clearEditPasswordBtn').addEventListener('click', () => {
    editPassword = null;
    editPasswordVerified = false;
    saveSettings();
    showToast('编辑密码已清除', 'success');
    updatePasswordStatusPanel();
});

// 清空第一个密码输入框
document.getElementById('clearEditPasswordInputBtn').addEventListener('click', () => {
    document.getElementById('editPasswordInput').value = '';
});

// 清空第二个密码输入框
document.getElementById('clearEditPasswordConfirmInputBtn').addEventListener('click', () => {
    document.getElementById('editPasswordConfirmInput').value = '';
});

// 更新密码状态显示面板
function updatePasswordStatusPanel() {
    const notSetPanel = document.getElementById('passwordNotSet');
    const setPanel = document.getElementById('passwordSetPanel');
    
    if (editPassword && editPassword.length > 0) {
        notSetPanel.style.display = 'none';
        setPanel.style.display = 'block';
    } else {
        notSetPanel.style.display = 'block';
        setPanel.style.display = 'none';
    }
}

// ==================== 所有关闭按钮事件 ====================
document.querySelectorAll('.modal-close').forEach(btn => {
    btn.addEventListener('click', (e) => {
        const modal = e.target.closest('.modal-overlay');
        if (modal) {
            modal.classList.remove('show');
            // 如果是authModal关闭，重置UI
            if (modal.id === 'authModal') {
                // 短暂延迟后重置，确保动画完成
                setTimeout(() => {
                    document.getElementById('authTitle').textContent = '登录';
                    document.getElementById('submitAuth').textContent = '登录';
                    document.getElementById('switchAuthMode').textContent = '切换到注册';
                    document.getElementById('authPasswordGroup').style.display = '';
                    document.getElementById('switchAuthMode').style.display = '';
                    document.getElementById('submitAuth').style.display = '';
                    document.getElementById('forgotPasswordBtn').textContent = '忘记密码';
                    document.getElementById('backToLoginBtn').style.display = 'none';
                    document.getElementById('authConfirmPasswordGroup').style.display = 'none';
                    document.getElementById('rememberPasswordGroup').style.display = '';
                    document.getElementById('authError').style.display = 'none';
                }, 300);
            }
        }
    });
});

// ==================== 管理员检查 ====================
function isAdmin() {
    if (!currentUser || !currentUser.email) return false;
    // 从环境变量配置中读取管理员邮箱（Cloudflare Pages 注入的 ADMIN_EMAIL）
    const adminEmail = CONFIG.ADMIN_EMAIL || '';
    if (!adminEmail) {
        // 如果未配置 ADMIN_EMAIL，降级到硬编码的默认值（保持向后兼容）
        return currentUser.email === 'leader_dwq@163.com';
    }
    return currentUser.email.toLowerCase() === adminEmail.toLowerCase();
}

// 渲染图标：支持emoji和图片链接
function renderIcon(icon) {
    if (!icon) return '🌐';
    // 判断是否是URL（以http开头）
    if (icon.toLowerCase().startsWith('http')) {
        return `<img src="${icon}" loading="lazy" style="width:20px;height:20px;object-fit:contain;display:inline-block;vertical-align:middle;" onerror="this.outerHTML='🌐'">`;
    }
    return icon;
}

// ==================== 管理员推广卡片管理 ====================
async function renderAdminCardsList() {
    const listEl = document.getElementById('adminCardsList');
    if (!listEl) return;
    
    listEl.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-secondary);">加载中...</div>';
    
    if (!isCloudReady) {
        listEl.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-secondary);">云端未连接</div>';
        return;
    }
    
    const res = await safeSupabaseCall(supabaseClient.from('admin_cards').select('*').order('sort_order'));
    if (!res || res.error) {
        listEl.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-secondary);">加载失败: ' + (res.error?.message || '未知错误') + '</div>';
        return;
    }
    
    const cards = res.data || [];
    if (cards.length === 0) {
        listEl.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-secondary);">暂无卡片，可在下方添加</div>';
        return;
    }
    
    listEl.innerHTML = `
        <div style="margin-bottom:10px;padding:8px 12px;background:var(--bg-active);border-radius:8px;font-size:0.85rem;">
            💡 提示：可以拖拽卡片调整顺序，点击上下按钮快速移动
        </div>
        ${cards.map((card, index) => `
        <div class="recycle-item" draggable="true" data-id="${card.id}" data-index="${index}" style="cursor:move;">
            <div class="recycle-item-info">
                <div class="recycle-item-name">${renderIcon(card.icon)} ${esc(card.name)}</div>
                <div class="recycle-item-date">${esc(card.url)}</div>
            </div>
            <div class="recycle-item-actions" style="display:flex;gap:4px;">
                <button class="btn btn-ghost btn-sm move-up-btn" data-id="${card.id}" data-index="${index}" title="上移" ${index === 0 ? 'disabled' : ''}>↑</button>
                <button class="btn btn-ghost btn-sm move-down-btn" data-id="${card.id}" data-index="${index}" title="下移" ${index === cards.length - 1 ? 'disabled' : ''}>↓</button>
                <button class="btn btn-ghost btn-sm edit-admin-card-btn" data-id="${card.id}" data-name="${esc(card.name)}" data-url="${esc(card.url)}" data-icon="${esc(card.icon)}" title="编辑">✏️</button>
                <button class="btn btn-danger btn-sm delete-admin-card-btn" data-id="${card.id}">删除</button>
            </div>
        </div>
    `).join('')}`;
    
    // 绑定删除事件
    listEl.querySelectorAll('.delete-admin-card-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            const id = e.target.dataset.id;
            const confirmed = await showConfirmDialog('🗑️', '删除卡片', '确定删除这个推广卡片吗？');
            if (!confirmed) return;
            
            await safeSupabaseCall(supabaseClient.from('admin_cards').delete().eq('id', id));
            showToast('卡片已删除', 'success');
            await renderAdminCardsList();
            await loadAdminCards();
        });
    });
    
    // 绑定编辑事件
    listEl.querySelectorAll('.edit-admin-card-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            const id = e.target.dataset.id;
            const name = e.target.dataset.name;
            const url = e.target.dataset.url;
            const icon = e.target.dataset.icon;
            
            // 填充编辑表单
            document.getElementById('editCardName').value = name;
            document.getElementById('editCardUrl').value = url;
            document.getElementById('editCardIcon').value = icon || '🌐';
            document.getElementById('editCardOverlay').dataset.editingId = id;
            document.getElementById('editCardOverlay').classList.add('show');
        });
    });
    
    // 绑定上移事件
    listEl.querySelectorAll('.move-up-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            const id = e.target.dataset.id;
            const index = parseInt(e.target.dataset.index);
            if (index <= 0) return;
            await swapCardOrder(id, index, index - 1);
        });
    });
    
    // 绑定下移事件
    listEl.querySelectorAll('.move-down-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            const id = e.target.dataset.id;
            const index = parseInt(e.target.dataset.index);
            const totalCards = listEl.querySelectorAll('.recycle-item').length;
            if (index >= totalCards - 1) return;
            await swapCardOrder(id, index, index + 1);
        });
    });
    
    // 绑定拖拽排序
    let draggedItem = null;
    listEl.querySelectorAll('.recycle-item').forEach(item => {
        item.addEventListener('dragstart', (e) => {
            draggedItem = item;
            item.style.opacity = '0.5';
        });
        item.addEventListener('dragend', () => {
            item.style.opacity = '';
            draggedItem = null;
        });
        item.addEventListener('dragover', (e) => {
            e.preventDefault();
        });
        item.addEventListener('drop', async (e) => {
            e.preventDefault();
            if (!draggedItem || draggedItem === item) return;
            
            const fromId = draggedItem.dataset.id;
            const fromIndex = parseInt(draggedItem.dataset.index);
            const toIndex = parseInt(item.dataset.index);
            
            if (fromIndex === toIndex) return;
            await swapCardOrder(fromId, fromIndex, toIndex);
        });
    });
}

async function swapCardOrder(moveId, fromIndex, toIndex) {
    const listEl = document.getElementById('adminCardsList');
    const items = Array.from(listEl.querySelectorAll('.recycle-item'));
    const allCards = items.map(item => ({
        id: item.dataset.id,
        index: parseInt(item.dataset.index)
    }));
    
    // 重新计算顺序
    const newOrder = [];
    allCards.forEach((card, idx) => {
        if (card.id === moveId) {
            newOrder.push({ id: card.id, sort_order: toIndex });
        } else if (fromIndex < toIndex) {
            // 向后移动，中间的索引减1
            if (idx > fromIndex && idx <= toIndex) {
                newOrder.push({ id: card.id, sort_order: idx - 1 });
            } else {
                newOrder.push({ id: card.id, sort_order: idx });
            }
        } else {
            // 向前移动，中间的索引加1
            if (idx >= toIndex && idx < fromIndex) {
                newOrder.push({ id: card.id, sort_order: idx + 1 });
            } else {
                newOrder.push({ id: card.id, sort_order: idx });
            }
        }
    });
    
    // 批量更新
    for (const card of newOrder) {
        await safeSupabaseCall(supabaseClient.from('admin_cards').update({ sort_order: card.sort_order }).eq('id', card.id));
    }
    
    showToast('顺序已更新', 'success');
    await renderAdminCardsList();
    await loadAdminCards();
}

// 绑定添加卡片事件
document.getElementById('addAdminCardBtn')?.addEventListener('click', async () => {
    const name = document.getElementById('newCardName').value.trim();
    const url = document.getElementById('newCardUrl').value.trim();
    const icon = document.getElementById('newCardIcon').value.trim() || '🌐';
    
    if (!name || !url) {
        showToast('请填写名称和链接', 'error');
        return;
    }
    
    // 添加sort_order
    const cardsRes = await safeSupabaseCall(supabaseClient.from('admin_cards').select('*'));
    const currentCount = cardsRes?.data?.length || 0;
    
    const res = await safeSupabaseCall(supabaseClient.from('admin_cards').insert([{
        name,
        url,
        icon,
        sort_order: currentCount
    }]));
    
    if (res && !res.error) {
        showToast('卡片添加成功', 'success');
        document.getElementById('newCardName').value = '';
        document.getElementById('newCardUrl').value = '';
        document.getElementById('newCardIcon').value = '';
        await renderAdminCardsList();
        await loadAdminCards();
    } else {
        let errorMsg = res.error?.message || '未知错误';
        if (errorMsg.toLowerCase().includes('row level security') || errorMsg.toLowerCase().includes('policy')) {
            errorMsg = '需要在Supabase后台设置RLS策略！请打开：\nSupabase后台 → Authentication → Policies\n找到admin_cards表，添加允许INSERT、UPDATE、DELETE的策略\n（或者临时禁用RLS）';
            showToast(errorMsg, 'error', 8000);
        } else {
            showToast('添加失败: ' + errorMsg, 'error');
        }
    }
});

// 绑定管理卡片按钮事件（旧按钮）
document.getElementById('manageAdminCardsBtn')?.addEventListener('click', async () => {
    settingsOverlay.classList.remove('show');
    await renderAdminCardsList();
    document.getElementById('adminCardsOverlay').classList.add('show');
});

// 绑定设置面板中管理卡片按钮事件
document.getElementById('openAdminCardsBtn')?.addEventListener('click', async () => {
    settingsOverlay.classList.remove('show');
    await renderAdminCardsList();
    document.getElementById('adminCardsOverlay').classList.add('show');
});

// 关闭管理员卡片弹窗
document.getElementById('closeAdminCardsBtn')?.addEventListener('click', () => {
    document.getElementById('adminCardsOverlay').classList.remove('show');
});
document.getElementById('adminCardsOverlay')?.addEventListener('click', (e) => {
    if (e.target === document.getElementById('adminCardsOverlay')) {
        document.getElementById('adminCardsOverlay').classList.remove('show');
    }
});

// 编辑卡片弹窗
document.getElementById('editCardOverlay').querySelector('.modal-close')?.addEventListener('click', () => {
    document.getElementById('editCardOverlay').classList.remove('show');
});
document.getElementById('editCardOverlay')?.addEventListener('click', (e) => {
    if (e.target === document.getElementById('editCardOverlay')) {
        document.getElementById('editCardOverlay').classList.remove('show');
    }
});
document.getElementById('cancelEditCardBtn')?.addEventListener('click', () => {
    document.getElementById('editCardOverlay').classList.remove('show');
});
document.getElementById('saveEditCardBtn')?.addEventListener('click', async () => {
    const id = document.getElementById('editCardOverlay').dataset.editingId;
    const name = document.getElementById('editCardName').value.trim();
    const url = document.getElementById('editCardUrl').value.trim();
    const icon = document.getElementById('editCardIcon').value.trim() || '🌐';
    
    if (!name || !url) {
        showToast('请填写名称和链接', 'error');
        return;
    }
    
    const res = await safeSupabaseCall(supabaseClient.from('admin_cards').update({ name, url, icon }).eq('id', id));
    if (res && !res.error) {
        showToast('卡片已更新', 'success');
        document.getElementById('editCardOverlay').classList.remove('show');
        await renderAdminCardsList();
        await loadAdminCards();
    } else {
        showToast('更新失败: ' + (res.error?.message || '未知错误'), 'error');
    }
});

// ==================== 添加文件夹 ====================
document.getElementById('addFolderBtn')?.addEventListener('click', showAddFolderModal);
document.getElementById('addFolderBtn2')?.addEventListener('click', showAddFolderModal);

// 公共函数：填充文件夹选择器
function populateFolderSelect(selectEl, excludeIds = null, defaultId = null) {
    selectEl.innerHTML = '<option value="">根目录</option>';
    function collect(nodes, depth = 0) {
        nodes.forEach(node => {
            if ((node.isFolder || node.children !== undefined) && (!excludeIds || !excludeIds.has(node.id))) {
                const prefix = '  '.repeat(depth);
                selectEl.innerHTML += `<option value="${node.id}">${prefix}${node.icon || '📁'} ${node.name}</option>`;
                if (node.children) collect(node.children, depth + 1);
            }
        });
    }
    collect(data);
    if (defaultId) selectEl.value = defaultId;
}

function showAddFolderModal() {
    if (!isEditing) {
        showToast('请先进入编辑模式', 'error');
        return;
    }
    document.getElementById('addFolderName').value = '';
    document.getElementById('addFolderIcon').value = '';
    
    const folderSelect = document.getElementById('addFolderParent');
    const defaultId = currentPath.length > 0 ? (findNodeByPath(data, currentPath)?.id || null) : null;
    populateFolderSelect(folderSelect, null, defaultId);
    
    document.getElementById('addFolderOverlay').classList.add('show');
}

document.getElementById('addFolderOverlay')?.querySelector('.modal-close')?.addEventListener('click', () => {
    document.getElementById('addFolderOverlay').classList.remove('show');
});
document.getElementById('addFolderOverlay')?.addEventListener('click', (e) => {
    if (e.target === document.getElementById('addFolderOverlay')) {
        document.getElementById('addFolderOverlay').classList.remove('show');
    }
});
document.getElementById('cancelAddFolderBtn')?.addEventListener('click', () => {
    document.getElementById('addFolderOverlay').classList.remove('show');
});

document.getElementById('confirmAddFolderBtn')?.addEventListener('click', async () => {
    const name = document.getElementById('addFolderName').value.trim();
    const icon = document.getElementById('addFolderIcon').value.trim() || '📁';
    const parentId = document.getElementById('addFolderParent').value || null;
    
    if (!name) {
        showToast('请输入文件夹名称', 'error');
        return;
    }
    
    const newFolder = {
        id: generateId(),
        name,
        icon,
        isFolder: true,
        children: []
    };
    
    addNodeToParent(data, parentId, newFolder);
    allBookmarks = flattenTree(data);
    saveLocalData();
    renderAll();
    
    // 如果已登录，同步到云端
    if (isCloudReady && currentUser) {
        log('[添加文件夹] 开始同步到云端');
        await threeWayMergeSync();
    }
    
    document.getElementById('addFolderOverlay').classList.remove('show');
});

// ==================== 添加书签 ====================
document.getElementById('addBookmarkBtn')?.addEventListener('click', showAddBookmarkModal);
document.getElementById('addBookmarkBtn2')?.addEventListener('click', showAddBookmarkModal);

function showAddBookmarkModal() {
    if (!isEditing) {
        showToast('请先进入编辑模式', 'error');
        return;
    }
    document.getElementById('addBookmarkName').value = '';
    document.getElementById('addBookmarkUrl').value = '';
    document.getElementById('addBookmarkIcon').value = '';
    
    const folderSelect = document.getElementById('addBookmarkFolder');
    const defaultId = currentPath.length > 0 ? (findNodeByPath(data, currentPath)?.id || null) : null;
    populateFolderSelect(folderSelect, null, defaultId);
    
    document.getElementById('addBookmarkOverlay').classList.add('show');
}

document.getElementById('addBookmarkOverlay')?.querySelector('.modal-close')?.addEventListener('click', () => {
    document.getElementById('addBookmarkOverlay').classList.remove('show');
});
document.getElementById('addBookmarkOverlay')?.addEventListener('click', (e) => {
    if (e.target === document.getElementById('addBookmarkOverlay')) {
        document.getElementById('addBookmarkOverlay').classList.remove('show');
    }
});
document.getElementById('cancelAddBookmarkBtn')?.addEventListener('click', () => {
    document.getElementById('addBookmarkOverlay').classList.remove('show');
});



let isAddingBookmark = false;

document.getElementById('confirmAddBookmarkBtn')?.addEventListener('click', async () => {
    if (isAddingBookmark) return;
    isAddingBookmark = true;
    
    const name = document.getElementById('addBookmarkName').value.trim();
    let url = document.getElementById('addBookmarkUrl').value.trim();
    let icon = document.getElementById('addBookmarkIcon').value.trim();
    const parentId = document.getElementById('addBookmarkFolder').value || null;
    
    if (!name || !url) {
        showToast('请输入名称和网址', 'error');
        isAddingBookmark = false;
        return;
    }
    
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
        url = 'https://' + url;
    }
    
    const newBookmark = {
        id: generateId(),
        name,
        url,
        icon: icon || '🌐'
    };
    
    addNodeToParent(data, parentId || null, newBookmark);
    allBookmarks = flattenTree(data);
    saveLocalData();
    renderAll();
    
    if (isCloudReady && currentUser) {
        log('[添加书签] 开始同步到云端');
        await threeWayMergeSync();
    }
    
    document.getElementById('addBookmarkOverlay').classList.remove('show');
    isAddingBookmark = false;
});

// ==================== 编辑书签 ====================
document.getElementById('editBookmarkOverlay')?.querySelector('.modal-close')?.addEventListener('click', () => {
    document.getElementById('editBookmarkOverlay').classList.remove('show');
});
document.getElementById('editBookmarkOverlay')?.addEventListener('click', (e) => {
    if (e.target === document.getElementById('editBookmarkOverlay')) {
        document.getElementById('editBookmarkOverlay').classList.remove('show');
    }
});
document.getElementById('cancelEditBookmarkBtn')?.addEventListener('click', () => {
    document.getElementById('editBookmarkOverlay').classList.remove('show');
});

document.getElementById('confirmEditBookmarkBtn')?.addEventListener('click', async () => {
    const name = document.getElementById('editBookmarkName').value.trim();
    let url = document.getElementById('editBookmarkUrl').value.trim();
    let icon = document.getElementById('editBookmarkIcon').value.trim();
    
    if (!name || !url) {
        showToast('请输入名称和网址', 'error');
        return;
    }
    
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
        url = 'https://' + url;
    }
    
    const treeNode = findNodeById(data, currentEditBookmarkId);
    if (treeNode) {
        treeNode.name = name;
        treeNode.url = url;
        treeNode.icon = icon || '🌐';
    }
    
    if (isCloudReady && currentUser) {
        const bm = allBookmarks.find(b => b.id === currentEditBookmarkId);
        if (bm) {
            bm.name = name;
            bm.url = url;
            bm.icon = icon || '🌐';
            await syncSingleBookmark(bm, 'update');
        }
    }
    
    allBookmarks = flattenTree(data);
    saveLocalData();
    renderAll();
    showToast('书签已更新', 'success');
    document.getElementById('editBookmarkOverlay').classList.remove('show');
});

document.getElementById('editFolderOverlay')?.addEventListener('click', (e) => {
    if (e.target === document.getElementById('editFolderOverlay')) {
        document.getElementById('editFolderOverlay').classList.remove('show');
    }
});
document.getElementById('editFolderOverlay')?.querySelector('.modal-close')?.addEventListener('click', () => {
    document.getElementById('editFolderOverlay').classList.remove('show');
});
document.getElementById('cancelEditFolderBtn')?.addEventListener('click', () => {
    document.getElementById('editFolderOverlay').classList.remove('show');
});

document.getElementById('confirmEditFolderBtn')?.addEventListener('click', async () => {
    const name = document.getElementById('editFolderName').value.trim();
    const icon = document.getElementById('editFolderIcon').value.trim() || '📁';
    const parentId = document.getElementById('editFolderParent').value || null;
    
    if (!name) {
        showToast('请输入文件夹名称', 'error');
        return;
    }
    
    const treeNode = findNodeById(data, currentEditFolderId);
    if (treeNode) {
        treeNode.name = name;
        treeNode.icon = icon;
        
        // 检查是否需要移动到新的父级
        const currentParent = findParentNode(data, currentEditFolderId);
        const currentParentId = currentParent ? currentParent.id : null;
        
        if (currentParentId !== parentId) {
            // 从当前父级移除
            if (currentParent) {
                currentParent.children = currentParent.children.filter(c => c.id !== currentEditFolderId);
            } else {
                data = data.filter(c => c.id !== currentEditFolderId);
            }
            
            // 添加到新父级
            addNodeToParent(data, parentId, treeNode);
        }
    }
    
    if (isCloudReady && currentUser) {
        await threeWayMergeSync();
    }
    
    allBookmarks = flattenTree(data);
    saveLocalData();
    renderAll();
    showToast('文件夹已更新', 'success');
    document.getElementById('editFolderOverlay').classList.remove('show');
});

// ==================== 图标上传到Supabase Storage ====================
// 配置说明：
// 1. 在Supabase控制台创建存储桶：icons，设为公开读
// 2. 配置RLS策略（根据使用模式选择）：
//    - 本地模式（当前）：由于是本地生成的UUID作为userId，RLS策略需要允许公开上传
//      执行: CREATE POLICY "Allow public uploads" ON storage.objects FOR ALL TO public USING (bucket_id = 'icons');
//    - 认证模式（未来）：如果接入Supabase Auth，RLS策略应为认证用户可写
//      执行: CREATE POLICY "Authenticated users can upload icons" ON storage.objects FOR INSERT TO authenticated USING (bucket_id = 'icons');
// 3. CORS已加本地域名
// 
// 当前实现：本地模式（localStorage存储，无Supabase Auth）
// - 用户ID为本地生成的UUID（存储在 localStorage['qnav_local_user_id']）
// - 文件路径格式：icons/{localUserId}/{timestamp-random.ext}
// - 上传时无需认证（需配置公开写RLS策略）

const ALLOWED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/svg+xml', 'image/webp'];
const MAX_FILE_SIZE = 1 * 1024 * 1024; // 1MB

// 生成随机文件名
function generateRandomFileName(originalName) {
    const ext = originalName.split('.').pop().toLowerCase();
    const random = Math.random().toString(36).substring(2, 15);
    return `${Date.now()}-${random}.${ext}`;
}

// 获取当前用户ID（纯同步，使用localStorage UUID）
function getCurrentUserId() {
    // 本地模式：生成稳定的UUID存储在localStorage
    let localUserId = localStorage.getItem('qnav_local_user_id');
    if (!localUserId) {
        // 生成UUID v4格式的ID
        localUserId = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
            const r = Math.random() * 16 | 0;
            const v = c === 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
        localStorage.setItem('qnav_local_user_id', localUserId);
    }
    return localUserId;
}

// 文件格式校验
function validateImageFile(file) {
    if (!file) return { valid: false, message: '请选择文件' };
    
    if (file.size > MAX_FILE_SIZE) {
        return { valid: false, message: `文件大小超过限制（最大1MB）` };
    }
    
    if (!ALLOWED_IMAGE_TYPES.includes(file.type)) {
        return { valid: false, message: `不支持的文件格式，仅支持: ${ALLOWED_IMAGE_TYPES.join(', ')}` };
    }
    
    return { valid: true, message: '验证通过' };
}

// SVG XSS过滤 - 移除危险内容
function sanitizeSVG(svgContent) {
    if (!svgContent) return '';
    
    // 移除<script>标签
    let sanitized = svgContent.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
    
    // 移除on*事件属性
    sanitized = sanitized.replace(/\s+on\w+\s*=\s*["'][^"']*["']/gi, '');
    sanitized = sanitized.replace(/\s+on\w+\s*=\s*[^>\s]+/gi, '');
    
    // 移除javascript:伪协议
    sanitized = sanitized.replace(/javascript:/gi, '');
    
    // 移除eval()调用
    sanitized = sanitized.replace(/\beval\s*\(/gi, '/*eval blocked*/(');
    
    return sanitized;
}

// 将SVG字符串转换为Blob
function svgStringToBlob(svgContent) {
    const blob = new Blob([svgContent], { type: 'image/svg+xml' });
    return blob;
}

// 上传文件到Supabase Storage
async function uploadIconToStorage(file, originalName) {
    if (typeof supabaseClient === 'undefined') {
        throw new Error('Supabase未初始化，请刷新页面重试');
    }
    
    try {
        const userId = getCurrentUserId();
        const fileName = generateRandomFileName(originalName);
        const filePath = `icons/${userId}/${fileName}`;
        
        // 上传文件（异步）
        const { data, error } = await supabaseClient.storage
            .from('icons')
            .upload(filePath, file, {
                cacheControl: '3600',
                upsert: false
            });
        
        if (error) {
            error('上传失败:', error);
            throw new Error(`上传失败: ${error.message}`);
        }
        
        // 获取公开URL（同步方法，不加await）
        const { data: urlData, error: urlError } = supabaseClient.storage
            .from('icons')
            .getPublicUrl(filePath);
        
        if (urlError) {
            error('获取URL失败:', urlError);
            throw new Error(`获取URL失败: ${urlError.message}`);
        }
        
        // 返回字符串URL
        const publicUrl = urlData?.publicUrl;
        if (!publicUrl || typeof publicUrl !== 'string') {
            throw new Error('无法获取有效URL');
        }
        
        return publicUrl;
    } catch (err) {
        error('上传过程出错:', err);
        throw err;
    }
}

// 处理图标输入 - 四合一模式
async function processIconInput(value, targetInputId) {
    const input = document.getElementById(targetInputId);
    
    if (!value || value.trim() === '') {
        input.value = '🌐';
        return '🌐';
    }
    
    const trimmedValue = value.trim();
    
    // ① http/https开头 - 作为外部URL
    if (trimmedValue.toLowerCase().startsWith('http://') || trimmedValue.toLowerCase().startsWith('https://')) {
        input.value = trimmedValue;
        return trimmedValue;
    }
    
    // ② <svg开头 - 转换为Blob上传
    if (trimmedValue.startsWith('<svg')) {
        try {
            // SVG XSS过滤
            const sanitizedSVG = sanitizeSVG(trimmedValue);
            
            // 转换为Blob
            const blob = svgStringToBlob(sanitizedSVG);
            
            // 上传到Storage
            const url = await uploadIconToStorage(blob, 'icon.svg');
            
            input.value = url;
            return url;
        } catch (err) {
            error('SVG处理失败:', err);
            showToast('SVG上传失败: ' + err.message, 'error');
            input.value = '🌐';
            return '🌐';
        }
    }
    
    // ③ 其他 - 作为Emoji
    input.value = trimmedValue;
    return trimmedValue;
}

// 上传按钮点击事件
document.querySelectorAll('.icon-upload-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
        e.preventDefault();
        const targetInputId = btn.dataset.target;
        
        // 创建隐藏的file input
        let fileInput = document.getElementById('iconUploadInput');
        if (!fileInput) {
            fileInput = document.createElement('input');
            fileInput.type = 'file';
            fileInput.id = 'iconUploadInput';
            fileInput.accept = 'image/png,image/jpeg,image/svg+xml,image/webp';
            fileInput.style.display = 'none';
            document.body.appendChild(fileInput);
        }
        
        fileInput.onchange = async (event) => {
            const file = event.target.files[0];
            if (!file) return;
            
            // 文件校验
            const validation = validateImageFile(file);
            if (!validation.valid) {
                showToast(validation.message, 'error');
                return;
            }
            
            // 显示上传中状态
            btn.classList.add('uploading');
            btn.textContent = '⏳';
            
            try {
                // 上传文件
                const url = await uploadIconToStorage(file, file.name);
                
                // 更新输入框
                document.getElementById(targetInputId).value = url;
                
                showToast('图标上传成功', 'success');
            } catch (err) {
                showToast('上传失败: ' + err.message, 'error');
            } finally {
                // 恢复按钮状态
                btn.classList.remove('uploading');
                btn.textContent = '📷';
                
                // 清空file input
                event.target.value = '';
            }
        };
        
        // 触发文件选择
        fileInput.click();
    });
});

// 图标输入框粘贴事件处理
document.querySelectorAll('.icon-input-wrapper input').forEach(input => {
    input.addEventListener('paste', async (e) => {
        // 阻止浏览器默认粘贴行为，防止重复粘贴
        e.preventDefault();
        
        const clipboardData = e.clipboardData || window.clipboardData;
        const pastedText = clipboardData.getData('text');
        
        if (!pastedText) return;
        
        // 处理粘贴内容
        try {
            await processIconInput(pastedText, input.id);
        } catch (err) {
            error('粘贴处理失败:', err);
            showToast('粘贴处理失败', 'error');
        }
    });
});

// ==================== 测试函数（可在控制台调用）====================
// 测试图标上传
window.testIconUpload = async function(file) {
    if (typeof supabaseClient === 'undefined') {
        error('Supabase未初始化');
        return null;
    }
    
    try {
        const url = await uploadIconToStorage(file, file.name);
        log('上传成功，URL:', url);
        return url;
    } catch (err) {
        error('上传失败:', err);
        return null;
    }
};

// 测试获取用户ID
window.testGetUserId = function() {
    const userId = getCurrentUserId();
    log('当前用户ID:', userId);
    return userId;
};

// ==================== 图标选择器 ====================
const iconCategories = {
    common: ['📁', '📂', '📄', '📎', '📌', '🔗', '💾', '📊', '📈', '📉', '📆', '📅', '🗂️', '🗃️', '🗄️'],
    tools: ['🛠️', '🔧', '🔨', '⚙️', '🔩', '⚡', '🔋', '💻', '📱', '⌚', '📷', '🎥', '🎧', '🎮', '🖥️', '🖨️'],
    social: ['💬', '📢', '📣', '🔔', '✉️', '📧', '📮', '💌', '🗣️', '👥', '👤', '👥', '🤝', '💫', '⭐', '🌟'],
    media: ['🎬', '🎵', '🎶', '🎤', '🎧', '🎼', '🎹', '🎸', '🥁', '🎺', '🎻', '📺', '📻', '🎮', '🎲', '🎯'],
    office: ['📝', '✏️', '✒️', '🖊️', '🖋️', '📚', '📖', '📕', '📗', '📘', '📙', '📓', '📒', '📋', '📁', '🗃️'],
    nature: ['🌲', '🌳', '🌴', '🌵', '🌷', '🌸', '🌹', '🌺', '🌻', '🌼', '🌽', '🍎', '🍊', '🍋', '🍌', '🍉'],
    emoji: ['😀', '😃', '😄', '😁', '😆', '😊', '😇', '🙂', '🙃', '😉', '😌', '😍', '🥰', '😘', '😗', '😙']
};

let currentIconTarget = null;

// 显示图标选择器
document.querySelectorAll('.icon-picker-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
        currentIconTarget = btn.dataset.target;
        document.getElementById('iconPickerOverlay').classList.add('show');
        renderIconGrid('common');
    });
});

// 关闭图标选择器
document.getElementById('iconPickerOverlay')?.querySelector('.modal-close')?.addEventListener('click', () => {
    document.getElementById('iconPickerOverlay').classList.remove('show');
});
document.getElementById('iconPickerOverlay')?.addEventListener('click', (e) => {
    if (e.target === document.getElementById('iconPickerOverlay')) {
        document.getElementById('iconPickerOverlay').classList.remove('show');
    }
});

// 分类切换
document.querySelectorAll('.category-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.category-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        renderIconGrid(btn.dataset.category);
    });
});

// 渲染图标网格
function renderIconGrid(category) {
    const grid = document.getElementById('iconGrid');
    const icons = iconCategories[category] || [];
    
    grid.innerHTML = icons.map(icon => `
        <div class="icon-item" data-icon="${icon}">
            ${icon}
        </div>
    `).join('');
    
    // 绑定点击事件
    grid.querySelectorAll('.icon-item').forEach(item => {
        item.addEventListener('click', () => {
            if (currentIconTarget) {
                const input = document.getElementById(currentIconTarget);
                if (input) {
                    input.value = item.dataset.icon;
                }
            }
            document.getElementById('iconPickerOverlay').classList.remove('show');
        });
    });
}

// ==================== 认证（离线兼容） ====================
let isSignUp = false;

function updateUserUI() {
    if (currentUser) {
        const email = currentUser.email || '';
        const prefix = email.split('@')[0] || '';
        const initial = email.charAt(0).toUpperCase();
        if (syncStatus) syncStatus.textContent = '已同步';
        updateSyncIndicator('online');
        
        // 更新设置面板里的同步状态
        const syncStatusText = document.getElementById('syncStatusText');
        const lastSyncTime = document.getElementById('qnav_last_sync');
        if (syncStatusText) {
            syncStatusText.textContent = '✅ 已登录 · ' + email + ' · 数据自动同步';
        }
        if (lastSyncTime) {
            const stored = localStorage.getItem('qnav_last_sync');
            if (stored) {
                try {
                    const d = new Date(stored);
                    lastSyncTime.textContent = d.toLocaleString('zh-CN');
                } catch(e) {
                    lastSyncTime.textContent = '刚刚';
                }
            } else {
                lastSyncTime.textContent = '从未';
            }
        }
        
        // 更新设置侧边栏底部的同步状态
        const settingsSync = document.getElementById('settingsSyncStatus');
        if (settingsSync) {
            settingsSync.textContent = '✅ 已登录 · ' + email + ' · 数据自动同步';
        }
        // 更新管理标签里的同步状态
        const adminSyncStatus = document.getElementById('adminSyncStatus');
        if (adminSyncStatus) {
            adminSyncStatus.textContent = '✅ 已登录 · ' + email + ' · 数据自动同步';
        }
        
        userArea.innerHTML = `
            <div class="user-menu" id="userMenu" style="position:relative;cursor:pointer;">
                <div class="user-avatar-small">${initial}</div>
                <span class="user-email-prefix">${esc(prefix)}</span>
                <div class="user-dropdown" id="userDropdown" style="display:none;position:absolute;top:100%;right:0;margin-top:8px;background:var(--bg-surface);border-radius:12px;box-shadow:0 10px 40px rgba(0,0,0,0.15);padding:8px 0;min-width:180px;z-index:1000;">
                    <div style="padding:12px 16px;font-size:0.85rem;color:var(--text-secondary);border-bottom:1px solid var(--border);">
                        <div style="font-weight:600;color:var(--text-primary);">${esc(email)}</div>
                        <div style="margin-top:4px;">已登录</div>
                    </div>
                    <div class="dropdown-item" id="logoutBtn" style="padding:10px 16px;cursor:pointer;transition:0.2s;display:flex;align-items:center;gap:8px;">
                        🚪 退出登录
                    </div>
                </div>
            </div>
        `;
        
        const menu = document.getElementById('userMenu');
        const dropdown = document.getElementById('userDropdown');
        const logoutBtn = document.getElementById('logoutBtn');
        
        menu.addEventListener('click', (e) => {
            e.stopPropagation();
            dropdown.style.display = dropdown.style.display === 'block' ? 'none' : 'block';
        });
        
        logoutBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            handleLogout();
        });
        
        // 点击其他地方关闭
        document.addEventListener('click', closeDropdown);
        function closeDropdown(e) {
            if (!menu.contains(e.target)) {
                dropdown.style.display = 'none';
            }
        }
    } else {
        if (syncStatus) syncStatus.textContent = '未登录';
        updateSyncIndicator('offline');
        
        // 更新设置面板里的同步状态
        const syncStatusText = document.getElementById('syncStatusText');
        const lastSyncTime = document.getElementById('qnav_last_sync');
        if (syncStatusText) {
            syncStatusText.textContent = '☁️ 未登录 · 数据仅保存在本地';
        }
        if (lastSyncTime) {
            lastSyncTime.textContent = '从未';
        }
        
        // 更新设置侧边栏底部的同步状态
        const settingsSync = document.getElementById('settingsSyncStatus');
        if (settingsSync) {
            settingsSync.textContent = '☁️ 未登录 · 数据仅保存在本地';
        }
        // 更新管理标签里的同步状态
        const adminSyncStatus = document.getElementById('adminSyncStatus');
        if (adminSyncStatus) {
            adminSyncStatus.textContent = '☁️ 未登录 · 数据仅保存在本地';
        }
        
        userArea.innerHTML = '<button class="login-btn" id="loginBtn">登录</button>';
        document.getElementById('loginBtn').addEventListener('click', () => {
            if (!isCloudReady) {
                const diag = getConfigDiagnostics();
                const diagText = Object.entries(diag).map(([k, v]) => `${k}: ${v}`).join('\n');
                error('[loginBtn] Supabase 未配置，诊断信息:\n' + diagText);
                let hint = '云端同步未配置。';
                if (!diag.Supabase库是否加载) {
                    hint += ' Supabase 库未加载（可能是网络问题或 CDN 被屏蔽）。';
                } else if (!diag.URL已设置 || !diag.ANON_KEY已设置) {
                    if (diag.配置来源.includes('Cloudflare')) {
                        hint += ' Cloudflare Pages 环境变量未正确设置。请在 Cloudflare 控制台检查 SUPABASE_URL 和 SUPABASE_ANON_KEY。';
                    } else if (diag.配置来源.includes('config.js')) {
                        hint += ' config.js 中的配置为空或无效。请编辑 config.js 填写实际的 Supabase 信息。';
                    } else {
                        hint += ' 未找到任何配置。请在 Cloudflare Pages 设置环境变量，或在本地编辑 config.js。';
                    }
                } else if (!diag.配置是否有效) {
                    hint += ' 检测到示例/占位符 URL，未替换为真实配置。';
                }
                hint += ' 目前将以离线模式使用。';
                showToast(hint, 'warning', 8000);
                return;
            }
            showAuth(false);
        });
    }
}

async function handleLogout() {
    const confirmed = await showConfirmDialog('', '退出登录', '确定要退出登录吗？<br>本地数据将保留在浏览器中，下次登录时可选择合并到云端。');
    if (!confirmed) return;
    
    // 退出前先确保数据同步到云端
    if (isCloudReady && currentUser && !isSyncing) {
        await threeWayMergeSync();
    }
    if (isCloudReady && supabaseClient) {
        await safeSupabaseCall(supabaseClient.auth.signOut());
    }
    currentUser = null;
    
    // 清空编辑密码（重置功能）
    if (editPassword) {
        editPassword = null;
        editPasswordVerified = false;
        saveSettings();
        showToast('编辑密码已重置', 'info');
    }
    
    // 退出编辑模式
    if (isEditing) {
        isEditing = false;
        document.body.classList.remove('editing');
        document.querySelector('.topbar').classList.remove('editing');
        const editBtn = document.getElementById('editModeToggle');
        editBtn.textContent = '✏️';
        editBtn.title = '编辑模式';
        document.querySelectorAll('.bookmark-card').forEach(card => card.classList.remove('editing'));
    }
    
    updateUserUI();
    loadLocalData();
    renderAll();
    showToast('已退出登录，切换到离线模式', 'info');
}

function showAuth(mode) {
    isSignUp = mode;
    authModal.classList.add('show');
    document.getElementById('authTitle').textContent = mode ? '注册' : '登录';
    document.getElementById('submitAuth').textContent = mode ? '注册' : '登录';
    document.getElementById('switchAuthMode').textContent = mode ? '切换到登录' : '切换到注册';
    document.getElementById('authEmail').value = '';
    document.getElementById('authPassword').value = '';
    document.getElementById('authConfirmPassword').value = '';
    document.getElementById('authError').style.display = 'none';
    document.getElementById('authPasswordGroup').style.display = '';
    document.getElementById('switchAuthMode').style.display = '';
    document.getElementById('submitAuth').style.display = '';
    document.getElementById('forgotPasswordBtn').textContent = '忘记密码';
    document.getElementById('backToLoginBtn').style.display = 'none';
    // 显示/隐藏确认密码
    document.getElementById('authConfirmPasswordGroup').style.display = mode ? '' : 'none';
    // 显示/隐藏记住密码
    document.getElementById('rememberPasswordGroup').style.display = mode ? 'none' : '';
    document.getElementById('forgotPasswordBtn').style.display = mode ? 'none' : 'inline-block';
    
    // 加载历史邮箱
    loadEmailHistory();
    
    // 如果是登录模式，尝试自动填充记住的密码
    if (!mode) {
        const rememberedEmail = localStorage.getItem('qnav_remembered_email');
        const rememberedPassword = localStorage.getItem('qnav_remembered_password');
        const rememberChecked = localStorage.getItem('qnav_remember_password') === 'true';
        
        if (rememberedEmail && rememberedPassword && rememberChecked) {
            document.getElementById('authEmail').value = rememberedEmail;
            document.getElementById('authPassword').value = rememberedPassword;
            document.getElementById('rememberPassword').checked = true;
        }
    }
}

document.getElementById('switchAuthMode').addEventListener('click', () => showAuth(!isSignUp));

document.getElementById('submitAuth').addEventListener('click', async () => {
    if (!isCloudReady) {
        showToast('云端服务未就绪', 'error');
        return;
    }
    const email = document.getElementById('authEmail').value.trim();
    const password = document.getElementById('authPassword').value;
    const errorEl = document.getElementById('authError');
    errorEl.style.display = 'none';

    if (!email) { errorEl.textContent = '请输入邮箱'; errorEl.style.display = 'block'; return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { errorEl.textContent = '邮箱格式不正确'; errorEl.style.display = 'block'; return; }
    if (!password) { errorEl.textContent = '请输入密码'; errorEl.style.display = 'block'; return; }
    if (password.length < 6) { errorEl.textContent = '密码至少需要6位'; errorEl.style.display = 'block'; return; }
    
    // 注册时验证确认密码
    if (isSignUp) {
        const confirmPassword = document.getElementById('authConfirmPassword').value;
        if (!confirmPassword) { errorEl.textContent = '请确认密码'; errorEl.style.display = 'block'; return; }
        if (password !== confirmPassword) { errorEl.textContent = '两次输入的密码不一致'; errorEl.style.display = 'block'; return; }
    }

    try {
        if (isSignUp) {
            const { data: authData, error } = await supabaseClient.auth.signUp({ email, password });
            if (error) throw error;
            if (authData.user && authData.session) {
                currentUser = authData.user;
                updateUserUI();
                authModal.classList.remove('show');
                // 保存邮箱到历史记录
                saveEmailToHistory(email);
                const result = await ensureTables();
                if (result.ok) {
                    await threeWayMergeSync();
                    await loadCloudData();
                }
                renderAll();
                showToast('注册成功，已自动登录！', 'success');
            } else {
                showToast('注册成功！请检查邮箱确认（如开启了邮箱验证），或直接登录。', 'success', 5000);
                authModal.classList.remove('show');
            }
        } else {
            const { data: authData, error } = await supabaseClient.auth.signInWithPassword({ email, password });
            if (error) throw error;
            currentUser = authData.user;
            updateUserUI();
            authModal.classList.remove('show');
            // 保存邮箱到历史记录
            saveEmailToHistory(email);
            
            // 处理记住密码
            const rememberPassword = document.getElementById('rememberPassword').checked;
            if (rememberPassword) {
                localStorage.setItem('qnav_remembered_email', email);
                localStorage.setItem('qnav_remembered_password', password);
                localStorage.setItem('qnav_remember_password', 'true');
            } else {
                localStorage.removeItem('qnav_remembered_email');
                localStorage.removeItem('qnav_remembered_password');
                localStorage.setItem('qnav_remember_password', 'false');
            }
            const result = await ensureTables();
            if (result.ok) {
                // 检测本地和云端数据
                const localBookmarkCount = allBookmarks.length || 0;
                
                // 获取云端数据量
                const cloudRes = await safeSupabaseCall(
                    supabaseClient.from('bookmarks').select('id', { count: 'exact', head: true })
                        .eq('user_id', currentUser.id)
                        .eq('deleted', false)
                );
                const cloudBookmarkCount = cloudRes?.count || 0;
                
                log('[login] 本地数据:', localBookmarkCount, '条，云端数据:', cloudBookmarkCount, '条');
                
                // 如果本地有数据，云端也有数据，询问用户
                if (localBookmarkCount > 0 && cloudBookmarkCount > 0) {
                    const strategy = await showDataMergeModal(localBookmarkCount, cloudBookmarkCount);
                    
                    if (!strategy) {
                        // 用户取消，退出登录
                        await handleLogout();
                        return;
                    }
                    
                    // 根据用户选择执行不同策略
                    if (strategy === 'use-cloud') {
                        await loadCloudDataOnly();
                    } else if (strategy === 'merge') {
                        await mergeLocalToCloud();
                    } else if (strategy === 'use-local') {
                        await overwriteCloudWithLocal();
                    }
                } else if (cloudBookmarkCount > 0) {
                    // 只有云端有数据，直接加载
                    await loadCloudData();
                } else {
                    // 云端没有数据，加载本地数据并同步到云端
                    loadLocalData();
                    if (localBookmarkCount > 0) {
                        await threeWayMergeSync();
                    }
                }
            }
            renderAll();
            showToast('登录成功！', 'success');
        }
    } catch (error) {
        error('登录错误详情:', error);
        let msg = error.message || '认证失败，请重试';
        
        // 映射常见错误到中文
        if (msg.includes('Invalid login credentials') || 
            msg.includes('Invalid email or password') || 
            msg.includes('invalid_grant')) {
            msg = '❌ 邮箱或密码错误，请检查后重试';
        } else if (msg.includes('Email not confirmed')) {
            msg = '📧 邮箱尚未验证，请先检查邮箱完成验证';
        } else if (msg.includes('User not found')) {
            msg = '👤 该邮箱未注册，请先注册';
        } else if (msg.includes('Email rate limit exceeded')) {
            msg = '⏱️ 发送过于频繁，请稍后再试';
        } else if (msg.includes('Failed to fetch') || msg.includes('fetch')) {
            errorEl.textContent = '无法连接服务器，请检查：\n1. Supabase 项目是否已创建\n2. URL 和 Anon Key 是否正确\n3. 网络是否正常';
            errorEl.style.whiteSpace = 'pre-line';
            showSetupModal();
            errorEl.style.display = 'block';
            return;
        } else if (msg.includes('Database error')) {
            msg = '🗄️ 数据库错误，请稍后再试';
        } else if (msg.includes('Too many requests')) {
            msg = '🚫 请求次数过多，请稍后再试';
        }
        
        errorEl.textContent = msg;
        errorEl.style.display = 'block';
    }
});

// 忘记密码按钮
document.getElementById('forgotPasswordBtn')?.addEventListener('click', async () => {
    const email = document.getElementById('authEmail').value.trim();
    const errorEl = document.getElementById('authError');
    const isForgotPasswordMode = document.getElementById('authTitle').textContent === '重置密码';
    
    if (isForgotPasswordMode) {
        // 如果已经是重置密码模式，直接发送重置邮件
        if (!email) {
            errorEl.textContent = '请先输入邮箱';
            errorEl.style.display = 'block';
            return;
        }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            errorEl.textContent = '邮箱格式不正确';
            errorEl.style.display = 'block';
            return;
        }
        
        if (!isCloudReady) {
            showToast('云端服务未就绪', 'error');
            return;
        }
        
        try {
            const { error } = await supabaseClient.auth.resetPasswordForEmail(email, {
                redirectTo: window.location.origin
            });
            if (error) throw error;
            showToast('密码重置链接已发送到您的邮箱！请查收后点击链接重置密码。', 'success', 6000);
            authModal.classList.remove('show');
        } catch (error) {
            errorEl.textContent = error.message || '发送失败，请重试';
            errorEl.style.display = 'block';
        }
    } else {
        // 切换到重置密码模式，调整界面
        document.getElementById('authTitle').textContent = '重置密码';
        document.getElementById('authPasswordGroup').style.display = 'none';
        document.getElementById('authConfirmPasswordGroup').style.display = 'none';
        document.getElementById('rememberPasswordGroup').style.display = 'none';
        document.getElementById('switchAuthMode').style.display = 'none';
        document.getElementById('forgotPasswordBtn').textContent = '发送重置链接';
        document.getElementById('submitAuth').style.display = 'none';
        document.getElementById('backToLoginBtn').style.display = 'inline-block';
        errorEl.style.display = 'none';
    }
});

// 返回登录按钮
document.getElementById('backToLoginBtn')?.addEventListener('click', () => {
    showAuth(false);
});

authModal.addEventListener('click', (e) => {
    if (e.target === authModal) {
        authModal.classList.remove('show');
        // 短暂延迟后重置，确保动画完成
        setTimeout(() => {
            document.getElementById('authTitle').textContent = '登录';
            document.getElementById('submitAuth').textContent = '登录';
            document.getElementById('switchAuthMode').textContent = '切换到注册';
            document.getElementById('authPasswordGroup').style.display = '';
            document.getElementById('switchAuthMode').style.display = '';
            document.getElementById('submitAuth').style.display = '';
            document.getElementById('forgotPasswordBtn').textContent = '忘记密码';
            document.getElementById('backToLoginBtn').style.display = 'none';
            document.getElementById('authConfirmPasswordGroup').style.display = 'none';
            document.getElementById('rememberPasswordGroup').style.display = '';
            document.getElementById('authError').style.display = 'none';
        }, 300);
    }
});

// ==================== 数据合并对话框 ====================
let pendingMergeData = null;

function showDataMergeModal(localCount, cloudCount) {
    return new Promise((resolve) => {
        pendingMergeData = { localCount, cloudCount, resolve };
        
        document.getElementById('localDataCount').textContent = localCount;
        document.getElementById('cloudDataCount').textContent = cloudCount;
        
        // 默认选中推荐选项
        document.querySelector('input[name="mergeStrategy"][value="use-cloud"]').checked = true;
        
        document.getElementById('dataMergeModal').classList.add('show');
    });
}

function closeDataMergeModal() {
    document.getElementById('dataMergeModal').classList.remove('show');
    if (pendingMergeData) {
        pendingMergeData.resolve(null); // 用户取消
        pendingMergeData = null;
    }
}

function confirmMergeStrategy() {
    const selected = document.querySelector('input[name="mergeStrategy"]:checked');
    if (!selected) return;
    
    const strategy = selected.value;
    
    // 如果选择覆盖，需要二次确认
    if (strategy === 'use-local') {
        showConfirmDialog('⚠️', '危险操作', '这将删除云端所有数据，用本地数据替换。确定要继续吗？')
            .then(confirmed => {
                if (confirmed && pendingMergeData) {
                    pendingMergeData.resolve(strategy);
                    closeDataMergeModal();
                }
            });
    } else {
        if (pendingMergeData) {
            pendingMergeData.resolve(strategy);
            closeDataMergeModal();
        }
    }
}

// 点击遮罩关闭
const dataMergeModal = document.getElementById('dataMergeModal');
if (dataMergeModal) {
    dataMergeModal.addEventListener('click', (e) => {
        if (e.target === dataMergeModal) {
            closeDataMergeModal();
        }
    });
}

// ==================== 自定义确认对话框 ====================
function showConfirmDialog(icon, title, message) {
    return new Promise((resolve) => {
        const overlay = document.getElementById('confirmDialogOverlay');
        const iconEl = document.getElementById('confirmDialogIcon');
        const titleEl = document.getElementById('confirmDialogTitle');
        const messageEl = document.getElementById('confirmDialogMessage');
        const cancelBtn = document.getElementById('confirmDialogCancel');
        const confirmBtn = document.getElementById('confirmDialogConfirm');
        
        iconEl.textContent = icon;
        titleEl.textContent = title;
        messageEl.innerHTML = message;
        overlay.classList.add('show');
        
        const cleanup = () => {
            overlay.classList.remove('show');
            cancelBtn.removeEventListener('click', onCancel);
            confirmBtn.removeEventListener('click', onConfirm);
        };
        
        const onCancel = () => { cleanup(); resolve(false); };
        const onConfirm = () => { cleanup(); resolve(true); };
        
        cancelBtn.addEventListener('click', onCancel);
        confirmBtn.addEventListener('click', onConfirm);
    });
}

// ==================== 历史邮箱功能 ====================
function loadEmailHistory() {
    try {
        const history = JSON.parse(localStorage.getItem('qnav_email_history') || '[]');
        const historyList = document.getElementById('emailHistoryList');
        const historyItems = document.getElementById('emailHistoryItems');
        
        if (history.length === 0) {
            historyList.style.display = 'none';
            return;
        }
        
        historyList.style.display = 'block';
        historyItems.innerHTML = history.map(email => {
            const prefix = email.split('@')[0];
            return `<button type="button" class="email-history-item" data-email="${email}" style="padding:6px 12px;background:var(--bg-hover);border:1px solid var(--border);border-radius:8px;font-size:0.8rem;color:var(--text-secondary);cursor:pointer;transition:0.2s;">${prefix}@...</button>`;
        }).join('');
        
        // 绑定点击事件
        document.querySelectorAll('.email-history-item').forEach(btn => {
            btn.addEventListener('click', () => {
                document.getElementById('authEmail').value = btn.dataset.email;
            });
            btn.addEventListener('mouseenter', () => {
                btn.style.background = 'var(--accent)';
                btn.style.color = '#fff';
                btn.style.borderColor = 'var(--accent)';
            });
            btn.addEventListener('mouseleave', () => {
                btn.style.background = 'var(--bg-hover)';
                btn.style.color = 'var(--text-secondary)';
                btn.style.borderColor = 'var(--border)';
            });
        });
    } catch (e) {
        error('加载历史邮箱失败', e);
    }
}

function saveEmailToHistory(email) {
    try {
        let history = JSON.parse(localStorage.getItem('qnav_email_history') || '[]');
        // 移除已存在的邮箱
        history = history.filter(e => e !== email);
        // 添加到最前面
        history.unshift(email);
        // 最多保存5个
        history = history.slice(0, 5);
        localStorage.setItem('qnav_email_history', JSON.stringify(history));
    } catch (e) {
        error('保存历史邮箱失败', e);
    }
}

document.getElementById('clearEmailHistoryBtn')?.addEventListener('click', async () => {
    const confirmed = await showConfirmDialog('🗑️', '清除历史记录', '确定清除历史登录账号吗？');
    if (!confirmed) return;
    
    localStorage.removeItem('qnav_email_history');
    loadEmailHistory();
    showToast('已清除历史记录', 'success');
});

function getEngineIconHTML(value) {
    switch (value) {
        case 'baidu':
            return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2zm-1.5 15c-.8 0-1.5-.7-1.5-1.5v-3c0-.8.7-1.5 1.5-1.5h3c.8 0 1.5.7 1.5 1.5v3c0 .8-.7 1.5-1.5 1.5h-3zm0-6c-.8 0-1.5-.7-1.5-1.5v-3c0-.8.7-1.5 1.5-1.5h3c.8 0 1.5.7 1.5 1.5v3c0 .8-.7 1.5-1.5 1.5h-3z" fill="#23B8E8"/></svg>';
        case 'bing':
            return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M7 5v14l6-3.5V8.5L7 5zm6 3.5v7l6 3.5V8.5L13 8.5z" fill="#0089D6"/></svg>';
        case 'toutiao':
            return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M4 7h16v2H4V7zm0 4h16v2H4v-2zm0 4h10v2H4v-2z" fill="#F85959"/></svg>';
        case 'quark':
            return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" fill="#7C5CFC"/></svg>';
        case 'weixin':
            return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M2 12c0-5 4.5-9 10-9s10 4 10 9-4.5 9-10 9c-1.2 0-2.3-.2-3.3-.6l-3 1 .8-2.5C3.5 16.5 2 14.5 2 12z" fill="#07C160"/><circle cx="8" cy="10" r="1.5" fill="#fff"/><circle cx="14" cy="10" r="1.5" fill="#fff"/></svg>';
        default:
            return '';
    }
}

function getEngineName(value) {
    const names = {
        baidu: '百度',
        bing: '必应',
        toutiao: '头条搜索',
        quark: '夸克搜索',
        weixin: '微信搜一搜'
    };
    return names[value] || '';
}

function generateSearchOptionsHTML() {
    const engines = ['local', 'baidu', 'bing', 'toutiao', 'quark', 'weixin'];
    return engines.map(value => {
        if (value === 'local') {
            return '<div class="search-option" data-value="local">🔍 本站</div>';
        }
        const icon = getEngineIconHTML(value);
        const name = getEngineName(value);
        return `<div class="search-option" data-value="${value}">${icon.replace('<svg ', '<svg class="engine-icon" ')} ${name}</div>`;
    }).join('');
}

// ==================== 设置面板 ====================
document.getElementById('settingsBtn').addEventListener('click', () => {
    // 检查是否需要密码验证
    if (editPassword && !isEditing) {
        // 显示提示文字
        const hint = document.getElementById('settingsLockedHint');
        hint.style.display = 'block';
        // 3秒后自动隐藏
        setTimeout(() => {
            hint.style.display = 'none';
        }, 3000);
        return;
    }

    // 正常打开设置面板
    // applyDensity(currentDensity); // 由新主题系统管理
    // applyCardStyle(currentCardStyle); // 已废弃，使用布局系统
    defaultSearchEngine.value = currentSearchEngine;
    // 更新默认搜索引擎显示
    const engineIcon = document.getElementById('defaultEngineIcon');
    const engineName = document.getElementById('defaultEngineName');
    engineIcon.innerHTML = getEngineIconHTML(currentSearchEngine);
    engineName.textContent = getEngineName(currentSearchEngine);
    renderThemeGrid();
    
    const settingsSync = document.getElementById('settingsSyncStatus');
    const syncStatusText = document.getElementById('syncStatusText');
    const adminSyncStatus = document.getElementById('adminSyncStatus');
    const lastSyncTime = document.getElementById('qnav_last_sync');
    if (currentUser) {
        const syncText = '✅ 已登录 · ' + currentUser.email + ' · 数据自动同步';
        settingsSync.textContent = syncText;
        if (syncStatusText) {
            syncStatusText.textContent = syncText;
        }
        if (adminSyncStatus) {
            adminSyncStatus.textContent = syncText;
        }
        if (lastSyncTime) {
            const stored = localStorage.getItem('qnav_last_sync');
            if (stored) {
                try {
                    const d = new Date(stored);
                    lastSyncTime.textContent = d.toLocaleString('zh-CN');
                } catch(e) {
                    lastSyncTime.textContent = '刚刚';
                }
            } else {
                lastSyncTime.textContent = '从未';
            }
        }
    } else {
        const syncText = '☁️ 未登录 · 数据仅保存在本地';
        settingsSync.textContent = syncText;
        if (syncStatusText) {
            syncStatusText.textContent = syncText;
        }
        if (adminSyncStatus) {
            adminSyncStatus.textContent = syncText;
        }
        if (lastSyncTime) {
            lastSyncTime.textContent = '从未';
        }
    }
    
    // 显示/隐藏管理员入口
    const adminSection = document.getElementById('adminSection');
    const adminNavItem = document.getElementById('adminNavItem');
    if (adminSection) {
        adminSection.style.display = isAdmin() ? 'block' : 'none';
    }
    if (adminNavItem) {
        adminNavItem.style.display = isAdmin() ? 'flex' : 'none';
    }
    
    // 清空密码输入框
    document.getElementById('editPasswordInput').value = '';
    document.getElementById('editPasswordConfirmInput').value = '';
    document.getElementById('editPasswordInput').type = 'password';
    document.getElementById('editPasswordConfirmInput').type = 'password';
    showEditPasswordInput = false;
    showEditPasswordConfirmInput = false;
    document.getElementById('toggleEditPasswordInput').textContent = '👁';
    document.getElementById('toggleEditPasswordConfirmInput').textContent = '👁';
    
    // 检测备份数据
    checkBackupData();
    
    // 先显示面板
    settingsOverlay.classList.add('show');
    
    // 面板显示后统一更新所有壁纸输入框
    requestAnimationFrame(() => {
        updateAllWallpaperInputs();
        renderWallpaperHistory();
    });
});

// 壁纸URL输入框事件
document.getElementById('wallpaperUrlInput')?.addEventListener('change', (e) => {
    const url = e.target.value.trim();
    if (url) {
        addWallpaperToHistory(url);
    }
    currentWallpaper = url;
    applyWallpaper(url);
    saveSettings(); // 保存设置
    showToast('壁纸已更新', 'success');
    // 同步更新所有壁纸输入框
    updateAllWallpaperInputs();
    renderWallpaperHistory();
});

// 壁纸输入框粘贴/清除按钮功能
const wallpaperInput = document.getElementById('wallpaperUrlInput');
const wallpaperActionBtn = document.getElementById('wallpaperActionBtn');

// 统一的壁纸状态管理
function updateAllWallpaperInputs() {
    const wallpaper = currentWallpaper || '';
    
    // 更新设置面板中的壁纸输入框
    const settingsInput = document.getElementById('wallpaperUrlInput');
    const settingsBtn = document.getElementById('wallpaperActionBtn');
    if (settingsInput) {
        settingsInput.value = wallpaper;
    }
    if (settingsInput && settingsBtn) {
        const hasValue = wallpaper.trim().length > 0;
        if (hasValue) {
            settingsBtn.textContent = '清除';
            settingsBtn.className = 'btn btn-sm btn-ghost';
        } else {
            settingsBtn.textContent = '粘贴';
            settingsBtn.className = 'btn btn-sm btn-primary';
        }
    }
    
    // 更新快速设置面板中的壁纸输入框
    const quickInput = document.getElementById('quickWallpaperInput');
    const quickPasteBtn = document.getElementById('quickWallpaperPasteBtn');
    const quickClearBtn = document.getElementById('quickWallpaperClearBtn');
    if (quickInput) {
        quickInput.value = wallpaper;
    }
    if (quickInput && quickPasteBtn && quickClearBtn) {
        const hasValue = wallpaper.trim().length > 0;
        quickPasteBtn.style.display = hasValue ? 'none' : 'block';
        quickClearBtn.style.display = hasValue ? 'block' : 'none';
    }
}

// 同步壁纸到快速设置面板（保留兼容）
function syncWallpaperToQuickSettings(url) {
    currentWallpaper = url;
    updateAllWallpaperInputs();
}

// 同步壁纸到设置面板（保留兼容）
function syncWallpaperToSettings(url) {
    currentWallpaper = url;
    updateAllWallpaperInputs();
}

// ==================== 壁纸上传和历史管理 ====================
const wallpaperUploadBtn = document.getElementById('wallpaperUploadBtn');
const wallpaperFileInput = document.getElementById('wallpaperFileInput');
const wallpaperHistoryGrid = document.getElementById('wallpaperHistoryGrid');

// 历史壁纸存储
let wallpaperHistory = JSON.parse(localStorage.getItem('qnav_wallpaper_history') || '[]');

// 上传按钮点击事件
wallpaperUploadBtn?.addEventListener('click', () => {
    wallpaperFileInput?.click();
});

// 文件选择事件
wallpaperFileInput?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    
    try {
        showToast('正在上传壁纸...', 'info');
        
        let wallpaperUrl;
        
        // 尝试上传到 Supabase，如果失败则使用本地存储
        if (supabaseClient) {
            try {
                const fileName = `wallpaper_${Date.now()}_${file.name}`;
                const { data, error } = await supabaseClient
                    .storage
                    .from('wallpapers')
                    .upload(fileName, file, {
                        cacheControl: '3600',
                        upsert: false
                    });
                
                if (error) throw error;
                
                // 获取公开 URL
                const { data: { publicUrl } } = supabaseClient
                    .storage
                    .from('wallpapers')
                    .getPublicUrl(fileName);
                
                wallpaperUrl = publicUrl;
            } catch (err) {
                log('Supabase 上传失败，使用本地存储:', err);
                // 回退到本地 base64
                wallpaperUrl = await fileToBase64(file);
            }
        } else {
            // 本地存储
            wallpaperUrl = await fileToBase64(file);
        }
        
        // 添加到历史记录
        addWallpaperToHistory(wallpaperUrl);
        
        // 设置为当前壁纸
        currentWallpaper = wallpaperUrl;
        applyWallpaper(wallpaperUrl);
        saveSettings();
        updateAllWallpaperInputs();
        renderWallpaperHistory();
        
        showToast('壁纸上传成功！', 'success');
    } catch (error) {
        error('上传失败:', error);
        showToast('上传失败，请重试', 'error');
    }
    
    // 清空文件输入
    if (wallpaperFileInput) {
        wallpaperFileInput.value = '';
    }
});

// 文件转 base64
function fileToBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

// 添加壁纸到历史记录
function addWallpaperToHistory(url) {
    // 避免重复
    wallpaperHistory = wallpaperHistory.filter(w => w !== url);
    // 添加到开头
    wallpaperHistory.unshift(url);
    // 只保留最近 12 张
    if (wallpaperHistory.length > 12) {
        wallpaperHistory = wallpaperHistory.slice(0, 12);
    }
    localStorage.setItem('qnav_wallpaper_history', JSON.stringify(wallpaperHistory));
}

// 渲染历史壁纸
function renderWallpaperHistory() {
    if (!wallpaperHistoryGrid) return;
    
    wallpaperHistoryGrid.innerHTML = '';
    
    wallpaperHistory.forEach((url, index) => {
        const item = document.createElement('div');
        item.className = 'wallpaper-history-item';
        item.style.cssText = `
            aspect-ratio:16/9;
            background:url(${url}) center/cover no-repeat;
            border-radius:8px;
            cursor:pointer;
            border:2px solid transparent;
            transition:all 0.2s;
            position:relative;
            overflow:hidden;
        `;
        
        // 高亮当前壁纸
        if (url === currentWallpaper) {
            item.style.borderColor = 'var(--accent)';
            item.style.boxShadow = '0 0 0 2px var(--accent), 0 4px 12px rgba(0,0,0,0.15)';
        }
        
        // 点击设置壁纸
        item.addEventListener('click', () => {
            currentWallpaper = url;
            applyWallpaper(url);
            saveSettings();
            updateAllWallpaperInputs();
            renderWallpaperHistory();
            showToast('壁纸已更新', 'success');
        });
        
        // 删除按钮
        const deleteBtn = document.createElement('button');
        deleteBtn.innerHTML = '×';
        deleteBtn.style.cssText = `
            position:absolute;
            top:4px;
            right:4px;
            width:20px;
            height:20px;
            border-radius:50%;
            background:rgba(0,0,0,0.6);
            color:white;
            border:none;
            cursor:pointer;
            font-size:14px;
            line-height:1;
            display:flex;
            align-items:center;
            justify-content:center;
            opacity:0;
            transition:opacity 0.2s;
        `;
        deleteBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            deleteWallpaperFromHistory(index);
        });
        
        item.appendChild(deleteBtn);
        
        // hover 显示删除按钮
        item.addEventListener('mouseenter', () => {
            deleteBtn.style.opacity = '1';
        });
        item.addEventListener('mouseleave', () => {
            deleteBtn.style.opacity = '0';
        });
        
        wallpaperHistoryGrid.appendChild(item);
    });
}

// 从历史记录删除壁纸
function deleteWallpaperFromHistory(index) {
    wallpaperHistory.splice(index, 1);
    localStorage.setItem('qnav_wallpaper_history', JSON.stringify(wallpaperHistory));
    renderWallpaperHistory();
    showToast('已从历史记录移除', 'info');
}

if (wallpaperInput && wallpaperActionBtn) {
    // 更新按钮状态
    function updateWallpaperButton() {
        const hasValue = wallpaperInput.value.trim().length > 0;
        if (hasValue) {
            wallpaperActionBtn.textContent = '清除';
            wallpaperActionBtn.className = 'btn btn-sm btn-ghost';
        } else {
            wallpaperActionBtn.textContent = '粘贴';
            wallpaperActionBtn.className = 'btn btn-sm btn-primary';
        }
    }
    
    // 监听输入框变化
    wallpaperInput.addEventListener('input', updateWallpaperButton);
    
    // 初始化按钮状态
    updateWallpaperButton();
    
    // 按钮点击事件
    wallpaperActionBtn.addEventListener('click', async () => {
        const hasValue = wallpaperInput.value.trim().length > 0;
        
        if (hasValue) {
            // 清除
            currentWallpaper = '';
            wallpaperInput.value = '';
            applyWallpaper('');
            saveSettings();
            showToast('壁纸已清除', 'info');
        } else {
            // 粘贴
            try {
                const text = await navigator.clipboard.readText();
                if (text) {
                    currentWallpaper = text.trim();
                    wallpaperInput.value = text;
                    applyWallpaper(text.trim());
                    saveSettings();
                    showToast('壁纸已应用', 'success');
                }
            } catch (err) {
                showToast('无法读取剪贴板，请手动粘贴', 'error');
            }
        }
        
        // 统一更新所有壁纸输入框
        updateAllWallpaperInputs();
    });
}

// 主题下拉菜单中的快速壁纸功能
const quickWallpaperInput = document.getElementById('quickWallpaperInput');
const quickWallpaperPasteBtn = document.getElementById('quickWallpaperPasteBtn');
const quickWallpaperClearBtn = document.getElementById('quickWallpaperClearBtn');

if (quickWallpaperInput && quickWallpaperPasteBtn && quickWallpaperClearBtn) {
    // 更新按钮状态
    function updateQuickWallpaperButton() {
        const hasValue = quickWallpaperInput.value.trim().length > 0;
        quickWallpaperPasteBtn.style.display = hasValue ? 'none' : 'block';
        quickWallpaperClearBtn.style.display = hasValue ? 'block' : 'none';
    }
    
    // 监听输入框变化
    quickWallpaperInput.addEventListener('input', updateQuickWallpaperButton);
    
    // 初始化按钮状态
    updateQuickWallpaperButton();
    
    // 粘贴按钮点击事件
    quickWallpaperPasteBtn.addEventListener('click', async () => {
        try {
            const text = await navigator.clipboard.readText();
            if (text) {
                currentWallpaper = text.trim();
                quickWallpaperInput.value = currentWallpaper;
                applyWallpaper(currentWallpaper);
                saveSettings();
                showToast('壁纸已应用', 'success');
                // 统一更新所有壁纸输入框
                updateAllWallpaperInputs();
            }
        } catch (err) {
            showToast('无法读取剪贴板，请手动粘贴', 'error');
        }
    });
    
    // 清除按钮点击事件
    quickWallpaperClearBtn.addEventListener('click', () => {
        currentWallpaper = '';
        quickWallpaperInput.value = '';
        applyWallpaper('');
        saveSettings();
        showToast('壁纸已清除', 'info');
        // 统一更新所有壁纸输入框
        updateAllWallpaperInputs();
    });
    
    // 输入框回车应用壁纸
    quickWallpaperInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            const url = quickWallpaperInput.value.trim();
            if (url) {
                currentWallpaper = url;
                applyWallpaper(url);
                saveSettings();
                showToast('壁纸已应用', 'success');
                // 统一更新所有壁纸输入框
                updateAllWallpaperInputs();
            }
        }
    });
}

document.getElementById('closeSettingsBtn').addEventListener('click', () => settingsOverlay.classList.remove('show'));
settingsOverlay.addEventListener('click', (e) => {
    if (e.target === settingsOverlay) settingsOverlay.classList.remove('show');
});

// 设置面板分类切换
document.querySelectorAll('.settings-nav-item').forEach(item => {
    item.addEventListener('click', () => {
        // 移除所有active类
        document.querySelectorAll('.settings-nav-item').forEach(i => i.classList.remove('active'));
        document.querySelectorAll('.settings-section').forEach(s => s.classList.remove('active'));
        
        // 添加active类到当前项
        item.classList.add('active');
        const sectionId = item.dataset.section;
        const section = document.getElementById(`section-${sectionId}`);
        if (section) {
            section.classList.add('active');
        }
    });
});

document.getElementById('showSqlBtn').addEventListener('click', () => {
    settingsOverlay.classList.remove('show');
    showSetupModal();
});

document.getElementById('testConnectionBtn').addEventListener('click', async () => {
    if (!isCloudReady) {
        showToast('Supabase SDK 未加载或配置无效', 'error');
        return;
    }
    showToast('正在测试连接...', 'info');
    try {
        const { data, error } = await supabaseClient.auth.getSession();
        if (error) throw error;
        showToast('✅ Supabase 连接正常！', 'success');
        const settingsSync = document.getElementById('settingsSyncStatus');
        settingsSync.textContent = '✅ 连接正常 · ' + (currentUser ? currentUser.email : '未登录');
    } catch (e) {
        const msg = e.message || '';
        if (msg.includes('fetch') || msg.includes('Failed')) {
            showToast('❌ 无法连接 Supabase，请检查：\n1. 项目 URL 和 Anon Key 是否正确\n2. 项目是否已暂停或删除\n3. 网络是否正常', 'error', 6000);
        } else {
            showToast('❌ 连接异常：' + msg, 'error', 5000);
        }
    }
});

// ==================== 农历转换 ====================
function getLunarDate(date) {
    const lunarInfo = [
        0x04bd8, 0x04ae0, 0x0a570, 0x054d5, 0x0d260, 0x0d950, 0x16554, 0x056a0, 0x09ad0, 0x055d2,
        0x04ae0, 0x0a5b6, 0x0a4d0, 0x0d250, 0x1d255, 0x0b540, 0x0d6a0, 0x0ada2, 0x095b0, 0x14977,
        0x04970, 0x0a4b0, 0x0b4b5, 0x06a50, 0x06d40, 0x1ab54, 0x02b60, 0x09570, 0x052f2, 0x04970,
        0x06566, 0x0d4a0, 0x0ea50, 0x06e95, 0x05ad0, 0x02b60, 0x186e3, 0x092e0, 0x1c8d7, 0x0c950,
        0x0d4a0, 0x1d8a6, 0x0b550, 0x056a0, 0x1a5b4, 0x025d0, 0x092d0, 0x0d2b2, 0x0a950, 0x0b557,
        0x06ca0, 0x0b550, 0x15355, 0x04da0, 0x0a5d0, 0x14573, 0x052d0, 0x0a9a8, 0x0e950, 0x06aa0,
        0x0aea6, 0x0ab50, 0x04b60, 0x0aae4, 0x0a570, 0x05260, 0x0f263, 0x0d950, 0x05b57, 0x056a0,
        0x096d0, 0x04dd5, 0x04ad0, 0x0a4d0, 0x0d4d4, 0x0d250, 0x0d558, 0x0b540, 0x0b5a0, 0x195a6,
        0x095b0, 0x049b0, 0x0a974, 0x0a4b0, 0x0b27a, 0x06a50, 0x06d40, 0x0af46, 0x0ab60, 0x09570,
        0x04af5, 0x04970, 0x064b0, 0x074a3, 0x0ea50, 0x06b58, 0x055c0, 0x0ab60, 0x096d5, 0x092e0,
        0x0c960, 0x0d954, 0x0d4a0, 0x0da50, 0x07552, 0x056a0, 0x0abb7, 0x025d0, 0x092d0, 0x0cab5,
        0x0a950, 0x0b4a0, 0x0baa4, 0x0ad50, 0x055d9, 0x04ba0, 0x0a5b0, 0x15176, 0x052b0, 0x0a930,
        0x07954, 0x06aa0, 0x0ad50, 0x05b52, 0x04b60, 0x0a6e6, 0x0a4e0, 0x0d260, 0x0ea65, 0x0d530,
        0x05aa0, 0x076a3, 0x096d0, 0x04afb, 0x04ad0, 0x0a4d0, 0x1d0b6, 0x0d250, 0x0d520, 0x0dd45,
        0x0b5a0, 0x056d0, 0x055b2, 0x049b0, 0x0a577, 0x0a4b0, 0x0aa50, 0x1b255, 0x06d20, 0x0ada0
    ];
    const Gan = ["甲", "乙", "丙", "丁", "戊", "己", "庚", "辛", "壬", "癸"];
    const Zhi = ["子", "丑", "寅", "卯", "辰", "巳", "午", "未", "申", "酉", "戌", "亥"];
    const Animals = ["鼠", "牛", "虎", "兔", "龙", "蛇", "马", "羊", "猴", "鸡", "狗", "猪"];
    const lunarMonths = ["正", "二", "三", "四", "五", "六", "七", "八", "九", "十", "冬", "腊"];
    const lunarDays = ["初一", "初二", "初三", "初四", "初五", "初六", "初七", "初八", "初九", "初十",
        "十一", "十二", "十三", "十四", "十五", "十六", "十七", "十八", "十九", "二十",
        "廿一", "廿二", "廿三", "廿四", "廿五", "廿六", "廿七", "廿八", "廿九", "三十"];
    
    let baseDate = new Date(1900, 0, 31);
    let offset = Math.floor((date - baseDate) / 86400000);
    let i, leap = 0, temp = 0;
    let year = 1900;
    
    while (year < 2100 && offset > 0) {
        temp = lYearDays(year);
        offset -= temp;
        year++;
    }
    year--;
    offset += temp;
    
    leap = leapMonth(year);
    let isLeap = false;
    let month = 1;
    while (month < 13 && offset > 0) {
        if (leap > 0 && month === (leap + 1) && isLeap === false) {
            --month;
            isLeap = true;
            temp = leapDays(year);
        } else {
            temp = monthDays(year, month);
        }
        if (isLeap === true && month === (leap + 1)) isLeap = false;
        offset -= temp;
        month++;
    }
    month--;
    offset += temp;
    
    let day = offset + 1;
    
    return { year, month, day, isLeap };
    
    function lYearDays(y) {
        let sum = 348;
        for (let i = 0x8000; i > 0x8; i >>= 1) {
            sum += (lunarInfo[y - 1900] & i) ? 1 : 0;
        }
        return sum + leapDays(y);
    }
    function leapMonth(y) {
        return lunarInfo[y - 1900] & 0xf;
    }
    function leapDays(y) {
        if (leapMonth(y))
            return ((lunarInfo[y - 1900] & 0x10000) ? 30 : 29);
        else
            return 0;
    }
    function monthDays(y, m) {
        return ((lunarInfo[y - 1900] & (0x10000 >> m)) ? 30 : 29);
    }
}

function formatLunarDate(date) {
    const lunar = getLunarDate(date);
    const lunarMonths = ["正", "二", "三", "四", "五", "六", "七", "八", "九", "十", "冬", "腊"];
    const lunarDays = ["初一", "初二", "初三", "初四", "初五", "初六", "初七", "初八", "初九", "初十",
        "十一", "十二", "十三", "十四", "十五", "十六", "十七", "十八", "十九", "二十",
        "廿一", "廿二", "廿三", "廿四", "廿五", "廿六", "廿七", "廿八", "廿九", "三十"];
    return `农历${lunar.isLeap ? '闰' : ''}${lunarMonths[lunar.month - 1]}月${lunarDays[lunar.day - 1]}`;
}

// ==================== 其他基础交互 ====================
function updateTime() {
    const now = new Date();
    const t = now.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    const d = now.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
    const lunar = formatLunarDate(now);
    const dateWithLunar = `${d} · ${lunar}`;
    
    document.getElementById('homeTime').textContent = t;
    document.getElementById('heroTime').textContent = t;
    document.getElementById('homeDate').textContent = dateWithLunar;
    document.getElementById('heroDateLunar').textContent = dateWithLunar;
}
setInterval(updateTime, 1000);
updateTime();

function performSearch(q, engine) {
    if (!q) return;
    if (engine === 'local') {
        const results = allBookmarks.filter(b =>
            b.name.toLowerCase().includes(q.toLowerCase()) ||
            (b.url && b.url.toLowerCase().includes(q.toLowerCase()))
        );
        if (results.length > 0) {
            // 切换到收藏夹视图
            if (viewToggleBtn && typeof isHomeView !== 'undefined') {
                isHomeView = false;
                viewToggleBtn.textContent = '📁';
                viewToggleBtn.title = '收藏夹';
            }
            homeView.style.display = 'none';
            bookmarksView.style.display = 'flex';
            document.body.classList.add('page-bookmarks');
            // 更新侧边栏折叠按钮的显示状态
            if (typeof updateSidebarToggleBtn === 'function') {
                const sidebar = document.getElementById('sidebar');
                updateSidebarToggleBtn(sidebar.classList.contains('hidden'));
            }
            selectPath([]);
            currentPath = [];
            updateBreadcrumb();
            bookmarkGrid.innerHTML = '';
            results.forEach(bm => {
                const a = document.createElement('a');
                const themeName = document.documentElement.dataset.theme?.split('-')[0] || 'aurora';
                a.className = `bookmark-card theme-${themeName}`;
                a.href = bm.url;
                a.target = '_blank';
                const domain = getDomain(bm.url);
                a.innerHTML = `
                    <div class="card-favicon"><img src="https://www.google.com/s2/favicons?domain=${domain}&sz=24" referrerpolicy="no-referrer" onerror="this.outerHTML='<span style=font-size:1.2rem;>${bm.name.charAt(0)}</span>'"></div>
                    <div class="card-info"><div class="card-title">${esc(bm.name)}</div><div class="card-domain">${domain}</div></div>
                `;
                bookmarkGrid.appendChild(a);
            });
        } else {
            showToast('未找到匹配的书签', 'info');
        }
    } else {
        const base = { baidu: 'https://www.baidu.com/s?wd=', bing: 'https://cn.bing.com/search?q=', toutiao: 'https://so.toutiao.com/search?keyword=', quark: 'https://quark.sm.cn/s?q=', weixin: 'https://weixin.sogou.com/weixin?type=2&query=' };
        window.open(base[engine] + encodeURIComponent(q), '_blank');
    }
}

document.getElementById('homeSearchInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') performSearch(e.target.value.trim(), document.getElementById('homeSearchSelect').value);
});
document.getElementById('heroSearchInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') performSearch(e.target.value.trim(), document.getElementById('heroSearchSelect').value);
});

// ==================== 一体化搜索组件 ====================
function initSearchSelector() {
    // 初始化首页搜索选择器
    initSingleSearchSelector('home');
    // 初始化收藏夹页面搜索选择器
    initSingleSearchSelector('hero');
}

function initSingleSearchSelector(prefix) {
    const selector = document.getElementById(`${prefix}SearchSelector`);
    const selectorText = document.getElementById(`${prefix}SearchSelectorText`);
    const options = document.getElementById(`${prefix}SearchOptions`);
    const select = document.getElementById(`${prefix}SearchSelect`);
    const optionEls = options ? options.querySelectorAll('.search-option') : [];

    if (!selector || !selectorText || !options || !select) return;

    const getOptionHTML = (el) => {
        const icon = el.querySelector('.engine-icon');
        if (icon) return icon.outerHTML;
        return el.textContent.trim();
    };

    const updateSelectorText = () => {
        const selectedValue = select.value;
        const selectedOption = [...optionEls].find(el => el.dataset.value === selectedValue);
        if (selectedOption) {
            selectorText.innerHTML = getOptionHTML(selectedOption);
            optionEls.forEach(el => el.classList.toggle('selected', el.dataset.value === selectedValue));
        }
    };

    updateSelectorText();

    selector.addEventListener('click', (e) => {
        e.stopPropagation();
        selector.classList.toggle('active');
        options.style.display = options.style.display === 'none' ? 'block' : 'none';
    });

    optionEls.forEach(option => {
        option.addEventListener('click', (e) => {
            e.stopPropagation();
            const value = option.dataset.value;
            select.value = value;
            updateSelectorText();
            options.style.display = 'none';
            selector.classList.remove('active');
            const otherPrefix = prefix === 'home' ? 'hero' : 'home';
            const otherSelect = document.getElementById(`${otherPrefix}SearchSelect`);
            const otherSelectorText = document.getElementById(`${otherPrefix}SearchSelectorText`);
            const otherOptions = document.getElementById(`${otherPrefix}SearchOptions`);
            if (otherSelect) otherSelect.value = value;
            if (otherSelectorText && otherOptions) {
                const otherOptionEls = otherOptions.querySelectorAll('.search-option');
                const otherSelectedOption = [...otherOptionEls].find(el => el.dataset.value === value);
                if (otherSelectedOption) {
                    const otherIcon = otherSelectedOption.querySelector('.engine-icon');
                    otherSelectorText.innerHTML = otherIcon ? otherIcon.outerHTML : otherSelectedOption.textContent.trim();
                    otherOptionEls.forEach(el => el.classList.toggle('selected', el.dataset.value === value));
                }
            }
        });
    });

    // 点击其他地方关闭选项
    document.addEventListener('click', () => {
        options.style.display = 'none';
        selector.classList.remove('active');
    });
}

// ==================== 侧边栏拖拽 ====================
const sidebarEl = document.getElementById('sidebar');
const resizerEl = document.getElementById('resizer');
let isResizing = false, startX, startWidth;

// 初始化侧边栏宽度变量
document.addEventListener('DOMContentLoaded', () => {
    const initialWidth = sidebarEl.offsetWidth || 320;
    document.documentElement.style.setProperty('--sidebar-width', initialWidth + 'px');
    
    // 确保主题下拉菜单正确渲染
    setTimeout(() => {
        renderThemeDropdown();
    }, 100);
    
    // 初始化搜索引擎选项
    const searchOptionsHTML = generateSearchOptionsHTML();
    const homeSearchOptions = document.getElementById('homeSearchOptions');
    const heroSearchOptions = document.getElementById('heroSearchOptions');
    if (homeSearchOptions) homeSearchOptions.innerHTML = searchOptionsHTML;
    if (heroSearchOptions) heroSearchOptions.innerHTML = searchOptionsHTML;
    
    // 注册 Service Worker (PWA)
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('./sw.js')
            .then((reg) => {
                log('[PWA] Service Worker 注册成功:', reg.scope);
            })
            .catch((err) => {
                log('[PWA] Service Worker 注册失败:', err);
            });
    }
    
    // 加载推荐壁纸
    renderFeaturedWallpapers();
});

resizerEl.addEventListener('mousedown', e => {
    isResizing = true; startX = e.clientX; startWidth = sidebarEl.offsetWidth;
    document.body.style.cursor = 'col-resize'; document.body.style.userSelect = 'none';
});
window.addEventListener('mousemove', e => {
    if (!isResizing) return;
    const w = Math.min(500, Math.max(300, startWidth + e.clientX - startX));
    document.documentElement.style.setProperty('--sidebar-width', w + 'px');
});
window.addEventListener('mouseup', () => { isResizing = false; document.body.style.cursor = ''; document.body.style.userSelect = ''; });

let isAllCollapsed = false;

// 切换全部文件夹展开/折叠（绑定到全部书签右侧的V形图标）
function toggleAllFolders() {
    const icon = document.getElementById('toggleAllIcon');
    const toggleBtn = document.getElementById('toggleAllFolders');
    isAllCollapsed = !isAllCollapsed;
    if (isAllCollapsed) {
        // 折叠全部
        document.querySelectorAll('.expandable').forEach(u => u.style.display = 'none');
        // 更新所有文件夹箭头为向右
        document.querySelectorAll('.tree-toggle').forEach(toggle => {
            toggle.dataset.collapsed = 'true';
            const svg = toggle.querySelector('svg');
            if (svg) {
                svg.innerHTML = '<polyline points="9 6 15 12 9 18">';
            }
            toggle.title = '展开';
        });
        // 更新V形图标为向右，提示文字变为"全部展开"
        if (icon) icon.setAttribute('points', '9 6 15 12 9 18');
        if (toggleBtn) toggleBtn.setAttribute('title', '全部展开');
    } else {
        // 展开全部
        document.querySelectorAll('.expandable').forEach(u => u.style.display = '');
        // 更新所有文件夹箭头为向下
        document.querySelectorAll('.tree-toggle').forEach(toggle => {
            toggle.dataset.collapsed = 'false';
            const svg = toggle.querySelector('svg');
            if (svg) {
                svg.innerHTML = '<polyline points="6 9 12 15 18 9">';
            }
            toggle.title = '折叠';
        });
        // 更新V形图标为向下，提示文字变为"全部收起"
        if (icon) icon.setAttribute('points', '6 9 12 15 18 9');
        if (toggleBtn) toggleBtn.setAttribute('title', '全部收起');
    }
}

// 侧边栏显示/隐藏功能（单一按钮，CSS 控制位置和图标）
const toggleSidebarBtn = document.getElementById('toggleSidebarBtn');
if (toggleSidebarBtn) {
    const sidebar = document.getElementById('sidebar');
    const headerButtons = document.querySelector('.sidebar-header > div:last-child');
    
    updateSidebarToggleBtn = (isHidden) => {
        toggleSidebarBtn.title = isHidden ? '展开侧边栏' : '隐藏侧边栏';
        // 确保 body 上有 sidebar-hidden 类
        if (isHidden) {
            document.body.classList.add('sidebar-hidden');
        } else {
            document.body.classList.remove('sidebar-hidden');
        }
        
        if (isHidden) {
            // 当侧边栏隐藏时，把按钮移动到body上
            if (toggleSidebarBtn.parentElement !== document.body) {
                document.body.appendChild(toggleSidebarBtn);
            }
            // 直接设置内联样式，确保按钮在正确的位置
            toggleSidebarBtn.style.position = 'fixed';
            toggleSidebarBtn.style.top = '96px';
            toggleSidebarBtn.style.left = '8px';
            toggleSidebarBtn.style.zIndex = '100';
            toggleSidebarBtn.style.width = '42px';
            toggleSidebarBtn.style.height = '42px';
            // 只在收藏夹视图时显示
            if (document.body.classList.contains('page-bookmarks')) {
                toggleSidebarBtn.style.display = 'flex';
            } else {
                toggleSidebarBtn.style.display = 'none';
            }
        } else {
            // 当侧边栏显示时，把按钮放回sidebar-header
            if (headerButtons && toggleSidebarBtn.parentElement !== headerButtons) {
                headerButtons.appendChild(toggleSidebarBtn);
            }
            // 清除内联样式，让CSS控制
            toggleSidebarBtn.style.position = '';
            toggleSidebarBtn.style.top = '';
            toggleSidebarBtn.style.left = '';
            toggleSidebarBtn.style.zIndex = '';
            toggleSidebarBtn.style.width = '';
            toggleSidebarBtn.style.height = '';
            toggleSidebarBtn.style.display = '';
        }
    };
    
    updateSidebarToggleBtn(sidebar.classList.contains('hidden'));
    
    toggleSidebarBtn.addEventListener('click', () => {
        const isHidden = sidebar.classList.toggle('hidden');
        updateSidebarToggleBtn(isHidden);
    });
}

// ==================== 移动端汉堡菜单 ====================
document.getElementById('hamburgerBtn').addEventListener('click', () => {
    document.getElementById('sidebar').classList.toggle('open');
});
document.addEventListener('click', (e) => {
    const sidebar = document.getElementById('sidebar');
    if (sidebar.classList.contains('open') && window.innerWidth <= 768) {
        if (!sidebar.contains(e.target) && e.target.id !== 'hamburgerBtn' && !document.getElementById('hamburgerBtn').contains(e.target)) {
            sidebar.classList.remove('open');
        }
    }
});

// ==================== 管理员推广卡片 ====================
async function loadAdminCards() {
    if (!aiContainer) return;
    
    // 获取推荐应用样式设置
    const aiToolCardStyle = localStorage.getItem('qnav_ai_tool_card_style') || 'default';
    
    // 应用样式类
    aiContainer.className = 'ai-tools';
    if (aiToolCardStyle !== 'default') {
        aiContainer.classList.add(`style-${aiToolCardStyle}`);
    }
    
    let cards = null;
    if (isCloudReady) {
        const res = await safeSupabaseCall(supabaseClient.from('admin_cards').select('*').order('sort_order'));
        if (res && res.data && res.data.length) cards = res.data;
    }
    if (cards && cards.length > 0) {
        aiContainer.innerHTML = cards.map(c => `
            <a class="ai-tool-card" href="${c.url}" target="_blank" title="${esc(c.name)}">
                <div class="ai-tool-icon">
                    ${c.icon?.toLowerCase().startsWith('http') 
                        ? `<img src="${c.icon}" style="width:100%;height:100%;object-fit:contain;" onerror="this.outerHTML='🌐'">`
                        : (c.icon || '🌐')}
                </div>
                <span>${esc(c.name)}</span>
            </a>
        `).join('');
    } else {
        aiContainer.innerHTML = '';
    }
}

// ==================== 启动 ====================
window.addEventListener('load', async () => {
    initSupabaseClient();
    loadLocalData();
    loadSettings();
    
    // 初始化密码状态面板
    updatePasswordStatusPanel();

    applyWallpaper(currentWallpaper);
    // applyDensity(currentDensity); // 由新主题系统管理
    // applyCardStyle(currentCardStyle); // 已废弃，使用布局系统
    
    // 初始化卡片方案
    initCardStyle();
    
    // 初始化弹窗卡片方案切换事件
    initDropdownCardStyleEvents();
    
    // 绑定主题标签页下的收藏夹页卡片方案选择事件
    const themeCardStyleOptions = document.getElementById('cardStyleOptions');
    if (themeCardStyleOptions) {
        themeCardStyleOptions.addEventListener('click', (e) => {
            const option = e.target.closest('.card-style-option');
            if (option) {
                const style = option.dataset.style;
                applyCardStyle(style);
                showToast('✅ 收藏夹样式已更新', 'success');
            }
        });
    }
    
    loadAdminCards(); // 加载推荐应用并应用样式
    document.getElementById('homeSearchSelect').value = currentSearchEngine;
    document.getElementById('heroSearchSelect').value = currentSearchEngine;
    defaultSearchEngine.value = currentSearchEngine;

    // 初始化默认搜索引擎选择器
    const defaultEngineSelector = document.getElementById('defaultEngineSelector');
    const defaultEngineDisplay = document.getElementById('defaultEngineDisplay');
    const defaultEngineOptions = document.getElementById('defaultEngineOptions');
    const defaultEngineIcon = document.getElementById('defaultEngineIcon');
    const defaultEngineName = document.getElementById('defaultEngineName');

    // 点击显示/隐藏下拉菜单
    defaultEngineDisplay.addEventListener('click', (e) => {
        e.stopPropagation();
        const isOpen = defaultEngineOptions.style.display === 'block';
        defaultEngineOptions.style.display = isOpen ? 'none' : 'block';
        defaultEngineSelector.classList.toggle('active', !isOpen);
    });

    // 点击选项
    defaultEngineOptions.querySelectorAll('.engine-option').forEach(option => {
        option.addEventListener('click', (e) => {
            e.stopPropagation();
            const value = option.dataset.value;
            defaultSearchEngine.value = value;
            // 更新显示
            defaultEngineIcon.innerHTML = getEngineIconHTML(value);
            defaultEngineName.textContent = getEngineName(value);
            // 关闭下拉
            defaultEngineOptions.style.display = 'none';
            defaultEngineSelector.classList.remove('active');
            // 保存设置
            saveSettings();
            // 更新搜索框
            document.getElementById('homeSearchSelect').value = value;
            document.getElementById('heroSearchSelect').value = value;
            // 更新搜索框显示
            initSearchSelector();
            showToast('默认搜索引擎已更新', 'success');
        });
    });

    // 点击其他地方关闭下拉
    document.addEventListener('click', () => {
        defaultEngineOptions.style.display = 'none';
        defaultEngineSelector.classList.remove('active');
    });

    // 初始化一体化搜索组件
    initSearchSelector();

    renderAll();
    loadAdminCards();
    updateUserUI();

    // 检查是否是密码重置流程
    const urlParams = new URLSearchParams(window.location.hash.slice(1));
    const accessToken = urlParams.get('access_token');
    const type = urlParams.get('type');
    if (type === 'recovery' && accessToken && isCloudReady) {
        document.getElementById('resetPasswordOverlay').classList.add('show');
        // 清理 URL
        history.replaceState(null, '', window.location.pathname + window.location.search);
    }

    if (isCloudReady) {
        try {
            const { data: { session }, error } = await supabaseClient.auth.getSession();
            if (error) throw error;
            if (session) {
                currentUser = session.user;
                updateUserUI();
                const result = await ensureTables();
                if (result.ok) {
                    await loadCloudData();
                    renderAll();
                }
            }
        } catch (e) {
            warn('恢复会话失败', e);
            const msg = e.message || '';
            if (msg.includes('fetch') || msg.includes('Failed')) {
                showToast('⚠️ 无法连接 Supabase，将使用离线模式。请在设置中检查连接。', 'warning', 6000);
            }
        }
    }
});

// ==================== 重置密码功能 ====================
document.getElementById('confirmResetPasswordBtn').addEventListener('click', async () => {
    const password = document.getElementById('resetPasswordInput').value;
    const confirmPassword = document.getElementById('resetPasswordConfirmInput').value;
    const errorEl = document.getElementById('resetPasswordError');
    errorEl.style.display = 'none';

    if (!password) { errorEl.textContent = '请输入密码'; errorEl.style.display = 'block'; return; }
    if (password.length < 6) { errorEl.textContent = '密码至少需要6位'; errorEl.style.display = 'block'; return; }
    if (password !== confirmPassword) { errorEl.textContent = '两次输入的密码不一致'; errorEl.style.display = 'block'; return; }

    try {
        const { error } = await supabaseClient.auth.updateUser({ password });
        if (error) throw error;
        showToast('密码重置成功！', 'success');
        document.getElementById('resetPasswordOverlay').classList.remove('show');
        // 重新登录
        showAuth(false);
    } catch (error) {
        errorEl.textContent = error.message || '重置密码失败';
        errorEl.style.display = 'block';
    }
});

document.getElementById('cancelResetPasswordBtn').addEventListener('click', () => {
    document.getElementById('resetPasswordOverlay').classList.remove('show');
});
document.getElementById('resetPasswordOverlay').addEventListener('click', (e) => {
    if (e.target === document.getElementById('resetPasswordOverlay')) {
        document.getElementById('resetPasswordOverlay').classList.remove('show');
    }
});

// ==================== 外观标签切换功能 ====================
(function initAppearanceTabs() {
    const appearanceTabs = document.querySelectorAll('.appearance-tab');
    const themeContent = document.getElementById('appearance-theme-content');
    const cardStylesContent = document.getElementById('appearance-card-styles-content');
    const personalWallpaperContent = document.getElementById('appearance-personal-wallpaper-content');
    const featuredWallpapersContent = document.getElementById('appearance-featured-wallpapers-content');

    if (!appearanceTabs.length || !themeContent || !cardStylesContent || !personalWallpaperContent || !featuredWallpapersContent) return;

    appearanceTabs.forEach(tab => {
        tab.addEventListener('click', async () => {
            appearanceTabs.forEach(t => t.classList.remove('active'));
            tab.classList.add('active');

            // 隐藏所有内容
            themeContent.style.display = 'none';
            cardStylesContent.style.display = 'none';
            personalWallpaperContent.style.display = 'none';
            featuredWallpapersContent.style.display = 'none';

            // 显示对应的标签内容
            switch(tab.dataset.tab) {
                case 'qnav_theme':
                    themeContent.style.display = 'block';
                    break;
                case 'card-styles':
                    cardStylesContent.style.display = 'block';
                    break;
                case 'personal-wallpaper':
                    personalWallpaperContent.style.display = 'block';
                    updateCurrentWallpaperPreview();
                    renderWallpaperHistory();
                    break;
                case 'featured-wallpapers':
                    featuredWallpapersContent.style.display = 'block';
                    await renderFeaturedWallpapers();
                    break;
            }
        });
    });
    
    // 页面加载完成后尝试加载推荐壁纸
    setTimeout(async () => {
        await renderFeaturedWallpapers();
    }, 500);
})();

// ==================== 更新当前壁纸预览 ====================
function updateCurrentWallpaperPreview() {
    const previewContainer = document.getElementById('currentWallpaperPreview');
    if (!previewContainer) return;

    if (currentWallpaper) {
        previewContainer.innerHTML = `<img src="${currentWallpaper.replace(/'/g, "\\'")}" alt="当前壁纸" onerror="this.parentElement.innerHTML='<span style=\\'color:var(--text-muted);font-size:1.1rem;font-weight:600;\\'>壁纸加载失败</span>';">`;
    } else {
        previewContainer.innerHTML = `<span style="color:var(--text-muted);font-size:1.1rem;font-weight:600;">尚未设置壁纸</span>`;
    }
}

// ==================== 重写渲染历史壁纸函数（使用新样式） ====================
const originalRenderWallpaperHistory = window.renderWallpaperHistory;
window.renderWallpaperHistory = function() {
    const wallpaperHistoryGrid = document.getElementById('wallpaperHistoryGrid');
    if (!wallpaperHistoryGrid) return;

    wallpaperHistoryGrid.innerHTML = '';

    wallpaperHistory.forEach((url, index) => {
        const item = document.createElement('div');
        item.className = 'wallpaper-history-item';
        item.style.backgroundImage = `url(${url.replace(/'/g, "\\'")})`;

        // 高亮当前壁纸
        if (url === currentWallpaper) {
            item.style.borderColor = 'var(--accent)';
            item.style.boxShadow = '0 0 0 3px var(--accent), 0 6px 20px rgba(0, 0, 0, 0.2)';
        }

        // 点击设置壁纸
        item.addEventListener('click', (e) => {
            if (e.target.closest('.wallpaper-history-delete')) return;
            currentWallpaper = url;
            applyWallpaper(url);
            saveSettings();
            updateAllWallpaperInputs();
            updateCurrentWallpaperPreview();
            renderWallpaperHistory();
            showToast('壁纸已更新', 'success');
        });

        // 删除按钮
        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'wallpaper-history-delete';
        deleteBtn.innerHTML = '×';
        deleteBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            deleteWallpaperFromHistory(index);
        });

        item.appendChild(deleteBtn);
        wallpaperHistoryGrid.appendChild(item);
    });
};

// ==================== 绑定新的按钮事件 ====================
(function initWallpaperButtons() {
    // 上传按钮 2
    const uploadBtn2 = document.getElementById('wallpaperUploadBtn2');
    if (uploadBtn2) {
        uploadBtn2.addEventListener('click', () => {
            const fileInput = document.getElementById('wallpaperFileInput');
            if (fileInput) fileInput.click();
        });
    }

    // 从链接添加 - 打开模态框
    const fromUrlBtn = document.getElementById('wallpaperFromUrlBtn');
    if (fromUrlBtn) {
        fromUrlBtn.addEventListener('click', () => {
            document.getElementById('wallpaperFromUrlOverlay').classList.add('show');
            document.getElementById('wallpaperFromUrlInput').value = currentWallpaper || '';
            updateWallpaperFromUrlPreview();
        });
    }

    // 粘贴按钮
    const pasteBtn = document.getElementById('pasteFromUrlBtn');
    if (pasteBtn) {
        pasteBtn.addEventListener('click', async () => {
            try {
                const text = await navigator.clipboard.readText();
                if (text) {
                    document.getElementById('wallpaperFromUrlInput').value = text;
                    updateWallpaperFromUrlPreview();
                    showToast('已粘贴链接！', 'success');
                }
            } catch (err) {
                showToast('无法粘贴，请手动粘贴', 'error');
            }
        });
    }

    // 输入链接时更新预览
    const urlInput = document.getElementById('wallpaperFromUrlInput');
    if (urlInput) {
        urlInput.addEventListener('input', updateWallpaperFromUrlPreview);
    }

    // 确认应用壁纸
    const confirmBtn = document.getElementById('confirmWallpaperFromUrlBtn');
    if (confirmBtn) {
        confirmBtn.addEventListener('click', () => {
            const url = document.getElementById('wallpaperFromUrlInput').value.trim();
            if (url) {
                currentWallpaper = url;
                applyWallpaper(url);
                addWallpaperToHistory(url);
                saveSettings();
                updateAllWallpaperInputs();
                updateCurrentWallpaperPreview();
                renderWallpaperHistory();
                document.getElementById('wallpaperFromUrlOverlay').classList.remove('show');
                showToast('壁纸已更新！', 'success');
            }
        });
    }

    // 取消按钮
    const cancelBtn = document.getElementById('cancelWallpaperFromUrlBtn');
    if (cancelBtn) {
        cancelBtn.addEventListener('click', () => {
            document.getElementById('wallpaperFromUrlOverlay').classList.remove('show');
        });
    }

    // 模态框关闭按钮
    const closeBtn = document.querySelector('#wallpaperFromUrlOverlay .modal-close');
    if (closeBtn) {
        closeBtn.addEventListener('click', () => {
            document.getElementById('wallpaperFromUrlOverlay').classList.remove('show');
        });
    }

    // 点击遮罩关闭
    document.getElementById('wallpaperFromUrlOverlay')?.addEventListener('click', (e) => {
        if (e.target === document.getElementById('wallpaperFromUrlOverlay')) {
            document.getElementById('wallpaperFromUrlOverlay').classList.remove('show');
        }
    });

    // 清除壁纸
    const clearBtn = document.getElementById('wallpaperClearBtn');
    if (clearBtn) {
        clearBtn.addEventListener('click', () => {
            currentWallpaper = null;
            applyWallpaper(null);
            saveSettings();
            updateAllWallpaperInputs();
            updateCurrentWallpaperPreview();
            renderWallpaperHistory();
            showToast('壁纸已清除', 'info');
        });
    }
})();

// 更新壁纸预览
function updateWallpaperFromUrlPreview() {
    const url = document.getElementById('wallpaperFromUrlInput').value.trim();
    const preview = document.getElementById('wallpaperFromUrlPreview');
    
    if (url) {
        preview.innerHTML = `<img src="${url}" onerror="this.parentElement.innerHTML='<span style=\\'color:var(--text-muted);font-size:0.9rem;\\'>预览加载失败</span>';" style="width:100%;height:100%;object-fit:cover;">`;
    } else {
        preview.innerHTML = '<span style="color:var(--text-muted);font-size:0.9rem;">输入链接后显示预览</span>';
    }
}

// ==================== 增强 applyWallpaper 函数 ====================
const originalApplyWallpaper = window.applyWallpaper;
window.applyWallpaper = function(url) {
    if (originalApplyWallpaper) originalApplyWallpaper(url);
    updateCurrentWallpaperPreview();
};

// ==================== 推荐壁纸库管理 ====================
// 渲染推荐壁纸库
async function renderFeaturedWallpapers() {
    const grid = document.getElementById('featuredWallpapersGrid');
    if (!grid) return;
    
    grid.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-secondary);">加载中...</div>';
    
    if (!isCloudReady || !supabaseClient) {
        grid.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-secondary);">云端未连接</div>';
        return;
    }
    
    try {
        const res = await supabaseClient
            .from('admin_wallpapers')
            .select('*')
            .order('sort_order');
        
        if (res.error) {
            error('加载推荐壁纸失败:', res.error);
            grid.innerHTML = `<div style="text-align:center;padding:20px;color:var(--text-secondary);">加载失败: ${res.error.message}</div>`;
            return;
        }
        
        const wallpapers = res.data || [];
        if (wallpapers.length === 0) {
            grid.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-secondary);">暂无推荐壁纸</div>';
            return;
        }
    
    grid.innerHTML = '';
    wallpapers.forEach(wallpaper => {
        const item = document.createElement('div');
        item.className = 'featured-wallpaper-item';
        item.style.backgroundImage = `url(${wallpaper.url})`;
        
        // 高亮当前使用的壁纸
        if (wallpaper.url === currentWallpaper) {
            item.classList.add('is-active');
        }
        
        // 悬停时显示壁纸名称
        const overlay = document.createElement('div');
        overlay.className = 'wallpaper-overlay';
        const name = document.createElement('span');
        name.className = 'wallpaper-name';
        name.textContent = wallpaper.name || '推荐壁纸';
        overlay.appendChild(name);
        item.appendChild(overlay);
        
        item.addEventListener('click', () => {
            currentWallpaper = wallpaper.url;
            applyWallpaper(wallpaper.url);
            addWallpaperToHistory(wallpaper.url);
            saveSettings();
            updateAllWallpaperInputs();
            updateCurrentWallpaperPreview();
            renderWallpaperHistory();
            renderFeaturedWallpapers();
            showToast(`已使用壁纸：${wallpaper.name || '推荐壁纸'}`, 'success');
        });
        
        grid.appendChild(item);
    });
    } catch (err) {
        error('加载推荐壁纸异常:', err);
        grid.innerHTML = `<div style="text-align:center;padding:20px;color:var(--text-secondary);">加载失败: ${err.message}</div>`;
    }
}

// ==================== 管理员壁纸库管理 ====================
async function renderAdminWallpapersList() {
    const listEl = document.getElementById('adminWallpapersList');
    if (!listEl) return;
    
    log('renderAdminWallpapersList 被调用');
    
    listEl.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-secondary);">加载中...</div>';
    
    if (!isCloudReady) {
        listEl.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-secondary);">云端未连接</div>';
        return;
    }
    
    try {
        log('开始查询数据库...');
        
        // 现在 sw.js 已经修复，直接简单查询即可
        const res = await supabaseClient
            .from('admin_wallpapers')
            .select('*')
            .order('sort_order');
        
        log('查询结果:', res);
        log('数据数量:', res.data?.length);
        
        if (res.error) {
            error('加载失败:', res.error);
            listEl.innerHTML = `<div style="text-align:center;padding:20px;color:var(--text-secondary);">加载失败: ${res.error.message}</div>`;
            return;
        }
        
        const wallpapers = res.data || [];
        if (wallpapers.length === 0) {
            listEl.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-secondary);">暂无壁纸，可在下方添加</div>';
            return;
        }
    
    listEl.innerHTML = `
        <div style="margin-bottom:10px;padding:8px 12px;background:var(--bg-active);border-radius:8px;font-size:0.78rem;">
            💡 可以拖拽壁纸调整顺序
        </div>
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;">
            ${wallpapers.map((wp, idx) => `
                <div class="admin-wallpaper-item" draggable="true" data-id="${wp.id}" data-index="${idx}" style="border:2px solid var(--border);border-radius:10px;overflow:hidden;position:relative;cursor:move;">
                    <div style="aspect-ratio:16/9;background:url(${wp.url}) center/cover no-repeat;"></div>
                    <div style="padding:8px;font-size:0.8rem;background:var(--bg-surface);">
                        <div style="font-weight:600;">${esc(wp.name || '未命名')}</div>
                    </div>
                    <button class="delete-admin-wallpaper-btn" data-id="${wp.id}" style="position:absolute;top:6px;right:6px;width:28px;height:28px;border-radius:50%;background:rgba(0,0,0,0.7);border:none;color:white;font-size:1.2rem;cursor:pointer;opacity:0;transition:opacity 0.2s;" title="删除">×</button>
                </div>
            `).join('')}
        </div>
    `;
    
    listEl.querySelectorAll('.delete-admin-wallpaper-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const id = e.target.dataset.id;
            const confirmed = await showConfirmDialog('🗑️', '删除壁纸', '确定删除这个壁纸吗？');
            if (!confirmed) return;
            
            try {
                showToast('正在删除...', 'info');
                log('开始删除壁纸 ID:', id);
                
                // 先从界面移除该元素，让用户立即看到效果
                const deleteBtn = e.target;
                const wallpaperItem = deleteBtn.closest('.admin-wallpaper-item');
                if (wallpaperItem) {
                    wallpaperItem.style.opacity = '0.3';
                    wallpaperItem.style.transform = 'scale(0.95)';
                    wallpaperItem.style.pointerEvents = 'none';
                }
                
                const res = await supabaseClient.from('admin_wallpapers').delete().eq('id', id);
                
                log('删除响应:', res);
                
                if (res.error) {
                    error('删除失败:', res.error);
                    // 如果删除失败，恢复元素
                    if (wallpaperItem) {
                        wallpaperItem.style.opacity = '1';
                        wallpaperItem.style.transform = 'scale(1)';
                        wallpaperItem.style.pointerEvents = 'auto';
                    }
                    showToast('删除失败: ' + res.error.message, 'error');
                    return;
                }
                
                showToast('壁纸已删除！', 'success');
                
                // 再完整刷新一次
                log('开始刷新界面...');
                await renderAdminWallpapersList();
                await renderFeaturedWallpapers();
                log('刷新完成');
                
            } catch (err) {
                error('删除异常:', err);
                showToast('删除失败: ' + (err.message || '未知错误'), 'error');
            }
        });
    });
    
    listEl.querySelectorAll('.admin-wallpaper-item').forEach(item => {
        item.addEventListener('mouseenter', () => {
            item.querySelector('.delete-admin-wallpaper-btn').style.opacity = '1';
        });
        item.addEventListener('mouseleave', () => {
            item.querySelector('.delete-admin-wallpaper-btn').style.opacity = '0';
        });
    });
    } catch (err) {
        error('加载异常:', err);
        listEl.innerHTML = `<div style="text-align:center;padding:20px;color:var(--text-secondary);">加载失败: ${err.message}</div>`;
    }
}

// 上传管理员壁纸到 Storage
async function uploadAdminWallpaper(file) {
    if (!supabaseClient) {
        // 如果没有配置云存储，就用 base64
        return fileToBase64(file);
    }
    
    try {
        const fileName = `admin_wallpaper_${Date.now()}_${file.name}`;
        const { data, error } = await supabaseClient
            .storage
            .from('wallpapers')
            .upload(fileName, file, { cacheControl: '3600', upsert: false });
        
        if (error) {
            warn('云存储上传失败，使用base64:', error);
            showToast('云存储上传失败，使用本地存储', 'info');
            return fileToBase64(file);
        }
        
        const { data: { publicUrl } } = supabaseClient
            .storage
            .from('wallpapers')
            .getPublicUrl(fileName);
        
        return publicUrl;
    } catch (err) {
        warn('云存储上传失败，使用base64:', err);
        // 备用方案：使用 base64
        return fileToBase64(file);
    }
}

// 将文件转为 base64
function fileToBase64(file) {
    return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => {
            resolve(reader.result);
        };
        reader.readAsDataURL(file);
    });
}

// 从 URL 下载图片并上传到 Storage
async function downloadAndUploadFromUrl(url) {
    try {
        showToast('正在下载图片...', 'info');
        
        // 下载图片
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error('下载失败: ' + response.status);
        }
        
        const blob = await response.blob();
        
        // 从 URL 中提取文件名，或者生成一个
        const urlObj = new URL(url);
        const pathParts = urlObj.pathname.split('/');
        let fileName = pathParts[pathParts.length - 1] || 'wallpaper.jpg';
        
        // 如果文件名太长或没有扩展名，生成一个
        if (!fileName.includes('.') || fileName.length > 100) {
            // 从 Content-Type 推断扩展名
            const mimeType = blob.type;
            let ext = 'jpg';
            if (mimeType.includes('png')) ext = 'png';
            else if (mimeType.includes('gif')) ext = 'gif';
            else if (mimeType.includes('webp')) ext = 'webp';
            fileName = `wallpaper_${Date.now()}.${ext}`;
        } else {
            // 确保文件名唯一
            fileName = `wallpaper_${Date.now()}_${fileName}`;
        }
        
        // 创建 File 对象
        const file = new File([blob], fileName, { type: blob.type });
        
        showToast('正在上传到存储桶...', 'info');
        
        // 上传到 Storage
        const uploadedUrl = await uploadAdminWallpaper(file);
        
        return uploadedUrl;
    } catch (err) {
        error('下载上传失败:', err);
        throw err;
    }
}

// 初始化壁纸库相关事件监听
(function initAdminWallpaperFeatures() {
    // 打开壁纸管理
    document.getElementById('manageAdminWallpapersBtn')?.addEventListener('click', async () => {
        document.getElementById('adminWallpapersOverlay').classList.add('show');
        await renderAdminWallpapersList();
    });
    
    // 关闭壁纸管理
    document.getElementById('closeAdminWallpapersBtn')?.addEventListener('click', () => {
        document.getElementById('adminWallpapersOverlay').classList.remove('show');
    });
    
    // 上传按钮
    document.getElementById('newWallpaperUploadBtn')?.addEventListener('click', () => {
        document.getElementById('adminWallpaperFileInput').click();
    });
    
    // 文件选择上传
    document.getElementById('adminWallpaperFileInput')?.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        
        showToast('正在上传壁纸...', 'info');
        const url = await uploadAdminWallpaper(file);
        if (url) {
            document.getElementById('newWallpaperUrl').value = url;
            showToast('上传成功！', 'success');
        } else {
            showToast('上传失败', 'error');
        }
        
        e.target.value = '';
    });
    
    // 添加壁纸
    document.getElementById('addAdminWallpaperBtn')?.addEventListener('click', async () => {
        const name = document.getElementById('newWallpaperName').value.trim();
        let url = document.getElementById('newWallpaperUrl').value.trim();
        
        if (!url) {
            showToast('请提供壁纸图片', 'error');
            return;
        }
        
        try {
            // 检查是否是外部 URL（不是我们自己的 Storage）
            const isExternalUrl = !url.includes(window.location.origin) && 
                                  !url.includes('supabase.co/storage');
            
            if (isExternalUrl && supabaseClient) {
                // 如果是外部 URL，先下载并上传到我们的 Storage
                try {
                    url = await downloadAndUploadFromUrl(url);
                    showToast('图片已上传到存储桶！', 'success');
                } catch (downloadErr) {
                    // 如果下载上传失败，询问用户是否直接用原始 URL
                    const confirmed = confirm('下载上传失败: ' + downloadErr.message + '\n\n是否直接使用原始 URL？');
                    if (!confirmed) {
                        return;
                    }
                    // 恢复原始 URL
                    url = document.getElementById('newWallpaperUrl').value.trim();
                }
            }
            
            showToast('正在保存...', 'info');
            
            // 获取当前数量
            let sortOrder = 0;
            const countRes = await supabaseClient.from('admin_wallpapers').select('*');
            if (!countRes.error) {
                sortOrder = countRes.data?.length || 0;
            }
            
            // 插入新壁纸
            const res = await supabaseClient.from('admin_wallpapers').insert([{
                name: name || '未命名',
                url: url,
                sort_order: sortOrder
            }]);
            
            if (res.error) {
                error('保存失败:', res.error);
                showToast('保存失败: ' + res.error.message, 'error');
                return;
            }
            
            showToast('壁纸添加成功！', 'success');
            document.getElementById('newWallpaperName').value = '';
            document.getElementById('newWallpaperUrl').value = '';
            
            // 直接刷新，没有闪烁
            await renderAdminWallpapersList();
            await renderFeaturedWallpapers();
        } catch (err) {
            error('保存异常:', err);
            showToast('保存失败: ' + (err.message || '未知错误'), 'error');
        }
    });
    
    // 壁纸标签切换时也加载推荐壁纸
    const appearanceTabs = document.querySelectorAll('.appearance-tab');
    appearanceTabs.forEach(tab => {
        tab.addEventListener('click', async () => {
            if (tab.dataset.tab === 'wallpaper') {
                await renderFeaturedWallpapers();
            }
        });
    });
    
    // 关闭按钮
    document.querySelectorAll('#adminWallpapersOverlay .modal-close').forEach(btn => {
        btn.addEventListener('click', () => {
            document.getElementById('adminWallpapersOverlay').classList.remove('show');
        });
    });
    
    // 点击遮罩关闭
    document.getElementById('adminWallpapersOverlay')?.addEventListener('click', (e) => {
        if (e.target === document.getElementById('adminWallpapersOverlay')) {
            document.getElementById('adminWallpapersOverlay').classList.remove('show');
        }
    });
})();

// 更新建表 SQL，添加 admin_wallpapers 表
const originalShowSqlBtn = document.getElementById('showSqlBtn');
if (originalShowSqlBtn) {
    originalShowSqlBtn.onclick = null;
    originalShowSqlBtn.addEventListener('click', () => {
        const originalSql = `-- ======================================
-- 第一步：创建数据表
-- ======================================
-- 1. 书签表
CREATE TABLE IF NOT EXISTS bookmarks (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    icon TEXT,
    sort_order INTEGER DEFAULT 0,
    folder_id UUID,
    deleted BOOLEAN DEFAULT FALSE,
    deleted_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- 2. 推广卡片表
CREATE TABLE IF NOT EXISTS admin_cards (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    icon TEXT,
    sort_order INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- 3. 壁纸表（新增）
CREATE TABLE IF NOT EXISTS admin_wallpapers (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    name TEXT,
    url TEXT NOT NULL,
    sort_order INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- 启用行级安全
ALTER TABLE bookmarks ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_cards ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_wallpapers ENABLE ROW LEVEL SECURITY;

-- 书签表的安全策略
CREATE POLICY "Users can view own bookmarks" ON bookmarks FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own bookmarks" ON bookmarks FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own bookmarks" ON bookmarks FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Users can delete own bookmarks" ON bookmarks FOR DELETE USING (auth.uid() = user_id);

-- 推广卡片表：所有人可读（暂不限制，如需限制可后续调整）
CREATE POLICY "Everyone can view admin cards" ON admin_cards FOR SELECT USING (true);
CREATE POLICY "Allow all operations" ON admin_cards FOR ALL USING (true);

-- 壁纸表：所有人可读，暂时允许所有操作
CREATE POLICY "Everyone can view admin wallpapers" ON admin_wallpapers FOR SELECT USING (true);
CREATE POLICY "Allow all operations" ON admin_wallpapers FOR ALL USING (true);

-- ======================================
-- 第二步：配置 Storage (重要！)
-- ======================================
-- 在 Supabase 控制台执行以下操作：
--
-- 1. 创建存储桶：
--    Storage > Buckets > 创建名为 'icons' 和 'wallpapers' 的存储桶
--    设置为「公开」访问
--
-- 2. 配置 Storage RLS 策略：
--    Storage > Policies > storage.objects 表
--    添加以下策略（如果还没有）：
--
--    策略名称: Allow public uploads
--    策略类型: SELECT, INSERT, UPDATE, DELETE
--    应用对象: public
--    条件: (bucket_id = 'icons'::text OR bucket_id = 'wallpapers'::text)
--
--    或者直接执行 SQL：
CREATE POLICY "Allow public access to icons and wallpapers" 
ON storage.objects 
FOR ALL 
TO public 
USING (bucket_id = 'icons' OR bucket_id = 'wallpapers');
`;
        
        showToast('请在 Supabase SQL Editor 中执行 SQL 脚本（已复制）', 'info', 5000);

    });
}
