'use strict';
// Баг-репорты: тикеты с номером.
//
// Участник описывает проблему и прикладывает скриншоты. Описание становится первым
// сообщением обсуждения тикета, дальше автор и основатели переписываются там же.
// Участник видит свои тикеты, основатель все. Основатель выносит решение:
// визуальный баг, уязвимость, не баг, дубль. Баг и уязвимость сервер сам записывает
// автору в учёт.

const BG = {
  list: null, // тикеты с сервера
  open: 0, // открытый тикет; 0: список или форма
  form: false, // форма нового тикета
  filter: 'open', // open | closed
  msgs: new Map(), // id тикета -> Map(id сообщения -> сообщение)
  more: new Map(),
  draft: { title: '', body: '' },
  attach: null,
  loading: false,
};

const VERDICTS = {
  visual: 'Визуальный баг',
  vuln: 'Уязвимость',
  notbug: 'Не баг',
  dup: 'Дубль',
};

const ticketNo = (id) => '#' + id;
const isFix = (t) => t.verdict === 'visual' || t.verdict === 'vuln';

async function loadTickets() {
  const r = await call(studio.tickets.list());
  BG.list = r.tickets;
  bugsBadge();
}

function bugsBadge() {
  const b = $('badge-bugs');
  if (!b || !BG.list) return;
  const n = BG.list.reduce((s, t) => s + (t.id === BG.open && S.view === 'bugs' ? 0 : t.unread), 0);
  b.hidden = !n;
  b.textContent = n > 99 ? '99+' : n;
}

async function openBugs() {
  $('bugs-hint').textContent = S.me && S.me.founder ? 'все тикеты команды' : 'ваши тикеты';
  if (!BG.list) {
    $('bugs-list').innerHTML = '';
    $('bugs-list').append(typeof skeleton === 'function' ? skeleton('lines', 4) : h('div', { class: 'side-empty', text: 'Загрузка...' }));
    try {
      await loadTickets();
    } catch (err) {
      toast(errText(err.code));
      return;
    }
  }
  if (!BG.open && !BG.form && !BG.list.length) BG.form = true;
  renderBugs();
}

function statusLine(t) {
  if (t.status === 'open') return 'ждёт решения';
  let s = VERDICTS[t.verdict] || 'закрыт';
  if (t.verdict === 'dup' && t.dupOf) s += ' ' + ticketNo(t.dupOf);
  if (t.verdict === 'visual') s += ', ' + t.qty + ' шт.';
  if (t.verdict === 'vuln') s += ', ' + t.points + ' баллов';
  if (t.amount) s += ', ' + t.amount + ' $';
  return s;
}

function renderBugs() {
  renderBugList();
  if (BG.form) renderBugForm();
  else renderTicket();
  bugsBadge();
}

function renderBugList() {
  const founder = S.me && S.me.founder;
  const f = $('bugs-filter');
  f.innerHTML = '';
  const nOpen = (BG.list || []).filter((t) => t.status === 'open').length;
  const nClosed = (BG.list || []).length - nOpen;
  f.append(segOf([['open', 'Открытые ' + nOpen], ['closed', 'Закрытые ' + nClosed]], BG.filter, (v) => {
    BG.filter = v;
    renderBugList();
  }));
  const box = $('bugs-list');
  box.innerHTML = '';
  const list = (BG.list || []).filter((t) => (BG.filter === 'open') === (t.status === 'open'));
  if (!list.length) box.append(h('div', { class: 'side-empty', text: BG.filter === 'open' ? 'Открытых тикетов нет.' : 'Закрытых тикетов пока нет.' }));
  for (const t of list) {
    const u = S.users.get(t.user);
    box.append(h('button', { class: 'item ticket-item' + (t.id === BG.open && !BG.form ? ' is-on' : ''), onclick: () => showTicket(t.id) },
      h('span', { class: 'ticket-no', text: ticketNo(t.id) }),
      h('span', { class: 'ticket-main' },
        h('span', { class: 'item-name', text: t.title }),
        h('span', { class: 'ticket-meta ' + (t.status === 'open' ? 'is-open' : 'is-' + t.verdict), text: (founder && u ? u.name + ' · ' : '') + statusLine(t) })),
      t.unread ? h('span', { class: 'badge', text: t.unread }) : null));
  }
}

// ---------- новый тикет ----------

function newBugForm() {
  BG.form = true;
  BG.open = 0;
  renderBugs();
}
$('bugs-new').addEventListener('click', newBugForm);

