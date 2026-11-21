'use strict';
// Встроенный браузер: отдельное окно с вкладками для рабочих площадок.
//
// Страницы открываются в своей сессии persist:tw-web. У них нет доступа ни к токену
// студии, ни к Node, ни к сессиям кузницы и запуска проектов. Входы в аккаунты
// (TikTok, YouTube и другие) сохраняются между запусками, как в обычном браузере.
// Закладки, открытые вкладки и значки сайтов лежат в userData/browser.json.

const { app, BrowserWindow, WebContentsView, Menu, clipboard, ipcMain, session, shell } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PARTITION = 'persist:tw-web';
const BAR_H = 78; // полоса вкладок 36 + панель адреса 42, как в browser.css
const SEARCH = 'https://www.google.com/search?q=';
const MAX_TABS = 30;
const MAX_MARKS = 60;
const MAX_ICONS = 200;
const DEFAULT_MARKS = [
  { id: 'tiktok', name: 'TikTok', url: 'https://www.tiktok.com/' },
  { id: 'youtube', name: 'YouTube', url: 'https://www.youtube.com/' },
  { id: 'instagram', name: 'Instagram', url: 'https://www.instagram.com/' },
  { id: 'x', name: 'X', url: 'https://x.com/' },
  { id: 'telegram', name: 'Telegram', url: 'https://web.telegram.org/a/' },
  { id: 'reddit', name: 'Reddit', url: 'https://www.reddit.com/' },
];
// Разрешения для сайтов. Камера, микрофон, геопозиция и уведомления выключены.
const ALLOWED_PERMS = new Set(['fullscreen', 'clipboard-sanitized-write', 'pointerLock']);
// Внешние ссылки, которые можно отдать системе (письмо, приложение Telegram).
const EXTERNAL = new Set(['mailto:', 'tg:']);

