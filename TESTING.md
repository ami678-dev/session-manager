# Testing and staged rollout

The bundle is installed in the desktop profile. Development is verified in two
layers: offline Node tests (no Host required), and an isolated end-to-end run
that starts a real DSH Host with `DSH_HOME` pointed at a temporary profile and
drives the Web GUI through headless Chrome's CDP endpoint. The live profile is
only used for the final install/refresh check.

## Phase A — offline checks (already run, no profile changes)

Working directory: `C:\Users\THINKPAD\Documents\deepseek-harness\default-workspace\session-manager`

```powershell
# 1. Syntax
node --check index.js
node --check host-lib.js
node --check client.js

# 2. Unit tests (fake Host/Client and a temp directory; no real sessions touched)
node --test test/*.test.mjs
```

Result at the time of writing: **81 passed, 0 failed** (2026-11-11).

What the tests cover:

- `host-lib.js`
  - session-id shape; `..`/slash/empty values rejected
  - single delete body: valid confirmation accepted; missing `confirm`,
    non-boolean `confirm`, non-object body, malformed JSON, and invalid ids
    refused
  - batch delete body: up to 100 ids accepted and deduped; empty, oversized,
    unconfirmed, non-array, and invalid entries refused
  - bounded body reader: normal body returned, oversized body refused
  - log path: accepted only for canonical generation names — the legacy
    version-zero `session.jsonl` and later `session.v<digits>.jsonl[.zstd]`
    files under a `--project--` (or `_no-cwd`) directory; wrong file name,
    non-canonical `session.v0`/leading-zero names, wrong session directory,
    relative path, root escape, and a non-absolute root are refused
  - stored subagent ids (bare UUIDs) validate through the internal path
    helper while the public request id stays `session-<uuid>`
  - schedule counting: only `target.kind === 'session'` and
    `involvedSessionIds` hits count; a task matching several removed ids is
    counted once
  - pending-delete store: versioned parse, dedupe, invalid-id drop, malformed
    or unknown-version refusal, idempotent add, removal, and the optional
    `moveToTrash` flag (old stores default to `false`)
  - `moveToTrash` validation on single and batch bodies: absent/false accepted
    as permanent, `true` accepted, non-boolean refused
  - cleanup body: confirmed path lists accepted and deduped; empty, unconfirmed,
    non-string, and over-200 lists refused; open-path body: exactly one
    non-empty path
  - cleanup path safety: absolute path strictly inside the root, raw `..`
    segment refused, the root itself refused, relative root refused
  - `isEncodedProjectKey` and `classifySessionDir`: registered ids, subagent
    ids of a known parent, orphan bare UUIDs, unknown directory names
  - Recycle Bin helpers: script embeds single-quoted literals with quote
    doubling, picks DeleteFile/DeleteDirectory, round-trips through UTF-16LE
    base64, and parses MOVED/MISSING/FAILED lines (MISSING counts as moved)
