'use strict';
// Картинки в чате: сжатие в webp, загрузка, показ в сообщении и на весь экран.
//
// Картинку можно прикрепить кнопкой, вставить из буфера (Ctrl+V) или перетащить в поле ввода.
// Перед загрузкой она пережимается здесь же: длинная сторона до 1920, webp.
// В общих комнатах ("Рабочая зона", "Свободные темы") картинок нет, там только текст:
// для картинок есть подчаты, личные переписки и обсуждения карточек.

const CI = { cache: new Map(), loading: new Map() };
const CI_MAX = 6;
const CI_ICON = '<svg viewBox="0 0 24 24"><path d="M3 5h18v14H3zM3 16l5-5 4 4 3-3 6 6M15.5 9.5h.01"/></svg>';

const imagesAllowedIn = (room) => !!room && room !== 'work' && room !== 'free';

// В webp: длинная сторона до 1920, если вышло больше 2,9 МБ, меньше и хуже.
async function chatWebP(blob) {
  const bmp = await createImageBitmap(blob);
  for (const [side, q] of [[1920, 0.82], [1600, 0.74], [1280, 0.66], [1000, 0.6]]) {
    const scale = Math.min(1, side / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(bmp.width * scale));
    c.height = Math.max(1, Math.round(bmp.height * scale));
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    const url = c.toDataURL('image/webp', q);
    const b64 = url.slice(url.indexOf(',') + 1);
    if (b64.length * 0.75 <= 2.9 * 1024 * 1024) return { url, b64, w: c.width, h: c.height };
  }
  throw Object.assign(new Error('bad_image'), { code: 'bad_image' });
}

// Картинка с сервера (data:), с небольшим кэшем.
function chatImgUrl(id) {
  if (CI.cache.has(id)) return Promise.resolve(CI.cache.get(id));
  if (!CI.loading.has(id)) {
    CI.loading.set(id, call(studio.chatImages.get(id)).then((url) => {
      CI.loading.delete(id);
      CI.cache.set(id, url);
      if (CI.cache.size > 150) CI.cache.delete(CI.cache.keys().next().value);
      return url;
    }, (err) => {
      CI.loading.delete(id);
      throw err;
    }));
  }
  return CI.loading.get(id);
}

// Сетка картинок под текстом сообщения.
function msgImages(m) {
  if (!m.images || !m.images.length) return null;
  const n = m.images.length;
  const box = h('div', { class: 'msg-images n' + Math.min(n, 4) });
  m.images.forEach((im, i) => {
    const tile = h('button', { class: 'msg-img', type: 'button', title: 'Открыть', onclick: () => openLightbox(m.images, i) });
    if (n === 1 && im.w && im.h) tile.style.aspectRatio = im.w + ' / ' + im.h;
    tile.append(h('span', { class: 'sk msg-img-sk' }));
    chatImgUrl(im.id).then((url) => {
      tile.innerHTML = '';
      tile.append(h('img', { src: url, alt: '', draggable: 'false' }));
    }, () => {
      tile.innerHTML = '';
      tile.append(h('span', { class: 'muted small', text: 'картинка удалена' }));
    });
    box.append(tile);
  });
  return box;
}

// ---------- просмотр на весь экран ----------

