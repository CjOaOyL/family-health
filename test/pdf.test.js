// End-to-end: fixtures/pdf/*.pdf → pdf.js (legacy build) → createExtractor → parseDocument → LabReport.
// Coded against docs/SPEC.md §2–§5. Run `node fixtures/gen/build.js` first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PDF_DIR = join(ROOT, 'fixtures', 'pdf');

/** Dynamic import that reports a missing module as a skip reason instead of crashing the run. */
async function tryImport(relPath) {
  try {
    return { mod: await import(new URL(relPath, import.meta.url).href), reason: null };
  } catch (e) {
    const missing = e && (e.code === 'ERR_MODULE_NOT_FOUND' || e.code === 'MODULE_NOT_FOUND');
    return { mod: null, reason: `${relPath} ${missing ? 'not available yet (missing module)' : 'failed to load'}: ${e && e.message}` };
  }
}

const extractorImport = tryImport('../src/pdf/extractor.js');
const parserImport = tryImport('../src/parse/index.js');

async function loadPipeline(t) {
  const [ex, pa] = await Promise.all([extractorImport, parserImport]);
  const reasons = [ex.reason, pa.reason].filter(Boolean);
  if (reasons.length) { t.skip(reasons.join('; ')); return null; }
  if (typeof ex.mod.createExtractor !== 'function') { t.skip('src/pdf/extractor.js does not export createExtractor'); return null; }
  if (typeof pa.mod.parseDocument !== 'function') { t.skip('src/parse/index.js does not export parseDocument'); return null; }
  return { createExtractor: ex.mod.createExtractor, parseDocument: pa.mod.parseDocument };
}

async function runPdf(pipeline, file) {
  const bytes = await readFile(join(PDF_DIR, file));
  const extractor = pipeline.createExtractor(pdfjs);
  const doc = await extractor.extract(new Uint8Array(bytes), file);
  const report = pipeline.parseDocument(doc);
  return { doc, report };
}

const REQUIRED = ['patient.fullName', 'patient.dob', 'patient.sex', 'specimen.collectedAt', 'specimen.reportedAt',
  'specimen.specimenId', 'provider.orderingName'];

function getPath(obj, path) { return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj); }

function findResult(report, name) {
  const key = name.toLowerCase().replace(/\s+/g, ' ').trim();
  return report.results.find((r) => (r.name || '').toLowerCase().replace(/\s+/g, ' ').trim() === key)
    || report.results.find((r) => (r.name || '').toLowerCase().startsWith(key));
}

function assertResult(report, want) {
  const r = findResult(report, want.name);
  assert.ok(r, `result ${JSON.stringify(want.name)} should be present; got names: ${report.results.slice(0, 60).map((x) => x.name).join(' | ')}`);
  if ('value' in want) assert.equal(r.value, want.value, `${want.name} value`);
  if ('valueText' in want) assert.equal(r.valueText, want.valueText, `${want.name} valueText`);
  if ('unit' in want) assert.equal(r.unit, want.unit, `${want.name} unit`);
  if ('flag' in want) assert.equal(r.flag, want.flag, `${want.name} flag`);
  if ('low' in want) assert.equal(r.referenceRange && r.referenceRange.low, want.low, `${want.name} range.low`);
  if ('high' in want) assert.equal(r.referenceRange && r.referenceRange.high, want.high, `${want.name} range.high`);
  if ('rangeKind' in want) assert.equal(r.referenceRange && r.referenceRange.kind, want.rangeKind, `${want.name} range.kind`);
  if ('lab' in want) assert.equal(r.performingLabCode, want.lab, `${want.name} performingLabCode`);
  if ('qualifier' in want) assert.equal(r.valueQualifier, want.qualifier, `${want.name} valueQualifier`);
  return r;
}

