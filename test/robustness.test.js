// Adversarial robustness suite: NEW synthetic PDFs the parser authors never saw, generated on the fly by
// fixtures/adversarial/gen.js (nothing is written to disk) and pushed through the REAL pipeline:
// pdf.js (legacy build) → createExtractor → parseDocument. Each variant is diffed row-by-row against what was printed.
//
// Pass criteria for a variant: vendor detected, results.count === rows printed, every printed row found with the
// right valueText/value/flag/unit/range text, no extra rows, all REQUIRED fields non-null, resultLikeUnconsumed === 0,
// audit.overall >= 0.95. Variants that currently fail are declared in KNOWN_FAILURES and run as `todo` so the suite
// stays green while every gap stays runnable: delete the entry once the parser is fixed and the test turns real.
//
//   node --test test/robustness.test.js
//   node fixtures/adversarial/run.js [id-substring]      → the same variants with full diff detail
import { test, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createExtractor } from '../src/pdf/extractor.js';
import { parseDocument } from '../src/parse/index.js';
import { parseRange, parseValue, isTextValue } from '../src/parse/common.js';
import { buildVariant, expectedRows, diffRows } from '../fixtures/adversarial/gen.js';
import { buildVariants, twinSpecs, LAYOUTS, REQUIRED_PATHS } from '../fixtures/adversarial/variants.js';

const getPath = (o, p) => p.split('.').reduce((x, k) => (x == null ? undefined : x[k]), o);

// ---------------------------------------------------------------------------------------------
// Known failures (id → what the parser does today). Keep each reason concrete: input → produced vs expected.
// ---------------------------------------------------------------------------------------------
const LABCORP_FLAG_IN_VALUE_CELL = 'labcorp.js probeRow(): a value cell "142 Low" (value+flag in one item, or two items < GAP_CELL apart) is not split → valueText "142 Low", value null, flag null';
const LABCORP_ROWS_LEFT_OF_HEADER = 'labcorp.js colOf(): rows printed 15pt LEFT of the header labels (COL_TOL=12) land in the previous column → unflagged rows are consumed as COMMENTS (silently dropped: audit overall=1, resultLikeUnconsumed=0), flagged rows get the value glued into the name ("Platelets 142")';
const LABCORP_STAR_VALUE = 'common.js parseValue(): "6.2*" is neither numeric nor a known text value → labcorp emits valueText "6.2*" with value null (Quest classic maps the "*" to flag A)';
const LABCORP_NOTE_AS_WRAPPED_NAME = 'labcorp.js isNameLike()/holdName: a short note line ("Diabetes: >6.4", "Fasting 8-12 hours") directly ABOVE the next result row is treated as a wrapped name → next result becomes "Diabetes: >6.4 Glucose"; the note is lost and the real row name is missing';
const LABCORP_VALUE_BELOW_LABEL = 'labcorp.js headerCell(): "Ordering:" / "Patient ID:" with the value on the NEXT line → value line is "Unrecognized header fragment"; provider.orderingName (REQUIRED) and patient.patientId stay null';
const LABCORP_NO_TABLE_HEADER = 'labcorp.js: without a TESTS/RESULT header line the first table rows on each page are swallowed by the account-block continuation (header:account → provider.accountName "CBC With Differential/Platelet", provider.address "WBC, RBC"); 5 of 21 rows silently dropped with overall=1';
const LABCORP_PORTAL_NO_TABLE_HEADER = 'labcorp.js probeRow() fallback (no header): "232-1245" is not recognized as a range because common.js parseRange() only accepts 1-3 digit numbers → Vitamin B12 range null, confidence 0.75';

