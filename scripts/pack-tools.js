#!/usr/bin/env node
// Упаковка инструментов кузницы с сайта для кнопки "Скачать" в приложении.
//
//   node scripts/pack-tools.js <папка forge сайта> [--upload]
//   пример: node scripts/pack-tools.js "C:\Users\Adronix\A.C.EON.git\forge" --upload
//
// Что делает:
// 1. Собирает пакеты dist-tools/forge-<id>-<версия>.tar.gz из файлов сайта.
// 2. Сравнивает с прошлой упаковкой (data/tools.json): инструмент, у которого ни один файл
//    не поменялся, остаётся со старой версией и старым адресом. Команде не придётся
//    заново качать то, что не менялось, и "Обновить" появится только у изменённых.
// 3. Записывает data/tools.json: размеры, sha256 и адреса релизов. Этот файл входит
//    в приложение, по нему проверяется каждый скачанный пакет.
// 4. С --upload создаёт релиз tools-<версия> на GitHub и загружает туда только изменённые
//    пакеты (нужен GitHub CLI: gh auth login). Токены в файлах не хранятся.
//
// После этого закоммитьте data/tools.json и выпустите новую версию приложения.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const { owner, repo } = pkg.build.publish[0];

// Общие файлы, на которые ссылаются почти все инструменты.
const COMMON = ['HTML-CSS-JS/engine.js', 'HTML-CSS-JS/editor.css', 'i18n-forge.js'];

const PACKAGES = [
  { id: 'grafika', name: 'Графика', desc: 'Обложки, превью для YouTube, сторис, открытки и QR-коды нужного размера. Внутри нейросеть для удаления фона, работает без интернета.', entry: 'grafika/', paths: ['grafika', 'fony/fony-engine.js', ...COMMON] },
  { id: 'zvuk', name: 'Звук', desc: 'Обрезать песню, сделать рингтон, записать голос, мастеринг с пресетами.', entry: 'zvuk/', paths: ['zvuk', ...COMMON] },
  { id: 'montazh', name: 'Монтаж', desc: 'Короткий ролик из фото и видео: переходы, надписи, музыка, видео файлом.', entry: 'montazh/', paths: ['montazh', 'fony/fony-engine.js', ...COMMON] },
  { id: 'pages', name: 'Страницы', desc: 'Визитка, приглашение, меню, все ссылки в одном месте. Скачивается файлом.', entry: 'HTML-CSS-JS/', paths: ['HTML-CSS-JS', 'p', 'img', 'i18n-forge.js'] },
  { id: 'fony', name: 'Фоны', desc: 'Аврора, волны, топография, конфетти. Картинкой, SVG или кодом CSS, в том числе плиткой для сайта.', entry: 'fony/', paths: ['fony', ...COMMON] },
];

// Эти файлы на сайте лежат, но приложению не нужны.
const SKIP = [/(^|\/)placeholder\.txt$/, /^grafika\/ai\/u2netp\.onnx$/, /(^|\/)\.DS_Store$/, /(^|\/)Thumbs\.db$/];

function walk(base, rel, out) {
  const abs = path.join(base, rel);
  const st = fs.statSync(abs);
  if (st.isFile()) {
    if (!SKIP.some((re) => re.test(rel))) out.push(rel);
    return;
  }
  for (const name of fs.readdirSync(abs).sort()) walk(base, rel ? rel + '/' + name : name, out);
}

// ---------- tar (ustar) ----------

