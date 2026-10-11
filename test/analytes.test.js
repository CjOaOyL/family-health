import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ANALYTES,
  normalizeAnalyte,
  normalizeUnit,
  convertUnit,
  normalizeKey,
  findAliasCollisions,
  getAnalyte,
} from '../src/model/analytes.js';

const id = (name, unit) => normalizeAnalyte(name, unit)?.id ?? null;
const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));

// ---------------------------------------------------------------- dictionary integrity

test('dictionary has 120+ entries with the required shape', () => {
  assert.ok(ANALYTES.length >= 120, `only ${ANALYTES.length} entries`);
  for (const a of ANALYTES) {
    assert.equal(typeof a.id, 'string');
    assert.match(a.id, /^[a-z0-9_]+$/, `id ${a.id} not snake_case`);
    assert.equal(typeof a.display, 'string');
    assert.ok(a.loinc === null || /^\d+-\d$/.test(a.loinc), `bad loinc on ${a.id}: ${a.loinc}`);
    assert.ok(a.canonicalUnit === null || typeof a.canonicalUnit === 'string');
    assert.ok(Array.isArray(a.aliases) && a.aliases.length > 0, `${a.id} has no aliases`);
    assert.equal(typeof a.group, 'string');
    if (a.conversions) {
      for (const [u, f] of Object.entries(a.conversions)) {
        assert.ok(typeof f === 'number' && f > 0, `${a.id} conversion ${u} not positive number`);
        assert.equal(normalizeUnit(u), u, `${a.id} conversion unit ${u} is not canonical spelling`);
      }
      assert.ok(a.canonicalUnit, `${a.id} has conversions but no canonicalUnit`);
    }
  }
});

