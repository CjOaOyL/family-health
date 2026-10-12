// Adversarial variant catalogue for test/robustness.test.js. Pure data + spec builders; no I/O.
// Each variant: { id, layout, title, spec, opts, pages?, required?: string[] (paths that must be non-null),
//                 expectName?, expectDob? }
// All people/providers/addresses are fake.
import { L, Q, M, PAGE_BREAK, FOOTER_ONLY, BASE_COLUMNS, deepClone } from './gen.js';

export const REQUIRED_PATHS = ['patient.fullName', 'patient.dob', 'patient.sex', 'specimen.collectedAt', 'specimen.reportedAt', 'specimen.specimenId', 'provider.orderingName'];

// ---------------------------------------------------------------------------------------------
// Base specs (compact but realistic)
// ---------------------------------------------------------------------------------------------
const LC_FOOTER = {
  sites: [
    '01 BN  LabCorp Burlington  1447 York Court, Burlington, NC 272153361  Dir: William F Hancock, MD  Phone: 800-762-4344',
    '02 RN  LabCorp Raritan  69 First Ave, Raritan, NJ 088691800  Dir: Sample B Director, MD  Phone: 800-631-5250',
  ],
  dateIssued: '03/05/25 1023 ET', status: 'FINAL REPORT',
  copyright: '(c) 1995-2025 Laboratory Corporation of America Holdings  All Rights Reserved - Enterprise Report Version: 1.00',
};
const Q_FOOTER = {
  sites: [
    'EZ  Quest Diagnostics Nichols Institute, 33608 Ortega Hwy, San Juan Capistrano, CA 92675-2042  Laboratory Director: Sample A Director, MD, CLIA: 05D0643352',
    'PR  Quest Diagnostics-Teterboro, One Malcolm Ave, Teterboro, NJ 07608-1070  Laboratory Director: Sample C Director, MD, CLIA: 31D0696246',
  ],
  clientServices: 'CLIENT SERVICES: 1.866.697.8378',
};

export function labcorpClassicBase() {
  return {
    file: 'adv-labcorp-classic.pdf', layout: 'labcorp-classic', vendor: 'labcorp',
    patient: { name: 'SAMPLE, ALEX Q', dob: '01/15/1980', age: '45', gender: 'M', patientId: '123456789', phone: '609-555-0100' },
    specimen: { collected: '03/04/2025 0815 Local', received: '03/04/2025', entered: '03/04/2025', reported: '03/05/2025 1023 ET', specimenId: '063-123-4567-0', fasting: 'Yes' },
    physician: { ordering: 'J SMITH', referring: '', id: '12345', npi: '1234567893' },
    account: { number: '12345678', name: 'Sample Family Medicine', address1: '123 Sample Street, Suite 100', address2: 'Anytown, NJ 08540', phone: '609-555-0200', fax: '609-555-0201', rte: '00' },
    orderedItems: 'CBC With Differential/Platelet; Comp. Metabolic Panel (14); Lipid Panel',
    footer: LC_FOOTER,
    panels: [
      { name: 'CBC With Differential/Platelet', rows: [
        L('WBC', '6.8', '', 'x10E3/uL', '3.4-10.8'),
        L('RBC', '4.95', '', 'x10E6/uL', '4.14-5.80'),
        L('Hemoglobin', '15.1', '', 'g/dL', '13.0-17.7'),
        L('Hematocrit', '44.6', '', '%', '37.5-51.0'),
        L('Platelets', '142', 'Low', 'x10E3/uL', '150-450'),
        L('Neutrophils', '58', '', '%', 'Not Estab.'),
        L('Lymphs (Absolute)', '2.0', '', 'x10E3/uL', '0.7-3.1'),
      ] },
      { name: 'Comp. Metabolic Panel (14)', rows: [
        L('Glucose', '104', 'High', 'mg/dL', '70-99'),
        L('BUN', '15', '', 'mg/dL', '6-24'),
        L('Creatinine', '1.02', '', 'mg/dL', '0.76-1.27'),
        L('eGFR', '92', '', 'mL/min/1.73', '>59', '01', { notes: ['Please Note: eGFR is calculated using the 2021 CKD-EPI creatinine equation', 'and is reported without adjustment for race.'] }),
        L('BUN/Creatinine Ratio', '15', '', '', '9-20'),
        L('Potassium', '6.1', 'Critical', 'mmol/L', '3.5-5.2'),
        L('Calcium', '9.5', '', 'mg/dL', '8.7-10.2'),
      ] },
      PAGE_BREAK,
      { name: 'Lipid Panel', rows: [
        L('Cholesterol, Total', '210', 'High', 'mg/dL', '100-199'),
        L('Triglycerides', '145', '', 'mg/dL', '0-149'),
        L('HDL Cholesterol', '48', '', 'mg/dL', '>39'),
        L('LDL Chol Calc (NIH)', '135', 'High', 'mg/dL', '0-99', '01', { notes: ['Desirable range <100 mg/dL for primary prevention goal.'] }),
        L('Chol/HDL Ratio', '4.4', '', 'ratio', '0.0-5.0'),
      ] },
      { name: 'TSH', rows: [L('TSH', '2.150', '', 'uIU/mL', '0.450-4.500')] },
      { name: 'Vitamin D, 25-Hydroxy', rows: [L('Vitamin D, 25-Hydroxy', '24.3', 'Low', 'ng/mL', '30.0-100.0', '02')] },
    ],
  };
}

