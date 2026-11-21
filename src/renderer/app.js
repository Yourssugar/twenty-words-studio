'use strict';
// Интерфейс Twenty Words Studio. Работает в песочнице, с сервером общается
// только через window.studio (см. preload.js).

// window.studio создаёт preload.js, здесь он доступен как глобальная переменная studio.
const $ = (id) => document.getElementById(id);

// ---------- помощники ----------

function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style') el.style.cssText = v; // через CSSOM: атрибут style запрещён политикой CSP
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const ERRORS = {
  bad_credentials: 'Неверный логин или пароль.',
  too_many_attempts: 'Слишком много попыток. Подождите 15 минут.',
  bad_code: 'Код не подходит: опечатка, уже использован или истёк.',
  login_taken: 'Такой логин уже занят.',
  bad_login: 'Логин: латиница, цифры, точка, дефис или _, от 3 до 24 символов.',
  bad_name: 'Имя должно быть от 2 до 32 символов.',
  weak_password: 'Пароль должен быть от 10 до 128 символов.',
  blocked: 'Аккаунт заблокирован. Обратитесь к админу.',
  network: 'Сервер не отвечает. Проверьте адрес сервера и интернет.',
  timeout: 'Сервер не ответил вовремя.',
  bad_server_url: 'Адрес сервера должен начинаться с https://. http можно только для 127.0.0.1.',
  admin_only: 'Нет прав.',
  forbidden: 'Нет прав.',
  not_on_self: 'Это действие нельзя применить к себе.',
  last_admin: 'Нельзя убрать последнего админа.',
  unauthorized: 'Нужно войти заново.',
  not_found: 'Не найдено. Возможно, уже удалено.',
  bad_avatar: 'Не удалось сохранить аватар.',
  quota_exceeded: 'Лимит ассистента на сегодня исчерпан. Он обновится в полночь, а после 18:00 можно взять из общего остатка, если он есть.',
  pool_exceeded: 'Общая квота команды на сегодня закончилась. Она обновится в полночь.',
  disabled: 'Ассистент для вас выключен. Обратитесь к админу.',
  no_model: 'Админ ещё не назначил модель ассистента.',
  no_provider: 'На сервере не подключён провайдер ассистента.',
  provider_auth: 'Ключ API на сервере не подходит. Сообщите админу.',
  provider_model_unavailable: 'Эта модель недоступна в тарифе провайдера. Выберите другую модель в шапке чата.',
  provider_rate_limited: 'Провайдер просит подождать. Попробуйте через минуту.',
  provider_unreachable: 'Сервер не может связаться с провайдером ассистента.',
  provider_bad_request: 'Провайдер не принял запрос. Возможно, модель недоступна.',
  provider_error: 'Провайдер ответил ошибкой.',
  busy: 'Подождите, предыдущий ответ ещё пишется.',
  cancelled: 'Ответ остановлен.',
  bad_limit: 'Лимит должен быть числом от 1 000 до 50 000 000.',
  bad_model: 'Эта модель недоступна.',
  model_disabled: 'Эта модель для вас закрыта. Выберите другую в шапке чата.',
  bad_pool: 'Такого котла нет на сервере.',
};
const errText = (code) => ERRORS[code] || 'Ошибка: ' + code;

async function call(promise) {
  const res = await promise;
  if (!res.ok) {
    const e = new Error(res.error);
    e.code = res.error;
    throw e;
  }
  return res.data;
}

function toast(text, kind = '') {
  const el = h('div', { class: 'toast ' + kind, text });
  $('toasts').append(el);
  setTimeout(() => el.classList.add('out'), 3800);
  setTimeout(() => el.remove(), 4300);
}

function modal({ title, body, ok = 'Да', danger = false }) {
  return new Promise((resolve) => {
    $('modal-title').textContent = title;
    const box = $('modal-body');
    box.innerHTML = '';
    if (typeof body === 'string') box.append(h('p', { text: body }));
    else if (body) box.append(body);
    const okBtn = $('modal-ok');
    okBtn.textContent = ok;
    okBtn.className = 'btn ' + (danger ? 'btn-danger' : 'btn-accent');
    $('modal').hidden = false;
    okBtn.focus();
    const done = (v) => {
      $('modal').hidden = true;
      okBtn.onclick = $('modal-cancel').onclick = null;
      document.removeEventListener('keydown', onKey);
      resolve(v);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') done(false);
    };
    document.addEventListener('keydown', onKey);
    okBtn.onclick = () => done(true);
    $('modal-cancel').onclick = () => done(false);
  });
}

