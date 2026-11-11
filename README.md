# Session manager for DeepSeek Harness

A local bundle for the Harness Web GUI with four capabilities:

1. **Session alerts** — an in-page popup and a short sound when a session needs
   approval, needs an answer, enters plan review, finishes, or errors. A bell
   button at the sidebar foot mutes the sound; **Shift+click** it to preview a
   popup and sound.
2. **Delete archived sessions** — the “…” menu of an archived session gains a
   *Delete archived session…* row. It always shows an irreversible-action
   dialog first, then removes the session log and its derived data. A session
   still held by the running DSH process is scheduled instead: the Host records
   it and completes the deletion automatically at the next start.
3. **Batch cleanup** — a trash button at the sidebar foot lists every archived
   session, with search, select-all, and per-session results. Deletable sessions
   are removed immediately; sessions still held by the process are scheduled for
   the next DSH start.
4. **Leftover-file cleanup** — a broom button at the sidebar foot scans the
   sessions root for provable leftovers: session directories that no workspace,
   archive, pin, pending deletion, or known subagent refers to, plus
   `.sm-delete-…` tombstones and empty directories. Each row has a checkbox
   (everything is selected initially) and names its kind and path;
   **打开位置 / Open location** reveals it in Explorer, and **Move to Recycle
   Bin** removes the selected rows.

## What is deleted, what is kept

Deleted (permanently, or to the Recycle Bin when that option is ticked):

- the session's durable log under `~/.dsh/sessions/…/session-<id>/`, including
  every historical format generation left behind by a migration (the legacy
  version-zero `session.jsonl` name included)
- the durable logs of its descendant subagent sessions, discovered from the
  persistence listing by their `origin: "subagent"` header and parent id
- their projection-cache rows (`session_projcache`)
- their archive/pin/workspace listing entries

Kept:

- every file in the workspace, including generated documents
- attachments — `~/.dsh/attachments/v1/objects` is content-addressed and shared
  across sessions, so no attachment can be attributed to one deleted session;
  attachments are therefore excluded from deletion and from leftover cleanup
- scheduled tasks and their history
- jobs, deliverables, and everything outside the session log directory

Both delete dialogs put a compact **Recycle Bin** checkbox at the left end of
the footer, well away from the session list and the Cancel/Delete buttons; its
tooltip carries the full explanation. When
ticked, each staged log is moved to the Windows Recycle Bin instead of being
unlinked; the leftover-file cleanup always tries the Recycle Bin first. If the Recycle Bin is unavailable, the operation degrades to
a permanent delete and reports that in the warnings. Moving to the Recycle Bin
uses `powershell.exe` with `Microsoft.VisualBasic.FileIO.FileSystem` (Windows
only); the Host plugin never imports Electron.

The confirmation dialog says this explicitly. The Host route re-checks the
archive set, liveness (the session and every subagent it is about to remove),
running work, and the exact log paths; a tampered or stale client cannot
delete an arbitrary path.

## Sessions held by the running process

DSH keeps a session's agent resident for the lifetime of the Host process once
the session has been opened. Archiving it does not release it, and a page
refresh does not help. When an idle-but-live session is deleted, the Host
writes the id to `.session-manager-pending-delete.json` beside the sessions
root and answers `202 restart-required`. The Client shows a sticky “deletion
scheduled” popup. On the next start,
the Host replays the queue before anything else and removes the log while the
session is still not live. A session with a running turn is refused instead
(`409 session-active`): stop the turn first.

Batch cleanup uses the same rule per session, so one batch can mix immediate
deletions and scheduled ones; the result view lists both counts.

## Install (only after review)

This bundle is intentionally **not installed during development**. After the
code and `TESTING.md` have been reviewed:

```text
plugin_manager install_bundle target=<absolute path to this directory>
```

Then refresh the Web GUI once so the Client half enters the page's module
graph. Rollback:

```text
plugin_manager remove_bundle @local/session-manager
```

or disable the `session-manager` row in the Plugin Manager, then refresh.
Rollback never deletes session data.

## Usage

| Action | Result |
| --- | --- |
| Approval / question / plan review on any session | Sticky popup |
| Session running → idle (while you are not looking at it) | Popup + sound, auto-dismisses; subagent completions stay quiet |
| Session error event | Error popup + sound |
| Click anywhere on a popup with a session | Opens that session and dismisses the popup; Enter/Space works when the card is focused |
| Bell at the sidebar foot | Toggle sound; Shift+click previews a test alert |
| Trash at the sidebar foot | Open the batch cleanup dialog for archived sessions |
| Broom at the sidebar foot | Scan leftover session files; open a location or move all to the Recycle Bin |
| Archived session → “…” → *Delete archived session…* | Confirmation (with the Recycle Bin option), then delete or schedule |
| Archived session with subagent history | Descendant subagent logs are deleted with it |