const CASES = [
  {
    file: 'labcorp-classic.pdf',
    vendor: 'labcorp',
    pages: 3,
    minResults: 49,
    identity: { fullName: 'SAMPLE, ALEX Q', dob: '1980-01-15', sex: 'M', specimenId: '063-123-4567-0', ordering: 'J SMITH',
      collectedAt: '2025-03-04T08:15', reportedAt: '2025-03-05T10:23' },
    results: [
      { name: 'Hemoglobin A1c', value: 5.4, unit: '%', low: 4.8, high: 5.6, flag: null, lab: '01' },
      { name: 'Cholesterol, Total', value: 210, unit: 'mg/dL', flag: 'H', low: 100, high: 199 },
      { name: 'Platelets', value: 142, unit: 'x10E3/uL', flag: 'L', low: 150, high: 450 },
      { name: 'Potassium', value: 6.1, unit: 'mmol/L', flag: 'HH' },
      { name: 'Vitamin D, 25-Hydroxy', value: 24.3, unit: 'ng/mL', flag: 'L', lab: '02' },
    ],
    wrapped: { prefix: 'Thyroxine (T4) Free', value: 1.22 },
  },
  {
    file: 'labcorp-portal.pdf',
    vendor: 'labcorp',
    pages: 2,
    minResults: 22,
    identity: { fullName: 'SAMPLE, JORDAN', dob: '2012-06-02', sex: 'F', specimenId: '063-765-4321-0', ordering: 'J SMITH',
      collectedAt: '2025-03-04T08:30', reportedAt: '2025-03-05T11:02' },
    results: [
      { name: 'Ferritin', value: 11, unit: 'ng/mL', flag: 'L', low: 13, high: 68 },
      { name: 'UIBC', value: 345, unit: 'ug/dL', flag: 'H' },
      { name: 'Vitamin B12', value: 512, unit: 'pg/mL', lab: '02' },
      { name: 'TSH', value: 1.87, unit: 'uIU/mL', flag: null },
    ],
  },
  {
    file: 'quest-classic.pdf',
    vendor: 'quest',
    pages: 4,
    minResults: 48,
    identity: { fullName: 'SAMPLE, ALEX Q', dob: '1980-01-15', sex: 'M', specimenId: 'AB123456C', ordering: 'DR. JANE DOE',
      collectedAt: '2025-09-10T08:15', reportedAt: '2025-09-11T06:12' },
    results: [
      { name: 'CHOLESTEROL, TOTAL', value: 210, flag: 'H', unit: 'mg/dL', high: 200, rangeKind: 'lt', lab: 'EZ' },
      { name: 'HEMOGLOBIN A1c', value: 5.4, flag: null, high: 5.7 },
      { name: 'POTASSIUM', value: 6.1, flag: 'HH', unit: 'mmol/L' },
      { name: 'VITAMIN D,25-OH,TOTAL,IA', value: 24, flag: 'L', unit: 'ng/mL', low: 30, high: 100, lab: 'PR' },
      { name: 'HEPATITIS C ANTIBODY', valueText: 'NON-REACTIVE', value: null, lab: 'PR' },
    ],
    wrapped: { prefix: 'NON HDL CHOLESTEROL', value: 162 },
  },
  {
    file: 'quest-myquest.pdf',
    vendor: 'quest',
    pages: 2,
    minResults: 15,
    identity: { fullName: /JORDAN/, dob: '2012-06-02', sex: 'F', specimenId: 'CD789012E', ordering: 'DR. JANE DOE',
      collectedAt: /^2025-09-10/, reportedAt: /^2025-09-11/ },
    results: [
      { name: 'CHOLESTEROL, TOTAL', value: 178, flag: 'H', unit: 'mg/dL' },
      { name: 'FERRITIN', value: 11, unit: 'ng/mL' },
      { name: 'TSH', value: 1.87, unit: 'mIU/L' },
    ],
  },
];

function assertMatch(actual, expected, label) {
  if (expected instanceof RegExp) assert.match(String(actual), expected, label);
  else assert.equal(actual, expected, label);
}

