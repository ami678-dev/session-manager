import test from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';

import {
  MAX_BATCH_DELETE,
  MAX_CLEANUP_ITEMS,
  MAX_DELETE_BODY_BYTES,
  TOMBSTONE_FILE_PATTERN,
  addPendingDelete,
  boundSchedulesFor,
  buildRecycleBinScript,
  classifySessionDir,
  countBoundSchedules,
  encodeSegment,
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
  removePendingDelete,
  safeArtifactPath,
  safeArtifactTarget,
  safePathWithinRoot,
} from '../host-lib.js';

const ID = 'session-50ca232d-d0eb-4ebf-933f-150bdaafc6e0';
const OTHER = 'session-11111111-2222-3333-4444-555555555555';
const ROOT = resolve('C:/Users/example/.dsh/sessions');

async function* chunks(...values) {
  for (const value of values) yield Buffer.from(value);
}

test('isSessionId accepts the shipped identity shape and rejects everything else', () => {
  assert.equal(isSessionId(ID), true);
  assert.equal(isSessionId('session-not-a-uuid'), false);
  assert.equal(isSessionId(''), false);
  assert.equal(isSessionId(`${ID}/..`), false);
  assert.equal(isSessionId(null), false);
});

test('encodeSegment keeps safe ids literal and escapes unsafe code units', () => {
  assert.equal(encodeSegment(ID), ID);
  assert.equal(encodeSegment('a~b'), 'a~007Eb');
  assert.equal(encodeSegment('.'), '~002E');
  assert.equal(encodeSegment('..'), '~002E~002E');
});

test('parseDeleteRequest accepts a confirmed archived-session request', () => {
  assert.deepEqual(
    parseDeleteRequest(JSON.stringify({ sessionId: ID, confirm: true })),
    { ok: true, sessionId: ID, moveToTrash: false },
  );
  assert.deepEqual(
    parseDeleteRequest(JSON.stringify({ sessionId: ID, confirm: true, moveToTrash: true })),
    { ok: true, sessionId: ID, moveToTrash: true },
  );
  assert.deepEqual(
    parseDeleteRequest(JSON.stringify({ sessionId: ID, confirm: true, moveToTrash: false })),
    { ok: true, sessionId: ID, moveToTrash: false },
  );
  assert.equal(
    parseDeleteRequest(JSON.stringify({ sessionId: ID, confirm: true, moveToTrash: 'yes' })).ok,
    false,
  );
});

test('parseDeleteRequest refuses missing confirmation, bad ids and malformed bodies', () => {
  assert.equal(parseDeleteRequest(JSON.stringify({ sessionId: ID })).ok, false);
  assert.equal(parseDeleteRequest(JSON.stringify({ sessionId: ID, confirm: 'yes' })).ok, false);
  assert.equal(parseDeleteRequest(JSON.stringify({ sessionId: 'session-x', confirm: true })).ok, false);
  assert.equal(parseDeleteRequest(JSON.stringify([{ sessionId: ID, confirm: true }])).ok, false);
  assert.equal(parseDeleteRequest('not json').ok, false);
  assert.equal(parseDeleteRequest('').ok, false);
});

test('parseBatchDeleteRequest accepts a confirmed batch and collapses duplicates', () => {
  assert.deepEqual(
    parseBatchDeleteRequest(JSON.stringify({ sessionIds: [ID, OTHER, ID], confirm: true })),
    { ok: true, sessionIds: [ID, OTHER], moveToTrash: false },
  );
  assert.deepEqual(
    parseBatchDeleteRequest(JSON.stringify({ sessionIds: [ID], confirm: true, moveToTrash: true })),
    { ok: true, sessionIds: [ID], moveToTrash: true },
  );
  assert.equal(
    parseBatchDeleteRequest(JSON.stringify({ sessionIds: [ID], confirm: true, moveToTrash: 1 })).ok,
    false,
  );
});

test('parseBatchDeleteRequest refuses empty, oversized, unconfirmed and malformed batches', () => {
  assert.equal(parseBatchDeleteRequest(JSON.stringify({ sessionIds: [], confirm: true })).ok, false);
  assert.equal(parseBatchDeleteRequest(JSON.stringify({ sessionIds: [ID] })).ok, false);
  assert.equal(parseBatchDeleteRequest(JSON.stringify({ sessionIds: [ID], confirm: 'yes' })).ok, false);
  assert.equal(parseBatchDeleteRequest(JSON.stringify({ sessionIds: ['session-x'], confirm: true })).ok, false);
  assert.equal(parseBatchDeleteRequest(JSON.stringify({ sessionIds: ID, confirm: true })).ok, false);
  assert.equal(parseBatchDeleteRequest(JSON.stringify({
    sessionIds: Array.from({ length: MAX_BATCH_DELETE + 1 }, () => ID),
    confirm: true,
  })).ok, false);
  assert.equal(parseBatchDeleteRequest('not json').ok, false);
  assert.equal(parseBatchDeleteRequest('').ok, false);
});

