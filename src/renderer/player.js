'use strict';
// Плеер в полосе заголовка: играть или пауза, следующий трек, название. По нажатию на
// название открывается панель: источник (студия, своя папка, радио, фоновые звуки),
// громкость, список радиостанций.
//
// Студийные треки и своя папка играют вперемешку, без повторов, пока не прозвучат все.
// Фоновые звуки (дождь, ветер, море, камин, шум) синтезируются здесь же через WebAudio:
// файлов нет, повторов на слух не слышно.

const PL = {
  s: null,
  source: 'studio',
  tracks: [], // [{ id, title }]
  bag: [], // ещё не игравшие в этом круге
  cur: null, // { id, title } или станция
  playing: false,
  autoPaused: false,
  fails: 0,
  info: '', // строка под источником в панели
  audio: null,
  amb: null, // { ctx, master, nodes, timer }
  radioTab: '', // 'mine' или 'find'
  rq: '', // поиск станций: строка, подборка, результаты
  rpreset: 'top',
  rres: null,
  rmore: false,
  rbusy: false,
};

const RADIO_PRESETS = [['top', 'Популярные'], ['pl', 'Польша'], ['ru', 'На русском'], ['lofi', 'Lo-fi'], ['chill', 'Chillout'], ['ambient', 'Ambient'], ['jazz', 'Джаз'], ['classic', 'Классика'], ['electro', 'Электроника'], ['rock', 'Рок']];

const SOURCES = [['studio', 'Студия'], ['folder', 'Моя папка'], ['radio', 'Радио'], ['ambient', 'Фоновые звуки']];
const AMBIENTS = [['rain', 'Дождь'], ['wind', 'Ветер'], ['ocean', 'Море'], ['fire', 'Камин'], ['pink', 'Мягкий шум'], ['brown', 'Глубокий шум']];

Object.assign(ERRORS, {
  music_none: 'В репозитории студии пока нет папки с музыкой.',
  music_offline: 'Список студийных треков не загрузился: нет связи с GitHub.',
  radio_catalog: 'Каталог радиостанций не отвечает. Попробуйте позже.',
  radio_full: 'В "Моих станциях" уже 50 станций. Уберите ненужные.',
});

function initPlayer(s) {
  PL.s = s;
  PL.source = s.musicSource;
  PL.audio = new Audio();
  PL.audio.preload = 'auto';
  PL.audio.volume = s.musicVolume;
  PL.audio.addEventListener('ended', () => nextTrack());
  PL.audio.addEventListener('playing', () => { PL.fails = 0; });
  PL.audio.addEventListener('error', () => {
    if (!PL.playing) return;
    if (PL.cur && PL.cur.preview) {
      stopMusic();
      toast('Станция "' + PL.cur.title + '" не отвечает. Попробуйте другую.');
      return;
    }
    PL.fails += 1;
    if (PL.fails >= 3) {
      stopMusic();
      toast(PL.source === 'radio' ? 'Радио не отвечает. Проверьте ссылку на станцию.' : 'Музыка не играет: файлы не открываются.');
      return;
    }
    nextTrack();
  });
  $('pl-play').addEventListener('click', () => (PL.playing ? stopMusic() : playMusic()));
  $('pl-next').addEventListener('click', () => nextTrack());
  $('pl-name').addEventListener('click', togglePlayerPanel);
  document.addEventListener('mousedown', (e) => {
    const pop = $('player-pop');
    if (!pop.hidden && !pop.contains(e.target) && !$('player').contains(e.target)) pop.hidden = true;
  });
  // Медиаклавиши на клавиатуре.
  if (navigator.mediaSession) {
    navigator.mediaSession.setActionHandler('play', () => playMusic());
    navigator.mediaSession.setActionHandler('pause', () => stopMusic());
    navigator.mediaSession.setActionHandler('nexttrack', () => nextTrack());
  }
  drawPlayer();
  if (s.musicAuto) playMusic();
}

function onMusicSettings(s) {
  PL.s = s;
  if (PL.audio) PL.audio.volume = s.musicVolume;
  if (PL.amb) PL.amb.master.gain.value = ambientGain(s.musicVolume);
}

// Окно свернули или развернули.
function onWindowHidden(hidden) {
  if (!PL.s || !PL.s.musicPauseMin) return;
  if (hidden && PL.playing) {
    PL.autoPaused = true;
    stopMusic(true);
  } else if (!hidden && PL.autoPaused) {
    PL.autoPaused = false;
    playMusic();
  }
}

