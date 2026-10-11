// fixtures/quest/_build.js — builds synthetic Quest Document fixtures (+ expected subsets) from compact descriptions.
// Run: node fixtures/quest/_build.js   → writes fixtures/quest/*.doc.json and *.expected.json
// Everything here is fake: people, NPIs, CLIA numbers, addresses, phone numbers.
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = dirname(fileURLToPath(import.meta.url));
const PAGE = { width: 612, height: 792 };
const LINE_H = 11;
const CHAR_W = 5.2;
const TOP_Y = 40;

// Classic layout columns (x in PDF units, measured on a 612x792 page)
const C = { name: 36, ind: 46, inr: 260, out: 330, ref: 410, lab: 560, blkPatient: 36, blkSpecimen: 260, blkClient: 430, status: 470, pageno: 470 };
// MyQuest layout columns
const M = { name: 36, value: 240, ref: 360, flag: 520, pageno: 470 };

// ---------- document assembly ----------
function makeLine(pageNumber, index, y, cells) {
  const items = cells.map(([x, str]) => ({ str, x, y, w: Math.round(str.length * CHAR_W * 10) / 10, h: 10 }));
  const last = items[items.length - 1];
  return {
    id: `p${pageNumber}l${index}`, page: pageNumber, y,
    x0: items[0].x, x1: Math.round((last.x + last.w) * 10) / 10,
    text: cells.map((c) => c[1]).join('  '),
    cells: cells.map((c) => c[1]),
    cellX: cells.map((c) => c[0]),
    items,
  };
}

/** specs: array of { cells:[[x,text],...], at?:y } ; cells flow down from TOP_Y unless `at` is given. */
function buildPage(pageNumber, specs) {
  const lines = [];
  let y = TOP_Y;
  for (const spec of specs) {
    if (spec.at != null) y = spec.at;
    lines.push(makeLine(pageNumber, lines.length, y, spec.cells));
    y += LINE_H;
  }
  return { pageNumber, width: PAGE.width, height: PAGE.height, lines };
}

function buildDoc(fileName, pageSpecs) {
  const fileHash = createHash('sha256').update(`synthetic:${fileName}`).digest('hex');
  return { fileName, fileHash, pageCount: pageSpecs.length, pages: pageSpecs.map((specs, i) => buildPage(i + 1, specs)) };
}

// ---------- expected derivation (intent of the description, independent of the parser) ----------
const UNITS = ['Thousand/uL', 'Million/uL', 'cells/uL', 'g/dL', '%', 'fL', 'pg', 'mg/dL', 'mmol/L', 'U/L', 'mL/min/1.73m2',
  '% of total Hgb', 'ng/mL', 'mIU/L', 'mg/L', 'nmol/L', 'mcg/dL'];
const NUM = '[-+]?\\d{1,3}(?:,\\d{3})*(?:\\.\\d+)?|[-+]?\\d*\\.\\d+';
const toN = (s) => parseFloat(s.replace(/,/g, ''));

function expectRef(ref) {
  if (!ref) return { unit: null, range: { low: null, high: null, kind: null } };
  let t = ref.replace(/\s*\(calc\)$/, '').trim();
  let unit = null;
  for (const u of UNITS.slice().sort((a, b) => b.length - a.length)) {
    if (t === u) { unit = u; t = ''; break; }
    if (t.endsWith(` ${u}`)) { unit = u; t = t.slice(0, -u.length - 1).trim(); break; }
  }
  let m, range;
  if (!t) range = { low: null, high: null, kind: null };
  else if ((m = t.match(new RegExp(`^(${NUM})-(${NUM})$`)))) range = { low: toN(m[1]), high: toN(m[2]), kind: 'range' };
  else if ((m = t.match(new RegExp(`^<(${NUM})$`)))) range = { low: null, high: toN(m[1]), kind: 'lt' };
  else if ((m = t.match(new RegExp(`^>(${NUM})$`)))) range = { low: toN(m[1]), high: null, kind: 'gt' };
  else if ((m = t.match(new RegExp(`^> OR = (${NUM})$`)))) range = { low: toN(m[1]), high: null, kind: 'ge' };
  else if ((m = t.match(new RegExp(`^< OR = (${NUM})$`)))) range = { low: null, high: toN(m[1]), kind: 'le' };
  else range = { low: null, high: null, kind: 'text' };
  return { unit, range };
}

