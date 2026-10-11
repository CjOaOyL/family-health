// Coverage audit and confidence scoring. Implements docs/SPEC.md §5 exactly.
import { REQUIRED_FIELDS, IMPORTANT_FIELDS, getPath } from '../model/schema.js';
import { parsePageOf, isTextValue, isUnitToken, UNIT_RE } from '../parse/common.js';

// ---------------------------------------------------------------------------------------------
// Heuristics (exported so tests can reference them)
// ---------------------------------------------------------------------------------------------

/** Weights, caps and thresholds from §5. */
export const WEIGHTS = { required: 0.40, important: 0.15, coverage: 0.30, pages: 0.15 };
export const CAPS = { requiredMissing: 0.90, resultLikeUnconsumed: 0.94 };
export const LABEL_THRESHOLDS = { complete: 0.95, review: 0.80 };
export const RESULT_PENALTIES = { missingUnit: 0.25, missingRange: 0.25, missingValue: 0.40, wrapped: 0.10, misaligned: 0.10 };

/** A numeric token (optionally qualified), e.g. "6.2", "<5", "1,234", ">=60". */
const NUM = '(?:[<>]=?\\s*)?[-+]?\\d{1,3}(?:,\\d{3})*(?:\\.\\d+)?|(?:[<>]=?\\s*)?[-+]?\\d*\\.\\d+';

/**
 * Numeric token followed by a unit-ish token: "95 mg/dL", "4.5 x10E3/uL", "42%", "1.2 ng/mL".
 * The unit alternatives mirror common.js UNIT_RE (without anchors).
 */
const UNIT_SRC = UNIT_RE.source.replace(/^\^\(\?:/, '(?:').replace(/\)\$$/, ')');
export const NUM_UNIT_RE = new RegExp(`(?:^|\\s)(?:${NUM})\\s*${UNIT_SRC}(?=\\s|$)`, 'i');

/** A flag token right after a number: "210 High", "4.1 L", "0.2 HH", "7.9 *". */
export const NUM_FLAG_RE = new RegExp(`(?:^|\\s)(?:${NUM})\\s+(?:H|L|HH|LL|A|C|HI|LO|High|Low|Critical|Abnormal|Alert|\\*|\\*\\*)(?=\\s|$)`);

/**
 * Reference-range pattern: "3.4-10.8", "0.0 - 5.0", "<200", ">39", ">=60", "Not Estab.".
 * Guarded so phone numbers (800-762-4344), specimen ids (063-123-4567-0) and dates do not match.
 */
export const RANGE_RE = /(?:(?<![\d\/.\-:])[-+]?\d{1,3}(?:,\d{3})*(?:\.\d+)?\s*(?:-|–|—|to)\s*[-+]?\d{1,3}(?:,\d{3})*(?:\.\d+)?(?![\d\-\/.:])|(?:^|\s)[<>]=?\s*\d|(?:^|\s)(?:≤|≥)\s*\d|\bNot\s+Estab\.?)/i;

/**
 * Known boilerplate: lines that may contain numbers but are never result rows. Any line matching one
 * of these is not "result-like" even if it has a numeric token.
 */
