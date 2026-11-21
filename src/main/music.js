'use strict';
// Музыка в фоне: студийные треки из папки на GitHub, своя папка с музыкой или онлайн-радио.
// Интерфейс играет их через адреса twmusic://, сам в сеть и к файлам не ходит.
//
//   twmusic://studio/<sha>   студийный трек: с диска, если уже скачан, иначе с GitHub
//                            (сразу играет и одновременно сохраняется в кеш)
//   twmusic://folder/<n>     файл из выбранной папки (только из неё)
//   twmusic://radio/<n>      радиостанция из настроек (ссылки .m3u и .pls разбираются)
//
// Список студийных треков берётся у GitHub раз в 6 часов и хранится на диске, поэтому
// скачанные треки играют и без интернета. Кеш не больше 800 МБ: старые треки удаляются.

const { app, protocol, net, dialog } = require('electron');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { pathToFileURL } = require('url');

const SCHEME = 'twmusic';
const musicPrivileges = { scheme: SCHEME, privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } };
const AUDIO = /\.(mp3|ogg|oga|opus|m4a|aac|wav|flac|webm)$/i;
const TYPES = { '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.wav': 'audio/wav', '.flac': 'audio/flac', '.webm': 'audio/webm' };
const CACHE_MAX = 800 * 1024 * 1024;
const LIST_TTL = 6 * 3600 * 1000;
const FOLDER_MAX = 3000;

const err = (code) => Object.assign(new Error(code), { code });
const typeOf = (name) => TYPES[path.extname(name).toLowerCase()] || 'audio/mpeg';
// Подчёркивания становятся пробелами, кроме размеров вроде 3_4.
const titleOf = (name) => path.basename(name, path.extname(name)).replace(/(?<!\d)_+|_+(?!\d)/g, ' ').replace(/\s+/g, ' ').trim();

class Music {
  constructor({ config, settings }) {
    const m = (config && config.music) || {};
    this.repo = /^[\w.-]+\/[\w.-]+$/.test(m.repo || '') ? m.repo : 'Yourssugar/twenty-words-studio';
    this.path = typeof m.path === 'string' && !m.path.includes('..') ? m.path.replace(/^\/+|\/+$/g, '') : 'music';
    this.branch = /^[\w./-]+$/.test(m.branch || '') ? m.branch : '';
    this.settings = settings;
    this.dir = path.join(app.getPath('userData'), 'music');
    this.cacheDir = path.join(this.dir, 'cache');
    this.listFile = path.join(this.dir, 'studio.json');
    this.studio = null; // { at, items: [{ id, name, title, size, url }] }
    this.folder = { root: '', files: [] };
  }

  // ---------- студийные треки ----------

  readList() {
    try {
      return JSON.parse(fs.readFileSync(this.listFile, 'utf8'));
    } catch {
      return null;
    }
  }

