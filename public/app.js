// WhatsApp Group Manager - Frontend Logic
const socket = io();

// State
let appState = {
  currentStep: 1,
  isConnected: false,
  currentUser: null,
  activeTab: 'tab-excel',
  uploadedFile: null,
  excelData: null,
  processedRecords: [],
  allGroups: [],
  selectedGroupIds: new Set(),
  matchedItems: [],
  activeRemoval: false,
  isPaused: false
};

// DOM Elements
const connectionStatusBadge = document.getElementById('connectionStatusBadge');
const connectionStatusText = document.getElementById('connectionStatusText');
const logoutBtn = document.getElementById('logoutBtn');

// Stepper
const stepItems = document.querySelectorAll('.step-item');
const stepSections = document.querySelectorAll('.step-section');

// Step 1 Elements
const qrContainer = document.getElementById('qrContainer');
const qrLoading = document.getElementById('qrLoading');
const qrImage = document.getElementById('qrImage');
const connectedCard = document.getElementById('connectedCard');
const connectedUserName = document.getElementById('connectedUserName');
const connectedUserPhone = document.getElementById('connectedUserPhone');
const toStep2Btn = document.getElementById('toStep2Btn');

// Step 2 Elements
const tabBtns = document.querySelectorAll('.tab-btn');
const tabContents = document.querySelectorAll('.tab-content');
const dropZone = document.getElementById('dropZone');
const dropZoneContent = document.getElementById('dropZoneContent');
const dropZoneLoading = document.getElementById('dropZoneLoading');
const excelFileInput = document.getElementById('excelFileInput');
const fileSummaryCard = document.getElementById('fileSummaryCard');
const fileNameEl = document.getElementById('fileName');
const fileRowsCountEl = document.getElementById('fileRowsCount');
const changeFileBtn = document.getElementById('changeFileBtn');
const phoneColumnSelect = document.getElementById('phoneColumnSelect');
const nameColumnSelect = document.getElementById('nameColumnSelect');
const defaultCountryCodeInput = document.getElementById('defaultCountryCode');
const validNumbersCountEl = document.getElementById('validNumbersCount');
const excelPreviewTableBody = document.getElementById('excelPreviewTableBody');
const commonRecordsPreview = document.getElementById('commonRecordsPreview');
const backToStep1Btn = document.getElementById('backToStep1Btn');
const toStep3Btn = document.getElementById('toStep3Btn');

// Tab 2: Copy-Paste
const pastedNumbersText = document.getElementById('pastedNumbersText');
const extractPastedBtn = document.getElementById('extractPastedBtn');
const clearPastedBtn = document.getElementById('clearPastedBtn');

// Tab 3: OCR
const ocrDropZone = document.getElementById('ocrDropZone');
const ocrFileInput = document.getElementById('ocrFileInput');
const ocrDropZoneContent = document.getElementById('ocrDropZoneContent');
const ocrLoading = document.getElementById('ocrLoading');
const ocrProgressStatus = document.getElementById('ocrProgressStatus');
const ocrPreviewContainer = document.getElementById('ocrPreviewContainer');
const ocrPreviewImg = document.getElementById('ocrPreviewImg');

// Step 3 Elements
const refreshGroupsBtn = document.getElementById('refreshGroupsBtn');
const groupSearchInput = document.getElementById('groupSearchInput');
const adminOnlyFilter = document.getElementById('adminOnlyFilter');
const selectAllGroupsBtn = document.getElementById('selectAllGroupsBtn');
const deselectAllGroupsBtn = document.getElementById('deselectAllGroupsBtn');
const groupsLoading = document.getElementById('groupsLoading');
const groupsGrid = document.getElementById('groupsGrid');
const selectedGroupsCountEl = document.getElementById('selectedGroupsCount');
const backToStep2Btn = document.getElementById('backToStep2Btn');
const toStep4Btn = document.getElementById('toStep4Btn');

