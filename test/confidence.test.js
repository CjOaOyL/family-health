import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAudit, resultLike, isBoilerplate, scoreResult, WEIGHTS, CAPS, LABEL_THRESHOLDS, RESULT_PENALTIES,
} from '../src/audit/confidence.js';
import { emptyReport, emptyResult, REQUIRED_FIELDS, IMPORTANT_FIELDS } from '../src/model/schema.js';

function docFrom(...pages) {
  return {
    fileName: 't.pdf', fileHash: 'h', pageCount: pages.length,
    pages: pages.map((texts, pi) => ({
      pageNumber: pi + 1, width: 612, height: 792,
      lines: texts.map((text, i) => ({ id: `p${pi + 1}l${i}`, page: pi + 1, y: 20 + i * 12, x0: 36, x1: 500, text, cells: text.split(/\s{2,}/), cellX: [36], items: [] })),
    })),
  };
}

/** A fully populated report (all required + important fields present). */
function fullReport(results = []) {
  const r = emptyReport();
  r.source.vendor = 'labcorp';
  Object.assign(r.patient, { fullName: 'DOE, JANE', dob: '1980-01-02', sex: 'F', patientId: '1', ageAtCollection: 45 });
  Object.assign(r.specimen, { collectedAt: '2025-03-04T08:15', reportedAt: '2025-03-05T10:23', receivedAt: '2025-03-04', specimenId: '063-1' });
  Object.assign(r.provider, { orderingName: 'J SMITH', accountNumber: '123', npi: '1234567890' });
  r.performingLabs = [{ code: '01', name: 'LabCorp Burlington', address: null, director: null, clia: null, phone: null }];
  r.results = results;
  return r;
}

function goodResult(id, over = {}) {
  const r = emptyResult(id);
  Object.assign(r, { name: 'Glucose', valueText: '95', value: 95, unit: 'mg/dL', referenceRange: { text: '65-99', low: 65, high: 99, kind: 'range' }, confidence: 1,
    fieldStatus: { value: 'found', unit: 'found', range: 'found', flag: 'na' } }, over);
  return r;
}

// ---------------------------------------------------------------- resultLike / isBoilerplate

test('resultLike recognizes result rows', () => {
  for (const t of [
    'Cholesterol, Total  210  High  mg/dL  100-199  01',
    'CHOLESTEROL, TOTAL  185  <200 mg/dL  EZ',
    'Hemoglobin A1c  5.4  %  4.8-5.6  01',
    'WBC  6.2  x10E3/uL  3.4-10.8  01',
    'eGFR  95  mL/min/1.73  >59  01',
    'Hepatitis B Surface Ag  NEGATIVE  NEGATIVE  01',
    'HIV Ag/Ab Screen  Non Reactive  Non Reactive',
    'PSA, TOTAL  <0.1  < OR = 4.0 ng/mL  EZ',
    'Platelets  450  High  x10E3/uL  150-450',
    'TSH  2.1 uIU/mL  0.45-4.5',
  ]) assert.equal(resultLike(t), true, t);
});

test('resultLike rejects headers, footers, labels and prose', () => {
  for (const t of [
    'DOB: 01/02/1980  Age: 45  Gender: M',
    'Date collected: 03/04/2025 0815 Local',
    'Phone: 800-762-4344',
    'Specimen ID: 063-123-4567-0',
    'Patient ID: 123456789',
    'Account Number: 12345678',
    'Page 1 of 3',
    '(c) 1995-2025 Laboratory Corporation of America Holdings',
    '01 BN  LabCorp Burlington  1447 York Court, Burlington, NC 272153361  Dir: William F Hancock, MD  Phone: 800-762-4344',
    'Date Issued: 03/05/25 1023 ET  FINAL REPORT  Page 1 of 3',
    'Lipid Panel',
    'TESTS  RESULT  FLAG  UNITS  REFERENCE INTERVAL  LAB',
    'Ordered Items: CBC With Differential/Platelet; Lipid Panel',
    'Fasting: Yes',
    '123456',
    '',
  ]) assert.equal(resultLike(t), false, t);
});

test('resultLike accepts Line objects and uses their cells', () => {
  const line = { text: 'Rubella Ab, IgG  Immune  Immune', cells: ['Rubella Ab, IgG', 'Immune', 'Immune'] };
  assert.equal(resultLike(line), true);
  assert.equal(resultLike({ text: 'Lipid Panel', cells: ['Lipid Panel'] }), false);
});

test('isBoilerplate matches known header/footer patterns only', () => {
  assert.equal(isBoilerplate('Page 2 of 4'), true);
  assert.equal(isBoilerplate('CLIENT SERVICES: 1.866.697.8378'), true);
  assert.equal(isBoilerplate('EZ  Quest Diagnostics Nichols Institute, 33608 Ortega Hwy, San Juan Capistrano, CA 92675-2042  CLIA: 05D0643352'), true);
  assert.equal(isBoilerplate('NPI: 1234567890'), true);
  assert.equal(isBoilerplate('Cholesterol, Total  210  High  mg/dL  100-199  01'), false);
  assert.equal(isBoilerplate('Please Note: Desirable range <100 mg/dL'), false);
  assert.equal(isBoilerplate({ text: 'Page 1 of 1' }), true);
});

