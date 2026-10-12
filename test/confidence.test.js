import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAudit, resultLike, resultRowLike, isBoilerplate, scoreResult, WEIGHTS, CAPS, LABEL_THRESHOLDS, RESULT_PENALTIES,
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

test('scoreResult does not penalize text results for missing unit or range, and never penalizes a printed text range', () => {
  const txt = goodResult('r1', { valueText: 'NEGATIVE', value: null, unit: null, referenceRange: { text: null, low: null, high: null, kind: null }, fieldStatus: { value: 'found', unit: 'na', range: 'na', flag: 'na' } });
  assert.equal(scoreResult(txt), 1);
  // N/A-style text range → status 'na', no penalty (even if the parser said 'missing')
  const na = goodResult('r1', { referenceRange: { text: 'Not Estab.', low: null, high: null, kind: 'text' }, fieldStatus: { value: 'found', unit: 'found', range: 'found', flag: 'na' } });
  assert.equal(scoreResult(na), 1);
  const na2 = goodResult('r1', { referenceRange: { text: 'N/A', low: null, high: null, kind: 'text' }, fieldStatus: { value: 'found', unit: 'found', range: 'missing', flag: 'na' } });
  assert.equal(scoreResult(na2), 1);
  // any other printed text range IS a range → found, no penalty
  const txtRange = goodResult('r1', { referenceRange: { text: 'Negative', low: null, high: null, kind: 'text' }, fieldStatus: { value: 'found', unit: 'found', range: 'found', flag: 'na' } });
  assert.equal(scoreResult(txtRange), 1);
  const txtRange2 = goodResult('r1', { referenceRange: { text: 'age dependent', low: null, high: null, kind: 'text' }, fieldStatus: { value: 'found', unit: 'found', range: 'uncertain', flag: 'na' } });
  assert.equal(scoreResult(txtRange2), 1);
  // numeric value with NO printed range → penalized
  const none = goodResult('r1', { referenceRange: { text: null, low: null, high: null, kind: null }, fieldStatus: { value: 'found', unit: 'found', range: 'missing', flag: 'na' } });
  assert.equal(scoreResult(none), 1 - RESULT_PENALTIES.missingRange);
  // explicit 'na' status with no text → not penalized (parser decided the range does not apply)
  const explicitNA = goodResult('r1', { referenceRange: { text: null, low: null, high: null, kind: null }, fieldStatus: { value: 'found', unit: 'found', range: 'na', flag: 'na' } });
  assert.equal(scoreResult(explicitNA), 1);
});

// ---------------------------------------------------------------- resultRowLike (strict shape)

test('resultRowLike accepts full result rows in Labcorp, Quest classic and MyQuest shapes', () => {
  for (const t of [
    'WBC  6.8  x10E3/uL  3.4-10.8  01',
    'Neutrophils  58  %  Not Estab.  01',
    'BUN/Creatinine Ratio  15  9-20  01',
    'eGFR  92  mL/min/1.73  >59  01',
    'Cholesterol, Total  210  High  mg/dL  100-199  01',
    'Vitamin B12  512  pg/mL  232-1245  02',
    'Chol/HDL Ratio  4.4  ratio  0.0-5.0  01',
    'CHOLESTEROL, TOTAL  185  <200 mg/dL  EZ',
    'CHOLESTEROL, TOTAL  210 H  <200 mg/dL  EZ',
    'PSA, TOTAL  <0.1  < OR = 4.0 ng/mL  EZ',
    'ABSOLUTE NEUTROPHILS  3944  1500-7800 cells/uL  EZ',
    'WHITE BLOOD CELL COUNT  7.9 Thousand/uL  4.5-13.5 Thousand/uL',
    'HDL CHOLESTEROL  52 mg/dL  > OR = 45 mg/dL',
    'HEMOGLOBIN A1c  6.2* %  <5.7 %',
    '25-OH Vitamin D  24.3  ng/mL  30.0-100.0  01',
    'Hepatitis B Surface Ag  NEGATIVE  NEGATIVE  01',
    'HIV Ag/Ab Screen  Non Reactive  Non Reactive  EZ',
    'TSH  2.150  uIU/mL',
    'Glucose  104  High',
  ]) assert.equal(resultRowLike(t), true, t);
  assert.equal(resultLike('WBC  6.8  x10E3/uL  3.4-10.8  01', { strict: true }), true);
});

test('resultRowLike rejects prose comments that mention numbers and units, labels, wraps and headers', () => {
  for (const t of [
    'Desirable range <100 mg/dL for primary prevention goal.',
    'Prediabetes: 5.7 - 6.4',
    'Diabetes: >6.4',
    'Glycemic control for adults with diabetes: <7.0',
    'Vitamin D deficiency has been defined by the Endocrine Society as a level of <20 ng/mL.',
    '. Reference Range: > OR = 60 mL/min/1.73m2',
    '. Please note: Triglyceride results above 400 mg/dL may',
    '. between 5.7% and 6.4% is consistent with prediabetes and',
    'Reference Range:  <5.7 % of total Hgb',
    'Reference range: <100',
    '. Vitamin D Status: Deficiency <20 ng/mL; Insufficiency 20-29 ng/mL; Optimal 30-100 ng/mL.',
    'Reference range for TSH is age dependent; 0.40-4.50 mIU/L applies to adults 21 and older.',
    'Deficiency: <20 ng/mL',
    'Optimal: > OR = 30 ng/mL',
    'Please Note:  01',
    'Comment:  01',
    'Estimated Average',
    '25-Hydroxy',
    'CBC With Differential/Platelet',
    'DOB: 01/02/1980  Age: 45  Gender: M',
    'Phone: 800-762-4344',
    'Specimen ID: 063-123-4567-0',
    'TESTS  RESULT  FLAG  UNITS  REFERENCE INTERVAL  LAB',
    'Page 1 of 3',
    '01 BN  LabCorp Burlington  1447 York Court, Burlington, NC 272153361  Dir: William F Hancock, MD  Phone: 800-762-4344',
    'Date Issued: 03/05/25 1023 ET  FINAL REPORT  Page 1 of 3',
    'Collected on 03/04/2025  08:15 AM',
    '',
  ]) assert.equal(resultRowLike(t), false, t);
  assert.equal(resultRowLike({ text: 'Please Note:  01', cells: ['Please Note:', '01'] }), false);
  // the broad heuristic still flags prose with a number + unit when it is UNCONSUMED
  assert.equal(resultLike('Desirable range <100 mg/dL for primary prevention goal.'), true);
});

