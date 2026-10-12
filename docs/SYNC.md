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
- `applySyncChanges` (what the engine calls with the merge result) never overwrites a record whose stored
  `updatedAt` is newer than the incoming record or tombstone — that is an edit the user made while the sync was
  running. The record is kept (and no tombstone is written beside it); the next sync pushes it.
- `importAll` with merge: a backup tombstone for an id that exists locally deletes the record (and its PDF) when
  the record is not newer than `deletedAt`; otherwise the tombstone is dropped. A tombstone is never written
  beside a live record.
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
backoff; while backing off the status repeats what Drive said (e.g. a scope or quota message, not always "rate
limit") plus the retry time; offline → skipped quietly. Errors are returned as status, never thrown to the UI.

### Duplicate snapshots (two devices doing their first sync at the same moment)
Drive allows several files with the same name, so a first-sync race leaves two `family-health-sync.json` (and
possibly two `pdf-<hash>.pdf`) files. The listing requests `createdTime` and groups entries by name: the
*primary* is the oldest `createdTime`, ties broken by the smallest id; the rest are *extras*. Every readable
extra is merged into the remote side before the local merge (so nothing in any copy is lost), the union is
uploaded to the primary, then the extras are deleted. Right after a fresh create the engine re-lists once and
runs the same reconciliation, so the race is healed on the run that caused it, on both devices (both pick the
same primary; the second delete of an extra is a harmless 404). Duplicate PDFs: keep the primary, delete the
rest. `snapshotDriveId` always ends up pointing at the primary. Result field `duplicatesRemoved` counts both.

### Corrupt snapshot
`readSnapshot` wraps download + parse. An empty file (size 0), non-JSON, non-object, or an unknown/older
`formatVersion` throws `SyncError(code: 'corrupt', retryable: false)`. The engine then renames the broken file
to `family-health-sync.corrupt-<timestamp>.json` (metadata PATCH, bytes kept for forensics), recreates the
snapshot from this device on the same run, and returns a successful result whose one-line message / `notice`
is "The Drive copy was unreadable and has been replaced from this device; the old file was kept as …" (the
Settings status line shows it; the pill tooltip carries it). A `formatVersion` *newer* than ours is different:
`code: 'newer'`, nothing is written, and the status says to update the app on this device.

## App wiring (`app/sync.js`)
Triggers: app start (when connected), after Save, member add (from Review) / rename / merge / delete, report
delete, backup import, re-parse, `visibilitychange` to visible after > 2 min, and the Settings "Sync now"
button. Bursts are debounced (1.5 s). The nav pill shows not connected / syncing / synced N min ago / offline /
error, and links to Settings.
- Settings "Clear all data" goes through `disconnect({ eraseLocal: true })`, never `db.clearAll()` directly, so
  the connected flag, the in-memory token and the pill are reset together with the data (otherwise the next
  trigger would re-pull everything from Drive).
- `main.js` re-routes Family / Results / Compare on `SYNC_EVENT`; Review and Settings are not re-rendered (they
  may hold unsaved input such as a half-typed Client ID). Settings keeps its status line current via
  `onSyncStatus`.
- Connect: a `popup_closed` within ~3 s of a `select_account` prompt is reported with a hint to check the
  Client ID and the Authorized JavaScript origin — Google shows its own error page for those and GIS only
  reports the popup closing.

## Content-Security-Policy (index.html)
`script-src 'self' cdnjs.cloudflare.com accounts.google.com`, `connect-src www.googleapis.com
oauth2.googleapis.com`, `frame-src accounts.google.com`, everything else `'none'`/`'self'`. No other host can
ever receive document data.

Known, harmless console error: when the GIS script loads it injects a `<style>` element (its own button CSS)
and the browser logs "Applying inline style violates the following Content Security Policy directive
'style-src 'self''" with a sha256 hash. Nothing of ours needs that stylesheet (we never render the Google
button; the token popup is a separate window), so sign-in and sync work regardless. The hash does silence the
error when added to `style-src` (verified with `'sha256-RU4sU0AaS8IBGZx8XrGt/pa9A5SLA3dQszGeqT5L3Kw='` on
2026-10-12), but `gsi/client` is unversioned and its minified CSS changes with Google's releases, so the hash
would go stale silently. The CSP is therefore left as is; `'unsafe-inline'` is not an option.

## Tests
`test/merge.test.js` (rules above), `test/sync.test.js` (fake Drive + fake db: first upload, second device
pull, concurrent edits, delete propagation, PDF uploaded once, 401 retry, 403 message in back-off, first-sync
race → one snapshot, pre-existing duplicates folded, garbage / empty / newer-format snapshots, edit during
sync). The same file carries a minimal in-memory IndexedDB so `applySyncChanges` and `importAll` in
`src/store/db.js` are tested for real.
