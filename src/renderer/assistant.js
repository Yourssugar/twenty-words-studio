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
};

// Модель открытого чата: своя, а если она недоступна, модель по умолчанию.
function currentModel() {
  const m = AI.chat && AI.chat.model;
  if (m && AI.models.some((x) => x.model === m)) return m;
  return AI.defaultModel;
}
const quotaOf = (model) => AI.models.find((x) => x.model === model) || null;

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
      root.append(h('div', { class: 'codeblock' }, h('div', { class: 'codeblock-head' }, h('span', { text: lang || 'код' }), copy), h('pre', {}, h('code', { text: code }))));
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
    const [chats, models] = await Promise.all([call(studio.ai.chats()), call(studio.ai.models())]);
    AI.chats = chats;
    applyModels(models);
    AI.loaded = true;
    if (!AI.chat && chats.length) await selectChat(chats[0].id);
    renderAI();
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
}

// ---------- отрисовка ----------

function renderAI() {
  renderChatList();
  renderAIHeader();
  renderAILog(true);
  renderQuota();
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
  for (const m of AI.messages) {
    if (!foldShown && upto && m.id > upto) {
      log.append(h('div', { class: 'day', text: 'выше: свёрнуто в памятку' }));
      foldShown = true;
    }
    log.append(aiBubble(m.role, m.content, m));
  }
  if (AI.streaming && AI.streaming.chatId === AI.chat.id) {
    log.append(aiBubble('assistant', AI.streaming.text || '...', null, true));
  }
  if (!AI.messages.length && !AI.streaming) {
    log.append(h('div', { class: 'log-empty' }, h('div', { class: 'muted', text: 'Напишите первый вопрос.' })));
  }
  if (stick || nearBottom) log.scrollTop = log.scrollHeight;
}

function aiBubble(role, content, m, live) {
  const mine = role === 'user';
  const body = mine ? h('div', { class: 'msg-text' }, linkify(content)) : renderMarkdown(content);
  const meta = m && !mine && (m.tokensIn || m.tokensOut) ? h('div', { class: 'ai-meta', text: `${fmtTokens(m.tokensIn + m.tokensOut)} токенов` }) : null;
  return h('div', { class: 'ai-msg ' + (mine ? 'is-user' : 'is-ai') + (live ? ' is-live' : '') },
    h('div', { class: 'ai-who', text: mine ? (S.me ? S.me.name : 'Вы') : 'Ассистент' }),
    body,
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
  if (!text || !AI.chat) return;
  if (AI.streaming) {
    toast(errText('busy'));
    return;
  }
  const chatId = AI.chat.id;
  AI.streaming = { chatId, text: '' };
  aiText.value = '';
  aiText.style.height = 'auto';
  setStreaming(true);
  renderChatList();
  renderAILog(true);
  try {
    const final = await call(studio.ai.send(chatId, text));
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
    AI.streaming = null;
    setStreaming(false);
    renderChatList();
    renderAILog();
    refreshQuota();
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
    const pct = p.daily ? Math.min(100, Math.round((p.used / p.daily) * 100)) : 0;
    const daily = h('input', { type: 'number', min: '1000', step: '100000', value: p.daily });
    const userDaily = h('input', { type: 'number', min: '1000', step: '10000', value: p.userDaily });
    const userMax = h('input', { type: 'number', min: '1000', step: '10000', value: p.userMax });
    pools.append(h('div', { class: 'pool' },
      h('div', { class: 'row between' }, h('strong', { text: poolTitle(p) }), h('span', { class: 'muted small', text: `сегодня ${fmtTokens(p.used)} из ${fmtTokens(p.daily)} · сервер остановится на ${d.rules.safetyPct}%` })),
      h('div', { class: 'bar' }, h('i', { style: `width:${pct}%` })),
      h('div', { class: 'row wrap gap-s' },
        h('label', { class: 'inline' }, 'всего в сутки', daily),
        h('label', { class: 'inline' }, 'каждому', userDaily),
        h('label', { class: 'inline' }, 'вечером до', userMax),
        h('button', { class: 'btn btn-s', type: 'button', text: 'Сохранить', onclick: async () => {
          try {
            await call(studio.admin.aiPool(p.name, { daily: Number(daily.value) || 0, userDaily: Number(userDaily.value) || 0, userMax: Number(userMax.value) || 0 }));
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
  head.append(h('tr', {}, h('th', { text: 'Кто' }), h('th', { text: 'Вкл.' }), ...d.pools.map((p) => h('th', { text: poolTitle(p) + ', в день' })), h('th', { text: 'Сегодня' }), h('th', { text: 'За месяц' }), h('th')));
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
      return h('td', {}, h('div', { class: 'row gap-s' }, on, daily), h('div', { class: 'muted small', text: 'сегодня ' + fmtTokens(up.used) }));
    });
    tb.append(h('tr', {},
      h('td', { text: u.name }),
      h('td', {}, en),
      ...poolTds,
      h('td', { text: fmtTokens(u.usage.today) }),
      h('td', { text: fmtTokens(u.usage.month) }),
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
