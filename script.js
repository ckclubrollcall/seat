// 全域變數來存儲設定和學生數據
let classSettings = {
    className: '',      // 班級名稱
    totalRows: 0,       // 總排數 (前後)
    totalCols: 0,       // 總列數 (左右)
    minStudentId: 0,    // 最小號碼
    maxStudentId: 0,    // 最大號碼
    excludedIds: new Set(), // 排除的號碼 Set
    allStudentIds: []   // 實際需要分配座位的學生號碼列表
};

let studentsData = []; // 存儲每個學生的詳細偏好資料

// 用於追蹤當前正在輸入的學生 (僅用於顯示進度)
let currentStudentIndex = 0;

/** 顯示錯誤訊息 */
function displayError(message) {
    const errorDiv = document.getElementById('error-message');
    errorDiv.textContent = message;
    errorDiv.style.display = 'block';
    setTimeout(() => {
        errorDiv.style.display = 'none'; // 3 秒後自動隱藏
    }, 3000);
}

function startStudentInput() {
    // 1. 讀取輸入值
    const className = document.getElementById('class-name').value.trim();
    const rows = parseInt(document.getElementById('rows').value);
    const cols = parseInt(document.getElementById('cols').value);
    const minId = parseInt(document.getElementById('min-id').value);
    const maxId = parseInt(document.getElementById('max-id').value);
    const excludedText = document.getElementById('excluded-ids').value;

    // 2. 基礎驗證
    if (!className) {
        return displayError("請輸入有效的班級名稱。");
    }
    if (isNaN(rows) || rows <= 0 || isNaN(cols) || cols <= 0) {
        return displayError("請輸入有效的排數和列數 (須為大於 0 的數字)。");
    }
    if (isNaN(minId) || isNaN(maxId) || minId <= 0 || maxId < minId) {
        return displayError("請輸入有效的學生號碼範圍 (最小號碼須大於 0 且小於最大號碼)。");
    }

    // 3. 處理排除號碼
    let excludedIds = new Set();
    if (excludedText) {
        excludedText.split(',').forEach(id => {
            const num = parseInt(id.trim());
            if (!isNaN(num) && num >= minId && num <= maxId) {
                excludedIds.add(num);
            }
        });
    }

    // 4. 生成實際學生列表
    const allStudentIds = [];
    for (let i = minId; i <= maxId; i++) {
        if (!excludedIds.has(i)) {
            allStudentIds.push(i);
        }
    }

    if (allStudentIds.length === 0) {
        return displayError("錯誤: 根據您的設定，沒有任何學生需要分配座位。");
    }
    if (allStudentIds.length > rows * cols) {
        return displayError(`錯誤: 學生人數 (${allStudentIds.length} 人) 超過座位總數 (${rows * cols} 個)。`);
    }

    // 5. 存儲設定
    classSettings = {
        className: className,
        totalRows: rows,
        totalCols: cols,
        minStudentId: minId,
        maxStudentId: maxId,
        excludedIds: excludedIds,
        allStudentIds: allStudentIds
    };

    // 6. 初始化狀態並切換頁面
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
    const currentStatusElement = document.getElementById('current-student-status');
    currentStatusElement.textContent = `${Math.min(currentStudentIndex + 1, totalStudents)} / ${totalStudents}`;
}

