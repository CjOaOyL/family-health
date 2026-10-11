// Shared parsing helpers used by all vendor parsers. Pure functions, no I/O. See docs/SPEC.md §4.

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };

const pad2 = (n) => String(n).padStart(2, '0');

/**
 * Parse a US-style date/time as printed by Labcorp or Quest.
 * Accepts: "03/04/2025", "03/04/25", "03/04/2025 0815 Local", "03/04/2025 08:15 EDT",
 *          "03/04/2025 / 08:15 EDT", "03/05/25 1023 ET", "Mar 04, 2025", "2025-03-04".
 * Returns { iso: 'YYYY-MM-DD' | 'YYYY-MM-DDTHH:mm', date: 'YYYY-MM-DD', time: 'HH:mm'|null, tz: string|null } or null.
 */
export function parseUSDate(input) {
  if (input == null) return null;
  const s = String(input).trim().replace(/\s+/g, ' ');
  if (!s) return null;
  let y, m, d, rest = '';
  let mt = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2}|\d{4})(?:\b|\s)(.*)$/);
  if (mt) {
    m = +mt[1]; d = +mt[2]; y = +mt[3]; rest = mt[4] || '';
    if (mt[3].length === 2) y += y < 50 ? 2000 : 1900;
  } else if ((mt = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T\s](.*))?$/))) {
    y = +mt[1]; m = +mt[2]; d = +mt[3]; rest = mt[4] || '';
  } else if ((mt = s.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})(.*)$/))) {
    m = MONTHS[mt[1].slice(0, 3).toLowerCase()]; d = +mt[2]; y = +mt[3]; rest = mt[4] || '';
    if (!m) return null;
  } else if ((mt = s.match(/^(\d{1,2})\s+([A-Za-z]{3,9})\.?\s+(\d{4})(.*)$/))) {
    d = +mt[1]; m = MONTHS[mt[2].slice(0, 3).toLowerCase()]; y = +mt[3]; rest = mt[4] || '';
    if (!m) return null;
  } else {
    return null;
  }
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1900 || y > 2100) return null;
  const date = `${y}-${pad2(m)}-${pad2(d)}`;
  let time = null, tz = null;
  rest = rest.replace(/^[\s\/,-]+/, '').trim();
  if (rest) {
    const t = rest.match(/^(\d{1,2}):?(\d{2})\s*(AM|PM|am|pm)?\s*(.*)$/);
    if (t) {
      let hh = +t[1]; const mm = +t[2];
      if (t[3]) { const ap = t[3].toUpperCase(); if (ap === 'PM' && hh < 12) hh += 12; if (ap === 'AM' && hh === 12) hh = 0; }
      if (hh <= 23 && mm <= 59) { time = `${pad2(hh)}:${pad2(mm)}`; tz = (t[4] || '').trim() || null; }
      else tz = rest || null;
    } else {
      tz = rest;
    }
    if (tz) tz = tz.replace(/[()]/g, '').trim() || null;
  }
  return { iso: time ? `${date}T${time}` : date, date, time, tz };
}

/** Find the first date-like substring in free text and parse it. */
export function findDate(text) {
  if (!text) return null;
  const m = String(text).match(/(\d{1,2}[\/\-.]\d{1,2}[\/\-.](?:\d{4}|\d{2})(?:\s*\/?\s*\d{1,2}:?\d{2}\s*(?:AM|PM|am|pm)?\s*[A-Za-z]{0,6})?)/);
  return m ? parseUSDate(m[1]) : null;
}

const NUM_RE = /^([<>]=?|≤|≥)?\s*([-+]?\d{1,3}(?:,\d{3})+(?:\.\d+)?|[-+]?\d*\.?\d+)\s*$/;
export const NUMERIC_TOKEN_RE = /(?:[<>]=?)?\s*[-+]?\d{1,3}(?:,\d{3})*(?:\.\d+)?|(?:[<>]=?)?\s*[-+]?\d*\.\d+/;

const TEXT_VALUES = [
  'NEGATIVE', 'POSITIVE', 'NORMAL', 'ABNORMAL', 'DETECTED', 'NOT DETECTED', 'NONDETECTED', 'NON-REACTIVE', 'NONREACTIVE',
  'REACTIVE', 'ABSENT', 'PRESENT', 'TRACE', 'NONE SEEN', 'NOT ESTAB.', 'NOT ESTAB', 'SEE NOTE', 'SEE BELOW', 'SEE COMMENT',
  'N/A', 'NA', 'PENDING', 'CANCELED', 'CANCELLED', 'TNP', 'QNS', 'CLEAR', 'YELLOW', 'STRAW', 'AMBER', 'INDETERMINATE',
  'EQUIVOCAL', 'INCONCLUSIVE', 'FEW', 'MODERATE', 'MANY', 'RARE', 'OCCASIONAL', 'ADEQUATE', 'INSUFFICIENT', 'SUFFICIENT',
  'COMMENT', 'NOT CALCULATED', 'NOT CALC.', 'NOT APPLICABLE', 'IMMUNE', 'NON-IMMUNE', 'HIGH', 'LOW', 'NOT INDICATED',
];
const TEXT_VALUE_SET = new Set(TEXT_VALUES);

