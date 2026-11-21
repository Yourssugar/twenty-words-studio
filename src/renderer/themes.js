'use strict';
// Темы оформления. Сезонные палитры и фоны взяты из Twenty Words Launcher.
// Остальные темы лежат в assets/themes/themes.json (см. loadExtraThemes).

const THEMES = [
  {
    id: 'spring',
    name: 'Весна',
    vars: { '--bg': '#121a16', '--panel': '#1a2620', '--panel-2': '#22342b', '--line': '#31503f', '--muted': '#97b8a6', '--accent': '#3ccf91', '--accent-ink': '#05170e' },
    bg: 'spring',
  },
  {
    id: 'summer',
    name: 'Лето',
    vars: { '--bg': '#0e1a22', '--panel': '#13262f', '--panel-2': '#1b3440', '--line': '#285063', '--muted': '#90b7c6', '--accent': '#ffb703', '--accent-ink': '#1a1200' },
    bg: 'summer',
  },
  {
    id: 'autumn',
    name: 'Осень',
    vars: { '--bg': '#1a120c', '--panel': '#261a12', '--panel-2': '#35241a', '--line': '#4d3424', '--muted': '#b89f8a', '--accent': '#e67e22', '--accent-ink': '#1d0e02' },
    bg: 'autumn',
  },
  {
    id: 'winter',
    name: 'Зима',
    vars: { '--bg': '#0f1724', '--panel': '#172234', '--panel-2': '#203048', '--line': '#2f4462', '--muted': '#8fa3bf', '--accent': '#4fa3ff', '--accent-ink': '#08111f' },
    bg: 'winter',
  },
];

// Темы из assets/themes/themes.json (их проверяет главный процесс) встают после сезонных.
async function loadExtraThemes() {
  try {
    const list = await call(studio.app.themes());
    for (const t of list) if (!THEMES.some((x) => x.id === t.id)) THEMES.push(t);
  } catch {}
}

// «По сезону»: весна с марта, лето с июня, осень с сентября, зима с декабря.
function seasonNow(d = new Date()) {
  const m = d.getMonth();
  if (m >= 2 && m <= 4) return 'spring';
  if (m >= 5 && m <= 7) return 'summer';
  if (m >= 8 && m <= 10) return 'autumn';
  return 'winter';
}

function resolveTheme(id) {
  const real = id === 'auto' || !id ? seasonNow() : id;
  return THEMES.find((t) => t.id === real) || THEMES.find((t) => t.id === seasonNow());
}

function applyTheme(id) {
  const t = resolveTheme(id);
  const root = document.documentElement;
  for (const th of THEMES) for (const k of Object.keys(th.vars)) root.style.removeProperty(k);
  for (const [k, v] of Object.entries(t.vars)) root.style.setProperty(k, v);
  root.style.setProperty('--theme-bg', t.bg ? `url("../assets/themes/${t.bg}.webp")` : 'none');
  root.dataset.theme = t.id;
  return t;
}
