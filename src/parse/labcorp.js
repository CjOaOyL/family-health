// Labcorp patient-report parser. See docs/SPEC.md §4 and §6.
// Handles the classic layout ("Patient Details / Specimen Details / Physician Details",
// "TESTS RESULT FLAG UNITS REFERENCE INTERVAL LAB") and the newer portal label set
// ("Patient:", "Date of Birth:", "Specimen #:", "Test Name Result Flag Units Reference Interval Lab").
// Pure: no I/O, no network, isomorphic.
//
// Row recognition: cells are assigned to the columns learned from the table header by position, then
// sanity-checked by shape (a RESULT cell must parse as a value, UNITS must be unit-like, REF must be a
// range, LAB a 2-digit code) with neighbour-column repair, so right-aligned values and rows that drift
// relative to the header still land in the right slot. A line that looks like a result but cannot be
// parsed as a row is never silently consumed as a comment: it is retried with a relaxed token split and,
// failing that, left unconsumed so the audit surfaces it.

import { emptyReport, emptyResult } from '../model/schema.js';
import {
  parseUSDate, parseValue, parseRange, normalizeFlag, isUnitToken, splitName, normalizeSex,
  normalizeYesNo, parsePageOf, clean, parseAge, isTextValue,
} from './common.js';
import { resultLike } from '../audit/confidence.js';

export const LABCORP_PARSER_VERSION = '1.1.0';

const COL_TOL = 20;          // PDF units of slack when assigning a cell to a learned column (symmetric)
const ACCT_TOL = 16;         // x slack for account-block continuation lines
const INDENT = 3;            // x offset that counts as "indented" relative to the name column
const ACCOUNT_BLOCK_LINES = 4;   // the account name/address window below "Account Number:" (lines)
const CHAR_W_RATIO = 0.55;   // estimated glyph width as a fraction of font height when item widths are unknown

// ---------- label vocabulary (both classic and portal label sets) ----------
const LABEL_DEFS = [
  ['Date of Birth', 'dob'], ['Birth Date', 'dob'], ['DOB', 'dob'],
  ['Patient ID', 'patientId'], ['Patient Name', 'patientName'], ['Patient', 'patientName'],
  ['Age', 'age'], ['Gender', 'sex'], ['Sex', 'sex'],
  ['Date collected', 'collected'], ['Collection Date', 'collected'], ['Collected', 'collected'],
  ['Date received', 'received'], ['Received', 'received'],
  ['Date entered', 'entered'], ['Entered', 'entered'],
  ['Date reported', 'reported'], ['Reported', 'reported'],
  ['Date Issued', 'issued'],
  ['Specimen ID', 'specimenId'], ['Specimen Number', 'specimenId'], ['Specimen No', 'specimenId'],
  ['Specimen #', 'specimenId'], ['Specimen', 'specimenId'],
  ['Fasting', 'fasting'],
  ['Ordering Physician', 'ordering'], ['Ordering Provider', 'ordering'], ['Ordering', 'ordering'],
  ['Referring Physician', 'referring'], ['Referring Provider', 'referring'], ['Referring', 'referring'],
  ['NPI', 'npi'], ['Physician ID', 'physicianId'], ['ID', 'physicianId'],
  ['Account Number', 'account'], ['Account #', 'account'], ['Acct #', 'account'], ['Account', 'account'],
  ['Phone', 'phone'], ['Fax', 'fax'], ['Rte', 'route'], ['Route', 'route'],
  ['Ordered Items', 'ordered'], ['Control ID', 'controlId'], ['Alternate Control Number', 'controlId'],
  ['Control Number', 'controlId'], ['Address', 'address'],
];
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
const LABEL_ALT = LABEL_DEFS.map((d) => d[0]).sort((a, b) => b.length - a.length).map(escRe).join('|');
const LABEL_KEY = new Map(LABEL_DEFS.map(([l, k]) => [l.toLowerCase().replace(/\s+/g, ' '), k]));
const labelKey = (txt) => LABEL_KEY.get(txt.toLowerCase().replace(/\s+/g, ' ')) || null;
const TAG_OF_KEY = {
  dob: 'patient.dob', patientId: 'patient.patientId', patientName: 'patient.name', age: 'patient.age', sex: 'patient.sex',
  collected: 'specimen.collected', received: 'specimen.received', entered: 'specimen.entered', reported: 'specimen.reported',
  issued: 'dateIssued', specimenId: 'specimen.id', fasting: 'specimen.fasting', ordering: 'provider.ordering',
  referring: 'provider.referring', npi: 'provider.npi', physicianId: 'provider.id', account: 'provider.account',
  phone: 'phone', fax: 'provider.fax', route: 'route', ordered: 'orderedItems', controlId: 'controlId', address: 'address',
};
/** Report field path per label key (for evidence when a value is taken from the line below its label). */
const PATH_OF_KEY = {
  dob: 'patient.dob', patientId: 'patient.patientId', patientName: 'patient.fullName', age: 'patient.ageAtCollection', sex: 'patient.sex',
  collected: 'specimen.collectedAt', received: 'specimen.receivedAt', entered: 'specimen.enteredAt', reported: 'specimen.reportedAt',
  specimenId: 'specimen.specimenId', fasting: 'specimen.fasting', ordering: 'provider.orderingName', referring: 'provider.referringName',
  npi: 'provider.npi', account: 'provider.accountNumber', fax: 'provider.fax',
};

/** Split "DOB: 01/15/1980 Age: 45" into [{key,label,value}], plus any text before the first label. */
function splitLabels(text) {
  const re = new RegExp(`(?:^|\\s)(${LABEL_ALT})\\s*:\\s*`, 'gi');
  const parts = []; let last = null; let m; let prefix = '';
  while ((m = re.exec(text))) {
    if (last) last.value = text.slice(last.end, m.index).trim();
    else prefix = text.slice(0, m.index).trim();
    last = { label: m[1], key: labelKey(m[1]), end: m.index + m[0].length, value: '' };
    parts.push(last);
  }
  if (last) last.value = text.slice(last.end).trim();
  return { prefix, parts };
}

/**
 * Shape of a bare value printed on the line BELOW its (empty) label, per label key.
 * Only these shapes may be claimed by a pending label; anything else stays a stray fragment.
 */
