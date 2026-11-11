import test from 'node:test';
import assert from 'node:assert/strict';

const ID = 'session-50ca232d-d0eb-4ebf-933f-150bdaafc6e0';

// The client module is a browser artifact: it registers itself through the
// browser module table at evaluation time. Install the smallest possible host
// before importing it, so this test exercises the real file.
let loaded;
const storage = new Map();
globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      loaded = definition;
    },
  },
  localStorage: {
    getItem(key) {
      return storage.has(key) ? storage.get(key) : null;
    },
    setItem(key, value) {
      storage.set(key, String(value));
    },
  },
  addEventListener() {},
  removeEventListener() {},
};
globalThis.document = {
  addEventListener() {},
  removeEventListener() {},
  visibilityState: 'visible',
  hasFocus() {
    return true;
  },
  baseURI: 'http://127.0.0.1:53540/',
};
// Ask the factory for its pure-helper test seam.
globalThis.__SESSION_MANAGER_TEST__ = true;

const ReactStub = {
  createElement() {
    return null;
  },
  Fragment: 'Fragment',
  Component: class Component {
    constructor(props) {
      this.props = props;
    }

    setState() {}
  },
  useSyncExternalStore(_subscribe, getSnapshot) {
    return getSnapshot();
  },
  useEffect() {},
  useRef() {
    return { current: null };
  },
};

const requireStub = (name) => {
  if (name === 'react') return ReactStub;
  throw new Error(`unexpected client module dependency: ${name}`);
};

await import('../client.js');

test('the client module registers the expected package id', () => {
  assert.ok(loaded, 'client module did not call the browser module loader');
  assert.equal(loaded.id, '@local/session-manager');
});

test('the factory exposes the documented service injection and apply seam', () => {
  const mod = loaded.factory(requireStub);
  assert.deepEqual(mod.inject, ['slots', 'locale', 'remote', 'sessions']);
  assert.equal(typeof mod.apply, 'function');
  assert.equal(typeof mod.__test.addNotice, 'function');
  assert.equal(typeof mod.__test.statusTransitions, 'function');
});

test('addNotice coalesces only a repeated pending-action notice', () => {
  const mod = loaded.factory(requireStub);
  const base = {
    kind: 'approval',
    sessionId: ID,
    detail: 'write',
    sticky: true,
    createdAt: 1000,
  };
  const first = mod.__test.addNotice([], { ...base, id: 1, resolved: false }, 4, 1000);
  assert.equal(first.length, 1);
  const duplicate = mod.__test.addNotice(first, { ...base, id: 2, resolved: false }, 4, 5000);
  assert.equal(duplicate, first, 'a repeat approval must not mint a new store value');

  // Completions and errors are discrete events: two quick ones both alert.
  const completions = mod.__test.addNotice(
    mod.__test.addNotice([], {
      kind: 'completed', sessionId: ID, detail: '', id: 10, sticky: false, createdAt: 1000,
    }, 4, 1000),
    {
      kind: 'completed', sessionId: ID, detail: '', id: 11, sticky: false, createdAt: 1500,
    },
    4,
    1500,
  );
  assert.equal(completions.length, 2, 'completion events must not be coalesced');

  const other = mod.__test.addNotice(first, {
    kind: 'error',
    sessionId: ID,
    detail: 'boom',
    id: 3,
    sticky: false,
    createdAt: 1000,
  }, 4, 5000);
  assert.equal(other.length, 2);
});

test('addNotice caps the stack and prefers dropping non-sticky entries', () => {
  const mod = loaded.factory(requireStub);
  let list = [];
  list = mod.__test.addNotice(list, { kind: 'approval', sessionId: ID, detail: '', id: 99, sticky: true, createdAt: 1000 }, 4, 1000);
  for (let index = 0; index < 6; index += 1) {
    list = mod.__test.addNotice(list, {
      kind: 'completed',
      sessionId: `session-${index}`,
      detail: '',
      id: index,
      sticky: false,
      createdAt: 1000,
    }, 4, 1000);
  }
  assert.equal(list.length, 4);
  assert.equal(list.some((entry) => entry.id === 99), true, 'sticky approval must survive');
  assert.deepEqual(list.map((entry) => entry.id), [99, 3, 4, 5]);
});

