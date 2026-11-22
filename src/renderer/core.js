'use strict';
// Core: персональный помощник без ИИ. Иногда появляется на главной с подсказкой
// (непрочитанное, ответы по тикетам, отчёт) и фразой по поводу (давно не были,
// любимый раздел, ещё не заходили, ночь на дворе) или просто так.
//
// Память: только счётчики и даты, без текстов, без браузера, без того, с кем человек
// переписывается. Хранится на сервере зашифрованной ключом из пароля (main/core.js):
// ни сервер, ни основатели её не читают. Фразы: core-phrases.js.
//
// Показывается только на главной, не чаще раза в 15-20 минут ("редко": раз в час),
// никогда во время фокуса.

const CR = {
  mem: null,
  dirty: false,
  fresh: false, // этот запуск начал новую сессию (перерыв больше 30 минут)
  greeted: false,
  prevLast: 0, // когда были в прошлый раз
  sessionSec: 0, // сколько минут в студии с начала сессии (не хранится)
  nextAt: 0,
  card: null,
  hideTimer: 0,
  meetAsked: false,
  starting: false,
};

const CORE_VIEWS = { home: 'Главная', chat: 'Чат', projects: 'Проекты', assistant: 'Ассистент', contrib: 'Вклад', materials: 'Материалы', bugs: 'Баги', tools: 'Инструменты' };
const CORE_GAP = 30 * 60 * 1000;
const H = 3600e3;
const DAYMS = 864e5;

const coreMode = () => (LOOK.s && LOOK.s.coreMode) || 'often';
const coreRnd = (a, b) => a + Math.random() * (b - a);
const pick1 = (arr) => arr[Math.floor(Math.random() * arr.length)];

function dayKey(t) {
  const d = new Date(t);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function weekKey(t) {
  const d = new Date(t);
  const day = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - day);
  return dayKey(d.getTime());
}

function coreDur(sec) {
  const m = Math.round(sec / 60);
  if (m < 60) return m + ' ' + plural(m, 'минуту', 'минуты', 'минут');
  const hh = Math.floor(m / 60);
  const mm = m % 60;
  return hh + ' ' + plural(hh, 'час', 'часа', 'часов') + (mm ? ' ' + mm + ' мин' : '');
}

const fmtDays = (n) => n + ' ' + plural(n, 'день', 'дня', 'дней');

// ---------- память ----------

// Запускается после входа и ещё раз, когда сервер прислал "ready" с данными человека:
// через туннель "ready" приходит позже, чем открывается главная.
async function coreStart() {
  if (!S.me || CR.mem || CR.starting) return;
  CR.starting = true;
  let mem = {};
  try {
    mem = (await call(studio.core.load(S.me.id))) || {};
  } catch {
    /* память не загрузилась: начинаем с пустой */
  }
  CR.starting = false;
  if (!S.me) return; // пока грузилось, вышли из аккаунта
  CR.mem = mem;
  const m = CR.mem;
  const now = Date.now();
  CR.prevLast = m.lastAt || 0;
  CR.greeted = false;
  CR.sessionSec = 0;
  if (!m.lastAt || now - m.lastAt > CORE_GAP) {
    CR.fresh = true;
    m.sessions = (m.sessions || 0) + 1;
    m.gapLast = m.lastAt ? now - m.lastAt : 0;
    if (!m.first) m.first = now;
    const hr = new Date(now).getHours();
    const tod = hr < 5 ? 'night' : hr < 12 ? 'morning' : hr < 18 ? 'day' : 'evening';
    m.tod = m.tod || {};
    m.tod[tod] = (m.tod[tod] || 0) + 1;
    const today = dayKey(now);
    if (m.day !== today) {
      m.streak = m.day === dayKey(now - DAYMS) ? (m.streak || 0) + 1 : 1;
      m.bestStreak = Math.max(m.bestStreak || 0, m.streak);
      m.days = (m.days || 0) + 1;
      m.day = today;
    }
  } else {
    CR.fresh = false;
  }
  m.lastAt = now;
  CR.dirty = true;
  // Новый заход или ещё не познакомились: почти сразу. Перезапуск посреди работы: через 4-6 минут.
  CR.nextAt = now + (CR.fresh || !(m.me && m.me.name) ? 4000 : coreRnd(4, 6) * 60e3);
  coreSave();
}