test('lines consumed as comments that look like result rows are listed as suspiciousConsumed and cap the score at 0.94', () => {
  const doc = docFrom([
    'Glucose  95  mg/dL  65-99  01',
    'BUN  15  mg/dL  6-24  01',
    'Creatinine  1.02  mg/dL  0.76-1.27  01',
    'Desirable range <100 mg/dL for primary prevention goal.',
    'Page 1 of 1',
  ]);
  const report = fullReport([goodResult('r1')]);
  const pr = { report, consumed: new Map([['p1l0', 'result:r1'], ['p1l1', 'comment:r1'], ['p1l2', 'comment'], ['p1l3', 'comment:r1'], ['p1l4', 'pageno']]), notes: [], fieldEvidence: {} };
  const a = buildAudit(doc, pr, report);
  assert.equal(a.coverage.consumedLines, 5);
  assert.deepEqual(a.coverage.unconsumed, []);
  assert.equal(a.coverage.resultLikeUnconsumed, 0);
  assert.deepEqual(a.coverage.suspiciousConsumed, [
    { lineId: 'p1l1', page: 1, text: 'BUN  15  mg/dL  6-24  01', tag: 'comment:r1' },
    { lineId: 'p1l2', page: 1, text: 'Creatinine  1.02  mg/dL  0.76-1.27  01', tag: 'comment' },
  ]);
  assert.equal(a.coverage.resultLikeTotal, 2);
  assert.ok(a.overall <= CAPS.resultLikeUnconsumed, `overall ${a.overall}`);
  // coverage term: 1 - 2/(1+2) = 0.333 → 0.40 + 0.15 + 0.30*0.333 + 0.15 = 0.8
  assert.equal(a.overall, 0.8);
  assert.notEqual(a.label, 'complete');
  assert.ok(a.warnings.some((w) => /2 lines consumed as comments look like result rows \(p1l1, p1l2\)/.test(w)), a.warnings.join('|'));
});

test('a wrapped-name continuation that is itself a full result row is suspicious; genuine wraps and comments are not', () => {
  const doc = docFrom([
    'Vitamin D,',
    '25-Hydroxy  24.3  ng/mL  30.0-100.0  01',
    'Hemoglobin',
    'A1c  5.4  %  4.8-5.6  01',
    'Please Note:  01',
    'Prediabetes: 5.7 - 6.4',
    'Page 1 of 1',
  ]);
  const report = fullReport([goodResult('r1'), goodResult('r2')]);
  const pr = { report, consumed: new Map([['p1l0', 'result:r1:wrap'], ['p1l1', 'result:r1'], ['p1l2', 'result:r2:name-wrap'], ['p1l3', 'result:r2:wrap'], ['p1l4', 'comment:r2'], ['p1l5', 'comment:r2'], ['p1l6', 'pageno']]), notes: [], fieldEvidence: {} };
  const a = buildAudit(doc, pr, report);
  assert.deepEqual(a.coverage.suspiciousConsumed.map((s) => s.lineId), ['p1l3']);
  assert.ok(a.overall <= CAPS.resultLikeUnconsumed);
  assert.ok(a.warnings.some((w) => /1 line consumed as comments looks like result row \(p1l3\)/.test(w)), a.warnings.join('|'));
});

test('a result-like line consumed with a non-comment tag (header, footer, result) is never suspicious', () => {
  const doc = docFrom(['Glucose  95  mg/dL  65-99  01', 'Cholesterol  210  mg/dL  100-199  01', 'Page 1 of 1']);
  const report = fullReport([goodResult('r1')]);
  const pr = { report, consumed: new Map([['p1l0', 'result:r1'], ['p1l1', 'footer:lab'], ['p1l2', 'pageno']]), notes: [], fieldEvidence: {} };
  const a = buildAudit(doc, pr, report);
  assert.deepEqual(a.coverage.suspiciousConsumed, []);
  assert.equal(a.overall, 1);
});

// ---------------------------------------------------------------- buildAudit

test('a clean, fully consumed report scores 1.0 and is labelled complete', () => {
  const doc = docFrom(['DOB: 01/02/1980', 'Glucose  95  mg/dL  65-99  01', 'Page 1 of 1']);
  const report = fullReport([goodResult('r1')]);
  const pr = { report, consumed: new Map([['p1l0', 'patient.dob'], ['p1l1', 'result:r1'], ['p1l2', 'pageno']]), notes: [], fieldEvidence: { 'patient.dob': ['p1l0'] } };
  const a = buildAudit(doc, pr, report);
  assert.equal(a.overall, 1);
  assert.equal(a.label, 'complete');
  assert.deepEqual(a.coverage, { totalLines: 3, consumedLines: 3, unconsumed: [], resultLikeUnconsumed: 0, suspiciousConsumed: [], resultLikeTotal: 0 });
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