export function labcorpPortalBase() {
  return {
    file: 'adv-labcorp-portal.pdf', layout: 'labcorp-portal', vendor: 'labcorp',
    patient: { name: 'SAMPLE, JORDAN', dob: '06/02/2012', age: '12', sex: 'F', patientId: '555123' },
    specimen: { specimenId: '063-765-4321-0', collected: '03/04/2025 0830 Local', received: '03/04/2025', reported: '03/05/2025 1102 ET', fasting: 'No' },
    physician: { ordering: 'J SMITH', npi: '1234567893' },
    account: { number: '12345678', name: 'Sample Family Medicine' },
    footer: { ...LC_FOOTER, dateIssued: '03/05/25 1102 ET' },
    panels: [
      { name: 'CBC With Differential/Platelet', rows: [
        L('WBC', '7.9', '', 'x10E3/uL', '4.5-13.0'),
        L('RBC', '4.62', '', 'x10E6/uL', '3.90-5.20'),
        L('Hemoglobin', '12.9', '', 'g/dL', '11.1-14.7'),
        L('Platelets', '268', '', 'x10E3/uL', '150-450'),
        L('Neutrophils', '45', '', '%', 'Not Estab.'),
      ] },
      { name: 'Iron and TIBC', rows: [
        L('Iron Bind.Cap.(TIBC)', '398', '', 'ug/dL', '250-450'),
        L('UIBC', '345', 'High', 'ug/dL', '111-343'),
        L('Iron', '53', '', 'ug/dL', '27-139'),
        L('Iron Saturation', '13', 'Low', '%', '15-55'),
      ] },
      PAGE_BREAK,
      { name: 'Ferritin', rows: [L('Ferritin', '11', 'Low', 'ng/mL', '13-68')] },
      { name: 'Vitamin B12', rows: [L('Vitamin B12', '512', '', 'pg/mL', '232-1245', '02')] },
      { name: 'TSH', rows: [L('TSH', '1.870', '', 'uIU/mL', '0.450-4.500')] },
    ],
  };
}