function expectValue(printed) {
  if (printed == null) return { valueText: '', value: null, valueQualifier: null, flag: null };
  let valueText = printed, flag = null;
  const m = printed.match(/^(.*?)(?:\s+(HH|LL|H|L|A|C)|\s*(\*))$/);
  if (m && m[1]) { valueText = m[1]; flag = m[3] ? 'A' : m[2]; }
  const n = valueText.match(new RegExp(`^([<>]=?)?(${NUM})$`));
  return { valueText, value: n ? toN(n[2]) : null, valueQualifier: n ? (n[1] || null) : null, flag };
}

// ---------- fixture DSL ----------
// A "section" is a list of entries rendered into cells; results are also collected into expected.
//   P(name)                      panel line at the Test Name x
//   R(name, inr, out, ref, lab)  result row (name indented); inr/out are the printed cells (out carries the flag)
//   W(text)                      wrapped-name continuation line (name column, indented)
//   N(text) / N2(a, b)           comment lines (one cell / two cells)
//   X(cells)                     raw cells
const P = (name) => ({ kind: 'panel', name });
const R = (name, inr, out, ref, lab, opts = {}) => ({ kind: 'row', name, inr, out, ref, lab, ...opts });
const W = (text) => ({ kind: 'wrap', text });
const N = (text) => ({ kind: 'note', cells: [[C.ind, text]] });
const N2 = (a, b) => ({ kind: 'note', cells: [[C.ind, a], [140, b]] });
const X = (...cells) => ({ kind: 'raw', cells });

/** Render classic-layout entries → { specs, results, panels }. Shared state keeps r-ids sequential across pages. */
function renderClassic(entries, state) {
  const specs = [];
  let pendingWrap = null;
  for (const e of entries) {
    if (e.kind === 'panel') {
      state.panel = { name: e.name, resultIds: [], page: state.page };
      state.panels.push(state.panel);
      specs.push({ cells: [[C.name, e.name]] });
    } else if (e.kind === 'wrap') {
      specs.push({ cells: [[C.ind, e.text]] });
      if (e.below && state.lastResult) { state.lastResult.name = `${state.lastResult.name} ${e.text}`; }
      else pendingWrap = e.text;
    } else if (e.kind === 'row') {
      const cells = [[C.ind, e.name]];
      if (e.inr != null) cells.push([C.inr, e.inr]);
      if (e.out != null) cells.push([C.out, e.out]);
      if (e.ref != null) cells.push([C.ref, e.ref]);
      if (e.lab != null) cells.push([C.lab, e.lab]);
      specs.push({ cells });
      const id = `r${++state.seq}`;
      const v = expectValue(e.out != null ? e.out : e.inr);
      const rf = expectRef(e.ref);
      const result = {
        id, name: pendingWrap ? `${pendingWrap} ${e.name}` : e.name,
        valueText: v.valueText, value: v.value, valueQualifier: v.valueQualifier,
        unit: rf.unit, flag: v.flag, referenceRange: rf.range,
        performingLabCode: e.lab ?? null, panel: state.panel ? state.panel.name : null, page: state.page,
        ...(e.expect || {}),
      };
      pendingWrap = null;
      state.results.push(result);
      state.lastResult = result;
      if (state.panel) state.panel.resultIds.push(id);
    } else if (e.kind === 'note' || e.kind === 'raw') {
      specs.push({ cells: e.cells });
    }
  }
  return specs;
}

