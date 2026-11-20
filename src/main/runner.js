// Запуск проектов: файлы проекта открываются в отдельном окне по адресу
// twproj://<ключ>/index.html, как сайт целиком (html, css, js, json).
//
// Окно запуска изолировано:
// - своя сессия в памяти, без входа на сервер студии; при закрытии всё стирается;
// - нет Node и нет моста к приложению (без preload);
// - сеть закрыта, если в проекте не включена галочка; сервер студии закрыт всегда;
// - скачивания, новые окна, переходы на чужие адреса и разрешения браузера запрещены.
// Сообщения консоли страницы уходят в главное окно, в панель "Консоль".

const { BrowserWindow, session } = require('electron');
const path = require('path');

const SCHEME = 'twproj';
const MAX_LOG = 400;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
};

// Что разрешено странице без сети: только свои файлы и встроенные данные.
const OFFLINE_CSP = "default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob:; connect-src 'self' data: blob:; form-action 'none'";

const schemePrivileges = { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } };

function pickStart(files) {
  if (files.has('index.html')) return 'index.html';
  const html = [...files.keys()].filter((p) => /\.html?$/i.test(p)).sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
  return html[0] || '';
}

function noStartPage() {
  return '<!doctype html><meta charset="utf-8"><title>Нет страницы</title>' +
    '<body style="font:15px system-ui;background:#111;color:#ddd;padding:40px">' +
    '<h2>В проекте нет html-файла</h2><p>Добавьте index.html: с него начинается запуск.</p></body>';
}

class Runner {
  constructor({ notify, blockedHost }) {
    this.notify = notify; // (канал, данные) -> главное окно
    this.blockedHost = blockedHost; // () -> адрес сервера студии, к нему окну запуска нельзя
    this.runs = new Map(); // ключ -> { win, ses, files, net, title, start, logs }
  }

  // key: "p12" (проект) или "s5" (снимок). files: [{path, body}]
  open({ key, title, files, net }) {
    const map = new Map(files.map((f) => [f.path, f.body]));
    let run = this.runs.get(key);
    if (run && run.win && !run.win.isDestroyed()) {
      run.files = map;
      run.net = !!net;
      run.title = title;
      run.start = pickStart(map);
      run.logs = [];
      this.notify('run:log', { key, clear: true });
      run.win.setTitle('Запуск: ' + title);
      run.win.loadURL(this.url(key, run.start));
      if (run.win.isMinimized()) run.win.restore();
      run.win.focus();
      return { key, start: run.start, net: run.net };
    }
    const ses = session.fromPartition('twrun-' + key + '-' + Date.now()); // без persist: только в памяти
    run = { win: null, ses, files: map, net: !!net, title, start: pickStart(map), logs: [] };
    this.runs.set(key, run);
    this.setupSession(key, run);
    run.win = this.createWindow(key, run);
    return { key, start: run.start, net: run.net };
  }

  url(key, rel) {
    return SCHEME + '://' + key + '/' + (rel ? rel.split('/').map(encodeURIComponent).join('/') : '__start');
  }

  log(key, level, text, source = '') {
    const run = this.runs.get(key);
    const entry = { key, level, text: String(text).slice(0, 4000), source: String(source).slice(0, 300), ts: Date.now() };
    if (run) {
      run.logs.push(entry);
      if (run.logs.length > MAX_LOG) run.logs.shift();
    }
    this.notify('run:log', entry);
  }

  logs(key) {
    const run = this.runs.get(key);
    return run ? run.logs : [];
  }

  isOpen(key) {
    const run = this.runs.get(key);
    return !!(run && run.win && !run.win.isDestroyed());
  }

  setupSession(key, run) {
    const { ses } = run;
    ses.protocol.handle(SCHEME, (req) => this.serve(key, req));
    ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
    ses.setPermissionCheckHandler(() => false);
    ses.on('will-download', (e, item) => {
      e.preventDefault();
      this.log(key, 'warning', 'Скачивание заблокировано: ' + item.getFilename());
    });
    ses.webRequest.onBeforeRequest((details, cb) => {
      let u;
      try {
        u = new URL(details.url);
      } catch {
        return cb({ cancel: true });
      }
      const scheme = u.protocol.replace(':', '');
      if (scheme === SCHEME) return cb({ cancel: u.hostname !== key });
      if (scheme === 'data' || scheme === 'blob' || scheme === 'devtools') return cb({ cancel: false });
      if (['http', 'https', 'ws', 'wss'].includes(scheme)) {
        const blocked = this.blockedHost && this.blockedHost();
        if (blocked && u.hostname === blocked) {
          this.log(key, 'warning', 'Запрос к серверу студии заблокирован: ' + u.origin);
          return cb({ cancel: true });
        }
        if (run.net) return cb({ cancel: false });
        this.log(key, 'warning', 'Сеть выключена, запрос не ушёл: ' + details.url.slice(0, 200));
        return cb({ cancel: true });
      }
      this.log(key, 'warning', 'Адрес заблокирован: ' + details.url.slice(0, 200));
      cb({ cancel: true });
    });
  }