// Step 4 Elements
const statExcelTotal = document.getElementById('statExcelTotal');
const statSelectedGroupsCount = document.getElementById('statSelectedGroupsCount');
const statFoundMatchesCount = document.getElementById('statFoundMatchesCount');
const statAdminsProtectedCount = document.getElementById('statAdminsProtectedCount');
const delaySecondsInput = document.getElementById('delaySeconds');
const batchPauseCountInput = document.getElementById('batchPauseCount');
const matchSearchInput = document.getElementById('matchSearchInput');
const checkAllMatches = document.getElementById('checkAllMatches');
const matchesTableBody = document.getElementById('matchesTableBody');
const progressBox = document.getElementById('progressBox');
const progressStatusText = document.getElementById('progressStatusText');
const progressPercentage = document.getElementById('progressPercentage');
const progressBarFill = document.getElementById('progressBarFill');
const progressSuccessCount = document.getElementById('progressSuccessCount');
const progressFailedCount = document.getElementById('progressFailedCount');
const progressRemainingCount = document.getElementById('progressRemainingCount');
const terminalLogs = document.getElementById('terminalLogs');
const clearLogsBtn = document.getElementById('clearLogsBtn');
const startRemovalBtn = document.getElementById('startRemovalBtn');
const pauseRemovalBtn = document.getElementById('pauseRemovalBtn');
const resumeRemovalBtn = document.getElementById('resumeRemovalBtn');
const stopRemovalBtn = document.getElementById('stopRemovalBtn');
const exportReportBtn = document.getElementById('exportReportBtn');
const backToStep3Btn = document.getElementById('backToStep3Btn');

// ========================
// Socket.io Handlers
// ========================
socket.on('status', (data) => {
  if (data.status === 'connected') {
    appState.isConnected = true;
    appState.currentUser = data.user;
    updateConnectionUI(true, data.user);
  } else {
    appState.isConnected = false;
    appState.currentUser = null;
    updateConnectionUI(false, null, data.message);
  }
});

socket.on('qr', (qrDataUrl) => {
  qrLoading.style.display = 'none';
  qrImage.src = qrDataUrl;
  qrImage.style.display = 'block';
  qrContainer.style.display = 'flex';
  connectedCard.style.display = 'none';
});

socket.on('removal_log', (data) => {
  addTerminalLog(data.message, data.type || 'info');
});

socket.on('removal_progress', (data) => {
  updateProgressUI(data);
});

socket.on('removal_completed', (data) => {
  finishRemovalUI(data);
});

// Update connection UI state
function updateConnectionUI(connected, user, msg) {
  if (connected) {
    connectionStatusBadge.className = 'status-badge connected';
    connectionStatusText.textContent = `متصل (${user.phone})`;
    logoutBtn.style.display = 'inline-flex';

    qrContainer.style.display = 'none';
    connectedCard.style.display = 'flex';
    connectedUserName.textContent = `مرحباً ${user.name || 'بك'}`;
    connectedUserPhone.textContent = `+${user.phone}`;
  } else {
    connectionStatusBadge.className = 'status-badge disconnected';
    connectionStatusText.textContent = msg || 'غير متصل';
    logoutBtn.style.display = 'none';

    connectedCard.style.display = 'none';
    if (!qrImage.src) {
      qrLoading.style.display = 'flex';
      qrImage.style.display = 'none';
    }
  }
}

// Stepper Navigation
function goToStep(step) {
  appState.currentStep = step;

  stepItems.forEach((item) => {
    const s = parseInt(item.dataset.step);
    item.classList.remove('active', 'completed');
    if (s === step) item.classList.add('active');
    else if (s < step) item.classList.add('completed');
  });

  stepSections.forEach((section, idx) => {
    section.classList.toggle('active', idx + 1 === step);
  });

  window.scrollTo({ top: 0, behavior: 'smooth' });

  // Auto trigger data load if needed
  if (step === 3 && appState.allGroups.length === 0) {
    loadGroups();
  } else if (step === 4) {
    calculateMatchesAndPreview();
  }
}

// Event Listeners for Stepper Buttons
toStep2Btn.addEventListener('click', () => goToStep(2));
backToStep1Btn.addEventListener('click', () => goToStep(1));
toStep3Btn.addEventListener('click', () => goToStep(3));
backToStep2Btn.addEventListener('click', () => goToStep(2));
toStep4Btn.addEventListener('click', () => goToStep(4));
backToStep3Btn.addEventListener('click', () => goToStep(3));

// Stepper header click
stepItems.forEach((item) => {
  item.addEventListener('click', () => {
    const targetStep = parseInt(item.dataset.step);
    if (targetStep === 1 || (targetStep === 2 && appState.isConnected) ||
        (targetStep === 3) ||
        (targetStep === 4 && appState.selectedGroupIds.size > 0)) {
      goToStep(targetStep);
    }
  });
});

