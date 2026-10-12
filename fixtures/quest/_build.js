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
  '% of total Hgb', 'ng/mL', 'mIU/L', 'mg/L', 'nmol/L', 'mcg/dL', 'mg/24 hr'];
const NUM = '[-+]?\\d{1,3}(?:,\\d{3})+(?:\\.\\d+)?|[-+]?\\d+(?:\\.\\d+)?|[-+]?\\.\\d+';   // "4,320", "4320", "0.98", ".5"
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

const FLAG_WORDS = { HH: 'HH', LL: 'LL', H: 'H', L: 'L', A: 'A', C: 'C', High: 'H', Low: 'L', Critical: 'C', Abnormal: 'A' };
function expectValue(printed) {
  if (printed == null) return { valueText: '', value: null, valueQualifier: null, flag: null };
  let valueText = printed, flag = null;
  const m = printed.match(/^(.*?)(?:\s+(HH|LL|H|L|A|C|High|Low|Critical|Abnormal)|\s*(\*))$/);
  if (m && m[1]) { valueText = m[1]; flag = m[3] ? 'A' : FLAG_WORDS[m[2]]; }
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

/**
 * Render classic-layout entries → { specs, results, panels }. Shared state keeps r-ids sequential across pages.
 * state.cols (optional) overrides the row column x's ({ ind, inr, out, ref, lab }) — used to print rows drifted
 * relative to the table header, or flush with the panel names.
 */
function renderClassic(entries, state) {
  const specs = [];
  const K = { ...C, ...(state.cols || {}) };
  let pendingWrap = null;
  for (const e of entries) {
    if (e.kind === 'panel') {
      state.panel = { name: e.name, resultIds: [], page: state.page };
      state.panels.push(state.panel);
      specs.push({ cells: [[C.name, e.name]] });
    } else if (e.kind === 'wrap') {
      specs.push({ cells: [[K.ind, e.text]] });
      if (e.below && state.lastResult) { state.lastResult.name = `${state.lastResult.name} ${e.text}`; }
      else pendingWrap = e.text;
    } else if (e.kind === 'rawrow') {                       // a row printed as ONE text item with single spaces
      specs.push({ cells: e.cells });
      const id = `r${++state.seq}`;
      const result = { id, panel: state.panel ? state.panel.name : null, page: state.page, ...e.result };
      state.results.push(result);
      state.lastResult = result;
      if (state.panel) state.panel.resultIds.push(id);
    } else if (e.kind === 'row') {
      const cells = [[K.ind, e.name]];
      if (e.inr != null) cells.push([K.inr, e.inr]);
      if (e.out != null) cells.push([K.out, e.out]);
      if (e.ref != null) cells.push([K.ref, e.ref]);
      if (e.lab != null) cells.push([K.lab, e.lab]);
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

// ================= robust-layout =================
// Classic report whose geometry and vocabulary differ from the "clean" fixtures (each item mirrors a parser fix):
//  - page 1 rows are printed 15pt LEFT of the table-header labels (column drift); page 2 rows are flush with the panel names
//  - "DOB: … AGE: … Gender: …" is ONE text item; "Patient ID:" has its value on the line below
//  - result names starting with a digit; flag words (High/Low/Critical); "6.2*" star flag; units printed after the value
//  - a two-cell prose comment whose second cell sits under Reference Range; a "Physician should …" sentence in the table
//  - wrapped names without indentation (continuation below and above); a one-word panel directly after a row
//  - a row printed as a single text item with single spaces (relaxed split)
function buildRobust() {
  const st = { seq: 0, results: [], panels: [], panel: null, lastResult: null, page: 1, cols: null };
  const header = () => [
    { cells: [[C.name, 'Quest Diagnostics'], [C.status, 'FINAL']] },
    { cells: [[C.blkPatient, 'Patient Information'], [C.blkSpecimen, 'Specimen Information'], [C.blkClient, 'Client Information']] },
    { cells: [[36, 'ROBUST, CASEY'], [260, 'Specimen: RB246810Z'], [430, 'Client #: 55555555']] },
    { cells: [[36, 'DOB: 02/20/1970  AGE: 55  Gender: F'], [260, 'Requisition: 0055555'], [430, 'DR. SAM ROE']] },
    { cells: [[36, 'Patient ID:'], [260, 'Collected: 09/15/2025 / 07:30 EDT'], [430, '55 EXAMPLE AVENUE']] },
    { cells: [[36, '246810'], [260, 'Received: 09/15/2025 / 18:05 EDT'], [430, 'ANYTOWN, NJ 08540']] },
    { cells: [[36, 'Phone: 609.555.0155'], [260, 'Reported: 09/16/2025 / 05:40 EDT'], [430, 'NPI: 1234567893']] },
    { cells: [[C.name, 'Test Name'], [C.inr, 'In Range'], [C.out, 'Out of Range'], [C.ref, 'Reference Range'], [C.lab, 'Lab']] },
  ];
  const footer = (n) => classicFooter(n, 2, 'ROBUST, CASEY', 'RB246810Z');
  // ---- page 1: rows drifted 15pt left of the header labels ----
  const page1 = [
    P('CBC (INCLUDES DIFF/PLT)'),
    R('WBC', '7.2', null, '3.8-10.8 Thousand/uL', 'EZ'),
    R('HEMOGLOBIN', '15.1', null, '13.2-17.1 g/dL', 'EZ'),
    R('PLATELET COUNT', null, '135 L', '140-400 Thousand/uL', 'EZ'),
    R('ABSOLUTE NEUTROPHILS', '4320', null, '1500-7800 cells/uL', 'EZ'),
    R('NEUTROPHILS', '58.0', null, '%', 'EZ'),
    P('MISCELLANEOUS CHEMISTRY'),
    R('25-OH VITAMIN D', '31.8', null, '30.0-100.0 ng/mL', 'EZ'),
    R('5-HIAA', '3.2', null, '2.0-8.0 mg/24 hr', 'PR'),
    R('GLUCOSE', null, '104 High', '65-99 mg/dL', 'EZ'),
    R('POTASSIUM', null, '6.1 Critical', '3.5-5.3 mmol/L', 'EZ'),
    R('HEMOGLOBIN A1c', null, '6.2*', '<5.7 % of total Hgb', 'EZ'),
    R('LDL-CHOLESTEROL', '133 mg/dL (calc)', null, null, 'EZ', { expect: { valueText: '133', value: 133, unit: 'mg/dL' } }),
    { kind: 'note', cells: [[31, 'Reference range for LDL is based on'], [C.ref - 15, 'the ATP III guidelines <100 mg/dL']] },
    R('HEMOGLOBIN A1c, POC', '5.4 % of total Hgb', null, null, 'EZ', { expect: { valueText: '5.4', value: 5.4, unit: '% of total Hgb' } }),
    { kind: 'note', cells: [[31, 'Physician should correlate these results with clinical findings.']] },
  ];
  // ---- page 2: rows flush with the panel names (x = 36) ----
  const page2 = [
    P('HEPATITIS PANEL, ACUTE'),
    R('HEPATITIS B SURFACE', 'NON-REACTIVE', null, 'NON-REACTIVE', 'PR'),
    { kind: 'wrap', text: 'ANTIGEN', below: true },
    R('HEPATITIS A IGM', 'NON-REACTIVE', null, 'NON-REACTIVE', 'PR'),
    W('HEPATITIS C ANTIBODY W/REFLEX TO'),
    R('HCV RNA, QN, PCR', 'NON-REACTIVE', null, 'NON-REACTIVE', 'PR'),
    P('TSH'),
    R('TSH', '2.15', null, '0.40-4.50 mIU/L', 'EZ'),
    P('MAGNESIUM'),
    { kind: 'rawrow', cells: [[36, 'MAGNESIUM 2.0 1.5-2.5 mg/dL EZ']],
      result: { name: 'MAGNESIUM', valueText: '2.0', value: 2, valueQualifier: null, unit: 'mg/dL', flag: null, referenceRange: { low: 1.5, high: 2.5, kind: 'range' }, performingLabCode: 'EZ' } },
    ...LEGEND,
  ];
  const pages = [];
  st.page = 1; st.cols = { ind: 31, inr: C.inr - 15, out: C.out - 15, ref: C.ref - 15, lab: C.lab - 15 };
  pages.push([...header(), ...renderClassic(page1, st), ...footer(1)]);
  st.page = 2; st.cols = { ind: 36 };
  pages.push([...header(), ...renderClassic(page2, st), ...footer(2)]);
  const doc = buildDoc('robust-layout.pdf', pages);
  const expected = {
    source: { vendor: 'quest', reportStatus: 'final', pageCount: 2 },
    patient: { fullName: 'ROBUST, CASEY', lastName: 'ROBUST', firstName: 'CASEY', dob: '1970-02-20', sex: 'F', ageAtCollection: 55, patientId: '246810', phone: '609.555.0155', address: null },
    specimen: { specimenId: 'RB246810Z', requisition: '0055555', collectedAt: '2025-09-15T07:30', receivedAt: '2025-09-15T18:05', reportedAt: '2025-09-16T05:40' },
    provider: { orderingName: 'DR. SAM ROE', npi: '1234567893', accountNumber: '55555555', address: '55 EXAMPLE AVENUE, ANYTOWN, NJ 08540' },
    performingLabs: LEGEND_LABS,
    panels: st.panels,
    results: st.results,
  };
  return { doc, expected };
}

// ================= myquest-noheader =================
// MyQuest export without any "Test / Your Value / Reference Range / Flag" header line, "Results for" / "Ordered by"
// with the value on the next line, DOB + Sex in one text item, no AGE label (age derived from DOB and collection date),
// a 4-cell flagged row, "6.2* %" and "0-2 /HPF" values, a "Non Reactive" text value, and a printed "Final" status.
function buildMyQuestNoHeader() {
  const results = [], panels = [];
  let seq = 0, panel = null;
  const row = (name, value, ref, flag, exp) => {
    const cells = [[M.name, name], [M.value, value], [M.ref, ref]];
    if (flag) cells.push([M.flag, flag]);
    const id = `r${++seq}`;
    results.push({ id, name, panel: panel.name, page: 1, performingLabCode: null, ...exp });
    panel.resultIds.push(id);
    return { cells };
  };
  const card = (name) => { panel = { name, resultIds: [], page: 1 }; panels.push(panel); return { cells: [[M.name, name]] }; };
  const page1 = [
    { cells: [[M.name, 'MyQuest'], [430, 'Quest Diagnostics']] },
    { cells: [[M.name, 'Results for'], [430, 'Final']] },
    { cells: [[M.name, 'JORDAN SAMPLE']] },
    { cells: [[M.name, 'Date of Birth: 06/02/2012  Sex: Female']] },
    { cells: [[M.name, 'Collected on 09/10/2025 8:15 AM EDT'], [300, 'Reported on 09/11/2025']] },
    { cells: [[M.name, 'Ordered by'], [300, 'Specimen: CD789012E']] },
    { cells: [[M.name, 'DR. JANE DOE']] },
    card('LIPID PANEL'),
    row('CHOLESTEROL, TOTAL', '178 mg/dL', '<170 mg/dL', 'H', { valueText: '178', value: 178, unit: 'mg/dL', flag: 'H', referenceRange: { text: '<170', low: null, high: 170, kind: 'lt' } }),
    row('HDL CHOLESTEROL', '52 mg/dL', '> OR = 45 mg/dL', null, { valueText: '52', value: 52, unit: 'mg/dL', flag: null, referenceRange: { text: '> OR = 45', low: 45, high: null, kind: 'ge' } }),
    card('HEMOGLOBIN A1c'),
    row('HEMOGLOBIN A1c', '6.2* %', '4.8-5.6 %', null, { valueText: '6.2', value: 6.2, unit: '%', flag: 'A', referenceRange: { text: '4.8-5.6', low: 4.8, high: 5.6, kind: 'range' } }),
    card('URINALYSIS, COMPLETE'),
    row('RBC, UA', '0-2 /HPF', '0-1 /HPF', null, { valueText: '0-2', value: null, unit: '/HPF', flag: null, referenceRange: { text: '0-1', low: 0, high: 1, kind: 'range' } }),
    card('HIV SCREEN'),
    row('HIV AG/AB', 'Non Reactive', 'Non Reactive', null, { valueText: 'Non Reactive', value: null, unit: null, flag: null, referenceRange: { text: 'Non Reactive', kind: 'text' } }),
    { cells: [[M.name, 'Quest, Quest Diagnostics and MyQuest are trademarks of Quest Diagnostics.']] },
    { at: 740, cells: [[M.name, 'MyQuest'], [M.pageno, 'Page 1 of 1']] },
  ];
  const doc = buildDoc('myquest-noheader.pdf', [page1]);
  const expected = {
    source: { vendor: 'quest', reportStatus: 'final', pageCount: 1 },
    patient: { fullName: 'JORDAN SAMPLE', firstName: 'JORDAN', lastName: 'SAMPLE', dob: '2012-06-02', sex: 'F', ageAtCollection: 13, patientId: null, address: null },
    specimen: { specimenId: 'CD789012E', collectedAt: '2025-09-10T08:15', collectedTz: 'EDT', reportedAt: '2025-09-11' },
    provider: { orderingName: 'DR. JANE DOE', address: null },
    panels,
    results,
  };
  return { doc, expected };
}

// ---------- write ----------
const FIXTURES = { 'classic-4page': buildClassic, 'myquest-portal': buildMyQuest, 'edge-cases': buildEdge, 'robust-layout': buildRobust, 'myquest-noheader': buildMyQuestNoHeader };
for (const [name, build] of Object.entries(FIXTURES)) {
  const { doc, expected } = build();
  writeFileSync(join(OUT_DIR, `${name}.doc.json`), JSON.stringify(doc, null, 1) + '\n');
  writeFileSync(join(OUT_DIR, `${name}.expected.json`), JSON.stringify(expected, null, 1) + '\n');
  const lines = doc.pages.reduce((n, p) => n + p.lines.length, 0);
  console.log(`${name}: ${doc.pageCount} pages, ${lines} lines, ${expected.results.length} results, ${expected.panels.length} panels`);
}
