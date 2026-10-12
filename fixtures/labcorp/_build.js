// Builds synthetic Labcorp Document fixtures (SPEC §2 line model) and their expected LabReport subsets.
// Run: node fixtures/labcorp/_build.js   → writes fixtures/labcorp/*.doc.json and *.expected.json
// Everything here is fake: people, NPIs, phones, account numbers. Lab names/addresses mimic public Labcorp sites.
//
// Compact description language (one entry = one line, top to bottom):
//   'text'                              single cell at the left margin (x=36)
//   { t:'text', x:42 }                  single cell at x
//   { cells:[[x,'text'], ...] }         explicit cells
//   { hdr:['col1','col2','col3'] }      three detail columns (x 36 / 220 / 430); '' skips a column
//   { panel:'name' }                    panel heading (x=36); starts a panel in expected
//   { row:[name, valueText, value, qualifier, unit, flagPrinted, rangeText, low, high, kind, lab],
//     wrapAbove:'first part' | wrapBelow:'second part' }   result row (name printed at x=42); the
//                                       expected object is typed here, not computed
//     row options: merge:'flag' prints "142 Low" as ONE cell; merge:'unit+flag' prints "11.9 g/dL Low" as one
//       cell; single:true prints the whole row as one cell (space-joined); rightAlign:true right-aligns the
//       value cell 8pt before the FLAG column; dx:n shifts every non-name cell by n; expectFlag overrides the
//       expected flag (e.g. 'A' for a "6.2*" value with no printed flag)
//   { note:'text', lab:'01' }           comment line under the previous row (attached in expected)
//   { y:number } / { gap:n }            absolute y / extra blank space before the line
//   { table:true }                      table header line (TESTS … LAB); { table:'portal' } uses Test Name …;
//                                       { table:'split' } prints REFERENCE and INTERVAL as two cells
//   { legend:[code, site, name, address, director, phone] }   performing-lab footer line
//   { footer:[dateIssued, STATUS, 'Page x of y'] }

import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const W = 612, H = 792, PITCH = 11.5, CW = 5.2;
const COLS = { name: 36, nameRow: 42, result: 250, flag: 330, units: 380, ref: 450, lab: 560 };
const HDR_X = [36, 220, 430];
const FLAG_MAP = { High: 'H', Low: 'L', Critical: 'C', Abnormal: 'A', null: null };

