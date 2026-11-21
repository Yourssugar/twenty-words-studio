'use strict';
// Раздел "Вклад": вкладки "Команда" (team.js), "Мои отчёты", "Ссылки", у основателя
// ещё "Проверка" и "Учёт" (acct.js).
//
// Отчёт: один пост с вложениями. Вложение это скриншот, подпись и числа: либо одна
// публикация (просмотры за первые 7 дней), либо общая аналитика площадки за период
// (например, за неделю) с тем, сколько за период вышло роликов и постов.
// Скриншот пережимается здесь же в webp (до 1600 точек по длинной стороне) и
// уходит на сервер отдельно, перед отправкой отчёта. Его видят владелец и основатели.
//
// Напоминания человек ставит себе сам ("через неделю"), они лежат на сервере и
// всплывают при входе и раз в полчаса.

const CB = {
  tab: 'team', // team | mine | links | review | acct
  reports: [],
  platforms: [],
  today: '',
  loaded: false,
  queue: [],
  queueSent: 0,
  filter: { status: 'sent', user: 0 },
  images: new Map(), // id скриншота -> data:URL
  reminders: [],
  shown: new Set(), // напоминания, уже показанные сегодня (id:день)
  draft: null, // отчёт в работе: { id?, note, items, remind, every }
  refs: null,
  refsAdmin: null,
  refsMonth: '',
  timer: 0,
};

Object.assign(ERRORS, {
  bad_day: 'Проверьте даты: не позже сегодняшнего дня, период не длиннее двух месяцев.',
  too_early: 'Публикацию можно отправить с 7-го дня после выхода: считаются просмотры за первые 7 дней.',
  bad_image: 'Не получилось прочитать картинку. Нужен скриншот в png, jpg или webp.',
  bad_shot: 'Скриншот не загрузился. Добавьте его заново.',
  overlap: 'Эти даты по этой площадке уже есть в другом вложении или отчёте: одни просмотры посчитались бы дважды.',
  locked: 'Отчёт уже подтверждён, менять его нельзя.',
  note_required: 'Напишите, почему отклоняете: человек увидит это.',
  month_closed: 'Этот месяц уже закрыт в учёте.',
  slug_taken: 'Такой код цели уже есть.',
  has_hits: 'По этой цели уже были переходы. Её можно только выключить.',
});

const MONTHS = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
const monthTitle = (day) => {
  const [y, m] = day.split('-').map(Number);
  const name = MONTHS[m - 1];
  return name[0].toUpperCase() + name.slice(1) + ' ' + y;
};
const dayShort = (day) => {
  const d = new Date(day + 'T12:00:00');
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
};
const fmtNum = (n) => Number(n || 0).toLocaleString('ru-RU');
const FORMATS = [['long', 'Длинный ролик'], ['short', 'Шортс'], ['post', 'Пост']];
const formatLabel = (f) => (FORMATS.find(([v]) => v === f) || ['', ''])[1];
const shiftDay = (day, n) => {
  const d = new Date(day + 'T12:00:00');
  d.setDate(d.getDate() + n);
  return d.toLocaleDateString('sv-SE');
};
const daysBetween = (a, b) => Math.round((new Date(b + 'T12:00:00') - new Date(a + 'T12:00:00')) / 86400000);

function itemTitle(it) {
  if (it.kind === 'period') {
    const made = [[it.long, 'длинн.'], [it.short, 'шортс'], [it.post, 'пост.']].filter(([n]) => n).map(([n, t]) => n + ' ' + t).join(', ');
    return 'Аналитика за ' + dayShort(it.from) + ' - ' + dayShort(it.day) + (made ? ' (' + made + ')' : '');
  }
  return formatLabel(it.format) + ', вышел ' + dayShort(it.day);
}

// ---------- данные ----------

async function loadReports() {
  const r = await call(studio.reports.list());
  CB.reports = r.reports;
  CB.platforms = r.platforms;
  CB.today = r.today;
  CB.loaded = true;
  updateContribBadge();
}

async function loadQueue() {
  const r = await call(studio.reports.queue(CB.filter));
  CB.queue = r.reports;
  CB.queueSent = r.sent;
  updateContribBadge();
}

async function loadReminders() {
  const r = await call(studio.reminders.list());
  CB.reminders = r.reminders;
  CB.today = r.today;
  updateContribBadge();
}

const dueReminders = () => CB.reminders.filter((r) => r.day <= CB.today);
const rejectedReports = () => CB.reports.filter((r) => r.status === 'rejected');

// Значок на кнопке: наступившие напоминания, отклонённые отчёты, у основателя очередь.
function updateContribBadge() {
  const n = dueReminders().length + rejectedReports().length + (S.me && S.me.founder ? CB.queueSent : 0);
  const b = $('badge-contrib');
  b.hidden = !n;
  b.textContent = n > 99 ? '99+' : n;
}

// При входе и раз в полчаса: показать наступившие напоминания (каждое раз в день).
async function contribRemind() {
  try {
    await Promise.all([loadReports(), loadReminders()]);
    if (S.me && S.me.founder) await loadQueue();
  } catch {
    return;
  }
  const fresh = dueReminders().filter((r) => !CB.shown.has(r.id + ':' + CB.today));
  for (const r of fresh) CB.shown.add(r.id + ':' + CB.today);
  if (fresh.length) {
    const text = fresh.map((r) => r.note).join('; ');
    toast('Напоминание: ' + text + '. Раздел "Вклад".');
    studio.app.notify('Напоминание', text).catch(() => {});
  }
  if (S.view === 'contrib' && CB.tab === 'mine') renderContrib();
  clearTimeout(CB.timer);
  CB.timer = setTimeout(contribRemind, 30 * 60 * 1000);
}

