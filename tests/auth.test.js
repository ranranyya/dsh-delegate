// Authorization tests: default-off, single-use consumption, revocation,
// expiry, and restart behaviour.
//
// These are the tests that decide whether the plugin is safe to install. Each
// one asserts a refusal that must not depend on any caller-supplied claim.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AUTH_CODES,
  AuthError,
  AuthorizationRegistry,
  normalizeWorkspace,
} from '../src/auth/grants.js';

const WORKSPACE = process.platform === 'win32' ? 'C:\\work\\project' : '/work/project';

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
  const normalized = normalizeWorkspace(`${WORKSPACE}${process.platform === 'win32' ? '\\' : '/'}`);
  assert.equal(normalized.endsWith(process.platform === 'win32' ? '\\' : '/'), false);
});
