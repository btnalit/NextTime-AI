import { randomUUID } from 'node:crypto';
import type { CapabilityScope, HandleClaims } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import type { PoolLike } from '../../adapters/db/pool.js';
import { ENTRY_CEILING_CAPABILITIES } from '../../governance/capability/index.js';
import { MCP_TOOL_ALIASES } from './reference-tool-aliases.js';
import { buildToolCatalog } from './tool-projection.js';

/**
 * interfaces/mcp/tool-projection.test: pure unit tests (no DB) — `buildToolCatalog`'s pool
 * argument is only ever touched when the Handle's scope actually admits gate access (`<gate>.<op>`
 * or `request_action`); every case below omits both, so a pool whose `connect()` throws proves the
 * "no gate capabilities in scope → zero DB round trips" claim this module's own doc comment makes.
 */

const neverConnectPool: PoolLike = {
  connect(): Promise<PoolClient> {
    throw new Error('buildToolCatalog should not touch the database for this scope');
  },
};

function claimsWithScope(scope: CapabilityScope): HandleClaims {
  return {
    ws: randomUUID(),
    sid: randomUUID(),
    obo: randomUUID(),
    scope,
    jti: randomUUID(),
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
  };
}

describe('buildToolCatalog — native projection', () => {
  it('projects exactly the handle-channel capability names in scope, excluding the two gate placeholder patterns', async () => {
    const claims = claimsWithScope({
      capabilities: ['get_object', 'traverse', '<gate>.<op>', '<gate>.<op>:execute'],
      resources: {},
    });
    const catalog = await buildToolCatalog({ pool: neverConnectPool }, claims);
    const names = catalog.tools.map((t) => t.name).sort();
    // <gate>.<op>/<gate>.<op>:execute never appear as literal tool names — and no
    // list_allowed_operations call was made (neverConnectPool would have thrown), so no gate tools
    // are projected either; only the 2 concrete capabilities remain (neither aliases to anything).
    expect(names).toEqual(['get_object', 'traverse']);
  });

  it('an unknown/human-only capability name in scope (should never happen — assertValidScope guards issuance) projects nothing extra', async () => {
    const claims = claimsWithScope({
      capabilities: ['get_object', 'grant_capability'],
      resources: {},
    });
    const catalog = await buildToolCatalog({ pool: neverConnectPool }, claims);
    expect(catalog.tools.map((t) => t.name)).toEqual(['get_object']);
  });

  it('every native tool’s inputSchema is a JSON Schema object matching its capability’s paramsSchema shape', async () => {
    const claims = claimsWithScope({ capabilities: ['traverse'], resources: {} });
    const catalog = await buildToolCatalog({ pool: neverConnectPool }, claims);
    const traverseTool = catalog.tools.find((t) => t.name === 'traverse');
    expect(traverseTool?.inputSchema.type).toBe('object');
    expect(Object.keys(traverseTool?.inputSchema.properties ?? {}).sort()).toEqual(
      ['depth', 'fromId', 'linkType'].sort(),
    );
  });

  it('resolve() passes native tool args straight through, unmodified', async () => {
    const claims = claimsWithScope({ capabilities: ['traverse'], resources: {} });
    const catalog = await buildToolCatalog({ pool: neverConnectPool }, claims);
    expect(catalog.resolve('traverse', { fromId: 'obj-1', depth: 2 })).toEqual({
      capability: 'traverse',
      params: { fromId: 'obj-1', depth: 2 },
    });
  });

  it('resolve() returns undefined for a tool name outside the catalog (not in scope, or unknown)', async () => {
    const claims = claimsWithScope({ capabilities: ['get_object'], resources: {} });
    const catalog = await buildToolCatalog({ pool: neverConnectPool }, claims);
    expect(catalog.resolve('traverse', {})).toBeUndefined();
    expect(catalog.resolve('no_such_tool', {})).toBeUndefined();
  });

  it('the full entry-agent ceiling (an issue_handle-derived interactive Handle’s scope, sans gate access) projects one native tool per ceiling capability plus any applicable Semantica aliases', async () => {
    const ceilingWithoutGates = ENTRY_CEILING_CAPABILITIES.filter(
      (name) => name !== '<gate>.<op>' && name !== 'list_allowed_operations',
    );
    const claims = claimsWithScope({ capabilities: ceilingWithoutGates, resources: {} });
    const catalog = await buildToolCatalog({ pool: neverConnectPool }, claims);

    const ceilingSet = new Set(ceilingWithoutGates);
    const applicableAliasCount = MCP_TOOL_ALIASES.filter(
      (alias) => ceilingSet.has(alias.capability) && !ceilingSet.has(alias.aliasName),
    ).length;
    expect(catalog.tools).toHaveLength(ceilingWithoutGates.length + applicableAliasCount);
    // Every ceiling capability itself is still present as its own native tool.
    for (const name of ceilingWithoutGates) {
      expect(catalog.tools.some((t) => t.name === name)).toBe(true);
    }
  });
});