Batch cleanup: search by title or id, select rows (or all visible rows), then
**Delete (n)**. The result view reports deleted, scheduled, skipped, and failed
sessions. Ticking the footer **Recycle Bin** box applies to the whole batch.

Leftover cleanup: the list is a scan of the sessions root; it never includes a
registered, archived, pinned, pending-deletion, or known-subagent session. Each
row has a checkbox (select-all is provided and everything starts selected),
keeps its kind label (session directory / tombstone / empty directory) and full
path, and **打开位置 / Open location** reveals it in Explorer without changing
anything. A scheduled session is still listed as archived until the next
DSH start; the sticky popup names the restart requirement.

Preferences (`muted`) are stored in `localStorage['dsh.session-manager.v1']`.
The bundle declares `engines.dsh: ">=0.2.2-rc.1 <0.3.0"`, so the Plugin
Manager refuses to install it on an incompatible host.

## Safety and failure behaviour

- The delete, archived-list, cleanup, and open-path routes are registered on
  the bare `webServer` and every request is first checked by
  `ctx.connection.requestRejection()` (same-origin / authenticated-cookie
  fence), following the shipped `open-in-app` pattern.
- JSON body is capped at 16 KiB. A single delete takes `sessionId` (a
  `session-<uuid>`); a batch takes a deduped `sessionIds` array of at most 100
  entries. `confirm` must be `true` in both forms. A cleanup request takes at
  most 200 deduped paths plus `confirm: true`; an open-path request takes one
  path.
- Cleanup paths must be absolute, free of raw `..` segments, strictly inside
  `ctx.sessionPersistence.root`, and still resolve (via `realpath`) inside that
  root. Every survivor is re-classified against the current registry, archive,
  pin, queue, and subagent listing immediately before removal (TOCTOU fence);
  a path that became live, non-empty, or no longer a provable leftover fails
  item by item while the rest proceed.
- The leftover scan refuses to guess: if the workspace registry or the
  pending-delete store cannot be read, the scan fails closed instead of
  reporting directories. A backend without `sessionPersistence.list()` skips
  raw subagent directories and says so in `warnings`.
- Open-location is POST-only and Windows-only; the Host encodes one file URI
  and passes it as a single `explorer.exe` argument (files use the `/select,`
  reveal form). Explorer exit code 1 is treated as success because Explorer
  delegates to an existing desktop process and exits 1 in that case.
- Recycle Bin moves run through one `powershell.exe -EncodedCommand` per chunk
  of at most 40 paths. Paths are embedded as single-quoted PowerShell literals
  with quote doubling. An unavailable Recycle Bin or a refused item falls back
  to permanent removal with a warning; a permanent-removal failure is reported
  per item.
- Deletion is serialized in the Host plugin; cleanup requests share the same
  queue, so a scan-and-remove cannot race an ongoing delete. A running session or subagent, a
  non-archived session, a non-JSONL backend, or an unexpected path is refused
  before anything is written. An idle-but-live session is scheduled instead.
- The pending queue is a small atomic JSON file next to the sessions root
  (temporary file + rename, with Windows lock retries). It is replayed at
  startup; entries that became unarchived are dropped, entries that are live
  again are kept for the following start, and other failures stay queued.
- Every log file is first renamed to a non-canonical tombstone name. If any
  rename fails, all staged renames are rolled back and nothing is deleted. A
  tombstone that cannot be removed is left under a non-log name (the backend
  never lists it again) and reported as a warning; the rest of the cleanup
  continues.
- Cache and registry cleanup are fail-soft and reported as `warnings`. The
  single-session dialog stays open only when the log staging itself fails, so a
  retry is possible. Batch requests return per-session `deleted` / `scheduled`
  / `skipped` / `failed` results in one 200 response.
- Descendant subagent logs are discovered through `sessionPersistence.list()`.
  A backend that does not expose `list()` (older than this bundle's
  `engines.dsh` floor) cannot discover them; the parent is deleted, the child
  logs are kept, and the response carries a warning.
- The Client plugin gives each slot entry an error boundary and guards every
  event callback, so a failure degrades this plugin only.

## Development

```bash
node --check index.js && node --check host-lib.js && node --check client.js
node --test test/*.test.mjs
```

Files:

```
index.js        Host half: delete/archived/cleanup/open-path routes, pending queue,
                Recycle Bin and Explorer process adapters
host-lib.js     pure validation/path/classification/PowerShell helpers (unit-tested)
client.js       alerts, toasts, delete + batch + cleanup dialogs, footer actions
cordis.patch.yml
locale/         Plugin Manager display metadata
icon.svg
README.md
TESTING.md      phase A results + phase B manual acceptance + rollback
test/           Node built-in tests, no Harness required
```