test('statusTransitions reports new approvals and question resolutions', () => {
  const mod = loaded.factory(requireStub);
  const previous = new Map([[ID, { running: false }]]);
  const next = new Map([[ID, {
    running: false,
    pendingInteraction: { kind: 'approval', key: 'approval:1', toolName: 'write' },
  }]]);
  const changes = mod.__test.statusTransitions(previous, next);
  assert.deepEqual(changes.map((change) => change.type), ['pending']);
  assert.equal(changes[0].kind, 'approval');

  const samePending = mod.__test.statusTransitions(
    new Map([[ID, { pendingInteraction: { kind: 'question', key: 'q1' } }]]),
    new Map([[ID, { pendingInteraction: { kind: 'question', key: 'q1' } }]]),
  );
  assert.deepEqual(samePending, []);

  const resolved = mod.__test.statusTransitions(
    new Map([[ID, { pendingInteraction: { kind: 'question', key: 'q1' } }]]),
    new Map([[ID, {}]]),
  );
  assert.deepEqual(resolved.map((change) => change.type), ['resolved']);
});

test('statusTransitions reports running -> idle as completion', () => {
  const mod = loaded.factory(requireStub);
  const changes = mod.__test.statusTransitions(
    new Map([[ID, { running: true }]]),
    new Map([[ID, { running: false }]]),
  );
  assert.deepEqual(changes.map((change) => change.type), ['completed']);

  // A turn that ends while an interaction is pending is waiting for the user,
  // so the pending notice is the only alert (no misleading completion).
  const pending = mod.__test.statusTransitions(
    new Map([[ID, { running: true }]]),
    new Map([[ID, { running: false, pendingInteraction: { kind: 'question', key: 'q' } }]]),
  );
  assert.deepEqual(pending.map((change) => change.type), ['pending']);
});

function createFakeContext() {
  const slotRegistrations = [];
  const remoteEvents = [];
  const cleanups = [];
  const fakeScope = {
    uiSession: {
      sessionStatus: {
        getSnapshot: () => new Map(),
        subscribe: () => () => {},
      },
    },
    effect(fn, label) {
      const cleanup = fn(label);
      if (typeof cleanup === 'function') cleanups.push(cleanup);
      return () => {};
    },
  };
  const ctx = {
    locale: {
      register: () => () => {},
      bind: () => (key) => key,
      resolveText: (text) => text,
      getSnapshot: () => ({ active: 'en' }),
    },
    effect(fn) {
      const cleanup = fn();
      if (typeof cleanup === 'function') cleanups.push(cleanup);
    },
    on: () => () => {},
    remote: {
      $on(event) {
        remoteEvents.push(event);
        return () => {};
      },
    },
    sessions: {
      list: { getSnapshot: () => ({ byId: {} }) },
      refresh: async () => {},
    },
    slots: {
      inject(name, factory) {
        return factory();
      },
      register(options) {
        slotRegistrations.push(options);
        return () => {};
      },
    },
    inject(services, callback) {
      callback(fakeScope);
      return () => {};
    },
    get(name) {
      return name === 'uiSession' ? fakeScope.uiSession : undefined;
    },
  };
  return { ctx, slotRegistrations, remoteEvents, cleanups };
}

test('apply installs the six slot entries and never throws', () => {
  const mod = loaded.factory(requireStub);
  const { ctx, slotRegistrations, remoteEvents } = createFakeContext();
  assert.doesNotThrow(() => mod.apply(ctx));
  const ids = slotRegistrations.map((options) => options.id);
  assert.deepEqual(ids.sort(), [
    'session-manager-sound',
    'session-manager.batch',
    'session-manager.cleanup',
    'session-manager.confirm',
    'session-manager.delete-archived',
    'session-manager.toasts',
  ].sort());
  assert.ok(remoteEvents.includes('api-session/status'));
  assert.ok(remoteEvents.includes('api-session/error'));
});

test('noticeOpenable mirrors the Open button condition', () => {
  const mod = loaded.factory(requireStub);
  const { noticeOpenable } = mod.__test;
  const withId = { kind: 'completed', sessionId: ID };
  assert.equal(noticeOpenable(withId, true), true);
  assert.equal(noticeOpenable(withId, undefined), true);
  assert.equal(noticeOpenable(withId, false), false, 'no workspace service means no card click');
  assert.equal(noticeOpenable({ kind: 'scheduled', sessionId: null }, true), false);
  assert.equal(noticeOpenable(null, true), false);
});

