// Связь с сервером tw-studio. Модуль не знает про Electron: fetch, WebSocket и
// хранилище токена передаются снаружи, поэтому его можно проверить обычным node.
//
// События (EventEmitter):
//   'event'  (ev)      любое сообщение сервера по WebSocket (msg, presence, user, ...)
//   'status' (status)  'offline' | 'connecting' | 'online'
//   'signedOut' ()     сервер не принял токен: нужно войти заново
//   'rulesRequired' () сначала нужно принять правила команды (ответ 451 или закрытие чата 4003)

const { EventEmitter } = require('events');

const SEND_TYPES = new Set(['send', 'edit', 'delete', 'read', 'typing']);

class ServerError extends Error {
  constructor(code, status) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

/** Адрес сервера: https для всех, http только для своего компьютера. */
function normalizeServerUrl(raw) {
  let u;
  try {
    u = new URL(String(raw || '').trim());
  } catch {
    return null;
  }
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) return null;
  if (u.username || u.password || u.search || u.hash) return null;
  return u.origin;
}

class StudioClient extends EventEmitter {
  constructor({ fetchImpl, WebSocketImpl, tokenStore, serverUrl, device }) {
    super();
    this.fetch = fetchImpl;
    this.WebSocket = WebSocketImpl;
    this.tokens = tokenStore; // { load(): string|null, save(token), clear() }
    this.device = device || 'Twenty Words Studio';
    this.base = normalizeServerUrl(serverUrl);
    this.token = this.tokens.load();
    this.ws = null;
    this.status = 'offline';
    this.retry = 0;
    this.timer = null;
    this.wanted = false;
  }

  setServer(url) {
    const base = normalizeServerUrl(url);
    if (!base) throw new ServerError('bad_server_url');
    if (base !== this.base) {
      this.disconnect();
      this.base = base;
      this.forget();
    }
    return base;
  }

  get signedIn() {
    return !!this.token;
  }

  forget() {
    this.token = null;
    this.tokens.clear();
  }

  async request(method, path, body, { auth = true, timeout = 15000 } = {}) {
    if (!this.base) throw new ServerError('bad_server_url');
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (auth) {
      if (!this.token) throw new ServerError('unauthorized', 401);
      headers.Authorization = 'Bearer ' + this.token;
    }
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeout);
    let res;
    try {
      res = await this.fetch(this.base + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl.signal,
        redirect: 'error',
      });
    } catch (err) {
      throw new ServerError(err.name === 'AbortError' ? 'timeout' : 'network');
    } finally {
      clearTimeout(t);
    }
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* пустой ответ */
    }
    if (!res.ok) {
      const code = (data && data.error) || 'http_' + res.status;
      if (res.status === 401 && auth) this.signOutLocal();
      if (res.status === 451) this.emit('rulesRequired');
      throw new ServerError(code, res.status);
    }
    return data;
  }

  /** POST с ответом потоком NDJSON: каждая строка JSON уходит в onEvent. */
  async stream(path, body, onEvent, signal) {
    if (!this.base) throw new ServerError('bad_server_url');
    if (!this.token) throw new ServerError('unauthorized', 401);
    let res;
    try {
      res = await this.fetch(this.base + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson', Authorization: 'Bearer ' + this.token },
        body: JSON.stringify(body),
        signal,
        redirect: 'error',
      });
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      throw new ServerError('network');
    }
    if (!res.ok) {
      let data = null;
      try {
        data = await res.json();
      } catch {
        /* пусто */
      }
      if (res.status === 401) this.signOutLocal();
      if (res.status === 451) this.emit('rulesRequired');
      throw new ServerError((data && data.error) || 'http_' + res.status, res.status);
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        try {
          onEvent(JSON.parse(line));
        } catch {
          /* битая строка */
        }
      }
    }
  }

  signOutLocal() {
    const had = !!this.token;
    this.disconnect();
    this.forget();
    if (had) this.emit('signedOut');
  }

  async login(login, password) {
    const r = await this.request('POST', '/api/login', { login, password, device: this.device }, { auth: false });
    this.token = r.token;
    this.tokens.save(r.token);
    return r.user;
  }

  async register(code, login, name, password) {
    const body = { code, password, device: this.device };
    if (login) body.login = login;
    if (name) body.name = name;
    const r = await this.request('POST', '/api/register', body, { auth: false });
    this.token = r.token;
    this.tokens.save(r.token);
    return r.user;
  }

  async logout() {
    try {
      if (this.token) await this.request('POST', '/api/logout', {});
    } catch {
      /* всё равно выходим локально */
    }
    this.disconnect();
    this.forget();
  }

  // ---------- WebSocket ----------

  setStatus(s) {
    if (this.status !== s) {
      this.status = s;
      this.emit('status', s);
    }
  }

  connect() {
    this.wanted = true;
    if (!this.token || !this.base || this.ws) return;
    clearTimeout(this.timer);
    this.setStatus('connecting');
    const url = this.base.replace(/^http/, 'ws') + '/api/ws';
    let ws;
    try {
      ws = new this.WebSocket(url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => ws.send(JSON.stringify({ t: 'auth', token: this.token }));
    ws.onmessage = (e) => {
      let ev;
      try {
        ev = JSON.parse(e.data);
      } catch {
        return;
      }
      if (ev.t === 'ready') {
        this.retry = 0;
        this.setStatus('online');
      }
      this.emit('event', ev);
    };
    ws.onerror = () => {};
    ws.onclose = (e) => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (e.code === 4003) {
        // Чат закрыт до согласия с правилами. Снова подключит приложение после согласия.
        this.setStatus('offline');
        this.emit('rulesRequired');
        return;
      }
      if (e.code === 1008) {
        // Сервер не принял токен: вход закрыт, заблокирован или удалён.
        this.setStatus('offline');
        this.signOutLocal();
        return;
      }
      this.scheduleReconnect();
    };
  }

  scheduleReconnect() {
    this.ws = null;
    this.setStatus('offline');
    if (!this.wanted || !this.token) return;
    const delay = Math.min(30000, 1000 * 2 ** this.retry++) + Math.floor(Math.random() * 500);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.connect(), delay);
  }

  disconnect() {
    this.wanted = false;
    clearTimeout(this.timer);
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      try {
        ws.close(1000);
      } catch {
        /* уже закрыт */
      }
    }
    this.setStatus('offline');
  }

  /** Отправка в чат. Возвращает false, если нет связи. */
  send(obj) {
    if (!obj || !SEND_TYPES.has(obj.t)) return false;
    const ws = this.ws;
    if (!ws || ws.readyState !== 1 || this.status !== 'online') return false;
    ws.send(JSON.stringify(obj));
    return true;
  }
}

module.exports = { StudioClient, ServerError, normalizeServerUrl };
