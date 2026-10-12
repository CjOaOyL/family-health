// redactForSharing(report, doc) → string: a diagnostic safe to paste to a developer.
//
// Shape-preserving redaction. Free text (unconsumed lines, suspicious consumed lines, warnings, unmatched result
// names) is rebuilt token by token: a token survives ONLY if it is a known analyte word, a unit, report vocabulary
// or punctuation. Every other word becomes "▒" repeated to its length and every digit becomes "#". Anything the
// parser FAILED to recognize (which is exactly what the diagnostic shows) is therefore masked by default, instead of
// relying on the parser having found the identity fields first. Result values are never printed anywhere.
import { ANALYTES, normalizeKey, normalizeAnalyte } from './analytes.js';
import { UNIT_RE } from '../parse/common.js';

export const WORD_MASK = '▒';
export const DIGIT_MASK = '#';

/** Field paths whose tokens are always masked, even when they collide with allowed vocabulary (defense in depth). */
const IDENTITY_PATHS = [
  ['patient', 'fullName'], ['patient', 'lastName'], ['patient', 'firstName'], ['patient', 'middleName'],
  ['patient', 'patientId'], ['patient', 'phone'], ['patient', 'address'], ['patient', 'dob'],
  ['provider', 'orderingName'], ['provider', 'referringName'], ['provider', 'npi'], ['provider', 'accountNumber'],
  ['provider', 'accountName'], ['provider', 'address'], ['provider', 'phone'], ['provider', 'fax'],
  ['specimen', 'specimenId'], ['specimen', 'requisition'], ['specimen', 'labRef'],
];

/** Report vocabulary that may print in clear (lower-case). Generic words only; never names, places or numbers. */
export const ALLOWED_WORDS = new Set([
  // table / header vocabulary
  'test', 'tests', 'result', 'results', 'flag', 'flags', 'units', 'unit', 'reference', 'interval', 'range', 'ranges', 'lab',
  'page', 'of', 'date', 'collected', 'received', 'reported', 'entered', 'issued', 'specimen', 'patient', 'id', 'dob', 'age',
  'gender', 'sex', 'ordering', 'referring', 'physician', 'provider', 'account', 'npi', 'phone', 'fax', 'final', 'partial',
  'corrected', 'preliminary', 'report', 'note', 'notes', 'comment', 'comments', 'please', 'see', 'high', 'low', 'critical',
  'normal', 'abnormal', 'negative', 'positive', 'reactive', 'non', 'detected', 'not', 'estab', 'established', 'panel', 'with',
  'and', 'or', 'the', 'for', 'is', 'are', 'in', 'a', 'an', 'to', 'by', 'performing', 'site', 'laboratory', 'director', 'clia',
  'requisition', 'ref', 'client', 'services', 'service', 'fasting', 'ordered', 'items', 'number', 'status', 'details',
  'information', 'name', 'value', 'your', 'out', 'details', 'desirable', 'optimal', 'calc', 'calculated', 'none', 'seen',
  'applicable', 'na', 'n', 'pending', 'immune', 'absent', 'present', 'trace', 'equivocal', 'indeterminate', 'qns', 'tnp',
  // audit / parser warning vocabulary (confidence.js, index.js, parsers)
  'line', 'lines', 'look', 'looks', 'like', 'row', 'rows', 'consumed', 'unconsumed', 'parsed', 'parse', 'parser', 'parsing',
  'overall', 'score', 'capped', 'cap', 'at', 'field', 'fields', 'found', 'uncertain', 'optional', 'required', 'missing',
  'values', 'declared', 'declares', 'pages', 'seen', 'were', 'was', 'be', 'may', 'might', 'truncated', 'pdf', 'markers',
  'marker', 'no', 'so', 'completeness', 'could', 'verified', 'recognized', 'recognised', 'have', 'has', 'issues', 'issue',
  'vendor', 'generic', 'detection', 'detect', 'failed', 'used', 'instead', 'best', 'effort', 'from', 'document', 'forced',
  'but', 'this', 'that', 'these', 'those', 'review', 'conflicting', 'across', 'as', 'column', 'columns', 'without', 'letter',
  'set', 'both', 'text', 'printed', 'numeric', 'known', 'wrapped', 'wrap', 'header', 'fragment', 'unrecognized', 'dropped',
  'drop', 'swallowed', 'attached', 'previous', 'next', 'under', 'into', 'glued', 'only', 'one', 'two', 'all', 'any', 'some',
  'more', 'than', 'first', 'last', 'left', 'right', 'between', 'also', 'still', 'because', 'when', 'where', 'which', 'what',
  'while', 'it', 'its', 'on', 'off', 'up', 'down', 'over', 'per', 'via', 'if', 'then', 'else', 'ignored', 'ignoring',
  'ignore', 'using', 'use', 'option', 'unknown', 'returned', 'does', 'do', 'did', 'done', 'been', 'being', 'can', 'cannot',
  'will', 'would', 'should', 'must', 'after', 'before', 'again', 'twice', 'inline', 'cell', 'cells', 'empty', 'blank',
  'mapping', 'analyte', 'canonical', 'conversion', 'converted', 'confidence', 'audit', 'coverage', 'complete', 'incomplete',
  'needs', 'need', 'went', 'go', 'went', 'end', 'start', 'table', 'footer', 'legend', 'code', 'codes', 'repeated', 'repeat',
  'differ', 'differs', 'different', 'same', 'twice', 'mismatch', 'misaligned', 'alignment', 'offset', 'defaulted', 'default',
  'assumed', 'assume', 'yes', 'true', 'false', 'null', 'never', 'always', 'sometimes', 'likely', 'possibly', 'probably',
]);