test('apply degrades instead of throwing with an empty context', () => {
  const mod = loaded.factory(requireStub);
  const original = console.error;
  const captured = [];
  console.error = (...args) => {
    captured.push(args);
  };
  try {
    assert.doesNotThrow(() => mod.apply({}));
  } finally {
    console.error = original;
  }
  assert.ok(captured.length > 0, 'degraded subsystems should be reported, not thrown');
});

function createBehaviorContext(rows = {}) {
  const registrations = [];
  const handlers = new Map();
  const statusListeners = new Set();
  const cleanups = [];
  const list = { byId: rows, ids: Object.keys(rows) };
  let statusSnapshot = new Map();
  const source = {
    getSnapshot: () => statusSnapshot,
    subscribe(listener) {
      statusListeners.add(listener);
      return () => statusListeners.delete(listener);
    },
  };
  const fakeScope = {
    uiSession: { sessionStatus: source },
    effect(fn) {
      const cleanup = fn();
      if (typeof cleanup === 'function') cleanups.push(cleanup);
    },
  };
  const messages = {
    untitled: 'Untitled',
    'notice.error': 'Error',
    'notice.completed': 'Completed',
    'notice.deleted': 'Deleted',
    'notice.scheduled': 'Scheduled',
    'delete.unavailable': 'Unavailable',
    'delete.failed': 'Failed: {message}',
    'delete.restartRequired': 'Restart required',
    'delete.childSessions': 'Children {count}',
    'delete.keptSchedules': 'Kept {count}',
    'batch.scheduledToast': 'Scheduled {count}',
    'cleanup.toast': 'Moved {moved}',
    'cleanup.partialToast': 'Moved {moved}, failed {failed}',
    'cleanup.loadFailed': 'Cleanup scan failed',
  };
  const ctx = {
    locale: {
      register: () => () => {},
      bind: () => (key, params) => (messages[key] ?? key)
        .replace(/\{(\w+)\}/g, (match, name) => (params && name in params ? String(params[name]) : match)),
      resolveText: (text) => text,
    },
    effect(fn) {
      const cleanup = fn();
      if (typeof cleanup === 'function') cleanups.push(cleanup);
    },
    slots: {
      inject(name, factory) {
        return factory();
      },
      register(options, component) {
        registrations.push({ options, component });
        return () => {};
      },
    },
    sessions: {
      list: { getSnapshot: () => list },
      refresh: async () => {},
    },
    remote: {
      $on(event, handler) {
        handlers.set(event, handler);
        return () => handlers.delete(event);
      },
    },
    inject(_services, callback) {
      callback(fakeScope);
      return () => {};
    },
    get(name) {
      return name === 'uiSession' ? fakeScope.uiSession : undefined;
    },
  };
  const publish = (next) => {
    statusSnapshot = next;
    for (const listener of [...statusListeners]) listener();
  };
  return { ctx, registrations, handlers, publish, cleanups };
}

function slotView(registrations, id) {
  const entry = registrations.find((registration) => registration.options.id === id);
  assert.ok(entry, `slot entry ${id} was not registered`);
  return entry.options.inject();
}

test('a failed turn alerts as an error, not also as a completion, with a displayTitle', () => {
  const mod = loaded.factory(requireStub);
  const { ctx, registrations, handlers, publish } = createBehaviorContext({
    [ID]: {
      id: ID,
      displayTitle: 'Project title',
      blank: false,
      running: false,
      retainedBy: { mainView: 0 },
    },
  });
  mod.apply(ctx);
  const { view } = slotView(registrations, 'session-manager.toasts');

  publish(new Map([[ID, { running: true }]]));
  handlers.get('api-session/error')(ID, 'boom');
  publish(new Map([[ID, { running: false }]]));

  const toasts = view.getSnapshot().toasts;
  assert.deepEqual(toasts.map((toast) => toast.kind), ['error']);
  assert.equal(toasts[0].title, 'Project title');
  assert.equal(toasts[0].detail, 'boom');
});

