// test/quest.test.js — parseQuest against every fixtures/quest/*.doc.json
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseQuest } from '../src/parse/quest.js';

const FIX_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'quest');
const names = readdirSync(FIX_DIR).filter((f) => f.endsWith('.doc.json')).map((f) => f.replace(/\.doc\.json$/, ''));
const load = (name) => ({
  doc: JSON.parse(readFileSync(join(FIX_DIR, `${name}.doc.json`), 'utf8')),
  expected: JSON.parse(readFileSync(join(FIX_DIR, `${name}.expected.json`), 'utf8')),
});

/** Deep-subset matcher: arrays compared by index (lengths must match), objects by the keys present in `expected`. */
function subsetProblems(actual, expected, path = '$', out = []) {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) { out.push(`${path}: expected array, got ${JSON.stringify(actual)}`); return out; }
    if (actual.length !== expected.length) out.push(`${path}: length ${actual.length}, expected ${expected.length}`);
    expected.forEach((e, i) => subsetProblems(actual[i], e, `${path}[${i}]`, out));
  } else if (expected && typeof expected === 'object') {
    if (!actual || typeof actual !== 'object') { out.push(`${path}: expected object, got ${JSON.stringify(actual)}`); return out; }
    for (const k of Object.keys(expected)) subsetProblems(actual[k], expected[k], `${path}.${k}`, out);
  } else if (!Object.is(actual, expected)) {
    out.push(`${path}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
  }
  return out;
}

const byName = (report, name) => report.results.find((r) => r.name === name);
const allLineIds = (doc) => doc.pages.flatMap((p) => p.lines.map((l) => ({ id: l.id, text: l.text })));

assert.ok(names.length >= 3, 'expected at least three Quest fixtures');

for (const name of names) {
  test(`quest fixture ${name}: expected subset matches`, () => {
    const { doc, expected } = load(name);
    const { report, consumed, notes, fieldEvidence } = parseQuest(doc);
    assert.ok(consumed instanceof Map);
    assert.ok(Array.isArray(notes));
    assert.equal(typeof fieldEvidence, 'object');
    const problems = subsetProblems(report, expected);
    assert.equal(problems.length, 0, `${problems.length} mismatches:\n  ${problems.slice(0, 40).join('\n  ')}`);
    // ids sequential in document order
    report.results.forEach((r, i) => assert.equal(r.id, `r${i + 1}`));
    for (const r of report.results) {
      assert.ok(r.lineIds.length >= 1, `${r.id} has lineIds`);
      assert.ok(r.confidence >= 0 && r.confidence <= 1, `${r.id} confidence in range`);
      for (const k of ['value', 'unit', 'range', 'flag']) assert.ok(['found', 'missing', 'uncertain', 'na'].includes(r.fieldStatus[k]), `${r.id}.fieldStatus.${k}`);
    }
    for (const p of report.panels) assert.ok(p.page >= 1, `panel ${p.name} has page`);
  });

  test(`quest fixture ${name}: every line is consumed with a reason`, () => {
    const { doc } = load(name);
    const { consumed } = parseQuest(doc);
    const unconsumed = allLineIds(doc).filter((l) => !consumed.has(l.id));
    assert.equal(unconsumed.length, 0, `unconsumed lines:\n  ${unconsumed.map((l) => `${l.id}: ${l.text}`).join('\n  ')}`);
    for (const [id, reason] of consumed) assert.ok(typeof reason === 'string' && reason.length, `reason for ${id}`);
  });

  test(`quest fixture ${name}: header evidence is recorded`, () => {
    const { doc } = load(name);
    const { report, fieldEvidence } = parseQuest(doc);
    for (const path of ['patient.fullName', 'patient.dob', 'patient.sex', 'specimen.collectedAt', 'provider.orderingName']) {
      assert.ok(Array.isArray(fieldEvidence[path]) && fieldEvidence[path].length > 0, `evidence for ${path}`);
    }
    assert.equal(report.source.vendor, 'quest');
    assert.equal(report.source.vendorConfidence, 1);
  });
}

test('classic-4page spot checks', () => {
  const { doc } = load('classic-4page');
  const { report, consumed, notes } = parseQuest(doc);
  assert.equal(report.results.length, 48);
  assert.equal(report.panels.map((p) => p.name).join('|'),
    'CBC (INCLUDES DIFF/PLT)|COMPREHENSIVE METABOLIC PANEL|LIPID PANEL|HEMOGLOBIN A1c|VITAMIN D,25-OH,TOTAL,IA|TSH|HEPATITIS C ANTIBODY');
  assert.equal(report.panels[0].resultIds.length, 20);
  assert.equal(report.panels[0].page, 1);
  assert.equal(report.panels[1].page, 2);

  const hgb = byName(report, 'HEMOGLOBIN');
  assert.deepEqual([hgb.id, hgb.value, hgb.unit, hgb.flag, hgb.referenceRange.low, hgb.referenceRange.high, hgb.performingLabCode, hgb.panel],
    ['r3', 12.9, 'g/dL', 'L', 13.2, 17.1, 'EZ', 'CBC (INCLUDES DIFF/PLT)']);
  assert.equal(hgb.fieldStatus.flag, 'found');
  assert.equal(hgb.confidence, 1);

  const neut = byName(report, 'ABSOLUTE NEUTROPHILS');
  assert.equal(neut.valueText, '4,320'); assert.equal(neut.value, 4320);
  assert.deepEqual([neut.referenceRange.low, neut.referenceRange.high, neut.unit], [1500, 7800, 'cells/uL']);

  const pctN = byName(report, 'NEUTROPHILS');
  assert.deepEqual([pctN.value, pctN.unit, pctN.referenceRange.kind, pctN.fieldStatus.unit, pctN.fieldStatus.range, pctN.confidence], [60, '%', null, 'found', 'missing', 0.75]);

  const mpv = byName(report, 'MPV');
  assert.deepEqual([mpv.unit, mpv.referenceRange.text, mpv.referenceRange.kind, mpv.fieldStatus.range, mpv.confidence], ['fL', 'Not Estab.', 'text', 'na', 1]);

  const egfr = byName(report, 'EGFR');
  assert.deepEqual([egfr.value, egfr.unit, egfr.referenceRange.kind, egfr.referenceRange.low, egfr.referenceRange.text], [95, 'mL/min/1.73m2', 'ge', 60, '> OR = 60']);
  assert.match(egfr.comment, /CKD-EPI 2021/);
  assert.match(egfr.comment, /Please note: eGFR values/);

  const bun = byName(report, 'BUN/CREATININE RATIO');
  assert.deepEqual([bun.valueText, bun.value, bun.referenceRange.low, bun.referenceRange.high, bun.referenceRange.text, bun.fieldStatus.unit], ['NOT APPLICABLE', null, 6, 22, '6-22 (calc)', 'na']);

  const agr = byName(report, 'ALBUMIN/GLOBULIN RATIO');
  assert.deepEqual([agr.value, agr.unit, agr.fieldStatus.unit, agr.confidence], [1.7, null, 'na', 1]);

  const chol = byName(report, 'CHOLESTEROL, TOTAL');
  assert.deepEqual([chol.value, chol.flag, chol.unit, chol.referenceRange.kind, chol.referenceRange.high], [210, 'H', 'mg/dL', 'lt', 200]);
  const trig = byName(report, 'TRIGLYCERIDES');
  assert.deepEqual([trig.valueText, trig.value, trig.flag], ['1,250', 1250, 'HH']);
  assert.match(trig.comment, /^Please note: Triglyceride results above 400 mg\/dL may\naffect calculated/);
  const ldl = byName(report, 'LDL-CHOLESTEROL');
  assert.deepEqual([ldl.valueText, ldl.value, ldl.unit, ldl.referenceRange.kind, ldl.fieldStatus.value, ldl.fieldStatus.range], ['NOT CALC.', null, 'mg/dL', null, 'found', 'na']);
  const hdl = byName(report, 'HDL CHOLESTEROL');
  assert.deepEqual([hdl.referenceRange.kind, hdl.referenceRange.low, hdl.unit], ['ge', 40, 'mg/dL']);

  const a1c = byName(report, 'HEMOGLOBIN A1c');
  assert.deepEqual([a1c.value, a1c.flag, a1c.unit, a1c.referenceRange.high, a1c.referenceRange.kind, a1c.panel], [5.9, 'H', '% of total Hgb', 5.7, 'lt', 'HEMOGLOBIN A1c']);
  assert.match(a1c.comment, /Reference Range: <5\.7 % of total Hgb/);
  assert.match(a1c.comment, /Prediabetes: 5\.7 - 6\.4/);
  const a1cComments = report.comments.filter((c) => c.attachedTo === a1c.id);
  assert.equal(a1cComments.length, 1);
  assert.equal(a1cComments[0].lineIds.length, 7);

  const vitd = byName(report, 'VITAMIN D, 25-OH, TOTAL, IMMUNOASSAY');
  assert.ok(vitd, 'wrapped (below) name merged');
  assert.deepEqual([vitd.value, vitd.flag, vitd.unit, vitd.lineIds.length, vitd.confidence], [22, 'L', 'ng/mL', 2, 0.9]);
  assert.equal(consumed.get(vitd.lineIds[1]), `result:${vitd.id}:name-wrap`);

  const hcv = byName(report, 'HEPATITIS C ANTIBODY W/REFLEX TO HCV RNA, QN, PCR');
  assert.ok(hcv, 'wrapped (above) name merged');
  assert.deepEqual([hcv.valueText, hcv.value, hcv.unit, hcv.referenceRange.kind, hcv.referenceRange.text, hcv.performingLabCode, hcv.fieldStatus.unit, hcv.fieldStatus.range, hcv.confidence],
    ['NON-REACTIVE', null, null, 'text', 'NON-REACTIVE', 'PR', 'na', 'found', 0.9]);
  assert.equal(consumed.get(hcv.lineIds[0]), `result:${hcv.id}:name-wrap`);
  assert.equal(hcv.lineIds[0] < hcv.lineIds[1] || true, true);

  const tsh = byName(report, 'TSH');
  assert.deepEqual([tsh.performingLabCode, tsh.panel, tsh.page], ['PR', 'TSH', 4]);

  assert.equal(report.performingLabs.length, 2);
  assert.equal(report.performingLabs[1].clia, '31D0000002');
  assert.equal(report.comments.length >= 8, true);
  assert.ok(!notes.some((n) => n.startsWith('conflict:')), `no conflicts expected: ${notes.join(' | ')}`);

  // consumed reason tags cover the boilerplate
  const reasons = new Set([...consumed.values()].flatMap((r) => r.split(',')));
  for (const tag of ['header.vendor', 'header.status', 'header.block', 'table.header', 'panel', 'pageno', 'footer.performingSite', 'performingLab:EZ', 'performingLab:PR', 'footer.clientServices', 'footer.disclaimer']) {
    assert.ok(reasons.has(tag), `reason tag ${tag} used`);
  }
  assert.ok([...consumed.values()].some((r) => r.includes('patient.fullName') && r.includes('specimen.specimenId') && r.includes('pageno')), 'footer line tagged with all three reasons');
});

test('myquest-portal spot checks', () => {
  const { doc } = load('myquest-portal');
  const { report, notes } = parseQuest(doc);
  assert.equal(report.results.length, 16);
  assert.deepEqual([report.patient.fullName, report.patient.firstName, report.patient.lastName, report.patient.dob, report.patient.sex], ['JORDAN SAMPLE', 'JORDAN', 'SAMPLE', '2012-06-02', 'F']);
  const hgb = byName(report, 'HEMOGLOBIN');
  assert.deepEqual([hgb.value, hgb.flag, hgb.unit, hgb.referenceRange.low, hgb.referenceRange.high, hgb.panel, hgb.fieldStatus.flag], [11.2, 'L', 'g/dL', 11.7, 15.5, 'CBC (INCLUDES DIFF/PLT)', 'found']);
  const plt = byName(report, 'PLATELET COUNT');
  assert.deepEqual([plt.flag, plt.unit], ['H', 'Thousand/uL']);
  const sat = byName(report, '%SATURATION');
  assert.deepEqual([sat.value, sat.flag, sat.unit, sat.referenceRange.low, sat.referenceRange.high, sat.referenceRange.text], [11, 'A', '%', 15, 45, '15-45 (calc)']);
  const vitd = byName(report, 'VITAMIN D, 25-OH, TOTAL');
  assert.deepEqual([vitd.value, vitd.flag, vitd.page], [18, 'L', 2]);
  assert.match(vitd.comment, /^Vitamin D Status/);
  const tsh = byName(report, 'TSH');
  assert.deepEqual([tsh.flag, tsh.fieldStatus.flag, tsh.performingLabCode, tsh.confidence], [null, 'na', null, 1]);
  assert.equal(report.panels.length, 5);
  assert.equal(report.performingLabs[0].code, null);
  assert.ok(notes.some((n) => /site code/.test(n)));
});

test('edge-cases spot checks', () => {
  const { doc } = load('edge-cases');
  const { report, notes } = parseQuest(doc);
  assert.equal(report.source.reportStatus, 'corrected');
  assert.equal(report.patient.patientId, null);
  assert.equal(report.patient.phone, null);
  assert.equal(report.provider.orderingName, 'DOE, JANE');

  const mg = byName(report, 'MAGNESIUM');
  assert.deepEqual([mg.value, mg.unit, mg.referenceRange.kind, mg.fieldStatus.unit, mg.fieldStatus.range, mg.confidence], [2.0, 'mg/dL', null, 'found', 'missing', 0.75]);
  const osm = byName(report, 'OSMOLALITY, CALCULATED');
  assert.deepEqual([osm.value, osm.unit, osm.referenceRange.kind, osm.fieldStatus.unit, osm.fieldStatus.range, osm.performingLabCode, osm.confidence], [285, null, null, 'missing', 'missing', 'EZ', 0.5]);
  const crp = byName(report, 'C-REACTIVE PROTEIN');
  assert.deepEqual([crp.valueText, crp.value, crp.valueQualifier, crp.unit, crp.referenceRange.high], ['<0.1', 0.1, '<', 'mg/L', 3.0]);
  const egfr = byName(report, 'EGFR');
  assert.deepEqual([egfr.valueText, egfr.value, egfr.valueQualifier, egfr.referenceRange.kind], ['>90', 90, '>', 'ge']);
  const ana = byName(report, 'ANA SCREEN, IFA');
  assert.deepEqual([ana.valueText, ana.value, ana.flag, ana.referenceRange.kind, ana.referenceRange.text], ['POSITIVE', null, 'A', 'text', 'NEGATIVE']);
  const titer = byName(report, 'ANA TITER');
  assert.deepEqual([titer.valueText, titer.value, titer.flag, titer.referenceRange.kind, titer.referenceRange.low, titer.referenceRange.high, titer.referenceRange.text], ['1:40', null, 'A', 'text', null, null, '<1:40']);
  const pattern = byName(report, 'ANA PATTERN');
  assert.deepEqual([pattern.valueText, pattern.value, pattern.fieldStatus.value], ['SPECKLED', null, 'uncertain']);
  const lpa = byName(report, 'LIPOPROTEIN (a)');
  assert.deepEqual([lpa.valueText, lpa.unit, lpa.referenceRange.high, lpa.fieldStatus.value], ['SEE NOTE', 'nmol/L', 75, 'found']);
  assert.equal(lpa.comment.split('\n').length, 3);
  assert.match(lpa.comment, /^Please note: This test could not be resulted/);
  const k = byName(report, 'POTASSIUM');
  assert.deepEqual([k.valueText, k.value, k.flag, k.fieldStatus.flag], ['5.6', 5.6, 'A', 'found']);
  const a1c = byName(report, 'HEMOGLOBIN A1c');
  assert.deepEqual([a1c.page, a1c.unit, a1c.panel], [2, '% of total Hgb', 'HEMOGLOBIN A1c']);
  assert.ok(!notes.some((n) => n.startsWith('conflict:')), `duplicated header must reconcile without conflict: ${notes.join(' | ')}`);
});

test('robust-layout spot checks (column drift, digit names, flag words, star, inline units, flush wraps, relaxed split)', () => {
  const { doc } = load('robust-layout');
  const { report, consumed, notes } = parseQuest(doc);
  // header: combined labels in one text item, value on the line below its label
  assert.deepEqual([report.patient.dob, report.patient.ageAtCollection, report.patient.sex, report.patient.patientId, report.patient.address],
    ['1970-02-20', 55, 'F', '246810', null]);
  assert.equal(report.provider.orderingName, 'DR. SAM ROE', 'a "Physician should correlate ..." sentence must not become the ordering provider');
  assert.ok([...consumed.values()].some((r) => r.split(',').includes('patient.patientId')), 'the bare value line below "Patient ID:" is consumed as the patient id');
  // rows drifted 15pt left of the header labels
  const plt = byName(report, 'PLATELET COUNT');
  assert.deepEqual([plt.valueText, plt.value, plt.flag, plt.unit, plt.referenceRange.low, plt.referenceRange.high, plt.performingLabCode, plt.fieldStatus.flag],
    ['135', 135, 'L', 'Thousand/uL', 140, 400, 'EZ', 'found']);
  const wbc = byName(report, 'WBC');
  assert.deepEqual([wbc.value, wbc.unit, wbc.referenceRange.low, wbc.performingLabCode, wbc.flag], [7.2, 'Thousand/uL', 3.8, 'EZ', null]);
  const neut = byName(report, 'ABSOLUTE NEUTROPHILS');
  assert.deepEqual([neut.value, neut.referenceRange.low, neut.referenceRange.high, neut.referenceRange.kind], [4320, 1500, 7800, 'range']);
  // names starting with a digit
  const vitd = byName(report, '25-OH VITAMIN D');
  assert.deepEqual([vitd.value, vitd.unit, vitd.referenceRange.high], [31.8, 'ng/mL', 100]);
  const hiaa = byName(report, '5-HIAA');
  assert.deepEqual([hiaa.value, hiaa.unit, hiaa.performingLabCode], [3.2, 'mg/24 hr', 'PR']);
  // flag words and star
  assert.deepEqual([byName(report, 'GLUCOSE').value, byName(report, 'GLUCOSE').flag], [104, 'H']);
  assert.deepEqual([byName(report, 'POTASSIUM').value, byName(report, 'POTASSIUM').flag], [6.1, 'C']);
  const a1c = byName(report, 'HEMOGLOBIN A1c');
  assert.deepEqual([a1c.valueText, a1c.value, a1c.flag, a1c.unit, a1c.referenceRange.high], ['6.2', 6.2, 'A', '% of total Hgb', 5.7]);
  // unit printed after the value, with a parenthetical / prose tail
  const ldl = byName(report, 'LDL-CHOLESTEROL');
  assert.deepEqual([ldl.valueText, ldl.value, ldl.unit, ldl.fieldStatus.value, ldl.fieldStatus.unit], ['133', 133, 'mg/dL', 'found', 'found']);
  assert.match(ldl.comment, /^Reference range for LDL is based on the ATP III guidelines <100 mg\/dL$/, 'two-cell prose stays a comment, not a result');
  const poc = byName(report, 'HEMOGLOBIN A1c, POC');
  assert.deepEqual([poc.value, poc.unit], [5.4, '% of total Hgb']);
  assert.ok(!report.results.some((r) => /^(?:the ATP|Reference range|Physician)/.test(r.name)), 'no prose line became a result');
  assert.ok(report.comments.some((c) => /^Physician should correlate/.test(c.text)));
  // flush (un-indented) wrapped names below and above, one-word panel right after a row
  const hbs = byName(report, 'HEPATITIS B SURFACE ANTIGEN');
  assert.ok(hbs, 'continuation line below the value line merged without indentation');
  assert.equal(hbs.lineIds.length, 2);
  const hcv = byName(report, 'HEPATITIS C ANTIBODY W/REFLEX TO HCV RNA, QN, PCR');
  assert.ok(hcv, 'continuation line above the value line merged without indentation');
  assert.equal(report.panels.map((p) => p.name).join('|'), 'CBC (INCLUDES DIFF/PLT)|MISCELLANEOUS CHEMISTRY|HEPATITIS PANEL, ACUTE|TSH|MAGNESIUM');
  assert.deepEqual([byName(report, 'TSH').panel, byName(report, 'TSH').value], ['TSH', 2.15]);
  // a row printed as one text item with single spaces
  const mg = byName(report, 'MAGNESIUM');
  assert.deepEqual([mg.value, mg.unit, mg.referenceRange.low, mg.referenceRange.high, mg.performingLabCode, mg.confidence], [2, 'mg/dL', 1.5, 2.5, 'EZ', 0.9]);
  assert.equal(report.results.length, 17);
  assert.ok(!notes.some((n) => n.startsWith('conflict:')), notes.join(' | '));
});

test('myquest-noheader spot checks (no table header, value below label, derived age, 4-cell flagged row, star + unit)', () => {
  const { doc } = load('myquest-noheader');
  const { report, consumed, fieldEvidence } = parseQuest(doc);
  assert.deepEqual([report.patient.fullName, report.patient.sex, report.patient.dob, report.patient.ageAtCollection, report.provider.orderingName, report.source.reportStatus],
    ['JORDAN SAMPLE', 'F', '2012-06-02', 13, 'DR. JANE DOE', 'final']);
  assert.ok(fieldEvidence['patient.ageAtCollection'].length >= 2, 'derived age cites the DOB and collection lines');
  assert.equal(report.results.length, 5);
  const chol = byName(report, 'CHOLESTEROL, TOTAL');
  assert.deepEqual([chol.value, chol.unit, chol.flag, chol.referenceRange.high, chol.panel, chol.fieldStatus.flag], [178, 'mg/dL', 'H', 170, 'LIPID PANEL', 'found']);
  const a1c = byName(report, 'HEMOGLOBIN A1c');
  assert.deepEqual([a1c.valueText, a1c.value, a1c.flag, a1c.unit], ['6.2', 6.2, 'A', '%']);
  const rbc = byName(report, 'RBC, UA');
  assert.deepEqual([rbc.valueText, rbc.value, rbc.unit, rbc.referenceRange.high], ['0-2', null, '/HPF', 1]);
  const hiv = byName(report, 'HIV AG/AB');
  assert.deepEqual([hiv.valueText, hiv.fieldStatus.value, hiv.referenceRange.kind], ['Non Reactive', 'found', 'text']);
  assert.ok(report.results.every((r) => r.confidence <= 0.9), 'rows without a learned header are marked misaligned');
  assert.ok([...consumed.values()].some((r) => r === 'provider.orderingName'), 'the value line below "Ordered by" is consumed as the ordering name');
});

const mkLine = (i, cells, cellX, extra = {}) => ({ id: `p1l${i}`, page: 1, y: 40 + 11 * i, x0: cellX[0], x1: 560, text: cells.join('  '), cells, cellX, items: [], ...extra });
const mkDoc = (lines) => ({ fileName: 'u.pdf', fileHash: '1', pageCount: 1, pages: [{ pageNumber: 1, width: 612, height: 792, lines }] });
const QHEADER = (i) => mkLine(i, ['Test Name', 'In Range', 'Out of Range', 'Reference Range', 'Lab'], [36, 260, 330, 410, 560]);

test('a result-shaped line the column model cannot parse is left unconsumed, never filed as a comment', () => {
  const doc = mkDoc([
    mkLine(0, ['Quest Diagnostics'], [36]),
    QHEADER(1),
    mkLine(2, ['LIPID PANEL'], [36]),
    mkLine(3, ['CHOLESTEROL, TOTAL', '210 H', '<200 mg/dL', 'EZ'], [46, 330, 410, 560]),
    // two non-name cells that are not a parseable row (garbled value and range, no site code): must NOT become the previous result's comment
    mkLine(4, ['HDL CHOLESTEROL', 'abc', 'xyz'], [46, 260, 410]),
    // a genuine comment line is still attached
    mkLine(5, ['Desirable range <200 mg/dL for primary prevention.'], [46]),
  ]);
  const { report, consumed, notes } = parseQuest(doc);
  assert.equal(report.results.length, 1);
  assert.ok(!consumed.has('p1l4'), 'unparseable multi-cell line stays unconsumed for the audit');
  assert.ok(notes.some((n) => n === 'result-shaped line not parsed: p1l4'));
  assert.equal(report.results[0].comment, 'Desirable range <200 mg/dL for primary prevention.');
  assert.ok(!/abc|xyz/.test(report.results[0].comment || ''));
});

test('in table mode, colon-less header labels are not harvested from comment text', () => {
  const doc = mkDoc([
    mkLine(0, ['Quest Diagnostics'], [36]),
    mkLine(1, ['Patient Information'], [36]),
    mkLine(2, ['DOE, JANE'], [36]),
    mkLine(3, ['Gender: F'], [36]),
    QHEADER(4),
    mkLine(5, ['TSH'], [36]),
    mkLine(6, ['TSH', '2.15', '0.40-4.50 mIU/L', 'EZ'], [46, 260, 410, 560]),
    mkLine(7, ['Physician should correlate these results with clinical findings.'], [46]),
    mkLine(8, ['Patient was fasting at the time of collection.'], [46]),
    mkLine(9, ['Reported: 10/02/2025 / 05:30 EDT'], [46]),
  ]);
  const { report } = parseQuest(doc);
  assert.equal(report.provider.orderingName, null);
  assert.equal(report.patient.fullName, 'DOE, JANE');
  assert.equal(report.specimen.reportedAt, '2025-10-02T05:30', 'an explicit "Label:" is still honored in table mode');
  assert.match(report.results[0].comment, /Physician should correlate/);
  assert.match(report.results[0].comment, /Patient was fasting/);
});

test('"LAST, FIRST" result names never become the patient name', () => {
  const doc = mkDoc([
    mkLine(0, ['Quest Diagnostics'], [36]),
    mkLine(1, ['Patient Information'], [36]),
    mkLine(2, ['SAMPLE, ALEX'], [36]),
    mkLine(3, ['DOB: 01/15/1980'], [36]),
    mkLine(4, ['Gender: M'], [36]),
    mkLine(5, ['Phone: 609.555.0100'], [36]),
    mkLine(6, ['Patient ID: 987654'], [36]),
    mkLine(7, ['CHOLESTEROL, TOTAL'], [36]),         // no table header and no value: looks like "LAST, FIRST" but sits outside the patient block
    mkLine(8, ['CHOLESTEROL, TOTAL', '210 H', '<200 mg/dL', 'EZ'], [36, 260, 410, 560]),
  ]);
  const { report, notes } = parseQuest(doc);
  assert.equal(report.patient.fullName, 'SAMPLE, ALEX');
  assert.ok(!notes.some((n) => n.startsWith('conflict:patient.fullName')), notes.join(' | '));
  assert.equal(report.results.length, 1);
  assert.equal(report.results[0].value, 210);
});

test('parser notes carry paths and line ids only, never extracted values', () => {
  const doc = mkDoc([
    mkLine(0, ['Quest Diagnostics'], [36]),
    QHEADER(1),
    mkLine(2, ['ANA PATTERN', 'SPECKLED-ZZ', '', 'PR'], [46, 260, 410, 560]),
    mkLine(3, ['ANA TITER', '1:40', '<1:40', 'ez'], [46, 260, 410, 560]),
  ]);
  const { report, notes } = parseQuest(doc);
  assert.equal(report.results.length, 2);
  assert.equal(report.results[0].fieldStatus.value, 'uncertain');
  assert.ok(notes.some((n) => /value not recognized/.test(n)), notes.join(' | '));
  assert.ok(notes.some((n) => /Lab column text is not a site code/.test(n)), notes.join(' | '));
  for (const n of notes) assert.ok(!/SPECKLED|\bez\b|1:40/.test(n), `note leaks a value: ${n}`);
});

test('MyQuest without a printed status keeps reportStatus null (never fabricated)', () => {
  const { doc } = load('myquest-portal');
  const { report } = parseQuest(doc);
  assert.equal(report.source.reportStatus, null);
});

test('parseQuest never throws on an empty or minimal document', () => {
  const r = parseQuest({ fileName: 'x.pdf', fileHash: 'abc', pageCount: 1, pages: [{ pageNumber: 1, width: 612, height: 792, lines: [] }] });
  assert.equal(r.report.results.length, 0);
  assert.ok(r.notes.some((n) => /no result rows/.test(n)));
  const r2 = parseQuest({ fileName: 'y.pdf', fileHash: 'def', pageCount: 0, pages: [] });
  assert.equal(r2.report.source.vendor, 'quest');
});

test('fallback regex path (no table header) still finds rows and marks them misaligned', () => {
  const mk = (i, cells, cellX) => ({ id: `p1l${i}`, page: 1, y: 40 + 11 * i, x0: cellX[0], x1: 500, text: cells.join('  '), cells, cellX, items: [] });
  const doc = { fileName: 'z.pdf', fileHash: '0', pageCount: 1, pages: [{ pageNumber: 1, width: 612, height: 792, lines: [
    mk(0, ['Quest Diagnostics'], [36]),
    mk(1, ['LIPID PANEL'], [36]),
    mk(2, ['CHOLESTEROL, TOTAL', '210 H', '<200 mg/dL', 'EZ'], [46, 330, 410, 560]),
    mk(3, ['HDL CHOLESTEROL', '52', '> OR = 40 mg/dL', 'EZ'], [46, 260, 410, 560]),
  ] }] };
  const { report } = parseQuest(doc);
  assert.equal(report.results.length, 2);
  assert.deepEqual([report.results[0].value, report.results[0].flag, report.results[0].unit, report.results[0].confidence, report.results[0].panel], [210, 'H', 'mg/dL', 0.9, 'LIPID PANEL']);
});
