'use strict';
// Материалы студии: загрузка в R2 и скачивание из R2.
//
// Сервер выдаёт одноразовую ссылку на один файл, файл идёт между этим компьютером и R2
// напрямую. Ключей R2 у приложения нет. Интерфейс не видит путей к файлам: он получает
// метку (token) выбранного или перетащенного файла, путь знает только главный процесс.

const { dialog, net, shell } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');

const err = (code) => Object.assign(new Error(code), { code });

// Имя файла или папки, которое примет Windows.
function safeName(s) {
  let n = String(s || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').trim().slice(0, 150);
  if (!n) n = '_';
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(n)) n = '_' + n;
  return n;
}

class Materials {
  constructor({ client, notify, window }) {
    this.client = client;
    this.notify = notify; // (канал, данные) -> интерфейс
    this.window = window; // () -> главное окно (для окон выбора файла)
    this.files = new Map(); // token -> { path, name, size }
    this.jobs = new Map(); // token или 'd'+id -> AbortController
    this.saved = new Set(); // куда сохраняли: только их можно показать в проводнике
  }

  // Файл, который человек выбрал или перетащил: запоминаем путь, наружу отдаём метку.
  register(p) {
    let st;
    try {
      st = fs.statSync(p);
    } catch {
      return null;
    }
    if (!st.isFile()) return null;
    const token = crypto.randomBytes(9).toString('hex');
    this.files.set(token, { path: p, name: path.basename(p), size: st.size });
    return { token, name: path.basename(p), size: st.size };
  }