const ICONS = {
  home: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="2.6"/><circle cx="5" cy="6" r="1.6"/><circle cx="19" cy="6" r="1.6"/><circle cx="5" cy="18" r="1.6"/><circle cx="19" cy="18" r="1.6"/><path d="M6.3 7l3.7 3.4M17.7 7L14 10.4M6.3 17l3.7-3.4M17.7 17L14 13.6"/></svg>',
  chat: '<svg viewBox="0 0 24 24"><path d="M4 5h16v11H9l-5 4z"/></svg>',
  tools: '<svg viewBox="0 0 24 24"><path d="M4 20l7-7M14 4l6 6-4 4-6-6zM3 21l2-2"/></svg>',
  shield: '<svg viewBox="0 0 24 24"><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/></svg>',
  video: '<svg viewBox="0 0 24 24"><path d="M3 6h13v12H3zM16 10l5-3v10l-5-3"/></svg>',
  audio: '<svg viewBox="0 0 24 24"><path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 11v2"/></svg>',
  image: '<svg viewBox="0 0 24 24"><path d="M3 5h18v14H3zM3 16l5-5 4 4 3-3 6 6"/></svg>',
  forge: '<svg viewBox="0 0 24 24"><path d="M4 9h11l4 3H8v5H4zM8 17l-2 3M12 17l2 3"/></svg>',
  files: '<svg viewBox="0 0 24 24"><path d="M6 3h8l4 4v14H6zM14 3v4h4M9 12h6M9 16h6"/></svg>',
  spark: '<svg viewBox="0 0 24 24"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z"/></svg>',
};
function icons(root = document) {
  for (const el of root.querySelectorAll('[data-ico]')) el.innerHTML = ICONS[el.dataset.ico] || '';
}

const COLORS = ['#e9a23b', '#e5534b', '#3fb68b', '#4fa3ff', '#a371f7', '#ff7eb6', '#2ec4b6', '#c9d1d9'];
const PRESETS = ['robot', 'cat', 'fox', 'owl', 'ghost', 'astronaut', 'wizard', 'knight', 'dragon', 'alien', 'panda', 'frog', 'octopus', 'bunny', 'pumpkin', 'snowman'];

function avatar(user, size = 32) {
  const a = (user && user.avatar) || {};
  const color = /^#[0-9a-f]{6}$/i.test(a.color || '') ? a.color : '#3a3d46';
  const el = h('span', { class: 'avatar', style: `--size:${size}px;--c:${color}` });
  if (a.type === 'preset' && PRESETS.includes(a.id)) {
    el.append(h('img', { src: `../assets/avatars/${a.id}.webp`, alt: '' }));
  } else {
    el.textContent = ((user && user.name) || '?').trim().charAt(0).toUpperCase();
  }
  return el;
}

const pad = (n) => String(n).padStart(2, '0');
const timeOf = (ts) => {
  const d = new Date(ts);
  return pad(d.getHours()) + ':' + pad(d.getMinutes());
};
function dayLabel(ts) {
  const d = new Date(ts);
  const today = new Date();
  const y = new Date(today);
  y.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Сегодня';
  if (d.toDateString() === y.toDateString()) return 'Вчера';
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}
function seenLabel(u) {
  if (u.online) return 'в сети';
  if (!u.lastSeen) return 'ещё не заходил';
  const d = new Date(u.lastSeen);
  return 'был ' + (new Date().toDateString() === d.toDateString() ? 'сегодня в ' + timeOf(u.lastSeen) : d.toLocaleDateString('ru-RU') + ' ' + timeOf(u.lastSeen));
}

const URL_RE = /https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]/g;
function linkify(text) {
  const out = [];
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(h('a', { href: m[0], target: '_blank', rel: 'noopener noreferrer', text: m[0] }));
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const dmId = (a, b) => (a < b ? `dm:${a}:${b}` : `dm:${b}:${a}`);
function peerOf(room) {
  const [, a, b] = room.split(':').map(Number);
  return a === S.me.id ? b : a;
}

// ---------- состояние ----------

const S = {
  me: null,
  users: new Map(),
  rooms: new Map(),
  view: 'home',
  room: 'work',
  msgs: new Map(), // room -> Map(id -> message)
  more: new Map(), // room -> есть ли более старые
  loading: false,
  status: 'offline',
  typing: new Map(), // room -> { user, until }
  editing: 0,
};

// ---------- вход ----------

let authMode = 'login';

function setAuthMode(mode) {
  authMode = mode;
  for (const b of document.querySelectorAll('.seg-btn')) b.classList.toggle('is-on', b.dataset.mode === mode);
  for (const el of document.querySelectorAll('[data-only="register"]')) el.hidden = mode !== 'register';
  $('auth-go').textContent = mode === 'login' ? 'Войти' : 'Продолжить';
  $('f-pass').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
  $('auth-error').textContent = '';
}

async function showAuth() {
  $('app').hidden = true;
  $('auth').hidden = false;
  const s = await call(studio.settings.get());
  $('auth-server-url').textContent = s.serverUrl;
  $('f-server').value = s.serverUrl;
  setAuthMode(authMode);
  $(authMode === 'login' ? 'f-login' : 'f-code').focus();
}

for (const b of document.querySelectorAll('.seg-btn')) b.addEventListener('click', () => setAuthMode(b.dataset.mode));

$('auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('auth-go');
  btn.disabled = true;
  $('auth-error').textContent = '';
  try {
    if (authMode === 'login') {
      await call(studio.auth.login($('f-login').value.trim(), $('f-pass').value));
    } else {
      await call(studio.auth.register($('f-code').value.trim(), $('f-login').value.trim(), $('f-name').value.trim(), $('f-pass').value));
    }
    $('f-pass').value = '';
    $('f-code').value = '';
    enterApp();
  } catch (err) {
    $('auth-error').textContent = errText(err.code);
  } finally {
    btn.disabled = false;
  }
});

