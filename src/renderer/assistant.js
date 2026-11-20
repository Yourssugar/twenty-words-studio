'use strict';
// Раздел "Ассистент": личные чаты с моделью. Подключается после app.js и
// пользуется его помощниками (h, call, toast, modal, errText, S).

const AI = {
  chats: [],
  chat: null, // открытый чат
  messages: [],
  streaming: null, // { chatId, text } пока идёт ответ
  models: [], // доступные модели с остатком: [{model, label, used, daily, available, ...}]
  defaultModel: '',
  enabled: true,
  loaded: false,
  skills: [], // навыки от админа
  notes: [], // мой блокнот
  attach: [], // id заметок, приложенных к следующему сообщению
  note: null, // открытая в блокноте заметка: объект или 'new'
  notesOpen: false,
  est: null, // оценка токенов для текущего ввода
};

Object.assign(ERRORS, {
  too_long: 'Не влезает в объём контекста модели. Уберите часть вложений или сократите текст.',
  too_many: 'Слишком много: лимит заметок или вложений.',
  bad_title: 'Нужно название.',
});

// Модель открытого чата: своя, а если она недоступна, модель по умолчанию.
function currentModel() {
  const m = AI.chat && AI.chat.model;
  if (m && AI.models.some((x) => x.model === m)) return m;
  return AI.defaultModel;
}
const quotaOf = (model) => AI.models.find((x) => x.model === model) || null;

// 12 с, 1 мин 05 с
const fmtDur = (ms) => {
  const t = Math.max(0, Math.round(ms / 1000));
  return t < 60 ? t + ' с' : Math.floor(t / 60) + ' мин ' + String(t % 60).padStart(2, '0') + ' с';
};

const fmtTokens = (n) => {
  n = Number(n) || 0;
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '').replace('.', ',') + ' млн';
  if (n >= 1000) return Math.round(n / 1000) + ' тыс.';
  return String(n);
};

// ---------- разметка ответа ----------
// Только безопасное построение DOM: код в ``` блоках, `inline`, **жирный**, списки и абзацы.

function renderInline(text) {
  const out = [];
  const re = /`([^`\n]+)`|\*\*([^*\n]+)\*\*/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > last) out.push(...linkify(text.slice(last, m.index)));
    if (m[1] !== undefined) out.push(h('code', { class: 'inline', text: m[1] }));
    else out.push(h('strong', { text: m[2] }));
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(...linkify(text.slice(last)));
  return out;
}

function renderMarkdown(src) {
  const root = h('div', { class: 'md' });
  const parts = src.split(/```/);
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      // блок кода: первая строка может быть языком
      const nl = part.indexOf('\n');
      let lang = nl >= 0 ? part.slice(0, nl).trim() : '';
      let code = nl >= 0 ? part.slice(nl + 1) : part;
      if (!/^[\w#+.-]{0,20}$/.test(lang)) {
        code = part;
        lang = '';
      }
      code = code.replace(/\n$/, '');
      const copy = h('button', { class: 'mini', type: 'button', text: 'копировать' });
      copy.addEventListener('click', async () => {
        await call(studio.app.copy(code));
        copy.textContent = 'скопировано';
        setTimeout(() => (copy.textContent = 'копировать'), 1500);
      });
      const keep = h('button', { class: 'mini', type: 'button', text: 'в блокнот' });
      keep.addEventListener('click', () => saveToNotebook(lang, '```' + lang + '\n' + code + '\n```', keep));
      root.append(h('div', { class: 'codeblock' }, h('div', { class: 'codeblock-head' }, h('span', { text: lang || 'код' }), h('span', { class: 'row gap-s' }, keep, copy)), h('pre', {}, h('code', { text: code }))));
      return;
    }
    // обычный текст: абзацы и списки
    for (const block of part.split(/\n{2,}/)) {
      const lines = block.split('\n').filter((l) => l.trim() !== '');
      if (!lines.length) continue;
      if (lines.every((l) => /^\s*([-*]|\d+[.)])\s+/.test(l))) {
        const ordered = /^\s*\d/.test(lines[0]);
        const list = h(ordered ? 'ol' : 'ul');
        for (const l of lines) list.append(h('li', {}, renderInline(l.replace(/^\s*([-*]|\d+[.)])\s+/, ''))));
        root.append(list);
      } else if (/^#{1,4}\s/.test(lines[0]) && lines.length === 1) {
        root.append(h('div', { class: 'md-h' }, renderInline(lines[0].replace(/^#+\s/, ''))));
      } else {
        const p = h('p');
        lines.forEach((l, j) => {
          if (j) p.append(h('br'));
          p.append(...renderInline(l));
        });
        root.append(p);
      }
    }
  });
  return root;
}

// ---------- загрузка ----------

async function openAssistant() {
  try {
    const [chats, models, skills, notes] = await Promise.all([call(studio.ai.chats()), call(studio.ai.models()), call(studio.ai.skills()), call(studio.ai.notes())]);
    AI.chats = chats;
    AI.skills = skills;
    AI.notes = notes;
    applyModels(models);
    AI.loaded = true;
    if (!AI.chat && chats.length) await selectChat(chats[0].id);
    renderAI();
    scheduleEstimate(0);
  } catch (err) {
    toast(errText(err.code));
  }
  $('ai-text').focus();
}

