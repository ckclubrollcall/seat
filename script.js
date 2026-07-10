let isOnlineMode = false; // 標記目前是否為線上模式
let isAdmin = false;       // 標記是否為管理員
let currentRoomCode = '';  // 儲存目前的房間代碼
let unsubscribeSnapshot = null; // 用來取消監聽資料庫
let draggedStudentId = null;   // 記錄目前拖曳的學生座號

// 導入 Firebase Firestore 功能
import { doc, setDoc, getDoc, collection, onSnapshot } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

// 全域變數來存儲設定和學生數據
let classSettings = {
    className: '',      // 班級名稱
    totalRows: 0,       // 總排數 (前後)
    totalCols: 0,       // 總列數 (左右)
    minStudentId: 0,    // 最小號碼
    maxStudentId: 0,    // 最大號碼
    excludedIds: [],    // 排除的號碼列表 (雲端使用陣列)
    allStudentIds: []   // 實際需要分配座位的學生號碼列表
};

let studentsData = []; // 存儲每個學生的詳細偏好與座位資料
let currentStudentIndex = 0; // 用於追蹤下一個要預填的學生 index (線下模式)

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

/** 線下模式初始化 */
window.startStudentInput = function() {
    const className = document.getElementById('class-name').value.trim();
    const rows = parseInt(document.getElementById('rows').value);
    const cols = parseInt(document.getElementById('cols').value);
    const minId = parseInt(document.getElementById('min-id').value);
    const maxId = parseInt(document.getElementById('max-id').value);
    const excludedText = document.getElementById('excluded-ids').value;

    // 基礎驗證
    if (!className) {
        return displayError("請輸入有效的班級名稱。");
    }
    if (isNaN(rows) || rows <= 0 || isNaN(cols) || cols <= 0) {
        return displayError("請輸入有效的排數和列數 (須為大於 0 的數字)。");
    }
    if (isNaN(minId) || isNaN(maxId) || minId <= 0 || maxId < minId) {
        return displayError("請輸入有效的學生號碼範圍 (最小號碼須大於 0 且小於最大號碼)。");
    }

    // 處理排除號碼
    const excludedIds = [];
    if (excludedText) {
        excludedText.split(',').forEach(id => {
            const num = parseInt(id.trim());
            if (!isNaN(num) && num >= minId && num <= maxId) {
                excludedIds.push(num);
            }
        });
    }

    // 生成實際學生列表
    const allStudentIds = [];
    for (let i = minId; i <= maxId; i++) {
        if (!excludedIds.includes(i)) {
            allStudentIds.push(i);
        }
    }

    if (allStudentIds.length === 0) {
        return displayError("錯誤: 根據您的設定，沒有任何學生需要分配座位。");
    }
    if (allStudentIds.length > rows * cols) {
        return displayError(`錯誤: 學生人數 (${allStudentIds.length} 人) 超過座位總數 (${rows * cols} 個)。`);
    }

    // 存儲設定
    classSettings = {
        className: className,
        totalRows: rows,
        totalCols: cols,
        minStudentId: minId,
        maxStudentId: maxId,
        excludedIds: excludedIds,
        allStudentIds: allStudentIds
    };

    isOnlineMode = false;
    isAdmin = false;
    studentsData = [];

    // 初始化狀態並切換頁面
    currentStudentIndex = 0;
    updateStudentStatus();
    
    document.getElementById('setup-page').classList.add('hidden');
    document.getElementById('input-page').classList.remove('hidden');
    
    document.getElementById('student-id').value = classSettings.allStudentIds[0];
    document.getElementById('student-name').value = '';
}

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
        return displayError("請輸入有效的學生號碼。");
    }
    if (!classSettings.allStudentIds.includes(studentId)) {
        return displayError("輸入錯誤: 此號碼不是該班級的有效學號，或已被排除。");
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
        const weightStr = document.getElementById(pref.w).value.trim();
        const weight = parseInt(weightStr);

        const hasValue = (pref.type === 'id') ? !!val : (val !== '不限');
        const hasWeight = !!weightStr;

        if (hasValue && !hasWeight) {
            return displayError(`輸入錯誤: 您設定了「${pref.name}」條件，但未輸入其權重。`);
        }
        if (!hasValue && hasWeight) {
            return displayError(`輸入錯誤: 您輸入了「${pref.name}」的權重，但未設定條件。`);
        }

        if (hasValue && hasWeight) {
            if (isNaN(weight) || weight < 1 || weight > 4) {
                return displayError(`輸入錯誤: 「${pref.name}」的權重必須是 1 到 4 的數字。`);
            }

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
                    return displayError(`輸入錯誤: 座號 ${partnerId} 不是班上的有效號碼，或已被排除。`);
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
                    "<h3 style='color: var(--accent-green); margin-bottom: 10px;'>✓ 感謝您的填寫！</h3>" +
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
        document.getElementById('input-page').classList.add('hidden');
        document.getElementById('result-page').classList.remove('hidden');
        distributeSeats(); 
    }
}

