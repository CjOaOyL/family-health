// src/parse/quest.js — Quest Diagnostics parser: classic report + MyQuest portal variant.
// Contract: docs/SPEC.md §4 (ParseResult), §5 (preliminary confidence), §6 (layout notes).
// Pure, isomorphic, deterministic. No I/O.
import {
  parseUSDate, parseValue, parseRange, normalizeFlag, isUnitToken, splitName, normalizeSex, normalizeYesNo,
  parsePageOf, clean, parseAge,
} from './common.js';
import { emptyReport, emptyResult } from '../model/schema.js';

export const QUEST_PARSER_VERSION = '1.0.0';

const COL_TOL = 14;      // pt: a cell belongs to the right-most column whose x <= cellX + COL_TOL
const INDENT_TOL = 3;    // pt: panel names sit at the Test Name column x; result names are indented past this
const NEXT_CELL_MAX_DX = 120; // pt: "Label:" with an empty value may take the next cell as its value if it is this close

const STATUS_RE = /^(?:REPORT\s+STATUS\s*:\s*)?(FINAL|PARTIAL|CORRECTED|PRELIMINARY|PRELIM)(?:\s+REPORT)?$/i;
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
const VALUE_FLAG_RE = /^(.*?)(?:\s+(HH|LL|H|L|A|C)|\s*(\*{1,2}))$/i;

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

