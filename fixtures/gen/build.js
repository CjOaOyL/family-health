// Synthetic Labcorp / Quest PDF generator (pdf-lib).
// `node fixtures/gen/build.js` writes fixtures/pdf/*.pdf. Also importable:
//   import { REPORTS, buildPdf, countResults } from './fixtures/gen/build.js'
// Every person, provider, NPI, address and phone number here is fake.
// Layout contract (shared with the hand-authored *.doc.json fixtures):
//   Labcorp columns  TESTS=36 RESULT=250 FLAG=330 UNITS=380 REF=450 LAB=560
//   Quest columns    TestName=36 InRange=260 OutOfRange=330 RefRange=410 Lab=560
//   MyQuest columns  Test=36 YourValue=260 ReferenceRange=380 Flag=540
//   Letter 612x792, Helvetica / Helvetica-Bold, body 8pt, line pitch 11pt (classic) / 12pt (MyQuest)

import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { writeFile, mkdir } from 'node:fs/promises';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const PAGE = { width: 612, height: 792 };

export const COLUMNS = {
  labcorp: { name: 36, value: 250, flag: 330, unit: 380, ref: 450, lab: 560 },
  quest: { name: 36, inRange: 260, outOfRange: 330, ref: 410, lab: 560 },
  myquest: { name: 36, value: 260, ref: 380, flag: 540 },
};

export const LAYOUT = {
  'labcorp-classic': { bodyTop: 262, bodyBottom: 690, lineHeight: 11, fontSize: 8, noteIndent: 10 },
  'labcorp-portal': { bodyTop: 190, bodyBottom: 690, lineHeight: 11, fontSize: 8, noteIndent: 10 },
  'quest-classic': { bodyTop: 190, bodyBottom: 680, lineHeight: 11, fontSize: 8, noteIndent: 10 },
  'quest-myquest': { bodyTop: 150, bodyBottom: 700, lineHeight: 12, fontSize: 9, noteIndent: 10 },
};

// ---------------------------------------------------------------------------
// Row helpers. Labcorp row: [name, value, flag, unit, ref, lab, opts]
// Quest row: [name, value, flag, ref(with unit), lab, opts]. opts: { notes: [], cont: 'second line of name' }
const L = (name, value, flag, unit, ref, lab = '01', opts = {}) => ({ name, value, flag, unit, ref, lab, ...opts });
const Q = (name, value, flag, ref, lab = 'EZ', opts = {}) => ({ name, value, flag, ref, lab, ...opts });
const M = (name, value, ref, flag = '', opts = {}) => ({ name, value, ref, flag, ...opts });
const PAGE_BREAK = { pageBreak: true };

