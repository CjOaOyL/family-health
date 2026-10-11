// Analyte dictionary + unit normalization. See docs/SPEC.md §7.
// Pure data and functions; isomorphic (no Node-only imports, no network).
//
// Each ANALYTES entry:
//   id            stable canonical id used in Result.canonicalId
//   display       human label
//   loinc         LOINC code only where it is unambiguously the standard code for the common method; else null
//   canonicalUnit the unit stored results are normalized to (null for text-only results)
//   aliases       how Labcorp / Quest / clinicians print the name (matched case/punct-insensitively)
//   conversions   factors FROM canonicalUnit TO the keyed unit (value_in_key = value_in_canonical * factor)
//   group         panel/family grouping for the UI

const A = (id, display, loinc, canonicalUnit, group, aliases, conversions) => {
  const e = { id, display, loinc, canonicalUnit, aliases, group };
  if (conversions) e.conversions = conversions;
  return e;
};

const MMOL_CHOL = { 'mmol/L': 0.02586 };
const K_TO_L = { '10^9/L': 1 };
const VITD = { 'nmol/L': 2.496 };
const G_DL = { 'g/L': 10 };
const IU_U = { 'U/L': 1 };
const UG_DL_IRON = { 'umol/L': 0.179 };

export const ANALYTES = [
  // ---------------- CBC with differential ----------------
  A('wbc', 'WBC', '6690-2', '10^3/uL', 'cbc',
    ['WBC', 'White Blood Cell Count', 'White Blood Cells', 'WBC Count', 'White Count', 'Leukocyte Count', 'WBC, Blood'], K_TO_L),
  A('rbc', 'RBC', '789-8', '10^6/uL', 'cbc',
    ['RBC', 'Red Blood Cell Count', 'Red Blood Cells', 'Erythrocytes', 'RBC Count', 'Erythrocyte Count'], { '10^12/L': 1 }),
  A('hemoglobin', 'Hemoglobin', '718-7', 'g/dL', 'cbc',
    ['Hemoglobin', 'Hgb', 'Hb', 'HGB', 'Haemoglobin'], { 'g/L': 10, 'mmol/L': 0.6206 }),
  A('hematocrit', 'Hematocrit', '4544-3', '%', 'cbc',
    ['Hematocrit', 'Hct', 'HCT', 'Packed Cell Volume', 'Haematocrit']),
  A('mcv', 'MCV', '787-2', 'fL', 'cbc',
    ['MCV', 'Mean Corpuscular Volume', 'Mean Cell Volume']),
  A('mch', 'MCH', '785-6', 'pg', 'cbc',
    ['MCH', 'Mean Corpuscular Hemoglobin', 'Mean Cell Hemoglobin']),
  A('mchc', 'MCHC', '786-4', 'g/dL', 'cbc',
    ['MCHC', 'Mean Corpuscular Hemoglobin Concentration', 'Mean Corpuscular Hgb Conc', 'Mean Cell Hemoglobin Concentration']),
  A('rdw', 'RDW', '788-0', '%', 'cbc',
    ['RDW', 'RDW-CV', 'Red Cell Distribution Width', 'RDW CV', 'Red Cell Dist Width']),
  A('rdw_sd', 'RDW-SD', null, 'fL', 'cbc',
    ['RDW-SD', 'Red Cell Distribution Width SD']),
  A('platelets', 'Platelets', '777-3', '10^3/uL', 'cbc',
    ['Platelets', 'Platelet Count', 'Plt', 'PLT', 'Thrombocytes', 'Platelets, Blood'], K_TO_L),
  A('mpv', 'MPV', '32623-1', 'fL', 'cbc',
    ['MPV', 'Mean Platelet Volume']),
  A('neutrophils_pct', 'Neutrophils %', '770-8', '%', 'cbc',
    ['Neutrophils', 'Neutrophils %', 'Neutrophil %', 'Neut %', 'Neutrophils Relative', 'Neutrophils (Relative)',
      'Segmented Neutrophils', 'Segs', 'Polys', '% Neutrophils', 'Neutrophils, Percent', 'Neutrophils Percent']),
  A('neutrophils_abs', 'Neutrophils (Absolute)', '751-8', '10^3/uL', 'cbc',
    ['Neutrophils (Absolute)', 'Absolute Neutrophils', 'Neutrophils Absolute', 'Neutrophils Abs', 'Neut Abs', 'Neutro Abs',
      'ANC', 'Absolute Neutrophil Count', 'Neutrophils, Absolute', 'Neutrophil Absolute Count'], K_TO_L),
  A('lymphocytes_pct', 'Lymphocytes %', '736-9', '%', 'cbc',
    ['Lymphs', 'Lymphocytes', 'Lymphocytes %', 'Lymphs %', 'Lymph %', 'Lymphocytes Relative', 'Lymphocytes (Relative)',
      '% Lymphocytes', 'Lymphocytes, Percent', 'Lymphocytes Percent']),
  A('lymphocytes_abs', 'Lymphocytes (Absolute)', '731-0', '10^3/uL', 'cbc',
    ['Lymphs (Absolute)', 'Lymphocytes (Absolute)', 'Absolute Lymphocytes', 'Lymphocytes Absolute', 'Lymphs Abs', 'Lymph Abs',
      'ALC', 'Absolute Lymphocyte Count', 'Lymphocytes, Absolute'], K_TO_L),
  A('monocytes_pct', 'Monocytes %', '5905-5', '%', 'cbc',
    ['Monocytes', 'Monocytes %', 'Mono %', 'Monos', 'Monocytes Relative', 'Monocytes (Relative)', '% Monocytes',
      'Monocytes, Percent', 'Monocytes Percent']),
  A('monocytes_abs', 'Monocytes (Absolute)', '742-7', '10^3/uL', 'cbc',
    ['Monocytes(Absolute)', 'Monocytes (Absolute)', 'Absolute Monocytes', 'Monocytes Absolute', 'Mono Abs', 'Monos Abs',
      'AMC', 'Absolute Monocyte Count', 'Monocytes, Absolute'], K_TO_L),
  A('eosinophils_pct', 'Eosinophils %', '713-8', '%', 'cbc',
    ['Eos', 'Eosinophils', 'Eosinophils %', 'Eos %', 'Eosinophils Relative', 'Eosinophils (Relative)', '% Eosinophils',
      'Eosinophils, Percent', 'Eosinophils Percent', 'Eosinophil %']),
  A('eosinophils_abs', 'Eosinophils (Absolute)', '711-2', '10^3/uL', 'cbc',
    ['Eos (Absolute)', 'Eosinophils (Absolute)', 'Absolute Eosinophils', 'Eosinophils Absolute', 'Eos Abs', 'AEC',
      'Absolute Eosinophil Count', 'Eosinophils, Absolute'], K_TO_L),
  A('basophils_pct', 'Basophils %', '706-2', '%', 'cbc',
    ['Basos', 'Basophils', 'Basophils %', 'Baso %', 'Basophils Relative', 'Basophils (Relative)', '% Basophils',
      'Basophils, Percent', 'Basophils Percent', 'Basophil %']),
  A('basophils_abs', 'Basophils (Absolute)', '704-7', '10^3/uL', 'cbc',
    ['Baso (Absolute)', 'Basos (Absolute)', 'Basophils (Absolute)', 'Absolute Basophils', 'Basophils Absolute', 'Baso Abs',
      'Absolute Basophil Count', 'Basophils, Absolute'], K_TO_L),
  A('immature_grans_pct', 'Immature Granulocytes %', '71695-1', '%', 'cbc',
    ['Immature Granulocytes', 'Immature Granulocytes %', 'Immature Grans %', 'IG %', 'Immature Grans', 'IG',
      'Immature Granulocytes (Relative)', 'Immature Granulocytes Percent']),
  A('immature_grans_abs', 'Immature Granulocytes (Absolute)', '51584-1', '10^3/uL', 'cbc',
    ['Immature Grans (Abs)', 'Immature Granulocytes (Absolute)', 'Absolute Immature Granulocytes', 'Immature Grans Abs',
      'IG Abs', 'Immature Granulocytes Abs', 'Immature Granulocytes Absolute'], K_TO_L),
  A('nrbc_pct', 'Nucleated RBC %', null, '%', 'cbc',
    ['NRBC', 'Nucleated RBC', 'nRBC', 'Nucleated Red Blood Cells', 'NRBC %', 'Nucleated RBC %', 'NRBC (Relative)']),
  A('nrbc_abs', 'Nucleated RBC (Absolute)', null, '10^3/uL', 'cbc',
    ['NRBC (Absolute)', 'Nucleated RBC (Absolute)', 'Absolute NRBC', 'NRBC Abs', 'Nucleated RBC Abs'], K_TO_L),
  A('reticulocytes_pct', 'Reticulocytes %', '4679-7', '%', 'cbc',
    ['Reticulocyte Count', 'Reticulocytes', 'Retic Count', 'Retic %', 'Reticulocytes %', 'Reticulocyte %']),
  A('reticulocytes_abs', 'Reticulocytes (Absolute)', null, '10^3/uL', 'cbc',
    ['Reticulocytes (Absolute)', 'Absolute Reticulocytes', 'Retic Abs', 'Reticulocyte Count, Absolute', 'Absolute Retic Count'], K_TO_L),

  // ---------------- CMP (14) ----------------
  A('glucose', 'Glucose', '2345-7', 'mg/dL', 'cmp',
    ['Glucose', 'Glucose, Serum', 'Glucose Serum', 'Glucose, Plasma', 'Glucose Fasting', 'Glucose, Fasting', 'Fasting Glucose',
      'Blood Glucose', 'Glucose, Serum/Plasma', 'Glucose, Random'], { 'mmol/L': 0.0555 }),
  A('bun', 'BUN', '3094-0', 'mg/dL', 'cmp',
    ['BUN', 'Urea Nitrogen (BUN)', 'Urea Nitrogen', 'Blood Urea Nitrogen', 'Urea Nitrogen, Serum', 'BUN, Serum', 'Urea Nitrogen, Blood'],
    { 'mmol/L': 0.357 }),
  A('creatinine', 'Creatinine', '2160-0', 'mg/dL', 'cmp',
    ['Creatinine', 'Creatinine, Serum', 'Creatinine Serum', 'Creat', 'Creatinine, Plasma', 'Creatinine, Blood'], { 'umol/L': 88.4 }),
  A('egfr', 'eGFR', null, 'mL/min/1.73m2', 'cmp',
    ['eGFR', 'EGFR', 'Estimated GFR', 'GFR Estimate', 'eGFR (CKD-EPI 2021)', 'eGFR CKD-EPI', 'Glomerular Filtration Rate, Estimated',
      'GFR, Estimated', 'eGFR, CKD-EPI 2021', 'Est. GFR', 'eGFR (CKD-EPI)', 'Estimated Glomerular Filtration Rate']),
  A('egfr_nonaa', 'eGFR (Non-African American)', null, 'mL/min/1.73m2', 'cmp',
    ['eGFR If NonAfricn Am', 'eGFR Non-African American', 'GFR, Estimated (Non-African American)', 'eGFR Non Afr American',
      'EGFR NON-AFR. AMERICAN', 'eGFR Non-Afr American']),
  A('egfr_aa', 'eGFR (African American)', null, 'mL/min/1.73m2', 'cmp',
    ['eGFR If Africn Am', 'eGFR African American', 'GFR, Estimated (African American)', 'EGFR AFRICAN AMERICAN', 'eGFR Afr American']),
  A('bun_creatinine_ratio', 'BUN/Creatinine Ratio', '3097-3', 'ratio', 'cmp',
    ['BUN/Creatinine Ratio', 'BUN/Creat Ratio', 'BUN Creatinine Ratio', 'BUN/Creat', 'BUN:Creatinine Ratio', 'Urea Nitrogen/Creatinine Ratio']),
  A('sodium', 'Sodium', '2951-2', 'mmol/L', 'cmp',
    ['Sodium', 'Na', 'Sodium, Serum', 'Sodium Serum', 'Sodium, Plasma'], { 'mEq/L': 1 }),
  A('potassium', 'Potassium', '2823-3', 'mmol/L', 'cmp',
    ['Potassium', 'K', 'Potassium, Serum', 'Potassium Serum', 'Potassium, Plasma'], { 'mEq/L': 1 }),
  A('chloride', 'Chloride', '2075-0', 'mmol/L', 'cmp',
    ['Chloride', 'Cl', 'Chloride, Serum', 'Chloride Serum', 'Chloride, Plasma'], { 'mEq/L': 1 }),
  A('co2', 'Carbon Dioxide, Total', '2028-9', 'mmol/L', 'cmp',
    ['Carbon Dioxide', 'Carbon Dioxide, Total', 'CO2', 'CO2, Total', 'Bicarbonate', 'HCO3', 'Total CO2', 'Carbon Dioxide Total', 'CO2 Total'],
    { 'mEq/L': 1 }),
  A('calcium', 'Calcium', '17861-6', 'mg/dL', 'cmp',
    ['Calcium', 'Calcium, Serum', 'Ca', 'Calcium Serum', 'Calcium, Total', 'Total Calcium', 'Calcium, Plasma'], { 'mmol/L': 0.2495 }),
  A('protein_total', 'Protein, Total', '2885-2', 'g/dL', 'cmp',
    ['Protein, Total', 'Total Protein', 'Protein Total', 'Protein, Total, Serum', 'TP', 'Total Protein, Serum'], G_DL),
  A('albumin', 'Albumin', '1751-7', 'g/dL', 'cmp',
    ['Albumin', 'Albumin, Serum', 'Albumin Serum', 'Alb', 'Albumin, Plasma'], G_DL),
  A('globulin', 'Globulin, Total', '10834-0', 'g/dL', 'cmp',
    ['Globulin, Total', 'Globulin', 'Total Globulin', 'Globulin Total', 'Globulin (calculated)', 'Globulin, Calculated'], G_DL),
  A('ag_ratio', 'A/G Ratio', '1759-0', 'ratio', 'cmp',
    ['A/G Ratio', 'Albumin/Globulin Ratio', 'A/G', 'Alb/Glob Ratio', 'Albumin Globulin Ratio', 'Albumin:Globulin Ratio', 'A:G Ratio']),
  A('bilirubin_total', 'Bilirubin, Total', '1975-2', 'mg/dL', 'cmp',
    ['Bilirubin, Total', 'Total Bilirubin', 'Bilirubin Total', 'Bilirubin', 'T. Bili', 'TBIL', 'Bilirubin, Total, Serum'], { 'umol/L': 17.1 }),
  A('bilirubin_direct', 'Bilirubin, Direct', '1968-7', 'mg/dL', 'liver',
    ['Bilirubin, Direct', 'Direct Bilirubin', 'Bilirubin Direct', 'Conjugated Bilirubin', 'D. Bili', 'DBIL'], { 'umol/L': 17.1 }),
  A('bilirubin_indirect', 'Bilirubin, Indirect', null, 'mg/dL', 'liver',
    ['Bilirubin, Indirect', 'Indirect Bilirubin', 'Bilirubin Indirect', 'Unconjugated Bilirubin'], { 'umol/L': 17.1 }),
  A('alp', 'Alkaline Phosphatase', '6768-6', 'IU/L', 'cmp',
    ['Alkaline Phosphatase', 'Alk Phos', 'ALP', 'Alkaline Phosphatase, S', 'Alk Phosphatase', 'Alkaline Phosphatase, Serum', 'Alkaline Phos'], IU_U),
  A('ast', 'AST (SGOT)', '1920-8', 'IU/L', 'cmp',
    ['AST (SGOT)', 'AST', 'SGOT', 'Aspartate Aminotransferase', 'AST SGOT', 'Aspartate Transaminase'], IU_U),
  A('alt', 'ALT (SGPT)', '1742-6', 'IU/L', 'cmp',
    ['ALT (SGPT)', 'ALT', 'SGPT', 'Alanine Aminotransferase', 'ALT SGPT', 'Alanine Transaminase'], IU_U),

  // ---------------- Lipids ----------------
  A('cholesterol_total', 'Cholesterol, Total', '2093-3', 'mg/dL', 'lipid',
    ['Cholesterol, Total', 'Total Cholesterol', 'Cholesterol', 'Cholesterol Total', 'Chol', 'TC', 'Cholesterol, Serum'], MMOL_CHOL),
  A('hdl', 'HDL Cholesterol', '2085-9', 'mg/dL', 'lipid',
    ['HDL-C', 'HDL', 'HDL Cholesterol', 'HDL Chol', 'HDL-Cholesterol', 'HDL Chol Direct', 'HDL, Direct', 'HDLC', 'HDL Cholesterol, Direct',
      'Cholesterol, HDL', 'High Density Lipoprotein Cholesterol'], MMOL_CHOL),
  A('ldl', 'LDL Cholesterol (Calc)', '13457-7', 'mg/dL', 'lipid',
    ['LDL Chol Calc (NIH)', 'LDL', 'LDL-C', 'LDL Cholesterol', 'LDL-Cholesterol', 'LDL Chol Calc', 'LDL Calculated', 'LDL Cholesterol Calc',
      'LDL-C Calculated', 'LDL Cholesterol (Calc)', 'LDL Cholesterol Calculated (NIH)', 'LDL Cholesterol, Calculated', 'LDLC',
      'Cholesterol, LDL', 'Low Density Lipoprotein Cholesterol'], MMOL_CHOL),
  A('ldl_direct', 'LDL Cholesterol, Direct', '18262-6', 'mg/dL', 'lipid',
    ['LDL Cholesterol, Direct', 'Direct LDL', 'LDL Direct', 'LDL-C Direct', 'LDL Cholesterol Direct', 'Direct LDL Cholesterol'], MMOL_CHOL),
  A('triglycerides', 'Triglycerides', '2571-8', 'mg/dL', 'lipid',
    ['Triglycerides', 'Trig', 'TG', 'Triglyceride', 'Trigs', 'Triglycerides, Serum'], { 'mmol/L': 0.01129 }),
  A('vldl', 'VLDL Cholesterol (Calc)', '13458-5', 'mg/dL', 'lipid',
    ['VLDL Cholesterol Cal', 'VLDL', 'VLDL Cholesterol', 'VLDL Cholesterol Calc', 'VLDL-C', 'VLDL Cholesterol Calculated', 'VLDL Chol Calc',
      'Cholesterol, VLDL'], MMOL_CHOL),
  A('non_hdl', 'Non-HDL Cholesterol', '43396-1', 'mg/dL', 'lipid',
    ['Non HDL Cholesterol', 'Non-HDL Cholesterol', 'Non-HDL', 'Non HDL', 'Non-HDL-C', 'Cholesterol, Non-HDL', 'Non HDL-C', 'NonHDL Cholesterol'],
    MMOL_CHOL),
  A('chol_hdl_ratio', 'Cholesterol/HDL Ratio', '9830-1', 'ratio', 'lipid',
    ['Chol/HDLC Ratio', 'Cholesterol/HDL Ratio', 'Chol/HDL Ratio', 'Total Cholesterol/HDL Ratio', 'TC/HDL Ratio', 'Chol/HDL',
      'Cholesterol, Total/HDL Ratio', 'T. Chol/HDL Ratio', 'Cholesterol/HDL-C Ratio']),
  A('ldl_hdl_ratio', 'LDL/HDL Ratio', null, 'ratio', 'lipid',
    ['LDL/HDL Ratio', 'LDL/HDL', 'LDL-C/HDL-C Ratio', 'LDL/HDL Cholesterol Ratio']),
  A('tg_hdl_ratio', 'Triglycerides/HDL Ratio', null, 'ratio', 'lipid',
    ['Triglycerides/HDL Ratio', 'TG/HDL Ratio', 'Trig/HDL Ratio', 'TG/HDL', 'Triglyceride/HDL Ratio']),
  A('lipoprotein_a', 'Lipoprotein (a)', null, 'nmol/L', 'lipid',
    ['Lipoprotein (a)', 'Lipoprotein(a)', 'Lp(a)', 'Lipoprotein a', 'LPA', 'Lp (a)', 'Lipoprotein A']),
  A('apob', 'Apolipoprotein B', '1884-6', 'mg/dL', 'lipid',
    ['Apolipoprotein B', 'Apo B', 'ApoB', 'Apolipoprotein B-100', 'Apo B-100', 'Apolipoprotein B100'], { 'g/L': 0.01 }),
  A('apoa1', 'Apolipoprotein A-1', '1869-7', 'mg/dL', 'lipid',
    ['Apolipoprotein A-1', 'Apo A-1', 'ApoA1', 'Apolipoprotein A1', 'Apo A1', 'Apolipoprotein A-I', 'Apo A-I'], { 'g/L': 0.01 }),

  // ---------------- Diabetes ----------------
  A('hba1c', 'Hemoglobin A1c', '4548-4', '%', 'diabetes',
    ['Hemoglobin A1c', 'HbA1c', 'A1c', 'Hgb A1c', 'Glycohemoglobin', 'Hemoglobin A1C', 'Hb A1c', 'Hemoglobin A1c, Whole Blood',
      'Glycated Hemoglobin', 'Glycosylated Hemoglobin', 'Hgb A1C', 'HgbA1c']),
  A('eag', 'Estimated Average Glucose', '27353-2', 'mg/dL', 'diabetes',
    ['Estimated Average Glucose', 'Mean Plasma Glucose', 'eAG', 'Est. Avg Glucose', 'Estimated Average Glucose (eAG)', 'Estim. Avg Glu (eAG)',
      'Estim. Avg Glu', 'Average Glucose, Estimated', 'Est Average Glucose'], { 'mmol/L': 0.0555 }),
  A('insulin', 'Insulin', '20448-7', 'uIU/mL', 'diabetes',
    ['Insulin', 'Insulin, Fasting', 'Fasting Insulin', 'Insulin, Serum', 'Insulin Fasting'], { 'pmol/L': 6.945 }),
  A('c_peptide', 'C-Peptide', '1986-9', 'ng/mL', 'diabetes',
    ['C-Peptide', 'C Peptide', 'C-Peptide, Serum', 'C-Peptide, Fasting'], { 'nmol/L': 0.331 }),
  A('fructosamine', 'Fructosamine', null, 'umol/L', 'diabetes',
    ['Fructosamine', 'Fructosamine, Serum']),

  // ---------------- Thyroid ----------------
  A('tsh', 'TSH', '3016-3', 'uIU/mL', 'thyroid',
    ['TSH', 'Thyroid Stimulating Hormone', 'Thyrotropin', 'TSH, 3rd Generation', 'TSH 3rd Generation', 'Thyroid-Stimulating Hormone',
      'TSH, Serum', 'TSH w/Reflex to FT4', 'TSH With Reflex to FT4']), // mIU/L is folded into uIU/mL by normalizeUnit
  A('t4_free', 'T4, Free', '3024-7', 'ng/dL', 'thyroid',
    ['T4, Free', 'Free T4', 'T4 Free', 'Free Thyroxine', 'FT4', 'T4,Free(Direct)', 'T4, Free (Direct)', 'Thyroxine (T4) Free', 'Free T4 (Direct)',
      'Thyroxine, Free', 'Free T4, Direct', 'T4, Free, Direct'], { 'pmol/L': 12.87 }),
  A('t4_total', 'T4, Total', '3026-2', 'ug/dL', 'thyroid',
    ['T4', 'T4, Total', 'Total T4', 'Thyroxine (T4)', 'Thyroxine', 'T4 Total', 'Thyroxine, Total', 'Total Thyroxine', 'T4 (Thyroxine), Total'],
    { 'nmol/L': 12.87 }),
  A('t3_free', 'T3, Free', '3051-0', 'pg/mL', 'thyroid',
    ['T3, Free', 'Free T3', 'T3 Free', 'Triiodothyronine, Free', 'FT3', 'Triiodothyronine (T3), Free', 'Free T3 (Direct)', 'Triiodothyronine,Free,Serum',
      'Free Triiodothyronine', 'T3, Free, Serum'], { 'pmol/L': 1.536 }),
  A('t3_total', 'T3, Total', '3053-6', 'ng/dL', 'thyroid',
    ['T3', 'T3, Total', 'Total T3', 'Triiodothyronine (T3)', 'Triiodothyronine', 'T3 Total', 'Triiodothyronine, Total', 'Total Triiodothyronine'],
    { 'nmol/L': 0.01536 }),
  A('t3_reverse', 'Reverse T3', null, 'ng/dL', 'thyroid',
    ['Reverse T3', 'Reverse T3, Serum', 'rT3', 'T3, Reverse', 'Triiodothyronine, Reverse', 'Reverse Triiodothyronine', 'T3 Reverse', 'Reverse T3 (rT3)']),
  A('t3_uptake', 'T3 Uptake', null, '%', 'thyroid',
    ['T3 Uptake', 'T3 Uptake Ratio', 'T-Uptake', 'Thyroid Uptake', 'T3U', 'T Uptake']),
  A('tpo_ab', 'Thyroid Peroxidase (TPO) Ab', '8099-4', 'IU/mL', 'thyroid',
    ['Thyroid Peroxidase (TPO) Ab', 'TPO Antibodies', 'Thyroid Peroxidase Antibodies', 'Anti-TPO', 'TPO Ab', 'Thyroperoxidase Antibodies',
      'Thyroid Peroxidase Ab', 'Thyroid Peroxidase Antibody', 'Anti-Thyroid Peroxidase', 'TPO', 'Microsomal Antibodies']),
  A('tg_ab', 'Thyroglobulin Antibody', '8098-6', 'IU/mL', 'thyroid',
    ['Thyroglobulin Antibody', 'Thyroglobulin Antibodies', 'Anti-Thyroglobulin', 'Anti-TG', 'TgAb', 'Thyroglobulin Ab', 'Antithyroglobulin Ab',
      'Anti-Thyroglobulin Antibodies', 'Thyroglobulin, Antibody', 'Antithyroglobulin Antibody']),
  A('thyroglobulin', 'Thyroglobulin', '3013-0', 'ng/mL', 'thyroid',
    ['Thyroglobulin', 'Thyroglobulin, Serum', 'Thyroglobulin, Quantitative']),

  // ---------------- Vitamins ----------------
  A('vitamin_d_total', 'Vitamin D, 25-Hydroxy', '62292-8', 'ng/mL', 'vitamins',
    ['Vitamin D, 25-Hydroxy', 'Vitamin D 25-Hydroxy', '25-Hydroxyvitamin D', 'Vitamin D, 25-OH, Total', 'Vitamin D 25-OH Total', '25-OH Vitamin D',
      'Vitamin D', 'Vitamin D Total', '25(OH)D', '25-Hydroxy Vitamin D', 'Vit D, 25-Hydroxy', 'QuestAssureD 25-OH Vitamin D (D2+D3)',
      'Vitamin D 25-OH (D2+D3)', '25-OH Vitamin D (D2+D3)', 'Vitamin D, 25-OH', 'Vitamin D 25 OH', 'Vitamin D, 25-Hydroxy, Total',
      '25-Hydroxyvitamin D, Total', 'Vitamin D (25-Hydroxy)', 'Vitamin D, Total', '25-OH-D', 'Vit D 25-OH Total', 'QuestAssureD 25-OH Vit D (D2+D3)'],
    VITD),
  A('vitamin_d2', 'Vitamin D, 25-OH, D2', null, 'ng/mL', 'vitamins',
    ['Vitamin D, 25-OH, D2', 'Vitamin D 25-OH D2', '25-OH Vitamin D2', '25-Hydroxyvitamin D2', 'Vitamin D2, 25-Hydroxy', 'Vitamin D2', '25(OH)D2',
      'QuestAssureD 25-OH Vitamin D2', 'Vitamin D, 25-Hydroxy, D2'], VITD),
  A('vitamin_d3', 'Vitamin D, 25-OH, D3', '1989-3', 'ng/mL', 'vitamins',
    ['Vitamin D, 25-OH, D3', 'Vitamin D 25-OH D3', '25-OH Vitamin D3', '25-Hydroxyvitamin D3', 'Vitamin D3, 25-Hydroxy', 'Vitamin D3', '25(OH)D3',
      'QuestAssureD 25-OH Vitamin D3', 'Vitamin D, 25-Hydroxy, D3'], VITD),
  A('vitamin_d_125', 'Vitamin D, 1,25-Dihydroxy', null, 'pg/mL', 'vitamins',
    ['Vitamin D, 1,25-Dihydroxy', '1,25-Dihydroxyvitamin D', 'Vitamin D 1,25 Dihydroxy', 'Calcitriol', '1,25 Dihydroxy Vitamin D', 'Vitamin D, 1,25-OH']),
  A('vitamin_b12', 'Vitamin B12', '2132-9', 'pg/mL', 'vitamins',
    ['Vitamin B12', 'B12', 'Vitamin B-12', 'Cobalamin', 'Vit B12', 'B-12', 'Vitamin B12, Serum', 'Cyanocobalamin'], { 'pmol/L': 0.7378 }),
  A('folate', 'Folate', '2284-8', 'ng/mL', 'vitamins',
    ['Folate', 'Folate, Serum', 'Folate (Folic Acid), Serum', 'Folic Acid', 'Folate Serum', 'Serum Folate', 'Folic Acid, Serum', 'Folate (Folic Acid)'],
    { 'nmol/L': 2.266 }),
  A('folate_rbc', 'Folate, RBC', null, 'ng/mL', 'vitamins',
    ['Folate, RBC', 'RBC Folate', 'Folate RBC', 'Red Blood Cell Folate', 'Folate, Red Blood Cell'], { 'nmol/L': 2.266 }),
  A('vitamin_b6', 'Vitamin B6', null, 'ng/mL', 'vitamins',
    ['Vitamin B6', 'Vitamin B-6', 'Pyridoxal 5-Phosphate', "Pyridoxal 5'-Phosphate", 'Vitamin B6, Plasma', 'PLP', 'Pyridoxine', 'Vitamin B6 (Pyridoxine)',
      'Pyridoxal Phosphate', 'B6'], { 'nmol/L': 4.046 }),
  A('vitamin_b1', 'Vitamin B1 (Thiamine)', null, 'nmol/L', 'vitamins',
    ['Vitamin B1', 'Thiamine', 'Vitamin B1 (Thiamine)', 'Thiamin', 'Vitamin B-1', 'Thiamine, Whole Blood', 'B1']),
  A('vitamin_a', 'Vitamin A', '2923-1', 'ug/dL', 'vitamins',
    ['Vitamin A', 'Retinol', 'Vitamin A (Retinol)', 'Vitamin A, Serum', 'Retinol, Serum'], { 'umol/L': 0.0349 }),
  A('vitamin_e', 'Vitamin E', null, 'mg/L', 'vitamins',
    ['Vitamin E', 'Alpha-Tocopherol', 'Vitamin E (Alpha Tocopherol)', 'Tocopherol, Alpha', 'Alpha Tocopherol', 'Vitamin E (Tocopherol)']),
  A('vitamin_c', 'Vitamin C', null, 'mg/dL', 'vitamins',
    ['Vitamin C', 'Ascorbic Acid', 'Vitamin C (Ascorbic Acid)', 'Ascorbate', 'Vitamin C, Plasma']),
  A('vitamin_k', 'Vitamin K', null, 'ng/mL', 'vitamins',
    ['Vitamin K', 'Vitamin K1', 'Phylloquinone', 'Vitamin K1 (Phylloquinone)']),

  // ---------------- Iron ----------------
  A('ferritin', 'Ferritin', '2276-4', 'ng/mL', 'iron',
    ['Ferritin', 'Ferritin, Serum', 'Serum Ferritin'], { 'ug/L': 1, 'pmol/L': 2.247 }),
  A('iron', 'Iron', '2498-4', 'ug/dL', 'iron',
    ['Iron', 'Iron, Total', 'Iron, Serum', 'Serum Iron', 'Fe', 'Total Iron', 'Iron Serum', 'Iron Total'], UG_DL_IRON),
  A('tibc', 'TIBC', '2500-7', 'ug/dL', 'iron',
    ['Iron Bind.Cap.(TIBC)', 'TIBC', 'Iron Binding Capacity', 'Total Iron Binding Capacity', 'Iron Binding Capacity, Total', 'Iron Bind Cap TIBC',
      'TIBC (Total Iron Binding Capacity)', 'Iron Binding Capacity (TIBC)', 'Total Iron Binding Cap', 'Iron Binding Capacity, Total (TIBC)'], UG_DL_IRON),
  A('uibc', 'UIBC', '2501-5', 'ug/dL', 'iron',
    ['UIBC', 'Unsaturated Iron Binding Capacity', 'Iron Binding Capacity, Unsaturated', 'Unsat. Iron Binding Cap', 'Unsaturated Iron Binding Cap'], UG_DL_IRON),
  A('iron_saturation', 'Iron Saturation', '2502-3', '%', 'iron',
    ['Iron Saturation', '% Saturation', 'Iron Sat', 'Transferrin Saturation', 'Iron % Saturation', 'Saturation, Iron', 'Percent Saturation',
      'Iron Saturation %', 'Transferrin Sat', 'TSAT', '%SAT', 'Saturation', 'Iron, % Saturation', 'Percent Iron Saturation', 'Sat %']),
  A('transferrin', 'Transferrin', '3034-6', 'mg/dL', 'iron',
    ['Transferrin', 'Transferrin, Serum'], { 'g/L': 0.01 }),

  // ---------------- Minerals / trace ----------------
  A('magnesium', 'Magnesium', '2601-3', 'mg/dL', 'minerals',
    ['Magnesium', 'Magnesium, Serum', 'Mg', 'Magnesium Serum', 'Magnesium, Plasma'], { 'mmol/L': 0.4114, 'mEq/L': 0.8229 }),
  A('phosphorus', 'Phosphorus', '2777-1', 'mg/dL', 'minerals',
    ['Phosphorus', 'Phosphorus, Serum', 'Phosphate', 'Phos', 'Phosphorus Serum', 'Phosphorus (Inorganic)', 'Phosphate (as Phosphorus)',
      'Inorganic Phosphorus', 'Phosphorus, Inorganic'], { 'mmol/L': 0.3229 }),
  A('uric_acid', 'Uric Acid', '3084-1', 'mg/dL', 'minerals',
    ['Uric Acid', 'Uric Acid, Serum', 'Urate', 'Uric Acid Serum'], { 'umol/L': 59.48 }),
  A('calcium_ionized', 'Calcium, Ionized', null, 'mg/dL', 'minerals',
    ['Calcium, Ionized', 'Ionized Calcium', 'Calcium Ionized', 'Ca, Ionized', 'Free Calcium', 'Calcium, Ionized, Serum', 'Ionized Ca'], { 'mmol/L': 0.2495 }),
  A('zinc', 'Zinc', '5763-8', 'ug/dL', 'minerals',
    ['Zinc', 'Zinc, Plasma or Serum', 'Zinc, Serum', 'Zinc, Plasma', 'Zn', 'Zinc, Serum or Plasma'], { 'umol/L': 0.153 }),
  A('copper', 'Copper', '5631-7', 'ug/dL', 'minerals',
    ['Copper', 'Copper, Serum', 'Copper, Serum or Plasma', 'Copper, Plasma', 'Cu'], { 'umol/L': 0.157 }),
  A('selenium', 'Selenium', null, 'ug/L', 'minerals',
    ['Selenium', 'Selenium, Serum', 'Selenium, Serum/Plasma', 'Selenium, Blood', 'Se', 'Selenium, Whole Blood', 'Selenium, Plasma']),
  A('iodine', 'Iodine', null, 'ug/L', 'minerals',
    ['Iodine', 'Iodine, Serum', 'Iodine, Serum/Plasma']),

  // ---------------- Heavy metals ----------------
  A('lead', 'Lead, Blood', '5671-3', 'ug/dL', 'heavy_metals',
    ['Lead', 'Lead, Blood', 'Blood Lead', 'Lead (Venous)', 'Pb', 'Lead, Blood (Venous)', 'Lead, Whole Blood', 'Lead, Venous Blood', 'Lead Level'],
    { 'umol/L': 0.0483 }),
  A('mercury', 'Mercury, Blood', '5685-3', 'ug/L', 'heavy_metals',
    ['Mercury', 'Mercury, Blood', 'Blood Mercury', 'Hg', 'Mercury, Whole Blood'], { 'nmol/L': 4.985 }),
  A('arsenic', 'Arsenic, Blood', null, 'ug/L', 'heavy_metals',
    ['Arsenic', 'Arsenic, Blood', 'Arsenic, Whole Blood', 'As']),
  A('cadmium', 'Cadmium, Blood', null, 'ug/L', 'heavy_metals',
    ['Cadmium', 'Cadmium, Blood', 'Cadmium, Whole Blood', 'Cd']),
  A('aluminum', 'Aluminum', null, 'ug/L', 'heavy_metals',
    ['Aluminum', 'Aluminum, Serum', 'Aluminium', 'Al']),

  // ---------------- Inflammation / immunology ----------------
  A('crp', 'C-Reactive Protein', '1988-5', 'mg/L', 'inflammation',
    ['CRP', 'C-Reactive Protein', 'C-Reactive Protein, Quant', 'C Reactive Protein', 'CRP, Quantitative', 'C-Reactive Protein Quant', 'C-Reactive Protein (CRP)'],
    { 'mg/dL': 0.1 }),
  A('hs_crp', 'hs-CRP', '30522-7', 'mg/L', 'inflammation',
    ['hs-CRP', 'hsCRP', 'High Sensitivity CRP', 'C-Reactive Protein, Cardiac', 'CRP, High Sensitivity', 'C-Reactive Protein, High Sensitivity', 'Cardio CRP',
      'hs CRP', 'High-Sensitivity C-Reactive Protein', 'CRP, Cardiac', 'C-Reactive Protein (CRP), High Sensitivity', 'hs-CRP (Cardio)', 'Cardiac CRP',
      'C-Reactive Protein, hs', 'hsCRP (Cardiac)', 'High Sensitivity C-Reactive Protein'], { 'mg/dL': 0.1 }),
  A('esr', 'Sedimentation Rate (ESR)', null, 'mm/hr', 'inflammation',
    ['Sedimentation Rate-Westergren', 'ESR', 'Sed Rate', 'Erythrocyte Sedimentation Rate', 'Sedimentation Rate', 'Sed Rate, Westergren',
      'Sedimentation Rate, Westergren', 'ESR, Westergren', 'Sed Rate by Modified Westergren', 'Sedimentation Rate, Erythrocyte', 'Sed Rate (ESR)',
      'ESR (Sedimentation Rate)']),
  A('rf', 'Rheumatoid Factor', '11572-5', 'IU/mL', 'autoimmune',
    ['RA Latex Turb.', 'Rheumatoid Factor', 'RF', 'Rheumatoid Factor, Quant', 'RA Factor', 'Rheumatoid Factor (RF)', 'RA Latex Turbidimetric', 'RA Latex Turb',
      'Rheumatoid Factor, Quantitative']),
  A('ana', 'ANA Screen', null, null, 'autoimmune',
    ['ANA', 'ANA Screen', 'Antinuclear Antibodies', 'ANA Screen, IFA', 'Antinuclear Ab', 'ANA Direct', 'ANA Screen IFA', 'Antinuclear Antibody',
      'ANA Screen, IFA, w/Reflex', 'Antinuclear Antibodies Screen', 'ANA w/Reflex', 'Antinuclear Antibodies, IFA']),
  A('ana_titer', 'ANA Titer', null, 'titer', 'autoimmune',
    ['ANA Titer', 'ANA Titer, IFA', 'Antinuclear Antibodies Titer', 'ANA Titer IFA', 'Antinuclear Antibody Titer']),
  A('ana_pattern', 'ANA Pattern', null, null, 'autoimmune',
    ['ANA Pattern', 'ANA Pattern, IFA', 'ANA Pattern IFA', 'Antinuclear Antibody Pattern']),
  A('celiac_ttg_iga', 'Tissue Transglutaminase IgA', '31017-7', 'U/mL', 'autoimmune',
    ['t-Transglutaminase (tTG) IgA', 'tTG IgA', 'Tissue Transglutaminase IgA', 'Tissue Transglutaminase Ab, IgA', 'Transglutaminase IgA', 'tTG-IgA',
      'Celiac tTG IgA', 'Tissue Transglutaminase (tTG) Ab, IgA', 'tTG Ab, IgA', 't-Transglutaminase IgA', 'Tissue Transglutaminase Antibody, IgA',
      'tTG IgA Ab', 'Transglutaminase IgA Antibody', 'tTG Antibody, IgA', 'Tissue Transglutaminase, IgA']),
  A('celiac_ttg_igg', 'Tissue Transglutaminase IgG', null, 'U/mL', 'autoimmune',
    ['t-Transglutaminase (tTG) IgG', 'tTG IgG', 'Tissue Transglutaminase IgG', 'Tissue Transglutaminase Ab, IgG', 'Transglutaminase IgG', 'tTG-IgG',
      'Tissue Transglutaminase (tTG) Ab, IgG', 'tTG Ab, IgG', 'Tissue Transglutaminase Antibody, IgG', 'Tissue Transglutaminase, IgG']),
  A('endomysial_iga', 'Endomysial Antibody IgA', null, null, 'autoimmune',
    ['Endomysial Antibody IgA', 'Endomysial Ab IgA', 'Endomysial Antibodies, IgA', 'EMA IgA', 'Endomysial Ab, IgA', 'Endomysial Antibody (IgA) Screen']),
  A('iga_total', 'Immunoglobulin A', '2458-8', 'mg/dL', 'autoimmune',
    ['Immunoglobulin A, Qn, Serum', 'IgA', 'Immunoglobulin A', 'Total IgA', 'IgA, Serum', 'Immunoglobulin A (IgA)', 'IgA, Total', 'Immunoglobulin A, Quantitative',
      'IgA Total', 'Immunoglobulin A, Serum', 'Immunoglobulin A (IgA), Serum'], { 'g/L': 0.01 }),
  A('igg_total', 'Immunoglobulin G', '2465-3', 'mg/dL', 'autoimmune',
    ['Immunoglobulin G, Qn, Serum', 'IgG', 'Immunoglobulin G', 'Total IgG', 'IgG, Serum', 'Immunoglobulin G (IgG)', 'IgG, Total', 'Immunoglobulin G, Quantitative'],
    { 'g/L': 0.01 }),
  A('igm_total', 'Immunoglobulin M', '2472-9', 'mg/dL', 'autoimmune',
    ['Immunoglobulin M, Qn, Serum', 'IgM', 'Immunoglobulin M', 'Total IgM', 'IgM, Serum', 'Immunoglobulin M (IgM)', 'IgM, Total', 'Immunoglobulin M, Quantitative'],
    { 'g/L': 0.01 }),
  A('ige_total', 'Immunoglobulin E, Total', '19113-0', 'IU/mL', 'autoimmune',
    ['IgE, Total', 'Immunoglobulin E', 'IgE', 'Total IgE', 'Immunoglobulin E, Total', 'IgE Total', 'Immunoglobulin E (IgE), Total', 'Immunoglobulin E, Qn, Serum']),

  // ---------------- Prostate / tumor markers ----------------
  A('psa_total', 'PSA, Total', '2857-1', 'ng/mL', 'prostate',
    ['PSA, Total', 'PSA', 'Prostate Specific Ag, Serum', 'Prostate Specific Antigen', 'Prostate-Specific Antigen', 'PSA Total', 'Total PSA', 'PSA, Serum',
      'Prostate Specific Ag', 'PSA (Prostate Specific Antigen)', 'Prostate Specific Antigen, Total', 'PSA Screen', 'PSA, Total (Screen)'], { 'ug/L': 1 }),
  A('psa_free', 'PSA, Free', '10886-0', 'ng/mL', 'prostate',
    ['PSA, Free', 'Free PSA', 'PSA Free', 'Prostate Specific Ag, Free', 'Prostate Specific Antigen, Free', 'PSA, Free, Serum'], { 'ug/L': 1 }),
  A('psa_free_pct', '% Free PSA', null, '%', 'prostate',
    ['PSA, Free Percent', 'Percent Free PSA', 'Free PSA Ratio', 'PSA Free/Total Ratio', 'PSA, Free/Total',
      'Free PSA, Percent', 'PSA, Percent Free', 'Free/Total PSA Ratio']),
  A('cea', 'CEA', '2039-6', 'ng/mL', 'tumor_markers',
    ['CEA', 'Carcinoembryonic Antigen', 'Carcinoembryonic Ag', 'CEA, Serum', 'Carcinoembryonic Antigen (CEA)'], { 'ug/L': 1 }),
  A('ca125', 'CA 125', '10334-1', 'U/mL', 'tumor_markers',
    ['CA 125', 'CA-125', 'Cancer Antigen 125', 'CA125', 'Cancer Antigen (CA) 125']),
  A('ca19_9', 'CA 19-9', '24108-3', 'U/mL', 'tumor_markers',
    ['CA 19-9', 'CA19-9', 'Cancer Antigen 19-9', 'Cancer Antigen (CA) 19-9']),
  A('afp', 'Alpha-Fetoprotein', '1834-1', 'ng/mL', 'tumor_markers',
    ['AFP', 'Alpha-Fetoprotein', 'Alpha Fetoprotein', 'AFP, Serum', 'AFP Tumor Marker', 'Alpha-Fetoprotein, Serum, Tumor Marker', 'AFP, Tumor Marker',
      'Alpha-Fetoprotein (AFP), Tumor Marker'], { 'ug/L': 1 }),

  // ---------------- Hormones / endocrine ----------------
  A('cortisol', 'Cortisol', '2143-6', 'ug/dL', 'hormones',
    ['Cortisol', 'Cortisol, Total', 'Cortisol, Serum', 'Cortisol Total', 'Cortisol, Random', 'Cortisol, Total, Serum'], { 'nmol/L': 27.59 }),
  A('cortisol_am', 'Cortisol - AM', null, 'ug/dL', 'hormones',
    ['Cortisol - AM', 'Cortisol, AM', 'Cortisol AM', 'AM Cortisol', 'Cortisol, Morning', 'Cortisol, 8 AM', 'Cortisol, A.M.', 'Cortisol-AM', 'Cortisol (AM)',
      'Cortisol, Total, AM'], { 'nmol/L': 27.59 }),
  A('cortisol_pm', 'Cortisol - PM', null, 'ug/dL', 'hormones',
    ['Cortisol - PM', 'Cortisol, PM', 'Cortisol PM', 'PM Cortisol', 'Cortisol, Afternoon', 'Cortisol, 4 PM', 'Cortisol, P.M.', 'Cortisol-PM', 'Cortisol (PM)',
      'Cortisol, Total, PM'], { 'nmol/L': 27.59 }),
  A('testosterone_total', 'Testosterone, Total', '2986-8', 'ng/dL', 'hormones',
    ['Testosterone', 'Testosterone, Total', 'Total Testosterone', 'Testosterone Total', 'Testosterone, Serum', 'Testosterone, Total, LC/MS',
      'Testosterone,Total,LC/MS', 'Testosterone, Total, MS', 'Testosterone, Total, LC/MS-MS', 'Testosterone, Total, LC/MS/MS', 'Testosterone Total LC/MS'],
    { 'nmol/L': 0.0347 }),
  A('testosterone_free', 'Testosterone, Free', '2991-8', 'pg/mL', 'hormones',
    ['Testosterone, Free', 'Free Testosterone', 'Testosterone Free', 'Free Testosterone(Direct)', 'Free Testosterone (Direct)', 'Testosterone, Free, Direct',
      'Testosterone, Free (Direct)', 'Testosterone,Free'], { 'pmol/L': 3.47 }),
  A('testosterone_bioavailable', 'Testosterone, Bioavailable', null, 'ng/dL', 'hormones',
    ['Testosterone, Bioavailable', 'Bioavailable Testosterone', 'Testosterone Bioavailable', 'Testosterone, Bioavail', 'Testosterone,Bioavailable'],
    { 'nmol/L': 0.0347 }),
  A('shbg', 'Sex Hormone Binding Globulin', '13967-5', 'nmol/L', 'hormones',
    ['Sex Horm Binding Glob, Serum', 'SHBG', 'Sex Hormone Binding Globulin', 'Sex Hormone-Binding Globulin', 'Sex Horm Binding Glob', 'Sex Hormone Binding Glob',
      'Sex Hormone Binding Globulin (SHBG)']),
  A('estradiol', 'Estradiol', '2243-4', 'pg/mL', 'hormones',
    ['Estradiol', 'E2', 'Estradiol, Serum', 'Estradiol (E2)', 'Estradiol, Sensitive', 'Estradiol, Ultrasensitive', 'Estradiol, Sensitive, LC/MS',
      'Estradiol, Ultrasensitive, LC/MS', 'Estradiol, Ultra Sensitive'], { 'pmol/L': 3.671 }),
  A('estrone', 'Estrone', null, 'pg/mL', 'hormones',
    ['Estrone', 'Estrone (E1)', 'E1', 'Estrone, Serum', 'Estrone, LC/MS']),
  A('progesterone', 'Progesterone', '2839-9', 'ng/mL', 'hormones',
    ['Progesterone', 'Progesterone, Serum'], { 'nmol/L': 3.18 }),
  A('lh', 'LH', '10501-5', 'mIU/mL', 'hormones',
    ['LH', 'Luteinizing Hormone', 'Luteinizing Hormone (LH)', 'LH, Serum', 'Luteinizing Hormone(LH), S', 'Luteinizing Hormone (LH), Serum', 'Lutropin'],
    { 'IU/L': 1 }),
  A('fsh', 'FSH', '15067-2', 'mIU/mL', 'hormones',
    ['FSH', 'Follicle Stimulating Hormone', 'Follicle-Stimulating Hormone', 'FSH, Serum', 'Follicle Stimulating Hormone (FSH)', 'Follitropin',
      'Follicle Stimulating Hormone (FSH), Serum'], { 'IU/L': 1 }),
  A('prolactin', 'Prolactin', '2842-3', 'ng/mL', 'hormones',
    ['Prolactin', 'Prolactin, Serum', 'PRL'], { 'ug/L': 1 }),
  A('dhea_s', 'DHEA-Sulfate', '2191-5', 'ug/dL', 'hormones',
    ['DHEA-Sulfate', 'DHEA-S', 'DHEA Sulfate', 'Dehydroepiandrosterone Sulfate', 'DHEAS', 'DHEA-SO4', 'Dehydroepiandrosterone (DHEA) Sulfate',
      'DHEA Sulfate, Serum', 'DHEA-S, Serum'], { 'umol/L': 0.02714 }),
  A('dhea', 'DHEA', null, 'ng/dL', 'hormones',
    ['DHEA', 'Dehydroepiandrosterone', 'DHEA, Unconjugated', 'DHEA, Serum', 'Dehydroepiandrosterone (DHEA)']),
  A('igf1', 'IGF-1', '2484-4', 'ng/mL', 'endocrine',
    ['IGF-1', 'Insulin-Like Growth Factor I', 'IGF-I', 'Insulin-Like Growth Factor 1', 'Insulin Like Growth Factor I', 'IGF 1', 'Somatomedin C',
      'Insulin-Like Growth Factor-1', 'IGF-1, LC/MS', 'Insulin-Like Growth Factor-I'], { 'nmol/L': 0.131 }),
  A('growth_hormone', 'Growth Hormone', '2963-7', 'ng/mL', 'endocrine',
    ['Growth Hormone', 'GH', 'Human Growth Hormone', 'HGH', 'Growth Hormone (GH)', 'Somatotropin', 'Growth Hormone, Serum'], { 'ug/L': 1 }),
  A('pth', 'Parathyroid Hormone, Intact', '2731-8', 'pg/mL', 'endocrine',
    ['PTH, Intact', 'Parathyroid Hormone', 'PTH', 'Parathyroid Hormone, Intact', 'Intact PTH', 'PTH Intact', 'Parathyroid Hormone (PTH), Intact',
      'PTH, Intact and Calcium', 'Parathyroid Hormone, Intact (PTH)', 'PTH Intact, Serum'], { 'ng/L': 1, 'pmol/L': 0.1053 }),
  A('acth', 'ACTH', null, 'pg/mL', 'endocrine',
    ['ACTH', 'Adrenocorticotropic Hormone', 'ACTH, Plasma', 'Corticotropin', 'Adrenocorticotropic Hormone (ACTH)'], { 'pmol/L': 0.2202 }),
  A('aldosterone', 'Aldosterone', null, 'ng/dL', 'endocrine',
    ['Aldosterone', 'Aldosterone, Serum', 'Aldosterone, LC/MS']),
  A('renin', 'Renin Activity', null, 'ng/mL/hr', 'endocrine',
    ['Renin', 'Renin Activity', 'Renin Activity, Plasma', 'Plasma Renin Activity', 'PRA', 'Renin, Plasma Activity', 'Renin, Direct']),
  A('amh', 'Anti-Mullerian Hormone', null, 'ng/mL', 'hormones',
    ['Anti-Mullerian Hormone', 'AMH', 'Anti-Müllerian Hormone', 'AMH (Anti-Mullerian Hormone)', 'Antimullerian Hormone', 'Anti-Mullerian Hormone (AMH)',
      'Mullerian Inhibiting Substance']),
  A('hcg_quant', 'hCG, Quantitative', '19080-1', 'mIU/mL', 'pregnancy',
    ['hCG, Total, Quantitative', 'hCG, Beta Subunit, Quant', 'hCG Quantitative', 'Beta hCG, Quantitative', 'hCG, Quantitative', 'HCG, Total, Quantitative',
      'Beta-hCG', 'hCG, Beta Subunit', 'Human Chorionic Gonadotropin, Quant', 'hCG Beta Subunit Quant', 'hCG, Beta Chain, Quant', 'B-hCG, Quantitative',
      'hCG Total, Quantitative', 'Beta hCG Quant', 'hCG, Quant', 'HCG, Beta Subunit, Quant'], { 'IU/L': 1 }),
  A('hcg_qual', 'hCG, Qualitative', null, null, 'pregnancy',
    ['hCG, Qualitative', 'hCG, Serum, Qualitative', 'Pregnancy Test, Serum', 'Pregnancy Test', 'hCG Qualitative', 'HCG, Qualitative', 'hCG, Urine, Qualitative',
      'Pregnancy Test, Urine', 'hCG, Qual', 'Beta hCG, Qualitative', 'hCG, Serum, Qual', 'Pregnancy Test, Urine, Qualitative']),

  // ---------------- Liver / pancreas / muscle / misc chemistry ----------------
  A('ggt', 'GGT', '2324-2', 'IU/L', 'liver',
    ['GGT', 'Gamma Glutamyl Transferase', 'Gamma-Glutamyl Transferase', 'Gamma GT', 'GGTP', 'Gamma Glutamyltransferase', 'Gamma-Glutamyl Transpeptidase',
      'Gamma Glutamyl Transpeptidase', 'Gamma-Glutamyltransferase'], IU_U),
  A('ldh', 'LDH', '2532-0', 'IU/L', 'liver',
    ['LDH', 'Lactate Dehydrogenase', 'LD', 'Lactic Acid Dehydrogenase', 'Lactate Dehydrogenase (LD)', 'Lactate Dehydrogenase (LDH)', 'LDH, Serum'], IU_U),
  A('amylase', 'Amylase', '1798-8', 'IU/L', 'pancreas',
    ['Amylase', 'Amylase, Serum', 'Amylase Serum', 'Amylase, Total'], IU_U),
  A('lipase', 'Lipase', '3040-3', 'IU/L', 'pancreas',
    ['Lipase', 'Lipase, Serum', 'Lipase Serum'], IU_U),
  A('ck', 'Creatine Kinase, Total', '2157-6', 'IU/L', 'muscle',
    ['Creatine Kinase,Total', 'CK', 'CPK', 'Creatine Kinase', 'Creatine Kinase, Total', 'Creatine Phosphokinase', 'CK, Total', 'Total CK', 'CK Total',
      'Creatine Kinase (CK), Total', 'CPK, Total'], IU_U),
  A('ck_mb', 'CK-MB', null, 'ng/mL', 'cardiac',
    ['CK-MB', 'CK MB', 'Creatine Kinase MB', 'CK-MB, Mass', 'CKMB', 'Creatine Kinase, MB', 'CK-MB Mass']),
  A('ammonia', 'Ammonia', null, 'umol/L', 'liver',
    ['Ammonia', 'Ammonia, Plasma', 'NH3', 'Ammonia Plasma']),
  A('lactate', 'Lactic Acid', null, 'mmol/L', 'chemistry',
    ['Lactate', 'Lactic Acid', 'Lactic Acid, Plasma', 'Lactate, Plasma', 'Lactic Acid Plasma'], { 'mg/dL': 9.008 }),
  A('homocysteine', 'Homocysteine', '13965-9', 'umol/L', 'cardiac',
    ['Homocysteine', 'Homocyst(e)ine', 'Homocysteine, Plasma', 'Homocysteine, Serum', 'Homocysteine, Total', 'HCY', 'Homocysteine Plasma', 'Total Homocysteine'],
    { 'mg/L': 0.1352 }),
  A('cystatin_c', 'Cystatin C', null, 'mg/L', 'kidney',
    ['Cystatin C', 'Cystatin-C', 'Cystatin C, Serum', 'Cystatin C with eGFR', 'Cystatin C, Serum/Plasma']),
  A('egfr_cystatin', 'eGFR (Cystatin C)', null, 'mL/min/1.73m2', 'kidney',
    ['eGFR, Cystatin C', 'eGFR (Cystatin C)', 'eGFR Cystatin C', 'Estimated GFR, Cystatin C', 'eGFR, Creatinine-Cystatin C', 'eGFR Cystatin-C',
      'eGFR (Cystatin C) CKD-EPI 2012', 'eGFR by Cystatin C']),
  A('anion_gap', 'Anion Gap', null, 'mmol/L', 'cmp',
    ['Anion Gap', 'AGAP', 'Anion Gap, Serum', 'Anion Gap (calculated)', 'Anion Gap, Calculated'], { 'mEq/L': 1 }),
  A('osmolality', 'Osmolality', null, 'mOsm/kg', 'chemistry',
    ['Osmolality', 'Osmolality, Serum', 'Serum Osmolality', 'Osmolality, Calculated', 'Osmolality (Calculated)', 'Osmolality, Plasma']),

  // ---------------- Kidney / urine chemistries ----------------
  A('microalbumin_creat_ratio', 'Microalbumin/Creatinine Ratio', '14959-1', 'mg/g', 'kidney',
    ['Microalb/Creat Ratio', 'Microalbumin/Creatinine Ratio', 'Albumin/Creatinine Ratio', 'Microalbumin/Creatinine Ratio, Random Urine', 'ACR',
      'Microalbumin/Creat Ratio', 'Microalb/Creat Ratio, Urine', 'Albumin/Creatinine Ratio, Urine', 'Urine Albumin/Creatinine Ratio', 'UACR',
      'Microalbumin, Ur/Creat Ratio', 'Microalbumin / Creatinine Ratio', 'Microalbumin/Creatinine Ratio, Urine', 'Microalbumin/Creat Ratio, Random Urine',
      'Microalb/Creat Ratio, Random Urine', 'Albumin/Creatinine Ratio, Random Urine', 'Alb/Creat Ratio', 'Microalbumin:Creatinine Ratio',
      'Microalbumin, Urine/Creatinine Ratio'], { 'mg/mmol': 0.1131 }),
  A('microalbumin_urine', 'Microalbumin, Urine', null, 'mg/L', 'kidney',
    ['Microalbumin, Random Urine', 'Microalbumin, Urine', 'Microalbumin', 'Albumin, Urine', 'Urine Microalbumin', 'Microalbumin, Ur', 'Microalbumin, Ur, Random',
      'Urine Albumin', 'Albumin, Random Urine', 'Microalbumin, Random Ur', 'Microalbumin, Urine, Random', 'Microalbumin, Ur, Rndm']),
  A('creatinine_urine', 'Creatinine, Urine', '2161-8', 'mg/dL', 'kidney',
    ['Creatinine, Random Urine', 'Creatinine, Urine', 'Urine Creatinine', 'Creatinine, Ur', 'Creatinine, Ur, Random', 'Creatinine, Random Ur', 'Creatinine (Urine)',
      'Creatinine, Urine, Random', 'Creatinine, Ur, Rndm', 'Creatinine, Random Ur, Rndm'], { 'mmol/L': 0.0884 }),
  A('protein_urine_quant', 'Protein, Urine (Quantitative)', null, 'mg/dL', 'kidney',
    ['Protein, Random Urine', 'Protein, Urine, Quantitative', 'Urine Protein, Quantitative', 'Protein, Ur, Random', 'Total Protein, Urine', 'Protein, Total, Urine',
      'Protein, Quantitative, Urine', 'Protein, Random Ur', 'Protein Quant, Urine', 'Protein, Qn, Urine']),
  A('protein_creat_ratio', 'Protein/Creatinine Ratio', null, 'mg/g', 'kidney',
    ['Protein/Creatinine Ratio', 'Protein/Creat Ratio', 'Urine Protein/Creatinine Ratio', 'UPCR', 'Protein/Creatinine Ratio, Urine', 'Prot/Creat Ratio',
      'Protein/Creatinine Ratio, Random Urine', 'Protein:Creatinine Ratio'], { 'mg/mmol': 0.1131 }),

  // ---------------- Urinalysis (dipstick / macroscopic / microscopic) ----------------
  A('urine_color', 'Color, Urine', '5778-6', null, 'urinalysis',
    ['Color', 'Urine Color', 'Color, Urine', 'Color, UA', 'Urine-Color', 'Color, Ur', 'Colour']),
  A('urine_appearance', 'Appearance, Urine', '5767-9', null, 'urinalysis',
    ['Appearance', 'Urine Appearance', 'Appearance, Urine', 'Clarity', 'Urine Clarity', 'Clarity, Urine', 'Appearance, UA', 'Appearance, Ur', 'Urine-Appearance',
      'Clarity, UA', 'Turbidity']),
  A('urine_specific_gravity', 'Specific Gravity, Urine', '5811-5', null, 'urinalysis',
    ['Specific Gravity', 'Specific Gravity, Urine', 'Urine Specific Gravity', 'Sp. Gravity', 'SG', 'Spec Gravity', 'Specific Gravity, UA', 'Specific Gravity, Ur',
      'Sp Gr', 'Sp Gravity', 'Urine-Specific Gravity', 'Specific Gravity, Refractometer']),
  A('urine_ph', 'pH, Urine', '5803-2', null, 'urinalysis',
    ['pH', 'Urine pH', 'pH, Urine', 'pH, UA', 'pH, Ur', 'Urine-pH']),
  A('urine_glucose', 'Glucose, Urine', '5792-7', null, 'urinalysis',
    ['Glucose, Urine', 'Urine Glucose', 'Glucose, UA', 'Glucose, Ur', 'Glucose, Urinalysis', 'Glucose (UA)', 'Urine-Glucose', 'Glucose Qual, Urine',
      'Glucose, Qual, Urine', 'Glucose, Qualitative, Urine', 'Glucose, Qual', 'Glucose, Urine, Qualitative']),
  A('urine_bilirubin', 'Bilirubin, Urine', '5770-3', null, 'urinalysis',
    ['Bilirubin, Urine', 'Urine Bilirubin', 'Bilirubin, UA', 'Bilirubin, Ur', 'Bilirubin (UA)', 'Urine-Bilirubin', 'Bilirubin, Qual, Urine', 'Bilirubin Qual, Urine',
      'Bilirubin, Urine, Qualitative']),
  A('urine_ketones', 'Ketones, Urine', '5797-6', null, 'urinalysis',
    ['Ketones', 'Ketones, Urine', 'Urine Ketones', 'Ketones, UA', 'Ketones, Ur', 'Ketone', 'Ketones (UA)', 'Urine-Ketones', 'Ketones, Qual, Urine', 'Ketones Qual, Urine',
      'Ketones, Urine, Qualitative', 'Acetone, Urine']),
  A('urine_blood', 'Blood, Urine', '5794-3', null, 'urinalysis',
    ['Blood', 'Occult Blood', 'Blood, Urine', 'Urine Blood', 'Blood, UA', 'Blood, Ur', 'Occult Blood, Urine', 'Hemoglobin, Urine', 'Blood (UA)', 'Urine-Blood',
      'Hgb, Urine', 'Blood, Qual, Urine', 'Occult Blood, UA', 'Hemoglobin, Qual, Urine', 'Blood, Urine, Qualitative']),
  A('urine_protein', 'Protein, Urine', '5804-0', null, 'urinalysis',
    ['Protein, Urine', 'Urine Protein', 'Protein, UA', 'Protein, Ur', 'Protein (UA)', 'Urine-Protein', 'Protein Qual, Urine', 'Protein, Qual, Urine',
      'Protein, Qualitative, Urine', 'Protein, Qual', 'Protein, Urine, Qualitative', 'Albumin, Qual, Urine']),
  A('urine_urobilinogen', 'Urobilinogen, Urine', null, 'mg/dL', 'urinalysis',
    ['Urobilinogen', 'Urobilinogen, Urine', 'Urobilinogen,Semi-Qn', 'Urobilinogen, Semi-Qn', 'Urine Urobilinogen', 'Urobilinogen, UA', 'Urobilinogen, Ur',
      'Urobilinogen (UA)', 'Urine-Urobilinogen', 'Urobilinogen, Semi-Quantitative', 'Urobilinogen Semi-Qn']),
  A('urine_nitrite', 'Nitrite, Urine', '5802-4', null, 'urinalysis',
    ['Nitrite', 'Nitrite, Urine', 'Urine Nitrite', 'Nitrite, UA', 'Nitrite, Ur', 'Nitrites', 'Nitrite (UA)', 'Urine-Nitrite', 'Nitrite, Qual, Urine',
      'Nitrite, Urine, Qualitative']),
  A('urine_leukocyte_esterase', 'Leukocyte Esterase, Urine', '5799-2', null, 'urinalysis',
    ['Leukocytes', 'Leukocyte Esterase', 'Leukocyte Esterase, Urine', 'Leuk Esterase', 'Leukocytes, Urine', 'Leukocyte Esterase, UA', 'Leukocyte Esterase, Ur',
      'Leukocytes (UA)', 'Urine-Leukocyte Esterase', 'Leukocytes Esterase', 'Leuk Esterase, UA', 'Leukocyte Esterase (UA)', 'Leukocytes (Esterase)',
      'Leukocyte Est', 'Leuk Est', 'Leukocyte Esterase, Qual, Urine', 'WBC Esterase']),
  A('urine_rbc', 'RBC, Urine', '13945-1', '/HPF', 'urinalysis',
    ['RBC, Urine', 'RBC/HPF', 'Urine RBC', 'RBC, UA', 'Red Blood Cells, Urine', 'RBC (Urine)', 'RBC, Ur', 'RBCs, Urine', 'Red Blood Cells, UA', 'Urine-RBC',
      'Microscopic RBC', 'RBC, Microscopic', 'RBC, UA Microscopic', 'Red Blood Cells (RBC), Urine', 'RBC/hpf, Urine', 'Erythrocytes, Urine']),
  A('urine_wbc', 'WBC, Urine', '5821-4', '/HPF', 'urinalysis',
    ['WBC, Urine', 'WBC/HPF', 'Urine WBC', 'WBC, UA', 'White Blood Cells, Urine', 'WBC (Urine)', 'WBC, Ur', 'WBCs, Urine', 'White Blood Cells, UA', 'Urine-WBC',
      'Microscopic WBC', 'WBC, Microscopic', 'WBC, UA Microscopic', 'White Blood Cells (WBC), Urine', 'WBC/hpf, Urine', 'Leukocytes, Urine, Microscopic']),
  A('urine_bacteria', 'Bacteria, Urine', null, '/HPF', 'urinalysis',
    ['Bacteria', 'Bacteria, Urine', 'Urine Bacteria', 'Bacteria, UA', 'Bacteria, Ur', 'Bacteria (UA)', 'Urine-Bacteria', 'Bacteria, Microscopic',
      'Bacteria, UA Microscopic']),
  A('urine_epithelial', 'Epithelial Cells, Urine', null, '/HPF', 'urinalysis',
    ['Epithelial Cells', 'Epithelial Cells (non renal)', 'Epithelial Cells, Urine', 'Squamous Epithelial Cells', 'Epithelial Cells, Non Renal', 'Epi Cells',
      'Epithelial Cells, UA', 'Squamous Epithelial', 'Urine-Epithelial Cells', 'Squamous Epithelial Cells, UA', 'Epithelial Cells, Non-Renal',
      'Squamous Epithelial Cells, Urine', 'Epithelial Cells (Non-Renal)', 'Epithelial Cells, Microscopic', 'Epith Cells']),
  A('urine_casts', 'Casts, Urine', null, '/LPF', 'urinalysis',
    ['Casts', 'Casts, Urine', 'Hyaline Casts', 'Urine Casts', 'Casts, UA', 'Hyaline Casts, Urine', 'Casts, Microscopic', 'Granular Casts']),
  A('urine_crystals', 'Crystals, Urine', null, null, 'urinalysis',
    ['Crystals', 'Crystals, Urine', 'Urine Crystals', 'Crystals, UA', 'Crystals, Microscopic']),
  A('urine_mucus', 'Mucus, Urine', null, null, 'urinalysis',
    ['Mucus', 'Mucus, Urine', 'Mucus, UA', 'Mucous', 'Mucus Threads', 'Mucus, Microscopic', 'Urine Mucus']),
  A('urine_yeast', 'Yeast, Urine', null, null, 'urinalysis',
    ['Yeast', 'Yeast, Urine', 'Yeast, UA', 'Urine Yeast', 'Yeast, Microscopic', 'Budding Yeast']),

  // ---------------- Infectious disease screens (text results) ----------------
  A('hbsag', 'Hepatitis B Surface Antigen', '5196-1', null, 'infectious',
    ['Hepatitis B Surface Ag', 'HBsAg', 'Hepatitis B Surface Antigen', 'Hep B Surface Ag', 'HBV Surface Antigen', 'Hepatitis B Surface Antigen (HBsAg)',
      'Hep B Surface Ag, Qual', 'Hepatitis B Surface Ag, Qualitative', 'Hepatitis B Surface Antigen, Qualitative', 'HBs Ag', 'Hep B Surface Antigen',
      'Hepatitis B Surface Ag w/Reflex', 'Hepatitis B Surface Antigen w/Reflex Confirmation']),
  A('hbsab', 'Hepatitis B Surface Antibody', null, 'mIU/mL', 'infectious',
    ['Hepatitis B Surface Ab', 'Hep B Surface Ab', 'HBsAb', 'Hepatitis B Surface Antibody', 'Anti-HBs', 'Hep B Surface Ab, Quant', 'Hep B Surface Ab, Qual',
      'Hepatitis B Surface Ab, Quantitative', 'Hepatitis B Surface Antibody, Quantitative', 'HBV Surface Antibody', 'Hep B Surface Ab, Qn',
      'Hepatitis B Surface Ab, Qual', 'Hep B Surface Ab Quant', 'Hep B Surface Ab Qual', 'Hepatitis B Surface Antibody, Qualitative', 'HBs Ab',
      'Hepatitis B Surface Ab, Immunity', 'Hep B Surface Antibody', 'Anti-HBs, Quantitative', 'Hepatitis B Surface Antibody, Qn'], { 'IU/L': 1 }),
  A('hbcab', 'Hepatitis B Core Antibody, Total', null, null, 'infectious',
    ['Hepatitis B Core Ab, Tot', 'Hepatitis B Core Antibody', 'Hep B Core Ab, Total', 'HBcAb', 'Anti-HBc', 'Hepatitis B Core Ab, Total', 'Hepatitis B Core Antibody, Total',
      'Hep B Core Ab, Tot', 'HBV Core Antibody, Total', 'Hepatitis B Core Ab', 'Hep B Core Ab', 'Hepatitis B Core Total Antibody', 'HBc Ab, Total',
      'Hepatitis B Core Antibody, Total (IgG+IgM)']),
  A('hbcab_igm', 'Hepatitis B Core Antibody, IgM', null, null, 'infectious',
    ['Hepatitis B Core Ab, IgM', 'Hep B Core Ab, IgM', 'HBcAb IgM', 'Anti-HBc IgM', 'Hepatitis B Core Antibody, IgM', 'Hepatitis B Core IgM', 'HBc IgM']),
  A('hbeag', 'Hepatitis B e Antigen', null, null, 'infectious',
    ['Hepatitis B e Antigen', 'HBeAg', 'Hep B e Ag', 'Hepatitis Be Antigen', 'Hepatitis B e Ag', 'Hep Be Antigen']),
  A('hbv_dna', 'Hepatitis B DNA, Quantitative', null, 'IU/mL', 'infectious',
    ['Hepatitis B DNA, Quant', 'HBV DNA, Quantitative', 'HBV DNA Quant', 'Hepatitis B Viral DNA, Quant', 'HBV DNA, PCR', 'Hepatitis B Virus DNA, Quantitative',
      'HBV Viral Load']),
  A('hcv_ab', 'Hepatitis C Antibody', '13955-0', null, 'infectious',
    ['Hepatitis C Antibody', 'Hep C Virus Ab', 'HCV Ab', 'Hepatitis C Ab', 'HCV Antibody', 'Hepatitis C Virus Antibody', 'Hep C Ab', 'Hepatitis C Virus Ab',
      'HCV Antibody w/Reflex to HCV RNA', 'Hepatitis C Antibody w/Reflex', 'Hepatitis C Ab w/Reflex', 'Hep C Virus Ab w/Reflex', 'Hepatitis C Virus (HCV) Antibody',
      'HCV Ab w/Reflex', 'Hepatitis C Antibody, Qualitative', 'Hep C Antibody', 'HCV Ab, Qual', 'Hepatitis C Virus Ab, IgG', 'Hepatitis C Ab, IgG']),
  A('hcv_rna', 'Hepatitis C RNA, Quantitative', null, 'IU/mL', 'infectious',
    ['HCV RNA, Quantitative', 'Hepatitis C RNA, Quant', 'HCV RNA Quant', 'Hepatitis C Viral RNA, Quant', 'HCV RNA, PCR', 'Hepatitis C Virus RNA, Quantitative',
      'HCV Viral Load', 'HCV RNA, Quant, Real-Time PCR', 'Hepatitis C RNA, Quantitative, PCR', 'HCV RNA Quantitative Real Time PCR']),
  A('hiv_ag_ab', 'HIV 1/2 Antigen/Antibody', '56888-1', null, 'infectious',
    ['HIV 1/2 Antigen/Antibody', 'HIV Ag/Ab Combo', 'HIV 1/2 Ag/Ab', 'HIV-1/2 Ag/Ab, 4th Generation', 'HIV Screen 4th Generation', 'HIV 1/2 Ag/Ab, 4th Gen',
      'HIV 1/O/2 Ag/Ab', 'HIV Antigen/Antibody', 'HIV-1/2 Antigen/Antibody', 'HIV Ag/Ab, 4th Generation', 'HIV 1/2 Ab/Ag', 'HIV Screen 4th Generation wRfx',
      'HIV-1/2 Ag/Ab 4th Gen', 'HIV 1/2 Antigen/Antibody, Fourth Generation', 'HIV Ag/Ab', 'HIV-1/2 Ag/Ab Screen', 'HIV 1/2 Ab/p24 Ag', 'HIV Screen 4th Gen',
      'HIV 1/O/2 Ab/p24 Ag', 'HIV Ag/Ab, 4th Gen', 'HIV 1/2 Antigen and Antibodies, Fourth Generation, with Reflexes', 'HIV-1/2 Antigen and Antibodies, 4th Gen',
      'HIV 1/2 Ag/Ab, 4th Generation w/Rfx', 'HIV Ag/Ab, 4th Gen w/Rfx', 'HIV Screen 4th Generation with Reflex']),
  A('hiv_1_rna', 'HIV-1 RNA, Quantitative', null, 'copies/mL', 'infectious',
    ['HIV-1 RNA, Quantitative', 'HIV 1 RNA Quant', 'HIV-1 RNA Quant', 'HIV Viral Load', 'HIV-1 RNA, Quant, Real-Time PCR', 'HIV-1 RNA, Quantitative, PCR',
      'HIV 1 RNA, Quantitative', 'HIV-1 Viral Load', 'HIV-1 RNA Quantitative Real Time PCR']),
  A('hav_ab_total', 'Hepatitis A Antibody, Total', null, null, 'infectious',
    ['Hepatitis A Ab, Total', 'Hepatitis A Antibody, Total', 'HAV Ab, Total', 'Hep A Ab, Total', 'Hepatitis A IgG', 'HAV IgG', 'Hepatitis A Ab, IgG',
      'Hep A Antibody, Total', 'Hepatitis A Antibody (Total)', 'HAV Ab Total', 'Hepatitis A Virus Antibody, Total']),
  A('hav_ab_igm', 'Hepatitis A Antibody, IgM', null, null, 'infectious',
    ['Hepatitis A Ab, IgM', 'Hepatitis A Antibody, IgM', 'HAV Ab, IgM', 'Hep A Ab, IgM', 'HAV IgM', 'Hepatitis A IgM', 'Hep A Antibody, IgM']),
  A('syphilis_rpr', 'RPR', '20507-0', null, 'infectious',
    ['RPR', 'RPR Screen', 'Rapid Plasma Reagin', 'RPR Qualitative', 'RPR, Qual', 'Syphilis RPR', 'RPR Screen w/Reflex', 'RPR (Monitor) w/Reflex to Titer',
      'RPR (Diagnosis) w/Refl Titer', 'RPR w/Reflex to Titer', 'RPR, Qualitative', 'Rapid Plasma Reagin (RPR)']),
  A('syphilis_rpr_titer', 'RPR Titer', null, 'titer', 'infectious',
    ['RPR Titer', 'RPR, Titer', 'Rapid Plasma Reagin Titer', 'RPR Quantitative', 'RPR, Quant']),
  A('syphilis_treponemal', 'Treponema pallidum Antibody', null, null, 'infectious',
    ['Treponema pallidum Ab', 'Syphilis Antibody', 'T. pallidum Ab', 'Treponemal Antibody', 'Syphilis Ab', 'Syphilis Screen', 'Treponema Pallidum Antibodies',
      'Syphilis Serology', 'T pallidum Ab', 'Treponema pallidum Antibodies', 'Syphilis Ab w/Reflex', 'Treponema pallidum Ab, Total', 'Syphilis Screen w/Reflex',
      'T. pallidum Antibodies, Total', 'Syphilis Antibody Screen', 'Treponema pallidum Antibody, Total', 'Syphilis Total Antibody']),
  A('rubella_igg', 'Rubella Antibody, IgG', null, 'IU/mL', 'infectious',
    ['Rubella Antibodies, IgG', 'Rubella IgG', 'Rubella Ab, IgG', 'Rubella Immune Status', 'Rubella Antibody, IgG', 'Rubella Antibody (IgG)', 'Rubella IgG Ab',
      'Rubella Antibodies, IgG, Immune Status', 'Rubella Immunity']),
  A('varicella_igg', 'Varicella-Zoster Antibody, IgG', null, null, 'infectious',
    ['Varicella-Zoster V IgG Ab', 'Varicella Zoster IgG', 'VZV IgG', 'Varicella IgG', 'Varicella-Zoster Virus Antibody, IgG', 'Varicella Immune Status',
      'Varicella Zoster Virus (VZV) Antibody, IgG', 'VZV Ab, IgG', 'Varicella-Zoster Virus Ab, IgG', 'Varicella Zoster Ab, IgG', 'Varicella Immunity']),
  A('measles_igg', 'Measles Antibody, IgG', null, null, 'infectious',
    ['Measles Antibodies, IgG', 'Measles IgG', 'Rubeola IgG', 'Rubeola Antibody, IgG', 'Measles Ab, IgG', 'Measles (Rubeola) Antibody, IgG', 'Rubeola Antibodies, IgG',
      'Measles Antibody (IgG)', 'Measles Immune Status', 'Rubeola Ab, IgG']),
  A('mumps_igg', 'Mumps Antibody, IgG', null, null, 'infectious',
    ['Mumps Antibodies, IgG', 'Mumps IgG', 'Mumps Ab, IgG', 'Mumps Antibody, IgG', 'Mumps Virus Antibody, IgG', 'Mumps Antibody (IgG)', 'Mumps Immune Status']),
  A('lyme_ab', 'Lyme Disease Antibody', null, null, 'infectious',
    ['Lyme Ab/Western Blot Reflex', 'Lyme Disease Ab, Total', 'Lyme Ab Screen', 'Lyme Disease Antibody', 'Lyme Antibody', 'Lyme Screen', 'Lyme IgG/IgM Ab',
      'Borrelia burgdorferi Ab', 'Lyme Disease Ab w/Reflex', 'Lyme Ab, Total', 'Lyme Disease Antibodies, Total', 'Lyme Disease Ab, Quant, IgG/IgM',
      'Lyme Disease (B. burgdorferi) Antibody', 'Lyme Disease Antibody Screen', 'B. burgdorferi Ab, Total']),
  A('ebv_vca_igg', 'EBV VCA IgG', null, null, 'infectious',
    ['EBV VCA IgG', 'Epstein-Barr VCA IgG', 'EBV Viral Capsid Ag IgG', 'EBV Capsid IgG', 'Epstein Barr Virus VCA, IgG', 'EBV Ab VCA, IgG', 'EBV VCA Ab, IgG']),
  A('ebv_vca_igm', 'EBV VCA IgM', null, null, 'infectious',
    ['EBV VCA IgM', 'Epstein-Barr VCA IgM', 'EBV Viral Capsid Ag IgM', 'EBV Capsid IgM', 'Epstein Barr Virus VCA, IgM', 'EBV Ab VCA, IgM', 'EBV VCA Ab, IgM']),
  A('ebv_ebna_igg', 'EBV Nuclear Antigen IgG', null, null, 'infectious',
    ['EBV Nuclear Antigen Ab, IgG', 'EBNA IgG', 'EBV EBNA IgG', 'Epstein-Barr Nuclear Antigen IgG', 'EBV Nuclear Ag IgG', 'EBV Ab EBNA, IgG', 'EBNA Ab, IgG']),
  A('h_pylori', 'H. pylori', null, null, 'infectious',
    ['H. pylori', 'H. pylori Antigen, Stool', 'Helicobacter pylori', 'H. pylori Ab, IgG', 'H pylori', 'Helicobacter pylori Antigen, Stool', 'H. pylori Breath Test',
      'Helicobacter pylori Ab, IgG', 'H. pylori Stool Antigen', 'H. pylori IgG', 'Helicobacter pylori Antibody, IgG', 'H. pylori Antigen']),
  A('strep_a', 'Strep A', null, null, 'infectious',
    ['Strep A', 'Streptococcus, Group A', 'Group A Strep', 'Strep A Antigen', 'Rapid Strep A', 'Group A Streptococcus', 'Strep A Culture', 'Streptococcus pyogenes']),
  A('mono_screen', 'Mononucleosis Screen', null, null, 'infectious',
    ['Mononucleosis Screen', 'Mono Screen', 'Mono Test', 'Mononucleosis Test', 'Monospot', 'Heterophile Antibody', 'Infectious Mononucleosis Screen', 'Mono Spot']),
  A('covid_pcr', 'SARS-CoV-2 RNA', null, null, 'infectious',
    ['SARS-CoV-2 RNA', 'SARS-CoV-2, NAA', 'COVID-19 PCR', 'SARS-CoV-2 RNA, PCR', 'SARS-CoV-2 RNA, Qualitative', 'COVID-19 RNA', 'SARS-CoV-2 PCR', 'SARS-CoV-2 NAAT',
      'SARS-CoV-2 (COVID-19) RNA', 'SARS-CoV-2 RNA, Qual, NAA', 'Coronavirus (COVID-19) PCR']),
  A('covid_igg', 'SARS-CoV-2 Antibody, IgG', null, null, 'infectious',
    ['SARS-CoV-2 Antibody, IgG', 'SARS-CoV-2 IgG', 'COVID-19 IgG', 'SARS-CoV-2 Ab, IgG', 'SARS-CoV-2 Antibodies, IgG', 'COVID-19 Antibody, IgG',
      'SARS-CoV-2 Semi-Quant Total Ab', 'SARS-CoV-2 Spike Ab, IgG', 'SARS-CoV-2 Total Antibody', 'SARS-CoV-2 Antibody (IgG), Spike, Semi-Quantitative']),

  // ---------------- Coagulation ----------------
  A('pt', 'Prothrombin Time', '5902-2', 'sec', 'coagulation',
    ['Prothrombin Time', 'PT', 'Prothrombin Time (PT)', 'Protime', 'PT (Prothrombin Time)', 'Prothrombin Time, Plasma', 'Pro Time', 'PT, Plasma']),
  A('inr', 'INR', '6301-6', 'ratio', 'coagulation',
    ['INR', 'International Normalized Ratio', 'PT/INR', 'Prothrombin Time INR', 'PT INR', 'INR (International Normalized Ratio)', 'Prothrombin INR']),
  A('ptt', 'PTT, Activated', null, 'sec', 'coagulation',
    ['PTT', 'aPTT', 'Partial Thromboplastin Time', 'Activated Partial Thromboplastin Time', 'APTT', 'PTT, Activated', 'Activated PTT',
      'Partial Thromboplastin Time, Activated', 'Partial Thromboplastin Time (PTT)', 'aPTT, Plasma', 'PTT (Partial Thromboplastin Time)', 'PTT-LA']),
  A('fibrinogen', 'Fibrinogen', '3255-7', 'mg/dL', 'coagulation',
    ['Fibrinogen', 'Fibrinogen Activity', 'Fibrinogen, Plasma', 'Fibrinogen Activity, Clauss', 'Fibrinogen, Functional', 'Fibrinogen Level', 'Fibrinogen (Clauss)'],
    { 'g/L': 0.01 }),
  A('d_dimer', 'D-Dimer', null, 'mg/L FEU', 'coagulation',
    ['D-Dimer', 'D Dimer', 'D-Dimer, Quantitative', 'D-Dimer, Quant', 'Fibrin D-Dimer', 'D-Dimer (FEU)', 'D-Dimer, Plasma', 'D-Dimer Quant', 'DDimer',
      'D-Dimer, Quantitative (FEU)', 'Fibrin Degradation Products, D-Dimer'], { 'ug/mL FEU': 1, 'ng/mL FEU': 1000 }),

  // ---------------- Cardiac ----------------
  A('troponin_i', 'Troponin I', null, 'ng/mL', 'cardiac',
    ['Troponin I', 'Troponin I, High Sensitivity', 'hs-Troponin I', 'Troponin-I', 'Troponin I (hs)', 'TnI', 'Troponin I, HS', 'High Sensitivity Troponin I',
      'Troponin I, hs', 'hsTnI', 'Troponin I, Serum', 'Troponin I, Quantitative', 'Troponin I, Plasma', 'Troponin-I, High Sensitivity'], { 'ng/L': 1000 }),
  A('troponin_t', 'Troponin T', null, 'ng/mL', 'cardiac',
    ['Troponin T', 'Troponin T, High Sensitivity', 'hs-Troponin T', 'Troponin-T', 'TnT', 'High Sensitivity Troponin T', 'Troponin T, HS', 'Troponin T, hs', 'hsTnT',
      'Troponin T, Serum', 'Troponin T, Quantitative', 'Troponin-T, High Sensitivity'], { 'ng/L': 1000 }),
  A('bnp', 'BNP', '30934-4', 'pg/mL', 'cardiac',
    ['BNP', 'B-Type Natriuretic Peptide', 'Brain Natriuretic Peptide', 'B-type Natriuretic Peptide (BNP)', 'Natriuretic Peptide, B-Type', 'BNP, Plasma',
      'B-Natriuretic Peptide', 'Natriuretic Peptide B'], { 'ng/L': 1 }),
  A('nt_probnp', 'NT-proBNP', '33762-6', 'pg/mL', 'cardiac',
    ['NT-proBNP', 'N-Terminal proBNP', 'proBNP, N-Terminal', 'NT proBNP', 'pro-BNP', 'NT-pro BNP', 'proBNP', 'N-terminal pro-B-type Natriuretic Peptide',
      'NT-proBNP (N-Terminal pro-BNP)', 'NTproBNP', 'B-Natriuretic Peptide, N-Terminal Pro', 'proBNP, N-Terminal (NT-proBNP)', 'N-Terminal Pro-BNP',
      'Pro B-type Natriuretic Peptide, N-Terminal', 'NT Pro-BNP'], { 'ng/L': 1, 'pmol/L': 0.118 }),
  A('myoglobin', 'Myoglobin', null, 'ng/mL', 'cardiac',
    ['Myoglobin', 'Myoglobin, Serum', 'Myoglobin, Plasma'], { 'ug/L': 1 }),

  // ---------------- Blood type ----------------
  A('abo_rh', 'ABO/Rh', '882-1', null, 'blood_type',
    ['ABO/Rh', 'ABO Grouping and Rho(D) Typing', 'ABO/Rh Type', 'Blood Type', 'ABO and Rh', 'ABO/RH(D)', 'ABO Rh', 'ABO Group and Rh Type', 'ABO/Rh(D) Typing',
      'ABO Grouping and Rh Typing', 'ABO/Rh Typing', 'Blood Type (ABO/Rh)', 'ABO and Rh Type', 'ABO Grouping and Rh(D) Typing', 'ABO & Rh Type']),
  A('abo_group', 'ABO Group', '883-9', null, 'blood_type',
    ['ABO Group', 'ABO', 'ABO Grouping', 'ABO Type', 'Blood Group', 'ABO Blood Group', 'ABO Blood Type', 'ABO Typing']),
  A('rh_type', 'Rh Type', '10331-7', null, 'blood_type',
    ['Rh Type', 'Rh', 'Rh(D)', 'Rho(D) Typing', 'Rh Factor', 'RH(D) Typing', 'Rh (D) Type', 'Rho(D)', 'Rh Typing', 'Rh(D) Type', 'Rh (D) Typing', 'Rhesus', 'Rh Blood Type']),
  A('antibody_screen', 'Antibody Screen', '890-4', null, 'blood_type',
    ['Antibody Screen', 'Antibody Screen, RBC', 'Indirect Coombs', 'Indirect Antiglobulin Test', 'RBC Antibody Screen', 'Ab Screen', 'Blood Group Antibody Screen',
      'Antibody Screen (Indirect Coombs)', 'Red Cell Antibody Screen', 'Antibody Screen, Indirect', 'IAT']),
];