function applyModels(r) {
  AI.models = r.models || [];
  AI.defaultModel = r.default || '';
  AI.enabled = r.enabled !== false;
}

async function refreshQuota() {
  try {
    applyModels(await call(studio.ai.models()));
  } catch {
    /* не страшно */
  }
  renderAIHeader();
  renderQuota();
}

async function selectChat(id) {
  try {
    const r = await call(studio.ai.messages(id));
    AI.chat = r.chat;
    AI.messages = r.messages;
  } catch (err) {
    toast(errText(err.code));
  }
  renderAI();
  scheduleEstimate(0);
}

// ---------- отрисовка ----------

function renderAI() {
  renderChatList();
  renderAIHeader();
  renderAILog(true);
  renderQuota();
  renderBar();
  renderNotes();
}

function renderChatList() {
  const list = $('ai-chat-list');
  list.innerHTML = '';
  if (!AI.chats.length) list.append(h('div', { class: 'side-empty', text: 'Чатов пока нет. Например: "Код", "Реклама", "Музыка".' }));
  for (const c of AI.chats) {
    list.append(h('button', { class: 'item' + (AI.chat && AI.chat.id === c.id ? ' is-on' : ''), onclick: () => selectChat(c.id) },
      h('span', { class: 'item-name', text: c.title }),
      AI.streaming && AI.streaming.chatId === c.id ? h('span', { class: 'tag', text: 'пишет' }) : null,
    ));
  }
}

function renderAIHeader() {
  const has = !!AI.chat;
  $('ai-tools').hidden = !has;
  $('ai-title').textContent = has ? AI.chat.title : 'Ассистент';
  $('ai-sub').textContent = has
    ? (AI.chat.system ? 'Установка: ' + AI.chat.system.slice(0, 90) + (AI.chat.system.length > 90 ? '...' : '') : 'без установки') + (AI.chat.summary ? ' · есть памятка' : '')
    : 'Создайте чат под свою задачу';
  $('ai-model-label').textContent = AI.enabled ? (AI.models.length ? 'Модели: ' + AI.models.map((m) => m.label).join(', ') : 'Модели не подключены') : 'Ассистент выключен админом';
  $('ai-composer').hidden = !has;
  $('ai-bar').hidden = !has;
  const sel = $('ai-model');
  sel.innerHTML = '';
  for (const m of AI.models) sel.append(h('option', { value: m.model, text: m.label }));
  sel.value = currentModel();
  sel.hidden = !AI.models.length;
}

function renderAILog(stick) {
  const log = $('ai-log');
  const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
  log.innerHTML = '';
  if (!AI.chat) {
    log.append(h('div', { class: 'log-empty' },
      h('div', { text: 'Отдельный чат под каждую задачу.' }),
      h('div', { class: 'muted', text: 'Модель помнит последние сообщения чата, а более ранние сворачивает в памятку.' }),
    ));
    return;
  }
  const upto = AI.chat.summaryUpto || 0;
  let foldShown = false;
  let prev = null;
  for (const m of AI.messages) {
    if (!foldShown && upto && m.id > upto) {
      log.append(h('div', { class: 'day', text: 'выше: свёрнуто в памятку' }));
      foldShown = true;
    }
    // Сколько шёл ответ: от сообщения человека до сохранения ответа.
    const dur = m.role === 'assistant' && prev && prev.role === 'user' ? m.created - prev.created : 0;
    log.append(aiBubble(m.role, m.content, m, false, dur));
    prev = m;
  }
  if (AI.streaming && AI.streaming.chatId === AI.chat.id) {
    log.append(aiBubble('assistant', AI.streaming.text, null, true));
  }
  if (!AI.messages.length && !AI.streaming) {
    log.append(h('div', { class: 'log-empty' }, h('div', { class: 'muted', text: 'Напишите первый вопрос.' })));
  }
  if (stick || nearBottom) log.scrollTop = log.scrollHeight;
}

function aiBubble(role, content, m, live, dur) {
  const mine = role === 'user';
  let body = mine ? h('div', { class: 'msg-text' }, linkify(content)) : renderMarkdown(content || '');
  let meta = null;
  if (live) {
    // Пока нет текста, модель думает: показываем это и таймер, чтобы не казалось, что всё зависло.
    if (!content) body = h('div', { class: 'ai-thinking' }, h('span', { text: 'Думает' }), h('span', { class: 'ai-dots' }, h('i'), h('i'), h('i')));
    const passed = fmtDur(Date.now() - AI.streaming.started);
    meta = h('div', { class: 'ai-meta' }, h('span', { id: 'ai-live-timer', text: (content ? 'пишет ' : '') + passed }));
  } else if (m && !mine) {
    const keep = h('button', { class: 'mini', type: 'button', text: 'в блокнот', title: 'Сохранить весь ответ в блокнот' });
    keep.addEventListener('click', () => saveToNotebook('', content, keep));
    meta = h('div', { class: 'ai-meta row gap-s' },
      m.tokensIn || m.tokensOut ? h('span', { text: `${fmtTokens(m.tokensIn + m.tokensOut)} токенов` }) : null,
      dur > 0 ? h('span', { text: 'ответ за ' + fmtDur(dur) }) : null,
      keep);
  }
  const attach = m && m.attach && m.attach.length
    ? h('div', { class: 'ai-attached' }, ...m.attach.map((a) => h('span', { class: 'chip', title: a.body.slice(0, 400), text: 'приложено: ' + a.title })))
    : null;
  return h('div', { class: 'ai-msg ' + (mine ? 'is-user' : 'is-ai') + (live ? ' is-live' : '') },
    h('div', { class: 'ai-who', text: mine ? (S.me ? S.me.name : 'Вы') : 'Ассистент' }),
    content || live ? body : null,
    attach,
    meta,
  );
}