/** True when the token is a recognized non-numeric result value ("NEGATIVE", "Not Estab.", "1:40" ...). */
export function isTextValue(tok) {
  if (!tok) return false;
  const t = tok.trim().toUpperCase().replace(/\s+/g, ' ');
  return TEXT_VALUE_SET.has(t) || /^\d+:\d+$/.test(t) || /^[<>]\s*\d+:\d+$/.test(t);
}

/**
 * Parse a printed result value.
 * Returns { valueText, value: number|null, qualifier: '<'|'>'|'<='|'>='|null, isText: boolean } or null if not value-like.
 */
export function parseValue(raw) {
  if (raw == null) return null;
  const text = String(raw).trim();
  if (!text) return null;
  const m = text.match(NUM_RE);
  if (m) {
    let q = m[1] || null;
    if (q === '≤') q = '<='; if (q === '≥') q = '>=';
    const value = parseFloat(m[2].replace(/,/g, ''));
    if (Number.isFinite(value)) return { valueText: text, value, qualifier: q, isText: false };
  }
  if (isTextValue(text)) return { valueText: text, value: null, qualifier: null, isText: true };
  return null;
}

/** Parse a reference interval string → { text, low, high, kind } (kind: range|lt|gt|le|ge|text|null). */
export function parseRange(raw) {
  if (raw == null) return { text: null, low: null, high: null, kind: null };
  let text = String(raw).trim().replace(/\s+/g, ' ');
  if (!text) return { text: null, low: null, high: null, kind: null };
  const core = text.replace(/\s*\([^)]*\)\s*$/, '').trim();        // drop trailing "(Fasting)" / "(see note)"
  const num = '[-+]?\\d{1,3}(?:,\\d{3})*(?:\\.\\d+)?|[-+]?\\d*\\.\\d+';
  const toN = (s) => parseFloat(s.replace(/,/g, ''));
  let m;
  if ((m = core.match(new RegExp(`^(${num})\\s*(?:-|–|—|to)\\s*(${num})\\b`)))) {
    return { text, low: toN(m[1]), high: toN(m[2]), kind: 'range' };
  }
  if ((m = core.match(new RegExp(`^(?:<|less than)\\s*=?\\s*(${num})`, 'i')))) {
    const le = /^<\s*=|^≤/.test(core);
    return { text, low: null, high: toN(m[1]), kind: le ? 'le' : 'lt' };
  }
  if ((m = core.match(new RegExp(`^≤\\s*(${num})`)))) return { text, low: null, high: toN(m[1]), kind: 'le' };
  if ((m = core.match(new RegExp(`^(?:>|greater than)\\s*=?\\s*(${num})`, 'i')))) {
    const ge = /^>\s*=|^≥/.test(core);
    return { text, low: toN(m[1]), high: null, kind: ge ? 'ge' : 'gt' };
  }
  if ((m = core.match(new RegExp(`^≥\\s*(${num})`)))) return { text, low: toN(m[1]), high: null, kind: 'ge' };
  if ((m = core.match(new RegExp(`^(${num})\\s*(?:or|and)\\s*(?:above|higher|greater)`, 'i')))) return { text, low: toN(m[1]), high: null, kind: 'ge' };
  if ((m = core.match(new RegExp(`^(${num})\\s*(?:or|and)\\s*(?:below|lower|less)`, 'i')))) return { text, low: null, high: toN(m[1]), kind: 'le' };
  if ((m = core.match(new RegExp(`^up to\\s*(${num})`, 'i')))) return { text, low: null, high: toN(m[1]), kind: 'le' };
  return { text, low: null, high: null, kind: 'text' };
}

/** Normalize a printed flag to 'H'|'L'|'HH'|'LL'|'A'|'C'|null. */
export function normalizeFlag(raw) {
  if (raw == null) return null;
  const t0 = String(raw).trim().toUpperCase();
  const t = /^\*+$/.test(t0) ? t0 : t0.replace(/\*+$/, '').trim();
  if (!t) return null;
  const map = {
    H: 'H', HI: 'H', HIGH: 'H', 'H*': 'H',
    L: 'L', LO: 'L', LOW: 'L',
    HH: 'HH', 'CRITICAL HIGH': 'HH', 'CRIT HIGH': 'HH', 'PANIC HIGH': 'HH',
    LL: 'LL', 'CRITICAL LOW': 'LL', 'CRIT LOW': 'LL', 'PANIC LOW': 'LL',
    A: 'A', AB: 'A', ABN: 'A', ABNORMAL: 'A', ALERT: 'A', '*': 'A', '**': 'A',
    C: 'C', CRIT: 'C', CRITICAL: 'C', PANIC: 'C',
  };
  return map[t] || null;
}

/** Tokens that are flags when they stand alone in a cell. */
export const FLAG_TOKEN_RE = /^(?:H|L|HH|LL|A|C|HI|LO|HIGH|LOW|ABNORMAL|CRITICAL|ALERT|\*|\*\*)\*?$/i;

