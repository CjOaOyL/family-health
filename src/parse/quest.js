// src/parse/quest.js — Quest Diagnostics parser: classic report + MyQuest portal variant.
// Contract: docs/SPEC.md §4 (ParseResult), §5 (preliminary confidence), §6 (layout notes).
// Pure, isomorphic, deterministic. No I/O.
import {
  parseUSDate, parseValue, parseRange, normalizeFlag, isUnitToken, splitName, normalizeSex, normalizeYesNo,
  parsePageOf, clean, parseAge, FLAG_TOKEN_RE,
} from './common.js';
import { resultLike, resultRowLike, isCellTextValue } from '../audit/confidence.js';
import { emptyReport, emptyResult } from '../model/schema.js';

export const QUEST_PARSER_VERSION = '1.1.0';

const COL_TOL = 20;      // pt: symmetric tolerance when matching a cell's left edge to a learned column
const COL_SNAP = 3;      // pt: an item that starts this close to a known column x begins a new cell (lines.js may have merged it)
const BLOCK_TOL = 14;    // pt: header block columns (Patient / Specimen / Client Information)
const INDENT_TOL = 3;    // pt: panel names sit at the Test Name column x; result names are indented past this
const NEXT_CELL_MAX_DX = 120; // pt: "Label:" with an empty value may take the next cell as its value if it is this close
const BELOW_X_TOL = 4;   // pt: "Label:" with an empty value may take a bare value printed at the same x on the next line
const CHAR_W_FACTOR = 0.5; // estimated char width as a fraction of font height when items are missing