const QUEST_ROWS_LEFT_OF_HEADER = 'quest.js assignColumns(): rows printed 15pt LEFT of the header labels (COL_TOL=14) shift one column left → value glued into the name, reference range parsed as the value (flag A), lab code parsed as the range; 14 of 19 rows missing, overall=1';
const QUEST_DIGIT_NAMES = 'quest.js analyzeRow(): result names starting with a digit ("25-OH Vitamin D", "5-HIAA") fail /^[A-Za-z%(]/ → row rejected and left unconsumed (audit does flag it: resultLikeUnconsumed=2)';
const QUEST_COMBINED_HEADER_ITEM = 'quest.js classifyCell(): "DOB: 01/15/1980  AGE: 45  Gender: M" as ONE text item only yields DOB; patient.sex (REQUIRED) and age are null (labcorp.js splitLabels() handles the same line)';
const QUEST_VALUE_BELOW_LABEL = 'quest.js classifyCell(): "Patient ID:" with the value on the NEXT line → "987654" is filed as patient.address; patient.patientId null; "partially understood header line" note';
const QUEST_NO_TABLE_HEADER = 'quest.js handleLine(): without a Test Name/In Range header the parser stays in header mode; result lines are classified as patient.address/provider.address fragments ("partially understood header line") and never reach analyzeRowFallback → 0 of 19 rows, panel name "CBC (INCLUDES DIFF/PLT)" stored as patient.address';
const QUEST_UNIT_AFTER_VALUE = 'quest.js parseValueCell(): "133 mg/dL (calc)" and "5.4 % of total Hgb" (unit after the value, parenthetical / 4-token unit) are not recognized → value null, unit null';
const QUEST_FLAG_WORDS = 'quest.js VALUE_FLAG_RE only accepts H/L/HH/LL/A/C/*: "135 Low", "104 High", "6.1 Critical" → value null, flag A (out-of-range column without a letter)';
const MYQUEST_RIGHT_ALIGNED = 'lines.js GAP_CELL (max(6, 1.8*cw) ≈ 8pt at 9pt text): a right-aligned "178 mg/dL" ending 8pt before the Reference Range column merges with it into one cell → quest.js files the line as a COMMENT; 9 of 11 rows silently dropped (only the flagged row is reported unconsumed)';
const MYQUEST_STAR_VALUE = 'quest.js parseValueCell(): "6.2* %" (star before the inline unit) → value null, flag null, valueText "6.2* %", status uncertain';
const MYQUEST_RANGE_VALUE = 'quest.js parseValueCell(): text value "0-2" with inline unit "/HPF" → valueText "0-2 /HPF" (unit not split off), status uncertain; "Non Reactive" (space) is not in common.js TEXT_VALUES → status uncertain + warning';
const MYQUEST_VALUE_BELOW_LABEL = 'quest.js LABELS: "Results for" / "Ordered by" with the value on the NEXT line → patient.fullName and provider.orderingName (both REQUIRED) null, overall capped at 0.9';
const MYQUEST_NO_TABLE_HEADER = 'quest.js analyzeRowFallback(): without a header, a 4-cell flagged row [name, "178 mg/dL", "<170 mg/dL", "H"] is rejected (the 3rd cell "H" is neither range nor lab) and filed as a COMMENT; silently dropped (overall=1)';

