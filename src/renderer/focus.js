'use strict';
// Режим фокуса: прячет всё, кроме главной, а на главной вместо графа четыре блока
// (Инструменты, Ассистент, Проекты, Браузер). Музыка играет дальше. Таймер работы и перерыва (25/5, 50/10, 90/15) или без таймера. По желанию
// "не беспокоить": без системных уведомлений о сообщениях и без звуков интерфейса.
// Кнопка "Фокус" в полосе заголовка: включить, посмотреть остаток, закончить.

const FO = { on: false, dnd: true, work: 50, rest: 10, phase: 'work', end: 0, rounds: 0, tick: 0 };
const FOCUS_PLANS = [[25, 5], [50, 10], [90, 15], [0, 0]];

function focusLeft() {
  return Math.max(0, FO.end - Date.now());
}

function fmtLeft(ms) {
  const s = Math.ceil(ms / 1000);
  const m = Math.floor(s / 60);
  return m + ':' + String(s % 60).padStart(2, '0');
}

// Кнопка в полосе заголовка видна только в фокусе: таймер и выход. Включают фокус
// кнопкой у ленты команды на главной.
function drawFocusButton() {
  const b = $('tb-focus');
  if (!b) return;
  b.hidden = !FO.on || !S.me;
  b.classList.toggle('is-on', FO.on);
  b.classList.toggle('is-rest', FO.on && FO.phase === 'rest');
  if (!FO.on) b.textContent = 'Фокус';
  else if (!FO.work) b.textContent = 'Фокус';
  else b.textContent = (FO.phase === 'work' ? 'Фокус ' : 'Перерыв ') + fmtLeft(focusLeft());
}

function startFocus(work, rest, dnd) {
  FO.on = true;
  FO.work = work;
  FO.rest = rest;
  FO.dnd = dnd;
  FO.phase = 'work';
  FO.rounds = 0;
  FO.end = work ? Date.now() + work * 60000 : 0;
  document.documentElement.classList.add('focus-mode');
  setView('home');
  showHub();
  studio.win.dnd(dnd).catch(() => {});
  clearInterval(FO.tick);
  FO.tick = setInterval(focusTick, 1000);
  drawFocusButton();
  if (typeof renderFeed === 'function' && S.view === 'home') renderFeed();
  toast(work ? 'Фокус на ' + work + ' минут' + (dnd ? ', уведомления выключены' : '') : 'Фокус без таймера' + (dnd ? ', уведомления выключены' : ''));
}

async function stopFocus() {
  FO.on = false;
  clearInterval(FO.tick);
  $('focus-pop').hidden = true;
  drawRest();
  await hideHub();
  document.documentElement.classList.remove('focus-mode');
  drawHubBack();
  studio.win.dnd(false).catch(() => {});
  drawFocusButton();
  $('focus-pop').hidden = true;
  if (typeof renderFeed === 'function' && S.view === 'home') renderFeed();
  if (FO.rounds) toast('Фокус закончен. Рабочих отрезков: ' + FO.rounds + '.');
}

// Сигнал смены отрезка звучит даже при "не беспокоить": ради него таймер и ставят.
function focusSignal(title, body) {
  const saved = LOOK.s && LOOK.s.uiSounds;
  if (LOOK.s) LOOK.s.uiSounds = true;
  const dnd = FO.dnd;
  FO.dnd = false;
  uiSound('remind');
  FO.dnd = dnd;
  if (LOOK.s) LOOK.s.uiSounds = saved;
  toast(title + '. ' + body);
  studio.app.notify(title, body).catch(() => {});
}

