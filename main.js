// F1 Telemetry desktop app (Electron). Starts server.js in a separate process and shows the dashboard in a window.
// Development:  npm start            (live from the game)
//               npm run start:demo   (fake data)
// Build:        npm run dist         (Windows installer + portable .exe in dist\)
const { app, BrowserWindow, Menu, dialog, shell, screen, utilityProcess } = require('electron');
const path = require('path'), fs = require('fs'), net = require('net'), dgram = require('dgram');

const DEMO = process.argv.includes('--demo');
app.setName('F1 Telemetry');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required'); // the engineer can talk without a click

// ---- Single instance: a second launch focuses the window that is already open ----
if (!app.requestSingleInstanceLock()) { app.quit(); return; }
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });

// ---- Settings (window state, ports, data folder) in %APPDATA%\F1 Telemetry\settings.json ----
const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json');
const DEFAULTS = { httpPort: 3000, udpPort: 20777, dataDir: '', bounds: null, maximized: false, alwaysOnTop: false, overlay: false, firstRunDone: false };
let settings = { ...DEFAULTS };
try { settings = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) }; } catch (e) {}
const save = () => { try { fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true }); fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2)); } catch (e) {} };
const cliPort = name => { const i = process.argv.indexOf('--' + name); return i > 0 ? +process.argv[i + 1] || null : null; };
const ports = () => ({ http: cliPort('http-port') || settings.httpPort, udp: cliPort('udp-port') || settings.udpPort });
// Data (laps.csv, traces, TTS cache): Documents\F1Telemetry unless settings.json says otherwise
const dataDir = () => settings.dataDir || path.join(app.getPath('documents'), 'F1Telemetry');
// Piper (local voice): bundled next to the app in resources\piper when packaged, the project's piper\ folder in development
const piperDir = () => app.isPackaged ? path.join(process.resourcesPath, 'piper') : path.join(__dirname, 'piper');

// ---- The telemetry server runs in its own process (Electron utilityProcess) ----
// Why a separate process rather than require('./server.js') here: server.js stays exactly the program you run with
// `node server.js`; a crash or a blocked port in it cannot take the window down; quitting can always end it (kill as a
// last resort); and the 30 updates/s of UDP parsing and JSON work never compete with the window's main process.
let server = null, serverInfo = null, quitting = false, win = null;
const logFile = () => path.join(dataDir(), 'server.log');
function startServer() {
  return new Promise(resolve => {
    const p = ports(), dir = dataDir();
    fs.mkdirSync(dir, { recursive: true });
    const log = fs.createWriteStream(logFile(), { flags: 'w' });
    const child = utilityProcess.fork(path.join(__dirname, 'server.js'), DEMO ? ['--demo'] : [], {
      serviceName: 'F1 Telemetry server', stdio: 'pipe',
      env: { ...process.env, F1T_HTTP_PORT: String(p.http), F1T_UDP_PORT: String(p.udp), F1T_DATA_DIR: dir, F1T_PIPER_DIR: piperDir() },
    });
    server = child; let settled = false, started = false;
    const done = r => { if (!settled) { settled = true; started = r.ok; resolve(r); } };
    for (const s of [child.stdout, child.stderr]) if (s) s.on('data', d => { log.write(d); process.stdout.write(d); });
    child.on('message', m => {
      if (m && m.type === 'ready') { serverInfo = m; done({ ok: true }); }
      if (m && m.type === 'error') done({ ok: false, ...m });
    });
    child.on('exit', code => {
      log.end(); const current = server === child; if (current) server = null;
      if (!settled) return done({ ok: false, code: 'EXIT', message: `The telemetry server stopped during start-up (exit code ${code}). See ${logFile()}` });
      if (started && current && !quitting) serverDied(code); // a start-up failure is handled by boot() instead
    });
  });
}
function stopServer() {
  return new Promise(resolve => {
    const child = server; if (!child) return resolve();
    const t = setTimeout(() => { try { child.kill(); } catch (e) {} resolve(); }, 1500); // last resort
    child.once('exit', () => { clearTimeout(t); resolve(); });
    try { child.postMessage({ type: 'quit' }); } catch (e) { child.kill(); }
  });
}
async function serverDied(code) {
  const r = await dialog.showMessageBox(win, { type: 'error', title: 'F1 Telemetry', buttons: ['Restart server', 'Quit'], defaultId: 0,
    message: 'The telemetry server stopped unexpectedly.', detail: `Exit code ${code}. Details are in ${logFile()}` });
  if (r.response === 1) return app.quit();
  if (!(await boot())) return app.quit();
  if (win) win.loadURL(url()); else createWindow();
}

// Find a free TCP port for the dashboard, starting after `from`
const tcpFree = port => new Promise(r => { const s = net.createServer().once('error', () => r(false)).once('listening', () => s.close(() => r(true))).listen(port); });
const udpFree = port => new Promise(r => { const s = dgram.createSocket('udp4').once('error', () => { s.close(); r(false); }).once('listening', () => s.close(() => r(true))); s.bind(port); });
async function nextFree(from, test) { for (let p = from + 1; p < from + 200; p++) if (await test(p)) return p; return null; }

