// node --test test/labcorp.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseLabcorp } from '../src/parse/labcorp.js';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'labcorp');
const load = (f) => JSON.parse(readFileSync(path.join(DIR, f), 'utf8'));

/** Every key/index present in `expected` must deep-equal the corresponding part of `actual`. */
function assertSubset(actual, expected, where = '$') {
  if (expected === null || typeof expected !== 'object') {
    assert.deepEqual(actual, expected, `${where}: expected ${JSON.stringify(expected)} got ${JSON.stringify(actual)}`);
    return;
  }
  if (Array.isArray(expected)) {
    assert.ok(Array.isArray(actual), `${where}: expected array, got ${typeof actual}`);
    assert.equal(actual.length, expected.length, `${where}: length ${actual.length} !== ${expected.length}` +
      (actual.length !== expected.length && actual[0] && actual[0].name !== undefined
        ? `\n  actual names: ${actual.map((r) => r.name).join(' | ')}` : ''));
    expected.forEach((e, i) => assertSubset(actual[i], e, `${where}[${i}]`));
    return;
  }
  assert.ok(actual && typeof actual === 'object', `${where}: expected object, got ${JSON.stringify(actual)}`);
  for (const k of Object.keys(expected)) assertSubset(actual[k], expected[k], `${where}.${k}`);
}

const fixtures = readdirSync(DIR).filter((f) => f.endsWith('.doc.json')).map((f) => f.replace(/\.doc\.json$/, ''));
assert.ok(fixtures.length >= 3, 'expected at least three Labcorp fixtures');

const FULLY_CONSUMED = ['classic-3page', 'portal-2023', 'edge-cases', 'robust-cases'];

for (const name of fixtures) {
  const doc = load(`${name}.doc.json`);
  const expected = load(`${name}.expected.json`);

  test(`labcorp fixture ${name}: expected subset matches`, () => {
    const { report, consumed, notes, fieldEvidence } = parseLabcorp(doc);
    assert.ok(consumed instanceof Map, 'consumed must be a Map');
    assert.ok(Array.isArray(notes));
    assertSubset(report, expected);
    // result ids are sequential r1..rn in document order
    report.results.forEach((r, i) => assert.equal(r.id, `r${i + 1}`));
    // every result has lineIds, a fieldStatus and a confidence in range
    for (const r of report.results) {
      assert.ok(r.lineIds.length >= 1, `${r.id} has no lineIds`);
      assert.ok(r.confidence >= 0 && r.confidence <= 1, `${r.id} confidence out of range`);
      for (const k of ['value', 'unit', 'range', 'flag']) assert.ok(['found', 'missing', 'uncertain', 'na'].includes(r.fieldStatus[k]), `${r.id} fieldStatus.${k}`);
      assert.equal(r.fieldStatus.value, 'found');
      if (r.unit) assert.equal(r.fieldStatus.unit, 'found');
      if (r.value != null && !r.unit) assert.equal(r.fieldStatus.unit, 'missing');
      if (r.value != null && r.referenceRange.kind == null) assert.equal(r.fieldStatus.range, 'missing');
      if (r.flag) assert.equal(r.fieldStatus.flag, 'found');
    }
    // every header field set has evidence
    for (const path of ['patient.fullName', 'patient.dob', 'patient.sex', 'specimen.specimenId', 'specimen.collectedAt',
      'specimen.reportedAt', 'provider.orderingName', 'provider.npi', 'provider.accountNumber', 'source.reportStatus']) {
      const v = path.split('.').reduce((o, k) => o[k], report);
      if (v != null) assert.ok(fieldEvidence[path] && fieldEvidence[path].length, `no fieldEvidence for ${path}`);
    }
    assert.ok(fieldEvidence.performingLabs && fieldEvidence.performingLabs.length >= doc.pageCount, 'performingLabs evidence from every page');
    // panels reference real result ids and every result sits in its panel
    const ids = new Set(report.results.map((r) => r.id));
    for (const p of report.panels) for (const id of p.resultIds) assert.ok(ids.has(id), `${p.name} references ${id}`);
    for (const r of report.results) if (r.panel) assert.ok(report.panels.find((p) => p.name === r.panel).resultIds.includes(r.id));
    // no header conflicts on fixtures where every page repeats the same values
    assert.deepEqual(notes.filter((n) => n.startsWith('conflict:')), [], 'no conflicts expected');
    // every consumed id exists in the document and every result line is tagged with its id
    const allIds = new Set(doc.pages.flatMap((p) => p.lines.map((l) => l.id)));
    for (const id of consumed.keys()) assert.ok(allIds.has(id), `consumed unknown line ${id}`);
    for (const r of report.results) assert.ok(consumed.get(r.lineIds[r.lineIds.length - 1]).startsWith(`result:${r.id}`) || consumed.get(r.lineIds[0]).startsWith(`result:${r.id}`));
  });

  test(`labcorp fixture ${name}: line coverage`, () => {
    const { consumed } = parseLabcorp(doc);
    const unconsumed = doc.pages.flatMap((p) => p.lines.filter((l) => !consumed.has(l.id)).map((l) => `${l.id}: ${l.text}`));
    if (FULLY_CONSUMED.includes(name)) {
      assert.deepEqual(unconsumed, [], `unconsumed lines in ${name}:\n  ${unconsumed.join('\n  ')}`);
    } else {
      assert.ok(unconsumed.length <= 1, `too many unconsumed lines in ${name}:\n  ${unconsumed.join('\n  ')}`);
    }
    for (const [, tag] of consumed) assert.ok(typeof tag === 'string' && tag.length, 'consumed reason tags must be non-empty strings');
  });
}

