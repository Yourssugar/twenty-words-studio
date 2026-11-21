'use strict';
// Раздел "Проекты": личные наборы текстовых файлов (html, css, js, json, md...).
// Файлы лежат на сервере. Здесь граф файлов: человек сам расставляет их и
// рисует связи. Связи и описания нужны только человеку, в модель уходят
// выбранный файл и его соседи по связям. Проект запускается целиком в
// отдельном окне (см. main/runner.js), снимок проекта можно отправить в тему.

const PJ = {
  list: [],
  loaded: false,
  cache: new Map(), // id проекта -> полный проект с файлами
  cur: null, // открытый проект или снимок: { id, title, kind, net, fileList, links, snap? }
  sel: 0, // id выбранного файла
  draft: null, // { id, body } несохранённый текст в редакторе
  logs: new Map(), // ключ запуска -> строки консоли
  consoleOpen: false,
  running: new Set(), // ключи открытых окон запуска
  pending: null, // что открыть при входе в раздел: { project, file } или { snap }
};

const PG = {
  canvas: null,
  ctx: null,
  w: 0,
  h: 0,
  dpr: 1,
  view: { x: 0, y: 0, z: 1 },
  drag: null,
  hover: 0,
  mouse: null,
  boxes: new Map(), // id файла -> {x, y, w, h} на экране
  needFit: false, // подогнать масштаб, как только станет известен размер поля
};

Object.assign(ERRORS, {
  bad_path: 'Имя файла: буквы, цифры, точка, дефис и _, папки через /. Без пробелов и без точки в начале.',
  bad_ext: 'Можно только файлы html, css, js, json, md, txt, svg.',
  exists: 'Файл с таким именем уже есть.',
  not_text: 'Это не текстовый файл.',
  too_big: 'Слишком большой: файл до 256 КБ, весь проект до 4 МБ.',
  empty: 'Пусто.',
  bad_input: 'Неверные данные.',
  rate_limited: 'Слишком часто. Подождите немного.',
  no_access: 'Нет доступа к этой комнате.',
});

const EXT_COLORS = { html: '#e9a23b', htm: '#e9a23b', css: '#4fa3ff', js: '#f0d54a', mjs: '#f0d54a', json: '#3fb68b', md: '#a371f7', txt: '#8b8e98', svg: '#ff7eb6' };
const extOf = (p) => (p.match(/\.([a-z0-9]+)$/i) || ['', ''])[1].toLowerCase();
const baseOf = (p) => p.split('/').pop();
const approxTokens = (s) => Math.round([...s].length / 3) + 4;
const fmtSize = (n) => (n >= 1024 * 1024 ? (n / 1024 / 1024).toFixed(1).replace('.', ',') + ' МБ' : n >= 1024 ? Math.round(n / 1024) + ' КБ' : n + ' Б');
const runKey = () => (PJ.cur ? (PJ.cur.snap ? 's' : 'p') + PJ.cur.id : '');
const isOwn = () => PJ.cur && !PJ.cur.snap;
const fileById = (id) => (PJ.cur ? PJ.cur.fileList.find((f) => f.id === id) : null);
const textBytes = (s) => new TextEncoder().encode(s).length;

// Язык блока кода -> расширение файла.
function extForLang(lang) {
  const l = (lang || '').toLowerCase();
  const map = { html: 'html', htm: 'html', xml: 'svg', svg: 'svg', css: 'css', js: 'js', javascript: 'js', mjs: 'js', json: 'json', md: 'md', markdown: 'md' };
  return map[l] || (l ? 'txt' : 'md');
}

// ---------- данные ----------

async function pjLoadList() {
  PJ.list = await call(studio.projects.list());
  PJ.loaded = true;
  return PJ.list;
}

async function pjFull(id, fresh) {
  if (!fresh && PJ.cache.has(id)) return PJ.cache.get(id);
  const p = await call(studio.projects.get(id));
  PJ.cache.set(id, p);
  return p;
}

function pjSyncListEntry(p) {
  const i = PJ.list.findIndex((x) => x.id === p.id);
  const entry = { id: p.id, title: p.title, kind: p.kind, net: p.net, origin: p.origin, files: p.fileList ? p.fileList.length : p.files, size: p.fileList ? p.fileList.reduce((n, f) => n + textBytes(f.body), 0) : p.size, updated: Date.now() };
  if (i >= 0) PJ.list[i] = { ...PJ.list[i], ...entry };
  else PJ.list.unshift(entry);
}

const draftsId = () => (PJ.list.find((p) => p.kind === 'drafts') || {}).id;

// Сохранить текст в проект как новый файл. Используется и ассистентом.
async function pjSaveAsFile(projectId, { path, ext, body }) {
  const f = await call(studio.projects.addFile(projectId, { path, ext, body }));
  const full = PJ.cache.get(projectId);
  if (full) full.fileList.push(f);
  const e = PJ.list.find((x) => x.id === projectId);
  if (e) e.files = (e.files || 0) + 1;
  if (PJ.cur && PJ.cur.id === projectId && !PJ.cur.snap) drawGraph();
  return f;
}

async function pjSaveToDrafts(ext, body) {
  if (!PJ.loaded) await pjLoadList();
  const id = draftsId();
  if (!id) throw Object.assign(new Error('not_found'), { code: 'not_found' });
  return pjSaveAsFile(id, { ext, body });
}