$('auth-server-save').addEventListener('click', async () => {
  try {
    const s = await call(studio.settings.set({ serverUrl: $('f-server').value }));
    $('auth-server-url').textContent = s.serverUrl;
    toast('Сервер сохранён');
  } catch (err) {
    $('auth-error').textContent = errText(err.code);
  }
});

// ---------- приложение ----------

async function enterApp() {
  $('auth').hidden = true;
  $('app').hidden = false;
  // Пока правила не приняты, сервер закрывает всё остальное: сначала экран правил.
  if (typeof checkRules === 'function' && (await checkRules())) return;
  afterRules();
}

// После согласия с правилами (или если принимать нечего).
async function afterRules() {
  setView(S.view);
  setStatus(await call(studio.chat.connect()));
}

function setView(view) {
  if (view === 'admin' && (!S.me || S.me.role !== 'admin')) view = 'home';
  if (S.view === 'home' && view !== 'home' && typeof leaveHome === 'function') leaveHome();
  if (S.view === 'projects' && view !== 'projects' && typeof flushDraft === 'function') flushDraft();
  S.view = view;
  for (const b of document.querySelectorAll('.rail-btn')) b.classList.toggle('is-on', b.dataset.view === view);
  for (const p of document.querySelectorAll('[data-view-pane]')) p.hidden = p.dataset.viewPane !== view;
  if (view === 'home' && typeof openHome === 'function') openHome();
  if (view === 'tools' && typeof openTools === 'function') openTools();
  if (view === 'admin') loadAdmin();
  if (view === 'profile') renderProfile();
  if (view === 'assistant' && typeof openAssistant === 'function') openAssistant();
  if (view === 'projects' && typeof openProjects === 'function') openProjects();
  if (view === 'chat') {
    markRead();
    $('composer-text').focus();
  }
}
for (const b of document.querySelectorAll('.rail-btn')) b.addEventListener('click', () => setView(b.dataset.view));

function setStatus(status) {
  S.status = status;
  const el = $('conn');
  el.dataset.state = status;
  el.querySelector('span').textContent = { online: 'в сети', connecting: 'подключение...', offline: 'нет связи' }[status] || status;
}

studio.chat.onStatus(setStatus);
studio.auth.onSignedOut(() => {
  S.me = null;
  S.msgs.clear();
  toast('Сеанс закончился. Войдите снова.');
  showAuth();
});
studio.chat.onOpenRoom((room) => {
  if (S.rooms.has(room) || room.startsWith('dm:')) {
    setView('chat');
    openRoom(room);
  }
});

// ---------- события сервера ----------

// Обсуждения карточек (комнаты card:<id>) ведёт главная, в home.js.
const isTopicEvent = (ev) => ((ev.m && ev.m.room) || ev.room || '').startsWith('card:');