// ------------------------------------------------------------------
// Indexes
// ------------------------------------------------------------------

/** Lowercase, µ→u, strip punctuation, collapse whitespace. Exported for parsers/tests. */
export function normalizeKey(s) {
  if (s == null) return '';
  return String(s)
    .replace(/[µμ]/g, 'u')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export const ANALYTE_BY_ID = new Map(ANALYTES.map((a) => [a.id, a]));

/** normalized alias key → analyte. Built once at module load. */
const ALIAS_INDEX = new Map();
/** [{ key, tokens:Set, analyte }] for fuzzy matching. */
const ALIAS_TOKENS = [];
for (const a of ANALYTES) {
  const seen = new Set();
  for (const alias of a.aliases) {
    const key = normalizeKey(alias);
    if (!key || seen.has(key)) continue; // duplicate spelling inside one analyte is harmless
    seen.add(key);
    if (!ALIAS_INDEX.has(key)) ALIAS_INDEX.set(key, a);
    ALIAS_TOKENS.push({ key, tokens: new Set(key.split(' ')), analyte: a });
  }
  // the display name and the id are implicit aliases (only if not already claimed)
  for (const extra of [a.display, a.id.replace(/_/g, ' ')]) {
    const key = normalizeKey(extra);
    if (key && !ALIAS_INDEX.has(key)) ALIAS_INDEX.set(key, a);
  }
}

/** Find alias key collisions across analytes: Map<normalizedKey, ids[]>. Tests assert it is empty. */
export function findAliasCollisions() {
  const owners = new Map();
  for (const a of ANALYTES) {
    for (const alias of a.aliases) {
      const key = normalizeKey(alias);
      if (!key) continue;
      const set = owners.get(key) || new Set();
      set.add(a.id);
      owners.set(key, set);
    }
  }
  const out = new Map();
  for (const [k, ids] of owners) if (ids.size > 1) out.set(k, [...ids]);
  return out;
}

export function getAnalyte(id) {
  return ANALYTE_BY_ID.get(id) || null;
}

// ------------------------------------------------------------------
// Unit normalization
// ------------------------------------------------------------------

function unitKey(u) {
  return String(u)
    .replace(/[µμ]/g, 'u')
    .replace(/²/g, '2')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/^\{(.*)\}$/, '$1');
}

