// Entry point: hash router, nav, and glue between views.
import { el, clear, errorBox } from './ui.js';
import { setPdfjs } from './pipeline.js';
import { parseHash, pendingCount, onSessionChange } from './state.js';
import * as importView from './views/import.js';
import * as reviewView from './views/review.js';
import * as familyView from './views/family.js';
import * as resultsView from './views/results.js';
import * as compareView from './views/compare.js';
import * as settingsView from './views/settings.js';

const APP_NAME = 'Family Health';

const ROUTES = {
  import: importView,
  review: reviewView,
  family: familyView,
  results: resultsView,
  compare: compareView,
  settings: settingsView,
};

const NAV = [
  ['import', 'Import'],
  ['family', 'Family'],
  ['results', 'Results'],
  ['compare', 'Compare'],
  ['settings', 'Settings'],
];

let routeToken = 0;
let currentCleanup = null;

function buildNav() {
  const bar = document.getElementById('topbar');
  const nav = el('nav', { class: 'nav', 'aria-label': 'Main' });
  for (const [name, label] of NAV) {
    const a = el('a', { href: `#/${name}`, dataset: { route: name } }, label);
    if (name === 'import') a.appendChild(el('span', { class: 'badge hidden', 'aria-label': 'pending reviews' }));
    nav.appendChild(a);
  }
  clear(bar).appendChild(el('div', { class: 'topbar-inner' },
    el('a', { class: 'brand', href: '#/import' }, el('span', { class: 'dot', 'aria-hidden': 'true' }), APP_NAME),
    nav));
  updateBadge();
}

function updateBadge() {
  const b = document.querySelector('.nav a[data-route="import"] .badge');
  if (!b) return;
  const n = pendingCount();
  b.textContent = n ? String(n) : '';
  b.classList.toggle('hidden', n === 0);
}

function highlight(name) {
  for (const a of document.querySelectorAll('.nav a')) a.classList.toggle('active', a.dataset.route === name || (name === 'review' && a.dataset.route === 'import'));
}

async function route() {
  const { name, id, query } = parseHash();
  const view = ROUTES[name];
  const root = document.getElementById('app');
  const token = ++routeToken;
  if (typeof currentCleanup === 'function') { try { currentCleanup(); } catch { /* ignore */ } currentCleanup = null; }
  if (!view) { location.replace('#/import'); return; }
  highlight(name);
  document.title = `${view.title || name} · ${APP_NAME}`;
  clear(root);
  window.scrollTo(0, 0);
  try {
    const cleanup = await view.render(root, { id, query });
    if (token !== routeToken) { if (typeof cleanup === 'function') cleanup(); return; }
    currentCleanup = cleanup || null;
  } catch (err) {
    if (token !== routeToken) return;
    clear(root).appendChild(errorBox(err, `Could not render ${view.title || name}`));
  }
}

export function start({ pdfjsLib, pdfjsError } = {}) {
  setPdfjs(pdfjsLib, pdfjsError);
  buildNav();
  onSessionChange(updateBadge);
  window.addEventListener('hashchange', route);
  if (!location.hash) location.replace('#/import');
  route();
}