export function questClassicBase() {
  return {
    file: 'adv-quest-classic.pdf', layout: 'quest-classic', vendor: 'quest', status: 'FINAL',
    patient: { name: 'SAMPLE, ALEX Q', dob: '01/15/1980', age: '45', gender: 'M', patientId: '987654', phone: '609.555.0100' },
    specimen: { specimenId: 'AB123456C', requisition: '0012345', labRef: '1234567', collected: '09/10/2025 / 08:15 EDT', received: '09/10/2025 / 20:33 EDT', reported: '09/11/2025 / 06:12 EDT', fasting: 'Y' },
    client: { number: '12345678', name: 'DR. JANE DOE', address1: '123 MAIN ST', address2: 'ANYTOWN, NJ 08540' },
    footer: Q_FOOTER,
    panels: [
      { name: 'CBC (INCLUDES DIFF/PLT)', rows: [
        Q('WHITE BLOOD CELL COUNT', '6.8', '', '3.8-10.8', 'Thousand/uL'),
        Q('RED BLOOD CELL COUNT', '4.95', '', '4.20-5.80', 'Million/uL'),
        Q('HEMOGLOBIN', '15.1', '', '13.2-17.1', 'g/dL'),
        Q('PLATELET COUNT', '135', 'L', '140-400', 'Thousand/uL'),
        Q('ABSOLUTE NEUTROPHILS', '3944', '', '1500-7800', 'cells/uL'),
        Q('NEUTROPHILS', '58.0', '', '', '%'),
      ] },
      { name: 'COMPREHENSIVE METABOLIC PANEL', rows: [
        Q('GLUCOSE', '104', 'H', '65-99', 'mg/dL', 'EZ', { notes: ['Fasting reference interval'] }),
        Q('UREA NITROGEN (BUN)', '15', '', '7-25', 'mg/dL'),
        Q('CREATININE', '1.02', '', '0.60-1.35', 'mg/dL'),
        Q('eGFR', '92', '', '> OR = 60', 'mL/min/1.73m2'),
        Q('POTASSIUM', '6.1', 'HH', '3.5-5.3', 'mmol/L'),
        Q('ALBUMIN/GLOBULIN RATIO', '1.9', '', '1.0-2.5 (calc)', ''),
      ] },
      PAGE_BREAK,
      { name: 'LIPID PANEL', rows: [
        Q('CHOLESTEROL, TOTAL', '210', 'H', '<200', 'mg/dL'),
        Q('HDL CHOLESTEROL', '48', '', '> OR = 40', 'mg/dL'),
        Q('TRIGLYCERIDES', '145', '', '<150', 'mg/dL'),
        // Quest prints "mg/dL (calc)" in the range cell; the parser drops the trailing parenthetical → unit "mg/dL", no range.
        Q('LDL-CHOLESTEROL', '133', 'H', '', 'mg/dL (calc)', 'EZ', { notes: ['Reference range: <100'], expectUnit: 'mg/dL' }),
      ] },
      { name: 'HEMOGLOBIN A1c', rows: [Q('HEMOGLOBIN A1c', '5.4', '', '<5.7', '% of total Hgb')] },
      { name: 'TSH', rows: [Q('TSH', '2.15', '', '0.40-4.50', 'mIU/L')] },
      { name: 'HEPATITIS C ANTIBODY', rows: [Q('HEPATITIS C ANTIBODY', 'NON-REACTIVE', '', 'NON-REACTIVE', '', 'PR')] },
    ],
  };
}

export function myQuestBase() {
  return {
    file: 'adv-quest-myquest.pdf', layout: 'quest-myquest', vendor: 'quest',
    patient: { displayName: 'JORDAN SAMPLE', dob: '06/02/2012', sex: 'F' },
    specimen: { specimenId: 'CD789012E', collected: '09/10/2025', reported: '09/11/2025' },
    physician: { ordering: 'DR. JANE DOE' },
    panels: [
      { name: 'CBC (INCLUDES DIFF/PLT)', rows: [
        M('WHITE BLOOD CELL COUNT', '7.9', 'Thousand/uL', '4.5-13.5'),
        M('HEMOGLOBIN', '12.9', 'g/dL', '11.5-15.5'),
        M('PLATELET COUNT', '268', 'Thousand/uL', '140-400'),
      ] },
      { name: 'COMPREHENSIVE METABOLIC PANEL', rows: [
        M('GLUCOSE', '88', 'mg/dL', '65-99'),
        M('SODIUM', '139', 'mmol/L', '135-146'),
        M('CREATININE', '0.52', 'mg/dL', '0.40-0.80'),
      ] },
      PAGE_BREAK,
      { name: 'LIPID PANEL', rows: [
        M('CHOLESTEROL, TOTAL', '178', 'mg/dL', '<170', 'H'),
        M('HDL CHOLESTEROL', '52', 'mg/dL', '> OR = 45'),
        M('LDL-CHOLESTEROL', '104', 'mg/dL', '<110'),
      ] },
      { name: 'TSH', rows: [M('TSH', '1.87', 'mIU/L', '0.50-4.30')] },
      { name: 'FERRITIN', rows: [M('FERRITIN', '11', 'ng/mL', '10-70')] },
    ],
  };
}

