import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSyncEngine, SNAPSHOT_NAME, pdfName, digest, corruptName } from '../src/sync/drive.js';
import { isStoredNewer } from '../src/store/db.js';

// ---------- fake Drive (appDataFolder only) ----------
function fakeDrive({ validToken = 'tok-1' } = {}) {
  const files = new Map(); // id → { id, name, mimeType, content: Uint8Array|string, modifiedTime }
  let seq = 0;
  const calls = [];
  const drive = { files, calls, validToken, failNext: null, tokensSeen: [], beforeRequest: null, created: [] };
  const dec = new TextDecoder();
  const res = (status, body, raw) => ({
    status, ok: status >= 200 && status < 300,
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
    arrayBuffer: async () => (raw instanceof Uint8Array ? raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) : new TextEncoder().encode(String(raw)).buffer),
  });
  const stamp = () => `2026-01-01T00:00:00.${String(++seq).padStart(3, '0')}Z`;
  const metaOf = (f) => ({ id: f.id, name: f.name, size: String(f.content.length ?? f.content.byteLength), modifiedTime: f.modifiedTime, createdTime: f.createdTime });

  function parseMultipart(body, boundary) {
    const bytes = body instanceof Uint8Array ? body : new Uint8Array(body);
    const text = dec.decode(bytes);
    const parts = text.split(`--${boundary}`).filter((p) => p.trim() && p.trim() !== '--');
    const meta = JSON.parse(parts[0].slice(parts[0].indexOf('\r\n\r\n') + 4).trim());
    // Locate the raw content bytes of the second part (binary-safe): after its blank line, before the closing boundary.
    const marker = new TextEncoder().encode(`--${boundary}\r\nContent-Type: ${meta.mimeType}\r\n\r\n`);
    let start = -1;
    outer: for (let i = 0; i <= bytes.length - marker.length; i++) {
      for (let j = 0; j < marker.length; j++) if (bytes[i + j] !== marker[j]) continue outer;
      start = i + marker.length; break;
    }
    const tail = new TextEncoder().encode(`\r\n--${boundary}--`);
    const end = bytes.length - tail.length;
    const content = bytes.slice(start, end);
    return { meta, content: meta.mimeType === 'application/json' ? dec.decode(content) : content };
  }

  drive.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = (init.method || 'GET').toUpperCase();
    calls.push(`${method} ${u.pathname}${u.search}`);
    if (drive.beforeRequest) await drive.beforeRequest(method, u.pathname);
    const auth = (init.headers || {}).Authorization || '';
    drive.tokensSeen.push(auth.replace('Bearer ', ''));
    if (drive.failNext) { const f = drive.failNext; drive.failNext = null; return res(f.status, { error: { message: f.message || 'failed' } }); }
    if (auth !== `Bearer ${drive.validToken}`) return res(401, { error: { message: 'Invalid Credentials' } });
    if (method === 'GET' && u.pathname === '/drive/v3/files') {
      assert.equal(u.searchParams.get('spaces'), 'appDataFolder', 'must only ever list the app folder');
      return res(200, { files: [...files.values()].map(metaOf) });
    }
    let m = u.pathname.match(/^\/drive\/v3\/files\/([^/]+)$/);
    if (m && method === 'GET') {
      const f = files.get(decodeURIComponent(m[1]));
      if (!f) return res(404, { error: { message: 'not found' } });
      return res(200, f.mimeType === 'application/json' ? f.content : null, f.content);
    }
    if (m && method === 'DELETE') { const ok = files.delete(decodeURIComponent(m[1])); return ok ? res(204, null) : res(404, { error: { message: 'not found' } }); }
    if (m && method === 'PATCH') { // metadata update (rename)
      const f = files.get(decodeURIComponent(m[1]));
      if (!f) return res(404, { error: { message: 'not found' } });
      const patch = JSON.parse(init.body);
      if (patch.name) f.name = patch.name;
      return res(200, { id: f.id, name: f.name });
    }
    if (method === 'POST' && u.pathname === '/upload/drive/v3/files') {
      assert.equal(u.searchParams.get('uploadType'), 'multipart');
      const boundary = init.headers['Content-Type'].match(/boundary=(.+)$/)[1];
      const { meta, content } = parseMultipart(init.body, boundary);
      assert.deepEqual(meta.parents, ['appDataFolder'], 'files must be created in appDataFolder');
      const id = `f${++seq}`;
      const f = { id, name: meta.name, mimeType: meta.mimeType, content, modifiedTime: stamp() };
      f.createdTime = f.modifiedTime;
      drive.created.push(f.name);
      files.set(id, f);
      return res(200, { id, name: f.name, modifiedTime: f.modifiedTime });
    }
    m = u.pathname.match(/^\/upload\/drive\/v3\/files\/([^/]+)$/);
    if (m && method === 'PATCH') {
      assert.equal(u.searchParams.get('uploadType'), 'media');
      const f = files.get(decodeURIComponent(m[1]));
      if (!f) return res(404, { error: { message: 'not found' } });
      f.content = typeof init.body === 'string' ? init.body : new Uint8Array(init.body);
      f.modifiedTime = stamp();
      return res(200, { id: f.id, name: f.name, modifiedTime: f.modifiedTime });
    }
    return res(400, { error: { message: `unhandled ${method} ${u.pathname}` } });
  };
  drive.byName = (name) => [...files.values()].find((f) => f.name === name) || null;
  drive.allNamed = (name) => [...files.values()].filter((f) => f.name === name);
  drive.snapshot = () => { const f = drive.byName(SNAPSHOT_NAME); return f ? JSON.parse(f.content) : null; };
  return drive;
}

