// IndexedDB wrapper for family-health. Promise-based, no library, browser-only.
// Stores:
//   reports  { id = fileHash, memberId, overrides: {fieldPath: value}, orphanedOverrides?: [...], report: LabReport, savedAt, updatedAt }
//            Result overrides are keyed by a stable result key: 'results[<firstLineId>|<normalizedName>].<field>'
//            (see app/reportUtil.js); header overrides use plain dotted paths ('patient.dob').
//   members  { id, name, dob, sex, createdAt }
//   files    { id = fileHash, bytes: ArrayBuffer, fileName }
//   settings { key, value }
//   tombstones { id, kind: 'member'|'report', deletedAt }   (v2) a delete leaves a tombstone so Drive sync can
//            propagate it to other devices; a later write of the same id removes the tombstone (resurrect).
//
// Version history:
//   1  reports, members, files, settings
//   2  + tombstones store; every member gets updatedAt (= createdAt or migration time); every report gets
//      updatedAt (= existing updatedAt, else savedAt, else migration time). Sync merges by updatedAt.

export const DB_NAME = 'family-health';
export const DB_VERSION = 2;
export const STORES = ['reports', 'members', 'files', 'settings', 'tombstones'];

let dbPromise = null;

function upgrade(db, oldVersion, txn) {
  if (!db.objectStoreNames.contains('reports')) {
    const s = db.createObjectStore('reports', { keyPath: 'id' });
    s.createIndex('memberId', 'memberId', { unique: false });
  }
  if (!db.objectStoreNames.contains('members')) db.createObjectStore('members', { keyPath: 'id' });
  if (!db.objectStoreNames.contains('files')) db.createObjectStore('files', { keyPath: 'id' });
  if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath: 'key' });
  if (!db.objectStoreNames.contains('tombstones')) {
    const t = db.createObjectStore('tombstones', { keyPath: 'id' });
    t.createIndex('kind', 'kind', { unique: false });
  }
  if (oldVersion > 0 && oldVersion < 2 && txn) {
    // v1 -> v2: stamp updatedAt on every existing member and report so the sync merge can order them.
    const stamp = nowIso();
    const walk = (store, fn) => {
      const req = store.openCursor();
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur) return;
        const v = cur.value;
        if (fn(v)) cur.update(v);
        cur.continue();
      };
    };
    walk(txn.objectStore('members'), (m) => { if (!m.updatedAt) { m.updatedAt = m.createdAt || stamp; return true; } return false; });
    walk(txn.objectStore('reports'), (r) => { if (!r.updatedAt) { r.updatedAt = r.savedAt || stamp; return true; } return false; });
  }
}

export function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('IndexedDB is not available in this browser')); return; }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => upgrade(req.result, e.oldVersion || 0, req.transaction);
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => { db.close(); dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => reject(req.error || new Error('Failed to open IndexedDB'));
    req.onblocked = () => reject(new Error('IndexedDB open blocked by another tab'));
  });
  dbPromise.catch(() => { dbPromise = null; });
  return dbPromise;
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB request failed'));
  });
}

async function tx(storeNames, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(storeNames, mode);
    const stores = Array.isArray(storeNames) ? storeNames.map((n) => t.objectStore(n)) : t.objectStore(storeNames);
    let result;
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error || new Error('IndexedDB transaction failed'));
    t.onabort = () => reject(t.error || new Error('IndexedDB transaction aborted'));
    Promise.resolve(fn(stores, t)).then((r) => { result = r; }).catch((e) => { try { t.abort(); } catch { /* ignore */ } reject(e); });
  });
}

function nowIso() { return new Date().toISOString(); }

// ---------- reports ----------

/**
 * Store a report record. Accepts either a full record { id, memberId, overrides, report, ... }
 * or a bare LabReport (wrapped automatically).
 */
