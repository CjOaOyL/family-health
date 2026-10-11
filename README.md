# Family Health

A private, browser-only app for keeping a family's lab results in one place.
Drop in a Labcorp or Quest Diagnostics PDF and the app pulls out every field
(who, when, where, which doctor, every result with units, flags, and reference
ranges), tells you how confident it is that nothing was missed, stores it on
your device, and lets you compare results across vendors and over time.

## Privacy model

- Extraction is deterministic code (layout + pattern parsing), not an AI model.
  Your PDF never leaves the browser. The only network request is loading the
  pdf.js library itself from cdnjs; the page's Content-Security-Policy forbids
  every other connection.
- Data lives in your browser's IndexedDB. Use Settings → Export to back it up.
- The optional "assist" feature (not yet enabled) would only ever send redacted
  leftover text fragments, and only if you paste your own API key.
- The folder `private/` is git-ignored. Put real PDFs there for local checks.

## Checking a real PDF locally (no browser, no upload)

```
npm install
node cli/extract.js private/my-labs.pdf            # human summary + unparsed lines
node cli/extract.js private/my-labs.pdf --json     # full structured record
node cli/extract.js private/my-labs.pdf --redacted # safe-to-share diagnostic
```

The `--redacted` output masks names, dates of birth, ids, phones, addresses and
all result values. It shows only the structure of what was and was not parsed,
so you can paste it to a developer to improve the parser without sharing health
data.

## How confidence works

Every line of text in the PDF is either consumed by the parser (with a reason)
or listed as unparsed. Lines that look like results but were not parsed cap
the score below "complete". Required header fields (name, DOB, sex, collection
and report dates, specimen id, ordering provider) cap the score when missing.
Page counts are checked against "Page X of Y". See `docs/SPEC.md` §5.

## Development

```
npm test                 # all unit, fixture, and end-to-end tests
node fixtures/gen/build.js   # regenerate synthetic PDFs
npx -y serve -l 8080 .   # run the site locally
```

Layout and contracts: `docs/SPEC.md`. Rules for contributors (human or agent):
`CLAUDE.md`. All fixtures are synthetic people.

## Deploying

The site is static. Enable GitHub Pages on the `main` branch, root folder.
