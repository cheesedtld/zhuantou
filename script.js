 (function() {


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
charBubble: '#001C77', charText: '#C2C2C2', charAvatar: '',
userBubble: '#016E8F', userText: '#C2C2C2', userAvatar: '',
chatBg: 'https://intellcs.sinosafe.com.cn/immessage/api/v1/message/attachment/download?groupName=group1&authorization=EnAfMjUzaQVz&fileName=M00/00/AB/CgND1WkthgWAKgDaAASrzx5RVa827.jpeg', chatBgIsDark: false,
homeBg: 'https://intellcs.sinosafe.com.cn/immessage/api/v1/message/attachment/download?groupName=group1&authorization=EnAfMjUzaQVz&fileName=M00/00/A7/CgND1WkhtDSADV5WAANPQ4JuHoI63.jpeg', homeBgIsDark: false,
iconBg: '#003673', iconColor: '#00885A',
caseColor: '#707070', phoneWidth: '330', phoneHeight: '660',
homeTextColor: '#749594',
interfaceColor: '#004A88',
msgNameColor: '#C2C2C2',
msgTimeColor: '#ADADAD',
fontSize: 14, // 默认字体大小
chatBtnColor: '#A7C6FF', // 按钮背景色
chatBtnText: '#A7C6FF', // 按钮文字/图标色
customTime: '', // 格式 HH:MM，为空则使用系统时间
timeOffset: 0, // 时间偏移量 (ms)
blockChar: false, // User blocks Char
blockUser: false, // Char blocks User
groups: [], // 群组列表 [{name: 'GroupName', members: ['A', 'B']}]
privateChats: [], // 私聊列表 ['Name1', 'Name2']
memberAvatars: {}, // NEW: 成员头像列表 { 'Name': 'url', ... }
useSunbox: true, // Default to true
// API Settings
apiEndpoint: 'https://api.openai.com/v1',
apiKey: '',
apiModel: 'gpt-3.5-turbo',
systemPrompt: '你是一个智能助手。'
};
let appSettings = { ...defaultAppSettings };
let userCharacters = []; // New: To store user characters
let editingUserIndex = null; // New: To track which user is being edited
let currentChatTag = null; // 当前聊天标签 (e.g. chat:Name or group:Name5人)
let currentChatTarget = null; // 当前聊天显示名称

let myStickerList = [];
const defaultStickerList = [
{ name: "你自首吧", url: "https://catbox.pengcyril.dpdns.org/s1wpw8.jpeg" },
{ name: "抱抱", url: "https://catbox.pengcyril.dpdns.org/31onrh.jpeg" },
{ name: "贴贴", url: "https://catbox.pengcyril.dpdns.org/ljqszc.jpeg" },
{ name: "我要告状", url: "https://catbox.pengcyril.dpdns.org/icwt52.jpeg" }
];

let activeDeleteBtn = null;
let currentConfirmAction = null;
// NEW: Pending upload file
let pendingFile = null;
// NEW: Last uploaded image for AI vision
let lastUploadedImageForAI = null;

let currentSettingsUploadType = null;
let isLoadingHistory = false;

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

    if(addContactModal) {
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
    removeBtn.onclick = function() {
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
    if(addContactModal) addContactModal.classList.remove('show');
}


function switchContactTab() {
    // Stub - no longer needed
}

function renderGroupInputs() {
    // No longer needed with new select-based UI
}

function addGroupNameRow(container, focus=false, value='', removable=true) {
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
    
    if(isGroup) {
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

        if(names.length < 2) {
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
        saveSettingsToStorage();

        targetName = groupName;
        // 构造群聊标签: 不再包含人数
        targetTag = `group:${groupName}`;
        
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
        saveSettingsToStorage();
        
        // Get NPC name
        // if (!appSettings.npcCharacters) appSettings.npcCharacters = [];
        const npc = npcCharacters[npcIndex];
        if (!npc) {
            console.error('NPC not found at index:', npcIndex);
            return;
        }
        
        targetName = npc.name;
        targetTag = `chat:${targetName}`;

        // NEW: 持久化保存私聊联系人
        if (!appSettings.privateChats) appSettings.privateChats = [];
        if (!appSettings.privateChats.includes(targetName)) {
            appSettings.privateChats.push(targetName);
            saveSettingsToStorage();
        }
    }
    
    closeAddContactModal();
    openChat(targetTag, targetName);
}





function openMessageList() {
if(homeScreen) homeScreen.style.display = 'none';
if(messageListScreen) messageListScreen.style.display = 'flex';
updateStatusBar('message-list');
renderMessageList();
}

function openChat(targetTag, targetName) {
    // If no target is specified, do nothing in standalone mode.
    if (!targetTag) {
        console.warn("openChat called without a target in standalone mode.");
        return;
    }

    currentChatTag = targetTag;
    currentChatTarget = targetName;

    // 更新标题
    const headerTitleEl = document.getElementById('header-title');
    if(headerTitleEl) headerTitleEl.textContent = currentChatTarget;

    // 刷新聊天内容
    if (typeof loadInitialChat === 'function') loadInitialChat();

    // 从消息列表进入聊天
    if(messageListScreen) messageListScreen.style.display = 'none';
    if(chatScreen) chatScreen.style.display = 'flex';
    updateStatusBar('chat');
    setTimeout(() => { if(chatMessages) chatMessages.scrollTop = chatMessages.scrollHeight; }, 300);
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

// Character Setup (NPC列表) -> Home
const setupScreen = document.getElementById('character-setup-screen');
if (setupScreen && setupScreen.style.display === 'flex') {
    setupScreen.style.display = 'none';
    if(homeScreen) homeScreen.style.display = 'flex';
    updateStatusBar('home');
    return;
}

if (chatSettingsScreen && chatSettingsScreen.style.display === 'flex') {
    closeChatSettings();
    return;
}

if(chatScreen && chatScreen.style.display === 'flex') {
    // 从聊天返回消息列表
    chatScreen.style.display = 'none';
    if(messageListScreen) messageListScreen.style.display = 'flex';
    updateStatusBar('message-list');
    renderMessageList(); // 刷新预览
    return;
}

if(messageListScreen && messageListScreen.style.display === 'flex') {
    // 从消息列表返回主屏幕
    messageListScreen.style.display = 'none';
    if(homeScreen) homeScreen.style.display = 'flex';
    updateStatusBar('home');
    return;
}

if(settingsScreen && settingsScreen.style.display === 'flex') {
    saveTimeSettings();
    settingsScreen.style.display = 'none';
    if(homeScreen) homeScreen.style.display = 'flex';
    updateStatusBar('home');
    return;
}

const beautifyScreenBack = document.getElementById('beautify-screen');
if(beautifyScreenBack && beautifyScreenBack.style.display === 'flex') {
    beautifyScreenBack.style.display = 'none';
    if(settingsScreen) settingsScreen.style.display = 'flex';
    updateStatusBar('settings');
    return;
}

const apiSettingsScreenBack = document.getElementById('api-settings-screen');
if(apiSettingsScreenBack && apiSettingsScreenBack.style.display === 'flex') {
    apiSettingsScreenBack.style.display = 'none';
    if(settingsScreen) settingsScreen.style.display = 'flex';
    updateStatusBar('settings');
    return;
}

const dataSettingsScreenBack = document.getElementById('data-settings-screen');
if(dataSettingsScreenBack && dataSettingsScreenBack.style.display === 'flex') {
    dataSettingsScreenBack.style.display = 'none';
    if(settingsScreen) settingsScreen.style.display = 'flex';
    updateStatusBar('settings');
    return;
}

if(userSettingsScreen && userSettingsScreen.style.display === 'flex') {
    userSettingsScreen.style.display = 'none';
    if (_userSettingsFrom === 'settings') {
        if(settingsScreen) settingsScreen.style.display = 'flex';
        updateStatusBar('settings');
    } else {
        if(homeScreen) homeScreen.style.display = 'flex';
        updateStatusBar('home');
    }
    return;
}

// Fallback
if(homeScreen) homeScreen.style.display = 'flex';
updateStatusBar('home');
}

// 辅助函数：从历史记录字符串中提取所有聊天块

function renderMessageList() {
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
            const memberAvatar = (appSettings.memberAvatars && appSettings.memberAvatars[name]) ? appSettings.memberAvatars[name] : placeholderAvatar;
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
    const getPreviewText = (body) => {
        if (!body) return '';
        if (body.includes('[') && body.includes(']')) {
            if (body.includes('|图片|')) return '[图片]';
            if (body.includes('|语音|')) return '[语音]';
            if (body.includes('|视频|')) return '[视频]';
            if (body.includes('|文件|')) return '[文件]';
            if (body.includes('|位置|')) return '[位置]';
            if (body.includes('|转账|') || body.includes('|TRANS|')) return '[转账]';
            if (body.includes('|表情包|')) return '[表情包]';
        }
        // Strip quotes and return a snippet
        return body.replace(/「`回复.*?`」/g, '').trim().substring(0, 50);
    };

    // Render List
    conversations.forEach(chat => {
        const historyKey = `faye-phone-history-${chat.tag}`;
        const savedHistory = localStorage.getItem(historyKey);
        if (savedHistory) {
            try {
                const history = JSON.parse(savedHistory);
                if (history.length > 0) {
                    const lastMessage = history[history.length - 1];
                    chat.lastMsg = getPreviewText(lastMessage.body);
                    const timeMatch = lastMessage.header ? lastMessage.header.match(/\|(\d{2}:\d{2})/) : null;
                    chat.lastTime = timeMatch ? timeMatch[1] : '';
                }
            } catch (e) { /* Ignore parsing errors */ }
        }

        const item = document.createElement('div');
        item.className = 'message-list-item';
        item.onclick = () => openChat(chat.tag, chat.name);

        let displayAvatar = chat.avatar;

        item.innerHTML = `
            <img class="message-list-avatar" src="${displayAvatar}">
            <div class="message-list-info">
                <div class="message-list-top">
                    <span class="message-list-name">${chat.name} ${chat.isGroup ? '<span class="group-badge">群</span>' : ''}</span>
                    <span class="message-list-time">${chat.lastTime || ''}</span>
                </div>
                <div class="message-list-preview">${chat.lastMsg}</div>
            </div>
        `;
        messageListBody.appendChild(item);
    });
}

function openSettings() {
    if(homeScreen) homeScreen.style.display = 'none';
    if(settingsScreen) settingsScreen.style.display = 'flex';
    // 加载时间设置到导航页
    let displayTime = '';
    if (appSettings.timeOffset) {
        const now = new Date();
        const target = new Date(now.getTime() + appSettings.timeOffset);
        displayTime = `${target.getHours().toString().padStart(2,'0')}:${target.getMinutes().toString().padStart(2,'0')}`;
    } else {
        displayTime = appSettings.customTime || '';
    }
    const timeInput = document.getElementById('set-custom-time');
    if (timeInput) timeInput.value = displayTime;
    updateStatusBar('settings');
}

function saveTimeSettings() {
    const timeInput = document.getElementById('set-custom-time').value;
    if (timeInput && /^\d{1,2}:\d{2}$/.test(timeInput)) {
        const now = new Date();
        const [h, m] = timeInput.split(':');
        const target = new Date(now);
        target.setHours(parseInt(h));
        target.setMinutes(parseInt(m));
        target.setSeconds(0);
        appSettings.timeOffset = target.getTime() - now.getTime();
        appSettings.customTime = timeInput;
    } else {
        appSettings.timeOffset = 0;
        appSettings.customTime = '';
    }
    saveSettingsToStorage();
}

function closeSettings() {
    saveTimeSettings();
    if(settingsScreen) settingsScreen.style.display = 'none';
    if(homeScreen) homeScreen.style.display = 'flex';
    updateStatusBar('home');
}

function openApiSettings() {
    document.getElementById('set-api-endpoint').value = appSettings.apiEndpoint || 'https://api.openai.com/v1';
    document.getElementById('set-api-key').value = appSettings.apiKey || '';
    document.getElementById('set-api-model').innerHTML = `<option value="${appSettings.apiModel || 'gpt-3.5-turbo'}">${appSettings.apiModel || 'gpt-3.5-turbo'}</option>`;
    document.getElementById('set-system-prompt').value = appSettings.systemPrompt || '你是一个智能助手。';

    if(settingsScreen) settingsScreen.style.display = 'none';
    const apiScreen = document.getElementById('api-settings-screen');
    if(apiScreen) apiScreen.style.display = 'flex';
    updateStatusBar('settings');
}

function closeApiSettings() {
    const apiScreen = document.getElementById('api-settings-screen');
    if(apiScreen) apiScreen.style.display = 'none';
    if(settingsScreen) settingsScreen.style.display = 'flex';
    updateStatusBar('settings');
}

function saveApiSettings() {
    appSettings.apiEndpoint = document.getElementById('set-api-endpoint').value;
    appSettings.apiKey = document.getElementById('set-api-key').value;
    appSettings.apiModel = document.getElementById('set-api-model').value;
    appSettings.systemPrompt = document.getElementById('set-system-prompt').value;
    saveSettingsToStorage();
    closeApiSettings();
}

function openDataSettings() {
    if(settingsScreen) settingsScreen.style.display = 'none';
    const dataScreen = document.getElementById('data-settings-screen');
    if(dataScreen) dataScreen.style.display = 'flex';
    updateStatusBar('settings');
}

function closeDataSettings() {
    const dataScreen = document.getElementById('data-settings-screen');
    if(dataScreen) dataScreen.style.display = 'none';
    if(settingsScreen) settingsScreen.style.display = 'flex';
    updateStatusBar('settings');
}

function exportAllData() {
    try {
        const allData = {};
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key.startsWith('faye-phone')) {
                allData[key] = localStorage.getItem(key);
            }
        }
        const blob = new Blob([JSON.stringify(allData, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `phone-backup-${new Date().toISOString().slice(0,10)}.json`;
        a.click();
        URL.revokeObjectURL(url);
        showToast('✅ 备份成功');
    } catch(e) {
        showToast('❌ 备份失败');
    }
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
                for (const [key, value] of Object.entries(data)) {
                    localStorage.setItem(key, value);
                }
                showToast('✅ 恢复成功，刷新页面生效');
                setTimeout(() => location.reload(), 1500);
            } catch(err) {
                showToast('❌ 文件格式错误');
            }
        };
        reader.readAsText(file);
    };
    input.click();
}

function clearAllData() {
    if (!confirm('确定要清除所有数据吗？此操作不可恢复！')) return;
    const keysToRemove = [];
    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key.startsWith('faye-phone')) {
            keysToRemove.push(key);
        }
    }
    keysToRemove.forEach(key => localStorage.removeItem(key));
    showToast('✅ 数据已清除');
    setTimeout(() => location.reload(), 1500);
}