export const KNOWN_FAILURES = {
  'labcorp-classic/rows-15': LABCORP_ROWS_LEFT_OF_HEADER,
  'labcorp-classic/right-aligned': `${LABCORP_FLAG_IN_VALUE_CELL} (value right-aligned to 8pt before the FLAG column merges with the flag item)`,
  'labcorp-classic/flag-inline': LABCORP_FLAG_IN_VALUE_CELL,
  'labcorp-classic/flag-gap2': LABCORP_FLAG_IN_VALUE_CELL,
  'labcorp-classic/values': LABCORP_STAR_VALUE,
  'labcorp-classic/comments': LABCORP_NOTE_AS_WRAPPED_NAME,
  'labcorp-classic/header-value-below': LABCORP_VALUE_BELOW_LABEL,
  'labcorp-classic/no-table-header': LABCORP_NO_TABLE_HEADER,
  'labcorp-portal/rows-15': LABCORP_ROWS_LEFT_OF_HEADER,
  'labcorp-portal/right-aligned': LABCORP_FLAG_IN_VALUE_CELL,
  'labcorp-portal/flag-inline': LABCORP_FLAG_IN_VALUE_CELL,
  'labcorp-portal/flag-gap2': LABCORP_FLAG_IN_VALUE_CELL,
  'labcorp-portal/values': LABCORP_STAR_VALUE,
  'labcorp-portal/comments': LABCORP_NOTE_AS_WRAPPED_NAME,
  'labcorp-portal/header-value-below': LABCORP_VALUE_BELOW_LABEL,
  'labcorp-portal/no-table-header': LABCORP_PORTAL_NO_TABLE_HEADER,
  'quest-classic/rows-15': QUEST_ROWS_LEFT_OF_HEADER,
  'quest-classic/names': QUEST_DIGIT_NAMES,
  'quest-classic/header-combined-item': QUEST_COMBINED_HEADER_ITEM,
  'quest-classic/header-value-below': QUEST_VALUE_BELOW_LABEL,
  'quest-classic/no-table-header': QUEST_NO_TABLE_HEADER,
  'quest-classic/units-in-value-cell': QUEST_UNIT_AFTER_VALUE,
  'quest-classic/flags-words': QUEST_FLAG_WORDS,
  'quest-myquest/rows-15': QUEST_ROWS_LEFT_OF_HEADER,
  'quest-myquest/right-aligned': MYQUEST_RIGHT_ALIGNED,
  'quest-myquest/names': QUEST_DIGIT_NAMES,
  'quest-myquest/values': MYQUEST_STAR_VALUE,
  'quest-myquest/ranges': MYQUEST_RANGE_VALUE,
  'quest-myquest/header-combined-item': QUEST_COMBINED_HEADER_ITEM,
  'quest-myquest/header-value-below': MYQUEST_VALUE_BELOW_LABEL,
  'quest-myquest/no-table-header': MYQUEST_NO_TABLE_HEADER,
};

/** Extra, variant-specific assertions on top of the generic pass criteria. */
const EXTRA_CHECKS = {
  'no-page-of': (r) => {
    assert.equal(r.report.audit.pages.declared, null, 'no page markers → pages.declared null');
    assert.ok(r.report.audit.warnings.some((w) => /Page X of Y/i.test(w)), 'warning about missing page markers');
  },
  'six-pages': (r, v) => {
    assert.ok(r.pageCount >= 6, `expected >= 6 pages, got ${r.pageCount}`);
    assert.equal(r.report.audit.pages.declared, r.pageCount);
    const big = r.report.results.filter((x) => /Allergen f\d{3} IgE/.test(x.name));
    assert.equal(big.length, 100, 'all 100 allergen rows found');
    assert.ok(new Set(big.map((x) => x.page)).size >= 3, 'the allergen panel spans >= 3 pages');
    assert.ok(big.every((x) => x.panel && /ALLERGEN PROFILE/i.test(x.panel)), 'rows on continuation pages keep their panel');
    void v;
  },
  'header-blank-patient-id': (r) => {
    assert.equal(r.report.patient.patientId, null, 'blank "Patient ID:" stays null, never ""');
  },
  'header-value-below': (r, v) => {
    if (v.layout === 'quest-classic') assert.notEqual(r.report.patient.address, v.spec.patient.patientId, 'patient ID must not be filed as patient.address');
    assert.equal(r.report.patient.patientId, v.spec.patient.patientId ?? null, 'patient.patientId from the line below its label');
  },
  'name-suffix': (r, v) => {
    if (v.expectName instanceof RegExp) assert.match(String(r.report.patient.fullName), v.expectName);
    else assert.equal(r.report.patient.fullName, v.expectName);
  },
  'all-in-range': (r) => {
    assert.ok(r.report.results.every((x) => x.flag === null), 'no flags when the Out of Range column is empty everywhere');
  },
};

// ---------------------------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------------------------
async function run(spec, opts, fileName) {
  const { bytes, pageCount } = await buildVariant(spec, opts);
  const doc = await createExtractor(pdfjs).extract(bytes, fileName);
  const report = parseDocument(doc);
  const expected = expectedRows(spec);
  const diff = diffRows(expected, report);
  const requiredMissing = REQUIRED_PATHS.filter((p) => { const val = getPath(report, p); return val == null || val === ''; });
  return { bytes, pageCount, doc, report, expected, diff, requiredMissing };
}

