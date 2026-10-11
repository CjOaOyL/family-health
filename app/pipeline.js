// Lazy, load-safe access to the extraction/parsing modules written by other parts of the app.
// Every import is dynamic and wrapped so a missing or broken module degrades to a clear error
// instead of taking the whole UI down. pdf.js is injected from index.html, never imported here.

let pdfjsLib = null;
let pdfjsError = null;
const mods = {};
const errors = {};

const PATHS = {
  extractor: '../src/pdf/extractor.js',
  parser: '../src/parse/index.js',
  redact: '../src/model/redact.js',
  analytes: '../src/model/analytes.js',
};

export function setPdfjs(lib, err) { pdfjsLib = lib || null; pdfjsError = err || null; }
export function hasPdfjs() { return !!pdfjsLib; }
export function pdfjsProblem() { return pdfjsError ? (pdfjsError.message || String(pdfjsError)) : null; }

async function load(name) {
  if (name in mods) return mods[name];
  try {
    mods[name] = await import(PATHS[name]);
  } catch (e) {
    mods[name] = null;
    errors[name] = e;
  }
  return mods[name];
}

export async function getParserModule() { return load('parser'); }
export async function getRedactModule() { return load('redact'); }
export async function getAnalytesModule() { return load('analytes'); }

let extractor = null;
export async function getExtractor() {
  if (extractor) return extractor;
  const m = await load('extractor');
  if (!m || typeof m.createExtractor !== 'function') return null;
  if (!pdfjsLib) return null;
  try { extractor = m.createExtractor(pdfjsLib); } catch (e) { errors.extractor = e; return null; }
  return extractor;
}

export async function getParserVersion() {
  const m = await load('parser');
  return m && m.PARSER_VERSION ? String(m.PARSER_VERSION) : null;
}

/** Human-readable status of each dependency, for Settings and error messages. */
export async function moduleStatus() {
  await Promise.all(Object.keys(PATHS).map(load));
  const status = { pdfjs: !!pdfjsLib, pdfjsError: pdfjsProblem() };
  for (const k of Object.keys(PATHS)) {
    status[k] = !!mods[k];
    if (errors[k]) status[k + 'Error'] = errors[k].message || String(errors[k]);
  }
  status.parserVersion = mods.parser?.PARSER_VERSION || null;
  return status;
}

function problem(name) {
  const e = errors[name];
  return e ? `: ${e.message || e}` : ' (module not available)';
}

/** bytes → Document via src/pdf/extractor.js. Throws with a readable message on failure. */
export async function extractDocument(bytes, fileName) {
  if (!pdfjsLib) throw new Error('PDF engine (pdf.js) did not load' + (pdfjsError ? `: ${pdfjsError.message || pdfjsError}` : '. Check your connection and reload.'));
  const ex = await getExtractor();
  if (!ex) throw new Error('PDF extractor failed to load' + problem('extractor'));
  const buf = bytes instanceof ArrayBuffer ? bytes : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return ex.extract(buf, fileName);
}

/** Document → LabReport via src/parse/index.js. Throws if the parser module is missing or throws. */
export async function parseDoc(doc, opts = {}) {
  const m = await load('parser');
  if (!m || typeof m.parseDocument !== 'function') throw new Error('Parser failed to load' + problem('parser'));
  return m.parseDocument(doc, opts);
}

/**
 * Full pipeline for one PDF. Never throws; returns { doc, report, error, parserVersion }.
 * If extraction fails, doc is null. If parsing fails, doc is still returned so the UI can show raw lines.
 */
export async function extractAndParse(bytes, fileName, opts = {}) {
  const out = { doc: null, report: null, error: null, parserVersion: null };
  try {
    out.doc = await extractDocument(bytes, fileName);
  } catch (e) {
    out.error = e;
    return out;
  }
  try {
    out.report = await parseDoc(out.doc, opts);
    out.parserVersion = out.report?.source?.parserVersion || (await getParserVersion());
  } catch (e) {
    out.error = e;
  }
  return out;
}

/** Redacted diagnostic text for sharing; throws if redact module is unavailable. */
export async function redact(report, doc) {
  const m = await load('redact');
  if (!m || typeof m.redactForSharing !== 'function') throw new Error('Redaction module failed to load' + problem('redact'));
  return m.redactForSharing(report, doc);
}

let analyteIndex = null;
/** Map canonicalId → display name from ANALYTES (empty map if module missing). */
export async function analyteNames() {
  if (analyteIndex) return analyteIndex;
  analyteIndex = new Map();
  const m = await load('analytes');
  const list = m && Array.isArray(m.ANALYTES) ? m.ANALYTES : [];
  for (const a of list) if (a && a.id) analyteIndex.set(a.id, { display: a.display || a.id, canonicalUnit: a.canonicalUnit || null, group: a.group || null });
  return analyteIndex;
}

/** Compute sha256 hex of bytes (used only when the extractor is unavailable, e.g. for de-dupe). */
export async function sha256Hex(bytes) {
  const buf = bytes instanceof ArrayBuffer ? bytes : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, '0')).join('');
}
