'use strict';
// Правила команды. При первом входе и после каждой новой версии экран закрывает
// всё приложение, пока человек не прочитает правила до конца и не оставит имя,
// фамилию и почту для связи. Основатели правила не принимают, они их пишут.
// Позже правила открываются из профиля. Основатель правит и публикует их в админке.

const RU = {
  cur: null, // ответ /api/rules
  gate: false, // экран закрывает приложение
  checking: false,
};

Object.assign(ERRORS, {
  rules_required: 'Сначала нужно принять правила команды.',
  rules_changed: 'Правила только что обновились. Прочитайте новую версию.',
  bad_person_name: 'Имя и фамилия: только буквы, пробел, дефис, до 60 знаков.',
  bad_email: 'Проверьте адрес почты.',
  bad_rules: 'Текст правил пустой или слишком длинный.',
  changes_required: 'Напишите, что изменилось: люди увидят это над правилами.',
  no_draft: 'Нет черновика для публикации.',
  founder_only: 'Это может только основатель.',
  founder_protected: 'Основателя нельзя заблокировать, удалить или лишить прав.',
});

// Разметка правил: "## " заголовок блока, "- " пункт, остальное абзацы.
function renderRulesText(text) {
  const root = h('div', { class: 'rules-text' });
  let block = null;
  let list = null;
  const target = () => block || root;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) {
      list = null;
      continue;
    }
    if (line.startsWith('## ')) {
      block = h('section', { class: 'rules-block' }, h('h3', { text: line.slice(3).trim() }));
      root.append(block);
      list = null;
    } else if (line.startsWith('- ')) {
      if (!list) {
        list = h('ul');
        target().append(list);
      }
      list.append(h('li', { text: line.slice(2).trim() }));
    } else {
      list = null;
      target().append(h('p', { text: line }));
    }
  }
  return root;
}

const fmtDate = (ms) => new Date(ms).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });

// Возвращает true, если экран правил закрыл приложение.
async function checkRules() {
  if (RU.checking) return RU.gate;
  RU.checking = true;
  try {
    const r = await call(studio.rules.get());
    RU.cur = r;
    if (r.required) {
      showRules(r, 'gate');
      return true;
    }
    if (RU.gate) hideRules();
    return false;
  } catch {
    return false;
  } finally {
    RU.checking = false;
  }
}

function hideRules() {
  RU.gate = false;
  $('rules-gate').hidden = true;
  $('rules-gate').innerHTML = '';
}

// mode: 'gate' (принять), 'view' (прочитать), 'preview' (черновик в админке)
function showRules(r, mode) {
  const box = $('rules-gate');
  box.innerHTML = '';
  box.hidden = false;
  RU.gate = mode === 'gate';
  const gate = mode === 'gate';
  const sub = mode === 'preview'
    ? 'Черновик версии ' + r.version + ', так его увидят участники'
    : 'Версия ' + r.version + (r.published ? ' от ' + fmtDate(r.published) : '');

  const scroll = h('div', { class: 'rules-scroll' });
  if (gate && r.changes && r.changes.length) {
    scroll.append(h('div', { class: 'rules-changes' },
      h('b', { text: 'Что изменилось' }),
      ...r.changes.map((c) => h('div', {}, h('div', { class: 'muted small', text: 'Версия ' + c.version + (c.published ? ', ' + fmtDate(c.published) : '') }), renderRulesText(c.changes))),
    ));
  } else if (mode === 'preview' && r.changes) {
    scroll.append(h('div', { class: 'rules-changes' }, h('b', { text: 'Что изменилось' }), renderRulesText(r.changes)));
  }
  scroll.append(renderRulesText(r.body || ''));

  const foot = h('div', { class: 'rules-foot' });
  if (gate) {
    const prev = r.consent || {};
    const first = h('input', { maxlength: '60', autocomplete: 'given-name', value: prev.firstName || '' });
    const last = h('input', { maxlength: '60', autocomplete: 'family-name', value: prev.lastName || '' });
    const email = h('input', { type: 'email', maxlength: '120', autocomplete: 'email', value: prev.email || '' });
    scroll.append(h('section', { class: 'rules-block rules-form' },
      h('h3', { text: 'Для связи' }),
      h('p', { class: 'muted small', text: 'Имя, фамилия и почта нужны, чтобы связаться по выплатам. Их видят только основатели студии.' }),
      h('div', { class: 'row wrap gap-s' },
        h('label', { class: 'field grow' }, h('span', { text: 'Имя' }), first),
        h('label', { class: 'field grow' }, h('span', { text: 'Фамилия' }), last),
      ),
      h('label', { class: 'field' }, h('span', { text: 'Почта' }), email),
    ));
    const hint = h('span', { class: 'muted small grow' });
    const agree = h('button', { class: 'btn btn-accent', type: 'button', text: 'Прочитал, согласен' });
    let readToEnd = false;
    const update = () => {
      if (!readToEnd && scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 8) readToEnd = true;
      const filled = first.value.trim() && last.value.trim() && /\S+@\S+\.\S+/.test(email.value.trim());
      agree.disabled = !(readToEnd && filled);
      hint.textContent = !readToEnd ? 'Прокрутите правила до конца.' : !filled ? 'Заполните имя, фамилию и почту.' : '';
    };
    scroll.addEventListener('scroll', update);
    for (const i of [first, last, email]) i.addEventListener('input', update);
    agree.addEventListener('click', async () => {
      agree.disabled = true;
      try {
        await call(studio.rules.accept(r.version, first.value, last.value, email.value));
        hideRules();
        toast('Спасибо. Правила всегда можно открыть в профиле.');
        if (typeof afterRules === 'function') afterRules();
      } catch (err) {
        toast(errText(err.code));
        if (err.code === 'rules_changed') checkRules();
        else update();
      }
    });
    foot.append(hint,
      h('button', { class: 'btn', type: 'button', text: 'Выйти из аккаунта', onclick: async () => {
        await call(studio.auth.logout());
        hideRules();
        S.me = null;
        showAuth();
      } }),
      agree);
    requestAnimationFrame(update);
  } else {
    let note = '';
    if (mode === 'view') {
      if (r.founder) note = 'Вы основатель: правила не принимаете, а пишете.';
      else if (r.consent) note = 'Вы приняли версию ' + r.consent.version + ', ' + fmtDate(r.consent.created);
    }
    foot.append(h('span', { class: 'muted small grow', text: note }),
      h('button', { class: 'btn btn-accent', type: 'button', text: 'Закрыть', onclick: hideRules }));
  }

  box.append(h('div', { class: 'rules-panel', role: 'dialog', 'aria-modal': 'true' },
    h('div', { class: 'rules-head' }, h('h2', { text: 'Правила команды' }), h('div', { class: 'muted small', text: sub })),
    scroll,
    foot,
  ));
  scroll.scrollTop = 0;
}

