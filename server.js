import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import multer from 'multer';
import xlsx from 'xlsx';
import QRCode from 'qrcode';
import pino from 'pino';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Baileys imports
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion
} from '@whiskeysockets/baileys';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

const PORT = process.env.PORT || 3000;
const AUTH_DIR = path.join(__dirname, 'auth_info_baileys');
const UPLOADS_DIR = path.join(__dirname, 'uploads');

if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// Configure express with 50mb limit to handle large group participant lists
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Server-side cache for groups to avoid large payloads across the wire
let cachedGroupsList = [];

// Multer storage for uploaded excel sheets
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => cb(null, `sheet_${Date.now()}_${file.originalname}`)
});
const upload = multer({ storage });

// State variables
let sock = null;
let connectionStatus = 'disconnected'; // 'connecting', 'connected', 'disconnected'
let currentQR = null;
let currentUser = null;

// Removal task state
let activeTask = {
  isRunning: false,
  isPaused: false,
  isStopped: false,
  total: 0,
  processed: 0,
  successful: 0,
  failed: 0,
  results: []
};

// Helper sleep with jitter
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Format phone number
function normalizePhoneNumber(rawPhone, defaultCountryCode = '20') {
  if (!rawPhone) return null;
  let digits = String(rawPhone).replace(/\D/g, '');
  if (!digits) return null;

  // Handle leading 00
  if (digits.startsWith('00')) {
    digits = digits.substring(2);
  }

  // Handle Egyptian local format (01xxxxxxxxx -> 11 digits)
  if (digits.startsWith('01') && digits.length === 11) {
    digits = '20' + digits.substring(1);
  } else if (digits.startsWith('0') && defaultCountryCode) {
    digits = defaultCountryCode + digits.substring(1);
  } else if (digits.length <= 10 && defaultCountryCode) {
    digits = defaultCountryCode + digits;
  }

  return digits;
}

// Initialize WhatsApp connection
async function initWhatsApp() {
  try {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`[Baileys] Using WA v${version.join('.')}, isLatest: ${isLatest}`);

    sock = makeWASocket({
      version,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
      auth: state,
      browser: ['WA Group Manager', 'Chrome', '1.0.0'],
      syncFullHistory: false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        currentQR = qr;
        connectionStatus = 'connecting';
        try {
          const qrDataUrl = await QRCode.toDataURL(qr, { scale: 8, margin: 1 });
          io.emit('qr', qrDataUrl);
          io.emit('status', { status: 'connecting', message: 'امسح رمز QR للاتصال' });
        } catch (err) {
          console.error('[QR] Error generating QR data URL:', err);
        }
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        console.log(`[Connection] Closed. Reason code: ${statusCode}. Reconnecting: ${shouldReconnect}`);
        
        connectionStatus = 'disconnected';
        currentQR = null;
        currentUser = null;
        io.emit('status', { status: 'disconnected', message: 'تم قطع الاتصال' });

        if (shouldReconnect) {
          setTimeout(() => initWhatsApp(), 3000);
        } else {
          // Logged out - clear session directory
          try {
            fs.rmSync(AUTH_DIR, { recursive: true, force: true });
          } catch (e) {
            console.error('[Auth] Error clearing auth dir:', e);
          }
          io.emit('status', { status: 'logged_out', message: 'تم تسجيل الخروج من الهاتف' });
        }
      } else if (connection === 'open') {
        connectionStatus = 'connected';
        currentQR = null;
        currentUser = sock.user;
        console.log('[Connection] WhatsApp connected as:', sock.user);
        io.emit('status', {
          status: 'connected',
          user: {
            id: sock.user.id,
            name: sock.user.name || sock.user.notify || 'حساب واتساب',
            phone: sock.user.id.split(':')[0]
          }
        });
      }
    });

  } catch (err) {
    console.error('[Baileys] Init error:', err);
    connectionStatus = 'disconnected';
    io.emit('status', { status: 'disconnected', message: 'فشل في الاتصال' });
  }
}

// Start WhatsApp on launch
initWhatsApp();

