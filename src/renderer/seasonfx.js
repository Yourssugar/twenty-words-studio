'use strict';
// Частицы поверх картинки темы: зимой снег, осенью листья, весной лепестки,
// летом светлячки. У дополнительных тем свои: пузыри и лучи под водой, искры,
// дождь, размытые огни (поле fx в themes.json). Только там, где видна картинка:
// на главной (под графом) и на экране входа (под карточкой).
//
// Лёгкий слой: не больше 30 кадров в секунду, частиц по площади окна, но не больше 110.
// Останавливается, когда окно свёрнуто, раздел без картинки открыт, анимации выключены
// или снята галочка "Частицы сезона". При "мягких" анимациях частиц вдвое меньше и
// они медленнее.

const FX = {
  canvas: null,
  ctx: null,
  host: null,
  kind: '',
  parts: [],
  w: 0,
  h: 0,
  dpr: 1,
  last: 0,
  raf: 0,
  idle: 0,
};

const FX_KIND = { winter: 'snow', autumn: 'leaves', spring: 'petals', summer: 'fireflies' };
const LEAF_COLORS = ['#e67e22', '#c0392b', '#d35400', '#b9770e', '#a04000'];
const PETAL_COLORS = ['#f7c6dc', '#ffd9e8', '#fff1c9', '#f3b0cf'];
const EMBER_COLORS = ['#ffb347', '#ff8a2b', '#ffd27a', '#ff6a2b'];
// Сколько площади окна на одну частицу.
const FX_DENSITY = { fireflies: 26000, leaves: 30000, rain: 9000, bokeh: 70000, bubbles: 30000, deep: 42000, embers: 20000 };

// Цвет акцента темы для размытых огней.
function fxAccent() {
  return getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#ffffff';
}

function fxEnabled() {
  const s = LOOK.s || {};
  return s.particles !== false && s.bgImage !== false && motionLevel() !== 'off' && !document.hidden;
}

// Куда рисовать: видимая главная или экран входа.
function fxHost() {
  for (const el of [document.querySelector('.home-stage'), $('auth')]) {
    if (el && el.offsetParent !== null && el.clientWidth > 0) return el;
  }
  return null;
}

function fxResize() {
  const r = FX.host.getBoundingClientRect();
  FX.dpr = Math.min(2, window.devicePixelRatio || 1);
  FX.w = r.width;
  FX.h = r.height;
  FX.canvas.width = Math.round(r.width * FX.dpr);
  FX.canvas.height = Math.round(r.height * FX.dpr);
  FX.canvas.style.width = r.width + 'px';
  FX.canvas.style.height = r.height + 'px';
}

const rnd = (a, b) => a + Math.random() * (b - a);

function fxSpawn(top) {
  const k = FX.kind;
  const p = { x: rnd(0, FX.w), y: top ? rnd(-40, -5) : rnd(0, FX.h), ph: rnd(0, 6.28) };
  if (k === 'snow') Object.assign(p, { r: rnd(0.8, 2.8), vy: rnd(14, 42), sway: rnd(8, 22), a: rnd(0.45, 0.9) });
  else if (k === 'leaves') Object.assign(p, { r: rnd(6, 11), vy: rnd(18, 40), sway: rnd(25, 60), rot: rnd(0, 6.28), spin: rnd(-1.4, 1.4), c: LEAF_COLORS[Math.floor(Math.random() * LEAF_COLORS.length)], a: rnd(0.55, 0.9) });
  else if (k === 'petals') Object.assign(p, { r: rnd(2.5, 4.5), vy: rnd(10, 26), sway: rnd(20, 45), rot: rnd(0, 6.28), spin: rnd(-2, 2), c: PETAL_COLORS[Math.floor(Math.random() * PETAL_COLORS.length)], a: rnd(0.5, 0.85) });
  else if (k === 'fireflies') Object.assign(p, { r: rnd(1.2, 2.2), vx: rnd(-8, 8), vy: rnd(-8, 8), blink: rnd(0.4, 1.2), a: 0 });
  else if (k === 'bubbles' || k === 'deep') Object.assign(p, { y: top ? FX.h + rnd(5, 40) : p.y, r: rnd(1.2, 4.5), vy: -rnd(18, 50), sway: rnd(3, 10), a: rnd(0.22, 0.5) });
  else if (k === 'embers') Object.assign(p, { y: top ? FX.h + rnd(5, 30) : p.y, r: rnd(0.8, 2.2), vy: -rnd(20, 55), sway: rnd(10, 32), c: EMBER_COLORS[Math.floor(Math.random() * EMBER_COLORS.length)], blink: rnd(2, 6), a: rnd(0.5, 0.95) });
  else if (k === 'rain') Object.assign(p, { len: rnd(12, 26), vy: rnd(560, 820), a: rnd(0.16, 0.36) });
  else if (k === 'bokeh') Object.assign(p, { r: rnd(10, 36), vx: rnd(-7, 7), vy: rnd(-5, 5), a: rnd(0.04, 0.13), blink: rnd(0.2, 0.6), white: Math.random() < 0.35 });
  else Object.assign(p, { r: rnd(0.6, 1.6), vy: rnd(-6, -2), sway: rnd(4, 12), a: rnd(0.12, 0.35) });
  return p;
}