export const BASES = {
  'labcorp-classic': labcorpClassicBase,
  'labcorp-portal': labcorpPortalBase,
  'quest-classic': questClassicBase,
  'quest-myquest': myQuestBase,
};
export const LAYOUTS = Object.keys(BASES);

// ---------------------------------------------------------------------------------------------
// Neutral row lists → vendor rows. Each neutral row: { name, value, flag: ''|'H'|'L'|'HH', unit, ref, notes?, cont? }
// Labcorp prints flag words, Quest letters. Flags on text values are unusual; keep them off.
// ---------------------------------------------------------------------------------------------
const LC_FLAG = { '': '', H: 'High', L: 'Low', HH: 'Critical', LL: 'Critical' };
export function rowsFor(layout, neutral) {
  return neutral.map((n) => {
    const o = {}; if (n.notes) o.notes = n.notes; if (n.cont) o.cont = n.cont; if ('expectValue' in n) o.expectValue = n.expectValue;
    if (layout.startsWith('labcorp')) return L(n.name, n.value, LC_FLAG[n.flag || ''] ?? n.flag, n.unit || '', n.ref || '', '01', o);
    // Quest: a trailing "*" on a value is an abnormal flag (SPEC §6), so expect "6.2*" → valueText "6.2", flag A.
    if (/\*$/.test(n.value)) { o.expectValueText = n.value.replace(/\*+$/, ''); o.expectFlag = 'A'; }
    if (layout === 'quest-classic') return Q(n.name, n.value, n.flag || '', n.ref || '', n.unit || '', 'EZ', o);
    return M(n.name, n.value, n.unit || '', n.ref || '', n.flag || '', o);
  });
}

/** Replace the panels of a base spec with one panel of neutral rows. */
function withPanel(layout, panelName, neutral, extraPanels = []) {
  const spec = BASES[layout]();
  spec.panels = [{ name: panelName, rows: rowsFor(layout, neutral) }, ...extraPanels];
  return spec;
}

// Shift every column x by dx.
function shiftCols(layout, dx) {
  const key = layout.startsWith('labcorp') ? 'labcorp' : layout === 'quest-classic' ? 'quest' : 'myquest';
  const out = {};
  for (const [k, x] of Object.entries(BASE_COLUMNS[key])) out[k] = k === 'name' ? x : x + dx;
  return out;
}
const COMPRESSED = {
  labcorp: { name: 36, value: 220, flag: 290, unit: 340, ref: 400, lab: 560 },
  quest: { name: 36, inRange: 220, outOfRange: 280, ref: 340, lab: 560 },
  myquest: { name: 36, value: 220, ref: 340, flag: 540 },
};
const colsKey = (layout) => (layout.startsWith('labcorp') ? 'labcorp' : layout === 'quest-classic' ? 'quest' : 'myquest');
/** Right edge for right-aligned values: just inside the next column. */
function rightEdge(layout) {
  if (layout.startsWith('labcorp')) return BASE_COLUMNS.labcorp.flag - 8;       // 322
  if (layout === 'quest-classic') return BASE_COLUMNS.quest.outOfRange - 8;      // 322
  return BASE_COLUMNS.myquest.ref - 8;                                           // 372
}

