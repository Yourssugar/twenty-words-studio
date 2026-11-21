'use strict';
// Вкладка "Учёт" в разделе "Вклад" (только основатель). Сервер считает всё сам
// (acct_calc.go), здесь ввод и просмотр: месяц, события, выплаты, финансы студии,
// бонусы, участники, веса и ставки, выгрузка в xlsx.

const AC = {
  data: null, // ответ /api/admin/acct
  section: 'month',
  month: '',
};

Object.assign(ERRORS, {
  month_closed: 'Месяц закрыт. Откройте его снова или платите "в счёт долга".',
  close_order: 'Закрывать и открывать месяцы нужно по порядку.',
  not_member: 'Основатели в учёт не входят.',
});

const CAT_NAMES = { pub: 'отчёт', refs: 'переходы', bugs: 'визуальные баги', vuln: 'уязвимость', idea: 'идея', comp: 'компенсация', bonus: 'личная доплата', transfer: 'перенос из пула', pool: 'бонусный пул' };
const PURPOSES = { month: 'за месяц', advance: 'аванс', debt: 'в счёт долга', retro: 'ретро-бонус' };

const usd = (v) => {
  const n = Number(v || 0);
  if (!n) return '0 $';
  return n.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: Math.abs(n) < 1 ? 3 : 2 }) + ' $';
};
const pts = (v) => Number(v || 0).toLocaleString('ru-RU', { maximumFractionDigits: 2 });
const pct = (v) => (Number(v || 0) * 100).toLocaleString('ru-RU', { maximumFractionDigits: 1 }) + '%';
const memberName = (id) => ((AC.data && AC.data.result.members.find((m) => m.id === id)) || { name: '#' + id }).name;

async function loadAcct() {
  AC.data = await call(studio.acct.get());
  const r = AC.data.result;
  if (!AC.month || !r.months.some((m) => m.month === AC.month)) AC.month = r.current;
}

async function acctReload() {
  try {
    await loadAcct();
  } catch (err) {
    toast(errText(err.code));
  }
  if (S.view === 'contrib' && CB.tab === 'acct') renderContrib();
}

// Обёртка: выполнить, показать ошибку, перерисовать.
async function acctDo(fn, ok) {
  try {
    await fn();
    if (ok) toast(ok);
  } catch (err) {
    toast(errText(err.code));
  }
  await acctReload();
}

function renderAcct(box) {
  if (!AC.data) {
    box.append(h('div', { class: 'card muted', text: 'Загрузка...' }));
    loadAcct().then(() => renderContrib(), (err) => toast(errText(err.code)));
    return;
  }
  const r = AC.data.result;
  const sections = [['month', 'Месяц'], ['events', 'События'], ['payments', 'Выплаты'], ['finance', 'Финансы студии'], ['bonus', 'Бонусы'], ['members', 'Участники'], ['weights', 'Веса и ставки']];
  box.append(h('div', { class: 'acct-bar' },
    ...sections.map(([id, t]) => h('button', { class: 'chip-btn' + (AC.section === id ? ' is-on' : ''), type: 'button', text: t, onclick: () => { AC.section = id; renderContrib(); } })),
    h('div', { class: 'grow' }),
    h('span', { class: 'muted small', text: r.plus ? 'В плюсе с ' + monthTitle(r.plus + '-01') : 'Студия ещё не в плюсе' }),
    h('button', { class: 'btn btn-s', type: 'button', text: 'Выгрузить в xlsx', onclick: async () => {
      try {
        const p = await call(studio.acct.exportXlsx());
        if (p) toast('Сохранено: ' + p);
      } catch (err) {
        toast(errText(err.code));
      }
    } }),
  ));
  ({ month: acctMonth, events: acctEvents, payments: acctPayments, finance: acctFinance, bonus: acctBonus, members: acctMembers, weights: acctWeights })[AC.section](box, r);
}

function table(head, rows, cls) {
  return h('div', { class: 'table-wrap' }, h('table', { class: 'table acct-table ' + (cls || '') },
    h('thead', {}, h('tr', {}, ...head.map((x) => h('th', { text: x })))),
    h('tbody', {}, ...rows),
  ));
}

