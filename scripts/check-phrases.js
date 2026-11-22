'use strict';
// Проверка реплик Юны после правки src/renderer/core-phrases.js:
//   node scripts/check-phrases.js
// Ищет запрещённые символы, неверный регистр, чужие подстановки, дубли, слишком длинные фразы,
// число перед склоняемым словом и картинки настроений, которых нет в src/assets/yuna.

const fs = require('fs');
const vm = require('vm');
const path = require('path');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'src/renderer/core-phrases.js'), 'utf8');
const { CORE_PHRASES: P, CORE_JOINS: J, CORE_MOODS: M } = vm.runInNewContext(source + ';({CORE_PHRASES,CORE_JOINS,CORE_MOODS})', {}, { timeout: 1000 });

const TOPICS = ['meet_done', 'meet_boss', 'back_short', 'back_day', 'back_long', 'back_very_long', 'unread_dm', 'unread_rooms',
  'ticket_decision', 'ticket_reply', 'report_due', 'feed_news', 'never_visited', 'favorite', 'streak', 'long_session', 'night',
  'early', 'weekend', 'monday', 'friday', 'focus_stats', 'focus_never', 'model_love', 'tokens_big', 'music_none', 'music_src',
  'milestone', 'month_in', 'joke', 'tip'];
const LOWER = TOPICS.slice(TOPICS.indexOf('never_visited'));
const ALLOWED = {
  days: ['back_long', 'back_very_long'],
  n: ['unread_dm', 'unread_rooms', 'feed_news', 'streak', 'focus_stats', 'milestone'],
  room: ['unread_rooms'], id: ['ticket_decision', 'ticket_reply'], verdict: ['ticket_decision'],
  sec: ['never_visited', 'favorite'], time: ['favorite', 'long_session'], h: ['night', 'focus_stats'],
  min: ['focus_stats'], model: ['model_love'], tokens: ['tokens_big'], src: ['music_src'],
};
const MOODS = ['neutral', 'hello', 'smile', 'laugh', 'wink', 'surprised', 'thinking', 'proud', 'concerned', 'sleepy', 'curious'];
const BAD = /[\u2014\u2013\u00ab\u00bb\u2026\u2192\u00a0]|\p{Extended_Pictographic}/u;

const errors = [];
const seen = new Set();
let total = 0;
for (const k of Object.keys(P)) if (!TOPICS.includes(k)) errors.push('лишняя тема: ' + k);
for (const k of TOPICS) {
  const list = P[k];
  if (!Array.isArray(list) || list.length < 2) {
    errors.push('мало фраз или нет темы: ' + k);
    continue;
  }
  total += list.length;
  if (!k.startsWith('meet') && list.filter((s) => !s.includes('{name}')).length * 2 < list.length) errors.push('мало фраз без {name}: ' + k);
  for (const s of list) {
    const fail = (why) => errors.push(`${k}: ${why}: ${s}`);
    if (typeof s !== 'string' || !s.trim() || s.trim() !== s) fail('пустая или с пробелами по краям');
    if (s.length > 170) fail('длиннее 170');
    if (BAD.test(s)) fail('символ не с клавиатуры');
    if (LOWER.includes(k) && /^["(]?[А-ЯЁA-Z]/.test(s) && !/^[А-ЯЁA-Z]{2}/.test(s)) fail('должна начинаться со строчной');
    if (!LOWER.includes(k) && /^["(]?[а-яё]/.test(s)) fail('должна начинаться с заглавной');
    if (/\{(n|min|h)\}\s+(дн|час|минут|сообщ|сесси|заход|раз|непрочит|нов)/.test(s)) fail('число перед склоняемым словом');
    if (seen.has(s)) fail('повтор');
    seen.add(s);
    for (const t of s.match(/\{[^{}]*\}/g) || []) {
      const name = t.slice(1, -1);
      if (name === 'name' || /^g:[^|{}]+\|[^|{}]+$/.test(name)) continue;
      if (!(ALLOWED[name] || []).includes(k)) fail('подстановка ' + t + ' здесь не приходит');
    }
  }
}
if (!Array.isArray(J) || !J.length) errors.push('нет связок CORE_JOINS');
for (const [k, v] of Object.entries(M || {})) {
  for (const m of [].concat(v)) {
    if (!MOODS.includes(m)) errors.push(`настроение ${m} у темы ${k} неизвестно`);
  }
}
for (const look of ['a', 'b', 'c']) {
  for (const m of MOODS) {
    if (!fs.existsSync(path.join(root, 'src/assets/yuna', look, m + '.webp'))) errors.push(`нет картинки ${look}/${m}.webp`);
  }
}
for (const e of errors) console.log(e);
console.log(`фраз: ${total}, тем: ${TOPICS.length}, ошибок: ${errors.length}`);
process.exit(errors.length ? 1 : 0);
