import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactForSharing, redactText, redactWarning, ANALYTE_WORDS, ALLOWED_WORDS } from '../src/model/redact.js';
import { parseDocument } from '../src/parse/index.js';
import { emptyReport, emptyResult } from '../src/model/schema.js';

// Fake identity strings. None of these may appear in the diagnostic in any form.
const NAME = 'DOE, JANE MARIE';
const STREET = '123 MAPLE STREET APT 4';
const CITY = 'Anytown, NJ 08540';
const DOB = '01/15/1980';
const PHONE = '609-555-0100';
const NPI = '1234567893';
const SPECIMEN = '063-123-4567-0';
const ACCOUNT = '12345678';
const PRACTICE = 'Riverside Family Medicine';
const PROVIDER = 'J SMITH';
const IDENTITY_WORDS = ['DOE', 'JANE', 'MARIE', 'MAPLE', 'STREET', 'APT', 'Anytown', 'Riverside', 'Family', 'Medicine', 'SMITH', 'Springfield'];
const IDENTITY_NUMBERS = ['08540', '1980', '0100', '1234567893', '063-123-4567-0', '12345678', '62704', '555'];

function line(id, text, page = 1) {
  return { id, page, y: 0, x0: 36, x1: 500, text, cells: text.split(/\s{2,}/), cellX: [36], items: [] };
}

/** Document where NOTHING identity-bearing was parsed: every identity string sits in an unconsumed line. */
function docWithUnconsumedIdentity() {
  const texts = [
    'Labcorp',
    NAME,
    `DOB: ${DOB}  Age: 46  Gender: F`,
    `Patient ID: ${ACCOUNT}  Phone: ${PHONE}`,
    `Specimen ID: ${SPECIMEN}`,
    `Ordering: ${PROVIDER}  NPI: ${NPI}`,
    `Account Number: ${ACCOUNT}`,
    PRACTICE,
    STREET,
    CITY,
    '### MAPLE STREET APT #, SPRINGFIELD IL 62704',
    'TESTS  RESULT  FLAG  UNITS  REFERENCE INTERVAL  LAB',
    'Hemoglobin A1c  5.4  %  4.8-5.6  01',
    'Page 1 of 1',
  ];
  return { fileName: 'x.pdf', fileHash: 'h', pageCount: 1, pages: [{ pageNumber: 1, width: 612, height: 792, lines: texts.map((t, i) => line(`p1l${i}`, t)) }] };
}

function assertNoIdentity(out) {
  const lower = out.toLowerCase();
  for (const s of [NAME, STREET, CITY, DOB, PHONE, NPI, SPECIMEN, ACCOUNT, PRACTICE, PROVIDER]) {
    assert.equal(lower.includes(s.toLowerCase()), false, `identity string leaked: ${s}`);
  }
  for (const w of IDENTITY_WORDS) {
    assert.equal(lower.includes(w.toLowerCase()), false, `identity word leaked: ${w}`);
  }
  for (const n of IDENTITY_NUMBERS) assert.equal(out.includes(n), false, `identity number leaked: ${n}`);
  assert.equal(/\d{4,}/.test(out.replace(/p\d+l\d+/g, '')), false, 'a run of 4+ digits leaked');
}