// Start the server, explaining port problems with a dialog. Returns true when it is running.
async function boot() {
  for (;;) {
    const r = await startServer();
    if (r.ok) return true;
    const p = ports();
    if (r.which === 'http' && r.code === 'EADDRINUSE') {
      const alt = await nextFree(p.http, tcpFree);
      const a = await dialog.showMessageBox({ type: 'warning', title: 'F1 Telemetry: port in use', buttons: alt ? [`Use port ${alt}`, 'Try again', 'Quit'] : ['Try again', 'Quit'], defaultId: 0, cancelId: alt ? 2 : 1,
        message: `The dashboard port ${p.http} is already used by another program.`,
        detail: 'This is the local web port the app uses internally (it does not affect the game). Another copy of the dashboard (node server.js) or another local web app may be using it.' +
          (alt ? `\n\nPort ${alt} is free. Use it from now on? (You can change it later in settings.json.)` : '') });
      const choice = alt ? ['use', 'retry', 'quit'][a.response] : ['retry', 'quit'][a.response];
      if (choice === 'quit') return false;
      if (choice === 'use') { settings.httpPort = alt; save(); }
      continue;
    }
    if (r.which === 'udp' && r.code === 'EADDRINUSE') {
      const alt = await nextFree(p.udp, udpFree);
      const a = await dialog.showMessageBox({ type: 'warning', title: 'F1 Telemetry: telemetry port in use', buttons: alt ? ['Try again', `Use UDP port ${alt}`, 'Quit'] : ['Try again', 'Quit'], defaultId: 0, cancelId: alt ? 2 : 1,
        message: `UDP port ${p.udp} is already in use, so the game's telemetry can't be received.`,
        detail: 'Another telemetry program (for example SimHub, Crew Chief or a second copy of this dashboard) is listening on it. Close that program and choose Try again.' +
          (alt ? `\n\nOr use UDP port ${alt} instead, and then set the same port in F1 25: Settings > Telemetry Settings > UDP Port (and keep the other program on ${p.udp}). Many programs can also forward telemetry to a second port.` : '') });
      const choice = alt ? ['retry', 'use', 'quit'][a.response] : ['retry', 'quit'][a.response];
      if (choice === 'quit') return false;
      if (choice === 'use') { settings.udpPort = alt; save(); }
      continue;
    }
    const a = await dialog.showMessageBox({ type: 'error', title: 'F1 Telemetry', buttons: ['Try again', 'Open log', 'Quit'], defaultId: 0, cancelId: 2,
      message: 'The telemetry server could not start.', detail: r.message || 'Unknown error.' });
    if (a.response === 1) shell.openPath(logFile());
    if (a.response !== 0) return false;
  }
}
const url = () => `http://127.0.0.1:${serverInfo.httpPort}/`;

// ---- Window ----
function visibleBounds(b) { // ignore saved bounds that are off every screen (e.g. a monitor was unplugged)
  if (!b) return null;
  return screen.getAllDisplays().some(d => { const w = d.workArea; return b.x < w.x + w.width - 50 && b.x + b.width > w.x + 50 && b.y >= w.y - 10 && b.y < w.y + w.height - 50; }) ? b : null;
}
function rememberBounds() {
  if (!win || win.isDestroyed() || win.isFullScreen()) return;
  settings.maximized = win.isMaximized();
  if (!settings.maximized && !win.isMinimized()) settings.bounds = win.getBounds();
  save();
}
// Overlay mode = borderless window. Electron can't remove a frame from an open window, so the window is re-created.
const OVERLAY_CSS = `header.top{-webkit-app-region:drag;cursor:move}
header.top button,header.top select,header.top input,header.top a,#engPanel{-webkit-app-region:no-drag;cursor:auto}`;
function createWindow() {
  const b = visibleBounds(settings.bounds);
  win = new BrowserWindow({
    title: DEMO ? 'F1 Telemetry (demo)' : 'F1 Telemetry', width: 1600, height: 900, minWidth: 800, minHeight: 500, ...(b || {}),
    frame: !settings.overlay, backgroundColor: '#0b0d10', show: false, alwaysOnTop: settings.alwaysOnTop, autoHideMenuBar: settings.overlay,
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, autoplayPolicy: 'no-user-gesture-required', backgroundThrottling: false },
  });
  if (settings.alwaysOnTop) win.setAlwaysOnTop(true, 'screen-saver'); // above full-screen windows too
  if (settings.maximized) win.maximize();
  win.once('ready-to-show', () => { win.show(); firstRun(); });
  win.webContents.on('did-finish-load', () => { if (settings.overlay) win.webContents.insertCSS(OVERLAY_CSS); });
  win.webContents.on('did-fail-load', (e, code, desc, u) => { if (!u.startsWith('http://127.0.0.1')) return; setTimeout(() => win && !win.isDestroyed() && win.loadURL(url()), 1000); }); // server still starting: retry
  win.webContents.setWindowOpenHandler(({ url: u }) => { if (/^https?:/.test(u)) shell.openExternal(u); return { action: 'deny' }; });
  win.webContents.on('before-input-event', (e, i) => { // shortcuts that must also work in overlay mode (no menu bar)
    if (i.type !== 'keyDown') return;
    const k = i.key.toLowerCase(), cs = i.control && i.shift;
    if (k === 'f11') { e.preventDefault(); toggleFullscreen(); }
    else if (cs && k === 't') { e.preventDefault(); toggleOnTop(); }
    else if (cs && k === 'o') { e.preventDefault(); toggleOverlay(); }
    else if (k === 'escape' && win.isFullScreen()) { e.preventDefault(); win.setFullScreen(false); }
  });
  let t; for (const ev of ['resize', 'move']) win.on(ev, () => { clearTimeout(t); t = setTimeout(rememberBounds, 400); });
  win.on('close', rememberBounds);
  const me = win; win.on('closed', () => { if (win === me) win = null; });
  win.loadURL(url());
}
function toggleFullscreen() { if (win) { win.setFullScreen(!win.isFullScreen()); buildMenu(); } }
function toggleOnTop() {
  settings.alwaysOnTop = !settings.alwaysOnTop; save();
  if (win) win.setAlwaysOnTop(settings.alwaysOnTop, 'screen-saver');
  buildMenu();
}
function toggleOverlay() {
  rememberBounds(); settings.overlay = !settings.overlay;
  if (settings.overlay && !settings.alwaysOnTop) settings.alwaysOnTop = true; // an overlay is meant to float over the game
  save();
  const old = win; win = null; createWindow(); if (old) { old.removeAllListeners('close'); old.destroy(); }
  buildMenu();
}