// Перезаписать существующий файл (из ассистента, "в проект" с тем же именем).
async function pjOverwrite(projectId, file, body) {
  const f = await call(studio.projects.editFile(file.id, { body }));
  Object.assign(file, f);
  if (PJ.cur && PJ.cur.id === projectId && PJ.sel === file.id) {
    PJ.draft = null;
    renderFilePanel();
  }
  return f;
}

// Соседи файла по связям.
function neighborsOf(p, id) {
  const out = [];
  for (const [a, b] of p.links) {
    if (a === id) out.push(b);
    else if (b === id) out.push(a);
  }
  return out;
}

// ---------- вход в раздел ----------

async function openProjects() {
  const want = PJ.pending;
  PJ.pending = null;
  try {
    if (!PJ.loaded) await pjLoadList();
    if (want && want.snap) await openSnap(want.snap);
    else if (want && want.project) await selectProject(want.project, want.file);
    else if (!PJ.cur && PJ.list.length) await selectProject(PJ.list[0].id);
  } catch (err) {
    toast(errText(err.code));
  }
  renderProjects();
  requestAnimationFrame(() => {
    resizeGraph();
    drawGraph();
  });
}

// Открыть раздел на нужном проекте, файле или снимке (из ассистента и из тем).
function openProjectsView({ project, file, snap } = {}) {
  PJ.pending = { project, file, snap };
  if (S.view === 'projects') openProjects();
  else setView('projects');
}

async function selectProject(id, fileId) {
  await flushDraft();
  const p = await pjFull(id, true);
  PJ.cur = p;
  PJ.sel = fileId || 0;
  PJ.draft = null;
  PG.needFit = true;
  renderProjects();
}

async function openSnap(id) {
  await flushDraft();
  const sn = await call(studio.projects.snap(id));
  // В снимке у файлов нет своих id: нумеруем по порядку, связи хранятся номерами.
  const files = sn.files.map((f, i) => ({ id: i + 1, path: f.path, body: f.body, descr: f.descr, x: f.x, y: f.y }));
  PJ.cur = { id: sn.id, snap: true, title: sn.title, owner: sn.owner, created: sn.created, fileList: files, links: sn.links.map(([a, b]) => [a + 1, b + 1]), net: false };
  PJ.sel = 0;
  PJ.draft = null;
  PG.needFit = true;
  renderProjects();
}

// ---------- отрисовка раздела ----------

function renderProjects() {
  renderProjectList();
  renderProjectHead();
  renderFilePanel();
  renderConsole();
  drawGraph();
}

function renderProjectList() {
  const box = $('proj-list');
  box.innerHTML = '';
  for (const p of PJ.list) {
    const on = PJ.cur && !PJ.cur.snap && PJ.cur.id === p.id;
    box.append(h('button', { class: 'item' + (on ? ' is-on' : ''), onclick: () => selectProject(p.id).catch((e) => toast(errText(e.code))) },
      h('span', { class: 'item-name', text: p.title }),
      p.kind === 'drafts' ? h('span', { class: 'tag', text: 'черновики' }) : p.net ? h('span', { class: 'tag', text: 'сеть' }) : null,
      h('span', { class: 'muted small', text: String(p.files || 0) }),
    ));
  }
  if (PJ.cur && PJ.cur.snap) {
    box.append(h('div', { class: 'side-group', text: 'Открыт снимок' }),
      h('button', { class: 'item is-on' }, h('span', { class: 'item-name', text: PJ.cur.title }), h('span', { class: 'tag', text: 'снимок' })));
  }
}

function renderProjectHead() {
  const p = PJ.cur;
  $('proj-title').textContent = p ? p.title : 'Проекты';
  const sub = $('proj-sub');
  const tools = $('proj-tools');
  tools.innerHTML = '';
  if (!p) {
    sub.textContent = 'Создайте проект слева.';
    return;
  }
  const size = p.fileList.reduce((n, f) => n + textBytes(f.body), 0);
  if (p.snap) {
    const u = S.users.get(p.owner);
    sub.textContent = 'Снимок от ' + (u ? u.name : 'участника') + ', ' + dayLabel(p.created) + ' ' + timeOf(p.created) + ' · ' + p.fileList.length + ' файлов · только чтение, запуск без сети';
  } else {
    sub.textContent = p.fileList.length + ' файлов · ' + fmtSize(size) + (p.kind === 'drafts' ? ' · сюда попадает всё, что вы сохраняете из ответов ассистента' : '');
  }
  const running = PJ.running.has(runKey());
  const runBtn = h('button', { class: 'btn btn-accent btn-s', type: 'button', text: running ? 'Перезапустить' : 'Запустить', title: 'Открыть проект как сайт в отдельном окне. F5 в окне: перезапуск, F12: инструменты разработчика', onclick: runCurrent });
  if (p.snap) {
    tools.append(
      runBtn,
      h('button', { class: 'btn btn-s', type: 'button', text: 'Взять себе', title: 'Личная копия: можно править и дорабатывать', onclick: takeSnap }),
      h('button', { class: 'btn btn-s', type: 'button', text: 'Закрыть снимок', onclick: () => { PJ.cur = null; openProjects(); } }),
    );
    return;
  }
  const net = h('input', { type: 'checkbox' });
  net.checked = !!p.net;
  net.addEventListener('change', () => setNet(net));
  // append() печатает null как текст: пустые кнопки отсекаем.
  tools.append(...[
    h('button', { class: 'btn btn-s', type: 'button', text: 'Новый файл', onclick: () => newFile() }),
    runBtn,
    h('label', { class: 'check proj-net', title: 'Разрешить запущенному проекту ходить в интернет (CDN, внешние API). Сервер студии закрыт всегда.' }, net, 'Сеть'),
    h('button', { class: 'btn btn-s', type: 'button', text: 'В тему', title: 'Отправить снимок проекта в обсуждение', onclick: () => shareProject() }),
    p.kind !== 'drafts' ? h('button', { class: 'btn btn-s', type: 'button', text: 'Переименовать', onclick: renameProject }) : null,
    p.kind !== 'drafts' ? h('button', { class: 'btn btn-s btn-danger-ghost', type: 'button', text: 'Удалить', onclick: deleteProject }) : null,
  ].filter(Boolean));
}

