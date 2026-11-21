'use strict';
// Режим фокуса: прячет левую панель, ленту и список чатов, оставляет текущую работу и
// музыку. Таймер работы и перерыва (25/5, 50/10, 90/15) или без таймера. По желанию
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

function drawFocusButton() {
  const b = $('tb-focus');
  if (!b) return;
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
  studio.win.dnd(dnd).catch(() => {});
  clearInterval(FO.tick);
  FO.tick = setInterval(focusTick, 1000);
  drawFocusButton();
  if (typeof renderFeed === 'function' && S.view === 'home') renderFeed();
  toast(work ? 'Фокус на ' + work + ' минут' + (dnd ? ', уведомления выключены' : '') : 'Фокус без таймера' + (dnd ? ', уведомления выключены' : ''));
}

function stopFocus() {
  FO.on = false;
  clearInterval(FO.tick);
  document.documentElement.classList.remove('focus-mode');
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
}

function toggleFocusPanel() {
  const pop = $('focus-pop');
  if (!pop.hidden) {
    pop.hidden = true;
    return;
  }
  pop.hidden = false;
  const r = $('tb-focus').getBoundingClientRect();
  pop.style.left = Math.max(8, Math.min(window.innerWidth - 340, r.left)) + 'px';
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
    h('p', { class: 'small', text: 'Спрячу левую панель, ленту и список чатов. Музыка продолжит играть.' }),
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
  if (pop && !pop.hidden && !pop.contains(e.target) && e.target !== $('tb-focus')) pop.hidden = true;
});
