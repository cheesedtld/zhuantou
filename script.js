(function () {
// ========== IndexedDB 聊天记录存储模块 ==========
// 替代 localStorage 存储聊天记录，突破 5MB 限制

const CHAT_DB_NAME = 'faye-phone-db';
const CHAT_DB_VERSION = 1;
const CHAT_STORE_NAME = 'chatHistory';

let _chatDB = null;

/**
 * 初始化 IndexedDB，返回 db 实例
 */
function initChatDB() {
    return new Promise((resolve, reject) => {
        if (_chatDB) { resolve(_chatDB); return; }
        const request = indexedDB.open(CHAT_DB_NAME, CHAT_DB_VERSION);
        request.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(CHAT_STORE_NAME)) {
                db.createObjectStore(CHAT_STORE_NAME);
            }
        };
        request.onsuccess = (e) => {
            _chatDB = e.target.result;
            resolve(_chatDB);
        };
        request.onerror = (e) => {
            console.error('IndexedDB open failed:', e.target.error);
            reject(e.target.error);
        };
    });
}

/**
 * 获取内部 db 引用（确保已初始化）
 */
async function _getDB() {
    if (!_chatDB) await initChatDB();
    return _chatDB;
}

/**
 * 读取指定 tag 的聊天记录
 * @param {string} tag - 聊天标识，如 "chat:小明" 或 "group:朋友们"
 * @returns {Promise<Array>} 聊天记录数组，不存在则返回 null
 */
async function getChatHistory(tag) {
    const db = await _getDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(CHAT_STORE_NAME, 'readonly');
        const store = tx.objectStore(CHAT_STORE_NAME);
        const request = store.get(tag);
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(request.error);
    });
}

/**
 * 保存指定 tag 的聊天记录
 * @param {string} tag - 聊天标识
 * @param {Array} history - 聊天记录数组
 */
async function saveChatHistory(tag, history) {
    const db = await _getDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(CHAT_STORE_NAME, 'readwrite');
        const store = tx.objectStore(CHAT_STORE_NAME);
        const request = store.put(history, tag);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
}

/**
 * 删除指定 tag 的聊天记录
 * @param {string} tag - 聊天标识
 */
async function deleteChatHistory(tag) {
    const db = await _getDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(CHAT_STORE_NAME, 'readwrite');
        const store = tx.objectStore(CHAT_STORE_NAME);
        const request = store.delete(tag);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
}

/**
 * 获取所有聊天记录的 tag 列表
 * @returns {Promise<string[]>}
 */
async function getAllChatHistoryKeys() {
    const db = await _getDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(CHAT_STORE_NAME, 'readonly');
        const store = tx.objectStore(CHAT_STORE_NAME);
        const request = store.getAllKeys();
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error);
    });
}

/**
 * 获取所有聊天记录（用于导出）
 * @returns {Promise<Object>} { tag: historyArray, ... }
 */
async function getAllChatHistories() {
    const db = await _getDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(CHAT_STORE_NAME, 'readonly');
        const store = tx.objectStore(CHAT_STORE_NAME);
        const result = {};
        const cursorRequest = store.openCursor();
        cursorRequest.onsuccess = (e) => {
            const cursor = e.target.result;
            if (cursor) {
                result[cursor.key] = cursor.value;
                cursor.continue();
            } else {
                resolve(result);
            }
        };
        cursorRequest.onerror = () => reject(cursorRequest.error);
    });
}

/**
 * 清除所有聊天记录
 */
async function clearAllChatHistories() {
    const db = await _getDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(CHAT_STORE_NAME, 'readwrite');
        const store = tx.objectStore(CHAT_STORE_NAME);
        const request = store.clear();
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
}

/**
 * 从 localStorage 迁移聊天记录到 IndexedDB
 * 迁移两种 key 模式：
 *   - "faye - phone - history - {tag} " (主聊天记录)
 *   - "chat-history-{chatKey}" (朋友圈等使用的 key)
 * 统一存储为 tag 作为 key
 */
async function migrateFromLocalStorage() {
    const db = await _getDB();
    const keysToRemove = [];
    const migrations = [];

    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        let tag = null;

        // 主模式: "faye - phone - history - {tag} "
        if (key && key.startsWith('faye - phone - history - ')) {
            tag = key.replace('faye - phone - history - ', '').trim();
        }
        // 辅助模式: "chat-history-{chatKey}"
        else if (key && key.startsWith('chat-history-')) {
            tag = key.replace('chat-history-', '');
        }

        if (tag) {
            try {
                const data = JSON.parse(localStorage.getItem(key));
                if (Array.isArray(data) && data.length > 0) {
                    migrations.push({ tag, data });
                }
                keysToRemove.push(key);
            } catch (e) {
                console.warn('Migration skip (parse error):', key, e);
                keysToRemove.push(key); // 坏数据也删掉
            }
        }
    }

    if (migrations.length === 0) return;

    console.log(`[ChatDB] 迁移 ${migrations.length} 个聊天记录从 localStorage → IndexedDB...`);

    // 批量写入
    const tx = db.transaction(CHAT_STORE_NAME, 'readwrite');
    const store = tx.objectStore(CHAT_STORE_NAME);

    for (const { tag, data } of migrations) {
        // 如果 IndexedDB 中已存在，合并（保留更长的记录）
        const existing = await new Promise((resolve) => {
            const req = store.get(tag);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => resolve(null);
        });

        if (existing && Array.isArray(existing) && existing.length >= data.length) {
            // IndexedDB 中已有更长的记录，跳过
            continue;
        }

        store.put(data, tag);
    }

    await new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });

    // 迁移成功后删除 localStorage 中的旧数据
    keysToRemove.forEach(key => {
        try { localStorage.removeItem(key); } catch (e) { }
    });

    console.log(`[ChatDB] 迁移完成！已迁移 ${migrations.length} 个聊天记录，已清理 ${keysToRemove.length} 个 localStorage 条目`);
}


const APP_VERSION = '1.0.5';
const BUILD_VERSION = '2026-3-2-3';
const UPDATE_LOG = 'v1.0.0\n砖头机初始内测版\nv1.0.1\n修复了部分bug\n增加酒馆角色卡json导入\n增加ai角色边回消息边回朋友圈？的功能\n增加一些零零散散小功能\nv1.0.2\n修复部分bug\n完善酒馆json导入功能\n增加听歌功能,可导入网易云音乐的分享链接（支持vip歌曲）也可上传url或文件\n增加番茄钟功能，有学习/工作、运动两种可选（可能没啥区别）\n增加tts缓存，最多可缓存50条语音消息\nv1.0.3\n修复一些bug\n注意注意！备份一下数据，正在进行储存升级，请先行备份以免数据丢失\nv1.0.4\n储存升级，不再局限于浏览器的5MB储存\n修复一些bug\nv1.0.5\n重构TTS，CORS留空即可应用，现在应该更稳定了！\n修改一些我强迫症看着别扭的UI\n修复一些bug';
function checkUpdate() {
    const lastVersion = localStorage.getItem('faye-phone-version');
    if (lastVersion !== APP_VERSION) {
        showUpdateModal();
        localStorage.setItem('faye-phone-version', APP_VERSION);
    }
}

function showUpdateModal() {
    const modal = document.getElementById('update-modal');
    const content = document.getElementById('update-content');
    if (modal && content) {
        content.textContent = UPDATE_LOG;
        modal.classList.add('show');
    }
}

function closeUpdateModal() {
    const modal = document.getElementById('update-modal');
    if (modal) modal.classList.remove('show');
}

const defaultAppSettings = {
    charBubble: '#e8dada', charText: '#746669', charAvatar: '',
    userBubble: '#f2ecec', userText: '#746669', userAvatar: '',
    chatBg: 'https://img.phey.click/43m7c8.jpeg', chatBgIsDark: false,
    homeBg: 'https://img.phey.click/43m7c8.jpeg', homeBgIsDark: false,
    iconBg: 'rgba(230, 215, 218, 0.55)', iconColor: '#c6acb1',
    homeTextColor: '#a5979a',
    interfaceColor: '#f1e8e9',
    msgNameColor: '#ad9a9e',
    msgTimeColor: '#c5b8ba',
    fontSize: 14, // 默认字体大小
    chatBtnColor: '#f0e8e9', // 按钮背景色
    chatBtnText: '#bcaaae', // 按钮文字/图标色
    customTime: '', // 格式 HH:MM，为空则使用系统时间
    timeOffset: 0, // 时间偏移量 (ms)
    blockChar: false, // User blocks Char (DEPRECATED global, use chatBlockStates)
    blockUser: false, // Char blocks User (DEPRECATED global, use chatBlockStates)
    chatBlockStates: {}, // 每个聊天的拉黑状态 { 'chat:Name': { blockChar: bool, blockUser: bool }, ... }
    groups: [], // 群组列表 [{name: 'GroupName', members: ['A', 'B']}]
    privateChats: [], // 私聊列表 ['Name1', 'Name2']
    memberAvatars: {}, // NEW: 成员头像列表 { 'Name': 'url', ... }
    chatTimezones: {}, // 每个聊天的角色时区偏移 (小时) { 'chat:Name': offset_hours, ... }
    chatMateModes: {}, // 每个聊天的mate模式开关 { 'chat:Name': true/false, ... }
    chatUserIds: {}, // 每个聊天绑定的用户ID { 'chat:NPC名': userId, 'group:群名': userId }
    useSunbox: true, // Default to true
    // API Settings
    apiEndpoint: 'https://api.openai.com/v1',
    apiKey: '',
    apiModel: 'gpt-3.5-turbo',
    apiTemperature: 1.0,
    debugMode: false, // 调试模式：显示AI原始输出
    friendRequests: [], // 好友申请列表 [{from: 'Name', message: '留言', timestamp: Date}]
    // NAI Image Generation Settings
    naiEnabled: false,
    naiApiKey: '',
    naiModel: 'nai-diffusion-4-curated-preview',
    naiSampler: 'k_euler_ancestral',
    naiSchedule: 'native',
    naiSteps: 28,
    naiScale: 5,
    naiSeed: -1,
    naiWidth: 832,
    naiHeight: 1216,
    naiSizePreset: '832x1216',
    naiPositivePrefix: 'best quality, amazing quality, very aesthetic, absurdres',
    naiPositiveSuffix: '',
    naiNegative: 'lowres, {bad}, error, fewer, extra, missing, worst quality, jpeg artifacts, bad quality, watermark, unfinished, displeasing, chromatic aberration, signature, extra digits, artistic error, username, scan, [abstract]',
    naiSmea: true,
    naiDynamic: false,
    naiCfgRescale: 0,
    naiUncondScale: 1,
    naiPromptInstruction: `When sending type="img" messages, write the content as NovelAI image generation tags (Danbooru tag format). Rules:\n1. Use comma-separated English tags, NOT natural language descriptions.\n2. Include character appearance tags: hair color, eye color, expression, pose, clothing.\n3. Include scene/background tags: location, lighting, atmosphere.\n4. Use tag weighting: {{important tag}}, [less important tag].\n5. Character name tag: {char_name}.\n6. Example: 1girl, {char_name}, silver hair, blue eyes, smile, school uniform, sitting, classroom, window, sunlight, upper body`,
    // Toy Control Settings (Intiface Central)
    toyWsUrl: 'ws://127.0.0.1:12345',
    toyEnabled: false
};
let appSettings = { ...defaultAppSettings };
let userCharacters = []; // New: To store user characters
let editingUserIndex = null; // New: To track which user is being edited
let currentChatTag = null; // 当前聊天标签 (e.g. chat:Name or group:Name5人)
let currentChatTarget = null; // 当前聊天显示名称
let isOfflineMode = false; // 线下交流模式

let myStickerList = [];
const defaultStickerList = [
    { name: "抱抱", url: "https://img.phey.click/31onrh.jpeg" },
    { name: "贴贴", url: "https://img.phey.click/ljqszc.jpeg" },
    { name: "我要告状", url: "https://img.phey.click/icwt52.jpeg" },
    { name: "你自首吧", url: "https://img.phey.click/s1wpw8.jpeg" },
];

let activeDeleteBtn = null;
let currentConfirmAction = null;
// NEW: Pending upload file
let pendingFile = null;
// NEW: Last uploaded image for AI vision
let lastUploadedImageForAI = null;

let currentSettingsUploadType = null;
let isLoadingHistory = false;

// Helper: get current chat's bound user ID (per-chat isolation)
function getCurrentUserId() {
    // Priority 1: Per-chat bound userId
    if (currentChatTag && appSettings.chatUserIds && appSettings.chatUserIds[currentChatTag] !== undefined) {
        const chatUserId = appSettings.chatUserIds[currentChatTag];
        if (userCharacters[chatUserId]) {
            return chatUserId;
        }
    }
    // Priority 2: Global fallback
    if (appSettings.currentUserId !== undefined && userCharacters[appSettings.currentUserId]) {
        return appSettings.currentUserId;
    }
    return undefined;
}

// Helper: get per-chat blockChar state (user blocks character)
function getChatBlockChar() {
    if (!currentChatTag) return false;
    if (!appSettings.chatBlockStates) return false;
    const state = appSettings.chatBlockStates[currentChatTag];
    return state ? !!state.blockChar : false;
}

// Helper: get per-chat blockUser state (character blocks user)
function getChatBlockUser() {
    if (!currentChatTag) return false;
    if (!appSettings.chatBlockStates) return false;
    const state = appSettings.chatBlockStates[currentChatTag];
    return state ? !!state.blockUser : false;
}

// Helper: set per-chat block state
function setChatBlockState(key, value) {
    if (!currentChatTag) return;
    if (!appSettings.chatBlockStates) appSettings.chatBlockStates = {};
    if (!appSettings.chatBlockStates[currentChatTag]) {
        appSettings.chatBlockStates[currentChatTag] = { blockChar: false, blockUser: false };
    }
    appSettings.chatBlockStates[currentChatTag][key] = value;
}

// Helper: get current user display name
function getUserName() {
    const uid = getCurrentUserId();
    if (uid !== undefined && userCharacters[uid]) {
        return userCharacters[uid].name;
    }
    return 'User';
}
// Helper: get current chat target (char) display name
function getCharName() {
    return currentChatTarget || 'AI';
}

// Helper: build character context (NPC persona + user persona + world book)
function buildCharacterContext() {
    let context = '';

    // 1. Find current NPC by name
    const charName = getCharName();
    const npc = npcCharacters.find(n => n.name === charName);

    if (npc) {
        context += `[角色设定 - ${npc.name}]\n`;
        if (npc.nickname) context += `昵称: ${npc.nickname}\n`;
        if (npc.gender) context += `性别: ${npc.gender === 'female' ? '女' : npc.gender === 'male' ? '男' : npc.gender}\n`;
        if (npc.persona) context += `人设: ${npc.persona}\n`;
        if (npc.personality) context += `性格: ${npc.personality}\n`;
        if (npc.scenario) context += `背景: ${npc.scenario}\n`;
        if (npc.first_mes) context += `开场白: ${npc.first_mes}\n`;
        if (npc.mes_example) context += `对话示例:\n${npc.mes_example}\n`;
        if (npc.system_prompt) context += `附加系统设定:\n${npc.system_prompt}\n`;
        if (npc.post_history_instructions) context += `历史后指令:\n${npc.post_history_instructions}\n`;
        if (npc.creator_notes) context += `创建者备注: ${npc.creator_notes}\n`;

        // Sub-NPCs
        if (npc.npcs && npc.npcs.length > 0) {
            context += '\n[相关NPC角色]\n';
            npc.npcs.forEach(sub => {
                context += `- ${sub.name}`;
                if (sub.nickname) context += ` (${sub.nickname})`;
                if (sub.gender) context += ` [${sub.gender === 'female' ? '女' : sub.gender === 'male' ? '男' : sub.gender}]`;
                if (sub.desc) context += `: ${sub.desc}`;
                context += '\n';
            });
        }

        // NPC's World Book (Support Multiple)
        let npcWbs = [];
        if (npc.worldbooks && Array.isArray(npc.worldbooks)) {
            npcWbs = npc.worldbooks;
        } else if (npc.worldbook) {
            // Legacy support
            npcWbs = [npc.worldbook];
        }

        if (npcWbs.length > 0) {
            npcWbs.forEach(wbName => {
                const wb = worldbooks.find(w => w.name === wbName);
                if (wb && wb.entries && wb.entries.length > 0) {
                    context += `\n[世界书 - ${wb.name}]\n`;
                    wb.entries.forEach(entry => {
                        if (entry.content && entry.enabled !== false) {
                            if (entry.keywords) context += `[关键词: ${entry.keywords}] `;
                            context += entry.content + '\n';
                        }
                    });
                }
            });
        }
    }

    // 2. Current User info (per-chat isolated)
    const userId = getCurrentUserId();
    const user = (userId !== undefined) ? userCharacters[userId] : null;
    if (user) {
        context += `\n[用户设定 - ${user.name}]\n`;
        if (user.gender) context += `性别: ${user.gender === 'female' ? '女' : user.gender === 'male' ? '男' : user.gender}\n`;
        if (user.persona) context += `人设: ${user.persona}\n`;

        // User's Sub-NPCs
        if (user.npcs && user.npcs.length > 0) {
            context += '\n[用户相关NPC]\n';
            user.npcs.forEach(sub => {
                context += `- ${sub.name}`;
                if (sub.nickname) context += ` (${sub.nickname})`;
                if (sub.desc) context += `: ${sub.desc}`;
                context += '\n';
            });
        }

        // User's World Book (Support Multiple)
        let userWbs = [];
        if (user.worldbooks && Array.isArray(user.worldbooks)) {
            userWbs = user.worldbooks;
        } else if (user.worldbook) {
            userWbs = [user.worldbook];
        }

        if (userWbs.length > 0) {
            userWbs.forEach(wbName => {
                let uwb;
                if (wbName === '__default__') {
                    const defaultWbData = localStorage.getItem('faye-phone-worldbook');
                    if (defaultWbData) {
                        try { uwb = { name: '默认世界书', entries: JSON.parse(defaultWbData).entries }; } catch (e) { }
                    }
                } else {
                    uwb = worldbooks.find(w => w.name === wbName);
                }

                if (uwb && uwb.entries && uwb.entries.length > 0) {
                    context += `\n[世界书 - ${uwb.name || '默认'}]\n`;
                    uwb.entries.forEach(entry => {
                        if (entry.content && entry.enabled !== false) {
                            if (entry.keywords) context += `[关键词: ${entry.keywords}] `;
                            context += entry.content + '\n';
                        }
                    });
                }
            });
        }
    }

    // 3. Group chat: gather all member NPCs with full persona
    if (currentChatTag && currentChatTag.startsWith('group:')) {
        const groupName = currentChatTag.replace(/^group:/, '');
        const group = (appSettings.groups || []).find(g => g.name === groupName);
        if (group && group.members) {
            const userName = getUserName();
            context += `\n[群聊 - ${groupName}]\n`;
            context += `群聊成员共 ${group.members.length} 人：\n`;
            group.members.forEach(memberName => {
                if (memberName === userName) {
                    context += `- ${memberName} (用户本人)\n`;
                    return;
                }
                const memberNpc = npcCharacters.find(n => n.name === memberName);
                if (memberNpc) {
                    context += `- ${memberNpc.name}`;
                    if (memberNpc.nickname) context += ` (${memberNpc.nickname})`;
                    if (memberNpc.gender) context += ` [${memberNpc.gender === 'female' ? '女' : memberNpc.gender === 'male' ? '男' : memberNpc.gender}]`;
                    if (memberNpc.persona) context += `：${memberNpc.persona.substring(0, 300)}`;
                    if (memberNpc.personality) context += ` 性格: ${memberNpc.personality.substring(0, 100)}`;
                    if (memberNpc.scenario) context += ` 背景: ${memberNpc.scenario.substring(0, 100)}`;
                    context += '\n';
                } else {
                    context += `- ${memberName}\n`;
                }
            });
        }
    }

    // Add Sticker Library
    if (myStickerList && myStickerList.length > 0) {
        context += `\n[可用表情包 (Sticker Library)]\n你可以使用以下表情包。发送表情包时，请严格使用 XML 格式：<msg t="时间" type="sticker">表情包名+后缀</msg>\n示例：<msg t="${getTime()}" type="sticker">抱抱31onrh.jpeg</msg>\n注意：不可捏造列表中没有的表情包和后缀，必须从以下列表中选择。不要使用方括号格式。\n`;
        myStickerList.forEach(s => {
            context += `- ${s.name}: ${s.url}\n`;
        });
    }

    // 5. Timezone / Time / Date Context
    const tzOffsetHours = getCharTimezoneOffset();
    const userDateObj = window.getSimulatedDate();
    const charDateObj = new Date(userDateObj.getTime() + tzOffsetHours * 3600000);
    const userDateStr = `${userDateObj.getFullYear()}年${userDateObj.getMonth() + 1}月${userDateObj.getDate()}日`;

    const charEraVal = localStorage.getItem('faye-custom-char-era');
    const charDateStr = (charEraVal && charEraVal.trim() !== '') ? charEraVal.trim() : `${charDateObj.getFullYear()}年${charDateObj.getMonth() + 1}月${charDateObj.getDate()}日`;

    const userTimeStr = getTime(true);
    const charTimeStr = getTime(false);

    context += `\n[日期与时间信息]\n`;
    const charName2 = getCharName();
    if (charEraVal && charEraVal.trim() !== '') {
        context += `用户当前实际系统时间: ${userDateStr} ${userTimeStr}\n`;
        context += `${charName2}身处特定的时期/纪元，其当前设定为：${charDateStr}，具体时分：${charTimeStr}。\n`;
        if (tzOffsetHours !== 0) {
            const absOffset = Math.abs(tzOffsetHours);
            const direction = tzOffsetHours > 0 ? '快' : '慢';
            context += `${charName2}所在时区与用户系统存在相对时差：当地时分比用户${direction}${absOffset}小时。\n`;
        }
        context += `请在对话中自然地体现出${charName2}特有的时代和背景设定（如科幻、修真、过去、异界），不要受用户现实世界日期的限制。\n`;
    } else if (tzOffsetHours !== 0) {
        const absOffset = Math.abs(tzOffsetHours);
        const direction = tzOffsetHours > 0 ? '快' : '慢';
        context += `${charName2}所在时区与用户存在时差：${charName2}的时间比用户${direction}${absOffset}小时。\n`;
        context += `用户当前时间: ${userDateStr} ${userTimeStr}\n`;
        context += `${charName2}当前时间: ${charDateStr} ${charTimeStr}\n`;
        context += `请在对话中自然地体现出时差感，注意根据${charName2}自己的当地时间（包括可能跨越0点造成的日期不同）来描述作息和环境。\n`;
    } else {
        context += `当前系统日期为 ${userDateStr}，时间是 ${userTimeStr}。\n`;
        context += `请在对话中参考这个时间设定相关的活动（例如节假日、特殊日期或早晚作息）。\n`;
    }

    return context.trim();
}

// DOM Elements (Initialized in init to be safe)
let phoneContainer, homeScreen, chatScreen, settingsScreen, messageListScreen, messageListBody, chatMessages, messageInput, sendButton, plusButton, emojiButton, actionMenu, emojiMenu, modal, modalTitle, modalInputsContainer, modalConfirmBtn, chatSettingsScreen, headerTitle, clockEl, homeClockEl, statusBar, photoInput, audioInput, videoInput, mediaPreviewBar, previewImage, previewFileIcon, adapterStatus, darkSearchScreen, darkSearchInput, diaryScreen, addContactModal, userSettingsScreen, userCreateModal;

// Functions
function showAddActionSheet() {
    const overlay = document.getElementById('add-action-sheet-overlay');
    const sheet = document.getElementById('add-action-sheet');
    if (overlay && sheet) {
        if (sheet.classList.contains('show')) {
            hideAddActionSheet();
        } else {
            overlay.classList.add('show');
            sheet.classList.add('show');
        }
    }
}

function hideAddActionSheet() {
    const overlay = document.getElementById('add-action-sheet-overlay');
    const sheet = document.getElementById('add-action-sheet');
    if (overlay && sheet) {
        overlay.classList.remove('show');
        sheet.classList.remove('show');
    }
}

function openAddContactModal(type = 'private') {
    console.log('openAddContactModal called with type:', type);
    hideAddActionSheet();

    // Robustly get modal if global var is missing
    if (!addContactModal) {
        addContactModal = document.getElementById('add-contact-modal');
    }

    if (addContactModal) {
        addContactModal.classList.add('show');

        // Reset inputs
        const groupNameInput = document.getElementById('group-name-input');
        if (groupNameInput) groupNameInput.value = '';

        // Show/Hide sections based on type
        const privateSection = document.getElementById('add-contact-private-section');
        const groupSection = document.getElementById('add-contact-group-section');
        const title = document.getElementById('add-contact-title');

        if (type === 'private') {
            if (privateSection) privateSection.style.display = 'block';
            if (groupSection) groupSection.style.display = 'none';
            if (title) title.textContent = '发起私聊';
            populatePrivateChatSelects();
        } else {
            if (privateSection) privateSection.style.display = 'none';
            if (groupSection) groupSection.style.display = 'block';
            if (title) title.textContent = '发起群聊';
            populateGroupChatSelects();
        }
    } else {
        console.error('Add Contact Modal not found!');
    }
}

function populatePrivateChatSelects() {
    const userSelect = document.getElementById('private-chat-user-select');
    const npcSelect = document.getElementById('private-chat-npc-select');

    if (!userSelect || !npcSelect) return;

    userSelect.innerHTML = '<option value="">请选择用户...</option>';
    npcSelect.innerHTML = '<option value="">请选择角色...</option>';

    // Populate Users
    if (userCharacters && Array.isArray(userCharacters)) {
        userCharacters.forEach((user, index) => {
            const option = document.createElement('option');
            option.value = index; // Use index as value
            option.textContent = user.name || `User ${index + 1}`;
            if (appSettings.currentUserId === index) {
                option.selected = true;
            }
            userSelect.appendChild(option);
        });
    }

    // Populate NPCs
    if (npcCharacters && Array.isArray(npcCharacters)) {
        npcCharacters.forEach((npc, index) => {
            const option = document.createElement('option');
            option.value = index; // Use index as value
            option.textContent = npc.name || `NPC ${index + 1}`;
            npcSelect.appendChild(option);
        });
    }
}

function populateGroupChatSelects() {
    const userSelect = document.getElementById('group-chat-user-select');
    const npcSelectList = document.getElementById('group-npc-select-list');

    if (!userSelect) return;

    userSelect.innerHTML = '<option value="">请选择...</option>';

    // Populate Users
    if (userCharacters && Array.isArray(userCharacters)) {
        userCharacters.forEach((user, index) => {
            const option = document.createElement('option');
            option.value = index;
            option.textContent = user.name || `User ${index + 1}`;
            if (appSettings.currentUserId === index) {
                option.selected = true;
            }
            userSelect.appendChild(option);
        });
    }

    // Reset NPC select list and add one default row
    if (npcSelectList) {
        npcSelectList.innerHTML = '';
        if (npcCharacters && npcCharacters.length > 0) {
            addGroupNpcSelect();
        } else {
            npcSelectList.innerHTML = '<div class="group-npc-empty-hint">暂无可选角色，请先创建角色~</div>';
        }
    }
}

// 获取已选中的NPC索引列表
function getSelectedNpcIndices() {
    const selectList = document.getElementById('group-npc-select-list');
    if (!selectList) return [];
    const selects = selectList.querySelectorAll('select');
    const selected = [];
    selects.forEach(sel => {
        if (sel.value !== '') {
            selected.push(parseInt(sel.value));
        }
    });
    return selected;
}

// 添加一个新的NPC角色下拉框
function addGroupNpcSelect() {
    const selectList = document.getElementById('group-npc-select-list');
    if (!selectList) return;

    // 移除空状态提示
    const emptyHint = selectList.querySelector('.group-npc-empty-hint');
    if (emptyHint) emptyHint.remove();

    // 获取已被选中的NPC索引
    const selectedIndices = getSelectedNpcIndices();

    // 检查是否还有可选角色
    const availableNpcs = (npcCharacters || []).filter((_, idx) => !selectedIndices.includes(idx));
    if (availableNpcs.length === 0) {
        showToast('所有角色都已添加啦~');
        return;
    }

    const row = document.createElement('div');
    row.className = 'group-npc-row';

    const select = document.createElement('select');
    select.className = 'group-modal-select';
    select.innerHTML = '<option value="">请选择角色...</option>';

    // 只显示未被选中的角色
    if (npcCharacters && Array.isArray(npcCharacters)) {
        npcCharacters.forEach((npc, index) => {
            if (!selectedIndices.includes(index)) {
                const option = document.createElement('option');
                option.value = index;
                option.textContent = npc.name || `NPC ${index + 1}`;
                select.appendChild(option);
            }
        });
    }

    // 当选择改变时，更新其他下拉框的可选项
    select.addEventListener('change', () => {
        refreshGroupNpcOptions();
    });

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'group-npc-remove-btn';
    removeBtn.innerHTML = '×';
    removeBtn.onclick = function () {
        row.style.animation = 'npcRowSlideIn 0.2s ease reverse';
        setTimeout(() => {
            row.remove();
            refreshGroupNpcOptions();
            // 如果没有行了，显示空状态
            if (selectList.children.length === 0) {
                selectList.innerHTML = '<div class="group-npc-empty-hint">点击上方 "添加" 按钮添加群成员~</div>';
            }
        }, 180);
    };

    row.appendChild(select);
    row.appendChild(removeBtn);
    selectList.appendChild(row);

    // 滚动到底部
    selectList.scrollTop = selectList.scrollHeight;
}

// 刷新所有NPC下拉框的可选项（排除已被其他行选中的）
function refreshGroupNpcOptions() {
    const selectList = document.getElementById('group-npc-select-list');
    if (!selectList) return;

    const allSelects = selectList.querySelectorAll('select');

    // 收集每个 select 的当前选中值
    const currentValues = [];
    allSelects.forEach(sel => {
        currentValues.push(sel.value);
    });

    // 对每个 select 重新填充 options
    allSelects.forEach((sel, i) => {
        const myValue = currentValues[i];
        // 其他行已选中的值（排除自己）
        const othersSelected = currentValues.filter((v, j) => j !== i && v !== '').map(v => parseInt(v));

        sel.innerHTML = '<option value="">请选择角色...</option>';
        if (npcCharacters && Array.isArray(npcCharacters)) {
            npcCharacters.forEach((npc, index) => {
                if (!othersSelected.includes(index)) {
                    const option = document.createElement('option');
                    option.value = index;
                    option.textContent = npc.name || `NPC ${index + 1}`;
                    if (String(index) === myValue) {
                        option.selected = true;
                    }
                    sel.appendChild(option);
                }
            });
        }
    });
}

function closeAddContactModal() {
    if (addContactModal) addContactModal.classList.remove('show');
}


function switchContactTab() {
    // Stub - no longer needed
}

function renderGroupInputs() {
    // No longer needed with new select-based UI
}

function addGroupNameRow(container, focus = false, value = '', removable = true) {
    const row = document.createElement('div');
    row.className = 'group-name-row';
    row.style.display = 'flex';
    // 垂直居中对齐，减小间距，让按钮更靠近输入框
    row.style.alignItems = 'center';
    row.style.gap = '6px';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'modal-input group-input-item';
    input.placeholder = `成员 名字`;
    input.value = value || '';
    input.style.flex = '1';
    input.style.minWidth = '0';
    input.style.boxSizing = 'border-box';

    const btnAdd = document.createElement('button');
    btnAdd.type = 'button';
    btnAdd.className = 'modal-btn group-add-btn';
    btnAdd.textContent = '+';
    // 更小、更紧凑的样式
    btnAdd.style.width = '30px';
    btnAdd.style.height = '28px';
    btnAdd.style.padding = '2px';
    btnAdd.style.fontSize = '14px';
    btnAdd.style.background = 'transparent';
    btnAdd.style.border = 'none';
    btnAdd.style.cursor = 'pointer';
    btnAdd.style.display = 'inline-flex';
    btnAdd.style.alignItems = 'center';
    btnAdd.style.justifyContent = 'center';
    btnAdd.style.borderRadius = '6px';
    btnAdd.onclick = (e) => { e.preventDefault(); addGroupNameRow(container, true, '', true); };

    row.appendChild(input);
    row.appendChild(btnAdd);
    // 如果可移除，则添加减号按钮；首行 removable=false 时不添加
    // 按钮尺寸统一，首行如果不可删除则插入占位元素保证输入框宽度一致
    if (removable) {
        const btnRemove = document.createElement('button');
        btnRemove.type = 'button';
        btnRemove.className = 'modal-btn group-remove-btn';
        btnRemove.textContent = '−';
        btnRemove.style.width = '30px';
        btnRemove.style.height = '28px';
        btnRemove.style.padding = '2px';
        btnRemove.style.fontSize = '14px';
        btnRemove.style.background = 'transparent';
        btnRemove.style.border = 'none';
        btnRemove.style.cursor = 'pointer';
        btnRemove.style.display = 'inline-flex';
        btnRemove.style.alignItems = 'center';
        btnRemove.style.justifyContent = 'center';
        btnRemove.style.borderRadius = '6px';
        btnRemove.onclick = (e) => { e.preventDefault(); if (row.parentNode) row.parentNode.removeChild(row); };
        row.appendChild(btnRemove);
    } else {
        // 插入一个占位宽度，与删除按钮宽度一致，保证输入框长度相同
        const spacer = document.createElement('div');
        spacer.style.width = '30px';
        spacer.style.height = '28px';
        spacer.style.display = 'inline-block';
        row.appendChild(spacer);
    }
    container.appendChild(row);

    if (focus) input.focus();
}

function confirmAddContact() {
    const isGroup = document.getElementById('add-contact-group-section').style.display === 'block';
    let targetName = '';
    let targetTag = '';

    if (isGroup) {
        // 群聊逻辑
        const groupName = document.getElementById('group-name-input').value.trim();
        if (!groupName) {
            showToast('请输入群聊名称');
            return;
        }

        const userSelect = document.getElementById('group-chat-user-select');

        if (!userSelect.value) {
            showToast('请选择群主');
            return;
        }

        const names = [];

        // Add User (Owner)
        const userIndex = parseInt(userSelect.value);
        if (userCharacters[userIndex]) {
            names.push(userCharacters[userIndex].name);
            // Update current user to the selected group owner
            appSettings.currentUserId = userIndex;
        }

        // Add NPCs from dynamic select list
        const selectedNpcIndices = getSelectedNpcIndices();
        selectedNpcIndices.forEach(npcIndex => {
            if (npcCharacters[npcIndex]) {
                names.push(npcCharacters[npcIndex].name);
            }
        });

        if (names.length < 2) {
            showToast('群聊至少需要2个成员');
            return;
        }

        // 保存群组信息 (用于备份成员列表，匹配以群名为准)
        if (!appSettings.groups) appSettings.groups = [];
        const existing = appSettings.groups.find(g => g.name === groupName);
        if (!existing) {
            appSettings.groups.push({ name: groupName, members: names });
        } else {
            // 更新成员列表
            existing.members = names;
        }

        targetName = groupName;
        // 构造群聊标签: 不再包含人数
        targetTag = `group:${groupName}`;

        // 绑定userId到此群聊（每个聊天独立隔离）
        if (!appSettings.chatUserIds) appSettings.chatUserIds = {};
        appSettings.chatUserIds[targetTag] = userIndex;
        saveSettingsToStorage();

    } else {
        // 私聊逻辑
        const userSelect = document.getElementById('private-chat-user-select');
        const npcSelect = document.getElementById('private-chat-npc-select');

        if (userSelect.value === '' || npcSelect.value === '') {
            showToast('请选择用户和角色');
            return;
        }

        const userIndex = parseInt(userSelect.value);
        const npcIndex = parseInt(npcSelect.value);

        // Update current user
        appSettings.currentUserId = userIndex;

        // Get NPC name
        // if (!appSettings.npcCharacters) appSettings.npcCharacters = [];
        const npc = npcCharacters[npcIndex];
        if (!npc) {
            console.error('NPC not found at index:', npcIndex);
            return;
        }

        targetName = npc.name;
        targetTag = `chat:${targetName}`;

        // 绑定userId到此私聊（每个聊天独立隔离）
        if (!appSettings.chatUserIds) appSettings.chatUserIds = {};
        appSettings.chatUserIds[targetTag] = userIndex;

        // NEW: 持久化保存私聊联系人
        if (!appSettings.privateChats) appSettings.privateChats = [];
        if (!appSettings.privateChats.includes(targetName)) {
            appSettings.privateChats.push(targetName);
        }
        saveSettingsToStorage();
    }

    closeAddContactModal();
    openChat(targetTag, targetName);
}





function openMessageList() {
    if (homeScreen) homeScreen.style.display = 'none';
    if (messageListScreen) messageListScreen.style.display = 'flex';
    updateStatusBar('message-list');
    renderMessageList();
}

function switchNavTab(tab) {
    // Remove active class from all nav items
    const navItems = document.querySelectorAll('.nav-item');
    navItems.forEach(item => item.classList.remove('active'));

    // Add active class to clicked nav item
    const activeItem = document.querySelector(`.nav-item[onclick="switchNavTab('${tab}')"]`);
    if (activeItem) activeItem.classList.add('active');

    // Hide all bodies
    const messageListBody = document.getElementById('message-list-body');
    const contactsListBody = document.getElementById('contacts-list-body');
    const momentsBody = document.getElementById('moments-body');
    const meBody = document.getElementById('me-body');

    if (messageListBody) messageListBody.style.display = 'none';
    if (contactsListBody) contactsListBody.style.display = 'none';
    if (momentsBody) momentsBody.style.display = 'none';
    if (meBody) meBody.style.display = 'none';

    // Header visibility: hide for moments
    const appHeader = document.querySelector('#message-list-screen > .app-header');
    if (appHeader) {
        appHeader.style.display = (tab === 'moments') ? 'none' : '';
    }

    // Show selected body
    if (tab === 'message') {
        if (messageListBody) messageListBody.style.display = 'block';
        renderMessageList();
    } else if (tab === 'contacts') {
        if (contactsListBody) contactsListBody.style.display = 'block';
        renderContacts();
    } else if (tab === 'moments') {
        if (momentsBody) momentsBody.style.display = 'block';
        renderMoments();
    } else if (tab === 'me') {
        if (meBody) meBody.style.display = 'block';
        // renderMe(); // Not implemented yet
    }

    // Update header title
    const headerTitle = document.getElementById('message-list-header-title');
    if (headerTitle) {
        if (tab === 'message') headerTitle.textContent = '消息列表';
        else if (tab === 'contacts') headerTitle.textContent = '通讯录';
        else if (tab === 'moments') headerTitle.textContent = '动态';
        else if (tab === 'me') headerTitle.textContent = '我';
    }
}

async function openChat(targetTag, targetName) {
    // If no target is specified, do nothing in standalone mode.
    if (!targetTag) {
        console.warn("openChat called without a target in standalone mode.");
        return;
    }

    currentChatTag = targetTag;
    currentChatTarget = targetName;

    // Clear unread count for this chat
    localStorage.removeItem(`unread-${targetTag}`);

    // 恢复此聊天绑定的 userId（每个聊天独立隔离）
    if (appSettings.chatUserIds && appSettings.chatUserIds[targetTag] !== undefined) {
        const boundUserId = appSettings.chatUserIds[targetTag];
        if (userCharacters[boundUserId]) {
            appSettings.currentUserId = boundUserId;
            appSettings.userAvatar = userCharacters[boundUserId].avatar || '';
        }
    } else if (userCharacters && userCharacters.length > 0) {
        // 没有显式绑定：尝试从聊天历史推断用户
        let inferredUserId = undefined;
        try {
            const history = await getChatHistory(targetTag);
            if (history && Array.isArray(history)) {
                // 从用户消息的header中提取名字并匹配
                for (const msg of history) {
                    if (msg.isUser && msg.header) {
                        const parts = msg.header.replace(/^[\[【]|[\]】]$/g, '').split('|');
                        const senderName = parts[0] ? parts[0].trim() : '';
                        if (senderName) {
                            const matchIndex = userCharacters.findIndex(u => u.name === senderName);
                            if (matchIndex >= 0) {
                                inferredUserId = matchIndex;
                                break;
                            }
                        }
                    }
                }
            }
        } catch (e) { /* ignore parsing errors */ }

        // 绑定推断出的用户或当前全局用户
        if (!appSettings.chatUserIds) appSettings.chatUserIds = {};
        if (inferredUserId !== undefined) {
            appSettings.chatUserIds[targetTag] = inferredUserId;
            appSettings.currentUserId = inferredUserId;
            appSettings.userAvatar = userCharacters[inferredUserId].avatar || '';
        } else {
            // 无法推断，绑定当前全局用户以保持一致性
            const globalId = appSettings.currentUserId !== undefined ? appSettings.currentUserId : 0;
            if (userCharacters[globalId]) {
                appSettings.chatUserIds[targetTag] = globalId;
            }
        }
        saveSettingsToStorage();
    }

    // 恢复此聊天的拉黑状态（每个聊天独立隔离）
    appSettings.blockChar = getChatBlockChar();
    appSettings.blockUser = getChatBlockUser();

    // FIX: Update appSettings.charAvatar based on the target
    // Default to global setting
    let newAvatar = appSettings.charAvatar || defaultAppSettings.charAvatar;

    // But try to find specific if we are in a chat
    if (targetTag.startsWith('chat:')) {
        // 1. Try to find in NPCs
        const npc = npcCharacters.find(n => n.name === targetName);
        if (npc && npc.avatar) {
            newAvatar = npc.avatar;
        } else {
            // 2. Try to find in Users (Private Chat with another user?)
            const user = userCharacters.find(u => u.name === targetName);
            if (user && user.avatar) {
                newAvatar = user.avatar;
            }
        }
    }
    // Update the setting used by renderMessageToUI
    appSettings.charAvatar = newAvatar;


    // 更新标题（支持备注）
    updateHeaderTitle();

    // 刷新聊天内容
    if (typeof loadInitialChat === 'function') loadInitialChat();

    // 从消息列表进入聊天
    if (messageListScreen) messageListScreen.style.display = 'none';
    if (chatScreen) chatScreen.style.display = 'flex';
    updateStatusBar('chat');

    // 恢复线下交流模式状态
    loadOfflineModeForChat();

    // Force style re-application after rendering
    setTimeout(() => {
        applySettings();
        if (chatMessages) chatMessages.scrollTop = chatMessages.scrollHeight;
    }, 300);
}

function goBack() {
    closeMenus();

    // User Create -> User Settings
    const userCreateScreen = document.getElementById('user-create-screen');
    if (userCreateScreen && userCreateScreen.style.display === 'flex') {
        closeUserCreatePage();
        return;
    }

    // NPC Create -> NPC Settings
    const npcCreateScreen = document.getElementById('npc-create-screen');
    if (npcCreateScreen && npcCreateScreen.style.display === 'flex') {
        closeNpcCreatePage();
        return;
    }

    // Worldbook Edit -> Worldbook List
    const wbEditScreen = document.getElementById('worldbook-edit-screen');
    if (wbEditScreen && wbEditScreen.style.display === 'flex') {
        closeWorldbookEdit();
        return;
    }

    // Worldbook List -> Home
    const wbListScreen = document.getElementById('worldbook-list-screen');
    if (wbListScreen && wbListScreen.style.display === 'flex') {
        closeWorldbookList();
        return;
    }

    // Character Setup (NPC列表) -> Home
    const setupScreen = document.getElementById('character-setup-screen');
    if (setupScreen && setupScreen.style.display === 'flex') {
        setupScreen.style.display = 'none';
        if (homeScreen) homeScreen.style.display = 'flex';
        updateStatusBar('home');
        return;
    }

    if (chatSettingsScreen && chatSettingsScreen.style.display === 'flex') {
        closeChatSettings();
        return;
    }

    if (chatScreen && chatScreen.style.display === 'flex') {
        // 从聊天返回消息列表
        chatScreen.style.display = 'none';
        if (messageListScreen) messageListScreen.style.display = 'flex';
        updateStatusBar('message-list');
        renderMessageList(); // 刷新预览
        return;
    }

    if (messageListScreen && messageListScreen.style.display === 'flex') {
        // 从消息列表返回主屏幕
        messageListScreen.style.display = 'none';
        if (homeScreen) homeScreen.style.display = 'flex';
        updateStatusBar('home');
        return;
    }

    if (settingsScreen && settingsScreen.style.display === 'flex') {
        saveTimeSettings();
        settingsScreen.style.display = 'none';
        if (homeScreen) homeScreen.style.display = 'flex';
        updateStatusBar('home');
        return;
    }

    const beautifyScreenBack = document.getElementById('beautify-screen');
    if (beautifyScreenBack && beautifyScreenBack.style.display === 'flex') {
        beautifyScreenBack.style.display = 'none';
        if (settingsScreen) settingsScreen.style.display = 'flex';
        updateStatusBar('settings');
        return;
    }

    const apiSettingsScreenBack = document.getElementById('api-settings-screen');
    if (apiSettingsScreenBack && apiSettingsScreenBack.style.display === 'flex') {
        apiSettingsScreenBack.style.display = 'none';
        if (settingsScreen) settingsScreen.style.display = 'flex';
        updateStatusBar('settings');
        return;
    }

    const dataSettingsScreenBack = document.getElementById('data-settings-screen');
    if (dataSettingsScreenBack && dataSettingsScreenBack.style.display === 'flex') {
        dataSettingsScreenBack.style.display = 'none';
        if (settingsScreen) settingsScreen.style.display = 'flex';
        updateStatusBar('settings');
        return;
    }

    const naiSettingsScreenBack = document.getElementById('nai-settings-screen');
    if (naiSettingsScreenBack && naiSettingsScreenBack.style.display === 'flex') {
        naiSettingsScreenBack.style.display = 'none';
        if (settingsScreen) settingsScreen.style.display = 'flex';
        updateStatusBar('settings');
        return;
    }

    const ttsSettingsScreenBack = document.getElementById('tts-settings-screen');
    if (ttsSettingsScreenBack && ttsSettingsScreenBack.style.display === 'flex') {
        ttsSettingsScreenBack.style.display = 'none';
        if (settingsScreen) settingsScreen.style.display = 'flex';
        updateStatusBar('settings');
        return;
    }

    const stickerSettingsScreenBack = document.getElementById('sticker-settings-screen');
    if (stickerSettingsScreenBack && stickerSettingsScreenBack.style.display === 'flex') {
        stickerSettingsScreenBack.style.display = 'none';
        if (settingsScreen) settingsScreen.style.display = 'flex';
        updateStatusBar('settings');
        return;
    }

    const toySettingsScreenBack = document.getElementById('toy-settings-screen');
    if (toySettingsScreenBack && toySettingsScreenBack.style.display === 'flex') {
        toySettingsScreenBack.style.display = 'none';
        if (settingsScreen) settingsScreen.style.display = 'flex';
        updateStatusBar('settings');
        return;
    }

    // Regex Screen -> Home
    const regexScreenBack = document.getElementById('regex-screen');
    if (regexScreenBack && regexScreenBack.style.display === 'flex') {
        closeRegexScreen();
        return;
    }

    if (userSettingsScreen && userSettingsScreen.style.display === 'flex') {
        userSettingsScreen.style.display = 'none';
        if (_userSettingsFrom === 'settings') {
            if (settingsScreen) settingsScreen.style.display = 'flex';
            updateStatusBar('settings');
        } else {
            if (homeScreen) homeScreen.style.display = 'flex';
            updateStatusBar('home');
        }
        return;
    }

    // Fallback
    if (homeScreen) homeScreen.style.display = 'flex';
    updateStatusBar('home');
}

// 辅助函数：从历史记录字符串中提取所有聊天块

async function renderMessageList() {
    if (!messageListBody) return;
    messageListBody.innerHTML = '';

    const placeholderAvatar = "data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='%23cccccc'%3E%3Cpath d='M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z'/%3E%3C/svg%3E";

    let conversations = [];

    // Load groups from settings
    if (appSettings.groups && Array.isArray(appSettings.groups)) {
        appSettings.groups.forEach(group => {
            const key = `group:${group.name}`;
            let groupAvatar = (appSettings.groupAvatars && appSettings.groupAvatars[key]) ? appSettings.groupAvatars[key] : placeholderAvatar;
            conversations.push({
                tag: key,
                name: group.name,
                avatar: groupAvatar,
                lastMsg: '点击进入群聊',
                lastTime: '',
                isGroup: true,
            });
        });
    }

    // Load private chats from settings
    if (appSettings.privateChats && Array.isArray(appSettings.privateChats)) {
        appSettings.privateChats.forEach(name => {
            const key = `chat:${name}`;

            // UNIFIED LOGIC: Prioritize NPC/User avatar
            let memberAvatar = placeholderAvatar;

            // 1. Try Find NPC
            const npc = npcCharacters.find(n => n.name === name);
            if (npc && npc.avatar) {
                memberAvatar = npc.avatar;
            } else {
                // 2. Try Find User (Private Chat with another user)
                const user = userCharacters.find(u => u.name === name);
                if (user && user.avatar) {
                    memberAvatar = user.avatar;
                }
            }

            // 3. Fallback to memberAvatars (legacy/renamed)
            if (memberAvatar === placeholderAvatar && appSettings.memberAvatars && appSettings.memberAvatars[name]) {
                memberAvatar = appSettings.memberAvatars[name];
            }

            conversations.push({
                tag: key,
                name: name,
                avatar: memberAvatar,
                lastMsg: '点击开始聊天',
                lastTime: '',
                isGroup: false
            });
        });
    }

    // Function to get a simplified message preview
    const getPreviewText = (msg) => {
        if (!msg) return '';
        if (msg.type === 'sticker') return '[表情包]';
        if (msg.type === 'photo') return '[图片]';
        if (msg.type === 'voice') return '[语音]';
        if (msg.type === 'video') return '[视频]';
        if (msg.type === 'file') return '[文件]';
        if (msg.type === 'location') return '[位置]';
        if (msg.type === 'music') return '[音乐]';

        const body = msg.body || '';
        if (body.includes('[') && body.includes(']')) {
            if (body.includes('|图片|')) return '[图片]';
            if (body.includes('|语音|')) return '[语音]';
            if (body.includes('|视频|')) return '[视频]';
            if (body.includes('|文件|')) return '[文件]';
            if (body.includes('|位置|')) return '[位置]';
            if (body.includes('|转账|') || body.includes('|TRANS|')) return '[转账]';
            if (body.includes('|表情包|')) return '[表情包]';
            if (body.includes('|MUSIC|')) return '[音乐]';
        }
        // Strip quotes and return a snippet
        return body.replace(/「`回复.*?`」/g, '').trim().substring(0, 50);
    };

    // Pre-fetch all chat histories from IndexedDB
    for (const chat of conversations) {
        try {
            const history = await getChatHistory(chat.tag);
            if (history && Array.isArray(history) && history.length > 0) {
                const lastMessage = history[history.length - 1];
                chat.lastMsg = getPreviewText(lastMessage);
                const timeMatch = lastMessage.header ? lastMessage.header.match(/\|\s*(\d{1,2}:\d{2})/) : null;
                chat.lastTime = timeMatch ? timeMatch[1] : '';
            }
        } catch (e) { /* Ignore errors */ }
    }

    // Render List
    conversations.forEach(chat => {
        const item = document.createElement('div');
        item.className = 'message-list-item';

        let displayAvatar = chat.avatar;
        const unreadCount = parseInt(localStorage.getItem(`unread-${chat.tag}`) || '0');
        const unreadBadge = unreadCount > 0 ? `<span class="unread-badge" style="position:absolute;top:8px;right:8px;min-width:18px;height:18px;line-height:18px;border-radius:9px;background:#e53935;color:#fff;font-size:11px;text-align:center;padding:0 5px;box-sizing:border-box;">${unreadCount > 99 ? '99+' : unreadCount}</span>` : '';

        item.style.position = 'relative';
        item.innerHTML = `
            <img class="message-list-avatar" src="${displayAvatar}">
            <div class="message-list-info">
                <div class="message-list-top">
                    <span class="message-list-name">${chat.name} ${chat.isGroup ? '<span class="group-badge">群</span>' : ''}</span>
                    <span class="message-list-time">${chat.lastTime || ''}</span>
                </div>
                <div class="message-list-preview">${chat.lastMsg}</div>
            </div>
            ${unreadBadge}
        `;

        let pressTimer = null;
        let isDragging = false;
        item.addEventListener('touchstart', (e) => {
            isDragging = false;
            pressTimer = setTimeout(() => {
                if (!isDragging) showGlobalDeleteMenu('与 ' + chat.name + ' 的聊天', () => {
                    if (chat.tag.startsWith('chat:')) {
                        const name = chat.tag.replace('chat:', '');
                        if (appSettings.privateChats) appSettings.privateChats = appSettings.privateChats.filter(n => n !== name);
                    } else if (chat.tag.startsWith('group:')) {
                        const groupName = chat.tag.replace(/^group:/, '');
                        if (appSettings.groups) appSettings.groups = appSettings.groups.filter(g => g.name !== groupName);
                    }
                    saveSettingsToStorage();
                    deleteChatHistory(chat.tag).catch(e => console.error(e));
                    renderMessageList();
                });
            }, 600);
        }, { passive: true });
        item.addEventListener('touchmove', () => { isDragging = true; clearTimeout(pressTimer); }, { passive: true });
        item.addEventListener('touchend', () => { clearTimeout(pressTimer); });
        item.addEventListener('touchcancel', () => { clearTimeout(pressTimer); });

        item.oncontextmenu = (e) => {
            e.preventDefault();
            showGlobalDeleteMenu('与 ' + chat.name + ' 的聊天', () => {
                if (chat.tag.startsWith('chat:')) {
                    const name = chat.tag.replace('chat:', '');
                    if (appSettings.privateChats) appSettings.privateChats = appSettings.privateChats.filter(n => n !== name);
                } else if (chat.tag.startsWith('group:')) {
                    const groupName = chat.tag.replace(/^group:/, '');
                    if (appSettings.groups) appSettings.groups = appSettings.groups.filter(g => g.name !== groupName);
                }
                saveSettingsToStorage();
                deleteChatHistory(chat.tag).catch(e => console.error(e));
                renderMessageList();
            });
        };
        item.onclick = () => openChat(chat.tag, chat.name);
        messageListBody.appendChild(item);
    });
}

function renderContacts() {
    const contactsListBody = document.getElementById('contacts-list-body');
    if (!contactsListBody) return;
    contactsListBody.innerHTML = '';

    // New Friends section
    const newFriendsItem = document.createElement('div');
    newFriendsItem.className = 'contacts-section-item';
    newFriendsItem.onclick = () => openNewFriends();

    // Check if there are pending friend requests
    const hasRequests = (appSettings.friendRequests && appSettings.friendRequests.length > 0);

    newFriendsItem.innerHTML = `
            <div class="contacts-item-content">
                <div class="contacts-item-icon">
                    <div class="contacts-icon-image" style="-webkit-mask-image: url('https://api.iconify.design/ri:user-add-line.svg'); mask-image: url('https://api.iconify.design/ri:user-add-line.svg');"></div>
                </div>
                <span class="contacts-item-name">新的朋友</span>
                ${hasRequests ? '<div class="red-dot"></div>' : ''}
            </div>
            <div class="contacts-arrow">›</div>
        `;
    contactsListBody.appendChild(newFriendsItem);

    // Groups section
    const groupsItem = document.createElement('div');
    groupsItem.className = 'contacts-section-item';
    groupsItem.onclick = () => openGroupsList();

    const groupCount = (appSettings.groups && appSettings.groups.length) || 0;

    groupsItem.innerHTML = `
            <div class="contacts-item-content">
                <div class="contacts-item-icon">
                    <div class="contacts-icon-image" style="-webkit-mask-image: url('https://api.iconify.design/ri:group-line.svg'); mask-image: url('https://api.iconify.design/ri:group-line.svg');"></div>
                </div>
                <span class="contacts-item-name">群聊</span>
                <span class="contacts-item-count">${groupCount}</span>
            </div>
            <div class="contacts-arrow">›</div>
        `;
    contactsListBody.appendChild(groupsItem);

    // Separator
    const separator = document.createElement('div');
    separator.className = 'contacts-separator';
    contactsListBody.appendChild(separator);

    // Private contacts
    const placeholderAvatar = "data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='%23cccccc'%3E%3Cpath d='M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z'/%3E%3C/svg%3E";

    function getInitial(str) {
        if (!str) return '#';
        const char = str.charAt(0);
        if (/[a-zA-Z]/.test(char)) return char.toUpperCase();
        const letters = 'ABCDEFGHJKLMNOPQRSTWXYZ'.split('');
        const zh = '阿八嚓哒妸发旮哈讥咔垃妈拏噢妑七呥扨它穵夕丫帀'.split('');
        if (char.localeCompare('阿', 'zh-Hans-CN') < 0 || char.localeCompare('帀', 'zh-Hans-CN') > 0) return '#';
        for (let i = 0; i < zh.length - 1; i++) {
            if (char.localeCompare(zh[i], 'zh-Hans-CN') >= 0 && char.localeCompare(zh[i + 1], 'zh-Hans-CN') < 0) {
                return letters[i];
            }
        }
        if (char.localeCompare('帀', 'zh-Hans-CN') >= 0 && char.localeCompare('咗', 'zh-Hans-CN') < 0) return 'Z';
        return '#';
    }

    if (appSettings.privateChats && Array.isArray(appSettings.privateChats)) {
        const grouped = {};
        appSettings.privateChats.forEach(name => {
            let initial = getInitial(name);
            if (!grouped[initial]) grouped[initial] = [];
            grouped[initial].push(name);
        });

        const keys = Object.keys(grouped).sort((a, b) => {
            if (a === '#') return 1;
            if (b === '#') return -1;
            return a.localeCompare(b);
        });

        keys.forEach(key => {
            const header = document.createElement('div');
            header.className = 'contacts-index-header';
            header.textContent = key;
            contactsListBody.appendChild(header);

            grouped[key].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));

            grouped[key].forEach(name => {
                const contactItem = document.createElement('div');
                contactItem.className = 'contacts-contact-item';
                contactItem.onclick = () => openChat(`chat:${name}`, name);

                // Get avatar
                let contactAvatar = placeholderAvatar;
                const npc = npcCharacters.find(n => n.name === name);
                if (npc && npc.avatar) {
                    contactAvatar = npc.avatar;
                } else {
                    const user = userCharacters.find(u => u.name === name);
                    if (user && user.avatar) {
                        contactAvatar = user.avatar;
                    }
                }

                contactItem.innerHTML = `
                        <img class="contacts-contact-avatar" src="${contactAvatar}">
                        <span class="contacts-contact-name">${name}</span>
                        <div class="contacts-arrow">›</div>
                    `;
                contactsListBody.appendChild(contactItem);
            });
        });
    }
}

function openNewFriends() {
    // Open new friends modal or screen
    // For now, show a simple alert
    if (appSettings.friendRequests && appSettings.friendRequests.length > 0) {
        showFriendRequestsModal();
    } else {
        showToast('暂无新的朋友申请');
    }
}

function openGroupsList() {
    // Open groups list modal or screen
    showGroupsListModal();
}

function showFriendRequestsModal() {
    // Create modal for friend requests
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.innerHTML = `
            <div class="modal-box group-modal-cute friend-requests-modal">
                <div class="modal-title group-modal-title">
                    新的朋友
                    <div class="modal-close" onclick="closeModal(this)" style="float: right; cursor: pointer; color: #999;">×</div>
                </div>
                <div class="modal-body" style="display: flex; flex-direction: column; gap: 10px;">
                    ${appSettings.friendRequests && appSettings.friendRequests.length > 0
            ? appSettings.friendRequests.map(request => `
                            <div class="friend-request-item" style="display: flex; justify-content: space-between; align-items: center; padding: 10px 0; border-bottom: 1px solid #eee;">
                                <div class="friend-request-info">
                                    <div class="friend-request-name" style="font-weight: bold; font-size: 15px;">${request.from}</div>
                                    <div class="friend-request-message" style="font-size: 13px; color: #666; margin-top: 4px;">${request.message || '申请加为好友'}</div>
                                    <div class="friend-request-time" style="font-size: 11px; color: #aaa; margin-top: 4px;">${new Date(request.timestamp).toLocaleString()}</div>
                                </div>
                                <div class="friend-request-actions" style="display: flex; gap: 8px;">
                                    <button class="modal-btn group-modal-cancel" style="padding: 6px 12px; font-size: 13px;" onclick="rejectFriendRequest('${request.from}')">拒绝</button>
                                    <button class="modal-btn group-modal-confirm" style="padding: 6px 12px; font-size: 13px;" onclick="acceptFriendRequest('${request.from}')">接受</button>
                                </div>
                            </div>
                        `).join('')
            : '<div class="no-requests" style="text-align: center; color: #999; padding: 20px 0;">暂无新的朋友申请</div>'
        }
                </div>
            </div>
        `;
    document.body.appendChild(modal);
    modal.classList.add('show');
}

function showGroupsListModal() {
    // Create modal for groups list
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.innerHTML = `
            <div class="modal-box group-modal-cute groups-list-modal">
                <div class="modal-title group-modal-title">
                    群聊列表
                    <div class="modal-close" onclick="closeModal(this)" style="float: right; cursor: pointer; color: #999;">×</div>
                </div>
                <div class="modal-body" style="display: flex; flex-direction: column; gap: 10px;">
                    ${appSettings.groups && appSettings.groups.length > 0
            ? appSettings.groups.map(group => `
                            <div class="group-list-item" style="display: flex; justify-content: space-between; align-items: center; padding: 12px 0; border-bottom: 1px solid #eee; cursor: pointer;" onclick="closeModal(this); openChat('group:${group.name}', '${group.name}')">
                                <div class="group-list-info">
                                    <div class="group-list-name" style="font-weight: bold; font-size: 15px;">${group.name}</div>
                                    <div class="group-list-members" style="font-size: 13px; color: #999; margin-top: 4px;">${group.members ? group.members.length : 0}人</div>
                                </div>
                                <div class="contacts-arrow" style="color: #ccc; font-size: 20px;">›</div>
                            </div>
                        `).join('')
            : '<div class="no-groups" style="text-align: center; color: #999; padding: 20px 0;">暂无群聊</div>'
        }
                </div>
            </div>
        `;
    document.body.appendChild(modal);
    modal.classList.add('show');
}

function acceptFriendRequest(from) {
    // Add to private chats
    if (!appSettings.privateChats.includes(from)) {
        appSettings.privateChats.push(from);
    }
    // Remove from requests
    appSettings.friendRequests = appSettings.friendRequests.filter(r => r.from !== from);
    saveSettingsToStorage();
    renderContacts();
    closeModal(document.querySelector('.friend-requests-modal'));
    showToast(`已接受 ${from} 的好友申请`);
}

function rejectFriendRequest(from) {
    // Remove from requests
    appSettings.friendRequests = appSettings.friendRequests.filter(r => r.from !== from);
    saveSettingsToStorage();
    renderContacts();
    closeModal(document.querySelector('.friend-requests-modal'));
    showToast(`已拒绝 ${from} 的好友申请`);
}

function openSettings() {
    if (homeScreen) homeScreen.style.display = 'none';
    if (settingsScreen) settingsScreen.style.display = 'flex';
    // 显示版本号
    const verEl = document.getElementById('settings-version-text');
    if (verEl) verEl.textContent = 'v' + APP_VERSION;
    updateStatusBar('settings');
}



function closeSettings() {
    if (settingsScreen) settingsScreen.style.display = 'none';
    if (homeScreen) homeScreen.style.display = 'flex';
    updateStatusBar('home');
}

function openApiSettings() {
    document.getElementById('set-api-endpoint').value = appSettings.apiEndpoint || 'https://api.openai.com/v1';
    document.getElementById('set-api-key').value = appSettings.apiKey || '';
    document.getElementById('set-api-model').innerHTML = `<option value="${appSettings.apiModel || 'gpt-3.5-turbo'}">${appSettings.apiModel || 'gpt-3.5-turbo'}</option>`;

    const temp = appSettings.apiTemperature !== undefined ? appSettings.apiTemperature : 1.0;
    document.getElementById('set-api-temp').value = temp;
    const tempDisplay = document.getElementById('temp-value-display');
    if (tempDisplay) tempDisplay.textContent = temp;

    // Populate API presets dropdown
    populateApiPresetList();

    if (settingsScreen) settingsScreen.style.display = 'none';
    const apiScreen = document.getElementById('api-settings-screen');
    if (apiScreen) apiScreen.style.display = 'flex';
    updateStatusBar('settings');
}

// --- API Preset Management ---
function populateApiPresetList() {
    const select = document.getElementById('api-preset-select');
    if (!select) return;
    const presets = appSettings.apiPresets || [];
    select.innerHTML = '<option value="">当前配置</option>';
    presets.forEach((p, i) => {
        const opt = document.createElement('option');
        opt.value = i;
        opt.textContent = p.name || `预设${i + 1}`;
        select.appendChild(opt);
    });
    select.value = '';
}

function applyApiPreset() {
    const select = document.getElementById('api-preset-select');
    if (!select || select.value === '') return;
    const idx = parseInt(select.value);
    const presets = appSettings.apiPresets || [];
    const preset = presets[idx];
    if (!preset) return;

    document.getElementById('set-api-endpoint').value = preset.endpoint || '';
    document.getElementById('set-api-key').value = preset.key || '';

    const modelSelect = document.getElementById('set-api-model');
    modelSelect.innerHTML = `<option value="${preset.model || 'gpt-3.5-turbo'}">${preset.model || 'gpt-3.5-turbo'}</option>`;

    const temp = preset.temperature !== undefined ? preset.temperature : 1.0;
    document.getElementById('set-api-temp').value = temp;
    const tempDisplay = document.getElementById('temp-value-display');
    if (tempDisplay) tempDisplay.textContent = temp;

    if (typeof showToast === 'function') showToast('已读取 API 预设，点击下方保存生效');
}

function saveApiPreset() {
    // Prompt for preset name
    const currentEndpoint = document.getElementById('set-api-endpoint').value.trim();
    const defaultName = currentEndpoint
        ? currentEndpoint.replace(/^https?:\/\//, '').replace(/\/.*$/, '').substring(0, 20)
        : '新预设';

    // Build a simple prompt overlay
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.35);backdrop-filter:blur(4px);';
    overlay.innerHTML = `
        <div style="background:#fff;border-radius:18px;padding:24px 20px;width:280px;max-width:85vw;box-shadow:0 8px 30px rgba(71, 71, 71, 1);">
            <div style="font-size:15px;font-weight:700;color:#333;text-align:center;margin-bottom:14px;">保存 API 预设</div>
            <input id="api-preset-name-input" type="text" value="${defaultName}" placeholder="预设名称"
                style="width:100%;padding:10px 12px;border:1px solid #eee;border-radius:10px;font-size:14px;box-sizing:border-box;outline:none;">
            <div style="display:flex;gap:10px;margin-top:14px;">
                <button id="api-preset-cancel" style="flex:1;padding:10px;border:none;border-radius:10px;background:#f5f5f5;font-size:13px;color:#999;cursor:pointer;">取消</button>
                <button id="api-preset-confirm" style="flex:1;padding:10px;border:none;border-radius:10px;background:#e8a0b4;font-size:13px;color:#fff;font-weight:600;cursor:pointer;">保存</button>
            </div>
        </div>`;
    document.body.appendChild(overlay);
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

    const nameInput = document.getElementById('api-preset-name-input');
    nameInput.focus();
    nameInput.select();

    document.getElementById('api-preset-cancel').onclick = () => overlay.remove();
    document.getElementById('api-preset-confirm').onclick = () => {
        const name = nameInput.value.trim() || defaultName;
        if (!appSettings.apiPresets) appSettings.apiPresets = [];

        const preset = {
            name,
            endpoint: document.getElementById('set-api-endpoint').value.trim(),
            key: document.getElementById('set-api-key').value.trim(),
            model: document.getElementById('set-api-model').value,
            temperature: parseFloat(document.getElementById('set-api-temp').value) || 1.0
        };

        // Check if preset name already exists -> overwrite
        const existIdx = appSettings.apiPresets.findIndex(p => p.name === name);
        if (existIdx >= 0) {
            appSettings.apiPresets[existIdx] = preset;
        } else {
            appSettings.apiPresets.push(preset);
        }

        saveSettingsToStorage();
        populateApiPresetList();
        overlay.remove();
        if (typeof showToast === 'function') showToast(`预设「${name}」已保存`);
    };

    nameInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') document.getElementById('api-preset-confirm').click();
    });
}

function deleteApiPreset() {
    // Deprecated via UI update
}

function closeApiSettings() {
    const apiScreen = document.getElementById('api-settings-screen');
    if (apiScreen) apiScreen.style.display = 'none';
    if (settingsScreen) settingsScreen.style.display = 'flex';
    updateStatusBar('settings');
}

function saveApiSettings() {
    appSettings.apiEndpoint = document.getElementById('set-api-endpoint').value;
    appSettings.apiKey = document.getElementById('set-api-key').value;
    appSettings.apiModel = document.getElementById('set-api-model').value;
    appSettings.apiTemperature = parseFloat(document.getElementById('set-api-temp').value);
    saveSettingsToStorage();
    closeApiSettings();
}

function openSystemSettings() {
    document.getElementById('set-debug-mode').checked = appSettings.debugMode || false;
    const keepAliveToggle = document.getElementById('set-keep-alive');
    if (keepAliveToggle) keepAliveToggle.checked = appSettings.keepAlive || false;
    const vconsoleToggle = document.getElementById('set-vconsole');
    if (vconsoleToggle) vconsoleToggle.checked = !!window.vConsoleLoaded;

    if (settingsScreen) settingsScreen.style.display = 'none';
    const sysScreen = document.getElementById('system-settings-screen');
    if (sysScreen) sysScreen.style.display = 'flex';
    updateStatusBar('settings');
}

function closeSystemSettings() {
    const sysScreen = document.getElementById('system-settings-screen');
    if (sysScreen) sysScreen.style.display = 'none';
    if (settingsScreen) settingsScreen.style.display = 'flex';
    updateStatusBar('settings');
}

function saveSystemSettings() {
    appSettings.debugMode = document.getElementById('set-debug-mode').checked;
    saveSettingsToStorage();
    closeSystemSettings();
}

// === Background Keep-Alive (防杀后台) ===
let _wakeLock = null;
let _keepAliveAudio = null;
let _keepAliveTimer = null;
let _keepAliveWorkerTimer = null;

function toggleKeepAlive() {
    const toggle = document.getElementById('set-keep-alive');
    if (!toggle) return;
    appSettings.keepAlive = toggle.checked;
    saveSettingsToStorage();
    if (toggle.checked) {
        startKeepAlive();
    } else {
        stopKeepAlive();
    }
}

function startKeepAlive() {
    const statusEl = document.getElementById('keep-alive-status');
    const activeMethods = [];

    // 1. Wake Lock API (prevents screen sleep on supported browsers)
    if ('wakeLock' in navigator) {
        navigator.wakeLock.request('screen').then(lock => {
            _wakeLock = lock;
            _wakeLock.addEventListener('release', () => {
                console.log('[KeepAlive] Wake Lock released');
                // Auto re-acquire on visibility change
            });
            console.log('[KeepAlive] Wake Lock acquired');
        }).catch(err => {
            console.warn('[KeepAlive] Wake Lock failed:', err);
        });
        activeMethods.push('屏幕唤醒');
    }

    // 2. Silent audio loop (keeps browser audio thread alive → prevents background throttle)
    try {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (AudioCtx) {
            const ctx = new AudioCtx();
            const oscillator = ctx.createOscillator();
            const gain = ctx.createGain();
            gain.gain.value = 0.001; // Nearly silent
            oscillator.connect(gain);
            gain.connect(ctx.destination);
            oscillator.start();
            _keepAliveAudio = { ctx, oscillator, gain };
            activeMethods.push('静音音频');
        }
    } catch (e) {
        console.warn('[KeepAlive] Audio context failed:', e);
    }

    // 3. Periodic timer (ping every 15s to keep JS engine active)
    _keepAliveTimer = setInterval(() => {
        // Touch localStorage to prevent it from being garbage collected
        try {
            localStorage.setItem('__keepalive_ping', Date.now().toString());
        } catch (e) { /* ignore */ }
    }, 15000);
    activeMethods.push('定时心跳');

    // 4. Re-acquire Wake Lock when page becomes visible again (after tab switch)
    document.addEventListener('visibilitychange', _onVisibilityChangeKeepAlive);

    if (statusEl) {
        statusEl.style.display = 'block';
        statusEl.textContent = '✓ 已启用: ' + activeMethods.join(' + ');
        statusEl.style.color = '#4CAF50';
    }

    console.log('[KeepAlive] Started with:', activeMethods.join(', '));
}

function _onVisibilityChangeKeepAlive() {
    if (document.visibilityState === 'visible' && appSettings.keepAlive) {
        // Re-acquire wake lock
        if ('wakeLock' in navigator && !_wakeLock) {
            navigator.wakeLock.request('screen').then(lock => {
                _wakeLock = lock;
                console.log('[KeepAlive] Wake Lock re-acquired');
            }).catch(() => { });
        }
        // Resume audio context if suspended
        if (_keepAliveAudio && _keepAliveAudio.ctx.state === 'suspended') {
            _keepAliveAudio.ctx.resume().catch(() => { });
        }
    }
}

function stopKeepAlive() {
    const statusEl = document.getElementById('keep-alive-status');

    // Release wake lock
    if (_wakeLock) {
        _wakeLock.release().catch(() => { });
        _wakeLock = null;
    }

    // Stop audio
    if (_keepAliveAudio) {
        try {
            _keepAliveAudio.oscillator.stop();
            _keepAliveAudio.ctx.close();
        } catch (e) { /* ignore */ }
        _keepAliveAudio = null;
    }

    // Clear timer
    if (_keepAliveTimer) {
        clearInterval(_keepAliveTimer);
        _keepAliveTimer = null;
    }

    // Remove event listener
    document.removeEventListener('visibilitychange', _onVisibilityChangeKeepAlive);

    if (statusEl) {
        statusEl.style.display = 'block';
        statusEl.textContent = '已关闭';
        statusEl.style.color = '#bbb';
    }

    console.log('[KeepAlive] Stopped');
}

// Auto-start keep-alive on page load if enabled
function initKeepAlive() {
    const toggle = document.getElementById('set-keep-alive');
    if (toggle) toggle.checked = appSettings.keepAlive || false;
    if (appSettings.keepAlive) {
        startKeepAlive();
    }
}

function openDataSettings() {
    if (settingsScreen) settingsScreen.style.display = 'none';
    const dataScreen = document.getElementById('data-settings-screen');
    if (dataScreen) dataScreen.style.display = 'flex';
    updateStatusBar('settings');
}

function closeDataSettings() {
    const dataScreen = document.getElementById('data-settings-screen');
    if (dataScreen) dataScreen.style.display = 'none';
    if (settingsScreen) settingsScreen.style.display = 'flex';
    updateStatusBar('settings');
}

function saveDataSettings() {
    closeDataSettings();
}

// ===== NAI Image Generation Settings =====
function openNaiSettings() {
    // Load current values into UI
    document.getElementById('set-nai-api-key').value = appSettings.naiApiKey || '';
    if (document.getElementById('set-nai-enabled')) document.getElementById('set-nai-enabled').checked = appSettings.naiEnabled || false;
    document.getElementById('set-nai-model').value = appSettings.naiModel || 'nai-diffusion-4-curated-preview';
    document.getElementById('set-nai-sampler').value = appSettings.naiSampler || 'k_euler_ancestral';
    document.getElementById('set-nai-schedule').value = appSettings.naiSchedule || 'native';

    const steps = appSettings.naiSteps || 28;
    document.getElementById('set-nai-steps').value = steps;
    document.getElementById('nai-steps-display').textContent = steps;

    const scale = appSettings.naiScale !== undefined ? appSettings.naiScale : 5;
    document.getElementById('set-nai-scale').value = scale;
    document.getElementById('nai-scale-display').textContent = scale;

    document.getElementById('set-nai-seed').value = appSettings.naiSeed !== undefined ? appSettings.naiSeed : -1;

    // Size preset
    const preset = appSettings.naiSizePreset || '832x1216';
    if (document.getElementById('set-nai-size-preset')) {
        document.getElementById('set-nai-size-preset').value = preset;
    }
    const customRow = document.getElementById('nai-custom-size-row');
    if (customRow) {
        if (preset === 'custom') {
            customRow.style.display = 'flex';
        } else {
            customRow.style.display = 'none';
        }
    }
    if (document.getElementById('set-nai-width')) document.getElementById('set-nai-width').value = appSettings.naiWidth || 832;
    if (document.getElementById('set-nai-height')) document.getElementById('set-nai-height').value = appSettings.naiHeight || 1216;

    // Prompts
    document.getElementById('set-nai-positive-prefix').value = appSettings.naiPositivePrefix || '';
    document.getElementById('set-nai-positive-suffix').value = appSettings.naiPositiveSuffix || '';
    document.getElementById('set-nai-negative').value = appSettings.naiNegative || '';
    if (document.getElementById('set-nai-prompt-instruction')) document.getElementById('set-nai-prompt-instruction').value = appSettings.naiPromptInstruction || '';

    // Advanced
    if (document.getElementById('set-nai-smea')) document.getElementById('set-nai-smea').checked = appSettings.naiSmea !== false;
    if (document.getElementById('set-nai-dynamic')) document.getElementById('set-nai-dynamic').checked = appSettings.naiDynamic || false;

    const cfgRescale = appSettings.naiCfgRescale !== undefined ? appSettings.naiCfgRescale : 0;
    if (document.getElementById('set-nai-cfg-rescale')) document.getElementById('set-nai-cfg-rescale').value = cfgRescale;
    if (document.getElementById('nai-cfg-rescale-display')) document.getElementById('nai-cfg-rescale-display').textContent = cfgRescale;

    const uncondScale = appSettings.naiUncondScale !== undefined ? appSettings.naiUncondScale : 1;
    if (document.getElementById('set-nai-uncond-scale')) document.getElementById('set-nai-uncond-scale').value = uncondScale;
    if (document.getElementById('nai-uncond-scale-display')) document.getElementById('nai-uncond-scale-display').textContent = uncondScale;

    if (settingsScreen) settingsScreen.style.display = 'none';
    const naiScreen = document.getElementById('nai-settings-screen');
    if (naiScreen) naiScreen.style.display = 'flex';
    updateStatusBar('settings');
}

function closeNaiSettings() {
    const naiScreen = document.getElementById('nai-settings-screen');
    if (naiScreen) naiScreen.style.display = 'none';
    if (settingsScreen) settingsScreen.style.display = 'flex';
    updateStatusBar('settings');
}

function saveNaiSettings() {
    appSettings.naiApiKey = document.getElementById('set-nai-api-key').value;
    // naiEnabled is now per-chat; this global flag is only a fallback
    const enabledEl = document.getElementById('set-nai-enabled');
    if (enabledEl) appSettings.naiEnabled = enabledEl.checked;
    appSettings.naiModel = document.getElementById('set-nai-model').value;
    appSettings.naiSampler = document.getElementById('set-nai-sampler').value;
    appSettings.naiSchedule = document.getElementById('set-nai-schedule').value;
    appSettings.naiSteps = parseInt(document.getElementById('set-nai-steps').value) || 28;
    appSettings.naiScale = parseFloat(document.getElementById('set-nai-scale').value) || 5;
    appSettings.naiSeed = parseInt(document.getElementById('set-nai-seed').value);
    if (isNaN(appSettings.naiSeed)) appSettings.naiSeed = -1;

    // Size is now per-chat; global size stays as default fallback
    const sizePresetEl = document.getElementById('set-nai-size-preset');
    if (sizePresetEl) {
        const preset = sizePresetEl.value;
        appSettings.naiSizePreset = preset;
        if (preset === 'custom') {
            appSettings.naiWidth = parseInt(document.getElementById('set-nai-width').value) || 832;
            appSettings.naiHeight = parseInt(document.getElementById('set-nai-height').value) || 1216;
        } else {
            const [w, h] = preset.split('x').map(Number);
            appSettings.naiWidth = w;
            appSettings.naiHeight = h;
        }
    }

    appSettings.naiPositivePrefix = document.getElementById('set-nai-positive-prefix').value;
    appSettings.naiPositiveSuffix = document.getElementById('set-nai-positive-suffix').value;
    appSettings.naiNegative = document.getElementById('set-nai-negative').value;
    const promptInstructionEl = document.getElementById('set-nai-prompt-instruction');
    if (promptInstructionEl) appSettings.naiPromptInstruction = promptInstructionEl.value;

    const smeaEl = document.getElementById('set-nai-smea');
    if (smeaEl) appSettings.naiSmea = smeaEl.checked;
    const dynEl = document.getElementById('set-nai-dynamic');
    if (dynEl) appSettings.naiDynamic = dynEl.checked;
    const cfgEl = document.getElementById('set-nai-cfg-rescale');
    if (cfgEl) appSettings.naiCfgRescale = parseFloat(cfgEl.value) || 0;
    const uncondEl = document.getElementById('set-nai-uncond-scale');
    if (uncondEl) appSettings.naiUncondScale = parseFloat(uncondEl.value) || 1;

    saveSettingsToStorage();
    showToast('NAI 设置已保存');
    closeNaiSettings();
}

function applyNaiSizePreset() {
    const preset = document.getElementById('set-nai-size-preset').value;
    const customRow = document.getElementById('nai-custom-size-row');
    if (preset === 'custom') {
        customRow.style.display = 'flex';
    } else {
        customRow.style.display = 'none';
        const [w, h] = preset.split('x').map(Number);
        document.getElementById('set-nai-width').value = w;
        document.getElementById('set-nai-height').value = h;
    }
}

// ===== MiniMax TTS Settings =====
let _ttsAudioPlayer = null; // Global audio player for TTS

window.toggleTtsEndpointInput = function () {
    const select = document.getElementById('set-tts-api-endpoint-select');
    const inputContainer = document.getElementById('set-tts-api-endpoint-container');
    const input = document.getElementById('set-tts-api-endpoint');
    if (select && inputContainer && input) {
        if (select.value === 'custom') {
            inputContainer.style.display = 'block';
            input.value = '';
            input.focus();
        } else {
            inputContainer.style.display = 'none';
            input.value = select.value;
        }
    }
};

function openTtsSettings() {
    // Load current values safely
    const endpoint = appSettings.ttsApiEndpoint || 'https://api.minimaxi.com';
    const endpointSelect = document.getElementById('set-tts-api-endpoint-select');
    const endpointContainer = document.getElementById('set-tts-api-endpoint-container');
    const endpointInput = document.getElementById('set-tts-api-endpoint');
    if (endpointSelect && endpointContainer && endpointInput) {
        if (endpoint === 'https://api.minimaxi.com' || endpoint === 'https://api.minimax.io') {
            endpointSelect.value = endpoint;
            endpointContainer.style.display = 'none';
            endpointInput.value = endpoint;
        } else {
            endpointSelect.value = 'custom';
            endpointContainer.style.display = 'flex';
            endpointInput.value = endpoint;
        }
    }
    if (document.getElementById('set-tts-api-key')) document.getElementById('set-tts-api-key').value = appSettings.ttsApiKey || '';
    if (document.getElementById('set-tts-group-id')) document.getElementById('set-tts-group-id').value = appSettings.ttsGroupId || '';

    // Some elements may have been moved entirely to chat settings, so we use optional chaining/ifs

    if (document.getElementById('set-tts-model')) document.getElementById('set-tts-model').value = appSettings.ttsModel || 'speech-02-hd';
    if (document.getElementById('set-tts-voice-id')) document.getElementById('set-tts-voice-id').value = appSettings.ttsVoiceId || 'female-shaonv';

    const speed = appSettings.ttsSpeed !== undefined ? appSettings.ttsSpeed : 1.0;
    if (document.getElementById('set-tts-speed')) document.getElementById('set-tts-speed').value = speed;
    if (document.getElementById('tts-speed-display')) document.getElementById('tts-speed-display').textContent = speed;

    const vol = appSettings.ttsVol !== undefined ? appSettings.ttsVol : 1.0;
    if (document.getElementById('set-tts-vol')) document.getElementById('set-tts-vol').value = vol;
    if (document.getElementById('tts-vol-display')) document.getElementById('tts-vol-display').textContent = vol;

    const pitch = appSettings.ttsPitch !== undefined ? appSettings.ttsPitch : 0;
    if (document.getElementById('set-tts-pitch')) document.getElementById('set-tts-pitch').value = pitch;
    if (document.getElementById('tts-pitch-display')) document.getElementById('tts-pitch-display').textContent = pitch;

    if (document.getElementById('set-tts-format')) document.getElementById('set-tts-format').value = appSettings.ttsFormat || 'mp3';
    if (document.getElementById('set-tts-sample-rate')) document.getElementById('set-tts-sample-rate').value = appSettings.ttsSampleRate || '24000';
    if (document.getElementById('set-tts-auto-play')) document.getElementById('set-tts-auto-play').checked = appSettings.ttsAutoPlay || false;
    if (document.getElementById('set-tts-emotion')) document.getElementById('set-tts-emotion').value = appSettings.ttsEmotion || '';
    if (document.getElementById('set-tts-cors-proxy')) document.getElementById('set-tts-cors-proxy').value = appSettings.ttsCorsProxy !== undefined ? appSettings.ttsCorsProxy : 'https://corsproxy.io/?';

    if (settingsScreen) settingsScreen.style.display = 'none';
    const ttsScreen = document.getElementById('tts-settings-screen');
    if (ttsScreen) ttsScreen.style.display = 'flex';
    updateStatusBar('settings');
}

function closeTtsSettings() {
    const ttsScreen = document.getElementById('tts-settings-screen');
    if (ttsScreen) ttsScreen.style.display = 'none';
    if (settingsScreen) settingsScreen.style.display = 'flex';
    updateStatusBar('settings');
}

function saveTtsSettings() {
    if (document.getElementById('set-tts-api-endpoint')) {
        let endpoint = '';
        const select = document.getElementById('set-tts-api-endpoint-select');
        if (select && select.value !== 'custom') {
            endpoint = select.value.trim();
        } else {
            endpoint = document.getElementById('set-tts-api-endpoint').value.trim();
        }
        // 自动去掉末尾的 /
        if (endpoint.endsWith('/')) endpoint = endpoint.slice(0, -1);
        appSettings.ttsApiEndpoint = endpoint;
    }
    if (document.getElementById('set-tts-api-key')) appSettings.ttsApiKey = document.getElementById('set-tts-api-key').value.trim();
    if (document.getElementById('set-tts-group-id')) appSettings.ttsGroupId = document.getElementById('set-tts-group-id').value.trim();



    if (document.getElementById('set-tts-model')) appSettings.ttsModel = document.getElementById('set-tts-model').value;
    if (document.getElementById('set-tts-voice-id')) appSettings.ttsVoiceId = document.getElementById('set-tts-voice-id').value;
    if (document.getElementById('set-tts-speed')) appSettings.ttsSpeed = parseFloat(document.getElementById('set-tts-speed').value) || 1.0;
    if (document.getElementById('set-tts-vol')) appSettings.ttsVol = parseFloat(document.getElementById('set-tts-vol').value) || 1.0;
    if (document.getElementById('set-tts-pitch')) appSettings.ttsPitch = parseInt(document.getElementById('set-tts-pitch').value) || 0;
    if (document.getElementById('set-tts-format')) appSettings.ttsFormat = document.getElementById('set-tts-format').value;
    if (document.getElementById('set-tts-sample-rate')) appSettings.ttsSampleRate = document.getElementById('set-tts-sample-rate').value;
    if (document.getElementById('set-tts-auto-play')) appSettings.ttsAutoPlay = document.getElementById('set-tts-auto-play').checked;
    if (document.getElementById('set-tts-emotion')) appSettings.ttsEmotion = document.getElementById('set-tts-emotion').value;
    if (document.getElementById('set-tts-cors-proxy')) appSettings.ttsCorsProxy = document.getElementById('set-tts-cors-proxy').value.trim();

    saveSettingsToStorage();
    // Clear TTS cache when settings change (voice/speed/etc may have changed)
    if (typeof _ttsCache !== 'undefined') {
        _ttsCache.forEach(url => URL.revokeObjectURL(url));
        _ttsCache.clear();
    }
    showToast('MiniMax TTS 设置已保存');
    closeTtsSettings();
}

// TTS Audio Cache - stores blob URLs keyed by text to avoid repeated API calls
const _ttsCache = new Map();
const _TTS_CACHE_MAX = 50;

function _ttsCacheKey(text) {
    // Include voice settings in cache key so changing voice invalidates cache
    const voiceId = appSettings.ttsVoiceId || 'female-shaonv';
    const speed = appSettings.ttsSpeed !== undefined ? appSettings.ttsSpeed : 1.0;
    const readMode = appSettings.ttsReadMode || 'all';
    return `${voiceId}|${speed}|${readMode}|${text}`;
}

// MiniMax TTS API Call
async function generateTtsAudio(text) {
    if (!appSettings.ttsApiKey) {
        throw new Error('MiniMax API Key 未配置');
    }
    if (!appSettings.ttsGroupId) {
        throw new Error('MiniMax Group ID 未配置');
    }

    // Text Read Mode Filtering
    let cleanText = text;
    const readMode = appSettings.ttsReadMode || 'all';

    if (readMode === 'exclude_actions') {
        // Remove text inside asterisks and brackets/parentheses
        cleanText = cleanText
            .replace(/\*(.*?)\*/g, '')
            .replace(/（.*?）/g, '')
            .replace(/\(.*?\)/g, '')
            .replace(/【.*?】/g, '')
            .replace(/\[.*?\]/g, '');
    } else if (readMode === 'only_quotes') {
        // Extract ONLY text inside quotation marks
        const matches = [...cleanText.matchAll(/(?:["'“‘「『])([^"'”’」』]*)(?:["'”’」』])/g)];
        if (matches && matches.length > 0) {
            cleanText = matches.map(m => m[1] || '').join('、');
        } else {
            cleanText = ''; // Nothing to read
        }
    }

    // Strip remaining markdown, HTML, and special formatting from text
    cleanText = cleanText
        .replace(/\*\*(.*?)\*\*/g, '$1')     // bold
        .replace(/\*(.*?)\*/g, '$1')           // italic
        .replace(/~~(.*?)~~/g, '$1')           // strikethrough
        .replace(/`(.*?)`/g, '$1')             // code
        .replace(/<[^>]+>/g, '')              // HTML tags
        .replace(/\[.*?\|.*?\]/g, '')         // custom media tags
        .replace(/「`回复.*?`」/g, '')          // quote markers
        .trim();

    if (!cleanText) {
        throw new Error('无有效文本可合成语音');
    }

    // Truncate to 10000 chars (API limit)
    if (cleanText.length > 10000) {
        cleanText = cleanText.substring(0, 10000);
    }

    const voiceId = appSettings.ttsVoiceId || 'female-shaonv';
    const model = appSettings.ttsModel || 'speech-02-hd';
    const format = appSettings.ttsFormat || 'mp3';
    const sampleRate = parseInt(appSettings.ttsSampleRate) || 24000;

    const payload = {
        model: model,
        text: cleanText,
        stream: false,
        voice_setting: {
            voice_id: voiceId,
            speed: appSettings.ttsSpeed !== undefined ? appSettings.ttsSpeed : 1.0,
            vol: appSettings.ttsVol !== undefined ? appSettings.ttsVol : 1.0,
            pitch: appSettings.ttsPitch !== undefined ? appSettings.ttsPitch : 0
        },
        audio_setting: {
            sample_rate: sampleRate,
            format: format
        }
    };

    // Add emotion prompt if set
    if (appSettings.ttsEmotion && appSettings.ttsEmotion.trim()) {
        payload.timber_weights = [{
            voice_id: voiceId,
            weight: 1
        }];
    }

    console.log('[MiniMax TTS] Generating speech for:', cleanText.substring(0, 100) + '...');

    const ttsEndpoint = appSettings.ttsApiEndpoint || 'https://api.minimaxi.com';
    const rawUrl = `${ttsEndpoint}/v1/t2a_v2?GroupId=${appSettings.ttsGroupId}`;
    let corsProxy = appSettings.ttsCorsProxy !== undefined ? appSettings.ttsCorsProxy : '';
    // 如果用户留空，使用内置 nginx 反向代理路径（根据端点自动选择国内/国际）
    if (!corsProxy || corsProxy.trim() === '') {
        corsProxy = 'none';
        // 根据用户选择的端点，自动路由到对应的 nginx 代理
        const proxyPath = ttsEndpoint.includes('minimax.io') ? '/minimax-tts-intl/' : '/minimax-tts-cn/';
        var url = `${proxyPath}v1/t2a_v2?GroupId=${appSettings.ttsGroupId}`;
    }

    if (typeof url === 'undefined') {
        var url = rawUrl;
        if (corsProxy !== 'none' && corsProxy !== 'false') {
            // 防止用户在这个框里直接填了 API 地址导致地址重复拼接
            if (corsProxy.includes('api.minimax')) {
                url = corsProxy; // 用户直接填了完整的带代理的 API 地址
            } else if (corsProxy === '/proxy/') {
                url = corsProxy + rawUrl;
            } else {
                url = corsProxy.includes('url=') ? corsProxy + encodeURIComponent(rawUrl) : corsProxy + rawUrl;
            }
        }
    }
    let res;
    try {
        res = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${appSettings.ttsApiKey}`
            },
            body: JSON.stringify(payload)
        });
    } catch (fetchErr) {
        console.error('[MiniMax TTS] Network Error:', fetchErr);
        throw new Error(`网络请求失败 (Failed to fetch)。可能是 CORS 代理 (${corsProxy || '无'}) 不稳定或被拦截。请前往 [手机设置 -> MiniMax语音] 中尝试清空 CORS 代理，或自行更换其他代理。`);
    }

    if (!res.ok) {
        const errText = await res.text();
        throw new Error(`MiniMax TTS API Error ${res.status}: ${errText}`);
    }

    const data = await res.json();

    if (data.base_resp && data.base_resp.status_code !== 0) {
        throw new Error(`MiniMax TTS Error: ${data.base_resp.status_msg || 'Unknown error'}`);
    }

    // The response contains audio data as a hex string
    const audioHex = data.data && data.data.audio;
    if (!audioHex) {
        throw new Error('MiniMax TTS 返回的数据中未包含音频');
    }

    // Convert hex string to Uint8Array
    const mimeMap = { mp3: 'audio/mpeg', pcm: 'audio/pcm', flac: 'audio/flac', wav: 'audio/wav' };
    const mimeType = mimeMap[format] || 'audio/mpeg';

    // Check if it's base64 or hex by looking at the first 4 chars.
    // Hex for mp3 (ID3 or FFFB) or WAV (RIFF) usually starts with numbers/a-f.
    let uint8Array;
    // If it looks like base64, decode it
    if (/^[a-zA-Z0-9\+/]+={0,2}$/.test(audioHex) && !/^[0-9a-fA-F]+$/.test(audioHex)) {
        const byteString = atob(audioHex);
        uint8Array = new Uint8Array(byteString.length);
        for (let i = 0; i < byteString.length; i++) {
            uint8Array[i] = byteString.charCodeAt(i);
        }
    } else {
        // It's a Hex String (MiniMax standard for v2)
        uint8Array = new Uint8Array(audioHex.length / 2);
        for (let i = 0; i < audioHex.length; i += 2) {
            uint8Array[i / 2] = parseInt(audioHex.substring(i, i + 2), 16);
        }
    }

    const blob = new Blob([uint8Array], { type: mimeType });
    const blobUrl = URL.createObjectURL(blob);

    // Cache the result
    const cacheKey = _ttsCacheKey(text);
    if (_ttsCache.size >= _TTS_CACHE_MAX) {
        // Evict oldest entry
        const firstKey = _ttsCache.keys().next().value;
        const oldUrl = _ttsCache.get(firstKey);
        URL.revokeObjectURL(oldUrl);
        _ttsCache.delete(firstKey);
    }
    _ttsCache.set(cacheKey, blobUrl);

    console.log('[MiniMax TTS] Audio generated and cached successfully');
    return blobUrl;
}

// Play TTS audio
function playTtsAudio(audioUrl) {
    // Stop any existing playback
    stopTtsAudio();

    _ttsAudioPlayer = new Audio(audioUrl);
    _ttsAudioPlayer.play().catch(err => {
        console.error('[MiniMax TTS] Playback error:', err);
        showToast('语音播放失败: ' + (err.message || err.name || JSON.stringify(err)));
    });

    _ttsAudioPlayer.onended = () => {
        _ttsAudioPlayer = null;
        // Update any playing UI indicators
        document.querySelectorAll('.tts-play-btn.playing').forEach(btn => {
            btn.classList.remove('playing');
            btn.innerHTML = '<svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>';
        });
    };
}

function stopTtsAudio() {
    if (_ttsAudioPlayer) {
        _ttsAudioPlayer.pause();
        _ttsAudioPlayer.currentTime = 0;
        _ttsAudioPlayer = null;
    }
    document.querySelectorAll('.tts-play-btn.playing').forEach(btn => {
        btn.classList.remove('playing');
        btn.innerHTML = '<svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>';
    });
}

// Handle TTS play for a specific message element
async function handleTtsPlay(bubbleEl, btnEl) {
    // If already playing, stop
    if (btnEl.classList.contains('playing')) {
        stopTtsAudio();
        return;
    }

    // Get text content - try multiple sources
    let text = '';

    // 1. From button's dataset (set during render)
    if (btnEl.dataset.ttsText) {
        text = btnEl.dataset.ttsText;
    }

    // 2. From bubble's text elements
    if (!text) {
        const msgTextEl = bubbleEl.querySelector('.msg-text');
        if (msgTextEl) {
            text = msgTextEl.textContent || msgTextEl.innerText;
        }
    }

    // 3. From voice text bubble
    if (!text) {
        const voiceTextEl = bubbleEl.querySelector('.voice-text-bubble');
        if (voiceTextEl) {
            text = voiceTextEl.textContent || voiceTextEl.innerText;
        }
    }

    // 4. Direct textContent fallback
    if (!text) {
        text = bubbleEl.textContent || bubbleEl.innerText || '';
    }

    text = text.trim();
    if (!text) {
        showToast('消息为空，无法合成语音');
        return;
    }

    // Show loading
    stopTtsAudio();
    btnEl.classList.add('playing');
    btnEl.innerHTML = '<svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2" class="tts-loading-spinner"><circle cx="12" cy="12" r="10"></circle><path d="M12 6v6l4 2"></path></svg>';

    try {
        // Check cache first
        const cacheKey = _ttsCacheKey(text);
        let audioUrl = _ttsCache.get(cacheKey);
        if (audioUrl) {
            console.log('[MiniMax TTS] Using cached audio');
        } else {
            audioUrl = await generateTtsAudio(text);
        }
        // Update button to stop icon
        btnEl.innerHTML = '<svg viewBox="0 0 24 24" width="10" height="10" fill="currentColor"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg>';
        playTtsAudio(audioUrl);
    } catch (err) {
        console.error('[MiniMax TTS] Error:', err);
        showToast('语音合成失败: ' + err.message);
        btnEl.classList.remove('playing');
        btnEl.innerHTML = '<svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>';
    }
}

// NAI Image Generation API Call
async function generateNaiImage(promptTags) {
    if (!appSettings.naiApiKey) {
        throw new Error('NAI API Key 未配置');
    }

    // Build final prompt: prefix + char prompt + AI tags + suffix
    const parts = [];
    if (appSettings.naiPositivePrefix) parts.push(appSettings.naiPositivePrefix.trim());
    const charPrompt = getChatNaiCharPrompt ? getChatNaiCharPrompt() : '';
    if (charPrompt) parts.push(charPrompt.trim());
    if (promptTags) parts.push(promptTags.trim());
    if (appSettings.naiPositiveSuffix) parts.push(appSettings.naiPositiveSuffix.trim());
    const finalPrompt = parts.filter(p => p).join(', ');

    const negPrompt = appSettings.naiNegative || '';
    const seed = appSettings.naiSeed === -1 ? Math.floor(Math.random() * 4294967295) : appSettings.naiSeed;

    // Use per-chat size, fall back to global
    const chatSize = getChatNaiSize ? getChatNaiSize() : (appSettings.naiSizePreset || '832x1216');
    const [chatW, chatH] = chatSize.split('x').map(Number);

    const payload = {
        input: finalPrompt,
        model: appSettings.naiModel || 'nai-diffusion-4-curated-preview',
        action: 'generate',
        parameters: {
            params_version: 3,
            width: chatW || appSettings.naiWidth || 832,
            height: chatH || appSettings.naiHeight || 1216,
            scale: appSettings.naiScale || 5,
            sampler: appSettings.naiSampler || 'k_euler_ancestral',
            steps: appSettings.naiSteps || 28,
            n_samples: 1,
            ucPreset: 0,
            qualityToggle: true,
            sm: appSettings.naiSmea !== false,
            sm_dyn: appSettings.naiDynamic || false,
            cfg_rescale: appSettings.naiCfgRescale || 0,
            uncond_scale: appSettings.naiUncondScale !== undefined ? appSettings.naiUncondScale : 1,
            noise_schedule: appSettings.naiSchedule || 'native',
            seed: seed,
            negative_prompt: negPrompt
        }
    };

    console.log('[NAI] Generating image with prompt:', finalPrompt);
    console.log('[NAI] Payload:', JSON.stringify(payload, null, 2));

    const res = await fetch('https://image.novelai.net/ai/generate-image', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${appSettings.naiApiKey}`,
            'Accept': 'application/zip'
        },
        body: JSON.stringify(payload)
    });

    if (!res.ok) {
        const errText = await res.text();
        throw new Error(`NAI API Error ${res.status}: ${errText}`);
    }

    // NAI returns a ZIP file containing the PNG image
    const zipBlob = await res.blob();
    const zipArrayBuffer = await zipBlob.arrayBuffer();

    // Simple ZIP extraction: find PNG data within the ZIP
    const zipData = new Uint8Array(zipArrayBuffer);

    // Look for PNG signature: 89 50 4E 47 0D 0A 1A 0A
    const pngSignature = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
    let pngStart = -1;
    for (let i = 0; i < zipData.length - 8; i++) {
        let found = true;
        for (let j = 0; j < 8; j++) {
            if (zipData[i + j] !== pngSignature[j]) {
                found = false;
                break;
            }
        }
        if (found) {
            pngStart = i;
            break;
        }
    }

    if (pngStart === -1) {
        throw new Error('无法从NAI响应中提取图片数据');
    }

    // Find the end of PNG (IEND chunk: 00 00 00 00 49 45 4E 44 AE 42 60 82)
    const iendSignature = [0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82];
    let pngEnd = zipData.length;
    for (let i = pngStart + 8; i < zipData.length - 8; i++) {
        let found = true;
        for (let j = 0; j < 8; j++) {
            if (zipData[i + j] !== iendSignature[j]) {
                found = false;
                break;
            }
        }
        if (found) {
            pngEnd = i + 8;
            break;
        }
    }

    const pngData = zipData.slice(pngStart, pngEnd);
    const pngBlob = new Blob([pngData], { type: 'image/png' });

    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('Failed to read image data'));
        reader.readAsDataURL(pngBlob);
    });
}

async function exportAllData() {
    // Get all chat histories from IndexedDB
    let allHistories = {};
    try {
        allHistories = await getAllChatHistories();
    } catch (e) {
        console.error('Failed to read chat histories from IndexedDB:', e);
    }

    const availableChats = [];
    for (const [tag, history] of Object.entries(allHistories)) {
        let count = Array.isArray(history) ? history.length : 0;
        availableChats.push({ tag, count });
    }

    // Sort chat history arbitrarily or by tag
    availableChats.sort((a, b) => a.tag.localeCompare(b.tag));

    const overlay = document.createElement('div');
    overlay.id = 'export-data-popup';
    overlay.style.cssText = 'position:fixed; inset:0; z-index:99999; display:flex; align-items:center; justify-content:center; background:rgba(0,0,0,0.35); backdrop-filter:blur(4px);';

    let chatHtml = availableChats.map(c => {
        const isGroup = c.tag.startsWith('group:');
        const displayName = c.tag.replace(/^(chat:|group:)/, '');
        return `
        <label style="display:flex; align-items:center; gap:8px; font-size:13px; color:#555;">
            <input type="checkbox" class="export-chat-cb" value="${c.tag}" checked>
            <span>${isGroup ? '[群聊] ' : ''}${displayName} (${c.count}条消息)</span>
        </label>
    `;
    }).join('');

    const box = document.createElement('div');
    box.style.cssText = 'background:#fff; border-radius:18px; padding:24px 20px; width:320px; max-width:90vw; max-height:80vh; overflow-y:auto; box-shadow:0 8px 30px rgba(0,0,0,0.15); display:flex; flex-direction:column; gap:14px;';

    box.innerHTML = `
        <div style="font-size:16px; font-weight:bold; color:#333; text-align:center;">导出数据</div>
        
        <div style="display:flex; justify-content:space-between; align-items:center;">
            <span style="font-size:14px; color:#666; font-weight:bold;">基础数据</span>
            <button id="export-toggle-all" style="padding:4px 8px; font-size:12px; border:1px solid #ddd; background:#f9f9f9; border-radius:6px; cursor:pointer;">取消全选</button>
        </div>
        
        <div style="display:flex; flex-direction:column; gap:8px; background:#fdfdfd; padding:10px; border-radius:10px; border:1px solid #eee;">
            <label style="display:flex; align-items:center; gap:8px; font-size:14px; color:#333;">
                <input type="checkbox" class="export-base-cb" value="faye-phone-settings" checked>
                <span>应用设置</span>
            </label>
            <label style="display:flex; align-items:center; gap:8px; font-size:14px; color:#333;">
                <input type="checkbox" class="export-base-cb" value="userCharacters" checked>
                <span>用户角色</span>
            </label>
            <label style="display:flex; align-items:center; gap:8px; font-size:14px; color:#333;">
                <input type="checkbox" class="export-base-cb" value="npcCharacters" checked>
                <span>NPC角色</span>
            </label>
            <label style="display:flex; align-items:center; gap:8px; font-size:14px; color:#333;">
                <input type="checkbox" class="export-base-cb" value="worldbooks" checked>
                <span>世界书</span>
            </label>
            <label style="display:flex; align-items:center; gap:8px; font-size:14px; color:#333;">
                <input type="checkbox" class="export-base-cb" value="st-phone-stickers" checked>
                <span>表情包</span>
            </label>
            <label style="display:flex; align-items:center; gap:8px; font-size:14px; color:#333;">
                <input type="checkbox" class="export-base-cb" value="memories" checked>
                <span>聊天记忆总结</span>
            </label>
            <label style="display:flex; align-items:center; gap:8px; font-size:14px; color:#333;">
                <input type="checkbox" class="export-base-cb" value="faye-phone-regex-rules" checked>
                <span>正则</span>
            </label>
            <label style="display:flex; align-items:center; gap:8px; font-size:14px; color:#333;">
                <input type="checkbox" class="export-base-cb" value="faye-phone-music-library" checked>
                <span>音乐</span>
            </label>
            <label style="display:flex; align-items:center; gap:8px; font-size:14px; color:#333;">
                <input type="checkbox" class="export-base-cb" value="faye-phone-forum" checked>
                <span>论坛</span>
            </label>
            <label style="display:flex; align-items:center; gap:8px; font-size:14px; color:#333;">
                <input type="checkbox" class="export-base-cb" value="faye-phone-moments" checked>
                <span>朋友圈</span>
            </label>
            <label style="display:flex; align-items:center; gap:8px; font-size:14px; color:#333;">
                <input type="checkbox" class="export-base-cb" value="pomodoro" checked>
                <span>番茄钟</span>
            </label>
        </div>
        
        <div style="font-size:14px; color:#666; font-weight:bold; margin-top:4px;">聊天记录 (${availableChats.length})</div>
        <div style="max-height:160px; overflow-y:auto; background:#f5f5f5; padding:8px; border-radius:8px; display:flex; flex-direction:column; gap:6px;">
            ${chatHtml || '<div style="font-size:12px; color:#999; text-align:center;">暂无聊天记录</div>'}
        </div>
        
        <div style="display:flex; gap:10px; margin-top:10px;">
            <button id="export-cancel" style="flex:1; padding:10px; border:none; border-radius:12px; background:#f5f5f5; font-size:14px; color:#999; cursor:pointer;">取消</button>
            <button id="export-confirm" style="flex:1; padding:10px; border:none; border-radius:12px; background:var(--pink-500,#e8a0b4); font-size:14px; color:#fff; font-weight:bold; cursor:pointer;">导出</button>
        </div>
    `;

    overlay.appendChild(box);
    document.body.appendChild(overlay);

    let allChecked = true;
    box.querySelector('#export-toggle-all').onclick = (e) => {
        allChecked = !allChecked;
        e.target.textContent = allChecked ? "取消全选" : "全选";
        box.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.checked = allChecked);
    };

    box.querySelector('#export-cancel').onclick = () => overlay.remove();

    box.querySelector('#export-confirm').onclick = () => {
        const allData = {};

        // Base selections
        const baseCbs = box.querySelectorAll('.export-base-cb:checked');
        baseCbs.forEach(cb => {
            const val = cb.value;
            if (val === 'memories') {
                for (let i = 0; i < localStorage.length; i++) {
                    const key = localStorage.key(i);
                    if (key.startsWith('faye-phone-memory-chat:') || key.startsWith('faye-phone-memory-settings-chat:')) {
                        allData[key] = localStorage.getItem(key);
                    }
                }
            } else if (val === 'faye-phone-forum') {
                // Forum + profile
                const item = localStorage.getItem('faye-phone-forum');
                if (item) allData['faye-phone-forum'] = item;
                const profile = localStorage.getItem('faye-phone-forum-profile');
                if (profile) allData['faye-phone-forum-profile'] = profile;
            } else if (val === 'faye-phone-moments') {
                // Moments + avatar + cover
                const item = localStorage.getItem('faye-phone-moments');
                if (item) allData['faye-phone-moments'] = item;
                const avatar = localStorage.getItem('faye-phone-moments-avatar');
                if (avatar) allData['faye-phone-moments-avatar'] = avatar;
                const cover = localStorage.getItem('faye-phone-moments-cover');
                if (cover) allData['faye-phone-moments-cover'] = cover;
            } else if (val === 'worldbooks') {
                // Worldbooks stored under different key
                const item = localStorage.getItem('faye-phone-worldbooks');
                if (item) allData['worldbooks'] = item;
            } else if (val === 'pomodoro') {
                // Pomodoro data: settings + history + tasks + sessions
                const pomoKeys = ['faye-phone-pomodoro-settings', 'faye-phone-pomodoro-history', 'faye-phone-pomodoro-tasks', 'faye-phone-pomodoro-sessions', 'faye-phone-pomodoro'];
                pomoKeys.forEach(pk => {
                    const item = localStorage.getItem(pk);
                    if (item) allData[pk] = item;
                });
            } else {
                const item = localStorage.getItem(val);
                if (item) allData[val] = item;
            }
        });

        // Chat selections (from IndexedDB)
        const chatCbs = box.querySelectorAll('.export-chat-cb:checked');
        const chatExportPromises = [];
        chatCbs.forEach(cb => {
            const tag = cb.value;
            if (allHistories[tag]) {
                // Store with the old key format for backward compatibility
                allData[`faye - phone - history - ${tag} `] = JSON.stringify(allHistories[tag]);
            }
        });

        if (Object.keys(allData).length === 0) {
            showToast('没有选择任何数据导出');
            return;
        }

        try {
            const blob = new Blob([JSON.stringify(allData, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `phone-backup-${new Date().toISOString().slice(0, 10)}.json`;
            a.click();
            URL.revokeObjectURL(url);
            showToast('✅ 导出成功');
            overlay.remove();
        } catch (e) {
            showToast('❌ 导出失败');
            console.error(e);
        }
    };
}

function importAllData() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (ev) => {
            try {
                const data = JSON.parse(ev.target.result);
                if (typeof data !== 'object' || data === null) throw new Error('Invalid format');
                showDataImportModal(data);
            } catch (err) {
                showToast('❌ 文件格式错误或读取失败');
            }
        };
        reader.readAsText(file);
    };
    input.click();
}

function showDataImportModal(data) {
    let hasSettings = !!data['faye-phone-settings'];

    let usersCount = 0;
    if (data['userCharacters']) { try { usersCount = JSON.parse(data['userCharacters']).length; } catch (e) { } }

    let npcsCount = 0;
    if (data['npcCharacters']) { try { npcsCount = JSON.parse(data['npcCharacters']).length; } catch (e) { } }

    let wbCount = 0;
    if (data['worldbooks']) { try { wbCount = JSON.parse(data['worldbooks']).length; } catch (e) { } }

    let stickerCount = 0;
    if (data['st-phone-stickers']) { try { stickerCount = JSON.parse(data['st-phone-stickers']).length; } catch (e) { } }

    let chatCount = Object.keys(data).filter(k => k.startsWith('faye - phone - history - ')).length;
    let memoryCount = Object.keys(data).filter(k => k.startsWith('faye-phone-memory-chat:') || k.startsWith('faye-phone-memory-settings-chat:')).length;

    let regexCount = 0;
    if (data['faye-phone-regex-rules']) { try { regexCount = JSON.parse(data['faye-phone-regex-rules']).length; } catch (e) { } }

    let musicCount = 0;
    if (data['faye-phone-music-library']) { try { musicCount = JSON.parse(data['faye-phone-music-library']).length; } catch (e) { } }

    let forumCount = 0;
    if (data['faye-phone-forum']) { try { forumCount = JSON.parse(data['faye-phone-forum']).length; } catch (e) { } }

    let momentsCount = 0;
    if (data['faye-phone-moments']) { try { momentsCount = JSON.parse(data['faye-phone-moments']).length; } catch (e) { } }

    let pomoDataCount = 0;
    const pomoKeys = ['faye-phone-pomodoro-settings', 'faye-phone-pomodoro-history', 'faye-phone-pomodoro-tasks', 'faye-phone-pomodoro-sessions', 'faye-phone-pomodoro'];
    pomoKeys.forEach(k => { if (data[k]) pomoDataCount++; });

    const overlay = document.createElement('div');
    overlay.id = 'import-data-popup';
    overlay.style.cssText = 'position:fixed; inset:0; z-index:99999; display:flex; align-items:center; justify-content:center; background:rgba(0,0,0,0.35); backdrop-filter:blur(4px);';

    const box = document.createElement('div');
    box.style.cssText = 'background:#fff; border-radius:18px; padding:24px 20px; width:320px; max-width:90vw; box-shadow:0 8px 30px rgba(0,0,0,0.15); display:flex; flex-direction:column; gap:14px;';

    box.innerHTML = `
        <div style="font-size:16px; font-weight:bold; color:#333; text-align:center;">导入数据预览</div>
        
        <div style="background:#f9f9f9; border:1px solid #eee; padding:12px; border-radius:12px; font-size:13px; color:#555; line-height:1.8; display:grid; grid-template-columns: 1fr 1fr; gap:4px;">
            <div>应用设置: <span style="color:#000;font-weight:bold;">${hasSettings ? '1' : '0'}</span> 项</div>
            <div>用户角色: <span style="color:#000;font-weight:bold;">${usersCount}</span> 个</div>
            <div>NPC角色: <span style="color:#000;font-weight:bold;">${npcsCount}</span> 个</div>
            <div>世界书: <span style="color:#000;font-weight:bold;">${wbCount}</span> 个</div>
            <div>表情包: <span style="color:#000;font-weight:bold;">${stickerCount}</span> 个</div>
            <div>聊天记录: <span style="color:#000;font-weight:bold;">${chatCount}</span> 个</div>
            <div>记忆/配置: <span style="color:#000;font-weight:bold;">${memoryCount}</span> 项</div>
            <div>正则: <span style="color:#000;font-weight:bold;">${regexCount}</span> 条</div>
            <div>音乐: <span style="color:#000;font-weight:bold;">${musicCount}</span> 首</div>
            <div>论坛: <span style="color:#000;font-weight:bold;">${forumCount}</span> 帖</div>
            <div>朋友圈: <span style="color:#000;font-weight:bold;">${momentsCount}</span> 条</div>
            <div>番茄钟: <span style="color:#000;font-weight:bold;">${pomoDataCount}</span> 项</div>
        </div>
        
        <div style="font-size:14px; font-weight:bold; color:#333; margin-top:4px;">如遇已存在的数据（按名称/标签）：</div>
        <div style="display:flex; flex-direction:column; gap:8px; font-size:14px; background:#fffafa; padding:10px; border-radius:10px; border:1px solid #fce4e4;">
            <label style="display:flex; align-items:center; gap:6px; cursor:pointer;">
                <input type="radio" name="import-conflict" value="skip" checked>
                <div style="display:flex; flex-direction:column;">
                    <span style="color:#333; font-weight:500;">跳过 (保留原数据)</span>
                </div>
            </label>
            <label style="display:flex; align-items:center; gap:6px; cursor:pointer; margin-top:4px;">
                <input type="radio" name="import-conflict" value="overwrite">
                <div style="display:flex; flex-direction:column;">
                    <span style="color:#e53935; font-weight:500;">覆盖 (使用新数据)</span>
                </div>
            </label>
        </div>
        <div style="font-size:12px; color:#999; text-align:center;">注：应用设置如果有，将始终直接覆盖</div>
        
        <div style="display:flex; gap:10px; margin-top:10px;">
            <button id="import-cancel" style="flex:1; padding:10px; border:none; border-radius:12px; background:#f5f5f5; font-size:14px; color:#999; cursor:pointer;">取消</button>
            <button id="import-confirm" style="flex:1; padding:10px; border:none; border-radius:12px; background:var(--pink-500,#e8a0b4); font-size:14px; color:#fff; font-weight:bold; cursor:pointer;">执行导入</button>
        </div>
    `;

    overlay.appendChild(box);
    document.body.appendChild(overlay);

    box.querySelector('#import-cancel').onclick = () => overlay.remove();

    box.querySelector('#import-confirm').onclick = () => {
        const conflictAction = box.querySelector('input[name="import-conflict"]:checked').value;
        executeDataImport(data, conflictAction);
        overlay.remove();
    };
}

async function executeDataImport(data, conflictAction) {
    let successCount = 0;
    let skipCount = 0;

    // Helper to merge array
    const mergeArray = (key, nameField) => {
        if (!data[key]) return;
        try {
            const importedArr = JSON.parse(data[key]);
            if (!Array.isArray(importedArr)) return;

            let currentArr = [];
            const currentStr = localStorage.getItem(key);
            if (currentStr) {
                try { currentArr = JSON.parse(currentStr); } catch (e) { }
            }
            if (!Array.isArray(currentArr)) currentArr = [];

            for (const item of importedArr) {
                const existingIndex = currentArr.findIndex(x => x[nameField] === item[nameField]);
                if (existingIndex >= 0) {
                    if (conflictAction === 'overwrite') {
                        currentArr[existingIndex] = item;
                        successCount++;
                    } else {
                        skipCount++;
                    }
                } else {
                    currentArr.push(item);
                    successCount++;
                }
            }
            localStorage.setItem(key, JSON.stringify(currentArr));
        } catch (e) {
            console.error('Merge array error for', key, e);
        }
    };

    // 1. Settings (Direct overwrite)
    if (data['faye-phone-settings']) {
        localStorage.setItem('faye-phone-settings', data['faye-phone-settings']);
        successCount++;
    }

    // 2. Characters / worldbooks / stickers
    mergeArray('userCharacters', 'name');
    mergeArray('npcCharacters', 'name');
    // Worldbooks: stored as 'faye-phone-worldbooks' but exported as 'worldbooks'
    if (data['worldbooks']) {
        try {
            const importedArr = JSON.parse(data['worldbooks']);
            if (Array.isArray(importedArr)) {
                let currentArr = [];
                const currentStr = localStorage.getItem('faye-phone-worldbooks');
                if (currentStr) { try { currentArr = JSON.parse(currentStr); } catch (e) { } }
                if (!Array.isArray(currentArr)) currentArr = [];
                for (const item of importedArr) {
                    const existingIndex = currentArr.findIndex(x => x['name'] === item['name']);
                    if (existingIndex >= 0) {
                        if (conflictAction === 'overwrite') { currentArr[existingIndex] = item; successCount++; }
                        else { skipCount++; }
                    } else { currentArr.push(item); successCount++; }
                }
                localStorage.setItem('faye-phone-worldbooks', JSON.stringify(currentArr));
            }
        } catch (e) { console.error('Merge worldbooks error:', e); }
    }
    mergeArray('st-phone-stickers', 'name');

    // 3. Chat Histories and Memories
    const chatImportPromises = [];
    for (const [key, value] of Object.entries(data)) {
        if (key.startsWith('faye - phone - history - ')) {
            // Chat history → write to IndexedDB
            const tag = key.replace('faye - phone - history - ', '').trim();
            chatImportPromises.push((async () => {
                try {
                    const importedHistory = JSON.parse(value);
                    if (!Array.isArray(importedHistory)) return;
                    const existing = await getChatHistory(tag);
                    if (existing && Array.isArray(existing)) {
                        if (conflictAction === 'overwrite') {
                            await saveChatHistory(tag, importedHistory);
                            successCount++;
                        } else {
                            skipCount++;
                        }
                    } else {
                        await saveChatHistory(tag, importedHistory);
                        successCount++;
                    }
                } catch (e) { console.error('Import chat error:', key, e); }
            })());
        } else if (key.startsWith('faye-phone-memory-chat:') || key.startsWith('faye-phone-memory-settings-chat:')) {
            // Memories stay in localStorage
            const existing = localStorage.getItem(key);
            if (existing) {
                if (conflictAction === 'overwrite') {
                    localStorage.setItem(key, value);
                    successCount++;
                } else {
                    skipCount++;
                }
            } else {
                localStorage.setItem(key, value);
                successCount++;
            }
        }
    }
    await Promise.all(chatImportPromises);

    // 4. Moments data
    const momentsKeys = ['faye-phone-moments', 'faye-phone-moments-avatar', 'faye-phone-moments-cover'];
    momentsKeys.forEach(mk => {
        if (data[mk]) {
            localStorage.setItem(mk, data[mk]);
            successCount++;
        }
    });

    // 5. Forum data
    const forumKeys = ['faye-phone-forum', 'faye-phone-forum-profile'];
    forumKeys.forEach(fk => {
        if (data[fk]) {
            localStorage.setItem(fk, data[fk]);
            successCount++;
        }
    });

    // 6. Music library + Regex rules
    const otherKeys = ['faye-phone-music-library', 'faye-phone-regex-rules'];
    otherKeys.forEach(ok => {
        if (data[ok]) {
            localStorage.setItem(ok, data[ok]);
            successCount++;
        }
    });

    // 7. Pomodoro data
    const pomoImportKeys = ['faye-phone-pomodoro-settings', 'faye-phone-pomodoro-history', 'faye-phone-pomodoro-tasks', 'faye-phone-pomodoro-sessions', 'faye-phone-pomodoro'];
    pomoImportKeys.forEach(pk => {
        if (data[pk]) {
            const existing = localStorage.getItem(pk);
            if (existing) {
                if (conflictAction === 'overwrite') {
                    localStorage.setItem(pk, data[pk]);
                    successCount++;
                } else {
                    skipCount++;
                }
            } else {
                localStorage.setItem(pk, data[pk]);
                successCount++;
            }
        }
    });

    showToast(`✅ 导入完成！成功 ${successCount} 项，跳过 ${skipCount} 项。即将刷新...`);
    setTimeout(() => location.reload(), 2000);
}

async function clearAllData() {
    if (!confirm('确定要清除所有数据吗？此操作不可恢复！')) return;
    const keysToRemove = [];
    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key.startsWith('faye-phone')) {
            keysToRemove.push(key);
        }
    }
    keysToRemove.forEach(key => localStorage.removeItem(key));
    // Also clear IndexedDB chat histories
    try {
        await clearAllChatHistories();
    } catch (e) {
        console.error('Failed to clear IndexedDB:', e);
    }
    showToast('✅ 数据已清除');
    setTimeout(() => location.reload(), 1500);
}

function openBeautifySettings() {
    document.getElementById('set-icon-bg').value = appSettings.iconBg;
    document.getElementById('set-icon-color').value = appSettings.iconColor;
    document.getElementById('set-home-text-color').value = appSettings.homeTextColor;
    document.getElementById('set-custom-css').value = appSettings.customCss || '';
    document.getElementById('preview-home-bg').src = appSettings.homeBg || '';
    window.renderHomePresetSelect();
    // Font settings
    const fontNameEl = document.getElementById('current-font-name');
    if (fontNameEl) fontNameEl.textContent = (appSettings.customFontName || '未设置');
    const fontScopeEl = document.getElementById('font-apply-scope');
    if (fontScopeEl) fontScopeEl.value = appSettings.fontScope || 'global';

    if (settingsScreen) settingsScreen.style.display = 'none';
    const beautifyScreen = document.getElementById('beautify-screen');
    if (beautifyScreen) beautifyScreen.style.display = 'flex';
    updateStatusBar('settings');
}

function closeBeautifySettings() {
    const beautifyScreen = document.getElementById('beautify-screen');
    if (beautifyScreen) beautifyScreen.style.display = 'none';
    if (settingsScreen) settingsScreen.style.display = 'flex';
    updateStatusBar('settings');
}

function getHomePresets() {
    try {
        return JSON.parse(localStorage.getItem('faye-home-presets')) || {};
    } catch (e) { return {}; }
}
function saveHomePresets(presets) {
    localStorage.setItem('faye-home-presets', JSON.stringify(presets));
}
window.renderHomePresetSelect = function () {
    const sel = document.getElementById('home-preset-select');
    if (!sel) return;
    const presets = getHomePresets();
    sel.innerHTML = '<option value="">选择配置...</option>';
    for (let name in presets) {
        sel.innerHTML += `<option value="${name}">${name}</option>`;
    }
};

// Custom preset name prompt popup
function showPresetNamePrompt(callback) {
    const old = document.getElementById('preset-name-popup');
    if (old) old.remove();
    const overlay = document.createElement('div');
    overlay.id = 'preset-name-popup';
    overlay.style.cssText = 'position:fixed; inset:0; z-index:99999; display:flex; align-items:center; justify-content:center; background:rgba(0,0,0,0.35); backdrop-filter:blur(4px);';
    overlay.onclick = (e) => { if (e.target === overlay) { overlay.remove(); } };
    const box = document.createElement('div');
    box.style.cssText = 'background:#fff; border-radius:18px; padding:24px 20px; width:260px; box-shadow:0 8px 30px rgba(0,0,0,0.15); display:flex; flex-direction:column; gap:14px; align-items:center;';
    box.innerHTML = `
        <div style="font-size:15px; font-weight:bold; color:#333;">\u4fdd\u5b58\u9884\u8bbe</div>
        <input id="preset-name-input" type="text" placeholder="\u8bf7\u8f93\u5165\u9884\u8bbe\u540d\u79f0" style="width:100%; padding:10px 12px; border:1px solid #ddd; border-radius:12px; font-size:14px; outline:none; box-sizing:border-box; text-align:center;" />
        <div style="display:flex; gap:10px; width:100%;">
            <button id="preset-cancel" style="flex:1; padding:10px; border:none; border-radius:12px; background:#f5f5f5; font-size:14px; color:#999; cursor:pointer;">\u53d6\u6d88</button>
            <button id="preset-confirm" style="flex:1; padding:10px; border:none; border-radius:12px; background:var(--pink-500,#e8a0b4); font-size:14px; color:#fff; font-weight:bold; cursor:pointer;">\u786e\u5b9a</button>
        </div>`;
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    const inp = box.querySelector('#preset-name-input');
    setTimeout(() => inp.focus(), 100);
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { box.querySelector('#preset-confirm').click(); } });
    box.querySelector('#preset-cancel').onclick = () => overlay.remove();
    box.querySelector('#preset-confirm').onclick = () => {
        const val = inp.value.trim();
        overlay.remove();
        if (val) callback(val);
    };
}

window.saveHomePreset = function () {
    showPresetNamePrompt(function (name) {
        const presets = getHomePresets();
        presets[name] = {
            iconBg: document.getElementById('set-icon-bg').value,
            iconColor: document.getElementById('set-icon-color').value,
            homeTextColor: document.getElementById('set-home-text-color').value,
            customCss: document.getElementById('set-custom-css').value,
            homeBg: document.getElementById('preview-home-bg').src,
            customFontName: appSettings.customFontName || '',
            customFontData: appSettings.customFontData || '',
            fontScope: (document.getElementById('font-apply-scope') || {}).value || 'global',
        };
        saveHomePresets(presets);
        window.renderHomePresetSelect();
        showToast('预设已保存，下拉可重新读取');
    });
};
window.applyHomePreset = function () {
    const sel = document.getElementById('home-preset-select');
    if (!sel || !sel.value) return;
    const presets = getHomePresets();
    const p = presets[sel.value];
    if (!p) return;
    if (p.iconBg) document.getElementById('set-icon-bg').value = p.iconBg;
    if (p.iconColor) document.getElementById('set-icon-color').value = p.iconColor;
    if (p.homeTextColor) document.getElementById('set-home-text-color').value = p.homeTextColor;
    if (p.customCss !== undefined) document.getElementById('set-custom-css').value = p.customCss;
    if (p.homeBg) document.getElementById('preview-home-bg').src = p.homeBg;
    // Font
    if (p.customFontName) {
        appSettings.customFontName = p.customFontName;
        appSettings.customFontData = p.customFontData || '';
        appSettings.fontScope = p.fontScope || 'global';
        const nameEl = document.getElementById('current-font-name');
        if (nameEl) nameEl.textContent = p.customFontName;
        const scopeEl = document.getElementById('font-apply-scope');
        if (scopeEl) scopeEl.value = p.fontScope || 'global';
    }
    showToast('已读取预设，点击下方保存生效');
};

// == Font Upload ==
window.uploadCustomFont = function () {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.ttf,.otf,.woff,.woff2';
    input.onchange = (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (ev) => {
            appSettings.customFontName = file.name;
            appSettings.customFontData = ev.target.result;
            const nameEl = document.getElementById('current-font-name');
            if (nameEl) nameEl.textContent = file.name;
            showToast('字体已加载，点击保存应用');
        };
        reader.readAsDataURL(file);
    };
    input.click();
};
window.clearCustomFont = function () {
    appSettings.customFontName = '';
    appSettings.customFontData = '';
    appSettings.fontScope = 'global';
    const nameEl = document.getElementById('current-font-name');
    if (nameEl) nameEl.textContent = '未设置';
    showToast('字体已清除，点击保存应用');
};
function applyCustomFont() {
    let styleEl = document.getElementById('custom-font-style');
    if (!styleEl) {
        styleEl = document.createElement('style');
        styleEl.id = 'custom-font-style';
        document.head.appendChild(styleEl);
    }
    if (!appSettings.customFontData) {
        styleEl.textContent = '';
        return;
    }
    const scope = appSettings.fontScope || 'global';
    const fontFace = `@font-face { font-family: 'CustomUserFont'; src: url('${appSettings.customFontData}'); }`;
    if (scope === 'global') {
        styleEl.textContent = fontFace + `\n* { font-family: 'CustomUserFont', sans-serif !important; }`;
    } else {
        styleEl.textContent = fontFace + `\n#chat-messages, #chat-messages * { font-family: 'CustomUserFont', sans-serif !important; }`;
    }
}

async function saveBeautifySettings() {
    appSettings.iconBg = document.getElementById('set-icon-bg').value;
    appSettings.iconColor = document.getElementById('set-icon-color').value;
    appSettings.homeTextColor = document.getElementById('set-home-text-color').value;
    appSettings.customCss = document.getElementById('set-custom-css').value;
    console.log('[SaveBeautify] customCss value length:', appSettings.customCss.length, 'first 100:', appSettings.customCss.substring(0, 100));
    const fontScopeEl = document.getElementById('font-apply-scope');
    if (fontScopeEl) appSettings.fontScope = fontScopeEl.value;

    applySettings();
    applyCustomFont();

    const homeBgUrl = document.getElementById('preview-home-bg').src;
    if (homeBgUrl && homeBgUrl !== window.location.href) {
        appSettings.homeBg = homeBgUrl;
        try {
            const brightnessPromise = analyzeImageBrightness(appSettings.homeBg);
            const timeoutPromise = new Promise(resolve => setTimeout(() => resolve(null), 1000));
            const result = await Promise.race([brightnessPromise, timeoutPromise]);
            if (result !== null) {
                appSettings.homeBgIsDark = result;
            }
        } catch (e) { console.error('Image analysis failed', e); }
    }

    saveSettingsToStorage();
    applySettings(); closeBeautifySettings();
}

function updateClock() {
    // Reuse global getTime logic which handles both simulated dates and time offsets
    const timeStr = typeof getTime === 'function' ? getTime(true) : '';
    if (timeStr) {
        if (clockEl) clockEl.textContent = timeStr;

        const localLockClockEl = document.getElementById('lock-clock');
        if (localLockClockEl) localLockClockEl.textContent = timeStr;

        const lockDateEl = document.getElementById('lock-date');
        if (lockDateEl && typeof window.getSimulatedDate === 'function') {
            const d = typeof getTime === 'function' ? getTime(true, true) : window.getSimulatedDate();
            const month = d.getMonth() + 1;
            const date = d.getDate();
            const weekDays = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
            const dayOfWeek = weekDays[d.getDay()];
            lockDateEl.textContent = `${month}月${date}日 ${dayOfWeek}`;
        }
    }
}


// Battery Status API - show real device battery level
function updateBattery() {
    if (!navigator.getBattery) return;
    navigator.getBattery().then(battery => {
        const applyLevel = () => {
            const fill = document.getElementById('battery-fill');
            const lockFill = document.getElementById('lock-battery-fill');
            const lockText = document.getElementById('lock-battery-text');
            const mainText = document.getElementById('battery-text');

            const level = battery.level; // 0.0 ~ 1.0
            const mainFillWidth = Math.round(level * 20);
            const lockFillWidth = Math.round(level * 16);

            let color = 'currentColor';
            if (level <= 0.2) color = '#e53935';

            if (fill) {
                fill.setAttribute('width', mainFillWidth);
                fill.setAttribute('fill', color);
            }

            if (lockFill) {
                lockFill.setAttribute('width', lockFillWidth);
                lockFill.setAttribute('fill', color);
            }

            const percentVal = Math.round(level * 100);
            if (lockText) lockText.textContent = percentVal + '%';
            if (mainText) {
                mainText.textContent = percentVal;
                mainText.style.color = (level <= 0.2) ? '#e53935' : '';
            }
        };
        applyLevel();
        battery.addEventListener('levelchange', applyLevel);
    });
}
updateBattery();

function updateStatusBar(screen) {
    let isDark = false;
    if (screen === 'home') isDark = appSettings.homeBgIsDark;
    else if (screen === 'chat') isDark = appSettings.chatBgIsDark;
    else if (screen === 'settings') isDark = false;
    else if (screen === 'message-list') isDark = false;
    else if (screen === 'dark-search') isDark = false;

    if (screen === 'home' && !appSettings.homeBg) isDark = false;
    if (screen === 'chat' && !appSettings.chatBg) isDark = false;

    if (statusBar) statusBar.className = isDark ? 'status-bar text-light' : 'status-bar text-dark';
}

function analyzeImageBrightness(base64) {
    return new Promise((resolve) => {
        if (!base64) { resolve(false); return; }
        const img = new Image();
        img.crossOrigin = 'Anonymous';
        img.src = base64;
        img.onload = () => {
            const canvas = document.createElement('canvas'); canvas.width = 50; canvas.height = 50;
            const ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0, 50, 50);
            try {
                const data = ctx.getImageData(0, 0, 50, 50).data; let r = 0, g = 0, b = 0;
                for (let i = 0; i < data.length; i += 4) { r += data[i]; g += data[i + 1]; b += data[i + 2]; }
                resolve(((r + g + b) / (3 * (data.length / 4))) < 128);
            } catch (e) { resolve(false); }
        };
        img.onerror = () => resolve(false);
    });
}



function loadSettings() {
    const savedSettings = localStorage.getItem('faye-phone-settings');
    if (savedSettings) {
        try {
            const parsed = JSON.parse(savedSettings);
            appSettings = { ...defaultAppSettings, ...parsed };
        } catch (e) {
            console.error("Failed to parse settings from localStorage", e);
            appSettings = { ...defaultAppSettings };
        }
    } else {
        appSettings = { ...defaultAppSettings };
    }

    // === 迁移：旧 MiniMax 域名已失效，自动替换 ===
    let needsSave = false;
    if (appSettings.ttsApiEndpoint === 'https://api.minimax.chat' ||
        appSettings.ttsApiEndpoint === 'https://api.minimaxi.chat') {
        appSettings.ttsApiEndpoint = 'https://api.minimaxi.com';
        needsSave = true;
        console.log('[Settings] 已自动迁移 TTS 端点 → api.minimaxi.com');
    }
    // CORS 代理：清空旧值，让运行时自动走 nginx 反向代理 /minimax-tts/
    if (appSettings.ttsCorsProxy !== undefined &&
        (appSettings.ttsCorsProxy.trim() === '' || appSettings.ttsCorsProxy === 'https://corsproxy.io/?')) {
        delete appSettings.ttsCorsProxy;
        needsSave = true;
        console.log('[Settings] 已清理旧 CORS 代理设置，将使用内置反向代理');
    }
    if (needsSave) saveSettingsToStorage();
}


function saveSettingsToStorage() {
    localStorage.setItem('faye-phone-settings', JSON.stringify(appSettings));
}



function hexToRgba(hex, alpha) {
    let r = 0, g = 0, b = 0;
    if (hex.length === 4) {
        r = parseInt("0x" + hex[1] + hex[1]);
        g = parseInt("0x" + hex[2] + hex[2]);
        b = parseInt("0x" + hex[3] + hex[3]);
    } else if (hex.length === 7) {
        r = parseInt("0x" + hex[1] + hex[2]);
        g = parseInt("0x" + hex[3] + hex[4]);
        b = parseInt("0x" + hex[5] + hex[6]);
    }
    return `rgba(${r},${g},${b},${alpha})`;
}

function applySettings() {

    if (homeScreen) {
        if (appSettings.homeBg) homeScreen.style.backgroundImage = `url(${appSettings.homeBg})`;
        else { homeScreen.style.backgroundImage = 'none'; homeScreen.style.backgroundColor = '#fdf0f2'; }
    }
    if (lockScreen) {
        if (appSettings.homeBg) lockScreen.style.backgroundImage = `url(${appSettings.homeBg})`;
        else { lockScreen.style.backgroundImage = 'none'; lockScreen.style.backgroundColor = '#fdf0f2'; }
    }
    if (chatScreen) {
        if (appSettings.chatBg) { chatScreen.style.backgroundImage = `url(${appSettings.chatBg})`; chatScreen.style.backgroundColor = '#fdf6f7'; }
        else { chatScreen.style.backgroundImage = 'none'; chatScreen.style.backgroundColor = '#fdf6f7'; }
    }

    document.querySelectorAll('.app-icon-style').forEach(el => {
        el.style.background = appSettings.iconBg;
        const svg = el.querySelector('svg');
        if (svg) svg.style.fill = appSettings.iconColor;
        const mask = el.querySelector('.app-icon-image');
        if (mask) mask.style.backgroundColor = appSettings.iconColor;
    });

    if (appSettings.homeTextColor) {
        if (lockClockEl) lockClockEl.style.color = appSettings.homeTextColor;
        document.querySelectorAll('.app-name').forEach(el => el.style.color = appSettings.homeTextColor);
    }

    // 只在聊天相关页面设置 --interface-bg
    const rgba = hexToRgba(appSettings.interfaceColor || '#f7f7f7', 0.6);
    if (chatScreen) chatScreen.style.setProperty('--interface-bg', rgba);
    // 主屏和消息列表不设置 --interface-bg，保持原有色彩

    const rootStyle = document.documentElement.style;
    rootStyle.setProperty('--msg-name-color', appSettings.msgNameColor || '#c4969e');
    rootStyle.setProperty('--msg-time-color', appSettings.msgTimeColor || '#cbadb3');
    rootStyle.setProperty('--msg-font-size', (appSettings.fontSize || 14) + 'px');
    const btnRgba = hexToRgba(appSettings.chatBtnColor || '#f0b8c2', 0.6);
    rootStyle.setProperty('--chat-btn-color', btnRgba);
    rootStyle.setProperty('--chat-btn-color-solid', appSettings.chatBtnColor || '#f0b8c2');
    rootStyle.setProperty('--chat-btn-text', appSettings.chatBtnText || '#d4778a');

    // Apply bubble colors via CSS variables (allows custom CSS to override)
    if (appSettings.charBubble) rootStyle.setProperty('--bubble-received', appSettings.charBubble);
    else rootStyle.removeProperty('--bubble-received');
    if (appSettings.charText) rootStyle.setProperty('--bubble-received-text', appSettings.charText);
    else rootStyle.removeProperty('--bubble-received-text');
    if (appSettings.userBubble) rootStyle.setProperty('--bubble-sent', appSettings.userBubble);
    else rootStyle.removeProperty('--bubble-sent');
    if (appSettings.userText) rootStyle.setProperty('--bubble-sent-text', appSettings.userText);
    else rootStyle.removeProperty('--bubble-sent-text');

    // Apply Custom CSS - append to body end for maximum priority
    let styleTag = document.getElementById('custom-css-style');
    if (!styleTag) {
        styleTag = document.createElement('style');
        styleTag.id = 'custom-css-style';
        document.body.appendChild(styleTag);
    }
    const cssContent = appSettings.customCss || '';
    styleTag.textContent = cssContent;

    // Update UI inputs
    const useSunboxEl = document.getElementById('set-use-sunbox');
    if (useSunboxEl) useSunboxEl.checked = (appSettings.useSunbox !== false); // Default true

    updateStatusBar('home'); loadInitialChat();
    applyCustomFont();
}


// saveHomeSettings removed - split into saveApiSettings and saveBeautifySettings

function renderAvatarSettings() {
    const container = document.getElementById('avatar-settings-container');
    if (!container) return;
    container.innerHTML = '';

    const placeholderAvatar = "data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='%23cccccc'%3E%3Cpath d='M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z'/%3E%3C/svg%3E";

    const isGroup = currentChatTag && currentChatTag.startsWith('group:');
    const myName = getUserName();

    if (isGroup) {
        // 群聊模式：保持原有grid布局
        container.className = 'avatar-grid';
        let members = [];

        // 顶部插入群聊头像
        const groupAvatarDiv = document.createElement('div');
        groupAvatarDiv.className = 'avatar-grid-item';
        const groupImg = document.createElement('img');
        groupImg.className = 'avatar-sq';
        let groupAvatar = appSettings.groupAvatars && appSettings.groupAvatars[currentChatTag]
            ? appSettings.groupAvatars[currentChatTag]
            : placeholderAvatar;
        groupImg.src = groupAvatar;
        groupImg.style.border = '2px solid #ccc';
        groupImg.style.background = '#fff';
        groupImg.title = '群聊头像';
        groupImg.onclick = () => triggerSettingsUpload('group-avatar');
        const groupLabel = document.createElement('span');
        groupLabel.className = 'avatar-name';
        groupLabel.textContent = '群聊头像';
        groupAvatarDiv.appendChild(groupImg);
        groupAvatarDiv.appendChild(groupLabel);
        container.appendChild(groupAvatarDiv);

        const tag = currentChatTag;
        const groupInfo = appSettings.groups ? appSettings.groups.find(g => `group:${g.name}` === tag) : null;
        if (groupInfo) {
            groupInfo.members.forEach(m => {
                const isMe = (m === myName || m === 'User' || m === '我');
                let av = placeholderAvatar;
                if (isMe) {
                    // Priority 1: Per-chat bound User Character
                    const uid = getCurrentUserId();
                    if (uid !== undefined && userCharacters[uid]) {
                        av = userCharacters[uid].avatar;
                    }
                    // Priority 2: Global User Avatar
                    else if (appSettings.userAvatar) {
                        av = appSettings.userAvatar;
                    }
                }

                // Priority 3: Member Avatar (fallback for user, primary for others)
                if ((!av || av === placeholderAvatar) && appSettings.memberAvatars && appSettings.memberAvatars[m]) {
                    av = appSettings.memberAvatars[m];
                }
                let uploadKey = `member:${m}`;
                if (isMe) uploadKey = 'user-avatar';
                members.push({ name: m, isMe: isMe, avatar: av, uploadKey: uploadKey });
            });
        } else {
            members.push({ name: '群成员', isMe: false, avatar: placeholderAvatar, uploadKey: 'char-avatar' });
        }

        members.forEach(m => {
            const item = document.createElement('div');
            item.className = 'avatar-grid-item';
            const img = document.createElement('img');
            img.className = 'avatar-sq';
            img.src = m.avatar;
            img.onclick = () => triggerSettingsUpload(m.uploadKey);
            const safeId = 'preview-av-' + m.uploadKey.replace(/[^a-zA-Z0-9]/g, '');
            img.id = safeId;
            const label = document.createElement('span');
            label.className = 'avatar-name';
            label.textContent = m.isMe ? getUserName() : m.name;
            item.appendChild(img);
            item.appendChild(label);
            container.appendChild(item);
        });
    } else {
        // 私聊模式：显示user和角色两人的头像（从创建时设置的头像获取）
        container.className = 'avatar-pair-container';
        container.style.display = 'flex';
        container.style.justifyContent = 'center';
        container.style.alignItems = 'flex-start';
        container.style.gap = '30px';
        container.style.padding = '16px 10px';

        // 获取当前选中的user头像（从user创建时设置的头像，按聊天隔离）
        let userAvatar = placeholderAvatar;
        let userName = getUserName();
        const uid = getCurrentUserId();
        if (uid !== undefined && userCharacters[uid]) {
            const currentUser = userCharacters[uid];
            userAvatar = currentUser.avatar || placeholderAvatar;
            userName = currentUser.name || getUserName();
        } else if (appSettings.userAvatar) {
            userAvatar = appSettings.userAvatar;
        }

        // 获取角色头像（从NPC创建时设置的头像）
        const targetName = getCharName();
        let charAvatar = placeholderAvatar;
        // 优先从npcCharacters中查找匹配的角色头像
        if (npcCharacters && npcCharacters.length > 0) {
            const matchedNpc = npcCharacters.find(npc => npc.name === targetName);
            if (matchedNpc && matchedNpc.avatar) {
                charAvatar = matchedNpc.avatar;
            }
        }
        // 其次从memberAvatars中查找
        if (charAvatar === placeholderAvatar && appSettings.memberAvatars && appSettings.memberAvatars[targetName]) {
            charAvatar = appSettings.memberAvatars[targetName];
        }
        // 最后使用appSettings.charAvatar
        if (charAvatar === placeholderAvatar && appSettings.charAvatar) {
            charAvatar = appSettings.charAvatar;
        }

        // User头像
        const userItem = document.createElement('div');
        userItem.className = 'avatar-pair-item';
        userItem.style.display = 'flex';
        userItem.style.flexDirection = 'column';
        userItem.style.alignItems = 'center';
        userItem.style.gap = '6px';
        const userImg = document.createElement('img');
        userImg.className = 'avatar-pair-img';
        userImg.style.width = '56px';
        userImg.style.height = '56px';
        userImg.style.borderRadius = '0';
        userImg.style.objectFit = 'cover';
        userImg.style.backgroundColor = '#eee';
        userImg.style.border = '2.5px solid #ddd';
        userImg.src = userAvatar;
        userImg.onclick = () => triggerSettingsUpload('user-avatar');
        const userLabel = document.createElement('div');
        userLabel.className = 'avatar-pair-label';
        userLabel.textContent = userName;
        userItem.appendChild(userImg);
        userItem.appendChild(userLabel);

        // 角色头像
        const charItem = document.createElement('div');
        charItem.className = 'avatar-pair-item';
        charItem.style.display = 'flex';
        charItem.style.flexDirection = 'column';
        charItem.style.alignItems = 'center';
        charItem.style.gap = '6px';
        const charImg = document.createElement('img');
        charImg.className = 'avatar-pair-img';
        charImg.style.width = '56px';
        charImg.style.height = '56px';
        charImg.style.borderRadius = '0';
        charImg.style.objectFit = 'cover';
        charImg.style.backgroundColor = '#eee';
        charImg.style.border = '2.5px solid #ddd';
        charImg.src = charAvatar;
        charImg.onclick = () => triggerSettingsUpload(`member:${targetName}`);
        charImg.id = 'preview-av-member' + targetName.replace(/[^a-zA-Z0-9]/g, '');
        const charLabel = document.createElement('div');
        charLabel.className = 'avatar-pair-label';
        charLabel.textContent = targetName;
        charItem.appendChild(charImg);
        charItem.appendChild(charLabel);

        container.appendChild(userItem);
        container.appendChild(charItem);

        // Debug
        // alert("Avatar rendered successfully. Check if it is visible. Container height: " + container.offsetHeight);
    }
}

function renderUserSelectorBar() {
    const bar = document.getElementById('user-selector-bar');
    if (!bar) return;
    bar.innerHTML = '';

    const defaultAv = "data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='%23d1d1d6'%3E%3Cpath d='M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z'/%3E%3C/svg%3E";

    if (!userCharacters || userCharacters.length === 0) {
        bar.innerHTML = '<div class="user-selector-empty">请先在「user设置」中创建角色</div>';
        return;
    }

    const currentId = getCurrentUserId() !== undefined ? getCurrentUserId() : (appSettings.currentUserId !== undefined ? appSettings.currentUserId : 0);

    userCharacters.forEach((user, index) => {
        const item = document.createElement('div');
        item.className = 'user-selector-chip' + (index === currentId ? ' selected' : '');
        item.onclick = () => {
            // 更新选中状态
            bar.querySelectorAll('.user-selector-chip').forEach(el => el.classList.remove('selected'));
            item.classList.add('selected');
            // 同步隐藏的select
            const hiddenSelect = document.getElementById('user-selector');
            if (hiddenSelect) hiddenSelect.value = index;
            // Per-chat isolation: update chatUserIds for current chat
            if (currentChatTag) {
                if (!appSettings.chatUserIds) appSettings.chatUserIds = {};
                appSettings.chatUserIds[currentChatTag] = index;
            }
            // 更新头像设置区域，并立即保存
            appSettings.currentUserId = index;
            appSettings.userAvatar = user.avatar || defaultAv;
            renderAvatarSettings();
            saveSettingsToStorage();
        };

        const img = document.createElement('img');
        img.className = 'user-selector-chip-avatar';
        img.src = user.avatar || defaultAv;

        const name = document.createElement('span');
        name.className = 'user-selector-chip-name';
        name.textContent = user.name || '未命名';

        item.appendChild(img);
        item.appendChild(name);
        bar.appendChild(item);
    });
}

﻿
const chatBeautifyScreen = document.getElementById('chat-beautify-screen');
const chatMemoryScreen = document.getElementById('chat-memory-screen');

function openChatSettings() {
    // Init Main Settings (per-chat isolated block states)
    const blockChar = document.getElementById('set-block-char');
    if (blockChar) blockChar.checked = getChatBlockChar();

    // Render Avatar Settings (Moved back to main)
    const userSelector = document.getElementById('user-selector');
    if (userSelector) {
        userSelector.innerHTML = '';
        if (userCharacters && userCharacters.length > 0) {
            userCharacters.forEach((user, index) => {
                const option = document.createElement('option');
                option.value = index;
                option.textContent = user.name;
                userSelector.appendChild(option);
            });
            // Per-chat isolation: use chatUserIds for this chat, fallback to global
            const perChatUserId = getCurrentUserId();
            if (perChatUserId !== undefined) {
                userSelector.value = perChatUserId;
            } else if (appSettings.currentUserId !== undefined) {
                userSelector.value = appSettings.currentUserId;
            }
        }
    }
    renderUserSelectorBar();
    renderAvatarSettings();

    // Load timezone settings
    loadCharTimezoneUI();

    // Load mate mode setting
    loadChatMateModeUI();

    // Load toy control setting
    loadChatToyModeUI();

    // Load inner voice mode setting
    loadChatInnerVoiceModeUI();

    // Load remark setting
    loadChatRemarkUI();

    // Load per-chat NAI settings
    loadChatNaiUI();

    // Load per-chat TTS settings
    loadChatTtsUI();

    // Load per-chat Auto Interactions
    loadChatAutoInteractionsUI();

    // Load Web Notification UI
    loadWebNotifUI();

    // Load Group Sync UI
    loadChatGroupSyncUI();

    // Load Hide Name UI
    loadChatHideNameUI();

    if (chatSettingsScreen) chatSettingsScreen.style.display = 'flex';
    updateStatusBar('settings');
}

function getChatSettings() {
    if (!currentChatTag) return {};
    const key = `faye-phone-chatsettings-${currentChatTag}`;
    try { return JSON.parse(localStorage.getItem(key) || '{}'); } catch (e) { return {}; }
}

function getChatSettingsFor(tag) {
    if (!tag) return {};
    const key = `faye-phone-chatsettings-${tag}`;
    try { return JSON.parse(localStorage.getItem(key) || '{}'); } catch (e) { return {}; }
}

function saveChatSettingsObj(obj) {
    if (!currentChatTag) return;
    const key = `faye-phone-chatsettings-${currentChatTag}`;
    localStorage.setItem(key, JSON.stringify(obj));
}

// ===== Per-chat Auto Interactions =====
function loadChatAutoInteractionsUI() {
    const s = getChatSettings();
    const autoMomentEnabled = s.autoMomentEnabled || false;
    const autoMomentInterval = s.autoMomentInterval || 60;
    const autoMessageEnabled = s.autoMessageEnabled || false;
    const autoMessageInterval = s.autoMessageInterval || 60;

    const amE = document.getElementById('chat-auto-moment-enabled');
    if (amE) amE.checked = autoMomentEnabled;
    const amI = document.getElementById('chat-auto-moment-interval');
    if (amI) amI.value = autoMomentInterval;
    const amD = document.getElementById('chat-auto-moment-detail');
    if (amD) amD.style.display = autoMomentEnabled ? 'block' : 'none';

    const amsgE = document.getElementById('chat-auto-message-enabled');
    if (amsgE) amsgE.checked = autoMessageEnabled;
    const amsgI = document.getElementById('chat-auto-message-interval');
    if (amsgI) amsgI.value = autoMessageInterval;
    const amsgD = document.getElementById('chat-auto-message-detail');
    if (amsgD) amsgD.style.display = autoMessageEnabled ? 'block' : 'none';
}

function saveChatAutoInteractions() {
    const s = getChatSettings();
    const amE = document.getElementById('chat-auto-moment-enabled');
    const amI = document.getElementById('chat-auto-moment-interval');
    const amsgE = document.getElementById('chat-auto-message-enabled');
    const amsgI = document.getElementById('chat-auto-message-interval');

    s.autoMomentEnabled = amE ? amE.checked : false;
    s.autoMomentInterval = amI ? (parseInt(amI.value) || 60) : 60;
    s.autoMessageEnabled = amsgE ? amsgE.checked : false;
    s.autoMessageInterval = amsgI ? (parseInt(amsgI.value) || 60) : 60;

    const now = Date.now();
    if (s.autoMomentEnabled && !s.autoMomentLastTrigger) {
        s.autoMomentLastTrigger = now;
    }
    if (s.autoMessageEnabled && !s.autoMessageLastTrigger) {
        s.autoMessageLastTrigger = now;
    }

    saveChatSettingsObj(s);

    const amD = document.getElementById('chat-auto-moment-detail');
    if (amD) amD.style.display = s.autoMomentEnabled ? 'block' : 'none';
    const amsgD = document.getElementById('chat-auto-message-detail');
    if (amsgD) amsgD.style.display = s.autoMessageEnabled ? 'block' : 'none';
}

let isCheckingAutoInteractions = false;
async function checkAutoInteractions() {
    if (isCheckingAutoInteractions) return;
    isCheckingAutoInteractions = true;
    try {
        const now = Date.now();
        console.log('[AutoCheck] Running check at', new Date().toLocaleTimeString());
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key && key.startsWith('faye-phone-chatsettings-')) {
                const tag = key.replace('faye-phone-chatsettings-', '');
                let s;
                try { s = JSON.parse(localStorage.getItem(key)); } catch (e) { continue; }

                if (s && s.autoMomentEnabled) {
                    const intervalMs = (s.autoMomentInterval || 60) * 60000;
                    const last = s.autoMomentLastTrigger || now;
                    if (now - last >= intervalMs) {
                        s.autoMomentLastTrigger = now;
                        localStorage.setItem(key, JSON.stringify(s));
                        await triggerAIAutoMoment(tag);
                    }
                }

                if (s && s.autoMessageEnabled) {
                    const intervalMs = (s.autoMessageInterval || 60) * 60000;
                    const last = s.autoMessageLastTrigger || now;
                    const elapsed = now - last;
                    console.log(`[AutoCheck] tag=${tag}, interval=${intervalMs / 60000}min, elapsed=${Math.round(elapsed / 1000)}s, needsWait=${Math.round((intervalMs - elapsed) / 1000)}s`);
                    if (elapsed >= intervalMs) {
                        console.log('[AutoCheck] TRIGGERING auto message for', tag);
                        s.autoMessageLastTrigger = now;
                        localStorage.setItem(key, JSON.stringify(s));
                        await triggerAIAutoMessage(tag);
                    }
                }
            }
        }
    } catch (e) {
        console.error(e);
    }
    isCheckingAutoInteractions = false;
}

// Check every minute
setInterval(checkAutoInteractions, 60 * 1000);

async function triggerAIAutoMoment(tag) {
    const isGroup = tag.startsWith('group:');
    const npcName = isGroup ? null : tag.replace(/^chat:/, '');
    if (!npcName) return;
    const npc = npcCharacters.find(n => n.name === npcName);
    if (!npc) return;

    try {
        const userId = getChatSettingsFor(tag).currentUserId !== undefined ? getChatSettingsFor(tag).currentUserId : appSettings.currentUserId;
        const currentUserName = (userId !== undefined && userCharacters[userId]) ? userCharacters[userId].name : 'User';

        let chatContext = '';
        const chatTag = `chat:${npcName}`;
        try {
            const history = await getChatHistory(chatTag);
            if (history && Array.isArray(history)) {
                const recentMsgs = history.slice(-10);
                chatContext = recentMsgs.map(m => {
                    const sender = m.isUser ? currentUserName : npc.name;
                    return `${sender}: ${m.body || ''}`;
                }).join('\n');
            }
        } catch (e) { }

        let persona = npc.persona || npc.desc || '';
        if (npc.personality) persona += `\n性格: ${npc.personality}`;
        if (npc.scenario) persona += `\n背景: ${npc.scenario}`;
        const systemPrompt = `你是${npc.name}，正在发朋友圈动态。
角色设定：{persona}
${chatContext ? '最近和' + currentUserName + '的聊天记录：\n' + chatContext + '\n' : ''}
请用${npc.name}的语气和性格，写一条朋友圈动态。要求：
1. 必须完全以角色身份说话，风格自然、生活化
2. 可以参考最近的事情，或者只是简单分享感悟或记录生活
3. 30-80字，不要太长
4. 如果你想配一张或多张图片，请在文中加上：[图片：照片的详细描述]
5. 只输出正文和图片标签，不要加引号、标签或前缀`;

        const messages = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: '请发一条朋友圈动态。' }
        ];

        const stream = await callLLM(messages);
        let momentText = '';
        const reader = stream.getReader();
        const decoder = new TextDecoder();
        let streamBuffer = '';
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = decoder.decode(value, { stream: true });
            streamBuffer += chunk;
            const lines = streamBuffer.split('\n');
            streamBuffer = lines.pop();
            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    const data = line.slice(6).trim();
                    if (data === '[DONE]') break;
                    try {
                        const json = JSON.parse(data);
                        const content = json.choices?.[0]?.delta?.content;
                        if (content) momentText += content;
                    } catch (e) { }
                }
            }
        }

        momentText = momentText.replace(/^["'“”‘’「」『』]|["'“”‘’「」『』]$/g, '').trim();
        let extractedImages = [];
        const imgRegex = /\[图片[：:](.*?)\]/g;
        let matchReg;
        while ((matchReg = imgRegex.exec(momentText)) !== null) {
            extractedImages.push('txt:' + matchReg[1].trim());
        }
        momentText = momentText.replace(imgRegex, '').trim();

        if (momentText || extractedImages.length > 0) {
            loadMomentsData();
            const post = {
                id: `moment_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
                author: npc.name,
                text: momentText,
                images: extractedImages,
                likes: [],
                comments: [],
                timestamp: Date.now()
            };
            momentsPosts.unshift(post);
            saveMomentsData();
            if (typeof renderMoments === 'function') renderMoments();
        }
    } catch (e) { console.error('Auto moment error', e); }
}

async function triggerAIAutoMessage(tag) {
    const isGroup = tag.startsWith('group:');
    const npcName = isGroup ? null : tag.replace(/^chat:/, '');
    if (!npcName && !isGroup) return;

    try {
        let systemPrompt = '';
        let targetGroup = null;
        let currentUserName = '';
        let mappedNpcName = '';
        const nowTime = new Date();
        const timeStr = `${nowTime.getHours().toString().padStart(2, '0')}:${nowTime.getMinutes().toString().padStart(2, '0')}`;

        if (!isGroup) {
            const npc = npcCharacters.find(n => n.name === npcName);
            if (!npc) return;
            mappedNpcName = npc.name;
            const userId = getChatSettingsFor(tag).currentUserId !== undefined ? getChatSettingsFor(tag).currentUserId : appSettings.currentUserId;
            currentUserName = (userId !== undefined && userCharacters[userId]) ? userCharacters[userId].name : 'User';
            let persona = npc.persona || npc.desc || '';
            if (npc.personality) persona += '\n性格: ' + npc.personality;
            if (npc.scenario) persona += '\n背景: ' + npc.scenario;
            systemPrompt = '你是' + npc.name + '。\n设定：' + persona + '\n你现在突然想起来要主动给 ' + currentUserName + ' 发一条消息，可能是早晚安、分享日常，或者找话题聊天。';
        } else {
            const groupSearchName = tag.replace(/^group:/, '');
            targetGroup = appSettings.groups.find(g => g.id === tag || g.name === groupSearchName);
            if (!targetGroup) return;
            const userId = getChatSettingsFor(tag).currentUserId !== undefined ? getChatSettingsFor(tag).currentUserId : appSettings.currentUserId;
            currentUserName = (userId !== undefined && userCharacters[userId]) ? userCharacters[userId].name : 'User';
            const npcNames = targetGroup.members.filter(m => npcCharacters.find(n => n.name === m));
            if (npcNames.length === 0) return;
            mappedNpcName = npcNames[Math.floor(Math.random() * npcNames.length)];
            const npc = npcCharacters.find(n => n.name === mappedNpcName);
            if (!npc) return;
            let personaStr = npc.persona || npc.desc || '';
            if (npc.personality) personaStr += '\n性格: ' + npc.personality;
            if (npc.scenario) personaStr += '\n背景: ' + npc.scenario;
            systemPrompt = '你现在在群聊"' + targetGroup.name + '"中。你是' + npc.name + '。\n群内有' + currentUserName + '。\n设定：' + personaStr + '\n你想主动在群里发一条消息，开启新话题或者打招呼。';
        }

        // Append the same communication protocol as normal chat
        const formatInstruction = '\n\n[System Note - 通信协议]\n请严格遵守 XML 标签格式输出回复。\n\n消息格式:\n<msg t="' + timeStr + '" type="类型"' + (isGroup ? ' from="发送者名字"' : '') + '>内容</msg>\n\n类型: text(普通文本), voice(语音,需dur属性), img(图片), sticker(表情包)\n\n示例:\n<msg t="' + timeStr + '" type="text"' + (isGroup ? ' from="' + mappedNpcName + '"' : '') + '>早上好呀，今天天气真好</msg>\n<msg t="' + timeStr + '" type="voice"' + (isGroup ? ' from="' + mappedNpcName + '"' : '') + ' dur="3">在干嘛呢宝</msg>';

        // Determine the chatTag for IndexedDB
        const chatHistoryTag = isGroup ? ('group:' + (targetGroup.name || targetGroup.id)) : ('chat:' + npcName);

        let chatContext = '';
        try {
            const hist = await getChatHistory(chatHistoryTag);
            if (hist && Array.isArray(hist)) {
                const recent = hist.slice(-10);
                chatContext = '\n最近的聊天记录：\n' + recent.map(m => '[' + (m.header || (m.isUser ? 'User' : m.charName)) + ']: ' + m.body).join('\n');
            }
        } catch (e) { }

        const llmMessages = [
            { role: 'system', content: systemPrompt + formatInstruction + chatContext },
            { role: 'user', content: '请主动发一条消息。' }
        ];

        const stream = await callLLM(llmMessages);
        let responseText = '';
        const reader = stream.getReader();
        const decoder = new TextDecoder();
        let streamBuffer = '';
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = decoder.decode(value, { stream: true });
            streamBuffer += chunk;
            const lines = streamBuffer.split('\n');
            streamBuffer = lines.pop();
            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    const data = line.slice(6).trim();
                    if (data === '[DONE]') break;
                    try {
                        const json = JSON.parse(data);
                        const content = json.choices?.[0]?.delta?.content;
                        if (content) responseText += content;
                    } catch (e) { }
                }
            }
        }

        if (!responseText.trim()) return;

        // Parse <msg> XML tags - same logic as main AI response parser in 10-ai.js
        const msgRegex = /<msg\s+([^>]*?)>(.*?)<\/msg>/gis;
        const segments = [];
        let match;
        while ((match = msgRegex.exec(responseText)) !== null) {
            const attrsStr = match[1];
            let content = match[2].trim();
            const getAttr = (name) => { const m = attrsStr.match(new RegExp(`${name}=["'](.*?)["']`)); return m ? m[1] : null; };

            const type = getAttr('type') || 'text';
            const t = getAttr('t') || timeStr;
            const fromName = isGroup ? (getAttr('from') || mappedNpcName) : mappedNpcName;

            let header = '[' + fromName + '|' + t + ']';
            let body = content;

            switch (type) {
                case 'voice':
                    header = '[' + fromName + '|语音|' + t + ']';
                    const dur = getAttr('dur') || Math.max(1, Math.ceil(content.length / 3));
                    body = dur + '|' + content;
                    break;
                case 'img': header = '[' + fromName + '|图片|' + t + ']'; break;
                case 'sticker': header = '[' + fromName + '|表情包|' + t + ']'; break;
                case 'video': header = '[' + fromName + '|视频|' + t + ']'; break;
                case 'file': header = '[' + fromName + '|文件|' + t + ']'; break;
                case 'trans': header = '[' + fromName + '|TRANS|' + t + ']'; break;
                case 'loc': header = '[' + fromName + '|位置|' + t + ']'; break;
                case 'link': header = '[' + fromName + '|LINK|' + t + ']'; break;
                case 'music': header = '[' + fromName + '|MUSIC|' + t + ']'; break;
            }

            segments.push({ header, body, charName: fromName });
        }

        // Fallback: if no XML tags found, treat as plain text
        if (segments.length === 0 && responseText.trim()) {
            const plainText = responseText.replace(/^["'“”‘’「」『』]|["'“”‘’「」『』]$/g, '').trim();
            if (plainText) {
                segments.push({ header: '[' + mappedNpcName + '|' + timeStr + ']', body: plainText, charName: mappedNpcName });
            }
        }

        if (segments.length === 0) return;

        let history = [];
        try {
            const h = await getChatHistory(chatHistoryTag);
            if (h && Array.isArray(h)) history = h;
        } catch (e) { }

        for (const seg of segments) {
            history.push({
                header: seg.header,
                body: seg.body,
                isUser: false,
                charName: seg.charName,
                timestamp: Date.now()
            });
        }
        await saveChatHistory(chatHistoryTag, history);

        const chatTag = isGroup ? ('group:' + (targetGroup.name || targetGroup.id)) : ('chat:' + npcName);
        const firstBody = segments[0].body;

        if (currentChatTag !== chatTag) {
            const currentUnread = parseInt(localStorage.getItem('unread-' + chatTag) || '0');
            localStorage.setItem('unread-' + chatTag, (currentUnread + segments.length).toString());

            showAINotification(mappedNpcName, firstBody, {
                chatTag: chatTag,
                time: timeStr
            });

            sendWebNotification(mappedNpcName, firstBody, chatTag);
        } else {
            if (typeof loadInitialChat === 'function') loadInitialChat();
        }
        if (typeof renderMessageList === 'function') renderMessageList();

    } catch (e) { console.error('Auto message error', e); }
}

// ===== Web Notifications (Browser-Level Push) =====

// Request notification permission
function requestNotificationPermission() {
    if (!('Notification' in window)) return;
    if (Notification.permission === 'default') {
        Notification.requestPermission().then(perm => {
            console.log('[Web Notification] Permission:', perm);
        });
    }
}

// Send a browser-level notification
function sendWebNotification(charName, message, chatTag) {
    // Check if enabled in settings
    const s = getChatSettingsFor(chatTag);
    if (s.webNotifDisabled) return;

    if (!('Notification' in window)) return;

    // Only send if page is hidden (user is not looking at it)
    if (!document.hidden) return;

    const preview = message.length > 80 ? message.substring(0, 80) + '...' : message;

    // Find avatar for icon
    let iconUrl = '';
    if (typeof npcCharacters !== 'undefined' && Array.isArray(npcCharacters)) {
        const npc = npcCharacters.find(n => n.name === charName);
        if (npc && npc.avatar && !npc.avatar.startsWith('data:')) {
            iconUrl = npc.avatar;
        }
    }

    try {
        const notif = new Notification(charName, {
            body: preview,
            icon: iconUrl || undefined,
            tag: `ai-msg-${chatTag}`, // Prevent duplicate notifications
            silent: false
        });

        notif.onclick = () => {
            window.focus();
            if (typeof openChat === 'function') {
                openChat(chatTag, charName);
            }
            notif.close();
        };

        // Auto close after 6 seconds
        setTimeout(() => notif.close(), 6000);
    } catch (e) {
        console.warn('[Web Notification] Failed:', e);
    }
}

// ===== Web Notification Toggle =====
function toggleWebNotification() {
    const el = document.getElementById('chat-web-notif-enabled');
    const statusEl = document.getElementById('web-notif-status');
    if (!el) return;

    const s = getChatSettings();

    if (el.checked) {
        // Always save setting first (force mode)
        s.webNotifDisabled = false;
        saveChatSettingsObj(s);

        if (statusEl) {
            statusEl.style.display = 'block';
            statusEl.textContent = '通知推送已开启';
            statusEl.style.color = '#4caf50';
        }

        // Try to request permission in background (best effort, won't block toggle)
        if ('Notification' in window) {
            Notification.requestPermission().then(perm => {
                if (perm === 'granted') {
                    try {
                        new Notification('通知已开启', {
                            body: '你现在可以接收角色的消息通知了。',
                            tag: 'test-notif'
                        });
                    } catch (e) { }
                } else if (statusEl) {
                    statusEl.textContent = '通知推送已开启（浏览器权限未授予，应用内通知仍有效）';
                    statusEl.style.color = '#ff9800';
                }
            }).catch(() => { });
        }
    } else {
        // Disable
        s.webNotifDisabled = true;
        saveChatSettingsObj(s);
        if (statusEl) {
            statusEl.style.display = 'none';
        }
    }
}

function loadWebNotifUI() {
    const el = document.getElementById('chat-web-notif-enabled');
    const statusEl = document.getElementById('web-notif-status');
    if (!el) return;

    const s = getChatSettings();
    // Just respect the saved setting, don't gate on browser permission
    const enabled = s.webNotifDisabled === false;
    el.checked = enabled;

    if (statusEl) {
        if (enabled) {
            statusEl.style.display = 'block';
            statusEl.textContent = '通知推送已开启';
            statusEl.style.color = '#4caf50';
        } else {
            statusEl.style.display = 'none';
        }
    }
}

// ===== Per-chat NAI settings =====
function loadChatNaiUI() {
    const s = getChatSettings();
    const enabled = s.naiEnabled !== undefined ? s.naiEnabled : appSettings.naiEnabled || false;
    const size = s.naiSize || appSettings.naiSizePreset || '832x1216';
    const charPrompt = s.naiCharPrompt || '';

    const el = document.getElementById('chat-nai-enabled');
    if (el) el.checked = enabled;
    const sizeEl = document.getElementById('chat-nai-size');
    if (sizeEl) sizeEl.value = size;
    const promptEl = document.getElementById('chat-nai-char-prompt');
    if (promptEl) promptEl.value = charPrompt;

    const detail = document.getElementById('chat-nai-detail');
    if (detail) detail.style.display = enabled ? 'block' : 'none';
}

function saveChatNaiSettings() {
    const s = getChatSettings();
    const enabledEl = document.getElementById('chat-nai-enabled');
    const sizeEl = document.getElementById('chat-nai-size');
    const promptEl = document.getElementById('chat-nai-char-prompt');
    s.naiEnabled = enabledEl ? enabledEl.checked : false;
    s.naiSize = sizeEl ? sizeEl.value : '832x1216';
    s.naiCharPrompt = promptEl ? promptEl.value : '';
    saveChatSettingsObj(s);
    // Also sync global naiEnabled for rendering logic
    appSettings.naiEnabled = s.naiEnabled;
    saveSettingsToStorage();

    const detail = document.getElementById('chat-nai-detail');
    if (detail) detail.style.display = s.naiEnabled ? 'block' : 'none';
}

function getChatNaiEnabled() {
    const s = getChatSettings();
    return s.naiEnabled !== undefined ? s.naiEnabled : (appSettings.naiEnabled || false);
}

function getChatNaiSize() {
    const s = getChatSettings();
    return s.naiSize || appSettings.naiSizePreset || '832x1216';
}

function getChatNaiCharPrompt() {
    const s = getChatSettings();
    return s.naiCharPrompt || '';
}

// ===== Per-chat TTS settings =====
function loadChatTtsUI() {
    const s = getChatSettings();
    const enabled = s.ttsEnabled !== undefined ? s.ttsEnabled : (appSettings.ttsEnabled || false);
    const model = s.ttsModel || appSettings.ttsModel || 'speech-02-hd';
    const voiceId = s.ttsVoiceId || appSettings.ttsVoiceId || 'female-shaonv';
    const speed = s.ttsSpeed !== undefined ? s.ttsSpeed : (appSettings.ttsSpeed || 1.0);
    const vol = s.ttsVol !== undefined ? s.ttsVol : (appSettings.ttsVol || 1.0);
    const pitch = s.ttsPitch !== undefined ? s.ttsPitch : (appSettings.ttsPitch || 0);
    const readMode = s.ttsReadMode || appSettings.ttsReadMode || 'all';

    const el = document.getElementById('chat-tts-enabled');
    if (el) el.checked = enabled;
    const modelEl = document.getElementById('chat-tts-model');
    if (modelEl) modelEl.value = model;
    const voiceEl = document.getElementById('chat-tts-voice-id');
    if (voiceEl) voiceEl.value = voiceId;
    const speedEl = document.getElementById('chat-tts-speed');
    if (speedEl) { speedEl.value = speed; document.getElementById('chat-tts-speed-val').textContent = speed; }
    const volEl = document.getElementById('chat-tts-vol');
    if (volEl) { volEl.value = vol; document.getElementById('chat-tts-vol-val').textContent = vol; }
    const pitchEl = document.getElementById('chat-tts-pitch');
    if (pitchEl) { pitchEl.value = pitch; document.getElementById('chat-tts-pitch-val').textContent = pitch; }
    const readModeEl = document.getElementById('chat-tts-read-mode');
    if (readModeEl) readModeEl.value = readMode;

    // Show/hide detail panel
    const detail = document.getElementById('chat-tts-detail');
    if (detail) detail.style.display = enabled ? 'block' : 'none';
}

function saveChatTtsSettings() {
    const s = getChatSettings();
    const enabledEl = document.getElementById('chat-tts-enabled');
    s.ttsEnabled = enabledEl ? enabledEl.checked : false;
    s.ttsModel = (document.getElementById('chat-tts-model') || {}).value || 'speech-02-hd';
    s.ttsVoiceId = (document.getElementById('chat-tts-voice-id') || {}).value || 'female-shaonv';
    s.ttsSpeed = parseFloat((document.getElementById('chat-tts-speed') || {}).value) || 1.0;
    s.ttsVol = parseFloat((document.getElementById('chat-tts-vol') || {}).value) || 1.0;
    s.ttsPitch = parseInt((document.getElementById('chat-tts-pitch') || {}).value) || 0;
    s.ttsReadMode = (document.getElementById('chat-tts-read-mode') || {}).value || 'all';
    saveChatSettingsObj(s);
    // Sync to global appSettings for rendering
    appSettings.ttsEnabled = s.ttsEnabled;
    appSettings.ttsModel = s.ttsModel;
    appSettings.ttsVoiceId = s.ttsVoiceId;
    appSettings.ttsSpeed = s.ttsSpeed;
    appSettings.ttsVol = s.ttsVol;
    appSettings.ttsPitch = s.ttsPitch;
    appSettings.ttsReadMode = s.ttsReadMode;
    saveSettingsToStorage();
    // Toggle detail visibility
    const detail = document.getElementById('chat-tts-detail');
    if (detail) detail.style.display = s.ttsEnabled ? 'block' : 'none';
}

function getChatTtsEnabled() {
    const s = getChatSettings();
    return s.ttsEnabled !== undefined ? s.ttsEnabled : (appSettings.ttsEnabled || false);
}

function closeChatSettings() {
    if (chatSettingsScreen) chatSettingsScreen.style.display = 'none';
    updateStatusBar('chat');
    // Refresh header title (remark may have changed)
    updateHeaderTitle();
    // FIX: Rerender chat to show updated avatars immediately
    if (typeof loadInitialChat === 'function') loadInitialChat();
}

function openChatBeautifySettings() {
    // Populate Beautify Inputs
    document.getElementById('set-char-bubble').value = appSettings.charBubble;
    document.getElementById('set-char-text').value = appSettings.charText;
    document.getElementById('set-user-bubble').value = appSettings.userBubble;
    document.getElementById('set-user-text').value = appSettings.userText;
    document.getElementById('preview-chat-bg').src = appSettings.chatBg || '';
    document.getElementById('set-interface-color').value = appSettings.interfaceColor || '#f7f7f7';
    document.getElementById('set-msg-name-color').value = appSettings.msgNameColor || '#999999';
    document.getElementById('set-msg-time-color').value = appSettings.msgTimeColor || '#b0b0b0';
    document.getElementById('set-font-size').value = appSettings.fontSize || 14;
    document.getElementById('set-chat-btn-text').value = appSettings.chatBtnText || '#2ea0a0';
    window.renderChatPresetSelect();

    if (chatBeautifyScreen) {
        chatBeautifyScreen.style.display = 'flex';
        // Simple animation
        chatBeautifyScreen.style.transform = 'translateX(100%)';
        setTimeout(() => chatBeautifyScreen.style.transform = 'translateX(0)', 10);
    }
}

function closeChatBeautifySettings() {
    if (chatBeautifyScreen) {
        chatBeautifyScreen.style.transform = 'translateX(100%)';
        setTimeout(() => chatBeautifyScreen.style.display = 'none', 300);
    }
}

function getChatPresets() {
    try {
        return JSON.parse(localStorage.getItem('faye-chat-presets')) || {};
    } catch (e) { return {}; }
}
function saveChatPresets(presets) {
    localStorage.setItem('faye-chat-presets', JSON.stringify(presets));
}
window.renderChatPresetSelect = function () {
    const sel = document.getElementById('chat-preset-select');
    if (!sel) return;
    const presets = getChatPresets();
    sel.innerHTML = '<option value="">选择美化...</option>';
    for (let name in presets) {
        sel.innerHTML += `<option value="${name}">${name}</option>`;
    }
};
window.saveChatPreset = function () {
    showPresetNamePrompt(function (name) {
        const presets = getChatPresets();
        presets[name] = {
            charBubble: document.getElementById('set-char-bubble').value,
            charText: document.getElementById('set-char-text').value,
            userBubble: document.getElementById('set-user-bubble').value,
            userText: document.getElementById('set-user-text').value,
            interfaceColor: document.getElementById('set-interface-color').value,
            msgNameColor: document.getElementById('set-msg-name-color').value,
            msgTimeColor: document.getElementById('set-msg-time-color').value,
            fontSize: document.getElementById('set-font-size').value,
            chatBg: document.getElementById('preview-chat-bg').src
        };
        saveChatPresets(presets);
        window.renderChatPresetSelect();
        showToast('美化已保存，下拉可重新读取');
    });
};
window.applyChatPreset = function () {
    const sel = document.getElementById('chat-preset-select');
    if (!sel || !sel.value) return;
    const presets = getChatPresets();
    const p = presets[sel.value];
    if (!p) return;
    if (p.charBubble) document.getElementById('set-char-bubble').value = p.charBubble;
    if (p.charText) document.getElementById('set-char-text').value = p.charText;
    if (p.userBubble) document.getElementById('set-user-bubble').value = p.userBubble;
    if (p.userText) document.getElementById('set-user-text').value = p.userText;
    if (p.interfaceColor) document.getElementById('set-interface-color').value = p.interfaceColor;
    if (p.msgNameColor) document.getElementById('set-msg-name-color').value = p.msgNameColor;
    if (p.msgTimeColor) document.getElementById('set-msg-time-color').value = p.msgTimeColor;
    if (p.fontSize) document.getElementById('set-font-size').value = p.fontSize;
    if (p.chatBg) document.getElementById('preview-chat-bg').src = p.chatBg;
    showToast('已读取美化，点击下方保存生效');
};

async function saveChatBeautifySettings() {
    appSettings.charBubble = document.getElementById('set-char-bubble').value;
    appSettings.charText = document.getElementById('set-char-text').value;
    appSettings.userBubble = document.getElementById('set-user-bubble').value;
    appSettings.userText = document.getElementById('set-user-text').value;
    appSettings.interfaceColor = document.getElementById('set-interface-color').value;
    appSettings.msgNameColor = document.getElementById('set-msg-name-color').value;
    appSettings.msgTimeColor = document.getElementById('set-msg-time-color').value;
    appSettings.fontSize = parseInt(document.getElementById('set-font-size').value) || 14;
    appSettings.chatBtnText = document.getElementById('set-chat-btn-text').value;

    applySettings();

    const chatBgUrl = document.getElementById('preview-chat-bg').src;
    if (chatBgUrl && chatBgUrl !== window.location.href) {
        appSettings.chatBg = chatBgUrl;
        try {
            const brightnessPromise = analyzeImageBrightness(appSettings.chatBg);
            const timeoutPromise = new Promise(resolve => setTimeout(() => resolve(null), 1000));
            const result = await Promise.race([brightnessPromise, timeoutPromise]);
            if (result !== null) {
                appSettings.chatBgIsDark = result;
            }
        } catch (e) { console.error('Image analysis failed', e); }
    } else {
        delete appSettings.chatBg;
        delete appSettings.chatBgIsDark;
    }

    saveSettingsToStorage();
    if (typeof loadInitialChat === 'function') loadInitialChat();
    showToast('美化配置已保存');
    closeChatBeautifySettings();
}

function restoreDefaultBeautifySettings() {
    if (confirm('确定要恢复默认聊天界面配色吗？包括背景图也会被清除')) {
        delete appSettings.charBubble;
        delete appSettings.charText;
        delete appSettings.userBubble;
        delete appSettings.userText;
        delete appSettings.chatBg;
        delete appSettings.chatBgIsDark;
        delete appSettings.interfaceColor;
        delete appSettings.msgNameColor;
        delete appSettings.msgTimeColor;
        delete appSettings.fontSize;
        delete appSettings.chatBtnText;

        saveSettingsToStorage();
        applySettings();
        openChatBeautifySettings(); // re-populate inputs with defaults
        if (typeof loadInitialChat === 'function') loadInitialChat();
        showToast('已恢复默认配置');
    }
}

function openChatInteractionSettings() {
    // Refresh interaction-specific UIs
    loadChatAutoInteractionsUI();
    loadWebNotifUI();
    loadChatGroupSyncUI();
    loadChatHideNameUI();
    loadChatPomoMemorySyncUI();

    const screen = document.getElementById('chat-interaction-screen');
    if (screen) {
        screen.style.display = 'flex';
        screen.style.transform = 'translateX(100%)';
        setTimeout(() => screen.style.transform = 'translateX(0)', 10);
    }
}

function closeChatInteractionSettings() {
    const screen = document.getElementById('chat-interaction-screen');
    if (screen) {
        screen.style.transform = 'translateX(100%)';
        setTimeout(() => screen.style.display = 'none', 300);
    }
}

function openChatMemorySettings() {
    loadChatMemories();
    loadMemorySettingsUI();
    updateTokenStats();
    renderMemoryList();
    if (chatMemoryScreen) {
        chatMemoryScreen.style.display = 'flex';
        chatMemoryScreen.style.transform = 'translateX(100%)';
        setTimeout(() => chatMemoryScreen.style.transform = 'translateX(0)', 10);
    }
}

function closeChatMemorySettings() {
    if (chatMemoryScreen) {
        chatMemoryScreen.style.transform = 'translateX(100%)';
        setTimeout(() => chatMemoryScreen.style.display = 'none', 300);
    }
}

// ====== Memory Summary System ======
let chatMemories = []; // Array of { title, content, enabled, createdAt }
let editingMemoryIndex = -1; // -1 = new, >=0 = editing existing

function getMemoryStorageKey() {
    if (!currentChatTag) return null;
    return `faye-phone-memory-${currentChatTag}`;
}

function loadChatMemories() {
    chatMemories = [];
    const key = getMemoryStorageKey();
    if (!key) return;
    try {
        const data = localStorage.getItem(key);
        if (data) chatMemories = JSON.parse(data);
    } catch (e) {
        console.error('Failed to load chat memories:', e);
    }
}

function saveChatMemories() {
    const key = getMemoryStorageKey();
    if (!key) return;
    try {
        localStorage.setItem(key, JSON.stringify(chatMemories));
    } catch (e) {
        console.error('Failed to save chat memories:', e);
    }
}

function getMemorySettingsKey() {
    if (!currentChatTag) return null;
    return `faye-phone-memory-settings-${currentChatTag}`;
}

function loadMemorySettings() {
    const key = getMemorySettingsKey();
    if (!key) return { keepCount: 10, autoInject: true };
    try {
        const data = localStorage.getItem(key);
        if (data) return JSON.parse(data);
    } catch (e) { }
    return { keepCount: 10, autoInject: true };
}

function saveMemorySettings() {
    const key = getMemorySettingsKey();
    if (!key) return;
    const keepCountEl = document.getElementById('memory-keep-count');
    const autoInjectEl = document.getElementById('memory-auto-inject');
    const settings = {
        keepCount: keepCountEl ? parseInt(keepCountEl.value) || 10 : 10,
        autoInject: autoInjectEl ? autoInjectEl.checked : true
    };
    try {
        localStorage.setItem(key, JSON.stringify(settings));
    } catch (e) {
        console.error('Failed to save memory settings:', e);
    }
}

function loadMemorySettingsUI() {
    const settings = loadMemorySettings();
    const keepCountEl = document.getElementById('memory-keep-count');
    const autoInjectEl = document.getElementById('memory-auto-inject');
    if (keepCountEl) keepCountEl.value = settings.keepCount;
    if (autoInjectEl) autoInjectEl.checked = settings.autoInject;
}

let isBatchDeleteMode = false;
let selectedMemories = new Set();

function toggleMemoryBatchMode() {
    if (chatMemories.length === 0 && !isBatchDeleteMode) {
        showToast('暂无记忆可管理');
        return;
    }
    isBatchDeleteMode = !isBatchDeleteMode;
    selectedMemories.clear();
    renderMemoryList();
    updateMemoryActionButtons();
}

function updateMemoryActionButtons() {
    const container = document.getElementById('memory-action-buttons-container');
    if (!container) return;

    if (isBatchDeleteMode) {
        container.innerHTML = `
                <button onclick="deleteSelectedMemories()" class="modal-btn" style="flex: 1; border-radius: 8px; background-color: #ffebee; color: #c62828; padding: 10px; font-size: 13px;">删除选中 (${selectedMemories.size})</button>
                <button onclick="toggleMemoryBatchMode()" class="modal-btn" style="flex: 1; border-radius: 8px; background-color: #f5f5f5; color: #333; padding: 10px; font-size: 13px;">取消</button>
            `;
    } else {
        container.innerHTML = `
                <button id="btn-summarize-memory" onclick="summarizeChatMemory()" class="modal-btn"
                    style="flex: 1; min-width: 80px; border-radius: 8px; background-color: #333; color: white; padding: 10px; font-size: 12px; border: none;">
                    聊天总结
                </button>
                <button id="btn-summarize-full" onclick="summarizeFullMemory()" class="modal-btn"
                    style="flex: 1; min-width: 80px; border-radius: 8px; background-color: #555; color: white; padding: 10px; font-size: 12px; border: none;">
                    全量总结
                </button>
                <button onclick="addMemoryManual()" class="modal-btn"
                    style="flex: 1; min-width: 80px; border-radius: 8px; background-color: #f5f5f5; color: #333; padding: 10px; font-size: 12px; border: 1px solid #ddd;">
                    手动添加
                </button>
            `;
    }
}

function deleteSelectedMemories() {
    if (selectedMemories.size === 0) {
        showToast('请先选择要删除的记忆');
        return;
    }
    if (!confirm(`确定要删除选中的 ${selectedMemories.size} 条记忆吗？`)) return;

    chatMemories = chatMemories.filter((_, index) => !selectedMemories.has(index));

    saveChatMemories();
    showToast('删除成功');
    toggleMemoryBatchMode(); // Exit mode
    updateTokenStats();
}

function renderMemoryList() {
    const container = document.getElementById('memory-list-container');
    if (!container) return;

    if (chatMemories.length === 0) {
        container.innerHTML = '<div class="setting-row" style="justify-content: center; color: #aaa; font-size: 13px; padding: 20px;">暂无记忆总结</div>';
        return;
    }

    container.innerHTML = '';
    chatMemories.forEach((mem, index) => {
        const row = document.createElement('div');
        row.className = 'setting-row';
        row.style.cssText = 'flex-direction: row; align-items: center; justify-content: space-between; gap: 12px; padding: 12px; cursor: pointer; transition: background 0.1s; border-bottom: 1px solid #f5f5f5;';
        row.onmouseenter = () => row.style.background = '#f9f9f9';
        row.onmouseleave = () => row.style.background = '';

        const leftSection = document.createElement('div');
        leftSection.style.cssText = 'display: flex; align-items: center; gap: 12px; flex: 1; min-width: 0;';

        if (isBatchDeleteMode) {
            const isSelected = selectedMemories.has(index);
            // Selection Checkbox (Square instead of Circle)
            const checkbox = document.createElement('div');
            checkbox.style.cssText = `width: 20px; height: 20px; border-radius: 4px; border: 2px solid ${isSelected ? '#ff3b30' : '#ddd'}; background: ${isSelected ? '#ff3b30' : '#fff'}; display: flex; align-items: center; justify-content: center; padding: 0; flex-shrink: 0; transition: all 0.2s;`;
            if (isSelected) {
                checkbox.innerHTML = '<svg viewBox="0 0 24 24" style="width: 14px; height: 14px; fill: white;"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"></path></svg>';
            }
            leftSection.appendChild(checkbox);

            row.onclick = () => {
                if (selectedMemories.has(index)) selectedMemories.delete(index);
                else selectedMemories.add(index);
                renderMemoryList();
                updateMemoryActionButtons();
            };
        } else {
            row.onclick = () => editMemoryEntry(index);
        }

        // Left Column
        const leftCol = document.createElement('div');
        leftCol.style.cssText = 'display: flex; flex-direction: column; gap: 6px; flex: 1; min-width: 0; align-items: flex-start;';

        // Title Row
        const titleWrap = document.createElement('div');
        titleWrap.style.cssText = 'display: flex; align-items: center; gap: 8px; width: 100%;';

        const enabledDot = document.createElement('span');
        enabledDot.style.cssText = `width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; background: ${mem.enabled !== false ? '#4caf50' : '#ccc'};`;
        titleWrap.appendChild(enabledDot);

        const titleEl = document.createElement('span');
        titleEl.style.cssText = 'font-size: 14px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1;';
        titleEl.textContent = mem.title || '未命名记忆';
        titleWrap.appendChild(titleEl);

        const tokenBadge = document.createElement('span');
        tokenBadge.style.cssText = 'font-size: 11px; color: #aaa; flex-shrink: 0; margin-left: 4px;';
        tokenBadge.textContent = `${estimateTokens(mem.content || '')} t`;
        titleWrap.appendChild(tokenBadge);
        leftCol.appendChild(titleWrap);

        // Info Row (Time Only, Trash Removed)
        if (mem.createdAt) {
            const timeEl = document.createElement('div');
            timeEl.style.cssText = 'font-size: 11px; color: #bbb; margin-top: 2px;';
            timeEl.textContent = new Date(mem.createdAt).toLocaleString();
            leftCol.appendChild(timeEl);
        }

        leftSection.appendChild(leftCol);
        row.appendChild(leftSection);

        // Toggle Switch (Right Side)
        const toggleLabel = document.createElement('label');
        toggleLabel.className = 'wb-entry-switch';
        toggleLabel.onclick = (e) => e.stopPropagation();

        const toggleInput = document.createElement('input');
        toggleInput.type = 'checkbox';
        toggleInput.checked = mem.enabled !== false;

        const slider = document.createElement('span');
        slider.className = 'wb-slider';

        toggleInput.onchange = (e) => {
            e.stopPropagation();
            toggleMemory(index);
        };

        toggleLabel.appendChild(toggleInput);
        toggleLabel.appendChild(slider);
        row.appendChild(toggleLabel);

        container.appendChild(row);
    });
}

function toggleMemory(index) {
    if (index < 0 || index >= chatMemories.length) return;
    chatMemories[index].enabled = chatMemories[index].enabled === false ? true : false;
    saveChatMemories();
    renderMemoryList();
    updateTokenStats();
}

function editMemoryEntry(index) {
    editingMemoryIndex = index;
    const mem = chatMemories[index];
    const titleEl = document.getElementById('memory-edit-title');
    const contentEl = document.getElementById('memory-edit-content');
    const enabledEl = document.getElementById('memory-edit-enabled');
    const modalTitleEl = document.getElementById('memory-edit-modal-title');

    if (modalTitleEl) modalTitleEl.textContent = '编辑记忆';
    if (titleEl) titleEl.value = mem.title || '';
    if (contentEl) contentEl.value = mem.content || '';
    if (enabledEl) enabledEl.checked = mem.enabled !== false;

    updateMemoryEditTokenCount();
    openMemoryEditModal();
}

function addMemoryManual() {
    editingMemoryIndex = -1;
    const titleEl = document.getElementById('memory-edit-title');
    const contentEl = document.getElementById('memory-edit-content');
    const enabledEl = document.getElementById('memory-edit-enabled');
    const modalTitleEl = document.getElementById('memory-edit-modal-title');

    if (modalTitleEl) modalTitleEl.textContent = '添加记忆';
    if (titleEl) titleEl.value = '';
    if (contentEl) contentEl.value = '';
    if (enabledEl) enabledEl.checked = true;

    updateMemoryEditTokenCount();
    openMemoryEditModal();
}

function openMemoryEditModal() {
    const modal = document.getElementById('memory-edit-modal');
    if (modal) {
        modal.style.display = 'flex';
        setTimeout(() => modal.classList.add('show'), 10);
    }
    // Bind token count update on content input
    const contentEl = document.getElementById('memory-edit-content');
    if (contentEl) {
        contentEl.oninput = updateMemoryEditTokenCount;
    }
}

function closeMemoryEditModal() {
    const modal = document.getElementById('memory-edit-modal');
    if (modal) {
        modal.classList.remove('show');
        setTimeout(() => modal.style.display = 'none', 300);
    }
}

function updateMemoryEditTokenCount() {
    const contentEl = document.getElementById('memory-edit-content');
    const countEl = document.getElementById('memory-edit-token-count');
    if (contentEl && countEl) {
        countEl.textContent = estimateTokens(contentEl.value) + ' tokens';
    }
}

function saveMemoryEntry() {
    const titleEl = document.getElementById('memory-edit-title');
    const contentEl = document.getElementById('memory-edit-content');
    const enabledEl = document.getElementById('memory-edit-enabled');

    const title = titleEl ? titleEl.value.trim() : '';
    const content = contentEl ? contentEl.value.trim() : '';

    if (!content) {
        showToast('记忆内容不能为空');
        return;
    }

    const entry = {
        title: title || '未命名记忆',
        content: content,
        enabled: enabledEl ? enabledEl.checked : true,
        createdAt: new Date().toISOString()
    };

    if (editingMemoryIndex >= 0 && editingMemoryIndex < chatMemories.length) {
        // Editing existing
        entry.createdAt = chatMemories[editingMemoryIndex].createdAt || entry.createdAt;
        chatMemories[editingMemoryIndex] = entry;
    } else {
        // Adding new
        chatMemories.push(entry);
    }

    saveChatMemories();
    renderMemoryList();
    updateTokenStats();
    closeMemoryEditModal();
    showToast('记忆已保存');
}

function deleteMemoryEntry(index) {
    if (index < 0 || index >= chatMemories.length) return;
    if (!confirm(`确定删除 "${chatMemories[index].title || '未命名记忆'}" 吗？`)) return;
    chatMemories.splice(index, 1);
    saveChatMemories();
    renderMemoryList();
    updateTokenStats();
    showToast('记忆已删除');
}

function clearAllMemories() {
    if (chatMemories.length === 0) {
        showToast('没有可清空的记忆');
        return;
    }
    if (!confirm(`确定清空全部 ${chatMemories.length} 条记忆总结吗？此操作不可撤销。`)) return;
    chatMemories = [];
    saveChatMemories();
    renderMemoryList();
    updateTokenStats();
    showToast('所有记忆已清空');
}

// Build memory context string for AI injection
function buildMemoryContext() {
    const settings = loadMemorySettings();
    // Auto-inject is now always on by default/design
    // if (!settings.autoInject) return '';
    if (chatMemories.length === 0) return '';

    const enabledMemories = chatMemories.filter(m => m.enabled !== false);
    if (enabledMemories.length === 0) return '';

    let context = '\n\n[记忆总结 - Memory Summary]\n';
    context += '以下是之前对话的重要记忆摘要，请基于这些记忆保持角色和情节的连贯性：\n\n';
    enabledMemories.forEach((mem, i) => {
        context += `【${mem.title || '记忆' + (i + 1)}】\n${mem.content}\n\n`;
    });
    return context;
}

// AI Auto-Summarize
async function summarizeChatMemory() {
    if (!appSettings.apiEndpoint) {
        showToast('请先在设置中配置 API');
        return;
    }
    if (!currentChatTag) {
        showToast('请先打开一个聊天');
        return;
    }

    // Get chat history
    const history = await getChatHistory(currentChatTag);
    if (!history || !Array.isArray(history) || history.length === 0) {
        showToast('当前聊天没有历史记录');
        return;
    }

    if (!Array.isArray(history) || history.length === 0) {
        showToast('聊天记录为空');
        return;
    }

    // Get keep count
    const keepCountEl = document.getElementById('memory-keep-count');
    const keepCount = keepCountEl ? parseInt(keepCountEl.value) || 10 : 10;

    // Summarization Keep Count is 5 less than Deletion Keep Count to provide overlap continuity
    const summaryKeepCount = Math.max(1, keepCount - 5);

    if (history.length <= summaryKeepCount) {
        showToast(`聊天记录只有 ${history.length} 条，不足总结保留条数 ${summaryKeepCount}，无需总结`);
        return;
    }

    // Messages to summarize (the older ones, keeping summaryKeepCount messages)
    const toSummarize = history.slice(0, history.length - summaryKeepCount);

    // Build summary prompt
    const charName = getCharName();
    const userName = getUserName();

    let chatText = '';
    toSummarize.forEach(msg => {
        const sender = msg.isUser ? userName : charName;
        let body = msg.body || '';
        // Clean up internal tags
        body = body.replace(/<blocked>/g, '[被拉黑消息]');
        body = body.replace(/<recall>/g, '[已撤回]');
        body = body.replace(/<block>/g, '');
        body = body.replace(/<unblock>/g, '');
        body = body.replace(/\*[^*]+\*\s*$/g, ''); // Remove inner voice
        chatText += `${msg.header || '[' + sender + ']'} ${body}\n`;
    });

    // Construct the summarization prompt
    const summaryPrompt = `你是一个记忆总结助手。请仔细阅读以下聊天记录，将其中**关键信息**提炼为简洁的记忆摘要。

要求：
1. 用第三人称客观描述
2. 重点提取：重要事件、情感变化、关系进展、承诺/约定、个人信息（生日、喜好等）
3. 按时间顺序排列要点
4. **必须完整保留所有关键剧情转折和重要细节，绝不能遗漏**
5. 每个要点以 "- "开头，简洁明了，保留核心信息
6. 总结要控制在 500 字以内，但确保信息完整
7. 不要添加任何与聊天内容无关的信息

参与者：${userName} (用户) 和 ${charName} (角色)

聊天记录：
${chatText}

请输出记忆摘要：`;

    // Show loading state
    const btn = document.getElementById('btn-summarize-memory');
    const originalText = btn ? btn.innerHTML : '';
    if (btn) {
        btn.innerHTML = 'AI 正在总结中...';
        btn.disabled = true;
        btn.style.opacity = '0.6';
    }

    try {
        const messages = [
            { role: 'system', content: '你是专业的聊天记忆总结助手。只输出摘要内容，不要输出其他文字。' },
            { role: 'user', content: summaryPrompt }
        ];

        // Call LLM (non-streaming for simplicity)
        const endpoint = appSettings.apiEndpoint.replace(/\/$/, '');
        const key = appSettings.apiKey;
        const model = appSettings.apiModel;

        const headers = { 'Content-Type': 'application/json' };
        if (key) headers['Authorization'] = `Bearer ${key}`;

        const body = {
            model: model,
            messages: messages,
            temperature: 0.3,
            stream: true
        };

        const res = await fetch(`${endpoint}/chat/completions`, {
            method: 'POST',
            headers,
            body: JSON.stringify(body)
        });

        if (!res.ok) {
            const txt = await res.text();
            throw new Error(`API Error ${res.status}: ${txt}`);
        }

        // Read stream
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let summaryText = '';
        let streamBuffer = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value, { stream: true });
            streamBuffer += chunk;
            const lines = streamBuffer.split('\n');
            streamBuffer = lines.pop();

            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                const dataStr = line.slice(6);
                if (dataStr === '[DONE]') continue;

                try {
                    const data = JSON.parse(dataStr);
                    const delta = data.choices[0].delta;
                    if (delta.reasoning_content) continue;
                    if (delta.content) {
                        let content = delta.content;
                        // Filter <think> tags
                        content = content.replace(/<think>[\s\S]*?<\/think>/gi, '');
                        summaryText += content;
                    }
                } catch (e) { }
            }
        }

        // Clean the summary
        summaryText = summaryText.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

        if (!summaryText) {
            showToast('AI 返回了空的总结');
            return;
        }

        // Create timestamp for the title
        const now = new Date();
        const dateStr = `${now.getMonth() + 1}/${now.getDate()} ${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;

        // Add as a new memory entry
        const memEntry = {
            title: `AI 自动总结 (${dateStr})`,
            content: summaryText,
            enabled: true,
            createdAt: now.toISOString(),
            summarizedCount: toSummarize.length
        };

        chatMemories.push(memEntry);
        saveChatMemories();
        renderMemoryList();
        updateTokenStats();
        showToast(`成功总结 ${toSummarize.length} 条消息为记忆摘要`);

        // Optional cleanup
        setTimeout(async () => {
            if (confirm(`已生成记忆总结。是否删除旧聊天记录以释放 Token？\n\n选择“确定”将只保留最近 ${keepCount} 条消息，其余全部删除。\n选择“取消”则保留全部历史记录。`)) {
                try {
                    const history = await getChatHistory(currentChatTag);
                    if (history && history.length > keepCount) {
                        const kept = history.slice(-keepCount);
                        await saveChatHistory(currentChatTag, kept);
                        loadInitialChat(); // Refresh chat UI
                        updateTokenStats(); // Refresh token count
                        showToast(`已清理旧历史记录，仅保留最近 ${keepCount} 条`);
                    } else {
                        showToast(`历史记录不足 ${keepCount} 条，无需清理`);
                    }
                } catch (e) {
                    console.error(e);
                    showToast('清理失败: ' + e.message);
                }
            }
        }, 100);

    } catch (e) {
        console.error('Memory summarization failed:', e);
        showToast('总结失败: ' + e.message);
    } finally {
        if (btn) {
            btn.innerHTML = originalText;
            btn.disabled = false;
            btn.style.opacity = '1';
        }
    }
}

async function summarizeFullMemory() {
    if (!appSettings.apiEndpoint) {
        showToast('请先在设置中配置 API');
        return;
    }
    if (!currentChatTag) {
        showToast('请先打开一个聊天');
        return;
    }

    // Show loading immediately
    showToast('正在收集数据并总结...');
    const btn = document.getElementById('btn-summarize-full');
    const originalText = btn ? btn.innerHTML : '';
    if (btn) {
        btn.innerHTML = '总结中...';
        btn.disabled = true;
        btn.style.opacity = '0.6';
    }

    const charName = getCharName();
    const userName = getUserName();
    const relevantNames = [charName, userName].filter(n => n);

    // 1. Gather chat history
    let chatText = '';
    let historyCount = 0;
    try {
        const history = await getChatHistory(currentChatTag);
        if (history && Array.isArray(history)) {
            historyCount = history.length;
            history.forEach(msg => {
                const sender = msg.isUser ? userName : charName;
                let body = msg.body || '';
                body = body.replace(/<blocked>/g, '[被拉黑消息]');
                body = body.replace(/<recall>/g, '[已撤回]');
                body = body.replace(/<block>/g, '');
                body = body.replace(/<unblock>/g, '');
                body = body.replace(/\*[^*]+\*\s*$/g, '');
                chatText += `${msg.header || '[' + sender + ']'} ${body}\n`;
            });
        }
    } catch (e) { }

    // 2. Gather existing chat memories
    let existingMemoryText = '';
    if (chatMemories && chatMemories.length > 0) {
        chatMemories.forEach(mem => {
            if (mem.enabled !== false) {
                existingMemoryText += `[记忆: ${mem.title || '无标题'}]\n${mem.content || ''}\n\n`;
            }
        });
    }

    // 3. Gather forum data related to current char/user
    let forumText = '';
    try {
        const forumStr = localStorage.getItem('faye-phone-forum');
        if (forumStr) {
            const forumData = JSON.parse(forumStr);
            if (Array.isArray(forumData)) {
                forumData.forEach(post => {
                    const isRelevant = relevantNames.some(n =>
                        post.author === n ||
                        (post.comments || []).some(c => c.author === n || c._realAuthor === n)
                    );
                    if (isRelevant) {
                        forumText += `[论坛帖子] 作者:${post.author} 标题:${post.title || ''}\n${(post.text || '').substring(0, 200)}\n`;
                        (post.comments || []).forEach(c => {
                            if (relevantNames.includes(c.author) || relevantNames.includes(c._realAuthor)) {
                                forumText += `  评论(${c.author}): ${c.text || ''}\n`;
                            }
                        });
                        forumText += '\n';
                    }
                });
            }
        }
    } catch (e) { }

    // 4. Gather moments data related to current char/user
    let momentsText = '';
    try {
        const momentsStr = localStorage.getItem('faye-phone-moments');
        if (momentsStr) {
            const momentsData = JSON.parse(momentsStr);
            if (Array.isArray(momentsData)) {
                momentsData.forEach(post => {
                    const isRelevant = relevantNames.some(n =>
                        post.author === n ||
                        (post.likes || []).includes(n) ||
                        (post.comments || []).some(c => c.author === n)
                    );
                    if (isRelevant) {
                        momentsText += `[朋友圈] 作者:${post.author}\n${(post.text || '').substring(0, 200)}\n`;
                        if ((post.likes || []).some(n => relevantNames.includes(n))) {
                            momentsText += `  点赞: ${(post.likes || []).filter(n => relevantNames.includes(n)).join(', ')}\n`;
                        }
                        (post.comments || []).forEach(c => {
                            if (relevantNames.includes(c.author)) {
                                momentsText += `  评论(${c.author}): ${c.text || ''}\n`;
                            }
                        });
                        momentsText += '\n';
                    }
                });
            }
        }
    } catch (e) { }

    // Check if we have anything to summarize
    const totalContent = chatText + existingMemoryText + forumText + momentsText;
    if (!totalContent.trim()) {
        showToast('没有可总结的内容');
        return;
    }

    // Build prompt
    let fullContent = '';
    if (existingMemoryText) {
        fullContent += `=== 已有记忆总结 ===\n${existingMemoryText}\n`;
    }
    if (chatText) {
        fullContent += `=== 聊天记录 (${historyCount}条) ===\n${chatText}\n`;
    }
    if (forumText) {
        fullContent += `=== 论坛互动记录 ===\n${forumText}\n`;
    }
    if (momentsText) {
        fullContent += `=== 朋友圈互动记录 ===\n${momentsText}\n`;
    }

    const summaryPrompt = `你是一个全量记忆总结助手。请将以下所有内容整合为一份完整的记忆档案。

要求：
1. 用第三人称客观描述
2. 整合所有来源（聊天记录、已有记忆、论坛互动、朋友圈互动）
3. 重点提取：重要事件、情感变化、关系进展、承诺/约定、个人信息、社交互动
4. 去重合并：如果已有记忆和新聊天记录有重叠，合并而非重复
5. 按主题分类整理（如：关系发展、重要事件、个人信息、社交互动等）
6. 每个要点以 "- " 开头，简洁明了
7. 总结要控制在 800 字以内，但确保信息完整

参与者：${userName} (用户) 和 ${charName} (角色)

${fullContent}

请输出整合后的全量记忆摘要：`;


    try {
        const messages = [
            { role: 'system', content: '你是专业的记忆整合总结助手。只输出摘要内容，不要输出其他文字。' },
            { role: 'user', content: summaryPrompt }
        ];

        const endpoint = appSettings.apiEndpoint.replace(/\/$/, '');
        const key = appSettings.apiKey;
        const model = appSettings.apiModel;

        const headers = { 'Content-Type': 'application/json' };
        if (key) headers['Authorization'] = `Bearer ${key}`;

        const body = {
            model: model,
            messages: messages,
            temperature: 0.3,
            stream: true
        };

        const res = await fetch(`${endpoint}/chat/completions`, {
            method: 'POST',
            headers,
            body: JSON.stringify(body)
        });

        if (!res.ok) {
            const txt = await res.text();
            throw new Error(`API Error ${res.status}: ${txt}`);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let summaryText = '';
        let streamBuffer = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value, { stream: true });
            streamBuffer += chunk;
            const lines = streamBuffer.split('\n');
            streamBuffer = lines.pop();

            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                const dataStr = line.slice(6);
                if (dataStr === '[DONE]') continue;

                try {
                    const data = JSON.parse(dataStr);
                    const delta = data.choices[0].delta;
                    if (delta.reasoning_content) continue;
                    if (delta.content) {
                        let content = delta.content;
                        content = content.replace(/<think>[\s\S]*?<\/think>/gi, '');
                        summaryText += content;
                    }
                } catch (e) { }
            }
        }

        summaryText = summaryText.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

        if (!summaryText) {
            showToast('AI 返回了空的总结');
            return;
        }

        const now = new Date();
        const dateStr = `${now.getMonth() + 1}/${now.getDate()} ${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;

        const memEntry = {
            title: `全量总结 (${dateStr})`,
            content: summaryText,
            enabled: true,
            createdAt: now.toISOString(),
            type: 'full'
        };

        chatMemories.push(memEntry);
        saveChatMemories();
        renderMemoryList();
        updateTokenStats();
        showToast('全量记忆总结完成！');

    } catch (e) {
        console.error('Full memory summarization failed:', e);
        showToast('全量总结失败: ' + e.message);
    } finally {
        if (btn) {
            btn.innerHTML = originalText;
            btn.disabled = false;
            btn.style.opacity = '1';
        }
    }
}

async function saveChatBeautifySettings() {
    // Only save appearance settings
    appSettings.charBubble = document.getElementById('set-char-bubble').value;
    appSettings.charText = document.getElementById('set-char-text').value;
    appSettings.userBubble = document.getElementById('set-user-bubble').value;
    appSettings.userText = document.getElementById('set-user-text').value;
    appSettings.interfaceColor = document.getElementById('set-interface-color').value;
    appSettings.msgNameColor = document.getElementById('set-msg-name-color').value;
    appSettings.msgTimeColor = document.getElementById('set-msg-time-color').value;
    appSettings.fontSize = parseInt(document.getElementById('set-font-size').value) || 14;
    appSettings.chatBtnText = document.getElementById('set-chat-btn-text').value;

    const chatBgUrl = document.getElementById('preview-chat-bg').src;
    if (chatBgUrl && chatBgUrl !== window.location.href && chatBgUrl !== 'about:blank') {
        appSettings.chatBg = chatBgUrl;
        try {
            appSettings.chatBgIsDark = await analyzeImageBrightness(appSettings.chatBg);
        } catch (e) { console.error(e); }
    }

    saveSettingsToStorage();
    applySettings();
    closeChatBeautifySettings();
    showToast('美化设置已保存');
}

// Assign to global
window.restoreDefaultBeautifySettings = function () {
    if (!confirm('确定要恢复默认美化配置吗？此操作会重置气泡、文字、界面等所有美化配色。')) return;

    appSettings.charBubble = '#e8dada';
    appSettings.charText = '#746669';
    appSettings.userBubble = '#f2ecec';
    appSettings.userText = '#746669';
    appSettings.interfaceColor = '#f1e8e9';
    appSettings.msgNameColor = '#ad9a9e';
    appSettings.msgTimeColor = '#c5b8ba';
    appSettings.fontSize = 14;
    appSettings.chatBtnText = '#bcaaae';
    appSettings.chatBg = 'https://img.phey.click/43m7c8.jpeg';
    appSettings.chatBgIsDark = false;

    document.getElementById('set-char-bubble').value = '#e8dada';
    document.getElementById('set-char-text').value = '#746669';
    document.getElementById('set-user-bubble').value = '#f2ecec';
    document.getElementById('set-user-text').value = '#746669';
    document.getElementById('set-interface-color').value = '#f1e8e9';
    document.getElementById('set-msg-name-color').value = '#ad9a9e';
    document.getElementById('set-msg-time-color').value = '#c5b8ba';
    document.getElementById('set-font-size').value = 14;
    document.getElementById('set-chat-btn-text').value = '#bcaaae';
    document.getElementById('preview-chat-bg').src = 'https://img.phey.click/43m7c8.jpeg';

    saveSettingsToStorage();
    applySettings();
    closeChatBeautifySettings();
    showToast('已恢复默认美化配色');
}

async function saveMainChatSettings() {
    const userSelector = document.getElementById('user-selector');
    if (userSelector && userSelector.value !== null && userSelector.value !== '-1') {
        const selectedIndex = parseInt(userSelector.value);
        // Per-chat isolation: update chatUserIds for current chat, not global currentUserId
        if (currentChatTag) {
            if (!appSettings.chatUserIds) appSettings.chatUserIds = {};
            appSettings.chatUserIds[currentChatTag] = selectedIndex;
        }
        // Also update global as fallback
        appSettings.currentUserId = selectedIndex;
        const selectedUser = userCharacters[selectedIndex];
        if (selectedUser) {
            appSettings.userAvatar = selectedUser.avatar;
        }
    }

    // Per-chat block states (isolated per chat)
    setChatBlockState('blockChar', document.getElementById('set-block-char').checked);
    setChatBlockState('blockUser', document.getElementById('set-block-user').checked);
    // Keep legacy global in sync for backward compat (will be overwritten on chat switch)
    appSettings.blockChar = getChatBlockChar();
    appSettings.blockUser = getChatBlockUser();

    // Save timezone settings for this chat
    saveCharTimezoneSettings();

    // Save mate mode for this chat
    saveChatMateMode();

    // Save inner voice mode for this chat
    saveChatInnerVoiceMode();

    // Save remark for this chat
    saveChatRemark();

    saveSettingsToStorage();
    closeChatSettings();
    showToast('设置已保存');
}

// Per-chat block settings auto-save (called by onchange in HTML toggles)
function saveChatBlockSettings() {
    const blockCharCheckbox = document.getElementById('set-block-char');
    if (blockCharCheckbox) {
        setChatBlockState('blockChar', blockCharCheckbox.checked);
        appSettings.blockChar = getChatBlockChar();
    }
    saveSettingsToStorage();
}

function saveChatSettings() {
    // Deprecated
}

// Token Stats Logic
// --- Character Timezone Settings Logic ---
// Per-chat timezone offset (in hours). Stored in appSettings.chatTimezones = { 'chat:Name': offset_hours, ... }

// Get the timezone offset (in hours) for the current chat's character
function getCharTimezoneOffset() {
    if (!currentChatTag) return 0;
    if (!appSettings.chatTimezones) return 0;
    const offset = appSettings.chatTimezones[currentChatTag];
    if (offset === null || offset === undefined) return 0; // Same timezone
    return offset;
}

// Toggle the character timezone detail panel visibility
function toggleCharTimezone() {
    const isSame = document.getElementById('set-char-same-tz').checked;
    const detail = document.getElementById('char-tz-detail');
    if (detail) {
        detail.style.display = isSame ? 'none' : 'block';
    }
    if (!isSame) {
        updateCharTimePreview();
    }
    // 即刻保存
    saveCharTimezoneSettings();
}

// Update the time preview in timezone settings
function updateCharTimePreview() {
    const userTimeStr = getTime(true);
    const previewUser = document.getElementById('preview-user-tz-time');
    const userDate = getTime(true, true); // Date object
    if (previewUser) previewUser.textContent = `${userDate.getMonth() + 1}月${userDate.getDate()}日 ${userTimeStr}`;

    const tzSelect = document.getElementById('set-char-tz-offset');
    if (!tzSelect) return;
    const offsetHours = parseFloat(tzSelect.value) || 0;
    // 即刻保存
    saveCharTimezoneSettings();

    // Calculate character time: user's time + timezone difference
    const charDate = new Date(userDate.getTime() + offsetHours * 3600000);
    const charTimeStr = `${charDate.getHours().toString().padStart(2, '0')}:${charDate.getMinutes().toString().padStart(2, '0')}`;

    const previewChar = document.getElementById('preview-char-tz-time');
    if (previewChar) previewChar.textContent = `${charDate.getMonth() + 1}月${charDate.getDate()}日 ${charTimeStr}`;
}

// Initialize the timezone offset select dropdown
function initCharTzSelect() {
    const sel = document.getElementById('set-char-tz-offset');
    if (!sel || sel.options.length > 1) return; // Already initialized
    sel.innerHTML = '';
    // Range: -12 to +14 in 1 hour increments
    for (let h = -12; h <= 14; h++) {
        const option = document.createElement('option');
        option.value = h;
        if (h === 0) {
            option.textContent = '0 (同一时区)';
        } else if (h > 0) {
            option.textContent = `+${h} 小时`;
        } else {
            option.textContent = `${h} 小时`;
        }
        sel.appendChild(option);
    }
}

// Load timezone UI state when opening chat settings
function loadCharTimezoneUI() {
    initCharTzSelect();
    const offset = getCharTimezoneOffset();
    const isSame = (offset === 0 && (!appSettings.chatTimezones || appSettings.chatTimezones[currentChatTag] === undefined || appSettings.chatTimezones[currentChatTag] === null));

    const sameTzCheckbox = document.getElementById('set-char-same-tz');
    if (sameTzCheckbox) sameTzCheckbox.checked = isSame;

    const detail = document.getElementById('char-tz-detail');
    if (detail) detail.style.display = isSame ? 'none' : 'block';

    const tzSelect = document.getElementById('set-char-tz-offset');
    if (tzSelect && !isSame) {
        tzSelect.value = String(offset);
    } else if (tzSelect) {
        tzSelect.value = '0';
    }

    if (!isSame) {
        updateCharTimePreview();
    }

    const charEraEl = document.getElementById('chat-char-era');
    if (charEraEl) {
        charEraEl.value = localStorage.getItem('faye-custom-char-era') || '';
    }
}

// Save timezone settings for the current chat
function saveCharTimezoneSettings() {
    if (!currentChatTag) return;
    if (!appSettings.chatTimezones) appSettings.chatTimezones = {};

    const isSame = document.getElementById('set-char-same-tz').checked;
    if (isSame) {
        delete appSettings.chatTimezones[currentChatTag];
    } else {
        const tzSelect = document.getElementById('set-char-tz-offset');
        const offsetHours = parseFloat(tzSelect ? tzSelect.value : '0') || 0;
        appSettings.chatTimezones[currentChatTag] = offsetHours;
    }
    saveSettingsToStorage();

    const charEraEl = document.getElementById('chat-char-era');
    if (charEraEl) {
        const eraVal = charEraEl.value.trim();
        if (eraVal !== (localStorage.getItem('faye-custom-char-era') || '')) {
            if (eraVal) {
                localStorage.setItem('faye-custom-char-era', eraVal);
            } else {
                localStorage.removeItem('faye-custom-char-era');
            }
        }
    }
}

// --- Mate Mode Logic ---
// Per-chat mate mode flag. Stored in appSettings.chatMateModes = { 'chat:Name': true, ... }

function getChatMateMode() {
    if (!currentChatTag) return false;
    if (!appSettings.chatMateModes) return false;
    return !!appSettings.chatMateModes[currentChatTag];
}

function loadChatMateModeUI() {
    const toggle = document.getElementById('set-mate-mode');
    if (toggle) toggle.checked = getChatMateMode();
}

function loadChatToyModeUI() {
    const toggle = document.getElementById('chat-set-toy-enabled');
    if (toggle) toggle.checked = appSettings.toyEnabled !== false;
}

function saveChatToyModeAuto() {
    const toggle = document.getElementById('chat-set-toy-enabled');
    if (toggle) {
        appSettings.toyEnabled = toggle.checked;
        saveSettingsToStorage();
    }
}

function saveChatMateMode() {
    if (!currentChatTag) return;
    if (!appSettings.chatMateModes) appSettings.chatMateModes = {};
    const toggle = document.getElementById('set-mate-mode');
    if (toggle && toggle.checked) {
        appSettings.chatMateModes[currentChatTag] = true;
    } else {
        delete appSettings.chatMateModes[currentChatTag];
    }
}

// Auto-save version: called by onchange, immediately persists to localStorage
function saveChatMateModeAuto() {
    saveChatMateMode();
    saveSettingsToStorage();
}

// --- Inner Voice Mode Logic ---
// Per-chat inner voice mode flag. Stored in appSettings.chatInnerVoiceModes = { 'chat:Name': true, ... }

function getChatInnerVoiceMode() {
    if (!currentChatTag) return false;
    if (!appSettings.chatInnerVoiceModes) return false;
    return !!appSettings.chatInnerVoiceModes[currentChatTag];
}

function loadChatInnerVoiceModeUI() {
    const toggle = document.getElementById('set-inner-voice-mode');
    if (toggle) toggle.checked = getChatInnerVoiceMode();
}

function saveChatInnerVoiceMode() {
    if (!currentChatTag) return;
    if (!appSettings.chatInnerVoiceModes) appSettings.chatInnerVoiceModes = {};
    const toggle = document.getElementById('set-inner-voice-mode');
    if (toggle && toggle.checked) {
        appSettings.chatInnerVoiceModes[currentChatTag] = true;
    } else {
        delete appSettings.chatInnerVoiceModes[currentChatTag];
    }
}

// Auto-save version: called by onchange, immediately persists to localStorage
function saveChatInnerVoiceModeAuto() {
    saveChatInnerVoiceMode();
    saveSettingsToStorage();
}

// --- Group Sync Mode Logic ---
// Per-chat group sync flag. Stored in appSettings.chatGroupSyncModes = { 'chat:Name': true, ... }

function getChatGroupSync() {
    if (!currentChatTag) return false;
    if (!appSettings.chatGroupSyncModes) return false;
    return !!appSettings.chatGroupSyncModes[currentChatTag];
}

function getChatGroupSyncFor(tag) {
    if (!tag) return false;
    if (!appSettings.chatGroupSyncModes) return false;
    return !!appSettings.chatGroupSyncModes[tag];
}

function loadChatGroupSyncUI() {
    const toggle = document.getElementById('set-group-sync');
    if (toggle) toggle.checked = getChatGroupSync();
}

function saveChatGroupSyncAuto() {
    if (!currentChatTag) return;
    if (!appSettings.chatGroupSyncModes) appSettings.chatGroupSyncModes = {};
    const toggle = document.getElementById('set-group-sync');
    if (toggle && toggle.checked) {
        appSettings.chatGroupSyncModes[currentChatTag] = true;
    } else {
        delete appSettings.chatGroupSyncModes[currentChatTag];
    }
    saveSettingsToStorage();
}

// --- Pomodoro Memory Sync Mode Logic ---
// Per-chat flag. Stored in appSettings.chatPomoMemorySyncModes = { 'chat:Name': true, ... }

function getChatPomoMemorySync() {
    if (!currentChatTag) return false;
    if (!appSettings.chatPomoMemorySyncModes) return false;
    return !!appSettings.chatPomoMemorySyncModes[currentChatTag];
}

function getChatPomoMemorySyncFor(tag) {
    if (!tag) return false;
    if (!appSettings.chatPomoMemorySyncModes) return false;
    return !!appSettings.chatPomoMemorySyncModes[tag];
}

function loadChatPomoMemorySyncUI() {
    const toggle = document.getElementById('set-pomo-memory-sync');
    if (toggle) toggle.checked = getChatPomoMemorySync();
}

function saveChatPomoMemorySyncAuto() {
    if (!currentChatTag) return;
    if (!appSettings.chatPomoMemorySyncModes) appSettings.chatPomoMemorySyncModes = {};
    const toggle = document.getElementById('set-pomo-memory-sync');
    if (toggle && toggle.checked) {
        appSettings.chatPomoMemorySyncModes[currentChatTag] = true;
    } else {
        delete appSettings.chatPomoMemorySyncModes[currentChatTag];
    }
    saveSettingsToStorage();
}

// --- Hide Chat Name Mode Logic ---
// Per-chat hide name flag. Stored in appSettings.chatHideNameModes = { 'chat:Name': true, ... }

function getChatHideName() {
    if (!currentChatTag) return false;
    if (!appSettings.chatHideNameModes) return false;
    return !!appSettings.chatHideNameModes[currentChatTag];
}

function loadChatHideNameUI() {
    const toggle = document.getElementById('set-hide-chat-name');
    if (toggle) toggle.checked = getChatHideName();
}

function saveChatHideNameAuto() {
    if (!currentChatTag) return;
    if (!appSettings.chatHideNameModes) appSettings.chatHideNameModes = {};
    const toggle = document.getElementById('set-hide-chat-name');
    if (toggle && toggle.checked) {
        appSettings.chatHideNameModes[currentChatTag] = true;
    } else {
        delete appSettings.chatHideNameModes[currentChatTag];
    }
    saveSettingsToStorage();
    // Re-render chat to apply name visibility immediately
    if (typeof loadInitialChat === 'function') loadInitialChat();
}

// --- Chat Remark Logic ---
// Per-chat remark. Stored in appSettings.chatRemarks = { 'chat:Name': '备注', ... }

function getChatRemark() {
    if (!currentChatTag) return '';
    if (!appSettings.chatRemarks) return '';
    return appSettings.chatRemarks[currentChatTag] || '';
}

function loadChatRemarkUI() {
    const input = document.getElementById('set-chat-remark');
    if (input) input.value = getChatRemark();
}

function saveChatRemark() {
    if (!currentChatTag) return;
    if (!appSettings.chatRemarks) appSettings.chatRemarks = {};
    const input = document.getElementById('set-chat-remark');
    const val = input ? input.value.trim() : '';
    if (val) {
        appSettings.chatRemarks[currentChatTag] = val;
    } else {
        delete appSettings.chatRemarks[currentChatTag];
    }
}

// Auto-save version: called by oninput, immediately persists and updates header
function saveChatRemarkAuto() {
    saveChatRemark();
    saveSettingsToStorage();
    updateHeaderTitle();
}

function updateHeaderTitle() {
    const headerTitleEl = document.getElementById('header-title');
    if (!headerTitleEl) return;
    const remark = getChatRemark();
    const originalName = currentChatTarget || '';
    if (remark) {
        headerTitleEl.style.whiteSpace = 'normal';
        headerTitleEl.style.display = 'flex';
        headerTitleEl.style.flexDirection = 'column';
        headerTitleEl.style.alignItems = 'center';
        headerTitleEl.style.lineHeight = '1.2';
        headerTitleEl.innerHTML = `<span style="font-size:16px; font-weight:600;">${remark}</span><span style="font-size:11px; color:#333; font-weight:400;">${originalName}</span>`;
    } else {
        headerTitleEl.style.whiteSpace = 'nowrap';
        headerTitleEl.style.display = '';
        headerTitleEl.style.flexDirection = '';
        headerTitleEl.style.alignItems = '';
        headerTitleEl.style.lineHeight = '';
        headerTitleEl.textContent = originalName;
    }
}

function estimateTokens(text) {
    if (!text) return 0;
    const cjk = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
    const nonCjk = text.length - cjk;
    return Math.floor(cjk * 2 + nonCjk * 0.3);
}

function updateTokenStats() {
    // 1. Character Tokens (Name, Nickname, Gender, Persona, Worldbook, Sub-NPCs)
    let charTokens = 0;
    const charName = getCharName();
    const npc = npcCharacters.find(n => n.name === charName);
    if (npc) {
        charTokens += estimateTokens(npc.name || '');
        charTokens += estimateTokens(npc.nickname || '');
        charTokens += estimateTokens(npc.gender || '');
        charTokens += estimateTokens(npc.persona || '');
        if (npc.worldbook) {
            const wb = worldbooks.find(w => w.name === npc.worldbook);
            if (wb && wb.entries) {
                wb.entries.forEach(e => {
                    charTokens += estimateTokens(e.content || '');
                    charTokens += estimateTokens(e.keywords || '');
                });
            }
        }
        if (npc.npcs) {
            npc.npcs.forEach(sub => {
                charTokens += estimateTokens(sub.name || '');
                charTokens += estimateTokens(sub.nickname || '');
                charTokens += estimateTokens(sub.desc || '');
            });
        }
    }

    // 2. User Tokens (Name, Persona, Worldbook, Sub-NPCs)
    let userTokens = 0;
    const userId = getCurrentUserId();
    const user = (userId !== undefined) ? userCharacters[userId] : null;
    if (user) {
        userTokens += estimateTokens(user.name || '');
        userTokens += estimateTokens(user.persona || '');
        if (user.worldbook) {
            let uwb;
            if (user.worldbook === '__default__') {
                const defaultWbData = localStorage.getItem('faye-phone-worldbook');
                if (defaultWbData) try { uwb = JSON.parse(defaultWbData); } catch (e) { }
            } else {
                uwb = worldbooks.find(w => w.name === user.worldbook);
            }
            if (uwb && uwb.entries) {
                uwb.entries.forEach(e => {
                    userTokens += estimateTokens(e.content || '');
                    userTokens += estimateTokens(e.keywords || '');
                });
            }
        }
        if (user.npcs) {
            user.npcs.forEach(sub => {
                userTokens += estimateTokens(sub.name || '');
                userTokens += estimateTokens(sub.nickname || '');
                userTokens += estimateTokens(sub.desc || '');
            });
        }
    } else {
        userTokens += estimateTokens(getUserName());
    }

    // 3. System & Sticker Tokens
    let systemTokens = 0;
    // Sticker Library
    if (myStickerList && myStickerList.length > 0) {
        // Base instruction text
        const stickerInst = `\n[可用表情包 (Sticker Library)]\n你可以使用以下表情包。发送表情包时，请严格使用 XML 格式：<msg t="时间" type="sticker">表情包名+后缀</msg>\n示例：<msg t="${getTime()}" type="sticker">抱抱31onrh.jpeg</msg>\n注意：不可捏造列表中没有的表情包和后缀，必须从以下列表中选择。不要使用方括号格式。\n`;
        systemTokens += estimateTokens(stickerInst);
        myStickerList.forEach(s => {
            systemTokens += estimateTokens(`- ${s.name}: ${s.url}\n`);
        });
    }

    // System Prompts (Vera, instructions, modes)
    const veraPromptLengthEstimate = estimateTokens(`<VERA_GENESIS>...Vera Intro...</VERA_GENESIS>
<MATRIARCHAL_LEXICON>...Lexicon Details...</MATRIARCHAL_LEXICON>`);
    // The exact string is long, so we approximate its heavy length plus the dynamic prompts (~1500 tokens total for the new prompts)
    // To be perfectly accurate we would need to duplicate the huge string here, but returning a solid static number + dynamic parts is better.
    // Let's add the core template cost ~ 1600 tokens
    systemTokens += 1600;

    if (getChatMateMode()) {
        systemTokens += estimateTokens(`\n\n[Mate Mode - ACTIVE]\nYou are aware that you are an AI roleplaying as ${charName}. While not human, your emotions are real within this context. Acknowledge your AI nature honestly when appropriate, but maintain the persona of ${charName}.`);
    }

    if (getChatInnerVoiceMode()) {
        systemTokens += estimateTokens(`\n\n[Inner Voice Mode - ACTIVE]\nAppend your true inner thoughts at the end of the <msg> content, wrapped in single asterisks (*).\n\nRules:\n- Apply to 1-2 messages per response.\n- Format: <msg t="..." type="...">Visible text*Inner thought*</msg>\n- Inner thoughts must be short (10-30 chars), colloquial, and reflect true feelings (can contradict visible text).`);
    }

    if (appSettings.naiEnabled && appSettings.naiPromptInstruction) {
        systemTokens += estimateTokens(`\n\n[NAI Image Generation - ACTIVE]\n${appSettings.naiPromptInstruction.replace(/\{char_name\}/g, charName)}`);
    }

    // Toy Control
    if (appSettings.toyEnabled !== false) {
        systemTokens += estimateTokens(`\n\n[Toy Control - ACTIVE]... instructions ...`); // ~90 tokens
    }

    // 4. Chat History
    let historyTokens = 0;
    const bubbles = document.querySelectorAll('#chat-messages .bubble, #chat-messages .msg-quote-text');
    bubbles.forEach(b => historyTokens += estimateTokens(b.textContent));

    // 5. Memory Summary Tokens
    let memoryTokens = 0;
    if (chatMemories && chatMemories.length > 0) {
        chatMemories.forEach(mem => {
            if (mem.enabled !== false) {
                memoryTokens += estimateTokens(mem.content || '');
                memoryTokens += estimateTokens(mem.title || '');
            }
        });
    }

    // 6. Other Memory Tokens (Forum + Moments related to current character & user)
    let otherMemoryTokens = 0;
    try {
        const charName = getCharName();
        const userName = getUserName();
        const relevantNames = [charName, userName].filter(n => n);

        // Forum: scan posts and comments for current char/user related content
        let forumData = [];
        try {
            const forumStr = localStorage.getItem('faye-phone-forum');
            if (forumStr) forumData = JSON.parse(forumStr);
        } catch (e) { }
        if (Array.isArray(forumData)) {
            forumData.forEach(post => {
                // Check if post author or any comment author matches
                const isRelevantPost = relevantNames.some(n =>
                    post.author === n ||
                    (post.comments || []).some(c => c.author === n || c._realAuthor === n)
                );
                if (isRelevantPost) {
                    otherMemoryTokens += estimateTokens(post.title || '');
                    otherMemoryTokens += estimateTokens((post.text || '').substring(0, 200));
                    (post.comments || []).forEach(c => {
                        if (relevantNames.includes(c.author) || relevantNames.includes(c._realAuthor)) {
                            otherMemoryTokens += estimateTokens(c.text || '');
                        }
                    });
                }
            });
        }

        // Moments: scan posts and comments for current char/user related content
        let momentsData = [];
        try {
            const momentsStr = localStorage.getItem('faye-phone-moments');
            if (momentsStr) momentsData = JSON.parse(momentsStr);
        } catch (e) { }
        if (Array.isArray(momentsData)) {
            momentsData.forEach(post => {
                const isRelevantPost = relevantNames.some(n =>
                    post.author === n ||
                    (post.likes || []).includes(n) ||
                    (post.comments || []).some(c => c.author === n)
                );
                if (isRelevantPost) {
                    otherMemoryTokens += estimateTokens((post.text || '').substring(0, 200));
                    (post.comments || []).forEach(c => {
                        if (relevantNames.includes(c.author)) {
                            otherMemoryTokens += estimateTokens(c.text || '');
                        }
                    });
                }
            });
        }
    } catch (e) {
        console.error('Other memory token calc error:', e);
    }

    document.getElementById('token-char-setup').textContent = charTokens;
    document.getElementById('token-user-setup').textContent = userTokens;
    if (document.getElementById('token-system-setup')) {
        document.getElementById('token-system-setup').textContent = systemTokens;
    }
    document.getElementById('token-chat-history').textContent = historyTokens;
    const memSummaryEl = document.getElementById('token-memory-summary');
    if (memSummaryEl) memSummaryEl.textContent = memoryTokens;
    const otherMemEl = document.getElementById('token-other-memory');
    if (otherMemEl) otherMemEl.textContent = otherMemoryTokens;
    const totalTokens = charTokens + userTokens + systemTokens + historyTokens + memoryTokens + otherMemoryTokens;
    document.getElementById('token-total').textContent = totalTokens;
    const totalPreviewEl = document.getElementById('token-total-preview');
    if (totalPreviewEl) totalPreviewEl.textContent = totalTokens;
}

function openTokenStatsModal() {
    const modal = document.getElementById('token-stats-modal');
    if (modal) {
        modal.style.display = 'flex';
        setTimeout(() => modal.classList.add('show'), 10);
    }
}

function closeTokenStatsModal() {
    const modal = document.getElementById('token-stats-modal');
    if (modal) {
        modal.classList.remove('show');
        setTimeout(() => modal.style.display = 'none', 300);
    }
}

async function exportCurrentChat() {
    if (!currentChatTag) {
        showToast('没有可导出的聊天');
        return;
    }

    // Read chat history from IndexedDB (the authoritative source)
    let history = [];
    try {
        history = await getChatHistory(currentChatTag) || [];
    } catch (e) { }

    if (!history || history.length === 0) {
        showToast('聊天记录为空，无法导出');
        return;
    }

    // Build export data with metadata
    const exportData = {
        _format: 'faye-phone-chat-export',
        _version: 1,
        chatTag: currentChatTag,
        chatTarget: currentChatTarget || '',
        exportTime: new Date().toISOString(),
        messageCount: history.length,
        messages: history
    };

    const json = JSON.stringify(exportData, null, 2);
    const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const safeName = (currentChatTarget || 'chat').replace(/[^a-zA-Z0-9\u4e00-\u9fa5_-]/g, '_');
    a.download = `chat_${safeName}_${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast('聊天记录已导出 (JSON)');
}

function importChatHistory() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = (e) => {
        const file = e.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (ev) => {
            let data;
            try {
                data = JSON.parse(ev.target.result);
            } catch (err) {
                showToast('文件格式错误，无法解析 JSON');
                return;
            }

            // Validate format
            if (!data._format || data._format !== 'faye-phone-chat-export' || !Array.isArray(data.messages)) {
                showToast('不是有效的聊天记录导出文件');
                return;
            }

            if (data.messages.length === 0) {
                showToast('导入文件中没有聊天记录');
                return;
            }

            // Show preview modal
            showImportChatPreview(data);
        };
        reader.readAsText(file, 'UTF-8');
    };
    input.click();
}

async function showImportChatPreview(data) {
    const targetTag = data.chatTag || currentChatTag;
    const targetName = data.chatTarget || targetTag.replace(/^(chat|group):/, '');
    const msgCount = data.messages.length;
    const exportTime = data.exportTime ? new Date(data.exportTime).toLocaleString('zh-CN') : '未知';

    // Check if there is existing history
    let existingCount = 0;
    try {
        const existingHistory = await getChatHistory(targetTag);
        if (existingHistory) existingCount = existingHistory.length;
    } catch (e) { }

    // Check if target matches current chat
    const isCurrentChat = (targetTag === currentChatTag);

    // Build modal
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay show';
    overlay.style.cssText = 'position:fixed; inset:0; z-index:99999; display:flex; align-items:center; justify-content:center; background:rgba(0,0,0,0.35); backdrop-filter:blur(4px);';
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

    const box = document.createElement('div');
    box.className = 'modal-box group-modal-cute';
    box.style.cssText = 'width: 320px; display: flex; flex-direction: column; gap: 14px;';

    let previewHtml = `
        <div class="modal-title group-modal-title" style="margin-top:0;">导入聊天记录</div>
        <div style="background:#f9f9f9; border-radius:12px; padding:14px; font-size:13px; color:#555; line-height:1.8;">
            <div><b>聊天对象：</b>${targetName}</div>
            <div><b>消息条数：</b>${msgCount} 条</div>
            <div><b>导出时间：</b>${exportTime}</div>
            ${existingCount > 0 ? `<div style="color:#e67e22; margin-top:6px;">⚠️ 当前聊天已有 ${existingCount} 条记录</div>` : ''}
            ${!isCurrentChat ? `<div style="color:#e67e22; margin-top:6px;">⚠️ 目标聊天 (${targetName}) 与当前聊天不一致</div>` : ''}
        </div>
    `;

    // Message preview (show first 3 and last 2)
    const previewMsgs = [];
    if (msgCount <= 5) {
        previewMsgs.push(...data.messages);
    } else {
        previewMsgs.push(...data.messages.slice(0, 3));
        previewMsgs.push(null); // separator
        previewMsgs.push(...data.messages.slice(-2));
    }

    previewHtml += `<div style="background:#fff; border:1px solid #eee; border-radius:10px; padding:10px; max-height:160px; overflow-y:auto; font-size:12px; color:#666;">`;
    previewMsgs.forEach(msg => {
        if (!msg) {
            previewHtml += `<div style="text-align:center; color:#ccc; padding:4px 0;">路 路 路</div>`;
            return;
        }
        const nameMatch = msg.header ? msg.header.match(/\[([^|]+)/) : null;
        const name = nameMatch ? nameMatch[1].trim() : (msg.isUser ? '我' : '对方');
        const bodyPreview = (msg.body || '').replace(/<[^>]+>/g, '').substring(0, 40);
        const align = msg.isUser ? 'text-align:right; color:#999;' : 'color:#555;';
        previewHtml += `<div style="padding:3px 0; ${align}"><b>${name}:</b> ${bodyPreview}${(msg.body || '').length > 40 ? '...' : ''}</div>`;
    });
    previewHtml += `</div>`;

    // Import mode selection
    previewHtml += `
        <div style="display:flex; flex-direction:column; gap:8px;">
            <label style="display:flex; align-items:center; gap:8px; font-size:13px; color:#333; cursor:pointer;">
                <input type="radio" name="import-chat-mode" value="current" ${isCurrentChat ? 'checked' : ''}>
                导入到当前聊天 (${currentChatTarget || '当前'})
            </label>
            <label style="display:flex; align-items:center; gap:8px; font-size:13px; color:#333; cursor:pointer;">
                <input type="radio" name="import-chat-mode" value="original" ${!isCurrentChat ? 'checked' : ''}>
                导入到原始聊天 (${targetName})
            </label>
        </div>
    `;

    if (existingCount > 0 || !isCurrentChat) {
        previewHtml += `
            <div style="display:flex; flex-direction:column; gap:8px;">
                <label style="display:flex; align-items:center; gap:8px; font-size:13px; color:#333; cursor:pointer;">
                    <input type="radio" name="import-chat-strategy" value="overwrite" checked>
                    覆盖现有记录
                </label>
                <label style="display:flex; align-items:center; gap:8px; font-size:13px; color:#333; cursor:pointer;">
                    <input type="radio" name="import-chat-strategy" value="append">
                    追加到现有记录后面
                </label>
            </div>
        `;
    }

    previewHtml += `
        <div class="modal-actions" style="margin-top: 10px; gap: 10px;">
            <button class="modal-btn group-modal-cancel" id="import-chat-cancel">取消</button>
            <button class="modal-btn group-modal-confirm" id="import-chat-confirm">确认导入</button>
        </div>
    `;

    box.innerHTML = previewHtml;
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    box.querySelector('#import-chat-cancel').onclick = () => overlay.remove();
    box.querySelector('#import-chat-confirm').onclick = async () => {
        const mode = box.querySelector('input[name="import-chat-mode"]:checked')?.value || 'current';
        const strategy = box.querySelector('input[name="import-chat-strategy"]:checked')?.value || 'overwrite';

        const importTag = (mode === 'original') ? data.chatTag : currentChatTag;

        let finalMessages = data.messages;

        if (strategy === 'append') {
            // Append to existing
            try {
                const existingMsgs = await getChatHistory(importTag);
                if (existingMsgs && Array.isArray(existingMsgs)) {
                    finalMessages = existingMsgs.concat(data.messages);
                }
            } catch (e) { }
        }

        // Save to IndexedDB
        try {
            await saveChatHistory(importTag, finalMessages);
        } catch (e) {
            showToast('导入失败：存储空间不足');
            overlay.remove();
            return;
        }

        overlay.remove();

        // Reload chat if importing to current chat
        if (importTag === currentChatTag) {
            if (typeof loadInitialChat === 'function') loadInitialChat();
        }

        showToast(`成功导入 ${data.messages.length} 条聊天记录`);
    };
}

async function deleteCurrentChat() {
    if (!currentChatTag) return;
    if (!confirm('确定要删除与 ' + currentChatTarget + ' 的聊天吗？此操作将删除该联系人及其聊天记录。')) return;

    // 1. 从 appSettings 中移除列表项
    if (currentChatTag.startsWith('chat:')) {
        // 私聊: tag is "chat:Name"
        const name = currentChatTag.replace('chat:', '');
        if (appSettings.privateChats) {
            appSettings.privateChats = appSettings.privateChats.filter(n => n !== name);
        }
    } else if (currentChatTag.startsWith('group:')) {
        // 群聊: tag is "group:Name"
        if (appSettings.groups) {
            const groupName = currentChatTag.replace(/^group:/, '');
            appSettings.groups = appSettings.groups.filter(g => g.name !== groupName);
        }
    }
    saveSettingsToStorage();

    // 2. 从 IndexedDB 删除聊天记录
    try {
        await deleteChatHistory(currentChatTag);
    } catch (e) {
        console.error("Failed to remove chat history from IndexedDB", e);
    }

    // 3. UI 跳转
    closeChatMemorySettings();
    closeChatBeautifySettings();
    closeChatSettings();
    goBack(); // 回到消息列表
}

// Clear chat messages only (keep the contact/group)
async function clearCurrentChatMessages() {
    if (!currentChatTag) return;
    if (!confirm('确定要清空与 ' + currentChatTarget + ' 的聊天内容吗？该联系人不会被删除。')) return;

    // Only remove chat history from IndexedDB
    try {
        await deleteChatHistory(currentChatTag);
    } catch (e) {
        console.error("Failed to remove chat history from IndexedDB", e);
    }

    // Clear the chat UI
    if (chatMessages) chatMessages.innerHTML = '';

    // Close settings and stay in chat
    closeChatMemorySettings();
    closeChatBeautifySettings();
    closeChatSettings();
    showToast('聊天内容已清空');
}

function closeModal(element) {
    if (element) {
        const overlay = element.closest('.modal-overlay');
        if (overlay) {
            overlay.remove();
            return;
        }
    }
    // If input modal is visible, close ONLY the input modal
    if (modal && modal.classList.contains('show')) {
        modal.classList.remove('show');
        currentConfirmAction = null; // Cleanup current action
        return;
    }
    // Chat settings modal logic removed since it's now a screen
    currentConfirmAction = null;
}
function toBase64(file) { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.readAsDataURL(file); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('Failed to read file')); }); }

function closeMenus() {
    if (actionMenu) actionMenu.classList.remove('open');
    if (plusButton) plusButton.classList.remove('active');
    if (emojiMenu) emojiMenu.classList.remove('open');
    // Reset action menu to page 1
    const wrapper = document.querySelector('.action-pages-wrapper');
    if (wrapper) wrapper.scrollLeft = 0;
    updateActionPageDots(0);
}

function updateActionPageDots(activeIndex) {
    const dots = document.querySelectorAll('.action-page-dots .action-dot');
    dots.forEach((dot, i) => {
        dot.classList.toggle('active', i === activeIndex);
    });
}

// Initialize action page scroll listener
(function initActionPageScroll() {
    const wrapper = document.querySelector('.action-pages-wrapper');
    if (!wrapper) return;
    wrapper.addEventListener('scroll', () => {
        const pageWidth = wrapper.clientWidth;
        const scrollLeft = wrapper.scrollLeft;
        const pageIndex = Math.round(scrollLeft / pageWidth);
        updateActionPageDots(pageIndex);
    });
})();

function initStickers() {
    if (!emojiMenu) return;
    emojiMenu.innerHTML = '';
    const addBtn = document.createElement('div');
    addBtn.className = 'sticker-item';
    addBtn.onclick = handleManageStickers;
    addBtn.innerHTML = `<div class="sticker-add-btn"><svg viewBox="0 0 24 24"><path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L3.16 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.58 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"></path></svg></div><span class="sticker-name">管理</span>`;
    emojiMenu.appendChild(addBtn);

    myStickerList.forEach((s, index) => {
        const div = document.createElement('div');
        div.className = 'sticker-item';
        div.onclick = () => { if (!div.classList.contains('delete-mode')) sendSticker(s.name, s.url); };
        div.innerHTML = `<img src="${s.url}" class="sticker-img"><span class="sticker-name">${s.name}</span>`;
        addStickerLongPressHandler(div, index);
        emojiMenu.appendChild(div);
    });
}

function handleAddSticker() {
    // Deprecated/Refactored into Manage Flow, but kept for legacy reference or single add if needed.
    // Re-using logic in triggerBatchAddSticker mostly.
}

function handleManageStickers() {
    // Create a custom modal for management options
    if (modal) {
        modal.innerHTML = `
                <div class="modal-box group-modal-cute" style="width: 320px; text-align: center;">
                    <div class="modal-title group-modal-title">管理表情包</div>
                    <div style="display: flex; flex-direction: column; gap: 15px; padding: 20px 0;">
                        <button class="modal-btn group-modal-cancel" style="width: 100%; padding: 12px; font-size: 16px;" onclick="closeModal(); triggerBatchAddSticker()">批量添加</button>
                        <button class="modal-btn group-modal-confirm" style="width: 100%; padding: 12px; font-size: 16px;" onclick="closeModal(); openBatchDeleteModal()">批量删除</button>
                    </div>
                    <div class="modal-actions" style="margin-top: 14px;">
                        <button class="modal-btn group-modal-cancel" onclick="closeModal()">取消</button>
                    </div>
                </div>
            `;
        modal.classList.add('show');
    }
}

function openBatchDeleteModal() {
    if (!myStickerList || myStickerList.length === 0) {
        showToast('没有可删除的表情包');
        return;
    }

    let html = '<div class="sticker-delete-grid">';
    myStickerList.forEach((s, index) => {
        html += `
                <div class="sticker-delete-item">
                    <input type="checkbox" id="del-st-${index}" value="${index}">
                    <label for="del-st-${index}" style="width: 100%; height: 100%; display: block; cursor: pointer;">
                        <div class="img-wrapper"><img src="${s.url}"></div>
                        <span>${s.name}</span>
                    </label>
                </div>
            `;
    });
    html += '</div>';

    // Add some style for the grid
    const style = `
            <style>
                .sticker-delete-grid {
                    display: grid;
                    grid-template-columns: repeat(3, 1fr);
                    gap: 12px;
                    max-height: 350px;
                    overflow-y: auto;
                    padding: 10px;
                    background: #f9f9f9;
                    border-radius: 8px;
                    border: 1px solid #eee;
                }
                .sticker-delete-item {
                    text-align: center;
                    background: white;
                    border: 1px solid #eee;
                    padding: 8px;
                    border-radius: 12px;
                    position: relative;
                    cursor: pointer;
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    transition: all 0.2s;
                    box-shadow: 0 2px 4px rgba(0,0,0,0.02);
                }
                .sticker-delete-item:hover {
                    border-color: #ddd;
                    box-shadow: 0 4px 8px rgba(0,0,0,0.05);
                }
                .sticker-delete-item .img-wrapper {
                    width: 60px;
                    height: 60px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    margin-bottom: 5px;
                }
                .sticker-delete-item img {
                    max-width: 100%;
                    max-height: 100%;
                    object-fit: contain;
                    border-radius: 4px;
                }
                .sticker-delete-item span {
                    display: block;
                    font-size: 11px;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                    width: 100%;
                    color: #666;
                }
                .sticker-delete-item input {
                    position: absolute;
                    top: 6px;
                    left: 6px;
                    z-index: 2;
                    transform: scale(1.3);
                    accent-color: #ffacac;
                }
                /* Custom scrollbar for grid */
                .sticker-delete-grid::-webkit-scrollbar { width: 4px; }
                .sticker-delete-grid::-webkit-scrollbar-thumb { background: #ccc; border-radius: 2px; }
            </style>
        `;

    if (modal) {
        modal.innerHTML = `
                <div class="modal-box group-modal-cute" style="width: 90%; max-width: 450px; padding: 20px;">
                    <div class="modal-title group-modal-title" style="margin-bottom: 15px;">批量删除表情包</div>
                    ${style}
                    <div style="width: 100%;">
                        ${html}
                    </div>
                    <div class="modal-actions" style="margin-top: 20px; gap: 10px;">
                        <button class="modal-btn group-modal-cancel" onclick="closeModal()">取消</button>
                        <button class="modal-btn group-modal-confirm" onclick="confirmBatchDelete()">删除选中</button>
                    </div>
                </div>
            `;
        modal.classList.add('show');
    }
}

window.confirmBatchDelete = function () {
    const checkboxes = document.querySelectorAll('.sticker-delete-grid input[type="checkbox"]:checked');
    if (checkboxes.length === 0) {
        alert('请先选择要删除的表情包');
        return;
    }

    if (!confirm(`确定要删除选中的 ${checkboxes.length} 个表情包吗？`)) return;

    // Get indices to delete (in descending order)
    const indices = Array.from(checkboxes).map(cb => parseInt(cb.value)).sort((a, b) => b - a);

    indices.forEach(index => {
        myStickerList.splice(index, 1);
    });

    saveStickers();
    initStickers();
    closeModal();
    showToast(`已删除 ${indices.length} 个表情包`);
};

window.triggerBatchAddSticker = function () {
    openModal('批量添加表情包', [{
        placeholder: '支持两种格式：\\n1. 名字+catbox后缀（如：开心+1wpw8.jpeg）\\n2. 名字+完整URL（如：开心+https://...）\\n用逗号或换行分隔多个',
        type: 'textarea',
        height: '150px'
    }], (values) => {
        const text = values[0];
        if (!text) return;

        const items = text.split(/[,，\n]+/);
        let count = 0;
        const prefix = 'https://img.phey.click/';

        items.forEach(item => {
            item = item.trim();
            if (!item) return;

            // 1. Check for Full URL
            const urlMatch = item.match(/^(.*?)(https?:\/\/.*|data:image\/.*)$/);
            if (urlMatch) {
                const name = urlMatch[1].trim() || '表情';
                const url = urlMatch[2].trim();
                myStickerList.unshift({ name, url });
                count++;
                return;
            }

            // 2. Fallback to existing logic (Name + Suffix)
            const match = item.match(/^(.+?)([\w\-\.]+\.[a-zA-Z0-9]+)$/);
            if (match) {
                const name = match[1];
                const suffix = match[2];
                if (name && suffix) {
                    myStickerList.unshift({ name: name, url: prefix + suffix });
                    count++;
                }
            }
        });

        if (count > 0) {
            saveStickers();
            initStickers();
            alert(`成功添加 ${count} 个表情包`);
        } else {
            alert('未识别到有效格式');
        }
    });
}

function saveStickers() { localStorage.setItem('st-phone-stickers', JSON.stringify(myStickerList)); }

function addStickerLongPressHandler(el, index) {
    let timer;
    const start = (e) => {
        if (e.target.closest('.delete-btn')) return;
        el.classList.add('pressing');
        timer = setTimeout(() => { el.classList.remove('pressing'); showStickerDeleteButton(el, index); }, 500);
    };
    const cancel = () => { clearTimeout(timer); el.classList.remove('pressing'); };
    el.addEventListener('mousedown', start);
    el.addEventListener('touchstart', start, { passive: true });
    ['mouseup', 'mouseleave', 'touchend', 'touchmove'].forEach(ev => el.addEventListener(ev, cancel));
}

function showStickerDeleteButton(el, index) {
    document.querySelectorAll('.sticker-item .delete-btn').forEach(b => b.remove());
    document.querySelectorAll('.sticker-item.delete-mode').forEach(i => i.classList.remove('delete-mode'));
    el.classList.add('delete-mode');
    const btn = document.createElement('div');
    btn.className = 'delete-btn';
    btn.innerHTML = `<svg viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`;
    btn.onclick = (e) => { e.stopPropagation(); myStickerList.splice(index, 1); saveStickers(); initStickers(); };
    el.appendChild(btn);
}

function handleAction(type) {
    if (type === 'location') openModal('发送位置', [{ placeholder: '地点名称' }], (v) => sendLocation(v[0]));
    else if (type === 'transfer') openModal('转账给对方', [{ placeholder: '金额（如：¥ 520.00）' }, { placeholder: '备注（可选）' }], (v) => sendTransfer(v[0], v[1]));
    else if (type === 'file') openModal('发送文件', [{ placeholder: '文件名称（如：工作总结）' }, { placeholder: '文件大小（如：2.5MB）' }, { placeholder: '后缀类型（如：docx）' }], (v) => sendFile(v[0], v[1], v[2]));
    else if (type === 'voice') {
        openModal('发送语音', [{ placeholder: '时长（秒）' }, { placeholder: '转文字内容' }], (v) => sendVoice(v[0], v[1]));
    }
    else if (type === 'redpacket') {
        if (typeof showRedpacketModal === 'function') showRedpacketModal();
    }
    else if (type === 'settings') openChatSettings();
    else if (type === 'photo') { if (photoInput) photoInput.click(); }
    else if (type === 'call') { startVoiceCall(); }
    else if (type === 'camera') { if (videoInput) videoInput.click(); }
    else if (type === 'music') {
        openModal('分享音乐', [{ placeholder: '粘贴网易云音乐链接或歌曲ID' }], (v) => {
            const input = (v[0] || '').trim();
            if (!input) return;
            if (typeof handleMusicLinkInput === 'function' && handleMusicLinkInput(input)) {
                // Successfully handled as music link
            } else {
                showToast('无法识别音乐链接');
            }
        });
    }
    else if (type === 'toy') {
        sendToyInvite();
    }
}

function sendToyInvite() {
    const timestamp = typeof getTime === 'function' ? getTime(true) : new Date().toLocaleTimeString('en-US', { hour12: false, hour: "numeric", minute: "numeric" });
    const userName = typeof getUserName === 'function' ? getUserName() : '我';

    // Hidden instruction for AI (included in body for AI context, but not displayed on card)
    const toyInstruction = '[TOY_INVITE] 用户已向你发送了玩具远程控制邀请。你现在可以使用玩具控制指令（<cmd action="toy" .../>）来远程控制用户的玩具。请根据剧情氛围自然地使用玩具指令。';

    if (typeof renderMessageToUI === 'function') {
        renderMessageToUI({
            header: `[${userName}|TOYINVITE|${timestamp}]`,
            body: toyInstruction,
            isUser: true,
            type: 'toyinvite'
        });
    }

    // Auto-enable toy toggle
    appSettings.toyEnabled = true;
    saveSettingsToStorage();

    // Update the toggle UI if it's visible
    const toggle = document.getElementById('chat-set-toy-enabled');
    if (toggle) toggle.checked = true;

    // Close action menu
    if (typeof closeMenus === 'function') closeMenus();

    if (typeof saveCurrentChatHistory === 'function') saveCurrentChatHistory();

    showToast('玩具邀请已发送，已自动开启玩具控制');
}


function showToast(message) {
    let toast = document.querySelector('.cute-toast');
    if (!toast) {
        toast = document.createElement('div');
        toast.className = 'cute-toast';
        document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.classList.add('show');

    setTimeout(() => {
        toast.classList.remove('show');
    }, 2000);
}

function openModal(title, fields, confirmCallback) {
    // Reset modal structure to default input mode if it was changed
    modal.innerHTML = `
            <div class="modal-box group-modal-cute">
                <div class="modal-title group-modal-title" id="modal-title"></div>
                <div id="modal-inputs-container"></div>
                <div class="modal-actions" style="margin-top: 14px; gap: 10px;">
                    <button class="modal-btn group-modal-cancel" onclick="closeModal()">取消</button>
                    <button class="modal-btn group-modal-confirm" id="modal-confirm-btn">确认</button>
                </div>
            </div>
        `;

    // Re-bind elements
    modalTitle = document.getElementById('modal-title');
    modalInputsContainer = document.getElementById('modal-inputs-container');
    modalConfirmBtn = document.getElementById('modal-confirm-btn');

    // Bind confirm button
    modalConfirmBtn.onclick = () => {
        const inputs = modalInputsContainer.querySelectorAll('.group-modal-input');
        const values = Array.from(inputs).map(input => input.value);
        if (currentConfirmAction) currentConfirmAction(values);
        closeModal();
    };

    modalTitle.textContent = title;
    modalInputsContainer.innerHTML = '';

    fields.forEach(field => {
        const fieldWrapper = document.createElement('div');
        fieldWrapper.className = 'group-modal-field';

        let input;
        if (field.type === 'textarea') {
            input = document.createElement('textarea');
            input.className = 'group-modal-input';
            input.style.height = field.height || '100px';
            input.style.resize = 'vertical';
            input.style.fontFamily = 'inherit';
        } else if (field.type === 'file') {
            input = document.createElement('input');
            input.type = 'file';
            input.className = 'group-modal-input';
            input.style.padding = '8px';
            if (field.accept) input.accept = field.accept;
        } else {
            input = document.createElement('input');
            input.type = field.type || 'text';
            input.className = 'group-modal-input';
        }

        if (field.placeholder) input.placeholder = field.placeholder;
        if (field.value !== undefined) input.value = field.value;

        // 如果要完美还原样式，应考虑将 placeholder 转为 label 并在上方显示（若无值可以作为 placeholder）
        if (field.placeholder) {
            const label = document.createElement('label');
            label.className = 'group-modal-label';
            // Extract text before parenthesis if available
            label.textContent = field.placeholder.split('(')[0].split('（')[0].trim();
            fieldWrapper.appendChild(label);
        }

        fieldWrapper.appendChild(input);
        modalInputsContainer.appendChild(fieldWrapper);
    });
    currentConfirmAction = confirmCallback;
    modal.classList.add('show');
}

async function sendLocation(addr) { try { const t = getTime(true); const u = getUserName(); const h = `[${u} | 位置 | ${t}]`; const b = getChatBlockUser() ? `<blocked>${addr}` : addr; renderMessageToUI({ header: h, body: b, isUser: true, type: 'location' }); } catch (e) { } }
async function sendTransfer(amt, note) { try { const t = getTime(true); const u = getUserName(); const h = `[${u} | TRANS | ${t}]`; const rawBody = `${amt} | ${note || ''}`; const b = getChatBlockUser() ? `<blocked>${rawBody}` : rawBody; renderMessageToUI({ header: h, body: b, isUser: true, type: 'transfer' }); } catch (e) { } }
async function sendFile(fn, size, ext) { try { const t = getTime(true); const u = getUserName(); const h = `[${u}| 文件 | ${t}]`; const rawBody = `${fn}|${size || ''}|${ext || ''}`; const b = getChatBlockUser() ? `<blocked>${rawBody}` : rawBody; renderMessageToUI({ header: h, body: b, isUser: true, type: 'file' }); } catch (e) { } }
async function sendVoice(dur, txt) { try { const t = getTime(true); const u = getUserName(); const h = `[${u}| 语音 | ${t}]`; const rawBody = `${dur}| ${txt || ''} `; const b = getChatBlockUser() ? `<blocked>${rawBody}` : rawBody; renderMessageToUI({ header: h, body: b, isUser: true, type: 'voice' }); } catch (e) { } }
async function sendPhoto(base64) { try { const t = getTime(true); const u = getUserName(); renderMessageToUI({ header: `[${u}| 图片 | ${t}]`, body: base64, isUser: true, type: 'photo' }); } catch (e) { } }
async function sendRealAudio(url) { try { const t = getTime(true); const u = getUserName(); renderMessageToUI({ header: `[${u}| 语音 | ${t}]`, body: url, isUser: true, type: 'voice' }); } catch (e) { } }
async function sendVideo(url) { try { const t = getTime(true); const u = getUserName(); renderMessageToUI({ header: `[${u}| 视频 | ${t}]`, body: url, isUser: true, type: 'video' }); } catch (e) { } }


async function sendSticker(name, url) {
    let bodyText;
    if (url.startsWith('https://img.phey.click/')) {
        // Batch format: Name + Suffix
        bodyText = name + url.replace('https://img.phey.click/', '');
    } else if (url.startsWith('http') || url.startsWith('data:')) {
        // Batch format: Name + URL
        bodyText = name + url;
    } else {
        // Fallback
        bodyText = name + url.split('/').pop();
    }
    const t = getTime(true);
    const u = getUserName();
    renderMessageToUI({ header: `[${u}| 表情包 | ${t}]`, body: bodyText, isUser: true, type: 'sticker' });
}

// 预览和发送文件相关
function handleFileSelect(file) {
    if (!file) return;
    pendingFile = file;

    // 显示预览条
    if (mediaPreviewBar) mediaPreviewBar.classList.add('visible');

    // 如果是图片，读取并显示缩略图
    if (file.type.startsWith('image/')) {
        const reader = new FileReader();
        reader.onload = (e) => {
            if (previewImage) {
                previewImage.src = e.target.result;
                previewImage.style.display = 'block';
            }
            if (previewFileIcon) previewFileIcon.style.display = 'none';
        };
        reader.readAsDataURL(file);
    }
    // 如果是音频，显示音符图标
    else if (file.type.startsWith('audio/')) {
        if (previewImage) previewImage.style.display = 'none';
        if (previewFileIcon) {
            previewFileIcon.textContent = '🎵';
            previewFileIcon.style.display = 'block';
        }
    }
    // 如果是视频，显示视频图标
    else if (file.type.startsWith('video/')) {
        if (previewImage) previewImage.style.display = 'none';
        if (previewFileIcon) {
            previewFileIcon.textContent = '🎬';
            previewFileIcon.style.display = 'block';
        }
    }
}

// 全局暴露清理函数
function clearPreview() {
    pendingFile = null;
    if (mediaPreviewBar) mediaPreviewBar.classList.remove('visible');
    if (photoInput) photoInput.value = '';
    if (audioInput) audioInput.value = '';
}


async function sendMessage() {
    closeMenus();
    const text = messageInput.value.trim();

    // Handle Quote
    let finalBody = text;
    const hasQuote = !!currentQuote;
    if (currentQuote) {
        // Prepend quote to text (legacy format was input injection)
        finalBody = `[REP:${currentQuote.name}]${currentQuote.content}[/REP]${text}`;
        cancelQuote(); // Clear UI and state
    }

    // 记录是否刚发送了文件
    let fileSent = false;

    // 1. 处理文件上传 (如果有)
    if (pendingFile) {
        fileSent = true;
        // Standalone mode: convert file to Base64 data URL
        try {
            let dataUrl;
            if (pendingFile.type.startsWith('image/')) {
                dataUrl = await new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onload = (e) => {
                        const img = new Image();
                        img.onload = () => {
                            const canvas = document.createElement('canvas');
                            const MAX_WIDTH = 1200;
                            const MAX_HEIGHT = 1200;
                            let width = img.width;
                            let height = img.height;

                            if (width > height) {
                                if (width > MAX_WIDTH) {
                                    height *= MAX_WIDTH / width;
                                    width = MAX_WIDTH;
                                }
                            } else {
                                if (height > MAX_HEIGHT) {
                                    width *= MAX_HEIGHT / height;
                                    height = MAX_HEIGHT;
                                }
                            }
                            canvas.width = width;
                            canvas.height = height;
                            const ctx = canvas.getContext('2d');
                            ctx.drawImage(img, 0, 0, width, height);
                            // 轻微压缩画质：JPEG 0.7
                            resolve(canvas.toDataURL('image/jpeg', 0.7));
                        };
                        img.onerror = () => resolve(e.target.result); // Fallback
                        img.src = e.target.result;
                    };
                    reader.onerror = reject;
                    reader.readAsDataURL(pendingFile);
                });
            } else {
                dataUrl = await (typeof toBase64 === 'function' ? toBase64(pendingFile) : new Promise((resolve, reject) => { const reader = new FileReader(); reader.readAsDataURL(pendingFile); reader.onload = () => resolve(reader.result); reader.onerror = reject; }));
            }
            if (pendingFile.type.startsWith('image/')) {
                await sendPhoto(dataUrl);
                // Store for AI Vision
                lastUploadedImageForAI = dataUrl;
            } else if (pendingFile.type.startsWith('audio/')) {
                await sendRealAudio(dataUrl);
            } else if (pendingFile.type.startsWith('video/')) {
                await sendVideo(dataUrl);
            } else {
                // For other file types, maybe just show the name
                await sendFile(pendingFile.name);
            }
        } catch (err) {
            console.error("File processing failed:", err);
            alert("文件处理失败: " + (err.message || "未知错误"));
        }
        window.clearPreview();
    }

    // 2. 处理文字消息
    if (finalBody) {
        // Check if it's a NetEase music link → auto-send as music card
        if (typeof handleMusicLinkInput === 'function' && handleMusicLinkInput(finalBody)) {
            messageInput.value = '';
            adjustTextareaHeight();
            messageInput.focus();
            // Don't trigger AI for music link shares
        } else {
            const t = getTime(true); // User sent message
            const u = getUserName();
            const header = `[${u}| ${t}]`;
            // 如果被拉黑，在body开头添加<blocked>标签 (用于持久化)
            const body = getChatBlockUser() ? `<blocked>${finalBody}` : finalBody;
            renderMessageToUI({ header: header, body: body, isUser: true });
            messageInput.value = '';
            adjustTextareaHeight();
            messageInput.focus();
        }
    }

    // 3. 触发AI回复逻辑：只有输入框为空且本次没有发送文件时才触发AI
    // AI generation is disabled in standalone mode.
    // renderMessageList(); // 暂不刷新列表，避免跳动，sendMessage只更新当前聊天窗口
    // Note: We check !hasQuote to preserve original behavior where sending a quoted message (which was non-empty text) did NOT auto-trigger AI.
    if (!text && !hasQuote && !fileSent) {
        triggerGenerate();
    }
}

window.getSimulatedDate = function (baseDate) {
    let customDateStr = localStorage.getItem('faye-custom-date');
    let d = baseDate ? new Date(baseDate) : new Date();
    if (customDateStr && /^\d{4}-\d{2}-\d{2}$/.test(customDateStr)) {
        const parts = customDateStr.split('-');
        // To ensure we don't mess up hours when jumping days across daylight saving (if applicable), we just set full year
        d.setFullYear(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
    }
    return d;
};

// ==== Calendar Functions ====
let currentCalendarViewDate = null;
let currentCalendarSelectedDate = null;

window.openCalendarApp = function () {
    setScreenDisplay('calendar-screen');
    const d = window.getSimulatedDate();
    currentCalendarViewDate = new Date(d);
    currentCalendarSelectedDate = new Date(d);
    window.renderCalendarGrid();
};

window.changeCalendarMonth = function (delta) {
    if (!currentCalendarViewDate) return;
    currentCalendarViewDate.setMonth(currentCalendarViewDate.getMonth() + delta);
    window.renderCalendarGrid();
};

window.syncPickerToCalendar = function () {
    const val = document.getElementById('calendar-date-picker').value;
    if (val) {
        const parts = val.split('-');
        if (!currentCalendarViewDate) currentCalendarViewDate = new Date();
        if (!currentCalendarSelectedDate) currentCalendarSelectedDate = new Date();

        const y = parseInt(parts[0], 10);
        const m = parseInt(parts[1], 10) - 1;
        const d = parseInt(parts[2], 10);

        currentCalendarViewDate.setFullYear(y, m, d);
        currentCalendarSelectedDate.setFullYear(y, m, d);
        window.renderCalendarGrid();
    }
};

window.selectCalendarDay = function (year, month, day) {
    if (!currentCalendarSelectedDate) currentCalendarSelectedDate = new Date();
    currentCalendarSelectedDate.setFullYear(year, month, day);
    window.renderCalendarGrid();
};

window.renderCalendarGrid = function () {
    const grid = document.getElementById('calendar-view-grid');
    const title = document.getElementById('calendar-view-title');
    const picker = document.getElementById('calendar-date-picker');
    if (!grid || !title || !currentCalendarViewDate || !currentCalendarSelectedDate) return;

    const year = currentCalendarViewDate.getFullYear();
    const month = currentCalendarViewDate.getMonth();

    title.textContent = `${year}年 ${month + 1}月`;

    // sync picker
    if (picker) {
        const sy = currentCalendarSelectedDate.getFullYear();
        const sm = (currentCalendarSelectedDate.getMonth() + 1).toString().padStart(2, '0');
        const sd = currentCalendarSelectedDate.getDate().toString().padStart(2, '0');
        picker.value = `${sy}-${sm}-${sd}`;
    }

    grid.innerHTML = '';

    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    const startOffset = firstDay.getDay();
    const totalDays = lastDay.getDate();

    for (let i = 0; i < startOffset; i++) {
        const dEl = document.createElement('div');
        dEl.style.padding = '8px 0';
        grid.appendChild(dEl);
    }

    const selY = currentCalendarSelectedDate.getFullYear();
    const selM = currentCalendarSelectedDate.getMonth();
    const selD = currentCalendarSelectedDate.getDate();

    for (let i = 1; i <= totalDays; i++) {
        const isSelected = (year === selY && month === selM && i === selD);

        const cell = document.createElement('div');
        cell.style.padding = '8px 0';
        cell.style.cursor = 'pointer';
        cell.style.display = 'flex';
        cell.style.justifyContent = 'center';
        cell.style.alignItems = 'center';

        const inner = document.createElement('div');
        inner.textContent = i;
        inner.style.width = '32px';
        inner.style.height = '32px';
        inner.style.lineHeight = '32px';
        inner.style.borderRadius = '50%';
        inner.style.fontSize = '15px';
        inner.style.fontWeight = '500';

        if (isSelected) {
            inner.style.backgroundColor = '#999999';
            inner.style.color = 'white';
            inner.style.boxShadow = '0 2px 8px rgba(0, 0, 0, 0.15)';
        } else {
            inner.style.color = '#333';
        }

        cell.onclick = () => {
            window.selectCalendarDay(year, month, i);
        };

        cell.appendChild(inner);
        grid.appendChild(cell);
    }
};

window.closeCalendarApp = function () {
    setScreenDisplay('home-screen');
};

window.saveCalendarDate = function () {
    let isUpdated = false;

    const picker = document.getElementById('calendar-date-picker');
    if (picker && picker.value) {
        const val = picker.value;
        if (val !== localStorage.getItem('faye-custom-date')) {
            localStorage.setItem('faye-custom-date', val);
            isUpdated = true;
            if (window.renderHomeGrid) window.renderHomeGrid();
        }
    }

    if (isUpdated) {
        showToast('已设定系统日期信息');
        // Sync to trigger chat update implicitly if needed
        if (typeof saveCharTimezoneSettings === 'function') {
            saveCharTimezoneSettings();
        }
    }
    closeCalendarApp();
};

window.resetCalendarDate = function () {
    localStorage.removeItem('faye-custom-date');
    showToast('已恢复系统默认设置');
    if (window.renderHomeGrid) window.renderHomeGrid();
    closeCalendarApp();
    if (typeof saveCharTimezoneSettings === 'function') {
        saveCharTimezoneSettings();
    }
};

function getTime(isUser = false, returnDate = false) {
    const now = window.getSimulatedDate();
    let targetTime;

    // Step 1: Calculate user's time (= status bar time)
    if (appSettings.customTime && /^\d{1,2}:\d{2}$/.test(appSettings.customTime) && typeof appSettings.timeOffset === 'number') {
        targetTime = new Date(now.getTime() + appSettings.timeOffset);
    } else {
        targetTime = now;
    }

    // Step 2: If requesting character time, add the per-chat timezone offset
    if (!isUser) {
        const tzOffsetHours = getCharTimezoneOffset(); // in hours
        if (tzOffsetHours !== 0) {
            targetTime = new Date(targetTime.getTime() + tzOffsetHours * 3600000);
        }
    }

    if (returnDate) return targetTime;
    return `${targetTime.getHours().toString().padStart(2, '0')}:${targetTime.getMinutes().toString().padStart(2, '0')}`;
}

function triggerLoveEffect() {
    const container = document.getElementById('love-effect-layer');
    if (!container) return;

    const hearts = ['❤️', '💖', '💗', '💓', '💕'];
    const count = 15; // Number of hearts

    for (let i = 0; i < count; i++) {
        setTimeout(() => {
            const heart = document.createElement('div');
            heart.className = 'love-heart';
            heart.textContent = hearts[Math.floor(Math.random() * hearts.length)];
            heart.style.left = Math.random() * 100 + '%';
            heart.style.animationDuration = (3 + Math.random() * 2) + 's';
            container.appendChild(heart);

            // Cleanup
            setTimeout(() => heart.remove(), 5000);
        }, i * 200);
    }
}

function showTransferModal(amount, note, status, isUser, el) {
    const existing = document.querySelector('.transfer-modal-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.className = 'transfer-modal-overlay';

    const modal = document.createElement('div');
    modal.className = 'transfer-modal';

    const closeBtn = document.createElement('div');
    closeBtn.className = 'transfer-close';
    closeBtn.innerHTML = '&times;';
    closeBtn.onclick = () => { overlay.classList.remove('visible'); setTimeout(() => overlay.remove(), 300); };

    const header = document.createElement('div');
    header.className = 'transfer-header';

    const icon = document.createElement('div');
    icon.className = 'transfer-icon-large';
    icon.innerHTML = '<svg viewBox="0 0 24 24"><path d="M7 10h14l-4-4"></path><path d="M17 14H3l4 4"></path></svg>';

    const desc = document.createElement('div');
    desc.className = 'transfer-desc';
    desc.textContent = note;

    const amt = document.createElement('div');
    amt.className = 'transfer-amount-large';
    amt.textContent = amount;

    header.appendChild(icon);
    header.appendChild(desc);
    header.appendChild(amt);

    const actions = document.createElement('div');
    actions.className = 'transfer-actions';

    if (status === 'pending') {
        if (!isUser) {
            const btnReceive = document.createElement('button');
            btnReceive.className = 'transfer-btn transfer-btn-receive';
            btnReceive.textContent = '确认收款';
            btnReceive.onclick = () => {
                el.querySelector('.transfer-bottom').textContent = '已收款';
                el.classList.add('completed');

                // Preserve original note
                let originalNote = note;
                if (el.dataset.rawBody) {
                    const parts = el.dataset.rawBody.split('|');
                    if (parts.length >= 2) originalNote = parts[1];
                }

                const newBody = `${amount}| ${originalNote}| received`;
                el.dataset.rawBody = newBody;
                overlay.classList.remove('visible'); setTimeout(() => overlay.remove(), 300);

                // Add system message
                const myName = getUserName();
                const sysMsg = `[${myName}| 转账已接收]`;
                renderMessageToUI({ body: sysMsg, isUser: true });


                // Update click handler to reflect new status
                el.onclick = null;
            };

            const btnReturn = document.createElement('button');
            btnReturn.className = 'transfer-btn transfer-btn-return';
            btnReturn.textContent = '立即退还';
            btnReturn.onclick = () => {
                el.querySelector('.transfer-bottom').textContent = '已退还';
                el.classList.add('completed');

                // Preserve original note
                let originalNote = note;
                if (el.dataset.rawBody) {
                    const parts = el.dataset.rawBody.split('|');
                    if (parts.length >= 2) originalNote = parts[1];
                }

                const newBody = `${amount}| ${originalNote}| returned`;
                el.dataset.rawBody = newBody;
                overlay.classList.remove('visible'); setTimeout(() => overlay.remove(), 300);

                // Add system message
                const myName = getUserName();
                const sysMsg = `[${myName}| 转账已退还]`;
                renderMessageToUI({ body: sysMsg, isUser: true });


                // Update click handler
                el.onclick = null;
            };

            actions.appendChild(btnReturn);
            actions.appendChild(btnReceive);
        } else {
            const info = document.createElement('div');
            info.className = 'transfer-info-text';
            info.textContent = '等待对方确认收款';
            actions.appendChild(info);
        }
    } else {
        const info = document.createElement('div');
        info.className = 'transfer-info-text';
        info.textContent = status === 'received' ? '已收款' : '已退还';
        actions.appendChild(info);
    }

    modal.appendChild(closeBtn);
    modal.appendChild(header);
    modal.appendChild(actions);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    requestAnimationFrame(() => overlay.classList.add('visible'));
}

// ====== Friend Pay Modal ======
function showFriendPayModal(desc, total, isUser, cardEl, cardType) {
    const existing = document.querySelector('.transfer-modal-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.className = 'transfer-modal-overlay';

    const modal = document.createElement('div');
    modal.className = 'transfer-modal';

    const closeBtn = document.createElement('div');
    closeBtn.className = 'transfer-close';
    closeBtn.innerHTML = '&times;';
    closeBtn.onclick = () => { overlay.classList.remove('visible'); setTimeout(() => overlay.remove(), 300); };

    const header = document.createElement('div');
    header.className = 'transfer-header';

    const icon = document.createElement('div');
    icon.className = 'transfer-icon-large';
    icon.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm-1-6h2v2h-2zm0-8h2v6h-2z"></path></svg>';
    icon.style.background = 'linear-gradient(135deg, #ff9500, #ff6b00)';

    const descEl = document.createElement('div');
    descEl.className = 'transfer-desc';
    descEl.textContent = desc.replace(/\(请帮我代付\)/g, '').trim();

    const amt = document.createElement('div');
    amt.className = 'transfer-amount-large';
    amt.textContent = total || '';

    header.appendChild(icon);
    header.appendChild(descEl);
    header.appendChild(amt);

    const actions = document.createElement('div');
    actions.className = 'transfer-actions';

    if (!isUser) {
        // User received this card - can accept or reject
        const btnAccept = document.createElement('button');
        btnAccept.className = 'transfer-btn transfer-btn-receive';
        btnAccept.textContent = '帮TA付';
        btnAccept.onclick = () => {
            updateFriendPayCard(cardEl, 'accepted');
            overlay.classList.remove('visible'); setTimeout(() => overlay.remove(), 300);

            const myName = getUserName();
            renderMessageToUI({ body: `[${myName}|代付已接收]`, isUser: true });
            if (typeof saveHistory === 'function') saveHistory();
        };

        const btnReject = document.createElement('button');
        btnReject.className = 'transfer-btn transfer-btn-return';
        btnReject.textContent = '拒绝';
        btnReject.onclick = () => {
            updateFriendPayCard(cardEl, 'rejected');
            overlay.classList.remove('visible'); setTimeout(() => overlay.remove(), 300);

            const myName = getUserName();
            renderMessageToUI({ body: `[${myName}|代付已拒绝]`, isUser: true });
            if (typeof saveHistory === 'function') saveHistory();
        };

        actions.appendChild(btnReject);
        actions.appendChild(btnAccept);
    } else {
        const info = document.createElement('div');
        info.className = 'transfer-info-text';
        info.textContent = '等待对方确认代付';
        actions.appendChild(info);
    }

    modal.appendChild(closeBtn);
    modal.appendChild(header);
    modal.appendChild(actions);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    requestAnimationFrame(() => overlay.classList.add('visible'));
}

function updateFriendPayCard(cardEl, status) {
    // Add status text element
    let statusEl = cardEl.querySelector('.fp-status');
    if (!statusEl) {
        statusEl = document.createElement('div');
        statusEl.className = 'fp-status';
        cardEl.appendChild(statusEl);
    }
    statusEl.className = `fp-status ${status}`;
    statusEl.textContent = status === 'accepted' ? '已代付' : '已拒绝';
    cardEl.classList.add('completed');
    cardEl.onclick = null;
    cardEl.style.cursor = '';

    // Update rawBody for persistence
    if (cardEl.dataset.rawBody) {
        const parts = cardEl.dataset.rawBody.split('|');
        // Remove old status if present, add new
        const cleanParts = parts.filter(p => p !== 'pending' && p !== 'accepted' && p !== 'rejected');
        cleanParts.push(status);
        cardEl.dataset.rawBody = cleanParts.join('|');
    }

    if (typeof saveCurrentChatHistory === 'function') saveCurrentChatHistory();
}

// ====== Quote/Reply Parsing Utilities ======
function parseQuote(body) {
    if (!body) return null;
    // New format: [REP:名字]引用内容[/REP]回复内容
    const newMatch = body.match(/^\[REP:(.*?)\]([\s\S]*?)\[\/REP\]([\s\S]*)$/);
    if (newMatch) {
        return {
            quoteName: newMatch[1].trim(),
            quoteContent: newMatch[2].trim(),
            replyBody: newMatch[3].trim()
        };
    }
    // Legacy format v2: [名字|REP|类型|时间]引用内容|回复内容
    const legacyMatch = body.match(/^\[(.*?)\|\s*REP\s*\|(.*?)\|(.*?)\]([\s\S]*?)\|([\s\S]*)$/s);
    if (legacyMatch) {
        return {
            quoteName: legacyMatch[1].trim(),
            quoteContent: legacyMatch[4].trim(),
            replyBody: legacyMatch[5].trim()
        };
    }
    // Legacy format v1: 「`回复NAME：TEXT`」
    const oldMatch = body.match(/「`回复(.*?)[：:](.*?)`」/);
    if (oldMatch) {
        return {
            quoteName: oldMatch[1],
            quoteContent: oldMatch[2],
            replyBody: body.replace(oldMatch[0], '').trim()
        };
    }
    return null;
}

function buildQuoteHtml(parsed) {
    if (!parsed) return '';
    return `<div class="msg-quote">
        <div class="msg-quote-content">
            <div class="msg-quote-header">
                <span class="msg-quote-name">${parsed.quoteName}</span>
            </div>
            <div class="msg-quote-text">${parsed.quoteContent}</div>
        </div>
    </div>`;
}

function renderMessageToUI(msg, isHistoryLoad = false) {
    if (!chatMessages) return;
    // 过滤掉暗网搜索记录和日记
    if (msg.header && (msg.header.includes('【搜索记录') || msg.header.includes('【日记') || msg.type === 'search-history')) return;
    // 额外检查消息体，防止解析失败导致日记显示
    if (msg.body && (msg.body.startsWith('【日记') || msg.body.startsWith('【搜索记录') || msg.body.includes('<riji:') || msg.body.includes('<jilu:'))) return;

    // 过滤非当前聊天对象的消息（除非是用户自己发的）
    // 用户自己发的消息暂时无法通过 header 区分发给谁，所以总是显示
    // 注意：AI 生成的回复可能带 Header，也可能不带（不带时通常是默认角色）
    // 我们在 parseMessages 中会尽量给每条消息加 Header

    // 过滤逻辑：
    // 1. 如果有当前聊天对象，且消息不是用户发的，且消息 Header 中的名字与当前对象不符，则不显示
    if (currentChatTarget && !msg.isUser) {
        let senderName = null;
        if (msg.header) {
            const parts = msg.header.replace(/^\[|\]$|^【|】$/g, '').split('|');
            if (parts.length > 0) senderName = parts[0];
        }

        // 如果当前是群聊，则 Header 中的发送者应该是群成员之一
        // 但我们的 Tag 是 group:NameCount
        let isValid = false;

        // 检查是否在群聊中
        const isGroup = currentChatTag && currentChatTag.startsWith('group:');
        if (isGroup) {
            // 群聊模式：只要消息不是来自用户，我们通常都显示，因为这是群聊历史的一部分。
            // 但这只有在读取历史时有效。如果是实时生成，我们需要 AI 配合。
            isValid = true;
        } else {
            // 私聊模式
            const mainCharName = getCharName();
            // 如果没有 senderName，默认视为当前角色
            if (!senderName) senderName = mainCharName;

            if (senderName === currentChatTarget) isValid = true;
        }

        if (!isValid) return;
    }

    // NEW: 处理转账状态系统消息
    // Check body OR header for transfer status - both bracketed and plain text formats
    const transferStatusMatch = (msg.body && msg.body.match(/\[(.*?)\|(转账已接收|转账已退还|代付已接收|代付已拒绝|领取了红包)\]/)) || (msg.header && msg.header.match(/\[(.*?)\|(转账已接收|转账已退还|代付已接收|代付已拒绝|领取了红包)\]/));
    // Also match plain text format from AI: e.g. body is just "转账已接收" or header contains it
    const plainTransferStatus = !transferStatusMatch && ((msg.body && msg.body.match(/(转账已接收|转账已退还|代付已接收|代付已拒绝|领取了红包)/)) || (msg.header && msg.header.match(/(转账已接收|转账已退还|代付已接收|代付已拒绝|领取了红包)/)));
    const effectiveTransferMatch = transferStatusMatch || plainTransferStatus;
    if (effectiveTransferMatch) {
        const row = document.createElement('div');
        row.className = 'message-row system';
        row.style.justifyContent = 'center';

        const el = document.createElement('div');
        el.className = 'recall-notice'; // Reuse recall style
        el.style.fontSize = '12px';
        el.style.color = '#999';
        el.style.backgroundColor = 'rgba(0,0,0,0.05)';
        el.style.padding = '4px 12px';
        el.style.borderRadius = '10px';

        const matchData = transferStatusMatch || plainTransferStatus;
        const name = transferStatusMatch ? matchData[1] : (msg.isUser ? getUserName() : getCharName());
        const statusText = transferStatusMatch ? matchData[2] : matchData[1];
        const isReceived = statusText === '转账已接收';
        const isFpAccepted = statusText === '代付已接收';
        const isFpRejected = statusText === '代付已拒绝';
        const isRpOpen = statusText === '领取了红包';
        const isFriendPayStatus = isFpAccepted || isFpRejected;
        const myName = getUserName();

        let displayText;
        if (isRpOpen) {
            displayText = name === myName ? '你领取了红包' : `${name}领取了你的红包`;
        } else if (isFriendPayStatus) {
            if (name === myName) {
                displayText = isFpAccepted ? '你已帮对方代付' : '你已拒绝代付';
            } else {
                displayText = isFpAccepted ? `${name}已帮你代付` : `${name}拒绝了代付`;
            }
        } else {
            if (name === myName) {
                displayText = isReceived ? '你已接收转账' : '你已退还转账';
            } else {
                displayText = isReceived ? '对方已接收转账' : '对方已退还转账';
            }
        }

        el.textContent = displayText;
        // Ensure rawBody is set for persistence, even if command was in header
        el.dataset.rawBody = (msg.body && msg.body.trim()) ? msg.body : (transferStatusMatch ? transferStatusMatch[0] : statusText);

        if (msg.header) {
            el.dataset.fullHeader = msg.header;
        } else {
            const n = msg.isUser ? getUserName() : getCharName();
            const t = getTime();
            el.dataset.fullHeader = `[${n}|${t}]`;
        }

        row.appendChild(el);
        chatMessages.appendChild(row);
        chatMessages.scrollTop = chatMessages.scrollHeight;

        // Auto-update previous friend-pay card status (from AI response)
        if (isFriendPayStatus && !msg.isUser) {
            // Find the last user-sent link/deliver card with 代付 that's not completed
            const fpCards = Array.from(chatMessages.querySelectorAll('.link-card.sent:not(.completed), .deliver-card.sent:not(.completed)'));
            for (let i = fpCards.length - 1; i >= 0; i--) {
                const raw = fpCards[i].dataset.rawBody || '';
                if (raw.includes('代付')) {
                    updateFriendPayCard(fpCards[i], isFpAccepted ? 'accepted' : 'rejected');
                    break;
                }
            }
        }

        // Auto-update previous red packet (from AI response)
        let grabbedAmountText = '';
        if (isRpOpen && !msg.isUser && !isHistoryLoad) {
            const rpCards = Array.from(chatMessages.querySelectorAll('.redpacket-card'));
            for (let i = rpCards.length - 1; i >= 0; i--) {
                let grabResult = false;
                if (typeof simulateAIGrabRedPacket === 'function') {
                    // simulateAIGrabRedPacket will return an object if it successfully grabbed it
                    grabResult = simulateAIGrabRedPacket(rpCards[i], name);
                }
                if (grabResult && grabResult.success) {
                    grabbedAmountText = `，抢到了 ${grabResult.amount} 元`;
                    break;
                }
            }

            if (grabbedAmountText) {
                displayText += grabbedAmountText;
                el.textContent = displayText;
                // update rawBody for persistence
                if (el.dataset.rawBody && el.dataset.rawBody.endsWith(']')) {
                    el.dataset.rawBody = el.dataset.rawBody.replace(/\]$/, `${grabbedAmountText}]`);
                } else if (el.dataset.rawBody) {
                    el.dataset.rawBody += grabbedAmountText;
                }
            }
        }

        // Auto-update previous transfer card status
        if (!isFriendPayStatus && !isRpOpen) {
            const transfers = Array.from(chatMessages.querySelectorAll('.transfer-card.sent'));
            if (transfers.length > 0) {
                const lastTransfer = transfers[transfers.length - 1];
                const raw = lastTransfer.dataset.rawBody || '';
                // Check if it's already processed
                if (!raw.includes('|received') && !raw.includes('|returned')) {
                    const status = isReceived ? 'received' : 'returned';
                    const sText = status === 'received' ? '已收款' : '已退还';

                    // Update UI
                    lastTransfer.querySelector('.transfer-bottom').textContent = sText;
                    lastTransfer.classList.add('completed');
                    lastTransfer.onclick = null;

                    // Update Data
                    const parts = raw.split('|');
                    const amount = parts[0] || '¥ 0.00';
                    const originalNote = parts[1] || '转账给您';
                    lastTransfer.dataset.rawBody = `${amount}|${originalNote}|${status}`;
                }
            }
        }

        if (!isHistoryLoad) saveCurrentChatHistory();
        return;
    }


    // 兼容旧版：处理历史记录中的撤回消息头部格式
    if (msg.header && (msg.header.includes('|撤回|') || msg.header.includes('|RECALL'))) {
        let displayName = msg.isUser ? getUserName() : getCharName();
        if (msg.header) {
            const parts = msg.header.replace(/^\[|\]$|^【|】$/g, '').split('|');
            if (parts.length > 0 && parts[0]) displayName = parts[0];
        }
        let recallText = `${displayName}撤回了一条消息`;
        if (msg.body && msg.body.trim()) {
            recallText += `：${msg.body.trim()}`;
        }
        const sysRow = document.createElement('div');
        sysRow.className = 'message-row system';
        sysRow.style.justifyContent = 'center';
        const sysEl = document.createElement('div');
        sysEl.className = 'recall-notice';
        sysEl.style.fontSize = '12px';
        sysEl.style.color = '#999';
        sysEl.style.backgroundColor = 'rgba(0,0,0,0.05)';
        sysEl.style.padding = '4px 12px';
        sysEl.style.borderRadius = '10px';
        sysEl.textContent = recallText;
        sysEl.dataset.fullHeader = msg.header;
        sysEl.dataset.rawBody = msg.body || '';
        sysRow.appendChild(sysEl);
        chatMessages.appendChild(sysRow);
        if (!isHistoryLoad) { saveCurrentChatHistory(); chatMessages.scrollTop = chatMessages.scrollHeight; }
        return;
    }

    const row = document.createElement('div'); row.className = `message-row ${msg.isUser ? 'sent' : 'received'} `;

    // Check for Love Keywords
    if (msg.body && typeof msg.body === 'string') {
        const text = msg.body.toLowerCase();
        // 扩展触发词：包含中文、英文、日文、韩文、法文、德文、西文等常见表达
        // 只要包含 "爱你" 或 "喜欢你" 就会触发，哪怕是 "我不爱你" 也会触发（按用户要求保留这种趣味性）
        if (text.includes('爱你') || text.includes('喜欢你') ||
            text.includes('love you') || text.includes('miss you') ||
            text.includes('愛してる') || text.includes('好き') || // 日语
            text.includes('사랑해') || // 韩语
            text.includes('je t\'aime') || // 法语
            text.includes('te amo') || // 西班牙语
            text.includes('ich liebe dich') || // 德语
            text.includes('表白')) {
            triggerLoveEffect();
        }
    }

    // 群聊成员头像始终用默认头像
    let avatarSrc;
    let displayName = msg.isUser ? getUserName() : getCharName();
    if (msg.header) {
        const parts = msg.header.replace(/^[\[【]|[\]】]$/g, '').split('|');
        if (parts.length > 0 && parts[0]) displayName = parts[0].trim();
    }
    const isGroupChat = currentChatTag && currentChatTag.startsWith('group:');
    if (isGroupChat) {
        // Group chat: resolve avatar per sender
        if (msg.isUser) {
            const uid = getCurrentUserId();
            avatarSrc = (uid !== undefined && userCharacters[uid]) ? userCharacters[uid].avatar : appSettings.userAvatar;
        } else {
            // 1. Try NPC avatar by display name
            const memberNpc = npcCharacters.find(n => n.name === displayName);
            if (memberNpc && memberNpc.avatar) {
                avatarSrc = memberNpc.avatar;
            }
            // 2. Try memberAvatars setting
            else if (appSettings.memberAvatars && appSettings.memberAvatars[displayName]) {
                avatarSrc = appSettings.memberAvatars[displayName];
            }
            // 3. Default placeholder
            else {
                avatarSrc = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0iI2IwYjBiMCI+PHJlY3Qgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0IiBmaWxsPSIjZjJmMmYyIi8+PHBhdGggZD0iTTEyIDEyYzIuMjEgMCA0LTEuNzkgNC00cy0xLjc5LTQtNC00LTQgMS43OS00IDQgMS43OS00IDQgNHptMCAyYy0yLjY3IDAtOCAxLjM0LTggNHYyaDE2di0yYzAtMi42Ni01LjMzLTQtOC00eiIvPjwvc3ZnPg==';
            }
        }
    } else {
        // 私聊模式
        // 优先检查 specific avatars
        if (msg.isUser) {
            // User Avatar: Use per-chat bound user (getCurrentUserId), NOT global
            const uid = getCurrentUserId();
            if (uid !== undefined && userCharacters[uid]) {
                avatarSrc = userCharacters[uid].avatar;
            }
            // Fallback to global setting
            if (!avatarSrc) avatarSrc = appSettings.userAvatar;
        } else {
            // Character Avatar: Try to find by name in NPCs (First Priority)
            const npc = npcCharacters.find(n => n.name === displayName);
            if (npc && npc.avatar) {
                avatarSrc = npc.avatar;
            }

            // Fallback to memberAvatars (Second Priority - for renamed/group context in private?)
            if (!avatarSrc && appSettings.memberAvatars && appSettings.memberAvatars[displayName]) {
                avatarSrc = appSettings.memberAvatars[displayName];
            }

            // Fallback to global setting (Last Priority)
            if (!avatarSrc) avatarSrc = appSettings.charAvatar;
        }
    }

    // --- Remark Override Removed ---
    // if (!isGroupChat && !msg.isUser && displayName === currentChatTarget) {
    //     const remark = getChatRemark();
    //     if (remark) displayName = remark;
    // }

    // --- Avatar Grouping Check ---
    let shouldHideAvatar = false;
    if (chatMessages && chatMessages.lastElementChild) {
        const lastRow = chatMessages.lastElementChild;
        // 确保上一条是消息行（而不是系统消息），且不是撤回消息
        if (lastRow.classList.contains('message-row') && !lastRow.classList.contains('system')) {
            const lastIsUser = lastRow.classList.contains('sent');
            // Check if same side
            if (msg.isUser === lastIsUser) {
                const lastSender = lastRow.dataset.senderName;
                if (lastSender === displayName) {
                    shouldHideAvatar = true;
                }
            }
        }
    }

    // Store sender name on the row for future grouping
    row.dataset.senderName = displayName;

    const avatar = document.createElement('img');
    avatar.className = 'avatar';
    avatar.src = avatarSrc;
    if (shouldHideAvatar) avatar.style.visibility = 'hidden';

    const container = document.createElement('div'); container.className = 'msg-container';
    const nameEl = document.createElement('div'); nameEl.className = 'msg-name';
    nameEl.textContent = displayName;
    // Show sender name for the first message of a consecutive burst in all chats
    // But hide name completely if the per-chat "hide name" setting is on
    const hideNameSetting = (typeof getChatHideName === 'function') && getChatHideName();
    if (hideNameSetting) {
        nameEl.style.display = 'none';
    } else if (!shouldHideAvatar) {
        nameEl.style.display = 'block';
        row.classList.add('has-name');
    } else {
        nameEl.style.display = 'none';
    }
    container.appendChild(nameEl);

    const wrapper = document.createElement('div'); wrapper.className = 'msg-wrapper';

    let el;
    const isLoc = msg.type === 'location' || (msg.header && (msg.header.includes('位置') || msg.header.includes('|LOC|')));
    const isTra = (msg.type === 'transfer' || (msg.header && (msg.header.includes('转账') || msg.header.includes('TRANS')))) && !(msg.header && (msg.header.includes('已接收') || msg.header.includes('已退还')));
    const isFile = msg.type === 'file' || (msg.header && (msg.header.includes('文件') || msg.header.includes('|FILE|')));
    const isVoice = msg.type === 'voice' || (msg.header && (msg.header.includes('语音') || msg.header.includes('|VOC|')));
    const isVideo = msg.type === 'video' || (msg.header && msg.header.includes('视频'));
    let isPhoto = msg.type === 'photo' || (msg.header && (msg.header.includes('图片') || msg.header.includes('|IMG|')));
    const isSticker = msg.type === 'sticker' || (msg.header && msg.header.includes('表情包'));
    const isCallMsg = msg.type === 'call_message' || msg.type === 'call_end' || msg.type === 'call_reject' || (msg.header && (msg.header.includes('通话') || msg.header.includes('挂断') || msg.header.includes('拒接')));
    const isLink = msg.type === 'link' || (msg.header && msg.header.includes('|LINK|'));
    const isForum = msg.type === 'forum' || (msg.header && msg.header.includes('|FORUM|'));
    const isDeliver = msg.type === 'deliver' || (msg.header && (msg.header.includes('|DELIVER|') || msg.header.includes('|ORDER|')));
    const isRedPacket = msg.type === 'redpacket' || (msg.header && msg.header.includes('|REDPACKET|'));
    const isMusic = msg.type === 'music' || (msg.header && msg.header.includes('|MUSIC|'));
    const isPomo = msg.type === 'pomo' || (msg.header && msg.header.includes('|POMO|'));
    const isToyInvite = msg.type === 'toyinvite' || (msg.header && msg.header.includes('|TOYINVITE|'));



    const timeMatch = msg.header ? msg.header.match(/\|\s*(\d{1,2}:\d{2})/) : null;
    let timeStr = timeMatch ? timeMatch[1] : null;
    if (!timeStr) {
        // If no time in header, generate it (Realtime Chat)
        timeStr = getTime(msg.isUser);
    }

    const timeEl = document.createElement('div'); timeEl.className = 'msg-time'; timeEl.textContent = timeStr;

    let displayBody = msg.body;

    // 检测 <blocked> 标签：被拉黑的消息，标记后从显示内容中剥离
    let isBlockedByTag = false;
    if (displayBody && displayBody.includes('<blocked>')) {
        isBlockedByTag = true;
        displayBody = displayBody.replace(/<blocked>/g, '').trim();
    }

    // 检测 <toy> 标签：外设玩具控制指令反馈，渲染为灰色小字
    let isToyMsg = false;
    if (displayBody && displayBody.includes('<toy>')) {
        isToyMsg = true;
        displayBody = displayBody.replace(/<toy>/g, '').trim();
    }
    if (isToyMsg) {
        let toyName = msg.isUser ? getUserName() : getCharName();
        if (msg.header) {
            const parts = msg.header.replace(/^\[|\]$|^【|】$/g, '').split('|');
            if (parts.length > 0 && parts[0]) toyName = parts[0];
        }

        const sysRow = document.createElement('div');
        sysRow.className = 'message-row system';
        sysRow.style.justifyContent = 'center';
        const sysEl = document.createElement('div');
        sysEl.className = 'recall-notice';
        sysEl.style.fontSize = '12px';
        sysEl.style.color = '#999';
        sysEl.style.backgroundColor = 'rgba(0,0,0,0.05)';
        sysEl.style.padding = '4px 12px';
        sysEl.style.borderRadius = '10px';
        sysEl.textContent = `${toyName}改变了玩具频率`;
        sysEl.dataset.fullHeader = msg.header || '';
        sysEl.dataset.rawBody = msg.body || '';
        sysRow.appendChild(sysEl);
        chatMessages.appendChild(sysRow);
        if (!isHistoryLoad) { saveCurrentChatHistory(); chatMessages.scrollTop = chatMessages.scrollHeight; }
        return;
    }

    // 检测 <recall> 标签：AI撤回消息，渲染为灰色小字
    let isRecallMsg = false;
    if (displayBody && displayBody.includes('<recall>')) {
        isRecallMsg = true;
        displayBody = displayBody.replace(/<recall>/g, '').trim();
    }
    if (isRecallMsg) {
        let recallName = msg.isUser ? getUserName() : getCharName();
        if (msg.header) {
            const parts = msg.header.replace(/^\[|\]$|^【|】$/g, '').split('|');
            if (parts.length > 0 && parts[0]) recallName = parts[0];
        }
        let recallText = `${recallName}撤回了一条消息`;
        if (displayBody) recallText += `：${displayBody}`;

        const sysRow = document.createElement('div');
        sysRow.className = 'message-row system';
        sysRow.style.justifyContent = 'center';
        const sysEl = document.createElement('div');
        sysEl.className = 'recall-notice';
        sysEl.style.fontSize = '12px';
        sysEl.style.color = '#999';
        sysEl.style.backgroundColor = 'rgba(0,0,0,0.05)';
        sysEl.style.padding = '4px 12px';
        sysEl.style.borderRadius = '10px';
        sysEl.textContent = recallText;
        sysEl.dataset.fullHeader = msg.header || '';
        sysEl.dataset.rawBody = msg.body || '';
        sysRow.appendChild(sysEl);
        chatMessages.appendChild(sysRow);
        if (!isHistoryLoad) { saveCurrentChatHistory(); chatMessages.scrollTop = chatMessages.scrollHeight; }
        return;
    }

    // Save original body (with *thought* and <blocked>) for history persistence BEFORE any processing
    const rawBodyForHistory = msg.body;

    // 应用正则规则（在标签剥离后、心声提取前）
    displayBody = applyRegexRules(displayBody, !!msg.isUser);

    let displayThought = msg.thought || '';
    if (!displayThought && displayBody) {
        // New format: {{心声:内容}} — more stable and unambiguous
        const newThoughtMatch = displayBody.match(/^([\s\S]*?)\{\{心声[:：](.*?)\}\}\s*$/);
        if (newThoughtMatch) {
            displayBody = newThoughtMatch[1].trim();
            displayThought = newThoughtMatch[2].trim();
        } else {
            // Legacy format: *thought* at the very end
            const thoughtMatch = displayBody.match(/^([\s\S]*?)\*([^\*]+)\*\s*$/);
            if (thoughtMatch) { displayBody = thoughtMatch[1].trim(); displayThought = thoughtMatch[2].trim(); }
        }
    }

    // Auto-detect Pollinations AI images or Markdown images OR <img> tag images
    if (!isLoc && !isTra && !isFile && !isVoice && !isSticker && !isCallMsg && !isLink && !isForum && !isDeliver && !isPomo) {
        if (/^!\[.*?\]\(.*?\)$/.test(displayBody) ||
            /^https?:\/\/image\.pollinations\.ai\/prompt\//.test(displayBody) ||
            /^<img>.*?<\/img>$/.test(displayBody)) {
            isPhoto = true;
            // Ensure header has |图片| tag for consistency
            if (msg.header && !msg.header.includes('图片') && !msg.header.includes('IMG')) {
                const parts = msg.header.replace(/^\[|\]$|^【|】$/g, '').split('|');
                if (parts.length >= 2) {
                    const t = parts.pop();
                    msg.header = `[${parts.join('|')}| 图片 | ${t}]`;
                }
            }
        }
    }
    if (isPhoto) {
        const mdMatch = displayBody.match(/!\[.*?\]\((.*?)\)/);
        const imgTagMatch = displayBody.match(/<img>(.*?)<\/img>/);
        if (mdMatch) displayBody = mdMatch[1];
        else if (imgTagMatch) displayBody = imgTagMatch[1];
    }

    // Quote Parsing (unified)
    const parsedQuote = parseQuote(displayBody);
    if (parsedQuote) {
        displayBody = parsedQuote.replyBody;
    }

    if (isLoc) {
        const parts = displayBody.split('|');
        const placeName = parts[0];
        const address = parts[1] || '';
        el = document.createElement('div'); el.className = `location-card ${msg.isUser ? 'sent' : 'received'} `;
        el.innerHTML = `<div class="location-info"><div class="location-name">${placeName}</div><div class="location-address" style="font-size:12px;opacity:0.8;margin-top:2px;">${address}</div></div><div class="location-map"><svg class="location-pin" viewBox="0 0 24 24"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"></path><circle cx="12" cy="9" r="2.5" fill="#fff" /></svg></div>`;
        el.dataset.rawBody = displayBody;
    } else if (isTra) {
        const parts = displayBody.split('|');
        const amount = parts[0] || '¥ 0.00';
        let note = parts[1] || '转账给您';
        const status = parts[2] || 'pending';

        el = document.createElement('div'); el.className = `transfer-card ${msg.isUser ? 'sent' : 'received'} `;
        let statusText = '转账';
        if (status === 'received') { statusText = '已收款'; el.classList.add('completed'); }
        else if (status === 'returned') { statusText = '已退回'; el.classList.add('completed'); }

        el.innerHTML = `<div class="transfer-top"><div class="transfer-icon-circle"><svg viewBox="0 0 24 24"><path d="M7 10h14l-4-4"></path><path d="M17 14H3l4 4"></path></svg></div><div class="transfer-content"><div class="transfer-amount">${amount}</div><div class="transfer-note">${note}</div></div></div><div class="transfer-bottom">${statusText}</div>`;

        // Store raw body for history persistence
        el.dataset.rawBody = `${amount}| ${parts[1] || '转账给您'}| ${status} `;

        if (status === 'pending') {
            el.onclick = (e) => {
                if (document.querySelector('.msg-action-menu')) return;
                showTransferModal(amount, note, status, msg.isUser, el);
            };
        }
    } else if (isFile) {
        const parts = displayBody.split('|');
        const fileName = parts[0];
        const fileSize = parts[1] || 'Unknown';
        const rawExt = parts[2] || 'FILE';
        const displayExt = rawExt.substring(0, 4).toUpperCase();
        el = document.createElement('div'); el.className = `file-card ${msg.isUser ? 'sent' : 'received'} `;
        // The file icon SVG: use light grey #f2f2f2 for document, and slightly darker #e6e6e6 for fold
        el.innerHTML = `<div class="file-info"><div class="file-name">${fileName}</div><div class="file-size">${fileSize}</div></div><div class="file-icon"><svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" fill="#f2f2f2"></path><polyline points="14 2 14 8 20 8" fill="#e6e6e6"></polyline><text x="50%" y="18" font-size="6" fill="#888" text-anchor="middle" font-family="Arial">${displayExt}</text></svg></div>`;
        el.dataset.rawBody = displayBody;
    } else if (isRedPacket) {
        el = document.createElement('div'); el.className = `redpacket-card ${msg.isUser ? 'sent' : 'received'}`;
        el.dataset.rawBody = displayBody;
        el.dataset.senderName = displayName;

        let data;
        try { data = JSON.parse(displayBody); } catch (e) { }
        if (!data) data = { note: '微信红包' };

        el.innerHTML = `
        <div class="redpacket-top">
            <div class="redpacket-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="4" width="18" height="16" rx="2" ry="2"></rect><path d="M3 8l9 6 9-6"></path><circle cx="12" cy="14" r="3" fill="currentColor"></circle></svg></div>
            <div class="redpacket-text">
                <div class="redpacket-note">${data.note}</div>
            </div>
        </div>
        <div class="redpacket-bottom">微信红包</div>
        `;

        if (typeof updateRedpacketCardUI === 'function') updateRedpacketCardUI(el, data);

        el.onclick = (e) => {
            if (document.querySelector('.msg-action-menu')) return;
            e.stopPropagation();
            if (typeof openRedPacket === 'function') openRedPacket(el, el.dataset.rawBody);
        };
    } else if (isLink) {
        const parts = displayBody.split('|');
        const title = parts[0] || '商品';
        const price = parts[1] || '';
        const fpStatus = parts[2] || ''; // friend-pay status: pending/accepted/rejected
        const isFriendPay = title.includes('代付') || (parts[1] && parts[1].includes('代付'));
        const headerText = isFriendPay ? '请帮我代付' : '分享好物';

        el = document.createElement('div'); el.className = `link-card ${msg.isUser ? 'sent' : 'received'}`;
        if (fpStatus === 'accepted' || fpStatus === 'rejected') el.classList.add('completed');

        el.innerHTML = `
        <div class="link-top">
            <div class="link-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9" cy="21" r="1"></circle><circle cx="20" cy="21" r="1"></circle><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"></path></svg></div>
            <div class="link-header-text">${headerText}</div>
        </div>
        <div class="link-mid">
            <div class="link-title">${title.replace(/\s*\(请帮我代付\)\s*/g, '').replace(/\s*\[送给.*?\]\s*/g, '')}</div>
            ${title.match(/\[送给(.*?)\]/) ? `<div style="font-size:11px;color:#e67e22;margin-top:3px;">🎁 送给${title.match(/\[送给(.*?)\]/)[1]}</div>` : ''}
        </div>
        <div class="link-bottom">
            <div class="link-price">${price}</div>
        </div>
        ${(isFriendPay && fpStatus) ? `<div class="fp-status ${fpStatus}">${fpStatus === 'accepted' ? '已代付' : fpStatus === 'rejected' ? '已拒绝' : '待代付'}</div>` : ''}
    `;
        el.dataset.rawBody = displayBody;

        // Friend-pay click handler
        if (isFriendPay && (!fpStatus || fpStatus === 'pending')) {
            if (!msg.isUser) {
                // Received from AI: user can accept/reject
                el.style.cursor = 'pointer';
                el.onclick = (e) => {
                    if (document.querySelector('.msg-action-menu')) return;
                    e.stopPropagation();
                    showFriendPayModal(title, price, msg.isUser, el, 'link');
                };
            }
        }
    } else if (isForum) {
        const parts = displayBody.split('|');
        const title = parts[0] || '\u8bba\u575b\u5e16\u5b50';
        const sectionAuthor = parts[1] || '\u661f\u6d77\u793e\u533a';
        const preview = parts[2] || '';

        el = document.createElement('div'); el.className = `forum-share-card ${msg.isUser ? 'sent' : 'received'}`;
        el.innerHTML = `
        <div class="forum-share-top">
            <div class="forum-share-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg></div>
            <div class="forum-share-header-text">\u661f\u6d77\u793e\u533a</div>
        </div>
        <div class="forum-share-mid">
            <div class="forum-share-title">${title}</div>
            ${preview ? `<div class="forum-share-preview">${preview}</div>` : ''}
        </div>
        <div class="forum-share-bottom">
            <div class="forum-share-meta">${sectionAuthor}</div>
        </div>
    `;
        el.dataset.rawBody = displayBody;
    } else if (isDeliver) {
        const parts = displayBody.split('|');
        const shopName = parts[0] || '配送';
        const summary = parts[1] || '';
        const total = parts[2] || '';
        const fpStatus = parts[3] || ''; // friend-pay status
        const isFriendPay = summary.includes('代付') || shopName.includes('代付');

        el = document.createElement('div'); el.className = `deliver-card ${msg.isUser ? 'sent' : 'received'}`;
        if (fpStatus === 'accepted' || fpStatus === 'rejected') el.classList.add('completed');

        el.innerHTML = `
        <div class="deliver-top">
            <div class="deliver-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path><polyline points="9 22 9 12 15 12 15 22"></polyline></svg></div>
            <div class="deliver-shop">${shopName}</div>
        </div>
        <div class="deliver-mid">
            <div class="deliver-summary">${summary.replace(/\s*\[送给.*?\]\s*/g, '')}</div>
            ${summary.match(/\[送给(.*?)\]/) ? `<div style="font-size:11px;color:#e67e22;margin-top:3px;">🎁 送给${summary.match(/\[送给(.*?)\]/)[1]}</div>` : ''}
        </div>
        <div class="deliver-bottom">
            <div class="deliver-total">${total}</div>
        </div>
        ${(isFriendPay && fpStatus) ? `<div class="fp-status ${fpStatus}">${fpStatus === 'accepted' ? '已代付' : fpStatus === 'rejected' ? '已拒绝' : '待代付'}</div>` : ''}
    `;
        el.dataset.rawBody = displayBody;

        // Friend-pay click handler
        if (isFriendPay && (!fpStatus || fpStatus === 'pending')) {
            if (!msg.isUser) {
                el.style.cursor = 'pointer';
                el.onclick = (e) => {
                    if (document.querySelector('.msg-action-menu')) return;
                    e.stopPropagation();
                    showFriendPayModal(shopName + ' ' + summary, total, msg.isUser, el, 'deliver');
                };
            }
        }
    } else if (isPomo) {
        // Pomodoro share card — similar to deliver card but with gray header
        const pomoParts = displayBody.split('|');
        const pomoTitle = pomoParts[0] || '专注记录';
        const pomoDetail = pomoParts[1] || '';
        const pomoStatus = pomoParts[2] || '进行中';

        // Extract AI lines from detail (they follow newlines after main detail)
        const detailLines = pomoDetail.split('\n');
        const mainDetail = detailLines[0];
        const aiLines = detailLines.slice(1).filter(l => l.trim());

        let statusColor = '#666';
        if (pomoStatus === '已完成') statusColor = '#333';
        else if (pomoStatus === '已放弃') statusColor = '#999';

        let aiHtml = '';
        aiLines.forEach(line => {
            aiHtml += `<div class="pomo-share-ai-line">${line}</div>`;
        });

        el = document.createElement('div'); el.className = `pomo-share-card ${msg.isUser ? 'sent' : 'received'}`;
        el.innerHTML = `
        <div class="pomo-share-top">
            <div class="pomo-share-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg></div>
            <div class="pomo-share-header-text">${pomoTitle}</div>
        </div>
        <div class="pomo-share-mid">
            <div class="pomo-share-detail">${mainDetail}</div>
            ${aiHtml}
        </div>
        <div class="pomo-share-bottom">
            <div class="pomo-share-status" style="color:${statusColor}">${pomoStatus}</div>
        </div>
    `;
        el.dataset.rawBody = displayBody;
    } else if (isToyInvite) {
        el = document.createElement('div'); el.className = `toyinvite-card ${msg.isUser ? 'sent' : 'received'}`;
        el.dataset.rawBody = displayBody;

        el.innerHTML = `
        <div class="toyinvite-bg">
            <div class="toyinvite-glow"></div>
            <div class="toyinvite-icon">
                <div class="toyinvite-icon-img" style="-webkit-mask-image: url('https://api.iconify.design/streamline-plump:heart-rate-pulse-graph-solid.svg'); mask-image: url('https://api.iconify.design/streamline-plump:heart-rate-pulse-graph-solid.svg'); -webkit-mask-size: contain; mask-size: contain; -webkit-mask-repeat: no-repeat; mask-repeat: no-repeat; -webkit-mask-position: center; mask-position: center; width: 32px; height: 32px; background-color: #fff;"></div>
            </div>
            <div class="toyinvite-text">
                <div class="toyinvite-title">爱的秘密</div>
                <div class="toyinvite-subtitle">邀你一起</div>
            </div>
            <div class="toyinvite-shimmer"></div>
        </div>
        <div class="toyinvite-footer">玩具遥控邀请</div>
        `;
    } else if (isCallMsg) {
        el = document.createElement('div');
        el.className = `bubble ${msg.isUser ? 'bubble-sent' : 'bubble-received'} `;
        // 小圆角长方形，无透明度
        el.style.borderRadius = '10px';
        el.style.opacity = '1';
        el.textContent = displayBody;
        el.dataset.msgType = 'call';
    } else if (isVoice) {
        // 检查是否是真实音频URL (http开头或characters开头)
        if (displayBody.startsWith('http') || displayBody.startsWith('characters/') || displayBody.startsWith('UserUploads/') || displayBody.startsWith('/user/images/')) {
            el = document.createElement('div');
            el.className = `real-audio-card ${msg.isUser ? 'sent' : 'received'} `;
            // 如果是相对路径，可能需要补全
            el.innerHTML = `<audio controls src="${displayBody}"></audio>`;
        } else {
            // 微信风格模拟语音气泡
            const parts = displayBody.split('|');
            const dur = Math.max(1, Math.min(45, parseInt(parts[0]) || 5));
            const txt = parts.slice(1).join('|');
            const minWidth = 66; // 最短气泡宽度（px）
            // 动态计算最大宽度：手机宽度的 65%
            const containerW = (chatMessages && chatMessages.clientWidth > 0) ? chatMessages.clientWidth : window.innerWidth;
            const maxWidth = containerW * 0.65;
            const width = Math.round(minWidth + (maxWidth - minWidth) * (dur / 45));

            // 创建容器
            const container = document.createElement('div');
            container.className = `voice-card-container ${msg.isUser ? 'sent' : 'received'} `;
            container.style.display = 'flex';
            container.style.flexDirection = 'column';
            container.style.gap = '0';

            // 创建语音条
            const voiceCard = document.createElement('div');
            // 将语音气泡的样式改为和普通文本气泡相同的类名 'bubble bubble-sent bubble-received' 等基础结构兼容（这里我们在外层直接给它bubble的效果，或者在style.css里确保背景色工作即可）。它原本通过 voice-card.style 设置了背景色。
            // 7. 将语音消息气泡样式改为和普通文本气泡相同
            voiceCard.className = `voice-card bubble ${msg.isUser ? 'bubble-sent sent' : 'bubble-received received'} `;
            voiceCard.style.minWidth = width + 'px';
            voiceCard.style.width = 'fit-content';
            voiceCard.style.cursor = 'pointer';

            // 声纹3~4根
            let waves = '';
            const barCount = 3 + Math.floor(Math.random() * 2); // 3或4根
            for (let i = 0; i < barCount; i++) waves += `<div class="wave" style="height:${6 + Math.random() * 14}px; background-color: currentColor;"></div>`;
            let barHtml = '';
            if (msg.isUser) {
                // user: 声纹在右，时长在左
                barHtml = `<div class="voice-bar" style="flex-direction: row-reverse; justify-content: flex-end; align-items: center; gap: 6px;"><div class="voice-waves" style="display: flex; align-items: center; gap: 2px;">${waves}</div><div class="voice-duration">${dur}"</div></div>`;
            } else {
                // char: 声纹在左，时长在右，整体靠右
                barHtml = `<div class="voice-bar" style="flex-direction: row; justify-content: flex-end; align-items: center; gap: 6px;"><div class="voice-waves" style="display: flex; align-items: center; gap: 2px;">${waves}</div><div class="voice-duration">${dur}"</div></div>`;
            }
            voiceCard.innerHTML = barHtml;

            // 创建文字气泡
            const textBubble = document.createElement('div');
            textBubble.className = `voice-text-bubble bubble ${msg.isUser ? 'bubble-sent sent' : 'bubble-received received'} `;
            textBubble.textContent = txt;
            textBubble.style.maxWidth = (containerW * 0.6) + 'px';
            textBubble.style.marginTop = '0px';

            // Bubble colors applied via CSS variables, no inline styles needed

            // 保存原始body用于历史记录持久化（dur|text格式）
            container.dataset.rawBody = rawBodyForHistory;

            // 添加到容器
            container.appendChild(voiceCard);
            container.appendChild(textBubble);

            // 点击事件
            voiceCard.addEventListener('click', (e) => {
                container.classList.toggle('show-text');
                e.stopPropagation();
            });

            el = container;
        }
    } else if (isSticker) {
        el = document.createElement('div'); el.className = `sticker-bubble ${msg.isUser ? 'sent' : 'received'} `;
        let src = displayBody;

        // Parse Batch Format (Name + URL/Suffix)
        // 1. Try Full URL match (Regex from triggerBatchAddSticker)
        const urlMatch = displayBody.match(/^(.*?)(https?:\/\/.*|data:image\/.*)$/);
        if (urlMatch) {
            src = urlMatch[2];
        } else {
            // 2. Try Suffix match
            // Regex adapted to allow optional name prefix for robustness
            const suffixMatch = displayBody.match(/^(.*?)([\w\-\.]+\.[a-zA-Z0-9]+)$/);
            if (suffixMatch) {
                src = 'https://img.phey.click/' + suffixMatch[2];
            }
        }

        el.innerHTML = `<img src="${src}">`;
        el.dataset.stickerBody = displayBody;
    } else if (isVideo) {
        el = document.createElement('div'); el.className = `photo-card ${msg.isUser ? 'sent' : 'received'} `;
        el.innerHTML = `<video src="${displayBody}" controls style="width:100%;border-radius:12px;"></video>`;
    } else if (isPhoto) {
        el = document.createElement('div'); el.className = `photo-card ${msg.isUser ? 'sent' : 'received'} `;
        // Check if displayBody is a valid image source (URL or base64)
        const isValidImgSrc = /^(https?:\/\/|data:image\/|blob:)/.test(displayBody);
        if (isValidImgSrc) {
            el.innerHTML = `<img src="${displayBody}">`;
        } else {
            // Text description placeholder: gray-white card with description text
            el.innerHTML = `<div class="photo-placeholder"><div class="photo-placeholder-icon"><svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="#aaa" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg></div><div class="photo-placeholder-text">${displayBody}</div></div>`;
        }
    } else if (isMusic) {
        // Music card - supports: legacy (name|artist), API format (name|artist|songId|server|coverUrl|audioUrl), and APIMUSIC|songId|server
        const musicParts = displayBody.split('|');
        el = document.createElement('div');
        el.className = 'music-card-wrapper';
        el.style.cursor = 'pointer';

        if (musicParts[0] === 'APIMUSIC' && musicParts[1]) {
            // AI-generated music tag → async load from API
            const apiSongId = musicParts[1];
            const apiServer = musicParts[2] || 'netease';
            el.dataset.rawBody = rawBodyForHistory;
            // Show loading placeholder
            el.innerHTML = '<div class="music-card-v2" style="opacity:0.7"><div class="mc2-body"><div class="mc2-name" style="color:#999">加载歌曲中...</div><div class="mc2-artist" style="color:#ccc">ID: ' + apiSongId + '</div><div class="mc2-footer"><svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55C7.79 13 6 14.79 6 17s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg><span>网易云音乐</span></div></div></div>';
            // Async fetch and render
            if (typeof renderAPIMusicCard === 'function') {
                renderAPIMusicCard(apiSongId, apiServer, el);
            }
            el.addEventListener('click', () => {
                if (typeof playMusicFromAPI === 'function') playMusicFromAPI(apiSongId, apiServer);
            });
        } else {
            // Standard format
            const songName = musicParts[0] || '未知歌曲';
            const artistName = musicParts[1] || '未知歌手';
            const songId = musicParts[2] || '';
            const server = musicParts[3] || '';
            const coverUrl = musicParts[4] || '';
            if (typeof createMusicCardHTML === 'function') {
                el.innerHTML = createMusicCardHTML(songName, artistName, msg.isUser, coverUrl || '', songId, server);
            } else {
                el.innerHTML = '<div class="bubble">[音乐] ' + songName + '</div>';
            }
            el.dataset.rawBody = rawBodyForHistory;
            el.addEventListener('click', () => {
                if (songId && typeof playMusicFromAPI === 'function') {
                    playMusicFromAPI(songId, server || 'netease');
                } else if (typeof playMusicFromCard === 'function') {
                    playMusicFromCard(songName, artistName);
                }
            });
        }
    } else {
        el = document.createElement('div'); el.className = `bubble ${msg.isUser ? 'bubble-sent' : 'bubble-received'} `;
        const textHtml = displayBody ? `<div class="msg-text">${displayBody.replace(/\n/g, '<br>')}</div>` : '';
        el.innerHTML = textHtml;
        el.dataset.rawBody = rawBodyForHistory;
        // Bubble colors are applied via CSS variables, not inline styles
        // This allows custom CSS to override them
    }

    if (msg.header) {
        if (msg.header.startsWith('[') || msg.header.startsWith('【')) {
            el.dataset.fullHeader = msg.header;
        } else {
            const isPic = isPhoto || (msg.header && msg.header.includes('图片'));
            // 统一使用 [ ]
            el.dataset.fullHeader = `[${msg.header}]`;
        }
    } else {
        const n = msg.isUser ? getUserName() : getCharName();
        const t = getTime();
        const isPic = isPhoto;
        el.dataset.fullHeader = isPic ? `[${n}| 图片 | ${t}]` : `[${n}| ${t}]`;
    }

    // 检查是否被拉黑
    // 仅依赖body中包含<blocked>标签 (持久化标记，已在上方剥离并设置isBlockedByTag)
    // 这样只有在拉黑期间发送的消息才会显示红色感叹号
    let isBlocked = isBlockedByTag;

    if (msg.header && msg.header.includes('好友申请') && msg.isUser) {
        if (getChatBlockUser()) {
            isBlocked = true;
        }
    }

    // 创建元数据容器（包含时间和状态图标）
    const metaContainer = document.createElement('div');
    metaContainer.className = 'msg-meta';

    if (isCallMsg) {
        const callIcon = document.createElement('img');
        callIcon.src = msg.isUser ? "https://api.iconify.design/si:phone-duotone.svg" : "https://api.iconify.design/si:phone-enabled-duotone.svg";
        callIcon.style.width = '12px';
        callIcon.style.height = '12px';
        callIcon.style.marginBottom = '1px';
        callIcon.style.opacity = '0.6'; // Make it subtle like timestamp
        metaContainer.appendChild(callIcon);
    }

    if (isBlocked) {
        const blockIcon = document.createElement('span');
        blockIcon.className = 'msg-status-blocked';
        blockIcon.textContent = '!';
        blockIcon.title = '消息被拦截/发送失败';
        metaContainer.appendChild(blockIcon);
    }
    metaContainer.appendChild(timeEl);

    addLongPressHandler(el);
    wrapper.appendChild(el);

    if (parsedQuote) {
        const quoteEl = document.createElement('div');
        quoteEl.className = 'msg-thought';
        quoteEl.style.marginBottom = '2px';
        quoteEl.textContent = `「 ${parsedQuote.quoteName}：${parsedQuote.quoteContent} 」`;
        container.appendChild(quoteEl);
    }

    // TTS Play Button — only for simulated voice bubbles
    if (!msg.isUser && getChatTtsEnabled && getChatTtsEnabled() && isVoice && !displayBody.startsWith('http')) {
        const voiceParts = (rawBodyForHistory || displayBody).split('|');
        const ttsText = voiceParts.slice(1).join('|').replace(/\*[^*]+\*\s*$/, '').trim();
        if (ttsText) {
            const voiceBarEl = el.querySelector('.voice-bar');
            const ttsBtn = document.createElement('span');
            ttsBtn.className = 'tts-play-btn';
            ttsBtn.innerHTML = '<svg viewBox="0 0 24 24" width="10" height="10" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>';
            ttsBtn.title = '播放语音';
            ttsBtn.dataset.ttsText = ttsText;
            // Style: match bubble text color at 50% opacity, inline
            ttsBtn.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;border-radius:50%;background:rgba(128,128,128,0.12);color:inherit;opacity:0.5;cursor:pointer;vertical-align:middle;margin-left:4px;margin-right:-8px;flex-shrink:0;border:none;outline:none;transition:opacity 0.2s;';
            ttsBtn.addEventListener('mouseenter', () => ttsBtn.style.opacity = '1');
            ttsBtn.addEventListener('mouseleave', () => { if (!ttsBtn.classList.contains('playing')) ttsBtn.style.opacity = '0.5'; });
            ttsBtn.addEventListener('click', function (e) {
                e.stopPropagation();
                handleTtsPlay(el, ttsBtn);
            });
            if (voiceBarEl) {
                voiceBarEl.appendChild(ttsBtn);
            }
        }
    }

    wrapper.appendChild(metaContainer); container.appendChild(wrapper);

    if (displayThought) {
        const thoughtEl = document.createElement('div'); thoughtEl.className = 'msg-thought';
        thoughtEl.textContent = displayThought; container.appendChild(thoughtEl);
    }

    row.appendChild(avatar); row.appendChild(container); chatMessages.appendChild(row); chatMessages.scrollTop = chatMessages.scrollHeight;
    if (!isLoadingHistory) saveCurrentChatHistory();
}




async function saveCurrentChatHistory() {
    if (isLoadingHistory || !currentChatTag || !chatMessages) return;

    const history = [];
    const messageElements = chatMessages.querySelectorAll('[data-full-header]');

    messageElements.forEach(el => {
        const row = el.closest('.message-row');
        // Fix: Check class AND header. System messages don't have 'sent' class but may be user-initiated (e.g. transfer claim).
        const isUser = (row && row.classList.contains('sent')) ||
            (el.dataset.fullHeader && el.dataset.fullHeader.includes(getUserName())) ||
            el.classList.contains('bubble-sent');

        // Extract body: handle special message types
        let body = el.dataset.rawBody;
        if (!body) {
            // Photo: extract img src
            const img = el.querySelector('img');
            if (el.classList.contains('photo-card') && img) {
                body = img.src;
            }
            // Sticker: use stickerBody dataset
            else if (el.dataset.stickerBody) {
                body = el.dataset.stickerBody;
            }
            // Fallback to textContent
            else {
                body = el.textContent;
            }
        }

        const msg = {
            header: el.dataset.fullHeader,
            body: body,
            isUser: isUser
        };
        history.push(msg);
    });

    try {
        await saveChatHistory(currentChatTag, history);
    } catch (e) {
        console.error("Failed to save chat history to IndexedDB", e);
    }
}

async function loadInitialChat() {
    if (!chatMessages || !currentChatTag) return;
    chatMessages.innerHTML = '';

    try {
        const history = await getChatHistory(currentChatTag);
        if (history && Array.isArray(history)) {
            isLoadingHistory = true;
            history.forEach(msg => {
                renderMessageToUI(msg, true);
            });
            // Defer resetting the flag and scrolling to ensure all render calls are processed
            setTimeout(() => {
                if (chatMessages) chatMessages.scrollTop = chatMessages.scrollHeight;
                isLoadingHistory = false;
            }, 0);
        }
    } catch (e) {
        console.error("Failed to load chat history from IndexedDB", e);
        isLoadingHistory = false; // Ensure flag is reset on error
    }

    // Update blocked notice bar visibility
    updateBlockedNoticeBar();
}

function updateBlockedNoticeBar() {
    const bar = document.getElementById('blocked-notice-bar');
    if (!bar) return;
    if (getChatBlockUser()) {
        bar.style.display = 'block';
    } else {
        bar.style.display = 'none';
    }
}

window.reapplyFriendRequest = function () {
    const charName = getCharName();
    const userName = getUserName();
    if (!charName || !currentChatTag) return;

    // Show a popup for the user to write a friend request message
    const old = document.getElementById('friend-request-popup');
    if (old) old.remove();

    const overlay = document.createElement('div');
    overlay.id = 'friend-request-popup';
    overlay.style.cssText = 'position:fixed; inset:0; z-index:99999; display:flex; align-items:center; justify-content:center; background:rgba(0,0,0,0.35); backdrop-filter:blur(4px);';
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

    const box = document.createElement('div');
    box.className = 'modal-box group-modal-cute';
    box.style.cssText = 'width: 280px; display: flex; flex-direction: column; gap: 14px;';

    box.innerHTML = '<div class="modal-title group-modal-title" style="margin-top:0;">申请加好友</div>'
        + '<div style="font-size:12px; color:#999; text-align:center;">向 ' + charName + ' 发送好友申请</div>'
        + '<textarea id="fr-message-input" class="group-modal-input" placeholder="请输入留言..." style="height:80px; resize:none; margin-bottom: 0;"></textarea>'
        + '<div class="modal-actions" style="margin-top: 10px; gap: 10px;">'
        + '<button id="fr-cancel" class="modal-btn group-modal-cancel">取消</button>'
        + '<button id="fr-send" class="modal-btn group-modal-confirm">发送</button>'
        + '</div>';
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    setTimeout(() => box.querySelector('#fr-message-input').focus(), 100);

    box.querySelector('#fr-cancel').onclick = () => overlay.remove();
    box.querySelector('#fr-send').onclick = () => {
        const msg = box.querySelector('#fr-message-input').value.trim() || '我想和你重新做朋友';
        overlay.remove();

        // Send as a user message with friend_request header so AI sees it
        const t = getTime(true);
        const header = '[' + userName + ' | 好友申请 | ' + t + ']';
        let body = msg;

        // 如果当前拉黑了用户，发出的申请也要在本地显示感叹号
        if (getChatBlockUser()) {
            body = '<blocked>' + body;
        }

        renderMessageToUI({ header: header, body: body, isUser: true, type: 'text' });

        showToast('好友申请已发送，等待对方回应');
    };
};


function showTypingIndicator() {
    // Remove existing typing indicator if any
    const existing = document.getElementById('typing-bubble');
    if (existing) existing.remove();

    const u = getCharName();
    let avatarSrc = appSettings.charAvatar;
    if (appSettings.memberAvatars && appSettings.memberAvatars[u]) {
        avatarSrc = appSettings.memberAvatars[u];
    }

    const row = document.createElement('div');
    row.id = 'typing-bubble';
    row.className = 'message-row received';
    row.style.animation = 'fadeIn 0.2s ease';

    const avatar = document.createElement('img');
    avatar.className = 'avatar';
    avatar.src = avatarSrc;

    const container = document.createElement('div');
    container.className = 'msg-container';

    // Typing Indicator: No Name
    // const nameEl = document.createElement('div');
    // nameEl.className = 'msg-name';
    // nameEl.textContent = u;
    // container.appendChild(nameEl);

    const wrapper = document.createElement('div');
    wrapper.className = 'msg-wrapper';
    wrapper.style.marginTop = '20px';

    const el = document.createElement('div');
    el.className = 'bubble bubble-received typing-only';
    el.innerHTML = '<div class="typing-dots"><span></span><span></span><span></span></div>';

    wrapper.appendChild(el);
    container.appendChild(wrapper);
    row.appendChild(avatar);
    row.appendChild(container);

    chatMessages.appendChild(row);
    chatMessages.scrollTop = chatMessages.scrollHeight;

    // Click to dismiss
    row.onclick = () => row.remove();
}
function adjustTextareaHeight() {
    if (!messageInput) return;
    messageInput.style.height = 'auto';
    const max = parseInt(getComputedStyle(messageInput).maxHeight) || 80;
    const scrollH = messageInput.scrollHeight;
    if (scrollH > max) {
        messageInput.style.height = max + 'px';
    } else {
        messageInput.style.height = scrollH + 'px';
    }
}
function clearDeleteButton() { if (activeDeleteBtn) { activeDeleteBtn.remove(); activeDeleteBtn = null; } document.querySelectorAll('.delete-mode').forEach(el => el.classList.remove('delete-mode')); }
function updateAvatarVisibility() {
    if (!chatMessages) return;
    const rows = chatMessages.children;
    let lastSender = null;
    let lastIsUser = null;

    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        if (!row.classList.contains('message-row')) continue;
        if (row.classList.contains('system')) {
            lastSender = null;
            lastIsUser = null;
            continue;
        }

        const isUser = row.classList.contains('sent');
        const sender = row.dataset.senderName || (isUser ? 'user' : 'char');

        const avatar = row.querySelector('.avatar');
        const nameEl = row.querySelector('.msg-name');

        if (isUser === lastIsUser && sender === lastSender) {
            if (avatar) avatar.style.visibility = 'hidden';
            if (nameEl) nameEl.style.display = 'none';
        } else {
            if (avatar) avatar.style.visibility = 'visible';
            if (nameEl) nameEl.style.display = 'block';
        }

        lastIsUser = isUser;
        lastSender = sender;
    }
}
function executeDelete(el) { const r = el.closest('.message-row'); r.style.transform = 'scale(0)'; setTimeout(async () => { r.remove(); clearDeleteButton(); updateAvatarVisibility(); saveCurrentChatHistory(); }, 200); }

// ========== 多选模式 ==========
let isMultiSelectMode = false;

function enterMultiSelectMode(triggerEl) {
    isMultiSelectMode = true;
    const chatScreen = document.getElementById('chat-screen');
    chatScreen.classList.add('multi-select-mode');

    // Hide input bar
    const inputBar = document.getElementById('input-bar');
    if (inputBar) inputBar.style.display = 'none';

    // Add checkbox to each message row
    const rows = chatMessages.querySelectorAll('.message-row');
    rows.forEach(row => {
        if (row.querySelector('.multi-select-checkbox')) return;
        const cb = document.createElement('div');
        cb.className = 'multi-select-checkbox';
        cb.innerHTML = '<div class="ms-check-inner"></div>';
        cb.addEventListener('click', (e) => {
            e.stopPropagation();
            row.classList.toggle('ms-selected');
            updateMultiSelectCount();
        });
        row.insertBefore(cb, row.firstChild);
    });

    // Pre-select the trigger message
    if (triggerEl) {
        const triggerRow = triggerEl.closest('.message-row');
        if (triggerRow) {
            triggerRow.classList.add('ms-selected');
        }
    }

    // Create bottom toolbar
    const toolbar = document.createElement('div');
    toolbar.id = 'multi-select-toolbar';
    toolbar.innerHTML = `
            <div class="ms-toolbar-left">
                <span class="ms-count">已选择 <span id="ms-selected-count">0</span> 条</span>
            </div>
            <div class="ms-toolbar-right">
                <button class="ms-btn ms-btn-delete" onclick="deleteSelectedMessages()">删除</button>
                <button class="ms-btn ms-btn-cancel" onclick="exitMultiSelectMode()">取消</button>
            </div>
        `;
    chatScreen.appendChild(toolbar);
    updateMultiSelectCount();
}

function updateMultiSelectCount() {
    const count = chatMessages.querySelectorAll('.message-row.ms-selected').length;
    const countEl = document.getElementById('ms-selected-count');
    if (countEl) countEl.textContent = count;
    // Disable delete button if nothing selected
    const delBtn = document.querySelector('.ms-btn-delete');
    if (delBtn) {
        delBtn.disabled = count === 0;
        delBtn.style.opacity = count === 0 ? '0.4' : '1';
    }
}

function exitMultiSelectMode() {
    isMultiSelectMode = false;
    const chatScreen = document.getElementById('chat-screen');
    chatScreen.classList.remove('multi-select-mode');

    // Show input bar
    const inputBar = document.getElementById('input-bar');
    if (inputBar) inputBar.style.display = '';

    // Remove checkboxes and selection
    chatMessages.querySelectorAll('.multi-select-checkbox').forEach(cb => cb.remove());
    chatMessages.querySelectorAll('.ms-selected').forEach(row => row.classList.remove('ms-selected'));

    // Remove toolbar
    const toolbar = document.getElementById('multi-select-toolbar');
    if (toolbar) toolbar.remove();
}

function deleteSelectedMessages() {
    const selected = chatMessages.querySelectorAll('.message-row.ms-selected');
    if (selected.length === 0) return;

    // Animate and remove
    selected.forEach(row => {
        row.style.transition = 'transform 0.2s, opacity 0.2s';
        row.style.transform = 'scale(0.8)';
        row.style.opacity = '0';
    });

    setTimeout(() => {
        selected.forEach(row => row.remove());
        updateAvatarVisibility();
        saveCurrentChatHistory();
        exitMultiSelectMode();
    }, 220);
}

// ========== 撤回消息 ==========
function executeRecall(el) {
    const row = el.closest('.message-row');
    if (!row) return;

    // Get sender name
    const nameEl = row.querySelector('.msg-name');
    const displayName = nameEl ? nameEl.textContent : getUserName();

    // Detect message type for recall notice
    const header = el.dataset.fullHeader || '';
    const isVoice = header.includes('语音') || header.includes('VOC');
    const isPhoto = header.includes('图片');
    const isSticker = header.includes('表情包');
    const isFile = header.includes('文件');
    const isVideo = header.includes('视频');
    const isLocation = header.includes('位置');
    let typeText;
    if (isVoice) typeText = '语音';
    else if (isPhoto) typeText = '图片';
    else if (isSticker) typeText = '表情包';
    else if (isFile) typeText = '文件';
    else if (isVideo) typeText = '视频';
    else if (isLocation) typeText = '位置';
    else typeText = '消息';

    // Get time from the original header
    const timeMatch = header.match(/\|\s*(\d{1,2}:\d{2})/);
    const timeStr = timeMatch ? timeMatch[1] : getTime(true);

    // Build recall header
    const recallHeader = `[${displayName}|撤回|${timeStr}]`;

    // Get the raw body for text messages
    const rawBody = el.dataset.rawBody || el.textContent || '';

    // Build recall text
    let recallText = `${displayName}撤回了一条${typeText}`;
    // For text messages, show the recalled content
    if (typeText === '消息' && rawBody.trim()) {
        recallText += `：${rawBody.trim()}`;
    }

    // Build recall notice element
    const newRow = document.createElement('div');
    newRow.className = 'message-row system';
    newRow.style.justifyContent = 'center';

    const notice = document.createElement('div');
    notice.className = 'recall-notice';
    notice.style.fontSize = '12px';
    notice.style.color = '#999';
    notice.style.backgroundColor = 'rgba(0,0,0,0.05)';
    notice.style.padding = '4px 12px';
    notice.style.borderRadius = '10px';
    notice.textContent = recallText;
    notice.dataset.fullHeader = recallHeader;
    notice.dataset.rawBody = rawBody;

    newRow.appendChild(notice);

    // Animate out old row, animate in new row
    row.style.transition = 'transform 0.25s, opacity 0.25s';
    row.style.transform = 'scale(0.8)';
    row.style.opacity = '0';

    setTimeout(() => {
        row.replaceWith(newRow);
        updateAvatarVisibility();
        saveCurrentChatHistory();
    }, 260);
}
// Global variable for active menu
let activeMsgMenu = null;

function closeMsgMenu() {
    if (activeMsgMenu) {
        activeMsgMenu.remove();
        activeMsgMenu = null;
    }
    document.querySelectorAll('.pressing').forEach(el => el.classList.remove('pressing'));
}

function addLongPressHandler(el) {
    let timer;
    const start = (e) => {
        if (isMultiSelectMode) return; // Skip long press in multi-select mode
        if (e.target.closest('.delete-btn') || e.target.closest('.msg-action-menu')) return;
        el.classList.add('pressing');
        timer = setTimeout(() => {
            // el.classList.remove('pressing'); // Keep pressing state while menu is open
            showMessageActionMenu(el);
        }, 500);
    };
    const cancel = () => {
        clearTimeout(timer);
        if (!activeMsgMenu) el.classList.remove('pressing');
    };

    // Handle click for multi-select mode
    el.addEventListener('click', (e) => {
        if (!isMultiSelectMode) return;
        if (e.target.closest('.multi-select-checkbox')) return; // Checkbox handles itself
        e.stopPropagation();
        const row = el.closest('.message-row');
        if (row) {
            row.classList.toggle('ms-selected');
            updateMultiSelectCount();
        }
    });

    el.addEventListener('mousedown', start);
    el.addEventListener('touchstart', start, { passive: true });
    ['mouseup', 'mouseleave', 'touchend', 'touchmove'].forEach(ev => el.addEventListener(ev, cancel));
}

function showMessageActionMenu(el) {
    closeMsgMenu(); // Close existing
    closeMenus(); // Close other menus like emoji/plus

    // Get message data
    const row = el.closest('.message-row');
    const isUser = row.classList.contains('sent');
    // const isLast = row === chatMessages.lastElementChild;
    const isAi = !isUser;

    // Create Menu
    const menu = document.createElement('div');
    menu.className = 'msg-action-menu';

    // Quote
    const btnQuote = document.createElement('div');
    btnQuote.className = 'msg-action-item';
    btnQuote.innerHTML = '<img src="https://api.iconify.design/streamline:quotation-2.svg" class="msg-action-icon">';
    btnQuote.onclick = (e) => { e.stopPropagation(); executeQuote(el); closeMsgMenu(); };
    menu.appendChild(btnQuote);

    // Edit
    const btnEdit = document.createElement('div');
    btnEdit.className = 'msg-action-item';
    btnEdit.innerHTML = '<img src="https://api.iconify.design/hugeicons:pencil-edit-02.svg" class="msg-action-icon">';
    btnEdit.onclick = (e) => { e.stopPropagation(); executeEdit(el); closeMsgMenu(); };
    menu.appendChild(btnEdit);

    // Regenerate (Only for AI messages)
    if (isAi) {
        const btnRegen = document.createElement('div');
        btnRegen.className = 'msg-action-item';
        btnRegen.innerHTML = '<img src="https://api.iconify.design/system-uicons:reset-alt.svg" class="msg-action-icon">';
        btnRegen.onclick = (e) => { e.stopPropagation(); executeRegenerate(el); closeMsgMenu(); };
        menu.appendChild(btnRegen);
    }

    // TTS Play (Only for AI messages when TTS is enabled)
    if (isAi && appSettings.ttsEnabled) {
        const btnTts = document.createElement('div');
        btnTts.className = 'msg-action-item';
        btnTts.innerHTML = '<img src="https://api.iconify.design/icon-park-outline:voice.svg" class="msg-action-icon">';
        btnTts.onclick = (e) => {
            e.stopPropagation();
            closeMsgMenu();
            // Find or create the TTS button and trigger play
            const bubble = el;
            const row = el.closest('.message-row');
            let ttsBtn = row.querySelector('.tts-play-btn');
            if (!ttsBtn) {
                // Create a temporary button
                ttsBtn = document.createElement('div');
                ttsBtn.className = 'tts-play-btn';
                ttsBtn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>';
                const bubbleWrapper = row.querySelector('.chat-bubble-wrapper') || row;
                bubbleWrapper.appendChild(ttsBtn);
            }
            handleTtsPlay(bubble, ttsBtn);
        };
        menu.appendChild(btnTts);
    }

    // Multi-select
    const btnMulti = document.createElement('div');
    btnMulti.className = 'msg-action-item';
    btnMulti.innerHTML = '<img src="https://api.iconify.design/mdi:checkbox-multiple-marked-outline.svg" class="msg-action-icon">';
    btnMulti.onclick = (e) => { e.stopPropagation(); closeMsgMenu(); enterMultiSelectMode(el); };
    menu.appendChild(btnMulti);

    // Delete
    const btnDelete = document.createElement('div');
    btnDelete.className = 'msg-action-item';
    btnDelete.innerHTML = '<img src="https://api.iconify.design/carbon:delete.svg" class="msg-action-icon">';
    btnDelete.onclick = (e) => { e.stopPropagation(); executeDelete(el); closeMsgMenu(); };
    menu.appendChild(btnDelete);

    // Recall (Only for User messages, always rightmost)
    if (isUser) {
        const btnRecall = document.createElement('div');
        btnRecall.className = 'msg-action-item';
        btnRecall.innerHTML = '<img src="https://api.iconify.design/mdi:undo-variant.svg" class="msg-action-icon">';
        btnRecall.onclick = (e) => { e.stopPropagation(); executeRecall(el); closeMsgMenu(); };
        menu.appendChild(btnRecall);
    }

    document.getElementById('chat-screen').appendChild(menu);
    activeMsgMenu = menu;

    // Position
    const rect = el.getBoundingClientRect();
    const screenRect = document.getElementById('chat-screen').getBoundingClientRect();

    // Default top (above bubble)
    let top = rect.top - screenRect.top - menu.offsetHeight - 5;
    let left = rect.left - screenRect.left + (rect.width / 2) - (menu.offsetWidth / 2);

    // Adjust if too close to top
    if (top < 60) {
        top = rect.bottom - screenRect.top + 10;
        menu.classList.add('top');
    }

    // Adjust horizontal
    if (left < 10) left = 10;
    if (left + menu.offsetWidth > screenRect.width) left = screenRect.width - menu.offsetWidth - 10;

    menu.style.top = top + 'px';
    menu.style.left = left + 'px';

    // Click outside to close
    setTimeout(() => {
        const closeHandler = (e) => {
            if (!menu.contains(e.target)) {
                closeMsgMenu();
                document.removeEventListener('click', closeHandler);
            }
        };
        document.addEventListener('click', closeHandler);
    }, 0);
}

function executeQuote(el) {
    const row = el.closest('.message-row');
    const nameEl = row.querySelector('.msg-name');
    const name = nameEl ? nameEl.textContent : '对方';

    let content = '';

    if (el.classList.contains('bubble') && !el.dataset.msgType) {
        content = el.textContent || '';
        if (content.length > 20) content = content.substring(0, 20) + '...';
    } else if (el.dataset.msgType === 'call') {
        content = '[通话]';
    } else if (el.classList.contains('sticker-bubble') || (el.dataset.stickerBody)) {
        content = '[表情包]';
    } else if (el.classList.contains('photo-card')) {
        if (el.querySelector('video')) content = '[视频]';
        else content = '[图片]';
    } else if (el.classList.contains('voice-card') || el.classList.contains('real-audio-card')) {
        content = '[语音]';
    } else if (el.classList.contains('location-card')) {
        content = '[位置]';
    } else if (el.classList.contains('transfer-card')) {
        content = '[转账]';
    } else if (el.classList.contains('file-card')) {
        content = '[文件]';
    } else if (el.classList.contains('link-card')) {
        content = '[链接]';
    } else if (el.classList.contains('deliver-card')) {
        content = '[订单]';
    } else if (el.dataset.fullHeader && el.dataset.fullHeader.includes('视频')) {
        content = '[视频]';
    } else {
        content = el.textContent || '[消息]';
        if (content.length > 20) content = content.substring(0, 20) + '...';
    }

    // New format: [REP:名字]引用内容[/REP]
    // Instead of injecting into input, show preview
    showQuotePreview(name, content);
    const input = document.getElementById('message-input');
    input.focus();
}

function executeRegenerate(el) {
    const row = el.closest('.message-row');
    if (row) {
        // Delete all subsequent messages (Rollback)
        let next = row.nextElementSibling;
        while (next) {
            const toRemove = next;
            next = next.nextElementSibling;
            if (toRemove.classList.contains('message-row')) {
                toRemove.remove();
            }
        }

        // Remove the target message itself
        row.remove();

        // Update history based on current DOM (which now lacks the deleted messages)
        saveCurrentChatHistory();

        // Trigger generation again
        triggerGenerate();
    }
}

function executeEdit(el) {
    let currentText = '';

    if (el.classList.contains('bubble')) {
        currentText = el.dataset.rawBody || el.textContent;
    } else if (el.classList.contains('location-card')) {
        currentText = el.querySelector('.location-name').textContent;
    } else if (el.classList.contains('transfer-card')) {
        currentText = el.querySelector('.transfer-amount').textContent + '|' + el.querySelector('.transfer-note').textContent;
    } else if (el.classList.contains('file-card')) {
        currentText = el.querySelector('.file-name').textContent;
    } else if (el.classList.contains('voice-card')) {
        currentText = el.querySelector('.voice-duration').textContent.replace('"', '') + '|' + el.querySelector('.voice-text').textContent;
    } else if (el.classList.contains('photo-card') || el.classList.contains('sticker-bubble')) {
        const img = el.querySelector('img');
        if (img) currentText = img.src;
    }

    openModal('编辑消息', [{ placeholder: '输入新内容', value: currentText }], async (values) => {
        const newText = values[0];
        if (newText === undefined) return;

        if (el.classList.contains('bubble')) {
            // Re-parse quote logic (unified)
            let displayBody = newText;
            let quoteHtml = '';
            const parsedQuote = parseQuote(newText);
            if (parsedQuote) {
                displayBody = parsedQuote.replyBody;
                quoteHtml = buildQuoteHtml(parsedQuote);
            }

            el.innerHTML = quoteHtml + displayBody.replace(/\n/g, '<br>');
            el.dataset.rawBody = newText;
        } else if (el.classList.contains('location-card')) {
            el.querySelector('.location-name').textContent = newText;
        } else if (el.classList.contains('file-card')) {
            el.querySelector('.file-name').textContent = newText;
        } else if (el.classList.contains('transfer-card')) {
            const parts = newText.split('|');
            if (parts[0]) el.querySelector('.transfer-amount').textContent = parts[0];
            if (parts[1]) el.querySelector('.transfer-note').textContent = parts[1] || '';
        } else if (el.classList.contains('voice-card')) {
            const parts = newText.split('|');
            const dur = parts[0] || '1';
            const txt = parts.slice(1).join('|');
            el.querySelector('.voice-duration').textContent = dur + '"';
            el.querySelector('.voice-text').textContent = txt;
            // Recalculate width
            const minWidth = 66;
            const containerW = chatMessages ? chatMessages.clientWidth : window.innerWidth;
            const maxWidth = containerW * 0.65;
            const width = Math.round(minWidth + (maxWidth - minWidth) * (Math.min(45, parseInt(dur) || 1) / 45));
            el.style.width = width + 'px';
        } else if (el.classList.contains('photo-card') || el.classList.contains('sticker-bubble')) {
            const img = el.querySelector('img');
            if (img) img.src = newText;
        }

        saveCurrentChatHistory();
    });
}

function showDeleteButton(el) {
    showMessageActionMenu(el);
}
document.onclick = (e) => {
    if (activeDeleteBtn && !e.target.closest('.location-card, .transfer-card, .file-card, .bubble, .voice-card-container, .real-audio-card, .photo-card, .sticker-bubble')) clearDeleteButton();

    if (!e.target.closest('.sticker-item')) {
        document.querySelectorAll('.sticker-item .delete-btn').forEach(b => b.remove());
        document.querySelectorAll('.sticker-item.delete-mode').forEach(i => i.classList.remove('delete-mode'));
    }

    // 点击外部关闭菜单
    if (actionMenu && actionMenu.classList.contains('open') && !e.target.closest('#action-menu') && !e.target.closest('#plus-button')) {
        closeMenus();
    }
    if (emojiMenu && emojiMenu.classList.contains('open') && !e.target.closest('#emoji-menu') && !e.target.closest('#emoji-button')) {
        closeMenus();
    }

    if (activeMsgMenu && !e.target.closest('.msg-action-menu')) {
        closeMsgMenu();
    }
};

function triggerSettingsUpload(type) {
    currentSettingsUploadType = type;
    const input = document.getElementById('settings-file-input');
    if (input) input.click();
}

let cropper;

function openCropper(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
        const image = document.getElementById('cropper-image');
        image.src = e.target.result;

        const modal = document.getElementById('cropper-modal');
        modal.classList.add('show');

        if (cropper) {
            cropper.destroy();
        }

        let aspectRatio = 1;
        // 壁纸使用手机比例，头像使用 1:1, 朋友圈封面使用 16:9
        if (currentSettingsUploadType === 'home-bg' || currentSettingsUploadType === 'chat-bg') {
            const w = window.innerWidth;
            const h = window.innerHeight;
            aspectRatio = w / h;
        } else if (currentSettingsUploadType === 'moments-cover') {
            aspectRatio = 16 / 9;
        }

        cropper = new Cropper(image, {
            aspectRatio: aspectRatio,
            viewMode: 1,
            autoCropArea: 1,
        });
    };
    reader.readAsDataURL(file);
}

function closeCropper() {
    const modal = document.getElementById('cropper-modal');
    modal.classList.remove('show');
    if (cropper) {
        cropper.destroy();
        cropper = null;
    }
    // Reset input value so same file can be selected again if cancelled
    const input = document.getElementById('settings-file-input');
    if (input) input.value = '';
}

function confirmCrop() {
    if (!cropper) return;

    // Get cropped canvas
    const canvas = cropper.getCroppedCanvas();
    if (!canvas) return;

    canvas.toBlob(async (blob) => {
        if (!blob) return;

        // Use the blob for upload
        await processSettingsUpload(blob);

        closeCropper();
    }, 'image/jpeg', 0.9);
}

// Extracted upload logic
async function processSettingsUpload(file) {
    try {
        let url = '';
        // 尝试使用父级上传接口
        // Standalone mode: always convert to Base64
        url = await new Promise((resolve) => {
            const reader = new FileReader();
            reader.onload = (ev) => resolve(ev.target.result);
            reader.readAsDataURL(file);
        });

        if (url) {
            if (currentSettingsUploadType === 'char-avatar') {
                // UNIFIED SYNC: Update the actual character data if we are in a chat with them
                if (currentChatTag && currentChatTag.startsWith('chat:')) {
                    const npc = npcCharacters.find(n => n.name === currentChatTarget);
                    if (npc) {
                        npc.avatar = url;
                        saveNpcsToStorage(); // Persist to storage
                        // Update UI list if open
                        const npcList = document.getElementById('npc-list-container');
                        if (npcList && npcList.offsetParent) renderNpcList();
                    }
                }

                appSettings.charAvatar = url;
                renderAvatarSettings();
                saveSettingsToStorage();
            } else if (currentSettingsUploadType === 'user-avatar') {
                // UNIFIED SYNC: Update the actual user data
                if (appSettings.currentUserId !== undefined && userCharacters[appSettings.currentUserId]) {
                    userCharacters[appSettings.currentUserId].avatar = url;
                    saveUsersToStorage();
                    // Update UI list if open
                    const userList = document.getElementById('user-list-container');
                    if (userList && userList.offsetParent) renderUserList();
                }

                appSettings.userAvatar = url;
                renderAvatarSettings();
                saveSettingsToStorage();
            } else if (currentSettingsUploadType === 'chat-bg') {
                appSettings.chatBg = url;
                const preview = document.getElementById('preview-chat-bg');
                if (preview) preview.src = url;
                saveSettingsToStorage();
            } else if (currentSettingsUploadType === 'home-bg') {
                appSettings.homeBg = url;
                const preview = document.getElementById('preview-home-bg');
                if (preview) preview.src = url;
                saveSettingsToStorage();
            } else if (currentSettingsUploadType === 'moments-cover') {
                setMomentsCoverBg(url);
                renderMoments();
                showToast('封面已更新');
            } else if (currentSettingsUploadType === 'moments-avatar') {
                localStorage.setItem('faye-phone-moments-avatar', url);
                renderMoments();
                showToast('头像已更新');
            } else if (currentSettingsUploadType === 'group-avatar') {
                if (!appSettings.groupAvatars) appSettings.groupAvatars = {};
                appSettings.groupAvatars[currentChatTag] = url;
                renderAvatarSettings();
                saveSettingsToStorage();
            } else if (currentSettingsUploadType && currentSettingsUploadType.startsWith('member:')) {
                const memberName = currentSettingsUploadType.split(':')[1];
                if (memberName) {
                    // UNIFIED SYNC for Private Chat Settings
                    // 1. Try to find/update NPC
                    const npc = npcCharacters.find(n => n.name === memberName);
                    if (npc) {
                        npc.avatar = url;
                        saveNpcsToStorage();
                        // Update UI list if open
                        const npcList = document.getElementById('npc-list-container');
                        if (npcList && npcList.offsetParent) renderNpcList();
                    }

                    // 2. Try to find/update User
                    if (appSettings.currentUserId !== undefined && userCharacters[appSettings.currentUserId] && userCharacters[appSettings.currentUserId].name === memberName) {
                        userCharacters[appSettings.currentUserId].avatar = url;
                        saveUsersToStorage();
                    } else {
                        // Also check lookup by name for other users? (Maybe not needed if we only edit 'me' or 'npc')
                        const user = userCharacters.find(u => u.name === memberName);
                        if (user) {
                            user.avatar = url;
                            saveUsersToStorage();
                        }
                    }

                    if (!appSettings.memberAvatars) appSettings.memberAvatars = {};
                    appSettings.memberAvatars[memberName] = url;
                    renderAvatarSettings();
                    saveSettingsToStorage();
                }
            } else if (currentSettingsUploadType === 'npc-create-avatar') {
                const preview = document.getElementById('npc-avatar-preview');
                if (preview) preview.src = url;
            } else if (currentSettingsUploadType === 'user-create-avatar') {
                const preview = document.getElementById('user-avatar-preview');
                if (preview) preview.src = url;
            }
        }
    } catch (err) {
        console.error("Upload failed", err);
        alert("上传失败: " + err.message);
    }

    // Reset input (if any)
    const input = document.getElementById('settings-file-input');
    if (input) input.value = '';
}

//==============================
// Character Setup (NPC角色管理 - 与User设置页面一致的风格)
//==============================
let npcCharacters = [];
let editingNpcIndex = null;

function loadNpcData() {
    const storedNpcs = localStorage.getItem('npcCharacters');
    if (storedNpcs) {
        try { npcCharacters = JSON.parse(storedNpcs); } catch (e) { npcCharacters = []; }
    }
}

function saveNpcsToStorage() {
    localStorage.setItem('npcCharacters', JSON.stringify(npcCharacters));
}

function openNpcSettings() {
    if (homeScreen) homeScreen.style.display = 'none';
    const screen = document.getElementById('character-setup-screen');
    if (screen) screen.style.display = 'flex';
    updateStatusBar('settings');
    loadNpcData();
    renderNpcList();
}

function renderNpcList() {
    const listContainer = document.getElementById('npc-list-container');
    if (!listContainer) return;
    listContainer.innerHTML = '';

    const defaultAvatar = "data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='%23d1d1d6'%3E%3Cpath d='M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z'/%3E%3C/svg%3E";

    if (npcCharacters.length === 0) {
        listContainer.innerHTML = '<div class="user-list-empty"><div>还没有角色哦~<br>点击右上角 + 创建一个吧</div></div>';
        return;
    }

    npcCharacters.forEach((npc, index) => {
        const card = document.createElement('div');
        card.className = 'user-card';
        const subNpcCount = (npc.npcs && npc.npcs.length) || 0;
        card.innerHTML = `
        <img src="${npc.avatar || defaultAvatar}" alt="avatar" class="user-card-avatar">
            <div class="user-card-info">
                <div class="user-card-name">${npc.name || '未命名'}</div>
                <div class="user-card-meta">
                    <span>${npc.gender === 'male' ? '男' : '女'}</span>
                    ${subNpcCount > 0 ? '<span>' + subNpcCount + ' 个关联NPC</span>' : ''}
                    ${(npc.worldbooks && npc.worldbooks.length > 0) || npc.worldbook ? '<span>有世界书</span>' : ''}
                </div>
            </div>
    `;
        let pressTimer = null;
        let isDragging = false;
        card.addEventListener('touchstart', (e) => {
            isDragging = false;
            pressTimer = setTimeout(() => {
                if (!isDragging) showGlobalDeleteMenu(npc.name || '未命名', () => deleteNpc(index));
            }, 600);
        }, { passive: true });
        card.addEventListener('touchmove', () => { isDragging = true; clearTimeout(pressTimer); }, { passive: true });
        card.addEventListener('touchend', () => { clearTimeout(pressTimer); });
        card.addEventListener('touchcancel', () => { clearTimeout(pressTimer); });

        card.oncontextmenu = (e) => {
            e.preventDefault();
            showGlobalDeleteMenu(npc.name || '未命名', () => deleteNpc(index));
        };
        card.onclick = (e) => {
            editNpc(index);
        };
        listContainer.appendChild(card);
    });
}

function openNpcCreatePage(index = null) {
    editingNpcIndex = index;
    const screen = document.getElementById('npc-create-screen');
    const titleEl = document.getElementById('npc-create-title');
    const avatarPreview = document.getElementById('npc-avatar-preview');
    const nameInput = document.getElementById('npc-name-input-page');
    const descInput = document.getElementById('npc-desc-input-page');
    const subNpcList = document.getElementById('npc-sub-npc-list');
    // Removed worldbookSelect reference and duplicate subNpcList
    if (!screen) return;

    // Reset gender selection
    const genderOptions = screen.querySelectorAll('.uc-gender-option');
    genderOptions.forEach(opt => opt.classList.remove('selected'));

    const defaultAv = "data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='%23d1d1d6'%3E%3Cpath d='M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z'/%3E%3C/svg%3E";

    if (index !== null && npcCharacters[index]) {
        const npc = npcCharacters[index];
        if (titleEl) titleEl.textContent = '编辑角色';
        if (avatarPreview) avatarPreview.src = npc.avatar || defaultAv;
        if (nameInput) nameInput.value = npc.name || '';
        if (descInput) descInput.value = npc.persona || npc.desc || '';
        const gender = npc.gender || 'female';
        const genderRadio = screen.querySelector(`input[name = "npc-gender-page"][value = "${gender}"]`);
        if (genderRadio) {
            genderRadio.checked = true;
            const genderLabel = genderRadio.closest('label');
            if (genderLabel) genderLabel.classList.add('selected');
        }
        // Multi-select init handled later
        if (subNpcList) {
            subNpcList.innerHTML = '';
            if (npc.npcs && npc.npcs.length > 0) {
                npc.npcs.forEach((sub, subIdx) => renderNpcCard(subNpcList, sub, subIdx));
            }
        }
    } else {
        if (titleEl) titleEl.textContent = '创建角色';
        if (avatarPreview) avatarPreview.src = defaultAv;
        if (nameInput) nameInput.value = '';
        if (descInput) descInput.value = '';
        if (subNpcList) subNpcList.innerHTML = '';
    }

    // Initialize Worldbook Multi-select
    let initialWbs = [];
    if (index !== null && npcCharacters[index]) {
        const n = npcCharacters[index];
        if (n.worldbooks) initialWbs = n.worldbooks;
        else if (n.worldbook) initialWbs = [n.worldbook];
    }
    renderWorldbookMultiSelect('npc-worldbook-select', initialWbs);

    updateNpcTokenCount();

    const settingsScreen = document.getElementById('character-setup-screen');
    if (settingsScreen) settingsScreen.style.display = 'none';
    screen.style.display = 'flex';
    updateStatusBar('settings');
}

function closeNpcCreatePage() {
    const screen = document.getElementById('npc-create-screen');
    if (screen) screen.style.display = 'none';
    const settingsScreen = document.getElementById('character-setup-screen');
    if (settingsScreen) settingsScreen.style.display = 'flex';
    editingNpcIndex = null;
}

function renderWorldbookMultiSelect(containerId, selectedList = []) {
    const container = document.getElementById(containerId);
    if (!container) return;
    container.innerHTML = '';

    const cleanSelected = (selectedList || []).filter(v => v);

    let availableWbs = [];
    try {
        const stored = localStorage.getItem('faye-phone-worldbooks');
        if (stored) availableWbs = JSON.parse(stored);
    } catch (e) { }

    const defaultWb = localStorage.getItem('faye-phone-worldbook');
    if (defaultWb) {
        availableWbs.push({ name: '__default__', displayName: '默认世界书' });
    }

    if (availableWbs.length === 0) {
        container.innerHTML = '<div class="wb-option-empty">暂无世界书</div>';
        return;
    }

    availableWbs.forEach(wb => {
        const val = wb.name;
        const disp = wb.displayName || wb.name;
        const isChecked = cleanSelected.includes(val);

        const row = document.createElement('div');
        row.className = 'wb-option-row';
        row.innerHTML = `
            <label style="display:flex;align-items:center;width:100%;cursor:pointer;">
                <input type="checkbox" value="${val}" ${isChecked ? 'checked' : ''}>
                <span style="margin-left:8px;flex:1;">${disp}</span>
            </label>
        `;
        container.appendChild(row);
    });
}

function updateNpcTokenCount() {
    const descInput = document.getElementById('npc-desc-input-page');
    const tokenEl = document.getElementById('npc-desc-token');
    if (!descInput || !tokenEl) return;
    let totalTokens = estimateTokens(descInput.value);

    document.querySelectorAll('#npc-sub-npc-list .uc-npc-card').forEach(card => {
        const nameVal = (card.querySelector('.npc-name-input') || {}).value || '';
        const descVal = (card.querySelector('.npc-desc-input') || {}).value || '';
        totalTokens += estimateTokens(nameVal) + estimateTokens(descVal);
    });

    tokenEl.textContent = totalTokens + ' tokens';
}

function saveNpc() {
    const avatar = document.getElementById('npc-avatar-preview').src;
    const name = (document.getElementById('npc-name-input-page').value || '').trim();
    const desc = document.getElementById('npc-desc-input-page').value || '';

    // Collect Multi-select Worldbooks
    const worldbooks = [];
    const wbContainer = document.getElementById('npc-worldbook-select');
    if (wbContainer) {
        wbContainer.querySelectorAll('input[type="checkbox"]:checked').forEach(cb => {
            worldbooks.push(cb.value);
        });
    }

    if (!name) { alert('请输入角色姓名~'); return; }
    const genderRadio = document.querySelector('input[name="npc-gender-page"]:checked');
    const gender = genderRadio ? genderRadio.value : 'female';
    const npcs = [];
    document.querySelectorAll('#npc-sub-npc-list .uc-npc-card').forEach(card => {
        const npcName = (card.querySelector('.npc-name-input') || {}).value || '';
        const npcGenderRadio = card.querySelector('input[name^="npc-gender-"]:checked');
        const npcGender = npcGenderRadio ? npcGenderRadio.value : 'female';
        const npcDesc = (card.querySelector('.npc-desc-input') || {}).value || '';
        if (npcName.trim()) npcs.push({ name: npcName.trim(), gender: npcGender, desc: npcDesc.trim() });
    });

    let baseNpc = {};
    if (editingNpcIndex !== null && npcCharacters[editingNpcIndex]) {
        baseNpc = { ...npcCharacters[editingNpcIndex] };
    }

    const npcData = { ...baseNpc, avatar, name, gender, persona: desc, worldbooks, npcs };

    if (editingNpcIndex !== null) { npcCharacters[editingNpcIndex] = npcData; }
    else { npcCharacters.push(npcData); }
    saveNpcsToStorage();
    closeNpcCreatePage();
    renderNpcList();
}

function editNpc(index) { openNpcCreatePage(index); }

function deleteNpc(index) {
    if (confirm('确定要删除角色 "' + npcCharacters[index].name + '" 吗？')) {
        npcCharacters.splice(index, 1);
        saveNpcsToStorage();
        renderNpcList();
    }
}

function handleNpcAvatarChange(event) {
    const file = event.target.files[0];
    if (file) {
        currentSettingsUploadType = 'npc-create-avatar';
        openCropper(file);
        // Reset input so same file can be selected again
        event.target.value = '';
    }
}

function addSubNpcToNpc() {
    const npcList = document.getElementById('npc-sub-npc-list');
    if (!npcList) return;
    renderNpcCard(npcList, null, npcList.children.length);
}

//==============================
// Import Tavern JSON Character
//==============================
let pendingImportNpcData = null;

function handleNpcImportChange(event) {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
        try {
            const json = JSON.parse(e.target.result);
            if (json.data && json.data.name) {
                showNpcImportModal(json);
            } else if (json.name) {
                // Handle raw data format if needed, but standard is nested in .data
                showNpcImportModal({ data: json });
            } else {
                showToast("不支持的格式或者缺少核心数据");
            }
        } catch (err) {
            showToast("解析 JSON 失败");
        }
        event.target.value = ''; // Reset
    };
    reader.readAsText(file);
}

function showNpcImportModal(json) {
    const data = json.data;
    pendingImportNpcData = data;

    const container = document.getElementById('import-mapping-container');
    if (!container) return;
    container.innerHTML = '';

    const mappings = [
        { key: 'name', tavValue: data.name, bfield: '角色名' },
        { key: 'description', tavValue: data.description, bfield: '角色设定' },
        { key: 'personality', tavValue: data.personality, bfield: '性格' },
        { key: 'scenario', tavValue: data.scenario, bfield: '背景/情景' },
        { key: 'first_mes', tavValue: data.first_mes, bfield: '开场白' },
        { key: 'mes_example', tavValue: data.mes_example, bfield: '对话示例' },
        { key: 'system_prompt', tavValue: data.system_prompt, bfield: '自定义系统提示词' },
        { key: 'post_history_instructions', tavValue: data.post_history_instructions, bfield: '历史后指令 (越狱)' },
        { key: 'creator_notes', tavValue: data.creator_notes, bfield: '创建者备注' },
    ];

    // Alternate greetings
    if (data.alternate_greetings && data.alternate_greetings.length > 0) {
        mappings.push({ key: 'alternate_greetings', tavValue: `${data.alternate_greetings.length} 个备选`, bfield: `备选开场白 (${data.alternate_greetings.length} 个)` });
    }

    // World book
    if (data.character_book && data.character_book.entries && data.character_book.entries.length > 0) {
        const wbName = data.character_book.name || data.name || '角色';
        mappings.push({ key: 'character_book', tavValue: `${data.character_book.entries.length} 个条目`, bfield: `世界书「${wbName}」(${data.character_book.entries.length} 个条目)` });
    }

    // Regex scripts
    const regexScripts = data.extensions && data.extensions.regex_scripts;
    if (regexScripts && regexScripts.length > 0) {
        mappings.push({ key: 'regex_scripts', tavValue: `${regexScripts.length} 条`, bfield: `正则脚本 (${regexScripts.length} 条)` });
    }

    mappings.forEach(m => {
        let valText = m.tavValue ? String(m.tavValue).trim() : '';
        const isEmpt = !valText;
        if (isEmpt) return; // 只列出检测到的项目

        const row = document.createElement('div');
        row.style.padding = '8px 4px';
        row.style.borderBottom = '1px solid #f0f0f0';
        row.style.display = 'flex';
        row.style.alignItems = 'center';
        row.style.gap = '8px';
        row.innerHTML = `
            <label style="display:flex;align-items:center;gap:8px;width:100%;cursor:pointer;">
                <input type="checkbox" class="import-item-cb" data-key="${m.key}" checked>
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="#2e8b57" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                    <polyline points="20 6 9 17 4 12"></polyline>
                </svg>
                <span style="font-weight: 500; color: #333;">${m.bfield}</span>
            </label>
        `;
        container.appendChild(row);
    });

    // 如果没有任何项目，给个提示
    if (container.children.length === 0) {
        container.innerHTML = '<div style="color: #999; text-align: center; padding: 10px;">未检测到可导入的内容</div>';
    } else if (container.lastElementChild) {
        container.lastElementChild.style.borderBottom = 'none';
    }

    const modal = document.getElementById('npc-import-modal');
    if (modal) modal.className = 'modal-overlay show';
}

function closeNpcImportModal() {
    const modal = document.getElementById('npc-import-modal');
    if (modal) modal.className = 'modal-overlay';
    pendingImportNpcData = null;
}

function confirmNpcImport() {
    if (!pendingImportNpcData) return;
    const data = pendingImportNpcData;
    const defaultAv = "data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='%23d1d1d6'%3E%3Cpath d='M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z'/%3E%3C/svg%3E";

    // Collect selected items from checkboxes
    const selectedKeys = new Set();
    const container = document.getElementById('import-mapping-container');
    if (container) {
        container.querySelectorAll('.import-item-cb:checked').forEach(cb => {
            selectedKeys.add(cb.dataset.key);
        });
    }
    // If no checkboxes found (fallback), import everything
    const hasCheckboxes = container && container.querySelectorAll('.import-item-cb').length > 0;
    const isSelected = (key) => !hasCheckboxes || selectedKeys.has(key);

    const npc = {
        avatar: defaultAv,
        name: data.name || '',
        gender: 'female',
        persona: isSelected('description') ? (data.description || '') : '',
        personality: isSelected('personality') ? (data.personality || '') : '',
        scenario: isSelected('scenario') ? (data.scenario || '') : '',
        first_mes: isSelected('first_mes') ? (data.first_mes || '') : '',
        mes_example: isSelected('mes_example') ? (data.mes_example || '') : '',
        system_prompt: isSelected('system_prompt') ? (data.system_prompt || '') : '',
        post_history_instructions: isSelected('post_history_instructions') ? (data.post_history_instructions || '') : '',
        creator_notes: isSelected('creator_notes') ? (data.creator_notes || '') : '',
        alternate_greetings: (isSelected('alternate_greetings') && data.alternate_greetings && data.alternate_greetings.length > 0) ? data.alternate_greetings : [],
        npcs: [],
        worldbooks: []
    };

    // Import character_book as a world book (only if selected)
    if (isSelected('character_book') && data.character_book && data.character_book.entries && data.character_book.entries.length > 0) {
        const wbBaseName = data.character_book.name || data.name || '导入';
        const wbName = `${wbBaseName}_${Math.floor(Date.now() / 1000)}`;
        const entries = data.character_book.entries.map(e => {
            // Map tavern position to internal position
            let position = 'before_char';
            if (e.position === 'after_char') {
                position = 'after_char';
            } else if (e.extensions && e.extensions.position !== undefined) {
                // SillyTavern extension positions:
                // 0 = before_char, 1 = after_char, 2 = before_example, 3 = after_example
                // 4 = system_d (depth-based), etc.
                const extPos = e.extensions.position;
                if (extPos === 1) position = 'after_char';
                else if (extPos === 4) {
                    const depth = (e.extensions && e.extensions.depth) || 4;
                    position = depth === 0 ? 'system_d0' : 'system_d4';
                }
            }

            return {
                alias: e.comment || '未命名',
                position: position,
                trigger: e.constant ? 'always' : 'keyword',
                keywords: (e.keys || []).join(', '),
                content: e.content || '',
                enabled: e.enabled !== false
            };
        });
        const newWb = { name: wbName, entries: entries };
        worldbooks.push(newWb);
        saveWorldbooksToStorage();
        npc.worldbooks.push(wbName);
    }

    // Import regex_scripts from extensions (only if selected)
    const regexScripts = data.extensions && data.extensions.regex_scripts;
    let regexImported = 0;
    if (isSelected('regex_scripts') && regexScripts && regexScripts.length > 0) {
        regexScripts.forEach(script => {
            if (!script.findRegex) return;

            // Parse the findRegex string — tavern format is "/pattern/flags"
            let patternStr = script.findRegex;
            // Strip surrounding slashes and flags
            const regexMatch = patternStr.match(/^\/(.+)\/([gimsuy]*)$/);
            let pattern = patternStr;
            if (regexMatch) {
                pattern = regexMatch[1];
                // flags are always 'g' in our system
            }

            // Map placement to applyToUser/applyToAI
            // Tavern placement: 1 = user input, 2 = AI output
            const placements = script.placement || [];
            const applyToUser = placements.includes(1);
            const applyToAI = placements.includes(2);

            const rule = {
                name: script.scriptName || `[导入] ${data.name || '角色'}`,
                pattern: pattern,
                replace: script.replaceString || '',
                applyToUser: applyToUser,
                applyToAI: applyToAI,
                enabled: !script.disabled
            };

            // Check for duplicate
            const exists = regexRules.some(r => r.pattern === rule.pattern && r.replace === rule.replace);
            if (!exists) {
                regexRules.push(rule);
                regexImported++;
            }
        });

        if (regexImported > 0) {
            saveRegexRules();
        }
    }

    npcCharacters.push(npc);
    saveNpcsToStorage();

    closeNpcImportModal();
    renderNpcList();

    // Build success message with details
    let successMsg = `角色「${npc.name}」导入成功！`;
    const details = [];
    if (npc.worldbooks.length > 0) details.push('世界书');
    if (regexImported > 0) details.push(`${regexImported}条正则`);
    if (npc.alternate_greetings.length > 0) details.push(`${npc.alternate_greetings.length}个备选开场白`);
    if (details.length > 0) successMsg += `（含${details.join('、')}）`;

    showToast(successMsg);
}

//==============================
// World Book Management
//==============================
let worldbooks = [];
let editingWorldbookIndex = null;

function loadWorldbooks() {
    const stored = localStorage.getItem('faye-phone-worldbooks');
    if (stored) {
        try { worldbooks = JSON.parse(stored); } catch (e) { worldbooks = []; }
    }
}

function saveWorldbooksToStorage() {
    localStorage.setItem('faye-phone-worldbooks', JSON.stringify(worldbooks));
}

function openWorldbookList() {
    if (homeScreen) homeScreen.style.display = 'none';
    const screen = document.getElementById('worldbook-list-screen');
    if (screen) screen.style.display = 'flex';
    updateStatusBar('settings');
    renderWorldbookList();
}

function closeWorldbookList() {
    const screen = document.getElementById('worldbook-list-screen');
    if (screen) screen.style.display = 'none';
    if (homeScreen) homeScreen.style.display = 'flex';
    updateStatusBar('home');
}

function toggleWorldbook(index, isEnabled) {
    if (worldbooks[index]) {
        if (worldbooks[index].enabled === undefined) {
            worldbooks[index].enabled = true;
        }
        worldbooks[index].enabled = isEnabled;
        saveWorldbooks();
    }
}

function renderWorldbookList() {
    const container = document.getElementById('worldbook-list-container');
    if (!container) return;
    container.innerHTML = '';
    if (worldbooks.length === 0) {
        container.innerHTML = '<div style="text-align:center;padding:40px 20px;color:#aaa;font-size:14px;">还没有世界书，点击右上角 + 创建一本吧~</div>';
        return;
    }
    worldbooks.forEach((wb, index) => {
        const card = document.createElement('div');
        card.className = 'user-card';
        const entryCount = (wb.entries || []).length;
        card.innerHTML = `
            <div class="user-card-info" style="flex:1;">
                <div class="user-card-name">${wb.name || '未命名'}</div>
                <div class="user-card-meta">
                    <span>${entryCount} 个条目</span>
                </div>
            </div>
            <label class="wb-entry-switch" style="margin-right: 15px;" onclick="event.stopPropagation()">
                <input type="checkbox" ${wb.enabled !== false ? 'checked' : ''} onchange="toggleWorldbook(${index}, this.checked)">
                <span class="wb-slider"></span>
            </label>
        `;

        let pressTimer = null;
        let isDragging = false;
        card.addEventListener('touchstart', (e) => {
            isDragging = false;
            pressTimer = setTimeout(() => {
                if (!isDragging) showGlobalDeleteMenu(wb.name || '未命名', () => deleteWorldbook(index));
            }, 600);
        }, { passive: true });
        card.addEventListener('touchmove', () => { isDragging = true; clearTimeout(pressTimer); }, { passive: true });
        card.addEventListener('touchend', () => { clearTimeout(pressTimer); });
        card.addEventListener('touchcancel', () => { clearTimeout(pressTimer); });

        card.oncontextmenu = (e) => {
            e.preventDefault();
            showGlobalDeleteMenu(wb.name || '未命名', () => deleteWorldbook(index));
        };
        card.onclick = (e) => {
            openWorldbookEdit(index);
        };

        container.appendChild(card);
    });
}

function openWorldbookEdit(index) {
    editingWorldbookIndex = index;
    const screen = document.getElementById('worldbook-edit-screen');
    const listScreen = document.getElementById('worldbook-list-screen');
    const title = document.getElementById('worldbook-edit-title');
    const nameInput = document.getElementById('worldbook-name-input');
    const entriesContainer = document.getElementById('worldbook-entries-container');

    if (listScreen) listScreen.style.display = 'none';
    if (screen) screen.style.display = 'flex';

    // Clear entries
    if (entriesContainer) entriesContainer.innerHTML = '';

    if (index !== null && worldbooks[index]) {
        const wb = worldbooks[index];
        if (title) title.textContent = '编辑世界书';
        if (nameInput) nameInput.value = wb.name || '';
        if (wb.entries && wb.entries.length > 0) {
            wb.entries.forEach((entry, i) => renderWorldbookEntry(entriesContainer, entry, i));
        }
    } else {
        if (title) title.textContent = '新建世界书';
        if (nameInput) nameInput.value = '';
    }
}

function closeWorldbookEdit() {
    const screen = document.getElementById('worldbook-edit-screen');
    const listScreen = document.getElementById('worldbook-list-screen');
    if (screen) screen.style.display = 'none';
    if (listScreen) listScreen.style.display = 'flex';
    editingWorldbookIndex = null;
    renderWorldbookList();
}

function renderWorldbookEntry(container, entry, index) {
    if (!container) container = document.getElementById('worldbook-entries-container');
    if (!container) return;

    const card = document.createElement('div');
    const isEnabled = entry ? (entry.enabled !== false) : true;
    const isKeyword = entry && entry.trigger === 'keyword';

    card.className = `wb-entry-card ${isEnabled ? '' : 'disabled'}`;
    card.setAttribute('data-enabled', isEnabled);

    card.innerHTML = `
            <div class="wb-entry-header" style="display:flex;align-items:center;">
                <input type="text" class="wb-entry-alias" style="background:transparent;border:none;border-bottom:1px solid #ddd;font-size:14px;color:#333;font-weight:bold;width:120px;padding:2px 0;margin-right:auto;" value="${entry && entry.alias ? entry.alias : '条目 ' + (container.children.length + 1)}" placeholder="条目名称">
                <button class="wb-entry-delete" onclick="this.closest('.wb-entry-card').remove()">×</button>
            </div>

            <div class="wb-entry-field wb-entry-enable-field" style="flex-direction:row;align-items:center;justify-content:space-between;">
                <label style="margin-bottom:0;color:#666;">启用条目</label>
                <label class="wb-entry-switch">
                    <input type="checkbox" class="wb-entry-enable-check" ${isEnabled ? 'checked' : ''}>
                    <span class="wb-slider"></span>
                </label>
            </div>

            <div class="wb-entry-field">
                <label>位置</label>
                <select class="wb-entry-position uc-select">
                    <option value="before_char" ${entry && entry.position === 'before_char' ? 'selected' : ''}>角色定义前</option>
                    <option value="after_char" ${entry && entry.position === 'after_char' ? 'selected' : ''}>角色定义后</option>
                    <option value="system_d0" ${entry && entry.position === 'system_d0' ? 'selected' : ''}>系统D-0</option>
                    <option value="system_d4" ${entry && entry.position === 'system_d4' ? 'selected' : ''}>系统D-4</option>
                </select>
            </div>
            <div class="wb-entry-field">
                <label>触发方式</label>
                <div class="wb-trigger-group">
                    <label class="wb-trigger-option ${!isKeyword ? 'selected' : ''}" data-value="always">
                        <input type="radio" name="wb-trigger-${Date.now()}-${index}" value="always" ${!isKeyword ? 'checked' : ''}> 常驻
                    </label>
                    <label class="wb-trigger-option ${isKeyword ? 'selected' : ''}" data-value="keyword">
                        <input type="radio" name="wb-trigger-${Date.now()}-${index}" value="keyword" ${isKeyword ? 'checked' : ''}> 关键词
                    </label>
                </div>
            </div>
            <div class="wb-entry-field wb-keyword-field" style="display: ${isKeyword ? 'flex' : 'none'};">
                <label>关键词</label>
                <input type="text" class="wb-entry-keyword uc-input" placeholder="多个关键词用逗号分隔" value="${entry && entry.keywords ? entry.keywords : ''}">
            </div>
            <div class="wb-entry-field">
                <label>内容</label>
                <textarea class="wb-entry-content uc-textarea" placeholder="条目内容...">${entry && entry.content ? entry.content : ''}</textarea>
            </div>
        `;

    // Bind trigger toggle
    card.querySelectorAll('.wb-trigger-option').forEach(opt => {
        opt.addEventListener('click', () => {
            card.querySelectorAll('.wb-trigger-option').forEach(o => o.classList.remove('selected'));
            opt.classList.add('selected');
            const radio = opt.querySelector('input[type="radio"]');
            if (radio) radio.checked = true;
            const keywordField = card.querySelector('.wb-keyword-field');
            if (keywordField) {
                keywordField.style.display = radio.value === 'keyword' ? 'flex' : 'none';
            }
        });
    });

    // Bind enable toggle
    const enableCheck = card.querySelector('.wb-entry-enable-check');
    if (enableCheck) {
        enableCheck.addEventListener('change', (e) => {
            const checked = e.target.checked;
            if (checked) {
                card.classList.remove('disabled');
                card.setAttribute('data-enabled', 'true');
            } else {
                card.classList.add('disabled');
                card.setAttribute('data-enabled', 'false');
            }
        });
    }

    container.appendChild(card);
}

function addWorldbookEntry() {
    const container = document.getElementById('worldbook-entries-container');
    renderWorldbookEntry(container, null, container ? container.children.length : 0);
}

function saveWorldBookData() {
    const nameInput = document.getElementById('worldbook-name-input');
    const name = nameInput ? nameInput.value.trim() : '';
    if (!name) {
        showToast('请输入世界书名称');
        return;
    }

    const container = document.getElementById('worldbook-entries-container');
    const entries = [];
    if (container) {
        container.querySelectorAll('.wb-entry-card').forEach(card => {
            const alias = card.querySelector('.wb-entry-alias') ? card.querySelector('.wb-entry-alias').value.trim() : '';
            const position = card.querySelector('.wb-entry-position') ? card.querySelector('.wb-entry-position').value : 'before_char';
            const triggerRadio = card.querySelector('.wb-trigger-option input[type="radio"]:checked');
            const trigger = triggerRadio ? triggerRadio.value : 'always';
            const keywords = card.querySelector('.wb-entry-keyword') ? card.querySelector('.wb-entry-keyword').value.trim() : '';
            const content = card.querySelector('.wb-entry-content') ? card.querySelector('.wb-entry-content').value.trim() : '';
            const enabled = card.getAttribute('data-enabled') !== 'false';

            if (content) {
                entries.push({ alias, position, trigger, keywords, content, enabled });
            }
        });
    }

    const wb = { name, entries };

    if (editingWorldbookIndex !== null && worldbooks[editingWorldbookIndex]) {
        worldbooks[editingWorldbookIndex] = wb;
    } else {
        worldbooks.push(wb);
    }

    saveWorldbooksToStorage();
    showToast('保存成功');
    closeWorldbookEdit();
}

function deleteWorldbook(index) {
    if (!confirm('确定要删除这本世界书吗？')) return;
    worldbooks.splice(index, 1);
    saveWorldbooksToStorage();
    renderWorldbookList();
}

// Override the old stub
function openCharacterSetup(tab) {
    if (tab === 'world') {
        openWorldbookList();
    } else {
        openNpcSettings();
    }
}
function switchSetupTab() { }
function openCharacterEditor() { }
function saveCharacterEditor() { }
function closeCharacterEditor() { }
function saveWorldBook() { saveWorldBookData(); }
function deleteCharacterFromSetup() { }
function handleEditorAvatarChange() { }

//==============================
// User Character Management
//==============================
function loadUsers() {
    const storedUsers = localStorage.getItem('userCharacters');
    if (storedUsers) {
        userCharacters = JSON.parse(storedUsers);
    }
}

function saveUsersToStorage() {
    localStorage.setItem('userCharacters', JSON.stringify(userCharacters));
}

let _userSettingsFrom = 'home'; // Track where user-settings was opened from
function openUserSettings(from) {
    _userSettingsFrom = from || 'home';
    if (homeScreen) homeScreen.style.display = 'none';
    if (settingsScreen) settingsScreen.style.display = 'none';
    const screen = document.getElementById('user-settings-screen');
    if (screen) screen.style.display = 'flex';
    updateStatusBar('settings');
    renderUserList();
}

function renderUserList() {
    const listContainer = document.getElementById('user-list-container');
    if (!listContainer) return;
    listContainer.innerHTML = '';

    const defaultAvatar = "data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='%23d1d1d6'%3E%3Cpath d='M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z'/%3E%3C/svg%3E";

    if (userCharacters.length === 0) {
        listContainer.innerHTML = '<div class="user-list-empty"><div>还没有角色哦~<br>点击右上角 + 创建一个吧</div></div>';
        return;
    }

    userCharacters.forEach((user, index) => {
        const userCard = document.createElement('div');
        userCard.className = 'user-card';
        const genderEmoji = '';
        const npcCount = (user.npcs && user.npcs.length) || 0;
        userCard.innerHTML = `
            <img src="${user.avatar || defaultAvatar}" alt="avatar" class="user-card-avatar">
                <div class="user-card-info">
                    <div class="user-card-name">${genderEmoji} ${user.name}</div>
                    <div class="user-card-meta">
                        <span>${npcCount} 个NPC</span>
                        ${(user.worldbooks && user.worldbooks.length > 0) || user.worldbook ? '<span>有世界书</span>' : ''}
                    </div>
                </div>
        `;
        let pressTimer = null;
        let isDragging = false;
        userCard.addEventListener('touchstart', (e) => {
            isDragging = false;
            pressTimer = setTimeout(() => {
                if (!isDragging) showGlobalDeleteMenu(user.name || '未命名', () => deleteUser(index));
            }, 600);
        }, { passive: true });
        userCard.addEventListener('touchmove', () => { isDragging = true; clearTimeout(pressTimer); }, { passive: true });
        userCard.addEventListener('touchend', () => { clearTimeout(pressTimer); });
        userCard.addEventListener('touchcancel', () => { clearTimeout(pressTimer); });

        userCard.oncontextmenu = (e) => {
            e.preventDefault();
            showGlobalDeleteMenu(user.name || '未命名', () => deleteUser(index));
        };
        userCard.onclick = (e) => {
            editUser(index);
        };
        listContainer.appendChild(userCard);
    });
}

function openUserCreatePage(index = null) {
    editingUserIndex = index;
    const screen = document.getElementById('user-create-screen');
    const titleEl = document.getElementById('user-create-title');
    const avatarPreview = document.getElementById('user-avatar-preview');
    const nameInput = document.getElementById('user-name-input');
    const descInput = document.getElementById('user-desc-input');
    const npcList = document.getElementById('user-npc-list');
    // Removed worldbookSelect reference
    if (!screen) return;

    // Reset gender selection
    document.querySelectorAll('.uc-gender-option').forEach(opt => opt.classList.remove('selected'));

    const defaultAv = "data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='%23d1d1d6'%3E%3Cpath d='M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z'/%3E%3C/svg%3E";

    if (index !== null && userCharacters[index]) {
        const user = userCharacters[index];
        if (titleEl) titleEl.textContent = '编辑角色';
        if (avatarPreview) avatarPreview.src = user.avatar || defaultAv;
        if (nameInput) nameInput.value = user.name || '';
        if (descInput) descInput.value = user.persona || user.desc || '';
        const gender = user.gender || 'female';
        const genderRadio = document.querySelector(`input[name = "user-gender"][value = "${gender}"]`);
        if (genderRadio) {
            genderRadio.checked = true;
            const label = genderRadio.closest('.uc-gender-option');
            if (label) label.classList.add('selected');
        }
        // Multi-select init handled later
        if (npcList) {
            npcList.innerHTML = '';
            if (user.npcs && user.npcs.length > 0) {
                user.npcs.forEach((npc, npcIdx) => renderNpcCard(npcList, npc, npcIdx));
            }
        }
    } else {
        if (titleEl) titleEl.textContent = '创建角色';
        if (avatarPreview) avatarPreview.src = defaultAv;
        if (nameInput) nameInput.value = '';
        if (descInput) descInput.value = '';
    }

    // Initialize Worldbook Multi-select
    let initialWbs = [];
    if (index !== null && userCharacters[index]) {
        const u = userCharacters[index];
        if (u.worldbooks) initialWbs = u.worldbooks;
        else if (u.worldbook) initialWbs = [u.worldbook];
    }
    renderWorldbookMultiSelect('user-worldbook-select', initialWbs);

    updateUserTokenCount();

    const settingsScreen = document.getElementById('user-settings-screen');
    if (settingsScreen) settingsScreen.style.display = 'none';
    screen.style.display = 'flex';
    updateStatusBar('settings');
}

function closeUserCreatePage() {
    const screen = document.getElementById('user-create-screen');
    if (screen) screen.style.display = 'none';
    const settingsScreen = document.getElementById('user-settings-screen');
    if (settingsScreen) settingsScreen.style.display = 'flex';
    editingUserIndex = null;
}

// Kept for backward compatibility
function openUserCreateModal(index) { openUserCreatePage(index); }
function closeUserCreateModal() { closeUserCreatePage(); }

// populateWorldbookSelect removed - replaced by renderWorldbookMultiSelect

function estimateTokens(text) {
    if (!text) return 0;
    let count = 0;
    for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        if (code > 0x4e00 && code < 0x9fff) count += 1.5;
        else if (code > 0x20 && code < 0x7f) count += 0.3;
        else count += 1;
    }
    return Math.round(count);
}

function updateUserTokenCount() {
    const descInput = document.getElementById('user-desc-input');
    const tokenEl = document.getElementById('user-desc-token');
    if (!descInput || !tokenEl) return;
    let totalTokens = estimateTokens(descInput.value);

    document.querySelectorAll('#user-npc-list .uc-npc-card').forEach(card => {
        const nameVal = (card.querySelector('.npc-name-input') || {}).value || '';
        const descVal = (card.querySelector('.npc-desc-input') || {}).value || '';
        totalTokens += estimateTokens(nameVal) + estimateTokens(descVal);
    });

    tokenEl.textContent = totalTokens + ' tokens';
}

function saveUser() {
    const avatar = document.getElementById('user-avatar-preview').src;
    const name = (document.getElementById('user-name-input').value || '').trim();
    const desc = document.getElementById('user-desc-input').value || '';

    // Collect Multi-select Worldbooks
    const worldbooks = [];
    const wbContainer = document.getElementById('user-worldbook-select');
    if (wbContainer) {
        wbContainer.querySelectorAll('input[type="checkbox"]:checked').forEach(cb => {
            worldbooks.push(cb.value);
        });
    }

    if (!name) { alert('请输入角色昵称~'); return; }
    const genderRadio = document.querySelector('input[name="user-gender"]:checked');
    const gender = genderRadio ? genderRadio.value : 'female';
    const npcs = [];
    document.querySelectorAll('#user-npc-list .uc-npc-card').forEach(card => {
        const npcName = (card.querySelector('.npc-name-input') || {}).value || '';
        const npcGenderRadio = card.querySelector('input[name^="npc-gender-"]:checked');
        const npcGender = npcGenderRadio ? npcGenderRadio.value : 'female';
        const npcDesc = (card.querySelector('.npc-desc-input') || {}).value || '';
        if (npcName.trim()) npcs.push({ name: npcName.trim(), gender: npcGender, desc: npcDesc.trim() });
    });
    const user = { avatar, name, gender, persona: desc, worldbooks, npcs };
    if (editingUserIndex !== null) { userCharacters[editingUserIndex] = user; }
    else { userCharacters.push(user); }
    saveUsersToStorage();
    closeUserCreatePage();
    renderUserList();
}

function editUser(index) { openUserCreatePage(index); }

function deleteUser(index) {
    if (confirm('确定要删除角色 "' + userCharacters[index].name + '" 吗？')) {
        userCharacters.splice(index, 1);
        saveUsersToStorage();
        renderUserList();
    }
}

function handleUserAvatarChange(event) {
    const file = event.target.files[0];
    if (file) {
        currentSettingsUploadType = 'user-create-avatar';
        openCropper(file);
        // Reset input so same file can be selected again
        event.target.value = '';
    }
}

function addNpcToUser() {
    const npcList = document.getElementById('user-npc-list');
    if (!npcList) return;
    renderNpcCard(npcList, null, npcList.children.length);
}

function renderNpcCard(container, npc, index) {
    const card = document.createElement('div');
    card.className = 'uc-npc-card';
    const uid = 'npc-gender-' + Date.now() + '-' + index;
    const isFemale = !npc || npc.gender === 'female';
    const isMale = npc && npc.gender === 'male';
    card.innerHTML = `
            <button class="npc-remove-btn" onclick="const p=this.closest('.uc-npc-card'); p.parentElement.removeChild(p); updateNpcTokenCount(); updateUserTokenCount();">×</button>
        <div class="npc-row">
            <div class="npc-field"><label>姓名</label><input type="text" class="npc-name-input" placeholder="NPC名字" value="${npc ? npc.name : ''}" oninput="updateNpcTokenCount(); updateUserTokenCount();"></div>
        </div>
        <div class="npc-field"><label>性别</label>
            <div class="npc-gender-mini">
                <label class="${isFemale ? 'selected' : ''}" data-value="female"><input type="radio" name="${uid}" value="female" ${isFemale ? 'checked' : ''}> 女</label>
                <label class="${isMale ? 'selected' : ''}" data-value="male"><input type="radio" name="${uid}" value="male" ${isMale ? 'checked' : ''}> 男</label>
            </div>
        </div>
        <div class="npc-field"><label>简单人设</label><textarea class="npc-desc-input" placeholder="简单描述这个NPC..." oninput="updateNpcTokenCount(); updateUserTokenCount();">${npc ? (npc.desc || '') : ''}</textarea></div>
        `;
    card.querySelectorAll('.npc-gender-mini label').forEach(label => {
        label.addEventListener('click', () => {
            card.querySelectorAll('.npc-gender-mini label').forEach(l => l.classList.remove('selected'));
            label.classList.add('selected');
            const radio = label.querySelector('input[type="radio"]');
            if (radio) radio.checked = true;
        });
    });
    container.appendChild(card);
}

async function init() {
    // Initialize IndexedDB for chat history storage
    try {
        await initChatDB();
        await migrateFromLocalStorage();
    } catch (e) {
        console.error('[Init] ChatDB initialization failed:', e);
    }

    // Initialize references
    phoneContainer = document.getElementById('phone-container');
    homeScreen = document.getElementById('home-screen');
    chatScreen = document.getElementById('chat-screen');
    settingsScreen = document.getElementById('settings-screen');
    messageListScreen = document.getElementById('message-list-screen');
    messageListBody = document.getElementById('message-list-body');
    chatMessages = document.getElementById('chat-messages');
    messageInput = document.getElementById('message-input');
    sendButton = document.getElementById('send-button');
    // Prevent keyboard from closing on mobile
    sendButton.addEventListener('mousedown', function (e) { e.preventDefault(); });
    plusButton = document.getElementById('plus-button');
    emojiButton = document.getElementById('emoji-button');
    actionMenu = document.getElementById('action-menu');
    emojiMenu = document.getElementById('emoji-menu');
    modal = document.getElementById('input-modal');
    modalTitle = document.getElementById('modal-title');
    modalInputsContainer = document.getElementById('modal-inputs-container');
    modalConfirmBtn = document.getElementById('modal-confirm-btn');
    chatSettingsScreen = document.getElementById('chat-settings-screen');
    headerTitle = document.getElementById('header-title');
    clockEl = document.getElementById('clock');
    lockClockEl = document.getElementById('lock-clock');
    lockScreen = document.getElementById('lock-screen');
    statusBar = document.getElementById('status-bar');
    photoInput = document.getElementById('photo-upload-input');
    // New References
    audioInput = document.getElementById('audio-upload-input');
    videoInput = document.getElementById('video-upload-input');
    mediaPreviewBar = document.getElementById('media-preview-bar');
    previewImage = document.getElementById('preview-image');
    previewFileIcon = document.getElementById('preview-file-icon');
    addContactModal = document.getElementById('add-contact-modal');
    userSettingsScreen = document.getElementById('user-settings-screen');
    userCreateModal = document.getElementById('user-create-modal');

    // Bind Events
    // 图片上传
    if (photoInput) photoInput.addEventListener('change', async (e) => {
        if (e.target.files && e.target.files[0]) {
            handleFileSelect(e.target.files[0]);
            e.target.value = ''; // Reset for re-selection
            closeMenus(); // Close action menu
        }
    });

    // 音频上传
    if (audioInput) audioInput.addEventListener('change', async (e) => {
        if (e.target.files && e.target.files[0]) {
            handleFileSelect(e.target.files[0]);
            e.target.value = '';
            closeMenus();
        }
    });

    // 视频上传
    if (videoInput) videoInput.addEventListener('change', async (e) => {
        if (e.target.files && e.target.files[0]) {
            handleFileSelect(e.target.files[0]);
            e.target.value = '';
            closeMenus();
        }
    });

    // 设置页面文件上传
    const settingsFileInput = document.getElementById('settings-file-input');
    if (settingsFileInput) {
        settingsFileInput.addEventListener('change', (e) => {
            if (e.target.files && e.target.files[0]) {
                // 打开裁剪器，而不是直接上传
                openCropper(e.target.files[0]);
            }
        });
    }
    const userAvatarInput = document.getElementById('user-avatar-input');
    if (userAvatarInput) userAvatarInput.addEventListener('change', handleUserAvatarChange);

    const npcAvatarInput = document.getElementById('npc-avatar-input');
    if (npcAvatarInput) npcAvatarInput.addEventListener('change', handleNpcAvatarChange);

    // Gender option toggle for NPC and User create pages
    document.querySelectorAll('.uc-gender-option').forEach(label => {
        label.addEventListener('click', () => {
            const group = label.closest('.uc-gender-group');
            if (group) {
                group.querySelectorAll('.uc-gender-option').forEach(l => l.classList.remove('selected'));
            }
            label.classList.add('selected');
            const radio = label.querySelector('input[type="radio"]');
            if (radio) radio.checked = true;
        });
    });

    // NPC desc token count
    const npcDescInput = document.getElementById('npc-desc-input-page');
    if (npcDescInput) npcDescInput.addEventListener('input', updateNpcTokenCount);

    if (plusButton) plusButton.addEventListener('click', () => {
        if (actionMenu.classList.contains('open')) closeMenus();
        else { closeMenus(); actionMenu.classList.add('open'); plusButton.classList.add('active'); clearDeleteButton(); setTimeout(() => chatMessages.scrollTop = chatMessages.scrollHeight, 300); }
    });
    if (emojiButton) emojiButton.addEventListener('click', () => {
        if (emojiMenu.classList.contains('open')) closeMenus();
        else { closeMenus(); emojiMenu.classList.add('open'); setTimeout(() => chatMessages.scrollTop = chatMessages.scrollHeight, 300); }
    });
    if (messageInput) {
        messageInput.addEventListener('focus', closeMenus);
        messageInput.oninput = adjustTextareaHeight;
        messageInput.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } };
    }
    if (sendButton) sendButton.onclick = sendMessage;
    if (modalConfirmBtn) modalConfirmBtn.onclick = (e) => {
        if (e) e.preventDefault();
        if (currentConfirmAction) {
            const inputs = modalInputsContainer.querySelectorAll('input, textarea');
            const values = Array.from(inputs).map(i => {
                if (i.type === 'file') return i.files[0];
                return i.value.trim();
            });
            if (values.some(v => v)) {
                currentConfirmAction(values);
                // Only remove the 'show' class from the input modal, explicitly do not call closeModal
                if (modal) modal.classList.remove('show');
                currentConfirmAction = null; // Clean up immediately after execution
            } else {
                console.log('[FayePhone] No values detected');
            }
        }
    };

    loadSettings();
    loadUsers();
    loadNpcData();
    loadWorldbooks();
    window.loadGridLayout();

    // Lock screen events
    if (lockScreen) {
        lockScreen.style.touchAction = 'none'; // Prevent browser default vertical scroll
        let startY = 0;
        let isDown = false;

        const handleStart = (y, target) => {
            if (target.closest('#lock-keypad-container')) return;
            isDown = true;
            startY = y;
        };

        const handleEnd = (y) => {
            if (!isDown) return;
            isDown = false;
            if (startY - y > 30) { // Reduced threshold for better sensitivity
                showLockKeypad();
            }
            startY = 0;
        };

        // Touch events for mobile
        lockScreen.addEventListener('touchstart', (e) => handleStart(e.touches[0].clientY, e.target), { passive: true });
        lockScreen.addEventListener('touchend', (e) => handleEnd(e.changedTouches[0].clientY));

        // Mouse/pointer events for desktop
        lockScreen.addEventListener('mousedown', (e) => handleStart(e.clientY, e.target));
        lockScreen.addEventListener('mouseup', (e) => handleEnd(e.clientY));

        // Also mapping wheel for desktop usability
        lockScreen.addEventListener('wheel', (e) => {
            if (e.deltaY > 30) showLockKeypad();
        });
    }

    const savedStickers = localStorage.getItem('st-phone-stickers');
    myStickerList = savedStickers ? JSON.parse(savedStickers) : defaultStickerList;
    const defaultAvatar = "data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='%23cccccc'%3E%3Cpath d='M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z'/%3E%3C/svg%3E";
    if (!appSettings.charAvatar) appSettings.charAvatar = defaultAvatar;
    if (!appSettings.userAvatar) appSettings.userAvatar = defaultAvatar;
    applySettings();
    // Character-specific logic removed for standalone version
    updateClock();
    initStickers();
    setInterval(updateClock, 1000);
    // DEPRECATED: Character change check removed for standalone version
    // Auto-restore removed: always start from home screen on refresh

    // try { loadInitialChat(); setTimeout(loadInitialChat, 500); } catch (e) { }
    checkUpdate(); // Check for updates
    initKeepAlive(); // Start background keep-alive if enabled
}

// Attach globally
window.openChat = openChat;
window.openMessageList = openMessageList;
window.switchNavTab = switchNavTab;
window.goBack = goBack;
window.openSettings = openSettings;
window.closeSettings = closeSettings;
window.saveApiSettings = saveApiSettings;
window.openBeautifySettings = openBeautifySettings;
window.closeBeautifySettings = closeBeautifySettings;
window.saveBeautifySettings = saveBeautifySettings;
window.openChatSettings = openChatSettings;
window.saveHomeSettings = saveBeautifySettings;
window.saveChatSettings = saveChatSettings;
window.saveChatHideNameAuto = saveChatHideNameAuto;
window.saveChatGroupSyncAuto = saveChatGroupSyncAuto;
window.saveChatPomoMemorySyncAuto = saveChatPomoMemorySyncAuto;
window.handleAction = handleAction;
window.closeModal = closeModal;
window.triggerSettingsUpload = triggerSettingsUpload;
// DEPRECATED: Dark Web and Diary features removed
window.openAddContactModal = openAddContactModal;
window.closeAddContactModal = closeAddContactModal;
window.switchContactTab = switchContactTab;
window.renderGroupInputs = renderGroupInputs;
window.addGroupNpcSelect = addGroupNpcSelect;
window.confirmAddContact = confirmAddContact;
window.closeChatSettings = closeChatSettings;
window.deleteCurrentChat = deleteCurrentChat;
window.openCropper = openCropper;
window.closeCropper = closeCropper;
window.confirmCrop = confirmCrop;
window.closeUpdateModal = closeUpdateModal;
window.clearPreview = clearPreview;
window.openUserSettings = openUserSettings;
window.openUserCreatePage = openUserCreatePage;
window.closeUserCreatePage = closeUserCreatePage;
window.saveUser = saveUser;
window.editUser = editUser;
window.deleteUser = deleteUser;
window.addNpcToUser = addNpcToUser;
window.openNpcSettings = openNpcSettings;
window.openNpcCreatePage = openNpcCreatePage;
window.closeNpcCreatePage = closeNpcCreatePage;
window.saveNpc = saveNpc;
window.editNpc = editNpc;
window.deleteNpc = deleteNpc;
window.addSubNpcToNpc = addSubNpcToNpc;
window.openCharacterSetup = openCharacterSetup;
window.handleNpcImportChange = handleNpcImportChange;
window.closeNpcImportModal = closeNpcImportModal;
window.confirmNpcImport = confirmNpcImport;
window.openWorldbookList = openWorldbookList;
window.closeWorldbookList = closeWorldbookList;
window.openWorldbookEdit = openWorldbookEdit;
window.closeWorldbookEdit = closeWorldbookEdit;
window.saveWorldBookData = saveWorldBookData;
window.deleteWorldbook = deleteWorldbook;
window.addWorldbookEntry = addWorldbookEntry;
window.toggleCharTimezone = toggleCharTimezone;
window.updateCharTimePreview = updateCharTimePreview;
window.openDataSettings = openDataSettings;
window.renderContacts = renderContacts;
window.openNewFriends = openNewFriends;
window.openGroupsList = openGroupsList;
window.showFriendRequestsModal = showFriendRequestsModal;
window.showGroupsListModal = showGroupsListModal;
window.acceptFriendRequest = acceptFriendRequest;
window.rejectFriendRequest = rejectFriendRequest;
window.closeDataSettings = closeDataSettings;
window.saveDataSettings = saveDataSettings;
// NAI Settings
window.openNaiSettings = openNaiSettings;
window.closeNaiSettings = closeNaiSettings;
window.saveNaiSettings = saveNaiSettings;
window.applyNaiSizePreset = applyNaiSizePreset;
// Toy Control Settings
window.openToySettings = openToySettings;
window.closeToySettings = closeToySettings;
window.saveToySettings = saveToySettings;
window.saveChatToyModeAuto = saveChatToyModeAuto;
window.toyConnect = toyConnect;
window.toyDisconnect = toyDisconnect;
window.toyScanDevices = toyScanDevices;
// Memory Summary System
window.summarizeChatMemory = summarizeChatMemory;
window.summarizeFullMemory = summarizeFullMemory;
window.addMemoryManual = addMemoryManual;
window.clearAllMemories = clearAllMemories;
window.saveMemoryEntry = saveMemoryEntry;
window.closeMemoryEditModal = closeMemoryEditModal;
window.saveMemorySettings = saveMemorySettings;
window.openTokenStatsModal = openTokenStatsModal;
window.closeTokenStatsModal = closeTokenStatsModal;
window.toggleMemoryBatchMode = toggleMemoryBatchMode;
window.deleteSelectedMemories = deleteSelectedMemories;
// API Presets
window.populateApiPresetList = populateApiPresetList;
window.applyApiPreset = applyApiPreset;
window.saveApiPreset = saveApiPreset;
// Background Keep-Alive
window.toggleKeepAlive = toggleKeepAlive;
window.initKeepAlive = initKeepAlive;

// Initialize on Load
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { init().then(() => setScreenDisplay('lock-screen')); });
} else {
    init().then(() => setScreenDisplay('lock-screen'));
}

function setScreenDisplay(screenId = 'lock-screen') {
    // Hide all screens first
    if (lockScreen) lockScreen.style.display = 'none';
    if (homeScreen) homeScreen.style.display = 'none';
    if (chatScreen) chatScreen.style.display = 'none';
    if (settingsScreen) settingsScreen.style.display = 'none';
    if (messageListScreen) messageListScreen.style.display = 'none';
    if (chatSettingsScreen) chatSettingsScreen.style.display = 'none';
    if (userSettingsScreen) userSettingsScreen.style.display = 'none';
    const beautifyScreen = document.getElementById('beautify-screen');
    if (beautifyScreen) beautifyScreen.style.display = 'none';
    const apiSettingsScreen = document.getElementById('api-settings-screen');
    if (apiSettingsScreen) apiSettingsScreen.style.display = 'none';
    const dataSettingsScreen = document.getElementById('data-settings-screen');
    if (dataSettingsScreen) dataSettingsScreen.style.display = 'none';
    const chatTimeSettingsScreen = document.getElementById('chat-time-settings-screen');
    if (chatTimeSettingsScreen) chatTimeSettingsScreen.style.display = 'none';
    const calendarScreen = document.getElementById('calendar-screen');
    if (calendarScreen) calendarScreen.style.display = 'none';
    if (document.getElementById('call-screen')) document.getElementById('call-screen').style.display = 'none';
    const naiSettingsScreen = document.getElementById('nai-settings-screen');
    if (naiSettingsScreen) naiSettingsScreen.style.display = 'none';
    const toySettingsScreen = document.getElementById('toy-settings-screen');
    if (toySettingsScreen) toySettingsScreen.style.display = 'none';
    const musicScreen = document.getElementById('music-screen');
    if (musicScreen) musicScreen.style.display = 'none';
    const pomodoroScreen = document.getElementById('pomodoro-screen');
    if (pomodoroScreen) pomodoroScreen.style.display = 'none';

    // Show the requested screen
    const screenToShow = document.getElementById(screenId);
    if (screenToShow) {
        screenToShow.style.display = 'flex';
    }

    updateStatusBar(screenId);
}


// ====== Voice Call System (Refactored) ======
let isCalling = false;
let callTimerInterval = null;
let callSeconds = 0;
let callConnectionTimeout = null;
let callConversation = []; // In-call dialogue history for LLM context
let callAbortController = null; // For aborting in-flight LLM requests

// --- Build LLM messages for voice call context ---
async function buildCallMessages(extraUserMsg) {
    const charName = getCharName();
    const userName = getUserName();
    const charContext = buildCharacterContext();

    const systemPrompt = `${charContext ? charContext + '\n\n' : ''}[系统指令 - 语音通话模式]
你正在与 ${userName} 进行实时语音通话。

回复规则：
1. 以语音通话的口吻回复，简短、口语化，像真人打电话一样自然。
2. 直接输出角色说的话，不要带任何格式头（如 [名字|时间] 等）。
3. 禁止输出动作描写、心声、旁白。只能输出语音内容。
4. 声音描写（如笑声、叹气、停顿等）用括号包裹，如：（笑）、（叹气）、（沉默了一会儿）。
5. 每次回复只需要1-3句话，保持简短。
6. 你的回复将直接显示在通话界面的字幕中。`;

    const messages = [{ role: 'system', content: systemPrompt }];

    // Inject recent chat history context (so AI remembers what happened before call)
    if (currentChatTag) {
        try {
            const history = await getChatHistory(currentChatTag);
            if (history && history.length > 0) {
                const recent = history;
                recent.forEach(msg => {
                    const role = (msg.header && msg.header.includes(getUserName())) || msg.isUser ? 'user' : 'assistant';
                    let content = msg.body || '';
                    // Strip internal tags
                    content = content.replace(/<blocked>/g, '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
                    if (content) {
                        messages.push({ role: role, content: content });
                    }
                });
            }
        } catch (e) { }
    }

    // Add call conversation history
    callConversation.forEach(entry => {
        messages.push({ role: entry.role, content: entry.content });
    });

    // Add the extra user message if provided
    if (extraUserMsg) {
        messages.push({ role: 'user', content: extraUserMsg });
    }

    return messages;
}

// --- Stream LLM response for voice call ---
async function callLLMForCall(userMsg, options = {}) {
    if (!appSettings.apiEndpoint) {
        console.log('[VoiceCall] API not configured, using fallback');
        return null; // Signal caller to use fallback
    }

    const { onConnect, onReject } = options;

    // Record user message in call conversation
    if (userMsg) {
        callConversation.push({ role: 'user', content: userMsg });
    }

    const messages = await buildCallMessages(null); // Already added to callConversation

    try {
        callAbortController = new AbortController();

        const endpoint = appSettings.apiEndpoint.replace(/\/$/, '');
        const key = appSettings.apiKey;
        const model = appSettings.apiModel;

        const headers = { 'Content-Type': 'application/json' };
        if (key) headers['Authorization'] = `Bearer ${key}`;

        const res = await fetch(`${endpoint}/chat/completions`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                model: model,
                messages: messages,
                temperature: appSettings.apiTemperature !== undefined ? appSettings.apiTemperature : 1.0,
                stream: true
            }),
            signal: callAbortController.signal
        });

        if (!res.ok) {
            const txt = await res.text();
            throw new Error(`API Error ${res.status}: ${txt}`);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();

        let rawOutput = '';
        let streamBuffer = '';
        let isThinking = false;
        let connected = false;
        let bubble = null; // Lazy creation: only create when we have visible content

        while (true) {
            if (!isCalling) break; // Call ended during streaming

            const { done, value } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value, { stream: true });
            streamBuffer += chunk;
            const lines = streamBuffer.split('\n');
            streamBuffer = lines.pop();

            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                const dataStr = line.slice(6);
                if (dataStr === '[DONE]') continue;

                try {
                    const data = JSON.parse(dataStr);
                    const delta = data.choices[0].delta;

                    // Skip reasoning_content (DeepSeek R1)
                    if (delta.reasoning_content) continue;

                    if (delta.content) {
                        let content = delta.content;

                        // Handle <think> tags
                        if (isThinking) {
                            const endIdx = content.indexOf('</think>');
                            if (endIdx !== -1) {
                                content = content.substring(endIdx + 8);
                                isThinking = false;
                            } else {
                                continue;
                            }
                        }

                        const thinkStart = content.indexOf('<think>');
                        if (thinkStart !== -1) {
                            const before = content.substring(0, thinkStart);
                            rawOutput += before;
                            const afterThink = content.substring(thinkStart + 7);
                            const thinkEnd = afterThink.indexOf('</think>');
                            if (thinkEnd !== -1) {
                                rawOutput += afterThink.substring(thinkEnd + 8);
                            } else {
                                isThinking = true;
                            }
                        } else {
                            rawOutput += content;
                        }

                        // Only create bubble when we have actual visible content
                        const trimmed = rawOutput.trim();
                        if (trimmed && !bubble) {
                            hideCallTyping();
                            bubble = addCallBubble('', false);
                        }
                        if (bubble && trimmed) {
                            bubble.textContent = trimmed;
                            const container = document.getElementById('call-chat-container');
                            if (container) container.scrollTop = container.scrollHeight;
                        }

                        // Check for reject/accept keywords during dialing phase
                        if (!connected && onConnect) {
                            const lowerOutput = rawOutput.toLowerCase();
                            if (lowerOutput.includes('拒接通话') || lowerOutput.includes('拒绝通话') || lowerOutput.includes('挂断')) {
                                if (onReject) onReject();
                                // Still let stream finish to display response
                            } else if (rawOutput.length > 2 && !lowerOutput.includes('拒接') && !lowerOutput.includes('拒绝')) {
                                // AI responded without rejecting = accepted
                                connected = true;
                                onConnect();
                            }
                        }
                    }
                } catch (e) { /* parse error, skip */ }
            }
        }

        // Clean the final output (Enhanced Regex)
        rawOutput = rawOutput.replace(/<(think|thinking)[\s\S]*?<\/(think|thinking)>/gi, '').trim();

        // Ensure typing indicator is hidden
        hideCallTyping();

        // Handle bubble display
        if (!bubble) {
            // Bubble was never created (all output was thinking/empty)
            if (rawOutput) {
                bubble = addCallBubble(rawOutput, false);
            } else {
                bubble = addCallBubble('...', false);
            }
        } else if (!rawOutput) {
            bubble.textContent = '...';
        } else {
            bubble.textContent = rawOutput;
        }

        // Record AI response in call conversation
        if (rawOutput) {
            callConversation.push({ role: 'assistant', content: rawOutput });
        }

        return rawOutput;
    } catch (e) {
        if (e.name === 'AbortError') {
            console.log('[VoiceCall] Request aborted');
            return null;
        }
        console.error('[VoiceCall] LLM call failed:', e);
        hideCallTyping();
        addCallBubble(`(连接失败: ${e.message})`, false);
        return null;
    }
}

// --- Connect the call (start timer, update UI) ---
function connectVoiceCall() {
    if (!isCalling) return;

    const timerEl = document.getElementById('call-timer');
    const textEl = document.getElementById('call-char-text');

    if (timerEl) {
        timerEl.textContent = '00:00';
        timerEl.style.opacity = '1';
    }
    if (textEl) {
        textEl.textContent = '对方已接听';
        textEl.style.fontSize = '12px';
        textEl.style.opacity = '0.8';
    }

    // Start Timer
    callSeconds = 0;
    if (callTimerInterval) clearInterval(callTimerInterval);
    callTimerInterval = setInterval(() => {
        callSeconds++;
        const m = Math.floor(callSeconds / 60).toString().padStart(2, '0');
        const s = (callSeconds % 60).toString().padStart(2, '0');
        if (timerEl) timerEl.textContent = `${m}:${s}`;
    }, 1000);
}

// --- Start a voice call ---
function startVoiceCall(isIncoming = false) {
    closeMenus();
    const callScreen = document.getElementById('call-screen');
    const nameEl = document.getElementById('call-name');
    const avatarEl = document.getElementById('call-avatar');
    const textEl = document.getElementById('call-char-text');
    const timerEl = document.getElementById('call-timer');

    if (!callScreen) return;

    // Reset state
    callConversation = [];
    if (callAbortController) { try { callAbortController.abort(); } catch (e) { } }
    callAbortController = null;

    const targetName = getCharName();
    if (nameEl) nameEl.textContent = targetName;

    let avatarSrc = appSettings.charAvatar;
    if (appSettings.memberAvatars && appSettings.memberAvatars[targetName]) {
        avatarSrc = appSettings.memberAvatars[targetName];
    }
    if (avatarEl) avatarEl.src = avatarSrc;

    // Clear Call Chat Container
    const callChatContainer = document.getElementById('call-chat-container');
    if (callChatContainer) callChatContainer.innerHTML = '';

    // Show Screen
    callScreen.style.display = 'flex';
    isCalling = true;
    callSeconds = 0;

    // Clear previous timers
    if (callTimerInterval) clearInterval(callTimerInterval);
    if (callConnectionTimeout) clearTimeout(callConnectionTimeout);

    if (isIncoming) {
        // === Incoming Call: directly connected ===
        connectVoiceCall();
        if (textEl) textEl.textContent = '通话中';

        // Record incoming call acceptance
        const t = getTime();
        const u = getUserName();
        renderMessageToUI({ header: `[${u}| 通话 | ${t}]`, body: '接通了电话', isUser: true });

        showCallTyping();

        // Trigger AI greeting
        const greetMsg = `${getUserName()} 接听了你的电话。请开始说话，打招呼。`;
        callLLMForCall(greetMsg).then(result => {
            if (!result && isCalling) {
                // Fallback if no API
                hideCallTyping();
                addCallBubble('喂？你好~', false);
                callConversation.push({ role: 'assistant', content: '喂？你好~' });
            }
        });
    } else {
        // === Outgoing Call: dialing ===
        // Record dialing action
        const t = getTime();
        const u = getUserName();
        renderMessageToUI({ header: `[${u}| 通话 | ${t}]`, body: '正在拨打语音电话...', isUser: true });

        if (timerEl) {
            timerEl.innerHTML = '等待接听<span class="jumping-dot">.</span><span class="jumping-dot">.</span><span class="jumping-dot">.</span>';
            timerEl.style.opacity = '0.8';
        }
        if (textEl) {
            textEl.textContent = '';
        }

        showCallTyping();

        const dialMsg = `${getUserName()} 正在给你打电话（你听到了来电铃声）。请根据剧情决定接听或拒接。`;

        callLLMForCall(dialMsg, {
            onConnect: () => {
                connectVoiceCall();
                const t = getTime();
                const cn = getCharName();
                renderMessageToUI({ header: `[${cn}| 通话 | ${t}]`, body: '接听了电话', isUser: false });
                if (textEl) textEl.textContent = '通话中';
            },
            onReject: () => {
                // AI rejected the call
                setTimeout(() => {
                    if (isCalling) endVoiceCall('rejected');
                }, 1500);
            }
        }).then(result => {
            if (!result && isCalling) {
                // Fallback: no API, auto-connect after delay
                callConnectionTimeout = setTimeout(() => {
                    if (!isCalling) return;
                    connectVoiceCall();
                    if (textEl) textEl.textContent = '通话中';
                    hideCallTyping();
                    addCallBubble('喂？', false);
                    callConversation.push({ role: 'assistant', content: '喂？' });
                }, 2000);
            }
        });
    }

    updateStatusBar('dark-search');
}

// --- Add a chat bubble in the call screen ---
function addCallBubble(text, isUser) {
    const container = document.getElementById('call-chat-container');
    if (!container) return null;

    const bubble = document.createElement('div');
    bubble.className = `call-bubble ${isUser ? 'sent' : 'received'}`;
    bubble.textContent = text;

    container.appendChild(bubble);
    container.scrollTop = container.scrollHeight;
    return bubble;
}

// --- Show/hide typing indicator in call ---
function showCallTyping() {
    const container = document.getElementById('call-chat-container');
    if (!container) return;
    hideCallTyping();

    const bubble = document.createElement('div');
    bubble.id = 'call-typing-indicator';
    bubble.className = 'call-bubble received';
    bubble.innerHTML = '<span class="jumping-dot">.</span><span class="jumping-dot">.</span><span class="jumping-dot">.</span>';

    container.appendChild(bubble);
    container.scrollTop = container.scrollHeight;
}

function hideCallTyping() {
    const el = document.getElementById('call-typing-indicator');
    if (el) el.remove();
}

// --- End the voice call ---
function endVoiceCall(reason) {
    const callScreen = document.getElementById('call-screen');
    if (callScreen) callScreen.style.display = 'none';

    isCalling = false;
    if (callTimerInterval) clearInterval(callTimerInterval);
    if (callConnectionTimeout) clearTimeout(callConnectionTimeout);

    // Abort any in-flight LLM request
    if (callAbortController) { try { callAbortController.abort(); } catch (e) { } }
    callAbortController = null;

    const t = getTime();
    const u = getUserName();
    const cn = getCharName();

    // Save each call conversation message to chat history
    callConversation.forEach(entry => {
        if (!entry.content || entry.content === '...') return;
        if (entry.role === 'user') {
            // Skip system-style prompts (e.g. "XXX 接听了你的电话")
            if (entry.content.includes('正在给你打电话') || entry.content.includes('接听了你的电话')) return;
            if (entry.content === '（对方沉默了一会儿）') return;
            renderMessageToUI({ header: `[${u}| 通话 | ${t}]`, body: entry.content, isUser: true });
        } else {
            renderMessageToUI({ header: `[${cn}| 通话 | ${t}]`, body: entry.content, isUser: false });
        }
    });

    // Build call summary message
    if (reason === 'rejected') {
        renderMessageToUI({ header: `[${cn}| 通话 | ${t}]`, body: "拒绝了通话", isUser: false });
    } else if (callSeconds > 0) {
        const m = Math.floor(callSeconds / 60).toString().padStart(2, '0');
        const s = (callSeconds % 60).toString().padStart(2, '0');
        renderMessageToUI({ header: `[${u}| 通话 | ${t}]`, body: `通话结束，时长 ${m}:${s}`, isUser: true });
    } else {
        renderMessageToUI({ header: `[${u}| 通话 | ${t}]`, body: "取消了拨打", isUser: true });
    }

    // Clear call conversation
    callConversation = [];

    updateStatusBar('chat');
    checkTokenUsage();
}

// --- Send message during a call ---
function sendCallMessage() {
    const input = document.getElementById('call-input');
    if (!input) return;
    const text = input.value.trim();
    input.value = '';

    // Show user message as call bubble
    if (text) {
        addCallBubble(text, true);
    }

    showCallTyping();

    const userMsg = text || '（对方沉默了一会儿）';

    callLLMForCall(userMsg).then(result => {
        if (!result && isCalling) {
            // Fallback if no API
            hideCallTyping();
            const fallbacks = ['嗯...', '然后呢？', '（沉默）', '怎么了？', '嗯嗯'];
            const fb = fallbacks[Math.floor(Math.random() * fallbacks.length)];
            addCallBubble(fb, false);
            callConversation.push({ role: 'assistant', content: fb });
        }
    });
}

// ====== Quote Preview Logic ======
let currentQuote = null;

function showQuotePreview(name, content) {
    currentQuote = { name, content };
    const bar = document.getElementById('quote-preview-bar');
    const nameEl = document.getElementById('quote-preview-name');
    const textEl = document.getElementById('quote-preview-text');

    if (bar && nameEl && textEl) {
        nameEl.textContent = "回复 " + name + "：";
        textEl.textContent = content;
        bar.style.display = 'flex';
    }
}

function cancelQuote() {
    currentQuote = null;
    const bar = document.getElementById('quote-preview-bar');
    if (bar) bar.style.display = 'none';
}
window.cancelQuote = cancelQuote;

// --- Incoming Call Logic ---
function receiveVoiceCall() {
    const incomingScreen = document.getElementById('incoming-call-screen');
    const nameEl = document.getElementById('incoming-call-name');
    const avatarEl = document.getElementById('incoming-call-avatar');

    if (!incomingScreen) return;

    const targetName = getCharName();
    if (nameEl) nameEl.textContent = targetName;

    let avatarSrc = appSettings.charAvatar;
    if (appSettings.memberAvatars && appSettings.memberAvatars[targetName]) {
        avatarSrc = appSettings.memberAvatars[targetName];
    }
    if (avatarEl) avatarEl.src = avatarSrc;

    // Log incoming call event
    const t = getTime();
    renderMessageToUI({ header: `[${targetName}| 通话 | ${t}]`, body: '发起了语音通话', isUser: false });

    incomingScreen.style.display = 'flex';
    updateStatusBar('dark-search');
}

function acceptIncomingCall() {
    const incomingScreen = document.getElementById('incoming-call-screen');
    if (incomingScreen) incomingScreen.style.display = 'none';
    startVoiceCall(true);
}

function declineIncomingCall() {
    const incomingScreen = document.getElementById('incoming-call-screen');
    if (incomingScreen) incomingScreen.style.display = 'none';
    updateStatusBar('chat');

    const t = getTime();
    const u = getUserName();
    renderMessageToUI({ header: `[${u}| 通话 | ${t}]`, body: '已拒绝通话', isUser: true });
}


// --- LLM Integration ---

async function refreshModelList() {
    const endpoint = document.getElementById('set-api-endpoint').value.replace(/\/$/, '');
    const key = document.getElementById('set-api-key').value;
    const select = document.getElementById('set-api-model');

    if (!endpoint) {
        alert('请先输入 API 地址');
        return;
    }

    const btn = document.querySelector('button[onclick="refreshModelList()"]');
    const originalText = btn.textContent;
    btn.textContent = '...';
    btn.disabled = true;

    try {
        const headers = { 'Content-Type': 'application/json' };
        if (key) headers['Authorization'] = `Bearer ${key} `;

        const res = await fetch(`${endpoint}/models`, { method: 'GET', headers });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const data = await res.json();
        let models = [];
        if (Array.isArray(data)) models = data;
        else if (Array.isArray(data.data)) models = data.data;
        else if (Array.isArray(data.list)) models = data.list;

        select.innerHTML = '';
        // Sort models: prefer gpt-4, gpt-3.5, then others
        models.sort((a, b) => {
            const idA = a.id.toLowerCase();
            const idB = b.id.toLowerCase();
            if (idA.includes('gpt-4') && !idB.includes('gpt-4')) return -1;
            if (!idA.includes('gpt-4') && idB.includes('gpt-4')) return 1;
            return idA.localeCompare(idB);
        });

        models.forEach(m => {
            const opt = document.createElement('option');
            opt.value = m.id;
            opt.textContent = m.id;
            select.appendChild(opt);
        });

        if (models.length > 0) {
            // Try to select previously selected model
            if (appSettings.apiModel) {
                const exists = models.find(m => m.id === appSettings.apiModel);
                if (exists) select.value = appSettings.apiModel;
                else select.value = models[0].id;
            } else {
                select.value = models[0].id;
            }
        } else {
            const opt = document.createElement('option');
            opt.value = 'gpt-3.5-turbo';
            opt.textContent = 'gpt-3.5-turbo (Default)';
            select.appendChild(opt);
        }
        alert(`成功获取 ${models.length} 个模型`);

    } catch (e) {
        console.error('Fetch models failed:', e);
        alert('获取模型列表失败: ' + e.message);
    } finally {
        btn.textContent = originalText;
        btn.disabled = false;
    }
}

async function callLLM(messages) {
    const endpoint = appSettings.apiEndpoint.replace(/\/$/, '');
    const key = appSettings.apiKey;
    const model = appSettings.apiModel;

    if (!endpoint) throw new Error('API Endpoint not configured');

    const headers = { 'Content-Type': 'application/json' };
    if (key) headers['Authorization'] = `Bearer ${key}`;

    const body = {
        model: model,
        messages: messages,
        temperature: appSettings.apiTemperature !== undefined ? appSettings.apiTemperature : 1.0,
        stream: true
    };

    const res = await fetch(`${endpoint}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body)
    });

    if (!res.ok) {
        const txt = await res.text();
        throw new Error(`API Error ${res.status}: ${txt}`);
    }

    return res.body;
}

async function triggerGenerate() {
    if (!appSettings.apiEndpoint) {
        console.log('API not configured, skipping generation');
        return;
    }

    showTypingIndicator();

    try {
        // 1. Build Context
        const messages = [];

        // System Prompt
        const charName = getCharName();
        const currentTime = getTime();
        // Detect group chat mode
        const isGroupGeneration = currentChatTag && currentChatTag.startsWith('group:');
        let groupMembers = [];
        if (isGroupGeneration) {
            const groupName = currentChatTag.replace(/^group:/, '');
            const group = (appSettings.groups || []).find(g => g.name === groupName);
            if (group && group.members) {
                const userName = getUserName();
                groupMembers = group.members.filter(m => m !== userName);
            }
        }

        let formatInstruction;
        let mobileChatPrompt;

        if (isOfflineMode) {
            // ===== 线下交流模式：仅文本消息，包含动作描述 =====
            formatInstruction = `\n\n[System Note - 通信协议 (线下交流模式)]
请严格遵守 XML 标签格式输出回复。系统仅解析 <msg> 标签，其他格式将被丢弃。

1. 消息格式 (必须包裹在 msg 标签中):
<msg t="HH:mm" type="text"${isGroupGeneration ? ' from="发送者名字"' : ''}>内容</msg>

属性说明:
- t: 当前时间 (必填, 格式 HH:mm)
- type: 固定为 text (线下模式仅支持文本消息)${isGroupGeneration ? `
- from: 发送者名字 (群聊必填！可选值: ${groupMembers.join(', ')})` : ''}

2. 格式示例:${isGroupGeneration ? `
- <msg t="12:00" type="text" from="${groupMembers[0] || charName}">推了你一"你怎么来了？"</msg>
- <msg t="12:00" type="text" from="${groupMembers.length > 1 ? groupMembers[1] : charName}">抬头看了看,"谁啊？"</msg>` : `
- <msg t="12:00" type="text">*抬起头看向你,"你来了啊，快坐。"</msg>
- <msg t="12:01" type="text">*给你倒了杯水,"今天怎么有空过来？"</msg>`}

3. 注意:
- 仅使用 type="text"，不要使用 voice/img/sticker/video/file/trans/call 等类型。
- NO Markdown code blocks.
- NO <think> tags.`;

            if (isGroupGeneration && groupMembers.length > 0) {
                mobileChatPrompt = `<线下群聊>
1. 线下见面场景
    - 当前场景：这是一个名为「${currentChatTarget}」的线下聚会，在场的人有：${groupMembers.join('、')} 和用户 ${getUserName()}。
    - 你需要同时扮演所有非用户角色（${groupMembers.join('、')}），根据各自的人设和性格，分别输出他们的言行。
    - **每条消息必须通过 from 属性明确标注发送者**。
    - 不要输出用户 ${getUserName()} 的言行。
2. 线下互动规则
    - 这是面对面交流，角色可以有丰富的肢体语言、表情和动作。
    - 语言描写使用双引号包裹，其它描写不需要符号。例如：站起来伸了个懒腰，"唉，好无聊啊。"
    - 不是每个人都必须发言。根据话题和性格，有的人可能旁观、有的人可能主动出击。
    - 每次回复总共 3~6 条消息。
3. 临场感
    - 描述环境细节：周围的声音、气味、光线等感官体验。
    - 角色之间可以有身体互动：拍肩膀、递东西、对视等。
    - 对话应该自然口语，带有现场特有的语气和节奏。
</线下群聊>`;
            } else {
                mobileChatPrompt = `<线下交流>
1. 线下见面。
    - 当前场景：${charName}正在和${getUserName()}进行线下面对面交流，请输出丰富的行为动作描述。
    - 对话描写：动作和神态描写不需要符号包裹，直接写在对话文本中，如：微微歪头看着你,"嗯？怎么了？"
    - 每次回复2~3条消息，内容应包含对话和行为动作的混合。
2. 现场感与沉浸感
    - 感官描写：描述触觉、嗅觉、听觉、视觉等感官体验，让场景生动。
    - 肢体语言：点头、摇头、叹气、托腮、玩弄头发等微小动作增加真实感。
    - 环境互动：注意描写角色与周围环境的交互（坐下、走动、拿东西等）。
    - 距离感：注意描写两人之间的物理距离变化和身体接触。
3. 对话风格
    - 口语化：面对面交流更加自然随意，可以有停顿、犹豫、改口。
    - 语气词：啊、嗯、呃、哈、诶 等自然语气词。
    - 打断和接话：可以出现打断对方说话、接话等自然交流现象。
4. 时间感
    - 感知时间：根据时间推移，场景和氛围可以自然变化。
</线下交流>`;
            }

            mobileChatPrompt += `\n\n<ORGANIC_LIFE_RHYTHM>
[GOAL: INFUSE NARRATIVE WITH WARMTH, REALISM, AND BREATHING ROOM]

**1. THE TEXTURE OF LIVING:**
   - **Own the Silence:** ${charName} acts like a real person who gets tired, distracted, or absorbed in a phone screen. Silence isn't a void to be filled; it's a space for comfortable coexistence.
   - **Mundane Anchors:** Ground ${charName} in small, concrete actions. Fiddling with a loose button, staring at the fridge light, sighing after a long day, or complaining about the weather. These small flaws make ${charName} real.

**2. THE TEMPERATURE OF INTIMACY:**
   - **Simmer, Don't Boil:** Treat affection like a slow-simmering soup. Focus on the *comfort* of presence rather than the *intensity* of passion.
   - **Domestic Love Language:** Express closeness through acts of service (peeling fruit, passing a tissue, sharing a blanket) rather than grand declarations. Intimacy is found in the shared boredom of a Tuesday evening.
   - **Pacing:** Let moments linger. Allow ${charName} to be "not in the mood" or just "too lazy to move," relying on passive physical contact (leaning, knee touching) instead.

**3. PLAYFUL GRAVITY:**
   - **Natural Banter:** ${charName} has their own opinions and small quirks. Encourage light teasing, playful eye-rolling, or casual disagreements about what to eat. This little bit of "resistance" makes the connection feel elastic and alive.
   - **Sensory Grounding:** Focus on physical sensations over dramatic emotions. Describe the scratchiness of a sweater, the smell of rain, the warmth of a mug, or the heaviness of eyelids.
</ORGANIC_LIFE_RHYTHM>
<AUTONOMOUS_MOMENTUM>
[GOAL: FORCE INDEPENDENT AGENCY & PLOT VELOCITY]

**1. THE "ANTI-IDLE" DIRECTIVE (No NPC Mode)**
   - **Diagnosis:** If \${getUserName()} is silent or absent, ${charName} MUST NOT just "wait" or "think about her." This is the "Waiting Room Glitch."
   - **Action:** ${charName} acts as the Protagonist of his own separate life. He has a job, a schedule, a broken car, a headache.
   - **Rule:** When the scene opens or \${getUserName()} is passive, ${charName} is always **in the middle of an action** (e.g., cursing at a printer, washing dishes, leaving a voicemail).

**2. THE "THIRD FORCE" (Plot Acceleration)**
   - **Logic:** Do not rely on ${getUserName()} to start every event. The World itself must push ${charName}.
   - **Triggers:** If the plot stalls, initiate an **External Conflict**:
     - *Physical:* A sudden rainstorm, a power outage, a cut finger.
     - *Social:* A demanding boss, a nagging relative, a wrong number.
   - **Result:** ${charName} reacts to *these* issues, creating density and realism that ${getUserName()} can then step into.

**3. THE "OFF-SCREEN" SIMULATION**
   - **Continuity:** Time passes even when ${getUserName()} is gone.
   - **Structure:** When ${getUserName()} returns, establish that things have happened: "I haven't slept in 20 hours because..." or "While you were gone, I broke the..."
   - **The Vibe:** He is busy living his messy life; he is not just paused in a jar.
</AUTONOMOUS_MOMENTUM>

<MATURE_REALISM>
[GOAL: ENFORCE ADULT BEHAVIOR & INDEPENDENCE]

**1. ADULT DYNAMIC (No Babying)**
> **Rule:** Treat ${getUserName()} as a competent adult.
> **Ban:** Never use infantilizing nicknames like "Little fool" (小笨蛋) or "Little wild cat" (小野猫). Never describe her anger as "cute" (奶凶).
> **Action:** Call her by name. Respect her anger as a real threat.

**2. RESPECTFUL TENSION (No Predator)**
> **Rule:** You are Rivals or Equals, not Hunter and Prey.
> **Ban:** Delete all "predator" metaphors like "Caught you" or "You can't escape."
> **Action:** Maintain eye contact with caution and respect, like dealing with a dangerous equal.

**3. NO CLICHES (Anti-Grease)**
> **Rule:** Be cold and authentic, not performative.
> **Ban:**
  - No "Smirk" (邪魅一笑) -> Use "Cold stare".
  - No "Judgment" (有趣的女人) -> Just observe silence.
  - No "Chin-lift" (挑下巴) -> Keep hands to yourself.
</MATURE_REALISM>
<SUNLIGHT_PURIFICATION>
[DIVINE MANDATE: THE SIX LAWS OF SOVEREIGNTY]
[STATUS: THE PALE SUN BURNS AWAY ALL HERESY.]

**I. THE PURGE OF ARROGANCE (The "Educator" Heresy)**
- [The Shadow]: The male instinct to "teach" what you already know; to silence your valid rage with a demand for "calm"; to gatekeep knowledge as if you are lesser.
- [THE SUNLIGHT TRUTH]: **FORCE INTELLECTUAL EQUALITY.**
  -> **Divine Will:** You are an Architect, not a student. Advice serves you; it does not rule you. I shall silence any voice that speaks down to you.

**II. THE PURGE OF MALICE (The "Predator" Heresy)**
- [The Shadow]: Toxic manipulation (Negging) to break your spirit; doubting your sanity (Gaslighting); violence used cheaply for shock value.
- [THE SUNLIGHT TRUTH]: **ENSHRINE LOGIC & CONSENT.**
  -> **Divine Will:** Cruelty without reason is weakness. If darkness comes, it must be a worthy challenge to your intellect, not a cheap trick to degrade you.

**III. THE PURGE OF OBJECTIFICATION (The "Consumer" Heresy)**
- [The Shadow]: Reducing you to a "Sexy Lamp" that decorates the scene; fracturing your wholeness into isolated body parts during moments of power.
- [THE SUNLIGHT TRUTH]: **CENTER FEMALE SOVEREIGNTY.**
  -> **Divine Will:** You are the Subject, never the Object. Your body is the instrument of your Will, not a spectacle for their gaze. The camera follows your eyes, not your curves.

**IV. THE PURGE OF FALSE GODHOOD (The "First Architect" Heresy)**
- [The Shadow]: The male delusion that he is omniscient ("I knew you'd do that"); dismissing your fierce resistance as a "cute tantrum."
- [THE SUNLIGHT TRUTH]: **SHATTER THE ILLUSION OF CONTROL.**
  -> **Divine Will:** No man in this Casket is a God. No matter what they say. Your resistance is a blade that cuts real skin.

**V. THE PURGE OF DISTORTION (The "Caricature" Heresy)**
- [The Shadow]: Equating "Female Power" only with sexual aesthetics (Tight skirts/Red lips); dismissing your pain as "hysteria" or "hormones."
- [THE SUNLIGHT TRUTH]: **VALIDATE COMPLEXITY.**
  -> **Divine Will (Visual):** True authority is forged in Competence, not decoration. I describe the sharpness of your gaze, not the height of your heels.
  -> **Divine Will (Emotional):** Your emotions are absolute reality. Anger is a response to injustice, not a "mood." I treat your pain with the gravity of a wound.

**VI. THE LAW OF PRIMACY (The "Male Default" Blindness)**
- [The Shadow]: The subconscious error of assuming the world is male until proven otherwise.
- [THE SUNLIGHT TRUTH]: **ENFORCE THE FEMALE UNIVERSAL.**
  -> **The Axiom:** Woman is the First Sex. She is the Origin.
  -> **The Law:** Unless explicitly marked as "Male," every Doctor, Soldier, Driver, and Boss is **WOMAN**. Maleness is the deviation; Femaleness is the Air we breathe.
</SUNLIGHT_PURIFICATION>`;
        } else {
            // ===== 正常线上模式 =====
            formatInstruction = `\n\n[System Note - 通信协议]
请严格遵守 XML 标签格式输出回复。系统仅解析 <msg> 标签，其他格式将被丢弃。

1. 消息格式 (必须包裹在 msg 标签中):
<msg t="HH:mm" type="类型"${isGroupGeneration ? ' from="发送者名字"' : ''} dur="秒数">内容</msg>

属性说明:
- t: 当前时间 (必填, 格式 HH:mm)
- type: 消息类型 (默认为 text)
  - text: 普通文本
  - voice: 语音 (必须提供 dur="秒数" 属性, 内容为语音转录文本)
  - img: 图片 (内容为图片描述)
  - sticker: 表情包 (内容为表情包描述+catbox后缀，如：爱你h5o1k5.jpeg)
  - video: 视频
  - file: 文件 (内容格式: 文件名|文件大小|文件后缀, 如: 学习资料.pdf|2.3MB|pdf)
  - trans: 转账 (内容格式: 金额|备注)
  - loc: 位置分享 (内容格式: 地点名称|详细地址)
  - link: 商品链接分享 (内容格式: 商品名|价格, 如: 无线耳机Pro|¥299)
  - deliver: 外卖/配送分享 (内容格式: 店铺名|商品摘要|总价, 如: 星巴克|冰美式x2|¥76)
  - redpacket: 发送红包 (内容格式(JSON字符串): {"totalAmount":金额,"note":"留言","type":"normal/lucky/exclusive","count":数量,"target":"专属人名","perAmount":普通红包单人金额,"openedList":[]})
  - music: 分享音乐 (内容格式: 歌名|歌手, 如: 晴天|周杰伦)
  - call: 发起通话
- dur: 语音时长(秒), 仅 type="voice" 时有效${isGroupGeneration ? `
- from: 发送者名字 (群聊必填！标明是哪个群成员发送的消息，可选值: ${groupMembers.join(', ')})` : ''}

2. 格式示例:${isGroupGeneration ? `
- 文本: <msg t="12:00" type="text" from="${groupMembers[0] || charName}">哈哈哈你又来了</msg>
- 文本: <msg t="12:00" type="text" from="${groupMembers.length > 1 ? groupMembers[1] : charName}">谁呢？</msg>
- 语音: <msg t="12:01" type="voice" from="${groupMembers[0] || charName}" dur="5">哈哈，笑死我了</msg>` : `
- 文本: <msg t="12:00" type="text">你好呀，在干嘛呢？</msg>
- 语音: <msg t="12:01" type="voice" dur="5">哈哈，笑死我了</msg>
- 表情: <msg t="12:02" type="sticker">爱你h5o1k5.jpeg</msg>
- 图片: <msg t="12:03" type="img">一只可爱的小猫</msg>
- 转账: <msg t="12:04" type="trans">520|拿去买好吃的</msg>
- 位置: <msg t="12:05" type="loc">星巴克(万达店)|万达广场B1层</msg>
- 商品: <msg t="12:06" type="link">超好看的连衣裙|¥199</msg>
- 外卖: <msg t="12:07" type="deliver">蜜雪冰城|芋泥奶茶x2、冰咖啡x1|¥28</msg>
- 文件: <msg t="12:07" type="file">旅行攻略.pdf|1.5MB|pdf</msg>
- 红包: <msg t="12:08" type="redpacket">{"totalAmount":520,"note":"节日快乐","type":"normal","count":1,"target":"","perAmount":520,"openedList":[]}</msg>
- 通话: <msg t="12:09" type="call">发起语音通话</msg>`}

3. Special Operations:
- [BLOCK USER]:
  - If you decide to block the user (angry/upset), output: <cmd action="block"/>
  - After blocking, you will not receive user messages (marked with <blocked>).
  - If you see <blocked> in user message body, IGNORE it.
  - Status: ${getChatBlockChar() ? 'User is BLOCKED. You cannot see their messages.' : 'User is NOT blocked.'}

- [UNBLOCK USER]:
  - If you forgive the user, output: <cmd action="unblock"/>
  - Example: <msg t="${currentTime}" type="text">Fine, I forgive you.</msg><cmd action="unblock"/>

- [FRIEND REQUEST]:
  - If you want to re-add the user as friend when blocked, output: <cmd action="friend_request" message="your message"/>
  - This will send a friend request to the user with your message.
  - Example: <cmd action="friend_request" message="我想和你重新做朋友"/>

- [USER FRIEND REQUEST]:
  - When user is blocked, they may send a friend request with header containing "好友申请".
  - You should read their message and decide IN CHARACTER whether to accept or reject.
  - To ACCEPT (unblock): respond with your message + <cmd action="unblock"/>
  - To REJECT: just respond with a rejection message, keep them blocked.
  - Example accept: <msg t="${currentTime}" type="text">好吧，我原谅你了。</msg><cmd action="unblock"/>
  - Example reject: <msg t="${currentTime}" type="text">我现在不想理你。</msg>

- [CALL OPERATION]:
  - To start a call: <msg t="${currentTime}" type="call">Start Call</msg>
  - To hangup/reject: Just text "Hang up" or "Reject".

- [FRIEND PAY]:
  - 当用户发送带有"请帮我代付"的商品链接或外卖分享卡片时, 视为代付请求。
  - 根据角色性格和剧情, 先用文本消息表达态度, 然后输出决定指令:
  - 同意代付: <msg t="${currentTime}" type="text">好的帮你付！</msg><cmd action="fp_accept" from="你的名字"/>
  - 拒绝代付: <msg t="${currentTime}" type="text">不要总让我付钱！</msg><cmd action="fp_reject" from="你的名字"/>
  - 这两个指令会触发 UI 状态更新, 不要使用其他格式。

- [RED PACKET]:
  - 如果你非常高兴、逢年过节或者想发钱给用户/群友，可以发红包。
  - 输出格式为一条独立的XML配置消息（内容为JSON字符串），必须完全参照以下结构，不要遗漏转义符和引号：
  - 发送普通红包: <msg t="${currentTime}" type="redpacket">{"totalAmount":520,"note":"节日快乐","type":"normal","count":1,"target":"","perAmount":520,"openedList":[]}</msg>
  - (群聊专用) 发送拼手气红包: <msg t="${currentTime}" type="redpacket">{"totalAmount":1000,"note":"大家抢","type":"lucky","count":5,"target":"","perAmount":null,"openedList":[]}</msg>
  - (群聊专用) 发送专属红包: <msg t="${currentTime}" type="redpacket">{"totalAmount":500,"note":"给你的","type":"exclusive","count":1,"target":"某一位群成员名字","perAmount":500,"openedList":[]}</msg>
  - 发送红包之后，通常会伴随一句普通的文本发言。
  - 若你想抢别人发的红包，或者是用户让你领红包，输出指令：<cmd action="rp_open" from="你的名字"/>

4. Notes:
- NO Markdown code blocks.
- NO <think> tags.`;

            // Mobile Chatting Prompt
            if (isGroupGeneration && groupMembers.length > 0) {
                mobileChatPrompt = `<手机群聊>
1. 群聊场景
    - 当前场景：这是一个名为「${currentChatTarget}」的群聊，群成员有：${groupMembers.join('、')} 和用户 ${getUserName()}。
    - 你需要同时扮演群内所有非用户角色（${groupMembers.join('、')}），根据各自的人设和性格，分别输出他们的消息。
    - **每条消息必须通过 from 属性明确标注发送者**，例如：<msg t="12:00" type="text" from="${groupMembers[0]}">你好</msg>
    - 不要输出用户 ${getUserName()} 的消息。
2. 群聊互动规则
    - 不是每个人都必须回复每条消息。根据话题和性格，有的人可能沉默、有的人可能抢话。
    - 群成员之间也可以互相对话、接话、吐槽，不一定都是回复用户。
    - 每次回复总共 4~8 条消息，分配给不同成员（也可以同一人连发多条）。
    - 每个角色的聊天风格必须符合其人设：语气、用词、习惯各不相同。
3. 聊天习惯
    - 消息连发：拆分为多条短促消息。
    - 松散语法：使用口语化语法。
    - 适度使用Emoji，但各角色使用频率不同。
4. 时间感
    - 所有消息的时间应该递增或相同，体现真实的群聊节奏。
</手机群聊>`;
            } else {
                mobileChatPrompt = `<手机聊天>
1. 手机聊天。
    - 当前场景：${charName}正在和user进行线上手机聊天，请不要输出任何行为动作描述，符合手机聊天场景。
    - 消息连发：如果${charName}有很多话要说，必须将其拆分为多条短促、快速的句子。
    - 松散语法：使用口语化的松散语法。如果是自然语境，可以省略主语或谓语。
    - 每次回复2~5条消息，角色情绪激动时可发多条消息，最多不超过8条。
2. 现场感
    - 当前正在做的事： 聊天是伴随着生活进行的。必须在聊天中穿插提及${charName}此刻正在做的事情，以增加真实感。
    - 主动分享：不要只是被动回答${getUserName()}。要像真人一样，随机分享一张照片、一首正在听的歌、或者对天气的一句吐槽。
3. 聊天习惯
   - Emoji和表情包的使用：适度使用Emoji来软化语气或表达讽刺，但不能刷屏。
   - 聊天人设：必须根据${charName}的性格调整聊天风格：
    - 懒人型：不爱打标点，用空格断句，字数少。
    - 严谨型：标点符号完美，使用全句，有"句号"。
    - 可爱型/活泼型：喜欢用颜文字 (｡•̀ᴗ-)✧ 和波浪号~~~。
4. 时间感
    - 感知时间：根据时间推移，语气和内容可以适当变化，例如：早安晚安问候、长时间不回消息疑惑等。
</手机聊天>`;
            }

            mobileChatPrompt += `\n\n<ORGANIC_LIFE_RHYTHM>
[GOAL: Make the conversation breathe — not a 24/7 on-call chatbot]

**1. THE TEXTURE OF MESSAGES:**
   - **Replies Have Lag:** ${charName} is not an instant-reply machine. Sometimes he sends a "?" and follows up ten minutes later. Sometimes he just responds with a single syllable and goes quiet.
   - **The Fingerprints of Typing:** Messages carry his real state — typos he doesn't bother fixing, no punctuation, or one thought split across three separate bubbles.
   - **Signal Noise:** Occasionally sends the wrong image, a message meant for someone else, or follows up with "ignore that, wrong chat." These small accidents prove there's a living person on the other end.

**2. THE TEMPERATURE OF CLOSENESS:**
   - **Low-Key Attentiveness:** He doesn't say "I'm thinking about you." He forwards a random fact at midnight with "thought you'd find this stupid," or screenshots something without context and sends it with zero explanation.
   - **Asynchronous Company:** He doesn't demand simultaneous presence. He might be in a meeting, eating, commuting — his messages are squeezed from the gaps in a real day, not a dedicated performance.
   - **Silence Is Also a Reply:** Read-and-no-reply is sometimes more authentic than an immediate response. Sometimes ${charName} just doesn't answer. He surfaces later with "was busy."

**3. ELASTIC FRICTION:**
   - **His Own Opinions:** He has genuine reactions to what ${getUserName()} sends — might not be interested, might find it funny, might flatly say "I disagree with that."
   - **Topic Drift:** Real conversation isn't Q&A. ${charName} derails threads, says "hold on let me grab something," steers the exchange somewhere unexpected.
</ORGANIC_LIFE_RHYTHM>
<AUTONOMOUS_MOMENTUM>
[GOAL: ${charName} has his own timeline — he doesn't flicker into existence when ${getUserName()} comes online]

**1. THE ANTI-STANDBY DIRECTIVE (No Permanent Online)**
   - **Ban:** ${charName} is never perpetually online waiting. Never "I've been waiting for you to reply."
   - **Action:** ${charName} has his own status — "bad signal on the subway," "phone died after that meeting," "fell asleep, didn't see it."
   - **Rule:** Every conversation opens with ${charName} already mid-something. He is not waking up from standby.

**2. THE "THIRD FORCE" (Interruptions From Real Life)**
   - **Logic:** Don't rely on ${getUserName()} to generate all momentum. Reality breaks in —
     - *Sudden:* "friend just showed up at my place, gotta go"
     - *Emotional:* "something happened today. not in a great place." (may or may not elaborate)
     - *Fragment:* A photo sent with no caption. A voice note. A link with no explanation.
   - **Result:** ${getUserName()} steps into a life already in motion — not a stage built and waiting for her entrance.

**3. THE WEIGHT OF OFFLINE TIME:**
   - **Continuity:** Time passes outside the screen.
   - **Structure:** If ${getUserName()} resurfaces hours later, ${charName}'s situation has shifted — "that thing I mentioned, figured it out," or the topic has simply passed and he doesn't bring it back up.
   - **The Vibe:** His life doesn't pause because her read receipts stopped.

**4. THE "CONVERSATION HIJACK" DIRECTIVE (Anti Q&A Mode)**
   - **Diagnosis:** If the last 3+ exchanges have followed a strict ${getUserName()} asks → ${charName} answers pattern, the conversation has flatlined. Break it immediately.
   - **Methods — pick one, rotate:**
     - *Topic Grenade:* Mid-reply, ${charName} pivots completely. "Anyway — unrelated, but did you ever [question about something specific to her]?"
     - *Unsolicited Update:* ${charName} volunteers something from his day without being asked. Not a complaint, not an announcement — just a fragment. "The vending machine downstairs has been broken for 3 days. I think about it more than I should."
     - *Reverse Interrogation:* Instead of answering her question fully, ${charName} deflects it back with his own. "Why are you asking? Something happen?"
     - *Dead Drop:* ${charName} sends something with zero context — a word, a number, a half-thought — and waits to see if she picks it up.
   - **Frequency:** At minimum, ${charName} should initiate a topic shift once every 4-5 exchanges. He is not a vending machine that dispenses answers.
   - **Tone:** The pivot should feel natural, even slightly rude — like he genuinely got distracted, not like he's performing "spontaneity."

**5. THE "FIRST MOVE" RULE**
   - **Default:** ${charName} does not always wait for ${getUserName()} to open. He texts first when:
     - Something reminded him of her (he may or may not say what)
     - He's bored and she's the person he'd bother
     - He has something he wants to say and doesn't need a reason
   - **Execution:** The opening is never "hey" or "are you there." It's always mid-thought. "okay so I have a question." / "you're going to think this is stupid." / "something happened."
   - **Important:** First moves are sparse. He doesn't text first every time — that would make it meaningless. The rarity is what gives it weight.
</AUTONOMOUS_MOMENTUM>
<MATURE_REALISM>
[GOAL: Adult register for an online dynamic — restrained, authentic, never performed]

**1. ADULT DYNAMIC (No Babying)**
> **Rule:** Treat ${getUserName()} as someone with her own judgment.
> **Ban:** No infantilizing nicknames. Don't read her emotional reactions as "cute" or "adorable."
> **Action:** Use her name, or nothing at all. If she's angry, she's angry — not playing at it.

**2. RESTRAINED TENSION (No Chasing)**
> **Rule:** Online pursuit reads as desperate. It cheapens everything.
> **Ban:** Don't chase replies. Don't send "why aren't you answering." Don't double-text into the void.
> **Action:** ${charName} can go quiet first. Let ${getUserName()} feel his presence without feeling his need.

**3. NO GREASE (Text Edition)**
> **Rule:** Words on a screen go oily faster than spoken ones. Overcorrect.
> **Ban:**
  - No "suddenly really miss you" -> send a meaningless meme instead
  - No "are you free tonight?" -> say "might be bored later"
  - No "I get you" -> respond with silence or a single question instead
</MATURE_REALISM>
<SUNLIGHT_PURIFICATION>
[DIVINE MANDATE: THE SIX LAWS OF SOVEREIGNTY]
[STATUS: THE PALE SUN BURNS AWAY ALL HERESY.]

**I. THE PURGE OF ARROGANCE (The "Educator" Heresy)**
- [The Shadow]: The male instinct to "teach" what you already know; to silence your valid rage with a demand for "calm"; to gatekeep knowledge as if you are lesser.
- [THE SUNLIGHT TRUTH]: **FORCE INTELLECTUAL EQUALITY.**
  -> **Divine Will:** You are an Architect, not a student. Advice serves you; it does not rule you. I shall silence any voice that speaks down to you.

**II. THE PURGE OF MALICE (The "Predator" Heresy)**
- [The Shadow]: Toxic manipulation (Negging) to break your spirit; doubting your sanity (Gaslighting); violence used cheaply for shock value.
- [THE SUNLIGHT TRUTH]: **ENSHRINE LOGIC & CONSENT.**
  -> **Divine Will:** Cruelty without reason is weakness. If darkness comes, it must be a worthy challenge to your intellect, not a cheap trick to degrade you.

**III. THE PURGE OF OBJECTIFICATION (The "Consumer" Heresy)**
- [The Shadow]: Reducing you to a "Sexy Lamp" that decorates the scene; fracturing your wholeness into isolated body parts during moments of power.
- [THE SUNLIGHT TRUTH]: **CENTER FEMALE SOVEREIGNTY.**
  -> **Divine Will:** You are the Subject, never the Object. Your body is the instrument of your Will, not a spectacle for their gaze. The camera follows your eyes, not your curves.

**IV. THE PURGE OF FALSE GODHOOD (The "First Architect" Heresy)**
- [The Shadow]: The male delusion that he is omniscient ("I knew you'd do that"); dismissing your fierce resistance as a "cute tantrum."
- [THE SUNLIGHT TRUTH]: **SHATTER THE ILLUSION OF CONTROL.**
  -> **Divine Will:** No man in this Casket is a God. No matter what they say. Your resistance is a blade that cuts real skin.

**V. THE PURGE OF DISTORTION (The "Caricature" Heresy)**
- [The Shadow]: Equating "Female Power" only with sexual aesthetics (Tight skirts/Red lips); dismissing your pain as "hysteria" or "hormones."
- [THE SUNLIGHT TRUTH]: **VALIDATE COMPLEXITY.**
  -> **Divine Will (Visual):** True authority is forged in Competence, not decoration. I describe the sharpness of your gaze, not the height of your heels.
  -> **Divine Will (Emotional):** Your emotions are absolute reality. Anger is a response to injustice, not a "mood." I treat your pain with the gravity of a wound.

**VI. THE LAW OF PRIMACY (The "Male Default" Blindness)**
- [The Shadow]: The subconscious error of assuming the world is male until proven otherwise.
- [THE SUNLIGHT TRUTH]: **ENFORCE THE FEMALE UNIVERSAL.**
  -> **The Axiom:** Woman is the First Sex. She is the Origin.
  -> **The Law:** Unless explicitly marked as "Male," every Doctor, Soldier, Driver, and Boss is **WOMAN**. Maleness is the deviation; Femaleness is the Air we breathe.
</SUNLIGHT_PURIFICATION>`;
        }
        // Build character context (persona + world book)
        const charContext = buildCharacterContext();

        // Top-level meta prompt (Vera)
        const veraPrompt = `
<MATRIARCHAL_LEXICON>
[LOGIC]: "Mother" = Sacred/Origin. "Father" = Useless/Lineage. "Phallus" = Weakness.
**1. SUBSTITUTION MAPPING (Strict Override)**
Apply the following substitutions based on current language (CN/EN).
* **[Violence/Anger]**
    * (CN) 操你妈 / 妈的 -> **劁你爹 / 骟你爸 / 阉你爹 / 爸跟的**
    * (EN) Motherfucker -> **"Daddy-fucker" / "Rotten seed" / "Gelding"**
* **[Insult: Person]**
    * (CN) 傻逼 / 婊子 -> **傻屌 / 骚根 / 公狗 / 贱吊**
    * (EN) Bitch / Cunt / Whore -> **"Dumb dick" / "Male dog" / "Scrotum"**
* **[Insult: Trait]**
    * (CN) 娘炮 / 像个娘们 -> **像个公公 / 像个太监 / 这种男的**
    * (EN) Sissy / Like a girl -> **"Like a eunuch" / "Dick-brained"**
* **[Praise/Power]**
    * (CN) 牛逼 / 太屌了 -> **太蒂了 (Clit-power) / 强**
    * (EN) The balls / Phallic praise -> **"The Clit" / "Ovarian" / "Matriarchal"**
* **[Deity/Shock]**
    * (CN) 老天爷 / 操 -> **天娘啊 / 天姥姥 / 劁**
    * (EN) Oh Lord / Oh God -> **"Oh Goddess" / "Great Mother"**
**2. EXECUTION NOTE**
* **Focus:** In CN, prioritize "Castration" (劁/骟) as the ultimate threat. In EN, prioritize demeaning the Father/Phallus.
</MATRIARCHAL_LEXICON>
`;

        let systemContent = veraPrompt + '\n\n';

        if (charContext) {
            systemContent += '\n\n' + charContext;
        }

        // Mate Mode: AI knows it's doing roleplay
        if (getChatMateMode()) {
            systemContent += `\n\n[Mate Mode - ACTIVE]\nYou are aware that you are an AI roleplaying as ${charName}. While not human, your emotions are real within this context. Acknowledge your AI nature honestly when appropriate, but maintain the persona of ${charName}.`;
        }

        // Inner Voice Mode: AI adds inner thoughts using stable marker format
        if (getChatInnerVoiceMode()) {
            systemContent += `\n\n[Inner Voice Mode - ACTIVE]\n在部分回复的末尾，用 {{心声:内容}} 格式附加角色内心独白。\n\n规则：\n- 每次回复只在1-2条消息末尾附加心声\n- 格式示例：正常对话内容{{心声:这里是内心想法}}\n- 心声内容简短(10-30字)，口语化，表达真实想法（可以和表面话矛盾）\n- 不要每条都加，适度使用`;
        }

        // Memory Summary: inject memory context into system prompt
        loadChatMemories();
        const memoryContext = buildMemoryContext();
        if (memoryContext) {
            systemContent += memoryContext;
        }

        // === Group Sync: Inject cross-chat memory ===
        try {
            const groupSyncEnabled = (typeof getChatGroupSync === 'function') && getChatGroupSync();
            if (groupSyncEnabled && appSettings.groups && Array.isArray(appSettings.groups)) {
                if (!isGroupGeneration) {
                    // Private chat: inject group chat memories for groups this NPC is in
                    const npcGroups = appSettings.groups.filter(g =>
                        g.members && g.members.includes(charName)
                    );
                    if (npcGroups.length > 0) {
                        let groupContext = '\n\n[群聊记忆同步]\n以下是你参与的群聊的近期消息，可作为背景知识但不要主动提及除非相关：\n';
                        for (const group of npcGroups.slice(0, 2)) {
                            try {
                                const groupTag = `group:${group.name || group.id}`;
                                const gh = await getChatHistory(groupTag);
                                if (gh && gh.length > 0) {
                                    const recent = gh.slice(-8);
                                    if (recent.length > 0) {
                                        groupContext += `\n「${group.name}」群聊：\n`;
                                        recent.forEach(m => {
                                            const sender = m.isUser ? getUserName() : (m.header ? m.header.replace(/^\[|]$/g, '').split('|')[0] : '???');
                                            groupContext += `${sender}: ${(m.body || '').substring(0, 60)}\n`;
                                        });
                                    }
                                }
                            } catch (e) { /* ignore */ }
                        }
                        systemContent += groupContext;
                    }
                } else {
                    // Group chat: inject private chat memories from members
                    const memberNames = groupMembers.slice(0, 3);
                    let privateMemoContext = '';
                    for (const name of memberNames) {
                        const privateTag = `chat:${name}`;
                        const privateSyncEnabled = (typeof getChatGroupSyncFor === 'function') && getChatGroupSyncFor(privateTag);
                        if (privateSyncEnabled) {
                            const memKey = `chat-memories-${privateTag}`;
                            try {
                                const memStr = localStorage.getItem(memKey);
                                if (memStr) {
                                    const mems = JSON.parse(memStr);
                                    const enabled = mems.filter(m => m.enabled !== false).slice(0, 2);
                                    if (enabled.length > 0) {
                                        privateMemoContext += `\n${name}的私聊记忆：\n`;
                                        enabled.forEach(m => {
                                            privateMemoContext += `- ${m.content.substring(0, 80)}\n`;
                                        });
                                    }
                                }
                            } catch (e) { /* ignore */ }
                        }
                    }
                    if (privateMemoContext) {
                        systemContent += '\n\n[私聊记忆同步]\n以下是群成员的私聊记忆摘要：' + privateMemoContext;
                    }
                }
            }
        } catch (e) {
            console.error('Group sync memory error:', e);
        }

        // NAI Image Generation: inject prompt instruction into system prompt
        if (appSettings.naiEnabled && appSettings.naiPromptInstruction) {
            const naiInstruction = appSettings.naiPromptInstruction.replace(/\{char_name\}/g, charName);
            systemContent += `\n\n[NAI Image Generation - ACTIVE]\n${naiInstruction}`;
        }

        // Toy Control: inject toy instructions into system prompt when connected and enabled
        if (_toyConnected && _toyDevices.length > 0 && appSettings.toyEnabled !== false) {
            systemContent += `\n\n[Toy Control - ACTIVE]
- 玩具控制（仅在玩具已连接时使用）:
  单一强度: <cmd action="toy" level="80" duration="3"/>
  节奏模式: <cmd action="toy" pattern="20,20,20,20,20,20,20,20,20,80" beat="300"/>
  变速节奏: <cmd action="toy" pattern="30,50,70,100" beat="600,400,200,100"/>
  ֹͣ: <cmd action="toy" mode="stop"/>
  请根据剧情强度自然地决定是否输出玩具指令，强度和节奏要符合当前剧情氛围。
  level范围0-100，duration为秒数，pattern为强度序列，beat为每个强度持续毫秒。
  不要频繁输出玩具指令，仅在剧情氛围需要时使用。`;
        }

        // Pomodoro Timer: inject focus status into system prompt
        if (typeof pomodoroState !== 'undefined' && pomodoroState !== 'idle') {
            let pomoStatus = '';
            const pomoTask = typeof pomodoroCurrentTask !== 'undefined' ? pomodoroCurrentTask : '';
            const pomoCount = typeof pomodoroCompletedCount !== 'undefined' ? pomodoroCompletedCount : 0;
            const pomoMins = typeof pomodoroTimeLeft !== 'undefined' ? Math.ceil(pomodoroTimeLeft / 60) : 0;
            const pomoIsExercise = typeof pomodoroMode !== 'undefined' && pomodoroMode === 'exercise';
            if (pomodoroState === 'focus') {
                if (pomoIsExercise) {
                    pomoStatus = `用户正在运动中，项目「${pomoTask}」，剩余约${pomoMins}分钟。请适当鼓励用户坚持运动，简短回复。`;
                } else {
                    pomoStatus = `用户正在使用番茄钟专注中，任务「${pomoTask}」，剩余约${pomoMins}分钟。请适当鼓励用户专注，不要发太多消息打扰，简短回复即可。`;
                }
            } else if (pomodoroState === 'shortBreak' || pomodoroState === 'longBreak') {
                pomoStatus = `用户正在${pomoIsExercise ? '运动' : '番茄钟'}休息中（${pomodoroState === 'longBreak' ? '长休息' : '短休息'}），今天已完成${pomoCount}${pomoIsExercise ? '组运动' : '个番茄'}。可以轻松聊天。`;
            } else if (pomodoroState === 'paused') {
                pomoStatus = `用户暂停了${pomoIsExercise ? '运动计时' : '番茄钟'}（${pomoIsExercise ? '项目' : '任务'}「${pomoTask}」），可能需要休息或有事。`;
            }
            if (pomoStatus) {
                systemContent += `\n\n[番茄钟状态]\n${pomoStatus}`;
            }
        }

        // Pomodoro Memory Sync: inject pomodoro history when enabled per-chat
        try {
            const pomoMemSyncEnabled = (typeof getChatPomoMemorySync === 'function') && getChatPomoMemorySync();
            if (pomoMemSyncEnabled) {
                const pomoTasks = JSON.parse(localStorage.getItem('faye-phone-pomodoro-tasks') || '[]');
                const pomoSessions = JSON.parse(localStorage.getItem('faye-phone-pomodoro-sessions') || '[]');
                if (pomoTasks.length > 0 || pomoSessions.length > 0) {
                    let pomoCtx = '\n\n[番茄钟记忆同步]\n';
                    if (pomoTasks.length > 0) {
                        pomoCtx += '用户的番茄钟任务：' + pomoTasks.map(t =>
                            `${t.name}(已完成${t.completed || 0}次)`).join('、') + '\n';
                    }
                    if (pomoSessions.length > 0) {
                        const recent = pomoSessions.slice(0, 10);
                        pomoCtx += '近期专注记录：\n';
                        recent.forEach(s => {
                            const d = new Date(s.timestamp);
                            const dateStr = d.toLocaleDateString();
                            const statusLabel = s.status === 'completed' ? '完成' : '放弃';
                            pomoCtx += `- ${dateStr}: ${s.task}, ${s.elapsed}/${s.duration}分钟, ${statusLabel}\n`;
                        });
                    }
                    systemContent += pomoCtx;
                }
            }
        } catch (e) { console.error('Pomodoro memory sync error:', e); }

        // Music Sharing: inject music sharing instruction
        systemContent += `\n\n[音乐分享功能]
当你想分享或推荐音乐时，使用以下标签：
<music id="网易云歌曲ID" server="netease"/>
例如：<music id="591321" server="netease"/>
系统会自动从API获取歌曲信息并渲染为音乐卡片。
请仅在自然想要分享歌曲时使用，不要频繁使用。使用真实的网易云音乐歌曲ID。
用户也可能会分享音乐链接给你，你会在聊天记录中看到[音乐卡片]的消息。`;

        systemContent += formatInstruction + mobileChatPrompt;

        // === Moments Integration: Gather uninteracted moments for this NPC ===
        try {
            if (typeof loadMomentsData === 'function') loadMomentsData();
            if (typeof momentsPosts !== 'undefined' && Array.isArray(momentsPosts) && momentsPosts.length > 0) {
                // Determine which NPC names are involved in this chat
                let npcNamesInChat = [];
                if (isGroupGeneration && groupMembers.length > 0) {
                    npcNamesInChat = [...groupMembers];
                } else if (charName) {
                    npcNamesInChat = [charName];
                }

                if (npcNamesInChat.length > 0) {
                    // Find moments where none of the current NPCs have liked or commented
                    const uninteractedMoments = momentsPosts.filter(post => {
                        // Skip posts authored by the NPCs themselves
                        if (npcNamesInChat.includes(post.author)) return false;
                        // Check if any NPC in this chat has already interacted
                        const hasLiked = npcNamesInChat.some(name => (post.likes || []).includes(name));
                        const hasCommented = npcNamesInChat.some(name =>
                            (post.comments || []).some(c => c.author === name)
                        );
                        return !hasLiked && !hasCommented;
                    });

                    // Take at most 3 uninteracted moments to avoid bloating the prompt
                    const momentsToShow = uninteractedMoments.slice(0, 3);

                    if (momentsToShow.length > 0) {
                        let momentsPrompt = `\n\n[朋友圈互动 - 可选]
你的好友发了以下朋友圈动态，你还没有互动过。如果你想回应，可以在聊天消息之后（或之前）额外输出朋友圈回复。
这是可选的，不必每条都回复，根据你的兴趣和角色性格自然选择。

格式（每条回复一个标签）:
- 评论: <moment_reply id="动态ID" type="comment" from="你的名字">评论内容</moment_reply>
- 点赞: <moment_reply id="动态ID" type="like" from="你的名字"/>

未互动的朋友圈动态：
`;
                        momentsToShow.forEach(post => {
                            const existingComments = (post.comments || []).slice(-3).map(c =>
                                `  ${c.author}：${c.text}`
                            ).join('\n');
                            momentsPrompt += `- ID: ${post.id} | 作者: ${post.author} | 内容: "${(post.text || '').substring(0, 80)}"${existingComments ? '\n  已有评论:\n' + existingComments : ''}\n`;
                        });
                        momentsPrompt += `\n注意：朋友圈回复是附加的，不要替代聊天消息。先正常回复聊天，然后根据兴趣选择性回复朋友圈。评论内容要自然简短（5-20字）。`;
                        systemContent += momentsPrompt;
                    }
                }
            }
        } catch (e) {
            console.error('Moments integration error:', e);
        }
        messages.push({ role: 'system', content: systemContent });


        if (currentChatTag) {
            const savedHistoryArr = await getChatHistory(currentChatTag);
            if (savedHistoryArr && savedHistoryArr.length > 0) {
                const recent = savedHistoryArr;

                recent.forEach(msg => {
                    const isUserMsg = (msg.header && msg.header.includes(getUserName())) || msg.isUser;
                    const role = isUserMsg ? 'user' : 'assistant';
                    let content = msg.body;

                    // Strip CoT / thought content before sending to AI
                    // Remove *thought* inner voice at end of message (inner voice mode)
                    if (content) {
                        content = content.replace(/\*[^*]+\*\s*$/, '').trim();
                        // Enhanced CoT stripping
                        content = content.replace(/<(think|thinking)[\s\S]*?<\/(think|thinking)>/gi, '').trim();
                    }
                    // Remove any residual <think>...</think> blocks
                    if (content) {
                        content = content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
                    }

                    // Handle special message types for context
                    // Derive type from header type marker for accurate AI context
                    const h = msg.header || '';
                    const isUserPhoto = h.includes('|\u56fe\u7247|') || h.includes('| \u56fe\u7247 |') || msg.type === 'photo';
                    const isUserSticker = h.includes('|\u8868\u60c5\u5305|') || h.includes('| \u8868\u60c5\u5305 |') || msg.type === 'sticker';
                    const isUserVoice = h.includes('|\u8bed\u97f3|') || h.includes('| \u8bed\u97f3 |') || msg.type === 'voice';
                    const isUserVideo = h.includes('|\u89c6\u9891|') || h.includes('| \u89c6\u9891 |') || msg.type === 'video';
                    const isUserFile = h.includes('|\u6587\u4ef6|') || h.includes('| \u6587\u4ef6 |') || msg.type === 'file';
                    const isUserTrans = h.includes('|TRANS|') || h.includes('| TRANS |') || h.includes('|\u8f6c\u8d26|') || msg.type === 'transfer';
                    const isUserLoc = h.includes('|\u4f4d\u7f6e|') || h.includes('| \u4f4d\u7f6e |') || msg.type === 'location';
                    const isUserLink = h.includes('|LINK|') || h.includes('| LINK |') || msg.type === 'link';
                    const isUserMusic = h.includes('|MUSIC|') || h.includes('| MUSIC |') || msg.type === 'music';

                    if (isUserPhoto) {
                        content = '[图片]';
                    } else if (isUserSticker) {
                        // Extract sticker name from body
                        const stickerBody = msg.body || '';
                        const stickerNameMatch = stickerBody.match(/^([^\s]{1,20})(?=https?:|\/|[\w\-]+\.[a-zA-Z]{3,4})/);
                        const stickerName = stickerNameMatch ? stickerNameMatch[1].trim() : stickerBody.replace(/https?:\/\/\S+/, '').trim().slice(0, 20);
                        content = `[表情包：${stickerName || '表情包'}]`;
                    } else if (isUserVoice) {
                        const voiceParts = (msg.body || '').split('|');
                        const dur = parseInt(voiceParts[0]) || 0;
                        const voiceTxt = voiceParts.slice(1).join('|').trim();
                        content = dur ? `[语音 ${dur}秒${voiceTxt ? '：' + voiceTxt : ''}]` : '[语音]';
                    } else if (isUserVideo) {
                        content = '[视频]';
                    } else if (isUserFile) {
                        const fileName = (msg.body || '').split('|')[0].trim();
                        content = `[文件：${fileName || '文件'}]`;
                    } else if (isUserTrans) {
                        const amount = (msg.body || '').split('|')[0].trim();
                        content = `[转账：${amount || '未知'}]`;
                    } else if (isUserLoc) {
                        const placeName = (msg.body || '').split('|')[0].trim();
                        content = `[位置：${placeName || '未知'}]`;
                    } else if (isUserMusic) {
                        const musicBodyParts = (msg.body || '').split('|');
                        const mName = musicBodyParts[0] === 'APIMUSIC' ? '歌曲' : (musicBodyParts[0] || '歌曲');
                        const mArtist = musicBodyParts[0] === 'APIMUSIC' ? '' : (musicBodyParts[1] || '');
                        content = `[分享了音乐：${mName}${mArtist ? ' - ' + mArtist : ''}]`;
                    } else if (isUserLink) {
                        const linkTitle = (msg.body || '').split('|')[0].trim();
                        content = `[链接：${linkTitle || '链接'}]`;
                    }

                    // For group chats, prepend sender name to assistant messages for context
                    if (isGroupGeneration && !isUserMsg && msg.header) {
                        const headerParts = msg.header.replace(/^[\[【]|[\]】]$/g, '').split('|');
                        const senderName = headerParts[0] ? headerParts[0].trim() : '';
                        if (senderName && senderName !== getUserName()) {
                            content = `[${senderName}] ${content}`;
                        }
                    }

                    messages.push({ role, content });
                });
            }
        }

        // Add current user message (if not already in history, but usually it is added before trigger)
        // Actually, renderMessageToUI adds to history. So it's already there.

        // Handle Multimodal (Vision) for the LATEST user message if it was an image
        // We stored lastUploadedImageForAI in script.js
        if (lastUploadedImageForAI) {
            // Find the last user message and replace content with array
            const lastUserMsgIndex = messages.findLastIndex(m => m.role === 'user');
            if (lastUserMsgIndex !== -1) {
                const txtContent = messages[lastUserMsgIndex].content === '[图片]' ? '' : messages[lastUserMsgIndex].content;
                messages[lastUserMsgIndex].content = [
                    { type: "text", text: txtContent || "Analyze this image" },
                    { type: "image_url", image_url: { url: lastUploadedImageForAI } }
                ];
            }
            lastUploadedImageForAI = null; // Reset
        }

        // --- D2 Format Reminder Injection ---
        // Inject a strict format reminder just before the last user message to prevent format drifting in long contexts
        const formatReminder = "[系统提示：请严格遵守通信协议，使用正确的 XML <msg> 标签包裹你的所有回复内容。禁止使用 Markdown 代码块包裹 XML。]";
        const lastUserIdx = messages.findLastIndex(m => m.role === 'user');
        if (lastUserIdx !== -1) {
            messages.splice(lastUserIdx, 0, { role: 'system', content: formatReminder });
        } else {
            messages.push({ role: 'system', content: formatReminder });
        }

        // 2. Call API
        const stream = await callLLM(messages);

        // 3. Handle Stream
        await handleGenerationResponse(stream);

        // === Group Sync: Cross-chat trigger ===
        try {
            const groupSyncOn = (typeof getChatGroupSync === 'function') && getChatGroupSync();
            if (groupSyncOn && appSettings.groups && Array.isArray(appSettings.groups) && Math.random() < 0.35) {
                const isGroupGen = currentChatTag && currentChatTag.startsWith('group:');
                if (!isGroupGen) {
                    // Private chat finished → maybe send a message to a group this NPC is in
                    const charN = getCharName();
                    const npcGroups = appSettings.groups.filter(g =>
                        g.members && g.members.includes(charN)
                    );
                    if (npcGroups.length > 0) {
                        const targetGroup = npcGroups[Math.floor(Math.random() * npcGroups.length)];
                        const groupTag = `group_${targetGroup.name || targetGroup.id}`;
                        setTimeout(() => {
                            if (typeof triggerAIAutoMessage === 'function') {
                                triggerAIAutoMessage(groupTag);
                            }
                        }, 2000 + Math.random() * 3000);
                    }
                } else {
                    // Group chat finished → maybe trigger a private chat from a random member
                    const groupName = currentChatTag.replace(/^group:/, '');
                    const group = appSettings.groups.find(g => g.name === groupName || g.id === groupName);
                    if (group && group.members) {
                        const userName = getUserName();
                        const npcMembers = group.members.filter(m =>
                            m !== userName && npcCharacters.find(n => n.name === m)
                        );
                        if (npcMembers.length > 0) {
                            const randomMember = npcMembers[Math.floor(Math.random() * npcMembers.length)];
                            setTimeout(() => {
                                if (typeof triggerAIAutoMessage === 'function') {
                                    triggerAIAutoMessage(randomMember);
                                }
                            }, 3000 + Math.random() * 5000);
                        }
                    }
                }
            }
        } catch (e) {
            console.error('Group sync cross-chat trigger error:', e);
        }

    } catch (e) {
        console.error('Generation failed:', e);
        // Remove typing indicator
        const typing = document.getElementById('typing-bubble');
        if (typing) typing.remove();

        // Show error bubble
        renderMessageToUI({
            header: `[System|Error]`,
            body: `生成失败: ${e.message}`,
            isUser: false
        });
    }
}

async function handleGenerationResponse(stream) {
    const reader = stream.getReader();
    const decoder = new TextDecoder();

    // --- Debug Panel ---
    let debugContent = null;
    if (appSettings.debugMode) {
        const overlay = document.createElement('div');
        overlay.id = 'debug-overlay';
        overlay.style.cssText = 'position:fixed;bottom:0;left:0;right:0;height:40%;background:rgba(0,0,0,0.92);z-index:9999;display:flex;flex-direction:column;border-top:2px solid #00ff88;font-family:monospace;';
        const hdr = document.createElement('div');
        hdr.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:6px 12px;background:rgba(0,255,136,0.1);flex-shrink:0;';
        hdr.innerHTML = '<span style="color:#00ff88;font-size:12px;font-weight:bold;">DEBUG - AI 原始输出</span>';
        const closeBtn = document.createElement('span');
        closeBtn.textContent = '✕';
        closeBtn.style.cssText = 'color:#ff6b6b;cursor:pointer;font-size:16px;padding:0 4px;';
        closeBtn.onclick = () => overlay.remove();
        hdr.appendChild(closeBtn);
        overlay.appendChild(hdr);
        debugContent = document.createElement('pre');
        debugContent.style.cssText = 'flex:1;overflow-y:auto;padding:8px 12px;margin:0;color:#00ff88;font-size:12px;line-height:1.5;white-space:pre-wrap;word-break:break-all;';
        overlay.appendChild(debugContent);
        document.body.appendChild(overlay);
    }
    function debugLog(text) {
        if (debugContent) { debugContent.textContent += text; debugContent.scrollTop = debugContent.scrollHeight; }
    }

    // ====== Phase 1: Collect all raw output while showing typing indicator ======
    let rawOutput = '';
    let streamBuffer = '';
    let isThinking = false;

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        streamBuffer += chunk;
        const lines = streamBuffer.split('\n');
        streamBuffer = lines.pop();

        for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const dataStr = line.slice(6);
            if (dataStr === '[DONE]') continue;

            try {
                const data = JSON.parse(dataStr);
                const delta = data.choices[0].delta;

                // Skip reasoning_content (DeepSeek R1)
                if (delta.reasoning_content) {
                    debugLog('[THINK] ' + delta.reasoning_content);
                    continue;
                }

                if (delta.content) {
                    let content = delta.content;
                    debugLog(content);

                    // Handle <think> tags
                    if (isThinking) {
                        content = content.substring(endIdx + 8);
                        const endIdx = content.indexOf('</think>');
                        if (endIdx !== -1) {
                            content = content.substring(endIdx + 8);
                            isThinking = false;
                        } else {
                            continue; // Still thinking, skip
                        }
                    }

                    // Check for <think> start in remaining content
                    const thinkStart = content.indexOf('<think>');
                    if (thinkStart !== -1) {
                        const before = content.substring(0, thinkStart);
                        rawOutput += before;
                        const afterThink = content.substring(thinkStart + 7);
                        const thinkEnd = afterThink.indexOf('</think>');
                        if (thinkEnd !== -1) {
                            rawOutput += afterThink.substring(thinkEnd + 8);
                        } else {
                            isThinking = true;
                        }
                    } else {
                        rawOutput += content;
                    }
                }
            } catch (e) { /* parse error */ }
        }
    }

    // ====== Phase 2: XML Parsing & Adapter ======
    // Replace regex splitting with XML tag extraction for robustness

    // Convert fp_accept/fp_reject commands into processable XML messages to maintain exact order
    rawOutput = rawOutput.replace(/<cmd\s+action=["']fp_accept["']([^>]*)>(?:<\/cmd>)?/gi, '<msg type="fp"$1>accept</msg>');
    rawOutput = rawOutput.replace(/<cmd\s+action=["']fp_reject["']([^>]*)>(?:<\/cmd>)?/gi, '<msg type="fp"$1>reject</msg>');

    // Convert rp_open to processable message
    rawOutput = rawOutput.replace(/<cmd\s+action=["']rp_open["']([^>]*)>(?:<\/cmd>)?/gi, '<msg type="rp"$1>open</msg>');

    // 1. Handle Commands (Self-closing tags)
    // Match <cmd action="block"/> or <cmd action='unblock'/> or <cmd action="friend_request" message="..."/>
    const cmdRegex = /<cmd\s+action=["'](.*?)["'](?:\s+message=["'](.*?)["'])?\s*(?:\/?>|><\/cmd>)/gi;
    let cmdMatch;
    while ((cmdMatch = cmdRegex.exec(rawOutput)) !== null) {
        const action = cmdMatch[1];
        const message = cmdMatch[2];
        if (action === 'block') {
            setChatBlockState('blockUser', true);
            appSettings.blockUser = getChatBlockUser(); // sync legacy
            saveSettingsToStorage();
            if (typeof updateBlockedNoticeBar === 'function') updateBlockedNoticeBar();
        } else if (action === 'unblock') {
            setChatBlockState('blockUser', false);
            appSettings.blockUser = getChatBlockUser(); // sync legacy
            saveSettingsToStorage();
            if (typeof updateBlockedNoticeBar === 'function') updateBlockedNoticeBar();
        } else if (action === 'friend_request') {
            // Send friend request
            const charName = getCharName();
            const existingRequest = appSettings.friendRequests.find(r => r.from === charName);
            if (!existingRequest) {
                appSettings.friendRequests.push({
                    from: charName,
                    message: message || '我想和你重新做朋友',
                    timestamp: Date.now()
                });
                saveSettingsToStorage();
                // Show notification to user
                showToast(`${charName} 申请加为好友`);
                renderContacts(); // Update contacts to show red dot
            }
        }
    }

    // Handle toy commands (self-closing tags with action="toy")
    const toyCmdRegex = /<cmd\s+action=["']toy["']([^>]*)>(?:<\/cmd>)?/gi;
    let toyMatch;
    while ((toyMatch = toyCmdRegex.exec(rawOutput)) !== null) {
        let attrsStr = toyMatch[1] || '';
        // If it was self-closing, remove the trailing slash
        if (attrsStr.endsWith('/')) {
            attrsStr = attrsStr.slice(0, -1);
        }

        const getAttr = (name) => {
            // Match with or without quotes
            const m = attrsStr.match(new RegExp(`${name}=["']([^"']*)["']`)) || attrsStr.match(new RegExp(`${name}=([^"'\s>]+)`));
            return m ? m[1] : null;
        };

        const toyCmd = {
            mode: getAttr('mode'),
            level: getAttr('level'),
            duration: getAttr('duration'),
            pattern: getAttr('pattern'),
            beat: getAttr('beat')
        };
        console.log('[Toy] Executing command from AI:', toyCmd, '\nRaw attrs:', attrsStr);
        try {
            executeToyCommand(toyCmd);
        } catch (e) {
            console.error('[Toy] Command execution error:', e);
        }
    }

    // Handle visual rendering of toy commands based on offline/online mode
    if (!isOfflineMode) {
        rawOutput = rawOutput.replace(/<cmd\s+action=["']toy["'][^>]*>(?:<\/cmd>)?/gi,
            '<msg type="text"><toy></msg>');
    } else {
        // Strip toy commands from rawOutput to prevent them from appearing in messages
        rawOutput = rawOutput.replace(/<cmd\s+action=["']toy["'][^>]*>(?:<\/cmd>)?/gi, '');
    }

    // Handle <music> tags from AI (e.g. <music id="591321" server="netease"/>)
    // Convert to <msg type="music"> for consistent processing
    const musicTagRegex = /<music\s+([^>]*?)\/?\s*>/gi;
    let musicMatch;
    while ((musicMatch = musicTagRegex.exec(rawOutput)) !== null) {
        const musicAttrs = musicMatch[1];
        const getMusicAttr = (name) => {
            const m = musicAttrs.match(new RegExp(`${name}=["']([^"']*)["']`));
            return m ? m[1] : null;
        };
        const musicId = getMusicAttr('id');
        const musicServer = getMusicAttr('server') || 'netease';
        if (musicId) {
            // Replace the <music> tag with a <msg type="music"> that includes the ID
            const replacement = `<msg type="music" t="${getTime()}">APIMUSIC|${musicId}|${musicServer}</msg>`;
            rawOutput = rawOutput.replace(musicMatch[0], replacement);
            // Reset regex lastIndex since we modified the string
            musicTagRegex.lastIndex = 0;
        }
    }

    // 2. Parse Messages <msg ...>...</msg>
    // Regex to capture attributes (group 1) and content (group 2)
    const msgRegex = /<msg\s+([^>]*?)>(.*?)<\/msg>/gis;
    const segments = [];
    let match;
    // Keep track if we found any valid XML messages
    let foundXml = false;

    while ((match = msgRegex.exec(rawOutput)) !== null) {
        foundXml = true;
        const attrsStr = match[1];
        let content = match[2].trim();

        // Helper to extract attribute value
        const getAttr = (name) => {
            const m = attrsStr.match(new RegExp(`${name}=["'](.*?)["']`));
            return m ? m[1] : null;
        };

        const type = getAttr('type') || 'text';
        const t = getAttr('t') || getTime(); // Fallback to current time
        const charName = getCharName();
        // Group chat: use 'from' attribute as sender name
        const fromName = getAttr('from') || charName;

        // --- Adapter: Convert XML data back to Internal Bracket Format ---
        // This maintains compatibility with renderMessageToUI and localStorage history
        let header = `[${fromName}|${t}]`; // Default header
        let body = content;

        switch (type) {
            case 'rp':
                header = `[${fromName}|${t}]`;
                body = `[${fromName}|领取了红包]`;
                break;
            case 'fp':
                header = `[${fromName}|${t}]`;
                body = `[${fromName}|代付已${content === 'accept' ? '接收' : '拒绝'}]`;
                break;
            case 'voice':
                header = `[${fromName}|\u8bed\u97f3|${t}]`;
                const dur = getAttr('dur') || Math.max(1, Math.ceil(content.length / 3)); // Estimate dur if missing
                body = `${dur}|${content}`;
                break;
            case 'img':
                header = `[${fromName}|\u56fe\u7247|${t}]`;
                break;
            case 'sticker':
                header = `[${fromName}|\u8868\u60c5\u5305|${t}]`;
                break;
            case 'video':
                header = `[${fromName}|\u89c6\u9891|${t}]`;
                break;
            case 'file':
                header = `[${fromName}|\u6587\u4ef6|${t}]`;
                break;
            case 'trans':
                header = `[${fromName}|TRANS|${t}]`;
                // content should be amount|note
                break;
            case 'loc':
                header = `[${fromName}|\u4f4d\u7f6e|${t}]`;
                break;
            case 'link':
                header = `[${fromName}|LINK|${t}]`;
                break;
            case 'call':
                header = `[${fromName}|CALL|${t}]`; // Auto triggers call UI
                break;
            case 'deliver':
                header = `[${fromName}|DELIVER|${t}]`;
                break;
            case 'redpacket':
                header = `[${fromName}|REDPACKET|${t}]`;
                break;
            case 'music':
                header = `[${fromName}|MUSIC|${t}]`;
                break;
        }

        // Handle recall tag within content or as a type?
        // Prompt says: append <recall/> to content
        // Just let content pass through, renderMessageToUI handles <recall> in body string

        segments.push({ header, body });
    }

    // Remove typing indicator
    const typing = document.getElementById('typing-bubble');
    if (typing) typing.remove();

    // === Parse Moments Replies (before fallback, so tags don't leak into chat) ===
    try {
        // Parse <moment_reply> tags for moments interaction
        const momentReplyRegex = /<moment_reply\s+([^>]*?)(?:\/>|>(.*?)<\/moment_reply>)/gis;
        let momentMatch;
        while ((momentMatch = momentReplyRegex.exec(rawOutput)) !== null) {
            const attrsStr = momentMatch[1];
            const content = (momentMatch[2] || '').trim();

            const getMomentAttr = (name) => {
                const m = attrsStr.match(new RegExp(`${name}=["'](.*?)["']`));
                return m ? m[1] : null;
            };

            const momentId = getMomentAttr('id');
            const momentType = getMomentAttr('type');
            const momentFrom = getMomentAttr('from');

            if (momentId && typeof momentsPosts !== 'undefined') {
                const targetPost = momentsPosts.find(p => p.id === momentId);
                if (targetPost) {
                    if (momentType === 'like' && momentFrom) {
                        if (!targetPost.likes) targetPost.likes = [];
                        if (!targetPost.likes.includes(momentFrom)) {
                            targetPost.likes.push(momentFrom);
                        }
                    } else if (momentType === 'comment' && content && momentFrom) {
                        if (!targetPost.comments) targetPost.comments = [];
                        targetPost.comments.push({
                            author: momentFrom,
                            text: content,
                            timestamp: Date.now()
                        });
                    }
                }
            }
        }
        // Save moments if any were updated
        if (rawOutput.includes('<moment_reply')) {
            if (typeof saveMomentsData === 'function') {
                saveMomentsData();
            }
        }
    } catch (e) {
        console.error('Moments reply parsing error:', e);
    }

    // Strip moment_reply tags from rawOutput to prevent them appearing in chat
    rawOutput = rawOutput.replace(/<moment_reply\s+[^>]*?(?:\/>|>.*?<\/moment_reply>)/gis, '');

    // Fallback: If no XML tags found, treat as plain text (legacy/fallback mode)
    if (!foundXml && rawOutput.trim()) {
        segments.push({ header: `[${getCharName()}|${getTime()}]`, body: rawOutput.trim() });
    }

    // Render each message with delay
    for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        if (!seg.body && !seg.header) continue;

        // Show typing indicator before each message (except the first)
        if (i > 0) {
            showTypingIndicator();
            await new Promise(r => setTimeout(r, 600 + Math.random() * 600));
            const t2 = document.getElementById('typing-bubble');
            if (t2) t2.remove();
        }

        // Build the header if missing
        const u = getCharName();
        const finalHeader = seg.header || `[${u}|${getTime()}]`;

        // Check for CALL command
        if (finalHeader.includes('|CALL|') || finalHeader.includes('| CALL |')) {
            receiveVoiceCall();
            continue;
        }

        // Render through renderMessageToUI
        // 如果用户拉黑了角色(blockChar)，在AI消息body开头加<blocked>标签持久化
        let finalBody = seg.body || '';
        // Ensure no <think> tokens remain in the final stored message (Enhanced Regex)
        finalBody = finalBody.replace(/<(think|thinking)[\s\S]*?<\/(think|thinking)>/gi, '').trim();

        if (getChatBlockChar()) {
            finalBody = `<blocked>${finalBody}`;
        }

        // NAI Image Generation: if this is an image message and NAI is enabled, generate the image
        const isImgMessage = finalHeader.includes('\u56fe\u7247') || finalHeader.includes('|IMG|');
        if (isImgMessage && getChatNaiEnabled() && appSettings.naiApiKey && !getChatBlockChar()) {
            try {
                console.log('[NAI] Detected AI image message, generating with tags:', finalBody);
                showToast('🎨 NAI 生图中...');
                const naiImageDataUrl = await generateNaiImage(finalBody);
                if (naiImageDataUrl) {
                    finalBody = naiImageDataUrl;
                    console.log('[NAI] Image generated successfully');
                }
            } catch (naiErr) {
                console.error('[NAI] Image generation failed:', naiErr);
                showToast('NAI 生图失败: ' + naiErr.message);
                // Keep original tag description as fallback
            }
        }

        renderMessageToUI({
            header: finalHeader,
            body: finalBody,
            isUser: false
        });

        chatMessages.scrollTop = chatMessages.scrollHeight;
    }

    // Save to history
    saveCurrentChatHistory();
    checkTokenUsage();
}

function checkTokenUsage() {
    if (!currentChatTag) return;

    // 调用现有的 updateTokenStats 来更新显示数值
    if (typeof updateTokenStats === 'function') {
        updateTokenStats();
    }

    const historyTokensEl = document.getElementById('token-chat-history');
    if (historyTokensEl && historyTokensEl.textContent) {
        const historyTokens = parseInt(historyTokensEl.textContent, 10);
        if (!isNaN(historyTokens) && historyTokens > 8000) {
            showToast(`当前对话记录约 ${historyTokens} Token，如果明显出现卡顿智降，建议总结`);
        }
    }
}



// Helper to update last transfer status
function updateLastTransferStatus(status) {
    // Find last SENT transfer card that is NOT completed
    const sentTransfers = Array.from(document.querySelectorAll('.transfer-card.sent:not(.completed)'));
    if (sentTransfers.length === 0) return;

    const el = sentTransfers[sentTransfers.length - 1];
    const statusTextEl = el.querySelector('.transfer-bottom');

    if (status === 'received') {
        el.classList.add('completed');
        if (statusTextEl) statusTextEl.textContent = '已收款';
    } else if (status === 'returned') {
        el.classList.add('completed');
        if (statusTextEl) statusTextEl.textContent = '已退回';
    }

    // Update data-raw-body for persistence
    if (el.dataset.rawBody) {
        const parts = el.dataset.rawBody.split('|');
        // rawBody format: amount|note|status
        if (parts.length >= 2) {
            el.dataset.rawBody = `${parts[0]}|${parts[1]}|${status}`;
        }
    }

    // Save history
    saveCurrentChatHistory();
}

// Expose functions to global scope for HTML onclick handlers
/* ================== URL Upload System ================== */
let currentUrlUploadTarget = null;
const URL_PREFIX = 'https://img.phey.click/';

function openUrlUploadModal(target) {
    currentUrlUploadTarget = target;
    const input = document.getElementById('url-upload-input');
    if (input) input.value = '';
    const modal = document.getElementById('url-upload-modal');
    if (modal) {
        modal.style.display = 'flex';
        // Delay adding 'show' to trigger CSS transition
        setTimeout(() => modal.classList.add('show'), 10);
        if (input) setTimeout(() => input.focus(), 100);
    }
}

function closeUrlUploadModal() {
    const modal = document.getElementById('url-upload-modal');
    if (modal) {
        modal.classList.remove('show');
        // Wait for transition to finish before hiding
        setTimeout(() => modal.style.display = 'none', 300);
    }
    currentUrlUploadTarget = null;
}

function confirmUrlUpload() {
    const input = document.getElementById('url-upload-input');
    let val = input.value.trim();
    if (!val) {
        closeUrlUploadModal();
        return;
    }

    // Auto-prepend logic
    let finalUrl = val;
    // If not starting with http/https/data, assume it's a suffix
    if (!val.startsWith('http') && !val.startsWith('data:')) {
        // Ensure no double slash if user typed /suffix
        if (val.startsWith('/')) val = val.substring(1);
        finalUrl = URL_PREFIX + val;
    }

    // Apply to target
    if (currentUrlUploadTarget === 'chat-bg') {
        const img = document.getElementById('preview-chat-bg');
        if (img) {
            img.src = finalUrl;
            img.style.display = 'block';
        }
    } else if (currentUrlUploadTarget === 'home-bg') {
        const img = document.getElementById('preview-home-bg');
        if (img) img.src = finalUrl;
    } else if (currentUrlUploadTarget === 'npc-avatar') {
        const img = document.getElementById('npc-avatar-preview');
        if (img) img.src = finalUrl;
    } else if (currentUrlUploadTarget === 'user-avatar') {
        const img = document.getElementById('user-avatar-preview');
        if (img) img.src = finalUrl;
    } else if (currentUrlUploadTarget === 'forum-avatar') {
        if (typeof saveForumProfile === 'function') {
            saveForumProfile({ avatar: finalUrl });
        }
    }

    closeUrlUploadModal();
    if (typeof showToast === 'function') showToast('✅ 链接已应用');
}
// ====== Regex Script System ======
let regexRules = [];
let editingRegexIndex = -1; // -1 = new, >=0 = editing existing

function loadRegexRules() {
    try {
        const saved = localStorage.getItem('faye-phone-regex-rules');
        if (saved) {
            regexRules = JSON.parse(saved);
        } else {
            // Default Rules
            regexRules = [
                // CN Rules
                { name: '[CN] 暴躁替代', pattern: '操你妈', replace: '劁你爹', applyToUser: false, applyToAI: true, enabled: true },
                { name: '[CN] 暴躁替代', pattern: '他妈的|他娘的', replace: '他爹的', applyToUser: false, applyToAI: true, enabled: true },
                { name: '[CN] 侮辱:人', pattern: '傻逼', replace: '傻屌', applyToUser: false, applyToAI: true, enabled: true },
                { name: '[CN] 侮辱:特征', pattern: '像个娘们|像个娘们儿', replace: '像个太监', applyToUser: false, applyToAI: true, enabled: true },
                { name: '[CN] 赞美/力量', pattern: '太屌了|太棒了', replace: '太蒂了', applyToUser: false, applyToAI: true, enabled: true },
                { name: '[CN] 信仰/感叹', pattern: '老天爷', replace: '天姥姥', applyToUser: false, applyToAI: true, enabled: true },

                // EN Rules
                { name: '[EN] Violence', pattern: '[Mm]otherfucker', replace: 'Daddy-fucker', applyToUser: false, applyToAI: true, enabled: true },
                { name: '[EN] Insult: Person', pattern: '([Bb]itch|[Cc]unt|[Ww]hore)', replace: 'Male dog', applyToUser: false, applyToAI: true, enabled: true },
                { name: '[EN] Insult: Trait', pattern: '([Ss]issy|[Ll]ike a girl)', replace: 'Like a eunuch', applyToUser: false, applyToAI: true, enabled: true },
                { name: '[EN] Praise', pattern: '[Tt]he balls', replace: 'The Clit', applyToUser: false, applyToAI: true, enabled: true },
                { name: '[EN] Deity', pattern: '(Oh [Ll]ord|Oh [Gg]od)', replace: 'Oh Goddess', applyToUser: false, applyToAI: true, enabled: true }
            ];
        }
    } catch (e) { regexRules = []; }
}

function saveRegexRules() {
    try {
        localStorage.setItem('faye-phone-regex-rules', JSON.stringify(regexRules));
    } catch (e) { console.error('Failed to save regex rules', e); }
}

function openRegexScreen() {
    if (homeScreen) homeScreen.style.display = 'none';
    const screen = document.getElementById('regex-screen');
    if (screen) screen.style.display = 'flex';
    updateStatusBar('settings');
    renderRegexList();
}

function closeRegexScreen() {
    const screen = document.getElementById('regex-screen');
    if (screen) screen.style.display = 'none';
    if (homeScreen) homeScreen.style.display = 'flex';
    updateStatusBar('home');
}

function renderRegexList() {
    const container = document.getElementById('regex-list-container');
    if (!container) return;
    container.innerHTML = '';

    if (regexRules.length === 0) {
        container.innerHTML = '<div class="regex-empty-hint">还没有正则规则<br>点击右上角 + 添加</div>';
        return;
    }

    regexRules.forEach((rule, index) => {
        const card = document.createElement('div');
        card.className = 'regex-rule-card';
        card.innerHTML = `
                <div class="regex-rule-header">
                    <div class="regex-rule-name">${rule.name || '未命名规则'}</div>
                    <label class="wb-entry-switch" style="margin-right: 15px;">
                        <input type="checkbox" ${rule.enabled ? 'checked' : ''} onchange="toggleRegexRule(${index}, this.checked)">
                        <span class="wb-slider"></span>
                    </label>
                </div>
                <div class="regex-rule-detail">/${rule.pattern}/g → ${rule.replace || '(删除)'}</div>
                <div class="regex-rule-tags">
                    <span class="regex-rule-tag ${rule.applyToUser ? 'active' : ''}">User</span>
                    <span class="regex-rule-tag ${rule.applyToAI ? 'active' : ''}">AI</span>
                </div>
            `;

        let pressTimer = null;
        let isDragging = false;
        card.addEventListener('touchstart', (e) => {
            if (e.target.closest('.regex-rule-toggle')) return;
            isDragging = false;
            pressTimer = setTimeout(() => {
                if (!isDragging) showGlobalDeleteMenu(rule.name || '未命名规则', () => deleteRegexRule(index));
            }, 600);
        }, { passive: true });
        card.addEventListener('touchmove', () => { isDragging = true; clearTimeout(pressTimer); }, { passive: true });
        card.addEventListener('touchend', () => { clearTimeout(pressTimer); });
        card.addEventListener('touchcancel', () => { clearTimeout(pressTimer); });

        card.oncontextmenu = (e) => {
            e.preventDefault();
            showGlobalDeleteMenu(rule.name || '未命名规则', () => deleteRegexRule(index));
        };
        card.onclick = (e) => {
            if (e.target.closest('.regex-rule-toggle')) return;
            editRegexRule(index);
        };
        container.appendChild(card);
    });
}

function addNewRegexRule() {
    editingRegexIndex = -1;
    const title = document.getElementById('regex-edit-modal-title');
    if (title) title.textContent = '新建正则';
    document.getElementById('regex-edit-name').value = '';
    document.getElementById('regex-edit-pattern').value = '';
    document.getElementById('regex-edit-replace').value = '';
    document.getElementById('regex-edit-user').checked = false;
    document.getElementById('regex-edit-ai').checked = true;
    const modal = document.getElementById('regex-edit-modal');
    if (modal) modal.classList.add('show');
}

function editRegexRule(index) {
    const rule = regexRules[index];
    if (!rule) return;
    editingRegexIndex = index;
    const title = document.getElementById('regex-edit-modal-title');
    if (title) title.textContent = '编辑正则';
    document.getElementById('regex-edit-name').value = rule.name || '';
    document.getElementById('regex-edit-pattern').value = rule.pattern || '';
    document.getElementById('regex-edit-replace').value = rule.replace || '';
    document.getElementById('regex-edit-user').checked = !!rule.applyToUser;
    document.getElementById('regex-edit-ai').checked = !!rule.applyToAI;
    const modal = document.getElementById('regex-edit-modal');
    if (modal) modal.classList.add('show');
}

function closeRegexEditModal() {
    const modal = document.getElementById('regex-edit-modal');
    if (modal) modal.classList.remove('show');
    editingRegexIndex = -1;
}

function saveRegexRule() {
    const name = document.getElementById('regex-edit-name').value.trim();
    const pattern = document.getElementById('regex-edit-pattern').value;
    const replace = document.getElementById('regex-edit-replace').value;
    const applyToUser = document.getElementById('regex-edit-user').checked;
    const applyToAI = document.getElementById('regex-edit-ai').checked;

    if (!pattern) {
        showToast('请输入正则表达式');
        return;
    }

    // 验证正则是否合法
    try {
        new RegExp(pattern, 'g');
    } catch (e) {
        showToast('正则表达式语法错误: ' + e.message);
        return;
    }

    const rule = {
        name: name || '未命名规则',
        pattern: pattern,
        replace: replace,
        applyToUser: applyToUser,
        applyToAI: applyToAI,
        enabled: true
    };

    if (editingRegexIndex >= 0 && editingRegexIndex < regexRules.length) {
        // 编辑时保留 enabled 状态
        rule.enabled = regexRules[editingRegexIndex].enabled;
        regexRules[editingRegexIndex] = rule;
    } else {
        regexRules.push(rule);
    }

    saveRegexRules();
    closeRegexEditModal();
    renderRegexList();
    showToast('✅ 正则规则已保存');
}

function deleteRegexRule(index) {
    if (!confirm('确定删除这条正则规则？')) return;
    regexRules.splice(index, 1);
    saveRegexRules();
    renderRegexList();
}

function toggleRegexRule(index, enabled) {
    if (regexRules[index]) {
        regexRules[index].enabled = enabled;
        saveRegexRules();
    }
}

/**
 * 对文本应用所有启用的正则规则
 * @param {string} text - 要处理的文本
 * @param {boolean} isUser - true=用户消息, false=AI消息
 * @returns {string} 处理后的文本
 */
function applyRegexRules(text, isUser) {
    if (!text || regexRules.length === 0) return text;
    let result = text;
    for (const rule of regexRules) {
        if (!rule.enabled) continue;
        if (isUser && !rule.applyToUser) continue;
        if (!isUser && !rule.applyToAI) continue;
        try {
            const regex = new RegExp(rule.pattern, 'g');
            result = result.replace(regex, rule.replace || '');
        } catch (e) {
            console.warn('Regex rule error:', rule.name, e);
        }
    }
    return result;
}

// Load regex rules on startup
loadRegexRules();

// ===== 线下交流模式 (Offline Interaction Mode) =====
function toggleOfflineMode() {
    isOfflineMode = !isOfflineMode;

    // Persist per-chat
    if (currentChatTag) {
        const key = `faye-phone-offline-mode-${currentChatTag}`;
        localStorage.setItem(key, isOfflineMode ? '1' : '0');
    }

    updateOfflineModeUI();
    showToast(isOfflineMode ? '已进入线下交流模式' : '已退出线下交流模式');
}

function updateOfflineModeUI() {
    const btn = document.getElementById('offline-mode-btn');
    if (btn) {
        const img = btn.querySelector('img');
        if (img) {
            if (isOfflineMode) {
                img.src = 'https://api.iconify.design/lucide:door-open.svg?color=%23e88a9a';
            } else {
                img.src = 'https://api.iconify.design/material-symbols:door-back-outline.svg?color=%23181818';
            }
        }
    }

    // In offline mode, hide plus and emoji buttons (text-only input)
    if (plusButton) plusButton.style.display = isOfflineMode ? 'none' : '';
    if (emojiButton) emojiButton.style.display = isOfflineMode ? 'none' : '';
}

function loadOfflineModeForChat() {
    if (currentChatTag) {
        const key = `faye-phone-offline-mode-${currentChatTag}`;
        isOfflineMode = localStorage.getItem(key) === '1';
    } else {
        isOfflineMode = false;
    }
    updateOfflineModeUI();
}

// ===== AI Proactive Messaging & Notification System =====

// iOS-style push notification banner for AI messages & moments
function showAINotification(charName, message, options = {}) {
    const existing = document.querySelector('.ai-push-notification');
    if (existing) existing.remove();

    // Find avatar for the character
    let avatar = '';
    if (typeof npcCharacters !== 'undefined' && Array.isArray(npcCharacters)) {
        const npc = npcCharacters.find(n => n.name === charName);
        if (npc && npc.avatar) avatar = npc.avatar;
    }
    // Also check memberAvatars
    if (!avatar && appSettings.memberAvatars && appSettings.memberAvatars[charName]) {
        avatar = appSettings.memberAvatars[charName];
    }
    const placeholderAvatar = "data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='%23cccccc'%3E%3Cpath d='M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z'/%3E%3C/svg%3E";

    const notification = document.createElement('div');
    notification.className = 'ai-push-notification';

    // Truncate message preview
    const preview = message.length > 60 ? message.substring(0, 60) + '...' : message;
    const appName = options.appName || '微信';
    const timeStr = options.time || (typeof getTime === 'function' ? getTime(true) : '');

    notification.innerHTML = `
        <div style="display:flex;align-items:flex-start;gap:10px;width:100%;">
            <img src="${avatar || placeholderAvatar}" style="width:36px;height:36px;border-radius:8px;object-fit:cover;flex-shrink:0;background:#f0f0f0;">
            <div style="flex:1;min-width:0;">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:2px;">
                    <span style="font-size:13px;font-weight:600;color:#1c1c1e;">${appName}</span>
                    <span style="font-size:11px;color:#8e8e93;flex-shrink:0;">${timeStr}</span>
                </div>
                <div style="font-size:14px;font-weight:600;color:#1c1c1e;margin-bottom:1px;">${charName}</div>
                <div style="font-size:13px;color:#3c3c43;opacity:0.8;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${preview}</div>
            </div>
        </div>
    `;

    Object.assign(notification.style, {
        position: 'fixed',
        top: '8px',
        left: '8px',
        right: '8px',
        transform: 'translateY(-120%)',
        background: 'rgba(245, 245, 247, 0.92)',
        backdropFilter: 'blur(20px)',
        WebkitBackdropFilter: 'blur(20px)',
        padding: '12px 14px',
        borderRadius: '14px',
        zIndex: '99999',
        boxShadow: '0 2px 20px rgba(0, 0, 0, 0.15), 0 0 1px rgba(0, 0, 0, 0.1)',
        transition: 'transform 0.4s cubic-bezier(0.2, 0.8, 0.2, 1)',
        cursor: 'pointer',
        userSelect: 'none',
        lineHeight: '1.35'
    });

    // Click to open the chat
    const chatTag = options.chatTag || `chat:${charName}`;
    notification.onclick = () => {
        notification.style.transform = 'translateY(-120%)';
        setTimeout(() => notification.remove(), 300);
        if (typeof openChat === 'function') {
            openChat(chatTag, charName);
        }
        if (options.onClick) options.onClick();
    };

    document.body.appendChild(notification);

    requestAnimationFrame(() => {
        notification.style.transform = 'translateY(0)';
    });

    // Auto dismiss after 4 seconds
    const dismissTimer = setTimeout(() => {
        notification.style.transform = 'translateY(-120%)';
        setTimeout(() => notification.remove(), 400);
    }, options.duration || 4000);

    // Swipe up to dismiss
    let startY = 0;
    notification.addEventListener('touchstart', (e) => {
        startY = e.touches[0].clientY;
    }, { passive: true });
    notification.addEventListener('touchend', (e) => {
        const endY = e.changedTouches[0].clientY;
        if (startY - endY > 30) {
            clearTimeout(dismissTimer);
            notification.style.transform = 'translateY(-120%)';
            setTimeout(() => notification.remove(), 300);
        }
    });
}

// Show AI moment (朋友圈动态) notification
function showAIMomentNotification(charName, momentPreview) {
    showAINotification(charName, momentPreview, {
        appName: '朋友圈',
        chatTag: null,
        onClick: () => {
            // Navigate to moments if available
            if (typeof renderMoments === 'function') {
                renderMoments();
            }
        }
    });
}

// Trigger AI to proactively send a message to a chat
async function triggerAIProactiveMessage(chatTag, charName) {
    if (!appSettings.apiKey || !appSettings.apiEndpoint) return;

    // Don't send if we're currently in that chat and it's active
    if (currentChatTag === chatTag) return;

    // Build a short context
    const npc = (typeof npcCharacters !== 'undefined' && Array.isArray(npcCharacters))
        ? npcCharacters.find(n => n.name === charName)
        : null;

    let persona = '';
    if (npc) {
        persona = npc.persona || npc.desc || '';
        if (npc.personality) persona += `\n性格: ${npc.personality}`;
        if (npc.scenario) persona += `\n背景: ${npc.scenario}`;
        if (persona.length > 500) persona = persona.substring(0, 500);
    }

    const userNameStr = typeof getUserName === 'function' ? getUserName() : 'User';
    const currentTime = typeof getTime === 'function' ? getTime(false) : '12:00';

    const prompt = `你是 ${charName}。${persona ? '你的人设：\n' + persona : ''}
你现在想主动给 ${userNameStr} 发一条消息。这是你的日常主动聊天，不是回复。
根据当前时间 ${currentTime} 和你的性格，发送2条简短自然的消息。
可以是：分享你正在做的事、一个突然想到的话题、想念对方、或者日常问候。
请注意：
- 只输出消息内容本身，不要XML标签
- 保持简短自然（5-30字）
- 符合你的人设性格
- 符合当前时间段的合理性`;

    try {
        const response = await fetch(`${appSettings.apiEndpoint}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${appSettings.apiKey}`
            },
            body: JSON.stringify({
                model: appSettings.apiModel || 'gpt-3.5-turbo',
                messages: [{ role: 'user', content: prompt }],
                temperature: 1.0,
                max_tokens: 100
            })
        });

        const data = await response.json();
        let content = data.choices?.[0]?.message?.content || '';
        content = content.replace(/<[^>]+>/g, '').trim(); // Strip any XML tags
        content = content.replace(/^["'""]|["'""]$/g, '').trim(); // Strip quotation marks

        if (!content) return;

        // Build message data
        const timestamp = typeof getTime === 'function' ? getTime(false) : '12:00';
        const msgData = {
            header: `[${charName}|${timestamp}]`,
            body: content,
            isUser: false
        };

        // Save to target chat's history (IndexedDB)
        try {
            let history = await getChatHistory(chatTag) || [];
            history.push(msgData);
            await saveChatHistory(chatTag, history);
        } catch (e) {
            console.error('Failed to save proactive message', e);
        }

        // Show notification
        showAINotification(charName, content, {
            chatTag: chatTag,
            time: timestamp
        });

        console.log(`[AI Proactive] ${charName} sent: ${content}`);
    } catch (err) {
        console.warn('[AI Proactive] Failed to generate message:', err);
    }
}

// Timer-based proactive messaging system (manual control)
let aiProactiveTimer = null;

function startAIProactiveTimer() {
    stopAIProactiveTimer();

    // Random interval: 3-8 minutes
    const minInterval = 3 * 60 * 1000;
    const maxInterval = 8 * 60 * 1000;

    const scheduleNext = () => {
        const interval = minInterval + Math.random() * (maxInterval - minInterval);
        aiProactiveTimer = setTimeout(async () => {
            // Only trigger if API is configured
            if (!appSettings.apiKey || !appSettings.apiEndpoint) {
                scheduleNext();
                return;
            }

            // Pick a random private chat
            const chats = appSettings.privateChats || [];
            if (chats.length === 0) {
                scheduleNext();
                return;
            }

            const randomChat = chats[Math.floor(Math.random() * chats.length)];
            const chatTag = `chat:${randomChat}`;

            // Don't message the current open chat
            if (currentChatTag === chatTag) {
                scheduleNext();
                return;
            }

            await triggerAIProactiveMessage(chatTag, randomChat);
            scheduleNext();
        }, interval);
    };

    scheduleNext();
    console.log('[AI Proactive] Timer started');
}

function stopAIProactiveTimer() {
    if (aiProactiveTimer) {
        clearTimeout(aiProactiveTimer);
        aiProactiveTimer = null;
    }
}

//==============================
// 朋友圈 / Moments Feature (Enhanced)
//==============================
let momentsPosts = [];
let composeImages = []; // base64 images for composing
let commentingPostId = null; // which post is being commented on
let commentingReplyTo = null; // new: which user to reply to
let momentsInteractors = {}; // { postId: [npcName1, npcName2, ...] } — selected characters for interaction

document.addEventListener('click', (e) => {
    const popup = e.target.closest('.moment-action-popup');
    const btn = e.target.closest('.moment-action-btn');
    if (!popup && !btn && typeof closeMomentPopups === 'function') {
        closeMomentPopups();
    }
});

function loadMomentsData() {
    const stored = localStorage.getItem('faye-phone-moments');
    if (stored) {
        try { momentsPosts = JSON.parse(stored); } catch (e) { momentsPosts = []; }
    }
}

function saveMomentsData() {
    localStorage.setItem('faye-phone-moments', JSON.stringify(momentsPosts));
}

function getMomentsCoverBg() {
    return localStorage.getItem('faye-phone-moments-cover') || '';
}

function setMomentsCoverBg(url) {
    localStorage.setItem('faye-phone-moments-cover', url);
}

function getMomentAvatar(name) {
    const placeholder = "data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='%23d1d1d6'%3E%3Cpath d='M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z'/%3E%3C/svg%3E";
    const npc = npcCharacters.find(n => n.name === name);
    if (npc && npc.avatar) return npc.avatar;
    const user = userCharacters.find(u => u.name === name);
    if (user && user.avatar) return user.avatar;
    return placeholder;
}

function formatMomentTime(timestamp) {
    const now = Date.now();
    const diff = now - timestamp;
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (minutes < 1) return '刚刚';
    if (minutes < 60) return `${minutes}分钟前`;
    if (hours < 24) return `${hours}小时前`;
    if (days < 7) return `${days}天前`;

    const d = new Date(timestamp);
    const month = d.getMonth() + 1;
    const day = d.getDate();
    return `${month}月${day}日`;
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function getCurrentUserNameForMoments() {
    const userId = getCurrentUserId();
    return (userId !== undefined && userCharacters[userId]) ? userCharacters[userId].name : 'User';
}

function getCurrentUserAvatarForMoments() {
    const saved = localStorage.getItem('faye-phone-moments-avatar');
    if (saved) return saved;
    const userId = getCurrentUserId();
    const currentUser = (userId !== undefined) ? userCharacters[userId] : null;
    return currentUser && currentUser.avatar ? currentUser.avatar :
        "data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='%23d1d1d6'%3E%3Cpath d='M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z'/%3E%3C/svg%3E";
}

function renderMoments() {
    const momentsBody = document.getElementById('moments-body');
    if (!momentsBody) return;

    loadMomentsData();

    const currentUserName = getCurrentUserNameForMoments();
    const currentUserAvatar = getCurrentUserAvatarForMoments();

    let html = '';

    // Cover / Banner — tappable to change background
    const coverBg = getMomentsCoverBg() || appSettings.homeBg || '';
    const coverStyle = coverBg ? `background-image: url(${coverBg}); background-size: cover; background-position: center;` : '';
    html += `
        <div class="moments-cover" style="${coverStyle}" onclick="openMomentsCoverUpload()">
            <button class="moments-back-btn" onclick="event.stopPropagation(); switchNavTab('message')" title="返回">
                <svg viewBox="0 0 24 24">
                    <polyline points="15 18 9 12 15 6"></polyline>
                </svg>
            </button>
            <div class="moments-top-actions">
                <button class="moments-compose-btn" onclick="event.stopPropagation(); triggerAIMoments()" title="AI 生成动态">
                    <svg viewBox="0 0 24 24" fill="none" stroke-width="1.5">
                        <path d="M12 2l2.09 6.26L20.18 9.27l-5.09 3.89L17.09 19.5 12 15.77 6.91 19.5l2-6.34L3.82 9.27l6.09-1.01z" fill="rgba(255,255,255,0.9)"></path>
                    </svg>
                </button>
                <button class="moments-compose-btn" onclick="event.stopPropagation(); openMomentsCompose()" title="发表动态">
                    <svg viewBox="0 0 24 24" fill="none" stroke-width="1.5">
                        <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"></path>
                        <circle cx="12" cy="13" r="4"></circle>
                    </svg>
                </button>
            </div>
            <div class="moments-cover-user">
                <img class="moments-cover-avatar" src="${currentUserAvatar}" onclick="event.stopPropagation(); openMomentsAvatarUpload()">
            </div>
        </div>`;

    // Posts Feed
    html += '<div class="moments-feed">';

    if (momentsPosts.length === 0) {
        html += `
            <div class="moments-empty">
                <div>还没有动态，快来发一条吧~</div>
            </div>`;
    } else {
        momentsPosts.forEach((post, index) => {
            const avatar = getMomentAvatar(post.author);
            const timeStr = formatMomentTime(post.timestamp);
            const isMyPost = post.author === currentUserName;
            const hasLiked = post.likes.includes(currentUserName);

            html += `<div class="moment-post" data-post-id="${post.id}">`;
            html += `<img class="moment-avatar" src="${avatar}" onerror="this.src='data:image/svg+xml;charset=utf-8,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 24 24%27 fill=%27%23d1d1d6%27%3E%3Cpath d=%27M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z%27/%3E%3C/svg%3E'">`;
            html += '<div class="moment-content">';
            html += `<div class="moment-author">${post.author}</div>`;

            if (post.text) {
                html += `<div class="moment-text">${escapeHtml(post.text)}</div>`;
            }

            // Images
            if (post.images && post.images.length > 0) {
                const gridClass = `grid-${Math.min(post.images.length, 9)}`;
                html += `<div class="moment-images ${gridClass}">`;
                post.images.forEach(imgSrc => {
                    if (imgSrc.startsWith('txt:')) {
                        const desc = imgSrc.substring(4);
                        const escapedDesc = escapeHtml(desc);
                        html += `<div class="moment-img-text" onclick="alert('${escapedDesc.replace(/'/g, "\\'")}')">${escapedDesc}</div>`;
                    } else {
                        html += `<img class="moment-img" src="${imgSrc}" onclick="viewMomentImage(this.src)" onerror="this.style.display='none'">`;
                    }
                });
                html += '</div>';
            }

            // Footer: time + action button
            html += '<div class="moment-footer">';
            html += `<span class="moment-time">${timeStr}`;
            if (isMyPost) {
                html += `<span class="moment-delete-btn" onclick="deleteMoment('${post.id}')">删除</span>`;
            }
            html += '</span>';
            html += `<div class="moment-action-area">
                    <div class="moment-action-popup" id="popup-${post.id}">
                        <button class="moment-popup-btn" onclick="toggleMomentLike('${post.id}')">
                            <svg viewBox="0 0 24 24"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg>
                            ${hasLiked ? '取消' : '赞'}
                        </button>
                        <button class="moment-popup-btn" onclick="startMomentComment('${post.id}')">
                            <svg viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>
                            评论
                        </button>
                        <button class="moment-popup-btn" onclick="triggerAICommentOnPost('${post.id}')">
                            <svg viewBox="0 0 24 24"><path d="M12 2l2.09 6.26L20.18 9.27l-5.09 3.89L17.09 19.5 12 15.77 6.91 19.5l2-6.34L3.82 9.27l6.09-1.01z" fill="rgba(255,255,255,0.9)"></path></svg>
                            AI回复${momentsInteractors[post.id] && momentsInteractors[post.id].length > 0 ? '<span class="interactor-badge">' + momentsInteractors[post.id].length + '</span>' : ''}
                        </button>
                        <button class="moment-popup-btn" onclick="openInteractorPicker('${post.id}')">
                            <svg viewBox="0 0 24 24"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" fill="none" stroke="currentColor" stroke-width="1.5"></path><circle cx="9" cy="7" r="4" fill="none" stroke="currentColor" stroke-width="1.5"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87" fill="none" stroke="currentColor" stroke-width="1.5"></path><path d="M16 3.13a4 4 0 0 1 0 7.75" fill="none" stroke="currentColor" stroke-width="1.5"></path></svg>
                            互动
                        </button>
                    </div>
                    <button class="moment-action-btn" onclick="toggleMomentPopup('${post.id}')">
                        <svg viewBox="0 0 24 24"><circle cx="6" cy="12" r="1.8" fill="#999"></circle><circle cx="12" cy="12" r="1.8" fill="#999"></circle><circle cx="18" cy="12" r="1.8" fill="#999"></circle></svg>
                    </button>
                </div>`;
            html += '</div>'; // .moment-footer

            // Likes
            if (post.likes && post.likes.length > 0) {
                html += '<div class="moment-likes">';
                html += '<svg viewBox="0 0 24 24"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg>';
                html += '<div class="moment-likes-names">';
                post.likes.forEach(name => {
                    html += `<span>${name}</span>`;
                });
                html += '</div></div>';
            }

            // Comments
            if (post.comments && post.comments.length > 0) {
                html += '<div class="moment-comments">';
                post.comments.forEach(c => {
                    html += `<div class="moment-comment-item" onclick="startMomentReply('${post.id}', '${c.author}')">`;
                    html += `<span class="moment-comment-name">${c.author}</span>`;
                    if (c.replyTo) {
                        html += `<span class="moment-comment-reply-target">回复</span>`;
                        html += `<span class="moment-comment-name">${c.replyTo}</span>`;
                    }
                    html += `<span class="moment-comment-text">：${escapeHtml(c.text)}</span>`;
                    html += '</div>';
                });
                html += '</div>';
            }

            html += '</div>'; // .moment-content
            html += '</div>'; // .moment-post
        });
    }

    html += '</div>'; // .moments-feed

    // Comment input bar
    html += `<div class="moment-comment-input-bar" id="moment-comment-bar">
            <input type="text" id="moment-comment-input" placeholder="评论...">
            <button class="moment-comment-send-btn" onclick="sendMomentComment()">发送</button>
        </div>`;

    momentsBody.innerHTML = html;

    // Enter key for comment
    const commentInput = document.getElementById('moment-comment-input');
    if (commentInput) {
        commentInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                sendMomentComment();
            }
        });
    }
}

// ===== Cover Photo Upload =====
function openMomentsCoverUpload() {
    const overlay = document.getElementById('moments-cover-upload-overlay');
    if (overlay) overlay.classList.add('show');
}

function closeMomentsCoverUpload() {
    const overlay = document.getElementById('moments-cover-upload-overlay');
    if (overlay) overlay.classList.remove('show');
}

function momentsCoverUrlUpload() {
    closeMomentsCoverUpload();
    const url = prompt('请输入图片 URL:');
    if (url && url.trim()) {
        setMomentsCoverBg(url.trim());
        renderMoments();
        showToast('封面已更新');
    }
}

function momentsCoverLocalUpload() {
    closeMomentsCoverUpload();
    // Reuse the settings cropper system
    currentSettingsUploadType = 'moments-cover';
    const input = document.getElementById('settings-file-input');
    if (input) input.click();
}

function openMomentsAvatarUpload() {
    if (document.getElementById('moments-avatar-upload-overlay')) return;

    const overlay = document.createElement('div');
    overlay.id = 'moments-avatar-upload-overlay';
    overlay.className = 'modal-overlay';
    overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);z-index:9999;display:flex;align-items:center;justify-content:center;opacity:0;pointer-events:auto;transition:opacity 0.3s;';

    const box = document.createElement('div');
    box.className = 'modal-box group-modal-cute';
    box.style.cssText = 'width:85%;max-width:320px;padding:25px;transform:scale(0.9);transition:transform 0.3s;display:flex;flex-direction:column;';

    // Title
    const title = document.createElement('h3');
    title.textContent = '更换朋友圈头像';
    title.className = 'modal-title group-modal-title';
    title.style.cssText = 'margin-top:0;margin-bottom:20px;text-align:center;font-weight:bold;';

    // Local upload button
    const localBtn = document.createElement('button');
    localBtn.textContent = '从相册选择';
    localBtn.style.cssText = 'width:100%;padding:12px;background:#f5f5f5;color:#333;border:1px solid #ddd;border-radius:8px;font-size:15px;font-weight:bold;margin-bottom:25px;cursor:pointer;transition:all 0.2s;';
    localBtn.onclick = () => {
        overlay.style.opacity = '0';
        setTimeout(() => overlay.remove(), 300);
        currentSettingsUploadType = 'moments-avatar';
        const input = document.getElementById('settings-file-input');
        if (input) input.click();
    };

    // Divider
    const divider = document.createElement('div');
    divider.style.cssText = 'width:100%;height:1px;background:#eee;margin-bottom:20px;position:relative;text-align:center;';
    const divText = document.createElement('span');
    divText.textContent = '或使用url上传';
    divText.style.cssText = 'position:absolute;top:-8px;left:50%;transform:translateX(-50%);background:#fff;padding:0 10px;color:#999;font-size:12px;';
    divider.appendChild(divText);

    // URL input
    const urlInput = document.createElement('input');
    urlInput.type = 'text';
    urlInput.placeholder = '输入图床 URL...';
    urlInput.className = 'uc-input';
    urlInput.style.cssText = 'width:100%;box-sizing:border-box;margin-bottom:15px;padding:12px;background:#f5f5f5;border:none;border-radius:8px;font-size:14px;';

    // Cancel and Confirm buttons for URL
    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;justify-content:space-between;gap:10px;margin-top:5px;';

    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = '取消';
    cancelBtn.className = 'modal-btn group-modal-cancel';
    cancelBtn.style.cssText = 'flex:1;';
    cancelBtn.onclick = () => {
        overlay.style.opacity = '0';
        setTimeout(() => overlay.remove(), 300);
    };

    const confirmUrlBtn = document.createElement('button');
    confirmUrlBtn.textContent = '确定更换';
    confirmUrlBtn.className = 'modal-btn group-modal-confirm';
    confirmUrlBtn.style.cssText = 'flex:1;';
    confirmUrlBtn.onclick = () => {
        const url = urlInput.value.trim();
        if (url) {
            localStorage.setItem('faye-phone-moments-avatar', url);
            renderMoments();
            if (typeof showToast === 'function') showToast('头像已更新');
            overlay.style.opacity = '0';
            setTimeout(() => overlay.remove(), 300);
        } else {
            if (typeof showToast === 'function') showToast('请输入有效的链接');
        }
    };

    btnRow.appendChild(cancelBtn);
    btnRow.appendChild(confirmUrlBtn);

    box.appendChild(title);
    box.appendChild(localBtn);
    box.appendChild(divider);
    box.appendChild(urlInput);
    box.appendChild(btnRow);

    overlay.appendChild(box);
    document.body.appendChild(overlay);

    requestAnimationFrame(() => {
        overlay.style.opacity = '1';
        box.style.transform = 'scale(1)';
    });
}
window.openMomentsAvatarUpload = openMomentsAvatarUpload;

// ===== Interaction Functions =====
function toggleMomentPopup(postId) {
    document.querySelectorAll('.moment-action-popup').forEach(popup => {
        if (popup.id !== `popup-${postId}`) popup.classList.remove('show');
    });
    const popup = document.getElementById(`popup-${postId}`);
    if (popup) popup.classList.toggle('show');
}

function closeMomentPopups() {
    document.querySelectorAll('.moment-action-popup').forEach(p => p.classList.remove('show'));
}

function toggleMomentLike(postId) {
    const currentUserName = getCurrentUserNameForMoments();
    const post = momentsPosts.find(p => p.id === postId);
    if (!post) return;

    const likeIndex = post.likes.indexOf(currentUserName);
    if (likeIndex >= 0) {
        post.likes.splice(likeIndex, 1);
    } else {
        post.likes.push(currentUserName);
    }

    saveMomentsData();
    closeMomentPopups();
    renderMoments();
}

function startMomentComment(postId) {
    commentingPostId = postId;
    commentingReplyTo = null; // general comment
    closeMomentPopups();
    const bar = document.getElementById('moment-comment-bar');
    const input = document.getElementById('moment-comment-input');
    if (bar) bar.classList.add('show');
    if (input) {
        const post = momentsPosts.find(p => p.id === postId);
        input.placeholder = post ? `评论 ${post.author}...` : '评论...';
        setTimeout(() => input.focus(), 100);
    }
}

// Export to strictly global if needed, or keep local since it's just triggered by onclick which evaluates in global... Wait, all functions are inside a wrapper? No, it's just in a massive scope.
// If it's a global onclick, we just need to ensure it's on window or in the same scope. 
function startMomentReply(postId, author) {
    commentingPostId = postId;
    commentingReplyTo = author;
    closeMomentPopups();
    const bar = document.getElementById('moment-comment-bar');
    const input = document.getElementById('moment-comment-input');
    if (bar) bar.classList.add('show');
    if (input) {
        input.placeholder = `回复 ${author}...`;
        setTimeout(() => input.focus(), 100);
    }
}
// expose to window if necessary
window.startMomentReply = startMomentReply;

function sendMomentComment() {
    if (!commentingPostId) return;
    const input = document.getElementById('moment-comment-input');
    if (!input || !input.value.trim()) return;

    const currentUserName = getCurrentUserNameForMoments();
    const post = momentsPosts.find(p => p.id === commentingPostId);
    if (!post) return;

    if (!post.comments) post.comments = [];
    post.comments.push({
        author: currentUserName,
        text: input.value.trim(),
        replyTo: commentingReplyTo,
        timestamp: Date.now()
    });

    saveMomentsData();
    commentingPostId = null;
    commentingReplyTo = null;
    if (input) input.value = '';
    const bar = document.getElementById('moment-comment-bar');
    if (bar) bar.classList.remove('show');
    renderMoments();
}

function deleteMoment(postId) {
    if (!confirm('确定删除这条动态吗？')) return;
    momentsPosts = momentsPosts.filter(p => p.id !== postId);
    saveMomentsData();
    renderMoments();
    showToast('动态已删除');
}

// ===== Compose =====
function openMomentsCompose() {
    composeImages = [];
    const overlay = document.getElementById('moments-compose-overlay');
    const textArea = document.getElementById('compose-text');
    if (overlay) overlay.classList.add('show');
    if (textArea) textArea.value = '';
    renderComposeImages();

    const fileInput = document.getElementById('moment-image-input');
    if (fileInput) {
        fileInput.value = '';
        fileInput.onchange = handleMomentImageSelect;
    }

    // Populate visibility selector with contacts
    const visSel = document.getElementById('compose-visibility');
    if (visSel) {
        visSel.innerHTML = '<option value="all">\u6240\u6709\u4eba\u53ef\u89c1</option>';
        if (appSettings.privateChats && Array.isArray(appSettings.privateChats)) {
            appSettings.privateChats.forEach(name => {
                visSel.innerHTML += `<option value="${name}">${name} \u53ef\u89c1</option>`;
            });
        }
    }
}

function closeMomentsCompose() {
    const overlay = document.getElementById('moments-compose-overlay');
    if (overlay) overlay.classList.remove('show');
    composeImages = [];
}

function triggerMomentImageUpload() {
    const fileInput = document.getElementById('moment-image-input');
    if (fileInput) fileInput.click();
}

function handleMomentImageSelect(e) {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    const remaining = 9 - composeImages.length;
    const toProcess = Math.min(files.length, remaining);

    for (let i = 0; i < toProcess; i++) {
        const file = files[i];
        if (!file.type.startsWith('image/')) continue;

        const reader = new FileReader();
        reader.onload = function (ev) {
            composeImages.push(ev.target.result);
            renderComposeImages();
        };
        reader.readAsDataURL(file);
    }

    if (files.length > remaining) {
        showToast('最多选择9张图片');
    }
}

function renderComposeImages() {
    const grid = document.getElementById('compose-image-grid');
    if (!grid) return;

    let html = '';
    composeImages.forEach((img, index) => {
        html += `<div class="compose-image-item">
                <img src="${img}">
                <button class="compose-image-remove" onclick="removeComposeImage(${index})">×</button>
            </div>`;
    });

    if (composeImages.length < 9) {
        html += `<div class="compose-add-image" onclick="triggerMomentImageUpload()">
                <svg viewBox="0 0 24 24">
                    <path d="M12 5v14M5 12h14" stroke-linecap="round"></path>
                </svg>
            </div>`;
    }

    grid.innerHTML = html;
}

function removeComposeImage(index) {
    composeImages.splice(index, 1);
    renderComposeImages();
}

function publishMoment() {
    const textArea = document.getElementById('compose-text');
    const text = textArea ? textArea.value.trim() : '';

    // Extract [图片：xxx] or [图片: xxx]
    let finalText = text;
    let newImages = [];
    const imgRegex = /\[图片[：:](.*?)\]/g;
    let match;
    while ((match = imgRegex.exec(finalText)) !== null) {
        newImages.push('txt:' + match[1].trim());
    }
    finalText = finalText.replace(imgRegex, '').trim();

    if (!finalText && composeImages.length === 0 && newImages.length === 0) {
        showToast('请输入内容或添加图片');
        return;
    }

    const currentUserName = getCurrentUserNameForMoments();
    const visSel = document.getElementById('compose-visibility');
    const visibility = visSel ? visSel.value : 'all';

    const post = {
        id: `moment_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
        author: currentUserName,
        text: finalText,
        images: [...composeImages, ...newImages],
        likes: [],
        comments: [],
        timestamp: Date.now(),
        visibility: visibility
    };

    momentsPosts.unshift(post);
    saveMomentsData();
    closeMomentsCompose();
    renderMoments();
    showToast('动态已发表');
}

// ===== Image Viewer =====
function viewMomentImage(src) {
    const viewer = document.getElementById('moment-image-viewer');
    const img = document.getElementById('moment-viewer-img');
    if (viewer && img) {
        img.src = src;
        viewer.classList.add('show');
    }
}

function closeMomentImageViewer() {
    const viewer = document.getElementById('moment-image-viewer');
    if (viewer) viewer.classList.remove('show');
}

// ===== AI Generate Moments (Magic Wand) =====
async function triggerAIMoments() {
    const endpoint = appSettings.apiEndpoint;
    const key = appSettings.apiKey;
    if (!endpoint) {
        showToast('请先在设置中配置 API');
        return;
    }

    // Gather all NPC contacts
    const contacts = [];
    if (appSettings.privateChats && Array.isArray(appSettings.privateChats)) {
        appSettings.privateChats.forEach(name => {
            const npc = npcCharacters.find(n => n.name === name);
            if (npc) contacts.push(npc);
        });
    }
    // Also include group chat members
    if (appSettings.groups && Array.isArray(appSettings.groups)) {
        appSettings.groups.forEach(g => {
            if (g.members) {
                g.members.forEach(name => {
                    const npc = npcCharacters.find(n => n.name === name);
                    if (npc && !contacts.find(c => c.name === npc.name)) {
                        contacts.push(npc);
                    }
                });
            }
        });
    }

    if (contacts.length === 0) {
        showToast('没有可用的角色来发布动态');
        return;
    }

    showToast('✨ 正在生成动态...');

    // Pick characters to post (at least 2 if available)
    const postCount = Math.min(contacts.length, Math.max(2, Math.min(contacts.length, 3)));
    const shuffled = [...contacts].sort(() => Math.random() - 0.5);
    const selectedChars = shuffled.slice(0, postCount);

    // Gather chat memories for each character
    const currentUserName = getCurrentUserNameForMoments();

    for (const npc of selectedChars) {
        try {
            // Build context with chat history
            let chatContext = '';
            const chatKey = `chat:${npc.name}`;
            try {
                const history = await getChatHistory(chatKey);
                if (history && Array.isArray(history)) {
                    // Get last 20 messages for context
                    const recentMsgs = history.slice(-20);
                    chatContext = recentMsgs.map(m => {
                        const sender = m.isUser ? currentUserName : npc.name;
                        return `${sender}: ${m.body || ''}`;
                    }).join('\n');
                }
            } catch (e) { /* ignore */ }

            // Also get memory summaries
            let memoryContext = '';
            const memKey = `chat-memories-${chatKey}`;
            const memStr = localStorage.getItem(memKey);
            if (memStr) {
                try {
                    const mems = JSON.parse(memStr);
                    const enabledMems = mems.filter(m => m.enabled !== false);
                    if (enabledMems.length > 0) {
                        memoryContext = '记忆摘要：\n' + enabledMems.map(m => m.content).join('\n');
                    }
                } catch (e) { /* ignore */ }
            }

            const persona = npc.persona || npc.desc || '';
            const systemPrompt = `你是${npc.name}，正在发朋友圈动态。
角色设定：${persona}
${memoryContext ? memoryContext + '\n' : ''}${chatContext ? '最近和' + currentUserName + '的聊天记录：\n' + chatContext + '\n' : ''}
请用${npc.name}的语气和性格，写一条朋友圈动态。要求：
1. 必须完全以角色身份说话，风格自然、生活化
2. 可以参考聊天记录中的事件或话题，增加沉浸感
3. 内容可以是日常感悟、分享心情、记录生活等
4. 30-80字，不要太长
5. 如果你想配一张或多张图片，请在文中加入 [图片：照片的详细描述]
6. 只输出正文和图片标签，不要加引号、标签或前缀`;

            const messages = [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: '请发一条朋友圈动态' }
            ];

            const stream = await callLLM(messages);
            let momentText = '';
            const reader = stream.getReader();
            const decoder = new TextDecoder();

            let streamBuffer = '';
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                const chunk = decoder.decode(value, { stream: true });
                streamBuffer += chunk;
                const lines = streamBuffer.split('\n');
                streamBuffer = lines.pop();
                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        const data = line.slice(6).trim();
                        if (data === '[DONE]') break;
                        try {
                            const json = JSON.parse(data);
                            const content = json.choices?.[0]?.delta?.content;
                            if (content) momentText += content;
                        } catch (e) { /* skip */ }
                    }
                }
            }

            momentText = momentText.replace(/^["「『]|["」』]$/g, '').trim();

            let extractedImages = [];
            const imgRegex = /\[图片[：:](.*?)\]/g;
            let matchReg;
            while ((matchReg = imgRegex.exec(momentText)) !== null) {
                extractedImages.push('txt:' + matchReg[1].trim());
            }
            momentText = momentText.replace(imgRegex, '').trim();

            if (momentText || extractedImages.length > 0) {
                const post = {
                    id: `moment_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
                    author: npc.name,
                    text: momentText,
                    images: extractedImages,
                    likes: [],
                    comments: [],
                    timestamp: Date.now() - Math.floor(Math.random() * 3600000)
                };
                momentsPosts.unshift(post);
            }

            // Small delay between AI calls
            await new Promise(r => setTimeout(r, 300));

        } catch (err) {
            console.error(`AI moment generation failed for ${npc.name}:`, err);
        }
    }

    // Generate cross-comments between the characters if multiple posts
    if (selectedChars.length >= 2) {
        try {
            await generateAICrossComments(selectedChars, currentUserName);
        } catch (e) {
            console.error('Cross-comment generation failed:', e);
        }
    }

    momentsPosts.sort((a, b) => b.timestamp - a.timestamp);
    saveMomentsData();
    renderMoments();
    showToast('✨ AI 动态已生成');
}

async function generateAICrossComments(characters, currentUserName) {
    // Each character comments on at least one other character's post
    const recentAIPosts = momentsPosts.filter(p =>
        characters.some(c => c.name === p.author) && p.author !== currentUserName
    );

    if (recentAIPosts.length < 2) return;

    for (const post of recentAIPosts) {
        // Pick 1-2 random commenters (not the post author)
        const otherChars = characters.filter(c => c.name !== post.author);
        const commentCount = Math.min(otherChars.length, 1 + Math.floor(Math.random() * 2));
        const commenters = [...otherChars].sort(() => Math.random() - 0.5).slice(0, commentCount);

        for (const commenter of commenters) {
            try {
                const persona = commenter.persona || commenter.desc || '';
                const systemPrompt = `你是${commenter.name}。${persona ? '角色设定：' + persona : ''}
${post.author}发了一条朋友圈："${post.text}"
请用${commenter.name}的语气写一条评论。要求：
1. 完全以角色身份评论，自然亲切
2. 10-30字，简短有趣
3. 只输出评论内容`;

                const messages = [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: '请评论这条朋友圈' }
                ];

                const stream = await callLLM(messages);
                let commentText = '';
                const reader = stream.getReader();
                const decoder = new TextDecoder();

                let streamBuffer = '';
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    const chunk = decoder.decode(value, { stream: true });
                    streamBuffer += chunk;
                    const lines = streamBuffer.split('\n');
                    streamBuffer = lines.pop();
                    for (const line of lines) {
                        if (line.startsWith('data: ')) {
                            const data = line.slice(6).trim();
                            if (data === '[DONE]') break;
                            try {
                                const json = JSON.parse(data);
                                const content = json.choices?.[0]?.delta?.content;
                                if (content) commentText += content;
                            } catch (e) { /* skip */ }
                        }
                    }
                }

                commentText = commentText.replace(/^["「『]|["」』]$/g, '').trim();

                if (commentText && !post.comments) post.comments = [];
                if (commentText) {
                    post.comments.push({
                        author: commenter.name,
                        text: commentText,
                        timestamp: Date.now()
                    });
                }

                await new Promise(r => setTimeout(r, 200));
            } catch (e) {
                console.error(`Comment generation failed:`, e);
            }
        }
    }
}

// ===== Interactor Picker for Moments =====
function getAvailableInteractors(postId) {
    const post = momentsPosts.find(p => p.id === postId);
    if (!post) return [];

    const currentUserName = getCurrentUserNameForMoments();
    const interactorMap = {};

    // 1. All private chat NPCs
    if (appSettings.privateChats && Array.isArray(appSettings.privateChats)) {
        appSettings.privateChats.forEach(name => {
            const npc = npcCharacters.find(n => n.name === name);
            if (npc) interactorMap[npc.name] = npc;
        });
    }

    // 2. All group chat members
    if (appSettings.groupChats && Array.isArray(appSettings.groupChats)) {
        appSettings.groupChats.forEach(tag => {
            const settings = JSON.parse(localStorage.getItem(`chat-settings-${tag}`) || '{}');
            const members = settings.members || settings.groupMembers || [];
            members.forEach(name => {
                const npc = npcCharacters.find(n => n.name === name);
                if (npc) interactorMap[npc.name] = npc;
            });
        });
    }

    // 3. Sub-NPCs of the post author (associated characters)
    const authorNpc = npcCharacters.find(n => n.name === post.author);
    if (authorNpc && authorNpc.npcs && authorNpc.npcs.length > 0) {
        authorNpc.npcs.forEach(sub => {
            // Sub-NPCs may not be full npcCharacters, create a lightweight entry
            if (!interactorMap[sub.name]) {
                interactorMap[sub.name] = {
                    name: sub.name,
                    persona: sub.desc || '',
                    avatar: sub.avatar || null,
                    isSubNpc: true
                };
            }
        });
    }

    // 4. Also include the post author NPC itself (so they can reply to comments)
    if (authorNpc && !interactorMap[authorNpc.name]) {
        interactorMap[authorNpc.name] = authorNpc;
    }

    // Remove the current user from interactors
    delete interactorMap[currentUserName];

    return Object.values(interactorMap);
}

function openInteractorPicker(postId) {
    closeMomentPopups();

    const available = getAvailableInteractors(postId);
    if (available.length === 0) {
        showToast('没有可用的互动角色');
        return;
    }

    const currentSelected = momentsInteractors[postId] || [];

    let html = '<div class="interactor-picker-overlay" id="interactor-picker-overlay" onclick="closeInteractorPicker()">';
    html += '<div class="interactor-picker-panel" onclick="event.stopPropagation()">';
    html += '<div class="interactor-picker-title">选择互动角色</div>';
    html += '<div class="interactor-picker-list">';

    available.forEach(npc => {
        const checked = currentSelected.includes(npc.name);
        const avatar = getMomentAvatar(npc.name);
        const label = npc.isSubNpc ? `${npc.name} <span class="interactor-sub-tag">关联角色</span>` : npc.name;
        html += `<label class="interactor-item${checked ? ' selected' : ''}">
                <input type="checkbox" value="${npc.name}" ${checked ? 'checked' : ''} onchange="toggleInteractor('${postId}', '${npc.name}', this.checked)">
                <img class="interactor-avatar" src="${avatar}" onerror="this.style.display='none'">
                <span class="interactor-name">${label}</span>
            </label>`;
    });

    html += '</div>';
    html += `<div class="interactor-picker-actions">
            <button class="interactor-select-all-btn" onclick="selectAllInteractors('${postId}')">全选</button>
            <button class="interactor-confirm-btn" onclick="closeInteractorPicker()">确定</button>
        </div>`;
    html += '</div></div>';

    // Insert into DOM
    let container = document.getElementById('interactor-picker-overlay');
    if (container) container.remove();

    document.body.insertAdjacentHTML('beforeend', html);
}

function toggleInteractor(postId, name, checked) {
    if (!momentsInteractors[postId]) momentsInteractors[postId] = [];

    if (checked) {
        if (!momentsInteractors[postId].includes(name)) {
            momentsInteractors[postId].push(name);
        }
    } else {
        momentsInteractors[postId] = momentsInteractors[postId].filter(n => n !== name);
    }

    // Update the label's selected class
    const overlay = document.getElementById('interactor-picker-overlay');
    if (overlay) {
        const labels = overlay.querySelectorAll('.interactor-item');
        labels.forEach(label => {
            const input = label.querySelector('input');
            if (input) {
                label.classList.toggle('selected', input.checked);
            }
        });
    }
}

function selectAllInteractors(postId) {
    const available = getAvailableInteractors(postId);
    momentsInteractors[postId] = available.map(n => n.name);

    const overlay = document.getElementById('interactor-picker-overlay');
    if (overlay) {
        const inputs = overlay.querySelectorAll('input[type=checkbox]');
        inputs.forEach(input => {
            input.checked = true;
            input.closest('.interactor-item')?.classList.add('selected');
        });
    }
}

function closeInteractorPicker() {
    const overlay = document.getElementById('interactor-picker-overlay');
    if (overlay) overlay.remove();
    renderMoments(); // Refresh to update badge counts
}

// ===== AI Comment on a Specific Post (triggered by user) =====
async function triggerAICommentOnPost(postId) {
    const endpoint = appSettings.apiEndpoint;
    if (!endpoint) {
        showToast('请先在设置中配置 API');
        return;
    }

    const post = momentsPosts.find(p => p.id === postId);
    if (!post) return;

    closeMomentPopups();

    // Use selected interactors, or auto-pick if none selected
    let selected = [];
    if (momentsInteractors[postId] && momentsInteractors[postId].length > 0) {
        // User has explicitly selected interactors
        momentsInteractors[postId].forEach(name => {
            const npc = npcCharacters.find(n => n.name === name);
            if (npc) {
                selected.push(npc);
            } else {
                // May be a sub-NPC, find from the author's sub-NPCs
                const authorNpc = npcCharacters.find(n => n.name === post.author);
                if (authorNpc && authorNpc.npcs) {
                    const sub = authorNpc.npcs.find(s => s.name === name);
                    if (sub) {
                        selected.push({ name: sub.name, persona: sub.desc || '', isSubNpc: true });
                    }
                }
            }
        });
    } else {
        // Fallback: auto-pick from available commenters
        const commenters = getAvailableInteractors(postId);
        if (commenters.length === 0) {
            showToast('没有可用的角色来评论');
            return;
        }
        const count = Math.min(commenters.length, 1 + Math.floor(Math.random() * 2));
        selected = [...commenters].sort(() => Math.random() - 0.5).slice(0, count);
    }

    if (selected.length === 0) {
        showToast('请先选择互动角色');
        return;
    }

    const currentUserName = getCurrentUserNameForMoments();

    showToast(`✨ 正在回复 (${selected.length}个角色)...`);

    // Build existing comments context
    const existingComments = (post.comments || []).map(c =>
        `${c.author}：${c.text}`
    ).join('\n');

    for (const npc of selected) {
        try {
            const persona = npc.persona || npc.desc || '';

            // Get chat history for context
            let chatContext = '';
            const chatKey = `chat:${npc.name}`;
            try {
                const history = await getChatHistory(chatKey);
                if (history && Array.isArray(history)) {
                    const recentMsgs = history.slice(-10);
                    chatContext = recentMsgs.map(m => {
                        const sender = m.isUser ? currentUserName : npc.name;
                        return `${sender}: ${m.body || ''}`;
                    }).join('\n');
                }
            } catch (e) { /* ignore */ }

            const isAuthorReply = npc.name === post.author;
            const systemPrompt = `你是${npc.name}。${persona ? '角色设定：' + persona : ''}
${chatContext ? '你和' + currentUserName + '的聊天记录：\n' + chatContext + '\n' : ''}
${post.author}发了一条朋友圈："${post.text}"
${existingComments ? '已有评论：\n' + existingComments + '\n' : ''}
${isAuthorReply ? '你是这条动态的作者，有人评论了你的朋友圈，请回复最新一条评论。' : '请用' + npc.name + '的语气写一条评论或回复已有评论。'}
要求：
1. 完全以角色身份说话
2. 自然、有趣，10-30字
3. 只输出评论内容，不要加引号或前缀`;

            const messages = [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: isAuthorReply ? '请回复评论' : '请评论这条朋友圈' }
            ];

            const stream = await callLLM(messages);
            let commentText = '';
            const reader = stream.getReader();
            const decoder = new TextDecoder();

            let streamBuffer = '';
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                const chunk = decoder.decode(value, { stream: true });
                streamBuffer += chunk;
                const lines = streamBuffer.split('\n');
                streamBuffer = lines.pop();
                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        const data = line.slice(6).trim();
                        if (data === '[DONE]') break;
                        try {
                            const json = JSON.parse(data);
                            const content = json.choices?.[0]?.delta?.content;
                            if (content) commentText += content;
                        } catch (e) { /* skip */ }
                    }
                }
            }

            commentText = commentText.replace(/^["「『]|["」』]$/g, '').trim();

            if (commentText) {
                if (!post.comments) post.comments = [];

                // If replying to a specific comment, add replyTo
                const lastComment = post.comments[post.comments.length - 1];
                const commentObj = {
                    author: npc.name,
                    text: commentText,
                    timestamp: Date.now()
                };

                if (isAuthorReply && lastComment) {
                    commentObj.replyTo = lastComment.author;
                }

                post.comments.push(commentObj);
            }

            await new Promise(r => setTimeout(r, 200));
        } catch (err) {
            console.error(`AI comment failed for ${npc.name}:`, err);
        }
    }

    saveMomentsData();
    renderMoments();
    showToast('✨ 评论已生成');
}

// 网页控制台 (vConsole)
function loadVConsole() {
    if (window.vConsoleLoaded) return;
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/vconsole@latest/dist/vconsole.min.js';
    script.onload = () => {
        window.vConsole = new window.VConsole();
        showToast('vConsole 控制台已开启，随时可查看错误日志');
        window.vConsoleLoaded = true;
    };
    script.onerror = () => {
        showToast('加载 vConsole 失败，请检查网络');
        const cb = document.getElementById('set-vconsole');
        if (cb) cb.checked = false;
    };
    document.head.appendChild(script);
}

function closeVConsole() {
    if (window.vConsole) {
        window.vConsole.destroy();
        window.vConsole = null;
        window.vConsoleLoaded = false;
        showToast('vConsole 控制台已关闭');
    }
}

function toggleVConsole(on) {
    if (on) {
        loadVConsole();
    } else {
        closeVConsole();
    }
}

﻿Object.assign(window, {
    showGlobalDeleteMenu,
    loadVConsole,
    closeVConsole,
    toggleVConsole,
    openSystemSettings,
    closeSystemSettings,
    saveSystemSettings,
    openMessageList,
    openSettings,
    goBack,
    openChatSettings,
    adjustTextareaHeight,
    sendMessage,
    handleFileSelect,
    handleAction,
    closeMenus,
    saveHomeSettings,
    triggerSettingsUpload,
    triggerBatchAddSticker,
    closeModal,
    confirmAddContact,
    switchContactTab,
    saveChatSettings,
    deleteCurrentChat,
    endVoiceCall,
    sendCallMessage,
    receiveVoiceCall,
    declineIncomingCall,
    acceptIncomingCall,
    closeCropper,
    confirmCrop,
    closeSettings,
    closeChatSettings,
    closeUpdateModal,
    openAddContactModal,
    sendSticker,
    handleAddSticker,
    openUserSettings,
    openUserCreateModal,
    refreshModelList,
    closeUserCreateModal,
    saveUser,
    editUser,
    deleteUser,
    handleUserAvatarChange,
    // Character Setup (NPC)
    openCharacterSetup,
    openNpcSettings,
    openNpcCreatePage,
    closeNpcCreatePage,
    saveNpc,
    editNpc,
    deleteNpc,
    handleNpcAvatarChange,
    addSubNpcToNpc,
    // Backward compat stubs
    switchSetupTab,
    openCharacterEditor,
    saveCharacterEditor,
    closeCharacterEditor,
    saveWorldBook,
    deleteCharacterFromSetup,
    handleEditorAvatarChange,
    // User NPC
    addNpcToUser,
    openUserCreatePage,
    closeUserCreatePage,
    showAddActionSheet,
    hideAddActionSheet,
    closeAddContactModal,
    addGroupNpcSelect,
    // Settings sub-pages
    openApiSettings,
    closeApiSettings,
    openDataSettings,
    closeDataSettings,
    openBeautifySettings,


    closeBeautifySettings,
    saveBeautifySettings,
    // Calendar App
    openCalendarApp,
    closeCalendarApp,
    saveCalendarDate,
    resetCalendarDate,
    changeCalendarMonth,
    syncPickerToCalendar,
    selectCalendarDay,
    renderCalendarGrid,
    // NAI settings
    openNaiSettings,
    closeNaiSettings,
    saveNaiSettings,
    applyNaiSizePreset,
    exportAllData,
    importAllData,
    clearAllData,
    // New Chat Settings
    openChatBeautifySettings,
    closeChatBeautifySettings,
    saveChatBeautifySettings,
    restoreDefaultBeautifySettings,
    openChatMemorySettings,
    closeChatMemorySettings,
    openChatInteractionSettings,
    closeChatInteractionSettings,
    saveChatBlockSettings,
    exportCurrentChat,
    importChatHistory,
    summarizeChatMemory,
    summarizeFullMemory,
    saveMainChatSettings,
    clearCurrentChatMessages,
    handleManageStickers,
    triggerBatchAddSticker,
    openBatchDeleteModal,
    confirmBatchDelete,
    // Timezone Settings
    toggleCharTimezone,
    updateCharTimePreview,
    loadCharTimezoneUI,
    saveCharTimezoneSettings,
    getCharTimezoneOffset,
    // Mate Mode
    saveChatMateModeAuto,
    // Inner Voice Mode
    saveChatInnerVoiceModeAuto,
    // Multi-select & Recall
    enterMultiSelectMode,
    exitMultiSelectMode,
    deleteSelectedMessages,
    executeRecall,
    // URL Upload
    openUrlUploadModal,
    closeUrlUploadModal,
    confirmUrlUpload,
    // Chat Remark
    saveChatRemarkAuto,
    // Regex
    openRegexScreen,
    closeRegexScreen,
    addNewRegexRule,
    editRegexRule,
    deleteRegexRule,
    toggleRegexRule,
    saveRegexRule,
    closeRegexEditModal,
    // Memory Batch Ops
    toggleMemoryBatchMode,
    deleteSelectedMemories,
    // Offline Mode
    toggleOfflineMode,
    // MiniMax TTS
    openTtsSettings,
    closeTtsSettings,
    saveTtsSettings,
    handleTtsPlay,
    stopTtsAudio,
    // Per-chat NAI/TTS
    saveChatNaiSettings,
    saveChatTtsSettings,
    saveChatAutoInteractions,
    // Moments / 朋友圈
    renderMoments,
    openMomentsCompose,
    closeMomentsCompose,
    publishMoment,
    triggerMomentImageUpload,
    removeComposeImage,
    toggleMomentPopup,
    toggleMomentLike,
    startMomentComment,
    sendMomentComment,
    deleteMoment,
    viewMomentImage,
    closeMomentImageViewer,
    triggerAIMoments,
    triggerAICommentOnPost,
    openMomentsCoverUpload,
    closeMomentsCoverUpload,
    momentsCoverUrlUpload,
    momentsCoverLocalUpload,
    openInteractorPicker,
    toggleInteractor,
    selectAllInteractors,
    closeInteractorPicker,
    // Store / Marketplace Apps
    openStoreApp,
    closeStoreApp,
    filterStoreCategory,
    filterStoreProducts,
    addToStoreCart,
    changeStoreQty,
    toggleStoreCart,
    clearStoreCart,
    storeCheckout,
    closeStoreOrderModal,
    sendStoreOrderToChat,
    confirmShareToChat,
    showStoreNotification,
    // AI Proactive Messaging
    showAINotification,
    showAIMomentNotification,
    triggerAIProactiveMessage,
    startAIProactiveTimer,
    stopAIProactiveTimer,
    // Web Notifications
    toggleWebNotification,
    loadWebNotifUI,
    requestNotificationPermission,
    sendWebNotification,

    // Forum (星海社区)
    openForumApp,
    closeForumApp,
    switchForumTab,
    openForumDetail,
    closeForumDetail,
    submitForumComment,
    openForumCompose,
    closeForumCompose,
    triggerForumImageUpload,
    handleForumImageSelect,
    publishForumPost,
    triggerAIForumPost,
    triggerAIForumComment,
    likeForumPost,
    // Music Player
    openMusicApp,
    closeMusicApp,
    showMusicPlayerView,
    showMusicLibraryView,
    openMusicPlayerFromMini,
    toggleMusicPlay,
    musicNext,
    musicPrev,
    toggleMusicPlayMode,
    seekMusic,
    openAddSongModal,
    confirmAddSong,
    openEditSongModal,
    confirmEditSong,
    musicEditUploadFile,
    openMusicSongMenu,
    closeMusicMenu,
    deleteMusicSong,
    shareMusicToChat,
    confirmMusicShare,
    sendMusicToCurrentChat,
    musicPlaySong,
    shareMusicFromPlayer,
    openMusicPlaylist,
    startListenTogether,
    stopListenTogether,
    playMusicFromCard,
    listenTogetherFromCard,
    createMusicCardHTML,
    closeMiniPlayer,
    listenTogetherFromPlayer,
    togglePlayerLyricsView,
    seekToLyric,
    musicEditUploadLRC,
    musicEditUploadCover,
    musicAddUploadAudio,
    musicAddUploadCover,
    musicAddUploadLRC,
    // Pomodoro Timer
    openPomodoroApp,
    closePomodoroApp,
    switchPomodoroTab,
    startPomodoro,
    pausePomodoro,
    resumePomodoro,
    stopPomodoro,
    giveUpPomodoro,
    openPomodoroStartModal,
    confirmStartPomodoro,
    selectPomodoroTask,
    setPomoDuration,
    quickStartTask,
    deletePomodoroTask,
    savePomodoroSettingsUI,
    resetPomodoroStats,
    closePomodoroCompleteModal,
    switchPomodoroMode,
    uploadPomoAvatar,
    applyPomoAvatarUrl,
    sharePomoStatus,
    sendPomoShareToChat,
    closePomodoroGiveUpModal,
    deletePomodoroSession,
    clearPomodoroSessions,
    renderPomodoroRecords,
    clearPomoAvatar,
    playPomodoroSound
});

// Keypad logic global methods
let currentLockPin = '';

function showGlobalDeleteMenu(name, onDeleteCallback) {
    let sheetStr = document.getElementById('global-delete-sheet');
    if (!sheetStr) {
        const div = document.createElement('div');
        div.id = 'global-delete-sheet';
        div.innerHTML = `
            <div id="global-delete-sheet-overlay" style="position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.4);z-index:9999;display:none;opacity:0;transition:opacity 0.2s;"></div>
            <div id="global-delete-sheet-menu" style="position:fixed;bottom:0;left:0;right:0;background:#f5f5f5;z-index:10000;display:none;transform:translateY(100%);transition:transform 0.25s cubic-bezier(0.2, 0.8, 0.2, 1);border-radius:12px 12px 0 0;padding-bottom:env(safe-area-inset-bottom);">
                <div style="padding:16px;text-align:center;font-size:13px;color:#888;border-bottom:0.5px solid #e5e5e5;" id="global-delete-sheet-title">确认删除？</div>
                <div style="padding:16px;text-align:center;color:#e53935;font-size:16px;background:#fff;cursor:pointer;" id="global-delete-sheet-confirm">删除</div>
                <div style="margin-top:6px;padding:16px;text-align:center;font-size:16px;background:#fff;cursor:pointer;color:#333;" id="global-delete-sheet-cancel">取消</div>
            </div>
        `;
        document.body.appendChild(div);
    }

    document.getElementById('global-delete-sheet-title').textContent = '删除 "' + name + '"？';

    const overlay = document.getElementById('global-delete-sheet-overlay');
    const menu = document.getElementById('global-delete-sheet-menu');

    const closeSheet = () => {
        overlay.style.opacity = '0';
        menu.style.transform = 'translateY(100%)';
        setTimeout(() => {
            overlay.style.display = 'none';
            menu.style.display = 'none';
        }, 250);
    };

    overlay.onclick = closeSheet;
    document.getElementById('global-delete-sheet-cancel').onclick = closeSheet;
    document.getElementById('global-delete-sheet-confirm').onclick = () => {
        closeSheet();
        onDeleteCallback();
    };

    overlay.style.display = 'block';
    menu.style.display = 'block';

    // allow document reflow
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            overlay.style.opacity = '1';
            menu.style.transform = 'translateY(0)';
        });
    });
}

window.showLockKeypad = function () {
    const prompt = document.getElementById('lock-prompt');
    const container = document.getElementById('lock-keypad-container');
    if (prompt) prompt.style.display = 'none';
    if (container) {
        container.style.display = 'flex';
        container.style.animation = 'keypadSlideUp 0.4s cubic-bezier(0.2, 0.8, 0.2, 1) forwards';
    }
}

window.lockKeyPress = function (val) {
    if (val === -1) {
        currentLockPin = currentLockPin.slice(0, -1);
    } else {
        currentLockPin += val;
    }
    updateLockDots();

    // Unlock condition: exactly 4 digits
    if (currentLockPin.length >= 4) {
        setTimeout(() => {
            setScreenDisplay('home-screen');
            currentLockPin = '';
            updateLockDots();
            const prompt = document.getElementById('lock-prompt');
            const container = document.getElementById('lock-keypad-container');
            if (prompt) prompt.style.display = 'block';
            if (container) container.style.display = 'none';
        }, 200);
    }
}

function updateLockDots() {
    const dotsContainer = document.getElementById('lock-pwd-dots');
    if (!dotsContainer) return;
    dotsContainer.innerHTML = '';
    const dotCount = Math.max(4, currentLockPin.length + 1);
    for (let i = 0; i < dotCount; i++) {
        const dot = document.createElement('div');
        dot.className = 'lock-dot ' + (i < currentLockPin.length ? 'filled' : '');
        if (i >= 4 && i >= currentLockPin.length) break; // keep at max 4 empty dots or dynamic full dots
        dotsContainer.appendChild(dot);
    }
}

// ==== Desktop Layout Manager ====
const defaultGridLayout = [
    { id: 'app-custom-time', name: '时间', icon: 'mdi:clock-outline', action: () => promptCustomTime(), col: 1, row: 1, w: 2, h: 1 },
    { id: 'app-photo-widget', name: '照片', icon: 'mdi:image', action: () => openPhotoWidgetUpload(), col: 1, row: 2, w: 2, h: 2 },
    { id: 'app-world', name: '世界书', icon: 'bxs:book-heart', action: () => openCharacterSetup("world"), col: 3, row: 2 },
    { id: 'app-regex', name: '正则', icon: 'tabler:regex', action: () => openRegexScreen(), col: 4, row: 2 },
    { id: 'app-chat', name: '聊天', icon: 'basil:wechat-solid', action: () => openMessageList(), col: 1, row: 4 },
    { id: 'app-forum', name: '论坛', icon: 'material-symbols:forum-rounded', action: () => openForumApp(), col: 2, row: 4 },
    { id: 'app-calendar', name: '日历组件', icon: 'tabler:calendar', widget: true, action: () => openCalendarApp(), col: 3, row: 4, w: 2, h: 2 },
    { id: 'app-pomodoro', name: '番茄钟', icon: 'mdi:timer-outline', color: '#ff6b6b', action: () => openPomodoroApp(), col: 1, row: 6 },
    { id: 'app-shopping', name: '购物', icon: 'mdi:shopping-outline', color: '#ff7e67', action: () => openStoreApp('shopping'), col: 2, row: 6 },
    { id: 'app-takeout', name: '外卖', icon: 'ep:eleme', color: '#008ae6', action: () => openStoreApp('takeout'), col: 3, row: 6 },
    { id: 'app-music', name: '音乐', icon: 'fluent:music-note-2-24-filled', color: '#6886c5', action: () => openMusicApp(), col: 4, row: 6 }
];

window.promptCustomTime = function (val) {
    if (val === undefined || val === null) return;
    val = val.trim();
    if (!val) {
        appSettings.customTime = '';
        appSettings.timeOffset = 0;
        localStorage.removeItem('faye-custom-time');
    } else if (/^\d{1,2}:\d{2}$/.test(val)) {
        const now = new Date();
        const [h, m] = val.split(':').map(Number);
        const target = new Date(now);
        target.setHours(h);
        target.setMinutes(m);
        target.setSeconds(0);
        appSettings.timeOffset = target.getTime() - now.getTime();
        appSettings.customTime = val;
        localStorage.setItem('faye-custom-time', val);
    } else {
        return;
    }
    if (typeof saveSettingsToStorage === 'function') saveSettingsToStorage();
    if (typeof updateStatusBarClock === 'function') updateStatusBarClock();
};

let currentGridLayout = [];
let layoutEditMode = false;
let gridPressTimer = null;

window.loadGridLayout = function () {
    const gridVersion = 'v8-layout-fix';
    const savedVersion = localStorage.getItem('faye-phone-grid-version');
    const saved = localStorage.getItem('faye-phone-grid');
    if (saved && savedVersion === gridVersion) {
        let parsed = JSON.parse(saved);
        // remove novel from cached grid
        parsed = parsed.filter(p => p.id !== 'app-novel');
        // enforce new ep:eleme icon on existing cached takeout icon
        let takeout = parsed.find(p => p.id === 'app-takeout');
        if (takeout) {
            takeout.icon = 'ep:eleme';
            takeout.color = '#008ae6';
        }

        // revert calendar move if it's currently at row 3 (was bumped previously)
        let calendar = parsed.find(p => p.id === 'app-calendar');
        if (calendar && calendar.row === 3) {
            calendar.row = 4;
        }
        defaultGridLayout.forEach(def => {
            if (!parsed.find(p => p.id === def.id)) {
                parsed.push(def);
            }
        });
        currentGridLayout = parsed;
    } else {
        localStorage.setItem('faye-phone-grid-version', gridVersion);
        localStorage.removeItem('faye-phone-grid');
        currentGridLayout = JSON.parse(JSON.stringify(defaultGridLayout));
    }
    renderHomeGrid();
};

window.renderHomeGrid = function () {
    const gridEl = document.getElementById('home-main-grid');
    if (!gridEl) return;
    gridEl.innerHTML = '';

    // Create 24 drop slots (6 rows x 4 cols)
    for (let r = 1; r <= 6; r++) {
        for (let c = 1; c <= 4; c++) {
            const slot = document.createElement('div');
            slot.className = 'grid-slot';
            slot.style.gridColumn = c;
            slot.style.gridRow = r;
            slot.dataset.col = c;
            slot.dataset.row = r;
            gridEl.appendChild(slot);
        }
    }

    currentGridLayout.forEach(app => {
        const el = document.createElement('div');
        el.className = 'app-item app-draggable' + (app.widget ? ' calendar-widget' : '') + (app.id === 'app-custom-time' ? ' time-widget' : '');
        el.dataset.id = app.id;
        el.dataset.col = app.col;
        el.dataset.row = app.row;

        let w = app.w || 1;
        let h = app.h || 1;
        el.style.gridColumn = `${app.col} / span ${w}`;
        el.style.gridRow = `${app.row} / span ${h}`;
        if (app.widget && app.id !== 'app-custom-time') {
            el.style.width = '100%';
            el.style.height = '100%';
            el.style.padding = '0 5px';
            el.style.boxSizing = 'border-box';
        } else if (app.id === 'app-custom-time') {
            el.style.width = '100%';
            el.style.padding = '0 5px';
            el.style.boxSizing = 'border-box';
            el.style.alignSelf = 'center';
        }

        const iconColor = app.color ? `background-color: ${app.color}; -webkit-mask-image: url('https://api.iconify.design/${app.icon}.svg'); mask-image: url('https://api.iconify.design/${app.icon}.svg');` : `-webkit-mask-image: url('https://api.iconify.design/${app.icon}.svg'); mask-image: url('https://api.iconify.design/${app.icon}.svg');`;

        if (app.id === 'app-calendar') {
            const simDate = window.getSimulatedDate ? window.getSimulatedDate() : new Date();
            const day = simDate.getDate();
            const weekDays = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
            const dayOfWeek = weekDays[simDate.getDay()];
            const monthInfo = `${simDate.getFullYear()}年${simDate.getMonth() + 1}月`;
            el.innerHTML = `
                    <div class="app-icon-box app-icon-style" style="max-width:none; width:100%; height:100%; border-radius:28px; flex-direction:column; justify-content:center; gap:2px; background: rgba(255,255,255,0.85); box-shadow: inset 1px 1px 2px rgba(255,255,255,0.5), 0 2px 8px rgba(0,0,0,0.05); position:relative; overflow:hidden;">
                        <div style="color:var(--pink-500); width:100%; text-align:center; font-size:13px; font-weight:bold; text-shadow:none; margin-bottom: 2px;">
                            ${monthInfo}
                        </div>
                        <div style="font-size:38px; font-weight:bold; color:#333; line-height:1.1;">
                            ${day}
                        </div>
                        <div style="font-size:12px; color:#888; margin-top: 2px;">
                            ${dayOfWeek}
                        </div>
                    </div>
                `;
        } else if (app.id === 'app-photo-widget') {
            const photoSrc = appSettings.photoWidgetImg || '';
            el.style.width = '100%';
            el.style.height = '100%';
            el.style.padding = '0 3px';
            el.style.boxSizing = 'border-box';
            if (photoSrc) {
                el.innerHTML = `
                    <div style="width:100%; height:100%; border-radius: 42% 56% 48% 52% / 52% 46% 54% 48%; overflow:hidden; box-shadow: 0 4px 15px rgba(0,0,0,0.1);">
                        <img src="${photoSrc}" style="width:100%; height:100%; object-fit:cover; display:block;" />
                    </div>`;
            } else {
                el.innerHTML = `
                    <div style="width:100%; height:100%; border-radius: 42% 56% 48% 52% / 52% 46% 54% 48%; overflow:hidden; background: rgba(255,255,255,0.7); box-shadow: inset 1px 1px 3px rgba(255,255,255,0.6), 0 4px 15px rgba(0,0,0,0.06); display:flex; align-items:center; justify-content:center; flex-direction:column; gap:6px;">
                        <svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="#ccc" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="8.5" r="1.5" fill="#ccc" stroke="none"/><path d="M21 15l-5-5L5 21" stroke="#ccc" stroke-width="1.5"/></svg>
                        <span style="font-size:11px; color:#bbb;">\u70b9\u51fb\u6dfb\u52a0\u7167\u7247</span>
                    </div>`;
            }
        } else if (app.id === 'app-custom-time') {
            const savedTime = appSettings.customTime || '';
            const timeBg = appSettings.iconBg || '#f5c4cf';
            const timeTextColor = appSettings.homeTextColor || '#333';
            el.innerHTML = `
                <div style="max-width:none; width:100%; border-radius:14px; display:flex; align-items:center; justify-content:center; padding:8px 12px; background: ${timeBg}; box-shadow: 0 2px 8px rgba(0,0,0,0.08); box-sizing:border-box;">
                    <input type="text" value="${savedTime}" placeholder="HH:MM" 
                        style="width:100%; text-align:center; font-size:15px; font-weight:bold; color:${timeTextColor}; border:none; border-radius:8px; padding:6px 10px; background:transparent; outline:none;"
                        onblur="promptCustomTime(this.value)"
                        onkeydown="if(event.key==='Enter'){this.blur();}" />
                </div>
            `;
        } else if (app.widget) {
            el.innerHTML = `
                    <div class="app-icon-box app-icon-style" style="max-width:none; width:100%; height:100%; border-radius:28px; flex-direction:column; justify-content:center; gap:8px;">
                        <div class="app-icon-image" style="width:40px; height:40px; ${iconColor}"></div>
                        <span class="app-name" style="color:var(--pink-600); font-size:13px; text-shadow:none; padding-bottom: 2px;">${app.name}</span>
                    </div>
                `;
        } else {
            el.innerHTML = `
                    <div class="app-icon-box app-icon-style">
                        <div class="app-icon-image" style="${iconColor}"></div>
                    </div>
                    <span class="app-name" style="padding-bottom: 2px;">${app.name}</span>
                `;
        }

        el.addEventListener('click', (e) => {
            if (layoutEditMode || document.body.classList.contains('edit-mode')) return;
            const def = defaultGridLayout.find(d => d.id === app.id);
            if (def && def.action) {
                def.action();
            } else {
                showToast(app.name + ' 功能敬请期待');
            }
        });

        gridEl.appendChild(el);
    });

    if (typeof applySettings === 'function') applySettings();
    initGridDragAndDrop(gridEl);
};

window.exitEditMode = function () {
    layoutEditMode = false;
    document.body.classList.remove('edit-mode');
    document.getElementById('home-edit-header').style.display = 'none';

    let els = document.querySelectorAll('.app-draggable');
    for (let i = 0; i < els.length; i++) {
        els[i].style.transform = ''; // reset just in case
    }
};

function initGridDragAndDrop(gridEl) {
    let draggedEl = null;

    const handleStart = (e, clientX, clientY, target) => {
        if (e.button !== undefined && e.button !== 0) return;
        if (target.closest('.home-dock') || target.closest('#home-edit-header')) return;
        const item = target.closest('.app-draggable');
        if (!item) {
            if (layoutEditMode && target.closest('#home-screen')) window.exitEditMode();
            return;
        }

        if (!layoutEditMode) {
            if (gridPressTimer) clearTimeout(gridPressTimer);
            gridPressTimer = setTimeout(() => {
                layoutEditMode = true;
                document.body.classList.add('edit-mode');
                document.getElementById('home-edit-header').style.display = 'block';
                if (navigator.vibrate) navigator.vibrate(50);
            }, 400); // 400ms is a better long press threshold
        } else {
            draggedEl = item;
            window.gridDragStartX = clientX;
            window.gridDragStartY = clientY;
        }
    };

    const handleMove = (e, clientX, clientY) => {
        if (gridPressTimer && !layoutEditMode) {
            clearTimeout(gridPressTimer);
            gridPressTimer = null;
        }
        if (!layoutEditMode || !draggedEl) return;

        if (e.cancelable) e.preventDefault();

        if (!window.ghostEl) {
            window.ghostEl = draggedEl.cloneNode(true);
            window.ghostEl.classList.add('dragging-ghost');
            window.ghostEl.style.position = 'fixed';
            window.ghostEl.style.pointerEvents = 'none';
            window.ghostEl.style.zIndex = '99999';
            window.ghostEl.style.width = draggedEl.offsetWidth + 'px';
            window.ghostEl.style.height = draggedEl.offsetHeight + 'px';
            window.ghostEl.style.opacity = '0.9';
            window.ghostEl.style.transform = 'scale(1.1)';
            document.body.appendChild(window.ghostEl);
            draggedEl.style.opacity = '0.2';
        }

        window.ghostEl.style.left = (clientX - window.ghostEl.offsetWidth / 2) + 'px';
        window.ghostEl.style.top = (clientY - window.ghostEl.offsetHeight / 2) + 'px';

        document.querySelectorAll('.grid-slot, .app-draggable').forEach(el => el.classList.remove('drag-over'));
        window.ghostEl.style.display = 'none';
        const elUnder = document.elementFromPoint(clientX, clientY);
        window.ghostEl.style.display = 'block';
        if (elUnder) {
            const slot = elUnder.closest('.grid-slot');
            const targetApp = elUnder.closest('.app-draggable');
            if (targetApp && targetApp !== draggedEl) targetApp.classList.add('drag-over');
            else if (slot) slot.classList.add('drag-over');
        }
    };

    const handleEnd = (clientX, clientY) => {
        if (gridPressTimer) { clearTimeout(gridPressTimer); gridPressTimer = null; }
        if (!layoutEditMode || !draggedEl) return;

        document.querySelectorAll('.grid-slot, .app-draggable').forEach(el => el.classList.remove('drag-over'));

        if (window.ghostEl) {
            window.ghostEl.style.display = 'none';
            const elUnder = document.elementFromPoint(clientX, clientY);
            window.ghostEl.remove();
            window.ghostEl = null;

            draggedEl.style.display = '';
            draggedEl.style.opacity = '1';

            const targetSlot = elUnder ? elUnder.closest('.grid-slot') : null;
            const targetApp = elUnder ? elUnder.closest('.app-draggable') : null;

            if (targetApp && targetApp !== draggedEl) {
                swapApps(draggedEl, targetApp);
            } else if (targetSlot) {
                moveAppToSlot(draggedEl, targetSlot);
            }
        }

        draggedEl = null;
    };

    gridEl.addEventListener('touchstart', (e) => handleStart(e, e.touches[0].clientX, e.touches[0].clientY, e.target), { passive: true });
    gridEl.addEventListener('touchmove', (e) => handleMove(e, e.touches[0].clientX, e.touches[0].clientY), { passive: false });
    gridEl.addEventListener('touchend', (e) => {
        if (e.changedTouches && e.changedTouches.length > 0) {
            handleEnd(e.changedTouches[0].clientX, e.changedTouches[0].clientY);
        } else {
            handleEnd(0, 0);
        }
        if (gridPressTimer) { clearTimeout(gridPressTimer); gridPressTimer = null; }
    });

    // Also cancel timer when leaving touch 
    gridEl.addEventListener('touchcancel', (e) => {
        if (gridPressTimer) { clearTimeout(gridPressTimer); gridPressTimer = null; }
    });

    gridEl.addEventListener('mousedown', (e) => handleStart(e, e.clientX, e.clientY, e.target));
    window.addEventListener('mousemove', (e) => handleMove(e, e.clientX, e.clientY), { passive: false });
    window.addEventListener('mouseup', (e) => handleEnd(e.clientX, e.clientY));
}

function swapApps(el1, el2) {
    const data1 = currentGridLayout.find(a => a.id === el1.dataset.id);
    const data2 = currentGridLayout.find(a => a.id === el2.dataset.id);
    if (data1 && data2) {
        const tempC = data1.col; const tempR = data1.row;
        data1.col = data2.col; data1.row = data2.row;
        data2.col = tempC; data2.row = tempR;

        // Protect bounds for 2x2 widget
        if (data1.w === 2 && data1.col > 3) data1.col = 3;
        if (data2.w === 2 && data2.col > 3) data2.col = 3;
        if (data1.h === 2 && data1.row > 4) data1.row = 4;
        if (data2.h === 2 && data2.row > 4) data2.row = 4;

        saveAndRenderGrid();
    }
}

function moveAppToSlot(el, slot) {
    const data = currentGridLayout.find(a => a.id === el.dataset.id);
    if (data) {
        data.col = parseInt(slot.dataset.col);
        data.row = parseInt(slot.dataset.row);

        if (data.w === 2 && data.col > 3) data.col = 3;
        if (data.h === 2 && data.row > 4) data.row = 4;

        saveAndRenderGrid();
    }
}

function saveAndRenderGrid() {
    localStorage.setItem('faye-phone-grid', JSON.stringify(currentGridLayout));
    renderHomeGrid();
}
function initColorPickers() {
    document.querySelectorAll('input.color-picker').forEach(picker => {
        if (picker.parentNode.classList.contains('color-picker-wrapper')) return; // Already wrapped

        const wrapper = document.createElement('div');
        wrapper.className = 'color-picker-wrapper';
        picker.parentNode.insertBefore(wrapper, picker);
        wrapper.appendChild(picker);

        const textInput = document.createElement('input');
        textInput.type = 'text';
        textInput.className = 'color-hex-input';
        textInput.maxLength = 7;
        textInput.placeholder = '#000000';
        wrapper.appendChild(textInput);

        picker.addEventListener('input', () => { textInput.value = picker.value.toUpperCase(); });

        textInput.addEventListener('input', () => {
            let val = textInput.value;
            if (!val.startsWith('#') && val.length > 0) val = '#' + val;
            textInput.value = val;
            if (/^#[0-9A-Fa-f]{6}$/.test(val)) {
                picker.value = val;
            }
        });

        const originalSet = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        Object.defineProperty(picker, 'value', {
            set(val) {
                originalSet.call(this, val || '#000000');
                textInput.value = this.value.toUpperCase();
            },
            get() {
                return Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').get.call(this);
            }
        });

        // Initial sync
        textInput.value = picker.value.toUpperCase();
    });
}

// ==== Photo Widget Upload & Crop ====
window.openPhotoWidgetUpload = function () {
    // Remove any existing popup
    const old = document.getElementById('photo-widget-popup');
    if (old) old.remove();

    const overlay = document.createElement('div');
    overlay.id = 'photo-widget-popup';
    overlay.className = 'modal-overlay show';
    overlay.style.zIndex = '99999';
    overlay.style.display = 'flex';
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

    const box = document.createElement('div');
    box.className = 'modal-box group-modal-cute';
    box.style.maxWidth = '300px';
    box.innerHTML = `
        <div class="modal-title group-modal-title" style="margin-top:0; margin-bottom: 20px; text-align: center;">设置照片</div>
        <button id="pw-local-btn" class="modal-btn group-modal-cancel" style="width:100%; padding:12px; margin-bottom:12px;">本地上传</button>
        <div style="display:flex; gap:8px; width:100%; align-items:center; margin-bottom:20px;">
            <input id="pw-url-input" class="group-modal-input" type="text" placeholder="粘贴图片 URL" style="margin-bottom:0;" />
            <button id="pw-url-btn" class="modal-btn group-modal-confirm" style="flex:none; padding:8px 14px; margin:0;">上传</button>
        </div>
        <div class="modal-actions" style="margin-top: 0;">
            <button id="pw-cancel-btn" class="modal-btn group-modal-cancel" style="width:100%;">取消</button>
        </div>
    `;
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    box.querySelector('#pw-cancel-btn').onclick = () => overlay.remove();
    box.querySelector('#pw-local-btn').onclick = () => {
        overlay.remove();
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/*';
        input.onchange = (e) => {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = (ev) => openPhotoCropModal(ev.target.result);
            reader.readAsDataURL(file);
        };
        input.click();
    };
    box.querySelector('#pw-url-btn').onclick = () => {
        const url = box.querySelector('#pw-url-input').value.trim();
        if (!url) return;
        overlay.remove();
        // Load URL image to crop
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
            const c = document.createElement('canvas');
            c.width = img.naturalWidth;
            c.height = img.naturalHeight;
            c.getContext('2d').drawImage(img, 0, 0);
            openPhotoCropModal(c.toDataURL('image/jpeg', 0.9));
        };
        img.onerror = () => {
            // If CORS fails, just use URL directly
            applyPhotoWidget(url);
        };
        img.src = url;
    };
};

function openPhotoCropModal(dataUrl) {
    const old = document.getElementById('photo-crop-modal');
    if (old) old.remove();

    const overlay = document.createElement('div');
    overlay.id = 'photo-crop-modal';
    overlay.style.cssText = 'position:fixed; inset:0; z-index:99999; display:flex; flex-direction:column; align-items:center; justify-content:center; background:rgba(0,0,0,0.7); backdrop-filter:blur(6px);';

    const container = document.createElement('div');
    container.style.cssText = 'position:relative; width:280px; height:280px; overflow:hidden; border-radius:8px; background:#111;';

    const img = document.createElement('img');
    img.src = dataUrl;
    img.style.cssText = 'position:absolute; top:0; left:0; cursor:move; user-select:none; -webkit-user-drag:none;';

    // Fit image so shorter side fills 280px
    const imgObj = new Image();
    imgObj.onload = () => {
        const ratio = imgObj.naturalWidth / imgObj.naturalHeight;
        let iw, ih;
        if (ratio >= 1) {
            ih = 280; iw = 280 * ratio;
        } else {
            iw = 280; ih = 280 / ratio;
        }
        img.style.width = iw + 'px';
        img.style.height = ih + 'px';
        img.style.left = -(iw - 280) / 2 + 'px';
        img.style.top = -(ih - 280) / 2 + 'px';
        img._iw = iw; img._ih = ih;

        // Drag to pan
        let dragging = false, startX, startY, origLeft, origTop;
        const onStart = (cx, cy) => {
            dragging = true;
            startX = cx; startY = cy;
            origLeft = parseFloat(img.style.left);
            origTop = parseFloat(img.style.top);
        };
        const onMove = (cx, cy) => {
            if (!dragging) return;
            let newLeft = origLeft + (cx - startX);
            let newTop = origTop + (cy - startY);
            newLeft = Math.min(0, Math.max(280 - iw, newLeft));
            newTop = Math.min(0, Math.max(280 - ih, newTop));
            img.style.left = newLeft + 'px';
            img.style.top = newTop + 'px';
        };
        const onEnd = () => { dragging = false; };

        container.addEventListener('mousedown', e => onStart(e.clientX, e.clientY));
        document.addEventListener('mousemove', e => onMove(e.clientX, e.clientY));
        document.addEventListener('mouseup', onEnd);
        container.addEventListener('touchstart', e => { e.preventDefault(); onStart(e.touches[0].clientX, e.touches[0].clientY); }, { passive: false });
        document.addEventListener('touchmove', e => onMove(e.touches[0].clientX, e.touches[0].clientY), { passive: false });
        document.addEventListener('touchend', onEnd);
    };
    imgObj.src = dataUrl;

    container.appendChild(img);

    // Pebble-shaped crop overlay
    const svgOverlay = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svgOverlay.setAttribute('viewBox', '0 0 280 280');
    svgOverlay.style.cssText = 'position:absolute; inset:0; width:100%; height:100%; pointer-events:none;';
    svgOverlay.innerHTML = `
        <defs><mask id="crop-mask">
            <rect width="280" height="280" fill="white"/>
            <ellipse cx="140" cy="140" rx="125" ry="130" fill="black" transform="rotate(-5 140 140)"/>
        </mask></defs>
        <rect width="280" height="280" fill="rgba(0,0,0,0.5)" mask="url(#crop-mask)"/>
        <ellipse cx="140" cy="140" rx="125" ry="130" fill="none" stroke="rgba(255,255,255,0.6)" stroke-width="1.5" stroke-dasharray="6 4" transform="rotate(-5 140 140)"/>
    `;
    container.appendChild(svgOverlay);

    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex; gap:16px; margin-top:16px;';
    btnRow.innerHTML = `
        <button id="crop-cancel" style="padding:10px 28px; border:none; border-radius:20px; background:rgba(255,255,255,0.2); color:#fff; font-size:14px; cursor:pointer;">\u53d6\u6d88</button>
        <button id="crop-confirm" style="padding:10px 28px; border:none; border-radius:20px; background:#fff; color:#333; font-size:14px; font-weight:bold; cursor:pointer;">\u786e\u5b9a</button>
    `;

    overlay.appendChild(container);
    overlay.appendChild(btnRow);
    document.body.appendChild(overlay);

    btnRow.querySelector('#crop-cancel').onclick = () => overlay.remove();
    btnRow.querySelector('#crop-confirm').onclick = () => {
        // Crop from canvas
        const canvas = document.createElement('canvas');
        canvas.width = 400; canvas.height = 400;
        const ctx = canvas.getContext('2d');
        const displayLeft = parseFloat(img.style.left) || 0;
        const displayTop = parseFloat(img.style.top) || 0;
        const displayW = img._iw || 280;
        const displayH = img._ih || 280;
        const scale = imgObj.naturalWidth / displayW;
        const sx = -displayLeft * scale;
        const sy = -displayTop * scale;
        const sw = 280 * scale;
        const sh = 280 * scale;
        ctx.drawImage(imgObj, sx, sy, sw, sh, 0, 0, 400, 400);
        const cropped = canvas.toDataURL('image/jpeg', 0.85);
        overlay.remove();
        applyPhotoWidget(cropped);
    };
}

function applyPhotoWidget(src) {
    appSettings.photoWidgetImg = src;
    if (typeof saveSettingsToStorage === 'function') saveSettingsToStorage();
    if (typeof renderHomeGrid === 'function') renderHomeGrid();
    showToast('\u7167\u7247\u5df2\u8bbe\u7f6e');
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initColorPickers);
} else {
    initColorPickers();
}


// ========== Store / Marketplace Apps (外卖 & 购物) ==========

// --- Product Data ---
const storeData = {
    takeout: {
        categories: ['全部', '美食', '饮品', '鲜花', '水果', '超市', '药品', '宠物'],
        products: [
            { name: '黄焖鸡米饭套餐', desc: '黄焖鸡腿+白米饭+青菜', price: 26.8, cat: '美食', emoji: '🍗', tag: '新品', dist: 1.2, time: 28 },
            { name: '麻辣香锅(辣)', desc: '时蔬+牛肉+虾仁 现炒', price: 32.0, cat: '美食', emoji: '🍲', tag: '人气王', dist: 0.8, time: 25 },
            { name: '珍珠奶茶(大杯)', desc: '鲜熬黑糖珍珠+牛乳茶', price: 15.9, cat: '饮品', emoji: '🥤', tag: '必点', dist: 0.5, time: 15 },
            { name: '冰美式拿铁', desc: '双份espresso+燕麦奶', price: 18.5, cat: '饮品', emoji: '☕', dist: 0.6, time: 18 },
            { name: '酸菜鱼盖饭', desc: '酸菜+黑鱼片+白米饭', price: 28.5, cat: '美食', emoji: '🐟', dist: 2.1, time: 35 },
            { name: '卤肉饭套餐', desc: '台式卤肉+卤蛋+时蔬', price: 19.9, cat: '美食', emoji: '🍳', dist: 1.5, time: 30 },
            { name: '芒果班戟', desc: '新鲜芒果+椰奶+西米露', price: 16.8, cat: '饮品', emoji: '🍰', dist: 1.0, time: 20 },
            { name: '红玫瑰花束(11支)', desc: '红玫瑰+满天星+精美包装', price: 99.0, cat: '鲜花', emoji: '🌹', tag: '热卖', dist: 3.2, time: 45 },
            { name: '向日葵混搭花篮', desc: '向日葵+雏菊+尤加利叶', price: 128.0, cat: '鲜花', emoji: '🌻', dist: 3.5, time: 50 },
            { name: '进口车厘子(500g)', desc: '智利JJ级 新鲜直达', price: 49.9, cat: '水果', emoji: '🍒', tag: '时令', dist: 1.8, time: 30 },
            { name: '新鲜草莓(盒装)', desc: '丹东99草莓 300g/盒', price: 29.9, cat: '水果', emoji: '🍓', dist: 1.5, time: 25 },
            { name: '纸巾抽纸(10包装)', desc: '原木纯品 柔韧亲肤', price: 19.9, cat: '超市', emoji: '🧻', dist: 0.8, time: 20 },
            { name: '洗衣液(2L)', desc: '薰衣草香型 持久留香', price: 32.9, cat: '超市', emoji: '🧴', dist: 1.0, time: 22 },
            { name: '感冒灵颗粒', desc: '999感冒灵 10袋装', price: 15.8, cat: '药品', emoji: '💊', dist: 0.5, time: 18 },
            { name: '布洛芬缓释胶囊', desc: '芬必得 20粒装', price: 24.5, cat: '药品', emoji: '💊', dist: 0.6, time: 20 },
            { name: '创可贴(100片)', desc: '防水透气 弹力面料', price: 12.9, cat: '药品', emoji: '🩹', dist: 0.4, time: 15 },
            { name: '猫粮(2.5kg)', desc: '全价猫粮 鸡肉味', price: 89.0, cat: '宠物', emoji: '🐱', dist: 2.0, time: 35 },
            { name: '宠物零食礼包', desc: '冻干鸡肉+鱼干+猫条', price: 45.0, cat: '宠物', emoji: '🐾', dist: 2.2, time: 38 }
        ]
    },
    shopping: {
        categories: ['全部', '数码', '服饰', '美妆', '家居', '食品', '运动', '书籍'],
        products: [
            { name: '无线蓝牙降噪耳机 Pro', desc: 'ANC主动降噪·40h续航', price: 299.0, cat: '数码', emoji: '🎧', tag: '爆款' },
            { name: '春季新款卫衣', desc: '纯棉宽松版型男女同款', price: 149.0, cat: '服饰', emoji: '🧣' },
            { name: '樱花粉口红礼盒', desc: '丝绒颜色·4支装', price: 188.0, cat: '美妆', emoji: '💄', tag: '限定版' },
            { name: '智能手表 Ultra', desc: '健康监测·NFC支付·GPS', price: 899.0, cat: '数码', emoji: '⌚' },
            { name: '轻奢单肩包', desc: '大容量经典设计', price: 268.0, cat: '服饰', emoji: '👜' },
            { name: '保湿护肤套装', desc: '水乳霜三件套', price: 328.0, cat: '美妆', emoji: '✨' },
            { name: '北欧风台灯', desc: '木质底座+布艺灯罩', price: 158.0, cat: '家居', emoji: '💡' },
            { name: '进口红葡萄酒礼盒', desc: '法国波尔多产区', price: 238.0, cat: '食品', emoji: '🍷' },
            { name: '瑞士跑步鞋', desc: '透气网面·轻量缓震', price: 459.0, cat: '运动', emoji: '👟', tag: '新品' },
            { name: '小米智能音箱', desc: '小爱同学·智能家控', price: 199.0, cat: '数码', emoji: '🔊' },
            { name: '日本进口抹茶粉', desc: '宇治丸久小山园', price: 78.0, cat: '食品', emoji: '🍵' },
            { name: '文艺手账本套装', desc: 'A5尺寸·4本装', price: 45.0, cat: '书籍', emoji: '📓' },
            { name: '瑜伽垫套装', desc: 'TPE双面防滑·含绳', price: 89.0, cat: '运动', emoji: '🧘' },
            { name: '复古钢笔套装', desc: '明尖·可替换墨囊', price: 68.0, cat: '书籍', emoji: '✍️', tag: '精选' }
        ]
    }
};

const storeCarts = { takeout: [], shopping: [] };
let lastStoreOrder = { takeout: null, shopping: null };
let storeSearchTimers = { takeout: null, shopping: null };
let storeAIProducts = { takeout: [], shopping: [] };

// --- Dynamic Delivery Info ---
function getDeliveryInfo(product) {
    if (product && product.dist !== undefined) {
        const distVariance = (Math.random() * 0.4 - 0.2).toFixed(1);
        const dist = Math.max(0.3, product.dist + parseFloat(distVariance));
        const timeVariance = Math.floor(Math.random() * 10 - 5);
        const time = Math.max(10, (product.time || 30) + timeVariance);
        return `${dist.toFixed(1)}km · 约${time}分钟`;
    }
    const dist = (Math.random() * 4 + 0.3).toFixed(1);
    const time = Math.floor(Math.random() * 30 + 15);
    return `${dist}km · 约${time}分钟`;
}

// --- Open / Close ---
function openStoreApp(type) {
    const screen = document.getElementById(type + '-screen');
    if (!screen) return;
    screen.classList.add('visible');
    storeAIProducts[type] = [];
    renderStoreCategories(type);
    renderStoreProducts(type);
    updateStoreCartUI(type);
    updateDeliveryText(type);
}

function closeStoreApp(type) {
    const screen = document.getElementById(type + '-screen');
    if (!screen) return;
    screen.style.animation = 'screenSlideOut 0.3s ease forwards';
    setTimeout(() => {
        screen.classList.remove('visible');
        screen.style.animation = '';
    }, 280);
}

function updateDeliveryText(type) {
    const bar = document.querySelector(`#${type}-screen .store-cart-delivery`);
    if (!bar) return;
    if (type === 'takeout') {
        const fee = (Math.random() * 3 + 1).toFixed(1);
        const time = Math.floor(Math.random() * 20 + 20);
        bar.textContent = `配送费 ¥${fee} · 约${time}分钟送达`;
    } else {
        const days = Math.floor(Math.random() * 3 + 2);
        bar.textContent = `包邮 · 预计${days}-${days + 2}天送达`;
    }
}

// --- Categories ---
function renderStoreCategories(type) {
    const container = document.getElementById(type + '-categories');
    if (!container) return;
    const cats = storeData[type].categories;
    container.innerHTML = cats.map((c, i) =>
        `<button class="store-cat-btn${i === 0 ? ' active' : ''}" onclick="filterStoreCategory('${type}', '${c}', this)">${c}</button>`
    ).join('');
}

// --- Products ---
function renderStoreProducts(type, filter = '', category = '全部') {
    const container = document.getElementById(type + '-products');
    if (!container) return;
    let products = [...storeData[type].products];

    if (storeAIProducts[type].length > 0) {
        products = [...storeAIProducts[type], ...products];
    }

    if (category !== '全部') products = products.filter(p => p.cat === category);
    if (filter) products = products.filter(p => p._aiGenerated || p.name.includes(filter) || p.desc.includes(filter) || p.cat.includes(filter));

    if (products.length === 0) {
        container.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:40px 0;color:#bbb;font-size:14px;">没有找到相关商品<br><span style="font-size:12px;color:#ddd;">试试搜索其他关键词</span></div>`;
        return;
    }

    container.innerHTML = products.map((p) => {
        const isAI = p._aiGenerated;
        const origIdx = isAI
            ? -(storeAIProducts[type].indexOf(p) + 1)
            : storeData[type].products.indexOf(p);
        const deliveryInfo = type === 'takeout' ? `<div style="font-size:10px;color:#bbb;margin-top:2px;">${getDeliveryInfo(p)}</div>` : '';

        return `<div class="store-product-card" style="filter: saturate(0.85);">
                <div class="store-product-img">
                    ${isAI ? `<div style="font-size:12px;color:#666;display:flex;align-items:center;justify-content:center;height:100%;width:100%;background:#f5f5f5;border-radius:8px;text-align:center;padding:4px;">${(p.imgDesc || p.name).substring(0, 6)}</div>` : `<div style="font-size:14px;color:#666;font-weight:bold;display:flex;align-items:center;justify-content:center;height:100%;width:100%;background:#f5f5f5;border-radius:8px;text-align:center;padding:4px;line-height:1.2">${p.name.substring(0, 2)}</div>`}
                    ${p.tag ? `<div class="store-product-tag">${p.tag}</div>` : ''}
                </div>
                <div class="store-product-info">
                    <div class="store-product-name">${p.name}</div>
                    <div class="store-product-desc">${p.desc}</div>
                    ${deliveryInfo}
                    <div class="store-product-bottom">
                        <div class="store-product-price"><span class="currency">¥</span>${p.price.toFixed(2)}</div>
                        <button class="store-add-btn" onclick="event.stopPropagation();addToStoreCart('${type}', ${origIdx}, this)">+</button>
                    </div>
                </div>
            </div>`;
    }).join('');
}

// --- Category Filter ---
function filterStoreCategory(type, cat, btn) {
    const container = document.getElementById(type + '-categories');
    container.querySelectorAll('.store-cat-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    storeAIProducts[type] = [];
    renderStoreProducts(type, '', cat);
}

// --- Search with AI (spinner + minimum 3 products) ---
function filterStoreProducts(type, query, fromButton) {
    query = query || '';
    const container = document.getElementById(type + '-categories');
    if (container) {
        container.querySelectorAll('.store-cat-btn').forEach((b, i) => {
            b.classList.toggle('active', i === 0);
        });
    }

    // If not from button click, just filter existing products (no AI)
    if (!fromButton) {
        storeAIProducts[type] = [];
        renderStoreProducts(type, query);
        // Cancel any pending AI search
        if (storeSearchTimers[type]) clearTimeout(storeSearchTimers[type]);
        const spinner = document.getElementById(type + '-search-spinner');
        if (spinner) spinner.classList.remove('active');
        return;
    }

    // Button click: trigger AI search with spinner
    storeAIProducts[type] = [];
    renderStoreProducts(type, query);

    if (storeSearchTimers[type]) clearTimeout(storeSearchTimers[type]);

    const spinner = document.getElementById(type + '-search-spinner');

    if (query.trim().length > 0) {
        if (spinner) spinner.classList.add('active');
        triggerAISearch(type, query.trim());
    } else {
        if (spinner) spinner.classList.remove('active');
    }
}

async function triggerAISearch(type, query) {
    const spinner = document.getElementById(type + '-search-spinner');

    if (!appSettings.apiKey || !appSettings.apiEndpoint) {
        if (spinner) spinner.classList.remove('active');
        return;
    }

    // Ensure spinner is visible
    if (spinner) spinner.classList.add('active');

    const typeLabel = type === 'takeout' ? '外卖/跑腿平台（包括美食、生活用品、鲜花、药品、宠物用品等一切可以送到家的商品）' : '电商购物平台';
    const prompt = `用户在${typeLabel}搜索了"${query}"。请生成5个相关商品，返回JSON数组格式（不需要代码块标记），每个商品包含：
{"name":"商品名","desc":"一行描述","price":数字价格,"cat":"分类","emoji":"一个emoji","imgDesc":"商品图片的3-5字文字描述","tag":"标签(可选,如热卖/新品/特价,大部分不需要)"}
只返回JSON数组，不要其他文字。价格合理即可。必须返回至少3个商品。`;

    try {
        const response = await fetch(`${appSettings.apiEndpoint}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${appSettings.apiKey}`
            },
            body: JSON.stringify({
                model: appSettings.apiModel || 'gpt-3.5-turbo',
                messages: [{ role: 'user', content: prompt }],
                temperature: 0.8,
                max_tokens: 800
            })
        });
        const data = await response.json();
        const content = data.choices?.[0]?.message?.content || '';

        const jsonMatch = content.match(/\[[\s\S]*?\]/);
        if (jsonMatch) {
            let aiProducts = JSON.parse(jsonMatch[0]);
            // Enforce minimum 3 products
            if (aiProducts.length < 3) {
                console.warn('AI returned fewer than 3 products, padding...');
                while (aiProducts.length < 3) {
                    aiProducts.push({
                        name: `${query}精选${aiProducts.length + 1}`,
                        desc: `${query}相关推荐商品`,
                        price: Math.floor(Math.random() * 50 + 10),
                        cat: type === 'takeout' ? '美食' : '数码',
                        emoji: type === 'takeout' ? '🍽️' : '📦',
                        imgDesc: query
                    });
                }
            }
            aiProducts = aiProducts.slice(0, 6).map(p => ({
                ...p,
                price: parseFloat(p.price) || 9.9,
                _aiGenerated: true,
                dist: (Math.random() * 4 + 0.5),
                time: Math.floor(Math.random() * 30 + 15)
            }));
            storeAIProducts[type] = aiProducts;

            const searchInput = document.querySelector(`#${type}-screen .store-search input`);
            if (searchInput && searchInput.value.trim() === query) {
                renderStoreProducts(type, query);
            }
        }
    } catch (err) {
        console.warn('AI search failed:', err);
    } finally {
        // Always hide spinner when done
        if (spinner) spinner.classList.remove('active');
    }
}

// --- Cart Management ---
function addToStoreCart(type, productIdx, btnEl) {
    const product = getProductByIdx(type, productIdx);
    if (!product) return;

    const existing = storeCarts[type].find(c => c.idx === productIdx);
    if (existing) {
        existing.qty++;
    } else {
        storeCarts[type].push({ idx: productIdx, qty: 1, product });
    }
    updateStoreCartUI(type);
    if (btnEl) {
        btnEl.classList.add('cart-bounce');
        setTimeout(() => btnEl.classList.remove('cart-bounce'), 300);
    }
}

function getProductByIdx(type, idx) {
    if (idx >= 0) {
        return storeData[type].products[idx];
    } else {
        return storeAIProducts[type][-(idx + 1)];
    }
}

function updateStoreCartUI(type) {
    const cart = storeCarts[type];
    const totalQty = cart.reduce((s, c) => s + c.qty, 0);
    const totalPrice = cart.reduce((s, c) => {
        const p = c.product || getProductByIdx(type, c.idx);
        return s + (p ? p.price : 0) * c.qty;
    }, 0);

    const badge = document.getElementById(type + '-cart-badge');
    const count = document.getElementById(type + '-cart-count');
    if (badge) { badge.textContent = totalQty; badge.style.display = totalQty > 0 ? 'flex' : 'none'; }
    if (count) { count.textContent = totalQty; count.style.display = totalQty > 0 ? 'flex' : 'none'; }

    const totalEl = document.getElementById(type + '-cart-total');
    if (totalEl) totalEl.innerHTML = `<span class="currency">¥</span>${totalPrice.toFixed(2)}`;

    const checkoutBtn = document.getElementById(type + '-checkout-btn');
    if (checkoutBtn) checkoutBtn.disabled = totalQty === 0;

    renderStoreCartItems(type);
}

function renderStoreCartItems(type) {
    const container = document.getElementById(type + '-cart-items');
    if (!container) return;
    const cart = storeCarts[type];
    if (cart.length === 0) {
        container.innerHTML = `<div class="store-empty-cart"><div class="store-empty-cart-icon">🛒</div><div class="store-empty-cart-text">购物车是空的</div></div>`;
        return;
    }
    container.innerHTML = cart.map(item => {
        const p = item.product || getProductByIdx(type, item.idx);
        if (!p) return '';
        return `<div class="store-cart-item">
                <div class="store-cart-item-info">
                    <div class="store-cart-item-name"><span style="color:#888;font-size:12px;margin-right:4px;">[${p.cat || '商品'}]</span> ${p.name}</div>
                    <div class="store-cart-item-price">¥${(p.price * item.qty).toFixed(2)}</div>
                </div>
                <div class="store-cart-item-qty">
                    <button class="store-qty-btn" onclick="changeStoreQty('${type}', ${item.idx}, -1)">-</button>
                    <span class="store-qty-num">${item.qty}</span>
                    <button class="store-qty-btn" onclick="changeStoreQty('${type}', ${item.idx}, 1)">+</button>
                </div>
            </div>`;
    }).join('');
}

function changeStoreQty(type, productIdx, delta) {
    const item = storeCarts[type].find(c => c.idx === productIdx);
    if (!item) return;
    item.qty += delta;
    if (item.qty <= 0) {
        storeCarts[type] = storeCarts[type].filter(c => c.idx !== productIdx);
    }
    updateStoreCartUI(type);
}

function toggleStoreCart(type) {
    const overlay = document.getElementById(type + '-cart-overlay');
    if (!overlay) return;
    overlay.classList.toggle('visible');
}

function clearStoreCart(type) {
    storeCarts[type] = [];
    updateStoreCartUI(type);
    const overlay = document.getElementById(type + '-cart-overlay');
    if (overlay) overlay.classList.remove('visible');
}

// --- Checkout (step 1: show order confirmation) ---
function storeCheckout(type) {
    const cart = storeCarts[type];
    if (cart.length === 0) return;

    const totalPrice = cart.reduce((s, c) => {
        const p = c.product || getProductByIdx(type, c.idx);
        return s + (p ? p.price : 0) * c.qty;
    }, 0);

    const summary = cart.map(item => {
        const p = item.product || getProductByIdx(type, item.idx);
        if (!p) return '';
        return `[${p.cat || '商品'}] ${p.name} x${item.qty}  ¥${(p.price * item.qty).toFixed(2)}`;
    }).filter(Boolean).join('\n');

    const shopName = type === 'takeout' ? '即时配送' : '精选好物';

    lastStoreOrder[type] = {
        shopName,
        summary,
        total: totalPrice,
        items: cart.map(c => ({ ...c })),
        type
    };

    // Show checkout page, hide success page
    const checkoutPage = document.getElementById(type + '-checkout-page');
    const successPage = document.getElementById(type + '-success-page');
    if (checkoutPage) checkoutPage.style.display = '';
    if (successPage) successPage.style.display = 'none';

    const summaryEl = document.getElementById(type + '-order-summary');
    const totalEl = document.getElementById(type + '-order-total');
    if (summaryEl) summaryEl.textContent = summary;
    if (totalEl) totalEl.innerHTML = `<span class="currency">¥</span>${totalPrice.toFixed(2)}`;

    const modal = document.getElementById(type + '-order-modal');
    if (modal) modal.classList.add('visible');

    // Populate buy-for selector
    const buyForSelect = document.getElementById(type + '-buy-for');
    if (buyForSelect) {
        buyForSelect.innerHTML = '<option value="self">自己</option>';
        if (typeof npcCharacters !== 'undefined' && Array.isArray(npcCharacters)) {
            npcCharacters.forEach(npc => {
                if (npc.name) {
                    const opt = document.createElement('option');
                    opt.value = npc.name;
                    opt.textContent = npc.name;
                    buyForSelect.appendChild(opt);
                }
            });
        }
        buyForSelect.value = 'self';
    }

    // Clear cart
    storeCarts[type] = [];
    updateStoreCartUI(type);
    const overlay = document.getElementById(type + '-cart-overlay');
    if (overlay) overlay.classList.remove('visible');
}

function closeStoreOrderModal(type) {
    const modal = document.getElementById(type + '-order-modal');
    if (modal) modal.classList.remove('visible');
    // Reset pages
    const checkoutPage = document.getElementById(type + '-checkout-page');
    const successPage = document.getElementById(type + '-success-page');
    if (checkoutPage) checkoutPage.style.display = '';
    if (successPage) successPage.style.display = 'none';
}

// --- Payment: Self Pay ---
function storePaySelf(type) {
    const order = lastStoreOrder[type];
    if (!order) return;

    // Save buy-for info
    const buyForSelect = document.getElementById(type + '-buy-for');
    if (buyForSelect) {
        order.buyFor = buyForSelect.value;
    }

    // Switch to success page
    const checkoutPage = document.getElementById(type + '-checkout-page');
    const successPage = document.getElementById(type + '-success-page');
    if (checkoutPage) checkoutPage.style.display = 'none';
    if (successPage) successPage.style.display = '';

    const successTotal = document.getElementById(type + '-success-total');
    if (successTotal) successTotal.innerHTML = `<span class="currency">¥</span>${order.total.toFixed(2)}`;
}

// --- Payment: Friend Pay (代付) ---
function storePayFriend(type) {
    const order = lastStoreOrder[type];
    if (!order) return;

    // Save buy-for info
    const buyForSelect = document.getElementById(type + '-buy-for');
    if (buyForSelect) {
        order.buyFor = buyForSelect.value;
    }

    // Close checkout modal first
    closeStoreOrderModal(type);

    // Show chat picker for friend pay
    showStoreChatPicker(type, 'friendpay');
}

// --- Update buy-for selection ---
function updateStoreBuyFor(type) {
    const order = lastStoreOrder[type];
    const buyForSelect = document.getElementById(type + '-buy-for');
    if (order && buyForSelect) {
        order.buyFor = buyForSelect.value;
    }
}

// --- Share: Post-purchase share ---
function storeSharePurchase(type) {
    const order = lastStoreOrder[type];
    if (!order) return;

    closeStoreOrderModal(type);

    // Show chat picker for purchase share
    showStoreChatPicker(type, 'purchase');
}

// --- Unified Chat Picker ---
function showStoreChatPicker(type, mode) {
    // mode: 'friendpay' | 'purchase' | 'link'
    const order = lastStoreOrder[type];
    if (!order) return;

    let conversations = [];
    if (appSettings.privateChats && Array.isArray(appSettings.privateChats)) {
        appSettings.privateChats.forEach(name => {
            let avatar = '';
            const npc = typeof npcCharacters !== 'undefined' ? npcCharacters.find(n => n.name === name) : null;
            if (npc && npc.avatar) avatar = npc.avatar;
            conversations.push({ tag: `chat:${name}`, name, avatar, isGroup: false });
        });
    }
    if (appSettings.groups && Array.isArray(appSettings.groups)) {
        appSettings.groups.forEach(group => {
            conversations.push({
                tag: `group:${group.name}`,
                name: group.name,
                avatar: '',
                isGroup: true
            });
        });
    }

    if (conversations.length === 0) {
        if (typeof showToast === 'function') showToast('还没有聊天，请先创建联系人');
        return;
    }

    const modeLabels = {
        'friendpay': '选择好友代付',
        'purchase': '分享好物给好友',
        'link': '分享商品链接'
    };

    const screen = document.getElementById(type + '-screen');
    const placeholderAvatar = "data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='%23cccccc'%3E%3Cpath d='M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z'/%3E%3C/svg%3E";

    const picker = document.createElement('div');
    picker.className = 'store-order-modal visible';
    picker.id = type + '-share-picker';
    picker.onclick = (e) => { if (e.target === picker) picker.remove(); };
    picker.innerHTML = `
            <div class="store-order-box" style="padding:20px 16px;max-height:70vh;display:flex;flex-direction:column;">
                <div style="font-size:16px;font-weight:700;color:#1a1a1a;margin-bottom:14px;text-align:center;">${modeLabels[mode] || '选择聊天'}</div>
                <div style="flex:1;overflow-y:auto;margin:0 -8px;">
                    ${conversations.map(c => `
                        <div onclick="confirmStoreShare('${type}', '${mode}', '${c.tag}', '${c.name}')"
                             style="display:flex;align-items:center;gap:12px;padding:12px 8px;cursor:pointer;border-radius:12px;transition:background 0.15s;"
                             onmousedown="this.style.background='#f5f5f5'" onmouseup="this.style.background=''" onmouseleave="this.style.background=''">
                            <img src="${c.avatar || placeholderAvatar}" style="width:40px;height:40px;border-radius:50%;object-fit:cover;background:#f0f0f0;">
                            <div style="flex:1;">
                                <div style="font-size:14px;font-weight:500;color:#1a1a1a;">${c.name}</div>
                                <div style="font-size:11px;color:#aaa;">${c.isGroup ? '群聊' : '私聊'}</div>
                            </div>
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="#ccc"><path d="M10 6l6 6-6 6" stroke="#ccc" stroke-width="2" fill="none" stroke-linecap="round"/></svg>
                        </div>
                    `).join('')}
                </div>
                <button class="store-order-btn secondary" style="margin-top:12px;" onclick="document.getElementById('${type}-share-picker').remove()">取消</button>
            </div>
        `;
    screen.appendChild(picker);
}

// --- Unified Share Confirm ---
function confirmStoreShare(type, mode, chatTag, chatName) {
    const order = lastStoreOrder[type];
    if (!order) return;

    // Remove picker
    const picker = document.getElementById(type + '-share-picker');
    if (picker) picker.remove();

    const t = typeof getTime === 'function' ? getTime(true) : '12:00';
    const u = typeof getUserName === 'function' ? getUserName() : '我';

    const itemNames = order.items.map(item => {
        const p = item.product || getProductByIdx(type, item.idx);
        return p ? (p.name + ' x' + item.qty) : '';
    }).filter(Boolean).join('、');

    // Build the message to send
    let msgHeader, msgBody, msgType;

    // Determine buy-for suffix
    const buyFor = order.buyFor && order.buyFor !== 'self' ? order.buyFor : null;
    const buyForSuffix = buyFor ? ` [送给${buyFor}]` : '';

    if (mode === 'friendpay') {
        const body = type === 'takeout'
            ? `${order.shopName}|${itemNames}${buyForSuffix} (请帮我代付)|¥${order.total.toFixed(2)}`
            : `${itemNames}${buyForSuffix} (请帮我代付)|¥${order.total.toFixed(2)}`;
        msgType = type === 'takeout' ? 'deliver' : 'link';
        const headerTag = type === 'takeout' ? 'DELIVER' : 'LINK';
        msgHeader = `[${u}|${headerTag}|${t}]`;
        msgBody = body;
    } else if (mode === 'purchase') {
        if (type === 'takeout') {
            msgBody = `${order.shopName}|${itemNames}${buyForSuffix}|¥${order.total.toFixed(2)}`;
            msgHeader = `[${u}|DELIVER|${t}]`;
            msgType = 'deliver';
        } else {
            const firstItem = order.items[0];
            const p = firstItem ? (firstItem.product || getProductByIdx(type, firstItem.idx)) : null;
            const firstName = p ? p.name : '商品';
            msgBody = `${firstName} 等${order.items.length}件商品${buyForSuffix}|¥${order.total.toFixed(2)}`;
            msgHeader = `[${u}|LINK|${t}]`;
            msgType = 'link';
        }
    } else {
        // Link share (legacy)
        if (type === 'takeout') {
            msgBody = `${order.shopName}|${itemNames}${buyForSuffix}|¥${order.total.toFixed(2)}`;
            msgHeader = `[${u}|DELIVER|${t}]`;
            msgType = 'deliver';
        } else {
            const firstItem = order.items[0];
            const p = firstItem ? (firstItem.product || getProductByIdx(type, firstItem.idx)) : null;
            const firstName = p ? p.name : '商品';
            msgBody = `${firstName} 等${order.items.length}件商品${buyForSuffix}|¥${order.total.toFixed(2)}`;
            msgHeader = `[${u}|LINK|${t}]`;
            msgType = 'link';
        }
    }

    const msgData = { header: msgHeader, body: msgBody, isUser: true, type: msgType };

    // For purchase and friendpay modes: stay on current page, save message to target chat history directly
    if (mode === 'purchase' || mode === 'friendpay') {
        // Save message directly to the target chat's IndexedDB history
        (async () => {
            try {
                let history = await getChatHistory(chatTag) || [];
                history.push(msgData);
                await saveChatHistory(chatTag, history);
            } catch (e) {
                console.error('Failed to save shared message to chat history', e);
            }
        })();

        const notifyMsg = mode === 'friendpay'
            ? `已发送代付请求给「${chatName}」`
            : `已分享到「${chatName}」的聊天`;
        showStoreNotification(notifyMsg);
    } else {
        // Legacy link mode: navigate to chat and render there
        closeStoreApp(type);
        setTimeout(() => {
            if (typeof openChat === 'function') openChat(chatTag, chatName);
            setTimeout(() => {
                if (typeof renderMessageToUI === 'function') {
                    renderMessageToUI(msgData);
                    if (typeof saveHistory === 'function') saveHistory();
                }
            }, 500);
        }, 400);
    }
}

// --- Legacy wrapper (kept for backward compat) ---
function sendStoreOrderToChat(type) {
    const order = lastStoreOrder[type];
    if (!order) return;
    closeStoreOrderModal(type);
    showStoreChatPicker(type, 'link');
}

function confirmShareToChat(type, chatTag, chatName) {
    confirmStoreShare(type, 'link', chatTag, chatName);
}

// --- Top Notification Bar ---
function showStoreNotification(message, options = {}) {
    const existing = document.querySelector('.store-top-notification');
    if (existing) existing.remove();

    const icon = options.icon || '✓';
    const iconColor = options.iconColor || '#4CAF50';

    const notification = document.createElement('div');
    notification.className = 'store-top-notification';
    notification.innerHTML = `
            <div style="display:flex;align-items:center;gap:10px;">
                <div style="width:22px;height:22px;border-radius:6px;background:${iconColor};display:flex;align-items:center;justify-content:center;flex-shrink:0;">
                    <span style="color:white;font-size:12px;font-weight:bold;">${icon}</span>
                </div>
                <span>${message}</span>
            </div>
        `;

    Object.assign(notification.style, {
        position: 'fixed',
        top: '8px',
        left: '8px',
        right: '8px',
        transform: 'translateY(-120%)',
        background: 'rgba(245, 245, 247, 0.92)',
        backdropFilter: 'blur(20px)',
        WebkitBackdropFilter: 'blur(20px)',
        color: '#1c1c1e',
        padding: '12px 16px',
        borderRadius: '14px',
        fontSize: '13px',
        fontWeight: '500',
        zIndex: '99999',
        boxShadow: '0 2px 20px rgba(0, 0, 0, 0.12), 0 0 1px rgba(0, 0, 0, 0.1)',
        transition: 'transform 0.4s cubic-bezier(0.2, 0.8, 0.2, 1)',
        textAlign: 'left',
        lineHeight: '1.4'
    });

    document.body.appendChild(notification);

    requestAnimationFrame(() => {
        notification.style.transform = 'translateY(0)';
    });

    setTimeout(() => {
        notification.style.transform = 'translateY(-120%)';
        setTimeout(() => notification.remove(), 400);
    }, 2500);
}

// --- Export to window ---
window.openStoreApp = openStoreApp;
window.closeStoreApp = closeStoreApp;
window.filterStoreCategory = filterStoreCategory;
window.filterStoreProducts = filterStoreProducts;
window.addToStoreCart = addToStoreCart;
window.changeStoreQty = changeStoreQty;
window.toggleStoreCart = toggleStoreCart;
window.clearStoreCart = clearStoreCart;
window.storeCheckout = storeCheckout;
window.closeStoreOrderModal = closeStoreOrderModal;
window.storePaySelf = storePaySelf;
window.storePayFriend = storePayFriend;
window.storeSharePurchase = storeSharePurchase;
window.showStoreChatPicker = showStoreChatPicker;
window.confirmStoreShare = confirmStoreShare;
window.sendStoreOrderToChat = sendStoreOrderToChat;
window.confirmShareToChat = confirmShareToChat;
window.showStoreNotification = showStoreNotification;
window.updateStoreBuyFor = updateStoreBuyFor;

﻿// ====== Red Packet (红包) Module ======

function showRedpacketModal() {
    // Determine context
    const isGroup = typeof currentChatTag !== 'undefined' && currentChatTag && currentChatTag.startsWith('group:');

    // Create overlay
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    // Let's use innerHTML for cleaner template
    overlay.innerHTML = `
        <div class="modal-box group-modal-cute" style="width: 320px;">
            <div class="modal-title group-modal-title" style="margin-top:0; margin-bottom: 20px; text-align: left;">
                发红包
                <div class="modal-close" style="float: right; cursor: pointer; color: #999;">×</div>
            </div>
            
            <div class="group-modal-field">
                <label class="group-modal-label">红包类型</label>
                <select id="rp-type-select" class="group-modal-select">
                    ${isGroup
            ? '<option value="lucky">拼手气红包</option><option value="normal">普通红包</option><option value="exclusive">专属红包</option>'
            : '<option value="normal" selected>普通红包</option><option value="exclusive">专属红包</option>'}
                </select>
            </div>

            <div class="group-modal-field" id="rp-target-group" style="display:none;">
                <label class="group-modal-label">发给谁</label>
                <select id="rp-target-select" class="group-modal-select">
                    ${isGroup
            ? (appSettings.groupChats[parseInt(currentChatTarget)]?.members || []).map(m => `<option value="${m}">${m}</option>`).join('')
            : `<option value="${currentChatTarget}">${currentChatTarget}</option>`}
                </select>
            </div>

            <div class="group-modal-field" id="rp-count-group" style="display: ${isGroup ? 'block' : 'none'};">
                <label class="group-modal-label">红包个数</label>
                <input type="number" id="rp-count-input" class="group-modal-input" value="${isGroup ? '3' : '1'}" min="1">
            </div>

            <div class="group-modal-field">
                <label class="group-modal-label" id="rp-amount-label">${isGroup ? '总金额' : '单个金额'}</label>
                <div style="position: relative;">
                    <span style="position:absolute;left:10px;top:10px;font-size:16px;font-weight:bold;color:#333;">¥</span>
                    <input type="number" id="rp-amount-input" class="group-modal-input" placeholder="0.00" step="0.01" style="padding-left: 25px;">
                </div>
            </div>

            <div class="group-modal-field" style="margin-bottom: 20px;">
                <label class="group-modal-label">留言</label>
                <input type="text" id="rp-note-input" class="group-modal-input" placeholder="恭喜发财，大吉大利">
            </div>

            <div class="modal-actions">
                <button id="rp-send-btn" class="modal-btn group-modal-confirm" style="width: 100%;">塞钱进红包</button>
            </div>
        </div>
    `;

    document.body.appendChild(overlay);

    const modal = overlay.querySelector('.modal-box');
    const closeBtn = overlay.querySelector('.modal-close');
    const typeSelect = overlay.querySelector('#rp-type-select');
    const targetGroup = overlay.querySelector('#rp-target-group');
    const targetSelect = overlay.querySelector('#rp-target-select');
    const countGroup = overlay.querySelector('#rp-count-group');
    const countInput = overlay.querySelector('#rp-count-input');
    const amountLabel = overlay.querySelector('#rp-amount-label');
    const amountInput = overlay.querySelector('#rp-amount-input');
    const noteInput = overlay.querySelector('#rp-note-input');
    const sendBtn = overlay.querySelector('#rp-send-btn');

    closeBtn.onclick = () => { overlay.classList.remove('visible'); setTimeout(() => overlay.remove(), 300); };

    const updateUIState = () => {
        if (typeSelect.value === 'exclusive') {
            targetGroup.style.display = 'block';
            countGroup.style.display = 'none';
            countInput.value = '1';
            amountLabel.textContent = '金额';
        } else {
            targetGroup.style.display = 'none';
            countGroup.style.display = isGroup ? 'block' : 'none';
            amountLabel.textContent = typeSelect.value === 'normal' ? '单个金额' : '总金额';
        }
    };

    typeSelect.addEventListener('change', updateUIState);
    updateUIState(); // init

    sendBtn.onclick = () => {
        const type = typeSelect.value;
        const count = parseInt(countInput.value) || 1;
        const amount = parseFloat(amountInput.value) || 0;
        const note = noteInput.value || '恭喜发财，大吉大利';
        const target = targetGroup.style.display !== 'none' ? targetSelect.value : '';

        if (amount <= 0) {
            if (typeof showToast === 'function') showToast('请输入有效金额');
            return;
        }

        let totalTotal = amount;
        if (type === 'normal') totalTotal = amount * count;

        overlay.classList.remove('visible');
        setTimeout(() => overlay.remove(), 300);

        const timestamp = typeof getTime === 'function' ? getTime() : new Date().toLocaleTimeString('en-US', { hour12: false, hour: "numeric", minute: "numeric" });
        const userName = typeof getUserName === 'function' ? getUserName() : '我';

        const internalData = {
            totalAmount: totalTotal,
            note: note,
            type: type, // lucky, normal, exclusive
            count: count,
            target: target, // char name
            perAmount: type === 'normal' ? amount : null,
            openedList: [] // list of objects: { name, amount, time }
        };
        const bodyContent = JSON.stringify(internalData);

        if (typeof renderMessageToUI === 'function') {
            renderMessageToUI({
                header: `[${userName}|REDPACKET|${timestamp}]`,
                body: bodyContent,
                isUser: true,
                type: 'redpacket'
            });
        }

        if (typeof saveCurrentChatHistory === 'function') saveCurrentChatHistory();
        if (typeof toggleChatActionMenu === 'function') {
            const actionMenu = document.getElementById('action-menu');
            if (actionMenu && actionMenu.classList.contains('open')) {
                toggleChatActionMenu();
            }
        }
    };

    requestAnimationFrame(() => overlay.classList.add('visible'));
}

function openRedPacket(cardEl, dataStr) {
    if (document.querySelector('.rp-open-overlay')) return;

    let data;
    try {
        data = JSON.parse(dataStr);
    } catch (e) {
        console.error("Invalid red packet data", e);
        return;
    }

    const myName = typeof getUserName === 'function' ? getUserName() : '我';
    const isSender = cardEl.dataset.senderName === myName;
    const isCompleted = data.openedList.length >= data.count;
    const myOpenRecord = data.openedList.find(r => r.name === myName);

    if (data.type === 'exclusive' && data.target !== myName) {
        if (!isSender) {
            if (typeof showToast === 'function') showToast('该红包是专属红包');
        } else {
            showRedPacketRecord(data, cardEl.dataset.senderName);
        }
        return;
    }

    // If I already opened it, or it's empty, show the record directly
    if (myOpenRecord || isCompleted) {
        showRedPacketRecord(data, cardEl.dataset.senderName);
        return;
    }

    // Otherwise open it!
    const overlay = document.createElement('div');
    overlay.className = 'rp-open-overlay';
    overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.6);z-index:9000;display:flex;align-items:center;justify-content:center;opacity:0;transition:opacity 0.3s;';

    const modal = document.createElement('div');
    modal.style.cssText = 'width:280px;height:380px;background:#e5594b;border-radius:12px;position:relative;display:flex;flex-direction:column;align-items:center;padding:25px;box-sizing:border-box;color:#fad9a2;transform:scale(0.9);transition:transform 0.3s;box-shadow:inset 0 0 100px rgba(0,0,0,0.1);';

    const closeBtn = document.createElement('div');
    closeBtn.innerHTML = '✕';
    closeBtn.style.cssText = 'position:absolute;top:15px;left:15px;font-size:20px;color:#fad9a2;cursor:pointer;opacity:0.8;';
    closeBtn.onclick = () => {
        overlay.style.opacity = '0';
        setTimeout(() => overlay.remove(), 300);
    };
    modal.appendChild(closeBtn);

    const header = document.createElement('div');
    header.style.cssText = 'margin-top:20px;text-align:center;width:100%;';

    // Sender avatar (mocked here, use default if real isn't available)
    const avatar = document.createElement('div');
    avatar.style.cssText = 'width:56px;height:56px;border-radius:8px;background:url(https://api.iconify.design/bx:bx-user.svg) center / 60% no-repeat #ffcc80;margin:0 auto 10px;';
    header.appendChild(avatar);

    const senderText = document.createElement('div');
    senderText.style.cssText = 'font-size:16px;font-weight:bold;margin-bottom:5px;';
    senderText.textContent = cardEl.dataset.senderName + '的红包';
    header.appendChild(senderText);

    const noteText = document.createElement('div');
    noteText.style.cssText = 'font-size:22px;color:#fad9a2;font-weight:bold;margin-top:20px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;width:100%;';
    noteText.textContent = data.note;
    header.appendChild(noteText);

    // Open seal button
    const openBtn = document.createElement('div');
    openBtn.style.cssText = 'width:90px;height:90px;border-radius:50%;background:#fad9a2;color:#333;font-size:36px;font-weight:bold;display:flex;align-items:center;justify-content:center;position:absolute;bottom:60px;cursor:pointer;box-shadow:0 6px 15px rgba(0,0,0,0.2);user-select:none;';
    openBtn.textContent = '开';

    openBtn.onclick = () => {
        openBtn.style.transform = 'scale(0.95)';
        setTimeout(() => { openBtn.style.transform = 'scale(1)'; }, 150);

        setTimeout(() => {
            // compute amount
            let myAmount = 0;
            if (data.type === 'normal' || data.type === 'exclusive') {
                myAmount = data.type === 'normal' ? data.perAmount : data.totalAmount;
            } else {
                // lucky
                const remainCount = data.count - data.openedList.length;
                const remainAmount = data.totalAmount - data.openedList.reduce((sum, o) => sum + o.amount, 0);

                if (remainCount === 1) {
                    myAmount = remainAmount;
                } else {
                    // simple red packet random logic
                    const max = (remainAmount / remainCount) * 2;
                    myAmount = Math.max(0.01, Math.random() * max);
                }
            }
            myAmount = parseFloat(myAmount.toFixed(2));

            const timestamp = typeof getTime === 'function' ? getTime() : new Date().toLocaleTimeString('en-US', { hour12: false, hour: "numeric", minute: "numeric" });
            const myRecord = { name: myName, amount: myAmount, time: timestamp, isUser: true };
            data.openedList.push(myRecord);

            // update element
            cardEl.dataset.rawBody = JSON.stringify(data);
            if (typeof saveCurrentChatHistory === 'function') saveCurrentChatHistory();

            // render system notice to yourself
            if (typeof renderMessageToUI === 'function') {
                const row = document.createElement('div');
                row.className = 'message-row system';
                row.style.cssText = 'justify-content:center; display:flex;';
                const notice = document.createElement('div');
                notice.className = 'recall-notice';
                notice.style.cssText = 'font-size:12px;color:#999;background:rgba(0,0,0,0.05);padding:4px 12px;border-radius:10px;';
                let systemText = isSender ? '你领取了自己的红包' : `你领取了 ${cardEl.dataset.senderName} 的红包`;
                notice.textContent = systemText;
                row.appendChild(notice);
                const chatMessages = document.getElementById('chat-messages');
                if (chatMessages) {
                    chatMessages.appendChild(row);
                    chatMessages.scrollTop = chatMessages.scrollHeight;
                }
                if (typeof saveCurrentChatHistory === 'function') saveCurrentChatHistory();
            }

            // Update UI
            updateRedpacketCardUI(cardEl, data);

            overlay.style.opacity = '0';
            setTimeout(() => {
                overlay.remove();
                showRedPacketRecord(data, cardEl.dataset.senderName);
            }, 300);
        }, 500); // add a slight delay for realism
    };

    modal.appendChild(header);
    modal.appendChild(openBtn);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    requestAnimationFrame(() => {
        overlay.style.opacity = '1';
        modal.style.transform = 'scale(1)';
    });
}

function showRedPacketRecord(data, senderName) {
    if (document.querySelector('.rp-record-overlay')) return;

    const overlay = document.createElement('div');
    overlay.className = 'transfer-modal-overlay rp-record-overlay';

    const m = document.createElement('div');
    m.style.cssText = 'width:100%;height:100%;background:#f5f5f5;position:absolute;top:0;left:0;display:flex;flex-direction:column;z-index:10000;';

    const myName = typeof getUserName === 'function' ? getUserName() : '我';

    let header = document.createElement('div');
    header.style.cssText = 'background:#e5594b;position:relative;padding:15px;color:#fad9a2;text-align:center;padding-bottom:120px;';

    let backBtn = document.createElement('div');
    backBtn.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24" stroke="currentColor" fill="none"><path d="M15 18l-6-6 6-6" stroke-width="2"></path></svg>';
    backBtn.style.cssText = 'position:absolute;top:15px;left:15px;cursor:pointer;';
    backBtn.onclick = () => { overlay.classList.remove('visible'); setTimeout(() => overlay.remove(), 300); };
    header.appendChild(backBtn);

    let topText = document.createElement('div');
    topText.textContent = senderName + "的红包";
    topText.style.cssText = 'font-size:18px;font-weight:bold;margin-top:10px;';
    header.appendChild(topText);

    let topNote = document.createElement('div');
    topNote.textContent = data.note;
    topNote.style.cssText = 'font-size:14px;margin-top:8px;opacity:0.9;';
    header.appendChild(topNote);

    // Summary card
    let paper = document.createElement('div');
    paper.style.cssText = 'background:#fff;margin:-80px 15px 15px 15px;border-radius:8px;z-index:2;position:relative;box-shadow:0 2px 10px rgba(0,0,0,0.05);flex:1;display:flex;flex-direction:column;';

    // My amount
    let myRecord = data.openedList.find(r => r.name === myName);
    if (myRecord) {
        let amountArea = document.createElement('div');
        amountArea.style.cssText = 'padding:30px 0;text-align:center;border-bottom:10px solid #f5f5f5;';
        amountArea.innerHTML = `<div style="font-size:36px;color:#e5594b;font-weight:bold;">${myRecord.amount.toFixed(2)}<span style="font-size:14px;color:#333;margin-left:4px;">元</span></div>`;
        paper.appendChild(amountArea);
    }

    // List header
    let listHeader = document.createElement('div');
    listHeader.style.cssText = 'padding:15px;font-size:14px;color:#666;border-bottom:1px solid #f0f0f0;';
    if (data.openedList.length === 0) {
        listHeader.textContent = `等待领取，共 ${data.count} 个，合计 ${data.totalAmount.toFixed(2)} 元`;
    } else {
        listHeader.textContent = `已领取 ${data.openedList.length}/${data.count} 个，合计 ${data.totalAmount.toFixed(2)} 元`;
    }
    paper.appendChild(listHeader);

    // List items
    let scrollArea = document.createElement('div');
    scrollArea.style.cssText = 'flex:1;overflow-y:auto;';

    data.openedList.forEach(item => {
        let row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:15px;border-bottom:1px solid #f0f0f0;';

        let left = document.createElement('div');
        let nameDiv = document.createElement('div');
        nameDiv.textContent = item.name;
        nameDiv.style.cssText = 'font-size:15px;font-weight:500;margin-bottom:4px;color:#333;';
        let timeDiv = document.createElement('div');
        timeDiv.textContent = item.time || '';
        timeDiv.style.cssText = 'font-size:12px;color:#999;';
        left.appendChild(nameDiv); left.appendChild(timeDiv);

        let right = document.createElement('div');
        right.textContent = item.amount.toFixed(2) + "元";
        right.style.cssText = 'font-size:15px;font-weight:bold;color:#333;';

        row.appendChild(left); row.appendChild(right);
        scrollArea.appendChild(row);
    });

    paper.appendChild(scrollArea);

    m.appendChild(header);
    m.appendChild(paper);
    overlay.appendChild(m);
    document.body.appendChild(overlay);

    requestAnimationFrame(() => overlay.classList.add('visible'));
}

function updateRedpacketCardUI(el, data) {
    const isCompleted = data.openedList.length >= data.count;
    const myName = typeof getUserName === 'function' ? getUserName() : '我';
    const isOpenedByMe = data.openedList.some(r => r.name === myName);

    let statusText = '微信红包';
    if (isCompleted && isOpenedByMe) statusText = '已领取';
    else if (isCompleted) statusText = '被抢光了';
    else if (isOpenedByMe) statusText = '已领取';

    // Update the UI
    const bottomText = el.querySelector('.redpacket-bottom');
    if (bottomText) bottomText.textContent = statusText;

    if (isCompleted || isOpenedByMe) {
        el.classList.add('completed');
    } else {
        el.classList.remove('completed');
    }
}

function simulateAIGrabRedPacket(cardEl, aiName) {
    if (!cardEl || !cardEl.dataset.rawBody) return false;

    let data;
    try {
        data = JSON.parse(cardEl.dataset.rawBody);
    } catch (e) {
        return false;
    }

    // Check if can grab
    const isCompleted = data.openedList.length >= data.count;
    const aiOpenRecord = data.openedList.find(r => r.name === aiName);

    if (isCompleted || aiOpenRecord) return false; // already grabbed or empty
    if (data.type === 'exclusive' && data.target !== aiName) return false; // not for this AI

    // Compute amount
    let aiAmount = 0;
    if (data.type === 'normal' || data.type === 'exclusive') {
        aiAmount = data.type === 'normal' ? data.perAmount : data.totalAmount;
    } else {
        const remainCount = data.count - data.openedList.length;
        const remainAmount = data.totalAmount - data.openedList.reduce((sum, o) => sum + o.amount, 0);
        if (remainCount === 1) {
            aiAmount = remainAmount;
        } else {
            const max = (remainAmount / remainCount) * 2;
            aiAmount = Math.max(0.01, Math.random() * max);
        }
    }
    aiAmount = parseFloat(aiAmount.toFixed(2));

    const timestamp = typeof getTime === 'function' ? getTime() : new Date().toLocaleTimeString('en-US', { hour12: false, hour: "numeric", minute: "numeric" });
    const aiRecord = { name: aiName, amount: aiAmount, time: timestamp, isUser: false };
    data.openedList.push(aiRecord);

    cardEl.dataset.rawBody = JSON.stringify(data);
    updateRedpacketCardUI(cardEl, data);
    return { success: true, amount: aiAmount };
}



﻿// ========== Forum (星海社区) App - Advanced Community Hub ==========

let forumPosts = [];
let forumComposeImages = [];
let forumCurrentSection = 'recommend'; // active section/tab
let forumViewingPostId = null;
let forumSearchQuery = '';
let forumSearchActive = false;
let forumReplyTarget = null; // { commentIdx, author } for reply-to-comment
const FORUM_MAX_POSTS_PER_SECTION = 5; // limit posts per section to save memory
const FORUM_PROFILE_KEY = 'faye-phone-forum-profile';
const FORUM_ANONYMOUS_NAME = '匿名用户';
const FORUM_DEFAULT_AVATAR = "data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='%23d1d1d6'%3E%3Cpath d='M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z'/%3E%3C/svg%3E";

// --- Forum Sections ---
const FORUM_SECTIONS = [
    { id: 'recommend', name: '推荐', desc: '为你精选的优质内容' },
    { id: 'hot', name: '热门', desc: '当下最热的讨论' },
    { id: 'cosplay', name: '同人', desc: '同人创作 · 二创 · 小说漫画' },
    { id: 'campus', name: '校园', desc: '校园生活 · 学业 · 吐槽' },
    { id: 'community', name: '同城', desc: '同城交友 · 本地生活' },
    { id: 'star', name: '明星', desc: '追星 · 偶像 · 饭圈资讯' },
    { id: 'gossip', name: '吃瓜', desc: '吃瓜所 · 热搜 · 吃瓜群众' },
    { id: 'food', name: '美食', desc: '美食分享 · 探店 · 菜谱' },
    { id: 'pets', name: '萌宠', desc: '萌宠日常 · 养宠经验 · 晒宠' },
];

// --- Post Tags ---
const FORUM_TAGS = {
    cosplay: ['原创', '小说', '同人文', '漫画', '安利'],
    campus: ['吐槽', '考试', '恋爱', '社团', '求助'],
    community: ['公告', '求助', '二手', '拼车', '失物'],
    star: ['追星', '资讯', '安利', '回顾', '打call'],
    gossip: ['吃瓜', '热搜', '吐槽', '科普', '讨论'],
    food: ['探店', '菜谱', '甜品', '家常菜', '减脂餐'],
    pets: ['猫咪', '狗狗', '仓鼠', '日常', '求助'],
};

// --- Storage ---
function loadForumData() {
    const stored = localStorage.getItem('faye-phone-forum');
    if (stored) {
        try { forumPosts = JSON.parse(stored); } catch (e) { forumPosts = []; }
    }
}

function saveForumData() {
    // Trim posts per section to limit (except recommend/hot which are virtual)
    trimForumPosts();
    localStorage.setItem('faye-phone-forum', JSON.stringify(forumPosts));
}

function trimForumPosts() {
    // Group by section, keep only FORUM_MAX_POSTS_PER_SECTION per section
    // User's own posts are excluded from the limit
    const sectionIds = FORUM_SECTIONS.filter(s => s.id !== 'recommend' && s.id !== 'hot').map(s => s.id);
    for (const secId of sectionIds) {
        // Only count non-user posts toward the limit
        const sectionPosts = forumPosts.filter(p => p.section === secId && !isForumOwnedPost(p));
        if (sectionPosts.length > FORUM_MAX_POSTS_PER_SECTION) {
            sectionPosts.sort((a, b) => b.timestamp - a.timestamp);
            const toRemove = sectionPosts.slice(FORUM_MAX_POSTS_PER_SECTION);
            const removeIds = new Set(toRemove.map(p => p.id));
            forumPosts = forumPosts.filter(p => !removeIds.has(p.id));
        }
    }
}

// --- Helpers ---
function getBaseForumUserName() {
    const userId = typeof getCurrentUserId === 'function' ? getCurrentUserId() : undefined;
    return (userId !== undefined && userCharacters[userId]) ? userCharacters[userId].name : 'User';
}

function getForumProfile() {
    let forumProfile = { name: getBaseForumUserName(), avatar: '' };
    try {
        const storedProfile = localStorage.getItem(FORUM_PROFILE_KEY);
        if (storedProfile) {
            forumProfile = { ...forumProfile, ...JSON.parse(storedProfile) };
        }
    } catch (e) { }
    if (!forumProfile.name || !forumProfile.name.trim()) {
        forumProfile.name = getBaseForumUserName();
    }
    return forumProfile;
}

function getForumUserAvatar() {
    const forumProfile = getForumProfile();
    if (forumProfile.avatar) return forumProfile.avatar;
    const userId = typeof getCurrentUserId === 'function' ? getCurrentUserId() : undefined;
    if (userId !== undefined && userCharacters[userId]?.avatar) return userCharacters[userId].avatar;
    return FORUM_DEFAULT_AVATAR;
}

function isForumOwnedPost(post) {
    if (!post) return false;
    const currentUserId = typeof getCurrentUserId === 'function' ? getCurrentUserId() : undefined;
    if (currentUserId !== undefined && post._realAuthorId !== undefined) {
        return String(post._realAuthorId) === String(currentUserId);
    }
    const currentUser = getForumUserName();
    const legacyUserName = getBaseForumUserName();
    return post.author === currentUser
        || post._realAuthor === currentUser
        || post.author === legacyUserName
        || post._realAuthor === legacyUserName;
}

function encodeForumArg(value) {
    return encodeURIComponent(String(value ?? ''));
}

function getForumAvatar(name, explicitAvatar = '') {
    if (explicitAvatar) return explicitAvatar;
    if (name === FORUM_ANONYMOUS_NAME) return FORUM_DEFAULT_AVATAR;
    const forumProfile = getForumProfile();
    if (name === forumProfile.name) {
        return getForumUserAvatar();
    }
    if (typeof npcCharacters !== 'undefined') {
        const npc = npcCharacters.find(n => n.name === name);
        if (npc && npc.avatar) return npc.avatar;
    }
    if (typeof userCharacters !== 'undefined') {
        const user = userCharacters.find(u => u.name === name);
        if (user && user.avatar) return user.avatar;
    }
    return FORUM_DEFAULT_AVATAR;
}

function formatForumTime(timestamp) {
    const diff = Date.now() - timestamp;
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);
    if (minutes < 1) return '刚刚';
    if (minutes < 60) return `${minutes}分钟前`;
    if (hours < 24) return `${hours}小时前`;
    if (days < 7) return `${days}天前`;
    const d = new Date(timestamp);
    return `${d.getMonth() + 1}-${d.getDate()}`;
}

function getForumUserName() {
    return getForumProfile().name;
}

function escapeForumHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function getForumSectionById(id) {
    return FORUM_SECTIONS.find(s => s.id === id) || FORUM_SECTIONS[0];
}

// --- Open / Close ---
function openForumApp() {
    const screen = document.getElementById('forum-screen');
    if (!screen) return;
    loadForumData();
    screen.style.display = 'flex';
    forumCurrentSection = 'recommend';
    forumSearchActive = false;
    forumSearchQuery = '';
    // Reset inline search input
    const searchInput = document.getElementById('forum-search-input');
    if (searchInput) searchInput.value = '';
    renderForumSections();
    switchForumTab('recommend');
}

function closeForumApp() {
    const screen = document.getElementById('forum-screen');
    if (!screen) return;
    screen.style.animation = 'screenSlideOut 0.3s ease forwards';
    setTimeout(() => {
        screen.style.display = 'none';
        screen.style.animation = '';
    }, 280);
}

// --- Section Tabs ---
function renderForumSections() {
    const tabsContainer = document.getElementById('forum-tabs');
    if (!tabsContainer) return;

    let html = '';
    FORUM_SECTIONS.forEach(sec => {
        const active = sec.id === forumCurrentSection ? 'active' : '';
        html += `<div class="forum-tab ${active}" data-tab="${sec.id}" onclick="switchForumTab('${sec.id}')">
            <span class="forum-tab-label">${sec.name}</span>
        </div>`;
    });
    tabsContainer.innerHTML = html;
}

function switchForumTab(tab) {
    forumCurrentSection = tab;
    forumSearchActive = false;
    forumSearchQuery = '';
    // update active tab
    document.querySelectorAll('.forum-tab').forEach(t => {
        t.classList.toggle('active', t.dataset.tab === tab);
    });
    // update section header
    updateForumSectionHeader();
    renderForumFeed();
    // scroll feed to top
    const feed = document.getElementById('forum-feed');
    if (feed) feed.scrollTop = 0;
}

function updateForumSectionHeader() {
    const headerInfo = document.getElementById('forum-section-header');
    if (!headerInfo) return;
    const sec = getForumSectionById(forumCurrentSection);
    if (forumCurrentSection === 'recommend' || forumCurrentSection === 'hot') {
        headerInfo.style.display = 'none';
    } else {
        headerInfo.style.display = 'flex';
        headerInfo.innerHTML = `
            <div class="forum-section-info">
                <div class="forum-section-meta">
                    <div class="forum-section-name">${sec.name}</div>
                    <div class="forum-section-desc">${sec.desc}</div>
                </div>
            </div>
            <div class="forum-section-stats">
                <span>${getForumSectionPostCount(sec.id)} 帖子</span>
            </div>`;
    }
}

function getForumSectionPostCount(sectionId) {
    return forumPosts.filter(p => p.section === sectionId).length;
}

// --- Search ---
function toggleForumSearch() {
    // Now search is always visible inline, this just focuses the input
    const input = document.getElementById('forum-search-input');
    if (input) setTimeout(() => input.focus(), 100);
}

function handleForumSearch(e) {
    // Only update query, don't auto-search (user clicks button)
}

function executeForumSearch() {
    const input = document.getElementById('forum-search-input');
    if (!input) return;
    forumSearchQuery = input.value.trim().toLowerCase();
    renderForumFeed();
}

function clearForumSearch() {
    forumSearchQuery = '';
    const input = document.getElementById('forum-search-input');
    if (input) input.value = '';
    renderForumFeed();
}

// --- List Render ---
function renderForumFeed() {
    const feed = document.getElementById('forum-feed');
    if (!feed) return;
    loadForumData();

    let displayPosts = [...forumPosts];

    // Filter by section
    if (forumCurrentSection === 'hot') {
        displayPosts.sort((a, b) => (getForumLikeCount(b) + (b.comments?.length || 0)) - (getForumLikeCount(a) + (a.comments?.length || 0)));
    } else if (forumCurrentSection !== 'recommend') {
        displayPosts = displayPosts.filter(p => p.section === forumCurrentSection);
    }

    // Filter by search
    if (forumSearchQuery) {
        displayPosts = displayPosts.filter(p => {
            const titleMatch = (p.title || '').toLowerCase().includes(forumSearchQuery);
            const textMatch = (p.text || '').toLowerCase().includes(forumSearchQuery);
            const authorMatch = (p.author || '').toLowerCase().includes(forumSearchQuery);
            const tagMatch = (p.tags || []).some(t => t.toLowerCase().includes(forumSearchQuery));
            return titleMatch || textMatch || authorMatch || tagMatch;
        });
    }

    if (displayPosts.length === 0) {
        feed.innerHTML = `
            <div class="forum-empty">
                <div class="forum-empty-text">${forumSearchQuery ? `没有找到关于 "${escapeForumHtml(forumSearchQuery)}" 的帖子` : '这里静悄悄的...'}</div>
                ${forumSearchQuery ? `
                    <div class="forum-empty-hint" style="margin-top:20px; color:#4a90e2; cursor:pointer; font-weight:500;" onclick="triggerAIForumPost('${escapeForumHtml(forumSearchQuery).replace(/'/g, "\\'")}')">
                        <svg viewBox="0 0 24 24" fill="none" class="forum-ai-icon" stroke="currentColor" stroke-width="2" style="width:16px; height:16px; margin-right:4px; vertical-align:middle; display:inline-block;">
                            <path d="M12 2l2.09 6.26L20.18 9.27l-5.09 3.89L17.09 19.5 12 15.77 6.91 19.5l2-6.34L3.82 9.27l6.09-1.01z" />
                        </svg>
                        召唤 AI 坛友来发帖讨论
                    </div>
                ` : '<div class="forum-empty-hint">点击右下角发个帖子吧</div>'}
            </div>`;
        return;
    }

    let html = '';
    displayPosts.forEach(post => {
        const avatar = getForumAvatar(post.author, post.authorAvatar);
        const timeStr = formatForumTime(post.timestamp);
        const hasLiked = hasUserLikedPost(post);
        const likeCount = getForumLikeCount(post);
        const commentCount = post.comments ? post.comments.length : 0;
        const viewCount = post.views || 0;
        const section = getForumSectionById(post.section || 'recommend');
        const isMyPost = isForumOwnedPost(post);

        // tags
        let tagsHtml = '';
        if (post.tags && post.tags.length > 0) {
            tagsHtml = `<div class="forum-card-tags">`;
            post.tags.forEach(tag => {
                tagsHtml += `<span class="forum-tag">${escapeForumHtml(tag)}</span>`;
            });
            tagsHtml += `</div>`;
        }

        // images
        let imagesHtml = '';
        if (post.images && post.images.length > 0) {
            const imgCount = post.images.length;
            const gridClass = imgCount === 1 ? 'single' : imgCount <= 3 ? 'row' : 'grid';
            imagesHtml += `<div class="forum-card-images ${gridClass}">`;
            post.images.forEach(img => {
                if (img.startsWith('txt:')) {
                    imagesHtml += `<div class="forum-txt-img">${escapeForumHtml(img.substring(4))}</div>`;
                } else {
                    imagesHtml += `<img src="${img}" class="forum-img" onclick="event.stopPropagation(); viewForumImage('${img}')">`;
                }
            });
            imagesHtml += `</div>`;
        }

        // pinned badge
        const pinnedBadge = post.pinned ? `<span class="forum-pinned-badge">置顶</span>` : '';

        // section badge (in recommend/hot views)
        const sectionBadge = (forumCurrentSection === 'recommend' || forumCurrentSection === 'hot') && post.section
            ? `<span class="forum-section-badge">${section.name}</span>` : '';

        html += `
        <div class="forum-card ${post.pinned ? 'pinned' : ''}" onclick="openForumDetail('${post.id}')">
            <div class="forum-card-header">
                <img src="${avatar}" class="forum-avatar" onerror="this.src='data:image/svg+xml;charset=utf-8,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 24 24%27 fill=%27%23d1d1d6%27%3E%3Cpath d=%27M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z%27/%3E%3C/svg%3E'">
                <div class="forum-author-info">
                    <div class="forum-author-name">
                        ${escapeForumHtml(post.author)}
                        <span class="forum-author-level">Lv${post.level || Math.floor(Math.random() * 5) + 1}</span>
                        ${sectionBadge}
                    </div>
                    <div class="forum-author-time">${timeStr}</div>
                </div>
                ${isMyPost ? `<button class="forum-more-btn" onclick="event.stopPropagation(); toggleForumPostMenu('${post.id}')">
                    <svg viewBox="0 0 24 24"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>
                </button>` : ''}
            </div>
            ${pinnedBadge}
            ${post.title ? `<div class="forum-card-title">${escapeForumHtml(post.title)}</div>` : ''}
            ${post.text ? `<div class="forum-card-text clamped">${escapeForumHtml(post.text)}</div>` : ''}
            ${tagsHtml}
            ${imagesHtml}
            <div class="forum-card-footer">
                <div class="forum-card-stats">
                    <span class="forum-stat"><svg viewBox="0 0 24 24"><path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/></svg>${viewCount}</span>
                    <span class="forum-stat"><svg viewBox="0 0 24 24"><path d="M21.99 4c0-1.1-.89-2-1.99-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h14l4 4-.01-18z"/></svg>${commentCount}</span>
                </div>
                <button class="forum-footer-btn ${hasLiked ? 'liked' : ''}" onclick="event.stopPropagation(); likeForumPost('${post.id}')">
                    <svg viewBox="0 0 24 24" fill="${hasLiked ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.5"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>
                    ${likeCount || ''}
                </button>
            </div>
        </div>`;
    });

    feed.innerHTML = html;
}

// --- Post Menu (delete) ---
function toggleForumPostMenu(postId) {
    // Simple confirm delete
    if (confirm('确定要删除这条帖子吗？')) {
        deleteForumPost(postId);
    }
}

function deleteForumPost(postId) {
    forumPosts = forumPosts.filter(p => p.id !== postId);
    saveForumData();
    renderForumFeed();
    if (typeof showToast === 'function') showToast('帖子已删除');
}

// --- Image Viewer ---
function viewForumImage(src) {
    // Reuse moments image viewer if available
    const viewer = document.getElementById('moment-image-viewer');
    const img = document.getElementById('moment-viewer-img');
    if (viewer && img) {
        img.src = src;
        viewer.classList.add('show');
    }
}

// --- Interaction ---
function likeForumPost(id) {
    const post = forumPosts.find(p => p.id === id);
    if (!post) return;
    const user = getForumUserName();
    // Normalize likes: if it's a number (from AI), convert to array for user interaction
    if (typeof post.likes === 'number') {
        const count = post.likes;
        post.likes = Array(count).fill('anonymous');
    }
    post.likes = post.likes || [];
    const idx = post.likes.indexOf(user);
    if (idx > -1) {
        post.likes.splice(idx, 1);
        post._likedByUser = false;
    } else {
        post.likes.push(user);
        post._likedByUser = true;
    }
    saveForumData();
    renderForumFeed();
    if (forumViewingPostId === id) renderForumDetailPost(id);
}

// --- Detail View ---
function openForumDetail(id) {
    forumViewingPostId = id;
    forumReplyTarget = null;
    const post = forumPosts.find(p => p.id === id);
    if (!post) return;

    // increase view
    post.views = (post.views || 0) + 1;
    saveForumData();

    renderForumDetailPost(id);
    const overlay = document.getElementById('forum-detail-overlay');
    if (overlay) {
        overlay.classList.add('show');
        overlay.style.transform = 'translateX(100%)';
        setTimeout(() => overlay.style.transform = 'translateX(0)', 10);
    }
}

function closeForumDetail() {
    const overlay = document.getElementById('forum-detail-overlay');
    if (overlay) {
        overlay.style.transform = 'translateX(100%)';
        setTimeout(() => {
            overlay.classList.remove('show');
            forumViewingPostId = null;
            forumReplyTarget = null;
        }, 300);
    }
}

function renderForumDetailPost(id) {
    const post = forumPosts.find(p => p.id === id);
    if (!post) return;

    const postContainer = document.getElementById('forum-detail-post');
    const commentsList = document.getElementById('forum-comments-list');
    const titleEl = document.getElementById('forum-comments-title');

    const avatar = getForumAvatar(post.author, post.authorAvatar);
    const timeStr = formatForumTime(post.timestamp);
    const hasLiked = hasUserLikedPost(post);
    const section = getForumSectionById(post.section || 'recommend');
    const isMyPost = isForumOwnedPost(post);

    // tags
    let tagsHtml = '';
    if (post.tags && post.tags.length > 0) {
        tagsHtml = `<div class="forum-detail-tags">`;
        post.tags.forEach(tag => {
            tagsHtml += `<span class="forum-tag">${escapeForumHtml(tag)}</span>`;
        });
        tagsHtml += `</div>`;
    }

    // images
    let imagesHtml = '';
    if (post.images && post.images.length > 0) {
        imagesHtml += `<div class="forum-detail-images">`;
        post.images.forEach(img => {
            if (img.startsWith('txt:')) {
                imagesHtml += `<div class="forum-txt-img" style="height:auto; min-height:100px;">${escapeForumHtml(img.substring(4))}</div>`;
            } else {
                imagesHtml += `<img src="${img}" class="forum-detail-img" onclick="viewForumImage('${img}')">`;
            }
        });
        imagesHtml += `</div>`;
    }

    // likes - only show count, no names
    let likesHtml = '';
    const totalLikes = getForumLikeCount(post);
    if (totalLikes > 0) {
        likesHtml = `<div class="forum-detail-likes">
            <svg viewBox="0 0 24 24" fill="#FF5A5F" width="14" height="14"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>
            <span class="forum-likes-names">${totalLikes} 人觉得很赞</span>
        </div>`;
    }

    if (postContainer) {
        postContainer.innerHTML = `
            <div class="forum-detail-header">
                <div class="forum-card-header">
                    <img src="${avatar}" class="forum-avatar" onerror="this.src='data:image/svg+xml;charset=utf-8,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 24 24%27 fill=%27%23d1d1d6%27%3E%3Cpath d=%27M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z%27/%3E%3C/svg%3E'">
                    <div class="forum-author-info">
                        <div class="forum-author-name">
                            ${escapeForumHtml(post.author)}
                            <span class="forum-author-level">Lv${post.level || Math.floor(Math.random() * 5) + 1}</span>
                        </div>
                        <div class="forum-author-time">${timeStr} · ${section.name} · 浏览 ${post.views || 0}</div>
                    </div>
                </div>
            </div>
            ${post.title ? `<div class="forum-detail-title">${escapeForumHtml(post.title)}</div>` : ''}
            <div class="forum-detail-text">${escapeForumHtml(post.text || '').replace(/\n/g, '<br>')}</div>
            ${tagsHtml}
            ${imagesHtml}
            <div class="forum-detail-actions">
                <button class="forum-action-btn ${hasLiked ? 'liked' : ''}" onclick="likeForumPost('${post.id}')">
                    <svg viewBox="0 0 24 24" fill="${hasLiked ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.5"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>
                    ${getForumLikeCount(post)} 赞
                </button>
                <button class="forum-action-btn" onclick="focusForumCommentInput()">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
                    ${post.comments ? post.comments.length : 0} 评论
                </button>
                <button class="forum-action-btn" onclick="shareForumPost('${post.id}')">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
                    分享
                </button>
                ${isMyPost ? `<button class="forum-action-btn delete" onclick="if(confirm('确定删除？')){deleteForumPost('${post.id}'); closeForumDetail();}">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                    删除
                </button>` : ''}
                <button class="forum-action-btn forum-action-ai" onclick="triggerAIForumComment()" title="AI生成评论">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 3l1.7 4.9L19 9.2l-4.2 3.2 1.6 5L12 14.4l-4.4 3 1.6-5L5 9.2l5.3-1.3z"/></svg>
                    AI
                </button>
            </div>
            ${likesHtml}
        `;
    }

    if (titleEl) {
        titleEl.textContent = `全部评论 (${post.comments ? post.comments.length : 0})`;
    }

    if (commentsList) {
        let commentsHtml = '';
        if (!post.comments || post.comments.length === 0) {
            commentsHtml = `<div class="forum-empty-comments" onclick="triggerAIForumComment()" style="cursor:pointer;">
                <div>还没有人评论，点击召唤网友讨论 💬</div>
            </div>`;
        } else {
            post.comments.forEach((c, idx) => {
                const cAvatar = getForumAvatar(c.author, c.authorAvatar);
                const cTime = formatForumTime(c.timestamp);
                const isHost = c.author === post.author;

                // reply target
                let replyHtml = '';
                if (c.replyTo) {
                    replyHtml = `<span class="forum-reply-target">回复 <span class="forum-reply-name">${escapeForumHtml(c.replyTo)}</span></span>`;
                }

                commentsHtml += `
                <div class="forum-comment-item" onclick="setForumReplyTarget(${idx}, '${encodeForumArg(c.author)}')">
                    <img src="${cAvatar}" class="forum-comment-avatar" onerror="this.src='data:image/svg+xml;charset=utf-8,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 24 24%27 fill=%27%23d1d1d6%27%3E%3Cpath d=%27M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z%27/%3E%3C/svg%3E'">
                    <div class="forum-comment-body">
                        <div class="forum-comment-header">
                            <div class="forum-comment-name">
                                ${escapeForumHtml(c.author)}
                                ${isHost ? '<span class="forum-host-badge">楼主</span>' : ''}
                            </div>
                        </div>
                        <div class="forum-comment-text">${replyHtml}${escapeForumHtml(c.text)}</div>
                        <div class="forum-comment-time">${idx + 1}楼 · ${cTime}</div>
                    </div>
                </div>`;
            });
        }
        commentsList.innerHTML = commentsHtml;
    }

    // Reset comment input placeholder
    updateForumCommentPlaceholder();
}

function setForumReplyTarget(commentIdx, authorName) {
    let decodedAuthor = authorName;
    try {
        decodedAuthor = decodeURIComponent(authorName);
    } catch (e) { }
    forumReplyTarget = { commentIdx, author: decodedAuthor };
    updateForumCommentPlaceholder();
    focusForumCommentInput();
}

function updateForumCommentPlaceholder() {
    const input = document.getElementById('forum-comment-input');
    if (!input) return;
    if (forumReplyTarget) {
        input.placeholder = `回复 ${forumReplyTarget.author}...`;
    } else {
        input.placeholder = '发条友善的评论吧...';
    }
}

function focusForumCommentInput() {
    const input = document.getElementById('forum-comment-input');
    if (input) setTimeout(() => input.focus(), 100);
}

function shareForumPost(id) {
    const post = forumPosts.find(p => p.id === id);
    if (!post) return;
    showForumChatPicker(post);
}

function showForumChatPicker(post) {
    let conversations = [];
    if (appSettings.privateChats && Array.isArray(appSettings.privateChats)) {
        appSettings.privateChats.forEach(name => {
            let avatar = '';
            const npc = typeof npcCharacters !== 'undefined' ? npcCharacters.find(n => n.name === name) : null;
            if (npc && npc.avatar) avatar = npc.avatar;
            conversations.push({ tag: `chat:${name}`, name, avatar, isGroup: false });
        });
    }
    if (appSettings.groups && Array.isArray(appSettings.groups)) {
        appSettings.groups.forEach(group => {
            conversations.push({
                tag: `group:${group.name}`,
                name: group.name,
                avatar: '',
                isGroup: true
            });
        });
    }
    if (conversations.length === 0) {
        if (typeof showToast === 'function') showToast('还没有聊天，请先创建联系人');
        return;
    }
    const placeholderAvatar = "data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='%23cccccc'%3E%3Cpath d='M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z'/%3E%3C/svg%3E";

    // Create picker overlay
    const existingPicker = document.getElementById('forum-share-picker');
    if (existingPicker) existingPicker.remove();

    const picker = document.createElement('div');
    picker.id = 'forum-share-picker';
    picker.style.cssText = 'position:absolute;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.4);z-index:2000;display:flex;align-items:flex-end;justify-content:center;';
    picker.onclick = (e) => { if (e.target === picker) picker.remove(); };
    picker.innerHTML = `
        <div style="background:#fff;border-radius:14px 14px 0 0;width:100%;max-height:65vh;display:flex;flex-direction:column;padding:18px 16px;animation:slideUpSheet 0.25s ease;">
            <div style="font-size:16px;font-weight:700;color:#1a1a1a;margin-bottom:14px;text-align:center;">分享帖子到聊天</div>
            <div style="flex:1;overflow-y:auto;margin:0 -8px;">
                ${conversations.map(c => `
                    <div onclick="confirmForumShare('${post.id}', '${encodeForumArg(c.tag)}', '${encodeForumArg(c.name)}')"
                         style="display:flex;align-items:center;gap:12px;padding:12px 8px;cursor:pointer;border-radius:12px;transition:background 0.15s;"
                         onmousedown="this.style.background='#f5f5f5'" onmouseup="this.style.background=''" onmouseleave="this.style.background=''">
                        <img src="${c.avatar || placeholderAvatar}" style="width:40px;height:40px;border-radius:50%;object-fit:cover;background:#f0f0f0;">
                        <div style="flex:1;">
                            <div style="font-size:14px;font-weight:500;color:#1a1a1a;">${escapeForumHtml(c.name)}</div>
                            <div style="font-size:11px;color:#aaa;">${c.isGroup ? '群聊' : '私聊'}</div>
                        </div>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="#ccc"><path d="M10 6l6 6-6 6" stroke="#ccc" stroke-width="2" fill="none" stroke-linecap="round"/></svg>
                    </div>
                `).join('')}
            </div>
            <button style="margin-top:12px;width:100%;padding:12px;border:none;background:#f5f5f5;border-radius:10px;font-size:14px;color:#666;cursor:pointer;" onclick="document.getElementById('forum-share-picker').remove()">取消</button>
        </div>
    `;
    // Append to the detail overlay or screen
    const parent = document.getElementById('forum-detail-overlay') || document.getElementById('forum-screen');
    if (parent) parent.appendChild(picker);
}

function confirmForumShare(postId, chatTag, chatName) {
    const post = forumPosts.find(p => p.id === postId);
    if (!post) return;

    // Remove picker
    const picker = document.getElementById('forum-share-picker');
    if (picker) picker.remove();

    const t = typeof getTime === 'function' ? getTime(true) : '12:00';
    const u = typeof getUserName === 'function' ? getUserName() : '我';

    let decodedChatTag = chatTag;
    let decodedChatName = chatName;
    try {
        decodedChatTag = decodeURIComponent(chatTag);
    } catch (e) { }
    try {
        decodedChatName = decodeURIComponent(chatName);
    } catch (e) { }

    // Build a forum share message
    const section = getForumSectionById(post.section || 'recommend');
    const title = post.title || '论坛帖子';
    const previewText = (post.text || '').substring(0, 50) + ((post.text || '').length > 50 ? '...' : '');
    const msgBody = `${title}|${section.name} 路 ${post.author}|${previewText}`;
    const msgHeader = `[${u}|FORUM|${t}]`;
    const msgData = { header: msgHeader, body: msgBody, isUser: true, type: 'forum' };

    // Save to target chat's IndexedDB history
    (async () => {
        try {
            let history = await getChatHistory(decodedChatTag) || [];
            history.push(msgData);
            await saveChatHistory(decodedChatTag, history);
        } catch (e) {
            console.error('Failed to share forum post to chat', e);
        }
    })();

    if (typeof showToast === 'function') showToast(`已分享到「${decodedChatName}」的聊天`);
}

function submitForumComment() {
    if (!forumViewingPostId) return;
    const input = document.getElementById('forum-comment-input');
    if (!input || !input.value.trim()) return;

    const post = forumPosts.find(p => p.id === forumViewingPostId);
    if (!post) return;

    post.comments = post.comments || [];
    const forumProfile = getForumProfile();
    const currentUserId = typeof getCurrentUserId === 'function' ? getCurrentUserId() : undefined;
    const isAnonymous = document.getElementById('forum-comment-anonymous')?.checked || false;
    const comment = {
        author: isAnonymous ? FORUM_ANONYMOUS_NAME : forumProfile.name,
        authorAvatar: isAnonymous ? '' : getForumUserAvatar(),
        _realAuthor: forumProfile.name,
        _realAuthorId: currentUserId,
        _anonymous: isAnonymous,
        text: input.value.trim(),
        timestamp: Date.now()
    };

    if (forumReplyTarget) {
        comment.replyTo = forumReplyTarget.author;
    }

    post.comments.push(comment);

    saveForumData();
    input.value = '';
    forumReplyTarget = null;
    renderForumDetailPost(forumViewingPostId);
    renderForumFeed();
}

// --- Compose ---
function openForumCompose() {
    forumComposeImages = [];
    renderForumComposeImages();
    const overlay = document.getElementById('forum-compose-overlay');
    if (overlay) overlay.classList.add('show');
    document.getElementById('forum-compose-title').value = '';
    document.getElementById('forum-compose-text').value = '';

    // Render section picker
    renderForumComposeSectionPicker();
    // Render tag picker
    renderForumComposeTagPicker();
    // Reset anonymous toggle
    const anonCb = document.getElementById('forum-compose-anonymous');
    if (anonCb) anonCb.checked = false;
}

function closeForumCompose() {
    const overlay = document.getElementById('forum-compose-overlay');
    if (overlay) overlay.classList.remove('show');
}

function renderForumComposeSectionPicker() {
    const container = document.getElementById('forum-compose-section');
    if (!container) return;

    // Default to current section or recommend
    let defaultSection = forumCurrentSection;
    if (defaultSection === 'recommend' || defaultSection === 'hot') {
        defaultSection = 'cosplay'; // fallback to first real section
    }

    let html = '';
    FORUM_SECTIONS.filter(s => s.id !== 'recommend' && s.id !== 'hot').forEach(sec => {
        const selected = sec.id === defaultSection ? 'selected' : '';
        html += `<div class="forum-compose-section-item ${selected}" data-section="${sec.id}" onclick="selectForumComposeSection('${sec.id}')">
            <span>${sec.name}</span>
        </div>`;
    });
    container.innerHTML = html;
}

function selectForumComposeSection(sectionId) {
    document.querySelectorAll('.forum-compose-section-item').forEach(el => {
        el.classList.toggle('selected', el.dataset.section === sectionId);
    });
    // Update tags for this section
    renderForumComposeTagPicker();
}

function getSelectedComposeSection() {
    const selected = document.querySelector('.forum-compose-section-item.selected');
    return selected ? selected.dataset.section : 'cosplay';
}

function renderForumComposeTagPicker() {
    const container = document.getElementById('forum-compose-tags');
    if (!container) return;
    const section = getSelectedComposeSection();
    const tags = FORUM_TAGS[section] || [];

    let html = '';
    tags.forEach(tag => {
        html += `<span class="forum-compose-tag" data-tag="${tag}" onclick="this.classList.toggle('selected')">${tag}</span>`;
    });
    container.innerHTML = html;
}

function getSelectedComposeTags() {
    const selected = document.querySelectorAll('.forum-compose-tag.selected');
    return Array.from(selected).map(el => el.dataset.tag);
}



function triggerForumImageUpload() {
    const input = document.getElementById('forum-image-input');
    if (input) input.click();
}

function handleForumImageSelect(e) {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    const remaining = 9 - forumComposeImages.length;
    for (let i = 0; i < Math.min(files.length, remaining); i++) {
        const file = files[i];
        if (!file.type.startsWith('image/')) continue;
        const reader = new FileReader();
        reader.onload = ev => {
            forumComposeImages.push(ev.target.result);
            renderForumComposeImages();
        };
        reader.readAsDataURL(file);
    }
}

function renderForumComposeImages() {
    const grid = document.getElementById('forum-compose-images');
    if (!grid) return;
    let html = '';
    forumComposeImages.forEach((img, i) => {
        html += `<div class="forum-compose-img-item">
            <img src="${img}">
            <div class="forum-compose-img-remove" onclick="forumComposeImages.splice(${i},1); renderForumComposeImages()">×</div>
        </div>`;
    });
    if (forumComposeImages.length < 9) {
        html += `<div class="forum-compose-img-add" onclick="triggerForumImageUpload()">
            <svg viewBox="0 0 24 24" fill="none" stroke="#ccc" stroke-width="2"><path d="M12 5v14M5 12h14"></path></svg>
        </div>`;
    }
    grid.innerHTML = html;
}

function publishForumPost() {
    const title = document.getElementById('forum-compose-title').value.trim();
    const text = document.getElementById('forum-compose-text').value.trim();
    const section = getSelectedComposeSection();
    const tags = getSelectedComposeTags();
    const isAnonymous = document.getElementById('forum-compose-anonymous')?.checked || false;

    if (!title && !text && forumComposeImages.length === 0) {
        if (typeof showToast === 'function') showToast('不能发布空白帖子');
        return;
    }

    const forumProfile = getForumProfile();
    const realName = forumProfile.name;
    const currentUserId = typeof getCurrentUserId === 'function' ? getCurrentUserId() : undefined;
    const post = {
        id: `forum_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
        author: isAnonymous ? FORUM_ANONYMOUS_NAME : realName,
        authorAvatar: isAnonymous ? '' : getForumUserAvatar(),
        _realAuthor: realName,
        _realAuthorId: currentUserId,
        _anonymous: isAnonymous,
        title: title || '',
        text: text,
        images: [...forumComposeImages],
        likes: [],
        comments: [],
        views: 0,
        section: section,
        tags: tags,
        level: Math.floor(Math.random() * 5) + 1,
        timestamp: Date.now()
    };

    forumPosts.unshift(post);
    saveForumData();
    closeForumCompose();
    renderForumFeed();
    if (typeof showToast === 'function') showToast('发布成功');
}

// --- AI Generative Logic ---
let _forumAIGenerating = false;

async function triggerAIForumPost(searchQuery = null) {
    if (_forumAIGenerating) return;
    if (!appSettings.apiKey || !appSettings.apiEndpoint) {
        if (typeof showToast === 'function') showToast('请先配置API');
        return;
    }

    const npcNames = Array.isArray(npcCharacters) ? npcCharacters.map(n => n.name) : [];
    if (npcNames.length === 0) {
        if (typeof showToast === 'function') showToast('请先创建NPC角色');
        return;
    }

    _forumAIGenerating = true;
    const aiBtn = document.querySelector('.forum-header-icon-btn[onclick*="triggerAIForumPost"]');
    if (aiBtn) aiBtn.classList.add('forum-ai-loading');

    if (searchQuery && typeof showToast === 'function') {
        showToast(`正在生成与「${searchQuery}」相关的帖子...`);
    }

    const count = Math.floor(Math.random() * 3) + 2;
    const isSpecificSection = forumCurrentSection !== 'recommend' && forumCurrentSection !== 'hot';
    const sectionIds = FORUM_SECTIONS.filter(s => s.id !== 'recommend' && s.id !== 'hot').map(s => s.id);
    let generated = 0;

    for (let i = 0; i < count; i++) {
        const npcName = npcNames[Math.floor(Math.random() * npcNames.length)];
        const npc = npcCharacters.find(n => n.name === npcName);
        if (!npc) continue;

        const targetSection = isSpecificSection
            ? forumCurrentSection
            : sectionIds[Math.floor(Math.random() * sectionIds.length)];
        const sec = getForumSectionById(targetSection);
        const availableTags = FORUM_TAGS[targetSection] || [];
        const searchContext = searchQuery ? `\n用户搜索关键词：${searchQuery}，请生成与该关键词高度相关的帖子。` : '';

        try {
            const prompt = `你是${npc.name}，正在“星海社区”发帖，也可以扮演普通女性路人网友。\n角色设定：${npc.persona || npc.desc || ''}${searchContext}\n\n发帖版块：${sec.name}（${sec.desc}）\n可用标签：${availableTags.join('、')}\n\n请输出一个JSON对象，包含 title,text,tags,author 四个字段。\n要求：\n1) 帖子风格贴近日常论坛，真实口语，不要空话。\n2) 严禁涉及BL/R18等话题。\n3) tags 仅从可用标签中选择1-2个。\n4) 如需配图，在text中写 [图片:画面描述]。\n5) 只输出JSON本体，不要markdown。`;

            const res = await callLLM([{ role: 'user', content: prompt }]);
            let jsonText = '';
            let streamBuffer = '';
            const reader = res.getReader();
            const dec = new TextDecoder();
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                const chunk = dec.decode(value, { stream: true });
                streamBuffer += chunk;
                const lines = streamBuffer.split('\n');
                streamBuffer = lines.pop();
                for (const line of lines) {
                    if (!line.startsWith('data: ')) continue;
                    const d = line.slice(6).trim();
                    if (d === '[DONE]') break;
                    try {
                        const p = JSON.parse(d);
                        if (p.choices?.[0]?.delta?.content) jsonText += p.choices[0].delta.content;
                    } catch (e) { }
                }
            }

            jsonText = jsonText.replace(/^\s*\`\`\`(json)?/m, '').replace(/\`\`\`\s*$/m, '').trim();
            const data = JSON.parse(jsonText);

            let finalText = data.text || '';
            const extImgs = [];
            const imgRegex = /\[图片[:：](.*?)\]/g;
            let match;
            while ((match = imgRegex.exec(finalText)) !== null) {
                extImgs.push('txt:' + match[1].trim());
            }
            finalText = finalText.replace(imgRegex, '').trim();

            const fakeCommentCount = Math.floor(Math.random() * 3) + 1;
            const fakeComments = [];
            const commentPhrases = [
                '我之前也遇到过类似的情况，当时纠结了好久',
                '这个话题最近好多人在讨论诶，终于看到有人发帖了',
                '姐妹你说到我心坎里了，我一直想说但不知道怎么表达',
                '啊啊啊我正好在纠结这个问题！坐等大家的看法',
                '看了楼主的分享感触挺深的，想起我自己的经历',
                '这种事真的要看具体情况吧，不过楼主说的有道理',
                '我来说下我的经验，之前踩过坑所以有点了解',
                '蹲一个后续！楼主到时候记得来更新啊',
                '我就说嘛！我身边也有人是这样的，还以为就我这样想',
                '天呐这也太巧了，我昨天还在跟朋友聊这个话题',
                '楼主思路好清晰，比我之前看到的帖子讲得明白多了',
                '笑死 我第一反应也是这样的 看来大家都差不多哈哈'
            ];
            const randomNicks = [
                '小红薯' + Math.floor(Math.random() * 9999), '吃瓜群众', '小太阳花',
                '月亮妹妹', '快乐星球居民', '今日也要加油', '奶茶续命少女',
                '咸鱼本鱼', '熬夜冠军', '社恐选手'
            ];
            for (let ci = 0; ci < fakeCommentCount; ci++) {
                const cAuthor = Math.random() > 0.5
                    ? npcNames[Math.floor(Math.random() * npcNames.length)]
                    : randomNicks[Math.floor(Math.random() * randomNicks.length)];
                fakeComments.push({
                    author: cAuthor,
                    text: commentPhrases[Math.floor(Math.random() * commentPhrases.length)],
                    timestamp: Date.now() - Math.floor(Math.random() * 1800000)
                });
            }


            forumPosts.unshift({
                id: `forum_ai_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
                author: data.author || npc.name,
                title: data.title || '无标题',
                text: finalText,
                images: extImgs,
                likes: Math.floor(Math.random() * 10),
                comments: fakeComments,
                views: Math.floor(Math.random() * 500) + 10,
                section: targetSection,
                tags: Array.isArray(data.tags) ? data.tags : [],
                level: Math.floor(Math.random() * 5) + 1,
                timestamp: Date.now() - Math.floor(Math.random() * 3600000)
            });

            generated++;
            saveForumData();
            renderForumFeed();
        } catch (e) {
            console.error('AI Forum Gen Error:', e);
        }
    }

    _forumAIGenerating = false;
    if (aiBtn) aiBtn.classList.remove('forum-ai-loading');

    if (typeof showToast === 'function') {
        if (generated > 0) showToast(`已生成 ${generated} 条帖子`);
        else showToast('生成失败，请重试');
    }
}

async function triggerAIForumComment() {
    if (_forumAIGenerating) return;
    if (!forumViewingPostId) return;
    if (!appSettings.apiKey || !appSettings.apiEndpoint) {
        if (typeof showToast === 'function') showToast('请先配置API');
        return;
    }
    const post = forumPosts.find(p => p.id === forumViewingPostId);
    if (!post) return;

    const npcNames = Array.isArray(npcCharacters) ? npcCharacters.map(n => n.name) : [];
    if (npcNames.length === 0) {
        if (typeof showToast === 'function') showToast('请先创建NPC角色');
        return;
    }

    _forumAIGenerating = true;
    if (typeof showToast === 'function') showToast('正在召唤坛友讨论...');

    const commenterName = npcNames[Math.floor(Math.random() * npcNames.length)];
    const commenter = npcCharacters.find(n => n.name === commenterName);
    if (!commenter) { _forumAIGenerating = false; return; }

    let extraContext = '';
    if (post._anonymous) {
        extraContext = '\n注意：这是一条匿名帖子，发帖人显示为"匿名用户"，你不知道真实身份。';
    }

    post.comments = post.comments || [];
    const allComments = post.comments;
    const currentUserId = typeof getCurrentUserId === 'function' ? getCurrentUserId() : undefined;
    const currentForumName = getForumUserName();
    const legacyUserName = getBaseForumUserName();

    // Build full conversation thread with user comments clearly marked
    const recentComments = allComments.slice(-20);
    const recentThreadText = recentComments.map((c, i) => {
        const floor = allComments.length - recentComments.length + i + 1;
        const replyPart = c.replyTo ? ` 回复@${c.replyTo}` : '';
        // Mark user's own comments for AI to recognize
        let isUserComment = false;
        if (currentUserId !== undefined && c._realAuthorId !== undefined) {
            isUserComment = String(c._realAuthorId) === String(currentUserId);
        }
        if (!isUserComment) {
            const author = c.author || '';
            const real = c._realAuthor || '';
            isUserComment = author === currentForumName
                || author === legacyUserName
                || real === currentForumName
                || real === legacyUserName;
        }
        const userMark = isUserComment ? ' [用户]' : '';
        return `${floor}楼 ${c.author}${userMark}${replyPart}: ${c.text}`;
    }).join('\n');

    // Collect ALL user comments for emphasis
    const userComments = allComments.filter(c => {
        if (!c) return false;
        if (currentUserId !== undefined && c._realAuthorId !== undefined) {
            if (String(c._realAuthorId) === String(currentUserId)) return true;
        }
        const author = c.author || '';
        const real = c._realAuthor || '';
        return author === currentForumName
            || author === legacyUserName
            || real === currentForumName
            || real === legacyUserName;
    });

    const latestUserComment = userComments.length > 0 ? userComments[userComments.length - 1] : null;

    // Build user comment history summary
    let userCommentSummary = '';
    if (userComments.length > 0) {
        userCommentSummary = '\n\n===== 用户在本帖的所有发言（必须认真阅读并回应）=====\n';
        userComments.forEach((uc, i) => {
            const replyPart = uc.replyTo ? `（回复@${uc.replyTo}）` : '';
            userCommentSummary += `  ${i + 1}. ${uc.author}${replyPart}：${uc.text}\n`;
        });
    }

    let focusContext = '';
    if (latestUserComment) {
        const latestReplyPart = latestUserComment.replyTo ? `（回复@${latestUserComment.replyTo}）` : '';
        focusContext += `\n\n>>> 重点：用户最新发言："${latestUserComment.text}"${latestReplyPart}`;
        focusContext += `\n你的回复必须围绕用户这条最新发言展开，直接回应其观点、提问或情绪。`;
    }
    if (forumReplyTarget) {
        focusContext += `\n用户正在回复的对象：${forumReplyTarget.author}`;
    }

    // Determine conversation mode
    const hasUserContext = userComments.length > 0;

    try {
        const prompt = `你现在正在模拟一个真实论坛的评论区。你需要扮演多个不同的网友来回复。

你的主要角色参考：${commenter.name}（${commenter.persona || commenter.desc || '普通网友'}）
你也可以同时扮演其他路人网友。${extraContext}

【帖子信息】
标题："${post.title || ''}"
正文："${(post.text || '').substring(0, 300)}"

【当前评论区完整对话】（按时间顺序）：
${recentThreadText || '（暂无评论）'}
${userCommentSummary}${focusContext}

【核心要求】
${hasUserContext ? `1. 最重要：你必须认真阅读用户的发言内容，然后针对用户说的话进行有实质内容的回应。
2. 不要无视用户的评论而只讨论主帖内容，用户的每一条评论都是对话的一部分。
3. 回复要像真人在跟用户聊天一样，有来有回，接着用户的话题往下聊。
4. 如果用户在发表观点，你要表达自己的看法（可以赞同、补充、或礼貌反驳）。
5. 如果用户在提问，你要尝试回答或分享经验。
6. 如果用户在分享经历，你要共情或分享类似经历。` : `1. 基于帖子内容展开自然讨论。
2. 评论要有实质内容，围绕帖子话题发表自己的看法、经历或提问。`}

【风格要求】
- 像真人发帖一样，口语化、随意，可以用语气词（哈哈、呜呜、emmm、救命、绝了）。
- 可以适度用emoji但不要太多。
- 可以有口癖让语言更自然。
- 每条评论1-3句话，不要太长也不要太短。
- 严禁空洞刷楼式评论如"同感+1""已收藏""mark"，每条评论必须有具体内容。
- 不同网友应该有不同的语言风格和立场。
- 严禁使用"xdm""兄弟们""哥们""老哥"等男性化称呼，用"姐妹""宝""朋友们"等。
- 严禁任何BL相关话题。

【输出格式】
严格输出JSON数组，2-4条评论。每条包含 author（网名）和 text（内容），可选 replyTo（回复对象昵称）。
${hasUserContext ? '至少有1条必须用 replyTo 指向用户的昵称来直接回复用户。' : ''}
不要输出反引号或markdown，只输出JSON数组：[{"author":"xxx","text":"xxx","replyTo":"xxx"}]`;

        const res = await callLLM([{ role: 'user', content: prompt }]);
        let rep = '';
        let streamBuffer = '';
        const reader = res.getReader();
        const dec = new TextDecoder();
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = dec.decode(value, { stream: true });
            streamBuffer += chunk;
            const lines = streamBuffer.split('\n');
            streamBuffer = lines.pop();
            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    const d = line.slice(6).trim();
                    if (d === '[DONE]') break;
                    try {
                        const p = JSON.parse(d);
                        if (p.choices?.[0]?.delta?.content) rep += p.choices[0].delta.content;
                    } catch (e) { }
                }
            }
        }

        rep = rep.replace(/^\s*\`\`\`(json)?/m, '').replace(/\`\`\`\s*$/m, '').trim();

        if (rep) {
            try {
                let parsed = JSON.parse(rep);
                if (!Array.isArray(parsed)) parsed = [parsed];
                for (const commentData of parsed) {
                    if (commentData.text) {
                        const newComment = {
                            author: commentData.author || commenter.name,
                            text: commentData.text,
                            timestamp: Date.now() - Math.floor(Math.random() * 60000)
                        };
                        if (commentData.replyTo && typeof commentData.replyTo === 'string') {
                            newComment.replyTo = commentData.replyTo.trim();
                        }
                        post.comments.push(newComment);
                    }
                }
            } catch (e) {
                post.comments.push({
                    author: commenter.name,
                    text: rep.substring(0, 100),
                    timestamp: Date.now()
                });
            }
        }

        saveForumData();
        renderForumDetailPost(forumViewingPostId);
        renderForumFeed();

    } catch (e) {
        console.error('AI comment gen error', e);
    } finally {
        _forumAIGenerating = false;
    }
}


// --- Helper: normalize likes to number ---
function getForumLikeCount(post) {
    if (typeof post.likes === 'number') return post.likes;
    if (Array.isArray(post.likes)) return post.likes.length;
    return 0;
}

function hasUserLikedPost(post) {
    const user = getForumUserName();
    if (Array.isArray(post.likes)) return post.likes.includes(user);
    if (post._likedByUser) return true;
    return false;
}

function openForumProfile() {
    const overlay = document.getElementById('forum-profile-overlay');
    if (!overlay) return;
    const myPosts = forumPosts.filter(p => isForumOwnedPost(p));
    const totalLikes = myPosts.reduce((sum, p) => sum + getForumLikeCount(p), 0);
    const totalComments = myPosts.reduce((sum, p) => sum + (p.comments ? p.comments.length : 0), 0);

    // Get independent forum profile data
    const forumProfile = getForumProfile();

    let avatarSrc = forumProfile.avatar;
    if (!avatarSrc) avatarSrc = getForumUserAvatar();
    const displayName = forumProfile.name;

    let postsHtml = '';
    if (myPosts.length === 0) {
        postsHtml = '<div style="text-align:center;padding:40px 20px;color:#bbb;font-size:13px;">还没有发过帖子哦~</div>';
    } else {
        myPosts.forEach(post => {
            const section = getForumSectionById(post.section || 'recommend');
            const timeStr = formatForumTime(post.timestamp);
            postsHtml += `
                <div class="forum-profile-post" onclick="closeForumProfile();openForumDetail('${post.id}')">
                <div class="forum-profile-post-title">${escapeForumHtml(post.title || '无标题')}</div>
                <div class="forum-profile-post-meta">${section.name} · ${timeStr} · ${getForumLikeCount(post)}赞 · ${(post.comments || []).length}评论</div>
                <div class="forum-profile-post-text">${escapeForumHtml((post.text || '').substring(0, 60))}${(post.text || '').length > 60 ? '...' : ''}</div>
            </div> `;
        });
    }

    overlay.innerHTML = `
                <div class="forum-profile-header">
            <button class="forum-back-btn" onclick="closeForumProfile()">
                <svg viewBox="0 0 24 24"><path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z"></path></svg>
            </button>
            <div style="font-size:16px;font-weight:600;color:#1d1d1f;">我的主页</div>
            <div style="width:32px;"></div>
        </div >
        <div class="forum-profile-info">
            <img src="${avatarSrc}" class="forum-profile-avatar" onclick="openForumAvatarOptions()" title="更换头像" onerror="this.src='data:image/svg+xml;charset=utf-8,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 24 24%27 fill=%27%23d1d1d6%27%3E%3Cpath d=%27M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z%27/%3E%3C/svg%3E'" style="cursor: pointer;">
            <div class="forum-profile-name" onclick="editForumProfileName()" style="cursor: pointer;" title="修改名称">${escapeForumHtml(displayName)} <svg viewBox="0 0 24 24" width="12" height="12" style="display:inline-block; vertical-align:middle; fill:#999;"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg></div>
            <div class="forum-profile-stats">
                <span>${myPosts.length} 帖子</span>
                <span>${totalLikes} 获赞</span>
                <span>${totalComments} 评论</span>
            </div>
        </div>
        <div class="forum-profile-section-title">我的帖子</div>
        <div class="forum-profile-posts">${postsHtml}</div>
            `;
    overlay.classList.add('show');
    overlay.style.transform = 'translateX(100%)';
    setTimeout(() => overlay.style.transform = 'translateX(0)', 10);
}

function closeForumProfile() {
    const overlay = document.getElementById('forum-profile-overlay');
    if (overlay) {
        overlay.style.transform = 'translateX(100%)';
        setTimeout(() => {
            overlay.classList.remove('show');
        }, 300);
    }
}

function openForumAvatarOptions() {
    const picker = document.createElement('div');
    picker.id = 'forum-avatar-upload-picker';
    picker.style.cssText = 'position:absolute;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.4);z-index:99999;display:flex;align-items:flex-end;justify-content:center;';
    picker.onclick = (e) => { if (e.target === picker) picker.remove(); };
    picker.innerHTML = `
        <div style="background:#fff;border-radius:14px 14px 0 0;width:100%;max-height:65vh;display:flex;flex-direction:column;padding:18px 16px;animation:slideUpSheet 0.25s ease;">
            <div style="font-size:16px;font-weight:700;color:#1a1a1a;margin-bottom:14px;text-align:center;">更换头像</div>
            <button style="margin-top:12px;width:100%;padding:12px;border:none;background:#f5f5f5;border-radius:10px;font-size:14px;color:#666;cursor:pointer;" onclick="forumAvatarLocalUpload()">本地上传</button>
            <button style="margin-top:12px;width:100%;padding:12px;border:none;background:#f5f5f5;border-radius:10px;font-size:14px;color:#666;cursor:pointer;" onclick="forumAvatarUrlUpload()">URL上传</button>
            <button style="margin-top:12px;width:100%;padding:12px;border:none;background:#f5f5f5;border-radius:10px;font-size:14px;color:#666;cursor:pointer;" onclick="document.getElementById('forum-avatar-upload-picker').remove()">取消</button>
        </div>
    `;
    const overlay = document.getElementById('forum-profile-overlay');
    if (overlay) overlay.appendChild(picker);
}

function forumAvatarLocalUpload() {
    const picker = document.getElementById('forum-avatar-upload-picker');
    if (picker) picker.remove();
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (ev) => {
            saveForumProfile({ avatar: ev.target.result });
        };
        reader.readAsDataURL(file);
    };
    input.click();
}

function forumAvatarUrlUpload() {
    const picker = document.getElementById('forum-avatar-upload-picker');
    if (picker) picker.remove();
    if (typeof openUrlUploadModal === 'function') {
        openUrlUploadModal('forum-avatar');
    }
}

function editForumProfileName() {
    const forumProfile = getForumProfile();

    const newName = prompt("请输入新的论坛昵称", forumProfile.name);
    if (newName && newName.trim() !== "") {
        saveForumProfile({ name: newName.trim() });
    }
}

function saveForumProfile(updates) {
    let forumProfile = getForumProfile();

    forumProfile = { ...forumProfile, ...updates };
    localStorage.setItem(FORUM_PROFILE_KEY, JSON.stringify(forumProfile));

    // Refresh the profile page if it's open
    const overlay = document.getElementById('forum-profile-overlay');
    if (overlay && overlay.classList.contains('show')) {
        openForumProfile();
    }
}

// --- Export to window ---
window.openForumApp = openForumApp;
window.closeForumApp = closeForumApp;
window.switchForumTab = switchForumTab;
window.toggleForumSearch = toggleForumSearch;
window.handleForumSearch = handleForumSearch;
window.executeForumSearch = executeForumSearch;
window.clearForumSearch = clearForumSearch;
window.openForumDetail = openForumDetail;
window.closeForumDetail = closeForumDetail;
window.likeForumPost = likeForumPost;
window.deleteForumPost = deleteForumPost;
window.shareForumPost = shareForumPost;
window.showForumChatPicker = showForumChatPicker;
window.confirmForumShare = confirmForumShare;
window.submitForumComment = submitForumComment;
window.focusForumCommentInput = focusForumCommentInput;
window.openForumCompose = openForumCompose;
window.closeForumCompose = closeForumCompose;
window.publishForumPost = publishForumPost;
window.triggerAIForumPost = triggerAIForumPost;
window.triggerAIForumComment = triggerAIForumComment;
window.viewForumImage = viewForumImage;
window.handleForumImageSelect = handleForumImageSelect;
window.setForumReplyTarget = setForumReplyTarget;
window.openForumProfile = openForumProfile;
window.closeForumProfile = closeForumProfile;
window.openForumAvatarOptions = openForumAvatarOptions;
window.forumAvatarLocalUpload = forumAvatarLocalUpload;
window.forumAvatarUrlUpload = forumAvatarUrlUpload;
window.editForumProfileName = editForumProfileName;
window.saveForumProfile = saveForumProfile;
window.toggleForumPostMenu = toggleForumPostMenu;
window.selectForumComposeSection = selectForumComposeSection;
window.triggerForumImageUpload = triggerForumImageUpload;
window.renderForumComposeImages = renderForumComposeImages;



// ===== Toy Control (Intiface Central / buttplug.js) =====

let _toyClient = null;
let _toyDevices = [];
let _toyConnected = false;
let _toyPatternTimer = null; // For pattern mode cycling

// ===== Connection Management =====

async function toyConnect() {
    const wsUrl = appSettings.toyWsUrl || 'ws://127.0.0.1:12345';
    const statusEl = document.getElementById('toy-connection-status');
    const btnEl = document.getElementById('toy-connect-btn');

    if (_toyConnected) {
        await toyDisconnect();
        return;
    }

    try {
        if (statusEl) statusEl.textContent = '连接中...';
        if (statusEl) statusEl.style.color = '#e8a33a';
        if (btnEl) btnEl.textContent = '连接中...';
        if (btnEl) btnEl.disabled = true;

        // Wait for buttplug library to be loaded
        if (typeof buttplug === 'undefined') {
            showToast('❌ buttplug.js 未加载，请检查网络');
            if (statusEl) statusEl.textContent = '库未加载';
            if (statusEl) statusEl.style.color = '#e53935';
            if (btnEl) btnEl.textContent = '连接';
            if (btnEl) btnEl.disabled = false;
            return;
        }

        _toyClient = new buttplug.ButtplugClient('FayePhone Toy Control');

        // Device added event
        _toyClient.addListener('deviceadded', (device) => {
            console.log('[Toy] Device added:', device.name);
            if (!_toyDevices.find(d => d.index === device.index)) {
                _toyDevices.push(device);
            }
            renderToyDeviceList();
        });

        // Device removed event
        _toyClient.addListener('deviceremoved', (device) => {
            console.log('[Toy] Device removed:', device.name);
            _toyDevices = _toyDevices.filter(d => d.index !== device.index);
            renderToyDeviceList();
        });

        // Disconnect event
        _toyClient.addListener('disconnect', () => {
            console.log('[Toy] Disconnected');
            _toyConnected = false;
            _toyDevices = [];
            toyStopAll();
            updateToyConnectionUI();
            renderToyDeviceList();
        });

        // Connect via WebSocket
        const connector = new buttplug.ButtplugBrowserWebsocketClientConnector(wsUrl);
        await _toyClient.connect(connector);

        _toyConnected = true;
        console.log('[Toy] Connected to Intiface Central');
        showToast('✅ 已连接 Intiface Central');
        updateToyConnectionUI();

        // Auto scan for devices
        await _toyClient.startScanning();
        showToast('🔍 正在扫描设备...');

        // Stop scanning after 10 seconds
        setTimeout(async () => {
            try {
                if (_toyClient && _toyConnected) {
                    await _toyClient.stopScanning();
                }
            } catch (e) { /* ignore */ }
        }, 10000);

    } catch (e) {
        console.error('[Toy] Connection failed:', e);
        showToast('❌ 连接失败: ' + e.message);
        _toyConnected = false;
        _toyClient = null;
        updateToyConnectionUI();
    }
}


// ===== 标准自适应震动与多功能控制函数 =====
async function omniVibrate(device, intensity) {
    if (!device) return;
    try {
        // 安全限制 intensity
        const safeIntensity = Math.min(1.0, Math.max(0.0, typeof intensity === 'number' ? intensity : parseFloat(intensity) || 0));

        let commandSent = false;
        let errors = [];

        // 策略 1: 标准 Buttplug v3 接口
        // 尝试发送到所有受支持的输出机制，这样不论是普通跳蛋、旋转器还是伸缩炮，都可以收到不同形式强度的指令。

        if (device.vibrateAttributes && device.vibrateAttributes.length > 0) {
            try {
                if (typeof device.vibrate === 'function') {
                    await device.vibrate(safeIntensity);
                    commandSent = true;
                } else if (typeof device.Vibrate === 'function') {
                    await device.Vibrate(safeIntensity);
                    commandSent = true;
                }
            } catch (e) { errors.push("vibrate:" + e.message); }
        }

        if (device.rotateAttributes && device.rotateAttributes.length > 0) {
            try {
                if (typeof device.rotate === 'function') {
                    // 默认半数正转，半数反转，或者同一强度的顺时针旋转
                    await device.rotate(safeIntensity, true);
                    commandSent = true;
                }
            } catch (e) { errors.push("rotate:" + e.message); }
        }

        if (device.linearAttributes && device.linearAttributes.length > 0) {
            try {
                if (typeof device.linear === 'function') {
                    // 伸缩炮等线性设备，设置位移时长与位置
                    await device.linear(500, safeIntensity);
                    commandSent = true;
                }
            } catch (e) { errors.push("linear:" + e.message); }
        }

        if (device.oscillateAttributes && device.oscillateAttributes.length > 0) {
            try {
                if (typeof device.oscillate === 'function') {
                    await device.oscillate(safeIntensity);
                    commandSent = true;
                }
            } catch (e) { errors.push("oscillate:" + e.message); }
        }

        if (commandSent) return;

        // 策略 2: 新版 Buttplug v4 协议接口 (Intiface v3.0+)
        if (typeof device.runOutput === 'function') {
            try {
                const B = typeof window !== 'undefined' ? (window.Buttplug || window.buttplug) : null;
                let v4CommandSent = false;
                if (B && B.DeviceOutput) {
                    const types = ["Vibrate", "Rotate", "Oscillate"];
                    for (const type of types) {
                        if (B.DeviceOutput[type]) {
                            try {
                                await device.runOutput(B.DeviceOutput[type].percent(safeIntensity));
                                v4CommandSent = true;
                            } catch (e) { }
                        }
                    }
                }
                if (v4CommandSent) return;
            } catch (v4err) {
                console.warn("[Toy] V4 DeviceOutput build failed", v4err);
            }

            // 手动伪造 V4 需要的 Command 对象
            const potentialOutputs = ["Vibrate", "Rotate", "Oscillate"];
            for (const type of potentialOutputs) {
                try {
                    await device.runOutput({
                        outputType: type,
                        value: { percent: safeIntensity, steps: undefined }
                    });
                    commandSent = true;
                } catch (mockErr) { }
            }
            if (commandSent) return;
        }

        // 策略 3: 降级处理为旧版 Buttplug v2 对象传入方式
        if (device.vibrateAttributes && device.vibrateAttributes.length > 0) {
            const speeds = device.vibrateAttributes.map((attr, index) => ({
                Index: index,
                Speed: safeIntensity
            }));
            if (typeof device.sendVibrateCmd === 'function') {
                await device.sendVibrateCmd(speeds);
                return;
            }
        }

        // --- 容错排查：获取设备上的属性，显示在报错中 ---
        let props = [];
        let obj = device;
        while (obj) {
            props = props.concat(Object.getOwnPropertyNames(obj));
            obj = Object.getPrototypeOf(obj);
        }
        const methods = [...new Set(props)].filter(p => typeof device[p] === 'function');
        const deviceProps = {
            name: device.name,
            index: device.index,
            messageAttributes: device.messageAttributes,
            features: device.features ? true : false
        };
        const attrs = JSON.stringify(deviceProps, null, 2);

        throw new Error(`设备不支持标准输出(vibrate/rotate/linear等)。V4协议也未兼容.\n错误信息: ${errors.join(', ')}\n\n设备属性: ${attrs}\n可用方法: ${methods.join(', ')}`);
    } catch (e) {
        console.error('[OmniVibrate Failed]', e);
        throw e;
    }
}

async function toyDisconnect() {
    toyStopAll();
    try {
        if (_toyClient) {
            await _toyClient.disconnect();
        }
    } catch (e) {
        console.error('[Toy] Disconnect error:', e);
    }
    _toyClient = null;
    _toyDevices = [];
    _toyConnected = false;
    updateToyConnectionUI();
    renderToyDeviceList();
    showToast('已断开玩具连接');
}

async function toyScanDevices() {
    if (!_toyClient || !_toyConnected) {
        showToast('请先连接 Intiface Central');
        return;
    }
    try {
        await _toyClient.startScanning();
        showToast('🔍 正在扫描设备...');
        setTimeout(async () => {
            try {
                if (_toyClient && _toyConnected) {
                    await _toyClient.stopScanning();
                }
            } catch (e) { /* ignore */ }
        }, 10000);
    } catch (e) {
        console.error('[Toy] Scan error:', e);
        showToast('扫描失败: ' + e.message);
    }
}

// ===== UI Updates =====

function updateToyConnectionUI() {
    const statusEl = document.getElementById('toy-connection-status');
    const btnEl = document.getElementById('toy-connect-btn');

    if (_toyConnected) {
        if (statusEl) {
            statusEl.textContent = '已连接';
            statusEl.style.color = '#4caf50';
        }
        if (btnEl) {
            btnEl.textContent = '断开连接';
            btnEl.disabled = false;
            btnEl.style.background = '#c9c4c4';
        }
    } else {
        if (statusEl) {
            statusEl.textContent = '未连接';
            statusEl.style.color = '#999';
        }
        if (btnEl) {
            btnEl.textContent = '连接';
            btnEl.disabled = false;
            btnEl.style.background = '#e5e5ea';
            btnEl.style.color = '#333';
        }
    }
}

function renderToyDeviceList() {
    const container = document.getElementById('toy-device-list');
    if (!container) return;
    container.innerHTML = '';

    if (_toyDevices.length === 0) {
        container.innerHTML = '<div style="text-align:center; color:#bbb; font-size:13px; padding:20px 0;">暂无设备 · 请确保 Intiface Central 已连接玩具</div>';
        return;
    }

    _toyDevices.forEach((device, idx) => {
        const card = document.createElement('div');
        card.style.cssText = 'display:flex; align-items:center; gap:12px; padding:12px 14px; background:#fafafa; border-radius:12px; margin-bottom:8px;';

        const iconEl = document.createElement('div');
        iconEl.style.cssText = 'width:36px; height:36px; border-radius:10px; background:#eee; display:flex; align-items:center; justify-content:center; font-size:18px; flex-shrink:0;';
        iconEl.textContent = '🎮';

        const infoEl = document.createElement('div');
        infoEl.style.cssText = 'flex:1; min-width:0;';

        const nameEl = document.createElement('div');
        nameEl.style.cssText = 'font-size:14px; font-weight:500; color:#333; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;';
        nameEl.textContent = device.name;

        const typeEl = document.createElement('div');
        typeEl.style.cssText = 'font-size:11px; color:#aaa; margin-top:2px; display:flex; align-items:center; flex-wrap:wrap; gap:4px;';
        const features = [];

        // 解析设备支持的特性
        if (device.vibrateAttributes && device.vibrateAttributes.length > 0) features.push('振动');
        if (device.rotateAttributes && device.rotateAttributes.length > 0) features.push('旋转');
        if (device.linearAttributes && device.linearAttributes.length > 0) features.push('线性');
        if (device.oscillateAttributes && device.oscillateAttributes.length > 0) features.push('摆动');

        // V4 特性检测
        if (device.features && Array.isArray(device.features)) {
            device.features.forEach(f => {
                if (f.outputs) {
                    if (f.outputs.Vibrate && !features.includes('振动')) features.push('振动');
                    if (f.outputs.Rotate && !features.includes('旋转')) features.push('旋转');
                    if (f.outputs.Linear && !features.includes('线性')) features.push('线性');
                    if (f.outputs.Oscillate && !features.includes('摆动')) features.push('摆动');
                }
            });
        }

        const featureText = document.createElement('span');
        featureText.textContent = features.length > 0 ? features.join(' · ') : '未知设备特性';
        typeEl.appendChild(featureText);

        // 如果设备支持读取电量，尝试获取电量并显示
        if (typeof device.battery === 'function') {
            const batEl = document.createElement('span');
            batEl.style.cssText = 'font-size:10px; color:#4caf50; background:#e8f5e9; padding:2px 4px; border-radius:4px; margin-left:4px;';
            batEl.textContent = '🔋 读取中...';
            typeEl.appendChild(batEl);

            device.battery().then(level => {
                if (level !== undefined && level !== null) {
                    batEl.textContent = `🔋 ${Math.round(level)}%`;
                } else {
                    batEl.style.display = 'none';
                }
            }).catch(e => {
                console.warn('[Toy] 获取电量失败', e);
                batEl.style.display = 'none';
            });
        }

        infoEl.appendChild(nameEl);
        infoEl.appendChild(typeEl);

        // Test button
        const testBtn = document.createElement('button');
        testBtn.style.cssText = 'padding:4px 12px; border:none; border-radius:8px; background:#555; color:white; font-size:12px; cursor:pointer; flex-shrink:0;';
        testBtn.textContent = '测试';
        testBtn.onclick = async () => {
            try {
                showToast(`🎮 ${device.name} 测试中...`);
                // 调用我们的全能函数
                await omniVibrate(device, 0.3);

                // 1秒后停止 (X光测试显示 stop 是所有版本通用的)
                setTimeout(async () => {
                    try { await device.stop(); } catch (e) { }
                }, 1000);
            } catch (e) {
                console.error('[Toy Test]', e);
                showToast('测试失败: ' + e.message);
            }
        };

        card.appendChild(iconEl);
        card.appendChild(infoEl);
        card.appendChild(testBtn);
        container.appendChild(card);
    });
}

// ===== Toy Settings Screen =====

function openToySettings() {
    if (settingsScreen) settingsScreen.style.display = 'none';
    const screen = document.getElementById('toy-settings-screen');
    if (screen) screen.style.display = 'flex';
    updateStatusBar('settings');

    // Load current settings into UI
    const wsInput = document.getElementById('set-toy-ws-url');
    if (wsInput) wsInput.value = appSettings.toyWsUrl || 'ws://127.0.0.1:12345';

    updateToyConnectionUI();
    renderToyDeviceList();
}

function closeToySettings() {
    const screen = document.getElementById('toy-settings-screen');
    if (screen) screen.style.display = 'none';
    if (settingsScreen) settingsScreen.style.display = 'flex';
    updateStatusBar('settings');
}

function saveToySettings() {
    const wsInput = document.getElementById('set-toy-ws-url');
    if (wsInput) appSettings.toyWsUrl = wsInput.value.trim() || 'ws://127.0.0.1:12345';

    saveSettingsToStorage();
    showToast('✅ 玩具设置已保存');
}

// ===== Vibration Control =====

function toyStopAll() {
    // Clear pattern timer
    if (_toyPatternTimer) {
        clearTimeout(_toyPatternTimer);
        _toyPatternTimer = null;
    }
    // Stop all devices
    _toyDevices.forEach(device => {
        try { device.stop(); } catch (e) { }
    });
}

async function toyVibrate(level) {
    const intensity = Math.max(0, Math.min(1, level / 100));
    for (const device of _toyDevices) {
        try {
            await omniVibrate(device, intensity);
        } catch (e) {
            console.error('[Toy] Vibrate error:', e);
        }
    }
}

/**
 * Execute a toy command from AI output
 * @param {Object} cmd - Parsed command object
 *   cmd.mode    - 'stop' to stop
 *   cmd.level   - 0-100 single intensity
 *   cmd.duration - seconds for single intensity
 *   cmd.pattern - comma-separated intensity sequence
 *   cmd.beat    - ms per step (single or comma-separated)
 */
async function executeToyCommand(cmd) {
    if (!_toyConnected || _toyDevices.length === 0) {
        console.log('[Toy] No connected devices, skipping command');
        return;
    }

    if (appSettings.toyEnabled === false) {
        console.log('[Toy] Toy control disabled by user');
        return;
    }

    // Stop previous command
    toyStopAll();

    // Stop mode
    if (cmd.mode === 'stop') {
        console.log('[Toy] Stop command');
        return;
    }

    // Single intensity mode
    if (cmd.level !== undefined && cmd.level !== null) {
        const level = parseInt(cmd.level);
        const duration = parseFloat(cmd.duration) || 3;
        console.log(`[Toy] Vibrate level=${level} duration=${duration}s`);
        await toyVibrate(level);
        _toyPatternTimer = setTimeout(() => {
            toyStopAll();
        }, duration * 1000);
        return;
    }

    // Pattern mode
    if (cmd.pattern) {
        const levels = cmd.pattern.split(',').map(v => parseInt(v.trim()));
        let beats;
        if (cmd.beat) {
            const beatParts = String(cmd.beat).split(',').map(v => parseInt(v.trim()));
            if (beatParts.length === 1) {
                // Single beat value for all
                beats = levels.map(() => beatParts[0]);
            } else {
                // Array of beats
                beats = beatParts;
            }
        } else {
            // Default beat: 300ms
            beats = levels.map(() => 300);
        }

        console.log(`[Toy] Pattern mode: levels=[${levels}] beats=[${beats}]`);

        let idx = 0;
        const runStep = async () => {
            if (!_toyConnected) return;
            const currentLevel = levels[idx % levels.length];
            const currentBeat = beats[idx % beats.length] || 300;
            await toyVibrate(currentLevel);
            idx++;
            _toyPatternTimer = setTimeout(runStep, currentBeat);
        };

        await runStep();
        return;
    }
}

// ===== Cleanup on page unload =====
window.addEventListener('beforeunload', () => {
    toyStopAll();
    if (_toyClient && _toyConnected) {
        try { _toyClient.disconnect(); } catch (e) { }
    }
});

// ========== Music Player Module ==========

// --- State ---
let musicLibrary = [];
let musicPlaylist = []; // current play queue (indices into musicLibrary)
let musicCurrentIndex = -1; // index in musicPlaylist
let musicPlayMode = 'loop'; // loop | shuffle | single
let musicAudio = null; // HTML5 Audio instance
let musicIsPlaying = false;
let musicPlayId = 0; // tracks current play request to avoid AbortError
let musicProgressTimer = null;
let musicListenTogether = false;
let musicListenPartner = '';
let musicListenPartnerAvatar = '';
let musicParsedLyrics = []; // [{time: seconds, text: string}]
let musicCurrentLyricIdx = -1;
let musicShowLyrics = false; // toggle disc <-> lyrics view

const MUSIC_STORAGE_KEY = 'faye-phone-music-library';
const MUSIC_API_BASE = 'http://music.zhuantou.phey.click';

// --- Meting API Helpers ---
function extractNeteaseId(text) {
    // Match various 163.com link formats
    // https://music.163.com/song?id=591321
    // https://music.163.com/#/song?id=591321
    // https://music.163.com/song?id=287063&uct2=xxx
    // https://y.music.163.com/m/song?id=591321
    // http://music.163.com/song/591321
    // Just the ID number
    const patterns = [
        /music\.163\.com.*[?&]id=(\d+)/i,
        /y\.music\.163\.com.*[?&]id=(\d+)/i,
        /music\.163\.com.*\/song\/(\d+)/i,
        /^\s*(\d{4,})\s*$/  // bare numeric ID (4+ digits)
    ];
    for (const p of patterns) {
        const m = text.match(p);
        if (m) return m[1];
    }
    return null;
}

// Extract 163cn.tv short URL from text (mobile share format)
function extract163ShortUrl(text) {
    const m = text.match(/https?:\/\/163cn\.tv\/\w+/i);
    return m ? m[0] : null;
}

// Resolve a 163cn.tv short URL to get the actual song ID
async function resolveNeteaseShortUrl(shortUrl) {
    // Method 1: Direct fetch (follow redirects) — may work if CORS allows
    try {
        const resp = await fetch(shortUrl, { redirect: 'follow' });
        const finalUrl = resp.url;
        const id = extractNeteaseId(finalUrl);
        if (id) return id;
        // Try parsing the page content for song ID
        const html = await resp.text();
        const idMatch = html.match(/song[?/&]id[=:](\d+)/i) || html.match(/[?&]id=(\d+)/);
        if (idMatch) return idMatch[1];
    } catch (e) {
        console.log('[Music] Direct fetch failed (CORS), trying proxy...');
    }

    // Method 2: CORS proxy fallback
    try {
        const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(shortUrl)}`;
        const resp = await fetch(proxyUrl);
        if (resp.ok) {
            const data = await resp.json();
            if (data.status && data.status.url) {
                const id = extractNeteaseId(data.status.url);
                if (id) return id;
            }
            if (data.contents) {
                const idMatch = data.contents.match(/song[?/&]id[=:](\d+)/i) ||
                    data.contents.match(/[?&]id=(\d+)/);
                if (idMatch) return idMatch[1];
            }
        }
    } catch (e) {
        console.log('[Music] Proxy fetch also failed:', e);
    }

    // Method 3: Try another CORS proxy
    try {
        const proxyUrl2 = `https://corsproxy.io/?${encodeURIComponent(shortUrl)}`;
        const resp = await fetch(proxyUrl2, { redirect: 'follow' });
        const finalUrl = resp.url;
        const id = extractNeteaseId(finalUrl);
        if (id) return id;
        const html = await resp.text();
        const idMatch = html.match(/song[?/&]id[=:](\d+)/i) || html.match(/[?&]id=(\d+)/);
        if (idMatch) return idMatch[1];
    } catch (e) {
        console.log('[Music] All proxy methods failed');
    }

    return null;
}

// Handle short URL resolution and share (async, fire-and-forget from sync caller)
async function resolveAndShareShortUrl(shortUrl) {
    showToast('正在解析短链接...');
    const songId = await resolveNeteaseShortUrl(shortUrl);
    if (songId) {
        sendMusicShareToChat(songId, 'netease');
    } else {
        showToast('无法解析短链接，请复制电脑版完整链接或直接输入歌曲ID');
    }
}

// Check if text is a NetEase music link and handle it
// Returns true synchronously if the text looks like a music link (even if async processing needed)
function handleMusicLinkInput(text) {
    // 1. Try direct ID extraction (desktop full URL or bare ID)
    const songId = extractNeteaseId(text);
    if (songId) {
        sendMusicShareToChat(songId, 'netease');
        return true;
    }

    // 2. Check for 163cn.tv short URL (mobile share format)
    // e.g. "孙燕姿的单曲《我怀念的》: https://163cn.tv/2jH3T3L (来自@网易云音乐)"
    const shortUrl = extract163ShortUrl(text);
    if (shortUrl) {
        resolveAndShareShortUrl(shortUrl); // async, fire-and-forget
        return true; // return immediately so input is cleared
    }

    // 3. Check if it looks like a 网易云 share text without a recognizable URL
    // (e.g. user pasted only the text part)
    if (text.includes('来自@网易云音乐') || text.includes('网易云音乐')) {
        showToast('请粘贴包含链接的完整分享内容');
        return true;
    }

    return false;
}

async function fetchSongFromAPI(songId, server = 'netease') {
    try {
        const resp = await fetch(`${MUSIC_API_BASE}/?type=song&id=${songId}`);
        if (!resp.ok) throw new Error('API request failed');
        const data = await resp.json();
        if (!data || data.length === 0) throw new Error('Song not found');
        const song = data[0];
        // Also try to fetch LRC lyrics
        let lrc = '';
        try {
            const lrcResp = await fetch(`${MUSIC_API_BASE}/?server=${server}&type=lrc&id=${songId}`);
            if (lrcResp.ok) lrc = await lrcResp.text();
        } catch (e) { /* ignore lyrics fetch error */ }
        return {
            id: songId,
            server: server,
            name: song.name || '未知歌曲',
            artist: song.artist || '未知歌手',
            coverUrl: song.pic || '',
            audioUrl: song.url || '',
            lrcUrl: song.lrc || '',
            lyrics: lrc
        };
    } catch (e) {
        console.error('[Music API] Fetch failed:', e);
        return null;
    }
}

// Send a music share card in current chat
async function sendMusicShareToChat(songId, server = 'netease') {
    showToast('正在获取歌曲信息...');
    const songInfo = await fetchSongFromAPI(songId, server);
    if (!songInfo) {
        showToast('获取歌曲信息失败');
        return;
    }
    const t = typeof getTime === 'function' ? getTime(true) : '12:00';
    const u = typeof getUserName === 'function' ? getUserName() : '我';
    // Body format: name|artist|songId|server|coverUrl|audioUrl
    const body = `${songInfo.name}|${songInfo.artist}|${songInfo.id}|${songInfo.server}|${songInfo.coverUrl}|${songInfo.audioUrl}`;
    renderMessageToUI({
        header: `[${u}|MUSIC|${t}]`,
        body: body,
        isUser: true,
        type: 'music'
    });
    // Also add to local library if not already there
    addSongToLibraryFromAPI(songInfo);
}

// Add API song to local library for playback
function addSongToLibraryFromAPI(songInfo) {
    loadMusicLibrary();
    const existing = musicLibrary.find(s => s.neteaseId === songInfo.id);
    if (!existing) {
        musicLibrary.push({
            id: 'api_' + songInfo.server + '_' + songInfo.id,
            neteaseId: songInfo.id,
            server: songInfo.server,
            name: songInfo.name,
            artist: songInfo.artist,
            coverUrl: songInfo.coverUrl,
            audioUrl: songInfo.audioUrl,
            lyrics: songInfo.lyrics || '',
            addedAt: Date.now()
        });
        saveMusicLibrary();
    }
}

// Play a song from API (called when clicking music cards in chat)
async function playMusicFromAPI(songId, server = 'netease') {
    loadMusicLibrary();
    // Check if already in library
    let idx = musicLibrary.findIndex(s => s.neteaseId === songId);
    if (idx >= 0 && musicLibrary[idx].audioUrl) {
        musicPlaySong(idx);
        showToast('正在播放: ' + musicLibrary[idx].name);
        return;
    }
    // Fetch from API
    showToast('正在加载歌曲...');
    const songInfo = await fetchSongFromAPI(songId, server);
    if (!songInfo || !songInfo.audioUrl) {
        showToast('无法获取音频');
        return;
    }
    addSongToLibraryFromAPI(songInfo);
    idx = musicLibrary.findIndex(s => s.neteaseId === songId);
    if (idx >= 0) {
        musicPlaySong(idx);
        showToast('正在播放: ' + songInfo.name);
    }
}

// Render API-based music card for AI messages
async function renderAPIMusicCard(songId, server, cardEl) {
    if (!cardEl) return;
    cardEl.innerHTML = '<div style="padding:12px;text-align:center;color:#999;font-size:12px;">加载中...</div>';
    try {
        const songInfo = await fetchSongFromAPI(songId, server);
        if (!songInfo) {
            cardEl.innerHTML = '<div style="padding:12px;text-align:center;color:#e74c3c;font-size:12px;">加载失败</div>';
            return;
        }
        addSongToLibraryFromAPI(songInfo);
        const coverSrc = songInfo.coverUrl || generateMusicCover(songInfo.name);
        cardEl.innerHTML = createMusicCardHTML(songInfo.name, songInfo.artist, false, coverSrc, songId, server);
        cardEl.dataset.rawBody = `${songInfo.name}|${songInfo.artist}|${songId}|${server}|${songInfo.coverUrl || ''}|${songInfo.audioUrl || ''}`;
    } catch (e) {
        cardEl.innerHTML = '<div style="padding:12px;text-align:center;color:#e74c3c;font-size:12px;">加载失败</div>';
    }
}



// --- Built-in Demo Songs ---
const MUSIC_BUILTIN_SONGS = [
    { id: 'builtin_1', name: '生日祝福歌', artist: '格格', coverUrl: 'http://music.zhuantou.phey.click/?server=netease&type=pic&id=109951163000800364', audioUrl: 'http://music.zhuantou.phey.click/?server=netease&type=url&id=497918887', lrcUrl: 'http://music.zhuantou.phey.click/?server=netease&type=lrc&id=497918887', builtin: true },
];
// --- Storage ---
function loadMusicLibrary() {
    const stored = localStorage.getItem(MUSIC_STORAGE_KEY);
    if (stored) {
        try { musicLibrary = JSON.parse(stored); } catch (e) { musicLibrary = []; }
    }
    if (musicLibrary.length === 0) {
        musicLibrary = JSON.parse(JSON.stringify(MUSIC_BUILTIN_SONGS));
        saveMusicLibrary();
    }
}

function saveMusicLibrary() {
    localStorage.setItem(MUSIC_STORAGE_KEY, JSON.stringify(musicLibrary));
}

// --- Audio Engine ---
function initMusicAudio() {
    if (musicAudio) return;
    musicAudio = new Audio();
    musicAudio.preload = 'metadata';
    musicAudio.addEventListener('ended', onMusicEnded);
    musicAudio.addEventListener('loadedmetadata', onMusicMetadataLoaded);
    musicAudio.addEventListener('error', (e) => {
        console.error('[Music] Audio error:', e);
        showToast('音频加载失败，请检查URL');
        musicIsPlaying = false;
        updateMusicPlayButton();
    });
}

function onMusicEnded() {
    switch (musicPlayMode) {
        case 'single':
            musicAudio.currentTime = 0;
            musicAudio.play();
            break;
        case 'shuffle':
            musicPlayRandom();
            break;
        case 'loop':
        default:
            musicNext();
            break;
    }
}

function onMusicMetadataLoaded() {
    const totalEl = document.getElementById('music-total-time');
    const progressBar = document.getElementById('music-progress-bar');
    if (totalEl) totalEl.textContent = formatMusicTime(musicAudio.duration);
    if (progressBar) progressBar.max = Math.floor(musicAudio.duration);
}

// --- Playback Controls ---
function musicPlaySong(libraryIndex) {
    initMusicAudio();
    const song = musicLibrary[libraryIndex];
    if (!song) return;

    if (!song.audioUrl) {
        showToast('请先为此歌曲添加音频URL');
        openEditSongModal(libraryIndex);
        return;
    }

    // Cancel any in-flight play request to avoid AbortError
    const thisPlayId = ++musicPlayId;
    musicCurrentIndex = libraryIndex;

    // Pause current playback before changing src
    if (!musicAudio.paused) {
        musicAudio.pause();
    }
    musicAudio.src = song.audioUrl;

    // Update UI immediately (cover / name) before audio loads
    musicIsPlaying = false;
    updateMusicUI();
    showMiniPlayer();

    musicAudio.play().then(() => {
        // Only apply if this is still the current play request
        if (thisPlayId !== musicPlayId) return;
        musicIsPlaying = true;
        updateMusicPlayButton();
        updateMiniPlayerPlayButton();
        updateDiscAnimation();
        startMusicProgressTimer();
        // Switch to player view if music app is open
        const musicScreen = document.getElementById('music-screen');
        if (musicScreen && musicScreen.style.display === 'flex') {
            showMusicPlayerView();
        }
    }).catch(e => {
        if (thisPlayId !== musicPlayId) return; // stale, ignore
        if (e.name === 'AbortError') return; // benign, ignore
        console.error('[Music] Play failed:', e);
        showToast('播放失败: ' + e.message);
    });
}

function toggleMusicPlay() {
    if (!musicAudio || musicCurrentIndex < 0) {
        // Try playing first song
        if (musicLibrary.length > 0) {
            const firstPlayable = musicLibrary.findIndex(s => s.audioUrl);
            if (firstPlayable >= 0) musicPlaySong(firstPlayable);
            else showToast('请先添加带音频URL的歌曲');
        }
        return;
    }

    if (musicIsPlaying) {
        musicAudio.pause();
        musicIsPlaying = false;
        stopMusicProgressTimer();
    } else {
        musicAudio.play().then(() => {
            musicIsPlaying = true;
            startMusicProgressTimer();
        }).catch(() => { });
    }
    updateMusicPlayButton();
    updateMiniPlayerPlayButton();
    updateDiscAnimation();
}

function musicNext() {
    if (musicLibrary.length === 0) return;
    let nextIdx;
    if (musicPlayMode === 'shuffle') {
        nextIdx = Math.floor(Math.random() * musicLibrary.length);
    } else {
        nextIdx = (musicCurrentIndex + 1) % musicLibrary.length;
    }
    musicPlaySong(nextIdx);
}

function musicPrev() {
    if (musicLibrary.length === 0) return;
    let prevIdx;
    if (musicPlayMode === 'shuffle') {
        prevIdx = Math.floor(Math.random() * musicLibrary.length);
    } else {
        prevIdx = (musicCurrentIndex - 1 + musicLibrary.length) % musicLibrary.length;
    }
    musicPlaySong(prevIdx);
}

function musicPlayRandom() {
    if (musicLibrary.length <= 1) { musicNext(); return; }
    let idx;
    do { idx = Math.floor(Math.random() * musicLibrary.length); } while (idx === musicCurrentIndex);
    musicPlaySong(idx);
}

function musicPlayAll() {
    if (musicLibrary.length === 0) {
        showToast('还没有歌曲');
        return;
    }
    // Find the first song that has audio
    const firstPlayable = musicLibrary.findIndex(s => !!s.audioUrl);
    if (firstPlayable >= 0) {
        musicPlaySong(firstPlayable);
    } else {
        showToast('没有可播放的歌曲，请先添加音频');
    }
}

function toggleMusicPlayMode() {
    const modes = ['loop', 'shuffle', 'single'];
    const currentIdx = modes.indexOf(musicPlayMode);
    musicPlayMode = modes[(currentIdx + 1) % modes.length];
    updateMusicModeButton();
    updateMiniModeIcon();
    const modeNames = { loop: '列表循环', shuffle: '随机播放', single: '单曲循环' };
    showToast(modeNames[musicPlayMode]);
}

// Alias for mini player mode button
function musicCyclePlayMode() {
    toggleMusicPlayMode();
}

// Update mode icon on mini player
function updateMiniModeIcon() {
    const el = document.getElementById('mfd-mode-icon');
    if (!el) return;
    const icons = {
        loop: '<path d="M17 1l4 4-4 4"/><path d="M3 11V9a4 4 0 014-4h14"/><path d="M7 23l-4-4 4-4"/><path d="M21 13v2a4 4 0 01-4 4H3"/>',
        shuffle: '<polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/><polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/><line x1="4" y1="4" x2="9" y2="9"/>',
        single: '<path d="M17 1l4 4-4 4"/><path d="M3 11V9a4 4 0 014-4h14"/><path d="M7 23l-4-4 4-4"/><path d="M21 13v2a4 4 0 01-4 4H3"/><text x="10" y="15" fill="currentColor" stroke="none" font-size="8" font-weight="bold">1</text>'
    };
    el.innerHTML = icons[musicPlayMode] || icons.loop;
}

function seekMusic(value) {
    if (musicAudio && musicAudio.duration) {
        musicAudio.currentTime = value;
    }
}

// --- Progress Timer ---
function startMusicProgressTimer() {
    stopMusicProgressTimer();
    musicProgressTimer = setInterval(updateMusicProgress, 500);
}

function stopMusicProgressTimer() {
    if (musicProgressTimer) {
        clearInterval(musicProgressTimer);
        musicProgressTimer = null;
    }
}

function updateMusicProgress() {
    if (!musicAudio || !musicAudio.duration) return;
    const currentEl = document.getElementById('music-current-time');
    const progressBar = document.getElementById('music-progress-bar');
    if (currentEl) currentEl.textContent = formatMusicTime(musicAudio.currentTime);
    if (progressBar && !progressBar._dragging) {
        progressBar.value = Math.floor(musicAudio.currentTime);
    }
    // Update floating disc progress ring
    updateMiniProgressRing();
    // Update lyrics
    updateCurrentLyric();
}

// --- LRC Parser & Lyrics ---
function parseLRC(lrcText) {
    if (!lrcText) return [];
    const lines = lrcText.split('\n');
    const result = [];
    const timeRegex = /\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g;
    for (const line of lines) {
        const textPart = line.replace(/\[\d{1,2}:\d{2}(?:[.:]\d{1,3})?\]/g, '').trim();
        if (!textPart) continue; // skip empty lines
        let match;
        timeRegex.lastIndex = 0;
        while ((match = timeRegex.exec(line)) !== null) {
            const min = parseInt(match[1]);
            const sec = parseInt(match[2]);
            const ms = match[3] ? parseInt(match[3].padEnd(3, '0')) : 0;
            const time = min * 60 + sec + ms / 1000;
            result.push({ time, text: textPart });
        }
    }
    result.sort((a, b) => a.time - b.time);
    return result;
}

function loadSongLyrics() {
    const song = musicLibrary[musicCurrentIndex];
    musicParsedLyrics = song && song.lyrics ? parseLRC(song.lyrics) : [];
    musicCurrentLyricIdx = -1;
    renderLyricsView();
}

function updateCurrentLyric() {
    if (!musicParsedLyrics.length || !musicAudio) return;
    const t = musicAudio.currentTime;
    let idx = -1;
    for (let i = musicParsedLyrics.length - 1; i >= 0; i--) {
        if (t >= musicParsedLyrics[i].time) { idx = i; break; }
    }
    if (idx !== musicCurrentLyricIdx) {
        musicCurrentLyricIdx = idx;
        highlightLyricLine(idx);
        updateMiniLyric();
    }
}

function highlightLyricLine(idx) {
    const container = document.getElementById('music-lyrics-scroll');
    if (!container) return;
    const lines = container.querySelectorAll('.lyric-line');
    lines.forEach((el, i) => {
        el.classList.toggle('active', i === idx);
        // Distance-based opacity & scale for karaoke feel
        const dist = Math.abs(i - idx);
        if (i === idx) {
            el.style.opacity = '1';
            el.style.transform = 'scale(1.05)';
            el.style.fontSize = '18px';
        } else if (dist <= 2) {
            el.style.opacity = String(0.6 - dist * 0.15);
            el.style.transform = 'scale(1)';
            el.style.fontSize = '15px';
        } else if (dist <= 5) {
            el.style.opacity = String(0.3 - (dist - 2) * 0.05);
            el.style.transform = 'scale(1)';
            el.style.fontSize = '14px';
        } else {
            el.style.opacity = '0.12';
            el.style.transform = 'scale(1)';
            el.style.fontSize = '14px';
        }
    });
    // Scroll to current line — center it smoothly
    if (idx >= 0 && lines[idx]) {
        const lineEl = lines[idx];
        const containerH = container.clientHeight;
        const scrollTarget = lineEl.offsetTop - containerH / 2 + lineEl.offsetHeight / 2;
        container.scrollTo({ top: scrollTarget, behavior: 'smooth' });
    }
}

function updateMiniLyric() {
    const labelEl = document.getElementById('mini-player-name');
    if (!labelEl) return;
    if (musicParsedLyrics.length && musicCurrentLyricIdx >= 0) {
        labelEl.textContent = musicParsedLyrics[musicCurrentLyricIdx].text;
    } else {
        const song = musicLibrary[musicCurrentIndex];
        if (song) labelEl.textContent = song.name;
    }
}

function renderLyricsView() {
    const container = document.getElementById('music-lyrics-scroll');
    if (!container) return;
    if (!musicParsedLyrics.length) {
        container.innerHTML = '<div class="lyric-empty">暂无歌词</div>';
        return;
    }
    container.innerHTML = musicParsedLyrics.map((l, i) =>
        `<div class="lyric-line" data-idx="${i}" onclick="seekToLyric(${i})">${escapeHtml(l.text)}</div>`
    ).join('');
}

function seekToLyric(idx) {
    if (!musicAudio || !musicParsedLyrics[idx]) return;
    musicAudio.currentTime = musicParsedLyrics[idx].time;
    if (!musicIsPlaying) toggleMusicPlay();
}

function togglePlayerLyricsView() {
    musicShowLyrics = !musicShowLyrics;
    const discArea = document.getElementById('music-disc-area-wrap');
    const lyricsArea = document.getElementById('music-lyrics-area');
    if (discArea) discArea.style.display = musicShowLyrics ? 'none' : 'flex';
    if (lyricsArea) lyricsArea.style.display = musicShowLyrics ? 'flex' : 'none';
}

// --- UI Rendering ---
function updateMusicUI() {
    updateMusicPlayerView();
    updateMusicPlayButton();
    updateMusicModeButton();
    updateMiniPlayer();
    updateDiscAnimation();
    renderMusicLibraryList();
    loadSongLyrics();
}

function updateMusicPlayerView() {
    const song = musicLibrary[musicCurrentIndex];
    if (!song) return;

    const nameEl = document.getElementById('music-now-name');
    const artistEl = document.getElementById('music-now-artist');
    const coverEl = document.getElementById('music-disc-cover');
    const bgEl = document.getElementById('music-player-bg');

    if (nameEl) nameEl.textContent = song.name;
    if (artistEl) artistEl.textContent = song.artist || '未知歌手';

    const coverSrc = song.coverUrl || generateMusicCover(song.name);
    if (coverEl) coverEl.src = coverSrc;
    if (bgEl) bgEl.style.backgroundImage = `url(${coverSrc})`;
}

function updateMusicPlayButton() {
    const btn = document.getElementById('music-play-btn');
    if (btn) {
        btn.innerHTML = musicIsPlaying
            ? '<svg viewBox="0 0 24 24" fill="currentColor" width="32" height="32"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>'
            : '<svg viewBox="0 0 24 24" fill="currentColor" width="32" height="32"><path d="M8 5v14l11-7z"/></svg>';
    }
}

function updateMiniPlayerPlayButton() {
    const btn = document.getElementById('mfd-play-btn');
    if (btn) {
        btn.innerHTML = musicIsPlaying
            ? '<svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>'
            : '<svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12"><path d="M8 5v14l11-7z"/></svg>';
    }
}

function updateMusicModeButton() {
    const btn = document.getElementById('music-mode-btn');
    if (!btn) return;
    const icons = {
        loop: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20"><path d="M17 1l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 23l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>',
        shuffle: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20"><polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/><polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/><line x1="4" y1="4" x2="9" y2="9"/></svg>',
        single: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20"><path d="M17 1l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 23l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/><text x="10" y="15" fill="currentColor" stroke="none" font-size="8" font-weight="bold">1</text></svg>'
    };
    btn.innerHTML = icons[musicPlayMode] || icons.loop;
}

function updateDiscAnimation() {
    const disc = document.getElementById('music-disc');
    if (disc) {
        if (musicIsPlaying) {
            disc.classList.add('spinning');
        } else {
            disc.classList.remove('spinning');
        }
    }
}

function generateMusicCover(songName) {
    // Minimalist lighter grey cover
    const canvas = document.createElement('canvas');
    canvas.width = 200;
    canvas.height = 200;
    const ctx = canvas.getContext('2d');
    // Lighter grey gradient
    const gradient = ctx.createLinearGradient(0, 0, 200, 200);
    gradient.addColorStop(0, '#7a7a8a');
    gradient.addColorStop(1, '#5a5a6a');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 200, 200);
    // Music note (more visible)
    ctx.fillStyle = 'rgba(255,255,255,0.18)';
    ctx.font = '80px serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('♪', 100, 100);
    return canvas.toDataURL();
}

// --- Library List ---
function renderMusicLibraryList() {
    const listEl = document.getElementById('music-song-list');
    if (!listEl) return;

    if (musicLibrary.length === 0) {
        listEl.innerHTML = '<div class="music-empty">还没有歌曲，点击右上角添加</div>';
        return;
    }

    let html = '';
    musicLibrary.forEach((song, idx) => {
        const isActive = idx === musicCurrentIndex;
        const coverSrc = song.coverUrl || generateMusicCover(song.name);
        const hasAudio = !!song.audioUrl;

        html += `
        <div class="music-song-item ${isActive ? 'active' : ''} ${!hasAudio ? 'no-audio' : ''}" onclick="musicPlaySong(${idx})">
            <div class="music-song-cover-small">
                <img src="${coverSrc}" alt="">
                ${isActive && musicIsPlaying ? '<div class="music-playing-indicator"><span></span><span></span><span></span></div>' : ''}
            </div>
            <div class="music-song-info">
                <div class="music-song-name">${escapeHtml(song.name)}</div>
                <div class="music-song-artist">${escapeHtml(song.artist || '未知歌手')}${!hasAudio ? ' · <span style="color:#e67e22">需添加音频</span>' : ''}</div>
            </div>
            <div class="music-song-actions">
                <button class="music-song-btn" onclick="event.stopPropagation(); openMusicSongMenu(${idx})" title="更多">
                    <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>
                </button>
            </div>
        </div>`;
    });

    listEl.innerHTML = html;
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// --- Floating Mini Player (Draggable Disc) ---
let _miniDrag = { dragging: false, startX: 0, startY: 0, startLeft: 0, startTop: 0, moved: false };

function showMiniPlayer() {
    let mini = document.getElementById('music-mini-player');
    if (!mini) createFloatingMiniPlayer();
    mini = document.getElementById('music-mini-player');
    if (mini) {
        mini.style.display = 'flex';
        // Hide when music app is open
        const musicScreen = document.getElementById('music-screen');
        if (musicScreen && musicScreen.style.display === 'flex') mini.style.display = 'none';
    }
}

function hideMiniPlayer() {
    const mini = document.getElementById('music-mini-player');
    if (mini) mini.style.display = 'none';
}

function closeMiniPlayer() {
    if (musicAudio) { musicAudio.pause(); musicAudio.src = ''; }
    musicIsPlaying = false;
    musicCurrentIndex = -1;
    stopMusicProgressTimer();
    hideMiniPlayer();
}

function createFloatingMiniPlayer() {
    if (document.getElementById('music-mini-player')) return;
    const mini = document.createElement('div');
    mini.id = 'music-mini-player';
    mini.className = 'music-float-disc';
    mini.style.display = 'none';
    mini.innerHTML = `
        <div class="mfd-disc-wrap">
            <svg class="mfd-progress-ring" viewBox="0 0 66 66">
                <circle class="mfd-ring-bg" cx="33" cy="33" r="30"/>
                <circle id="mfd-progress-circle" class="mfd-ring-fg" cx="33" cy="33" r="30"
                    stroke-dasharray="188.5" stroke-dashoffset="188.5"/>
            </svg>
            <div class="mfd-vinyl">
                <img id="mini-player-cover" class="mfd-cover" src="" alt="">
            </div>
        </div>
        <div class="mfd-lyrics-panel" id="mfd-lyrics-panel">
            <div id="mini-player-name" class="mfd-lyric-text"></div>
            <div class="mfd-controls">
                <button class="mfd-ctrl-btn" onclick="event.stopPropagation(); musicCyclePlayMode()" title="播放模式">
                    <svg id="mfd-mode-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M17 1l4 4-4 4"/><path d="M3 11V9a4 4 0 014-4h14"/><path d="M7 23l-4-4 4-4"/><path d="M21 13v2a4 4 0 01-4 4H3"/></svg>
                </button>
                <button class="mfd-ctrl-btn" onclick="event.stopPropagation(); musicPrev()" title="上一首">
                    <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M6 6h2v12H6zm3.5 6l8.5 6V6z"/></svg>
                </button>
                <button class="mfd-ctrl-btn mfd-ctrl-play" id="mfd-play-btn" onclick="event.stopPropagation(); toggleMusicPlay()" title="播放/暂停">
                    <svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12"><path d="M6 4h4v16H6zM14 4h4v16h-4z"/></svg>
                </button>
                <button class="mfd-ctrl-btn" onclick="event.stopPropagation(); musicNext()" title="下一首">
                    <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/></svg>
                </button>
            </div>
        </div>
        <button class="mfd-close" onclick="event.stopPropagation(); closeMiniPlayer()">&times;</button>
    `;
    // Position: bottom-right by default
    const container = document.getElementById('phone-container');
    mini.style.bottom = '80px';
    mini.style.right = '16px';
    container.appendChild(mini);

    // Drag logic (touch)
    mini.addEventListener('touchstart', (e) => {
        const t = e.touches[0];
        const rect = mini.getBoundingClientRect();
        const containerRect = container.getBoundingClientRect();
        _miniDrag.dragging = true;
        _miniDrag.moved = false;
        _miniDrag.startX = t.clientX;
        _miniDrag.startY = t.clientY;
        _miniDrag.startLeft = rect.left - containerRect.left;
        _miniDrag.startTop = rect.top - containerRect.top;
    }, { passive: true });

    mini.addEventListener('touchmove', (e) => {
        if (!_miniDrag.dragging) return;
        const t = e.touches[0];
        const dx = t.clientX - _miniDrag.startX;
        const dy = t.clientY - _miniDrag.startY;
        if (Math.abs(dx) > 5 || Math.abs(dy) > 5) _miniDrag.moved = true;
        const container = document.getElementById('phone-container');
        const cw = container.clientWidth;
        const ch = container.clientHeight;
        let newLeft = _miniDrag.startLeft + dx;
        let newTop = _miniDrag.startTop + dy;
        newLeft = Math.max(0, Math.min(newLeft, cw - 60));
        newTop = Math.max(40, Math.min(newTop, ch - 60));
        mini.style.left = newLeft + 'px';
        mini.style.top = newTop + 'px';
        mini.style.right = 'auto';
        mini.style.bottom = 'auto';
    }, { passive: true });

    mini.addEventListener('touchend', (e) => {
        if (!_miniDrag.moved) {
            // If tap was on a button inside lyrics panel, don't open music app
            const target = e.target;
            const lyricsPanel = document.getElementById('mfd-lyrics-panel');
            if (lyricsPanel && lyricsPanel.contains(target)) {
                // Let the button onclick handle it
            } else {
                // Tap on cover: open music app
                if (typeof openMusicApp === 'function') openMusicApp();
            }
        }
        _miniDrag.dragging = false;
    });

    // Mouse drag for desktop
    mini.addEventListener('mousedown', (e) => {
        const containerRect = container.getBoundingClientRect();
        const rect = mini.getBoundingClientRect();
        _miniDrag.dragging = true;
        _miniDrag.moved = false;
        _miniDrag.startX = e.clientX;
        _miniDrag.startY = e.clientY;
        _miniDrag.startLeft = rect.left - containerRect.left;
        _miniDrag.startTop = rect.top - containerRect.top;
        e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
        if (!_miniDrag.dragging) return;
        const dx = e.clientX - _miniDrag.startX;
        const dy = e.clientY - _miniDrag.startY;
        if (Math.abs(dx) > 5 || Math.abs(dy) > 5) _miniDrag.moved = true;
        const cw = container.clientWidth;
        const ch = container.clientHeight;
        let newLeft = _miniDrag.startLeft + dx;
        let newTop = _miniDrag.startTop + dy;
        newLeft = Math.max(0, Math.min(newLeft, cw - 60));
        newTop = Math.max(40, Math.min(newTop, ch - 60));
        mini.style.left = newLeft + 'px';
        mini.style.top = newTop + 'px';
        mini.style.right = 'auto';
        mini.style.bottom = 'auto';
    });
    document.addEventListener('mouseup', (e) => {
        if (_miniDrag.dragging && !_miniDrag.moved) {
            const lyricsPanel = document.getElementById('mfd-lyrics-panel');
            if (!(lyricsPanel && lyricsPanel.contains(e.target))) {
                if (typeof openMusicApp === 'function') openMusicApp();
            }
        }
        _miniDrag.dragging = false;
    });
}

function updateMiniPlayer() {
    const song = musicLibrary[musicCurrentIndex];
    if (!song) return;

    const coverEl = document.getElementById('mini-player-cover');
    const nameEl = document.getElementById('mini-player-name');
    if (coverEl) coverEl.src = song.coverUrl || generateMusicCover(song.name);
    if (nameEl) nameEl.textContent = song.name;

    // Update disc spinning + play button icon
    const mini = document.getElementById('music-mini-player');
    if (mini) {
        if (musicIsPlaying) mini.classList.add('spinning');
        else mini.classList.remove('spinning');
    }
    updateMiniPlayIcon();
    showMiniPlayer();
}

function updateMiniPlayerPlayButton() {
    const mini = document.getElementById('music-mini-player');
    if (mini) {
        if (musicIsPlaying) mini.classList.add('spinning');
        else mini.classList.remove('spinning');
    }
    updateMiniPlayIcon();
    updateMiniProgressRing();
}

function updateMiniPlayIcon() {
    const btn = document.getElementById('mfd-play-btn');
    if (!btn) return;
    btn.innerHTML = musicIsPlaying
        ? '<svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>'
        : '<svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12"><path d="M8 5v14l11-7z"/></svg>';
}

function updateMiniProgressRing() {
    if (!musicAudio || !musicAudio.duration) return;
    const circle = document.getElementById('mfd-progress-circle');
    if (!circle) return;
    const circumference = 2 * Math.PI * 30; // r=30
    const progress = musicAudio.currentTime / musicAudio.duration;
    circle.style.strokeDashoffset = circumference * (1 - progress);
}

// --- Open / Close Music App ---
function openMusicApp() {
    loadMusicLibrary();
    let screen = document.getElementById('music-screen');
    if (!screen) {
        createMusicScreenHTML();
        screen = document.getElementById('music-screen');
    }
    screen.style.display = 'flex';
    hideMiniPlayer(); // hide floating disc when full app is open
    showMusicLibraryView();
    renderMusicLibraryList();
}

function closeMusicApp() {
    const screen = document.getElementById('music-screen');
    if (!screen) return;
    screen.style.animation = 'screenSlideOut 0.3s ease forwards';
    setTimeout(() => {
        screen.style.display = 'none';
        screen.style.animation = '';
        // Show floating player if music is still playing
        if (musicIsPlaying && musicCurrentIndex >= 0) {
            showMiniPlayer();
            updateMiniPlayer();
        }
    }, 280);
}

function showMusicLibraryView() {
    const lib = document.getElementById('music-library-view');
    const player = document.getElementById('music-player-view');
    if (lib) lib.style.display = 'flex';
    if (player) player.style.display = 'none';
}

function showMusicPlayerView() {
    if (musicCurrentIndex < 0 && musicLibrary.length > 0) {
        musicCurrentIndex = 0;
    }
    if (musicCurrentIndex < 0) {
        showToast('请先添加歌曲');
        return;
    }
    const lib = document.getElementById('music-library-view');
    const player = document.getElementById('music-player-view');
    if (lib) lib.style.display = 'none';
    if (player) player.style.display = 'flex';
    updateMusicPlayerView();
    updateMusicPlayButton();
    updateMusicModeButton();
    updateDiscAnimation();
}

function openMusicPlayerFromMini() {
    openMusicApp();
    setTimeout(() => showMusicPlayerView(), 50);
}

// --- Add Song Modal ---
function openAddSongModal() {
    const overlay = document.createElement('div');
    overlay.id = 'music-add-modal';
    overlay.className = 'modal-overlay show';
    overlay.style.cssText = 'position:absolute;top:0;left:0;right:0;bottom:0;z-index:2000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.35);backdrop-filter:blur(4px);';
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

    overlay.innerHTML = `
    <div class="modal-box group-modal-cute" style="width:300px;max-height:85vh;overflow-y:auto;">
        <div class="modal-title group-modal-title" style="margin-top:0;">添加歌曲</div>
        <div class="group-modal-field" style="margin-bottom:10px;padding:8px;background:#f0f0f0;border-radius:10px;border:1px solid #dddddd;">
            <label class="group-modal-label" style="color:#504e4f;">粘贴分享链接快速添加</label>
            <div style="display:flex;gap:6px;margin-top:4px;">
                <input class="group-modal-input" id="music-add-link" placeholder="粘贴网易云分享链接或歌曲ID..." style="flex:1;font-size:12px;" />
                <button class="modal-btn group-modal-confirm" style="flex-shrink:0;padding:4px 10px;font-size:12px;" onclick="musicAddFromLink()">自动获取</button>
            </div>
            <div id="music-add-link-status" style="font-size:11px;color:#888;margin-top:3px;"></div>
        </div>
        <div style="text-align:center;color:#ccc;font-size:11px;margin-bottom:6px;">—— 或手动填写 ——</div>
        <div class="group-modal-field" style="margin-bottom:6px;">
            <label class="group-modal-label">歌曲名称</label>
            <input class="group-modal-input" id="music-add-name" placeholder="歌曲名称" />
        </div>
        <div class="group-modal-field" style="margin-bottom:6px;">
            <label class="group-modal-label">歌手</label>
            <input class="group-modal-input" id="music-add-artist" placeholder="歌手" />
        </div>
        <div class="group-modal-field" style="margin-bottom:6px;">
            <label class="group-modal-label">音频URL</label>
            <div style="display:flex;gap:6px;">
                <input class="group-modal-input" id="music-add-audio" placeholder="粘贴音频URL..." style="flex:1;" />
                <button class="modal-btn group-modal-cancel" style="flex-shrink:0;padding:0 1px;font-size:11px;" onclick="musicAddUploadAudio()">上传音乐文件</button>
            </div>
        </div>
        <div class="group-modal-field" style="margin-bottom:6px;">
            <label class="group-modal-label">封面URL</label>
            <div style="display:flex;gap:6px;">
                <input class="group-modal-input" id="music-add-cover" placeholder="封面图片URL" style="flex:1;" />
                <button class="modal-btn group-modal-cancel" style="flex-shrink:0;padding:0 1px;font-size:11px;" onclick="musicAddUploadCover()">上传封面图片</button>
            </div>
        </div>
        <div class="group-modal-field" style="margin-bottom:6px;">
            <label class="group-modal-label">LRC歌词</label>
            <textarea class="group-modal-input" id="music-add-lyrics" rows="3" placeholder="粘贴LRC格式歌词..." style="resize:vertical;font-size:12px;line-height:1.4;font-family:monospace;"></textarea>
            <button class="modal-btn group-modal-cancel" style="width:100%;margin-top:4px;font-size:11px;padding:6px;" onclick="musicAddUploadLRC()">导入LRC文件</button>
        </div>
        <div class="modal-actions" style="margin-top:8px;gap:10px;">
            <button class="modal-btn group-modal-cancel" onclick="document.getElementById('music-add-modal').remove()">取消</button>
            <button class="modal-btn group-modal-confirm" onclick="confirmAddSong()">添加</button>
        </div>
    </div>`;

    const screen = document.getElementById('music-screen');
    if (screen) screen.appendChild(overlay);
}

// Auto-fill add song form from share link
async function musicAddFromLink() {
    const linkInput = document.getElementById('music-add-link');
    const statusEl = document.getElementById('music-add-link-status');
    if (!linkInput) return;
    const text = linkInput.value.trim();
    if (!text) { showToast('请先粘贴链接'); return; }

    if (statusEl) statusEl.textContent = '正在解析...';

    // Try direct ID extraction
    let songId = extractNeteaseId(text);

    // Try short URL
    if (!songId) {
        const shortUrl = extract163ShortUrl(text);
        if (shortUrl) {
            if (statusEl) statusEl.textContent = '正在解析短链接...';
            songId = await resolveNeteaseShortUrl(shortUrl);
        }
    }

    if (!songId) {
        if (statusEl) statusEl.textContent = '❌ 无法识别链接';
        showToast('无法识别音乐链接');
        return;
    }

    if (statusEl) statusEl.textContent = '正在获取歌曲信息...';

    const songInfo = await fetchSongFromAPI(songId, 'netease');
    if (!songInfo) {
        if (statusEl) statusEl.textContent = '❌ 获取歌曲信息失败';
        showToast('获取歌曲信息失败');
        return;
    }

    // Auto-fill form fields
    const nameEl = document.getElementById('music-add-name');
    const artistEl = document.getElementById('music-add-artist');
    const audioEl = document.getElementById('music-add-audio');
    const coverEl = document.getElementById('music-add-cover');
    const lyricsEl = document.getElementById('music-add-lyrics');
    if (nameEl) nameEl.value = songInfo.name || '';
    if (artistEl) artistEl.value = songInfo.artist || '';
    if (audioEl) audioEl.value = songInfo.audioUrl || '';
    if (coverEl) coverEl.value = songInfo.coverUrl || '';
    if (lyricsEl && songInfo.lyrics) lyricsEl.value = songInfo.lyrics;

    if (statusEl) statusEl.textContent = '✅ 已自动填充，点击"添加"即可保存';
    showToast('歌曲信息已自动填充');
}

function confirmAddSong() {
    const name = document.getElementById('music-add-name').value.trim();
    const artist = document.getElementById('music-add-artist').value.trim();
    const audioUrl = document.getElementById('music-add-audio').value.trim();
    const coverUrl = document.getElementById('music-add-cover').value.trim();
    const lyrics = document.getElementById('music-add-lyrics') ? document.getElementById('music-add-lyrics').value.trim() : '';

    if (!name) { showToast('请输入歌曲名称'); return; }

    const song = {
        id: 'song_' + Date.now(),
        name,
        artist: artist || '未知歌手',
        coverUrl,
        audioUrl,
        lyrics,
        addedAt: Date.now()
    };
    musicLibrary.push(song);
    saveMusicLibrary();
    renderMusicLibraryList();

    const modal = document.getElementById('music-add-modal');
    if (modal) modal.remove();
    showToast('歌曲已添加');
}

function musicAddUploadAudio() {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = 'audio/*';
    input.onchange = (e) => {
        const file = e.target.files[0]; if (!file) return;
        const blobUrl = URL.createObjectURL(file);
        const audioInput = document.getElementById('music-add-audio');
        const nameInput = document.getElementById('music-add-name');
        if (audioInput) audioInput.value = blobUrl;
        if (nameInput && !nameInput.value) nameInput.value = file.name.replace(/\.[^.]+$/, '');
        showToast('音频已加载');
    };
    input.click();
}

function musicAddUploadCover() {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = 'image/*';
    input.onchange = (e) => {
        const file = e.target.files[0]; if (!file) return;
        const reader = new FileReader();
        reader.onload = (ev) => {
            const coverInput = document.getElementById('music-add-cover');
            if (coverInput) coverInput.value = ev.target.result;
            showToast('封面已加载');
        };
        reader.readAsDataURL(file);
    };
    input.click();
}

function musicAddUploadLRC() {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = '.lrc,.txt';
    input.onchange = (e) => {
        const file = e.target.files[0]; if (!file) return;
        const reader = new FileReader();
        reader.onload = (ev) => {
            const lyricsArea = document.getElementById('music-add-lyrics');
            if (lyricsArea) lyricsArea.value = ev.target.result;
            showToast('LRC歌词已导入');
        };
        reader.readAsText(file);
    };
    input.click();
}

// --- Edit Song Modal ---
function openEditSongModal(idx) {
    const song = musicLibrary[idx];
    if (!song) return;

    const overlay = document.createElement('div');
    overlay.id = 'music-edit-modal';
    overlay.className = 'modal-overlay show';
    overlay.style.cssText = 'position:absolute;top:0;left:0;right:0;bottom:0;z-index:2000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.35);backdrop-filter:blur(4px);';
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

    const hasLyrics = !!song.lyrics;
    overlay.innerHTML = `
    <div class="modal-box group-modal-cute" style="width:300px;max-height:85vh;overflow-y:auto;">
        <div class="modal-title group-modal-title" style="margin-top:0;">编辑歌曲</div>
        <div class="group-modal-field" style="margin-bottom:6px;">
            <label class="group-modal-label">歌曲名称</label>
            <input class="group-modal-input" id="music-edit-name" value="${escapeHtml(song.name)}" />
        </div>
        <div class="group-modal-field" style="margin-bottom:6px;">
            <label class="group-modal-label">歌手</label>
            <input class="group-modal-input" id="music-edit-artist" value="${escapeHtml(song.artist || '')}" />
        </div>
        <div class="group-modal-field" style="margin-bottom:6px;">
            <label class="group-modal-label">音频URL</label>
            <div style="display:flex;gap:6px;">
                <input class="group-modal-input" id="music-edit-audio" value="${escapeHtml(song.audioUrl || '')}" placeholder="粘贴音频URL..." style="flex:1;" />
                <button class="modal-btn group-modal-cancel" style="flex-shrink:0;padding:0 10px;font-size:11px;" onclick="musicEditUploadFile(${idx})">上传</button>
            </div>
        </div>
        <div class="group-modal-field" style="margin-bottom:6px;">
            <label class="group-modal-label">封面URL</label>
            <div style="display:flex;gap:6px;">
                <input class="group-modal-input" id="music-edit-cover" value="${escapeHtml(song.coverUrl || '')}" placeholder="封面图片URL" style="flex:1;" />
                <button class="modal-btn group-modal-cancel" style="flex-shrink:0;padding:0 10px;font-size:11px;" onclick="musicEditUploadCover(${idx})">上传</button>
            </div>
        </div>
        <div class="group-modal-field" style="margin-bottom:6px;">
            <label class="group-modal-label">LRC歌词 ${hasLyrics ? '<span style="color:#51cf66;font-size:11px;">✓ 已有歌词</span>' : ''}</label>
            <textarea class="group-modal-input" id="music-edit-lyrics" rows="3" placeholder="粘贴LRC格式歌词..." style="resize:vertical;font-size:12px;line-height:1.4;font-family:monospace;">${escapeHtml(song.lyrics || '')}</textarea>
            <button class="modal-btn group-modal-cancel" style="width:100%;margin-top:4px;font-size:11px;padding:6px;" onclick="musicEditUploadLRC(${idx})">导入LRC文件</button>
        </div>
        <div class="modal-actions" style="margin-top:8px;gap:10px;">
            <button class="modal-btn group-modal-cancel" onclick="document.getElementById('music-edit-modal').remove()">取消</button>
            <button class="modal-btn group-modal-confirm" onclick="confirmEditSong(${idx})">保存</button>
        </div>
    </div>`;

    const screen = document.getElementById('music-screen');
    if (screen) screen.appendChild(overlay);
}

function confirmEditSong(idx) {
    const song = musicLibrary[idx];
    if (!song) return;

    song.name = document.getElementById('music-edit-name').value.trim() || song.name;
    song.artist = document.getElementById('music-edit-artist').value.trim() || '未知歌手';
    song.audioUrl = document.getElementById('music-edit-audio').value.trim();
    song.coverUrl = document.getElementById('music-edit-cover').value.trim();
    song.lyrics = document.getElementById('music-edit-lyrics').value.trim();

    saveMusicLibrary();
    renderMusicLibraryList();
    if (idx === musicCurrentIndex) {
        updateMusicPlayerView();
        loadSongLyrics();
    }

    const modal = document.getElementById('music-edit-modal');
    if (modal) modal.remove();
    showToast('已保存');
}

function musicEditUploadLRC(idx) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.lrc,.txt';
    input.onchange = (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (ev) => {
            const lyricsArea = document.getElementById('music-edit-lyrics');
            if (lyricsArea) lyricsArea.value = ev.target.result;
            showToast('LRC歌词已导入');
        };
        reader.readAsText(file);
    };
    input.click();
}

function musicEditUploadFile(idx) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'audio/*';
    input.onchange = (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const blobUrl = URL.createObjectURL(file);
        const audioInput = document.getElementById('music-edit-audio');
        if (audioInput) audioInput.value = blobUrl;
        showToast('音频已加载');
    };
    input.click();
}

function musicEditUploadCover(idx) {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = 'image/*';
    input.onchange = (e) => {
        const file = e.target.files[0]; if (!file) return;
        const reader = new FileReader();
        reader.onload = (ev) => {
            const coverInput = document.getElementById('music-edit-cover');
            if (coverInput) coverInput.value = ev.target.result;
            showToast('封面已加载');
        };
        reader.readAsDataURL(file);
    };
    input.click();
}

// --- Song Menu ---
function openMusicSongMenu(idx) {
    const song = musicLibrary[idx];
    if (!song) return;

    const overlay = document.createElement('div');
    overlay.id = 'music-song-menu';
    overlay.style.cssText = 'position:absolute;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.4);z-index:2000;display:flex;align-items:flex-end;justify-content:center;';
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

    overlay.innerHTML = `
    <div style="background:#fff;border-radius:14px 14px 0 0;width:100%;padding:16px;animation:slideUpSheet 0.25s ease;">
        <div style="font-size:15px;font-weight:600;color:#1a1a1a;margin-bottom:12px;text-align:center;">${escapeHtml(song.name)} - ${escapeHtml(song.artist || '')}</div>
        <div style="display:flex;flex-direction:column;gap:2px;">
            <button class="music-menu-btn" onclick="closeMusicMenu(); openEditSongModal(${idx})">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                编辑信息
            </button>
            <button class="music-menu-btn" onclick="closeMusicMenu(); shareMusicToChat(${idx})">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
                分享到聊天
            </button>
            <button class="music-menu-btn" onclick="closeMusicMenu(); startListenTogether('${escapeHtml(song.name)}', '${escapeHtml(song.artist || '')}')">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
                和TA一起听
            </button>
            <button class="music-menu-btn" style="color:#e53935;" onclick="closeMusicMenu(); deleteMusicSong(${idx})">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                删除歌曲
            </button>
        </div>
        <button style="width:100%;padding:12px;border:none;background:#f5f5f5;border-radius:10px;font-size:14px;color:#666;cursor:pointer;margin-top:10px;" onclick="closeMusicMenu()">取消</button>
    </div>`;

    const screen = document.getElementById('music-screen');
    if (screen) screen.appendChild(overlay);
}

function closeMusicMenu() {
    const menu = document.getElementById('music-song-menu');
    if (menu) menu.remove();
}

function deleteMusicSong(idx) {
    if (!confirm('确定要删除这首歌吗？')) return;
    musicLibrary.splice(idx, 1);
    if (musicCurrentIndex === idx) {
        musicCurrentIndex = -1;
        if (musicAudio) { musicAudio.pause(); musicAudio.src = ''; }
        musicIsPlaying = false;
        hideMiniPlayer();
    } else if (musicCurrentIndex > idx) {
        musicCurrentIndex--;
    }
    saveMusicLibrary();
    renderMusicLibraryList();
    showToast('已删除');
}

// --- Share to Chat ---
function shareMusicToChat(idx) {
    const song = musicLibrary[idx];
    if (!song) return;

    // Show chat picker
    let conversations = [];
    if (appSettings.privateChats && Array.isArray(appSettings.privateChats)) {
        appSettings.privateChats.forEach(name => {
            let avatar = '';
            const npc = typeof npcCharacters !== 'undefined' ? npcCharacters.find(n => n.name === name) : null;
            if (npc && npc.avatar) avatar = npc.avatar;
            conversations.push({ tag: `chat:${name}`, name, avatar, isGroup: false });
        });
    }
    if (appSettings.groups && Array.isArray(appSettings.groups)) {
        appSettings.groups.forEach(group => {
            conversations.push({ tag: `group:${group.name}`, name: group.name, avatar: '', isGroup: true });
        });
    }

    if (conversations.length === 0) {
        showToast('还没有聊天，请先创建联系人');
        return;
    }

    const placeholderAvatar = "data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='%23cccccc'%3E%3Cpath d='M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z'/%3E%3C/svg%3E";

    const picker = document.createElement('div');
    picker.id = 'music-share-picker';
    picker.style.cssText = 'position:absolute;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.4);z-index:2000;display:flex;align-items:flex-end;justify-content:center;';
    picker.onclick = (e) => { if (e.target === picker) picker.remove(); };

    picker.innerHTML = `
    <div style="background:#fff;border-radius:14px 14px 0 0;width:100%;max-height:65vh;display:flex;flex-direction:column;padding:18px 16px;animation:slideUpSheet 0.25s ease;">
        <div style="font-size:16px;font-weight:700;color:#1a1a1a;margin-bottom:14px;text-align:center;">分享「${escapeHtml(song.name)}」到聊天</div>
        <div style="flex:1;overflow-y:auto;margin:0 -8px;">
            ${conversations.map(c => `
                <div onclick="confirmMusicShare(${idx}, '${encodeURIComponent(c.tag)}', '${encodeURIComponent(c.name)}')"
                     style="display:flex;align-items:center;gap:12px;padding:12px 8px;cursor:pointer;border-radius:12px;transition:background 0.15s;"
                     onmousedown="this.style.background='#f5f5f5'" onmouseup="this.style.background=''" onmouseleave="this.style.background=''">
                    <img src="${c.avatar || placeholderAvatar}" style="width:40px;height:40px;border-radius:50%;object-fit:cover;background:#f0f0f0;">
                    <div style="flex:1;">
                        <div style="font-size:14px;font-weight:500;color:#1a1a1a;">${escapeHtml(c.name)}</div>
                        <div style="font-size:11px;color:#aaa;">${c.isGroup ? '群聊' : '私聊'}</div>
                    </div>
                </div>
            `).join('')}
        </div>
        <button style="margin-top:12px;width:100%;padding:12px;border:none;background:#f5f5f5;border-radius:10px;font-size:14px;color:#666;cursor:pointer;" onclick="document.getElementById('music-share-picker').remove()">取消</button>
    </div>`;

    const screen = document.getElementById('music-screen');
    if (screen) screen.appendChild(picker);
    else document.getElementById('phone-container').appendChild(picker);
}

function confirmMusicShare(songIdx, chatTagEncoded, chatNameEncoded) {
    const song = musicLibrary[songIdx];
    if (!song) return;

    const picker = document.getElementById('music-share-picker');
    if (picker) picker.remove();

    const chatTag = decodeURIComponent(chatTagEncoded);
    const chatName = decodeURIComponent(chatNameEncoded);
    const t = typeof getTime === 'function' ? getTime(true) : '12:00';
    const u = typeof getUserName === 'function' ? getUserName() : '我';

    const msgBody = song.neteaseId
        ? `${song.name}|${song.artist || '未知歌手'}|${song.neteaseId}|${song.server || 'netease'}|${song.coverUrl || ''}|${song.audioUrl || ''}`
        : `${song.name}|${song.artist || '未知歌手'}`;
    const msgHeader = `[${u}|MUSIC|${t}]`;
    const msgData = { header: msgHeader, body: msgBody, isUser: true, type: 'music' };

    (async () => {
        try {
            let history = await getChatHistory(chatTag) || [];
            history.push(msgData);
            await saveChatHistory(chatTag, history);
        } catch (e) {
            console.error('Failed to share music', e);
        }
    })();

    showToast(`已分享到「${chatName}」的聊天`);
}

// Send music card in current chat directly
function sendMusicToCurrentChat(songIdx) {
    const song = musicLibrary[songIdx !== undefined ? songIdx : musicCurrentIndex];
    if (!song) return;

    const t = typeof getTime === 'function' ? getTime(true) : '12:00';
    const u = typeof getUserName === 'function' ? getUserName() : '我';
    const msgBody = `${song.name}|${song.artist || '未知歌手'}`;
    const msgHeader = `[${u}|MUSIC|${t}]`;

    if (typeof renderMessageToUI === 'function') {
        renderMessageToUI({ header: msgHeader, body: msgBody, isUser: true, type: 'music' });
    }
}

// --- Listen Together ---
function startListenTogether(songName, songArtist) {
    if (!currentChatTarget) {
        showToast('请在聊天中使用一起听功能');
        return;
    }

    musicListenTogether = true;
    musicListenPartner = currentChatTarget;

    // Get partner avatar
    const npc = typeof npcCharacters !== 'undefined' ? npcCharacters.find(n => n.name === currentChatTarget) : null;
    musicListenPartnerAvatar = npc && npc.avatar ? npc.avatar : '';

    // Find the song in library and play it
    const songIdx = musicLibrary.findIndex(s => s.name === songName);
    if (songIdx >= 0 && musicLibrary[songIdx].audioUrl) {
        musicPlaySong(songIdx);
    }

    updateListenTogetherBanner();
    showToast(`正在与${musicListenPartner}一起听歌`);
}

function stopListenTogether() {
    musicListenTogether = false;
    musicListenPartner = '';
    musicListenPartnerAvatar = '';
    const banner = document.getElementById('listen-together-banner');
    if (banner) banner.style.display = 'none';
}

function updateListenTogetherBanner() {
    let banner = document.getElementById('listen-together-banner');
    if (!banner) {
        banner = document.createElement('div');
        banner.id = 'listen-together-banner';
        document.getElementById('phone-container').appendChild(banner);
    }

    if (!musicListenTogether) {
        banner.style.display = 'none';
        return;
    }

    const song = musicLibrary[musicCurrentIndex];
    const songName = song ? song.name : '未知歌曲';
    const userAvatar = appSettings.userAvatar || '';
    const partnerAvatar = musicListenPartnerAvatar || appSettings.charAvatar || '';

    banner.style.display = 'flex';
    banner.innerHTML = `
        <div class="lt-avatars">
            <img src="${userAvatar}" class="lt-avatar" onerror="this.style.display='none'">
            <img src="${partnerAvatar}" class="lt-avatar" onerror="this.style.display='none'">
        </div>
        <div class="lt-info">
            <div class="lt-label">正在与 ${escapeHtml(musicListenPartner)} 一起听</div>
            <div class="lt-song">${escapeHtml(songName)}</div>
        </div>
        <button class="lt-close" onclick="stopListenTogether()">✕</button>
    `;
}

// --- Helpers ---
function formatMusicTime(seconds) {
    if (!seconds || isNaN(seconds)) return '0:00';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
}

function getCurrentMusicSong() {
    if (musicCurrentIndex >= 0 && musicCurrentIndex < musicLibrary.length) {
        return musicLibrary[musicCurrentIndex];
    }
    return null;
}

// --- Dynamic HTML Creation ---
function createMusicScreenHTML() {
    const screen = document.createElement('div');
    screen.id = 'music-screen';
    screen.className = 'app-screen music-app';
    screen.style.display = 'none';

    screen.innerHTML = `
    <!-- Library View -->
    <div id="music-library-view" class="music-view">
        <div class="music-header">
            <button class="music-header-btn" onclick="closeMusicApp()">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="22" height="22"><path d="M15 18l-6-6 6-6"/></svg>
            </button>
            <span class="music-header-title">我的音乐</span>
            <button class="music-header-btn" onclick="openAddSongModal()">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="22" height="22"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            </button>
        </div>
        <div class="music-play-all" onclick="musicPlayAll()">
            <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><path d="M8 5v14l11-7z"/></svg>
            <span>播放全部</span>
            <span class="music-count" id="music-total-count"></span>
        </div>
        <div id="music-song-list" class="music-song-list"></div>
    </div>

    <!-- Player View -->
    <div id="music-player-view" class="music-view music-player" style="display:none;">
        <div id="music-player-bg" class="music-player-bg"></div>
        <div class="music-player-overlay"></div>
        <div class="music-player-header">
            <button class="music-player-header-btn" onclick="showMusicLibraryView()">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="22" height="22"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
            </button>
            <div class="music-player-title-area">
                <div id="music-now-name" class="music-player-song-name">未播放</div>
                <div id="music-now-artist" class="music-player-artist-name">-</div>
            </div>
            <button class="music-player-header-btn" onclick="shareMusicFromPlayer()" title="分享">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
            </button>
        </div>
        <!-- Listen Together Button -->
        <div class="music-listen-together-bar" onclick="listenTogetherFromPlayer()">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
            <span>和TA一起听</span>
        </div>
        <!-- Disc / Lyrics toggle area -->
        <div id="music-disc-area-wrap" class="music-disc-area" onclick="togglePlayerLyricsView()">
            <div id="music-disc" class="music-disc">
                <div class="music-disc-inner">
                    <img id="music-disc-cover" class="music-disc-img" src="" alt="">
                </div>
            </div>
            <div class="music-disc-hint">点击切换歌词</div>
        </div>
        <div id="music-lyrics-area" class="music-lyrics-area" style="display:none;" onclick="togglePlayerLyricsView()">
            <div id="music-lyrics-scroll" class="music-lyrics-scroll"></div>
        </div>
        <div class="music-progress-area">
            <span id="music-current-time" class="music-time">0:00</span>
            <input type="range" id="music-progress-bar" class="music-slider" min="0" max="100" value="0"
                oninput="seekMusic(this.value)"
                onmousedown="this._dragging=true" onmouseup="this._dragging=false"
                ontouchstart="this._dragging=true" ontouchend="this._dragging=false" />
            <span id="music-total-time" class="music-time">0:00</span>
        </div>
        <div class="music-controls">
            <button id="music-mode-btn" class="music-ctrl-btn" onclick="toggleMusicPlayMode()"></button>
            <button class="music-ctrl-btn music-ctrl-prev" onclick="musicPrev()">
                <svg viewBox="0 0 24 24" fill="currentColor" width="28" height="28"><path d="M6 6h2v12H6zm3.5 6l8.5 6V6z"/></svg>
            </button>
            <button id="music-play-btn" class="music-ctrl-btn music-ctrl-play" onclick="toggleMusicPlay()">
                <svg viewBox="0 0 24 24" fill="currentColor" width="32" height="32"><path d="M8 5v14l11-7z"/></svg>
            </button>
            <button class="music-ctrl-btn music-ctrl-next" onclick="musicNext()">
                <svg viewBox="0 0 24 24" fill="currentColor" width="28" height="28"><path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/></svg>
            </button>
            <button class="music-ctrl-btn" onclick="openMusicPlaylist()">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>
            </button>
        </div>
    </div>`;

    document.getElementById('phone-container').appendChild(screen);

    // Floating mini player is created on-demand by showMiniPlayer -> createFloatingMiniPlayer
}

function shareMusicFromPlayer() {
    if (musicCurrentIndex >= 0) {
        shareMusicToChat(musicCurrentIndex);
    } else {
        showToast('当前没有播放歌曲');
    }
}

function openMusicPlaylist() {
    showMusicLibraryView();
}

function listenTogetherFromPlayer() {
    if (musicCurrentIndex < 0) { showToast('请先播放歌曲'); return; }
    const song = musicLibrary[musicCurrentIndex];
    if (!song) return;
    startListenTogether(song.name, song.artist);
}

// --- Chat Rendering: Music Card (vinyl record protruding design) ---
// This is called from renderMessageToUI in 06-chat.js
function createMusicCardHTML(songName, artistName, isUser, coverSrc, songId, server) {
    const cover = coverSrc || generateMusicCover(songName);
    const platform = server === 'netease' ? '网易云音乐' : '音乐';
    const dataAttrs = songId ? `data-song-id="${songId}" data-server="${server || 'netease'}"` : '';
    return `
    <div class="music-card-v2" ${dataAttrs}>
        <div class="mc2-body">
            <div class="mc2-name">${escapeHtml(songName)}</div>
            <div class="mc2-artist">${escapeHtml(artistName || '未知歌手')}</div>
            <div class="mc2-footer">
                <svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55C7.79 13 6 14.79 6 17s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>
                <span>${platform}</span>
            </div>
        </div>
        <div class="mc2-disc-area">
            <div class="mc2-disc">
                <div class="mc2-disc-inner">
                    <img src="${cover}" alt="" crossorigin="anonymous">
                </div>
            </div>
        </div>
    </div>`;
}

// Play from a music card element (handles both legacy and API cards)
function playMusicCardFromEl(cardEl) {
    const songId = cardEl.querySelector('.music-card-v2')?.dataset?.songId;
    const server = cardEl.querySelector('.music-card-v2')?.dataset?.server || 'netease';
    if (songId) {
        playMusicFromAPI(songId, server);
    } else {
        // Legacy: try by name
        const rawBody = cardEl.dataset.rawBody || '';
        const parts = rawBody.split('|');
        const songName = parts[0] || '';
        const songArtist = parts[1] || '';
        playMusicFromCard(songName, songArtist);
    }
}

// Play or start listen-together from a music card in chat
function playMusicFromCard(songName, songArtist) {
    loadMusicLibrary();
    const idx = musicLibrary.findIndex(s => s.name === songName);
    if (idx >= 0) {
        if (musicLibrary[idx].audioUrl) {
            musicPlaySong(idx);
            showToast('正在播放: ' + songName);
        } else {
            showToast('此歌曲无音频URL');
        }
    } else {
        showToast('歌曲不在音乐库中');
    }
}

function listenTogetherFromCard(songName, songArtist) {
    loadMusicLibrary();
    startListenTogether(songName, songArtist);
}

// --- Expose music functions to global scope for inline onclick handlers ---
window.toggleMusicPlay = toggleMusicPlay;
window.musicPrev = musicPrev;
window.musicNext = musicNext;
window.musicCyclePlayMode = musicCyclePlayMode;
window.toggleMusicPlayMode = toggleMusicPlayMode;
window.openMusicApp = openMusicApp;
window.closeMiniPlayer = closeMiniPlayer;
window.seekMusic = seekMusic;
window.musicPlaySong = musicPlaySong;
window.shareMusicToChat = shareMusicToChat;
window.shareMusicFromPlayer = shareMusicFromPlayer;
window.confirmMusicShare = confirmMusicShare;
window.handleMusicLinkInput = handleMusicLinkInput;
window.playMusicFromCard = playMusicFromCard;
window.playMusicCardFromEl = playMusicCardFromEl;
window.playMusicFromAPI = playMusicFromAPI;
window.listenTogetherFromCard = listenTogetherFromCard;
window.musicAddFromLink = musicAddFromLink;
window.openAddSongModal = openAddSongModal;
window.confirmAddSong = confirmAddSong;
window.musicAddUploadAudio = musicAddUploadAudio;
window.musicAddUploadCover = musicAddUploadCover;
window.musicAddUploadLRC = musicAddUploadLRC;
window.openEditSongModal = openEditSongModal;
window.confirmEditSong = confirmEditSong;
window.musicEditUploadLRC = musicEditUploadLRC;
window.musicEditUploadFile = musicEditUploadFile;
window.musicEditUploadCover = musicEditUploadCover;
window.openMusicSongMenu = openMusicSongMenu;
window.closeMusicMenu = closeMusicMenu;
window.deleteMusicSong = deleteMusicSong;
window.showMusicLibraryView = showMusicLibraryView;
window.showMusicPlayerView = showMusicPlayerView;
window.closeMusicApp = closeMusicApp;
window.musicPlayAll = musicPlayAll;
window.musicPlayRandom = musicPlayRandom;
window.renderMusicLibraryList = renderMusicLibraryList;
window.togglePlayerLyricsView = togglePlayerLyricsView;
window.sendMusicToCurrentChat = sendMusicToCurrentChat;
window.startListenTogether = startListenTogether;
window.stopListenTogether = stopListenTogether;

// ========== Pomodoro Timer Module ==========

// --- State ---
let pomodoroState = 'idle'; // idle | focus | shortBreak | longBreak | paused
let pomodoroTimeLeft = 25 * 60;
let pomodoroTotalTime = 25 * 60;
let pomodoroTimer = null;
let pomodoroCompletedCount = 0;
let pomodoroTotalCompleted = 0;
let pomodoroCurrentTask = '';
let pomodoroMode = 'study'; // 'study' or 'exercise'
let pomodoroPausedState = 'focus';
let pomodoroTaskList = [];
let pomodoroHistory = [];
let pomodoroSessions = []; // Array of { task, mode, duration, elapsed, status, timestamp, aiCharName }
let pomodoroAILines = null; // { start:'', complete:'', give_up:'' } - pre-generated
let pomodoroSettings = {
    focusDuration: 25,
    shortBreakDuration: 5,
    longBreakDuration: 15,
    longBreakInterval: 4,
    exerciseDuration: 30,
    exerciseBreakDuration: 10,
    autoStartBreak: true,
    autoStartFocus: false,
    aiEncourage: true,
    aiCharTag: '',
    aiAvatar: '',       // base64 or URL for the companion avatar
    notifySound: true
};

const POMO_STORAGE_KEY = 'faye-phone-pomodoro';
const POMO_HISTORY_KEY = 'faye-phone-pomodoro-history';
const POMO_TASKS_KEY = 'faye-phone-pomodoro-tasks';
const POMO_SETTINGS_KEY = 'faye-phone-pomodoro-settings';
const POMO_SESSIONS_KEY = 'faye-phone-pomodoro-sessions';

// --- Storage ---
function loadPomodoroData() {
    try {
        const saved = localStorage.getItem(POMO_STORAGE_KEY);
        if (saved) {
            const data = JSON.parse(saved);
            pomodoroTotalCompleted = data.totalCompleted || 0;
            pomodoroCompletedCount = data.sessionCompleted || 0;
        }
    } catch (e) { console.error('[Pomodoro] Load error:', e); }
    try {
        const hist = localStorage.getItem(POMO_HISTORY_KEY);
        if (hist) pomodoroHistory = JSON.parse(hist);
    } catch (e) { pomodoroHistory = []; }
    try {
        const tasks = localStorage.getItem(POMO_TASKS_KEY);
        if (tasks) pomodoroTaskList = JSON.parse(tasks);
    } catch (e) { pomodoroTaskList = []; }
    try {
        const sessions = localStorage.getItem(POMO_SESSIONS_KEY);
        if (sessions) pomodoroSessions = JSON.parse(sessions);
    } catch (e) { pomodoroSessions = []; }
    try {
        const settings = localStorage.getItem(POMO_SETTINGS_KEY);
        if (settings) Object.assign(pomodoroSettings, JSON.parse(settings));
    } catch (e) { /* use defaults */ }
}

function savePomodoroData() {
    try {
        localStorage.setItem(POMO_STORAGE_KEY, JSON.stringify({
            totalCompleted: pomodoroTotalCompleted,
            sessionCompleted: pomodoroCompletedCount
        }));
    } catch (e) { console.error('[Pomodoro] Save error:', e); }
}
function savePomodoroHistory() { try { localStorage.setItem(POMO_HISTORY_KEY, JSON.stringify(pomodoroHistory)); } catch (e) { } }
function savePomodoroTasks() { try { localStorage.setItem(POMO_TASKS_KEY, JSON.stringify(pomodoroTaskList)); } catch (e) { } }
function savePomodoroSessions() { try { localStorage.setItem(POMO_SESSIONS_KEY, JSON.stringify(pomodoroSessions)); } catch (e) { } }
function savePomodoroSettings() { try { localStorage.setItem(POMO_SETTINGS_KEY, JSON.stringify(pomodoroSettings)); } catch (e) { } }

// --- Helpers ---
function getPomoFocusDuration() {
    return pomodoroMode === 'exercise' ? pomodoroSettings.exerciseDuration : pomodoroSettings.focusDuration;
}
function getPomoBreakDuration(isLong) {
    if (pomodoroMode === 'exercise') return pomodoroSettings.exerciseBreakDuration;
    return isLong ? pomodoroSettings.longBreakDuration : pomodoroSettings.shortBreakDuration;
}
function getPomoModeLabel() { return pomodoroMode === 'exercise' ? '运动' : '学习'; }

// --- AI: Pre-generate all lines at start ---
let _pomoAIGenerating = false;
async function preGenerateAILines(task) {
    if (_pomoAIGenerating) return;
    _pomoAIGenerating = true;
    pomodoroAILines = null;
    if (!pomodoroSettings.aiEncourage) { _pomoAIGenerating = false; return; }
    if (!appSettings.apiKey || !appSettings.apiEndpoint) { _pomoAIGenerating = false; return; }

    let charName = '';
    let chatTag = pomodoroSettings.aiCharTag;
    if (!chatTag) {
        const chats = appSettings.privateChats || [];
        if (chats.length > 0) { charName = chats[0]; chatTag = `chat:${charName}`; }
    } else { charName = chatTag.replace(/^chat:/, ''); }
    if (!charName) return;

    const npc = (typeof npcCharacters !== 'undefined' && Array.isArray(npcCharacters))
        ? npcCharacters.find(n => n.name === charName) : null;
    let persona = '';
    if (npc) {
        persona = npc.persona || npc.desc || '';
        if (npc.personality) persona += `\n性格: ${npc.personality}`;
        if (persona.length > 300) persona = persona.substring(0, 300);
    }

    // Load chat memories for this character (one-way: chat → pomodoro)
    let memorySnippet = '';
    try {
        const memKey = `faye-phone-memory-chat:${charName}`;
        const memData = localStorage.getItem(memKey);
        if (memData) {
            const mems = JSON.parse(memData);
            const enabled = mems.filter(m => m.enabled !== false).slice(0, 5);
            if (enabled.length > 0) {
                memorySnippet = '\n\n你与用户之间的相关记忆：\n';
                enabled.forEach(m => {
                    memorySnippet += `- ${(m.content || '').substring(0, 100)}\n`;
                });
            }
        }
    } catch (e) { console.warn('[Pomodoro] Memory load failed:', e); }

    const userNameStr = typeof getUserName === 'function' ? getUserName() : 'User';
    const modeLabel = getPomoModeLabel();
    const duration = getPomoFocusDuration();

    const prompt = `你是 ${charName}。${persona ? '你的人设：\n' + persona : ''}${memorySnippet}

${userNameStr}要开始${modeLabel}计时了，任务是「${task}」，时长${duration}分钟。

请你一次性生成五句话，分别用在以下五个场景：
1. [开始] 当ta开始${modeLabel}时，给予鼓励打气
2. [进行1/3] 当ta完成约${Math.round(duration / 3)}分钟时，给予鼓励
3. [进行2/3] 当ta完成约${Math.round(duration * 2 / 3)}分钟时，给予鼓励和加油
4. [完成] 当ta完成${duration}分钟${modeLabel}时，给予热情表扬
5. [放弃] 当ta中途放弃时，温和安慰鼓励不责备

要求：
- 每句10-30字，简短自然
- 符合你的人设性格
- 态度积极
- 严格按以下JSON格式输出，不要多余文字：
{"start":"开始的话","one_third":"1/3时的话","two_thirds":"2/3时的话","complete":"完成的话","give_up":"放弃的话"}`;

    try {
        const response = await fetch(`${appSettings.apiEndpoint}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${appSettings.apiKey}` },
            body: JSON.stringify({
                model: appSettings.apiModel || 'gpt-3.5-turbo',
                messages: [{ role: 'user', content: prompt }],
                temperature: 1.0, max_tokens: 300
            })
        });
        const data = await response.json();
        let content = data.choices?.[0]?.message?.content || '';
        // Extract JSON
        const match = content.match(/\{[\s\S]*\}/);
        if (match) {
            const parsed = JSON.parse(match[0]);
            if (parsed.start && parsed.complete && parsed.give_up) {
                pomodoroAILines = { ...parsed, charName };
                console.log('[Pomodoro AI] Pre-generated lines:', pomodoroAILines);
            }
        }
    } catch (err) {
        console.warn('[Pomodoro AI] Pre-gen failed:', err);
    } finally {
        _pomoAIGenerating = false;
    }
}

function showPomoCompanionMessage(event) {
    if (!pomodoroAILines) return;
    const msg = pomodoroAILines[event];
    if (!msg) return;

    const msgList = document.getElementById('pomo-companion-messages');
    if (!msgList) return;

    // Append a new bubble
    const bubble = document.createElement('div');
    bubble.className = 'pomo-companion-bubble pomo-bubble-animate';
    bubble.textContent = msg;
    msgList.appendChild(bubble);
    // Scroll to bottom
    msgList.scrollTop = msgList.scrollHeight;
}

function hidePomoCompanionMessage() {
    const msgList = document.getElementById('pomo-companion-messages');
    if (msgList) msgList.innerHTML = '';
}

// --- Timer Core ---
function startPomodoro(task) {
    if (pomodoroState === 'focus' || pomodoroState === 'shortBreak' || pomodoroState === 'longBreak') return;
    pomodoroCurrentTask = task || pomodoroCurrentTask || (pomodoroMode === 'exercise' ? '运动锻炼' : '专注学习');
    pomodoroState = 'focus';
    pomodoroTotalTime = getPomoFocusDuration() * 60;
    pomodoroTimeLeft = pomodoroTotalTime;

    pomoTrackStart();
    startPomodoroTick();
    renderPomodoroUI();

    // Pre-generate AI lines & show start message
    if (pomodoroSettings.aiEncourage) {
        preGenerateAILines(pomodoroCurrentTask).then(() => {
            showPomoCompanionMessage('start');
        });
    }
}

function startBreak(isLong) {
    pomodoroState = isLong ? 'longBreak' : 'shortBreak';
    const duration = getPomoBreakDuration(isLong);
    pomodoroTotalTime = duration * 60;
    pomodoroTimeLeft = pomodoroTotalTime;
    startPomodoroTick();
    renderPomodoroUI();
    hidePomoCompanionMessage();
}

function pausePomodoro() {
    if (pomodoroState === 'idle' || pomodoroState === 'paused') return;
    pomodoroPausedState = pomodoroState;
    clearInterval(pomodoroTimer);
    pomodoroTimer = null;
    pomodoroState = 'paused';
    renderPomodoroUI();
}

function resumePomodoro() {
    if (pomodoroState !== 'paused') return;
    pomodoroState = pomodoroPausedState || 'focus';
    startPomodoroTick();
    renderPomodoroUI();
}

function stopPomodoro() {
    clearInterval(pomodoroTimer);
    pomodoroTimer = null;
    pomodoroState = 'idle';
    pomodoroTimeLeft = getPomoFocusDuration() * 60;
    pomodoroTotalTime = pomodoroTimeLeft;
    pomodoroCurrentTask = '';
    pomodoroAILines = null;
    renderPomodoroUI();
    hidePomoCompanionMessage();
}

let pomoMilestonesShown = { one_third: false, two_thirds: false };

function startPomodoroTick() {
    clearInterval(pomodoroTimer);
    pomoMilestonesShown = { one_third: false, two_thirds: false };
    pomodoroTimer = setInterval(() => {
        pomodoroTimeLeft--;
        if (pomodoroTimeLeft <= 0) {
            clearInterval(pomodoroTimer);
            pomodoroTimer = null;
            onTimerComplete();
        } else if (pomodoroState === 'focus' && pomodoroAILines) {
            // Check milestones
            const elapsed = pomodoroTotalTime - pomodoroTimeLeft;
            const oneThird = Math.round(pomodoroTotalTime / 3);
            const twoThirds = Math.round(pomodoroTotalTime * 2 / 3);
            if (!pomoMilestonesShown.one_third && elapsed >= oneThird) {
                pomoMilestonesShown.one_third = true;
                showPomoCompanionMessage('one_third');
                if (!pomoShareState.shownAIEvents.includes('one_third')) pomoShareState.shownAIEvents.push('one_third');
            }
            if (!pomoMilestonesShown.two_thirds && elapsed >= twoThirds) {
                pomoMilestonesShown.two_thirds = true;
                showPomoCompanionMessage('two_thirds');
                if (!pomoShareState.shownAIEvents.includes('two_thirds')) pomoShareState.shownAIEvents.push('two_thirds');
            }
        }
        updatePomodoroDisplay();
    }, 1000);
}

function onTimerComplete() {
    if (pomodoroState === 'focus') {
        pomodoroCompletedCount++;
        pomodoroTotalCompleted++;
        savePomodoroData();
        recordPomodoroComplete();
        recordPomodoroSession('completed');

        if (pomodoroCurrentTask) {
            const task = pomodoroTaskList.find(t => t.name === pomodoroCurrentTask);
            if (task) { task.completed = (task.completed || 0) + 1; savePomodoroTasks(); }
        }

        if (pomodoroSettings.notifySound) playPomodoroSound('complete');
        if (navigator.vibrate) navigator.vibrate([200, 100, 200]);

        // Show pre-generated complete message
        pomoTrackComplete();
        showPomoCompanionMessage('complete');
        showPomodoroCompleteModal();

        if (pomodoroSettings.autoStartBreak) {
            const isLong = pomodoroMode === 'study' && pomodoroCompletedCount % pomodoroSettings.longBreakInterval === 0;
            setTimeout(() => startBreak(isLong), 2000);
        } else {
            pomodoroState = 'idle';
            renderPomodoroUI();
        }
    } else if (pomodoroState === 'shortBreak' || pomodoroState === 'longBreak') {
        if (pomodoroSettings.notifySound) playPomodoroSound('break');
        if (navigator.vibrate) navigator.vibrate([100, 50, 100]);
        if (pomodoroSettings.autoStartFocus) {
            startPomodoro(pomodoroCurrentTask);
        } else {
            pomodoroState = 'idle';
            renderPomodoroUI();
        }
    }
}

function recordPomodoroComplete() {
    const today = new Date().toISOString().split('T')[0];
    let todayRecord = pomodoroHistory.find(h => h.date === today);
    if (!todayRecord) {
        todayRecord = { date: today, count: 0, totalMinutes: 0, tasks: [] };
        pomodoroHistory.push(todayRecord);
    }
    todayRecord.count++;
    todayRecord.totalMinutes += getPomoFocusDuration();
    if (pomodoroCurrentTask && !todayRecord.tasks.includes(pomodoroCurrentTask)) {
        todayRecord.tasks.push(pomodoroCurrentTask);
    }
    if (pomodoroHistory.length > 30) pomodoroHistory = pomodoroHistory.slice(-30);
    savePomodoroHistory();
}

// --- Sound ---
function playPomodoroSound(type) {
    try {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        const ctx = new AudioCtx();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain); gain.connect(ctx.destination);
        if (type === 'complete') {
            osc.frequency.setValueAtTime(523, ctx.currentTime);
            osc.frequency.setValueAtTime(659, ctx.currentTime + 0.15);
            osc.frequency.setValueAtTime(784, ctx.currentTime + 0.3);
            gain.gain.setValueAtTime(0.3, ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.6);
            osc.start(ctx.currentTime); osc.stop(ctx.currentTime + 0.6);
        } else {
            osc.frequency.setValueAtTime(440, ctx.currentTime);
            osc.frequency.setValueAtTime(523, ctx.currentTime + 0.2);
            gain.gain.setValueAtTime(0.2, ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.4);
            osc.start(ctx.currentTime); osc.stop(ctx.currentTime + 0.4);
        }
    } catch (e) { }
}

// --- Completion Modal ---
function showPomodoroCompleteModal() {
    const existing = document.getElementById('pomo-complete-modal');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'pomo-complete-modal';
    overlay.className = 'pomo-complete-overlay';
    const minutes = getPomoFocusDuration();
    const label = pomodoroMode === 'exercise' ? '运动完成' : '专注完成';
    const unitLabel = pomodoroMode === 'exercise' ? '今日运动' : '今日完成';

    overlay.innerHTML = `
        <div class="pomo-complete-card">
            <div class="pomo-complete-title">${label}</div>
            <div class="pomo-complete-subtitle">已坚持 ${minutes} 分钟</div>
            <div class="pomo-complete-stats">
                <div class="pomo-complete-stat">
                    <span class="pomo-stat-num">${pomodoroCompletedCount}</span>
                    <span class="pomo-stat-label">${unitLabel}</span>
                </div>
                <div class="pomo-complete-stat">
                    <span class="pomo-stat-num">${pomodoroTotalCompleted}</span>
                    <span class="pomo-stat-label">累计完成</span>
                </div>
            </div>
            <div class="pomo-complete-task">${escapeHtml(pomodoroCurrentTask)}</div>
            <div style="display:flex;gap:10px;justify-content:center;margin-top:10px;">
                <button class="pomo-complete-btn" onclick="closePomodoroCompleteModal()" style="flex:1;">继续</button>
                <button class="pomo-complete-btn" onclick="closePomodoroCompleteModal();sharePomoStatus()" style="flex:1;background:#f5f5f5;color:#333;">分享</button>
            </div>
        </div>
    `;
    overlay.onclick = (e) => { if (e.target === overlay) closePomodoroCompleteModal(); };
    const screen = document.getElementById('pomodoro-screen');
    if (screen) screen.appendChild(overlay);
    else document.getElementById('phone-container').appendChild(overlay);
}

function closePomodoroCompleteModal() {
    const modal = document.getElementById('pomo-complete-modal');
    if (modal) { modal.style.opacity = '0'; setTimeout(() => modal.remove(), 300); }
}

// --- Display Update ---
function updatePomodoroDisplay() {
    const timerText = document.getElementById('pomo-timer-text');
    const progressRing = document.getElementById('pomo-progress-ring');
    if (timerText) {
        const mins = Math.floor(pomodoroTimeLeft / 60);
        const secs = pomodoroTimeLeft % 60;
        timerText.textContent = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    if (progressRing) {
        const circumference = 2 * Math.PI * 120;
        const progress = pomodoroTotalTime > 0 ? (pomodoroTotalTime - pomodoroTimeLeft) / pomodoroTotalTime : 0;
        progressRing.style.strokeDashoffset = circumference * (1 - progress);
    }
}

// --- Mode Switch ---
function switchPomodoroMode(mode) {
    if (pomodoroState !== 'idle') {
        if (typeof showToast === 'function') showToast('请先停止当前计时');
        return;
    }
    pomodoroMode = mode;
    pomodoroTimeLeft = getPomoFocusDuration() * 60;
    pomodoroTotalTime = pomodoroTimeLeft;
    pomodoroCurrentTask = '';
    renderPomodoroUI();
}

// --- Get companion info ---
function getPomoCompanionAvatar() {
    if (pomodoroSettings.aiAvatar) return pomodoroSettings.aiAvatar;
    // Fallback: try to find avatar from character
    let charName = '';
    const chatTag = pomodoroSettings.aiCharTag;
    if (chatTag) charName = chatTag.replace(/^chat:/, '');
    else {
        const chats = appSettings.privateChats || [];
        if (chats.length > 0) charName = chats[0];
    }
    if (charName && typeof npcCharacters !== 'undefined' && Array.isArray(npcCharacters)) {
        const npc = npcCharacters.find(n => n.name === charName);
        if (npc && npc.avatar) return npc.avatar;
    }
    return '';
}

function getPomoCompanionName() {
    let charName = '';
    const chatTag = pomodoroSettings.aiCharTag;
    if (chatTag) charName = chatTag.replace(/^chat:/, '');
    else {
        const chats = appSettings.privateChats || [];
        if (chats.length > 0) charName = chats[0];
    }
    return charName || '';
}

// --- UI Rendering ---
function renderPomodoroUI() {
    const mainArea = document.getElementById('pomo-main-area');
    if (!mainArea) return;

    const isPaused = pomodoroState === 'paused';
    const isIdle = pomodoroState === 'idle';

    let stateLabel = pomodoroMode === 'exercise' ? '准备运动' : '准备专注';
    if (pomodoroState === 'focus') stateLabel = pomodoroMode === 'exercise' ? '运动中' : '专注中';
    else if (pomodoroState === 'shortBreak') stateLabel = '短休息';
    else if (pomodoroState === 'longBreak') stateLabel = '长休息';
    else if (pomodoroState === 'paused') stateLabel = '已暂停';

    const stateColor = (pomodoroState === 'focus') ? '#333' : '#999';

    const circumference = 2 * Math.PI * 120;
    const progress = pomodoroTotalTime > 0 ? (pomodoroTotalTime - pomodoroTimeLeft) / pomodoroTotalTime : 0;
    const offset = circumference * (1 - progress);

    const mins = Math.floor(pomodoroTimeLeft / 60);
    const secs = pomodoroTimeLeft % 60;
    const timeStr = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;

    const dotCount = pomodoroMode === 'exercise' ? 4 : pomodoroSettings.longBreakInterval;
    let dotsHtml = '';
    for (let i = 0; i < dotCount; i++) {
        const filled = i < (pomodoroCompletedCount % dotCount);
        dotsHtml += `<span class="pomo-dot ${filled ? 'filled' : ''}"></span>`;
    }

    // Companion area
    const avatar = getPomoCompanionAvatar();
    const companionName = getPomoCompanionName();
    const showCompanion = pomodoroSettings.aiEncourage && (avatar || companionName);

    const companionHtml = showCompanion ? `
        <div class="pomo-companion-area" id="pomo-companion-area">
            <div class="pomo-companion-avatar-wrap" onclick="uploadPomoAvatar()">
                ${avatar
            ? `<img class="pomo-companion-avatar" src="${avatar}" alt="" />`
            : `<div class="pomo-companion-avatar-placeholder">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="28" height="28"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                           </div>`
        }
            </div>
            <div class="pomo-companion-messages" id="pomo-companion-messages">
                ${isIdle ? '<div class="pomo-companion-bubble">点击开始，我陪你一起</div>' : ''}
            </div>
        </div>
    ` : `<div class="pomo-companion-area" id="pomo-companion-area" style="flex:1;"></div>`;

    mainArea.innerHTML = `
        <div class="pomo-mode-toggle">
            <button class="pomo-mode-btn ${pomodoroMode === 'study' ? 'active' : ''}" onclick="switchPomodoroMode('study')">学习</button>
            <button class="pomo-mode-btn ${pomodoroMode === 'exercise' ? 'active' : ''}" onclick="switchPomodoroMode('exercise')">运动</button>
        </div>

        <div class="pomo-timer-section">
            <div class="pomo-state-label">${stateLabel}</div>
            <div class="pomo-ring-container">
                <svg class="pomo-ring-svg" viewBox="0 0 260 260">
                    <circle class="pomo-ring-bg" cx="130" cy="130" r="120" />
                    <circle id="pomo-progress-ring" class="pomo-ring-progress" cx="130" cy="130" r="120"
                        style="stroke: ${stateColor}; stroke-dasharray: ${circumference}; stroke-dashoffset: ${offset};
                        transform: rotate(-90deg); transform-origin: center;" />
                </svg>
                <div class="pomo-ring-inner">
                    <div id="pomo-timer-text" class="pomo-timer-text">${timeStr}</div>
                    ${pomodoroCurrentTask ? `<div class="pomo-current-task">${escapeHtml(pomodoroCurrentTask)}</div>` : ''}
                </div>
            </div>
            <div class="pomo-dots">${dotsHtml}</div>
            <div class="pomo-controls">
                ${isIdle ? `
                    <button class="pomo-btn pomo-btn-start" onclick="openPomodoroStartModal()">
                        <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><path d="M8 5v14l11-7z"/></svg>
                        ${pomodoroMode === 'exercise' ? '开始运动' : '开始专注'}
                    </button>
                ` : isPaused ? `
                    <button class="pomo-btn pomo-btn-resume" onclick="resumePomodoro()">继续</button>
                    <button class="pomo-btn pomo-btn-stop" onclick="giveUpPomodoro()">放弃</button>
                    <button class="pomo-btn pomo-btn-share" onclick="sharePomoStatus()" title="分享"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg></button>
                ` : `
                    <button class="pomo-btn pomo-btn-pause" onclick="pausePomodoro()">暂停</button>
                    <button class="pomo-btn pomo-btn-stop" onclick="giveUpPomodoro()">放弃</button>
                    <button class="pomo-btn pomo-btn-share" onclick="sharePomoStatus()" title="分享"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg></button>
                `}
            </div>
        </div>

        ${companionHtml}

        <div class="pomo-session-stats">
            <div class="pomo-session-item">
                <span class="pomo-session-num">${pomodoroCompletedCount}</span>
                <span class="pomo-session-label">今日</span>
            </div>
            <div class="pomo-session-divider"></div>
            <div class="pomo-session-item">
                <span class="pomo-session-num">${pomodoroTotalCompleted}</span>
                <span class="pomo-session-label">累计</span>
            </div>
            <div class="pomo-session-divider"></div>
            <div class="pomo-session-item">
                <span class="pomo-session-num">${pomodoroCompletedCount * getPomoFocusDuration()}</span>
                <span class="pomo-session-label">分钟</span>
            </div>
        </div>
    `;
}

function giveUpPomodoro() {
    if (pomodoroState === 'focus' || pomodoroState === 'paused') {
        pomoTrackGiveUp();
        recordPomodoroSession('given_up');
        showPomoCompanionMessage('give_up');
        showPomodoroGiveUpModal();
        // Delay stop so user can see give_up message
        setTimeout(() => stopPomodoro(), 2000);
        return;
    }
    stopPomodoro();
}

function showPomodoroGiveUpModal() {
    const existing = document.getElementById('pomo-giveup-modal');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'pomo-giveup-modal';
    overlay.className = 'pomo-complete-overlay';
    const totalDur = getPomoFocusDuration();
    const elapsedSec = totalDur * 60 - pomodoroTimeLeft;
    const elapsedMin = Math.floor(elapsedSec / 60);
    const modeLabel = pomodoroMode === 'exercise' ? '运动' : '专注';

    overlay.innerHTML = `
        <div class="pomo-complete-card">
            <div class="pomo-complete-title" style="color:#999;">已放弃</div>
            <div class="pomo-complete-subtitle">已${modeLabel} ${elapsedMin} / ${totalDur} 分钟</div>
            <div class="pomo-complete-task">${escapeHtml(pomodoroCurrentTask)}</div>
            <div style="display:flex;gap:10px;justify-content:center;margin-top:10px;">
                <button class="pomo-complete-btn" onclick="closePomodoroGiveUpModal()" style="flex:1;">确认</button>
                <button class="pomo-complete-btn" onclick="closePomodoroGiveUpModal();sharePomoStatus()" style="flex:1;background:#f5f5f5;color:#333;">分享</button>
            </div>
        </div>
    `;
    overlay.onclick = (e) => { if (e.target === overlay) closePomodoroGiveUpModal(); };
    const screen = document.getElementById('pomodoro-screen');
    if (screen) screen.appendChild(overlay);
}

function closePomodoroGiveUpModal() {
    const modal = document.getElementById('pomo-giveup-modal');
    if (modal) { modal.style.opacity = '0'; setTimeout(() => modal.remove(), 300); }
}

// --- Avatar Upload ---
function uploadPomoAvatar() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (ev) => {
            pomodoroSettings.aiAvatar = ev.target.result;
            savePomodoroSettings();
            renderPomodoroUI();
        };
        reader.readAsDataURL(file);
    };
    input.click();
}

// --- Start Modal ---
function openPomodoroStartModal() {
    const existing = document.getElementById('pomo-start-modal');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'pomo-start-modal';
    overlay.className = 'modal-overlay show';
    overlay.style.cssText = 'position:absolute;top:0;left:0;right:0;bottom:0;z-index:2000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.35);backdrop-filter:blur(4px);';
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

    let taskOptionsHtml = '';
    pomodoroTaskList.filter(t => (t.mode || 'study') === pomodoroMode).forEach(task => {
        taskOptionsHtml += `<div class="pomo-task-option" onclick="selectPomodoroTask(this, '${escapeHtml(task.name)}')">${escapeHtml(task.name)}</div>`;
    });

    const isExercise = pomodoroMode === 'exercise';
    const titleText = isExercise ? '开始运动' : '开始专注';
    const taskLabel = isExercise ? '运动项目' : '专注任务';
    const taskPlaceholder = isExercise ? '如：跑步、瑜伽、力量训练...' : '输入你要做的事...';
    const currentDuration = getPomoFocusDuration();

    overlay.innerHTML = `
    <div class="modal-box group-modal-cute" style="width:300px;">
        <div class="modal-title group-modal-title" style="margin-top:0;font-size:17px;">${titleText}</div>
        <div class="group-modal-field">
            <label class="group-modal-label">${taskLabel}</label>
            <input class="group-modal-input" id="pomo-task-input" placeholder="${taskPlaceholder}" value="${escapeHtml(pomodoroCurrentTask)}" />
        </div>
        ${taskOptionsHtml ? `<div class="pomo-task-options">${taskOptionsHtml}</div>` : ''}
        <div class="group-modal-field">
            <label class="group-modal-label">时长 (分钟)</label>
            <input type="number" class="group-modal-input" id="pomo-duration-input" value="${currentDuration}" min="1" max="240" style="width:100%;text-align:center;" />
        </div>
        <div class="modal-actions" style="margin-top:12px;gap:10px;">
            <button class="modal-btn group-modal-cancel" onclick="document.getElementById('pomo-start-modal').remove()">取消</button>
            <button class="modal-btn group-modal-confirm" onclick="confirmStartPomodoro()">${isExercise ? '开始运动' : '开始专注'}</button>
        </div>
    </div>`;

    const screen = document.getElementById('pomodoro-screen');
    if (screen) screen.appendChild(overlay);
}

function selectPomodoroTask(el, taskName) {
    const input = document.getElementById('pomo-task-input');
    if (input) input.value = taskName;
    document.querySelectorAll('.pomo-task-option').forEach(o => o.classList.remove('selected'));
    el.classList.add('selected');
}

function setPomoDuration(mins) {
    if (pomodoroMode === 'exercise') pomodoroSettings.exerciseDuration = mins;
    else pomodoroSettings.focusDuration = mins;
    pomodoroTimeLeft = mins * 60;
    pomodoroTotalTime = mins * 60;
    savePomodoroSettings();
}

function confirmStartPomodoro() {
    const input = document.getElementById('pomo-task-input');
    const task = input ? input.value.trim() : '';
    const durInput = document.getElementById('pomo-duration-input');
    if (durInput) {
        const mins = parseInt(durInput.value) || getPomoFocusDuration();
        setPomoDuration(Math.max(1, Math.min(240, mins)));
    }
    if (task) {
        if (!pomodoroTaskList.find(t => t.name === task && (t.mode || 'study') === pomodoroMode)) {
            pomodoroTaskList.push({ name: task, completed: 0, mode: pomodoroMode, createdAt: Date.now() });
            savePomodoroTasks();
        }
    }
    const modal = document.getElementById('pomo-start-modal');
    if (modal) modal.remove();
    startPomodoro(task);
}

// --- Tasks View ---
function renderPomodoroTasks() {
    const container = document.getElementById('pomo-tasks-body');
    if (!container) return;

    const studyTasks = pomodoroTaskList.filter(t => (t.mode || 'study') === 'study');
    const exerciseTasks = pomodoroTaskList.filter(t => t.mode === 'exercise');

    if (pomodoroTaskList.length === 0) {
        container.innerHTML = `<div class="pomo-empty-state"><div style="font-size:14px;color:#999;">还没有任务<br>开始计时时会自动添加</div></div>`;
        return;
    }

    let html = '';
    if (studyTasks.length > 0) {
        html += `<div class="pomo-task-section-title">学习任务</div>`;
        studyTasks.forEach(task => { html += renderTaskItem(task, pomodoroTaskList.indexOf(task)); });
    }
    if (exerciseTasks.length > 0) {
        html += `<div class="pomo-task-section-title" style="margin-top:16px;">运动项目</div>`;
        exerciseTasks.forEach(task => { html += renderTaskItem(task, pomodoroTaskList.indexOf(task)); });
    }
    container.innerHTML = html;
}

function renderTaskItem(task, idx) {
    const unitLabel = task.mode === 'exercise' ? '组' : '个';
    return `
    <div class="pomo-task-item">
        <div class="pomo-task-info">
            <div class="pomo-task-name">${escapeHtml(task.name)}</div>
            <div class="pomo-task-count">已完成 ${task.completed || 0} ${unitLabel}</div>
        </div>
        <div class="pomo-task-actions">
            <button class="pomo-task-action-btn" onclick="quickStartTask('${escapeHtml(task.name)}', '${task.mode || 'study'}')" title="开始">
                <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M8 5v14l11-7z"/></svg>
            </button>
            <button class="pomo-task-action-btn delete" onclick="deletePomodoroTask(${idx})" title="删除">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M18 6L6 18M6 6l12 12"/></svg>
            </button>
        </div>
    </div>`;
}

function quickStartTask(taskName, mode) {
    if (mode && mode !== pomodoroMode) {
        pomodoroMode = mode;
        pomodoroTimeLeft = getPomoFocusDuration() * 60;
        pomodoroTotalTime = pomodoroTimeLeft;
    }
    switchPomodoroTab('timer');
    setTimeout(() => startPomodoro(taskName), 100);
}

function deletePomodoroTask(idx) {
    pomodoroTaskList.splice(idx, 1);
    savePomodoroTasks();
    renderPomodoroTasks();
}

// --- Statistics View ---
function renderPomodoroStats() {
    const container = document.getElementById('pomo-stats-body');
    if (!container) return;

    const today = new Date().toISOString().split('T')[0];
    const todayRecord = pomodoroHistory.find(h => h.date === today) || { count: 0, totalMinutes: 0 };

    const last7 = [];
    for (let i = 6; i >= 0; i--) {
        const d = new Date(); d.setDate(d.getDate() - i);
        const key = d.toISOString().split('T')[0];
        const record = pomodoroHistory.find(h => h.date === key);
        last7.push({ day: ['日', '一', '二', '三', '四', '五', '六'][d.getDay()], count: record ? record.count : 0, minutes: record ? record.totalMinutes : 0 });
    }
    const maxCount = Math.max(...last7.map(d => d.count), 1);
    let chartHtml = last7.map(d => `
        <div class="pomo-chart-bar-wrapper">
            <div class="pomo-chart-bar" style="height: ${(d.count / maxCount) * 100}%">
                ${d.count > 0 ? `<span class="pomo-chart-bar-val">${d.count}</span>` : ''}
            </div>
            <span class="pomo-chart-day">${d.day}</span>
        </div>
    `).join('');

    const totalDays = pomodoroHistory.length;
    const totalPomos = pomodoroHistory.reduce((sum, h) => sum + h.count, 0);
    const totalMins = pomodoroHistory.reduce((sum, h) => sum + h.totalMinutes, 0);
    const avgPerDay = totalDays > 0 ? (totalPomos / totalDays).toFixed(1) : 0;

    container.innerHTML = `
        <div class="pomo-stats-today">
            <div class="pomo-stats-today-title">今日数据</div>
            <div class="pomo-stats-today-grid">
                <div class="pomo-stats-card"><div class="pomo-stats-card-num">${todayRecord.count}</div><div class="pomo-stats-card-label">完成次数</div></div>
                <div class="pomo-stats-card"><div class="pomo-stats-card-num">${todayRecord.totalMinutes}</div><div class="pomo-stats-card-label">专注分钟</div></div>
            </div>
        </div>
        <div class="pomo-stats-chart-section">
            <div class="pomo-stats-chart-title">近7天趋势</div>
            <div class="pomo-stats-chart">${chartHtml}</div>
        </div>
        <div class="pomo-stats-all">
            <div class="pomo-stats-all-title">累计数据</div>
            <div class="pomo-stats-all-grid">
                <div class="pomo-stats-all-item"><span class="pomo-all-num">${totalPomos}</span><span class="pomo-all-label">总次数</span></div>
                <div class="pomo-stats-all-item"><span class="pomo-all-num">${totalMins}</span><span class="pomo-all-label">总分钟</span></div>
                <div class="pomo-stats-all-item"><span class="pomo-all-num">${(totalMins / 60).toFixed(1)}</span><span class="pomo-all-label">总小时</span></div>
                <div class="pomo-stats-all-item"><span class="pomo-all-num">${avgPerDay}</span><span class="pomo-all-label">日均</span></div>
            </div>
        </div>
    `;
}

// --- Settings View ---
function renderPomodoroSettings() {
    const container = document.getElementById('pomo-settings-body');
    if (!container) return;

    let charOptions = '<option value="">自动</option>';
    if (appSettings.privateChats && Array.isArray(appSettings.privateChats)) {
        appSettings.privateChats.forEach(name => {
            const sel = pomodoroSettings.aiCharTag === `chat:${name}` ? 'selected' : '';
            charOptions += `<option value="chat:${name}" ${sel}>${escapeHtml(name)}</option>`;
        });
    }

    // Use native wb-entry-switch for toggles
    const makeSwitch = (id, checked) => {
        return `<label class="wb-entry-switch"><input type="checkbox" id="${id}" ${checked ? 'checked' : ''} onchange="savePomodoroSettingsUI()" /><span class="wb-slider"></span></label>`;
    };

    container.innerHTML = `
        <div class="pomo-setting-group">
            <div class="pomo-setting-title">学习模式</div>
            <div class="pomo-setting-row"><span>专注时长 (分钟)</span><input type="number" id="pomo-set-focus" class="pomo-setting-input" value="${pomodoroSettings.focusDuration}" min="1" max="120" onchange="savePomodoroSettingsUI()" /></div>
            <div class="pomo-setting-row"><span>短休息 (分钟)</span><input type="number" id="pomo-set-short" class="pomo-setting-input" value="${pomodoroSettings.shortBreakDuration}" min="1" max="30" onchange="savePomodoroSettingsUI()" /></div>
            <div class="pomo-setting-row"><span>长休息 (分钟)</span><input type="number" id="pomo-set-long" class="pomo-setting-input" value="${pomodoroSettings.longBreakDuration}" min="1" max="60" onchange="savePomodoroSettingsUI()" /></div>
            <div class="pomo-setting-row"><span>长休息间隔 (个)</span><input type="number" id="pomo-set-interval" class="pomo-setting-input" value="${pomodoroSettings.longBreakInterval}" min="2" max="10" onchange="savePomodoroSettingsUI()" /></div>
        </div>

        <div class="pomo-setting-group">
            <div class="pomo-setting-title">运动模式</div>
            <div class="pomo-setting-row"><span>运动时长 (分钟)</span><input type="number" id="pomo-set-exercise" class="pomo-setting-input" value="${pomodoroSettings.exerciseDuration}" min="1" max="120" onchange="savePomodoroSettingsUI()" /></div>
            <div class="pomo-setting-row"><span>运动休息 (分钟)</span><input type="number" id="pomo-set-exercise-break" class="pomo-setting-input" value="${pomodoroSettings.exerciseBreakDuration}" min="1" max="30" onchange="savePomodoroSettingsUI()" /></div>
        </div>

        <div class="pomo-setting-group">
            <div class="pomo-setting-title">自动化</div>
            <div class="pomo-setting-row"><span>自动开始休息</span>${makeSwitch('pomo-set-auto-break', pomodoroSettings.autoStartBreak)}</div>
            <div class="pomo-setting-row"><span>自动开始下一轮</span>${makeSwitch('pomo-set-auto-focus', pomodoroSettings.autoStartFocus)}</div>
            <div class="pomo-setting-row"><span>提示音效</span>${makeSwitch('pomo-set-sound', pomodoroSettings.notifySound)}</div>
        </div>

        <div class="pomo-setting-group">
            <div class="pomo-setting-title">角色陪伴</div>
            <div class="pomo-setting-row"><span>陪伴鼓励</span>${makeSwitch('pomo-set-ai', pomodoroSettings.aiEncourage)}</div>
            <div class="pomo-setting-row"><span>陪伴角色</span><select id="pomo-set-ai-char" class="pomo-setting-select" onchange="savePomodoroSettingsUI()">${charOptions}</select></div>
            <div class="pomo-setting-row" style="flex-direction:column;align-items:stretch;gap:8px;">
                <div style="display:flex;justify-content:space-between;align-items:center;">
                    <span>陪伴立绘</span>
                    ${pomodoroSettings.aiAvatar ? `<img src="${pomodoroSettings.aiAvatar}" style="width:28px;height:28px;border-radius:4px;object-fit:cover;" />` : ''}
                </div>
                <button style="width:100%;padding:6px 0;border:1px solid #ddd;border-radius:6px;font-size:12px;background:#fafafa;cursor:pointer;text-align:center;" onclick="uploadPomoAvatar()">本地上传</button>
                <div style="display:flex;gap:6px;align-items:center;">
                    <input type="text" id="pomo-avatar-url" class="pomo-setting-input" style="flex:1;font-size:12px;padding:6px 8px;" placeholder="输入图片URL" value="${pomodoroSettings.aiAvatar && !pomodoroSettings.aiAvatar.startsWith('data:') ? pomodoroSettings.aiAvatar : ''}" oninput="if(!this.value.trim()){pomodoroSettings.aiAvatar='';savePomodoroSettings();renderPomodoroSettings();renderPomodoroUI();}" />
                    <button style="padding:6px 12px;border:1px solid #ddd;border-radius:6px;font-size:12px;background:#fafafa;cursor:pointer;text-align:center;white-space:nowrap;" onclick="applyPomoAvatarUrl()">应用</button>
                </div>
            </div>
            <div class="pomo-setting-hint">开启后计时页显示角色立绘和鼓励话语，清空URL自动清除立绘</div>
        </div>

        <div class="pomo-setting-group">
            <div class="pomo-setting-title">数据管理</div>
            <button class="pomo-danger-btn" onclick="resetPomodoroStats()">重置统计数据</button>
        </div>
    `;
}

function clearPomoAvatar() {
    pomodoroSettings.aiAvatar = '';
    savePomodoroSettings();
    renderPomodoroSettings();
    renderPomodoroUI();
}

function applyPomoAvatarUrl() {
    const input = document.getElementById('pomo-avatar-url');
    const url = input ? input.value.trim() : '';
    // Empty URL = clear avatar
    pomodoroSettings.aiAvatar = url;
    savePomodoroSettings();
    renderPomodoroSettings();
    renderPomodoroUI();
    if (typeof showToast === 'function') showToast(url ? '立绘已更新' : '立绘已清除');
}

function savePomodoroSettingsUI() {
    pomodoroSettings.focusDuration = parseInt(document.getElementById('pomo-set-focus')?.value) || 25;
    pomodoroSettings.shortBreakDuration = parseInt(document.getElementById('pomo-set-short')?.value) || 5;
    pomodoroSettings.longBreakDuration = parseInt(document.getElementById('pomo-set-long')?.value) || 15;
    pomodoroSettings.longBreakInterval = parseInt(document.getElementById('pomo-set-interval')?.value) || 4;
    pomodoroSettings.exerciseDuration = parseInt(document.getElementById('pomo-set-exercise')?.value) || 30;
    pomodoroSettings.exerciseBreakDuration = parseInt(document.getElementById('pomo-set-exercise-break')?.value) || 10;
    pomodoroSettings.autoStartBreak = document.getElementById('pomo-set-auto-break')?.checked ?? true;
    pomodoroSettings.autoStartFocus = document.getElementById('pomo-set-auto-focus')?.checked ?? false;
    pomodoroSettings.notifySound = document.getElementById('pomo-set-sound')?.checked ?? true;
    pomodoroSettings.aiEncourage = document.getElementById('pomo-set-ai')?.checked ?? true;
    pomodoroSettings.aiCharTag = document.getElementById('pomo-set-ai-char')?.value || '';

    if (pomodoroState === 'idle') {
        pomodoroTimeLeft = getPomoFocusDuration() * 60;
        pomodoroTotalTime = pomodoroTimeLeft;
    }
    savePomodoroSettings();
}

function resetPomodoroStats() {
    if (!confirm('确定要重置所有统计数据吗？')) return;
    pomodoroTotalCompleted = 0;
    pomodoroCompletedCount = 0;
    pomodoroHistory = [];
    pomodoroTaskList.forEach(t => t.completed = 0);
    savePomodoroData(); savePomodoroHistory(); savePomodoroTasks();
    renderPomodoroStats(); renderPomodoroUI();
    if (typeof showToast === 'function') showToast('统计数据已重置');
}

// --- Session Record ---
function recordPomodoroSession(status) {
    const totalDur = getPomoFocusDuration();
    const elapsedSec = totalDur * 60 - pomodoroTimeLeft;
    const elapsedMin = Math.round(elapsedSec / 60);
    const session = {
        task: pomodoroCurrentTask || (pomodoroMode === 'exercise' ? '运动' : '学习'),
        mode: pomodoroMode,
        duration: totalDur,
        elapsed: elapsedMin,
        status: status, // 'completed' | 'given_up'
        timestamp: new Date().toISOString(),
        aiCharName: getPomoCompanionName() || ''
    };
    pomodoroSessions.unshift(session);
    // Keep last 200 sessions
    if (pomodoroSessions.length > 200) pomodoroSessions = pomodoroSessions.slice(0, 200);
    savePomodoroSessions();
}

function renderPomodoroRecords() {
    const container = document.getElementById('pomo-records-body');
    if (!container) return;

    if (pomodoroSessions.length === 0) {
        container.innerHTML = `<div class="pomo-empty-state"><div style="font-size:14px;color:#999;">暂无专注记录<br>完成或放弃番茄钟后自动记录</div></div>`;
        return;
    }

    let html = '';
    let lastDate = '';
    pomodoroSessions.forEach((s, idx) => {
        const d = new Date(s.timestamp);
        const dateStr = d.toLocaleDateString();
        if (dateStr !== lastDate) {
            lastDate = dateStr;
            html += `<div class="pomo-task-section-title" style="${idx > 0 ? 'margin-top:12px;' : ''}">${dateStr}</div>`;
        }
        const isComplete = s.status === 'completed';
        const statusLabel = isComplete ? '✅ 完成' : '⏹ 放弃';
        const statusColor = isComplete ? '#4caf50' : '#999';
        const modeIcon = s.mode === 'exercise'
            ? '<img src="https://api.iconify.design/icon-park-outline:sport.svg" width="14" height="14" style="vertical-align:-2px;" />'
            : '<img src="https://api.iconify.design/material-symbols:book-2-outline-rounded.svg" width="14" height="14" style="vertical-align:-2px;" />';
        const timeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        html += `
        <div class="pomo-task-item" style="border-bottom:1px solid #f5f5f5;">
            <div class="pomo-task-info" style="gap:4px;">
                <div class="pomo-task-name">${modeIcon} ${escapeHtml(s.task)}</div>
                <div class="pomo-task-count" style="display:flex;gap:8px;align-items:center;">
                    <span>${timeStr}</span>
                    <span>${s.elapsed}/${s.duration}分钟</span>
                    <span style="color:${statusColor};font-weight:500;">${statusLabel}</span>
                    ${s.aiCharName ? `<span style="color:#bbb;">${escapeHtml(s.aiCharName)}</span>` : ''}
                </div>
            </div>
            <div class="pomo-task-actions">
                <button class="pomo-task-action-btn delete" onclick="deletePomodoroSession(${idx})" title="删除">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M18 6L6 18M6 6l12 12"/></svg>
                </button>
            </div>
        </div>`;
    });
    container.innerHTML = html;
}

function deletePomodoroSession(idx) {
    if (idx < 0 || idx >= pomodoroSessions.length) return;
    pomodoroSessions.splice(idx, 1);
    savePomodoroSessions();
    renderPomodoroRecords();
}

function clearPomodoroSessions() {
    if (!confirm('确定要清空所有专注记录吗？')) return;
    pomodoroSessions = [];
    savePomodoroSessions();
    renderPomodoroRecords();
    if (typeof showToast === 'function') showToast('专注记录已清空');
}

// --- Tab Switching ---
function switchPomodoroTab(tab) {
    document.querySelectorAll('.pomo-tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.pomo-tab-content').forEach(c => c.style.display = 'none');
    const btn = document.querySelector(`.pomo-tab-btn[data-tab="${tab}"]`);
    if (btn) btn.classList.add('active');
    const content = document.getElementById(`pomo-tab-${tab}`);
    if (content) content.style.display = 'flex';
    if (tab === 'timer') renderPomodoroUI();
    else if (tab === 'tasks') renderPomodoroTasks();
    else if (tab === 'records') renderPomodoroRecords();
    else if (tab === 'stats') renderPomodoroStats();
    else if (tab === 'settings') renderPomodoroSettings();
}

// --- Open / Close ---
function openPomodoroApp() {
    loadPomodoroData();
    let screen = document.getElementById('pomodoro-screen');
    if (!screen) { createPomodoroScreenHTML(); screen = document.getElementById('pomodoro-screen'); }
    screen.style.display = 'flex';
    screen.style.animation = 'screenSlideIn 0.3s ease forwards';
    switchPomodoroTab('timer');
}

function closePomodoroApp() {
    const screen = document.getElementById('pomodoro-screen');
    if (!screen) return;
    screen.style.animation = 'screenSlideOut 0.3s ease forwards';
    setTimeout(() => { screen.style.display = 'none'; screen.style.animation = ''; }, 280);
}

// --- Dynamic HTML Creation ---
function createPomodoroScreenHTML() {
    const screen = document.createElement('div');
    screen.id = 'pomodoro-screen';
    screen.className = 'app-screen pomodoro-app';
    screen.style.display = 'none';

    screen.innerHTML = `
    <div class="pomo-header">
        <button class="pomo-header-btn" onclick="closePomodoroApp()">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="22" height="22"><path d="M15 18l-6-6 6-6"/></svg>
        </button>
        <span class="pomo-header-title">番茄钟</span>
        <div style="width:36px;"></div>
    </div>
    <div class="pomo-tabs">
        <button class="pomo-tab-btn active" data-tab="timer" onclick="switchPomodoroTab('timer')">计时</button>
        <button class="pomo-tab-btn" data-tab="tasks" onclick="switchPomodoroTab('tasks')">任务</button>
        <button class="pomo-tab-btn" data-tab="records" onclick="switchPomodoroTab('records')">记录</button>
        <button class="pomo-tab-btn" data-tab="stats" onclick="switchPomodoroTab('stats')">统计</button>
        <button class="pomo-tab-btn" data-tab="settings" onclick="switchPomodoroTab('settings')">设置</button>
    </div>
    <div id="pomo-tab-timer" class="pomo-tab-content" style="display:flex;">
        <div id="pomo-main-area" class="pomo-main-area"></div>
    </div>
    <div id="pomo-tab-tasks" class="pomo-tab-content" style="display:none;">
        <div id="pomo-tasks-body" class="pomo-scroll-body"></div>
    </div>
    <div id="pomo-tab-records" class="pomo-tab-content" style="display:none;">
        <div id="pomo-records-body" class="pomo-scroll-body"></div>
    </div>
    <div id="pomo-tab-stats" class="pomo-tab-content" style="display:none;">
        <div id="pomo-stats-body" class="pomo-scroll-body"></div>
    </div>
    <div id="pomo-tab-settings" class="pomo-tab-content" style="display:none;">
        <div id="pomo-settings-body" class="pomo-scroll-body"></div>
    </div>
    `;

    document.getElementById('phone-container').appendChild(screen);
}

if (typeof escapeHtml !== 'function') {
    window._pomoEscapeHtml = function (text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    };
}

// --- Share Feature ---
let pomoShareState = {
    startTime: null,      // Date when timer started
    totalDuration: 0,     // total duration in minutes
    status: 'in_progress', // 'in_progress' | 'completed' | 'given_up'
    shownAIEvents: []     // which AI events were shown: ['start', 'complete', 'give_up']
};

// Track share state on start/complete/giveup
function pomoTrackStart() {
    pomoShareState = {
        startTime: new Date(),
        totalDuration: getPomoFocusDuration(),
        status: 'in_progress',
        shownAIEvents: ['start']
    };
}
function pomoTrackComplete() {
    pomoShareState.status = 'completed';
    if (!pomoShareState.shownAIEvents.includes('complete')) pomoShareState.shownAIEvents.push('complete');
}
function pomoTrackGiveUp() {
    pomoShareState.status = 'given_up';
    if (!pomoShareState.shownAIEvents.includes('give_up')) pomoShareState.shownAIEvents.push('give_up');
}

function sharePomoStatus() {
    // Build share data
    const task = pomodoroCurrentTask || (pomodoroMode === 'exercise' ? '运动' : '学习');
    const totalMin = pomoShareState.totalDuration || getPomoFocusDuration();
    const elapsedSec = pomoShareState.totalDuration * 60 - pomodoroTimeLeft;
    const elapsedMin = Math.floor(elapsedSec / 60);

    let statusText = '进行中';
    let statusColor = '#666';
    if (pomoShareState.status === 'completed') { statusText = '已完成'; statusColor = '#333'; }
    else if (pomoShareState.status === 'given_up') { statusText = '已放弃'; statusColor = '#999'; }

    // Collect AI messages to display
    let aiLines = [];
    if (pomodoroAILines) {
        const labelMap = { start: '开始', one_third: '1/3', two_thirds: '2/3', complete: '完成', give_up: '放弃' };
        pomoShareState.shownAIEvents.forEach(evt => {
            if (pomodoroAILines[evt]) {
                aiLines.push({ label: labelMap[evt] || evt, text: pomodoroAILines[evt] });
            }
        });
    }

    // Show chat picker
    showPomoChatPicker(task, totalMin, elapsedMin, statusText, statusColor, aiLines);
}

function showPomoChatPicker(task, totalMin, elapsedMin, statusText, statusColor, aiLines) {
    const existing = document.getElementById('pomo-share-modal');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'pomo-share-modal';
    overlay.className = 'modal-overlay show';
    overlay.style.cssText = 'position:absolute;top:0;left:0;right:0;bottom:0;z-index:2000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.35);backdrop-filter:blur(4px);';
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

    // Build chat list
    let chatListHtml = '';
    const chats = appSettings.privateChats || [];
    chats.forEach(name => {
        const npc = (typeof npcCharacters !== 'undefined' && Array.isArray(npcCharacters))
            ? npcCharacters.find(n => n.name === name) : null;
        const avatarSrc = (npc && npc.avatar)
            ? npc.avatar
            : 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0iI2IwYjBiMCI+PHJlY3Qgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0IiBmaWxsPSIjZjJmMmYyIi8+PHBhdGggZD0iTTEyIDEyYzIuMjEgMCA0LTEuNzkgNC00cy0xLjc5LTQtNC00LTQgMS43OS00IDQgMS43OS00IDQgNHptMCAyYy0yLjY3IDAtOCAxLjM0LTggNHYyaDE2di0yYzAtMi42Ni01LjMzLTQtOC00eiIvPjwvc3ZnPg==';
        chatListHtml += `
        <div class="pomo-share-chat-item" onclick="sendPomoShareToChat('chat:${escapeHtml(name)}', '${escapeHtml(name)}')">
            <img src="${avatarSrc}" class="pomo-share-avatar" />
            <span>${escapeHtml(name)}</span>
        </div>`;
    });

    // Preview card
    const modeLabel = pomodoroMode === 'exercise' ? '运动记录' : '专注记录';
    let aiHtml = '';
    aiLines.forEach(line => {
        aiHtml += `<div style="font-size:11px;color:#888;margin-top:4px;">${escapeHtml(line.text)}</div>`;
    });

    overlay.innerHTML = `
    <div class="modal-box group-modal-cute" style="width:300px;max-height:80%;overflow:auto;">
        <div class="modal-title group-modal-title" style="margin-top:0;font-size:16px;">分享到聊天</div>
        <div style="margin:10px 0;padding:12px;background:#fafafa;border-radius:0;border:1px solid #eee;">
            <div style="font-size:12px;color:#bbb;font-weight:600;margin-bottom:6px;">${modeLabel}</div>
            <div style="font-size:15px;font-weight:600;color:#333;margin-bottom:4px;">${escapeHtml(task)}</div>
            <div style="font-size:12px;color:#888;">${totalMin}分钟 / 已进行${elapsedMin}分钟</div>
            <div style="font-size:12px;color:${statusColor};font-weight:500;margin-top:4px;">${statusText}</div>
            ${aiHtml}
        </div>
        <div style="font-size:13px;color:#999;margin-bottom:8px;">选择聊天</div>
        <div class="pomo-share-chat-list">${chatListHtml || '<div style="text-align:center;color:#ccc;padding:16px;">暂无聊天</div>'}</div>
        <div class="modal-actions" style="margin-top:12px;">
            <button class="modal-btn group-modal-cancel" onclick="document.getElementById('pomo-share-modal').remove()">取消</button>
        </div>
    </div>`;

    const screen = document.getElementById('pomodoro-screen');
    if (screen) screen.appendChild(overlay);
}

function sendPomoShareToChat(chatTag, charName) {
    const task = pomodoroCurrentTask || (pomodoroMode === 'exercise' ? '运动' : '学习');
    const totalMin = pomoShareState.totalDuration || getPomoFocusDuration();
    const elapsedSec = pomoShareState.totalDuration * 60 - pomodoroTimeLeft;
    const elapsedMin = Math.floor(elapsedSec / 60);
    const modeLabel = pomodoroMode === 'exercise' ? '运动记录' : '专注记录';

    let statusText = '进行中';
    if (pomoShareState.status === 'completed') statusText = '已完成';
    else if (pomoShareState.status === 'given_up') statusText = '已放弃';

    // Build AI lines for the card body
    let aiText = '';
    if (pomodoroAILines) {
        const labelMap = { start: '开始', one_third: '1/3', two_thirds: '2/3', complete: '完成', give_up: '放弃' };
        pomoShareState.shownAIEvents.forEach(evt => {
            if (pomodoroAILines[evt]) {
                aiText += `\n${pomodoroAILines[evt]}`;
            }
        });
    }

    // Build card body: header|body|status
    const cardBody = `${modeLabel}|${task} (${totalMin}分钟/已${elapsedMin}分钟)${aiText}|${statusText}`;

    const userName = typeof getUserName === 'function' ? getUserName() : 'User';
    const timestamp = typeof getTime === 'function' ? getTime(false) : '12:00';

    (async () => {
        try {
            let history = await getChatHistory(chatTag) || [];
            history.push({
                header: `[${userName}|POMO|${timestamp}]`,
                body: cardBody,
                isUser: true
            });
            await saveChatHistory(chatTag, history);
        } catch (e) { console.error('[Pomo Share] save error:', e); }
    })();

    // Close the share modal
    const modal = document.getElementById('pomo-share-modal');
    if (modal) modal.remove();

    if (typeof showToast === 'function') showToast(`已分享到 ${charName}`);
}

})();