// Logout
logoutBtn.addEventListener('click', async () => {
  if (confirm('هل أنت متأكد من رغبتك في تسجيل الخروج؟ ستحتاج لمسح رمز QR مرة أخرى.')) {
    try {
      await fetch('/api/logout', { method: 'POST' });
      location.reload();
    } catch (e) {
      alert('خطأ في تسجيل الخروج: ' + e.message);
    }
  }
});

// ============================================
// Step 2: Input Tabs & Multi-Source Processing
// ============================================
tabBtns.forEach((btn) => {
  btn.addEventListener('click', () => {
    const targetId = btn.dataset.tab;
    appState.activeTab = targetId;

    tabBtns.forEach((b) => b.classList.remove('active'));
    tabContents.forEach((c) => c.classList.remove('active'));

    btn.classList.add('active');
    const content = document.getElementById(targetId);
    if (content) content.classList.add('active');
  });
});

// Helper: Convert Arabic numbers and clean
function normalizeRawPhoneNumber(rawPhone, defaultCountryCode = '20') {
  if (!rawPhone) return null;
  // Convert Arabic numerals
  let str = String(rawPhone)
    .replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d));

  let digits = str.replace(/\D/g, '');
  if (!digits || digits.length < 8) return null;

  if (digits.startsWith('00')) {
    digits = digits.substring(2);
  }

  if (digits.startsWith('01') && digits.length === 11) {
    digits = '20' + digits.substring(1);
  } else if (digits.startsWith('0') && defaultCountryCode) {
    digits = defaultCountryCode + digits.substring(1);
  } else if (digits.length <= 10 && defaultCountryCode) {
    digits = defaultCountryCode + digits;
  }

  return digits;
}