export async function putReport(rec) {
  if (!rec || typeof rec !== 'object') throw new Error('putReport: record required');
  let record = rec;
  if (!rec.report && rec.results && rec.source) {
    record = { id: rec.id, memberId: rec.patient?.memberId ?? null, overrides: {}, report: rec };
  }
  if (!record.id) record.id = record.report?.id || record.report?.source?.fileHash;
  if (!record.id) throw new Error('putReport: record has no id (fileHash)');
  record = {
    ...record,
    memberId: record.memberId ?? null,
    overrides: record.overrides && typeof record.overrides === 'object' ? record.overrides : {},
    savedAt: record.savedAt || nowIso(),
    updatedAt: nowIso(),
  };
  // Never persist transient in-memory fields.
  delete record.doc; delete record.bytes; delete record.error; delete record.stored;
  // Writing a record resurrects it: drop any tombstone with the same id.
  await tx(['reports', 'tombstones'], 'readwrite', async ([s, t]) => { await reqToPromise(s.put(record)); await reqToPromise(t.delete(record.id)); });
  return record;
}

export function getReport(id) {
  return tx('reports', 'readonly', (s) => reqToPromise(s.get(id))).then((r) => r || null);
}

/** List report records, optionally only those assigned to memberId. Sorted by collectedAt desc. */
export async function listReports(memberId) {
  const rows = await tx('reports', 'readonly', (s) => {
    if (memberId != null && memberId !== '') return reqToPromise(s.index('memberId').getAll(memberId));
    return reqToPromise(s.getAll());
  });
  const key = (r) => r.report?.specimen?.collectedAt || r.report?.specimen?.reportedAt || r.savedAt || '';
  return (rows || []).sort((a, b) => (key(a) < key(b) ? 1 : key(a) > key(b) ? -1 : 0));
}

/** Delete a report and leave a tombstone so the deletion syncs to other devices. */
export function deleteReport(id) {
  const deletedAt = nowIso();
  return tx(['reports', 'tombstones'], 'readwrite', async ([s, t]) => {
    await reqToPromise(s.delete(id));
    await reqToPromise(t.put({ id, kind: 'report', deletedAt }));
  });
}

// ---------- members ----------