// ---------------- spot checks ----------------
test('classic-3page spot checks', () => {
  const doc = load('classic-3page.doc.json');
  const { report, consumed, fieldEvidence } = parseLabcorp(doc);
  const by = (n) => report.results.find((r) => r.name === n);

  const plt = by('Platelets');
  assert.equal(plt.value, 462); assert.equal(plt.flag, 'H'); assert.equal(plt.unit, 'x10E3/uL');
  assert.deepEqual([plt.referenceRange.low, plt.referenceRange.high, plt.referenceRange.kind], [150, 450, 'range']);
  assert.equal(plt.performingLabCode, '01'); assert.equal(plt.panel, 'CBC With Differential/Platelet'); assert.equal(plt.page, 1);
  assert.equal(plt.confidence, 1);

  const k = by('Potassium');
  assert.equal(k.flag, 'C'); assert.equal(k.fieldStatus.flag, 'found');

  const tg = by('Triglycerides');
  assert.equal(tg.valueText, '1,045'); assert.equal(tg.value, 1045); assert.equal(tg.flag, 'H');

  const hdl = by('HDL Cholesterol');
  assert.equal(hdl.flag, 'L'); assert.deepEqual([hdl.referenceRange.low, hdl.referenceRange.high, hdl.referenceRange.kind], [39, null, 'gt']);

  const neut = by('Neutrophils');
  assert.equal(neut.referenceRange.kind, 'text'); assert.equal(neut.referenceRange.text, 'Not Estab.'); assert.equal(neut.fieldStatus.range, 'na');
  assert.equal(neut.confidence, 1);

  const bun = by('BUN/Creatinine Ratio');
  assert.equal(bun.unit, null); assert.equal(bun.fieldStatus.unit, 'missing'); assert.equal(bun.confidence, 0.75);

  const egfr = by('eGFR');
  assert.equal(egfr.unit, 'mL/min/1.73');
  assert.match(egfr.comment, /^Please Note:\neGFR is calculated/);
  assert.equal(report.comments.find((c) => c.attachedTo === egfr.id).lineIds.length, 2);

  const ldl = by('LDL Chol Calc (NIH)');
  assert.equal(ldl.comment, 'Comment:\nDesirable range <100 mg/dL for primary prevention goal.');
  assert.equal(report.comments.filter((c) => c.attachedTo === ldl.id).length, 1, 'Comment: label and its text form one block');
  assert.deepEqual(report.comments.filter((c) => c.attachedTo == null), [], 'every comment is attached to a result');

  const a1c = by('Hemoglobin A1c');
  assert.equal(a1c.flag, 'H'); assert.equal(a1c.unit, '%');
  assert.equal(a1c.comment.split('\n').length, 4);
  assert.match(a1c.comment, /Glycemic control for adults with diabetes: <7.0$/);

  // wrapped name above the value line: merged, two lineIds, tagged :wrap, −0.1
  const eag = by('Estimated Average Glucose (eAG)');
  assert.ok(eag, 'wrapped eAG name merged');
  assert.equal(eag.lineIds.length, 2);
  assert.equal(consumed.get(eag.lineIds[0]), `result:${eag.id}:wrap`);
  assert.equal(eag.referenceRange.kind, null); assert.equal(eag.fieldStatus.range, 'missing');
  assert.equal(eag.confidence, 0.65);   // 1 − 0.25 (no range) − 0.1 (wrapped)
  assert.equal(eag.panel, 'Hemoglobin A1c');

  // wrapped name below the value line
  const vd = by('Vitamin D, 25-Hydroxy');
  assert.ok(vd, 'wrapped Vitamin D name merged');
  assert.equal(vd.value, 32.4); assert.equal(vd.performingLabCode, '02'); assert.equal(vd.page, 3);
  assert.equal(consumed.get(vd.lineIds[1]), `result:${vd.id}:wrap`);
  assert.equal(vd.confidence, 0.9);
  assert.match(vd.comment, /Endocrine Society/);

  const tsh = by('TSH');
  assert.equal(tsh.value, 1.23); assert.equal(tsh.unit, 'uIU/mL'); assert.equal(tsh.panel, 'TSH');

  assert.equal(report.results.length, 49);
  assert.deepEqual(report.panels.map((p) => [p.name, p.resultIds.length, p.page]), [
    ['CBC With Differential/Platelet', 21, 1], ['Comp. Metabolic Panel (14)', 18, 2], ['Lipid Panel', 6, 2],
    ['Hemoglobin A1c', 2, 3], ['Vitamin D, 25-Hydroxy', 1, 3], ['TSH', 1, 3],
  ]);
  // header evidence collected from all three pages
  assert.equal(fieldEvidence['patient.dob'].length, 3);
  assert.equal(fieldEvidence['specimen.specimenId'].length, 3);
  assert.equal(fieldEvidence.pages.length, 3);
  // tags used for boilerplate
  const tags = new Set(consumed.values());
  for (const t of ['header', 'header:patient.name', 'header:section', 'orderedItems', 'table.header', 'panel', 'footer:lab', 'footer', 'footer:copyright', 'footer:disclaimer'])
    assert.ok(tags.has(t), `tag ${t} used`);
});