describe('buildToolCatalog — Semantica aliases', () => {
  it('adds an alias tool only when its target capability is in scope', async () => {
    const withoutExplain = claimsWithScope({ capabilities: ['traverse'], resources: {} });
    const withExplain = claimsWithScope({ capabilities: ['traverse', 'explain'], resources: {} });

    const catalogWithout = await buildToolCatalog({ pool: neverConnectPool }, withoutExplain);
    const catalogWith = await buildToolCatalog({ pool: neverConnectPool }, withExplain);

    expect(catalogWithout.tools.map((t) => t.name)).not.toContain('get_provenance');
    expect(catalogWith.tools.map((t) => t.name)).toContain('get_provenance');
  });

  it('resolve() on an alias name translates Semantica-style args to the target capability’s own params', async () => {
    const claims = claimsWithScope({ capabilities: ['explain', 'causal_chain'], resources: {} });
    const catalog = await buildToolCatalog({ pool: neverConnectPool }, claims);

    expect(catalog.resolve('get_provenance', { entity_id: 'obj-1' })).toEqual({
      capability: 'explain',
      params: { nodeId: 'obj-1' },
    });
    expect(catalog.resolve('get_causal_chain', { decision_id: 'dec-1' })).toEqual({
      capability: 'causal_chain',
      params: { decisionId: 'dec-1' },
    });
  });

  it('never adds a duplicate/colliding alias tool for record_decision/query_decisions/find_precedents — the native capability of the same name wins', async () => {
    const claims = claimsWithScope({
      capabilities: ['record_decision', 'query_decisions', 'find_precedents'],
      resources: {},
    });
    const catalog = await buildToolCatalog({ pool: neverConnectPool }, claims);
    const names = catalog.tools.map((t) => t.name).sort();
    expect(names).toEqual(['find_precedents', 'query_decisions', 'record_decision']);
    // The single `find_precedents` tool resolves to the native capability's own params (`need`),
    // never a translated `scenario` — no alias tool was added for it.
    expect(catalog.resolve('find_precedents', { need: 'x' })).toEqual({
      capability: 'find_precedents',
      params: { need: 'x' },
    });
  });
});

describe('buildToolCatalog — registry-driven, so newly-wired capabilities need no changes here', () => {
  it('the S3.2 epistemic handlers newly wired on the handle channel (list_conflicts/query_decisions/causal_chain/decision_impact/find_precedents) appear in tools/list whenever they are in scope — proven purely by being registered handle-channel capabilities, no hardcoded tool list to update', async () => {
    const handleChannelEpistemicCapabilities = [
      'list_conflicts',
      'query_decisions',
      'causal_chain',
      'decision_impact',
      'find_precedents',
    ];
    const claims = claimsWithScope({
      capabilities: handleChannelEpistemicCapabilities,
      resources: {},
    });
    const catalog = await buildToolCatalog({ pool: neverConnectPool }, claims);
    const names = catalog.tools.map((t) => t.name);
    for (const capabilityName of handleChannelEpistemicCapabilities) {
      expect(names).toContain(capabilityName);
    }
  });

  it('the S3.2 epistemic handlers that landed on the human channel (resolve_conflict/verify_fact — a governance-sensitive write, per capabilities.ts’s own current registry entries) never appear as MCP tools, even hypothetically "in scope" — MCP tools/list is Handle-channel-only by construction (listByChannel(\'handle\') in tool-projection.ts)', async () => {
    const claims = claimsWithScope({
      capabilities: ['resolve_conflict', 'verify_fact'],
      resources: {},
    });
    const catalog = await buildToolCatalog({ pool: neverConnectPool }, claims);
    expect(catalog.tools.map((t) => t.name)).toEqual([]);
  });
});

describe('buildToolCatalog — gate projection triggers', () => {
  it('does not touch the database when neither gate pattern is in scope', async () => {
    const claims = claimsWithScope({
      capabilities: ['get_object', 'list_allowed_operations'],
      resources: {},
    });
    // list_allowed_operations alone (without <gate>.<op> or request_action) never triggers the
    // gate-projection branch — proven by neverConnectPool not throwing.
    await expect(buildToolCatalog({ pool: neverConnectPool }, claims)).resolves.toBeDefined();
  });
});
