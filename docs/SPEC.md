# family-health — Lab Extraction Module Specification (v1)

This document is the contract between modules. Every agent reads it before coding.

## 0. Goals
1. Extract **everything** from a Labcorp or Quest Diagnostics lab-report PDF: patient identity, specimen timing, collection/performing site, ordering provider, every result row (name, value, flag, units, reference range, performing lab), panel grouping, comments/notes.
2. Be **deterministic and private**: pure layout/regex parsing in the browser. No document content leaves the device.
3. Report **confidence and completeness** honestly: per-field status, per-result confidence, and a coverage audit that lists every line of text the parser did not consume so nothing is silently dropped. Target is 100% consumption of result-like lines.
4. Store reports locally (IndexedDB) for a whole family and compare analytes across vendors and time.
5. Deploy as a static site on GitHub Pages (no build step).

## 1. Repository layout
```
index.html                 app shell served by GitHub Pages
app/                       UI modules (ES modules). app/main.js is the entry.
app/styles.css
src/pdf/extractor.js       createExtractor(pdfjsLib) -> extract(bytes, fileName) -> Document
src/pdf/lines.js           buildLines(textItems, pageWidth, pageHeight, pageNumber) -> Line[]   (pure, testable)
src/parse/detect.js        detectVendor(doc) -> { vendor, confidence, evidence }
src/parse/common.js        shared helpers: dates, numbers, ranges, flags, units, name splitting
src/parse/labcorp.js       parseLabcorp(doc) -> ParseResult
src/parse/quest.js         parseQuest(doc) -> ParseResult
src/parse/index.js         parseDocument(doc, opts) -> LabReport (runs detect, parser, audit, analyte mapping)
src/audit/confidence.js    buildAudit(doc, parseResult, report) -> Audit; scoreResult(result, hints) ; resultLike(line); isBoilerplate(line)
src/model/schema.js        emptyReport(), emptyResult(), validateReport(), constants (FLAGS, REQUIRED_FIELDS)
src/model/analytes.js      ANALYTES dictionary + normalizeAnalyte(name, unit) + normalizeUnit() + convertUnit()
src/model/redact.js        redactForSharing(report, doc) -> string  (safe diagnostic export)
src/store/db.js            IndexedDB wrapper: reports, members, files
src/assist/                optional LLM assist (off by default; see §9)
fixtures/labcorp/*.doc.json      synthetic Document fixtures (line model), hand-authored
fixtures/labcorp/*.expected.json expected LabReport subset for each fixture
fixtures/quest/...
fixtures/gen/build.js      generates synthetic PDFs into fixtures/pdf/ with pdf-lib
fixtures/pdf/*.pdf         synthetic PDFs (committed)
cli/extract.js             node cli/extract.js <file.pdf> [--json] [--redacted] [--vendor labcorp|quest]  (user's private local check, no agents)
test/*.test.js             node:test
```

## 2. Document model (output of the PDF layer, input to parsers)
```ts
Document {
  fileName: string
  fileHash: string            // sha256 hex of bytes (Web Crypto / node:crypto)
  pageCount: number
  pages: Page[]
}
Page {
  pageNumber: number          // 1-based
  width: number, height: number   // PDF user units
  lines: Line[]               // top-to-bottom reading order
}
Line {
  id: string                  // `p${pageNumber}l${index}` e.g. "p1l12", unique within document, index 0-based
  page: number
  y: number                   // baseline in PDF units measured from TOP of page (0 = top)
  x0: number, x1: number      // horizontal extent
  text: string                // items joined; gaps >= GAP_CELL are rendered as two spaces
  cells: string[]             // items grouped into column cells split at gaps >= GAP_CELL
  cellX: number[]             // x0 of each cell (same length as cells), for column alignment
  items: TextItem[]           // raw items, sorted by x
}
TextItem { str: string, x: number, y: number, w: number, h: number, font?: string }
```
Line reconstruction rules (`src/pdf/lines.js`):
- Convert pdf.js item transforms to top-origin coordinates: `x = tx[4]`, `y = pageHeight - tx[5]`, `h = |tx[3]| || item.height`, `w = item.width`.
- Group items into a line when `|y_a - y_b| <= max(2, 0.45 * h)`. Sort groups by y, items by x.
- Within a line, gap = `next.x - (prev.x + prev.w)`. Average char width `cw = w / max(1, str.length)`.
  - gap < 0.25*cw → join with "" ; gap < GAP_CELL → join with " " ; else join with "  " and start a new cell.
  - `GAP_CELL = max(6, 1.8 * cw)` in PDF units.