/** Unit-looking token. Deliberately broad; parsers use column position first. */
export const UNIT_RE = /^(?:%|x10E?\d\/[umµ]?L|10\^?\d\/[umµ]?L|10\*\d\/[umµ]?L|K\/[umµ]?L|M\/[umµ]?L|Thousand\/[umµ]?L|Million\/[umµ]?L|cells\/[umµ]?L|[mµun]?g\/(?:d?L|mL|24 ?hr?|g(?: creat)?)|[mµnp]?mol\/(?:L|mL|24 ?hr?)|[mµu]?I?U\/(?:m?L|mL)|m?Eq\/L|[mµ]?IU\/mL|[mµ]?[gG]\/[dm]?L|pg\/mL|ng\/mL|ng\/dL|mcg\/dL|mcg\/mL|mcg\/L|ug\/L|ug\/dL|ug\/mL|nmol\/L|pmol\/L|umol\/L|mmol\/L|mmol\/mol|fL|pg|mL\/min(?:\/1\.73(?:m2|m\^2)?)?|mm\/hr|sec|seconds|ratio|index|AU\/mL|U\/mL|U\/L|IU\/L|mIU\/L|mIU\/mL|uIU\/mL|uU\/mL|mg\/L|g\/L|g\/dL|mg\/dL|mg\/g|ug\/g|titer|copies\/mL|IU\/mL|log IU\/mL|RU\/mL|EU\/mL|kU\/L|kIU\/L|%\s*sat(?:uration)?|mOsm\/kg|mm\s*Hg|cm|kg|lb|BPM|kPa|S\/CO|s\/co|COI|AI|ISR|Mg\/dL|mg\/dl|ng\/ml|cells\/mcL|\/HPF|\/LPF|\/hpf|\/lpf|\/uL|\/mcL|per HPF|per LPF)$/i;

export function isUnitToken(tok) {
  return !!tok && UNIT_RE.test(String(tok).trim());
}

/** Split "LAST, FIRST M" | "First M Last" | "LAST, FIRST MIDDLE" into parts. */
export function splitName(raw) {
  if (!raw) return { fullName: null, lastName: null, firstName: null, middleName: null };
  const s = String(raw).trim().replace(/\s+/g, ' ');
  if (!s) return { fullName: null, lastName: null, firstName: null, middleName: null };
  let lastName = null, firstName = null, middleName = null;
  if (s.includes(',')) {
    const [l, rest = ''] = s.split(',').map((x) => x.trim());
    lastName = l || null;
    const parts = rest.split(' ').filter(Boolean);
    firstName = parts[0] || null;
    middleName = parts.slice(1).join(' ') || null;
  } else {
    const parts = s.split(' ').filter(Boolean);
    if (parts.length === 1) { lastName = parts[0]; }
    else { firstName = parts[0]; lastName = parts[parts.length - 1]; middleName = parts.slice(1, -1).join(' ') || null; }
  }
  return { fullName: s, lastName, firstName, middleName };
}

/** Normalize sex/gender tokens. */
export function normalizeSex(raw) {
  if (!raw) return null;
  const t = String(raw).trim().toUpperCase();
  if (/^(M|MALE)$/.test(t)) return 'M';
  if (/^(F|FEMALE)$/.test(t)) return 'F';
  if (/^(U|UNKNOWN|X|O|OTHER)$/.test(t)) return 'U';
  return null;
}

/** "Yes"/"Y"/"No"/"N" → boolean|null */
export function normalizeYesNo(raw) {
  if (raw == null) return null;
  const t = String(raw).trim().toUpperCase();
  if (/^(Y|YES|TRUE)$/.test(t)) return true;
  if (/^(N|NO|FALSE)$/.test(t)) return false;
  return null;
}

/** Match "Label: value" at the start of a string. Returns value (string) or null. Label match is case-insensitive. */
export function labelValue(text, label) {
  if (!text) return null;
  const esc = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s*');
  const m = String(text).match(new RegExp(`(?:^|\\s)${esc}\\s*[:#]?\\s*(.*)$`, 'i'));
  return m ? m[1].trim() : null;
}

/** Extract "Page X of Y" → { page, of } or null. */
export function parsePageOf(text) {
  const m = String(text || '').match(/\bPage\s*(\d+)\s*(?:of|\/)\s*(\d+)\b/i);
  return m ? { page: +m[1], of: +m[2] } : null;
}

/** Strip leading indentation markers and collapse spaces. */
export function clean(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

/** Age like "45" | "45 Y" | "45 years" | "7 M" → number|null (years; months → fraction rounded to 2dp). */
export function parseAge(raw) {
  if (raw == null) return null;
  const m = String(raw).trim().match(/^(\d{1,3})\s*(Y|YR|YRS|YEARS?|M|MO|MOS|MONTHS?|D|DAYS?)?\b/i);
  if (!m) return null;
  const n = +m[1]; const u = (m[2] || 'Y').toUpperCase();
  if (u.startsWith('M')) return Math.round((n / 12) * 100) / 100;
  if (u.startsWith('D')) return Math.round((n / 365) * 100) / 100;
  return n;
}
