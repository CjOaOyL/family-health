// Pure helpers over LabReport records: overrides, member matching, flattening for Results/Compare.
import { getPath } from '../src/model/schema.js';

export const SETTING_KEEP_FILES = 'keepFiles';

export function clone(obj) {
  if (typeof structuredClone === 'function') return structuredClone(obj);
  return JSON.parse(JSON.stringify(obj));
}

/**
 * Set a dotted path on an object. Array segments may be numeric indexes or an element id
 * (e.g. 'results.r12.valueText' finds the result whose id === 'r12').
 */
export function setPath(obj, path, value) {
  const parts = path.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    let next;
    if (Array.isArray(cur)) next = /^\d+$/.test(k) ? cur[+k] : cur.find((x) => x && x.id === k);
    else next = cur[k];
    if (next == null || typeof next !== 'object') {
      if (Array.isArray(cur)) return false;
      next = cur[k] = {};
    }
    cur = next;
  }
  const last = parts[parts.length - 1];
  if (Array.isArray(cur)) {
    if (/^\d+$/.test(last)) cur[+last] = value; else return false;
  } else cur[last] = value;
  return true;
}

export function getPathAny(obj, path) {
  const parts = path.split('.');
  let cur = obj;
  for (const k of parts) {
    if (cur == null) return undefined;
    if (Array.isArray(cur)) cur = /^\d+$/.test(k) ? cur[+k] : cur.find((x) => x && x.id === k);
    else cur = cur[k];
  }
  return cur;
}

const NUM_RE = /^([<>]=?)?\s*([-+]?\d{1,3}(?:,\d{3})+(?:\.\d+)?|[-+]?\d*\.?\d+)\s*$/;
export function parseNumeric(text) {
  if (text == null) return { value: null, qualifier: null };
  const m = String(text).trim().match(NUM_RE);
  if (!m) return { value: null, qualifier: null };
  const v = parseFloat(m[2].replace(/,/g, ''));
  return { value: isFinite(v) ? v : null, qualifier: m[1] || null };
}