- Drop items whose `str.trim() === ""` before grouping.
- Lines are never merged across pages.
- Fixture `*.doc.json` files are full Document objects. Hand-authored fixtures may omit `items` (use `[]`) but must give `text`, `cells`, `cellX`, `x0`, `x1`, `y`.

## 3. Canonical LabReport (parser output after audit)
All dates are ISO strings. Dates with time: `YYYY-MM-DDTHH:mm` with tz text preserved separately. Date-only: `YYYY-MM-DD`. Unknown → `null`, never `""`.
```ts
LabReport {
  id: string                       // fileHash
  schemaVersion: 1
  source: { vendor: 'labcorp'|'quest'|'unknown', vendorConfidence: number, fileName, fileHash, pageCount,
            parserVersion: string, parsedAt: ISO, reportStatus: 'final'|'partial'|'corrected'|'preliminary'|null }
  patient: { fullName: string|null, lastName, firstName, middleName, dob: 'YYYY-MM-DD'|null,
             sex: 'M'|'F'|'U'|null, ageAtCollection: number|null, patientId: string|null,
             phone: string|null, address: string|null, memberId: string|null /* set by app */ }
  specimen: { specimenId: string|null, requisition: string|null, labRef: string|null,
              collectedAt: ISO|null, collectedTz: string|null, receivedAt, reportedAt, enteredAt,
              fasting: boolean|null, collectionSite: { name, address, code }|null }
  provider: { orderingName: string|null, referringName, npi, accountNumber, accountName, address, phone, fax }
  performingLabs: Array<{ code: string|null /* null when the report names a site without a code, e.g. MyQuest */, name: string|null, address: string|null, director: string|null, clia: string|null, phone: string|null }>
  panels: Array<{ name: string, resultIds: string[], page: number }>
  results: Result[]
  comments: Array<{ text: string, page: number, lineIds: string[], attachedTo: resultId|null }>
  audit: Audit
}
Result {
  id: string                       // `r${n}` sequential in document order, starting r1
  panel: string|null
  name: string                     // as printed
  canonicalId: string|null         // from analytes.js, e.g. 'hba1c'
  loinc: string|null
  valueText: string                // as printed, e.g. "<5", "NEGATIVE", "6.2"
  value: number|null               // numeric if parsable (strip <, >, commas; "<5" → 5 with valueQualifier '<')
  valueQualifier: '<'|'>'|'<='|'>='|null
  unit: string|null                // as printed
  canonicalUnit: string|null
  canonicalValue: number|null      // value converted to canonicalUnit when a conversion exists, else value
  flag: 'H'|'L'|'HH'|'LL'|'A'|'C'|null     // H high, L low, HH/LL critical, A abnormal, C critical
  referenceRange: { text: string|null, low: number|null, high: number|null, kind: 'range'|'lt'|'gt'|'le'|'ge'|'text'|null }
  performingLabCode: string|null
  comment: string|null
  page: number
  lineIds: string[]
  confidence: number               // 0..1 per §5
  fieldStatus: { value: FieldStatus, unit: FieldStatus, range: FieldStatus, flag: FieldStatus }
}
FieldStatus = 'found'|'missing'|'uncertain'|'na'
```
`src/model/schema.js` already exists with `emptyReport()`, `emptyResult(id)`, `getPath()`, `validateReport()`, `REQUIRED_FIELDS`, `IMPORTANT_FIELDS`, `FLAGS`. Use it.