// Socket.io Events
io.on('connection', (socket) => {
  console.log('[Socket] Client connected:', socket.id);

  // Send current status immediately
  if (connectionStatus === 'connected' && currentUser) {
    socket.emit('status', {
      status: 'connected',
      user: {
        id: currentUser.id,
        name: currentUser.name || currentUser.notify || 'حساب واتساب',
        phone: currentUser.id.split(':')[0]
      }
    });
  } else if (currentQR) {
    QRCode.toDataURL(currentQR, { scale: 8, margin: 1 }).then((url) => {
      socket.emit('qr', url);
      socket.emit('status', { status: 'connecting', message: 'امسح رمز QR للاتصال' });
    });
  } else {
    socket.emit('status', { status: connectionStatus, message: 'جاري تهيئة الاتصال...' });
  }

  // Handle client request to reconnect/regenerate QR
  socket.on('reconnect_wa', () => {
    initWhatsApp();
  });

  // Handle pause/resume/stop removal
  socket.on('pause_removal', () => {
    if (activeTask.isRunning) {
      activeTask.isPaused = true;
      io.emit('removal_log', { type: 'warn', message: '⏸️ تم إيقاف عملية الحذف مؤقتاً بواسطة المستخدم' });
    }
  });

  socket.on('resume_removal', () => {
    if (activeTask.isRunning && activeTask.isPaused) {
      activeTask.isPaused = false;
      io.emit('removal_log', { type: 'info', message: '▶️ تم استئناف عملية الحذف الآمن' });
    }
  });

  socket.on('stop_removal', () => {
    if (activeTask.isRunning) {
      activeTask.isStopped = true;
      activeTask.isRunning = false;
      io.emit('removal_log', { type: 'error', message: '🛑 تم إيقاف عملية الحذف كلياً بناءً على طلب المستخدم' });
    }
  });
});

// API Routes

// 1. Status endpoint
app.get('/api/status', (req, res) => {
  res.json({
    connectionStatus,
    user: currentUser ? {
      id: currentUser.id,
      name: currentUser.name || currentUser.notify || 'حساب واتساب',
      phone: currentUser.id.split(':')[0]
    } : null
  });
});