function focusTick() {
  if (!FO.on || !FO.work) return;
  if (focusLeft() <= 0) {
    if (FO.phase === 'work') {
      FO.rounds += 1;
      FO.phase = 'rest';
      if (typeof coreCount === 'function') {
        coreCount('focus', 1, 'n');
        coreCount('focus', FO.work, 'min');
      }
      FO.end = Date.now() + FO.rest * 60000;
      focusSignal('Перерыв ' + FO.rest + ' минут', 'Встань, разомнись, посмотри вдаль.');
    } else {
      FO.phase = 'work';
      FO.end = Date.now() + FO.work * 60000;
      focusSignal('Перерыв закончился', 'Следующие ' + FO.work + ' минут работы.');
    }
  }
  drawFocusButton();
  if (!$('focus-pop').hidden) drawFocusPanel();
  drawRest();
}

function toggleFocusPanel(anchor) {
  const pop = $('focus-pop');
  if (!pop.hidden) {
    pop.hidden = true;
    return;
  }
  pop.hidden = false;
  const r = (anchor || $('tb-focus')).getBoundingClientRect();
  pop.style.left = Math.max(8, Math.min(window.innerWidth - 340, r.left)) + 'px';
  pop.style.top = r.bottom + 6 + 'px';
  drawFocusPanel();
}

function drawFocusPanel() {
  const pop = $('focus-pop');
  pop.innerHTML = '';
  if (FO.on) {
    pop.append(
      h('div', { class: 'fo-big', text: FO.work ? fmtLeft(focusLeft()) : 'без таймера' }),
      h('p', { class: 'muted small', text: FO.work ? (FO.phase === 'work' ? 'до перерыва, отрезок ' + (FO.rounds + 1) : 'до конца перерыва, позади отрезков: ' + FO.rounds) + (FO.dnd ? '. Уведомления выключены.' : '.') : (FO.dnd ? 'Уведомления выключены.' : '') }),
      h('div', { class: 'row gap-s' },
        FO.work ? h('button', { class: 'btn btn-s', type: 'button', text: FO.phase === 'work' ? 'Перерыв сейчас' : 'Пропустить перерыв', onclick: () => { FO.end = Date.now(); focusTick(); } }) : null,
        h('button', { class: 'btn btn-s btn-accent', type: 'button', text: 'Закончить', onclick: stopFocus }),
      ),
    );
    return;
  }
  let plan = FOCUS_PLANS.findIndex(([w]) => w === FO.work);
  if (plan < 0) plan = 1;
  const seg = h('div', { class: 'seg seg-inline fo-plans' });
  const drawSeg = () => {
    seg.innerHTML = '';
    FOCUS_PLANS.forEach(([w, r], i) => seg.append(h('button', {
      class: 'seg-btn' + (i === plan ? ' is-on' : ''), type: 'button', text: w ? w + ' / ' + r : 'Без таймера',
      onclick: () => { plan = i; drawSeg(); },
    })));
  };
  drawSeg();
  const dnd = h('input', { type: 'checkbox' });
  dnd.checked = FO.dnd;
  pop.append(
    h('p', { class: 'small', text: 'Останется только главная: вместо графа четыре блока (Инструменты, Ассистент, Проекты, Браузер). Музыка продолжит играть.' }),
    h('div', { class: 'field' }, h('span', { text: 'Минут работы / перерыва' }), seg),
    h('label', { class: 'check small' }, dnd, h('span', { text: 'Не беспокоить: без уведомлений о сообщениях и звуков' })),
    h('div', { class: 'row gap-s' },
      h('button', { class: 'btn btn-accent btn-s', type: 'button', text: 'Начать', onclick: () => {
        const [w, r] = FOCUS_PLANS[plan];
        pop.hidden = true;
        startFocus(w, r, dnd.checked);
      } }),
      typeof PL !== 'undefined' && !PL.playing ? h('button', { class: 'btn btn-s', type: 'button', text: 'Начать и включить музыку', onclick: () => {
        const [w, r] = FOCUS_PLANS[plan];
        pop.hidden = true;
        startFocus(w, r, dnd.checked);
        playMusic();
      } }) : null,
    ),
  );
}