function renderQuota() {
  const el = $('ai-quota');
  if (!AI.enabled) {
    el.hidden = false;
    $('ai-quota-fill').style.width = '0%';
    $('ai-quota-text').textContent = 'Ассистент выключен админом';
    return;
  }
  const q = quotaOf(currentModel());
  if (!q || !AI.chat) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  const pct = q.daily ? Math.min(100, Math.round((q.used / q.daily) * 100)) : 0;
  $('ai-quota-fill').style.width = pct + '%';
  el.classList.toggle('is-low', q.available < 20000);
  el.querySelector('.bar').hidden = !!q.unlimited;
  if (q.unlimited) {
    $('ai-quota-fill').style.width = '0%';
    el.classList.remove('is-low');
    $('ai-quota-text').textContent = `${q.label}: без лимита · сегодня потрачено ${fmtTokens(q.used)}`;
    return;
  }
  let text = `${q.label}: сегодня ${fmtTokens(q.used)} из ${fmtTokens(q.daily)}`;
  if (q.reason === 'pool_exceeded') text += ' · общая квота этой модели на сегодня закончилась';
  else if (q.used >= q.daily) text += q.sharing ? ` · из общего остатка доступно ${fmtTokens(q.available)}` : ' · личный лимит исчерпан, после 18:00 можно взять из общего остатка';
  else if (q.sharing && q.available > q.daily - q.used) text += ` · доступно ${fmtTokens(q.available)}: после 18:00 можно сверх личного лимита`;
  else text += ` · доступно ${fmtTokens(q.available)}`;
  $('ai-quota-text').textContent = text;
}

// ---------- действия ----------

$('ai-new').addEventListener('click', async () => {
  const title = h('input', { placeholder: 'Например: Код игры', maxlength: '80' });
  const system = h('textarea', { rows: 4, placeholder: 'Необязательно. Что модель должна знать в этом чате: роль, язык, стиль, проект.' });
  const model = h('select');
  for (const m of AI.models) model.append(h('option', { value: m.model, text: m.label }));
  model.value = AI.defaultModel;
  const body = h('div', {},
    h('label', { class: 'field' }, h('span', { text: 'Название' }), title),
    h('label', { class: 'field' }, h('span', { text: 'Модель' }), model),
    h('label', { class: 'field' }, h('span', { text: 'Установка' }), system),
  );
  setTimeout(() => title.focus());
  if (!(await modal({ title: 'Новый чат', body, ok: 'Создать' }))) return;
  try {
    const c = await call(studio.ai.createChat(title.value.trim(), system.value.trim(), model.value));
    AI.chats.unshift(c);
    AI.chat = c;
    AI.messages = [];
    renderAI();
    scheduleEstimate(0);
    $('ai-text').focus();
  } catch (err) {
    toast(errText(err.code));
  }
});

async function editField(field, title, hint) {
  const ta = h('textarea', { rows: field === 'summary' ? 12 : 6 });
  ta.value = AI.chat[field] || '';
  const body = h('div', {}, hint ? h('p', { class: 'muted small', text: hint }) : null, ta);
  setTimeout(() => ta.focus());
  if (!(await modal({ title, body, ok: 'Сохранить' }))) return;
  try {
    const c = await call(studio.ai.updateChat(AI.chat.id, { [field]: ta.value }));
    Object.assign(AI.chat, c);
    const i = AI.chats.findIndex((x) => x.id === c.id);
    if (i >= 0) AI.chats[i] = c;
    renderAI();
    scheduleEstimate(0);
  } catch (err) {
    toast(errText(err.code));
  }
}

$('ai-system-btn').addEventListener('click', () => editField('system', 'Установка чата', 'Уходит модели в каждом запросе этого чата. Например: "Помогаешь писать браузерные игры на чистом JS, без фреймворков".'));
$('ai-summary-btn').addEventListener('click', () => editField('summary', 'Памятка', 'Сюда модель сворачивает раннюю часть разговора, чтобы не тратить токены на всю историю. Если что-то важное потерялось, допишите сами.'));

$('ai-model').addEventListener('change', async (e) => {
  try {
    const c = await call(studio.ai.updateChat(AI.chat.id, { model: e.target.value }));
    Object.assign(AI.chat, c);
    const i = AI.chats.findIndex((x) => x.id === c.id);
    if (i >= 0) AI.chats[i] = c;
    renderQuota();
    scheduleEstimate(0);
  } catch (err) {
    toast(errText(err.code));
    e.target.value = currentModel();
  }
});

