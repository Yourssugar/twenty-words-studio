// Инструменты кузницы (FORGE) с сайта: скачиваются по кнопке, а не входят в установщик.
//
// Список пакетов, их размеры и sha256 лежат в data/tools.json внутри приложения.
// Пакет: tar.gz с файлами в тех же путях, что на сайте (grafika/..., HTML-CSS-JS/...).
// Все пакеты распаковываются в одну папку userData/tools/forge: инструменты ссылаются
// на общие файлы друг друга (HTML-CSS-JS/engine.js и другие), как на сайте.
// Открываются в отдельном окне по адресу twtool://forge/<папка>/ в своей сессии:
// у окна нет доступа ни к токену студии, ни к Node.

const { app, BrowserWindow, protocol, session, shell } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { Readable } = require('stream');

const SCHEME = 'twtool';
const PARTITION = 'persist:forge';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.onnx': 'application/octet-stream',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.gif': 'image/gif',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

// Схему надо объявить до готовности приложения: тогда у страниц инструментов
// обычное происхождение (origin) и работают localStorage и IndexedDB.
// Свои схемы регистрируются одним вызовом до готовности приложения: повторный вызов затирает прежний.
function registerScheme(extra = []) {
  protocol.registerSchemesAsPrivileged([
    { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
    ...extra,
  ]);
}

class Tools {
  constructor({ root, notify, onWindow }) {
    this.root = root; // папка приложения
    this.onWindow = onWindow || (() => {}); // окно открыто: развернуть по настройке, F11
    this.notify = notify; // (канал, данные) -> интерфейс
    this.dir = path.join(app.getPath('userData'), 'tools');
    this.forge = path.join(this.dir, 'forge');
    this.stateFile = path.join(this.dir, 'installed.json');
    this.busy = new Map(); // id -> AbortController
    this.windows = new Map(); // id -> окно
    this.manifest = this.readManifest();
  }

  readManifest() {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(this.root, 'data', 'tools.json'), 'utf8'));
      if (process.env.TW_TOOLS_BASE && !app.isPackaged) m.base = process.env.TW_TOOLS_BASE; // для проверки с локального сервера
      return m;
    } catch {
      return { base: '', tools: [] };
    }
  }

  readState() {
    try {
      return JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
    } catch {
      return {};
    }
  }

  writeState(st) {
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = this.stateFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(st, null, 2));
    fs.renameSync(tmp, this.stateFile);
  }

  tool(id) {
    const t = this.manifest.tools.find((x) => x.id === id);
    if (!t) throw Object.assign(new Error('not_found'), { code: 'not_found' });
    return t;
  }

  list() {
    const st = this.readState();
    return this.manifest.tools.map((t) => ({
      id: t.id,
      name: t.name,
      desc: t.desc,
      size: t.size,
      version: t.version,
      installed: st[t.id] ? st[t.id].version : null,
      update: !!(st[t.id] && st[t.id].version !== t.version),
      busy: this.busy.has(t.id),
    }));
  }

  // ---------- установка ----------

  async install(id) {
    const t = this.tool(id);
    if (this.busy.has(id)) throw Object.assign(new Error('busy'), { code: 'busy' });
    // Свой адрес релиза у инструмента, который не менялся с прошлой упаковки (pack-tools.js).
    const local = process.env.TW_TOOLS_BASE && !app.isPackaged;
    const base = local ? this.manifest.base : t.base || this.manifest.base;
    if (!local && !/^https:\/\//.test(base)) {
      throw Object.assign(new Error('no_source'), { code: 'no_source' });
    }
    const ctrl = new AbortController();
    this.busy.set(id, ctrl);
    const tmp = path.join(this.dir, `.${id}.download`);
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      await this.download(base.replace(/\/$/, '') + '/' + t.file, tmp, t, ctrl.signal);
      this.notify('tools:progress', { id, phase: 'unpack' });
      const files = await extractTarGz(tmp, this.forge, t.paths);
      const st = this.readState();
      st[id] = { version: t.version, files };
      this.writeState(st);
      return this.list();
    } finally {
      this.busy.delete(id);
      fs.rmSync(tmp, { force: true });
    }
  }

  async download(url, file, t, signal) {
    let res;
    try {
      res = await fetch(url, { signal, redirect: 'follow' });
    } catch (err) {
      if (err.name === 'AbortError') throw Object.assign(err, { code: 'cancelled' });
      throw Object.assign(new Error('network'), { code: 'network' });
    }
    if (!res.ok || !res.body) throw Object.assign(new Error('download_failed'), { code: 'download_failed' });
    const hash = crypto.createHash('sha256');
    const out = fs.createWriteStream(file);
    let got = 0;
    let lastSent = 0;
    try {
      for await (const chunk of res.body) {
        got += chunk.length;
        if (got > t.size * 1.05 + 1024) throw Object.assign(new Error('bad_package'), { code: 'bad_package' });
        hash.update(chunk);
        if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
        const now = Date.now();
        if (now - lastSent > 150) {
          lastSent = now;
          this.notify('tools:progress', { id: t.id, phase: 'download', got, size: t.size });
        }
      }
    } catch (err) {
      if (err.name === 'AbortError') throw Object.assign(new Error('cancelled'), { code: 'cancelled' });
      throw err;
    } finally {
      await new Promise((r) => out.end(r));
    }
    // Пакет должен совпасть байт в байт с тем, что записано в приложении.
    if (hash.digest('hex') !== t.sha256) throw Object.assign(new Error('bad_package'), { code: 'bad_package' });
  }

  cancel(id) {
    const c = this.busy.get(id);
    if (c) c.abort();
    return true;
  }

  // Удаляются только файлы, которые не нужны другим установленным инструментам.
  remove(id) {
    this.tool(id);
    const w = this.windows.get(id);
    if (w && !w.isDestroyed()) w.close();
    const st = this.readState();
    if (!st[id]) return this.list();
    const keep = new Set();
    for (const [other, info] of Object.entries(st)) if (other !== id) for (const f of info.files) keep.add(f);
    for (const f of st[id].files) {
      if (keep.has(f)) continue;
      const abs = safeJoin(this.forge, f);
      if (abs) fs.rmSync(abs, { force: true });
    }
    delete st[id];
    this.writeState(st);
    pruneEmptyDirs(this.forge);
    return this.list();
  }

  // ---------- окно инструмента ----------

  setupSession() {
    const ses = session.fromPartition(PARTITION);
    ses.setPermissionRequestHandler((_wc, perm, cb) => cb(perm === 'clipboard-sanitized-write'));
    ses.protocol.handle(SCHEME, (req) => this.serve(req));
    return ses;
  }

  async serve(req) {
    const url = new URL(req.url);
    if (url.hostname !== 'forge') return new Response('not found', { status: 404 });
    let rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    if (rel === '' || rel.endsWith('/')) rel += 'index.html';
    const file = safeJoin(this.forge, rel);
    if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      if (rel.endsWith('index.html')) return htmlResponse(notInstalledPage(), 404);
      return new Response('not found', { status: 404 });
    }
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    return new Response(Readable.toWeb(fs.createReadStream(file)), {
      headers: { 'Content-Type': type, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' },
    });
  }

  open(id) {
    const t = this.tool(id);
    const st = this.readState();
    if (!st[id]) throw Object.assign(new Error('not_installed'), { code: 'not_installed' });
    const old = this.windows.get(id);
    if (old && !old.isDestroyed()) {
      if (old.isMinimized()) old.restore();
      old.focus();
      return true;
    }
    const w = new BrowserWindow({
      width: 1360,
      height: 860,
      minWidth: 900,
      minHeight: 600,
      title: t.name + ' · Twenty Words Studio',
      backgroundColor: '#0c0e12',
      autoHideMenuBar: true,
      icon: path.join(this.root, 'src', 'assets', 'icon.png'),
      webPreferences: { partition: PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: true },
    });
    // Внутри окна можно ходить между инструментами кузницы, всё остальное открывается в браузере.
    w.webContents.on('will-navigate', (e, url) => {
      if (url.startsWith(SCHEME + '://forge/')) return;
      e.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    });
    w.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
    w.loadURL(`${SCHEME}://forge/${t.entry}`);
    this.onWindow(w);
    this.windows.set(id, w);
    w.on('closed', () => this.windows.delete(id));
    return true;
  }
}

