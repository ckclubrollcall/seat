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
    if (target) {
        target.classList.remove('hidden');
        // 重新觸發進場動畫（先移除再強制 reflow，讓每次切換都有淡入效果）
        target.classList.remove('page-enter');
        void target.offsetWidth;
        target.classList.add('page-enter');
    }
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
    container.style.gridTemplateColumns = `repeat(${pendingSetup.cols}, minmax(56px, 1fr))`;

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

    // --- 2. 條件與權重驗證（依照拖曳順序給分） ---
    const studentPreferences = { wantToSitWith: [], frontBack: {}, leftRightCenter: {} };
    const partnerIdsSet = new Set();
    
    // 取得畫面上目前排序好的所有條件區塊
    const conditionGroups = document.querySelectorAll('#condition-list .condition-group');
    let currentWeight = 4; // 第一順位給予最高權重 4，接下來遞減

    for (const group of conditionGroups) {
        // 找到該區塊內的輸入框或下拉選單
        const input = group.querySelector('input:not(.preference-id)[type="number"], input.preference-id, select');
        if (!input) continue;

        const val = input.value.trim();
        const id = input.id;
        
        const isIdType = (id === 'pref-1-id' || id === 'pref-2-id');
        const hasValue = isIdType ? !!val : (val !== '不限');

        // 如果學生有填寫該條件，才賦予權重
        if (hasValue) {
            const weight = currentWeight > 0 ? currentWeight : 1; // 最少給 1 分
            currentWeight--; // 下一個有效條件的權重遞減

            if (isIdType) {
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
            } else if (id === 'pref-5-val') {
                studentPreferences.frontBack = { value: val, weight: weight };
            } else if (id === 'pref-6-val') {
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
        renderModeRecommendation(true); // 依填答狀況分析並自動套用建議模式
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


/** 計算全班座位分配的總滿意度得分 */
/** * 新增：計算單一學生在特定座位的各項滿意度 (連續計分) 
 * @returns {Object} 包含前後、左右、好友與總分的物件
 */
function calculateStudentSatisfaction(student, seatPosition = null, allStudents = studentsData) {
    const seat = seatPosition || student.seat;
    if (!seat) return { frontBack: 0, leftRight: 0, friends: 0, total: 0 };

    let fbScore = 0;
    let lrScore = 0;
    let frScore = 0;
    const pref = student.preferences;

    // 1. 前後方位 (乘數從 10 改為 50，與好友平權)
    if (pref.frontBack.value && pref.frontBack.value !== '不限' && classSettings.totalRows > 1) {
        const row = seat.row;
        const maxR = classSettings.totalRows;
        let ratio = 0;
        
        if (pref.frontBack.value === '前') {
            ratio = (maxR - row) / (maxR - 1);
        } else if (pref.frontBack.value === '後') {
            ratio = (row - 1) / (maxR - 1);
        } else if (pref.frontBack.value === '中') {
            const center = (maxR + 1) / 2;
            const maxDist = (maxR - 1) / 2;
            ratio = 1 - (Math.abs(row - center) / maxDist);
        }
        fbScore = ratio * pref.frontBack.weight * 50; // <-- 修正這裡
    }

    // 2. 左右方位 (乘數從 10 改為 50，與好友平權)
    if (pref.leftRightCenter.value && pref.leftRightCenter.value !== '不限' && classSettings.totalCols > 1) {
        const col = seat.col;
        const maxC = classSettings.totalCols;
        let ratio = 0;
        
        if (pref.leftRightCenter.value === '左') {
            ratio = (maxC - col) / (maxC - 1);
        } else if (pref.leftRightCenter.value === '右') {
            ratio = (col - 1) / (maxC - 1);
        } else if (pref.leftRightCenter.value === '中') {
            const center = (maxC + 1) / 2;
            const maxDist = (maxC - 1) / 2;
            ratio = 1 - (Math.abs(col - center) / maxDist);
        }
        lrScore = ratio * pref.leftRightCenter.weight * 50; // <-- 修正這裡
    }

    // 3. 好友距離 (保持 50)
    pref.wantToSitWith.forEach(p => {
        const partner = allStudents.find(s => s.studentId === p.id);
        if (partner && partner.seat) {
            const rowDiff = Math.abs(seat.row - partner.seat.row);
            const colDiff = Math.abs(seat.col - partner.seat.col);
            // 取得橫向與縱向的最大差值
            const dist = Math.max(rowDiff, colDiff); 
            // 當 dist == 1 (包含斜對角)，ratio 為 1 (不扣分)
            const ratio = Math.max(0, 1 - (dist - 1) * 0.25);
            frScore += ratio * p.weight * 50; 
        }
    });

    return {
        frontBack: fbScore,
        leftRight: lrScore,
        friends: frScore,
        total: fbScore + lrScore + frScore
    };
}

/** * 新增：評估當前全班座位分配的系統總能量 (結合公平係數)
 */
function evaluateSystem(allStudents) {
    const scores = allStudents.map(s => calculateStudentSatisfaction(s, s.seat, allStudents).total);
    if (scores.length === 0) return 0;

    const sum = scores.reduce((a, b) => a + b, 0);
    const mean = sum / scores.length;
    const variance = scores.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / scores.length;
    const stdDev = Math.sqrt(variance);

    // 讀取 UI 選擇的演算法模式
    const modeSelect = document.getElementById('algo-mode');
    const mode = modeSelect ? modeSelect.value : 'balanced';
    const N = scores.length; // 取得班級人數

    // 依據模式決定目標函式 (依人數標準化，確保任何班級規模都有相等保護力)
    if (mode === 'max_score') {
        return sum; // 最大滿意度：追求總分最高
    } else if (mode === 'fairness') {
        // 公平優先：懲罰分數落差，但避免犧牲過多整體滿意度
        // (實測比較：1.5 會讓總分掉 ~27% 才換到標準差降 ~48%，效益不佳；
        //  0.9 只犧牲 ~8.5% 總分就能降低 ~22% 標準差，CP 值更高)
        return (mean - (stdDev * 0.9)) * N; 
    } else {
        // 平衡模式 (預設)：適度懲罰落差 (約等於舊版的 stdDev * 5)
        return (mean - (stdDev * 0.5)) * N; 
    }
}

/* =========================================================
   智慧推薦演算法模式：依據學生實際填答狀況分析後推薦
   ========================================================= */

const ALGO_MODE_LABELS = {
    balanced: '⚖️ 平衡模式',
    max_score: '🔥 最大滿意度',
    fairness: '🤝 公平優先'
};

/**
 * 分析全班填答狀況，回傳建議的演算法模式與理由
 * 判斷依據：
 *  1. 平均需求強度：大家填得越「隨便」，模式差異越小 -> 平衡模式即可
 *  2. 需求分佈的變異係數 (CV)：有人瘋狂填權重、有人完全不填 -> 落差大則優先保護弱勢，用公平優先
 *  3. 「過熱」好友指名：同一位同學被 3 人以上高權重指名 -> 座位一定不夠分，必有人失望，用公平優先降低傷害
 *  4. 需求集中且不衝突時 -> 可以放心衝最大滿意度
 */
function analyzeAndRecommendMode() {
    const students = studentsData;
    const N = students.length;
    if (N === 0) return null;

    // 計算每位學生的「需求強度」= 方位權重 + 所有好友指名權重加總
    const demandList = students.map(s => {
        const p = s.preferences || {};
        let demand = 0;
        if (p.frontBack && p.frontBack.value && p.frontBack.value !== '不限') demand += (p.frontBack.weight || 0);
        if (p.leftRightCenter && p.leftRightCenter.value && p.leftRightCenter.value !== '不限') demand += (p.leftRightCenter.weight || 0);
        (p.wantToSitWith || []).forEach(w => demand += (w.weight || 0));
        return demand;
    });

// 把「完全沒填」跟「有填但需求普通」分開看：demand=0 代表主動放棄、怎樣都好，
    // 不該被當成「需求被忽略」混進落差計算，否則會誤判成需要公平優先
    const respondersDemand = demandList.filter(d => d > 0);
    const responderCount = respondersDemand.length;
    const nonResponderRatio = (N - responderCount) / N;

    const meanDemand = responderCount > 0 ? respondersDemand.reduce((a, b) => a + b, 0) / responderCount : 0;
    const variance = responderCount > 0
        ? respondersDemand.reduce((a, b) => a + Math.pow(b - meanDemand, 2), 0) / responderCount
        : 0;
    const stdDev = Math.sqrt(variance);
    const cv = meanDemand > 0 ? stdDev / meanDemand : 0; // 變異係數：在「有填的人」之中，需求落差是否懸殊

    // 統計每個座號被指名的「熱度」，找出被多人高權重搶著坐附近的過熱目標
    const targetHeat = {};
    students.forEach(s => {
        (s?.preferences?.wantToSitWith || []).forEach(w => {
            if (!targetHeat[w.id]) targetHeat[w.id] = { count: 0, highWeightCount: 0 };
            targetHeat[w.id].count++;
            if (w.weight >= 3) targetHeat[w.id].highWeightCount++;
        });
    });
    const overloadedTargets = Object.values(targetHeat).filter(t => t.count >= 3 && t.highWeightCount >= 2).length;

    // --- 決策邏輯 ---
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

/** 顯示推薦模式卡片；autoApply 為 true 時，會在首次生成座位表前直接套用建議值 */
function renderModeRecommendation(autoApply = false) {
    const banner = document.getElementById('mode-recommendation');
    if (!banner) return;

    const result = analyzeAndRecommendMode();
    if (!result) {
        banner.classList.add('hidden');
        return;
    }

    document.getElementById('recommend-mode-label').textContent = ALGO_MODE_LABELS[result.mode];
    document.getElementById('recommend-mode-reason').textContent = result.reason;
    banner.dataset.recommendedMode = result.mode;
    banner.classList.remove('hidden');

    if (autoApply) {
        const modeSelect = document.getElementById('algo-mode');
        if (modeSelect) modeSelect.value = result.mode;
    }
}

/** 套用建議的演算法模式並立即重新分配 */
window.applyRecommendedMode = function() {
    const banner = document.getElementById('mode-recommendation');
    const mode = banner ? banner.dataset.recommendedMode : null;
    if (!mode) return;

    const modeSelect = document.getElementById('algo-mode');
    if (modeSelect) modeSelect.value = mode;

    distributeSeats();
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
    container.style.gridTemplateColumns = `repeat(${classSettings.totalCols}, minmax(64px, 1fr))`;

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

/**
 * 匯出座位表為 Word 檔 (.doc)
 * 特色：1. 版面強制橫向防跑版  2. 老師視角 (第一排在下方)
 */
window.downloadDoc = function() {
    // 1. 建立 Word 專用的 HTML 結構，加入 Word 專屬的 XML 與 CSS 樣式
    const header = `
        <html xmlns:o='urn:schemas-microsoft-com:office:office' 
              xmlns:w='urn:schemas-microsoft-com:office:word' 
              xmlns='http://www.w3.org/TR/REC-html40'>
        <head>
            <meta charset='utf-8'>
            <style>
                /* --- 【解決跑版問題】：設定 Word 橫向版面 (Landscape) --- */
                @page Section1 {
                    size: 841.9pt 595.3pt; /* A4 橫向尺寸 */
                    mso-page-orientation: landscape;
                    margin: 1.0in 1.0in 1.0in 1.0in; /* 邊界設定 */
                }
                div.Section1 { page: Section1; }
                
                /* --- 防跑版的表格 CSS 樣式 --- */
                table {
                    width: 100%;
                    border-collapse: collapse;
                    table-layout: fixed; /* 讓每個座位的欄寬均分，不會被字數撐破 */
                    font-family: "Microsoft JhengHei", "微軟正黑體", sans-serif;
                }
                td {
                    border: 1px solid #333;
                    padding: 8px;
                    text-align: center;
                    vertical-align: middle;
                    word-wrap: break-word;
                    height: 50px;
                    font-size: 14pt; /* 調整為適合列印的大小 */
                }
                /* 走道或不坐人的位子樣式 */
                .blocked { 
                    background-color: #f4f6f7; 
                    border: 1px dashed #ccc;
                } 
            </style>
        </head>
        <body>
            <div class="Section1">
                <h2 style="text-align: center; font-family: '微軟正黑體';">班級座位表 (老師視角)</h2>
    `;

    // 2. 建立表格內容
    let tableHtml = `<table>`;
    
    // --- 【解決老師視角問題】：反向迴圈 (從最後一排印到第一排) ---
    for (let r = classSettings.totalRows; r >= 1; r--) {
        tableHtml += `<tr>`;
        for (let c = 1; c <= classSettings.totalCols; c++) {
            
            // 檢查該座位是否為不坐人的位子(走道)
            if (isBlockedSeat(r, c)) {
                tableHtml += `<td class="blocked"></td>`;
            } else {
                // 尋找這個位子上有沒有學生
                const student = studentsData.find(s => s.seat && s.seat.row === r && s.seat.col === c);
                if (student) {
                    tableHtml += `<td>${student.name}</td>`;
                } else {
                    tableHtml += `<td><span style="color: #999;">(空位)</span></td>`;
                }
            }
        }
        tableHtml += `</tr>`;
    }
    tableHtml += `</table>`;

    // 3. 在最下方加上「講台」示意圖，讓方向感更明確
    tableHtml += `
        <div style="text-align: center; margin-top: 30px;">
            <div style="display: inline-block; width: 150px; padding: 10px; border: 2px solid #000; background-color: #eee; font-weight: bold; font-family: '微軟正黑體';">
                講 台
            </div>
        </div>
    `;

    const footer = `</div></body></html>`;
    
    // 4. 組裝完整 HTML 並觸發下載機制
    const fullHtml = header + tableHtml + footer;
    
    // 使用 Blob 產生檔案 (加入 \ufeff 是為了確保 UTF-8 中文不亂碼)
    const blob = new Blob(['\ufeff', fullHtml], { type: 'application/msword' });
    const url = URL.createObjectURL(blob);
    
    // 動態建立 <a> 標籤來觸發下載
    const link = document.createElement('a');
    link.href = url;
    link.download = '班級座位表_老師視角.doc';
    document.body.appendChild(link);
    link.click();
    
    // 清理資源
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
};

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

        // 依填答狀況分析並自動套用建議模式
        renderModeRecommendation(true);

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

                // 學生端隱藏模式推薦卡片（該功能僅供管理員操作使用）
                const recommendBanner = document.getElementById('mode-recommendation');
                if (recommendBanner) {
                    recommendBanner.classList.add('hidden');
                }

                // 繪製座位表 (此時為唯讀模式，不能拖曳)
                drawSeatMap();
            }
        }
    });
}

