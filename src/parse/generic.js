// Best-effort fallback parser for unknown vendors (or when a vendor parser throws).
// Finds label:value header fields (SPEC §6 label sets) and result-shaped rows using the shared helpers.
import {
  parseUSDate, findDate, parseValue, parseRange, normalizeFlag, FLAG_TOKEN_RE, isUnitToken, isTextValue,
  splitName, normalizeSex, normalizeYesNo, parsePageOf, parseAge, clean,
} from './common.js';
import { emptyResult } from '../model/schema.js';
import { isBoilerplate, resultLike } from '../audit/confidence.js';

/**
 * Header field labels. Order matters only for display; matching finds every label on a line and takes
 * the text up to the next label as the value. `colon: false` labels are phrase-style ("Collected on").
 */
export const FIELD_LABELS = [
  { path: 'patient.fullName', kind: 'name', labels: ['Patient Name', 'Patient', 'Name'] },
  { path: 'patient.fullName', kind: 'name', labels: ['Results for'], colon: false },
  { path: 'patient.dob', kind: 'date', labels: ['Date of Birth', 'Birth Date', 'Birthdate', 'DOB'] },
  { path: 'patient.ageAtCollection', kind: 'age', labels: ['Age'] },
  { path: 'patient.sex', kind: 'sex', labels: ['Gender', 'Sex'] },
  { path: 'patient.patientId', kind: 'text', labels: ['Patient ID', 'Patient #', 'Patient Number', 'MRN', 'PID'] },
  { path: 'patient.phone', kind: 'text', labels: ['Phone'] },
  { path: 'specimen.collectedAt', kind: 'datetime', labels: ['Date collected', 'Collection Date', 'Date of Collection', 'Collected'] },
  { path: 'specimen.collectedAt', kind: 'datetime', labels: ['Collected on'], colon: false },
  { path: 'specimen.receivedAt', kind: 'datetime', labels: ['Date received', 'Received'] },
  { path: 'specimen.reportedAt', kind: 'datetime', labels: ['Date reported', 'Report Date', 'Reported', 'Date Issued'] },
  { path: 'specimen.enteredAt', kind: 'datetime', labels: ['Date entered', 'Entered'] },
  { path: 'specimen.specimenId', kind: 'text', labels: ['Specimen ID', 'Specimen Number', 'Specimen #', 'Accession #', 'Accession', 'Specimen'] },
  { path: 'specimen.requisition', kind: 'text', labels: ['Requisition #', 'Requisition', 'Req #'] },
  { path: 'specimen.labRef', kind: 'text', labels: ['Lab Ref #', 'Lab Ref'] },
  { path: 'specimen.fasting', kind: 'yesno', labels: ['Fasting'] },
  { path: 'provider.orderingName', kind: 'provider', labels: ['Ordering Physician', 'Ordering Provider', 'Ordering', 'Physician', 'Provider'] },
  { path: 'provider.orderingName', kind: 'provider', labels: ['Ordered by'], colon: false },
  { path: 'provider.referringName', kind: 'provider', labels: ['Referring Physician', 'Referring'] },
  { path: 'provider.npi', kind: 'text', labels: ['NPI'] },
  { path: 'provider.accountNumber', kind: 'text', labels: ['Account Number', 'Account #', 'Client #', 'Client Number', 'Account'] },
  { path: 'provider.fax', kind: 'text', labels: ['Fax'] },
];

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// One regex per label; longest labels first so "Patient ID" wins over "Patient".
const LABEL_MATCHERS = FIELD_LABELS.flatMap((f) => f.labels.map((label) => ({
  field: f,
  label,
  re: new RegExp(f.colon === false
    ? `(?:^|\\s)${escapeRe(label).replace(/\\\s+/g, '\\s+')}\\s+`
    : `(?:^|\\s)${escapeRe(label).replace(/\s+/g, '\\s+')}\\s*[:#]\\s*`, 'i'),
}))).sort((a, b) => b.label.length - a.label.length);