test('subagent completions stay quiet while forked sessions still alert', () => {
  const SUB = 'cb841833-fb14-49c7-a884-bc81b52b400f';
  const FORK = 'session-11111111-2222-3333-4444-555555555555';
  const mod = loaded.factory(requireStub);
  const { ctx, registrations, publish } = createBehaviorContext({
    [SUB]: {
      id: SUB,
      origin: 'subagent',
      parentId: ID,
      displayTitle: 'Subagent',
      blank: false,
      running: false,
      retainedBy: { mainView: 0 },
    },
    [FORK]: {
      id: FORK,
      parentId: ID,
      displayTitle: 'Fork',
      blank: false,
      running: false,
      retainedBy: { mainView: 0 },
    },
  });
  mod.apply(ctx);
  const { view } = slotView(registrations, 'session-manager.toasts');

  publish(new Map([
    [SUB, { running: true }],
    [FORK, { running: true }],
  ]));
  publish(new Map([
    [SUB, { running: false }],
    [FORK, { running: false }],
  ]));

  assert.deepEqual(view.getSnapshot().toasts.map((toast) => toast.title), ['Fork']);
});

test('approval notices resolve a localized displayReason map', () => {
  const mod = loaded.factory(requireStub);
  const { ctx, registrations, publish } = createBehaviorContext({
    [ID]: {
      id: ID,
      displayTitle: 'Project title',
      blank: false,
      running: false,
      retainedBy: { mainView: 0 },
    },
  });
  mod.apply(ctx);
  const { view } = slotView(registrations, 'session-manager.toasts');

  publish(new Map([[ID, {
    running: false,
    pendingInteraction: {
      kind: 'approval',
      key: 'approval:1',
      toolName: 'write',
      displayReason: { en: 'Needs write access', zh: '需要写权限' },
    },
  }]]));

  const toast = view.getSnapshot().toasts.at(-1);
  assert.equal(toast.kind, 'approval');
  assert.equal(toast.detail, 'write · Needs write access');
});

test('a missing host route maps to the localized unavailable message', async () => {
  const mod = loaded.factory(requireStub);
  const { ctx, registrations } = createBehaviorContext({});
  mod.apply(ctx);
  const { view, actions } = slotView(registrations, 'session-manager.confirm');

  const original = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 405, json: async () => null });
  try {
    actions.requestDelete({ sessionId: ID, title: 'T' });
    await actions.confirmDelete();
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(view.getSnapshot().confirm.error, 'Failed: Unavailable');
});

test('a scheduled deletion closes the dialog and shows a sticky restart notice', async () => {
  const mod = loaded.factory(requireStub);
  const { ctx, registrations } = createBehaviorContext({});
  mod.apply(ctx);
  const { view, actions } = slotView(registrations, 'session-manager.confirm');

  const original = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 202,
    json: async () => ({
      ok: true,
      code: 'restart-required',
      sessionId: ID,
      message: 'session is held by the running DSH process',
    }),
  });
  try {
    actions.requestDelete({ sessionId: ID, title: 'T' });
    await actions.confirmDelete();
  } finally {
    globalThis.fetch = original;
  }

  assert.equal(view.getSnapshot().confirm, null, 'dialog closes');
  const toasts = view.getSnapshot().toasts;
  assert.equal(toasts.some((toast) => toast.kind === 'deleted'), false);
  const scheduled = toasts.find((toast) => toast.kind === 'scheduled');
  assert.ok(scheduled, 'scheduled notice was pushed');
  assert.equal(scheduled.sticky, true);
  assert.equal(scheduled.sessionId, null, 'no Open action on a queued deletion');
  assert.equal(scheduled.title, 'T');
  assert.equal(scheduled.detail, 'Restart required');
});

test('the delete request carries moveToTrash only when the box is checked', async () => {
  const mod = loaded.factory(requireStub);
  const { ctx, registrations } = createBehaviorContext({});
  mod.apply(ctx);
  const { actions } = slotView(registrations, 'session-manager.confirm');

  const original = globalThis.fetch;
  const bodies = [];
  globalThis.fetch = async (_url, options) => {
    bodies.push(JSON.parse(options.body));
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, removedChildSessions: [], boundSchedules: { count: 0 }, warnings: [] }),
    };
  };
  try {
    actions.requestDelete({ sessionId: ID, title: 'T' });
    await actions.confirmDelete();

    actions.requestDelete({ sessionId: ID, title: 'T' });
    actions.setMoveToTrash(true);
    await actions.confirmDelete();
  } finally {
    globalThis.fetch = original;
  }

  // The legacy body stays byte-identical: old hosts ignore unknown fields,
  // but keeping it unchanged also keeps the old E2E assertions valid.
  assert.deepEqual(bodies[0], { sessionId: ID, confirm: true });
  assert.deepEqual(bodies[1], { sessionId: ID, confirm: true, moveToTrash: true });
});