async function coreSave() {
  if (!CR.mem || !CR.dirty) return;
  CR.dirty = false;
  try {
    const r = await call(studio.core.save(CR.mem));
    // При конфликте двух компьютеров главный процесс вернёт слитую память.
    if (r && r.mem) CR.mem = Object.assign(r.mem, { lastAt: Math.max(r.mem.lastAt || 0, CR.mem.lastAt || 0) });
  } catch {
    CR.dirty = true;
  }
}

// Раз в 30 секунд: время в текущем разделе, только когда окно на экране и в фокусе.
setInterval(() => {
  if (!CR.mem || !S.me || !S.view || document.visibilityState !== 'visible' || !document.hasFocus()) return;
  const m = CR.mem;
  const v = CORE_VIEWS[S.view] ? S.view : null;
  m.lastAt = Date.now();
  CR.sessionSec += 30;
  if (v) {
    m.sec = m.sec || {};
    m.sec[v] = (m.sec[v] || 0) + 30;
    m.weeks = m.weeks || {};
    const wk = weekKey(Date.now());
    m.weeks[wk] = m.weeks[wk] || {};
    m.weeks[wk][v] = (m.weeks[wk][v] || 0) + 30;
    // Храним только последние 8 недель.
    const keys = Object.keys(m.weeks).sort();
    while (keys.length > 8) delete m.weeks[keys.shift()];
    m.seenViews = m.seenViews || {};
    m.seenViews[v] = 1;
  }
  CR.dirty = true;
}, 30000);
setInterval(coreSave, 120000);
window.addEventListener('beforeunload', () => coreSave());

// Счётчики из других частей приложения (без содержимого): coreCount('tokens', 120),
// coreCount('focus', 1, 'n'), coreCount('models', 1, 'glm-4.6').
function coreCount(a, n = 1, b) {
  if (!CR.mem) return;
  if (b) {
    CR.mem[a] = CR.mem[a] || {};
    CR.mem[a][b] = (CR.mem[a][b] || 0) + n;
  } else {
    CR.mem[a] = (CR.mem[a] || 0) + n;
  }
  CR.dirty = true;
}

// ---------- выбор фразы ----------

function fill(text, vars) {
  const me = (CR.mem && CR.mem.me) || {};
  return text
    .replace(/\{g:([^|}]*)\|([^}]*)\}/g, (_, a, b) => (me.gender === 'f' ? b : a))
    .replace(/\{(\w+)\}/g, (_, k) => (k === 'name' ? me.name || '' : vars[k] !== undefined ? String(vars[k]) : ''));
}

// Фраза темы, которую давно не показывали. Фразы с {name} только если имя есть.
function phrase(topic, vars = {}) {
  const pool = CORE_PHRASES[topic] || [];
  const hasName = !!(CR.mem && CR.mem.me && CR.mem.me.name);
  const shown = (CR.mem && CR.mem.shown) || {};
  const ok = pool.map((t, i) => ({ t, id: topic + '.' + i })).filter((x) => hasName || !x.t.includes('{name}'));
  if (!ok.length) return null;
  const oldest = Math.min(...ok.map((x) => shown[x.id] || 0));
  const choice = pick1(ok.filter((x) => (shown[x.id] || 0) === oldest));
  return { id: choice.id, text: fill(choice.t, vars) };
}

function cooled(key, ms) {
  const t = (CR.mem.topics || {})[key] || 0;
  return Date.now() - t >= ms;
}

