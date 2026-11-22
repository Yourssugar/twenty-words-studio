'use strict';
// Память помощника Core: шифрование и синхронизация с сервером.
//
// Ключ выводится из пароля при входе (scrypt, соль с сервера). Пароль и ключ на сервер
// не уходят, сервер хранит только шифротекст (AES-256-GCM). На этом компьютере ключ
// лежит под защитой Windows (safeStorage), чтобы не спрашивать пароль при каждом запуске.
// Пока ключа нет (вошли раньше, чем появилась Core), память копится на компьютере и
// при следующем входе с паролем сливается с серверной.
//
// Два компьютера пишут одновременно: сервер отвечает 409, мы берём его версию и
// прибавляем к ней то, что накопили с прошлой синхронизации (merge).

const { app, safeStorage } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 << 20 };

// Поля, которые сливаются не сложением.
const MIN_KEYS = new Set(['first']);
const MAX_KEYS = new Set(['lastAt', 'streak', 'bestStreak', 'hello', 'met']);
const MAX_TREES = new Set(['shown', 'topics', 'off', 'seenViews', 'ticketsSeen']); // внутри: время или флаг
const KEEP_TREES = new Set(['me']); // как обращаться: берём новее

// merge(S, M, B): S с сервера, M у нас, B то, что было на сервере при прошлой синхронизации.
function merge(S, M, B, key = '') {
  S = S || {};
  M = M || {};
  B = B || {};
  const out = {};
  for (const k of new Set([...Object.keys(S), ...Object.keys(M)])) {
    const s = S[k];
    const m = M[k];
    const b = B[k];
    if (MAX_TREES.has(key) || MAX_KEYS.has(k)) {
      out[k] = typeof s === 'number' || typeof m === 'number' ? Math.max(s || 0, m || 0) : m !== undefined ? m : s;
    } else if (MIN_KEYS.has(k)) {
      out[k] = Math.min(...[s, m].filter((x) => typeof x === 'number' && x > 0)) || 0;
    } else if (KEEP_TREES.has(k)) {
      out[k] = JSON.stringify(m) !== JSON.stringify(b) && m !== undefined ? m : s;
    } else if (m && typeof m === 'object' && !Array.isArray(m)) {
      out[k] = merge(s, m, b, k);
    } else if (typeof m === 'number' && (typeof s === 'number' || s === undefined)) {
      out[k] = (s || 0) + (m - (typeof b === 'number' ? b : 0));
    } else {
      out[k] = m !== undefined && JSON.stringify(m) !== JSON.stringify(b) ? m : s !== undefined ? s : m;
    }
  }
  return out;
}

class Core {
  constructor({ client }) {
    this.client = client;
    this.uid = 0;
    this.key = null; // Buffer 32
    this.mem = null; // расшифрованная память
    this.base = {}; // как было на сервере при последней синхронизации
    this.version = 0;
    this.salt = '';
  }

  file(kind) {
    return path.join(app.getPath('userData'), `core-${kind}-${this.uid}.bin`);
  }

  readProtected(kind) {
    try {
      const raw = fs.readFileSync(this.file(kind));
      return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(raw) : null;
    } catch {
      return null;
    }
  }

  writeProtected(kind, text) {
    if (!safeStorage.isEncryptionAvailable()) return;
    try {
      fs.writeFileSync(this.file(kind), safeStorage.encryptString(text));
    } catch {
      /* не критично */
    }
  }

  drop(kind) {
    try {
      fs.unlinkSync(this.file(kind));
    } catch {
      /* нет файла */
    }
  }

  derive(password, salt) {
    return crypto.scryptSync(String(password), Buffer.from(salt, 'base64'), 32, SCRYPT);
  }