// ---------- редактор файла ----------

function renderFilePanel() {
  const box = $('proj-file');
  const p = PJ.cur;
  box.innerHTML = '';
  if (!p) {
    box.append(h('div', { class: 'proj-help muted small', text: 'Проект: личный набор текстовых файлов. Картинки и звук сюда не входят.' }));
    return;
  }
  const f = fileById(PJ.sel);
  if (!f) {
    box.append(h('div', { class: 'proj-help' },
      h('div', { class: 'side-title', text: p.snap ? 'Снимок проекта' : 'Как работать' }),
      p.snap
        ? h('p', { class: 'muted small', text: 'Нажмите на файл, чтобы прочитать. Чтобы править, возьмите копию себе: в ней можно включить сеть и менять что угодно.' })
        : h('ul', { class: 'muted small' },
          h('li', { text: 'Двойной щелчок по пустому месту: новый файл.' }),
          h('li', { text: 'Перетаскивайте файлы, расставляйте как удобно.' }),
          h('li', { text: 'Shift + перетащить с файла на файл: связь. Ещё раз: связь убирается.' }),
          h('li', { text: 'Колесо мыши: масштаб, перетаскивание фона: сдвиг.' }),
          h('li', { text: 'Связи и описания видите только вы. В модель уходит выбранный файл и его соседи по связям.' }),
          h('li', { text: 'Запуск открывает проект в отдельном окне, с index.html.' }),
        ),
    ));
    return;
  }
  const own = isOwn();
  const body = PJ.draft && PJ.draft.id === f.id ? PJ.draft.body : f.body;
  const path = h('input', { class: 'mono', value: f.path, maxlength: '120', spellcheck: 'false', title: 'Имя файла. Enter: переименовать' });
  path.readOnly = !own;
  const descr = h('input', { value: f.descr || '', maxlength: '300', placeholder: own ? 'Описание для себя, в модель не уходит' : '' });
  descr.readOnly = !own;
  const ta = h('textarea', { class: 'proj-code', spellcheck: 'false', wrap: 'off' });
  ta.value = body;
  ta.readOnly = !own;
  const meta = h('div', { class: 'muted small' });
  const updateMeta = () => {
    const v = ta.value;
    meta.textContent = fmtSize(textBytes(v)) + ' · около ' + fmtTokens(approxTokens(v)) + ' токенов' + (PJ.draft && PJ.draft.id === f.id ? ' · не сохранено' : '');
  };
  updateMeta();
  if (own) {
    ta.addEventListener('input', () => {
      PJ.draft = { id: f.id, body: ta.value };
      updateMeta();
    });
    ta.addEventListener('keydown', (e) => {
      if (e.key === 's' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        saveFile();
      } else if (e.key === 'Tab' && !e.shiftKey) {
        e.preventDefault();
        ta.setRangeText('  ', ta.selectionStart, ta.selectionEnd, 'end');
        ta.dispatchEvent(new Event('input'));
      }
    });
    path.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        renameFile(f, path.value);
      } else if (e.key === 'Escape') path.value = f.path;
    });
    path.addEventListener('blur', () => {
      if (path.value.trim() !== f.path) renameFile(f, path.value);
    });
    descr.addEventListener('change', async () => {
      try {
        Object.assign(f, await call(studio.projects.editFile(f.id, { descr: descr.value })));
        drawGraph();
      } catch (err) {
        toast(errText(err.code));
      }
    });
  }
  const neigh = neighborsOf(p, f.id).map(fileById).filter(Boolean);
  const links = h('div', { class: 'proj-links' },
    h('span', { class: 'muted small', text: neigh.length ? 'Связан с:' : 'Связей нет' }),
    ...neigh.map((n) => h('span', { class: 'chip' }, h('span', { text: n.path, title: n.descr || '' }),
      own ? h('button', { class: 'chip-x', type: 'button', title: 'Убрать связь', text: 'x', onclick: () => toggleLink(f.id, n.id) }) : null)),
  );
  if (own) {
    const others = p.fileList.filter((x) => x.id !== f.id && !neigh.includes(x));
    if (others.length) {
      const sel = h('select', { class: 'proj-link-sel' }, h('option', { value: '', text: 'связать с...' }), ...others.map((x) => h('option', { value: String(x.id), text: x.path })));
      sel.addEventListener('change', () => sel.value && toggleLink(f.id, Number(sel.value)));
      links.append(sel);
    }
  }
  box.append(
    h('div', { class: 'proj-file-head' },
      h('span', { class: 'proj-ext', style: '--ext:' + (EXT_COLORS[extOf(f.path)] || '#8b8e98'), text: extOf(f.path) || 'txt' }),
      path,
      h('button', { class: 'btn btn-s', type: 'button', text: 'Закрыть', onclick: () => selectFile(0) }),
    ),
    own || f.descr ? descr : null,
    links,
    ta,
    meta,
    h('div', { class: 'row gap-s proj-file-foot' },
      own ? h('button', { class: 'btn btn-s', type: 'button', text: 'В чат', title: 'Приложить к сообщению ассистенту этот файл и его соседей по связям', onclick: () => sendToChat(f) }) : null,
      h('button', { class: 'btn btn-s', type: 'button', text: 'Копировать', onclick: async () => { await call(studio.app.copy(ta.value)); toast('Скопировано'); } }),
      own ? h('button', { class: 'btn btn-s btn-danger-ghost', type: 'button', text: 'Удалить', onclick: () => deleteFile(f) }) : null,
      h('div', { class: 'grow' }),
      own ? h('button', { class: 'btn btn-accent btn-s', type: 'button', text: 'Сохранить', title: 'Ctrl+S', onclick: saveFile }) : null,
    ),
  );
}

