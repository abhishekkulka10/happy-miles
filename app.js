// Service Worker Registration
let deferredPrompt;
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(err => console.log('SW registration failed', err));
}

window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    const btn = document.getElementById('pwaInstallBtn');
    if (btn) btn.style.display = 'inline-flex';
});

document.getElementById('pwaInstallBtn').addEventListener('click', () => {
    if (deferredPrompt) {
        deferredPrompt.prompt();
        deferredPrompt.userChoice.then((choiceResult) => {
            if (choiceResult.outcome === 'accepted') {
                document.getElementById('pwaInstallBtn').style.display = 'none';
            }
            deferredPrompt = null;
        });
    }
});

// App State Variables
let activeUserKey   = localStorage.getItem('hm_user') || '';
let allSheets       = [];
let spreadsheetName = 'Happy Miles';
let currentIdx      = 0;
let searchTerm      = '';
let filterVal       = 'all';
let isDark          = false;
let autoTimer       = null;

let currentDutyEvent = null;
let pendingDutyPayload = null;
let pendingChecklistData = null;
let leafletMap = null;

const QUEUE_KEY = 'hm_offline_queue';
const SHIFT_HISTORY_KEY = 'hm_shift_history';
const BREADCRUMB_KEY = 'hm_breadcrumbs';

// DOM Element Handles
const sheetArea    = document.getElementById('sheetArea');
const statusText   = document.getElementById('statusText');
const statusDot    = document.getElementById('statusDot');
const pageTitle    = document.getElementById('pageTitle');
const tabBar       = document.getElementById('tabBar');
const filterBox    = document.getElementById('filterBox');
const searchBox    = document.getElementById('searchBox');
const rowCount     = document.getElementById('rowCount');
const subtotalBar  = document.getElementById('subtotalBar');
const loginOverlay = document.getElementById('loginOverlay');
const loginError   = document.getElementById('loginError');
const dashboardPanel = document.getElementById('dashboardPanel');

document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('banner').textContent = typeof COMPANY_NAME !== 'undefined' ? COMPANY_NAME : 'Happy Miles';
    
    // Auth listeners
    document.getElementById('loginForm').addEventListener('submit', handleLogin);
    document.getElementById('username').addEventListener('input', () => { loginError.style.display = 'none'; });
    document.getElementById('password').addEventListener('input', () => { loginError.style.display = 'none'; });
    document.getElementById('logoutBtn').addEventListener('click', handleLogout);
    
    // UI listeners
    document.getElementById('refreshBtn').addEventListener('click', loadSheet);
    document.getElementById('themeBtn').addEventListener('click', toggleDark);
    searchBox.addEventListener('input', doSearch);
    filterBox.addEventListener('change', doFilter);

    window.addEventListener('online', flushOfflineQueue);

    initApp();
});

function initApp() {
    if (activeUserKey && USER_CONFIG[activeUserKey]) {
        loginOverlay.style.display = 'none';
        dashboardPanel.style.display = 'flex';
        initMap();
        updateDutyUI();
        updateQueueBadge();
        startBreadcrumbTracking();
        loadSheet();
        if (navigator.onLine) flushOfflineQueue();
    } else {
        loginOverlay.style.display = 'flex';
        dashboardPanel.style.display = 'none';
    }
}

function handleLogin(e) {
    e.preventDefault();
    loginError.style.display = 'none';
    const rawUser = document.getElementById('username').value.trim();
    const p = document.getElementById('password').value.trim();
    
    const userKey = Object.keys(USER_CONFIG).find(k => k.toLowerCase() === rawUser.toLowerCase());

    if (userKey && USER_CONFIG[userKey].password === p) {
        activeUserKey = userKey;
        localStorage.setItem('hm_user', userKey);
        loginOverlay.style.display = 'none';
        dashboardPanel.style.display = 'flex';
        initMap();
        updateDutyUI();
        updateQueueBadge();
        loadSheet();
    } else {
        loginError.style.display = 'block';
    }
}