test('readBoundedBody returns the body and refuses an oversized one', async () => {
  assert.equal(await readBoundedBody(chunks('{"a":1}'), 64), '{"a":1}');
  assert.equal(await readBoundedBody(chunks('x'.repeat(200)), 10), null);
});

test('safeArtifactTarget accepts the JSONL layout with and without a root', () => {
  const file = join(ROOT, '--C-Users-x--', ID, 'session.v4.jsonl.zstd');
  const withRoot = safeArtifactTarget(file, ID, ROOT);
  assert.equal(withRoot.ok, true);
  assert.equal(withRoot.file, file);
  assert.equal(withRoot.dir, join(ROOT, '--C-Users-x--', ID));

  const withoutRoot = safeArtifactTarget(file, ID);
  assert.equal(withoutRoot.ok, true);

  const noCwd = safeArtifactTarget(join(ROOT, '_no-cwd', ID, 'session.v3.jsonl'), ID, ROOT);
  assert.equal(noCwd.ok, true);

  // Version zero keeps the backend's original `session.jsonl` name.
  const v0 = safeArtifactTarget(join(ROOT, '_no-cwd', ID, 'session.jsonl'), ID, ROOT);
  assert.equal(v0.ok, true);
  const v0zstd = safeArtifactTarget(join(ROOT, '_no-cwd', ID, 'session.jsonl.zstd'), ID, ROOT);
  assert.equal(v0zstd.ok, true);
});

test('safeArtifactTarget refuses wrong names, wrong directories and root escapes', () => {
  const valid = join(ROOT, '--C-Users-x--', ID, 'session.v4.jsonl.zstd');
  assert.equal(safeArtifactTarget(valid.replace('session.v4.jsonl.zstd', 'notes.txt'), ID, ROOT).ok, false);
  assert.equal(safeArtifactTarget(join(ROOT, '--C-Users-x--', OTHER, 'session.v4.jsonl.zstd'), ID, ROOT).ok, false);
  assert.equal(safeArtifactTarget(join(ROOT, 'not-a-project-key', ID, 'session.v4.jsonl.zstd'), ID, ROOT).ok, false);
  assert.equal(safeArtifactTarget('session.v4.jsonl.zstd', ID, ROOT).ok, false);
  assert.equal(safeArtifactTarget(join(ROOT, '..', 'other-root', '--x--', ID, 'session.v4.jsonl.zstd'), ID, ROOT).ok, false);
  assert.equal(safeArtifactTarget(valid, 'session-bad', ROOT).ok, false);
  assert.equal(safeArtifactTarget(valid, ID, 'relative-root').ok, false);
  // Non-canonical generation spellings the backend never writes.
  assert.equal(safeArtifactTarget(join(ROOT, '--x--', ID, 'session.v0.jsonl'), ID, ROOT).ok, false);
  assert.equal(safeArtifactTarget(join(ROOT, '--x--', ID, 'session.v04.jsonl'), ID, ROOT).ok, false);
  assert.equal(safeArtifactTarget(join(ROOT, '--x--', ID, 'session.V4.jsonl'), ID, ROOT).ok, false);
});

test('safeArtifactPath accepts stored subagent ids the request pattern refuses', () => {
  const bare = 'cb841833-fb14-49c7-a884-bc81b52b400f';
  assert.equal(isSessionId(bare), false);
  const file = join(ROOT, '--project--', bare, 'session.v4.jsonl.zstd');
  const accepted = safeArtifactPath(file, bare, ROOT);
  assert.equal(accepted.ok, true);
  assert.equal(accepted.file, file);
  assert.equal(safeArtifactPath(file, '', ROOT).ok, false);
  assert.equal(safeArtifactPath(join(ROOT, '--project--', ID, 'session.v4.jsonl.zstd'), bare, ROOT).ok, false);
});

test('countBoundSchedules counts session targets and involved sessions only', () => {
  const catalog = [
    { id: 'a', title: 'A', target: { kind: 'session', sessionId: ID }, involvedSessionIds: [] },
    { id: 'b', title: 'B', target: { kind: 'new', create: {} }, involvedSessionIds: [ID] },
    { id: 'c', title: 'C', target: { kind: 'session', sessionId: OTHER }, involvedSessionIds: [OTHER] },
    { id: 'd', title: 'D', target: { kind: 'new', create: {} }, involvedSessionIds: [] },
  ];
  assert.deepEqual(countBoundSchedules(catalog, ID), { count: 2, titles: ['A', 'B'] });
  assert.deepEqual(countBoundSchedules(null, ID), { count: 0, titles: [] });
});