// Render processed records table
function renderExtractedRecords(records) {
  appState.processedRecords = records;
  if (!records || records.length === 0) {
    commonRecordsPreview.style.display = 'none';
    validNumbersCountEl.textContent = 'لم يتم العثور على أرقام صالحة';
    return;
  }

  commonRecordsPreview.style.display = 'block';
  validNumbersCountEl.textContent = `تم استخراج ${records.length} رقم هاتف صالح وفريد`;
  excelPreviewTableBody.innerHTML = '';

  const preview = records.slice(0, 15);
  preview.forEach((item, idx) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${idx + 1}</td>
      <td><strong>${escapeHtml(item.name || `عضو #${idx + 1}`)}</strong></td>
      <td dir="ltr" style="text-align: right;">${escapeHtml(item.rawPhone)}</td>
      <td dir="ltr" style="text-align: right;" class="text-accent font-bold">+${item.normalizedPhone}</td>
      <td><span class="badge" style="background: rgba(37, 211, 102, 0.15);">جاهز للمطابقة</span></td>
    `;
    excelPreviewTableBody.appendChild(tr);
  });
}

// --- Tab 1: Excel Handling ---
dropZone.addEventListener('click', () => excelFileInput.click());
dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZone.classList.add('dragover');
});
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('dragover');
  if (e.dataTransfer.files.length) {
    handleFileUpload(e.dataTransfer.files[0]);
  }
});

excelFileInput.addEventListener('change', (e) => {
  if (e.target.files.length) {
    handleFileUpload(e.target.files[0]);
  }
});

changeFileBtn.addEventListener('click', () => {
  excelFileInput.value = '';
  dropZoneLoading.style.display = 'none';
  dropZoneContent.style.display = 'block';
  dropZone.style.display = 'block';
  fileSummaryCard.style.display = 'none';
  appState.excelData = null;
  renderExtractedRecords([]);
});

async function handleFileUpload(file) {
  const formData = new FormData();
  formData.append('file', file);

  dropZoneContent.style.display = 'none';
  dropZoneLoading.style.display = 'flex';

  try {
    const res = await fetch('/api/upload-excel', {
      method: 'POST',
      body: formData
    });
    const data = await res.json();

    dropZoneLoading.style.display = 'none';
    dropZoneContent.style.display = 'block';

    if (!data.success) {
      alert('خطأ: ' + data.error);
      resetDropZoneUI();
      return;
    }

    appState.excelData = data;
    renderFileSummary(data);

  } catch (err) {
    dropZoneLoading.style.display = 'none';
    dropZoneContent.style.display = 'block';
    alert('حدث خطأ أثناء رفع الملف: ' + err.message);
    resetDropZoneUI();
  }
}

function resetDropZoneUI() {
  dropZoneLoading.style.display = 'none';
  dropZoneContent.style.display = 'block';
  dropZone.style.display = 'block';
  fileSummaryCard.style.display = 'none';
}

function renderFileSummary(data) {
  dropZone.style.display = 'none';
  fileSummaryCard.style.display = 'flex';

  fileNameEl.textContent = data.fileName;
  fileRowsCountEl.textContent = `${data.totalRows} صف بيانات`;

  phoneColumnSelect.innerHTML = '';
  nameColumnSelect.innerHTML = '<option value="">-- بدون عمود اسم (توليد تلقائي) --</option>';

  data.columns.forEach((col) => {
    const phoneOpt = document.createElement('option');
    phoneOpt.value = col;
    phoneOpt.textContent = col;
    if (col === data.detectedPhoneCol) phoneOpt.selected = true;
    phoneColumnSelect.appendChild(phoneOpt);

    const nameOpt = document.createElement('option');
    nameOpt.value = col;
    nameOpt.textContent = col;
    if (col === data.detectedNameCol) nameOpt.selected = true;
    nameColumnSelect.appendChild(nameOpt);
  });

  phoneColumnSelect.onchange = processExtractedNumbers;
  nameColumnSelect.onchange = processExtractedNumbers;
  defaultCountryCodeInput.oninput = processExtractedNumbers;

  processExtractedNumbers();
}

async function processExtractedNumbers() {
  if (!appState.excelData) return;

  const body = {
    tempPath: appState.excelData.tempPath,
    phoneCol: phoneColumnSelect.value,
    nameCol: nameColumnSelect.value,
    defaultCountryCode: defaultCountryCodeInput.value.trim()
  };

  try {
    const res = await fetch('/api/process-excel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const result = await res.json();

    if (result.success) {
      renderExtractedRecords(result.items);
    }
  } catch (err) {
    console.error('Process error:', err);
  }
}

// --- Tab 2: Copy-Paste Text Handling ---
extractPastedBtn.addEventListener('click', () => {
  const text = pastedNumbersText.value.trim();
  if (!text) {
    alert('يرجى لصق نص أو أرقام أولاً.');
    return;
  }

  const defaultCountry = defaultCountryCodeInput.value.trim() || '20';
  const lines = text.split(/[\r\n,;]+/);
  const records = [];
  const seen = new Set();

  lines.forEach((line, i) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    // Try finding phone in line
    const match = trimmed.match(/(?:\+|00)?[0-9٠-٩]{9,15}/);
    if (match) {
      const rawNumber = match[0];
      const normalized = normalizeRawPhoneNumber(rawNumber, defaultCountry);
      // Remaining text might be the name
      let possibleName = trimmed.replace(rawNumber, '').replace(/[-–—:]+/g, '').trim();
      if (!possibleName) possibleName = `عضو #${records.length + 1}`;

      if (normalized && !seen.has(normalized)) {
        seen.add(normalized);
        records.push({
          rowNumber: records.length + 1,
          name: possibleName,
          rawPhone: rawNumber,
          normalizedPhone: normalized,
          jid: `${normalized}@s.whatsapp.net`
        });
      }
    }
  });

  if (records.length === 0) {
    alert('لم يتم العثور على أي أرقام هواتف صالحة في النص الملصق.');
  } else {
    renderExtractedRecords(records);
    alert(`✅ تم استخراج ${records.length} رقم هاتف بنجاح!`);
  }
});

clearPastedBtn.addEventListener('click', () => {
  pastedNumbersText.value = '';
  renderExtractedRecords([]);
});

// --- Tab 3: Image OCR Handling ---
ocrDropZone.addEventListener('click', () => ocrFileInput.click());
ocrDropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  ocrDropZone.classList.add('dragover');
});
ocrDropZone.addEventListener('dragleave', () => ocrDropZone.classList.remove('dragover'));
ocrDropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  ocrDropZone.classList.remove('dragover');
  if (e.dataTransfer.files.length) {
    processImageOCR(e.dataTransfer.files[0]);
  }
});

ocrFileInput.addEventListener('change', (e) => {
  if (e.target.files.length) {
    processImageOCR(e.target.files[0]);
  }
});