$('ai-rename-btn').addEventListener('click', async () => {
  const input = h('input', { maxlength: '80' });
  input.value = AI.chat.title;
  setTimeout(() => input.select());
  if (!(await modal({ title: 'Название чата', body: input, ok: 'Сохранить' }))) return;
  try {
    const c = await call(studio.ai.updateChat(AI.chat.id, { title: input.value }));
    Object.assign(AI.chat, c);
    const i = AI.chats.findIndex((x) => x.id === c.id);
    if (i >= 0) AI.chats[i] = c;
    renderAI();
  } catch (err) {
    toast(errText(err.code));
  }
});

$('ai-delete-btn').addEventListener('click', async () => {
  if (!(await modal({ title: 'Удалить чат?', body: `"${AI.chat.title}" и вся его переписка удалятся.`, ok: 'Удалить', danger: true }))) return;
  try {
    await call(studio.ai.deleteChat(AI.chat.id));
    AI.chats = AI.chats.filter((c) => c.id !== AI.chat.id);
    AI.chat = null;
    AI.messages = [];
    if (AI.chats.length) await selectChat(AI.chats[0].id);
    renderAI();
  } catch (err) {
    toast(errText(err.code));
  }
});

const aiText = $('ai-text');
aiText.addEventListener('input', () => {
  aiText.style.height = 'auto';
  aiText.style.height = Math.min(aiText.scrollHeight, 260) + 'px';
  scheduleEstimate();
});
aiText.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $('ai-composer').requestSubmit();
  }
});

function setStreaming(on) {
  $('ai-send').hidden = on;
  $('ai-stop').hidden = !on;
}

$('ai-composer').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = aiText.value.trim();
  if ((!text && !AI.attach.length) || !AI.chat) return;
  if (AI.streaming) {
    toast(errText('busy'));
    return;
  }
  if (AI.est && AI.est.fits === false) {
    toast(errText('too_long'));
    return;
  }
  const chatId = AI.chat.id;
  const notes = AI.attach.slice();
  AI.streaming = { chatId, text: '', started: Date.now() };
  const tick = setInterval(() => {
    const el = document.getElementById('ai-live-timer');
    if (el && AI.streaming) el.textContent = (AI.streaming.text ? 'пишет ' : '') + fmtDur(Date.now() - AI.streaming.started);
  }, 1000);
  aiText.value = '';
  aiText.style.height = 'auto';
  setStreaming(true);
  renderChatList();
  renderAILog(true);
  try {
    const final = await call(studio.ai.send(chatId, text, notes));
    if (!final || final.t !== 'error') {
      AI.attach = [];
      renderBar();
      renderNotes();
    }
    if (final && final.t === 'error') {
      if (final.code === 'cancelled') {
        // сервер сохраняет оборванный ответ: подтягиваем его сразу
        setTimeout(() => AI.chat && AI.chat.id === chatId && selectChat(chatId), 400);
      } else {
        toast(errText(final.code));
      }
    }
  } catch (err) {
    toast(errText(err.code));
    if (AI.chat && AI.chat.id === chatId && !AI.messages.some((m) => m.role === 'user' && m.content === text)) aiText.value = text;
  } finally {
    clearInterval(tick);
    AI.streaming = null;
    setStreaming(false);
    renderChatList();
    renderAILog();
    refreshQuota();
    scheduleEstimate(0);
    // памятка обновляется на сервере после ответа: перечитаем чат чуть позже
    setTimeout(() => {
      if (AI.chat && AI.chat.id === chatId && !AI.streaming) selectChat(chatId);
    }, 4000);
  }
});

$('ai-stop').addEventListener('click', () => {
  if (AI.streaming) studio.ai.stop(AI.streaming.chatId);
});

let aiFrame = 0;
studio.ai.onEvent((ev) => {
  // Модель размышляет: таймер уже идёт, перерисовывать нечего.
  if (ev.t === 'think') return;
  const own = AI.chat && AI.chat.id === ev.chatId;
  switch (ev.t) {
    case 'start':
      if (own) AI.messages.push(ev.user);
      break;
    case 'delta':
      if (AI.streaming && AI.streaming.chatId === ev.chatId) AI.streaming.text += ev.text;
      break;
    case 'done': {
      if (own) AI.messages.push(ev.message);
      if (AI.streaming && AI.streaming.chatId === ev.chatId) AI.streaming = null;
      if (ev.quota) {
        const i = AI.models.findIndex((x) => x.model === ev.quota.model);
        if (i >= 0) AI.models[i] = ev.quota;
      }
      renderQuota();
      const c = AI.chats.find((x) => x.id === ev.chatId);
      if (c) {
        c.updated = Date.now();
        AI.chats.sort((a, b) => b.updated - a.updated);
      }
      break;
    }
  }
  if (own && !aiFrame) {
    aiFrame = requestAnimationFrame(() => {
      aiFrame = 0;
      renderAILog();
    });
  }
});

// ---------- админка ассистента ----------

let aiAdminData = null;

async function loadAdminAI() {
  try {
    aiAdminData = await call(studio.admin.ai());
    renderAdminAI();
  } catch (err) {
    $('admin-ai-card').hidden = true;
  }
}

