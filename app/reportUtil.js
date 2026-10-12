// Pure helpers over LabReport records: overrides, member matching, flattening for Results/Compare.
import { getPath } from '../src/model/schema.js';

export const SETTING_KEEP_FILES = 'keepFiles';

export function clone(obj) {
  if (typeof structuredClone === 'function') return structuredClone(obj);
  return JSON.parse(JSON.stringify(obj));
}

// ---------- analyte dictionary (injected; app/pipeline.js loads src/model/analytes.js lazily) ----------

let analytesMod = null;
/** Give reportUtil the analytes module so edits can recompute canonicalId/canonicalUnit/canonicalValue. */
export function useAnalytes(mod) { analytesMod = mod && typeof mod.normalizeAnalyte === 'function' ? mod : null; }
export function hasAnalytes() { return !!analytesMod; }

/** True when extraction produced pages but not a single text line (scanned image, no text layer). */
export function docHasNoText(doc) {
  if (!doc || !Array.isArray(doc.pages)) return false;
  return doc.pages.every((p) => !Array.isArray(p.lines) || p.lines.length === 0);
}

/** True when a parsed report has nothing to work with: no text lines were extracted. */
export function reportHasNoText(report, doc) {
  if (doc) return docHasNoText(doc);
  const cov = report?.audit?.coverage;
  return !!cov && cov.totalLines === 0;
}

// ---------- stable result keys ----------

/** 'Cholesterol, Total' → 'cholesteroltotal' (lowercase, punctuation and spaces stripped). */
export function normalizeResultName(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * Stable identity for a result across re-parses: first source line id + normalized printed name.
 * Result ids (r1, r2, …) are sequential document order and shift when the parser changes, so overrides
 * must never be keyed by them.
 */
export function resultKey(result) {
  if (!result) return '';
  const first = Array.isArray(result.lineIds) && result.lineIds.length ? String(result.lineIds[0]) : '';
  return `${first}|${normalizeResultName(result.name)}`;
}

export function resultPath(result, field) { return `results[${resultKey(result)}].${field}`; }

const RESULT_PATH_RE = /^results\[([^\]]*)\]\.(.+)$/;
const LEGACY_RESULT_PATH_RE = /^results\.([^.\[\]]+)\.(.+)$/;

/** Split 'results[p1l5|wbc].referenceRange.text' into segments; a bracketed segment becomes { key }. */
function splitPath(path) {
  const out = [];
  const re = /\[([^\]]*)\]|([^.\[\]]+)/g;
  let m;
  while ((m = re.exec(path))) out.push(m[1] != null ? { key: m[1] } : m[2]);
  return out;
}

function step(cur, seg) {
  if (cur == null) return undefined;
  if (typeof seg === 'object') {
    if (!Array.isArray(cur)) return undefined;
    return findResultByKey(cur, seg.key);
  }
  if (Array.isArray(cur)) return /^\d+$/.test(seg) ? cur[+seg] : cur.find((x) => x && x.id === seg);
  return cur[seg];
}

/**
 * Find the result a stable key refers to. Exact key first; if the first line id moved (e.g. a wrapped
 * name now starts one line earlier) fall back to the normalized name when it is unique in the report.
 */
export function findResultByKey(results, key) {
  if (!Array.isArray(results) || !key) return undefined;
  let hit = results.find((r) => resultKey(r) === key);
  if (hit) return hit;
  const name = key.split('|').slice(1).join('|');
  if (!name) return undefined;
  const byName = results.filter((r) => normalizeResultName(r.name) === name);
  return byName.length === 1 ? byName[0] : undefined;
}

/**
 * Set a dotted path on an object. Array segments may be numeric indexes, an element id
 * (e.g. 'panels.p1.name' finds the panel whose id === 'p1'), or a bracketed stable result key
 * ('results[p1l5|wbc].valueText'). Returns false when the target cannot be resolved.
 */