function openBeautifySettings() {
document.getElementById('set-icon-bg').value = appSettings.iconBg;
document.getElementById('set-icon-color').value = appSettings.iconColor;
document.getElementById('set-home-text-color').value = appSettings.homeTextColor;
document.getElementById('set-custom-css').value = appSettings.customCss || '';
document.getElementById('preview-home-bg').src = appSettings.homeBg || '';

if(settingsScreen) settingsScreen.style.display = 'none';
const beautifyScreen = document.getElementById('beautify-screen');
if(beautifyScreen) beautifyScreen.style.display = 'flex';
updateStatusBar('settings');
}

function closeBeautifySettings() {
    const beautifyScreen = document.getElementById('beautify-screen');
    if(beautifyScreen) beautifyScreen.style.display = 'none';
    if(settingsScreen) settingsScreen.style.display = 'flex';
    updateStatusBar('settings');
}

async function saveBeautifySettings() {
appSettings.iconBg = document.getElementById('set-icon-bg').value;
appSettings.iconColor = document.getElementById('set-icon-color').value;
appSettings.homeTextColor = document.getElementById('set-home-text-color').value;
appSettings.customCss = document.getElementById('set-custom-css').value;

applySettings();

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
    } catch(e) { console.error('Image analysis failed', e); }
}

saveSettingsToStorage(); 
applySettings(); closeBeautifySettings();
}

function updateClock() {
let timeStr;
// 只要 customTime 有值，就说明用户启用了自定义时间，此时应该使用 timeOffset (即使是 0)
if (appSettings.customTime && /^\d{1,2}:\d{2}$/.test(appSettings.customTime) && typeof appSettings.timeOffset === 'number') {
    const now = new Date();
    const target = new Date(now.getTime() + appSettings.timeOffset);
    timeStr = `${target.getHours().toString().padStart(2,'0')}:${target.getMinutes().toString().padStart(2,'0')}`;
} else {
    const now = new Date();
    timeStr = `${now.getHours().toString().padStart(2,'0')}:${now.getMinutes().toString().padStart(2,'0')}`;
}
if(clockEl) clockEl.textContent = timeStr;
if(homeClockEl) homeClockEl.textContent = timeStr;
}

function updateStatusBar(screen) {
let isDark = false;
if (screen === 'home') isDark = appSettings.homeBgIsDark;
else if (screen === 'chat') isDark = appSettings.chatBgIsDark;
else if (screen === 'settings') isDark = false;
else if (screen === 'message-list') isDark = false;
else if (screen === 'dark-search') isDark = false;

if (screen === 'home' && !appSettings.homeBg) isDark = false;
if (screen === 'chat' && !appSettings.chatBg) isDark = false;

if(statusBar) statusBar.className = isDark ? 'status-bar text-light' : 'status-bar text-dark';
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
const data = ctx.getImageData(0,0,50,50).data; let r=0,g=0,b=0;
for(let i=0; i<data.length; i+=4) { r+=data[i]; g+=data[i+1]; b+=data[i+2]; }
resolve(((r+g+b)/(3*(data.length/4))) < 128);
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
if(phoneContainer) {
    // Width and height are now controlled by CSS for full-screen layout.
}
if(homeScreen) {
    if (appSettings.homeBg) homeScreen.style.backgroundImage = `url(${appSettings.homeBg})`;
    else { homeScreen.style.backgroundImage = 'none'; homeScreen.style.backgroundColor = '#f3e5f5'; }
}
if(chatScreen) {
    if (appSettings.chatBg) { chatScreen.style.backgroundImage = `url(${appSettings.chatBg})`; chatScreen.style.backgroundColor = '#f9f9f9'; }
    else { chatScreen.style.backgroundImage = 'none'; chatScreen.style.backgroundColor = '#fff'; }
}

document.querySelectorAll('.app-icon-style').forEach(el => {
    el.style.background = appSettings.iconBg;
    const svg = el.querySelector('svg');
    if (svg) svg.style.fill = appSettings.iconColor;
    const mask = el.querySelector('.app-icon-image');
    if (mask) mask.style.backgroundColor = appSettings.iconColor;
});

if (appSettings.homeTextColor) {
    if(homeClockEl) homeClockEl.style.color = appSettings.homeTextColor;
    document.querySelectorAll('.app-name').forEach(el => el.style.color = appSettings.homeTextColor);
}

// 只在聊天相关页面设置 --interface-bg
const rgba = hexToRgba(appSettings.interfaceColor || '#f7f7f7', 0.6);
if (chatScreen) chatScreen.style.setProperty('--interface-bg', rgba);
if (document.getElementById('chat-settings-screen')) document.getElementById('chat-settings-screen').style.setProperty('--interface-bg', rgba);
// 主屏和消息列表不设置 --interface-bg，保持原有色彩

const rootStyle = document.documentElement.style;
rootStyle.setProperty('--msg-name-color', appSettings.msgNameColor || '#999999');
rootStyle.setProperty('--msg-time-color', appSettings.msgTimeColor || '#b0b0b0');
rootStyle.setProperty('--msg-font-size', (appSettings.fontSize || 14) + 'px');
const btnRgba = hexToRgba(appSettings.chatBtnColor || '#f2b5b6', 0.6);
rootStyle.setProperty('--chat-btn-color', btnRgba);
rootStyle.setProperty('--chat-btn-text', appSettings.chatBtnText || '#2ea0a0');
// 手机宽度变量（用于计算气泡最大宽度），默认330px
rootStyle.setProperty('--phone-width-px', ((appSettings.phoneWidth && !isNaN(appSettings.phoneWidth)) ? appSettings.phoneWidth : 330) + 'px');

// Apply Custom CSS
let styleTag = document.getElementById('custom-css-style');
if (!styleTag) {
    styleTag = document.createElement('style');
    styleTag.id = 'custom-css-style';
    document.head.appendChild(styleTag);
}
styleTag.textContent = appSettings.customCss || '';

// Update UI inputs
const useSunboxEl = document.getElementById('set-use-sunbox');
if (useSunboxEl) useSunboxEl.checked = (appSettings.useSunbox !== false); // Default true

updateStatusBar('home'); loadInitialChat();
}


// saveHomeSettings removed - split into saveApiSettings and saveBeautifySettings

function renderAvatarSettings() {
    const container = document.getElementById('avatar-settings-container');
    if (!container) return;
    container.innerHTML = '';

    const placeholderAvatar = "data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='%23cccccc'%3E%3Cpath d='M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z'/%3E%3C/svg%3E";
    
    const isGroup = currentChatTag && currentChatTag.startsWith('group:');
    const myName = (appSettings.currentUserId !== undefined && userCharacters[appSettings.currentUserId]) ? userCharacters[appSettings.currentUserId].name : '{{user}}';

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
        groupImg.style.border = '2px solid #ffb6b6';
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
                const isMe = (m === myName || m === '{{user}}' || m === 'User' || m === '我');
                let av = (appSettings.memberAvatars && appSettings.memberAvatars[m])
                    ? appSettings.memberAvatars[m]
                    : placeholderAvatar;
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
            label.textContent = m.isMe ? '{{user}}' : m.name;
            item.appendChild(img);
            item.appendChild(label);
            container.appendChild(item);
        });
    } else {
        // 私聊模式：显示user和角色两人的头像（从创建时设置的头像获取）
        container.className = 'avatar-pair-container';

        // 获取当前选中的user头像（从user创建时设置的头像）
        let userAvatar = placeholderAvatar;
        let userName = '{{user}}';
        if (appSettings.currentUserId !== undefined && userCharacters[appSettings.currentUserId]) {
            const currentUser = userCharacters[appSettings.currentUserId];
            userAvatar = currentUser.avatar || placeholderAvatar;
            userName = currentUser.name || '{{user}}';
        } else if (appSettings.userAvatar) {
            userAvatar = appSettings.userAvatar;
        }

        // 获取角色头像（从NPC创建时设置的头像）
        const targetName = currentChatTarget || '{{char}}';
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
        const userImg = document.createElement('img');
        userImg.className = 'avatar-pair-img';
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
        const charImg = document.createElement('img');
        charImg.className = 'avatar-pair-img';
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

    const currentId = appSettings.currentUserId !== undefined ? appSettings.currentUserId : 0;

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
            // 更新头像设置区域
            appSettings.currentUserId = index;
            appSettings.userAvatar = user.avatar || defaultAv;
            renderAvatarSettings();
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

function openChatSettings() {
    // Populate User Selector (hidden select for compatibility)
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
            if (appSettings.currentUserId !== undefined) {
                userSelector.value = appSettings.currentUserId;
            }
        }
    }

    // Render horizontal user selector bar
    renderUserSelectorBar();

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
    document.getElementById('set-block-char').checked = appSettings.blockChar || false;
    document.getElementById('set-block-user').checked = appSettings.blockUser || false;

    renderAvatarSettings();

    if(chatSettingsScreen) chatSettingsScreen.style.display = 'flex';
    updateStatusBar('settings');
}

function closeChatSettings() {
    if(chatSettingsScreen) chatSettingsScreen.style.display = 'none';
    updateStatusBar('chat');
}

async function saveChatSettings() {
    // Save selected user
    const userSelector = document.getElementById('user-selector');
    if (userSelector && userSelector.value !== null && userSelector.value !== '-1') {
        const selectedIndex = parseInt(userSelector.value);
        appSettings.currentUserId = selectedIndex;
        const selectedUser = userCharacters[selectedIndex];
        if (selectedUser) {
            appSettings.userAvatar = selectedUser.avatar;
        }
    }

    appSettings.charBubble = document.getElementById('set-char-bubble').value;
    appSettings.charText = document.getElementById('set-char-text').value;
    appSettings.userBubble = document.getElementById('set-user-bubble').value;
    appSettings.userText = document.getElementById('set-user-text').value;
    appSettings.interfaceColor = document.getElementById('set-interface-color').value;
    appSettings.msgNameColor = document.getElementById('set-msg-name-color').value;
    appSettings.msgTimeColor = document.getElementById('set-msg-time-color').value;
    appSettings.fontSize = parseInt(document.getElementById('set-font-size').value) || 14;
    appSettings.chatBtnText = document.getElementById('set-chat-btn-text').value;
    appSettings.blockChar = document.getElementById('set-block-char').checked;
    appSettings.blockUser = document.getElementById('set-block-user').checked;

    const chatBgUrl = document.getElementById('preview-chat-bg').src;
    if (chatBgUrl && chatBgUrl !== window.location.href) {
        appSettings.chatBg = chatBgUrl;
        appSettings.chatBgIsDark = await analyzeImageBrightness(appSettings.chatBg);
    }
    saveSettingsToStorage();
    applySettings();
    closeChatSettings();
    closeMenus();
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

    // 2. 从 localStorage 删除聊天记录
    try {
        const historyKey = `faye-phone-history-${currentChatTag}`;
        localStorage.removeItem(historyKey);
    } catch (e) {
        console.error("Failed to remove chat history from localStorage", e);
    }

    // 3. UI 跳转
    closeChatSettings();
    goBack(); // 回到消息列表
}

