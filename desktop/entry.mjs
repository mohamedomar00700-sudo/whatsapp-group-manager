// Desktop launcher: runs the app locally on this computer and opens the browser.
import fs from 'fs';
import os from 'os';
import path from 'path';
import net from 'net';
import http from 'http';
import { exec } from 'child_process';

const APP_NAME = 'WhatsApp Group Manager';
const BASE_PORT = 3717;
const WEB_FILES = ['index.html', 'app.js', 'style.css', 'socket.io.js'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function openBrowser(url) {
  const cmd = process.platform === 'win32'
    ? `start "" "${url}"`
    : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd, () => {});
}

function isOurApp(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/healthz', timeout: 1500 }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve(body.trim() === 'ok'));
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function isFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

async function loadSea() {
  try {
    const m = await import('node:sea');
    const sea = m.default || m;
    return sea.isSea && sea.isSea() ? sea : null;
  } catch (e) {
    return null;
  }
}

// Write the web page files (embedded inside the .exe) to the data folder
async function writeWebFiles(publicDir) {
  const sea = await loadSea();
  const read = sea
    ? (f) => Buffer.from(sea.getAsset(f))
    : (f) => fs.readFileSync(f === 'socket.io.js'
        ? path.join(process.cwd(), 'node_modules/socket.io/client-dist/socket.io.min.js')
        : path.join(process.cwd(), 'public', f));

  for (const f of WEB_FILES) {
    let data = read(f);
    if (f === 'index.html') {
      data = Buffer.from(data.toString('utf8').replace('/socket.io/socket.io.js', '/socket.io.js'));
    }
    fs.writeFileSync(path.join(publicDir, f), data);
  }
}

async function main() {
  const dataDir = path.join(process.env.APPDATA || path.join(os.homedir(), '.config'), 'WhatsAppGroupManager');
  const publicDir = path.join(dataDir, 'public');
  fs.mkdirSync(publicDir, { recursive: true });

  // Already running? (user double-clicked again) -> just open the browser
  for (let p = BASE_PORT; p < BASE_PORT + 20; p++) {
    if (await isOurApp(p)) {
      console.log(`${APP_NAME} is already running. Opening browser...`);
      openBrowser(`http://localhost:${p}`);
      await sleep(1500);
      process.exit(0);
    }
  }

  let port = null;
  for (let p = BASE_PORT; p < BASE_PORT + 20; p++) {
    if (await isFree(p)) { port = p; break; }
  }
  if (!port) {
    console.log('Could not find a free port. Close other programs and try again.');
    await sleep(15000);
    process.exit(1);
  }

  await writeWebFiles(publicDir);

  process.env.DESKTOP = '1';
  process.env.PORT = String(port);
  process.env.HOST = '127.0.0.1';
  process.env.DATA_DIR = dataDir;
  process.env.PUBLIC_DIR = publicDir;
  process.env.MAX_ACTIVE_SESSIONS = process.env.MAX_ACTIVE_SESSIONS || '3';
  process.env.IDLE_MINUTES = process.env.IDLE_MINUTES || '600';

  console.log('==================================================');
  console.log(`  ${APP_NAME}`);
  console.log('==================================================');
  console.log(`  Running at: http://localhost:${port}`);
  console.log('  Keep this window open while using the app.');
  console.log('  Close this window to stop the app.');
  console.log('==================================================');

  await import('../server.js');

  for (let i = 0; i < 40; i++) {
    if (await isOurApp(port)) { openBrowser(`http://localhost:${port}`); break; }
    await sleep(250);
  }
}

main().catch(async (err) => {
  console.error('Error:', err);
  await sleep(30000);
  process.exit(1);
});