export function setPath(obj, path, value) {
  const parts = splitPath(path);
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    let next = step(cur, k);
    if (next == null || typeof next !== 'object') {
      if (Array.isArray(cur) || typeof k === 'object') return false;
      next = cur[k] = {};
    }
    cur = next;
  }
  const last = parts[parts.length - 1];
  if (typeof last === 'object') return false;
  if (Array.isArray(cur)) {
    if (/^\d+$/.test(last)) cur[+last] = value; else return false;
  } else cur[last] = value;
  return true;
}

export function getPathAny(obj, path) {
  let cur = obj;
  for (const k of splitPath(path)) {
    cur = step(cur, k);
    if (cur === undefined) return undefined;
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

export const FLAG_VALUES = ['H', 'L', 'HH', 'LL', 'A', 'C'];

/**
 * Validate and coerce an edited text value into the type the field expects.
 * Returns { ok: true, value } or { ok: false, error }. Blank always clears the field (value null).
 */
export function validateOverride(path, text) {
  const t = text == null ? '' : String(text).trim();
  if (t === '') return { ok: true, value: null };
  const last = path.split('.').pop();
  if (last === 'fasting') {
    if (/^(y|yes|true|1)$/i.test(t)) return { ok: true, value: true };
    if (/^(n|no|false|0)$/i.test(t)) return { ok: true, value: false };
    return { ok: false, error: 'Fasting must be yes or no' };
  }
  if (last === 'ageAtCollection' || last === 'low' || last === 'high' || last === 'value' || last === 'pageCount') {
    const n = parseFloat(t.replace(/,/g, ''));
    if (!isFinite(n) || !/^[-+]?[\d,]*\.?\d+$/.test(t)) return { ok: false, error: `${last === 'ageAtCollection' ? 'Age' : 'This field'} must be a number` };
    return { ok: true, value: n };
  }
  if (last === 'flag') {
    const f = t.toUpperCase();
    if (!FLAG_VALUES.includes(f)) return { ok: false, error: 'Flag must be H, L, HH, LL, A, C or blank' };
    return { ok: true, value: f };
  }
  if (last === 'sex') {
    const s = t[0].toUpperCase();
    if (s === 'M' || s === 'F' || s === 'U') return { ok: true, value: s };
    return { ok: false, error: 'Sex must be M, F or U' };
  }
  if (/At$|^dob$/.test(last)) {
    // Accept MM/DD/YYYY [HH:mm] or ISO and normalise to ISO wall time. The calendar date must be real.
    const bad = { ok: false, error: 'Enter a real date as MM/DD/YYYY or YYYY-MM-DD (optionally with HH:mm)' };
    const build = (y, mo, d, hh, mm) => {
      const Y = +y, M = +mo, D = +d;
      const dt = new Date(Y, M - 1, D);
      if (!(M >= 1 && M <= 12 && D >= 1 && D <= 31) || dt.getFullYear() !== Y || dt.getMonth() !== M - 1 || dt.getDate() !== D) return bad;
      if (hh != null && !(+hh >= 0 && +hh <= 23 && +mm >= 0 && +mm <= 59)) return bad;
      const iso = `${String(Y).padStart(4, '0')}-${String(M).padStart(2, '0')}-${String(D).padStart(2, '0')}`;
      return { ok: true, value: hh != null ? `${iso}T${String(hh).padStart(2, '0')}:${mm}` : iso };
    };
    let m = t.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})(?:[ T,]+(\d{1,2}):?(\d{2}))?$/);
    if (m) return build(m[3], m[1], m[2], m[4] ?? null, m[5] ?? null);
    m = t.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?$/);
    if (m) return build(m[1], m[2], m[3], m[4] ?? null, m[5] ?? null);
    return bad;
  }
  return { ok: true, value: t };
}

/** Coerce an edited text value; invalid input becomes null. Prefer validateOverride in the UI. */
export function coerceOverride(path, text) {
  const v = validateOverride(path, text);
  return v.ok ? v.value : null;
}

// ---------- overrides: migration + resolution ----------