// ================= classic-4page =================
const CLASSIC_TOTAL = 4;
function classicHeader(status) {
  return [
    { cells: [[C.name, 'Quest Diagnostics'], [C.status, status]] },
    { cells: [[C.blkPatient, 'Patient Information'], [C.blkSpecimen, 'Specimen Information'], [C.blkClient, 'Client Information']] },
    { cells: [[36, 'SAMPLE, ALEX Q'], [260, 'Specimen: AB123456C'], [430, 'Client #: 12345678']] },
    { cells: [[36, 'DOB: 01/15/1980'], [150, 'AGE: 45'], [260, 'Requisition: 0012345'], [430, 'DR. JANE DOE']] },
    { cells: [[36, 'Gender: M'], [260, 'Lab Ref #: 1234567'], [430, 'ANYTOWN FAMILY MEDICINE']] },
    { cells: [[36, 'Patient ID: 987654'], [260, 'Collected: 09/10/2025 / 08:15 EDT'], [430, '123 MAIN STREET, SUITE 100']] },
    { cells: [[36, 'Phone: 609.555.0100'], [260, 'Received: 09/10/2025 / 20:33 EDT'], [430, 'ANYTOWN, NJ 08540-0000']] },
    { cells: [[260, 'Reported: 09/11/2025 / 06:12 EDT'], [430, 'NPI: 1234567893']] },
    { cells: [[260, 'Fasting: Y']] },
    { cells: [[C.name, 'Test Name'], [C.inr, 'In Range'], [C.out, 'Out of Range'], [C.ref, 'Reference Range'], [C.lab, 'Lab']] },
  ];
}
const classicFooter = (n, of, name = 'SAMPLE, ALEX Q', spec = 'AB123456C') => [
  { at: 740, cells: [[36, `Patient: ${name}`], [260, `Specimen: ${spec}`], [C.pageno, `Page ${n} of ${of}`]] },
];
const LEGEND = [
  X([C.name, 'PERFORMING SITE:']),
  X([C.name, 'EZ'], [60, 'Quest Diagnostics Nichols Institute, 33608 Example Hwy, San Juan Capistrano, CA 92675-2042']),
  X([60, 'Laboratory Director: SAMPLE DIRECTOR, MD, CLIA: 05D0000001, Phone: 800.555.0199']),
  X([C.name, 'PR'], [60, 'Quest Diagnostics-Teterboro, 1 Example Blvd, Teterboro, NJ 07608-1070']),
  X([60, 'Laboratory Director: TEST PATHOLOGIST, MD, CLIA: 31D0000002, Phone: 800.555.0198']),
  X([C.name, 'CLIENT SERVICES: 1.866.555.0100']),
  X([C.name, 'Quest, Quest Diagnostics, the associated logo and all associated Quest Diagnostics marks are the trademarks of Quest Diagnostics.']),
];
const LEGEND_LABS = [
  { code: 'EZ', name: 'Quest Diagnostics Nichols Institute', address: '33608 Example Hwy, San Juan Capistrano, CA 92675-2042', director: 'SAMPLE DIRECTOR, MD', clia: '05D0000001', phone: '800.555.0199' },
  { code: 'PR', name: 'Quest Diagnostics-Teterboro', address: '1 Example Blvd, Teterboro, NJ 07608-1070', director: 'TEST PATHOLOGIST, MD', clia: '31D0000002', phone: '800.555.0198' },
];

