/**
 * sw.js — 砖头机 Service Worker
 * 
 * 职责：
 * 1. 监听 push 事件 → 弹出系统通知（后台/锁屏也能收到）
 * 2. 监听 notificationclick → 打开/聚焦到应用页面
 * 3. 提供 showNotification 消息通道 → 主线程可随时触发通知
 * 
 * 注意事项：
 * - iOS 16.4+ 必须「添加到主屏幕」后才支持 SW 通知
 * - Android Chrome 完全支持
 * - 桌面浏览器完全支持
 */

// ====== Push 事件 ======
// 当服务器推送消息时触发（需要 Web Push 后端配合，预留接口）
self.addEventListener('push', (event) => {
    let data = { title: '砖头机', body: '你收到了一条新消息', tag: 'default' };

    if (event.data) {
        try {
            data = Object.assign(data, event.data.json());
        } catch (e) {
            data.body = event.data.text();
        }
    }

    const options = {
        body: data.body,
        icon: data.icon || './icon.png',
        badge: './icon.png',
        tag: data.tag || 'default',
        renotify: true,
        requireInteraction: false,    // 不强制用户交互 — 减少 Chrome 垃圾判定
        silent: false,
        data: {
            chatTag: data.chatTag || '',
            charName: data.charName || '',
            url: data.url || './'
        }
    };

    event.waitUntil(
        self.registration.showNotification(data.title, options)
    );
});

// ====== 通知点击事件 ======
self.addEventListener('notificationclick', (event) => {
    event.notification.close();

    const targetUrl = event.notification.data?.url || './';
    const chatTag = event.notification.data?.chatTag || '';
    const charName = event.notification.data?.charName || '';

    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
            for (const client of windowClients) {
                if (client.url.includes('index.html') || client.url.endsWith('/')) {
                    client.postMessage({
                        type: 'NOTIFICATION_CLICK',
                        chatTag: chatTag,
                        charName: charName
                    });
                    return client.focus();
                }
            }
            let url = targetUrl;
            if (chatTag) {
                const urlObj = new URL(url, self.location.origin);
                urlObj.searchParams.set('chat', chatTag);
                if (charName) urlObj.searchParams.set('name', charName);
                url = urlObj.href;
            }
            return clients.openWindow(url);
        })
    );
});

// ====== 从主线程接收消息 ======
// 主线程通过 postMessage 发送通知请求
self.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'SHOW_NOTIFICATION') {
        const { title, body, icon, tag, chatTag, charName } = event.data;

        self.registration.showNotification(title || '砖头机', {
            body: body || '',
            icon: icon || './icon.png',
            badge: './icon.png',
            tag: tag || `msg-${Date.now()}`,
            renotify: true,
            requireInteraction: false,
            silent: false,
            data: {
                chatTag: chatTag || '',
                charName: charName || '',
                url: './'
            }
        });
    }

    // 心跳 — 保持 SW 活跃（配合 Keep-Alive 系统）
    if (event.data && event.data.type === 'KEEPALIVE') {
        // 什么也不做，只是防止 SW 被浏览器终止
    }
});

// ====== 安装 & 激活 ======
self.addEventListener('install', (event) => {
    console.log('[SW] Service Worker 安装完成');
    self.skipWaiting(); // 立即激活，不等待旧 SW 退出
});

self.addEventListener('activate', (event) => {
    console.log('[SW] Service Worker 已激活');
    event.waitUntil(clients.claim()); // 立即接管所有页面
});
