# family-health — rules for any agent working in this repo

This is a personal/family health app. The first module extracts lab results from Labcorp and Quest PDFs.

## Privacy rules (non-negotiable)
- The extraction tool is deterministic (regex/layout parsing). It must never send document content to any network service by default.
- Never open, read, copy, or quote any file under `private/`. That folder holds the family's real lab PDFs and is gitignored. Agents work only with synthetic fixtures under `fixtures/`.
- Never add analytics, telemetry, remote fonts that carry query data, or any fetch() that includes document text. The only hosts the page may contact are cdnjs.cloudflare.com (pdf.js), accounts.google.com (sign-in) and www.googleapis.com / oauth2.googleapis.com (the user's own Drive app folder, only after the user connects sync). The CSP in index.html enforces this; do not widen it.
- Drive sync (docs/SYNC.md) stores data only in `appDataFolder` under the user's own account. Never persist access tokens; never add scopes beyond drive.appdata.
- The optional LLM assist in `src/assist/` is off by default, requires the user to paste their own key, and may only send redacted unconsumed fragments. Identity fields are never sent.
- Do not log extracted values to the console in production paths.

## Engineering rules
- Plain ES modules, no bundler, no framework. Must run as a static site on GitHub Pages from the repo root (`index.html`).
- `src/` modules must be isomorphic: no Node-only imports. pdf.js is injected (`createExtractor(pdfjsLib)`), never imported inside `src/`.
- Tests use `node:test` (`npm test`). Fixtures are synthetic JSON documents and synthetic PDFs generated with pdf-lib.
- Read `docs/SPEC.md` before writing code. It is the contract between modules. If you must change the contract, edit SPEC.md in the same change and say so in your report.
- Pin CDN versions exactly (pdf.js 4.10.38).
