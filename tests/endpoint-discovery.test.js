import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  publishRuntimeEndpoint,
  readRuntimeEndpoint,
  resolveDefaultEndpointDiscoveryPath,
  resolveEndpointDiscoveryPath,
} from '../src/runtime/endpoint-discovery.js';

test('the DSH plugin publishes a bounded loopback endpoint record and removes its own record', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-endpoint-publish-'));
  const filePath = join(directory, 'runtime-endpoint.json');
  try {
    const lease = await publishRuntimeEndpoint({
      filePath,
      host: '127.0.0.1',
      port: 14655,
      processId: 1234,
      now: new Date('2026-10-24T00:00:00.000Z'),
    });
    const endpoint = await readRuntimeEndpoint(filePath);
    const record = JSON.parse(await readFile(filePath, 'utf8'));

    assert.equal(endpoint.baseUrl, 'http://127.0.0.1:14655');
    assert.equal(endpoint.processId, 1234);
    assert.equal(typeof endpoint.instanceId, 'string');
    assert.equal(record.schemaVersion, 1);
    assert.equal(record.updatedAt, '2026-10-24T00:00:00.000Z');
    await lease.dispose();
    await assert.rejects(() => readRuntimeEndpoint(filePath), (error) => error.code === 'MCP_ENDPOINT_NOT_FOUND');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('an old DSH instance cannot remove an endpoint published by a newer instance', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-endpoint-replace-'));
  const filePath = join(directory, 'runtime-endpoint.json');
  try {
    const oldLease = await publishRuntimeEndpoint({ filePath, host: '127.0.0.1', port: 49111 });
    const newLease = await publishRuntimeEndpoint({ filePath, host: '127.0.0.1', port: 49112 });
    await oldLease.dispose();
    assert.equal((await readRuntimeEndpoint(filePath)).port, 49112);
    await newLease.dispose();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('the discovery record refuses non-loopback addresses and invalid ports', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-endpoint-invalid-'));
  const filePath = join(directory, 'runtime-endpoint.json');
  try {
    await assert.rejects(
      () => publishRuntimeEndpoint({ filePath, host: '0.0.0.0', port: 3210 }),
      (error) => error.code === 'MCP_ENDPOINT_BIND_UNSUPPORTED',
    );
    await assert.rejects(
      () => publishRuntimeEndpoint({ filePath, host: '127.0.0.1', port: 0 }),
      (error) => error.code === 'MCP_ENDPOINT_INVALID',
    );
    await assert.rejects(() => readRuntimeEndpoint(filePath), (error) => error.code === 'MCP_ENDPOINT_NOT_FOUND');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('the MCP client refuses a discovery record that names a non-loopback host', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-endpoint-host-'));
  const filePath = join(directory, 'runtime-endpoint.json');
  try {
    await writeFile(filePath, JSON.stringify({
      schemaVersion: 1,
      host: '192.0.2.10',
      port: 3210,
      processId: 1234,
      instanceId: 'instance-id-with-enough-length',
      updatedAt: new Date().toISOString(),
    }));
    await assert.rejects(
      () => readRuntimeEndpoint(filePath),
      (error) => error.code === 'MCP_ENDPOINT_INVALID',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('the discovery path follows DSH_HOME and requires explicit overrides to be absolute', () => {
  assert.equal(
    resolveEndpointDiscoveryPath({ DSH_HOME: 'C:\\dsh-home' }),
    'C:\\dsh-home\\data\\dsh-delegate\\runtime-endpoint.json',
  );
  assert.throws(
    () => resolveEndpointDiscoveryPath({ DSH_DELEGATE_DISCOVERY_FILE: 'relative.json' }),
    (error) => error.code === 'MCP_CONFIG_INVALID',
  );
  assert.equal(
    resolveDefaultEndpointDiscoveryPath({ DSH_DELEGATE_DISCOVERY_FILE: 'ignored.json', DSH_HOME: 'C:\\dsh-home' }),
    'C:\\dsh-home\\data\\dsh-delegate\\runtime-endpoint.json',
  );
});