/**
 * Rewrite legacy 'results.rN.field' override paths to stable 'results[<key>].field' paths, matching by
 * the result id in the report the overrides were made against. Mutates rec.overrides in place and
 * returns it. Paths whose id no longer exists are left untouched (they will show as orphaned).
 */
export function migrateOverrides(rec, report = rec && rec.report) {
  const ov = rec && rec.overrides;
  if (!ov || typeof ov !== 'object') return ov || {};
  const results = (report && report.results) || [];
  for (const path of Object.keys(ov)) {
    const m = path.match(LEGACY_RESULT_PATH_RE);
    if (!m) continue;
    const res = /^\d+$/.test(m[1]) ? results[+m[1]] : results.find((r) => r && r.id === m[1]);
    if (!res) continue;
    const next = `results[${resultKey(res)}].${m[2]}`;
    if (!(next in ov)) ov[next] = ov[path];
    delete ov[path];
  }
  return ov;
}

/**
 * Resolve every override against the current report.
 * Returns { applied: [{ path, resolvedId, field, value }], orphaned: [{ path, key, name, field, value }] }.
 * Orphans are result overrides whose stable key no longer matches any result after a re-parse.
 */
export function resolveOverrides(rec, report = rec && rec.report) {
  const out = { applied: [], orphaned: [] };
  if (!rec || !rec.overrides) return out;
  migrateOverrides(rec, report);
  const results = (report && report.results) || [];
  for (const [path, value] of Object.entries(rec.overrides)) {
    const legacy = path.match(LEGACY_RESULT_PATH_RE);
    if (legacy) {
      // A legacy id-keyed path that could not be migrated (its id is gone): never apply it by id.
      out.orphaned.push({ path, key: legacy[1], name: legacy[1], field: legacy[2], value, legacy: true });
      continue;
    }
    const m = path.match(RESULT_PATH_RE);
    if (!m) { out.applied.push({ path, field: path, value }); continue; }
    const res = findResultByKey(results, m[1]);
    if (res) out.applied.push({ path, resolvedId: res.id, field: m[2], value });
    else out.orphaned.push({ path, key: m[1], name: humanizeKeyName(m[1]), field: m[2], value, legacy: false });
  }
  return out;
}

function humanizeKeyName(key) {
  const name = String(key).split('|').slice(1).join('|');
  return name || key;
}

/** Recompute canonicalId/loinc/canonicalUnit/canonicalValue for a result after its name/unit/value changed. */
export function recanonicalize(res, orig, { identityChanged = false } = {}) {
  if (!res) return;
  const m = analytesMod;
  if (m && identityChanged) {
    let a = null;
    try { a = m.normalizeAnalyte(res.name, res.unit || undefined); } catch { a = null; }
    res.canonicalId = a ? a.id ?? null : null;
    res.loinc = a ? a.loinc ?? null : null;
    res.canonicalUnit = a ? a.canonicalUnit ?? null : null;
  }
  if (typeof res.value !== 'number' || !isFinite(res.value)) { res.canonicalValue = null; return; }
  let cv = res.value;
  if (m && res.unit && res.canonicalUnit) {
    try {
      const from = m.normalizeUnit(res.unit), to = m.normalizeUnit(res.canonicalUnit);
      if (from && to && from !== to) {
        const conv = m.convertUnit(res.value, res.unit, res.canonicalUnit, res.canonicalId);
        if (typeof conv === 'number' && isFinite(conv)) cv = conv;
        else cv = null; // unit changed to something the dictionary cannot convert: do not pretend
      }
    } catch { /* keep cv */ }
  } else if (!m && orig && typeof orig.value === 'number' && orig.value !== 0 && orig.canonicalValue != null) {
    // Dictionary unavailable: keep the original conversion factor.
    const factor = orig.canonicalValue / orig.value;
    cv = isFinite(factor) && factor > 0 ? +(res.value * factor).toPrecision(12) : res.value;
  }
  res.canonicalValue = cv;
}

