// Главный процесс Twenty Words Studio.
// Интерфейс работает в песочнице и в сеть не ходит: все запросы к серверу
// делает этот процесс, а интерфейс вызывает только функции из preload.js.

const { app, BrowserWindow, ipcMain, session, shell, clipboard, Notification, Menu, safeStorage, dialog, screen } = require('electron');
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { StudioClient, normalizeServerUrl } = require('./client');
const { Tools, registerScheme } = require('./tools');
const { Runner, schemePrivileges } = require('./runner');
const { setupUpdater } = require('./updater');
const { Music, musicPrivileges } = require('./music');
const { Browser } = require('./browser');
const { Materials } = require('./materials');
const { Core } = require('./core');
const { RadioCatalog } = require('./radio');

const ROOT = path.join(__dirname, '..', '..');
const RENDERER = path.join(__dirname, '..', 'renderer', 'index.html');
const ICON = path.join(__dirname, '..', 'assets', 'icon.png');
const DEV = !app.isPackaged || process.argv.includes('--dev');

let win = null;
let client = null;
let tools = null;
let updater = null;
let runner = null;
let music = null;
let browser = null;
let materials = null;
let core = null;
let radio = null;
const MIN_SERVER = '0.9.3'; // сервер, который нужен этой версии приложения
const names = new Map(); // id -> имя, для текста уведомлений
const aiStreams = new Map(); // чат ассистента -> AbortController текущего ответа
let myId = 0;

// ---------- настройки и токен ----------

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

const config = readJson(path.join(ROOT, 'data', 'config.json'), {});
const THEME_IDS = ['auto', 'spring', 'summer', 'autumn', 'winter'];

