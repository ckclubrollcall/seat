/**
 * shared.js — 跨頁共用工具模組
 * 包含：SessionStorage 狀態管理、Modal 遮罩元件、Firebase 初始化
 */

/* =========================================================
   SessionStorage 狀態管理
   ========================================================= */

const STATE_KEY = 'seatAppState';

/** 讀取全域狀態 */
export function loadState() {
    try {
        const raw = sessionStorage.getItem(STATE_KEY);
        return raw ? JSON.parse(raw) : getDefaultState();
    } catch {
        return getDefaultState();
    }
}

/** 寫入全域狀態（淺合併） */
export function saveState(partial) {
    const current = loadState();
    const next = { ...current, ...partial };
    sessionStorage.setItem(STATE_KEY, JSON.stringify(next));
    return next;
}

/** 清除全域狀態 */
export function clearState() {
    sessionStorage.removeItem(STATE_KEY);
}

function getDefaultState() {
    return {
        flowMode: 'offline',       // 'offline' | 'onlineCreate' | 'onlineJoin'
        isOnlineMode: false,
        isAdmin: false,
        currentRoomCode: '',
        classSettings: {
            className: '',
            totalRows: 0,
            totalCols: 0,
            blockedSeats: [],
            allStudentIds: []
        },
        studentsData: [],
        currentStudentIndex: 0
    };
}

/* =========================================================
   Firebase 初始化（每個頁面呼叫一次，避免重複初始化）
   ========================================================= */

const FIREBASE_CONFIG = {
    apiKey: "AIzaSyAd5J6KhvEaNGg-RG55m3Ug1EC1VRNjwY0",
    authDomain: "seat-ea9a2.firebaseapp.com",
    projectId: "seat-ea9a2",
    storageBucket: "seat-ea9a2.firebasestorage.app",
    messagingSenderId: "948717447392",
    appId: "1:948717447392:web:aa05f4fc44130f15258885"
};

let _dbInstance = null;

/** 初始化 Firebase 並回傳 db 實例 */
export async function initFirebase() {
    if (_dbInstance) return _dbInstance;
    const { initializeApp, getApps } = await import("https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js");
    const { getFirestore } = await import("https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js");
    const app = getApps().length === 0 ? initializeApp(FIREBASE_CONFIG) : getApps()[0];
    _dbInstance = getFirestore(app);
    return _dbInstance;
}

/* =========================================================
   Modal 遮罩元件
   ========================================================= */

/**
 * 顯示通知型 Modal（只有確定按鈕）
 * @param {string} message
 * @param {'info'|'error'|'success'} [type='info']
 * @returns {Promise<void>}
 */
export function showModal(message, type = 'info') {
    return new Promise(resolve => {
        const overlay = _createOverlay();
        const card = _createCard();

        const icon = { info: 'ℹ️', error: '❌', success: '✅' }[type] || 'ℹ️';
        const titleColor = {
            info: 'var(--accent-deep)',
            error: 'var(--error-text)',
            success: '#4a9a6e'
        }[type] || 'var(--accent-deep)';

        card.innerHTML = `
            <div class="modal-icon">${icon}</div>
            <div class="modal-message" style="color:${titleColor};">${_escHtml(message)}</div>
            <div class="modal-actions">
                <button class="btn-primary" id="modal-ok">確定</button>
            </div>
        `;

        overlay.appendChild(card);
        document.body.appendChild(overlay);

        requestAnimationFrame(() => {
            overlay.classList.add('modal-visible');
            card.classList.add('modal-card-visible');
        });

        const close = () => {
            _dismissModal(overlay, card);
            resolve();
        };

        card.querySelector('#modal-ok').addEventListener('click', close);
        overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
    });
}

/**
 * 顯示確認型 Modal（確定 / 取消）
 * @param {string} message
 * @returns {Promise<boolean>}
 */
export function showConfirm(message) {
    return new Promise(resolve => {
        const overlay = _createOverlay();
        const card = _createCard();

        card.innerHTML = `
            <div class="modal-icon">❓</div>
            <div class="modal-message">${_escHtml(message)}</div>
            <div class="modal-actions">
                <button class="btn-secondary" id="modal-cancel">取消</button>
                <button class="btn-primary" id="modal-ok">確定</button>
            </div>
        `;

        overlay.appendChild(card);
        document.body.appendChild(overlay);

        requestAnimationFrame(() => {
            overlay.classList.add('modal-visible');
            card.classList.add('modal-card-visible');
        });

        const close = (result) => {
            _dismissModal(overlay, card);
            resolve(result);
        };

        card.querySelector('#modal-ok').addEventListener('click', () => close(true));
        card.querySelector('#modal-cancel').addEventListener('click', () => close(false));
        overlay.addEventListener('click', e => { if (e.target === overlay) close(false); });
    });
}

/** 顯示錯誤 Modal（showModal 便捷包裝） */
export function showError(message) {
    return showModal(message, 'error');
}

function _createOverlay() {
    const el = document.createElement('div');
    el.className = 'modal-overlay';
    return el;
}

function _createCard() {
    const el = document.createElement('div');
    el.className = 'modal-card';
    return el;
}

function _dismissModal(overlay, card) {
    overlay.classList.remove('modal-visible');
    card.classList.remove('modal-card-visible');
    setTimeout(() => overlay.remove(), 300);
}

function _escHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/* =========================================================
   頁面切換工具
   ========================================================= */

/** 導向到指定頁面 */
export function navigateTo(page) {
    window.location.href = page;
}