function assertVariant(v, r) {
  const a = r.report.audit;
  assert.equal(r.report.source.vendor, v.spec.vendor, 'vendor detected');
  assert.ok(r.report.source.vendorConfidence >= 0.8, `vendorConfidence ${r.report.source.vendorConfidence}`);
  assert.deepEqual(r.requiredMissing, [], `required fields missing: ${r.requiredMissing.join(', ')}`);
  assert.deepEqual(r.diff.missing, [], `rows printed but not parsed: ${r.diff.missing.join(' | ')}`);
  assert.deepEqual(r.diff.mismatches, [], `wrong values: ${r.diff.mismatches.map((m) => `${m.name}.${m.field}: expected ${JSON.stringify(m.expected)} got ${JSON.stringify(m.got)}`).join(' | ')}`);
  assert.deepEqual(r.diff.extra, [], `rows parsed that were never printed: ${r.diff.extra.join(' | ')}`);
  assert.equal(r.report.results.length, r.expected.length, 'results.count');
  assert.equal(a.coverage.resultLikeUnconsumed, 0, `result-like lines unconsumed: ${a.coverage.unconsumed.filter((u) => u.resultLike).map((u) => u.text).join(' | ')}`);
  assert.ok(a.overall >= 0.95, `audit.overall ${a.overall} (${a.label}); warnings: ${a.warnings.join(' / ')}`);
  if (v.minPages) assert.ok(r.pageCount >= v.minPages, `pages ${r.pageCount} >= ${v.minPages}`);
  const extra = EXTRA_CHECKS[v.id.split('/')[1]];
  if (extra) extra(r, v);
}

const variants = buildVariants();
const results = new Map();

before(async () => {
  // Generate every PDF in memory (≈ 95 variants, nothing hits the disk).
  for (const v of variants) {
    try { results.set(v.id, await run(v.spec, v.opts, `${v.id.replace(/\//g, '-')}.pdf`)); }
    catch (e) { results.set(v.id, { error: e }); }
  }
});

describe('adversarial variants (pdf-lib → pdf.js → extractor → parseDocument)', () => {
  for (const v of variants) {
    const todo = KNOWN_FAILURES[v.id];
    test(`${v.id}: ${v.title}`, todo ? { todo } : {}, () => {
      const r = results.get(v.id);
      assert.ok(r, 'variant was generated');
      if (r.error) throw r.error;
      assertVariant(v, r);
    });
  }
});

describe('two family members, otherwise identical reports', () => {
  for (const layout of LAYOUTS) {
    test(`${layout}: different fileHash, identical results, no identity cross-contamination`, async () => {
      const { a, b } = twinSpecs(layout);
      const ra = await run(a, {}, 'member-a.pdf');
      const rb = await run(b, {}, 'member-b.pdf');
      assert.notEqual(ra.report.id, rb.report.id, 'fileHash differs');
      assert.match(ra.report.id, /^[0-9a-f]{64}$/);
      const strip = (rep) => rep.results.map((r) => ({ ...r, lineIds: undefined }));
      assert.deepEqual(strip(ra.report), strip(rb.report), 'result rows identical');
      assert.notEqual(ra.report.patient.fullName, rb.report.patient.fullName);
      assert.match(String(ra.report.patient.dob), /^\d{4}-\d{2}-\d{2}$/);
      assert.equal(rb.report.patient.dob, '1965-11-30');
      assert.notEqual(ra.report.patient.dob, rb.report.patient.dob);
      assert.ok(/CASEY/.test(rb.report.patient.fullName), rb.report.patient.fullName);
      assert.ok(!/CASEY/.test(ra.report.patient.fullName), ra.report.patient.fullName);
      assert.deepEqual(ra.requiredMissing, []);
      assert.deepEqual(rb.requiredMissing, []);
    });
  }
});