function plural(n, one, few, many) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

// ---------- раздел ----------

async function openContrib() {
  try {
    await Promise.all([loadReports(), loadReminders()]);
    if (S.me && S.me.founder) await loadQueue();
    if (CB.tab === 'acct' && typeof loadAcct === 'function') await loadAcct();
    if (CB.tab === 'team' && typeof loadTeam === 'function') await loadTeam();
    if (CB.tab === 'links') await loadLinks();
  } catch (err) {
    toast(errText(err.code));
  }
  renderContrib();
}

async function loadLinks() {
  if (S.me && S.me.founder) CB.refsAdmin = await call(studio.refs.admin(CB.refsMonth));
  else CB.refs = { ...(await call(studio.refs.mine(CB.refsMonth))), base: await call(studio.refs.base()) };
}

function renderContrib() {
  const founder = !!(S.me && S.me.founder);
  if (!founder && (CB.tab === 'review' || CB.tab === 'acct')) CB.tab = 'team';
  const tabs = $('contrib-tabs');
  tabs.innerHTML = '';
  const tab = (id, text) => h('button', {
    class: 'seg-btn' + (CB.tab === id ? ' is-on' : ''), type: 'button', text,
    onclick: async () => {
      if (id === 'team' && typeof TM !== 'undefined') TM.data = null;
      CB.tab = id;
      if (id === 'links') {
        try {
          await loadLinks();
        } catch (err) {
          toast(errText(err.code));
        }
      }
      renderContrib();
    },
  });
  const mineN = dueReminders().length + rejectedReports().length;
  tabs.append(tab('team', 'Команда'), tab('mine', 'Мои отчёты' + (mineN ? ' (' + mineN + ')' : '')), tab('links', 'Ссылки'));
  if (founder) tabs.append(tab('review', 'Проверка' + (CB.queueSent ? ' (' + CB.queueSent + ')' : '')), tab('acct', 'Учёт'));
  tabs.style.gridTemplateColumns = 'repeat(' + tabs.children.length + ', auto)';
  tabs.hidden = false;
  const box = $('contrib-body');
  box.innerHTML = '';
  if (CB.tab === 'review') renderReview(box);
  else if (CB.tab === 'acct' && typeof renderAcct === 'function') renderAcct(box);
  else if (CB.tab === 'team' && typeof renderTeam === 'function') renderTeam(box);
  else if (CB.tab === 'links') renderLinks(box);
  else renderMine(box);
}

// ---------- мои отчёты ----------

function renderMine(box) {
  if (CB.draft) {
    box.append(renderDraft());
    return;
  }
  box.append(h('div', { class: 'card' },
    h('div', { class: 'row between wrap gap-s' },
      h('div', {},
        h('h2', { text: 'Мои отчёты' }),
        h('p', { class: 'muted small', text: 'Отчёт это пост со скриншотами. В одно вложение можно положить одну публикацию (просмотры за первые 7 дней) или общую аналитику площадки за период, например за неделю. Ссылки на ролики не нужны.' }),
      ),
      h('button', { class: 'btn btn-accent', type: 'button', text: 'Новый отчёт', onclick: () => startDraft() }),
    ),
  ));
  box.append(renderReminders());
  if (!CB.reports.length) {
    box.append(h('div', { class: 'card muted', text: 'Отчётов пока нет.' }));
    return;
  }
  for (const r of CB.reports) box.append(reportCard(r, false));
}

function statusChip(r) {
  if (r.status === 'ok') return h('span', { class: 'st-chip is-ok', text: 'подтверждён' });
  if (r.status === 'rejected') return h('span', { class: 'st-chip is-bad', text: 'отклонён' });
  return h('span', { class: 'st-chip', text: 'на проверке' });
}

function thumb(id) {
  const el = h('div', { class: 'thumb', title: 'Открыть скриншот', onclick: () => showShot(id) }, h('span', { class: 'muted small', text: '...' }));
  shotImage(id).then((url) => {
    el.innerHTML = '';
    el.append(h('img', { src: url, alt: 'скриншот' }));
  }, () => {
    el.innerHTML = '';
    el.append(h('span', { class: 'muted small', text: 'нет' }));
  });
  return el;
}

function reportCard(r, forFounder) {
  const created = new Date(r.created).toLocaleDateString('sv-SE');
  const actions = h('div', { class: 'row gap-s' });
  if (!forFounder && r.status !== 'ok') {
    actions.append(
      h('button', { class: 'btn btn-s' + (r.status === 'rejected' ? ' btn-accent' : ''), type: 'button', text: r.status === 'rejected' ? 'Исправить' : 'Изменить', onclick: () => startDraft(r) }),
      h('button', { class: 'btn btn-s btn-danger-ghost', type: 'button', text: 'Удалить', onclick: () => deleteReport(r) }),
    );
  }
  const rows = r.items.map((it) => h('div', { class: 'item-row' },
    thumb(it.shot),
    h('div', { class: 'grow' },
      h('div', {}, h('b', { text: it.platform }), h('span', { class: 'muted', text: ' · ' + itemTitle(it) })),
      it.label ? h('div', { class: 'small', text: it.label }) : null,
      h('div', { class: 'small ' + (r.status === 'ok' ? 'ok' : 'muted'), text: r.status === 'ok'
        ? 'подтверждено ' + fmtNum(it.okViews) + ' просм.' + (it.okViews !== it.views ? ' (вы писали ' + fmtNum(it.views) + ')' : '')
          + (it.kind === 'period' && (it.okLong !== it.long || it.okShort !== it.short || it.okPost !== it.post) ? ', публикаций засчитано: ' + it.okLong + ' длинн., ' + it.okShort + ' шортс, ' + it.okPost + ' пост.' : '')
        : fmtNum(it.views) + ' просм.' }),
    ),
  ));
  return h('div', { class: 'card report-card' + (r.status === 'rejected' ? ' is-bad' : '') },
    h('div', { class: 'row between wrap gap-s' },
      h('div', { class: 'row gap-s' }, forFounder ? h('b', { text: (S.users.get(r.user) || { name: '#' + r.user }).name }) : null, h('span', { class: 'muted', text: dayShort(created) }), statusChip(r)),
      actions,
    ),
    r.note ? h('p', { class: 'small', text: r.note }) : null,
    r.status === 'rejected' ? h('p', { class: 'contrib-bad small', text: 'Причина: ' + r.reviewNote }) : null,
    r.status === 'ok' && r.reviewNote ? h('p', { class: 'muted small', text: 'Комментарий: ' + r.reviewNote }) : null,
    ...rows,
  );
}