const PERSON_RE = /^[A-Za-z][A-Za-z.,'\- ]{1,48}$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9\-]{2,24}$/;
const VALUE_BELOW_SHAPE = {
  ordering: (t) => PERSON_RE.test(t) && !/\d/.test(t),
  referring: (t) => PERSON_RE.test(t) && !/\d/.test(t),
  patientName: (t) => PERSON_RE.test(t) && !/\d/.test(t),
  patientId: (t) => ID_RE.test(t) && /\d/.test(t),
  account: (t) => ID_RE.test(t) && /\d/.test(t),
  npi: (t) => /^\d{10}$/.test(t),
  physicianId: (t) => ID_RE.test(t) && /\d/.test(t),
  specimenId: (t) => /^[A-Za-z0-9][A-Za-z0-9\-]{3,24}$/.test(t) && /\d/.test(t),
  controlId: (t) => ID_RE.test(t) && /\d/.test(t),
  dob: (t) => !!parseUSDate(t), collected: (t) => !!parseUSDate(t), received: (t) => !!parseUSDate(t),
  entered: (t) => !!parseUSDate(t), reported: (t) => !!parseUSDate(t), issued: (t) => !!parseUSDate(t),
  sex: (t) => !!normalizeSex(t),
  age: (t) => /^\d{1,3}/.test(t) && parseAge(t) != null,
  fasting: (t) => normalizeYesNo(t) != null,
  phone: (t) => /^[\d().\-+ ]{7,}$/.test(t),
  fax: (t) => /^[\d().\-+ ]{7,}$/.test(t),
  route: (t) => /^\d{1,4}$/.test(t),
};

// ---------- boilerplate patterns ----------
const WORDMARK_RE = /^(?:Labcorp|LabCorp|LABCORP)(?:\s*®)?$/;
const TITLE_RE = /^(?:Patient\s+Report|Lab\s+Report|Patient\s+Results?|Laboratory\s+Report|Lab\s+Results?\s+Report)$/i;
const STATUS_RE = /^(FINAL|PARTIAL|CORRECTED|PRELIMINARY|AMENDED)\s+REPORT$/i;
const SECTION_RE = /^(?:Patient|Specimen|Physician|Provider|Account|Client)\s+(?:Details|Information)$/i;
const NAME_LINE_RE = /^[A-Z][A-Z'`.\-]*(?:\s[A-Z][A-Z'`.\-]*)*,\s*[A-Z][A-Z'`.\-]*(?:\s[A-Z][A-Z'`.\-]*){0,3}$/;
const COPYRIGHT_RE = /Laboratory\s+Corporation\s+of\s+America|^\(?[cC©]\)?\s*\d{4}|All\s+Rights\s+Reserved/i;
const DISCLAIMER_RE = /private and confidential health information|Results are Flagged in Accordance|Enterprise Report Version|This document contains|for informational purposes|Report\s+Version\s*:|Age Dependent Reference Ranges/i;
const LEGEND_HEAD_RE = /^Performing\s+(?:Lab|Site|Laboratory|Laboratories)s?\s*:?$/i;
const LEGEND_RE = /^(\d{2})\s+(?:([A-Z]{2,3})\s+)?(.+)$/;
const LEGEND_NAME_RE = /^(?:LabCorp|Labcorp|Laboratory Corporation|Dynacare|Esoterix|Monogram|Bioreference|Integrated|Dianon|Litholink|Viromed)/i;
/** Something only a performing-lab legend line carries: director, CLIA, phone label, "ST 12345" zip, "Laboratory". */
const LEGEND_SIGNAL_RE = /\b(?:Lab\s*)?Dir(?:ector)?\s*:|\bCLIA\b|\b(?:Phone|Ph|Tel)\s*:|\b[A-Z]{2}\s+\d{5}(?:-?\d{4})?\b|\bLaborator(?:y|ies)\b/i;
const COMMENT_START_RE = /^(?:please\s+note|note|comment|comments|ref|reference\s+(?:range|interval)|desirable|interpretation|disclaimer|see\s+note|see\s+comment|the\s|this\s|these\s|for\s|results?\s|patient\s|according|test\s+performed|performed\s+(?:by|at)|method|methodology|assay|\*)/i;
/** Words that make a short line a sentence rather than a test name (with/and/of/for/w/ are allowed: "Iron and TIBC"). */
const FUNCTION_WORD_RE = /\b(?:the|is|are|range|should|may|than|was|were|note|please|if|this|that|when|been|has|have|using|used)\b/i;
/** Broader sentence test used only when deciding whether an unparsed result-like line is prose. */
const SENTENCE_RE = /\b(?:the|is|are|was|were|been|has|have|should|may|this|that|these|please|note|than|using|used|of|for|to|with|from|and)\b/i;
const LAB_CODE_RE = /^(?:\d{2}|[A-Z]{2})$/;
const CELL_VALUE_LIKE_RE = /^[<>]?=?\s*[-+]?\d[\d,]*\.?\d*$/;
const NOTE_LABEL_RE = /^(?:please\s+note|note|comment|comments|ref|reference\s+range|interpretation|disclaimer)\s*:?\s*$/i;
/** "Word words: value" — a labelled note such as "Prediabetes: 5.7 - 6.4" or "Diabetes: >6.4". */
const LABEL_NOTE_RE = /^[A-Za-z][^:]{1,40}:\s*\S/;
const FLAG_WORD_RE = /^(?:H|L|HH|LL|A|C|HI|LO|High|Low|Critical|Abnormal|Alert|\*|\*\*)\*?$/i;
const FLAG_TWO_WORD_RE = /^(?:Critical|Crit|Panic)\s+(?:High|Low)$/i;
const EXTRA_UNIT_RE = /^(?:mg\/24\s?hrs?|g\/24\s?hrs?|mL\/min\/1\.73\s?m?\^?2?|titer|ratio|index|x10E\d\/[umµ]?L)$/i;
/** A numeric range that spans two numbers ("8-12", "5.7 - 6.4", "0.0 to 5.0") or a bounded one ("<200", ">=60"). */
const NUMBER_SRC = '[-+]?\\d{1,3}(?:,\\d{3})*(?:\\.\\d+)?|[-+]?\\d*\\.\\d+';
const RANGE_IN_TEXT_RE = new RegExp(`(?<![\\d\\/.\\-:])(?:${NUMBER_SRC})\\s*(?:-|–|—|to)\\s*(?:${NUMBER_SRC})(?![\\d\\-\\/.:])|(?:^|[\\s(])(?:[<>]=?|≤|≥)\\s*\\d`, 'i');
const WHOLE_RANGE_RE = new RegExp(`^(?:(?:[<>]=?|≤|≥)\\s*(?:${NUMBER_SRC})|(?:${NUMBER_SRC})\\s*(?:-|–|—|to)\\s*(?:${NUMBER_SRC}))$`, 'i');

const normName = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const parseFlagWord = (t) => (t == null ? null : normalizeFlag(t));
const isNoteLabelLine = (text) => NOTE_LABEL_RE.test(clean(text));
const isUnit = (s) => !!s && (isUnitToken(s) || EXTRA_UNIT_RE.test(clean(s)));
const isFlagCell = (s) => !!s && (FLAG_WORD_RE.test(clean(s)) || FLAG_TWO_WORD_RE.test(clean(s)));

/** Text value with tolerant spacing ("Non Reactive", "Not Detected", "NOT ESTAB.", "1:40"). Private helper pending common.js. */
function isTextValueLoose(t) {
  const s = clean(t);
  if (!s || isUnit(s)) return false;
  return isTextValue(s) || isTextValue(s.replace(/\s+/g, '-')) || isTextValue(s.replace(/\s+/g, ''));
}

/** Reference-interval shaped cell: numeric range/bound, text value ("Negative", "Not Estab."), titer bound ("<1:80"). */
function isRangeLike(t) {
  const s = clean(t);
  if (!s || LAB_CODE_RE.test(s) || isUnit(s) || isFlagCell(s)) return false;
  const pr = parseRange(s);
  if (pr.kind && pr.kind !== 'text') return true;
  if (isTextValueLoose(s)) return true;
  if (/^[<>]?=?\s*\d+:\d+$/.test(s)) return true;
  if (/^(?:not\s+estab|n\/?a$|none$|see\s+(?:note|below|comment)|negative|normal|non[-\s]?reactive|not\s+detected|[<>]=?\s*\d|[≤≥]\s*\d)/i.test(s)) return true;
  return false;
}

/** Numeric token followed by a unit token anywhere in the text ("<20 ng/mL", "6.5%", "100 mg/dL"). */
function hasNumberWithUnit(text) {
  const toks = clean(text).replace(/[,;.]$/, '').split(' ');
  for (let i = 0; i < toks.length; i++) {
    const tok = toks[i].replace(/[,;]$/, '');
    if (/^[<>]?=?[-+]?\d[\d,]*\.?\d*%$/.test(tok)) return true;
    if (!/^[<>]?=?[-+]?\d[\d,]*\.?\d*$/.test(tok)) continue;
    const nx = toks[i + 1] ? toks[i + 1].replace(/[,;.]$/, '') : '';
    if (nx && (isUnit(nx) || (toks[i + 2] && isUnit(`${nx} ${toks[i + 2].replace(/[,;.]$/, '')}`)))) return true;
  }
  return false;
}

/**
 * Parse a RESULT cell that may carry its flag and/or unit: "142", "142 Low", "6.1 Critical", "142 mg/dL Low",
 * "6.2*", "6.5%", "NOT DETECTED", "1:40", ">1:640". Returns
 * { valueText, value, qualifier, isText, unit, flag, flagRaw, star } or null when the cell is not a value.
 * valueText is kept as printed (including a trailing "*"); a trailing star sets flag 'A' (SPEC §6).
 */
function parseValueCell(raw) {
  let t = clean(raw);
  if (!t) return null;
  let flagRaw = null, unit = null;
  const words = t.split(' ');
  for (let pass = 0; pass < 3 && words.length > 1; pass++) {
    const last = words[words.length - 1];
    const last2 = words.length > 2 ? `${words[words.length - 2]} ${last}` : null;
    if (!flagRaw && last2 && FLAG_TWO_WORD_RE.test(last2)) { flagRaw = last2; words.splice(-2); continue; }
    if (!flagRaw && FLAG_WORD_RE.test(last) && !/^\*+$/.test(last)) { flagRaw = last; words.pop(); continue; }
    if (!flagRaw && /^\*+$/.test(last)) { flagRaw = last; words.pop(); continue; }
    if (!unit && last2 && isUnit(last2)) { unit = last2; words.splice(-2); continue; }
    if (!unit && isUnit(last)) { unit = last; words.pop(); continue; }
    break;
  }
  if (!flagRaw && words.length > 1 && FLAG_WORD_RE.test(words[0]) && !/^\*+$/.test(words[0]) && /^[<>]?=?[-+]?[\d.]/.test(words[1])) flagRaw = words.shift();
  let core = words.join(' ');
  if (!core) return null;
  let star = false;
  const sm = core.match(/^(.*?[^\s*])\s*(\*+)$/);
  if (sm) { core = sm[1]; star = true; }
  let pv = parseValue(core);
  if (pv && pv.isText && /^\*+$/.test(core)) pv = null;
  if (!pv) {
    const g = core.match(/^([<>]?=?\s*[-+]?[\d,]*\.?\d+)\s*(%|[A-Za-z][A-Za-z0-9\/.^]*)$/);
    if (g && !unit && isUnit(g[2])) { const p2 = parseValue(g[1]); if (p2) { pv = p2; unit = g[2]; } }
  }
  if (!pv && isTextValueLoose(core) && !isFlagCell(core)) pv = { valueText: core, value: null, qualifier: null, isText: true };
  if (!pv) return null;
  let flag = flagRaw ? parseFlagWord(flagRaw) : null;
  if (!flag && star) flag = 'A';
  const printed = star ? `${pv.valueText}*` : pv.valueText;
  return { valueText: printed, value: pv.value, qualifier: pv.qualifier, isText: pv.isText, unit, flag, flagRaw, star };
}

/** Short, label-free, sentence-free text that could be (part of) a test name or a panel heading. */
function isNameLike(text) {
  const t = clean(text);
  if (!t || t.length > 44) return false;
  if (!/^[A-Za-z0-9(\[]/.test(t)) return false;
  if (/[:;!?]$/.test(t)) return false;
  if (LABEL_NOTE_RE.test(t)) return false;                         // "Prediabetes: 5.7 - 6.4"
  if (/\.$/.test(t) && !/\b(?:Estab|Calc|Abs|Tot|Ser|Pl|Ur|Qn|Ql|Dir|Immun|Bld|Bind|Cap|Sat|Avg|Glu|Hgb|Est|Conc)\.$/i.test(t)) return false;
  if (COMMENT_START_RE.test(t)) return false;
  if (FUNCTION_WORD_RE.test(t)) return false;
  if (CELL_VALUE_LIKE_RE.test(t)) return false;
  if (hasNumberWithUnit(t)) return false;                           // "<20 ng/mL", "6.5%"
  if (RANGE_IN_TEXT_RE.test(t)) return false;                       // "Fasting 8-12 hours", "Diabetes: >6.4"
  const pr = parseRange(t);
  if (pr.kind && pr.kind !== 'text') return false;
  return true;
}

/** Title-case heading: every word capitalised or an acronym/number, no terminal punctuation ("Thyroid Panel With TSH"). */
function isTitleCase(text) {
  const t = clean(text);
  if (!t || t.length > 44 || /[.:;!?]$/.test(t)) return false;
  const words = t.split(' ');
  if (words.length > 7) return false;
  return words.every((w) => /^(?:[A-Z0-9(][^\s]*|w\/[^\s]*|with|and|of|for|or)$/.test(w)) && /^[A-Z]/.test(t);
}

const SLOTS = ['name', 'result', 'flag', 'units', 'ref', 'lab'];

// ---------- main ----------
/**
 * @param {object} doc  Document (SPEC §2)
 * @returns {{ report: object, consumed: Map<string,string>, notes: string[], fieldEvidence: Record<string,string[]> }}
 */
export function parseLabcorp(doc) {
  const report = emptyReport();
  delete report.audit;
  const consumed = new Map();
  const notes = [];
  const fieldEvidence = {};
  const uncertain = new Set();

  report.id = doc.fileHash || null;
  report.source = {
    vendor: 'labcorp', vendorConfidence: 1, fileName: doc.fileName || null, fileHash: doc.fileHash || null,
    pageCount: doc.pageCount || (doc.pages ? doc.pages.length : 0), parserVersion: LABCORP_PARSER_VERSION,
    parsedAt: new Date().toISOString(), reportStatus: null,
  };

  const addEvidence = (path, lineId) => {
    if (!lineId) return;
    const arr = fieldEvidence[path] || (fieldEvidence[path] = []);
    if (!arr.includes(lineId)) arr.push(lineId);
  };
  const getPath = (path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), report);
  const setPathRaw = (path, value) => {
    const ks = path.split('.'); let o = report;
    for (let i = 0; i < ks.length - 1; i++) o = o[ks[i]];
    o[ks[ks.length - 1]] = value;
  };
  /** First non-null wins; a differing later value is a conflict → note (field path + line ids only) + 'uncertain'. */
  const setField = (path, value, lineId) => {
    if (value == null || value === '') return;
    const cur = getPath(path);
    if (cur == null) setPathRaw(path, value);
    else if (String(cur) !== String(value)) {
      if (!uncertain.has(path)) {
        const first = (fieldEvidence[path] || [])[0] || '?';
        notes.push(`conflict:${path}: value at ${lineId} differs from ${first} (first kept)`);
      }
      uncertain.add(path);
    }
    addEvidence(path, lineId);
  };
  const setDateField = (path, raw, lineId, tzPath) => {
    if (!raw) return;
    const d = parseUSDate(raw);
    if (!d) { notes.push(`Could not parse the date for ${path} at ${lineId}`); return; }
    setField(path, d.iso, lineId);
    if (tzPath && d.tz) setField(tzPath, d.tz, lineId);
  };

  // document-level state
  let cols = null;                 // [{key,x}] sorted by x, learned from the table header line
  const orderedItems = [];         // normalized panel names from "Ordered Items"
  const orderedRaw = [];
  let currentPanel = null;         // { name, resultIds, page }
  let lastResult = null;
  let dateIssued = null; let dateIssuedLine = null;
  let declaredPages = null;
  let rid = 0;

  const pages = doc.pages || [];
  for (const page of pages) {
    const lines = page.lines || [];
    const pageWidth = page.width || 612;
    const pageHeight = page.height || 792;
    const pageMinX = lines.length ? Math.min(...lines.map((l) => l.x0 ?? (l.cellX && l.cellX[0]) ?? 0)) : 36;
    const nameX = () => (cols ? cols[0].x : pageMinX);

    // per-page state
    let inTable = false;
    let inFooter = false;
    let accountX = null; let accountLeft = 0; let accountNameSet = false;
    const addrParts = [];
    let orderedOpen = false; let orderedText = '';
    let openComment = null;      // { text, page, lineIds, attachedTo } (+ non-enumerable result)
    let pendingName = null;      // { text, lineId, x0 } name fragment waiting for its value line
    let prevKind = null;         // 'row' | 'wrap' | 'panel' | 'comment' | 'other'
    let lastLegend = null;
    let pendingLabels = [];      // labels printed with an empty value on the previous header line
    let curPendingLabels = [];

    const consume = (line, tag) => { consumed.set(line.id, tag); };
    const closeComment = () => { openComment = null; };
    const flushOrdered = () => {
      if (!orderedOpen) return;
      orderedOpen = false;
      for (const item of orderedText.split(/;|\n/).map((s) => clean(s)).filter(Boolean)) {
        if (!orderedItems.includes(normName(item))) { orderedItems.push(normName(item)); orderedRaw.push(item); }
      }
      orderedText = '';
    };
    const finishAccountAddress = () => {
      if (!addrParts.length) return;
      setField('provider.address', addrParts.map((p) => p.text).join(', '), addrParts[0].lineId);
      for (const p of addrParts) addEvidence('provider.address', p.lineId);
      addrParts.length = 0;
    };

    // ---- cell geometry ----
    const cellGeom = (line) => {
      const cells = line.cells && line.cells.length ? line.cells : [line.text];
      const xs = line.cellX && line.cellX.length === cells.length ? line.cellX : null;
      const items = Array.isArray(line.items) ? line.items : [];
      const h = items.length && items[0].h ? items[0].h : 8;
      const widths = cells.map((c, i) => {
        if (xs && items.length) {
          const lo = xs[i], hi = i + 1 < xs.length ? xs[i + 1] : Infinity;
          const its = items.filter((it) => it.x >= lo - 0.5 && it.x < hi - 0.5);
          if (its.length) return Math.max(...its.map((it) => it.x + (it.w || 0))) - lo;
        }
        return clean(c).length * CHAR_W_RATIO * h;
      });
      return { cells, xs, widths };
    };
    /** Column key for a left edge: the right-most learned column whose anchor is within COL_TOL to the right. */
    const colOf = (x) => {
      let key = cols[0].key;
      for (const c of cols) if (x >= c.x - COL_TOL) key = c.key;
      return key;
    };

    /**
     * Assign cells to row slots. `geo` (column keys by position) is null in the shape-based fallback.
     * Each cell goes to its geometric column when its text fits that column's shape, else to the first
     * empty slot it does fit; a cell nobody can take becomes an "extra" (comment text).
     */
    const resolveCells = (cells, geo, xs, widths) => {
      const slots = { name: null, result: null, flag: null, units: null, ref: null, lab: null };
      let last = -1; let misaligned = false; let loose = false; const extra = [];
      const n = cells.length;
      const fits = (k, t) => {
        switch (k) {
          case 'name': return !parseValueCell(t) && !isUnit(t) && !LAB_CODE_RE.test(t) && !isFlagCell(t) && !isRangeLike(t);
          case 'result': return !!parseValueCell(t);
          case 'flag': return isFlagCell(t);
          case 'units': return isUnit(t);
          case 'ref': return isRangeLike(t);
          case 'lab': return LAB_CODE_RE.test(t);
          default: return false;
        }
      };
      for (let i = 0; i < n; i++) {
        let t = clean(cells[i]);
        if (!t) continue;
        const g = geo ? geo[i] : null;
        const isLastCell = i === n - 1;
        // a lab code glued to the end of the last cell ("0.0-5.0 01", "Not Estab. 01")
        if (isLastCell && !slots.lab && /\s\d{2}$/.test(t) && !parseValueCell(t)) {
          const mm = t.match(/^(.*\S)\s+(\d{2})$/);
          if (mm && (isRangeLike(mm[1]) || isUnit(mm[1]) || parseValueCell(mm[1]))) { slots.lab = mm[2]; t = mm[1]; }
        }
        const farRight = xs ? xs[i] > pageWidth * 0.82 : false;
        let cands;
        if (g) {
          cands = [g];
          if (isLastCell && LAB_CODE_RE.test(t) && g !== 'result') cands.push('lab');
          // a non-value at the RESULT position with the result still empty stays a (loose) value rather than
          // migrating to REF: "0-2" (RBC, UA) is a printed value, not the row's interval
          const pool = g === 'result' && !slots.result ? ['flag', 'units', 'lab'] : SLOTS.slice(1);
          for (const k of pool) if (!cands.includes(k)) cands.push(k);
          // the name never follows a value: a name-shaped cell to the right of filled slots is an extra
          if (g === 'name' && last > 0) cands = cands.filter((k) => k !== 'name');
        } else if (i === 0) {
          cands = ['name', 'result'];
        } else {
          cands = SLOTS.slice(last + 1);
          if (isLastCell && LAB_CODE_RE.test(t) && (slots.result || farRight)) cands = ['lab', ...cands];
        }
        let chosen = null;
        for (const k of cands) {
          if (slots[k]) continue;
          if (k === 'lab' && g !== 'lab' && !(isLastCell && (slots.result || farRight || g))) continue;
          if (k === 'lab' && !isLastCell && g !== 'lab') continue;
          if (fits(k, t)) { chosen = k; break; }
        }
        if (!chosen) {
          if ((g === 'name' && last <= 0) || (!g && i === 0)) { slots.name = slots.name ? `${slots.name} ${t}` : t; last = Math.max(last, 0); continue; }
          if (g === 'result' && !slots.result) { slots.result = t; loose = true; last = Math.max(last, 1); continue; }
          extra.push(t); continue;
        }
        slots[chosen] = t;
        if (g && chosen !== g) {
          // a value whose right edge sits just before its geometric column's anchor is right-aligned, not misplaced
          const anchor = cols.find((c) => c.key === g);
          const right = xs ? xs[i] + (widths ? widths[i] : 0) : null;
          const rightAligned = right != null && anchor && SLOTS.indexOf(chosen) < SLOTS.indexOf(g) && right <= anchor.x + 4 && right >= anchor.x - 28;
          if (!rightAligned) misaligned = true;
        }
        last = Math.max(last, SLOTS.indexOf(chosen));
      }
      return { slots, misaligned, loose, extra };
    };

    /** Interpret a line as a result row (pure; returns null when not row-shaped). */
    const probeCells = (cells, xs, widths, geo) => {
      const { slots, misaligned, loose, extra } = resolveCells(cells, geo, xs, widths);
      const name = slots.name;
      if (name && (/:\s*$/.test(name) || isNoteLabelLine(name) || splitLabels(name).parts.length)) return null;
      if (!slots.result) return null;
      let pv = parseValueCell(slots.result);
      if (!pv) {
        if (!loose) return null;
        const words = slots.result.split(' ');
        const other = slots.flag || slots.units || slots.ref || slots.lab;
        if (words.length <= 3 && other && !/[:]/.test(slots.result) && /^[A-Za-z<>0-9]/.test(slots.result) && !isUnit(slots.result) && !isFlagCell(slots.result)) {
          pv = { valueText: slots.result, value: null, qualifier: null, isText: true, unit: null, flag: null, flagRaw: null, star: false };
        } else return null;
      }
      if (!name && !geo && !pendingName) return null;
      return {
        name, valueText: pv.valueText, value: pv.value, qualifier: pv.qualifier, isText: pv.isText,
        unit: slots.units || pv.unit || null, flagRaw: slots.flag || null, inlineFlag: pv.flag, inlineFlagRaw: pv.flagRaw,
        refRaw: slots.ref, lab: slots.lab, misaligned, extra,
      };
    };
    const probeRow = (line) => {
      const { cells, xs, widths } = cellGeom(line);
      const geo = cols && xs ? xs.map((x) => colOf(x)) : (cols ? cells.map(() => 'name') : null);
      return probeCells(cells, xs, widths, geo);
    };

    /**
     * Relaxed retry for a result-like line the row probe rejected: split the text on single spaces and
     * read name | value [flag] [unit] [range] [lab] left to right. Returns { row } when the structure
     * parses cleanly, { comment: true } when the line is prose / a labelled note, { lost: true } when it
     * has the structure of a row but no name to attach it to (left unconsumed by the caller), or null.
     */
    const probeRelaxed = (line) => {
      const text = clean(line.text);
      if (!text) return null;
      if (LABEL_NOTE_RE.test(text)) return { comment: true };
      const toks = text.split(' ');
      let vi = -1; let pv = null; let span = 1;
      for (let i = 0; i < toks.length; i++) {
        const tok = toks[i];
        if ((i === toks.length - 1 && LAB_CODE_RE.test(tok)) || isFlagCell(tok)) continue;   // a lab code only ends a row
        const two = i + 1 < toks.length ? `${tok} ${toks[i + 1]}` : null;
        if (two && isTextValueLoose(two) && !isFlagCell(two)) { pv = parseValueCell(two); vi = i; span = 2; break; }
        const p = parseValueCell(tok);
        if (p && (p.value != null || /\d+:\d+/.test(tok) || (p.isText && !isFlagCell(tok)))) { pv = p; vi = i; break; }
      }
      if (!pv) return null;
      const nameToks = toks.slice(0, vi);
      const name = nameToks.join(' ');
      if (name && (SENTENCE_RE.test(name) || nameToks.length > 7 || /:$/.test(name))) return { comment: true };
      let j = vi + span;
      let flagRaw = null, unit = pv.unit, refRaw = null, lab = null;
      const takeFlag = () => {
        if (flagRaw || j >= toks.length) return;
        const two = j + 1 < toks.length ? `${toks[j]} ${toks[j + 1]}` : null;
        if (two && FLAG_TWO_WORD_RE.test(two)) { flagRaw = two; j += 2; }
        else if (FLAG_WORD_RE.test(toks[j])) { flagRaw = toks[j]; j += 1; }
      };
      const takeUnit = () => {
        if (unit || j >= toks.length) return;
        const two = j + 1 < toks.length ? `${toks[j]} ${toks[j + 1]}` : null;
        if (two && isUnit(two)) { unit = two; j += 2; }
        else if (isUnit(toks[j])) { unit = toks[j]; j += 1; }
      };
      takeFlag(); takeUnit(); takeFlag();
      for (const k of [3, 2, 1]) {
        if (j + k > toks.length) continue;
        const cand = toks.slice(j, j + k).join(' ');
        const core = cand.replace(/\s*\([^)]*\)\s*$/, '');
        if (WHOLE_RANGE_RE.test(core) || (isTextValueLoose(core) && !isFlagCell(core)) || /^[<>]?=?\s*\d+:\d+$/.test(core)) { refRaw = cand; j += k; break; }
      }
      if (j === toks.length - 1 && LAB_CODE_RE.test(toks[j])) { lab = toks[j]; j += 1; }
      if (j < toks.length) return { comment: true };                 // trailing prose → not a row
      if (!name && !pendingName) return (unit || refRaw || lab) ? { lost: true } : null;
      return { row: { name: name || null, valueText: pv.valueText, value: pv.value, qualifier: pv.qualifier, isText: pv.isText,
        unit: unit || null, flagRaw, inlineFlag: pv.flag, inlineFlagRaw: pv.flagRaw, refRaw, lab, misaligned: true, extra: [] } };
    };

    // ---- footer helpers ----
    const parseLegend = (line) => {
      const text = clean(line.text);
      const m = text.match(LEGEND_RE);
      if (!m) return null;
      const code = m[1]; const abbr = m[2] || null;
      let cells = (line.cells && line.cells.length > 1) ? line.cells.map(clean) : [m[3]];
      if (line.cells && line.cells.length > 1) {
        cells[0] = clean(cells[0].replace(new RegExp(`^${code}\\s*(?:${abbr || ''})?\\s*`), ''));
        if (!cells[0]) cells.shift();
        if (abbr && cells[0] === abbr) cells.shift();
      }
      const lab = { code, name: null, address: null, director: null, clia: null, phone: null };
      const addr = [];
      const takeTagged = (s) => {
        let sm;
        if ((sm = s.match(/^(?:Lab\s+)?Dir(?:ector)?\s*:\s*(.*)$/i))) { lab.director = sm[1] || null; return true; }
        if ((sm = s.match(/^(?:Phone|Ph|Tel)\s*:\s*(.*)$/i))) { lab.phone = sm[1] || null; return true; }
        if ((sm = s.match(/^CLIA\s*(?:#|No\.?)?\s*:?\s*(.*)$/i))) { lab.clia = sm[1] || null; return true; }
        return false;
      };
      for (const c of cells) {
        if (takeTagged(c)) continue;
        if (lab.name == null) {
          // possibly unsplit: "LabCorp Burlington 1447 York Court, ... Dir: ... Phone: ..."
          const segs = c.split(/\s+(?=(?:Lab\s+)?(?:Dir(?:ector)?|Phone|Ph|Tel|CLIA)\s*:)/i);
          const head = segs.shift();
          const hm = head.match(/^(.*?)\s+(\d+\s.*)$/);
          if (hm && LEGEND_NAME_RE.test(hm[1])) { lab.name = hm[1]; addr.push(hm[2]); } else lab.name = head;
          for (const s of segs) takeTagged(s);
          continue;
        }
        addr.push(c);
      }
      lab.address = addr.length ? addr.join(', ') : null;
      return lab;   // the 2-letter site abbreviation (BN/SE) is not modeled in SPEC §3
    };
    const addLab = (lab, lineId) => {
      const cur = report.performingLabs.find((l) => l.code === lab.code);
      if (!cur) { report.performingLabs.push(lab); lastLegend = lab; }
      else {
        if (cur.name && lab.name && normName(cur.name) !== normName(lab.name)) {
          const first = (fieldEvidence.performingLabs || [])[0] || '?';
          notes.push(`conflict:performingLabs.${lab.code}: legend at ${lineId} differs from ${first} (first kept)`); uncertain.add('performingLabs');
        }
        for (const k of ['name', 'address', 'director', 'clia', 'phone']) if (cur[k] == null && lab[k] != null) cur[k] = lab[k];
        lastLegend = cur;
      }
      addEvidence('performingLabs', lineId);
    };
    /** True when no later line on this page is row-shaped (the legend zone below the table). */
    const inFooterZone = (li, line) => {
      if (line.y != null && line.y < pageHeight * 0.6) return false;
      for (let k = li + 1; k < lines.length; k++) if (probeRow(lines[k])) return false;
      return true;
    };
    const footerCellTag = (cell, lineId) => {
      const t = clean(cell);
      if (!t) return 'blank';
      const po = parsePageOf(t);
      if (po) {
        if (declaredPages == null) declaredPages = po.of;
        else if (declaredPages !== po.of) notes.push(`conflict:pages: declared ${declaredPages} vs ${po.of} at ${lineId}`);
        if (po.page !== page.pageNumber) notes.push(`Page label says page ${po.page} on physical page ${page.pageNumber} (${lineId})`);
        addEvidence('pages', lineId);
        return 'pageno';
      }
      let m;
      if ((m = t.match(STATUS_RE))) { setField('source.reportStatus', m[1].toLowerCase(), lineId); return 'footer:status'; }
      if ((m = t.match(/^Date\s+Issued\s*:\s*(.*)$/i))) {
        const d = parseUSDate(m[1]);
        if (d && !dateIssued) { dateIssued = d; dateIssuedLine = lineId; }
        return 'footer:dateIssued';
      }
      if (COPYRIGHT_RE.test(t)) return 'footer:copyright';
      if (DISCLAIMER_RE.test(t)) return 'footer:disclaimer';
      if (LEGEND_HEAD_RE.test(t)) return 'footer:labs';
      return null;
    };

    // ---- header helpers ----
    const applyName = (raw, lineId) => {
      const n = splitName(raw);
      setField('patient.fullName', n.fullName, lineId);
      if (getPath('patient.fullName') === n.fullName) {
        setField('patient.lastName', n.lastName, lineId); setField('patient.firstName', n.firstName, lineId);
        setField('patient.middleName', n.middleName, lineId);
      }
    };
    const applyLabel = (p, cx, line) => {
      const v = p.value; const id = line.id;
      if (v === '' && p.key !== 'ordered') curPendingLabels.push({ key: p.key, cx, lineId: id });
      switch (p.key) {
        case 'dob': setDateField('patient.dob', v, id); break;
        case 'age': { const a = parseAge(v); if (a != null) setField('patient.ageAtCollection', a, id); break; }
        case 'sex': { const s = normalizeSex(v); if (s) setField('patient.sex', s, id); else if (v) notes.push(`Unrecognized sex value at ${id}`); break; }
        case 'patientId': setField('patient.patientId', v, id); break;
        case 'patientName': if (v) applyName(v, id); break;
        case 'collected': setDateField('specimen.collectedAt', v, id, 'specimen.collectedTz'); break;
        case 'received': setDateField('specimen.receivedAt', v, id); break;
        case 'entered': setDateField('specimen.enteredAt', v, id); break;
        case 'reported': setDateField('specimen.reportedAt', v, id); break;
        case 'issued': { const d = parseUSDate(v); if (d && !dateIssued) { dateIssued = d; dateIssuedLine = id; } break; }
        case 'specimenId': setField('specimen.specimenId', v, id); break;
        case 'fasting': { const f = normalizeYesNo(v); if (f != null) setField('specimen.fasting', f, id); break; }
        case 'ordering': setField('provider.orderingName', v, id); break;
        case 'referring': setField('provider.referringName', v, id); break;
        case 'npi': setField('provider.npi', v, id); break;
        case 'account': {
          const mm = v.match(/^(\d[\d-]*)\s*(?:[-–:]\s*)?(.*)$/);
          if (mm) { setField('provider.accountNumber', mm[1], id); if (mm[2]) { setField('provider.accountName', mm[2], id); accountNameSet = true; } }
          else if (v) setField('provider.accountNumber', v, id);
          accountX = cx; accountLeft = ACCOUNT_BLOCK_LINES + 1;
          break;
        }
        case 'phone': if (cx < pageWidth * 0.4) setField('patient.phone', v, id); else setField('provider.phone', v, id); break;
        case 'fax': setField('provider.fax', v, id); break;
        case 'address': if (cx < pageWidth * 0.4) setField('patient.address', v, id); else setField('provider.address', v, id); break;
        case 'ordered': orderedOpen = true; orderedText = v; break;
        default: break; // physicianId, route, controlId: consumed, not modeled
      }
    };
    const headerCell = (cell, cx, line) => {
      const t = clean(cell);
      if (!t) return 'blank';
      if (WORDMARK_RE.test(t)) return 'header:wordmark';
      if (TITLE_RE.test(t)) return 'header:title';
      let m;
      if ((m = t.match(/^(Final|Partial|Corrected|Preliminary|Amended)\s+Report$/i))) { setField('source.reportStatus', m[1].toLowerCase(), line.id); return 'header:status'; }
      if (SECTION_RE.test(t)) return 'header:section';
      const { prefix, parts } = splitLabels(t);
      if (parts.length) {
        if (prefix && NAME_LINE_RE.test(prefix)) applyName(prefix, line.id);
        for (const p of parts) applyLabel(p, cx, line);
        return parts.length === 1 ? `header:${TAG_OF_KEY[parts[0].key] || parts[0].key}` : 'header:labels';
      }
      // value printed on the line below its (empty) label, in the same column
      const pl = pendingLabels.find((p) => Math.abs(cx - p.cx) <= ACCT_TOL && VALUE_BELOW_SHAPE[p.key] && VALUE_BELOW_SHAPE[p.key](t));
      if (pl) {
        applyLabel({ key: pl.key, label: pl.key, value: t }, cx, line);
        const path = PATH_OF_KEY[pl.key];
        if (path && (fieldEvidence[path] || []).includes(line.id)) addEvidence(path, pl.lineId);   // the label line is evidence too
        return `header:${TAG_OF_KEY[pl.key] || pl.key}`;
      }
      if (NAME_LINE_RE.test(t) && (!report.patient.fullName || normName(t) === normName(report.patient.fullName))) {
        applyName(t, line.id); return 'header:patient.name';
      }
      // account name/address continuation (same column, directly under "Account Number:")
      if (accountX != null && accountLeft > 0 && Math.abs(cx - accountX) <= ACCT_TOL && !CELL_VALUE_LIKE_RE.test(t)) {
        if (!accountNameSet) { setField('provider.accountName', t, line.id); accountNameSet = true; }
        else addrParts.push({ text: t, lineId: line.id });
        return 'header:account';
      }
      return null;
    };

    // ---- result helpers ----
    const emitResult = (row, line, extraLineIds, wrapped) => {
      const r = emptyResult(`r${++rid}`);
      r.panel = currentPanel ? currentPanel.name : null;
      r.name = clean(row.name || '');
      r.valueText = row.valueText; r.value = row.value; r.valueQualifier = row.qualifier;
      r.unit = row.unit ? clean(row.unit) : null;
      const flagRaw = row.flagRaw || row.inlineFlagRaw || null;
      r.flag = row.flagRaw ? parseFlagWord(row.flagRaw) : (row.inlineFlag || null);
      r.referenceRange = parseRange(row.refRaw);
      r.performingLabCode = row.lab || null;
      r.page = page.pageNumber;
      r.lineIds = [...(extraLineIds || []), line.id];
      const numeric = row.value != null;
      r.fieldStatus.value = row.valueText ? 'found' : 'missing';
      r.fieldStatus.unit = r.unit ? 'found' : (numeric ? 'missing' : 'na');
      const rk = r.referenceRange.kind;
      if (rk == null) r.fieldStatus.range = numeric ? 'missing' : 'na';
      else if (rk === 'text') r.fieldStatus.range = /not\s*estab|n\/a|^na$|not\s+applicable|^none$/i.test(r.referenceRange.text) ? 'na' : 'found';
      else r.fieldStatus.range = 'found';
      r.fieldStatus.flag = r.flag ? 'found' : (flagRaw ? 'uncertain' : 'na');
      // preliminary confidence per SPEC §5 (audit may rescore)
      let conf = 1;
      if (numeric && !r.unit) conf -= 0.25;
      if (numeric && r.fieldStatus.range === 'missing') conf -= 0.25;
      if (!row.valueText) conf -= 0.4;
      if (wrapped) conf -= 0.1;
      if (row.misaligned) conf -= 0.1;
      if (flagRaw && !r.flag) { conf -= 0.1; notes.push(`Unrecognized flag on ${r.id} (${line.id})`); }
      r.confidence = Math.max(0, Math.min(1, Math.round(conf * 100) / 100));
      if (row.misaligned) r.hints = { ...(r.hints || {}), misaligned: true };
      if (wrapped) r.hints = { ...(r.hints || {}), wrapped: true };
      if (row.extra && row.extra.length) r.comment = row.extra.join(' ');
      report.results.push(r);
      if (currentPanel) currentPanel.resultIds.push(r.id);
      lastResult = r;
      return r;
    };
    const wrapBelow = (line, text) => {
      lastResult.name = `${lastResult.name} ${clean(text)}`;
      lastResult.lineIds.push(line.id);
      lastResult.confidence = Math.max(0, Math.round((lastResult.confidence - 0.1) * 100) / 100);
      lastResult.hints = { ...(lastResult.hints || {}), wrapped: true };
      consume(line, `result:${lastResult.id}:wrap`); prevKind = 'wrap';
    };
    const holdName = (line, text, x0) => { pendingName = { text: clean(text), lineId: line.id, x0 }; prevKind = 'wrap'; };
    const startPanel = (name, line) => {
      flushOrdered(); finishAccountAddress();
      currentPanel = { name: clean(name), resultIds: [], page: page.pageNumber };
      report.panels.push(currentPanel);
      consume(line, 'panel');
      inTable = true; closeComment(); pendingName = null; prevKind = 'panel';
    };
    const commentText = (line) => {
      const cells = line.cells && line.cells.length ? line.cells.slice() : [line.text];
      if (cells.length > 1 && LAB_CODE_RE.test(clean(cells[cells.length - 1])) && (!cols || !line.cellX || colOf(line.cellX[cells.length - 1]) === 'lab')) cells.pop();
      return clean(cells.join(' '));
    };
    const addComment = (line, forceNew) => {
      const text = commentText(line);
      const attachTo = (prevKind === 'row' || prevKind === 'wrap' || prevKind === 'comment') && lastResult ? lastResult : null;
      if (openComment && !forceNew && openComment.result === attachTo) {
        openComment.text += `\n${text}`; openComment.lineIds.push(line.id);
        if (attachTo) attachTo.comment = attachTo.comment ? `${attachTo.comment}\n${text}` : text;
      } else {
        openComment = { text, page: page.pageNumber, lineIds: [line.id], attachedTo: attachTo ? attachTo.id : null };
        Object.defineProperty(openComment, 'result', { value: attachTo, enumerable: false, writable: true });
        report.comments.push(openComment);
        if (attachTo) attachTo.comment = attachTo.comment ? `${attachTo.comment}\n${text}` : text;
      }
      if (attachTo && !attachTo.lineIds.includes(line.id)) attachTo.lineIds.push(line.id);
      consume(line, attachTo ? `comment:${attachTo.id}` : 'comment');
      prevKind = 'comment';
    };
    const emitRow = (row, line) => {
      flushOrdered(); finishAccountAddress();
      inTable = true;
      let wrapped = false; const extraIds = [];
      if (pendingName) {
        row.name = row.name ? `${pendingName.text} ${row.name}` : pendingName.text;
        extraIds.push(pendingName.lineId); wrapped = true; pendingName = null;
      }
      if (!row.name) { notes.push(`Result row without a name at ${line.id}`); row.name = '(unnamed)'; }
      const r = emitResult(row, line, extraIds, wrapped);
      if (wrapped) consumed.set(extraIds[0], `result:${r.id}:wrap`);
      consume(line, `result:${r.id}`);
      closeComment(); prevKind = 'row';
    };

    // ================= line loop =================
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      const text = clean(line.text);
      const cells = line.cells && line.cells.length ? line.cells : [line.text];
      const cellX = line.cellX && line.cellX.length === cells.length ? line.cellX : cells.map(() => line.x0 || 0);
      const next = lines[li + 1] || null;
      if (accountLeft > 0) accountLeft--;
      pendingLabels = curPendingLabels; curPendingLabels = [];

      if (!text) { consume(line, 'blank'); continue; }

      // ---- footer: performing-lab legend (only with a lab-name signal or in the footer zone) ----
      const lm = text.match(LEGEND_RE);
      if (lm && (LEGEND_NAME_RE.test(lm[3]) || LEGEND_SIGNAL_RE.test(text) || inFooter || inFooterZone(li, line))) {
        const lab = parseLegend(line);
        if (lab) {
          addLab(lab, line.id); consume(line, 'footer:lab');
          inFooter = true; inTable = false; closeComment(); pendingName = null; prevKind = 'other';
          continue;
        }
      }
      // ---- footer: status / page / copyright / disclaimers (every cell must be recognized) ----
      {
        const tags = cells.map((c) => footerCellTag(c, line.id));
        if (tags.every((t) => t)) {
          const real = tags.filter((t) => t !== 'blank');
          const tag = real.length > 1 && new Set(real).size > 1 ? 'footer' : (real[0] || 'blank');
          consume(line, tag);
          const lowOnPage = line.y == null || line.y > pageHeight * 0.5;
          if (real.some((t) => t === 'footer:dateIssued' || t === 'footer:labs' || t === 'footer:copyright') || (lowOnPage && real.includes('pageno'))) {
            inFooter = true; inTable = false; closeComment(); pendingName = null;
          }
          prevKind = 'other';
          continue;
        }
        if (inFooter && lastLegend && cells.length === 1 && !splitLabels(text).parts.length && !probeRow(line)) {
          // continuation of a legend address wrapped onto the next line
          lastLegend.address = lastLegend.address ? `${lastLegend.address}, ${text}` : text;
          addEvidence('performingLabs', line.id);
          consume(line, 'footer:lab');
          continue;
        }
      }

      // ---- table header (adjacent cells are joined so "REFERENCE" | "INTERVAL" still reads as one label) ----
      if (cells.length >= 3) {
        const headerKey = (c) => {
          const t = clean(c).toLowerCase();
          if (/^(?:tests?|test name)$/.test(t)) return 'name';
          if (/^results?$/.test(t)) return 'result';
          if (/^flags?$/.test(t)) return 'flag';
          if (/^units?$/.test(t)) return 'units';
          if (/^(?:reference|ref\.?)(?:\s+(?:interval|range))?$/.test(t)) return 'ref';
          if (/^lab$/.test(t)) return 'lab';
          return null;
        };
        const map = []; let ok = true;
        for (let i = 0; i < cells.length; i++) {
          const joined = i + 1 < cells.length ? headerKey(`${clean(cells[i])} ${clean(cells[i + 1])}`) : null;
          if (joined) { map.push({ key: joined, x: cellX[i] }); i++; continue; }
          const key = headerKey(cells[i]);
          if (key) { map.push({ key, x: cellX[i] }); continue; }
          const t = clean(cells[i]).toLowerCase();
          if (/^(?:interval|range)$/.test(t) && map.length && map[map.length - 1].key === 'ref') continue;
          if (t === 'name' && map.length && map[map.length - 1].key === 'name') continue;
          ok = false; break;
        }
        if (ok && map.some((m) => m.key === 'name') && map.some((m) => m.key === 'result')) {
          flushOrdered(); finishAccountAddress();
          cols = map.sort((a, b) => a.x - b.x);
          consume(line, 'table.header'); inTable = true; inFooter = false; closeComment(); pendingName = null; prevKind = 'other';
          continue;
        }
      }

      // ---- "Ordered Items" continuation line ----
      if (orderedOpen && !inTable && cells.length === 1 && !splitLabels(text).parts.length && !SECTION_RE.test(text)
          && (/;\s*$/.test(orderedText) || text.includes(';')
            || (!orderedText.split(';').map(normName).includes(normName(text)) && !probeRow(line) && !(next && probeRow(next))))) {
        orderedText += `;${text}`; consume(line, 'orderedItems'); prevKind = 'other'; continue;
      }
      if (orderedOpen && !splitLabels(text).parts.length) flushOrdered();   // this line is not an "Ordered Items" continuation

      // ---- panel line that matches an ordered item (closes the account-block window) ----
      if (cells.length <= 2 && orderedItems.includes(normName(cells[0])) && !probeRow(line)) {
        accountLeft = 0;
        startPanel(cells[0], line);
        continue;
      }

      // ---- result rows (probed before the header block so no header window can swallow a row) ----
      const lineIsResultLike = resultLike(line);
      if (lineIsResultLike) accountLeft = 0;
      let row = probeRow(line);
      let lostRow = false;
      if (!row && lineIsResultLike && (inTable || pendingName)) {
        const rr = probeRelaxed(line);
        if (rr && rr.row) row = rr.row;
        else if (rr && rr.lost) lostRow = true;
      }
      if (row && (inTable || row.name)) { emitRow(row, line); continue; }
      if (lostRow) {
        // Row-shaped (value + unit/range/lab) but nothing to attach it to: leave it UNCONSUMED for the audit.
        notes.push(`Result-like line could not be parsed at ${line.id}`);
        closeComment(); pendingName = null; prevKind = 'other';
        continue;
      }

      // ---- header block (labels, name, sections) — only above the table on this page ----
      if (!inTable && !inFooter) {
        const tags = cells.map((c, i) => headerCell(c, cellX[i], line));
        if (tags.some((t) => t)) {
          const real = tags.filter((t) => t && t !== 'blank');
          const isAccount = real.includes('header:account') || real.includes('header:provider.account');
          if (!real.includes('header:orderedItems') && !isAccount) { flushOrdered(); }
          if (!isAccount) finishAccountAddress();
          if (isAccount && tags.some((t) => !t)) {
            // "Account Number: 123  Sample Family Medicine": the account name sits to the right on the same line
            const ai = tags.findIndex((t) => t === 'header:account' || t === 'header:provider.account');
            for (let i = 0; i < cells.length; i++) {
              if (tags[i] || i <= ai) continue;
              const t = clean(cells[i]);
              if (!t || CELL_VALUE_LIKE_RE.test(t) || splitLabels(t).parts.length) continue;
              if (!accountNameSet) { setField('provider.accountName', t, line.id); accountNameSet = true; accountX = cellX[i]; }
              else addrParts.push({ text: t, lineId: line.id });
              tags[i] = 'header:account';
            }
          }
          if (tags.every((t) => t)) {
            consume(line, real.length > 1 && new Set(real).size > 1 ? 'header' : (real[0] || 'blank'));
          } else {
            consume(line, 'header');
            notes.push(`Unrecognized header fragment at ${line.id}`);
          }
          prevKind = 'other';
          continue;
        }
      }

      // ---- single-cell lines: panel / wrapped name / comment ----
      const isSingle = cells.length === 1 || (cells.length === 2 && LAB_CODE_RE.test(clean(cells[1])) && (!cols || colOf(cellX[1]) === 'lab'));
      const x0 = line.x0 ?? cellX[0];
      const flushLeft = x0 <= nameX() + INDENT;
      const nextRow = next ? probeRow(next) : null;
      const nextX0 = next ? (next.x0 ?? (next.cellX && next.cellX[0]) ?? x0) : x0;
      const nameLike = isSingle && isNameLike(cells[0]);
      const noDigits = !/\d/.test(clean(cells[0]));
      const wordCount = clean(cells[0]).split(' ').length;
      const prevLine = lines[li - 1];
      const prevWasRow = prevKind === 'row' && !!lastResult && !!prevLine && lastResult.lineIds.includes(prevLine.id);

      if (!inTable) {
        // a flush-left heading directly above the first row of a page without a table header
        if (isSingle && flushLeft && nextRow && nextRow.name && (nameLike || isTitleCase(cells[0]))) { startPanel(cells[0], line); continue; }
        continue;   // above the table and not recognized → stays unconsumed for the audit
      }

      // a flush-left title-case line followed by an indented row is a panel heading, whatever words it contains
      if (isSingle && flushLeft && nextRow && nextRow.name && nextX0 > x0 + INDENT - 1 && isTitleCase(cells[0]) && !openComment) { startPanel(cells[0], line); continue; }

      if (nameLike) {
        const t = cells[0];
        const nextName = nextRow ? clean(nextRow.name || '') : null;
        const nextIsFragment = nextRow && (!nextName || /^[(a-z]/.test(nextName) || (!prevWasRow && nextName.split(' ').length <= 2 && (clean(t).length + nextName.length) <= 44));
        if (nextRow && !nextName) { holdName(line, t, x0); continue; }                            // "Name" / "<value row without name>"
        if (nextRow && /^[(a-z]/.test(nextName) && noDigits) { holdName(line, t, x0); continue; } // "Estim. Avg Glu" / "(eAG)  123 ..."
        if (flushLeft && nextRow) { startPanel(t, line); continue; }                              // un-ordered panel heading
        if (prevWasRow && (/[,\/\-(]$/.test(lastResult.name) || (wordCount <= 3 && noDigits))) { wrapBelow(line, t); continue; }
        if (nextIsFragment && noDigits) { holdName(line, t, x0); continue; }
        if (flushLeft && !openComment) { startPanel(t, line); continue; }
      }
      // everything else inside the table is a note/comment
      const forceNew = isNoteLabelLine(text) || /^(?:please\s+note|comments?|note)\s*:/i.test(text);
      addComment(line, forceNew);
    }
    flushOrdered(); finishAccountAddress();
  }

  // ---- post-processing ----
  if (dateIssued) addEvidence('source.dateIssued', dateIssuedLine);
  if (!report.specimen.reportedAt && dateIssued) {
    report.specimen.reportedAt = dateIssued.iso; addEvidence('specimen.reportedAt', dateIssuedLine);
    notes.push('specimen.reportedAt taken from Date Issued');
  }
  if (report.patient.ageAtCollection == null && report.patient.dob && report.specimen.collectedAt) {
    const [by, bm, bd] = report.patient.dob.split('-').map(Number);
    const [cy, cm, cd] = report.specimen.collectedAt.slice(0, 10).split('-').map(Number);
    let age = cy - by; if (cm < bm || (cm === bm && cd < bd)) age--;
    if (age >= 0 && age < 130) {
      report.patient.ageAtCollection = age;
      for (const id of [...(fieldEvidence['patient.dob'] || []), ...(fieldEvidence['specimen.collectedAt'] || [])]) addEvidence('patient.ageAtCollection', id);
    }
  }
  if (declaredPages != null && declaredPages !== report.source.pageCount) notes.push(`Declared ${declaredPages} pages but document has ${report.source.pageCount}`);
  if (orderedRaw.length) {
    const seen = new Set(report.panels.map((p) => normName(p.name)));
    for (const item of orderedRaw) if (!seen.has(normName(item))) notes.push(`Ordered item "${item}" has no panel in the results`);
  }
  for (const p of uncertain) notes.push(`uncertain:${p}`);
  report.comments = report.comments.map(({ text, page, lineIds, attachedTo }) => ({ text, page, lineIds, attachedTo }));
  if (!report.results.length) notes.push('No result rows recognized');

  return { report, consumed, notes, fieldEvidence };
}