## 4. Parser interface
```ts
ParseResult {
  report: Partial<LabReport>       // everything except audit, canonicalId/loinc/canonicalUnit (filled by index.js)
  consumed: Map<lineId, string>    // lineId → reason tag (e.g. 'header','patient.dob','result:r12','comment','footer','pageno','blank')
  notes: string[]                  // parser-level warnings, human readable
  fieldEvidence: Record<fieldPath, lineId[]>   // e.g. 'patient.dob' → ['p1l4']
  fieldStatus?: Record<fieldPath, FieldStatus> // optional: mark 'uncertain' when pages disagree (buildAudit honors it)
}
// Optional per-result hint for the audit: `result.hints = { wrapped?: boolean, misaligned?: boolean }`.
// index.js feeds it to scoreResult() (−0.1 each) and deletes it from the final report. If a parser sets
// result.confidence itself, index.js keeps min(parser confidence, scoreResult(result)).
parseLabcorp(doc: Document): ParseResult
parseQuest(doc: Document): ParseResult
detectVendor(doc): { vendor: 'labcorp'|'quest'|'unknown', confidence: number, evidence: string[] }
parseDocument(doc, { vendor?: string } = {}): LabReport    // never throws for a readable doc; unknown vendor → generic best-effort + low confidence
```
Rules for parsers:
- Parsers must consume every line they understand, including boilerplate (headers, footers, "Page x of y", legal disclaimers), tagging each with a reason. Unconsumed lines are the audit's main signal.
- Each page may repeat the header block; parse it on every page and reconcile (first non-null wins; conflicts → note + 'uncertain').
- Result rows: use `cells` and column x positions learned from the table header line ("TESTS … RESULT … FLAG … UNITS … REFERENCE INTERVAL … LAB" for Labcorp; "Test Name … In Range … Out of Range … Reference Range … Lab" for Quest). Fall back to regex on `text` when header is missing.
- A result name wrapped onto two lines (continuation line with no value, directly above/below) must be merged.
- Lines under a result that are not result-shaped (e.g. "Please Note:", "Comment:", "Desirable range <200 mg/dL") attach as that result's comment.
- Never fabricate: if a value or range is not present, leave null and mark 'missing'.
- Handle values: numbers with commas, decimals, leading `<`/`>`, "NEGATIVE", "POSITIVE", "Not Estab.", "See Note", "N/A", "ABSENT", "NORMAL", "DETECTED", "NOT DETECTED", ratios like "1:40", text with units inline.
- Handle ranges: "3.4-10.8", "0.0 - 5.0", "<200", ">39", ">=60", "Not Estab.", "Negative", "6.0-8.5 (see note)", "70-99 (Fasting)".
- Flags: Labcorp prints "High"/"Low"/"Critical"/"Abnormal"; Quest prints "H"/"L"/"HH"/"LL"/"A" (sometimes "*"). Normalize per §3.

## 5. Audit and confidence (`src/audit/confidence.js`)
```ts
Audit {
  overall: number                   // 0..1
  label: 'complete'|'review'|'incomplete'   // >=0.95, >=0.80, else
  fields: Record<fieldPath, { status: FieldStatus, confidence: number, evidence: lineId[] }>
  coverage: { totalLines, consumedLines, unconsumed: Array<{ lineId, page, text, resultLike: boolean }>, resultLikeUnconsumed: number }
  pages: { declared: number|null, seen: number, complete: boolean }     // from "Page x of y"
  results: { count: number, fullyParsed: number, withIssues: number }
  warnings: string[]
}
```
- `resultLike(line)` heuristic: line has ≥1 alphabetic token and (a numeric token followed by a unit-ish token, or a flag token, or a range pattern) and is not a known boilerplate pattern. Keep the regex in `confidence.js` and export it for tests.
- Per-result confidence: start 1.0; −0.25 missing unit when value numeric; −0.25 missing range when value numeric (unless range kind 'text' is clearly N/A); −0.4 value missing; −0.1 name wrapped/merged; −0.1 column misaligned (value not under RESULT column). Clamp 0..1.
- Overall = 0.40 × (required found fraction, uncertain counts 0.5) + 0.15 × (important found fraction) + 0.30 × (1 − resultLikeUnconsumed / max(1, results.count + resultLikeUnconsumed)) + 0.15 × (pages complete ? 1 : 0.5 × seen/declared).
- An IMPORTANT (optional) field whose label never appears in the document gets status 'na' and counts as found (it is not a miss). Labels are in `OPTIONAL_FIELD_LABELS` in confidence.js.
- A directionless critical flag ('C') is resolved to HH/LL by index.js when the numeric range shows the side.
- Any required field missing caps overall at 0.90. Any resultLikeUnconsumed > 0 caps overall at 0.94 (so 'complete' is only possible when every result-like line was consumed).
- warnings[] gets a plain-English line for each cap applied and each parser note.