function build(name, pagesSpec) {
  const expected = { panels: [], results: [] };
  let rid = 0; let panel = null; let lastResult = null;
  const pages = pagesSpec.map((specs, pi) => {
    const pageNumber = pi + 1; let y = 40; const lines = [];
    const push = (cells) => {
      cells = cells.filter((c) => c[1] != null && c[1] !== '').sort((a, b) => a[0] - b[0]);
      const last = cells[cells.length - 1];
      lines.push({
        id: `p${pageNumber}l${lines.length}`, page: pageNumber, y: Math.round(y * 10) / 10,
        x0: cells[0][0], x1: Math.round(last[0] + last[1].length * CW), text: cells.map((c) => c[1]).join('  '),
        cells: cells.map((c) => c[1]), cellX: cells.map((c) => c[0]), items: [],
      });
      y += PITCH;
    };
    for (const s of specs) {
      if (typeof s === 'string') { push([[COLS.name, s]]); continue; }
      if (s.gap) y += PITCH * s.gap;
      if (s.y != null) y = s.y;
      if (s.t != null) { push([[s.x ?? COLS.name, s.t]]); continue; }
      if (s.cells) { push(s.cells); continue; }
      if (s.hdr) { push(s.hdr.map((t, k) => [HDR_X[k], t])); continue; }
      if (s.table) {
        const labels = s.table === 'portal' ? ['Test Name', 'Result', 'Flag', 'Units', 'Reference Interval', 'Lab']
          : ['TESTS', 'RESULT', 'FLAG', 'UNITS', 'REFERENCE INTERVAL', 'LAB'];
        if (s.table === 'split') {
          push([[COLS.name, labels[0]], [COLS.result, labels[1]], [COLS.flag, labels[2]], [COLS.units, labels[3]], [COLS.ref, 'REFERENCE'], [COLS.ref + 55, 'INTERVAL'], [COLS.lab, labels[5]]]);
          continue;
        }
        push([[COLS.name, labels[0]], [COLS.result, labels[1]], [COLS.flag, labels[2]], [COLS.units, labels[3]], [COLS.ref, labels[4]], [COLS.lab, labels[5]]]);
        continue;
      }
      if (s.panel) { panel = { name: s.panel, resultIds: [], page: pageNumber }; expected.panels.push(panel); push([[COLS.name, s.panel]]); lastResult = null; continue; }
      if (s.row) {
        const [n, vt, v, q, u, f, rt, lo, hi, kind, lab] = s.row;
        const dx = s.dx || 0;
        let valueCell = vt, flagCell = f, unitCell = u;
        if (s.merge === 'flag' && f) { valueCell = `${vt} ${f}`; flagCell = null; }
        if (s.merge === 'unit+flag') { valueCell = [vt, u, f].filter(Boolean).join(' '); flagCell = null; unitCell = null; }
        const vx = s.rightAlign ? Math.round(COLS.flag - 8 - valueCell.length * CW) : COLS.result + dx;
        if (s.wrapAbove) push([[COLS.nameRow, s.wrapAbove]]);
        if (s.single) push([[COLS.nameRow, [n, valueCell, flagCell, unitCell, rt, lab].filter(Boolean).join(' ')]]);
        else push([[COLS.nameRow, n], [vx, valueCell], [COLS.flag + dx, flagCell], [COLS.units + dx, unitCell], [COLS.ref + dx, rt], [COLS.lab + dx, lab]]);
        if (s.wrapBelow) push([[COLS.nameRow, s.wrapBelow]]);
        const id = `r${++rid}`;
        const fullName = s.wrapAbove ? `${s.wrapAbove} ${n}` : s.wrapBelow ? `${n} ${s.wrapBelow}` : n;
        lastResult = {
          id, panel: panel ? panel.name : null, name: fullName, valueText: vt, value: v, valueQualifier: q,
          unit: u ?? null, flag: s.expectFlag !== undefined ? s.expectFlag : (FLAG_MAP[f] ?? null),
          referenceRange: { text: rt ?? null, low: lo, high: hi, kind },
          performingLabCode: lab ?? null, comment: null, page: pageNumber,
        };
        expected.results.push(lastResult);
        if (panel) panel.resultIds.push(id);
        continue;
      }
      if (s.note != null) {
        push(s.lab ? [[COLS.nameRow, s.note], [COLS.lab, s.lab]] : [[COLS.nameRow, s.note]]);
        if (lastResult && !s.detached) lastResult.comment = lastResult.comment ? `${lastResult.comment}\n${s.note}` : s.note;
        continue;
      }
      if (s.legend) {
        const [code, site, lname, addr, dir, phone] = s.legend;
        push([[36, `${code} ${site}`], [78, lname], [180, addr], [410, `Dir: ${dir}`], [525, `Phone: ${phone}`]]);
        continue;
      }
      if (s.footer) {
        const [issued, status, pg] = s.footer;
        push([[36, `Date Issued: ${issued}`], [300, status], [520, pg]]);
        continue;
      }
      throw new Error(`unknown spec ${JSON.stringify(s)}`);
    }
    return { pageNumber, width: W, height: H, lines };
  });
  const fileHash = createHash('sha256').update(JSON.stringify(pages)).digest('hex');
  const doc = { fileName: `${name}.pdf`, fileHash, pageCount: pages.length, pages };
  return { doc, expected };
}

function write(name, pagesSpec, headerExpected) {
  const { doc, expected } = build(name, pagesSpec);
  const exp = { ...headerExpected, panels: expected.panels, results: expected.results };
  writeFileSync(path.join(HERE, `${name}.doc.json`), JSON.stringify(doc, null, 1) + '\n');
  writeFileSync(path.join(HERE, `${name}.expected.json`), JSON.stringify(exp, null, 1) + '\n');
  const n = doc.pages.reduce((a, p) => a + p.lines.length, 0);
  console.log(`${name}: ${doc.pages.length} pages, ${n} lines, ${expected.results.length} results, ${expected.panels.length} panels`);
}

const LAB01 = ['01', 'BN', 'LabCorp Burlington', '1447 York Court, Burlington, NC 272153361', 'Pat Example, MD', '800-555-0101'];
const LAB02 = ['02', 'SE', 'LabCorp Phoenix', '5005 S 40th St Ste 1100, Phoenix, AZ 850403222', 'Chris Sample, MD', '800-555-0102'];
const COPYRIGHT = '© 1995-2025 Laboratory Corporation of America® Holdings';
const PRIVACY = 'This document contains private and confidential health information protected by state and federal law.';
const VERSION = 'All Rights Reserved - Enterprise Report Version: 1.00';

