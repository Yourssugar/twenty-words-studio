'use strict';
// Лента команды на главной: узкая панель слева от графа. Кто что сделал за две недели:
// подтверждённые отчёты, баги, идеи, уязвимости, переходы по ссылкам, новые темы и
// участники. Только баллы, без денег. Сворачивается в ярлычок; пока открыт список
// карточек ветки или тема, панель прячется, чтобы не мешать.

const FD = { items: [], now: 0, loaded: false, seenAt: 0, timer: 0, visible: false, loading: false };

function feedOpenSetting() {
  return !LOOK.s || LOOK.s.feedOpen !== false;
}

// Видна ли панель сейчас: открыта, на главной, не открыта ветка или тема, окно не узкое.
function feedVisible() {
  const stage = document.querySelector('.home-stage');
  return S.view === 'home' && feedOpenSetting() && !B.open && !B.topic && !!stage && stage.clientWidth >= 1000 && !document.documentElement.classList.contains('focus-mode');
}

async function loadFeed() {
  if (FD.loading) return;
  FD.loading = true;
  try {
    const r = await call(studio.team.feed());
    FD.items = r.feed;
    FD.now = r.now;
    FD.loaded = true;
    renderFeed();
  } catch {
    /* лента не главное: попробуем в следующий раз */
  } finally {
    FD.loading = false;
  }
}

function feedAgo(at) {
  const diff = Date.now() - at;
  if (diff < 60000) return 'только что';
  if (diff < 3600000) return Math.floor(diff / 60000) + ' мин назад';
  const d = new Date(at);
  const today = new Date();
  const time = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === today.toDateString()) return 'сегодня в ' + time;
  const y = new Date(today);
  y.setDate(y.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return 'вчера';
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}

function feedText(f, name) {
  switch (f.kind) {
    case 'report':
      return f.count
        ? name + ': подтверждён отчёт, ' + f.count + ' ' + plural(f.count, 'публикация', 'публикации', 'публикаций') + (f.text ? ' (' + f.text + ')' : '')
        : name + ': подтверждена аналитика' + (f.text ? ' (' + f.text + ')' : '');
    case 'bugs':
      return name + ': ' + f.count + ' ' + plural(f.count, 'визуальный баг', 'визуальных бага', 'визуальных багов');
    case 'vuln':
      return name + ': найдена уязвимость';
    case 'idea':
      return name + ': принята идея';
    case 'refs':
      return name + ': ' + f.count + ' ' + plural(f.count, 'переход', 'перехода', 'переходов') + (f.text === 'link' ? ' по ссылке за ' + feedAgo(f.at).replace('сегодня в', 'сегодня') : '');
    case 'card':
      return name + ': новая тема "' + f.text + '"';
    case 'member':
      return name === 'Вы' ? 'Вы присоединились к команде' : 'В команде новый участник: ' + name;
    default:
      return name;
  }
}

function renderFeed() {
  const stage = document.querySelector('.home-stage');
  if (!stage) return;
  let box = $('feed');
  if (!box) {
    box = h('aside', { class: 'feed', id: 'feed' });
    stage.append(box);
  }
  box.innerHTML = '';
  const vis = feedVisible();
  FD.visible = vis;
  box.classList.toggle('is-collapsed', !feedOpenSetting());
  box.hidden = S.view !== 'home' || !!B.open || !!B.topic;
  box.classList.toggle('is-narrow', false);
  if (!feedOpenSetting()) {
    box.append(h('div', { class: 'feed-tabs' }, h('button', { class: 'feed-tab', type: 'button', text: 'Лента команды', onclick: () => setFeedOpen(true) }), focusEntry()));
    return;
  }
  if (!vis) {
    // Окно узкое для ленты: остаётся только кнопка фокуса.
    box.classList.add('is-narrow');
    box.append(h('div', { class: 'feed-tabs' }, focusEntry()));
    return;
  }
  box.append(h('header', { class: 'feed-head' },
    h('span', { text: 'Лента команды' }),
    focusEntry(),
    h('button', { class: 'feed-x', type: 'button', title: 'Свернуть ленту', text: 'скрыть', onclick: () => setFeedOpen(false) }),
  ));
  const list = h('div', { class: 'feed-list' });
  if (FD.loaded && !FD.items.length) list.append(h('p', { class: 'muted small', text: 'За две недели событий нет. Здесь появятся отчёты, баги, идеи, переходы и новые темы.' }));
  if (!FD.loaded) list.append(skeleton('lines', 5));
  for (const f of FD.items) {
    const u = S.users.get(f.user) || { name: 'Участник', avatar: {} };
    const name = u.id === S.me.id ? 'Вы' : u.name;
    const fresh = FD.seenAt && f.at > FD.seenAt;
    const link = f.kind === 'card' && B.cards.has(f.ref);
    list.append(h('div', { class: 'feed-item' + (fresh ? ' is-new' : '') + (link ? ' is-link' : ''), onclick: link ? () => openTopic(f.ref) : null },
      avatar(u, 26),
      h('div', { class: 'feed-body' },
        h('div', { class: 'feed-text', text: feedText(f, name) }),
        h('div', { class: 'feed-meta' },
          h('span', { text: feedAgo(f.at) }),
          f.points ? h('b', { text: '+' + pts(f.points) + ' ' + (Number.isInteger(f.points) ? plural(f.points, 'балл', 'балла', 'баллов') : 'балла') }) : null,
        ),
      ),
    ));
  }
  box.append(list);
  FD.seenAt = Math.max(FD.seenAt, ...FD.items.map((f) => f.at), 1);
}

async function setFeedOpen(open) {
  try {
    LOOK.s = await call(studio.settings.set({ feedOpen: open }));
  } catch {
    LOOK.s = { ...LOOK.s, feedOpen: open };
  }
  renderFeed();
}

// Перечитать ленту чуть позже: несколько событий подряд дают один запрос.
function feedSoon() {
  clearTimeout(FD.timer);
  FD.timer = setTimeout(loadFeed, 700);
}

// Каждые 5 минут, пока открыта главная: "только что" должно стареть.
setInterval(() => {
  if (S.view === 'home' && !document.hidden && S.me) loadFeed();
}, 5 * 60 * 1000);