describe('audit blind spots', () => {
  test('rows the parser mis-files as comments are invisible to the coverage audit', { todo: 'labcorp.js/quest.js attach ANY unexplained in-table line as a comment, so buildAudit() never sees it: labcorp-classic/rows-15 drops 15 rows with resultLikeUnconsumed=0 and overall=1' }, () => {
    const r = results.get('labcorp-classic/rows-15');
    assert.ok(r && !r.error);
    const dropped = r.diff.missing.length;
    assert.ok(dropped > 0, 'variant still drops rows');
    assert.ok(r.report.audit.coverage.resultLikeUnconsumed >= dropped || r.report.audit.overall < 0.95,
      `audit should flag ${dropped} dropped rows; got resultLikeUnconsumed=${r.report.audit.coverage.resultLikeUnconsumed}, overall=${r.report.audit.overall}`);
  });
  test('comment text that is really a dropped row is attached to the previous result', { todo: 'same root cause; the dropped "BUN 15 mg/dL 6-24" line becomes part of the previous result\'s comment' }, () => {
    const r = results.get('labcorp-classic/rows-15');
    const polluted = r.report.results.filter((x) => x.comment && /\b(?:mg\/dL|mmol\/L|x10E3\/uL)\b/.test(x.comment) && /\d-\d/.test(x.comment));
    assert.equal(polluted.length, 0, `results whose comment contains a swallowed row: ${polluted.map((x) => x.name).join(', ')}`);
  });
});

describe('common.js primitives (observed on the adversarial inputs)', () => {
  test('parseRange: 4-digit bounds ("1500-7800", "232-1245") give numeric low/high', { todo: 'common.js parseRange() num pattern is \\d{1,3}(?:,\\d{3})* → "1500-7800" (Quest absolute neutrophils, in the authors\' own fixture) parses as kind "text" with low/high null' }, () => {
    for (const [s, lo, hi] of [['1500-7800', 1500, 7800], ['232-1245', 232, 1245], ['850-3900', 850, 3900]]) {
      const r = parseRange(s);
      assert.equal(r.kind, 'range', s);
      assert.equal(r.low, lo, s); assert.equal(r.high, hi, s);
    }
  });
  test('parseRange: titer range "<1:80" is text, not "< 1"', { todo: 'common.js parseRange("<1:80") → kind "lt", high 1 (quest.js patches this locally; labcorp.js does not)' }, () => {
    const r = parseRange('<1:80');
    assert.equal(r.kind, 'text'); assert.equal(r.high, null);
  });
  test('parseRange: "< OR = 4.0" is a <= bound', { todo: 'common.js parseRange("< OR = 4.0") → kind "text" (quest.js normalizes "< OR =" before calling it; labcorp.js does not)' }, () => {
    const r = parseRange('< OR = 4.0');
    assert.equal(r.kind, 'le'); assert.equal(r.high, 4);
  });
  test('parseValue: "6.2*" is 6.2 with an abnormal marker', { todo: 'common.js parseValue("6.2*") → null' }, () => {
    const r = parseValue('6.2*');
    assert.ok(r && r.value === 6.2, JSON.stringify(r));
  });
  test('isTextValue: "Non Reactive" (space) is a known text value like "NON-REACTIVE"', { todo: 'common.js TEXT_VALUES has NON-REACTIVE/NONREACTIVE but not "NON REACTIVE"; confidence.js isCellTextValue() works around it, quest.js marks the value uncertain' }, () => {
    assert.ok(isTextValue('Non Reactive'));
  });
  test('parseRange handles the ranges the parsers do get right', () => {
    assert.deepEqual(parseRange('-2.0-3.0'), { text: '-2.0-3.0', low: -2, high: 3, kind: 'range' });
    assert.deepEqual(parseRange('10,000-20,000'), { text: '10,000-20,000', low: 10000, high: 20000, kind: 'range' });
    assert.equal(parseRange('<130 (calc)').high, 130);
    assert.equal(parseRange('70-99 (Fasting)').low, 70);
    assert.equal(parseRange('0-1 /HPF').high, 1);
    assert.equal(parseRange('>=60').kind, 'ge');
  });
});