// Global paste listener for images (Ctrl+V)
window.addEventListener('paste', (e) => {
  if (appState.currentStep === 2 && appState.activeTab === 'tab-ocr') {
    const items = (e.clipboardData || e.originalEvent.clipboardData).items;
    for (const item of items) {
      if (item.type.indexOf('image') !== -1) {
        const file = item.getAsFile();
        processImageOCR(file);
        break;
      }
    }
  }
});

async function processImageOCR(file) {
  if (!file || !file.type.startsWith('image/')) {
    alert('يرجى اختيار ملف صورة صالح.');
    return;
  }

  // Preview Image
  const reader = new FileReader();
  reader.onload = (e) => {
    ocrPreviewImg.src = e.target.result;
    ocrPreviewContainer.style.display = 'block';
  };
  reader.readAsDataURL(file);

  ocrDropZoneContent.style.display = 'none';
  ocrLoading.style.display = 'flex';
  ocrProgressStatus.textContent = 'جاري تهيئة محرك التعرف الضوئي على النصوص (OCR)...';

  try {
    if (typeof Tesseract === 'undefined') {
      throw new Error('مكتبة Tesseract غير متوفرة');
    }

    const worker = await Tesseract.createWorker('eng+ara');
    ocrProgressStatus.textContent = 'جاري فحص الصورة واستخراج الأرقام...';

    const ret = await worker.recognize(file);
    await worker.terminate();

    const text = ret.data.text;
    console.log('[OCR Text Output]:', text);

    ocrLoading.style.display = 'none';
    ocrDropZoneContent.style.display = 'block';

    // Parse numbers from OCR text
    const defaultCountry = defaultCountryCodeInput.value.trim() || '20';
    const lines = text.split(/[\r\n]+/);
    const records = [];
    const seen = new Set();

    lines.forEach((line) => {
      const trimmed = line.trim();
      const matches = trimmed.match(/(?:\+|00)?[0-9٠-٩]{9,15}/g);
      if (matches) {
        matches.forEach((rawNumber) => {
          const normalized = normalizeRawPhoneNumber(rawNumber, defaultCountry);
          if (normalized && !seen.has(normalized)) {
            seen.add(normalized);
            records.push({
              rowNumber: records.length + 1,
              name: `عضو (${normalized})`,
              rawPhone: rawNumber,
              normalizedPhone: normalized,
              jid: `${normalized}@s.whatsapp.net`
            });
          }
        });
      }
    });

    if (records.length === 0) {
      alert('لم يتم العثور على أرقام هواتف واضحة في الصورة. يمكنك كتابة الأرقام يدوياً أو رفع ملف إكسيل.');
    } else {
      renderExtractedRecords(records);
      alert(`✅ نجاح: تم استخراج ${records.length} رقم هاتف من الصورة!`);
    }

  } catch (err) {
    ocrLoading.style.display = 'none';
    ocrDropZoneContent.style.display = 'block';
    alert('حدث خطأ أثناء قراءة الصورة: ' + err.message);
  }
}

// ========================
// Step 3: Groups Handling
// ========================
refreshGroupsBtn.addEventListener('click', loadGroups);

async function loadGroups() {
  groupsLoading.style.display = 'flex';
  groupsGrid.style.display = 'none';

  try {
    const res = await fetch('/api/groups');
    const data = await res.json();

    groupsLoading.style.display = 'none';
    groupsGrid.style.display = 'grid';

    if (!data.success) {
      alert('خطأ: ' + data.error);
      return;
    }

    appState.allGroups = data.groups;
    renderGroupsGrid();

  } catch (err) {
    groupsLoading.style.display = 'none';
    alert('تعذر تحميل الجروبات: ' + err.message);
  }
}