const UNIT_TABLE = new Map();
/** Register canonical spelling plus alternate spellings. Alternates never overwrite an earlier canonical claim. */
const U = (canonical, ...spellings) => {
  UNIT_TABLE.set(unitKey(canonical), canonical);
  for (const s of spellings) {
    const k = unitKey(s);
    if (!UNIT_TABLE.has(k)) UNIT_TABLE.set(k, canonical);
  }
};

// Counts
U('10^3/uL', 'Thousand/uL', 'x10E3/uL', 'x10^3/uL', 'K/uL', '10*3/uL', '10E3/uL', 'x10(3)/uL', '10(3)/uL', 'Thou/uL', 'Thousand/cumm', 'K/cumm', 'K/mm3',
  'x10E3/mcL', '10^3/mcL', 'K/mcL', 'TH/uL', 'thou/cumm', 'x10^3/mm3', '10^3/mm3', '10*3/mm3', 'x1000/uL', '1000/uL', 'Thousand/mcL', 'Thousands/uL');
U('10^9/L', '10*9/L', 'x10E9/L', '10E9/L', '10(9)/L', 'x10^9/L', 'Giga/L');
U('10^6/uL', 'Million/uL', 'x10E6/uL', 'x10^6/uL', 'M/uL', '10*6/uL', '10E6/uL', 'Mil/uL', 'Mill/uL', 'Million/cumm', 'x10E6/mcL', '10^6/mcL', 'M/mcL',
  'x10(6)/uL', '10(6)/uL', 'M/mm3', 'Million/mcL', 'x10^6/mm3', '10^6/mm3', 'mil/mm3', 'Million/mm3', 'Millions/uL');