// --- 初始化：設定所有拖曳式權重滑桿與自動加入邏輯 ---
document.addEventListener('DOMContentLoaded', () => {
    initConditionDragAndDrop();
    updateReorderButtonsState();

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

/** 更新每個條件區塊的上/下移按鈕啟用狀態 (第一個禁用上移，最後一個禁用下移) */
function updateReorderButtonsState() {
    const groups = document.querySelectorAll('#condition-list .condition-group');
    groups.forEach((group, index) => {
        const buttons = group.querySelectorAll('.reorder-btn');
        const upBtn = buttons[0];
        const downBtn = buttons[1];
        if (upBtn) upBtn.disabled = (index === 0);
        if (downBtn) downBtn.disabled = (index === groups.length - 1);
    });
}

/** 手機版：將條件區塊往上移一位 */
window.moveConditionUp = function(btn) {
    const group = btn.closest('.condition-group');
    const prev = group.previousElementSibling;
    if (prev) {
        group.parentNode.insertBefore(group, prev);
        updateReorderButtonsState();
    }
}

/** 手機版：將條件區塊往下移一位 */
window.moveConditionDown = function(btn) {
    const group = btn.closest('.condition-group');
    const next = group.nextElementSibling;
    if (next) {
        group.parentNode.insertBefore(next, group);
        updateReorderButtonsState();
    }
}

/** 初始化偏好條件的拖曳排序功能 */
function initConditionDragAndDrop() {
    const list = document.getElementById('condition-list');
    if (!list) return;

    let draggedItem = null;

    list.addEventListener('dragstart', (e) => {
        const target = e.target.closest('.condition-group');
        if (!target) return;
        draggedItem = target;
        // 使用 setTimeout 讓原本的元素在畫面上保持原樣，只有分身跟著游標走
        setTimeout(() => target.classList.add('dragging'), 0);
    });

    list.addEventListener('dragend', (e) => {
        const target = e.target.closest('.condition-group');
        if (!target) return;
        target.classList.remove('dragging');
        draggedItem = null;
        // 清除所有提示線
        document.querySelectorAll('.condition-group').forEach(el => el.classList.remove('drag-over'));
    });

    list.addEventListener('dragover', (e) => {
        e.preventDefault(); // 必須阻止預設行為才能允許放置 (Drop)
        const target = e.target.closest('.condition-group');
        if (target && target !== draggedItem) {
            target.classList.add('drag-over');
        }
    });

    list.addEventListener('dragleave', (e) => {
        const target = e.target.closest('.condition-group');
        if (target && target !== draggedItem) {
            target.classList.remove('drag-over');
        }
    });

    list.addEventListener('drop', (e) => {
        e.preventDefault();
        const target = e.target.closest('.condition-group');
        if (target && target !== draggedItem) {
            target.classList.remove('drag-over');
            
            // 判斷游標位置，決定要安插在目標元素的「上方」還是「下方」
            const rect = target.getBoundingClientRect();
            const insertAfter = (e.clientY - rect.top) / (rect.bottom - rect.top) > 0.5;
            
            if (insertAfter) {
                list.insertBefore(draggedItem, target.nextSibling);
            } else {
                list.insertBefore(draggedItem, target);
            }
            updateReorderButtonsState();
        }
    });
}

/** 
 * 優化後的核心座位分配演算法 (導入模擬退火與空位交換池)
 * 依照設定的模式 (平衡/最大滿意度/公平) 進行最佳化運算
 * [修正版]：調整溫度數值尺度與動態冷卻率，解決演算法過早退化的問題
 */
/** 標準 Fisher-Yates 洗牌，取代原本統計上有偏差的 sort(()=>Math.random()-0.5) */
function shuffleArray(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

window.distributeSeats = function() {
    // 1. 取得所有可用的空座位
    const availableSeats = [];
    for (let r = 1; r <= classSettings.totalRows; r++) {
        for (let c = 1; c <= classSettings.totalCols; c++) {
            if (!isBlockedSeat(r, c)) {
                availableSeats.push({ row: r, col: c });
            }
        }
    }

    // 確保可用座位足夠
    if (availableSeats.length < studentsData.length) {
        alert("錯誤：可用座位數量少於學生人數！");
        return;
    }

    // 2. 初始隨機分配 (將座位打亂後依序發給學生)
    shuffleArray(availableSeats);
    
    studentsData.forEach((student, index) => {
        student.seat = { ...availableSeats[index] };
    });

    // 3. 最佳化演算：模擬退火演算法 (Simulated Annealing)
    let currentScore = evaluateSystem(studentsData);
    
    // --- 【更正】模擬退火參數設定與動態冷卻 ---
    const iterations = 50000;       // 縮減迭代次數，節省 50% 無效運算
    let temperature = 500.0;        // 提高初始溫度至 500，以對應單項權重乘以 50 倍的分數尺度
    const minTemperature = 1.0;     // 終止時的最低溫度目標

    // 動態計算冷卻率，確保在第 10000 次迴圈時，溫度正好降到 1.0 (全程維持退火探索能力)
    const coolingRate = Math.pow(minTemperature / temperature, 1 / iterations);

    for (let i = 0; i < iterations; i++) {
        // 隨機挑選一位學生
        const idx = Math.floor(Math.random() * studentsData.length);
        const student1 = studentsData[idx];

        // 隨機挑選一個可用座位 (包含空位與已被坐的位子)
        const targetSeat = availableSeats[Math.floor(Math.random() * availableSeats.length)];

        // 檢查目標座位上目前有沒有坐人
        const student2 = studentsData.find(s => s.seat && s.seat.row === targetSeat.row && s.seat.col === targetSeat.col);

        // 如果挑到同一個人坐的位子，直接跳過不處理
        if (student2 === student1) continue;

        // 記錄原本的位置以便可能需要的還原 (Undo)
        const oldSeat1 = student1.seat;

        // 執行座位移動/交換
        if (student2) {
            // 目標座位有人：兩人交換座位
            student1.seat = student2.seat;
            student2.seat = oldSeat1;
        } else {
            // 目標座位是空位：學生直接移至該新座位
            student1.seat = { ...targetSeat };
        }

        // 重新評估分數
        const newScore = evaluateSystem(studentsData);
        const deltaScore = newScore - currentScore;

        // 判定是否接受本次變更
        // 1. 如果新分數比較高或平手 (deltaScore >= 0)，100% 接受
        // 2. 如果新分數變低了，根據目前溫度計算機率，有機率地接受
        if (deltaScore >= 0 || Math.random() < Math.exp(deltaScore / temperature)) {
            currentScore = newScore; // 接受變更，更新目前總分
        } else {
            // 拒絕變更，將座位還原 (Undo)
            if (student2) {
                student2.seat = student1.seat;
                student1.seat = oldSeat1;
            } else {
                student1.seat = oldSeat1;
            }
        }

        // 溫度隨時間動態冷卻
        temperature *= coolingRate;
    }

    // 4. 運算完成，把結果畫到畫面上
    drawSeatMap();

    // 5. 如果是線上模式的管理員，同步最新座位表到 Firebase
    if (isOnlineMode && isAdmin) {
        saveSeatsToCloud();
    }
}; 