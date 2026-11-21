'use strict';
// Экран "Сегодня": открывается при первом входе за день поверх главной. Приветствие,
// кто в сети, напоминания на сегодня, непрочитанное в чатах и темах, отчёты, баллы
// команды за 7 дней и быстрый запуск музыки. Закрывается кнопкой "К работе", Esc или
// щелчком мимо. Открыть снова: кнопка "Сегодня" в полосе заголовка. Выключается в
// настройках ("Оформление").

const TD = { open: false };

const localDay = (d = new Date()) => d.toLocaleDateString('sv-SE');

function greeting(d = new Date()) {
  const hr = d.getHours();
  if (hr >= 5 && hr < 12) return 'Доброе утро';
  if (hr >= 12 && hr < 18) return 'Добрый день';
  if (hr >= 18 && hr < 23) return 'Добрый вечер';
  return 'Доброй ночи';
}

// После входа: ждём, пока придут комнаты чата и ветки, потом показываем (раз в день).
async function maybeShowToday() {
  const s = LOOK.s || {};
  if (s.todayScreen === false || s.todayShown === localDay()) return;
  for (let i = 0; i < 30 && !(S.me && S.rooms.size); i++) await new Promise((r) => setTimeout(r, 100));
  if (!S.me || $('app').hidden || !$('rules-gate').hidden) return;
  await showToday();
  try {
    LOOK.s = await call(studio.settings.set({ todayShown: localDay() }));
  } catch {
    /* не страшно: покажется ещё раз */
  }
}

function closeToday() {
  TD.open = false;
  $('today').hidden = true;
  document.removeEventListener('keydown', todayKey);
}

function todayKey(e) {
  if (e.key === 'Escape' && $('modal').hidden) closeToday();
}

// Небольшой блок экрана: заголовок и содержимое.
function tdBlock(title, ...kids) {
  return h('section', { class: 'td-block' }, h('h3', { text: title }), ...kids);
}

function tdLink(text, sub, onclick) {
  return h('button', { class: 'td-link', type: 'button', onclick }, h('span', { text }), sub ? h('b', { text: sub }) : null);
}

async function showToday() {
  const box = $('today');
  TD.open = true;
  box.hidden = false;
  document.addEventListener('keydown', todayKey);
  const now = new Date();
  const online = [...S.users.values()].filter((u) => u.online && u.id !== S.me.id);
  const date = now.toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' });

  const card = h('div', { class: 'td-card', role: 'dialog', 'aria-label': 'Сегодня' });
  card.append(
    h('header', { class: 'td-head' },
      h('div', {},
        h('div', { class: 'td-hello', text: greeting(now) + ', ' + S.me.name }),
        h('div', { class: 'td-date', text: date[0].toUpperCase() + date.slice(1) }),
      ),
      h('div', { class: 'td-online' },
        online.length ? h('span', { class: 'muted small', text: 'В сети:' }) : h('span', { class: 'muted small', text: 'Пока никого в сети' }),
        ...online.slice(0, 8).map((u) => h('span', { class: 'td-who', title: u.name }, avatar(u, 26))),
      ),
    ),
  );
  const grid = h('div', { class: 'td-grid' });
  card.append(grid, h('footer', { class: 'td-foot' },
    h('label', { class: 'check small' }, (() => {
      const c = h('input', { type: 'checkbox' });
      c.checked = true;
      c.addEventListener('change', async () => { LOOK.s = await call(studio.settings.set({ todayScreen: c.checked })); });
      return c;
    })(), h('span', { text: 'Показывать при первом входе за день' })),
    h('button', { class: 'btn btn-accent', type: 'button', text: 'К работе', onclick: closeToday }),
  ));
  box.innerHTML = '';
  box.append(card);
  box.onclick = (e) => {
    if (e.target === box) closeToday();
  };

  // Данные: что уже есть в памяти рисуем сразу, остальное по мере ответа сервера.
  const remBlock = tdBlock('На сегодня', skeleton('lines', 2));
  const unreadBlock = tdBlock('Непрочитанное');
  const repBlock = tdBlock('Отчёты', skeleton('lines', 2));
  const teamBlock = tdBlock('Команда за 7 дней', skeleton('lines', 3));
  grid.append(remBlock, unreadBlock, repBlock, teamBlock);

  // Непрочитанное: чаты и темы на главной.
  const unread = [];
  for (const r of S.rooms.values()) if (r.unread) unread.push(tdLink(roomTitle(r.id), String(r.unread), () => { closeToday(); setView('chat'); openRoom(r.id); }));
  if (typeof B !== 'undefined') {
    for (const c of B.cards.values()) if (c.unread) unread.push(tdLink('Тема: ' + c.title, String(c.unread), () => { closeToday(); setView('home'); openTopic(c.id); }));
  }
  unreadBlock.append(...(unread.length ? unread.slice(0, 6) : [h('p', { class: 'muted small', text: 'Всё прочитано.' })]));

  // Музыка: быстрый запуск, если молчит.
  if (typeof PL !== 'undefined' && !PL.playing) {
    card.querySelector('.td-foot').prepend(h('button', { class: 'btn', type: 'button', text: 'Включить музыку', onclick: (e) => { playMusic(); e.target.remove(); } }));
  }

  const jobs = [];
  if (typeof loadReminders === 'function') jobs.push(loadReminders().then(() => drawTodayReminders(remBlock), () => fillBlock(remBlock, 'Не загрузилось.')));
  if (typeof loadReports === 'function') {
    const founder = S.me.founder;
    jobs.push((founder ? Promise.all([loadReports(), loadQueue()]) : loadReports()).then(() => drawTodayReports(repBlock), () => fillBlock(repBlock, 'Не загрузилось.')));
  }
  jobs.push(call(studio.team.stats()).then((st) => drawTodayTeam(teamBlock, st), () => fillBlock(teamBlock, 'Не загрузилось.')));
  await Promise.all(jobs);
}

