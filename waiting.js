/**
 * waiting.js — 線上模式：管理員等待學生填寫
 */
import { loadState, saveState, showModal, showConfirm, showError, initFirebase, navigateTo } from './shared.js';

let unsubscribeSnapshot = null;
let state = null;

document.addEventListener('DOMContentLoaded', async () => {
    state = loadState();

    // 防呆：若不是管理員 或 沒有房間代碼，導回首頁
    if (!state.isAdmin || !state.currentRoomCode) {
        navigateTo('index.html');
        return;
    }

    // 顯示房間代碼與初始人數
    document.getElementById('display-room-code').textContent = state.currentRoomCode;
    document.getElementById('online-student-status').textContent =
        `0 / ${state.classSettings.allStudentIds.length}`;

    // 產生 QR Code（指向 index.html?room=CODE）
    const joinUrl = window.location.origin
        + window.location.pathname.replace('waiting.html', 'index.html')
        + '?room=' + state.currentRoomCode;

    new QRCode(document.getElementById('qrcode-container'), {
        text: joinUrl,
        width: 160,
        height: 160,
        colorDark: "#38424a",
        colorLight: "#ffffff",
        correctLevel: QRCode.CorrectLevel.H
    });

    // 開始即時監聽學生提交
    await listenToStudentSubmissions();
});

/** 複製房間代碼 */
window.copyRoomCode = async function() {
    const code = document.getElementById('display-room-code').textContent;
    if (!code) return;
    try {
        await navigator.clipboard.writeText(code);
        await showModal('房間代碼已複製到剪貼簿！', 'success');
    } catch {
        await showError('複製失敗，請手動複製。');
    }
};

/** 即時監聽學生提交的資料 */
async function listenToStudentSubmissions() {
    try {
        const { collection, onSnapshot } = await import("https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js");
        const db = await initFirebase();

        if (unsubscribeSnapshot) unsubscribeSnapshot();

        const studentsRef = collection(db, "rooms", state.currentRoomCode, "students");
        unsubscribeSnapshot = onSnapshot(studentsRef, snapshot => {
            const studentsData = [];
            const listEl = document.getElementById('submitted-students-list');
            listEl.innerHTML = '';

            snapshot.forEach(docSnap => {
                const student = docSnap.data();
                studentsData.push(student);

                const li = document.createElement('li');
                li.innerHTML = `
                    <span>座號 <b>${student.studentId}</b>：${student.studentName || '未填姓名'}</span>
                    <span style="color: var(--accent-deep); font-size: 0.8rem; font-weight: 500;">已填寫偏好</span>
                `;
                listEl.appendChild(li);
            });

            document.getElementById('online-student-status').textContent =
                `${studentsData.length} / ${state.classSettings.allStudentIds.length}`;

            // 更新 state 中的學生資料
            state.studentsData = studentsData;
            saveState({ studentsData });
        });
    } catch (err) {
        console.error('監聽學生資料失敗:', err);
        await showError('監聽學生資料失敗，請重新整理頁面。');
    }
}

/** 結束收集並生成座位表 */
window.finishOnlineCollection = async function() {
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