// =====================================================================================
// classic-3page: SAMPLE, ALEX Q — classic patient report, 3 pages, 2 performing labs
// =====================================================================================
const classicHeader = () => [
  { cells: [[36, 'Labcorp'], [430, 'Patient Report']] },
  'SAMPLE, ALEX Q',
  { hdr: ['Patient Details', 'Specimen Details', 'Physician Details'] },
  { hdr: ['DOB: 01/15/1980', 'Date collected: 03/04/2025 0815 Local', 'Ordering: J SMITH'] },
  { hdr: ['Age: 45', 'Date received: 03/04/2025', 'Referring:'] },
  { hdr: ['Gender: M', 'Date entered: 03/04/2025', 'ID: 12345'] },
  { hdr: ['Patient ID: 100200300', 'Date reported: 03/05/2025 1023 ET', 'NPI: 1234567893'] },
  { hdr: ['Phone: 555-010-0100', 'Specimen ID: 063-123-4567-0', 'Account Number: 12345678'] },
  { hdr: ['', 'Fasting: Yes', 'SAMPLE FAMILY MEDICINE'] },
  { hdr: ['', '', '123 FAKE STREET STE 4'] },
  { hdr: ['', '', 'ANYTOWN NY 12345-0000'] },
  { cells: [[430, 'Phone: 555-010-0200'], [520, 'Fax: 555-010-0201']] },
  { hdr: ['', '', 'Rte: 00'] },
];
const classicFooter = (pg, labs) => [

  ...labs.map((l, i) => (i === 0 ? { legend: l, y: 700 } : { legend: l })),
  { footer: ['03/05/25 1023 ET', 'FINAL REPORT', `Page ${pg} of 3`] },
  COPYRIGHT,
  VERSION,
  PRIVACY,
];
// row: [name, valueText, value, qualifier, unit, flagPrinted, rangeText, low, high, kind, lab]
const classicPages = [
  [
    ...classicHeader(),
    'Ordered Items: CBC With Differential/Platelet; Comp. Metabolic Panel (14); Lipid Panel;',
    'Hemoglobin A1c; Vitamin D, 25-Hydroxy; TSH',
    { table: true, gap: 0.5 },
    { panel: 'CBC With Differential/Platelet' },
    { row: ['WBC', '6.8', 6.8, null, 'x10E3/uL', null, '3.4-10.8', 3.4, 10.8, 'range', '01'] },
    { row: ['RBC', '4.95', 4.95, null, 'x10E6/uL', null, '4.14-5.80', 4.14, 5.8, 'range', '01'] },
    { row: ['Hemoglobin', '15.1', 15.1, null, 'g/dL', null, '13.0-17.7', 13.0, 17.7, 'range', '01'] },
    { row: ['Hematocrit', '44.2', 44.2, null, '%', null, '37.5-51.0', 37.5, 51.0, 'range', '01'] },
    { row: ['MCV', '89', 89, null, 'fL', null, '79-97', 79, 97, 'range', '01'] },
    { row: ['MCH', '30.5', 30.5, null, 'pg', null, '26.6-33.0', 26.6, 33.0, 'range', '01'] },
    { row: ['MCHC', '34.2', 34.2, null, 'g/dL', null, '31.5-35.7', 31.5, 35.7, 'range', '01'] },
    { row: ['RDW', '12.9', 12.9, null, '%', null, '11.6-15.4', 11.6, 15.4, 'range', '01'] },
    { row: ['Platelets', '462', 462, null, 'x10E3/uL', 'High', '150-450', 150, 450, 'range', '01'] },
    { row: ['Neutrophils', '58', 58, null, '%', null, 'Not Estab.', null, null, 'text', '01'] },
    { row: ['Lymphs', '30', 30, null, '%', null, 'Not Estab.', null, null, 'text', '01'] },
    { row: ['Monocytes', '8', 8, null, '%', null, 'Not Estab.', null, null, 'text', '01'] },
    { row: ['Eos', '3', 3, null, '%', null, 'Not Estab.', null, null, 'text', '01'] },
    { row: ['Basos', '1', 1, null, '%', null, 'Not Estab.', null, null, 'text', '01'] },
    { row: ['Neutrophils (Absolute)', '3.9', 3.9, null, 'x10E3/uL', null, '1.4-7.0', 1.4, 7.0, 'range', '01'] },
    { row: ['Lymphs (Absolute)', '2.0', 2.0, null, 'x10E3/uL', null, '0.7-3.1', 0.7, 3.1, 'range', '01'] },
    { row: ['Monocytes(Absolute)', '0.5', 0.5, null, 'x10E3/uL', null, '0.1-0.9', 0.1, 0.9, 'range', '01'] },
    { row: ['Eos (Absolute)', '0.2', 0.2, null, 'x10E3/uL', null, '0.0-0.4', 0.0, 0.4, 'range', '01'] },
    { row: ['Baso (Absolute)', '0.1', 0.1, null, 'x10E3/uL', null, '0.0-0.2', 0.0, 0.2, 'range', '01'] },
    { row: ['Immature Granulocytes', '0', 0, null, '%', null, 'Not Estab.', null, null, 'text', '01'] },
    { row: ['Immature Grans (Abs)', '0.0', 0.0, null, 'x10E3/uL', null, '0.0-0.1', 0.0, 0.1, 'range', '01'] },
    ...classicFooter(1, [LAB01]),
  ],
  [
    ...classicHeader(),
    { table: true, gap: 0.5 },
    { panel: 'Comp. Metabolic Panel (14)' },
    { row: ['Glucose', '102', 102, null, 'mg/dL', 'High', '70-99', 70, 99, 'range', '01'] },
    { row: ['BUN', '15', 15, null, 'mg/dL', null, '6-24', 6, 24, 'range', '01'] },
    { row: ['Creatinine', '0.98', 0.98, null, 'mg/dL', null, '0.76-1.27', 0.76, 1.27, 'range', '01'] },
    { row: ['eGFR', '92', 92, null, 'mL/min/1.73', null, '>59', 59, null, 'gt', '01'] },
    { note: 'Please Note:', lab: '01' },
    { note: 'eGFR is calculated using the 2021 CKD-EPI creatinine equation, without a race variable.' },
    { row: ['BUN/Creatinine Ratio', '15', 15, null, null, null, '9-20', 9, 20, 'range', '01'] },
    { row: ['Sodium', '140', 140, null, 'mmol/L', null, '134-144', 134, 144, 'range', '01'] },
    { row: ['Potassium', '6.3', 6.3, null, 'mmol/L', 'Critical', '3.5-5.2', 3.5, 5.2, 'range', '01'] },
    { row: ['Chloride', '101', 101, null, 'mmol/L', null, '96-106', 96, 106, 'range', '01'] },
    { row: ['Carbon Dioxide, Total', '24', 24, null, 'mmol/L', null, '20-29', 20, 29, 'range', '01'] },
    { row: ['Calcium', '9.4', 9.4, null, 'mg/dL', null, '8.7-10.2', 8.7, 10.2, 'range', '01'] },
    { row: ['Protein, Total', '7.0', 7.0, null, 'g/dL', null, '6.0-8.5', 6.0, 8.5, 'range', '01'] },
    { row: ['Albumin', '4.5', 4.5, null, 'g/dL', null, '3.8-4.9', 3.8, 4.9, 'range', '01'] },
    { row: ['Globulin, Total', '2.5', 2.5, null, 'g/dL', null, '1.5-4.5', 1.5, 4.5, 'range', '01'] },
    { row: ['A/G Ratio', '1.8', 1.8, null, null, null, '1.2-2.2', 1.2, 2.2, 'range', '01'] },
    { row: ['Bilirubin, Total', '0.6', 0.6, null, 'mg/dL', null, '0.0-1.2', 0.0, 1.2, 'range', '01'] },
    { row: ['Alkaline Phosphatase', '68', 68, null, 'IU/L', null, '44-121', 44, 121, 'range', '01'] },
    { row: ['AST (SGOT)', '22', 22, null, 'IU/L', null, '0-40', 0, 40, 'range', '01'] },
    { row: ['ALT (SGPT)', '27', 27, null, 'IU/L', null, '0-44', 0, 44, 'range', '01'] },
    { panel: 'Lipid Panel' },
    { row: ['Cholesterol, Total', '210', 210, null, 'mg/dL', 'High', '100-199', 100, 199, 'range', '01'] },
    { row: ['Triglycerides', '1,045', 1045, null, 'mg/dL', 'High', '0-149', 0, 149, 'range', '01'] },
    { row: ['HDL Cholesterol', '38', 38, null, 'mg/dL', 'Low', '>39', 39, null, 'gt', '01'] },
    { row: ['VLDL Cholesterol Cal', '27', 27, null, 'mg/dL', null, '5-40', 5, 40, 'range', '01'] },
    { row: ['LDL Chol Calc (NIH)', '142', 142, null, 'mg/dL', 'High', '0-99', 0, 99, 'range', '01'] },
    { note: 'Comment:', lab: '01' },
    { note: 'Desirable range <100 mg/dL for primary prevention goal.' },
    { row: ['Chol/HDL Ratio', '5.5', 5.5, null, 'ratio', 'High', '0.0-5.0', 0.0, 5.0, 'range', '01'] },
    ...classicFooter(2, [LAB01]),
  ],
  [
    ...classicHeader(),
    { table: true, gap: 0.5 },
    { panel: 'Hemoglobin A1c' },
    { row: ['Hemoglobin A1c', '5.9', 5.9, null, '%', 'High', '4.8-5.6', 4.8, 5.6, 'range', '01'] },
    { note: 'Please Note:', lab: '01' },
    { note: 'Prediabetes: 5.7 - 6.4' },
    { note: 'Diabetes: >6.4' },
    { note: 'Glycemic control for adults with diabetes: <7.0' },
    { row: ['Glucose (eAG)', '123', 123, null, 'mg/dL', null, null, null, null, null, '01'], wrapAbove: 'Estimated Average' },
    { panel: 'Vitamin D, 25-Hydroxy' },
    { row: ['Vitamin D,', '32.4', 32.4, null, 'ng/mL', null, '30.0-100.0', 30.0, 100.0, 'range', '02'], wrapBelow: '25-Hydroxy' },
    { note: 'Please Note:', lab: '02' },
    { note: 'Vitamin D deficiency has been defined by the Endocrine Society as a level of <20 ng/mL.' },
    { panel: 'TSH' },
    { row: ['TSH', '1.230', 1.23, null, 'uIU/mL', null, '0.450-4.500', 0.45, 4.5, 'range', '01'] },
    ...classicFooter(3, [LAB01, LAB02]),
  ],
];
write('classic-3page', classicPages, {
  source: { vendor: 'labcorp', pageCount: 3, reportStatus: 'final' },
  patient: { fullName: 'SAMPLE, ALEX Q', lastName: 'SAMPLE', firstName: 'ALEX', middleName: 'Q', dob: '1980-01-15', sex: 'M',
    ageAtCollection: 45, patientId: '100200300', phone: '555-010-0100' },
  specimen: { specimenId: '063-123-4567-0', collectedAt: '2025-03-04T08:15', collectedTz: 'Local', receivedAt: '2025-03-04',
    enteredAt: '2025-03-04', reportedAt: '2025-03-05T10:23', fasting: true },
  provider: { orderingName: 'J SMITH', referringName: null, npi: '1234567893', accountNumber: '12345678', accountName: 'SAMPLE FAMILY MEDICINE',
    address: '123 FAKE STREET STE 4, ANYTOWN NY 12345-0000', phone: '555-010-0200', fax: '555-010-0201' },
  performingLabs: [
    { code: '01', name: 'LabCorp Burlington', address: '1447 York Court, Burlington, NC 272153361', director: 'Pat Example, MD', clia: null, phone: '800-555-0101' },
    { code: '02', name: 'LabCorp Phoenix', address: '5005 S 40th St Ste 1100, Phoenix, AZ 850403222', director: 'Chris Sample, MD', clia: null, phone: '800-555-0102' },
  ],
});

