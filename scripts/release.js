#!/usr/bin/env node
// Выпуск новой версии одной командой: npm run release
//
// Что делает по порядку:
// 1. Проверяет вход в GitHub CLI и адрес сервера в data/config.json.
// 2. Если в папке есть изменения, сохраняет их в git (commit) и отправляет на GitHub (push).
// 3. Создаёт релиз v<версия из package.json>, собирает установщик и загружает его.
//
// Версию в package.json поднимает тот, кто прислал обновление. Если такая версия уже
// выпущена, скрипт остановится и попросит поднять номер.
//
// Токен GitHub берётся из GitHub CLI (gh auth login делается один раз) и живёт только
// в памяти на время сборки. Файлов с токеном в папке нет.
// Установленные приложения сами скачают обновление и предложат перезапуск.

const fs = require('fs');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const { owner, repo } = pkg.build.publish[0];
const version = pkg.version;
const tag = `v${version}`;
const full = `${owner}/${repo}`;

function gh(args, opts = {}) {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
}

let token;
try {
  token = gh(['auth', 'token']);
} catch {
  console.error('Нет входа в GitHub CLI. Выполните один раз: gh auth login');
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'config.json'), 'utf8'));
if (!/^https:\/\//.test(config.serverUrl || '')) {
  console.error('В data/config.json должен быть адрес сервера с https://, иначе приложение у команды не подключится.');
  process.exit(1);
}

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

// Уже выпущенную версию не перезаписываем: у людей она уже стоит.
let existing = null;
try {
  existing = JSON.parse(gh(['release', 'view', tag, '--repo', full, '--json', 'assets']));
} catch {
  /* релиза ещё нет */
}
if (existing && existing.assets && existing.assets.some((a) => a.name.endsWith('.exe'))) {
  console.error(`Версия ${version} уже выпущена. Поднимите "version" в package.json (например, ${version.replace(/(\d+)$/, (n) => Number(n) + 1)}) и запустите снова.`);
  process.exit(1);
}

// Репозиторий публичный. Перед сохранением: файлы, которые попали в git раньше, а теперь
// исключены в .gitignore (например, памятка), убираем из репозитория (на диске они остаются).
// И проверяем, что в выпуск не уходит ничего похожего на ключи и пароли.
function guardPublic() {
  const tracked = git(['ls-files', '-ci', '--exclude-standard', '-z']).split('\0').filter(Boolean);
  for (const f of tracked) {
    git(['rm', '--cached', '-q', '--', f]);
    console.log('Убрано из репозитория (осталось на диске): ' + f);
  }
  git(['add', '-A']);
  const files = git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']).split('\0').filter(Boolean);
  const bad = /\.(md|txt|env|pem|key)$/i;
  const allowed = new Set(['README.md']);
  const secret = /(sk-[A-Za-z0-9_-]{20,}|AGE-SECRET-KEY-1[0-9A-Z]{20,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/;
  const problems = [];
  for (const f of files) {
    const full = path.join(ROOT, f);
    if (!fs.existsSync(full)) continue;
    if (bad.test(f) && !allowed.has(f)) problems.push(f + ': такие файлы в публичный репозиторий не кладём');
    else if (fs.statSync(full).size < 2_000_000 && secret.test(fs.readFileSync(full, 'latin1'))) problems.push(f + ': похоже на ключ или пароль');
  }
  if (problems.length) {
    git(['reset', '-q']);
    console.error('Выпуск остановлен, в репозиторий ушло бы лишнее:\n  ' + problems.join('\n  ') + '\nУберите файл из папки или добавьте его в .gitignore и запустите снова.');
    process.exit(1);
  }
}

// Изменения в папке: сохраняем и отправляем на GitHub.
try {
  guardPublic();
  if (git(['status', '--porcelain'])) {
    git(['add', '-A']);
    git(['commit', '-m', `Twenty Words Studio ${version}`]);
    console.log('Изменения сохранены в git.');
  }
  git(['push']);
  console.log('Код отправлен на GitHub.');
} catch (err) {
  console.error('Не получилось сохранить или отправить код в git:\n' + ((err.stderr || '') + (err.stdout || '') || err.message));
  process.exit(1);
}

// Релиз создаём заранее сами: electron-builder иногда создаёт его дважды и получает 422.
if (existing) {
  console.log(`Релиз ${tag} уже есть, загружаю файлы в него.`);
} else {
  gh(['release', 'create', tag, '--repo', full, '--title', version, '--notes', `Twenty Words Studio ${version}`]);
  console.log(`Создан релиз ${tag}.`);
}

console.log(`Собираю и выкладываю Twenty Words Studio ${version}...\n`);
const child = spawn('npx electron-builder --win --publish always', {
  cwd: ROOT,
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, GH_TOKEN: token },
});
child.on('exit', (code) => {
  if (code === 0) {
    console.log('\nГотово. Ссылка на установщик (всегда последняя версия):');
    console.log(`https://github.com/${full}/releases/latest/download/Twenty-Words-Studio-Setup.exe`);
  }
  process.exit(code || 0);
});
