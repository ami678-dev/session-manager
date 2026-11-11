/**
 * Host half of @local/session-manager.
 *
 * Responsibilities:
 * - Serve the archived-session list used by batch cleanup.
 * - Serve the destructive operation the plugin needs: permanently delete one
 *   archived session's durable log, the logs of its descendant subagent
 *   sessions, its derived projection cache rows, and its workspace listing
 *   entries.
 * - Never touch workspace files, attachments, generated documents, scheduled
 *   tasks, jobs, or any path outside the session log directory.
 *
 * Design notes (see TESTING.md and README.md):
 * - The delete route is registered on the bare `webServer`, so it must ask the
 *   composition's `connection` service for a rejection first, exactly like the
 *   shipped `@deepseek-ai/dsh-host-open-in-app` routes.
 * - `sessionPersistence` exposes no delete method. The log artifact paths are
 *   read from `stat()`/`list()`, then validated by `host-lib.js` before a
 *   single file is removed.
 * - All log files are staged under a non-canonical tombstone name first. If
 *   any rename fails, every staged rename is rolled back and nothing is
 *   deleted. Cleanup that follows the log removal is fail-soft and reported
 *   back as a warning.
 * - `apply` never throws: a failure to register the route is logged and the
 *   plugin stays inert instead of failing the Loader entry.
 *
 * @module @local/session-manager
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { mkdir, readFile, readdir, realpath, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  MAX_CLEANUP_ITEMS,
  MAX_DELETE_BODY_BYTES,
  PENDING_DELETE_VERSION,
  SESSION_LOG_FILE_PATTERN,
  TOMBSTONE_FILE_PATTERN,
  addPendingDelete,
  boundSchedulesFor,
  classifySessionDir,
  isEncodedProjectKey,
  isSessionId,
  parseBatchDeleteRequest,
  parseCleanupRequest,
  parseDeleteRequest,
  parseOpenPathRequest,
  parsePendingDeletes,
  parseRecycleBinStdout,
  readBoundedBody,
  recycleBinEncodedCommand,
  safeArtifactPath,
  safeArtifactTarget,
  safePathWithinRoot,
} from './host-lib.js';

/** Cordis function-plugin name. */
export const name = 'session-manager';

/**
 * Services this Host half reads. `schedule` is optional and read through
 * `ctx.get('schedule')` because it is only used for a read-only count.
 */
export const inject = [
  'webServer',
  'connection',
  'sessions',
  'agents',
  'sessionPersistence',
  'workspaceRegistry',
  'storageDomain',
];

/** Exact routes registered on the composition's web server. */
const ROUTE_PATH = '/session-manager/api/delete';
const ARCHIVED_PATH = '/session-manager/api/archived';
const CLEANUP_PATH = '/session-manager/api/cleanup';
const OPEN_PATH = '/session-manager/api/open-path';

