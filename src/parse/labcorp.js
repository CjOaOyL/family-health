// Labcorp patient-report parser. See docs/SPEC.md §4 and §6.
// Handles the classic layout ("Patient Details / Specimen Details / Physician Details",
// "TESTS RESULT FLAG UNITS REFERENCE INTERVAL LAB") and the newer portal label set
// ("Patient:", "Date of Birth:", "Specimen #:", "Test Name Result Flag Units Reference Interval Lab").
// Pure: no I/O, no network, isomorphic.

import { emptyReport, emptyResult } from '../model/schema.js';
import {
  parseUSDate, parseValue, parseRange, normalizeFlag, isUnitToken, splitName, normalizeSex,
  normalizeYesNo, parsePageOf, clean, parseAge, isTextValue,
} from './common.js';

export const LABCORP_PARSER_VERSION = '1.0.0';

const COL_TOL = 12;          // PDF units of slack when assigning a cell to a column
const INDENT = 3;            // x offset that counts as "indented" relative to the name column
const ACCOUNT_BLOCK_LINES = 6;

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

// ---------- boilerplate patterns ----------
const WORDMARK_RE = /^(?:Labcorp|LabCorp|LABCORP)(?:\s*®)?$/;
const TITLE_RE = /^(?:Patient\s+Report|Lab\s+Report|Patient\s+Results?|Laboratory\s+Report)$/i;
const STATUS_RE = /^(FINAL|PARTIAL|CORRECTED|PRELIMINARY|AMENDED)\s+REPORT$/i;
const SECTION_RE = /^(?:Patient|Specimen|Physician|Provider|Account|Client)\s+(?:Details|Information)$/i;
const NAME_LINE_RE = /^[A-Z][A-Z'`.\-]*(?:\s[A-Z][A-Z'`.\-]*)*,\s*[A-Z][A-Z'`.\-]*(?:\s[A-Z][A-Z'`.\-]*){0,3}$/;
const COPYRIGHT_RE = /Laboratory\s+Corporation\s+of\s+America|^\(?[cC©]\)?\s*\d{4}|All\s+Rights\s+Reserved/i;
const DISCLAIMER_RE = /private and confidential health information|Results are Flagged in Accordance|Enterprise Report Version|This document contains|for informational purposes|Report\s+Version\s*:|Age Dependent Reference Ranges/i;
const LEGEND_HEAD_RE = /^Performing\s+(?:Lab|Site|Laboratory|Laboratories)s?\s*:?$/i;
const LEGEND_RE = /^(\d{2})\s+(?:([A-Z]{2,3})\s+)?(.+)$/;
const LEGEND_NAME_RE = /^(?:LabCorp|Labcorp|Laboratory Corporation|Dynacare|Esoterix|Monogram|Bioreference|Integrated|Dianon|Litholink|Viromed)/i;
const COMMENT_START_RE = /^(?:please\s+note|note|comment|comments|ref|reference\s+(?:range|interval)|desirable|interpretation|disclaimer|see\s+note|see\s+comment|the\s|this\s|these\s|for\s|results?\s|patient\s|according|test\s+performed|performed\s+(?:by|at)|method|methodology|assay|\*)/i;
const FUNCTION_WORD_RE = /\b(?:the|is|are|for|of|to|and|with|range|should|may|from|than|was|were|note|please|if|this|that|when|been|has|have|using|used)\b/i;
const LAB_CODE_RE = /^(?:\d{2}|[A-Z]{2})$/;
const CELL_VALUE_LIKE_RE = /^[<>]?=?\s*[-+]?\d[\d,]*\.?\d*$/;
const NOTE_LABEL_RE = /^(?:please\s+note|note|comment|comments|ref|reference\s+range|interpretation|disclaimer)\s*:?\s*$/i;

const normName = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const parseFlagWord = (t) => (t == null ? null : normalizeFlag(t));
const isNoteLabelLine = (text) => NOTE_LABEL_RE.test(clean(text));

/** Short, label-free, sentence-free text that could be (part of) a test name. */
function isNameLike(text) {
  const t = clean(text);
  if (!t || t.length > 44) return false;
  if (!/^[A-Za-z0-9(\[]/.test(t)) return false;
  if (/[:;!?]$/.test(t)) return false;
  if (/\.$/.test(t) && !/\b(?:Estab|Calc|Abs|Tot|Ser|Pl|Ur|Qn|Ql|Dir|Immun|Bld|Bind|Cap|Sat|Avg|Glu|Hgb|Est|Conc)\.$/i.test(t)) return false;
  if (COMMENT_START_RE.test(t)) return false;
  if (FUNCTION_WORD_RE.test(t)) return false;
  if (CELL_VALUE_LIKE_RE.test(t)) return false;
  const pr = parseRange(t);
  if (pr.kind && pr.kind !== 'text') return false;
  return true;
}

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
  /** First non-null wins; a differing later value is a conflict → note + 'uncertain'. */
  const setField = (path, value, lineId) => {
    if (value == null || value === '') return;
    const cur = getPath(path);
    if (cur == null) setPathRaw(path, value);
    else if (String(cur) !== String(value)) {
      if (!uncertain.has(path)) notes.push(`conflict:${path}: "${cur}" vs "${value}" at ${lineId}`);
      uncertain.add(path);
    }
    addEvidence(path, lineId);
  };
  const setDateField = (path, raw, lineId, tzPath) => {
    if (!raw) return;
    const d = parseUSDate(raw);
    if (!d) { notes.push(`Could not parse date for ${path}: "${raw}" at ${lineId}`); return; }
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

    // ---- cell-level column assignment ----
    const colOf = (x) => {
      let key = cols[0].key;
      for (const c of cols) if (x >= c.x - COL_TOL) key = c.key;
      return key;
    };
    const byColumns = (line) => {
      const out = {};
      const cells = line.cells && line.cells.length ? line.cells : [line.text];
      const xs = line.cellX && line.cellX.length === cells.length ? line.cellX : cells.map(() => line.x0 || 0);
      for (let i = 0; i < cells.length; i++) {
        const k = colOf(xs[i]);
        out[k] = out[k] ? `${out[k]} ${cells[i]}` : cells[i];
      }
      return out;
    };

    /** Interpret a line as a result row (pure; returns null when not row-shaped). */
    const probeRow = (line) => {
      const cells = line.cells && line.cells.length ? line.cells : [line.text];
      const xs = line.cellX && line.cellX.length === cells.length ? line.cellX : null;
      let name = null, resultCell = null, flagCell = null, unitCell = null, refCell = null, labCell = null;
      let misaligned = false; const extra = [];
      if (cols) {
        const b = byColumns(line);
        name = b.name || null; resultCell = b.result || null; flagCell = b.flag || null;
        unitCell = b.units || null; refCell = b.ref || null; labCell = b.lab || null;
        // repairs for mildly misaligned columns
        if (!resultCell && flagCell && parseValue(flagCell) && !parseFlagWord(flagCell)) { resultCell = flagCell; flagCell = null; misaligned = true; }
        if (!resultCell && !flagCell && unitCell && parseValue(unitCell) && !isUnitToken(unitCell)) { resultCell = unitCell; unitCell = null; misaligned = true; }
        if (flagCell && !parseFlagWord(flagCell)) {
          if (!unitCell && isUnitToken(flagCell)) { unitCell = flagCell; flagCell = null; misaligned = true; }
          else if (!refCell && parseRange(flagCell).kind && parseRange(flagCell).kind !== 'text') { refCell = flagCell; flagCell = null; misaligned = true; }
          else { extra.push(flagCell); flagCell = null; }
        }
        if (unitCell && !isUnitToken(unitCell)) {
          if (parseFlagWord(unitCell) && !flagCell) { flagCell = unitCell; unitCell = null; misaligned = true; }
          else if (!refCell && (parseRange(unitCell).kind !== 'text' || isTextValue(unitCell))) { refCell = unitCell; unitCell = null; misaligned = true; }
        }
        if (labCell && !LAB_CODE_RE.test(labCell)) {
          const mm = labCell.match(/^(.*?)\s+(\d{2}|[A-Z]{2})$/);
          if (mm) { refCell = refCell ? `${refCell} ${mm[1]}` : mm[1]; labCell = mm[2]; }
          else { refCell = refCell ? `${refCell} ${labCell}` : labCell; labCell = null; }
        }
      } else {
        // shape-based fallback when no table header has been seen
        let start = 0;
        if (cells.length && !parseValue(cells[0]) && !CELL_VALUE_LIKE_RE.test(cells[0])) { name = cells[0]; start = 1; }
        for (let i = start; i < cells.length; i++) {
          const c = clean(cells[i]);
          const isLast = i === cells.length - 1;
          const farRight = xs ? xs[i] > pageWidth * 0.82 : false;
          if (isLast && farRight && LAB_CODE_RE.test(c)) { labCell = c; continue; }
          if (!resultCell && parseValue(c)) { resultCell = c; continue; }
          if (!resultCell && /^[<>]?=?\s*[-+]?\d[\d,]*\.?\d*\s+\S+$/.test(c) && isUnitToken(c.split(/\s+/).pop())) { resultCell = c; continue; }
          if (!flagCell && resultCell && /^(?:H|L|HH|LL|A|C|HIGH|LOW|CRITICAL|ABNORMAL|ALERT|\*+)\*?$/i.test(c)) { flagCell = c; continue; }
          if (!unitCell && isUnitToken(c)) { unitCell = c; continue; }
          const pr = parseRange(c);
          if (!refCell && resultCell && ((pr.kind && pr.kind !== 'text') || isTextValue(c))) { refCell = c; continue; }
          if (!labCell && isLast && LAB_CODE_RE.test(c)) { labCell = c; continue; }
          if (!resultCell && isTextValue(c)) { resultCell = c; continue; }
          extra.push(c);
        }
        if (!name && !resultCell) return null;
      }
      if (name && (/:\s*$/.test(name) || isNoteLabelLine(name))) return null;
      if (!resultCell) return null;
      // value
      let pv = parseValue(resultCell); let inlineUnit = null;
      if (!pv) {
        const mm = resultCell.match(/^(\S+)\s+(.+)$/);
        if (mm && parseValue(mm[1]) && isUnitToken(mm[2])) { pv = parseValue(mm[1]); inlineUnit = mm[2]; }
      }
      if (!pv) {
        const words = resultCell.split(/\s+/);
        const other = flagCell || unitCell || refCell || labCell;
        if (words.length <= 3 && other && !/[:]/.test(resultCell) && /^[A-Za-z<>0-9]/.test(resultCell)) {
          pv = { valueText: resultCell, value: null, qualifier: null, isText: true };
        } else return null;
      }
      if (!name && !cols && !pendingName) return null;
      return { name, valueText: pv.valueText, value: pv.value, qualifier: pv.qualifier, isText: pv.isText,
        unit: unitCell || inlineUnit || null, flagRaw: flagCell, refRaw: refCell, lab: labCell, misaligned, extra };
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
          notes.push(`conflict:performingLabs.${lab.code}: "${cur.name}" vs "${lab.name}" at ${lineId}`); uncertain.add('performingLabs');
        }
        for (const k of ['name', 'address', 'director', 'clia', 'phone']) if (cur[k] == null && lab[k] != null) cur[k] = lab[k];
        lastLegend = cur;
      }
      addEvidence('performingLabs', lineId);
    };
    const footerCellTag = (cell, lineId) => {
      const t = clean(cell);
      if (!t) return 'blank';
      const po = parsePageOf(t);
      if (po) {
        if (declaredPages == null) declaredPages = po.of;
        else if (declaredPages !== po.of) notes.push(`conflict:pages: declared ${declaredPages} vs ${po.of} at ${lineId}`);
        if (po.page !== page.pageNumber) notes.push(`Page label "${t}" on physical page ${page.pageNumber} (${lineId})`);
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
      switch (p.key) {
        case 'dob': setDateField('patient.dob', v, id); break;
        case 'age': { const a = parseAge(v); if (a != null) setField('patient.ageAtCollection', a, id); break; }
        case 'sex': { const s = normalizeSex(v); if (s) setField('patient.sex', s, id); else if (v) notes.push(`Unrecognized sex "${v}" at ${id}`); break; }
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
      if (NAME_LINE_RE.test(t) && (!report.patient.fullName || normName(t) === normName(report.patient.fullName))) {
        applyName(t, line.id); return 'header:patient.name';
      }
      // account name/address continuation (same column, directly under "Account Number:")
      if (accountX != null && accountLeft > 0 && Math.abs(cx - accountX) <= COL_TOL + 4 && !CELL_VALUE_LIKE_RE.test(t)) {
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
      r.flag = row.flagRaw ? parseFlagWord(row.flagRaw) : null;
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
      r.fieldStatus.flag = row.flagRaw ? (r.flag ? 'found' : 'uncertain') : 'na';
      // preliminary confidence per SPEC §5 (audit may rescore)
      let conf = 1;
      if (numeric && !r.unit) conf -= 0.25;
      if (numeric && r.fieldStatus.range === 'missing') conf -= 0.25;
      if (!row.valueText) conf -= 0.4;
      if (wrapped) conf -= 0.1;
      if (row.misaligned) conf -= 0.1;
      if (row.flagRaw && !r.flag) { conf -= 0.1; notes.push(`Unrecognized flag "${row.flagRaw}" on ${r.id} (${line.id})`); }
      r.confidence = Math.max(0, Math.min(1, Math.round(conf * 100) / 100));
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
      if (cells.length > 1 && LAB_CODE_RE.test(clean(cells[cells.length - 1])) && (!cols || colOf(line.cellX[cells.length - 1]) === 'lab')) cells.pop();
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

    // ================= line loop =================
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      const text = clean(line.text);
      const cells = line.cells && line.cells.length ? line.cells : [line.text];
      const cellX = line.cellX && line.cellX.length === cells.length ? line.cellX : cells.map(() => line.x0 || 0);
      const next = lines[li + 1] || null;
      if (accountLeft > 0) accountLeft--;

      if (!text) { consume(line, 'blank'); continue; }

      // ---- footer: performing-lab legend ----
      const lm = text.match(LEGEND_RE);
      if (lm && (lm[2] || LEGEND_NAME_RE.test(lm[3]))) {
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
          if (real.some((t) => t === 'pageno' || t === 'footer:dateIssued' || t === 'footer:labs' || t === 'footer:copyright')) {
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

      // ---- table header ----
      if (cells.length >= 3) {
        const map = []; let ok = true;
        for (let i = 0; i < cells.length; i++) {
          const c = clean(cells[i]).toLowerCase();
          let key = null;
          if (/^(?:tests?|test name)$/.test(c)) key = 'name';
          else if (/^results?$/.test(c)) key = 'result';
          else if (/^flags?$/.test(c)) key = 'flag';
          else if (/^units?$/.test(c)) key = 'units';
          else if (/^(?:reference|ref\.?)\s*(?:interval|range)$/.test(c) || c === 'reference') key = 'ref';
          else if (/^lab$/.test(c)) key = 'lab';
          else { ok = false; break; }
          map.push({ key, x: cellX[i] });
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

      // ---- header block (labels, name, sections) — only above the table on this page ----
      if (!inTable && !inFooter) {
        const tags = cells.map((c, i) => headerCell(c, cellX[i], line));
        if (tags.some((t) => t)) {
          const real = tags.filter((t) => t && t !== 'blank');
          const isAccount = real.includes('header:account') || real.includes('header:provider.account');
          if (!real.includes('header:orderedItems') && !isAccount) { flushOrdered(); }
          if (!isAccount) finishAccountAddress();
          if (tags.every((t) => t)) {
            consume(line, real.length > 1 && new Set(real).size > 1 ? 'header' : (real[0] || 'blank'));
          } else {
            const stray = cells.filter((c, i) => !tags[i]).map(clean).join(' | ');
            consume(line, 'header');
            notes.push(`Unrecognized header fragment "${stray}" at ${line.id}`);
          }
          prevKind = 'other';
          continue;
        }
      }

      // ---- panel line that matches an ordered item ----
      if (orderedOpen && !splitLabels(text).parts.length) flushOrdered();   // this line is not an "Ordered Items" continuation
      if (cells.length <= 2 && orderedItems.includes(normName(cells[0])) && !probeRow(line)) {
        startPanel(cells[0], line);
        continue;
      }

      // ---- result rows ----
      const row = probeRow(line);
      if (row && (inTable || row.name)) {
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
        continue;
      }

      if (!inTable) continue;   // above the table and not recognized → stays unconsumed for the audit

      // ---- single-cell lines inside the table: panel / wrapped name / comment ----
      const isSingle = cells.length === 1 || (cells.length === 2 && LAB_CODE_RE.test(clean(cells[1])) && (!cols || colOf(cellX[1]) === 'lab'));
      const x0 = line.x0 ?? cellX[0];
      const flushLeft = x0 <= nameX() + INDENT;
      const nextRow = next ? probeRow(next) : null;
      const nameLike = isSingle && isNameLike(cells[0]);
      const prevLine = lines[li - 1];
      const prevWasRow = prevKind === 'row' && !!lastResult && !!prevLine && lastResult.lineIds.includes(prevLine.id);

      if (nameLike) {
        const t = cells[0];
        if (nextRow && !nextRow.name) { holdName(line, t, x0); continue; }                       // "Name" / "<value row without name>"
        if (nextRow && /^[(a-z]/.test(nextRow.name)) { holdName(line, t, x0); continue; }        // "Estim. Avg Glu" / "(eAG)  123 ..."
        if (flushLeft && nextRow) { startPanel(t, line); continue; }                             // un-ordered panel heading
        if (prevWasRow && (/[,\/\-]$/.test(lastResult.name) || !nextRow)) { wrapBelow(line, t); continue; }
        if (nextRow) { holdName(line, t, x0); continue; }
        if (prevWasRow) { wrapBelow(line, t); continue; }
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
