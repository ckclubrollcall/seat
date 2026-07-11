/**
 * setup.js — 教室設定 + 座位配置邏輯
 */
import { loadState, saveState, showError, showConfirm, initFirebase, navigateTo } from './shared.js';

/* ── 本頁內部的頁面切換（不依賴 shared.js） ── */
function showPageSection(id) {
    document.querySelectorAll('.page-section').forEach(s => s.classList.add('hidden'));
    const target = document.getElementById(id);
    if (target) {
        target.classList.remove('hidden');
        target.classList.remove('page-enter');
        void target.offsetWidth;
        target.classList.add('page-enter');
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* ── 暫存狀態（僅本頁使用，不寫入 sessionStorage） ── */
let pendingSetup = { className: '', rows: 0, cols: 0 };
let layoutBlockedSet = new Set();

/* ── 初始化 ── */
document.addEventListener('DOMContentLoaded', () => {
    const state = loadState();
    if (!state.flowMode) {
        navigateTo('index.html');
    }
});

/* ── 返回首頁 ── */
window.goBack = function() {
    navigateTo('index.html');
};

/* ── 返回教室設定頁 ── */
window.backToSetup = function() {
    showPageSection('setup-page');
};

/* =========================================================
   教室設定 → 座位配置
   ========================================================= */

window.goToLayoutConfig = async function() {
    const className = document.getElementById('class-name').value.trim();
    const rows = parseInt(document.getElementById('rows').value);
    const cols = parseInt(document.getElementById('cols').value);

    if (!className) { await showError('請輸入有效的班級名稱。'); return; }
    if (isNaN(rows) || rows <= 0 || isNaN(cols) || cols <= 0) {
        await showError('請輸入有效的排數和列數 (須為大於 0 的數字)。');
        return;
    }
    if (rows * cols > 400) {
        await showError('教室座位數量過多，請確認排數與列數是否正確。');
        return;
    }

    pendingSetup = { className, rows, cols };
    layoutBlockedSet = new Set();

    drawLayoutConfigGrid();
    showPageSection('layout-config-page');
};

function drawLayoutConfigGrid() {
    const container = document.getElementById('layout-config-container');
    container.innerHTML = '';
    container.style.display = 'grid';
    container.style.gridTemplateColumns = `repeat(${pendingSetup.cols}, minmax(56px, 1fr))`;

    for (let r = 1; r <= pendingSetup.rows; r++) {
        for (let c = 1; c <= pendingSetup.cols; c++) {
            const key = `${r},${c}`;
            const seatDiv = document.createElement('div');
            seatDiv.className = 'layout-seat';
            seatDiv.dataset.key = key;
            seatDiv.textContent = `${r}-${c}`;
            if (layoutBlockedSet.has(key)) seatDiv.classList.add('inactive');

            seatDiv.addEventListener('click', () => {
                if (layoutBlockedSet.has(key)) {
                    layoutBlockedSet.delete(key);
                    seatDiv.classList.remove('inactive');
                } else {
                    layoutBlockedSet.add(key);
                    seatDiv.classList.add('inactive');
                }
                updateLayoutSeatCount();
            });
            container.appendChild(seatDiv);
        }
    }
    updateLayoutSeatCount();
}

function updateLayoutSeatCount() {
    const total = pendingSetup.rows * pendingSetup.cols;
    const active = total - layoutBlockedSet.size;
    document.getElementById('active-seat-count').textContent = active;
    document.getElementById('total-seat-count').textContent = total;
}

/* =========================================================
   確認座位配置 → 依模式前往下一頁
   ========================================================= */

window.confirmLayoutConfig = async function() {
    const total = pendingSetup.rows * pendingSetup.cols;
    const activeCount = total - layoutBlockedSet.size;

    if (activeCount <= 0) {
        await showError('至少需要保留一個可以坐人的座位。');
        return;
    }

    const allStudentIds = Array.from({ length: activeCount }, (_, i) => i + 1);

    const classSettings = {
        className: pendingSetup.className,
        totalRows: pendingSetup.rows,
        totalCols: pendingSetup.cols,
        blockedSeats: Array.from(layoutBlockedSet),
        allStudentIds
    };

    const state = loadState();
    saveState({ classSettings, studentsData: [], currentStudentIndex: 0 });

    if (state.flowMode === 'offline') {
        navigateTo('input.html');
    } else if (state.flowMode === 'onlineCreate') {
        await createOnlineRoom(classSettings);
    }
};

/* =========================================================
   線上模式：建立房間並跳轉至等待頁
   ========================================================= */

async function createOnlineRoom(classSettings) {
    const btn = document.getElementById('layout-confirm-btn');
    if (btn) { btn.disabled = true; btn.textContent = '建立中…'; }

    try {
        const { doc, setDoc } = await import("https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js");
        const db = await initFirebase();

        const roomCode = Math.random().toString(36).substring(2, 8).toUpperCase();

        await setDoc(doc(db, "rooms", roomCode), {
            ...classSettings,
            status: 'waiting',
            seats: []
        });

        saveState({
            isOnlineMode: true,
            isAdmin: true,
            currentRoomCode: roomCode,
            classSettings
        });

        navigateTo('waiting.html');
    } catch (err) {
        console.error('建立房間失敗:', err);
        await showError('建立房間失敗，請檢查網路連線或 Firebase 金鑰配置。');
        if (btn) { btn.disabled = false; btn.textContent = '確認座位配置'; }
    }
}