test('the success toast reports deleted subagent sessions', async () => {
  const mod = loaded.factory(requireStub);
  const { ctx, registrations } = createBehaviorContext({});
  mod.apply(ctx);
  const { view, actions } = slotView(registrations, 'session-manager.confirm');

  const original = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      ok: true,
      removedChildSessions: ['cb841833-fb14-49c7-a884-bc81b52b400f'],
      boundSchedules: { count: 0 },
      warnings: [],
    }),
  });
  try {
    actions.requestDelete({ sessionId: ID, title: 'T' });
    await actions.confirmDelete();
  } finally {
    globalThis.fetch = original;
  }
  const toasts = view.getSnapshot().toasts;
  const deleted = toasts.find((toast) => toast.kind === 'deleted');
  assert.ok(deleted, 'deleted notice was pushed');
  assert.equal(deleted.detail, 'Children 1');
});

const OTHER = 'session-11111111-2222-3333-4444-555555555555';
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

test('the batch dialog loads archived ids and tracks selection', async () => {
  const mod = loaded.factory(requireStub);
  const { ctx, registrations } = createBehaviorContext({});
  mod.apply(ctx);
  const { view, actions } = slotView(registrations, 'session-manager.batch');
  assert.equal(typeof actions.open, 'function');

  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return { ok: true, status: 200, json: async () => ({ ok: true, sessions: [ID, OTHER] }) };
  };
  try {
    actions.open();
    await tick();
  } finally {
    globalThis.fetch = original;
  }

  const snapshot = view.getSnapshot();
  assert.equal(snapshot.open, true);
  assert.equal(snapshot.loading, false);
  assert.deepEqual(snapshot.ids, [ID, OTHER]);
  assert.equal(calls[0].url, '/session-manager/api/archived');

  actions.toggle(ID);
  assert.deepEqual(view.getSnapshot().selected, [ID]);
  actions.setFilter('name');
  assert.equal(view.getSnapshot().filter, 'name');
  actions.close();
  assert.equal(view.getSnapshot().open, false);
});

test('batch delete reports mixed outcomes and pushes one summary toast', async () => {
  const mod = loaded.factory(requireStub);
  const { ctx, registrations } = createBehaviorContext({});
  mod.apply(ctx);
  const batch = slotView(registrations, 'session-manager.batch');
  const toasts = slotView(registrations, 'session-manager.toasts');

  const original = globalThis.fetch;
  const items = [
    { sessionId: ID, status: 'deleted' },
    { sessionId: OTHER, status: 'scheduled', code: 'restart-required' },
  ];
  globalThis.fetch = async (url) => {
    if (String(url).includes('/archived')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, sessions: [ID, OTHER] }) };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, results: items }) };
  };
  try {
    batch.actions.open();
    await tick();
    batch.actions.toggle(ID);
    batch.actions.toggle(OTHER);
    await batch.actions.deleteSelected();
  } finally {
    globalThis.fetch = original;
  }

  const snapshot = batch.view.getSnapshot();
  assert.equal(snapshot.deleting, false);
  assert.deepEqual(snapshot.selected, []);
  assert.deepEqual(snapshot.results, {
    items,
    deleted: 1,
    scheduled: 1,
    skipped: 0,
    failed: 0,
  });

  const notices = toasts.view.getSnapshot().toasts;
  assert.equal(notices.length, 1);
  assert.equal(notices[0].kind, 'scheduled');
  assert.equal(notices[0].sticky, true);
  assert.equal(notices[0].detail, 'Scheduled 1');
});