function fillBlock(block, text) {
  block.querySelectorAll(':scope > :not(h3)').forEach((x) => x.remove());
  if (text) block.append(h('p', { class: 'muted small', text }));
}

function drawTodayReminders(block) {
  fillBlock(block);
  const due = CB.reminders.filter((r) => r.day <= CB.today);
  const next = CB.reminders.find((r) => r.day > CB.today);
  for (const r of due) {
    const row = h('div', { class: 'td-rem' },
      h('span', { text: r.note }),
      h('button', { class: 'btn btn-s', type: 'button', text: 'Сделано', onclick: async () => {
        await reminderDone(r);
        drawTodayReminders(block);
      } }),
    );
    block.append(row);
  }
  if (!due.length) block.append(h('p', { class: 'muted small', text: 'Напоминаний на сегодня нет.' + (next ? ' Следующее: ' + dayShort(next.day) + ', ' + next.note + '.' : '') }));
  block.append(h('button', { class: 'td-more', type: 'button', text: 'Поставить напоминание', onclick: () => addReminder().then(() => drawTodayReminders(block)) }));
}

function drawTodayReports(block) {
  fillBlock(block);
  const go = (tab) => () => {
    closeToday();
    CB.tab = tab;
    setView('contrib');
  };
  if (S.me.founder) {
    block.append(CB.queueSent
      ? tdLink('Ждут проверки', String(CB.queueSent), go('review'))
      : h('p', { class: 'muted small', text: 'Новых отчётов на проверке нет.' }));
    return;
  }
  const rejected = CB.reports.filter((r) => r.status === 'rejected').length;
  const sent = CB.reports.filter((r) => r.status === 'sent').length;
  if (rejected) block.append(tdLink('Отклонены, нужно исправить', String(rejected), go('mine')));
  if (sent) block.append(tdLink('На проверке', String(sent), go('mine')));
  if (!rejected && !sent) block.append(h('p', { class: 'muted small', text: 'Всё проверено.' }));
  block.append(h('button', { class: 'td-more', type: 'button', text: 'Новый отчёт', onclick: () => { closeToday(); CB.tab = 'mine'; setView('contrib'); setTimeout(() => startDraft(), 300); } }));
}

// Баллы команды по дням за последние 7 дней: маленькие столбики, сегодня справа.
function drawTodayTeam(block, st) {
  fillBlock(block);
  const days = Array.from({ length: 7 }, (_, i) => shiftDay(st.today, i - 6));
  const team = new Map(days.map((d) => [d, 0]));
  let mine = 0;
  for (const p of st.points) {
    if (!team.has(p.day)) continue;
    team.set(p.day, team.get(p.day) + p.points);
    if (p.user === S.me.id) mine += p.points;
  }
  const total = [...team.values()].reduce((a, b) => a + b, 0);
  const max = Math.max(1, ...team.values());
  const W = 220;
  const H = 54;
  const bw = 22;
  const gap = (W - bw * 7) / 6;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', W);
  svg.setAttribute('height', H + 14);
  svg.setAttribute('class', 'td-bars');
  days.forEach((d, i) => {
    const v = team.get(d);
    const hgt = v ? Math.max(3, (v / max) * H) : 2;
    const r = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    r.setAttribute('x', i * (bw + gap));
    r.setAttribute('y', H - hgt);
    r.setAttribute('width', bw);
    r.setAttribute('height', hgt);
    r.setAttribute('rx', 3);
    r.setAttribute('class', v ? 'on' : 'off');
    const tt = document.createElementNS('http://www.w3.org/2000/svg', 'title');
    tt.textContent = dayShort(d) + ': ' + pts(v);
    r.append(tt);
    svg.append(r);
    const lab = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    lab.setAttribute('x', i * (bw + gap) + bw / 2);
    lab.setAttribute('y', H + 12);
    lab.setAttribute('text-anchor', 'middle');
    lab.textContent = new Date(d + 'T12:00:00').toLocaleDateString('ru-RU', { weekday: 'short' });
    svg.append(lab);
  });
  block.append(
    h('div', { class: 'td-nums' },
      h('div', {}, h('b', { text: pts(total) }), h('span', { class: 'muted small', text: 'баллов у команды' })),
      st.mine ? h('div', {}, h('b', { text: pts(mine) }), h('span', { class: 'muted small', text: 'ваших' })) : null,
    ),
    svg,
    h('button', { class: 'td-more', type: 'button', text: 'Подробнее во "Вкладе"', onclick: () => { closeToday(); CB.tab = 'team'; if (typeof TM !== 'undefined') TM.data = null; setView('contrib'); } }),
  );
}
