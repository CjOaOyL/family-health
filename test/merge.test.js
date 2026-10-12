import { test } from 'node:test';
import assert from 'node:assert/strict';
import { merge, normalizeSnapshot, snapshotFromLists, canonicalJson, changeCount, emptySnapshot } from '../src/sync/merge.js';

const T = (n) => `2026-01-01T00:00:${String(n).padStart(2, '0')}.000Z`;
const member = (id, name, t) => ({ id, name, dob: null, sex: null, createdAt: T(0), updatedAt: T(t) });
const report = (id, memberId, t, extra = {}) => ({ id, memberId, overrides: {}, report: { id, results: [] }, savedAt: T(0), updatedAt: T(t), ...extra });
const snap = (members = [], reports = [], tombstones = [], updatedAt = null) => snapshotFromLists({ members, reports, tombstones }, updatedAt);
const NOW = T(50);

test('merge: both sides empty → nothing to do, nothing to upload', () => {
  const r = merge(snap(), snap(), { now: NOW });
  assert.equal(changeCount(r.localChanges), 0);
  assert.equal(r.remoteChanged, false);
  assert.deepEqual(r.merged.members, {});
  assert.deepEqual(r.merged.reports, {});
});

test('merge: remote null (first sync) uploads everything local, changes nothing locally', () => {
  const local = snap([member('m1', 'Ann', 1)], [report('r1', 'm1', 2)]);
  const r = merge(local, null, { now: NOW });
  assert.equal(changeCount(r.localChanges), 0);
  assert.equal(r.remoteChanged, true);
  assert.deepEqual(Object.keys(r.merged.members), ['m1']);
  assert.deepEqual(Object.keys(r.merged.reports), ['r1']);
  assert.equal(r.merged.updatedAt, NOW);
  assert.equal(r.merged.formatVersion, 1);
});

test('merge: empty local, populated remote → pull everything, remote unchanged', () => {
  const remote = snap([member('m1', 'Ann', 1)], [report('r1', 'm1', 2)], [], T(3));
  const r = merge(snap(), remote, { now: NOW });
  assert.equal(r.remoteChanged, false);
  assert.deepEqual(r.localChanges.members.map((m) => m.id), ['m1']);
  assert.deepEqual(r.localChanges.reports.map((x) => x.id), ['r1']);
  assert.equal(r.merged.updatedAt, T(3), 'updatedAt kept from remote when nothing changes remotely');
});

test('merge: newer updatedAt wins in each direction', () => {
  const local = snap([member('m1', 'Ann (local newer)', 5), member('m2', 'Bob (local older)', 1)]);
  const remote = snap([member('m1', 'Ann (remote older)', 3), member('m2', 'Bob (remote newer)', 4)]);
  const r = merge(local, remote, { now: NOW });
  assert.equal(r.merged.members.m1.name, 'Ann (local newer)');
  assert.equal(r.merged.members.m2.name, 'Bob (remote newer)');
  assert.deepEqual(r.localChanges.members.map((m) => m.id), ['m2'], 'only the remote-won record is applied locally');
  assert.equal(r.remoteChanged, true, 'the local-won record must be uploaded');
});

test('merge: identical content on both sides → no changes either way', () => {
  const a = snap([member('m1', 'Ann', 1)], [report('r1', 'm1', 2)], [], T(9));
  const b = snap([member('m1', 'Ann', 1)], [report('r1', 'm1', 2)], [], T(9));
  const r = merge(a, b, { now: NOW });
  assert.equal(changeCount(r.localChanges), 0);
  assert.equal(r.remoteChanged, false);
});

test('merge: tombstone newer than the record deletes it on both sides', () => {
  const local = snap([member('m1', 'Ann', 1)], [report('r1', 'm1', 2)]);
  const remote = snap([member('m1', 'Ann', 1)], [], [{ id: 'r1', kind: 'report', deletedAt: T(3) }]);
  const r = merge(local, remote, { now: NOW });
  assert.deepEqual(r.localChanges.removeReports, ['r1']);
  assert.ok(!('r1' in r.merged.reports));
  assert.deepEqual(r.merged.tombstones.r1, { kind: 'report', deletedAt: T(3) });
  assert.deepEqual(r.localChanges.tombstones, [{ id: 'r1', kind: 'report', deletedAt: T(3) }], 'tombstone is written locally too');
  assert.equal(r.remoteChanged, false);
});

test('merge: local tombstone newer than remote record removes it from the merged (remote) snapshot', () => {
  const local = snap([], [], [{ id: 'r1', kind: 'report', deletedAt: T(5) }]);
  const remote = snap([], [report('r1', null, 2)]);
  const r = merge(local, remote, { now: NOW });
  assert.ok(!('r1' in r.merged.reports));
  assert.equal(r.remoteChanged, true);
  assert.equal(changeCount(r.localChanges), 0);
  assert.equal(r.summary.deletedRemotely, 1);
});

test('merge: a record newer than the tombstone resurrects it and drops the tombstone', () => {
  const local = snap([], [], [{ id: 'm1', kind: 'member', deletedAt: T(2) }]);
  const remote = snap([member('m1', 'Ann again', 4)]);
  const r = merge(local, remote, { now: NOW });
  assert.equal(r.merged.members.m1.name, 'Ann again');
  assert.ok(!('m1' in r.merged.tombstones));
  assert.deepEqual(r.localChanges.members.map((m) => m.id), ['m1']);
  assert.deepEqual(r.localChanges.removeTombstones, ['m1']);
  assert.equal(r.remoteChanged, false, 'Drive never held the stale tombstone, so it needs no rewrite');
  assert.equal(r.summary.resurrected, 1);
  // Mirror: the stale tombstone is in Drive and the newer record is local → Drive must be rewritten.
  const r2 = merge(remote, local, { now: NOW });
  assert.equal(r2.merged.members.m1.name, 'Ann again');
  assert.ok(!('m1' in r2.merged.tombstones));
  assert.equal(r2.remoteChanged, true);
  assert.equal(changeCount(r2.localChanges), 0);
});