async function deleteReport(r) {
  if (!(await modal({ title: 'Удалить отчёт?', body: 'Вложений: ' + r.items.length + '. Скриншоты тоже удалятся.', ok: 'Удалить', danger: true }))) return;
  try {
    await call(studio.reports.remove(r.id));
    await loadReports();
    renderContrib();
  } catch (err) {
    toast(errText(err.code));
  }
}

// ---------- напоминания ----------

function renderReminders() {
  const card = h('div', { class: 'card' },
    h('div', { class: 'row between wrap gap-s' },
      h('h2', { text: 'Напоминания' }),
      h('button', { class: 'btn btn-s', type: 'button', text: 'Напомнить...', onclick: () => addReminder() }),
    ),
  );
  if (!CB.reminders.length) {
    card.append(h('p', { class: 'muted small', text: 'Поставьте себе напоминание, например через неделю загрузить отчёт. Оно всплывёт в приложении в этот день.' }));
    return card;
  }
  for (const r of CB.reminders) {
    const due = r.day <= CB.today;
    card.append(h('div', { class: 'item-row' + (due ? ' is-due' : '') },
      h('div', { class: 'rem-day', text: due ? (r.day === CB.today ? 'сегодня' : 'с ' + dayShort(r.day)) : dayShort(r.day) }),
      h('div', { class: 'grow' }, h('span', { text: r.note }), r.every ? h('span', { class: 'muted small', text: ', каждые ' + r.every + ' ' + plural(r.every, 'день', 'дня', 'дней') }) : null),
      due ? h('button', { class: 'btn btn-s btn-accent', type: 'button', text: r.every ? 'Сделано, дальше' : 'Сделано', onclick: () => reminderDone(r) }) : null,
      h('button', { class: 'btn btn-s btn-danger-ghost', type: 'button', text: 'Убрать', onclick: () => reminderDelete(r) }),
    ));
  }
  return card;
}

// Выбор "когда": через 2 дня, неделю, две недели или своя дата.
function whenPicker(initial) {
  let pick = initial || 7;
  const date = h('input', { type: 'date', min: CB.today, value: shiftDay(CB.today, 7) });
  const seg = h('div', { class: 'seg seg-wrap' });
  const draw = () => {
    seg.innerHTML = '';
    for (const [v, t] of [[2, 'через 2 дня'], [7, 'через неделю'], [14, 'через 2 недели'], ['date', 'дата']]) {
      seg.append(h('button', { class: 'seg-btn' + (pick === v ? ' is-on' : ''), type: 'button', text: t, onclick: () => { pick = v; draw(); } }));
    }
    date.hidden = pick !== 'date';
  };
  draw();
  return { el: h('div', { class: 'stack-s' }, seg, date), day: () => (pick === 'date' ? date.value : shiftDay(CB.today, pick)), every: () => (pick === 'date' ? 7 : pick) };
}

async function addReminder() {
  const when = whenPicker(7);
  const note = h('input', { maxlength: '120', placeholder: 'Загрузить отчёт', value: '' });
  const repeat = h('input', { type: 'checkbox' });
  const body = h('div', {},
    h('label', { class: 'field' }, h('span', { text: 'Когда' }), when.el),
    h('label', { class: 'field' }, h('span', { text: 'О чём' }), note),
    h('label', { class: 'check' }, repeat, h('span', { text: 'Повторять с тем же шагом (для даты: каждую неделю)' })),
  );
  if (!(await modal({ title: 'Напоминание', body, ok: 'Поставить' }))) return;
  try {
    await call(studio.reminders.add({ day: when.day(), note: note.value, every: repeat.checked ? when.every() : 0 }));
    await loadReminders();
    renderContrib();
  } catch (err) {
    toast(errText(err.code));
  }
}

async function reminderDone(r) {
  try {
    await call(studio.reminders.done(r.id));
    await loadReminders();
    renderContrib();
  } catch (err) {
    toast(errText(err.code));
  }
}

async function reminderDelete(r) {
  try {
    await call(studio.reminders.remove(r.id));
    await loadReminders();
    renderContrib();
  } catch (err) {
    toast(errText(err.code));
  }
}

// ---------- новый отчёт и правка ----------

function newItem(kind) {
  return {
    kind: kind || 'period',
    platform: 'YouTube',
    format: 'short',
    from: shiftDay(CB.today, -7),
    day: kind === 'pub' ? shiftDay(CB.today, -7) : shiftDay(CB.today, -1),
    long: 0, short: 0, post: 0,
    views: '',
    label: '',
    shot: 0, // id на сервере, когда загружен
    img: '', // картинка для показа
    b64: '', // ещё не загруженная картинка
  };
}