// Во встроенном браузере заиграло видео или звук: музыка студии ждёт.
function onBrowserAudio(on) {
  if (!PL.s || !PL.s.musicPauseWeb) return;
  if (on && PL.playing) {
    PL.webPaused = true;
    stopMusic(true);
  } else if (!on && PL.webPaused) {
    PL.webPaused = false;
    if (!PL.autoPaused) playMusic();
  }
}
studio.browser.onAudio((d) => onBrowserAudio(!!d.on));

// ---------- источники ----------

async function loadTracks() {
  PL.tracks = [];
  PL.bag = [];
  PL.info = '';
  const src = PL.source;
  if (src === 'studio') {
    const r = await call(studio.music.studio(false));
    if (PL.source !== src) return; // пока грузился список, источник сменили
    PL.tracks = r.tracks;
    PL.info = r.tracks.length ? 'Треков: ' + r.tracks.length + ', скачано: ' + r.tracks.filter((t) => t.cached).length : 'Треков пока нет.';
  } else if (src === 'folder') {
    const r = await call(studio.music.folder());
    if (PL.source !== src) return;
    PL.tracks = r.tracks;
    PL.info = r.folder ? r.folder + ', треков: ' + r.tracks.length : 'Папка не выбрана.';
  } else if (PL.source === 'radio') {
    PL.tracks = PL.s.musicRadios.map((r, i) => ({ id: String(i), title: r.name }));
    PL.info = PL.tracks.length ? '' : 'Своих станций пока нет: найдите во вкладке "Найти" или добавьте ссылку на поток.';
  }
}

function srcFor(t) {
  return 'twmusic://' + PL.source + '/' + encodeURIComponent(t.id);
}

async function playMusic() {
  PL.webPaused = false;
  if (typeof coreCount === 'function') coreCount('music', 1, PL.source === 'ambient' ? 'ambient' : PL.source); // Core: только источник, без треков
  if (PL.source === 'ambient') {
    startAmbient(PL.s.musicAmbient);
    PL.playing = true;
    PL.cur = { title: AMBIENTS.find(([v]) => v === PL.s.musicAmbient)[1] };
    drawPlayer();
    return;
  }
  if (PL.cur && PL.audio.src && PL.source !== 'radio') {
    PL.playing = true;
    PL.audio.play().catch(() => {});
    drawPlayer();
    return;
  }
  await nextTrack(true);
}

function stopMusic(keepAuto) {
  if (!keepAuto) PL.autoPaused = PL.webPaused = false;
  PL.playing = false;
  if (PL.audio) {
    PL.audio.pause();
    if (PL.source === 'radio') PL.audio.removeAttribute('src'); // поток не копим в паузе
  }
  stopAmbient();
  drawPlayer();
}

async function nextTrack(start) {
  if (PL.source === 'ambient') {
    const i = AMBIENTS.findIndex(([v]) => v === PL.s.musicAmbient);
    const next = AMBIENTS[(i + 1) % AMBIENTS.length][0];
    PL.s.musicAmbient = next;
    studio.settings.set({ musicAmbient: next });
    if (PL.playing || start) await playMusic();
    else drawPlayer();
    return;
  }
  try {
    if (!PL.tracks.length) await loadTracks();
  } catch (err) {
    toast(errText(err.code));
    stopMusic();
    return;
  }
  if (!PL.tracks.length) {
    toast(PL.info || 'Играть нечего.');
    stopMusic();
    openPlayerPanel();
    return;
  }
  let t;
  if (PL.source === 'radio' && start && PL.cur && PL.cur.preview) {
    playRadio(PL.cur); // после паузы играет та же найденная станция
    return;
  }
  if (PL.source === 'radio') {
    const i = PL.cur ? PL.tracks.findIndex((x) => x.id === PL.cur.id) : -1;
    t = PL.tracks[start && i >= 0 ? i : (i + 1) % PL.tracks.length];
    if (start && i < 0) t = PL.tracks[Math.min(PL.s.musicRadio, PL.tracks.length - 1)];
    studio.settings.set({ musicRadio: Number(t.id) });
  } else {
    if (!PL.bag.length) {
      PL.bag = PL.tracks.map((_, i) => i);
      for (let i = PL.bag.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [PL.bag[i], PL.bag[j]] = [PL.bag[j], PL.bag[i]];
      }
      // Новый круг не начинается с того же трека, которым кончился прошлый.
      if (PL.cur && PL.bag.length > 1 && PL.tracks[PL.bag[PL.bag.length - 1]].id === PL.cur.id) PL.bag.unshift(PL.bag.pop());
    }
    t = PL.tracks[PL.bag.pop()];
  }
  PL.cur = t;
  PL.playing = true;
  PL.audio.src = srcFor(t);
  PL.audio.play().catch(() => {});
  if (navigator.mediaSession) navigator.mediaSession.metadata = new MediaMetadata({ title: t.title, artist: 'Twenty Words Studio' });
  drawPlayer();
}

