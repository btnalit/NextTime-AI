import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { HandleClaims } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import type { PoolLike } from '../../adapters/db/pool.js';
import { buildMcpServer, mapCapabilityErrorToToolResult } from './server-factory.js';
import { buildToolCatalog } from './tool-projection.js';

/**
 * interfaces/mcp/server-factory.test: exercises the real MCP `Server` this module builds against
 * the SDK's own `InMemoryTransport` + `Client` — the actual JSON-RPC request/response framing,
 * schema validation, and `tools/list`/`tools/call` wiring, entirely in-process. No Fastify, no
 * HTTP, no database (this module's own doc comment: "which matters on a host with no local
 * Postgres"). The two `dispatchCapability` outcomes reachable without a DB — an unknown tool name,
 * and a real capability rejected by its own params validation (`InvalidCapabilityParamsError`,
 * thrown by `dispatchCapability` *before* it ever opens a transaction — see dispatch.ts's own
 * ordering) — are both exercised for real, over the wire; the DB-gated `index.test.ts` covers a
 * genuinely successful capability dispatch end-to-end once Postgres is available.
 */

const neverConnectPool: PoolLike = {
  connect(): Promise<PoolClient> {
    throw new Error('should not touch the database for this scope');
  },
};

function fakeClaims(capabilities: readonly string[]): HandleClaims {
  return {
    ws: randomUUID(),
    sid: randomUUID(),
    obo: randomUUID(),
    scope: { capabilities: [...capabilities], resources: {} },
    jti: randomUUID(),
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
  };
}

async function connectedClient(claims: HandleClaims): Promise<{
  client: Client;
  close: () => Promise<void>;
}> {
  const catalog = await buildToolCatalog({ pool: neverConnectPool }, claims);
  const server = buildMcpServer(neverConnectPool, claims, catalog);
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'nexttime-mcp-server-factory-test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

describe('buildMcpServer — tools/list over a real MCP transport', () => {
  it('returns exactly the catalog’s tools, with JSON-Schema inputSchemas', async () => {
    const { client, close } = await connectedClient(fakeClaims(['get_object', 'traverse']));
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual(['get_object', 'traverse']);
      const getObjectTool = tools.find((t) => t.name === 'get_object');
      expect(getObjectTool?.inputSchema.type).toBe('object');
      expect(Object.keys(getObjectTool?.inputSchema.properties ?? {})).toContain('objectId');
    } finally {
      await close();
    }
  });

  it('an empty scope lists zero tools', async () => {
    const { client, close } = await connectedClient(fakeClaims([]));
    try {
      const { tools } = await client.listTools();
      expect(tools).toEqual([]);
    } finally {
      await close();
    }
  });
});

describe('buildMcpServer — tools/call over a real MCP transport', () => {
  it('an unknown tool name → isError result, not a thrown protocol error', async () => {
    const { client, close } = await connectedClient(fakeClaims(['get_object']));
    try {
      const result = await client.callTool({ name: 'no_such_tool', arguments: {} });
      expect(result.isError).toBe(true);
      expect((result.content as Array<{ text?: string }>)[0]?.text).toContain('unknown tool');
    } finally {
      await close();
    }
  });

  it('a real capability rejected by its own params validation → isError, invalid_params prefix (never touches the DB — dispatchCapability validates before opening a transaction)', async () => {
    const { client, close } = await connectedClient(fakeClaims(['get_object']));
    try {
      // get_object requires `objectId` — omitting it fails InvalidCapabilityParamsError before
      // dispatchCapability ever calls withWorkspace(pool, ...), so neverConnectPool never throws.
      const result = await client.callTool({ name: 'get_object', arguments: {} });
      expect(result.isError).toBe(true);
      const text = (result.content as Array<{ text?: string }>)[0]?.text ?? '';
      expect(text.startsWith('invalid_params:')).toBe(true);
    } finally {
      await close();
    }
  });
});

describe('mapCapabilityErrorToToolResult', () => {
  it('falls through to a plain .message for an unmapped error class', () => {
    const result = mapCapabilityErrorToToolResult(new Error('some domain-specific failure'));
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: 'text', text: 'some domain-specific failure' }]);
  });

  it('stringifies a non-Error throw rather than crashing', () => {
    const result = mapCapabilityErrorToToolResult('a plain string throw');
    expect(result.content).toEqual([{ type: 'text', text: 'a plain string throw' }]);
  });
});
