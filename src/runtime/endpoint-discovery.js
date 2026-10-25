import { randomUUID } from 'node:crypto';
import { lstat, readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

import { writeFileAtomic } from '../config/store.js';

export const ENDPOINT_DISCOVERY_FILE = 'runtime-endpoint.json';
export const ENDPOINT_DISCOVERY_SCHEMA = 1;
const MAX_DISCOVERY_BYTES = 4096;

export class EndpointDiscoveryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'EndpointDiscoveryError';
    this.code = code;
  }
}

export function resolveEndpointDiscoveryPath(env = process.env, homeDirectory = homedir()) {
  const configuredPath = typeof env.DSH_DELEGATE_DISCOVERY_FILE === 'string'
    ? env.DSH_DELEGATE_DISCOVERY_FILE.trim()
    : '';
  if (configuredPath !== '') {
    if (!isAbsolute(configuredPath)) {
      throw new EndpointDiscoveryError('MCP_CONFIG_INVALID', 'DSH_DELEGATE_DISCOVERY_FILE must be an absolute path');
    }
    return resolve(configuredPath);
  }

  return resolveDefaultEndpointDiscoveryPath(env, homeDirectory);
}

export function resolveDefaultEndpointDiscoveryPath(env = process.env, homeDirectory = homedir()) {
  const configuredHome = typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : '';
  const dshHome = configuredHome === '' ? join(homeDirectory, '.dsh') : configuredHome;
  return join(resolve(dshHome), 'data', 'dsh-delegate', ENDPOINT_DISCOVERY_FILE);
}

export async function publishRuntimeEndpoint({ filePath, host, port, processId = process.pid, now = new Date() }) {
  if (host !== '127.0.0.1') {
    throw new EndpointDiscoveryError('MCP_ENDPOINT_BIND_UNSUPPORTED', 'the DSH endpoint must bind to 127.0.0.1');
  }
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new EndpointDiscoveryError('MCP_ENDPOINT_INVALID', 'the DSH endpoint port is invalid');
  }
  if (!Number.isSafeInteger(processId) || processId < 1) {
    throw new EndpointDiscoveryError('MCP_ENDPOINT_INVALID', 'the DSH process id is invalid');
  }

  const record = {
    schemaVersion: ENDPOINT_DISCOVERY_SCHEMA,
    host,
    port,
    processId,
    instanceId: randomUUID(),
    updatedAt: now.toISOString(),
  };
  await writeFileAtomic(filePath, `${JSON.stringify(record)}\n`);

  return {
    filePath,
    instanceId: record.instanceId,
    async dispose() {
      try {
        const current = await readDiscoveryRecord(filePath);
        if (current.instanceId === record.instanceId) await rm(filePath, { force: true });
      } catch { /* An unreadable or replaced record is not this instance's file to remove. */ }
    },
  };
}

export async function readRuntimeEndpoint(filePath) {
  const record = await readDiscoveryRecord(filePath);
  return Object.freeze({
    baseUrl: `http://${record.host}:${record.port}`,
    host: record.host,
    port: record.port,
    processId: record.processId,
    instanceId: record.instanceId,
    updatedAt: record.updatedAt,
  });
}

async function readDiscoveryRecord(filePath) {
  let metadata;
  try {
    metadata = await lstat(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new EndpointDiscoveryError(
        'MCP_ENDPOINT_NOT_FOUND',
        'no DSH endpoint is published; start DSH with dsh-delegate 0.1.8 or set DSH_DELEGATE_BASE_URL',
      );
    }
    throw new EndpointDiscoveryError('MCP_ENDPOINT_READ_FAILED', 'the DSH endpoint discovery file could not be read');
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_DISCOVERY_BYTES) {
    throw new EndpointDiscoveryError('MCP_ENDPOINT_INVALID', 'the DSH endpoint discovery file is not a bounded regular file');
  }

  let record;
  try {
    record = JSON.parse(await readFile(filePath, 'utf8'));
  } catch {
    throw new EndpointDiscoveryError('MCP_ENDPOINT_INVALID', 'the DSH endpoint discovery file is malformed');
  }
  if (record === null || typeof record !== 'object' || Array.isArray(record)
    || record.schemaVersion !== ENDPOINT_DISCOVERY_SCHEMA
    || record.host !== '127.0.0.1'
    || !Number.isInteger(record.port) || record.port < 1 || record.port > 65_535
    || !Number.isSafeInteger(record.processId) || record.processId < 1
    || typeof record.instanceId !== 'string' || record.instanceId.length < 16 || record.instanceId.length > 100
    || typeof record.updatedAt !== 'string' || !Number.isFinite(Date.parse(record.updatedAt))) {
    throw new EndpointDiscoveryError('MCP_ENDPOINT_INVALID', 'the DSH endpoint discovery record is invalid');
  }
  return record;
}