## 6. Vendor layout notes (public knowledge; synthetic fixtures must mimic these)
### Labcorp (classic patient report)
- Top: "Labcorp" wordmark; patient name line "LAST, FIRST M" (often uppercase); "Patient Report" / "Final Report" / "Partial Report".
- Three detail columns on page 1 (and repeated on later pages):
  - Patient Details: `DOB: MM/DD/YYYY`, `Age: 45`, `Gender: M`, `Patient ID: 123456789` (sometimes `Patient ID:` blank), `Phone:`.
  - Specimen Details: `Date collected: MM/DD/YYYY HHMM Local`, `Date received: MM/DD/YYYY`, `Date entered: MM/DD/YYYY`, `Date reported: MM/DD/YYYY HHMM ET`, `Specimen ID: 063-123-4567-0` (also printed as `Specimen Number`), `Fasting: Yes/No` (sometimes).
  - Physician Details: `Ordering: J SMITH`, `Referring:`, `ID: 12345`, `NPI: 1234567890`.
  - Account block: `Account Number: 12345678`, account name/address, `Phone`, `Fax`, `Rte:`.
- "Ordered Items" line listing panel names separated by `;`.
- Table header: `TESTS   RESULT   FLAG   UNITS   REFERENCE INTERVAL   LAB`.
- Panel name on its own line (e.g. `CBC With Differential/Platelet`, `Comp. Metabolic Panel (14)`, `Lipid Panel`, `Hemoglobin A1c`). Rows indented beneath. Row example: `Cholesterol, Total   210   High   mg/dL   100-199   01`. Units like `x10E3/uL`, `x10E6/uL`, `mg/dL`, `%`, `uIU/mL`, `ng/mL`, `mL/min/1.73`.
- Notes: `Please Note:` / `Comment:` / `Ref: ...` lines; A1c has multi-line "Prediabetes: 5.7 - 6.4 ..." text; eGFR note; "Desirable range <100 mg/dL for primary prevention goal" etc.
- Footer: performing-lab legend `01 BN  LabCorp Burlington  1447 York Court, Burlington, NC 272153361  Dir: William F Hancock, MD  Phone: 800-762-4344`; `Date Issued: MM/DD/YY HHMM ET`, `FINAL REPORT`, `Page 1 of 3`, `(c) 1995-2025 Laboratory Corporation of America Holdings`.
- Newer portal variant (2023+): `Patient:`/`Date of Birth:`/`Sex:`/`Specimen #:`/`Collected:`/`Received:`/`Reported:`/`Ordering Physician:`/`Account:` and headers `Test Name  Result  Flag  Units  Reference Interval  Lab`. Parsers must accept both label sets.

### Quest Diagnostics (classic report)
- Top right: "Quest Diagnostics"; status word `FINAL` / `PARTIAL` / `CORRECTED`; sometimes `Client Service: 1.866.697.8378`.
- Three blocks: `Patient Information` (`LAST, FIRST M`, `DOB: MM/DD/YYYY  AGE: 45`, `Gender: M` or `Sex: M`, `Patient ID: 987654`, `Phone:`), `Specimen Information` (`Specimen: AB123456C`, `Requisition: 0012345`, `Lab Ref #: 1234567`, `Collected: MM/DD/YYYY / HH:MM EDT`, `Received: MM/DD/YYYY / HH:MM EDT`, `Reported: MM/DD/YYYY / HH:MM EDT`, `Fasting: Y`), `Client Information` or `Ordering Physician` (`Client #: 12345678`, `DR. JANE DOE` or `DOE, JANE`, address lines, `NPI`).
- Table header: `Test Name   In Range   Out of Range   Reference Range   Lab`.
- Panel name in uppercase on its own line (`CBC (INCLUDES DIFF/PLT)`, `COMPREHENSIVE METABOLIC PANEL`, `LIPID PANEL`, `HEMOGLOBIN A1c`). Row example in-range: `CHOLESTEROL, TOTAL   185   <200 mg/dL   EZ`; out of range: `CHOLESTEROL, TOTAL      210 H   <200 mg/dL   EZ`. Units are printed INSIDE the reference range cell (`3.8-10.8 Thousand/uL`, `Not Estab. ng/mL`, `mg/dL` alone when range absent).
- Comment lines beneath rows, often with "." leaders; `Reference Range:` text blocks for A1c, eGFR, vitamin D; "Please note:" blocks.
- Footer: `PERFORMING SITE:` legend `EZ  Quest Diagnostics Nichols Institute, 33608 Ortega Hwy, San Juan Capistrano, CA 92675-2042  Laboratory Director: ..., CLIA: 05D0643352`; also `PR Quest Diagnostics-Teterboro ...`. `Page 1 of 4`. `CLIENT SERVICES:`.
- MyQuest portal variant: `Results for FIRST LAST`, `Collected on MM/DD/YYYY`, `Ordered by`, results as cards `Test  Your Value  Reference Range  Flag`. Parsers must accept both.