async function openRulesView() {
  try {
    const r = await call(studio.rules.get());
    if (!r.version) {
      toast('Правила ещё не опубликованы.');
      return;
    }
    showRules(r, r.required ? 'gate' : 'view');
  } catch (err) {
    toast(errText(err.code));
  }
}

studio.rules.onRequired(() => {
  if (!RU.gate && !$('app').hidden) checkRules();
});

// ---------- админка: правила (только основатель) ----------

async function loadAdminRules() {
  const card = $('admin-rules-card');
  card.hidden = !(S.me && S.me.founder);
  if (card.hidden) return;
  let d;
  try {
    d = await call(studio.admin.rules());
  } catch (err) {
    toast(errText(err.code));
    return;
  }
  const versions = d.versions || [];
  const draft = versions.find((v) => !v.published);
  const cur = versions.filter((v) => v.published).pop();
  const box = $('admin-rules');
  box.innerHTML = '';
  const pendingNames = (d.pending || []).map((id) => (S.users.get(id) || { name: '#' + id }).name);
  box.append(h('p', { class: 'muted small', text: cur
    ? 'Действует версия ' + cur.version + ' от ' + fmtDate(cur.published) + '. ' + (pendingNames.length ? 'Ещё не приняли: ' + pendingNames.join(', ') + '.' : 'Приняли все.')
    : 'Правила ещё не опубликованы: пока их нет, никто их не видит и ничего не закрыто.' }));

  const body = h('textarea', { class: 'mono rules-edit', rows: '18', spellcheck: 'false' });
  body.value = draft ? draft.body : cur ? cur.body : '';
  const changes = h('textarea', { rows: '3', placeholder: '- Что поменялось, по пункту в строке. Люди увидят это над правилами.' });
  changes.value = draft ? draft.changes : '';
  const save = async (quiet) => {
    await call(studio.admin.rulesDraft(body.value, changes.value));
    if (!quiet) toast('Черновик сохранён');
  };
  const nextVersion = draft ? draft.version : (cur ? cur.version + 1 : 1);
  box.append(
    h('div', { class: 'admin-sub', text: (draft ? 'Черновик версии ' : 'Новая версия ') + nextVersion }),
    h('p', { class: 'muted small', text: 'Разметка: "## " заголовок блока, "- " пункт списка, пустая строка между абзацами.' }),
    body,
    cur ? h('label', { class: 'field' }, h('span', { text: 'Что изменилось' }), changes) : null,
    h('div', { class: 'row gap-s' },
      h('button', { class: 'btn btn-s', type: 'button', text: 'Сохранить черновик', onclick: () => save().catch((e) => toast(errText(e.code))) }),
      h('button', { class: 'btn btn-s', type: 'button', text: 'Как увидят участники', onclick: () => showRules({ version: nextVersion, body: body.value, changes: cur ? changes.value : '' }, 'preview') }),
      h('button', { class: 'btn btn-s btn-accent', type: 'button', text: 'Опубликовать', onclick: async () => {
        const ok = await modal({
          title: 'Опубликовать версию ' + nextVersion + '?',
          body: 'Каждый участник при следующем действии в приложении увидит экран правил и не сможет работать, пока не примет их. Основатели правила не принимают.',
          ok: 'Опубликовать',
        });
        if (!ok) return;
        try {
          await save(true);
          await call(studio.admin.rulesPublish());
          toast('Версия ' + nextVersion + ' опубликована');
          loadAdminRules();
        } catch (err) {
          toast(errText(err.code));
        }
      } }),
    ),
  );

  const consents = d.consents || [];
  box.append(h('div', { class: 'admin-sub', text: 'Кто принял' }));
  if (!consents.length) box.append(h('p', { class: 'muted small', text: 'Пока никто.' }));
  else {
    const tb = h('tbody');
    for (const c of consents) {
      const u = S.users.get(c.user);
      tb.append(h('tr', {},
        h('td', { text: u ? u.name + ' (' + u.login + ')' : '#' + c.user }),
        h('td', { text: String(c.version) }),
        h('td', { text: c.firstName + ' ' + c.lastName }),
        h('td', { class: 'mono', text: c.email }),
        h('td', { text: new Date(c.created).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' }) }),
      ));
    }
    box.append(h('table', { class: 'table' }, h('thead', {}, h('tr', {}, ...['Аккаунт', 'Версия', 'Имя и фамилия', 'Почта', 'Когда'].map((t) => h('th', { text: t })))), tb));
  }
}