// ---------------------------------------------------------------------------
// 1. Labcorp classic patient report, 3 pages
export const labcorpClassic = {
  file: 'labcorp-classic.pdf',
  layout: 'labcorp-classic',
  vendor: 'labcorp',
  expectedPages: 3,
  patient: { name: 'SAMPLE, ALEX Q', dob: '01/15/1980', age: '45', gender: 'M', patientId: '123456789', phone: '609-555-0100' },
  specimen: {
    collected: '03/04/2025 0815 Local', received: '03/04/2025', entered: '03/04/2025',
    reported: '03/05/2025 1023 ET', specimenId: '063-123-4567-0', fasting: 'Yes',
  },
  physician: { ordering: 'J SMITH', referring: '', id: '12345', npi: '1234567893' },
  account: {
    number: '12345678', name: 'Sample Family Medicine', address1: '123 Sample Street, Suite 100',
    address2: 'Anytown, NJ 08540', phone: '609-555-0200', fax: '609-555-0201', rte: '00',
  },
  orderedItems: 'CBC With Differential/Platelet; Comp. Metabolic Panel (14); Lipid Panel; Hemoglobin A1c; Vitamin D, 25-Hydroxy; TSH; T4,Free(Direct)',
  footer: {
    sites: [
      '01 BN  LabCorp Burlington  1447 York Court, Burlington, NC 272153361  Dir: William F Hancock, MD  Phone: 800-762-4344',
      '02 RN  LabCorp Raritan  69 First Ave, Raritan, NJ 088691800  Dir: Sample B Director, MD  Phone: 800-631-5250',
    ],
    dateIssued: '03/05/25 1023 ET',
    status: 'FINAL REPORT',
    copyright: '(c) 1995-2025 Laboratory Corporation of America Holdings  All Rights Reserved - Enterprise Report Version: 1.00',
  },
  panels: [
    {
      name: 'CBC With Differential/Platelet',
      rows: [
        L('WBC', '6.8', '', 'x10E3/uL', '3.4-10.8'),
        L('RBC', '4.95', '', 'x10E6/uL', '4.14-5.80'),
        L('Hemoglobin', '15.1', '', 'g/dL', '13.0-17.7'),
        L('Hematocrit', '44.6', '', '%', '37.5-51.0'),
        L('MCV', '90', '', 'fL', '79-97'),
        L('MCH', '30.5', '', 'pg', '26.6-33.0'),
        L('MCHC', '33.9', '', 'g/dL', '31.5-35.7'),
        L('RDW', '12.8', '', '%', '11.6-15.4'),
        L('Platelets', '142', 'Low', 'x10E3/uL', '150-450'),
        L('Neutrophils', '58', '', '%', 'Not Estab.'),
        L('Lymphs', '30', '', '%', 'Not Estab.'),
        L('Monocytes', '8', '', '%', 'Not Estab.'),
        L('Eos', '3', '', '%', 'Not Estab.'),
        L('Basos', '1', '', '%', 'Not Estab.'),
        L('Neutrophils (Absolute)', '3.9', '', 'x10E3/uL', '1.4-7.0'),
        L('Lymphs (Absolute)', '2.0', '', 'x10E3/uL', '0.7-3.1'),
        L('Monocytes(Absolute)', '0.5', '', 'x10E3/uL', '0.1-0.9'),
        L('Eos (Absolute)', '0.2', '', 'x10E3/uL', '0.0-0.4'),
        L('Baso (Absolute)', '0.1', '', 'x10E3/uL', '0.0-0.2'),
        L('Immature Granulocytes', '0', '', '%', 'Not Estab.'),
        L('Immature Grans (Abs)', '0.0', '', 'x10E3/uL', '0.0-0.1'),
      ],
    },
    {
      name: 'Comp. Metabolic Panel (14)',
      rows: [
        L('Glucose', '104', 'High', 'mg/dL', '70-99'),
        L('BUN', '15', '', 'mg/dL', '6-24'),
        L('Creatinine', '1.02', '', 'mg/dL', '0.76-1.27'),
        L('eGFR', '92', '', 'mL/min/1.73', '>59', '01', {
          notes: ['Please Note: eGFR is calculated using the 2021 CKD-EPI creatinine equation', 'and is reported without adjustment for race.'],
        }),
        L('BUN/Creatinine Ratio', '15', '', '', '9-20'),
        L('Sodium', '140', '', 'mmol/L', '134-144'),
        L('Potassium', '6.1', 'Critical', 'mmol/L', '3.5-5.2'),
        L('Chloride', '102', '', 'mmol/L', '96-106'),
        L('Carbon Dioxide, Total', '25', '', 'mmol/L', '20-29'),
        L('Calcium', '9.5', '', 'mg/dL', '8.7-10.2'),
        L('Protein, Total', '7.0', '', 'g/dL', '6.0-8.5'),
        L('Albumin', '4.6', '', 'g/dL', '4.1-5.1'),
        L('Globulin, Total', '2.4', '', 'g/dL', '1.5-4.5'),
        L('A/G Ratio', '1.9', '', '', '1.2-2.2'),
        L('Bilirubin, Total', '0.6', '', 'mg/dL', '0.0-1.2'),
        L('Alkaline Phosphatase', '71', '', 'IU/L', '44-121'),
        L('AST (SGOT)', '22', '', 'IU/L', '0-40'),
        L('ALT (SGPT)', '31', '', 'IU/L', '0-44'),
      ],
    },
    PAGE_BREAK,
    {
      name: 'Lipid Panel',
      rows: [
        L('Cholesterol, Total', '210', 'High', 'mg/dL', '100-199'),
        L('Triglycerides', '145', '', 'mg/dL', '0-149'),
        L('HDL Cholesterol', '48', '', 'mg/dL', '>39'),
        L('VLDL Cholesterol Cal', '27', '', 'mg/dL', '5-40'),
        L('LDL Chol Calc (NIH)', '135', 'High', 'mg/dL', '0-99', '01', {
          notes: ['Desirable range <100 mg/dL for primary prevention goal.'],
        }),
        L('Chol/HDL Ratio', '4.4', '', 'ratio', '0.0-5.0'),
      ],
    },
    {
      name: 'Hemoglobin A1c',
      rows: [
        L('Hemoglobin A1c', '5.4', '', '%', '4.8-5.6', '01', {
          notes: ['Please Note:', 'Prediabetes: 5.7 - 6.4', 'Diabetes: >6.4', 'Glycemic control for adults with diabetes: <7.0'],
        }),
      ],
    },
    {
      name: 'Vitamin D, 25-Hydroxy',
      rows: [
        L('Vitamin D, 25-Hydroxy', '24.3', 'Low', 'ng/mL', '30.0-100.0', '02', {
          notes: ['Vitamin D deficiency has been defined by the Endocrine Society as a', '25(OH) D level of <20 ng/mL.'],
        }),
      ],
    },
    {
      name: 'TSH',
      rows: [L('TSH', '2.150', '', 'uIU/mL', '0.450-4.500', '01')],
    },
    {
      name: 'T4,Free(Direct)',
      rows: [
        // Deliberately wrapped two-line test name: value is on the first line, continuation below.
        L('Thyroxine (T4) Free,', '1.22', '', 'ng/dL', '0.82-1.77', '01', { cont: 'Direct' }),
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
// 2. Labcorp portal variant (2023+ label set), 2 pages
export const labcorpPortal = {
  file: 'labcorp-portal.pdf',
  layout: 'labcorp-portal',
  vendor: 'labcorp',
  expectedPages: 2,
  patient: { name: 'SAMPLE, JORDAN', dob: '06/02/2012', age: '12', sex: 'F', patientId: '555123' },
  specimen: { specimenId: '063-765-4321-0', collected: '03/04/2025 0830 Local', received: '03/04/2025', reported: '03/05/2025 1102 ET', fasting: 'No' },
  physician: { ordering: 'J SMITH', npi: '1234567893' },
  account: { number: '12345678', name: 'Sample Family Medicine' },
  footer: {
    sites: [
      '01 BN  LabCorp Burlington  1447 York Court, Burlington, NC 272153361  Dir: William F Hancock, MD  Phone: 800-762-4344',
      '02 RN  LabCorp Raritan  69 First Ave, Raritan, NJ 088691800  Dir: Sample B Director, MD  Phone: 800-631-5250',
    ],
    dateIssued: '03/05/25 1102 ET',
    status: 'FINAL REPORT',
    copyright: '(c) 1995-2025 Laboratory Corporation of America Holdings  All Rights Reserved - Enterprise Report Version: 1.00',
  },
  panels: [
    {
      name: 'CBC With Differential/Platelet',
      rows: [
        L('WBC', '7.9', '', 'x10E3/uL', '4.5-13.0'),
        L('RBC', '4.62', '', 'x10E6/uL', '3.90-5.20'),
        L('Hemoglobin', '12.9', '', 'g/dL', '11.1-14.7'),
        L('Hematocrit', '38.4', '', '%', '34.0-44.0'),
        L('MCV', '83', '', 'fL', '77-95'),
        L('MCH', '27.9', '', 'pg', '25.0-31.0'),
        L('MCHC', '33.6', '', 'g/dL', '31.5-35.7'),
        L('RDW', '13.1', '', '%', '11.7-15.4'),
        L('Platelets', '268', '', 'x10E3/uL', '150-450'),
        L('Neutrophils', '45', '', '%', 'Not Estab.'),
        L('Lymphs', '44', '', '%', 'Not Estab.'),
        L('Monocytes', '7', '', '%', 'Not Estab.'),
        L('Eos', '3', '', '%', 'Not Estab.'),
        L('Basos', '1', '', '%', 'Not Estab.'),
      ],
    },
    PAGE_BREAK,
    {
      name: 'Iron and TIBC',
      rows: [
        L('Iron Bind.Cap.(TIBC)', '398', '', 'ug/dL', '250-450'),
        L('UIBC', '345', 'High', 'ug/dL', '111-343'),
        L('Iron', '53', '', 'ug/dL', '27-139'),
        L('Iron Saturation', '13', 'Low', '%', '15-55'),
      ],
    },
    { name: 'Ferritin', rows: [L('Ferritin', '11', 'Low', 'ng/mL', '13-68')] },
    { name: 'Vitamin B12', rows: [L('Vitamin B12', '512', '', 'pg/mL', '232-1245', '02')] },
    { name: 'Vitamin D, 25-Hydroxy', rows: [L('Vitamin D, 25-Hydroxy', '31.8', '', 'ng/mL', '30.0-100.0', '02')] },
    { name: 'TSH', rows: [L('TSH', '1.870', '', 'uIU/mL', '0.450-4.500')] },
  ],
};

// ---------------------------------------------------------------------------
// 3. Quest Diagnostics classic report, 4 pages
export const questClassic = {
  file: 'quest-classic.pdf',
  layout: 'quest-classic',
  vendor: 'quest',
  expectedPages: 4,
  status: 'FINAL',
  patient: { name: 'SAMPLE, ALEX Q', dob: '01/15/1980', age: '45', gender: 'M', patientId: '987654', phone: '609.555.0100' },
  specimen: {
    specimenId: 'AB123456C', requisition: '0012345', labRef: '1234567',
    collected: '09/10/2025 / 08:15 EDT', received: '09/10/2025 / 20:33 EDT', reported: '09/11/2025 / 06:12 EDT', fasting: 'Y',
  },
  client: { number: '12345678', name: 'DR. JANE DOE', address1: '123 MAIN ST', address2: 'ANYTOWN, NJ 08540' },
  footer: {
    sites: [
      'EZ  Quest Diagnostics Nichols Institute, 33608 Ortega Hwy, San Juan Capistrano, CA 92675-2042  Laboratory Director: Sample A Director, MD, CLIA: 05D0643352',
      'PR  Quest Diagnostics-Teterboro, One Malcolm Ave, Teterboro, NJ 07608-1070  Laboratory Director: Sample C Director, MD, CLIA: 31D0696246',
    ],
    clientServices: 'CLIENT SERVICES: 1.866.697.8378',
  },
  panels: [
    {
      name: 'CBC (INCLUDES DIFF/PLT)',
      rows: [
        Q('WHITE BLOOD CELL COUNT', '6.8', '', '3.8-10.8 Thousand/uL'),
        Q('RED BLOOD CELL COUNT', '4.95', '', '4.20-5.80 Million/uL'),
        Q('HEMOGLOBIN', '15.1', '', '13.2-17.1 g/dL'),
        Q('HEMATOCRIT', '44.6', '', '38.5-50.0 %'),
        Q('MCV', '90.1', '', '80.0-100.0 fL'),
        Q('MCH', '30.5', '', '27.0-33.0 pg'),
        Q('MCHC', '33.9', '', '32.0-36.0 g/dL'),
        Q('RDW', '12.8', '', '11.0-15.0 %'),
        Q('PLATELET COUNT', '135', 'L', '140-400 Thousand/uL'),
        Q('MPV', '10.2', '', '7.5-12.5 fL'),
        Q('ABSOLUTE NEUTROPHILS', '3944', '', '1500-7800 cells/uL'),
        Q('ABSOLUTE LYMPHOCYTES', '2040', '', '850-3900 cells/uL'),
        Q('ABSOLUTE MONOCYTES', '544', '', '200-950 cells/uL'),
        Q('ABSOLUTE EOSINOPHILS', '204', '', '15-500 cells/uL'),
        Q('ABSOLUTE BASOPHILS', '68', '', '0-200 cells/uL'),
        Q('NEUTROPHILS', '58.0', '', '%'),
        Q('LYMPHOCYTES', '30.0', '', '%'),
        Q('MONOCYTES', '8.0', '', '%'),
        Q('EOSINOPHILS', '3.0', '', '%'),
        Q('BASOPHILS', '1.0', '', '%'),
      ],
    },
    PAGE_BREAK,
    {
      name: 'COMPREHENSIVE METABOLIC PANEL',
      rows: [
        Q('GLUCOSE', '104', 'H', '65-99 mg/dL', 'EZ', { notes: ['Fasting reference interval'] }),
        Q('UREA NITROGEN (BUN)', '15', '', '7-25 mg/dL'),
        Q('CREATININE', '1.02', '', '0.60-1.35 mg/dL'),
        Q('eGFR', '92', '', '> OR = 60 mL/min/1.73m2', 'EZ', {
          notes: ['eGFR is calculated using the CKD-EPI 2021 equation, which does not', 'include a race variable.'],
        }),
        Q('BUN/CREATININE RATIO', 'NOT APPLICABLE', '', '6-22 (calc)'),
        Q('SODIUM', '140', '', '135-146 mmol/L'),
        Q('POTASSIUM', '6.1', 'HH', '3.5-5.3 mmol/L'),
        Q('CHLORIDE', '102', '', '98-110 mmol/L'),
        Q('CARBON DIOXIDE', '25', '', '20-32 mmol/L'),
        Q('CALCIUM', '9.5', '', '8.6-10.3 mg/dL'),
        Q('PROTEIN, TOTAL', '7.0', '', '6.1-8.1 g/dL'),
        Q('ALBUMIN', '4.6', '', '3.6-5.1 g/dL'),
        Q('GLOBULIN', '2.4', '', '1.9-3.7 g/dL (calc)'),
        Q('ALBUMIN/GLOBULIN RATIO', '1.9', '', '1.0-2.5 (calc)'),
        Q('BILIRUBIN, TOTAL', '0.6', '', '0.2-1.2 mg/dL'),
        Q('ALKALINE PHOSPHATASE', '71', '', '36-130 U/L'),
        Q('AST', '22', '', '10-35 U/L'),
        Q('ALT', '31', '', '9-46 U/L'),
      ],
    },
    PAGE_BREAK,
    {
      name: 'LIPID PANEL',
      rows: [
        Q('CHOLESTEROL, TOTAL', '210', 'H', '<200 mg/dL'),
        Q('HDL CHOLESTEROL', '48', '', '> OR = 40 mg/dL'),
        Q('TRIGLYCERIDES', '145', '', '<150 mg/dL'),
        Q('LDL-CHOLESTEROL', '133', 'H', 'mg/dL (calc)', 'EZ', {
          notes: ['Reference range: <100', 'Desirable range <100 mg/dL for primary prevention.'],
        }),
        Q('CHOL/HDLC RATIO', '4.4', '', '<5.0 (calc)'),
        // Deliberately wrapped two-line test name: value is on the first line, continuation below.
        Q('NON HDL CHOLESTEROL', '162', 'H', '<150 mg/dL (calc)', 'EZ', { cont: '(CALC)' }),
      ],
    },
    {
      name: 'HEMOGLOBIN A1c',
      rows: [
        Q('HEMOGLOBIN A1c', '5.4', '', '<5.7 % of total Hgb', 'EZ', {
          notes: [
            'For someone without known diabetes, a hemoglobin A1c value',
            'between 5.7% and 6.4% is consistent with prediabetes and should be',
            'confirmed with a follow-up test.',
          ],
        }),
      ],
    },
    PAGE_BREAK,
    {
      name: 'VITAMIN D,25-OH,TOTAL,IA',
      rows: [
        Q('VITAMIN D,25-OH,TOTAL,IA', '24', 'L', '30-100 ng/mL', 'PR', {
          notes: ['Vitamin D Status 25-OH Vitamin D:', 'Deficiency: <20 ng/mL', 'Insufficiency: 20-29 ng/mL', 'Optimal: > OR = 30 ng/mL'],
        }),
      ],
    },
    { name: 'TSH', rows: [Q('TSH', '2.15', '', '0.40-4.50 mIU/L', 'EZ')] },
    {
      name: 'HEPATITIS C ANTIBODY',
      rows: [Q('HEPATITIS C ANTIBODY', 'NON-REACTIVE', '', 'NON-REACTIVE', 'PR', { notes: ['Reference Range: NON-REACTIVE'] })],
    },
  ],
};

// ---------------------------------------------------------------------------
// 4. MyQuest portal variant, 2 pages
export const questMyQuest = {
  file: 'quest-myquest.pdf',
  layout: 'quest-myquest',
  vendor: 'quest',
  expectedPages: 2,
  patient: { displayName: 'JORDAN SAMPLE', dob: '06/02/2012', sex: 'F' },
  specimen: { specimenId: 'CD789012E', collected: '09/10/2025', reported: '09/11/2025' },
  physician: { ordering: 'DR. JANE DOE' },
  panels: [
    {
      name: 'CBC (INCLUDES DIFF/PLT)',
      rows: [
        M('WHITE BLOOD CELL COUNT', '7.9 Thousand/uL', '4.5-13.5 Thousand/uL'),
        M('RED BLOOD CELL COUNT', '4.62 Million/uL', '3.90-5.30 Million/uL'),
        M('HEMOGLOBIN', '12.9 g/dL', '11.5-15.5 g/dL'),
        M('HEMATOCRIT', '38.4 %', '35.0-45.0 %'),
        M('PLATELET COUNT', '268 Thousand/uL', '140-400 Thousand/uL'),
      ],
    },
    {
      name: 'COMPREHENSIVE METABOLIC PANEL',
      rows: [
        M('GLUCOSE', '88 mg/dL', '65-99 mg/dL'),
        M('SODIUM', '139 mmol/L', '135-146 mmol/L'),
        M('POTASSIUM', '4.1 mmol/L', '3.8-5.1 mmol/L'),
        M('CREATININE', '0.52 mg/dL', '0.40-0.80 mg/dL'),
      ],
    },
    PAGE_BREAK,
    {
      name: 'LIPID PANEL',
      rows: [
        M('CHOLESTEROL, TOTAL', '178 mg/dL', '<170 mg/dL', 'H'),
        M('HDL CHOLESTEROL', '52 mg/dL', '> OR = 45 mg/dL'),
        M('LDL-CHOLESTEROL', '104 mg/dL', '<110 mg/dL'),
      ],
    },
    { name: 'VITAMIN D,25-OH,TOTAL,IA', rows: [M('VITAMIN D,25-OH,TOTAL,IA', '31 ng/mL', '30-100 ng/mL')] },
    { name: 'TSH', rows: [M('TSH', '1.87 mIU/L', '0.50-4.30 mIU/L')] },
    { name: 'FERRITIN', rows: [M('FERRITIN', '11 ng/mL', '10-70 ng/mL')] },
  ],
};

export const REPORTS = [labcorpClassic, labcorpPortal, questClassic, questMyQuest];

/** Number of result rows a spec will print (what a parser should recover). */
export function countResults(spec) {
  return spec.panels.reduce((n, p) => n + (p.rows ? p.rows.length : 0), 0);
}

// ---------------------------------------------------------------------------
// Flow: turn panels into a list of body lines, then paginate.
function flowItems(spec) {
  const items = [];
  for (const panel of spec.panels) {
    if (panel.pageBreak) { items.push({ kind: 'pageBreak' }); continue; }
    items.push({ kind: 'panel', name: panel.name });
    for (const row of panel.rows) {
      items.push({ kind: 'row', row });
      if (row.cont) items.push({ kind: 'cont', text: row.cont });
      for (const note of row.notes || []) items.push({ kind: 'note', text: note });
    }
    items.push({ kind: 'blank' });
  }
  return items;
}

function paginate(items, layout) {
  const perPage = Math.floor((layout.bodyBottom - layout.bodyTop) / layout.lineHeight);
  const pages = [[]];
  for (const it of items) {
    let cur = pages[pages.length - 1];
    if (it.kind === 'pageBreak') { if (cur.length) pages.push([]); continue; }
    if (it.kind === 'blank' && cur.length === 0) continue; // no leading blank on a page
    if (cur.length >= perPage) { pages.push([]); cur = pages[pages.length - 1]; if (it.kind === 'blank') continue; }
    cur.push(it);
  }
  // trailing blank lines are harmless but drop them for tidiness
  for (const p of pages) while (p.length && p[p.length - 1].kind === 'blank') p.pop();
  return pages;
}

// ---------------------------------------------------------------------------
// Drawing helpers (y is measured from the TOP of the page here; converted for pdf-lib).
class Canvas {
  constructor(page, fonts, fontSize) {
    this.page = page; this.fonts = fonts; this.fontSize = fontSize;
  }
  text(x, yTop, str, { bold = false, size = this.fontSize, color = rgb(0, 0, 0) } = {}) {
    if (str === undefined || str === null || String(str).trim() === '') return;
    const font = bold ? this.fonts.bold : this.fonts.regular;
    this.page.drawText(String(str), { x, y: PAGE.height - yTop, size, font, color });
  }
  width(str, { bold = false, size = this.fontSize } = {}) {
    const font = bold ? this.fonts.bold : this.fonts.regular;
    return font.widthOfTextAtSize(String(str), size);
  }
  rule(yTop, x0 = 36, x1 = PAGE.width - 36) {
    this.page.drawLine({ start: { x: x0, y: PAGE.height - yTop }, end: { x: x1, y: PAGE.height - yTop }, thickness: 0.5, color: rgb(0.4, 0.4, 0.4) });
  }
}

// --- Labcorp classic ---------------------------------------------------------
function labcorpClassicHeader(c, spec, pageNo, pageCount) {
  const { patient: p, specimen: s, physician: d, account: a } = spec;
  c.text(36, 40, 'Labcorp', { bold: true, size: 16 });
  c.text(470, 40, 'Patient Report', { bold: true, size: 10 });
  c.text(36, 62, p.name, { bold: true, size: 11 });
  c.text(36, 80, 'Patient Details', { bold: true });
  c.text(220, 80, 'Specimen Details', { bold: true });
  c.text(420, 80, 'Physician Details', { bold: true });
  const cols = [
    [`DOB: ${p.dob}`, `Age: ${p.age}`, `Gender: ${p.gender}`, `Patient ID: ${p.patientId}`, `Phone: ${p.phone}`],
    [`Date collected: ${s.collected}`, `Date received: ${s.received}`, `Date entered: ${s.entered}`, `Date reported: ${s.reported}`, `Specimen ID: ${s.specimenId}`, `Fasting: ${s.fasting}`],
    [`Ordering: ${d.ordering}`, `Referring: ${d.referring}`, `ID: ${d.id}`, `NPI: ${d.npi}`],
  ];
  const xs = [36, 220, 420];
  cols.forEach((lines, i) => lines.forEach((t, j) => c.text(xs[i], 92 + j * 11, t)));
  // Account block
  c.text(36, 170, `Account Number: ${a.number}`);
  c.text(220, 170, a.name);
  c.text(220, 181, a.address1);
  c.text(220, 192, a.address2);
  c.text(420, 170, `Phone: ${a.phone}`);
  c.text(420, 181, `Fax: ${a.fax}`);
  c.text(420, 192, `Rte: ${a.rte}`);
  let y = 212;
  if (pageNo === 1) { c.text(36, y, 'Ordered Items:', { bold: true }); c.text(100, y, spec.orderedItems); }
  y = 236;
  c.rule(y + 3);
  labcorpTableHeader(c, y, ['TESTS', 'RESULT', 'FLAG', 'UNITS', 'REFERENCE INTERVAL', 'LAB']);
}

function labcorpTableHeader(c, y, labels) {
  const col = COLUMNS.labcorp;
  const xs = [col.name, col.value, col.flag, col.unit, col.ref, col.lab];
  labels.forEach((t, i) => c.text(xs[i], y, t, { bold: true }));
  c.rule(y + 3);
}

function labcorpFooter(c, spec, pageNo, pageCount) {
  const f = spec.footer;
  c.rule(708);
  f.sites.forEach((s, i) => drawLegend(c, 36, 718 + i * 10, s, 7));
  c.text(36, 746, `Date Issued: ${f.dateIssued}`);
  c.text(300, 746, f.status, { bold: true });
  c.text(520, 746, `Page ${pageNo} of ${pageCount}`);
  c.text(36, 758, f.copyright, { size: 7 });
}

/** Legend lines use two-space separators; draw each segment as its own item so columns are gaps, not spaces. */
function drawLegend(c, x, y, line, size) {
  let cx = x;
  for (const seg of line.split('  ')) {
    c.text(cx, y, seg, { size });
    cx += c.width(seg, { size }) + 14;
  }
}

function labcorpBodyLine(c, y, it, layout) {
  const col = COLUMNS.labcorp;
  switch (it.kind) {
    case 'panel': c.text(col.name, y, it.name, { bold: true }); break;
    case 'row': {
      const r = it.row;
      c.text(col.name, y, r.name);
      c.text(col.value, y, r.value);
      c.text(col.flag, y, r.flag);
      c.text(col.unit, y, r.unit);
      c.text(col.ref, y, r.ref);
      c.text(col.lab, y, r.lab);
      break;
    }
    case 'cont': c.text(col.name, y, it.text); break;
    case 'note': c.text(col.name + layout.noteIndent, y, it.text); break;
    default: break;
  }
}

// --- Labcorp portal variant ---------------------------------------------------
function labcorpPortalHeader(c, spec, pageNo, pageCount) {
  const { patient: p, specimen: s, physician: d, account: a } = spec;
  c.text(36, 40, 'Labcorp', { bold: true, size: 16 });
  c.text(440, 40, 'Lab Results Report', { bold: true, size: 10 });
  const left = [`Patient: ${p.name}`, `Date of Birth: ${p.dob}`, `Sex: ${p.sex}`, `Age: ${p.age}`, `Patient ID: ${p.patientId}`];
  const mid = [`Specimen #: ${s.specimenId}`, `Collected: ${s.collected}`, `Received: ${s.received}`, `Reported: ${s.reported}`, `Fasting: ${s.fasting}`];
  const right = [`Ordering Physician: ${d.ordering}`, `NPI: ${d.npi}`, `Account: ${a.number}`, a.name];
  [left, mid, right].forEach((lines, i) => lines.forEach((t, j) => c.text([36, 220, 420][i], 70 + j * 11, t)));
  c.text(440, 134, `Page ${pageNo} of ${pageCount}`, { size: 7 });
  const y = 164;
  c.rule(y - 10);
  labcorpTableHeader(c, y, ['Test Name', 'Result', 'Flag', 'Units', 'Reference Interval', 'Lab']);
}

// --- Quest classic --------------------------------------------------------------
function questClassicHeader(c, spec, pageNo, pageCount) {
  const { patient: p, specimen: s, client: k } = spec;
  c.text(36, 40, p.name, { bold: true, size: 10 });
  c.text(430, 40, 'Quest Diagnostics', { bold: true, size: 13 });
  c.text(430, 56, 'Report Status:');
  c.text(492, 56, spec.status, { bold: true });
  c.text(36, 76, 'Patient Information', { bold: true });
  c.text(220, 76, 'Specimen Information', { bold: true });
  c.text(410, 76, 'Client Information', { bold: true });
  const cols = [
    [p.name, `DOB: ${p.dob}`, `Gender: ${p.gender}`, `Patient ID: ${p.patientId}`, `Phone: ${p.phone}`],
    [`Specimen: ${s.specimenId}`, `Requisition: ${s.requisition}`, `Lab Ref #: ${s.labRef}`, `Collected: ${s.collected}`, `Received: ${s.received}`, `Reported: ${s.reported}`, `Fasting: ${s.fasting}`],
    [`Client #: ${k.number}`, k.name, k.address1, k.address2],
  ];
  const xs = [36, 220, 410];
  cols.forEach((lines, i) => lines.forEach((t, j) => c.text(xs[i], 88 + j * 11, t)));
  // AGE sits on the DOB line, as a separate item, like the real report.
  c.text(36 + c.width(`DOB: ${p.dob}`) + 12, 99, `AGE: ${p.age}`);
  const y = 175;
  c.rule(y - 10);
  const col = COLUMNS.quest;
  [[col.name, 'Test Name'], [col.inRange, 'In Range'], [col.outOfRange, 'Out of Range'], [col.ref, 'Reference Range'], [col.lab, 'Lab']]
    .forEach(([x, t]) => c.text(x, y, t, { bold: true }));
  c.rule(y + 3);
}

function questFooter(c, spec, pageNo, pageCount) {
  const f = spec.footer;
  c.rule(696);
  c.text(36, 706, 'PERFORMING SITE:', { bold: true, size: 7 });
  f.sites.forEach((s, i) => drawLegend(c, 36, 716 + i * 10, s, 7));
  c.text(36, 742, f.clientServices, { size: 7 });
  c.text(260, 742, `SPECIMEN: ${spec.specimen.specimenId}`, { size: 7 });
  c.text(520, 742, `Page ${pageNo} of ${pageCount}`, { size: 7 });
}

function questBodyLine(c, y, it, layout) {
  const col = COLUMNS.quest;
  switch (it.kind) {
    case 'panel': c.text(col.name, y, it.name, { bold: true }); break;
    case 'row': {
      const r = it.row;
      c.text(col.name, y, r.name);
      if (r.flag) {
        c.text(col.outOfRange, y, r.value);
        c.text(col.outOfRange + c.width(r.value) + 3, y, r.flag);
      } else {
        c.text(col.inRange, y, r.value);
      }
      c.text(col.ref, y, r.ref);
      c.text(col.lab, y, r.lab);
      break;
    }
    case 'cont': c.text(col.name, y, it.text); break;
    case 'note': c.text(col.name + layout.noteIndent, y, it.text); break;
    default: break;
  }
}

// --- MyQuest portal variant -----------------------------------------------------
function myQuestHeader(c, spec, pageNo, pageCount) {
  const { patient: p, specimen: s, physician: d } = spec;
  c.text(36, 40, 'MyQuest', { bold: true, size: 16 });
  c.text(430, 40, 'Quest Diagnostics', { bold: true, size: 11 });
  c.text(36, 64, `Results for ${p.displayName}`, { bold: true, size: 12 });
  c.text(36, 80, `Date of Birth: ${p.dob}`, { size: 9 });
  c.text(220, 80, `Sex: ${p.sex}`, { size: 9 });
  c.text(36, 93, `Collected on ${s.collected}`, { size: 9 });
  c.text(220, 93, `Reported on ${s.reported}`, { size: 9 });
  c.text(36, 106, `Ordered by ${d.ordering}`, { size: 9 });
  c.text(220, 106, `Specimen: ${s.specimenId}`, { size: 9 });
  c.text(520, 106, `Page ${pageNo} of ${pageCount}`, { size: 8 });
  const y = 128;
  const col = COLUMNS.myquest;
  [[col.name, 'Test'], [col.value, 'Your Value'], [col.ref, 'Reference Range'], [col.flag, 'Flag']]
    .forEach(([x, t]) => c.text(x, y, t, { bold: true, size: 9 }));
  c.rule(y + 4);
}

function myQuestFooter(c, spec, pageNo, pageCount) {
  c.rule(720);
  c.text(36, 732, 'Quest, Quest Diagnostics and MyQuest are trademarks of Quest Diagnostics. Sample report for testing only.', { size: 7 });
  c.text(36, 744, 'CLIENT SERVICES: 1.866.697.8378', { size: 7 });
  c.text(520, 744, `Page ${pageNo} of ${pageCount}`, { size: 7 });
}

function myQuestBodyLine(c, y, it, layout) {
  const col = COLUMNS.myquest;
  switch (it.kind) {
    case 'panel': c.text(col.name, y, it.name, { bold: true }); break;
    case 'row': {
      const r = it.row;
      c.text(col.name, y, r.name);
      c.text(col.value, y, r.value);
      c.text(col.ref, y, r.ref);
      c.text(col.flag, y, r.flag, { bold: true });
      break;
    }
    case 'cont': c.text(col.name, y, it.text); break;
    case 'note': c.text(col.name + layout.noteIndent, y, it.text); break;
    default: break;
  }
}

const RENDERERS = {
  'labcorp-classic': { header: labcorpClassicHeader, footer: labcorpFooter, line: labcorpBodyLine },
  'labcorp-portal': { header: labcorpPortalHeader, footer: labcorpFooter, line: labcorpBodyLine },
  'quest-classic': { header: questClassicHeader, footer: questFooter, line: questBodyLine },
  'quest-myquest': { header: myQuestHeader, footer: myQuestFooter, line: myQuestBodyLine },
};

/** Build one PDF from a report spec. Returns { bytes: Uint8Array, pageCount } */
export async function buildPdf(spec) {
  const layout = LAYOUT[spec.layout];
  const r = RENDERERS[spec.layout];
  if (!layout || !r) throw new Error(`Unknown layout: ${spec.layout}`);
  const pages = paginate(flowItems(spec), layout);
  const doc = await PDFDocument.create();
  doc.setTitle(spec.file.replace(/\.pdf$/, ''));
  doc.setProducer('family-health synthetic fixture generator');
  doc.setCreator('fixtures/gen/build.js');
  const fonts = {
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
  };
  pages.forEach((items, idx) => {
    const page = doc.addPage([PAGE.width, PAGE.height]);
    const c = new Canvas(page, fonts, layout.fontSize);
    const pageNo = idx + 1;
    r.header(c, spec, pageNo, pages.length);
    let y = layout.bodyTop;
    for (const it of items) { r.line(c, y, it, layout); y += layout.lineHeight; }
    r.footer(c, spec, pageNo, pages.length);
  });
  const bytes = await doc.save({ useObjectStreams: false });
  return { bytes, pageCount: pages.length };
}

export const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'pdf');

export async function buildAll(outDir = OUT_DIR) {
  await mkdir(outDir, { recursive: true });
  const written = [];
  for (const spec of REPORTS) {
    const { bytes, pageCount } = await buildPdf(spec);
    const path = join(outDir, spec.file);
    await writeFile(path, bytes);
    written.push({ file: spec.file, path, pageCount, bytes: bytes.length, results: countResults(spec) });
  }
  return written;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  buildAll().then((written) => {
    for (const w of written) {
      const warn = REPORTS.find((s) => s.file === w.file).expectedPages !== w.pageCount ? '  (WARNING: expectedPages mismatch)' : '';
      console.log(`${w.file}: ${w.pageCount} pages, ${w.bytes} bytes, ${w.results} result rows${warn}`);
    }
  }).catch((e) => { console.error(e); process.exit(1); });
}