function markTopic(key) {
  CR.mem.topics = CR.mem.topics || {};
  CR.mem.topics[key] = Date.now();
  // не копим вечно: только 300 последних отметок
  const keys = Object.keys(CR.mem.topics);
  if (keys.length > 300) keys.sort((a, b) => CR.mem.topics[a] - CR.mem.topics[b]).slice(0, keys.length - 300).forEach((k) => delete CR.mem.topics[k]);
}

const offTopic = (t) => !!(CR.mem.off || {})[t];

// Полезное в моменте: берётся из того, что приложение уже знает, и не хранится.
function pickUseful() {
  const list = [];
  // ответы и решения по своим тикетам
  if (typeof BG !== 'undefined' && BG.list) {
    for (const t of BG.list.filter((x) => x.user === S.me.id)) {
      const seen = (CR.mem.ticketsSeen || {})[t.id] || 0;
      if (t.status === 'closed' && t.checked > seen) {
        list.push({ topic: 'ticket_decision', key: 'td' + t.id, vars: { id: t.id, verdict: (VERDICTS[t.verdict] || 'закрыт').toLowerCase() }, ticket: t.id, action: { label: 'К тикету', go: () => { setView('bugs'); showTicket(t.id); } } });
      } else if (t.unread > 0) {
        list.push({ topic: 'ticket_reply', key: 'tr' + t.id + '.' + t.messages, vars: { id: t.id }, action: { label: 'К тикету', go: () => { setView('bugs'); showTicket(t.id); } } });
      }
    }
  }
  // непрочитанное
  let dm = 0;
  let rooms = 0;
  let top = null;
  for (const r of S.rooms.values()) {
    if (!r.unread) continue;
    if (r.kind === 'dm') dm += r.unread;
    else {
      rooms += r.unread;
      if (!top || r.unread > top.unread) top = r;
    }
  }
  if (dm) list.push({ topic: 'unread_dm', key: 'dm' + dm, cd: 30 * 60e3, vars: { n: dm }, action: { label: 'Открыть чат', go: () => setView('chat') } });
  if (rooms) list.push({ topic: 'unread_rooms', key: 'rm' + rooms, cd: 30 * 60e3, vars: { n: rooms, room: top ? top.title : '' }, action: { label: 'Открыть чат', go: () => { setView('chat'); if (top) openRoom(top.id); } } });
  // отчёт по напоминанию
  if (typeof dueReminders === 'function' && dueReminders().length) list.push({ topic: 'report_due', key: 'rep', cd: 3 * H, vars: {}, action: { label: 'Ко вкладу', go: () => setView('contrib') } });
  // новое в ленте с прошлого раза (только чужое)
  if (CR.fresh && typeof FD !== 'undefined' && CR.prevLast) {
    const n = FD.items.filter((f) => f.at > CR.prevLast && f.user !== S.me.id).length;
    if (n) list.push({ topic: 'feed_news', key: 'feed' + CR.prevLast, vars: { n } });
  }
  return list.find((x) => !offTopic(x.topic) && cooled(x.topic + ':' + x.key, x.cd || 1e15)) || null;
}