const memberSelect = (r) => h('select', {}, ...r.members.map((m) => h('option', { value: String(m.id), text: m.name + (m.leftOn ? ' (ушёл)' : '') })));
const acctToday = () => (AC.data && AC.data.result.today) || new Date().toLocaleDateString('sv-SE');
const dateInput = (v) => h('input', { type: 'date', value: v || acctToday() });
const numInput = (v, step) => h('input', { type: 'number', step: step || '0.01', min: '0', value: v === undefined || v === null ? '' : String(v) });

// ---------- месяц ----------

function acctMonth(box, r) {
  const sel = h('select', {}, ...[...r.months].reverse().map((m) => h('option', { value: m.month, text: monthTitle(m.month + '-01') + (m.closed ? ', закрыт' : '') })));
  sel.value = AC.month;
  sel.addEventListener('change', () => {
    AC.month = sel.value;
    renderContrib();
  });
  const mi = r.months.find((m) => m.month === AC.month) || { month: AC.month };
  const rows = r.rows[AC.month] || [];
  box.append(h('div', { class: 'card' },
    h('div', { class: 'row between wrap gap-s' },
      h('div', { class: 'row gap-s' }, h('h2', { text: 'Месяц' }), sel, mi.plus ? h('span', { class: 'tag', text: 'точка выхода в плюс' }) : null),
      h('button', { class: 'btn btn-s' + (mi.closed ? '' : ' btn-accent'), type: 'button', text: mi.closed ? 'Открыть снова' : 'Закрыть месяц', onclick: () => closeMonth(mi) }),
    ),
    h('div', { class: 'acct-stats' },
      stat('Бюджет на начало', usd(mi.budgetStart)),
      stat('Отложено', usd(mi.budgetAdd)),
      stat('Потрачено', usd(mi.spent)),
      stat('Остаток', usd(mi.budgetEnd), mi.budgetEnd < 0 ? 'is-bad' : ''),
      stat('Доход студии', usd(mi.income)),
      stat('Расходы', usd(mi.expenses)),
      mi.pool ? stat('Пул (делится в след. месяце)', usd(mi.pool)) : null,
    ),
    h('p', { class: 'muted small', text: mi.closed
      ? 'Месяц закрыт: цифры заморожены, недоплата записана в долг. Платить дальше: "в счёт долга".'
      : 'Закрытие замораживает месяц: что не выплачено, записывается в долг навсегда (при выходе в плюс долг x10). Закрывать по порядку.' }),
  ));
  if (!rows.length) {
    box.append(h('div', { class: 'card muted', text: 'В этом месяце нет начислений.' }));
  } else {
    box.append(h('div', { class: 'card' }, table(
      ['Участник', 'Баллы', 'Доля', 'Заработано', 'Пул', 'Доплаты', 'Начислено', 'Аванс', 'К выплате', 'Выплачено', mi.closed ? 'Долг' : 'Не выплачено', ''],
      rows.map((x) => h('tr', {},
        h('td', {}, memberName(x.user), x.testOnly ? h('span', { class: 'muted small', text: ' тест' }) : null),
        h('td', { text: pts(x.points) }), h('td', { text: pct(x.share) }), h('td', { text: usd(x.earned) }), h('td', { text: usd(x.pool) }),
        h('td', { text: usd(x.other) }), h('td', { text: usd(x.accrued) }), h('td', { text: x.offset ? '-' + usd(x.offset) : '' }),
        h('td', { class: 'strong', text: usd(x.due) }), h('td', { text: usd(x.paid) }),
        h('td', { class: x.unpaid > 0 ? 'contrib-bad' : '', text: usd(x.unpaid) }),
        h('td', {}, !mi.closed && x.unpaid > 0 ? h('button', { class: 'btn btn-s', type: 'button', text: 'Выплатить', onclick: () => payDialog(r, { user: x.user, amount: Math.round(x.unpaid * 100) / 100, purpose: 'month', month: AC.month }) }) : null),
      )),
    )));
  }
  const lines = r.lines.filter((l) => l.month === AC.month);
  if (lines.length) {
    box.append(h('div', { class: 'card' }, h('h3', { text: 'Начисления месяца' }), table(['Дата', 'Участник', 'Вид', 'Баллы', 'Сумма', 'Примечание'],
      lines.map((l) => h('tr', {}, h('td', { text: dayShort(l.day) }), h('td', { text: memberName(l.user) }), h('td', { text: CAT_NAMES[l.cat] || l.cat }),
        h('td', { text: pts(l.points) }), h('td', { text: usd(l.amount) }), h('td', { class: 'muted', text: l.note || '' }))))));
  }
}

