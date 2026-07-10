let isOnlineMode = false; // 標記目前是否為線上模式
let isAdmin = false;       // 標記是否為管理員
let currentRoomCode = '';  // 儲存目前的房間代碼
let unsubscribeSnapshot = null; // 用來取消監聽資料庫
let draggedStudentId = null;   // 記錄目前拖曳的學生座號
let flowMode = 'offline';  // 'offline' | 'onlineCreate' | 'onlineJoin'

// 導入 Firebase Firestore 功能
import { doc, setDoc, getDoc, collection, onSnapshot } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

// 全域變數來存儲設定和學生數據
let classSettings = {
    className: '',      // 班級名稱
    totalRows: 0,       // 總排數 (前後)
    totalCols: 0,       // 總列數 (左右)
    blockedSeats: [],   // 不坐人的座位座標，格式 "row,col"
    allStudentIds: []   // 實際需要分配座位的學生號碼列表 (依可用座位數量自動產生 1..N)
};

let pendingSetup = { className: '', rows: 0, cols: 0 }; // 座位配置頁尚未確認前暫存的教室設定
let layoutBlockedSet = new Set(); // 座位配置頁：目前被標記為「不坐人」的座位

let studentsData = []; // 存儲每個學生的詳細偏好與座位資料
let currentStudentIndex = 0; // 用於追蹤下一個要預填的學生 index (線下模式)

const WEIGHT_LABELS = ['未設定', '普通', '重要', '非常重要', '必須'];

/** 顯示錯誤訊息 */
function displayError(message) {
    const errorDiv = document.getElementById('error-message');
    if (!errorDiv) {
        alert(message);
        return;
    }
    errorDiv.textContent = message;
    errorDiv.style.display = 'block';
    errorDiv.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    setTimeout(() => {
        errorDiv.style.display = 'none'; // 3 秒後自動隱藏
    }, 4000);
}

