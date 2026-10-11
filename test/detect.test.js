import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectVendor, MIN_SCORE } from '../src/parse/detect.js';

/** Build a Document from arrays of line texts per page. */
function docFrom(...pages) {
  return {
    fileName: 't.pdf', fileHash: 'h', pageCount: pages.length,
    pages: pages.map((texts, pi) => ({
      pageNumber: pi + 1, width: 612, height: 792,
      lines: texts.map((text, i) => ({ id: `p${pi + 1}l${i}`, page: pi + 1, y: 20 + i * 12, x0: 36, x1: 500, text, cells: text.split(/\s{2,}/), cellX: [36], items: [] })),
    })),
  };
}

test('detects a classic Labcorp report with high confidence and evidence', () => {
  const doc = docFrom([
    'Labcorp  Patient Report',
    'DOB: 01/02/1980  Date collected: 03/04/2025 0815 Local  Ordering: J SMITH',
    'TESTS  RESULT  FLAG  UNITS  REFERENCE INTERVAL  LAB',
    'Cholesterol, Total  210  High  mg/dL  100-199  01',
    '(c) 1995-2025 Laboratory Corporation of America Holdings',
  ]);
  const r = detectVendor(doc);
  assert.equal(r.vendor, 'labcorp');
  assert.ok(r.confidence >= 0.9, `confidence ${r.confidence}`);
  assert.ok(r.evidence.some((e) => /Laboratory Corporation of America/.test(e)));
  assert.ok(r.evidence.some((e) => /REFERENCE INTERVAL/.test(e)));
  assert.ok(r.evidence.every((e) => /\(p\d+l\d+\)$/.test(e)), 'evidence cites line ids');
});

test('detects a classic Quest report', () => {
  const doc = docFrom([
    'Quest Diagnostics  FINAL',
    'Patient Information  Specimen Information  Client Information',
    'Specimen: AB123456C  Requisition: 0012345  Lab Ref #: 1234567',
    'Test Name  In Range  Out of Range  Reference Range  Lab',
    'CHOLESTEROL, TOTAL  185  <200 mg/dL  EZ',
  ], [
    'PERFORMING SITE:',
    'EZ  Quest Diagnostics Nichols Institute, 33608 Ortega Hwy, San Juan Capistrano, CA 92675-2042  CLIA: 05D0643352',
  ]);
  const r = detectVendor(doc);
  assert.equal(r.vendor, 'quest');
  assert.ok(r.confidence >= 0.9, `confidence ${r.confidence}`);
  assert.ok(r.evidence.some((e) => /PERFORMING SITE/.test(e)));
});

test('detects the newer Labcorp portal variant', () => {
  const doc = docFrom([
    'Labcorp',
    'Patient: DOE, JANE  Date of Birth: 01/02/1980  Sex: F',
    'Specimen #: 063-123-4567-0  Collected: 03/04/2025  Reported: 03/05/2025',
    'Test Name  Result  Flag  Units  Reference Interval  Lab',
  ]);
  assert.equal(detectVendor(doc).vendor, 'labcorp');
});

test('detects the MyQuest portal variant', () => {
  const doc = docFrom([
    'MyQuest',
    'Results for JANE DOE',
    'Collected on 03/04/2025',
    'Test  Your Value  Reference Range  Flag',
  ]);
  assert.equal(detectVendor(doc).vendor, 'quest');
});

test('returns unknown with zero confidence for an unrecognized document', () => {
  const doc = docFrom(['Acme Clinical Laboratory', 'Glucose  95  mg/dL  65-99', 'Page 1 of 1']);
  const r = detectVendor(doc);
  assert.equal(r.vendor, 'unknown');
  assert.equal(r.confidence, 0);
  assert.deepEqual(r.evidence, []);
});

test('a single weak hint is not enough', () => {
  const r = detectVendor(docFrom(['Specimen ID: 1234']));
  assert.equal(r.vendor, 'unknown');
  assert.ok(MIN_SCORE > 1);
});

test('mixed evidence picks the stronger vendor with reduced confidence', () => {
  const doc = docFrom([
    'Quest Diagnostics',
    'PERFORMING SITE:',
    'Out of Range',
    'Specimen ID: 063-123-4567-0', // one labcorp-ish label
  ]);
  const r = detectVendor(doc);
  assert.equal(r.vendor, 'quest');
  assert.ok(r.confidence < 1 && r.confidence > 0.5, `confidence ${r.confidence}`);
  assert.ok(r.evidence.some((e) => e.startsWith('labcorp:')), 'opposing evidence is reported too');
});

test('each signature counts once even when repeated on every page', () => {
  const one = detectVendor(docFrom(['Quest Diagnostics']));
  const three = detectVendor(docFrom(['Quest Diagnostics'], ['Quest Diagnostics'], ['Quest Diagnostics']));
  assert.equal(one.vendor, 'quest');
  assert.equal(three.confidence, one.confidence);
  assert.equal(three.evidence.length, one.evidence.length);
});

test('tolerates empty or malformed documents', () => {
  assert.deepEqual(detectVendor({ pages: [] }), { vendor: 'unknown', confidence: 0, evidence: [] });
  assert.equal(detectVendor(null).vendor, 'unknown');
  assert.equal(detectVendor({ pages: [{ pageNumber: 1 }] }).vendor, 'unknown');
});