for (const c of CASES) {
  test(`end-to-end ${c.file}: pdf.js → extractor → parseDocument`, async (t) => {
    const pipeline = await loadPipeline(t);
    if (!pipeline) return;
    const { doc, report } = await runPdf(pipeline, c.file);

    // Document model (§2)
    assert.equal(doc.pageCount, c.pages, 'doc.pageCount');
    assert.equal(doc.pages.length, c.pages, 'doc.pages.length');
    assert.match(doc.fileHash, /^[0-9a-f]{64}$/, 'fileHash is sha256 hex');
    for (const p of doc.pages) assert.ok(p.lines.length > 10, `page ${p.pageNumber} has lines`);

    // Source / vendor
    assert.equal(report.source.vendor, c.vendor, 'source.vendor');
    assert.ok(report.source.vendorConfidence >= 0.8, `vendorConfidence ${report.source.vendorConfidence}`);
    assert.equal(report.source.pageCount, c.pages, 'source.pageCount');
    assert.equal(report.id, doc.fileHash, 'report.id is the fileHash');

    // Required identity fields (§3) non-null
    for (const path of REQUIRED) {
      const v = getPath(report, path);
      assert.ok(v !== null && v !== undefined && v !== '', `${path} should be non-null (got ${JSON.stringify(v)})`);
    }
    assertMatch(report.patient.fullName, c.identity.fullName, 'patient.fullName');
    assert.equal(report.patient.dob, c.identity.dob, 'patient.dob');
    assert.equal(report.patient.sex, c.identity.sex, 'patient.sex');
    assert.equal(report.specimen.specimenId, c.identity.specimenId, 'specimen.specimenId');
    assert.equal(report.provider.orderingName, c.identity.ordering, 'provider.orderingName');
    assertMatch(report.specimen.collectedAt, c.identity.collectedAt, 'specimen.collectedAt');
    assertMatch(report.specimen.reportedAt, c.identity.reportedAt, 'specimen.reportedAt');

    // Results
    assert.ok(Array.isArray(report.results), 'results array');
    assert.ok(report.results.length >= c.minResults, `expected >= ${c.minResults} results, got ${report.results.length}`);
    assert.equal(report.results[0].id, 'r1', 'result ids start at r1');
    for (const want of c.results) assertResult(report, want);
    if (c.wrapped) {
      const r = report.results.find((x) => (x.name || '').toUpperCase().startsWith(c.wrapped.prefix.toUpperCase()));
      assert.ok(r, `wrapped-name result starting ${JSON.stringify(c.wrapped.prefix)} should be present`);
      assert.equal(r.value, c.wrapped.value, 'wrapped-name result value');
    }
    // No two results should claim the same line.
    const seen = new Set();
    for (const r of report.results) for (const id of r.lineIds || []) {
      assert.ok(!seen.has(id), `line ${id} claimed by more than one result`);
      seen.add(id);
    }

    // Audit (§5)
    assert.ok(report.audit, 'audit present');
    assert.equal(report.audit.coverage.resultLikeUnconsumed, 0,
      `resultLikeUnconsumed should be 0; unconsumed result-like lines: ${JSON.stringify((report.audit.coverage.unconsumed || []).filter((u) => u.resultLike).map((u) => u.text))}`);
    assert.ok(report.audit.overall >= 0.95, `audit.overall ${report.audit.overall} >= 0.95; warnings: ${JSON.stringify(report.audit.warnings)}`);
    assert.equal(report.audit.label, 'complete', 'audit.label');
    assert.equal(report.audit.pages.declared, c.pages, 'audit.pages.declared');
    assert.equal(report.audit.pages.seen, c.pages, 'audit.pages.seen');
    assert.equal(report.audit.pages.complete, true, 'audit.pages.complete');
    assert.equal(report.audit.results.count, report.results.length, 'audit.results.count');
  });
}

test('end-to-end: both vendors expose two performing labs and panel grouping', async (t) => {
  const pipeline = await loadPipeline(t);
  if (!pipeline) return;
  for (const file of ['labcorp-classic.pdf', 'quest-classic.pdf']) {
    const { report } = await runPdf(pipeline, file);
    const codes = report.performingLabs.map((l) => l.code).sort();
    assert.deepEqual(codes, file.startsWith('labcorp') ? ['01', '02'] : ['EZ', 'PR'], `${file} performing lab codes`);
    assert.ok(report.panels.length >= 6, `${file} should have >= 6 panels, got ${report.panels.length}`);
    const panelled = report.results.filter((r) => r.panel).length;
    assert.ok(panelled >= report.results.length * 0.9, `${file}: most results should carry a panel name`);
    assert.equal(report.source.reportStatus, 'final', `${file} reportStatus`);
  }
});