// ---------- fake local db (mirrors src/store/db.js semantics) ----------
function fakeDb(clock) {
  const members = new Map(), reports = new Map(), tombstones = new Map(), files = new Map();
  let meta = { lastSyncAt: null, snapshotDriveId: null, deviceId: null };
  const db = {
    members, reports, tombstones, files,
    async listMembers() { return [...members.values()]; },
    async listReports() { return [...reports.values()]; },
    async listTombstones() { return [...tombstones.values()]; },
    async listFileIds() { return [...files.keys()]; },
    async getFile(id) { return files.get(id) || null; },
    async putFile({ id, bytes, fileName }) { files.set(id, { id, bytes, fileName }); },
    async getSyncMeta() { return { ...meta }; },
    async setSyncMeta(p) { meta = { ...meta, ...p }; return meta; },
    async applySyncChanges(c) {
      // Same rule as db.js: a record edited here after the sync read it (stored newer) is not overwritten.
      const kept = new Set();
      for (const m of c.members || []) { if (isStoredNewer(members.get(m.id), m)) kept.add(m.id); else members.set(m.id, m); }
      for (const r of c.reports || []) { if (isStoredNewer(reports.get(r.id), r)) kept.add(r.id); else reports.set(r.id, r); }
      const tombAt = new Map((c.tombstones || []).map((t) => [t.id, t.deletedAt]));
      for (const id of c.removeMembers || []) { if (isStoredNewer(members.get(id), { updatedAt: tombAt.get(id) })) kept.add(id); else members.delete(id); }
      for (const id of c.removeReports || []) { if (isStoredNewer(reports.get(id), { updatedAt: tombAt.get(id) })) kept.add(id); else { reports.delete(id); files.delete(id); } }
      for (const t of c.tombstones || []) if (!kept.has(t.id)) tombstones.set(t.id, t);
      for (const id of c.removeTombstones || []) tombstones.delete(id);
    },
    // app-side writes (what putMember/putReport/deleteReport do)
    putMember(m) { const rec = { dob: null, sex: null, createdAt: clock(), ...m, updatedAt: clock() }; members.set(rec.id, rec); tombstones.delete(rec.id); return rec; },
    putReport(r) { const rec = { memberId: null, overrides: {}, savedAt: clock(), ...r, updatedAt: clock() }; reports.set(rec.id, rec); tombstones.delete(rec.id); return rec; },
    deleteReport(id) { reports.delete(id); files.delete(id); tombstones.set(id, { id, kind: 'report', deletedAt: clock() }); },
    deleteMember(id) { members.delete(id); tombstones.set(id, { id, kind: 'member', deletedAt: clock() }); },
    putFileSync(id, bytes, fileName) { files.set(id, { id, bytes, fileName }); },
  };
  return db;
}

function makeClock() {
  let t = 0;
  const clock = () => `2026-02-01T00:00:${String(t).padStart(2, '0')}.000Z`;
  clock.tick = (n = 1) => { t += n; return clock(); };
  return clock;
}

function engineFor(db, drive, { token = () => drive.validToken, online = () => true, clock } = {}) {
  const tokens = [];
  const getToken = async ({ forceRefresh } = {}) => { const v = typeof token === 'function' ? token({ forceRefresh }) : token; tokens.push({ forceRefresh: !!forceRefresh, v }); return v; };
  const eng = createSyncEngine({ db, fetch: drive.fetch, getToken, now: clock, isOnline: online, randomId: (() => { let n = 0; return () => `rid${++n}`; })() });
  eng.tokens = tokens;
  return eng;
}

const PDF_A = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0xff, 0x00, 0x01]); // "%PDF-1.4\n" + binary
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

// ---------- tests ----------

test('first sync uploads the local snapshot and PDFs to appDataFolder', async () => {
  const clock = makeClock();
  const drive = fakeDrive();
  const db = fakeDb(clock);
  const m = db.putMember({ id: 'm1', name: 'Ann' });
  db.putReport({ id: HASH_A, memberId: m.id, report: { id: HASH_A, results: [{ id: 'r1', name: 'WBC' }] } });
  db.putFileSync(HASH_A, PDF_A, 'ann.pdf');
  const eng = engineFor(db, drive, { clock });
  const r = await eng.sync({ reason: 'test' });
  assert.equal(r.ok, true, r.message);
  assert.equal(r.status, 'synced');
  assert.equal(r.changedRemote, true);
  assert.equal(r.pdfsUploaded, 1);
  const snap = drive.snapshot();
  assert.equal(snap.formatVersion, 1);
  assert.deepEqual(Object.keys(snap.members), ['m1']);
  assert.deepEqual(Object.keys(snap.reports), [HASH_A]);
  assert.equal(snap.reports[HASH_A].report.results[0].name, 'WBC');
  assert.ok(!JSON.stringify(snap).includes('bytes'), 'snapshot never carries PDF bytes');
  const pdf = drive.byName(pdfName(HASH_A));
  assert.ok(pdf, 'pdf uploaded');
  assert.equal(pdf.mimeType, 'application/pdf');
  assert.deepEqual([...pdf.content], [...PDF_A], 'binary content intact');
  const meta = await db.getSyncMeta();
  assert.equal(meta.snapshotDriveId, drive.byName(SNAPSHOT_NAME).id);
  assert.ok(meta.lastSyncAt);
  assert.ok(meta.deviceId);
  // Only the app folder was touched.
  for (const c of drive.calls) assert.ok(/\/drive\/v3\/files|\/upload\/drive\/v3\/files/.test(c), c);
});