function startDraft(r) {
  CB.draft = r
    ? { id: r.id, note: r.note || '', items: r.items.map((it) => ({ ...it, views: String(it.views), img: '', b64: '' })), remind: 0, every: false, bad: -1 }
    : { note: '', items: [newItem('period')], remind: 0, every: false, bad: -1 };
  CB.tab = 'mine';
  renderContrib();
}

function platformField(it, onChange) {
  const known = ['YouTube', ...CB.platforms];
  const sel = h('select', {},
    ...known.map((x) => h('option', { value: x, text: x })),
    h('option', { value: '__new', text: 'Другая площадка...' }),
  );
  const own = h('input', { maxlength: '30', placeholder: 'Например: TikTok, Telegram, Instagram' });
  if (known.includes(it.platform)) sel.value = it.platform;
  else {
    sel.value = '__new';
    own.value = it.platform;
  }
  const sync = () => {
    own.hidden = sel.value !== '__new';
    it.platform = sel.value === '__new' ? own.value : sel.value;
    onChange && onChange();
  };
  sel.addEventListener('change', sync);
  own.addEventListener('input', sync);
  sync();
  return h('label', { class: 'field' }, h('span', { text: 'Площадка' }), h('div', { class: 'stack-s' }, sel, own));
}

function numInputFor(it, key, ph) {
  const el = h('input', { type: 'number', min: '0', step: '1', placeholder: ph || '0', value: it[key] === '' || it[key] === 0 ? '' : String(it[key]) });
  el.addEventListener('input', () => { it[key] = key === 'views' ? el.value : Math.max(0, Math.round(Number(el.value) || 0)); });
  return el;
}

function dateInputFor(it, key, max) {
  const el = h('input', { type: 'date', max, value: it[key] });
  el.addEventListener('change', () => { it[key] = el.value; });
  return el;
}

// Последний блок, куда попадёт картинка из Ctrl+V.
let pasteTarget = null;
document.addEventListener('paste', (e) => {
  if (!pasteTarget || !pasteTarget.isConnected) return;
  const item = [...(e.clipboardData ? e.clipboardData.items : [])].find((i) => i.type.startsWith('image/'));
  if (item) {
    e.preventDefault();
    pasteTarget.take(item.getAsFile());
  }
});

function shotZone(it) {
  const zone = h('div', { class: 'shot-drop', tabindex: '0' });
  const file = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif,image/bmp', hidden: true });
  const draw = () => {
    zone.innerHTML = '';
    if (it.img) zone.append(h('img', { src: it.img, alt: 'скриншот' }), h('span', { class: 'muted small', text: 'Нажмите, чтобы заменить' }));
    else zone.append(h('span', { class: 'muted', text: 'Скриншот: перетащите сюда, вставьте Ctrl+V или нажмите, чтобы выбрать файл' }));
  };
  zone.take = async (blob) => {
    if (!blob || !blob.type.startsWith('image/')) {
      toast(errText('bad_image'));
      return;
    }
    try {
      const p = await toWebP(blob);
      it.img = p.url;
      it.b64 = p.b64;
      it.shot = 0;
      draw();
    } catch {
      toast(errText('bad_image'));
    }
  };
  if (it.shot && !it.img) {
    shotImage(it.shot).then((url) => { it.img = url; draw(); }, () => {});
  }
  file.addEventListener('change', () => zone.take(file.files[0]));
  zone.addEventListener('click', () => { pasteTarget = zone; file.click(); });
  zone.addEventListener('focus', () => { pasteTarget = zone; });
  zone.addEventListener('mouseenter', () => { pasteTarget = zone; });
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('is-over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('is-over'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('is-over');
    zone.take(e.dataTransfer.files[0]);
  });
  draw();
  pasteTarget = zone;
  return h('div', {}, zone, file);
}

