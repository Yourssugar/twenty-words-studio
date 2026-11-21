'use strict';
// Вкладка "Команда" в разделе "Вклад": баллы по дням и месяцам, доли, сравнение
// участников и остаток бюджета студии. Баллы и бюджет видят все. Свои деньги
// участник видит только сам (сервер отдаёт только его строки).
//
// Графики рисуются здесь же в SVG, без библиотек: политика CSP приложения не
// пускает внешние скрипты. Цвет закреплён за участником по порядку прихода в
// команду и не меняется от месяца к месяцу.

const TM = {
  data: null,
  month: '',
  resizeTimer: 0,
};

// Палитра проверена на контраст и различимость при дальтонизме на фонах всех тем.
const TEAM_COLORS = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#0ca30c', '#9085e9', '#e66767'];
const TEAM_OTHER = '#7d808a';

const KINDS = [
  ['long', 'Длинные'],
  ['short', 'Шортс'],
  ['post', 'Посты'],
  ['refs', 'Переходы'],
  ['bugs', 'Баги'],
  ['vuln', 'Уязвимости'],
  ['idea', 'Идеи'],
];

async function loadTeam() {
  TM.data = await call(studio.team.stats());
  const months = TM.data.months.map((m) => m.month);
  if (!TM.month || !months.includes(TM.month)) TM.month = months.includes(TM.data.current) ? TM.data.current : months[months.length - 1] || TM.data.current;
}

// ---------- данные для графиков ----------

function teamSeries() {
  const d = TM.data;
  const list = d.members.map((m, i) => ({ id: m.id, name: m.name, leftOn: m.leftOn, color: i < TEAM_COLORS.length ? TEAM_COLORS[i] : TEAM_OTHER, me: S.me && m.id === S.me.id }));
  return list;
}

function pointsBy(filter) {
  const out = new Map();
  for (const p of TM.data.points) {
    if (!filter(p)) continue;
    out.set(p.user, (out.get(p.user) || 0) + p.points);
  }
  return out;
}

function prevMonth(m) {
  let [y, mm] = m.split('-').map(Number);
  mm -= 1;
  if (mm === 0) { mm = 12; y -= 1; }
  return y + '-' + String(mm).padStart(2, '0');
}

function daysIn(m) {
  const [y, mm] = m.split('-').map(Number);
  return new Date(y, mm, 0).getDate();
}

const shortMonth = (m) => {
  const [y, mm] = m.split('-').map(Number);
  return MONTHS[mm - 1].slice(0, 3) + (mm === 1 ? ' ' + String(y).slice(2) : '');
};

// ---------- вкладка ----------