function stat(label, value, cls) {
  return h('div', { class: 'acct-stat ' + (cls || '') }, h('div', { class: 'muted small', text: label }), h('div', { class: 'acct-stat-v', text: value }));
}

async function closeMonth(mi) {
  const open = mi.closed;
  const ok = await modal({
    title: (open ? 'Открыть ' : 'Закрыть ') + monthTitle(mi.month + '-01').toLowerCase() + '?',
    body: open ? 'Снимок месяца удалится, записанный в нём долг тоже. Цифры снова посчитаются по текущим данным.' : 'Что сейчас не выплачено, станет долгом. После этого события и выплаты за этот месяц менять нельзя.',
    ok: open ? 'Открыть' : 'Закрыть',
    danger: !open,
  });
  if (ok) acctDo(() => call(studio.acct.close(mi.month, open)), open ? 'Месяц открыт' : 'Месяц закрыт');
}

// ---------- события ----------

function acctEvents(box, r) {
  const user = memberSelect(r);
  const to = memberSelect(r);
  const type = h('select', {}, ...['bugs', 'vuln', 'idea', 'refs', 'comp', 'bonus', 'transfer'].map((t) => h('option', { value: t, text: CAT_NAMES[t] })));
  const day = dateInput();
  const qty = numInput('', '1');
  const points = numInput('', '0.1');
  const amount = numInput('');
  const note = h('input', { maxlength: '200', placeholder: 'Примечание' });
  const f = (label, el) => h('label', { class: 'field' }, h('span', { text: label }), el);
  const fUser = f('Участник', user);
  const fTo = f('Кому (ушедший)', to);
  const fQty = f('Количество', qty);
  const fPoints = f('Баллы', points);
  const fAmount = f('Сумма, $', amount);
  const hint = h('p', { class: 'muted small' });
  const sync = () => {
    const t = type.value;
    fQty.hidden = !(t === 'bugs' || t === 'refs');
    fPoints.hidden = !(t === 'vuln' || t === 'idea');
    fAmount.hidden = t === 'refs';
    fTo.hidden = t !== 'transfer';
    fUser.querySelector('span').textContent = t === 'transfer' ? 'От кого (часть своего пула)' : 'Участник';
    fQty.querySelector('span').textContent = t === 'refs' ? 'Переходов' : 'Багов';
    hint.textContent = {
      bugs: 'Баллы: 3 за каждые 5 багов, без округления. Сумма за пачку 5-10 багов: до 0,50 $.',
      vuln: 'Критическая уязвимость: 25-75 баллов, 1-5 $.',
      idea: 'Идея: 1-300 баллов, сумма по договорённости (можно 0).',
      refs: 'Только то, что сервер не посчитал сам (переходы по ссылкам считаются автоматически). 2 балла и 0,01 $ за каждые 100, после выхода в плюс 0,03 $.',
      comp: 'Компенсация покупки по согласованию: из бюджета, не заработок, в ретро-бонус не входит.',
      bonus: 'Личная доплата основателей (за месяц, к дню рождения): вне пула и баллов.',
      transfer: 'Бонус ушедшему: участник отдаёт часть своего пула. У него сумма уйдёт в минус, у ушедшего в плюс.',
    }[t];
  };
  type.addEventListener('change', sync);
  sync();
  box.append(h('div', { class: 'card' },
    h('h2', { text: 'Новое событие' }),
    h('div', { class: 'acct-form' }, f('Тип', type), fUser, fTo, f('Дата', day), fQty, fPoints, fAmount, f('Примечание', note)),
    hint,
    h('button', { class: 'btn btn-accent', type: 'button', text: 'Добавить', onclick: () => acctDo(async () => {
      const base = { day: day.value, type: type.value, qty: Number(qty.value) || 0, points: Number(points.value) || 0, amount: Number(amount.value) || 0, note: note.value };
      if (type.value === 'transfer') {
        if (to.value === user.value) throw Object.assign(new Error('bad_input'), { code: 'bad_input' });
        await call(studio.acct.addEvent({ ...base, user: Number(user.value), amount: -Math.abs(base.amount), note: 'ушедшему ' + memberName(Number(to.value)) + (note.value ? ': ' + note.value : '') }));
        await call(studio.acct.addEvent({ ...base, user: Number(to.value), amount: Math.abs(base.amount), note: 'от ' + memberName(Number(user.value)) + (note.value ? ': ' + note.value : '') }));
      } else {
        await call(studio.acct.addEvent({ ...base, user: Number(user.value) }));
      }
    }, 'Добавлено') }),
  ));
  const list = [...AC.data.events].reverse();
  box.append(h('div', { class: 'card' }, h('h3', { text: 'Журнал событий' }), list.length ? table(['Дата', 'Участник', 'Тип', 'Кол-во', 'Баллы', 'Сумма', 'Примечание', ''],
    list.map((e) => h('tr', {},
      h('td', { text: dayShort(e.day) }), h('td', { text: memberName(e.user) }), h('td', { text: CAT_NAMES[e.type] }),
      h('td', { text: e.qty ? pts(e.qty) : '' }), h('td', { text: e.points ? pts(e.points) : '' }), h('td', { text: e.amount ? usd(e.amount) : '' }),
      h('td', { class: 'muted', text: e.note || '' }),
      h('td', {}, h('button', { class: 'btn btn-s btn-danger-ghost', type: 'button', text: 'Удалить', onclick: async () => {
        if (await modal({ title: 'Удалить событие?', body: CAT_NAMES[e.type] + ', ' + memberName(e.user) + ', ' + dayShort(e.day), ok: 'Удалить', danger: true })) acctDo(() => call(studio.acct.deleteEvent(e.id)));
      } })),
    ))) : h('p', { class: 'muted', text: 'Пусто.' })));
}