async function setSource(src) {
  const was = PL.playing;
  stopMusic();
  PL.source = src;
  PL.cur = null;
  PL.audio.removeAttribute('src');
  try {
    PL.s = await call(studio.settings.set({ musicSource: src }));
    if (src !== 'ambient') await loadTracks();
  } catch (err) {
    PL.info = errText(err.code);
  }
  if (was) await playMusic();
  drawPlayer();
  drawPlayerPanel();
}

// ---------- фоновые звуки ----------

const ambientGain = (v) => v * 0.6;

// Шумы длиной 8 секунд с плавной склейкой концов.
function noiseBuffer(ctx, kind, secs = 8) {
  const n = ctx.sampleRate * secs;
  const buf = ctx.createBuffer(2, n, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let b0 = 0, b1 = 0, b2 = 0, last = 0;
    for (let i = 0; i < n; i++) {
      const w = Math.random() * 2 - 1;
      if (kind === 'pink') {
        b0 = 0.99765 * b0 + w * 0.099046;
        b1 = 0.963 * b1 + w * 0.2965164;
        b2 = 0.57 * b2 + w * 1.0526913;
        d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.11;
      } else if (kind === 'brown') {
        last = (last + 0.02 * w) / 1.02;
        d[i] = last * 3.2;
      } else {
        d[i] = w * 0.5;
      }
    }
    const fade = Math.floor(ctx.sampleRate * 0.05);
    for (let i = 0; i < fade; i++) {
      const k = i / fade;
      d[i] *= k;
      d[n - 1 - i] *= k;
    }
  }
  return buf;
}

// Редкие короткие щелчки: капли дождя или треск поленьев.
function clicksBuffer(ctx, perSec, lenMs, secs = 8) {
  const n = ctx.sampleRate * secs;
  const buf = ctx.createBuffer(2, n, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    const count = Math.round(perSec * secs);
    for (let c = 0; c < count; c++) {
      const at = Math.floor(Math.random() * (n - ctx.sampleRate * 0.05));
      const len = Math.floor(ctx.sampleRate * (lenMs / 1000) * (0.4 + Math.random()));
      const amp = 0.15 + Math.random() * 0.6;
      for (let i = 0; i < len; i++) d[at + i] += (Math.random() * 2 - 1) * amp * Math.pow(1 - i / len, 3);
    }
  }
  return buf;
}

function startAmbient(kind) {
  stopAmbient();
  const ctx = new AudioContext();
  const master = ctx.createGain();
  master.gain.value = ambientGain(PL.s.musicVolume);
  master.connect(ctx.destination);
  const nodes = [];
  const loop = (buf) => {
    const s = ctx.createBufferSource();
    s.buffer = buf;
    s.loop = true;
    s.start();
    nodes.push(s);
    return s;
  };
  const filter = (type, f, q) => {
    const x = ctx.createBiquadFilter();
    x.type = type;
    x.frequency.value = f;
    if (q) x.Q.value = q;
    return x;
  };
  const lfo = (param, freq, depth) => {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.value = freq;
    g.gain.value = depth;
    o.connect(g).connect(param);
    o.start();
    nodes.push(o);
  };
  const gain = (v) => {
    const g = ctx.createGain();
    g.gain.value = v;
    return g;
  };
  if (kind === 'rain') {
    loop(noiseBuffer(ctx, 'pink')).connect(filter('highpass', 500)).connect(filter('lowpass', 7000)).connect(gain(0.9)).connect(master);
    loop(clicksBuffer(ctx, 60, 6)).connect(filter('bandpass', 2600, 0.8)).connect(gain(0.5)).connect(master);
  } else if (kind === 'wind') {
    const bp = filter('bandpass', 500, 0.9);
    lfo(bp.frequency, 0.07, 280);
    const g = gain(0.9);
    lfo(g.gain, 0.05, 0.35);
    loop(noiseBuffer(ctx, 'brown')).connect(bp).connect(g).connect(master);
  } else if (kind === 'ocean') {
    const g = gain(0.6);
    lfo(g.gain, 0.09, 0.45); // накат и отход волн
    loop(noiseBuffer(ctx, 'brown')).connect(filter('lowpass', 700)).connect(g).connect(master);
    loop(noiseBuffer(ctx, 'pink')).connect(filter('highpass', 1800)).connect(gain(0.12)).connect(master);
  } else if (kind === 'fire') {
    loop(noiseBuffer(ctx, 'brown')).connect(filter('lowpass', 380)).connect(gain(0.8)).connect(master);
    loop(clicksBuffer(ctx, 9, 3)).connect(filter('highpass', 1500)).connect(gain(0.7)).connect(master);
  } else {
    loop(noiseBuffer(ctx, kind === 'brown' ? 'brown' : 'pink')).connect(gain(0.8)).connect(master);
  }
  PL.amb = { ctx, master, nodes };
}

