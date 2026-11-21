'use strict';
// Короткий праздник у самого человека: конфетти на полторы секунды и плашка с поводом.
// Поводы: подтвердили твой отчёт; твои баллы за месяц перешли рубеж (25, 50, 100,
// 200, 500, 1000); первый переход по твоей ссылке. Каждый рубеж и первый переход
// празднуются один раз (помнит главный процесс, настройка celebrated).
// Анимации выключены: только плашка без конфетти. Мягкие: конфетти вдвое меньше.
// Выключается галочкой в "Оформлении".

const CEL = { busy: false, queue: [], checking: false };
const MILESTONES = [25, 50, 100, 200, 500, 1000];

function celebrateOn() {
  return !LOOK.s || LOOK.s.celebrate !== false;
}

function celebrate(title, sub) {
  if (!celebrateOn()) return;
  CEL.queue.push([title, sub]);
  if (!CEL.busy) nextCelebration();
}

function nextCelebration() {
  const item = CEL.queue.shift();
  if (!item) {
    CEL.busy = false;
    return;
  }
  CEL.busy = true;
  const [title, sub] = item;
  if (typeof uiSound === 'function') uiSound('ok');
  const badge = h('div', { class: 'cel-badge' }, h('div', { class: 'cel-title', text: title }), sub ? h('div', { class: 'cel-sub', text: sub }) : null);
  document.body.append(badge);
  const level = motionLevel();
  if (level !== 'off') confetti(level === 'soft' ? 45 : 90);
  setTimeout(() => badge.classList.add('is-out'), 2600);
  setTimeout(() => {
    badge.remove();
    nextCelebration();
  }, 3000);
}

// Конфетти из точки чуть выше центра окна, разлетаются и падают.
function confetti(n) {
  const c = document.createElement('canvas');
  c.className = 'cel-canvas';
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const W = window.innerWidth;
  const H = window.innerHeight;
  c.width = W * dpr;
  c.height = H * dpr;
  document.body.append(c);
  const ctx = c.getContext('2d');
  ctx.scale(dpr, dpr);
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#e9a23b';
  const colors = [accent, '#3987e5', '#199e70', '#d55181', '#c98500', '#f2f0eb'];
  const parts = Array.from({ length: n }, () => {
    const a = -Math.PI / 2 + (Math.random() - 0.5) * 2.2;
    const v = 260 + Math.random() * 420;
    return {
      x: W / 2 + (Math.random() - 0.5) * 60,
      y: H * 0.38,
      vx: Math.cos(a) * v,
      vy: Math.sin(a) * v,
      w: 5 + Math.random() * 5,
      h: 3 + Math.random() * 4,
      r: Math.random() * 6.28,
      vr: (Math.random() - 0.5) * 14,
      c: colors[Math.floor(Math.random() * colors.length)],
    };
  });
  const t0 = performance.now();
  let last = t0;
  const step = (now) => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    const age = (now - t0) / 1000;
    ctx.clearRect(0, 0, W, H);
    ctx.globalAlpha = Math.max(0, 1 - Math.max(0, age - 1.1) / 0.6);
    for (const p of parts) {
      p.vy += 900 * dt;
      p.vx *= 1 - 1.6 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.r += p.vr * dt;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.r);
      ctx.fillStyle = p.c;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h * Math.abs(Math.cos(p.r * 1.7)));
      ctx.restore();
    }
    if (age < 1.7) requestAnimationFrame(step);
    else c.remove();
  };
  requestAnimationFrame(step);
}

// Проверка рубежей и первого перехода по свежей статистике команды.
async function checkMilestones() {
  if (!S.me || S.me.founder || !celebrateOn() || CEL.checking) return;
  CEL.checking = true;
  try {
    const st = await call(studio.team.stats());
    const done = { ...((LOOK.s && LOOK.s.celebrated) || {}) };
    const month = st.current;
    let mine = 0;
    let refs = 0;
    for (const p of st.points) {
      if (p.user !== S.me.id) continue;
      if (p.day.startsWith(month)) mine += p.points;
      if (p.kind === 'refs') refs += p.count;
    }
    let changed = false;
    // Первый запуск: всё, что уже было до этой версии, не празднуем задним числом.
    if (!done.init) {
      done.init = 1;
      done[month] = MILESTONES.filter((m) => mine >= m).pop() || 0;
      done.refFirst = refs > 0 ? 1 : 0;
      changed = true;
    } else {
      const reached = MILESTONES.filter((m) => mine >= m).pop() || 0;
      if (reached > (done[month] || 0)) {
        done[month] = reached;
        changed = true;
        celebrate('Цель месяца: ' + reached + ' баллов', 'У тебя уже ' + pts(mine) + ' за ' + MONTHS[Number(month.slice(5)) - 1] + '.');
      }
      if (refs > 0 && !done.refFirst) {
        done.refFirst = 1;
        changed = true;
        celebrate('Первый переход по твоей ссылке', 'Кто-то открыл ссылку. 100 переходов дают 2 балла.');
      }
    }
    // Старые месяцы не храним: хватает текущего и прошлого.
    for (const k of Object.keys(done)) if (/^\d{4}-\d{2}$/.test(k) && k < shiftDay(month + '-01', -40).slice(0, 7)) delete done[k];
    if (changed) LOOK.s = await call(studio.settings.set({ celebrated: done }));
  } catch {
    /* не страшно */
  } finally {
    CEL.checking = false;
  }
}

// Подтвердили отчёт: праздник с баллами из этого отчёта (их считает сервер по весам учёта).
function celebrateReport(rep) {
  if (!rep || rep.status !== 'ok') return;
  const points = rep.points || 0;
  let n = 0;
  for (const it of rep.items) n += it.kind === 'pub' ? 1 : it.okLong + it.okShort + it.okPost;
  celebrate('Отчёт подтверждён' + (points ? ': +' + pts(points) + ' ' + (Number.isInteger(points) ? plural(points, 'балл', 'балла', 'баллов') : 'балла') : ''),
    n ? n + ' ' + plural(n, 'публикация засчитана', 'публикации засчитаны', 'публикаций засчитано') : 'Просмотры засчитаны');
  setTimeout(checkMilestones, 3500);
}

let celTimer = 0;
// Лента поменялась (событие учёта, подтверждение): проверить рубежи чуть позже.
function milestonesSoon() {
  clearTimeout(celTimer);
  celTimer = setTimeout(checkMilestones, 1500);
}