function fxReset() {
  const soft = motionLevel() === 'soft';
  const per = FX_DENSITY[FX.kind] || 16000;
  let n = Math.min(FX.kind === 'rain' ? 160 : 110, Math.round((FX.w * FX.h) / per));
  if (soft) n = Math.round(n / 2);
  FX.parts = Array.from({ length: n }, () => fxSpawn(false));
  FX.color = fxAccent();
  // Лучи света сверху (под водой): несколько широких полос, медленно качаются.
  FX.rays = FX.kind === 'deep' ? Array.from({ length: 5 }, (_, i) => ({ x: FX.w * (0.1 + i * 0.2 + rnd(-0.06, 0.06)), w: rnd(60, 160), tilt: rnd(-0.25, 0.25), ph: rnd(0, 6.28), a: rnd(0.035, 0.07) })) : [];
}

function fxStep(dt, t) {
  const speed = motionLevel() === 'soft' ? 0.5 : 1;
  dt *= speed;
  const ctx = FX.ctx;
  ctx.setTransform(FX.dpr, 0, 0, FX.dpr, 0, 0);
  ctx.clearRect(0, 0, FX.w, FX.h);
  for (const r of FX.rays || []) {
    const sw = Math.sin(t * 0.25 + r.ph);
    const a = r.a * (0.7 + 0.3 * Math.sin(t * 0.4 + r.ph * 2));
    const top = r.x + sw * 30;
    const bottom = top + (r.tilt + sw * 0.05) * FX.h;
    const g = ctx.createLinearGradient(0, 0, 0, FX.h * 0.9);
    g.addColorStop(0, 'rgba(210,240,255,' + a.toFixed(3) + ')');
    g.addColorStop(1, 'rgba(210,240,255,0)');
    ctx.globalAlpha = 1;
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(top - r.w * 0.3, 0);
    ctx.lineTo(top + r.w * 0.3, 0);
    ctx.lineTo(bottom + r.w, FX.h * 0.9);
    ctx.lineTo(bottom - r.w, FX.h * 0.9);
    ctx.closePath();
    ctx.fill();
  }
  for (let i = 0; i < FX.parts.length; i++) {
    const p = FX.parts[i];
    if (FX.kind === 'rain') {
      // Косые штрихи, быстро вниз.
      p.y += p.vy * dt;
      p.x -= p.vy * 0.18 * dt;
      if (p.y > FX.h + 30 || p.x < -30) FX.parts[i] = Object.assign(fxSpawn(true), { x: rnd(0, FX.w + FX.h * 0.18) });
      ctx.globalAlpha = p.a;
      ctx.strokeStyle = '#cfe3ff';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(p.x + p.len * 0.18, p.y - p.len);
      ctx.stroke();
      continue;
    }
    if (FX.kind === 'bokeh') {
      // Большие размытые огни: плывут и медленно дышат.
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (p.x < -50) p.x = FX.w + 50;
      if (p.x > FX.w + 50) p.x = -50;
      if (p.y < -50) p.y = FX.h + 50;
      if (p.y > FX.h + 50) p.y = -50;
      const a = p.a * (0.6 + 0.4 * Math.sin(t * p.blink + p.ph));
      const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r);
      const c = p.white ? '#ffffff' : FX.color;
      g.addColorStop(0, c);
      g.addColorStop(0.6, c);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.globalAlpha = a;
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, 6.283);
      ctx.fill();
      continue;
    }
    if (FX.kind === 'fireflies') {
      // Блуждают и мигают.
      p.vx += rnd(-12, 12) * dt;
      p.vy += rnd(-12, 12) * dt;
      p.vx = Math.max(-14, Math.min(14, p.vx));
      p.vy = Math.max(-10, Math.min(10, p.vy));
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (p.x < -10) p.x = FX.w + 10;
      if (p.x > FX.w + 10) p.x = -10;
      if (p.y < FX.h * 0.25) p.vy += 4 * dt;
      if (p.y > FX.h + 10) p.y = FX.h * 0.4;
      p.a = 0.2 + 0.8 * Math.max(0, Math.sin(t * p.blink + p.ph)) ** 2;
      // Мягкое свечение: круг с прозрачными краями.
      const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r * 7);
      g.addColorStop(0, 'rgba(230,255,140,' + (p.a * 0.45).toFixed(3) + ')');
      g.addColorStop(1, 'rgba(230,255,140,0)');
      ctx.globalAlpha = 1;
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r * 7, 0, 6.283);
      ctx.fill();
      ctx.globalAlpha = p.a;
      ctx.fillStyle = '#f4ffb8';
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, 6.283);
      ctx.fill();
      continue;
    }
    p.y += p.vy * dt;
    const x = p.x + Math.sin(t * 0.6 + p.ph) * p.sway;
    if (p.vy > 0 && p.y > FX.h + 20) FX.parts[i] = fxSpawn(true);
    else if (p.vy < 0 && p.y < -10) Object.assign(p, { y: FX.h + 5, x: rnd(0, FX.w) });
    ctx.globalAlpha = p.a;
    if (FX.kind === 'bubbles' || FX.kind === 'deep') {
      // Пузырь: тонкий контур и блик.
      ctx.strokeStyle = '#dff6ff';
      ctx.lineWidth = 0.9;
      ctx.beginPath();
      ctx.arc(x, p.y, p.r, 0, 6.283);
      ctx.stroke();
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(x - p.r * 0.35, p.y - p.r * 0.35, p.r * 0.28, 0, 6.283);
      ctx.fill();
    } else if (FX.kind === 'embers') {
      // Искра: тлеет и мерцает, поднимаясь.
      ctx.globalAlpha = p.a * (0.55 + 0.45 * Math.sin(t * p.blink + p.ph));
      const g = ctx.createRadialGradient(x, p.y, 0, x, p.y, p.r * 4);
      g.addColorStop(0, p.c);
      g.addColorStop(1, 'rgba(255,120,40,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, p.y, p.r * 4, 0, 6.283);
      ctx.fill();
      ctx.fillStyle = '#fff3d6';
      ctx.beginPath();
      ctx.arc(x, p.y, p.r * 0.6, 0, 6.283);
      ctx.fill();
    } else if (FX.kind === 'snow' || FX.kind === 'dust') {
      ctx.fillStyle = FX.kind === 'snow' ? '#ffffff' : '#ffd9a0';
      ctx.beginPath();
      ctx.arc(x, p.y, p.r, 0, 6.283);
      ctx.fill();
    } else {
      // Лист или лепесток: вытянутый эллипс, крутится и переворачивается.
      p.rot += p.spin * dt;
      ctx.save();
      ctx.translate(x, p.y);
      ctx.rotate(p.rot);
      ctx.scale(1, 0.35 + 0.65 * Math.abs(Math.sin(t * 1.3 + p.ph)));
      ctx.fillStyle = p.c;
      ctx.beginPath();
      if (FX.kind === 'leaves') {
        // Лист с острыми концами.
        ctx.moveTo(-p.r, 0);
        ctx.quadraticCurveTo(0, -p.r * 0.75, p.r, 0);
        ctx.quadraticCurveTo(0, p.r * 0.75, -p.r, 0);
      } else {
        ctx.ellipse(0, 0, p.r, p.r * 0.7, 0, 0, 6.283);
      }
      ctx.fill();
      if (FX.kind === 'leaves') {
        ctx.strokeStyle = 'rgba(0,0,0,.25)';
        ctx.lineWidth = 0.6;
        ctx.beginPath();
        ctx.moveTo(-p.r, 0);
        ctx.lineTo(p.r, 0);
        ctx.stroke();
      }
      ctx.restore();
    }
  }
  ctx.globalAlpha = 1;
}