// Наблюдения и шутки: что подходит сейчас, с паузами между повторами.
function pickFun() {
  const m = CR.mem;
  const now = Date.now();
  const hr = new Date(now).getHours();
  const wd = new Date(now).getDay();
  const c = [];
  const add = (topic, cd, vars, weight = 3, action, key = topic) => {
    if (!offTopic(topic) && cooled('f:' + key, cd)) c.push({ topic, vars, weight, action, key });
  };
  const sections = Object.keys(CORE_VIEWS).filter((v) => v !== 'home');
  const never = sections.filter((v) => !(m.seenViews || {})[v]);
  if (never.length && (m.sessions || 0) >= 2) {
    const v = pick1(never);
    add('never_visited', DAYMS, { sec: CORE_VIEWS[v] }, 3, { label: 'Заглянуть', go: () => setView(v) });
  }
  const wk = (m.weeks || {})[weekKey(now)] || {};
  const fav = Object.entries(wk).filter(([v]) => v !== 'home').sort((a, b) => b[1] - a[1])[0];
  if (fav && fav[1] >= 20 * 60) add('favorite', 2 * DAYMS, { sec: CORE_VIEWS[fav[0]] || fav[0], time: coreDur(fav[1]) });
  if ((m.streak || 0) >= 3) add('streak', DAYMS, { n: m.streak });
  if (CR.sessionSec >= 2 * 3600) add('long_session', 2 * H, { time: coreDur(CR.sessionSec) }, 4);
  if (hr < 5) add('night', 3 * H, { h: String(hr).padStart(2, '0') + ':' + String(new Date(now).getMinutes()).padStart(2, '0') }, 4);
  if (hr >= 5 && hr < 8) add('early', DAYMS, {});
  if (wd === 0 || wd === 6) add('weekend', DAYMS, {}, 2);
  if (wd === 1) add('monday', DAYMS, {}, 2);
  if (wd === 5) add('friday', DAYMS, {}, 2);
  const f = m.focus || {};
  if ((f.n || 0) >= 3) add('focus_stats', 3 * DAYMS, { n: f.n, min: f.min || 0, h: Math.round((f.min || 0) / 60) });
  if (!f.n && (m.sessions || 0) >= 5) add('focus_never', 3 * DAYMS, {}, 2, { label: 'Попробовать', go: () => toggleFocusPanel(document.querySelector('.feed-focus')) });
  const models = Object.entries(m.models || {}).sort((a, b) => b[1] - a[1]);
  if (models[0] && models[0][1] >= 10) {
    const q = typeof AI !== 'undefined' ? (AI.models || []).find((x) => x.model === models[0][0]) : null;
    add('model_love', 7 * DAYMS, { model: q ? q.label : models[0][0] }, 2);
  }
  if ((m.tokens || 0) >= 100000) add('tokens_big', 7 * DAYMS, { tokens: Math.round(m.tokens / 1000) + ' тысяч' }, 2);
  const mus = Object.entries(m.music || {}).sort((a, b) => b[1] - a[1]);
  if (!mus.length && (m.sessions || 0) >= 4) add('music_none', 3 * DAYMS, {}, 2);
  if (mus[0] && mus[0][1] >= 5) add('music_src', 7 * DAYMS, { src: { studio: 'музыку студии', folder: 'свою папку с музыкой', radio: 'радио' }[mus[0][0]] || 'музыку' }, 1);
  for (const n of [10, 25, 50, 100, 250, 500]) if (m.sessions === n) add('milestone', 1e15, { n }, 6, null, 'milestone' + n);
  if (m.first && now - m.first >= 30 * DAYMS && now - m.first < 40 * DAYMS) add('month_in', 1e15, {}, 5);
  add('joke', 0, {}, 2);
  add('tip', 0, {}, 1);
  // случайно с весами
  const total = c.reduce((s, x) => s + x.weight, 0);
  let r = Math.random() * total;
  for (const x of c) {
    r -= x.weight;
    if (r <= 0) return x;
  }
  return c[0] || null;
}

function pickGreeting() {
  const gap = CR.mem.gapLast || 0;
  if (!CR.prevLast) return null;
  if (gap >= 14 * DAYMS) return { topic: 'back_very_long', vars: { days: fmtDays(Math.floor(gap / DAYMS)) } };
  if (gap >= 2 * DAYMS) return { topic: 'back_long', vars: { days: fmtDays(Math.floor(gap / DAYMS)) } };
  if (gap >= 6 * H) return { topic: 'back_day', vars: {} };
  return { topic: 'back_short', vars: {} };
}