studio.chat.onEvent((ev) => {
  if (isTopicEvent(ev)) return;
  switch (ev.t) {
    case 'ready':
      S.me = ev.me;
      S.users = new Map(ev.users.map((u) => [u.id, u]));
      S.rooms = new Map(ev.rooms.map((r) => [r.id, r]));
      // После переподключения история могла устареть: перечитываем открытую комнату.
      S.msgs.clear();
      S.more.clear();
      $('rail-admin').hidden = S.me.role !== 'admin';
      renderMeBadge();
      if (!S.rooms.has(S.room) && !S.room.startsWith('dm:')) S.room = 'work';
      openRoom(S.room);
      if (S.view === 'admin') loadAdmin();
      break;

    case 'msg': {
      const m = ev.m;
      if (!S.rooms.has(m.room)) S.rooms.set(m.room, { id: m.room, kind: 'dm', peer: peerOf(m.room), unread: 0 });
      const r = S.rooms.get(m.room);
      r.last = m;
      const list = S.msgs.get(m.room);
      if (list) list.set(m.id, m);
      const t = S.typing.get(m.room);
      if (t && t.user === m.user) S.typing.delete(m.room);
      const visible = m.room === S.room && S.view === 'chat' && document.hasFocus();
      if (m.user !== S.me.id) {
        if (visible) studio.chat.send({ t: 'read', room: m.room, id: m.id });
        else r.unread = (r.unread || 0) + 1;
      }
      if (m.room === S.room) renderLog({ stick: m.user === S.me.id });
      renderSide();
      renderTyping();
      break;
    }

    case 'edit': {
      const list = S.msgs.get(ev.m.room);
      if (list && list.has(ev.m.id)) {
        list.set(ev.m.id, ev.m);
        if (ev.m.room === S.room) renderLog();
      }
      break;
    }

    case 'delete': {
      const list = S.msgs.get(ev.room);
      if (list && list.delete(ev.id) && ev.room === S.room) renderLog();
      break;
    }

    case 'read': {
      const r = S.rooms.get(ev.room);
      if (r) {
        r.unread = 0;
        renderSide();
      }
      break;
    }

    case 'rules':
      if (typeof checkRules === 'function') checkRules();
      break;
    case 'presence': {
      const u = S.users.get(ev.user);
      if (u) {
        u.online = ev.online;
        if (!ev.online) u.lastSeen = Date.now();
        renderSide();
        renderHeader();
      }
      break;
    }

    case 'user': {
      const old = S.users.get(ev.u.id) || {};
      S.users.set(ev.u.id, { ...old, ...ev.u, online: old.online || ev.u.online });
      if (S.me && ev.u.id === S.me.id) {
        S.me = { ...S.me, ...ev.u };
        renderMeBadge();
      }
      renderSide();
      renderLog();
      if (S.view === 'admin') loadAdmin();
      break;
    }

    case 'userGone': {
      S.users.delete(ev.user);
      for (const id of [...S.rooms.keys()]) {
        if (id.startsWith('dm:') && peerOf(id) === ev.user) {
          S.rooms.delete(id);
          if (ev.deleted) S.msgs.delete(id);
        }
      }
      if (ev.deleted) {
        for (const list of S.msgs.values()) for (const [id, m] of list) if (m.user === ev.user) list.delete(id);
      }
      if (S.room.startsWith('dm:') && !S.rooms.has(S.room)) openRoom('work');
      renderSide();
      renderLog();
      if (S.view === 'admin') loadAdmin();
      break;
    }

    case 'typing':
      S.typing.set(ev.room, { user: ev.user, until: Date.now() + 4000 });
      renderTyping();
      setTimeout(renderTyping, 4100);
      break;

    case 'error':
      if (ev.code === 'rate_limited') toast('Слишком часто. Подождите пару секунд.');
      else if (ev.code === 'no_access') toast('Нет доступа к этой переписке.');
      else if (ev.code !== 'empty') toast(errText(ev.code));
      break;
  }
});

// ---------- боковая панель ----------

function roomTitle(id) {
  const r = S.rooms.get(id);
  if (r && r.kind === 'public') return r.title;
  if (id.startsWith('dm:')) {
    const u = S.users.get(peerOf(id));
    return u ? u.name : 'Личная переписка';
  }
  return id;
}

function renderSide() {
  if (!S.me) return;
  const rooms = $('room-list');
  rooms.innerHTML = '';
  let total = 0;
  for (const r of S.rooms.values()) {
    total += r.unread || 0;
    if (r.kind !== 'public') continue;
    rooms.append(
      h('button', { class: 'item' + (r.id === S.room ? ' is-on' : ''), onclick: () => openRoom(r.id) },
        h('span', { class: 'hash', text: '#' }),
        h('span', { class: 'item-name', text: r.title }),
        r.unread ? h('span', { class: 'badge', text: r.unread > 99 ? '99+' : r.unread }) : null,
      ),
    );
  }
  const people = $('people-list');
  people.innerHTML = '';
  const others = [...S.users.values()].filter((u) => u.id !== S.me.id).sort((a, b) => b.online - a.online || a.name.localeCompare(b.name, 'ru'));
  if (!others.length) people.append(h('div', { class: 'side-empty', text: 'Пока никого. Пригласите команду в разделе Админ.' }));
  for (const u of others) {
    const id = dmId(S.me.id, u.id);
    const r = S.rooms.get(id);
    people.append(
      h('button', { class: 'item' + (id === S.room ? ' is-on' : ''), onclick: () => openRoom(id) },
        h('span', { class: 'presence' + (u.online ? ' on' : '') }, avatar(u, 26)),
        h('span', { class: 'item-name', text: u.name }),
        u.role === 'admin' ? h('span', { class: 'tag', text: 'админ' }) : null,
        r && r.unread ? h('span', { class: 'badge', text: r.unread }) : null,
      ),
    );
  }
  const badge = $('badge-chat');
  badge.hidden = !total;
  badge.textContent = total > 99 ? '99+' : total;
}