test('merge: tombstone ordering — the newer of two tombstones is kept', () => {
  const local = snap([], [], [{ id: 'r1', kind: 'report', deletedAt: T(7) }]);
  const remote = snap([], [], [{ id: 'r1', kind: 'report', deletedAt: T(3) }]);
  const r = merge(local, remote, { now: NOW });
  assert.equal(r.merged.tombstones.r1.deletedAt, T(7));
  assert.equal(r.remoteChanged, true);
  const r2 = merge(remote, local, { now: NOW });
  assert.equal(r2.merged.tombstones.r1.deletedAt, T(7));
  assert.deepEqual(r2.localChanges.tombstones, [{ id: 'r1', kind: 'report', deletedAt: T(7) }]);
});

test('merge: tombstone with the same timestamp as the record wins (delete is deliberate)', () => {
  const local = snap([member('m1', 'Ann', 4)]);
  const remote = snap([], [], [{ id: 'm1', kind: 'member', deletedAt: T(4) }]);
  const r = merge(local, remote, { now: NOW });
  assert.ok(!('m1' in r.merged.members));
  assert.deepEqual(r.localChanges.removeMembers, ['m1']);
});

test('merge: equal timestamps, different content → deterministic and symmetric tie-break', () => {
  const a = snap([member('m1', 'Ann B', 4)]);
  const b = snap([member('m1', 'Ann A', 4)]);
  const ab = merge(a, b, { now: NOW });
  const ba = merge(b, a, { now: NOW });
  assert.equal(canonicalJson(ab.merged.members), canonicalJson(ba.merged.members), 'same winner whichever side is local');
  const winner = ab.merged.members.m1.name;
  assert.ok(winner === 'Ann A' || winner === 'Ann B');
  // Exactly one side has to change.
  assert.equal(changeCount(ab.localChanges) + changeCount(ba.localChanges), 1);
});

test('merge: ids are processed in sorted order so output is stable regardless of input order', () => {
  const l1 = snap([member('b', 'B', 1), member('a', 'A', 1)]);
  const l2 = snap([member('a', 'A', 1), member('b', 'B', 1)]);
  const r1 = merge(l1, null, { now: NOW });
  const r2 = merge(l2, null, { now: NOW });
  assert.equal(JSON.stringify(r1.merged), JSON.stringify(r2.merged));
  assert.deepEqual(Object.keys(r1.merged.members), ['a', 'b']);
});

test('merge: a record without updatedAt is older than anything with one', () => {
  const local = snap([{ id: 'm1', name: 'legacy', dob: null, sex: null }]);
  const remote = snap([member('m1', 'stamped', 1)]);
  const r = merge(local, remote, { now: NOW });
  assert.equal(r.merged.members.m1.name, 'stamped');
  const r2 = merge(local, snap([], [], [{ id: 'm1', kind: 'member', deletedAt: T(1) }]), { now: NOW });
  assert.ok(!('m1' in r2.merged.members), 'tombstone beats an unstamped record');
});

test('merge: tombstones of a different kind do not affect a record with the same id', () => {
  const local = snap([member('x', 'Ann', 1)]);
  const remote = snap([], [], [{ id: 'x', kind: 'report', deletedAt: T(9) }]);
  const r = merge(local, remote, { now: NOW });
  assert.equal(r.merged.members.x.name, 'Ann');
  assert.deepEqual(r.merged.tombstones.x, { kind: 'report', deletedAt: T(9) });
});

test('merge: report fields (overrides, memberId, orphanedOverrides) travel intact; PDFs are not in the snapshot', () => {
  const rec = report('r1', 'm1', 3, { overrides: { 'patient.dob': '1980-01-15' }, orphanedOverrides: [{ path: 'x' }], bytes: 'should not be here' });
  const r = merge(snap([], [rec]), snap(), { now: NOW });
  assert.deepEqual(r.merged.reports.r1.overrides, { 'patient.dob': '1980-01-15' });
  assert.equal(r.merged.reports.r1.memberId, 'm1');
  assert.deepEqual(r.merged.reports.r1.orphanedOverrides, [{ path: 'x' }]);
  assert.ok(!JSON.stringify(emptySnapshot()).includes('files'));
});

test('normalizeSnapshot: accepts arrays or id-keyed objects, drops malformed entries', () => {
  const s = normalizeSnapshot({ members: [{ id: 'a' }, null, { name: 'no id' }], reports: { r1: { memberId: null } }, tombstones: [{ id: 't', kind: 'member', deletedAt: T(1) }, { id: 'bad' }] });
  assert.deepEqual(Object.keys(s.members), ['a']);
  assert.equal(s.reports.r1.id, 'r1');
  assert.deepEqual(Object.keys(s.tombstones), ['t']);
  assert.equal(normalizeSnapshot(null).formatVersion, 1);
});

test('merge: never throws on garbage input', () => {
  for (const bad of [undefined, null, 42, 'x', [], { members: 'nope', reports: 7, tombstones: 'z' }]) {
    const r = merge(bad, bad, { now: NOW });
    assert.equal(changeCount(r.localChanges), 0);
    assert.equal(r.remoteChanged, false);
  }
});
