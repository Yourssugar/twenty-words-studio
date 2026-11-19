// Автообновление приложения через GitHub Releases (electron-updater).
// Работает только в установленной программе: при запуске через npm start ничего не делает.

const { app } = require('electron');

function setupUpdater(notify) {
  if (!app.isPackaged) return null;
  let autoUpdater;
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch (err) {
    console.warn('electron-updater не установлен: ' + err.message);
    return null;
  }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('update-downloaded', (info) => notify('app:update', { version: info.version }));
  autoUpdater.on('error', (err) => console.warn('Обновление: ' + (err && err.message)));
  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  setTimeout(check, 10 * 1000);
  setInterval(check, 6 * 60 * 60 * 1000);
  return { restart: () => autoUpdater.quitAndInstall(false, true) };
}

module.exports = { setupUpdater };