// 2. Logout endpoint
app.post('/api/logout', async (req, res) => {
  try {
    if (sock) {
      await sock.logout();
    }
    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    connectionStatus = 'disconnected';
    currentUser = null;
    currentQR = null;
    setTimeout(() => initWhatsApp(), 1500);
    res.json({ success: true, message: 'تم تسجيل الخروج بنجاح' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 3. Upload & Parse Excel file
app.post('/api/upload-excel', upload.single('file'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'لم يتم اختيار ملف' });
    }

    const filePath = req.file.path;
    const workbook = xlsx.readFile(filePath);
    const firstSheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[firstSheetName];
    const jsonData = xlsx.utils.sheet_to_json(worksheet, { defval: '' });

    if (!jsonData || jsonData.length === 0) {
      return res.status(400).json({ success: false, error: 'الملف فارغ أو لا يحتوي على صفوف بيانات' });
    }

    // Get column names
    const columns = Object.keys(jsonData[0]);

    // Guess phone column & name column
    let detectedPhoneCol = columns.find(c =>
      /phone|mobile|tel|رقم|موبايل|هاتف|تليفون|جوال/i.test(c)
    ) || columns[0];

    let detectedNameCol = columns.find(c =>
      /name|اسم|الاسم|عميل|طالب|عضو/i.test(c)
    ) || (columns.length > 1 ? columns[1] : columns[0]);

    res.json({
      success: true,
      fileName: req.file.originalname,
      tempPath: filePath,
      totalRows: jsonData.length,
      columns,
      detectedPhoneCol,
      detectedNameCol,
      sampleRows: jsonData.slice(0, 10)
    });
  } catch (err) {
    console.error('[Excel Upload] Error:', err);
    res.status(500).json({ success: false, error: 'حدث خطأ أثناء قراءة ملف الإكسيل: ' + err.message });
  }
});

// 4. Process Excel with selected columns
app.post('/api/process-excel', (req, res) => {
  try {
    const { tempPath, phoneCol, nameCol, defaultCountryCode } = req.body;
    if (!tempPath || !fs.existsSync(tempPath)) {
      return res.status(400).json({ success: false, error: 'مسار الملف غير صالح أو تم حذفه' });
    }

    const workbook = xlsx.readFile(tempPath);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rawData = xlsx.utils.sheet_to_json(sheet, { defval: '' });

    const processedList = [];
    const seenPhones = new Set();

    for (let i = 0; i < rawData.length; i++) {
      const row = rawData[i];
      const rawPhone = row[phoneCol];
      const name = nameCol && row[nameCol] ? String(row[nameCol]).trim() : `عضو #${i + 1}`;
      const normalizedPhone = normalizePhoneNumber(rawPhone, defaultCountryCode || '20');

      if (normalizedPhone && !seenPhones.has(normalizedPhone)) {
        seenPhones.add(normalizedPhone);
        processedList.push({
          rowNumber: i + 1,
          name,
          rawPhone: String(rawPhone || ''),
          normalizedPhone,
          jid: `${normalizedPhone}@s.whatsapp.net`
        });
      }
    }

    res.json({
      success: true,
      totalExtracted: processedList.length,
      items: processedList
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 5. Fetch all WhatsApp groups
app.get('/api/groups', async (req, res) => {
  try {
    if (connectionStatus !== 'connected' || !sock) {
      return res.status(400).json({ success: false, error: 'واتساب غير متصل حالياً' });
    }

    const myPhone = sock.user?.id ? sock.user.id.split('@')[0].split(':')[0] : '';
    const myLid = sock.user?.lid ? sock.user.lid.split('@')[0].split(':')[0] : '';
    console.log(`[Groups] Fetching all groups. My phone: ${myPhone}, My LID: ${myLid}`);

    function isParticipantMe(p) {
      if (!p) return false;
      if (p.jid) {
        const pPhone = p.jid.split('@')[0].split(':')[0];
        if (pPhone && myPhone && pPhone === myPhone) return true;
      }
      if (p.lid && myLid) {
        const pLid = p.lid.split('@')[0].split(':')[0];
        if (pLid && pLid === myLid) return true;
      }
      if (p.id) {
        const pId = p.id.split('@')[0].split(':')[0];
        if (pId && ((myPhone && pId === myPhone) || (myLid && pId === myLid))) return true;
      }
      return false;
    }

    const groupsData = await sock.groupFetchAllParticipating();
    const groupList = [];

    for (const [id, meta] of Object.entries(groupsData)) {
      const participants = meta.participants || [];
      const myParticipant = participants.find(isParticipantMe);
      const amIAdmin = myParticipant ? (myParticipant.admin === 'admin' || myParticipant.admin === 'superadmin') : false;

      groupList.push({
        id,
        subject: meta.subject || 'مجموعة بدون اسم',
        desc: meta.desc || '',
        creation: meta.creation,
        participantsCount: participants.length,
        isAdmin: amIAdmin,
        participants: participants.map(p => {
          const rawJid = p.jid || p.id;
          const phone = rawJid.split('@')[0].split(':')[0];
          return {
            id: p.id,
            jid: rawJid,
            phone,
            isMe: isParticipantMe(p),
            isAdmin: p.admin === 'admin' || p.admin === 'superadmin'
          };
        })
      });
    }

    // Sort: Admin groups first, then alphabetically
    groupList.sort((a, b) => {
      if (a.isAdmin && !b.isAdmin) return -1;
      if (!a.isAdmin && b.isAdmin) return 1;
      return a.subject.localeCompare(b.subject);
    });

    // Cache groups in memory
    cachedGroupsList = groupList;

    res.json({
      success: true,
      totalGroups: groupList.length,
      adminGroupsCount: groupList.filter(g => g.isAdmin).length,
      groups: groupList
    });
  } catch (err) {
    console.error('[Groups] Error fetching groups:', err);
    res.status(500).json({ success: false, error: 'حدث خطأ أثناء جلب الجروبات: ' + err.message });
  }
});

// 6. Match Excel/Custom records with Selected Groups
app.post('/api/match-members', (req, res) => {
  try {
    const { targetGroupIds, excelRecords, groupsData } = req.body;
    if (!targetGroupIds || targetGroupIds.length === 0) {
      return res.status(400).json({ success: false, error: 'لم يتم تحديد أي مجموعة' });
    }

    const groupsPool = (groupsData && groupsData.length > 0) ? groupsData : cachedGroupsList;
    const selectedGroups = groupsPool.filter(g => targetGroupIds.includes(g.id));

    // If no numbers provided, return all participants from selected groups so user can select directly
    if (!excelRecords || excelRecords.length === 0) {
      const allDirectMembers = [];
      const protectedAdmins = [];

      for (const group of selectedGroups) {
        for (const p of group.participants) {
          if (p.isMe) {
            protectedAdmins.push({
              name: 'حسابك الشخصي',
              phone: p.phone,
              groupId: group.id,
              groupName: group.subject,
              reason: 'حسابك الشخصي (محمي)'
            });
          } else if (p.isAdmin) {
            protectedAdmins.push({
              name: 'مشرف في الجروب',
              phone: p.phone,
              groupId: group.id,
              groupName: group.subject,
              reason: 'مشرف في الجروب (محمي)'
            });
          } else {
            allDirectMembers.push({
              excelRow: '-',
              name: `عضو (${p.phone})`,
              phone: p.phone,
              jid: p.jid || p.id,
              groupId: group.id,
              groupName: group.subject,
              selected: false
            });
          }
        }
      }

      return res.json({
        success: true,
        directSelectionMode: true,
        totalExcel: 0,
        selectedGroupsCount: selectedGroups.length,
        matchesCount: allDirectMembers.length,
        adminsProtectedCount: protectedAdmins.length,
        notFoundCount: 0,
        matchesToKick: allDirectMembers,
        protectedAdmins,
        notice: 'لم يتم تقديم قائمة أرقام، تم عرض جميع أعضاء المجموعات المحددة لتتمكن من تحديد من ترغب في حذفه يدوياً.'
      });
    }

    const matchesToKick = [];
    const protectedAdmins = [];
    const notFoundInGroups = [];

    // Map phone -> excel record
    const excelMap = new Map();
    excelRecords.forEach(rec => {
      excelMap.set(rec.normalizedPhone, rec);
    });

    const matchedPhonesSet = new Set();

    for (const group of selectedGroups) {
      for (const participant of group.participants) {
        const participantPhone = participant.phone;

        if (excelMap.has(participantPhone)) {
          const excelRecord = excelMap.get(participantPhone);
          matchedPhonesSet.add(participantPhone);

          if (participant.isMe) {
            protectedAdmins.push({
              name: excelRecord.name + ' (حسابك الشخصي)',
              phone: participantPhone,
              groupId: group.id,
              groupName: group.subject,
              reason: 'حسابك الشخصي (تم حمايته واستثناؤه تلقائياً)'
            });
          } else if (participant.isAdmin) {
            protectedAdmins.push({
              name: excelRecord.name,
              phone: participantPhone,
              groupId: group.id,
              groupName: group.subject,
              reason: 'مشرف في المجموعة (تم حمايته واستثناؤه تلقائياً)'
            });
          } else {
            matchesToKick.push({
              excelRow: excelRecord.rowNumber,
              name: excelRecord.name,
              phone: participantPhone,
              jid: participant.jid || participant.id,
              groupId: group.id,
              groupName: group.subject,
              selected: true
            });
          }
        }
      }
    }


    // Identify excel numbers not found in any selected group
    excelRecords.forEach(rec => {
      if (!matchedPhonesSet.has(rec.normalizedPhone)) {
        notFoundInGroups.push(rec);
      }
    });

    res.json({
      success: true,
      totalExcel: excelRecords.length,
      selectedGroupsCount: selectedGroups.length,
      matchesCount: matchesToKick.length,
      adminsProtectedCount: protectedAdmins.length,
      notFoundCount: notFoundInGroups.length,
      matchesToKick,
      protectedAdmins
    });
  } catch (err) {
    console.error('[Match] Error matching members:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 7. Start Bulk Removal
app.post('/api/start-removal', async (req, res) => {
  try {
    const { itemsToRemove, delaySeconds = 4, batchPauseCount = 25 } = req.body;

    if (!itemsToRemove || itemsToRemove.length === 0) {
      return res.status(400).json({ success: false, error: 'لا يوجد أعضاء محددين للحذف' });
    }

    if (activeTask.isRunning) {
      return res.status(400).json({ success: false, error: 'هناك عملية حذف جارية بالفعل' });
    }

    if (connectionStatus !== 'connected' || !sock) {
      return res.status(400).json({ success: false, error: 'واتساب غير متصل' });
    }

    // Initialize task
    activeTask = {
      isRunning: true,
      isPaused: false,
      isStopped: false,
      total: itemsToRemove.length,
      processed: 0,
      successful: 0,
      failed: 0,
      results: []
    };

    res.json({ success: true, message: 'تم بدء عملية الحذف بنجاح' });

    // Execute in background
    (async () => {
      io.emit('removal_log', {
        type: 'info',
        message: `🚀 بدء عملية الحذف لعدد ${itemsToRemove.length} عضو بفاصل زمني ${delaySeconds} ثوانٍ...`
      });

      for (let i = 0; i < itemsToRemove.length; i++) {
        // Check if stopped
        if (activeTask.isStopped) {
          io.emit('removal_log', { type: 'warn', message: '⏹️ توقفت العملية بالكامل.' });
          break;
        }

        // Check if paused
        while (activeTask.isPaused && !activeTask.isStopped) {
          await sleep(1000);
        }

        const item = itemsToRemove[i];
        activeTask.processed++;

        // Batch pause logic to prevent anti-spam trigger
        if (i > 0 && i % batchPauseCount === 0) {
          io.emit('removal_log', {
            type: 'warn',
            message: `🛡️ استراحة حماية مؤقتة لمدة 15 ثانية بعد إتمام دفعة من ${batchPauseCount} عضو...`
          });
          await sleep(15000);
        }

        try {
          const targetJid = (item.jid && item.jid.includes('@')) ? item.jid : `${item.phone}@s.whatsapp.net`;
          console.log(`[Removal Action] Removing ${targetJid} from ${item.groupId} (${item.groupName})`);

          io.emit('removal_log', {
            type: 'info',
            message: `⏳ [${activeTask.processed}/${activeTask.total}] جاري حذف "${item.name}" (${item.phone}) من "${item.groupName}"...`
          });

          await sock.groupParticipantsUpdate(item.groupId, [targetJid], 'remove');

          activeTask.successful++;
          const resultEntry = {
            ...item,
            status: 'تم الحذف بنجاح',
            timestamp: new Date().toLocaleTimeString('ar-EG')
          };
          activeTask.results.push(resultEntry);

          io.emit('removal_log', {
            type: 'success',
            message: `✅ تم بنجاح حذف "${item.name}" (${item.phone}) من "${item.groupName}".`
          });

        } catch (err) {
          activeTask.failed++;
          console.error(`[Removal Failed] ${item.phone}:`, err);
          const resultEntry = {
            ...item,
            status: 'فشل: ' + (err.message || 'خطأ غير معروف'),
            timestamp: new Date().toLocaleTimeString('ar-EG')
          };
          activeTask.results.push(resultEntry);

          io.emit('removal_log', {
            type: 'error',
            message: `❌ فشل حذف "${item.name}" (${item.phone}): ${err.message || 'خطأ'}`
          });
        }

        // Emit live progress
        const percentage = Math.round((activeTask.processed / activeTask.total) * 100);
        io.emit('removal_progress', {
          total: activeTask.total,
          processed: activeTask.processed,
          successful: activeTask.successful,
          failed: activeTask.failed,
          remaining: activeTask.total - activeTask.processed,
          percentage
        });

        // Safe delay with random jitter (delaySeconds + 0.5s to 2.5s jitter)
        if (i < itemsToRemove.length - 1 && !activeTask.isStopped) {
          const jitterMs = Math.floor(Math.random() * 2000) + 500;
          const waitTimeMs = (delaySeconds * 1000) + jitterMs;
          await sleep(waitTimeMs);
        }
      }

      activeTask.isRunning = false;
      io.emit('removal_log', {
        type: 'success',
        message: `🎉 اكتملت العملية! نجح: ${activeTask.successful} | فشل: ${activeTask.failed}`
      });
      io.emit('removal_completed', {
        total: activeTask.total,
        successful: activeTask.successful,
        failed: activeTask.failed,
        results: activeTask.results
      });
    })();

  } catch (err) {
    console.error('[Start Removal] Error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 8. Export Results
app.get('/api/export-results', (req, res) => {
  try {
    const ws = xlsx.utils.json_to_sheet(activeTask.results);
    const wb = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(wb, ws, 'نتائج الحذف');

    const buf = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', 'attachment; filename="removal_results.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Start Server
server.listen(PORT, () => {
  console.log(`\n======================================================`);
  console.log(`🚀 خادم تطبيق مدير مجموعات واتساب يعمل بنجاح!`);
  console.log(`🌐 افتح الرابط التالي في متصفحك: http://localhost:${PORT}`);
  console.log(`======================================================\n`);
});