U('10^12/L', '10*12/L', 'x10E12/L', '10E12/L', '10(12)/L', 'x10^12/L', 'Tera/L');
U('/uL', 'cells/uL', '/mcL', 'cells/mcL', '/mm3', 'cells/mm3', 'per uL', '/cumm', 'cells/cumm');
U('copies/mL', 'cp/mL', 'copies per mL');

// Mass concentrations
U('mg/dL', 'mg/100mL', 'mg%');
U('mg/L');
U('g/dL', 'gm/dL', 'g/100mL', 'g%');
U('g/L', 'gm/L');
U('ng/mL');
U('ng/dL');
U('ng/L');
U('pg/mL');
U('pg/dL');
U('ug/dL', 'mcg/dL', 'µg/dL');
U('ug/L', 'mcg/L', 'µg/L');
U('ug/mL', 'mcg/mL', 'µg/mL');
U('ng/mg', 'ng/mg creat', 'ng/mg creatinine');
U('mg/g', 'mg/g creat', 'mg/g Cr', 'mg/g creatinine', 'mg/gCr', 'mg/gm creat');
U('mg/mmol', 'mg/mmol creat', 'mg/mmol Cr');
U('mg/L FEU');
U('ug/mL FEU', 'mcg/mL FEU', 'µg/mL FEU');
U('ng/mL FEU');
U('ng/mL DDU');

