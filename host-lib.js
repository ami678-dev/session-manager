/**
 * Pure Host-side helpers for @local/session-manager.
 *
 * Nothing in this module touches Cordis, the profile, or the real session
 * store: the safety rules for the irreversible delete route are unit-testable
 * without activating the plugin. `index.js` is the only file that performs
 * I/O, and it only calls these helpers after they have accepted an input.
 *
 * @module @local/session-manager/host-lib
 */

import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';

/** Maximum accepted JSON body for the delete route. */
export const MAX_DELETE_BODY_BYTES = 16 * 1024;

/**
 * Top-level session identities created by the Harness are `session-<uuid>`.
 * Subagent sessions use a bare UUID and never pass this request-id boundary;
 * their internal paths are validated by {@link safeArtifactPath} instead.
 * Keeping the request pattern strict is a security boundary: the id becomes a
 * path segment before the log is removed.
 */
const SESSION_ID_RE = /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Canonical generation log file names written by the JSONL backend: version
 * zero keeps `session.jsonl`, every later generation carries a lowercase
 * numeric `.vN` component without a leading zero (see the backend's
 * `sessionFormatLogFilename` and `parseSessionFormatLogFilename`).
 */
export const SESSION_LOG_FILE_PATTERN = /^session(?:\.v[1-9]\d*)?\.jsonl(?:\.zstd)?$/;

/** Whether a value is a session identity this plugin is willing to address. */
export function isSessionId(value) {
  return typeof value === 'string' && SESSION_ID_RE.test(value);
}

/**
 * Encode one path segment exactly like the JSONL session backend does.
 * For the shipped `session-<uuid>` ids this is the identity function, but
 * mirroring the rule keeps the parent-directory check correct for any id
 * that ever carries a non-safe code unit.
 */
export function encodeSegment(raw) {
  if (typeof raw !== 'string' || raw === '') return '';
  if (raw === '.') return '~002E';
  if (raw === '..') return '~002E~002E';
  let out = '';
  for (let index = 0; index < raw.length; index += 1) {
    const code = raw.charCodeAt(index);
    const ch = String.fromCharCode(code);
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch;
    else out += `~${code.toString(16).toUpperCase().padStart(4, '0')}`;
  }
  return out;
}

/**
 * Parse and validate the delete route body.
 *
 * `moveToTrash` is optional (default false). When true the caller moves the
 * log files to the Recycle Bin instead of deleting them permanently; when the
 * Recycle Bin is unavailable it degrades to permanent removal, so the flag
 * never weakens the confirmation contract.
 * @param {string} text - raw request body.
 * @returns {{ok: true, sessionId: string, moveToTrash: boolean} | {ok: false, code: 'bad-request', message: string}}
 */
export function parseDeleteRequest(text) {
  if (typeof text !== 'string' || text === '') {
    return { ok: false, code: 'bad-request', message: 'body is empty' };
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return { ok: false, code: 'bad-request', message: 'body is not JSON' };
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, code: 'bad-request', message: 'body must be a JSON object' };
  }
  if (body.confirm !== true) {
    return { ok: false, code: 'bad-request', message: 'confirm must be true' };
  }
  if (body.moveToTrash !== undefined && typeof body.moveToTrash !== 'boolean') {
    return { ok: false, code: 'bad-request', message: 'moveToTrash must be a boolean' };
  }
  if (!isSessionId(body.sessionId)) {
    return { ok: false, code: 'bad-request', message: 'sessionId is invalid' };
  }
  return { ok: true, sessionId: body.sessionId, moveToTrash: body.moveToTrash === true };
}

/** Upper bound for one batch request; keeps the atomic marker write bounded. */
export const MAX_BATCH_DELETE = 100;

/**
 * Parse and validate a batch delete body. Duplicate ids are collapsed so one
 * request can never race itself on the same log.
 * @param {string} text - raw request body.
 * @returns {{ok: true, sessionIds: string[], moveToTrash: boolean} | {ok: false, code: 'bad-request', message: string}}
 */
