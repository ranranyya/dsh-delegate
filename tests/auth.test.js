// Authorization tests: default-off, single-use consumption, revocation,
// expiry, and restart behaviour.
//
// These are the tests that decide whether the plugin is safe to install. Each
// one asserts a refusal that must not depend on any caller-supplied claim.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AUTH_CODES,
  AUTH_EVENT_REASONS,
  AUTH_RETENTION_MS,
  AuthError,
  AuthorizationRegistry,
  DEFAULT_CONNECTION_LEASE_MS,
  normalizeWorkspace,
} from '../src/auth/grants.js';
import { LIMITS } from '../src/config/defaults.js';

const WINDOWS = process.platform === 'win32';
const WORKSPACE = WINDOWS ? 'C:\\work\\project' : '/work/project';
const OTHER_WORKSPACE = WINDOWS ? 'C:\\work\\other' : '/work/other';

function registryAt(clock) {
  return new AuthorizationRegistry({ now: () => clock.value });
}

test('delegation is off in a fresh registry', () => {
  const registry = new AuthorizationRegistry();
  assert.equal(registry.isDelegationAuthorized(), false);
  assert.deepEqual(registry.listConnections(), []);
});

test('a connection token is returned once and never re-readable', () => {
  const registry = new AuthorizationRegistry();
  const issued = registry.issueConnection({ label: 'codex' });
  assert.match(issued.token, /^[A-Za-z0-9_-]{40,}$/);
  assert.equal(registry.authenticate(issued.token).connectionId, issued.connectionId);

  const listed = registry.listConnections();
  assert.equal(listed.length, 1);
  // The listing must not contain the token or its hash.
  const serialized = JSON.stringify(listed);
  assert.equal(serialized.includes(issued.token), false);
  assert.equal(serialized.includes('tokenHash'), false);
});

test('a wrong token authenticates nothing', () => {
  const registry = new AuthorizationRegistry();
  const issued = registry.issueConnection({});
  assert.equal(registry.authenticate(''), null);
  assert.equal(registry.authenticate('not-a-token'), null);
  assert.equal(registry.authenticate(issued.token.slice(0, -1)), null);
});

test('a task grant authorizes exactly one consumption', () => {
  const registry = new AuthorizationRegistry();
  const { connectionId } = registry.issueConnection({});
  const grant = registry.issueGrant(connectionId, {
    kind: 'task',
    workspacePath: WORKSPACE,
    ttlSeconds: 60,
  });
  assert.equal(registry.isDelegationAuthorized(), true);

  const first = registry.consumeTaskGrant({
    connectionId,
    grantId: grant.grantId,
    taskId: 'task-1',
    workspacePath: WORKSPACE,
  });
  assert.equal(first.consumedByTaskId, 'task-1');

  assert.throws(
    () => registry.consumeTaskGrant({
      connectionId,
      grantId: grant.grantId,
      taskId: 'task-2',
      workspacePath: WORKSPACE,
    }),
    (error) => error instanceof AuthError && error.code === AUTH_CODES.grantConsumed,
  );
  // The second attempt must not have created a second authorization.
  assert.equal(registry.isDelegationAuthorized(), false);
});

test('concurrent consumption cannot double-spend one grant', async () => {
  const registry = new AuthorizationRegistry();
  const { connectionId } = registry.issueConnection({});
  const grant = registry.issueGrant(connectionId, {
    kind: 'task',
    workspacePath: WORKSPACE,
    ttlSeconds: 60,
  });

  const attempt = (taskId) => Promise.resolve().then(() => registry.consumeTaskGrant({
    connectionId,
    grantId: grant.grantId,
    taskId,
    workspacePath: WORKSPACE,
  }));

  const results = await Promise.allSettled([attempt('task-a'), attempt('task-b'), attempt('task-c')]);
  const fulfilled = results.filter((entry) => entry.status === 'fulfilled');
  assert.equal(fulfilled.length, 1, 'exactly one consumer may win');
  for (const entry of results.filter((result) => result.status === 'rejected')) {
    assert.equal(entry.reason.code, AUTH_CODES.grantConsumed);
  }
});

test('a task grant cannot be spent on another workspace', () => {
  const registry = new AuthorizationRegistry();
  const { connectionId } = registry.issueConnection({});
  const grant = registry.issueGrant(connectionId, {
    kind: 'task',
    workspacePath: WORKSPACE,
    ttlSeconds: 60,
  });
  const other = process.platform === 'win32' ? 'C:\\work\\other' : '/work/other';

  assert.throws(
    () => registry.consumeTaskGrant({
      connectionId,
      grantId: grant.grantId,
      taskId: 'task-1',
      workspacePath: other,
    }),
    (error) => error.code === AUTH_CODES.grantMismatch,
  );
  // A refused consumption must not burn the grant.
  const ok = registry.consumeTaskGrant({
    connectionId,
    grantId: grant.grantId,
    taskId: 'task-1',
    workspacePath: WORKSPACE,
  });
  assert.equal(ok.consumedByTaskId, 'task-1');
});