/** Every word that occurs in an analyte alias/display name, e.g. "cholesterol", "total", "a1c", "hdl". */
export const ANALYTE_WORDS = new Set();
for (const a of ANALYTES) {
  for (const s of [...(a.aliases || []), a.display || '', a.id.replace(/_/g, ' ')]) {
    for (const w of normalizeKey(s).split(' ')) if (w && /[a-z]/.test(w)) ANALYTE_WORDS.add(w);
  }
}

/** Collect identity strings and words (≥2 chars) from the report's identity fields. */
export function identityTokens(report) {
  const toks = new Set();
  const add = (v) => {
    if (v == null) return;
    const s = String(v).trim();
    if (!s) return;
    toks.add(s);
    for (const t of s.split(/[\s,.;:\/\-()]+/)) if (t.length >= 2 && /[A-Za-z0-9]/.test(t)) toks.add(t);
  };
  for (const [sec, key] of IDENTITY_PATHS) add(report && report[sec] ? report[sec][key] : null);
  const cs = report && report.specimen && report.specimen.collectionSite;
  if (cs) { add(cs.name); add(cs.address); add(cs.code); }
  for (const pl of (report && report.performingLabs) || []) { add(pl.director); add(pl.phone); add(pl.clia); }
  // Drop tokens that are too generic to redact safely (short common words / titles).
  for (const t of [...toks]) if (/^(?:MD|DO|DR|MR|MS|JR|SR|II|III|OF|THE|AND)$/i.test(t)) toks.delete(t);
  return [...toks].sort((a, b) => b.length - a.length);
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Shape-mask a string: letters → ▒, digits → #, everything else kept. */
export function shapeMask(s) {
  return String(s == null ? '' : s).replace(/[A-Za-z]/g, WORD_MASK).replace(/\d/g, DIGIT_MASK);
}

const LINE_ID_RE = /^p\d+l\d+$/;
const stripPunct = (t) => t.replace(/^[^A-Za-z0-9%]+|[^A-Za-z0-9%]+$/g, '');

/**
 * redactText(text, tokens) → shape-preserving redaction of one free-text string.
 * Keeps: analyte words, unit tokens (UNIT_RE), report vocabulary (ALLOWED_WORDS), line ids (p1l12), punctuation.
 * Masks: every other word (▒ per letter) and every digit (#). `tokens` (identity strings/words from the report)
 * are always masked, even when they would otherwise be allowed.
 */
export function redactText(text, tokens = []) {
  let s = String(text == null ? '' : text);
  // 1. Whole identity strings (multi-word) first, so "DOE, JANE MARIE" never survives as separate allowed words.
  for (const t of tokens) {
    if (t.length < 2) continue;
    const re = new RegExp(`(?<![A-Za-z0-9])${escapeRe(t)}(?![A-Za-z0-9])`, 'gi');
    s = s.replace(re, (m) => shapeMask(m));
  }
  const identityWords = new Set(tokens.map((t) => t.toLowerCase()));
  // 2. Token by token.
  return s.replace(/\S+/g, (tok) => {
    const bare = stripPunct(tok);
    if (!bare) return tok;                                                   // pure punctuation
    if (LINE_ID_RE.test(bare)) return tok;                                   // audit line ids
    if (UNIT_RE.test(bare) && !identityWords.has(bare.toLowerCase())) return tok;   // "mg/dL", "x10E3/uL", "%"
    return tok.replace(/[A-Za-z][A-Za-z0-9]*|\d+/g, (run) => {
      if (/^\d+$/.test(run)) return DIGIT_MASK.repeat(run.length);
      const lower = run.toLowerCase();
      if (identityWords.has(lower)) return shapeMask(run);
      if (ALLOWED_WORDS.has(lower) || ANALYTE_WORDS.has(lower)) return run;
      return shapeMask(run);
    });
  });
}

/** Warnings may interpolate document text inside quotes; replace every quoted span with "…" before masking. */
export function redactWarning(w, tokens = []) {
  const s = String(w == null ? '' : w).replace(/"[^"]*"|“[^”]*”|'[^']{3,}'/g, '…');
  return redactText(s, tokens);
}

function fmtConf(n) { return typeof n === 'number' ? n.toFixed(2) : 'n/a'; }

/** A result name is printed in clear only when the analyte dictionary recognizes it; otherwise it is shape-masked. */
function redactName(name, unit, tokens) {
  const s = String(name == null ? '' : name);
  if (!s.trim()) return '(blank)';
  let known = false;
  try { known = !!normalizeAnalyte(s, unit || undefined); } catch { known = false; }
  if (known && !tokens.some((t) => t.length >= 3 && s.toLowerCase().includes(t.toLowerCase()))) return s;
  return redactText(s, tokens);
}

function redactUnit(unit, tokens) {
  if (!unit) return 'null';
  const s = String(unit).trim();
  if (UNIT_RE.test(s)) return s;
  return redactText(s, tokens);
}

/**
 * redactForSharing(report, doc) → string
 */
export function redactForSharing(report, doc) {
  const r = report || {};
  const src = r.source || {};
  const audit = r.audit || {};
  const tokens = identityTokens(r);
  const out = [];

  out.push('lab-extraction redacted diagnostic');
  out.push(`Masking: in every free-text line below, a word is printed in clear ONLY if it is a known analyte name, a unit, or generic report vocabulary; every other word is shown as "${WORD_MASK}" per letter and every digit as "${DIGIT_MASK}". Quoted text inside warnings is replaced by "…". Result values, dates, names, IDs, addresses and phone numbers are never printed. Result names are printed only when the analyte dictionary recognizes them.`);
  out.push('');
  out.push(`vendor: ${src.vendor ?? 'unknown'} (confidence ${fmtConf(src.vendorConfidence)})`);
  out.push(`pages: ${src.pageCount ?? (doc && doc.pageCount) ?? 'n/a'}`);
  out.push(`parserVersion: ${src.parserVersion ?? 'n/a'}`);
  out.push(`reportStatus: ${src.reportStatus ?? 'null'}`);
  out.push('');

  out.push('audit:');
  out.push(`  overall: ${fmtConf(audit.overall)} (${audit.label ?? 'n/a'})`);
  if (audit.pages) out.push(`  pages: declared=${audit.pages.declared ?? 'null'} seen=${audit.pages.seen} complete=${audit.pages.complete}`);
  const cov = audit.coverage || {};
  if (audit.coverage) {
    out.push(`  coverage: ${cov.consumedLines}/${cov.totalLines} lines consumed, ${cov.resultLikeUnconsumed ?? 0} result-like unconsumed, ${(cov.suspiciousConsumed || []).length} consumed-as-comment lines that look like result rows`);
  }
  if (audit.results) out.push(`  results: ${audit.results.count} total, ${audit.results.fullyParsed} fully parsed, ${audit.results.withIssues} with issues`);
  for (const w of audit.warnings || []) out.push(`  warning: ${redactWarning(w, tokens)}`);
  out.push('');

  out.push('fields (status only):');
  const fields = audit.fields || {};
  for (const p of Object.keys(fields)) out.push(`  ${p}: ${fields[p].status} (${fmtConf(fields[p].confidence)})`);
  out.push('');

  out.push(`results (${(r.results || []).length}; names/units/range kinds only, no values):`);
  for (const x of r.results || []) {
    const rr = x.referenceRange || {};
    const bits = [
      `${x.id}`,
      redactName(x.name, x.unit, tokens),
      `unit=${redactUnit(x.unit, tokens)}`,
      `range=${rr.kind ?? 'null'}`,
      `flag=${x.flag ? 'yes' : 'no'}`,
      `conf=${fmtConf(x.confidence)}`,
      `status=v:${x.fieldStatus?.value ?? '?'}/u:${x.fieldStatus?.unit ?? '?'}/r:${x.fieldStatus?.range ?? '?'}`,
    ];
    if (x.canonicalId) bits.push(`canonical=${x.canonicalId}`);
    out.push(`  ${bits.join('  ')}`);
  }
  out.push('');

  const suspicious = cov.suspiciousConsumed || [];
  if (suspicious.length) {
    out.push(`consumed-as-comment lines that look like result rows (${suspicious.length}; masked):`);
    for (const s of suspicious) out.push(`  [${s.lineId}] [${s.tag}] ${redactText(s.text, tokens)}`);
    out.push('');
  }

  const unconsumed = cov.unconsumed || [];
  out.push(`unconsumed lines (${unconsumed.length}; masked):`);
  for (const u of unconsumed) {
    out.push(`  [${u.lineId}]${u.resultLike ? ' [result-like]' : ''} ${redactText(u.text, tokens)}`);
  }
  return out.join('\n');
}
