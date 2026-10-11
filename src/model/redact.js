// redactForSharing(report, doc) → string: a diagnostic safe to paste to a developer.
// Never includes result values, dates, ids, names or any digits from unconsumed lines.

/** Field paths whose tokens are scrubbed from free text. */
const IDENTITY_PATHS = [
  ['patient', 'fullName'], ['patient', 'lastName'], ['patient', 'firstName'], ['patient', 'middleName'],
  ['patient', 'patientId'], ['patient', 'phone'], ['patient', 'address'],
  ['provider', 'orderingName'], ['provider', 'referringName'], ['provider', 'npi'], ['provider', 'accountNumber'],
  ['provider', 'accountName'], ['provider', 'address'], ['provider', 'phone'], ['provider', 'fax'],
  ['specimen', 'specimenId'], ['specimen', 'requisition'], ['specimen', 'labRef'],
];

const BLOCK = '█';

/** Collect identity tokens (≥2 chars, letters or digits) from the report's identity fields. */
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
  // Drop tokens that are too generic to redact safely (short common words).
  for (const t of [...toks]) if (/^(?:MD|DO|DR|MR|MS|JR|SR|II|III|OF|THE|AND)$/i.test(t)) toks.delete(t);
  return [...toks].sort((a, b) => b.length - a.length);
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Redact one free-text string: identity tokens → █, 10-digit runs → █, all digits → #. */
export function redactText(text, tokens) {
  let s = String(text == null ? '' : text);
  for (const t of tokens) {
    const re = new RegExp(`(?<![A-Za-z0-9])${escapeRe(t)}(?![A-Za-z0-9])`, 'gi');
    s = s.replace(re, BLOCK.repeat(Math.min(t.length, 8)));
  }
  s = s.replace(/\d(?:[\s().-]*\d){9}(?!\d)/g, (m) => BLOCK.repeat(Math.min(m.length, 12)));
  s = s.replace(/\d/g, '#');
  return s;
}

function fmtConf(n) { return typeof n === 'number' ? n.toFixed(2) : 'n/a'; }

/**
 * redactForSharing(report, doc) → string
 */
export function redactForSharing(report, doc) {
  const r = report || {};
  const src = r.source || {};
  const audit = r.audit || {};
  const tokens = identityTokens(r);
  const out = [];

  out.push('family-health redacted diagnostic');
  out.push('Redacted: all digits replaced by "#"; names, IDs, phone/fax, addresses, NPI/account/specimen numbers and 10-digit runs replaced by "█". Result values, dates and identity fields are omitted entirely.');
  out.push('');
  out.push(`vendor: ${src.vendor ?? 'unknown'} (confidence ${fmtConf(src.vendorConfidence)})`);
  out.push(`pages: ${src.pageCount ?? (doc && doc.pageCount) ?? 'n/a'}`);
  out.push(`parserVersion: ${src.parserVersion ?? 'n/a'}`);
  out.push(`reportStatus: ${src.reportStatus ?? 'null'}`);
  out.push('');

  out.push('audit:');
  out.push(`  overall: ${fmtConf(audit.overall)} (${audit.label ?? 'n/a'})`);
  if (audit.pages) out.push(`  pages: declared=${audit.pages.declared ?? 'null'} seen=${audit.pages.seen} complete=${audit.pages.complete}`);
  if (audit.coverage) out.push(`  coverage: ${audit.coverage.consumedLines}/${audit.coverage.totalLines} lines consumed, ${audit.coverage.resultLikeUnconsumed} result-like unconsumed`);
  if (audit.results) out.push(`  results: ${audit.results.count} total, ${audit.results.fullyParsed} fully parsed, ${audit.results.withIssues} with issues`);
  for (const w of audit.warnings || []) out.push(`  warning: ${redactText(w, tokens)}`);
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
      redactText(x.name, tokens),
      `unit=${x.unit ? redactText(x.unit, tokens) : 'null'}`,
      `range=${rr.kind ?? 'null'}`,
      `flag=${x.flag ? 'yes' : 'no'}`,
      `conf=${fmtConf(x.confidence)}`,
      `status=v:${x.fieldStatus?.value ?? '?'}/u:${x.fieldStatus?.unit ?? '?'}/r:${x.fieldStatus?.range ?? '?'}`,
    ];
    if (x.canonicalId) bits.push(`canonical=${x.canonicalId}`);
    out.push(`  ${bits.join('  ')}`);
  }
  out.push('');

  const unconsumed = (audit.coverage && audit.coverage.unconsumed) || [];
  out.push(`unconsumed lines (${unconsumed.length}; digits masked):`);
  for (const u of unconsumed) {
    out.push(`  [${u.lineId}]${u.resultLike ? ' [result-like]' : ''} ${redactText(u.text, tokens)}`);
  }
  return out.join('\n');
}