## 7. Analyte dictionary (`src/model/analytes.js`)
```ts
ANALYTES: Array<{ id, display, loinc: string|null, canonicalUnit, aliases: string[], conversions?: Record<unit, factor>, group }>
normalizeAnalyte(name: string, unit?: string): { id, loinc, canonicalUnit, display } | null   // case/punct-insensitive alias match, then fuzzy on tokens
normalizeUnit(unit: string): string      // 'Thousand/uL' | 'x10E3/uL' | 'K/uL' → '10^3/uL'; 'Million/uL' | 'x10E6/uL' → '10^6/uL'
convertUnit(value, fromUnit, toUnit, analyteId): number|null
```
Cover at least: CBC with differential (absolute + %), CMP (14), lipid panel (+ VLDL, non-HDL, ratios), A1c, eAG, TSH/T4/T3/free T4/free T3, vitamin D 25-OH, B12, folate, ferritin, iron/TIBC/UIBC/%sat, magnesium, phosphorus, uric acid, CRP/hs-CRP, ESR, PSA, insulin, cortisol, testosterone (total/free), estradiol, LH/FSH, prolactin, urinalysis components, hepatitis/HIV screens (text results), eGFR, BUN/creat ratio, lipoprotein(a), ApoB, homocysteine. ~120 entries.

## 8. App (`app/`, `index.html`)
Views (hash router): **Import** (drop/choose PDF → parse in browser → Review), **Review** (header fields with status chips, result table with per-row confidence, unconsumed lines panel, page completeness, inline edit of any field creates an override saved with the report; Save assigns to a family member matched by name+DOB or lets user pick), **Family** (members list, counts), **Results** (per member, filter by analyte/vendor/date, table), **Compare** (pick member + analyte → timeline chart with vendor as series, reference band from latest ranges; or pick two reports side-by-side by canonicalId), **Settings** (export/import JSON backup, clear data, optional assist key, redacted diagnostic export, parser version + re-parse stored PDFs).
- Charts are inline SVG, no chart library. Vendor color is consistent across the app.
- IndexedDB stores: `reports` (LabReport + overrides), `members` ({id, name, dob, sex}), `files` (original PDF bytes, toggle default ON) so the user can re-parse after parser updates.
- Everything must work on phone width.

## 9. Optional LLM assist (`src/assist/`) — phase 2, scaffold only
Interface `assistUnparsed({ fragments: string[], vendor }) → Array<{ fragment, parsed: Partial<Result>|null }>`. Fragments are run through `redact.js` first (digits in ids/phones/dob masked, patient/provider names replaced). Off unless the user pastes a key in Settings. Never called automatically.

## 10. Testing
- `test/lines.test.js`: line reconstruction from synthetic text items (gap → cell rules).
- `test/<vendor>.test.js`: each `fixtures/<vendor>/*.doc.json` parses to deep-equal `*.expected.json` on the fields present in expected (expected may omit lineIds/evidence), and audit.coverage.resultLikeUnconsumed === 0, audit.overall >= 0.95 for "clean" fixtures.
- `test/pdf.test.js`: generated PDFs in `fixtures/pdf/` run through pdfjs-dist (legacy build) → extractor → parseDocument; assert vendor, result count, required fields.
- `test/analytes.test.js`, `test/confidence.test.js`.
- Fixtures must be realistic: multi-page, repeated headers, wrapped names, comments, text results, `<`/`>` values, missing units, critical flags, two performing labs.

## 11. Versioning
`PARSER_VERSION = '1.0.0'` exported from `src/parse/index.js`. Bump on any parser change; the app shows it and offers re-parse of stored PDFs when it changes.
