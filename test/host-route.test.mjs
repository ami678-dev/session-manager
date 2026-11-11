import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm, access, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

import { apply, inject } from '../index.js';

const ID = 'session-50ca232d-d0eb-4ebf-933f-150bdaafc6e0';
const OTHER = 'session-11111111-2222-3333-4444-555555555555';
const THIRD = 'session-22222222-3333-4444-5555-666666666666';
const PENDING_STORE = '.session-manager-pending-delete.json';

function makeRequest(body, overrides = {}) {
  const stream = (async function* chunks() {
    yield Buffer.from(body);
  })();
  stream.method = 'POST';
  stream.headers = { 'content-type': 'application/json' };
  Object.assign(stream, overrides);
  return stream;
}

function makeResponse() {
  return {
    statusCode: 0,
    headers: {},
    headersSent: false,
    writableEnded: false,
    body: undefined,
    setHeader(name, value) {
      this.headers[name] = value;
    },
    end(payload) {
      this.body = payload;
      this.writableEnded = true;
    },
  };
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check, timeoutMs = 3000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('condition was not met in time');
}

test('the Host plugin declares its dependencies and survives an empty context', () => {
  assert.deepEqual(inject, [
    'webServer',
    'connection',
    'sessions',
    'agents',
    'sessionPersistence',
    'workspaceRegistry',
    'storageDomain',
  ]);
  assert.doesNotThrow(() => apply({}));
});

test('the delete route removes only the session log and listing entries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'session-manager-test-'));
  const projectDir = join(root, '--project--');
  const sessionDir = join(projectDir, ID);
  const logFile = join(sessionDir, 'session.v4.jsonl.zstd');
  const olderLog = join(sessionDir, 'session.v3.jsonl.zstd');
  await mkdir(sessionDir, { recursive: true });
  await writeFile(logFile, 'log');
  await writeFile(olderLog, 'old log from a prior generation');

  let route;
  const registryCalls = { unarchived: [], detached: [], unpinned: [] };
  const scheduleEntry = {
    id: 'task-1',
    title: 'Keep me',
    target: { kind: 'session', sessionId: ID },
    involvedSessionIds: [],
  };

  const ctx = {
    effect(fn) {
      const cleanup = fn();
      if (typeof cleanup === 'function') this.cleanups.push(cleanup);
    },
    cleanups: [],
    webServer: {
      register(candidate) {
        if (candidate.path === '/session-manager/api/delete') route = candidate;
        return () => {};
      },
    },
    connection: {
      requestRejection() {
        return undefined;
      },
    },
    sessions: { get: () => undefined },
    agents: { get: () => undefined },
    waterfall: async () => [],
    sessionPersistence: {
      root,
      async stat(sessionId) {
        return {
          header: { id: sessionId },
          sizeBytes: 3,
          location: { kind: 'jsonl', path: logFile },
        };
      },
    },
    workspaceRegistry: {
      archivedSessionIds: [ID],
      async unarchiveSession(sessionId) {
        registryCalls.unarchived.push(sessionId);
      },
      list() {
        return [{
          id: 'workspace-1',
          sessionIds: [ID],
          async detachSession(sessionId) {
            registryCalls.detached.push(sessionId);
          },
        }];
      },
      async unpinSession(sessionId) {
        registryCalls.unpinned.push(sessionId);
      },
    },
    storageDomain: {
      get(name) {
        if (name !== 'session_projcache') return undefined;
        return {
          table() {
            return {
              async delete() {
                return true;
              },
            };
          },
        };
      },
    },
    get(name) {
      if (name !== 'schedule') return undefined;
      return { catalog: async () => [scheduleEntry] };
    },
    logger: { info() {}, error() {} },
  };

  try {
    apply(ctx);
    assert.ok(route, 'route was not registered');
    assert.equal(route.kind, 'exact');
    assert.equal(route.path, '/session-manager/api/delete');

    const request = makeRequest(JSON.stringify({ sessionId: ID, confirm: true }));
    const response = makeResponse();
    await route.handler(request, response);

    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.equal(body.ok, true);
    assert.equal(body.sessionId, ID);
    assert.equal(body.boundSchedules.count, 1);
    assert.deepEqual(body.removedFromWorkspaces, ['workspace-1']);
    assert.equal(await exists(logFile), false, 'session log must be gone');
    assert.equal(await exists(olderLog), false, 'historical log generations must be gone too');
    assert.equal(await exists(sessionDir), false, 'empty session directory must be tidied');
    assert.deepEqual(registryCalls.unarchived, [ID]);
    assert.deepEqual(registryCalls.detached, [ID]);
    assert.deepEqual(registryCalls.unpinned, [ID]);
    assert.equal(await exists(projectDir), true, 'the project directory must stay');
    assert.deepEqual(scheduleEntry.target, { kind: 'session', sessionId: ID }, 'schedule untouched');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the delete route refuses a request that is not archived', async () => {
  let route;
  const ctx = {
    effect(fn) {
      fn();
    },
    webServer: {
      register(candidate) {
        if (candidate.path === '/session-manager/api/delete') route = candidate;
        return () => {};
      },
    },
    connection: { requestRejection: () => undefined },
    sessions: { get: () => undefined },
    agents: { get: () => undefined },
    waterfall: async () => [],
    sessionPersistence: { stat: async () => undefined },
    workspaceRegistry: { archivedSessionIds: [], list: () => [], unarchiveSession: async () => {}, unpinSession: async () => {} },
    storageDomain: { get: () => undefined },
    get: () => undefined,
    logger: { info() {}, error() {} },
  };
  apply(ctx);
  const response = makeResponse();
  await route.handler(makeRequest(JSON.stringify({ sessionId: ID, confirm: true })), response);
  assert.equal(response.statusCode, 409);
  assert.equal(JSON.parse(response.body).code, 'not-archived');
});