- `index.js` routes (end-to-end with a temporary directory and fake services)
  - registers `/session-manager/api/delete`, `/session-manager/api/archived`,
    `/session-manager/api/cleanup`, and `/session-manager/api/open-path`
  - a single delete with `moveToTrash: true` calls the recycle seam, decodes the
    embedded tombstone path, and still tidies the empty session directory; a
    simulated recycle failure degrades to permanent removal with a warning
  - batch `moveToTrash` reaches both the immediate delete and the queued entry;
    startup replay honors the queued flag
  - cleanup GET classifies a real tree: registered, archived, pinned, live, and
    known-subagent sessions are skipped; unknown and orphan-subagent
    directories, tombstones, and provably idle empty directories are reported;
    non-project directories and root files are ignored; 201 leftovers truncate
    to 200 with `truncated: true`
  - cleanup POST moves a mixed file/directory list with one recycle spawn;
    per-item failures are reported for a known session that became non-empty, a
    vanished path, and a raw `..` escape; nothing is spawned when every item
    fails; more than 200 paths is a 400; other methods are 405 with
    `allow: GET, POST`; the trust fence is passed through
  - open-path reveals a file with one `['/select,<encoded URI>']` argument,
    opens a directory with one URI argument, refuses an escape with 400, a
    vanished path with 404, other methods with 405, and passes the fence through
  - the archived route returns the registry ids, drops invalid shapes, and
    refuses non-GET methods
  - a confirmed single request deletes the temp log **and historical
    generations** (including the legacy `session.v3.jsonl.zstd` and
    `session.jsonl` names), tidies the empty session directory,
    unarchives/detaches/unpins the session, counts the bound schedule, and
    leaves the project directory and the schedule record intact
  - descendant subagent logs reported by the persistence listing are deleted
    with the parent and returned as `removedChildSessions`
  - a live subagent, a failing subagent listing, an unexpected subagent path,
    and a directory sitting at the log path all refuse the whole operation
    before any log is renamed
  - an idle-but-live session returns 202 and is written to the pending queue;
    a running agent returns 409 and is not queued; a live idle subagent
    schedules the parent family; a running live subagent is refused
  - startup replay deletes a queued archived session and clears the store;
    drops an entry that was unarchived; keeps an entry that is live again
  - a batch request reports per-session `deleted`, `scheduled`, and `skipped`
    results, deletes only the static log, and queues only the live session
  - a non-archived session is refused with 409 and nothing is deleted
  - a trust-fence rejection is passed through untouched (403)
  - a non-JSONL storage backend is refused with 400 without a path guess
  - a vanished log still cleans the listing and returns 200 with a warning
  - invalid JSON and a non-JSON content type are refused with 400/415
  - the Host plugin object survives an empty context
- `client.js`
  - the module registers `@local/session-manager`
  - the factory exposes `inject: ['slots', 'locale', 'remote', 'sessions']`
    and an `apply` function
  - `addNotice` coalesces only repeated pending-action notices, caps the stack
    at four while keeping the newest notice, and keeps a sticky approval while
    dropping older non-sticky entries; repeated completions/errors each alert
  - `statusTransitions` reports new approvals, ignores unchanged pending keys,
    reports question resolution, reports `running → idle` as a completion, and
    suppresses the completion when the new snapshot still has a pending
    interaction
  - a failed turn (`api-session/error` then `running → idle`) alerts once, as
    an error, and notification titles use the list's `displayTitle`
  - subagent completions stay quiet (their parent shows subagent activity),
    while a forked session — which also carries a parent id — still alerts
  - an approval whose `displayReason` is a `{ en, [locale] }` map resolves
    through the locale service (English fallback when the active locale is
    absent)
  - a missing host route (405 from the SPA fallback) maps to the localized
    “delete service unavailable” message
  - a `202 restart-required` response closes the dialog and pushes a sticky
    “deletion scheduled” notice
  - a successful delete reports the removed subagent count in the toast
  - batch load, selection, filter, and mixed delete results; one summary toast
    (sticky when anything is scheduled)
  - `noticeOpenable`: a notice with a session id is clickable when the
    session-open action is available; a missing workspace service or session id
    disables the card
  - the single-delete body stays exactly `{sessionId, confirm}` unless the
    checkbox is ticked, which adds only `moveToTrash: true`; batch bodies follow
    the same rule and the toggle survives reopening the dialog
  - cleanup scan, default selection, toggle/toggle-all, open-location, and
    move-selected request shapes; a missing route maps to the localized
    unavailable message; mixed results push the summary toast; the debug seam
    publishes a notice with a session id
  - `apply` installs all six slot entries and never throws with a normal fake
    context or with an empty context

Explicitly **not** exercised offline: rendering in a real browser and a real
irreversible deletion on a live profile. Those are covered by the isolated E2E
run and the Phase B manual checks below.