function fxFrame(now) {
  FX.raf = 0;
  const id = document.documentElement.dataset.theme;
  const kind = FX_KIND[id] || (THEMES.find((t) => t.id === id) || {}).fx || 'dust';
  const host = fxEnabled() && kind !== 'none' ? fxHost() : null;
  if (!host) {
    fxStop();
    FX.idle = setTimeout(fxTick, 600); // проверяем, не открылась ли снова главная
    return;
  }
  if (host !== FX.host) {
    FX.host = host;
    host.prepend(FX.canvas);
    fxResize();
    FX.kind = '';
  }
  if (FX.canvas.width !== Math.round(host.clientWidth * FX.dpr)) {
    fxResize();
    FX.kind = '';
  }
  if (kind !== FX.kind) {
    FX.kind = kind;
    fxReset();
  }
  FX.raf = requestAnimationFrame(fxFrame);
  if (now - FX.last < 33) return; // 30 кадров в секунду хватает
  const dt = Math.min(0.1, (now - (FX.last || now)) / 1000);
  FX.last = now;
  fxStep(dt, now / 1000);
}

function fxStop() {
  if (FX.raf) cancelAnimationFrame(FX.raf);
  FX.raf = 0;
  if (FX.canvas && FX.canvas.parentNode) FX.canvas.remove();
  FX.host = null;
  FX.kind = '';
  FX.last = 0;
}

function fxTick() {
  clearTimeout(FX.idle);
  if (!FX.raf) FX.raf = requestAnimationFrame(fxFrame);
}

function initSeasonFx() {
  FX.canvas = document.createElement('canvas');
  FX.canvas.className = 'season-fx';
  FX.canvas.setAttribute('aria-hidden', 'true');
  FX.ctx = FX.canvas.getContext('2d');
  document.addEventListener('visibilitychange', fxTick);
  window.addEventListener('resize', fxTick);
  fxTick();
}