test('the delete route refuses a malformed body and a non-JSON content type', async () => {
  let route;
  const ctx = {
    effect(fn) {
      fn();
    },
    webServer: {
      register(candidate) {
        if (candidate.path === '/session-manager/api/delete') route = candidate;
        return () => {};
      },
    },
    connection: { requestRejection: () => undefined },
    logger: { info() {}, error() {} },
  };
  apply(ctx);

  const bad = makeResponse();
  await route.handler(makeRequest('{"sessionId":"not-a-session","confirm":true}'), bad);
  assert.equal(bad.statusCode, 400);

  const wrongType = makeResponse();
  await route.handler(makeRequest('{}', { headers: { 'content-type': 'text/plain' } }), wrongType);
  assert.equal(wrongType.statusCode, 415);
});

function makeRouteContext(overrides = {}) {
  let route;
  const routes = new Map();
  const base = {
    effect(fn) {
      fn();
    },
    webServer: {
      register(candidate) {
        routes.set(candidate.path, candidate);
        if (candidate.path === '/session-manager/api/delete') route = candidate;
        return () => {};
      },
    },
    connection: { requestRejection: () => undefined },
    sessions: { get: () => undefined },
    agents: { get: () => undefined },
    waterfall: async () => [],
    sessionPersistence: { stat: async () => undefined, list: async () => [] },
    workspaceRegistry: {
      archivedSessionIds: [ID],
      list: () => [],
      unarchiveSession: async () => {},
      unpinSession: async () => {},
    },
    storageDomain: { get: () => undefined },
    get: () => undefined,
    logger: { info() {}, error() {} },
  };
  const ctx = { ...base, ...overrides };
  apply(ctx);
  return { ctx, route, routes };
}

test('the trust fence rejection is passed through untouched', async () => {
  const { route } = makeRouteContext({
    connection: { requestRejection: () => 403 },
  });
  const response = makeResponse();
  await route.handler(makeRequest(JSON.stringify({ sessionId: ID, confirm: true })), response);
  assert.equal(response.statusCode, 403);
  assert.equal(response.body, undefined);
});

test('the archived list route returns the registry ids and refuses other methods', async () => {
  const { routes } = makeRouteContext({
    workspaceRegistry: {
      archivedSessionIds: [ID, ID, 'not-a-session', null],
      list: () => [],
      unarchiveSession: async () => {},
      unpinSession: async () => {},
    },
  });
  const route = routes.get('/session-manager/api/archived');
  assert.ok(route, 'archived route was not registered');

  const request = makeRequest('');
  request.method = 'GET';
  request.headers = {};
  const response = makeResponse();
  await route.handler(request, response);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body), { ok: true, sessions: [ID] });

  const post = makeResponse();
  await route.handler(makeRequest('{}'), post);
  assert.equal(post.statusCode, 405);
  assert.equal(post.headers.allow, 'GET');
});