## Phase B — after your review and approval

### B1. Install / update

```text
plugin_manager install_bundle target=C:\Users\THINKPAD\Documents\deepseek-harness\default-workspace\session-manager
```

Read the returned `application` and `warnings`. Do not treat logs as the result.
A Host-half change (routes, pending queue) only takes effect after **restarting
the DSH application**, not just refreshing the page. The Client half reloads on
a page refresh. The bundle declares `engines.dsh: ">=0.2.2-rc.1 <0.3.0"`; an
older or newer incompatible host must refuse the installation instead of
loading it.

### B2. Verify the Host row

```text
cordis_inspect_query host Config.listConfigs name=@local/session-manager
```

Expected: an entry `id: session-manager` with a schema status.

### B3. Refresh the page

The Client half must enter the page's module graph. Refresh the Web GUI once
(there is no running `dev:web` watcher, so no hot update is assumed).

### B4. Verify slot registration

```text
cordis_inspect_query client Slots.listSubTree root=shell.overlay
cordis_inspect_query client Slots.listSubTree root=sidebar.footer.action
cordis_inspect_query client Slots.listSubTree root=sidebar.workspaces.session.menu.item
```

Expected occupants:

- `shell.overlay`: `session-manager.toasts`, `session-manager.confirm`,
  `session-manager.batch`, `session-manager.cleanup`
- `sidebar.footer.action`: `session-manager-sound` (renders the batch trash
  button, the leftover-cleanup broom, and the sound bell)
- `sidebar.workspaces.session.menu.item`: `session-manager.delete-archived`

### B5. Manual acceptance checklist

Alerts:

- [ ] Open the console; no `slot entry crashed` or `[session-manager] … failed`
      entries after refresh.
- [ ] Approval: trigger a tool that needs approval. A sticky “需要审批” popup
      appears, with the tool name/reason; the sound plays; clicking the popup
      focuses that session.
- [ ] Question/plan review: ask the agent a question (or enter plan mode and
      finish a plan). A sticky popup appears.
- [ ] Completion: start a turn in a session and switch the window/app focus to
      something else; when it finishes, a popup and sound appear. When the
      finished session is the current one **and** the window is focused, the
      completion popup is intentionally suppressed.
- [ ] Error: a failed turn produces an error popup, and no “completed” popup
      follows it.
- [ ] Popup card click: click anywhere on a popup that carries a session (the
      popup no longer has an “打开” button). That session opens and the popup
      dismisses. The “×” button closes the popup without opening anything.
      With the card focused, Enter and Space behave like a click.
- [ ] Bell button: click mutes (no sound, popups remain); click again enables.
      **Shift+click** shows an “示例提醒” popup and a sound (useful without
      waiting for a real approval).
- [ ] Reload the page: the mute state is remembered.

Archived-session delete:

- [ ] A non-archived session's “…” menu has **no** delete row.
- [ ] Archive a disposable session, then open its “…” menu: the
      “删除已归档会话…” row is present, matches the Host context-menu row
      metrics (13px text, 34px row), and keeps the danger colour.
- [ ] Click it: the menu closes and the confirmation dialog opens with the
      session title, the “cannot be undone” sentence (which now names subagent
      sessions too), the keep list, and a compact “回收站” checkbox at the left
      end of the footer (off by default; its tooltip explains that logs move to
      the Recycle Bin and can be recovered). Cancel and “永久删除” stay
      together on the right.
- [ ] With the checkbox off, deletion is permanent (previous behaviour). With
      it on, the same delete appears in the Windows Recycle Bin, and a warning
      is reported if the Recycle Bin is unavailable (the logs are then removed
      permanently).
- [ ] Escape / backdrop / Cancel closes the dialog without a request.
- [ ] While the session is idle but still held by the running DSH process (or a
      subagent it spawned is), confirming returns 202: the dialog closes, a
      sticky “已安排删除” popup appears, and the row stays archived until the
      restart.