/** 重置學生輸入表單 */
function resetStudentForm() {
    const preferenceInputs = document.querySelectorAll('#student-form-container input, #student-form-container select');
    preferenceInputs.forEach(input => {
        if (input.id !== 'student-id') {
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

/** 獲取所有目前空置的座位座標 */
function getEmptySeats() {
    const occupied = new Set(studentsData.filter(s => s.seat).map(s => `${s.seat.row},${s.seat.col}`));
    const empty = [];
    for (let r = 1; r <= classSettings.totalRows; r++) {
        for (let c = 1; c <= classSettings.totalCols; c++) {
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

    // 2. 初始化可用座位
    let availableSeats = [];
    for (let r = 1; r <= classSettings.totalRows; r++) {
        for (let c = 1; c <= classSettings.totalCols; c++) {
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
    e.preventDefault(); // 必須阻止預設行為才能觸發 drop
    const box = e.target.closest('.seat-box');
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
                body { font-family: 'Arial', sans-serif; background-color: #f6f5f2; color: #3d4043; padding: 20px; }
                h1 { text-align: center; color: #3d4043; margin-bottom: 5px; }
                .subtitle { text-align: center; color: #7e8285; font-size: 14px; margin-bottom: 20px; }
                .podium-bar { width: 200px; height: 30px; background-color: #d8d6ce; border-radius: 15px; margin: 10px auto 25px auto; text-align: center; line-height: 30px; font-weight: bold; color: #6a6c6e; font-size: 12px; }
                table { border-collapse: separate; border-spacing: 10px; width: 100%; max-width: 800px; margin: 0 auto; }
                td { 
                    border: 1px solid #e2e1dc; 
                    background-color: #ffffff; 
                    padding: 12px; 
                    text-align: center; 
                    height: 70px; 
                    width: ${100 / classSettings.totalCols}%;
                    border-radius: 8px;
                    font-size: 14px;
                }
                .occupied { background-color: #edf2f7; border-color: #8da1b9; }
                .student-id { font-size: 10px; color: #7e8285; margin-bottom: 4px; }
                .student-name { font-weight: bold; font-size: 14px; color: #3d4043; }
                .empty { border-style: dashed; background-color: #faf9f6; color: #7e8285; }
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

// --- 線上模式：管理員建立房間 ---
window.createOnlineRoom = async function() {
    const className = document.getElementById('class-name').value.trim();
    const rows = parseInt(document.getElementById('rows').value);
    const cols = parseInt(document.getElementById('cols').value);
    const minId = parseInt(document.getElementById('min-id').value);
    const maxId = parseInt(document.getElementById('max-id').value);
    const excludedText = document.getElementById('excluded-ids').value;

    // 基本驗證
    if (!className) return displayError("請輸入有效的班級名稱。");
    if (isNaN(rows) || rows <= 0 || isNaN(cols) || cols <= 0) return displayError("請輸入有效的排數和列數。");
    if (isNaN(minId) || isNaN(maxId) || minId <= 0 || maxId < minId) {
        return displayError("請輸入有效的學生號碼範圍。");
    }
    
    // 生成隨機 6 碼英數代碼
    currentRoomCode = Math.random().toString(36).substring(2, 8).toUpperCase();
    
    // 整理排除號碼並生成 allStudentIds
    const excludedIdsArray = [];
    if (excludedText) {
        excludedText.split(',').map(id => parseInt(id.trim())).forEach(id => {
            if (!isNaN(id)) excludedIdsArray.push(id);
        });
    }
    const allStudentIds = [];
    for (let i = minId; i <= maxId; i++) {
        if (!excludedIdsArray.includes(i)) allStudentIds.push(i);
    }

    classSettings = {
        className, 
        totalRows: rows, 
        totalCols: cols, 
        minStudentId: minId, 
        maxStudentId: maxId,
        excludedIds: excludedIdsArray,
        allStudentIds
    };

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
        document.getElementById('setup-page').classList.add('hidden');
        document.getElementById('admin-waiting-page').classList.remove('hidden');
        document.getElementById('display-room-code').textContent = currentRoomCode;
        document.getElementById('online-student-status').textContent = `0 / ${allStudentIds.length}`;

        // 3. 即時監聽學生提交的資料
        listenToStudentSubmissions();
    } catch (error) {
        console.error("建立房間失敗:", error);
        displayError("建立房間失敗，請檢查網路連線或 Firebase 金鑰配置。");
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
                <span style="color: var(--accent-green); font-size: 0.8rem; font-weight: 500;">已填寫偏好</span>
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
        
        document.getElementById('admin-waiting-page').classList.add('hidden');
        document.getElementById('result-page').classList.remove('hidden');
        
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
        isOnlineMode = true; 
        isAdmin = false;
        studentsData = [];

        // 切換到學生輸入畫面
        document.getElementById('setup-page').classList.add('hidden');
        document.getElementById('input-page').classList.remove('hidden');

        // 修改進度文字，顯示目前是線上模式
        const statusWrapper = document.getElementById('student-status-wrapper');
        if (statusWrapper) {
            statusWrapper.innerHTML = `線上模式：房間代碼 <b style="color: var(--primary-color);">${roomCode}</b> (班級：${classSettings.className})`;
        }
        
        // 清空輸入框讓學生填寫自己
        document.getElementById('student-id').value = '';
        document.getElementById('student-name').value = '';

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
                
                // 停止監聽以節省資源
                if (unsubscribeSnapshot) {
                    unsubscribeSnapshot();
                    unsubscribeSnapshot = null;
                }
                
                // 學生端自動跳轉至座位表畫面
                document.getElementById('input-page').classList.add('hidden');
                document.getElementById('result-page').classList.remove('hidden');
                
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