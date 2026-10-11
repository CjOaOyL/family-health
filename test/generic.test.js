import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLines } from '../src/pdf/lines.js';
import { parseGeneric, findLabelPairs, parseResultRow, normalizeRangeText } from '../src/parse/generic.js';
import { buildAudit, scoreResult } from '../src/audit/confidence.js';

/** rows: [y, [[x, str], ...]] → Page built through the real line builder. */
function page(rows, n, cw = 4.5) {
  const items = [];
  for (const [y, cells] of rows) for (const [x, str] of cells) items.push({ str, x, y, w: str.length * cw, h: 9 });
  return { pageNumber: n, width: 612, height: 792, lines: buildLines(items, 612, 792, n) };
}
const docOf = (...pages) => ({ fileName: 't.pdf', fileHash: 'h', pageCount: pages.length, pages });

const LABCORP_P1 = page([
  [40, [[36, 'Labcorp'], [400, 'Patient Report']]],
  [55, [[36, 'DOE, JANE M']]],
  [70, [[36, 'Patient Details'], [220, 'Specimen Details'], [420, 'Physician Details']]],
  [82, [[36, 'DOB: 01/02/1980'], [220, 'Date collected: 03/04/2025 0815 Local'], [420, 'Ordering: J SMITH']]],
  [94, [[36, 'Age: 45'], [220, 'Date received: 03/04/2025'], [420, 'Referring:']]],
  [106, [[36, 'Gender: F'], [220, 'Date reported: 03/05/2025 1023 ET'], [420, 'NPI: 1234567890']]],
  [118, [[36, 'Patient ID: 123456789'], [220, 'Specimen ID: 063-123-4567-0'], [420, 'Account Number: 12345678']]],
  [130, [[36, 'Fasting: Yes']]],
  [150, [[36, 'Ordered Items: Lipid Panel; Hemoglobin A1c']]],
  [170, [[36, 'TESTS'], [200, 'RESULT'], [260, 'FLAG'], [310, 'UNITS'], [380, 'REFERENCE INTERVAL'], [520, 'LAB']]],
  [185, [[36, 'Lipid Panel']]],
  [200, [[44, 'Cholesterol, Total'], [200, '210'], [260, 'High'], [310, 'mg/dL'], [380, '100-199'], [520, '01']]],
  [215, [[44, 'Triglycerides'], [200, '95'], [310, 'mg/dL'], [380, '0-149'], [520, '01']]],
  [230, [[44, 'HDL Cholesterol'], [200, '62'], [310, 'mg/dL'], [380, '>39'], [520, '01']]],
  [245, [[44, 'LDL Chol Calc (NIH)'], [200, '130'], [260, 'High'], [310, 'mg/dL'], [380, '0-99'], [520, '01']]],
  [260, [[52, 'Please Note: Desirable range <100 mg/dL for primary prevention goal.']]],
  [280, [[36, 'Hemoglobin A1c']]],
  [295, [[44, 'Hemoglobin A1c'], [200, '5.4'], [310, '%'], [380, '4.8-5.6'], [520, '01']]],
  [310, [[52, 'Prediabetes: 5.7 - 6.4']]],
  [325, [[52, 'Diabetes: >6.4']]],
  [340, [[44, 'Hepatitis B Surface Ag'], [200, 'Negative'], [380, 'Negative'], [520, '01']]],
  [355, [[44, 'Estimated Average Glucose'], [200, '108'], [310, 'mg/dL'], [520, '01']]],
  [700, [[36, '01 BN'], [80, 'LabCorp Burlington'], [180, '1447 York Court, Burlington, NC 272153361'], [400, 'Dir: William F Hancock, MD'], [540, 'Phone: 800-762-4344']]],
  [720, [[36, 'Date Issued: 03/05/25 1023 ET'], [300, 'FINAL REPORT'], [500, 'Page 1 of 2']]],
  [740, [[36, '(c) 1995-2025 Laboratory Corporation of America Holdings']]],
], 1);