test('portal-2023 spot checks', () => {
  const doc = load('portal-2023.doc.json');
  const { report, fieldEvidence } = parseLabcorp(doc);
  assert.equal(report.patient.sex, 'F'); assert.equal(report.patient.ageAtCollection, 11); assert.equal(report.specimen.fasting, true);
  assert.equal(report.provider.accountName, 'SAMPLE PEDIATRICS GROUP');
  const fer = report.results.find((r) => r.name === 'Ferritin');
  assert.equal(fer.flag, 'L'); assert.equal(fer.value, 9); assert.equal(fer.panel, 'Ferritin'); assert.equal(fer.page, 2);
  assert.equal(fer.comment, 'Please Note:\nReference interval for ferritin is age and sex dependent.');
  assert.deepEqual([fer.referenceRange.low, fer.referenceRange.high], [13, 150]);
  assert.equal(report.results.length, 23);
  assert.equal(fieldEvidence['patient.fullName'].length, 2);
  assert.equal(fieldEvidence['specimen.fasting'].length, 2);
});

test('edge-cases spot checks (no table header → shape fallback)', () => {
  const doc = load('edge-cases.doc.json');
  const { report, notes } = parseLabcorp(doc);
  const by = (n) => report.results.find((r) => r.name === n);
  assert.equal(report.source.reportStatus, 'partial');
  assert.equal(report.patient.patientId, null);
  const tsh = by('TSH');
  assert.equal(tsh.valueText, '<0.1'); assert.equal(tsh.value, 0.1); assert.equal(tsh.valueQualifier, '<'); assert.equal(tsh.flag, 'L');
  const egfr = by('eGFR');
  assert.equal(egfr.value, 90); assert.equal(egfr.valueQualifier, '>'); assert.equal(egfr.unit, 'mL/min/1.73'); assert.equal(egfr.referenceRange.kind, 'gt');
  const titer = by('ANA Titer');
  assert.equal(titer.valueText, '1:40'); assert.equal(titer.value, null); assert.equal(titer.flag, 'A');
  assert.equal(titer.referenceRange.kind, null); assert.equal(titer.fieldStatus.range, 'na'); assert.equal(titer.fieldStatus.unit, 'na');
  const pat = by('ANA Pattern');
  assert.equal(pat.valueText, 'See Note');
  assert.equal(pat.comment, 'Please Note:\nPattern: Homogeneous. Homogeneous patterns are associated with a variety of\nconditions; clinical correlation is recommended.');
  const fti = by('Free Thyroxine Index');
  assert.equal(fti.unit, null); assert.equal(fti.fieldStatus.unit, 'missing'); assert.equal(fti.referenceRange.high, 4.9); assert.equal(fti.confidence, 0.75);
  const eag = by('Estim. Avg Glu (eAG)');
  assert.equal(eag.referenceRange.kind, null); assert.equal(eag.fieldStatus.range, 'missing'); assert.equal(eag.unit, 'mg/dL');
  const sat = by('Iron Saturation');
  assert.equal(sat.flag, null); assert.equal(sat.fieldStatus.flag, 'na'); assert.equal(sat.unit, '%'); assert.equal(sat.confidence, 1);
  const hep = by('Hepatitis B Surface Ab, Qual');
  assert.equal(hep.valueText, 'Positive'); assert.equal(hep.referenceRange.text, 'Negative'); assert.equal(hep.performingLabCode, '02');
  assert.equal(report.performingLabs.length, 2);
  assert.ok(!notes.some((n) => /conflict/.test(n)), notes.join('\n'));
});