test('another connection cannot use a grant it does not own', () => {
  const registry = new AuthorizationRegistry();
  const owner = registry.issueConnection({ label: 'owner' });
  const stranger = registry.issueConnection({ label: 'stranger' });
  const grant = registry.issueGrant(owner.connectionId, {
    kind: 'task',
    workspacePath: WORKSPACE,
    ttlSeconds: 60,
  });

  assert.throws(
    () => registry.consumeTaskGrant({
      connectionId: stranger.connectionId,
      grantId: grant.grantId,
      taskId: 'task-1',
      workspacePath: WORKSPACE,
    }),
    (error) => error.code === AUTH_CODES.grantUnknown,
  );
});

test('revoking a connection revokes its grants', () => {
  const registry = new AuthorizationRegistry();
  const { connectionId } = registry.issueConnection({});
  const grant = registry.issueGrant(connectionId, {
    kind: 'task',
    workspacePath: WORKSPACE,
    ttlSeconds: 60,
  });

  assert.equal(registry.revokeConnection(connectionId), 1);
  assert.throws(
    () => registry.consumeTaskGrant({
      connectionId,
      grantId: grant.grantId,
      taskId: 'task-1',
      workspacePath: WORKSPACE,
    }),
    (error) => error.code === AUTH_CODES.connectionRevoked,
  );
  assert.equal(registry.isDelegationAuthorized(), false);
});

test('an expired grant refuses and reports expiry', () => {
  const clock = { value: 1_000_000 };
  const registry = registryAt(clock);
  const { connectionId } = registry.issueConnection({});
  const grant = registry.issueGrant(connectionId, {
    kind: 'task',
    workspacePath: WORKSPACE,
    ttlSeconds: 30,
  });
  clock.value += 30_001;

  assert.throws(
    () => registry.consumeTaskGrant({
      connectionId,
      grantId: grant.grantId,
      taskId: 'task-1',
      workspacePath: WORKSPACE,
    }),
    (error) => error.code === AUTH_CODES.grantExpired,
  );
  assert.equal(registry.isDelegationAuthorized(), false);
});

test('a restart loses every authorization', async () => {
  const first = new AuthorizationRegistry();
  const { connectionId } = first.issueConnection({});
  first.issueGrant(connectionId, { kind: 'task', workspacePath: WORKSPACE, ttlSeconds: 600 });
  assert.equal(first.isDelegationAuthorized(), true);

  // A new process builds a new registry; nothing is loaded from disk because
  // delegation state is deliberately not persisted.
  const restarted = new AuthorizationRegistry();
  assert.equal(restarted.isDelegationAuthorized(), false);
  assert.deepEqual(restarted.listConnections(), []);
  assert.throws(
    () => restarted.consumeTaskGrant({
      connectionId,
      grantId: 'grant-anything',
      taskId: 'task-1',
      workspacePath: WORKSPACE,
    }),
    (error) => error.code === AUTH_CODES.connectionUnknown,
  );
});

test('a session grant allows repeated starts but stops on revoke', () => {
  const registry = new AuthorizationRegistry();
  const { connectionId } = registry.issueConnection({});
  const grant = registry.issueGrant(connectionId, {
    kind: 'session',
    workspacePath: WORKSPACE,
    ttlSeconds: 600,
  });

  const first = registry.requireSessionGrant({ connectionId, workspacePath: WORKSPACE });
  const second = registry.requireSessionGrant({ connectionId, workspacePath: WORKSPACE });
  assert.equal(first.grantId, second.grantId);

  registry.revokeGrant({ grantId: grant.grantId, allowOperator: true });
  assert.throws(
    () => registry.requireSessionGrant({ connectionId, workspacePath: WORKSPACE }),
    (error) => error.code === AUTH_CODES.grantUnknown,
  );
});

test('a session grant cannot be consumed as a task grant', () => {
  const registry = new AuthorizationRegistry();
  const { connectionId } = registry.issueConnection({});
  const grant = registry.issueGrant(connectionId, {
    kind: 'session',
    workspacePath: WORKSPACE,
    ttlSeconds: 600,
  });
  assert.throws(
    () => registry.consumeTaskGrant({
      connectionId,
      grantId: grant.grantId,
      taskId: 'task-1',
      workspacePath: WORKSPACE,
    }),
    (error) => error.code === AUTH_CODES.grantMismatch,
  );
});

test('grant issuance is bounded', () => {
  const registry = new AuthorizationRegistry();
  const { connectionId } = registry.issueConnection({});
  for (let index = 0; index < 32; index += 1) {
    registry.issueGrant(connectionId, { kind: 'task', workspacePath: WORKSPACE, ttlSeconds: 600 });
  }
  assert.throws(
    () => registry.issueGrant(connectionId, { kind: 'task', workspacePath: WORKSPACE, ttlSeconds: 600 }),
    (error) => error.code === AUTH_CODES.grantLimit,
  );
});

test('revokeAll stops every outstanding authorization', () => {
  const registry = new AuthorizationRegistry();
  const one = registry.issueConnection({});
  const two = registry.issueConnection({});
  registry.issueGrant(one.connectionId, { kind: 'task', workspacePath: WORKSPACE, ttlSeconds: 600 });
  registry.issueGrant(two.connectionId, { kind: 'session', workspacePath: WORKSPACE, ttlSeconds: 600 });

  assert.equal(registry.revokeAll(), 2);
  assert.equal(registry.isDelegationAuthorized(), false);
});