async function selectFile(id) {
  await flushDraft();
  PJ.sel = id;
  renderFilePanel();
  drawGraph();
}

// Несохранённый текст сохраняем молча при смене файла, проекта и перед запуском.
async function flushDraft() {
  if (!PJ.draft || !isOwn()) return true;
  const f = fileById(PJ.draft.id);
  if (!f || f.body === PJ.draft.body) {
    PJ.draft = null;
    return true;
  }
  try {
    Object.assign(f, await call(studio.projects.editFile(f.id, { body: PJ.draft.body })));
    PJ.draft = null;
    pjSyncListEntry(PJ.cur);
    return true;
  } catch (err) {
    toast(errText(err.code));
    return false;
  }
}

async function saveFile() {
  if (!PJ.draft) {
    toast('Сохранено');
    return;
  }
  if (await flushDraft()) {
    toast('Сохранено');
    renderFilePanel();
    renderProjectHead();
  }
}

async function renameFile(f, value) {
  const next = value.trim();
  if (!next || next === f.path) return;
  try {
    Object.assign(f, await call(studio.projects.editFile(f.id, { path: next })));
    renderFilePanel();
    drawGraph();
  } catch (err) {
    toast(errText(err.code));
    renderFilePanel();
  }
}

async function deleteFile(f) {
  if (!(await modal({ title: 'Удалить файл?', body: f.path + ' удалится из проекта вместе со связями. Снимки, уже отправленные в темы, не изменятся.', ok: 'Удалить', danger: true }))) return;
  try {
    await call(studio.projects.deleteFile(f.id));
    const p = PJ.cur;
    p.fileList = p.fileList.filter((x) => x.id !== f.id);
    p.links = p.links.filter(([a, b]) => a !== f.id && b !== f.id);
    if (PJ.draft && PJ.draft.id === f.id) PJ.draft = null;
    PJ.sel = 0;
    pjSyncListEntry(p);
    renderProjects();
  } catch (err) {
    toast(errText(err.code));
  }
}

async function newFile(x, y) {
  if (!isOwn()) return;
  const name = h('input', { class: 'mono', placeholder: 'index.html, style.css, js/app.js', maxlength: '120', spellcheck: 'false' });
  const hasIndex = PJ.cur.fileList.some((f) => f.path === 'index.html');
  name.value = hasIndex ? '' : 'index.html';
  const body = h('div', {},
    h('label', { class: 'field' }, h('span', { text: 'Имя файла' }), name),
    h('p', { class: 'muted small', text: 'Можно html, css, js, json, md, txt, svg. Папки через /, например css/style.css.' }),
  );
  setTimeout(() => name.select(), 30);
  if (!(await modal({ title: 'Новый файл', body, ok: 'Создать' }))) return;
  if (x === undefined) [x, y] = freeSpot();
  try {
    const f = await call(studio.projects.addFile(PJ.cur.id, { path: name.value, body: '', x, y }));
    PJ.cur.fileList.push(f);
    pjSyncListEntry(PJ.cur);
    await selectFile(f.id);
    renderProjects();
    setTimeout(() => document.querySelector('#proj-file .proj-code')?.focus(), 30);
  } catch (err) {
    toast(errText(err.code));
  }
}

async function toggleLink(a, b) {
  const p = PJ.cur;
  if (!isOwn() || a === b) return;
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  const i = p.links.findIndex(([x, y]) => x === lo && y === hi);
  try {
    await call(studio.projects.link(p.id, lo, hi, i < 0));
    if (i < 0) p.links.push([lo, hi]);
    else p.links.splice(i, 1);
    renderFilePanel();
    drawGraph();
  } catch (err) {
    toast(errText(err.code));
  }
}

// ---------- проект целиком ----------

async function newProject() {
  const title = h('input', { maxlength: '60', placeholder: 'Например: Лендинг мастерской' });
  setTimeout(() => title.focus(), 30);
  if (!(await modal({ title: 'Новый проект', body: h('label', { class: 'field' }, h('span', { text: 'Название' }), title), ok: 'Создать' }))) return;
  try {
    const p = await call(studio.projects.create(title.value));
    PJ.list.splice(1, 0, p);
    await selectProject(p.id);
  } catch (err) {
    toast(errText(err.code));
  }
}

async function renameProject() {
  const title = h('input', { maxlength: '60' });
  title.value = PJ.cur.title;
  setTimeout(() => title.select(), 30);
  if (!(await modal({ title: 'Название проекта', body: title, ok: 'Сохранить' }))) return;
  try {
    const p = await call(studio.projects.update(PJ.cur.id, { title: title.value }));
    PJ.cur.title = p.title;
    pjSyncListEntry(PJ.cur);
    renderProjects();
  } catch (err) {
    toast(errText(err.code));
  }
}

