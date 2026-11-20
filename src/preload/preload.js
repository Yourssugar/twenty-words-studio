// Мост между интерфейсом и главным процессом.
// Интерфейс видит только эти функции: ни Node, ни сети, ни файлов.

const { contextBridge, ipcRenderer } = require('electron');

const call = (channel, arg) => ipcRenderer.invoke(channel, arg);
const on = (channel) => (cb) => {
  const fn = (_e, data) => cb(data);
  ipcRenderer.on(channel, fn);
  return () => ipcRenderer.removeListener(channel, fn);
};

contextBridge.exposeInMainWorld('studio', {
  auth: {
    state: () => call('auth:state'),
    login: (login, password) => call('auth:login', { login, password }),
    register: (code, login, name, password) => call('auth:register', { code, login, name, password }),
    logout: () => call('auth:logout'),
    onSignedOut: on('auth:signedOut'),
  },
  chat: {
    connect: () => call('chat:connect'),
    send: (obj) => call('chat:send', obj),
    onEvent: on('chat:event'),
    onStatus: on('chat:status'),
    onOpenRoom: on('app:openRoom'),
  },
  api: {
    me: () => call('api:me'),
    updateMe: (patch) => call('api:updateMe', patch),
    changePassword: (oldPass, newPass) => call('api:password', { old: oldPass, new: newPass }),
    users: () => call('api:users'),
    rooms: () => call('api:rooms'),
    messages: (room, before) => call('api:messages', { room, before }),
  },
  board: {
    get: () => call('board:get'),
    add: (branch, title, body) => call('board:add', { branch, title, body }),
    edit: (id, title, body) => call('board:edit', { id, title, body }),
    remove: (id) => call('board:delete', { id }),
    branch: (id, title, note) => call('admin:branch', { id, title, note }),
  },
  ai: {
    models: () => call('ai:models'),
    chats: () => call('ai:chats'),
    createChat: (title, system, model) => call('ai:createChat', { title, system, model }),
    updateChat: (chatId, patch) => call('ai:updateChat', { chatId, ...patch }),
    deleteChat: (chatId) => call('ai:deleteChat', { chatId }),
    messages: (chatId) => call('ai:messages', { chatId }),
    send: (chatId, text, notes) => call('ai:send', { chatId, text, notes }),
    estimate: (chatId, text, notes) => call('ai:estimate', { chatId, text, notes }),
    skills: () => call('ai:skills'),
    notes: () => call('ai:notes'),
    addNote: (title, body) => call('ai:addNote', { title, body }),
    editNote: (id, title, body) => call('ai:editNote', { id, title, body }),
    deleteNote: (id) => call('ai:deleteNote', { id }),
    stop: (chatId) => call('ai:stop', { chatId }),
    onEvent: on('ai:event'),
  },
  admin: {
    ai: () => call('admin:ai'),
    aiUser: (id, settings) => call('admin:aiUser', { id, ...settings }),
    aiDefaults: (model) => call('admin:aiDefaults', { model }),
    aiPool: (name, limits) => call('admin:aiPool', { name, ...limits }),
    aiSystem: (system) => call('admin:aiSystem', { system }),
    aiAddSkill: (skill) => call('admin:aiAddSkill', skill),
    aiEditSkill: (id, skill) => call('admin:aiEditSkill', { id, ...skill }),
    aiDeleteSkill: (id) => call('admin:aiDeleteSkill', { id }),
    aiModel: (name, ctx) => call('admin:aiModel', { name, ctx }),
    users: () => call('admin:users'),
    invites: () => call('admin:invites'),
    createInvite: (name, role, days) => call('admin:createInvite', { name, role, days }),
    revokeInvite: (id) => call('admin:revokeInvite', { id }),
    userAction: (id, action, role) => call('admin:userAction', { id, action, role }),
    deleteUser: (id) => call('admin:deleteUser', { id }),
  },
  tools: {
    list: () => call('tools:list'),
    install: (id) => call('tools:install', { id }),
    cancel: (id) => call('tools:cancel', { id }),
    remove: (id) => call('tools:remove', { id }),
    open: (id) => call('tools:open', { id }),
    onProgress: on('tools:progress'),
  },
  settings: {
    get: () => call('settings:get'),
    set: (patch) => call('settings:set', patch),
  },
  app: {
    info: () => call('app:info'),
    copy: (text) => call('app:copy', { text }),
    restart: () => call('app:restart'),
    onUpdate: on('app:update'),
  },
});