  async pick() {
    const r = await dialog.showOpenDialog(this.window(), {
      title: 'Загрузить материалы',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Видео, музыка, фото', extensions: ['mp4', 'mov', 'm4v', 'webm', 'mkv', 'mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac', 'png', 'jpg', 'jpeg', 'webp', 'gif'] },
      ],
    });
    if (r.canceled) return [];
    return r.filePaths.map((p) => this.register(p)).filter(Boolean);
  }

  progress(token, sent, total, stage) {
    this.notify('mat:progress', { token, sent, total, stage });
  }

  async upload({ token, project, folder }) {
    const f = this.files.get(token);
    if (!f) throw err('not_found');
    const start = await this.client.request('POST', '/api/materials/projects/' + project + '/files', { name: f.name, size: f.size, folder: folder || '' });
    const ctl = new AbortController();
    this.jobs.set(token, ctl);
    try {
      await this.put(start.url, f, token, ctl.signal);
      this.progress(token, f.size, f.size, 'check');
      const done = await this.client.request('POST', '/api/materials/files/' + start.file.id + '/done', {}, { timeout: 60000 });
      this.files.delete(token);
      return done;
    } catch (e) {
      if (ctl.signal.aborted) throw err('cancelled');
      throw e.code ? e : err('r2_upload_failed');
    } finally {
      this.jobs.delete(token);
    }
  }

  // PUT файла по подписанной ссылке: с точной длиной (R2 не принимает загрузку без неё).
  put(url, f, token, signal) {
    const https = require('https');
    const http = require('http');
    const u = new URL(url);
    const mod = u.protocol === 'http:' ? http : https; // http только для проверки на своём компьютере
    return new Promise((resolve, reject) => {
      let sent = 0;
      let last = 0;
      const src = fs.createReadStream(f.path, { highWaterMark: 1 << 20 });
      const req = mod.request(u, { method: 'PUT', headers: { 'Content-Length': f.size }, signal }, (res) => {
        res.resume();
        if (res.statusCode >= 200 && res.statusCode < 300) resolve();
        else reject(err('r2_upload_failed'));
      });
      req.on('error', reject);
      src.on('error', (e) => req.destroy(e));
      src.on('data', (chunk) => {
        sent += chunk.length;
        if (Date.now() - last > 250) {
          last = Date.now();
          this.progress(token, sent, f.size, 'up');
        }
      });
      src.pipe(req);
    });
  }

  cancel(token) {
    const c = this.jobs.get(token);
    if (c) c.abort();
    return !!c;
  }

  async download(id) {
    const info = await this.client.request('GET', '/api/materials/files/' + id + '/url');
    const r = await dialog.showSaveDialog(this.window(), { title: 'Сохранить', defaultPath: info.name });
    if (r.canceled || !r.filePath) return { saved: false };
    const key = 'd' + id;
    const ctl = new AbortController();
    this.jobs.set(key, ctl);
    const part = r.filePath + '.part';
    try {
      const res = await net.fetch(info.url, { signal: ctl.signal });
      if (!res.ok || !res.body) throw err('r2_download_failed');
      let got = 0;
      let last = 0;
      const out = fs.createWriteStream(part);
      const body = Readable.fromWeb(res.body);
      body.on('data', (chunk) => {
        got += chunk.length;
        if (Date.now() - last > 250) {
          last = Date.now();
          this.progress(key, got, info.bytes, 'down');
        }
      });
      await new Promise((resolve, reject) => {
        body.on('error', reject);
        out.on('error', reject);
        out.on('finish', resolve);
        body.pipe(out);
      });
      fs.renameSync(part, r.filePath);
      this.saved.add(r.filePath);
      this.progress(key, info.bytes, info.bytes, 'done');
      return { saved: true, file: r.filePath };
    } catch (e) {
      fs.unlink(part, () => {});
      if (ctl.signal.aborted) throw err('cancelled');
      throw e.code ? e : err('r2_download_failed');
    } finally {
      this.jobs.delete(key);
    }
  }

  // Весь проект в выбранную папку: <папка>/<проект>/<папка файла>/<имя>. Файл того же
  // размера, что уже лежит на месте, пропускается: повторный запуск докачивает только новое.
  async downloadProject(project) {
    const ov = await this.client.request('GET', '/api/materials');
    const p = (ov.projects || []).find((x) => x.id === project);
    if (!p) throw err('not_found');
    const { files } = await this.client.request('GET', '/api/materials/projects/' + project + '/files');
    const r = await dialog.showOpenDialog(this.window(), { title: 'Куда сохранить проект "' + p.title + '"', properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled || !r.filePaths[0]) return { saved: false };
    const root = path.join(r.filePaths[0], safeName(p.title));
    const key = 'p' + project;
    const ctl = new AbortController();
    this.jobs.set(key, ctl);
    const total = files.reduce((n, f) => n + f.bytes, 0);
    let done = 0;
    let skipped = 0;
    let got = 0;
    const used = new Set();
    try {
      for (const f of files) {
        if (ctl.signal.aborted) throw err('cancelled');
        const dir = f.folder ? path.join(root, safeName(f.folder)) : root;
        let name = safeName(f.name);
        // Два файла с одним именем в одной папке: ко второму дописываем номер.
        if (used.has(path.join(dir, name).toLowerCase())) {
          const ext = path.extname(name);
          name = path.basename(name, ext) + ' (' + f.id + ')' + ext;
        }
        used.add(path.join(dir, name).toLowerCase());
        const target = path.join(dir, name);
        let size = -1;
        try {
          size = fs.statSync(target).size;
        } catch {
          /* ещё нет */
        }
        if (size === f.bytes) {
          skipped++;
          done++;
          got += f.bytes;
          this.notify('mat:progress', { token: key, sent: got, total, stage: 'bulk', done, count: files.length, skipped });
          continue;
        }
        fs.mkdirSync(dir, { recursive: true });
        const info = await this.client.request('GET', '/api/materials/files/' + f.id + '/url?inline=1');
        const res = await net.fetch(info.url, { signal: ctl.signal });
        if (!res.ok || !res.body) throw err('r2_download_failed');
        const part = target + '.part';
        const out = fs.createWriteStream(part);
        const body = Readable.fromWeb(res.body);
        let last = 0;
        const base = got;
        let mine = 0;
        body.on('data', (chunk) => {
          mine += chunk.length;
          if (Date.now() - last > 250) {
            last = Date.now();
            this.notify('mat:progress', { token: key, sent: base + mine, total, stage: 'bulk', done, count: files.length, skipped });
          }
        });
        try {
          await new Promise((resolve, reject) => {
            body.on('error', reject);
            out.on('error', reject);
            out.on('finish', resolve);
            body.pipe(out);
          });
          fs.renameSync(part, target);
        } catch (e) {
          fs.unlink(part, () => {});
          throw e;
        }
        got += f.bytes;
        done++;
        this.notify('mat:progress', { token: key, sent: got, total, stage: 'bulk', done, count: files.length, skipped });
      }
      this.saved.add(root);
      return { saved: true, folder: root, count: files.length, skipped };
    } catch (e) {
      if (ctl.signal.aborted) throw err('cancelled');
      throw e.code ? e : err('r2_download_failed');
    } finally {
      this.jobs.delete(key);
    }
  }

  // Ссылка для просмотра внутри приложения (картинка, видео, звук), 15 минут.
  async previewUrl(id) {
    const info = await this.client.request('GET', '/api/materials/files/' + id + '/url?inline=1');
    if (!/^https:\/\/[a-z0-9.-]+\.r2\.cloudflarestorage\.com\//i.test(info.url)) throw err('bad_url');
    return info;
  }

  showFile(p) {
    if (typeof p !== 'string' || !this.saved.has(p) || !fs.existsSync(p)) return;
    if (fs.statSync(p).isDirectory()) shell.openPath(p);
    else shell.showItemInFolder(p);
  }
}

module.exports = { Materials };
