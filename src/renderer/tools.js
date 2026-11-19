'use strict';
// Вкладка «Инструменты»: инструменты кузницы с сайта. Каждый человек сам решает,
// какие скачать. После установки работают без интернета, в отдельном окне.

const T = {
  list: [],
  progress: new Map(), // id -> { phase, got, size }
};

const TOOL_ICONS = { grafika: 'image', zvuk: 'audio', montazh: 'video', pages: 'page', fony: 'pattern' };
ICONS.page = '<svg viewBox="0 0 24 24"><path d="M6 3h9l4 4v14H6zM14 3v5h5M9 12h7M9 16h7"/></svg>';
ICONS.pattern = '<svg viewBox="0 0 24 24"><path d="M3 8c3-3 6 3 9 0s6-3 9 0M3 13c3-3 6 3 9 0s6-3 9 0M3 18c3-3 6 3 9 0s6-3 9 0"/></svg>';

const TOOL_ERRORS = {
  network: 'Не удалось скачать: нет связи с GitHub.',
  download_failed: 'Файл инструмента не найден на GitHub. Возможно, его ещё не выложили.',
  bad_package: 'Скачанный файл не совпал с ожидаемым. Установка отменена, попробуйте ещё раз.',
  no_source: 'Адрес загрузки инструментов не настроен.',
  not_installed: 'Инструмент не установлен.',
  cancelled: 'Загрузка отменена.',
};

const mb = (n) => (n / 1048576).toFixed(n < 10485760 ? 1 : 0).replace('.', ',') + ' МБ';

async function openTools() {
  try {
    T.list = await call(studio.tools.list());
  } catch (err) {
    toast(errText(err.code));
  }
  renderToolList();
}

function renderToolList() {
  const grid = $('tool-grid');
  grid.innerHTML = '';
  for (const t of T.list) {
    const pr = T.progress.get(t.id);
    const busy = t.busy || !!pr;
    const state = busy ? '' : t.installed ? (t.update ? 'есть обновление' : 'установлен') : 'не установлен';
    const actions = h('div', { class: 'row gap-s tool-actions' });
    if (busy) {
      const pct = pr && pr.size ? Math.min(100, Math.round((pr.got / pr.size) * 100)) : 0;
      actions.append(
        h('div', { class: 'grow' },
          h('div', { class: 'bar tool-bar' }, h('i', { style: `width:${pr && pr.phase === 'unpack' ? 100 : pct}%` })),
          h('div', { class: 'muted small', text: pr && pr.phase === 'unpack' ? 'распаковка...' : pr ? `${mb(pr.got)} из ${mb(pr.size)}` : 'подготовка...' }),
        ),
        h('button', { class: 'btn btn-s', text: 'Отмена', onclick: () => studio.tools.cancel(t.id) }),
      );
    } else if (t.installed) {
      actions.append(h('button', { class: 'btn btn-accent btn-s', text: 'Открыть', onclick: () => openTool(t.id) }));
      if (t.update) actions.append(h('button', { class: 'btn btn-s', text: 'Обновить', onclick: () => installTool(t) }));
      actions.append(h('button', { class: 'btn btn-s btn-danger-ghost', text: 'Удалить', onclick: () => removeTool(t) }));
    } else {
      actions.append(h('button', { class: 'btn btn-accent btn-s', text: 'Скачать · ' + mb(t.size), onclick: () => installTool(t) }));
    }
    grid.append(h('div', { class: 'tool' + (t.installed ? ' is-installed' : '') },
      h('span', { class: 'ico', dataset: { ico: TOOL_ICONS[t.id] || 'forge' } }),
      h('div', { class: 'tool-name', text: t.name }),
      h('div', { class: 'muted small tool-desc', text: t.desc }),
      state ? h('span', { class: 'tag' + (t.update ? ' tag-accent' : ''), text: state }) : null,
      actions,
    ));
  }
  if (!T.list.length) grid.append(h('div', { class: 'muted', text: 'Список инструментов пуст.' }));
  icons(grid);
}

async function installTool(t) {
  T.progress.set(t.id, { phase: 'download', got: 0, size: t.size });
  renderToolList();
  try {
    T.list = await call(studio.tools.install(t.id));
    toast(t.name + ': установлено');
  } catch (err) {
    if (err.code !== 'cancelled') toast(TOOL_ERRORS[err.code] || errText(err.code));
    else toast(TOOL_ERRORS.cancelled);
    T.list = await call(studio.tools.list());
  } finally {
    T.progress.delete(t.id);
    renderToolList();
  }
}

async function removeTool(t) {
  if (!(await modal({ title: 'Удалить «' + t.name + '»?', body: 'Файлы инструмента удалятся с компьютера. Ваши работы внутри инструмента сохранятся и будут на месте, если установить его снова.', ok: 'Удалить', danger: true }))) return;
  try {
    T.list = await call(studio.tools.remove(t.id));
    renderToolList();
  } catch (err) {
    toast(errText(err.code));
  }
}

async function openTool(id) {
  try {
    await call(studio.tools.open(id));
  } catch (err) {
    toast(TOOL_ERRORS[err.code] || errText(err.code));
  }
}

studio.tools.onProgress((p) => {
  const cur = T.progress.get(p.id) || {};
  T.progress.set(p.id, { ...cur, ...p });
  if (S.view === 'tools') renderToolList();
});

studio.app.onUpdate(async (u) => {
  if (await modal({ title: 'Доступно обновление', body: `Версия ${u.version} скачана. Перезапустить приложение сейчас? Если нет, обновление установится при следующем закрытии.`, ok: 'Перезапустить' })) {
    studio.app.restart();
  }
});
