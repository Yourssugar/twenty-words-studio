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
};

const SOURCES = [['studio', 'Студия'], ['folder', 'Моя папка'], ['radio', 'Радио'], ['ambient', 'Фоновые звуки']];
const AMBIENTS = [['rain', 'Дождь'], ['wind', 'Ветер'], ['ocean', 'Море'], ['fire', 'Камин'], ['pink', 'Мягкий шум'], ['brown', 'Глубокий шум']];

Object.assign(ERRORS, {
  music_none: 'В репозитории студии пока нет папки с музыкой.',
  music_offline: 'Список студийных треков не загрузился: нет связи с GitHub.',
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
  if (PL.source === 'studio') {
    const r = await call(studio.music.studio(false));
    PL.tracks = r.tracks;
    PL.info = r.tracks.length ? 'Треков: ' + r.tracks.length + ', скачано: ' + r.tracks.filter((t) => t.cached).length : 'Треков пока нет.';
  } else if (PL.source === 'folder') {
    const r = await call(studio.music.folder());
    PL.tracks = r.tracks;
    PL.info = r.folder ? r.folder + ', треков: ' + r.tracks.length : 'Папка не выбрана.';
  } else if (PL.source === 'radio') {
    PL.tracks = PL.s.musicRadios.map((r, i) => ({ id: String(i), title: r.name }));
    PL.info = PL.tracks.length ? '' : 'Станций нет: добавьте ссылку на поток.';
  }
}

function srcFor(t) {
  return 'twmusic://' + PL.source + '/' + encodeURIComponent(t.id);
}

async function playMusic() {
  PL.webPaused = false;
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
  pop.style.left = Math.max(8, Math.min(window.innerWidth - 340, r.left)) + 'px';
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
    const list = h('div', { class: 'pl-radios' });
    PL.s.musicRadios.forEach((st, i) => {
      list.append(h('div', { class: 'pl-radio' + (PL.cur && PL.cur.id === String(i) ? ' is-on' : '') },
        h('button', { class: 'pl-radio-name', type: 'button', text: st.name, title: st.url, onclick: async () => {
          PL.cur = { id: String(i), title: st.name };
          PL.playing = true;
          PL.audio.src = srcFor(PL.cur);
          PL.audio.play().catch(() => {});
          studio.settings.set({ musicRadio: i });
          drawPlayer();
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
      h('div', { class: 'pl-add' }, name, url, h('button', { class: 'btn btn-s', type: 'button', text: 'Добавить', onclick: async () => {
        if (!/^https?:\/\//i.test(url.value.trim())) {
          toast('Нужна ссылка на поток, начинается с http:// или https://');
          return;
        }
        PL.s = await call(studio.settings.set({ musicRadios: [...PL.s.musicRadios, { name: name.value.trim(), url: url.value.trim() }] }));
        await loadTracks();
        drawPlayerPanel();
      } })),
    );
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