function renderTeam(box) {
  if (!TM.data) {
    box.append(skeleton('tiles'));
    loadTeam().then(() => renderContrib(), (err) => {
      box.innerHTML = '';
      box.append(h('div', { class: 'card muted', text: errText(err.code) }));
    });
    return;
  }
  const d = TM.data;
  const series = teamSeries();
  if (!series.length) {
    box.append(h('div', { class: 'card muted', text: 'В команде пока нет участников. Основатели в баллах не участвуют.' }));
    return;
  }
  const months = d.months.map((m) => m.month);
  const idx = months.indexOf(TM.month);
  const go = (i) => { TM.month = months[i]; renderContrib(); };

  box.append(h('div', { class: 'team-bar' },
    h('button', { class: 'btn btn-s', type: 'button', text: 'Назад', disabled: idx <= 0, onclick: () => go(idx - 1) }),
    h('div', { class: 'team-month', text: monthTitle(TM.month + '-01') + (TM.month === d.current ? ', идёт сейчас' : '') }),
    h('button', { class: 'btn btn-s', type: 'button', text: 'Вперёд', disabled: idx < 0 || idx >= months.length - 1, onclick: () => go(idx + 1) }),
    h('div', { class: 'grow' }),
    h('button', { class: 'btn btn-s', type: 'button', text: 'Обновить', onclick: async () => {
      try {
        await loadTeam();
        renderContrib();
      } catch (err) {
        toast(errText(err.code));
      }
    } }),
  ));

  box.append(teamTiles(series));

  const legend = teamLegend(series);
  const daily = h('div', { class: 'chart' });
  box.append(h('div', { class: 'card' },
    h('div', { class: 'row between wrap gap-s' }, h('h2', { text: 'Баллы по дням' }), legend),
    daily,
    h('p', { class: 'muted small', text: 'Баллы из отчёта стоят на дне выхода публикации или на последнем дне периода аналитики и появляются, когда основатель подтвердит отчёт. Переходы по ссылкам считаются сами.' + (d.waiting ? ' У вас на проверке: ' + d.waiting + '.' : '') }),
  ));

  box.append(teamShares(series));

  const monthly = h('div', { class: 'chart' });
  box.append(h('div', { class: 'card' },
    h('div', { class: 'row between wrap gap-s' }, h('h2', { text: 'Баллы по месяцам' }), teamLegend(series)),
    monthly,
    h('p', { class: 'muted small', text: 'Нажмите на месяц, чтобы открыть его.' }),
  ));

  const budget = h('div', { class: 'chart' });
  box.append(h('div', { class: 'card' },
    h('h2', { text: 'Остаток бюджета студии' }),
    budget,
    h('p', { class: 'muted small', text: 'Каждый месяц в бюджет откладывается ' + usd(d.months.length ? d.months[d.months.length - 1].budgetAdd : 80) + '. Из него идут все выплаты команде. Остаток переходит на следующий месяц.' }),
  ));

  if (d.mine) box.append(teamMoney());
  else box.append(h('div', { class: 'card muted small', text: 'Основатели в баллах и выплатах не участвуют. Деньги участников во вкладке "Учёт".' }));

  // Ширину графика узнаём, когда блок уже на странице.
  requestAnimationFrame(() => drawTeamCharts(daily, monthly, budget, series));
}

function drawTeamCharts(daily, monthly, budget, series) {
  if (!daily.isConnected) return;
  const d = TM.data;
  const n = daysIn(TM.month);
  const days = Array.from({ length: n }, (_, i) => TM.month + '-' + String(i + 1).padStart(2, '0'));
  const byDay = new Map();
  for (const p of d.points) {
    if (!p.day.startsWith(TM.month)) continue;
    const k = p.day + ':' + p.user;
    byDay.set(k, (byDay.get(k) || 0) + p.points);
  }
  stackedBars(daily, {
    cats: days,
    label: (day, i) => (i === 0 || (i + 1) % 5 === 0 ? String(i + 1) : ''),
    series,
    value: (day, s) => byDay.get(day + ':' + s.id) || 0,
    tipTitle: (day) => dayShort(day) + (day === d.today ? ', сегодня' : ''),
    mark: (day) => day === d.today,
    height: 200,
  });

  const months = d.months.map((m) => m.month);
  const byMonth = new Map();
  for (const p of d.points) {
    const k = p.day.slice(0, 7) + ':' + p.user;
    byMonth.set(k, (byMonth.get(k) || 0) + p.points);
  }
  stackedBars(monthly, {
    cats: months,
    label: (m) => shortMonth(m),
    series,
    value: (m, s) => byMonth.get(m + ':' + s.id) || 0,
    tipTitle: (m) => monthTitle(m + '-01'),
    mark: (m) => m === TM.month,
    onPick: (m) => { TM.month = m; renderContrib(); },
    height: 180,
    maxBar: 56,
  });

  lineChart(budget, {
    cats: months,
    label: (m) => shortMonth(m),
    value: (m) => d.months.find((x) => x.month === m).budgetEnd,
    tip: (m) => {
      const x = d.months.find((y) => y.month === m);
      return [
        [monthTitle(m + '-01'), ''],
        ['На начало', usd(x.budgetStart)],
        ['Отложено', '+' + usd(x.budgetAdd)],
        ['Выплачено', usd(x.spent)],
        ['Остаток', usd(x.budgetEnd)],
      ];
    },
    format: usd,
    axis: (v) => Math.round(v).toLocaleString('ru-RU') + ' $',
    mark: (m) => m === TM.month,
    color: TEAM_COLORS[0],
    height: 170,
  });
}