test('redactForSharing masks identity in BOTH parsed fields and unconsumed/suspicious lines, keeps analyte names and units', () => {
  const doc = docWithUnconsumedIdentity();
  const report = emptyReport();
  // parsed identity fields
  Object.assign(report.patient, { fullName: NAME, lastName: 'DOE', firstName: 'JANE', middleName: 'MARIE', dob: '1980-01-15', sex: 'F', patientId: ACCOUNT, phone: PHONE, address: `${STREET}, ${CITY}` });
  Object.assign(report.provider, { orderingName: PROVIDER, npi: NPI, accountNumber: ACCOUNT, accountName: PRACTICE, address: `${STREET}, ${CITY}`, phone: PHONE });
  Object.assign(report.specimen, { specimenId: SPECIMEN, collectedAt: '2025-03-04T08:15' });
  report.source.vendor = 'labcorp'; report.source.pageCount = 1; report.source.parserVersion = '9.9.9';
  const r1 = emptyResult('r1');
  Object.assign(r1, { name: 'Hemoglobin A1c', valueText: '5.4', value: 5.4, unit: '%', canonicalId: 'hba1c', referenceRange: { text: '4.8-5.6', low: 4.8, high: 5.6, kind: 'range' }, confidence: 1, fieldStatus: { value: 'found', unit: 'found', range: 'found', flag: 'na' } });
  const r2 = emptyResult('r2');
  Object.assign(r2, { name: `Cholesterol, Total for ${NAME}`, valueText: '210', value: 210, unit: 'mg/dL', referenceRange: { text: '100-199', low: 100, high: 199, kind: 'range' }, confidence: 1, fieldStatus: { value: 'found', unit: 'found', range: 'found', flag: 'na' } });
  const r3 = emptyResult('r3');
  Object.assign(r3, { name: `${PRACTICE} special assay`, valueText: '77', value: 77, unit: 'widgets', referenceRange: { text: null, low: null, high: null, kind: null }, confidence: 0.5, fieldStatus: { value: 'found', unit: 'found', range: 'missing', flag: 'na' } });
  report.results = [r1, r2, r3];
  // audit with every identity line unconsumed, one suspicious consumed line, and warnings that interpolate identity text
  const lines = doc.pages[0].lines;
  report.audit = {
    overall: 0.5, label: 'incomplete', fields: { 'patient.fullName': { status: 'found', confidence: 1, evidence: [] } },
    coverage: {
      totalLines: lines.length, consumedLines: 1,
      unconsumed: lines.filter((l) => l.id !== 'p1l12').map((l) => ({ lineId: l.id, page: 1, text: l.text, resultLike: false })),
      resultLikeUnconsumed: 0,
      suspiciousConsumed: [{ lineId: 'p1l12', page: 1, text: `Hemoglobin A1c  5.4  %  4.8-5.6  01  ${NAME}`, tag: 'comment:r1' }],
      resultLikeTotal: 1,
    },
    pages: { declared: 1, seen: 1, complete: true }, results: { count: 3, fullyParsed: 2, withIssues: 1 },
    warnings: [
      `Unrecognized header fragment "${PRACTICE}" at p1l7`,
      `Unrecognized header fragment "${STREET}" at p1l8`,
      `Patient name ${NAME} printed twice; DOB ${DOB} differs from ${'01/15/1981'}`,
      `provider ${PROVIDER} NPI ${NPI} account ${ACCOUNT} phone ${PHONE}`,
    ],
  };

  const out = redactForSharing(report, doc);
  assertNoIdentity(out);
  // never a result value
  assert.equal(/\b5\.4\b/.test(out), false, 'result value 5.4 leaked');
  assert.equal(/\b210\b/.test(out), false, 'result value 210 leaked');
  assert.equal(/\b77\b/.test(out), false, 'result value 77 leaked');
  // analyte names, units, kinds, statuses, scores and vendor survive
  assert.ok(out.includes('Hemoglobin A1c'), 'known analyte name kept');
  assert.ok(out.includes('mg/dL'), 'unit kept');
  assert.ok(out.includes('unit=%'), 'percent unit kept');
  assert.ok(out.includes('vendor: labcorp'));
  assert.ok(out.includes('parserVersion: 9.9.9'));
  assert.ok(out.includes('range=range'));
  assert.ok(out.includes('status=v:found/u:found/r:missing'));
  assert.ok(out.includes('canonical=hba1c'));
  assert.ok(out.includes('overall: 0.50 (incomplete)'));
  assert.ok(out.includes('patient.fullName: found'));
  assert.ok(/^Masking:/m.test(out), 'header line explains the masking');
  assert.ok(out.includes('[p1l12] [comment:r1]'), 'suspicious consumed line is listed');
  assert.ok(out.includes('1 consumed-as-comment lines that look like result rows'));
  // unknown result name / unit are shape-masked, not printed
  assert.equal(out.includes('widgets'), false);
  assert.equal(out.includes('special assay'), false);
  assert.ok(out.includes('▒'), 'masking character present');
  // quoted spans in warnings are replaced by an ellipsis
  assert.ok(out.includes('Unrecognized header fragment … at p1l7'), out.split('\n').filter((l) => l.includes('warning')).join('\n'));
});

test('redactForSharing on a real parsed document never prints identity even though the parser found it', () => {
  const doc = docWithUnconsumedIdentity();
  const report = parseDocument(doc);
  const out = redactForSharing(report, doc);
  assertNoIdentity(out);
  assert.ok(out.includes('Hemoglobin A1c') || out.includes('▒'));
});

test('redactText keeps only analyte words, units, vocabulary and punctuation', () => {
  const s = redactText('Cholesterol, Total  210  High  mg/dL  100-199  01  seen by DR JANE DOE at 123 MAPLE STREET');
  assert.equal(s, 'Cholesterol, Total  ###  High  mg/dL  ###-###  ##  seen by ▒▒ ▒▒▒▒ ▒▒▒ at ### ▒▒▒▒▒ ▒▒▒▒▒▒');
  assert.equal(redactText('WBC  6.8  x10E3/uL  3.4-10.8'), 'WBC  #.#  x10E3/uL  #.#-##.#');
  assert.equal(redactText('Non Reactive  Not Detected  Negative'), 'Non Reactive  Not Detected  Negative');
  assert.equal(redactText('p2l14 Anytown, NJ 08540'), 'p2l14 ▒▒▒▒▒▒▒, ▒▒ #####');
  // identity tokens win over vocabulary / analyte words
  assert.equal(redactText('Patient Iron Low', ['Iron', 'Low']), 'Patient ▒▒▒▒ ▒▒▒');
  assert.equal(redactText('', []), '');
  assert.equal(redactText(null, []), '');
});

test('redactWarning strips quoted spans before masking', () => {
  assert.equal(redactWarning('Unrecognized header fragment "Sample Family Medicine" at p1l9'), 'Unrecognized header fragment … at p1l9');
  assert.equal(redactWarning('value “6.2 mg/dL” not recognized'), 'value … not recognized');
});

test('allow-lists contain no obviously identifying words', () => {
  for (const w of ['maple', 'street', 'anytown', 'springfield', 'doe', 'jane', 'marie', 'riverside', 'smith', 'burlington', 'york', 'court', 'ave', 'road', 'suite']) {
    assert.equal(ANALYTE_WORDS.has(w), false, `analyte words contain ${w}`);
    assert.equal(ALLOWED_WORDS.has(w), false, `allowed words contain ${w}`);
  }
});
