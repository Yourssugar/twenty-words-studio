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
  topic: null, // id карточки, обсуждение которой открыто
  topicMsgs: new Map(),
  topicMore: false,
  typingTimer: 0,
  lastTyping: 0,
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
  fshift: 0, // сдвиг вправо, когда слева видна лента команды
  nodes: new Map(), // id ветки -> узел с точками кластера
  mouse: null,
  pulses: new Map(), // id ветки -> время вспышки: в теме ветки новое сообщение или новая карточка
};

// Ветка коротко вспыхивает, когда в ней что-то происходит.
function pulseBranch(id) {
  if (id) G.pulses.set(id, performance.now());
}

// ---------- данные ----------

async function loadBoard() {
  try {
    const data = await call(studio.board.get());
    B.branches = data.branches;
    B.cards = new Map(data.cards.map((c) => [c.id, c]));
    B.loaded = true;
    syncNodes();
    renderDrawer();
    updateHomeBadge();
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
    if (B.topic) loadTopic(B.topic);
    return;
  }
  if (ev.t === 'userGone' && ev.deleted) {
    for (const [id, c] of B.cards) if (c.author === ev.user) B.cards.delete(id);
    if (B.topic && !B.cards.has(B.topic)) B.topic = null;
    renderDrawer();
    return;
  }
  if (ev.t === 'board') {
    if (ev.op === 'card') {
      // Счётчики обсуждения у каждого свои: при правке карточки их не затираем.
      const old = B.cards.get(ev.card.id);
      if (!old) {
        pulseBranch(ev.card.branch);
        if (typeof feedSoon === 'function') feedSoon();
      }
      B.cards.set(ev.card.id, old ? { ...ev.card, msgs: old.msgs, unread: old.unread, last: old.last } : ev.card);
    } else if (ev.op === 'cardGone') {
      B.cards.delete(ev.id);
      if (B.topic === ev.id) {
        B.topic = null;
        toast('Тему удалили');
      }
    } else if (ev.op === 'branch') {
      const i = B.branches.findIndex((b) => b.id === ev.branch.id);
      if (i >= 0) B.branches[i] = ev.branch;
    }
    renderDrawer();
    if (B.hover) showTip(B.hover);
    return;
  }
  // Сообщения в обсуждениях карточек
  const room = (ev.m && ev.m.room) || ev.room || '';
  if (!room.startsWith('card:')) return;
  const cardId = Number(room.slice(5));
  const card = B.cards.get(cardId);
  if (ev.t === 'msg') {
    const m = ev.m;
    if (card) {
      card.msgs = (card.msgs || 0) + 1;
      card.last = m.ts;
      pulseBranch(card.branch);
    }
    const open = B.topic === cardId && S.view === 'home';
    if (open) {
      B.topicMsgs.set(m.id, m);
      if (m.user !== S.me.id && document.hasFocus()) studio.chat.send({ t: 'read', room, id: m.id });
      else if (m.user !== S.me.id && card) card.unread = (card.unread || 0) + 1;
      renderTopicLog(m.user === S.me.id);
    } else if (card && m.user !== S.me.id) {
      card.unread = (card.unread || 0) + 1;
    }
    if (!open) renderDrawer();
    updateHomeBadge();
  } else if (ev.t === 'edit' && B.topic === cardId) {
    B.topicMsgs.set(ev.m.id, ev.m);
    renderTopicLog();
  } else if (ev.t === 'delete') {
    if (card) card.msgs = Math.max(0, (card.msgs || 1) - 1);
    if (B.topic === cardId && B.topicMsgs.delete(ev.id)) renderTopicLog();
  } else if (ev.t === 'read' && card) {
    card.unread = 0;
    updateHomeBadge();
    if (!B.topic) renderDrawer();
  } else if (ev.t === 'typing' && B.topic === cardId) {
    const u = S.users.get(ev.user);
    const el = document.getElementById('topic-typing');
    if (el && u) {
      el.textContent = u.name + ' печатает...';
      clearTimeout(B.typingTimer);
      B.typingTimer = setTimeout(() => (el.textContent = ''), 4000);
    }
  }
});