window.addEventListener('resize', () => {
  clearTimeout(TM.resizeTimer);
  TM.resizeTimer = setTimeout(() => {
    if (typeof CB !== 'undefined' && CB.tab === 'team' && TM.data && document.querySelector('.view-contrib .chart')) renderContrib();
  }, 200);
});

function teamTiles(series) {
  const d = TM.data;
  const cur = pointsBy((p) => p.day.startsWith(TM.month));
  const prev = pointsBy((p) => p.day.startsWith(prevMonth(TM.month)));
  const sum = (m) => [...m.values()].reduce((a, b) => a + b, 0);
  const total = sum(cur);
  const prevTotal = sum(prev);
  const info = d.months.find((m) => m.month === TM.month);
  const tile = (label, value, sub) => h('div', { class: 'tile' }, h('div', { class: 'tile-label', text: label }), h('div', { class: 'tile-value', text: value }), sub ? h('div', { class: 'tile-sub', text: sub }) : null);
  const tiles = [tile('Баллы команды', pts(total), 'в прошлом месяце ' + pts(prevTotal))];
  if (d.mine) {
    const mine = cur.get(S.me.id) || 0;
    tiles.push(tile('Мои баллы', pts(mine), total ? 'доля ' + pct(mine / total) : 'долей пока нет'));
  }
  if (info) tiles.push(tile('Бюджет студии', usd(info.budgetEnd), info.month === d.current ? 'остаток на сегодня' : 'остаток на конец месяца'));
  tiles.push(tile('Выход в плюс', d.plus ? monthTitle(d.plus + '-01') : 'ещё нет', d.plus ? 'с него ставки x3 и пул 15%' : 'бонусы пока считаются как прогноз'));
  return h('div', { class: 'tiles' }, ...tiles);
}


function teamLegend(series) {
  return h('div', { class: 'legend' }, ...series.map((s) => h('span', { class: 'legend-item' },
    swatch(s.color),
    h('span', { text: s.name + (s.me ? ' (вы)' : '') }),
  )));
}

function swatch(color) {
  const el = h('span', { class: 'swatch' });
  el.style.background = color;
  return el;
}

function teamShares(series) {
  const d = TM.data;
  const kinds = new Map(); // user -> kind -> points
  for (const p of d.points) {
    if (!p.day.startsWith(TM.month)) continue;
    if (!kinds.has(p.user)) kinds.set(p.user, new Map());
    const k = kinds.get(p.user);
    k.set(p.kind, (k.get(p.kind) || 0) + p.points);
  }
  const cur = pointsBy((p) => p.day.startsWith(TM.month));
  const prev = pointsBy((p) => p.day.startsWith(prevMonth(TM.month)));
  const total = [...cur.values()].reduce((a, b) => a + b, 0);
  const max = Math.max(0, ...cur.values());
  const usedKinds = KINDS.filter(([k]) => [...kinds.values()].some((m) => m.get(k)));
  const rows = [...series]
    .filter((s) => cur.get(s.id) || !s.leftOn || s.leftOn >= TM.month + '-01')
    .sort((a, b) => (cur.get(b.id) || 0) - (cur.get(a.id) || 0));
  const bar = (s) => {
    const v = cur.get(s.id) || 0;
    const fill = h('span', { class: 'share-fill' });
    fill.style.width = (max ? (v / max) * 100 : 0) + '%';
    fill.style.background = s.color;
    return h('div', { class: 'share' }, h('span', { class: 'share-track' }, fill), h('span', { class: 'share-pct', text: total ? pct(v / total) : '' }));
  };
  const delta = (s) => {
    const v = (cur.get(s.id) || 0) - (prev.get(s.id) || 0);
    if (!v) return '';
    return (v > 0 ? '+' : '') + pts(v);
  };
  const body = rows.map((s) => h('tr', { class: s.me ? 'is-me' : '' },
    h('td', {}, h('span', { class: 'row gap-s' }, swatch(s.color), h('span', { text: s.name + (s.me ? ' (вы)' : '') + (s.leftOn ? ', ушёл ' + dayShort(s.leftOn) : '') }))),
    h('td', { class: 'strong', text: pts(cur.get(s.id) || 0) }),
    h('td', {}, bar(s)),
    h('td', { class: 'muted', text: delta(s) }),
    ...usedKinds.map(([k]) => h('td', { text: kinds.has(s.id) && kinds.get(s.id).get(k) ? pts(kinds.get(s.id).get(k)) : '' })),
  ));
  return h('div', { class: 'card' },
    h('h2', { text: 'Доли за месяц' }),
    total ? table(['Участник', 'Баллы', 'Доля', 'К прошлому', ...usedKinds.map(([, t]) => t)], body, 'team-table')
      : h('p', { class: 'muted', text: 'В этом месяце баллов пока нет.' }),
    h('p', { class: 'muted small', text: 'Доля считается от баллов всей команды за месяц. По долям делится бонусный пул после выхода в плюс, а по долям до него считается ретро-бонус.' }),
  );
}

