/**
 * input.js — 學生偏好輸入邏輯
 * 支援線下模式（三按鈕）與線上模式（單一送出按鈕）
 */
import { loadState, saveState, showError, showModal, showConfirm, initFirebase, navigateTo } from './shared.js';

let state = null;

document.addEventListener('DOMContentLoaded', () => {
    state = loadState();

    if (!state.classSettings || !state.classSettings.allStudentIds.length) {
        navigateTo('index.html');
        return;
    }

    // 依模式顯示對應按鈕組
    if (state.flowMode === 'offline') {
        document.getElementById('offline-btn-group').classList.remove('hidden');
        document.getElementById('offline-btn-group').style.display = 'flex';
    } else {
        document.getElementById('online-btn-group').classList.remove('hidden');
        document.getElementById('online-btn-group').style.display = 'block';
    }

    // 初始化進度顯示
    updateStudentStatus();

    // 線下模式：預填第一個未填寫的學生座號
    if (state.flowMode === 'offline') {
        const nextId = getNextUnenteredStudentId();
        if (nextId !== undefined) {
            document.getElementById('student-id').value = nextId;
        }
    } else {
        // 線上加入：清空讓學生自己填
        document.getElementById('student-id').value = '';
        document.getElementById('student-name').value = '';

        // 顯示線上模式進度文字
        const wrapper = document.getElementById('student-status-wrapper');
        if (wrapper) {
            wrapper.innerHTML = `線上模式：房間代碼 <b style="color: var(--primary-color);">${state.currentRoomCode}</b> (班級：${state.classSettings.className})`;
        }

        // 學生端監聽座位表生成
        listenToRoomStatusForStudent();
    }

    // 初始化條件拖曳排序
    initConditionDragAndDrop();
    updateReorderButtonsState();
});

/* =========================================================
   線上模式：學生端監聽房間狀態
   ========================================================= */

async function listenToRoomStatusForStudent() {
    try {
        const { doc, onSnapshot } = await import("https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js");
        const db = await initFirebase();
        const roomRef = doc(db, "rooms", state.currentRoomCode);

        const unsubscribe = onSnapshot(roomRef, async (docSnap) => {
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

/* =========================================================
   進度更新
   ========================================================= */

function updateStudentStatus() {
    const total = state.classSettings.allStudentIds.length;
    const completed = (state.studentsData || []).length;
    const el = document.getElementById('current-student-status');
    if (el) el.textContent = `${completed} / ${total}`;
}

function getNextUnenteredStudentId() {
    const entered = new Set((state.studentsData || []).map(s => s.studentId));
    return state.classSettings.allStudentIds.find(id => !entered.has(id));
}

/* =========================================================
   按鈕功能
   ========================================================= */

/** 返回座位配置頁 */
window.goBackFromInput = function() {
    navigateTo('setup.html');
};

/** 下一步 / 確認送出：提交當前學生偏好 */
window.submitStudentPreferences = async function() {
    const studentId = parseInt(document.getElementById('student-id').value);
    const studentName = document.getElementById('student-name').value.trim();

    // 驗證座號
    if (isNaN(studentId) || studentId <= 0) {
        await showError('請輸入有效的座號。');
        return;
    }
    if (!state.classSettings.allStudentIds.includes(studentId)) {
        await showError('輸入錯誤: 此座號不是該班級的有效座號。');
        return;
    }

    // 收集條件
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

    // === 線上模式 ===
    if (state.isOnlineMode) {
        try {
            const { doc, setDoc } = await import("https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js");
            const db = await initFirebase();
            await setDoc(doc(db, "rooms", state.currentRoomCode, "students", studentId.toString()), newStudentData);

            // 鎖定表單，防止重複送出
            document.getElementById('student-form-container').innerHTML = `
                <div style="text-align: center; padding: 30px;">
                    <h3 style="color: var(--accent-deep); margin-bottom: 10px;">✓ 感謝您的填寫！</h3>
                    <p style="color: var(--text-secondary);">資料已同步至雲端，請等待前方螢幕顯示座位表。</p>
                </div>`;
        } catch (err) {
            console.error('資料上傳失敗:', err);
            await showError('雲端儲存失敗，請檢查網路連線後重試。');
        }
        return;
    }

    // === 線下模式 ===
    let studentsData = [...(state.studentsData || [])];
    const existingIdx = studentsData.findIndex(s => s.studentId === studentId);
    if (existingIdx !== -1) {
        const confirmed = await showConfirm(`座號 ${studentId} 已經填過偏好，是否要覆蓋原本的資料？`);
        if (!confirmed) return;
        studentsData[existingIdx] = newStudentData;
    } else {
        studentsData.push(newStudentData);
    }
    studentsData.sort((a, b) => a.studentId - b.studentId);

    saveState({ studentsData });
    state.studentsData = studentsData;

    resetStudentForm();
    updateStudentStatus();

    // 預填下一個未填學生
    const nextId = getNextUnenteredStudentId();
    document.getElementById('student-id').value = nextId !== undefined ? nextId : '';

    // 若全部填完，自動生成
    if (studentsData.length === state.classSettings.allStudentIds.length) {
        await showModal('班級所有學生偏好已填寫完畢！即將為您分配最佳座位。', 'success');
        navigateTo('result.html');
    }
};

/** 生成座位（線下模式：允許部分學生未填，直接生成） */
window.generateSeatsNow = async function() {
    let studentsData = [...(state.studentsData || [])];

    if (studentsData.length === 0) {
        const confirmed = await showConfirm('目前還沒有任何學生填寫偏好，是否要用預設值（無偏好）為全班分配座位？');
        if (!confirmed) return;
    }

    // 把尚未填寫的學生以「無偏好」補入
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

/* =========================================================
   偏好收集 & 表單重置
   ========================================================= */

function collectPreferences(studentId) {
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

/* =========================================================
   條件拖曳排序（手機用上/下按鈕，桌機用拖曳）
   ========================================================= */

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
