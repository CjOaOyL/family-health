// Google Drive sync engine. Isomorphic: no DOM, no globals except what is injected
// ({ db, fetch, getToken, now, isOnline, randomId }) so it runs under node:test with a fake Drive.
//
// Everything lives in the signed-in user's hidden Drive app folder (spaces=appDataFolder):
//   family-health-sync.json      one JSON snapshot (members, reports, tombstones; NO PDF bytes)
//   pdf-<fileHash>.pdf           one file per stored PDF
// Nothing else is ever read or written, and the drive.appdata scope cannot see other Drive files.
import { merge, snapshotFromLists, changeCount, canonicalJson } from './merge.js';

export const SNAPSHOT_NAME = 'family-health-sync.json';
export const SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
export const DRIVE_API = 'https://www.googleapis.com/drive/v3';
export const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';

export const pdfName = (id) => `pdf-${id}.pdf`;
const PDF_RE = /^pdf-([0-9a-f]{16,})\.pdf$/i;

const BACKOFF_BASE_MS = 60 * 1000;
const BACKOFF_MAX_MS = 15 * 60 * 1000;

/** Small, stable digest of a string (FNV-1a 32-bit, hex) for change detection — not security. */
export function digest(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
}

export class SyncError extends Error {
  constructor(message, { status = 0, retryable = false, auth = false } = {}) { super(message); this.status = status; this.retryable = retryable; this.auth = auth; }
}

function concatBytes(parts) {
  const enc = new TextEncoder();
  const arrs = parts.map((p) => (typeof p === 'string' ? enc.encode(p) : p instanceof Uint8Array ? p : new Uint8Array(p)));
  const out = new Uint8Array(arrs.reduce((n, a) => n + a.byteLength, 0));
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.byteLength; }
  return out;
}

/**
 * createSyncEngine({ db, fetch, getToken, now, isOnline, log })
 *   db       adapter: listMembers, listReports, listTombstones, applySyncChanges, getSyncMeta, setSyncMeta,
 *            listFileIds, getFile(id) → { id, bytes, fileName }|null, putFile({ id, bytes, fileName })
 *   fetch    WHATWG fetch
 *   getToken ({ forceRefresh }) → Promise<string|null>  (null = not signed in; never throws into the engine)
 */
