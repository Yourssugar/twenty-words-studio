'use strict';
// Оформление: своя полоса заголовка, картинка сезона и её затемнение, анимации,
// масштаб, звуки интерфейса, окна редакторов и видеокарта. Настройки хранит главный
// процесс (settings.json), здесь они применяются и рисуется их карточка в профиле.

const LOOK = { s: null, full: false, gpu: null };

// Уровень анимаций: "auto" смотрит на настройку Windows "уменьшить движение".
function motionLevel() {
  const m = (LOOK.s && LOOK.s.motion) || 'auto';
  if (m !== 'auto') return m;
  return matchMedia('(prefers-reduced-motion: reduce)').matches ? 'soft' : 'all';
}

// Множитель размаха для анимаций на canvas (граф на главной и т.п.).
function motionAmp() {
  return { all: 1, soft: 0.4, off: 0 }[motionLevel()];
}

function applyLook(s) {
  LOOK.s = { ...(LOOK.s || {}), ...s };
  const root = document.documentElement;
  root.dataset.motion = motionLevel();
  root.classList.toggle('no-bg-image', LOOK.s.bgImage === false);
  root.style.setProperty('--bg-dim', (LOOK.s.bgDim ?? 35) + '%');
  root.style.setProperty('--zoom', String((LOOK.s.zoom || 100) / 100));
  syncTitlebar();
}

// Цвет в #rrggbb из того, что отдаёт getComputedStyle (rgb() или color(srgb ...)).
function cssHex(v) {
  const n = (v.match(/[\d.]+/g) || []).map(Number);
  if (n.length < 3) return '';
  const k = /^color\(/.test(v) ? 255 : 1;
  return '#' + n.slice(0, 3).map((x) => Math.round(Math.min(255, x * k)).toString(16).padStart(2, '0')).join('');
}

// Кнопки окна рисует Windows: красим их под тему.
function syncTitlebar() {
  const bar = $('titlebar');
  if (!bar) return;
  requestAnimationFrame(async () => {
    const cs = getComputedStyle(bar);
    try {
      const r = await call(studio.win.titlebar(cssHex(cs.backgroundColor), cssHex(cs.color)));
      LOOK.full = r.full;
      bar.classList.toggle('is-full', r.full);
    } catch {
      /* старое окно без своей полосы */
    }
  });
}

// Тема поменялась: перекрасить и полосу заголовка.
const applyThemeBase = applyTheme;
applyTheme = function (id) {
  const t = applyThemeBase(id);
  syncTitlebar();
  return t;
};

const SECTION_NAMES = { home: 'Главная', chat: 'Чат', projects: 'Проекты', assistant: 'Ассистент', contrib: 'Вклад', tools: 'Инструменты', admin: 'Админ', profile: 'Профиль' };
function setTitleSection(view) {
  const el = $('tb-section');
  if (el) el.textContent = SECTION_NAMES[view] || '';
}

studio.win.onState((st) => {
  if ('full' in st) {
    LOOK.full = st.full;
    const bar = $('titlebar');
    if (bar) bar.classList.toggle('is-full', st.full);
  }
  if ('hidden' in st && typeof onWindowHidden === 'function') onWindowHidden(st.hidden);
});

matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', () => {
  if (LOOK.s) applyLook({});
});

// ---------- звуки интерфейса ----------

let uiCtx = null;
// Короткие тихие сигналы, синтезируются на месте (файлов нет).
function uiSound(kind) {
  if (!LOOK.s || LOOK.s.uiSounds === false) return;
  if (typeof FO !== 'undefined' && FO.on && FO.dnd) return; // режим фокуса, "не беспокоить"
  try {
    uiCtx = uiCtx || new AudioContext();
    const notes = { message: [660], ok: [523, 784], remind: [784, 659, 784], error: [330, 262] }[kind] || [660];
    const t0 = uiCtx.currentTime + 0.01;
    notes.forEach((f, i) => {
      const o = uiCtx.createOscillator();
      const g = uiCtx.createGain();
      o.type = 'sine';
      o.frequency.value = f;
      const t = t0 + i * 0.09;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.06, t + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
      o.connect(g).connect(uiCtx.destination);
      o.start(t);
      o.stop(t + 0.25);
    });
  } catch {
    /* звука нет */
  }
}

// ---------- карточки в профиле ----------

async function saveLook(patch) {
  try {
    const s = await call(studio.settings.set(patch));
    applyLook(s);
    if (typeof onMusicSettings === 'function') onMusicSettings(s);
    renderLookSettings(s);
  } catch (err) {
    toast(errText(err.code));
  }
}

function segOf(items, current, onPick) {
  return h('div', { class: 'seg seg-inline' }, ...items.map(([v, t]) => h('button', {
    class: 'seg-btn' + (v === current ? ' is-on' : ''), type: 'button', text: t, onclick: () => onPick(v),
  })));
}

function checkOf(text, on, onChange) {
  const box = h('input', { type: 'checkbox' });
  box.checked = on;
  box.addEventListener('change', () => onChange(box.checked));
  return h('label', { class: 'check' }, box, h('span', { text }));
}