const LABCORP_P2 = page([
  [40, [[36, 'Labcorp'], [400, 'Patient Report']]],
  [55, [[36, 'DOE, JANE M']]],
  [82, [[36, 'DOB: 01/02/1980'], [220, 'Date collected: 03/04/2025 0815 Local'], [420, 'Ordering: J SMITH']]],
  [170, [[36, 'TESTS'], [200, 'RESULT'], [260, 'FLAG'], [310, 'UNITS'], [380, 'REFERENCE INTERVAL'], [520, 'LAB']]],
  [185, [[36, 'CBC With Differential/Platelet']]],
  [200, [[44, 'WBC'], [200, '6.2'], [310, 'x10E3/uL'], [380, '3.4-10.8'], [520, '01']]],
  [215, [[44, 'Platelets'], [200, '110'], [260, 'Low'], [310, 'x10E3/uL'], [380, '150-450'], [520, '01']]],
  [230, [[44, 'Immature Granulocytes']]],
  [245, [[44, '(Absolute)'], [200, '0.0'], [310, 'x10E3/uL'], [380, '0.0-0.1'], [520, '01']]],
  [720, [[36, 'Date Issued: 03/05/25 1023 ET'], [300, 'FINAL REPORT'], [500, 'Page 2 of 2']]],
], 2);

test('parses Labcorp-style header fields with evidence', () => {
  const pr = parseGeneric(docOf(LABCORP_P1, LABCORP_P2));
  const { patient, specimen, provider, source } = pr.report;
  assert.equal(patient.fullName, 'DOE, JANE M');
  assert.equal(patient.lastName, 'DOE');
  assert.equal(patient.firstName, 'JANE');
  assert.equal(patient.middleName, 'M');
  assert.equal(patient.dob, '1980-01-02');
  assert.equal(patient.ageAtCollection, 45);
  assert.equal(patient.sex, 'F');
  assert.equal(patient.patientId, '123456789');
  assert.equal(specimen.collectedAt, '2025-03-04T08:15');
  assert.equal(specimen.collectedTz, 'Local');
  assert.equal(specimen.receivedAt, '2025-03-04');
  assert.equal(specimen.reportedAt, '2025-03-05T10:23');
  assert.equal(specimen.specimenId, '063-123-4567-0');
  assert.equal(specimen.fasting, true);
  assert.equal(provider.orderingName, 'J SMITH');
  assert.equal(provider.referringName, undefined);
  assert.equal(provider.npi, '1234567890');
  assert.equal(provider.accountNumber, '12345678');
  assert.equal(source.reportStatus, 'final');
  assert.deepEqual(pr.fieldEvidence['patient.dob'], ['p1l3', 'p2l2']);
  assert.deepEqual(pr.fieldEvidence['specimen.specimenId'], ['p1l6']);
  assert.ok(pr.fieldEvidence['patient.fullName'].includes('p1l1'));
});

test('parses Labcorp-style result rows, panels, comments and the lab legend', () => {
  const pr = parseGeneric(docOf(LABCORP_P1, LABCORP_P2));
  const rs = pr.report.results;
  assert.deepEqual(rs.map((r) => r.id), rs.map((_, i) => `r${i + 1}`));
  const chol = rs.find((r) => r.name === 'Cholesterol, Total');
  assert.equal(chol.panel, 'Lipid Panel');
  assert.equal(chol.valueText, '210');
  assert.equal(chol.value, 210);
  assert.equal(chol.flag, 'H');
  assert.equal(chol.unit, 'mg/dL');
  assert.deepEqual(chol.referenceRange, { text: '100-199', low: 100, high: 199, kind: 'range' });
  assert.equal(chol.performingLabCode, '01');
  assert.deepEqual(chol.lineIds, ['p1l11']);
  assert.deepEqual(chol.fieldStatus, { value: 'found', unit: 'found', range: 'found', flag: 'found' });
  assert.equal(chol.page, 1);

  const hdl = rs.find((r) => r.name === 'HDL Cholesterol');
  assert.deepEqual(hdl.referenceRange, { text: '>39', low: 39, high: null, kind: 'gt' });

  const ldl = rs.find((r) => r.name === 'LDL Chol Calc (NIH)');
  assert.match(ldl.comment, /Desirable range <100 mg\/dL/);
  assert.ok(ldl.lineIds.includes('p1l15'));

  const a1c = rs.find((r) => r.name === 'Hemoglobin A1c');
  assert.equal(a1c.panel, 'Hemoglobin A1c');
  assert.equal(a1c.unit, '%');
  assert.match(a1c.comment, /Prediabetes: 5.7 - 6.4 Diabetes: >6.4/);

  const hep = rs.find((r) => r.name === 'Hepatitis B Surface Ag');
  assert.equal(hep.valueText, 'Negative');
  assert.equal(hep.value, null);
  assert.equal(hep.referenceRange.kind, 'text');
  assert.equal(hep.fieldStatus.unit, 'na');

  const eag = rs.find((r) => r.name === 'Estimated Average Glucose');
  assert.equal(eag.fieldStatus.range, 'missing');
  assert.equal(scoreResult(eag), 0.75);

  assert.deepEqual(pr.report.panels.map((p) => p.name), ['Lipid Panel', 'Hemoglobin A1c', 'CBC With Differential/Platelet']);
  assert.deepEqual(pr.report.panels[0].resultIds, ['r1', 'r2', 'r3', 'r4']);

  assert.equal(pr.report.performingLabs.length, 1);
  const lab = pr.report.performingLabs[0];
  assert.equal(lab.code, '01');
  assert.equal(lab.name, 'LabCorp Burlington');
  assert.match(lab.address, /1447 York Court/);
  assert.equal(lab.director, 'William F Hancock, MD');
  assert.equal(lab.phone, '800-762-4344');
});