// Дополнительные темы: assets/themes/themes.json + картинка фона рядом (id.webp).
// Цвета только #rrggbb и только из списка переменных ниже, так файл не может подмешать в страницу ничего лишнего.
const THEME_VARS = ['--bg', '--panel', '--panel-2', '--line', '--muted', '--accent', '--accent-ink', '--text'];
const THEME_FX = ['snow', 'leaves', 'petals', 'fireflies', 'dust', 'bubbles', 'deep', 'embers', 'rain', 'bokeh', 'none'];
function loadExtraThemes() {
  const dir = path.join(__dirname, '..', 'assets', 'themes');
  const j = readJson(path.join(dir, 'themes.json'), { themes: [] });
  const out = [];
  for (const t of Array.isArray(j.themes) ? j.themes : []) {
    if (!t || !/^[a-z0-9-]{1,40}$/.test(t.id || '') || THEME_IDS.includes(t.id) || out.some((x) => x.id === t.id)) continue;
    const vars = {};
    for (const k of THEME_VARS) if (/^#[0-9a-f]{6}$/i.test((t.vars || {})[k] || '')) vars[k] = t.vars[k];
    if (!vars['--bg'] || !vars['--accent']) continue;
    const bg = /^[a-z0-9-]{1,40}$/.test(t.bg || '') && fs.existsSync(path.join(dir, t.bg + '.webp')) ? t.bg : null;
    // Маленькая картинка для плитки в настройках: <bg>-thumb.webp, если есть.
    const thumb = bg && fs.existsSync(path.join(dir, bg + '-thumb.webp')) ? bg + '-thumb' : bg;
    out.push({ id: t.id, name: (typeof t.name === 'string' && t.name.slice(0, 40)) || t.id, vars, bg, thumb, fx: THEME_FX.includes(t.fx) ? t.fx : 'dust' });
  }
  return out;
}
const EXTRA_THEMES = loadExtraThemes();
THEME_IDS.push(...EXTRA_THEMES.map((t) => t.id));
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

// Настройки оформления, музыки и окон: ключ -> [проверка, значение по умолчанию].
const oneOf = (...v) => (x) => v.includes(x);
const isBool = (x) => typeof x === 'boolean';
const numIn = (lo, hi) => (x) => typeof x === 'number' && Number.isFinite(x) && x >= lo && x <= hi;
const LOOK = {
  bgImage: [isBool, true], // картинка сезона на фоне
  bgDim: [numIn(0, 90), 35], // затемнение картинки, %
  particles: [isBool, true], // сезонные частицы поверх картинки
  todayScreen: [isBool, true], // экран "Сегодня" при первом входе за день
  feedOpen: [isBool, true], // лента команды на главной развёрнута
  celebrate: [isBool, true], // короткий праздник при успехах
  coreMode: [oneOf('often', 'rare', 'off'), 'often'], // как часто появляется Юна
  yunaLook: [oneOf('a', 'b', 'c'), 'a'], // как выглядит Юна
  focusOrder: [(x) => Array.isArray(x) && x.length <= 8 && x.every((v) => typeof v === 'string' && /^[a-z]{1,20}$/.test(v)), []], // порядок блоков фокуса
  celebrated: [(x) => !!x && typeof x === 'object' && !Array.isArray(x) && JSON.stringify(x).length < 2000, {}], // что уже праздновали
  todayShown: [(x) => typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x), ''],
  motion: [oneOf('auto', 'all', 'soft', 'off'), 'auto'], // анимации; auto: по настройке Windows
  zoom: [oneOf(90, 100, 110, 125), 100],
  uiSounds: [isBool, true],
  musicAuto: [isBool, false], // включать музыку при запуске
  musicPauseMin: [isBool, true], // пауза, когда окно свёрнуто
  musicPauseWeb: [isBool, true], // пауза, пока во встроенном браузере играет звук
  musicVolume: [numIn(0, 1), 0.5],
  musicSource: [oneOf('studio', 'folder', 'radio', 'ambient'), 'studio'],
  musicFolder: [(x) => typeof x === 'string' && x.length < 1000, ''],
  musicRadio: [numIn(0, 49), 0],
  musicAmbient: [oneOf('rain', 'wind', 'ocean', 'fire', 'pink', 'brown'), 'rain'],
  editorsMode: [oneOf('window', 'maximized', 'fullscreen'), 'window'],
  linksInBrowser: [isBool, true], // ссылки из чата: во встроенном браузере или в системном
  gpuHigh: [isBool, true], // мощная видеокарта, если их две
  gpuAccel: [isBool, true], // аппаратное ускорение (выключать только при сбоях)
  // Камера и микрофон для инструментов: { grafika: { mic: 'allow', cam: 'deny' } }, решения человека
  toolPerms: [(x) => !!x && typeof x === 'object' && !Array.isArray(x) && Object.keys(x).length <= 40 &&
    Object.entries(x).every(([id, v]) => /^[a-z0-9-]{1,32}$/.test(id) && v && typeof v === 'object' &&
      Object.entries(v).every(([k, d]) => ['mic', 'cam'].includes(k) && ['allow', 'deny'].includes(d))), {}],
};
const cleanRadios = (v) =>
  (Array.isArray(v) ? v : [])
    .filter((r) => r && typeof r.url === 'string' && /^https?:\/\//i.test(r.url))
    .slice(0, 50)
    .map((r) => {
      const out = { name: String(r.name || '').slice(0, 60) || r.url.replace(/^https?:\/\//i, '').slice(0, 60), url: r.url.slice(0, 500) };
      if (typeof r.uuid === 'string' && /^[0-9a-f-]{36}$/.test(r.uuid)) out.uuid = r.uuid; // станция из каталога
      return out;
    });

function getSettings() {
  const s = readJson(settingsFile(), {});
  const out = {
    serverUrl: normalizeServerUrl(s.serverUrl) || normalizeServerUrl(config.serverUrl) || 'http://127.0.0.1:8787',
    notifications: s.notifications !== false,
    theme: THEME_IDS.includes(s.theme) ? s.theme : 'auto',
    musicRadios: cleanRadios(s.musicRadios),
  };
  for (const [k, [ok, def]] of Object.entries(LOOK)) out[k] = ok(s[k]) ? s[k] : def;
  return out;
}

function saveSettings(patch) {
  const next = { ...readJson(settingsFile(), {}), ...patch };
  writeJson(settingsFile(), next);
  return getSettings();
}

// Токен входа шифруется средствами Windows (DPAPI) через safeStorage:
// скопированный на другой компьютер файл расшифровать нельзя.
// Если шифрование недоступно, токен живёт только в памяти до закрытия программы.
const tokenFile = () => path.join(app.getPath('userData'), 'session.bin');
let memoryToken = null;
const tokenStore = {
  load() {
    if (!safeStorage.isEncryptionAvailable()) return memoryToken;
    try {
      return safeStorage.decryptString(fs.readFileSync(tokenFile()));
    } catch {
      return null;
    }
  },
  save(token) {
    memoryToken = token;
    if (!safeStorage.isEncryptionAvailable()) return;
    fs.mkdirSync(path.dirname(tokenFile()), { recursive: true });
    fs.writeFileSync(tokenFile(), safeStorage.encryptString(token), { mode: 0o600 });
  },
  clear() {
    memoryToken = null;
    try {
      fs.unlinkSync(tokenFile());
    } catch {
      /* файла нет */
    }
  },
};

// ---------- видеокарта ----------

// Значения на момент запуска: видеокарта и ускорение меняются только перезапуском.
let STARTUP = { gpuHigh: true, gpuAccel: true };

// Windows выбирает видеокарту для программы по записи в реестре пользователя (то же
// самое делает "Параметры, Дисплей, Графика"). 2: высокая производительность.
// Флаг Chromium force_high_performance_gpu просит о том же изнутри.
function setWindowsGpuPreference(high) {
  if (process.platform !== 'win32') return;
  const key = 'HKCU\\Software\\Microsoft\\DirectX\\UserGpuPreferences';
  const args = high
    ? ['add', key, '/v', process.execPath, '/t', 'REG_SZ', '/d', 'GpuPreference=2;', '/f']
    : ['delete', key, '/v', process.execPath, '/f'];
  execFile('reg', args, { windowsHide: true }, () => {});
}

function setupGpu() {
  const s = getSettings();
  STARTUP = { gpuHigh: s.gpuHigh, gpuAccel: s.gpuAccel };
  if (!s.gpuAccel) app.disableHardwareAcceleration();
  else if (s.gpuHigh) app.commandLine.appendSwitch('force_high_performance_gpu');
  if (s.gpuHigh) setWindowsGpuPreference(true);
}

// Какая видеокарта рисует окно: для строки в настройках.
async function gpuInfo() {
  const status = app.getGPUFeatureStatus();
  let name = '';
  try {
    const info = await app.getGPUInfo('complete');
    name = (info.auxAttributes && info.auxAttributes.glRenderer) || '';
    const m = /ANGLE \(([^,]+),\s*([^,(]+?)(?:\s+Direct3D|\s*\(|,|\))/.exec(name);
    if (m) name = m[2].trim();
    if (!name && info.gpuDevice) {
      const d = info.gpuDevice.find((x) => x.active) || info.gpuDevice[0];
      if (d) name = d.description || d.deviceString || '';
    }
  } catch {
    /* сведений нет */
  }
  return { name, accelerated: status.gpu_compositing === 'enabled' };
}

// ---------- окно ----------

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// Размер и положение окна запоминаются. Если монитор с сохранённым окном отключён,
// окно открывается на основном.
const winStateFile = () => path.join(app.getPath('userData'), 'window.json');
function loadWinState() {
  const st = readJson(winStateFile(), {});
  const b = st.bounds;
  if (!b || ![b.x, b.y, b.width, b.height].every(Number.isFinite)) return { width: 1240, height: 800, maximized: false };
  const area = screen.getDisplayMatching(b).workArea;
  const visible = b.x < area.x + area.width - 80 && b.x + b.width > area.x + 80 && b.y >= area.y - 10 && b.y < area.y + area.height - 60;
  return visible ? { ...b, maximized: !!st.maximized } : { width: b.width, height: b.height, maximized: !!st.maximized };
}
function saveWinState() {
  if (!win || win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return;
  writeJson(winStateFile(), { bounds: win.isMaximized() ? win.getNormalBounds() : win.getBounds(), maximized: win.isMaximized() });
}

// F11 во весь экран в любом окне студии.
function fullScreenKey(w) {
  w.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'F11' && !input.control && !input.alt) {
      e.preventDefault();
      w.setFullScreen(!w.isFullScreen());
    }
  });
}

// Как открывать редакторы и запуск проектов: окном, развёрнутыми или во весь экран.
function applyEditorsMode(w) {
  const mode = getSettings().editorsMode;
  if (mode === 'maximized') w.maximize();
  else if (mode === 'fullscreen') w.setFullScreen(true);
  fullScreenKey(w);
}

const TITLEBAR_H = 34;

function createWindow() {
  const st = loadWinState();
  win = new BrowserWindow({
    x: st.x,
    y: st.y,
    width: st.width,
    height: st.height,
    minWidth: 920,
    minHeight: 600,
    title: 'Twenty Words Studio',
    icon: ICON,
    backgroundColor: '#0f1012',
    autoHideMenuBar: true,
    // Своя полоса заголовка в цветах темы. Кнопки свернуть, развернуть, закрыть
    // рисует Windows поверх неё, поэтому работают привязка к краям и меню Win+Z.
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0b0c0e', symbolColor: '#e8e6e1', height: TITLEBAR_H },
    show: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: true,
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
    },
  });

  // Никаких переходов внутри окна. Ссылки из чата открываются во встроенном браузере
  // или в системном, по настройке.
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      if (getSettings().linksInBrowser && browser) browser.open(url);
      else shell.openExternal(url);
    }
    return { action: 'deny' };
  });
  win.webContents.on('before-input-event', (e, input) => {
    if (DEV && input.type === 'keyDown' && input.control && input.shift && input.key.toLowerCase() === 'i') {
      win.webContents.toggleDevTools();
    }
  });
  win.on('focus', () => win.flashFrame(false));
  win.once('ready-to-show', () => {
    if (st.maximized) win.maximize();
    win.show();
  });
  win.webContents.on('did-finish-load', () => win.webContents.setZoomFactor(getSettings().zoom / 100));
  fullScreenKey(win);
  let saveTimer = null;
  const saveSoon = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveWinState, 400);
  };
  win.on('resize', saveSoon);
  win.on('move', saveSoon);
  win.on('close', saveWinState);
  // Свёрнуто или нет: интерфейсу, чтобы ставить музыку и анимации на паузу.
  for (const ev of ['minimize', 'hide']) win.on(ev, () => send('win:state', { hidden: true }));
  for (const ev of ['restore', 'show']) win.on(ev, () => send('win:state', { hidden: false }));
  win.on('enter-full-screen', () => send('win:state', { full: true }));
  win.on('leave-full-screen', () => send('win:state', { full: false }));
  win.loadFile(RENDERER);
  win.on('closed', () => {
    win = null;
    // Окна инструментов без главного окна не живут.
    for (const w of BrowserWindow.getAllWindows()) w.close();
  });
}

