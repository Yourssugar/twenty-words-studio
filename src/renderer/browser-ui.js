'use strict';
// Панель встроенного браузера: вкладки, адресная строка, закладки.
// Сами сайты показывает главный процесс поверх этой страницы (src/main/browser.js).

const $ = (id) => document.getElementById(id);

function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

const ICO = {
  back: '<svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>',
  fwd: '<svg viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"/></svg>',
  reload: '<svg viewBox="0 0 24 24"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/></svg>',
  stop: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  home: '<svg viewBox="0 0 24 24"><path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z"/></svg>',
  star: '<svg viewBox="0 0 24 24"><path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z"/></svg>',
  plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  x: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  pen: '<svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4"/></svg>',
  sound: '<svg viewBox="0 0 24 24"><path d="M4 9h4l5-4v14l-5-4H4zM16 9a4 4 0 0 1 0 6M18.5 6.5a7.5 7.5 0 0 1 0 11"/></svg>',
  muted: '<svg viewBox="0 0 24 24"><path d="M4 9h4l5-4v14l-5-4H4zM16 9l5 6M21 9l-5 6"/></svg>',
};
const svg = (name) => {
  const s = h('span', { class: 'b-svg' });
  s.innerHTML = ICO[name];
  return s.firstChild;
};
const setIco = (el, name) => {
  el.innerHTML = ICO[name];
};

const B = { state: null, editing: null, adding: false, drag: null };
const cmd = (a) => window.twb.cmd(a).then((r) => {
  if (r && !r.ok && r.error === 'too_many') toast('Закладок слишком много, удалите лишние.');
  if (r && !r.ok && r.error === 'bad_url') toast('Адрес не подходит: нужен сайт на http или https.');
  return r;
});

function letter(text, cls) {
  return h('span', { class: cls, text: (String(text || '?').replace(/^www\./, '').trim()[0] || '?').toUpperCase() });
}

// ---------- тема ----------

function applyBrowserTheme(t) {
  for (const x of t.extra || []) if (!THEMES.some((y) => y.id === x.id)) THEMES.push(x);
  applyTheme(t.theme);
  // Кнопки окна рисует Windows: красим их под полосу вкладок.
  requestAnimationFrame(() => {
    const cs = getComputedStyle($('b-tabs'));
    const color = cssHex(cs.backgroundColor);
    const symbol = cssHex(getComputedStyle(document.body).color);
    if (color && symbol) cmd({ cmd: 'titlebar', color, symbol });
  });
}