test('merges a wrapped result name and marks it with a wrapped hint', () => {
  const pr = parseGeneric(docOf(LABCORP_P1, LABCORP_P2));
  const ig = pr.report.results.find((r) => /Immature Granulocytes/.test(r.name));
  assert.ok(ig, 'wrapped row parsed');
  assert.equal(ig.name, 'Immature Granulocytes (Absolute)');
  assert.deepEqual(ig.lineIds, ['p2l7', 'p2l8']);
  assert.deepEqual(ig.hints, { wrapped: true });
  assert.equal(scoreResult(ig), 0.9);
  assert.equal(ig.panel, 'CBC With Differential/Platelet');
  const plt = pr.report.results.find((r) => r.name === 'Platelets');
  assert.equal(plt.flag, 'L');
});

test('consumes every line of the Labcorp-style document (nothing result-like left over)', () => {
  const doc = docOf(LABCORP_P1, LABCORP_P2);
  const pr = parseGeneric(doc);
  const total = doc.pages.reduce((n, p) => n + p.lines.length, 0);
  const unconsumed = doc.pages.flatMap((p) => p.lines).filter((l) => !pr.consumed.has(l.id)).map((l) => l.text);
  assert.deepEqual(unconsumed, []);
  assert.equal(pr.consumed.size, total);
  assert.equal(pr.consumed.get('p1l9'), 'tableheader');
  assert.equal(pr.consumed.get('p1l10'), 'panel');
  assert.equal(pr.consumed.get('p1l11'), 'result:r1');
  assert.equal(pr.consumed.get('p1l15'), 'comment');
  assert.equal(pr.consumed.get('p1l22'), 'performinglab');
  assert.equal(pr.consumed.get('p1l24'), 'boilerplate');
  assert.ok(/^header/.test(pr.consumed.get('p1l3')));
  for (const r of pr.report.results) r.confidence = scoreResult(r);
  const audit = buildAudit(doc, pr, { ...pr.report, source: { vendor: 'labcorp' } });
  assert.equal(audit.coverage.resultLikeUnconsumed, 0);
  assert.deepEqual(audit.pages, { declared: 2, seen: 2, complete: true });
  assert.ok(pr.notes.some((n) => /Generic parser used/.test(n)));
});