function stopAmbient() {
  if (!PL.amb) return;
  const { ctx } = PL.amb;
  PL.amb = null;
  ctx.close().catch(() => {});
}

// ---------- вид ----------

const PL_ICONS = {
  play: '<svg viewBox="0 0 24 24"><path d="M8 5.5v13l10.5-6.5z"/></svg>',
  pause: '<svg viewBox="0 0 24 24"><path d="M8 5.5v13M16 5.5v13"/></svg>',
  next: '<svg viewBox="0 0 24 24"><path d="M6 5.5v13l9-6.5zM18 5.5v13"/></svg>',
};

function drawPlayer() {
  const play = $('pl-play');
  play.innerHTML = PL.playing ? PL_ICONS.pause : PL_ICONS.play;
  play.title = PL.playing ? 'Пауза' : 'Играть';
  $('pl-next').innerHTML = PL_ICONS.next;
  $('pl-next').title = PL.source === 'ambient' ? 'Другой звук' : PL.source === 'radio' ? 'Следующая станция' : 'Следующий трек';
  const label = SOURCES.find(([v]) => v === PL.source)[1];
  $('pl-name').textContent = PL.cur ? PL.cur.title : label;
  $('pl-name').title = (PL.cur ? PL.cur.title + ' · ' : '') + label + '. Нажмите, чтобы выбрать источник.';
  $('player').classList.toggle('is-playing', PL.playing);
  if (!$('player-pop').hidden) drawPlayerPanel();
}

function togglePlayerPanel() {
  const pop = $('player-pop');
  if (pop.hidden) openPlayerPanel();
  else pop.hidden = true;
}

async function openPlayerPanel() {
  const pop = $('player-pop');
  pop.hidden = false;
  const r = $('player').getBoundingClientRect();
  pop.style.left = Math.max(8, Math.min(window.innerWidth - 432, r.left)) + 'px';
  if (PL.source !== 'ambient' && !PL.tracks.length) {
    try {
      await loadTracks();
    } catch (err) {
      PL.info = errText(err.code);
    }
  }
  drawPlayerPanel();
}