// ---------------------------------------------------------------- scoreResult

test('scoreResult applies §5 penalties and clamps', () => {
  assert.equal(scoreResult(goodResult('r1')), 1);
  assert.equal(scoreResult(goodResult('r1', { unit: null, fieldStatus: { value: 'found', unit: 'missing', range: 'found', flag: 'na' } })), 1 - RESULT_PENALTIES.missingUnit);
  assert.equal(scoreResult(goodResult('r1', { referenceRange: { text: null, low: null, high: null, kind: null }, fieldStatus: { value: 'found', unit: 'found', range: 'missing', flag: 'na' } })), 1 - RESULT_PENALTIES.missingRange);
  assert.equal(scoreResult(goodResult('r1', { valueText: '', value: null, fieldStatus: { value: 'missing', unit: 'found', range: 'found', flag: 'na' } })), 1 - RESULT_PENALTIES.missingValue);
  assert.equal(scoreResult(goodResult('r1'), { wrapped: true }), 0.9);
  assert.equal(scoreResult(goodResult('r1'), { misaligned: true }), 0.9);
  assert.equal(scoreResult(goodResult('r1', { hints: { wrapped: true, misaligned: true } })), 0.8);
  // everything wrong → clamp at 0
  const bad = goodResult('r1', { valueText: '', value: null, unit: null, referenceRange: { text: null, low: null, high: null, kind: null }, fieldStatus: { value: 'missing', unit: 'missing', range: 'missing', flag: 'na' } });
  assert.ok(scoreResult(bad, { wrapped: true, misaligned: true }) >= 0);
});

test('scoreResult does not penalize text results for missing unit or range, and treats text ranges as N/A', () => {
  const txt = goodResult('r1', { valueText: 'NEGATIVE', value: null, unit: null, referenceRange: { text: null, low: null, high: null, kind: null }, fieldStatus: { value: 'found', unit: 'na', range: 'na', flag: 'na' } });
  assert.equal(scoreResult(txt), 1);
  const na = goodResult('r1', { referenceRange: { text: 'Not Estab.', low: null, high: null, kind: 'text' }, fieldStatus: { value: 'found', unit: 'found', range: 'found', flag: 'na' } });
  assert.equal(scoreResult(na), 1);
});

// ---------------------------------------------------------------- buildAudit

test('a clean, fully consumed report scores 1.0 and is labelled complete', () => {
  const doc = docFrom(['DOB: 01/02/1980', 'Glucose  95  mg/dL  65-99  01', 'Page 1 of 1']);
  const report = fullReport([goodResult('r1')]);
  const pr = { report, consumed: new Map([['p1l0', 'patient.dob'], ['p1l1', 'result:r1'], ['p1l2', 'pageno']]), notes: [], fieldEvidence: { 'patient.dob': ['p1l0'] } };
  const a = buildAudit(doc, pr, report);
  assert.equal(a.overall, 1);
  assert.equal(a.label, 'complete');
  assert.deepEqual(a.coverage, { totalLines: 3, consumedLines: 3, unconsumed: [], resultLikeUnconsumed: 0 });
  assert.deepEqual(a.pages, { declared: 1, seen: 1, complete: true });
  assert.deepEqual(a.results, { count: 1, fullyParsed: 1, withIssues: 0 });
  assert.deepEqual(a.fields['patient.dob'], { status: 'found', confidence: 1, evidence: ['p1l0'] });
  for (const p of [...REQUIRED_FIELDS, ...IMPORTANT_FIELDS]) assert.equal(a.fields[p].status, 'found', p);
  assert.deepEqual(a.warnings, []);
});

test('unconsumed lines are listed with result-like flags and cap the score at 0.94', () => {
  const doc = docFrom(['Glucose  95  mg/dL  65-99  01', 'Cholesterol  210  mg/dL  100-199  01', 'Some prose line', 'Page 1 of 1']);
  const report = fullReport([goodResult('r1')]);
  const pr = { report, consumed: new Map([['p1l0', 'result:r1'], ['p1l3', 'pageno']]), notes: [], fieldEvidence: {} };
  const a = buildAudit(doc, pr, report);
  assert.equal(a.coverage.totalLines, 4);
  assert.equal(a.coverage.consumedLines, 2);
  assert.deepEqual(a.coverage.unconsumed, [
    { lineId: 'p1l1', page: 1, text: 'Cholesterol  210  mg/dL  100-199  01', resultLike: true },
    { lineId: 'p1l2', page: 1, text: 'Some prose line', resultLike: false },
  ]);
  assert.equal(a.coverage.resultLikeUnconsumed, 1);
  assert.ok(a.overall <= CAPS.resultLikeUnconsumed);
  // coverage term: 1 - 1/(1+1) = 0.5 → 0.40 + 0.15 + 0.15 + 0.15*1 = 0.85 (below the cap, so no cap applied numerically)
  assert.equal(a.overall, 0.85);
  assert.equal(a.label, 'review');
  assert.ok(a.warnings.some((w) => /1 line that looks like a result was not parsed/.test(w)), a.warnings.join('|'));
});