test('second device downloads everything on its first sync; nothing is re-uploaded', async () => {
  const clock = makeClock();
  const drive = fakeDrive();
  const A = fakeDb(clock);
  A.putMember({ id: 'm1', name: 'Ann' });
  A.putReport({ id: HASH_A, memberId: 'm1', report: { id: HASH_A } });
  A.putFileSync(HASH_A, PDF_A, 'ann.pdf');
  await engineFor(A, drive, { clock }).sync();
  const callsAfterA = drive.calls.length;

  const B = fakeDb(clock);
  const engB = engineFor(B, drive, { clock });
  const r = await engB.sync();
  assert.equal(r.ok, true, r.message);
  assert.equal(r.changedLocal, true);
  assert.equal(r.pulled, 2);
  assert.equal(r.changedRemote, false, 'B holds nothing new, so the snapshot is not rewritten');
  assert.equal(B.members.get('m1').name, 'Ann');
  assert.equal(B.reports.get(HASH_A).memberId, 'm1');
  assert.equal(B.members.get('m1').updatedAt, A.members.get('m1').updatedAt, 'timestamps are preserved, not re-stamped');
  const newCalls = drive.calls.slice(callsAfterA);
  assert.ok(!newCalls.some((c) => c.startsWith('POST') || c.startsWith('PATCH')), `no uploads expected: ${newCalls}`);

  // PDF bytes are fetched on demand, then cached locally.
  assert.equal(B.files.has(HASH_A), false);
  const got = await engB.ensureFileBytes(HASH_A, { fileName: 'ann.pdf' });
  assert.ok(got && got.source === 'drive');
  assert.deepEqual([...new Uint8Array(got.bytes)], [...PDF_A]);
  assert.equal(B.files.has(HASH_A), true);
  const again = await engB.ensureFileBytes(HASH_A);
  assert.equal(again.source, 'local');
  assert.equal(await engB.ensureFileBytes(HASH_B), null, 'unknown hash → null, no throw');
});

test('both devices edit the same member → the newer edit wins on both', async () => {
  const clock = makeClock();
  const drive = fakeDrive();
  const A = fakeDb(clock), B = fakeDb(clock);
  const engA = engineFor(A, drive, { clock }), engB = engineFor(B, drive, { clock });
  A.putMember({ id: 'm1', name: 'Ann' });
  await engA.sync(); await engB.sync();
  clock.tick(); A.putMember({ ...A.members.get('m1'), name: 'Ann (A)' });
  clock.tick(); B.putMember({ ...B.members.get('m1'), name: 'Ann (B, later)' });
  await engA.sync();
  assert.equal(drive.snapshot().members.m1.name, 'Ann (A)');
  await engB.sync();
  assert.equal(drive.snapshot().members.m1.name, 'Ann (B, later)');
  assert.equal(B.members.get('m1').name, 'Ann (B, later)');
  const rA = await engA.sync();
  assert.equal(rA.changedLocal, true);
  assert.equal(A.members.get('m1').name, 'Ann (B, later)');
});

test('delete on A removes the report (and its PDF) on B and from Drive', async () => {
  const clock = makeClock();
  const drive = fakeDrive();
  const A = fakeDb(clock), B = fakeDb(clock);
  const engA = engineFor(A, drive, { clock }), engB = engineFor(B, drive, { clock });
  A.putReport({ id: HASH_A, report: { id: HASH_A } });
  A.putFileSync(HASH_A, PDF_A, 'a.pdf');
  await engA.sync(); await engB.sync();
  await engB.ensureFileBytes(HASH_A);
  assert.ok(B.reports.has(HASH_A) && B.files.has(HASH_A));
  clock.tick(); A.deleteReport(HASH_A);
  const rA = await engA.sync();
  assert.equal(rA.ok, true, rA.message);
  assert.equal(rA.pdfsDeleted, 1);
  assert.equal(drive.byName(pdfName(HASH_A)), null, 'PDF removed from Drive');
  assert.deepEqual(Object.keys(drive.snapshot().reports), []);
  assert.equal(drive.snapshot().tombstones[HASH_A].kind, 'report');
  const rB = await engB.sync();
  assert.equal(rB.changedLocal, true);
  assert.equal(B.reports.has(HASH_A), false);
  assert.equal(B.files.has(HASH_A), false, 'local PDF dropped with the record');
  assert.equal(B.tombstones.get(HASH_A).kind, 'report');
  // Re-saving the same report on B later resurrects it everywhere.
  clock.tick(); B.putReport({ id: HASH_A, report: { id: HASH_A, again: true } });
  await engB.sync();
  assert.ok(drive.snapshot().reports[HASH_A]);
  assert.ok(!drive.snapshot().tombstones[HASH_A]);
  await engA.sync();
  assert.equal(A.reports.get(HASH_A).report.again, true);
});

test('member delete on A unassigns reports and removes the member on B', async () => {
  const clock = makeClock();
  const drive = fakeDrive();
  const A = fakeDb(clock), B = fakeDb(clock);
  const engA = engineFor(A, drive, { clock }), engB = engineFor(B, drive, { clock });
  A.putMember({ id: 'm1', name: 'Ann' });
  A.putReport({ id: HASH_A, memberId: 'm1', report: { id: HASH_A } });
  await engA.sync(); await engB.sync();
  clock.tick(); A.deleteMember('m1'); A.putReport({ ...A.reports.get(HASH_A), memberId: null });
  await engA.sync(); await engB.sync();
  assert.equal(B.members.has('m1'), false);
  assert.equal(B.reports.get(HASH_A).memberId, null);
});