const poolTitle = (p) => p.labels.join(', ');

function renderAdminAI() {
  const d = aiAdminData;
  $('admin-ai-card').hidden = false;

  // Котлы: общий объём и личные лимиты по умолчанию
  const pools = $('admin-ai-pools');
  pools.innerHTML = '';
  if (!d.pools.length) {
    pools.append(h('p', { class: 'muted', text: 'Модели ещё не подключены. На сервере: tw-studio ai-openai (GPT и GPT-mini) и tw-studio ai-mistral (Devstral). Ключ API программа спросит отдельно.' }));
  }
  for (const p of d.pools) {
    const pct = p.daily && !p.unlimited ? Math.min(100, Math.round((p.used / p.daily) * 100)) : 0;
    const daily = h('input', { type: 'number', min: '1000', step: '100000', value: p.daily });
    const userDaily = h('input', { type: 'number', min: '1000', step: '10000', value: p.userDaily });
    const userMax = h('input', { type: 'number', min: '1000', step: '10000', value: p.userMax });
    const unl = h('input', { type: 'checkbox' });
    unl.checked = !!p.unlimited;
    const limits = h('span', { class: 'row wrap gap-s' },
      h('label', { class: 'inline' }, 'всего в сутки', daily),
      h('label', { class: 'inline' }, 'каждому', userDaily),
      h('label', { class: 'inline' }, 'вечером до', userMax),
    );
    limits.hidden = unl.checked;
    unl.addEventListener('change', () => (limits.hidden = unl.checked));
    const u = p.usage || { today: p.used, month: 0, total: 0 };
    const head = p.unlimited
      ? `без лимита · сегодня ${fmtTokens(u.today)} · за месяц ${fmtTokens(u.month)} · всего ${fmtTokens(u.total)}`
      : `сегодня ${fmtTokens(p.used)} из ${fmtTokens(p.daily)} · за месяц ${fmtTokens(u.month)} · всего ${fmtTokens(u.total)} · сервер остановится на ${d.rules.safetyPct}%`;
    pools.append(h('div', { class: 'pool' },
      h('div', { class: 'row between' }, h('strong', { text: poolTitle(p) }), h('span', { class: 'muted small', text: head })),
      p.unlimited ? null : h('div', { class: 'bar' }, h('i', { style: `width:${pct}%` })),
      h('div', { class: 'row wrap gap-s' },
        h('label', { class: 'inline', title: 'Лимиты не действуют, расход только считается. Для бесплатных моделей.' }, unl, 'без лимита'),
        limits,
        h('button', { class: 'btn btn-s', type: 'button', text: 'Сохранить', onclick: async () => {
          if (unl.checked && !p.unlimited && !(await modal({ title: 'Убрать лимиты?', body: 'Для ' + poolTitle(p) + ' перестанут действовать лимиты котла и личные. Если модель платная сверх бесплатного объёма, расход ничем не ограничен.', ok: 'Убрать' }))) return;
          try {
            await call(studio.admin.aiPool(p.name, { daily: Number(daily.value) || 0, userDaily: Number(userDaily.value) || 0, userMax: Number(userMax.value) || 0, unlimited: unl.checked }));
            toast('Сохранено: ' + poolTitle(p));
            loadAdminAI();
          } catch (err) {
            toast(errText(err.code));
          }
        } }),
      ),
    ));
  }

  const dm = $('aid-model');
  dm.innerHTML = '';
  for (const m of d.models) dm.append(h('option', { value: m.name, text: m.label }));
  dm.value = d.model;

  // Люди: общий выключатель, модель по умолчанию и доступ к каждому котлу
  const head = $('admin-ai-head');
  head.innerHTML = '';
  head.append(h('tr', {}, h('th', { text: 'Кто' }), h('th', { text: 'Вкл.' }), ...d.pools.map((p) => h('th', { text: poolTitle(p) + (p.unlimited ? '' : ', в день') })), h('th', { text: 'Сегодня' }), h('th', { text: 'За месяц' }), h('th', { text: 'Всего' }), h('th')));
  const tb = $('admin-ai-users');
  tb.innerHTML = '';
  for (const u of d.users) {
    const en = h('input', { type: 'checkbox' });
    en.checked = u.enabled;
    const cells = {};
    const poolTds = d.pools.map((p) => {
      const up = u.pools[p.name];
      const on = h('input', { type: 'checkbox', title: 'Доступ к ' + poolTitle(p) });
      on.checked = up.enabled;
      const daily = h('input', { type: 'number', min: '1000', step: '10000', placeholder: String(p.userDaily) });
      if (up.ownDaily) daily.value = up.ownDaily;
      cells[p.name] = { on, daily, ownMax: up.ownMax };
      // У котла без лимитов личный лимит не нужен: только доступ и расход.
      return h('td', {}, h('div', { class: 'row gap-s' }, on, p.unlimited ? null : daily), h('div', { class: 'muted small', text: 'сегодня ' + fmtTokens(up.used) }));
    });
    tb.append(h('tr', {},
      h('td', { text: u.name }),
      h('td', {}, en),
      ...poolTds,
      h('td', { text: fmtTokens(u.usage.today) }),
      h('td', { text: fmtTokens(u.usage.month) }),
      h('td', { text: fmtTokens(u.usage.total || 0) }),
      h('td', {}, h('button', { class: 'btn btn-s', type: 'button', text: 'Сохранить', onclick: async () => {
        const pools = {};
        for (const [name, c] of Object.entries(cells)) pools[name] = { enabled: c.on.checked, daily: Number(c.daily.value) || 0, max: c.ownMax || 0 };
        try {
          await call(studio.admin.aiUser(u.user, { enabled: en.checked, model: u.model, pools }));
          toast('Сохранено: ' + u.name);
          loadAdminAI();
        } catch (err) {
          toast(errText(err.code));
        }
      } })),
    ));
  }
  renderAdminExtras(d);
  $('admin-ai-rules').textContent = `Пустое поле "в день" значит лимит котла по умолчанию. Личный лимит гарантирован. До ${d.rules.shareHour}:00 по Варшаве остаток котла держится под личные лимиты остальных, после ${d.rules.shareHour}:00 его можно брать до значения "вечером до". Модель помнит ${d.rules.history} последних сообщений, памятка обновляется каждые ${d.rules.summarizeAfter / 2} обменов.`;
}