function itemEditor(d, it, i) {
  const redraw = () => renderContrib();
  const kindSeg = h('div', { class: 'seg' },
    ...[['period', 'Аналитика за период'], ['pub', 'Одна публикация']].map(([v, t]) => h('button', {
      class: 'seg-btn' + (it.kind === v ? ' is-on' : ''), type: 'button', text: t,
      onclick: () => {
        it.kind = v;
        if (v === 'pub' && it.day > shiftDay(CB.today, -7)) it.day = shiftDay(CB.today, -7);
        redraw();
      },
    })),
  );
  const fields = [];
  if (it.kind === 'pub') {
    const fmt = h('div', { class: 'seg' }, ...FORMATS.map(([v, t]) => h('button', {
      class: 'seg-btn' + (it.format === v ? ' is-on' : ''), type: 'button', text: v === 'long' ? 'Длинный, от 2 минут' : t,
      onclick: (e) => { it.format = v; [...e.target.parentNode.children].forEach((b) => b.classList.toggle('is-on', b === e.target)); },
    })));
    fields.push(
      h('label', { class: 'field' }, h('span', { text: 'Что вышло' }), fmt),
      h('label', { class: 'field' }, h('span', { text: 'Дата выхода (отчёт с 7-го дня)' }), dateInputFor(it, 'day', shiftDay(CB.today, -7))),
      h('label', { class: 'field' }, h('span', { text: 'Просмотры за первые 7 дней' }), numInputFor(it, 'views', 'например 4200')),
    );
  } else {
    const from = dateInputFor(it, 'from', CB.today);
    const to = dateInputFor(it, 'day', CB.today);
    const quick = (n) => h('button', { class: 'btn btn-s', type: 'button', text: n === 7 ? 'прошлые 7 дней' : 'прошлые 28 дней', onclick: () => {
      it.day = shiftDay(CB.today, -1);
      it.from = shiftDay(CB.today, -n);
      from.value = it.from;
      to.value = it.day;
    } });
    fields.push(
      h('div', { class: 'field' }, h('span', { text: 'Период' }), h('div', { class: 'row gap-s wrap' }, from, h('span', { class: 'muted', text: 'по' }), to, quick(7), quick(28))),
      h('label', { class: 'field' }, h('span', { text: 'Просмотры за период (всего по площадке)' }), numInputFor(it, 'views', 'например 52000')),
      h('div', { class: 'field' }, h('span', { text: 'Сколько вышло за период' }), h('div', { class: 'row gap-s wrap counts' },
        h('label', {}, h('span', { class: 'small muted', text: 'длинных' }), numInputFor(it, 'long')),
        h('label', {}, h('span', { class: 'small muted', text: 'шортс' }), numInputFor(it, 'short')),
        h('label', {}, h('span', { class: 'small muted', text: 'постов' }), numInputFor(it, 'post')),
      )),
    );
  }
  const label = h('input', { maxlength: '200', placeholder: it.kind === 'period' ? 'Например: аналитика канала за неделю, вкладка Обзор' : 'Например: шортс с нарезкой трека Ночь', value: it.label });
  label.addEventListener('input', () => { it.label = label.value; });
  return h('div', { class: 'item-editor' + (d.bad === i ? ' is-bad' : '') },
    h('div', { class: 'row between wrap gap-s' },
      h('b', { text: 'Вложение ' + (i + 1) }),
      d.items.length > 1 ? h('button', { class: 'btn btn-s btn-danger-ghost', type: 'button', text: 'Убрать', onclick: () => { d.items.splice(i, 1); d.bad = -1; redraw(); } }) : null,
    ),
    kindSeg,
    h('div', { class: 'item-grid' },
      h('div', {}, platformField(it), ...fields, h('label', { class: 'field' }, h('span', { text: 'Подпись: что на скриншоте' }), label)),
      shotZone(it),
    ),
  );
}

function renderDraft() {
  const d = CB.draft;
  const note = h('input', { maxlength: '300', placeholder: 'Необязательно: что за неделя, что вышло', value: d.note });
  note.addEventListener('input', () => { d.note = note.value; });
  const remindSel = h('select', {}, ...[[0, 'не надо'], [2, 'через 2 дня'], [7, 'через неделю'], [14, 'через 2 недели']].map(([v, t]) => h('option', { value: String(v), text: t })));
  remindSel.value = String(d.remind);
  remindSel.addEventListener('change', () => { d.remind = Number(remindSel.value); });
  const every = h('input', { type: 'checkbox' });
  every.checked = d.every;
  every.addEventListener('change', () => { d.every = every.checked; });
  const send = h('button', { class: 'btn btn-accent', type: 'button', text: d.id ? 'Сохранить и отправить' : 'Отправить на проверку', onclick: () => submitDraft(send) });
  return h('div', { class: 'card' },
    h('div', { class: 'row between wrap gap-s' }, h('h2', { text: d.id ? 'Отчёт: правка' : 'Новый отчёт' }), h('button', { class: 'btn btn-s', type: 'button', text: 'Отмена', onclick: () => { CB.draft = null; renderContrib(); } })),
    h('p', { class: 'muted small', text: 'YouTube считается по 1000 просмотров, остальные площадки по 1500. В аналитике за период потолок 50 000 просмотров на каждую вышедшую публикацию. Один и тот же период по одной площадке дважды не засчитывается.' }),
    ...d.items.map((it, i) => itemEditor(d, it, i)),
    d.items.length < 8 ? h('div', { class: 'row gap-s' },
      h('button', { class: 'btn', type: 'button', text: 'Добавить вложение', onclick: () => { const last = d.items[d.items.length - 1]; d.items.push(newItem(last ? last.kind : 'period')); renderContrib(); } }),
    ) : null,
    h('label', { class: 'field' }, h('span', { text: 'Комментарий к отчёту' }), note),
    h('div', { class: 'row gap-s wrap' },
      h('span', { class: 'muted small', text: 'Напомнить про следующий отчёт:' }), remindSel,
      h('label', { class: 'check' }, every, h('span', { class: 'small', text: 'и дальше с тем же шагом' })),
    ),
    h('div', { class: 'row gap-s end' }, send),
  );
}

async function submitDraft(btn) {
  const d = CB.draft;
  for (let i = 0; i < d.items.length; i++) {
    const it = d.items[i];
    const fail = (text) => {
      d.bad = i;
      renderContrib();
      toast('Вложение ' + (i + 1) + ': ' + text);
    };
    if (!it.shot && !it.b64) return fail('добавьте скриншот.');
    if (!it.platform.trim()) return fail('напишите площадку.');
    if (it.views === '' || Number(it.views) < 0) return fail('напишите число просмотров со скриншота.');
    if (!it.label.trim()) return fail('подпишите, что на скриншоте.');
  }
  btn.disabled = true;
  btn.textContent = 'Отправка...';
  try {
    // Сначала картинки, по одной: каждая не больше 3 МБ.
    for (const it of d.items) {
      if (!it.shot && it.b64) {
        const r = await call(studio.reports.upload(it.b64));
        it.shot = r.id;
        CB.images.set(r.id, it.img);
        it.b64 = '';
      }
    }
    const body = {
      note: d.note,
      items: d.items.map((it) => ({
        kind: it.kind, platform: it.platform.trim(), format: it.kind === 'pub' ? it.format : '',
        from: it.kind === 'period' ? it.from : '', day: it.day,
        long: it.kind === 'period' ? Number(it.long) || 0 : 0, short: it.kind === 'period' ? Number(it.short) || 0 : 0, post: it.kind === 'period' ? Number(it.post) || 0 : 0,
        views: Math.round(Number(it.views) || 0), shot: it.shot, label: it.label,
      })),
    };
    if (d.id) await call(studio.reports.edit(d.id, body));
    else await call(studio.reports.add(body));
    if (d.remind) {
      await call(studio.reminders.add({ day: shiftDay(CB.today, d.remind), note: 'Загрузить отчёт', every: d.every ? d.remind : 0 })).catch((err) => toast(errText(err.code)));
    }
    CB.draft = null;
    toast('Отчёт отправлен на проверку');
    await Promise.all([loadReports(), loadReminders()]);
    renderContrib();
  } catch (err) {
    if (Number.isInteger(err.item)) d.bad = err.item;
    renderContrib();
    toast((Number.isInteger(err.item) ? 'Вложение ' + (err.item + 1) + ': ' : '') + errText(err.code));
  }
}

