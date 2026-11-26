// MTGClownfish desktop app: starts the rules engine (the bridge, with its own Java) out of sight, shows the game
// in its own window, and stops the engine when the app quits.
//
// The game files sit in the app's resources under game/ (bridge jar, Forge's card data, the built client and a
// trimmed Java runtime; see scripts/package.sh). Running unpackaged (npm start), CLOWNFISH_GAME points at such
// a folder instead.
const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require('electron');
const { spawn, execFile } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const PAGE = 'http://127.0.0.1:7780/';
const BRIDGE_PORT = 7777;

let win = null;
let bridge = null;
let quitting = false;

function gameDir() {
  if (app.isPackaged) return path.join(process.resourcesPath, 'game');
  return process.env.CLOWNFISH_GAME ? path.resolve(process.env.CLOWNFISH_GAME) : null;
}

const logsDir = () => path.join(app.getPath('userData'), 'logs');

// the window's own preferences, kept between launches (fullscreen, for now)
const windowPrefsFile = () => path.join(app.getPath('userData'), 'window.json');
function windowPrefs() {
  try {
    return JSON.parse(fs.readFileSync(windowPrefsFile(), 'utf8'));
  } catch {
    return {};
  }
}
function saveWindowPrefs(prefs) {
  try {
    fs.writeFileSync(windowPrefsFile(), JSON.stringify({ ...windowPrefs(), ...prefs }));
  } catch {
    // not remembered: it still applies now
  }
}

ipcMain.on('fullscreen:set', (e, on) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (w) w.setFullScreen(!!on);
});
ipcMain.handle('fullscreen:get', (e) => !!BrowserWindow.fromWebContents(e.sender)?.isFullScreen());
const bridgeLog = () => path.join(app.getPath('userData'), 'engine.log');