test('workspace normalization refuses relative paths', () => {
  assert.throws(() => normalizeWorkspace('relative/path'), (error) => error.code === 'GRANT_WORKSPACE_NOT_ABSOLUTE');
  assert.throws(() => normalizeWorkspace(''), (error) => error.code === 'GRANT_WORKSPACE_REQUIRED');
  const normalized = normalizeWorkspace(`${WORKSPACE}${WINDOWS ? '\\' : '/'}`);
  assert.equal(normalized.endsWith(WINDOWS ? '\\' : '/'), false);
  assert.equal(normalized, normalizeWorkspace(WORKSPACE), 'a trailing separator must not change the key');
});

// ---------------------------------------------------------------------------
// Workspace canonicalization
// ---------------------------------------------------------------------------

test('workspace normalization folds separator spelling and case', () => {
  if (WINDOWS) {
    assert.equal(normalizeWorkspace('C:/work/project'), normalizeWorkspace('C:\\WORK\\Project'));
    assert.equal(normalizeWorkspace('C:\\work\\project'), 'c:\\work\\project');
    assert.equal(normalizeWorkspace('  C:\\work\\project  '), 'c:\\work\\project');
  } else {
    assert.equal(normalizeWorkspace('/work/project/'), '/work/project');
    // A POSIX filesystem may be case-sensitive; the key must not fold it.
    assert.notEqual(normalizeWorkspace('/Work/Project'), normalizeWorkspace('/work/project'));
  }
});

test('workspace normalization collapses dot segments and keeps the root', () => {
  if (WINDOWS) {
    // `..` must resolve, not survive as a literal segment: otherwise a grant for
    // C:\work\project would also cover C:\work\project\..\secrets.
    assert.equal(normalizeWorkspace('C:\\work\\project\\..\\other'), normalizeWorkspace('C:\\work\\other'));
    assert.equal(normalizeWorkspace('C:\\work\\.\\project'), 'c:\\work\\project');
    assert.equal(normalizeWorkspace('C:\\'), 'c:\\');
    assert.equal(normalizeWorkspace('C:/'), 'c:\\');
    assert.equal(normalizeWorkspace('C:\\work\\..\\..\\'), 'c:\\');
  } else {
    assert.equal(normalizeWorkspace('/work/project/../other'), '/work/other');
    assert.equal(normalizeWorkspace('/work/./project'), '/work/project');
    assert.equal(normalizeWorkspace('/'), '/');
    assert.equal(normalizeWorkspace('/work/../..'), '/');
  }
});

test('workspace normalization refuses NUL bytes and non-strings', () => {
  for (const value of ['C:\\work\0\\project', '/work\0/project']) {
    assert.throws(() => normalizeWorkspace(value), (error) => error.code === 'GRANT_WORKSPACE_INVALID');
  }
  for (const value of [null, undefined, 42, {}, [], '   ']) {
    assert.throws(() => normalizeWorkspace(value), (error) => error.code === 'GRANT_WORKSPACE_REQUIRED');
  }
});

test('a grant issued for one spelling covers every equivalent spelling', () => {
  const registry = new AuthorizationRegistry();
  const { connectionId } = registry.issueConnection({});
  const grant = registry.issueGrant(connectionId, { kind: 'task', workspacePath: WORKSPACE, ttlSeconds: 600 });
  const respelled = WINDOWS
    ? `${WORKSPACE.replace('\\', '/')}\\`
    : `${WORKSPACE}/`;
  const consumed = registry.consumeTaskGrant({
    connectionId,
    grantId: grant.grantId,
    taskId: 'task-1',
    workspacePath: respelled,
  });
  assert.equal(consumed.consumedByTaskId, 'task-1');
});

// ---------------------------------------------------------------------------
// TTL bounds (per kind)
// ---------------------------------------------------------------------------

test('grant TTL is bounded per kind', () => {
  const registry = new AuthorizationRegistry();
  const { connectionId } = registry.issueConnection({});

  for (const ttlSeconds of [LIMITS.taskGrantTtlSecondsMin, LIMITS.taskGrantTtlSecondsMax]) {
    const grant = registry.issueGrant(connectionId, { kind: 'task', workspacePath: WORKSPACE, ttlSeconds });
    assert.equal(grant.expiresAt - grant.createdAt, ttlSeconds * 1000);
  }
  for (const ttlSeconds of [LIMITS.sessionGrantTtlSecondsMin, LIMITS.sessionGrantTtlSecondsMax]) {
    const grant = registry.issueGrant(connectionId, { kind: 'session', workspacePath: WORKSPACE, ttlSeconds });
    assert.equal(grant.expiresAt - grant.createdAt, ttlSeconds * 1000);
  }

  for (const ttlSeconds of [LIMITS.taskGrantTtlSecondsMin - 1, LIMITS.taskGrantTtlSecondsMax + 1]) {
    assert.throws(
      () => registry.issueGrant(connectionId, { kind: 'task', workspacePath: WORKSPACE, ttlSeconds }),
      (error) => error.code === 'GRANT_TTL_OUT_OF_RANGE',
      `task ttl ${ttlSeconds} must be refused`,
    );
  }
  for (const ttlSeconds of [LIMITS.sessionGrantTtlSecondsMin - 1, LIMITS.sessionGrantTtlSecondsMax + 1]) {
    assert.throws(
      () => registry.issueGrant(connectionId, { kind: 'session', workspacePath: WORKSPACE, ttlSeconds }),
      (error) => error.code === 'GRANT_TTL_OUT_OF_RANGE',
      `session ttl ${ttlSeconds} must be refused`,
    );
  }
  // A session TTL above the *task* ceiling is legitimate; the bounds are per kind.
  assert.doesNotThrow(() => registry.issueGrant(connectionId, {
    kind: 'session',
    workspacePath: WORKSPACE,
    ttlSeconds: LIMITS.taskGrantTtlSecondsMax + 1,
  }));
});