test('boundSchedulesFor counts a task once across the parent and its subagents', () => {
  const SUB = 'cb841833-fb14-49c7-a884-bc81b52b400f';
  const catalog = [
    { id: 'a', title: 'A', target: { kind: 'session', sessionId: ID }, involvedSessionIds: [SUB] },
    { id: 'b', title: 'B', target: { kind: 'session', sessionId: SUB }, involvedSessionIds: [] },
    { id: 'c', title: 'C', target: { kind: 'new', create: {} }, involvedSessionIds: ['session-unrelated'] },
  ];
  assert.deepEqual(boundSchedulesFor(catalog, [ID, SUB]), { count: 2, titles: ['A', 'B'] });
});

test('the delete body limit is small and finite', () => {
  assert.equal(Number.isInteger(MAX_DELETE_BODY_BYTES), true);
  assert.ok(MAX_DELETE_BODY_BYTES > 0 && MAX_DELETE_BODY_BYTES <= 64 * 1024);
});

test('parsePendingDeletes accepts a versioned store, dedupes and drops invalid ids', () => {
  const parsed = parsePendingDeletes(JSON.stringify({
    version: 1,
    sessions: [
      { id: ID, requestedAt: 1000, moveToTrash: true },
      { id: ID, requestedAt: 2000 },
      { id: 'bogus' },
      { id: OTHER, requestedAt: -5, moveToTrash: 'yes' },
    ],
  }));
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.entries, [
    { id: ID, requestedAt: 1000, moveToTrash: true },
    { id: OTHER, requestedAt: 0, moveToTrash: false },
  ]);
});

test('parsePendingDeletes refuses malformed or unknown-version stores', () => {
  assert.equal(parsePendingDeletes('').ok, false);
  assert.equal(parsePendingDeletes('not json').ok, false);
  assert.equal(parsePendingDeletes('[]').ok, false);
  assert.equal(parsePendingDeletes(JSON.stringify({ version: 2, sessions: [] })).ok, false);
  assert.equal(parsePendingDeletes(JSON.stringify({ version: 1, sessions: 'x' })).ok, false);
});

test('addPendingDelete is idempotent and removePendingDelete removes one id', () => {
  const first = addPendingDelete([], ID, 1000);
  assert.deepEqual(first, [{ id: ID, requestedAt: 1000, moveToTrash: false }]);
  assert.deepEqual(addPendingDelete(first, ID, 2000), first, 'first request time is kept');
  assert.deepEqual(addPendingDelete(first, 'bogus', 2000), first);
  assert.deepEqual(addPendingDelete([], ID, 1000, true), [{ id: ID, requestedAt: 1000, moveToTrash: true }]);
  assert.deepEqual(removePendingDelete(first, ID), []);
  assert.deepEqual(removePendingDelete(first, OTHER), first);
});

test('isEncodedProjectKey accepts only backend project directories', () => {
  assert.equal(isEncodedProjectKey('--C-Users-x--'), true);
  assert.equal(isEncodedProjectKey('--D-~5DE5~4F5C~6587~4EF6--'), true);
  assert.equal(isEncodedProjectKey('_no-cwd'), true);
  assert.equal(isEncodedProjectKey('--x'), false);
  assert.equal(isEncodedProjectKey('x--'), false);
  assert.equal(isEncodedProjectKey('storages'), false);
  assert.equal(isEncodedProjectKey(''), false);
  assert.equal(isEncodedProjectKey(null), false);
});

test('parseCleanupRequest accepts confirmed bounded path lists and dedupes', () => {
  assert.deepEqual(
    parseCleanupRequest(JSON.stringify({ paths: ['C:\\root\\a', 'C:\\root\\b', 'C:\\root\\a'], confirm: true })),
    { ok: true, paths: ['C:\\root\\a', 'C:\\root\\b'] },
  );
  assert.equal(parseCleanupRequest(JSON.stringify({ paths: [], confirm: true })).ok, false);
  assert.equal(parseCleanupRequest(JSON.stringify({ paths: ['C:\\root\\a'] })).ok, false);
  assert.equal(parseCleanupRequest(JSON.stringify({ paths: [42], confirm: true })).ok, false);
  assert.equal(parseCleanupRequest(JSON.stringify({ paths: 'x', confirm: true })).ok, false);
  assert.equal(parseCleanupRequest(JSON.stringify({
    paths: Array.from({ length: MAX_CLEANUP_ITEMS + 1 }, (_, index) => `C:\\root\\${index}`),
    confirm: true,
  })).ok, false);
  assert.equal(parseCleanupRequest('').ok, false);
});

