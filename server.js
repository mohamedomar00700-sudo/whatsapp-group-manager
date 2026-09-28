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
  cors: { origin: '*' },
  maxHttpBufferSize: 5e6
});

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || __dirname;
const SESSIONS_DIR = path.join(DATA_DIR, 'auth_sessions');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');

// Max simultaneous active WhatsApp connections (protects server memory)
const MAX_ACTIVE_SESSIONS = parseInt(process.env.MAX_ACTIVE_SESSIONS || '25', 10);
// Close a WhatsApp connection after this many minutes with no open browser tab (unless a removal is running)
const IDLE_MINUTES = parseInt(process.env.IDLE_MINUTES || '20', 10);

for (const dir of [SESSIONS_DIR, UPLOADS_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
// Also serve the 3 frontend files if they sit next to server.js (flat upload, e.g. from a phone)
const FLAT_FILES = { '/': 'index.html', '/index.html': 'index.html', '/app.js': 'app.js', '/style.css': 'style.css' };
for (const [route, file] of Object.entries(FLAT_FILES)) {
  app.get(route, (req, res, next) => {
    const p = path.join(__dirname, file);
    fs.existsSync(p) ? res.sendFile(p) : next();
  });
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => cb(null, `sheet_${Date.now()}_${Math.random().toString(36).slice(2)}${path.extname(file.originalname || '').slice(0, 10)}`)
  }),
  limits: { fileSize: 20 * 1024 * 1024 }
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ============================================================
// Multi-user sessions: every browser gets its own WhatsApp link
// ============================================================
const SESSION_ID_RE = /^[a-zA-Z0-9-]{16,64}$/;
const sessions = new Map();

function isValidSessionId(id) {
  return typeof id === 'string' && SESSION_ID_RE.test(id);
}

function newTaskState() {
  return { isRunning: false, isPaused: false, isStopped: false, total: 0, processed: 0, successful: 0, failed: 0, results: [] };
}

function getSession(id) {
  let s = sessions.get(id);
  if (!s) {
    s = {
      id,
      sock: null,
      status: 'disconnected',
      qr: null,
      user: null,
      task: newTaskState(),
      groups: [],
      clients: 0,
      lastSeen: Date.now(),
      initializing: false,
      closedByServer: false
    };
    sessions.set(id, s);
  }
  return s;
}

function activeSocketCount() {
  let n = 0;
  for (const s of sessions.values()) if (s.sock) n++;
  return n;
}

function emitTo(s, event, data) {
  io.to(s.id).emit(event, data);
}

function userPayload(user) {
  if (!user) return null;
  return {
    id: user.id,
    name: user.name || user.notify || 'حساب واتساب',
    phone: user.id.split(':')[0].split('@')[0]
  };
}

function closeSock(s) {
  if (s.sock) {
    s.closedByServer = true;
    try { s.sock.ev.removeAllListeners(); } catch (e) {}
    try { s.sock.end(undefined); } catch (e) {}
    s.sock = null;
  }
}

async function initWhatsApp(s) {
  if (s.initializing) return;
  if (!s.sock && activeSocketCount() >= MAX_ACTIVE_SESSIONS) {
    emitTo(s, 'status', { status: 'disconnected', message: 'السيرفر مشغول حالياً بعدد كبير من المستخدمين، حاول بعد قليل' });
    return;
  }
  s.initializing = true;
  closeSock(s);
  s.closedByServer = false;

  try {
    const { state, saveCreds } = await useMultiFileAuthState(path.join(SESSIONS_DIR, s.id));
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
      auth: state,
      browser: ['WA Group Manager', 'Chrome', '1.0.0'],
      syncFullHistory: false,
      markOnlineOnConnect: false
    });
    s.sock = sock;
    s.status = 'connecting';

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      if (s.sock !== sock) return; // stale socket
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        s.qr = qr;
        s.status = 'connecting';
        try {
          emitTo(s, 'qr', await QRCode.toDataURL(qr, { scale: 8, margin: 1 }));
          emitTo(s, 'status', { status: 'connecting', message: 'امسح رمز QR للاتصال' });
        } catch (err) {
          console.error('[QR] Error generating QR:', err);
        }
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const loggedOut = statusCode === DisconnectReason.loggedOut;
        s.sock = null;
        s.status = 'disconnected';
        s.qr = null;
        s.user = null;

        if (s.closedByServer) return;

        emitTo(s, 'status', { status: 'disconnected', message: 'تم قطع الاتصال' });

        if (loggedOut) {
          fs.rmSync(path.join(SESSIONS_DIR, s.id), { recursive: true, force: true });
          emitTo(s, 'status', { status: 'logged_out', message: 'تم تسجيل الخروج من الهاتف' });
          if (s.clients > 0) setTimeout(() => initWhatsApp(s), 1500);
        } else if (s.clients > 0 || s.task.isRunning) {
          // Only reconnect while someone is using this session
          setTimeout(() => { if (!s.sock) initWhatsApp(s); }, 3000);
        }
      } else if (connection === 'open') {
        s.status = 'connected';
        s.qr = null;
        s.user = sock.user;
        console.log(`[Session ${s.id.slice(0, 8)}] connected`);
        emitTo(s, 'status', { status: 'connected', user: userPayload(sock.user) });
      }
    });
  } catch (err) {
    console.error('[Baileys] Init error:', err);
    s.sock = null;
    s.status = 'disconnected';
    emitTo(s, 'status', { status: 'disconnected', message: 'فشل في الاتصال' });
  } finally {
    s.initializing = false;
  }
}