test('a non-integer or non-positive TTL is refused before any grant exists', () => {
  const registry = new AuthorizationRegistry();
  const { connectionId } = registry.issueConnection({});
  for (const ttlSeconds of [0, -1, 1.5, NaN, Infinity, '600', null, undefined]) {
    assert.throws(
      () => registry.issueGrant(connectionId, { kind: 'task', workspacePath: WORKSPACE, ttlSeconds }),
      (error) => error.code === 'GRANT_TTL_INVALID',
      `ttl ${String(ttlSeconds)} must be refused`,
    );
  }
  assert.deepEqual(registry.listGrants(connectionId), []);
});

// ---------------------------------------------------------------------------
// assertTaskAuthorized
// ---------------------------------------------------------------------------

test('assertTaskAuthorized accepts exactly the task that consumed the grant', () => {
  const registry = new AuthorizationRegistry();
  const { connectionId } = registry.issueConnection({});
  const grant = registry.issueGrant(connectionId, { kind: 'task', workspacePath: WORKSPACE, ttlSeconds: 600 });
  registry.consumeTaskGrant({ connectionId, grantId: grant.grantId, taskId: 'task-1', workspacePath: WORKSPACE });

  const checked = registry.assertTaskAuthorized({
    connectionId,
    grantId: grant.grantId,
    taskId: 'task-1',
    workspacePath: WORKSPACE,
  });
  assert.equal(checked.grantId, grant.grantId);
  assert.equal(checked.consumedByTaskId, 'task-1');

  // The returned value is a snapshot: mutating it cannot touch the grant.
  checked.consumedByTaskId = 'task-other';
  checked.revokedAt = 123;
  const again = registry.assertTaskAuthorized({
    connectionId,
    grantId: grant.grantId,
    taskId: 'task-1',
    workspacePath: WORKSPACE,
  });
  assert.equal(again.consumedByTaskId, 'task-1');
  assert.equal(again.revokedAt, null);
});

test('a consumed task grant authorizes no other task', () => {
  const registry = new AuthorizationRegistry();
  const { connectionId } = registry.issueConnection({});
  const grant = registry.issueGrant(connectionId, { kind: 'task', workspacePath: WORKSPACE, ttlSeconds: 600 });
  registry.consumeTaskGrant({ connectionId, grantId: grant.grantId, taskId: 'task-1', workspacePath: WORKSPACE });

  assert.throws(
    () => registry.assertTaskAuthorized({
      connectionId,
      grantId: grant.grantId,
      taskId: 'task-2',
      workspacePath: WORKSPACE,
    }),
    (error) => error.code === AUTH_CODES.grantConsumed && error.details.consumedByTaskId === 'task-1',
  );
  // Consumption stays consumption: the grant must not become reusable.
  assert.throws(
    () => registry.consumeTaskGrant({
      connectionId,
      grantId: grant.grantId,
      taskId: 'task-2',
      workspacePath: WORKSPACE,
    }),
    (error) => error.code === AUTH_CODES.grantConsumed,
  );
});

test('assertTaskAuthorized refuses an unconsumed task grant', () => {
  const registry = new AuthorizationRegistry();
  const { connectionId } = registry.issueConnection({});
  const grant = registry.issueGrant(connectionId, { kind: 'task', workspacePath: WORKSPACE, ttlSeconds: 600 });
  assert.throws(
    () => registry.assertTaskAuthorized({
      connectionId,
      grantId: grant.grantId,
      taskId: 'task-1',
      workspacePath: WORKSPACE,
    }),
    (error) => error.code === AUTH_CODES.grantNotConsumed,
  );
});