- [ ] While a turn is actually running, confirming is refused with a readable
      message (HTTP 409 `session-active`); the dialog stays open.
- [ ] Restart DSH: the scheduled log directory is gone and
      `.session-manager-pending-delete.json` is cleared.
- [ ] Before deleting, place a sentinel file in the workspace and note an
      existing scheduled task bound to another session. After deleting:
  - [ ] the archived row disappears from the sidebar after the list refresh;
  - [ ] the sentinel file is still present;
  - [ ] the scheduled task still exists in the Schedule page;
  - [ ] the session log directory is gone (or only non-log files remain with a
        “cleanup incomplete” notice), **including every bare-UUID subagent
        session directory under the same project**;
  - [ ] the success popup appears; if the deleted session had bound schedules,
        the popup mentions how many were kept, and if it had subagent sessions,
        it mentions how many were deleted;
- [ ] Do not use a session whose log you need as the first live deletion test.

Batch cleanup:

- [ ] The trash button at the sidebar foot is beside the bell and has a
      localized tooltip.
- [ ] Opening it lists every archived session, including ones hidden by the
      sidebar's “hide archived” filter.
- [ ] Search matches by title and by session id; select-all selects only the
      visible (filtered) rows and shows an indeterminate state for a partial
      selection.
- [ ] With nothing selected, the delete button is disabled and reads
      “删除（0）”; its label only counts the selection.
- [ ] The search field's top border and focus ring are fully visible, with a
      clear gap below the description text (the body provides top clearance).
- [ ] A mixed batch (one deletable, one held by the process) reports
      “已删除 1 个 / 1 个将在下次启动 DSH 时删除”, pushes one sticky scheduled
      popup, and keeps the dialog open on the result summary.
- [ ] The deletable session's log is gone immediately; the scheduled one
      remains until the next DSH start.
- [ ] With no archived sessions, the dialog shows “没有已归档会话。” and the
      delete button stays disabled.
- [ ] Escape / backdrop / Cancel / close button all dismiss the dialog; while a
      batch request is in flight they are disabled.

Leftover cleanup:

- [ ] The broom button at the sidebar foot sits between the trash and the bell
      and has a localized tooltip.
- [ ] Opening it scans the sessions root. Registered, archived, pinned,
      pending-deletion, and known-subagent sessions are never listed.
- [ ] Each row shows a checkbox and its kind (session directory / tombstone /
      empty directory) and full path. Everything is selected on open; the
      select-all row reads “全选 / 已选 N 个” and shows an indeterminate state
      for a partial selection. When more than 200 items exist, a truncation
      note names the listed count.
- [ ] Unticking a row excludes it from the move; with nothing selected the
      footer button reads “移入回收站（0）” and is disabled.
- [ ] “打开位置” reveals that exact path in Explorer; it changes nothing on
      disk. Repeat for a file and a directory.
- [ ] “移入回收站（N）” disables while the request is in flight, then the
      result view reports moved and failed counts. Reopening the dialog shows
      the empty state (or only items that were refused).
- [ ] With no leftovers, the dialog shows “没有发现残留文件。” and the move
      button stays disabled.
- [ ] Attachments under `~/.dsh/attachments` are never listed and never
      deleted.

Batch cleanup (Recycle Bin option):

- [ ] The batch dialog has its own compact “回收站” checkbox at the left end
      of the footer, separated from the Cancel / “删除（N）” buttons on the
      right; its tooltip carries the full explanation. Select-all's
      indeterminate state still works.
- [ ] Ticking it and deleting a disposable batch moves each log to the Recycle
      Bin; the result summary still reports deleted/scheduled per session.

Visual/theme:

- [ ] Switch light/dark: dialogs, popups, and the bell use theme colours, not
      hard-coded panel colours.
- [ ] Switch language (zh/en): menu row, dialog, popups, and bell tooltip
      follow the active locale.

