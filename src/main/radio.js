'use strict';
// Каталог интернет-радио radio-browser.info: открытая база станций, без ключей и регистрации.
// Ходит в сеть только главный процесс. Интерфейс получает названия и метки, а ссылку на поток
// найденной станции знает только этот модуль: twmusic://radio/s-<uuid> играет лишь то,
// что было в последних результатах поиска.
//
// Сервер каталога выбирается по DNS (_api._tcp.radio-browser.info), если не вышло, из списка
// известных зеркал. Клики по станциям отправляются в каталог, как просят его правила:
// так считаются популярные станции.

const { app, net } = require('electron');
const dns = require('dns').promises;

const FALLBACK = ['de1.api.radio-browser.info', 'de2.api.radio-browser.info', 'nl1.api.radio-browser.info', 'at1.api.radio-browser.info'];
const HOST = /^[a-z0-9-]+\.api\.radio-browser\.info$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CODECS = /^(mp3|aac|aac\+|he-aac|ogg|opus|flac)$/i;
const PAGE = 40;
const FOUND_MAX = 600;

// Подборки на кнопках в панели плеера.
const PRESETS = {
  top: {},
  pl: { countrycode: 'PL' },
  ru: { language: 'russian' },
  lofi: { tag: 'lofi' },
  chill: { tag: 'chillout' },
  ambient: { tag: 'ambient' },
  jazz: { tag: 'jazz' },
  classic: { tag: 'classical' },
  electro: { tag: 'electronic' },
  rock: { tag: 'rock' },
};

const err = (code) => Object.assign(new Error(code), { code });
const shuffle = (a) => {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

class RadioCatalog {
  constructor() {
    // Только для проверки без сети: свой адрес каталога в несобранном приложении.
    this.base = !app.isPackaged && /^http:\/\/127\.0\.0\.1:\d+$/.test(process.env.TW_RADIO_API || '') ? process.env.TW_RADIO_API : null;
    this.hosts = null;
    this.found = new Map(); // uuid -> { url, name }
    this.clicked = new Map(); // uuid -> время последнего клика
  }

  async servers() {
    if (this.base) return [this.base];
    if (!this.hosts) {
      let names = [];
      try {
        names = (await dns.resolveSrv('_api._tcp.radio-browser.info')).map((r) => r.name.toLowerCase()).filter((n) => HOST.test(n));
      } catch {
        /* нет DNS: берём известные зеркала */
      }
      this.hosts = shuffle(names.length ? [...new Set(names)] : FALLBACK.slice());
    }
    return this.hosts.map((h) => 'https://' + h);
  }

  async get(pathAndQuery) {
    const ua = 'TwentyWordsStudio/' + app.getVersion();
    for (const base of await this.servers()) {
      try {
        const r = await net.fetch(base + pathAndQuery, { headers: { 'User-Agent': ua }, signal: AbortSignal.timeout(8000) });
        if (r.ok) return await r.json();
      } catch {
        /* следующее зеркало */
      }
    }
    throw err('radio_catalog');
  }

  // { q, preset, offset } -> { stations: [{ uuid, name, country, tags, codec, bitrate }], more }
  async search(a) {
    const q = typeof a.q === 'string' ? a.q.trim().slice(0, 60) : '';
    const preset = PRESETS[a.preset] ? a.preset : 'top';
    const offset = Number.isInteger(a.offset) && a.offset >= 0 && a.offset <= 2000 ? a.offset : 0;
    const p = new URLSearchParams({ hidebroken: 'true', order: 'clickcount', reverse: 'true', limit: String(PAGE), offset: String(offset) });
    if (q) p.set('name', q);
    else for (const [k, v] of Object.entries(PRESETS[preset])) p.set(k, v);
    const list = await this.get('/json/stations/search?' + p.toString());
    if (!Array.isArray(list)) throw err('radio_catalog');
    const seen = new Set();
    const stations = [];
    for (const s of list) {
      const url = String(s.url_resolved || s.url || '');
      const uuid = String(s.stationuuid || '');
      const name = String(s.name || '').replace(/\s+/g, ' ').trim().slice(0, 60);
      if (!UUID.test(uuid) || !name || !/^https?:\/\//i.test(url) || url.length > 500) continue;
      if (Number(s.hls) === 1 || /\.m3u8(\?|$)/i.test(url)) continue; // HLS обычный плеер не играет
      if (s.codec && !CODECS.test(String(s.codec))) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      this.remember(uuid, url, name);
      stations.push({
        uuid,
        name,
        country: String(s.countrycode || '').slice(0, 2).toUpperCase(),
        tags: String(s.tags || '').split(',').map((t) => t.trim()).filter((t) => t && t.length <= 20).slice(0, 3),
        codec: String(s.codec || '').slice(0, 10).toUpperCase(),
        bitrate: Number(s.bitrate) > 0 && Number(s.bitrate) < 10000 ? Math.round(Number(s.bitrate)) : 0,
      });
    }
    return { stations, more: list.length === PAGE };
  }

  remember(uuid, url, name) {
    this.found.delete(uuid);
    this.found.set(uuid, { url, name });
    while (this.found.size > FOUND_MAX) this.found.delete(this.found.keys().next().value);
  }

  // Найденная станция: ссылка на поток для плеера и для сохранения в "Мои станции".
  station(uuid) {
    return UUID.test(uuid) ? this.found.get(uuid) || null : null;
  }

  // Каталог просит отмечать прослушивание: не чаще раза в час на станцию.
  click(uuid) {
    if (!UUID.test(uuid || '')) return;
    const now = Date.now();
    if (now - (this.clicked.get(uuid) || 0) < 3600e3) return;
    this.clicked.set(uuid, now);
    this.get('/json/url/' + uuid).catch(() => {});
  }
}

module.exports = { RadioCatalog, PRESETS };
