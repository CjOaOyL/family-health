// Pure merge of two sync snapshots (local device vs Google Drive). No I/O, no DOM, deterministic.
//
// Snapshot {
//   formatVersion: 1, updatedAt: ISO,
//   members:    { [id]: member }        member = { id, name, dob, sex, createdAt, updatedAt }
//   reports:    { [id]: record }        record = { id, memberId, overrides, orphanedOverrides?, report, savedAt, updatedAt }
//   tombstones: { [id]: { kind: 'member'|'report', deletedAt: ISO } }
// }
//
// Rules (see docs/SYNC.md):
//   1. Union by id. For an id present on both sides the record with the newer updatedAt wins.
//   2. A tombstone newer than (or as new as) the winning record deletes it on both sides.
//   3. A record newer than the winning tombstone resurrects it: the tombstone is dropped.
//   4. Equal updatedAt on both sides with different content: the canonical JSON that sorts first wins, so the
//      result does not depend on which side is called "local".
//   5. Missing updatedAt counts as older than everything.

export const SNAPSHOT_FORMAT = 1;

const KINDS = [['members', 'member'], ['reports', 'report']];

export function emptySnapshot(updatedAt = null) {
  return { formatVersion: SNAPSHOT_FORMAT, updatedAt, members: {}, reports: {}, tombstones: {} };
}

/** Deterministic JSON: object keys sorted recursively, undefined dropped. */
export function canonicalJson(value) {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) if (v[k] !== undefined) out[k] = sortKeys(v[k]);
    return out;
  }
  return v;
}

export function deepEqual(a, b) {
  return canonicalJson(a) === canonicalJson(b);
}

function ts(v) { return typeof v === 'string' ? v : ''; }

/** Normalise any input (null, partial, arrays) into a full snapshot with plain objects keyed by id. */
export function normalizeSnapshot(snap) {
  const out = emptySnapshot(snap && typeof snap.updatedAt === 'string' ? snap.updatedAt : null);
  if (!snap || typeof snap !== 'object') return out;
  for (const [coll] of KINDS) {
    const src = snap[coll];
    if (Array.isArray(src)) { for (const r of src) if (r && r.id) out[coll][r.id] = r; }
    else if (src && typeof src === 'object') { for (const [id, r] of Object.entries(src)) if (r && typeof r === 'object') out[coll][id] = { ...r, id: r.id || id }; }
  }
  const t = snap.tombstones;
  if (Array.isArray(t)) { for (const x of t) if (x && x.id && x.kind && x.deletedAt) out.tombstones[x.id] = { kind: x.kind, deletedAt: x.deletedAt }; }
  else if (t && typeof t === 'object') { for (const [id, x] of Object.entries(t)) if (x && x.kind && x.deletedAt) out.tombstones[id] = { kind: x.kind, deletedAt: x.deletedAt }; }
  return out;
}

/** Build a snapshot from db-style arrays. */
export function snapshotFromLists({ members = [], reports = [], tombstones = [] } = {}, updatedAt = null) {
  return normalizeSnapshot({ members, reports, tombstones, updatedAt });
}

function newer(a, b) {
  // Returns the winner of two records by updatedAt; ties broken by canonical JSON (deterministic, symmetric).
  if (!a) return b; if (!b) return a;
  const ta = ts(a.updatedAt), tb = ts(b.updatedAt);
  if (ta !== tb) return ta > tb ? a : b;
  const ja = canonicalJson(a), jb = canonicalJson(b);
  return ja <= jb ? a : b;
}

/**
 * merge(local, remote, { now }) → { merged, localChanges, remoteChanged, summary }
 *   merged        the snapshot both sides should hold afterwards (updatedAt = now when it differs from remote)
 *   localChanges  { members, reports, tombstones, removeMembers, removeReports, removeTombstones } to apply locally
 *   remoteChanged true when merged differs from remote (so it must be uploaded); remote === null counts as changed
 *                 only when merged holds anything
 */
export function merge(localIn, remoteIn, { now = null } = {}) {
  const local = normalizeSnapshot(localIn);
  const hadRemote = remoteIn != null;
  const remote = normalizeSnapshot(remoteIn);
  const merged = emptySnapshot(remote.updatedAt);
  const localChanges = { members: [], reports: [], tombstones: [], removeMembers: [], removeReports: [], removeTombstones: [] };
  const summary = { kept: 0, pulled: 0, pushed: 0, deletedLocally: 0, deletedRemotely: 0, resurrected: 0 };

  for (const [coll, kind] of KINDS) {
    const ids = new Set([
      ...Object.keys(local[coll]), ...Object.keys(remote[coll]),
      ...Object.entries(local.tombstones).filter(([, t]) => t.kind === kind).map(([id]) => id),
      ...Object.entries(remote.tombstones).filter(([, t]) => t.kind === kind).map(([id]) => id),
    ]);
    for (const id of [...ids].sort()) {
      const lr = local[coll][id] || null, rr = remote[coll][id] || null;
      const lt = local.tombstones[id] && local.tombstones[id].kind === kind ? local.tombstones[id] : null;
      const rt = remote.tombstones[id] && remote.tombstones[id].kind === kind ? remote.tombstones[id] : null;
      const rec = newer(lr, rr);
      let tomb = null;
      if (lt || rt) tomb = !lt ? rt : !rt ? lt : (ts(lt.deletedAt) >= ts(rt.deletedAt) ? lt : rt);

      let keepRec = null, keepTomb = null;
      if (rec && tomb) {
        if (ts(tomb.deletedAt) >= ts(rec.updatedAt)) keepTomb = tomb; else { keepRec = rec; summary.resurrected++; }
      } else if (rec) keepRec = rec;
      else keepTomb = tomb;

      if (keepRec) {
        merged[coll][id] = keepRec;
        if (!lr || !deepEqual(lr, keepRec)) { localChanges[coll].push(keepRec); if (rr && deepEqual(rr, keepRec)) summary.pulled++; }
        else if (!rr || !deepEqual(rr, keepRec)) summary.pushed++;
        else summary.kept++;
        if (lt) localChanges.removeTombstones.push(id);
      } else if (keepTomb) {
        merged.tombstones[id] = { kind, deletedAt: keepTomb.deletedAt };
        if (lr) { localChanges[coll === 'members' ? 'removeMembers' : 'removeReports'].push(id); summary.deletedLocally++; }
        if (rr) summary.deletedRemotely++;
        if (!lt || !deepEqual(lt, merged.tombstones[id])) localChanges.tombstones.push({ id, kind, deletedAt: keepTomb.deletedAt });
      }
    }
  }

  const body = (s) => ({ members: s.members, reports: s.reports, tombstones: s.tombstones });
  const remoteChanged = hadRemote ? !deepEqual(body(merged), body(remote)) : hasContent(merged);
  if (remoteChanged) merged.updatedAt = now || merged.updatedAt || null;
  return { merged, localChanges, remoteChanged, summary };
}

export function hasContent(snap) {
  return Object.keys(snap.members).length + Object.keys(snap.reports).length + Object.keys(snap.tombstones).length > 0;
}

export function changeCount(localChanges) {
  return Object.values(localChanges).reduce((n, arr) => n + (Array.isArray(arr) ? arr.length : 0), 0);
}