export function createSyncEngine({ db, fetch, getToken, now = () => new Date().toISOString(), isOnline = () => true, randomId = defaultRandomId, log = null } = {}) {
  if (!db || !fetch || !getToken) throw new Error('createSyncEngine: db, fetch and getToken are required');
  let running = null;       // Promise of the in-flight sync
  let queued = false;       // another sync was requested while one ran
  let backoffUntil = 0;     // epoch ms
  let backoffStep = 0;
  let lastListing = null;   // { at, files: Map<name, { id, size, modifiedTime }> }
  const nowMs = () => Date.parse(now());

  // ---------- HTTP ----------
  async function request(url, { method = 'GET', headers = {}, body, raw = false, retryAuth = true } = {}) {
    const token = await getToken({ forceRefresh: false });
    if (!token) throw new SyncError('Sign in to Google to sync', { auth: true });
    let res;
    try {
      res = await fetch(url, { method, headers: { Authorization: `Bearer ${token}`, ...headers }, body });
    } catch (e) {
      throw new SyncError(`Network error: ${e && e.message ? e.message : e}`, { retryable: true });
    }
    if (res.status === 401 && retryAuth) {
      const fresh = await getToken({ forceRefresh: true });
      if (!fresh) throw new SyncError('Google sign-in expired; sign in again', { status: 401, auth: true });
      return request(url, { method, headers, body, raw, retryAuth: false });
    }
    if (res.status === 401) throw new SyncError('Google sign-in expired; sign in again', { status: 401, auth: true });
    if (res.status === 403 || res.status === 429) {
      let msg = 'Google Drive refused the request';
      try { const j = await res.json(); msg = j && j.error && j.error.message ? j.error.message : msg; } catch { /* ignore */ }
      throw new SyncError(`${msg} (${res.status})`, { status: res.status, retryable: true });
    }
    if (res.status === 404) throw new SyncError('Not found in Drive', { status: 404 });
    if (!res.ok) {
      let msg = `Drive error ${res.status}`;
      try { const j = await res.json(); if (j && j.error && j.error.message) msg += `: ${j.error.message}`; } catch { /* ignore */ }
      throw new SyncError(msg, { status: res.status, retryable: res.status >= 500 });
    }
    if (res.status === 204) return null;
    if (raw) return res.arrayBuffer();
    return res.json();
  }

  async function listAppFiles() {
    const files = new Map();
    let pageToken = null;
    do {
      const qs = new URLSearchParams({ spaces: 'appDataFolder', fields: 'nextPageToken,files(id,name,size,modifiedTime)', pageSize: '1000' });
      if (pageToken) qs.set('pageToken', pageToken);
      const j = await request(`${DRIVE_API}/files?${qs}`);
      for (const f of (j && j.files) || []) if (f && f.name) files.set(f.name, { id: f.id, size: +f.size || 0, modifiedTime: f.modifiedTime || null });
      pageToken = j && j.nextPageToken ? j.nextPageToken : null;
    } while (pageToken);
    lastListing = { at: now(), files };
    return files;
  }

  async function download(id, { raw = false } = {}) {
    return request(`${DRIVE_API}/files/${encodeURIComponent(id)}?alt=media`, { raw });
  }

  async function createFile(name, mimeType, content) {
    const boundary = `fh-${randomId()}`;
    const meta = JSON.stringify({ name, parents: ['appDataFolder'], mimeType });
    const body = concatBytes([
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n`,
      `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`, content, `\r\n--${boundary}--`,
    ]);
    return request(`${UPLOAD_API}/files?uploadType=multipart&fields=id,name,modifiedTime`, {
      method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body,
    });
  }

  async function updateFile(id, mimeType, content) {
    return request(`${UPLOAD_API}/files/${encodeURIComponent(id)}?uploadType=media&fields=id,name,modifiedTime`, {
      method: 'PATCH', headers: { 'Content-Type': mimeType }, body: content,
    });
  }

  async function deleteFile(id) {
    try { await request(`${DRIVE_API}/files/${encodeURIComponent(id)}`, { method: 'DELETE' }); return true; } catch (e) { if (e.status === 404) return true; throw e; }
  }

  // ---------- local snapshot ----------
  async function localSnapshot() {
    const [members, reports, tombstones] = await Promise.all([db.listMembers(), db.listReports(), db.listTombstones()]);
    return snapshotFromLists({ members, reports, tombstones });
  }

  function statusOf(err) {
    if (err instanceof SyncError) return { ok: false, status: err.auth ? 'needs-auth' : 'error', message: err.message, retryable: err.retryable, httpStatus: err.status };
    return { ok: false, status: 'error', message: err && err.message ? err.message : String(err), retryable: false };
  }

  function applyBackoff(err) {
    if (err instanceof SyncError && (err.status === 403 || err.status === 429)) {
      backoffStep = Math.min(backoffStep + 1, 8);
      backoffUntil = nowMs() + Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (backoffStep - 1));
    }
  }

  // ---------- the sync ----------
  async function doSync({ reason = 'manual', force = false } = {}) {
    const at = now();
    const result = { ok: true, status: 'synced', message: '', reason, at, pulled: 0, pushed: 0, pdfsUploaded: 0, pdfsDeleted: 0, changedLocal: false, changedRemote: false, skipped: false };
    if (!isOnline()) return { ...result, ok: false, status: 'offline', message: 'Offline; will sync when back online' };
    if (!force && nowMs() < backoffUntil) return { ...result, ok: false, status: 'error', message: `Google Drive rate limit; retrying after ${new Date(backoffUntil).toISOString().slice(11, 16)} UTC`, retryable: true };
    try {
      const meta = await db.getSyncMeta();
      if (!meta.deviceId) meta.deviceId = randomId();
      const local = await localSnapshot();
      const localDigest = digest(canonicalJson({ m: local.members, r: local.reports, t: local.tombstones }));

      const files = await listAppFiles();
      const snapFile = files.get(SNAPSHOT_NAME) || null;

      // Fast path: nothing changed on either side since the last sync → only check for missing PDFs.
      const remoteUnchanged = snapFile && meta.snapshotDriveId === snapFile.id && meta.remoteModifiedTime && meta.remoteModifiedTime === snapFile.modifiedTime;
      let merged, localChanges, remoteChanged, remote = null;
      if (!force && remoteUnchanged && meta.localDigest === localDigest) {
        result.skipped = true;
        merged = local; localChanges = null; remoteChanged = false;
      } else {
        if (snapFile) {
          const json = await download(snapFile.id);
          if (!json || typeof json !== 'object' || json.formatVersion !== 1) throw new SyncError('The Drive snapshot is not in a format this app understands; not overwriting it', { status: 0 });
          remote = json;
        }
        ({ merged, localChanges, remoteChanged } = merge(local, remote, { now: at }));
        if (changeCount(localChanges)) {
          await db.applySyncChanges(localChanges);
          result.changedLocal = true;
          result.pulled = localChanges.members.length + localChanges.reports.length + localChanges.removeMembers.length + localChanges.removeReports.length;
        }
      }

      let snapId = snapFile ? snapFile.id : null;
      let snapModified = snapFile ? snapFile.modifiedTime : null;
      if (remoteChanged || !snapFile) {
        const content = JSON.stringify(merged);
        const r = snapFile ? await updateFile(snapFile.id, 'application/json', content) : await createFile(SNAPSHOT_NAME, 'application/json', content);
        snapId = r && r.id ? r.id : snapId;
        snapModified = r && r.modifiedTime ? r.modifiedTime : null;
        if (snapFile) { result.changedRemote = true; result.pushed = 1; } else result.changedRemote = true;
      }

      // PDFs: upload local ones Drive lacks (for reports that still exist), delete Drive ones whose report is gone.
      const localIds = new Set(await db.listFileIds());
      const liveReports = new Set(Object.keys(merged.reports));
      for (const id of localIds) {
        if (!liveReports.has(id) || files.has(pdfName(id))) continue;
        const f = await db.getFile(id);
        if (!f || !f.bytes) continue;
        const r = await createFile(pdfName(id), 'application/pdf', f.bytes instanceof Uint8Array ? f.bytes : new Uint8Array(f.bytes));
        files.set(pdfName(id), { id: r && r.id, size: f.bytes.byteLength, modifiedTime: r && r.modifiedTime });
        result.pdfsUploaded++;
      }
      for (const [name, f] of files) {
        const m = name.match(PDF_RE);
        if (!m || liveReports.has(m[1]) || !(merged.tombstones[m[1]] && merged.tombstones[m[1]].kind === 'report')) continue;
        if (await deleteFile(f.id)) { files.delete(name); result.pdfsDeleted++; }
      }

      // The local digest after applying remote changes is the merged body.
      const mergedDigest = result.changedLocal ? digest(canonicalJson({ m: merged.members, r: merged.reports, t: merged.tombstones })) : localDigest;
      await db.setSyncMeta({ lastSyncAt: at, snapshotDriveId: snapId, deviceId: meta.deviceId, remoteModifiedTime: snapModified, localDigest: mergedDigest });
      backoffStep = 0; backoffUntil = 0;
      result.message = result.skipped ? 'Up to date' : `Synced${result.pulled ? `, ${result.pulled} pulled` : ''}${result.changedRemote ? ', uploaded' : ''}${result.pdfsUploaded ? `, ${result.pdfsUploaded} PDF${result.pdfsUploaded === 1 ? '' : 's'} uploaded` : ''}`;
      return result;
    } catch (err) {
      applyBackoff(err);
      if (log) { try { log('sync failed', err); } catch { /* ignore */ } }
      return { ...result, ...statusOf(err) };
    }
  }

  /** Run one sync; concurrent callers share the in-flight run and one follow-up run is queued. Never throws. */
  function sync(opts = {}) {
    if (running) { queued = true; return running; }
    running = (async () => {
      let r = await doSync(opts);
      while (queued) { queued = false; r = await doSync({ reason: 'queued' }); }
      return r;
    })().finally(() => { running = null; });
    return running;
  }

  /**
   * Make sure the PDF bytes for fileHash are available locally, downloading from Drive when needed.
   * Returns { bytes, fileName, source: 'local'|'drive' } or null. Never throws.
   */
  async function ensureFileBytes(fileHash, { fileName = null } = {}) {
    try {
      const local = await db.getFile(fileHash);
      if (local && local.bytes) return { bytes: local.bytes, fileName: local.fileName || fileName, source: 'local' };
      if (!isOnline()) return null;
      let files = lastListing && (nowMs() - Date.parse(lastListing.at)) < 60 * 1000 ? lastListing.files : null;
      if (!files || !files.has(pdfName(fileHash))) files = await listAppFiles();
      const f = files.get(pdfName(fileHash));
      if (!f) return null;
      const bytes = await download(f.id, { raw: true });
      if (!bytes || !bytes.byteLength) return null;
      await db.putFile({ id: fileHash, bytes, fileName: fileName || null });
      return { bytes, fileName, source: 'drive' };
    } catch (err) {
      if (log) { try { log('ensureFileBytes failed', err); } catch { /* ignore */ } }
      return null;
    }
  }

  /** PDF hashes known to exist in Drive from the most recent listing (no network). */
  function remoteFileIds() {
    const out = [];
    if (!lastListing) return out;
    for (const name of lastListing.files.keys()) { const m = name.match(PDF_RE); if (m) out.push(m[1]); }
    return out;
  }

  /** Delete every file this app put in the Drive app folder. Returns { ok, deleted, message }. */
  async function deleteAllRemote() {
    try {
      const files = await listAppFiles();
      let deleted = 0;
      for (const [, f] of files) if (await deleteFile(f.id)) deleted++;
      lastListing = { at: now(), files: new Map() };
      await db.setSyncMeta({ snapshotDriveId: null, remoteModifiedTime: null, localDigest: null });
      return { ok: true, deleted, message: `Deleted ${deleted} file${deleted === 1 ? '' : 's'} from Drive` };
    } catch (err) { return { ok: false, deleted: 0, ...statusOf(err) }; }
  }

  return { sync, ensureFileBytes, remoteFileIds, deleteAllRemote, listAppFiles, get busy() { return !!running; } };
}

function defaultRandomId() {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}