function closeModal() {
// If input modal is visible, close ONLY the input modal
if(modal && modal.classList.contains('show')) {
modal.classList.remove('show');
currentConfirmAction = null; // Cleanup current action
return;
}
// Chat settings modal logic removed since it's now a screen
currentConfirmAction = null;
}
function toBase64(file) { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.readAsDataURL(file); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('Failed to read file')); }); }

function closeMenus() {
if(actionMenu) actionMenu.classList.remove('open');
if(plusButton) plusButton.classList.remove('active');
if(emojiMenu) emojiMenu.classList.remove('open');
}

function initStickers() {
if(!emojiMenu) return;
emojiMenu.innerHTML = '';
const addBtn = document.createElement('div');
addBtn.className = 'sticker-item';
addBtn.onclick = handleAddSticker;
addBtn.innerHTML = `<div class="sticker-add-btn"><svg viewBox="0 0 24 24"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"></path></svg></div><span class="sticker-name">添加</span>`;
emojiMenu.appendChild(addBtn);

myStickerList.forEach((s, index) => {
const div = document.createElement('div');
div.className = 'sticker-item';
div.onclick = () => { if(!div.classList.contains('delete-mode')) sendSticker(s.name, s.url); };
div.innerHTML = `<img src="${s.url}" class="sticker-img"><span class="sticker-name">${s.name}</span>`;
addStickerLongPressHandler(div, index);
emojiMenu.appendChild(div);
});
}

function handleAddSticker() {
    openModal('添加表情包', [
        { placeholder: '粘贴图片链接 (支持批量,逗号分隔)', type: 'textarea', height: '60px' }
    ], async (values) => {
        const textInput = values[0];
        
        let addedCount = 0;

        // Handle Text Input (URLs)
        if (textInput) {
            const items = textInput.split(/[,，\n]+/);
            items.forEach(item => {
                item = item.trim();
                if(!item) return;
                // Support simple URL or Name+URL
                const match = item.match(/^(.*?)(https?:\/\/.*)$/);
                if(match) {
                    const name = match[1].trim() || '表情';
                    const url = match[2].trim();
                    myStickerList.unshift({ name, url });
                    addedCount++;
                } else if (item.startsWith('http')) {
                     // Just URL
                     myStickerList.unshift({ name: '表情', url: item });
                     addedCount++;
                } else {
                    // Try legacy format: Name + Filename
                    const legacyMatch = item.match(/^(.+?)([\w\-\.]+\.[a-zA-Z0-9]+)$/);
                    if (legacyMatch) {
                        const name = legacyMatch[1];
                        const suffix = legacyMatch[2];
                        const prefix = 'https://catbox.pengcyril.dpdns.org/';
                        myStickerList.unshift({ name: name, url: prefix + suffix });
                        addedCount++;
                    }
                }
            });
        }

        if(addedCount > 0) { saveStickers(); initStickers(); }
    });
}

function triggerBatchAddSticker() {
    openModal('批量添加表情包', [{
        placeholder: '支持两种格式：\n1. 名字+catbox后缀 (如: 开心s1wpw8.jpeg)\n2. 名字+完整URL (如: 开心https://...)\n用逗号或换行分隔多个',
        type: 'textarea',
        height: '150px'
    }], (values) => {
        const text = values[0];
        if (!text) return;
        
        const items = text.split(/[,，\n]+/);
        let count = 0;
        const prefix = 'https://catbox.pengcyril.dpdns.org/';
        
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
            alert('未识别到有效格式。');
        }
    });
}

function saveStickers() { localStorage.setItem('st-phone-stickers', JSON.stringify(myStickerList)); }

function addStickerLongPressHandler(el, index) {
let timer;
const start = (e) => {
if(e.target.closest('.delete-btn')) return;
el.classList.add('pressing');
timer = setTimeout(() => { el.classList.remove('pressing'); showStickerDeleteButton(el, index); }, 500);
};
const cancel = () => { clearTimeout(timer); el.classList.remove('pressing'); };
el.addEventListener('mousedown', start);
el.addEventListener('touchstart', start, {passive:true});
['mouseup','mouseleave','touchend','touchmove'].forEach(ev => el.addEventListener(ev, cancel));
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
else if (type === 'transfer') openModal('转账给对方', [{ placeholder: '金额 (如：¥ 520.00)' }, { placeholder: '备注 (可选)' }], (v) => sendTransfer(v[0], v[1]));
else if (type === 'file') openModal('发送文件', [{ placeholder: '文件名称 (如：报告.pdf)' }], (v) => sendFile(v[0]));
else if (type === 'voice') {
    openModal('发送语音', [{ placeholder: '时长 (秒)' }, { placeholder: '转文字内容' }], (v) => sendVoice(v[0], v[1]));
}
else if (type === 'settings') openChatSettings();
else if (type === 'photo') { if(photoInput) photoInput.click(); }
else if (type === 'call') { startVoiceCall(); }
else if (type === 'camera') { if(videoInput) videoInput.click(); }
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
modalTitle.textContent = title; modalInputsContainer.innerHTML = '';
fields.forEach(field => {
    let input;
    if (field.type === 'textarea') {
        input = document.createElement('textarea');
        input.className = 'modal-input';
        input.style.height = field.height || '100px';
        input.style.resize = 'vertical';
        input.style.fontFamily = 'inherit';
    } else if (field.type === 'file') {
        input = document.createElement('input');
        input.type = 'file';
        input.className = 'modal-input';
        if (field.accept) input.accept = field.accept;
    } else {
        input = document.createElement('input');
        input.type = 'text';
        input.className = 'modal-input';
    }
    input.placeholder = field.placeholder || '';
    if (field.value) input.value = field.value;
    modalInputsContainer.appendChild(input);
});
currentConfirmAction = confirmCallback; modal.classList.add('show');
}

async function sendLocation(addr) { try { const t = getTime(); const u = '{{user}}'; const h = appSettings.blockUser ? `[${u}|位置|${t}|!]` : `[${u}|位置|${t}]`; renderMessageToUI({ header: h, body: addr, isUser: true, type: 'location' }); } catch (e) {} }
async function sendTransfer(amt, note) { try { const t = getTime(); const u = '{{user}}'; const h = appSettings.blockUser ? `[${u}|TRANS|${t}|!]` : `[${u}|TRANS|${t}]`; renderMessageToUI({ header: h, body: `${amt}|${note||''}`, isUser: true, type: 'transfer' }); } catch (e) {} }
async function sendFile(fn) { try { const t = getTime(); const u = '{{user}}'; const h = appSettings.blockUser ? `[${u}|文件|${t}|!]` : `[${u}|文件|${t}]`; renderMessageToUI({ header: h, body: fn, isUser: true, type: 'file' }); } catch (e) {} }
async function sendVoice(dur, txt) { try { const t = getTime(); const u = '{{user}}'; const h = appSettings.blockUser ? `[${u}|语音|${t}|!]` : `[${u}|语音|${t}]`; renderMessageToUI({ header: h, body: `${dur}|${txt||''}`, isUser: true, type: 'voice' }); } catch (e) {} }
async function sendPhoto(base64) { try { const t = getTime(); const u = '{{user}}'; renderMessageToUI({ header: `[${u}|图片|${t}]`, body: base64, isUser: true, type: 'photo' }); } catch (e) {} }
async function sendRealAudio(url) { try { const t = getTime(); const u = '{{user}}'; renderMessageToUI({ header: `[${u}|语音|${t}]`, body: url, isUser: true, type: 'voice' }); } catch (e) {} }
async function sendVideo(url) { try { const t = getTime(); const u = '{{user}}'; renderMessageToUI({ header: `[${u}|视频|${t}]`, body: url, isUser: true, type: 'video' }); } catch (e) {} }


