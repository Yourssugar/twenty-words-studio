'use strict';
// Интерфейс Twenty Words Studio. Работает в песочнице, с сервером общается
// только через window.studio (см. preload.js).

// window.studio создаёт preload.js, здесь он доступен как глобальная переменная studio.
const $ = (id) => document.getElementById(id);

// ---------- помощники ----------

// append(x, null) печатает слово "null". Пустые части (null, undefined, false) пропускаем
// во всём интерфейсе: так удобнее писать условия прямо в списке.
for (const proto of [Element.prototype, DocumentFragment.prototype]) {
  for (const k of ['append', 'prepend']) {
    const orig = proto[k];
    proto[k] = function (...items) {
      return orig.apply(this, items.filter((x) => x !== null && x !== undefined && x !== false));
    };
  }
}

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
  no_images: 'В общих комнатах только текст. Картинки можно в подчатах, личных сообщениях и обсуждениях.',
  bad_image: 'Картинка не подошла. Нужен png, jpg, webp или gif.',
  too_many: 'Слишком много за сутки. Попробуйте завтра или удалите лишнее.',
  ticket_closed: 'По тикету уже есть решение, менять его может только основатель.',
  month_closed: 'Этот месяц в учёте уже закрыт.',
  bad_input: 'Проверьте, что всё заполнено правильно.',
};
const errText = (code) => ERRORS[code] || (code ? 'Ошибка: ' + code : 'Не получилось. Попробуйте ещё раз.');