/** 切換頁面顯示的共用函式 */
function showSection(sectionId) {
    document.querySelectorAll('.page-section').forEach(sec => sec.classList.add('hidden'));
    const target = document.getElementById(sectionId);
    if (target) target.classList.remove('hidden');
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

/** 複製房間代碼 */
window.copyRoomCode = function() {
    const code = document.getElementById('display-room-code').textContent;
    if (code) {
        navigator.clipboard.writeText(code).then(() => {
            alert('房間代碼已複製到剪貼簿！');
        }).catch(err => {
            console.error('複製失敗:', err);
            displayError('複製失敗，請手動複製。');
        });
    }
}

/* =========================================================
   首頁導覽：建立房間 / 加入房間 / 線下模式
   ========================================================= */

/** 從首頁進入教室設定頁 (線上建立房間 或 線下模式共用) */
window.goToSetup = function(mode) {
    flowMode = mode; // 'onlineCreate' 或 'offline'
    showSection('setup-page');
}

/** 從首頁進入加入房間頁 */
window.showJoinRoomPage = function() {
    showSection('join-room-page');
}

/** 返回首頁 */
window.backToLanding = function() {
    showSection('landing-page');
}

/** 從座位配置頁返回教室設定頁 */
window.backToSetup = function() {
    showSection('setup-page');
}

/* =========================================================
   教室設定 -> 座位配置
   ========================================================= */

/** 驗證教室設定並產生座位配置格線 */
window.goToLayoutConfig = function() {
    const className = document.getElementById('class-name').value.trim();
    const rows = parseInt(document.getElementById('rows').value);
    const cols = parseInt(document.getElementById('cols').value);

    if (!className) {
        return displayError("請輸入有效的班級名稱。");
    }
    if (isNaN(rows) || rows <= 0 || isNaN(cols) || cols <= 0) {
        return displayError("請輸入有效的排數和列數 (須為大於 0 的數字)。");
    }
    if (rows * cols > 400) {
        return displayError("教室座位數量過多，請確認排數與列數是否正確。");
    }

    pendingSetup = { className, rows, cols };
    layoutBlockedSet = new Set(); // 每次重新設定教室都重置停用座位

    drawLayoutConfigGrid();
    showSection('layout-config-page');
}

/** 繪製座位配置格線，供點擊切換啟用/停用 */
function drawLayoutConfigGrid() {
    const container = document.getElementById('layout-config-container');
    container.innerHTML = '';
    container.style.display = 'grid';
    container.style.gridTemplateColumns = `repeat(${pendingSetup.cols}, 1fr)`;

    for (let r = 1; r <= pendingSetup.rows; r++) {
        for (let c = 1; c <= pendingSetup.cols; c++) {
            const key = `${r},${c}`;
            const seatDiv = document.createElement('div');
            seatDiv.className = 'layout-seat';
            seatDiv.dataset.key = key;
            seatDiv.textContent = `${r}-${c}`;
            if (layoutBlockedSet.has(key)) {
                seatDiv.classList.add('inactive');
            }
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

/** 更新座位配置頁中的可用座位人數顯示 */
function updateLayoutSeatCount() {
    const total = pendingSetup.rows * pendingSetup.cols;
    const active = total - layoutBlockedSet.size;
    document.getElementById('active-seat-count').textContent = active;
    document.getElementById('total-seat-count').textContent = total;
}

/** 確認座位配置，依模式進入下一步 */
window.confirmLayoutConfig = async function() {
    const total = pendingSetup.rows * pendingSetup.cols;
    const activeCount = total - layoutBlockedSet.size;

    if (activeCount <= 0) {
        return displayError("至少需要保留一個可以坐人的座位。");
    }

    const allStudentIds = [];
    for (let i = 1; i <= activeCount; i++) {
        allStudentIds.push(i);
    }

    classSettings = {
        className: pendingSetup.className,
        totalRows: pendingSetup.rows,
        totalCols: pendingSetup.cols,
        blockedSeats: Array.from(layoutBlockedSet),
        allStudentIds
    };

    studentsData = [];

    if (flowMode === 'offline') {
        isOnlineMode = false;
        isAdmin = false;
        currentStudentIndex = 0;
        updateStudentStatus();

        const statusWrapper = document.getElementById('student-status-wrapper');
        if (statusWrapper) {
            statusWrapper.innerHTML = `目前輸入學生: <span id="current-student-status" style="font-weight: bold; color: var(--primary-color);">0 / ${classSettings.allStudentIds.length}</span>`;
        }

        document.getElementById('student-id').value = classSettings.allStudentIds[0];
        document.getElementById('student-name').value = '';
        resetStudentForm();

        showSection('input-page');
        return;
    }

    if (flowMode === 'onlineCreate') {
        await createOnlineRoom();
    }
}

/* =========================================================
   拖曳式權重滑桿
   ========================================================= */

/** 初始化所有權重拖曳元件 */
function initAllWeightDrags() {
    document.querySelectorAll('.weight-drag').forEach(el => initWeightDrag(el));
}

/** 初始化單一權重拖曳元件 */
function initWeightDrag(dragEl) {
    const track = dragEl.querySelector('.weight-track');
    const handle = dragEl.querySelector('.weight-handle');
    const fill = dragEl.querySelector('.weight-fill');
    const label = dragEl.querySelector('.weight-label');
    const hiddenInput = document.getElementById(dragEl.id.replace('-weight-drag', '-w'));

    // 加入刻度點 (0-4 共 5 個)
    for (let i = 0; i <= 4; i++) {
        const tick = document.createElement('div');
        tick.className = 'weight-tick';
        tick.style.left = `${(i / 4) * 100}%`;
        track.appendChild(tick);
    }
    track.appendChild(handle); // 確保 handle 在最上層

    function setValue(value) {
        value = Math.max(0, Math.min(4, value));
        const percent = (value / 4) * 100;
        handle.style.left = `${percent}%`;
        fill.style.width = `${percent}%`;
        label.textContent = WEIGHT_LABELS[value];
        hiddenInput.value = value;
        dragEl.classList.toggle('active', value > 0);
    }

    function valueFromClientX(clientX) {
        const rect = track.getBoundingClientRect();
        const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
        return Math.round(ratio * 4);
    }

    let dragging = false;

    function onPointerDown(e) {
        dragging = true;
        setValue(valueFromClientX(e.clientX));
        e.preventDefault();
    }
    function onPointerMove(e) {
        if (!dragging) return;
        setValue(valueFromClientX(e.clientX));
    }
    function onPointerUp() {
        dragging = false;
    }

    track.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);

    // 鍵盤操作支援 (左右鍵調整)
    handle.addEventListener('keydown', (e) => {
        const current = parseInt(hiddenInput.value) || 0;
        if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
            setValue(current + 1);
            e.preventDefault();
        } else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
            setValue(current - 1);
            e.preventDefault();
        }
    });

    dragEl._setWeightValue = setValue; // 提供外部呼叫以重置數值
    setValue(0);
}

/** 重置所有權重拖曳元件為 0 */
function resetAllWeightDrags() {
    document.querySelectorAll('.weight-drag').forEach(el => {
        if (el._setWeightValue) el._setWeightValue(0);
    });
}

/* =========================================================
   線下模式：學生條件輸入流程
   ========================================================= */

/** 更新學生輸入進度顯示 */
function updateStudentStatus() {
    const totalStudents = classSettings.allStudentIds.length;
    const completedCount = studentsData.length;
    const currentStatusElement = document.getElementById('current-student-status');
    if (currentStatusElement) {
        currentStatusElement.textContent = `${completedCount} / ${totalStudents}`;
    }
}

/** 提交學生偏好資料 */
window.submitStudentPreferences = function() {
    const studentId = parseInt(document.getElementById('student-id').value);
    const studentName = document.getElementById('student-name').value.trim();

    // --- 1. 學生 ID 驗證 ---
    if (isNaN(studentId) || studentId <= 0) {
        return displayError("請輸入有效的座號。");
    }
    if (!classSettings.allStudentIds.includes(studentId)) {
        return displayError("輸入錯誤: 此座號不是該班級的有效座號。");
    }

    // --- 2. 條件與權重驗證 ---
    const preferences = [
        { id: 'pref-1-id', w: 'pref-1-w', type: 'id', name: '想跟誰坐(1)' },
        { id: 'pref-2-id', w: 'pref-2-w', type: 'id', name: '想跟誰坐(2)' },
        { id: 'pref-5-val', w: 'pref-5-w', type: 'select', name: '前後偏好' },
        { id: 'pref-6-val', w: 'pref-6-w', type: 'select', name: '左右偏好' }
    ];

    const studentPreferences = { wantToSitWith: [], frontBack: {}, leftRightCenter: {} };
    const partnerIdsSet = new Set();

    for (const pref of preferences) {
        const val = document.getElementById(pref.id).value.trim();
        const weight = parseInt(document.getElementById(pref.w).value) || 0;

        const hasValue = (pref.type === 'id') ? !!val : (val !== '不限');
        const hasWeight = weight > 0;

        if (hasValue && !hasWeight) {
            return displayError(`輸入錯誤: 您設定了「${pref.name}」條件，但還沒拖曳設定重視程度。`);
        }
        if (!hasValue && hasWeight) {
            return displayError(`輸入錯誤: 您設定了「${pref.name}」的重視程度，但未填入條件。`);
        }

        if (hasValue && hasWeight) {
            // 收集數據與額外 bug 檢查
            if (pref.type === 'id') {
                const partnerId = parseInt(val);
                if (isNaN(partnerId)) {
                    return displayError("輸入錯誤: 朋友的座號必須是數字。");
                }
                if (partnerId === studentId) {
                    return displayError("輸入錯誤: 您不能選擇自己作為「想跟誰坐」的對象。");
                }
                if (partnerIdsSet.has(partnerId)) {
                    return displayError("輸入錯誤: 您重複選擇了同一個朋友座號。");
                }
                partnerIdsSet.add(partnerId);

                if (classSettings.allStudentIds.includes(partnerId)) {
                    studentPreferences.wantToSitWith.push({ id: partnerId, weight: weight });
                } else {
                    return displayError(`輸入錯誤: 座號 ${partnerId} 不是班上的有效座號。`);
                }
            } else if (pref.name === '前後偏好') {
                studentPreferences.frontBack = { value: val, weight: weight };
            } else if (pref.name === '左右偏好') {
                studentPreferences.leftRightCenter = { value: val, weight: weight };
            }
        }
    }

    // --- 3. 整理偏好數據 (若無輸入，則補全為預設值) ---
    const newStudentData = {
        studentId: studentId,
        studentName: studentName || '',
        preferences: {
            wantToSitWith: studentPreferences.wantToSitWith,
            frontBack: studentPreferences.frontBack.value ? studentPreferences.frontBack : { value: '不限', weight: 0 },
            leftRightCenter: studentPreferences.leftRightCenter.value ? studentPreferences.leftRightCenter : { value: '不限', weight: 0 }
        },
        seat: null
    };

    // --- 4. 存儲數據並推進流程 ---
    // === 線上模式：資料傳上雲端 ===
    if (isOnlineMode) {
        const studentDocRef = doc(window.db, "rooms", currentRoomCode, "students", studentId.toString());
        setDoc(studentDocRef, newStudentData)
            .then(() => {
                alert("您的條件資料已成功送出！請靜待管理員生成座位表。");
                // 鎖定表單，防止重複點擊與修改
                document.getElementById('student-form-container').innerHTML =
                    "<div style='text-align: center; padding: 30px;'>" +
                    "<h3 style='color: var(--accent-deep); margin-bottom: 10px;'>✓ 感謝您的填寫！</h3>" +
                    "<p style='color: var(--text-secondary);'>資料已同步至雲端，請等待前方螢幕顯示座位表。</p>" +
                    "</div>";
            })
            .catch(error => {
                console.error("資料上傳失敗:", error);
                displayError("雲端儲存失敗，請檢查網路連線後重試。");
            });
        return;
    }

    // === 單機線下模式：存入本地陣列 ===
    const existingIndex = studentsData.findIndex(student => student.studentId === studentId);
    if (existingIndex !== -1) {
        if (!confirm(`座號 ${studentId} 已經填過偏好，是否要覆蓋原本的資料？`)) {
            return;
        }
        studentsData[existingIndex] = newStudentData;
    } else {
        studentsData.push(newStudentData);
    }

    studentsData.sort((a, b) => a.studentId - b.studentId);
    resetStudentForm();

    // 自動尋找下一個「還沒填寫偏好」的學生座號填入
    const nextUnenteredStudent = classSettings.allStudentIds.find(id => !studentsData.some(s => s.studentId === id));
    if (nextUnenteredStudent !== undefined) {
        document.getElementById('student-id').value = nextUnenteredStudent;
    } else {
        document.getElementById('student-id').value = '';
    }

    updateStudentStatus();

    // 檢查是否所有人都填寫完畢
    if (studentsData.length === classSettings.allStudentIds.length) {
        alert("班級所有學生偏好已填寫完畢！即將為您分配最佳座位。");
        showSection('result-page');
        distributeSeats();
    }
}

/** 重置學生輸入表單 */
function resetStudentForm() {
    const preferenceInputs = document.querySelectorAll('#student-form-container input, #student-form-container select');
    preferenceInputs.forEach(input => {
        if (input.id !== 'student-id' && input.type !== 'hidden') {
            if (input.tagName === 'SELECT') {
                input.value = '不限';
            } else {
                input.value = '';
            }
        }
    });
    resetAllWeightDrags();
}

/** 判斷座位屬於哪個 前/中/後 區域 */
function getFrontBackZone(row) {
    const totalRows = classSettings.totalRows;
    const third = Math.ceil(totalRows / 3);
    if (row <= third) return '前';
    if (row <= 2 * third) return '中';
    return '後';
}

/** 判斷座位屬於哪個 左/中/右 區域 */
function getLeftRightCenterZone(col) {
    const totalCols = classSettings.totalCols;
    const third = Math.ceil(totalCols / 3);
    if (col <= third) return '左';
    if (col <= 2 * third) return '中';
    return '右';
}

/** 判斷座位是否緊鄰 */
function isAdjacent(seatA, seatB) {
    if (!seatA || !seatB) return false;
    const rowDiff = Math.abs(seatA.row - seatB.row);
    const colDiff = Math.abs(seatA.col - seatB.col);
    // 這裡定義的緊鄰包括左右、前後、以及斜角緊鄰
    return (rowDiff <= 1 && colDiff <= 1) && (rowDiff !== 0 || colDiff !== 0);
}

/** 判斷座位是否為停用座位 (不坐人) */
function isBlockedSeat(row, col) {
    return (classSettings.blockedSeats || []).includes(`${row},${col}`);
}

/** 獲取所有目前空置且可用的座位座標 */
function getEmptySeats() {
    const occupied = new Set(studentsData.filter(s => s.seat).map(s => `${s.seat.row},${s.seat.col}`));
    const empty = [];
    for (let r = 1; r <= classSettings.totalRows; r++) {
        for (let c = 1; c <= classSettings.totalCols; c++) {
            if (isBlockedSeat(r, c)) continue;
            if (!occupied.has(`${r},${c}`)) {
                empty.push({ row: r, col: c });
            }
        }
    }
    return empty;
}

/** 計算單一學生在某特定座位的滿意度分數 */
function calculateScore(studentData, seatPosition) {
    let score = 0;
    const pref = studentData.preferences;

    // 1. 區域偏好：前後
    const frontBackPref = pref.frontBack;
    if (frontBackPref.value && frontBackPref.value !== '不限') {
        if (getFrontBackZone(seatPosition.row) === frontBackPref.value) {
            score += frontBackPref.weight * 10;
        } else {
            score -= frontBackPref.weight * 5;
        }
    }

    // 2. 區域偏好：左右
    const leftRightPref = pref.leftRightCenter;
    if (leftRightPref.value && leftRightPref.value !== '不限') {
        if (getLeftRightCenterZone(seatPosition.col) === leftRightPref.value) {
            score += leftRightPref.weight * 10;
        } else {
            score -= leftRightPref.weight * 5;
        }
    }

    // 3. 朋友偏好：「Greedy 階段」若朋友已入座，計算與該朋友座位的鄰近分數加成
    pref.wantToSitWith.forEach(p => {
        const partner = studentsData.find(s => s.studentId === p.id);
        if (partner && partner.seat) {
            if (isAdjacent(seatPosition, partner.seat)) {
                score += p.weight * 50;
            } else if (Math.abs(seatPosition.row - partner.seat.row) <= 2 &&
                       Math.abs(seatPosition.col - partner.seat.col) <= 2) {
                score += p.weight * 10;
            }
        } else {
            // 對方尚未排定座位，提供基礎權重底分
            score += p.weight;
        }
    });

    return score;
}

/** 計算全班座位分配的總滿意度得分 */
function calculateTotalSatisfaction() {
    let totalScore = 0;
    studentsData.forEach(student => {
        if (!student.seat) return;
        totalScore += calculateScore(student, student.seat);

        studentsData.forEach(otherStudent => {
            if (student.studentId === otherStudent.studentId || !otherStudent.seat) return;

            const desirePref = student.preferences.wantToSitWith.find(p => p.id === otherStudent.studentId);
            if (desirePref) {
                if (isAdjacent(student.seat, otherStudent.seat)) {
                    totalScore += desirePref.weight * 50;
                } else if (Math.abs(student.seat.row - otherStudent.seat.row) <= 2 &&
                           Math.abs(student.seat.col - otherStudent.seat.col) <= 2) {
                    totalScore += desirePref.weight * 10;
                }
            }
        });
    });
    return totalScore;
}

/** 核心座位分配演算法 */
window.distributeSeats = function() {
    // 1. 重置學生座位並計算權重
    studentsData.forEach(student => {
        student.seat = null;
        student.totalWeight = student.preferences.wantToSitWith.reduce((sum, p) => sum + p.weight, 0) +
                              (student.preferences.frontBack.weight || 0) +
                              (student.preferences.leftRightCenter.weight || 0);
    });

    // 2. 初始化可用座位 (排除停用座位)
    let availableSeats = [];
    for (let r = 1; r <= classSettings.totalRows; r++) {
        for (let c = 1; c <= classSettings.totalCols; c++) {
            if (isBlockedSeat(r, c)) continue;
            availableSeats.push({ row: r, col: c });
        }
    }

    // 3. 依總權重排序學生，由高權重者優先進行 Greedy 分配
    const sortedStudents = [...studentsData].sort((a, b) => b.totalWeight - a.totalWeight);

    // 4. 核心貪婪分配
    sortedStudents.forEach(student => {
        let bestSeat = null;
        let maxScore = -Infinity;
        let potentialSeats = [];

        availableSeats.forEach(seat => {
            const currentScore = calculateScore(student, seat);
            if (currentScore > maxScore) {
                maxScore = currentScore;
                potentialSeats = [seat];
            } else if (currentScore === maxScore) {
                potentialSeats.push(seat);
            }
        });

        if (potentialSeats.length > 0) {
            const randomIndex = Math.floor(Math.random() * potentialSeats.length);
            bestSeat = potentialSeats[randomIndex];
            student.seat = bestSeat;
            availableSeats = availableSeats.filter(s => !(s.row === bestSeat.row && s.col === bestSeat.col));
        } else if (availableSeats.length > 0) {
            const randomIndex = Math.floor(Math.random() * availableSeats.length);
            student.seat = availableSeats.splice(randomIndex, 1)[0];
        }
    });

    // 5. 第二階段優化 (Local Search - 納入「空座位」的優化調整)
    const NUM_ITERATIONS = 5000;
    for (let i = 0; i < NUM_ITERATIONS; i++) {
        const indexA = Math.floor(Math.random() * studentsData.length);
        const studentA = studentsData[indexA];
        if (!studentA || !studentA.seat) continue;

        const originalScore = calculateTotalSatisfaction();
        const seatA = studentA.seat;

        const emptySeats = getEmptySeats();
        const chooseEmpty = emptySeats.length > 0 && Math.random() < 0.3; // 30% 機率讓學生搬到空位優化

        if (chooseEmpty) {
            const emptySeat = emptySeats[Math.floor(Math.random() * emptySeats.length)];
            studentA.seat = emptySeat;
            const newScore = calculateTotalSatisfaction();
            if (newScore <= originalScore) {
                studentA.seat = seatA; // 搬過去沒有變更好，移回來
            }
        } else {
            // 交換兩個學生
            const indexB = Math.floor(Math.random() * studentsData.length);
            if (indexA === indexB) continue;

            const studentB = studentsData[indexB];
            if (!studentB || !studentB.seat) continue;

            const seatB = studentB.seat;
            studentA.seat = seatB;
            studentB.seat = seatA;
            const newScore = calculateTotalSatisfaction();

            if (newScore <= originalScore) {
                studentA.seat = seatA; // 交換沒有變更好，換回來
                studentB.seat = seatB;
            }
        }
    }

    // 繪製座位圖
    drawSeatMap();

    // 如果是線上模式且是管理員，將最終排好的座位同步到雲端 Firestore
    if (isOnlineMode && isAdmin) {
        saveSeatsToCloud();
    }
}

/** 將座位表數據與狀態同步至 Firestore */
async function saveSeatsToCloud() {
    if (isOnlineMode && isAdmin && currentRoomCode) {
        try {
            const roomRef = doc(window.db, "rooms", currentRoomCode);
            await setDoc(roomRef, {
                status: 'generated',
                seats: studentsData
            }, { merge: true });
        } catch (error) {
            console.error("同步座位到雲端失敗:", error);
        }
    }
}

/** 繪製座位表與拖曳事件註冊 */
function drawSeatMap() {
    const container = document.getElementById('seat-map-container');
    if (!container) return;
    container.innerHTML = '';
    container.style.display = 'grid';
    container.style.gridTemplateColumns = `repeat(${classSettings.totalCols}, 1fr)`;

    // 只有非線上模式，或者是線上模式的管理員才可以進行拖曳修改
    const canDrag = !isOnlineMode || isAdmin;

    for (let r = 1; r <= classSettings.totalRows; r++) {
        for (let c = 1; c <= classSettings.totalCols; c++) {
            const seatDiv = document.createElement('div');
            seatDiv.className = 'seat-box';

            // 綁定 row/col 資料以便在 dragover/drop 事件中識別
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
                seatDiv.innerHTML = `
                    <div class="seat-student-id">${student.studentId} 號</div>
                    <div class="seat-student-name">${student.studentName || '無姓名'}</div>
                `;
                seatDiv.title = `排: ${r}, 列: ${c}\n學生: ${student.studentId} 號` + (student.studentName ? ` - ${student.studentName}` : '');
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
            }

            container.appendChild(seatDiv);
        }
    }
}