test('assertTaskAuthorized refuses a forged or foreign grant', () => {
  const registry = new AuthorizationRegistry();
  const owner = registry.issueConnection({ label: 'owner' });
  const stranger = registry.issueConnection({ label: 'stranger' });
  const grant = registry.issueGrant(owner.connectionId, { kind: 'task', workspacePath: WORKSPACE, ttlSeconds: 600 });
  registry.consumeTaskGrant({
    connectionId: owner.connectionId,
    grantId: grant.grantId,
    taskId: 'task-1',
    workspacePath: WORKSPACE,
  });

  // A stranger naming a real grant id learns only that it has none.
  assert.throws(
    () => registry.assertTaskAuthorized({
      connectionId: stranger.connectionId,
      grantId: grant.grantId,
      taskId: 'task-1',
      workspacePath: WORKSPACE,
    }),
    (error) => error.code === AUTH_CODES.grantUnknown,
  );
  // An invented grant id is equally unknown.
  assert.throws(
    () => registry.assertTaskAuthorized({
      connectionId: owner.connectionId,
      grantId: 'grant-forged',
      taskId: 'task-1',
      workspacePath: WORKSPACE,
    }),
    (error) => error.code === AUTH_CODES.grantUnknown,
  );
  // A different workspace is not covered even for the owning connection.
  assert.throws(
    () => registry.assertTaskAuthorized({
      connectionId: owner.connectionId,
      grantId: grant.grantId,
      taskId: 'task-1',
      workspacePath: OTHER_WORKSPACE,
    }),
    (error) => error.code === AUTH_CODES.grantMismatch,
  );
  // A missing task id cannot be authorized.
  assert.throws(
    () => registry.assertTaskAuthorized({
      connectionId: owner.connectionId,
      grantId: grant.grantId,
      workspacePath: WORKSPACE,
    }),
    (error) => error.code === 'GRANT_TASK_REQUIRED',
  );
});

test('assertTaskAuthorized honours expiry and revocation', () => {
  const clock = { value: 5_000_000 };
  const registry = registryAt(clock);
  const { connectionId, token } = registry.issueConnection({});
  const grant = registry.issueGrant(connectionId, { kind: 'task', workspacePath: WORKSPACE, ttlSeconds: 600 });
  registry.consumeTaskGrant({ connectionId, grantId: grant.grantId, taskId: 'task-1', workspacePath: WORKSPACE });

  const input = { connectionId, grantId: grant.grantId, taskId: 'task-1', workspacePath: WORKSPACE };
  assert.equal(registry.assertTaskAuthorized(input).grantId, grant.grantId);

  // Time passes while the task runs, and the connection keeps heartbeating: the
  // refusal must be the grant's expiry, not a lapsed idle lease.
  for (let step = 0; step < 7; step += 1) {
    clock.value += 100_000;
    assert.notEqual(registry.authenticate(token), null);
  }
  assert.equal(clock.value, 5_700_000);
  assert.throws(() => registry.assertTaskAuthorized(input), (error) => error.code === AUTH_CODES.grantExpired);

  // And a revoked grant is refused as revoked, not as expired.
  const later = registry.issueGrant(connectionId, { kind: 'task', workspacePath: WORKSPACE, ttlSeconds: 600 });
  registry.consumeTaskGrant({
    connectionId,
    grantId: later.grantId,
    taskId: 'task-2',
    workspacePath: WORKSPACE,
  });
  registry.revokeGrant({ grantId: later.grantId, allowOperator: true });
  assert.throws(
    () => registry.assertTaskAuthorized({ connectionId, grantId: later.grantId, taskId: 'task-2', workspacePath: WORKSPACE }),
    (error) => error.code === AUTH_CODES.grantRevoked,
  );
});

test('assertTaskAuthorized requires the exact session grant id when one is named', () => {
  const registry = new AuthorizationRegistry();
  const { connectionId } = registry.issueConnection({});
  const first = registry.issueGrant(connectionId, { kind: 'session', workspacePath: WORKSPACE, ttlSeconds: 600 });
  const second = registry.issueGrant(connectionId, { kind: 'session', workspacePath: WORKSPACE, ttlSeconds: 600 });

  assert.equal(
    registry.assertTaskAuthorized({
      connectionId,
      grantId: first.grantId,
      taskId: 'task-1',
      workspacePath: WORKSPACE,
    }).grantId,
    first.grantId,
  );

  registry.revokeGrant({ grantId: first.grantId, allowOperator: true });
  assert.throws(
    () => registry.assertTaskAuthorized({
      connectionId,
      grantId: first.grantId,
      taskId: 'task-1',
      workspacePath: WORKSPACE,
    }),
    (error) => error.code === AUTH_CODES.grantRevoked,
  );
  // The unrelated session grant is untouched and still authorizes on its own id.
  assert.equal(
    registry.assertTaskAuthorized({
      connectionId,
      grantId: second.grantId,
      taskId: 'task-2',
      workspacePath: WORKSPACE,
    }).grantId,
    second.grantId,
  );
});

test('assertTaskAuthorized refuses a revoked connection', () => {
  const registry = new AuthorizationRegistry();
  const { connectionId } = registry.issueConnection({});
  const grant = registry.issueGrant(connectionId, { kind: 'task', workspacePath: WORKSPACE, ttlSeconds: 600 });
  registry.consumeTaskGrant({ connectionId, grantId: grant.grantId, taskId: 'task-1', workspacePath: WORKSPACE });
  registry.revokeConnection(connectionId);

  assert.throws(
    () => registry.assertTaskAuthorized({
      connectionId,
      grantId: grant.grantId,
      taskId: 'task-1',
      workspacePath: WORKSPACE,
    }),
    (error) => error.code === AUTH_CODES.connectionRevoked,
  );
});