function renderBugForm() {
  $('bug-title').textContent = 'Новый баг-репорт';
  $('bug-sub').textContent = 'Тикет получит номер, ответ придёт сюда же';
  $('bug-tools').innerHTML = '';
  const body = $('bug-body');
  body.innerHTML = '';
  const title = h('input', { maxlength: '120', placeholder: 'Коротко: что сломалось. Например: плеер не играет после смены источника', value: BG.draft.title });
  const text = h('textarea', { rows: '8', maxlength: '4000', placeholder: 'Что делали по шагам, что ожидали, что получилось. Если ошибка повторяется, напишите как.' });
  text.value = BG.draft.body;
  title.addEventListener('input', () => (BG.draft.title = title.value));
  text.addEventListener('input', () => (BG.draft.body = text.value));
  const strip = h('div', { class: 'att-strip bug-att', hidden: true });
  if (!BG.attach) BG.attach = new Attacher(strip);
  BG.attach.strip = strip;
  BG.attach.render();
  const imgBtn = h('button', { class: 'btn btn-img', type: 'button' });
  const send = h('button', { class: 'btn btn-accent', type: 'submit', text: 'Отправить' });
  const form = h('form', { class: 'bug-form card' },
    h('label', { class: 'field' }, h('span', { text: 'Заголовок' }), title),
    h('label', { class: 'field' }, h('span', { text: 'Описание' }), text),
    h('div', { class: 'field' }, h('span', { text: 'Скриншоты, до 6 штук: кнопкой, Ctrl+V или перетащить сюда' }), strip, imgBtn),
    h('p', { class: 'muted small', text: 'Версия приложения и система добавятся сами. Визуальные баги и уязвимости после проверки идут в учёт.' }),
    h('div', { class: 'row end' }, BG.list && BG.list.length ? h('button', { class: 'btn', type: 'button', text: 'Отмена', onclick: () => {
      BG.form = false;
      renderBugs();
    } }) : null, send));
  bindAttach({ input: text, dropZone: form, button: imgBtn, attacher: BG.attach, allowed: () => true });
  imgBtn.append(document.createTextNode(' Добавить скриншот'));
  title.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData ? e.clipboardData.files : [])].filter((f) => /^image\//.test(f.type));
    if (files.length) {
      e.preventDefault();
      BG.attach.add(files);
    }
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!title.value.trim()) return title.focus();
    if (!text.value.trim()) return text.focus();
    send.disabled = true;
    send.textContent = 'Отправляю...';
    try {
      const t = await call(studio.tickets.add({
        title: title.value.trim(),
        body: text.value.trim(),
        images: BG.attach.items.map((x) => ({ data: x.b64, w: x.w, h: x.h })),
      }));
      BG.draft = { title: '', body: '' };
      BG.attach.clear();
      BG.list = [t, ...(BG.list || []).filter((x) => x.id !== t.id)];
      BG.form = false;
      toast('Тикет ' + ticketNo(t.id) + ' отправлен.');
      showTicket(t.id);
    } catch (err) {
      toast(errText(err.code));
      send.disabled = false;
      send.textContent = 'Отправить';
    }
  });
  body.append(form);
  setTimeout(() => (title.value ? text : title).focus(), 30);
}

// ---------- тикет ----------

async function showTicket(id) {
  BG.form = false;
  BG.open = id;
  renderBugs();
  if (!BG.msgs.has(id)) {
    await loadTicketMsgs(id);
    if (BG.open === id) renderTicket();
  }
  ticketRead(id);
}

async function loadTicketMsgs(id, before) {
  if (BG.loading) return;
  BG.loading = true;
  try {
    const r = await call(studio.api.messages('ticket:' + id, before));
    const list = BG.msgs.get(id) || new Map();
    for (const m of r.messages) list.set(m.id, m);
    BG.msgs.set(id, list);
    BG.more.set(id, r.messages.length === 50);
  } catch (err) {
    toast(errText(err.code));
  } finally {
    BG.loading = false;
  }
}

function ticketRead(id) {
  const list = BG.msgs.get(id);
  const t = (BG.list || []).find((x) => x.id === id);
  if (!list || !list.size) return;
  studio.chat.send({ t: 'read', room: 'ticket:' + id, id: Math.max(...list.keys()) });
  if (t && t.unread) {
    t.unread = 0;
    renderBugList();
    bugsBadge();
  }
}