test('header values that differ between pages produce a conflict note and keep the first value', () => {
  const doc = load('classic-3page.doc.json');
  const l = doc.pages[1].lines.find((x) => x.text.startsWith('DOB:'));
  l.cells[0] = 'DOB: 01/16/1980'; l.text = l.text.replace('01/15/1980', '01/16/1980');
  const { report, notes } = parseLabcorp(doc);
  assert.equal(report.patient.dob, '1980-01-15');
  assert.ok(notes.some((n) => n.startsWith('conflict:patient.dob:')), notes.join('\n'));
  assert.ok(notes.includes('uncertain:patient.dob'));
});

test('performing-lab legend parses when the extractor did not split it into cells', () => {
  const doc = load('classic-3page.doc.json');
  const leg = doc.pages[2].lines.find((x) => x.text.startsWith('02 SE'));
  leg.cells = [leg.text.replace(/ {2}/g, ' ')]; leg.cellX = [36]; leg.text = leg.cells[0];
  const { report } = parseLabcorp(doc);
  assert.deepEqual(report.performingLabs[1], { code: '02', name: 'LabCorp Phoenix', address: '5005 S 40th St Ste 1100, Phoenix, AZ 850403222',
    director: 'Chris Sample, MD', clia: null, phone: '800-555-0102' });
});

// ---------------- robustness fixes (fixtures/labcorp/robust-cases) ----------------
test('robust-cases: header values printed on the line below their label are taken, with both lines as evidence', () => {
  const doc = load('robust-cases.doc.json');
  const { report, consumed, notes, fieldEvidence } = parseLabcorp(doc);
  assert.equal(report.provider.orderingName, 'K LEE');
  assert.equal(report.patient.patientId, '200300400');
  assert.deepEqual(fieldEvidence['provider.orderingName'], ['p1l4', 'p1l3', 'p2l4', 'p2l3']);
  assert.deepEqual(fieldEvidence['patient.patientId'], ['p1l7', 'p1l6', 'p2l7', 'p2l6']);
  assert.equal(consumed.get('p1l4'), 'header');                 // "Age: 50 | Date received: ... | K LEE"
  assert.ok(!notes.some((n) => /Unrecognized header fragment/.test(n)), notes.join('\n'));
  // account block in the left column, no table header: the first panel two lines below it is NOT eaten as the address
  assert.equal(report.provider.accountName, 'SAMPLE INTERNAL MEDICINE');
  assert.equal(report.provider.address, '77 FAKE ROAD');
  assert.equal(consumed.get('p1l12'), 'panel');
  assert.equal(report.panels[0].name, 'CBC With Differential/Platelet');
});

