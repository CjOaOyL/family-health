import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSyncEngine, SNAPSHOT_NAME, pdfName, digest } from '../src/sync/drive.js';

// ---------- fake Drive (appDataFolder only) ----------
function fakeDrive({ validToken = 'tok-1' } = {}) {
  const files = new Map(); // id → { id, name, mimeType, content: Uint8Array|string, modifiedTime }
  let seq = 0;
  const calls = [];
  const drive = { files, calls, validToken, failNext: null, tokensSeen: [] };
  const dec = new TextDecoder();
  const res = (status, body, raw) => ({
    status, ok: status >= 200 && status < 300,
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
    arrayBuffer: async () => (raw instanceof Uint8Array ? raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) : new TextEncoder().encode(String(raw)).buffer),
  });
  const stamp = () => `2026-01-01T00:00:00.${String(++seq).padStart(3, '0')}Z`;
  const metaOf = (f) => ({ id: f.id, name: f.name, size: String(f.content.length ?? f.content.byteLength), modifiedTime: f.modifiedTime });

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
    if (method === 'POST' && u.pathname === '/upload/drive/v3/files') {
      assert.equal(u.searchParams.get('uploadType'), 'multipart');
      const boundary = init.headers['Content-Type'].match(/boundary=(.+)$/)[1];
      const { meta, content } = parseMultipart(init.body, boundary);
      assert.deepEqual(meta.parents, ['appDataFolder'], 'files must be created in appDataFolder');
      const id = `f${++seq}`;
      const f = { id, name: meta.name, mimeType: meta.mimeType, content, modifiedTime: stamp() };
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
      for (const m of c.members || []) members.set(m.id, m);
      for (const r of c.reports || []) reports.set(r.id, r);
      for (const t of c.tombstones || []) tombstones.set(t.id, t);
      for (const id of c.removeMembers || []) members.delete(id);
      for (const id of c.removeReports || []) { reports.delete(id); files.delete(id); }
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

test('a corrupt remote snapshot is never overwritten', async () => {
  const clock = makeClock();
  const drive = fakeDrive();
  const A = fakeDb(clock);
  A.putMember({ id: 'm1', name: 'Ann' });
  const eng = engineFor(A, drive, { clock });
  await eng.sync();
  const f = drive.byName(SNAPSHOT_NAME);
  f.content = JSON.stringify({ formatVersion: 99 }); f.modifiedTime = '2030-01-01T00:00:00Z';
  const r = await eng.sync();
  assert.equal(r.ok, false);
  assert.match(r.message, /not in a format/);
  assert.equal(JSON.parse(drive.byName(SNAPSHOT_NAME).content).formatVersion, 99);
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
  assert.equal(listings, 2, 'one run plus one queued follow-up');
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
