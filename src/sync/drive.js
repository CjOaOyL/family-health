// Google Drive sync engine. Isomorphic: no DOM, no globals except what is injected
// ({ db, fetch, getToken, now, isOnline, randomId }) so it runs under node:test with a fake Drive.
//
// Everything lives in the signed-in user's hidden Drive app folder (spaces=appDataFolder):
//   family-health-sync.json      one JSON snapshot (members, reports, tombstones; NO PDF bytes)
//   pdf-<fileHash>.pdf           one file per stored PDF
// Nothing else is ever read or written, and the drive.appdata scope cannot see other Drive files.
import { merge, snapshotFromLists, changeCount, canonicalJson, SNAPSHOT_FORMAT } from './merge.js';

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
  /** code: 'corrupt' (snapshot unreadable; quarantined and recreated) | 'newer' (written by a newer app; never overwritten) | null */
  constructor(message, { status = 0, retryable = false, auth = false, code = null } = {}) { super(message); this.status = status; this.retryable = retryable; this.auth = auth; this.code = code; }
}

/** Oldest createdTime first, then smallest id: the deterministic "primary" among same-named duplicates. */
export function primaryFirst(a, b) {
  const ca = a.createdTime || '', cb = b.createdTime || '';
  if (ca !== cb) return ca < cb ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Name a quarantined (unreadable) snapshot gets: family-health-sync.corrupt-<timestamp>[-n].json */
export function corruptName(at, n = 0) {
  return `family-health-sync.corrupt-${String(at).replace(/[:.]/g, '-')}${n ? `-${n}` : ''}.json`;
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
  let backoffMessage = ''; // what Drive said on the last 403/429
  let lastListing = null;   // { at, files: Map<name, { id, size, modifiedTime, createdTime, extras: [...] }> }
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

  /**
   * List the app folder. Returns Map<name, entry>; entry = { id, size, modifiedTime, createdTime, extras }.
   * Drive allows several files with the same name (two devices doing their first sync at the same moment each
   * create one). The entry is the primary copy (oldest createdTime, then smallest id); `extras` holds the rest so
   * the sync can fold them into the primary and delete them.
   */
  async function listAppFiles() {
    const byName = new Map();
    let pageToken = null;
    do {
      const qs = new URLSearchParams({ spaces: 'appDataFolder', fields: 'nextPageToken,files(id,name,size,modifiedTime,createdTime)', pageSize: '1000' });
      if (pageToken) qs.set('pageToken', pageToken);
      const j = await request(`${DRIVE_API}/files?${qs}`);
      for (const f of (j && j.files) || []) {
        if (!f || !f.name || !f.id) continue;
        if (!byName.has(f.name)) byName.set(f.name, []);
        byName.get(f.name).push({ id: f.id, size: f.size == null ? null : (+f.size || 0), modifiedTime: f.modifiedTime || null, createdTime: f.createdTime || null });
      }
      pageToken = j && j.nextPageToken ? j.nextPageToken : null;
    } while (pageToken);
    const files = new Map();
    for (const [name, list] of byName) { list.sort(primaryFirst); files.set(name, { ...list[0], extras: list.slice(1) }); }
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

  /** Metadata-only PATCH: rename a file in place (used to quarantine an unreadable snapshot). */
  async function renameFile(id, name) {
    return request(`${DRIVE_API}/files/${encodeURIComponent(id)}?fields=id,name`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
    });
  }

  /**
   * Download and validate one snapshot file. Throws SyncError code 'corrupt' (empty, not JSON, not a snapshot,
   * unknown/older format) or 'newer' (formatVersion above ours: never overwritten; the app must be updated).
   * HTTP/network errors propagate unchanged.
   */
  async function readSnapshot(f) {
    const corrupt = (why) => new SyncError(`The Drive copy is unreadable (${why})`, { retryable: false, code: 'corrupt' });
    if (f.size === 0) throw corrupt('empty file');
    let json;
    try { json = await download(f.id); } catch (e) { if (e instanceof SyncError) throw e; throw corrupt('not valid JSON'); }
    if (!json || typeof json !== 'object' || Array.isArray(json)) throw corrupt('not a snapshot');
    const v = json.formatVersion;
    if (v !== SNAPSHOT_FORMAT) {
      if (typeof v === 'number' && v > SNAPSHOT_FORMAT) throw new SyncError(`The Drive copy was written by a newer version of this app (format ${v}); update the app on this device to sync. It was not changed.`, { retryable: false, code: 'newer' });
      throw corrupt(`format ${JSON.stringify(v)} is not one this app understands`);
    }
    return json;
  }

  const isCorrupt = (e) => e instanceof SyncError && e.code === 'corrupt';

  // ---------- local snapshot ----------
  async function localSnapshot() {
    const [members, reports, tombstones] = await Promise.all([db.listMembers(), db.listReports(), db.listTombstones()]);
    return snapshotFromLists({ members, reports, tombstones });
  }

  function statusOf(err) {
    if (err instanceof SyncError) return { ok: false, status: err.auth ? 'needs-auth' : 'error', message: err.message, retryable: err.retryable, httpStatus: err.status, code: err.code };
    return { ok: false, status: 'error', message: err && err.message ? err.message : String(err), retryable: false };
  }

  function applyBackoff(err) {
    if (err instanceof SyncError && (err.status === 403 || err.status === 429)) {
      backoffMessage = err.message;
      backoffStep = Math.min(backoffStep + 1, 8);
      backoffUntil = nowMs() + Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (backoffStep - 1));
    }
  }

  // ---------- the sync ----------
  async function doSync({ reason = 'manual', force = false } = {}) {
    const at = now();
    const result = { ok: true, status: 'synced', message: '', notice: '', reason, at, pulled: 0, pushed: 0, pdfsUploaded: 0, pdfsDeleted: 0, duplicatesRemoved: 0, changedLocal: false, changedRemote: false, skipped: false };
    if (!isOnline()) return { ...result, ok: false, status: 'offline', message: 'Offline; will sync when back online' };
    if (!force && nowMs() < backoffUntil) return { ...result, ok: false, status: 'error', message: `${backoffMessage || 'Google Drive refused the request'}; retrying after ${new Date(backoffUntil).toISOString().slice(11, 16)} UTC`, retryable: true };
    try {
      const meta = await db.getSyncMeta();
      if (!meta.deviceId) meta.deviceId = randomId();
      const local = await localSnapshot();
      const localDigest = digest(canonicalJson({ m: local.members, r: local.reports, t: local.tombstones }));

      let files = await listAppFiles();
      let snapFile = files.get(SNAPSHOT_NAME) || null;
      const extras = snapFile ? snapFile.extras : [];
      let quarantined = 0;
      const quarantine = async (f) => { const name = corruptName(at, quarantined++); await renameFile(f.id, name); return name; };
      const pulledCount = (c) => c.members.length + c.reports.length + c.removeMembers.length + c.removeReports.length;

      // Fast path: nothing changed on either side since the last sync → only check for missing PDFs.
      const remoteUnchanged = snapFile && !extras.length && meta.snapshotDriveId === snapFile.id && meta.remoteModifiedTime && meta.remoteModifiedTime === snapFile.modifiedTime;
      let merged, localChanges, remoteChanged, remote = null;
      const absorbed = []; // duplicate snapshot ids whose content has been folded into `merged`
      if (!force && remoteUnchanged && meta.localDigest === localDigest) {
        result.skipped = true;
        merged = local; localChanges = null; remoteChanged = false;
      } else {
        if (snapFile) {
          try { remote = await readSnapshot(snapFile); } catch (e) {
            if (!isCorrupt(e)) throw e;
            // Unreadable: keep it under another name for forensics and recreate the snapshot from this device.
            const kept = await quarantine(snapFile);
            result.notice = `The Drive copy was unreadable and has been replaced from this device; the old file was kept as ${kept}`;
            snapFile = null;
          }
        }
        // Duplicate copies (same name, from a simultaneous first sync elsewhere): fold each into the remote side.
        let unionChanged = false;
        for (const x of extras) {
          let j;
          try { j = await readSnapshot(x); } catch (e) { if (isCorrupt(e)) { await quarantine(x); continue; } throw e; }
          const u = merge(remote, j, { now: at });
          if (remote == null || changeCount(u.localChanges)) unionChanged = true;
          remote = u.merged;
          absorbed.push(x.id);
        }
        ({ merged, localChanges, remoteChanged } = merge(local, remote, { now: at }));
        if (unionChanged) remoteChanged = true; // the primary does not hold the union yet
        if (changeCount(localChanges)) {
          await db.applySyncChanges(localChanges);
          result.changedLocal = true;
          result.pulled = pulledCount(localChanges);
        }
      }

      let snapId = snapFile ? snapFile.id : null;
      let snapModified = snapFile ? snapFile.modifiedTime : null;
      let created = false;
      if (remoteChanged || !snapFile) {
        const content = JSON.stringify(merged);
        const r = snapFile ? await updateFile(snapFile.id, 'application/json', content) : await createFile(SNAPSHOT_NAME, 'application/json', content);
        snapId = r && r.id ? r.id : snapId;
        snapModified = r && r.modifiedTime ? r.modifiedTime : null;
        result.changedRemote = true;
        if (snapFile) result.pushed = 1; else created = true;
      }
      // The primary now holds everything the duplicates held: remove them.
      for (const id of absorbed) if (await deleteFile(id)) result.duplicatesRemoved++;

      if (created) {
        // Another device may have created its own snapshot at the same moment. Re-list once; if several copies
        // exist, fold them all into the primary (oldest) one and delete the rest, on both sides.
        files = await listAppFiles();
        const sf = files.get(SNAPSHOT_NAME);
        if (sf && sf.extras.length) {
          const folded = []; // copies whose content is in `merged` (ours included)
          let changed = false;
          for (const f of [sf, ...sf.extras]) {
            if (f.id === snapId) { folded.push(f); continue; }
            let j;
            try { j = await readSnapshot(f); } catch (e) { if (isCorrupt(e)) { await quarantine(f); continue; } throw e; }
            const u = merge(merged, j, { now: at });
            if (changeCount(u.localChanges)) {
              await db.applySyncChanges(u.localChanges);
              result.changedLocal = true;
              result.pulled += pulledCount(u.localChanges);
              changed = true;
            }
            merged = u.merged;
            folded.push(f);
          }
          folded.sort(primaryFirst);
          const primary = folded[0];
          if (primary.id !== snapId || changed) {
            const r = await updateFile(primary.id, 'application/json', JSON.stringify(merged));
            snapModified = r && r.modifiedTime ? r.modifiedTime : null;
          }
          snapId = primary.id;
          for (const f of folded) if (f.id !== primary.id && (await deleteFile(f.id))) result.duplicatesRemoved++;
        }
      }

      // PDFs: drop duplicate copies, upload local ones Drive lacks (for reports that still exist), delete Drive
      // ones whose report is gone.
      for (const [name, f] of files) {
        if (!PDF_RE.test(name) || !f.extras.length) continue;
        for (const x of f.extras) if (await deleteFile(x.id)) result.duplicatesRemoved++;
        f.extras = [];
      }
      const localIds = new Set(await db.listFileIds());
      const liveReports = new Set(Object.keys(merged.reports));
      for (const id of localIds) {
        if (!liveReports.has(id) || files.has(pdfName(id))) continue;
        const f = await db.getFile(id);
        if (!f || !f.bytes) continue;
        const r = await createFile(pdfName(id), 'application/pdf', f.bytes instanceof Uint8Array ? f.bytes : new Uint8Array(f.bytes));
        files.set(pdfName(id), { id: r && r.id, size: f.bytes.byteLength, modifiedTime: r && r.modifiedTime, createdTime: null, extras: [] });
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
      backoffStep = 0; backoffUntil = 0; backoffMessage = '';
      result.message = result.notice ? result.notice
        : result.skipped ? 'Up to date'
          : `Synced${result.pulled ? `, ${result.pulled} pulled` : ''}${result.changedRemote ? ', uploaded' : ''}${result.pdfsUploaded ? `, ${result.pdfsUploaded} PDF${result.pdfsUploaded === 1 ? '' : 's'} uploaded` : ''}`;
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
      for (const [, f] of files) for (const e of [f, ...f.extras]) if (await deleteFile(e.id)) deleted++;
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
