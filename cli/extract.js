#!/usr/bin/env node
// node cli/extract.js <file.pdf> [--json] [--redacted] [--vendor labcorp|quest]
// Local check for the user's own PDFs. Nothing leaves the machine.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createExtractor } from '../src/pdf/extractor.js';
import { parseDocument, PARSER_VERSION } from '../src/parse/index.js';
import { redactForSharing } from '../src/model/redact.js';
import { REQUIRED_FIELDS, IMPORTANT_FIELDS, getPath } from '../src/model/schema.js';

function usage(code = 1) {
  console.error('usage: node cli/extract.js <file.pdf> [--json] [--redacted] [--vendor labcorp|quest]');
  process.exit(code);
}

function parseArgs(argv) {
  const opts = { file: null, json: false, redacted: false, vendor: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '--redacted') opts.redacted = true;
    else if (a === '--vendor') { opts.vendor = argv[++i]; if (!opts.vendor) usage(); }
    else if (a.startsWith('--vendor=')) opts.vendor = a.slice('--vendor='.length);
    else if (a === '-h' || a === '--help') usage(0);
    else if (!opts.file) opts.file = a;
    else usage();
  }
  if (!opts.file) usage();
  if (opts.vendor && !['labcorp', 'quest'].includes(opts.vendor)) { console.error(`unknown vendor: ${opts.vendor}`); usage(); }
  return opts;
}

const pad = (s, n) => String(s ?? '').padEnd(n);
const trunc = (s, n) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

function summary(report, doc) {
  const L = [];
  const src = report.source;
  L.push(`File: ${src.fileName}  (${src.pageCount} page${src.pageCount === 1 ? '' : 's'}, sha256 ${String(src.fileHash).slice(0, 12)}…)`);
  L.push(`Vendor: ${src.vendor} (confidence ${src.vendorConfidence})  status: ${src.reportStatus ?? '-'}  parser ${src.parserVersion}`);
  L.push('');
  L.push('Header fields:');
  const paths = [...new Set([...REQUIRED_FIELDS, ...IMPORTANT_FIELDS])].filter((p) => p !== 'performingLabs' && p !== 'source.vendor');
  for (const p of paths) {
    const v = getPath(report, p);
    const st = report.audit?.fields?.[p]?.status ?? (v == null ? 'missing' : 'found');
    L.push(`  ${pad(p, 26)} ${pad(st, 10)} ${v == null ? '' : v}`);
  }
  const sp = report.specimen;
  L.push(`  ${pad('specimen.collectedTz', 26)} ${pad(sp.collectedTz ? 'found' : 'missing', 10)} ${sp.collectedTz ?? ''}`);
  L.push(`  ${pad('specimen.enteredAt', 26)} ${pad(sp.enteredAt ? 'found' : 'missing', 10)} ${sp.enteredAt ?? ''}`);
  L.push(`  ${pad('specimen.fasting', 26)} ${pad(sp.fasting == null ? 'missing' : 'found', 10)} ${sp.fasting ?? ''}`);
  L.push(`  ${pad('provider.referringName', 26)} ${pad(report.provider.referringName ? 'found' : 'missing', 10)} ${report.provider.referringName ?? ''}`);
  L.push('');
  L.push(`Performing labs (${report.performingLabs.length}):`);
  for (const lab of report.performingLabs) L.push(`  ${pad(lab.code, 4)} ${lab.name ?? ''}${lab.clia ? `  CLIA ${lab.clia}` : ''}${lab.director ? `  Dir ${lab.director}` : ''}`);
  L.push('');
  L.push(`Panels (${report.panels.length}): ${report.panels.map((p) => `${p.name} [${p.resultIds.length}]`).join('; ')}`);
  L.push('');
  L.push(`Results (${report.results.length}):`);
  L.push(`  ${pad('id', 5)} ${pad('name', 34)} ${pad('value', 14)} ${pad('unit', 12)} ${pad('range', 20)} ${pad('flag', 4)} ${pad('lab', 3)} conf`);
  for (const r of report.results) {
    L.push(`  ${pad(r.id, 5)} ${pad(trunc(r.name, 34), 34)} ${pad(trunc(r.valueText, 14), 14)} ${pad(trunc(r.unit ?? '', 12), 12)} ${pad(trunc(r.referenceRange?.text ?? '', 20), 20)} ${pad(r.flag ?? '', 4)} ${pad(r.performingLabCode ?? '', 3)} ${r.confidence.toFixed(2)}${r.canonicalId ? `  (${r.canonicalId})` : ''}`);
    if (r.comment) L.push(`        note: ${trunc(r.comment, 110)}`);
  }
  L.push('');
  const a = report.audit;
  L.push(`Audit: overall ${a.overall} (${a.label})  pages declared=${a.pages.declared ?? '?'} seen=${a.pages.seen} complete=${a.pages.complete}`);
  L.push(`       coverage ${a.coverage.consumedLines}/${a.coverage.totalLines} lines consumed, ${a.coverage.resultLikeUnconsumed} result-like unconsumed; results ${a.results.fullyParsed}/${a.results.count} fully parsed`);
  for (const w of a.warnings) L.push(`  ! ${w}`);
  L.push('');
  L.push(`Unconsumed lines (${a.coverage.unconsumed.length}):`);
  for (const u of a.coverage.unconsumed) L.push(`  ${pad(u.lineId, 8)} ${u.resultLike ? '[R] ' : '    '}${u.text}`);
  return L.join('\n');
}

/**
 * Load pdf.js (legacy build) without its Node canvas/polyfill warnings; text extraction does not need canvas.
 * pdf.js's warn() prints via console.log at module-evaluation time, so filter console.log during the import.
 */
async function loadPdfjs() {
  const origLog = console.log;
  console.log = (...args) => { if (!/napi-rs\/canvas|Cannot polyfill/.test(String(args[0]))) origLog(...args); };
  try {
    return await import('pdfjs-dist/legacy/build/pdf.mjs');
  } finally {
    console.log = origLog;
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const path = resolve(opts.file);
  const bytes = new Uint8Array(await readFile(path));
  const pdfjsLib = await loadPdfjs();
  const extractor = createExtractor(pdfjsLib);
  const doc = await extractor.extract(bytes, path.split(/[\\/]/).pop());
  const report = parseDocument(doc, { vendor: opts.vendor });
  if (opts.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else if (opts.redacted) {
    process.stdout.write(redactForSharing(report, doc) + '\n');
  } else {
    process.stdout.write(summary(report, doc) + '\n');
  }
}

// Piping into `head` closes stdout early; that is not an error worth reporting.
process.stdout.on('error', (e) => { if (e && e.code === 'EPIPE') process.exit(0); throw e; });

main().catch((e) => {
  console.error(`extract failed: ${e && e.message ? e.message : e}`);
  process.exit(2);
});
