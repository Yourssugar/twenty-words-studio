'use strict';
// Главная: граф студии по мотивам A.C.EON Core. В центре студия, вокруг ветки
// (Идеи, Реклама, Материалы и запасные). Ветки и карточки лежат на сервере,
// изменения приходят всем через WebSocket. Анимация спокойная: лёгкое
// покачивание, а ветка под курсором сворачивается в кружок.

const B = {
  branches: [],
  cards: new Map(), // id -> карточка
  open: null, // id открытой ветки
  hover: null,
  loaded: false,
  expanded: new Set(), // раскрытые карточки в списке
};

const G = {
  canvas: null,
  ctx: null,
  w: 0,
  h: 0,
  dpr: 1,
  running: false,
  raf: 0,
  t0: performance.now(),
  shift: 0, // сдвиг графа влево, когда открыт список карточек
  nodes: new Map(), // id ветки -> узел с точками кластера
  mouse: null,
};

// ---------- данные ----------

async function loadBoard() {
  try {
    const data = await call(studio.board.get());
    B.branches = data.branches;
    B.cards = new Map(data.cards.map((c) => [c.id, c]));
    B.loaded = true;
    syncNodes();
    renderDrawer();
  } catch (err) {
    if (err.code !== 'unauthorized') toast(errText(err.code));
  }
}

function cardsOf(branch) {
  return [...B.cards.values()].filter((c) => c.branch === branch).sort((a, b) => b.created - a.created);
}

function branchById(id) {
  return B.branches.find((b) => b.id === id);
}

studio.chat.onEvent((ev) => {
  if (ev.t === 'ready') {
    loadBoard();
    return;
  }
  if (ev.t === 'userGone' && ev.deleted) {
    for (const [id, c] of B.cards) if (c.author === ev.user) B.cards.delete(id);
    renderDrawer();
    return;
  }
  if (ev.t !== 'board') return;
  if (ev.op === 'card') B.cards.set(ev.card.id, ev.card);
  else if (ev.op === 'cardGone') B.cards.delete(ev.id);
  else if (ev.op === 'branch') {
    const i = B.branches.findIndex((b) => b.id === ev.branch.id);
    if (i >= 0) B.branches[i] = ev.branch;
  }
  renderDrawer();
  if (B.hover) showTip(B.hover);
});

// ---------- геометрия ----------

// Детерминированный генератор: кластер ветки всегда выглядит одинаково.
function rng(seed) {
  let x = 2166136261;
  for (const ch of seed) x = Math.imul(x ^ ch.charCodeAt(0), 16777619);
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return ((x >>> 0) % 100000) / 100000;
  };
}

function makeCluster(id) {
  const r = rng(id);
  const n = 18;
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = r() * Math.PI * 2;
    const d = 18 + Math.sqrt(r()) * 58;
    pts.push({ x: Math.cos(a) * d * 1.15, y: Math.sin(a) * d * 0.85, ph: r() * 6.28, sp: 0.4 + r() * 0.5 });
  }
  // Каждая точка соединяется с двумя ближайшими: получается сетка, как на сайте.
  const edges = new Set();
  pts.forEach((p, i) => {
    const near = pts
      .map((q, j) => ({ j, d: (p.x - q.x) ** 2 + (p.y - q.y) ** 2 }))
      .filter((o) => o.j !== i)
      .sort((a, b) => a.d - b.d)
      .slice(0, 2);
    for (const o of near) edges.add(i < o.j ? i + ':' + o.j : o.j + ':' + i);
  });
  // Положение каждой точки в свёрнутом виде: ровное кольцо.
  pts.forEach((p, i) => {
    const a = (i / n) * Math.PI * 2;
    p.cx = Math.cos(a) * 30;
    p.cy = Math.sin(a) * 30;
  });
  return { pts, edges: [...edges].map((e) => e.split(':').map(Number)), fold: 0, ph: r() * 6.28 };
}

function syncNodes() {
  for (const b of B.branches) if (!G.nodes.has(b.id)) G.nodes.set(b.id, makeCluster(b.id));
}