// ---------- скриншот ----------

// Картинка в webp: длинная сторона до 1600, если файл больше 3 МБ, меньше и хуже.
async function toWebP(blob) {
  const bmp = await createImageBitmap(blob);
  for (const [side, q] of [[1600, 0.85], [1280, 0.75], [1000, 0.65]]) {
    const scale = Math.min(1, side / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale);
    c.height = Math.round(bmp.height * scale);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    const url = c.toDataURL('image/webp', q);
    const b64 = url.slice(url.indexOf(',') + 1);
    if (b64.length * 0.75 <= 2.9 * 1024 * 1024) return { url, b64, w: c.width, h: c.height };
  }
  throw Object.assign(new Error('bad_image'), { code: 'bad_image' });
}

async function shotImage(id) {
  if (!CB.images.has(id)) CB.images.set(id, await call(studio.reports.image(id)));
  return CB.images.get(id);
}

async function showShot(id) {
  try {
    const url = await shotImage(id);
    await modal({ title: 'Скриншот', body: h('img', { class: 'shot-full', src: url, alt: 'скриншот' }), ok: 'Закрыть' });
  } catch (err) {
    toast(errText(err.code));
  }
}

// ---------- ссылки ----------

function renderLinks(box) {
  if (S.me && S.me.founder) {
    renderLinksAdmin(box);
    return;
  }
  const r = CB.refs;
  if (!r) {
    box.append(h('div', { class: 'card muted', text: 'Загрузка...' }));
    loadLinks().then(() => renderContrib(), (err) => toast(errText(err.code)));
    return;
  }
  const base = String(r.base || '').replace(/\/+$/, '');
  const card = h('div', { class: 'card' },
    h('h2', { text: 'Мои реферальные ссылки' }),
    h('p', { class: 'muted small', text: 'Делитесь ссылкой где угодно. Засчитывается уникальный посетитель за день по каждой ссылке. Переходы роботов и превью в мессенджерах не считаются. 100 переходов дают 2 балла.' }),
  );
  if (!r.targets.length) card.append(h('p', { class: 'muted', text: 'Основатель ещё не добавил, куда вести ссылки.' }));
  r.targets.forEach((t, i) => {
    const link = base + '/r/' + r.code + (i === 0 ? '' : '/' + t.slug);
    card.append(h('div', { class: 'item-row' },
      h('div', { class: 'link-name', text: t.name }),
      h('code', { class: 'grow link-url', text: link }),
      h('button', { class: 'btn btn-s', type: 'button', text: 'Копировать', onclick: async () => {
        await call(studio.app.copy(link));
        toast('Ссылка скопирована');
      } }),
    ));
  });
  box.append(card);
  box.append(refsTable(r.counts, r.targets, r.month || CB.today.slice(0, 7), false));
}

function monthNav(cur, onGo) {
  const prev = shiftDay(cur + '-01', -1).slice(0, 7);
  const next = shiftDay(cur + '-28', 5).slice(0, 7);
  return h('div', { class: 'row gap-s' },
    h('button', { class: 'btn btn-s', type: 'button', text: 'Назад', onclick: () => onGo(prev) }),
    h('b', { text: monthTitle(cur + '-01') }),
    h('button', { class: 'btn btn-s', type: 'button', text: 'Вперёд', disabled: cur >= CB.today.slice(0, 7), onclick: () => onGo(next) }),
  );
}

