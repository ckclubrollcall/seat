/**
 * index.js — 首頁邏輯
 */
import { saveState, showError, showModal, initFirebase, navigateTo } from './shared.js';

document.addEventListener('DOMContentLoaded', () => {
    // 鍵盤支援：Enter/Space 觸發 landing-btn
    document.querySelectorAll('.landing-btn').forEach(btn => {
        btn.addEventListener('keydown', e => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                btn.click();
            }
        });
    });

    document.getElementById('btn-create').addEventListener('click', () => goToSetup('onlineCreate'));
    document.getElementById('btn-offline').addEventListener('click', () => goToSetup('offline'));
    document.getElementById('btn-join').addEventListener('click', showJoinBox);

    // 若網址帶有 ?room=XXXX 參數，自動展開加入框並填入代碼
    const urlParams = new URLSearchParams(window.location.search);
    const roomCodeParam = urlParams.get('room');
    if (roomCodeParam) {
        showJoinBox();
        const input = document.getElementById('room-code');
        if (input) input.value = roomCodeParam.toUpperCase();
        setTimeout(() => doJoinRoom(), 400);
    }
});

/** 進入教室設定頁 */
function goToSetup(mode) {
    saveState({ flowMode: mode });
    navigateTo('setup.html');
}

/** 顯示加入房間輸入框 */
function showJoinBox() {
    const box = document.getElementById('join-box');
    box.classList.remove('hidden');
    document.getElementById('room-code').focus();
}

/** 隱藏加入房間輸入框 */
window.hideJoinBox = function() {
    document.getElementById('join-box').classList.add('hidden');
};

/** 加入房間 */
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

        const classSettings = roomSnap.data();
        saveState({
            flowMode: 'onlineJoin',
            isOnlineMode: true,
            isAdmin: false,
            currentRoomCode: roomCode,
            classSettings,
            studentsData: [],
            currentStudentIndex: 0
        });

        navigateTo('input.html');
    } catch (err) {
        console.error('加入房間失敗:', err);
        await showError('加入房間失敗，請檢查網路連線。');
    }
};