function isUpperDominant(text) {
  const letters = text.match(/[A-Za-z]/g) || [];
  if (letters.length < 2) return false;
  const upper = text.match(/[A-Z]/g) || [];
  return upper.length / letters.length >= 0.85;
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

/** Group a line's cells by column role (cells in the same column are joined with a single space). */
function assignColumns(cells, cellX, columns) {
  const out = {};
  cells.forEach((c, i) => {
    const x = cellX[i];
    let role = columns.cols[0].role;
    for (const col of columns.cols) if (col.x <= x + COL_TOL) role = col.role;
    if (!out[role]) out[role] = { text: '', x, idx: [] };
    out[role].text = (out[role].text ? out[role].text + ' ' : '') + clean(c);
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

/** "210 H" → { text:'210', parsed:{...}, flag:'H' }; "12.5*" → flag 'A'; "32 ng/mL" → inlineUnit. */
function parseValueCell(raw) {
  let t = clean(raw);
  if (!t) return null;
  let flag = null;
  const m = t.match(VALUE_FLAG_RE);
  if (m && m[1].trim()) { flag = normalizeFlag(m[2] || m[3]); t = m[1].trim(); }
  let parsed = parseValue(t), inlineUnit = null;
  if (!parsed) {
    const toks = t.split(' ');
    for (let n = Math.min(3, toks.length - 1); n >= 1; n--) {
      const suf = toks.slice(toks.length - n).join(' ');
      if (isUnit(suf)) { const p2 = parseValue(toks.slice(0, toks.length - n).join(' ')); if (p2) { parsed = p2; inlineUnit = suf; } break; }
    }
  }
  return { raw: clean(raw), text: t, parsed, flag, inlineUnit };
}

const normalizeRangeText = (t) => t.replace(/^([<>])\s*OR\s*=\s*/i, '$1=').replace(/^(?:>|greater than)\s*OR\s*(?:EQUAL(?:\s+TO)?|=)\s*/i, '>=');

// ---------- result rows ----------
/** Pure analysis of a line as a result row. Returns null when the line is not result-shaped. */
function analyzeRow(ctx, line, cells, cellX) {
  if (ctx.columns) {
    const a = assignColumns(cells, cellX, ctx.columns);
    const name = a.name ? a.name.text : '';
    const rawIn = a.inRange?.text, rawOut = a.outRange?.text, rawVal = a.value?.text, rawRef = a.ref?.text;
    const rawUnits = a.units?.text, rawFlag = a.flag?.text, rawLab = a.lab?.text;
    const nonName = Object.keys(a).filter((k) => k !== 'name').length;
    if (!nonName) return null;
    if (!name && !ctx.pendingName) return null;
    if (name && !/^[A-Za-z%(]/.test(name)) return null;
    let valueCell = null, inOut = null;
    if (rawOut) { valueCell = rawOut; inOut = 'out'; } else if (rawIn) { valueCell = rawIn; inOut = 'in'; } else if (rawVal) { valueCell = rawVal; inOut = 'value'; }
    const v = valueCell ? parseValueCell(valueCell) : null;
    const refSplit = splitRefCell(rawRef);
    const unit = rawUnits ? clean(rawUnits) : (refSplit.unit || (v && v.inlineUnit) || null);
    const lab = rawLab ? clean(rawLab) : null;
    const labOk = !!(lab && LAB_CODE_RE.test(lab));
    const refOk = !!(refSplit.unit || refSplit.rangeText);
    const valueOk = !!(v && v.parsed);
    if (!valueOk && !refOk && !labOk) return null;
    if (!valueCell && !refOk) return null;
    return { name, v, inOut, bothCols: !!(rawOut && rawIn), refSplit, unit, lab, labOk, rawFlag, misaligned: false, nonName };
  }
  return analyzeRowFallback(cells);
}

/** No table header seen: infer [name, value?, reference?, lab?] from cell shapes. Marks the row misaligned (−0.1). */
function analyzeRowFallback(cells) {
  if (cells.length < 2 || cells.length > 5) return null;
  const name = clean(cells[0]);
  if (!/^[A-Za-z%(]/.test(name) || /:$/.test(name) || /^(?:Page|Patient|Specimen|Client|Reference)\b/i.test(name)) return null;
  const rest = cells.slice(1).map(clean);
  let lab = null;
  if (rest.length >= 2 && LAB_CODE_RE.test(rest[rest.length - 1])) lab = rest.pop();
  let refSplit = { rangeText: null, unit: null }, v = null;
  if (rest.length >= 2) {
    refSplit = splitRefCell(rest[rest.length - 1]);
    if (!refSplit.unit && !refSplit.rangeText) return null;
    v = parseValueCell(rest[0]);
    if (rest.length === 3 && !v?.flag) { const f = normalizeFlag(rest[1]); if (f) v.flag = f; else return null; }
    if (rest.length > 3) return null;
  } else if (rest.length === 1) {
    v = parseValueCell(rest[0]);
    if (!v?.parsed) { v = null; refSplit = splitRefCell(rest[0]); if (!refSplit.unit && !refSplit.rangeText) return null; }
  }
  if (!v && !refSplit.unit && !refSplit.rangeText) return null;
  const unit = refSplit.unit || (v && v.inlineUnit) || null;
  return { name, v, inOut: v?.flag ? 'out' : 'in', bothCols: false, refSplit, unit, lab, labOk: !!lab, rawFlag: null, misaligned: true, nonName: rest.length + (lab ? 1 : 0) };
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
    if (!info.v.parsed) ctx.notes.push(`${r.id}: value "${r.valueText}" not recognized as numeric or known text value (${line.id})`);
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
  else if (info.lab) ctx.notes.push(`${r.id}: Lab column text "${info.lab}" is not a site code (${line.id})`);
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
function tryPanelOrWrap(ctx, line, cells, cellX, prev, next) {
  const text = clean(line.text);
  if (ctx.columns) {
    const a = assignColumns(cells, cellX, ctx.columns);
    if (Object.keys(a).some((k) => k !== 'name')) return false;
  } else if (cells.length > 1) return false;
  if (!isUpperDominant(text) || text.length > 70 || /[:;]/.test(text) || /^[.•·]/.test(text) || /\.$/.test(text)) return false;
  if (!/^[A-Z%(]/.test(text)) return false;
  const nameX = ctx.columns ? ctx.columns.nameX : ctx.pageLeft;
  const indented = line.x0 > nameX + INDENT_TOL;
  const incomplete = INCOMPLETE_TAIL_RE.test(text);
  const nextIsRow = !!(next && next.page === line.page && !ctx.pendingName && analyzeRow(ctx, next, cellsOf(next), cellXOf(next)));
  if (nextIsRow && (indented || incomplete)) {           // wrapped name, continuation ABOVE the value line
    ctx.pendingName = { text, lineId: line.id };
    return true;                                           // consumed when the row commits
  }
  const lr = ctx.lastResult;
  if (lr && prev && lr.lineIds[lr.lineIds.length - 1] === prev.id && !ctx.lastWasComment
      && (indented || INCOMPLETE_TAIL_RE.test(lr.name))) { // wrapped name, continuation BELOW the value line
    lr.name = clean(`${lr.name} ${text}`);
    lr.lineIds.push(line.id);
    (ctx.meta.get(lr.id) || ctx.meta.set(lr.id, {}).get(lr.id)).wrapped = true;
    ctx.consumed.set(line.id, `result:${lr.id}:name-wrap`);
    return true;
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
const LABELS = [
  { tag: 'patient.dob', re: /^(?:DOB|Date\s+of\s+Birth|Birth\s*Date)\s*:?\s*(.*)$/i, apply: (c, v, id) => setDate(c, 'patient.dob', v, id, true) },
  { tag: 'patient.ageAtCollection', re: /^AGE\s*:?\s*(.*)$/i, apply: (c, v, id) => setField(c, 'patient.ageAtCollection', parseAge(v), id) },
  { tag: 'patient.sex', re: /^(?:Gender|Sex)\s*:?\s*(.*)$/i, apply: (c, v, id) => setField(c, 'patient.sex', normalizeSex(v), id) },
  { tag: 'patient.patientId', re: /^Patient\s*ID\s*:?\s*(.*)$/i, apply: (c, v, id) => setField(c, 'patient.patientId', v, id) },
  { tag: 'phone', re: /^(?:Phone|Tel(?:ephone)?)\s*:?\s*(.*)$/i, apply: (c, v, id, block) => setField(c, block === 'client' ? 'provider.phone' : 'patient.phone', v, id) },
  { tag: 'provider.fax', re: /^Fax\s*:?\s*(.*)$/i, apply: (c, v, id) => setField(c, 'provider.fax', v, id) },
  { tag: 'specimen.specimenId', re: /^Specimen\s*(?:#|ID|Number|No\.?)?\s*:\s*(.*)$/i, apply: (c, v, id) => setField(c, 'specimen.specimenId', v, id) },
  { tag: 'specimen.requisition', re: /^Requisition\s*(?:#|No\.?)?\s*:?\s*(.*)$/i, apply: (c, v, id) => setField(c, 'specimen.requisition', v, id) },
  { tag: 'specimen.labRef', re: /^Lab\s*Ref(?:erence)?\s*#?\s*:?\s*(.*)$/i, apply: (c, v, id) => setField(c, 'specimen.labRef', v, id) },
  { tag: 'specimen.collectedAt', re: /^Collected(?:\s+on)?\s*:?\s*(.*)$/i, apply: (c, v, id) => setDate(c, 'specimen.collectedAt', v, id, false, 'specimen.collectedTz') },
  { tag: 'specimen.receivedAt', re: /^Received(?:\s+on)?\s*:?\s*(.*)$/i, apply: (c, v, id) => setDate(c, 'specimen.receivedAt', v, id, false) },
  { tag: 'specimen.reportedAt', re: /^Reported(?:\s+on)?\s*:?\s*(.*)$/i, apply: (c, v, id) => setDate(c, 'specimen.reportedAt', v, id, false) },
  { tag: 'specimen.enteredAt', re: /^Entered(?:\s+on)?\s*:?\s*(.*)$/i, apply: (c, v, id) => setDate(c, 'specimen.enteredAt', v, id, false) },
  { tag: 'specimen.fasting', re: /^Fasting\s*:?\s*(.*)$/i, apply: (c, v, id) => setField(c, 'specimen.fasting', normalizeYesNo(v), id) },
  { tag: 'provider.accountNumber', re: /^(?:Client|Account)\s*(?:#|Number|No\.?)\s*:?\s*(.*)$/i, apply: (c, v, id) => setField(c, 'provider.accountNumber', v, id) },
  { tag: 'provider.npi', re: /^NPI\s*:?\s*(.*)$/i, apply: (c, v, id) => setField(c, 'provider.npi', v, id) },
  { tag: 'provider.orderingName', re: /^(?:Ordered\s+by|Ordering\s+(?:Physician|Provider)|Physician|Provider)\s*:?\s*(.*)$/i, apply: (c, v, id) => setField(c, 'provider.orderingName', v, id) },
  { tag: 'patient.fullName', re: /^Results\s+for\s*:?\s*(.*)$/i, apply: (c, v, id) => setName(c, v, id) },
  { tag: 'patient.fullName', re: /^Patient(?:\s+Name)?\s*:\s*(.*)$/i, apply: (c, v, id) => setName(c, v, id) },
  { tag: 'source.reportStatus', re: /^(?:Report\s+)?Status\s*:\s*(.*)$/i, apply: (c, v, id) => { const m = v.match(STATUS_RE); return m ? setField(c, 'source.reportStatus', STATUS_MAP[m[1].toUpperCase()], id) : false; } },
  { tag: 'performingLabs', re: /^Performed\s+(?:at|by)\s*:?\s*(.*)$/i, apply: (c, v, id) => { if (!v) return false; absorbLabText(addPerformingLab(c, null, id), v); return true; } },
];

const isLabelish = (t) => LABELS.some((l) => l.re.test(t)) || BLOCK_RES.some(([, re]) => re.test(t)) || STATUS_RE.test(t) || VENDOR_RE.test(t) || !!parsePageOf(t);

function blockFor(ctx, x) {
  let best = null;
  for (const [kind, bx] of Object.entries(ctx.blocks)) if (bx <= x + COL_TOL && (best == null || bx > ctx.blocks[best])) best = kind;
  return best;
}

/** Classify one header/footer cell; applies side effects. Returns a reason tag or null. */
function classifyCell(ctx, line, i, cells, cellX) {
  const text = clean(cells[i]);
  const x = cellX[i];
  if (!text) return 'blank';
  for (const [kind, re] of BLOCK_RES) if (re.test(text)) { ctx.blocks[kind] = x; return 'header.block'; }
  if (VENDOR_RE.test(text)) { ctx.vendorSeen = true; return 'header.vendor'; }
  let m = text.match(STATUS_RE);
  if (m) { setField(ctx, 'source.reportStatus', STATUS_MAP[m[1].toUpperCase()], line.id); return 'header.status'; }
  const po = parsePageOf(text);
  if (po && /^Page\b/i.test(text)) { ctx.pages.push({ ...po, lineId: line.id, page: line.page, printed: po.page }); return 'pageno'; }
  if (CLIENT_SERVICES_RE.test(text)) return 'footer.clientServices';
  if (DISCLAIMER_RE.test(text)) return 'footer.disclaimer';
  const block = blockFor(ctx, x);
  for (const label of LABELS) {
    if (!(m = text.match(label.re))) continue;
    let v = clean(m[1]);
    if (!v && i + 1 < cells.length && cellX[i + 1] - x < NEXT_CELL_MAX_DX && !isLabelish(clean(cells[i + 1]))) {
      v = clean(cells[i + 1]);
      ctx.skipCells.add(i + 1);
    }
    label.apply(ctx, v, line.id, block);
    const tag = label.tag === 'phone' ? (block === 'client' ? 'provider.phone' : 'patient.phone') : label.tag;
    return tag + (v ? '' : ':blank');
  }
  if (ctx.report.patient.fullName && text === ctx.report.patient.fullName) { addEvidence(ctx, 'patient.fullName', line.id); return 'patient.fullName'; }
  if (ctx.report.specimen.specimenId && text === ctx.report.specimen.specimenId) { addEvidence(ctx, 'specimen.specimenId', line.id); return 'specimen.specimenId'; }
  if (ctx.mode !== 'header') return null;
  if ((block === 'patient' || (block == null && ctx.lineIdx < 8)) && PERSON_NAME_RE.test(text)) { setName(ctx, text, line.id); return 'patient.fullName'; }
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
  const cells = cellsOf(line), cellX = cellXOf(line);

  if (ctx.mode === 'legend') {
    if (handleLegendLine(ctx, line, cells, cellX)) return;
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
  const cols = learnColumns(cells, cellX);
  if (cols) {
    ctx.columns = cols;
    ctx.mode = 'table';
    ctx.lastResult = null;
    ctx.lastWasComment = false;
    ctx.consumed.set(line.id, 'table.header');
    return;
  }

  // header / footer cells (labels, boilerplate)
  ctx.skipCells = new Set();
  const reasons = [];
  let classified = 0;
  for (let i = 0; i < cells.length; i++) {
    if (ctx.skipCells.has(i)) { classified++; continue; }
    const r = classifyCell(ctx, line, i, cells, cellX);
    if (r) { classified++; if (!reasons.includes(r)) reasons.push(r); }
  }
  if (classified === cells.length) { ctx.consumed.set(line.id, reasons.join(',')); return; }
  if (ctx.mode === 'footer') return;                                    // after the legend: only boilerplate is understood
  if (ctx.mode === 'header' && classified > 0) { ctx.notes.push(`partially understood header line ${line.id}: ${reasons.join(',')}`); return; }

  // result rows
  const info = analyzeRow(ctx, line, cells, cellX);
  if (info && (ctx.columns || ctx.mode === 'table' || cells.length >= 3)) { commitRow(ctx, line, info); return; }
  if (tryPanelOrWrap(ctx, line, cells, cellX, prev, next)) return;
  if (ctx.mode === 'table') {
    if (ctx.columns) {
      const a = assignColumns(cells, cellX, ctx.columns);
      const nonName = Object.keys(a).filter((k) => k !== 'name').length;
      if (nonName >= 2) { ctx.notes.push(`result-shaped line not parsed: ${line.id}`); return; }   // leave for the audit
    }
    attachComment(ctx, line, text);
  }
}

/**
 * Parse a Quest Diagnostics Document (classic report or MyQuest portal export).
 * @param {object} doc Document per SPEC §2
 * @returns {{ report: object, consumed: Map<string,string>, notes: string[], fieldEvidence: Record<string,string[]> }}
 */
export function parseQuest(doc) {
  const ctx = {
    report: emptyReport(), consumed: new Map(), notes: [], fieldEvidence: {},
    conflicts: new Set(), blocks: {}, pageAcc: { ordering: null, accountName: [], address: [], patientAddress: [] },
    columns: null, mode: 'header', currentPanel: null, lastResult: null, lastWasComment: false, pendingName: null,
    seq: 0, meta: new Map(), labs: new Map(), codelessLabs: [], currentLab: null, labCodesUsed: new Set(),
    pages: [], vendorSeen: false, skipCells: new Set(), lineIdx: 0, pageLeft: 0,
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
    ctx.currentLab = null;
    ctx.pendingName = null;
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