// ---------------------------------------------------------------------------------------------
// Row sets for items 5–8 and 14
// ---------------------------------------------------------------------------------------------
const TRICKY_NAMES = [
  { name: 'Vitamin B12', value: '512', unit: 'pg/mL', ref: '232-1245' },
  { name: 'T4, Free (Direct)', value: '1.22', unit: 'ng/dL', ref: '0.82-1.77' },
  { name: 'CO2', value: '25', unit: 'mmol/L', ref: '20-29' },
  { name: 'Hemoglobin A1c', value: '5.4', unit: '%', ref: '4.8-5.6' },
  { name: '25-OH Vitamin D', value: '31.8', unit: 'ng/mL', ref: '30.0-100.0' },
  { name: 'eGFR If NonAfricn Am', value: '92', unit: 'mL/min/1.73', ref: '>59' },
  { name: 'LDL Chol Calc (NIH)', value: '135', flag: 'H', unit: 'mg/dL', ref: '0-99' },
  { name: 'Cholesterol/HDL Ratio', value: '4.4', unit: 'ratio', ref: '0.0-5.0' },
  { name: '5-HIAA', value: '3.2', unit: 'mg/24 hr', ref: '2.0-8.0' },
  { name: 'Protein, Total (24 hr urine)', value: '88', unit: 'mg/24 hr', ref: '30-150' },
];
const TRICKY_VALUES = [
  { name: 'Base Excess', value: '-2.5', unit: 'mmol/L', ref: '-2.0-3.0', expectValue: -2.5 },
  { name: 'HIV-1 RNA, Quant', value: '1,250,000', flag: 'H', unit: 'copies/mL', ref: '<20', expectValue: 1250000 },
  { name: 'Troponin I', value: '<0.1', unit: 'ng/mL', ref: '<0.4', expectValue: 0.1 },
  { name: 'ANA Titer', value: '>1:640', flag: 'H', unit: 'titer', ref: '<1:80', expectValue: null },
  { name: 'RPR Titer', value: '1:80', flag: 'H', unit: 'titer', ref: 'Non Reactive', expectValue: null },
  { name: 'Hemoglobin A1c', value: '6.2*', unit: '%', ref: '4.8-5.6', expectValue: 6.2 },
  { name: 'SARS-CoV-2 RNA', value: 'NOT DETECTED', unit: '', ref: 'Not Detected', expectValue: null },
  { name: 'Lipase', value: 'See Note', unit: 'U/L', ref: '13-78', expectValue: null },
  { name: 'Magnesium', value: 'QNS', unit: 'mg/dL', ref: '1.6-2.3', expectValue: null },
  { name: 'Folate', value: 'Canceled', unit: 'ng/mL', ref: '>3.0', expectValue: null },
  { name: 'Basos', value: '0', unit: '%', ref: 'Not Estab.', expectValue: 0 },
  { name: 'Immature Grans', value: 'Not Estab.', unit: '%', ref: 'Not Estab.', expectValue: null },
];
const TRICKY_RANGES = [
  { name: 'HDL Cholesterol', value: '48', unit: 'mg/dL', ref: '>39' },
  { name: 'TSH', value: '2.15', unit: 'mIU/L', ref: '< OR = 4.0' },
  { name: 'TSH Reflex', value: '2.150', unit: 'uIU/mL', ref: '0.450-4.500' },
  { name: 'Neutrophils', value: '58', unit: '%', ref: 'Not Estab.' },
  { name: 'Urine Glucose', value: 'Negative', unit: '', ref: 'Negative', expectValue: null },
  { name: 'LDL Cholesterol', value: '135', flag: 'H', unit: 'mg/dL', ref: '<130 (calc)' },
  { name: 'Glucose', value: '104', flag: 'H', unit: 'mg/dL', ref: '70-99 (Fasting)' },
  { name: 'HIV Ag/Ab', value: 'Non Reactive', unit: '', ref: 'Non Reactive', expectValue: null },
  { name: 'RBC, UA', value: '0-2', unit: '/HPF', ref: '0-1 /HPF', expectValue: null },
  { name: 'Specific Gravity', value: '1.020', unit: '', ref: '1.005-1.030' },
  { name: 'Ketones, Urine', value: '15', unit: 'mg/dL', ref: '' },
];
const LONG_COMMENT_ROWS = [
  { name: 'Hemoglobin A1c', value: '6.1', flag: 'H', unit: '%', ref: '4.8-5.6', notes: [
    'Please Note:',
    'According to the ADA, the following A1c cut points apply:',
    '1. For patients with a value of 5.7-6.4%, prediabetes is likely.',
    '2. A value of 6.5% or greater is consistent with diabetes.',
    '3. Glycemic control target for adults with diabetes is <7.0%.',
    'The eAG calculation uses the formula 28.7 x A1c - 46.7.',
    'Values >100 mg/dL eAG correspond to an A1c above 5.1%.',
    'This test was performed using an NGSP-certified method.',
    'Results may be unreliable in hemoglobinopathies.',
  ] },
  { name: 'LDL Chol Calc (NIH)', value: '135', flag: 'H', unit: 'mg/dL', ref: '0-99', notes: [
    'Diabetes: >6.4',
  ] },
  { name: 'Glucose', value: '104', flag: 'H', unit: 'mg/dL', ref: '70-99', notes: [
    'Fasting 8-12 hours',
  ] },
  { name: 'eGFR', value: '92', unit: 'mL/min/1.73', ref: '>59' },
];