function renderMeBadge() {
  const box = $('rail-avatar');
  box.innerHTML = '';
  box.append(avatar(S.me, 30));
}

function renderHeader() {
  if (!S.me) return;
  $('chat-title').textContent = (S.room.startsWith('dm:') ? '' : '# ') + roomTitle(S.room);
  let sub = '';
  if (S.room === 'work') sub = 'задачи, файлы, решения';
  else if (S.room === 'free') sub = 'всё остальное';
  else {
    const u = S.users.get(peerOf(S.room));
    sub = u ? seenLabel(u) : '';
  }
  $('chat-sub').textContent = sub;
  $('composer-text').placeholder = 'Сообщение: ' + roomTitle(S.room);
}

function renderTyping() {
  const t = S.typing.get(S.room);
  const el = $('typing');
  if (t && t.until > Date.now() && t.user !== S.me.id) {
    const u = S.users.get(t.user);
    el.textContent = (u ? u.name : 'Кто-то') + ' печатает...';
  } else {
    el.textContent = '';
  }
}

// ---------- сообщения ----------

async function openRoom(id) {
  S.room = id;
  S.editing = 0;
  if (!S.rooms.has(id) && id.startsWith('dm:')) S.rooms.set(id, { id, kind: 'dm', peer: peerOf(id), unread: 0 });
  renderSide();
  renderHeader();
  renderTyping();
  if (!S.msgs.has(id)) {
    $('log').innerHTML = '';
    await loadHistory(id);
  }
  renderLog({ stick: true });
  markRead();
}

async function loadHistory(room, before) {
  if (S.loading) return;
  S.loading = true;
  try {
    const r = await call(studio.api.messages(room, before));
    const list = S.msgs.get(room) || new Map();
    for (const m of r.messages) list.set(m.id, m);
    S.msgs.set(room, list);
    S.more.set(room, r.messages.length === 50);
  } catch (err) {
    toast(errText(err.code));
  } finally {
    S.loading = false;
  }
}

function markRead() {
  const r = S.rooms.get(S.room);
  const list = S.msgs.get(S.room);
  if (!r || !list || !list.size) return;
  const last = Math.max(...list.keys());
  if (r.unread) {
    r.unread = 0;
    renderSide();
  }
  studio.chat.send({ t: 'read', room: S.room, id: last });
}
window.addEventListener('focus', () => S.view === 'chat' && markRead());

function renderLog({ stick = false } = {}) {
  if (!S.me) return;
  const log = $('log');
  const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
  const list = [...(S.msgs.get(S.room) || new Map()).values()].sort((a, b) => a.id - b.id);
  log.innerHTML = '';

  if (S.more.get(S.room)) log.append(h('div', { class: 'log-more', text: 'Прокрутите вверх, чтобы загрузить раньше' }));
  if (!list.length) {
    log.append(h('div', { class: 'log-empty' }, h('div', { text: 'Здесь пока тихо.' }), h('div', { class: 'muted', text: 'Напишите первое сообщение.' })));
  }

  let prev = null;
  for (const m of list) {
    const day = dayLabel(m.ts);
    if (!prev || dayLabel(prev.ts) !== day) log.append(h('div', { class: 'day', text: day }));
    const compact = prev && prev.user === m.user && m.ts - prev.ts < 5 * 60 * 1000 && dayLabel(prev.ts) === day;
    log.append(renderMessage(m, compact));
    prev = m;
  }
  if (stick || nearBottom) log.scrollTop = log.scrollHeight;
}

function renderMessage(m, compact) {
  const u = S.users.get(m.user) || { name: 'Удалённый пользователь' };
  const mine = m.user === S.me.id;
  const canDelete = mine || S.me.role === 'admin';
  const row = h('div', { class: 'msg' + (compact ? ' compact' : '') + (mine ? ' mine' : ''), dataset: { id: m.id } });
  row.append(compact ? h('span', { class: 'msg-time-side', text: timeOf(m.ts) }) : avatar(u, 36));
  const body = h('div', { class: 'msg-body' });
  if (!compact) {
    body.append(h('div', { class: 'msg-head' }, h('span', { class: 'msg-name', text: u.name }), h('span', { class: 'msg-time', text: timeOf(m.ts) })));
  }
  if (S.editing === m.id) {
    const ta = h('textarea', { class: 'edit-box', rows: 2 });
    ta.value = m.text;
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const text = ta.value.trim();
        if (text && text !== m.text) studio.chat.send({ t: 'edit', id: m.id, text });
        S.editing = 0;
        renderLog();
      } else if (e.key === 'Escape') {
        S.editing = 0;
        renderLog();
      }
    });
    body.append(ta, h('div', { class: 'muted small', text: 'Enter сохранить, Esc отмена' }));
    setTimeout(() => {
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
    });
  } else {
    body.append(h('div', { class: 'msg-text' }, linkify(m.text), m.edited ? h('span', { class: 'edited', text: ' (изменено)' }) : null));
    if (m.snap && typeof snapCard === 'function') body.append(snapCard(m.snap));
  }
  row.append(body);
  if (S.editing !== m.id && (mine || canDelete)) {
    row.append(
      h('div', { class: 'msg-actions' },
        mine ? h('button', { class: 'mini', title: 'Изменить', text: 'изменить', onclick: () => { S.editing = m.id; renderLog(); } }) : null,
        canDelete ? h('button', { class: 'mini', title: 'Удалить', text: 'удалить', onclick: () => deleteMessage(m) }) : null,
      ),
    );
  }
  return row;
}