export const BOILERPLATE_PATTERNS = [
  /\bPage\s*\d+\s*(?:of|\/)\s*\d+\b/i,
  /(?:©|\(c\)|copyright)\s*\d{4}/i,
  /Laboratory Corporation of America/i,
  /\bLab[Cc]orp\b.*(?:Burlington|York Court|Holdings)/,
  /Quest Diagnostics(?:\s+Incorporated|-|\s+Nichols)?/,
  /\b(?:FINAL|PARTIAL|CORRECTED|PRELIMINARY)\s+REPORT\b/,
  /\bDate\s+Issued\b/i,
  /\bCLIENT\s+SERVICES?\b/i,
  /\bPERFORMING\s+SITE\b/i,
  /\bLaboratory\s+Director\b/i,
  /\bCLIA\s*[:#]?\s*\w/i,
  /\bDir\s*:/,
  /\bNPI\s*[:#]?\s*\d/i,
  /\b(?:Phone|Fax|Tel|Telephone)\s*[:#]?\s*[\d(]/i,
  /\b(?:DOB|Date of Birth|Birth ?Date)\s*[:#]/i,
  /\b(?:Age|Gender|Sex)\s*[:#]/i,
  /\bPatient\s*(?:ID|#|Name)?\s*[:#]/i,
  /\b(?:Specimen|Accession)\s*(?:ID|#|Number)?\s*[:#]/i,
  /\b(?:Requisition|Req\.?|Lab Ref)\s*#?\s*[:#]/i,
  /\b(?:Date\s+)?(?:collected|received|reported|entered)\s*[:#]/i,
  /\bCollected\s+on\b/i,
  /\b(?:Account|Client)\s*(?:Number|#|Name)?\s*[:#]/i,
  /\b(?:Ordering|Referring|Ordered by|Physician|Provider)\b.*[:#]/i,
  /\bFasting\s*[:#]/i,
  /\bRte\s*[:#]/i,
  /\bOrdered\s+Items\b/i,
  /^\s*(?:TESTS?|Test Name)\b.*\b(?:RESULT|In Range|Your Value)\b/i,
  /\b(?:Patient|Specimen|Physician|Client)\s+(?:Details|Information)\b/i,
  /^\s*(?:\d{2}|[A-Z]{2,3})\s{2,}(?:[A-Z]{2}\s{2,})?(?:Lab[Cc]orp|Quest Diagnostics|.*\bDir\s*:)/,
  /\b(?:Suite|Ste\.?|Hwy|Highway|Street|St\.|Road|Rd\.|Avenue|Ave\.|Court|Ct\.|Blvd|Drive|Dr\.)\b.*\b[A-Z]{2}\s+\d{5}/,
  /\b[A-Z]{2}\s+\d{5}(?:-?\d{4})?\b\s*$/,
  /\b(?:1\.)?8\d{2}[.\-]\d{3}[.\-]\d{4}\b/,
];

/** A whole cell that is a recognized text value ("NEGATIVE", "Non Reactive", "Not Detected"). */
export function isCellTextValue(c) {
  const t = String(c || '').trim();
  if (!t || isUnitToken(t) || /^\d+:\d+$/.test(t)) return false;
  return isTextValue(t) || isTextValue(t.replace(/\s+/g, '-')) || isTextValue(t.replace(/\s+/g, ''));
}

/** True when a line is a known header/footer/boilerplate line. Accepts a Line or a string. */
export function isBoilerplate(line) {
  const text = typeof line === 'string' ? line : (line && line.text) || '';
  if (!text.trim()) return true;
  return BOILERPLATE_PATTERNS.some((re) => re.test(text));
}

/**
 * resultLike(line): ≥1 alphabetic token AND (numeric token followed by a unit-ish token, OR a flag token
 * after a number, OR a range pattern, OR a whole cell that is a recognized text value) AND not boilerplate.
 */
export function resultLike(line) {
  const text = typeof line === 'string' ? line : (line && line.text) || '';
  if (!text.trim()) return false;
  if (!/[A-Za-z]{2,}/.test(text)) return false;
  if (isBoilerplate(text)) return false;
  if (NUM_UNIT_RE.test(text)) return true;
  if (NUM_FLAG_RE.test(text)) return true;
  if (RANGE_RE.test(text)) return true;
  const cells = typeof line === 'string' || !Array.isArray(line.cells) ? text.split(/\s{2,}/) : line.cells;
  if (cells.length >= 2 && cells.slice(1).some((c) => isCellTextValue(c))) return true;
  return false;
}

// ---------------------------------------------------------------------------------------------
// Per-result confidence (§5)
// ---------------------------------------------------------------------------------------------

const clamp01 = (n) => Math.max(0, Math.min(1, n));
const round3 = (n) => Math.round(n * 1000) / 1000;

/**
 * scoreResult(result, hints?) → number 0..1.
 * hints.wrapped: name was wrapped/merged across lines; hints.misaligned: value not under RESULT column.
 * Parsers may also set result.hints = { wrapped, misaligned } (ignored by the schema, honored here).
 */
export function scoreResult(result, hints = {}) {
  if (!result) return 0;
  const h = { ...(result.hints || {}), ...hints };
  const fs = result.fieldStatus || {};
  const numeric = typeof result.value === 'number' && Number.isFinite(result.value);
  const hasValue = (result.valueText != null && String(result.valueText).trim() !== '') || numeric;
  let c = 1.0;
  if (!hasValue || fs.value === 'missing') c -= RESULT_PENALTIES.missingValue;
  if (numeric) {
    const unitMissing = fs.unit === 'missing' || (fs.unit !== 'na' && fs.unit !== 'found' && !result.unit);
    if (unitMissing) c -= RESULT_PENALTIES.missingUnit;
    const rr = result.referenceRange || {};
    const rangeNA = fs.range === 'na' || (rr.kind === 'text' && rr.text != null);
    const rangeMissing = !rangeNA && (fs.range === 'missing' || (fs.range !== 'found' && rr.text == null));
    if (rangeMissing) c -= RESULT_PENALTIES.missingRange;
  }
  if (h.wrapped) c -= RESULT_PENALTIES.wrapped;
  if (h.misaligned) c -= RESULT_PENALTIES.misaligned;
  return round3(clamp01(c));
}

// ---------------------------------------------------------------------------------------------
// Audit (§5)
// ---------------------------------------------------------------------------------------------

/** Human label for a dotted path, used in warnings. */
const FIELD_LABELS = {
  'patient.fullName': 'patient name', 'patient.dob': 'date of birth', 'patient.sex': 'sex',
  'specimen.collectedAt': 'collection date', 'specimen.reportedAt': 'report date', 'specimen.specimenId': 'specimen ID',
  'provider.orderingName': 'ordering provider', 'source.vendor': 'lab vendor',
  'patient.patientId': 'patient ID', 'specimen.receivedAt': 'received date', 'provider.accountNumber': 'account number',
  'performingLabs': 'performing lab legend', 'patient.ageAtCollection': 'age', 'provider.npi': 'provider NPI',
};
export const fieldLabel = (p) => FIELD_LABELS[p] || p;

/** Labels that indicate an optional field is printed in the document (so a null value is a real miss). */
export const OPTIONAL_FIELD_LABELS = {
  'patient.patientId': /patient\s*id|patient\s*#|MRN/i,
  'specimen.receivedAt': /(?:date\s+)?received/i,
  'provider.accountNumber': /account(?:\s*(?:number|#|no\.?))?\s*:|client\s*#|client\s*(?:number|no\.?)\s*:/i,
  'performingLabs': /performing\s+(?:site|lab)|lab(?:oratory)?\s+director|Dir:|CLIA/i,
  'patient.ageAtCollection': /age\s*:/i,
  'provider.npi': /NPI/i,
};
function labelPresent(path, docText) {
  const re = OPTIONAL_FIELD_LABELS[path];
  return re ? re.test(docText) : true;
}

function isPresent(path, value) {
  if (path === 'source.vendor') return value != null && value !== 'unknown';
  if (Array.isArray(value)) return value.length > 0;
  return value != null && value !== '';
}

function statusConfidence(status) {
  if (status === 'found') return 1;
  if (status === 'uncertain') return 0.5;
  if (status === 'na') return 1;
  return 0;
}

/** Fraction of fields found, uncertain counts 0.5. */
function foundFraction(fields, paths) {
  if (!paths.length) return 1;
  let sum = 0;
  for (const p of paths) {
    const s = fields[p] ? fields[p].status : 'missing';
    sum += s === 'found' || s === 'na' ? 1 : s === 'uncertain' ? 0.5 : 0;
  }
  return sum / paths.length;
}

function resultHasIssues(r) {
  const fs = r.fieldStatus || {};
  if (['value', 'unit', 'range', 'flag'].some((k) => fs[k] === 'missing' || fs[k] === 'uncertain')) return true;
  return typeof r.confidence === 'number' && r.confidence < 0.999;
}

/**
 * buildAudit(doc, parseResult, report) → Audit
 * `report` is the merged LabReport (fields already filled) — if omitted, parseResult.report is used.
 * parseResult.fieldStatus (optional, Record<path, FieldStatus>) lets a parser mark 'uncertain'.
 */
export function buildAudit(doc, parseResult, report) {
  const pr = parseResult || {};
  const rep = report || pr.report || {};
  const consumed = pr.consumed instanceof Map ? pr.consumed : new Map(Object.entries(pr.consumed || {}));
  const evidence = pr.fieldEvidence || {};
  const statusOverride = pr.fieldStatus || {};
  const warnings = [];

  // Fields
  const fields = {};
  const allPaths = [...new Set([...REQUIRED_FIELDS, ...IMPORTANT_FIELDS])];
  const docText = (Array.isArray(doc && doc.pages) ? doc.pages : []).flatMap((pg) => (pg.lines || []).map((l) => l.text || '')).join(' | ');
  for (const p of allPaths) {
    const v = getPath(rep, p);
    let status = statusOverride[p] || (isPresent(p, v) ? 'found' : 'missing');
    if (status === 'uncertain' && !isPresent(p, v)) status = 'missing';
    // An optional field whose label never appears in the document is not a miss: mark it 'na'.
    if (status === 'missing' && IMPORTANT_FIELDS.includes(p) && !REQUIRED_FIELDS.includes(p) && !labelPresent(p, docText)) status = 'na';
    fields[p] = { status, confidence: statusConfidence(status), evidence: Array.isArray(evidence[p]) ? [...evidence[p]] : [] };
  }

  // Coverage
  const pages = Array.isArray(doc && doc.pages) ? doc.pages : [];
  const unconsumed = [];
  let totalLines = 0;
  let consumedLines = 0;
  let declared = null;
  for (const page of pages) {
    for (const line of page.lines || []) {
      totalLines++;
      const po = parsePageOf(line.text);
      if (po && (declared == null || po.of > declared)) declared = po.of;
      if (consumed.has(line.id)) { consumedLines++; continue; }
      unconsumed.push({ lineId: line.id, page: line.page ?? page.pageNumber, text: line.text, resultLike: resultLike(line) });
    }
  }
  const resultLikeUnconsumed = unconsumed.filter((u) => u.resultLike).length;

  // Pages
  const seen = (doc && doc.pageCount) || pages.length;
  const pagesComplete = declared == null ? true : seen >= declared;
  const pagesInfo = { declared, seen, complete: pagesComplete };

  // Results
  const results = Array.isArray(rep.results) ? rep.results : [];
  const withIssues = results.filter(resultHasIssues).length;
  const resultsInfo = { count: results.length, fullyParsed: results.length - withIssues, withIssues };

  // Overall
  const requiredFrac = foundFraction(fields, REQUIRED_FIELDS);
  const importantFrac = foundFraction(fields, IMPORTANT_FIELDS);
  const coverageFrac = 1 - resultLikeUnconsumed / Math.max(1, results.length + resultLikeUnconsumed);
  const pagesFrac = pagesComplete ? 1 : 0.5 * (declared ? seen / declared : 1);
  let overall = WEIGHTS.required * requiredFrac + WEIGHTS.important * importantFrac + WEIGHTS.coverage * coverageFrac + WEIGHTS.pages * pagesFrac;

  const missingRequired = REQUIRED_FIELDS.filter((p) => fields[p].status === 'missing');
  if (missingRequired.length) {
    overall = Math.min(overall, CAPS.requiredMissing);
    warnings.push(`Required field${missingRequired.length > 1 ? 's' : ''} not found: ${missingRequired.map(fieldLabel).join(', ')}. Overall score capped at ${CAPS.requiredMissing}.`);
  }
  const uncertainRequired = REQUIRED_FIELDS.filter((p) => fields[p].status === 'uncertain');
  if (uncertainRequired.length) {
    warnings.push(`Required field${uncertainRequired.length > 1 ? 's' : ''} uncertain (conflicting values across pages): ${uncertainRequired.map(fieldLabel).join(', ')}.`);
  }
  if (resultLikeUnconsumed > 0) {
    overall = Math.min(overall, CAPS.resultLikeUnconsumed);
    warnings.push(resultLikeUnconsumed === 1
      ? `1 line that looks like a result was not parsed; review the unconsumed lines. Overall score capped at ${CAPS.resultLikeUnconsumed}.`
      : `${resultLikeUnconsumed} lines that look like results were not parsed; review the unconsumed lines. Overall score capped at ${CAPS.resultLikeUnconsumed}.`);
  }
  if (!pagesComplete) {
    warnings.push(`The report declares ${declared} pages but only ${seen} ${seen === 1 ? 'was' : 'were'} found; the PDF may be truncated.`);
  } else if (declared == null) {
    warnings.push('No "Page X of Y" markers were found, so page completeness could not be verified.');
  }
  const missingImportant = IMPORTANT_FIELDS.filter((p) => fields[p].status === 'missing');
  if (missingImportant.length) {
    warnings.push(`Optional field${missingImportant.length > 1 ? 's' : ''} not found: ${missingImportant.map(fieldLabel).join(', ')}.`);
  }
  if (results.length === 0) warnings.push('No result rows were recognized.');
  else if (withIssues > 0) warnings.push(`${withIssues} of ${results.length} results have a missing or uncertain value, unit, range or flag.`);
  for (const n of pr.notes || []) if (n) warnings.push(String(n));

  overall = round3(clamp01(overall));
  const label = overall >= LABEL_THRESHOLDS.complete ? 'complete' : overall >= LABEL_THRESHOLDS.review ? 'review' : 'incomplete';

  return {
    overall,
    label,
    fields,
    coverage: { totalLines, consumedLines, unconsumed, resultLikeUnconsumed },
    pages: pagesInfo,
    results: resultsInfo,
    warnings,
  };
}
