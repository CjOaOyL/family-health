// Coverage audit and confidence scoring. Implements docs/SPEC.md §5 exactly.
import { REQUIRED_FIELDS, IMPORTANT_FIELDS, getPath } from '../model/schema.js';
import { parsePageOf, isTextValue, isUnitToken, UNIT_RE, FLAG_TOKEN_RE, parseRange, isNARangeText, clean } from '../parse/common.js';

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
export function resultLike(line, { strict = false } = {}) {
  if (strict) return resultRowLike(line);
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
// Strict result-row shape (used for lines the parser consumed as comments / wrapped names)
// ---------------------------------------------------------------------------------------------

/** First cell of a result row: short, label-free, sentence-free test name ("Cholesterol, Total", "25-OH Vitamin D"). */
const NAME_CELL_RE = /^[A-Za-z0-9(][A-Za-z0-9 ,.()\/\-+%#'&]*$/;
const NAME_STOP_RE = /^(?:please\s+note|note|comment|comments|ref|reference|desirable|optimal|interpretation|disclaimer|see\s|the\s|this\s|these\s|for\s|results?\s|patient\s|according|method|performed|\.)/i;
const SENTENCE_WORD_RE = /\b(?:is|are|was|were|the|for|may|should|than|this|these|if|be|been|has|have|using|used|please|note|range|interval|desirable|optimal|according|between|above|below|within|applies|defined|calculated|reported|recommended)\b/i;
const NAME_ABBREV_RE = /\b(?:Estab|Calc|Abs|Tot|Ser|Pl|Ur|Qn|Ql|Dir|Immun|Bld|Bind|Cap|Sat|Avg|Glu|Hgb|Est|Conc|Chol|Trig|Vit|Hydroxy)\.$/i;
const LAB_CODE_RE = /^(?:\d{2}|[A-Z]{2,3})$/;
/** Leading numeric value with optional qualifier and trailing abnormal star: "6.2", "<0.1", ">=60", "1,234", "6.2*", "6.2 *". */
const VALUE_HEAD_RE = /^(?:[<>]=?|≤|≥)?\s*[-+]?(?:\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?|\.\d+)(?:\s*\*)?/;
/** The whole cell is nothing but a range: "3.4-10.8", "<200", "> OR = 45", ">=60", "0.0 – 5.0". */
const RANGE_ONLY_RE = /^(?:[<>]=?|≤|≥|<\s*or\s*=|>\s*or\s*=|less than|greater than|up to)?\s*[-+]?[\d.,]+(?:\s*(?:-|–|—|−|to)\s*[-+]?[\d.,]+|\s*(?:or|and)\s*(?:above|below|higher|lower|greater|less|more))?$/i;

/** Name-like first cell: not a label (no trailing ":"), not a sentence, not a value/unit/flag by itself. */
export function isNameCell(c) {
  const t = clean(c);
  if (!t || t.length > 60) return false;
  if (!NAME_CELL_RE.test(t)) return false;
  if ((t.match(/[A-Za-z]/g) || []).length < 2) return false;      // "A1c", "RBC", "eGFR" qualify; "5" / "%" do not
  if (/\.$/.test(t) && !NAME_ABBREV_RE.test(t)) return false;
  if (NAME_STOP_RE.test(t) || SENTENCE_WORD_RE.test(t)) return false;
  if (VALUE_HEAD_RE.test(t) && /^[<>≤≥]?\s*[-+]?[\d.,]+\s*\*?$/.test(t)) return false;
  if (isUnitToken(t) || FLAG_TOKEN_RE.test(t) || isTextValue(t)) return false;
  return true;
}

/** A value cell: number[qualifier][*] optionally followed only by flag / unit tokens ("104 H", "7.9 Thousand/uL", "6.2* %"). */
export function isValueCell(c) {
  const t = clean(c);
  const m = t.match(VALUE_HEAD_RE);
  if (!m) return false;
  const rest = t.slice(m[0].length).trim();
  if (!rest) return true;
  if (/^[\/:\d]/.test(rest)) return false;              // "01/15/1980", "1:40", "063-123-4567"
  return rest.split(/\s+/).every((tok) => FLAG_TOKEN_RE.test(tok) || isUnitToken(tok) || /^\((?:calc|calculated)\)$/i.test(tok));
}

/** A reference-range cell (unit suffix allowed): "3.4-10.8", "<200 mg/dL", "> OR = 45 mg/dL", "Not Estab.", "Negative". */
export function isRangeCell(c) {
  const t = clean(c).replace(/\s*\([^)]*\)\s*$/, '');
  if (!t) return false;
  const toks = t.split(/\s+/);
  while (toks.length > 1 && isUnitToken(toks[toks.length - 1])) toks.pop();
  const core = toks.join(' ');
  if (isNARangeText(core) || isCellTextValue(core)) return true;
  const pr = parseRange(core);
  if (pr.kind == null || pr.kind === 'text') return false;
  return RANGE_ONLY_RE.test(core);
}

const isTailCell = (c) => {
  const t = clean(c);
  return !!t && (FLAG_TOKEN_RE.test(t) || isUnitToken(t.replace(/\s*\([^)]*\)\s*$/, '')) || LAB_CODE_RE.test(t) || isRangeCell(t) || isCellTextValue(t));
};

/**
 * resultRowLike(line): strict table-row shape, used for lines the parser consumed as a comment or wrapped name.
 * Requires the line to START with a name-like cell followed by a numeric cell, i.e.
 *   "<Name> <number[qualifier][*]> [flag] [unit] [range] [labcode]"   (≥2 cells, every trailing cell row-shaped), or
 *   ≥3 cells with a name cell, a numeric cell and a unit/range cell (all other cells row-shaped), or
 *   ≥3 cells with a name cell, a known text value ("NEGATIVE", "Non Reactive") and only text/range/lab-code cells after it.
 * Prose that merely mentions a number and a unit ("Desirable range <100 mg/dL for primary prevention") is NOT a row,
 * because it is a single cell and does not start with a name cell followed by a numeric cell.
 */
export function resultRowLike(line) {
  const text = typeof line === 'string' ? line : (line && line.text) || '';
  if (!text.trim() || isBoilerplate(text)) return false;
  const raw = typeof line === 'string' || !Array.isArray(line.cells) ? text.split(/\s{2,}/) : line.cells;
  const cells = raw.map((c) => clean(c)).filter(Boolean);
  if (cells.length < 2 || !isNameCell(cells[0])) return false;
  const tail = cells.slice(1);
  if (isValueCell(cells[1]) && tail.slice(1).every(isTailCell)) return true;
  if (cells.length >= 3) {
    if (tail.some(isValueCell) && tail.some((c) => isUnitToken(c) || isRangeCell(c)) && tail.every((c) => isValueCell(c) || isTailCell(c))) return true;
    if (isCellTextValue(cells[1]) && tail.slice(1).every((c) => isCellTextValue(c) || LAB_CODE_RE.test(c) || isRangeCell(c))) return true;
  }
  return false;
}

/** Consumed-line tags that hide a line from the unconsumed list but may still have swallowed a result row. */
export const SUSPICIOUS_TAG_RE = /^comment|wrap/i;

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
    // Range (§5): the penalty applies only when NO interval text was printed. A printed text interval is never
    // penalized: N/A-style text ("Not Estab.", "N/A", "See Note", "Negative", ...) is status 'na'; any other text
    // interval IS a range and counts as found.
    const rr = result.referenceRange || {};
    const rangePrinted = rr.text != null && String(rr.text).trim() !== '';
    const rangeNA = fs.range === 'na' || (rangePrinted && isNARangeText(rr.text));
    const rangeMissing = !rangeNA && !rangePrinted && (fs.range === 'missing' || fs.range !== 'found');
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
  const suspiciousConsumed = [];
  let totalLines = 0;
  let consumedLines = 0;
  let declared = null;
  for (const page of pages) {
    for (const line of page.lines || []) {
      totalLines++;
      const po = parsePageOf(line.text);
      if (po && (declared == null || po.of > declared)) declared = po.of;
      if (consumed.has(line.id)) {
        consumedLines++;
        // Audit blindness guard: a line swallowed as a comment (or as a wrapped-name continuation) that itself has the
        // full shape of a result row was most likely a dropped result. Count it like an unconsumed result-like line.
        const tag = String(consumed.get(line.id) ?? '');
        if (SUSPICIOUS_TAG_RE.test(tag) && resultRowLike(line)) {
          suspiciousConsumed.push({ lineId: line.id, page: line.page ?? page.pageNumber, text: line.text, tag });
        }
        continue;
      }
      unconsumed.push({ lineId: line.id, page: line.page ?? page.pageNumber, text: line.text, resultLike: resultLike(line) });
    }
  }
  const resultLikeUnconsumed = unconsumed.filter((u) => u.resultLike).length;
  const resultLikeTotal = resultLikeUnconsumed + suspiciousConsumed.length;

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
  const coverageFrac = 1 - resultLikeTotal / Math.max(1, results.length + resultLikeTotal);
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
  if (suspiciousConsumed.length > 0) {
    overall = Math.min(overall, CAPS.resultLikeUnconsumed);
    const n = suspiciousConsumed.length;
    const ids = suspiciousConsumed.map((s) => s.lineId).join(', ');
    warnings.push(`${n} line${n === 1 ? '' : 's'} consumed as comments look${n === 1 ? 's' : ''} like result row${n === 1 ? '' : 's'} (${ids}); the parser may have dropped ${n === 1 ? 'this result' : 'these results'}. Overall score capped at ${CAPS.resultLikeUnconsumed}.`);
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
    coverage: { totalLines, consumedLines, unconsumed, resultLikeUnconsumed, suspiciousConsumed, resultLikeTotal },
    pages: pagesInfo,
    results: resultsInfo,
    warnings,
  };
}