function renderTicket() {
  const t = (BG.list || []).find((x) => x.id === BG.open);
  const body = $('bug-body');
  const tools = $('bug-tools');
  tools.innerHTML = '';
  body.innerHTML = '';
  if (!t) {
    $('bug-title').textContent = 'Баг-репорты';
    $('bug-sub').textContent = '';
    body.append(h('div', { class: 'log-empty' }, h('div', { text: 'Выберите тикет слева или сообщите о новом баге.' })));
    return;
  }
  const founder = S.me && S.me.founder;
  const u = S.users.get(t.user);
  $('bug-title').textContent = ticketNo(t.id) + ' ' + t.title;
  $('bug-sub').textContent = [u ? u.name : 'Участник', dayLabel(t.created) + ' ' + timeOf(t.created), t.app].filter(Boolean).join(' · ');
  if (founder) tools.append(h('button', { class: 'btn btn-s btn-accent', type: 'button', text: t.status === 'open' ? 'Решение' : 'Изменить решение', onclick: () => reviewTicket(t) }));
  if (founder || (t.user === S.me.id && t.status === 'open')) {
    tools.append(h('button', { class: 'btn btn-s', type: 'button', text: 'Переименовать', onclick: () => renameTicket(t) }));
    tools.append(h('button', { class: 'btn btn-s btn-danger-ghost', type: 'button', text: 'Удалить', onclick: () => deleteTicket(t) }));
  }

  const verdict = t.status === 'open'
    ? h('div', { class: 'ticket-verdict is-open' }, h('b', { text: 'Ждёт решения.' }), h('span', { class: 'muted', text: ' Основатель посмотрит и ответит здесь же.' }))
    : h('div', { class: 'ticket-verdict is-' + t.verdict },
      h('b', { text: statusLine(t) + '.' }),
      t.inAcct ? h('span', { class: 'muted', text: ' Записано в учёт.' }) : null,
      isFix(t) ? h('span', { class: 'muted', text: ' Скриншоты сохранены в истории исправлений.' }) : null,
      t.verdict === 'notbug' || t.verdict === 'dup' ? h('span', { class: 'muted', text: ' Скриншоты уберутся с сервера через 7 дней после решения.' }) : null,
      t.note ? h('div', { class: 'ticket-note', text: t.note }) : null);

  const log = h('div', { class: 'log bug-log', id: 'bug-log' });
  log.addEventListener('scroll', async () => {
    if (log.scrollTop > 60 || !BG.more.get(t.id) || BG.loading) return;
    const list = BG.msgs.get(t.id);
    if (!list || !list.size) return;
    const old = log.scrollHeight;
    await loadTicketMsgs(t.id, Math.min(...list.keys()));
    renderTicketLog();
    log.scrollTop = log.scrollHeight - old;
  });

  const ta = h('textarea', { rows: '1', maxlength: '4000', placeholder: 'Ответить в тикет. Enter отправить, Shift+Enter новая строка' });
  const imgBtn = h('button', { class: 'btn btn-ico', type: 'button', title: 'Картинка: кнопкой, Ctrl+V или перетащить сюда' });
  const strip = h('div', { class: 'att-strip', hidden: true });
  const attach = new Attacher(strip);
  const form = h('form', { class: 'composer topic-composer' }, strip, imgBtn, ta, h('button', { class: 'btn btn-accent', type: 'submit', text: 'Отправить' }));
  bindAttach({ input: ta, dropZone: form, button: imgBtn, attacher: attach, allowed: () => true });
  const size = () => {
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 160) + 'px';
  };
  ta.addEventListener('input', size);
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      form.requestSubmit();
    }
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = ta.value.trim();
    if (!text && !attach.count) return;
    if (!(await sendWithImages('ticket:' + t.id, text, attach))) return;
    ta.value = '';
    size();
  });
  body.append(verdict, log, form);
  renderTicketLog(true);
}

function renderTicketLog(stick) {
  const log = $('bug-log');
  if (!log) return;
  const near = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
  log.innerHTML = '';
  const list = [...(BG.msgs.get(BG.open) || new Map()).values()].sort((a, b) => a.id - b.id);
  if (BG.more.get(BG.open)) log.append(h('div', { class: 'log-more', text: 'Прокрутите вверх, чтобы загрузить раньше' }));
  let prev = null;
  for (const m of list) {
    const day = dayLabel(m.ts);
    if (!prev || dayLabel(prev.ts) !== day) log.append(h('div', { class: 'day', text: day }));
    const compact = prev && prev.user === m.user && m.ts - prev.ts < 5 * 60 * 1000 && dayLabel(prev.ts) === day;
    log.append(ticketMessage(m, compact));
    prev = m;
  }
  if (stick || near) log.scrollTop = log.scrollHeight;
}