function cssHex(v) {
  const n = (v.match(/[\d.]+/g) || []).map(Number);
  if (n.length < 3) return '';
  const k = /^color\(/.test(v) ? 255 : 1;
  return '#' + n.slice(0, 3).map((x) => Math.round(Math.min(255, x * k)).toString(16).padStart(2, '0')).join('');
}

// ---------- вкладки ----------

function renderTabs() {
  const s = B.state;
  const list = $('b-tab-list');
  list.innerHTML = '';
  const narrow = s.tabs.length > 9;
  s.tabs.forEach((t, i) => {
    const ico = h('span', { class: 'b-tab-ico' });
    if (t.loading) ico.append(h('span', { class: 'b-spin' }));
    else if (t.icon) ico.append(h('img', { src: t.icon, alt: '' }));
    else ico.append(letter(t.start ? '+' : t.title, 'b-letter'));
    const sound = t.audible || t.muted
      ? h('button', { class: 'b-tab-sound' + (t.muted ? ' is-muted' : ''), type: 'button', title: t.muted ? 'Включить звук' : 'Выключить звук', onclick: (e) => {
        e.stopPropagation();
        cmd({ cmd: 'mute', id: t.id });
      } }, svg(t.muted ? 'muted' : 'sound'))
      : null;
    const el = h('div', {
      class: 'b-tab' + (t.id === s.active ? ' is-on' : '') + (narrow ? ' narrow' : ''),
      title: t.title + (t.url ? '\n' + t.url : ''),
      draggable: 'true',
      onmousedown: (e) => {
        if (e.button === 0) cmd({ cmd: 'activate', id: t.id });
      },
      onauxclick: (e) => {
        if (e.button === 1) cmd({ cmd: 'close', id: t.id });
      },
      ondragstart: (e) => {
        B.drag = t.id;
        e.dataTransfer.effectAllowed = 'move';
      },
      ondragover: (e) => {
        if (B.drag === null) return;
        e.preventDefault();
        el.classList.add('drag-over');
      },
      ondragleave: () => el.classList.remove('drag-over'),
      ondrop: (e) => {
        e.preventDefault();
        el.classList.remove('drag-over');
        if (B.drag !== null && B.drag !== t.id) cmd({ cmd: 'move', id: B.drag, to: i });
        B.drag = null;
      },
      ondragend: () => {
        B.drag = null;
      },
    },
    ico,
    h('span', { class: 'b-tab-title', text: t.title }),
    sound,
    h('button', { class: 'b-tab-x', type: 'button', title: 'Закрыть (Ctrl+W)', onmousedown: (e) => e.stopPropagation(), onclick: () => cmd({ cmd: 'close', id: t.id }) }, svg('x')));
    list.append(el);
  });
}

// ---------- панель адреса ----------

function renderBar() {
  const s = B.state;
  const t = s.tabs.find((x) => x.id === s.active) || {};
  $('b-back').disabled = !(s.canBack || s.backToPage);
  $('b-fwd').disabled = !s.canFwd;
  setIco($('b-reload'), t.loading ? 'stop' : 'reload');
  $('b-reload').title = t.loading ? 'Остановить' : 'Обновить (F5)';
  $('b-reload').disabled = !!t.start;
  $('b-home').classList.toggle('is-on', !!t.start);
  const addr = $('b-addr');
  if (document.activeElement !== addr) addr.value = t.start ? '' : t.url || '';
  $('b-mark').disabled = !!t.start;
  $('b-mark').classList.toggle('is-on', s.marked);
  $('b-mark').title = s.marked ? 'Убрать из закладок (Ctrl+D)' : 'Добавить в закладки (Ctrl+D)';
  $('b-zoom').hidden = s.zoom === 100 || !!t.start;
  $('b-zoom').textContent = s.zoom + '%';
  $('b-start').hidden = !t.start;
  $('b-error').hidden = !(t.error && !t.start);
  if (t.error && !t.start) {
    $('b-error-title').textContent = t.error.code === 'crash' ? 'Страница упала' : 'Страница не открылась';
    $('b-error-text').textContent = (t.error.code === 'crash' ? '' : t.error.desc + '\n') + (t.error.url || '');
  }
  document.title = t.start ? 'Браузер' : (t.title || 'Браузер') + ' · Браузер';
}

// ---------- закладки ----------

// Большие плитки студии: сайт и канал. Не удаляются, задаются в data/config.json.
function renderStudio() {
  const box = $('b-studio');
  box.innerHTML = '';
  for (const x of B.state.studio || []) {
    const ico = h('span', { class: 'b-studio-ico' });
    ico.append(x.icon ? h('img', { src: x.icon, alt: '' }) : letter(x.name, 'b-big-letter'));
    box.append(h('div', {
      class: 'b-studio-card',
      title: x.host,
      tabindex: '0',
      onclick: (e) => cmd({ cmd: 'openStudio', id: x.id, newTab: e.ctrlKey || e.metaKey, background: e.ctrlKey || e.metaKey }),
      onauxclick: (e) => {
        if (e.button === 1) cmd({ cmd: 'openStudio', id: x.id, newTab: true, background: true });
      },
      onkeydown: (e) => {
        if (e.key === 'Enter') cmd({ cmd: 'openStudio', id: x.id });
      },
    }, ico, h('span', { class: 'b-studio-text' }, h('span', { class: 'b-studio-name', text: x.name }), h('span', { class: 'b-mark-host', text: x.sub || x.host }))));
  }
  box.hidden = !box.children.length;
}

function renderMarks() {
  const s = B.state;
  const box = $('b-marks');
  box.innerHTML = '';
  for (const m of s.marks) {
    if (B.editing === m.id) {
      box.append(markForm({ name: m.name, url: m.url, id: m.id }));
      continue;
    }
    const ico = h('span', { class: 'b-mark-ico' });
    ico.append(m.icon ? h('img', { src: m.icon, alt: '' }) : letter(m.name, 'b-big-letter'));
    box.append(h('div', {
      class: 'b-mark',
      title: m.url,
      tabindex: '0',
      onclick: (e) => cmd({ cmd: 'openMark', id: m.id, newTab: e.ctrlKey || e.metaKey, background: e.ctrlKey || e.metaKey }),
      onauxclick: (e) => {
        if (e.button === 1) cmd({ cmd: 'openMark', id: m.id, newTab: true, background: true });
      },
      onkeydown: (e) => {
        if (e.key === 'Enter') cmd({ cmd: 'openMark', id: m.id });
      },
    },
    ico,
    h('span', { class: 'b-mark-name', text: m.name }),
    h('span', { class: 'b-mark-host', text: m.host }),
    h('span', { class: 'b-mark-tools' },
      h('button', { type: 'button', title: 'Переименовать', onclick: (e) => {
        e.stopPropagation();
        B.editing = m.id;
        B.adding = false;
        renderMarks();
      } }, svg('pen')),
      h('button', { type: 'button', title: 'Удалить закладку', onclick: (e) => {
        e.stopPropagation();
        cmd({ cmd: 'delMark', id: m.id });
      } }, svg('x')))));
  }
  if (B.adding) box.append(markForm({ name: '', url: '' }));
  else {
    box.append(h('div', { class: 'b-mark b-mark-add', tabindex: '0', onclick: () => {
      B.adding = true;
      B.editing = null;
      renderMarks();
    } }, h('span', { class: 'b-mark-ico' }, svg('plus')), h('span', { class: 'b-mark-name', text: 'Добавить' })));
  }
  $('b-reset').hidden = !s.missingDefaults;
}

function markForm({ id, name, url }) {
  const nameIn = h('input', { placeholder: 'Название', maxlength: '40', value: name });
  const urlIn = id ? null : h('input', { placeholder: 'Адрес, например tiktok.com', spellcheck: 'false', value: url });
  const done = () => {
    B.editing = null;
    B.adding = false;
    renderMarks();
  };
  const save = async () => {
    if (id) await cmd({ cmd: 'renameMark', id, name: nameIn.value });
    else {
      if (!urlIn.value.trim()) return urlIn.focus();
      const r = await cmd({ cmd: 'addMark', name: nameIn.value, url: urlIn.value });
      if (!r.ok) return;
    }
    done();
  };
  const onKey = (e) => {
    if (e.key === 'Enter') save();
    if (e.key === 'Escape') done();
  };
  nameIn.addEventListener('keydown', onKey);
  if (urlIn) urlIn.addEventListener('keydown', onKey);
  const form = h('div', { class: 'b-mark b-mark-form' },
    nameIn,
    urlIn,
    h('div', { class: 'b-row' },
      h('button', { class: 'b-btn', type: 'button', text: 'Отмена', onclick: done }),
      h('button', { class: 'b-btn b-btn-accent', type: 'button', text: 'Сохранить', onclick: save })));
  setTimeout(() => (urlIn && !id ? urlIn : nameIn).focus(), 0);
  return form;
}

// ---------- уведомления ----------

function toast(text, file) {
  const el = h('div', { class: 'b-toast' }, h('span', { text }));
  if (file) el.append(h('button', { class: 'b-link', type: 'button', text: 'Показать в папке', onclick: () => cmd({ cmd: 'showFile', file }) }));
  const box = $('b-toasts');
  box.prepend(el);
  while (box.children.length > 2) box.lastChild.remove();
  setTimeout(() => el.remove(), 6000);
}

// ---------- события ----------

function render(s) {
  B.state = s;
  renderTabs();
  renderBar();
  renderStudio();
  renderMarks();
}

for (const [id, ico] of [['b-back', 'back'], ['b-fwd', 'fwd'], ['b-reload', 'reload'], ['b-home', 'home'], ['b-mark', 'star'], ['b-newtab', 'plus']]) setIco($(id), ico);

$('b-back').addEventListener('click', () => cmd({ cmd: 'back' }));
$('b-fwd').addEventListener('click', () => cmd({ cmd: 'fwd' }));
$('b-reload').addEventListener('click', () => {
  const t = B.state && B.state.tabs.find((x) => x.id === B.state.active);
  cmd({ cmd: t && t.loading ? 'stop' : 'reload' });
});
$('b-home').addEventListener('click', () => cmd({ cmd: 'home' }));
$('b-mark').addEventListener('click', () => cmd({ cmd: 'mark' }));
$('b-newtab').addEventListener('click', () => cmd({ cmd: 'new' }));
$('b-zoom').addEventListener('click', () => cmd({ cmd: 'zoom', dir: 0 }));
$('b-reset').addEventListener('click', () => cmd({ cmd: 'resetMarks' }));
$('b-error-retry').addEventListener('click', () => cmd({ cmd: 'reload' }));
$('b-tabs').addEventListener('dblclick', (e) => {
  if (e.target === $('b-tabs') || e.target === $('b-tab-list')) cmd({ cmd: 'new' });
});

const go = (input, e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  cmd({ cmd: 'go', text });
  input.blur();
};
$('b-addr-form').addEventListener('submit', (e) => go($('b-addr'), e));
$('b-search-form').addEventListener('submit', (e) => {
  go($('b-search'), e);
  $('b-search').value = '';
});
$('b-addr').addEventListener('focus', () => $('b-addr').select());
$('b-addr').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    renderBar();
    $('b-addr').blur();
  }
});

// Горячие клавиши (Ctrl+T, Ctrl+W, F5 и другие) ловит главный процесс до страницы: см. key() в browser.js.

window.twb.onState(render);
window.twb.onToast((t) => toast(t.text, t.file));
window.twb.onTheme(applyBrowserTheme);
window.twb.onFocus(() => {
  const t = B.state && B.state.tabs.find((x) => x.id === B.state.active);
  const input = t && t.start ? $('b-search') : $('b-addr');
  input.focus();
  input.select();
});

window.twb.init().then((r) => {
  if (!r.ok) return;
  applyBrowserTheme(r.data);
  render(r.data.state);
  const t = r.data.state.tabs.find((x) => x.id === r.data.state.active);
  if (t && t.start) $('b-search').focus();
});