export function parseBatchDeleteRequest(text) {
  if (typeof text !== 'string' || text === '') {
    return { ok: false, code: 'bad-request', message: 'body is empty' };
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return { ok: false, code: 'bad-request', message: 'body is not JSON' };
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, code: 'bad-request', message: 'body must be a JSON object' };
  }
  if (body.confirm !== true) {
    return { ok: false, code: 'bad-request', message: 'confirm must be true' };
  }
  if (body.moveToTrash !== undefined && typeof body.moveToTrash !== 'boolean') {
    return { ok: false, code: 'bad-request', message: 'moveToTrash must be a boolean' };
  }
  if (!Array.isArray(body.sessionIds)) {
    return { ok: false, code: 'bad-request', message: 'sessionIds must be an array' };
  }
  if (body.sessionIds.length === 0) {
    return { ok: false, code: 'bad-request', message: 'sessionIds must not be empty' };
  }
  if (body.sessionIds.length > MAX_BATCH_DELETE) {
    return { ok: false, code: 'bad-request', message: 'too many sessionIds' };
  }
  const sessionIds = [];
  const seen = new Set();
  for (const id of body.sessionIds) {
    if (!isSessionId(id)) {
      return { ok: false, code: 'bad-request', message: 'sessionIds contains an invalid id' };
    }
    if (!seen.has(id)) {
      seen.add(id);
      sessionIds.push(id);
    }
  }
  return { ok: true, sessionIds, moveToTrash: body.moveToTrash === true };
}

/**
 * Read a request body up to `limit` bytes.
 * @param {AsyncIterable<Uint8Array|string>} stream - request stream.
 * @param {number} [limit] - maximum accepted bytes.
 * @returns {Promise<string|null>} UTF-8 text, or `null` when the limit was exceeded.
 */
export async function readBoundedBody(stream, limit = MAX_DELETE_BODY_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    const bytes = typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.byteLength;
    size += bytes;
    if (size > limit) {
      try {
        stream.resume?.();
      } catch {
        /* the caller answers 413; draining is best effort */
      }
      return null;
    }
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks, size).toString('utf8');
}

/**
 * Verify that an artifact path produced by `sessionPersistence.stat(id)` is
 * exactly the log file of that session, and never an arbitrary path.
 *
 * Rules:
 * - the candidate must be absolute;
 * - the file name must be a canonical JSONL generation name;
 * - the containing directory must be the encoded session id;
 * - the project directory above it must be a workspace key or `_no-cwd`;
 * - when the backend root is known, the file must live three levels below it
 *   and must not escape it.
 *
 * @param {string} candidate - `snapshot.location.path`.
 * @param {string} sessionId - the archived session requested for deletion.
 * @param {string} [root] - the persistence backend root, when readable.
 * @returns {{ok: true, file: string, dir: string, projectDir: string} | {ok: false, message: string}}
 */
export function safeArtifactTarget(candidate, sessionId, root) {
  if (!isSessionId(sessionId)) return { ok: false, message: 'invalid session id' };
  return safeArtifactPath(candidate, sessionId, root);
}

/**
 * Whether a directory name is a project-key directory written by the JSONL
 * backend (`--<escaped cwd>--`, or `_no-cwd` for sessions without one).
 * Foreign names inside the session root are ignored by cleanup scans.
 * @param {string} name - directory name.
 * @returns {boolean}
 */
export function isEncodedProjectKey(name) {
  return typeof name === 'string'
    && (name === '_no-cwd' || (name.startsWith('--') && name.endsWith('--')));
}

/**
 * The same path proof as {@link safeArtifactTarget}, for an internal id the
 * persistence backend itself reported (a subagent id is a bare UUID, which
 * the strict request-id pattern deliberately refuses). The id still has to
 * encode to the directory name and the path still has to stay under `root`.
 * @param {string} candidate - artifact path reported by the persistence backend.
 * @param {string} sessionId - any non-empty stored session id.
 * @param {string} [root] - the persistence backend root, when readable.
 * @returns {{ok: true, file: string, dir: string, projectDir: string} | {ok: false, message: string}}
 */
export function safeArtifactPath(candidate, sessionId, root) {
  if (typeof sessionId !== 'string' || sessionId === '') return { ok: false, message: 'invalid session id' };
  if (typeof candidate !== 'string' || candidate === '') return { ok: false, message: 'no artifact path' };
  if (!isAbsolute(candidate)) return { ok: false, message: 'artifact path is not absolute' };

  const file = resolve(candidate);
  const dir = dirname(file);
  const name = basename(file);
  if (!SESSION_LOG_FILE_PATTERN.test(name)) return { ok: false, message: 'unexpected log file name' };
  if (basename(dir) !== encodeSegment(sessionId)) {
    return { ok: false, message: 'log file is not inside its session directory' };
  }

  const projectDir = basename(dirname(dir));
  if (!isEncodedProjectKey(projectDir)) {
    return { ok: false, message: 'unexpected project directory' };
  }

  if (typeof root === 'string' && root !== '') {
    if (!isAbsolute(root)) return { ok: false, message: 'session root is not absolute' };
    const baseRoot = resolve(root);
    const rel = relative(baseRoot, file);
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
      return { ok: false, message: 'log path escapes the session root' };
    }
    const parts = rel.split(sep);
    if (parts.length !== 3) return { ok: false, message: 'unexpected session log depth' };
  }

  return { ok: true, file, dir, projectDir };
}