async function deleteMessage(m) {
  const yes = await modal({ title: 'Удалить сообщение?', body: m.text.length > 200 ? m.text.slice(0, 200) + '...' : m.text, ok: 'Удалить', danger: true });
  if (yes && !(await call(studio.chat.send({ t: 'delete', id: m.id })))) toast('Нет связи с сервером.');
}

$('log').addEventListener('scroll', async () => {
  const log = $('log');
  if (log.scrollTop > 60 || !S.more.get(S.room) || S.loading) return;
  const list = S.msgs.get(S.room);
  if (!list || !list.size) return;
  const before = Math.min(...list.keys());
  const room = S.room;
  const oldHeight = log.scrollHeight;
  await loadHistory(room, before);
  if (room !== S.room) return;
  renderLog();
  log.scrollTop = log.scrollHeight - oldHeight;
});

// ---------- ввод ----------

const composer = $('composer-text');
let lastTyping = 0;

function autosize() {
  composer.style.height = 'auto';
  composer.style.height = Math.min(composer.scrollHeight, 200) + 'px';
}
composer.addEventListener('input', () => {
  autosize();
  if (composer.value && Date.now() - lastTyping > 2500) {
    lastTyping = Date.now();
    studio.chat.send({ t: 'typing', room: S.room });
  }
});
composer.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $('composer').requestSubmit();
  }
});
$('composer').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = composer.value.trim();
  if (!text) return;
  const ok = await call(studio.chat.send({ t: 'send', room: S.room, text, cid: Math.random().toString(36).slice(2, 10) }));
  if (!ok) {
    toast('Нет связи с сервером. Сообщение не отправлено.');
    return;
  }
  composer.value = '';
  lastTyping = 0;
  autosize();
});

// ---------- админ ----------

async function loadAdmin() {
  if (!S.me || S.me.role !== 'admin') return;
  try {
    const [users, invites] = await Promise.all([call(studio.admin.users()), call(studio.admin.invites())]);
    renderAdminUsers(users);
    renderAdminInvites(invites);
    if (typeof loadAdminAI === 'function') loadAdminAI();
    if (typeof loadAdminRules === 'function') loadAdminRules();
  } catch (err) {
    toast(errText(err.code));
  }
}

function showCode(label, code) {
  $('code-label').textContent = label;
  $('code-value').textContent = code;
  $('code-box').hidden = false;
  $('code-box').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}
$('code-copy').addEventListener('click', async () => {
  await call(studio.app.copy($('code-value').textContent));
  toast('Код скопирован');
});

$('invite-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const r = await call(studio.admin.createInvite($('inv-name').value.trim(), $('inv-role').value, Number($('inv-days').value)));
    showCode(`Приглашение: ${r.name} (${r.role === 'admin' ? 'админ' : 'участник'}), ${r.days} дн.`, r.code);
    $('inv-name').value = '';
    loadAdmin();
  } catch (err) {
    toast(errText(err.code));
  }
});

async function adminAction(u, action) {
  const labels = {
    block: [`Блокировка: ${u.name}`, 'Человек сразу выйдет из чата и не сможет войти, пока вы не снимете блокировку. Сообщения останутся.', 'Заблокировать', true],
    unblock: [`Снять блокировку: ${u.name}`, 'Человек снова сможет войти со своим паролем.', 'Разблокировать', false],
    reset: [`Сброс пароля: ${u.name}`, 'Будет создан код сброса на 2 дня. Старый пароль работает, пока код не использован.', 'Создать код', false],
    makeAdmin: [`Права админа: ${u.name}`, 'Админ может приглашать, блокировать и удалять людей.', 'Сделать админом', false],
    makeMember: [`Снять права админа: ${u.name}`, 'Человек останется в команде как обычный участник.', 'Снять права', false],
  };
  const [title, body, ok, danger] = labels[action];
  if (!(await modal({ title, body, ok, danger }))) return;
  try {
    if (action === 'makeAdmin' || action === 'makeMember') {
      await call(studio.admin.userAction(u.id, 'role', action === 'makeAdmin' ? 'admin' : 'member'));
    } else {
      const r = await call(studio.admin.userAction(u.id, action));
      if (action === 'reset') showCode(`Код сброса пароля: ${u.name} (${u.login}), 2 дн.`, r.code);
    }
    loadAdmin();
  } catch (err) {
    toast(errText(err.code));
  }
}