async function call(promise) {
  const res = await promise;
  if (!res.ok) {
    const e = new Error(res.error);
    e.code = res.error;
    if (Number.isInteger(res.item)) e.item = res.item;
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

function modal({ title, body, ok = 'Да', danger = false, wide = false }) {
  return new Promise((resolve) => {
    $('modal-title').textContent = title;
    $('modal').querySelector('.modal-card').classList.toggle('is-wide', wide);
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
  chart: '<svg viewBox="0 0 24 24"><path d="M4 20h16M7 17v-5M12 17V7M17 17v-8"/></svg>',
  files: '<svg viewBox="0 0 24 24"><path d="M6 3h8l4 4v14H6zM14 3v4h4M9 12h6M9 16h6"/></svg>',
  globe: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z"/></svg>',
  box: '<svg viewBox="0 0 24 24"><path d="M3 7l9-4 9 4v10l-9 4-9-4zM3 7l9 4 9-4M12 11v10"/></svg>',
  bug: '<svg viewBox="0 0 24 24"><path d="M8 8a4 4 0 0 1 8 0M7 9h10v5a5 5 0 0 1-10 0zM12 9v10M3 12h4M17 12h4M4 7l3 2M20 7l-3 2M4 18l3-2M20 18l-3-2"/></svg>',
  spark: '<svg viewBox="0 0 24 24"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z"/></svg>',
};
function icons(root = document) {
  for (const el of root.querySelectorAll('[data-ico]')) el.innerHTML = ICONS[el.dataset.ico] || '';
}

const COLORS = ['#e9a23b', '#e5534b', '#3fb68b', '#4fa3ff', '#a371f7', '#ff7eb6', '#2ec4b6', '#c9d1d9'];
// Готовые аватарки: список приходит из assets/avatars/avatars.json при запуске.
let PRESETS = ['robot', 'cat', 'fox', 'owl', 'ghost', 'astronaut', 'wizard', 'knight', 'dragon', 'alien', 'panda', 'frog', 'octopus', 'bunny', 'pumpkin', 'snowman'];
let AV_LIST = PRESETS.map((id) => ({ id, group: 'base' }));
let AV_GROUPS = [{ id: 'base', name: 'Основные' }];
studio.app.avatars().then((r) => {
  if (!r.ok || !r.data || !r.data.list.length) return;
  AV_LIST = r.data.list;
  PRESETS = AV_LIST.map((a) => a.id);
  const known = new Set(r.data.groups.map((g) => g.id));
  AV_GROUPS = r.data.groups.concat([...new Set(AV_LIST.map((a) => a.group))].filter((g) => !known.has(g)).map((g) => ({ id: g, name: g })));
}, () => {});

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
  $('tb-today').hidden = true;
  $('tb-focus').hidden = true;
  if (typeof FO !== 'undefined' && FO.on) stopFocus();
  if (typeof closeToday === 'function') closeToday();
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
  // Напоминание о скриншотах, когда уже известно, кто вошёл (основателю ещё очередь проверки).
  setTimeout(() => typeof contribRemind === 'function' && contribRemind(), 2500);
  $('tb-today').hidden = false;
  if (typeof drawFocusButton === 'function') drawFocusButton();
  if (typeof bugsStart === 'function') bugsStart();
  checkServerVersion();
  if (typeof maybeShowToday === 'function') maybeShowToday();
  setTimeout(() => typeof checkMilestones === 'function' && checkMilestones(), 4000);
}

$('tb-focus').addEventListener('click', (e) => toggleFocusPanel(e.currentTarget));
$('rail-browser').addEventListener('click', () => call(studio.browser.open()).catch(() => {}));

$('tb-today').addEventListener('click', () => {
  if (S.me && typeof showToday === 'function') (TD.open ? closeToday() : showToday());
});

function setView(view) {
  if (view === 'admin' && (!S.me || S.me.role !== 'admin')) view = 'home';
  if (S.view === 'home' && view !== 'home' && typeof leaveHome === 'function') leaveHome();
  if (S.view === 'projects' && view !== 'projects' && typeof flushDraft === 'function') flushDraft();
  S.view = view;
  setTitleSection(view);
  for (const b of document.querySelectorAll('.rail-btn')) b.classList.toggle('is-on', b.dataset.view === view);
  for (const p of document.querySelectorAll('[data-view-pane]')) {
    const was = p.hidden;
    p.hidden = p.dataset.viewPane !== view;
    if (was && !p.hidden && typeof fadeIn === 'function') fadeIn(p);
  }
  if (view === 'home' && typeof openHome === 'function') openHome();
  if (typeof drawHubBack === 'function') drawHubBack();
  if (view === 'tools' && typeof openTools === 'function') openTools();
  if (view === 'admin') loadAdmin();
  if (view === 'profile') renderProfile();
  if (view === 'assistant' && typeof openAssistant === 'function') openAssistant();
  if (view === 'projects' && typeof openProjects === 'function') openProjects();
  if (view === 'contrib' && typeof openContrib === 'function') openContrib();
  if (view === 'bugs' && typeof openBugs === 'function') openBugs();
  if (view === 'materials' && typeof openMaterials === 'function') openMaterials();
  if (view === 'chat') {
    markRead();
    $('composer-text').focus();
  }
}
for (const b of document.querySelectorAll('.rail-btn[data-view]')) b.addEventListener('click', () => setView(b.dataset.view));

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

// Обсуждения карточек (комнаты card:<id>) ведёт главная, в home.js, обсуждения тикетов bugs.js.
const isTopicEvent = (ev) => ((ev.m && ev.m.room) || ev.room || '').startsWith('card:');
const isTicketEvent = (ev) => ((ev.m && ev.m.room) || ev.room || '').startsWith('ticket:');

studio.chat.onEvent((ev) => {
  if (isTopicEvent(ev)) return;
  if (isTicketEvent(ev)) {
    if (typeof onTicketChat === 'function') onTicketChat(ev);
    return;
  }
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
      if (!S.rooms.has(m.room)) {
        if (!m.room.startsWith('dm:')) break;
        S.rooms.set(m.room, { id: m.room, kind: 'dm', peer: peerOf(m.room), unread: 0 });
      }
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
        if (!visible && document.hasFocus() && typeof uiSound === 'function') uiSound('message');
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
    case 'feed':
      if (typeof feedSoon === 'function' && S.view === 'home') feedSoon();
      if (typeof milestonesSoon === 'function') milestonesSoon();
      break;
    case 'reports':
      if (typeof onReportsEvent === 'function') onReportsEvent(ev);
      break;
    case 'tickets':
      if (typeof onTicketsEvent === 'function') onTicketsEvent(ev);
      break;
    case 'subroom':
      onSubroomEvent(ev);
      break;
    case 'materials':
      if (typeof onMaterialsEvent === 'function') onMaterialsEvent(ev);
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
  if (r && (r.kind === 'public' || r.kind === 'sub')) return r.title;
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
  const all = [...S.rooms.values()];
  for (const r of all) total += r.unread || 0;
  for (const r of all) {
    if (r.kind !== 'public') continue;
    rooms.append(
      h('div', { class: 'item-row' },
        h('button', { class: 'item' + (r.id === S.room ? ' is-on' : ''), onclick: () => openRoom(r.id) },
          h('span', { class: 'hash', text: '#' }),
          h('span', { class: 'item-name', text: r.title }),
          r.unread ? h('span', { class: 'badge', text: r.unread > 99 ? '99+' : r.unread }) : null,
        ),
        h('button', { class: 'item-add', type: 'button', title: 'Новый подчат в "' + r.title + '"', text: '+', onclick: () => addSubroom(r.id) }),
      ),
    );
    // Подчаты этой комнаты, по алфавиту.
    for (const sr of all.filter((x) => x.kind === 'sub' && x.parent === r.id).sort((a, b) => a.title.localeCompare(b.title, 'ru'))) {
      rooms.append(
        h('button', { class: 'item item-sub' + (sr.id === S.room ? ' is-on' : ''), onclick: () => openRoom(sr.id) },
          h('span', { class: 'hash', text: '-' }),
          h('span', { class: 'item-name', text: sr.title }),
          sr.unread ? h('span', { class: 'badge', text: sr.unread > 99 ? '99+' : sr.unread }) : null,
        ),
      );
    }
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
  const r = S.rooms.get(S.room);
  const tools = $('chat-tools');
  tools.innerHTML = '';
  if (S.room === 'work') sub = 'задачи, решения; только текст, картинки в подчатах';
  else if (S.room === 'free') sub = 'всё остальное; только текст, картинки в подчатах';
  else if (r && r.kind === 'sub') {
    const parent = S.rooms.get(r.parent);
    sub = 'подчат в "' + (parent ? parent.title : r.parent) + '"';
    if (S.me.founder || r.by === S.me.id) tools.append(h('button', { class: 'btn btn-s', type: 'button', text: 'Переименовать', onclick: () => renameSubroom(r) }));
    if (S.me.founder) tools.append(h('button', { class: 'btn btn-s btn-danger', type: 'button', text: 'Удалить подчат', onclick: () => deleteSubroom(r) }));
  } else {
    const u = S.users.get(peerOf(S.room));
    sub = u ? seenLabel(u) : '';
  }
  $('chat-sub').textContent = sub;
  $('composer-text').placeholder = 'Сообщение: ' + roomTitle(S.room);
  const imgOk = imagesAllowedIn(S.room);
  $('composer-img').hidden = !imgOk;
  if (!imgOk && chatAttach.count) chatAttach.clear();
}

// Сервер старее, чем нужно этой версии: новые разделы будут отвечать 404. Говорим сразу.
async function checkServerVersion() {
  try {
    const r = await call(studio.app.server());
    if (r.old || (!r.version && !r.unknown)) {
      const el = h('div', { class: 'toast toast-warn' }, h('span', { text: 'Сервер версии ' + (r.version || 'старше 0.9.0') + ', а приложению нужен ' + r.need + '. Подчаты, картинки, баги и материалы не заработают, пока сервер не обновят (ПАМЯТКА, "Обновить сервер").' }));
      $('toasts').append(el);
      setTimeout(() => el.remove(), 20000);
    }
  } catch {
    /* без проверки */
  }
}

// ---------- подчаты ----------

function onSubroomEvent(ev) {
  if (ev.op === 'delete') {
    S.rooms.delete(ev.room);
    S.msgs.delete(ev.room);
    if (S.room === ev.room) {
      toast('Подчат удалён.');
      openRoom('work');
    }
  } else if (ev.s) {
    const id = 'sub:' + ev.s.id;
    const old = S.rooms.get(id) || { unread: 0 };
    S.rooms.set(id, { ...old, id, kind: 'sub', title: ev.s.title, parent: ev.s.parent, by: ev.s.by });
    if (S.room === id) renderHeader();
  }
  renderSide();
}

function subroomForm(title, value) {
  const input = h('input', { maxlength: '60', placeholder: 'Например: Монтаж ролика про игру', value: value || '' });
  setTimeout(() => input.focus(), 30);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('modal-ok').click();
  });
  return { input, body: h('div', { class: 'col gap-s' }, h('p', { class: 'muted small', text: title }), input) };
}

async function addSubroom(parent) {
  const pr = S.rooms.get(parent);
  const f = subroomForm('Подчат в "' + (pr ? pr.title : parent) + '". В нём можно отправлять картинки. Создать может любой, удалить только основатель.');
  if (!(await modal({ title: 'Новый подчат', body: f.body, ok: 'Создать' })) || !f.input.value.trim()) return;
  try {
    const sr = await call(studio.subrooms.add(parent, f.input.value.trim()));
    onSubroomEvent({ op: 'add', s: sr });
    setView('chat');
    openRoom('sub:' + sr.id);
  } catch (err) {
    toast(errText(err.code));
  }
}

async function renameSubroom(r) {
  const f = subroomForm('Новое название подчата.', r.title);
  if (!(await modal({ title: 'Переименовать подчат', body: f.body, ok: 'Сохранить' })) || !f.input.value.trim()) return;
  try {
    onSubroomEvent({ op: 'edit', s: await call(studio.subrooms.rename(Number(r.id.slice(4)), f.input.value.trim())) });
  } catch (err) {
    toast(errText(err.code));
  }
}

async function deleteSubroom(r) {
  if (!(await modal({ title: 'Удалить подчат "' + r.title + '"?', body: 'Удалятся все сообщения и картинки в нём. Вернуть не получится.', ok: 'Удалить', danger: true }))) return;
  try {
    await call(studio.subrooms.remove(Number(r.id.slice(4))));
    onSubroomEvent({ op: 'delete', room: r.id });
  } catch (err) {
    toast(errText(err.code));
  }
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
    if (m.text || m.edited) body.append(h('div', { class: 'msg-text' }, linkify(m.text), m.edited ? h('span', { class: 'edited', text: ' (изменено)' }) : null));
    const imgs = msgImages(m);
    if (imgs) body.append(imgs);
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
  const pics = m.images && m.images.length ? 'Картинок: ' + m.images.length + ', они тоже удалятся.' : '';
  const text = (m.text.length > 200 ? m.text.slice(0, 200) + '...' : m.text) + (m.text && pics ? '\n\n' : '') + pics;
  const yes = await modal({ title: 'Удалить сообщение?', body: text, ok: 'Удалить', danger: true });
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
const chatAttach = new Attacher($('composer-att'));
bindAttach({ input: composer, dropZone: $('composer'), button: $('composer-img'), attacher: chatAttach, allowed: () => imagesAllowedIn(S.room) });
$('composer').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = composer.value.trim();
  if (!text && !chatAttach.count) return;
  if (!(await sendWithImages(S.room, text, chatAttach))) return;
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
    if (S.me.founder) loadStorage();
  } catch (err) {
    toast(errText(err.code));
  }
}

// Место на сервере: картинки чатов, скриншоты, история исправлений, база, диск.
function fmtBytes(n) {
  if (n >= 1024 ** 3) return (n / 1024 ** 3).toFixed(1).replace('.', ',') + ' ГБ';
  if (n >= 1024 ** 2) return (n / 1024 ** 2).toFixed(1).replace('.', ',') + ' МБ';
  return Math.round(n / 1024) + ' КБ';
}

async function loadStorage() {
  const card = $('storage-card');
  card.hidden = false;
  const box = $('storage-body');
  try {
    const s = await call(studio.tickets.storage());
    const g = (x) => x || { files: 0, bytes: 0 };
    const rows = [
      ['Картинки в подчатах', g(s.chat.sub), 'живут, пока жив подчат'],
      ['Картинки в личных сообщениях', g(s.chat.dm), 'удаляются вместе с сообщением'],
      ['Картинки в обсуждениях карточек', g(s.chat.card), 'удаляются вместе с карточкой'],
      ['Скриншоты тикетов', g(s.chat.ticket), s.rejected ? 'отклонённых тикетов со скриншотами: ' + s.rejected + ', уедут через 7 дней после решения' : ''],
      ['Загружены, но не отправлены', g(s.chat.loose), 'стираются через сутки'],
      ['Скриншоты отчётов', s.shots, 'копия в R2, shots/'],
      ['История исправлений', s.fixes, 'копия в R2, fixes/; на сервере ссылки на те же файлы, место почти не занимают'],
      ['Ждут отправки в R2 и удаления', s.trash, 'уйдут ночью в studio/deleted-tickets/'],
    ];
    const chatTotal = Object.values(s.chat).reduce((a, x) => a + x.bytes, 0);
    box.innerHTML = '';
    box.append(
      h('div', { class: 'tiles storage-tiles' },
        h('div', { class: 'tile' }, h('div', { class: 'muted small', text: 'Картинки чатов' }), h('div', { class: 'tile-num', text: fmtBytes(chatTotal) })),
        h('div', { class: 'tile' }, h('div', { class: 'muted small', text: 'База' }), h('div', { class: 'tile-num', text: fmtBytes(s.db) })),
        s.total ? h('div', { class: 'tile' }, h('div', { class: 'muted small', text: 'Свободно на диске' }), h('div', { class: 'tile-num', text: fmtBytes(s.free) }), h('div', { class: 'muted small', text: 'из ' + fmtBytes(s.total) })) : null),
      h('table', { class: 'table storage-table' },
        h('tbody', {}, ...rows.map(([name, x, note]) => h('tr', {},
          h('td', {}, h('div', { text: name }), note ? h('div', { class: 'muted small', text: note }) : null),
          h('td', { class: 'num', text: String(x.files) }),
          h('td', { class: 'num', text: fmtBytes(x.bytes) }))))),
    );
  } catch (err) {
    box.textContent = errText(err.code);
  }
}
$('storage-refresh').addEventListener('click', loadStorage);

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
  renderLookSettings(s);
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
  // В профиле видна первая группа; выбранная из полного списка картинка встаёт следом за ней.
  const first = AV_LIST.filter((a) => a.group === (AV_GROUPS[0] || {}).id).map((a) => a.id);
  const shown = draftAvatar.type === 'preset' && PRESETS.includes(draftAvatar.id) && !first.includes(draftAvatar.id) ? first.concat(draftAvatar.id) : first;
  for (const id of shown) presets.append(presetBtn(id, draftAvatar, () => renderAvatarPicker()));
  if (AV_LIST.length > first.length) {
    presets.append(h('button', { class: 'preset preset-all', type: 'button', title: 'Все аватары', onclick: openAvatarList },
      gridIco(),
      h('span', { class: 'preset-all-n', text: String(AV_LIST.length) })));
  }
}

function gridIco() {
  const el = h('span', { class: 'preset-all-ico' });
  el.innerHTML = '<svg viewBox="0 0 24 24"><path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z"/></svg>';
  return el;
}

function presetBtn(id, target, after) {
  return h('button', { class: 'preset' + (target.type === 'preset' && target.id === id ? ' is-on' : ''), type: 'button', title: id, onclick: () => {
    Object.assign(target, { type: 'preset', id });
    after();
  } }, avatar({ avatar: { type: 'preset', id, color: target.color } }, 40));
}

async function openAvatarList() {
  const pick = { ...draftAvatar };
  const box = h('div', { class: 'av-all' });
  const draw = () => {
    box.innerHTML = '';
    for (const g of AV_GROUPS) {
      const ids = AV_LIST.filter((a) => a.group === g.id).map((a) => a.id);
      if (!ids.length) continue;
      box.append(h('div', { class: 'av-group' },
        h('div', { class: 'av-group-name muted small', text: g.name + ' · ' + ids.length }),
        h('div', { class: 'presets' }, ...ids.map((id) => presetBtn(id, pick, draw)))));
    }
  };
  draw();
  if (await modal({ title: 'Все аватары', body: box, ok: 'Выбрать', wide: true }) && pick.type === 'preset') {
    draftAvatar = { type: 'preset', id: pick.id, color: draftAvatar.color };
    renderAvatarPicker();
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
      h('span', { class: 'theme-thumb', style: `--tb:${t.bg ? `url("../assets/themes/${t.thumb || t.bg}.webp")` : 'none'};--tc:${t.vars['--accent']};--tg:${t.vars['--bg']}` }),
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
// Старт после того, как прочитаны все скрипты страницы (look.js, player.js, разделы):
// иначе ответ главного процесса может прийти раньше, чем они загрузятся.
window.addEventListener('DOMContentLoaded', async () => {
  try {
    await loadExtraThemes();
    const s = await call(studio.settings.get());
    applyTheme(s.theme);
    initLook(s);
  } catch {
    applyTheme('auto');
  }
  const st = await call(studio.auth.state());
  if (st.signedIn) enterApp();
  else showAuth();
});
