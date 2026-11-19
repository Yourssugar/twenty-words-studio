// Главный процесс Twenty Words Studio.
// Интерфейс работает в песочнице и в сеть не ходит: все запросы к серверу
// делает этот процесс, а интерфейс вызывает только функции из preload.js.

const { app, BrowserWindow, ipcMain, session, shell, clipboard, Notification, Menu, safeStorage } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { StudioClient, normalizeServerUrl } = require('./client');
const { Tools, registerScheme } = require('./tools');
const { setupUpdater } = require('./updater');

const ROOT = path.join(__dirname, '..', '..');
const RENDERER = path.join(__dirname, '..', 'renderer', 'index.html');
const ICON = path.join(__dirname, '..', 'assets', 'icon.png');
const DEV = !app.isPackaged || process.argv.includes('--dev');

let win = null;
let client = null;
let tools = null;
let updater = null;
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
const THEME_IDS = ['auto', 'workshop', 'spring', 'summer', 'autumn', 'winter'];
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

function getSettings() {
  const s = readJson(settingsFile(), {});
  return {
    serverUrl: normalizeServerUrl(s.serverUrl) || normalizeServerUrl(config.serverUrl) || 'http://127.0.0.1:8787',
    notifications: s.notifications !== false,
    theme: THEME_IDS.includes(s.theme) ? s.theme : 'auto',
  };
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

// ---------- окно ----------

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1240,
    height: 800,
    minWidth: 920,
    minHeight: 600,
    title: 'Twenty Words Studio',
    icon: ICON,
    backgroundColor: '#0f1012',
    autoHideMenuBar: true,
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

  // Никаких переходов внутри окна. Ссылки из чата открываются в обычном браузере.
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('before-input-event', (e, input) => {
    if (DEV && input.type === 'keyDown' && input.control && input.shift && input.key.toLowerCase() === 'i') {
      win.webContents.toggleDevTools();
    }
  });
  win.on('focus', () => win.flashFrame(false));
  win.once('ready-to-show', () => win.show());
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

function maybeNotify(m) {
  if (m.user === myId || !getSettings().notifications) return;
  if (win && win.isFocused()) return;
  if (win) win.flashFrame(true);
  if (!Notification.isSupported()) return;
  const who = names.get(m.user) || 'Сообщение';
  const where = m.room === 'work' ? ' · Рабочая зона' : m.room === 'free' ? ' · Свободные темы' : '';
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

// Ответ всегда { ok, data } или { ok: false, error }: интерфейс показывает понятный текст по коду ошибки.
function handle(channel, fn) {
  ipcMain.handle(channel, async (event, arg) => {
    if (!event.senderFrame || !event.senderFrame.url.startsWith('file://')) return { ok: false, error: 'forbidden' };
    try {
      return { ok: true, data: await fn(arg || {}) };
    } catch (err) {
      return { ok: false, error: err.code || err.message || 'error' };
    }
  });
}

function registerIpc() {
  handle('auth:state', () => ({ signedIn: client.signedIn, server: client.base }));
  handle('auth:login', async (a) => {
    const user = await client.login(str(a.login, 64), str(a.password, 256));
    client.connect();
    return user;
  });
  handle('auth:register', async (a) => {
    const user = await client.register(str(a.code, 64), str(a.login, 64), str(a.name, 64), str(a.password, 256));
    client.connect();
    return user;
  });
  handle('auth:logout', async () => {
    await client.logout();
    return true;
  });

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
    return client.send(obj);
  });

  handle('api:me', () => client.request('GET', '/api/me'));
  handle('api:updateMe', (a) => {
    const body = {};
    if (a.name) body.name = str(a.name, 64);
    if (a.avatar && typeof a.avatar === 'object') body.avatar = { type: str(a.avatar.type, 16), id: str(a.avatar.id, 40) || undefined, color: str(a.avatar.color, 7) };
    return client.request('PATCH', '/api/me', body);
  });
  handle('api:password', (a) => client.request('POST', '/api/me/password', { old: str(a.old, 256), new: str(a.new, 256) }));
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
      await client.stream(path, { text: str(a.text, 20000) }, (ev) => {
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
  handle('admin:aiPool', (a) => {
    const name = str(a.name, 40);
    if (!poolName(name)) throw Object.assign(new Error('bad_input'), { code: 'bad_input' });
    return client.request('PUT', '/api/admin/ai/pools/' + name, { daily: int(a.daily), userDaily: int(a.userDaily), userMax: int(a.userMax) });
  });

  // Инструменты кузницы
  const toolId = (a) => str(a.id, 40);
  handle('tools:list', () => tools.list());
  handle('tools:install', (a) => tools.install(toolId(a)));
  handle('tools:cancel', (a) => tools.cancel(toolId(a)));
  handle('tools:remove', (a) => tools.remove(toolId(a)));
  handle('tools:open', (a) => tools.open(toolId(a)));

  handle('settings:get', () => getSettings());
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
    return saveSettings(patch);
  });

  handle('app:info', () => ({ version: app.getVersion(), dev: DEV }));
  handle('app:restart', () => {
    if (updater) updater.restart();
    return true;
  });
  handle('app:copy', (a) => {
    clipboard.writeText(str(a.text, 200000));
    return true;
  });
}

// ---------- запуск ----------

registerScheme();

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
    session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
    setupClient();
    tools = new Tools({ root: ROOT, notify: send });
    tools.setupSession();
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