// =====================================================================================
// portal-2023: SAMPLE, JORDAN (child, F) — newer portal label set, 2 pages
// =====================================================================================
const portalHeader = () => [
  { cells: [[36, 'Labcorp'], [430, 'Final Report']] },
  { cells: [[36, 'Patient: SAMPLE, JORDAN'], [330, 'Specimen #: 123-456-7890-0']] },
  { cells: [[36, 'Date of Birth: 06/02/2012'], [330, 'Collected: 09/10/2023 0902 Local']] },
  { cells: [[36, 'Sex: F'], [330, 'Received: 09/10/2023']] },
  { cells: [[36, 'Age: 11'], [330, 'Reported: 09/11/2023 1415 ET']] },
  { cells: [[36, 'Patient ID: 998877'], [330, 'Fasting: Yes']] },
  { cells: [[36, 'Ordering Physician: A JONES'], [330, 'Account: 87654321']] },
  { cells: [[36, 'NPI: 1234567893'], [330, 'SAMPLE PEDIATRICS GROUP']] },
  { cells: [[330, '456 FAKE AVE, ANYTOWN NY 12345']] },
];
const portalFooter = (pg, labs) => [

  ...labs.map((l, i) => (i === 0 ? { legend: l, y: 700 } : { legend: l })),
  { footer: ['09/11/23 1415 ET', 'FINAL REPORT', `Page ${pg} of 2`] },
  COPYRIGHT,
  PRIVACY,
];
const portalPages = [
  [
    ...portalHeader(),
    'Ordered Items: CBC With Differential/Platelet; Ferritin; TSH',
    { table: 'portal', gap: 0.5 },
    { panel: 'CBC With Differential/Platelet' },
    { row: ['WBC', '7.2', 7.2, null, 'x10E3/uL', null, '4.5-13.5', 4.5, 13.5, 'range', '01'] },
    { row: ['RBC', '4.60', 4.6, null, 'x10E6/uL', null, '3.90-5.20', 3.9, 5.2, 'range', '01'] },
    { row: ['Hemoglobin', '13.1', 13.1, null, 'g/dL', null, '11.1-14.7', 11.1, 14.7, 'range', '01'] },
    { row: ['Hematocrit', '38.9', 38.9, null, '%', null, '34.0-44.0', 34.0, 44.0, 'range', '01'] },
    { row: ['MCV', '85', 85, null, 'fL', null, '77-95', 77, 95, 'range', '01'] },
    { row: ['MCH', '28.5', 28.5, null, 'pg', null, '25.0-33.0', 25.0, 33.0, 'range', '01'] },
    { row: ['MCHC', '33.7', 33.7, null, 'g/dL', null, '31.5-35.7', 31.5, 35.7, 'range', '01'] },
    { row: ['RDW', '12.5', 12.5, null, '%', null, '11.7-15.4', 11.7, 15.4, 'range', '01'] },
    { row: ['Platelets', '298', 298, null, 'x10E3/uL', null, '150-450', 150, 450, 'range', '01'] },
    { row: ['Neutrophils', '45', 45, null, '%', null, 'Not Estab.', null, null, 'text', '01'] },
    { row: ['Lymphs', '42', 42, null, '%', null, 'Not Estab.', null, null, 'text', '01'] },
    { row: ['Monocytes', '8', 8, null, '%', null, 'Not Estab.', null, null, 'text', '01'] },
    { row: ['Eos', '4', 4, null, '%', null, 'Not Estab.', null, null, 'text', '01'] },
    { row: ['Basos', '1', 1, null, '%', null, 'Not Estab.', null, null, 'text', '01'] },
    { row: ['Neutrophils (Absolute)', '3.2', 3.2, null, 'x10E3/uL', null, '1.5-8.0', 1.5, 8.0, 'range', '01'] },
    { row: ['Lymphs (Absolute)', '3.0', 3.0, null, 'x10E3/uL', null, '1.2-5.2', 1.2, 5.2, 'range', '01'] },
    { row: ['Monocytes(Absolute)', '0.6', 0.6, null, 'x10E3/uL', null, '0.1-1.0', 0.1, 1.0, 'range', '01'] },
    { row: ['Eos (Absolute)', '0.3', 0.3, null, 'x10E3/uL', null, '0.0-0.7', 0.0, 0.7, 'range', '01'] },
    { row: ['Baso (Absolute)', '0.1', 0.1, null, 'x10E3/uL', null, '0.0-0.2', 0.0, 0.2, 'range', '01'] },
    { row: ['Immature Granulocytes', '0', 0, null, '%', null, 'Not Estab.', null, null, 'text', '01'] },
    { row: ['Immature Grans (Abs)', '0.0', 0.0, null, 'x10E3/uL', null, '0.0-0.1', 0.0, 0.1, 'range', '01'] },
    ...portalFooter(1, [LAB01]),
  ],
  [
    ...portalHeader(),
    { table: 'portal', gap: 0.5 },
    { panel: 'Ferritin' },
    { row: ['Ferritin', '9', 9, null, 'ng/mL', 'Low', '13-150', 13, 150, 'range', '01'] },
    { note: 'Please Note:', lab: '01' },
    { note: 'Reference interval for ferritin is age and sex dependent.' },
    { panel: 'TSH' },
    { row: ['TSH', '2.110', 2.11, null, 'uIU/mL', null, '0.500-4.300', 0.5, 4.3, 'range', '01'] },
    ...portalFooter(2, [LAB01]),
  ],
];
write('portal-2023', portalPages, {
  source: { vendor: 'labcorp', pageCount: 2, reportStatus: 'final' },
  patient: { fullName: 'SAMPLE, JORDAN', lastName: 'SAMPLE', firstName: 'JORDAN', middleName: null, dob: '2012-06-02', sex: 'F',
    ageAtCollection: 11, patientId: '998877', phone: null },
  specimen: { specimenId: '123-456-7890-0', collectedAt: '2023-09-10T09:02', collectedTz: 'Local', receivedAt: '2023-09-10',
    enteredAt: null, reportedAt: '2023-09-11T14:15', fasting: true },
  provider: { orderingName: 'A JONES', referringName: null, npi: '1234567893', accountNumber: '87654321', accountName: 'SAMPLE PEDIATRICS GROUP',
    address: '456 FAKE AVE, ANYTOWN NY 12345', phone: null, fax: null },
  performingLabs: [
    { code: '01', name: 'LabCorp Burlington', address: '1447 York Court, Burlington, NC 272153361', director: 'Pat Example, MD', clia: null, phone: '800-555-0101' },
  ],
});