function drawPlayerPanel() {
  const pop = $('player-pop');
  pop.innerHTML = '';
  pop.classList.toggle('is-wide', PL.source === 'radio' && PL.radioTab === 'find');
  const vol = h('input', { type: 'range', min: '0', max: '1', step: '0.05', value: String(PL.s.musicVolume) });
  vol.addEventListener('input', () => onMusicSettings({ ...PL.s, musicVolume: Number(vol.value) }));
  vol.addEventListener('change', async () => { PL.s = await call(studio.settings.set({ musicVolume: Number(vol.value) })); });
  pop.append(
    h('div', { class: 'seg seg-inline pl-sources' }, ...SOURCES.map(([v, t]) => h('button', { class: 'seg-btn' + (PL.source === v ? ' is-on' : ''), type: 'button', text: t, onclick: () => setSource(v) }))),
  );
  const body = h('div', { class: 'pl-body' });
  if (PL.source === 'studio') {
    body.append(
      h('p', { class: 'muted small', text: 'Треки студии с GitHub, вперемешку. Скачанные играют и без интернета.' }),
      PL.info ? h('p', { class: 'small', text: PL.info }) : null,
      h('button', { class: 'btn btn-s', type: 'button', text: 'Обновить список', onclick: async () => {
        try {
          const r = await call(studio.music.studio(true));
          PL.tracks = r.tracks;
          PL.bag = [];
          PL.info = 'Треков: ' + r.tracks.length + ', скачано: ' + r.tracks.filter((t) => t.cached).length;
        } catch (err) {
          PL.info = errText(err.code);
        }
        drawPlayerPanel();
      } }),
    );
  } else if (PL.source === 'folder') {
    body.append(
      h('p', { class: 'muted small', text: 'Файлы mp3, ogg, m4a, wav, flac из папки и её подпапок, вперемешку.' }),
      PL.info ? h('p', { class: 'small pl-path', text: PL.info }) : null,
      h('button', { class: 'btn btn-s', type: 'button', text: 'Выбрать папку', onclick: async () => {
        try {
          const r = await call(studio.music.pickFolder());
          if (!r) return;
          PL.s = await call(studio.settings.get());
          PL.cur = null;
          await loadTracks();
          if (PL.playing) nextTrack(true);
          drawPlayer();
          drawPlayerPanel();
        } catch (err) {
          toast(errText(err.code));
        }
      } }),
    );
  } else if (PL.source === 'radio') {
    if (!PL.radioTab) PL.radioTab = PL.s.musicRadios.length ? 'mine' : 'find';
    body.append(h('div', { class: 'seg seg-inline pl-rtabs' },
      ...[['mine', 'Мои станции'], ['find', 'Найти']].map(([v, t]) => h('button', { class: 'seg-btn' + (PL.radioTab === v ? ' is-on' : ''), type: 'button', text: t, onclick: () => {
        PL.radioTab = v;
        drawPlayerPanel();
      } }))));
    if (PL.radioTab === 'find') drawRadioFind(body);
    else drawRadioMine(body);
  } else {
    body.append(
      h('p', { class: 'muted small', text: 'Синтезируются на ходу, не повторяются.' }),
      h('div', { class: 'pl-ambients' }, ...AMBIENTS.map(([v, t]) => h('button', {
        class: 'chip-btn' + (PL.s.musicAmbient === v ? ' is-on' : ''), type: 'button', text: t,
        onclick: async () => {
          PL.s = await call(studio.settings.set({ musicAmbient: v }));
          await playMusic();
        },
      }))),
    );
  }
  pop.append(body, h('div', { class: 'pl-vol' }, h('span', { class: 'muted small', text: 'Громкость' }), vol));
}

// ---------- радио: свои станции и каталог ----------

function playRadio(t) {
  PL.cur = t;
  PL.playing = true;
  PL.audio.src = srcFor(t);
  PL.audio.play().catch(() => {});
  if (navigator.mediaSession) navigator.mediaSession.metadata = new MediaMetadata({ title: t.title, artist: 'Радио' });
  drawPlayer();
}

function drawRadioMine(body) {
  const list = h('div', { class: 'pl-radios' });
  PL.s.musicRadios.forEach((st, i) => {
    list.append(h('div', { class: 'pl-radio' + (PL.cur && PL.cur.id === String(i) ? ' is-on' : '') },
      h('button', { class: 'pl-radio-name', type: 'button', text: st.name, title: st.uuid ? 'Из каталога radio-browser.info' : st.url, onclick: () => {
        playRadio({ id: String(i), title: st.name });
        studio.settings.set({ musicRadio: i });
        drawPlayerPanel();
      } }),
      h('button', { class: 'btn btn-s btn-danger-ghost', type: 'button', text: 'Убрать', onclick: async () => {
        const radios = PL.s.musicRadios.filter((_, j) => j !== i);
        PL.s = await call(studio.settings.set({ musicRadios: radios }));
        if (PL.cur && PL.cur.id === String(i)) stopMusic();
        PL.cur = null;
        await loadTracks();
        drawPlayer();
        drawPlayerPanel();
      } }),
    ));
  });
  const name = h('input', { maxlength: '60', placeholder: 'Название' });
  const url = h('input', { maxlength: '500', placeholder: 'https://... ссылка на поток, .m3u или .pls' });
  body.append(
    list,
    PL.info ? h('p', { class: 'muted small', text: PL.info }) : null,
    h('details', { class: 'pl-own' }, h('summary', { class: 'small', text: 'Добавить по ссылке' }),
      h('div', { class: 'pl-add' }, name, url, h('button', { class: 'btn btn-s', type: 'button', text: 'Добавить', onclick: async () => {
        if (!/^https?:\/\//i.test(url.value.trim())) {
          toast('Нужна ссылка на поток, начинается с http:// или https://');
          return;
        }
        PL.s = await call(studio.settings.set({ musicRadios: [...PL.s.musicRadios, { name: name.value.trim(), url: url.value.trim() }] }));
        await loadTracks();
        drawPlayerPanel();
      } }))),
  );
}