/**
 * Count scheduled tasks that still reference any of the given sessions.
 * Read-only; the caller never edits schedule records. A task hitting several
 * removed ids (its target plus the acting session) is counted once.
 * @param {readonly any[]} catalog - `ctx.schedule.catalog()` result.
 * @param {readonly string[]} sessionIds - sessions being deleted.
 * @returns {{count: number, titles: string[]}}
 */
export function boundSchedulesFor(catalog, sessionIds) {
  if (!Array.isArray(catalog)) return { count: 0, titles: [] };
  const idSet = new Set(sessionIds);
  const seen = new Set();
  const titles = [];
  for (const [index, entry] of catalog.entries()) {
    if (typeof entry !== 'object' || entry === null) continue;
    const targetHit = entry.target
      && entry.target.kind === 'session'
      && idSet.has(entry.target.sessionId);
    const involvedHit = Array.isArray(entry.involvedSessionIds)
      && entry.involvedSessionIds.some((id) => idSet.has(id));
    if (!targetHit && !involvedHit) continue;
    const key = typeof entry.id === 'string' ? entry.id : `#${index}`;
    if (seen.has(key)) continue;
    seen.add(key);
    titles.push(typeof entry.title === 'string' ? entry.title : String(entry.id ?? ''));
  }
  return { count: titles.length, titles };
}

/**
 * Count scheduled tasks that still reference one session.
 * @param {readonly any[]} catalog - `ctx.schedule.catalog()` result.
 * @param {string} sessionId - session being deleted.
 * @returns {{count: number, titles: string[]}}
 */
export function countBoundSchedules(catalog, sessionId) {
  return boundSchedulesFor(catalog, [sessionId]);
}

/** Upper bound on leftover items one cleanup request may act on. */
export const MAX_CLEANUP_ITEMS = 200;

/**
 * Tombstone suffix marker used while a session log is staged for removal
 * (`<file>.sm-delete-<uuid>`). A file still carrying this marker was left
 * behind by an interrupted deletion and is a cleanup candidate.
 */
export const TOMBSTONE_FILE_PATTERN = /\.sm-delete-/;

/** Bare-UUID identities are subagent sessions created by the backend. */
const SUBAGENT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseJsonObject(text) {
  if (typeof text !== 'string' || text === '') return { ok: false, message: 'body is empty' };
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return { ok: false, message: 'body is not JSON' };
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, message: 'body must be a JSON object' };
  }
  return { ok: true, body };
}

/**
 * Parse and validate a cleanup request. `confirm` is the same deliberate
 * fence as the delete route; `paths` must be a bounded list of non-empty
 * strings, deduplicated in order.
 * @param {string} text - raw request body.
 * @returns {{ok: true, paths: string[]} | {ok: false, code: 'bad-request', message: string}}
 */
export function parseCleanupRequest(text) {
  const parsed = parseJsonObject(text);
  if (!parsed.ok) return { ok: false, code: 'bad-request', message: parsed.message };
  const { body } = parsed;
  if (body.confirm !== true) {
    return { ok: false, code: 'bad-request', message: 'confirm must be true' };
  }
  if (!Array.isArray(body.paths)) {
    return { ok: false, code: 'bad-request', message: 'paths must be an array' };
  }
  if (body.paths.length === 0) {
    return { ok: false, code: 'bad-request', message: 'paths must not be empty' };
  }
  if (body.paths.length > MAX_CLEANUP_ITEMS) {
    return { ok: false, code: 'bad-request', message: 'too many paths' };
  }
  const paths = [];
  const seen = new Set();
  for (const value of body.paths) {
    if (typeof value !== 'string' || value === '') {
      return { ok: false, code: 'bad-request', message: 'paths contains an invalid path' };
    }
    if (!seen.has(value)) {
      seen.add(value);
      paths.push(value);
    }
  }
  return { ok: true, paths };
}

/**
 * Parse and validate an open-location request.
 * @param {string} text - raw request body.
 * @returns {{ok: true, path: string} | {ok: false, code: 'bad-request', message: string}}
 */