test('a missing required field caps overall at 0.90 and names the field in plain English', () => {
  const doc = docFrom(['Page 1 of 1']);
  const report = fullReport([goodResult('r1')]);
  report.patient.dob = null;
  const pr = { report, consumed: new Map([['p1l0', 'pageno']]), notes: [], fieldEvidence: {} };
  const a = buildAudit(doc, pr, report);
  assert.equal(a.fields['patient.dob'].status, 'missing');
  assert.equal(a.fields['patient.dob'].confidence, 0);
  assert.ok(a.overall <= CAPS.requiredMissing);
  assert.ok(a.warnings.some((w) => /Required field not found: date of birth/.test(w)), a.warnings.join('|'));
  assert.equal(a.label, 'review');
});

test('uncertain fields count half and produce a warning', () => {
  const doc = docFrom(['Page 1 of 1']);
  const report = fullReport([goodResult('r1')]);
  const pr = { report, consumed: new Map([['p1l0', 'pageno']]), notes: [], fieldEvidence: {}, fieldStatus: { 'patient.dob': 'uncertain' } };
  const a = buildAudit(doc, pr, report);
  assert.equal(a.fields['patient.dob'].status, 'uncertain');
  assert.equal(a.fields['patient.dob'].confidence, 0.5);
  // required fraction = 7.5/8 → 0.40 * 0.9375 = 0.375; total = 0.975
  assert.equal(a.overall, 0.975);
  assert.ok(a.warnings.some((w) => /uncertain/.test(w)));
});

test('page completeness uses "Page X of Y" and the pages seen', () => {
  const doc = docFrom(['Page 1 of 3'], ['Page 2 of 3']);
  const report = fullReport([goodResult('r1')]);
  const pr = { report, consumed: new Map([['p1l0', 'pageno'], ['p2l0', 'pageno']]), notes: [], fieldEvidence: {} };
  const a = buildAudit(doc, pr, report);
  assert.deepEqual(a.pages, { declared: 3, seen: 2, complete: false });
  // pages term: 0.5 * 2/3 = 0.3333 → 0.85 + 0.15 * 0.3333 = 0.9
  assert.equal(a.overall, 0.9);
  assert.ok(a.warnings.some((w) => /declares 3 pages but only 2 were found/.test(w)), a.warnings.join('|'));
});

test('without page markers completeness is assumed but a warning is raised', () => {
  const doc = docFrom(['Glucose  95  mg/dL  65-99']);
  const report = fullReport([goodResult('r1')]);
  const pr = { report, consumed: new Map([['p1l0', 'result:r1']]), notes: [], fieldEvidence: {} };
  const a = buildAudit(doc, pr, report);
  assert.deepEqual(a.pages, { declared: null, seen: 1, complete: true });
  assert.ok(a.warnings.some((w) => /could not be verified/.test(w)));
});

test('weights follow §5 and labels follow the thresholds', () => {
  assert.deepEqual(WEIGHTS, { required: 0.40, important: 0.15, coverage: 0.30, pages: 0.15 });
  assert.deepEqual(LABEL_THRESHOLDS, { complete: 0.95, review: 0.80 });
  // Nothing found at all, nothing consumed → low score, incomplete
  const doc = docFrom(['Glucose  95  mg/dL  65-99', 'Sodium  140  mmol/L  135-145']);
  const report = emptyReport();
  const a = buildAudit(doc, { report, consumed: new Map(), notes: ['parser note here'], fieldEvidence: {} }, report);
  assert.equal(a.label, 'incomplete');
  assert.ok(a.overall < 0.5, `overall ${a.overall}`);
  assert.equal(a.results.count, 0);
  assert.ok(a.warnings.includes('parser note here'), 'parser notes become warnings');
  assert.ok(a.warnings.some((w) => /No result rows were recognized/.test(w)));
});

test('results with issues are counted', () => {
  const doc = docFrom(['Page 1 of 1']);
  const results = [goodResult('r1'), goodResult('r2', { unit: null, confidence: 0.75, fieldStatus: { value: 'found', unit: 'missing', range: 'found', flag: 'na' } })];
  const report = fullReport(results);
  const a = buildAudit(doc, { report, consumed: new Map([['p1l0', 'pageno']]), notes: [], fieldEvidence: {} }, report);
  assert.deepEqual(a.results, { count: 2, fullyParsed: 1, withIssues: 1 });
  assert.ok(a.warnings.some((w) => /1 of 2 results/.test(w)));
});

test('accepts consumed as a plain object and tolerates a missing report argument', () => {
  const doc = docFrom(['Page 1 of 1']);
  const report = fullReport([]);
  const a = buildAudit(doc, { report, consumed: { p1l0: 'pageno' }, notes: [], fieldEvidence: {} });
  assert.equal(a.coverage.consumedLines, 1);
  assert.equal(a.fields['patient.fullName'].status, 'found');
});