function updateHomeBadge() {
  let total = 0;
  for (const c of B.cards.values()) total += c.unread || 0;
  const badge = $('badge-home');
  badge.hidden = !total;
  badge.textContent = total > 99 ? '99+' : total;
}

window.addEventListener('focus', () => {
  if (B.topic && S.view === 'home') markTopicRead();
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
  const cx = G.w / 2 - G.shift + G.fshift;
  const cy = G.h / 2 + 10;
  const R = Math.max(150, Math.min(300, Math.min(G.w - G.shift * 2, G.h) * 0.33));
  const n = B.branches.length || 1;
  return { cx, cy, R, n };
}

function branchPos(i, t, L) {
  const a = -Math.PI / 2 + (i / L.n) * Math.PI * 2;
  const node = G.nodes.get(B.branches[i].id);
  const sway = node ? node.ph : 0;
  const amp = 4 * (typeof motionAmp === 'function' ? motionAmp() : 1); // настройка "Анимации"
  return {
    x: L.cx + Math.cos(a) * L.R * 1.25 + Math.sin(t * 0.35 + sway) * amp,
    y: L.cy + Math.sin(a) * L.R + Math.cos(t * 0.3 + sway) * amp,
  };
}

function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

// Насыщенный и светлый вариант цвета ветки: граф должен читаться поверх яркой картинки темы.
const VIVID = new Map();
function vivid(hex) {
  if (!/^#[0-9a-f]{6}$/i.test(hex || '')) return '#e9a23b';
  if (VIVID.has(hex)) return VIVID.get(hex);
  const n = parseInt(hex.slice(1), 16);
  let [r, g, b] = [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  let hh = 0;
  const d = mx - mn;
  if (d) hh = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  hh = (hh * 60 + 360) % 360;
  const l0 = (mx + mn) / 2;
  const s0 = d ? d / (1 - Math.abs(2 * l0 - 1)) : 0;
  const sat = Math.min(1, Math.max(s0 * 1.35, s0 > 0.08 ? 0.75 : s0));
  const l = Math.min(0.7, Math.max(0.6, l0));
  const c = (1 - Math.abs(2 * l - 1)) * sat;
  const x = c * (1 - Math.abs(((hh / 60) % 2) - 1));
  const m = l - c / 2;
  [r, g, b] = hh < 60 ? [c, x, 0] : hh < 120 ? [x, c, 0] : hh < 180 ? [0, c, x] : hh < 240 ? [0, x, c] : hh < 300 ? [x, 0, c] : [c, 0, x];
  const out = '#' + [r, g, b].map((v) => Math.round((v + m) * 255).toString(16).padStart(2, '0')).join('');
  VIVID.set(hex, out);
  return out;
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
  // Узкое окно прячет ленту, широкое возвращает.
  if (typeof FD !== 'undefined' && FD.loaded && FD.visible !== feedVisible()) renderFeed();
}

function frame(now) {
  if (!G.running) return;
  G.raf = requestAnimationFrame(frame);
  if (document.hidden) return;
  const t = (now - G.t0) / 1000;
  const ctx = G.ctx;
  const targetShift = B.topic ? Math.min(290, G.w * 0.22) : B.open ? Math.min(200, G.w * 0.16) : 0;
  G.shift += (targetShift - G.shift) * 0.12;
  const feedOn = typeof FD !== 'undefined' && FD.visible;
  G.fshift += ((feedOn ? 140 : 0) - G.fshift) * 0.12;

  ctx.setTransform(G.dpr, 0, 0, G.dpr, 0, 0);
  ctx.clearRect(0, 0, G.w, G.h);
  if (!B.branches.length) return;
  const L = layout();
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#e9a23b';

  // свечение центра
  const acc = vivid(accent.startsWith('#') ? accent : '#e9a23b');
  const glow = ctx.createRadialGradient(L.cx, L.cy, 10, L.cx, L.cy, 190);
  glow.addColorStop(0, hexA(acc, 0.28));
  glow.addColorStop(0.35, hexA(acc, 0.09));
  glow.addColorStop(1, hexA(acc, 0));
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
    const col = vivid(b.color);
    ctx.strokeStyle = hexA(col, on ? 0.95 : 0.62);
    ctx.lineWidth = on ? 2.2 : 1.6;
    ctx.shadowColor = hexA(col, 0.9);
    ctx.shadowBlur = on ? 12 : 7;
    ctx.beginPath();
    ctx.moveTo(L.cx, L.cy);
    ctx.quadraticCurveTo(qx, qy, p.x, p.y);
    ctx.stroke();
    ctx.shadowBlur = 0;
    // редкая искра вдоль нити
    const k = ((t * 0.12 + i * 0.17) % 1);
    if (k < 0.85) {
      const u = k / 0.85;
      const ex = (1 - u) * (1 - u) * L.cx + 2 * (1 - u) * u * qx + u * u * p.x;
      const ey = (1 - u) * (1 - u) * L.cy + 2 * (1 - u) * u * qy + u * u * p.y;
      ctx.fillStyle = hexA(col, 0.9 * Math.sin(u * Math.PI));
      ctx.beginPath();
      ctx.arc(ex, ey, 2.4, 0, Math.PI * 2);
      ctx.fill();
    }
  });

  // вспышки веток: искра бежит от центра к ветке, вокруг ветки расходится кольцо
  const amp = typeof motionAmp === 'function' ? motionAmp() : 1;
  B.branches.forEach((b, i) => {
    const at = G.pulses.get(b.id);
    if (!at) return;
    const age = (now - at) / 1000;
    if (age > 2.6) {
      G.pulses.delete(b.id);
      return;
    }
    const p = pos[i];
    if (amp > 0 && age < 0.9) {
      const u = age / 0.9;
      const dx = p.x - L.cx;
      const dy = p.y - L.cy;
      const qx = (L.cx + p.x) / 2 - dy * 0.12;
      const qy = (L.cy + p.y) / 2 + dx * 0.12;
      const ex = (1 - u) * (1 - u) * L.cx + 2 * (1 - u) * u * qx + u * u * p.x;
      const ey = (1 - u) * (1 - u) * L.cy + 2 * (1 - u) * u * qy + u * u * p.y;
      const sg = ctx.createRadialGradient(ex, ey, 0, ex, ey, 14);
      sg.addColorStop(0, hexA(b.color, 0.95));
      sg.addColorStop(1, hexA(b.color, 0));
      ctx.fillStyle = sg;
      ctx.beginPath();
      ctx.arc(ex, ey, 14, 0, Math.PI * 2);
      ctx.fill();
    }
    const k = Math.max(0, (age - (amp > 0 ? 0.7 : 0)) / 1.9);
    if (k > 0 && k < 1) {
      ctx.strokeStyle = hexA(b.color, 0.7 * (1 - k));
      ctx.lineWidth = 2 - k;
      ctx.beginPath();
      ctx.arc(p.x, p.y, amp > 0 ? 40 + k * 70 : 60, 0, Math.PI * 2);
      ctx.stroke();
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
      const qa = 2.2 * (typeof motionAmp === 'function' ? motionAmp() : 1);
      const sx = q.x + Math.sin(t * q.sp + q.ph) * qa;
      const sy = q.y + Math.cos(t * q.sp * 0.9 + q.ph) * qa;
      return { x: p.x + sx + (q.cx - sx) * f, y: p.y + sy + (q.cy - sy) * f };
    });
    const count = cardsOf(b.id).length;
    const empty = count === 0;
    const col = vivid(b.color);
    const base = empty ? 0.45 : 0.7;
    // тёмная подложка и цветное пятно: граф читается поверх любой картинки
    const shade = ctx.createRadialGradient(p.x, p.y, 10, p.x, p.y, 105);
    shade.addColorStop(0, 'rgba(6,7,10,.5)');
    shade.addColorStop(1, 'rgba(6,7,10,0)');
    ctx.fillStyle = shade;
    ctx.fillRect(p.x - 110, p.y - 110, 220, 220);
    const fog = ctx.createRadialGradient(p.x, p.y, 4, p.x, p.y, 95);
    fog.addColorStop(0, hexA(col, empty ? 0.12 : 0.22));
    fog.addColorStop(1, hexA(col, 0));
    ctx.fillStyle = fog;
    ctx.fillRect(p.x - 100, p.y - 100, 200, 200);

    ctx.shadowColor = hexA(col, 0.95);
    ctx.shadowBlur = 8;
    ctx.strokeStyle = hexA(col, Math.min(1, base + f * 0.3));
    ctx.lineWidth = 1.1;
    ctx.beginPath();
    for (const [a, c] of node.edges) {
      ctx.moveTo(pts[a].x, pts[a].y);
      ctx.lineTo(pts[c].x, pts[c].y);
    }
    ctx.stroke();
    ctx.fillStyle = hexA(col, empty ? 0.75 : 1);
    for (const q of pts) {
      ctx.beginPath();
      ctx.arc(q.x, q.y, 2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.shadowBlur = 0;
    // уголки-рамка вокруг ветки под курсором
    if (f > 0.05) {
      const s = 50;
      const l = 14;
      ctx.strokeStyle = hexA(col, 0.95 * f);
      ctx.lineWidth = 1.6;
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
    ctx.fillStyle = empty ? 'rgba(236,234,229,.78)' : '#ffffff';
    ctx.shadowColor = 'rgba(0,0,0,.95)';
    ctx.shadowBlur = 8;
    ctx.fillText(b.title.toUpperCase(), p.x, p.y);
    ctx.shadowColor = hexA(col, 0.7);
    ctx.shadowBlur = 14;
    ctx.fillText(b.title.toUpperCase(), p.x, p.y);
    ctx.font = '600 10.5px Consolas, "Cascadia Mono", monospace';
    ctx.letterSpacing = '1.5px';
    ctx.fillStyle = hexA(col, empty ? 0.75 : 1);
    ctx.shadowColor = 'rgba(0,0,0,.95)';
    ctx.shadowBlur = 6;
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
  ctx.fillStyle = 'rgba(18,19,23,.9)';
  ctx.shadowColor = hexA(acc, 0.8);
  ctx.shadowBlur = 18;
  ctx.beginPath();
  ctx.arc(L.cx, L.cy, 44, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = hexA(acc, 0.75);
  ctx.lineWidth = 1.4;
  ctx.setLineDash([2, 5]);
  ctx.beginPath();
  ctx.arc(L.cx, L.cy, 54 + Math.sin(t * 0.6) * 1.5 * (typeof motionAmp === 'function' ? motionAmp() : 1), 0, Math.PI * 2);
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
  drawOnline(ctx, L, t);
}

// Кто сейчас в сети: кружки с первой буквой имени медленно ходят вокруг центра.
// Под курсором видно имя.
function drawOnline(ctx, L, t) {
  if (!S.me) return;
  const list = [...S.users.values()].filter((u) => u.online || u.id === S.me.id).sort((a, b) => a.id - b.id);
  if (!list.length) return;
  const amp = typeof motionAmp === 'function' ? motionAmp() : 1;
  const R = 78;
  let hoverName = '';
  let hx = 0;
  let hy = 0;
  list.forEach((u, i) => {
    const a = -Math.PI / 2 + (i / list.length) * Math.PI * 2 + t * 0.06 * amp;
    const x = L.cx + Math.cos(a) * R;
    const y = L.cy + Math.sin(a) * R;
    const color = (u.avatar && /^#[0-9a-f]{6}$/i.test(u.avatar.color || '') && u.avatar.color) || '#7c6cff';
    ctx.fillStyle = hexA(color, 0.9);
    ctx.strokeStyle = 'rgba(10,11,13,.9)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.font = '700 9px "Segoe UI", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText((u.name || '?').slice(0, 1).toUpperCase(), x, y + 0.5);
    if (G.mouse && Math.hypot(G.mouse[0] - x, G.mouse[1] - y) < 11) {
      hoverName = u.id === S.me.id ? u.name + ' (вы)' : u.name;
      hx = x;
      hy = y;
    }
  });
  if (hoverName) {
    ctx.font = '12px "Segoe UI", system-ui, sans-serif';
    const w = ctx.measureText(hoverName).width + 14;
    ctx.fillStyle = 'rgba(14,15,18,.92)';
    ctx.strokeStyle = 'rgba(255,255,255,.18)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(hx - w / 2, hy - 34, w, 20, 5);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#f2f0eb';
    ctx.fillText(hoverName, hx, hy - 24);
  }
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
  G.mouse = [e.clientX - r.left, e.clientY - r.top];
  const id = branchAt(e.clientX - r.left, e.clientY - r.top);
  if (id !== B.hover) {
    B.hover = id;
    G.canvas.style.cursor = id ? 'pointer' : 'default';
    if (id) showTip(id);
    else hideTip();
  }
}

function onLeave() {
  G.mouse = null;
  B.hover = null;
  hideTip();
}

function onClick(e) {
  const r = G.canvas.getBoundingClientRect();
  const id = branchAt(e.clientX - r.left, e.clientY - r.top);
  if (id) openBranch(id);
  else if (B.open) closeBranch();
}

// ---------- список карточек ветки и обсуждение карточки ----------

function openBranch(id) {
  B.open = id;
  B.topic = null;
  hideTip();
  renderDrawer();
}

function closeBranch() {
  B.open = null;
  B.topic = null;
  renderDrawer();
}

function canEdit(c) {
  return S.me && (c.author === S.me.id || S.me.role === 'admin');
}

const msgsLabel = (n) => {
  const d = n % 10;
  const dd = n % 100;
  const w = d === 1 && dd !== 11 ? 'сообщение' : d >= 2 && d <= 4 && (dd < 12 || dd > 14) ? 'сообщения' : 'сообщений';
  return n + ' ' + w;
};

function renderDrawer() {
  if (typeof renderFeed === 'function') renderFeed(); // лента прячется, пока открыта ветка или тема
  $('home-count').textContent = B.loaded ? 'веток: ' + B.branches.length + ' · карточек: ' + B.cards.size : '';
  const box = $('home-drawer');
  if (B.topic && B.cards.has(B.topic)) {
    renderTopic();
    return;
  }
  B.topic = null;
  box.classList.remove('is-topic');
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
  if (!cards.length) list.append(h('div', { class: 'drawer-empty muted', text: 'Пока пусто. Добавьте первую карточку: заголовок и пару строк о сути, обсуждать будем внутри.' }));
  for (const c of cards) {
    const u = S.users.get(c.author) || { name: 'участник' };
    const talk = c.msgs ? msgsLabel(c.msgs) + (c.last ? ', последнее ' + dayLabel(c.last).toLowerCase() : '') : 'обсуждения ещё нет';
    list.append(h('button', { class: 'bcard', onclick: () => openTopic(c.id) },
      h('div', { class: 'bcard-head' },
        avatar(u, 22),
        h('div', { class: 'grow' },
          h('div', { class: 'bcard-title', text: c.title }),
          h('div', { class: 'bcard-meta', text: u.name + ' · ' + dayLabel(c.created) }),
        ),
        c.unread ? h('span', { class: 'badge', text: c.unread > 99 ? '99+' : c.unread }) : null,
      ),
      c.body ? h('div', { class: 'bcard-preview', text: c.body.length > 140 ? c.body.slice(0, 138).trim() + '...' : c.body }) : null,
      h('div', { class: 'bcard-talk', text: talk }),
    ));
  }
  box.append(head, tools, list);
}

// ---------- обсуждение карточки ----------

async function openTopic(id) {
  B.topic = id;
  B.topicMsgs = new Map();
  B.topicMore = false;
  renderDrawer();
  await loadTopic(id);
}

async function loadTopic(id, before) {
  try {
    const r = await call(studio.api.messages('card:' + id, before));
    if (B.topic !== id) return;
    for (const m of r.messages) B.topicMsgs.set(m.id, m);
    B.topicMore = r.messages.length === 50;
  } catch (err) {
    if (err.code !== 'no_access') toast(errText(err.code));
    return;
  }
  renderTopicLog(!before);
  if (!before) markTopicRead();
}

function markTopicRead() {
  const c = B.cards.get(B.topic);
  if (!c || !B.topicMsgs.size) return;
  const last = Math.max(...B.topicMsgs.keys());
  studio.chat.send({ t: 'read', room: 'card:' + c.id, id: last });
  if (c.unread) {
    c.unread = 0;
    updateHomeBadge();
  }
}

function backToBranch() {
  B.topic = null;
  renderDrawer();
}

function renderTopic() {
  const box = $('home-drawer');
  const c = B.cards.get(B.topic);
  const b = branchById(c.branch) || { title: '', color: '#e9a23b' };
  B.open = c.branch;
  box.hidden = false;
  box.classList.add('is-topic');
  box.style.setProperty('--c', b.color);
  // Поле ввода не пересоздаём, чтобы не терять набранный текст.
  let composer = document.getElementById('topic-form');
  const keep = composer && composer.dataset.card === String(c.id);
  box.innerHTML = '';
  const u = S.users.get(c.author) || { name: 'участник' };
  const head = h('div', { class: 'drawer-head topic-head' },
    h('button', { class: 'btn btn-s', text: 'Назад', title: 'К списку карточек ветки', onclick: backToBranch }),
    h('div', { class: 'grow topic-crumb', text: b.title }),
    h('button', { class: 'btn btn-s', text: 'Закрыть', onclick: closeBranch }),
  );
  const card = h('div', { class: 'topic-card' },
    h('div', { class: 'drawer-title', text: c.title }),
    h('div', { class: 'row gap-s topic-author' }, avatar(u, 20), h('span', { class: 'muted small', text: u.name + ' · ' + dayLabel(c.created) + (c.updated > c.created + 1000 ? ' · изменено' : '') })),
    c.body ? h('div', { class: 'msg-text topic-body' }, linkify(c.body)) : null,
    canEdit(c) ? h('div', { class: 'row gap-s' },
      h('button', { class: 'btn btn-s', text: 'Изменить', onclick: () => editCard(c, c.branch) }),
      h('button', { class: 'btn btn-s btn-danger-ghost', text: 'Удалить тему', onclick: () => deleteCard(c) }),
    ) : null,
  );
  const log = h('div', { class: 'topic-log', id: 'topic-log' });
  log.addEventListener('scroll', async () => {
    if (log.scrollTop > 40 || !B.topicMore || B.topicLoading) return;
    const before = Math.min(...B.topicMsgs.keys());
    const oldH = log.scrollHeight;
    B.topicLoading = true;
    await loadTopic(c.id, before);
    B.topicLoading = false;
    log.scrollTop = log.scrollHeight - oldH;
  });
  if (!keep) composer = topicComposer(c.id);
  box.append(head, card, h('div', { class: 'topic-label muted small', text: 'Обсуждение' }), log, h('div', { class: 'topic-typing muted small', id: 'topic-typing' }), composer);
  renderTopicLog(true);
}

function topicComposer(cardId) {
  const ta = h('textarea', { rows: '1', maxlength: '4000', placeholder: 'Написать в обсуждение. Enter отправить, Shift+Enter новая строка' });
  const proj = h('button', { class: 'btn', type: 'button', text: 'Проект', title: 'Прикрепить снимок своего проекта к обсуждению', onclick: () => shareProjectTo('card:' + cardId) });
  const imgBtn = h('button', { class: 'btn btn-ico', type: 'button', title: 'Картинка: кнопкой, Ctrl+V или перетащить сюда' });
  const strip = h('div', { class: 'att-strip', hidden: true });
  const attach = new Attacher(strip);
  const form = h('form', { class: 'composer topic-composer', id: 'topic-form', dataset: { card: String(cardId) } }, imgBtn, ta, proj, h('button', { class: 'btn btn-accent', type: 'submit', text: 'Отправить' }));
  bindAttach({ input: ta, dropZone: form, button: imgBtn, attacher: attach, allowed: () => true });
  form.prepend(strip);
  const size = () => {
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 160) + 'px';
  };
  ta.addEventListener('input', () => {
    size();
    if (ta.value && Date.now() - B.lastTyping > 2500) {
      B.lastTyping = Date.now();
      studio.chat.send({ t: 'typing', room: 'card:' + cardId });
    }
  });
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
    if (!(await sendWithImages('card:' + cardId, text, attach))) return;
    ta.value = '';
    B.lastTyping = 0;
    size();
  });
  setTimeout(() => ta.focus(), 30);
  return form;
}

function renderTopicLog(stick) {
  const log = document.getElementById('topic-log');
  if (!log) return;
  const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
  log.innerHTML = '';
  const list = [...B.topicMsgs.values()].sort((a, b) => a.id - b.id);
  if (B.topicMore) log.append(h('div', { class: 'log-more', text: 'Прокрутите вверх, чтобы загрузить раньше' }));
  if (!list.length) log.append(h('div', { class: 'drawer-empty muted', text: 'Обсуждения пока нет. Напишите первым.' }));
  let prev = null;
  for (const m of list) {
    const day = dayLabel(m.ts);
    if (!prev || dayLabel(prev.ts) !== day) log.append(h('div', { class: 'day', text: day }));
    const compact = prev && prev.user === m.user && m.ts - prev.ts < 5 * 60 * 1000 && dayLabel(prev.ts) === day;
    log.append(topicMessage(m, compact));
    prev = m;
  }
  if (stick || nearBottom) log.scrollTop = log.scrollHeight;
}

function topicMessage(m, compact) {
  const u = S.users.get(m.user) || { name: 'Удалённый пользователь' };
  const mine = m.user === S.me.id;
  const canDelete = mine || S.me.role === 'admin';
  const row = h('div', { class: 'msg' + (compact ? ' compact' : '') + (mine ? ' mine' : '') });
  row.append(compact ? h('span', { class: 'msg-time-side', text: timeOf(m.ts) }) : avatar(u, 30));
  const body = h('div', { class: 'msg-body' });
  if (!compact) body.append(h('div', { class: 'msg-head' }, h('span', { class: 'msg-name', text: u.name }), h('span', { class: 'msg-time', text: timeOf(m.ts) })));
  if (m.text || m.edited) body.append(h('div', { class: 'msg-text' }, linkify(m.text), m.edited ? h('span', { class: 'edited', text: ' (изменено)' }) : null));
  const imgs = msgImages(m);
  if (imgs) body.append(imgs);
  if (m.snap && typeof snapCard === 'function') body.append(snapCard(m.snap));
  row.append(body);
  if (mine || canDelete) {
    row.append(h('div', { class: 'msg-actions' },
      mine ? h('button', { class: 'mini', text: 'изменить', onclick: () => editTopicMessage(m) }) : null,
      canDelete ? h('button', { class: 'mini', text: 'удалить', onclick: () => deleteMessage(m) }) : null,
    ));
  }
  return row;
}

async function editTopicMessage(m) {
  const ta = h('textarea', { rows: '4', maxlength: '4000' });
  ta.value = m.text;
  setTimeout(() => ta.focus(), 30);
  if (!(await modal({ title: 'Изменить сообщение', body: ta, ok: 'Сохранить' }))) return;
  const text = ta.value.trim();
  if (text && text !== m.text) studio.chat.send({ t: 'edit', id: m.id, text });
}

async function editCard(card, branch) {
  const title = h('input', { maxlength: '80', placeholder: 'Тема: коротко, о чём речь' });
  const body = h('textarea', { rows: '8', maxlength: '4000', placeholder: 'Суть: что, зачем, ссылки. Обсуждение будет внутри карточки.' });
  title.value = card ? card.title : '';
  body.value = card ? card.body : '';
  const form = h('div', {}, h('label', { class: 'field' }, h('span', { text: 'Заголовок' }), title), h('label', { class: 'field' }, h('span', { text: 'Текст' }), body));
  setTimeout(() => title.focus(), 30);
  if (!(await modal({ title: card ? 'Изменить карточку' : 'Новая карточка', body: form, ok: 'Сохранить' }))) return;
  try {
    const saved = card
      ? await call(studio.board.edit(card.id, title.value, body.value))
      : await call(studio.board.add(branch, title.value, body.value));
    const old = B.cards.get(saved.id);
    B.cards.set(saved.id, old ? { ...saved, msgs: old.msgs, unread: old.unread, last: old.last } : saved);
    if (!card) {
      openTopic(saved.id);
      return;
    }
    renderDrawer();
  } catch (err) {
    toast(errText(err.code));
  }
}

async function deleteCard(c) {
  if (!(await modal({ title: 'Удалить тему?', body: '"' + c.title + '" исчезнет у всех вместе с обсуждением.', ok: 'Удалить', danger: true }))) return;
  try {
    await call(studio.board.remove(c.id));
    B.cards.delete(c.id);
    if (B.topic === c.id) B.topic = null;
    renderDrawer();
    updateHomeBadge();
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
  if (B.topic) setTimeout(markTopicRead, 50);
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
  if (typeof loadFeed === 'function') {
    renderFeed();
    loadFeed();
  }
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