function renderGroupsGrid() {
  const searchTerm = groupSearchInput.value.trim().toLowerCase();
  const onlyAdmin = adminOnlyFilter.checked;

  groupsGrid.innerHTML = '';

  const filtered = appState.allGroups.filter((g) => {
    const matchesSearch = g.subject.toLowerCase().includes(searchTerm);
    const matchesAdmin = onlyAdmin ? g.isAdmin : true;
    return matchesSearch && matchesAdmin;
  });

  if (filtered.length === 0) {
    groupsGrid.innerHTML = `
      <div style="grid-column: 1 / -1; text-align: center; padding: 40px; color: var(--text-secondary);">
        <i class="fa-solid fa-users-slash fa-3x" style="margin-bottom: 12px; opacity: 0.5;"></i>
        <p>لا توجد مجموعات مطابقة لخيارات البحث أو الفلتر المحدد.</p>
      </div>
    `;
    return;
  }

  filtered.forEach((group) => {
    const card = document.createElement('div');
    const isSelected = appState.selectedGroupIds.has(group.id);
    const canSelect = group.isAdmin;

    card.className = `group-card ${isSelected ? 'selected' : ''} ${!canSelect ? 'not-admin' : ''}`;
    card.innerHTML = `
      <div class="group-header-row">
        <div class="group-avatar">
          <i class="fa-solid fa-users"></i>
        </div>
        <div class="group-title-info">
          <div class="group-name" title="${escapeHtml(group.subject)}">${escapeHtml(group.subject)}</div>
          <div class="group-members-count">${group.participantsCount} عضو</div>
        </div>
        <span class="group-badge ${group.isAdmin ? 'admin' : 'member'}">
          ${group.isAdmin ? 'مشرف (Admin)' : 'عضو فقط'}
        </span>
      </div>
    `;

    if (canSelect) {
      card.addEventListener('click', () => {
        if (appState.selectedGroupIds.has(group.id)) {
          appState.selectedGroupIds.delete(group.id);
          card.classList.remove('selected');
        } else {
          appState.selectedGroupIds.add(group.id);
          card.classList.add('selected');
        }
        updateSelectedGroupsCountUI();
      });
    }

    groupsGrid.appendChild(card);
  });

  updateSelectedGroupsCountUI();
}

function updateSelectedGroupsCountUI() {
  selectedGroupsCountEl.textContent = appState.selectedGroupIds.size;
  toStep4Btn.disabled = appState.selectedGroupIds.size === 0;
}

groupSearchInput.addEventListener('input', renderGroupsGrid);
adminOnlyFilter.addEventListener('change', renderGroupsGrid);

selectAllGroupsBtn.addEventListener('click', () => {
  appState.allGroups.forEach((g) => {
    if (g.isAdmin) appState.selectedGroupIds.add(g.id);
  });
  renderGroupsGrid();
});

deselectAllGroupsBtn.addEventListener('click', () => {
  appState.selectedGroupIds.clear();
  renderGroupsGrid();
});

// ========================
// Step 4: Matches & Removal
// ========================
async function calculateMatchesAndPreview() {
  statExcelTotal.textContent = appState.processedRecords.length;
  statSelectedGroupsCount.textContent = appState.selectedGroupIds.size;
  matchesTableBody.innerHTML = `
    <tr>
      <td colspan="5" style="text-align: center; padding: 30px;">
        <div class="spinner" style="margin: 0 auto 10px;"></div>
        جاري مطابقة القائمة مع أعضاء الجروبات المحددة...
      </td>
    </tr>
  `;

  try {
    // Send only targetGroupIds and processedRecords (groupsData is cached on server)
    const res = await fetch('/api/match-members', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetGroupIds: Array.from(appState.selectedGroupIds),
        excelRecords: appState.processedRecords
      })
    });

    const data = await res.json();
    if (!data.success) {
      matchesTableBody.innerHTML = `
        <tr>
          <td colspan="5" style="text-align: center; padding: 25px; color: var(--danger-color);">
            <i class="fa-solid fa-triangle-exclamation fa-2x" style="margin-bottom: 8px;"></i>
            <p>خطأ أثناء المطابقة: ${escapeHtml(data.error || 'حدث خطأ')}</p>
            <button onclick="calculateMatchesAndPreview()" class="btn btn-secondary btn-sm" style="margin-top: 10px;">إعادة المحاولة</button>
          </td>
        </tr>
      `;
      return;
    }

    appState.matchedItems = data.matchesToKick || [];

    // In direct selection mode, uncheck all by default
    if (data.directSelectionMode) {
      checkAllMatches.checked = false;
      appState.matchedItems.forEach(i => i.selected = false);
      addTerminalLog('ℹ️ وضع التحديد اليدوي: يمكنك وضع علامة (صح) أمام الأعضاء الذين ترغب في حذفهم.', 'info');
    }

    statFoundMatchesCount.textContent = data.matchesCount;
    statAdminsProtectedCount.textContent = data.adminsProtectedCount;

    renderMatchesTable(appState.matchedItems);

    if (data.matchesCount === 0) {
      startRemovalBtn.disabled = true;
      addTerminalLog('ℹ️ لم يتم العثور على أي تطابق في المجموعات المحددة.', 'info');
    } else {
      updateStartBtnCount();
      if (!data.directSelectionMode) {
        addTerminalLog(`✅ تم العثور على ${data.matchesCount} عضو مطابق وجاهز للحذف.`, 'success');
      }
      if (data.adminsProtectedCount > 0) {
        addTerminalLog(`🛡️ تم استثناء ${data.adminsProtectedCount} مشرفين تلقائياً لحمايتهم من الحذف.`, 'warn');
      }
    }

  } catch (err) {
    matchesTableBody.innerHTML = `
      <tr>
        <td colspan="5" style="text-align: center; padding: 25px; color: var(--danger-color);">
          <i class="fa-solid fa-triangle-exclamation fa-2x" style="margin-bottom: 8px;"></i>
          <p>فشل في فحص المطابقة: ${escapeHtml(err.message)}</p>
          <button onclick="calculateMatchesAndPreview()" class="btn btn-secondary btn-sm" style="margin-top: 10px;">إعادة المحاولة</button>
        </td>
      </tr>
    `;
  }
}