## Rollback

```text
plugin_manager remove_bundle @local/session-manager
```

If removal is not desired, disable the `session-manager` row in the Plugin
Manager instead. Then refresh the page and confirm:

- the Host row is gone or disabled;
- the six slot occupants above are gone;
- no session was deleted by the rollback (rollback only unloads the plugin).

Rollback never touches session data. Only the confirmation dialog can delete a
session, and only after the Host-side checks pass.

## Notes and limits

- Browser checks were automated against an isolated Host: a temporary
  `DSH_HOME`, the `smoke` profile created from the Web template, a local
  OpenAI-compatible mock model, and headless Chrome driven through CDP. The
  live profile's sessions were not used as test data. Verified on 2026-11-11:
  the host modal metrics (28 px radius, layer-2 surface, 16 px title, 36 px
  buttons), menu row visibility, single delete 200 + toast, idle-live delete
  202 + sticky notice + marker file, startup replay removing the log and
  marker, and a mixed batch (deleted + scheduled) with its result view and
  startup replay. Console showed no plugin errors.
- v1.2 was verified on 2026-11-11 against the same isolated Host: clicking the
  body of an openable popup dismisses it **and** selects the session row
  (`aria-selected="true"`); the “×” button closes without opening; the cleanup
  dialog listed one orphan session directory, one `.sm-delete-…` tombstone, and
  one empty project directory with localized kinds and full paths; “打开位置”
  produced an `open-path` spawn with one `/select,<encoded URI>` argument; “全部
  移入回收站（3）” reported “已移入回收站 3 项”, left the live session log
  untouched, and reopening showed “没有发现残留文件。”.
- The Host tests use two test-only seams. When `SM_TEST_SPAWN_LOG` names a
  file, spawned processes are not launched; each call appends
  `{kind, file, argv}` to that file, and `recycle` moves the items into a
  simulated bin under `<log>.trash/` so the filesystem result matches a real
  Recycle Bin. `SM_TEST_SPAWN_FAIL=<kind>` makes that kind fail (used to test
  the permanent-delete fallback). Neither seam is active in normal use.
- The Client exposes `__SESSION_MANAGER_DEBUG__.pushNotice(...)` only when
  `globalThis.__SESSION_MANAGER_TEST__ === true`; it exists so an automated
  browser can create a toast for a real session.
- The delete route is reachable only through the page's authenticated
  same-origin request (Host/Origin fence from `ctx.connection.requestRejection`).
  A direct `curl` without the page's cookies/Origin is expected to be refused.
- If the Host returns `unsupported-storage`, the session backend is not the
  JSONL backend this version targets; nothing is deleted.
- The plugin assumes one Host owns the sessions root. Liveness is checked
  through this Host's `sessions`/`agents` registries and the persistence
  activity waterfall; a second process holding a write handle is not visible
  to those checks. On Windows such a handle usually makes the staging rename
  fail and the whole operation rolls back safely.
- Log files are staged under a `.sm-delete-<uuid>` suffix before removal. A
  tombstone that cannot be removed is ignored by the backend's canonical
  parser and reported as a warning; the leftover scanner reports it and can
  move it to the Recycle Bin once the lock is gone.
- Attachments are content-addressed and shared between sessions, so neither
  deletion nor leftover cleanup can attribute one to a deleted session; they
  are always kept. Empty workspace files and scheduled tasks are also kept.
- Recycle Bin support and open-location are Windows-only. On another platform
  the Host degrades to a permanent delete (with a warning) and the open-path
  route answers `400 unsupported`.
- DSH's plugin guidance forbids importing
  `@deepseek-ai/dsh-client-ui-primitives` from a plain-JS plugin. The dialog
  therefore reproduces the Host markup and metrics using the stable `--dsw-*`
  design tokens (surface, radius, elevation, typography, hairline, focus ring);
  it does not depend on hashed class names.