// Molar
U('mmol/L');
U('umol/L', 'µmol/L', 'mcmol/L');
U('nmol/L');
U('pmol/L');
U('mmol/mol', 'mmol/mol Hb');
U('mEq/L');
U('mOsm/kg', 'mOsm/kg H2O', 'mOsmol/kg', 'mOsm/kg water');

// Activity / international units
U('uIU/mL', 'mIU/L', 'µIU/mL', 'uU/mL', 'µU/mL', 'mU/L', 'micro IU/mL');
U('mIU/mL', 'mU/mL');
U('IU/mL', 'kIU/L', 'kU/L');
U('IU/L');
U('U/L', 'Units/L');
U('U/mL', 'Units/mL');
U('AU/mL');
U('IU/dL');

// Kidney
U('mL/min/1.73m2', 'mL/min/1.73', 'mL/min/1.73m^2', 'mL/min/1.73 m^2', 'mL/min/1.73 m2', 'mL/min/1.73sqm', 'mL/min/1.73 sq m', 'mL/min/1.73m²',
  'mL/min/1.73 m²', 'mL/min/1.73m*2', 'mL/min/{1.73_m2}', 'mL/min/1.73 sq.m', 'mL/min/1.73sq.m', 'mL/min/1.73 M2', 'mL/min per 1.73 m2',
  'mL/min/1.73 msq', 'mL/min/1.73 m**2');