// ---------- выплаты ----------

async function payDialog(r, pre) {
  const user = memberSelect(r);
  if (pre.user) user.value = String(pre.user);
  const day = dateInput();
  const amount = numInput(pre.amount);
  const purpose = h('select', {}, ...Object.entries(PURPOSES).map(([v, t]) => h('option', { value: v, text: t })));
  purpose.value = pre.purpose || 'month';
  const month = h('select', {}, ...[...r.months].reverse().filter((m) => !m.closed).map((m) => h('option', { value: m.month, text: monthTitle(m.month + '-01') })));
  if (pre.month) month.value = pre.month;
  const note = h('input', { maxlength: '200', placeholder: 'Например: перевод на карту' });
  const fMonth = h('label', { class: 'field' }, h('span', { text: 'За месяц' }), month);
  const sync = () => (fMonth.hidden = purpose.value !== 'month');
  purpose.addEventListener('change', sync);
  sync();
  const f = (label, el) => h('label', { class: 'field' }, h('span', { text: label }), el);
  const body = h('div', {}, f('Участник', user), f('Назначение', purpose), fMonth, f('Дата выплаты', day), f('Сумма, $', amount), f('Примечание', note),
    h('p', { class: 'muted small', text: 'Аванс зачитывается в следующие начисления. "В счёт долга" гасит записанный долг, "ретро-бонус" гасит ретро-бонус.' }));
  if (!(await modal({ title: 'Выплата', body, ok: 'Записать' }))) return;
  acctDo(() => call(studio.acct.addPayment({ user: Number(user.value), day: day.value, amount: Number(amount.value) || 0, purpose: purpose.value, month: month.value, note: note.value })), 'Выплата записана');
}

function acctPayments(box, r) {
  box.append(h('div', { class: 'card' },
    h('div', { class: 'row between' }, h('h2', { text: 'Выплаты' }), h('button', { class: 'btn btn-accent', type: 'button', text: 'Записать выплату', onclick: () => payDialog(r, {}) })),
    h('p', { class: 'muted small', text: 'Все выплаты идут из бюджета месяца по дате выплаты.' }),
  ));
  const list = [...AC.data.payments].reverse();
  box.append(h('div', { class: 'card' }, list.length ? table(['Дата', 'Участник', 'Сумма', 'Назначение', 'За месяц', 'Примечание', ''],
    list.map((p) => h('tr', {},
      h('td', { text: dayShort(p.day) }), h('td', { text: memberName(p.user) }), h('td', { class: 'strong', text: usd(p.amount) }),
      h('td', { text: PURPOSES[p.purpose] }), h('td', { text: p.month ? monthTitle(p.month + '-01') : '' }), h('td', { class: 'muted', text: p.note || '' }),
      h('td', {}, h('button', { class: 'btn btn-s btn-danger-ghost', type: 'button', text: 'Удалить', onclick: async () => {
        if (await modal({ title: 'Удалить выплату?', body: usd(p.amount) + ', ' + memberName(p.user) + ', ' + dayShort(p.day), ok: 'Удалить', danger: true })) acctDo(() => call(studio.acct.deletePayment(p.id)));
      } })),
    ))) : h('p', { class: 'muted', text: 'Выплат пока нет.' })));
}