function handleLogout() {
    activeUserKey = '';
    localStorage.removeItem('hm_user');
    allSheets = [];
    if (autoTimer) clearInterval(autoTimer);
    sheetArea.innerHTML = '<div class="loading-screen"><div>Please log in to view data.</div></div>';
    tabBar.innerHTML = '';
    subtotalBar.innerHTML = '';
    rowCount.textContent = '0 rows';
    pageTitle.textContent = 'Happy Miles';
    statusText.textContent = 'Awaiting login...';
    document.getElementById('username').value = '';
    document.getElementById('password').value = '';
    loginError.style.display = 'none';
    loginOverlay.style.display = 'flex';
    dashboardPanel.style.display = 'none';
}

// Map Handler
function initMap() {
    if (!leafletMap && document.getElementById('map')) {
        leafletMap = L.map('map').setView([19.8762, 75.3433], 12);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            maxZoom: 19, attribution: '© OpenStreetMap'
        }).addTo(leafletMap);
    }
}

// Duty & OCR Operations
async function toggleDuty(isChecked) {
    currentDutyEvent = isChecked ? 'ON' : 'OFF';
    if (isChecked) {
        localStorage.setItem('dutyStartTime', Date.now().toString());
        document.getElementById('checklistModal').style.display = 'flex';
    } else {
        document.getElementById('odometerInput').click();
    }
}

function confirmChecklist() {
    const checkboxes = document.querySelectorAll('.chk-item');
    const allPassed = Array.from(checkboxes).every(cb => cb.checked);
    pendingChecklistData = {
        tires: checkboxes[0].checked,
        brakes: checkboxes[1].checked,
        lights: checkboxes[2].checked,
        fluids: checkboxes[3].checked,
        status: allPassed ? 'PASSED' : 'FLAGGED'
    };
    document.getElementById('checklistModal').style.display = 'none';
    document.getElementById('odometerInput').click();
}

async function handleOdometerCapture(event) {
    const file = event.target.files[0];
    if (!file) return cancelOdometerCapture();
    showOCRModal('Scanning location & reading odometer...');
    try {
        const location = await getCurrentGPS();
        updateMapPin(location.latitude, location.longitude, currentDutyEvent);
        const odoResult = await Tesseract.recognize(file, 'eng');
        const extractedNumber = odoResult.data.text.replace(/[^0-9]/g, '');
        const metrics = calculateDutyMetrics(extractedNumber);
        
        pendingDutyPayload = {
            username: activeUserKey,
            spreadsheetId: USER_CONFIG[activeUserKey]?.spreadsheetId,
            dutyEvent: currentDutyEvent,
            latitude: location.latitude,
            longitude: location.longitude,
            checklist: pendingChecklistData,
            totalKM: metrics.totalKM,
            dutyDuration: metrics.durationStr,
            timestamp: new Date().toISOString()
        };
        showVerificationUI(extractedNumber || '');
    } catch (err) {
        alert('OCR Processing Error: ' + err.message);
        cancelOdometerCapture();
    } finally {
        event.target.value = '';
    }
}

async function submitOdometerData() {
    const verifiedOdo = document.getElementById('odometerInputValue').value.trim();
    if (!verifiedOdo) return alert('Please enter a valid odometer reading.');
    pendingDutyPayload.odometerReading = verifiedOdo;

    if (currentDutyEvent === 'ON') {
        localStorage.setItem('odometerStart', verifiedOdo);
        localStorage.setItem('dutyActive', 'true');
        localStorage.setItem('totalBreakDuration', '0');
    } else {
        saveShiftRecord({
            date: new Date().toLocaleDateString(),
            startTime: new Date(parseInt(localStorage.getItem('dutyStartTime'))).toLocaleTimeString(),
            endTime: new Date().toLocaleTimeString(),
            startOdo: localStorage.getItem('odometerStart'),
            endOdo: verifiedOdo,
            totalKM: pendingDutyPayload.totalKM,
            duration: pendingDutyPayload.dutyDuration
        });
        localStorage.setItem('dutyActive', 'false');
        localStorage.removeItem('dutyStartTime');
    }

    if (!navigator.onLine) {
        saveToQueue(pendingDutyPayload);
        showToast('Saved offline to local queue');
    } else {
        try {
            await fetch(SCRIPT_URL, {
                method: 'POST',
                mode: 'no-cors',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(pendingDutyPayload)
            });
            showToast('Duty log saved successfully');
        } catch (e) {
            saveToQueue(pendingDutyPayload);
            showToast('Network issue: queued offline');
        }
    }

    checkMaintenanceAlerts(verifiedOdo);
    updateDutyUI();
    updateQueueBadge();
    hideOCRModal();
}