test('a PDF is uploaded only once, even across repeated syncs and a second device holding the same bytes', async () => {
  const clock = makeClock();
  const drive = fakeDrive();
  const A = fakeDb(clock), B = fakeDb(clock);
  A.putReport({ id: HASH_A, report: { id: HASH_A } }); A.putFileSync(HASH_A, PDF_A, 'a.pdf');
  const engA = engineFor(A, drive, { clock });
  await engA.sync(); await engA.sync(); await engA.sync();
  B.putReport({ id: HASH_A, report: { id: HASH_A } }); B.putFileSync(HASH_A, PDF_A, 'a.pdf');
  await engineFor(B, drive, { clock }).sync();
  const pdfPosts = drive.calls.filter((c) => c.startsWith('POST') && !c.includes('fields=id,name,modifiedTime&x')).length;
  const pdfFiles = [...drive.files.values()].filter((f) => f.name === pdfName(HASH_A));
  assert.equal(pdfFiles.length, 1, 'exactly one Drive file for the hash');
  // POSTs: one snapshot create + one PDF create only.
  assert.equal(pdfPosts, 2, `expected 2 creates, got ${pdfPosts}: ${drive.calls.filter((c) => c.startsWith('POST'))}`);
});

test('unchanged on both sides → fast path: no snapshot download, no upload', async () => {
  const clock = makeClock();
  const drive = fakeDrive();
  const A = fakeDb(clock);
  A.putMember({ id: 'm1', name: 'Ann' });
  const eng = engineFor(A, drive, { clock });
  await eng.sync();
  const before = drive.calls.length;
  const r = await eng.sync();
  assert.equal(r.ok, true);
  assert.equal(r.skipped, true);
  const calls = drive.calls.slice(before);
  assert.deepEqual(calls.filter((c) => !c.startsWith('GET /drive/v3/files?')), [], `only a listing expected: ${calls}`);
});

test('401 → token refreshed once and the request retried; a second 401 surfaces as needs-auth', async () => {
  const clock = makeClock();
  const drive = fakeDrive({ validToken: 'fresh' });
  const A = fakeDb(clock);
  A.putMember({ id: 'm1', name: 'Ann' });
  let issued = 'stale';
  const eng = engineFor(A, drive, { clock, token: ({ forceRefresh }) => { if (forceRefresh) issued = 'fresh'; return issued; } });
  const r = await eng.sync();
  assert.equal(r.ok, true, r.message);
  assert.ok(eng.tokens.some((t) => t.forceRefresh), 'a forced refresh happened');
  assert.equal(drive.tokensSeen[0], 'stale');
  assert.equal(drive.tokensSeen[1], 'fresh');
  assert.equal(eng.tokens.filter((t) => t.forceRefresh).length, 1, 'refreshed exactly once');

  // Now the refresh itself keeps producing a bad token: one retry, then needs-auth, never a throw.
  const drive2 = fakeDrive({ validToken: 'good' });
  const eng2 = engineFor(A, drive2, { clock, token: () => 'bad' });
  const r2 = await eng2.sync();
  assert.equal(r2.ok, false);
  assert.equal(r2.status, 'needs-auth');
  assert.equal(drive2.calls.length, 2, 'original + one retry');
});

test('no token at all → needs-auth status, nothing sent', async () => {
  const clock = makeClock();
  const drive = fakeDrive();
  const eng = engineFor(fakeDb(clock), drive, { clock, token: () => null });
  const r = await eng.sync();
  assert.equal(r.ok, false);
  assert.equal(r.status, 'needs-auth');
  assert.equal(drive.calls.length, 0);
});

test('offline → skipped quietly with status offline', async () => {
  const clock = makeClock();
  const drive = fakeDrive();
  const eng = engineFor(fakeDb(clock), drive, { clock, online: () => false });
  const r = await eng.sync();
  assert.equal(r.status, 'offline');
  assert.equal(drive.calls.length, 0);
});

test('403/429 → error with a message and back-off; the next sync is skipped until the window passes', async () => {
  const clock = makeClock();
  const drive = fakeDrive();
  const A = fakeDb(clock);
  A.putMember({ id: 'm1', name: 'Ann' });
  const eng = engineFor(A, drive, { clock });
  drive.failNext = { status: 429, message: 'Rate Limit Exceeded' };
  const r = await eng.sync();
  assert.equal(r.ok, false);
  assert.equal(r.status, 'error');
  assert.match(r.message, /Rate Limit Exceeded/);
  assert.equal(r.retryable, true);
  const before = drive.calls.length;
  const r2 = await eng.sync();
  assert.equal(r2.ok, false);
  assert.match(r2.message, /rate limit/i);
  assert.equal(drive.calls.length, before, 'no network during back-off');
  clock.tick(59); // still inside the 60 s window
  assert.equal((await eng.sync()).ok, false);
  const r3 = await eng.sync({ force: true });
  assert.equal(r3.ok, true, 'manual sync ignores the back-off');
});

