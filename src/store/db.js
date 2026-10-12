// IndexedDB wrapper for family-health. Promise-based, no library, browser-only.
// Stores:
//   reports  { id = fileHash, memberId, overrides: {fieldPath: value}, orphanedOverrides?: [...], report: LabReport, savedAt, updatedAt }
//            Result overrides are keyed by a stable result key: 'results[<firstLineId>|<normalizedName>].<field>'
//            (see app/reportUtil.js); header overrides use plain dotted paths ('patient.dob').
//   members  { id, name, dob, sex, createdAt }
//   files    { id = fileHash, bytes: ArrayBuffer, fileName }
//   settings { key, value }

export const DB_NAME = 'family-health';
export const DB_VERSION = 1;
export const STORES = ['reports', 'members', 'files', 'settings'];

let dbPromise = null;

function upgrade(db) {
  if (!db.objectStoreNames.contains('reports')) {
    const s = db.createObjectStore('reports', { keyPath: 'id' });
    s.createIndex('memberId', 'memberId', { unique: false });
  }
  if (!db.objectStoreNames.contains('members')) db.createObjectStore('members', { keyPath: 'id' });
  if (!db.objectStoreNames.contains('files')) db.createObjectStore('files', { keyPath: 'id' });
  if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath: 'key' });
}

export function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('IndexedDB is not available in this browser')); return; }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => upgrade(req.result);
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
  await tx('reports', 'readwrite', (s) => reqToPromise(s.put(record)));
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

export function deleteReport(id) {
  return tx('reports', 'readwrite', (s) => reqToPromise(s.delete(id)));
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
  };
  await tx('members', 'readwrite', (s) => reqToPromise(s.put(member)));
  return member;
}

export async function getMember(id) {
  return tx('members', 'readonly', (s) => reqToPromise(s.get(id))).then((r) => r || null);
}

export async function listMembers() {
  const rows = await tx('members', 'readonly', (s) => reqToPromise(s.getAll()));
  return (rows || []).sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

/** Delete a member; reports assigned to it become unassigned (memberId = null). */
export function deleteMember(id) {
  return tx(['members', 'reports'], 'readwrite', async ([members, reports]) => {
    await reqToPromise(members.delete(id));
    const assigned = await reqToPromise(reports.index('memberId').getAll(id));
    for (const r of assigned || []) { r.memberId = null; await reqToPromise(reports.put(r)); }
  });
}

/** Reassign every report from one member to another and delete the source member. */
export function mergeMembers(fromId, intoId) {
  if (fromId === intoId) return Promise.resolve();
  return tx(['members', 'reports'], 'readwrite', async ([members, reports]) => {
    const assigned = await reqToPromise(reports.index('memberId').getAll(fromId));
    for (const r of assigned || []) { r.memberId = intoId; if (r.report?.patient) r.report.patient.memberId = intoId; await reqToPromise(reports.put(r)); }
    await reqToPromise(members.delete(fromId));
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
  const [reports, members, settings] = await Promise.all([
    tx('reports', 'readonly', (s) => reqToPromise(s.getAll())),
    tx('members', 'readonly', (s) => reqToPromise(s.getAll())),
    tx('settings', 'readonly', (s) => reqToPromise(s.getAll())),
  ]);
  const out = {
    app: 'family-health',
    formatVersion: 1,
    exportedAt: nowIso(),
    members: members || [],
    reports: reports || [],
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
  if (!merge) await clearAll();
  const counts = { members: 0, reports: 0, settings: 0, files: 0, skipped: 0 };
  await tx(['members', 'reports', 'settings'], 'readwrite', async ([ms, rs, ss]) => {
    for (const m of members) { if (m && m.id) { await reqToPromise(ms.put(m)); counts.members++; } else counts.skipped++; }
    for (const r of reports) {
      let rec = r;
      if (rec && !rec.report && rec.results && rec.source) rec = { id: rec.id, memberId: rec.patient?.memberId ?? null, overrides: {}, report: rec };
      if (rec && rec.id && rec.report) {
        rec = { ...rec, overrides: rec.overrides || {}, memberId: rec.memberId ?? null, savedAt: rec.savedAt || nowIso(), updatedAt: nowIso() };
        delete rec.doc; delete rec.bytes;
        await reqToPromise(rs.put(rec)); counts.reports++;
      } else counts.skipped++;
    }
    for (const s of settings) { if (s && s.key && EXPORTABLE_SETTINGS.includes(s.key)) { await reqToPromise(ss.put({ key: s.key, value: s.value })); counts.settings++; } else counts.skipped++; }
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

export function clearAll() {
  return tx(STORES, 'readwrite', async (stores) => { for (const s of stores) await reqToPromise(s.clear()); });
}

export async function counts() {
  const [r, m, f] = await Promise.all([
    tx('reports', 'readonly', (s) => reqToPromise(s.count())),
    tx('members', 'readonly', (s) => reqToPromise(s.count())),
    tx('files', 'readonly', (s) => reqToPromise(s.count())),
  ]);
  return { reports: r, members: m, files: f };
}