// =====================================================================================
// edge-cases: SAMPLE, CASEY — partial report, no table header (regex fallback), blank Patient ID,
// <0.1 / >90 / 1:40 / See Note values, rows missing units / range, 2 pages with identical headers
// =====================================================================================
const edgeHeader = () => [
  { cells: [[36, 'Labcorp'], [430, 'Partial Report']] },
  'SAMPLE, CASEY',
  { hdr: ['Patient Details', 'Specimen Details', 'Physician Details'] },
  { hdr: ['DOB: 11/30/1965', 'Date collected: 05/20/2024 0730 Local', 'Ordering: R DOE'] },
  { hdr: ['Age: 58', 'Date received: 05/20/2024', 'Referring:'] },
  { hdr: ['Gender: F', 'Date entered: 05/20/2024', 'NPI: 1234567893'] },
  { hdr: ['Patient ID:', 'Date reported: 05/21/2024 0912 ET', 'Account Number: 55566677'] },
  { hdr: ['Phone:', 'Specimen ID: 063-987-6543-0', 'SAMPLE CLINIC'] },
];
const edgeFooter = (pg, labs) => [

  ...labs.map((l, i) => (i === 0 ? { legend: l, y: 700 } : { legend: l })),
  { footer: ['05/21/24 0912 ET', 'PARTIAL REPORT', `Page ${pg} of 2`] },
  COPYRIGHT,
];
const edgePages = [
  [
    ...edgeHeader(),
    'Ordered Items: Thyroid Panel; ANA Screen, IFA w/Reflex; Hemoglobin A1c; eGFR; Iron and TIBC; Hepatitis B Surface Ab, Qual',
    { panel: 'Thyroid Panel', gap: 0.5 },
    { row: ['TSH', '<0.1', 0.1, '<', 'uIU/mL', 'Low', '0.450-4.500', 0.45, 4.5, 'range', '01'] },
    { row: ['Thyroxine (T4)', '13.4', 13.4, null, 'ug/dL', 'High', '4.5-12.0', 4.5, 12.0, 'range', '01'] },
    { row: ['T3 Uptake', '30', 30, null, '%', null, '24-39', 24, 39, 'range', '01'] },
    { row: ['Free Thyroxine Index', '4.0', 4.0, null, null, null, '1.2-4.9', 1.2, 4.9, 'range', '01'] },
    { panel: 'ANA Screen, IFA w/Reflex' },
    { row: ['ANA Direct', 'Positive', null, null, null, 'Abnormal', 'Negative', null, null, 'text', '01'] },
    { row: ['ANA Titer', '1:40', null, null, null, 'Abnormal', null, null, null, null, '01'] },
    { row: ['ANA Pattern', 'See Note', null, null, null, null, null, null, null, null, '01'] },
    { note: 'Please Note:', lab: '01' },
    { note: 'Pattern: Homogeneous. Homogeneous patterns are associated with a variety of' },
    { note: 'conditions; clinical correlation is recommended.' },
    ...edgeFooter(1, [LAB01]),
  ],
  [
    ...edgeHeader(),
    { panel: 'Hemoglobin A1c', gap: 0.5 },
    { row: ['Hemoglobin A1c', '6.1', 6.1, null, '%', 'High', '4.8-5.6', 4.8, 5.6, 'range', '01'] },
    { row: ['Estim. Avg Glu (eAG)', '128', 128, null, 'mg/dL', null, null, null, null, null, '01'] },
    { panel: 'eGFR' },
    { row: ['eGFR', '>90', 90, '>', 'mL/min/1.73', null, '>59', 59, null, 'gt', '01'] },
    { panel: 'Iron and TIBC' },
    { row: ['Iron Bind.Cap.(TIBC)', '312', 312, null, 'ug/dL', null, '250-450', 250, 450, 'range', '01'] },
    { row: ['UIBC', '220', 220, null, 'ug/dL', null, '131-425', 131, 425, 'range', '01'] },
    { row: ['Iron', '92', 92, null, 'ug/dL', null, '27-159', 27, 159, 'range', '01'] },
    { row: ['Iron Saturation', '29', 29, null, '%', null, '15-55', 15, 55, 'range', '01'] },
    { panel: 'Hepatitis B Surface Ab, Qual' },
    { row: ['Hepatitis B Surface Ab, Qual', 'Positive', null, null, null, null, 'Negative', null, null, 'text', '02'] },
    ...edgeFooter(2, [LAB01, LAB02]),
  ],
];
write('edge-cases', edgePages, {
  source: { vendor: 'labcorp', pageCount: 2, reportStatus: 'partial' },
  patient: { fullName: 'SAMPLE, CASEY', lastName: 'SAMPLE', firstName: 'CASEY', middleName: null, dob: '1965-11-30', sex: 'F',
    ageAtCollection: 58, patientId: null, phone: null },
  specimen: { specimenId: '063-987-6543-0', collectedAt: '2024-05-20T07:30', collectedTz: 'Local', receivedAt: '2024-05-20',
    enteredAt: '2024-05-20', reportedAt: '2024-05-21T09:12', fasting: null },
  provider: { orderingName: 'R DOE', referringName: null, npi: '1234567893', accountNumber: '55566677', accountName: 'SAMPLE CLINIC',
    address: null, phone: null, fax: null },
  performingLabs: [
    { code: '01', name: 'LabCorp Burlington', address: '1447 York Court, Burlington, NC 272153361', director: 'Pat Example, MD', clia: null, phone: '800-555-0101' },
    { code: '02', name: 'LabCorp Phoenix', address: '5005 S 40th St Ste 1100, Phoenix, AZ 850403222', director: 'Chris Sample, MD', clia: null, phone: '800-555-0102' },
  ],
});