// ---------- финансы студии ----------

function acctFinance(box, r) {
  const fin = new Map(AC.data.finance.map((m) => [m.month, m]));
  const w = r.weights;
  const rows = [...r.months].reverse().map((mi) => {
    const f = fin.get(mi.month) || {};
    const income = numInput(f.income || '');
    const expenses = numInput(f.expenses || '');
    const add = numInput(f.budgetAdd === undefined || f.budgetAdd === null ? '' : f.budgetAdd);
    add.placeholder = String(w.budgetMonthly);
    return h('tr', {},
      h('td', {}, monthTitle(mi.month + '-01'), mi.plus ? h('span', { class: 'tag', text: 'плюс' }) : null),
      h('td', {}, income), h('td', {}, expenses),
      h('td', { class: mi.net > 0 ? 'ok' : '', text: usd(mi.net) }), h('td', { text: mi.pool ? usd(mi.pool) : '' }),
      h('td', {}, add), h('td', { text: usd(mi.spent) }), h('td', { class: mi.budgetEnd < 0 ? 'contrib-bad' : '', text: usd(mi.budgetEnd) }),
      h('td', {}, h('button', { class: 'btn btn-s', type: 'button', text: 'Сохранить', onclick: () => acctDo(() => call(studio.acct.month({
        month: mi.month, income: Number(income.value) || 0, expenses: Number(expenses.value) || 0, budgetAdd: add.value === '' ? undefined : Number(add.value),
      })), 'Сохранено') })),
    );
  });
  box.append(h('div', { class: 'card' },
    h('h2', { text: 'Финансы студии' }),
    h('p', { class: 'muted small', text: 'Расходы: налоги, зарплаты, инструменты. Первый месяц, где доход больше расходов, становится точкой выхода в плюс: ставки x3, ретро-бонус, пул ' + w.poolPct + '% чистого дохода. "Отложено": пусто значит ' + w.budgetMonthly + ' $.' }),
    table(['Месяц', 'Доход, $', 'Расходы, $', 'Чистый', 'Пул', 'Отложено, $', 'Потрачено', 'Остаток бюджета', ''], rows, 'acct-fin'),
  ));
}

// ---------- бонусы ----------

function acctBonus(box, r) {
  box.append(h('div', { class: 'card' },
    h('h2', { text: 'Ретро-бонус и долг' }),
    h('p', { class: 'muted small', text: r.forecast
      ? 'Прогноз: как если бы студия вышла в плюс в следующем месяце. k = ' + r.weights.retroMin + ' + ' + (r.weights.retroMax - r.weights.retroMin) + ' x (доля / самая большая доля). Долг здесь без множителя, x' + r.weights.debtMult + ' появится после выхода в плюс.'
      : 'Точка отсчёта: ' + monthTitle(r.plus + '-01') + '. Ретро-бонус = заработанное до точки (без долга) x (k - 1). Долг до точки x' + r.weights.debtMult + ', даже уже возвращённый.' }),
    table(['Участник', 'Баллы до точки', 'Доля', 'k', 'Заработано', 'База', 'Ретро-бонус', 'Выплачено', 'Осталось', 'Долг записан', 'По долгу к выплате', 'Выплачено', 'Осталось', 'Аванс'],
      r.bonuses.map((b) => h('tr', { class: b.left ? 'is-blocked' : '' },
        h('td', {}, memberName(b.user), b.left ? h('span', { class: 'muted small', text: ' ушёл' }) : null),
        h('td', { text: pts(b.pointsBefore) }), h('td', { text: pct(b.share) }), h('td', { text: b.k ? b.k.toFixed(2).replace('.', ',') : '' }),
        h('td', { text: usd(b.earnedBefore) }), h('td', { text: usd(b.base) }), h('td', { class: 'strong', text: usd(b.retro) }),
        h('td', { text: usd(b.retroPaid) }), h('td', { text: r.forecast ? '' : usd(b.retroLeft) }),
        h('td', { text: usd(b.debtRecorded) }), h('td', { text: usd(b.debtTarget) }), h('td', { text: usd(b.debtPaid) }),
        h('td', { class: b.debtLeft > 0 ? 'contrib-bad' : '', text: usd(b.debtLeft) }), h('td', { text: b.advance ? usd(b.advance) : '' }),
      ))),
  ));
}