test('parseOpenPathRequest requires one non-empty path', () => {
  assert.deepEqual(
    parseOpenPathRequest(JSON.stringify({ path: 'C:\\root\\a' })),
    { ok: true, path: 'C:\\root\\a' },
  );
  assert.equal(parseOpenPathRequest(JSON.stringify({ path: '' })).ok, false);
  assert.equal(parseOpenPathRequest(JSON.stringify({})).ok, false);
  assert.equal(parseOpenPathRequest('[]').ok, false);
});

test('safePathWithinRoot proves containment and refuses escapes', () => {
  const inside = safePathWithinRoot(join(ROOT, '--x--', ID), ROOT);
  assert.equal(inside.ok, true);
  assert.equal(inside.path, join(ROOT, '--x--', ID));
  assert.equal(safePathWithinRoot(ROOT, ROOT).ok, false, 'the root itself is never a target');
  assert.equal(safePathWithinRoot(join(ROOT, '..', 'outside'), ROOT).ok, false);
  assert.equal(safePathWithinRoot(join('C:\\elsewhere', 'x'), ROOT).ok, false);
  assert.equal(safePathWithinRoot('relative\\path', ROOT).ok, false);
  assert.equal(safePathWithinRoot('', ROOT).ok, false);
  assert.equal(safePathWithinRoot(join(ROOT, 'x'), 'relative-root').ok, false);
});

test('classifySessionDir separates registry ids, live subagents and leftovers', () => {
  const SUB = 'cb841833-fb14-49c7-a884-bc81b52b400f';
  const ORPHAN_SUB = '9da6c409-0000-0000-0000-000000000000';
  const known = new Set([ID]);
  const subagents = new Set([SUB]);
  assert.deepEqual(classifySessionDir(ID, known, subagents), { known: true });
  assert.deepEqual(classifySessionDir(SUB, known, subagents), { known: true, kind: 'subagent' });
  assert.deepEqual(classifySessionDir(ORPHAN_SUB, known, subagents), { known: false, reason: 'subagent-orphan' });
  assert.deepEqual(classifySessionDir(OTHER, known, subagents), { known: false, reason: 'unknown' });
  assert.deepEqual(classifySessionDir('', known, subagents), { known: false, reason: 'unknown' });
  assert.deepEqual(classifySessionDir(ID, [ID], [SUB]), { known: true }, 'plain arrays work');
});

test('buildRecycleBinScript embeds paths as quoted literals and picks the right API', () => {
  const script = buildRecycleBinScript([
    { path: "C:\\root\\it's here\\session.v4.jsonl.zstd.sm-delete-1", isDir: false },
    { path: 'C:\\root\\--x--\\session-a', isDir: true },
  ]);
  assert.match(script, /FileSystem]::DeleteFile\(/);
  assert.match(script, /FileSystem]::DeleteDirectory\(/);
  assert.match(script, /'C:\\root\\it''s here\\session\.v4\.jsonl\.zstd\.sm-delete-1'/);
  assert.match(script, /"SendToRecycleBin"/);
  assert.match(script, /Test-Path -LiteralPath \$p/);
});

test('recycleBinEncodedCommand round-trips the script through UTF-16LE base64', () => {
  const items = [{ path: 'C:\\root\\--x--\\session-a', isDir: true }];
  const decoded = Buffer.from(recycleBinEncodedCommand(items), 'base64').toString('utf16le');
  assert.equal(decoded, buildRecycleBinScript(items));
});

test('parseRecycleBinStdout maps MOVED, MISSING and FAILED lines per path', () => {
  const paths = ['C:\\a', 'C:\\b', 'C:\\c', 'C:\\d'];
  const results = parseRecycleBinStdout([
    'MOVED|C:\\a',
    'MISSING|C:\\b',
    'FAILED|C:\\c|access denied',
    'garbage line',
    'MOVED|C:\\not-requested',
  ].join('\r\n'), paths);
  assert.deepEqual(results.get('C:\\a'), { moved: true });
  assert.deepEqual(results.get('C:\\b'), { moved: true }, 'missing counts as moved');
  assert.deepEqual(results.get('C:\\c'), { moved: false, reason: 'access denied' });
  assert.equal(results.has('C:\\d'), false);
  assert.equal(results.has('C:\\not-requested'), false);
  assert.equal(parseRecycleBinStdout('', paths).size, 0);
});

test('the tombstone pattern matches staged-generation leftovers only', () => {
  assert.equal(TOMBSTONE_FILE_PATTERN.test('session.v4.jsonl.zstd.sm-delete-abc'), true);
  assert.equal(TOMBSTONE_FILE_PATTERN.test('session.jsonl.sm-delete-abc'), true);
  assert.equal(TOMBSTONE_FILE_PATTERN.test('session.v4.jsonl.zstd'), false);
});