async function adminDelete(u) {
  const input = h('input', { placeholder: u.login, spellcheck: 'false' });
  const body = h('div', {},
    h('p', { text: 'Сотрутся все сообщения этого человека и все личные переписки с ним. Вернуть их будет нельзя.' }),
    h('p', { class: 'muted', text: 'Если нужно просто закрыть доступ, лучше заблокировать.' }),
    h('label', { class: 'field' }, h('span', { text: `Для подтверждения введите логин: ${u.login}` }), input),
  );
  setTimeout(() => input.focus());
  if (!(await modal({ title: `Удаление: ${u.name}`, body, ok: 'Удалить навсегда', danger: true }))) return;
  if (input.value.trim().toLowerCase() !== u.login) {
    toast('Логин не совпал, удаление отменено.');
    return;
  }
  try {
    await call(studio.admin.deleteUser(u.id));
    toast(`${u.name} удалён`);
    loadAdmin();
  } catch (err) {
    toast(errText(err.code));
  }
}

function renderAdminUsers(users) {
  const tb = $('admin-users');
  tb.innerHTML = '';
  const founder = !!S.me.founder;
  // Основатель меняет роли и работает с админами. Обычный админ только с участниками.
  $('inv-role').querySelector('option[value="admin"]').hidden = !founder;
  if (!founder) $('inv-role').value = 'member';
  for (const u of users) {
    const self = u.id === S.me.id;
    const status = u.blocked ? h('span', { class: 'tag tag-danger', text: 'заблокирован' }) : h('span', { class: u.online ? 'ok' : 'muted', text: seenLabel(u) });
    let actions;
    if (self) actions = h('span', { class: 'muted small', text: 'это вы' });
    else if (u.founder) actions = h('span', { class: 'muted small', text: 'основатель' });
    else if (u.role === 'admin' && !founder) actions = h('span', { class: 'muted small', text: 'админа меняет основатель' });
    else {
      actions = h('div', { class: 'row end gap-s' },
        h('button', { class: 'btn btn-s', text: 'Сброс пароля', onclick: () => adminAction(u, 'reset') }),
        founder ? h('button', { class: 'btn btn-s', text: u.role === 'admin' ? 'Снять админа' : 'Сделать админом', onclick: () => adminAction(u, u.role === 'admin' ? 'makeMember' : 'makeAdmin') }) : null,
        h('button', { class: 'btn btn-s', text: u.blocked ? 'Разблокировать' : 'Заблокировать', onclick: () => adminAction(u, u.blocked ? 'unblock' : 'block') }),
        h('button', { class: 'btn btn-s btn-danger-ghost', text: 'Удалить', onclick: () => adminDelete(u) }),
      );
    }
    tb.append(h('tr', { class: u.blocked ? 'is-blocked' : '' },
      h('td', {}, avatar(u, 28)),
      h('td', { text: u.name }),
      h('td', { class: 'mono', text: u.login }),
      h('td', { text: u.founder ? 'основатель' : u.role === 'admin' ? 'админ' : 'участник' }),
      h('td', {}, status),
      h('td', {}, actions),
    ));
  }
}