function htmlResponse(html, status = 200) {
  return new Response(html, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

function notInstalledPage() {
  return `<!doctype html><meta charset="utf-8"><title>Не установлено</title>
<body style="margin:0;height:100vh;display:grid;place-items:center;background:#0c0e12;color:#dfe5ea;font:15px 'Segoe UI',system-ui,sans-serif;text-align:center">
<div><b style="font-size:19px">Этот инструмент не установлен</b>
<p style="color:#8994a0;max-width:42ch;line-height:1.6">Скачайте его в приложении на вкладке «Инструменты» и откройте снова.</p>
<p><a href="javascript:history.back()" style="color:#e9a23b">Назад</a></p></div></body>`;
}

// Путь внутри папки, без выхода наружу через .. и абсолютные пути.
function safeJoin(base, rel) {
  if (typeof rel !== 'string' || rel.includes('\0') || path.isAbsolute(rel)) return null;
  const abs = path.resolve(base, rel);
  if (abs !== base && !abs.startsWith(base + path.sep)) return null;
  return abs;
}

function pruneEmptyDirs(dir) {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const p = path.join(dir, e.name);
    pruneEmptyDirs(p);
    if (fs.readdirSync(p).length === 0) fs.rmdirSync(p);
  }
}

// Минимальный разбор tar (формат ustar): только обычные файлы и папки.
// allowed: префиксы путей, которые пакету разрешено записывать.
async function extractTarGz(file, dest, allowed) {
  const data = zlib.gunzipSync(fs.readFileSync(file));
  const files = [];
  const writes = [];
  let off = 0;
  while (off + 512 <= data.length) {
    const hdr = data.subarray(off, off + 512);
    if (hdr.every((b) => b === 0)) break;
    const str = (a, b) => hdr.subarray(a, b).toString('utf8').replace(/\0.*$/s, '');
    const name = str(0, 100);
    const prefix = str(345, 500);
    const size = parseInt(str(124, 136).trim() || '0', 8);
    const type = String.fromCharCode(hdr[156] || 48);
    const full = (prefix ? prefix + '/' : '') + name;
    off += 512;
    const body = data.subarray(off, off + size);
    off += Math.ceil(size / 512) * 512;
    if (type === '5') continue; // папки создаются по ходу
    if (type !== '0') throw Object.assign(new Error('bad_package'), { code: 'bad_package' });
    const rel = full.replace(/^\.\//, '');
    if (!allowed.some((p) => rel === p || rel.startsWith(p.endsWith('/') ? p : p + '/'))) {
      throw Object.assign(new Error('bad_package'), { code: 'bad_package' });
    }
    const abs = safeJoin(dest, rel);
    if (!abs) throw Object.assign(new Error('bad_package'), { code: 'bad_package' });
    writes.push([abs, Buffer.from(body)]);
    files.push(rel);
  }
  // Пишем только после того, как весь архив проверен.
  for (const [abs, body] of writes) {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  return files;
}

module.exports = { Tools, registerScheme, extractTarGz, safeJoin };
