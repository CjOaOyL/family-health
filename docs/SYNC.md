# Google Drive sync — technical notes

User-facing setup lives in `GOOGLE-DRIVE-SETUP.md`. This file is for developers and agents.

## What goes where
- Auth: Google Identity Services token client (`https://accounts.google.com/gsi/client`), scope
  `https://www.googleapis.com/auth/drive.appdata` only. The script is loaded on demand (Connect click, or at
  start when this device connected earlier). Access tokens live in memory only; expiry → silent
  `requestAccessToken({ prompt: '' })`, then interactive on failure. Disconnect revokes the token.
- Client ID: `app/config.js` (`GOOGLE_CLIENT_ID`, committed; a client id is not a secret) or the `googleClientId`
  key in the `settings` store (user override). The override is excluded from backup export.
- Drive contents, all in `appDataFolder` (hidden from the Drive UI, readable only by this client id):
  - `family-health-sync.json` — snapshot `{ formatVersion: 1, updatedAt, members: {id→member},
    reports: {id→record}, tombstones: {id→{kind:'member'|'report', deletedAt}} }`. Records are the IndexedDB
    record shape (id, memberId, overrides, orphanedOverrides, report, savedAt, updatedAt). No PDF bytes.
  - `pdf-<fileHash>.pdf` — one per stored PDF (only when "keep original PDFs" is on).

## Local changes (IndexedDB v2, `src/store/db.js`)
- Migration v1→v2 adds the `tombstones` store, stamps `updatedAt` on every member and report.
- Every member/report write stamps `updatedAt` and removes a same-id tombstone (resurrect).
- Every delete (report, member, merge, clear, import-with-merge) leaves a tombstone.
- Sync metadata (`lastSyncAt`, `snapshotDriveId`, `deviceId`, connected flag) is in `settings`.

## Merge (`src/sync/merge.js`, pure)
Union of local and remote by id, ids processed in sorted order for determinism.
- Record vs record: newer `updatedAt` wins (ties resolved deterministically).
- Tombstone vs record: tombstone wins when `deletedAt >= updatedAt`, otherwise the record is resurrected and the
  tombstone dropped.
- Output: merged snapshot, `localChanges` to apply to IndexedDB (puts, removes, tombstones), `remoteChanged`
  (upload needed), and a summary (pulled/pushed/deleted/resurrected counts).

## Engine (`src/sync/drive.js`, DOM-free, injected fetch + token getter)
`sync()` = token → list appDataFolder → download snapshot (if any) → build local snapshot → merge → apply local
changes → upload snapshot when changed (media update of the existing file id, multipart create the first time) →
upload PDFs not yet in Drive (by name) → record `lastSyncAt`. `ensureFileBytes(fileHash)` downloads a PDF on
demand for re-parse and the redacted diagnostic. 401 → one token refresh and retry; 403/429 → exponential
backoff with a status message; offline → skipped quietly. Errors are returned as status, never thrown to the UI.

## App wiring (`app/sync.js`)
Triggers: app start (when connected), after Save, member rename/merge/delete, report delete, backup import,
re-parse, `visibilitychange` to visible after > 2 min, and the Settings "Sync now" button. Bursts are debounced
(1.5 s). The nav pill shows not connected / syncing / synced N min ago / offline / error, and links to Settings.

## Content-Security-Policy (index.html)
`script-src 'self' cdnjs.cloudflare.com accounts.google.com`, `connect-src www.googleapis.com
oauth2.googleapis.com`, `frame-src accounts.google.com`, everything else `'none'`/`'self'`. No other host can
ever receive document data.

## Tests
`test/merge.test.js` (rules above), `test/sync.test.js` (fake Drive + fake db: first upload, second device
pull, concurrent edits, delete propagation, PDF uploaded once, 401 retry).