// ---------------------------------------------------------------------------------------------
// The catalogue
// ---------------------------------------------------------------------------------------------
export function buildVariants() {
  const out = [];
  const add = (v) => { out.push(v); return v; };

  for (const layout of LAYOUTS) {
    const ck = colsKey(layout);
    const base = () => BASES[layout]();
    const tag = layout;

    // 0. control
    add({ id: `${tag}/control`, layout, title: 'control (base spec through the adversarial generator)', spec: base(), opts: {} });

    // 1. column drift
    add({ id: `${tag}/drift+15`, layout, title: 'all table columns +15 (header and rows together)', spec: base(), opts: { cols: shiftCols(layout, 15) } });
    add({ id: `${tag}/drift-15`, layout, title: 'all table columns -15 (header and rows together)', spec: base(), opts: { cols: shiftCols(layout, -15) } });
    add({ id: `${tag}/rows+15`, layout, title: 'rows +15 relative to the header labels', spec: base(), opts: { cols: shiftCols(layout, 15), headerCols: BASE_COLUMNS[ck] } });
    add({ id: `${tag}/rows-15`, layout, title: 'rows -15 relative to the header labels', spec: base(), opts: { cols: shiftCols(layout, -15), headerCols: BASE_COLUMNS[ck] } });
    add({ id: `${tag}/compressed`, layout, title: 'compressed columns (RESULT 220, UNITS 340 ...)', spec: base(), opts: { cols: COMPRESSED[ck] } });

    // 2. right-aligned values
    add({ id: `${tag}/right-aligned`, layout, title: 'right-aligned numeric values (x varies per row)', spec: base(), opts: { rightAlign: rightEdge(layout) } });

    // 3. font sizes
    add({ id: `${tag}/font7`, layout, title: 'body rows at 7pt', spec: base(), opts: { fontSize: 7, lineHeight: 9 } });
    add({ id: `${tag}/font10`, layout, title: 'body rows at 10pt', spec: base(), opts: { fontSize: 10, lineHeight: 13 } });

    // 4. value + flag placement
    add({ id: `${tag}/flag-inline`, layout, title: 'value and flag in one text item ("210 H")', spec: base(), opts: { flagMode: 'inline' } });
    add({ id: `${tag}/flag-gap2`, layout, title: 'value and flag as separate items 2pt apart', spec: base(), opts: layout === 'quest-classic' ? { questFlagGap: 2 } : { flagMode: 'gap2' } });

    // 5–8. content
    add({ id: `${tag}/names`, layout, title: 'result names with digits/units/parentheses', spec: withPanel(layout, layout.startsWith('quest') ? 'MISCELLANEOUS CHEMISTRY' : 'Miscellaneous Chemistry', TRICKY_NAMES), opts: {} });
    add({ id: `${tag}/values`, layout, title: 'unusual value tokens', spec: withPanel(layout, layout.startsWith('quest') ? 'MISCELLANEOUS' : 'Miscellaneous', TRICKY_VALUES), opts: {} });
    add({ id: `${tag}/ranges`, layout, title: 'unusual reference ranges', spec: withPanel(layout, layout.startsWith('quest') ? 'MISCELLANEOUS' : 'Miscellaneous', TRICKY_RANGES), opts: {} });
    add({ id: `${tag}/comments`, layout, title: 'long comment block (9 lines, numbered, with units)', spec: withPanel(layout, layout.startsWith('quest') ? 'HEMOGLOBIN A1c' : 'Hemoglobin A1c', LONG_COMMENT_ROWS), opts: {} });

    // 9. six pages, panel spanning three pages, footer-only page
    {
      const spec = base();
      const big = [];
      for (let i = 1; i <= 100; i++) {
        const n = String(i).padStart(3, '0');
        big.push({ name: `Allergen f${n} IgE`, value: (i % 7 === 0 ? '0.72' : '<0.10'), flag: i % 7 === 0 ? 'H' : '', unit: 'kU/L', ref: '<0.35' });
      }
      const name = layout.startsWith('quest') ? 'ALLERGEN PROFILE, FOOD' : 'Allergen Profile, Food';
      const first = base().panels.filter((p) => p.rows);
      spec.panels = [first[0], PAGE_BREAK, { name, rows: rowsFor(layout, big) }, FOOTER_ONLY, first[1] || first[0]];
      if (layout === 'labcorp-classic') spec.orderedItems = 'CBC With Differential/Platelet; Allergen Profile, Food; Comp. Metabolic Panel (14)';
      add({ id: `${tag}/six-pages`, layout, title: '6+ pages, one panel across 3 pages, a footer-only page', spec, opts: {}, minPages: 6 });
    }

    // 10. header block variations
    add({ id: `${tag}/header-combined-item`, layout, title: 'DOB / Age / Gender on one line as a single text item', spec: base(), opts: { header: { combined: 'item' } } });
    if (layout === 'labcorp-classic') add({ id: `${tag}/header-combined-cells`, layout, title: 'DOB / Age / Gender on one line as separate cells', spec: base(), opts: { header: { combined: 'cells' } } });
    {
      const keys = layout === 'labcorp-classic' ? ['patientId', 'ordering'] : layout === 'labcorp-portal' ? ['patientId', 'ordering'] : layout === 'quest-classic' ? ['patientId', 'specimenId'] : ['name', 'ordering'];
      add({ id: `${tag}/header-value-below`, layout, title: `label on one line, value on the next (${keys.join(', ')})`, spec: base(), opts: { header: { valueBelow: keys } }, required: REQUIRED_PATHS, important: ['patient.patientId'] });
    }
    if (layout !== 'quest-myquest') add({ id: `${tag}/header-blank-patient-id`, layout, title: '"Patient ID:" printed with no value', spec: base(), opts: { header: { blankPatientId: true } } });

    // 11. missing markers / header; suffix name
    add({ id: `${tag}/no-page-of`, layout, title: 'no "Page x of y" anywhere', spec: base(), opts: { header: { noPageOf: true } } });
    add({ id: `${tag}/no-table-header`, layout, title: 'table header line missing entirely', spec: base(), opts: { header: { noTableHeader: true } } });
    {
      const spec = base();
      if (layout === 'quest-myquest') spec.patient.displayName = 'ALEX QUINCY SAMPLE JR';
      else spec.patient.name = 'SAMPLE, ALEX QUINCY JR';
      add({ id: `${tag}/name-suffix`, layout, title: 'patient name "SAMPLE, ALEX QUINCY JR"', spec, opts: {}, expectName: layout === 'quest-myquest' ? /ALEX QUINCY SAMPLE JR/ : 'SAMPLE, ALEX QUINCY JR' });
    }

    // 13. Quest-specific
    if (layout === 'quest-classic') {
      const spec = base();
      for (const p of spec.panels) if (p.rows) for (const r of p.rows) r.flag = '';
      add({ id: `${tag}/all-in-range`, layout, title: 'Out of Range column empty for every row', spec, opts: {} });
      add({ id: `${tag}/units-in-value-cell`, layout, title: 'units printed after the value instead of in the range cell', spec: base(), opts: { questUnitsInValueCell: true } });
    }

    // 14. flag vocabulary swap
    if (layout.startsWith('labcorp')) {
      const spec = base();
      for (const p of spec.panels) if (p.rows) for (const r of p.rows) r.flag = { High: 'H', Low: 'L', Critical: 'HH' }[r.flag] ?? r.flag;
      add({ id: `${tag}/flags-HL`, layout, title: 'Labcorp prints H/L/HH instead of High/Low/Critical', spec, opts: {} });
    } else {
      const spec = base();
      for (const p of spec.panels) if (p.rows) for (const r of p.rows) r.flag = { H: 'High', L: 'Low', HH: 'Critical' }[r.flag] ?? r.flag;
      add({ id: `${tag}/flags-words`, layout, title: 'Quest prints High/Low/Critical instead of H/L/HH', spec, opts: {} });
    }
  }
  return out;
}

/** 12. Two reports identical except for the family member. */
export function twinSpecs(layout) {
  const a = BASES[layout]();
  const b = BASES[layout]();
  if (layout === 'quest-myquest') { b.patient.displayName = 'CASEY SAMPLE'; b.patient.dob = '11/30/1965'; }
  else { b.patient.name = 'SAMPLE, CASEY'; b.patient.dob = '11/30/1965'; }
  return { a, b };
}