async function sendSticker(name, url) {
    let bodyText;
    if (url.startsWith('http') || url.startsWith('data:')) {
        bodyText = url;
    } else {
        const filename = url.split('/').pop();
        bodyText = name + filename;
    }
    const t = getTime();
    const u = '{{user}}';
    renderMessageToUI({ header: `[${u}|表情包|${t}]`, body: bodyText, isUser: true, type: 'sticker' });
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

// 记录是否刚发送了文件
let fileSent = false;

// 1. 处理文件上传 (如果有)
if (pendingFile) {
    fileSent = true;
    // Standalone mode: convert file to Base64 data URL
    try {
        const dataUrl = await toBase64(pendingFile);
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
if (text) {
    const t = getTime(); 
    const u = '{{user}}';
    // 如果被拉黑，在消息头中添加标记 (用于持久化)
    let header = `[${u}|${t}]`;
    if (appSettings.blockUser) {
        header = `[${u}|${t}|!]`; // ! 表示被拉黑/发送失败
    }
    renderMessageToUI({ header: header, body: text, isUser: true });
    messageInput.value = '';
    adjustTextareaHeight();
    messageInput.focus();
} 

// 3. 触发AI回复逻辑：只有输入框为空且本次没有发送文件时才触发AI
// AI generation is disabled in standalone mode.
// renderMessageList(); // 暂不刷新列表，避免跳动，sendMessage只更新当前聊天窗口
if (!text && !fileSent) {
    triggerGenerate();
}
}

function getTime() {
if (appSettings.timeOffset) {
    const now = new Date();
    const target = new Date(now.getTime() + appSettings.timeOffset);
    return `${target.getHours().toString().padStart(2,'0')}:${target.getMinutes().toString().padStart(2,'0')}`;
}
if (appSettings.customTime && /^\d{1,2}:\d{2}$/.test(appSettings.customTime)) return appSettings.customTime;
const now = new Date(); return `${now.getHours().toString().padStart(2,'0')}:${now.getMinutes().toString().padStart(2,'0')}`;
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
                
                const newBody = `${amount}|${originalNote}|received`;
                el.dataset.rawBody = newBody;
                overlay.classList.remove('visible'); setTimeout(() => overlay.remove(), 300);
                
                // Add system message
                const myName = '{{user}}';
                const sysMsg = `[${myName}|转账已接收]`;
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

                const newBody = `${amount}|${originalNote}|returned`;
                el.dataset.rawBody = newBody;
                overlay.classList.remove('visible'); setTimeout(() => overlay.remove(), 300);
                
                // Add system message
                const myName = '{{user}}';
                const sysMsg = `[${myName}|转账已退还]`;
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

function renderMessageToUI(msg) {
if(!chatMessages) return;
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
        const mainCharName = '{{char}}';
        // 如果没有 senderName，默认视为当前角色
        if (!senderName) senderName = mainCharName;
        
        if (senderName === currentChatTarget) isValid = true;
    }
    
    if (!isValid) return;
}

// NEW: 处理转账状态系统消息
// Check body OR header, and allow trailing characters (relaxed match)
const transferStatusMatch = (msg.body && msg.body.match(/\[(.*?)\|(转账已接收|转账已退还)\]/)) || (msg.header && msg.header.match(/\[(.*?)\|(转账已接收|转账已退还)\]/));
if (transferStatusMatch) {
    const row = document.createElement('div'); 
    row.className = 'message-row system';
    row.style.justifyContent = 'center';
    row.style.margin = '10px 0';
    
    const el = document.createElement('div');
    el.className = 'recall-notice'; // Reuse recall style
    el.style.fontSize = '12px';
    el.style.color = '#999';
    el.style.backgroundColor = 'rgba(0,0,0,0.05)';
    el.style.padding = '4px 12px';
    el.style.borderRadius = '10px';
    
    const name = transferStatusMatch[1];
    const isReceived = transferStatusMatch[2] === '转账已接收';
    const myName = '{{user}}';
    
    let displayText;
    if (name === myName) {
        displayText = isReceived ? '你已接收转账' : '你已退还转账';
    } else {
        displayText = isReceived ? '对方已接收转账' : '对方已退还转账';
    }
    
    el.textContent = displayText;
    // Ensure rawBody is set for persistence, even if command was in header
    el.dataset.rawBody = (msg.body && msg.body.trim()) ? msg.body : transferStatusMatch[0];
    
    if (msg.header) {
        el.dataset.fullHeader = msg.header;
    } else {
        const n = msg.isUser ? '{{user}}' : ('{{char}}');
        const t = getTime();
        el.dataset.fullHeader = `[${n}|${t}]`;
    }
    
    row.appendChild(el);
    chatMessages.appendChild(row);
    chatMessages.scrollTop = chatMessages.scrollHeight;

    // Auto-update previous transfer card status
    // Find the last transfer card sent by user that is pending
    const transfers = Array.from(chatMessages.querySelectorAll('.transfer-card.sent'));
    if (transfers.length > 0) {
        const lastTransfer = transfers[transfers.length - 1];
        const raw = lastTransfer.dataset.rawBody || '';
        // Check if it's already processed
        if (!raw.includes('|received') && !raw.includes('|returned')) {
            const status = transferStatusMatch[2] === '转账已接收' ? 'received' : 'returned';
            const statusText = status === 'received' ? '已收款' : '已退还';
            
            // Update UI
            lastTransfer.querySelector('.transfer-bottom').textContent = statusText;
            lastTransfer.classList.add('completed');
            lastTransfer.onclick = null;
            
            // Update Data
            const parts = raw.split('|');
            // Ensure we have amount|note|status
            const amount = parts[0] || '¥ 0.00';
            const originalNote = parts[1] || '转账给您';
            lastTransfer.dataset.rawBody = `${amount}|${originalNote}|${status}`;
            
        }
    }

    return;
}


// NEW: 处理撤回消息
if (msg.header && (msg.header.includes('|撤回|') || msg.header.includes('|RECALL'))) {
    const row = document.createElement('div');
    row.className = 'message-row system';
    row.style.justifyContent = 'center';
    row.style.margin = '10px 0';
    
    const el = document.createElement('div');
    el.className = 'recall-notice';
    el.style.fontSize = '12px';
    el.style.color = '#999';
    el.style.backgroundColor = 'rgba(0,0,0,0.05)';
    el.style.padding = '4px 12px';
    el.style.borderRadius = '10px';
    
    let displayName = msg.isUser ? '{{user}}' : '{{char}}';
    if (msg.header) {
         const parts = msg.header.replace(/^\[|\]$|^【|】$/g, '').split('|');
         if (parts.length > 0 && parts[0]) displayName = parts[0];
    }
    
    const isVoice = msg.header.includes('语音') || msg.header.includes('VOC');
    const typeText = isVoice ? '语音' : '信息';
    
    el.textContent = `${displayName}撤回了一条${typeText}`;
    if (msg.body && msg.body.trim()) {
        el.textContent += `：${msg.body}`;
    }
    el.dataset.fullHeader = msg.header;
    el.dataset.rawBody = msg.body;
    
    row.appendChild(el);
    chatMessages.appendChild(row);
    chatMessages.scrollTop = chatMessages.scrollHeight;
    return;
}

const row = document.createElement('div'); row.className = `message-row ${msg.isUser ? 'sent' : 'received'}`;

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
let displayName = msg.isUser ? ((appSettings.currentUserId !== undefined && userCharacters[appSettings.currentUserId]) ? userCharacters[appSettings.currentUserId].name : '{{user}}') : (currentChatTarget || '{{char}}');
if (msg.header) {
    const parts = msg.header.replace(/^[\[【]|[\]】]$/g, '').split('|');
    if (parts.length > 0 && parts[0]) displayName = parts[0];
}
const isGroupChat = currentChatTag && currentChatTag.startsWith('group:');
if (isGroupChat) {
    // 群聊模式：优先使用设置的成员头像
    if (msg.isUser) {
        avatarSrc = (appSettings.currentUserId !== undefined && userCharacters[appSettings.currentUserId]) ? userCharacters[appSettings.currentUserId].avatar : appSettings.userAvatar;
    } else if (appSettings.memberAvatars && appSettings.memberAvatars[displayName]) {
        avatarSrc = appSettings.memberAvatars[displayName];
    } else {
        // 默认头像
        avatarSrc = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0iI2IwYjBiMCI+PHJlY3Qgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0IiBmaWxsPSIjZjJmMmYyIi8+PHBhdGggZD0iTTEyIDEyYzIuMjEgMCA0LTEuNzkgNC00cy0xLjc5LTQtNC00LTQgMS43OS00IDQgMS43OS00IDQgNHptMCAyYy0yLjY3IDAtOCAxLjM0LTggNHYyaDE2di0yYzAtMi42Ni01LjMzLTQtOC00eiIvPjwvc3ZnPg==';
    }
} else {
    avatarSrc = msg.isUser ? appSettings.userAvatar : appSettings.charAvatar;
    // 尝试查找特定成员头像（仅私聊）
    if (!msg.isUser && appSettings.memberAvatars && appSettings.memberAvatars[displayName]) {
        avatarSrc = appSettings.memberAvatars[displayName];
    }
}
const avatar = document.createElement('img'); avatar.className = 'avatar'; avatar.src = avatarSrc;

const container = document.createElement('div'); container.className = 'msg-container';
const nameEl = document.createElement('div'); nameEl.className = 'msg-name';
nameEl.textContent = displayName;
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
const isDeliver = msg.type === 'deliver' || (msg.header && (msg.header.includes('|DELIVER|') || msg.header.includes('|ORDER|')));

const timeMatch = msg.header ? msg.header.match(/\|(\d{2}:\d{2})/) : null;
const timeStr = timeMatch ? timeMatch[1] : getTime();
const timeEl = document.createElement('div'); timeEl.className = 'msg-time'; timeEl.textContent = timeStr;

let displayBody = msg.body;
let displayThought = msg.thought || '';
if (!displayThought && displayBody) {
const thoughtMatch = displayBody.match(/^([\s\S]*?)\*([^\*]+)\*\s*$/);
if (thoughtMatch) { displayBody = thoughtMatch[1].trim(); displayThought = thoughtMatch[2].trim(); }
}

// Save original body for history persistence
const rawBodyForHistory = displayBody;

// Auto-detect Pollinations AI images or Markdown images OR <img> tag images
if (!isLoc && !isTra && !isFile && !isVoice && !isSticker && !isCallMsg && !isLink && !isDeliver) {
    if (/^!\[.*?\]\(.*?\)$/.test(displayBody) ||
        /^https?:\/\/image\.pollinations\.ai\/prompt\//.test(displayBody) ||
        /^<img>.*?<\/img>$/.test(displayBody)) {
        isPhoto = true;
        // Ensure header has |图片| tag for consistency
        if (msg.header && !msg.header.includes('图片') && !msg.header.includes('IMG')) {
            const parts = msg.header.replace(/^\[|\]$|^【|】$/g, '').split('|');
            if (parts.length >= 2) {
                const t = parts.pop();
                msg.header = `[${parts.join('|')}|图片|${t}]`;
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

// Quote Parsing
let quoteHtml = '';

// 1. Try New Format: [名字|REP|引用类型|时间]引用内容|回复内容
const newQuoteRegex = /^\[(.*?)\|REP\|(.*?)\|(.*?)\](.*?)\|(.*)$/s;
const newQuoteMatch = displayBody.match(newQuoteRegex);

if (newQuoteMatch) {
    const qName = newQuoteMatch[1];
    const qType = newQuoteMatch[2];
    const qTime = newQuoteMatch[3];
    const qContent = newQuoteMatch[4];
    const replyContent = newQuoteMatch[5];

    displayBody = replyContent.trim();
    
    quoteHtml = `<div class="msg-quote">
        <div class="msg-quote-content">
            <div style="display:flex;justify-content:space-between;opacity:0.7;font-size:12px;margin-bottom:2px;">
                <span>${qName}</span>
                <span>${qTime}</span>
            </div>
            <div style="color:#666;">${qContent}</div>
        </div>
    </div>`;
} else {
    // 2. Fallback to Old Format
    const quoteRegex = /「`回复 (.*?)[：:](.*?)`」/;
    const quoteMatch = displayBody.match(quoteRegex);
    if (quoteMatch) {
        const qName = quoteMatch[1];
        const qText = quoteMatch[2];
        // Remove quote from body
        displayBody = displayBody.replace(quoteMatch[0], '').trim();
        // Build Quote HTML
        quoteHtml = `<div class="msg-quote"><div class="msg-quote-content"><span style="font-weight:bold">回复 ${qName}：</span>${qText}</div></div>`;
    }
}

if (isLoc) {
    const parts = displayBody.split('|');
    const placeName = parts[0];
    const address = parts[1] || '';
    el = document.createElement('div'); el.className = `location-card ${msg.isUser ? 'sent' : 'received'}`;
    el.innerHTML = `<div class="location-info"><div class="location-name">${placeName}</div><div class="location-address" style="font-size:12px;opacity:0.8;margin-top:2px;">${address}</div></div><div class="location-map"><svg class="location-pin" viewBox="0 0 24 24"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"></path><circle cx="12" cy="9" r="2.5" fill="#fff"/></svg></div>`;
} else if (isTra) {
    const parts = displayBody.split('|');
    const amount = parts[0] || '¥ 0.00';
    let note = parts[1] || '转账给您';
    const status = parts[2] || 'pending';

    el = document.createElement('div'); el.className = `transfer-card ${msg.isUser ? 'sent' : 'received'}`;
    let statusText = '转账';
    if (status === 'received') { statusText = '已收款'; el.classList.add('completed'); }
    else if (status === 'returned') { statusText = '已退回'; el.classList.add('completed'); }

    el.innerHTML = `<div class="transfer-top"><div class="transfer-icon-circle"><svg viewBox="0 0 24 24"><path d="M7 10h14l-4-4"></path><path d="M17 14H3l4 4"></path></svg></div><div class="transfer-content"><div class="transfer-amount">${amount}</div><div class="transfer-note">${note}</div></div></div><div class="transfer-bottom">${statusText}</div>`;
    
    // Store raw body for history persistence
    el.dataset.rawBody = `${amount}|${parts[1] || '转账给您'}|${status}`;

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
    el = document.createElement('div'); el.className = `file-card ${msg.isUser ? 'sent' : 'received'}`;
    el.innerHTML = `<div class="file-info"><div class="file-name">${fileName}</div><div class="file-size">${fileSize}</div></div><div class="file-icon"><svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" fill="#eee"></path><polyline points="14 2 14 8 20 8" fill="#ddd"></polyline><text x="50%" y="18" font-size="6" fill="#888" text-anchor="middle" font-family="Arial">FILE</text></svg></div>`;
} else if (isLink) {
    const parts = displayBody.split('|');
    const title = parts[0] || 'Product';
    const price = parts[1] || '';
    const imgUrl = parts[2] || '';
    
    el = document.createElement('div'); el.className = `link-card ${msg.isUser ? 'sent' : 'received'}`;
    el.innerHTML = `
        <div class="link-content">
            <div class="link-title">${title}</div>
            <div class="link-price">${price}</div>
        </div>
        <div class="link-image">
            ${imgUrl ? `<img src="${imgUrl}" onerror="this.style.display='none'">` : '<div class="link-placeholder">LINK</div>'}
        </div>
    `;
} else if (isDeliver) {
    const parts = displayBody.split('|');
    const shopName = parts[0] || 'Delivery';
    const summary = parts[1] || '';
    const total = parts[2] || '';
    
    el = document.createElement('div'); el.className = `deliver-card ${msg.isUser ? 'sent' : 'received'}`;
    el.innerHTML = `
        <div class="deliver-top">
            <div class="deliver-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path><polyline points="9 22 9 12 15 12 15 22"></polyline></svg></div>
            <div class="deliver-shop">${shopName}</div>
        </div>
        <div class="deliver-mid">
            <div class="deliver-summary">${summary}</div>
        </div>
        <div class="deliver-bottom">
            <div class="deliver-total">${total}</div>
        </div>
    `;
} else if (isCallMsg) {
    el = document.createElement('div');
    el.className = `bubble ${msg.isUser ? 'bubble-sent' : 'bubble-received'}`;
    // 小圆角长方形，无透明度
    el.style.borderRadius = '10px';
    el.style.opacity = '1';
    el.textContent = displayBody;
    
    if (msg.isUser) {
        el.style.backgroundColor = appSettings.userBubble;
        el.style.color = appSettings.userText;
    } else {
        el.style.backgroundColor = appSettings.charBubble;
        el.style.color = appSettings.charText;
    }
} else if (isVoice) {
    // 检查是否是真实音频URL (http开头或characters开头)
    if (displayBody.startsWith('http') || displayBody.startsWith('characters/') || displayBody.startsWith('UserUploads/') || displayBody.startsWith('/user/images/')) {
        el = document.createElement('div'); 
        el.className = `real-audio-card ${msg.isUser ? 'sent' : 'received'}`;
        // 为了安全和路径正确，如果是相对路径，可能需要补全。但在SillyTavern中相对路径通常是相对于根目录
        el.innerHTML = `<audio controls src="${displayBody}"></audio>`;
    } else {
        // 微信风格模拟语音气泡
        const parts = displayBody.split('|');
        const dur = Math.max(1, Math.min(45, parseInt(parts[0]) || 5));
        const txt = parts.slice(1).join('|');
        const minWidth = 66; // 最短气泡宽度（px）
        // 动态计算最大宽度：手机宽度的 65%
        const phoneW = (appSettings.phoneWidth && !isNaN(appSettings.phoneWidth)) ? parseInt(appSettings.phoneWidth) : 330;
        const maxWidth = phoneW * 0.65; 
        const width = Math.round(minWidth + (maxWidth - minWidth) * (dur / 45));
        
        // 创建容器
        const container = document.createElement('div');
        container.className = `voice-card-container ${msg.isUser ? 'sent' : 'received'}`;
        container.style.display = 'flex';
        container.style.flexDirection = 'column';
        container.style.gap = '0';
        
        // 创建语音条
        const voiceCard = document.createElement('div');
        voiceCard.className = `voice-card ${msg.isUser ? 'sent' : 'received'}`;
        voiceCard.style.width = width + 'px';
        voiceCard.style.cursor = 'pointer';
        
        // 声纹3~4根
        let waves = '';
        const barCount = 3 + Math.floor(Math.random()*2); // 3或4根
        for (let i = 0; i < barCount; i++) waves += `<div class="wave" style="height:${6 + Math.random()*14}px"></div>`;
        let barHtml = '';
        if (msg.isUser) {
            // user: 声纹在右，时长在左
            barHtml = `<div class="voice-bar" style="flex-direction: row-reverse; justify-content: flex-end;"><div class="voice-waves">${waves}</div><div class="voice-duration">${dur}"</div></div>`;
        } else {
            // char: 声纹在左，时长在右，整体靠右
            barHtml = `<div class="voice-bar" style="flex-direction: row; justify-content: flex-end;"><div class="voice-waves">${waves}</div><div class="voice-duration">${dur}"</div></div>`;
        }
        voiceCard.innerHTML = barHtml;
        
        // 创建文字气泡
        const textBubble = document.createElement('div');
        textBubble.className = `voice-text-bubble ${msg.isUser ? 'sent' : 'received'}`;
        textBubble.textContent = txt;
        textBubble.style.maxWidth = (phoneW * 0.6) + 'px';
        
        // 设置颜色
        if (msg.isUser) { 
            voiceCard.style.backgroundColor = appSettings.userBubble; 
            voiceCard.style.color = appSettings.userText;
            textBubble.style.backgroundColor = appSettings.userBubble;
            textBubble.style.color = appSettings.userText;
        }
        else { 
            voiceCard.style.backgroundColor = appSettings.charBubble; 
            voiceCard.style.color = appSettings.charText;
            textBubble.style.backgroundColor = appSettings.charBubble;
            textBubble.style.color = appSettings.charText;
        }
        
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
    el = document.createElement('div'); el.className = `sticker-bubble ${msg.isUser ? 'sent' : 'received'}`;
    let src = displayBody;
    
    // 优先尝试提取完整 URL
    const urlMatch = displayBody.match(/(https?:\/\/[^\s]+)/);
    if (urlMatch) {
        src = urlMatch[1];
    } else {
        // 否则尝试提取文件名后缀
        const fileMatch = displayBody.match(/([a-zA-Z0-9_-]+\.[a-zA-Z0-9]+)$/);
        if (fileMatch && !displayBody.startsWith('http')) { src = 'https://catbox.pengcyril.dpdns.org/' + fileMatch[1]; }
    }

    el.innerHTML = `<img src="${src}">`;
    el.dataset.stickerBody = displayBody;
} else if (isVideo) {
el = document.createElement('div'); el.className = `photo-card ${msg.isUser ? 'sent' : 'received'}`;
el.innerHTML = `<video src="${displayBody}" controls style="width:100%;border-radius:12px;"></video>`;
if (msg.isUser) { el.style.backgroundColor = appSettings.userBubble; }
else { el.style.backgroundColor = appSettings.charBubble; }
} else if (isPhoto) {
el = document.createElement('div'); el.className = `photo-card ${msg.isUser ? 'sent' : 'received'}`;
el.innerHTML = `<img src="${displayBody}">`;
if (msg.isUser) { el.style.backgroundColor = appSettings.userBubble; }
else { el.style.backgroundColor = appSettings.charBubble; }
} else {
el = document.createElement('div'); el.className = `bubble ${msg.isUser ? 'bubble-sent' : 'bubble-received'}`; 
el.innerHTML = quoteHtml + displayBody.replace(/\n/g, '<br>');
el.dataset.rawBody = rawBodyForHistory;
if (msg.isUser) { el.style.backgroundColor = appSettings.userBubble; el.style.color = appSettings.userText; }
else { el.style.backgroundColor = appSettings.charBubble; el.style.color = appSettings.charText; }
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
    const n = msg.isUser ? '{{user}}' : (currentChatTarget || '{{char}}');
    const t = getTime(); 
    const isPic = isPhoto;
    el.dataset.fullHeader = isPic ? `[${n}|图片|${t}]` : `[${n}|${t}]`; 
}

// 检查是否被拉黑
// 1. 如果是用户发的消息，且当前处于 Char拉黑User 状态 (appSettings.blockUser)，显示红色感叹号
// 2. 如果是Char发的消息，且当前处于 User拉黑Char 状态 (appSettings.blockChar)，显示红色感叹号
let isBlocked = false;
if (msg.isUser && appSettings.blockUser) isBlocked = true;
if (!msg.isUser && appSettings.blockChar) isBlocked = true;

// 检查消息头中是否已有标记 (持久化)
if (msg.header && msg.header.includes('!')) isBlocked = true;

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
wrapper.appendChild(el); wrapper.appendChild(metaContainer); container.appendChild(wrapper);

if (displayThought) {
const thoughtEl = document.createElement('div'); thoughtEl.className = 'msg-thought';
thoughtEl.textContent = displayThought; container.appendChild(thoughtEl);
}

row.appendChild(avatar); row.appendChild(container); chatMessages.appendChild(row); chatMessages.scrollTop = chatMessages.scrollHeight;
if (!isLoadingHistory) saveCurrentChatHistory();
}




function saveCurrentChatHistory() {
    if (isLoadingHistory || !currentChatTag || !chatMessages) return;

    const history = [];
    const messageElements = chatMessages.querySelectorAll('[data-full-header]');

    messageElements.forEach(el => {
        const row = el.closest('.message-row');
        const isUser = row ? row.classList.contains('sent') : (el.dataset.fullHeader && el.dataset.fullHeader.includes('{{user}}'));

        const msg = {
            header: el.dataset.fullHeader,
            body: el.dataset.rawBody || el.textContent,
            isUser: isUser
        };
        history.push(msg);
    });

    try {
        const key = `faye-phone-history-${currentChatTag}`;
        localStorage.setItem(key, JSON.stringify(history));
    } catch (e) {
        console.error("Failed to save chat history to localStorage", e);
    }
}

function loadInitialChat() {
    if (!chatMessages || !currentChatTag) return;
    chatMessages.innerHTML = '';

    const key = `faye-phone-history-${currentChatTag}`;
    const savedHistory = localStorage.getItem(key);

    if (savedHistory) {
        try {
            const history = JSON.parse(savedHistory);
            if (Array.isArray(history)) {
                isLoadingHistory = true;
                history.forEach(msg => {
                    renderMessageToUI(msg);
                });
                // Defer resetting the flag and scrolling to ensure all render calls are processed
                setTimeout(() => {
                    if(chatMessages) chatMessages.scrollTop = chatMessages.scrollHeight;
                    isLoadingHistory = false;
                }, 0);
            }
        } catch (e) {
            console.error("Failed to load or parse chat history from localStorage", e);
            isLoadingHistory = false; // Ensure flag is reset on error
        }
    }
}


function showTypingIndicator() {
const row = document.createElement('div'); row.id = 'typing-bubble'; row.className = 'message-row received';
const el = document.createElement('div'); el.className = 'bubble bubble-received typing-only';
el.innerHTML = '<div class="typing-dots"><span></span><span></span><span></span></div>';
el.style.backgroundColor = appSettings.charBubble;
row.appendChild(el); chatMessages.appendChild(row); chatMessages.scrollTop = chatMessages.scrollHeight;
// 点击气泡移除动画
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
function executeDelete(el) { const r = el.closest('.message-row'); r.style.transform = 'scale(0)'; setTimeout(async () => { r.remove(); clearDeleteButton(); saveCurrentChatHistory(); }, 200); }
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
        if(e.target.closest('.delete-btn') || e.target.closest('.msg-action-menu')) return;
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
    
    el.addEventListener('mousedown', start);
    el.addEventListener('touchstart', start, {passive:true});
    ['mouseup','mouseleave','touchend','touchmove'].forEach(ev => el.addEventListener(ev, cancel));
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

    // Delete (Always last)
    const btnDelete = document.createElement('div');
    btnDelete.className = 'msg-action-item';
    btnDelete.innerHTML = '<img src="https://api.iconify.design/carbon:delete.svg" class="msg-action-icon">';
    btnDelete.onclick = (e) => { e.stopPropagation(); executeDelete(el); closeMsgMenu(); };
    menu.appendChild(btnDelete);
    
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
    
    const timeEl = row.querySelector('.msg-time');
    const time = timeEl ? timeEl.textContent : getTime();

    let type = 'TXT';
    let content = '';

    if (el.classList.contains('bubble')) {
        type = 'TXT';
        content = el.textContent || '';
        content = content.replace(/\|/g, '｜'); // Sanitize separator
        if (content.length > 10) {
            content = content.substring(0, 10) + '...';
        }
    } else if (el.classList.contains('photo-card') || el.classList.contains('sticker-bubble')) {
        type = 'IMG';
        content = '[图片]';
    } else if (el.classList.contains('voice-card') || el.classList.contains('real-audio-card')) {
        type = 'VOC';
        content = '[语音]';
    } else if (el.classList.contains('location-card')) {
        type = 'LOC';
        content = '[位置]';
    } else if (el.classList.contains('transfer-card')) {
        type = 'TRA';
        content = '[转账]';
    } else if (el.classList.contains('file-card')) {
        type = 'FIL';
        content = '[文件]';
    } else if (el.querySelector('video') || (el.dataset.fullHeader && el.dataset.fullHeader.includes('视频'))) {
         type = 'VID';
         content = '[视频]';
    } else {
        type = 'TXT';
        content = el.textContent || '[消息]';
        content = content.replace(/\|/g, '｜');
        if (content.length > 10) content = content.substring(0, 10) + '...';
    }

    // Format: [名字|REP|引用类型|时间]引用内容|
    const quoteStr = `[${name}|REP|${type}|${time}]${content}|`;
    
    const input = document.getElementById('message-input');
    input.value = quoteStr + input.value;
    input.focus();
    adjustTextareaHeight();
}

function executeRegenerate(el) {
    // Remove the message bubble
    const row = el.closest('.message-row');
    if (row) {
        row.remove();
        // Remove from history (last message)
        if (currentChatTag) {
            const historyKey = `faye-phone-history-${currentChatTag}`;
            const savedHistory = localStorage.getItem(historyKey);
            if (savedHistory) {
                const history = JSON.parse(savedHistory);
                history.pop();
                localStorage.setItem(historyKey, JSON.stringify(history));
            }
        }
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
        currentText = el.querySelector('.voice-duration').textContent.replace('"','') + '|' + el.querySelector('.voice-text').textContent;
    } else if (el.classList.contains('photo-card') || el.classList.contains('sticker-bubble')) {
         const img = el.querySelector('img');
         if(img) currentText = img.src;
    }

    openModal('编辑消息', [{ placeholder: '输入新内容', value: currentText }], async (values) => {
        const newText = values[0];
        if (newText === undefined) return;
        
        if (el.classList.contains('bubble')) {
            // Re-parse quote logic
            let displayBody = newText;
            let quoteHtml = '';

            // 1. Try New Format
            const newQuoteRegex = /^\[(.*?)\|REP\|(.*?)\|(.*?)\](.*?)\|(.*)$/s;
            const newQuoteMatch = newText.match(newQuoteRegex);

            if (newQuoteMatch) {
                const qName = newQuoteMatch[1];
                const qType = newQuoteMatch[2];
                const qTime = newQuoteMatch[3];
                const qContent = newQuoteMatch[4];
                const replyContent = newQuoteMatch[5];

                displayBody = replyContent.trim();

                quoteHtml = `<div class="msg-quote">
                    <div class="msg-quote-content">
                        <div style="display:flex;justify-content:space-between;opacity:0.7;font-size:12px;margin-bottom:2px;">
                            <span>${qName}</span>
                            <span>${qTime}</span>
                        </div>
                        <div style="color:#666;">${qContent}</div>
                    </div>
                </div>`;
            } else {
                // 2. Fallback to Old Format
                const quoteRegex = /「`回复 (.*?)[：:](.*?)`」/;
                const quoteMatch = newText.match(quoteRegex);
                
                if (quoteMatch) {
                    const qName = quoteMatch[1];
                    const qText = quoteMatch[2];
                    displayBody = displayBody.replace(quoteMatch[0], '').trim();
                    quoteHtml = `<div class="msg-quote"><div class="msg-quote-content"><span style="font-weight:bold">回复 ${qName}：</span>${qText}</div></div>`;
                }
            }
            
            el.innerHTML = quoteHtml + displayBody.replace(/\n/g, '<br>');
            el.dataset.rawBody = newText;
        } else if (el.classList.contains('location-card')) {
            el.querySelector('.location-name').textContent = newText;
        } else if (el.classList.contains('file-card')) {
            el.querySelector('.file-name').textContent = newText;
        } else if (el.classList.contains('transfer-card')) {
            const parts = newText.split('|');
            if(parts[0]) el.querySelector('.transfer-amount').textContent = parts[0];
            if(parts[1]) el.querySelector('.transfer-note').textContent = parts[1] || '';
        } else if (el.classList.contains('voice-card')) {
             const parts = newText.split('|');
             const dur = parts[0] || '1';
             const txt = parts.slice(1).join('|');
             el.querySelector('.voice-duration').textContent = dur + '"';
             el.querySelector('.voice-text').textContent = txt;
             // Recalculate width
             const minWidth = 66; 
             const phoneW = (appSettings.phoneWidth && !isNaN(appSettings.phoneWidth)) ? parseInt(appSettings.phoneWidth) : 330;
             const maxWidth = phoneW * 0.65; 
             const width = Math.round(minWidth + (maxWidth - minWidth) * (Math.min(45, parseInt(dur)||1) / 45));
             el.style.width = width + 'px';
        } else if (el.classList.contains('photo-card') || el.classList.contains('sticker-bubble')) {
             const img = el.querySelector('img');
             if(img) img.src = newText;
        }
        
        saveCurrentChatHistory();
    });
}

function showDeleteButton(el) {
    showMessageActionMenu(el);
}
document.onclick = (e) => {
    if(activeDeleteBtn && !e.target.closest('.location-card, .transfer-card, .file-card, .bubble, .voice-card-container, .real-audio-card, .photo-card, .sticker-bubble')) clearDeleteButton();
    
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
        // 壁纸使用手机比例，头像使用 1:1
        if (currentSettingsUploadType === 'home-bg' || currentSettingsUploadType === 'chat-bg') {
            const w = parseInt(appSettings.phoneWidth) || 330;
            const h = parseInt(appSettings.phoneHeight) || 660;
            aspectRatio = w / h;
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
                appSettings.charAvatar = url;
                renderAvatarSettings();
                saveSettingsToStorage();
            } else if (currentSettingsUploadType === 'user-avatar') {
                appSettings.userAvatar = url;
                renderAvatarSettings();
                saveSettingsToStorage();
            } else if (currentSettingsUploadType === 'chat-bg') {
                appSettings.chatBg = url;
                const preview = document.getElementById('preview-chat-bg');
                if(preview) preview.src = url;
                saveSettingsToStorage();
            } else if (currentSettingsUploadType === 'home-bg') {
                appSettings.homeBg = url;
                const preview = document.getElementById('preview-home-bg');
                if(preview) preview.src = url;
                saveSettingsToStorage();
            } else if (currentSettingsUploadType === 'group-avatar') {
                if (!appSettings.groupAvatars) appSettings.groupAvatars = {};
                appSettings.groupAvatars[currentChatTag] = url;
                renderAvatarSettings();
                saveSettingsToStorage();
            } else if (currentSettingsUploadType && currentSettingsUploadType.startsWith('member:')) {
                const memberName = currentSettingsUploadType.split(':')[1];
                if (memberName) {
                    if (!appSettings.memberAvatars) appSettings.memberAvatars = {};
                    appSettings.memberAvatars[memberName] = url;
                    renderAvatarSettings();
                    saveSettingsToStorage();
                }
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
        try { npcCharacters = JSON.parse(storedNpcs); } catch(e) { npcCharacters = []; }
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
        listContainer.innerHTML = '<div class="user-list-empty"><div class="empty-icon">🎭</div><div>还没有角色哦~<br>点击右上角 + 创建一个吧</div></div>';
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
                    ${npc.worldbook ? '<span>📖 有世界书</span>' : ''}
                </div>
            </div>
            <div class="user-card-actions">
                <button onclick="editNpc(${index})">编辑</button>
                <button onclick="deleteNpc(${index})" class="delete">删除</button>
            </div>
        `;
        listContainer.appendChild(card);
    });
}

function openNpcCreatePage(index = null) {
    editingNpcIndex = index;
    const screen = document.getElementById('npc-create-screen');
    const titleEl = document.getElementById('npc-create-title');
    const avatarPreview = document.getElementById('npc-avatar-preview');
    const nameInput = document.getElementById('npc-name-input-page');
    const nicknameInput = document.getElementById('npc-nickname-input-page');
    const descInput = document.getElementById('npc-desc-input-page');
    const subNpcList = document.getElementById('npc-sub-npc-list');
    const worldbookSelect = document.getElementById('npc-worldbook-select');
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
        if (nicknameInput) nicknameInput.value = npc.nickname || '';
        if (descInput) descInput.value = npc.persona || npc.desc || '';
        const gender = npc.gender || 'female';
        const genderRadio = screen.querySelector(`input[name="npc-gender-page"][value="${gender}"]`);
        if (genderRadio) {
            genderRadio.checked = true;
            const label = genderRadio.closest('.uc-gender-option');
            if (label) label.classList.add('selected');
        }
        if (worldbookSelect) worldbookSelect.value = npc.worldbook || '';
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
        if (nicknameInput) nicknameInput.value = '';
        if (descInput) descInput.value = '';
        if (subNpcList) subNpcList.innerHTML = '';
        if (worldbookSelect) worldbookSelect.value = '';
        const femaleRadio = screen.querySelector('input[name="npc-gender-page"][value="female"]');
        if (femaleRadio) {
            femaleRadio.checked = true;
            const label = femaleRadio.closest('.uc-gender-option');
            if (label) label.classList.add('selected');
        }
    }

    populateNpcWorldbookSelect();
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

function populateNpcWorldbookSelect() {
    const select = document.getElementById('npc-worldbook-select');
    if (!select) return;
    select.innerHTML = '<option value="">不使用世界书</option>';
    const worldbooks = localStorage.getItem('faye-phone-worldbooks');
    if (worldbooks) {
        try {
            const list = JSON.parse(worldbooks);
            list.forEach(wb => {
                const opt = document.createElement('option');
                opt.value = wb.name;
                opt.textContent = wb.name;
                select.appendChild(opt);
            });
        } catch(e) {}
    }
    const defaultWb = localStorage.getItem('faye-phone-worldbook');
    if (defaultWb) {
        const opt = document.createElement('option');
        opt.value = '__default__';
        opt.textContent = '默认世界书';
        select.appendChild(opt);
    }
}

function updateNpcTokenCount() {
    const descInput = document.getElementById('npc-desc-input-page');
    const tokenEl = document.getElementById('npc-desc-token');
    if (!descInput || !tokenEl) return;
    tokenEl.textContent = estimateTokens(descInput.value) + ' tokens';
}

function saveNpc() {
    const avatar = document.getElementById('npc-avatar-preview').src;
    const name = (document.getElementById('npc-name-input-page').value || '').trim();
    const nickname = (document.getElementById('npc-nickname-input-page').value || '').trim();
    const desc = document.getElementById('npc-desc-input-page').value || '';
    const worldbook = (document.getElementById('npc-worldbook-select') || {}).value || '';
    if (!name) { alert('请输入角色姓名~'); return; }
    const genderRadio = document.querySelector('input[name="npc-gender-page"]:checked');
    const gender = genderRadio ? genderRadio.value : 'female';
    const npcs = [];
    document.querySelectorAll('#npc-sub-npc-list .uc-npc-card').forEach(card => {
        const npcName = (card.querySelector('.npc-name-input') || {}).value || '';
        const npcNickname = (card.querySelector('.npc-nickname-input') || {}).value || '';
        const npcGenderRadio = card.querySelector('input[name^="npc-gender-"]:checked');
        const npcGender = npcGenderRadio ? npcGenderRadio.value : 'female';
        const npcDesc = (card.querySelector('.npc-desc-input') || {}).value || '';
        if (npcName.trim()) npcs.push({ name: npcName.trim(), nickname: npcNickname.trim(), gender: npcGender, desc: npcDesc.trim() });
    });
    const npcData = { avatar, name, nickname, gender, persona: desc, worldbook, npcs };
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
        const reader = new FileReader();
        reader.onload = function(e) {
            document.getElementById('npc-avatar-preview').src = e.target.result;
        }
        reader.readAsDataURL(file);
    }
}

function addSubNpcToNpc() {
    const npcList = document.getElementById('npc-sub-npc-list');
    if (!npcList) return;
    renderNpcCard(npcList, null, npcList.children.length);
}

// Keep backward compatibility
function openCharacterSetup(tab) { openNpcSettings(); }
function switchSetupTab() {}
function openCharacterEditor() {}
function saveCharacterEditor() {}
function closeCharacterEditor() {}
function saveWorldBook() {}
function deleteCharacterFromSetup() {}
function handleEditorAvatarChange() {}

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
        listContainer.innerHTML = '<div class="user-list-empty"><div class="empty-icon">🎀</div><div>还没有角色哦~<br>点击右上角 + 创建一个吧</div></div>';
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
                    ${user.worldbook ? '<span>📖 有世界书</span>' : ''}
                </div>
            </div>
            <div class="user-card-actions">
                <button onclick="editUser(${index})">编辑</button>
                <button onclick="deleteUser(${index})" class="delete">删除</button>
            </div>
        `;
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
    const worldbookSelect = document.getElementById('user-worldbook-select');
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
        const genderRadio = document.querySelector(`input[name="user-gender"][value="${gender}"]`);
        if (genderRadio) {
            genderRadio.checked = true;
            const label = genderRadio.closest('.uc-gender-option');
            if (label) label.classList.add('selected');
        }
        if (worldbookSelect) worldbookSelect.value = user.worldbook || '';
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
        if (npcList) npcList.innerHTML = '';
        if (worldbookSelect) worldbookSelect.value = '';
        const femaleRadio = document.querySelector('input[name="user-gender"][value="female"]');
        if (femaleRadio) {
            femaleRadio.checked = true;
            const label = femaleRadio.closest('.uc-gender-option');
            if (label) label.classList.add('selected');
        }
    }

    populateWorldbookSelect();
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

function populateWorldbookSelect() {
    const select = document.getElementById('user-worldbook-select');
    if (!select) return;
    select.innerHTML = '<option value="">不使用世界书</option>';
    const worldbooks = localStorage.getItem('faye-phone-worldbooks');
    if (worldbooks) {
        try {
            const list = JSON.parse(worldbooks);
            list.forEach(wb => {
                const opt = document.createElement('option');
                opt.value = wb.name;
                opt.textContent = wb.name;
                select.appendChild(opt);
            });
        } catch(e) {}
    }
    const defaultWb = localStorage.getItem('faye-phone-worldbook');
    if (defaultWb) {
        const opt = document.createElement('option');
        opt.value = '__default__';
        opt.textContent = '默认世界书';
        select.appendChild(opt);
    }
}

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
    tokenEl.textContent = estimateTokens(descInput.value) + ' tokens';
}

function saveUser() {
    const avatar = document.getElementById('user-avatar-preview').src;
    const name = (document.getElementById('user-name-input').value || '').trim();
    const desc = document.getElementById('user-desc-input').value || '';
    const worldbook = (document.getElementById('user-worldbook-select') || {}).value || '';
    if (!name) { alert('请输入角色昵称~'); return; }
    const genderRadio = document.querySelector('input[name="user-gender"]:checked');
    const gender = genderRadio ? genderRadio.value : 'female';
    const npcs = [];
    document.querySelectorAll('#user-npc-list .uc-npc-card').forEach(card => {
        const npcName = (card.querySelector('.npc-name-input') || {}).value || '';
        const npcNickname = (card.querySelector('.npc-nickname-input') || {}).value || '';
        const npcGenderRadio = card.querySelector('input[name^="npc-gender-"]:checked');
        const npcGender = npcGenderRadio ? npcGenderRadio.value : 'female';
        const npcDesc = (card.querySelector('.npc-desc-input') || {}).value || '';
        if (npcName.trim()) npcs.push({ name: npcName.trim(), nickname: npcNickname.trim(), gender: npcGender, desc: npcDesc.trim() });
    });
    const user = { avatar, name, gender, persona: desc, worldbook, npcs };
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
        const reader = new FileReader();
        reader.onload = function(e) {
            document.getElementById('user-avatar-preview').src = e.target.result;
        }
        reader.readAsDataURL(file);
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
        <button class="npc-remove-btn" onclick="this.closest('.uc-npc-card').remove()">×</button>
        <div class="npc-row">
            <div class="npc-field"><label>姓名</label><input type="text" class="npc-name-input" placeholder="NPC名字" value="${npc ? npc.name : ''}"></div>
            <div class="npc-field"><label>昵称</label><input type="text" class="npc-nickname-input" placeholder="可选" value="${npc ? (npc.nickname||'') : ''}"></div>
        </div>
        <div class="npc-field"><label>性别</label>
            <div class="npc-gender-mini">
                <label class="${isFemale?'selected':''}" data-value="female"><input type="radio" name="${uid}" value="female" ${isFemale?'checked':''}> 女</label>
                <label class="${isMale?'selected':''}" data-value="male"><input type="radio" name="${uid}" value="male" ${isMale?'checked':''}> 男</label>
            </div>
        </div>
        <div class="npc-field"><label>简单人设</label><textarea class="npc-desc-input" placeholder="简单描述这个NPC...">${npc ? (npc.desc||'') : ''}</textarea></div>
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

function init() {
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
    sendButton.addEventListener('mousedown', function(e) { e.preventDefault(); });
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
homeClockEl = document.getElementById('home-clock');
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
if(photoInput) photoInput.addEventListener('change', async (e) => {
    if (e.target.files && e.target.files[0]) {
        handleFileSelect(e.target.files[0]);
        e.target.value = ''; // Reset for re-selection
        closeMenus(); // Close action menu
    }
});

// 音频上传
if(audioInput) audioInput.addEventListener('change', async (e) => {
    if (e.target.files && e.target.files[0]) {
        handleFileSelect(e.target.files[0]);
        e.target.value = '';
        closeMenus();
    }
});

// 视频上传
if(videoInput) videoInput.addEventListener('change', async (e) => {
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

// NPC desc token count
const npcDescInput = document.getElementById('npc-desc-input-page');
if (npcDescInput) npcDescInput.addEventListener('input', updateNpcTokenCount);

if(plusButton) plusButton.addEventListener('click', () => {
if (actionMenu.classList.contains('open')) closeMenus();
else { closeMenus(); actionMenu.classList.add('open'); plusButton.classList.add('active'); clearDeleteButton(); setTimeout(() => chatMessages.scrollTop = chatMessages.scrollHeight, 300); }
});
if(emojiButton) emojiButton.addEventListener('click', () => {
if (emojiMenu.classList.contains('open')) closeMenus();
else { closeMenus(); emojiMenu.classList.add('open'); setTimeout(() => chatMessages.scrollTop = chatMessages.scrollHeight, 300); }
});
if(messageInput) {
messageInput.addEventListener('focus', closeMenus);
messageInput.oninput = adjustTextareaHeight;
messageInput.onkeydown = (e) => { if(e.key==='Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } };
}
if(sendButton) sendButton.onclick = sendMessage;
if(modalConfirmBtn) modalConfirmBtn.onclick = (e) => {
    if(e) e.preventDefault();
    if (currentConfirmAction) {
        const inputs = modalInputsContainer.querySelectorAll('input, textarea');
        const values = Array.from(inputs).map(i => {
            if (i.type === 'file') return i.files[0];
            return i.value.trim();
        });
        if (values.some(v => v)) {
            currentConfirmAction(values);
            // Only remove the 'show' class from the input modal, explicitly do not call closeModal
            if(modal) modal.classList.remove('show');
            currentConfirmAction = null; // Clean up immediately after execution
        } else {
            console.log('[FayePhone] No values detected');
        }
    }
};

loadSettings();
loadUsers();
loadNpcData();
const savedStickers = localStorage.getItem('st-phone-stickers');
myStickerList = savedStickers ? JSON.parse(savedStickers) : defaultStickerList;
const defaultAvatar = "data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='%23cccccc'%3E%3Cpath d='M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z'/%3E%3C/svg%3E";
if(!appSettings.charAvatar) appSettings.charAvatar = defaultAvatar;
if(!appSettings.userAvatar) appSettings.userAvatar = defaultAvatar;
applySettings();
// Character-specific logic removed for standalone version
updateClock();
initStickers();
setInterval(updateClock, 1000);
// DEPRECATED: Character change check removed for standalone version
try { loadInitialChat(); setTimeout(loadInitialChat, 500); } catch(e){}
checkUpdate(); // Check for updates
}

// Attach globally
window.openChat = openChat;
window.openMessageList = openMessageList;
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

// Initialize on Load
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { init(); setScreenDisplay(); });
} else {
    init(); setScreenDisplay();
}

function setScreenDisplay(screenId = 'home-screen') {
    // Hide all screens first
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
    if (document.getElementById('call-screen')) document.getElementById('call-screen').style.display = 'none';

    // Show the requested screen
    const screenToShow = document.getElementById(screenId);
    if (screenToShow) {
        screenToShow.style.display = 'flex';
    }

    updateStatusBar(screenId);
}

// Voice Call Logic
let isCalling = false;
let callTimerInterval = null;
let callSeconds = 0;
let callConnectionTimeout = null;
let isWaitingForCallResponse = false; // NEW: Wait for AI response to decide connection

function connectVoiceCall() {
    if (!isCalling) return;
    isWaitingForCallResponse = false;
    
    const timerEl = document.getElementById('call-timer');
    const textEl = document.getElementById('call-char-text');
    
    // Connected
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
    if (callTimerInterval) clearInterval(callTimerInterval);
    callTimerInterval = setInterval(() => {
        callSeconds++;
        const m = Math.floor(callSeconds / 60).toString().padStart(2, '0');
        const s = (callSeconds % 60).toString().padStart(2, '0');
        if (timerEl) timerEl.textContent = `${m}:${s}`;
    }, 1000);
}


function startVoiceCall(isIncoming = false) {
    closeMenus();
    const callScreen = document.getElementById('call-screen');
    const nameEl = document.getElementById('call-name');
    const avatarEl = document.getElementById('call-avatar');
    const textEl = document.getElementById('call-char-text');
    const timerEl = document.getElementById('call-timer');
    
    if (!callScreen) return;
    
    // Set Info
    const targetName = currentChatTarget || '{{char}}';
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
        // Direct Connect for Incoming Call
        if (timerEl) {
            timerEl.textContent = '00:00';
            timerEl.style.opacity = '1';
        }
        if (textEl) {
            textEl.textContent = '通话中';
            textEl.style.fontSize = '12px';
            textEl.style.opacity = '0.8';
        }
        
        // Start Timer Immediately
        callTimerInterval = setInterval(() => {
            callSeconds++;
            const m = Math.floor(callSeconds / 60).toString().padStart(2, '0');
            const s = (callSeconds % 60).toString().padStart(2, '0');
            if (timerEl) timerEl.textContent = `${m}:${s}`;
        }, 1000);

        // Trigger AI Greeting (Incoming Call Context)
        showCallTyping();
        
        const prompt = `System: {{user}} is calling you. Output [拒接通话] format to reject, or [通话] format to accept.
[系统指令] {{user}} 正在给你打电话。
请决定是接听还是拒接。
如果要拒接，请输出包含 [拒接通话] 的内容。
如果要接听，请输出包含 [通话] 的内容，并开始对话。
回复格式要求：
1. 必须是语音通话的口吻，简短、口语化。
2. 禁止输出心声或动作描写（除非是声音描写）。
3. 声音描写（如笑声、叹气）请用括号包裹。
你的回复将直接显示在通话字幕中。`;
        
        // [修复] 使用 runSunboxGenerate 替代 generate
        // AI generation is disabled in standalone mode.

    } else {
        // Outgoing Call Logic (Dialing)
        if (timerEl) {
            timerEl.textContent = '正在拨打...';
            timerEl.style.opacity = '0.6';
        }
        if (textEl) {
            textEl.innerHTML = '等待接听<span class="jumping-dot">.</span><span class="jumping-dot">.</span><span class="jumping-dot">.</span>';
        }

        // Wait for AI response to decide connection
        isWaitingForCallResponse = true;

        // Trigger AI Greeting (Outgoing Call Context)
        showCallTyping();
        
        const prompt = `[系统指令] {{user}} 正在给你打电话。
请决定是接听还是拒接。
如果要拒接，请输出包含 [拒接通话] 的内容。
如果要接听，请输出包含 [通话] 的内容，并开始对话。
回复格式要求：
1. 必须是语音通话的口吻，简短、口语化。
2. 禁止输出心声或动作描写（除非是声音描写）。
3. 声音描写（如笑声、叹气）请用括号包裹。
你的回复将直接显示在通话字幕中。`;
        
        // AI generation is disabled in standalone mode.
        // For standalone, we can simulate an auto-connect or auto-reject.
        // Let's auto-connect for now.
        callConnectionTimeout = setTimeout(connectVoiceCall, 2000); // Simulate connection after 2s
    }

function connectVoiceCall() {
    const timerEl = document.getElementById('call-timer');
    const textEl = document.querySelector('#call-screen .jumping-dot')?.parentNode || document.getElementById('call-timer').nextElementSibling; // Fallback

    // Connected UI Update
    if (timerEl) {
        timerEl.textContent = '00:00';
        timerEl.style.opacity = '1';
    }
    // Try to find the status text element more reliably if needed, or just update what we can
    // Note: In the original code, textEl was defined in startVoiceCall scope.
    // We need to re-select it or pass it. For now, let's assume we can find it or just skip if not found.
    // Actually, let's look at startVoiceCall again. textEl is not global.
    // We can select it by content or structure.
    // The structure is: call-timer -> div (status text)
    
    const statusDiv = document.getElementById('call-timer').nextElementSibling;
    if (statusDiv) {
        statusDiv.textContent = '对方已接通';
        statusDiv.style.fontSize = '12px';
        statusDiv.style.opacity = '0.8';
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
    
    updateStatusBar('dark-search'); // Use dark status bar style
}

function addCallBubble(text, isUser) {
    const container = document.getElementById('call-chat-container');
    if (!container) return;
    
    const bubble = document.createElement('div');
    bubble.className = `call-bubble ${isUser ? 'sent' : 'received'}`;
    bubble.innerHTML = text; // Use innerHTML to support HTML content like typing indicator
    
    container.appendChild(bubble);
    container.scrollTop = container.scrollHeight;
    return bubble;
}

function showCallTyping() {
    const container = document.getElementById('call-chat-container');
    if (!container) return;
    // Remove existing typing indicator if any
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

function endVoiceCall(reason) {
    const callScreen = document.getElementById('call-screen');
    if (callScreen) callScreen.style.display = 'none';
    
    isCalling = false;
    if (callTimerInterval) clearInterval(callTimerInterval);
    if (callConnectionTimeout) clearTimeout(callConnectionTimeout);
    
    // Stop AI Generation if active
    // AI generation related features are removed.
    
    // Add system message to chat
    let bodyText = "";
    if (reason === 'rejected') {
        bodyText = "对方已拒绝";
    } else if (callSeconds > 0) {
        const m = Math.floor(callSeconds / 60).toString().padStart(2, '0');
        const s = (callSeconds % 60).toString().padStart(2, '0');
        bodyText = `通话结束，时长：${m}:${s}`;
    } else {
        bodyText = "通话取消";
    }
    
    const t = getTime();
    const u = '{{user}}';
    
    // Save to history
    renderMessageToUI({ header: `[${u}|通话|${t}]`, body: bodyText, isUser: true });
    
    updateStatusBar('chat');
}

function sendCallMessage() {
    const input = document.getElementById('call-input');
    if (!input) return;
    const text = input.value.trim();
    // Allow empty text to trigger AI response (silence)
    
    input.value = '';
    
    // Show User Message in Call Screen (Only if text is not empty)
    if (text) {
        addCallBubble(text, true);
    }
    
    // Show Thinking Animation
    showCallTyping();
    
    // Trigger AI
    const t = getTime();
    const cn = currentChatTarget || '{{char}}';
    
    let userActionDesc = `用户说：“${text}”。`;
    if (!text) {
        userActionDesc = `用户保持了沉默（没有说话）。`;
    }

    const prompt = `[系统指令] 当前正在与用户进行语音通话。
    ${userActionDesc}
    请以语音通话的口吻回复，内容要简短、口语化。
    禁止输出心声。
    包含语音内容和声音描写（如笑声、叹气等），用括号包裹声音描写。
    你的回复将直接显示在通话界面的字幕中。`;
    
    const u = '{{user}}';
    // Only log to history if text is not empty
    if (text) {
        renderMessageToUI({ header: `[${u}|通话|${t}]`, body: text, isUser: true });
    }
    
    // [修复] 使用 runSunboxGenerate 替代 generate
    // AI generation is disabled in standalone mode.
    // Simulate a response after a short delay.
    setTimeout(() => {
        hideCallTyping();
        addCallBubble("(沉默)", false);
    }, 1500);
}

// Incoming Call Logic
function receiveVoiceCall() {
    const incomingScreen = document.getElementById('incoming-call-screen');
    const nameEl = document.getElementById('incoming-call-name');
    const avatarEl = document.getElementById('incoming-call-avatar');
    
    if (!incomingScreen) return;
    
    const targetName = currentChatTarget || '{{char}}';
    if (nameEl) nameEl.textContent = targetName;
    
    let avatarSrc = appSettings.charAvatar;
    if (appSettings.memberAvatars && appSettings.memberAvatars[targetName]) {
        avatarSrc = appSettings.memberAvatars[targetName];
    }
    if (avatarEl) avatarEl.src = avatarSrc;
    
    incomingScreen.style.display = 'flex';
    updateStatusBar('dark-search');
}

function acceptIncomingCall() {
    const incomingScreen = document.getElementById('incoming-call-screen');
    if (incomingScreen) incomingScreen.style.display = 'none';
    
    // Start call directly (skip dialing)
    startVoiceCall(true);
}

// 4. 替换原有的 declineIncomingCall 函数
function declineIncomingCall() {
    const incomingScreen = document.getElementById('incoming-call-screen');
    if (incomingScreen) incomingScreen.style.display = 'none';
    if (typeof updateStatusBar === 'function') updateStatusBar('chat');
    
    const t = typeof getTime === 'function' ? getTime() : new Date().toLocaleTimeString();
    const u = '{{user}}';
    if (typeof renderMessageToUI === 'function') {
        renderMessageToUI({ header: `[${u}|${t}]`, body: `已拒绝通话`, isUser: true });
    }
    
    // AI generation is disabled in standalone mode.
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
        if (key) headers['Authorization'] = `Bearer ${key}`;

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
        if (appSettings.systemPrompt) {
            messages.push({ role: 'system', content: appSettings.systemPrompt + "\n\n[System Note: You must hide your thinking process. Do not output <think> tags or reasoning content. Start your response directly. To send multiple separate message bubbles, use the delimiter '|||' to separate them.]" });
        } else {
             messages.push({ role: 'system', content: "You must hide your thinking process. Do not output <think> tags or reasoning content. Start your response directly. To send multiple separate message bubbles, use the delimiter '|||' to separate them." });
        }

        // Chat History (Last 20 messages)
        // We need to reconstruct history from DOM or memory.
        // Using 'conversations' array might be better but it only has lastMsg.
        // Let's use localStorage history for current chat.
        if (currentChatTag) {
            const historyKey = `faye-phone-history-${currentChatTag}`;
            const savedHistory = localStorage.getItem(historyKey);
            if (savedHistory) {
                const history = JSON.parse(savedHistory);
                const recent = history.slice(-20); // Last 20
                
                recent.forEach(msg => {
                    const role = (msg.header && msg.header.includes('{{user}}')) || msg.isUser ? 'user' : 'assistant';
                    let content = msg.body;
                    
                    // Handle special message types for context
                    if (msg.type === 'photo') {
                        // If it's a photo, we can't easily send old base64s if they are huge.
                        // For now, replace with placeholder text unless it's the very last message
                        content = '[发送了一张图片]';
                    } else if (msg.type === 'sticker') {
                        content = `[发送了表情包: ${msg.body}]`;
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
                const txtContent = messages[lastUserMsgIndex].content === '[发送了一张图片]' ? '' : messages[lastUserMsgIndex].content;
                messages[lastUserMsgIndex].content = [
                    { type: "text", text: txtContent || "Analyze this image" },
                    { type: "image_url", image_url: { url: lastUploadedImageForAI } }
                ];
            }
            lastUploadedImageForAI = null; // Reset
        }

        // 2. Call API
        const stream = await callLLM(messages);
        
        // 3. Handle Stream
        await handleGenerationResponse(stream);

    } catch (e) {
        console.error('Generation failed:', e);
        // Remove typing indicator
        const typing = document.querySelector('.message-row.received .typing-indicator');
        if (typing) typing.closest('.message-row').remove();
        
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
    
    // Remove typing indicator
    const typing = document.querySelector('.message-row.received .typing-indicator');
    if (typing) typing.closest('.message-row').remove();

    const u = currentChatTarget || '{{char}}';
    let avatarSrc = appSettings.charAvatar;
    if (appSettings.memberAvatars && appSettings.memberAvatars[u]) {
        avatarSrc = appSettings.memberAvatars[u];
    }

    // Helper to create a new bubble
    let currentContentSpan = null;

    function createNewBubble() {
        const row = document.createElement('div');
        row.className = 'message-row received';

        const avatar = document.createElement('img');
        avatar.className = 'avatar';
        avatar.src = avatarSrc;

        const container = document.createElement('div');
        container.className = 'msg-container';

        const nameEl = document.createElement('div');
        nameEl.className = 'msg-name';
        nameEl.textContent = u;
        container.appendChild(nameEl);

        const wrapper = document.createElement('div');
        wrapper.className = 'msg-wrapper';

        const bubble = document.createElement('div');
        bubble.className = 'bubble bubble-received';
        bubble.style.backgroundColor = appSettings.charBubble;
        bubble.style.color = appSettings.charText;

        const contentSpan = document.createElement('span');
        bubble.appendChild(contentSpan);

        wrapper.appendChild(bubble);

        // Meta (Time)
        const metaContainer = document.createElement('div');
        metaContainer.className = 'msg-meta';
        const timeEl = document.createElement('span');
        timeEl.className = 'msg-time';
        timeEl.textContent = getTime();
        metaContainer.appendChild(timeEl);

        wrapper.appendChild(metaContainer);
        container.appendChild(wrapper);
        row.appendChild(avatar);
        row.appendChild(container);
        chatMessages.appendChild(row);
        chatMessages.scrollTop = chatMessages.scrollHeight;

        currentContentSpan = contentSpan;
        
        // Add long press handler
        if (typeof addLongPressHandler === 'function') addLongPressHandler(bubble);
    }

    // Create first bubble
    createNewBubble();

    let fullText = '';
    let isThinking = false;
    let streamBuffer = '';
    let contentBuffer = '';

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        const chunk = decoder.decode(value, { stream: true });
        streamBuffer += chunk;
        
        const lines = streamBuffer.split('\n');
        streamBuffer = lines.pop(); // Keep incomplete line
        
        for (const line of lines) {
            if (line.startsWith('data: ')) {
                const dataStr = line.slice(6);
                if (dataStr === '[DONE]') continue;
                
                try {
                    const data = JSON.parse(dataStr);
                    const delta = data.choices[0].delta;
                    
                    // 1. Ignore explicit reasoning_content (DeepSeek R1)
                    if (delta.reasoning_content) {
                        continue;
                    }

                    // 2. Handle content
                    if (delta.content) {
                        contentBuffer += delta.content;
                        
                        // Process contentBuffer
                        while (true) {
                            if (!isThinking) {
                                const startIdx = contentBuffer.indexOf('<think>');
                                const splitIdx = contentBuffer.indexOf('|||');
                                
                                // Priority: <think> hides content. ||| splits content.
                                if (startIdx !== -1 && (splitIdx === -1 || startIdx < splitIdx)) {
                                    // Found <think> start
                                    fullText += contentBuffer.substring(0, startIdx);
                                    currentContentSpan.textContent = fullText;
                                    
                                    contentBuffer = contentBuffer.substring(startIdx + 7);
                                    isThinking = true;
                                } else if (splitIdx !== -1) {
                                    // Found ||| delimiter
                                    fullText += contentBuffer.substring(0, splitIdx);
                                    currentContentSpan.textContent = fullText;
                                    
                                    contentBuffer = contentBuffer.substring(splitIdx + 3);
                                    fullText = ''; // Reset for new bubble
                                    createNewBubble();
                                } else {
                                    // Check for partial tags
                                    const lastOpen = contentBuffer.lastIndexOf('<');
                                    const possibleThink = lastOpen !== -1 && lastOpen > contentBuffer.length - 7;
                                    
                                    const lastPipe = contentBuffer.lastIndexOf('|');
                                    const possibleSplit = lastPipe !== -1 && lastPipe > contentBuffer.length - 3;
                                    
                                    if (possibleThink || possibleSplit) {
                                        // Flush safe part
                                        let safeEnd = Math.min(
                                            possibleThink ? lastOpen : contentBuffer.length,
                                            possibleSplit ? lastPipe : contentBuffer.length
                                        );
                                        
                                        if (safeEnd > 0) {
                                            fullText += contentBuffer.substring(0, safeEnd);
                                            currentContentSpan.textContent = fullText;
                                            contentBuffer = contentBuffer.substring(safeEnd);
                                        }
                                        break; // Wait for more data
                                    } else {
                                        // Safe to flush all
                                        fullText += contentBuffer;
                                        currentContentSpan.textContent = fullText;
                                        contentBuffer = '';
                                        break;
                                    }
                                }
                            } else {
                                // In thinking mode - discard content
                                const endIdx = contentBuffer.indexOf('</think>');
                                if (endIdx !== -1) {
                                    contentBuffer = contentBuffer.substring(endIdx + 8);
                                    isThinking = false;
                                } else {
                                    // Check partial end tag
                                    const lastOpen = contentBuffer.lastIndexOf('<');
                                    if (lastOpen !== -1 && lastOpen > contentBuffer.length - 8) {
                                        contentBuffer = contentBuffer.substring(lastOpen);
                                    } else {
                                        contentBuffer = '';
                                    }
                                    break;
                                }
                            }
                        }
                        chatMessages.scrollTop = chatMessages.scrollHeight;
                    }

                } catch (e) {
                    // console.error('Parse error', e);
                }
            }
        }
    }
    
    // Save to history
    saveCurrentChatHistory();
}

    // Expose functions to global scope for HTML onclick handlers
    Object.assign(window, {
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
        declineIncomingCall,
        acceptIncomingCall,
        closeCropper,
        confirmCrop,
        closeSettings,
        closeChatSettings,
        closeUpdateModal,
        openAddContactModal,
        sendSticker,
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
        saveApiSettings,
        exportAllData,
        importAllData,
        clearAllData
    });

})();