const lowerFirst = (s) => (s && /^[А-ЯЁA-Z]/.test(s) && !/^[А-ЯЁA-Z]{2}/.test(s) ? s[0].toLowerCase() + s.slice(1) : s);
const upperFirst = (s) => (s ? s.replace(/^(["(]?)(.)/, (_, q, c) => q + c.toUpperCase()) : s);

// Картинка Юны: вид из настроек (a, b, c) и настроение темы.
const YUNA_LOOKS = ['a', 'b', 'c'];
const yunaLook = () => (YUNA_LOOKS.includes(LOOK.s && LOOK.s.yunaLook) ? LOOK.s.yunaLook : 'a');
const moodOf = (topic) => {
  const m = (typeof CORE_MOODS !== 'undefined' && CORE_MOODS[topic]) || 'neutral';
  return Array.isArray(m) ? pick1(m) : m;
};
const yunaPic = (mood, look = yunaLook()) => '../assets/yuna/' + look + '/' + (mood || 'neutral') + '.webp';

// Собрать сообщение: приветствие или полезное, потом "А ещё, ..." с фразой.
function composeCore() {
  const parts = [];
  const used = [];
  let action = null;
  let offable = null;
  let gTopic = null;
  let uTopic = null;
  let fTopic = null;
  if (CR.fresh && !CR.greeted) {
    const g = pickGreeting();
    if (g) {
      const p = phrase(g.topic, g.vars);
      if (p) {
        parts.push(p.text);
        used.push(p.id);
        gTopic = g.topic;
      }
    }
    CR.greeted = true;
  }
  const u = pickUseful();
  if (u) {
    const p = phrase(u.topic, u.vars);
    if (p) {
      parts.push(upperFirst(p.text));
      used.push(p.id);
      uTopic = u.topic;
      markTopic(u.topic + ':' + u.key);
      if (u.ticket) {
        CR.mem.ticketsSeen = CR.mem.ticketsSeen || {};
        CR.mem.ticketsSeen[u.ticket] = Date.now();
      }
      action = u.action || null;
    }
  }
  if (parts.length < 2) {
    const f = pickFun();
    if (f) {
      const p = phrase(f.topic, f.vars);
      if (p) {
        parts.push(parts.length ? pick1(CORE_JOINS) + ', ' + lowerFirst(p.text) : upperFirst(p.text));
        used.push(p.id);
        fTopic = f.topic;
        markTopic('f:' + f.key);
        if (!action && f.action) action = f.action;
        if (f.topic !== 'joke' && f.topic !== 'tip') offable = f.topic;
      }
    }
  }
  if (!parts.length) return null;
  CR.mem.shown = CR.mem.shown || {};
  for (const id of used) CR.mem.shown[id] = Date.now();
  CR.dirty = true;
  // Лицо: удивление после долгой паузы важнее, иначе по последней фразе.
  const lead = gTopic === 'back_long' || gTopic === 'back_very_long' ? gTopic : fTopic || uTopic || gTopic;
  return { parts, action, offable, mood: moodOf(lead) };
}

// ---------- когда показывать ----------

function coreCanShow() {
  if (!CR.mem || !S.me || coreMode() === 'off') return false;
  if (S.view !== 'home' || FO.on || CR.card) return false;
  if (document.visibilityState !== 'visible') return false;
  if (!$('modal').hidden || (typeof B !== 'undefined' && (B.open || B.topic))) return false;
  const today = $('today');
  if (today && !today.hidden) return false;
  return Date.now() >= CR.nextAt;
}

function coreSchedule() {
  CR.nextAt = Date.now() + (coreMode() === 'rare' ? coreRnd(55, 70) : coreRnd(15, 20)) * 60e3;
}

setInterval(() => {
  if (!coreCanShow()) return;
  if (!(CR.mem.me && CR.mem.me.name) && !CR.meetAsked) {
    CR.meetAsked = true;
    showMeet();
    return;
  }
  const msg = composeCore();
  coreSchedule();
  if (msg) showCoreCard(msg);
  coreSave();
}, 5000);

// ---------- карточка ----------

function coreFrame(body, wide, mood) {
  hideCoreCard(true);
  const pic = h('div', { class: 'core-pic' }, h('img', { src: yunaPic(mood), alt: '', draggable: 'false' }));
  const card = h('div', { class: 'core-card' + (wide ? ' is-wide' : '') },
    h('button', { class: 'core-x', type: 'button', title: 'Закрыть', text: 'x', onclick: () => hideCoreCard() }),
    pic,
    h('div', { class: 'core-main' }, h('div', { class: 'core-name' }, h('b', { text: 'Юна' }), h('span', { class: 'muted small', text: 'ваш помощник' })), body));
  card.addEventListener('mouseenter', () => clearTimeout(CR.hideTimer));
  card.addEventListener('mouseleave', () => armCoreHide());
  document.querySelector('.home-stage').append(card);
  CR.card = card;
  return card;
}

function armCoreHide() {
  clearTimeout(CR.hideTimer);
  CR.hideTimer = setTimeout(() => hideCoreCard(), 35000);
}

function showCoreCard(msg) {
  const body = h('div', { class: 'core-body' }, ...msg.parts.map((t) => h('p', { text: t })));
  const row = h('div', { class: 'core-actions' });
  if (msg.action) row.append(h('button', { class: 'btn btn-s btn-accent', type: 'button', text: msg.action.label, onclick: () => { hideCoreCard(); msg.action.go(); } }));
  row.append(h('button', { class: 'btn btn-s', type: 'button', text: 'Ясно', onclick: () => hideCoreCard() }));
  if (msg.offable) {
    row.append(h('button', { class: 'b-link', type: 'button', text: 'не напоминай об этом', onclick: () => {
      CR.mem.off = CR.mem.off || {};
      CR.mem.off[msg.offable] = 1;
      CR.dirty = true;
      hideCoreCard();
      toast('Хорошо, об этом больше не буду.');
    } }));
  }
  body.append(row);
  coreFrame(body, false, msg.mood);
  if (typeof uiSound === 'function') uiSound('message');
  armCoreHide();
}

function hideCoreCard(now) {
  clearTimeout(CR.hideTimer);
  const c = CR.card;
  CR.card = null;
  if (!c) return;
  if (now) return c.remove();
  c.classList.add('is-out');
  setTimeout(() => c.remove(), 300);
}

// Ушли с главной: карточка уходит вместе с ней.
function coreOnView() {
  if (S.view !== 'home') hideCoreCard(true);
}

// ---------- знакомство ----------

function showMeet() {
  const me = (CR.mem && CR.mem.me) || {};
  const name = h('input', { maxlength: '30', placeholder: 'Имя или ник', value: me.name || '' });
  let gender = me.gender || 'm';
  const seg = segOf([['m', 'Мужской'], ['f', 'Женский']], gender, (v) => {
    gender = v;
  });
  const save = () => {
    const n = name.value.replace(/\s+/g, ' ').trim().slice(0, 30);
    if (!n) return name.focus();
    if (!CR.mem) CR.mem = {};
    CR.mem.me = { name: n, gender };
    CR.mem.met = Date.now();
    CR.dirty = true;
    coreSave();
    hideCoreCard(true);
    const p = phrase(CORE_BOSS.test(n) ? 'meet_boss' : 'meet_done', {});
    if (p) {
      CR.mem.shown = CR.mem.shown || {};
      CR.mem.shown[p.id] = Date.now();
      showCoreCard({ parts: [p.text], action: null, offable: null, mood: moodOf(CORE_BOSS.test(n) ? 'meet_boss' : 'meet_done') });
    }
    coreSchedule();
  };
  name.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') save();
  });
  const body = h('div', { class: 'core-body' },
    h('p', { text: 'Здравствуйте! Я Юна, ваш персональный помощник. Буду подсказывать, где что непрочитано, и иногда болтать. Как мне к вам обращаться?' }),
    h('label', { class: 'field' }, h('span', { text: 'Имя или ник' }), name),
    h('div', { class: 'field' }, h('span', { text: 'В каком роде к вам обращаться' }), seg),
    h('p', { class: 'muted small', text: 'Это и всё, что я о вас помню, кроме счётчиков вроде "сколько минут в Проектах". Память зашифрована вашим паролем: даже основатели её не видят.' }),
    h('div', { class: 'core-actions' },
      h('button', { class: 'btn btn-s btn-accent', type: 'button', text: 'Запомнить', onclick: save }),
      h('button', { class: 'btn btn-s', type: 'button', text: 'Позже', onclick: () => { hideCoreCard(); coreSchedule(); } })));
  coreFrame(body, true, moodOf('meet'));
  setTimeout(() => name.focus(), 50);
}

// ---------- настройки ----------

function renderCoreSettings() {
  const box = $('core-settings');
  if (!box) return;
  box.innerHTML = '';
  const me = (CR.mem && CR.mem.me) || {};
  box.append(
    h('div', { class: 'field' }, h('span', { text: 'Как часто' }), segOf([['often', 'Раз в 15-20 минут'], ['rare', 'Раз в час'], ['off', 'Молчит']], coreMode(), (v) => {
      saveLook({ coreMode: v });
      if (v === 'off') hideCoreCard();
      else coreSchedule();
    })),
    h('p', { class: 'muted small', text: 'Юна появляется только на главной и никогда во время фокуса.' }),
    h('div', { class: 'field' }, h('span', { text: 'Как выглядит' }),
      h('div', { class: 'yuna-looks' }, ...YUNA_LOOKS.map((l) => h('button', {
        class: 'yuna-look' + (yunaLook() === l ? ' is-on' : ''), type: 'button', title: { a: 'Тёмные волосы', b: 'Рыжие волосы', c: 'Аниме' }[l],
        onclick: async () => {
          await saveLook({ yunaLook: l });
          renderCoreSettings();
          const img = CR.card && CR.card.querySelector('.core-pic img');
          if (img) img.src = img.src.replace(/\/yuna\/[abc]\//, '/yuna/' + l + '/');
        },
      }, h('img', { src: yunaPic('smile', l), alt: '' }))))),
    h('div', { class: 'row between' },
      h('span', { class: 'small', text: me.name ? 'Обращается к вам: ' + me.name + (me.gender === 'f' ? ' (ж)' : ' (м)') : 'Ещё не познакомились' }),
      h('button', { class: 'btn btn-s', type: 'button', text: me.name ? 'Изменить' : 'Познакомиться', onclick: () => { setView('home'); CR.meetAsked = true; setTimeout(showMeet, 300); } })),
    h('p', { class: 'muted small', text: 'Что Юна помнит: заходы, сколько минут в каждом разделе, серию дней, фокус-сессии, любимую модель ассистента и токены, какой источник музыки чаще. Что не помнит никогда: браузер, тексты чатов, ассистента и отчётов, с кем вы переписываетесь, имена файлов. Память хранится на сервере, зашифрованная вашим паролем: ни сервер, ни основатели её не прочитают. Если пароль сбросят, память начнётся заново.' }),
    h('button', { class: 'btn btn-s btn-danger-ghost', type: 'button', text: 'Забыть всё', onclick: async () => {
      if (!(await modal({ title: 'Юна забудет всё?', body: 'Имя, счётчики и всё, что Юна показывала. Начнём знакомство заново.', ok: 'Забыть', danger: true }))) return;
      try {
        CR.mem = (await call(studio.core.forget())) || {};
      } catch {
        CR.mem = {};
      }
      CR.meetAsked = false;
      CR.fresh = false;
      hideCoreCard(true);
      renderCoreSettings();
      toast('Готово. Юна вас не помнит.');
    } }),
  );
}