// =====================================================================================
// robust-cases: SAMPLE, ROBIN — one layout quirk per parser fix:
//   page 1: no table header (shape fallback); "Ordering:" / "Patient ID:" with the value on the line BELOW;
//           account block in the LEFT column with the first panel two lines under it; "142 Low" and
//           "11.9 g/dL Low" as single cells; a whole row in one cell; "6.2*" star value; labelled A1c notes
//           ("Prediabetes: 5.7 - 6.4", "Diabetes: >6.4") directly above the next row
//   page 2: table header split as REFERENCE | INTERVAL; rows printed 15pt left of the header; right-aligned
//           values; an in-table comment that looks like a performing-lab legend ("50 TO 100 mg/dL is ...");
//           a short note with a range above a row; panel headings with function words not in Ordered Items
// =====================================================================================
const robustHeader = () => [
  { cells: [[36, 'Labcorp'], [430, 'Patient Report']] },
  'SAMPLE, ROBIN',
  { hdr: ['Patient Details', 'Specimen Details', 'Physician Details'] },
  { hdr: ['DOB: 04/02/1975', 'Date collected: 06/10/2025 0745 Local', 'Ordering:'] },
  { hdr: ['Age: 50', 'Date received: 06/10/2025', 'K LEE'] },
  { hdr: ['Gender: F', 'Date entered: 06/10/2025', 'Referring:'] },
  { hdr: ['Patient ID:', 'Date reported: 06/11/2025 0930 ET', 'NPI: 1234567893'] },
  { hdr: ['200300400', 'Specimen ID: 063-555-1212-0', ''] },
  { hdr: ['Account Number: 22334455', '', ''] },
  { hdr: ['SAMPLE INTERNAL MEDICINE', '', ''] },
  { hdr: ['77 FAKE ROAD', '', ''] },
];
const robustFooter = (pg, labs) => [
  ...labs.map((l, i) => (i === 0 ? { legend: l, y: 700 } : { legend: l })),
  { footer: ['06/11/25 0930 ET', 'FINAL REPORT', `Page ${pg} of 2`] },
  COPYRIGHT,
];
const robustPages = [
  [
    ...robustHeader(),
    'Ordered Items: CBC With Differential/Platelet; Hemoglobin A1c; Lipid Panel',
    { panel: 'CBC With Differential/Platelet', gap: 0.5 },
    { row: ['WBC', '7.7', 7.7, null, 'x10E3/uL', null, '3.4-10.8', 3.4, 10.8, 'range', '01'] },
    { row: ['Platelets', '142', 142, null, 'x10E3/uL', 'Low', '150-450', 150, 450, 'range', '01'], merge: 'flag' },
    { row: ['Hemoglobin', '11.9', 11.9, null, 'g/dL', 'Low', '13.0-17.7', 13.0, 17.7, 'range', '01'], merge: 'unit+flag' },
    { row: ['MCV', '101', 101, null, 'fL', 'High', '79-97', 79, 97, 'range', '01'], single: true },
    { panel: 'Hemoglobin A1c' },
    { row: ['Hemoglobin A1c', '6.2*', 6.2, null, '%', null, '4.8-5.6', 4.8, 5.6, 'range', '01'], expectFlag: 'A' },
    { note: 'Please Note:', lab: '01' },
    { note: 'Prediabetes: 5.7 - 6.4' },
    { note: 'Diabetes: >6.4' },
    { row: ['Glucose (eAG)', '131', 131, null, 'mg/dL', null, null, null, null, null, '01'] },
    ...robustFooter(1, [LAB01]),
  ],
  [
    ...robustHeader(),
    { table: 'split', gap: 0.5 },
    { panel: 'Lipid Panel' },
    { row: ['Cholesterol, Total', '210', 210, null, 'mg/dL', 'High', '100-199', 100, 199, 'range', '01'], dx: -15 },
    { row: ['Triglycerides', '98', 98, null, 'mg/dL', null, '0-149', 0, 149, 'range', '01'], dx: -15 },
    { row: ['HDL Cholesterol', '58', 58, null, 'mg/dL', null, '>39', 39, null, 'gt', '01'], rightAlign: true },
    { note: '50 TO 100 mg/dL is the optimal target' },
    { row: ['LDL Chol Calc (NIH)', '135', 135, null, 'mg/dL', 'High', '0-99', 0, 99, 'range', '01'], rightAlign: true, merge: 'flag' },
    { note: 'Fasting 8-12 hours' },
    { row: ['Chol/HDL Ratio', '3.6', 3.6, null, 'ratio', null, '0.0-5.0', 0.0, 5.0, 'range', '01'] },
    { panel: 'Thyroid Panel With TSH' },
    { row: ['TSH', '2.410', 2.41, null, 'uIU/mL', null, '0.450-4.500', 0.45, 4.5, 'range', '01'] },
    { row: ['Thyroxine (T4)', '7.9', 7.9, null, 'ug/dL', null, '4.5-12.0', 4.5, 12.0, 'range', '01'] },
    { panel: 'Iron and TIBC' },
    { row: ['Iron', '85', 85, null, 'ug/dL', null, '27-159', 27, 159, 'range', '02'] },
    ...robustFooter(2, [LAB01, LAB02]),
  ],
];
write('robust-cases', robustPages, {
  source: { vendor: 'labcorp', pageCount: 2, reportStatus: 'final' },
  patient: { fullName: 'SAMPLE, ROBIN', lastName: 'SAMPLE', firstName: 'ROBIN', middleName: null, dob: '1975-04-02', sex: 'F',
    ageAtCollection: 50, patientId: '200300400', phone: null },
  specimen: { specimenId: '063-555-1212-0', collectedAt: '2025-06-10T07:45', collectedTz: 'Local', receivedAt: '2025-06-10',
    enteredAt: '2025-06-10', reportedAt: '2025-06-11T09:30', fasting: null },
  provider: { orderingName: 'K LEE', referringName: null, npi: '1234567893', accountNumber: '22334455', accountName: 'SAMPLE INTERNAL MEDICINE',
    address: '77 FAKE ROAD', phone: null, fax: null },
  performingLabs: [
    { code: '01', name: 'LabCorp Burlington', address: '1447 York Court, Burlington, NC 272153361', director: 'Pat Example, MD', clia: null, phone: '800-555-0101' },
    { code: '02', name: 'LabCorp Phoenix', address: '5005 S 40th St Ste 1100, Phoenix, AZ 850403222', director: 'Chris Sample, MD', clia: null, phone: '800-555-0102' },
  ],
});