function teamMoney() {
  const d = TM.data;
  const rows = d.mine.rows;
  const b = d.mine.bonus;
  const payMonth = (d.mine.payFrom || '').slice(0, 7);
  const body = [...rows].reverse().map((r) => {
    return h('tr', { class: r.month === TM.month ? 'is-me' : '' },
      h('td', { text: monthTitle(r.month + '-01') }),
      h('td', { text: pts(r.points) }),
      h('td', { class: r.testOnly ? 'muted' : '', text: r.testOnly ? (r.month < payMonth ? 'до оплаты' : 'тестовый') : usd(r.earned) }),
      h('td', { text: r.pool ? usd(r.pool) : '' }),
      h('td', { text: r.other ? usd(r.other) : '' }),
      h('td', { text: r.offset ? usd(r.offset) : '' }),
      h('td', { class: 'strong', text: usd(r.due) }),
      h('td', { text: r.paid ? usd(r.paid) : '' }),
      h('td', { class: r.unpaid > 0 ? 'contrib-bad' : 'muted', text: r.unpaid > 0 ? usd(r.unpaid) + (r.closed ? ', в долге' : '') : '' }),
    );
  });
  const facts = [];
  if (b) {
    if (b.advance > 0) facts.push(['Аванс, ещё не зачтённый', usd(b.advance)]);
    if (!b.left) facts.push([d.forecast ? 'Ретро-бонус, прогноз' : 'Ретро-бонус', usd(b.retro) + (b.retroPaid ? ', выплачено ' + usd(b.retroPaid) : '') + (d.forecast ? ' (если бы плюс был сейчас, множитель x' + pts(b.k) + ')' : ', множитель x' + pts(b.k))]);
    if (b.debtRecorded > 0) facts.push(['Долг', 'записано ' + usd(b.debtRecorded) + ', к выплате ' + usd(b.debtTarget) + ', выплачено ' + usd(b.debtPaid) + ', осталось ' + usd(b.debtLeft)]);
  }
  return h('div', { class: 'card' },
    h('h2', { text: 'Мои деньги' }),
    h('p', { class: 'muted small', text: 'Эту таблицу видите только вы и основатели.' + (d.mine.payFrom && d.mine.payFrom > d.today ? ' Деньги за работу начисляются с ' + new Date(d.mine.payFrom + 'T12:00:00').toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }) + ', до этого копятся баллы.' : '') }),
    rows.length ? table(['Месяц', 'Баллы', 'Заработано', 'Пул', 'Доплаты', 'Аванс', 'К выплате', 'Выплачено', 'Не выплачено'], body) : h('p', { class: 'muted', text: 'Начислений пока нет.' }),
    facts.length ? h('div', { class: 'team-facts' }, ...facts.map(([k, v]) => h('div', {}, h('span', { class: 'muted', text: k + ': ' }), h('span', { text: v })))) : null,
  );
}

// ---------- графики ----------

const SVG_NS = 'http://www.w3.org/2000/svg';
function sv(tag, attrs, ...kids) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) if (v !== undefined && v !== null) el.setAttribute(k, v);
  for (const c of kids) if (c) el.append(c);
  return el;
}