const QUEST_P1 = page([
  [40, [[400, 'Quest Diagnostics'], [540, 'FINAL']]],
  [60, [[36, 'Patient Information'], [220, 'Specimen Information'], [420, 'Client Information']]],
  [72, [[36, 'DOE, JOHN Q'], [220, 'Specimen: AB123456C'], [420, 'Client #: 12345678']]],
  [84, [[36, 'DOB: 05/06/1975  AGE: 50'], [220, 'Requisition: 0012345'], [420, 'DR. JANE SMITH']]],
  [96, [[36, 'Gender: M'], [220, 'Lab Ref #: 1234567'], [420, '123 Main St Suite 4']]],
  [108, [[36, 'Patient ID: 987654'], [220, 'Collected: 03/04/2025 / 08:15 EDT'], [420, 'Anytown, NJ 07001']]],
  [120, [[36, 'Phone: 201.555.0100'], [220, 'Received: 03/04/2025 / 20:10 EDT']]],
  [132, [[220, 'Reported: 03/05/2025 / 09:30 EDT']]],
  [150, [[36, 'Test Name'], [220, 'In Range'], [290, 'Out of Range'], [380, 'Reference Range'], [540, 'Lab']]],
  [165, [[36, 'CBC (INCLUDES DIFF/PLT)']]],
  [180, [[44, 'WHITE BLOOD CELL COUNT'], [220, '6.2'], [380, '3.8-10.8 Thousand/uL'], [540, 'EZ']]],
  [195, [[44, 'HEMOGLOBIN'], [290, '12.1 L'], [380, '13.2-17.1 g/dL'], [540, 'EZ']]],
  [210, [[44, 'PLATELET COUNT'], [220, '250'], [380, '140-400 Thousand/uL'], [540, 'EZ']]],
  [225, [[36, 'HEMOGLOBIN A1c']]],
  [240, [[44, 'HEMOGLOBIN A1c'], [220, '5.5'], [380, '<5.7 % of total Hgb'], [540, 'EZ']]],
  [255, [[52, 'Reference Range: <5.7 Normal; 5.7-6.4 Prediabetes; >6.4 Diabetes']]],
  [270, [[36, 'HEPATITIS B SURFACE ANTIGEN']]],
  [285, [[44, 'HEPATITIS B SURFACE AG'], [220, 'NON-REACTIVE'], [380, 'NON-REACTIVE'], [540, 'EZ']]],
  [300, [[44, 'VITAMIN D, 25-OH, TOTAL'], [220, '32'], [380, '30-100 ng/mL'], [540, 'PR']]],
  [315, [[44, 'PSA, TOTAL'], [220, '<0.1'], [380, '< OR = 4.0 ng/mL'], [540, 'EZ']]],
  [680, [[36, 'PERFORMING SITE:']]],
  [692, [[36, 'EZ'], [60, 'Quest Diagnostics Nichols Institute, 33608 Ortega Hwy, San Juan Capistrano, CA 92675-2042  Laboratory Director: John Doe MD, CLIA: 05D0643352']]],
  [704, [[36, 'PR'], [60, 'Quest Diagnostics-Teterboro, 1 Malcolm Ave, Teterboro, NJ 07608  Laboratory Director: Jane Roe MD, CLIA: 31D0696246']]],
  [720, [[36, 'CLIENT SERVICES: 1.866.697.8378'], [500, 'Page 1 of 1']]],
], 1);

test('parses Quest-style header blocks including unlabelled name and DR. cells', () => {
  const pr = parseGeneric(docOf(QUEST_P1));
  const { patient, specimen, provider } = pr.report;
  assert.equal(patient.fullName, 'DOE, JOHN Q');
  assert.equal(patient.dob, '1975-05-06');
  assert.equal(patient.ageAtCollection, 50);
  assert.equal(patient.sex, 'M');
  assert.equal(patient.patientId, '987654');
  assert.equal(patient.phone, '201.555.0100');
  assert.equal(specimen.specimenId, 'AB123456C');
  assert.equal(specimen.requisition, '0012345');
  assert.equal(specimen.labRef, '1234567');
  assert.equal(specimen.collectedAt, '2025-03-04T08:15');
  assert.equal(specimen.collectedTz, 'EDT');
  assert.equal(specimen.receivedAt, '2025-03-04T20:10');
  assert.equal(specimen.reportedAt, '2025-03-05T09:30');
  assert.equal(provider.accountNumber, '12345678');
  assert.equal(provider.orderingName, 'DR. JANE SMITH');
  assert.equal(pr.report.source.reportStatus, 'final');
});

test('parses Quest-style rows: value+flag cells, units inside the range cell, "< OR =" ranges, two labs', () => {
  const pr = parseGeneric(docOf(QUEST_P1));
  const rs = pr.report.results;
  const wbc = rs.find((r) => r.name === 'WHITE BLOOD CELL COUNT');
  assert.equal(wbc.value, 6.2);
  assert.equal(wbc.unit, 'Thousand/uL');
  assert.deepEqual(wbc.referenceRange, { text: '3.8-10.8', low: 3.8, high: 10.8, kind: 'range' });
  assert.equal(wbc.performingLabCode, 'EZ');
  assert.equal(wbc.panel, 'CBC (INCLUDES DIFF/PLT)');

  const hgb = rs.find((r) => r.name === 'HEMOGLOBIN');
  assert.equal(hgb.value, 12.1);
  assert.equal(hgb.flag, 'L');
  assert.equal(hgb.unit, 'g/dL');

  const a1c = rs.find((r) => r.name === 'HEMOGLOBIN A1c');
  assert.equal(a1c.unit, '%');
  assert.deepEqual(a1c.referenceRange, { text: '<5.7', low: null, high: 5.7, kind: 'lt' });
  assert.match(a1c.comment, /Reference Range: <5.7 Normal/);

  const psa = rs.find((r) => r.name === 'PSA, TOTAL');
  assert.equal(psa.valueText, '<0.1');
  assert.equal(psa.value, 0.1);
  assert.equal(psa.valueQualifier, '<');
  assert.equal(psa.unit, 'ng/mL');
  assert.deepEqual(psa.referenceRange, { text: '<=4.0', low: null, high: 4, kind: 'le' });

  const vitd = rs.find((r) => r.name === 'VITAMIN D, 25-OH, TOTAL');
  assert.equal(vitd.performingLabCode, 'PR');

  const hep = rs.find((r) => r.name === 'HEPATITIS B SURFACE AG');
  assert.equal(hep.valueText, 'NON-REACTIVE');
  assert.equal(hep.value, null);

  assert.deepEqual(pr.report.performingLabs.map((l) => [l.code, l.name, l.clia]), [
    ['EZ', 'Quest Diagnostics Nichols Institute', '05D0643352'],
    ['PR', 'Quest Diagnostics-Teterboro', '31D0696246'],
  ]);
  assert.equal(pr.report.performingLabs[0].address, '33608 Ortega Hwy, San Juan Capistrano, CA 92675-2042');
  assert.equal(pr.report.performingLabs[0].director, 'John Doe MD');

  const unconsumed = QUEST_P1.lines.filter((l) => !pr.consumed.has(l.id)).map((l) => l.text);
  assert.deepEqual(unconsumed, []);
});