// ---------- участники ----------

function acctMembers(box, r) {
  box.append(h('div', { class: 'card' },
    h('h2', { text: 'Участники' }),
    h('p', { class: 'muted small', text: 'Начало: день принятия правил (или регистрации). Первый месяц тестовый, деньги с даты "Оплата с". Дату ухода ставьте, если человек ушёл до выхода студии в плюс: ретро-бонуса у него не будет, только бонус за участие.' }),
    table(['Участник', 'Начало', 'Оплата с', 'Ушёл', ''], r.members.map((m) => {
      const start = h('input', { type: 'date', value: m.start });
      const left = h('input', { type: 'date', value: m.leftOn || '' });
      return h('tr', {}, h('td', { text: m.name }), h('td', {}, start), h('td', { text: dayShort(m.payFrom) + ' ' + m.payFrom.slice(0, 4) }), h('td', {}, left),
        h('td', {}, h('button', { class: 'btn btn-s', type: 'button', text: 'Сохранить', onclick: () => acctDo(() => call(studio.acct.member(m.id, start.value, left.value)), 'Сохранено') })));
    })),
  ));
}

// ---------- веса ----------

const WEIGHT_FIELDS = [
  ['Баллы', [['ptsLong', 'Длинный ролик (от 2 минут)'], ['ptsShort', 'Шортс'], ['ptsPost', 'Пост'], ['ptsRefs100', '100 переходов'], ['ptsBugs5', '5 визуальных багов']]],
  ['Просмотры', [['rate', 'Ставка до плюса, $'], ['rateAfter', 'Ставка после плюса, $'], ['divYouTube', 'YouTube: за сколько просмотров'], ['divOther', 'Остальные: за сколько'], ['capViews', 'Потолок просмотров']]],
  ['Переходы', [['refRate', 'За 100 до плюса, $'], ['refRateAfter', 'За 100 после плюса, $']]],
  ['Бюджет и бонусы', [['budgetMonthly', 'Откладывать в месяц, $'], ['poolPct', 'Пул, % чистого дохода'], ['retroMin', 'Ретро-бонус от x'], ['retroMax', 'Ретро-бонус до x'], ['debtMult', 'Долг при плюсе x']]],
  ['Старт', [['payStart', 'Оплата не раньше'], ['testMonths', 'Тестовый период, месяцев']]],
];

function acctWeights(box, r) {
  const inputs = {};
  const groups = WEIGHT_FIELDS.map(([title, fields]) => h('div', { class: 'acct-wgroup' }, h('h3', { text: title }),
    ...fields.map(([k, label]) => {
      const el = k === 'payStart' ? h('input', { type: 'date', value: r.weights[k] }) : numInput(r.weights[k], k.startsWith('div') || k === 'capViews' || k === 'testMonths' ? '1' : '0.001');
      inputs[k] = el;
      return h('label', { class: 'field' }, h('span', { text: label }), el);
    })));
  box.append(h('div', { class: 'card' },
    h('h2', { text: 'Веса и ставки' }),
    h('p', { class: 'muted small', text: 'Меняются в одном месте и пересчитывают все открытые месяцы. Закрытые месяцы не меняются.' }),
    h('div', { class: 'acct-weights' }, ...groups),
    h('div', { class: 'row gap-s' },
      h('button', { class: 'btn btn-accent', type: 'button', text: 'Сохранить', onclick: () => acctDo(() => {
        const w = {};
        for (const [k, el] of Object.entries(inputs)) w[k] = k === 'payStart' ? el.value : Number(el.value);
        return call(studio.acct.weights(w));
      }, 'Веса сохранены') }),
      h('button', { class: 'btn', type: 'button', text: 'Как в правилах', onclick: async () => {
        if (await modal({ title: 'Вернуть веса из правил?', body: 'Все ставки и баллы станут как в правилах версии 1.', ok: 'Вернуть' })) acctDo(() => call(studio.acct.weights(AC.data.defaults)), 'Веса из правил');
      } }),
    ),
  ));
}