$('aid-save').addEventListener('click', async () => {
  try {
    await call(studio.admin.aiDefaults($('aid-model').value));
    toast('Сохранено');
    loadAdminAI();
  } catch (err) {
    toast(errText(err.code));
  }
});

// ---------- скиллы, вложения и оценка токенов ----------

function renderBar() {
  if (!AI.chat) return;
  const on = (AI.chat.skills || []).filter((id) => AI.skills.some((k) => k.id === id)).length;
  const sb = $('ai-skills-btn');
  sb.textContent = on ? 'Скиллы: ' + on : 'Скиллы';
  sb.classList.toggle('is-on', !!on);
  sb.hidden = !AI.skills.length;
  const box = $('ai-attach');
  box.innerHTML = '';
  for (const id of AI.attach) {
    const n = AI.notes.find((x) => x.id === id);
    if (!n) continue;
    box.append(h('span', { class: 'chip' }, h('span', { text: n.title }), h('button', { class: 'chip-x', type: 'button', title: 'Не прикладывать', text: 'x', onclick: () => toggleAttach(id) })));
  }
  renderEstimate();
}

function renderEstimate() {
  const el = $('ai-est');
  const e = AI.est;
  if (!e || !e.ctx) {
    el.textContent = '';
    return;
  }
  el.textContent = (e.fits ? 'около ' : 'не влезает: ') + fmtTokens(e.tokens) + ' из ' + fmtTokens(e.ctx) + ' токенов';
  el.classList.toggle('is-over', !e.fits);
  el.classList.toggle('is-high', e.fits && e.tokens > e.ctx * 0.75);
  el.title = 'Примерно столько токенов уйдёт в модель: установка, скиллы, памятка, ' + (e.history || 0) + ' сообщ. истории, вложения и текст. Ответ до ' + fmtTokens(e.out || 8000) + ' сверху.';
}

let estTimer = 0;
let estSeq = 0;
function scheduleEstimate(delay = 450) {
  clearTimeout(estTimer);
  estTimer = setTimeout(async () => {
    if (!AI.chat || !AI.models.length) {
      AI.est = null;
      renderEstimate();
      return;
    }
    const seq = ++estSeq;
    try {
      const r = await call(studio.ai.estimate(AI.chat.id, aiText.value, AI.attach));
      if (seq === estSeq) {
        AI.est = r;
        renderEstimate();
      }
    } catch {
      /* оценка не обязательна */
    }
  }, delay);
}

function toggleAttach(id) {
  const i = AI.attach.indexOf(id);
  if (i >= 0) AI.attach.splice(i, 1);
  else if (AI.attach.length >= 10) {
    toast('К одному сообщению можно приложить до 10 заметок.');
    return;
  } else AI.attach.push(id);
  renderBar();
  renderNotes();
  scheduleEstimate(0);
}

function closePop() {
  $('ai-skills-pop').hidden = true;
}

$('ai-skills-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  const pop = $('ai-skills-pop');
  if (!pop.hidden) {
    closePop();
    return;
  }
  pop.innerHTML = '';
  pop.append(h('div', { class: 'ai-pop-head' }, h('b', { text: 'Скиллы в этом чате' }), h('span', { class: 'muted small', text: 'дописываются к установке модели' })));
  const chosen = new Set(AI.chat.skills || []);
  for (const k of AI.skills) {
    const cb = h('input', { type: 'checkbox' });
    cb.checked = chosen.has(k.id);
    cb.addEventListener('change', async () => {
      const next = AI.skills.filter((x) => (x.id === k.id ? cb.checked : chosen.has(x.id))).map((x) => x.id);
      try {
        const c = await call(studio.ai.updateChat(AI.chat.id, { skills: next }));
        Object.assign(AI.chat, c);
        chosen.clear();
        for (const id of c.skills) chosen.add(id);
        renderBar();
        scheduleEstimate(0);
      } catch (err) {
        cb.checked = !cb.checked;
        toast(errText(err.code));
      }
    });
    pop.append(h('label', { class: 'ai-skill', title: k.prompt }, cb, h('span', {}, h('span', { class: 'ai-skill-name', text: k.name }), k.descr ? h('span', { class: 'muted small', text: k.descr }) : null)));
  }
  pop.hidden = false;
});
document.addEventListener('click', (e) => {
  if (!$('ai-skills-pop').hidden && !e.target.closest('#ai-skills-pop')) closePop();
});