// ---------- сервер ----------

function setupClient() {
  client = new StudioClient({
    fetchImpl: (...a) => fetch(...a),
    WebSocketImpl: WebSocket,
    tokenStore,
    serverUrl: getSettings().serverUrl,
    device: `Studio ${app.getVersion()} / ${os.hostname()}`,
  });
  client.on('status', (s) => send('chat:status', s));
  client.on('signedOut', () => send('auth:signedOut'));
  client.on('rulesRequired', () => send('rules:required'));
  client.on('event', (ev) => {
    if (ev.t === 'ready') {
      myId = ev.me.id;
      names.clear();
      for (const u of ev.users) names.set(u.id, u.name);
    } else if (ev.t === 'user') {
      names.set(ev.u.id, ev.u.name);
    } else if (ev.t === 'msg') {
      maybeNotify(ev.m);
    }
    send('chat:event', ev);
  });
}

let doNotDisturb = false; // режим фокуса в интерфейсе: без уведомлений о сообщениях

function maybeNotify(m) {
  if (m.user === myId || !getSettings().notifications || doNotDisturb) return;
  if (win && win.isFocused()) return;
  if (win) win.flashFrame(true);
  if (!Notification.isSupported()) return;
  const who = names.get(m.user) || 'Сообщение';
  const where = m.room === 'work' ? ' · Рабочая зона' : m.room === 'free' ? ' · Свободные темы' : m.room.startsWith('card:') ? ' · обсуждение темы' : '';
  const n = new Notification({ title: who + where, body: m.text.slice(0, 160), icon: ICON, silent: false });
  n.on('click', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    send('app:openRoom', m.room);
  });
  n.show();
}

// ---------- IPC ----------

const str = (v, max = 4000) => (typeof v === 'string' ? v.slice(0, max) : '');
const int = (v) => (Number.isSafeInteger(v) && v > 0 ? v : 0);
const ids = (v, max) => (Array.isArray(v) ? v.map(int).filter(Boolean).slice(0, max) : []);

// Ответ всегда { ok, data } или { ok: false, error }: интерфейс показывает понятный текст по коду ошибки.
function handle(channel, fn) {
  ipcMain.handle(channel, async (event, arg) => {
    // Только главное окно: у панели встроенного браузера свои каналы (browser.js).
    if (!win || event.sender !== win.webContents || !event.senderFrame || !event.senderFrame.url.startsWith('file://')) return { ok: false, error: 'forbidden' };
    try {
      return { ok: true, data: await fn(arg || {}) };
    } catch (err) {
      const out = { ok: false, error: err.code || err.message || 'error' };
      if (Number.isInteger(err.item)) out.item = err.item;
      return out;
    }
  });
}

