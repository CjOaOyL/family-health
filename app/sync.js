// Google Drive sync wiring for the browser: Google Identity Services token client (loaded only on demand),
// in-memory access token, status pill state, triggers (start / after writes / visibility / manual).
// The engine itself (src/sync/drive.js) is DOM-free; this module injects fetch + the token getter.
//
// What leaves the device: with the user signed in, the JSON snapshot (members, report records) and the stored
// PDFs go to https://www.googleapis.com (Drive API, hidden app folder of the signed-in account) only. The
// sign-in library comes from https://accounts.google.com. Nothing syncs until the user clicks Connect.
import { GOOGLE_CLIENT_ID } from './config.js';
import { createSyncEngine, SCOPE } from '../src/sync/drive.js';
import * as db from '../src/store/db.js';

const GIS_SRC = 'https://accounts.google.com/gsi/client';
const DEBOUNCE_MS = 1500;
const VISIBLE_RESYNC_MS = 2 * 60 * 1000;
const SILENT_RETRY_MS = 5 * 60 * 1000;
export const SYNC_EVENT = 'familyhealth:synced';

const state = {
  connected: false,            // the user connected Drive on this device (persisted flag)
  status: 'not-connected',     // not-connected | idle | syncing | synced | offline | needs-auth | error
  message: '',
  notice: '',                  // one-line note from the last successful sync that the user should still see (e.g. a quarantined corrupt snapshot)
  lastSyncAt: null,
  lastResult: null,
  clientId: '',
  clientIdSource: 'none',      // config | settings | none
  available: true,             // IndexedDB + engine usable
};
const listeners = new Set();
function emit() { for (const fn of listeners) { try { fn(getSyncStatus()); } catch { /* ignore */ } } }
export function onSyncStatus(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function getSyncStatus() { return { ...state }; }
function setStatus(status, message = '') { state.status = status; state.message = message || ''; emit(); }

// ---------- Google Identity Services ----------
let token = null;            // { value, expiresAt } — memory only, never persisted
let tokenClient = null;
let tokenClientFor = null;
let gisPromise = null;
let pendingResolve = null;
let lastSilentFailAt = 0;

function loadGis() {
  if (globalThis.google && google.accounts && google.accounts.oauth2) return Promise.resolve();
  if (gisPromise) return gisPromise;
  gisPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = GIS_SRC; s.async = true; s.defer = true;
    s.onload = () => resolve();
    s.onerror = () => { gisPromise = null; reject(new Error('Could not load the Google sign-in library')); };
    document.head.appendChild(s);
  });
  return gisPromise;
}

async function getClient() {
  const id = state.clientId;
  if (!id) throw new Error('No Google OAuth Client ID. Paste one in Settings → Google Drive sync.');
  await loadGis();
  if (!tokenClient || tokenClientFor !== id) {
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: id,
      scope: SCOPE,
      callback: (resp) => { const r = pendingResolve; pendingResolve = null; if (r) r(resp || {}); },
      error_callback: (err) => { const r = pendingResolve; pendingResolve = null; if (r) r({ error: (err && (err.type || err.message)) || 'popup_failed' }); },
    });
    tokenClientFor = id;
  }
  return tokenClient;
}

/** Ask GIS for an access token. prompt '' = silent when Google already trusts this app in this browser. */
async function requestToken(prompt) {
  let client;
  try { client = await getClient(); } catch (e) { return { error: e.message || String(e) }; }
  if (pendingResolve) return { error: 'A sign-in is already in progress' };
  const resp = await new Promise((resolve) => {
    pendingResolve = resolve;
    try { client.requestAccessToken(prompt === undefined ? {} : { prompt }); } catch (e) { pendingResolve = null; resolve({ error: e.message || String(e) }); }
  });
  if (resp && resp.access_token) {
    token = { value: resp.access_token, expiresAt: Date.now() + (Number(resp.expires_in) || 3600) * 1000 };
    return { token: token.value };
  }
  return { error: (resp && (resp.error_description || resp.error)) || 'No token returned' };
}

function tokenValid() { return !!token && token.expiresAt - 60 * 1000 > Date.now(); }

/** Token getter for the engine: memory token, else a silent refresh (throttled). Interactive prompts only come from clicks. */
async function getTokenForEngine({ forceRefresh = false } = {}) {
  if (forceRefresh) token = null;
  if (tokenValid()) return token.value;
  if (!state.connected) return null;
  if (Date.now() - lastSilentFailAt < SILENT_RETRY_MS) return null;
  const r = await requestToken('');
  if (r.token) return r.token;
  lastSilentFailAt = Date.now();
  return null;
}