U('mL/min');

// Misc
U('%', 'percent', 'pct');
U('ratio', 'calc');
U('fL', 'um3', 'cu um');
U('pg');
U('sec', 'seconds', 's', 'secs', 'second');
U('mm/hr', 'mm/h', 'mm per hour', 'mm/hour');
U('/HPF', 'per HPF', 'cells/HPF', 'HPF', '/ HPF');
U('/LPF', 'per LPF', 'LPF', '/ LPF');
U('titer', 'titre');
U('ng/mL/hr', 'ng/mL/h', 'ng/mL/hour');
U('nmol/mL');
U('umol/g', 'umol/g creat', 'µmol/g');
U('mg/24hr', 'mg/24 hr', 'mg/24h', 'mg/24 h', 'mg/day', 'mg/d');
U('g/24hr', 'g/24 hr', 'g/24h', 'g/day');
U('mmol/24hr', 'mmol/24 hr', 'mmol/24h', 'mmol/day');

/** Normalize unit spelling to a canonical string. Unknown units are returned trimmed; null/undefined → null. */
export function normalizeUnit(unit) {
  if (unit == null) return null;
  const trimmed = String(unit).trim();
  if (!trimmed) return trimmed;
  const hit = UNIT_TABLE.get(unitKey(trimmed));
  return hit || trimmed;
}

