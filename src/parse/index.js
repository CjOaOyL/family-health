// parseDocument(doc, opts) → LabReport. Runs detect → vendor parser → analyte mapping → audit. See SPEC §4/§11.
import { detectVendor } from './detect.js';
import { parseLabcorp } from './labcorp.js';
import { parseQuest } from './quest.js';
import { parseGeneric } from './generic.js';
import { normalizeAnalyte, normalizeUnit, convertUnit } from '../model/analytes.js';
import { parseValue } from './common.js';
import { emptyReport, emptyResult } from '../model/schema.js';
import { buildAudit, scoreResult } from '../audit/confidence.js';

export const PARSER_VERSION = '1.1.0';

const VENDOR_PARSERS = { labcorp: parseLabcorp, quest: parseQuest };

function isObj(v) { return v != null && typeof v === 'object' && !Array.isArray(v); }

/** Merge a partial section into the empty template: template keys win on shape, partial values win when non-null. */
function mergeSection(template, partial) {
  const out = { ...template };
  if (!isObj(partial)) return out;
  for (const [k, v] of Object.entries(partial)) {
    if (v === undefined) continue;
    if (isObj(v) && isObj(template[k])) out[k] = mergeSection(template[k], v);
    else if (v !== null || !(k in template)) out[k] = v;
  }
  return out;
}

function mergeResult(partial, index) {
  const base = emptyResult(partial && partial.id ? partial.id : `r${index + 1}`);
  const r = mergeSection(base, partial || {});
  if (!r.id) r.id = `r${index + 1}`;
  if (!Array.isArray(r.lineIds)) r.lineIds = [];
  if (!isObj(r.referenceRange)) r.referenceRange = { text: null, low: null, high: null, kind: null };
  if (!isObj(r.fieldStatus)) r.fieldStatus = { ...base.fieldStatus };
  if (typeof r.valueText !== 'string') r.valueText = r.valueText == null ? '' : String(r.valueText);
  if (typeof r.name !== 'string') r.name = r.name == null ? '' : String(r.name);
  return r;
}

/** Fill canonicalId / loinc / canonicalUnit / canonicalValue on a result. Never throws. */
function canonicalize(r, notes) {
  try {
    const a = normalizeAnalyte(r.name, r.unit || undefined);
    if (a) {
      r.canonicalId = a.id ?? null;
      r.loinc = a.loinc ?? null;
      r.canonicalUnit = a.canonicalUnit ?? null;
    }
    if (typeof r.value === 'number' && Number.isFinite(r.value)) {
      let cv = r.value;
      if (r.unit && r.canonicalUnit) {
        const from = normalizeUnit(r.unit);
        const to = normalizeUnit(r.canonicalUnit);
        if (from && to && from !== to) {
          const conv = convertUnit(r.value, r.unit, r.canonicalUnit, r.canonicalId);
          if (typeof conv === 'number' && Number.isFinite(conv)) cv = conv;
          // No conversion known: keep the raw value AND label it with the printed unit so canonicalValue and
          // canonicalUnit always agree (SPEC §3). Compare must never plot a raw value under the dictionary unit.
          else r.canonicalUnit = from || r.unit;
        }
      }
      r.canonicalValue = cv;
    } else {
      r.canonicalValue = null;
    }
  } catch (e) {
    r.canonicalValue = typeof r.value === 'number' ? r.value : null;
    if (notes) notes.push(`Analyte mapping failed for "${r.name}": ${e && e.message ? e.message : e}`);
  }
}

/**
 * Defensive: a value printed with a trailing "*" ("6.2*", "6.2 *") is an abnormal marker (Quest). If the parser left
 * the star in valueText with no flag, set flag 'A'; if it also left value null, fill the numeric value from valueText.
 */
function honorStarFlag(r) {
  if (typeof r.valueText !== 'string' || !/\*\s*$/.test(r.valueText)) return;
  const pv = parseValue(r.valueText);
  if (!pv || !pv.starFlag) return;
  if (r.flag == null) { r.flag = 'A'; if (r.fieldStatus) r.fieldStatus.flag = 'found'; }
  if (r.value == null && !pv.isText && typeof pv.value === 'number') {
    r.value = pv.value;
    r.valueQualifier = pv.qualifier;
    if (r.fieldStatus) r.fieldStatus.value = 'found';
  }
}

/** A directionless critical flag ('C', e.g. Labcorp "Critical") becomes HH/LL when the range shows which side. */
function resolveCriticalDirection(r) {
  if (r.flag !== 'C' || typeof r.value !== 'number') return;
  const rr = r.referenceRange || {};
  if (typeof rr.high === 'number' && r.value > rr.high) r.flag = 'HH';
  else if (typeof rr.low === 'number' && r.value < rr.low) r.flag = 'LL';
}