function submitStudentPreferences() {
    const studentId = parseInt(document.getElementById('student-id').value);
    const studentName = document.getElementById('student-name').value.trim();
    
    // --- 1. 學生 ID 驗證 ---
    if (isNaN(studentId) || studentId <= 0) {
        return displayError("請輸入有效的學生號碼。");
    }
    if (!classSettings.allStudentIds.includes(studentId)) {
        return displayError("輸入錯誤: 此號碼不是該班級的有效學號，或已被排除。");
    }
    const isAlreadyEntered = studentsData.some(student => student.studentId === studentId);
    if (isAlreadyEntered) {
        return displayError("輸入錯誤: 此號碼的學生資料已經輸入完成。");
    }
    
    // --- 2. 條件與權重驗證 ---
    const preferences = [
        { id: 'pref-1-id', w: 'pref-1-w', type: 'id', name: '想跟誰坐(1)' },
        { id: 'pref-2-id', w: 'pref-2-w', type: 'id', name: '想跟誰坐(2)' },
        { id: 'pref-5-val', w: 'pref-5-w', type: 'select', name: '前後偏好' },
        { id: 'pref-6-val', w: 'pref-6-w', type: 'select', name: '左右偏好' }
    ];

    const enteredWeights = new Set();
    const studentPreferences = { wantToSitWith: [], frontBack: {}, leftRightCenter: {} };

    for (const pref of preferences) {
        const val = document.getElementById(pref.id).value;
        const weightStr = document.getElementById(pref.w).value;
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
            if (enteredWeights.has(weight)) {
                return displayError(`輸入錯誤: 權重 ${weight} 被重複使用，請確保每個權重都是唯一的。`);
            }
            enteredWeights.add(weight);

            // 收集數據
            if (pref.type === 'id') {
                const partnerId = parseInt(val);
                if (classSettings.allStudentIds.includes(partnerId)) {
                     studentPreferences.wantToSitWith.push({ id: partnerId, weight: weight });
                }
            } else if (pref.name === '前後偏好') {
                studentPreferences.frontBack = { value: val, weight: weight };
            } else if (pref.name === '左右偏好') {
                studentPreferences.leftRightCenter = { value: val, weight: weight };
            }
        }
    }

    // --- 3. 收集偏好數據 (如果沒有輸入，則給予預設值) ---
    const newStudentData = {
        studentId: studentId,
        studentName: studentName || '', // 姓名可選
        preferences: {
            wantToSitWith: studentPreferences.wantToSitWith,
            frontBack: studentPreferences.frontBack.value ? studentPreferences.frontBack : { value: '不限', weight: 0 },
            leftRightCenter: studentPreferences.leftRightCenter.value ? studentPreferences.leftRightCenter : { value: '不限', weight: 0 }
        },
        seat: null
    };

    // --- 4. 存儲數據並推進流程 ---
    studentsData.push(newStudentData);
    studentsData.sort((a, b) => a.studentId - b.studentId);
    
    resetStudentForm();
    
    currentStudentIndex++;
    updateStudentStatus();
        
    if (currentStudentIndex < classSettings.allStudentIds.length) {
        document.getElementById('student-id').value = classSettings.allStudentIds[currentStudentIndex];
    } else {
        document.getElementById('student-id').value = ''; 
    }

    // --- 5. 檢查是否全部完成 ---
    if (studentsData.length === classSettings.allStudentIds.length) {
        alert("所有學生資料已輸入完畢！即將進入座位分配。");
        document.getElementById('input-page').classList.add('hidden');
        document.getElementById('result-page').classList.remove('hidden');
        distributeSeats(); 
    }
}

/** 重設學生輸入表單 */
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

function distributeSeats() {
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

    // 3. 依總權重排序學生
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

    // 5. 第二階段優化
    const NUM_ITERATIONS = 1000;
    for (let i = 0; i < NUM_ITERATIONS; i++) {
        const indexA = Math.floor(Math.random() * studentsData.length);
        let indexB = Math.floor(Math.random() * studentsData.length);
        if (indexA === indexB) continue;

        const studentA = studentsData[indexA];
        const studentB = studentsData[indexB];
        if (!studentA.seat || !studentB.seat) continue;

        const originalScore = calculateTotalSatisfaction();
        const seatA = studentA.seat;
        const seatB = studentB.seat;
        studentA.seat = seatB;
        studentB.seat = seatA;
        const newScore = calculateTotalSatisfaction();
        
        if (newScore <= originalScore) {
            studentA.seat = seatA; // 換回來
            studentB.seat = seatB;
        }
    }
    
    drawSeatMap();
}

/** 繪製座位表 (包含拖曳功能) */
function drawSeatMap() {
    const container = document.getElementById('seat-map-container');
    container.innerHTML = '';
    container.style.display = 'grid';
    container.style.gridTemplateColumns = `repeat(${classSettings.totalCols}, 1fr)`;

    for (let r = 1; r <= classSettings.totalRows; r++) {
        for (let c = 1; c <= classSettings.totalCols; c++) {
            const seatDiv = document.createElement('div');
            seatDiv.className = 'seat-box';
            
            const student = studentsData.find(s => s.seat && s.seat.row === r && s.seat.col === c);
            
            if (student) {
                seatDiv.innerHTML = student.studentName ? `${student.studentId}<br>${student.studentName}` : student.studentId;
                seatDiv.title = `排: ${r}, 列: ${c}\n學生: ${student.studentId} 號` + (student.studentName ? ` - ${student.studentName}` : '');
                seatDiv.classList.add('occupied');
                seatDiv.setAttribute('draggable', true);
                seatDiv.dataset.studentId = student.studentId; // 儲存學生ID
                
                // 拖曳事件監聽
                seatDiv.addEventListener('dragstart', handleDragStart);
                seatDiv.addEventListener('dragend', handleDragEnd);

            } else {
                seatDiv.textContent = `(空位)`;
                seatDiv.classList.add('empty');
            }
            // 所有座位都需要成為放置目標
            seatDiv.addEventListener('dragover', handleDragOver);
            seatDiv.addEventListener('drop', handleDrop);

            container.appendChild(seatDiv);
        }
    }
}