// ------------------------------------------------------------------
// Unit conversion
// ------------------------------------------------------------------

/** Analyte-independent exact factors: value[to] = value[from] * factor. Inverse is derived. */
const GENERIC = new Map();
const G = (from, to, factor) => {
  GENERIC.set(`${from}|${to}`, factor);
  GENERIC.set(`${to}|${from}`, 1 / factor);
};
G('10^3/uL', '10^9/L', 1);
G('10^6/uL', '10^12/L', 1);
G('/uL', '10^3/uL', 0.001);
G('/uL', '10^9/L', 0.001);
G('g/dL', 'g/L', 10);
G('mg/dL', 'mg/L', 10);
G('mg/dL', 'g/L', 0.01);
G('mg/dL', 'ug/dL', 1000);
G('mg/L', 'ug/L', 1000);
G('mg/L', 'ug/mL', 1);
G('g/L', 'mg/L', 1000);
G('ug/dL', 'ug/L', 10);
G('ug/dL', 'ng/mL', 10);
G('ug/dL', 'mg/L', 0.01);
G('ug/mL', 'ng/mL', 1000);
G('ng/mL', 'ug/L', 1);
G('ng/mL', 'ng/dL', 100);
G('ng/mL', 'pg/mL', 1000);
G('ng/mL', 'ng/L', 1000);
G('ng/dL', 'ng/L', 10);
G('ng/dL', 'pg/mL', 10);
G('pg/mL', 'ng/L', 1);
G('pg/mL', 'pg/dL', 100);
G('mmol/L', 'umol/L', 1000);
G('umol/L', 'nmol/L', 1000);
G('nmol/L', 'pmol/L', 1000);
G('mmol/L', 'nmol/L', 1e6);
G('uIU/mL', 'mIU/L', 1);
G('mIU/mL', 'IU/L', 1);
G('IU/mL', 'kIU/L', 1);
G('ug/mL FEU', 'mg/L FEU', 1);
G('ng/mL FEU', 'mg/L FEU', 0.001);
G('ng/mL FEU', 'ug/mL FEU', 0.001);