async function deleteProject() {
  const p = PJ.cur;
  if (!(await modal({ title: 'Удалить проект?', body: '"' + p.title + '" и все его файлы удалятся. Снимки, уже отправленные в темы, останутся.', ok: 'Удалить', danger: true }))) return;
  try {
    await call(studio.projects.remove(p.id));
    PJ.list = PJ.list.filter((x) => x.id !== p.id);
    PJ.cache.delete(p.id);
    PJ.cur = null;
    PJ.draft = null;
    openProjects();
  } catch (err) {
    toast(errText(err.code));
  }
}

async function setNet(cb) {
  try {
    const p = await call(studio.projects.update(PJ.cur.id, { net: cb.checked }));
    PJ.cur.net = p.net;
    pjSyncListEntry(PJ.cur);
    renderProjectList();
    toast(p.net ? 'Сеть для запуска включена. Применится при следующем запуске.' : 'Сеть для запуска выключена.');
  } catch (err) {
    cb.checked = !cb.checked;
    toast(errText(err.code));
  }
}

async function runCurrent() {
  const p = PJ.cur;
  if (!p) return;
  if (!p.fileList.length) {
    toast('В проекте нет файлов.');
    return;
  }
  if (!(await flushDraft())) return;
  const key = runKey();
  PJ.logs.set(key, []);
  try {
    const r = await call(p.snap ? studio.projects.runSnap(p.id) : studio.projects.run(p.id));
    PJ.running.add(key);
    if (!r.start) toast('В проекте нет html-файла: добавьте index.html.');
    renderProjectHead();
    renderConsole();
  } catch (err) {
    toast(errText(err.code));
  }
}

async function takeSnap() {
  try {
    const p = await call(studio.projects.copySnap(PJ.cur.id));
    PJ.list.splice(1, 0, p);
    toast('Копия "' + p.title + '" у вас в проектах');
    await selectProject(p.id);
  } catch (err) {
    toast(errText(err.code));
  }
}

// Куда отправить снимок: темы с главной и общие комнаты.
async function pickRoom() {
  let cards = typeof B !== 'undefined' && B.loaded ? [...B.cards.values()] : null;
  if (!cards) {
    try {
      cards = (await call(studio.board.get())).cards;
    } catch {
      cards = [];
    }
  }
  cards.sort((a, b) => (b.last || b.updated || 0) - (a.last || a.updated || 0));
  const sel = h('select', {},
    ...cards.map((c) => h('option', { value: 'card:' + c.id, text: 'Тема: ' + c.title })),
    h('option', { value: 'work', text: 'Рабочая зона' }),
    h('option', { value: 'free', text: 'Свободные темы' }),
  );
  return sel;
}

async function shareProject(room) {
  if (!(await flushDraft())) return;
  const p = PJ.cur;
  if (!p.fileList.length) {
    toast('В проекте нет файлов.');
    return;
  }
  const sel = room ? null : await pickRoom();
  const text = h('input', { maxlength: '300', placeholder: 'Пара слов к снимку (можно пусто)' });
  const body = h('div', {},
    h('p', { class: 'muted small', text: 'В тему уйдёт снимок: проект как он есть сейчас. Ваши правки после этого в снимке не появятся. Другие смогут открыть его, запустить без сети и взять себе копию.' }),
    sel ? h('label', { class: 'field' }, h('span', { text: 'Куда' }), sel) : null,
    h('label', { class: 'field' }, h('span', { text: 'Сообщение' }), text),
  );
  if (!(await modal({ title: 'Снимок "' + p.title + '"', body, ok: 'Отправить' }))) return;
  try {
    await call(studio.projects.share(p.id, room || sel.value, text.value));
    toast('Снимок отправлен');
  } catch (err) {
    toast(errText(err.code));
  }
}

// Из обсуждения темы: выбрать свой проект и отправить снимок сюда.
async function shareProjectTo(room) {
  try {
    if (!PJ.loaded) await pjLoadList();
  } catch (err) {
    toast(errText(err.code));
    return;
  }
  const own = PJ.list.filter((p) => (p.files || 0) > 0);
  if (!own.length) {
    toast('Нет проектов с файлами. Создайте проект в разделе "Проекты".');
    return;
  }
  const sel = h('select', {}, ...own.map((p) => h('option', { value: String(p.id), text: p.title + ' (' + p.files + ')' })));
  const text = h('input', { maxlength: '300', placeholder: 'Пара слов к снимку (можно пусто)' });
  const body = h('div', {},
    h('p', { class: 'muted small', text: 'Уйдёт снимок проекта как он есть сейчас. Остальные смогут открыть, запустить без сети и взять себе копию.' }),
    h('label', { class: 'field' }, h('span', { text: 'Проект' }), sel),
    h('label', { class: 'field' }, h('span', { text: 'Сообщение' }), text),
  );
  if (!(await modal({ title: 'Прикрепить проект', body, ok: 'Отправить' }))) return;
  try {
    await call(studio.projects.share(Number(sel.value), room, text.value));
  } catch (err) {
    toast(errText(err.code));
  }
}