// Переходы по дням: строки день (и участник у основателя), столбцы цели.
function refsTable(counts, targets, month, admin) {
  const go = async (m) => {
    CB.refsMonth = m;
    try {
      await loadLinks();
      renderContrib();
    } catch (err) {
      toast(errText(err.code));
    }
  };
  const rowsMap = new Map();
  for (const c of counts) {
    const k = c.day + ':' + c.user;
    if (!rowsMap.has(k)) rowsMap.set(k, { day: c.day, user: c.user, off: c.off, by: new Map(), total: 0 });
    const r = rowsMap.get(k);
    r.by.set(c.target, (r.by.get(c.target) || 0) + c.count);
    r.total += c.count;
  }
  const rows = [...rowsMap.values()].sort((a, b) => (a.day === b.day ? a.user - b.user : a.day < b.day ? 1 : -1));
  const sum = rows.filter((r) => !r.off).reduce((n, r) => n + r.total, 0);
  const allTargets = [...targets];
  for (const c of counts) if (!allTargets.find((t) => t.id === c.target)) allTargets.push({ id: c.target, name: 'цель #' + c.target });
  const body = rows.map((r) => h('tr', { class: r.off ? 'is-off' : '' },
    h('td', { text: dayShort(r.day) }),
    admin ? h('td', { text: (S.users.get(r.user) || { name: '#' + r.user }).name }) : null,
    ...allTargets.map((t) => h('td', { text: r.by.get(t.id) ? fmtNum(r.by.get(t.id)) : '' })),
    h('td', { class: 'strong', text: fmtNum(r.total) }),
    admin ? h('td', {}, h('button', { class: 'btn btn-s' + (r.off ? '' : ' btn-danger-ghost'), type: 'button', text: r.off ? 'Засчитать' : 'Не засчитывать', onclick: async () => {
      try {
        await call(studio.refs.setOff(r.user, r.day, !r.off));
        await loadLinks();
        renderContrib();
      } catch (err) {
        toast(errText(err.code));
      }
    } })) : (r.off ? h('td', { class: 'muted small', text: 'не засчитано' }) : h('td', {})),
  ));
  return h('div', { class: 'card' },
    h('div', { class: 'row between wrap gap-s' }, h('h2', { text: 'Переходы' }), monthNav(month, go)),
    h('p', { class: 'muted small', text: 'Засчитано за месяц: ' + fmtNum(sum) + (sum ? ', это ' + (sum / 50).toLocaleString('ru-RU', { maximumFractionDigits: 2 }) + ' балла.' : '.') }),
    rows.length ? table(['День', ...(admin ? ['Участник'] : []), ...allTargets.map((t) => t.name), 'Всего', ''], body) : h('p', { class: 'muted', text: 'Переходов в этом месяце нет.' }),
  );
}

function renderLinksAdmin(box) {
  const r = CB.refsAdmin;
  if (!r) {
    box.append(h('div', { class: 'card muted', text: 'Загрузка...' }));
    loadLinks().then(() => renderContrib(), (err) => toast(errText(err.code)));
    return;
  }
  const card = h('div', { class: 'card' },
    h('div', { class: 'row between wrap gap-s' },
      h('h2', { text: 'Куда ведут ссылки' }),
      h('button', { class: 'btn btn-s', type: 'button', text: 'Добавить цель', onclick: () => editTarget() }),
    ),
    h('p', { class: 'muted small', text: 'У каждого участника своя ссылка: адрес сервера/r/код ведёт на первую включённую цель, адрес сервера/r/код/код-цели на остальные. Адрес цели только https. Путь /r/ на сервере должен быть открыт для всех (если на домене включён Cloudflare Access, его нужно пропустить).' }),
  );
  if (!r.targets.length) card.append(h('p', { class: 'muted', text: 'Целей пока нет. Добавьте сайт и YouTube-канал.' }));
  for (const t of r.targets) {
    card.append(h('div', { class: 'item-row' + (t.active ? '' : ' is-off') },
      h('div', { class: 'link-name', text: t.name }),
      h('code', { class: 'small', text: t.slug }),
      h('div', { class: 'grow small muted link-url', text: t.url }),
      h('span', { class: 'small muted', text: t.active ? 'включена' : 'выключена' }),
      h('button', { class: 'btn btn-s', type: 'button', text: 'Изменить', onclick: () => editTarget(t) }),
      h('button', { class: 'btn btn-s btn-danger-ghost', type: 'button', text: 'Удалить', onclick: async () => {
        if (!(await modal({ title: 'Удалить цель?', body: t.name + ': ' + t.url, ok: 'Удалить', danger: true }))) return;
        try {
          await call(studio.refs.deleteTarget(t.id));
          await loadLinks();
          renderContrib();
        } catch (err) {
          toast(errText(err.code));
        }
      } }),
    ));
  }
  box.append(card);
  box.append(refsTable(r.counts, r.targets, r.month, true));
}

async function editTarget(t) {
  const name = h('input', { maxlength: '40', placeholder: 'Сайт', value: t ? t.name : '' });
  const slug = h('input', { maxlength: '20', placeholder: 'site', value: t ? t.slug : '' });
  const url = h('input', { maxlength: '300', placeholder: 'https://...', value: t ? t.url : '' });
  const pos = h('input', { type: 'number', min: '0', max: '100', step: '1', value: String(t ? t.pos : 0) });
  const active = h('input', { type: 'checkbox' });
  active.checked = t ? t.active : true;
  const body = h('div', {},
    h('label', { class: 'field' }, h('span', { text: 'Название' }), name),
    h('label', { class: 'field' }, h('span', { text: 'Код в ссылке (латиница, цифры, дефис)' }), slug),
    h('label', { class: 'field' }, h('span', { text: 'Куда вести' }), url),
    h('label', { class: 'field' }, h('span', { text: 'Порядок (первая включённая открывается по короткой ссылке)' }), pos),
    h('label', { class: 'check' }, active, h('span', { text: 'Включена' })),
  );
  if (!(await modal({ title: t ? 'Цель ссылки' : 'Новая цель', body, ok: 'Сохранить' }))) return;
  try {
    await call(studio.refs.saveTarget({ id: t ? t.id : 0, name: name.value, slug: slug.value, url: url.value, active: active.checked, pos: Number(pos.value) || 0 }));
    await loadLinks();
    renderContrib();
  } catch (err) {
    toast(errText(err.code));
  }
}

// ---------- проверка у основателя ----------