function openLightbox(list, start) {
  let i = start;
  const img = h('img', { class: 'lb-img', alt: '' });
  const count = h('span', { class: 'lb-count' });
  const prev = h('button', { class: 'lb-nav lb-prev', type: 'button', title: 'Предыдущая', text: '<' });
  const next = h('button', { class: 'lb-nav lb-next', type: 'button', title: 'Следующая', text: '>' });
  const close = h('button', { class: 'lb-close', type: 'button', title: 'Закрыть (Esc)', text: 'x' });
  const box = h('div', { class: 'lightbox', role: 'dialog' }, img, prev, next, close, count);
  const show = () => {
    img.removeAttribute('src');
    chatImgUrl(list[i].id).then((url) => {
      img.src = url;
    }, () => {});
    count.textContent = list.length > 1 ? i + 1 + ' из ' + list.length : '';
    prev.hidden = next.hidden = list.length < 2;
  };
  const go = (d) => {
    i = (i + d + list.length) % list.length;
    show();
  };
  const done = () => {
    box.remove();
    document.removeEventListener('keydown', onKey, true);
  };
  const onKey = (e) => {
    if (e.key === 'Escape') done();
    else if (e.key === 'ArrowLeft') go(-1);
    else if (e.key === 'ArrowRight') go(1);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  prev.addEventListener('click', () => go(-1));
  next.addEventListener('click', () => go(1));
  close.addEventListener('click', done);
  box.addEventListener('click', (e) => {
    if (e.target === box) done();
  });
  document.addEventListener('keydown', onKey, true);
  document.body.append(box);
  show();
}

// ---------- вложения в поле ввода ----------

// Attacher: картинки, которые ждут отправки. strip: куда рисовать миниатюры.
class Attacher {
  constructor(strip, onChange) {
    this.strip = strip;
    this.onChange = onChange || (() => {});
    this.items = []; // { url, b64, w, h, id }
    this.busy = false;
  }

  get count() {
    return this.items.length;
  }

  async add(files) {
    const list = [...files].filter((f) => f && /^image\//.test(f.type));
    if (!list.length) return;
    if (this.items.length + list.length > CI_MAX) toast('В одном сообщении до ' + CI_MAX + ' картинок.');
    for (const f of list.slice(0, CI_MAX - this.items.length)) {
      try {
        this.items.push(await chatWebP(f));
      } catch {
        toast('Не получилось прочитать картинку. Подойдут png, jpg, webp, gif.');
      }
      this.render();
    }
  }

  remove(i) {
    this.items.splice(i, 1);
    this.render();
  }

  clear() {
    this.items = [];
    this.render();
  }

  render() {
    this.strip.innerHTML = '';
    this.strip.hidden = !this.items.length;
    this.items.forEach((it, i) => {
      this.strip.append(h('div', { class: 'att' },
        h('img', { src: it.url, alt: '' }),
        h('button', { class: 'att-x', type: 'button', title: 'Убрать', text: 'x', onclick: () => this.remove(i) })));
    });
    this.onChange();
  }

  // Загрузить на сервер для комнаты. Уже загруженные второй раз не грузятся.
  async upload(room) {
    const ids = [];
    for (const it of this.items) {
      if (!it.id || it.room !== room) {
        const r = await call(studio.chatImages.upload(room, it.b64, it.w, it.h));
        it.id = r.id;
        it.room = room;
      }
      ids.push(it.id);
    }
    return ids;
  }
}

// Кнопка "картинка", вставка из буфера и перетаскивание в поле ввода.
function bindAttach({ input, dropZone, button, attacher, allowed }) {
  const file = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif,image/bmp', multiple: true, hidden: true });
  file.addEventListener('change', () => {
    attacher.add(file.files);
    file.value = '';
  });
  button.after(file);
  button.innerHTML = CI_ICON;
  button.addEventListener('click', () => {
    if (allowed()) file.click();
  });
  input.addEventListener('paste', (e) => {
    const imgs = [...(e.clipboardData ? e.clipboardData.files : [])].filter((f) => /^image\//.test(f.type));
    if (!imgs.length) return;
    e.preventDefault();
    if (!allowed()) {
      toast('В общих комнатах только текст. Картинки можно в подчатах и личных сообщениях.');
      return;
    }
    attacher.add(imgs);
  });
  dropZone.addEventListener('dragover', (e) => {
    if (!allowed() || !e.dataTransfer || ![...e.dataTransfer.types].includes('Files')) return;
    e.preventDefault();
    dropZone.classList.add('drop-on');
  });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drop-on'));
  dropZone.addEventListener('drop', (e) => {
    dropZone.classList.remove('drop-on');
    if (!allowed() || !e.dataTransfer) return;
    e.preventDefault();
    attacher.add(e.dataTransfer.files);
  });
}

// Отправка сообщения с картинками: загрузить, потом отправить. true, если ушло.
async function sendWithImages(room, text, attacher) {
  if (!text && !attacher.count) return false;
  if (attacher.busy) return false;
  attacher.busy = true;
  try {
    const images = attacher.count ? await attacher.upload(room) : undefined;
    const ok = await call(studio.chat.send({ t: 'send', room, text, images, cid: Math.random().toString(36).slice(2, 10) }));
    if (!ok) {
      toast('Нет связи с сервером. Сообщение не отправлено.');
      return false;
    }
    attacher.clear();
    return true;
  } catch (err) {
    toast(errText(err.code));
    return false;
  } finally {
    attacher.busy = false;
  }
}