/** Answers with any HTTP status: something is serving the game page. */
function pageUp() {
  return new Promise((resolve) => {
    const req = http.get(PAGE, (res) => {
      res.resume();
      resolve(true);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(1500, () => {
      req.destroy();
      resolve(false);
    });
  });
}

/** Whether something already listens on a local port (an older copy of the game still running). */
function portTaken(port) {
  return new Promise((resolve) => {
    const s = require('node:net').createServer();
    s.once('error', () => resolve(true));
    s.once('listening', () => s.close(() => resolve(false)));
    s.listen(port, '127.0.0.1');
  });
}

/** The logo for the splash, inlined (the splash is a data: page): the built client's, or the source in dev. */
function splashLogo() {
  const game = gameDir();
  const tries = [
    game && path.join(game, 'client', 'logo-360.webp'),
    path.join(__dirname, '..', 'client', 'public', 'logo-360.webp'),
  ];
  for (const file of tries) {
    try {
      if (file) return 'data:image/webp;base64,' + fs.readFileSync(file).toString('base64');
    } catch {}
  }
  return null;
}

function splash(text) {
  const logo = splashLogo();
  // The logo turns like a coin: two faces back to back, so its back half shows the right way round, and it
  // rests face on for a beat between turns. Reduced motion: a slow glow instead.
  const art = logo
    ? `<div class="coin"><img src="${logo}" alt=""><img class="back" src="${logo}" alt=""></div>`
    : '<div class="t">MTGClownfish</div>';
  const html = `<!doctype html><meta charset="utf-8"><title>MTGClownfish</title>
<style>
  html, body { margin: 0; height: 100%; background: #0b0b10; color: #e9dcc0; font: 16px/1.5 Georgia, serif; }
  body { display: grid; place-items: center; text-align: center;
    background: radial-gradient(ellipse at 50% 42%, #16202a 0%, #0b0b10 60%); }
  .stage { perspective: 900px; display: grid; place-items: center; }
  .coin { position: relative; width: 220px; height: 224px; transform-style: preserve-3d;
    animation: spin 2.4s cubic-bezier(.55,.05,.35,1) infinite; }
  .coin img { position: absolute; inset: 0; width: 100%; height: 100%; backface-visibility: hidden;
    filter: drop-shadow(0 10px 24px rgba(0,0,0,.6)); }
  .coin .back { transform: rotateY(180deg); }
  @keyframes spin { 0%, 25% { transform: rotateY(0) } 100% { transform: rotateY(360deg) } }
  .t { font-size: 28px; letter-spacing: 0.04em; color: #f3c56b; }
  .s { margin-top: 18px; opacity: 0.75; white-space: pre-line; }
  .dot { display: inline-block; animation: p 1.2s infinite; }
  .dot:nth-child(2) { animation-delay: .2s } .dot:nth-child(3) { animation-delay: .4s }
  @keyframes p { 0%, 100% { opacity: .2 } 50% { opacity: 1 } }
  @keyframes glow { 0%, 100% { opacity: .8 } 50% { opacity: 1 } }
  @media (prefers-reduced-motion: reduce) { .coin { animation: glow 2.4s ease-in-out infinite } }
</style>
<div><div class="stage">${art}</div><div class="s">${text}<span class="dot">.</span><span class="dot">.</span><span class="dot">.</span></div></div>`;
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
}

function fail(title, detail) {
  if (quitting) return;
  dialog.showMessageBoxSync(win ?? undefined, { type: 'error', title: 'MTGClownfish', message: title, detail });
  app.quit();
}

async function startBridge() {
  const game = gameDir();
  if (!game || !fs.existsSync(path.join(game, 'forge-bridge.jar'))) {
    return fail("The game's files are missing.", game ? `Looked in ${game}` : 'Set CLOWNFISH_GAME to a game folder to run unpackaged.');
  }
  if ((await portTaken(BRIDGE_PORT)) || (await portTaken(7780))) {
    return fail(
      'MTGClownfish seems to be running already.',
      'Another copy (or the older "Start MTGClownfish" launcher) is using the game\'s ports. Close it and open the app again.',
    );
  }
  const java = path.join(game, 'runtime', 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
  // a downloaded copy is marked quarantined on macOS, which can stop the bundled Java from starting
  if (process.platform === 'darwin') {
    await new Promise((r) => execFile('xattr', ['-dr', 'com.apple.quarantine', path.join(game, 'runtime')], () => r()));
  }
  fs.mkdirSync(logsDir(), { recursive: true });
  const prev = bridgeLog();
  try {
    if (fs.existsSync(prev)) fs.renameSync(prev, prev.replace(/\.log$/, '-previous.log'));
  } catch {
    // keep going without the previous log
  }
  const log = fs.createWriteStream(bridgeLog());
  bridge = spawn(
    java,
    [
      '-Xmx3g',
      `-Dforge.assets=${path.join(game, 'forge')}`,
      `-Dclient.dir=${path.join(game, 'client')}`,
      `-Dbridge.logs=${logsDir()}`,
      '-Dbridge.exitWithParent=true',
      '-jar',
      path.join(game, 'forge-bridge.jar'),
    ],
    // standard input stays open as a lifeline: the engine exits when it closes (this app quits or crashes)
    { cwd: app.getPath('userData'), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
  );
  bridge.stdout.pipe(log);
  bridge.stderr.pipe(log);
  bridge.on('error', (e) => fail("The game's engine couldn't start.", String(e)));
  bridge.on('exit', (code) => {
    bridge = null;
    if (!quitting) fail('The game\'s engine stopped unexpectedly.', `Exit code ${code}. Its log is at:\n${bridgeLog()}`);
  });
  // Forge loads its card database first (several seconds, longer on a first run)
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline && bridge) {
    if (await pageUp()) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  if (bridge) fail("The game's engine didn't start in time.", `Its log is at:\n${bridgeLog()}`);
  return false;
}

function stopBridge() {
  if (!bridge) return;
  try {
    bridge.stdin.end();
    bridge.kill();
  } catch {
    // already gone
  }
}

function buildMenu() {
  const mac = process.platform === 'darwin';
  const template = [
    ...(mac ? [{ role: 'appMenu' }] : []),
    { label: mac ? 'File' : 'Game', submenu: [mac ? { role: 'close' } : { role: 'quit' }] },
    // copy and paste (invite codes, deck lists, your API key) need the Edit menu's shortcuts
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [{ role: 'reload' }, { role: 'togglefullscreen' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'toggleDevTools' }],
    },
    {
      label: 'Help',
      submenu: [
        { label: 'Open Game Logs', click: () => shell.openPath(logsDir()) },
        { label: 'Open Engine Log', click: () => shell.openPath(bridgeLog()) },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function createWindow() {
  win = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#0b0b10',
    title: 'MTGClownfish',
    icon: path.join(__dirname, 'build', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    autoHideMenuBar: process.platform !== 'darwin',
    show: false,
    webPreferences: { contextIsolation: true, sandbox: true, autoplayPolicy: 'no-user-gesture-required', preload: path.join(__dirname, 'preload.js') },
  });
  win.once('ready-to-show', () => {
    win.show();
    if (windowPrefs().fullscreen) win.setFullScreen(true);
  });
  // fullscreen however it was reached (Settings, the View menu, the green button): remembered, and told to the page
  const fullscreenChanged = (on) => {
    saveWindowPrefs({ fullscreen: on });
    if (win && !win.isDestroyed()) win.webContents.send('fullscreen:changed', on);
  };
  win.on('enter-full-screen', () => fullscreenChanged(true));
  win.on('leave-full-screen', () => fullscreenChanged(false));
  win.on('closed', () => {
    win = null;
  });
  // links out of the game (Scryfall, the Claude console) open in the browser, not in the game window
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(PAGE) && !url.startsWith('data:')) {
      e.preventDefault();
      if (/^https?:/i.test(url)) shell.openExternal(url);
    }
  });
  await win.loadURL(splash('Shuffling up: starting the rules engine'));
  if (await startBridge()) await win.loadURL(PAGE);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app.whenReady().then(() => {
    buildMenu();
    createWindow();
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => {
    quitting = true;
    stopBridge();
  });
  app.on('will-quit', stopBridge);
}