function renderReview(box) {
  const status = h('select', {},
    ...[['sent', 'На проверке'], ['ok', 'Подтверждённые'], ['rejected', 'Отклонённые'], ['all', 'Все']].map(([v, t]) => h('option', { value: v, text: t })),
  );
  status.value = CB.filter.status;
  const people = [...S.users.values()].filter((u) => !u.founder).sort((a, b) => a.name.localeCompare(b.name));
  const who = h('select', {}, h('option', { value: '0', text: 'Все участники' }), ...people.map((u) => h('option', { value: String(u.id), text: u.name })));
  who.value = String(CB.filter.user || 0);
  const reload = async () => {
    CB.filter = { status: status.value, user: Number(who.value) };
    try {
      await loadQueue();
      renderContrib();
    } catch (err) {
      toast(errText(err.code));
    }
  };
  status.addEventListener('change', reload);
  who.addEventListener('change', reload);
  box.append(h('div', { class: 'card' },
    h('div', { class: 'row between wrap gap-s' }, h('h2', { text: 'Проверка отчётов' }), h('div', { class: 'row gap-s' }, status, who)),
    h('p', { class: 'muted small', text: 'Сверьте даты, площадку и просмотры на скриншоте. Числа можно поправить перед подтверждением. При отказе напишите причину: человек увидит её и исправит отчёт.' }),
  ));
  if (!CB.queue.length) {
    box.append(h('div', { class: 'card muted', text: 'Пусто.' }));
    return;
  }
  for (const r of CB.queue) box.append(reviewCard(r));
}

function reviewCard(r) {
  const u = S.users.get(r.user) || { name: '#' + r.user };
  const fixes = [];
  const items = r.items.map((it) => {
    const done = r.status === 'ok';
    const inp = (v) => h('input', { type: 'number', min: '0', step: '1', value: String(v) });
    const f = { id: it.id, views: inp(done ? it.okViews : it.views) };
    if (it.kind === 'period') {
      f.long = inp(done ? it.okLong : it.long);
      f.short = inp(done ? it.okShort : it.short);
      f.post = inp(done ? it.okPost : it.post);
    }
    fixes.push(f);
    const late = it.kind === 'pub' ? daysBetween(shiftDay(it.day, 7), new Date(r.updated).toLocaleDateString('sv-SE')) : 0;
    return h('div', { class: 'review-item' },
      h('div', { class: 'review-shot' }, thumb(it.shot)),
      h('div', { class: 'review-info' },
        h('div', {}, h('b', { text: it.platform }), h('span', { class: 'muted', text: (it.youtube ? ' (на 1000)' : ' (на 1500)') + ' · ' + itemTitle(it) })),
        it.label ? h('div', { class: 'small', text: it.label }) : null,
        late > 3 ? h('div', { class: 'muted small', text: 'Отчёт позже 7-го дня на ' + late + ' дн.: просмотры могли набраться и после.' }) : null,
        h('div', { class: 'row gap-s wrap review-nums' },
          h('label', { class: 'field' }, h('span', { text: 'Просмотры' + (r.status === 'sent' ? '' : ', писал ' + fmtNum(it.views)) }), f.views),
          ...(it.kind === 'period' ? [
            h('label', { class: 'field' }, h('span', { text: 'длинных' }), f.long),
            h('label', { class: 'field' }, h('span', { text: 'шортс' }), f.short),
            h('label', { class: 'field' }, h('span', { text: 'постов' }), f.post),
          ] : []),
        ),
      ),
    );
  });
  const act = async (ok) => {
    let note = '';
    const input = h('input', { maxlength: '300', placeholder: ok ? 'Необязательно' : 'Например: не видно дат, другая площадка' });
    setTimeout(() => input.focus(), 30);
    if (!ok) {
      if (!(await modal({ title: 'Отклонить отчёт', body: h('label', { class: 'field' }, h('span', { text: 'Причина' }), input), ok: 'Отклонить', danger: true }))) return;
      note = input.value;
    }
    const num = (el) => Math.max(0, Math.round(Number(el.value) || 0));
    try {
      await call(studio.reports.review(r.id, ok, note, fixes.map((f) => ({ id: f.id, views: num(f.views), ...(f.long ? { long: num(f.long), short: num(f.short), post: num(f.post) } : {}) }))));
      await loadQueue();
      renderContrib();
    } catch (err) {
      toast(errText(err.code));
    }
  };
  return h('div', { class: 'card report-card' },
    h('div', { class: 'row between wrap gap-s' },
      h('div', { class: 'row gap-s' }, h('b', { text: u.name }), h('span', { class: 'muted', text: dayShort(new Date(r.updated).toLocaleDateString('sv-SE')) }), statusChip(r)),
      h('div', { class: 'row gap-s' },
        h('button', { class: 'btn btn-accent btn-s', type: 'button', text: r.status === 'ok' ? 'Исправить числа' : 'Подтвердить', onclick: () => act(true) }),
        r.status !== 'rejected' ? h('button', { class: 'btn btn-s btn-danger-ghost', type: 'button', text: 'Отклонить', onclick: () => act(false) }) : null,
      ),
    ),
    r.note ? h('p', { class: 'small', text: r.note }) : null,
    r.status === 'rejected' ? h('p', { class: 'contrib-bad small', text: 'Отклонено: ' + r.reviewNote }) : null,
    ...items,
  );
}

// События сервера: новый отчёт (основателю) или проверка (участнику).
function onReportsEvent() {
  const jobs = [loadReports()];
  if (S.me && S.me.founder) jobs.push(loadQueue());
  // Подтверждение меняет баллы: вкладку "Команда" перечитываем, если она открыта.
  if (CB.tab === 'team' && S.view === 'contrib' && typeof loadTeam === 'function') jobs.push(loadTeam());
  Promise.all(jobs).then(() => {
    if (S.view === 'contrib' && !CB.draft) renderContrib();
  }, () => {});
}
