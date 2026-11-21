'use strict';
// Материалы студии: видео, музыка, фото по проектам. Файлы лежат в R2, загрузка и
// скачивание идут напрямую между компьютером и R2 (главный процесс, materials.js).
// Проекты создают основатели, загружает любой, удаляет автор файла или основатель.

const MT = {
  ov: null, // ответ /api/materials
  project: 0,
  files: new Map(), // проект -> файлы
  kind: 'all', // all | video | audio | image
  folder: '', // '' все папки
  queue: [], // { token, name, size, sent, stage, error, project, folder }
  busy: false,
};

const MAT_KINDS = [['all', 'Все'], ['video', 'Видео'], ['audio', 'Музыка'], ['image', 'Фото']];
const MAT_ICON = {
  video: '<svg viewBox="0 0 24 24"><path d="M3 6h13v12H3zM16 10l5-3v10l-5-3"/></svg>',
  audio: '<svg viewBox="0 0 24 24"><path d="M9 18V5l11-2v13M9 18a3 3 0 1 1-3-3 3 3 0 0 1 3 3zM20 16a3 3 0 1 1-3-3 3 3 0 0 1 3 3z"/></svg>',
  image: '<svg viewBox="0 0 24 24"><path d="M3 5h18v14H3zM3 16l5-5 4 4 3-3 6 6"/></svg>',
};

const MAT_ERRORS = {
  materials_off: 'Хранилище материалов на сервере ещё не настроено.',
  bad_type: 'Такой файл не принимаем: нужны видео, музыка или фото (mp4, mov, webm, mkv, mp3, wav, flac, ogg, m4a, png, jpg, webp, gif). Или содержимое файла не совпало с расширением.',
  too_big: 'Файл больше лимита на один файл.',
  storage_full: 'Общий лимит хранилища заполнен. Основатель может поднять его в настройках материалов.',
  upload_missing: 'Файл не дошёл до хранилища целиком. Попробуйте ещё раз.',
  r2_unreachable: 'Сервер не достучался до хранилища R2. Попробуйте позже.',
  r2_upload_failed: 'Загрузка в хранилище прервалась. Проверьте интернет и попробуйте ещё раз.',
  r2_download_failed: 'Скачивание прервалось. Попробуйте ещё раз.',
  bad_name: 'Имя не подошло. Расширение файла менять нельзя.',
};
const matErr = (code) => MAT_ERRORS[code] || errText(code);

function matIco(kind) {
  const el = h('span', { class: 'mat-ico k-' + kind });
  el.innerHTML = MAT_ICON[kind] || MAT_ICON.image;
  return el;
}

async function openMaterials() {
  try {
    MT.ov = await call(studio.materials.overview());
  } catch (err) {
    toast(matErr(err.code));
    return;
  }
  if (MT.project && !MT.ov.projects.some((p) => p.id === MT.project)) MT.project = 0;
  if (!MT.project && MT.ov.projects.length) MT.project = MT.ov.projects[0].id;
  renderMatSide();
  await loadMatFiles();
  renderMatMain();
}

async function loadMatFiles(force) {
  if (!MT.project || (!force && MT.files.has(MT.project))) return;
  try {
    const r = await call(studio.materials.files(MT.project));
    MT.files.set(MT.project, r.files);
  } catch (err) {
    toast(matErr(err.code));
  }
}

function renderMatSide() {
  const founder = S.me && S.me.founder;
  $('mat-new').hidden = !founder;
  const box = $('mat-list');
  box.innerHTML = '';
  const ov = MT.ov;
  if (!ov) return;
  if (!ov.projects.length) box.append(h('div', { class: 'side-empty', text: founder ? 'Проектов пока нет. Создайте первый.' : 'Проектов пока нет. Их создают основатели.' }));
  for (const p of ov.projects) {
    box.append(h('button', { class: 'item mat-item' + (p.id === MT.project ? ' is-on' : ''), onclick: () => openMatProject(p.id) },
      h('span', { class: 'ticket-main' },
        h('span', { class: 'item-name', text: p.title }),
        h('span', { class: 'ticket-meta', text: (p.files ? p.files + ' ' + plural(p.files, 'файл', 'файла', 'файлов') + ', ' + fmtBytes(p.bytes) : 'пусто') + (p.id === ov.musicProject ? ' · музыка студии' : '') }))));
  }
  const used = $('mat-usage');
  used.innerHTML = '';
  if (ov.enabled) {
    const pct = Math.min(100, (ov.used / ov.limit) * 100);
    const bar = h('div', { class: 'mat-bar' }, h('i'));
    bar.firstChild.style.width = pct.toFixed(1) + '%';
    used.append(h('div', { class: 'muted small', text: 'Занято ' + fmtBytes(ov.used) + ' из ' + fmtBytes(ov.limit) }), bar,
      h('div', { class: 'muted small', text: 'Один файл до ' + fmtBytes(ov.maxFile) }));
    if (founder) used.append(h('button', { class: 'b-link', type: 'button', text: 'Лимиты', onclick: matLimits }));
  }
}