function buildClassic() {
  const st = { seq: 0, results: [], panels: [], panel: null, lastResult: null, page: 1 };
  const pages = [];
  const body = [
    // ---- page 1: CBC ----
    [
      P('CBC (INCLUDES DIFF/PLT)'),
      R('WBC', '7.2', null, '3.8-10.8 Thousand/uL', 'EZ'),
      R('RBC', '4.85', null, '4.20-5.80 Million/uL', 'EZ'),
      R('HEMOGLOBIN', null, '12.9 L', '13.2-17.1 g/dL', 'EZ'),
      R('HEMATOCRIT', '39.5', null, '38.5-50.0 %', 'EZ'),
      R('MCV', '87.6', null, '80.0-100.0 fL', 'EZ'),
      R('MCH', '29.1', null, '27.0-33.0 pg', 'EZ'),
      R('MCHC', '33.2', null, '32.0-36.0 g/dL', 'EZ'),
      R('RDW', '13.1', null, '11.0-15.0 %', 'EZ'),
      R('PLATELET COUNT', '245', null, '140-400 Thousand/uL', 'EZ'),
      R('MPV', '10.2', null, 'Not Estab. fL', 'EZ'),
      R('ABSOLUTE NEUTROPHILS', '4,320', null, '1,500-7,800 cells/uL', 'EZ'),
      R('ABSOLUTE LYMPHOCYTES', '2,010', null, '850-3,900 cells/uL', 'EZ'),
      R('ABSOLUTE MONOCYTES', '540', null, '200-950 cells/uL', 'EZ'),
      R('ABSOLUTE EOSINOPHILS', '180', null, '15-500 cells/uL', 'EZ'),
      R('ABSOLUTE BASOPHILS', '50', null, '0-200 cells/uL', 'EZ'),
      R('NEUTROPHILS', '60.0', null, '%', 'EZ'),
      R('LYMPHOCYTES', '27.9', null, '%', 'EZ'),
      R('MONOCYTES', '7.5', null, '%', 'EZ'),
      R('EOSINOPHILS', '2.5', null, '%', 'EZ'),
      R('BASOPHILS', '0.7', null, '%', 'EZ'),
    ],
    // ---- page 2: CMP ----
    [
      P('COMPREHENSIVE METABOLIC PANEL'),
      R('GLUCOSE', '92', null, '65-99 mg/dL', 'EZ'),
      N('. Fasting reference interval'),
      R('UREA NITROGEN (BUN)', '14', null, '7-25 mg/dL', 'EZ'),
      R('CREATININE', '0.98', null, '0.60-1.35 mg/dL', 'EZ'),
      R('EGFR', '95', null, '> OR = 60 mL/min/1.73m2', 'EZ'),
      N('. eGFR is calculated using the CKD-EPI 2021 equation (creatinine, age, sex).'),
      N('. Reference Range: > OR = 60 mL/min/1.73m2'),
      N('Please note: eGFR values between 60 and 89 may be normal in some individuals.'),
      R('BUN/CREATININE RATIO', 'NOT APPLICABLE', null, '6-22 (calc)', 'EZ'),
      R('SODIUM', '139', null, '135-146 mmol/L', 'EZ'),
      R('POTASSIUM', '4.3', null, '3.5-5.3 mmol/L', 'EZ'),
      R('CHLORIDE', '103', null, '98-110 mmol/L', 'EZ'),
      R('CARBON DIOXIDE', '26', null, '20-32 mmol/L', 'EZ'),
      R('CALCIUM', '9.4', null, '8.6-10.3 mg/dL', 'EZ'),
      R('PROTEIN, TOTAL', '7.0', null, '6.1-8.1 g/dL', 'EZ'),
      R('ALBUMIN', '4.4', null, '3.6-5.1 g/dL', 'EZ'),
      R('GLOBULIN', '2.6', null, '1.9-3.7 g/dL (calc)', 'EZ'),
      R('ALBUMIN/GLOBULIN RATIO', '1.7', null, '1.0-2.5 (calc)', 'EZ'),
      R('BILIRUBIN, TOTAL', '0.6', null, '0.2-1.2 mg/dL', 'EZ'),
      R('ALKALINE PHOSPHATASE', '68', null, '36-130 U/L', 'EZ'),
      R('AST', '22', null, '10-35 U/L', 'EZ'),
      R('ALT', '28', null, '9-46 U/L', 'EZ'),
    ],
    // ---- page 3: LIPID + A1c ----
    [
      P('LIPID PANEL'),
      R('CHOLESTEROL, TOTAL', null, '210 H', '<200 mg/dL', 'EZ'),
      R('HDL CHOLESTEROL', '52', null, '> OR = 40 mg/dL', 'EZ'),
      R('TRIGLYCERIDES', null, '1,250 HH', '<150 mg/dL', 'EZ'),
      N('. Please note: Triglyceride results above 400 mg/dL may'),
      N('. affect calculated LDL and non-HDL cholesterol values.'),
      R('LDL-CHOLESTEROL', 'NOT CALC.', null, 'mg/dL (calc)', 'EZ'),
      N('. LDL-C is not calculated when triglycerides exceed 400 mg/dL.'),
      R('CHOL/HDLC RATIO', '4.0', null, '<5.0 (calc)', 'EZ'),
      R('NON HDL CHOLESTEROL', null, '158 H', '<130 mg/dL (calc)', 'EZ'),
      P('HEMOGLOBIN A1c'),
      R('HEMOGLOBIN A1c', null, '5.9 H', '<5.7 % of total Hgb', 'EZ'),
      N('. For someone without known diabetes, a hemoglobin A1c value'),
      N('. between 5.7% and 6.4% is consistent with prediabetes and'),
      N('. should be confirmed with a follow-up test.'),
      N2('Reference Range:', '<5.7 % of total Hgb'),
      N('. Prediabetes: 5.7 - 6.4'),
      N('. Diabetes: > OR = 6.5'),
      N('. Glycemic control for adults with diabetes: <7.0'),
    ],
    // ---- page 4: Vitamin D (wrapped below), TSH, Hep C (wrapped above), legend ----
    [
      P('VITAMIN D,25-OH,TOTAL,IA'),
      R('VITAMIN D, 25-OH, TOTAL,', null, '22 L', '30-100 ng/mL', 'EZ'),
      { kind: 'wrap', text: 'IMMUNOASSAY', below: true },
      N('. Vitamin D Status: Deficiency <20 ng/mL; Insufficiency 20-29 ng/mL; Optimal 30-100 ng/mL.'),
      P('TSH'),
      R('TSH', '1.85', null, '0.40-4.50 mIU/L', 'PR'),
      N('. Reference range for TSH is age dependent; 0.40-4.50 mIU/L applies to adults 21 and older.'),
      P('HEPATITIS C ANTIBODY'),
      W('HEPATITIS C ANTIBODY W/REFLEX TO'),
      R('HCV RNA, QN, PCR', 'NON-REACTIVE', null, 'NON-REACTIVE', 'PR'),
      N('Please note: A NON-REACTIVE result indicates that HCV antibody was not detected.'),
      ...LEGEND,
    ],
  ];
  body.forEach((entries, i) => {
    st.page = i + 1;
    pages.push([...classicHeader('FINAL'), ...renderClassic(entries, st), ...classicFooter(i + 1, CLASSIC_TOTAL)]);
  });
  const doc = buildDoc('classic-4page.pdf', pages);
  const expected = {
    source: { vendor: 'quest', reportStatus: 'final', pageCount: 4 },
    patient: { fullName: 'SAMPLE, ALEX Q', lastName: 'SAMPLE', firstName: 'ALEX', middleName: 'Q', dob: '1980-01-15', sex: 'M',
      ageAtCollection: 45, patientId: '987654', phone: '609.555.0100', address: null },
    specimen: { specimenId: 'AB123456C', requisition: '0012345', labRef: '1234567', collectedAt: '2025-09-10T08:15', collectedTz: 'EDT',
      receivedAt: '2025-09-10T20:33', reportedAt: '2025-09-11T06:12', enteredAt: null, fasting: true },
    provider: { orderingName: 'DR. JANE DOE', npi: '1234567893', accountNumber: '12345678', accountName: 'ANYTOWN FAMILY MEDICINE',
      address: '123 MAIN STREET, SUITE 100, ANYTOWN, NJ 08540-0000', referringName: null },
    performingLabs: LEGEND_LABS,
    panels: st.panels,
    results: st.results,
  };
  return { doc, expected };
}