test('requireSessionGrant does not shop for a different live session grant', () => {
  const registry = new AuthorizationRegistry();
  const { connectionId } = registry.issueConnection({});
  const live = registry.issueGrant(connectionId, { kind: 'session', workspacePath: WORKSPACE, ttlSeconds: 600 });
  const dead = registry.issueGrant(connectionId, { kind: 'session', workspacePath: WORKSPACE, ttlSeconds: 600 });
  registry.revokeGrant({ grantId: dead.grantId, allowOperator: true });

  assert.throws(
    () => registry.requireSessionGrant({ connectionId, grantId: dead.grantId, workspacePath: WORKSPACE }),
    (error) => error.code === AUTH_CODES.grantRevoked,
  );
  assert.equal(
    registry.requireSessionGrant({ connectionId, grantId: live.grantId, workspacePath: WORKSPACE }).grantId,
    live.grantId,
  );
  // A task grant is not a session grant, even when both cover the workspace.
  const task = registry.issueGrant(connectionId, { kind: 'task', workspacePath: WORKSPACE, ttlSeconds: 600 });
  assert.throws(
    () => registry.requireSessionGrant({ connectionId, grantId: task.grantId, workspacePath: WORKSPACE }),
    (error) => error.code === AUTH_CODES.grantMismatch,
  );
});

// ---------------------------------------------------------------------------
// Invalidation events
// ---------------------------------------------------------------------------

function recorder() {
  const events = [];
  return { events, listener: (event) => events.push(event) };
}

test('subscribe returns an idempotent unsubscribe', () => {
  const registry = new AuthorizationRegistry();
  const { events, listener } = recorder();
  const unsubscribe = registry.subscribe(listener);
  assert.equal(typeof unsubscribe, 'function');
  unsubscribe();
  unsubscribe();
  const { connectionId } = registry.issueConnection({});
  const grant = registry.issueGrant(connectionId, { kind: 'task', workspacePath: WORKSPACE, ttlSeconds: 600 });
  registry.revokeGrant({ grantId: grant.grantId, allowOperator: true });
  assert.deepEqual(events, []);
});

test('revoking a grant emits one grant invalidation event', () => {
  const registry = new AuthorizationRegistry();
  const { events, listener } = recorder();
  const unsubscribe = registry.subscribe(listener);
  try {
    const { connectionId } = registry.issueConnection({});
    const grant = registry.issueGrant(connectionId, { kind: 'task', workspacePath: WORKSPACE, ttlSeconds: 600 });
    registry.revokeGrant({ grantId: grant.grantId, allowOperator: true });

    assert.equal(events.length, 1);
    assert.equal(events[0].kind, 'grant');
    assert.equal(events[0].grantId, grant.grantId);
    assert.equal(events[0].connectionId, connectionId);
    assert.equal(events[0].reason, AUTH_EVENT_REASONS.revoked);

    // Revoking again is a no-op, and must not fire a second event.
    registry.revokeGrant({ grantId: grant.grantId, allowOperator: true });
    assert.equal(events.length, 1);
  } finally {
    unsubscribe();
  }
});

test('revoking a connection emits a connection event', () => {
  const registry = new AuthorizationRegistry();
  const { events, listener } = recorder();
  const unsubscribe = registry.subscribe(listener);
  try {
    const { connectionId } = registry.issueConnection({});
    registry.issueGrant(connectionId, { kind: 'session', workspacePath: WORKSPACE, ttlSeconds: 600 });
    registry.revokeConnection(connectionId);

    assert.equal(events.length, 1);
    assert.equal(events[0].kind, 'connection');
    assert.equal(events[0].connectionId, connectionId);
    assert.equal(events[0].reason, AUTH_EVENT_REASONS.revoked);
  } finally {
    unsubscribe();
  }
});

test('revokeAll emits a single all event rather than one per grant', () => {
  const registry = new AuthorizationRegistry();
  const { events, listener } = recorder();
  const unsubscribe = registry.subscribe(listener);
  try {
    const one = registry.issueConnection({});
    const two = registry.issueConnection({});
    registry.issueGrant(one.connectionId, { kind: 'task', workspacePath: WORKSPACE, ttlSeconds: 600 });
    registry.issueGrant(two.connectionId, { kind: 'session', workspacePath: WORKSPACE, ttlSeconds: 600 });
    registry.revokeAll();

    assert.equal(events.length, 1);
    assert.equal(events[0].kind, 'all');
    assert.equal(events[0].reason, AUTH_EVENT_REASONS.revokedAll);
    // No ids are attached to a blanket event.
    assert.equal('grantId' in events[0], false);
    assert.equal('connectionId' in events[0], false);
  } finally {
    unsubscribe();
  }
});