// --- 拖曳事件處理處理器 ---
function handleDragStart(e) {
    const box = e.target.closest('.seat-box');
    if (!box) return;
    draggedStudentId = parseInt(box.dataset.studentId);
    box.classList.add('dragging');
}

function handleDragOver(e) {
    const box = e.target.closest('.seat-box');
    if (box && box.classList.contains('blocked')) return;
    e.preventDefault(); // 必須阻止預設行為才能觸發 drop
    if (box) {
        box.classList.add('drag-over');
    }
}

function handleDragLeave(e) {
    const box = e.target.closest('.seat-box');
    if (box) {
        box.classList.remove('drag-over');
    }
}

function handleDragEnd(e) {
    const box = e.target.closest('.seat-box');
    if (box) {
        box.classList.remove('dragging');
    }
    document.querySelectorAll('.seat-box').forEach(el => el.classList.remove('drag-over'));
    draggedStudentId = null;
}

function handleDrop(e) {
    e.preventDefault();
    const targetSeatDiv = e.target.closest('.seat-box');
    if (!targetSeatDiv || !draggedStudentId) return;
    if (targetSeatDiv.classList.contains('blocked')) return; // 不能放到停用座位

    targetSeatDiv.classList.remove('drag-over');

    const targetRow = parseInt(targetSeatDiv.dataset.row);
    const targetCol = parseInt(targetSeatDiv.dataset.col);

    const draggedStudent = studentsData.find(s => s.studentId === draggedStudentId);
    if (!draggedStudent) return;

    // 尋找目標位置的學生
    const targetStudent = studentsData.find(s => s.seat && s.seat.row === targetRow && s.seat.col === targetCol);

    if (targetStudent) {
        // 交換座位
        const tempSeat = draggedStudent.seat;
        draggedStudent.seat = targetStudent.seat;
        targetStudent.seat = tempSeat;
    } else {
        // 直接將學生移至空座位
        draggedStudent.seat = { row: targetRow, col: targetCol };
    }

    drawSeatMap();

    // 如果在線上模式且是管理員，同步拖曳調整後的最新座位到雲端
    if (isOnlineMode && isAdmin) {
        saveSeatsToCloud();
    }
}