// ================= myquest-portal =================
function buildMyQuest() {
  const results = [], panels = [];
  let seq = 0, panel = null;
  const header = (n, of) => [
    { cells: [[M.name, 'MyQuest']] },
    { cells: [[M.name, 'Results for JORDAN SAMPLE']] },
    { cells: [[M.name, 'Collected on 09/10/2025 8:15 AM EDT'], [300, 'Reported on 09/11/2025']] },
    ...(n === 1 ? [
      { cells: [[M.name, 'Ordered by DR. JANE DOE']] },
      { cells: [[M.name, 'Date of Birth: 06/02/2012'], [200, 'Sex: Female'], [300, 'Age: 13']] },
      { cells: [[M.name, 'Performed at: Quest Diagnostics Nichols Institute, San Juan Capistrano, CA 92675']] },
    ] : []),
  ];
  const tableHeader = { cells: [[M.name, 'Test'], [M.value, 'Your Value'], [M.ref, 'Reference Range'], [M.flag, 'Flag']] };
  const card = (name, rows, notes = []) => {
    panel = { name, resultIds: [] };
    panels.push(panel);
    const specs = [{ cells: [[M.name, name]] }, tableHeader];
    for (const [rname, value, ref, flag] of rows) {
      const cells = [[M.name, rname], [M.value, value], [M.ref, ref]];
      if (flag) cells.push([M.flag, flag]);
      specs.push({ cells });
      const id = `r${++seq}`;
      const v = expectValue(value);
      const rf = expectRef(ref);
      results.push({ id, name: rname, valueText: v.valueText, value: v.value, valueQualifier: v.valueQualifier, unit: rf.unit,
        flag: flag ? ({ Low: 'L', High: 'H', L: 'L', H: 'H', Abnormal: 'A' })[flag] : null,
        referenceRange: rf.range, performingLabCode: null, panel: name });
      panel.resultIds.push(id);
    }
    for (const n of notes) specs.push({ cells: [[M.name, n]] });
    return specs;
  };
  const footer = (n, of) => [{ at: 740, cells: [[M.name, 'MyQuest'], [M.pageno, `Page ${n} of ${of}`]] }];
  const page1 = [
    ...header(1, 2),
    ...card('CBC (INCLUDES DIFF/PLT)', [
      ['WBC', '6.5', '4.5-13.0 Thousand/uL'],
      ['RBC', '4.40', '3.80-5.20 Million/uL'],
      ['HEMOGLOBIN', '11.2', '11.7-15.5 g/dL', 'Low'],
      ['HEMATOCRIT', '34.8', '35.0-45.0 %', 'L'],
      ['MCV', '79.1', '78.0-98.0 fL'],
      ['MCH', '25.5', '25.0-33.0 pg'],
      ['MCHC', '32.2', '31.0-36.0 g/dL'],
      ['RDW', '14.9', '11.0-15.0 %'],
      ['PLATELET COUNT', '455', '140-400 Thousand/uL', 'High'],
      ['MPV', '9.8', '7.5-12.5 fL'],
    ]),
    ...footer(1, 2),
  ];
  const page2 = [
    ...header(2, 2),
    ...card('VITAMIN D,25-OH,TOTAL,IA', [['VITAMIN D, 25-OH, TOTAL', '18', '30-100 ng/mL', 'Low']],
      ['Vitamin D Status: Deficiency <20 ng/mL; Insufficiency 20-29 ng/mL; Optimal 30-100 ng/mL.']),
    ...card('FERRITIN', [['FERRITIN', '8', '16-154 ng/mL', 'L']]),
    ...card('IRON AND TIBC', [
      ['IRON, TOTAL', '45', '40-190 mcg/dL'],
      ['IRON BINDING CAPACITY', '410', '250-450 mcg/dL (calc)'],
      ['%SATURATION', '11', '15-45 % (calc)', 'Abnormal'],
    ]),
    ...card('TSH', [['TSH', '2.10', '0.50-4.30 mIU/L']]),
    ...footer(2, 2),
  ];
  const doc = buildDoc('myquest-portal.pdf', [page1, page2]);
  const expected = {
    source: { vendor: 'quest', pageCount: 2 },
    patient: { fullName: 'JORDAN SAMPLE', firstName: 'JORDAN', lastName: 'SAMPLE', dob: '2012-06-02', sex: 'F', ageAtCollection: 13, patientId: null },
    specimen: { collectedAt: '2025-09-10T08:15', collectedTz: 'EDT', reportedAt: '2025-09-11', specimenId: null },
    provider: { orderingName: 'DR. JANE DOE' },
    performingLabs: [{ code: null, name: 'Quest Diagnostics Nichols Institute', address: 'San Juan Capistrano, CA 92675', director: null, clia: null, phone: null }],
    panels,
    results,
  };
  return { doc, expected };
}