export function parseOpenPathRequest(text) {
  const parsed = parseJsonObject(text);
  if (!parsed.ok) return { ok: false, code: 'bad-request', message: parsed.message };
  if (typeof parsed.body.path !== 'string' || parsed.body.path === '') {
    return { ok: false, code: 'bad-request', message: 'path is invalid' };
  }
  return { ok: true, path: parsed.body.path };
}

/**
 * Prove that a path stays strictly inside the session root.
 *
 * Unlike {@link safeArtifactPath} this does not require the log-file shape:
 * cleanup items are whole session directories, tombstones, and empty project
 * directories. It still refuses anything that is not absolute, carries a raw
 * `..` segment, equals the root, or resolves outside it.
 * @param {string} candidate - path from the cleanup request.
 * @param {string} root - the persistence backend root.
 * @returns {{ok: true, path: string, relative: string} | {ok: false, message: string}}
 */
export function safePathWithinRoot(candidate, root) {
  if (typeof candidate !== 'string' || candidate === '') return { ok: false, message: 'path is empty' };
  if (typeof root !== 'string' || root === '') return { ok: false, message: 'session root is unavailable' };
  if (!isAbsolute(candidate)) return { ok: false, message: 'path is not absolute' };
  if (!isAbsolute(root)) return { ok: false, message: 'session root is not absolute' };
  if (candidate.split(/[\\/]+/).includes('..')) {
    return { ok: false, message: 'path contains a parent segment' };
  }
  const baseRoot = resolve(root);
  const target = resolve(candidate);
  const rel = relative(baseRoot, target);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    return { ok: false, message: 'path escapes the session root' };
  }
  return { ok: true, path: target, relative: rel };
}

/**
 * Classify one directory name found under a project key.
 *
 * The workspace registry only tracks top-level `session-<uuid>` identities;
 * subagent sessions are bare UUIDs visible only through the persistence
 * listing. A bare UUID is safe to report as leftover only when its parent is
 * gone, which the caller encodes by leaving it out of `subagentChildren`.
 * @param {string} dirName - directory name.
 * @param {Set<string>|readonly string[]} knownIds - registry/queue ids.
 * @param {Set<string>|readonly string[]} subagentChildren - bare-UUID ids
 *   whose parent session is known.
 * @returns {{known: true, kind?: 'subagent'} | {known: false, reason: 'unknown' | 'subagent-orphan'}}
 */
export function classifySessionDir(dirName, knownIds, subagentChildren) {
  if (typeof dirName !== 'string' || dirName === '') {
    return { known: false, reason: 'unknown' };
  }
  const known = knownIds instanceof Set ? knownIds : new Set(knownIds || []);
  const children = subagentChildren instanceof Set ? subagentChildren : new Set(subagentChildren || []);
  if (known.has(dirName)) return { known: true };
  if (children.has(dirName)) return { known: true, kind: 'subagent' };
  if (SUBAGENT_ID_RE.test(dirName)) return { known: false, reason: 'subagent-orphan' };
  return { known: false, reason: 'unknown' };
}

function psLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * Build the Windows PowerShell script that moves paths to the Recycle Bin.
 *
 * Each item is reported on stdout as `MOVED|<path>`, `MISSING|<path>`, or
 * `FAILED|<path>|<reason>`. Windows file names can never contain `|`, so the
 * separator is unambiguous. Paths are embedded as single-quoted PowerShell
 * literals; backend path segments are already conservative, and quote
 * doubling keeps the script correct even for a hostile file name.
 * @param {{path: string, isDir: boolean}[]} items - validated absolute paths.
 * @returns {string} the script text.
 */