test('a remote snapshot written by a newer app version is never overwritten; the status says to update', async () => {
  const clock = makeClock();
  const drive = fakeDrive();
  const A = fakeDb(clock);
  A.putMember({ id: 'm1', name: 'Ann' });
  const eng = engineFor(A, drive, { clock });
  await eng.sync();
  const f = drive.byName(SNAPSHOT_NAME);
  f.content = JSON.stringify({ formatVersion: 99 }); f.modifiedTime = '2030-01-01T00:00:00Z';
  const before = drive.calls.length;
  const r = await eng.sync();
  assert.equal(r.ok, false);
  assert.equal(r.code, 'newer');
  assert.equal(r.retryable, false);
  assert.match(r.message, /newer version of this app.*update the app/);
  assert.equal(drive.allNamed(SNAPSHOT_NAME).length, 1, 'not duplicated, not renamed');
  assert.equal(JSON.parse(drive.byName(SNAPSHOT_NAME).content).formatVersion, 99);
  assert.ok(!drive.calls.slice(before).some((c) => c.startsWith('PATCH') || c.startsWith('POST') || c.startsWith('DELETE')), 'nothing written');
});

test('a corrupt (garbage) remote snapshot is quarantined and recreated from this device; the next sync is healthy', async () => {
  const clock = makeClock();
  const drive = fakeDrive();
  const A = fakeDb(clock);
  A.putMember({ id: 'm1', name: 'Ann' });
  const eng = engineFor(A, drive, { clock });
  await eng.sync();
  const f = drive.byName(SNAPSHOT_NAME);
  f.content = '{"formatVersion":1,"members":{ <<garbage'; f.modifiedTime = '2030-01-01T00:00:00Z';
  clock.tick();
  const r = await eng.sync();
  assert.equal(r.ok, true, r.message);
  assert.equal(r.status, 'synced');
  assert.match(r.message, /^The Drive copy was unreadable and has been replaced from this device; the old file was kept as family-health-sync\.corrupt-[0-9TZ-]+\.json$/);
  assert.equal(r.notice, r.message);
  // Exactly one healthy snapshot with our data, plus the quarantined file with the old bytes.
  const snaps = drive.allNamed(SNAPSHOT_NAME);
  assert.equal(snaps.length, 1);
  assert.equal(JSON.parse(snaps[0].content).members.m1.name, 'Ann');
  const kept = [...drive.files.values()].filter((x) => /^family-health-sync\.corrupt-.*\.json$/.test(x.name));
  assert.equal(kept.length, 1);
  assert.equal(kept[0].id, f.id, 'renamed in place, not copied');
  assert.equal(kept[0].content, '{"formatVersion":1,"members":{ <<garbage');
  assert.equal(kept[0].name, corruptName(r.at));
  assert.equal((await A.getSyncMeta()).snapshotDriveId, snaps[0].id);
  // Next sync: clean fast path, no notice.
  const r2 = await eng.sync();
  assert.equal(r2.ok, true);
  assert.equal(r2.skipped, true);
  assert.equal(r2.notice, '');
  assert.equal(r2.message, 'Up to date');
  // A second device still pulls everything from the recreated snapshot.
  const B = fakeDb(clock);
  const rB = await engineFor(B, drive, { clock }).sync();
  assert.equal(rB.ok, true);
  assert.equal(B.members.get('m1').name, 'Ann');
});

test('an empty (size 0) remote snapshot is treated as corrupt: quarantined and recreated', async () => {
  const clock = makeClock();
  const drive = fakeDrive();
  const A = fakeDb(clock);
  A.putReport({ id: HASH_A, report: { id: HASH_A } });
  const eng = engineFor(A, drive, { clock });
  await eng.sync();
  const f = drive.byName(SNAPSHOT_NAME);
  f.content = ''; f.modifiedTime = '2030-01-01T00:00:00Z';
  const r = await eng.sync();
  assert.equal(r.ok, true, r.message);
  assert.match(r.message, /unreadable and has been replaced/);
  assert.ok(!drive.calls.some((c) => c.startsWith(`GET /drive/v3/files/${f.id}?alt=media`)), 'an empty file is not even downloaded');
  assert.equal(drive.allNamed(SNAPSHOT_NAME).length, 1);
  assert.deepEqual(Object.keys(drive.snapshot().reports), [HASH_A]);
  assert.ok(drive.byName(corruptName(r.at)));
});