const isWeb = (u) => {
  try {
    const p = new URL(u).protocol;
    return p === 'http:' || p === 'https:';
  } catch {
    return false;
  }
};
const hostOf = (u) => {
  try {
    return new URL(u).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
};
const clip = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');

// Строка из адресной строки: адрес или поиск в Google.
function toUrl(text) {
  const t = clip(text, 2000).trim();
  if (!t) return null;
  if (/^https?:\/\//i.test(t)) return isWeb(t) ? t : null;
  if (/^(localhost|[\w-]+(\.[\w-]+)+)(:\d{1,5})?([/?#]\S*)?$/i.test(t) && !/\s/.test(t)) return 'https://' + t;
  return SEARCH + encodeURIComponent(t);
}

class Browser {
  constructor({ icon, onAudio, themeOf, studio }) {
    this.icon = icon;
    // Большие плитки студии на стартовой странице (data/config.json, browser.studio): только https.
    this.studio = (Array.isArray(studio) ? studio : [])
      .filter((x) => x && typeof x.url === 'string' && /^https:\/\//i.test(x.url) && isWeb(x.url))
      .slice(0, 4)
      .map((x) => ({ name: clip(x.name, 40) || hostOf(x.url), sub: clip(x.sub, 60), url: clip(x.url, 2000) }));
    this.onAudio = onAudio || (() => {});
    this.themeOf = themeOf || (() => ({ theme: 'auto', extra: [] }));
    this.file = path.join(app.getPath('userData'), 'browser.json');
    this.data = this.load();
    this.win = null;
    this.tabs = [];
    this.active = null;
    this.closed = []; // адреса закрытых вкладок для Ctrl+Shift+T
    this.seq = 0;
    this.ses = null;
    this.audible = false;
    this.htmlFull = false;
    this.stateTimer = null;
    this.saveTimer = null;
    this.registerIpc();
  }

  // ---------- данные ----------

  load() {
    let d = {};
    try {
      d = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      /* первый запуск */
    }
    const marks = (Array.isArray(d.marks) ? d.marks : [])
      .filter((m) => m && typeof m.id === 'string' && isWeb(m.url))
      .slice(0, MAX_MARKS)
      .map((m) => ({ id: clip(m.id, 40), name: clip(m.name, 40) || hostOf(m.url), url: clip(m.url, 2000) }));
    const out = {
      marks: d.seeded ? marks : DEFAULT_MARKS.map((m) => ({ ...m })),
      seeded: true,
      icons: d.icons && typeof d.icons === 'object' ? d.icons : {},
      tabs: (Array.isArray(d.tabs) ? d.tabs : []).filter((u) => u === '' || isWeb(u)).slice(0, MAX_TABS),
      active: Number.isInteger(d.active) ? d.active : 0,
    };
    for (const [h, v] of Object.entries(out.icons)) if (typeof v !== 'string' || !v.startsWith('data:image/')) delete out.icons[h];
    return out;
  }

  saveSoon() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.save(), 500);
  }

  save() {
    clearTimeout(this.saveTimer);
    if (this.win) {
      this.data.tabs = this.tabs.map((t) => (t.start ? '' : t.url)).filter((u) => u === '' || isWeb(u));
      this.data.active = Math.max(0, this.tabs.indexOf(this.active));
    }
    try {
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data));
      fs.renameSync(tmp, this.file);
    } catch {
      /* не критично */
    }
  }

  // ---------- сессия сайтов ----------

  setupSession() {
    if (this.ses) return this.ses;
    const ses = session.fromPartition(PARTITION);
    // Без меток Electron и приложения: иначе часть сайтов (вход Google) считает браузер небезопасным.
    const ua = app.userAgentFallback
      .replace(/\(KHTML, like Gecko\).*?Chrome\//, '(KHTML, like Gecko) Chrome/')
      .replace(/\sElectron\/\S+/, '')
      .replace(/\s{2,}/g, ' ');
    ses.setUserAgent(ua);
    ses.setPermissionRequestHandler((_wc, perm, cb) => cb(ALLOWED_PERMS.has(perm)));
    ses.setPermissionCheckHandler((_wc, perm) => ALLOWED_PERMS.has(perm));
    try {
      ses.setSpellCheckerLanguages(['ru', 'en-US']);
    } catch {
      /* словари не обязательны */
    }
    ses.on('will-download', (_e, item) => {
      item.once('done', (_e2, state) => {
        if (state === 'completed') this.toast('Скачано: ' + item.getFilename(), item.getSavePath());
        else if (state === 'interrupted') this.toast('Загрузка прервалась: ' + item.getFilename());
      });
    });
    this.ses = ses;
    return ses;
  }

  // ---------- окно ----------

  open(url) {
    if (!this.win) this.createWindow();
    else {
      if (this.win.isMinimized()) this.win.restore();
      this.win.show();
      this.win.focus();
    }
    if (url && isWeb(url)) this.newTab(url);
  }

  createWindow() {
    this.setupSession();
    const st = this.data.win || {};
    const win = new BrowserWindow({
      width: st.width || 1280,
      height: st.height || 820,
      x: st.x,
      y: st.y,
      minWidth: 640,
      minHeight: 420,
      title: 'Браузер',
      icon: this.icon,
      backgroundColor: '#0f1012',
      autoHideMenuBar: true,
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: '#0b0c0e', symbolColor: '#e8e6e1', height: 36 },
      show: false,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        spellcheck: true,
        preload: path.join(__dirname, '..', 'preload', 'browser-preload.js'),
      },
    });
    this.win = win;
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('before-input-event', (e, input) => {
      if (this.key(input)) e.preventDefault();
    });
    win.once('ready-to-show', () => {
      if (st.maximized) win.maximize();
      win.show();
    });
    win.on('resize', () => this.layout());
    win.on('enter-full-screen', () => this.layout());
    win.on('leave-full-screen', () => {
      this.htmlFull = false;
      this.layout();
    });
    win.on('close', () => {
      this.data.win = { ...win.getNormalBounds(), maximized: win.isMaximized() };
      this.save();
      // Страницы сайтов закрываем, пока окно ещё живо: после его уничтожения закрытие их вешает.
      for (const t of this.tabs) this.destroyView(t);
    });
    win.on('closed', () => {
      this.tabs = [];
      this.active = null;
      this.win = null;
      this.setAudible(false);
    });
    win.loadFile(path.join(__dirname, '..', 'renderer', 'browser.html'));
    // Вкладки прошлого раза.
    const saved = this.data.tabs.length ? this.data.tabs : [''];
    saved.forEach((u, i) => this.newTab(u || null, { activate: i === Math.min(this.data.active, saved.length - 1), lazy: true }));
    if (!this.active) this.activate(this.tabs[0]);
  }

  close() {
    if (this.win) this.win.close();
  }

  layout() {
    if (!this.win) return;
    const [w, h] = this.win.getContentSize();
    const bar = this.htmlFull ? 0 : BAR_H;
    for (const t of this.tabs) {
      const show = t === this.active && t.view && !t.start && !t.error;
      if (show) {
        if (!t.attached) {
          this.win.contentView.addChildView(t.view);
          t.attached = true;
        }
        t.view.setBounds({ x: 0, y: bar, width: w, height: Math.max(0, h - bar) });
      } else if (t.attached) {
        this.win.contentView.removeChildView(t.view);
        t.attached = false;
      }
    }
  }

  // ---------- вкладки ----------

  // next: сразу за текущей вкладкой (ссылки со страницы), иначе в конец.
  newTab(url, { activate = true, lazy = false, next = false } = {}) {
    if (!this.win) return null;
    if (this.tabs.length >= MAX_TABS) {
      this.toast('Открыто слишком много вкладок, закройте лишние.');
      return null;
    }
    const t = { id: ++this.seq, view: null, attached: false, url: '', title: 'Новая вкладка', host: '', loading: false, start: true, audible: false, error: null, lazyUrl: null };
    const i = next && this.active ? this.tabs.indexOf(this.active) + 1 : this.tabs.length;
    this.tabs.splice(i, 0, t);
    if (url) {
      // Вкладки прошлого раза грузятся, когда на них переключились.
      if (lazy && !activate) {
        t.lazyUrl = url;
        t.url = url;
        t.host = hostOf(url);
        t.title = t.host;
        t.start = false;
      } else this.navigate(t, url);
    }
    if (activate) this.activate(t);
    else this.state();
    this.saveSoon();
    return t;
  }

  activate(t) {
    if (!t) return;
    this.active = t;
    if (t.lazyUrl) {
      const u = t.lazyUrl;
      t.lazyUrl = null;
      this.navigate(t, u);
    }
    this.layout();
    if (t.view && !t.start) t.view.webContents.focus();
    else this.focusAddress();
    this.state();
    this.saveSoon();
  }

  closeTab(t) {
    if (!t) return;
    const i = this.tabs.indexOf(t);
    if (i < 0) return;
    if (!t.start && t.url) this.closed.push(t.url);
    if (this.closed.length > 20) this.closed.shift();
    this.destroyView(t);
    this.tabs.splice(i, 1);
    if (!this.tabs.length) {
      this.close();
      return;
    }
    if (this.active === t) this.activate(this.tabs[Math.min(i, this.tabs.length - 1)]);
    else this.state();
    this.updateAudible();
    this.saveSoon();
  }

  destroyView(t) {
    if (!t.view) return;
    if (t.attached && this.win) this.win.contentView.removeChildView(t.view);
    t.attached = false;
    const wc = t.view.webContents;
    t.view = null;
    try {
      if (!wc.isDestroyed()) wc.close();
    } catch {
      /* уже закрыто */
    }
  }

  navigate(t, url) {
    if (!isWeb(url)) return;
    this.ensureView(t);
    t.start = false;
    t.error = null;
    t.url = url;
    t.host = hostOf(url);
    t.view.webContents.loadURL(url).catch(() => {});
    this.layout();
    this.state();
  }

  ensureView(t) {
    if (t.view) return t.view;
    const view = new WebContentsView({
      webPreferences: {
        partition: PARTITION,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        spellcheck: true,
        safeDialogs: true,
        navigateOnDragDrop: false,
      },
    });
    view.setBackgroundColor('#ffffff');
    t.view = view;
    this.wire(t, view.webContents);
    return view;
  }

  wire(t, wc) {
    const upd = () => {
      if (t.view && t.view.webContents === wc) this.state();
    };
    wc.on('did-start-loading', () => {
      t.loading = true;
      upd();
    });
    wc.on('did-stop-loading', () => {
      t.loading = false;
      upd();
    });
    wc.on('page-title-updated', (_e, title) => {
      t.title = clip(title, 200) || t.host;
      upd();
    });
    const nav = (_e, url) => {
      t.url = url;
      t.host = hostOf(url);
      t.start = false;
      upd();
      this.saveSoon();
    };
    wc.on('did-navigate', nav);
    wc.on('did-navigate-in-page', (e, url, isMain) => {
      if (isMain) nav(e, url);
    });
    wc.on('did-fail-load', (_e, code, desc, url, isMain) => {
      if (!isMain || code === -3) return; // -3: переход отменён, это не ошибка
      t.error = { code, desc: clip(desc, 120), url: clip(url, 2000) };
      t.loading = false;
      this.layout();
      upd();
    });
    wc.on('did-finish-load', () => {
      if (t.error) {
        t.error = null;
        this.layout();
      }
    });
    wc.on('render-process-gone', () => {
      t.error = { code: 'crash', desc: 'Страница упала', url: t.url };
      t.loading = false;
      this.layout();
      upd();
    });
    wc.on('page-favicon-updated', (_e, favs) => this.fetchIcon(t.host, favs && favs[0]));
    const audio = () => setTimeout(() => {
      if (wc.isDestroyed()) return;
      t.audible = wc.isCurrentlyAudible();
      this.updateAudible();
      upd();
    }, 150);
    wc.on('media-started-playing', audio);
    wc.on('media-paused', audio);
    wc.on('audio-state-changed', audio);
    wc.on('enter-html-full-screen', () => {
      this.htmlFull = true;
      if (this.win) this.win.setFullScreen(true);
      this.layout();
    });
    wc.on('leave-html-full-screen', () => {
      this.htmlFull = false;
      if (this.win) this.win.setFullScreen(false);
      this.layout();
    });
    wc.on('before-input-event', (e, input) => {
      if (this.key(input)) e.preventDefault();
    });
    wc.on('context-menu', (_e, p) => this.menu(t, wc, p));
    const guard = (e, url) => {
      url = url || e.url;
      if (isWeb(url) || /^(about|blob|data):/i.test(url)) return;
      e.preventDefault();
      this.external(url);
    };
    wc.on('will-navigate', guard);
    wc.on('will-redirect', guard);
    wc.setWindowOpenHandler(({ url, disposition }) => {
      if (!isWeb(url)) {
        if (url !== 'about:blank') this.external(url);
        // about:blank с размерами окна: окно входа (Google, Apple), ему нужен opener.
        if (url === 'about:blank' && disposition === 'new-window') return this.popupOptions();
        return { action: 'deny' };
      }
      // Окно с размерами (вход через Google и подобные) остаётся окном: страница ждёт от него ответа.
      if (disposition === 'new-window') return this.popupOptions();
      this.newTab(url, { activate: disposition !== 'background-tab', next: true });
      return { action: 'deny' };
    });
    wc.on('did-create-window', (child) => {
      child.webContents.setWindowOpenHandler(({ url }) => {
        if (isWeb(url)) this.newTab(url, { next: true });
        return { action: 'deny' };
      });
    });
  }

  popupOptions() {
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        width: 520,
        height: 680,
        icon: this.icon,
        autoHideMenuBar: true,
        backgroundColor: '#ffffff',
        webPreferences: { partition: PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false },
      },
    };
  }

  external(url) {
    try {
      if (EXTERNAL.has(new URL(url).protocol)) shell.openExternal(url);
    } catch {
      /* битый адрес */
    }
  }

  updateAudible() {
    this.setAudible(this.tabs.some((t) => t.audible && t.view && !t.view.webContents.isAudioMuted()));
  }

  setAudible(on) {
    if (on === this.audible) return;
    this.audible = on;
    this.onAudio(on);
  }

  // ---------- значки сайтов ----------

  async fetchIcon(host, url) {
    if (!host || !url || this.data.icons[host] || !/^(https?|data):/i.test(url)) return;
    try {
      let data = url;
      if (!url.startsWith('data:')) {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 6000);
        const r = await this.ses.fetch(url, { signal: ctl.signal });
        clearTimeout(timer);
        const type = (r.headers.get('content-type') || '').split(';')[0].trim();
        if (!r.ok || !/^image\/(png|x-icon|vnd\.microsoft\.icon|svg\+xml|jpeg|webp|gif)$/.test(type)) return;
        const buf = Buffer.from(await r.arrayBuffer());
        if (buf.length > 64 * 1024) return;
        data = `data:${type};base64,${buf.toString('base64')}`;
      }
      if (!/^data:image\//.test(data) || data.length > 90000) return;
      const keys = Object.keys(this.data.icons);
      if (keys.length >= MAX_ICONS) delete this.data.icons[keys[0]];
      this.data.icons[host] = data;
      this.saveSoon();
      this.state();
    } catch {
      /* без значка */
    }
  }

  // ---------- закладки ----------

  addMark(name, url) {
    if (!isWeb(url)) throw Object.assign(new Error('bad_url'), { code: 'bad_url' });
    if (this.data.marks.some((m) => m.url === url)) return;
    if (this.data.marks.length >= MAX_MARKS) throw Object.assign(new Error('too_many'), { code: 'too_many' });
    this.data.marks.push({ id: crypto.randomBytes(6).toString('hex'), name: clip(String(name || '').trim(), 40) || hostOf(url), url: clip(url, 2000) });
    this.saveSoon();
    this.state();
  }

  delMark(id) {
    this.data.marks = this.data.marks.filter((m) => m.id !== id);
    this.saveSoon();
    this.state();
  }

  renameMark(id, name) {
    const m = this.data.marks.find((x) => x.id === id);
    if (!m) return;
    m.name = clip(String(name || '').trim(), 40) || hostOf(m.url);
    this.saveSoon();
    this.state();
  }

  resetMarks() {
    // Стандартные встают на свои места в начале списка, свои закладки остаются после них.
    DEFAULT_MARKS.forEach((d, i) => {
      if (!this.data.marks.some((m) => m.id === d.id || m.url === d.url)) this.data.marks.splice(Math.min(i, this.data.marks.length), 0, { ...d });
    });
    this.saveSoon();
    this.state();
  }

  toggleMark() {
    const t = this.active;
    if (!t || t.start || !isWeb(t.url)) return;
    const m = this.data.marks.find((x) => x.url === t.url);
    if (m) this.delMark(m.id);
    else this.addMark(t.title, t.url);
  }

  // ---------- состояние для панели ----------

  state() {
    if (this.stateTimer) return;
    this.stateTimer = setTimeout(() => {
      this.stateTimer = null;
      if (!this.win || this.win.isDestroyed()) return;
      this.win.webContents.send('browser:state', this.snapshot());
    }, 30);
  }

  snapshot() {
    const icons = this.data.icons;
    const a = this.active;
    const wc = a && a.view && !a.view.webContents.isDestroyed() ? a.view.webContents : null;
    return {
      active: a ? a.id : null,
      tabs: this.tabs.map((t) => ({
        id: t.id,
        title: t.start ? 'Новая вкладка' : t.title || t.host,
        url: t.start ? '' : t.url,
        icon: icons[t.host] || null,
        loading: t.loading,
        start: t.start,
        audible: t.audible,
        muted: !!(t.view && !t.view.webContents.isDestroyed() && t.view.webContents.isAudioMuted()),
        error: t.error,
      })),
      canBack: !!(wc && !a.start && wc.navigationHistory.canGoBack()),
      canFwd: !!(wc && wc.navigationHistory.canGoForward()),
      backToPage: !!(a && a.start && a.view),
      zoom: wc ? Math.round(wc.getZoomFactor() * 100) : 100,
      marked: !!(a && !a.start && this.data.marks.some((m) => m.url === a.url)),
      marks: this.data.marks.map((m) => ({ ...m, host: hostOf(m.url), icon: icons[hostOf(m.url)] || null })),
      studio: this.studio.map((x, i) => ({ id: i, name: x.name, sub: x.sub, host: hostOf(x.url), icon: icons[hostOf(x.url)] || null })),
      missingDefaults: DEFAULT_MARKS.some((d) => !this.data.marks.some((m) => m.id === d.id || m.url === d.url)),
    };
  }

  focusAddress() {
    if (!this.win) return;
    this.win.webContents.focus();
    this.win.webContents.send('browser:focus', {});
  }

  toast(text, file) {
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send('browser:toast', { text, file: file || '' });
  }

  // ---------- команды ----------

  cmd(a) {
    const t = this.active;
    const byId = (id) => this.tabs.find((x) => x.id === id);
    const wc = t && t.view && !t.view.webContents.isDestroyed() ? t.view.webContents : null;
    switch (a.cmd) {
      case 'new':
        this.newTab(toUrl(a.text) || null);
        break;
      case 'close':
        this.closeTab(byId(a.id) || t);
        break;
      case 'activate':
        this.activate(byId(a.id));
        break;
      case 'go': {
        const url = toUrl(a.text);
        if (!url) break;
        if (a.newTab || !t) this.newTab(url);
        else this.navigate(t, url);
        break;
      }
      case 'back':
        if (t && t.start && t.view) {
          t.start = false;
          this.layout();
          this.state();
        } else if (wc && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
        break;
      case 'fwd':
        if (wc && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
        break;
      case 'reload':
        if (t && t.error && wc) {
          t.error = null;
          this.layout();
          if (wc.getURL()) wc.reload();
          else wc.loadURL(t.url).catch(() => {});
        } else if (wc && !t.start) (a.hard ? wc.reloadIgnoringCache() : wc.reload());
        break;
      case 'stop':
        if (wc) wc.stop();
        break;
      case 'home':
        if (t) {
          t.start = true;
          t.error = null;
          this.layout();
          this.focusAddress();
          this.state();
        }
        break;
      case 'mute': {
        const x = byId(a.id);
        if (x && x.view) {
          x.view.webContents.setAudioMuted(!x.view.webContents.isAudioMuted());
          this.updateAudible();
          this.state();
        }
        break;
      }
      case 'zoom':
        if (wc) {
          const z = a.dir === 0 ? 0 : Math.max(-3, Math.min(5, wc.getZoomLevel() + (a.dir > 0 ? 0.5 : -0.5)));
          wc.setZoomLevel(z);
          this.state();
        }
        break;
      case 'move': {
        const x = byId(a.id);
        const to = Math.max(0, Math.min(this.tabs.length - 1, a.to | 0));
        if (x) {
          this.tabs.splice(this.tabs.indexOf(x), 1);
          this.tabs.splice(to, 0, x);
          this.state();
          this.saveSoon();
        }
        break;
      }
      case 'openStudio': {
        const x = this.studio[a.id | 0];
        if (!x) break;
        if (a.newTab || !t) this.newTab(x.url, { activate: !a.background });
        else this.navigate(t, x.url);
        break;
      }
      case 'openMark': {
        const m = this.data.marks.find((x) => x.id === a.id);
        if (!m) break;
        if (a.newTab || !t) this.newTab(m.url, { activate: !a.background });
        else this.navigate(t, m.url);
        break;
      }
      case 'mark':
        this.toggleMark();
        break;
      case 'addMark':
        this.addMark(a.name, toUrl(a.url));
        break;
      case 'delMark':
        this.delMark(a.id);
        break;
      case 'renameMark':
        this.renameMark(a.id, a.name);
        break;
      case 'resetMarks':
        this.resetMarks();
        break;
      case 'showFile':
        if (typeof a.file === 'string' && a.file && fs.existsSync(a.file)) shell.showItemInFolder(a.file);
        break;
      case 'titlebar':
        if (this.win && /^#[0-9a-f]{6}$/i.test(a.color || '') && /^#[0-9a-f]{6}$/i.test(a.symbol || '')) {
          try {
            this.win.setTitleBarOverlay({ color: a.color, symbolColor: a.symbol, height: 36 });
          } catch {
            /* не Windows */
          }
        }
        break;
      default:
        break;
    }
    return true;
  }

  // Горячие клавиши. Работают и на странице сайта, и в панели браузера.
  key(i) {
    if (i.type !== 'keyDown') return false;
    const ctrl = i.control || i.meta;
    const k = (i.key || '').toLowerCase();
    const t = this.active;
    const run = (c) => {
      this.cmd(c);
      return true;
    };
    if (ctrl && !i.shift && k === 't') return run({ cmd: 'new' });
    if (ctrl && i.shift && k === 't') {
      const u = this.closed.pop();
      return u ? run({ cmd: 'new', text: u }) : true;
    }
    if (ctrl && k === 'w') return run({ cmd: 'close' });
    if ((ctrl && k === 'l') || k === 'f6') {
      this.focusAddress();
      return true;
    }
    if ((ctrl && k === 'r') || k === 'f5') return run({ cmd: 'reload', hard: i.shift });
    if (i.alt && k === 'arrowleft') return run({ cmd: 'back' });
    if (i.alt && k === 'arrowright') return run({ cmd: 'fwd' });
    if (ctrl && k === 'tab' && this.tabs.length > 1) {
      const n = this.tabs.length;
      const idx = (this.tabs.indexOf(t) + (i.shift ? n - 1 : 1)) % n;
      return run({ cmd: 'activate', id: this.tabs[idx].id });
    }
    if (ctrl && /^[1-9]$/.test(k)) {
      const x = k === '9' ? this.tabs[this.tabs.length - 1] : this.tabs[Number(k) - 1];
      return x ? run({ cmd: 'activate', id: x.id }) : true;
    }
    if (ctrl && (k === '=' || k === '+')) return run({ cmd: 'zoom', dir: 1 });
    if (ctrl && k === '-') return run({ cmd: 'zoom', dir: -1 });
    if (ctrl && k === '0') return run({ cmd: 'zoom', dir: 0 });
    if (ctrl && k === 'd') return run({ cmd: 'mark' });
    if (k === 'f11') {
      if (this.win) this.win.setFullScreen(!this.win.isFullScreen());
      return true;
    }
    return false;
  }

  menu(t, wc, p) {
    const items = [];
    const add = (label, click, enabled = true) => items.push({ label, click, enabled });
    const sep = () => {
      if (items.length && items[items.length - 1].type !== 'separator') items.push({ type: 'separator' });
    };
    if (p.linkURL && isWeb(p.linkURL)) {
      add('Открыть в новой вкладке', () => this.newTab(p.linkURL, { activate: false, next: true }));
      add('Копировать ссылку', () => clipboard.writeText(p.linkURL));
      sep();
    }
    if (p.mediaType === 'image' && isWeb(p.srcURL)) {
      add('Открыть картинку в новой вкладке', () => this.newTab(p.srcURL));
      add('Копировать картинку', () => wc.copyImageAt(p.x, p.y));
      add('Сохранить картинку', () => wc.downloadURL(p.srcURL));
      sep();
    }
    if (p.isEditable) {
      for (const s of (p.dictionarySuggestions || []).slice(0, 5)) add(s, () => wc.replaceMisspelling(s));
      if (p.misspelledWord) sep();
      add('Вырезать', () => wc.cut(), p.editFlags.canCut);
      add('Копировать', () => wc.copy(), p.editFlags.canCopy);
      add('Вставить', () => wc.paste(), p.editFlags.canPaste);
      add('Выделить всё', () => wc.selectAll());
      sep();
    } else if (p.selectionText) {
      const q = p.selectionText.trim().slice(0, 300);
      add('Копировать', () => wc.copy());
      add('Искать в Google: ' + (q.length > 30 ? q.slice(0, 30) + '...' : q), () => this.newTab(SEARCH + encodeURIComponent(q)));
      sep();
    }
    add('Назад', () => wc.navigationHistory.goBack(), wc.navigationHistory.canGoBack());
    add('Вперёд', () => wc.navigationHistory.goForward(), wc.navigationHistory.canGoForward());
    add('Обновить', () => wc.reload());
    sep();
    add('Копировать адрес страницы', () => clipboard.writeText(wc.getURL()));
    Menu.buildFromTemplate(items).popup({ window: this.win });
  }

  registerIpc() {
    const mine = (e) => this.win && !this.win.isDestroyed() && e.sender === this.win.webContents;
    ipcMain.handle('browser:init', (e) => {
      if (!mine(e)) return { ok: false, error: 'forbidden' };
      return { ok: true, data: { ...this.themeOf(), state: this.snapshot() } };
    });
    ipcMain.handle('browser:cmd', (e, a) => {
      if (!mine(e) || !a || typeof a.cmd !== 'string') return { ok: false, error: 'forbidden' };
      try {
        return { ok: true, data: this.cmd(a) };
      } catch (err) {
        return { ok: false, error: err.code || 'error' };
      }
    });
  }

  // Тема студии сменилась: перекрасить панель браузера.
  themeChanged() {
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send('browser:theme', this.themeOf());
  }
}

module.exports = { Browser, toUrl, PARTITION };