async function openMatProject(id) {
  MT.project = id;
  MT.folder = '';
  renderMatSide();
  renderMatMain();
  await loadMatFiles();
  renderMatMain();
}

function renderMatMain() {
  const ov = MT.ov;
  const body = $('mat-body');
  const tools = $('mat-tools');
  body.innerHTML = '';
  tools.innerHTML = '';
  const founder = S.me && S.me.founder;
  if (!ov) return;
  if (!ov.enabled) {
    $('mat-title').textContent = 'Материалы';
    $('mat-sub').textContent = '';
    body.append(h('div', { class: 'log-empty' },
      h('div', { text: 'Хранилище материалов на сервере ещё не подключено.' }),
      h('div', { class: 'muted', text: 'Файлы будут лежать в отдельном бакете R2. Как подключить: ПАМЯТКА, раздел "Материалы".' })));
    return;
  }
  const p = ov.projects.find((x) => x.id === MT.project);
  if (!p) {
    $('mat-title').textContent = 'Материалы';
    $('mat-sub').textContent = 'видео, музыка и фото по проектам';
    body.append(h('div', { class: 'log-empty' }, h('div', { text: founder ? 'Создайте проект слева, потом загружайте в него файлы.' : 'Проектов пока нет.' })));
    return;
  }
  $('mat-title').textContent = p.title;
  $('mat-sub').textContent = p.note || (p.id === ov.musicProject ? 'аудио отсюда играет плеер как "Музыка студии"' : '');
  tools.append(h('button', { class: 'btn btn-s btn-accent', type: 'button', text: 'Загрузить', onclick: matPick }));
  if (founder) {
    const isMusic = p.id === ov.musicProject;
    tools.append(
      h('button', { class: 'btn btn-s', type: 'button', text: 'Скачать проект', title: 'Все файлы проекта в папку на компьютере или внешнем диске', onclick: () => matDownloadProject(p) }),
      h('button', { class: 'btn btn-s' + (isMusic ? ' is-on' : ''), type: 'button', text: isMusic ? 'Музыка студии: да' : 'Сделать музыкой студии', title: 'Плеер в приложении будет играть аудио из этого проекта', onclick: () => matSetMusic(isMusic ? 0 : p.id) }),
      h('button', { class: 'btn btn-s', type: 'button', text: 'Изменить', onclick: () => matProjectForm(p) }),
      h('button', { class: 'btn btn-s btn-danger-ghost', type: 'button', text: 'Удалить', onclick: () => matProjectDelete(p) }));
  }

  const all = MT.files.get(p.id);
  const folders = [...new Set((all || []).map((f) => f.folder).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ru'));
  const bar = h('div', { class: 'row wrap gap-s mat-filters' },
    segOf(MAT_KINDS, MT.kind, (v) => {
      MT.kind = v;
      renderMatMain();
    }));
  if (folders.length) {
    const sel = h('select', { title: 'Папка' }, h('option', { value: '', text: 'Все папки' }), ...folders.map((f) => h('option', { value: f, text: f, selected: f === MT.folder })));
    sel.addEventListener('change', () => {
      MT.folder = sel.value;
      renderMatMain();
    });
    bar.append(sel);
  }
  body.append(bar);

  const zone = h('div', { class: 'mat-zone' });
  bindMatDrop(zone);
  if (!all) {
    zone.append(skeleton('lines', 5));
  } else {
    const list = all.filter((f) => (MT.kind === 'all' || f.kind === MT.kind) && (!MT.folder || f.folder === MT.folder));
    if (!list.length) {
      zone.append(h('div', { class: 'mat-empty' },
        h('div', { text: all.length ? 'Под этот фильтр файлов нет.' : 'Перетащите сюда файлы из проводника или нажмите "Загрузить".' }),
        h('div', { class: 'muted small', text: 'Видео mp4, mov, webm, mkv; музыка mp3, wav, flac, ogg, m4a; фото png, jpg, webp, gif. До ' + fmtBytes(ov.maxFile) + ' за файл.' })));
    }
    let cur = null;
    for (const f of list) {
      if (f.folder !== cur) {
        cur = f.folder;
        zone.append(h('div', { class: 'mat-folder muted small', text: f.folder || 'Без папки' }));
      }
      zone.append(matRow(f));
    }
  }
  body.append(zone, matQueueBox());
}

function matRow(f) {
  const u = S.users.get(f.by);
  const mine = f.by === S.me.id;
  const can = mine || S.me.founder;
  return h('div', { class: 'mat-row' },
    matIco(f.kind),
    h('div', { class: 'mat-name' },
      h('div', { class: 'item-name', text: f.name, title: f.name }),
      h('div', { class: 'muted small', text: fmtBytes(f.bytes) + ' · ' + (u ? u.name : 'участник') + ' · ' + dayLabel(f.created) })),
    h('div', { class: 'row gap-s' },
      h('button', { class: 'btn btn-s', type: 'button', text: f.kind === 'audio' ? 'Слушать' : 'Смотреть', onclick: () => matPreview(f) }),
      h('button', { class: 'btn btn-s', type: 'button', text: 'Скачать', onclick: () => matDownload(f) }),
      can ? h('button', { class: 'btn btn-s', type: 'button', text: 'Изменить', onclick: () => matEdit(f) }) : null,
      can ? h('button', { class: 'btn btn-s btn-danger-ghost', type: 'button', text: 'Удалить', onclick: () => matDelete(f) }) : null));
}

// ---------- загрузка ----------

function bindMatDrop(zone) {
  zone.addEventListener('dragover', (e) => {
    if (!e.dataTransfer || ![...e.dataTransfer.types].includes('Files')) return;
    e.preventDefault();
    zone.classList.add('drop-on');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('drop-on'));
  zone.addEventListener('drop', async (e) => {
    zone.classList.remove('drop-on');
    if (!e.dataTransfer) return;
    e.preventDefault();
    const got = [];
    for (const file of e.dataTransfer.files) {
      try {
        const r = await call(studio.materials.drop(file));
        if (r) got.push(r);
      } catch {
        /* папка или не файл */
      }
    }
    matEnqueue(got);
  });
}

async function matPick() {
  try {
    matEnqueue(await call(studio.materials.pick()));
  } catch (err) {
    toast(matErr(err.code));
  }
}

function matEnqueue(list) {
  if (!list.length || !MT.project) return;
  const ov = MT.ov;
  for (const f of list) {
    const ext = (f.name.split('.').pop() || '').toLowerCase();
    const ok = Object.values(ov.types || {}).some((x) => x.includes(ext));
    MT.queue.push({ token: f.token, name: f.name, size: f.size, sent: 0, stage: ok ? 'wait' : 'error', error: ok ? (f.size > ov.maxFile ? matErr('too_big') : '') : matErr('bad_type'), project: MT.project, folder: MT.folder });
  }
  for (const q of MT.queue) if (q.stage === 'wait' && q.error) q.stage = 'error';
  renderMatQueue();
  matRun();
}

async function matRun() {
  if (MT.busy) return;
  const q = MT.queue.find((x) => x.stage === 'wait');
  if (!q) return;
  MT.busy = true;
  q.stage = 'up';
  renderMatQueue();
  try {
    await call(studio.materials.upload(q.token, q.project, q.folder));
    q.stage = 'done';
    q.sent = q.size;
    MT.files.delete(q.project);
    MT.ov = await call(studio.materials.overview());
    if (MT.project === q.project) await loadMatFiles();
    renderMatSide();
    renderMatMain();
  } catch (err) {
    q.stage = err.code === 'cancelled' ? 'cancelled' : 'error';
    q.error = err.code === 'cancelled' ? '' : matErr(err.code);
  } finally {
    MT.busy = false;
    renderMatQueue();
    matRun();
  }
}

studio.materials.onProgress((p) => {
  if (p.stage === 'bulk' && MT.bulk && MT.bulk.key === p.token) {
    Object.assign(MT.bulk, { sent: p.sent, total: p.total, done: p.done, count: p.count, skipped: p.skipped });
    renderMatQueue();
    return;
  }
  const q = MT.queue.find((x) => x.token === p.token);
  if (q) {
    q.sent = p.sent;
    if (p.stage === 'check') q.stage = 'check';
    renderMatQueue();
  } else if (p.stage === 'down' || p.stage === 'done') {
    const d = MT.downloads && MT.downloads.get(p.token);
    if (d) {
      d.sent = p.sent;
      renderMatQueue();
    }
  }
});

function matQueueBox() {
  return h('div', { class: 'mat-queue', id: 'mat-queue', hidden: true });
}

function renderMatQueue() {
  const box = $('mat-queue');
  if (!box) return;
  const items = MT.queue.filter((q) => q.stage !== 'done' || Date.now() - (q.doneAt || (q.doneAt = Date.now())) < 8000);
  const downs = [...(MT.downloads || new Map()).values()];
  box.hidden = !items.length && !downs.length && !MT.bulk;
  box.innerHTML = '';
  if (box.hidden) return;
  const label = { wait: 'в очереди', up: 'загружается', check: 'проверка на сервере', done: 'готово', cancelled: 'отменено', error: 'ошибка' };
  for (const q of items) {
    const pct = q.size ? Math.round((q.sent / q.size) * 100) : 0;
    const bar = h('div', { class: 'mat-bar' }, h('i'));
    bar.firstChild.style.width = (q.stage === 'done' ? 100 : pct) + '%';
    box.append(h('div', { class: 'mat-q' + (q.stage === 'error' ? ' is-err' : '') },
      h('div', { class: 'row between' },
        h('span', { class: 'item-name', text: q.name }),
        h('span', { class: 'muted small', text: label[q.stage] + (q.stage === 'up' ? ' ' + pct + '%' : '') + ' · ' + fmtBytes(q.size) }),
        q.stage === 'up' || q.stage === 'wait' ? h('button', { class: 'mini', type: 'button', text: 'отменить', onclick: () => matCancel(q) }) : null),
      q.stage === 'up' || q.stage === 'check' ? bar : null,
      q.error ? h('div', { class: 'small err-text', text: q.error }) : null));
  }
  if (MT.bulk) {
    const b = MT.bulk;
    const pct = b.total ? Math.round((b.sent / b.total) * 100) : 0;
    const bar = h('div', { class: 'mat-bar' }, h('i'));
    bar.firstChild.style.width = pct + '%';
    box.append(h('div', { class: 'mat-q' },
      h('div', { class: 'row between' },
        h('span', { class: 'item-name', text: 'Проект "' + b.name + '"' }),
        h('span', { class: 'muted small', text: b.done + ' из ' + b.count + ' · ' + fmtBytes(b.sent) + ' из ' + fmtBytes(b.total) + ' · ' + pct + '%' }),
        h('button', { class: 'mini', type: 'button', text: 'отменить', onclick: () => studio.materials.cancel(b.key) })),
      bar));
  }
  for (const d of downs) {
    const pct = d.size ? Math.round((d.sent / d.size) * 100) : 0;
    const bar = h('div', { class: 'mat-bar' }, h('i'));
    bar.firstChild.style.width = pct + '%';
    box.append(h('div', { class: 'mat-q' }, h('div', { class: 'row between' }, h('span', { class: 'item-name', text: d.name }), h('span', { class: 'muted small', text: 'скачивается ' + pct + '%' })), bar));
  }
  if (items.length && items.every((q) => ['done', 'error', 'cancelled'].includes(q.stage))) {
    box.append(h('button', { class: 'b-link', type: 'button', text: 'Очистить список', onclick: () => {
      MT.queue = [];
      renderMatQueue();
    } }));
  }
}

function matCancel(q) {
  if (q.stage === 'wait') {
    q.stage = 'cancelled';
    renderMatQueue();
    return;
  }
  studio.materials.cancel(q.token);
}

// ---------- просмотр, скачивание, правка ----------

async function matPreview(f) {
  try {
    const r = await call(studio.materials.preview(f.id));
    let el;
    if (f.kind === 'image') el = h('img', { class: 'mat-view', src: r.url, alt: '' });
    else if (f.kind === 'video') el = h('video', { class: 'mat-view', src: r.url, controls: true, autoplay: true });
    else el = h('audio', { class: 'mat-audio', src: r.url, controls: true, autoplay: true });
    if (f.kind !== 'image' && typeof onBrowserAudio === 'function') onBrowserAudio(true); // музыка студии ждёт
    await modal({ title: f.name, body: el, ok: 'Закрыть', wide: true });
    if (el.pause) el.pause();
    el.removeAttribute('src');
    if (f.kind !== 'image' && typeof onBrowserAudio === 'function') onBrowserAudio(false);
  } catch (err) {
    toast(matErr(err.code));
  }
}

async function matDownload(f) {
  MT.downloads = MT.downloads || new Map();
  const key = 'd' + f.id;
  MT.downloads.set(key, { name: f.name, size: f.bytes, sent: 0 });
  renderMatQueue();
  try {
    const r = await call(studio.materials.download(f.id));
    if (r.saved) {
      const el = h('div', { class: 'toast' }, h('span', { text: 'Скачано: ' + f.name + ' ' }), h('button', { class: 'b-link', type: 'button', text: 'Показать в папке', onclick: () => studio.materials.showFile(r.file) }));
      $('toasts').append(el);
      setTimeout(() => el.remove(), 7000);
    }
  } catch (err) {
    if (err.code !== 'cancelled') toast(matErr(err.code));
  } finally {
    MT.downloads.delete(key);
    renderMatQueue();
  }
}

async function matEdit(f) {
  const name = h('input', { maxlength: '160', value: f.name });
  const folder = h('input', { maxlength: '60', value: f.folder || '', placeholder: 'Например: Трейлер, Обложки, Черновики' });
  const box = h('div', { class: 'col gap-s' },
    h('label', { class: 'field' }, h('span', { text: 'Имя (расширение не меняется)' }), name),
    h('label', { class: 'field' }, h('span', { text: 'Папка' }), folder));
  if (!(await modal({ title: 'Файл', body: box, ok: 'Сохранить' }))) return;
  try {
    await call(studio.materials.edit(f.id, { name: name.value.trim(), folder: folder.value.trim() }));
    await loadMatFiles(true);
    renderMatMain();
  } catch (err) {
    toast(matErr(err.code));
  }
}

async function matDelete(f) {
  if (!(await modal({ title: 'Удалить "' + f.name + '"?', body: 'Файл удалится из хранилища. Вернуть не получится.', ok: 'Удалить', danger: true }))) return;
  try {
    await call(studio.materials.remove(f.id));
    MT.ov = await call(studio.materials.overview());
    await loadMatFiles(true);
    renderMatSide();
    renderMatMain();
  } catch (err) {
    toast(matErr(err.code));
  }
}

// Весь проект на диск: сначала сколько это, потом да или нет.
async function matDownloadProject(p) {
  if (!p.files) {
    toast('В проекте пока нет файлов.');
    return;
  }
  const body = h('div', { class: 'col gap-s' },
    h('p', { text: p.files + ' ' + plural(p.files, 'файл', 'файла', 'файлов') + ', всего ' + fmtBytes(p.bytes) + '.' }),
    h('p', { class: 'muted small', text: 'Дальше выберите папку, например на внешнем диске. Внутри появится папка "' + p.title + '" с подпапками как в проекте. Файлы, которые уже лежат там с тем же размером, не скачиваются заново: при следующем копировании докачается только новое.' }));
  if (!(await modal({ title: 'Скачать проект "' + p.title + '"?', body, ok: 'Да, скачать' }))) return;
  MT.bulk = { key: 'p' + p.id, name: p.title, sent: 0, total: p.bytes, done: 0, count: p.files, skipped: 0 };
  renderMatQueue();
  try {
    const r = await call(studio.materials.downloadProject(p.id));
    if (r.saved) {
      const el = h('div', { class: 'toast' },
        h('span', { text: 'Проект "' + p.title + '" скачан: ' + r.count + ' ' + plural(r.count, 'файл', 'файла', 'файлов') + (r.skipped ? ', из них уже были на месте: ' + r.skipped : '') + '. ' }),
        h('button', { class: 'b-link', type: 'button', text: 'Открыть папку', onclick: () => studio.materials.showFile(r.folder) }));
      $('toasts').append(el);
      setTimeout(() => el.remove(), 10000);
    }
  } catch (err) {
    if (err.code !== 'cancelled') toast(matErr(err.code));
  } finally {
    MT.bulk = null;
    renderMatQueue();
  }
}

// ---------- проекты (основатели) ----------

async function matProjectForm(p) {
  const title = h('input', { maxlength: '80', value: p ? p.title : '', placeholder: 'Например: Игра "Тетрис", Альбом весна' });
  const note = h('input', { maxlength: '500', value: p ? p.note || '' : '', placeholder: 'Коротко, что здесь лежит (не обязательно)' });
  setTimeout(() => title.focus(), 30);
  const box = h('div', { class: 'col gap-s' }, h('label', { class: 'field' }, h('span', { text: 'Название' }), title), h('label', { class: 'field' }, h('span', { text: 'Описание' }), note));
  if (!(await modal({ title: p ? 'Проект' : 'Новый проект материалов', body: box, ok: p ? 'Сохранить' : 'Создать' })) || !title.value.trim()) return;
  try {
    if (p) await call(studio.materials.projectEdit(p.id, title.value.trim(), note.value.trim()));
    else MT.project = (await call(studio.materials.projectAdd(title.value.trim(), note.value.trim()))).id;
    await openMaterials();
  } catch (err) {
    toast(matErr(err.code));
  }
}
$('mat-new').addEventListener('click', () => matProjectForm(null));

async function matProjectDelete(p) {
  const what = p.files ? 'Удалятся все файлы проекта (' + p.files + ', ' + fmtBytes(p.bytes) + ') из хранилища. Вернуть не получится.' : 'Проект пустой.';
  if (!(await modal({ title: 'Удалить проект "' + p.title + '"?', body: what, ok: 'Удалить', danger: true }))) return;
  try {
    await call(studio.materials.projectDelete(p.id));
    MT.files.delete(p.id);
    MT.project = 0;
    await openMaterials();
  } catch (err) {
    toast(matErr(err.code));
  }
}

async function matSetMusic(id) {
  try {
    await call(studio.materials.settings({ musicProject: id }));
    toast(id ? 'Плеер будет играть аудио из этого проекта. У команды список обновится в плеере: "Обновить список".' : 'Музыка студии снова берётся по-старому.');
    await openMaterials();
  } catch (err) {
    toast(matErr(err.code));
  }
}

async function matLimits() {
  const ov = MT.ov;
  const lim = h('input', { type: 'number', min: '1', max: '10000', step: '1', value: String(Math.round(ov.limit / 1024 ** 3)) });
  const max = h('input', { type: 'number', min: '0.01', max: '5', step: '0.1', value: String(Math.round((ov.maxFile / 1024 ** 3) * 100) / 100) });
  const box = h('div', { class: 'col gap-s' },
    h('label', { class: 'field' }, h('span', { text: 'Общий лимит, ГБ' }), lim, h('span', { class: 'muted small', text: 'Первые 10 ГБ в R2 бесплатно, дальше около 0,015 $ за ГБ в месяц. Скачивание бесплатное.' })),
    h('label', { class: 'field' }, h('span', { text: 'Один файл, ГБ (до 5)' }), max));
  if (!(await modal({ title: 'Лимиты материалов', body: box, ok: 'Сохранить' }))) return;
  try {
    await call(studio.materials.settings({ limitGB: Number(lim.value), maxFileGB: Number(max.value) }));
    await openMaterials();
  } catch (err) {
    toast(matErr(err.code));
  }
}

// Кто-то загрузил, удалил или переименовал: обновить, если раздел открыт.
function onMaterialsEvent(ev) {
  if (ev.project) MT.files.delete(ev.project);
  if (S.view === 'materials') openMaterials();
}
