/**
 * script.js — 換個座位 (Seat Shuffle) 整合核心模組
 * 包含：共用工具、首頁、教室設定、等待大廳、偏好輸入、座位結果與模擬退火演算法
 */

/* =========================================================
   1. 共用工具與狀態管理 (Shared)
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

/** 導向到指定頁面 */
export function navigateTo(page) {
    window.location.href = page;
}

/* ── Firebase 配置與初始化 ── */
const FIREBASE_CONFIG = {
    apiKey: "AIzaSyAd5J6KhvEaNGg-RG55m3Ug1EC1VRNjwY0",
    authDomain: "seat-ea9a2.firebaseapp.com",
    projectId: "seat-ea9a2",
    storageBucket: "seat-ea9a2.firebasestorage.app",
    messagingSenderId: "948717447392",
    appId: "1:948717447392:web:aa05f4fc44130f15258885"
};

let _dbInstance = null;

export async function initFirebase() {
    if (_dbInstance) return _dbInstance;
    const { initializeApp, getApps } = await import("https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js");
    const { getFirestore } = await import("https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js");
    const app = getApps().length === 0 ? initializeApp(FIREBASE_CONFIG) : getApps()[0];
    _dbInstance = getFirestore(app);
    return _dbInstance;
}

/* ── Modal 彈窗元件 ── */
export function showModal(message, type = 'info') {
    return new Promise(resolve => {
        const overlay = _createOverlay();
        const card = _createCard();

        const icon = { info: '提示', error: '錯誤', success: '成功' }[type] || '提示';
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

export function showConfirm(message) {
    return new Promise(resolve => {
        const overlay = _createOverlay();
        const card = _createCard();

        card.innerHTML = `
            <div class="modal-icon">提示</div>
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

/** 格式化座號與姓名顯示 (ex: 01王宥鈞 或 01號) */
function formatStudentDisplay(student) {
    if (!student) return '';
    const idStr = String(student.studentId).padStart(2, '0');
    return student.studentName ? `${idStr}${student.studentName}` : `${idStr}號`;
}

/* =========================================================
   2. 首頁模組 (Index Page)
   ========================================================= */

function initIndexPage() {
    document.querySelectorAll('.landing-btn').forEach(btn => {
        btn.addEventListener('keydown', e => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                btn.click();
            }
        });
    });

    const btnCreate = document.getElementById('btn-create');
    const btnOffline = document.getElementById('btn-offline');
    const btnJoin = document.getElementById('btn-join');

    if (btnCreate) btnCreate.addEventListener('click', () => goToSetup('onlineCreate'));
    if (btnOffline) btnOffline.addEventListener('click', () => goToSetup('offline'));
    if (btnJoin) btnJoin.addEventListener('click', showJoinBox);

    // 若網址帶有 ?room=XXXX 參數，自動展開加入框並填入代碼
    const urlParams = new URLSearchParams(window.location.search);
    const roomCodeParam = urlParams.get('room');
    if (roomCodeParam) {
        showJoinBox();
        const input = document.getElementById('room-code');
        if (input) input.value = roomCodeParam.toUpperCase();
        setTimeout(() => window.doJoinRoom(), 400);
    }
}

function goToSetup(mode) {
    saveState({ flowMode: mode });
    navigateTo('setup.html');
}

function showJoinBox() {
    const box = document.getElementById('join-box');
    if (box) {
        box.classList.remove('hidden');
        const input = document.getElementById('room-code');
        if (input) input.focus();
    }
}

window.hideJoinBox = function() {
    const box = document.getElementById('join-box');
    if (box) box.classList.add('hidden');
};

window.doJoinRoom = async function() {
    const input = document.getElementById('room-code');
    const roomCode = input ? input.value.trim().toUpperCase() : '';
    if (!roomCode) {
        await showError('請輸入房間代碼。');
        return;
    }

    try {
        const { doc, getDoc } = await import("https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js");
        const db = await initFirebase();
        const roomRef = doc(db, "rooms", roomCode);
        const roomSnap = await getDoc(roomRef);

        if (!roomSnap.exists()) {
            await showError('找不到該房間，請確認房間代碼是否正確。');
            return;
        }

        const roomData = roomSnap.data();

        // 若房間已經生成座位表，直接前往結果頁
        if (roomData.status === 'generated' && roomData.seats) {
            saveState({
                flowMode: 'onlineJoin',
                isOnlineMode: true,
                isAdmin: false,
                currentRoomCode: roomCode,
                classSettings: roomData,
                studentsData: roomData.seats,
                currentStudentIndex: 0
            });
            navigateTo('result.html');
            return;
        }

        saveState({
            flowMode: 'onlineJoin',
            isOnlineMode: true,
            isAdmin: false,
            currentRoomCode: roomCode,
            classSettings: roomData,
            studentsData: [],
            currentStudentIndex: 0
        });

        navigateTo('input.html');
    } catch (err) {
        console.error('加入房間失敗:', err);
        await showError('加入房間失敗，請檢查網路連線。');
    }
};

/* =========================================================
   3. 教室設定模組 (Setup Page)
   ========================================================= */

let pendingSetup = { className: '', rows: 0, cols: 0 };
let layoutBlockedSet = new Set();

function initSetupPage() {
    const state = loadState();
    if (!state.flowMode) {
        navigateTo('index.html');
        return;
    }

    // 回填先前的設定（若有）
    if (state.classSettings) {
        if (state.classSettings.className) {
            const nameEl = document.getElementById('class-name');
            if (nameEl) nameEl.value = state.classSettings.className;
        }
        if (state.classSettings.totalRows) {
            const rowsEl = document.getElementById('rows');
            if (rowsEl) rowsEl.value = state.classSettings.totalRows;
        }
        if (state.classSettings.totalCols) {
            const colsEl = document.getElementById('cols');
            if (colsEl) colsEl.value = state.classSettings.totalCols;
        }
        if (Array.isArray(state.classSettings.blockedSeats)) {
            layoutBlockedSet = new Set(state.classSettings.blockedSeats);
        }
    }
}

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

window.goBack = function() {
    navigateTo('index.html');
};

window.backToSetup = function() {
    showPageSection('setup-page');
};

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

    drawLayoutConfigGrid();
    showPageSection('layout-config-page');
};

function drawLayoutConfigGrid() {
    const container = document.getElementById('layout-config-container');
    if (!container) return;
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
    const activeEl = document.getElementById('active-seat-count');
    const totalEl = document.getElementById('total-seat-count');
    if (activeEl) activeEl.textContent = active;
    if (totalEl) totalEl.textContent = total;
}

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

async function createOnlineRoom(classSettings) {
    const btn = document.getElementById('layout-confirm-btn');
    if (btn) { btn.disabled = true; btn.textContent = '建立中…'; }

    try {
        const { doc, setDoc } = await import("https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js");
        const db = await initFirebase();

        // 確保剛好 6 位長度隨機英數字
        const roomCode = Math.random().toString(36).substring(2, 8).padEnd(6, 'X').toUpperCase();

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

/* =========================================================
   4. 等待大廳模組 (Waiting Page)
   ========================================================= */

let unsubscribeSnapshot = null;

function initWaitingPage() {
    const state = loadState();

    if (!state.isAdmin || !state.currentRoomCode) {
        navigateTo('index.html');
        return;
    }

    const codeEl = document.getElementById('display-room-code');
    const statusEl = document.getElementById('online-student-status');
    if (codeEl) codeEl.textContent = state.currentRoomCode;
    if (statusEl && state.classSettings && state.classSettings.allStudentIds) {
        statusEl.textContent = `0 / ${state.classSettings.allStudentIds.length}`;
    }

    // 產生 QR Code
    const qrcodeContainer = document.getElementById('qrcode-container');
    if (qrcodeContainer && window.QRCode) {
        qrcodeContainer.innerHTML = '';
        const joinUrl = window.location.origin
            + window.location.pathname.replace('waiting.html', 'index.html')
            + '?room=' + state.currentRoomCode;

        new QRCode(qrcodeContainer, {
            text: joinUrl,
            width: 160,
            height: 160,
            colorDark: "#38424a",
            colorLight: "#ffffff",
            correctLevel: QRCode.CorrectLevel.H
        });
    }

    listenToStudentSubmissions();
}

window.copyRoomCode = async function() {
    const codeEl = document.getElementById('display-room-code');
    const code = codeEl ? codeEl.textContent : '';
    if (!code) return;
    try {
        await navigator.clipboard.writeText(code);
        await showModal('房間代碼已複製到剪貼簿！', 'success');
    } catch {
        await showError('複製失敗，請手動複製。');
    }
};

async function listenToStudentSubmissions() {
    const state = loadState();
    try {
        const { collection, onSnapshot } = await import("https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js");
        const db = await initFirebase();

        if (unsubscribeSnapshot) unsubscribeSnapshot();

        const studentsRef = collection(db, "rooms", state.currentRoomCode, "students");
        unsubscribeSnapshot = onSnapshot(studentsRef, snapshot => {
            const studentsData = [];
            const listEl = document.getElementById('submitted-students-list');
            if (listEl) listEl.innerHTML = '';

            snapshot.forEach(docSnap => {
                const student = docSnap.data();
                studentsData.push(student);
            });

            // 依座號數字由小到大排序 (Bug 修復)
            studentsData.sort((a, b) => a.studentId - b.studentId);

            if (listEl) {
                studentsData.forEach(student => {
                    const li = document.createElement('li');
                    li.innerHTML = `
                        <span>座號 <b>${student.studentId}</b>：${student.studentName || '未填姓名'}</span>
                        <span style="color: var(--accent-deep); font-size: 0.8rem; font-weight: 500;">已填寫偏好</span>
                    `;
                    listEl.appendChild(li);
                });
            }

            const totalCount = state.classSettings?.allStudentIds?.length || '?';
            const statusEl = document.getElementById('online-student-status');
            if (statusEl) statusEl.textContent = `${studentsData.length} / ${totalCount}`;

            saveState({ studentsData });
        });
    } catch (err) {
        console.error('監聽學生資料失敗:', err);
        await showError('監聽學生資料失敗，請重新整理頁面。');
    }
}

/** 等待頁手動快速登記（未掃碼者） */
window.addStudentInWaiting = async function() {
    const idInput = document.getElementById('waiting-manual-id');
    const nameInput = document.getElementById('waiting-manual-name');
    const studentId = parseInt(idInput ? idInput.value : '');
    const studentName = (nameInput ? nameInput.value : '').trim();

    if (isNaN(studentId) || studentId <= 0) {
        await showError('請輸入有效的座號 (正整數)。');
        return;
    }

    const state = loadState();
    const currentStudents = state.studentsData || [];
    if (currentStudents.some(s => s.studentId === studentId)) {
        await showError(`座號 ${studentId} 已經存在於名單中！`);
        return;
    }

    try {
        const { doc, setDoc } = await import("https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js");
        const db = await initFirebase();
        const newStudentData = {
            studentId,
            studentName: studentName || '',
            preferences: {
                wantToSitWith: [],
                frontBack: { value: '不限', weight: 0 },
                leftRightCenter: { value: '不限', weight: 0 }
            },
            seat: null
        };
        await setDoc(doc(db, "rooms", state.currentRoomCode, "students", studentId.toString()), newStudentData);
        if (idInput) idInput.value = '';
        if (nameInput) nameInput.value = '';
        await showModal(`已添加座號 ${studentId}！`, 'success');
    } catch (err) {
        console.error('手動添加失敗:', err);
        await showError('手動添加失敗，請檢查網路連線。');
    }
};

window.finishOnlineCollection = async function() {
    const state = loadState();
    const currentStudents = state.studentsData || [];

    if (currentStudents.length === 0) {
        await showModal('目前還沒有任何學生提交資料喔！', 'info');
        return;
    }

    const confirmed = await showConfirm(
        `目前收到 ${currentStudents.length} 筆資料，確定要結束收集並生成座位表嗎？`
    );
    if (!confirmed) return;

    if (unsubscribeSnapshot) {
        unsubscribeSnapshot();
        unsubscribeSnapshot = null;
    }

    navigateTo('result.html');
};

/* =========================================================
   5. 學生偏好輸入模組 (Input Page)
   ========================================================= */

function initInputPage() {
    const state = loadState();

    if (!state.classSettings || !state.classSettings.allStudentIds.length) {
        navigateTo('index.html');
        return;
    }

    // 依模式顯示對應按鈕組
    const offlineGroup = document.getElementById('offline-btn-group');
    const onlineGroup = document.getElementById('online-btn-group');
    if (state.flowMode === 'offline') {
        if (offlineGroup) {
            offlineGroup.classList.remove('hidden');
            offlineGroup.style.display = 'flex';
        }
        if (onlineGroup) onlineGroup.classList.add('hidden');
    } else {
        if (onlineGroup) {
            onlineGroup.classList.remove('hidden');
            onlineGroup.style.display = 'block';
        }
        if (offlineGroup) offlineGroup.classList.add('hidden');
    }

    updateStudentStatus();

    // 線下模式：預填第一個未填寫的學生座號
    if (state.flowMode === 'offline') {
        const nextId = getNextUnenteredStudentId();
        const idInput = document.getElementById('student-id');
        if (nextId !== undefined && idInput) {
            idInput.value = nextId;
        }
    } else {
        const idInput = document.getElementById('student-id');
        const nameInput = document.getElementById('student-name');
        if (idInput) idInput.value = '';
        if (nameInput) nameInput.value = '';

        const wrapper = document.getElementById('student-status-wrapper');
        if (wrapper) {
            wrapper.innerHTML = `線上模式：房間代碼 <b style="color: var(--primary-color);">${state.currentRoomCode}</b> (班級：${state.classSettings.className})`;
        }

        listenToRoomStatusForStudent();
    }

    initConditionDragAndDrop();
    updateReorderButtonsState();
}

async function listenToRoomStatusForStudent() {
    const state = loadState();
    try {
        const { doc, onSnapshot } = await import("https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js");
        const db = await initFirebase();
        const roomRef = doc(db, "rooms", state.currentRoomCode);

        const unsubscribe = onSnapshot(roomRef, (docSnap) => {
            if (docSnap.exists()) {
                const roomData = docSnap.data();
                if (roomData.status === 'generated' && roomData.seats) {
                    unsubscribe();
                    saveState({
                        studentsData: roomData.seats,
                        classSettings: { ...state.classSettings, blockedSeats: roomData.blockedSeats || state.classSettings.blockedSeats }
                    });
                    navigateTo('result.html');
                }
            }
        });
    } catch (err) {
        console.error('監聽房間狀態失敗:', err);
    }
}

function updateStudentStatus() {
    const state = loadState();
    const total = state.classSettings?.allStudentIds?.length || '?';
    const completed = (state.studentsData || []).length;
    const el = document.getElementById('current-student-status');
    if (el) el.textContent = `${completed} / ${total}`;
}

function getNextUnenteredStudentId() {
    const state = loadState();
    const entered = new Set((state.studentsData || []).map(s => s.studentId));
    return state.classSettings.allStudentIds.find(id => !entered.has(id));
}

window.goBackFromInput = function() {
    navigateTo('setup.html');
};

let isSubmittingPreference = false;

window.submitStudentPreferences = async function() {
    if (isSubmittingPreference) return;
    const state = loadState();
    const idInput = document.getElementById('student-id');
    const nameInput = document.getElementById('student-name');
    const studentId = parseInt(idInput ? idInput.value : '');
    const studentName = nameInput ? nameInput.value.trim() : '';

    if (isNaN(studentId) || studentId <= 0) {
        await showError('請輸入有效的座號。');
        return;
    }
    if (!state.classSettings.allStudentIds.includes(studentId)) {
        await showError('輸入錯誤: 此座號不是該班級的有效座號。');
        return;
    }

    const result = collectPreferences(studentId);
    if (result.error) {
        await showError(result.error);
        return;
    }

    const newStudentData = {
        studentId,
        studentName: studentName || '',
        preferences: result.preferences,
        seat: null
    };

    isSubmittingPreference = true;

    // === 線上模式 ===
    if (state.isOnlineMode) {
        try {
            const { doc, setDoc } = await import("https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js");
            const db = await initFirebase();
            await setDoc(doc(db, "rooms", state.currentRoomCode, "students", studentId.toString()), newStudentData);

            const formContainer = document.getElementById('student-form-container');
            if (formContainer) {
                formContainer.innerHTML = `
                    <div style="text-align: center; padding: 30px;">
                        <h3 style="color: var(--accent-deep); margin-bottom: 10px;">✓ 感謝您的填寫！</h3>
                        <p style="color: var(--text-secondary);">資料已同步至雲端，請等待前方螢幕顯示座位表。</p>
                    </div>`;
            }
        } catch (err) {
            console.error('資料上傳失敗:', err);
            await showError('雲端儲存失敗，請檢查網路連線後重試。');
        } finally {
            isSubmittingPreference = false;
        }
        return;
    }

    // === 線下模式 ===
    try {
        let studentsData = [...(state.studentsData || [])];
        const existingIdx = studentsData.findIndex(s => s.studentId === studentId);
        if (existingIdx !== -1) {
            const confirmed = await showConfirm(`座號 ${studentId} 已經填過偏好，是否要覆蓋原本的資料？`);
            if (!confirmed) {
                isSubmittingPreference = false;
                return;
            }
            studentsData[existingIdx] = newStudentData;
        } else {
            studentsData.push(newStudentData);
        }
        studentsData.sort((a, b) => a.studentId - b.studentId);

        saveState({ studentsData });

        resetStudentForm();
        updateStudentStatus();

        const nextId = getNextUnenteredStudentId();
        if (idInput) idInput.value = nextId !== undefined ? nextId : '';

        if (studentsData.length === state.classSettings.allStudentIds.length) {
            await showModal('班級所有學生偏好已填寫完畢！即將為您分配最佳座位。', 'success');
            navigateTo('result.html');
        }
    } finally {
        isSubmittingPreference = false;
    }
};

window.generateSeatsNow = async function() {
    const state = loadState();
    let studentsData = [...(state.studentsData || [])];

    if (studentsData.length === 0) {
        const confirmed = await showConfirm('目前還沒有任何學生填寫偏好，是否要用預設值（無偏好）為全班分配座位？');
        if (!confirmed) return;
    }

    const entered = new Set(studentsData.map(s => s.studentId));
    state.classSettings.allStudentIds.forEach(id => {
        if (!entered.has(id)) {
            studentsData.push({
                studentId: id,
                studentName: '',
                preferences: {
                    wantToSitWith: [],
                    frontBack: { value: '不限', weight: 0 },
                    leftRightCenter: { value: '不限', weight: 0 }
                },
                seat: null
            });
        }
    });
    studentsData.sort((a, b) => a.studentId - b.studentId);

    saveState({ studentsData });
    navigateTo('result.html');
};

function collectPreferences(studentId) {
    const state = loadState();
    const studentPreferences = { wantToSitWith: [], frontBack: {}, leftRightCenter: {} };
    const partnerIdsSet = new Set();
    const conditionGroups = document.querySelectorAll('#condition-list .condition-group');
    let currentWeight = 4;

    for (const group of conditionGroups) {
        const input = group.querySelector('input:not(.preference-id)[type="number"], input.preference-id, select');
        if (!input) continue;

        const val = input.value.trim();
        const id = input.id;
        const isIdType = (id === 'pref-1-id' || id === 'pref-2-id');
        const hasValue = isIdType ? !!val : (val !== '不限');

        if (hasValue) {
            const weight = currentWeight > 0 ? currentWeight : 1;
            currentWeight--;

            if (isIdType) {
                const partnerId = parseInt(val);
                if (isNaN(partnerId)) return { error: '輸入錯誤: 朋友的座號必須是數字。' };
                if (partnerId === studentId) return { error: '輸入錯誤: 您不能選擇自己作為「想跟誰坐」的對象。' };
                if (partnerIdsSet.has(partnerId)) return { error: '輸入錯誤: 您重複選擇了同一個朋友座號。' };
                partnerIdsSet.add(partnerId);

                if (!state.classSettings.allStudentIds.includes(partnerId)) {
                    return { error: `輸入錯誤: 座號 ${partnerId} 不是班上的有效座號。` };
                }
                studentPreferences.wantToSitWith.push({ id: partnerId, weight });
            } else if (id === 'pref-5-val') {
                studentPreferences.frontBack = { value: val, weight };
            } else if (id === 'pref-6-val') {
                studentPreferences.leftRightCenter = { value: val, weight };
            }
        }
    }

    return {
        preferences: {
            wantToSitWith: studentPreferences.wantToSitWith,
            frontBack: studentPreferences.frontBack.value
                ? studentPreferences.frontBack
                : { value: '不限', weight: 0 },
            leftRightCenter: studentPreferences.leftRightCenter.value
                ? studentPreferences.leftRightCenter
                : { value: '不限', weight: 0 }
        }
    };
}

function resetStudentForm() {
    document.querySelectorAll('#student-form-container input, #student-form-container select').forEach(input => {
        if (input.id !== 'student-id' && input.type !== 'hidden') {
            input.value = input.tagName === 'SELECT' ? '不限' : '';
        }
    });
}

function updateReorderButtonsState() {
    const groups = document.querySelectorAll('#condition-list .condition-group');
    groups.forEach((group, index) => {
        const btns = group.querySelectorAll('.reorder-btn');
        if (btns[0]) btns[0].disabled = (index === 0);
        if (btns[1]) btns[1].disabled = (index === groups.length - 1);
    });
}

window.moveConditionUp = function(btn) {
    const group = btn.closest('.condition-group');
    const prev = group.previousElementSibling;
    if (prev) { group.parentNode.insertBefore(group, prev); updateReorderButtonsState(); }
};

window.moveConditionDown = function(btn) {
    const group = btn.closest('.condition-group');
    const next = group.nextElementSibling;
    if (next) { group.parentNode.insertBefore(next, group); updateReorderButtonsState(); }
};

function initConditionDragAndDrop() {
    const list = document.getElementById('condition-list');
    if (!list) return;
    let draggedItem = null;

    list.addEventListener('dragstart', e => {
        const target = e.target.closest('.condition-group');
        if (!target) return;
        draggedItem = target;
        setTimeout(() => target.classList.add('dragging'), 0);
    });

    list.addEventListener('dragend', e => {
        const target = e.target.closest('.condition-group');
        if (target) target.classList.remove('dragging');
        draggedItem = null;
        document.querySelectorAll('.condition-group').forEach(el => el.classList.remove('drag-over'));
    });

    list.addEventListener('dragover', e => {
        e.preventDefault();
        const target = e.target.closest('.condition-group');
        if (target && target !== draggedItem) target.classList.add('drag-over');
    });

    list.addEventListener('dragleave', e => {
        const target = e.target.closest('.condition-group');
        if (target && target !== draggedItem) target.classList.remove('drag-over');
    });

    list.addEventListener('drop', e => {
        e.preventDefault();
        const target = e.target.closest('.condition-group');
        if (target && target !== draggedItem) {
            target.classList.remove('drag-over');
            const rect = target.getBoundingClientRect();
            const insertAfter = (e.clientY - rect.top) / (rect.bottom - rect.top) > 0.5;
            list.insertBefore(draggedItem, insertAfter ? target.nextSibling : target);
            updateReorderButtonsState();
        }
    });
}

/* =========================================================
   6. 座位結果與演算法模組 (Result Page)
   ========================================================= */

let resultState = null;
let classSettings = null;
let studentsData = [];
let draggedStudentId = null;
let isOnlineMode = false;
let isAdmin = false;
let selectedSeatForSwap = null; // 支援行動裝置點擊互換

const ALGO_MODE_LABELS = {
    balanced: '平衡模式',
    max_score: '最大滿意',
    fairness: '公平優先'
};

async function initResultPage() {
    resultState = loadState();

    if (!resultState.classSettings || !resultState.classSettings.allStudentIds.length) {
        navigateTo('index.html');
        return;
    }

    classSettings = resultState.classSettings;
    studentsData = resultState.studentsData || [];
    isOnlineMode = resultState.isOnlineMode || false;
    isAdmin = resultState.isAdmin || false;

    // 學生端（線上 join）：隱藏重新分配按鈕、推薦卡片與添加學生區塊
    if (isOnlineMode && !isAdmin) {
        const redistributeBtn = document.getElementById('redistribute-btn');
        if (redistributeBtn) redistributeBtn.style.display = 'none';

        const banner = document.getElementById('mode-recommendation');
        if (banner) banner.classList.add('hidden');

        const addStudentContainer = document.getElementById('add-student-container');
        if (addStudentContainer) addStudentContainer.style.display = 'none';

        const algoGroup = document.getElementById('algo-mode-group');
        if (algoGroup) algoGroup.style.display = 'none';
    }

    // 檢查是否所有學生都已經擁有分配好的座位
    const hasAssignedSeats = studentsData.length > 0 && studentsData.every(s => s.seat && s.seat.row && s.seat.col);

    renderModeRecommendation(!hasAssignedSeats);

    // 只有在管理員/線下模式 且 尚未分配過座位時才自動分配
    // 學生端絕不自行分配，避免打亂老師指派結果 (Bug 修復)
    if (!hasAssignedSeats && (!isOnlineMode || isAdmin)) {
        distributeSeats();
    } else {
        drawSeatMap();
    }

    // 學生端線上即時監聽老師的座位調整 (Bug 修復)
    if (isOnlineMode && !isAdmin && resultState.currentRoomCode) {
        listenToSeatsUpdatesForStudent();
    }
}

async function listenToSeatsUpdatesForStudent() {
    try {
        const { doc, onSnapshot } = await import("https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js");
        const db = await initFirebase();
        const roomRef = doc(db, "rooms", resultState.currentRoomCode);

        onSnapshot(roomRef, docSnap => {
            if (docSnap.exists()) {
                const roomData = docSnap.data();
                if (roomData.seats && Array.isArray(roomData.seats)) {
                    studentsData = roomData.seats;
                    saveState({ studentsData });
                    drawSeatMap();
                }
            }
        });
    } catch (err) {
        console.error('即時監聽座位更新失敗:', err);
    }
}

function isBlockedSeat(row, col) {
    return (classSettings.blockedSeats || []).includes(`${row},${col}`);
}

function getEmptySeats() {
    const occupied = new Set(studentsData.filter(s => s.seat).map(s => `${s.seat.row},${s.seat.col}`));
    const empty = [];
    for (let r = 1; r <= classSettings.totalRows; r++) {
        for (let c = 1; c <= classSettings.totalCols; c++) {
            if (!isBlockedSeat(r, c) && !occupied.has(`${r},${c}`)) {
                empty.push({ row: r, col: c });
            }
        }
    }
    return empty;
}

function calculateStudentSatisfaction(student, seatPosition = null, allStudents = studentsData) {
    const seat = seatPosition || student.seat;
    if (!seat) return { frontBack: 0, leftRight: 0, friends: 0, total: 0 };

    const pref = student.preferences || { wantToSitWith: [], frontBack: {}, leftRightCenter: {} };
    let fbScore = 0, lrScore = 0, frScore = 0;

    // 前後方位（連續計分）
    if (pref.frontBack?.value && pref.frontBack.value !== '不限' && classSettings.totalRows > 1) {
        const row = seat.row;
        const maxR = classSettings.totalRows;
        let ratio = 0;
        if (pref.frontBack.value === '前') ratio = (maxR - row) / (maxR - 1);
        else if (pref.frontBack.value === '後') ratio = (row - 1) / (maxR - 1);
        else if (pref.frontBack.value === '中') {
            const center = (maxR + 1) / 2;
            const maxDist = (maxR - 1) / 2;
            ratio = 1 - (Math.abs(row - center) / maxDist);
        }
        fbScore = ratio * (pref.frontBack.weight || 1) * 50;
    }

    // 左右方位（連續計分）
    if (pref.leftRightCenter?.value && pref.leftRightCenter.value !== '不限' && classSettings.totalCols > 1) {
        const col = seat.col;
        const maxC = classSettings.totalCols;
        let ratio = 0;
        if (pref.leftRightCenter.value === '左') ratio = (maxC - col) / (maxC - 1);
        else if (pref.leftRightCenter.value === '右') ratio = (col - 1) / (maxC - 1);
        else if (pref.leftRightCenter.value === '中') {
            const center = (maxC + 1) / 2;
            const maxDist = (maxC - 1) / 2;
            ratio = 1 - (Math.abs(col - center) / maxDist);
        }
        lrScore = ratio * (pref.leftRightCenter.weight || 1) * 50;
    }

    // 好友距離
    (pref.wantToSitWith || []).forEach(p => {
        const partner = allStudents.find(s => s.studentId === p.id);
        if (partner && partner.seat) {
            const rowDiff = Math.abs(seat.row - partner.seat.row);
            const colDiff = Math.abs(seat.col - partner.seat.col);
            const dist = Math.max(rowDiff, colDiff);
            const ratio = Math.max(0, 1 - (dist - 1) * 0.25);
            frScore += ratio * (p.weight || 1) * 50;
        }
    });

    return { frontBack: fbScore, leftRight: lrScore, friends: frScore, total: fbScore + lrScore + frScore };
}

function evaluateSystem(allStudents) {
    const scores = allStudents.map(s => calculateStudentSatisfaction(s, s.seat, allStudents).total);
    if (scores.length === 0) return 0;

    const sum = scores.reduce((a, b) => a + b, 0);
    const mean = sum / scores.length;
    const variance = scores.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / scores.length;
    const stdDev = Math.sqrt(variance);

    const modeSelect = document.getElementById('algo-mode');
    const mode = modeSelect ? modeSelect.value : 'balanced';
    const N = scores.length;

    if (mode === 'max_score') return sum;
    else if (mode === 'fairness') return (mean - (stdDev * 0.9)) * N;
    else return (mean - (stdDev * 0.5)) * N;
}

function shuffleArray(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

window.distributeSeats = function() {
    const availableSeats = [];
    for (let r = 1; r <= classSettings.totalRows; r++) {
        for (let c = 1; c <= classSettings.totalCols; c++) {
            if (!isBlockedSeat(r, c)) availableSeats.push({ row: r, col: c });
        }
    }

    if (availableSeats.length < studentsData.length) {
        showError('錯誤：可用座位數量少於學生人數！');
        return;
    }

    if (studentsData.length === 0) {
        drawSeatMap();
        return;
    }

    // 初始隨機分配
    shuffleArray(availableSeats);
    studentsData.forEach((student, index) => {
        student.seat = { ...availableSeats[index] };
    });

    // 模擬退火最佳化
    let currentScore = evaluateSystem(studentsData);
    const iterations = 50000;
    let temperature = 500.0;
    const minTemperature = 1.0;
    const coolingRate = Math.pow(minTemperature / temperature, 1 / iterations);

    for (let i = 0; i < iterations; i++) {
        const idx = Math.floor(Math.random() * studentsData.length);
        const student1 = studentsData[idx];
        const targetSeat = availableSeats[Math.floor(Math.random() * availableSeats.length)];
        const student2 = studentsData.find(s => s.seat && s.seat.row === targetSeat.row && s.seat.col === targetSeat.col);

        if (student2 === student1) continue;

        const oldSeat1 = { ...student1.seat };
        const oldSeat2 = student2 ? { ...student2.seat } : null;

        if (student2) {
            student1.seat = { ...student2.seat };
            student2.seat = oldSeat1;
        } else {
            student1.seat = { ...targetSeat };
        }

        const newScore = evaluateSystem(studentsData);
        const deltaScore = newScore - currentScore;

        if (deltaScore >= 0 || Math.random() < Math.exp(deltaScore / temperature)) {
            currentScore = newScore;
        } else {
            // 復原座位指派 (防物件參考混亂)
            student1.seat = oldSeat1;
            if (student2) student2.seat = oldSeat2;
        }

        temperature *= coolingRate;
    }

    drawSeatMap();

    // 更新狀態與同步
    saveState({ studentsData });
    if (isOnlineMode && isAdmin) saveSeatsToCloud();
};

function drawSeatMap() {
    const container = document.getElementById('seat-map-container');
    if (!container) return;
    container.innerHTML = '';
    container.style.display = 'grid';
    container.style.gridTemplateColumns = `repeat(${classSettings.totalCols}, minmax(64px, 1fr))`;

    const canDrag = !isOnlineMode || isAdmin;

    for (let r = 1; r <= classSettings.totalRows; r++) {
        for (let c = 1; c <= classSettings.totalCols; c++) {
            const seatDiv = document.createElement('div');
            seatDiv.className = 'seat-box';
            seatDiv.dataset.row = r;
            seatDiv.dataset.col = c;

            if (isBlockedSeat(r, c)) {
                seatDiv.innerHTML = `<div class="seat-student-name">(不坐人)</div>`;
                seatDiv.classList.add('blocked');
                container.appendChild(seatDiv);
                continue;
            }

            const student = studentsData.find(s => s.seat && s.seat.row === r && s.seat.col === c);

            if (student) {
                const idStr = String(student.studentId).padStart(2, '0');
                seatDiv.innerHTML = `
                    <div class="seat-student-id">${idStr} 號</div>
                    <div class="seat-student-name">${student.studentName || '無姓名'}</div>
                `;
                seatDiv.title = `排: ${r}, 列: ${c}\n學生: ${idStr} 號` + (student.studentName ? ` - ${student.studentName}` : '');
                seatDiv.dataset.studentId = student.studentId;

                if (canDrag) {
                    seatDiv.classList.add('occupied');
                    seatDiv.setAttribute('draggable', true);
                    seatDiv.addEventListener('dragstart', handleDragStart);
                    seatDiv.addEventListener('dragend', handleDragEnd);
                } else {
                    seatDiv.classList.add('occupied-readonly');
                }
            } else {
                seatDiv.innerHTML = `<div class="seat-student-name">(空位)</div>`;
                seatDiv.classList.add('empty');
            }

            if (canDrag) {
                seatDiv.addEventListener('dragover', handleDragOver);
                seatDiv.addEventListener('dragleave', handleDragLeave);
                seatDiv.addEventListener('drop', handleDrop);

                // 支援行動裝置點擊互換 (Bug 修復)
                seatDiv.addEventListener('click', handleSeatClickForSwap);
            }

            container.appendChild(seatDiv);
        }
    }

    updateSeatStatsBadge();
}

/** 更新空位與人數統計徽章 */
function updateSeatStatsBadge() {
    const badge = document.getElementById('seat-stats-badge');
    if (!badge) return;
    const emptyCount = getEmptySeats().length;
    const occupiedCount = studentsData.filter(s => s.seat).length;
    badge.textContent = `目前人數：${occupiedCount} 人 · 剩餘空位：${emptyCount} 個`;
}

/* ── 行動裝置點擊互換支援 ── */
function handleSeatClickForSwap(e) {
    const box = e.currentTarget;
    if (box.classList.contains('blocked')) return;

    if (!selectedSeatForSwap) {
        // 第一下點選
        selectedSeatForSwap = box;
        box.classList.add('selected-for-swap');
    } else if (selectedSeatForSwap === box) {
        // 點選同一個：取消選取
        selectedSeatForSwap.classList.remove('selected-for-swap');
        selectedSeatForSwap = null;
    } else {
        // 第二下點選：執行對調
        const r1 = parseInt(selectedSeatForSwap.dataset.row);
        const c1 = parseInt(selectedSeatForSwap.dataset.col);
        const r2 = parseInt(box.dataset.row);
        const c2 = parseInt(box.dataset.col);

        const student1 = studentsData.find(s => s.seat && s.seat.row === r1 && s.seat.col === c1);
        const student2 = studentsData.find(s => s.seat && s.seat.row === r2 && s.seat.col === c2);

        if (student1 && student2) {
            const temp = student1.seat;
            student1.seat = student2.seat;
            student2.seat = temp;
        } else if (student1) {
            student1.seat = { row: r2, col: c2 };
        } else if (student2) {
            student2.seat = { row: r1, col: c1 };
        }

        selectedSeatForSwap.classList.remove('selected-for-swap');
        selectedSeatForSwap = null;

        drawSeatMap();
        saveState({ studentsData });
        if (isOnlineMode && isAdmin) saveSeatsToCloud();
    }
}

/* ── 原生拖曳事件 ── */
function handleDragStart(e) {
    const box = e.target.closest('.seat-box');
    if (!box) return;
    draggedStudentId = parseInt(box.dataset.studentId);
    box.classList.add('dragging');
}

function handleDragOver(e) {
    const box = e.target.closest('.seat-box');
    if (box && box.classList.contains('blocked')) return;
    e.preventDefault();
    if (box) box.classList.add('drag-over');
}

function handleDragLeave(e) {
    const box = e.target.closest('.seat-box');
    if (box) box.classList.remove('drag-over');
}

function handleDragEnd(e) {
    const box = e.target.closest('.seat-box');
    if (box) box.classList.remove('dragging');
    document.querySelectorAll('.seat-box').forEach(el => el.classList.remove('drag-over'));
    draggedStudentId = null;
}

function handleDrop(e) {
    e.preventDefault();
    const targetSeatDiv = e.target.closest('.seat-box');
    if (!targetSeatDiv || draggedStudentId === null || isNaN(draggedStudentId)) return;
    if (targetSeatDiv.classList.contains('blocked')) return;

    targetSeatDiv.classList.remove('drag-over');

    const targetRow = parseInt(targetSeatDiv.dataset.row);
    const targetCol = parseInt(targetSeatDiv.dataset.col);
    const draggedStudent = studentsData.find(s => s.studentId === draggedStudentId);
    if (!draggedStudent) return;

    const targetStudent = studentsData.find(s => s.seat && s.seat.row === targetRow && s.seat.col === targetCol);

    if (targetStudent) {
        const tempSeat = draggedStudent.seat;
        draggedStudent.seat = targetStudent.seat;
        targetStudent.seat = tempSeat;
    } else {
        draggedStudent.seat = { row: targetRow, col: targetCol };
    }

    drawSeatMap();
    saveState({ studentsData });
    if (isOnlineMode && isAdmin) saveSeatsToCloud();
}

async function saveSeatsToCloud() {
    if (!isOnlineMode || !isAdmin || !resultState.currentRoomCode) return;
    try {
        const { doc, setDoc } = await import("https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js");
        const db = await initFirebase();
        await setDoc(doc(db, "rooms", resultState.currentRoomCode), {
            status: 'generated',
            seats: studentsData
        }, { merge: true });
    } catch (err) {
        console.error('同步座位到雲端失敗:', err);
    }
}

/* =========================================================
   7. 手動添加學生功能 (Requirement 2)
   ========================================================= */

window.addStudentManually = async function() {
    const idInput = document.getElementById('manual-new-id');
    const nameInput = document.getElementById('manual-new-name');
    const studentId = parseInt(idInput ? idInput.value : '');
    const studentName = (nameInput ? nameInput.value : '').trim();

    if (isNaN(studentId) || studentId <= 0) {
        await showError('請輸入有效的座號 (正整數)。');
        return;
    }

    // 檢查座號是否重複
    if (studentsData.some(s => s.studentId === studentId)) {
        await showError(`座號 ${studentId} 已經存在於名單中！`);
        return;
    }

    // 檢查教室是否還有可用空位
    const emptySeats = getEmptySeats();
    if (emptySeats.length === 0) {
        await showError('教室已無剩餘可用座位！無法再添加學生。');
        return;
    }

    // 自動安排至第一個空位
    const assignedSeat = emptySeats[0];
    const newStudent = {
        studentId,
        studentName: studentName || '',
        preferences: {
            wantToSitWith: [],
            frontBack: { value: '不限', weight: 0 },
            leftRightCenter: { value: '不限', weight: 0 }
        },
        seat: { ...assignedSeat }
    };

    studentsData.push(newStudent);
    studentsData.sort((a, b) => a.studentId - b.studentId);

    // 擴充 classSettings.allStudentIds
    if (!classSettings.allStudentIds.includes(studentId)) {
        classSettings.allStudentIds.push(studentId);
        classSettings.allStudentIds.sort((a, b) => a - b);
    }

    // 儲存狀態並同步
    saveState({ studentsData, classSettings });
    if (isOnlineMode && isAdmin) {
        saveSeatsToCloud();
        // 同步新增至學生集合
        try {
            const { doc, setDoc } = await import("https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js");
            const db = await initFirebase();
            await setDoc(doc(db, "rooms", resultState.currentRoomCode, "students", studentId.toString()), newStudent);
        } catch (err) {
            console.warn('同步新學生資料失敗:', err);
        }
    }

    // 重新繪製介面與提示
    drawSeatMap();
    renderModeRecommendation(false);

    if (idInput) idInput.value = '';
    if (nameInput) nameInput.value = '';

    await showModal(`已成功添加 ${formatStudentDisplay(newStudent)}，並自動安排至第 ${assignedSeat.row} 排第 ${assignedSeat.col} 列！`, 'success');
};

/** 手動移除學生（釋出座位） */
window.removeStudentManually = async function() {
    const idInput = document.getElementById('manual-new-id');
    const studentId = parseInt(idInput ? idInput.value : '');

    if (isNaN(studentId) || studentId <= 0) {
        await showError('請在座號欄位輸入要移除的學生座號。');
        return;
    }

    const idx = studentsData.findIndex(s => s.studentId === studentId);
    if (idx === -1) {
        await showError(`找不到座號 ${studentId} 的學生。`);
        return;
    }

    const targetStudent = studentsData[idx];
    const confirmed = await showConfirm(`確定要移除 ${formatStudentDisplay(targetStudent)} 嗎？該座位將釋出為空位。`);
    if (!confirmed) return;

    studentsData.splice(idx, 1);
    saveState({ studentsData });
    if (isOnlineMode && isAdmin) saveSeatsToCloud();

    drawSeatMap();
    renderModeRecommendation(false);
    if (idInput) idInput.value = '';

    await showModal(`已移除座號 ${studentId}，座位已釋出。`, 'info');
};

/* =========================================================
   8. 智慧推薦模式
   ========================================================= */

function analyzeAndRecommendMode() {
    const N = studentsData.length;
    if (N === 0) return null;

    const demandList = studentsData.map(s => {
        const p = s.preferences || {};
        let demand = 0;
        if (p.frontBack && p.frontBack.value && p.frontBack.value !== '不限') demand += (p.frontBack.weight || 0);
        if (p.leftRightCenter && p.leftRightCenter.value && p.leftRightCenter.value !== '不限') demand += (p.leftRightCenter.weight || 0);
        (p.wantToSitWith || []).forEach(w => demand += (w.weight || 0));
        return demand;
    });

    const respondersDemand = demandList.filter(d => d > 0);
    const responderCount = respondersDemand.length;
    const nonResponderRatio = (N - responderCount) / N;

    const meanDemand = responderCount > 0 ? respondersDemand.reduce((a, b) => a + b, 0) / responderCount : 0;
    const variance = responderCount > 0
        ? respondersDemand.reduce((a, b) => a + Math.pow(b - meanDemand, 2), 0) / responderCount : 0;
    const stdDev = Math.sqrt(variance);
    const cv = meanDemand > 0 ? stdDev / meanDemand : 0;

    const targetHeat = {};
    studentsData.forEach(s => {
        (s?.preferences?.wantToSitWith || []).forEach(w => {
            if (!targetHeat[w.id]) targetHeat[w.id] = { count: 0, highWeightCount: 0 };
            targetHeat[w.id].count++;
            if (w.weight >= 3) targetHeat[w.id].highWeightCount++;
        });
    });
    const overloadedTargets = Object.values(targetHeat).filter(t => t.count >= 3 && t.highWeightCount >= 2).length;

    let mode, reason;
    if (responderCount === 0) {
        mode = 'balanced';
        reason = `全班都沒有填寫特別的座位偏好，代表大家怎麼坐都可以，用平衡模式最省事，結果也不會有爭議。`;
    } else if (meanDemand < 1.5) {
        mode = 'balanced';
        reason = `就算是有填寫的同學，偏好強度也普遍不高（平均約 ${meanDemand.toFixed(1)} 分），各模式差異不大，平衡模式即可。`;
    } else if (overloadedTargets > 0) {
        mode = 'fairness';
        reason = `有 ${overloadedTargets} 位同學被 3 人以上高權重指名想坐附近，這些座位一定不夠分配給所有人，建議用公平優先模式，避免少數同學的分數被嚴重犧牲。`;
    } else if (cv > 0.6) {
        mode = 'fairness';
        reason = `在有填寫偏好的同學之中，需求強度落差較大（有人要求很多、有人只是稍微填一下），建議用公平優先模式，避免強烈偏好排擠到其他同學。`;
    } else if (cv < 0.35 && meanDemand >= 2) {
        mode = 'max_score';
        reason = nonResponderRatio >= 0.3
            ? `有 ${Math.round(nonResponderRatio * 100)}% 的同學沒有特別要求（等於自願配合調度），剩下有填的同學需求又集中不衝突，可以放心用最大滿意度模式，不會犧牲到任何人。`
            : `同學的需求普遍積極且分佈平均、重疊指名少，衝突風險低，可以放心用最大滿意度模式衝高整體分數。`;
    } else {
        mode = 'balanced';
        reason = `目前的需求強度與分佈屬於中等狀況，平衡模式能兼顧整體滿意度與座位分配的公平性，是最穩妥的選擇。`;
    }

    return { mode, reason };
}

function renderModeRecommendation(autoApply = false) {
    const banner = document.getElementById('mode-recommendation');
    if (!banner) return;

    const result = analyzeAndRecommendMode();
    if (!result) { banner.classList.add('hidden'); return; }

    const labelEl = document.getElementById('recommend-mode-label');
    const reasonEl = document.getElementById('recommend-mode-reason');
    if (labelEl) labelEl.textContent = ALGO_MODE_LABELS[result.mode];
    if (reasonEl) reasonEl.textContent = result.reason;
    banner.dataset.recommendedMode = result.mode;
    banner.classList.remove('hidden');

    if (autoApply) {
        const modeSelect = document.getElementById('algo-mode');
        if (modeSelect) modeSelect.value = result.mode;
    }
}

window.applyRecommendedMode = function() {
    const banner = document.getElementById('mode-recommendation');
    const mode = banner ? banner.dataset.recommendedMode : null;
    if (!mode) return;
    const modeSelect = document.getElementById('algo-mode');
    if (modeSelect) modeSelect.value = mode;
    distributeSeats();
};

/* =========================================================
   9. 匯出 DOC 檔案 (Requirement 1: 修正左右相反與姓名吃掉座號)
   ========================================================= */

window.downloadDoc = function() {
    const className = classSettings?.className ? `${classSettings.className} ` : '';
    const header = `
        <html xmlns:o='urn:schemas-microsoft-com:office:office'
              xmlns:w='urn:schemas-microsoft-com:office:word'
              xmlns='http://www.w3.org/TR/REC-html40'>
        <head>
            <meta charset='utf-8'>
            <style>
                @page Section1 {
                    size: 841.9pt 595.3pt;
                    mso-page-orientation: landscape;
                    margin: 1.0in 1.0in 1.0in 1.0in;
                }
                div.Section1 { page: Section1; }
                table {
                    width: 100%;
                    border-collapse: collapse;
                    table-layout: fixed;
                    font-family: "Microsoft JhengHei", "微軟正黑體", sans-serif;
                }
                td {
                    border: 1px solid #333;
                    padding: 8px;
                    text-align: center;
                    vertical-align: middle;
                    word-wrap: break-word;
                    height: 52px;
                    font-size: 14pt;
                    mso-number-format: "\\@";
                }
                .blocked { background-color: #f4f6f7; border: 1px dashed #ccc; }
            </style>
        </head>
        <body>
            <div class="Section1">
                <h2 style="text-align: center; font-family: '微軟正黑體';">${className}班級座位表 (老師視角)</h2>
    `;

    let tableHtml = `<table>`;

    // 【老師視角修正】：
    // 1. 排數倒序：從最後一排印到第一排 (r = totalRows down to 1)，第一排緊鄰最下方的講台
    // 2. 欄數倒序：從最右欄印到最左欄 (c = totalCols down to 1)，老師站在講台面向全班時，左右與現實對齊
    for (let r = classSettings.totalRows; r >= 1; r--) {
        tableHtml += `<tr>`;
        for (let c = classSettings.totalCols; c >= 1; c--) {
            if (isBlockedSeat(r, c)) {
                tableHtml += `<td class="blocked"></td>`;
            } else {
                const student = studentsData.find(s => s.seat && s.seat.row === r && s.seat.col === c);
                if (student) {
                    // 【格式修正】：格子內顯示「座號姓名 (例如: 01王宥鈞)」
                    const studentDisplay = formatStudentDisplay(student);
                    tableHtml += `<td>${studentDisplay}</td>`;
                } else {
                    tableHtml += `<td><span style="color: #999;">(空位)</span></td>`;
                }
            }
        }
        tableHtml += `</tr>`;
    }
    tableHtml += `</table>`;

    // 在最下方放置講台，明確表示老師站在前方看學生的視角
    tableHtml += `
        <div style="text-align: center; margin-top: 30px;">
            <div style="display: inline-block; width: 160px; padding: 10px; border: 2px solid #000; background-color: #eee; font-weight: bold; font-family: '微軟正黑體'; font-size: 13pt;">
                講 台
            </div>
        </div>
    `;

    const footer = `</div></body></html>`;
    const fullHtml = header + tableHtml + footer;
    const blob = new Blob(['\ufeff', fullHtml], { type: 'application/msword' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${classSettings?.className ? `${classSettings.className}_` : ''}班級座位表_老師視角.doc`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
};

window.goHomeFromResult = async function() {
    const confirmed = await showConfirm('確定要回到首頁嗎？目前的座位資料已儲存。');
    if (confirmed) {
        navigateTo('index.html');
    }
};

/* =========================================================
   10. 自動頁面調度路由 (Dispatcher)
   ========================================================= */

document.addEventListener('DOMContentLoaded', () => {
    if (document.getElementById('landing-page')) {
        initIndexPage();
    } else if (document.getElementById('setup-page')) {
        initSetupPage();
    } else if (document.getElementById('admin-waiting-page')) {
        initWaitingPage();
    } else if (document.getElementById('input-page')) {
        initInputPage();
    } else if (document.getElementById('result-page')) {
        initResultPage();
    }
});