test('findLabelPairs splits several labels on one line and prefers longer labels', () => {
  const pairs = findLabelPairs('Patient ID: 123456789  Specimen ID: 063-123-4567-0  Account Number: 12345678');
  assert.deepEqual(pairs.map((p) => [p.field.path, p.value]), [
    ['patient.patientId', '123456789'],
    ['specimen.specimenId', '063-123-4567-0'],
    ['provider.accountNumber', '12345678'],
  ]);
  const dob = findLabelPairs('DOB: 05/06/1975  AGE: 50');
  assert.deepEqual(dob.map((p) => [p.field.path, p.value]), [['patient.dob', '05/06/1975'], ['patient.ageAtCollection', '50']]);
  assert.deepEqual(findLabelPairs('Collected on 03/04/2025').map((p) => p.field.path), ['specimen.collectedAt']);
  assert.deepEqual(findLabelPairs('Cholesterol, Total  210'), []);
});

test('parseResultRow falls back to splitting single-cell text and rejects notes', () => {
  const row = parseResultRow({ text: 'Glucose 95 mg/dL 65 - 99', cells: ['Glucose 95 mg/dL 65 - 99'] });
  assert.ok(row);
  assert.equal(row.name, 'Glucose');
  assert.equal(row.tail.value.value, 95);
  assert.equal(row.tail.unit, 'mg/dL');
  assert.deepEqual(row.tail.range, { text: '65-99', low: 65, high: 99, kind: 'range' });
  assert.equal(parseResultRow({ text: 'Please Note: Desirable range <100 mg/dL', cells: ['Please Note: Desirable range <100 mg/dL'] }), null);
  assert.equal(parseResultRow({ text: 'Lipid Panel', cells: ['Lipid Panel'] }), null);
  assert.equal(parseResultRow({ text: 'DOB: 01/02/1980', cells: ['DOB: 01/02/1980'] }), null);
});

test('normalizeRangeText folds Quest "< OR =" phrasing', () => {
  assert.equal(normalizeRangeText('< OR = 4.0'), '<=4.0');
  assert.equal(normalizeRangeText('> OR = 60'), '>=60');
  assert.equal(normalizeRangeText('3.4-10.8'), '3.4-10.8');
});

test('conflicting header values across pages are noted and marked uncertain', () => {
  const p2 = page([[82, [[36, 'DOB: 01/03/1980']]]], 2);
  const pr = parseGeneric(docOf(LABCORP_P1, p2));
  assert.equal(pr.report.patient.dob, '1980-01-02', 'first value wins');
  assert.equal(pr.fieldStatus['patient.dob'], 'uncertain');
  assert.ok(pr.notes.some((n) => /patient\.dob differs between pages/.test(n)));
  const audit = buildAudit(docOf(LABCORP_P1, p2), pr, { ...pr.report, source: { vendor: 'labcorp' } });
  assert.equal(audit.fields['patient.dob'].status, 'uncertain');
  assert.equal(audit.fields['patient.dob'].confidence, 0.5);
});

test('never fabricates: an unknown document yields empty fields and a note', () => {
  const pr = parseGeneric(docOf(page([[40, [[36, 'Some prose about nothing']]], [60, [[36, 'Another line']]]], 1)));
  assert.deepEqual(pr.report.results, []);
  assert.deepEqual(pr.report.patient, {});
  assert.equal(pr.consumed.size, 0);
  assert.ok(pr.notes.some((n) => /no result rows/.test(n)));
});
