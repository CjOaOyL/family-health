// Runner: build each adversarial variant, push it through the REAL pipeline (pdf.js legacy → createExtractor →
// parseDocument) and diff what was printed against what was parsed.
//   node fixtures/adversarial/run.js            → summary table for every variant
//   node fixtures/adversarial/run.js <id-substr> → details (diff, unconsumed, warnings) for matching variants
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createExtractor } from '../../src/pdf/extractor.js';
import { parseDocument } from '../../src/parse/index.js';
import { buildVariant, expectedRows, diffRows } from './gen.js';
import { buildVariants, REQUIRED_PATHS } from './variants.js';
import { pathToFileURL } from 'node:url';

const getPath = (o, p) => p.split('.').reduce((x, k) => (x == null ? undefined : x[k]), o);

export async function runSpec(spec, opts = {}, fileName = spec.file) {
  const { bytes, pageCount } = await buildVariant(spec, opts);
  const doc = await createExtractor(pdfjs).extract(bytes, fileName);
  const report = parseDocument(doc);
  const expected = expectedRows(spec);
  const diff = diffRows(expected, report);
  const requiredMissing = REQUIRED_PATHS.filter((p) => { const v = getPath(report, p); return v == null || v === ''; });
  return { bytes, pageCount, doc, report, expected, diff, requiredMissing };
}

export async function runVariant(v) {
  const r = await runSpec(v.spec, v.opts, `${v.id.replace(/\//g, '-')}.pdf`);
  const a = r.report.audit;
  return {
    ...r,
    summary: {
      id: v.id, vendor: r.report.source.vendor, vendorConf: r.report.source.vendorConfidence,
      pages: r.pageCount, count: r.report.results.length, expected: r.expected.length,
      requiredMissing: r.requiredMissing, overall: a.overall, label: a.label, rlu: a.coverage.resultLikeUnconsumed,
      missing: r.diff.missing.length, mismatches: r.diff.mismatches.length, extra: r.diff.extra.length,
    },
  };
}

function fmt(s) {
  const ok = s.vendor && s.count === s.expected && !s.missing && !s.mismatches && !s.extra && !s.requiredMissing.length && s.rlu === 0;
  return `${ok ? 'PASS' : 'FAIL'}  ${s.id.padEnd(44)} ${String(s.vendor).padEnd(8)} ${String(s.count).padStart(3)}/${String(s.expected).padEnd(3)} ` +
    `req-missing=${s.requiredMissing.length} overall=${s.overall} rlu=${s.rlu} missing=${s.missing} wrong=${s.mismatches} extra=${s.extra}`;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const filter = process.argv[2] || null;
  const variants = buildVariants().filter((v) => !filter || v.id.includes(filter));
  for (const v of variants) {
    const r = await runVariant(v);
    console.log(fmt(r.summary));
    if (filter) {
      if (r.requiredMissing.length) console.log('   required missing:', r.requiredMissing.join(', '));
      for (const m of r.diff.missing) console.log('   MISSING row:', m);
      for (const m of r.diff.mismatches) console.log(`   WRONG ${m.name} .${m.field}: expected ${JSON.stringify(m.expected)} got ${JSON.stringify(m.got)}`);
      for (const m of r.diff.extra) console.log('   EXTRA row:', m);
      for (const u of r.report.audit.coverage.unconsumed) if (u.resultLike) console.log('   UNCONSUMED result-like:', u.lineId, JSON.stringify(u.text));
      for (const w of r.report.audit.warnings) console.log('   warn:', w);
      console.log('   patient:', JSON.stringify(r.report.patient));
    }
  }
}