  serve(key, req) {
    const run = this.runs.get(key);
    const u = new URL(req.url);
    if (!run || u.hostname !== key) return new Response('not found', { status: 404 });
    let rel;
    try {
      rel = decodeURIComponent(u.pathname).replace(/^\/+/, '');
    } catch {
      return new Response('bad path', { status: 400 });
    }
    const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
    if (!run.net) headers['Content-Security-Policy'] = OFFLINE_CSP;
    if (rel === '__start') {
      if (!run.start) return new Response(noStartPage(), { status: 404, headers: { ...headers, 'Content-Type': TYPES['.html'] } });
      rel = run.start;
    }
    if (rel === '' || rel.endsWith('/')) rel += 'index.html';
    let body = run.files.get(rel);
    if (body === undefined) {
      // На Windows люди пишут Style.css вместо style.css: прощаем регистр.
      const lower = rel.toLowerCase();
      for (const [p, b] of run.files) {
        if (p.toLowerCase() === lower) {
          body = b;
          rel = p;
          break;
        }
      }
    }
    if (body === undefined) {
      if (!/favicon\.ico$/i.test(rel)) this.log(key, 'error', 'Нет файла: ' + rel);
      return new Response('not found', { status: 404, headers });
    }
    const type = TYPES[path.extname(rel).toLowerCase()] || 'text/plain; charset=utf-8';
    return new Response(body, { status: 200, headers: { ...headers, 'Content-Type': type } });
  }

  createWindow(key, run) {
    const win = new BrowserWindow({
      width: 1100,
      height: 760,
      title: 'Запуск: ' + run.title,
      backgroundColor: '#ffffff',
      autoHideMenuBar: true,
      webPreferences: {
        session: run.ses,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        spellcheck: false,
        navigateOnDragDrop: false,
        safeDialogs: true,
      },
    });
    const wc = win.webContents;
    wc.setWindowOpenHandler(({ url }) => {
      this.log(key, 'warning', 'Новые окна запрещены: ' + String(url).slice(0, 200));
      return { action: 'deny' };
    });
    const guard = (e, url) => {
      url = url || e.url;
      try {
        const u = new URL(url);
        if (u.protocol === SCHEME + ':' && u.hostname === key) return;
      } catch {
        /* битый адрес */
      }
      e.preventDefault();
      this.log(key, 'warning', 'Переход заблокирован: ' + String(url).slice(0, 200));
    };
    wc.on('will-navigate', guard);
    wc.on('will-redirect', guard);
    wc.on('will-frame-navigate', (e) => {
      if (!e.isMainFrame) guard(e, e.url);
    });
    wc.on('console-message', (e, level, message, line, sourceId) => {
      // Electron 35+: поля события; старые версии: отдельные аргументы.
      const lv = typeof e.level === 'string' ? e.level : ['debug', 'info', 'warning', 'error'][level] || 'info';
      const text = e.message !== undefined ? e.message : message;
      const ln = e.lineNumber !== undefined ? e.lineNumber : line;
      const src = e.sourceId !== undefined ? e.sourceId : sourceId;
      const where = src ? String(src).replace(SCHEME + '://' + key + '/', '') + (ln ? ':' + ln : '') : '';
      const msg = String(text);
      // Без сети запросы режет политика страницы. Её английский текст заменяем понятным.
      if (!run.net && msg.includes('Content Security Policy')) {
        if (/^Fetch API cannot load|^Refused to connect/.test(msg)) return; // дубль предыдущей строки
        const m = msg.match(/'((?:https?|wss?):[^']+)'/) || msg.match(/((?:https?|wss?):\/\/\S+)/);
        this.log(key, 'warning', 'Сеть выключена (галочка "Сеть" в проекте), не ушло: ' + (m ? m[1] : msg), where);
        return;
      }
      this.log(key, lv === 'warning' ? 'warning' : lv === 'error' ? 'error' : 'info', msg, where);
    });
    wc.on('render-process-gone', (_e, d) => this.log(key, 'error', 'Страница упала: ' + d.reason));
    wc.on('did-fail-load', (_e, code, desc, url, isMain) => {
      if (isMain && code !== -3) this.log(key, 'error', 'Не загрузилось: ' + desc + ' ' + String(url).slice(0, 200));
    });
    wc.on('before-input-event', (e, input) => {
      if (input.type !== 'keyDown') return;
      if (input.key === 'F12') {
        wc.toggleDevTools();
        e.preventDefault();
      } else if (input.key === 'F5' || (input.control && input.key.toLowerCase() === 'r')) {
        run.logs = [];
        this.notify('run:log', { key, clear: true });
        wc.reloadIgnoringCache();
        e.preventDefault();
      }
    });
    win.on('closed', () => {
      run.win = null;
      run.ses.clearStorageData().catch(() => {});
      run.ses.clearCache().catch(() => {});
      this.runs.delete(key);
      this.notify('run:closed', { key });
    });
    win.loadURL(this.url(key, run.start));
    return win;
  }

  closeAll() {
    for (const run of this.runs.values()) if (run.win && !run.win.isDestroyed()) run.win.close();
  }
}

module.exports = { Runner, schemePrivileges, SCHEME, pickStart };