// ---- Menu ----
function buildMenu() {
  const isFs = !!(win && win.isFullScreen());
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'File', submenu: [
      { label: 'Open data folder', accelerator: 'CmdOrCtrl+Shift+D', click: () => { fs.mkdirSync(dataDir(), { recursive: true }); shell.openPath(dataDir()); } },
      { label: 'Open settings file', click: () => { save(); shell.openPath(SETTINGS_FILE); } },
      { label: 'Open server log', click: () => shell.openPath(logFile()) },
      { label: 'Open dashboard in browser', click: () => serverInfo && shell.openExternal(`http://localhost:${serverInfo.httpPort}/`) },
      { type: 'separator' },
      { label: 'Quit', accelerator: 'CmdOrCtrl+Q', click: () => app.quit() },
    ] },
    { label: 'View', submenu: [
      { label: 'Fullscreen', type: 'checkbox', checked: isFs, accelerator: 'F11', click: toggleFullscreen },
      { label: 'Always on top', type: 'checkbox', checked: settings.alwaysOnTop, accelerator: 'CmdOrCtrl+Shift+T', click: toggleOnTop },
      { label: 'Overlay mode (borderless)', type: 'checkbox', checked: settings.overlay, accelerator: 'CmdOrCtrl+Shift+O', click: toggleOverlay },
      { type: 'separator' },
      { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => win && win.webContents.reload() },
      { label: 'Developer tools', accelerator: 'CmdOrCtrl+Shift+I', click: () => win && win.webContents.toggleDevTools() },
      { type: 'separator' },
      { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
    ] },
    { label: 'Help', submenu: [
      { label: 'Game and firewall setup', click: () => firstRun(true) },
      { label: 'About', click: () => dialog.showMessageBox(win, { title: 'F1 Telemetry', message: `F1 Telemetry ${app.getVersion()}`,
        detail: `Dashboard port ${serverInfo ? serverInfo.httpPort : '?'}, telemetry UDP port ${serverInfo ? serverInfo.udpPort : '?'}${DEMO ? ' (demo data)' : ''}\nData folder: ${dataDir()}\nVoice engine folder: ${piperDir()}` }) },
    ] },
  ]));
}
function firstRun(force) {
  if (settings.firstRunDone && !force) return;
  const p = ports();
  dialog.showMessageBox(win, { type: 'info', title: 'F1 Telemetry: setup', buttons: ['OK'],
    message: 'Before your first session',
    detail: `1. In F1 25 open Settings > Telemetry Settings and set:\n    UDP Telemetry: On\n    UDP Broadcast Mode: Off\n    UDP IP Address: 127.0.0.1\n    UDP Port: ${p.udp}\n    UDP Send Rate: 30 Hz or 60 Hz\n    UDP Format: 2025\n\n` +
      '2. Windows Firewall may ask whether F1 Telemetry may communicate on networks. Allow it on Private networks, otherwise no telemetry arrives.\n\n' +
      `3. Lap times and traces are saved in ${dataDir()} (File > Open data folder).\n\nShortcuts: F11 fullscreen, Ctrl+Shift+T always on top, Ctrl+Shift+O overlay mode.` });
  settings.firstRunDone = true; save();
}

// ---- Life cycle ----
app.whenReady().then(async () => {
  if (!(await boot())) { quitting = true; return app.quit(); }
  buildMenu(); createWindow();
});
app.on('window-all-closed', () => app.quit());
app.on('before-quit', e => {
  if (!server) return;
  e.preventDefault(); quitting = true;
  stopServer().then(() => app.quit());
});