document.addEventListener('mousedown', (e) => {
  const pop = $('focus-pop');
  if (pop && !pop.hidden && !pop.contains(e.target) && !e.target.closest('#tb-focus, .js-focus')) pop.hidden = true;
});

// ---------- блоки на главной в режиме фокуса ----------
//
// В фокусе граф на главной сменяют четыре одинаковых блока: Инструменты, Ассистент,
// Проекты, Браузер. Они вылетают из центра графа и уходят обратно при выходе.
// Блоки можно перетаскивать: соседи плавно уступают место, порядок запоминается.

const HUB = {
  items: [
    { id: 'tools', title: 'Инструменты', sub: 'кузница и редакторы', ico: 'tools', go: () => setView('tools') },
    { id: 'assistant', title: 'Ассистент', sub: 'чат с моделью', ico: 'spark', go: () => setView('assistant') },
    { id: 'projects', title: 'Проекты', sub: 'свои проекты и запуск', ico: 'files', go: () => setView('projects') },
    { id: 'browser', title: 'Браузер', sub: 'TikTok, YouTube и закладки', ico: 'globe', go: () => call(studio.browser.open()).catch(() => {}) },
  ],
  order: null,
  drag: null,
};

const GLOBE = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z"/></svg>';

function hubOrder() {
  const ids = HUB.items.map((x) => x.id);
  const saved = (LOOK.s && Array.isArray(LOOK.s.focusOrder) ? LOOK.s.focusOrder : []).filter((x) => ids.includes(x));
  return [...new Set([...saved, ...ids])];
}

function hubEl() {
  let el = $('focus-hub');
  if (!el) {
    el = h('div', { class: 'focus-hub', id: 'focus-hub', hidden: true });
    document.querySelector('.home-stage').append(el);
  }
  return el;
}

function renderHub() {
  const box = hubEl();
  box.innerHTML = '';
  HUB.order = hubOrder();
  for (const id of HUB.order) {
    const it = HUB.items.find((x) => x.id === id);
    const ico = h('span', { class: 'hub-ico' });
    ico.innerHTML = it.ico === 'globe' ? GLOBE : ICONS[it.ico] || '';
    const tile = h('button', { class: 'hub-tile', type: 'button', dataset: { id } },
      ico, h('span', { class: 'hub-title', text: it.title }), h('span', { class: 'hub-sub', text: it.sub }));
    tile.addEventListener('pointerdown', (e) => hubDown(e, tile));
    box.append(tile);
  }
}

// Вылет из центра графа (in) или обратно в центр (out).
function hubFly(dir) {
  const box = hubEl();
  const tiles = [...box.querySelectorAll('.hub-tile')];
  const r = box.getBoundingClientRect();
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  const still = typeof motionLevel === 'function' && motionLevel() === 'off';
  return new Promise((done) => {
    if (still) return done();
    tiles.forEach((t, i) => {
      const b = t.getBoundingClientRect();
      const dx = cx - (b.left + b.width / 2);
      const dy = cy - (b.top + b.height / 2);
      const away = `translate(${dx}px, ${dy}px) scale(.25)`;
      t.style.transition = 'none';
      if (dir === 'in') {
        t.style.transform = away;
        t.style.opacity = '0';
        t.getBoundingClientRect();
        t.style.transition = `transform .55s cubic-bezier(.2,.9,.25,1.15) ${i * 70}ms, opacity .35s ease ${i * 70}ms`;
        t.style.transform = '';
        t.style.opacity = '';
      } else {
        t.getBoundingClientRect();
        t.style.transition = `transform .35s cubic-bezier(.5,0,.75,0) ${i * 40}ms, opacity .3s ease ${i * 40}ms`;
        t.style.transform = away;
        t.style.opacity = '0';
      }
    });
    setTimeout(done, dir === 'in' ? 850 : 520);
  });
}