function layout() {
  const cx = G.w / 2 - G.shift;
  const cy = G.h / 2 + 10;
  const R = Math.max(150, Math.min(300, Math.min(G.w - G.shift * 2, G.h) * 0.33));
  const n = B.branches.length || 1;
  return { cx, cy, R, n };
}

function branchPos(i, t, L) {
  const a = -Math.PI / 2 + (i / L.n) * Math.PI * 2;
  const node = G.nodes.get(B.branches[i].id);
  const sway = node ? node.ph : 0;
  return {
    x: L.cx + Math.cos(a) * L.R * 1.25 + Math.sin(t * 0.35 + sway) * 4,
    y: L.cy + Math.sin(a) * L.R + Math.cos(t * 0.3 + sway) * 4,
  };
}

function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

// ---------- рисование ----------

function resize() {
  const c = G.canvas;
  const r = c.parentElement.getBoundingClientRect();
  G.dpr = window.devicePixelRatio || 1;
  G.w = r.width;
  G.h = r.height;
  c.width = Math.round(r.width * G.dpr);
  c.height = Math.round(r.height * G.dpr);
  c.style.width = r.width + 'px';
  c.style.height = r.height + 'px';
}

function frame(now) {
  if (!G.running) return;
  G.raf = requestAnimationFrame(frame);
  if (document.hidden) return;
  const t = (now - G.t0) / 1000;
  const ctx = G.ctx;
  const targetShift = B.open ? Math.min(200, G.w * 0.16) : 0;
  G.shift += (targetShift - G.shift) * 0.12;

  ctx.setTransform(G.dpr, 0, 0, G.dpr, 0, 0);
  ctx.clearRect(0, 0, G.w, G.h);
  if (!B.branches.length) return;
  const L = layout();
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#e9a23b';

  // свечение центра
  const glow = ctx.createRadialGradient(L.cx, L.cy, 10, L.cx, L.cy, 190);
  glow.addColorStop(0, 'rgba(255,255,255,.16)');
  glow.addColorStop(0.35, 'rgba(255,255,255,.05)');
  glow.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(L.cx - 200, L.cy - 200, 400, 400);

  const pos = B.branches.map((b, i) => branchPos(i, t, L));

  // нити от центра к веткам
  B.branches.forEach((b, i) => {
    const p = pos[i];
    const mx = (L.cx + p.x) / 2;
    const my = (L.cy + p.y) / 2;
    const dx = p.x - L.cx;
    const dy = p.y - L.cy;
    const qx = mx - dy * 0.12;
    const qy = my + dx * 0.12;
    const on = B.hover === b.id || B.open === b.id;
    ctx.strokeStyle = hexA(b.color, on ? 0.75 : 0.38);
    ctx.lineWidth = on ? 1.6 : 1.1;
    ctx.beginPath();
    ctx.moveTo(L.cx, L.cy);
    ctx.quadraticCurveTo(qx, qy, p.x, p.y);
    ctx.stroke();
    // редкая искра вдоль нити
    const k = ((t * 0.12 + i * 0.17) % 1);
    if (k < 0.85) {
      const u = k / 0.85;
      const ex = (1 - u) * (1 - u) * L.cx + 2 * (1 - u) * u * qx + u * u * p.x;
      const ey = (1 - u) * (1 - u) * L.cy + 2 * (1 - u) * u * qy + u * u * p.y;
      ctx.fillStyle = hexA(b.color, 0.55 * Math.sin(u * Math.PI));
      ctx.beginPath();
      ctx.arc(ex, ey, 1.8, 0, Math.PI * 2);
      ctx.fill();
    }
  });

  // кластеры веток
  B.branches.forEach((b, i) => {
    const node = G.nodes.get(b.id);
    if (!node) return;
    const p = pos[i];
    const target = B.hover === b.id ? 1 : 0;
    node.fold += (target - node.fold) * 0.14;
    const f = node.fold * node.fold * (3 - 2 * node.fold);
    const pts = node.pts.map((q) => {
      const sx = q.x + Math.sin(t * q.sp + q.ph) * 2.2;
      const sy = q.y + Math.cos(t * q.sp * 0.9 + q.ph) * 2.2;
      return { x: p.x + sx + (q.cx - sx) * f, y: p.y + sy + (q.cy - sy) * f };
    });
    const count = cardsOf(b.id).length;
    const empty = count === 0;
    const base = empty ? 0.22 : 0.4;
    // туманное пятно ветки
    const fog = ctx.createRadialGradient(p.x, p.y, 4, p.x, p.y, 95);
    fog.addColorStop(0, hexA(b.color, empty ? 0.07 : 0.13));
    fog.addColorStop(1, hexA(b.color, 0));
    ctx.fillStyle = fog;
    ctx.fillRect(p.x - 100, p.y - 100, 200, 200);

    ctx.strokeStyle = hexA(b.color, base + f * 0.35);
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    for (const [a, c] of node.edges) {
      ctx.moveTo(pts[a].x, pts[a].y);
      ctx.lineTo(pts[c].x, pts[c].y);
    }
    ctx.stroke();
    ctx.fillStyle = hexA(b.color, empty ? 0.5 : 0.85);
    for (const q of pts) {
      ctx.beginPath();
      ctx.arc(q.x, q.y, 1.5, 0, Math.PI * 2);
      ctx.fill();
    }
    // уголки-рамка вокруг ветки под курсором
    if (f > 0.05) {
      const s = 50;
      const l = 14;
      ctx.strokeStyle = hexA(b.color, 0.8 * f);
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        ctx.moveTo(p.x + sx * s, p.y + sy * (s - l));
        ctx.lineTo(p.x + sx * s, p.y + sy * s);
        ctx.lineTo(p.x + sx * (s - l), p.y + sy * s);
      }
      ctx.stroke();
    }

    // подписи
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '600 13px "Segoe UI", system-ui, sans-serif';
    ctx.letterSpacing = '1px';
    ctx.fillStyle = empty ? 'rgba(232,230,225,.55)' : 'rgba(240,238,233,.95)';
    ctx.shadowColor = 'rgba(0,0,0,.8)';
    ctx.shadowBlur = 6;
    ctx.fillText(b.title.toUpperCase(), p.x, p.y);
    ctx.font = '10.5px Consolas, "Cascadia Mono", monospace';
    ctx.letterSpacing = '1.5px';
    ctx.fillStyle = hexA(b.color, empty ? 0.45 : 0.8);
    const sub = (b.note ? shortNote(b.note) + ' · ' : '') + count;
    ctx.fillText(sub.toUpperCase(), p.x, p.y + 64);
    ctx.shadowBlur = 0;
    ctx.letterSpacing = '0px';
    b._x = p.x;
    b._y = p.y;
  });

  // центр
  ctx.fillStyle = 'rgba(18,19,23,.9)';
  ctx.strokeStyle = 'rgba(255,255,255,.28)';
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.arc(L.cx, L.cy, 44, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.strokeStyle = hexA(accent.startsWith('#') ? accent : '#e9a23b', 0.35);
  ctx.setLineDash([2, 5]);
  ctx.beginPath();
  ctx.arc(L.cx, L.cy, 54 + Math.sin(t * 0.6) * 1.5, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.textAlign = 'center';
  ctx.fillStyle = '#f2f0eb';
  ctx.font = '700 12.5px "Segoe UI", system-ui, sans-serif';
  ctx.fillText('TWENTY WORDS', L.cx, L.cy - 5);
  ctx.font = '9.5px Consolas, monospace';
  ctx.letterSpacing = '2px';
  ctx.fillStyle = 'rgba(232,230,225,.6)';
  ctx.fillText('STUDIO', L.cx, L.cy + 11);
  ctx.letterSpacing = '0px';
}

function shortNote(s) {
  return s.length > 26 ? s.slice(0, 24).trim() + '...' : s;
}

// ---------- мышь и подсказка ----------

function branchAt(x, y) {
  let best = null;
  let bd = 78 * 78;
  for (const b of B.branches) {
    if (b._x === undefined) continue;
    const d = (b._x - x) ** 2 + (b._y - y) ** 2;
    if (d < bd) {
      bd = d;
      best = b.id;
    }
  }
  return best;
}

function showTip(id) {
  const tip = $('home-tip');
  const b = branchById(id);
  if (!b || b._x === undefined) {
    tip.hidden = true;
    return;
  }
  const list = cardsOf(id);
  tip.innerHTML = '';
  tip.style.setProperty('--c', b.color);
  tip.append(
    h('div', { class: 'tip-kind', text: 'ветка' }),
    h('div', { class: 'tip-title', text: b.title }),
    h('div', { class: 'tip-row' }, h('span', { text: 'карточек' }), h('b', { text: String(list.length) })),
    h('div', { class: 'tip-row' }, h('span', { text: 'последняя' }), h('b', { text: list.length ? dayLabel(list[0].created) : 'пусто' })),
    b.note ? h('div', { class: 'tip-note', text: b.note }) : null,
    h('div', { class: 'tip-go', text: 'клик: открыть ветку' }),
  );
  tip.hidden = false;
  const box = tip.getBoundingClientRect();
  let x = b._x + 70;
  if (x + box.width > G.w - 10) x = b._x - 70 - box.width;
  const y = Math.max(10, Math.min(G.h - box.height - 10, b._y - box.height / 2));
  tip.style.left = x + 'px';
  tip.style.top = y + 'px';
}

function hideTip() {
  $('home-tip').hidden = true;
}

function onMove(e) {
  const r = G.canvas.getBoundingClientRect();
  const id = branchAt(e.clientX - r.left, e.clientY - r.top);
  if (id !== B.hover) {
    B.hover = id;
    G.canvas.style.cursor = id ? 'pointer' : 'default';
    if (id) showTip(id);
    else hideTip();
  }
}

function onLeave() {
  B.hover = null;
  hideTip();
}

function onClick(e) {
  const r = G.canvas.getBoundingClientRect();
  const id = branchAt(e.clientX - r.left, e.clientY - r.top);
  if (id) openBranch(id);
  else if (B.open) closeBranch();
}

// ---------- список карточек ветки ----------

function openBranch(id) {
  B.open = id;
  B.expanded.clear();
  hideTip();
  renderDrawer();
}

function closeBranch() {
  B.open = null;
  renderDrawer();
}

function canEdit(c) {
  return S.me && (c.author === S.me.id || S.me.role === 'admin');
}

function renderDrawer() {
  $('home-count').textContent = B.loaded ? 'веток: ' + B.branches.length + ' · карточек: ' + B.cards.size : '';
  const box = $('home-drawer');
  const b = B.open && branchById(B.open);
  if (!b) {
    box.hidden = true;
    B.open = null;
    return;
  }
  box.hidden = false;
  box.style.setProperty('--c', b.color);
  box.innerHTML = '';
  const head = h('div', { class: 'drawer-head' },
    h('div', { class: 'grow' }, h('div', { class: 'drawer-title', text: b.title }), b.note ? h('div', { class: 'muted small', text: b.note }) : null),
    h('button', { class: 'btn btn-s', text: 'Закрыть', onclick: closeBranch }),
  );
  const tools = h('div', { class: 'row gap-s drawer-tools' },
    h('button', { class: 'btn btn-accent btn-s', text: 'Добавить карточку', onclick: () => editCard(null, b.id) }),
    S.me && S.me.role === 'admin' ? h('button', { class: 'btn btn-s', text: 'Изменить ветку', onclick: () => editBranch(b) }) : null,
  );
  const list = h('div', { class: 'drawer-list' });
  const cards = cardsOf(b.id);
  if (!cards.length) list.append(h('div', { class: 'drawer-empty muted', text: 'Пока пусто. Добавьте первую карточку.' }));
  for (const c of cards) {
    const u = S.users.get(c.author) || { name: 'участник' };
    const open = B.expanded.has(c.id);
    const item = h('div', { class: 'bcard' + (open ? ' is-open' : '') },
      h('button', { class: 'bcard-head', onclick: () => { open ? B.expanded.delete(c.id) : B.expanded.add(c.id); renderDrawer(); } },
        avatar(u, 22),
        h('div', { class: 'grow' }, h('div', { class: 'bcard-title', text: c.title }), h('div', { class: 'bcard-meta', text: u.name + ' · ' + dayLabel(c.created) + (c.updated > c.created + 1000 ? ' · изменено' : '') })),
      ),
      open ? h('div', { class: 'bcard-body' }, c.body ? h('div', { class: 'msg-text' }, linkify(c.body)) : h('div', { class: 'muted small', text: 'Без описания.' })) : null,
      open && canEdit(c) ? h('div', { class: 'row gap-s bcard-actions' },
        h('button', { class: 'btn btn-s', text: 'Изменить', onclick: () => editCard(c, b.id) }),
        h('button', { class: 'btn btn-s btn-danger-ghost', text: 'Удалить', onclick: () => deleteCard(c) }),
      ) : null,
    );
    list.append(item);
  }
  box.append(head, tools, list);
}

async function editCard(card, branch) {
  const title = h('input', { maxlength: '80', placeholder: 'Коротко: о чём карточка' });
  const body = h('textarea', { rows: '8', maxlength: '4000', placeholder: 'Подробно: что, зачем, ссылки' });
  title.value = card ? card.title : '';
  body.value = card ? card.body : '';
  const form = h('div', {}, h('label', { class: 'field' }, h('span', { text: 'Заголовок' }), title), h('label', { class: 'field' }, h('span', { text: 'Текст' }), body));
  setTimeout(() => title.focus(), 30);
  if (!(await modal({ title: card ? 'Изменить карточку' : 'Новая карточка', body: form, ok: 'Сохранить' }))) return;
  try {
    const saved = card
      ? await call(studio.board.edit(card.id, title.value, body.value))
      : await call(studio.board.add(branch, title.value, body.value));
    B.cards.set(saved.id, saved);
    B.expanded.add(saved.id);
    renderDrawer();
  } catch (err) {
    toast(errText(err.code));
  }
}

async function deleteCard(c) {
  if (!(await modal({ title: 'Удалить карточку?', body: '«' + c.title + '» исчезнет у всех.', ok: 'Удалить', danger: true }))) return;
  try {
    await call(studio.board.remove(c.id));
    B.cards.delete(c.id);
    renderDrawer();
  } catch (err) {
    toast(errText(err.code));
  }
}

async function editBranch(b) {
  const title = h('input', { maxlength: '32' });
  const note = h('input', { maxlength: '120', placeholder: 'одна строка: для чего ветка' });
  title.value = b.title;
  note.value = b.note;
  const form = h('div', {}, h('label', { class: 'field' }, h('span', { text: 'Название' }), title), h('label', { class: 'field' }, h('span', { text: 'Описание' }), note));
  if (!(await modal({ title: 'Ветка', body: form, ok: 'Сохранить' }))) return;
  try {
    const saved = await call(studio.board.branch(b.id, title.value, note.value));
    Object.assign(b, saved);
    renderDrawer();
  } catch (err) {
    toast(errText(err.code));
  }
}

// ---------- вход и выход со страницы ----------

function openHome() {
  if (!G.canvas) {
    G.canvas = $('home-canvas');
    G.ctx = G.canvas.getContext('2d');
    G.canvas.addEventListener('mousemove', onMove);
    G.canvas.addEventListener('mouseleave', onLeave);
    G.canvas.addEventListener('click', onClick);
    new ResizeObserver(() => resize()).observe(G.canvas.parentElement);
  }
  resize();
  if (!B.loaded) loadBoard();
  if (!G.running) {
    G.running = true;
    G.raf = requestAnimationFrame(frame);
  }
}

function leaveHome() {
  G.running = false;
  cancelAnimationFrame(G.raf);
  hideTip();
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && B.open && S.view === 'home' && $('modal').hidden) closeBranch();
});