test('a simultaneous first sync on two devices ends with exactly one snapshot holding both devices\' records', async () => {
  const clock = makeClock();
  const drive = fakeDrive();
  const A = fakeDb(clock), B = fakeDb(clock);
  A.putMember({ id: 'm-a', name: 'From A' });
  A.putReport({ id: HASH_A, memberId: 'm-a', report: { id: HASH_A } }); A.putFileSync(HASH_A, PDF_A, 'a.pdf');
  B.putMember({ id: 'm-b', name: 'From B' });
  B.putReport({ id: HASH_A, memberId: 'm-b', report: { id: HASH_A, fromB: true } }); B.putFileSync(HASH_A, PDF_A, 'b.pdf');
  const engA = engineFor(A, drive, { clock }), engB = engineFor(B, drive, { clock });
  // Hold both initial listings until both have arrived, so each device sees an empty folder and creates its own file.
  let listed = 0, release;
  const gate = new Promise((r) => { release = r; });
  drive.beforeRequest = async (method, path) => {
    if (method === 'GET' && path === '/drive/v3/files' && listed < 2) { listed++; if (listed === 2) release(); await gate; }
  };
  const [ra, rb] = await Promise.all([engA.sync(), engB.sync()]);
  assert.equal(ra.ok, true, ra.message);
  assert.equal(rb.ok, true, rb.message);
  assert.equal(drive.created.filter((n) => n === SNAPSHOT_NAME).length, 2, 'the race really happened: two snapshot creates');
  const snaps = drive.allNamed(SNAPSHOT_NAME);
  assert.equal(snaps.length, 1, `exactly one snapshot, got ${snaps.map((s) => s.id)}`);
  const snap = JSON.parse(snaps[0].content);
  assert.deepEqual(Object.keys(snap.members).sort(), ['m-a', 'm-b']);
  assert.equal(snap.formatVersion, 1);
  assert.ok(snap.reports[HASH_A]);
  assert.equal(snaps[0].id, 'f1', 'the oldest copy is the one kept');
  assert.ok(![...drive.files.values()].some((x) => x.name.includes('.corrupt-')), 'nothing was quarantined');
  // A further sync on each device reconciles their local stores and removes the duplicate PDF upload.
  const r2a = await engA.sync(), r2b = await engB.sync();
  assert.equal(r2a.ok && r2b.ok, true);
  assert.equal(A.members.get('m-b').name, 'From B');
  assert.equal(B.members.get('m-a').name, 'From A');
  assert.equal(drive.allNamed(SNAPSHOT_NAME).length, 1);
  assert.equal(drive.allNamed(pdfName(HASH_A)).length, 1, 'duplicate PDF removed');
  assert.equal((await A.getSyncMeta()).snapshotDriveId, 'f1');
  assert.equal((await B.getSyncMeta()).snapshotDriveId, 'f1');
  // And both are now on the fast path.
  assert.equal((await engA.sync()).skipped, true);
  assert.equal((await engB.sync()).skipped, true);
});

test('duplicate snapshots already in Drive (from an older race) are folded into the oldest copy and deleted', async () => {
  const clock = makeClock();
  const drive = fakeDrive();
  const A = fakeDb(clock);
  const eng = engineFor(A, drive, { clock });
  // Three copies, the newest created last holds a record nobody else has; the oldest is the primary.
  const mk = (id, members, createdTime) => drive.files.set(id, { id, name: SNAPSHOT_NAME, mimeType: 'application/json', content: JSON.stringify({ formatVersion: 1, members, reports: {}, tombstones: {} }), modifiedTime: createdTime, createdTime });
  mk('zz-old', { p: { id: 'p', name: 'Primary', updatedAt: clock() } }, '2026-01-01T00:00:00.001Z');
  mk('aa-mid', { q: { id: 'q', name: 'Mid', updatedAt: clock() } }, '2026-01-01T00:00:00.002Z');
  mk('mm-new', { r: { id: 'r', name: 'New', updatedAt: clock() } }, '2026-01-01T00:00:00.002Z');
  const r = await eng.sync();
  assert.equal(r.ok, true, r.message);
  assert.equal(r.duplicatesRemoved, 2);
  const snaps = drive.allNamed(SNAPSHOT_NAME);
  assert.equal(snaps.length, 1);
  assert.equal(snaps[0].id, 'zz-old', 'oldest createdTime wins over id order');
  assert.deepEqual(Object.keys(JSON.parse(snaps[0].content).members).sort(), ['p', 'q', 'r']);
  assert.deepEqual([...A.members.keys()].sort(), ['p', 'q', 'r'], 'all three landed locally');
  assert.equal(r.pulled, 3);
});

test('403 back-off repeats what Drive said (not "rate limit") together with the retry time', async () => {
  const clock = makeClock();
  const drive = fakeDrive();
  const A = fakeDb(clock);
  A.putMember({ id: 'm1', name: 'Ann' });
  const eng = engineFor(A, drive, { clock });
  drive.failNext = { status: 403, message: 'The user has not granted the app 1234 read access to the file.' };
  const r = await eng.sync();
  assert.equal(r.ok, false);
  assert.match(r.message, /not granted the app 1234/);
  const r2 = await eng.sync();
  assert.equal(r2.ok, false);
  assert.match(r2.message, /^The user has not granted the app 1234 read access to the file\. \(403\); retrying after \d\d:\d\d UTC$/);
  assert.doesNotMatch(r2.message, /rate limit/i);
  // The remembered message is cleared by a successful sync.
  const r3 = await eng.sync({ force: true });
  assert.equal(r3.ok, true);
  drive.failNext = { status: 429, message: 'Rate Limit Exceeded' };
  await eng.sync();
  assert.match((await eng.sync()).message, /^Rate Limit Exceeded \(429\); retrying after/);
});

test('a record edited on this device while the sync was running is not overwritten by the incoming copy (fake db)', async () => {
  const clock = makeClock();
  const drive = fakeDrive();
  const A = fakeDb(clock), B = fakeDb(clock);
  const engA = engineFor(A, drive, { clock }), engB = engineFor(B, drive, { clock });
  A.putMember({ id: 'm1', name: 'Ann' });
  await engA.sync(); await engB.sync();
  clock.tick(); A.putMember({ ...A.members.get('m1'), name: 'Ann (A edit)' });
  await engA.sync();
  // On B the user renames m1 after B's sync has read the local store but before it applies A's edit.
  const apply = B.applySyncChanges;
  B.applySyncChanges = async (c) => { clock.tick(); B.putMember({ ...B.members.get('m1'), name: 'Ann (B edit during sync)' }); B.applySyncChanges = apply; return apply(c); };
  const rB = await engB.sync();
  assert.equal(rB.ok, true, rB.message);
  assert.equal(B.members.get('m1').name, 'Ann (B edit during sync)', 'the newer local edit survives');
  // The next sync pushes it, and A picks it up.
  const rB2 = await engB.sync();
  assert.equal(rB2.ok, true);
  assert.equal(drive.snapshot().members.m1.name, 'Ann (B edit during sync)');
  await engA.sync();
  assert.equal(A.members.get('m1').name, 'Ann (B edit during sync)');
});