function showHub() {
  renderHub();
  const box = hubEl();
  box.hidden = false;
  requestAnimationFrame(() => hubFly('in'));
}

async function hideHub() {
  const box = $('focus-hub');
  if (!box || box.hidden) return;
  if (S.view === 'home') await hubFly('out');
  box.hidden = true;
}

// Перетаскивание: блок едет за курсором, соседи плавно меняются местами.
function hubDown(e, tile) {
  if (e.button !== 0) return;
  HUB.drag = { tile, x: e.clientX, y: e.clientY, moved: false };
  tile.setPointerCapture(e.pointerId);
  tile.onpointermove = (ev) => hubMove(ev);
  tile.onpointerup = (ev) => hubUp(ev);
}

function hubMove(e) {
  const d = HUB.drag;
  if (!d) return;
  const dx = e.clientX - d.x;
  const dy = e.clientY - d.y;
  if (!d.moved && Math.hypot(dx, dy) < 6) return;
  if (!d.moved) {
    d.moved = true;
    d.tile.classList.add('is-drag');
  }
  d.tile.style.transition = 'none';
  d.tile.style.transform = `translate(${dx}px, ${dy}px) scale(1.04)`;
  // Над чьим местом курсор: с тем и меняемся.
  const box = hubEl();
  const others = [...box.querySelectorAll('.hub-tile')].filter((t) => t !== d.tile);
  const over = others.find((t) => {
    const b = t.getBoundingClientRect();
    return e.clientX > b.left && e.clientX < b.right && e.clientY > b.top && e.clientY < b.bottom;
  });
  if (!over) return;
  const tiles = [...box.querySelectorAll('.hub-tile')];
  const before = new Map(tiles.map((t) => [t, t.getBoundingClientRect()]));
  const a = tiles.indexOf(d.tile);
  const b = tiles.indexOf(over);
  const mark = document.createComment('');
  box.replaceChild(mark, d.tile);
  box.replaceChild(d.tile, over);
  box.replaceChild(over, mark);
  void a;
  void b;
  // FLIP: сосед из старого места плавно едет в новое.
  const o = before.get(over);
  const n = over.getBoundingClientRect();
  over.style.transition = 'none';
  over.style.transform = `translate(${o.left - n.left}px, ${o.top - n.top}px)`;
  over.getBoundingClientRect();
  over.style.transition = 'transform .3s cubic-bezier(.2,.8,.2,1)';
  over.style.transform = '';
  // Перетаскиваемый остаётся под курсором: пересчитываем точку отсчёта.
  const old = before.get(d.tile);
  const now = d.tile.getBoundingClientRect();
  d.x += now.left - old.left;
  d.y += now.top - old.top;
  d.tile.style.transform = `translate(${e.clientX - d.x}px, ${e.clientY - d.y}px) scale(1.04)`;
}

function hubUp(e) {
  const d = HUB.drag;
  HUB.drag = null;
  if (!d) return;
  d.tile.onpointermove = d.tile.onpointerup = null;
  try {
    d.tile.releasePointerCapture(e.pointerId);
  } catch {
    /* уже отпущен */
  }
  if (!d.moved) {
    const it = HUB.items.find((x) => x.id === d.tile.dataset.id);
    if (it) it.go();
    return;
  }
  d.tile.classList.remove('is-drag');
  d.tile.style.transition = 'transform .3s cubic-bezier(.2,.8,.2,1)';
  d.tile.style.transform = '';
  const order = [...hubEl().querySelectorAll('.hub-tile')].map((t) => t.dataset.id);
  if (LOOK.s) LOOK.s.focusOrder = order;
  call(studio.settings.set({ focusOrder: order })).catch(() => {});
}

// В фокусе вне главной слева остаётся одна кнопка "Главная" (назад к блокам), с подсветкой.
function drawHubBack() {
  document.documentElement.classList.toggle('focus-away', FO.on && S.view !== 'home');
}