// ================= edge-cases =================
function buildEdge() {
  const st = { seq: 0, results: [], panels: [], panel: null, lastResult: null, page: 1 };
  const header = () => [
    { cells: [[C.name, 'Quest Diagnostics'], [C.status, 'CORRECTED']] },
    { cells: [[C.blkPatient, 'Patient Information'], [C.blkSpecimen, 'Specimen Information'], [C.blkClient, 'Ordering Physician']] },
    { cells: [[36, 'TEST, PAT'], [260, 'Specimen: ZZ999999X'], [430, 'Client #: 87654321']] },
    { cells: [[36, 'DOB: 03/03/1975'], [150, 'AGE: 50'], [260, 'Requisition: 0099999'], [430, 'DOE, JANE']] },
    { cells: [[36, 'Sex: F'], [260, 'Collected: 10/01/2025 / 07:45 EDT'], [430, '9 EXAMPLE ROAD']] },
    { cells: [[36, 'Patient ID:'], [260, 'Received: 10/01/2025 / 19:10 EDT'], [430, 'SOMEWHERE, NJ 08000']] },
    { cells: [[36, 'Phone:'], [260, 'Reported: 10/02/2025 / 05:30 EDT'], [430, 'NPI: 1234567893']] },
    { cells: [[260, 'Fasting: N']] },
    { cells: [[C.name, 'Test Name'], [C.inr, 'In Range'], [C.out, 'Out of Range'], [C.ref, 'Reference Range'], [C.lab, 'Lab']] },
  ];
  const body = [
    [
      P('MAGNESIUM'),
      R('MAGNESIUM', '2.0', null, 'mg/dL', 'EZ'),
      P('OSMOLALITY, CALCULATED'),
      R('OSMOLALITY, CALCULATED', '285', null, null, 'EZ'),
      P('C-REACTIVE PROTEIN'),
      R('C-REACTIVE PROTEIN', '<0.1', null, '<3.0 mg/L', 'EZ'),
      P('CREATININE WITH EGFR'),
      R('CREATININE', '0.70', null, '0.50-1.10 mg/dL', 'EZ'),
      R('EGFR', '>90', null, '> OR = 60 mL/min/1.73m2', 'EZ'),
      P('ANA SCREEN, IFA, W/REFL TITER AND PATTERN'),
      R('ANA SCREEN, IFA', null, 'POSITIVE A', 'NEGATIVE', 'PR'),
      R('ANA TITER', null, '1:40 A', '<1:40', 'PR'),
      R('ANA PATTERN', 'SPECKLED', null, null, 'PR'),
      P('LIPOPROTEIN (a)'),
      R('LIPOPROTEIN (a)', 'SEE NOTE', null, '<75 nmol/L', 'PR'),
      N('Please note: This test could not be resulted because the specimen'),
      N('. was hemolyzed. A redraw is recommended if clinically indicated.'),
      N('. Lp(a) desirable range: <75 nmol/L.'),
      P('ELECTROLYTE PANEL'),
      R('SODIUM', '140', null, '135-146 mmol/L', 'EZ'),
      R('POTASSIUM', null, '5.6*', '3.5-5.3 mmol/L', 'EZ'),
    ],
    [
      P('HEMOGLOBIN A1c'),
      R('HEMOGLOBIN A1c', '5.4', null, '<5.7 % of total Hgb', 'EZ'),
      ...LEGEND,
    ],
  ];
  const pages = [];
  body.forEach((entries, i) => {
    st.page = i + 1;
    pages.push([...header(), ...renderClassic(entries, st), ...classicFooter(i + 1, 2, 'TEST, PAT', 'ZZ999999X')]);
  });
  const doc = buildDoc('edge-cases.pdf', pages);
  const expected = {
    source: { vendor: 'quest', reportStatus: 'corrected', pageCount: 2 },
    patient: { fullName: 'TEST, PAT', lastName: 'TEST', firstName: 'PAT', middleName: null, dob: '1975-03-03', sex: 'F', ageAtCollection: 50, patientId: null, phone: null },
    specimen: { specimenId: 'ZZ999999X', requisition: '0099999', labRef: null, collectedAt: '2025-10-01T07:45', receivedAt: '2025-10-01T19:10', reportedAt: '2025-10-02T05:30', fasting: false },
    provider: { orderingName: 'DOE, JANE', npi: '1234567893', accountNumber: '87654321', accountName: null, address: '9 EXAMPLE ROAD, SOMEWHERE, NJ 08000' },
    performingLabs: LEGEND_LABS,
    panels: st.panels,
    results: st.results,
  };
  return { doc, expected };
}

// ---------- write ----------
const FIXTURES = { 'classic-4page': buildClassic, 'myquest-portal': buildMyQuest, 'edge-cases': buildEdge };
for (const [name, build] of Object.entries(FIXTURES)) {
  const { doc, expected } = build();
  writeFileSync(join(OUT_DIR, `${name}.doc.json`), JSON.stringify(doc, null, 1) + '\n');
  writeFileSync(join(OUT_DIR, `${name}.expected.json`), JSON.stringify(expected, null, 1) + '\n');
  const lines = doc.pages.reduce((n, p) => n + p.lines.length, 0);
  console.log(`${name}: ${doc.pageCount} pages, ${lines} lines, ${expected.results.length} results, ${expected.panels.length} panels`);
}