export const PANEL_RE = /\b(?:panel|profile|cbc|cmp|bmp|metabolic|lipid|differential|w\/|with|hepatic|thyroid|urinalysis|screen|antibod|hemogram|function)\b|\(\d+\)$/i;
export const STATUS_RE = /^\s*(?:(FINAL|PARTIAL|CORRECTED|PRELIMINARY)(?:\s+REPORT)?|(?:Final|Partial|Corrected|Preliminary)\s+Report)\s*$/;
export const TABLE_HEADER_RE = /^\s*(?:TESTS?|Test Name)\b.*\b(?:RESULT|In Range|Your Value)\b/i;
export const PERFORMING_LAB_RE = /^(\d{2}|[A-Z]{2,3})$/;
export const PERFORMING_LAB_LEGEND_RE = /^(\d{2}|[A-Z]{2,3})(?:\s+[A-Z]{2,3})?$/;
export const VENDOR_LINE_RE = /^(?:Lab[Cc]orp|Quest Diagnostics(?:\s+Incorporated)?|MyQuest)\b|\bPatient Report\b/;
/** Standalone "LAST, FIRST M" line (uppercase, no digits). */
export const NAME_LINE_RE = /^[A-Z][A-Z'\-]+(?:\s[A-Z][A-Z'\-]+)?,\s*[A-Z][A-Z'\-]+(?:\s+[A-Z][A-Z'\-]*\.?)*$/;
/** "DR. JANE SMITH" / "Dr. Jane Smith" cell in a client block. */
export const DR_CELL_RE = /^DR\.?\s+[A-Z][A-Za-z.'\-]+(?:\s+[A-Z][A-Za-z.'\-]+){1,3}$/i;
/** "Word words: ..." — a labelled note such as "Prediabetes: 5.7 - 6.4". */
export const LABELLED_NOTE_RE = /^[A-Za-z][A-Za-z ()\/\-]{1,40}:\s*\S/;
export const COMMENT_START_RE = /^(?:please note|note|comment|ref|desirable|optimal|reference range|interpretation|\.{2,}|\*)/i;
export const FLAG_WORD_RE = /^(?:H|L|HH|LL|A|C|HI|LO|High|Low|Critical(?: High| Low)?|Abnormal|Alert|\*|\*\*)\*?$/;

function setField(report, path, value) {
  const [sec, key] = path.split('.');
  if (!report[sec]) report[sec] = {};
  if (report[sec][key] == null && value != null && value !== '') { report[sec][key] = value; return true; }
  return false;
}