// --- 拖曳事件處理函數 ---
let draggedStudentId = null;

function handleDragStart(e) {
    draggedStudentId = parseInt(e.target.dataset.studentId);
    e.target.style.opacity = '0.5';
}

function handleDragOver(e) {
    e.preventDefault(); // 必須阻止預設行為才能觸發 drop
}

function handleDragEnd(e) {
    e.target.style.opacity = '1';
    draggedStudentId = null;
}

function handleDrop(e) {
    e.preventDefault();
    const targetSeatDiv = e.target.closest('.seat-box.occupied');
    
    if (!targetSeatDiv || !draggedStudentId) return;

    const targetStudentId = parseInt(targetSeatDiv.dataset.studentId);
    if (draggedStudentId === targetStudentId) return;

    const draggedStudent = studentsData.find(s => s.studentId === draggedStudentId);
    const targetStudent = studentsData.find(s => s.studentId === targetStudentId);

    if (draggedStudent && targetStudent) {
        const tempSeat = draggedStudent.seat;
        draggedStudent.seat = targetStudent.seat;
        targetStudent.seat = tempSeat;
        
        drawSeatMap();
    }
}


/** 計算單一學生在某座位的分數 */
function calculateScore(studentData, seatPosition) {
    let score = 0;
    const pref = studentData.preferences;
    
    // 區域偏好
    const frontBackPref = pref.frontBack;
    if (frontBackPref.value !== '不限') {
        if (getFrontBackZone(seatPosition.row) === frontBackPref.value) score += frontBackPref.weight * 10;
        else score -= frontBackPref.weight * 5;
    }

    const leftRightPref = pref.leftRightCenter;
    if (leftRightPref.value !== '不限') {
        if (getLeftRightCenterZone(seatPosition.col) === leftRightPref.value) score += leftRightPref.weight * 10;
        else score -= leftRightPref.weight * 5;
    }

    // "想跟誰坐" 的基礎分數
    pref.wantToSitWith.forEach(p => {
        score += p.weight; 
    });

    return score;
}

/** 判斷座位是否緊鄰 */
function isAdjacent(seatA, seatB) {
    if (!seatA || !seatB) return false;
    const rowDiff = Math.abs(seatA.row - seatB.row);
    const colDiff = Math.abs(seatA.col - seatB.col);
    return (rowDiff <= 1 && colDiff <= 1) && (rowDiff !== 0 || colDiff !== 0);
}

/** 計算總滿意度 */
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


/** 下載為 DOC 檔案 */
function downloadDoc() {
    // 1. 建立 HTML 內容字串
    let content = `
        <html>
        <head>
            <meta charset="UTF-8">
            <style>
                body { font-family: 'Arial', sans-serif; }
                h1 { text-align: center; }
                table { border-collapse: collapse; width: 100%; margin: 20px auto; }
                td { border: 1px solid black; padding: 8px; text-align: center; height: 60px; }
            </style>
        </head>
        <body>
            <h1>${classSettings.className} 座位表</h1>
            <table>`;

    // 2. 填充表格內容
    for (let r = 1; r <= classSettings.totalRows; r++) {
        content += '<tr>';
        for (let c = 1; c <= classSettings.totalCols; c++) {
            const student = studentsData.find(s => s.seat && s.seat.row === r && s.seat.col === c);
            if (student) {
                const studentInfo = student.studentName ? `${student.studentId}<br>${student.studentName}` : student.studentId;
                content += `<td>${studentInfo}</td>`;
            } else {
                content += '<td>(空位)</td>';
            }
        }
        content += '</tr>';
    }

    content += `
            </table>
        </body>
        </html>`;

    // 3. 建立 Blob 並觸發下載
    const blob = new Blob([content], { type: 'application/msword;charset=utf-8' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `${classSettings.className}_座位表.doc`;
    
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}