// Кнопка "Фокус" у ленты команды.
function focusEntry() {
  return h('button', { class: 'feed-focus js-focus', type: 'button', title: 'Режим фокуса: вместо графа четыре блока, таймер работы и перерыва', text: 'Фокус', onclick: (e) => toggleFocusPanel(e.currentTarget) });
}

// ---------- перерыв: затемнение и часы ----------
//
// Пока идёт перерыв, окно затемняется, по центру циферблат: кольцо убывает вместе
// с оставшимся временем, стрелка идёт по кругу. Кнопки: пропустить перерыв или закончить фокус.

const REST = { el: null, ring: null, hand: null, time: null, len: 0 };

function restEl() {
  if (REST.el) return REST.el;
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 300 300');
  svg.setAttribute('class', 'rest-clock');
  const add = (tag, attrs) => {
    const el = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    svg.append(el);
    return el;
  };
  add('circle', { cx: 150, cy: 150, r: 138, class: 'rc-face' });
  // 60 делений, каждое пятое длиннее
  for (let i = 0; i < 60; i++) {
    const a = (i / 60) * Math.PI * 2;
    const long = i % 5 === 0;
    const r1 = long ? 116 : 122;
    add('line', { x1: 150 + Math.sin(a) * r1, y1: 150 - Math.cos(a) * r1, x2: 150 + Math.sin(a) * 128, y2: 150 - Math.cos(a) * 128, class: long ? 'rc-tick long' : 'rc-tick' });
  }
  add('circle', { cx: 150, cy: 150, r: 104, class: 'rc-track' });
  REST.len = 2 * Math.PI * 104;
  REST.ring = add('circle', { cx: 150, cy: 150, r: 104, class: 'rc-ring', 'stroke-dasharray': REST.len.toFixed(1), transform: 'rotate(-90 150 150)' });
  REST.hand = add('line', { x1: 150, y1: 150, x2: 150, y2: 40, class: 'rc-hand' });
  add('circle', { cx: 150, cy: 150, r: 5, class: 'rc-pin' });
  REST.time = h('div', { class: 'rest-time' });
  const box = h('div', { class: 'rest-box' },
    h('div', { class: 'rest-dial' }, svg, h('div', { class: 'rest-center' }, h('div', { class: 'rest-label', text: 'Перерыв' }), REST.time)),
    h('p', { class: 'rest-hint', text: 'Встань, разомнись, посмотри вдаль.' }),
    h('div', { class: 'row gap-s rest-actions' },
      h('button', { class: 'btn', type: 'button', text: 'Пропустить перерыв', onclick: () => { FO.end = Date.now(); focusTick(); } }),
      h('button', { class: 'btn btn-accent', type: 'button', text: 'Закончить фокус', onclick: stopFocus })));
  REST.el = h('div', { class: 'rest', hidden: true }, box);
  document.body.append(REST.el);
  return REST.el;
}

function drawRest() {
  const on = FO.on && FO.work && FO.phase === 'rest';
  const el = restEl();
  if (!on) {
    if (!el.hidden && !el.classList.contains('is-out')) {
      el.classList.add('is-out');
      setTimeout(() => {
        el.hidden = true;
        el.classList.remove('is-out');
      }, 400);
    }
    return;
  }
  if (el.hidden) {
    el.hidden = false;
    $('focus-pop').hidden = true;
  }
  const total = FO.rest * 60000;
  const left = focusLeft();
  const k = total ? Math.max(0, Math.min(1, left / total)) : 0;
  REST.ring.setAttribute('stroke-dashoffset', (REST.len * (1 - k)).toFixed(1));
  // Стрелка как секундная: полный круг за минуту.
  const sec = Math.ceil(left / 1000) % 60;
  REST.hand.setAttribute('transform', 'rotate(' + ((60 - sec) % 60) * 6 + ' 150 150)');
  REST.time.textContent = fmtLeft(left);
}