export async function putMember(m) {
  if (!m || typeof m !== 'object') throw new Error('putMember: member required');
  const member = {
    id: m.id || (globalThis.crypto && crypto.randomUUID ? crypto.randomUUID() : 'm-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)),
    name: m.name || '',
    dob: m.dob ?? null,
    sex: m.sex ?? null,
    createdAt: m.createdAt || nowIso(),
    updatedAt: nowIso(),
  };
  await tx(['members', 'tombstones'], 'readwrite', async ([s, t]) => { await reqToPromise(s.put(member)); await reqToPromise(t.delete(member.id)); });
  return member;
}

export async function getMember(id) {
  return tx('members', 'readonly', (s) => reqToPromise(s.get(id))).then((r) => r || null);
}

export async function listMembers() {
  const rows = await tx('members', 'readonly', (s) => reqToPromise(s.getAll()));
  return (rows || []).sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

/** Delete a member (leaving a tombstone); reports assigned to it become unassigned (memberId = null). */
export function deleteMember(id) {
  const at = nowIso();
  return tx(['members', 'reports', 'tombstones'], 'readwrite', async ([members, reports, tombs]) => {
    await reqToPromise(members.delete(id));
    await reqToPromise(tombs.put({ id, kind: 'member', deletedAt: at }));
    const assigned = await reqToPromise(reports.index('memberId').getAll(id));
    for (const r of assigned || []) { r.memberId = null; r.updatedAt = at; await reqToPromise(reports.put(r)); }
  });
}

/** Reassign every report from one member to another and delete the source member (tombstoned). */
export function mergeMembers(fromId, intoId) {
  if (fromId === intoId) return Promise.resolve();
  const at = nowIso();
  return tx(['members', 'reports', 'tombstones'], 'readwrite', async ([members, reports, tombs]) => {
    const assigned = await reqToPromise(reports.index('memberId').getAll(fromId));
    for (const r of assigned || []) { r.memberId = intoId; if (r.report?.patient) r.report.patient.memberId = intoId; r.updatedAt = at; await reqToPromise(reports.put(r)); }
    await reqToPromise(members.delete(fromId));
    await reqToPromise(tombs.put({ id: fromId, kind: 'member', deletedAt: at }));
  });
}

// ---------- tombstones + sync metadata ----------

export async function listTombstones() {
  const rows = await tx('tombstones', 'readonly', (s) => reqToPromise(s.getAll()));
  return rows || [];
}

const SYNC_META_KEY = 'syncMeta';

/** { lastSyncAt, snapshotDriveId, deviceId, remoteModifiedTime, localDigest } - never exported in backups. */
export async function getSyncMeta() {
  const m = await getSetting(SYNC_META_KEY, null);
  return m && typeof m === 'object' ? { ...m } : { lastSyncAt: null, snapshotDriveId: null, deviceId: null };
}

export async function setSyncMeta(patch) {
  const cur = await getSyncMeta();
  const next = { ...cur, ...(patch || {}) };
  await setSetting(SYNC_META_KEY, next);
  return next;
}

/** True when the record already stored is newer than the incoming one (it was edited while a sync was computing). */
export function isStoredNewer(stored, incoming) {
  return !!stored && String(stored.updatedAt || '') > String((incoming && incoming.updatedAt) || '');
}

/**
 * Apply the result of a sync merge in one transaction WITHOUT re-stamping updatedAt (the timestamps come
 * from whichever device made the change). Removing a report also drops its stored PDF.
 * A record edited on this device after the sync read it (stored updatedAt newer than the incoming record or
 * tombstone) is left alone; the next sync pushes it. Otherwise the edit would be silently overwritten.
 * changes: { members: [], reports: [], tombstones: [], removeMembers: [], removeReports: [], removeTombstones: [] }
 */
export function applySyncChanges(changes = {}) {
  const c = {
    members: changes.members || [], reports: changes.reports || [], tombstones: changes.tombstones || [],
    removeMembers: changes.removeMembers || [], removeReports: changes.removeReports || [], removeTombstones: changes.removeTombstones || [],
  };
  const n = c.members.length + c.reports.length + c.tombstones.length + c.removeMembers.length + c.removeReports.length + c.removeTombstones.length;
  if (!n) return Promise.resolve(0);
  return tx(['members', 'reports', 'tombstones', 'files'], 'readwrite', async ([ms, rs, ts, fs]) => {
    const kept = new Set(); // ids whose stored record out-dates the incoming change
    for (const m of c.members) {
      if (!m || !m.id) continue;
      if (isStoredNewer(await reqToPromise(ms.get(m.id)), m)) { kept.add(m.id); continue; }
      await reqToPromise(ms.put(m));
    }
    for (const r of c.reports) {
      if (!r || !r.id || !r.report) continue;
      if (isStoredNewer(await reqToPromise(rs.get(r.id)), r)) { kept.add(r.id); continue; }
      const rec = { ...r, overrides: r.overrides && typeof r.overrides === 'object' ? r.overrides : {}, memberId: r.memberId ?? null };
      delete rec.doc; delete rec.bytes; delete rec.error; delete rec.stored;
      await reqToPromise(rs.put(rec));
    }
    const tombAt = new Map(c.tombstones.filter((t) => t && t.id && t.deletedAt).map((t) => [t.id, t.deletedAt]));
    for (const id of c.removeMembers) {
      if (isStoredNewer(await reqToPromise(ms.get(id)), { updatedAt: tombAt.get(id) })) { kept.add(id); continue; }
      await reqToPromise(ms.delete(id));
    }
    for (const id of c.removeReports) {
      if (isStoredNewer(await reqToPromise(rs.get(id)), { updatedAt: tombAt.get(id) })) { kept.add(id); continue; }
      await reqToPromise(rs.delete(id)); await reqToPromise(fs.delete(id));
    }
    for (const t of c.tombstones) if (t && t.id && t.kind && t.deletedAt && !kept.has(t.id)) await reqToPromise(ts.put({ id: t.id, kind: t.kind, deletedAt: t.deletedAt }));
    for (const id of c.removeTombstones) await reqToPromise(ts.delete(id));
    return n;
  });
}

// ---------- files ----------

export async function putFile({ id, bytes, fileName }) {
  if (!id) throw new Error('putFile: id required');
  let buf = bytes;
  if (buf instanceof Uint8Array) buf = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  if (!(buf instanceof ArrayBuffer)) throw new Error('putFile: bytes must be ArrayBuffer or Uint8Array');
  await tx('files', 'readwrite', (s) => reqToPromise(s.put({ id, bytes: buf, fileName: fileName || null, size: buf.byteLength, savedAt: nowIso() })));
  return id;
}

export function getFile(id) {
  return tx('files', 'readonly', (s) => reqToPromise(s.get(id))).then((r) => r || null);
}

export function deleteFile(id) {
  return tx('files', 'readwrite', (s) => reqToPromise(s.delete(id)));
}

export async function listFileIds() {
  const keys = await tx('files', 'readonly', (s) => reqToPromise(s.getAllKeys()));
  return keys || [];
}

export async function listFileMeta() {
  const rows = await tx('files', 'readonly', (s) => reqToPromise(s.getAll()));
  return (rows || []).map((r) => ({ id: r.id, fileName: r.fileName, size: r.size ?? (r.bytes ? r.bytes.byteLength : 0) }));
}

// ---------- settings ----------

export async function getSetting(key, fallback = undefined) {
  const r = await tx('settings', 'readonly', (s) => reqToPromise(s.get(key)));
  return r ? r.value : fallback;
}

export async function setSetting(key, value) {
  await tx('settings', 'readwrite', (s) => reqToPromise(s.put({ key, value })));
  return value;
}

export async function listSettings() {
  const rows = await tx('settings', 'readonly', (s) => reqToPromise(s.getAll()));
  return rows || [];
}

// ---------- backup ----------

function bufToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return btoa(s);
}

function base64ToBuf(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out.buffer;
}

/**
 * Settings that may travel in a backup. Allow-list, not deny-list: anything else in the settings store
 * (e.g. a future assist API key) must never land in an exported file or be imported from one.
 */
export const EXPORTABLE_SETTINGS = ['keepFiles'];

/** JSON-able snapshot of everything. Files are included as base64 when includeFiles is true. */
export async function exportAll({ includeFiles = false } = {}) {
  const [reports, members, settings, tombstones] = await Promise.all([
    tx('reports', 'readonly', (s) => reqToPromise(s.getAll())),
    tx('members', 'readonly', (s) => reqToPromise(s.getAll())),
    tx('settings', 'readonly', (s) => reqToPromise(s.getAll())),
    tx('tombstones', 'readonly', (s) => reqToPromise(s.getAll())),
  ]);
  const out = {
    app: 'family-health',
    formatVersion: 1,
    exportedAt: nowIso(),
    members: members || [],
    reports: reports || [],
    tombstones: tombstones || [],
    settings: (settings || []).filter((s) => s && EXPORTABLE_SETTINGS.includes(s.key)).map((s) => ({ key: s.key, value: s.value })),
  };
  if (includeFiles) {
    const files = await tx('files', 'readonly', (s) => reqToPromise(s.getAll()));
    out.files = (files || []).map((f) => ({ id: f.id, fileName: f.fileName || null, bytesBase64: bufToBase64(f.bytes) }));
  }
  return out;
}

/**
 * Import a backup object. merge=true (default) upserts; merge=false clears everything first.
 * Returns counts.
 */
export async function importAll(obj, { merge = true } = {}) {
  if (!obj || typeof obj !== 'object') throw new Error('importAll: not a backup object');
  if (obj.app && obj.app !== 'family-health') throw new Error(`importAll: unexpected app "${obj.app}"`);
  const members = Array.isArray(obj.members) ? obj.members : [];
  const reports = Array.isArray(obj.reports) ? obj.reports : [];
  const settings = Array.isArray(obj.settings) ? obj.settings : [];
  const files = Array.isArray(obj.files) ? obj.files : [];
  const tombstones = Array.isArray(obj.tombstones) ? obj.tombstones : [];
  if (!merge) await clearAll();
  const counts = { members: 0, reports: 0, settings: 0, files: 0, tombstones: 0, skipped: 0 };
  const at = nowIso();
  await tx(['members', 'reports', 'settings', 'tombstones', 'files'], 'readwrite', async ([ms, rs, ss, ts, fs]) => {
    // Imported records are stamped "now": a restored backup wins over older copies on other devices.
    for (const m of members) { if (m && m.id) { await reqToPromise(ms.put({ ...m, updatedAt: at })); await reqToPromise(ts.delete(m.id)); counts.members++; } else counts.skipped++; }
    for (const r of reports) {
      let rec = r;
      if (rec && !rec.report && rec.results && rec.source) rec = { id: rec.id, memberId: rec.patient?.memberId ?? null, overrides: {}, report: rec };
      if (rec && rec.id && rec.report) {
        rec = { ...rec, overrides: rec.overrides || {}, memberId: rec.memberId ?? null, savedAt: rec.savedAt || at, updatedAt: at };
        delete rec.doc; delete rec.bytes;
        await reqToPromise(rs.put(rec)); await reqToPromise(ts.delete(rec.id)); counts.reports++;
      } else counts.skipped++;
    }
    for (const s of settings) { if (s && s.key && EXPORTABLE_SETTINGS.includes(s.key)) { await reqToPromise(ss.put({ key: s.key, value: s.value })); counts.settings++; } else counts.skipped++; }
    // Tombstones: keep the newer of local/backup, and never shadow a record the backup itself restores.
    // Against a record that exists on this device: the tombstone deletes it (and its PDF) when the record is not
    // newer than the deletion; a newer local record wins and the tombstone is dropped. Never both side by side.
    const restored = new Set(members.map((m) => m && m.id).concat(reports.map((r) => r && r.id)));
    for (const t of tombstones) {
      if (!t || !t.id || !t.kind || !t.deletedAt || restored.has(t.id) || (t.kind !== 'member' && t.kind !== 'report')) { counts.skipped++; continue; }
      const store = t.kind === 'member' ? ms : rs;
      const live = await reqToPromise(store.get(t.id));
      if (live) {
        if (String(live.updatedAt || '') > String(t.deletedAt)) { counts.skipped++; continue; }
        await reqToPromise(store.delete(t.id));
        if (t.kind === 'report') await reqToPromise(fs.delete(t.id));
      }
      const cur = await reqToPromise(ts.get(t.id));
      if (cur && cur.deletedAt >= t.deletedAt) continue;
      await reqToPromise(ts.put({ id: t.id, kind: t.kind, deletedAt: t.deletedAt })); counts.tombstones++;
    }
  });
  if (files.length) {
    await tx('files', 'readwrite', async (fs) => {
      for (const f of files) {
        if (f && f.id && typeof f.bytesBase64 === 'string') {
          const bytes = base64ToBuf(f.bytesBase64);
          await reqToPromise(fs.put({ id: f.id, bytes, fileName: f.fileName || null, size: bytes.byteLength, savedAt: nowIso() }));
          counts.files++;
        } else counts.skipped++;
      }
    });
  }
  return counts;
}

/** Settings keys used by Drive sync (app/sync.js). Kept here so clearAll knows about them. */
export const CLIENT_ID_SETTING = 'googleClientId';
export const DRIVE_CONNECTED_SETTING = 'driveConnected';

/**
 * Wipe every store on this device. The Google OAuth Client ID (a configuration value, not family data)
 * survives so the user does not have to paste it again; the Drive connection flag and sync metadata do not.
 */
export function clearAll() {
  return tx(STORES, 'readwrite', async (stores) => {
    const settings = stores[STORES.indexOf('settings')];
    const keep = await reqToPromise(settings.get(CLIENT_ID_SETTING));
    for (const s of stores) await reqToPromise(s.clear());
    if (keep && keep.value) await reqToPromise(settings.put(keep));
  });
}

export async function counts() {
  const [r, m, f] = await Promise.all([
    tx('reports', 'readonly', (s) => reqToPromise(s.count())),
    tx('members', 'readonly', (s) => reqToPromise(s.count())),
    tx('files', 'readonly', (s) => reqToPromise(s.count())),
  ]);
  return { reports: r, members: m, files: f };
}