function registerIpc() {
  handle('auth:state', () => ({ signedIn: client.signedIn, server: client.base }));
  handle('auth:login', async (a) => {
    const user = await client.login(str(a.login, 64), str(a.password, 256));
    client.connect();
    if (user && user.id) await core.onPassword(user.id, str(a.password, 256));
    return user;
  });
  handle('auth:register', async (a) => {
    const user = await client.register(str(a.code, 64), str(a.login, 64), str(a.name, 64), str(a.password, 256));
    client.connect();
    if (user && user.id) await core.onPassword(user.id, str(a.password, 256));
    return user;
  });
  handle('auth:logout', async () => {
    await client.logout();
    core.logout();
    return true;
  });

  // Отчёты, скриншоты, напоминания, реферальные ссылки
  const count = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : 0);
  const dayStr = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : '');
  const reportBody = (a) => ({
    note: str(a.note, 300),
    items: (Array.isArray(a.items) ? a.items : []).slice(0, 8).map((x) => ({
      kind: x.kind === 'period' ? 'period' : 'pub',
      platform: str(x.platform, 30),
      format: ['long', 'short', 'post'].includes(x.format) ? x.format : '',
      from: dayStr(x.from),
      day: dayStr(x.day),
      long: count(x.long),
      short: count(x.short),
      post: count(x.post),
      views: count(x.views),
      shot: int(x.shot),
      label: str(x.label, 200),
    })),
  });
  handle('team:stats', () => client.request('GET', '/api/team/stats'));
  handle('team:feed', () => client.request('GET', '/api/team/feed'));
  handle('reports:list', () => client.request('GET', '/api/reports'));
  handle('reports:add', (a) => client.request('POST', '/api/reports', reportBody(a)));
  handle('reports:edit', (a) => client.request('PUT', '/api/reports/' + need(a.id), reportBody(a)));
  handle('reports:delete', (a) => client.request('DELETE', '/api/reports/' + need(a.id)));
  handle('shots:upload', (a) => {
    const image = typeof a.image === 'string' && a.image.length <= 4_300_000 && /^[A-Za-z0-9+/=]+$/.test(a.image) ? a.image : '';
    if (!image) throw Object.assign(new Error('bad_image'), { code: 'bad_image' });
    return client.request('POST', '/api/shots', { image }, { timeout: 60000 });
  });
  handle('shots:get', async (a) => {
    const r = await client.fetchBytes('/api/shots/' + need(a.id));
    if (r.type !== 'image/webp') throw Object.assign(new Error('bad_image'), { code: 'bad_image' });
    return 'data:image/webp;base64,' + r.bytes.toString('base64');
  });
  handle('admin:reports', (a) => {
    const q = new URLSearchParams();
    if (['sent', 'ok', 'rejected', 'all'].includes(a.status)) q.set('status', a.status);
    if (int(a.user)) q.set('user', String(int(a.user)));
    if (/^\d{4}-\d{2}$/.test(a.month || '')) q.set('month', a.month);
    return client.request('GET', '/api/admin/reports?' + q.toString());
  });
  handle('admin:reportReview', (a) =>
    client.request('POST', '/api/admin/reports/' + need(a.id) + '/review', {
      ok: a.ok === true,
      note: str(a.note, 300),
      items: (Array.isArray(a.items) ? a.items : []).slice(0, 8).map((x) => ({ id: int(x.id), views: count(x.views), long: count(x.long), short: count(x.short), post: count(x.post) })),
    }),
  );
  handle('reminders:list', () => client.request('GET', '/api/reminders'));
  handle('reminders:add', (a) => client.request('POST', '/api/reminders', { day: dayStr(a.day), note: str(a.note, 120), every: Math.min(90, count(a.every)) }));
  handle('reminders:done', (a) => client.request('POST', '/api/reminders/' + need(a.id) + '/done'));
  handle('reminders:delete', (a) => client.request('DELETE', '/api/reminders/' + need(a.id)));
  handle('refs:mine', (a) => client.request('GET', '/api/refs' + (/^\d{4}-\d{2}$/.test(a.month || '') ? '?month=' + a.month : '')));
  handle('refs:link', () => client.base); // адрес сервера для ссылок
  handle('admin:refs', (a) => client.request('GET', '/api/admin/refs' + (/^\d{4}-\d{2}$/.test(a.month || '') ? '?month=' + a.month : '')));
  handle('admin:refTarget', (a) => {
    const body = { name: str(a.name, 40), slug: str(a.slug, 20), url: str(a.url, 300), active: a.active === true, pos: count(a.pos) };
    return a.id ? client.request('PUT', '/api/admin/refs/targets/' + need(a.id), body) : client.request('POST', '/api/admin/refs/targets', body);
  });
  handle('admin:refTargetDelete', (a) => client.request('DELETE', '/api/admin/refs/targets/' + need(a.id)));
  handle('admin:refOff', (a) => client.request('POST', '/api/admin/refs/off', { user: int(a.user), day: dayStr(a.day), off: a.off === true }));

  // Учёт (только основатель, сервер проверяет сам)
  const money = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const day = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : '');
  const month = (v) => (typeof v === 'string' && /^\d{4}-\d{2}$/.test(v) ? v : '');
  handle('acct:get', () => client.request('GET', '/api/admin/acct'));
  handle('acct:weights', (a) => {
    const w = {};
    for (const [k, v] of Object.entries(a.weights || {})) w[str(k, 40)] = k === 'payStart' ? day(v) : k === 'testMonths' ? Math.trunc(money(v)) : money(v);
    return client.request('PUT', '/api/admin/acct/weights', w);
  });
  handle('acct:addEvent', (a) =>
    client.request('POST', '/api/admin/acct/events', { user: int(a.user), day: day(a.day), type: str(a.type, 20), qty: money(a.qty), points: money(a.points), amount: money(a.amount), note: str(a.note, 200) }));
  handle('acct:deleteEvent', (a) => client.request('DELETE', '/api/admin/acct/events/' + need(a.id)));
  handle('acct:addPayment', (a) =>
    client.request('POST', '/api/admin/acct/payments', { user: int(a.user), day: day(a.day), amount: money(a.amount), purpose: str(a.purpose, 20), month: month(a.month), note: str(a.note, 200) }));
  handle('acct:deletePayment', (a) => client.request('DELETE', '/api/admin/acct/payments/' + need(a.id)));
  handle('acct:month', (a) => {
    const body = { income: money(a.income), expenses: money(a.expenses), note: str(a.note, 200) };
    if (typeof a.budgetAdd === 'number' && Number.isFinite(a.budgetAdd)) body.budgetAdd = a.budgetAdd;
    return client.request('PUT', '/api/admin/acct/months/' + (month(a.month) || 'x'), body);
  });
  handle('acct:close', (a) => client.request(a.open ? 'DELETE' : 'POST', '/api/admin/acct/months/' + (month(a.month) || 'x') + '/close'));
  handle('acct:member', (a) => client.request('PUT', '/api/admin/acct/members/' + need(a.id), { start: day(a.start), leftOn: day(a.leftOn) }));
  handle('acct:export', async () => {
    const r = await client.fetchBytes('/api/admin/acct/export.xlsx');
    const res = await dialog.showSaveDialog(win, {
      title: 'Сохранить учёт',
      defaultPath: path.join(app.getPath('documents'), 'uchet-' + new Date().toISOString().slice(0, 10) + '.xlsx'),
      filters: [{ name: 'Excel', extensions: ['xlsx'] }],
    });
    if (res.canceled || !res.filePath) return '';
    await fs.promises.writeFile(res.filePath, r.bytes);
    shell.showItemInFolder(res.filePath);
    return res.filePath;
  });

  // Правила команды
  handle('rules:get', () => client.request('GET', '/api/rules'));
  handle('rules:accept', (a) =>
    client.request('POST', '/api/rules/accept', { version: int(a.version), firstName: str(a.firstName, 100), lastName: str(a.lastName, 100), email: str(a.email, 160) }));
  handle('admin:rules', () => client.request('GET', '/api/admin/rules'));
  handle('admin:rulesDraft', (a) => client.request('PUT', '/api/admin/rules/draft', { body: str(a.body, 60000), changes: str(a.changes, 4000) }));
  handle('admin:rulesPublish', () => client.request('POST', '/api/admin/rules/publish'));

  handle('chat:connect', () => {
    client.connect();
    return client.status;
  });
  handle('chat:send', (a) => {
    const obj = { t: str(a.t, 16) };
    if (a.room !== undefined) obj.room = str(a.room, 64);
    if (a.text !== undefined) obj.text = str(a.text, 4000);
    if (a.cid !== undefined) obj.cid = str(a.cid, 64);
    if (a.id !== undefined) obj.id = int(a.id);
    if (Array.isArray(a.images)) obj.images = a.images.slice(0, 6).map(int).filter(Boolean);
    return client.send(obj);
  });

  // Картинки в чате, подчаты, баг-репорты
  const b64img = (v, max) => {
    if (typeof v !== 'string' || v.length > max || !/^[A-Za-z0-9+/=]+$/.test(v)) throw Object.assign(new Error('bad_image'), { code: 'bad_image' });
    return v;
  };
  const dim = (v) => (Number.isSafeInteger(v) && v > 0 && v <= 8000 ? v : 0);
  handle('chatimg:upload', (a) =>
    client.request('POST', '/api/chat/images', { room: str(a.room, 64), image: b64img(a.image, 4_300_000), w: dim(a.w), h: dim(a.h) }, { timeout: 60000 }));
  handle('chatimg:get', async (a) => {
    const r = await client.fetchBytes('/api/chat/images/' + need(a.id));
    if (r.type !== 'image/webp') throw Object.assign(new Error('bad_image'), { code: 'bad_image' });
    return 'data:image/webp;base64,' + r.bytes.toString('base64');
  });
  handle('subrooms:list', () => client.request('GET', '/api/subrooms'));
  handle('subrooms:add', (a) => client.request('POST', '/api/subrooms', { parent: str(a.parent, 16), title: str(a.title, 80) }));
  handle('subrooms:rename', (a) => client.request('PATCH', '/api/subrooms/' + need(a.id), { title: str(a.title, 80) }));
  handle('subrooms:delete', (a) => client.request('DELETE', '/api/subrooms/' + need(a.id)));
  handle('tickets:list', () => client.request('GET', '/api/tickets'));
  handle('admin:storage', () => client.request('GET', '/api/admin/storage'));

  // Версия сервера: старый сервер не знает новых разделов, об этом лучше сказать сразу.
  handle('app:server', async () => {
    let v = '';
    try {
      v = String((await client.request('GET', '/api/health', undefined, { auth: false })).version || '');
    } catch {
      return { version: '', need: MIN_SERVER, old: false, unknown: true };
    }
    const n = (x) => x.split('.').map((p) => parseInt(p, 10) || 0);
    const [a, b] = [n(v || '0'), n(MIN_SERVER)];
    const old = a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
    return { version: v, need: MIN_SERVER, old: old < 0 };
  });

  // Материалы студии (файлы в R2)
  const matText = (v, n) => str(v, n);
  handle('mat:overview', () => client.request('GET', '/api/materials'));
  handle('mat:files', (a) => client.request('GET', '/api/materials/projects/' + need(a.project) + '/files'));
  handle('mat:projectAdd', (a) => client.request('POST', '/api/materials/projects', { title: matText(a.title, 120), note: matText(a.note, 600) }));
  handle('mat:projectEdit', (a) => client.request('PATCH', '/api/materials/projects/' + need(a.id), { title: matText(a.title, 120), note: matText(a.note, 600) }));
  handle('mat:projectDelete', (a) => client.request('DELETE', '/api/materials/projects/' + need(a.id), undefined, { timeout: 120000 }));
  handle('mat:settings', (a) => {
    const body = {};
    if (Number.isFinite(a.limitGB)) body.limitGB = a.limitGB;
    if (Number.isFinite(a.maxFileGB)) body.maxFileGB = a.maxFileGB;
    if (Number.isSafeInteger(a.musicProject) && a.musicProject >= 0) body.musicProject = a.musicProject;
    if (typeof a.projectsOpen === 'boolean') body.projectsOpen = a.projectsOpen;
    return client.request('PATCH', '/api/materials/settings', body);
  });
  handle('mat:pick', () => materials.pick());
  handle('mat:register', (a) => materials.register(str(a.path, 4000)));
  handle('mat:upload', (a) => materials.upload({ token: str(a.token, 40), project: need(a.project), folder: matText(a.folder, 80) }));
  handle('mat:cancel', (a) => materials.cancel(str(a.token, 40)));
  handle('mat:download', (a) => materials.download(need(a.id)));
  handle('mat:downloadProject', (a) => materials.downloadProject(need(a.project)));
  handle('mat:preview', (a) => materials.previewUrl(need(a.id)));
  handle('mat:showFile', (a) => materials.showFile(a.file));
  handle('mat:fileEdit', (a) => {
    const body = {};
    if (typeof a.name === 'string') body.name = str(a.name, 200);
    if (typeof a.folder === 'string') body.folder = str(a.folder, 80);
    return client.request('PATCH', '/api/materials/files/' + need(a.id), body);
  });
  handle('mat:fileDelete', (a) => client.request('DELETE', '/api/materials/files/' + need(a.id)));
  handle('mat:move', (a) => client.request('POST', '/api/materials/files/' + need(a.id) + '/move', { project: need(a.project) }, { timeout: 120000 }));
  handle('tickets:add', (a) =>
    client.request('POST', '/api/tickets', {
      title: str(a.title, 200),
      body: str(a.body, 4000),
      app: app.getVersion() + ' ' + process.platform + ' ' + os.release(),
      images: (Array.isArray(a.images) ? a.images : []).slice(0, 6).map((x) => ({ data: b64img(x && x.data, 4_300_000), w: dim(x.w), h: dim(x.h) })),
    }, { timeout: 120000 }));
  handle('tickets:rename', (a) => client.request('PATCH', '/api/tickets/' + need(a.id), { title: str(a.title, 200) }));
  handle('tickets:review', (a) =>
    client.request('POST', '/api/tickets/' + need(a.id) + '/review', {
      verdict: ['visual', 'vuln', 'notbug', 'dup', ''].includes(a.verdict) ? a.verdict : '',
      note: str(a.note, 1000),
      dupOf: int(a.dupOf),
      qty: Number.isFinite(a.qty) ? a.qty : 0,
      points: Number.isFinite(a.points) ? a.points : 0,
      amount: Number.isFinite(a.amount) ? a.amount : 0,
    }));
  handle('tickets:delete', (a) => client.request('DELETE', '/api/tickets/' + need(a.id)));

  handle('api:me', () => client.request('GET', '/api/me'));
  handle('api:updateMe', (a) => {
    const body = {};
    if (a.name) body.name = str(a.name, 64);
    if (a.avatar && typeof a.avatar === 'object') body.avatar = { type: str(a.avatar.type, 16), id: str(a.avatar.id, 40) || undefined, color: str(a.avatar.color, 7) };
    return client.request('PATCH', '/api/me', body);
  });
  handle('api:password', async (a) => {
    const r = await client.request('POST', '/api/me/password', { old: str(a.old, 256), new: str(a.new, 256) });
    await core.rekey(str(a.new, 256)); // память Core перешифровывается под новый пароль
    return r;
  });
  // Память Core: расшифровывается только здесь, на сервер уходит шифротекст
  handle('core:load', (a) => core.load(need(a.uid)));
  handle('core:save', (a) => {
    const text = JSON.stringify(a.mem || {});
    if (text.length > 90000) throw Object.assign(new Error('too_big'), { code: 'too_big' });
    return core.save(JSON.parse(text));
  });
  handle('core:forget', () => core.forget());
  handle('api:users', () => client.request('GET', '/api/users'));
  handle('api:rooms', () => client.request('GET', '/api/rooms'));
  handle('api:messages', (a) => {
    const q = new URLSearchParams({ room: str(a.room, 64) });
    if (int(a.before)) q.set('before', String(int(a.before)));
    return client.request('GET', '/api/messages?' + q);
  });

  handle('admin:users', () => client.request('GET', '/api/admin/users'));
  handle('admin:invites', () => client.request('GET', '/api/admin/invites'));
  handle('admin:createInvite', (a) =>
    client.request('POST', '/api/admin/invites', { name: str(a.name, 64), role: a.role === 'admin' ? 'admin' : 'member', days: int(a.days) || 7 }),
  );
  handle('admin:revokeInvite', (a) => {
    const id = str(a.id, 16);
    if (!/^[0-9a-f]{16}$/.test(id)) throw Object.assign(new Error('not_found'), { code: 'not_found' });
    return client.request('DELETE', '/api/admin/invites/' + id);
  });
  handle('admin:userAction', (a) => {
    const id = int(a.id);
    const action = str(a.action, 16);
    if (!id || !['block', 'unblock', 'reset', 'role'].includes(action)) throw Object.assign(new Error('bad_input'), { code: 'bad_input' });
    const body = action === 'role' ? { role: a.role === 'admin' ? 'admin' : 'member' } : {};
    return client.request('POST', `/api/admin/users/${id}/${action}`, body);
  });
  handle('admin:deleteUser', (a) => {
    const id = int(a.id);
    if (!id) throw Object.assign(new Error('bad_input'), { code: 'bad_input' });
    return client.request('DELETE', `/api/admin/users/${id}`);
  });

  // Доска на главной: ветки графа и карточки
  const cardPath = (a) => {
    const id = int(a.id);
    if (!id) throw Object.assign(new Error('not_found'), { code: 'not_found' });
    return '/api/board/cards/' + id;
  };
  handle('board:get', () => client.request('GET', '/api/board'));
  handle('board:add', (a) => client.request('POST', '/api/board/cards', { branch: str(a.branch, 40), title: str(a.title, 200), body: str(a.body, 6000) }));
  handle('board:edit', (a) => client.request('PATCH', cardPath(a), { title: str(a.title, 200), body: str(a.body, 6000) }));
  handle('board:delete', (a) => client.request('DELETE', cardPath(a)));
  handle('admin:branch', (a) => {
    const id = str(a.id, 40);
    if (!/^[a-z0-9-]{1,40}$/.test(id)) throw Object.assign(new Error('not_found'), { code: 'not_found' });
    return client.request('PATCH', '/api/admin/board/branches/' + id, { title: str(a.title, 64), note: str(a.note, 240) });
  });

  // Ассистент
  const chatPath = (a) => {
    const id = int(a.chatId);
    if (!id) throw Object.assign(new Error('not_found'), { code: 'not_found' });
    return '/api/ai/chats/' + id;
  };
  handle('ai:models', () => client.request('GET', '/api/ai/models'));
  handle('ai:chats', () => client.request('GET', '/api/ai/chats'));
  handle('ai:createChat', (a) => client.request('POST', '/api/ai/chats', { title: str(a.title, 80), system: str(a.system, 4000), model: str(a.model, 80) }));
  handle('ai:updateChat', (a) => {
    const body = {};
    for (const k of ['title', 'system', 'summary', 'model']) if (typeof a[k] === 'string') body[k] = str(a[k], 6000);
    if (Array.isArray(a.skills)) body.skills = ids(a.skills, 50);
    return client.request('PATCH', chatPath(a), body);
  });
  handle('ai:deleteChat', (a) => client.request('DELETE', chatPath(a)));
  handle('ai:messages', (a) => client.request('GET', chatPath(a) + '/messages'));
  handle('ai:send', async (a) => {
    const id = int(a.chatId);
    const path = chatPath(a) + '/send';
    if (aiStreams.has(id)) throw Object.assign(new Error('busy'), { code: 'busy' });
    const ctrl = new AbortController();
    aiStreams.set(id, ctrl);
    let last = null;
    try {
      await client.stream(path, { text: str(a.text, 20000), files: ids(a.files, 20), memo: a.memo === true }, (ev) => {
        if (ev.t === 'done' || ev.t === 'error') last = ev;
        send('ai:event', { chatId: id, ...ev });
      }, ctrl.signal);
      return last;
    } catch (err) {
      if (err.name === 'AbortError') return { t: 'error', code: 'cancelled' };
      throw err;
    } finally {
      aiStreams.delete(id);
    }
  });
  handle('ai:estimate', (a) => client.request('POST', chatPath(a) + '/estimate', { text: str(a.text, 20000), files: ids(a.files, 20), memo: a.memo === true }));
  handle('ai:compress', (a) => client.request('POST', chatPath(a) + '/compress'));
  handle('ai:skills', () => client.request('GET', '/api/ai/skills'));
  handle('ai:stop', (a) => {
    const c = aiStreams.get(int(a.chatId));
    if (c) c.abort();
    return true;
  });
  handle('admin:ai', () => client.request('GET', '/api/admin/ai'));
  const poolName = (n) => /^[a-z0-9-]{1,40}$/.test(n);
  handle('admin:aiUser', (a) => {
    const id = int(a.id);
    if (!id) throw Object.assign(new Error('bad_input'), { code: 'bad_input' });
    const pools = {};
    for (const [name, p] of Object.entries(a.pools || {})) {
      if (!poolName(name) || !p || typeof p !== 'object') continue;
      pools[name] = { enabled: p.enabled !== false, daily: int(p.daily), max: int(p.max) };
    }
    return client.request('PUT', '/api/admin/ai/users/' + id, { enabled: a.enabled !== false, model: str(a.model, 80), pools });
  });
  handle('admin:aiDefaults', (a) => client.request('PUT', '/api/admin/ai/defaults', { model: str(a.model, 80) }));
  handle('admin:aiSystem', (a) => client.request('PUT', '/api/admin/ai/system', { system: str(a.system, 4000) }));
  const skillBody = (a) => ({ name: str(a.name, 80), descr: str(a.descr, 300), prompt: str(a.prompt, 4000) });
  handle('admin:aiAddSkill', (a) => client.request('POST', '/api/admin/ai/skills', skillBody(a)));
  handle('admin:aiEditSkill', (a) => {
    const id = int(a.id);
    if (!id) throw Object.assign(new Error('not_found'), { code: 'not_found' });
    return client.request('PUT', '/api/admin/ai/skills/' + id, skillBody(a));
  });
  handle('admin:aiDeleteSkill', (a) => {
    const id = int(a.id);
    if (!id) throw Object.assign(new Error('not_found'), { code: 'not_found' });
    return client.request('DELETE', '/api/admin/ai/skills/' + id);
  });
  handle('admin:aiModel', (a) => {
    const name = str(a.name, 80);
    if (!/^[\w.:-]{1,80}$/.test(name)) throw Object.assign(new Error('bad_input'), { code: 'bad_input' });
    const body = { ctx: int(a.ctx) };
    if (['', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(a.effort)) body.effort = a.effort;
    return client.request('PUT', '/api/admin/ai/models/' + encodeURIComponent(name), body);
  });
  handle('admin:aiDeleteModel', (a) => {
    const name = str(a.name, 80);
    if (!/^[\w.:-]{1,80}$/.test(name)) throw Object.assign(new Error('bad_input'), { code: 'bad_input' });
    return client.request('DELETE', '/api/admin/ai/models/' + encodeURIComponent(name));
  });
  handle('admin:aiPool', (a) => {
    const name = str(a.name, 40);
    if (!poolName(name)) throw Object.assign(new Error('bad_input'), { code: 'bad_input' });
    const body = { daily: int(a.daily), userDaily: int(a.userDaily), userMax: int(a.userMax) };
    if (typeof a.unlimited === 'boolean') body.unlimited = a.unlimited;
    return client.request('PUT', '/api/admin/ai/pools/' + name, body);
  });

  // Проекты и запуск
  const need = (v) => {
    const id = int(v);
    if (!id) throw Object.assign(new Error('not_found'), { code: 'not_found' });
    return id;
  };
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(-100000, Math.min(100000, v)) : undefined);
  const fileBody = (a) => {
    const b = {};
    if (typeof a.path === 'string') b.path = str(a.path, 200);
    if (typeof a.ext === 'string') b.ext = str(a.ext, 10);
    if (typeof a.body === 'string') b.body = str(a.body, 600000);
    if (typeof a.descr === 'string') b.descr = str(a.descr, 400);
    if (num(a.x) !== undefined && num(a.y) !== undefined) {
      b.x = num(a.x);
      b.y = num(a.y);
    }
    return b;
  };
  handle('proj:list', () => client.request('GET', '/api/projects'));
  handle('proj:create', (a) => client.request('POST', '/api/projects', { title: str(a.title, 80) }));
  handle('proj:get', (a) => client.request('GET', '/api/projects/' + need(a.id)));
  handle('proj:update', (a) => {
    const b = {};
    if (typeof a.title === 'string') b.title = str(a.title, 80);
    if (typeof a.net === 'boolean') b.net = a.net;
    return client.request('PATCH', '/api/projects/' + need(a.id), b);
  });
  handle('proj:delete', (a) => client.request('DELETE', '/api/projects/' + need(a.id)));
  handle('proj:addFile', (a) => client.request('POST', '/api/projects/' + need(a.id) + '/files', fileBody(a)));
  handle('proj:editFile', (a) => {
    const b = fileBody(a);
    delete b.ext;
    if (num(a.x) !== undefined && num(a.y) === undefined) b.x = num(a.x);
    return client.request('PATCH', '/api/projects/files/' + need(a.fileId), b);
  });
  handle('proj:deleteFile', (a) => client.request('DELETE', '/api/projects/files/' + need(a.fileId)));
  handle('proj:link', (a) => {
    const id = need(a.id);
    const x = need(a.a);
    const y = need(a.b);
    return a.on === false
      ? client.request('DELETE', `/api/projects/${id}/links/${x}/${y}`)
      : client.request('POST', `/api/projects/${id}/links`, { a: x, b: y });
  });
  handle('proj:share', (a) => client.request('POST', '/api/projects/' + need(a.id) + '/share', { room: str(a.room, 64), text: str(a.text, 4000) }));
  handle('snap:get', (a) => client.request('GET', '/api/snaps/' + need(a.id)));
  handle('snap:copy', (a) => client.request('POST', '/api/snaps/' + need(a.id) + '/copy'));
  handle('run:project', async (a) => {
    const id = need(a.id);
    const p = await client.request('GET', '/api/projects/' + id);
    return runner.open({ key: 'p' + id, title: p.title, files: p.fileList.map((f) => ({ path: f.path, body: f.body })), net: !!p.net });
  });
  handle('run:snap', async (a) => {
    const id = need(a.id);
    const sn = await client.request('GET', '/api/snaps/' + id);
    // Снимок всегда без сети: сеть можно включить только в своей копии.
    return runner.open({ key: 's' + id, title: sn.title + ' (снимок)', files: sn.files.map((f) => ({ path: f.path, body: f.body })), net: false });
  });
  handle('run:logs', (a) => runner.logs(str(a.key, 20)));

  // Инструменты кузницы
  const toolId = (a) => str(a.id, 40);
  handle('tools:list', () => tools.list());
  handle('tools:install', (a) => tools.install(toolId(a)));
  handle('tools:cancel', (a) => tools.cancel(toolId(a)));
  handle('tools:remove', (a) => tools.remove(toolId(a)));
  handle('tools:open', (a) => tools.open(toolId(a)));

  handle('settings:get', () => ({ ...getSettings(), restartNeeded: STARTUP.gpuHigh !== getSettings().gpuHigh || STARTUP.gpuAccel !== getSettings().gpuAccel }));
  handle('settings:set', (a) => {
    const patch = {};
    if (a.serverUrl !== undefined) {
      const url = normalizeServerUrl(a.serverUrl);
      if (!url) throw Object.assign(new Error('bad_server_url'), { code: 'bad_server_url' });
      client.setServer(url);
      patch.serverUrl = url;
    }
    if (a.notifications !== undefined) patch.notifications = !!a.notifications;
    if (a.theme !== undefined && THEME_IDS.includes(a.theme)) patch.theme = a.theme;
    // Папка с музыкой меняется только через окно выбора папки (music:pickFolder).
    for (const [k, [ok]] of Object.entries(LOOK)) if (k !== 'musicFolder' && a[k] !== undefined && ok(a[k])) patch[k] = a[k];
    if (a.musicRadios !== undefined) patch.musicRadios = cleanRadios(a.musicRadios);
    const after = saveSettings(patch);
    if (patch.zoom && win) win.webContents.setZoomFactor(after.zoom / 100);
    if (patch.theme && browser) browser.themeChanged();
    if (patch.gpuHigh !== undefined && process.platform === 'win32') setWindowsGpuPreference(after.gpuHigh);
    // Видеокарта и ускорение меняются только при запуске.
    after.restartNeeded = STARTUP.gpuHigh !== after.gpuHigh || STARTUP.gpuAccel !== after.gpuAccel;
    return after;
  });

  handle('app:info', () => ({ version: app.getVersion(), dev: DEV }));
  handle('app:restart', () => {
    if (updater) updater.restart();
    return true;
  });
  handle('app:notify', (a) => {
    // Напоминание из раздела "Вклад": системное уведомление, если окно не в фокусе.
    if (win && win.isFocused()) return false;
    if (win) win.flashFrame(true);
    if (!Notification.isSupported()) return false;
    const n = new Notification({ title: str(a.title, 80), body: str(a.body, 300), icon: ICON });
    n.on('click', () => {
      if (!win) return;
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    });
    n.show();
    return true;
  });
  // Музыка
  handle('music:studio', (a) => music.studioInfo(a.force === true));
  handle('music:folder', () => music.folderInfo());
  // Каталог радио: поиск и добавление найденной станции в "Мои станции" (ссылку знает только main).
  handle('radio:search', (a) => radio.search(a || {}));
  handle('radio:add', (a) => {
    const st = radio.station(String(a.uuid || ''));
    if (!st) throw Object.assign(new Error('not_found'), { code: 'not_found' });
    const s = getSettings();
    if (s.musicRadios.some((r) => r.uuid === a.uuid || r.url === st.url)) return s;
    if (s.musicRadios.length >= 50) throw Object.assign(new Error('radio_full'), { code: 'radio_full' });
    return saveSettings({ musicRadios: cleanRadios([...s.musicRadios, { name: st.name, url: st.url, uuid: a.uuid }]) });
  });
  handle('music:pickFolder', async () => {
    const dir = await music.pickFolder(win);
    if (!dir) return null;
    saveSettings({ musicFolder: dir, musicSource: 'folder' });
    return music.folderInfo();
  });
  handle('win:titlebar', (a) => {
    // Цвета полосы заголовка под тему: фон и значки кнопок.
    const hex = (v, d) => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v : d);
    if (win && typeof win.setTitleBarOverlay === 'function') {
      win.setTitleBarOverlay({ color: hex(a.color, '#0b0c0e'), symbolColor: hex(a.symbol, '#e8e6e1'), height: TITLEBAR_H });
    }
    return { full: !!(win && win.isFullScreen()), platform: process.platform };
  });
  handle('win:dnd', (a) => {
    doNotDisturb = a.on === true;
    return doNotDisturb;
  });
  handle('win:fullscreen', () => {
    if (win) win.setFullScreen(!win.isFullScreen());
    return !!(win && win.isFullScreen());
  });
  handle('app:gpu', () => gpuInfo());
  handle('app:themes', () => EXTRA_THEMES);
  handle('browser:open', (a) => {
    browser.open(typeof a.url === 'string' && /^https?:\/\//i.test(a.url) ? a.url.slice(0, 2000) : undefined);
    return true;
  });
  // Список готовых аватарок: assets/avatars/avatars.json (новые добавляются туда и файлом рядом).
  handle('app:avatars', () => {
    const j = readJson(path.join(__dirname, '..', 'assets', 'avatars', 'avatars.json'), { avatars: [] });
    const list = (Array.isArray(j.avatars) ? j.avatars : [])
      .filter((a) => a && /^[a-z0-9-]{1,40}$/.test(a.id || '') && fs.existsSync(path.join(__dirname, '..', 'assets', 'avatars', a.id + '.webp')))
      .map((a) => ({ id: a.id, group: str(a.group, 40) || 'base' }));
    const groups = (Array.isArray(j.groups) ? j.groups : [])
      .filter((g) => g && typeof g.id === 'string')
      .map((g) => ({ id: str(g.id, 40), name: str(g.name, 60) || g.id }));
    return { list, groups };
  });
  handle('app:relaunch', () => {
    app.relaunch();
    app.exit(0);
  });
  handle('app:copy', (a) => {
    clipboard.writeText(str(a.text, 200000));
    return true;
  });
}