/** Test seam: append every spawn to this file instead of running it. */
const SPAWN_LOG_ENV = 'SM_TEST_SPAWN_LOG';
/** Test seam: fail spawns of this kind (e.g. `recycle` or `open-path`). */
const SPAWN_FAIL_ENV = 'SM_TEST_SPAWN_FAIL';
/** Upper bound on captured process output. */
const SPAWN_STDOUT_LIMIT = 1024 * 1024;
/** Paths per `powershell.exe` invocation; keeps the command line short. */
const RECYCLE_CHUNK = 40;
/** Shape of a raw subagent session id (never shown in the workspace registry). */
const SUBAGENT_ID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function spawnLogPath() {
  try {
    const value = typeof process !== 'undefined' ? process.env?.[SPAWN_LOG_ENV] : undefined;
    return typeof value === 'string' && value !== '' ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Run one child process and capture stdout. Only `open-path` treats exit
 * code 1 as success: Explorer delegates an already-running desktop process
 * and exits 1 in that case (the shipped native-command plugin does the same).
 * @param {string} file - executable.
 * @param {string[]} argv - arguments, never a shell string.
 * @param {'recycle' | 'open-path'} kind - test-seam label.
 * @returns {Promise<{ok: boolean, stdout: string, code: number|null, message?: string}>}
 */
async function runSpawn(file, argv, kind) {
  const logPath = spawnLogPath();
  if (logPath !== undefined) {
    try {
      appendFileSync(logPath, `${JSON.stringify({ kind, file, argv })}\n`, 'utf8');
    } catch {
      /* the seam is best effort */
    }
    try {
      if (process.env?.[SPAWN_FAIL_ENV] === kind) {
        return { ok: false, stdout: '', code: null, message: `simulated ${kind} spawn failure` };
      }
    } catch {
      /* fall through to success */
    }
    return { ok: true, stdout: '', code: 0 };
  }

  return new Promise((resolvePromise) => {
    let child;
    try {
      child = spawn(file, argv, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    } catch (error) {
      resolvePromise({ ok: false, stdout: '', code: null, message: messageOf(error) });
      return;
    }
    let stdout = '';
    let settled = false;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      resolvePromise(result);
    };
    child.stdout?.on('data', (chunk) => {
      if (stdout.length >= SPAWN_STDOUT_LIMIT) return;
      stdout += String(chunk);
      if (stdout.length > SPAWN_STDOUT_LIMIT) stdout = stdout.slice(0, SPAWN_STDOUT_LIMIT);
    });
    child.once('error', (error) => {
      settle({ ok: false, stdout, code: null, message: messageOf(error) });
    });
    child.once('close', (code) => {
      const ok = code === 0 || (kind === 'open-path' && code === 1);
      settle({ ok, stdout, code, message: ok ? undefined : `${file} exited with code ${String(code)}` });
    });
  });
}

/**
 * Move validated paths to the Windows Recycle Bin. Items are chunked so one
 * command line stays bounded. When the Recycle Bin is unavailable the caller
 * degrades to permanent removal, exactly like the single-delete path.
 * @param {{path: string, isDir: boolean}[]} items - absolute paths.
 * @returns {Promise<{ok: true, results: Map<string, {moved: boolean, reason?: string}>} | {ok: false, reason: string, results: Map<string, {moved: boolean, reason?: string}>}>}
 */
async function recycleBinItems(items) {
  const results = new Map();
  if (items.length === 0) return { ok: true, results };
  if (typeof process === 'undefined' || process.platform !== 'win32') {
    return { ok: false, reason: 'the Recycle Bin is only supported on Windows', results };
  }
  const seamLog = spawnLogPath();
  for (let index = 0; index < items.length; index += RECYCLE_CHUNK) {
    const chunk = items.slice(index, index + RECYCLE_CHUNK);
    const outcome = await runSpawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', recycleBinEncodedCommand(chunk)],
      'recycle',
    );
    if (!outcome.ok) {
      return { ok: false, reason: outcome.message || 'the Recycle Bin is unavailable', results };
    }
    if (seamLog !== undefined) {
      // Test seam: emulate the move so the filesystem result matches a real
      // Recycle Bin without running PowerShell.
      const binDir = join(`${seamLog}.trash`, randomUUID());
      let ready = true;
      try {
        await mkdir(binDir, { recursive: true });
      } catch {
        ready = false;
      }
      for (let offset = 0; offset < chunk.length; offset += 1) {
        const item = chunk[offset];
        if (!ready) {
          results.set(item.path, { moved: false, reason: 'cannot create the simulated Recycle Bin' });
          continue;
        }
        try {
          await rename(item.path, join(binDir, `${offset}-${basename(item.path)}`));
          results.set(item.path, { moved: true });
        } catch (error) {
          results.set(item.path, { moved: false, reason: messageOf(error) });
        }
      }
      continue;
    }
    const parsed = parseRecycleBinStdout(outcome.stdout, chunk.map((item) => item.path));
    for (const [path, result] of parsed) results.set(path, result);
  }
  return { ok: true, results };
}

/**
 * Encode a path exactly like the shipped `dsh-native-command` plugin so the
 * same path syntax reaches Explorer, including the `/select,` reveal form.
 * @param {string} target - absolute path.
 * @returns {string} file URI.
 */
function explorerTarget(target) {
  let uri = pathToFileURL(target, { windows: true }).href;
  // The shipped encoder keeps 0x80-0x9F code units literal; mirror it so the
  // URI shape matches even though our encoded paths never need it.
  uri = uri
    .replace(/%8([0-9a-f])/gi, (match, hex) => String.fromCharCode(parseInt(`8${hex}`, 16)))
    .replace(/%9([0-9a-f])/gi, (match, hex) => String.fromCharCode(parseInt(`9${hex}`, 16)));
  return uri.replace(/,/g, '%2C').replace(/=/g, '%3D');
}

/** Suffix making a staged log invisible to the JSONL backend's canonical parser. */
const TOMBSTONE_SUFFIX = '.sm-delete-';

/** Pending-delete marker stored beside the session root and processed on the next start. */
const PENDING_DELETE_FILE = '.session-manager-pending-delete.json';

function messageOf(error) {
  if (error instanceof Error && typeof error.message === 'string') return error.message;
  return String(error);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pendingDeletePath(root) {
  return join(root, PENDING_DELETE_FILE);
}

/** Read the pending-delete store; a missing store is empty, a corrupt one is flagged. */
async function readPendingDeletes(ctx) {
  let root;
  try {
    if (typeof ctx.sessionPersistence?.root === 'string') root = ctx.sessionPersistence.root;
  } catch {
    /* the concrete backend is allowed to keep its root private */
  }
  if (root === undefined || root === '') {
    return { root: undefined, entries: [], warning: 'session root is unavailable' };
  }
  let text;
  try {
    text = await readFile(pendingDeletePath(root), 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return { root, entries: [] };
    throw error;
  }
  const parsed = parsePendingDeletes(text);
  if (!parsed.ok) return { root, entries: [], corrupt: true, message: parsed.message };
  return { root, entries: parsed.entries };
}

/** Atomically replace the pending-delete store (removing it when empty). */
async function writePendingDeletes(root, entries) {
  const file = pendingDeletePath(root);
  if (entries.length === 0) {
    try {
      await rm(file, { force: true });
    } catch {
      /* an absent store is the desired state */
    }
    return;
  }
  const text = JSON.stringify({ version: PENDING_DELETE_VERSION, sessions: entries });
  const temp = `${file}.${randomUUID()}.tmp`;
  await writeFile(temp, text, 'utf8');
  let lastError;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await rename(temp, file);
      return;
    } catch (error) {
      lastError = error;
      // Windows can briefly refuse replacing a file another reader has open.
      if (!error || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) break;
      await sleep(50 * (attempt + 1));
    }
  }
  try {
    await rm(temp, { force: true });
  } catch {
    /* the temp file is harmless if removal also fails */
  }
  throw lastError;
}

/** Queue one session for deletion on the next Host start. */
async function schedulePendingDelete(ctx, sessionId, moveToTrash = false) {
  const state = await readPendingDeletes(ctx);
  if (state.root === undefined) throw new Error(state.warning ?? 'session root is unavailable');
  if (state.corrupt) throw new Error(`pending-delete store is unreadable: ${state.message}`);
  const entries = addPendingDelete(state.entries, sessionId, Date.now(), moveToTrash === true);
  await writePendingDeletes(state.root, entries);
}

/** Current liveness of one session, including whether its Agent is inside a turn. */
function liveState(ctx, sessionId) {
  const agent = ctx.agents?.get?.(sessionId);
  const session = ctx.sessions?.get?.(sessionId);
  if (agent === undefined && session === undefined) return { live: false };
  return { live: true, running: agent?.status === 'running' };
}

function sendJson(response, status, payload) {
  try {
    if (response.headersSent || response.writableEnded) return;
    response.statusCode = status;
    response.setHeader('content-type', 'application/json; charset=utf-8');
    response.setHeader('cache-control', 'no-store');
    response.end(JSON.stringify(payload));
  } catch (error) {
    try {
      console.error('[session-manager] cannot write route response:', messageOf(error));
    } catch {
      /* nothing else can be done here */
    }
  }
}

/** Best-effort, read-only schedule count; a failure never blocks the delete. */
async function countSchedules(ctx, sessionIds, warnings) {
  try {
    const schedule = typeof ctx.get === 'function' ? ctx.get('schedule') : undefined;
    if (!schedule || typeof schedule.catalog !== 'function') return null;
    return boundSchedulesFor(await schedule.catalog(), sessionIds);
  } catch (error) {
    warnings.push(`schedule lookup failed: ${messageOf(error)}`);
    return null;
  }
}

/**
 * Collect the session ids of every descendant subagent session.
 *
 * Subagent sessions carry `origin: "subagent"` and their parent's id in the
 * log header; they are never shown as sidebar rows, so deleting only the
 * archived parent would silently orphan their durable logs.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - owning Host context.
 * @param {string} sessionId - the archived parent session.
 * @returns {Promise<{supported: boolean, ids: string[], snapshots: Map<string, any>}>}
 */
async function listSubagentDescendants(ctx, sessionId) {
  const persistence = ctx.sessionPersistence;
  if (!persistence || typeof persistence.list !== 'function') {
    return { supported: false, ids: [], snapshots: new Map() };
  }
  const listed = await persistence.list();
  const byParent = new Map();
  for (const snapshot of Array.isArray(listed) ? listed : []) {
    const header = snapshot?.header;
    if (!header || header.origin !== 'subagent' || typeof header.parentSession !== 'string') continue;
    if (typeof header.id !== 'string' || header.id === '') continue;
    let bucket = byParent.get(header.parentSession);
    if (bucket === undefined) {
      bucket = [];
      byParent.set(header.parentSession, bucket);
    }
    bucket.push(snapshot);
  }
  const ids = [];
  const snapshots = new Map();
  const queue = [sessionId];
  const seen = new Set(queue);
  for (let index = 0; index < queue.length; index += 1) {
    for (const snapshot of byParent.get(queue[index]) ?? []) {
      const id = snapshot.header.id;
      if (seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
      snapshots.set(id, snapshot);
      queue.push(id);
    }
  }
  return { supported: true, ids, snapshots };
}

/** One session directory's canonical generation files (target file as fallback). */
async function collectGenerationFiles(target) {
  let entries;
  try {
    entries = await readdir(target.dir, { withFileTypes: true });
  } catch (error) {
    if (error && error.code === 'ENOENT') return [target.file];
    throw error;
  }
  const files = entries
    .filter((entry) => entry.isFile() && SESSION_LOG_FILE_PATTERN.test(entry.name))
    .map((entry) => join(target.dir, entry.name));
  if (files.length > 0) return files;
  // A stale artifact path may name a vanished file (reported as absent) but
  // must never let a directory or device be renamed into a tombstone.
  try {
    const info = await stat(target.file);
    if (!info.isFile()) throw new Error('session log path is not a regular file');
  } catch (error) {
    if (error && error.code === 'ENOENT') return [target.file];
    throw error;
  }
  return [target.file];
}

/** Restore every already-staged log name; failures are reported, never thrown. */
async function rollbackRenames(renames, warnings) {
  for (let index = renames.length - 1; index >= 0; index -= 1) {
    const { from, to } = renames[index];
    try {
      await rename(to, from);
    } catch (error) {
      warnings.push(`cannot restore a staged session log: ${messageOf(error)}`);
    }
  }
  renames.length = 0;
}

/**
 * Stage every log file under a non-canonical tombstone name, then remove the
 * tombstones. A staging failure rolls back all renames, so the backend sees
 * an unchanged session; a failed tombstone removal only leaves a file the
 * backend no longer lists, reported as a warning.
 *
 * When `moveToTrash` is set the tombstones go to the Recycle Bin first; if
 * the Recycle Bin is unavailable (or refuses one file) the removal degrades
 * to a permanent delete and says so in the warnings.
 *
 * @param {{id: string, file: string, dir: string, sizeBytes: number}[]} targets
 * @param {string[]} warnings - warning sink.
 * @param {{moveToTrash?: boolean}} [options]
 * @returns {Promise<{ok: true, freedBytes: number} | {ok: false, message: string}>}
 */
async function removeSessionLogs(targets, warnings, options = {}) {
  if (targets.length === 0) return { ok: true, freedBytes: 0 };
  const tag = randomUUID();
  const renames = [];
  let freedBytes = 0;

  for (const target of targets) {
    let files;
    try {
      files = await collectGenerationFiles(target);
    } catch (error) {
      await rollbackRenames(renames, warnings);
      return {
        ok: false,
        message: `cannot enumerate session log generations: ${messageOf(error)}`,
      };
    }
    let staged = 0;
    for (const file of files) {
      const tombstone = `${file}${TOMBSTONE_SUFFIX}${tag}`;
      try {
        await rename(file, tombstone);
      } catch (error) {
        if (error && error.code === 'ENOENT') {
          warnings.push('a session log generation was already absent');
          continue;
        }
        await rollbackRenames(renames, warnings);
        return {
          ok: false,
          message: `cannot stage session log removal: ${messageOf(error)}`,
        };
      }
      renames.push({ from: file, to: tombstone });
      staged += 1;
    }
    if (staged > 0) freedBytes += target.sizeBytes;
  }

  if (options.moveToTrash === true && renames.length > 0) {
    const recycled = await recycleBinItems(renames.map(({ to }) => ({ path: to, isDir: false })));
    if (!recycled.ok) {
      warnings.push(
        `Recycle Bin unavailable (${recycled.reason}); session logs were permanently removed`,
      );
      for (const { to } of renames) {
        try {
          await rm(to, { force: false });
        } catch (error) {
          if (error && error.code === 'ENOENT') continue;
          warnings.push(`cannot remove a staged session log: ${messageOf(error)}`);
        }
      }
    } else {
      for (const { to } of renames) {
        const outcome = recycled.results.get(to);
        if (outcome?.moved) continue;
        try {
          await rm(to, { force: false });
        } catch (error) {
          if (error && error.code === 'ENOENT') continue;
          warnings.push(`cannot remove a staged session log: ${messageOf(error)}`);
          continue;
        }
        warnings.push(
          'the Recycle Bin refused a staged session log '
          + `(${outcome?.reason || 'no result'}); it was permanently removed`,
        );
      }
    }
  } else {
    for (const { to } of renames) {
      try {
        await rm(to, { force: false });
      } catch (error) {
        if (error && error.code === 'ENOENT') continue;
        warnings.push(`cannot remove a staged session log: ${messageOf(error)}`);
      }
    }
  }

  for (const dir of new Set(targets.map((target) => target.dir))) {
    try {
      const entries = await readdir(dir);
      if (entries.length === 0) await rmdir(dir);
      else warnings.push('session directory was kept because it still holds other files');
    } catch (error) {
      if (!(error && error.code === 'ENOENT')) {
        warnings.push(`cannot tidy session directory: ${messageOf(error)}`);
      }
    }
  }

  return { ok: true, freedBytes };
}

/**
 * Refuse or schedule a deletion when the session is still live.
 *
 * DSH keeps an opened session's Agent for the Host process lifetime, so an
 * idle live session cannot be "closed" from the page. Scheduling it for the
 * next Host start is the only reliable completion; a running turn is still a
 * hard refusal.
 *
 * @returns {Promise<undefined | {status: number, body: object}>}
 */
async function liveOutcome(ctx, sessionId, options) {
  let live;
  try {
    live = liveState(ctx, sessionId);
  } catch (error) {
    return {
      status: 500,
      body: {
        ok: false,
        code: 'delete-failed',
        message: `cannot verify session liveness: ${messageOf(error)}`,
      },
    };
  }
  if (!live.live) return undefined;
  if (live.running) {
    return {
      status: 409,
      body: {
        ok: false,
        code: 'session-active',
        message: 'session still has running work',
      },
    };
  }
  if (options.schedule === false) {
    return {
      status: 409,
      body: {
        ok: false,
        code: 'session-live',
        message: 'session is still open in this Harness; close it first',
      },
    };
  }
  try {
    await schedulePendingDelete(ctx, sessionId, options?.moveToTrash === true);
  } catch (error) {
    return {
      status: 500,
      body: {
        ok: false,
        code: 'delete-failed',
        message: `cannot schedule deletion: ${messageOf(error)}`,
      },
    };
  }
  return {
    status: 202,
    body: {
      ok: true,
      code: 'restart-required',
      sessionId,
      message: 'session is held by the running DSH process; deletion is scheduled for the next start',
    },
  };
}

/**
 * Delete one archived session after every safety check passes.
 * @param {import('@deepseek-ai/cordis').Context} ctx - owning Host context.
 * @param {string} sessionId - archived session.
 * @param {{schedule?: boolean, moveToTrash?: boolean}} [options] -
 *   `schedule: false` when replaying a pending request at startup (a
 *   still-live session is then a hard refusal); `moveToTrash: true` sends
 *   the log files to the Recycle Bin instead of a permanent delete.
 * @returns {Promise<{status: number, body: object}>}
 */
async function deleteArchivedSession(ctx, sessionId, options = {}) {
  const warnings = [];
  const registry = ctx.workspaceRegistry;

  let archived = false;
  try {
    archived = Array.isArray(registry?.archivedSessionIds)
      && registry.archivedSessionIds.includes(sessionId);
  } catch (error) {
    warnings.push(`archive set lookup failed: ${messageOf(error)}`);
  }
  if (!archived) {
    return {
      status: 409,
      body: { ok: false, code: 'not-archived', message: 'session is not archived' },
    };
  }

  // A live session may still hold a write handle on the log. Refuse a running
  // turn outright; an idle live session is scheduled for the next Host start.
  // A failure to read the registries is a refusal, never an assumed "idle".
  // Reuse the shipped archive activity check so subagents, schedules, or jobs
  // that still report work for this session block the irreversible step.
  // An activity check that cannot run is a refusal, not a green light.
  let activity = [];
  try {
    if (typeof ctx.waterfall === 'function') {
      activity = await ctx.waterfall(
        'workspace/session-activity',
        { sessionId },
        () => Promise.resolve([]),
      );
    }
  } catch (error) {
    return {
      status: 500,
      body: {
        ok: false,
        code: 'delete-failed',
        message: `cannot verify session activity: ${messageOf(error)}`,
      },
    };
  }
  if (Array.isArray(activity) && activity.length > 0) {
    return {
      status: 409,
      body: {
        ok: false,
        code: 'session-active',
        message: 'session still has running work',
        activity,
      },
    };
  }

  const earlyLive = await liveOutcome(ctx, sessionId, options);
  if (earlyLive !== undefined) return earlyLive;

  let snapshot;
  try {
    snapshot = await ctx.sessionPersistence.stat(sessionId);
  } catch (error) {
    return {
      status: 500,
      body: {
        ok: false,
        code: 'delete-failed',
        message: `cannot read session storage: ${messageOf(error)}`,
      },
    };
  }

  let root;
  try {
    if (typeof ctx.sessionPersistence.root === 'string') root = ctx.sessionPersistence.root;
  } catch {
    /* the concrete backend is allowed to keep its root private */
  }

  // Refuse a non-JSONL backend before asking it to enumerate subagents.
  if (snapshot && snapshot.location !== undefined && snapshot.location.kind !== 'jsonl') {
    return {
      status: 400,
      body: {
        ok: false,
        code: 'unsupported-storage',
        message: `unsupported session storage kind: ${String(snapshot.location.kind)}`,
      },
    };
  }

  let descendants;
  try {
    descendants = await listSubagentDescendants(ctx, sessionId);
  } catch (error) {
    return {
      status: 500,
      body: {
        ok: false,
        code: 'delete-failed',
        message: `cannot enumerate subagent sessions: ${messageOf(error)}`,
      },
    };
  }
  if (!descendants.supported) {
    warnings.push('subagent session listing is unavailable; subagent logs are kept');
  }
  const removedIds = [sessionId, ...descendants.ids];

  // Validate every path before touching anything, so a stale or unexpected
  // child artifact never leaves the parent half-deleted.
  const targets = [];
  let unsupported;
  let unexpected;
  const addTarget = (id, entry, strict) => {
    if (entry === undefined || entry === null) {
      warnings.push(id === sessionId
        ? 'session log is already gone; listing-only cleanup'
        : `subagent session ${id} has no durable log; skipping`);
      return;
    }
    if (entry.location === undefined) {
      warnings.push(id === sessionId
        ? 'no durable log artifact was found; listing-only cleanup'
        : `subagent session ${id} has no durable log artifact; skipping`);
      return;
    }
    if (entry.location.kind !== 'jsonl') {
      unsupported ??= `${id}: ${String(entry.location.kind)}`;
      return;
    }
    const target = strict
      ? safeArtifactTarget(entry.location.path, id, root)
      : safeArtifactPath(entry.location.path, id, root);
    if (!target.ok) {
      unexpected ??= `${id}: ${target.message}`;
      return;
    }
    targets.push({
      id,
      file: target.file,
      dir: target.dir,
      sizeBytes: Number(entry.sizeBytes) || 0,
    });
  };
  addTarget(sessionId, snapshot, true);
  for (const [id, entry] of descendants.snapshots) addTarget(id, entry, false);

  if (unsupported !== undefined) {
    return {
      status: 400,
      body: {
        ok: false,
        code: 'unsupported-storage',
        message: `unsupported session storage kind: ${unsupported}`,
      },
    };
  }
  if (unexpected !== undefined) {
    return {
      status: 400,
      body: {
        ok: false,
        code: 'bad-request',
        message: `refusing to delete an unexpected path: ${unexpected}`,
      },
    };
  }

  // Re-check every session about to lose its log: a session opened between
  // the first check and here would hold a write handle. A live child cannot be
  // scheduled on its own (its id is not an archived request id), so schedule
  // the parent and let the next start re-enumerate the whole family.
  for (const id of removedIds) {
    let live;
    try {
      live = liveState(ctx, id);
    } catch (error) {
      return {
        status: 500,
        body: {
          ok: false,
          code: 'delete-failed',
          message: `cannot re-verify session liveness: ${messageOf(error)}`,
        },
      };
    }
    if (!live.live) continue;
    if (live.running) {
      return {
        status: 409,
        body: {
          ok: false,
          code: 'session-active',
          message: 'session still has running work',
        },
      };
    }
    if (options.schedule === false) {
      return {
        status: 409,
        body: {
          ok: false,
          code: 'session-live',
          message: 'session became live during deletion; close it and retry',
        },
      };
    }
    try {
      await schedulePendingDelete(ctx, sessionId, options.moveToTrash === true);
    } catch (error) {
      return {
        status: 500,
        body: {
          ok: false,
          code: 'delete-failed',
          message: `cannot schedule deletion: ${messageOf(error)}`,
        },
      };
    }
    return {
      status: 202,
      body: {
        ok: true,
        code: 'restart-required',
        sessionId,
        message: 'session is held by the running DSH process; deletion is scheduled for the next start',
      },
    };
  }

  const logResult = await removeSessionLogs(targets, warnings, {
    moveToTrash: options.moveToTrash === true,
  });
  if (!logResult.ok) {
    return {
      status: 500,
      body: { ok: false, code: 'delete-failed', message: logResult.message },
    };
  }

  const boundSchedules = await countSchedules(ctx, removedIds, warnings);

  // Derived data: removing the cache rows is nice hygiene, never the authority.
  try {
    const domain = typeof ctx.storageDomain?.get === 'function'
      ? ctx.storageDomain.get('session_projcache')
      : undefined;
    if (domain && typeof domain.table === 'function') {
      const table = domain.table('sessions');
      for (const id of removedIds) await table.delete(id);
    }
  } catch (error) {
    warnings.push(`projection cache cleanup failed: ${messageOf(error)}`);
  }

  // Workspace accounting. These are public registry operations, so the
  // in-memory registry and the durable domain stay consistent.
  const removedFromWorkspaces = [];
  for (const id of removedIds) {
    try {
      await registry.unarchiveSession(id);
    } catch (error) {
      warnings.push(`archive set cleanup failed for ${id}: ${messageOf(error)}`);
    }
  }
  try {
    for (const entity of registry.list()) {
      if (!entity || typeof entity.detachSession !== 'function') continue;
      // `entity.sessionIds` is filtered by the registry's candidate index, so
      // it can hide an id whose log has just disappeared. Detach every id
      // unconditionally; `mutate` is a no-op when the raw record lacks the id.
      let accounted = false;
      for (const id of removedIds) {
        if (Array.isArray(entity.sessionIds) && entity.sessionIds.includes(id)) accounted = true;
        try {
          await entity.detachSession(id);
        } catch (error) {
          warnings.push(`workspace ${String(entity.id)} cleanup failed for ${id}: ${messageOf(error)}`);
        }
      }
      if (accounted && !removedFromWorkspaces.includes(entity.id)) removedFromWorkspaces.push(entity.id);
    }
  } catch (error) {
    warnings.push(`workspace listing failed: ${messageOf(error)}`);
  }
  for (const id of removedIds) {
    try {
      await registry.unpinSession(id);
    } catch (error) {
      warnings.push(`pin set cleanup failed for ${id}: ${messageOf(error)}`);
    }
  }

  try {
    ctx.logger?.info?.(
      `session-manager: deleted archived session ${sessionId} `
      + `(removed=${removedIds.length}, childSessions=${descendants.ids.length}, `
      + `bytes=${logResult.freedBytes}, warnings=${warnings.length})`,
    );
  } catch {
    /* logging is not part of the contract */
  }

  return {
    status: 200,
    body: {
      ok: true,
      sessionId,
      removedChildSessions: descendants.ids,
      freedLogBytes: logResult.freedBytes,
      boundSchedules,
      removedFromWorkspaces,
      warnings,
    },
  };
}

/**
 * Replay the durable pending-delete store at Host startup. Runs through the
 * route's serialization queue, so it can never race a live request.
 */
async function processPendingDeletes(ctx) {
  let state;
  try {
    state = await readPendingDeletes(ctx);
  } catch (error) {
    try {
      ctx.logger?.warn?.(`session-manager: cannot read pending deletions: ${messageOf(error)}`);
    } catch {
      /* logging is not part of the contract */
    }
    return;
  }
  if (state.root === undefined) return;
  if (state.corrupt) {
    try {
      ctx.logger?.warn?.(`session-manager: pending-deletion store is unreadable: ${state.message}`);
    } catch {
      /* logging is not part of the contract */
    }
    return;
  }
  if (state.entries.length === 0) return;

  const remaining = [];
  let removed = 0;
  for (const entry of state.entries) {
    let live;
    try {
      live = liveState(ctx, entry.id);
    } catch {
      remaining.push(entry);
      continue;
    }
    if (live.live) {
      // A session resumed before this plugin applied: retry on the next start.
      remaining.push(entry);
      continue;
    }
    let outcome;
    try {
      outcome = await deleteArchivedSession(ctx, entry.id, {
        schedule: false,
        moveToTrash: entry.moveToTrash === true,
      });
    } catch (error) {
      logInfo(ctx, `pending deletion failed for ${entry.id}: ${messageOf(error)}`);
      remaining.push(entry);
      continue;
    }
    if (outcome.status === 200) {
      removed += 1;
      continue;
    }
    if (outcome.body?.code === 'not-archived') {
      logInfo(ctx, `pending deletion canceled (no longer archived): ${entry.id}`);
      continue;
    }
    remaining.push(entry);
    logInfo(
      ctx,
      `pending deletion deferred for ${entry.id}: `
      + `${outcome.body?.code ?? String(outcome.status)} ${outcome.body?.message ?? ''}`.trim(),
    );
  }

  try {
    await writePendingDeletes(state.root, remaining);
  } catch (error) {
    try {
      ctx.logger?.error?.(`session-manager: cannot update pending deletions: ${messageOf(error)}`);
    } catch {
      /* logging is not part of the contract */
    }
  }
  if (removed > 0) {
    try {
      ctx.logger?.info?.(`session-manager: completed ${removed} pending deletion(s) at startup`);
    } catch {
      /* logging is not part of the contract */
    }
  }
}

function logInfo(ctx, text) {
  try {
    ctx.logger?.info?.(`session-manager: ${text}`);
  } catch {
    /* logging is not part of the contract */
  }
}

/** Ask the composition's connection service before serving any route. */
function rejectionStatus(ctx, request) {
  try {
    return typeof ctx.connection?.requestRejection === 'function'
      ? ctx.connection.requestRejection(request)
      : 403;
  } catch {
    return 403;
  }
}

/** The archived ids the workspace registry exposes, deduped and shape-checked. */
function archivedSessionIdsOf(ctx) {
  const ids = Array.isArray(ctx.workspaceRegistry?.archivedSessionIds)
    ? ctx.workspaceRegistry.archivedSessionIds
    : [];
  return [...new Set(ids.filter(isSessionId))];
}

function batchResultOf(sessionId, outcome) {
  const body = outcome?.body && typeof outcome.body === 'object' ? outcome.body : {};
  if (outcome?.status === 200) {
    return {
      sessionId,
      status: 'deleted',
      removedChildSessions: Array.isArray(body.removedChildSessions) ? body.removedChildSessions : [],
      warnings: Array.isArray(body.warnings) ? body.warnings : [],
      boundSchedules: body.boundSchedules,
    };
  }
  if (outcome?.status === 202) {
    return {
      sessionId,
      status: 'scheduled',
      code: body.code || 'restart-required',
      message: body.message,
    };
  }
  if (outcome?.status === 409) {
    return {
      sessionId,
      status: 'skipped',
      code: body.code || 'session-active',
      message: body.message,
    };
  }
  if (body.code === 'not-archived') {
    return { sessionId, status: 'skipped', code: body.code, message: body.message };
  }
  return {
    sessionId,
    status: 'failed',
    code: body.code || 'delete-failed',
    message: body.message || `HTTP ${outcome?.status ?? 500}`,
  };
}

async function deleteArchivedSessionBatch(ctx, sessionIds, moveToTrash = false) {
  const results = [];
  for (const sessionId of sessionIds) {
    try {
      const outcome = await deleteArchivedSession(ctx, sessionId, {
        schedule: true,
        moveToTrash: moveToTrash === true,
      });
      results.push(batchResultOf(sessionId, outcome));
    } catch (error) {
      results.push({
        sessionId,
        status: 'failed',
        code: 'delete-failed',
        message: messageOf(error),
      });
    }
  }
  return results;
}

/**
 * Every subagent session whose parent chain reaches a known session, mapped
 * to its direct parent. Nested subagents resolve to a fixed point. When the
 * backend cannot list sessions at all, `supported` is false and callers must
 * not guess about raw-UUID directories.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - owning Host context.
 * @param {Set<string>} known - registry/archived/pinned/pending session ids.
 * @returns {Promise<{supported: boolean, ids: Map<string, string>, children: Set<string>}>}
 */
async function listKnownSubagentIds(ctx, known) {
  const persistence = ctx.sessionPersistence;
  if (!persistence || typeof persistence.list !== 'function') {
    return { supported: false, ids: new Map(), children: new Set() };
  }
  const listed = await persistence.list();
  const headers = [];
  for (const snapshot of Array.isArray(listed) ? listed : []) {
    const header = snapshot?.header;
    if (!header || header.origin !== 'subagent') continue;
    if (typeof header.id !== 'string' || header.id === '') continue;
    if (typeof header.parentSession !== 'string' || header.parentSession === '') continue;
    headers.push({ id: header.id, parent: header.parentSession });
  }
  const ids = new Map();
  let changed = true;
  while (changed) {
    changed = false;
    for (const { id, parent } of headers) {
      if (ids.has(id)) continue;
      if (!known.has(parent) && !ids.has(parent)) continue;
      ids.set(id, parent);
      changed = true;
    }
  }
  return { supported: true, ids, children: new Set(ids.keys()) };
}

/**
 * The authoritative id sets for a cleanup scan or revalidation. Throws when
 * any authority is unavailable: guessing here could delete a live session.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - owning Host context.
 * @returns {Promise<{known: Set<string>, subagents: {supported: boolean, ids: Map<string, string>}}>}
 */
async function cleanupKnownState(ctx) {
  const registry = ctx.workspaceRegistry;
  if (!registry || typeof registry.list !== 'function') {
    throw new Error('workspace registry is unavailable');
  }
  const pendingState = await readPendingDeletes(ctx);
  if (pendingState.corrupt) {
    throw new Error(`pending-delete store is unreadable: ${pendingState.message}`);
  }
  const listed = registry.list();
  if (!Array.isArray(listed)) throw new Error('workspace registry listing is unavailable');
  const known = new Set();
  for (const entity of listed) {
    const ids = Array.isArray(entity?.sessionIds) ? entity.sessionIds : [];
    for (const id of ids) if (typeof id === 'string' && id !== '') known.add(id);
  }
  for (const id of archivedSessionIdsOf(ctx)) known.add(id);
  try {
    const pinned = registry.pinnedSessionIds;
    if (Array.isArray(pinned)) {
      for (const id of pinned) if (typeof id === 'string' && id !== '') known.add(id);
    }
  } catch {
    /* pins never authorize a delete on their own */
  }
  for (const entry of pendingState.entries) known.add(entry.id);
  const subagents = await listKnownSubagentIds(ctx, known);
  return { known, subagents };
}

/**
 * True only when neither the session nor its direct parent subagent session
 * is held by this Host. Unknown liveness is treated as live (skip the row).
 */
function isProvablyIdle(ctx, sessionId, subagents) {
  let live;
  try {
    live = liveState(ctx, sessionId);
  } catch {
    return false;
  }
  if (live.live) return false;
  const parent = subagents.ids.get(sessionId);
  if (parent !== undefined) {
    try {
      if (liveState(ctx, parent).live) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * Enumerate leftover files a one-click cleanup may remove. Only session
 * directories that are provably not part of the workspace (not registered,
 * not archived, not pinned, not pending deletion, not a subagent of one of
 * those) plus tombstones and provably idle empty directories are reported.
 * Attachments are content-addressed and shared across sessions, so they are
 * never candidates.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - owning Host context.
 * @returns {Promise<{items: {path: string, kind: string, reason?: string}[], truncated: boolean, warnings: string[]}>}
 */
async function scanCleanupItems(ctx) {
  let root;
  try {
    root = ctx.sessionPersistence?.root;
  } catch {
    root = undefined;
  }
  if (typeof root !== 'string' || root === '') throw new Error('session root is unavailable');

  const { known, subagents } = await cleanupKnownState(ctx);
  const warnings = [];
  if (!subagents.supported) {
    warnings.push('subagent session listing is unavailable; raw subagent directories are skipped');
  }

  const items = [];
  const seen = new Set();
  const addItem = (path, kind, reason) => {
    if (items.length > MAX_CLEANUP_ITEMS) return;
    if (seen.has(path)) return;
    seen.add(path);
    items.push(reason === undefined ? { path, kind } : { path, kind, reason });
  };

  let projectEntries;
  try {
    projectEntries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error && error.code === 'ENOENT') return { items: [], truncated: false, warnings };
    throw error;
  }

  for (const project of projectEntries) {
    if (!project.isDirectory() || !isEncodedProjectKey(project.name)) continue;
    const projectPath = join(root, project.name);
    let entries;
    try {
      entries = await readdir(projectPath, { withFileTypes: true });
    } catch (error) {
      warnings.push(`cannot read a project directory: ${messageOf(error)}`);
      continue;
    }
    for (const entry of entries) {
      if (entry.isFile() && TOMBSTONE_FILE_PATTERN.test(entry.name)) {
        addItem(join(projectPath, entry.name), 'tombstone');
      }
    }
    if (entries.length === 0) {
      // A project key never exists without at least one session; an empty one
      // is what a delete leaves behind.
      addItem(projectPath, 'empty-dir');
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dirPath = join(projectPath, entry.name);
      let children;
      try {
        children = await readdir(dirPath);
      } catch (error) {
        warnings.push(`cannot read a session directory: ${messageOf(error)}`);
        continue;
      }
      for (const child of children) {
        if (TOMBSTONE_FILE_PATTERN.test(child)) addItem(join(dirPath, child), 'tombstone');
      }
      if (!subagents.supported && SUBAGENT_ID_SHAPE.test(entry.name)) continue;
      const classification = classifySessionDir(entry.name, known, subagents.children);
      if (!classification.known) {
        addItem(dirPath, 'session-dir', classification.reason);
        continue;
      }
      if (children.length === 0 && isProvablyIdle(ctx, entry.name, subagents)) {
        addItem(dirPath, 'empty-dir');
      }
    }
  }

  const truncated = items.length > MAX_CLEANUP_ITEMS;
  return { items: items.slice(0, MAX_CLEANUP_ITEMS), truncated, warnings };
}

/**
 * Re-check one requested cleanup path against the current authorities. This
 * is the TOCTOU fence for the POST route: a path that stopped being a
 * provable leftover, or became live, is refused item by item.
 *
 * @returns {Promise<{ok: true, isDir: boolean} | {ok: false, message: string}>}
 */
async function revalidateCleanupItem(ctx, target, relativePath, fresh) {
  const parts = relativePath.split(/[\\/]+/).filter((part) => part !== '' && part !== '.');
  if (parts.length === 0 || parts.length > 3) {
    return { ok: false, message: 'unexpected cleanup path' };
  }
  if (!isEncodedProjectKey(parts[0])) {
    return { ok: false, message: 'not a session-file location' };
  }
  let info;
  try {
    info = await stat(target);
  } catch (error) {
    return {
      ok: false,
      message: error?.code === 'ENOENT'
        ? 'the path no longer exists'
        : `cannot inspect the path: ${messageOf(error)}`,
    };
  }
  if (parts.length === 1) {
    if (!info.isDirectory()) return { ok: false, message: 'not a cleanup candidate' };
    try {
      const entries = await readdir(target);
      return entries.length === 0
        ? { ok: true, isDir: true }
        : { ok: false, message: 'the directory is not empty' };
    } catch (error) {
      return { ok: false, message: `cannot read the path: ${messageOf(error)}` };
    }
  }
  if (info.isFile()) {
    if (TOMBSTONE_FILE_PATTERN.test(parts[parts.length - 1])) {
      return { ok: true, isDir: false };
    }
    return { ok: false, message: 'not a cleanup candidate' };
  }
  if (!info.isDirectory() || parts.length !== 2) {
    return { ok: false, message: 'not a cleanup candidate' };
  }
  const name = parts[1];
  if (!fresh.subagents.supported && SUBAGENT_ID_SHAPE.test(name)) {
    return { ok: false, message: 'subagent sessions cannot be classified' };
  }
  const classification = classifySessionDir(name, fresh.known, fresh.subagents.children);
  if (!classification.known) return { ok: true, isDir: true };
  try {
    const entries = await readdir(target);
    if (entries.length > 0) return { ok: false, message: 'the session directory is not empty' };
  } catch (error) {
    return { ok: false, message: `cannot read the path: ${messageOf(error)}` };
  }
  if (!isProvablyIdle(ctx, name, fresh.subagents)) {
    return { ok: false, message: 'the session is still open' };
  }
  return { ok: true, isDir: true };
}

async function removePermanently(target, isDir) {
  try {
    await rm(target, { recursive: isDir, force: true });
    return { ok: true };
  } catch (error) {
    return { ok: false, message: messageOf(error) };
  }
}

/**
 * Validate every requested path, then move the survivors to the Recycle Bin
 * (one PowerShell invocation per chunk). The Recycle Bin being unavailable,
 * or refusing one item, degrades that item to a permanent delete.
 *
 * @returns {Promise<{path: string, status: 'moved' | 'failed', message?: string}[]>}
 */
async function executeCleanup(ctx, paths) {
  let root;
  try {
    root = ctx.sessionPersistence?.root;
  } catch {
    root = undefined;
  }
  if (typeof root !== 'string' || root === '') throw new Error('session root is unavailable');
  const fresh = await cleanupKnownState(ctx);
  let realRoot;
  try {
    realRoot = await realpath(root);
  } catch {
    realRoot = resolve(root);
  }

  const entries = [];
  for (const original of paths) {
    const safe = safePathWithinRoot(original, root);
    if (!safe.ok) {
      entries.push({ original, failure: safe.message });
      continue;
    }
    let real;
    try {
      real = await realpath(safe.path);
    } catch (error) {
      entries.push({
        original,
        failure: error?.code === 'ENOENT'
          ? 'the path no longer exists'
          : `cannot resolve the path: ${messageOf(error)}`,
      });
      continue;
    }
    const rel = relative(realRoot, real);
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
      entries.push({ original, failure: 'the path escapes the session root' });
      continue;
    }
    const verdict = await revalidateCleanupItem(ctx, real, rel, fresh);
    if (!verdict.ok) {
      entries.push({ original, failure: verdict.message });
      continue;
    }
    entries.push({ original, path: real, isDir: verdict.isDir });
  }

  const targets = entries.filter((entry) => entry.failure === undefined);
  const outcomes = new Map();
  if (targets.length > 0) {
    const recycled = await recycleBinItems(
      targets.map(({ path, isDir }) => ({ path, isDir })),
    );
    for (const target of targets) {
      if (recycled.ok) {
        const outcome = recycled.results.get(target.path);
        if (outcome?.moved) {
          outcomes.set(target.original, { status: 'moved' });
          continue;
        }
      }
      const fallback = await removePermanently(target.path, target.isDir);
      const why = recycled.ok
        ? `the Recycle Bin refused the item (${recycled.results.get(target.path)?.reason || 'no result'})`
        : `the Recycle Bin was unavailable (${recycled.reason})`;
      outcomes.set(target.original, fallback.ok
        ? { status: 'moved', message: `${why}; it was permanently removed` }
        : { status: 'failed', message: fallback.message });
    }
  }

  return entries.map((entry) => {
    if (entry.failure !== undefined) {
      return { path: entry.original, status: 'failed', message: entry.failure };
    }
    const outcome = outcomes.get(entry.original) ?? { status: 'failed', message: 'no result' };
    return { path: entry.original, ...outcome };
  });
}

/**
 * Register the delete route. Every failure path is contained: this function
 * never rejects into the Loader.
 * @param {import('@deepseek-ai/cordis').Context} ctx - owning Host context.
 */
export function apply(ctx) {
  /** Serializes deletions so two requests can never race the same log. */
  let tail = Promise.resolve();
  const serialize = (job) => {
    const run = tail.then(job, job);
    tail = run.then(() => undefined, () => undefined);
    return run;
  };

  const handler = async (request, response) => {
    try {
      const rejection = rejectionStatus(ctx, request);
      if (rejection !== undefined) {
        response.statusCode = rejection;
        response.end();
        return;
      }

      if (request.method !== 'POST') {
        response.statusCode = 405;
        response.setHeader('allow', 'POST');
        response.end();
        return;
      }

      const contentType = String(request.headers?.['content-type'] ?? '').toLowerCase();
      if (!contentType.startsWith('application/json')) {
        sendJson(response, 415, {
          ok: false,
          code: 'bad-request',
          message: 'content-type must be application/json',
        });
        return;
      }

      const text = await readBoundedBody(request, MAX_DELETE_BODY_BYTES);
      if (text === null) {
        sendJson(response, 413, {
          ok: false,
          code: 'bad-request',
          message: 'request body is too large',
        });
        return;
      }

      const single = parseDeleteRequest(text);
      if (single.ok) {
        const outcome = await serialize(() => deleteArchivedSession(ctx, single.sessionId, {
          moveToTrash: single.moveToTrash === true,
        }));
        sendJson(response, outcome.status, outcome.body);
        return;
      }

      const batch = parseBatchDeleteRequest(text);
      if (!batch.ok) {
        sendJson(response, 400, batch);
        return;
      }

      const results = await serialize(
        () => deleteArchivedSessionBatch(ctx, batch.sessionIds, batch.moveToTrash === true),
      );
      sendJson(response, 200, { ok: true, results });
    } catch (error) {
      try {
        ctx.logger?.error?.(`session-manager: delete route failed: ${messageOf(error)}`);
      } catch {
        /* ignore */
      }
      sendJson(response, 500, {
        ok: false,
        code: 'delete-failed',
        message: messageOf(error),
      });
    }
  };

  try {
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: ROUTE_PATH,
      handler,
    }), 'session-manager: archived-session delete route');
  } catch (error) {
    try {
      ctx.logger?.error?.(`session-manager: cannot register delete route: ${messageOf(error)}`);
    } catch {
      /* ignore */
    }
  }

  const archivedHandler = async (request, response) => {
    try {
      const rejection = rejectionStatus(ctx, request);
      if (rejection !== undefined) {
        response.statusCode = rejection;
        response.end();
        return;
      }
      if (request.method !== 'GET') {
        response.statusCode = 405;
        response.setHeader('allow', 'GET');
        response.end();
        return;
      }
      sendJson(response, 200, { ok: true, sessions: archivedSessionIdsOf(ctx) });
    } catch (error) {
      try {
        ctx.logger?.error?.(`session-manager: archived list route failed: ${messageOf(error)}`);
      } catch {
        /* ignore */
      }
      sendJson(response, 500, {
        ok: false,
        code: 'list-failed',
        message: messageOf(error),
      });
    }
  };

  try {
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: ARCHIVED_PATH,
      handler: archivedHandler,
    }), 'session-manager: archived-session list route');
  } catch (error) {
    try {
      ctx.logger?.error?.(`session-manager: cannot register archived list route: ${messageOf(error)}`);
    } catch {
      /* ignore */
    }
  }

  const cleanupHandler = async (request, response) => {
    try {
      const rejection = rejectionStatus(ctx, request);
      if (rejection !== undefined) {
        response.statusCode = rejection;
        response.end();
        return;
      }

      if (request.method === 'GET') {
        const scan = await scanCleanupItems(ctx);
        let root;
        try {
          root = ctx.sessionPersistence?.root;
        } catch {
          root = undefined;
        }
        sendJson(response, 200, {
          ok: true,
          root: typeof root === 'string' ? root : '',
          items: scan.items,
          truncated: scan.truncated,
          warnings: scan.warnings,
        });
        return;
      }

      if (request.method !== 'POST') {
        response.statusCode = 405;
        response.setHeader('allow', 'GET, POST');
        response.end();
        return;
      }

      const contentType = String(request.headers?.['content-type'] ?? '').toLowerCase();
      if (!contentType.startsWith('application/json')) {
        sendJson(response, 415, {
          ok: false,
          code: 'bad-request',
          message: 'content-type must be application/json',
        });
        return;
      }
      const text = await readBoundedBody(request, MAX_DELETE_BODY_BYTES);
      if (text === null) {
        sendJson(response, 413, {
          ok: false,
          code: 'bad-request',
          message: 'request body is too large',
        });
        return;
      }
      const parsed = parseCleanupRequest(text);
      if (!parsed.ok) {
        sendJson(response, 400, parsed);
        return;
      }
      const results = await serialize(() => executeCleanup(ctx, parsed.paths));
      sendJson(response, 200, { ok: true, results });
    } catch (error) {
      try {
        ctx.logger?.error?.(`session-manager: cleanup route failed: ${messageOf(error)}`);
      } catch {
        /* ignore */
      }
      sendJson(response, 500, {
        ok: false,
        code: 'cleanup-failed',
        message: messageOf(error),
      });
    }
  };

  try {
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: CLEANUP_PATH,
      handler: cleanupHandler,
    }), 'session-manager: leftover-file cleanup route');
  } catch (error) {
    try {
      ctx.logger?.error?.(`session-manager: cannot register cleanup route: ${messageOf(error)}`);
    } catch {
      /* ignore */
    }
  }

  const openPathHandler = async (request, response) => {
    try {
      const rejection = rejectionStatus(ctx, request);
      if (rejection !== undefined) {
        response.statusCode = rejection;
        response.end();
        return;
      }
      if (request.method !== 'POST') {
        response.statusCode = 405;
        response.setHeader('allow', 'POST');
        response.end();
        return;
      }
      const contentType = String(request.headers?.['content-type'] ?? '').toLowerCase();
      if (!contentType.startsWith('application/json')) {
        sendJson(response, 415, {
          ok: false,
          code: 'bad-request',
          message: 'content-type must be application/json',
        });
        return;
      }
      const text = await readBoundedBody(request, MAX_DELETE_BODY_BYTES);
      if (text === null) {
        sendJson(response, 413, {
          ok: false,
          code: 'bad-request',
          message: 'request body is too large',
        });
        return;
      }
      const parsed = parseOpenPathRequest(text);
      if (!parsed.ok) {
        sendJson(response, 400, parsed);
        return;
      }
      if (typeof process !== 'undefined' && process.platform !== 'win32') {
        sendJson(response, 400, {
          ok: false,
          code: 'unsupported',
          message: 'opening a file location is supported on Windows only',
        });
        return;
      }
      let root;
      try {
        root = ctx.sessionPersistence?.root;
      } catch {
        root = undefined;
      }
      if (typeof root !== 'string' || root === '') {
        sendJson(response, 500, {
          ok: false,
          code: 'open-failed',
          message: 'session root is unavailable',
        });
        return;
      }
      const safe = safePathWithinRoot(parsed.path, root);
      if (!safe.ok) {
        sendJson(response, 400, { ok: false, code: 'bad-request', message: safe.message });
        return;
      }
      let real;
      try {
        real = await realpath(safe.path);
      } catch (error) {
        sendJson(response, error?.code === 'ENOENT' ? 404 : 500, {
          ok: false,
          code: error?.code === 'ENOENT' ? 'not-found' : 'open-failed',
          message: error?.code === 'ENOENT'
            ? 'the path no longer exists'
            : `cannot resolve the path: ${messageOf(error)}`,
        });
        return;
      }
      let realRoot;
      try {
        realRoot = await realpath(root);
      } catch {
        realRoot = resolve(root);
      }
      const rel = relative(realRoot, real);
      if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
        sendJson(response, 400, {
          ok: false,
          code: 'bad-request',
          message: 'the path escapes the session root',
        });
        return;
      }
      let info;
      try {
        info = await stat(real);
      } catch (error) {
        sendJson(response, 500, {
          ok: false,
          code: 'open-failed',
          message: `cannot inspect the path: ${messageOf(error)}`,
        });
        return;
      }
      const uri = explorerTarget(real);
      const argv = [info.isDirectory() ? uri : `/select,${uri}`];
      const outcome = await runSpawn('explorer.exe', argv, 'open-path');
      if (!outcome.ok) {
        sendJson(response, 500, {
          ok: false,
          code: 'open-failed',
          message: outcome.message || 'Explorer could not open the location',
        });
        return;
      }
      sendJson(response, 200, { ok: true, opened: true, path: real });
    } catch (error) {
      try {
        ctx.logger?.error?.(`session-manager: open-path route failed: ${messageOf(error)}`);
      } catch {
        /* ignore */
      }
      sendJson(response, 500, {
        ok: false,
        code: 'open-failed',
        message: messageOf(error),
      });
    }
  };

  try {
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: OPEN_PATH,
      handler: openPathHandler,
    }), 'session-manager: open-file-location route');
  } catch (error) {
    try {
      ctx.logger?.error?.(`session-manager: cannot register open-path route: ${messageOf(error)}`);
    } catch {
      /* ignore */
    }
  }

  // Replay scheduled deletions after startup. The route's serialization queue
  // makes a concurrent request wait behind (or ahead of) the replay.
  try {
    void serialize(() => processPendingDeletes(ctx)).catch((error) => {
      try {
        ctx.logger?.error?.(`session-manager: pending-deletion startup failed: ${messageOf(error)}`);
      } catch {
        /* ignore */
      }
    });
  } catch (error) {
    try {
      ctx.logger?.error?.(`session-manager: cannot start pending-deletion replay: ${messageOf(error)}`);
    } catch {
      /* ignore */
    }
  }
}