test('an expiring grant emits one expiry event, exactly once', () => {
  const clock = { value: 10_000_000 };
  const registry = registryAt(clock);
  const { events, listener } = recorder();
  const unsubscribe = registry.subscribe(listener);
  try {
    const { connectionId } = registry.issueConnection({});
    const grant = registry.issueGrant(connectionId, { kind: 'session', workspacePath: WORKSPACE, ttlSeconds: 60 });

    clock.value += 60_001;
    registry.sweep();
    registry.sweep();
    registry.sweep();

    const expiries = events.filter((event) => event.reason === AUTH_EVENT_REASONS.expired);
    assert.equal(expiries.length, 1);
    assert.equal(expiries[0].kind, 'grant');
    assert.equal(expiries[0].grantId, grant.grantId);
  } finally {
    unsubscribe();
  }
});

test('a consumed grant that expires while its task runs still emits one expiry', () => {
  const clock = { value: 15_000_000 };
  const registry = registryAt(clock);
  const { events, listener } = recorder();
  const unsubscribe = registry.subscribe(listener);
  try {
    const { connectionId } = registry.issueConnection({});
    const grant = registry.issueGrant(connectionId, { kind: 'task', workspacePath: WORKSPACE, ttlSeconds: 60 });
    registry.consumeTaskGrant({
      connectionId,
      grantId: grant.grantId,
      taskId: 'task-1',
      workspacePath: WORKSPACE,
    });

    // Consumption is not settlement: the task is still running on this grant, so
    // its expiry must be announced or the engine would never cancel it.
    clock.value += 60_001;
    registry.sweep();
    registry.sweep();

    const expiries = events.filter((event) => event.reason === AUTH_EVENT_REASONS.expired);
    assert.equal(expiries.length, 1);
    assert.equal(expiries[0].kind, 'grant');
    assert.equal(expiries[0].grantId, grant.grantId);
    assert.equal(expiries[0].connectionId, connectionId);
  } finally {
    unsubscribe();
  }
});

test('a connection that loses its idle lease is revoked and announced', () => {
  const clock = { value: 20_000_000 };
  const registry = new AuthorizationRegistry({ now: () => clock.value, leaseMs: 1_000 });
  const { events, listener } = recorder();
  const unsubscribe = registry.subscribe(listener);
  try {
    const { connectionId, token } = registry.issueConnection({});
    const grant = registry.issueGrant(connectionId, { kind: 'session', workspacePath: WORKSPACE, ttlSeconds: 6000 });

    // Inside the lease the connection is live and delegations are on.
    clock.value += 900;
    assert.equal(registry.authenticate(token).connectionId, connectionId);
    assert.equal(registry.isDelegationAuthorized(), true);

    // Past the lease the heartbeat is gone; the sweep settles it.
    clock.value += 1_200;
    registry.sweep();

    assert.equal(events.filter((event) => event.kind === 'connection').length, 1);
    const leaseEvent = events.find((event) => event.kind === 'connection');
    assert.equal(leaseEvent.connectionId, connectionId);
    assert.equal(leaseEvent.reason, AUTH_EVENT_REASONS.leaseExpired);

    assert.equal(registry.authenticate(token), null, 'a lapsed token must not authenticate');
    assert.equal(registry.isDelegationAuthorized(), false, 'its grants must be dead with it');
    assert.throws(
      () => registry.requireSessionGrant({ connectionId, workspacePath: WORKSPACE }),
      (error) => error.code === AUTH_CODES.connectionRevoked,
    );
    assert.equal(
      registry.listGrants(connectionId).every((snapshot) => snapshot.revokedAt !== null),
      true,
      'grant snapshots must show the revocation, not merely stop being returned',
    );
    assert.ok(grant.grantId);
  } finally {
    unsubscribe();
  }
});

test('an expired connection is refused without renewing its lease', () => {
  const clock = { value: 30_000_000 };
  const registry = new AuthorizationRegistry({ now: () => clock.value, leaseMs: 1_000 });
  const { connectionId, token } = registry.issueConnection({});

  clock.value += 1_001;
  assert.equal(registry.authenticate(token), null);
  const revokedAt = registry.listConnections()[0].revokedAt;
  assert.notEqual(revokedAt, null);

  // Presenting the same token again must not revive the connection.
  clock.value += 5_000;
  assert.equal(registry.authenticate(token), null);
  assert.equal(registry.listConnections()[0].revokedAt, revokedAt);
  assert.throws(
    () => registry.requireLiveConnection(connectionId),
    (error) => error.code === AUTH_CODES.connectionRevoked,
  );
});

test('requireLiveConnection reports expiry and settles the connection', () => {
  const clock = { value: 40_000_000 };
  const registry = new AuthorizationRegistry({ now: () => clock.value, leaseMs: 1_000 });
  const { events, listener } = recorder();
  const unsubscribe = registry.subscribe(listener);
  try {
    const { connectionId } = registry.issueConnection({});
    clock.value += 1_001;
    assert.throws(
      () => registry.requireLiveConnection(connectionId),
      (error) => error.code === AUTH_CODES.connectionExpired,
    );
    assert.equal(events.length, 1);
    assert.equal(events[0].reason, AUTH_EVENT_REASONS.leaseExpired);

    // Now revoked, so the next refusal is the stable revoked code.
    assert.throws(
      () => registry.requireLiveConnection(connectionId),
      (error) => error.code === AUTH_CODES.connectionRevoked,
    );
    assert.equal(events.length, 1, 'the second refusal must not re-announce');
  } finally {
    unsubscribe();
  }
});