async function radioSearch(more) {
  if (PL.rbusy) return;
  PL.rbusy = true;
  if (!more) PL.rres = null;
  drawPlayerPanel();
  try {
    const r = await call(studio.music.radioSearch({ q: PL.rq, preset: PL.rpreset, offset: more && PL.rres ? PL.rres.length : 0 }));
    PL.rres = more && PL.rres ? PL.rres.concat(r.stations.filter((x) => !PL.rres.some((y) => y.uuid === x.uuid))) : r.stations;
    PL.rmore = r.more;
  } catch (err) {
    PL.rres = PL.rres || [];
    PL.rmore = false;
    toast(errText(err.code));
  }
  PL.rbusy = false;
  if (!$('player-pop').hidden) drawPlayerPanel();
}

function drawRadioFind(body) {
  const q = h('input', { type: 'search', maxlength: '60', placeholder: 'Название станции', value: PL.rq });
  const go = () => {
    PL.rq = q.value.trim();
    radioSearch(false);
  };
  q.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') go();
  });
  const saved = new Set(PL.s.musicRadios.map((r) => r.uuid).filter(Boolean));
  const list = h('div', { class: 'pl-found' });
  for (const st of PL.rres || []) {
    const meta = [st.country, ...st.tags, st.codec && (st.codec + (st.bitrate ? ' ' + st.bitrate : ''))].filter(Boolean).join(', ');
    const on = PL.cur && PL.cur.id === 's-' + st.uuid;
    list.append(h('div', { class: 'pl-st' + (on ? ' is-on' : '') },
      h('button', { class: 'pl-st-main', type: 'button', title: 'Слушать', onclick: () => {
        playRadio({ id: 's-' + st.uuid, title: st.name, preview: true });
        drawPlayerPanel();
      } }, h('b', { text: st.name }), h('span', { class: 'muted small', text: meta })),
      saved.has(st.uuid)
        ? h('span', { class: 'muted small pl-st-ok', text: 'в моих' })
        : h('button', { class: 'btn btn-s', type: 'button', text: 'В мои', title: 'Сохранить в "Мои станции"', onclick: async () => {
          try {
            PL.s = await call(studio.music.radioAdd(st.uuid));
            await loadTracks();
            drawPlayerPanel();
          } catch (err) {
            toast(errText(err.code));
          }
        } }),
    ));
  }
  body.append(
    h('div', { class: 'pl-rsearch' }, q, h('button', { class: 'btn btn-s', type: 'button', text: 'Найти', onclick: go })),
    h('div', { class: 'pl-presets' }, ...RADIO_PRESETS.map(([v, t]) => h('button', {
      class: 'chip-btn' + (!PL.rq && PL.rpreset === v ? ' is-on' : ''), type: 'button', text: t,
      onclick: () => {
        PL.rq = '';
        PL.rpreset = v;
        radioSearch(false);
      },
    }))),
    PL.rbusy && !PL.rres ? h('p', { class: 'muted small', text: 'Ищу станции...' }) : null,
    PL.rres && !PL.rres.length && !PL.rbusy ? h('p', { class: 'muted small', text: 'Ничего не нашлось. Попробуйте другое название или подборку.' }) : null,
    PL.rres && PL.rres.length ? list : null,
    PL.rmore ? h('button', { class: 'btn btn-s', type: 'button', text: PL.rbusy ? 'Загружаю...' : 'Ещё станции', onclick: () => radioSearch(true) }) : null,
    h('p', { class: 'muted small', text: 'Каталог radio-browser.info: станции добавляют сами слушатели, некоторые могут не отвечать.' }),
  );
  if (!PL.rres && !PL.rbusy) {
    PL.rbusy = true; // первая подборка: один запрос, даже если панель перерисуется
    setTimeout(() => {
      PL.rbusy = false;
      radioSearch(false);
    }, 0);
  }
}
