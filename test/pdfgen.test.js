// Proves the synthetic PDFs in fixtures/pdf/ are text-based and extractable with pdf.js,
// independent of the extractor/parsers. Run `node fixtures/gen/build.js` first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

const PDF_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'pdf');

const CASES = [
  {
    file: 'labcorp-classic.pdf',
    pages: 3,
    strings: ['Labcorp', 'SAMPLE, ALEX Q', 'Specimen ID: 063-123-4567-0', 'Date collected: 03/04/2025 0815 Local',
      'Page 1 of 3', 'Hemoglobin A1c', '5.4', 'Cholesterol, Total', '210', 'High', 'Critical', 'x10E3/uL',
      'Thyroxine (T4) Free,', 'Direct', 'William F Hancock'],
    lastPage: 'Page 3 of 3',
  },
  {
    file: 'labcorp-portal.pdf',
    pages: 2,
    strings: ['Labcorp', 'Patient: SAMPLE, JORDAN', 'Date of Birth: 06/02/2012', 'Sex: F', 'Specimen #: 063-765-4321-0',
      'Ordering Physician: J SMITH', 'Page 1 of 2', 'Ferritin', '11', 'Test Name', 'Reference Interval'],
    lastPage: 'Page 2 of 2',
  },
  {
    file: 'quest-classic.pdf',
    pages: 4,
    strings: ['Quest Diagnostics', 'FINAL', 'SAMPLE, ALEX Q', 'Specimen: AB123456C', 'Collected: 09/10/2025 / 08:15 EDT',
      'DR. JANE DOE', 'Page 1 of 4', 'CHOLESTEROL, TOTAL', '210', 'H', '<200 mg/dL', 'HEMOGLOBIN A1c', '5.4',
      'NON HDL CHOLESTEROL', '(CALC)', 'HEPATITIS C ANTIBODY', 'NON-REACTIVE', 'PERFORMING SITE:', 'CLIA: 05D0643352',
      'CLIENT SERVICES: 1.866.697.8378'],
    lastPage: 'Page 4 of 4',
  },
  {
    file: 'quest-myquest.pdf',
    pages: 2,
    strings: ['Quest Diagnostics', 'Results for JORDAN SAMPLE', 'Collected on 09/10/2025', 'Ordered by DR. JANE DOE',
      'Specimen: CD789012E', 'Page 1 of 2', 'Your Value', 'CHOLESTEROL, TOTAL', '178 mg/dL', 'FERRITIN', '11 ng/mL'],
    lastPage: 'Page 2 of 2',
  },
];

/** Load a PDF with pdf.js and return the text of each page (items joined with single spaces). */
async function extractPageTexts(bytes) {
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, disableFontFace: true, verbosity: 0 });
  const pdf = await task.promise;
  try {
    const texts = [];
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n);
      const content = await page.getTextContent();
      texts.push(content.items.map((it) => it.str).filter((s) => s && s.trim()).join(' '));
      page.cleanup();
    }
    return texts;
  } finally {
    await pdf.destroy();
  }
}

for (const c of CASES) {
  test(`fixtures/pdf/${c.file} is text-based and extractable`, async () => {
    const bytes = await readFile(join(PDF_DIR, c.file));
    assert.ok(bytes.length > 1000, 'file should not be empty');
    assert.equal(bytes.subarray(0, 5).toString('latin1'), '%PDF-', 'should start with %PDF-');

    const texts = await extractPageTexts(bytes);
    assert.equal(texts.length, c.pages, `${c.file} should have ${c.pages} pages`);
    for (const [i, t] of texts.entries()) assert.ok(t.length > 200, `page ${i + 1} should contain text`);

    const all = texts.join('\n');
    for (const s of c.strings) assert.ok(all.includes(s), `expected text ${JSON.stringify(s)} in ${c.file}`);
    assert.ok(texts[texts.length - 1].includes(c.lastPage), `last page should say ${c.lastPage}`);
    // The identity header must repeat on every page.
    const firstPageId = c.strings[1];
    for (const [i, t] of texts.entries()) assert.ok(t.includes(firstPageId), `page ${i + 1} should repeat ${JSON.stringify(firstPageId)}`);
  });
}

test('generator exports data-driven specs and buildPdf()', async () => {
  const gen = await import('../fixtures/gen/build.js');
  assert.ok(Array.isArray(gen.REPORTS) && gen.REPORTS.length === 4);
  assert.equal(typeof gen.buildPdf, 'function');
  assert.deepEqual(gen.REPORTS.map((r) => r.file), CASES.map((c) => c.file));
  for (const spec of gen.REPORTS) {
    const expected = CASES.find((c) => c.file === spec.file);
    assert.equal(spec.expectedPages, expected.pages, `${spec.file} expectedPages`);
    const { bytes, pageCount } = await gen.buildPdf(spec);
    assert.equal(pageCount, expected.pages, `${spec.file} built in memory should have ${expected.pages} pages`);
    assert.ok(bytes instanceof Uint8Array && bytes.length > 1000);
  }
  assert.equal(gen.countResults(gen.labcorpClassic), 49);
  assert.equal(gen.countResults(gen.labcorpPortal), 22);
  assert.equal(gen.countResults(gen.questClassic), 48);
  assert.equal(gen.countResults(gen.questMyQuest), 15);
});