test('the batch route reports deleted, scheduled and skipped sessions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'session-manager-batch-'));
  const projectDir = join(root, '--project--');
  try {
    for (const id of [ID, OTHER]) {
      const dir = join(projectDir, id);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'session.v4.jsonl.zstd'), 'log');
    }
    const { routes } = makeRouteContext({
      // The first archived session is live and idle, so it is scheduled; the
      // second is deletable now; the third was never archived.
      sessions: { get: (id) => (id === ID ? { id } : undefined) },
      workspaceRegistry: {
        archivedSessionIds: [ID, OTHER],
        list: () => [],
        unarchiveSession: async () => {},
        unpinSession: async () => {},
      },
      sessionPersistence: {
        root,
        async stat(sessionId) {
          if (sessionId !== OTHER) return undefined;
          return {
            header: { id: sessionId },
            sizeBytes: 3,
            location: { kind: 'jsonl', path: join(projectDir, sessionId, 'session.v4.jsonl.zstd') },
          };
        },
        list: async () => [],
      },
    });
    const route = routes.get('/session-manager/api/delete');
    const response = makeResponse();
    await route.handler(makeRequest(JSON.stringify({
      sessionIds: [ID, OTHER, THIRD],
      confirm: true,
    })), response);

    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.equal(body.ok, true);
    assert.deepEqual(body.results.map((result) => result.status), ['scheduled', 'deleted', 'skipped']);
    assert.equal(body.results[2].code, 'not-archived');

    const marker = JSON.parse(await readFile(join(root, PENDING_STORE), 'utf8'));
    assert.deepEqual(marker.sessions.map((entry) => entry.id), [ID]);
    assert.equal(await exists(join(projectDir, OTHER)), false, 'deletable log must be gone');
    assert.equal(await exists(join(projectDir, ID)), true, 'scheduled log must stay until restart');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a live idle session is scheduled for the next Host start', async () => {
  const root = await mkdtemp(join(tmpdir(), 'session-manager-pending-live-'));
  const { route } = makeRouteContext({
    sessions: { get: (id) => ({ id }) },
    sessionPersistence: { root, stat: async () => undefined, list: async () => [] },
  });
  try {
    const response = makeResponse();
    await route.handler(makeRequest(JSON.stringify({ sessionId: ID, confirm: true })), response);
    assert.equal(response.statusCode, 202);
    const body = JSON.parse(response.body);
    assert.equal(body.ok, true);
    assert.equal(body.code, 'restart-required');
    const marker = JSON.parse(await readFile(join(root, '.session-manager-pending-delete.json'), 'utf8'));
    assert.deepEqual(marker.sessions.map((entry) => entry.id), [ID]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a live running Agent is refused as running work', async () => {
  const root = await mkdtemp(join(tmpdir(), 'session-manager-pending-running-'));
  const { route } = makeRouteContext({
    agents: { get: () => ({ status: 'running' }) },
    sessionPersistence: { root, stat: async () => undefined, list: async () => [] },
  });
  try {
    const response = makeResponse();
    await route.handler(makeRequest(JSON.stringify({ sessionId: ID, confirm: true })), response);
    assert.equal(response.statusCode, 409);
    assert.equal(JSON.parse(response.body).code, 'session-active');
    await assert.rejects(readFile(join(root, '.session-manager-pending-delete.json'), 'utf8'), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('reported running work is refused', async () => {
  const { route } = makeRouteContext({
    waterfall: async () => [{ kind: 'turn' }],
  });
  const response = makeResponse();
  await route.handler(makeRequest(JSON.stringify({ sessionId: ID, confirm: true })), response);
  assert.equal(response.statusCode, 409);
  assert.equal(JSON.parse(response.body).code, 'session-active');
});

test('a non-JSONL backend is refused without a path guess', async () => {
  const { route } = makeRouteContext({
    sessionPersistence: {
      stat: async () => ({ location: { kind: 'sqlite', path: 'somewhere' }, sizeBytes: 1 }),
    },
  });
  const response = makeResponse();
  await route.handler(makeRequest(JSON.stringify({ sessionId: ID, confirm: true })), response);
  assert.equal(response.statusCode, 400);
  assert.equal(JSON.parse(response.body).code, 'unsupported-storage');
});

test('a vanished log still cleans the listing and reports a warning', async () => {
  const root = await mkdtemp(join(tmpdir(), 'session-manager-missing-'));
  const sessionDir = join(root, '--project--', ID);
  await mkdir(sessionDir, { recursive: true });
  const missing = join(sessionDir, 'session.v4.jsonl.zstd');
  const calls = { unarchived: [], detached: [], unpinned: [] };

  const { route } = makeRouteContext({
    sessionPersistence: {
      root,
      stat: async () => ({ location: { kind: 'jsonl', path: missing }, sizeBytes: 0 }),
    },
    workspaceRegistry: {
      archivedSessionIds: [ID],
      list() {
        return [{
          id: 'workspace-1',
          sessionIds: [ID],
          async detachSession(sessionId) {
            calls.detached.push(sessionId);
          },
        }];
      },
      async unarchiveSession(sessionId) {
        calls.unarchived.push(sessionId);
      },
      async unpinSession(sessionId) {
        calls.unpinned.push(sessionId);
      },
    },
  });

  try {
    const response = makeResponse();
    await route.handler(makeRequest(JSON.stringify({ sessionId: ID, confirm: true })), response);
    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.equal(body.ok, true);
    assert.ok(body.warnings.some((warning) => warning.includes('already absent')));
    assert.equal(await exists(sessionDir), false);
    assert.deepEqual(calls.unarchived, [ID]);
    assert.deepEqual(calls.detached, [ID]);
    assert.deepEqual(calls.unpinned, [ID]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const PROJECT = '--project--';
const CHILD = 'cb841833-fb14-49c7-a884-bc81b52b400f';

test('legacy v0 session.jsonl is deleted alongside the current generation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'session-manager-v0-'));
  const dir = join(root, PROJECT, ID);
  await mkdir(dir, { recursive: true });
  const v4 = join(dir, 'session.v4.jsonl.zstd');
  const v0 = join(dir, 'session.jsonl');
  await writeFile(v4, 'v4');
  await writeFile(v0, 'v0');

  const { route } = makeRouteContext({
    sessionPersistence: {
      root,
      async stat() {
        return { header: { id: ID }, sizeBytes: 2, location: { kind: 'jsonl', path: v4 } };
      },
      async list() {
        return [{ header: { id: ID }, sizeBytes: 2, location: { kind: 'jsonl', path: v4 } }];
      },
    },
  });

  try {
    const response = makeResponse();
    await route.handler(makeRequest(JSON.stringify({ sessionId: ID, confirm: true })), response);
    assert.equal(response.statusCode, 200);
    assert.equal(await exists(v4), false, 'current generation deleted');
    assert.equal(await exists(v0), false, 'legacy v0 generation deleted too');
    assert.equal(await exists(dir), false, 'session directory tidied');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a v0-only stored session is deletable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'session-manager-v0only-'));
  const dir = join(root, PROJECT, ID);
  await mkdir(dir, { recursive: true });
  const v0 = join(dir, 'session.jsonl');
  await writeFile(v0, 'v0');

  const { route } = makeRouteContext({
    sessionPersistence: {
      root,
      async stat() {
        return { header: { id: ID }, sizeBytes: 2, location: { kind: 'jsonl', path: v0 } };
      },
      async list() {
        return [{ header: { id: ID }, sizeBytes: 2, location: { kind: 'jsonl', path: v0 } }];
      },
    },
  });

  try {
    const response = makeResponse();
    await route.handler(makeRequest(JSON.stringify({ sessionId: ID, confirm: true })), response);
    assert.equal(response.statusCode, 200);
    assert.equal(await exists(dir), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('descendant subagent logs are deleted with the parent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'session-manager-subagent-'));
  const parentDir = join(root, PROJECT, ID);
  const childDir = join(root, PROJECT, CHILD);
  await mkdir(parentDir, { recursive: true });
  await mkdir(childDir, { recursive: true });
  const parentLog = join(parentDir, 'session.v4.jsonl.zstd');
  const childLog = join(childDir, 'session.v4.jsonl.zstd');
  await writeFile(parentLog, 'parent');
  await writeFile(childLog, 'child');

  const { route } = makeRouteContext({
    sessionPersistence: {
      root,
      async stat() {
        return { header: { id: ID }, sizeBytes: 6, location: { kind: 'jsonl', path: parentLog } };
      },
      async list() {
        return [
          { header: { id: ID }, sizeBytes: 6, location: { kind: 'jsonl', path: parentLog } },
          {
            header: { id: CHILD, origin: 'subagent', parentSession: ID },
            sizeBytes: 5,
            location: { kind: 'jsonl', path: childLog },
          },
        ];
      },
    },
  });

  try {
    const response = makeResponse();
    await route.handler(makeRequest(JSON.stringify({ sessionId: ID, confirm: true })), response);
    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.deepEqual(body.removedChildSessions, [CHILD]);
    assert.equal(await exists(parentLog), false);
    assert.equal(await exists(childLog), false);
    assert.equal(await exists(parentDir), false);
    assert.equal(await exists(childDir), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a live idle subagent defers the whole family to the next Host start', async () => {
  const root = await mkdtemp(join(tmpdir(), 'session-manager-livechild-'));
  const parentDir = join(root, PROJECT, ID);
  const childDir = join(root, PROJECT, CHILD);
  await mkdir(parentDir, { recursive: true });
  await mkdir(childDir, { recursive: true });
  const parentLog = join(parentDir, 'session.v4.jsonl.zstd');
  const childLog = join(childDir, 'session.v4.jsonl.zstd');
  await writeFile(parentLog, 'parent');
  await writeFile(childLog, 'child');

  const { route } = makeRouteContext({
    sessions: { get: (id) => (id === CHILD ? { id } : undefined) },
    sessionPersistence: {
      root,
      async stat() {
        return { header: { id: ID }, sizeBytes: 6, location: { kind: 'jsonl', path: parentLog } };
      },
      async list() {
        return [{
          header: { id: CHILD, origin: 'subagent', parentSession: ID },
          sizeBytes: 5,
          location: { kind: 'jsonl', path: childLog },
        }];
      },
    },
  });

  try {
    const response = makeResponse();
    await route.handler(makeRequest(JSON.stringify({ sessionId: ID, confirm: true })), response);
    assert.equal(response.statusCode, 202);
    const body = JSON.parse(response.body);
    assert.equal(body.code, 'restart-required');
    assert.equal(body.sessionId, ID, 'the parent is scheduled, not the child');
    const marker = JSON.parse(await readFile(join(root, PENDING_STORE), 'utf8'));
    assert.deepEqual(marker.sessions.map((entry) => entry.id), [ID]);
    assert.equal(await exists(parentLog), true, 'parent log untouched');
    assert.equal(await exists(childLog), true, 'live child log untouched');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a running live subagent refuses the deletion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'session-manager-runningchild-'));
  const parentDir = join(root, PROJECT, ID);
  const childDir = join(root, PROJECT, CHILD);
  await mkdir(parentDir, { recursive: true });
  await mkdir(childDir, { recursive: true });
  const parentLog = join(parentDir, 'session.v4.jsonl.zstd');
  const childLog = join(childDir, 'session.v4.jsonl.zstd');
  await writeFile(parentLog, 'parent');
  await writeFile(childLog, 'child');

  const { route } = makeRouteContext({
    sessions: { get: (id) => (id === CHILD ? { id } : undefined) },
    agents: { get: (id) => (id === CHILD ? { status: 'running' } : undefined) },
    sessionPersistence: {
      root,
      async stat() {
        return { header: { id: ID }, sizeBytes: 6, location: { kind: 'jsonl', path: parentLog } };
      },
      async list() {
        return [{
          header: { id: CHILD, origin: 'subagent', parentSession: ID },
          sizeBytes: 5,
          location: { kind: 'jsonl', path: childLog },
        }];
      },
    },
  });

  try {
    const response = makeResponse();
    await route.handler(makeRequest(JSON.stringify({ sessionId: ID, confirm: true })), response);
    assert.equal(response.statusCode, 409);
    assert.equal(JSON.parse(response.body).code, 'session-active');
    await assert.rejects(readFile(join(root, PENDING_STORE), 'utf8'), { code: 'ENOENT' });
    assert.equal(await exists(parentLog), true);
    assert.equal(await exists(childLog), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a failing subagent listing refuses the deletion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'session-manager-listfail-'));
  const dir = join(root, PROJECT, ID);
  await mkdir(dir, { recursive: true });
  const log = join(dir, 'session.v4.jsonl.zstd');
  await writeFile(log, 'parent');

  const { route } = makeRouteContext({
    sessionPersistence: {
      root,
      async stat() {
        return { header: { id: ID }, sizeBytes: 6, location: { kind: 'jsonl', path: log } };
      },
      async list() {
        throw new Error('storage unavailable');
      },
    },
  });

  try {
    const response = makeResponse();
    await route.handler(makeRequest(JSON.stringify({ sessionId: ID, confirm: true })), response);
    assert.equal(response.statusCode, 500);
    assert.equal(JSON.parse(response.body).code, 'delete-failed');
    assert.equal(await exists(log), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an unexpected subagent path refuses the deletion before any rename', async () => {
  const root = await mkdtemp(join(tmpdir(), 'session-manager-childpath-'));
  const dir = join(root, PROJECT, ID);
  await mkdir(dir, { recursive: true });
  const log = join(dir, 'session.v4.jsonl.zstd');
  await writeFile(log, 'parent');

  const { route } = makeRouteContext({
    sessionPersistence: {
      root,
      async stat() {
        return { header: { id: ID }, sizeBytes: 6, location: { kind: 'jsonl', path: log } };
      },
      async list() {
        return [{
          header: { id: CHILD, origin: 'subagent', parentSession: ID },
          sizeBytes: 5,
          location: { kind: 'jsonl', path: log },
        }];
      },
    },
  });

  try {
    const response = makeResponse();
    await route.handler(makeRequest(JSON.stringify({ sessionId: ID, confirm: true })), response);
    assert.equal(response.statusCode, 400);
    assert.equal(JSON.parse(response.body).code, 'bad-request');
    assert.equal(await exists(log), true, 'nothing was renamed or removed');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a directory at the log path is refused without renaming it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'session-manager-dirlog-'));
  const dir = join(root, PROJECT, ID);
  const fakeLog = join(dir, 'session.v4.jsonl.zstd');
  await mkdir(fakeLog, { recursive: true });

  const { route } = makeRouteContext({
    sessionPersistence: {
      root,
      async stat() {
        return { header: { id: ID }, sizeBytes: 0, location: { kind: 'jsonl', path: fakeLog } };
      },
      async list() {
        return [{ header: { id: ID }, sizeBytes: 0, location: { kind: 'jsonl', path: fakeLog } }];
      },
    },
  });

  try {
    const response = makeResponse();
    await route.handler(makeRequest(JSON.stringify({ sessionId: ID, confirm: true })), response);
    assert.equal(response.statusCode, 500);
    assert.equal(await exists(fakeLog), true, 'the directory was not renamed');
    assert.deepEqual(await readdir(dir), ['session.v4.jsonl.zstd']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function writePendingStore(root, ids) {
  await writeFile(join(root, PENDING_STORE), JSON.stringify({
    version: 1,
    sessions: ids.map((id) => ({ id, requestedAt: 1 })),
  }));
}

test('startup replay deletes a scheduled archived session and clears the store', async () => {
  const root = await mkdtemp(join(tmpdir(), 'session-manager-replay-'));
  const dir = join(root, PROJECT, ID);
  await mkdir(dir, { recursive: true });
  const log = join(dir, 'session.v4.jsonl.zstd');
  await writeFile(log, 'parent');
  await writePendingStore(root, [ID]);
  const calls = { unarchived: [], unpinned: [] };

  makeRouteContext({
    sessionPersistence: {
      root,
      async stat() {
        return { header: { id: ID }, sizeBytes: 6, location: { kind: 'jsonl', path: log } };
      },
      async list() {
        return [{ header: { id: ID }, sizeBytes: 6, location: { kind: 'jsonl', path: log } }];
      },
    },
    workspaceRegistry: {
      archivedSessionIds: [ID],
      list: () => [],
      async unarchiveSession(id) { calls.unarchived.push(id); },
      async unpinSession(id) { calls.unpinned.push(id); },
    },
  });

  try {
    await waitFor(async () => !(await exists(log)));
    assert.equal(await exists(dir), false, 'session directory tidied');
    assert.equal(await exists(join(root, PENDING_STORE)), false, 'store removed');
    assert.deepEqual(calls.unarchived, [ID]);
    assert.deepEqual(calls.unpinned, [ID]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('startup replay drops a scheduled session that was unarchived', async () => {
  const root = await mkdtemp(join(tmpdir(), 'session-manager-replay-cancel-'));
  const dir = join(root, PROJECT, ID);
  await mkdir(dir, { recursive: true });
  const log = join(dir, 'session.v4.jsonl.zstd');
  await writeFile(log, 'parent');
  await writePendingStore(root, [ID]);

  makeRouteContext({
    sessionPersistence: {
      root,
      async stat() {
        return { header: { id: ID }, sizeBytes: 6, location: { kind: 'jsonl', path: log } };
      },
      async list() {
        return [{ header: { id: ID }, sizeBytes: 6, location: { kind: 'jsonl', path: log } }];
      },
    },
    workspaceRegistry: {
      archivedSessionIds: [],
      list: () => [],
      async unarchiveSession() {},
      async unpinSession() {},
    },
  });

  try {
    await waitFor(async () => !(await exists(join(root, PENDING_STORE))));
    assert.equal(await exists(log), true, 'unarchived session is kept');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('startup replay keeps a scheduled session that is live again', async () => {
  const root = await mkdtemp(join(tmpdir(), 'session-manager-replay-live-'));
  const dir = join(root, PROJECT, ID);
  await mkdir(dir, { recursive: true });
  const log = join(dir, 'session.v4.jsonl.zstd');
  await writeFile(log, 'parent');
  await writePendingStore(root, [ID]);

  makeRouteContext({
    sessions: { get: (id) => ({ id }) },
    sessionPersistence: {
      root,
      async stat() {
        return { header: { id: ID }, sizeBytes: 6, location: { kind: 'jsonl', path: log } };
      },
      async list() {
        return [{ header: { id: ID }, sizeBytes: 6, location: { kind: 'jsonl', path: log } }];
      },
    },
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 300));
    const store = JSON.parse(await readFile(join(root, PENDING_STORE), 'utf8'));
    assert.deepEqual(store.sessions.map((entry) => entry.id), [ID]);
    assert.equal(await exists(log), true, 'live session is kept');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function withSpawnSeams(config, fn) {
  const seamDir = await mkdtemp(join(tmpdir(), 'session-manager-spawn-'));
  const logPath = join(seamDir, 'spawn.log');
  const savedLog = process.env.SM_TEST_SPAWN_LOG;
  const savedFail = process.env.SM_TEST_SPAWN_FAIL;
  process.env.SM_TEST_SPAWN_LOG = logPath;
  if (config.fail) process.env.SM_TEST_SPAWN_FAIL = config.fail;
  else delete process.env.SM_TEST_SPAWN_FAIL;
  try {
    return await fn(logPath);
  } finally {
    if (savedLog === undefined) delete process.env.SM_TEST_SPAWN_LOG;
    else process.env.SM_TEST_SPAWN_LOG = savedLog;
    if (savedFail === undefined) delete process.env.SM_TEST_SPAWN_FAIL;
    else process.env.SM_TEST_SPAWN_FAIL = savedFail;
    await rm(seamDir, { recursive: true, force: true });
  }
}

async function readSpawnEntries(logPath) {
  try {
    const text = await readFile(logPath, 'utf8');
    return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

function deleteRouteOf(routes) {
  const route = routes.get('/session-manager/api/delete');
  assert.ok(route, 'delete route was not registered');
  return route;
}

test('the delete route moves log files to the Recycle Bin when asked', async () => {
  const root = await mkdtemp(join(tmpdir(), 'session-manager-trash-'));
  const dir = join(root, PROJECT, ID);
  await mkdir(dir, { recursive: true });
  const log = join(dir, 'session.v4.jsonl.zstd');
  await writeFile(log, 'log');

  const { routes } = makeRouteContext({
    sessionPersistence: {
      root,
      async stat() {
        return { header: { id: ID }, sizeBytes: 3, location: { kind: 'jsonl', path: log } };
      },
      async list() {
        return [{ header: { id: ID }, sizeBytes: 3, location: { kind: 'jsonl', path: log } }];
      },
    },
  });
  const route = deleteRouteOf(routes);

  try {
    await withSpawnSeams({}, async (spawnLog) => {
      const response = makeResponse();
      await route.handler(
        makeRequest(JSON.stringify({ sessionId: ID, confirm: true, moveToTrash: true })),
        response,
      );
      assert.equal(response.statusCode, 200);
      assert.equal(JSON.parse(response.body).ok, true);
      assert.equal(await exists(dir), false, 'staged logs and the empty directory are gone');
      const entries = await readSpawnEntries(spawnLog);
      assert.equal(entries.length, 1);
      assert.equal(entries[0].kind, 'recycle');
      assert.equal(entries[0].file, 'powershell.exe');
      const script = Buffer.from(entries[0].argv[3], 'base64').toString('utf16le');
      assert.match(script, /FileSystem\]::DeleteFile\(/);
      assert.match(script, /sm-delete-/);
      assert.match(script, /SendToRecycleBin/);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an unavailable Recycle Bin degrades the delete to permanent removal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'session-manager-trash-fail-'));
  const dir = join(root, PROJECT, ID);
  await mkdir(dir, { recursive: true });
  const log = join(dir, 'session.v4.jsonl.zstd');
  await writeFile(log, 'log');

  const { routes } = makeRouteContext({
    sessionPersistence: {
      root,
      async stat() {
        return { header: { id: ID }, sizeBytes: 3, location: { kind: 'jsonl', path: log } };
      },
      async list() {
        return [{ header: { id: ID }, sizeBytes: 3, location: { kind: 'jsonl', path: log } }];
      },
    },
  });
  const route = deleteRouteOf(routes);

  try {
    await withSpawnSeams({ fail: 'recycle' }, async (spawnLog) => {
      const response = makeResponse();
      await route.handler(
        makeRequest(JSON.stringify({ sessionId: ID, confirm: true, moveToTrash: true })),
        response,
      );
      assert.equal(response.statusCode, 200);
      const body = JSON.parse(response.body);
      assert.equal(body.ok, true);
      assert.ok(
        body.warnings.some((warning) => warning.includes('Recycle Bin unavailable')),
        `expected a Recycle Bin warning, got: ${JSON.stringify(body.warnings)}`,
      );
      assert.equal(await exists(dir), false, 'permanent fallback removed the logs');
      assert.equal((await readSpawnEntries(spawnLog)).length, 1, 'the failed spawn was attempted once');
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the batch route threads moveToTrash into the queue and the immediate delete', async () => {
  const root = await mkdtemp(join(tmpdir(), 'session-manager-batch-trash-'));
  const projectDir = join(root, PROJECT);
  try {
    for (const id of [ID, OTHER]) {
      const dir = join(projectDir, id);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'session.v4.jsonl.zstd'), 'log');
    }
    const { routes } = makeRouteContext({
      sessions: { get: (id) => (id === ID ? { id } : undefined) },
      workspaceRegistry: {
        archivedSessionIds: [ID, OTHER],
        list: () => [],
        unarchiveSession: async () => {},
        unpinSession: async () => {},
      },
      sessionPersistence: {
        root,
        async stat(sessionId) {
          if (sessionId !== OTHER) return undefined;
          return {
            header: { id: sessionId },
            sizeBytes: 3,
            location: { kind: 'jsonl', path: join(projectDir, sessionId, 'session.v4.jsonl.zstd') },
          };
        },
        list: async () => [],
      },
    });
    const route = deleteRouteOf(routes);

    await withSpawnSeams({}, async (spawnLog) => {
      const response = makeResponse();
      await route.handler(makeRequest(JSON.stringify({
        sessionIds: [ID, OTHER],
        confirm: true,
        moveToTrash: true,
      })), response);
      assert.equal(response.statusCode, 200);
      const statuses = JSON.parse(response.body).results.map((result) => result.status);
      assert.deepEqual(statuses, ['scheduled', 'deleted']);

      const marker = JSON.parse(await readFile(join(root, PENDING_STORE), 'utf8'));
      assert.deepEqual(marker.sessions, [{ id: ID, requestedAt: marker.sessions[0].requestedAt, moveToTrash: true }]);
      assert.equal(await exists(join(projectDir, OTHER)), false);
      assert.equal(await exists(join(projectDir, ID)), true, 'scheduled log stays until restart');
      const entries = await readSpawnEntries(spawnLog);
      assert.equal(entries.length, 1);
      assert.equal(entries[0].kind, 'recycle');
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('startup replay honors a queued moveToTrash flag', async () => {
  const root = await mkdtemp(join(tmpdir(), 'session-manager-replay-trash-'));
  const dir = join(root, PROJECT, ID);
  await mkdir(dir, { recursive: true });
  const log = join(dir, 'session.v4.jsonl.zstd');
  await writeFile(log, 'log');
  await writeFile(join(root, PENDING_STORE), JSON.stringify({
    version: 1,
    sessions: [{ id: ID, requestedAt: 1, moveToTrash: true }],
  }));

  await withSpawnSeams({}, async (spawnLog) => {
    makeRouteContext({
      sessionPersistence: {
        root,
        async stat() {
          return { header: { id: ID }, sizeBytes: 3, location: { kind: 'jsonl', path: log } };
        },
        async list() {
          return [{ header: { id: ID }, sizeBytes: 3, location: { kind: 'jsonl', path: log } }];
        },
      },
    });
    try {
      await waitFor(async () => !(await exists(log)));
      const entries = await readSpawnEntries(spawnLog);
      assert.equal(entries.length, 1);
      assert.equal(entries[0].kind, 'recycle');
      assert.equal(await exists(join(root, PENDING_STORE)), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

const LIVE_ID = 'session-44444444-5555-6666-7777-888888888888';
const ORPHAN_SUB = '9da6c409-0000-0000-0000-000000000000';
const UNKNOWN = 'session-33333333-4444-5555-6666-777777777777';

test('the cleanup scan reports leftovers and skips every known session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'session-manager-cleanup-'));
  const project = join(root, PROJECT);
  const knownDir = join(project, ID);
  const archivedDir = join(project, OTHER);
  const pinnedDir = join(project, THIRD);
  const liveDir = join(project, LIVE_ID);
  const childDir = join(project, CHILD);
  const orphanChildDir = join(project, ORPHAN_SUB);
  const unknownDir = join(project, UNKNOWN);
  const emptyProject = join(root, '--empty--');
  const tombstone = join(knownDir, 'session.v4.jsonl.zstd.sm-delete-tag');

  try {
    for (const dir of [knownDir, archivedDir, pinnedDir, liveDir, childDir, orphanChildDir, unknownDir, emptyProject]) {
      await mkdir(dir, { recursive: true });
    }
    for (const dir of [knownDir, archivedDir, childDir, orphanChildDir, unknownDir]) {
      await writeFile(join(dir, 'session.v4.jsonl.zstd'), 'log');
    }
    await writeFile(tombstone, 'staged');
    await mkdir(join(root, 'storages'), { recursive: true });
    await writeFile(join(root, 'not-a-project.json'), '{}');

    const { routes } = makeRouteContext({
      sessions: { get: (id) => (id === LIVE_ID ? { id } : undefined) },
      workspaceRegistry: {
        archivedSessionIds: [OTHER, LIVE_ID],
        pinnedSessionIds: [THIRD],
        list: () => [{ id: 'workspace-1', sessionIds: [ID] }],
      },
      sessionPersistence: {
        root,
        async stat() { return undefined; },
        async list() {
          return [{
            header: { id: CHILD, origin: 'subagent', parentSession: ID },
            sizeBytes: 3,
            location: { kind: 'jsonl', path: join(childDir, 'session.v4.jsonl.zstd') },
          }];
        },
      },
    });
    const route = routes.get('/session-manager/api/cleanup');
    assert.ok(route, 'cleanup route was not registered');

    const request = makeRequest('');
    request.method = 'GET';
    request.headers = {};
    const response = makeResponse();
    await route.handler(request, response);
    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.equal(body.ok, true);
    assert.equal(body.root, root);
    assert.equal(body.truncated, false);
    assert.deepEqual(body.warnings, []);

    const byPath = new Map(body.items.map((item) => [item.path, item]));
    assert.deepEqual(byPath.get(tombstone), { path: tombstone, kind: 'tombstone' });
    assert.deepEqual(byPath.get(pinnedDir), { path: pinnedDir, kind: 'empty-dir' });
    assert.deepEqual(byPath.get(emptyProject), { path: emptyProject, kind: 'empty-dir' });
    assert.deepEqual(byPath.get(orphanChildDir), {
      path: orphanChildDir,
      kind: 'session-dir',
      reason: 'subagent-orphan',
    });
    assert.deepEqual(byPath.get(unknownDir), {
      path: unknownDir,
      kind: 'session-dir',
      reason: 'unknown',
    });
    assert.equal(byPath.has(knownDir), false, 'registered session is never a candidate');
    assert.equal(byPath.has(archivedDir), false, 'archived session is never a candidate');
    assert.equal(byPath.has(liveDir), false, 'a live empty directory is skipped');
    assert.equal(byPath.has(childDir), false, 'a subagent of a known session is skipped');
    assert.equal(body.items.length, 5);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the cleanup scan truncates at the shared item cap', async () => {
  const root = await mkdtemp(join(tmpdir(), 'session-manager-cleanup-cap-'));
  const project = join(root, PROJECT);
  try {
    await mkdir(project, { recursive: true });
    const dirs = Array.from({ length: 201 }, (_, index) => (
      `session-10000000-0000-4000-8000-${String(index).padStart(12, '0')}`
    ));
    for (const name of dirs) await mkdir(join(project, name));
    const { routes } = makeRouteContext({
      sessionPersistence: { root, async stat() { return undefined; }, async list() { return []; } },
    });
    const route = routes.get('/session-manager/api/cleanup');
    const request = makeRequest('');
    request.method = 'GET';
    request.headers = {};
    const response = makeResponse();
    await route.handler(request, response);
    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.equal(body.truncated, true);
    assert.equal(body.items.length, 200);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the cleanup POST moves files and directories to the Recycle Bin in one spawn', async () => {
  const root = await mkdtemp(join(tmpdir(), 'session-manager-cleanup-post-'));
  const project = join(root, PROJECT);
  const knownDir = join(project, ID);
  const unknownDir = join(project, UNKNOWN);
  const tombstone = join(knownDir, 'session.v4.jsonl.zstd.sm-delete-tag');

  try {
    await mkdir(unknownDir, { recursive: true });
    await mkdir(knownDir, { recursive: true });
    await writeFile(join(knownDir, 'session.v4.jsonl.zstd'), 'log');
    await writeFile(tombstone, 'staged');

    const { routes } = makeRouteContext({
      workspaceRegistry: {
        archivedSessionIds: [],
        list: () => [{ id: 'workspace-1', sessionIds: [ID] }],
      },
      sessionPersistence: { root, async stat() { return undefined; }, async list() { return []; } },
    });
    const route = routes.get('/session-manager/api/cleanup');

    await withSpawnSeams({}, async (spawnLog) => {
      const response = makeResponse();
      await route.handler(makeRequest(JSON.stringify({
        paths: [unknownDir, tombstone],
        confirm: true,
      })), response);
      assert.equal(response.statusCode, 200);
      const body = JSON.parse(response.body);
      assert.equal(body.ok, true);
      assert.deepEqual(body.results.map((result) => result.status), ['moved', 'moved']);
      assert.equal(await exists(unknownDir), false);
      assert.equal(await exists(tombstone), false);
      assert.equal(await exists(join(knownDir, 'session.v4.jsonl.zstd')), true, 'live logs stay');

      const entries = await readSpawnEntries(spawnLog);
      assert.equal(entries.length, 1, 'one chunk, one spawn');
      assert.equal(entries[0].kind, 'recycle');
      const script = Buffer.from(entries[0].argv[3], 'base64').toString('utf16le');
      assert.match(script, /DeleteDirectory/);
      assert.match(script, /DeleteFile/);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the cleanup POST re-validates every path and reports per-item failures', async () => {
  const root = await mkdtemp(join(tmpdir(), 'session-manager-cleanup-toctou-'));
  const project = join(root, PROJECT);
  const knownDir = join(project, ID);
  const missing = join(project, 'session-99999999-0000-4000-8000-000000000000');

  try {
    await mkdir(knownDir, { recursive: true });
    await writeFile(join(knownDir, 'session.v4.jsonl.zstd'), 'still here');

    const { routes } = makeRouteContext({
      workspaceRegistry: {
        archivedSessionIds: [],
        list: () => [{ id: 'workspace-1', sessionIds: [ID] }],
      },
      sessionPersistence: { root, async stat() { return undefined; }, async list() { return []; } },
    });
    const route = routes.get('/session-manager/api/cleanup');
    const outside = join(root, '..', 'outside-the-root');

    await withSpawnSeams({}, async (spawnLog) => {
      const response = makeResponse();
      await route.handler(makeRequest(JSON.stringify({
        paths: [knownDir, missing, outside],
        confirm: true,
      })), response);
      assert.equal(response.statusCode, 200);
      const results = JSON.parse(response.body).results;
      assert.deepEqual(results.map((result) => result.status), ['failed', 'failed', 'failed']);
      assert.match(results[0].message, /not empty/);
      assert.match(results[1].message, /no longer exists/);
      assert.match(results[2].message, /parent segment|escapes the session root/);
      assert.equal(await exists(join(knownDir, 'session.v4.jsonl.zstd')), true);
      assert.deepEqual(await readSpawnEntries(spawnLog), [], 'nothing was spawned');
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the cleanup route bounds the request and fences other methods', async () => {
  const { routes } = makeRouteContext({});
  const route = routes.get('/session-manager/api/cleanup');
  const tooMany = makeResponse();
  await route.handler(makeRequest(JSON.stringify({
    paths: Array.from({ length: 201 }, (_, index) => `C:\\root\\${index}`),
    confirm: true,
  })), tooMany);
  assert.equal(tooMany.statusCode, 400);

  const put = makeRequest('{}');
  put.method = 'PUT';
  const putResponse = makeResponse();
  await route.handler(put, putResponse);
  assert.equal(putResponse.statusCode, 405);
  assert.equal(putResponse.headers.allow, 'GET, POST');

  const fenced = makeRouteContext({ connection: { requestRejection: () => 403 } });
  const fencedRoute = fenced.routes.get('/session-manager/api/cleanup');
  const get = makeRequest('');
  get.method = 'GET';
  get.headers = {};
  const fencedResponse = makeResponse();
  await fencedRoute.handler(get, fencedResponse);
  assert.equal(fencedResponse.statusCode, 403);
  assert.equal(fencedResponse.body, undefined);
});

test('the open-path route reveals a file with a single encoded /select argument', async () => {
  const root = await mkdtemp(join(tmpdir(), 'session-manager-open-'));
  const dir = join(root, PROJECT, ID);
  const file = join(dir, 'session.v4.jsonl.zstd');
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(file, 'log');
    const { routes } = makeRouteContext({ sessionPersistence: { root, async stat() { return undefined; }, async list() { return []; } } });
    const route = routes.get('/session-manager/api/open-path');
    assert.ok(route, 'open-path route was not registered');

    await withSpawnSeams({}, async (spawnLog) => {
      const realFile = await realpath(file);
      const expected = pathToFileURL(realFile, { windows: true }).href;
      const response = makeResponse();
      await route.handler(makeRequest(JSON.stringify({ path: file })), response);
      assert.equal(response.statusCode, 200);
      assert.deepEqual(JSON.parse(response.body), { ok: true, opened: true, path: realFile });

      const entries = await readSpawnEntries(spawnLog);
      assert.equal(entries.length, 1);
      assert.equal(entries[0].kind, 'open-path');
      assert.equal(entries[0].file, 'explorer.exe');
      assert.deepEqual(entries[0].argv, [`/select,${expected}`]);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the open-path route opens a directory with the plain URI and refuses escapes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'session-manager-open-dir-'));
  const dir = join(root, PROJECT, ID);
  try {
    await mkdir(dir, { recursive: true });
    const { routes } = makeRouteContext({ sessionPersistence: { root, async stat() { return undefined; }, async list() { return []; } } });
    const route = routes.get('/session-manager/api/open-path');

    await withSpawnSeams({}, async (spawnLog) => {
      const realDir = await realpath(dir);
      const expected = pathToFileURL(realDir, { windows: true }).href;
      const response = makeResponse();
      await route.handler(makeRequest(JSON.stringify({ path: dir })), response);
      assert.equal(response.statusCode, 200);
      const entries = await readSpawnEntries(spawnLog);
      assert.deepEqual(entries[0].argv, [expected]);
    });

    const escape = makeResponse();
    await route.handler(makeRequest(JSON.stringify({ path: join(root, '..', 'outside') })), escape);
    assert.equal(escape.statusCode, 400);

    const missing = makeResponse();
    await route.handler(makeRequest(JSON.stringify({ path: join(root, PROJECT, 'session-missing') })), missing);
    assert.equal(missing.statusCode, 404);
    assert.equal(JSON.parse(missing.body).code, 'not-found');

    const get = makeRequest('');
    get.method = 'GET';
    get.headers = {};
    const methodResponse = makeResponse();
    await route.handler(get, methodResponse);
    assert.equal(methodResponse.statusCode, 405);
    assert.equal(methodResponse.headers.allow, 'POST');

    const fenced = makeRouteContext({ connection: { requestRejection: () => 403 } });
    const fencedRoute = fenced.routes.get('/session-manager/api/open-path');
    const fencedResponse = makeResponse();
    await fencedRoute.handler(makeRequest(JSON.stringify({ path: dir })), fencedResponse);
    assert.equal(fencedResponse.statusCode, 403);
    assert.equal(fencedResponse.body, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
