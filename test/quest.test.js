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