  seal(obj) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const body = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
    return Buffer.concat([Buffer.from([1]), iv, c.getAuthTag(), body]).toString('base64');
  }

  open(blob, key = this.key) {
    if (!blob || !key) return null;
    try {
      const raw = Buffer.from(blob, 'base64');
      if (raw[0] !== 1) return null;
      const d = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(1, 13));
      d.setAuthTag(raw.subarray(13, 29));
      return JSON.parse(Buffer.concat([d.update(raw.subarray(29)), d.final()]).toString('utf8'));
    } catch {
      return null; // пароль сброшен или чужой ключ
    }
  }

  // Вход с паролем: выводим ключ, забираем память с сервера, вливаем накопленное локально.
  async onPassword(uid, password) {
    this.uid = uid;
    try {
      const srv = await this.client.request('GET', '/api/helper');
      this.key = this.derive(password, srv.salt);
      this.salt = srv.salt;
      this.version = srv.version;
      const server = this.open(srv.blob) || {};
      const local = this.readLocal();
      this.base = server;
      this.mem = local ? merge(server, local, {}) : server;
      this.writeProtected('key', this.key.toString('base64') + ':' + this.salt);
      this.drop('local');
      if (local) await this.push();
    } catch {
      /* сервер старый или недоступен: Core поработает на локальной памяти */
    }
  }

  readLocal() {
    const t = this.readProtected('local');
    try {
      return t ? JSON.parse(t) : null;
    } catch {
      return null;
    }
  }

  // Запуск без пароля (сохранённый вход): ключ с этого компьютера, если есть.
  async load(uid) {
    if (this.uid === uid && this.mem) return this.mem;
    this.uid = uid;
    const saved = this.readProtected('key');
    if (saved) {
      const [k, salt] = saved.split(':');
      this.key = Buffer.from(k, 'base64');
      this.salt = salt;
      try {
        const srv = await this.client.request('GET', '/api/helper');
        if (srv.salt !== this.salt) {
          // Пароль сменили на другом компьютере: этот ключ больше не подходит.
          this.key = null;
          this.drop('key');
        } else {
          this.version = srv.version;
          this.base = this.open(srv.blob) || {};
          this.mem = this.base;
          return this.mem;
        }
      } catch {
        /* нет связи: работаем на локальной копии */
      }
    }
    this.mem = this.readLocal() || {};
    return this.mem;
  }

  // Сохранить: на сервер, если есть ключ, иначе на компьютер.
  async save(mem) {
    this.mem = mem;
    if (!this.key) {
      this.writeProtected('local', JSON.stringify(mem));
      return { mem };
    }
    return this.push();
  }

  async push() {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await this.client.request('PUT', '/api/helper', { blob: this.seal(this.mem), version: this.version });
        this.version = r.version;
        this.base = JSON.parse(JSON.stringify(this.mem));
        return { mem: this.mem };
      } catch (e) {
        if (e.code !== 'version_conflict') {
          this.writeProtected('local', JSON.stringify(this.mem));
          return { mem: this.mem };
        }
        const srv = await this.client.request('GET', '/api/helper');
        if (srv.salt !== this.salt) {
          this.key = null;
          this.drop('key');
          this.writeProtected('local', JSON.stringify(this.mem));
          return { mem: this.mem };
        }
        this.version = srv.version;
        const server = this.open(srv.blob) || {};
        this.mem = merge(server, this.mem, this.base);
        this.base = server;
      }
    }
    return { mem: this.mem };
  }

  // Пароль сменили в этом приложении: новая соль, память перешифровывается.
  async rekey(password) {
    if (!this.mem || !this.uid) return;
    const salt = crypto.randomBytes(16).toString('base64');
    const key = this.derive(password, salt);
    const oldKey = this.key;
    try {
      const srv = await this.client.request('GET', '/api/helper');
      this.key = key;
      const blob = this.seal(this.mem);
      this.key = oldKey;
      const r = await this.client.request('PUT', '/api/helper', { blob, version: srv.version, salt });
      this.key = key;
      this.salt = salt;
      this.version = r.version;
      this.base = JSON.parse(JSON.stringify(this.mem));
      this.writeProtected('key', key.toString('base64') + ':' + salt);
    } catch {
      // Не вышло: старый ключ к новому паролю не подходит, дальше копим память на этом компьютере
      // и вольём её при следующем входе с паролем.
      this.key = null;
      this.drop('key');
      this.writeProtected('local', JSON.stringify(this.mem));
    }
  }

  async forget() {
    this.mem = {};
    this.base = {};
    this.drop('local');
    try {
      const srv = await this.client.request('DELETE', '/api/helper');
      this.version = srv.version;
    } catch {
      /* сервер недоступен */
    }
    return {};
  }

  logout() {
    this.drop('key');
    this.key = null;
    this.mem = null;
    this.base = {};
    this.uid = 0;
  }
}

module.exports = { Core, merge };
