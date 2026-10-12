// Entry point: hash router, nav, and glue between views.
import { el, clear, errorBox } from './ui.js';
import { setPdfjs } from './pipeline.js';
import { parseHash, pendingCount, onSessionChange } from './state.js';
import { initSync, onSyncStatus, getSyncStatus, statusLabel, needsSignIn, connect, SYNC_EVENT } from './sync.js';
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
    syncPill(),
    nav));
  updateBadge();
}

/** Small Drive status pill: "Drive: synced 2 min ago" etc. Click → Settings (or straight to Google sign-in when needed). */
function syncPill() {
  const pill = el('a', { class: 'sync-pill', href: '#/settings', title: 'Google Drive sync status', dataset: { state: 'not-connected' } }, statusLabel(getSyncStatus()));
  const refresh = () => {
    const s = getSyncStatus();
    pill.textContent = statusLabel(s);
    pill.dataset.state = s.status;
    pill.title = s.message ? `Google Drive sync: ${s.message}` : 'Google Drive sync status';
  };
  onSyncStatus(refresh);
  setInterval(refresh, 30 * 1000);
  pill.addEventListener('click', (e) => {
    if (!needsSignIn()) return;
    e.preventDefault();
    connect();
  });
  return pill;
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
  // Drive sync: only does anything when the user connected it earlier on this device.
  initSync().catch(() => {});
  // Remote changes landed: redraw list views so they show the new data. Review and Settings are left alone — they
  // may hold unsaved input (edits, a half-typed Client ID); Settings updates its own status line via onSyncStatus.
  window.addEventListener(SYNC_EVENT, () => {
    const { name } = parseHash();
    if (['family', 'results', 'compare'].includes(name)) route();
  });
  // Pending imports live only in memory: warn before a reload/close would silently drop them.
  window.addEventListener('beforeunload', (e) => {
    if (pendingCount() > 0) { e.preventDefault(); e.returnValue = ''; }
  });
  window.addEventListener('hashchange', route);
  if (!location.hash) location.replace('#/import');
  route();
}