function roundSig(x) {
  if (!Number.isFinite(x)) return null;
  return Number(x.toPrecision(12));
}

/**
 * Convert a numeric value between units. Returns null when no exact conversion is known (never approximates).
 * Analyte-specific molar factors come from ANALYTES[].conversions (factor FROM canonicalUnit).
 */
export function convertUnit(value, fromUnit, toUnit, analyteId) {
  if (value == null || typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (fromUnit == null || toUnit == null) return null;
  const from = normalizeUnit(fromUnit);
  const to = normalizeUnit(toUnit);
  if (!from || !to) return null;
  if (from === to) return value;

  const a = analyteId ? ANALYTE_BY_ID.get(analyteId) : null;
  if (a && a.conversions && a.canonicalUnit) {
    const canon = a.canonicalUnit;
    const conv = a.conversions;
    const known = [canon, ...Object.keys(conv)];
    const factorOf = (u) => (u === canon ? 1 : Object.prototype.hasOwnProperty.call(conv, u) ? conv[u] : null);
    const fFrom = factorOf(from);
    const fTo = factorOf(to);
    if (fFrom != null && fTo != null) return roundSig((value / fFrom) * fTo);
    // Compose one generic hop with the analyte table (e.g. g/L → mmol/L for hemoglobin).
    if (fFrom != null) {
      for (const u of known) {
        const g = GENERIC.get(`${u}|${to}`);
        if (g != null) return roundSig((value / fFrom) * factorOf(u) * g);
      }
    }
    if (fTo != null) {
      for (const u of known) {
        const g = GENERIC.get(`${from}|${u}`);
        if (g != null) return roundSig(((value * g) / factorOf(u)) * fTo);
      }
    }
  }

  const g = GENERIC.get(`${from}|${to}`);
  if (g != null) return roundSig(value * g);
  return null;
}

// ------------------------------------------------------------------
// Analyte name normalization
// ------------------------------------------------------------------

const COUNT_UNITS = new Set(['10^3/uL', '10^9/L', '/uL', '10^6/uL', '10^12/L']);

function pick(a) {
  return { id: a.id, loinc: a.loinc, canonicalUnit: a.canonicalUnit, display: a.display };
}

function jaccard(setA, setB) {
  let inter = 0;
  for (const t of setA) if (setB.has(t)) inter++;
  const union = setA.size + setB.size - inter;
  return union === 0 ? 0 : inter / union;
}

function isSubset(small, big) {
  for (const t of small) if (!big.has(t)) return false;
  return true;
}

function unitPrefers(unitNorm) {
  if (!unitNorm) return null;
  if (unitNorm === '%') return '_pct';
  if (COUNT_UNITS.has(unitNorm)) return '_abs';
  return null;
}

/** Swap to the sibling _pct/_abs (or urine_) variant when the unit contradicts the matched analyte. */
function disambiguate(a, unitRaw) {
  if (!unitRaw) return a;
  const u = normalizeUnit(unitRaw);
  const pref = unitPrefers(u);
  if (pref === '_pct' && a.id.endsWith('_abs')) {
    const sib = ANALYTE_BY_ID.get(a.id.replace(/_abs$/, '_pct'));
    if (sib) return sib;
  } else if (pref === '_pct' && !a.id.endsWith('_pct')) {
    // e.g. "PSA, Free" reported in % → psa_free_pct ("% Free PSA" loses its % under key normalization)
    const sib = ANALYTE_BY_ID.get(`${a.id}_pct`);
    if (sib) return sib;
  } else if (pref === '_abs' && a.id.endsWith('_pct')) {
    const sib = ANALYTE_BY_ID.get(a.id.replace(/_pct$/, '_abs'));
    if (sib) return sib;
  }
  if (/hpf|lpf/i.test(String(unitRaw)) && !a.id.startsWith('urine_')) {
    const sib = ANALYTE_BY_ID.get(`urine_${a.id}`);
    if (sib) return sib;
  }
  return a;
}

function fuzzyMatch(key, unitRaw) {
  const tokens = new Set(key.split(' '));
  if (tokens.size === 0) return null;
  const pref = unitPrefers(unitRaw ? normalizeUnit(unitRaw) : null);
  let best = null;
  let bestScore = 0;
  for (const cand of ALIAS_TOKENS) {
    if (!isSubset(cand.tokens, tokens) && !isSubset(tokens, cand.tokens)) continue;
    const j = jaccard(tokens, cand.tokens);
    if (j < 0.8) continue;
    let score = j;
    if (pref && cand.analyte.id.endsWith(pref)) score += 0.05;
    if (score > bestScore) {
      bestScore = score;
      best = cand.analyte;
    }
  }
  return best;
}

// Trailing specimen/method filler that does not change identity ("Glucose, Serum, Fasting" is NOT reduced
// because "fasting" is not filler; "Cholesterol, Total, Serum, Quant" → "cholesterol total").
const STRIP_SUFFIX = /\s+(serum|plasma|blood|ser|pl|whole blood|quant|quantitative|qn|s|p)$/;
function stripFiller(key) {
  let k = key;
  for (let i = 0; i < 3; i++) {
    const next = k.replace(STRIP_SUFFIX, '').trim();
    if (next === k || !next) break;
    k = next;
  }
  return k;
}

/**
 * Map a printed analyte name (Labcorp / Quest / other) to a dictionary entry.
 * Exact normalized-alias match first, then token-set fuzzy match (Jaccard >= 0.8 with one token set
 * contained in the other). The unit disambiguates _pct vs _abs differential variants and urine microscopy.
 */
export function normalizeAnalyte(name, unit) {
  if (name == null) return null;
  const key = normalizeKey(name);
  if (!key) return null;
  let hit = ALIAS_INDEX.get(key) || null;
  if (!hit) {
    const stripped = stripFiller(key);
    if (stripped !== key) hit = ALIAS_INDEX.get(stripped) || null;
  }
  if (!hit) hit = fuzzyMatch(key, unit);
  if (!hit) return null;
  return pick(disambiguate(hit, unit));
}

export default ANALYTES;