/** Interpret a raw label value according to its kind. Returns { value, extra? } or null. */
function interpretValue(kind, raw, report) {
  // A label's value never crosses a cell boundary (two or more spaces) in the joined text.
  const v = clean(String(raw ?? '').split(/\s{2,}/)[0]);
  if (!v) return null;
  switch (kind) {
    case 'name': { const n = splitName(v); return n.fullName ? { value: n.fullName, name: n } : null; }
    case 'provider': return /^[A-Za-z.,'\- ]{2,}$/.test(v) ? { value: v } : null;
    case 'date': { const d = findDate(v) || parseUSDate(v); return d ? { value: d.date } : null; }
    case 'datetime': { const d = findDate(v) || parseUSDate(v); return d ? { value: d.iso, tz: d.tz } : null; }
    case 'age': { const a = parseAge(v); return a != null ? { value: a } : null; }
    case 'sex': { const s = normalizeSex(v.split(/\s+/)[0]); return s ? { value: s } : null; }
    case 'yesno': { const b = normalizeYesNo(v.split(/\s+/)[0]); return b == null ? null : { value: b }; }
    case 'text': default: {
      const t = v.split(/\s{2,}/)[0].trim();
      return t ? { value: t } : null;
    }
  }
}

/**
 * Find every label on a line and the value text that follows it (up to the next label).
 * Returns [{ field, label, value, start }].
 */
export function findLabelPairs(text) {
  const found = [];
  const taken = [];
  for (const m of LABEL_MATCHERS) {
    const re = new RegExp(m.re.source, 'gi');
    let hit;
    while ((hit = re.exec(text))) {
      const start = hit.index + (hit[0].match(/^\s/) ? 1 : 0);
      const end = hit.index + hit[0].length;
      if (taken.some(([s, e]) => start < e && end > s)) continue; // overlaps a longer label already found
      taken.push([start, end]);
      found.push({ field: m.field, label: m.label, start, valueStart: end });
    }
  }
  found.sort((a, b) => a.start - b.start);
  return found.map((f, i) => ({
    field: f.field,
    label: f.label,
    start: f.start,
    value: text.slice(f.valueStart, i + 1 < found.length ? found[i + 1].start : text.length).trim(),
  }));
}

/** Quest prints "< OR = 4.0" / "> OR = 60"; fold these into "<=" / ">=" so parseRange understands them. */
export function normalizeRangeText(s) {
  return String(s).replace(/^<\s*OR\s*=\s*/i, '<=').replace(/^>\s*OR\s*=\s*/i, '>=');
}

/** Try to classify a token sequence (cells after the name) into value/flag/unit/range/lab code. */
function classifyTail(cells, lastCellIsLab) {
  const out = { value: null, flag: null, unit: null, range: null, lab: null, leftovers: [] };
  const list = [...cells];
  if (lastCellIsLab && list.length > 1 && PERFORMING_LAB_RE.test(list[list.length - 1]) && !isUnitToken(list[list.length - 1])) {
    out.lab = list.pop();
  }
  for (const cell of list) {
    const c = clean(cell);
    if (!c) continue;
    const toks = c.split(' ');
    // "210 H", "6.2 High", "NEGATIVE"
    if (!out.value) {
      const pv = parseValue(c);
      if (pv) { out.value = pv; continue; }
      const pv1 = parseValue(toks[0]);
      if (pv1 && toks.length >= 2) {
        const rest = toks.slice(1);
        if (FLAG_WORD_RE.test(rest.join(' ')) && normalizeFlag(rest.join(' '))) { out.value = pv1; out.flag = normalizeFlag(rest.join(' ')); continue; }
        if (rest.length === 1 && isUnitToken(rest[0])) { out.value = pv1; out.unit = rest[0]; continue; }
        if (rest.length === 2 && FLAG_WORD_RE.test(rest[0]) && isUnitToken(rest[1])) { out.value = pv1; out.flag = normalizeFlag(rest[0]); out.unit = rest[1]; continue; }
      }
      // "Not Detected" / "Non Reactive" variants with spaces
      if (isTextValue(c.replace(/\s+/g, '-')) || isTextValue(c.replace(/\s+/g, ''))) { out.value = { valueText: c, value: null, qualifier: null, isText: true }; continue; }
    }
    if (!out.flag && FLAG_WORD_RE.test(c) && normalizeFlag(c)) { out.flag = normalizeFlag(c); continue; }
    if (!out.unit && isUnitToken(c)) { out.unit = c; continue; }
    if (!out.range) {
      // "3.8-10.8 Thousand/uL", "Not Estab. ng/mL", "<5.7 % of total Hgb": range followed by a unit inside one cell
      const k = toks.findIndex((t, i) => i > 0 && isUnitToken(t));
      if (k > 0) {
        const r = parseRange(normalizeRangeText(toks.slice(0, k).join(' ')));
        if (r.kind && (r.kind !== 'text' || isTextValue(r.text))) {
          out.range = r; if (!out.unit) out.unit = toks[k];
          if (k + 1 < toks.length) out.leftovers.push(toks.slice(k + 1).join(' '));
          continue;
        }
      }
      const r = parseRange(normalizeRangeText(c));
      if (r.kind && r.kind !== 'text') { out.range = r; continue; }
      if (r.kind === 'text' && (isTextValue(c) || /^(?:see|not\s+estab)/i.test(c))) { out.range = r; continue; }
    }
    if (!out.lab && lastCellIsLab && PERFORMING_LAB_RE.test(c)) { out.lab = c; continue; }
    out.leftovers.push(c);
  }
  return out;
}

/** Is this a plausible result name (≥2 alphabetic chars, not a label, not a number)? */
function isNameLike(s) {
  const t = clean(s);
  if (!t || !/[A-Za-z]{2,}/.test(t)) return false;
  if (/[:#]/.test(t)) return false;
  if (COMMENT_START_RE.test(t)) return false;
  if (parseValue(t)) return false;
  if (isUnitToken(t)) return false;
  return true;
}

/**
 * Try to parse a line as a result row. Returns { name, tail } or null.
 * Works on cells; falls back to splitting text when the line came through as a single cell.
 */
export function parseResultRow(line) {
  let cells = Array.isArray(line.cells) && line.cells.length ? line.cells : clean(line.text).split(/\s{2,}/);
  if (cells.length === 1) {
    // Single-cell fallback: split on single spaces; name = leading tokens up to the first value token.
    const toks = clean(cells[0]).split(' ');
    let i = 1;
    while (i < toks.length && !parseValue(toks[i]) && !(isTextValue(toks[i]) && i > 0)) i++;
    if (i >= toks.length || i === 0) return null;
    const name = toks.slice(0, i).join(' ');
    // Re-join range tokens "3.4 - 10.8" and keep the rest as separate cells.
    const rest = toks.slice(i).join(' ').replace(/(\d)\s*-\s*(\d)/g, '$1-$2').split(' ');
    cells = [name, ...rest];
  }
  const name = clean(cells[0]);
  if (!isNameLike(name)) return null;
  const tail = classifyTail(cells.slice(1), true);
  if (!tail.value) return null;
  return { name, tail };
}

/**
 * parseGeneric(doc) → ParseResult
 */
export function parseGeneric(doc) {
  const report = {
    source: { vendor: 'unknown', reportStatus: null },
    patient: {}, specimen: {}, provider: {},
    performingLabs: [], panels: [], results: [], comments: [],
  };
  const consumed = new Map();
  const notes = [];
  const fieldEvidence = {};
  const fieldStatus = {}; // path → 'uncertain' when pages disagree (read by buildAudit)
  const evidence = (path, id) => { (fieldEvidence[path] ||= []).push(id); };

  let rn = 0;
  let currentPanel = null;
  let lastResult = null;
  let lastResultX0 = 0;
  let pendingName = null; // wrapped name candidate (line id + text)
  const seenLabCodes = new Set();

  const allLines = [];
  for (const page of doc.pages || []) for (const line of page.lines || []) allLines.push(line);

  for (let li = 0; li < allLines.length; li++) {
    const line = allLines[li];
    const text = clean(line.text);
    const next = allLines[li + 1];
    if (!text) { consumed.set(line.id, 'blank'); continue; }

    const cells = line.cells && line.cells.length ? line.cells : text.split(/\s{2,}/);

    // Report status word may share a line with other cells ("Date Issued ...  FINAL REPORT  Page 1 of 2", "Quest Diagnostics  FINAL")
    if (report.source.reportStatus == null) {
      const sc = cells.find((c) => STATUS_RE.test(c));
      if (sc) {
        const st = sc.match(STATUS_RE);
        report.source.reportStatus = (st[1] || sc.split(/\s+/)[0]).toLowerCase();
        evidence('source.reportStatus', line.id);
      }
    }

    // Page numbers / status-only lines / table headers
    if (parsePageOf(text) && text.length < 40) { consumed.set(line.id, 'pageno'); lastResult = null; continue; }
    if (STATUS_RE.test(text)) { consumed.set(line.id, 'status'); continue; }
    if (TABLE_HEADER_RE.test(text)) { consumed.set(line.id, 'tableheader'); lastResult = null; pendingName = null; continue; }

    // Performing-lab legend: "01  BN  LabCorp Burlington  1447 York Court ..." or "EZ  Quest Diagnostics Nichols Institute, ..."
    if (cells.length >= 2 && PERFORMING_LAB_LEGEND_RE.test(cells[0]) && /lab|quest|dir\s*:|clia|director|phone/i.test(text)) {
      const code = cells[0].split(/\s+/)[0];
      if (!seenLabCodes.has(code)) {
        seenLabCodes.add(code);
        const rest = cells.slice(1).filter((c) => !/^[A-Z]{2}$/.test(c));
        const dir = text.match(/(?:Dir|Laboratory Director|Director)\s*:\s*([^,]+(?:,\s*(?:MD|DO|PhD|M\.D\.|Ph\.D\.))?)/i);
        const clia = text.match(/CLIA\s*[:#]?\s*([0-9A-Z]{10})/i);
        const phone = text.match(/Phone\s*:\s*([\d().\- ]{7,})/i);
        // Strip director / CLIA / phone fragments, then split "Name, address" at the first comma.
        const body = clean(rest.join('  ').replace(/\b(?:Dir|Laboratory Director|Director|CLIA|Phone)\s*:.*$/i, ''));
        let name = null, address = null;
        if (rest.length >= 2 && !/,/.test(rest[0])) { name = clean(rest[0]); address = clean(rest.slice(1).join(' ').replace(/\b(?:Dir|Laboratory Director|Director|CLIA|Phone)\s*:.*$/i, '')) || null; }
        else if (body) { const ci = body.indexOf(','); name = ci > 0 ? body.slice(0, ci).trim() : body; address = ci > 0 ? body.slice(ci + 1).trim() || null : null; }
        report.performingLabs.push({
          code,
          name: name || null,
          address: address || null,
          director: dir ? clean(dir[1]) : null,
          clia: clia ? clia[1] : null,
          phone: phone ? clean(phone[1]) : null,
        });
        evidence('performingLabs', line.id);
      }
      consumed.set(line.id, 'performinglab'); continue;
    }

    // Vendor wordmark / report title lines
    if (VENDOR_LINE_RE.test(text) && cells.length <= 2 && text.length < 60) { consumed.set(line.id, 'header:vendor'); continue; }

    // Header block cells without labels: "LAST, FIRST M" (patient name) and "DR. JANE SMITH" (ordering provider)
    let used = 0;
    {
      const nameCell = cells.find((c) => NAME_LINE_RE.test(c) && !/\d/.test(c));
      if (nameCell && report.patient.fullName == null && report.results.length === 0) {
        const n = splitName(nameCell);
        report.patient.fullName = n.fullName; report.patient.lastName = n.lastName; report.patient.firstName = n.firstName; report.patient.middleName = n.middleName;
        evidence('patient.fullName', line.id); used++;
      } else if (nameCell && report.patient.fullName != null && clean(nameCell) === report.patient.fullName) {
        evidence('patient.fullName', line.id); used++; // repeated page header
      }
      const drCell = cells.find((c) => DR_CELL_RE.test(c));
      if (drCell && report.provider.orderingName == null && report.results.length === 0) {
        report.provider.orderingName = clean(drCell); evidence('provider.orderingName', line.id); used++;
      } else if (drCell && clean(drCell) === report.provider.orderingName) {
        used++;
      }
    }

    // Header label:value pairs (may be several on one line)
    const pairs = findLabelPairs(typeof line.text === 'string' && line.text.trim() ? line.text.trim() : text);
    if (pairs.length || used) {
      for (const p of pairs) {
        const iv = interpretValue(p.field.kind, p.value, report);
        if (!iv) continue;
        used++;
        if (p.field.kind === 'name' && iv.name) {
          if (setField(report, 'patient.fullName', iv.name.fullName)) {
            report.patient.lastName = iv.name.lastName; report.patient.firstName = iv.name.firstName; report.patient.middleName = iv.name.middleName;
            evidence('patient.fullName', line.id);
          }
          continue;
        }
        if (p.field.kind === 'datetime' && p.field.path === 'specimen.collectedAt' && iv.tz) setField(report, 'specimen.collectedTz', iv.tz);
        if (setField(report, p.field.path, iv.value)) { evidence(p.field.path, line.id); continue; }
        // Repeated header on a later page: reconcile. Same value → more evidence; different → note + uncertain.
        const [sec, key] = p.field.path.split('.');
        const existing = report[sec][key];
        if (existing != null && String(existing) === String(iv.value)) evidence(p.field.path, line.id);
        else if (existing != null && !fieldStatus[p.field.path]) {
          fieldStatus[p.field.path] = 'uncertain';
          notes.push(`${p.field.path} differs between pages ("${existing}" vs "${iv.value}" at ${line.id}); kept the first.`);
        }
      }
      consumed.set(line.id, used && pairs.length ? `header:${pairs.map((p) => p.field.path).join(',')}` : 'header');
      lastResult = null; pendingName = null;
      continue;
    }

    // Boilerplate (vendor names, addresses, copyright, legal)
    if (isBoilerplate(text)) { consumed.set(line.id, 'boilerplate'); continue; }

    // Result row
    const row = parseResultRow(line);
    if (row) {
      rn++;
      const r = emptyResult(`r${rn}`);
      r.name = row.name;
      if (pendingName) { r.name = `${pendingName.text} ${r.name}`; r.lineIds.push(pendingName.id); consumed.set(pendingName.id, `result:${r.id}`); r.hints = { wrapped: true }; pendingName = null; }
      r.panel = currentPanel ? currentPanel.name : null;
      r.page = line.page;
      r.lineIds.push(line.id);
      r.valueText = row.tail.value.valueText;
      r.value = row.tail.value.value;
      r.valueQualifier = row.tail.value.qualifier;
      r.unit = row.tail.unit;
      r.flag = row.tail.flag;
      r.referenceRange = row.tail.range || { text: null, low: null, high: null, kind: null };
      r.performingLabCode = row.tail.lab;
      if (row.tail.leftovers.length) r.comment = row.tail.leftovers.join(' ');
      const numeric = r.value != null;
      r.fieldStatus = {
        value: 'found',
        unit: r.unit ? 'found' : numeric ? 'missing' : 'na',
        range: r.referenceRange.kind ? 'found' : numeric ? 'missing' : 'na',
        flag: r.flag ? 'found' : 'na',
      };
      report.results.push(r);
      if (currentPanel) currentPanel.resultIds.push(r.id);
      consumed.set(line.id, `result:${r.id}`);
      lastResult = r;
      lastResultX0 = line.x0 ?? 0;
      continue;
    }

    // Name-only line: panel heading, wrapped name, or comment
    const nextIsRow = next && next.page === line.page && !!parseResultRow(next);
    if (isNameLike(text) && !resultLike(line) && nextIsRow && cells.length === 1) {
      const nextRow = parseResultRow(next);
      const indentedBelow = (next.x0 ?? 0) > (line.x0 ?? 0) + 1;
      const sameName = nextRow && clean(nextRow.name).toLowerCase() === text.toLowerCase();
      const looksPanel = indentedBelow || sameName || PANEL_RE.test(text) || (text === text.toUpperCase() && text.length > 3) || !lastResult;
      if (looksPanel) {
        currentPanel = { name: text, resultIds: [], page: line.page };
        report.panels.push(currentPanel);
        consumed.set(line.id, 'panel');
        lastResult = null; pendingName = null;
      } else {
        pendingName = { id: line.id, text };
      }
      continue;
    }

    // Comment attached to the previous result (indented, or starting with a note keyword, or result-like leftovers)
    const indented = (line.x0 ?? 0) > lastResultX0 + 1;
    if (lastResult && line.page === lastResult.page && (COMMENT_START_RE.test(text) || LABELLED_NOTE_RE.test(text) || indented || !resultLike(line))) {
      lastResult.comment = lastResult.comment ? `${lastResult.comment} ${text}` : text;
      lastResult.lineIds.push(line.id);
      report.comments.push({ text, page: line.page, lineIds: [line.id], attachedTo: lastResult.id });
      consumed.set(line.id, 'comment');
      continue;
    }
    if (COMMENT_START_RE.test(text)) {
      report.comments.push({ text, page: line.page, lineIds: [line.id], attachedTo: null });
      consumed.set(line.id, 'comment');
      continue;
    }
    // Otherwise leave unconsumed for the audit.
  }

  if (pendingName) pendingName = null; // dangling wrapped name stays unconsumed
  if (!report.results.length) notes.push('Generic parser: no result rows were recognized.');
  notes.push('Generic parser used (vendor layout not recognized); header fields and rows are best-effort.');
  return { report, consumed, notes, fieldEvidence, fieldStatus };
}