async function renderLookSettings(s) {
  s = s || (await call(studio.settings.get()));
  const look = $('look-settings');
  if (!look) return;
  look.innerHTML = '';
  const dim = h('input', { type: 'range', min: '0', max: '80', step: '5', value: String(s.bgDim) });
  dim.addEventListener('input', () => applyLook({ bgDim: Number(dim.value) }));
  dim.addEventListener('change', () => saveLook({ bgDim: Number(dim.value) }));
  look.append(
    checkOf('Картинка сезона на фоне главной и входа', s.bgImage, (v) => saveLook({ bgImage: v })),
    checkOf('Частицы сезона поверх картинки: снег, листья, лепестки, светлячки', s.particles, (v) => saveLook({ particles: v })),
    h('div', { class: 'field' }, h('span', { text: 'Затемнение картинки: ' + s.bgDim + '%' }), dim),
    h('div', { class: 'field' }, h('span', { text: 'Анимации' }),
      segOf([['auto', 'Как в Windows'], ['all', 'Все'], ['soft', 'Мягкие'], ['off', 'Выключены']], s.motion, (v) => saveLook({ motion: v }))),
    checkOf('Короткий праздник: подтверждённый отчёт, цель месяца, первый переход по ссылке', s.celebrate, (v) => saveLook({ celebrate: v })),
    checkOf('Экран "Сегодня" при первом входе за день (открыть снова: кнопка "Сегодня" вверху)', s.todayScreen, (v) => saveLook({ todayScreen: v })),
    h('div', { class: 'field' }, h('span', { text: 'Масштаб интерфейса' }),
      segOf([[90, '90%'], [100, '100%'], [110, '110%'], [125, '125%']], s.zoom, (v) => saveLook({ zoom: v }))),
  );

  const snd = $('sound-settings');
  snd.innerHTML = '';
  snd.append(
    checkOf('Включать музыку при запуске приложения', s.musicAuto, (v) => saveLook({ musicAuto: v })),
    checkOf('Останавливать музыку, когда приложение свёрнуто', s.musicPauseMin, (v) => saveLook({ musicPauseMin: v })),
    checkOf('Тихие звуки интерфейса: новое сообщение, подтверждённый отчёт, напоминание', s.uiSounds, (v) => { saveLook({ uiSounds: v }); if (v) setTimeout(() => uiSound('ok'), 50); }),
    h('p', { class: 'muted small', text: 'Источник музыки, свою папку, радио и фоновые звуки выбирают в плеере: нажмите на название трека в полосе заголовка.' }),
  );

  const wins = $('win-settings');
  wins.innerHTML = '';
  const gpuLine = h('p', { class: 'muted small', text: 'Видеокарта: проверяю...' });
  wins.append(
    h('div', { class: 'field' }, h('span', { text: 'Редакторы и запуск проектов открывать' }),
      segOf([['window', 'Окном'], ['maximized', 'Развёрнутыми'], ['fullscreen', 'Во весь экран']], s.editorsMode, (v) => saveLook({ editorsMode: v }))),
    h('p', { class: 'muted small', text: 'F11 в любом окне студии: во весь экран и обратно. Размер и положение главного окна запоминаются.' }),
    checkOf('Мощная видеокарта, если в компьютере их две (ноутбуки с NVIDIA или AMD)', s.gpuHigh, (v) => saveLook({ gpuHigh: v })),
    checkOf('Аппаратное ускорение (выключать, только если окна мигают или рисуются с ошибками)', s.gpuAccel, (v) => saveLook({ gpuAccel: v })),
    gpuLine,
    s.restartNeeded ? h('div', { class: 'row gap-s' },
      h('span', { class: 'small', text: 'Видеокарта поменяется после перезапуска.' }),
      h('button', { class: 'btn btn-s btn-accent', type: 'button', text: 'Перезапустить', onclick: () => studio.app.relaunch() }),
    ) : null,
  );
  try {
    LOOK.gpu = LOOK.gpu || (await call(studio.app.gpu()));
    gpuLine.textContent = LOOK.gpu.accelerated
      ? 'Сейчас рисует: ' + (LOOK.gpu.name || 'видеокарта (название не определилось)')
      : 'Сейчас рисует процессор: аппаратное ускорение выключено или недоступно.';
  } catch {
    gpuLine.textContent = '';
  }
}

async function initLook(s) {
  applyLook(s);
  if (typeof initPlayer === 'function') initPlayer(s);
  if (typeof initSeasonFx === 'function') initSeasonFx();
}

// ---------- заготовки вместо "Загрузка..." ----------

// Серые полосы на месте будущего содержимого. kind: card (карточка со строками),
// lines (строки внутри блока), tiles (ряд плиток и график, для "Команды").
function skeleton(kind = 'card', n = 3) {
  const line = (w) => {
    const el = h('div', { class: 'sk sk-line' });
    el.style.width = w + '%';
    return el;
  };
  const widths = [92, 76, 84, 60, 70, 88];
  if (kind === 'lines') return h('div', { class: 'sk-lines' }, ...Array.from({ length: n }, (_, i) => line(widths[i % widths.length])));
  if (kind === 'tiles') {
    return h('div', { class: 'sk-wrap' },
      h('div', { class: 'tiles' }, ...Array.from({ length: 4 }, () => h('div', { class: 'tile' }, line(50), h('div', { class: 'sk sk-big' }), line(70)))),
      h('div', { class: 'card' }, line(25), h('div', { class: 'sk sk-chart' })),
    );
  }
  return h('div', { class: 'sk-wrap' }, ...Array.from({ length: Math.max(1, Math.round(n / 3)) }, () => h('div', { class: 'card' }, h('div', { class: 'sk sk-title' }), ...Array.from({ length: n }, (_, i) => line(widths[i % widths.length])))));
}

// Плавное появление раздела или вкладки (только прозрачность: сдвиг сломал бы
// окна с position: fixed внутри раздела).
function fadeIn(el) {
  if (!el || motionLevel() === 'off') return;
  el.classList.remove('view-enter');
  void el.offsetWidth;
  el.classList.add('view-enter');
}