// Google Sheets Data API Loader
async function loadSheet() {
    if (!activeUserKey || !USER_CONFIG[activeUserKey]) {
        loginOverlay.style.display = 'flex';
        return;
    }

    const SPREADSHEET_ID = USER_CONFIG[activeUserKey].spreadsheetId;
    sheetArea.innerHTML = `<div class="loading-screen"><div class="spinner"></div><div>Fetching spreadsheet...</div></div>`;
    subtotalBar.innerHTML = '';
    statusText.textContent = 'Loading...';
    statusDot.className = 'status-dot';

    try {
        let url;
        if (DATA_RANGE) {
            const range = SHEET_NAME ? `${SHEET_NAME}!${DATA_RANGE}` : DATA_RANGE;
            url = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}?includeGridData=true&ranges=${encodeURIComponent(range)}&key=${API_KEY}`;
        } else {
            url = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}?includeGridData=true&key=${API_KEY}`;
            if (SHEET_NAME) url += `&ranges=${encodeURIComponent(SHEET_NAME)}`;
        }

        const res = await fetch(url);
        const data = await res.json();

        if (!res.ok) throw new Error(data.error && data.error.message ? data.error.message : `HTTP ${res.status}`);
        if (!data.sheets || !data.sheets.length) throw new Error('No sheets found in this spreadsheet.');

        spreadsheetName = data.properties && data.properties.title || 'Happy Miles';
        pageTitle.textContent = spreadsheetName;

        allSheets = data.sheets;
        currentIdx = 0;
        buildTabs();
        renderSheet(0);

        statusText.textContent = `Updated: ${new Date().toLocaleTimeString()}`;
        statusDot.className = 'status-dot';

        if (autoTimer) clearInterval(autoTimer);
        if (AUTO_REFRESH_MS > 0) autoTimer = setInterval(() => loadSheet(), AUTO_REFRESH_MS);

    } catch (err) {
        statusDot.className = 'status-dot error';
        statusText.textContent = 'Error';
        sheetArea.innerHTML = `<div class="error-box"><strong>Failed to load sheet</strong><br><br>${escapeHtml(err.message)}</div>`;
        subtotalBar.innerHTML = '';
        console.error(err);
    }
}