function runParser(doc, vendor, notes) {
  const fn = VENDOR_PARSERS[vendor];
  if (fn) {
    try {
      const pr = fn(doc);
      if (pr && isObj(pr.report)) return pr;
      notes.push(`The ${vendor} parser returned no report; generic parsing was used instead.`);
    } catch (e) {
      notes.push(`The ${vendor} parser failed (${e && e.message ? e.message : e}); generic parsing was used instead.`);
    }
  }
  try {
    return parseGeneric(doc);
  } catch (e) {
    notes.push(`Generic parsing failed (${e && e.message ? e.message : e}); the document could not be parsed.`);
    return { report: {}, consumed: new Map(), notes: [], fieldEvidence: {} };
  }
}

/**
 * parseDocument(doc, { vendor } = {}) → LabReport. Never throws for a readable Document.
 */
export function parseDocument(doc, { vendor } = {}) {
  const notes = [];
  const safeDoc = isObj(doc) ? doc : { fileName: null, fileHash: null, pageCount: 0, pages: [] };
  if (!Array.isArray(safeDoc.pages)) safeDoc.pages = [];

  // 1. Detect
  let detected;
  try { detected = detectVendor(safeDoc); } catch (e) { detected = { vendor: 'unknown', confidence: 0, evidence: [] }; notes.push(`Vendor detection failed: ${e && e.message ? e.message : e}`); }
  let chosen = detected.vendor;
  let vendorConfidence = detected.confidence;
  if (vendor && VENDOR_PARSERS[vendor]) {
    chosen = vendor;
    vendorConfidence = detected.vendor === vendor ? Math.max(detected.confidence, 0.99) : 1; // user-asserted
    if (detected.vendor !== 'unknown' && detected.vendor !== vendor) notes.push(`Vendor forced to ${vendor} but the document looks like ${detected.vendor}.`);
  } else if (vendor && vendor !== 'unknown') {
    notes.push(`Unknown vendor option "${vendor}" ignored; using detection.`);
  }
  if (chosen === 'unknown') notes.push('Vendor not recognized; results are best-effort from the generic parser.');

  // 2. Parse
  const pr = runParser(safeDoc, chosen, notes);
  const prNotes = Array.isArray(pr.notes) ? pr.notes : [];

  // 3. Merge into canonical report
  const partial = pr.report || {};
  const report = emptyReport();
  for (const sec of ['source', 'patient', 'specimen', 'provider']) report[sec] = mergeSection(report[sec], partial[sec]);
  report.performingLabs = Array.isArray(partial.performingLabs) ? partial.performingLabs : [];
  report.panels = Array.isArray(partial.panels) ? partial.panels : [];
  report.comments = Array.isArray(partial.comments) ? partial.comments : [];
  report.results = (Array.isArray(partial.results) ? partial.results : []).map(mergeResult);

  // 3b. Header fields the parser flagged as uncertain/conflicting (notes "uncertain:<path>" / "conflict:<path>...")
  const fieldStatus = { ...(pr.fieldStatus || {}) };
  for (const n of prNotes) {
    const m = /^(?:uncertain|conflict):\s*([a-zA-Z.]+)/.exec(String(n));
    if (m && !fieldStatus[m[1]]) fieldStatus[m[1]] = 'uncertain';
  }
  pr.fieldStatus = fieldStatus;

  // 4. Analyte mapping + per-result confidence
  for (const r of report.results) {
    honorStarFlag(r);
    canonicalize(r, notes);
    resolveCriticalDirection(r);
    const computed = scoreResult(r);
    // A parser-supplied confidence (including exactly 0) is honored: keep min(parser, computed).
    r.confidence = typeof r.confidence === 'number' && Number.isFinite(r.confidence) ? Math.min(r.confidence, computed) : computed;
    delete r.hints;
  }

  // 5. Source fields
  report.source.vendor = chosen;
  report.source.vendorConfidence = vendorConfidence;
  report.source.fileName = safeDoc.fileName ?? null;
  report.source.fileHash = safeDoc.fileHash ?? null;
  report.source.pageCount = safeDoc.pageCount ?? safeDoc.pages.length;
  report.source.parserVersion = PARSER_VERSION;
  report.source.parsedAt = new Date().toISOString();
  if (report.source.reportStatus === undefined) report.source.reportStatus = null;
  report.id = report.source.fileHash;

  // 6. Audit
  const auditInput = { ...pr, notes: [...notes, ...prNotes] };
  try {
    report.audit = buildAudit(safeDoc, auditInput, report);
  } catch (e) {
    report.audit = {
      overall: 0, label: 'incomplete', fields: {}, coverage: { totalLines: 0, consumedLines: 0, unconsumed: [], resultLikeUnconsumed: 0, suspiciousConsumed: [], resultLikeTotal: 0 },
      pages: { declared: null, seen: safeDoc.pageCount || 0, complete: false }, results: { count: report.results.length, fullyParsed: 0, withIssues: report.results.length },
      warnings: [...auditInput.notes, `Audit failed: ${e && e.message ? e.message : e}`],
    };
  }
  return report;
}