export function buildRecycleBinScript(items) {
  const lines = ['$ErrorActionPreference = "Continue"', 'Add-Type -AssemblyName Microsoft.VisualBasic'];
  for (const item of items) {
    const api = item.isDir ? 'DeleteDirectory' : 'DeleteFile';
    lines.push(`$p = ${psLiteral(item.path)}`);
    lines.push('if (-not (Test-Path -LiteralPath $p)) {');
    lines.push('  Write-Output ("MISSING|" + $p)');
    lines.push('} else {');
    lines.push('  try {');
    lines.push(`    [Microsoft.VisualBasic.FileIO.FileSystem]::${api}($p, "OnlyErrorDialogs", "SendToRecycleBin")`);
    lines.push('    Write-Output ("MOVED|" + $p)');
    lines.push('  } catch {');
    lines.push('    Write-Output ("FAILED|" + $p + "|" + $_.Exception.Message)');
    lines.push('  }');
    lines.push('}');
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Encode a Recycle Bin script for `powershell.exe -EncodedCommand`, which
 * expects base64 of UTF-16LE text.
 * @param {{path: string, isDir: boolean}[]} items - validated absolute paths.
 * @returns {string} base64 command payload.
 */
export function recycleBinEncodedCommand(items) {
  return Buffer.from(buildRecycleBinScript(items), 'utf16le').toString('base64');
}

/**
 * Turn the script's stdout into per-path outcomes. A `MISSING` item counts as
 * moved: nothing is left on disk. Paths without a result are not moved.
 * @param {string} text - stdout of the script.
 * @param {readonly string[]} paths - the paths that were requested.
 * @returns {Map<string, {moved: boolean, reason?: string}>}
 */
export function parseRecycleBinStdout(text, paths) {
  const results = new Map();
  const wanted = new Set(paths);
  for (const line of String(text || '').split(/\r?\n/)) {
    if (line === '') continue;
    const first = line.indexOf('|');
    if (first < 0) continue;
    const status = line.slice(0, first);
    const rest = line.slice(first + 1);
    const second = rest.indexOf('|');
    const path = second < 0 ? rest : rest.slice(0, second);
    if (!wanted.has(path)) continue;
    if (status === 'MOVED' || status === 'MISSING') {
      results.set(path, { moved: true });
    } else if (status === 'FAILED') {
      const reason = second < 0 ? '' : rest.slice(second + 1);
      results.set(path, { moved: false, reason: reason || 'the Recycle Bin refused the item' });
    }
  }
  return results;
}

/** Pending-delete store version written beside the session root. */
export const PENDING_DELETE_VERSION = 1;

/** Upper bound on queued sessions, so a corrupt or hostile marker cannot grow unbounded. */
export const MAX_PENDING_DELETES = 200;

/**
 * Parse the pending-delete store written beside the session root.
 *
 * The store is a JSON object `{ version: 1, sessions: [{ id, requestedAt }] }`.
 * A corrupt store yields `ok: false` so startup processing refuses to delete
 * anything from an unreadable record.
 * @param {string} text - raw store contents.
 * @returns {{ok: true, entries: {id: string, requestedAt: number}[]} | {ok: false, message: string}}
 */
export function parsePendingDeletes(text) {
  if (typeof text !== 'string' || text === '') return { ok: false, message: 'pending-delete store is empty' };
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, message: 'pending-delete store is not JSON' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, message: 'pending-delete store must be a JSON object' };
  }
  if (parsed.version !== PENDING_DELETE_VERSION) {
    return { ok: false, message: `unsupported pending-delete store version: ${String(parsed.version)}` };
  }
  if (!Array.isArray(parsed.sessions)) {
    return { ok: false, message: 'pending-delete sessions must be an array' };
  }
  const entries = [];
  const seen = new Set();
  for (const entry of parsed.sessions) {
    if (typeof entry !== 'object' || entry === null) continue;
    if (!isSessionId(entry.id) || seen.has(entry.id)) continue;
    seen.add(entry.id);
    const requestedAt = Number.isSafeInteger(entry.requestedAt) && entry.requestedAt >= 0
      ? entry.requestedAt
      : 0;
    entries.push({ id: entry.id, requestedAt, moveToTrash: entry.moveToTrash === true });
    if (entries.length >= MAX_PENDING_DELETES) break;
  }
  return { ok: true, entries };
}

/**
 * Add one session to a pending-delete list, keeping the first request time.
 * @param {readonly {id: string, requestedAt: number, moveToTrash?: boolean}[]} entries - current list.
 * @param {string} sessionId - session to schedule.
 * @param {number} requestedAt - epoch milliseconds of the request.
 * @param {boolean} [moveToTrash] - whether the replay should use the Recycle Bin.
 * @returns {{id: string, requestedAt: number, moveToTrash: boolean}[]} a new list.
 */
export function addPendingDelete(entries, sessionId, requestedAt, moveToTrash = false) {
  if (!isSessionId(sessionId)) return [...entries];
  if (entries.some((entry) => entry.id === sessionId)) return [...entries];
  return [...entries, { id: sessionId, requestedAt, moveToTrash: moveToTrash === true }]
    .slice(0, MAX_PENDING_DELETES);
}

/**
 * Remove one session from a pending-delete list.
 * @param {readonly {id: string, requestedAt: number}[]} entries - current list.
 * @param {string} sessionId - scheduled session.
 * @returns {{id: string, requestedAt: number}[]} a new list.
 */
export function removePendingDelete(entries, sessionId) {
  return entries.filter((entry) => entry.id !== sessionId);
}