// Idle cleanup: free memory for sessions nobody is using (auth files are kept,
// so the user reconnects without a new QR when they come back)
setInterval(() => {
  const now = Date.now();
  for (const s of sessions.values()) {
    const idle = s.clients === 0 && !s.task.isRunning && now - s.lastSeen > IDLE_MINUTES * 60 * 1000;
    if (idle) {
      closeSock(s);
      sessions.delete(s.id);
    }
  }
  // Delete uploaded sheets older than 2 hours
  try {
    for (const f of fs.readdirSync(UPLOADS_DIR)) {
      const p = path.join(UPLOADS_DIR, f);
      if (now - fs.statSync(p).mtimeMs > 2 * 60 * 60 * 1000) fs.rmSync(p, { force: true });
    }
  } catch (e) {}
}, 60 * 1000);

// ========================
// Socket.io
// ========================
io.on('connection', (socket) => {
  const sid = socket.handshake.auth?.sessionId;
  if (!isValidSessionId(sid)) {
    socket.emit('status', { status: 'disconnected', message: 'جلسة غير صالحة، أعد تحميل الصفحة' });
    socket.disconnect(true);
    return;
  }

  const s = getSession(sid);
  socket.join(sid);
  s.clients++;
  s.lastSeen = Date.now();

  if (s.status === 'connected' && s.user) {
    socket.emit('status', { status: 'connected', user: userPayload(s.user) });
  } else if (s.qr) {
    QRCode.toDataURL(s.qr, { scale: 8, margin: 1 }).then((url) => {
      socket.emit('qr', url);
      socket.emit('status', { status: 'connecting', message: 'امسح رمز QR للاتصال' });
    });
  } else {
    socket.emit('status', { status: s.status, message: 'جاري تهيئة الاتصال...' });
    if (!s.sock) initWhatsApp(s);
  }

  if (s.task.isRunning) {
    socket.emit('removal_progress', {
      total: s.task.total,
      processed: s.task.processed,
      successful: s.task.successful,
      failed: s.task.failed,
      remaining: s.task.total - s.task.processed,
      percentage: Math.round((s.task.processed / Math.max(s.task.total, 1)) * 100)
    });
  }

  socket.on('disconnect', () => {
    s.clients = Math.max(0, s.clients - 1);
    s.lastSeen = Date.now();
  });

  socket.on('reconnect_wa', () => {
    initWhatsApp(s);
  });

  socket.on('pause_removal', () => {
    if (s.task.isRunning) {
      s.task.isPaused = true;
      emitTo(s, 'removal_log', { type: 'warn', message: '⏸️ تم إيقاف عملية الحذف مؤقتاً بواسطة المستخدم' });
    }
  });

  socket.on('resume_removal', () => {
    if (s.task.isRunning && s.task.isPaused) {
      s.task.isPaused = false;
      emitTo(s, 'removal_log', { type: 'info', message: '▶️ تم استئناف عملية الحذف الآمن' });
    }
  });

  socket.on('stop_removal', () => {
    if (s.task.isRunning) {
      s.task.isStopped = true;
      emitTo(s, 'removal_log', { type: 'error', message: '🛑 تم إيقاف عملية الحذف كلياً بناءً على طلب المستخدم' });
    }
  });
});