test('robust-cases: value+flag / value+unit+flag in one cell, star values, whole row in one cell', () => {
  const doc = load('robust-cases.doc.json');
  const { report, consumed } = parseLabcorp(doc);
  const by = (n) => report.results.find((r) => r.name === n);
  const plt = by('Platelets');                                   // "142 Low" as one cell
  assert.equal(plt.valueText, '142'); assert.equal(plt.value, 142); assert.equal(plt.flag, 'L'); assert.equal(plt.unit, 'x10E3/uL');
  assert.equal(plt.fieldStatus.value, 'found'); assert.equal(plt.fieldStatus.flag, 'found'); assert.equal(plt.confidence, 1);
  const hgb = by('Hemoglobin');                                  // "11.9 g/dL Low" as one cell
  assert.equal(hgb.value, 11.9); assert.equal(hgb.unit, 'g/dL'); assert.equal(hgb.flag, 'L'); assert.equal(hgb.referenceRange.high, 17.7);
  const a1c = by('Hemoglobin A1c');                              // "6.2*": printed text kept, value parsed, star → flag A
  assert.equal(a1c.valueText, '6.2*'); assert.equal(a1c.value, 6.2); assert.equal(a1c.flag, 'A'); assert.equal(a1c.fieldStatus.flag, 'found');
  const mcv = by('MCV');                                         // "MCV 101 High fL 79-97 01" as ONE cell → relaxed split
  assert.ok(mcv, 'single-cell row recovered');
  assert.equal(mcv.value, 101); assert.equal(mcv.flag, 'H'); assert.equal(mcv.unit, 'fL');
  assert.deepEqual([mcv.referenceRange.low, mcv.referenceRange.high], [79, 97]); assert.equal(mcv.performingLabCode, '01');
  assert.equal(mcv.confidence, 0.9);                             // −0.1 misaligned hint for the relaxed parse
  assert.equal(consumed.get(mcv.lineIds[0]), `result:${mcv.id}`);
});

test('robust-cases: labelled notes and short notes with ranges are comments, never wrapped names', () => {
  const doc = load('robust-cases.doc.json');
  const { report } = parseLabcorp(doc);
  const by = (n) => report.results.find((r) => r.name === n);
  const a1c = by('Hemoglobin A1c');
  assert.equal(a1c.comment, 'Please Note:\nPrediabetes: 5.7 - 6.4\nDiabetes: >6.4');
  assert.ok(by('Glucose (eAG)'), 'row after "Diabetes: >6.4" keeps its own name');
  assert.ok(!report.results.some((r) => /Diabetes|Prediabetes/.test(r.name)), 'no note hijacked as a name');
  const ldl = by('LDL Chol Calc (NIH)');
  assert.equal(ldl.comment, 'Fasting 8-12 hours');
  assert.ok(by('Chol/HDL Ratio'), 'row after "Fasting 8-12 hours" keeps its own name');
  assert.deepEqual(report.comments.filter((c) => c.attachedTo == null), [], 'every comment is attached');
});

test('robust-cases: legend-shaped in-table comment is not a performing lab; function-word panel headings are panels', () => {
  const doc = load('robust-cases.doc.json');
  const { report } = parseLabcorp(doc);
  const by = (n) => report.results.find((r) => r.name === n);
  assert.deepEqual(report.performingLabs.map((l) => l.code), ['01', '02']);
  assert.equal(by('HDL Cholesterol').comment, '50 TO 100 mg/dL is the optimal target');
  assert.deepEqual(report.panels.map((p) => [p.name, p.resultIds.length, p.page]), [
    ['CBC With Differential/Platelet', 4, 1], ['Hemoglobin A1c', 2, 1], ['Lipid Panel', 5, 2],
    ['Thyroid Panel With TSH', 2, 2], ['Iron and TIBC', 1, 2],
  ]);
  assert.equal(by('TSH').panel, 'Thyroid Panel With TSH');
  assert.equal(by('Iron').panel, 'Iron and TIBC');
});

test('robust-cases: split REFERENCE | INTERVAL header is learned; drifted and right-aligned rows keep every column', () => {
  const doc = load('robust-cases.doc.json');
  const { report, consumed } = parseLabcorp(doc);
  const by = (n) => report.results.find((r) => r.name === n);
  const hdr = doc.pages[1].lines.find((l) => l.cells[0] === 'TESTS');
  assert.deepEqual(hdr.cells.slice(4, 6), ['REFERENCE', 'INTERVAL']);
  assert.equal(consumed.get(hdr.id), 'table.header');
  for (const n of ['Cholesterol, Total', 'Triglycerides']) {      // rows 15pt left of the header labels
    const r = by(n);
    assert.equal(r.unit, 'mg/dL', n); assert.equal(r.fieldStatus.range, 'found', n); assert.equal(r.performingLabCode, '01', n);
    assert.equal(r.confidence, 1, `${n} is not penalized as misaligned`);
  }
  assert.equal(by('Cholesterol, Total').flag, 'H');
  const hdl = by('HDL Cholesterol');                              // value right-aligned just before the FLAG column
  assert.equal(hdl.value, 58); assert.equal(hdl.unit, 'mg/dL'); assert.equal(hdl.referenceRange.kind, 'gt'); assert.equal(hdl.confidence, 1);
  const ldl = by('LDL Chol Calc (NIH)');                           // right-aligned "135 High" in one cell
  assert.equal(ldl.value, 135); assert.equal(ldl.flag, 'H'); assert.equal(ldl.referenceRange.high, 99);
  assert.equal(report.results.length, 14);
});