test('concurrent sync calls share one run and queue at most one follow-up', async () => {
  const clock = makeClock();
  const drive = fakeDrive();
  const A = fakeDb(clock);
  A.putMember({ id: 'm1', name: 'Ann' });
  const eng = engineFor(A, drive, { clock });
  const [a, b, c] = await Promise.all([eng.sync(), eng.sync(), eng.sync()]);
  assert.equal(a.ok && b.ok && c.ok, true);
  const listings = drive.calls.filter((x) => x.startsWith('GET /drive/v3/files?')).length;
  assert.equal(listings, 3, 'one run (which lists again after creating the snapshot) plus one queued follow-up');
});

test('deleteAllRemote removes every app-folder file and nothing else is touched', async () => {
  const clock = makeClock();
  const drive = fakeDrive();
  const A = fakeDb(clock);
  A.putReport({ id: HASH_A, report: { id: HASH_A } }); A.putFileSync(HASH_A, PDF_A, 'a.pdf');
  const eng = engineFor(A, drive, { clock });
  await eng.sync();
  assert.equal(drive.files.size, 2);
  const r = await eng.deleteAllRemote();
  assert.equal(r.ok, true);
  assert.equal(r.deleted, 2);
  assert.equal(drive.files.size, 0);
  assert.equal(A.reports.size, 1, 'local data untouched');
});

test('digest is stable and sensitive', () => {
  assert.equal(digest('abc'), digest('abc'));
  assert.notEqual(digest('abc'), digest('abd'));
  assert.match(digest(''), /^[0-9a-f]{8}$/);
});

// ---------- minimal in-memory IndexedDB, just enough to run src/store/db.js under node ----------
// Requests resolve in microtasks; a transaction completes on the next macrotask with no request pending, which
// matches how db.js awaits each request before issuing the next.
function installFakeIndexedDB() {
  const databases = new Map();
  const byKey = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  class Txn {
    constructor(db, names) { this.db = db; this.names = names; this.pending = 0; this.done = false; this.error = null; this.oncomplete = null; this.onerror = null; this.onabort = null; this.check(); }
    objectStore(name) { if (!this.names.includes(name)) throw new Error(`store ${name} is not in this transaction`); return new StoreHandle(this.db.stores.get(name), this); }
    abort() { if (this.done) return; this.done = true; if (this.onabort) this.onabort({ target: this }); }
    run(fn) {
      const req = { result: undefined, error: null, onsuccess: null, onerror: null };
      this.pending++;
      queueMicrotask(() => {
        try { req.result = fn(); if (req.onsuccess) req.onsuccess({ target: req }); } catch (e) { req.error = e; if (req.onerror) req.onerror({ target: req }); }
        this.pending--; if (!this.pending) this.check();
      });
      return req;
    }
    check() { setImmediate(() => { if (!this.done && !this.pending) { this.done = true; if (this.oncomplete) this.oncomplete({ target: this }); } }); }
  }
  class StoreHandle {
    constructor(store, txn) { this.s = store; this.t = txn; }
    put(v) { return this.t.run(() => { const k = v[this.s.keyPath]; if (k === undefined) throw new Error('no key'); this.s.rows.set(k, structuredClone(v)); return k; }); }
    get(k) { return this.t.run(() => (this.s.rows.has(k) ? structuredClone(this.s.rows.get(k)) : undefined)); }
    delete(k) { return this.t.run(() => { this.s.rows.delete(k); return undefined; }); }
    clear() { return this.t.run(() => { this.s.rows.clear(); return undefined; }); }
    count() { return this.t.run(() => this.s.rows.size); }
    getAll() { return this.t.run(() => [...this.s.rows.keys()].sort(byKey).map((k) => structuredClone(this.s.rows.get(k)))); }
    getAllKeys() { return this.t.run(() => [...this.s.rows.keys()].sort(byKey)); }
    index(name) { const kp = this.s.indexes.get(name); return { getAll: (q) => this.t.run(() => [...this.s.rows.values()].filter((v) => v[kp] === q).map((v) => structuredClone(v))) }; }
  }
  class Db {
    constructor(name) { this.name = name; this.version = 0; this.stores = new Map(); this.onversionchange = null; }
    get objectStoreNames() { return { contains: (n) => this.stores.has(n) }; }
    createObjectStore(name, { keyPath }) { const s = { name, keyPath, rows: new Map(), indexes: new Map() }; this.stores.set(name, s); return { createIndex: (iname, kp) => { s.indexes.set(iname, kp); } }; }
    transaction(names, mode) { return new Txn(this, Array.isArray(names) ? names : [names], mode); }
    close() {}
  }
  globalThis.indexedDB = {
    open(name, version) {
      const req = { result: null, error: null, transaction: null, onupgradeneeded: null, onsuccess: null, onerror: null, onblocked: null };
      queueMicrotask(() => {
        let db = databases.get(name);
        const old = db ? db.version : 0;
        if (!db) { db = new Db(name); databases.set(name, db); }
        req.result = db;
        if (version > old) { db.version = version; req.transaction = db.transaction([...db.stores.keys()], 'versionchange'); if (req.onupgradeneeded) req.onupgradeneeded({ oldVersion: old, target: req }); }
        if (req.onsuccess) req.onsuccess({ target: req });
      });
      return req;
    },
  };
}
installFakeIndexedDB();
const realDb = await import('../src/store/db.js');
const future = (s = 60) => new Date(Date.now() + s * 1000).toISOString();
const PAST = '2000-01-01T00:00:00.000Z';