// ========================
// Helpers
// ========================
function normalizePhoneNumber(rawPhone, defaultCountryCode = '20') {
  if (!rawPhone) return null;
  let digits = String(rawPhone).replace(/\D/g, '');
  if (!digits) return null;

  if (digits.startsWith('00')) digits = digits.substring(2);

  // Egyptian local format (01xxxxxxxxx -> 11 digits)
  if (digits.startsWith('01') && digits.length === 11) {
    digits = '20' + digits.substring(1);
  } else if (digits.startsWith('0') && defaultCountryCode) {
    digits = defaultCountryCode + digits.substring(1);
  } else if (digits.length <= 10 && defaultCountryCode) {
    digits = defaultCountryCode + digits;
  }
  return digits;
}

// Resolve an uploaded sheet path safely (only files inside the uploads folder)
function safeUploadPath(p) {
  if (!p || typeof p !== 'string') return null;
  const full = path.join(UPLOADS_DIR, path.basename(p));
  return fs.existsSync(full) ? full : null;
}

// Attach the caller's session to every /api request
function requireSession(req, res, next) {
  const sid = req.get('x-session-id') || req.query.sid;
  if (!isValidSessionId(sid)) {
    return res.status(400).json({ success: false, error: 'جلسة غير صالحة، أعد تحميل الصفحة' });
  }
  req.s = getSession(sid);
  req.s.lastSeen = Date.now();
  next();
}

// ========================
// API Routes
// ========================
app.get('/healthz', (req, res) => res.send('ok'));

app.use('/api', requireSession);

app.get('/api/status', (req, res) => {
  res.json({ connectionStatus: req.s.status, user: userPayload(req.s.user) });
});