// Table Rendering Engine
function renderSheet(idx) {
    const sheet = allSheets[idx];
    if (!sheet) return;

    const data = sheet.data && sheet.data[0];
    if (!data || !data.rowData) {
        sheetArea.innerHTML = '<div class="error-box">No data found in this sheet.</div>';
        subtotalBar.innerHTML = '';
        return;
    }

    const rows = data.rowData;
    const colMeta = data.columnMetadata || [];
    const rowMeta = data.rowMetadata || [];
    const maxCols = Math.max(...rows.map(r => (r.values||[]).length), colMeta.length);
    const maxRows = rows.length;
    const colWidths = colMeta.map(m => m.pixelSize || 100);
    const rowHeights = rowMeta.map(m => m.pixelSize || 21);
    const mergeCells = sheet.mergeCells || [];
    const { covered, mergeInfo } = processMerges(mergeCells, maxRows, maxCols);

    const hiddenCols = getHiddenCols(colMeta);
    const hiddenRows = getHiddenRows(rowMeta);
    const frozenRows = getFrozenRowCount(sheet);
    const headerRowIdx = Math.min(frozenRows - 1, maxRows - 1);
    const headerCells = rows[headerRowIdx].values || [];
    const header = headerCells.map(c => (c.formattedValue || '').trim());

    populateFilter(sheet, headerRowIdx, hiddenRows);
    const filterCol = getFilterColumnIndex(header);
    const dataStart = headerRowIdx + 1;
    const numericCols = detectNumericColumns(rows, dataStart, maxCols, hiddenRows);

    let visibleRows = [];
    for (let r = dataStart; r < maxRows; r++) {
        if (hiddenRows.includes(r)) continue;
        const row = rows[r] || {};
        const cells = row.values || [];
        const vals = cells.map(c => (c.formattedValue || '').trim());

        if (filterVal !== 'all') {
            const fv = (cells[filterCol] ? (cells[filterCol].formattedValue || '') : '').trim();
            if (fv !== filterVal) continue;
        }

        if (searchTerm) {
            const term = searchTerm.toLowerCase();
            const found = vals.some(v => v.toLowerCase().includes(term));
            if (!found) continue;
        }

        visibleRows.push(r);
    }

    const subtotals = new Array(maxCols).fill(null);
    if (numericCols.length > 0 && visibleRows.length > 0) {
        numericCols.forEach(colIdx => {
            if (hiddenCols.includes(colIdx)) return;
            let sum = 0;
            visibleRows.forEach(r => {
                const cell = rows[r].values && rows[r].values[colIdx];
                sum += parseNumber(cell ? cell.formattedValue : '');
            });
            subtotals[colIdx] = formatNumber(sum);
        });
    }

    let barHtml = '';
    if (numericCols.length > 0 && visibleRows.length > 0) {
        barHtml = `<span class="st-label">Subtotal (${visibleRows.length} rows):</span>`;
        numericCols.forEach(colIdx => {
            if (hiddenCols.includes(colIdx)) return;
            if (subtotals[colIdx] !== null) {
                const label = header[colIdx] || `Col ${colIdx+1}`;
                barHtml += `<span class="st-item"><span class="st-key">${escapeHtml(label)}:</span><span class="st-val">${subtotals[colIdx]}</span></span>`;
            }
        });
    } else {
        barHtml = `<span class="st-label">${visibleRows.length} rows shown</span>`;
    }
    subtotalBar.innerHTML = barHtml;

    let html = '<table class="sheet-table">';
    let stickyOffsets = [0];
    for (let r = 1; r < frozenRows && r < maxRows; r++) {
        stickyOffsets.push(stickyOffsets[r-1] + (rowHeights[r-1] || 21));
    }

    for (let r = 0; r < maxRows; r++) {
        if (r >= frozenRows && hiddenRows.includes(r)) continue;
        if (r >= frozenRows && !visibleRows.includes(r)) continue;

        const row = rows[r] || {};
        const cells = row.values || [];
        const h = rowHeights[r] || 21;
        const isFrozen = r < frozenRows;

        html += `<tr style="height:${h}px">`;

        for (let c = 0; c < maxCols; c++) {
            if (hiddenCols.includes(c)) continue;
            if (covered[r][c]) continue;

            const cell = cells[c] || {};
            const fmt = cell.effectiveFormat;
            const val = cell.formattedValue || '';
            const style = buildCellStyle(fmt);
            const merge = mergeInfo[r][c];

            const attrs = [];
            let inlineStyle = style;
            if (isFrozen) {
                inlineStyle = (inlineStyle ? inlineStyle + ';' : '') + `position:sticky;top:${stickyOffsets[r]}px;z-index:10;`;
            }
            if (inlineStyle) attrs.push(`style="${inlineStyle.replace(/"/g,'&quot;')}"`);
            if (merge) {
                let visibleSpan = 0;
                for (let mc = c; mc < c + merge.colspan && mc < maxCols; mc++) {
                    if (!hiddenCols.includes(mc)) visibleSpan++;
                }
                if (visibleSpan > 1) attrs.push(`colspan="${visibleSpan}"`);
                if (merge.rowspan > 1) attrs.push(`rowspan="${merge.rowspan}"`);
            }
            const w = colWidths[c] || 100;
            attrs.push(`width="${w}"`);

            html += `<td ${attrs.join(' ')}>${escapeHtml(val)}</td>`;
        }
        html += '</tr>';
    }

    html += '</table>';
    sheetArea.innerHTML = html;
    rowCount.textContent = `${visibleRows.length} rows`;
}