function niceStep(v) {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

// Шкала с круглым шагом, около пяти делений, ноль всегда на шкале.
function niceScale(lo, hi) {
  lo = Math.min(0, lo);
  hi = Math.max(0, hi);
  if (hi - lo <= 0) hi = 5;
  const step = niceStep((hi - lo) / 5);
  const a = Math.floor(lo / step) * step;
  const b = Math.ceil(hi / step) * step;
  return { lo: a, hi: b, step, ticks: Math.round((b - a) / step) };
}

// Скругление только у верхнего края столбика: низ стоит на оси.
function topRounded(x, y, w, hgt, r) {
  r = Math.min(r, w / 2, hgt);
  return `M${x},${y + hgt}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + hgt}Z`;
}

function chartTip(wrap) {
  let tip = wrap.querySelector('.chart-tip');
  if (!tip) {
    tip = h('div', { class: 'chart-tip', hidden: true });
    wrap.append(tip);
  }
  return {
    show(rows, x, y) {
      tip.innerHTML = '';
      for (const [k, v, color] of rows) {
        tip.append(h('div', { class: v === '' ? 'chart-tip-title' : 'chart-tip-row' },
          color ? swatch(color) : null,
          h('span', { text: k }),
          v !== '' ? h('b', { text: v }) : null,
        ));
      }
      tip.hidden = false;
      const ww = wrap.clientWidth;
      const tw = tip.offsetWidth;
      let left = x + 14;
      if (left + tw > ww) left = x - tw - 14;
      tip.style.left = Math.max(0, left) + 'px';
      tip.style.top = Math.max(0, y - 10) + 'px';
    },
    hide() { tip.hidden = true; },
  };
}

function stackedBars(wrap, o) {
  wrap.innerHTML = '';
  const W = Math.max(320, wrap.clientWidth);
  const H = o.height;
  const pad = { l: 40, r: 8, t: 10, b: 24 };
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  const totals = o.cats.map((c) => o.series.reduce((a, s) => a + o.value(c, s), 0));
  const sc = niceScale(0, Math.max(0, ...totals));
  const max = sc.hi;
  const step = iw / o.cats.length;
  const bw = Math.max(3, Math.min(o.maxBar || 22, step * 0.62));
  const y = (v) => pad.t + ih - (v / max) * ih;
  const svg = sv('svg', { width: W, height: H, class: 'chart-svg', role: 'img' });
  for (let i = 0; i <= sc.ticks; i++) {
    const v = sc.step * i;
    svg.append(sv('line', { x1: pad.l, x2: W - pad.r, y1: y(v), y2: y(v), class: i ? 'grid' : 'axis' }));
    svg.append(sv('text', { x: pad.l - 6, y: y(v) + 4, 'text-anchor': 'end', class: 'tick' }, document.createTextNode(pts(v))));
  }
  const tip = chartTip(wrap);
  o.cats.forEach((c, i) => {
    const cx = pad.l + step * i + step / 2;
    const x = cx - bw / 2;
    const lab = o.label(c, i);
    if (lab) svg.append(sv('text', { x: cx, y: H - 6, 'text-anchor': 'middle', class: 'tick' + (o.mark && o.mark(c) ? ' is-mark' : '') }, document.createTextNode(lab)));
    if (o.mark && o.mark(c)) svg.append(sv('rect', { x: pad.l + step * i, y: pad.t, width: step, height: ih, class: 'col-mark' }));
    let acc = 0;
    const parts = o.series.map((s) => [s, o.value(c, s)]).filter(([, v]) => v > 0);
    parts.forEach(([s, v], j) => {
      const y0 = y(acc);
      const y1 = y(acc + v);
      acc += v;
      const top = j === parts.length - 1;
      // 2 точки зазора между сегментами, чтобы соседние цвета не сливались
      const hh = Math.max(1, y0 - y1 - (j > 0 ? 2 : 0));
      const yy = y0 - (j > 0 ? 2 : 0) - hh;
      svg.append(top ? sv('path', { d: topRounded(x, yy, bw, hh, 4), fill: s.color }) : sv('rect', { x, y: yy, width: bw, height: hh, fill: s.color }));
    });
    const hit = sv('rect', { x: pad.l + step * i, y: pad.t, width: step, height: ih + pad.b, class: 'hit' + (o.onPick ? ' is-pick' : '') });
    hit.addEventListener('mousemove', (ev) => {
      const r = wrap.getBoundingClientRect();
      const rows = [[o.tipTitle(c), '']];
      for (const [s, v] of parts.slice().reverse()) rows.push([s.name, pts(v), s.color]);
      if (parts.length > 1) rows.push(['Всего', pts(totals[i])]);
      if (!parts.length) rows.push(['Баллов нет', ' ']);
      tip.show(rows, ev.clientX - r.left, ev.clientY - r.top);
    });
    hit.addEventListener('mouseleave', () => tip.hide());
    if (o.onPick) hit.addEventListener('click', () => o.onPick(c));
    svg.append(hit);
  });
  wrap.append(svg);
}

function lineChart(wrap, o) {
  wrap.innerHTML = '';
  if (!o.cats.length) {
    wrap.append(h('p', { class: 'muted', text: 'Данных пока нет.' }));
    return;
  }
  const W = Math.max(320, wrap.clientWidth);
  const H = o.height;
  const pad = { l: 56, r: 12, t: 12, b: 24 };
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  const vals = o.cats.map(o.value);
  const sc = niceScale(Math.min(...vals), Math.max(...vals));
  const lo = sc.lo;
  const hi = sc.hi;
  const step = iw / o.cats.length;
  const xAt = (i) => pad.l + step * i + step / 2;
  const y = (v) => pad.t + ih - ((v - lo) / (hi - lo || 1)) * ih;
  const svg = sv('svg', { width: W, height: H, class: 'chart-svg', role: 'img' });
  for (let i = 0; i <= sc.ticks; i++) {
    const v = lo + sc.step * i;
    svg.append(sv('line', { x1: pad.l, x2: W - pad.r, y1: y(v), y2: y(v), class: Math.abs(v) < 1e-9 ? 'axis' : 'grid' }));
    svg.append(sv('text', { x: pad.l - 6, y: y(v) + 4, 'text-anchor': 'end', class: 'tick' }, document.createTextNode(o.axis ? o.axis(v) : o.format(v))));
  }
  const labelEvery = Math.ceil(o.cats.length / Math.max(1, Math.floor(iw / 48)));
  o.cats.forEach((c, i) => {
    if (i % labelEvery === 0 || i === o.cats.length - 1) svg.append(sv('text', { x: xAt(i), y: H - 6, 'text-anchor': 'middle', class: 'tick' + (o.mark(c) ? ' is-mark' : '') }, document.createTextNode(o.label(c))));
  });
  svg.append(sv('path', { d: vals.map((v, i) => (i ? 'L' : 'M') + xAt(i) + ',' + y(v)).join(''), fill: 'none', stroke: o.color, 'stroke-width': 2, 'stroke-linejoin': 'round' }));
  const cross = sv('line', { x1: 0, x2: 0, y1: pad.t, y2: pad.t + ih, class: 'crosshair', visibility: 'hidden' });
  svg.append(cross);
  const dots = vals.map((v, i) => sv('circle', { cx: xAt(i), cy: y(v), r: o.mark(o.cats[i]) ? 5 : 4, fill: o.color, class: 'dot' }));
  dots.forEach((d) => svg.append(d));
  const tip = chartTip(wrap);
  o.cats.forEach((c, i) => {
    const hit = sv('rect', { x: pad.l + step * i, y: pad.t, width: step, height: ih + pad.b, class: 'hit' });
    hit.addEventListener('mousemove', (ev) => {
      cross.setAttribute('x1', xAt(i));
      cross.setAttribute('x2', xAt(i));
      cross.setAttribute('visibility', 'visible');
      const r = wrap.getBoundingClientRect();
      tip.show(o.tip(c), ev.clientX - r.left, ev.clientY - r.top);
    });
    hit.addEventListener('mouseleave', () => { cross.setAttribute('visibility', 'hidden'); tip.hide(); });
    svg.append(hit);
  });
  wrap.append(svg);
}