// ---------- запуск ----------

registerScheme([schemePrivileges, musicPrivileges]);
setupGpu();

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });

  app.whenReady().then(() => {
    app.setAppUserModelId('studio.twentywords.studio');
    Menu.setApplicationMenu(null);
    // Интерфейсу не нужны камера, микрофон, геопозиция и прочие разрешения браузера.
    // Только полный экран: видео в Материалах и картинки разворачиваются на весь экран.
    session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(perm === 'fullscreen'));
    setupClient();
    tools = new Tools({
      root: ROOT,
      notify: send,
      onWindow: applyEditorsMode,
      perms: {
        get: () => getSettings().toolPerms,
        set: (id, patch) => {
          const all = { ...getSettings().toolPerms };
          all[id] = { ...(all[id] || {}), ...patch };
          saveSettings({ toolPerms: all });
        },
      },
    });
    tools.setupSession();
    runner = new Runner({
      notify: send,
      onWindow: applyEditorsMode,
      blockedHost: () => {
        try {
          return new URL(getSettings().serverUrl).hostname;
        } catch {
          return '';
        }
      },
    });
    radio = new RadioCatalog();
    music = new Music({
      catalog: radio,
      config,
      settings: getSettings,
      server: {
        list: () => client.request('GET', '/api/materials/music'),
        url: (id) => client.request('GET', '/api/materials/files/' + int(id) + '/url?inline=1'),
      },
    });
    materials = new Materials({ client, notify: send, window: () => win });
    core = new Core({ client });
    browser = new Browser({
      icon: ICON,
      themeOf: () => ({ theme: getSettings().theme, extra: EXTRA_THEMES }),
      onAudio: (on) => send('browser:audio', { on }),
      studio: config.browser && config.browser.studio,
    });
    music.setupProtocol();
    registerIpc();
    createWindow();
    updater = setupUpdater(send);
  });

  app.on('window-all-closed', () => {
    for (const c of aiStreams.values()) c.abort();
    if (client) client.disconnect();
    app.quit();
  });
}