// Карточка снимка в сообщении (чат и обсуждения тем).
function snapCard(s) {
  return h('div', { class: 'snap-card' },
    h('span', { class: 'proj-ext', style: '--ext:var(--accent)', text: 'проект' }),
    h('div', { class: 'grow' }, h('div', { class: 'snap-title', text: s.title }), h('div', { class: 'muted small', text: s.files + ' файлов, снимок' })),
    h('button', { class: 'btn btn-s', type: 'button', text: 'Открыть', onclick: () => openProjectsView({ snap: s.id }) }),
    h('button', { class: 'btn btn-s', type: 'button', text: 'Запустить', title: 'Без сети, в отдельном окне', onclick: async () => {
      try {
        await call(studio.projects.runSnap(s.id));
        PJ.running.add('s' + s.id);
      } catch (err) {
        toast(errText(err.code));
      }
    } }),
  );
}

// В ассистент: файл и его соседи по связям.
async function sendToChat(f) {
  if (!(await flushDraft())) return;
  const p = PJ.cur;
  const list = [f, ...neighborsOf(p, f.id).map(fileById).filter(Boolean)];
  if (typeof aiAttachFiles === 'function') aiAttachFiles(list.map((x) => ({ id: x.id, title: p.title + '/' + x.path, body: x.body })));
  setView('assistant');
}

// ---------- консоль запуска ----------

studio.projects.onLog((e) => {
  if (e.clear) {
    PJ.logs.set(e.key, []);
  } else {
    const list = PJ.logs.get(e.key) || [];
    list.push(e);
    if (list.length > 400) list.shift();
    PJ.logs.set(e.key, list);
    if (e.level === 'error' && e.key === runKey()) PJ.consoleOpen = true;
  }
  if (S.view === 'projects' && e.key === runKey()) renderConsole();
});

studio.projects.onClosed((e) => {
  PJ.running.delete(e.key);
  if (S.view === 'projects') renderProjectHead();
});

function renderConsole() {
  const box = $('proj-console');
  const logs = PJ.logs.get(runKey()) || [];
  const errors = logs.filter((l) => l.level === 'error').length;
  const btn = $('proj-console-btn');
  btn.textContent = 'Консоль' + (logs.length ? ' (' + logs.length + (errors ? ', ошибок ' + errors : '') + ')' : '');
  btn.classList.toggle('is-over', errors > 0);
  btn.hidden = !PJ.cur;
  box.hidden = !PJ.consoleOpen || !PJ.cur;
  if (box.hidden) return;
  box.innerHTML = '';
  box.append(h('div', { class: 'proj-console-head' },
    h('b', { text: 'Консоль запуска' }),
    h('span', { class: 'muted small', text: logs.length ? '' : 'Пока пусто. Здесь будут console.log, ошибки и заблокированные запросы.' }),
    h('div', { class: 'grow' }),
    isOwn() && logs.length ? h('button', { class: 'btn btn-s', type: 'button', text: 'Ошибки в чат', title: 'Вставить ошибки в сообщение ассистенту', onclick: errorsToChat }) : null,
    h('button', { class: 'btn btn-s', type: 'button', text: 'Очистить', onclick: () => { PJ.logs.set(runKey(), []); renderConsole(); } }),
    h('button', { class: 'btn btn-s', type: 'button', text: 'Скрыть', onclick: () => { PJ.consoleOpen = false; renderConsole(); } }),
  ));
  const list = h('div', { class: 'proj-console-log mono' });
  for (const l of logs) {
    list.append(h('div', { class: 'cl cl-' + l.level }, h('span', { class: 'cl-text', text: l.text }), l.source ? h('span', { class: 'cl-src', text: l.source }) : null));
  }
  box.append(list);
  list.scrollTop = list.scrollHeight;
}

function errorsToChat() {
  const logs = (PJ.logs.get(runKey()) || []).filter((l) => l.level !== 'info');
  const lines = (logs.length ? logs : PJ.logs.get(runKey()) || []).slice(-30).map((l) => (l.source ? l.source + ': ' : '') + l.text);
  const f = fileById(PJ.sel);
  const files = f ? [f, ...neighborsOf(PJ.cur, f.id).map(fileById).filter(Boolean)] : [];
  if (typeof aiAttachFiles === 'function' && files.length) aiAttachFiles(files.map((x) => ({ id: x.id, title: PJ.cur.title + '/' + x.path, body: x.body })));
  if (typeof aiPrefill === 'function') aiPrefill('При запуске проекта "' + PJ.cur.title + '" в консоли:\n' + lines.join('\n') + '\n\nВ чём причина и как исправить?');
  setView('assistant');
}

$('proj-console-btn').addEventListener('click', () => {
  PJ.consoleOpen = !PJ.consoleOpen;
  renderConsole();
});
$('proj-new').addEventListener('click', newProject);

// ---------- граф ----------

// Свободное место рядом с центром экрана, чтобы новый файл было видно сразу.
function freeSpot() {
  const files = PJ.cur ? PJ.cur.fileList : [];
  const cx = Math.round(PG.view.x);
  const cy = Math.round(PG.view.y);
  for (let ring = 0; ring < 12; ring++) {
    for (let i = -ring; i <= ring; i++) {
      for (const [dx, dy] of [[i, -ring], [i, ring], [-ring, i], [ring, i]]) {
        const x = cx + dx * 180;
        const y = cy + dy * 80;
        if (!files.some((f) => Math.abs(f.x - x) < 160 && Math.abs(f.y - y) < 64)) return [x, y];
      }
    }
  }
  return [cx, cy];
}