app.post('/api/logout', async (req, res) => {
  const s = req.s;
  try {
    if (s.sock) {
      try { await s.sock.logout(); } catch (e) {}
    }
    closeSock(s);
    fs.rmSync(path.join(SESSIONS_DIR, s.id), { recursive: true, force: true });
    s.status = 'disconnected';
    s.user = null;
    s.qr = null;
    s.groups = [];
    setTimeout(() => initWhatsApp(s), 1500);
    res.json({ success: true, message: 'تم تسجيل الخروج بنجاح' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/upload-excel', upload.single('file'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'لم يتم اختيار ملف' });
    }
    const workbook = xlsx.readFile(req.file.path);
    const worksheet = workbook.Sheets[workbook.SheetNames[0]];
    const jsonData = xlsx.utils.sheet_to_json(worksheet, { defval: '' });

    if (!jsonData || jsonData.length === 0) {
      return res.status(400).json({ success: false, error: 'الملف فارغ أو لا يحتوي على صفوف بيانات' });
    }

    const columns = Object.keys(jsonData[0]);
    const detectedPhoneCol = columns.find(c => /phone|mobile|tel|رقم|موبايل|هاتف|تليفون|جوال/i.test(c)) || columns[0];
    const detectedNameCol = columns.find(c => /name|اسم|الاسم|عميل|طالب|عضو/i.test(c)) || (columns.length > 1 ? columns[1] : columns[0]);

    res.json({
      success: true,
      fileName: req.file.originalname,
      tempPath: path.basename(req.file.path),
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

app.post('/api/process-excel', (req, res) => {
  try {
    const { tempPath, phoneCol, nameCol, defaultCountryCode } = req.body;
    const filePath = safeUploadPath(tempPath);
    if (!filePath) {
      return res.status(400).json({ success: false, error: 'مسار الملف غير صالح أو تم حذفه، ارفع الملف مرة أخرى' });
    }

    const workbook = xlsx.readFile(filePath);
    const rawData = xlsx.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { defval: '' });

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

    res.json({ success: true, totalExtracted: processedList.length, items: processedList });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/groups', async (req, res) => {
  const s = req.s;
  try {
    if (s.status !== 'connected' || !s.sock) {
      return res.status(400).json({ success: false, error: 'واتساب غير متصل حالياً' });
    }
    const sock = s.sock;
    const myPhone = sock.user?.id ? sock.user.id.split('@')[0].split(':')[0] : '';
    const myLid = sock.user?.lid ? sock.user.lid.split('@')[0].split(':')[0] : '';

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
          return {
            id: p.id,
            jid: rawJid,
            phone: rawJid.split('@')[0].split(':')[0],
            isMe: isParticipantMe(p),
            isAdmin: p.admin === 'admin' || p.admin === 'superadmin'
          };
        })
      });
    }

    groupList.sort((a, b) => {
      if (a.isAdmin && !b.isAdmin) return -1;
      if (!a.isAdmin && b.isAdmin) return 1;
      return a.subject.localeCompare(b.subject);
    });

    s.groups = groupList;

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

app.post('/api/match-members', (req, res) => {
  try {
    const { targetGroupIds, excelRecords } = req.body;
    if (!targetGroupIds || targetGroupIds.length === 0) {
      return res.status(400).json({ success: false, error: 'لم يتم تحديد أي مجموعة' });
    }

    // Always use this user's own groups from the server (never trust client-sent group data)
    const selectedGroups = req.s.groups.filter(g => targetGroupIds.includes(g.id));
    if (selectedGroups.length === 0) {
      return res.status(400).json({ success: false, error: 'أعد تحميل قائمة الجروبات ثم حاول مرة أخرى' });
    }

    if (!excelRecords || excelRecords.length === 0) {
      const allDirectMembers = [];
      const protectedAdmins = [];

      for (const group of selectedGroups) {
        for (const p of group.participants) {
          if (p.isMe) {
            protectedAdmins.push({ name: 'حسابك الشخصي', phone: p.phone, groupId: group.id, groupName: group.subject, reason: 'حسابك الشخصي (محمي)' });
          } else if (p.isAdmin) {
            protectedAdmins.push({ name: 'مشرف في الجروب', phone: p.phone, groupId: group.id, groupName: group.subject, reason: 'مشرف في الجروب (محمي)' });
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
    const excelMap = new Map();
    excelRecords.forEach(rec => excelMap.set(rec.normalizedPhone, rec));
    const matchedPhonesSet = new Set();

    for (const group of selectedGroups) {
      for (const participant of group.participants) {
        const participantPhone = participant.phone;
        if (!excelMap.has(participantPhone)) continue;

        const excelRecord = excelMap.get(participantPhone);
        matchedPhonesSet.add(participantPhone);

        if (participant.isMe) {
          protectedAdmins.push({ name: excelRecord.name + ' (حسابك الشخصي)', phone: participantPhone, groupId: group.id, groupName: group.subject, reason: 'حسابك الشخصي (تم حمايته واستثناؤه تلقائياً)' });
        } else if (participant.isAdmin) {
          protectedAdmins.push({ name: excelRecord.name, phone: participantPhone, groupId: group.id, groupName: group.subject, reason: 'مشرف في المجموعة (تم حمايته واستثناؤه تلقائياً)' });
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

    excelRecords.forEach(rec => {
      if (!matchedPhonesSet.has(rec.normalizedPhone)) notFoundInGroups.push(rec);
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

app.post('/api/start-removal', async (req, res) => {
  const s = req.s;
  try {
    const { itemsToRemove } = req.body;
    const delaySeconds = Math.max(2, Number(req.body.delaySeconds) || 4);
    const batchPauseCount = Math.max(1, parseInt(req.body.batchPauseCount, 10) || 25);

    if (!itemsToRemove || itemsToRemove.length === 0) {
      return res.status(400).json({ success: false, error: 'لا يوجد أعضاء محددين للحذف' });
    }
    if (s.task.isRunning) {
      return res.status(400).json({ success: false, error: 'هناك عملية حذف جارية بالفعل' });
    }
    if (s.status !== 'connected' || !s.sock) {
      return res.status(400).json({ success: false, error: 'واتساب غير متصل' });
    }

    const task = newTaskState();
    task.isRunning = true;
    task.total = itemsToRemove.length;
    s.task = task;

    res.json({ success: true, message: 'تم بدء عملية الحذف بنجاح' });

    (async () => {
      emitTo(s, 'removal_log', { type: 'info', message: `🚀 بدء عملية الحذف لعدد ${itemsToRemove.length} عضو بفاصل زمني ${delaySeconds} ثوانٍ...` });

      for (let i = 0; i < itemsToRemove.length; i++) {
        if (task.isStopped) {
          emitTo(s, 'removal_log', { type: 'warn', message: '⏹️ توقفت العملية بالكامل.' });
          break;
        }
        while (task.isPaused && !task.isStopped) await sleep(1000);
        if (task.isStopped) break;

        // Wait for WhatsApp to reconnect if the link dropped mid-task
        let waited = 0;
        while ((!s.sock || s.status !== 'connected') && waited < 60 && !task.isStopped) {
          if (waited === 0) emitTo(s, 'removal_log', { type: 'warn', message: '⚠️ انقطع الاتصال بواتساب، جاري الانتظار لإعادة الاتصال...' });
          await sleep(1000);
          waited++;
        }

        const item = itemsToRemove[i];
        task.processed++;

        if (i > 0 && i % batchPauseCount === 0) {
          emitTo(s, 'removal_log', { type: 'warn', message: `🛡️ استراحة حماية مؤقتة لمدة 15 ثانية بعد إتمام دفعة من ${batchPauseCount} عضو...` });
          await sleep(15000);
        }

        try {
          const targetJid = (item.jid && item.jid.includes('@')) ? item.jid : `${item.phone}@s.whatsapp.net`;
          emitTo(s, 'removal_log', { type: 'info', message: `⏳ [${task.processed}/${task.total}] جاري حذف "${item.name}" (${item.phone}) من "${item.groupName}"...` });

          if (!s.sock) throw new Error('واتساب غير متصل');
          await s.sock.groupParticipantsUpdate(item.groupId, [targetJid], 'remove');

          task.successful++;
          task.results.push({ ...item, status: 'تم الحذف بنجاح', timestamp: new Date().toLocaleTimeString('ar-EG') });
          emitTo(s, 'removal_log', { type: 'success', message: `✅ تم بنجاح حذف "${item.name}" (${item.phone}) من "${item.groupName}".` });
        } catch (err) {
          task.failed++;
          task.results.push({ ...item, status: 'فشل: ' + (err.message || 'خطأ غير معروف'), timestamp: new Date().toLocaleTimeString('ar-EG') });
          emitTo(s, 'removal_log', { type: 'error', message: `❌ فشل حذف "${item.name}" (${item.phone}): ${err.message || 'خطأ'}` });
        }

        emitTo(s, 'removal_progress', {
          total: task.total,
          processed: task.processed,
          successful: task.successful,
          failed: task.failed,
          remaining: task.total - task.processed,
          percentage: Math.round((task.processed / task.total) * 100)
        });

        if (i < itemsToRemove.length - 1 && !task.isStopped) {
          const jitterMs = Math.floor(Math.random() * 2000) + 500;
          await sleep(delaySeconds * 1000 + jitterMs);
        }
      }

      task.isRunning = false;
      s.lastSeen = Date.now();
      emitTo(s, 'removal_log', { type: 'success', message: `🎉 اكتملت العملية! نجح: ${task.successful} | فشل: ${task.failed}` });
      emitTo(s, 'removal_completed', { total: task.total, successful: task.successful, failed: task.failed, results: task.results });
    })();
  } catch (err) {
    console.error('[Start Removal] Error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/export-results', (req, res) => {
  try {
    const ws = xlsx.utils.json_to_sheet(req.s.task.results);
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

server.listen(PORT, () => {
  console.log(`\n======================================================`);
  console.log(`🚀 خادم تطبيق مدير مجموعات واتساب يعمل بنجاح!`);
  console.log(`🌐 افتح الرابط التالي في متصفحك: http://localhost:${PORT}`);
  console.log(`======================================================\n`);
});
