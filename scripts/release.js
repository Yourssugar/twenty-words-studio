#!/usr/bin/env node
// Сборка установщика и выпуск новой версии: npm run release
//
// 1. Поднимите версию в package.json ("version"), например 0.4.0 -> 0.4.1, закоммитьте и запушьте.
// 2. npm run release
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

// Релиз создаём заранее сами: electron-builder иногда создаёт его дважды и получает 422.
try {
  gh(['release', 'view', tag, '--repo', full]);
  console.log(`Релиз ${tag} уже есть, загружаю файлы в него.`);
} catch {
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