// Formatting Helper Functions
function colorToCss(c) {
    if (!c) return null;
    const r = Math.round((c.red || 0) * 255);
    const g = Math.round((c.green || 0) * 255);
    const b = Math.round((c.blue || 0) * 255);
    const a = c.alpha !== undefined ? c.alpha : 1;
    return a === 1 ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${a})`;
}

function buildCellStyle(fmt) {
    if (!fmt) return '';
    const s = [];
    const bg = colorToCss(fmt.backgroundColor);
    if (bg) s.push(`background-color:${bg}`);
    const tf = fmt.textFormat;
    if (tf) {
        if (tf.bold) s.push('font-weight:bold');
        if (tf.italic) s.push('font-style:italic');
        if (tf.fontSize) s.push(`font-size:${tf.fontSize}pt`);
        if (tf.fontFamily) s.push(`font-family:"${tf.fontFamily}",sans-serif`);
        const fg = colorToCss(tf.foregroundColor);
        if (fg) s.push(`color:${fg}`);
        const deco = [];
        if (tf.underline) deco.push('underline');
        if (tf.strikethrough) deco.push('line-through');
        if (deco.length) s.push(`text-decoration:${deco.join(' ')}`);
    }
    if (fmt.horizontalAlignment) s.push(`text-align:${fmt.horizontalAlignment.toLowerCase()}`);
    if (fmt.verticalAlignment) {
        const vm = {TOP:'top', MIDDLE:'middle', BOTTOM:'bottom'};
        s.push(`vertical-align:${vm[fmt.verticalAlignment]||'middle'}`);
    }
    if (fmt.wrapStrategy === 'WRAP') { s.push('white-space:normal'); s.push('word-wrap:break-word'); }
    return s.join(';');
}

function processMerges(mergeCells, maxRows, maxCols) {
    const covered = Array.from({length:maxRows},()=>Array(maxCols).fill(false));
    const mergeInfo = Array.from({length:maxRows},()=>Array(maxCols).fill(null));
    (mergeCells||[]).forEach(m => {
        const r = m.range || {};
        const sr = r.startRowIndex || 0;
        const er = r.endRowIndex || maxRows;
        const sc = r.startColumnIndex || 0;
        const ec = r.endColumnIndex || maxCols;
        for (let row = sr; row < er; row++) {
            for (let col = sc; col < ec; col++) {
                if (row < maxRows && col < maxCols) covered[row][col] = true;
            }
        }
        if (sr < maxRows && sc < maxCols) {
            covered[sr][sc] = false;
            mergeInfo[sr][sc] = { rowspan: Math.min(er, maxRows) - sr, colspan: Math.min(ec, maxCols) - sc };
        }
    });
    return { covered, mergeInfo };
}

function escapeHtml(text) {
    const d = document.createElement('div');
    d.textContent = text;
    return d.innerHTML;
}

function parseNumber(str) {
    if (!str) return 0;
    const cleaned = str.replace(/[$,€£¥%\s]/g, '');
    const num = parseFloat(cleaned);
    return isNaN(num) ? 0 : num;
}

function formatNumber(num) {
    if (num === 0) return '0';
    const isInt = Number.isInteger(num);
    return num.toLocaleString('en-US', {minimumFractionDigits: isInt?0:2, maximumFractionDigits: 2});
}

function getHiddenCols(columnMetadata) {
    const hidden = [];
    (columnMetadata||[]).forEach((meta, idx) => { if (meta.hiddenByUser) hidden.push(idx); });
    return hidden;
}

function getHiddenRows(rowMetadata) {
    const hidden = [];
    (rowMetadata||[]).forEach((meta, idx) => { if (meta.hiddenByUser) hidden.push(idx); });
    return hidden;
}

function getFrozenRowCount(sheetData) {
    const grid = sheetData.properties && sheetData.properties.gridProperties;
    if (grid && grid.frozenRowCount) return grid.frozenRowCount;
    return 1;
}

function getFilterColumnIndex(header) {
    const h = header.map(x => (x||'').toLowerCase());
    const idx = h.findIndex(x => x.includes('status'));
    return idx >= 0 ? idx : h.length - 1;
}

function getUniqueFilterValues(sheetData, headerRowIdx, hiddenRows) {
    const data = sheetData.data && sheetData.data[0];
    if (!data || !data.rowData) return [];
    const rows = data.rowData;
    const dataStart = headerRowIdx + 1;
    if (dataStart >= rows.length) return [];
    let colIdx = rows[headerRowIdx].values ? rows[headerRowIdx].values.length - 1 : 0;
    const headerCells = rows[headerRowIdx].values || [];
    const header = headerCells.map(c => (c.formattedValue || '').toLowerCase());
    const statusIdx = header.findIndex(h => h.includes('status'));
    if (statusIdx >= 0) colIdx = statusIdx;
    const vals = new Set();
    for (let i = dataStart; i < rows.length; i++) {
        if (hiddenRows.includes(i)) continue;
        const cell = rows[i].values && rows[i].values[colIdx];
        const v = cell ? (cell.formattedValue || '').trim() : '';
        if (v) vals.add(v);
    }
    return Array.from(vals).sort();
}

function populateFilter(sheetData, headerRowIdx, hiddenRows) {
    const options = getUniqueFilterValues(sheetData, headerRowIdx, hiddenRows);
    let html = '<option value="all">All Rows</option>';
    options.forEach(opt => { html += `<option value="${escapeHtml(opt)}">${escapeHtml(opt)}</option>`; });
    filterBox.innerHTML = html;
    filterBox.value = (filterVal !== 'all' && options.includes(filterVal)) ? filterVal : 'all';
}

function detectNumericColumns(rows, dataStart, maxCols, hiddenRows) {
    const numericCols = [];
    for (let c = 0; c < maxCols; c++) {
        let numCount = 0, totalCount = 0;
        for (let r = dataStart; r < rows.length; r++) {
            if (hiddenRows.includes(r)) continue;
            const cell = rows[r].values && rows[r].values[c];
            const v = cell ? (cell.formattedValue || '').trim() : '';
            if (!v) continue;
            totalCount++;
            const cleaned = v.replace(/[$,€£¥%\s]/g, '');
            if (!isNaN(parseFloat(cleaned)) && isFinite(cleaned)) numCount++;
        }
        if (totalCount > 0 && numCount / totalCount >= 0.7) numericCols.push(c);
    }
    return numericCols;
}

function buildTabs() {
    let html = '';
    allSheets.forEach((s, i) => {
        const title = s.properties && s.properties.title || `Sheet ${i+1}`;
        const cls = i === currentIdx ? 'tab active' : 'tab';
        html += `<div class="${cls}" data-idx="${i}" onclick="switchTab(${i})">${escapeHtml(title)}</div>`;
    });
    tabBar.innerHTML = html;
}

function switchTab(idx) {
    currentIdx = idx;
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    const activeTab = document.querySelector(`.tab[data-idx="${idx}"]`);
    if (activeTab) activeTab.classList.add('active');
    renderSheet(idx);
}

function showToast(msg) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 2000);
}

function doSearch() { searchTerm = searchBox.value.trim(); renderSheet(currentIdx); }
function doFilter() { filterVal = filterBox.value; renderSheet(currentIdx); }
function toggleDark() { isDark = !isDark; document.body.classList.toggle('dark', isDark); showToast(isDark ? 'Dark mode enabled' : 'Light mode enabled'); }

// Auxiliary PWA Logic
function toggleBreak() {
    const isBreakActive = localStorage.getItem('breakActive') === 'true';
    const btn = document.getElementById('breakBtn');
    if (!isBreakActive) {
        localStorage.setItem('breakActive', 'true');
        localStorage.setItem('breakStart', Date.now().toString());
        btn.textContent = '▶ Resume Duty';
        btn.style.background = '#feefc3';
    } else {
        const breakStart = parseInt(localStorage.getItem('breakStart') || Date.now());
        const accumulated = parseInt(localStorage.getItem('totalBreakDuration') || '0');
        localStorage.setItem('totalBreakDuration', (accumulated + (Date.now() - breakStart)).toString());
        localStorage.setItem('breakActive', 'false');
        btn.textContent = '🍱 Take Break';
        btn.style.background = '#fff8e1';
    }
}

function saveToQueue(payload) {
    const queue = JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]');
    queue.push(payload);
    localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
    updateQueueBadge();
}

async function flushOfflineQueue() {
    const queue = JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]');
    if (queue.length === 0) return;
    const remaining = [];
    for (const item of queue) {
        try {
            await fetch(SCRIPT_URL, {
                method: 'POST', mode: 'no-cors',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(item)
            });
        } catch (e) { remaining.push(item); }
    }
    localStorage.setItem(QUEUE_KEY, JSON.stringify(remaining));
    updateQueueBadge();
}

function updateQueueBadge() {
    const queue = JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]');
    const badge = document.getElementById('queueBadge');
    if (!badge) return;
    badge.textContent = `${queue.length} queued`;
    badge.className = queue.length > 0 ? 'queue-badge has-items' : 'queue-badge';
}

function triggerVoiceInput() {
    if (!('webkitSpeechRecognition' in window)) return alert('Web Speech API not supported in this browser.');
    const recognition = new webkitSpeechRecognition();
    recognition.onstart = () => showToast('Listening... Speak expense details.');
    recognition.onresult = (e) => alert(`Captured Voice Data: "${e.results[0][0].transcript}"`);
    recognition.start();
}

function calculateDutyMetrics(endOdo) {
    const startOdo = parseFloat(localStorage.getItem('odometerStart') || '0');
    const totalKM = startOdo > 0 ? (parseFloat(endOdo) - startOdo).toFixed(1) : '0';
    const startTime = parseInt(localStorage.getItem('dutyStartTime') || Date.now());
    const breakMs = parseInt(localStorage.getItem('totalBreakDuration') || '0');
    const netMs = Math.max(0, Date.now() - startTime - breakMs);
    const hrs = Math.floor(netMs / (1000 * 60 * 60));
    const mins = Math.floor((netMs % (1000 * 60 * 60)) / (1000 * 60));
    return { totalKM, durationStr: `${hrs}h ${mins}m` };
}

function getCurrentGPS() {
    return new Promise((resolve) => {
        navigator.geolocation.getCurrentPosition(
            pos => resolve({ latitude: pos.coords.latitude, longitude: pos.coords.longitude }),
            () => resolve({ latitude: 19.8762, longitude: 75.3433 }),
            { enableHighAccuracy: true, timeout: 5000 }
        );
    });
}

function updateMapPin(lat, lng, label) {
    if (leafletMap) {
        L.marker([lat, lng]).addTo(leafletMap).bindPopup(`Event: ${label}`).openPopup();
        leafletMap.panTo([lat, lng]);
    }
}

function updateDutyUI() {
    const active = localStorage.getItem('dutyActive') === 'true';
    document.getElementById('dutyToggle').checked = active;
    document.getElementById('dutyStatusBadge').textContent = active ? 'ON DUTY' : 'OFF DUTY';
    document.getElementById('dutyStatusBadge').style.background = active ? '#e6f4ea' : '#f1f3f4';
    document.getElementById('dutyStatusBadge').style.color = active ? '#137333' : '#5f6368';
    document.getElementById('breakBtn').style.display = active ? 'inline-flex' : 'none';
    document.getElementById('dutyMetrics').style.display = active ? 'grid' : 'none';
    if (active) document.getElementById('lblStartOdo').textContent = localStorage.getItem('odometerStart') || '-';
}

function checkMaintenanceAlerts(currentOdo) {
    const odo = parseFloat(currentOdo || '0');
    const card = document.getElementById('maintenanceAlertCard');
    if (typeof MAINTENANCE_THRESHOLDS !== 'undefined' && odo > MAINTENANCE_THRESHOLDS.oilChange) {
        card.style.display = 'block';
        card.innerHTML = `⚠️ <strong>Maintenance Alert:</strong> Odometer (${odo} km) exceeds service limit.`;
    }
}

function startBreadcrumbTracking() {
    setInterval(async () => {
        if (localStorage.getItem('dutyActive') === 'true') {
            const gps = await getCurrentGPS();
            const crumbs = JSON.parse(localStorage.getItem(BREADCRUMB_KEY) || '[]');
            crumbs.push({ ...gps, timestamp: Date.now() });
            localStorage.setItem(BREADCRUMB_KEY, JSON.stringify(crumbs));
        }
    }, 600000);
}

function exportShiftCSV() {
    const history = JSON.parse(localStorage.getItem(SHIFT_HISTORY_KEY) || '[]');
    if (history.length === 0) return alert('No shift history logged locally yet.');
    let csv = 'Date,Start,End,StartOdo,EndOdo,TotalKM,Duration\n';
    history.forEach(r => csv += `"${r.date}","${r.startTime}","${r.endTime}","${r.startOdo}","${r.endOdo}","${r.totalKM}","${r.duration}"\n`);
    const link = document.createElement('a');
    link.href = encodeURI('data:text/csv;charset=utf-8,' + csv);
    link.download = `happy_miles_${new Date().toISOString().split('T')[0]}.csv`;
    link.click();
}

function saveShiftRecord(r) {
    const history = JSON.parse(localStorage.getItem(SHIFT_HISTORY_KEY) || '[]');
    history.push(r);
    localStorage.setItem(SHIFT_HISTORY_KEY, JSON.stringify(history));
}

function showOCRModal(msg) {
    document.getElementById('ocrProcessingState').style.display = 'block';
    document.getElementById('ocrVerifySection').style.display = 'none';
    document.getElementById('ocrStatusMsg').textContent = msg;
    document.getElementById('ocrModal').style.display = 'flex';
}
function showVerificationUI(val) {
    document.getElementById('ocrProcessingState').style.display = 'none';
    document.getElementById('odometerInputValue').value = val;
    document.getElementById('ocrVerifySection').style.display = 'block';
}
function hideOCRModal() { document.getElementById('ocrModal').style.display = 'none'; }
function cancelOdometerCapture() { hideOCRModal(); updateDutyUI(); }
function openExpenseModal() { document.getElementById('expenseModal').style.display = 'flex'; }
function closeExpenseModal() { document.getElementById('expenseModal').style.display = 'none'; }
function handleExpenseSubmit(e) {
    e.preventDefault();
    closeExpenseModal();
    showToast('Expense Logged Successfully!');
}
function showDiagnostics() {
    if (navigator.storage && navigator.storage.estimate) {
        navigator.storage.estimate().then(({usage, quota}) => {
            alert(`Storage Usage: ${(usage / 1024 / 1024).toFixed(2)} MB of ${(quota / 1024 / 1024).toFixed(2)} MB`);
        });
    }
}