function setupGraph() {
  PG.canvas = $('proj-canvas');
  PG.ctx = PG.canvas.getContext('2d');
  new ResizeObserver(() => {
    resizeGraph();
    drawGraph();
  }).observe(PG.canvas.parentElement);
  PG.canvas.addEventListener('mousedown', onDown);
  window.addEventListener('mousemove', pgOnMove);
  window.addEventListener('mouseup', onUp);
  PG.canvas.addEventListener('dblclick', onDbl);
  PG.canvas.addEventListener('wheel', onWheel, { passive: false });
  PG.canvas.addEventListener('mouseleave', () => {
    PG.hover = 0;
    $('proj-tip').hidden = true;
    drawGraph();
  });
}

function resizeGraph() {
  const r = PG.canvas.parentElement.getBoundingClientRect();
  PG.dpr = window.devicePixelRatio || 1;
  PG.w = Math.max(1, r.width);
  PG.h = Math.max(1, r.height);
  PG.canvas.width = Math.round(PG.w * PG.dpr);
  PG.canvas.height = Math.round(PG.h * PG.dpr);
  PG.canvas.style.width = PG.w + 'px';
  PG.canvas.style.height = PG.h + 'px';
}

const toScreen = (x, y) => [(x - PG.view.x) * PG.view.z + PG.w / 2, (y - PG.view.y) * PG.view.z + PG.h / 2];
const toWorld = (sx, sy) => [(sx - PG.w / 2) / PG.view.z + PG.view.x, (sy - PG.h / 2) / PG.view.z + PG.view.y];

function fitView() {
  const files = PJ.cur ? PJ.cur.fileList : [];
  if (!files.length) {
    PG.view = { x: 0, y: 0, z: 1 };
    return;
  }
  const xs = files.map((f) => f.x);
  const ys = files.map((f) => f.y);
  const minX = Math.min(...xs) - 120;
  const maxX = Math.max(...xs) + 120;
  const minY = Math.min(...ys) - 60;
  const maxY = Math.max(...ys) + 60;
  const w = PG.w || 800;
  const hh = PG.h || 500;
  PG.view = { x: (minX + maxX) / 2, y: (minY + maxY) / 2, z: Math.max(0.4, Math.min(1.2, Math.min(w / (maxX - minX), hh / (maxY - minY)))) };
}

function nodeAt(sx, sy) {
  let hit = 0;
  for (const [id, b] of PG.boxes) {
    if (sx >= b.x && sx <= b.x + b.w && sy >= b.y && sy <= b.y + b.h) hit = id;
  }
  return hit;
}

function localPos(e) {
  const r = PG.canvas.getBoundingClientRect();
  return [e.clientX - r.left, e.clientY - r.top];
}

function onDown(e) {
  if (!PJ.cur || e.button !== 0) return;
  const [sx, sy] = localPos(e);
  const id = nodeAt(sx, sy);
  $('proj-tip').hidden = true;
  if (id) {
    const f = fileById(id);
    PG.drag = { kind: e.shiftKey && isOwn() ? 'link' : 'node', id, sx, sy, ox: f.x, oy: f.y, moved: false };
  } else {
    PG.drag = { kind: 'pan', sx, sy, vx: PG.view.x, vy: PG.view.y, moved: false };
  }
  e.preventDefault();
}

function pgOnMove(e) {
  if (S.view !== 'projects' || !PG.canvas) return;
  const [sx, sy] = localPos(e);
  PG.mouse = [sx, sy];
  const d = PG.drag;
  if (d) {
    const dx = sx - d.sx;
    const dy = sy - d.sy;
    if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
    if (d.kind === 'pan') {
      PG.view.x = d.vx - dx / PG.view.z;
      PG.view.y = d.vy - dy / PG.view.z;
    } else if (d.kind === 'node' && isOwn() && d.moved) {
      const f = fileById(d.id);
      f.x = Math.round(d.ox + dx / PG.view.z);
      f.y = Math.round(d.oy + dy / PG.view.z);
    }
    drawGraph();
    return;
  }
  const id = nodeAt(sx, sy);
  if (id !== PG.hover) {
    PG.hover = id;
    PG.canvas.style.cursor = id ? 'pointer' : 'default';
    drawGraph();
  }
  const tip = $('proj-tip');
  const f = id ? fileById(id) : null;
  if (f && (f.descr || f.body)) {
    tip.hidden = false;
    tip.textContent = (f.descr ? f.descr + '\n' : '') + fmtSize(textBytes(f.body)) + ', около ' + fmtTokens(approxTokens(f.body)) + ' токенов';
    tip.style.left = Math.min(sx + 14, PG.w - 260) + 'px';
    tip.style.top = sy + 16 + 'px';
  } else tip.hidden = true;
}

async function onUp(e) {
  const d = PG.drag;
  PG.drag = null;
  if (!d || S.view !== 'projects') return;
  if (d.kind === 'pan') {
    drawGraph();
    return;
  }
  if (d.kind === 'link') {
    const [sx, sy] = localPos(e);
    const target = nodeAt(sx, sy);
    if (target && target !== d.id) await toggleLink(d.id, target);
    else drawGraph();
    return;
  }
  if (!d.moved) {
    selectFile(d.id);
    return;
  }
  if (isOwn()) {
    const f = fileById(d.id);
    try {
      await call(studio.projects.editFile(f.id, { x: f.x, y: f.y }));
    } catch (err) {
      toast(errText(err.code));
    }
  }
}

function onDbl(e) {
  if (!isOwn()) return;
  const [sx, sy] = localPos(e);
  if (nodeAt(sx, sy)) return;
  const [x, y] = toWorld(sx, sy);
  newFile(Math.round(x), Math.round(y));
}