$('ai-attach-btn').addEventListener('click', () => {
  AI.notesOpen = true;
  AI.note = null;
  renderNotes();
  if (!AI.notes.length) toast('Блокнот пуст. Сохраните туда код или текст кнопкой "в блокнот" под ответом.');
});

// ---------- блокнот ----------

async function saveToNotebook(title, body, btn) {
  try {
    const n = await call(studio.ai.addNote(title, body));
    AI.notes.unshift(n);
    if (btn) {
      btn.textContent = 'сохранено';
      setTimeout(() => (btn.textContent = 'в блокнот'), 1500);
    }
    if (AI.notesOpen) renderNotes();
  } catch (err) {
    toast(errText(err.code));
  }
}

$('ai-notes-btn').addEventListener('click', () => {
  AI.notesOpen = !AI.notesOpen;
  AI.note = null;
  renderNotes();
});

function renderNotes() {
  const box = $('ai-notes');
  box.hidden = !AI.notesOpen;
  $('ai-notes-btn').classList.toggle('is-on', AI.notesOpen);
  if (!AI.notesOpen) return;
  box.innerHTML = '';
  if (AI.note) {
    renderNoteEditor(box);
    return;
  }
  box.append(h('div', { class: 'notes-head' },
    h('div', { class: 'grow' }, h('div', { class: 'side-title', text: 'Блокнот' }), h('div', { class: 'muted small', text: 'Только ваш. Галочка прикладывает заметку к следующему сообщению.' })),
    h('button', { class: 'btn btn-s', type: 'button', text: 'Закрыть', onclick: () => { AI.notesOpen = false; renderNotes(); } }),
  ));
  box.append(h('div', { class: 'notes-tools' }, h('button', { class: 'btn btn-accent btn-s', type: 'button', text: 'Новая заметка', onclick: () => { AI.note = 'new'; renderNotes(); } })));
  const list = h('div', { class: 'notes-list' });
  if (!AI.notes.length) list.append(h('div', { class: 'muted small notes-empty', text: 'Пусто. Под каждым ответом и блоком кода есть кнопка "в блокнот".' }));
  for (const n of AI.notes) {
    const cb = h('input', { type: 'checkbox', title: 'Приложить к следующему сообщению' });
    cb.checked = AI.attach.includes(n.id);
    cb.addEventListener('change', () => toggleAttach(n.id));
    const preview = n.body.replace(/```\w*\n?/g, '').trim();
    list.append(h('div', { class: 'note' + (cb.checked ? ' is-on' : '') },
      cb,
      h('button', { class: 'note-open', type: 'button', onclick: () => { AI.note = n; renderNotes(); } },
        h('div', { class: 'note-title', text: n.title }),
        h('div', { class: 'note-preview', text: preview.length > 120 ? preview.slice(0, 118) + '...' : preview }),
        h('div', { class: 'note-meta', text: dayLabel(n.updated) + ' · около ' + fmtTokens(Math.round([...n.body].length / 3) + 4) + ' токенов' }),
      ),
    ));
  }
  box.append(list);
}

function renderNoteEditor(box) {
  const n = AI.note === 'new' ? { title: '', body: '' } : AI.note;
  const title = h('input', { maxlength: '80', placeholder: 'Название (можно пусто: возьмётся из первой строки)' });
  const body = h('textarea', { class: 'note-body', spellcheck: 'false', placeholder: 'Код, идея, памятка' });
  title.value = n.title;
  body.value = n.body;
  const save = async () => {
    try {
      if (AI.note === 'new') {
        const saved = await call(studio.ai.addNote(title.value, body.value));
        AI.notes.unshift(saved);
        AI.note = saved;
      } else {
        const saved = await call(studio.ai.editNote(n.id, title.value, body.value));
        const i = AI.notes.findIndex((x) => x.id === saved.id);
        if (i >= 0) AI.notes.splice(i, 1);
        AI.notes.unshift(saved);
        AI.note = saved;
      }
      toast('Сохранено');
      renderNotes();
      renderBar();
      if (AI.attach.includes(AI.note.id)) scheduleEstimate(0);
    } catch (err) {
      toast(errText(err.code));
    }
  };
  body.addEventListener('keydown', (e) => {
    if (e.key === 's' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      save();
    }
    if (e.key === 'Tab' && !e.shiftKey) {
      e.preventDefault();
      body.setRangeText('  ', body.selectionStart, body.selectionEnd, 'end');
    }
  });
  box.append(
    h('div', { class: 'notes-head' },
      h('button', { class: 'btn btn-s', type: 'button', text: 'Назад', onclick: () => { AI.note = null; renderNotes(); } }),
      h('div', { class: 'grow' }),
      AI.note !== 'new' ? h('button', { class: 'btn btn-s', type: 'button', text: AI.attach.includes(n.id) ? 'Не прикладывать' : 'Приложить', onclick: () => toggleAttach(n.id) }) : null,
    ),
    h('div', { class: 'note-edit' },
      title,
      body,
      h('div', { class: 'row gap-s' },
        h('button', { class: 'btn btn-accent btn-s', type: 'button', text: 'Сохранить', title: 'Ctrl+S', onclick: save }),
        h('button', { class: 'btn btn-s', type: 'button', text: 'Копировать', onclick: async () => { await call(studio.app.copy(body.value)); toast('Скопировано'); } }),
        h('div', { class: 'grow' }),
        AI.note !== 'new' ? h('button', { class: 'btn btn-s btn-danger-ghost', type: 'button', text: 'Удалить', onclick: async () => {
          if (!(await modal({ title: 'Удалить заметку?', body: '"' + n.title + '" удалится из блокнота.', ok: 'Удалить', danger: true }))) return;
          try {
            await call(studio.ai.deleteNote(n.id));
            AI.notes = AI.notes.filter((x) => x.id !== n.id);
            AI.attach = AI.attach.filter((x) => x !== n.id);
            AI.note = null;
            renderNotes();
            renderBar();
            scheduleEstimate(0);
          } catch (err) {
            toast(errText(err.code));
          }
        } }) : null,
      ),
    ),
  );
  setTimeout(() => (AI.note === 'new' ? body : body).focus(), 30);
}

// ---------- админка: установка, скиллы, модели ----------

function renderAdminExtras(d) {
  const sys = $('aid-system');
  if (document.activeElement !== sys) sys.value = d.system || '';

  const sk = $('admin-ai-skills');
  sk.innerHTML = '';
  for (const k of d.skills || []) {
    sk.append(h('div', { class: 'skill-row' },
      h('div', { class: 'grow' }, h('b', { text: k.name }), k.descr ? h('div', { class: 'muted small', text: k.descr }) : null),
      h('button', { class: 'btn btn-s', type: 'button', text: 'Изменить', onclick: () => editSkill(k) }),
      h('button', { class: 'btn btn-s btn-danger-ghost', type: 'button', text: 'Удалить', onclick: async () => {
        if (!(await modal({ title: 'Удалить скилл?', body: '"' + k.name + '" пропадёт у всех чатов, где он включён.', ok: 'Удалить', danger: true }))) return;
        try {
          await call(studio.admin.aiDeleteSkill(k.id));
          loadAdminAI();
        } catch (err) {
          toast(errText(err.code));
        }
      } }),
    ));
  }
  if (!(d.skills || []).length) sk.append(h('p', { class: 'muted small', text: 'Скиллов нет.' }));

  const md = $('admin-ai-models');
  md.innerHTML = '';
  if (!d.models.length) md.append(h('p', { class: 'muted small', text: 'Модели ещё не подключены.' }));
  for (const m of d.models) {
    const ctx = h('input', { type: 'number', min: String(d.rules.ctxMin || 4000), max: String(d.rules.ctxMax || 1000000), step: '4000', value: m.ctx });
    md.append(h('div', { class: 'row wrap gap-s model-row' },
      h('b', { class: 'model-name', text: m.label }),
      h('label', { class: 'inline' }, 'контекст за запрос, токенов', ctx),
      h('button', { class: 'btn btn-s', type: 'button', text: 'Сохранить', onclick: async () => {
        try {
          await call(studio.admin.aiModel(m.name, Number(ctx.value) || 0));
          toast('Сохранено: ' + m.label);
          loadAdminAI();
        } catch (err) {
          toast(errText(err.code));
        }
      } }),
    ));
  }
}

async function editSkill(k) {
  const name = h('input', { maxlength: '40', placeholder: 'Например: Без ИИ-паттернов' });
  const descr = h('input', { maxlength: '160', placeholder: 'Одна строка: что делает' });
  const prompt = h('textarea', { rows: '10', maxlength: '4000', placeholder: 'Текст для модели. Дописывается к установке, когда скилл включён.' });
  if (k) {
    name.value = k.name;
    descr.value = k.descr;
    prompt.value = k.prompt;
  }
  const body = h('div', {},
    h('label', { class: 'field' }, h('span', { text: 'Название' }), name),
    h('label', { class: 'field' }, h('span', { text: 'Описание' }), descr),
    h('label', { class: 'field' }, h('span', { text: 'Текст для модели' }), prompt),
  );
  setTimeout(() => name.focus(), 30);
  if (!(await modal({ title: k ? 'Скилл' : 'Новый скилл', body, ok: 'Сохранить' }))) return;
  const data = { name: name.value, descr: descr.value, prompt: prompt.value };
  try {
    if (k) await call(studio.admin.aiEditSkill(k.id, data));
    else await call(studio.admin.aiAddSkill(data));
    loadAdminAI();
  } catch (err) {
    toast(errText(err.code));
  }
}

$('aid-skill-add').addEventListener('click', () => editSkill(null));
$('aid-system-save').addEventListener('click', async () => {
  try {
    const r = await call(studio.admin.aiSystem($('aid-system').value));
    $('aid-system').value = r.system;
    toast('Установка сохранена');
  } catch (err) {
    toast(errText(err.code));
  }
});