/** 下載為 DOC 檔案 (支援莫蘭迪風格網頁結構導出) */
window.downloadDoc = function() {
    let content = `
        <html>
        <head>
            <meta charset="UTF-8">
            <style>
                body { font-family: 'Arial', sans-serif; background-color: #f4f6f7; color: #38424a; padding: 20px; }
                h1 { text-align: center; color: #38424a; margin-bottom: 5px; }
                .subtitle { text-align: center; color: #7c8a94; font-size: 14px; margin-bottom: 20px; }
                .podium-bar { width: 200px; height: 30px; background-color: #d6dee4; border-radius: 15px; margin: 10px auto 25px auto; text-align: center; line-height: 30px; font-weight: bold; color: #61707c; font-size: 12px; }
                table { border-collapse: separate; border-spacing: 10px; width: 100%; max-width: 800px; margin: 0 auto; }
                td {
                    border: 1px solid #e0e5e8;
                    background-color: #ffffff;
                    padding: 12px;
                    text-align: center;
                    height: 70px;
                    width: ${100 / classSettings.totalCols}%;
                    border-radius: 8px;
                    font-size: 14px;
                }
                .occupied { background-color: #edf2f7; border-color: #8da1b9; }
                .student-id { font-size: 10px; color: #7c8a94; margin-bottom: 4px; }
                .student-name { font-weight: bold; font-size: 14px; color: #38424a; }
                .empty { border-style: dashed; background-color: #fafbfc; color: #7c8a94; }
                .blocked { background-color: #e7eaec; color: #a3aeb6; }
            </style>
        </head>
        <body>
            <h1>${classSettings.className} 座位表</h1>
            <div class="subtitle">排座位終結者自動分配結果</div>
            <div class="podium-bar">講台 (前方)</div>
            <table>`;

    for (let r = 1; r <= classSettings.totalRows; r++) {
        content += '<tr>';
        for (let c = 1; c <= classSettings.totalCols; c++) {
            if (isBlockedSeat(r, c)) {
                content += '<td class="blocked"><div>(不坐人)</div></td>';
                continue;
            }
            const student = studentsData.find(s => s.seat && s.seat.row === r && s.seat.col === c);
            if (student) {
                content += `
                    <td class="occupied">
                        <div class="student-id">${student.studentId} 號</div>
                        <div class="student-name">${student.studentName || '無姓名'}</div>
                    </td>`;
            } else {
                content += '<td class="empty"><div>(空位)</div></td>';
            }
        }
        content += '</tr>';
    }

    content += `
            </table>
        </body>
        </html>`;

    const blob = new Blob([content], { type: 'application/msword;charset=utf-8' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `${classSettings.className}_座位表.doc`;

    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

/* =========================================================
   線上模式：管理員建立房間
   ========================================================= */
async function createOnlineRoom() {
    // 生成隨機 6 碼英數代碼
    currentRoomCode = Math.random().toString(36).substring(2, 8).toUpperCase();

    isOnlineMode = true;
    isAdmin = true;
    studentsData = [];

    try {
        // 1. 將房間設定寫入 Firestore 'rooms' 集合，並設定初始狀態 status = 'waiting'
        await setDoc(doc(window.db, "rooms", currentRoomCode), {
            ...classSettings,
            status: 'waiting',
            seats: []
        });

        // 2. 切換畫面至管理員等待房
        document.getElementById('display-room-code').textContent = currentRoomCode;
        document.getElementById('online-student-status').textContent = `0 / ${classSettings.allStudentIds.length}`;
        document.getElementById('submitted-students-list').innerHTML = '';
        
        // --- 新增：產生 QR Code ---
        const qrcodeContainer = document.getElementById('qrcode-container');
        qrcodeContainer.innerHTML = ''; // 清除舊的 QR Code
        const joinUrl = window.location.origin + window.location.pathname + "?room=" + currentRoomCode;
        new QRCode(qrcodeContainer, {
            text: joinUrl,
            width: 160,
            height: 160,
            colorDark : "#38424a",
            colorLight : "#ffffff",
            correctLevel : QRCode.CorrectLevel.H
        });
        // -------------------------

        showSection('admin-waiting-page');

        // 3. 即時監聽學生提交的資料
        listenToStudentSubmissions();
    } catch (error) {
        console.error("建立房間失敗:", error);
        displayError("建立房間失敗，請檢查網路連線或 Firebase 金鑰配置。");
        showSection('layout-config-page');
    }
}

// --- 【線上模式：管理員】即時監聽學生提交的資料 ---
function listenToStudentSubmissions() {
    const studentsRef = collection(window.db, "rooms", currentRoomCode, "students");

    if (unsubscribeSnapshot) unsubscribeSnapshot();

    unsubscribeSnapshot = onSnapshot(studentsRef, (snapshot) => {
        studentsData = []; // 清空管理員本地舊資料
        const listEl = document.getElementById('submitted-students-list');
        listEl.innerHTML = ''; // 清空畫面列表

        snapshot.forEach((docSnap) => {
            const student = docSnap.data();
            studentsData.push(student);

            // 在管理員畫面上列出已送出者
            const li = document.createElement('li');
            li.innerHTML = `
                <span>座號 <b>${student.studentId}</b>：${student.studentName || '未填姓名'}</span>
                <span style="color: var(--accent-deep); font-size: 0.8rem; font-weight: 500;">已填寫偏好</span>
            `;
            listEl.appendChild(li);
        });

        // 更新提交人數進度
        document.getElementById('online-student-status').textContent = `${studentsData.length} / ${classSettings.allStudentIds.length}`;
    });
}

// --- 【線上模式：管理員】結束收集並生成座位表 ---
window.finishOnlineCollection = function() {
    if (studentsData.length === 0) {
        alert("目前還沒有任何學生提交資料喔！");
        return;
    }

    if (confirm(`目前收到 ${studentsData.length} 筆資料，確定要結束收集並生成座位表嗎？`)) {
        if (unsubscribeSnapshot) {
            unsubscribeSnapshot(); // 停止監聽學生新提交，省流量
            unsubscribeSnapshot = null;
        }

        showSection('result-page');

        // 執行分配與自動雲端同步
        window.distributeSeats();
    }
}

// --- 【線上模式：學生】輸入代碼加入房間 ---
window.joinRoom = async function() {
    const roomCode = document.getElementById('room-code').value.trim().toUpperCase();
    if (!roomCode) return displayError("請輸入房間代碼。");

    try {
        const roomRef = doc(window.db, "rooms", roomCode);
        const roomSnap = await getDoc(roomRef);

        if (!roomSnap.exists()) {
            return displayError("找不到該房間，請確認房間代碼是否正確。");
        }

        // 讀取雲端的班級設定，覆蓋本地變數
        classSettings = roomSnap.data();
        currentRoomCode = roomCode;
        flowMode = 'onlineJoin';
        isOnlineMode = true;
        isAdmin = false;
        studentsData = [];

        // 切換到學生輸入畫面
        showSection('input-page');

        // 修改進度文字，顯示目前是線上模式
        const statusWrapper = document.getElementById('student-status-wrapper');
        if (statusWrapper) {
            statusWrapper.innerHTML = `線上模式：房間代碼 <b style="color: var(--primary-color);">${roomCode}</b> (班級：${classSettings.className})`;
        }

        // 清空輸入框讓學生填寫自己
        document.getElementById('student-id').value = '';
        document.getElementById('student-name').value = '';
        resetStudentForm();

        // 學生端開始即時監聽房間文件狀態變更
        listenToRoomStatusForStudent();
    } catch (error) {
        console.error("加入房間失敗:", error);
        displayError("加入房間失敗，請檢查網路連線。");
    }
}

// --- 【線上模式：學生】即時監聽房間狀態以呈現座位表 ---
function listenToRoomStatusForStudent() {
    const roomRef = doc(window.db, "rooms", currentRoomCode);

    if (unsubscribeSnapshot) unsubscribeSnapshot();

    unsubscribeSnapshot = onSnapshot(roomRef, (docSnap) => {
        if (docSnap.exists()) {
            const roomData = docSnap.data();
            // 當管理員生成座位表後，status 會轉為 'generated' 且有 seats 陣列
            if (roomData.status === 'generated' && roomData.seats) {
                studentsData = roomData.seats;
                classSettings.blockedSeats = roomData.blockedSeats || classSettings.blockedSeats;

                // 停止監聽以節省資源
                if (unsubscribeSnapshot) {
                    unsubscribeSnapshot();
                    unsubscribeSnapshot = null;
                }

                // 學生端自動跳轉至座位表畫面
                showSection('result-page');

                // 學生端隱藏「重新分配」按鈕
                const redistributeBtn = document.getElementById('redistribute-btn');
                if (redistributeBtn) {
                    redistributeBtn.style.display = 'none';
                }

                // 繪製座位表 (此時為唯讀模式，不能拖曳)
                drawSeatMap();
            }
        }
    });
}

// --- 初始化：設定所有拖曳式權重滑桿與自動加入邏輯 ---
document.addEventListener('DOMContentLoaded', () => {
    initAllWeightDrags();

    // 新增：檢查網址是否有帶入房間代碼參數 (例如 ?room=A1B2C3)
    const urlParams = new URLSearchParams(window.location.search);
    const roomCodeParam = urlParams.get('room');

    if (roomCodeParam) {
        // 找到輸入框並自動填入
        const roomInput = document.getElementById('room-code');
        if (roomInput) {
            roomInput.value = roomCodeParam;
            
            // 延遲執行，確保 Firebase 與頁面渲染完成
            setTimeout(() => {
                window.joinRoom();
            }, 500);
        }
    }
});