test('db.importAll (merge): a backup tombstone deletes a local record it out-dates, is dropped against a newer one, never sits beside a live record', async () => {
  await realDb.clearAll();
  await realDb.putMember({ id: 'm-old', name: 'Older than the tombstone' });
  await realDb.putMember({ id: 'm-new', name: 'Newer than the tombstone' });
  await realDb.putReport({ id: 'r-old', report: { id: 'r-old', results: [] } });
  await realDb.putFile({ id: 'r-old', bytes: new Uint8Array([1, 2, 3]), fileName: 'old.pdf' });
  await realDb.putReport({ id: 'r-new', report: { id: 'r-new', results: [] } });
  const counts = await realDb.importAll({
    app: 'family-health', formatVersion: 1, members: [], reports: [],
    tombstones: [
      { id: 'm-old', kind: 'member', deletedAt: future() },
      { id: 'm-new', kind: 'member', deletedAt: PAST },
      { id: 'r-old', kind: 'report', deletedAt: future() },
      { id: 'r-new', kind: 'report', deletedAt: PAST },
      { id: 'ghost', kind: 'report', deletedAt: future() },
    ],
  }, { merge: true });
  assert.equal(counts.tombstones, 3, 'm-old, r-old and ghost written; the two older tombstones dropped');
  assert.equal(counts.skipped, 2);
  assert.deepEqual((await realDb.listMembers()).map((m) => m.id), ['m-new']);
  assert.equal(await realDb.getReport('r-old'), null);
  assert.equal(await realDb.getFile('r-old'), null, 'the PDF goes with the report');
  assert.ok(await realDb.getReport('r-new'));
  const tombs = (await realDb.listTombstones()).map((t) => t.id).sort();
  assert.deepEqual(tombs, ['ghost', 'm-old', 'r-old']);
  for (const t of await realDb.listTombstones()) {
    assert.equal(t.kind === 'member' ? await realDb.getMember(t.id) : await realDb.getReport(t.id), null, `tombstone ${t.id} must not sit beside a live record`);
  }
  // Restoring a record the backup also contains still wins over its own tombstone.
  const c2 = await realDb.importAll({ members: [{ id: 'm-old', name: 'Back' }], tombstones: [{ id: 'm-old', kind: 'member', deletedAt: future(120) }] }, { merge: true });
  assert.equal(c2.members, 1);
  assert.ok(await realDb.getMember('m-old'));
  assert.ok(!(await realDb.listTombstones()).some((t) => t.id === 'm-old'));
});

test('db.applySyncChanges: an incoming record or tombstone older than what is stored is skipped (edit during sync)', async () => {
  await realDb.clearAll();
  const m = await realDb.putMember({ id: 'm1', name: 'Edited here just now' });
  const r = await realDb.putReport({ id: 'r1', memberId: 'm1', report: { id: 'r1', results: [] }, overrides: { 'patient.dob': '1980-01-01' } });
  await realDb.putFile({ id: 'r1', bytes: new Uint8Array([9]), fileName: 'r1.pdf' });
  // Older incoming copies: ignored.
  await realDb.applySyncChanges({
    members: [{ ...m, name: 'Stale from Drive', updatedAt: PAST }],
    reports: [{ ...r, overrides: {}, updatedAt: PAST }],
  });
  assert.equal((await realDb.getMember('m1')).name, 'Edited here just now');
  assert.deepEqual((await realDb.getReport('r1')).overrides, { 'patient.dob': '1980-01-01' });
  // Older tombstones: the record (and its file) stay, and the tombstone is not written beside them.
  await realDb.applySyncChanges({
    removeMembers: ['m1'], removeReports: ['r1'],
    tombstones: [{ id: 'm1', kind: 'member', deletedAt: PAST }, { id: 'r1', kind: 'report', deletedAt: PAST }],
  });
  assert.ok(await realDb.getMember('m1'));
  assert.ok(await realDb.getReport('r1'));
  assert.ok(await realDb.getFile('r1'));
  assert.deepEqual(await realDb.listTombstones(), []);
  // Newer incoming copies and tombstones apply as before (timestamps preserved, not re-stamped).
  const t2 = future();
  await realDb.applySyncChanges({ members: [{ ...m, name: 'Newer from Drive', updatedAt: t2 }] });
  assert.equal((await realDb.getMember('m1')).name, 'Newer from Drive');
  assert.equal((await realDb.getMember('m1')).updatedAt, t2);
  await realDb.applySyncChanges({ removeReports: ['r1'], tombstones: [{ id: 'r1', kind: 'report', deletedAt: future(120) }] });
  assert.equal(await realDb.getReport('r1'), null);
  assert.equal(await realDb.getFile('r1'), null);
  assert.equal((await realDb.listTombstones())[0].id, 'r1');
  // Pure helper, exported so the fake db above mirrors it.
  assert.equal(isStoredNewer({ updatedAt: '2026-01-02' }, { updatedAt: '2026-01-01' }), true);
  assert.equal(isStoredNewer({ updatedAt: '2026-01-01' }, { updatedAt: '2026-01-01' }), false);
  assert.equal(isStoredNewer(undefined, { updatedAt: '2026-01-01' }), false);
  assert.equal(isStoredNewer({ updatedAt: '2026-01-01' }, { updatedAt: undefined }), true);
});
