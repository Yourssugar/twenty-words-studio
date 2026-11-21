// Мост панели встроенного браузера. Ей доступны только команды браузера:
// ни API студии, ни токена, ни файлов.

const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (cb) => {
  const fn = (_e, data) => cb(data);
  ipcRenderer.on(channel, fn);
  return () => ipcRenderer.removeListener(channel, fn);
};

contextBridge.exposeInMainWorld('twb', {
  init: () => ipcRenderer.invoke('browser:init'),
  cmd: (a) => ipcRenderer.invoke('browser:cmd', a),
  onState: on('browser:state'),
  onFocus: on('browser:focus'),
  onToast: on('browser:toast'),
  onTheme: on('browser:theme'),
});