function renderMatchesTable(items) {
  matchesTableBody.innerHTML = '';
  const searchTerm = matchSearchInput.value.trim().toLowerCase();

  const filtered = items.filter(
    (item) => item.name.toLowerCase().includes(searchTerm) ||
              item.phone.includes(searchTerm) ||
              item.groupName.toLowerCase().includes(searchTerm)
  );

  if (filtered.length === 0) {
    matchesTableBody.innerHTML = `
      <tr>
        <td colspan="5" style="text-align: center; padding: 25px; color: var(--text-secondary);">
          لا يوجد أعضاء مطابقين لعرضهم
        </td>
      </tr>
    `;
    return;
  }

  filtered.forEach((item, idx) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><input type="checkbox" class="match-checkbox" data-index="${idx}" ${item.selected ? 'checked' : ''}></td>
      <td><strong>${escapeHtml(item.name)}</strong></td>
      <td dir="ltr" style="text-align: right;">+${item.phone}</td>
      <td><i class="fa-solid fa-users text-accent"></i> ${escapeHtml(item.groupName)}</td>
      <td><span class="badge" style="background: rgba(239, 68, 68, 0.15); color: var(--danger-color);">${item.selected ? 'محدد للإزالة' : 'غير محدد'}</span></td>
    `;

    const chk = tr.querySelector('.match-checkbox');
    chk.addEventListener('change', (e) => {
      item.selected = e.target.checked;
      const badge = tr.querySelector('.badge');
      if (badge) {
        badge.textContent = item.selected ? 'محدد للإزالة' : 'غير محدد';
      }
      updateStartBtnCount();
    });

    matchesTableBody.appendChild(tr);
  });

  updateStartBtnCount();
}

function updateStartBtnCount() {
  const selectedCount = appState.matchedItems.filter((i) => i.selected).length;
  startRemovalBtn.innerHTML = `<i class="fa-solid fa-trash-can"></i> بدء الحذف الجماعي الآمن (${selectedCount} عضو)`;
  startRemovalBtn.disabled = selectedCount === 0;
}

checkAllMatches.addEventListener('change', (e) => {
  const checked = e.target.checked;
  appState.matchedItems.forEach((i) => (i.selected = checked));
  document.querySelectorAll('.match-checkbox').forEach((chk) => (chk.checked = checked));
  updateStartBtnCount();
});

matchSearchInput.addEventListener('input', () => renderMatchesTable(appState.matchedItems));

// Modal elements
const confirmModal = document.getElementById('confirmModal');
const confirmModalText = document.getElementById('confirmModalText');
const modalDelayText = document.getElementById('modalDelayText');
const confirmExecuteBtn = document.getElementById('confirmExecuteBtn');
const cancelModalBtn = document.getElementById('cancelModalBtn');

if (cancelModalBtn) {
  cancelModalBtn.addEventListener('click', () => {
    confirmModal.style.display = 'none';
  });
}

if (confirmExecuteBtn) {
  confirmExecuteBtn.addEventListener('click', () => {
    confirmModal.style.display = 'none';
    executeRemoval();
  });
}

// Start Removal - Open In-App Confirmation Modal
startRemovalBtn.addEventListener('click', () => {
  const itemsToRemove = appState.matchedItems.filter((i) => i.selected);
  if (itemsToRemove.length === 0) {
    alert('يرجى تحديد عضو واحد على الأقل للحذف أولاً.');
    return;
  }

  const delaySeconds = parseInt(delaySecondsInput?.value) || 4;
  if (modalDelayText) modalDelayText.textContent = `${delaySeconds} ثوانٍ`;
  if (confirmModalText) {
    confirmModalText.textContent = `أنت على وشك حذف ${itemsToRemove.length} عضو محدد من المجموعات. سيتم تطبيق فواصل أمان مدروسة لحماية حسابك من الحظر. هل أنت جاهز للبدء؟`;
  }

  confirmModal.style.display = 'flex';
});

// Actual Removal Execution
async function executeRemoval() {
  const itemsToRemove = appState.matchedItems.filter((i) => i.selected);
  if (itemsToRemove.length === 0) return;

  const delaySeconds = parseInt(delaySecondsInput?.value) || 4;
  const batchPauseCount = parseInt(batchPauseCountInput?.value) || 25;

  startRemovalBtn.style.display = 'none';
  pauseRemovalBtn.style.display = 'inline-flex';
  stopRemovalBtn.style.display = 'inline-flex';
  progressBox.style.display = 'block';

  appState.activeRemoval = true;
  appState.isPaused = false;

  addTerminalLog(`⏳ جاري إرسال أمر الحذف لـ ${itemsToRemove.length} عضو إلى الخادم...`, 'info');

  try {
    const res = await fetch('/api/start-removal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        itemsToRemove,
        delaySeconds,
        batchPauseCount
      })
    });

    const data = await res.json();
    if (!data.success) {
      addTerminalLog(`❌ فشل بدء الحذف: ${data.error}`, 'error');
      alert('خطأ: ' + data.error);
      resetRemovalControlsUI();
    } else {
      addTerminalLog(`🚀 تم استقبال الطلب بنجاح، جاري حذف الأعضاء بالتتابع...`, 'success');
    }
  } catch (err) {
    addTerminalLog(`❌ خطأ في الاتصال: ${err.message}`, 'error');
    alert('فشل في بدء عملية الحذف: ' + err.message);
    resetRemovalControlsUI();
  }
}

// Pause / Resume / Stop
pauseRemovalBtn.addEventListener('click', () => {
  socket.emit('pause_removal');
  pauseRemovalBtn.style.display = 'none';
  resumeRemovalBtn.style.display = 'inline-flex';
});

resumeRemovalBtn.addEventListener('click', () => {
  socket.emit('resume_removal');
  resumeRemovalBtn.style.display = 'none';
  pauseRemovalBtn.style.display = 'inline-flex';
});

stopRemovalBtn.addEventListener('click', () => {
  if (confirm('هل تريد إيقاف عملية الحذف كلياً؟ لن يتم التراجع عمن تم حذفهم بالفعل.')) {
    socket.emit('stop_removal');
    resetRemovalControlsUI();
  }
});

function resetRemovalControlsUI() {
  startRemovalBtn.style.display = 'inline-flex';
  pauseRemovalBtn.style.display = 'none';
  resumeRemovalBtn.style.display = 'none';
  stopRemovalBtn.style.display = 'none';
  appState.activeRemoval = false;
}

function updateProgressUI(data) {
  progressPercentage.textContent = `${data.percentage}%`;
  progressBarFill.style.width = `${data.percentage}%`;
  progressSuccessCount.textContent = data.successful;
  progressFailedCount.textContent = data.failed;
  progressRemainingCount.textContent = data.remaining;
  progressStatusText.textContent = `جاري الحذف (${data.processed}/${data.total})...`;
}

function finishRemovalUI(data) {
  resetRemovalControlsUI();
  progressStatusText.textContent = 'اكتملت العملية بنجاح!';
  exportReportBtn.style.display = 'inline-flex';
}

exportReportBtn.addEventListener('click', () => {
  window.open('/api/export-results', '_blank');
});

// Terminal Logs
function addTerminalLog(msg, type = 'info') {
  const line = document.createElement('div');
  line.className = `log-line ${type}`;
  const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false });
  line.textContent = `[${timestamp}] ${msg}`;
  terminalLogs.appendChild(line);
  terminalLogs.scrollTop = terminalLogs.scrollHeight;
}

clearLogsBtn.addEventListener('click', () => {
  terminalLogs.innerHTML = '';
});

// Helper
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
