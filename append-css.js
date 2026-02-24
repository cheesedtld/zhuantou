const fs = require('fs');
const css = `

/* ========== FORUM (星海社区) ========== */
.forum-screen {
    background: #f7f8fa;
    z-index: 1000;
    display: none;
    flex-direction: column;
}
.forum-header {
    height: 48px;
    background: #fff;
    flex-shrink: 0;
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0 10px;
    padding-top: max(0px, env(safe-area-inset-top));
    border-bottom: 0.5px solid #e8e8e8;
    z-index: 10;
}
.forum-back-btn {
    border: none;
    background: transparent;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #333;
    padding: 6px;
}
.forum-back-btn svg { width: 22px; height: 22px; fill: currentColor; }
.forum-back-btn:active { opacity: 0.5; }

.forum-title {
    font-size: 16px;
    font-weight: 600;
    color: #1d1d1f;
}

.forum-header-actions {
    display: flex;
    gap: 2px;
}
.forum-header-icon-btn {
    border: none;
    background: transparent;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #666;
    padding: 6px;
}
.forum-header-icon-btn svg { width: 19px; height: 19px; fill: currentColor; }
.forum-header-icon-btn:active { opacity: 0.5; }

/* Search Bar */
.forum-search-bar {
    background: #fff;
    padding: 0 12px;
    max-height: 0;
    overflow: hidden;
    transition: max-height 0.25s ease, padding 0.25s ease;
    flex-shrink: 0;
    border-bottom: 0.5px solid #e8e8e8;
}
.forum-search-bar.show {
    max-height: 50px;
    padding: 6px 12px 8px;
}
.forum-search-inner {
    display: flex;
    align-items: center;
    background: #f2f3f5;
    border-radius: 8px;
    padding: 0 10px;
    gap: 6px;
}
.forum-search-icon { width: 16px; height: 16px; fill: #b0b0b0; flex-shrink: 0; }
.forum-search-inner input {
    flex: 1;
    border: none;
    background: transparent;
    height: 34px;
    font-size: 13.5px;
    outline: none;
    color: #333;
}
.forum-search-inner input::placeholder { color: #b0b0b0; }
.forum-search-clear {
    border: none;
    background: none;
    color: #b0b0b0;
    font-size: 13px;
    cursor: pointer;
    padding: 4px;
    line-height: 1;
}
.forum-search-go-btn {
    border: none;
    background: #1d1d1f;
    color: #fff;
    border-radius: 6px;
    width: 30px;
    height: 28px;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    flex-shrink: 0;
    transition: opacity 0.15s;
}
.forum-search-go-btn:active { opacity: 0.6; }
.forum-search-go-btn svg { width: 14px; height: 14px; fill: currentColor; }

/* Section Tabs */
.forum-tabs {
    background: #fff;
    display: flex;
    gap: 0;
    padding: 0 4px;
    border-bottom: 0.5px solid #e8e8e8;
    flex-shrink: 0;
    overflow-x: auto;
    scrollbar-width: none;
}
.forum-tabs::-webkit-scrollbar { display: none; }
.forum-tab {
    padding: 9px 11px;
    font-size: 13px;
    color: #888;
    cursor: pointer;
    position: relative;
    white-space: nowrap;
    display: flex;
    align-items: center;
    gap: 3px;
    transition: color 0.15s;
    flex-shrink: 0;
    background: none;
    border: none;
}
.forum-tab-icon { font-size: 12px; display: none; }
.forum-tab-label { font-weight: 500; }
.forum-tab.active {
    color: #1d1d1f;
    font-weight: 600;
}
.forum-tab.active::after {
    content: '';
    position: absolute;
    bottom: 0;
    left: 50%;
    transform: translateX(-50%);
    width: 16px;
    height: 2px;
    background: #1d1d1f;
    border-radius: 1px;
}

/* Section Header */
.forum-section-header {
    background: #fff;
    padding: 10px 14px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    border-bottom: 0.5px solid #e8e8e8;
    flex-shrink: 0;
}
.forum-section-info {
    display: flex;
    align-items: center;
    gap: 8px;
}
.forum-section-icon { font-size: 14px; color: #999; }
.forum-section-meta { display: flex; flex-direction: column; }
.forum-section-name { font-size: 14px; font-weight: 600; color: #1d1d1f; }
.forum-section-desc { font-size: 11.5px; color: #aaa; margin-top: 1px; }
.forum-section-stats { font-size: 11.5px; color: #bbb; }

/* Feed */
.forum-feed {
    flex: 1;
    overflow-y: auto;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0;
}

/* Empty State */
.forum-empty {
    text-align: center;
    padding: 60px 20px;
    color: #aaa;
}
.forum-empty-icon { font-size: 28px; margin-bottom: 10px; color: #ccc; }
.forum-empty-text { font-size: 14px; margin-bottom: 4px; color: #999; }
.forum-empty-hint { font-size: 12px; color: #c0c0c0; }

/* Post Card */
.forum-card {
    background: #fff;
    padding: 13px 14px;
    border-bottom: 0.5px solid #efefef;
    transition: background 0.1s;
}
.forum-card:active { background: #f9f9f9; }
.forum-card.pinned {
    border-left: 2px solid #7a8baa;
}
.forum-card-header {
    display: flex;
    align-items: center;
    margin-bottom: 6px;
}
.forum-avatar {
    width: 32px;
    height: 32px;
    border-radius: 50%;
    object-fit: cover;
    margin-right: 9px;
}
.forum-author-info {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
}
.forum-author-name {
    font-size: 13px;
    font-weight: 500;
    color: #333;
    display: flex;
    align-items: center;
    gap: 4px;
    flex-wrap: wrap;
}
.forum-author-level {
    font-size: 9px;
    background: #eef0f4;
    color: #7a8baa;
    padding: 1px 5px;
    border-radius: 3px;
    font-weight: 600;
}
.forum-author-time {
    font-size: 11px;
    color: #b0b0b0;
    margin-top: 1px;
}
.forum-section-badge {
    font-size: 9.5px;
    background: #f0f1f5;
    color: #8892a8;
    padding: 1px 5px;
    border-radius: 3px;
    font-weight: 500;
}
.forum-pinned-badge {
    font-size: 11px;
    color: #7a8baa;
    margin-bottom: 4px;
    font-weight: 500;
    display: block;
}

.forum-more-btn {
    border: none;
    background: none;
    cursor: pointer;
    padding: 4px;
    color: #ccc;
}
.forum-more-btn svg { width: 16px; height: 16px; fill: currentColor; }

.forum-card-title {
    font-size: 15px;
    font-weight: 600;
    color: #1d1d1f;
    margin-bottom: 3px;
    line-height: 1.35;
}
.forum-card-text {
    font-size: 13.5px;
    color: #666;
    line-height: 1.45;
    margin-bottom: 6px;
    word-break: break-word;
}
.forum-card-text.clamped {
    display: -webkit-box;
    -webkit-line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
}

/* Tags */
.forum-card-tags, .forum-detail-tags {
    display: flex;
    gap: 5px;
    flex-wrap: wrap;
    margin-bottom: 6px;
}
.forum-tag {
    font-size: 10.5px;
    color: #7a8baa;
    background: #f0f1f5;
    padding: 2px 7px;
    border-radius: 3px;
    font-weight: 500;
}

/* Images */
.forum-card-images {
    margin-bottom: 8px;
    border-radius: 6px;
    overflow: hidden;
}
.forum-card-images.single { }
.forum-card-images.row {
    display: flex;
    gap: 3px;
}
.forum-card-images.grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 3px;
}
.forum-img {
    width: 100%;
    height: 110px;
    object-fit: cover;
    border-radius: 4px;
    cursor: pointer;
}
.forum-card-images.single .forum-img {
    height: auto;
    max-height: 200px;
    width: 100%;
}
.forum-card-images.row .forum-img {
    flex: 1;
    min-width: 0;
}
.forum-txt-img {
    height: 110px;
    min-width: 90px;
    background: #f5f6f8;
    border-radius: 4px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #999;
    font-size: 11px;
    padding: 8px;
    text-align: center;
    border: 0.5px solid #e8e8e8;
    flex-shrink: 0;
}

/* Card Footer */
.forum-card-footer {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding-top: 6px;
}
.forum-card-stats {
    display: flex;
    gap: 10px;
}
.forum-stat {
    display: flex;
    align-items: center;
    gap: 3px;
    font-size: 11.5px;
    color: #bbb;
}
.forum-stat svg { width: 13px; height: 13px; fill: currentColor; }

.forum-footer-btn {
    display: flex;
    align-items: center;
    gap: 3px;
    font-size: 12px;
    background: none;
    border: none;
    color: #bbb;
    cursor: pointer;
    padding: 4px 8px;
    transition: color 0.15s;
}
.forum-footer-btn:active { opacity: 0.5; }
.forum-footer-btn svg { width: 16px; height: 16px; }
.forum-footer-btn.liked { color: #e06070; }

/* FAB */
.forum-fab {
    position: absolute;
    bottom: 28px;
    right: 18px;
    width: 46px;
    height: 46px;
    background: #1d1d1f;
    color: #fff;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    box-shadow: 0 2px 10px rgba(0,0,0,0.15);
    cursor: pointer;
    z-index: 20;
    transition: transform 0.15s;
}
.forum-fab svg { width: 20px; height: 20px; }
.forum-fab:active { transform: scale(0.9); }

/* ---- Detail View ---- */
.forum-detail-overlay {
    position: absolute;
    top: 0; left: 0; right: 0; bottom: 0;
    background: #fff;
    z-index: 1001;
    display: none;
    flex-direction: column;
    transform: translateX(100%);
    transition: transform 0.3s cubic-bezier(0.2, 0.8, 0.2, 1);
}
.forum-detail-overlay.show { display: flex; }
.forum-detail-content {
    flex: 1;
    overflow-y: auto;
    padding-bottom: 60px;
}
.forum-detail-post {
    padding: 14px;
    border-bottom: 6px solid #f7f8fa;
}
.forum-detail-header { }
.forum-detail-title {
    font-size: 18px;
    font-weight: 700;
    color: #1d1d1f;
    margin: 12px 0 6px;
    line-height: 1.35;
}
.forum-detail-text {
    font-size: 14.5px;
    color: #444;
    line-height: 1.65;
    margin-bottom: 10px;
    word-break: break-word;
}
.forum-detail-images {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin: 10px 0;
}
.forum-detail-img {
    width: 100%;
    border-radius: 6px;
    cursor: pointer;
}

/* Detail Actions */
.forum-detail-actions {
    display: flex;
    gap: 6px;
    padding: 10px 0;
    border-top: 0.5px solid #efefef;
    margin-top: 10px;
    flex-wrap: wrap;
}
.forum-action-btn {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 12.5px;
    background: #f5f6f8;
    border: none;
    color: #777;
    cursor: pointer;
    padding: 6px 12px;
    border-radius: 6px;
    transition: background 0.1s;
}
.forum-action-btn:active { background: #eee; }
.forum-action-btn svg { width: 14px; height: 14px; }
.forum-action-btn.liked { color: #e06070; background: #fdf2f3; }
.forum-action-btn.delete { color: #bbb; }

/* Detail Likes */
.forum-detail-likes {
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 8px 0;
    border-top: 0.5px solid #efefef;
    margin-top: 6px;
}
.forum-detail-likes svg { flex-shrink: 0; }
.forum-likes-names {
    font-size: 12.5px;
    color: #7a8baa;
    font-weight: 500;
    line-height: 1.4;
}

/* Comments */
.forum-comments-title {
    font-size: 13px;
    font-weight: 600;
    color: #1d1d1f;
    padding: 12px 14px 5px;
}
.forum-empty-comments {
    text-align: center;
    padding: 36px;
    color: #ccc;
    font-size: 12.5px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
}
.forum-comment-item {
    padding: 10px 14px;
    border-bottom: 0.5px solid #f2f3f5;
    display: flex;
    gap: 8px;
    cursor: pointer;
    transition: background 0.1s;
}
.forum-comment-item:active { background: #fafafa; }
.forum-comment-avatar {
    width: 28px;
    height: 28px;
    border-radius: 50%;
    object-fit: cover;
    flex-shrink: 0;
}
.forum-comment-body { flex: 1; min-width: 0; }
.forum-comment-header {
    display: flex;
    justify-content: space-between;
    margin-bottom: 2px;
}
.forum-comment-name {
    font-size: 12.5px;
    color: #7a8baa;
    font-weight: 500;
    display: flex;
    align-items: center;
    gap: 4px;
}
.forum-host-badge {
    font-size: 9px;
    color: #e06070;
    border: 0.5px solid #e06070;
    padding: 0 3px;
    border-radius: 2px;
    font-weight: 600;
}
.forum-comment-text {
    font-size: 13.5px;
    color: #333;
    line-height: 1.45;
    margin-bottom: 3px;
    word-break: break-word;
}
.forum-reply-target {
    color: #aaa;
    font-size: 12.5px;
    margin-right: 2px;
}
.forum-reply-name {
    color: #7a8baa;
    font-weight: 500;
}
.forum-comment-time {
    font-size: 10.5px;
    color: #c5c5c5;
}

/* Bottom Input */
.forum-bottom-input {
    position: absolute;
    bottom: 0; left: 0; right: 0;
    min-height: 50px;
    background: #fff;
    border-top: 0.5px solid #e8e8e8;
    display: flex;
    align-items: center;
    padding: 0 10px;
    gap: 8px;
    padding-bottom: max(0px, env(safe-area-inset-bottom));
}
.forum-input-field {
    flex: 1;
    height: 34px;
    background: #f2f3f5;
    border: none;
    border-radius: 8px;
    padding: 0 12px;
    font-size: 13.5px;
    outline: none;
    color: #333;
}
.forum-send-btn {
    border: none;
    background: none;
    color: #7a8baa;
    font-weight: 600;
    font-size: 14px;
    cursor: pointer;
    padding: 6px 4px;
    white-space: nowrap;
}
.forum-send-btn:disabled { color: #d0d0d0; }
.forum-ai-btn { color: #999; }

/* ---- Compose Modal ---- */
.forum-compose-overlay {
    position: absolute;
    top: 0; left: 0; right: 0; bottom: 0;
    background: rgba(0,0,0,0.35);
    z-index: 1002;
    display: none;
    flex-direction: column;
    justify-content: flex-end;
}
.forum-compose-overlay.show { display: flex; }
.forum-compose-sheet {
    background: #fff;
    border-radius: 12px 12px 0 0;
    padding: 16px;
    height: 85%;
    display: flex;
    flex-direction: column;
    gap: 10px;
    animation: slideUpSheet 0.25s ease;
    overflow-y: auto;
}
.forum-compose-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    flex-shrink: 0;
}
.forum-compose-cancel { color: #888; background: none; border: none; font-size: 14px; cursor: pointer; }
.forum-compose-title { font-size: 16px; font-weight: 600; color: #1d1d1f; }
.forum-compose-publish {
    color: #fff;
    background: #1d1d1f;
    border: none;
    font-size: 13px;
    padding: 6px 14px;
    border-radius: 6px;
    font-weight: 600;
    cursor: pointer;
    transition: opacity 0.15s;
}
.forum-compose-publish:active { opacity: 0.7; }

.forum-compose-label {
    font-size: 12px;
    color: #aaa;
    font-weight: 500;
    margin-top: 2px;
    flex-shrink: 0;
}

/* Section Picker */
.forum-compose-section-picker {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    flex-shrink: 0;
}
.forum-compose-section-item {
    display: flex;
    align-items: center;
    gap: 3px;
    padding: 5px 10px;
    border-radius: 6px;
    font-size: 12.5px;
    background: #f5f6f8;
    color: #777;
    cursor: pointer;
    transition: all 0.15s;
    border: 1px solid transparent;
}
.forum-compose-section-item.selected {
    background: #f0f1f5;
    color: #1d1d1f;
    border-color: #c0c5d0;
    font-weight: 600;
}

/* Tag Picker */
.forum-compose-tag-picker {
    display: flex;
    gap: 5px;
    flex-wrap: wrap;
    flex-shrink: 0;
}
.forum-compose-tag {
    padding: 3px 10px;
    border-radius: 4px;
    font-size: 11.5px;
    background: #f5f6f8;
    color: #888;
    cursor: pointer;
    transition: all 0.15s;
    border: 1px solid transparent;
}
.forum-compose-tag.selected {
    background: #f0f1f5;
    color: #1d1d1f;
    border-color: #c0c5d0;
    font-weight: 600;
}

.forum-compose-input-title {
    width: 100%;
    border: none;
    font-size: 17px;
    font-weight: 600;
    color: #1d1d1f;
    padding: 0;
    outline: none;
    flex-shrink: 0;
}
.forum-compose-input-title::placeholder { color: #ccc; }

.forum-compose-input-text {
    flex: 1;
    width: 100%;
    border: none;
    font-size: 14.5px;
    color: #444;
    padding: 0;
    outline: none;
    resize: none;
    line-height: 1.55;
    min-height: 80px;
}
.forum-compose-input-text::placeholder { color: #ccc; }

/* Compose Images */
.forum-compose-img-grid {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    flex-shrink: 0;
    padding: 6px 0;
}
.forum-compose-img-item {
    position: relative;
    width: 68px;
    height: 68px;
}
.forum-compose-img-item img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    border-radius: 6px;
}
.forum-compose-img-remove {
    position: absolute;
    top: -5px;
    right: -5px;
    background: rgba(0,0,0,0.5);
    color: #fff;
    border-radius: 50%;
    width: 18px;
    height: 18px;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    font-size: 12px;
}
.forum-compose-img-add {
    width: 68px;
    height: 68px;
    background: #f7f8fa;
    border-radius: 6px;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    border: 0.5px dashed #d0d0d0;
    transition: border-color 0.15s;
}
.forum-compose-img-add:hover { border-color: #999; }
.forum-compose-img-add svg { width: 20px; height: 20px; }
`;

fs.appendFileSync('style.css', css);
console.log('Clean forum CSS appended.');