const STATUS_RE = /^(?:REPORT\s+STATUS\s*:\s*)?(FINAL|PARTIAL|CORRECTED|PRELIMINARY|PRELIM)(?:\s+(?:REPORT|RESULTS?))?$/i;
const STATUS_MAP = { FINAL: 'final', PARTIAL: 'partial', CORRECTED: 'corrected', PRELIMINARY: 'preliminary', PRELIM: 'preliminary' };
const VENDOR_RE = /^(?:MyQuest(?:\s+by\s+Quest\s+Diagnostics)?|Quest\s+Diagnostics(?:,?\s+Inc(?:orporated)?\.?)?)$/i;
const BLOCK_RES = [
  ['patient', /^Patient\s+Information$/i],
  ['specimen', /^Specimen\s+Information$/i],
  ['client', /^(?:Client\s+Information|Ordering\s+Physician|Physician\s+Information|Ordering\s+Provider|Provider\s+Information)$/i],
];
const LAB_CODE_RE = /^[A-Z][A-Z0-9]{1,2}$/;
const DISCLAIMER_RE = /trademarks?\s+of\s+Quest|Quest,\s*Quest\s+Diagnostics|All\s+rights\s+reserved|©\s*\d{4}|\(c\)\s*\d{4}|This\s+(?:report|document)\s+(?:is|contains|has\s+been)/i;
const CLIENT_SERVICES_RE = /^Client\s+Services?\s*:?/i;
const PERFORMING_SITE_RE = /^Performing\s+(?:Site|Lab(?:oratory)?)s?\s*:?\s*(.*)$/i;
const EXTRA_UNIT_RE = /^(?:%\s+of\s+total\s+(?:Hgb|Hemoglobin)|mL\/min\/1\.73\s*m(?:2|\^2)?)$/i;
const NOT_ESTAB_RE = /^(?:Not\s+Estab(?:\.|lished)?|N\/A|NA|Not\s+Applicable|None)$/i;
const PERSON_NAME_RE = /^[A-Z][A-Z'.\- ]*,\s*[A-Z][A-Z'.\- ]*$/;          // "LAST, FIRST M" as printed
const INCOMPLETE_TAIL_RE = /(?:[,\/\-(]|\b(?:TO|W\/|AND|OR|OF|WITH|REFLEX|REFL|FOR|BY|IN))$/i;
const VALUE_FLAG_RE = /^(.*?)(?:\s+(HH|LL|H|L|A|C|HI|LO|High|Low|Critical\s+High|Critical\s+Low|Critical|Abnormal|Alert|Crit\s+High|Crit\s+Low)|\s*(\*{1,2}))$/i;
const STAR_VALUE_RE = /^(.*\d)\s*(\*{1,2})$/;
const NAME_START_RE = /^(?:[A-Za-z%(]|\d[\w.,\-]*[A-Za-z\-])/;          // "WBC", "%SATURATION", "(a)", "25-OH Vitamin D", "5-HIAA"
const PROSE_RE = /\b(?:the|is|are|for|of|to|with|should|may|from|than|was|were|note|please|if|this|that|when|been|has|have|using|used|based|on|in|by|an|be|not)\b/i;
const PANEL_VOCAB_RE = /\b(?:PANEL|PROFILE|CBC|CMP|BMP|COMPREHENSIVE|METABOLIC|LIPID|URINALYSIS|CHEMISTRY|HEMATOLOGY|SEROLOGY|IMMUNOLOGY|MICROBIOLOGY|MISCELLANEOUS|CASCADE|W\/REFL(?:EX)?|WITH\s+REFLEX|AND)\b|\(INCLUDES|,\s*IA$/i;
const LABEL_WORDS = 'DOB|Date\\s+of\\s+Birth|Birth\\s*Date|AGE|Gender|Sex|Patient\\s*ID|Patient(?:\\s+Name)?|Phone|Tel(?:ephone)?|Fax|Specimen(?:\\s*(?:#|ID|Number|No\\.?))?|Requisition(?:\\s*(?:#|No\\.?))?|Lab\\s*Ref(?:erence)?\\s*#?|Collected(?:\\s+on)?|Received(?:\\s+on)?|Reported(?:\\s+on)?|Entered(?:\\s+on)?|Fasting|(?:Client|Account)\\s*(?:#|Number|No\\.?)|NPI|Ordered\\s+by|Ordering\\s+(?:Physician|Provider)|Results\\s+for|(?:Report\\s+)?Status|Performed\\s+(?:at|by)';
const LABEL_SPLIT_RE = new RegExp(`(?:^|\\s)(?=(?:${LABEL_WORDS})\\s*:)`, 'gi');
const LABEL_START_RE = new RegExp(`^(?:${LABEL_WORDS})\\s*:`, 'i');
const LABEL_ANY_RE = new RegExp(`(?:^|\\s)(?:${LABEL_WORDS})\\s*:`, 'i');     // non-global: safe for .test()

const HEADER_ROLES = [
  ['name', /^Test(?:\s*Name)?$/i],
  ['inRange', /^In\s*Range$/i],
  ['outRange', /^Out\s*of\s*Range$/i],
  ['value', /^(?:Your\s*Value|Results?|Value)$/i],
  ['ref', /^(?:Reference|Ref\.?|Normal)\s*(?:Range|Interval|Values?)$/i],
  ['units', /^Units?$/i],
  ['flag', /^Flags?$/i],
  ['lab', /^Lab$/i],
];

// ---------- small utilities ----------
const getIn = (o, p) => p.split('.').reduce((x, k) => (x == null ? undefined : x[k]), o);
function setIn(o, p, v) { const ks = p.split('.'); let x = o; for (const k of ks.slice(0, -1)) x = x[k]; x[ks[ks.length - 1]] = v; }
const isUnit = (s) => !!s && (isUnitToken(s) || EXTRA_UNIT_RE.test(String(s).trim()));
const firstWord = (s) => clean(s).split(' ')[0].replace(/[,;:]+$/, '').toUpperCase();
const wordCount = (s) => clean(s).split(' ').filter(Boolean).length;

function isUpperDominant(text) {
  const letters = text.match(/[A-Za-z]/g) || [];
  if (letters.length < 2) return false;
  const upper = text.match(/[A-Z]/g) || [];
  return upper.length / letters.length >= 0.85;
}

/** A result-name cell: starts like a test name, is short, and reads like a label rather than a sentence. */
function nameLike(name) {
  const t = clean(name);
  if (!t || !NAME_START_RE.test(t) || /[:;]$/.test(t) || /\.$/.test(t)) return false;
  if (wordCount(t) > 8) return false;
  if (/^[a-z]/.test(t) && PROSE_RE.test(t)) return false;            // "the ATP III guidelines ..."
  if ((t.match(PROSE_RE) || []).length && !isUpperDominant(t)) return false;
  return true;
}

function addEvidence(ctx, path, lineIds) {
  const arr = ctx.fieldEvidence[path] || (ctx.fieldEvidence[path] = []);
  for (const id of [].concat(lineIds)) if (id && !arr.includes(id)) arr.push(id);
}

/** First non-null wins; a different later value is noted as a conflict (audit marks the field uncertain). */
function setField(ctx, path, value, lineIds) {
  if (value == null || value === '') return false;
  const cur = getIn(ctx.report, path);
  if (cur == null) setIn(ctx.report, path, value);
  else if (String(cur) !== String(value) && !ctx.conflicts.has(path)) {
    ctx.conflicts.add(path);
    const first = (ctx.fieldEvidence[path] || [])[0] || '?';
    ctx.notes.push(`conflict:${path}: value at ${[].concat(lineIds)[0]} differs from ${first} (first kept)`);
  }
  addEvidence(ctx, path, lineIds);
  return true;
}

function setDate(ctx, path, raw, lineId, dateOnly, tzPath) {
  const d = parseUSDate(raw);
  if (!d) return false;
  setField(ctx, path, dateOnly ? d.date : d.iso, lineId);
  if (tzPath && d.tz) setField(ctx, tzPath, d.tz, lineId);
  return true;
}

function setName(ctx, raw, lineId) {
  const n = splitName(raw);
  if (!n.fullName) return false;
  setField(ctx, 'patient.fullName', n.fullName, lineId);
  if (ctx.report.patient.fullName === n.fullName) {
    for (const k of ['lastName', 'firstName', 'middleName']) if (ctx.report.patient[k] == null && n[k]) ctx.report.patient[k] = n[k];
  }
  return true;
}

function addPerformingLab(ctx, code, lineId) {
  let lab = code ? ctx.labs.get(code) : null;
  if (!lab) {
    lab = { code: code ?? null, name: null, address: null, director: null, clia: null, phone: null };
    if (code) ctx.labs.set(code, lab); else ctx.codelessLabs.push(lab);
  }
  addEvidence(ctx, 'performingLabs', lineId);
  return lab;
}

/** Pull director / CLIA / phone out of a performing-site legend fragment; the rest becomes name (first segment) and address. */
function absorbLabText(lab, text) {
  let t = clean(text), m;
  if ((m = t.match(/(?:Laboratory|Lab\.?|Medical)\s+Director\s*:?\s*([^,]+(?:,\s*(?:MD|DO|PhD|Ph\.D\.|M\.D\.|D\.O\.))?)/i))) {
    if (!lab.director) lab.director = m[1].trim().replace(/[,\s]+$/, '');
    t = t.replace(m[0], ' ');
  }
  if ((m = t.match(/CLIA\s*(?:#|ID|No\.?|Number)?\s*:?\s*([0-9A-Z]{8,12})/i))) { if (!lab.clia) lab.clia = m[1]; t = t.replace(m[0], ' '); }
  if ((m = t.match(/(?:Phone|Tel(?:ephone)?|Ph)\s*:?\s*((?:\+?1[\s.\-])?\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4})/i))) { if (!lab.phone) lab.phone = m[1].trim(); t = t.replace(m[0], ' '); }
  t = t.replace(/\s*,\s*,/g, ',').replace(/^[\s,]+|[\s,]+$/g, '').replace(/\s+/g, ' ');
  if (!t) return;
  if (!lab.name) {
    const i = t.indexOf(',');
    if (i > 0) { lab.name = t.slice(0, i).trim(); lab.address = t.slice(i + 1).trim() || null; }
    else lab.name = t;
  } else lab.address = lab.address ? `${lab.address}, ${t}` : t;
}

// ---------- column model ----------
function learnColumns(cells, cellX) {
  const cols = [];
  let unknown = 0;
  cells.forEach((c, i) => {
    const t = clean(c);
    const hit = HEADER_ROLES.find(([, re]) => re.test(t));
    if (hit) cols.push({ role: hit[0], x: cellX[i] }); else unknown++;
  });
  const roles = new Set(cols.map((c) => c.role));
  if (!roles.has('name') || !(roles.has('inRange') || roles.has('value')) || !roles.has('ref') || unknown > 1) return null;
  cols.sort((a, b) => a.x - b.x);
  return { cols, variant: roles.has('inRange') ? 'classic' : 'myquest', nameX: cols.find((c) => c.role === 'name').x };
}

/**
 * Cells with geometry: { cells, cellX, cellX1 }. Uses the line's items when present so that
 * (a) widths are real and (b) a cell that lines.js merged across a known column boundary (gap just under GAP_CELL,
 * e.g. a right-aligned value touching the Reference column) is split again at the item that starts on that column.
 */
function cellGeometry(line, cells, cellX, columns) {
  const items = Array.isArray(line.items) ? line.items.filter((it) => it && typeof it.str === 'string' && it.str.trim()) : [];
  const fontH = items.length ? (items[0].h || 10) : 10;
  const estW = (t) => clean(t).length * CHAR_W_FACTOR * fontH;
  if (items.length < cells.length || items.length === 0) {
    return { cells, cellX, cellX1: cells.map((c, i) => cellX[i] + estW(c)) };
  }
  // group items into the existing cells by x
  const groups = cells.map(() => []);
  let k = 0;
  for (const it of items) {
    while (k + 1 < cells.length && it.x >= cellX[k + 1] - 0.01) k++;
    groups[k].push(it);
  }
  if (groups.some((g) => !g.length)) return { cells, cellX, cellX1: cells.map((c, i) => cellX[i] + estW(c)) };
  const outCells = [], outX = [], outX1 = [];
  const colXs = columns ? columns.cols.map((c) => c.x) : [];
  for (let g = 0; g < groups.length; g++) {
    const its = groups[g];
    let piece = [its[0]];
    const flush = () => {
      const text = piece.map((it, j) => {
        if (j === 0) return it.str;
        const prev = piece[j - 1];
        const gap = it.x - (prev.x + prev.w);
        const cw = prev.w / Math.max(1, prev.str.length);
        return (gap < 0.25 * cw ? '' : ' ') + it.str;
      }).join('');
      const last = piece[piece.length - 1];
      outCells.push(clean(text)); outX.push(piece[0].x); outX1.push(last.x + (last.w || estW(last.str)));
    };
    for (let j = 1; j < its.length; j++) {
      const it = its[j];
      // a flag letter printed right after its value never starts a cell, even when it lands on the next column's x
      const onColumn = !FLAG_TOKEN_RE.test(it.str.trim()) && colXs.some((cx) => Math.abs(it.x - cx) <= COL_SNAP && cx > piece[0].x + 10);
      if (onColumn) { flush(); piece = [it]; } else piece.push(it);
    }
    flush();
  }
  // if re-splitting changed nothing, keep the original cell text (lines.js spacing is authoritative)
  if (outCells.length === cells.length) return { cells, cellX, cellX1: outX1 };
  return { cells: outCells, cellX: outX, cellX1: outX1 };
}

/** Does a cell's text have the shape the column expects? */
function cellFits(role, text) {
  const t = clean(text);
  if (!t) return false;
  switch (role) {
    case 'name': return /[A-Za-z]/.test(t) && !/^(?:[<>]=?\s*)?[-+]?[\d.,]+\s*(?:[A-Za-z]{1,2}|\*{1,2})?$/.test(t) && !FLAG_TOKEN_RE.test(t);
    case 'inRange': case 'outRange': case 'value': { const v = parseValueCell(t); return !!(v && (v.parsed || v.flag)); }
    case 'ref': { const s = splitRefCell(t); return !!(s.unit || (s.rangeText && !FLAG_TOKEN_RE.test(s.rangeText) && !LAB_CODE_RE.test(s.rangeText))); }
    case 'units': return isUnit(t);
    case 'flag': return normalizeFlag(t) != null && t.length <= 14;
    case 'lab': return LAB_CODE_RE.test(t);
    default: return true;
  }
}

/** Both neighbours fit: decide by content. */
function tieBreak(left, right, text) {
  if ((left === 'inRange' && right === 'outRange')) { const v = parseValueCell(text); return v && v.flag ? right : left; }
  if (right === 'lab') return LAB_CODE_RE.test(clean(text)) ? right : left;
  if (right === 'flag') return normalizeFlag(text) ? right : left;
  if (left === 'name') return right;
  return left;
}

/**
 * Group a line's cells by column role (cells in the same column are joined with a single space).
 * A cell belongs to the right-most column that starts at or before cellX + COL_TOL. When the cell ends before that
 * column even starts (drifted-left row vs right-aligned previous column) both neighbours are sanity-checked by
 * content; a cell that does not fit its column tries the nearest neighbour that does.
 */
function assignColumns(cells, cellX, cellX1, columns) {
  const cols = columns.cols;
  const out = {};
  cells.forEach((c, i) => {
    const text = clean(c);
    if (!text) return;
    const x = cellX[i], x1 = cellX1 ? cellX1[i] : x + text.length * 4;
    let ci = 0;
    for (let k = 0; k < cols.length; k++) if (cols[k].x <= x + COL_TOL) ci = k;
    let role = cols[ci].role;
    if (ci > 0 && cols[ci].x > x1 + 0.5) {
      const left = cols[ci - 1].role, right = role;
      const lo = cellFits(left, text), ro = cellFits(right, text);
      role = lo && !ro ? left : ro && !lo ? right : lo && ro ? tieBreak(left, right, text) : right;
    } else if (!cellFits(role, text)) {
      for (const k of [ci + 1, ci - 1]) {
        if (k < 0 || k >= cols.length) continue;
        const near = Math.abs(cols[k].x - x) <= 2 * COL_TOL || (cols[k].x >= x && cols[k].x <= x1);
        if (near && cellFits(cols[k].role, text)) { role = cols[k].role; break; }
      }
    }
    if (!out[role]) out[role] = { text: '', x, idx: [] };
    out[role].text = (out[role].text ? out[role].text + ' ' : '') + text;
    out[role].idx.push(i);
  });
  return out;
}

// ---------- cell parsers ----------
/** "3.8-10.8 Thousand/uL" → { rangeText:'3.8-10.8', unit:'Thousand/uL' }; "mg/dL" → { rangeText:null, unit:'mg/dL' }; "6-22 (calc)" → { rangeText:'6-22 (calc)', unit:null } */
function splitRefCell(raw) {
  let t = clean(raw);
  if (!t) return { rangeText: null, unit: null };
  const parens = [];
  let m;
  while ((m = t.match(/\s*(\([^()]*\))$/))) { parens.unshift(m[1]); t = t.slice(0, m.index).trim(); }
  const toks = t ? t.split(' ') : [];
  let unitToks = [];
  for (let n = Math.min(4, toks.length); n >= 1; n--) {
    const suffix = toks.slice(toks.length - n).join(' ');
    if (isUnit(suffix)) { unitToks = toks.splice(toks.length - n, n); break; }
  }
  const core = toks.join(' ');
  return { rangeText: core ? [core, ...parens].join(' ') : null, unit: unitToks.length ? unitToks.join(' ') : null };
}

/** Parse a value token: numeric / qualified numeric / known text value (incl. "Non Reactive"); "6.2*" → 6.2 + star. */
function parseValueToken(t) {
  let flag = null, text = t;
  const sm = text.match(STAR_VALUE_RE);
  if (sm) { text = sm[1].trim(); flag = normalizeFlag(sm[2]); }
  let parsed = parseValue(text);
  if (!parsed && isCellTextValue(text)) parsed = { valueText: text, value: null, qualifier: null, isText: true };
  return { text, parsed, flag };
}

/**
 * "210 H" → { text:'210', parsed:{...}, flag:'H' }; "12.5*" → flag 'A'; "32 ng/mL" → inlineUnit;
 * "133 mg/dL (calc)" → 133 + 'mg/dL'; "5.4 % of total Hgb" → 5.4 + '% of total Hgb'; "6.2* %" → 6.2, flag A, '%'.
 */
function parseValueCell(raw) {
  let t = clean(raw);
  if (!t) return null;
  let flag = null;
  const m = t.match(VALUE_FLAG_RE);
  if (m && m[1].trim()) { flag = normalizeFlag(m[2] || m[3]); t = m[1].trim(); }
  // trailing parenthetical / prose tail after a unit: "133 mg/dL (calc)"
  const tail = t.match(/^(.*?)\s*(\([^()]*\))$/);
  if (tail && tail[1]) t = tail[1].trim();
  let tok = parseValueToken(t);
  let parsed = tok.parsed, inlineUnit = null, text = tok.text;
  if (tok.flag && !flag) flag = tok.flag;
  if (!parsed) {
    const toks = t.split(' ');
    for (let n = Math.min(4, toks.length - 1); n >= 1; n--) {
      const suf = toks.slice(toks.length - n).join(' ');
      if (!isUnit(suf)) continue;
      const head = toks.slice(0, toks.length - n).join(' ');
      const t2 = parseValueToken(head);
      if (t2.parsed) { parsed = t2.parsed; text = t2.text; inlineUnit = suf; if (t2.flag && !flag) flag = t2.flag; }
      else if (/^(?:[<>]=?\s*)?[\d.,:\-]+\*{0,2}$/.test(head) || wordCount(head) <= 2) { text = t2.text; inlineUnit = suf; if (t2.flag && !flag) flag = t2.flag; }
      break;
    }
  }
  return { raw: clean(raw), text, parsed, flag, inlineUnit };
}

const normalizeRangeText = (t) => t.replace(/^([<>])\s*OR\s*=\s*/i, '$1=').replace(/^(?:>|greater than)\s*OR\s*(?:EQUAL(?:\s+TO)?|=)\s*/i, '>=');

// ---------- result rows ----------
/** Pure analysis of a line as a result row. Returns null when the line is not result-shaped. */
function analyzeRow(ctx, line, cells, cellX, cellX1) {
  if (ctx.columns) {
    const a = assignColumns(cells, cellX, cellX1, ctx.columns);
    const name = a.name ? a.name.text : '';
    const rawIn = a.inRange?.text, rawOut = a.outRange?.text, rawVal = a.value?.text, rawRef = a.ref?.text;
    const rawUnits = a.units?.text, rawFlag = a.flag?.text, rawLab = a.lab?.text;
    const nonName = Object.keys(a).filter((k) => k !== 'name').length;
    if (!nonName) return null;
    if (!name && !ctx.pendingName) return null;
    if (name && !NAME_START_RE.test(name)) return null;
    if (name && /:$/.test(name)) return null;
    let valueCell = null, inOut = null;
    if (rawOut) { valueCell = rawOut; inOut = 'out'; } else if (rawIn) { valueCell = rawIn; inOut = 'in'; } else if (rawVal) { valueCell = rawVal; inOut = 'value'; }
    const v = valueCell ? parseValueCell(valueCell) : null;
    const refSplit = splitRefCell(rawRef);
    const unit = rawUnits ? clean(rawUnits) : (refSplit.unit || (v && v.inlineUnit) || null);
    const lab = rawLab ? clean(rawLab) : null;
    const labOk = !!(lab && LAB_CODE_RE.test(lab));
    const refOk = !!(refSplit.unit || refSplit.rangeText);
    const valueOk = !!(v && v.parsed);
    const nameOk = name ? nameLike(name) : true;
    const rangeKind = refSplit.rangeText ? parseRange(normalizeRangeText(refSplit.rangeText)).kind : null;
    const refStrong = refOk && (rangeKind !== 'text' || !!refSplit.unit || isCellTextValue(refSplit.rangeText || ''));
    let ok = false;
    if (valueOk) ok = true;
    else if (valueCell && labOk) ok = true;                                   // "SPECKLED" + lab code
    else if (valueCell && refStrong && nameOk) ok = true;                     // unknown text value with a real range
    else if (!valueCell && refStrong && nameOk && (rangeKind !== 'text' || !!refSplit.unit)) ok = true;   // value missing, range printed
    if (!ok) return null;
    return { name, v, inOut, bothCols: !!(rawOut && rawIn), refSplit, unit, lab, labOk, rawFlag, misaligned: false, nonName };
  }
  return analyzeRowFallback(cells);
}

/** No table header seen: infer [name, value?, flag?, reference?, lab?] from cell shapes. Marks the row misaligned (−0.1). */
function analyzeRowFallback(cells, { strict = false } = {}) {
  if (cells.length < 2 || cells.length > 5) return null;
  const name = clean(cells[0]);
  if (!NAME_START_RE.test(name) || /:/.test(name) || /^(?:Page|Patient|Specimen|Client|Reference)\b/i.test(name)) return null;
  if (!nameLike(name)) return null;
  const rest = cells.slice(1).map(clean);
  let lab = null, flagCell = null;
  if (rest.length >= 2 && LAB_CODE_RE.test(rest[rest.length - 1]) && !FLAG_TOKEN_RE.test(rest[rest.length - 1])) lab = rest.pop();
  if (rest.length >= 3 && FLAG_TOKEN_RE.test(rest[rest.length - 1]) && normalizeFlag(rest[rest.length - 1])) flagCell = rest.pop();   // MyQuest [name, value, ref, flag]
  let refSplit = { rangeText: null, unit: null }, v = null;
  if (rest.length >= 2) {
    refSplit = splitRefCell(rest[rest.length - 1]);
    if (!refSplit.unit && !refSplit.rangeText) return null;
    v = parseValueCell(rest[0]);
    if (rest.length === 3 && !v?.flag) { const f = normalizeFlag(rest[1]); if (f && FLAG_TOKEN_RE.test(rest[1])) v.flag = f; else return null; }
    if (rest.length > 3) return null;
  } else if (rest.length === 1) {
    v = parseValueCell(rest[0]);
    if (!v?.parsed) { v = null; refSplit = splitRefCell(rest[0]); if (!refSplit.unit && !refSplit.rangeText) return null; }
  }
  if (!v && !refSplit.unit && !refSplit.rangeText) return null;
  if (v && flagCell && !v.flag) v.flag = normalizeFlag(flagCell);
  if (strict) {
    if (!v || !v.parsed) return null;
    const rk = refSplit.rangeText ? parseRange(normalizeRangeText(refSplit.rangeText)).kind : null;
    if (refSplit.rangeText && rk === 'text' && !refSplit.unit && !isCellTextValue(refSplit.rangeText) && !NOT_ESTAB_RE.test(refSplit.rangeText)) return null;
    if (refSplit.rangeText && PROSE_RE.test(refSplit.rangeText)) return null;
  }
  const unit = refSplit.unit || (v && v.inlineUnit) || null;
  return { name, v, inOut: v?.flag ? 'out' : 'in', bothCols: false, refSplit, unit, lab, labOk: !!lab, rawFlag: null, misaligned: true, nonName: rest.length + (lab ? 1 : 0) + (flagCell ? 1 : 0) };
}

/** Header mode without a learned table: is this line a result row with a recognizable value? */
function fallbackRowOk(line) {
  if (!line || !resultLike(line)) return null;
  const cells = cellsOf(line);
  if (cells.some((c) => LABEL_ANY_RE.test(c) || isLabelish(c))) return null;
  const info = analyzeRowFallback(cells, { strict: true });
  return info && info.v && info.v.parsed ? info : null;
}

/**
 * Relaxed re-split for a result-like line that the column model could not parse: 2+ spaces first (the cells),
 * then single spaces when a numeric token follows a name. Returns row info or null (the line is then left unconsumed).
 */
function relaxedRow(ctx, line, cells) {
  let parts = cells.length > 1 ? cells : clean(line.text).split(/\s{2,}/);
  if (parts.length === 1) {
    const m = parts[0].match(/^(.+?[A-Za-z)%])\s+((?:[<>]=?\s*)?[-+]?\d[\d,]*\.?\d*\*{0,2}(?:\s+.*)?)$/);
    if (!m) return null;
    const toks = m[2].split(' ');
    const out = [m[1], toks[0]];
    let i = 1;
    if (i < toks.length && FLAG_TOKEN_RE.test(toks[i]) && normalizeFlag(toks[i])) { out[1] += ` ${toks[i]}`; i++; }
    const rest = toks.slice(i);
    let lab = null;
    if (rest.length >= 2 && LAB_CODE_RE.test(rest[rest.length - 1])) lab = rest.pop();
    if (rest.length) out.push(rest.join(' '));
    if (lab) out.push(lab);
    parts = out;
  }
  const info = analyzeRowFallback(parts.map(clean), { strict: true });
  return info;
}

function commitRow(ctx, line, info) {
  const r = emptyResult(`r${++ctx.seq}`);
  const meta = {};
  r.page = line.page;
  r.lineIds = [line.id];
  r.panel = ctx.currentPanel ? ctx.currentPanel.name : null;
  let name = clean(info.name);
  if (ctx.pendingName) {
    name = clean(`${ctx.pendingName.text} ${name}`);
    r.lineIds.unshift(ctx.pendingName.lineId);
    ctx.consumed.set(ctx.pendingName.lineId, `result:${r.id}:name-wrap`);
    meta.wrapped = true;
    ctx.pendingName = null;
  }
  r.name = name;
  // value
  if (info.v) {
    r.valueText = info.v.parsed ? info.v.parsed.valueText : info.v.text;
    r.value = info.v.parsed ? info.v.parsed.value : null;
    r.valueQualifier = info.v.parsed ? info.v.parsed.qualifier : null;
    r.fieldStatus.value = info.v.parsed ? 'found' : 'uncertain';
    if (!info.v.parsed) ctx.notes.push(`${r.id}: value not recognized as numeric or known text value (${line.id})`);
    if (info.bothCols) { r.fieldStatus.value = 'uncertain'; ctx.notes.push(`${r.id}: text in both In Range and Out of Range columns (${line.id}); Out of Range used`); }
  } else {
    r.valueText = '';
    r.fieldStatus.value = 'missing';
  }
  // flag
  let flag = info.v ? info.v.flag : null;
  if (!flag && info.rawFlag) flag = normalizeFlag(info.rawFlag);
  if (flag) { r.flag = flag; r.fieldStatus.flag = 'found'; }
  else if (info.inOut === 'out' && info.v) {
    r.flag = 'A'; r.fieldStatus.flag = 'uncertain';
    ctx.notes.push(`${r.id}: value printed in Out of Range column without a flag letter; flag set to A (${line.id})`);
  } else r.fieldStatus.flag = 'na';
  // unit
  const numeric = r.value != null;
  if (info.unit) { r.unit = info.unit; r.fieldStatus.unit = 'found'; }
  else r.fieldStatus.unit = numeric && !/\b(?:RATIO|INDEX)\b/i.test(r.name) ? 'missing' : 'na';
  // reference range
  const rt = info.refSplit.rangeText;
  if (rt) {
    const rr = parseRange(normalizeRangeText(rt));
    if (/\d+:\d+/.test(rt)) { rr.low = null; rr.high = null; rr.kind = 'text'; }   // titers: "<1:40" is text, not "<1"
    rr.text = rt;
    r.referenceRange = rr;
    r.fieldStatus.range = NOT_ESTAB_RE.test(rt.replace(/\s*\([^)]*\)$/, '')) ? 'na' : 'found';
  } else r.fieldStatus.range = numeric ? 'missing' : 'na';
  // performing lab
  if (info.lab && info.labOk) { r.performingLabCode = info.lab; ctx.labCodesUsed.add(info.lab); }
  else if (info.lab) ctx.notes.push(`${r.id}: Lab column text is not a site code (${line.id})`);
  if (info.misaligned) meta.misaligned = true;
  ctx.meta.set(r.id, meta);
  ctx.report.results.push(r);
  if (ctx.currentPanel) ctx.currentPanel.resultIds.push(r.id);
  ctx.lastResult = r;
  ctx.lastWasComment = false;
  ctx.consumed.set(line.id, `result:${r.id}`);
  ctx.mode = 'table';
}

// ---------- panels, wrapped names, comments ----------
function tryPanelOrWrap(ctx, line, cells, cellX, cellX1, prev, next) {
  const text = clean(line.text);
  if (ctx.columns) {
    const a = assignColumns(cells, cellX, cellX1, ctx.columns);
    if (Object.keys(a).some((k) => k !== 'name')) return false;
  } else if (cells.length > 1) return false;
  if (!isUpperDominant(text) || text.length > 70 || /[:;]/.test(text) || /^[.•·]/.test(text) || /\.$/.test(text)) return false;
  if (!/^[A-Z%(]/.test(text)) return false;
  if (resultLike(line)) return false;
  const nameX = ctx.columns ? ctx.columns.nameX : ctx.pageLeft;
  const indented = line.x0 > nameX + INDENT_TOL;
  const incomplete = INCOMPLETE_TAIL_RE.test(text);
  const vocab = PANEL_VOCAB_RE.test(text);
  const short = wordCount(text) <= 3;
  const nextRow = next && next.page === line.page && !ctx.pendingName ? analyzeRowCandidate(ctx, next) : null;
  const nextName = nextRow ? clean(nextRow.name) : '';
  const nextStartsWithThis = !!nextName && (nextName.toUpperCase().startsWith(text.toUpperCase()) || firstWord(nextName) === firstWord(text));
  const nextIndented = !!nextRow && next.x0 > line.x0 + INDENT_TOL;
  const lr = ctx.lastResult;
  const afterRow = !!(lr && prev && lr.lineIds[lr.lineIds.length - 1] === prev.id && !ctx.lastWasComment);
  const lrIncomplete = afterRow && INCOMPLETE_TAIL_RE.test(lr.name);
  const shortFlush = short && !vocab && !nextStartsWithThis && !!nextRow && !nextIndented;

  if (afterRow && (indented || lrIncomplete || (shortFlush && !incomplete))) {   // wrapped name, continuation BELOW the value line
    lr.name = clean(`${lr.name} ${text}`);
    lr.lineIds.push(line.id);
    (ctx.meta.get(lr.id) || ctx.meta.set(lr.id, {}).get(lr.id)).wrapped = true;
    ctx.consumed.set(line.id, `result:${lr.id}:name-wrap`);
    return true;
  }
  if (nextRow && !nextStartsWithThis && (indented || incomplete || (shortFlush && afterRow))) {   // wrapped name, continuation ABOVE the value line
    ctx.pendingName = { text, lineId: line.id };
    return true;                                           // consumed when the row commits
  }
  if (!indented) {                                         // panel name
    if (!(ctx.currentPanel && ctx.currentPanel.name === text && ctx.currentPanel.page === line.page)) {
      ctx.currentPanel = { name: text, resultIds: [], page: line.page };
      ctx.report.panels.push(ctx.currentPanel);
    }
    ctx.lastResult = null;
    ctx.lastWasComment = false;
    ctx.consumed.set(line.id, 'panel');
    ctx.mode = 'table';
    return true;
  }
  return false;
}

/** Row analysis of an arbitrary line (used for look-ahead). */
function analyzeRowCandidate(ctx, line) {
  const g = cellGeometry(line, cellsOf(line), cellXOf(line), ctx.columns);
  return analyzeRow(ctx, line, g.cells, g.cellX, g.cellX1);
}

function attachComment(ctx, line, text) {
  const target = ctx.lastResult;
  const stripped = text.replace(/^[.•·]+\s*/, '');
  const attachedTo = target ? target.id : null;
  const last = ctx.report.comments[ctx.report.comments.length - 1];
  if (ctx.lastWasComment && last && last.attachedTo === attachedTo && last.page === line.page) {
    last.text += `\n${stripped}`;
    last.lineIds.push(line.id);
  } else ctx.report.comments.push({ text: stripped, page: line.page, lineIds: [line.id], attachedTo });
  if (target) target.comment = target.comment ? `${target.comment}\n${stripped}` : stripped;
  ctx.lastWasComment = true;
  ctx.consumed.set(line.id, target ? `comment:${target.id}` : 'comment');
}

// ---------- header / footer cells ----------
// `below`: shape a bare value on the next line (same x) must have to be taken as this label's value.
const ID_SHAPE = /^[A-Z0-9][A-Z0-9\-]{2,}$/i;
const NAME_SHAPE = /^(?:DR\.?\s+)?[A-Za-z][A-Za-z.,'\-]*(?:\s+[A-Za-z][A-Za-z.,'\-]*){0,4}$/;
const DATE_SHAPE = (v) => !!parseUSDate(v);
const LABELS = [
  { tag: 'patient.dob', re: /^(?:DOB|Date\s+of\s+Birth|Birth\s*Date)\s*:?\s*(.*)$/i, below: DATE_SHAPE, apply: (c, v, id) => setDate(c, 'patient.dob', v, id, true) },
  { tag: 'patient.ageAtCollection', re: /^AGE\s*:?\s*(.*)$/i, below: /^\d{1,3}(?:\s*(?:Y|YR|YRS|YEARS?|M|MO|MOS|MONTHS?))?$/i, apply: (c, v, id) => setField(c, 'patient.ageAtCollection', parseAge(v), id) },
  { tag: 'patient.sex', re: /^(?:Gender|Sex)\s*:?\s*(.*)$/i, below: /^(?:M|F|U|MALE|FEMALE|UNKNOWN)$/i, apply: (c, v, id) => setField(c, 'patient.sex', normalizeSex(v), id) },
  { tag: 'patient.patientId', re: /^Patient\s*ID\s*:?\s*(.*)$/i, below: ID_SHAPE, apply: (c, v, id) => setField(c, 'patient.patientId', v, id) },
  { tag: 'phone', re: /^(?:Phone|Tel(?:ephone)?)\s*:?\s*(.*)$/i, below: /^[\d().\-\s]{7,}$/, apply: (c, v, id, block) => setField(c, block === 'client' ? 'provider.phone' : 'patient.phone', v, id) },
  { tag: 'provider.fax', re: /^Fax\s*:?\s*(.*)$/i, below: /^[\d().\-\s]{7,}$/, apply: (c, v, id) => setField(c, 'provider.fax', v, id) },
  { tag: 'specimen.specimenId', re: /^Specimen\s*(?:#|ID|Number|No\.?)?\s*:\s*(.*)$/i, below: ID_SHAPE, apply: (c, v, id) => setField(c, 'specimen.specimenId', v, id) },
  { tag: 'specimen.requisition', re: /^Requisition\s*(?:#|No\.?)?\s*:?\s*(.*)$/i, below: ID_SHAPE, apply: (c, v, id) => setField(c, 'specimen.requisition', v, id) },
  { tag: 'specimen.labRef', re: /^Lab\s*Ref(?:erence)?\s*#?\s*:?\s*(.*)$/i, below: ID_SHAPE, apply: (c, v, id) => setField(c, 'specimen.labRef', v, id) },
  { tag: 'specimen.collectedAt', re: /^Collected(?:\s+on)?\s*:?\s*(.*)$/i, below: DATE_SHAPE, apply: (c, v, id) => setDate(c, 'specimen.collectedAt', v, id, false, 'specimen.collectedTz') },
  { tag: 'specimen.receivedAt', re: /^Received(?:\s+on)?\s*:?\s*(.*)$/i, below: DATE_SHAPE, apply: (c, v, id) => setDate(c, 'specimen.receivedAt', v, id, false) },
  { tag: 'specimen.reportedAt', re: /^Reported(?:\s+on)?\s*:?\s*(.*)$/i, below: DATE_SHAPE, apply: (c, v, id) => setDate(c, 'specimen.reportedAt', v, id, false) },
  { tag: 'specimen.enteredAt', re: /^Entered(?:\s+on)?\s*:?\s*(.*)$/i, below: DATE_SHAPE, apply: (c, v, id) => setDate(c, 'specimen.enteredAt', v, id, false) },
  { tag: 'specimen.fasting', re: /^Fasting\s*:?\s*(.*)$/i, below: /^(?:Y|N|YES|NO)$/i, apply: (c, v, id) => setField(c, 'specimen.fasting', normalizeYesNo(v), id) },
  { tag: 'provider.accountNumber', re: /^(?:Client|Account)\s*(?:#|Number|No\.?)\s*:?\s*(.*)$/i, below: ID_SHAPE, apply: (c, v, id) => setField(c, 'provider.accountNumber', v, id) },
  { tag: 'provider.npi', re: /^NPI\s*:?\s*(.*)$/i, below: /^\d{10}$/, apply: (c, v, id) => setField(c, 'provider.npi', v, id) },
  { tag: 'provider.orderingName', re: /^(?:Ordered\s+by|Ordering\s+(?:Physician|Provider)|Physician|Provider)\s*:?\s*(.*)$/i, below: NAME_SHAPE, apply: (c, v, id) => setField(c, 'provider.orderingName', v, id) },
  { tag: 'patient.fullName', re: /^Results\s+for\s*:?\s*(.*)$/i, below: NAME_SHAPE, apply: (c, v, id) => setName(c, v, id) },
  { tag: 'patient.fullName', re: /^Patient(?:\s+Name)?\s*:\s*(.*)$/i, below: NAME_SHAPE, apply: (c, v, id) => setName(c, v, id) },
  { tag: 'source.reportStatus', re: /^(?:Report\s+)?Status\s*:\s*((?:FINAL|PARTIAL|CORRECTED|PRELIMINARY|PRELIM)(?:\s+(?:REPORT|RESULTS?))?)?$/i, below: (v) => STATUS_RE.test(v), apply: (c, v, id) => { const m = v.match(STATUS_RE); return m ? setField(c, 'source.reportStatus', STATUS_MAP[m[1].toUpperCase()], id) : false; } },
  { tag: 'performingLabs', re: /^Performed\s+(?:at|by)\s*:?\s*(.*)$/i, below: null, apply: (c, v, id) => { if (!v) return false; absorbLabText(addPerformingLab(c, null, id), v); return true; } },
];

const isLabelish = (t) => LABELS.some((l) => l.re.test(t)) || BLOCK_RES.some(([, re]) => re.test(t)) || STATUS_RE.test(t) || VENDOR_RE.test(t) || !!parsePageOf(t);
const shapeOk = (shape, v) => (shape instanceof RegExp ? shape.test(v) : typeof shape === 'function' ? shape(v) : false);

/** "DOB: 01/15/1980  AGE: 45  Gender: M" (one text item) → ["DOB: 01/15/1980", "AGE: 45", "Gender: M"]; null when < 2 labels. */
function splitLabelCell(text) {
  const t = clean(text);
  if (!LABEL_START_RE.test(t)) return null;                               // ". Vitamin D Status: ..." is a comment, not labels
  const parts = t.split(LABEL_SPLIT_RE).map((s) => s.trim()).filter(Boolean);
  return parts.length >= 2 && parts.every((p) => LABEL_START_RE.test(p)) ? parts : null;
}

function blockFor(ctx, x) {
  let best = null;
  for (const [kind, bx] of Object.entries(ctx.blocks)) if (bx <= x + BLOCK_TOL && (best == null || bx > ctx.blocks[best])) best = kind;
  return best;
}

/** In table mode a label must carry an explicit ':' and the value must be what follows the colon; never a lowercase sentence. */
function labelAllowed(ctx, text, m) {
  if (/^[a-z]/.test(text) && PROSE_RE.test(text)) return false;
  if (ctx.mode === 'header') return true;
  const colon = text.indexOf(':');
  if (colon <= 0 || colon > 28) return false;
  return clean(text.slice(colon + 1)) === clean(m[1]);
}

/** Try the LABELS on one label segment. Returns a reason tag or null. */
function applyLabel(ctx, line, text, x, i, cells, cellX, block, next) {
  for (const label of LABELS) {
    const m = text.match(label.re);
    if (!m) continue;
    if (!labelAllowed(ctx, text, m)) return null;
    let v = clean(m[1]);
    if (!v && i != null && i + 1 < cells.length && cellX[i + 1] - x < NEXT_CELL_MAX_DX && !isLabelish(clean(cells[i + 1])) && !splitLabelCell(cells[i + 1])) {
      v = clean(cells[i + 1]);
      ctx.skipCells.add(i + 1);
    }
    if (!v && label.below && next && next.page === line.page) {           // value printed on the line below its label
      const ncells = cellsOf(next), nx = cellXOf(next);
      for (let j = 0; j < ncells.length; j++) {
        const nt = clean(ncells[j]);
        if (Math.abs(nx[j] - x) > BELOW_X_TOL || !nt || isLabelish(nt) || splitLabelCell(nt) || !shapeOk(label.below, nt)) continue;
        if (label.tag === 'patient.fullName' || label.tag === 'provider.orderingName') { if (resultLike(nt) || /\d/.test(nt)) continue; }
        v = nt;
        let pb = ctx.pendingBelow.get(next.id);
        if (!pb) { pb = new Map(); ctx.pendingBelow.set(next.id, pb); }
        pb.set(j, label.tag === 'phone' ? (block === 'client' ? 'provider.phone' : 'patient.phone') : label.tag);
        break;
      }
    }
    label.apply(ctx, v, line.id, block);
    const tag = label.tag === 'phone' ? (block === 'client' ? 'provider.phone' : 'patient.phone') : label.tag;
    return tag + (v ? '' : ':blank');
  }
  return null;
}

/** Classify one header/footer cell; applies side effects. Returns a reason tag or null. */
function classifyCell(ctx, line, i, cells, cellX, next) {
  const text = clean(cells[i]);
  const x = cellX[i];
  if (!text) return 'blank';
  for (const [kind, re] of BLOCK_RES) if (re.test(text)) { ctx.blocks[kind] = x; ctx.blockLine[kind] = ctx.lineIdx; return 'header.block'; }
  if (VENDOR_RE.test(text)) { ctx.vendorSeen = true; return 'header.vendor'; }
  let m = text.match(STATUS_RE);
  if (m) { setField(ctx, 'source.reportStatus', STATUS_MAP[m[1].toUpperCase()], line.id); return 'header.status'; }
  const po = parsePageOf(text);
  if (po && /^Page\b/i.test(text)) { ctx.pages.push({ ...po, lineId: line.id, page: line.page, printed: po.page }); return 'pageno'; }
  if (CLIENT_SERVICES_RE.test(text)) return 'footer.clientServices';
  if (DISCLAIMER_RE.test(text)) return 'footer.disclaimer';
  const block = blockFor(ctx, x);
  const segs = splitLabelCell(text);
  if (segs) {                                                               // several "Label: value" pairs in one cell
    const tags = [];
    let any = false;
    for (const seg of segs) {
      const t = applyLabel(ctx, line, seg, x, null, cells, cellX, block, next);
      if (t) { any = true; if (!tags.includes(t)) tags.push(t); }
    }
    if (any) return tags.join('+');
  }
  const tag = applyLabel(ctx, line, text, x, i, cells, cellX, block, next);
  if (tag) return tag;
  if (ctx.report.patient.fullName && text === ctx.report.patient.fullName) { addEvidence(ctx, 'patient.fullName', line.id); return 'patient.fullName'; }
  if (ctx.report.specimen.specimenId && text === ctx.report.specimen.specimenId) { addEvidence(ctx, 'specimen.specimenId', line.id); return 'specimen.specimenId'; }
  if (ctx.mode !== 'header') return null;
  const inPatientBlock = block === 'patient' && ctx.blockLine.patient != null && ctx.lineIdx - ctx.blockLine.patient <= 4;
  if ((inPatientBlock || (block == null && ctx.lineIdx < 3)) && PERSON_NAME_RE.test(text) && !resultLike(line)) { setName(ctx, text, line.id); return 'patient.fullName'; }
  if (block === 'patient') { ctx.pageAcc.patientAddress.push({ text, id: line.id }); return 'patient.address'; }
  if (block === 'client') {
    if (!ctx.pageAcc.ordering) { ctx.pageAcc.ordering = { text, id: line.id }; return 'provider.orderingName'; }
    if (!/\d/.test(text) && !ctx.pageAcc.address.length) { ctx.pageAcc.accountName.push({ text, id: line.id }); return 'provider.accountName'; }
    ctx.pageAcc.address.push({ text, id: line.id });
    return 'provider.address';
  }
  return null;
}

function flushPageAcc(ctx) {
  const acc = ctx.pageAcc;
  const join = (arr, sep) => arr.map((a) => a.text).join(sep);
  const ids = (arr) => arr.map((a) => a.id);
  if (acc.ordering) setField(ctx, 'provider.orderingName', acc.ordering.text, acc.ordering.id);
  if (acc.accountName.length) setField(ctx, 'provider.accountName', join(acc.accountName, ' '), ids(acc.accountName));
  if (acc.address.length) setField(ctx, 'provider.address', join(acc.address, ', '), ids(acc.address));
  if (acc.patientAddress.length) setField(ctx, 'patient.address', join(acc.patientAddress, ', '), ids(acc.patientAddress));
  ctx.pageAcc = { ordering: null, accountName: [], address: [], patientAddress: [] };
}

// ---------- performing-site legend ----------
function handleLegendLine(ctx, line, cells, cellX) {
  const text = clean(line.text);
  let code = null, rest = null;
  if (cells.length >= 2 && LAB_CODE_RE.test(clean(cells[0]))) { code = clean(cells[0]); rest = cells.slice(1).map(clean).join(' '); }
  else {
    const m = text.match(/^([A-Z][A-Z0-9]{1,2})\s+(.{6,})$/);
    if (m && /Quest|Lab|Diagnostics|Institute|Hospital|Clinic/i.test(m[2])) { code = m[1]; rest = m[2]; }
  }
  if (code) {
    ctx.currentLab = addPerformingLab(ctx, code, line.id);
    absorbLabText(ctx.currentLab, rest);
    ctx.consumed.set(line.id, `performingLab:${code}`);
    return true;
  }
  if (ctx.currentLab && (/(?:Laboratory|Lab\.?|Medical)\s+Director|CLIA|Phone|Tel/i.test(text) || (cells.length === 1 && /\d/.test(text) && /,/.test(text) && !parsePageOf(text)))) {
    absorbLabText(ctx.currentLab, text);
    addEvidence(ctx, 'performingLabs', line.id);
    ctx.consumed.set(line.id, `performingLab:${ctx.currentLab.code}`);
    return true;
  }
  return false;
}

// ---------- driver ----------
const cellsOf = (line) => (line.cells && line.cells.length ? line.cells.map(clean) : [clean(line.text)]);
const cellXOf = (line) => (line.cellX && line.cells && line.cellX.length === line.cells.length ? line.cellX : cellsOf(line).map(() => line.x0 ?? 0));

function handleLine(ctx, line, prev, next) {
  const text = clean(line.text);
  if (!text) { ctx.consumed.set(line.id, 'blank'); return; }
  const rawCells = cellsOf(line), rawCellX = cellXOf(line);

  if (ctx.mode === 'legend') {
    if (handleLegendLine(ctx, line, rawCells, rawCellX)) return;
    ctx.mode = 'footer';
    ctx.lastResult = null;
    ctx.currentLab = null;
  }
  const ps = text.match(PERFORMING_SITE_RE);
  if (ps) {
    ctx.mode = 'legend';
    ctx.lastResult = null;
    ctx.consumed.set(line.id, 'footer.performingSite');
    if (clean(ps[1])) { const restLine = { ...line, text: ps[1], cells: [ps[1]], cellX: [line.x0] }; if (handleLegendLine(ctx, restLine, [clean(ps[1])], [line.x0])) ctx.consumed.set(line.id, 'footer.performingSite'); }
    return;
  }
  const cols = learnColumns(rawCells, rawCellX);
  if (cols) {
    ctx.columns = cols;
    ctx.mode = 'table';
    ctx.lastResult = null;
    ctx.lastWasComment = false;
    ctx.consumed.set(line.id, 'table.header');
    return;
  }
  const geo = cellGeometry(line, rawCells, rawCellX, ctx.columns);
  const cells = geo.cells, cellX = geo.cellX, cellX1 = geo.cellX1;

  // a document without a table header: the first result-shaped line (or a panel name right above one) starts the table
  if (ctx.mode === 'header' && !ctx.columns) {
    const info = fallbackRowOk(line);
    if (info) { commitRow(ctx, line, info); return; }
    if (cells.length === 1 && isUpperDominant(text) && next && next.page === line.page && fallbackRowOk(next)
        && tryPanelOrWrap(ctx, line, cells, cellX, cellX1, prev, next)) return;
  }

  // header / footer cells (labels, boilerplate)
  ctx.skipCells = new Set();
  const reasons = [];
  let classified = 0;
  const pre = ctx.pendingBelow.get(line.id);
  for (let i = 0; i < rawCells.length; i++) {
    if (pre && pre.has(i)) { classified++; if (!reasons.includes(pre.get(i))) reasons.push(pre.get(i)); continue; }
    if (ctx.skipCells.has(i)) { classified++; continue; }
    const r = classifyCell(ctx, line, i, rawCells, rawCellX, next);
    if (r) { classified++; if (!reasons.includes(r)) reasons.push(r); }
  }
  if (pre) ctx.pendingBelow.delete(line.id);
  if (classified === rawCells.length) { ctx.consumed.set(line.id, reasons.join(',')); return; }
  if (ctx.mode === 'footer') return;                                    // after the legend: only boilerplate is understood
  if (ctx.mode === 'header' && classified > 0) { ctx.notes.push(`partially understood header line ${line.id}: ${reasons.join(',')}`); return; }

  // result rows
  const info = analyzeRow(ctx, line, cells, cellX, cellX1);
  if (info && (ctx.columns || ctx.mode === 'table' || cells.length >= 3)) { commitRow(ctx, line, info); return; }
  if (tryPanelOrWrap(ctx, line, cells, cellX, cellX1, prev, next)) return;
  if (ctx.mode === 'table') {
    const rl = resultLike(line);
    if (rl) {
      const relaxed = relaxedRow(ctx, line, cells);
      if (relaxed) { commitRow(ctx, line, relaxed); return; }
    }
    let nonName = 0;
    if (ctx.columns) nonName = Object.keys(assignColumns(cells, cellX, cellX1, ctx.columns)).filter((k) => k !== 'name').length;
    else nonName = Math.max(0, cells.length - 1);
    // A comment never has ≥2 non-name cells, and never has the strict shape of a table row: such lines stay UNCONSUMED
    // so the coverage audit reports them instead of silently filing a dropped row under the previous result.
    if (nonName >= 2 || (rl && nonName >= 1 && resultRowLike({ text, cells }))) {
      ctx.notes.push(`result-shaped line not parsed: ${line.id}`);
      return;
    }
    attachComment(ctx, line, text);
  }
}

/** Age in whole years at `isoDate` for someone born on `dob` (both ISO); null when not computable. */
function ageAt(dob, isoDate) {
  if (!dob || !isoDate) return null;
  const [by, bm, bd] = dob.split('-').map(Number);
  const [cy, cm, cd] = isoDate.slice(0, 10).split('-').map(Number);
  if (![by, bm, bd, cy, cm, cd].every(Number.isFinite)) return null;
  let age = cy - by;
  if (cm < bm || (cm === bm && cd < bd)) age--;
  return age >= 0 && age < 130 ? age : null;
}

/**
 * Parse a Quest Diagnostics Document (classic report or MyQuest portal export).
 * @param {object} doc Document per SPEC §2
 * @returns {{ report: object, consumed: Map<string,string>, notes: string[], fieldEvidence: Record<string,string[]> }}
 */
export function parseQuest(doc) {
  const ctx = {
    report: emptyReport(), consumed: new Map(), notes: [], fieldEvidence: {},
    conflicts: new Set(), blocks: {}, blockLine: {}, pageAcc: { ordering: null, accountName: [], address: [], patientAddress: [] },
    columns: null, mode: 'header', currentPanel: null, lastResult: null, lastWasComment: false, pendingName: null,
    seq: 0, meta: new Map(), labs: new Map(), codelessLabs: [], currentLab: null, labCodesUsed: new Set(),
    pages: [], vendorSeen: false, skipCells: new Set(), pendingBelow: new Map(), lineIdx: 0, pageLeft: 0,
  };
  const report = ctx.report;
  report.id = doc.fileHash ?? null;
  report.source.vendor = 'quest';
  report.source.fileName = doc.fileName ?? null;
  report.source.fileHash = doc.fileHash ?? null;
  report.source.pageCount = doc.pageCount ?? (doc.pages ? doc.pages.length : 0);
  report.source.parserVersion = QUEST_PARSER_VERSION;

  for (const page of doc.pages || []) {
    const lines = page.lines || [];
    ctx.mode = 'header';
    ctx.blocks = {};
    ctx.blockLine = {};
    ctx.currentLab = null;
    ctx.pendingName = null;
    ctx.pendingBelow = new Map();
    ctx.lastWasComment = false;
    ctx.pageLeft = lines.length ? Math.min(...lines.map((l) => l.x0 ?? 0)) : 0;
    for (let i = 0; i < lines.length; i++) {
      ctx.lineIdx = i;
      try {
        handleLine(ctx, lines[i], i > 0 ? lines[i - 1] : null, i + 1 < lines.length ? lines[i + 1] : null);
      } catch (e) {
        ctx.notes.push(`parser error at ${lines[i].id}: ${e && e.message ? e.message : e}`);
      }
    }
    if (ctx.pendingName) { ctx.pendingName = null; }   // never committed: line stays unconsumed
    flushPageAcc(ctx);
  }

  // age at collection from DOB when no AGE label was printed (MyQuest)
  if (report.patient.ageAtCollection == null && report.patient.dob && report.specimen.collectedAt) {
    const age = ageAt(report.patient.dob, report.specimen.collectedAt);
    if (age != null) {
      report.patient.ageAtCollection = age;
      addEvidence(ctx, 'patient.ageAtCollection', [...(ctx.fieldEvidence['patient.dob'] || []), ...(ctx.fieldEvidence['specimen.collectedAt'] || [])]);
    }
  }

  // performing labs: legend entries first, then codes seen in rows without a legend entry, then code-less (MyQuest)
  report.performingLabs = [...ctx.labs.values()];
  for (const code of ctx.labCodesUsed) {
    if (!ctx.labs.has(code)) { report.performingLabs.push({ code, name: null, address: null, director: null, clia: null, phone: null }); ctx.notes.push(`performing site ${code} used by results but not described in a PERFORMING SITE legend`); }
  }
  report.performingLabs.push(...ctx.codelessLabs);
  if (ctx.codelessLabs.length) ctx.notes.push('performing lab given without a site code (MyQuest "Performed at"); performingLabs[].code is null');

  // page numbering
  const declared = ctx.pages.length ? Math.max(...ctx.pages.map((p) => p.of)) : null;
  if (declared != null && declared !== report.source.pageCount) ctx.notes.push(`document declares ${declared} pages but ${report.source.pageCount} were read`);
  if (ctx.pages.length) addEvidence(ctx, 'source.pageCount', ctx.pages.map((p) => p.lineId));

  // preliminary per-result confidence (SPEC §5)
  for (const r of report.results) {
    const meta = ctx.meta.get(r.id) || {};
    let c = 1.0;
    const numeric = r.value != null;
    if (r.fieldStatus.value === 'missing') c -= 0.4;
    if (numeric && r.fieldStatus.unit === 'missing') c -= 0.25;
    if (numeric && r.fieldStatus.range === 'missing') c -= 0.25;
    if (meta.wrapped) c -= 0.1;
    if (meta.misaligned) c -= 0.1;
    r.confidence = Math.max(0, Math.min(1, Math.round(c * 100) / 100));
  }
  report.source.vendorConfidence = ctx.vendorSeen ? 1 : (report.results.length ? 0.6 : 0.2);
  if (!report.results.length) ctx.notes.push('no result rows recognized');

  return { report, consumed: ctx.consumed, notes: ctx.notes, fieldEvidence: ctx.fieldEvidence };
}
