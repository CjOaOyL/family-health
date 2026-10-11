# Synthetic PDF fixtures

- Regenerate: `node fixtures/gen/build.js` (or `npm run fixtures`) writes `fixtures/pdf/*.pdf` and prints page counts; a mismatch against each spec's `expectedPages` is flagged.
- Verify: `node --test test/pdfgen.test.js` (pdf.js text extraction only) and `node --test test/pdf.test.js` (extractor + parser end to end).
- Every report is a plain JS object (`labcorpClassic`, `labcorpPortal`, `questClassic`, `questMyQuest`, collected in `REPORTS`); `buildPdf(spec)` returns `{ bytes, pageCount }` without touching disk.
- Rows use the `L(name, value, flag, unit, ref, lab, opts)` / `Q(name, value, flag, refWithUnit, lab, opts)` / `M(name, value, ref, flag)` helpers; `opts.notes` adds comment lines under the row and `opts.cont` adds a wrapped second line of the test name.
- Insert `PAGE_BREAK` between panels to force a new page; otherwise rows flow until `LAYOUT[layout].bodyBottom` and the header/footer repeat on every page automatically.
- Column x positions live in `COLUMNS` (Labcorp 36/250/330/380/450/560, Quest 36/260/330/410/560, MyQuest 36/260/380/540). The hand-authored `*.doc.json` fixtures use the same numbers; do not change them without updating those.
- To add a variant: copy one spec, change `file`, `layout` (one of the `LAYOUT` keys), identity fields and panels, set `expectedPages`, append it to `REPORTS`, regenerate, then add its filename and a few expected values to `test/pdfgen.test.js` and `test/pdf.test.js`.
- To add a new layout: add a `LAYOUT` entry plus `header`/`footer`/`line` functions in `RENDERERS`; draw each table cell with its own `c.text(x, y, str)` call so pdf.js sees separate items (one `drawText` with embedded spaces becomes a single cell).
- Keep all people, providers, NPIs, addresses and phone numbers obviously fake; real reports belong only under `private/`.
- Fonts are the standard Helvetica / Helvetica-Bold (proportional, like real reports), Letter 612x792, 8pt body on an 11pt pitch (MyQuest 9pt/12pt).