function onWheel(e) {
  e.preventDefault();
  const [sx, sy] = localPos(e);
  const [wx, wy] = toWorld(sx, sy);
  PG.view.z = Math.max(0.3, Math.min(2.2, PG.view.z * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
  // точка под курсором остаётся на месте
  PG.view.x = wx - (sx - PG.w / 2) / PG.view.z;
  PG.view.y = wy - (sy - PG.h / 2) / PG.view.z;
  drawGraph();
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function roundRect(ctx, x, y, w, hh, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + hh, r);
  ctx.arcTo(x + w, y + hh, x, y + hh, r);
  ctx.arcTo(x, y + hh, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawGraph() {
  if (!PG.ctx || S.view !== 'projects') return;
  if (PG.needFit && PG.w > 50 && PG.h > 50) {
    PG.needFit = false;
    fitView();
  }
  const ctx = PG.ctx;
  ctx.setTransform(PG.dpr, 0, 0, PG.dpr, 0, 0);
  ctx.clearRect(0, 0, PG.w, PG.h);
  PG.boxes.clear();
  const p = PJ.cur;
  const empty = $('proj-empty');
  empty.hidden = !!(p && p.fileList.length);
  empty.textContent = !p ? 'Выберите или создайте проект слева.' : p.snap ? 'В снимке нет файлов.' : 'Пусто. Двойной щелчок по полю или "Новый файл" сверху.';
  if (!p) return;
  const z = PG.view.z;
  const accent = cssVar('--accent') || '#e9a23b';
  const line = cssVar('--line') || '#2a2d35';
  const panel = cssVar('--panel-2') || '#1b1d22';
  const text = cssVar('--text') || '#e8e6e1';
  const muted = cssVar('--muted') || '#8b8e98';

  // сетка-точки
  ctx.fillStyle = line;
  const step = 40 * z;
  if (step > 12) {
    const [ox, oy] = toScreen(0, 0);
    for (let x = ((ox % step) + step) % step; x < PG.w; x += step) {
      for (let y = ((oy % step) + step) % step; y < PG.h; y += step) ctx.fillRect(x, y, 1.2, 1.2);
    }
  }

  ctx.font = Math.round(13 * z) + 'px "Segoe UI", system-ui, sans-serif';
  const sizes = new Map();
  for (const f of p.fileList) {
    const w = Math.max(110 * z, ctx.measureText(baseOf(f.path)).width + 54 * z);
    sizes.set(f.id, [w, 40 * z]);
  }
  const neigh = new Set(PJ.sel ? neighborsOf(p, PJ.sel) : []);

  // связи
  for (const [a, b] of p.links) {
    const fa = fileById(a);
    const fb = fileById(b);
    if (!fa || !fb) continue;
    const [x1, y1] = toScreen(fa.x, fa.y);
    const [x2, y2] = toScreen(fb.x, fb.y);
    const hot = PJ.sel && (a === PJ.sel || b === PJ.sel);
    ctx.strokeStyle = hot ? accent : muted;
    ctx.globalAlpha = hot ? 0.9 : 0.55;
    ctx.lineWidth = hot ? 1.6 : 1.2;
    ctx.setLineDash([6, 5]);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;

  // связь, которую тянут сейчас
  const d = PG.drag;
  if (d && d.kind === 'link' && PG.mouse) {
    const f = fileById(d.id);
    const [x1, y1] = toScreen(f.x, f.y);
    ctx.strokeStyle = accent;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(PG.mouse[0], PG.mouse[1]);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // файлы
  for (const f of p.fileList) {
    const [w, hh] = sizes.get(f.id);
    const [cx, cy] = toScreen(f.x, f.y);
    const x = cx - w / 2;
    const y = cy - hh / 2;
    PG.boxes.set(f.id, { x, y, w, h: hh });
    const sel = f.id === PJ.sel;
    const nb = neigh.has(f.id);
    roundRect(ctx, x, y, w, hh, 8 * z);
    ctx.fillStyle = panel;
    ctx.fill();
    ctx.lineWidth = sel ? 2 : 1;
    ctx.strokeStyle = sel ? accent : nb ? accent : PG.hover === f.id ? muted : line;
    ctx.globalAlpha = nb && !sel ? 0.6 : 1;
    ctx.stroke();
    ctx.globalAlpha = 1;
    // полоска цвета расширения
    const ec = EXT_COLORS[extOf(f.path)] || muted;
    ctx.fillStyle = ec;
    roundRect(ctx, x + 8 * z, y + hh / 2 - 9 * z, 4 * z, 18 * z, 2 * z);
    ctx.fill();
    ctx.fillStyle = text;
    ctx.textBaseline = 'middle';
    ctx.fillText(baseOf(f.path), x + 20 * z, cy - (f.path.includes('/') ? 6 * z : 0));
    if (f.path.includes('/')) {
      ctx.fillStyle = muted;
      ctx.font = Math.round(10 * z) + 'px "Segoe UI", system-ui, sans-serif';
      ctx.fillText(f.path.slice(0, f.path.lastIndexOf('/') + 1), x + 20 * z, cy + 9 * z);
      ctx.font = Math.round(13 * z) + 'px "Segoe UI", system-ui, sans-serif';
    }
    if (f.descr) {
      ctx.fillStyle = muted;
      ctx.beginPath();
      ctx.arc(x + w - 10 * z, y + 10 * z, 2.5 * z, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

setupGraph();