test('the batch delete request carries moveToTrash and the toggle survives reopen', async () => {
  const mod = loaded.factory(requireStub);
  const { ctx, registrations } = createBehaviorContext({});
  mod.apply(ctx);
  const batch = slotView(registrations, 'session-manager.batch');

  const original = globalThis.fetch;
  const bodies = [];
  globalThis.fetch = async (url, options) => {
    if (String(url).includes('/archived')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, sessions: [ID] }) };
    }
    bodies.push(JSON.parse(options.body));
    return { ok: true, status: 200, json: async () => ({ ok: true, results: [{ sessionId: ID, status: 'deleted' }] }) };
  };
  try {
    batch.actions.open();
    await tick();
    batch.actions.setMoveToTrash(true);
    batch.actions.toggle(ID);
    await batch.actions.deleteSelected();
    batch.actions.close();
    batch.actions.open();
    await tick();
  } finally {
    globalThis.fetch = original;
  }

  assert.deepEqual(bodies, [{ sessionIds: [ID], confirm: true, moveToTrash: true }]);
  assert.equal(batch.view.getSnapshot().moveToTrash, true, 'the choice is kept across opens');
});

test('the cleanup dialog scans, opens a location and moves everything to the bin', async () => {
  const mod = loaded.factory(requireStub);
  const { ctx, registrations } = createBehaviorContext({});
  mod.apply(ctx);
  const cleanup = slotView(registrations, 'session-manager.cleanup');
  const toasts = slotView(registrations, 'session-manager.toasts');

  const orphan = 'C:\\root\\--x--\\session-orphan';
  const tombstone = 'C:\\root\\--x--\\session-a\\session.v4.jsonl.zstd.sm-delete-1';
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url).includes('/open-path')) {
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    if (options?.method === 'POST') {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          results: [
            { path: orphan, status: 'moved' },
            { path: tombstone, status: 'moved' },
          ],
        }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        items: [
          { path: orphan, kind: 'session-dir' },
          { path: tombstone, kind: 'tombstone' },
        ],
        truncated: false,
      }),
    };
  };
  try {
    cleanup.actions.open();
    await tick();
    const scanned = cleanup.view.getSnapshot();
    assert.equal(scanned.loading, false);
    assert.deepEqual(scanned.items.map((item) => item.path), [orphan, tombstone]);
    assert.equal(calls[0].url, '/session-manager/api/cleanup');

    await cleanup.actions.openLocation(orphan);
    assert.equal(calls[1].url, '/session-manager/api/open-path');
    assert.deepEqual(JSON.parse(calls[1].options.body), { path: orphan });

    await cleanup.actions.moveAll();
  } finally {
    globalThis.fetch = original;
  }

  const after = cleanup.view.getSnapshot();
  assert.deepEqual(after.results, {
    items: [
      { path: orphan, status: 'moved' },
      { path: tombstone, status: 'moved' },
    ],
    moved: 2,
    failed: 0,
  });
  assert.deepEqual(after.items, [], 'the list is cleared after a successful move');
  const notice = toasts.view.getSnapshot().toasts.at(-1);
  assert.equal(notice.kind, 'deleted');
  assert.equal(notice.detail, 'Moved 2');

  const post = calls.find((call) => call.options && call.options.method === 'POST'
    && String(call.url).includes('/cleanup'));
  assert.deepEqual(JSON.parse(post.options.body), { paths: [orphan, tombstone], confirm: true });
});

test('a missing cleanup route maps to the localized unavailable message', async () => {
  const mod = loaded.factory(requireStub);
  const { ctx, registrations } = createBehaviorContext({});
  mod.apply(ctx);
  const cleanup = slotView(registrations, 'session-manager.cleanup');

  const original = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 405, json: async () => null });
  try {
    cleanup.actions.open();
    await tick();
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(cleanup.view.getSnapshot().error, 'Unavailable');
});

test('the debug seam injects a toast carrying a session id', () => {
  const mod = loaded.factory(requireStub);
  const { ctx, registrations } = createBehaviorContext({});
  mod.apply(ctx);
  const { view } = slotView(registrations, 'session-manager.toasts');
  try {
    globalThis.__SESSION_MANAGER_DEBUG__.pushNotice('completed', ID, 'probe', 'Probe');
    const notice = view.getSnapshot().toasts.at(-1);
    assert.equal(notice.sessionId, ID);
    assert.equal(notice.title, 'Probe');
  } finally {
    delete globalThis.__SESSION_MANAGER_DEBUG__;
  }
});
