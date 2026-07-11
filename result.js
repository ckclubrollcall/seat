/**
 * result.js — 座位分配結果頁邏輯
 * 包含：模擬退火演算法、拖曳交換座位、智慧推薦演算法模式、匯出 DOC
 */
import { loadState, saveState, showModal, showError, navigateTo, initFirebase } from './shared.js';

/* ── 全域狀態 ── */
let state = null;
let classSettings = null;
let studentsData = [];
let draggedStudentId = null;
let isOnlineMode = false;
let isAdmin = false;

const ALGO_MODE_LABELS = {
    balanced: '平衡模式',
    max_score: '最大滿意',
    fairness: '公平優先'
};

/* =========================================================
   初始化
   ========================================================= */

document.addEventListener('DOMContentLoaded', async () => {
    state = loadState();

    if (!state.classSettings || !state.classSettings.allStudentIds.length) {
        navigateTo('index.html');
        return;
    }

    classSettings = state.classSettings;
    studentsData = state.studentsData || [];
    isOnlineMode = state.isOnlineMode || false;
    isAdmin = state.isAdmin || false;

    // 學生端（線上 join）：隱藏重新分配按鈕與推薦卡片
    if (isOnlineMode && !isAdmin) {
        const btn = document.getElementById('redistribute-btn');
        if (btn) btn.style.display = 'none';
        const banner = document.getElementById('mode-recommendation');
        if (banner) banner.classList.add('hidden');
    }

    // 分析並推薦演算法模式，然後執行首次分配
    renderModeRecommendation(true);
    distributeSeats();
});

/* =========================================================
   座位判斷工具
   ========================================================= */

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

/* =========================================================
   滿意度計算
   ========================================================= */

function calculateStudentSatisfaction(student, seatPosition = null, allStudents = studentsData) {
    const seat = seatPosition || student.seat;
    if (!seat) return { frontBack: 0, leftRight: 0, friends: 0, total: 0 };

    const pref = student.preferences;
    let fbScore = 0, lrScore = 0, frScore = 0;

    // 前後方位（連續計分）
    if (pref.frontBack.value && pref.frontBack.value !== '不限' && classSettings.totalRows > 1) {
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
        fbScore = ratio * pref.frontBack.weight * 50;
    }

    // 左右方位（連續計分）
    if (pref.leftRightCenter.value && pref.leftRightCenter.value !== '不限' && classSettings.totalCols > 1) {
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
        lrScore = ratio * pref.leftRightCenter.weight * 50;
    }

    // 好友距離
    pref.wantToSitWith.forEach(p => {
        const partner = allStudents.find(s => s.studentId === p.id);
        if (partner && partner.seat) {
            const rowDiff = Math.abs(seat.row - partner.seat.row);
            const colDiff = Math.abs(seat.col - partner.seat.col);
            const dist = Math.max(rowDiff, colDiff);
            const ratio = Math.max(0, 1 - (dist - 1) * 0.25);
            frScore += ratio * p.weight * 50;
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

/* =========================================================
   模擬退火演算法 (Simulated Annealing)
   ========================================================= */

/** Fisher-Yates 洗牌 */
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

        const oldSeat1 = student1.seat;
        if (student2) {
            student1.seat = student2.seat;
            student2.seat = oldSeat1;
        } else {
            student1.seat = { ...targetSeat };
        }

        const newScore = evaluateSystem(studentsData);
        const deltaScore = newScore - currentScore;

        if (deltaScore >= 0 || Math.random() < Math.exp(deltaScore / temperature)) {
            currentScore = newScore;
        } else {
            if (student2) { student2.seat = student1.seat; student1.seat = oldSeat1; }
            else { student1.seat = oldSeat1; }
        }

        temperature *= coolingRate;
    }

    drawSeatMap();

    // 更新 state 並同步雲端
    saveState({ studentsData });
    if (isOnlineMode && isAdmin) saveSeatsToCloud();
};

/* =========================================================
   繪製座位表 + 拖曳
   ========================================================= */

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
    if (!targetSeatDiv || !draggedStudentId) return;
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

/* =========================================================
   雲端同步
   ========================================================= */

async function saveSeatsToCloud() {
    if (!isOnlineMode || !isAdmin || !state.currentRoomCode) return;
    try {
        const { doc, setDoc } = await import("https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js");
        const db = await initFirebase();
        await setDoc(doc(db, "rooms", state.currentRoomCode), {
            status: 'generated',
            seats: studentsData
        }, { merge: true });
    } catch (err) {
        console.error('同步座位到雲端失敗:', err);
    }
}

/* =========================================================
   智慧推薦演算法模式
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

    document.getElementById('recommend-mode-label').textContent = ALGO_MODE_LABELS[result.mode];
    document.getElementById('recommend-mode-reason').textContent = result.reason;
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
   匯出 DOC 檔案（老師視角，第一排在下方）
   ========================================================= */

window.downloadDoc = function() {
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
                    height: 50px;
                    font-size: 14pt;
                }
                .blocked { background-color: #f4f6f7; border: 1px dashed #ccc; }
            </style>
        </head>
        <body>
            <div class="Section1">
                <h2 style="text-align: center; font-family: '微軟正黑體';">班級座位表 (老師視角)</h2>
    `;

    let tableHtml = `<table>`;
    // 從最後一排印到第一排（老師視角）
    for (let r = classSettings.totalRows; r >= 1; r--) {
        tableHtml += `<tr>`;
        for (let c = 1; c <= classSettings.totalCols; c++) {
            if (isBlockedSeat(r, c)) {
                tableHtml += `<td class="blocked"></td>`;
            } else {
                const student = studentsData.find(s => s.seat && s.seat.row === r && s.seat.col === c);
                if (student) {
                    tableHtml += `<td>${student.studentName || `${student.studentId}號`}</td>`;
                } else {
                    tableHtml += `<td><span style="color: #999;">(空位)</span></td>`;
                }
            }
        }
        tableHtml += `</tr>`;
    }
    tableHtml += `</table>`;

    tableHtml += `
        <div style="text-align: center; margin-top: 30px;">
            <div style="display: inline-block; width: 150px; padding: 10px; border: 2px solid #000; background-color: #eee; font-weight: bold; font-family: '微軟正黑體';">
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
    link.download = '班級座位表_老師視角.doc';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
};