function ticketMessage(m, compact) {
  const u = S.users.get(m.user) || { name: 'Удалённый пользователь' };
  const mine = m.user === S.me.id;
  const row = h('div', { class: 'msg' + (compact ? ' compact' : '') + (mine ? ' mine' : '') });
  row.append(compact ? h('span', { class: 'msg-time-side', text: timeOf(m.ts) }) : avatar(u, 32));
  const body = h('div', { class: 'msg-body' });
  if (!compact) {
    body.append(h('div', { class: 'msg-head' },
      h('span', { class: 'msg-name', text: u.name }),
      u.founder ? h('span', { class: 'tag', text: 'основатель' }) : null,
      h('span', { class: 'msg-time', text: timeOf(m.ts) })));
  }
  if (m.text) body.append(h('div', { class: 'msg-text' }, linkify(m.text), m.edited ? h('span', { class: 'edited', text: ' (изменено)' }) : null));
  const imgs = msgImages(m);
  if (imgs) body.append(imgs);
  if (!m.text && !imgs) body.append(h('div', { class: 'muted small', text: 'Скриншоты убраны с сервера после решения.' }));
  row.append(body);
  if (mine || S.me.role === 'admin') row.append(h('div', { class: 'msg-actions' }, h('button', { class: 'mini', text: 'удалить', onclick: () => deleteMessage(m) })));
  return row;
}

// Сообщения обсуждений тикетов (комнаты ticket:<id>) приходят сюда из app.js.
function onTicketChat(ev) {
  const room = (ev.m && ev.m.room) || ev.room || '';
  const id = Number(room.slice(7));
  const list = BG.msgs.get(id);
  const here = S.view === 'bugs' && BG.open === id && !BG.form;
  if (ev.t === 'msg') {
    if (list) list.set(ev.m.id, ev.m);
    const t = (BG.list || []).find((x) => x.id === id);
    if (t) {
      t.messages++;
      t.last = ev.m.ts;
    }
    if (ev.m.user !== S.me.id) {
      if (here && document.hasFocus()) studio.chat.send({ t: 'read', room, id: ev.m.id });
      else if (t) t.unread++;
      else if (!BG.list) loadTickets().catch(() => {});
      if (!here && typeof uiSound === 'function') uiSound('message');
    }
  } else if (ev.t === 'edit' && list) list.set(ev.m.id, ev.m);
  else if (ev.t === 'delete' && list) list.delete(ev.id);
  else if (ev.t === 'read') {
    const t = (BG.list || []).find((x) => x.id === id);
    if (t) t.unread = 0;
  }
  if (here) renderTicketLog(ev.t === 'msg' && ev.m.user === S.me.id);
  if (S.view === 'bugs') renderBugList();
  bugsBadge();
}

// Тикет создан, изменён, решён или удалён: перечитать список.
async function onTicketsEvent(ev) {
  if (ev.op === 'new' && S.me && S.me.founder && ev.user !== S.me.id) toast('Новый баг-репорт ' + ticketNo(ev.id) + ': ' + (ev.title || ''));
  if (ev.op === 'review' && BG.list) {
    const t = BG.list.find((x) => x.id === ev.id);
    if (t && t.user === S.me.id && !S.me.founder) toast('По тикету ' + ticketNo(ev.id) + ' есть решение.');
  }
  if (ev.op === 'delete') {
    BG.msgs.delete(ev.id);
    if (BG.open === ev.id) BG.open = 0;
  }
  try {
    await loadTickets();
  } catch {
    return;
  }
  if (S.view === 'bugs') renderBugs();
}

// ---------- действия ----------

async function renameTicket(t) {
  const input = h('input', { maxlength: '120', value: t.title });
  setTimeout(() => input.focus(), 30);
  if (!(await modal({ title: 'Переименовать ' + ticketNo(t.id), body: input, ok: 'Сохранить' })) || !input.value.trim()) return;
  try {
    const nt = await call(studio.tickets.rename(t.id, input.value.trim()));
    Object.assign(t, nt);
    renderBugs();
  } catch (err) {
    toast(errText(err.code));
  }
}