/** Deep-clone the stored report and apply overrides. Result rows get value/qualifier/canonical fields recomputed. */
export function effectiveReport(rec) {
  const base = rec && rec.report ? rec.report : null;
  if (!base) return null;
  const r = clone(base);
  const { applied } = resolveOverrides(rec, base);
  const touched = new Map(); // resolvedId → { identity: bool }
  for (const a of applied) {
    if (a.resolvedId == null) { setPath(r, a.path, a.value); continue; }
    const res = r.results.find((x) => x.id === a.resolvedId);
    if (!res) continue;
    setPath(res, a.field, a.value);
    const t = touched.get(a.resolvedId) || { identity: false, value: false, range: false };
    if (a.field === 'name' || a.field === 'unit') t.identity = true;
    if (a.field === 'valueText') t.value = true;
    if (a.field === 'referenceRange.text') t.range = true;
    touched.set(a.resolvedId, t);
  }
  for (const [id, t] of touched) {
    const res = r.results.find((x) => x.id === id);
    const orig = base.results.find((x) => x.id === id);
    if (!res) continue;
    if (t.value) {
      const { value: v, qualifier } = parseNumeric(res.valueText);
      res.value = v; res.valueQualifier = qualifier;
    }
    if (t.range) Object.assign(res.referenceRange, parseRangeText(res.referenceRange.text));
    if (t.value || t.identity) recanonicalize(res, orig, { identityChanged: t.identity });
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

/** First-name token of a report patient ("LAST, FIRST M" → "first"; explicit firstName wins). */
export function reportFirstToken(p) {
  if (!p) return '';
  if (p.firstName) return nameTokens(p.firstName)[0] || '';
  const full = String(p.fullName || '');
  const m = full.match(/^\s*([^,]+),\s*(.+)$/);
  if (m) return nameTokens(m[2])[0] || '';
  return nameTokens(full)[0] || '';
}

/** First-name token of a member ("First Last" → "first"; "Last, First" also accepted). */
export function memberFirstToken(name) {
  const s = String(name || '');
  const m = s.match(/^\s*([^,]+),\s*(.+)$/);
  if (m) return nameTokens(m[2])[0] || '';
  return nameTokens(s)[0] || '';
}

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

/** Members whose DOB equals the report's DOB (siblings/twins share one). */
export function membersSharingDob(report, members) {
  const dob = report?.patient?.dob || null;
  if (!dob) return [];
  return (members || []).filter((m) => m.dob && m.dob === dob);
}

/**
 * Find the best existing member for a report (name case-insensitive + dob). Returns member or null.
 * When several members share the report's DOB (twins, siblings entered with the same birthday), a
 * shared surname is not enough: the first-name token must match too, or the whole normalized name.
 */
export function matchMember(report, members) {
  const p = report?.patient || {};
  const dob = p.dob || null;
  const keyFull = nameKey(p.fullName);
  const keyFl = nameKey(`${p.firstName || ''} ${p.lastName || ''}`);
  const tokens = new Set(nameTokens(p.fullName).concat(nameTokens(`${p.firstName || ''} ${p.lastName || ''}`)));
  const sameDob = membersSharingDob(report, members);
  const ambiguousDob = sameDob.length > 1;
  const first = reportFirstToken(p);
  let best = null; let bestScore = 0;
  for (const m of members || []) {
    const mk = nameKey(m.name);
    const exact = !!mk && (mk === keyFull || mk === keyFl);
    let score = 0;
    if (exact) score = 3;
    else {
      const mt = nameTokens(m.name);
      const shared = mt.filter((t) => tokens.has(t)).length;
      if (mt.length && shared >= Math.min(2, mt.length)) score = 2;
      else if (shared >= 1) score = 1;
    }
    if (dob && m.dob && dob === m.dob) {
      // Ambiguous DOB: require the first name (or the exact name) to agree, never a surname alone.
      if (ambiguousDob && !exact && !(first && memberFirstToken(m.name) === first)) score = 0;
      else score += 2;
    } else if (dob && m.dob && dob !== m.dob) score = Math.max(0, score - 3);
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