  async studioList(force = false) {
    if (!this.studio) this.studio = this.readList();
    if (this.studio && !force && Date.now() - this.studio.at < LIST_TTL) return this.studio.items;
    const enc = this.path.split('/').map(encodeURIComponent).join('/');
    const url = `https://api.github.com/repos/${this.repo}/contents/${enc}` + (this.branch ? '?ref=' + encodeURIComponent(this.branch) : '');
    try {
      const res = await net.fetch(url, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'TwentyWordsStudio' } });
      if (res.status === 404) throw err('music_none');
      if (!res.ok) throw err('music_offline');
      const data = await res.json();
      const items = (Array.isArray(data) ? data : [])
        .filter((f) => f.type === 'file' && AUDIO.test(f.name) && /^[0-9a-f]{40}$/.test(f.sha) && /^https:\/\/raw\.githubusercontent\.com\//.test(f.download_url || ''))
        .map((f) => ({ id: f.sha, name: f.name, title: titleOf(f.name), size: f.size, url: f.download_url }));
      this.studio = { at: Date.now(), items };
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(this.listFile, JSON.stringify(this.studio));
      return items;
    } catch (e) {
      if (this.studio) return this.studio.items; // нет сети: играем то, что знаем
      throw e.code ? e : err('music_offline');
    }
  }

  cachedPath(item) {
    return path.join(this.cacheDir, item.id + path.extname(item.name).toLowerCase());
  }

  cachedIds() {
    try {
      return new Set(fs.readdirSync(this.cacheDir).filter((f) => !f.endsWith('.part')).map((f) => f.replace(/\.[^.]+$/, '')));
    } catch {
      return new Set();
    }
  }

  trimCache() {
    let files;
    try {
      files = fs.readdirSync(this.cacheDir).map((f) => {
        const p = path.join(this.cacheDir, f);
        const st = fs.statSync(p);
        return { p, size: st.size, t: st.mtimeMs };
      });
    } catch {
      return;
    }
    let total = files.reduce((n, f) => n + f.size, 0);
    files.sort((a, b) => a.t - b.t);
    for (const f of files) {
      if (total <= CACHE_MAX) break;
      try {
        fs.unlinkSync(f.p);
        total -= f.size;
      } catch {
        /* занят */
      }
    }
  }

  async serveStudio(id, req) {
    const items = this.studio ? this.studio.items : await this.studioList();
    const item = items.find((x) => x.id === id);
    if (!item) return new Response('not found', { status: 404 });
    const file = this.cachedPath(item);
    if (fs.existsSync(file)) {
      const now = new Date();
      fs.utimes(file, now, now, () => {}); // недавно игравшие из кеша не удаляются
      return this.serveFile(file, req);
    }
    const res = await net.fetch(item.url);
    if (!res.ok || !res.body) return new Response('upstream', { status: 502 });
    // Играем сразу и параллельно сохраняем на диск.
    const [play, save] = res.body.tee();
    fs.mkdirSync(this.cacheDir, { recursive: true });
    const part = file + '.part';
    const out = fs.createWriteStream(part);
    Readable.fromWeb(save)
      .on('error', () => out.destroy())
      .pipe(out)
      .on('finish', () => {
        fs.rename(part, file, () => this.trimCache());
      })
      .on('error', () => fs.unlink(part, () => {}));
    return new Response(play, { status: 200, headers: { 'Content-Type': typeOf(item.name) } });
  }

  // ---------- своя папка ----------

  scanFolder() {
    const root = this.settings().musicFolder;
    if (!root) return (this.folder = { root: '', files: [] });
    if (this.folder.root === root && this.folder.files.length) return this.folder;
    const files = [];
    const walk = (dir, depth) => {
      let list;
      try {
        list = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const d of list) {
        if (files.length >= FOLDER_MAX) return;
        const p = path.join(dir, d.name);
        if (d.isDirectory() && depth < 3 && !d.name.startsWith('.')) walk(p, depth + 1);
        else if (d.isFile() && AUDIO.test(d.name)) files.push(p);
      }
    };
    walk(root, 0);
    files.sort((a, b) => a.localeCompare(b));
    this.folder = { root, files };
    return this.folder;
  }

  async pickFolder(parent) {
    const r = await dialog.showOpenDialog(parent, { title: 'Папка с музыкой', properties: ['openDirectory'] });
    if (r.canceled || !r.filePaths[0]) return null;
    return r.filePaths[0];
  }

  folderInfo() {
    const f = this.scanFolder();
    return { folder: f.root, tracks: f.files.map((p, i) => ({ id: String(i), title: titleOf(p) })) };
  }

  serveFolder(n, req) {
    const f = this.scanFolder();
    const file = f.files[Number(n)];
    const root = path.resolve(f.root) + path.sep;
    if (!file || !path.resolve(file).startsWith(root)) return new Response('not found', { status: 404 });
    return this.serveFile(file, req);
  }

  serveFile(file, req) {
    const headers = {};
    const range = req.headers.get('Range');
    if (range) headers.Range = range;
    return net.fetch(pathToFileURL(file).toString(), { headers });
  }

  // ---------- радио ----------

  async serveRadio(n) {
    const st = this.settings().musicRadios[Number(n)];
    if (!st) return new Response('not found', { status: 404 });
    let url = st.url;
    // Ссылка на плейлист: берём первый поток из него.
    if (/\.(m3u8?|pls)(\?|$)/i.test(url)) {
      const pl = await net.fetch(url);
      const text = (await pl.text()).slice(0, 20000);
      const m = /^(?:File\d+=)?\s*(https?:\/\/\S+)/im.exec(text);
      if (!m) return new Response('bad playlist', { status: 502 });
      url = m[1];
    }
    const res = await net.fetch(url, { headers: { 'Icy-MetaData': '0', 'User-Agent': 'TwentyWordsStudio' } });
    if (!res.ok || !res.body) return new Response('upstream', { status: 502 });
    const type = res.headers.get('content-type') || 'audio/mpeg';
    if (!/^audio\/|application\/ogg|video\/mp2t/i.test(type)) return new Response('not audio', { status: 415 });
    return new Response(res.body, { status: 200, headers: { 'Content-Type': type } });
  }

  // ---------- протокол ----------

  setupProtocol() {
    protocol.handle(SCHEME, async (req) => {
      try {
        const u = new URL(req.url);
        const id = decodeURIComponent(u.pathname.replace(/^\//, ''));
        if (u.hostname === 'studio' && /^[0-9a-f]{40}$/.test(id)) return await this.serveStudio(id, req);
        if (u.hostname === 'folder' && /^\d+$/.test(id)) return await this.serveFolder(id, req);
        if (u.hostname === 'radio' && /^\d+$/.test(id)) return await this.serveRadio(id);
        return new Response('not found', { status: 404 });
      } catch {
        return new Response('error', { status: 502 });
      }
    });
  }

  async studioInfo(force) {
    const items = await this.studioList(force);
    const cached = this.cachedIds();
    return { repo: this.repo, path: this.path, tracks: items.map((x) => ({ id: x.id, title: x.title, cached: cached.has(x.id) })) };
  }
}

module.exports = { Music, musicPrivileges, SCHEME };