test('every analyte id is unique', () => {
  const ids = ANALYTES.map((a) => a.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('no alias key collides across analytes', () => {
  const collisions = findAliasCollisions();
  assert.deepEqual([...collisions.entries()], []);
});

test('every alias maps back to its own analyte (no unit)', () => {
  for (const a of ANALYTES) {
    for (const alias of a.aliases) {
      assert.equal(id(alias), a.id, `alias "${alias}" resolved to ${id(alias)} not ${a.id}`);
    }
  }
});

test('canonicalUnit of every entry is already in canonical spelling', () => {
  for (const a of ANALYTES) {
    if (a.canonicalUnit) assert.equal(normalizeUnit(a.canonicalUnit), a.canonicalUnit, a.id);
  }
});

test('LOINC codes given in the spec are present', () => {
  const expect = {
    hba1c: '4548-4', glucose: '2345-7', creatinine: '2160-0', tsh: '3016-3', cholesterol_total: '2093-3', hdl: '2085-9',
    ldl: '13457-7', triglycerides: '2571-8', hemoglobin: '718-7', hematocrit: '4544-3', wbc: '6690-2', rbc: '789-8',
    platelets: '777-3', sodium: '2951-2', potassium: '2823-3', chloride: '2075-0', co2: '2028-9', calcium: '17861-6',
    bun: '3094-0', albumin: '1751-7', protein_total: '2885-2', bilirubin_total: '1975-2', alp: '6768-6', ast: '1920-8',
    alt: '1742-6', crp: '1988-5', hs_crp: '30522-7', vitamin_b12: '2132-9', folate: '2284-8', ferritin: '2276-4',
    iron: '2498-4', tibc: '2500-7', magnesium: '2601-3', phosphorus: '2777-1', uric_acid: '3084-1',
    vitamin_d_total: '62292-8', testosterone_total: '2986-8', estradiol: '2243-4',
  };
  for (const [k, v] of Object.entries(expect)) assert.equal(getAnalyte(k)?.loinc, v, k);
  assert.equal(normalizeAnalyte('Hemoglobin A1c').loinc, '4548-4');
});

// ---------------------------------------------------------------- Labcorp vs Quest names

test('normalizeKey strips case, punctuation and whitespace', () => {
  assert.equal(normalizeKey('  Vitamin D, 25-Hydroxy '), 'vitamin d 25 hydroxy');
  assert.equal(normalizeKey('HDL-C'), 'hdl c');
  assert.equal(normalizeKey('A/G Ratio'), 'a g ratio');
});

test('A1c: Labcorp and Quest spellings map to hba1c', () => {
  assert.equal(id('Hemoglobin A1c'), 'hba1c');
  assert.equal(id('HEMOGLOBIN A1c'), 'hba1c');
  assert.equal(id('HbA1c'), 'hba1c');
  assert.equal(id('Estimated Average Glucose'), 'eag');
  assert.equal(id('MEAN PLASMA GLUCOSE'), 'eag');
});

test('CBC: vendor names and short synonyms', () => {
  assert.equal(id('WBC'), 'wbc');
  assert.equal(id('WHITE BLOOD CELL COUNT'), 'wbc');
  assert.equal(id('RBC'), 'rbc');
  assert.equal(id('RED BLOOD CELL COUNT'), 'rbc');
  assert.equal(id('Hemoglobin'), 'hemoglobin');
  assert.equal(id('HEMOGLOBIN'), 'hemoglobin');
  assert.equal(id('Hgb'), 'hemoglobin');
  assert.equal(id('Hematocrit'), 'hematocrit');
  assert.equal(id('Hct'), 'hematocrit');
  assert.equal(id('MCV'), 'mcv');
  assert.equal(id('MCH'), 'mch');
  assert.equal(id('MCHC'), 'mchc');
  assert.equal(id('RDW'), 'rdw');
  assert.equal(id('Platelets'), 'platelets');
  assert.equal(id('PLATELET COUNT'), 'platelets');
  assert.equal(id('Plt'), 'platelets');
  assert.equal(id('MPV'), 'mpv');
});

test('differential: percentage vs absolute by name', () => {
  assert.equal(id('Neutrophils', '%'), 'neutrophils_pct');
  assert.equal(id('NEUTROPHILS'), 'neutrophils_pct');
  assert.equal(id('Neutrophils (Absolute)'), 'neutrophils_abs');
  assert.equal(id('ABSOLUTE NEUTROPHILS'), 'neutrophils_abs');
  assert.equal(id('Lymphs'), 'lymphocytes_pct');
  assert.equal(id('Lymphs (Absolute)'), 'lymphocytes_abs');
  assert.equal(id('ABSOLUTE LYMPHOCYTES'), 'lymphocytes_abs');
  assert.equal(id('Monocytes(Absolute)'), 'monocytes_abs');
  assert.equal(id('ABSOLUTE MONOCYTES'), 'monocytes_abs');
  assert.equal(id('Eos (Absolute)'), 'eosinophils_abs');
  assert.equal(id('ABSOLUTE EOSINOPHILS'), 'eosinophils_abs');
  assert.equal(id('Baso (Absolute)'), 'basophils_abs');
  assert.equal(id('ABSOLUTE BASOPHILS'), 'basophils_abs');
  assert.equal(id('Immature Granulocytes'), 'immature_grans_pct');
  assert.equal(id('Immature Grans (Abs)'), 'immature_grans_abs');
});

test('differential: unit disambiguates when the name is bare', () => {
  assert.equal(id('Neutrophils', 'x10E3/uL'), 'neutrophils_abs');
  assert.equal(id('Lymphs', 'Thousand/uL'), 'lymphocytes_abs');
  assert.equal(id('Monocytes', '%'), 'monocytes_pct');
  assert.equal(id('Neutrophils (Absolute)', '%'), 'neutrophils_pct');
  assert.equal(id('Eos', '10^9/L'), 'eosinophils_abs');
});

test('CMP (14): Labcorp and Quest', () => {
  const pairs = [
    ['Glucose', 'GLUCOSE', 'glucose'],
    ['BUN', 'UREA NITROGEN (BUN)', 'bun'],
    ['Creatinine', 'CREATININE', 'creatinine'],
    ['eGFR', 'EGFR', 'egfr'],
    ['BUN/Creatinine Ratio', 'BUN/CREATININE RATIO', 'bun_creatinine_ratio'],
    ['Sodium', 'SODIUM', 'sodium'],
    ['Potassium', 'POTASSIUM', 'potassium'],
    ['Chloride', 'CHLORIDE', 'chloride'],
    ['Carbon Dioxide, Total', 'CARBON DIOXIDE', 'co2'],
    ['Calcium', 'CALCIUM', 'calcium'],
    ['Protein, Total', 'PROTEIN, TOTAL', 'protein_total'],
    ['Albumin', 'ALBUMIN', 'albumin'],
    ['Globulin, Total', 'GLOBULIN', 'globulin'],
    ['A/G Ratio', 'ALBUMIN/GLOBULIN RATIO', 'ag_ratio'],
    ['Bilirubin, Total', 'BILIRUBIN, TOTAL', 'bilirubin_total'],
    ['Alkaline Phosphatase', 'ALKALINE PHOSPHATASE', 'alp'],
    ['AST (SGOT)', 'AST', 'ast'],
    ['ALT (SGPT)', 'ALT', 'alt'],
  ];
  for (const [lc, q, want] of pairs) {
    assert.equal(id(lc), want, lc);
    assert.equal(id(q), want, q);
  }
});

test('lipids: Labcorp and Quest', () => {
  assert.equal(id('Cholesterol, Total'), 'cholesterol_total');
  assert.equal(id('CHOLESTEROL, TOTAL'), 'cholesterol_total');
  assert.equal(id('Triglycerides'), 'triglycerides');
  assert.equal(id('TRIGLYCERIDES'), 'triglycerides');
  assert.equal(id('HDL-C'), 'hdl');
  assert.equal(id('HDL CHOLESTEROL'), 'hdl');
  assert.equal(id('LDL Chol Calc (NIH)'), 'ldl');
  assert.equal(id('LDL-CHOLESTEROL'), 'ldl');
  assert.equal(id('VLDL Cholesterol Cal'), 'vldl');
  assert.equal(id('CHOL/HDLC RATIO'), 'chol_hdl_ratio');
  assert.equal(id('NON HDL CHOLESTEROL'), 'non_hdl');
  assert.equal(id('Lipoprotein (a)'), 'lipoprotein_a');
  assert.equal(id('Apolipoprotein B'), 'apob');
});

test('thyroid, vitamins, iron: Labcorp and Quest', () => {
  assert.equal(id('TSH'), 'tsh');
  assert.equal(id('T4, FREE'), 't4_free');
  assert.equal(id('T4,Free(Direct)'), 't4_free');
  assert.equal(id('T3, FREE'), 't3_free');
  assert.equal(id('Reverse T3, Serum'), 't3_reverse');
  assert.equal(id('Thyroid Peroxidase (TPO) Ab'), 'tpo_ab');
  assert.equal(id('Vitamin D, 25-Hydroxy'), 'vitamin_d_total');
  assert.equal(id('VITAMIN D, 25-OH, TOTAL'), 'vitamin_d_total');
  assert.equal(id('VITAMIN D, 25-OH, D3'), 'vitamin_d3');
  assert.equal(id('VITAMIN D, 25-OH, D2'), 'vitamin_d2');
  assert.equal(id('Vitamin B12'), 'vitamin_b12');
  assert.equal(id('VITAMIN B12'), 'vitamin_b12');
  assert.equal(id('Folate (Folic Acid), Serum'), 'folate');
  assert.equal(id('FOLATE, SERUM'), 'folate');
  assert.equal(id('Ferritin'), 'ferritin');
  assert.equal(id('Iron Bind.Cap.(TIBC)'), 'tibc');
  assert.equal(id('IRON BINDING CAPACITY'), 'tibc');
  assert.equal(id('UIBC'), 'uibc');
  assert.equal(id('Iron Saturation'), 'iron_saturation');
  assert.equal(id('% SATURATION'), 'iron_saturation');
  assert.equal(id('IRON, TOTAL'), 'iron');
});

test('misc panels: PSA, infectious, urinalysis, coag, blood type', () => {
  assert.equal(id('PSA, TOTAL'), 'psa_total');
  assert.equal(id('Prostate Specific Ag, Serum'), 'psa_total');
  assert.equal(id('PSA, Free'), 'psa_free');
  assert.equal(id('PSA, Free', '%'), 'psa_free_pct');
  assert.equal(id('HEPATITIS C ANTIBODY'), 'hcv_ab');
  assert.equal(id('Hep C Virus Ab'), 'hcv_ab');
  assert.equal(id('HIV 1/2 ANTIGEN/ANTIBODY'), 'hiv_ag_ab');
  assert.equal(id('Hepatitis B Surface Ag'), 'hbsag');
  assert.equal(id('Specific Gravity'), 'urine_specific_gravity');
  assert.equal(id('pH'), 'urine_ph');
  assert.equal(id('Leukocytes'), 'urine_leukocyte_esterase');
  assert.equal(id('Glucose, Urine'), 'urine_glucose');
  assert.equal(id('WBC', '/HPF'), 'urine_wbc');
  assert.equal(id('RBC', '/hpf'), 'urine_rbc');
  assert.equal(id('Microalb/Creat Ratio'), 'microalbumin_creat_ratio');
  assert.equal(id('Creatinine, Random Urine'), 'creatinine_urine');
  assert.equal(id('Prothrombin Time'), 'pt');
  assert.equal(id('INR'), 'inr');
  assert.equal(id('aPTT'), 'ptt');
  assert.equal(id('ABO/Rh'), 'abo_rh');
  assert.equal(id('Cortisol - AM'), 'cortisol_am');
  assert.equal(id('Sex Horm Binding Glob, Serum'), 'shbg');
  assert.equal(id('t-Transglutaminase (tTG) IgA'), 'celiac_ttg_iga');
  assert.equal(id('Immunoglobulin A, Qn, Serum'), 'iga_total');
});

test('fuzzy token match and filler stripping', () => {
  assert.equal(id('Cholesterol, Total, Serum, Quant'), 'cholesterol_total');
  assert.equal(id('Hemoglobin A1c, Blood'), 'hba1c');
  assert.equal(id('Vitamin D 25-Hydroxy Total'), 'vitamin_d_total'); // 4/5 tokens, subset → Jaccard 0.8
  assert.equal(id('Not A Real Test'), null);
  assert.equal(id(''), null);
  assert.equal(id(null), null);
  assert.deepEqual(normalizeAnalyte('Glucose'), normalizeAnalyte('GLUCOSE'));
  assert.deepEqual(normalizeAnalyte('GLUCOSE'), { id: 'glucose', loinc: '2345-7', canonicalUnit: 'mg/dL', display: 'Glucose' });
});

// ---------------------------------------------------------------- units

test('normalizeUnit: counts', () => {
  for (const u of ['Thousand/uL', 'x10E3/uL', 'K/uL', '10*3/uL', '10^3/uL', 'thousand/ul', 'x10E3/mcL']) assert.equal(normalizeUnit(u), '10^3/uL', u);
  for (const u of ['Million/uL', 'x10E6/uL', 'M/uL', '10^6/uL']) assert.equal(normalizeUnit(u), '10^6/uL', u);
  assert.equal(normalizeUnit('10*9/L'), '10^9/L');
  assert.equal(normalizeUnit('10*12/L'), '10^12/L');
});

test('normalizeUnit: mass/molar spellings', () => {
  assert.equal(normalizeUnit('mg/dl'), 'mg/dL');
  assert.equal(normalizeUnit('MG/DL'), 'mg/dL');
  assert.equal(normalizeUnit('ng/ml'), 'ng/mL');
  assert.equal(normalizeUnit('pg/ml'), 'pg/mL');
  assert.equal(normalizeUnit('g/dl'), 'g/dL');
  assert.equal(normalizeUnit('mcg/dL'), 'ug/dL');
  assert.equal(normalizeUnit('µg/dL'), 'ug/dL');
  assert.equal(normalizeUnit('µmol/L'), 'umol/L');
  assert.equal(normalizeUnit('uIU/mL'), 'uIU/mL');
  assert.equal(normalizeUnit('mIU/L'), 'uIU/mL');
  assert.equal(normalizeUnit('µIU/mL'), 'uIU/mL');
  assert.equal(normalizeUnit('mIU/mL'), 'mIU/mL');
});

test('normalizeUnit: eGFR, enzyme units kept distinct, percent, unknown', () => {
  for (const u of ['mL/min/1.73', 'mL/min/1.73m2', 'mL/min/1.73 m^2', 'mL/min/1.73m²', 'mL/min/{1.73_m2}']) assert.equal(normalizeUnit(u), 'mL/min/1.73m2', u);
  assert.equal(normalizeUnit('IU/L'), 'IU/L');
  assert.equal(normalizeUnit('U/L'), 'U/L');
  assert.notEqual(normalizeUnit('IU/L'), normalizeUnit('U/L'));
  assert.equal(normalizeUnit('%'), '%');
  assert.equal(normalizeUnit('  %  '), '%');
  assert.equal(normalizeUnit('  furlongs/fortnight '), 'furlongs/fortnight');
  assert.equal(normalizeUnit(null), null);
  assert.equal(normalizeUnit(''), '');
  assert.equal(normalizeUnit('/hpf'), '/HPF');
  assert.equal(normalizeUnit('mm/h'), 'mm/hr');
});

// ---------------------------------------------------------------- conversions

test('convertUnit: identity and spelling-only differences', () => {
  assert.equal(convertUnit(5.5, 'mg/dL', 'mg/dl'), 5.5);
  assert.equal(convertUnit(7.2, 'Thousand/uL', 'x10E3/uL', 'wbc'), 7.2);
  assert.equal(convertUnit(7.2, 'Thousand/uL', '10^9/L'), 7.2);
  assert.equal(convertUnit(4.5, 'Million/uL', '10^12/L', 'rbc'), 4.5);
  assert.equal(convertUnit(2.5, 'uIU/mL', 'mIU/L', 'tsh'), 2.5);
  assert.equal(convertUnit(50, 'ng/mL', 'ug/L', 'ferritin'), 50);
});

test('convertUnit: analyte-specific molar factors and round trips', () => {
  const cases = [
    ['glucose', 100, 'mg/dL', 'mmol/L', 5.55],
    ['cholesterol_total', 200, 'mg/dL', 'mmol/L', 5.172],
    ['hdl', 50, 'mg/dL', 'mmol/L', 1.293],
    ['ldl', 100, 'mg/dL', 'mmol/L', 2.586],
    ['triglycerides', 150, 'mg/dL', 'mmol/L', 1.6935],
    ['creatinine', 1.0, 'mg/dL', 'umol/L', 88.4],
    ['bilirubin_total', 1.0, 'mg/dL', 'umol/L', 17.1],
    ['calcium', 10, 'mg/dL', 'mmol/L', 2.495],
    ['bun', 10, 'mg/dL', 'mmol/L', 3.57],
    ['uric_acid', 5, 'mg/dL', 'umol/L', 297.4],
    ['vitamin_d_total', 30, 'ng/mL', 'nmol/L', 74.88],
    ['vitamin_b12', 500, 'pg/mL', 'pmol/L', 368.9],
    ['folate', 10, 'ng/mL', 'nmol/L', 22.66],
    ['hemoglobin', 14, 'g/dL', 'g/L', 140],
    ['hemoglobin', 14, 'g/dL', 'mmol/L', 8.6884],
    ['testosterone_total', 500, 'ng/dL', 'nmol/L', 17.35],
    ['estradiol', 100, 'pg/mL', 'pmol/L', 367.1],
    ['cortisol', 10, 'ug/dL', 'nmol/L', 275.9],
    ['magnesium', 2, 'mg/dL', 'mmol/L', 0.8228],
    ['phosphorus', 3.5, 'mg/dL', 'mmol/L', 1.13015],
    ['iron', 100, 'ug/dL', 'umol/L', 17.9],
  ];
  for (const [aid, v, from, to, want] of cases) {
    const got = convertUnit(v, from, to, aid);
    assert.ok(got != null && near(got, want, 1e-6), `${aid} ${v} ${from}→${to}: got ${got}, want ${want}`);
    const back = convertUnit(got, to, from, aid);
    assert.ok(back != null && near(back, v, 1e-9), `${aid} round trip: ${back} != ${v}`);
  }
});

test('convertUnit: composes a generic hop with the analyte table', () => {
  // g/L → mmol/L for hemoglobin goes g/L → g/dL (generic) → mmol/L (analyte)
  const got = convertUnit(140, 'g/L', 'mmol/L', 'hemoglobin');
  assert.ok(near(got, 8.6884, 1e-6), String(got));
  // mcg/dL spelled with mu, to umol/L, iron
  assert.ok(near(convertUnit(100, 'µg/dL', 'µmol/L', 'iron'), 17.9, 1e-6));
});

test('convertUnit: refuses to guess', () => {
  assert.equal(convertUnit(100, 'mg/dL', 'mmol/L'), null); // no analyte → molar mass unknown
  assert.equal(convertUnit(100, 'mg/dL', 'mmol/L', 'not_an_analyte'), null);
  assert.equal(convertUnit(5, '%', 'mmol/mol', 'hba1c'), null); // NGSP→IFCC is affine, not a factor
  assert.equal(convertUnit(1, 'IU/L', 'U/L'), null); // distinct unless the analyte says so
  assert.equal(convertUnit(1, 'IU/L', 'U/L', 'alt'), 1);
  assert.equal(convertUnit(NaN, 'mg/dL', 'mmol/L', 'glucose'), null);
  assert.equal(convertUnit(null, 'mg/dL', 'mmol/L', 'glucose'), null);
  assert.equal(convertUnit('5', 'mg/dL', 'mmol/L', 'glucose'), null);
  assert.equal(convertUnit(5, null, 'mmol/L', 'glucose'), null);
});