test('a result-like line the probe cannot parse is retried with a relaxed split (header learned)', () => {
  const doc = load('classic-3page.doc.json');
  const l = doc.pages[1].lines.find((x) => x.cells[0] === 'BUN');
  l.cells = ['BUN 15 mg/dL 6-24 01']; l.cellX = [42]; l.text = l.cells[0];
  const { report, consumed } = parseLabcorp(doc);
  const bun = report.results.find((r) => r.name === 'BUN');
  assert.ok(bun, 'BUN recovered from a single-cell line');
  assert.equal(bun.value, 15); assert.equal(bun.unit, 'mg/dL'); assert.deepEqual([bun.referenceRange.low, bun.referenceRange.high], [6, 24]);
  assert.equal(bun.performingLabCode, '01'); assert.equal(bun.confidence, 0.9);
  assert.equal(consumed.get(l.id), `result:${bun.id}`);
  assert.equal(report.results.length, 49);
});

test('a row-shaped line with no name to attach to is left UNCONSUMED, not filed as a comment', () => {
  const doc = load('edge-cases.doc.json');
  const l = doc.pages[0].lines.find((x) => x.cells[0] === 'T3 Uptake');
  l.cells = ['30 mIU/L 24-39 01']; l.cellX = [42]; l.text = l.cells[0];   // value + unit + range + lab, but no name
  const { report, consumed, notes } = parseLabcorp(doc);
  assert.ok(!consumed.has(l.id), 'line stays unconsumed for the audit');
  assert.ok(notes.includes(`Result-like line could not be parsed at ${l.id}`), notes.join('\n'));
  assert.ok(!report.results.some((r) => r.name === 'T3 Uptake'));
  assert.ok(!report.results.some((r) => r.comment && r.comment.includes('24-39')), 'not swallowed into a comment');
  assert.ok(!report.comments.some((c) => c.text.includes('24-39')));
  assert.equal(report.results.length, 14);
  // the rows around it are unaffected
  assert.ok(report.results.find((r) => r.name === 'Thyroxine (T4)'));
  assert.ok(report.results.find((r) => r.name === 'Free Thyroxine Index'));
});

test('parser notes name the field path and line ids, never the conflicting or stray values', () => {
  const doc = load('classic-3page.doc.json');
  const l = doc.pages[1].lines.find((x) => x.text.startsWith('DOB:'));
  l.cells[0] = 'DOB: 01/16/1980'; l.text = l.text.replace('01/15/1980', '01/16/1980');
  const stray = doc.pages[2].lines.find((x) => x.text.startsWith('Age:'));
  stray.cells.push('ZZSTRAYZZ'); stray.cellX.push(300); stray.text += '  ZZSTRAYZZ';
  const { notes } = parseLabcorp(doc);
  const conflict = notes.find((n) => n.startsWith('conflict:patient.dob:'));
  assert.ok(conflict, notes.join('\n'));
  assert.match(conflict, /^conflict:patient\.dob: value at p2l\d+ differs from p1l\d+/);
  assert.ok(!/1980/.test(conflict), 'conflict note must not contain the values');
  const frag = notes.find((n) => n.startsWith('Unrecognized header fragment'));
  assert.equal(frag, `Unrecognized header fragment at ${stray.id}`);
  assert.ok(!notes.some((n) => /ZZSTRAYZZ|01\/1[56]\/1980|1980-01-1[56]/.test(n)), notes.join('\n'));
});

test('parseLabcorp tolerates an empty document', () => {
  const { report, consumed, notes } = parseLabcorp({ fileName: 'x.pdf', fileHash: 'abc', pageCount: 0, pages: [] });
  assert.equal(report.results.length, 0); assert.equal(consumed.size, 0);
  assert.ok(notes.includes('No result rows recognized'));
});