// ---------- engine ----------
let engine = null;
function getEngine() {
  if (engine) return engine;
  engine = createSyncEngine({
    db,
    fetch: (url, init) => fetch(url, { ...init, referrerPolicy: 'no-referrer', credentials: 'omit' }),
    getToken: getTokenForEngine,
    isOnline: () => (typeof navigator === 'undefined' ? true : navigator.onLine !== false),
  });
  return engine;
}

// ---------- public API ----------
export const DRIVE_SCOPE = SCOPE;

/** Called once from main.js. Never throws. */
export async function initSync() {
  try {
    const saved = await db.getSetting(db.CLIENT_ID_SETTING, '');
    applyClientId(saved);
    state.connected = !!(await db.getSetting(db.DRIVE_CONNECTED_SETTING, false));
    const meta = await db.getSyncMeta();
    state.lastSyncAt = meta.lastSyncAt || null;
  } catch (e) {
    state.available = false;
    setStatus('not-connected', e && e.message ? e.message : String(e));
    return;
  }
  if (state.connected) {
    setStatus('idle');
    loadGis().catch(() => {});
    runSync('start');
  } else setStatus('not-connected');
  window.addEventListener('online', () => requestSync('online'));
  window.addEventListener('offline', () => { if (state.connected) setStatus('offline'); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !state.connected) return;
    if (!state.lastSyncAt || Date.now() - Date.parse(state.lastSyncAt) > VISIBLE_RESYNC_MS) requestSync('visible');
  });
}

function applyClientId(saved) {
  const s = typeof saved === 'string' ? saved.trim() : '';
  if (s) { state.clientId = s; state.clientIdSource = 'settings'; }
  else if (GOOGLE_CLIENT_ID) { state.clientId = GOOGLE_CLIENT_ID; state.clientIdSource = 'config'; }
  else { state.clientId = ''; state.clientIdSource = 'none'; }
}

export function configClientId() { return GOOGLE_CLIENT_ID; }

/** Persist a Client ID override ('' = use config value). */
export async function setClientId(id) {
  const v = String(id || '').trim();
  await db.setSetting(db.CLIENT_ID_SETTING, v);
  applyClientId(v);
  tokenClient = null; tokenClientFor = null; token = null;
  emit();
  return state.clientId;
}

/** Interactive connect (must be called from a user gesture). Returns the first sync result or an error object. */
export async function connect() {
  if (!state.clientId) return { ok: false, status: 'error', message: 'Paste your Google OAuth Client ID first' };
  setStatus(state.connected ? 'syncing' : 'idle', 'Waiting for Google sign-in…');
  const prompt = state.connected ? '' : 'select_account';
  const started = Date.now();
  const r = await requestToken(prompt);
  if (!r.token) {
    // A popup that closes within a few seconds of a select_account prompt is almost never the user cancelling:
    // Google showed an error page (bad Client ID, origin not authorised) that GIS only reports as popup_closed.
    const msg = describeAuthError(r.error, { quick: prompt === 'select_account' && Date.now() - started < 3000 });
    setStatus(state.connected ? 'needs-auth' : 'not-connected', msg);
    return { ok: false, status: 'needs-auth', message: msg };
  }
  if (!state.connected) {
    state.connected = true;
    await db.setSetting(db.DRIVE_CONNECTED_SETTING, true);
  }
  lastSilentFailAt = 0;
  return runSync('connect', { force: true });
}

const CLIENT_ID_HINT = 'If Google showed an error, check the Client ID and the Authorized JavaScript origin (docs/GOOGLE-DRIVE-SETUP.md)';

function describeAuthError(err, { quick = false } = {}) {
  const e = String(err || '');
  if (/popup_closed/.test(e) && quick) return `Sign-in was cancelled. ${CLIENT_ID_HINT}`;
  if (/popup_closed|access_denied/.test(e)) return 'Sign-in was cancelled';
  if (/popup_failed/.test(e)) return 'The sign-in window was blocked; allow pop-ups for this site and try again';
  if (/invalid_client|idpiframe|origin/i.test(e)) return `Google rejected the Client ID or this page's origin (${e})`;
  return e || 'Sign-in failed';
}

/**
 * Disconnect: revoke the token, forget the connection. Options:
 *   eraseRemote  delete the app-folder files in Drive first (needs a valid token)
 *   eraseLocal   clear all local data on this device afterwards
 */