/** Coerce an edited text value into the type the field expects. */
export function coerceOverride(path, text) {
  const t = text == null ? '' : String(text).trim();
  if (t === '') return null;
  const last = path.split('.').pop();
  if (last === 'fasting') return /^(y|yes|true|1)$/i.test(t) ? true : /^(n|no|false|0)$/i.test(t) ? false : null;
  if (last === 'ageAtCollection' || last === 'low' || last === 'high' || last === 'value' || last === 'pageCount') {
    const n = parseFloat(t.replace(/,/g, '')); return isFinite(n) ? n : null;
  }
  if (last === 'flag') { const f = t.toUpperCase(); return ['H', 'L', 'HH', 'LL', 'A', 'C'].includes(f) ? f : null; }
  if (last === 'sex') { const s = t[0].toUpperCase(); return s === 'M' || s === 'F' ? s : 'U'; }
  if (/At$|^dob$/.test(last)) {
    // Accept MM/DD/YYYY [HH:mm] or ISO and normalise to ISO wall time.
    let m = t.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})(?:[ T,]+(\d{1,2}):?(\d{2}))?/);
    if (m) {
      const iso = `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
      return m[4] ? `${iso}T${m[4].padStart(2, '0')}:${m[5]}` : iso;
    }
    m = t.match(/^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}))?/);
    if (m) return m[2] ? `${m[1]}T${m[2]}` : m[1];
    return t;
  }
  return t;
}

/** Deep-clone the stored report and apply overrides. Result rows get value/qualifier recomputed. */
export function effectiveReport(rec) {
  const base = rec && rec.report ? rec.report : null;
  if (!base) return null;
  const r = clone(base);
  const ov = (rec && rec.overrides) || {};
  for (const [path, value] of Object.entries(ov)) {
    setPath(r, path, value);
    const m = path.match(/^results\.([^.]+)\.valueText$/);
    if (m) {
      const res = r.results.find((x) => x.id === m[1]);
      if (res) {
        const { value: v, qualifier } = parseNumeric(value);
        const orig = base.results.find((x) => x.id === m[1]);
        res.value = v; res.valueQualifier = qualifier;
        // Keep the original unit-conversion factor when one was applied, else canonicalValue mirrors value.
        const factor = orig && orig.value && orig.canonicalValue != null ? orig.canonicalValue / orig.value : 1;
        res.canonicalValue = v == null ? null : +(v * (isFinite(factor) && factor > 0 ? factor : 1)).toPrecision(12);
      }
    }
    const rr = path.match(/^results\.([^.]+)\.referenceRange\.text$/);
    if (rr) {
      const res = r.results.find((x) => x.id === rr[1]);
      if (res) Object.assign(res.referenceRange, parseRangeText(value));
    }
  }
  if (rec.memberId !== undefined && r.patient) r.patient.memberId = rec.memberId;
  return r;
}

export function parseRangeText(text) {
  const t = text == null ? '' : String(text).trim();
  if (!t) return { low: null, high: null, kind: null };
  let m = t.match(/^([-+]?\d[\d,]*\.?\d*)\s*[-–]\s*([-+]?\d[\d,]*\.?\d*)/);
  if (m) return { low: +m[1].replace(/,/g, ''), high: +m[2].replace(/,/g, ''), kind: 'range' };
  m = t.match(/^(<=|>=|<|>|≤|≥)\s*([-+]?\d[\d,]*\.?\d*)/);
  if (m) {
    const n = +m[2].replace(/,/g, '');
    const op = m[1];
    if (op === '<') return { low: null, high: n, kind: 'lt' };
    if (op === '<=' || op === '≤') return { low: null, high: n, kind: 'le' };
    if (op === '>') return { low: n, high: null, kind: 'gt' };
    return { low: n, high: null, kind: 'ge' };
  }
  return { low: null, high: null, kind: 'text' };
}

// ---------- member matching ----------

export function nameTokens(name) {
  return String(name || '').toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(Boolean);
}
export function nameKey(name) { return nameTokens(name).sort().join(' '); }

/** "LAST, FIRST M" / "First Last" → a display name "First Last". */
export function displayNameFromReport(report) {
  const p = report?.patient || {};
  const cap = (s) => String(s || '').toLowerCase().replace(/(^|[\s'-])([a-z])/g, (m, a, b) => a + b.toUpperCase());
  if (p.firstName && p.lastName) return `${cap(p.firstName)} ${cap(p.lastName)}`.trim();
  if (p.fullName) {
    const m = String(p.fullName).match(/^\s*([^,]+),\s*(.+)$/);
    if (m) return `${cap(m[2].split(/\s+/)[0])} ${cap(m[1])}`;
    return cap(p.fullName);
  }
  return '';
}

/** Find the best existing member for a report (name case-insensitive + dob). Returns member or null. */
export function matchMember(report, members) {
  const p = report?.patient || {};
  const dob = p.dob || null;
  const keyFull = nameKey(p.fullName);
  const keyFl = nameKey(`${p.firstName || ''} ${p.lastName || ''}`);
  const tokens = new Set(nameTokens(p.fullName).concat(nameTokens(`${p.firstName || ''} ${p.lastName || ''}`)));
  let best = null; let bestScore = 0;
  for (const m of members || []) {
    const mk = nameKey(m.name);
    let score = 0;
    if (mk && (mk === keyFull || mk === keyFl)) score = 3;
    else {
      const mt = nameTokens(m.name);
      const shared = mt.filter((t) => tokens.has(t)).length;
      if (mt.length && shared >= Math.min(2, mt.length)) score = 2;
      else if (shared >= 1) score = 1;
    }
    if (dob && m.dob && dob === m.dob) score += 2; else if (dob && m.dob && dob !== m.dob) score = Math.max(0, score - 3);
    if (score > bestScore) { bestScore = score; best = m; }
  }
  // Require a confident match: same dob + at least a partial name, or exact name with no conflicting dob.
  return bestScore >= 3 ? best : null;
}

// ---------- flattening ----------

export function normName(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9%]+/g, ' ').trim();
}

/** 'cholesterol_total' → 'Cholesterol total' (fallback when the analyte dictionary is unavailable). */
export function humanizeId(id) {
  if (!id) return '';
  const s = String(id).replace(/[_-]+/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Stable key for grouping results across reports/vendors. */
export function analyteKey(result) {
  if (result.canonicalId) return `id:${result.canonicalId}`;
  return `name:${normName(result.name)}`;
}

export function rangeText(rr) {
  if (!rr) return '';
  if (rr.text) return rr.text;
  if (rr.low != null && rr.high != null) return `${rr.low}–${rr.high}`;
  if (rr.kind === 'lt' && rr.high != null) return `<${rr.high}`;
  if (rr.kind === 'le' && rr.high != null) return `≤${rr.high}`;
  if (rr.kind === 'gt' && rr.low != null) return `>${rr.low}`;
  if (rr.kind === 'ge' && rr.low != null) return `≥${rr.low}`;
  return '';
}

/**
 * Flatten report records into result rows for tables and charts.
 * names: Map canonicalId → { display } (from ANALYTES); falls back to printed name.
 */
export function flattenResults(records, names) {
  const rows = [];
  for (const rec of records) {
    const rep = effectiveReport(rec);
    if (!rep) continue;
    const date = rep.specimen?.collectedAt || rep.specimen?.reportedAt || null;
    const vendor = rep.source?.vendor || 'unknown';
    for (const r of rep.results || []) {
      const info = r.canonicalId && names ? names.get(r.canonicalId) : null;
      rows.push({
        reportId: rec.id,
        memberId: rec.memberId ?? null,
        date,
        vendor,
        panel: r.panel || null,
        resultId: r.id,
        name: r.name,
        canonicalId: r.canonicalId || null,
        display: info?.display || humanizeId(r.canonicalId) || r.name,
        key: analyteKey(r),
        valueText: r.valueText,
        value: r.value,
        qualifier: r.valueQualifier || null,
        unit: r.unit,
        canonicalUnit: r.canonicalUnit || null,
        canonicalValue: r.canonicalValue,
        flag: r.flag,
        range: r.referenceRange || { text: null, low: null, high: null, kind: null },
        rangeText: rangeText(r.referenceRange),
        confidence: r.confidence,
      });
    }
  }
  return rows;
}

/** Distinct analytes present in rows: [{ key, display }] sorted by display. */
export function analyteOptions(rows) {
  const m = new Map();
  for (const r of rows) if (!m.has(r.key)) m.set(r.key, { key: r.key, display: r.display, count: 0 });
  for (const r of rows) m.get(r.key).count++;
  return Array.from(m.values()).sort((a, b) => a.display.localeCompare(b.display));
}

export function reportLabel(rec, members) {
  const rep = rec.report || {};
  const date = rep.specimen?.collectedAt || rep.specimen?.reportedAt || null;
  const vendor = rep.source?.vendor || 'unknown';
  const member = members ? members.find((m) => m.id === rec.memberId) : null;
  return { date, vendor, memberName: member ? member.name : null, fileName: rep.source?.fileName || rec.id, count: (rep.results || []).length };
}

export { getPath };