function renderAdminInvites(invites) {
  const tb = $('admin-invites');
  tb.innerHTML = '';
  if (!invites.length) {
    tb.append(h('tr', {}, h('td', { colspan: 5, class: 'muted', text: 'Нет действующих кодов.' })));
    return;
  }
  for (const inv of invites) {
    tb.append(h('tr', {},
      h('td', { text: inv.kind === 'reset' ? `${inv.name} (${inv.login})` : inv.name }),
      h('td', { text: inv.kind === 'reset' ? 'сброс пароля' : 'приглашение' }),
      h('td', { text: inv.role === 'admin' ? 'админ' : 'участник' }),
      h('td', { text: new Date(inv.expires).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' }) }),
      h('td', {}, h('button', { class: 'btn btn-s btn-danger-ghost', text: 'Отозвать', onclick: async () => {
        if (!(await modal({ title: 'Отозвать код?', body: 'Код перестанет работать.', ok: 'Отозвать', danger: true }))) return;
        try {
          await call(studio.admin.revokeInvite(inv.id));
          loadAdmin();
        } catch (err) {
          toast(errText(err.code));
        }
      } })),
    ));
  }
}

// ---------- профиль ----------

let draftAvatar = null;

async function renderProfile() {
  if (!S.me) return;
  draftAvatar = { ...(S.me.avatar || { type: 'letter', color: COLORS[0] }) };
  $('prof-name').value = S.me.name;
  $('prof-login').textContent = 'Логин: ' + S.me.login + (S.me.role === 'admin' ? ' · админ' : '');
  renderAvatarPicker();
  const s = await call(studio.settings.get());
  renderThemes(s.theme);
  $('set-notify').checked = s.notifications;
  $('set-server').value = s.serverUrl;
  const info = await call(studio.app.info());
  $('app-version').textContent = 'Версия ' + info.version;
}

function renderAvatarPicker() {
  const preview = $('prof-avatar');
  preview.innerHTML = '';
  preview.append(avatar({ name: $('prof-name').value || S.me.name, avatar: draftAvatar }, 72));
  const colors = $('prof-colors');
  colors.innerHTML = '';
  for (const c of COLORS) {
    colors.append(h('button', { class: 'swatch' + (draftAvatar.color === c ? ' is-on' : ''), style: `--c:${c}`, title: c, onclick: () => { draftAvatar.color = c; renderAvatarPicker(); } }));
  }
  const presets = $('prof-presets');
  presets.innerHTML = '';
  presets.append(h('button', { class: 'preset' + (draftAvatar.type === 'letter' ? ' is-on' : ''), title: 'Буква', onclick: () => { draftAvatar = { type: 'letter', color: draftAvatar.color }; renderAvatarPicker(); } }, avatar({ name: $('prof-name').value || S.me.name, avatar: { type: 'letter', color: draftAvatar.color } }, 40)));
  for (const id of PRESETS) {
    presets.append(h('button', { class: 'preset' + (draftAvatar.type === 'preset' && draftAvatar.id === id ? ' is-on' : ''), title: id, onclick: () => { draftAvatar = { type: 'preset', id, color: draftAvatar.color }; renderAvatarPicker(); } }, avatar({ avatar: { type: 'preset', id, color: draftAvatar.color } }, 40)));
  }
}
$('prof-name').addEventListener('input', renderAvatarPicker);

$('prof-save').addEventListener('click', async () => {
  try {
    const u = await call(studio.api.updateMe({ name: $('prof-name').value.trim(), avatar: draftAvatar }));
    S.me = { ...S.me, ...u };
    renderMeBadge();
    toast('Сохранено');
  } catch (err) {
    toast(errText(err.code));
  }
});

$('pass-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await call(studio.api.changePassword($('pass-old').value, $('pass-new').value));
    $('pass-old').value = $('pass-new').value = '';
    toast('Пароль изменён');
  } catch (err) {
    toast(errText(err.code === 'bad_credentials' ? 'bad_credentials' : err.code));
  }
});

function renderThemes(current) {
  const box = $('theme-list');
  box.innerHTML = '';
  const opts = [{ id: 'auto', name: 'По сезону', sub: resolveTheme('auto').name }, ...THEMES.map((t) => ({ id: t.id, name: t.name }))];
  for (const o of opts) {
    const t = resolveTheme(o.id);
    const tile = h('button', { class: 'theme-tile' + (o.id === current ? ' is-on' : ''), onclick: async () => {
      applyTheme(o.id);
      await call(studio.settings.set({ theme: o.id }));
      renderThemes(o.id);
    } },
      h('span', { class: 'theme-thumb', style: `--tb:${t.bg ? `url("../assets/themes/${t.bg}.webp")` : 'none'};--tc:${t.vars['--accent']};--tg:${t.vars['--bg']}` }),
      h('span', { class: 'theme-name', text: o.name }),
      o.sub ? h('span', { class: 'theme-sub', text: 'сейчас: ' + o.sub }) : null,
    );
    box.append(tile);
  }
}

$('set-notify').addEventListener('change', (e) => studio.settings.set({ notifications: e.target.checked }));

$('set-server-save').addEventListener('click', async () => {
  if (!(await modal({ title: 'Сменить сервер?', body: 'Вы выйдете из аккаунта и войдёте уже на новом сервере.', ok: 'Сменить' }))) return;
  try {
    await call(studio.settings.set({ serverUrl: $('set-server').value }));
    showAuth();
  } catch (err) {
    toast(errText(err.code));
  }
});

$('rules-open').addEventListener('click', () => openRulesView());

$('logout').addEventListener('click', async () => {
  if (!(await modal({ title: 'Выйти из аккаунта?', body: 'Чтобы вернуться, понадобятся логин и пароль.', ok: 'Выйти' }))) return;
  await call(studio.auth.logout());
  S.me = null;
  S.msgs.clear();
  showAuth();
});

// ---------- старт ----------

icons();
(async () => {
  try {
    applyTheme((await call(studio.settings.get())).theme);
  } catch {
    applyTheme('auto');
  }
  const st = await call(studio.auth.state());
  if (st.signedIn) enterApp();
  else showAuth();
})();