export async function disconnect({ eraseRemote = false, eraseLocal = false } = {}) {
  const out = { ok: true, remote: null, message: 'Disconnected' };
  if (eraseRemote) {
    out.remote = await getEngine().deleteAllRemote();
    if (!out.remote.ok) { out.ok = false; out.message = `Could not delete the Drive data: ${out.remote.message}`; setStatus('error', out.message); return out; }
  }
  if (token && globalThis.google && google.accounts && google.accounts.oauth2) {
    try { await new Promise((res) => { google.accounts.oauth2.revoke(token.value, () => res()); setTimeout(res, 3000); }); } catch { /* ignore */ }
  }
  token = null; tokenClient = null; tokenClientFor = null;
  state.connected = false; state.lastSyncAt = null; state.lastResult = null; state.notice = '';
  await db.setSetting(db.DRIVE_CONNECTED_SETTING, false);
  await db.setSyncMeta({ lastSyncAt: null, snapshotDriveId: null, remoteModifiedTime: null, localDigest: null });
  if (eraseLocal) { await db.clearAll(); out.message += '; local data erased'; }
  if (out.remote && out.remote.ok) out.message += `; ${out.remote.message}`;
  setStatus('not-connected');
  return out;
}

let timer = null;
/** Debounced sync after a local write. No-op when not connected. */
export function requestSync(reason = 'change') {
  if (!state.connected || !state.available) return;
  clearTimeout(timer);
  timer = setTimeout(() => { timer = null; runSync(reason); }, DEBOUNCE_MS);
}

/** Immediate sync (manual "Sync now" or right after connecting). */
export function syncNow(reason = 'manual') {
  clearTimeout(timer); timer = null;
  if (!state.connected) return Promise.resolve({ ok: false, status: 'not-connected', message: 'Not connected' });
  lastSilentFailAt = 0;
  return runSync(reason, { force: true });
}

async function runSync(reason, opts = {}) {
  if (!state.connected || !state.available) return null;
  setStatus('syncing');
  let r;
  try { r = await getEngine().sync({ reason, ...opts }); } catch (e) { r = { ok: false, status: 'error', message: e && e.message ? e.message : String(e) }; }
  state.lastResult = r;
  state.notice = (r && r.notice) || '';
  if (r.ok) {
    state.lastSyncAt = r.at || new Date().toISOString();
    setStatus('synced', r.message);
    if (r.changedLocal) { try { window.dispatchEvent(new CustomEvent(SYNC_EVENT, { detail: r })); } catch { /* ignore */ } }
  } else if (r.status === 'offline') setStatus('offline', r.message);
  else if (r.status === 'needs-auth') setStatus('needs-auth', r.message);
  else setStatus('error', r.message);
  return r;
}

/** True when the pill click should open the Google prompt instead of navigating to Settings. */
export function needsSignIn() { return state.connected && (state.status === 'needs-auth' || (state.status === 'error' && !tokenValid())); }

/**
 * PDF bytes for a report: local store first, then Drive when connected. Returns { bytes, fileName, source } or null.
 */
export async function ensureFileBytes(id, { fileName = null } = {}) {
  try {
    const local = await db.getFile(id);
    if (local && local.bytes) return { bytes: local.bytes, fileName: local.fileName || fileName, source: 'local' };
  } catch { /* fall through */ }
  if (!state.connected) return null;
  return getEngine().ensureFileBytes(id, { fileName });
}

/** PDF hashes known in Drive from the last listing (empty when not connected). */
export function remoteFileIds() { return state.connected && engine ? engine.remoteFileIds() : []; }

/** Short human label for the status pill. */
export function statusLabel(s = state, now = Date.now()) {
  switch (s.status) {
    case 'not-connected': return 'Drive: not connected';
    case 'idle': return 'Drive: connected';
    case 'syncing': return 'Drive: syncing…';
    case 'synced': return `Drive: synced ${relTime(s.lastSyncAt, now)}`;
    case 'offline': return 'Drive: offline';
    case 'needs-auth': return 'Drive: sign in to sync';
    case 'error': return `Drive: ${truncate(s.message || 'error', 40)}`;
    default: return 'Drive';
  }
}

export function relTime(iso, now = Date.now()) {
  if (!iso) return '';
  const ms = now - Date.parse(iso);
  if (!isFinite(ms) || ms < 45 * 1000) return 'just now';
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

function truncate(s, n) { s = String(s); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