async function deleteTicket(t) {
  const extra = t.inAcct ? '\n\nЗапись в учёте по этому тикету тоже удалится.' : '';
  if (!(await modal({ title: 'Удалить тикет ' + ticketNo(t.id) + '?', body: 'Удалятся описание, переписка и скриншоты.' + extra, ok: 'Удалить', danger: true }))) return;
  try {
    await call(studio.tickets.remove(t.id));
    BG.list = BG.list.filter((x) => x.id !== t.id);
    BG.msgs.delete(t.id);
    BG.open = 0;
    renderBugs();
  } catch (err) {
    toast(errText(err.code));
  }
}

async function reviewTicket(t) {
  const st = {
    verdict: t.verdict || 'visual',
    qty: t.qty || 1,
    points: t.points || 25,
    amount: t.amount || (t.verdict ? 0 : 0),
    dupOf: t.dupOf || 0,
    note: t.note || '',
  };
  const author = S.users.get(t.user);
  const box = h('div', { class: 'col gap-s review-box' });
  const num = (label, key, step, min, max, hint) => {
    const input = h('input', { type: 'number', step: String(step), min: String(min), max: String(max), value: String(st[key]) });
    input.addEventListener('input', () => (st[key] = Number(input.value) || 0));
    return h('label', { class: 'field' }, h('span', { text: label }), input, hint ? h('span', { class: 'muted small', text: hint }) : null);
  };
  const note = h('textarea', { rows: '3', maxlength: '1000', placeholder: 'Комментарий автору: что проверили, почему такое решение' });
  note.value = st.note;
  note.addEventListener('input', () => (st.note = note.value));
  const draw = () => {
    box.innerHTML = '';
    box.append(segOf(Object.entries(VERDICTS), st.verdict, (v) => {
      if (v === 'vuln' && !st.amount) st.amount = 1;
      st.verdict = v;
      draw();
    }));
    if (st.verdict === 'visual') {
      box.append(num('Сколько неточностей в тикете', 'qty', 1, 1, 100, 'В учёт: 3 балла за каждые 5.'), num('Сумма, $', 'amount', 0.05, 0, 5, 'По правилам до 0,50 $ за пачку из 5-10.'));
    } else if (st.verdict === 'vuln') {
      box.append(num('Баллы', 'points', 1, 1, 1000, 'По правилам 25-75.'), num('Сумма, $', 'amount', 0.5, 0, 50, 'По правилам 1-5 $.'));
    } else if (st.verdict === 'dup') {
      const others = (BG.list || []).filter((x) => x.id !== t.id && x.created <= t.created);
      const sel = h('select', {}, h('option', { value: '0', text: 'Выберите тикет' }), ...others.map((x) => h('option', { value: String(x.id), text: ticketNo(x.id) + ' ' + x.title, selected: x.id === st.dupOf })));
      sel.addEventListener('change', () => (st.dupOf = Number(sel.value)));
      box.append(h('label', { class: 'field' }, h('span', { text: 'Дубль какого тикета (оплачивается тому, кто прислал первым)' }), sel));
    }
    if ((st.verdict === 'visual' || st.verdict === 'vuln') && author && author.founder) box.append(h('p', { class: 'muted small', text: 'Автор основатель: в учёт не попадёт.' }));
    box.append(h('label', { class: 'field' }, h('span', { text: 'Комментарий' }), note));
    if (t.status !== 'open') box.append(h('button', { class: 'btn btn-s', type: 'button', text: 'Вернуть в открытые', onclick: () => {
      st.verdict = '';
      $('modal-ok').click();
    } }));
  };
  draw();
  if (!(await modal({ title: 'Решение по ' + ticketNo(t.id), body: box, ok: 'Сохранить', wide: true }))) return;
  if (st.verdict === 'dup' && !st.dupOf) {
    toast('Выберите, дубль какого тикета.');
    return;
  }
  try {
    const r = await call(studio.tickets.review(t.id, st));
    Object.assign(t, r.ticket);
    toast(st.verdict ? 'Решение сохранено' + (t.inAcct ? ', записано в учёт.' : '.') : 'Тикет снова открыт.');
    renderBugs();
  } catch (err) {
    toast(errText(err.code));
  }
}

// Список нужен и до первого захода в раздел: для значка непрочитанного.
function bugsStart() {
  BG.list = null;
  BG.msgs.clear();
  BG.open = 0;
  loadTickets().catch(() => {});
}