function header(name, size) {
  const h = Buffer.alloc(512, 0);
  let prefix = '';
  let base = name;
  if (Buffer.byteLength(name) > 100) {
    const i = name.lastIndexOf('/', 154);
    prefix = name.slice(0, i);
    base = name.slice(i + 1);
    if (Buffer.byteLength(base) > 100 || Buffer.byteLength(prefix) > 155) throw new Error('слишком длинный путь: ' + name);
  }
  const put = (s, off, len) => h.write(s, off, len, 'utf8');
  put(base, 0, 100);
  put('0000644\0', 100, 8);
  put('0000000\0', 108, 8);
  put('0000000\0', 116, 8);
  put(size.toString(8).padStart(11, '0') + '\0', 124, 12);
  put('00000000000\0', 136, 12);
  put('        ', 148, 8);
  h[156] = 48; // '0': обычный файл
  put('ustar\0', 257, 6);
  put('00', 263, 2);
  put(prefix, 345, 155);
  let sum = 0;
  for (const b of h) sum += b;
  put(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return h;
}

function tarGz(base, files) {
  const parts = [];
  for (const rel of files) {
    const body = fs.readFileSync(path.join(base, rel));
    parts.push(header(rel, body.length), body);
    const pad = (512 - (body.length % 512)) % 512;
    if (pad) parts.push(Buffer.alloc(pad, 0));
  }
  parts.push(Buffer.alloc(1024, 0));
  return zlib.gzipSync(Buffer.concat(parts), { level: 9 });
}

// ---------- запуск ----------

const args = process.argv.slice(2);
const src = args.find((a) => !a.startsWith('--'));
const upload = args.includes('--upload');
if (!src || !fs.existsSync(path.join(src, 'grafika'))) {
  console.error('Укажите папку forge из репозитория сайта, например:\n  node scripts/pack-tools.js "C:\\Users\\Adronix\\A.C.EON.git\\forge"');
  process.exit(1);
}

const d = new Date();
const two = (n) => String(n).padStart(2, '0');
// Дата и время: можно упаковывать несколько раз за день, у каждого релиза свой тег.
const version = `${d.getFullYear()}.${d.getMonth() + 1}.${d.getDate()}-${two(d.getHours())}${two(d.getMinutes())}`;
const tag = `tools-${version}`;
const base = `https://github.com/${owner}/${repo}/releases/download/${tag}`;
const outDir = path.join(ROOT, 'dist-tools');
fs.mkdirSync(outDir, { recursive: true });

let prev = { base: '', tools: [] };
try {
  prev = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'tools.json'), 'utf8'));
} catch {
  /* первая упаковка */
}

const manifest = { base, tools: [] };
const changed = [];

for (const p of PACKAGES) {
  const files = [];
  for (const rel of p.paths) {
    if (!fs.existsSync(path.join(src, rel))) throw new Error(`нет ${rel} в ${src}`);
    walk(src, rel, files);
  }
  const unique = [...new Set(files)];
  const gz = tarGz(src, unique);
  const sha256 = crypto.createHash('sha256').update(gz).digest('hex');
  const old = prev.tools.find((t) => t.id === p.id);
  if (old && old.sha256 === sha256 && JSON.stringify(old.paths) === JSON.stringify(p.paths)) {
    // Не поменялся: тот же пакет, тот же адрес, у команды без обновления.
    manifest.tools.push({ ...old, name: p.name, desc: p.desc, entry: p.entry, base: old.base || prev.base });
    console.log(`${p.name.padEnd(9)} без изменений, остаётся ${old.version}`);
    continue;
  }
  const file = `forge-${p.id}-${version}.tar.gz`;
  fs.writeFileSync(path.join(outDir, file), gz);
  manifest.tools.push({ id: p.id, name: p.name, desc: p.desc, entry: p.entry, paths: p.paths, version, file, size: gz.length, sha256, base });
  changed.push(path.join(outDir, file));
  console.log(`${p.name.padEnd(9)} ${String(unique.length).padStart(3)} файлов  ${(gz.length / 1048576).toFixed(1).padStart(5)} МБ  ${file}  ИЗМЕНЁН`);
}

if (!changed.length) {
  console.log('\nНи один инструмент не поменялся, обновлять нечего. Сайт точно обновлён (Pull в GitHub Desktop)?');
  process.exit(0);
}

fs.writeFileSync(path.join(ROOT, 'data', 'tools.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log('\ndata/tools.json обновлён.');

if (upload) {
  console.log(`\nСоздаю релиз ${tag} в ${owner}/${repo} и загружаю изменённые пакеты...`);
  execFileSync('gh', ['release', 'create', tag, ...changed, '--repo', `${owner}/${repo}`, '--title', `Инструменты ${version}`, '--notes', 'Пакеты инструментов кузницы для Twenty Words Studio. Скачиваются из приложения, вручную ставить не нужно.', '--latest=false'], { stdio: 'inherit' });
  console.log('\nГотово. Закоммитьте data/tools.json и выпустите новую версию приложения (npm run release).');
} else {
  console.log('Пакеты в dist-tools. Чтобы выложить: добавьте --upload.');
  console.log('Внимание: data/tools.json уже указывает на релиз ' + tag + '. Без --upload приложение не сможет скачать изменённые пакеты.');
}