test('the default idle lease is two minutes and list/poll does not renew it', () => {
  assert.equal(DEFAULT_CONNECTION_LEASE_MS, 120_000);
  const clock = { value: 50_000_000 };
  const registry = new AuthorizationRegistry({ now: () => clock.value });
  const { connectionId, token } = registry.issueConnection({});
  registry.issueGrant(connectionId, { kind: 'session', workspacePath: WORKSPACE, ttlSeconds: 600 });

  // Listing and polling are not heartbeats: they must not push lastSeenAt.
  clock.value += 100_000;
  registry.listConnections();
  registry.listGrants(connectionId);
  registry.isDelegationAuthorized();
  assert.equal(registry.listConnections()[0].lastSeenAt, 50_000_000);

  clock.value += 20_001;
  assert.equal(registry.authenticate(token), null, 'the lease lapsed despite the reads');
});

test('only an authenticated request renews the lease', () => {
  const clock = { value: 60_000_000 };
  const registry = new AuthorizationRegistry({ now: () => clock.value, leaseMs: 10_000 });
  const { connectionId, token } = registry.issueConnection({});

  clock.value += 9_000;
  assert.equal(registry.authenticate(token).connectionId, connectionId);
  assert.equal(registry.listConnections()[0].lastSeenAt, 60_009_000);

  clock.value += 9_000;
  assert.equal(registry.authenticate(token).connectionId, connectionId);
  assert.equal(registry.listConnections()[0].live, true);
});

test('a listener that throws does not break authorization bookkeeping', () => {
  const registry = new AuthorizationRegistry();
  const seen = [];
  registry.subscribe(() => { throw new Error('subscriber bug'); });
  registry.subscribe((event) => seen.push(event));
  const { connectionId } = registry.issueConnection({});
  const grant = registry.issueGrant(connectionId, { kind: 'task', workspacePath: WORKSPACE, ttlSeconds: 600 });
  registry.revokeGrant({ grantId: grant.grantId, allowOperator: true });
  assert.equal(seen.length, 1);
  assert.equal(registry.isDelegationAuthorized(), false);
});

test('unsubscribeAll detaches every listener on dispose', () => {
  const registry = new AuthorizationRegistry();
  const { events, listener } = recorder();
  registry.subscribe(listener);
  assert.equal(registry.unsubscribeAll(), 1);
  registry.revokeAll();
  assert.deepEqual(events, []);
});

test('a non-function listener is refused', () => {
  const registry = new AuthorizationRegistry();
  assert.throws(() => registry.subscribe(null), (error) => error.code === 'AUTH_LISTENER_INVALID');
});

// ---------------------------------------------------------------------------
// Bounded state
// ---------------------------------------------------------------------------

test('the sweep bounds both maps by dropping long-settled entries', () => {
  const clock = { value: 70_000_000 };
  const registry = new AuthorizationRegistry({ now: () => clock.value, leaseMs: 1_000 });
  const { connectionId } = registry.issueConnection({});
  registry.issueGrant(connectionId, { kind: 'task', workspacePath: WORKSPACE, ttlSeconds: 30 });

  // Past the lease, the grant TTL and the retention window: this sweep *settles*
  // the lease and the grant. Settlement is stamped with the moment it happened,
  // so nothing can be dropped in the same step — that is the contract, and the
  // reason entries stay visible for one retention window after they die.
  clock.value += 30 * 60 * 1000;
  const settled = registry.sweep();
  assert.deepEqual(settled, { grants: 0, connections: 0 });
  assert.equal(registry.listConnections()[0].revokedAt, clock.value);
  assert.equal(registry.listGrants(connectionId)[0].revokedAt, clock.value);

  // Only now has the retention window elapsed, counted from settlement.
  clock.value += AUTH_RETENTION_MS + 1;
  const swept = registry.sweep();
  assert.equal(swept.grants, 1);
  assert.equal(swept.connections, 1);
  assert.deepEqual(registry.listGrants(connectionId), []);
  assert.deepEqual(registry.listConnections(), []);
  // Bounded means reusable at the cap: the freed slots accept new identities.
  assert.doesNotThrow(() => registry.issueConnection({ label: 'after sweep' }));
});

test('a token or its hash is never listed, before or after revocation', () => {
  const clock = { value: 80_000_000 };
  const registry = new AuthorizationRegistry({ now: () => clock.value, leaseMs: 1_000 });
  const { connectionId, token } = registry.issueConnection({ label: 'codex' });
  registry.issueGrant(connectionId, { kind: 'session', workspacePath: WORKSPACE, ttlSeconds: 600 });

  const snapshots = [
    JSON.stringify(registry.listConnections()),
    JSON.stringify(registry.listGrants(connectionId)),
  ];
  registry.revokeConnection(connectionId);
  snapshots.push(JSON.stringify(registry.listConnections()));
  snapshots.push(JSON.stringify(registry.listGrants(connectionId)));

  for (const serialized of snapshots) {
    assert.equal(serialized.includes(token), false);
    assert.equal(serialized.toLowerCase().includes('tokenhash'), false);
    assert.equal(serialized.includes('Bearer'), false);
  }
});
