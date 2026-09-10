import { randomUUID } from 'node:crypto';
import type { AgentHostToKernelFrame, KernelToAgentHostFrame, Role } from '@nexttime/shared';
import type { CryptoKey } from 'jose';
import type { PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import type { PoolLike } from '../../adapters/db/pool.js';
import { generateEphemeralHandleKeyPair } from '../../governance/capability/keys.js';
import { type AgentHostLink, AgentHostRuntime } from './agent-host-runtime.js';
import type { AgentRuntimeEvent, AgentRuntimeEventSink, StartTurnInput } from './agent-runtime.js';

/**
 * agent-host-runtime.test: unit tests, no Postgres involved — a small fake `PoolLike` stands in
 * for `sessions`/`capability_handles`, matched against the exact SQL this class and
 * `governance/capability/handles.ts`'s `issueHandle` issue (same technique as
 * governance/capability/handles.test.ts's own `createFakeCapabilityClient` and
 * adapters/db/pool.test.ts's `createFakePool`, combined: this class drives real `withWorkspace`
 * transactions, which need BEGIN/set_config/set local role/COMMIT handled too).
 */

interface FakeSessionRow {
  id: string;
  workspaceId: string;
  principalId: string;
  onBehalfOf: string;
}

/** S2.6: an entry definition row `resolveEntryDefinition`'s `getPublishedEntryDefinition` query
 *  should find for a given `workspaceId`, keyed by `createFakePool`'s optional
 *  `publishedEntryDefinitions` seed map. */
interface FakeEntryDefinitionRow {
  readonly systemPrompt?: string;
  readonly model?: string;
  /** feat/egress-definition-lists */
  readonly egressDeny?: readonly string[];
}

/** S3.13: `governance/agent-profile/store.ts`'s `readAgentProfile` row, keyed by `principalId`
 *  (tests here only ever use one workspace at a time). `undefined`/absent fields default to the
 *  "inherit" `null` sentinel, matching a real row with those columns unset. */
interface FakeAgentProfileRow {
  readonly model?: string | null;
  readonly enabledSkills?: readonly string[] | null;
  readonly enabledGatekeepers?: readonly string[] | null;
  readonly enabledWorkerDefinitions?: readonly string[] | null;
  readonly promptAddendum?: string | null;
  readonly autoApproveLow?: boolean | null;
  readonly updatedAt?: Date;
}

/** S3.13: `governance/agent-profile/store.ts`'s `readAgentPolicy` row for the one workspace a
 *  test uses. `undefined` (the default) means "no row" — `readAgentPolicy`'s own compiled-in
 *  defaults apply, same as production. */
interface FakeAgentPolicyRow {
  readonly allowedModels?: readonly string[];
  readonly defaultModel?: string | null;
  readonly memberCanEditProfile?: boolean;
  readonly maxPromptAddendumChars?: number;
  readonly allowedSkills?: readonly string[];
  readonly allowedGatekeepers?: readonly string[];
  readonly allowMemberAutoApproveLow?: boolean;
  readonly updatedAt?: Date;
}

/** S3.13: one published Skill `application/worker/skills.ts`'s `resolvePublishedSkills` should
 *  resolve — matched by `id` or `name`, mirroring that function's own id-or-name lookup. */
interface FakePublishedSkill {
  readonly id: string;
  readonly name: string;
}

function createFakePool(
  publishedEntryDefinitions: ReadonlyMap<string, FakeEntryDefinitionRow> = new Map(),
  /** S2.13: `governance/capability/grants.ts`'s `listActiveGrantResourceScopes`, called by
   *  `ensureEntryHandle` — keyed by `principalId`, the gatekeeperIds an active `connect_gatekeeper`
   *  Grant would surface. Empty by default (every pre-S2.13 test keeps its exact prior behavior). */
  grantedGatekeeperIdsByPrincipal: ReadonlyMap<string, readonly string[]> = new Map(),
  /** S3.13: `agent_profiles` seed, keyed by `principalId`. Empty by default — every pre-S3.13 test
   *  keeps its exact prior behavior (a missing row resolves through `readAgentProfile` to
   *  `undefined`, then through `resolveEffectiveAgentProfile` to "no override" on every field). */
  agentProfilesByPrincipal: ReadonlyMap<string, FakeAgentProfileRow> = new Map(),
  /** S3.13: the one workspace's `agent_policies` row — `undefined` (default) means "no row",
   *  `readAgentPolicy`'s own compiled-in defaults apply. */
  agentPolicy: FakeAgentPolicyRow | undefined = undefined,
  /** S3.13: published Skills `application/worker/skills.ts`'s `resolvePublishedSkills` should
   *  resolve — empty by default. */
  publishedSkills: readonly FakePublishedSkill[] = [],
  /** W5.5 (STATUS leftover 18): `principals.role` per principalId, read by `ensureEntryHandle`'s
   *  `resolvePrincipalRole` to narrow the entry ceiling. Defaults to `owner` for every principal
   *  not listed, so every pre-W5.5 test keeps the full ceiling exactly as before. */
  rolesByPrincipal: ReadonlyMap<string, Role> = new Map(),
  /** W5.5: jtis `readHandleFreshness` should report as revoked (empty by default). */
  revokedJtis: ReadonlySet<string> = new Set(),
) {
  const sessionsByPrincipal = new Map<string, FakeSessionRow>();
  const handleCount = new Map<string, number>();

  const query = vi.fn(async (text: string, params: unknown[] = []) => {
    const sql = text.trim();

    if (sql.startsWith('BEGIN') || sql.startsWith('COMMIT') || sql.startsWith('ROLLBACK')) {
      return { rows: [], rowCount: 0 };
    }
    if (sql.startsWith('select set_config') || sql.startsWith('set local role')) {
      return { rows: [], rowCount: 0 };
    }

    // application/worker/definitions.ts's getPublishedEntryDefinition.
    if (sql.startsWith('select workspace_id, id, version, kind, status, definition')) {
      const [workspaceId] = params as [string];
      const seed = publishedEntryDefinitions.get(workspaceId);
      if (!seed) return { rows: [], rowCount: 0 };
      return {
        rows: [
          {
            workspace_id: workspaceId,
            id: randomUUID(),
            version: 1,
            kind: 'entry',
            status: 'published',
            definition: {
              systemPrompt: seed.systemPrompt,
              model: seed.model,
              egressDeny: seed.egressDeny,
            },
            proposed_by: randomUUID(),
            published_by: randomUUID(),
            created_at: new Date(),
            published_at: new Date(),
          },
        ],
        rowCount: 1,
      };
    }

    if (sql.startsWith('select id from sessions')) {
      const [, principalId] = params as [string, string];
      const row = sessionsByPrincipal.get(principalId);
      return { rows: row ? [{ id: row.id }] : [], rowCount: row ? 1 : 0 };
    }

    if (sql.startsWith('insert into sessions')) {
      const [workspaceId, principalId] = params as [string, string];
      const row: FakeSessionRow = {
        id: randomUUID(),
        workspaceId,
        principalId,
        onBehalfOf: principalId,
      };
      sessionsByPrincipal.set(principalId, row);
      return { rows: [{ id: row.id }], rowCount: 1 };
    }

    if (sql.startsWith('select (revoked_at is null) as live from capability_handles')) {
      // W5.5: `readHandleFreshness`'s revocation probe — this fake never revokes, so a cached jti
      // is always live (tests that need a revocation can override via `revokedJtis`).
      const [, jti] = params as [string, string];
      return { rows: [{ live: !revokedJtis.has(jti) }], rowCount: 1 };
    }

    if (sql.startsWith('select role from principals')) {
      const [, principalId] = params as [string, string];
      return { rows: [{ role: rolesByPrincipal.get(principalId) ?? 'owner' }], rowCount: 1 };
    }

    if (sql.startsWith('select workspace_id, on_behalf_of from sessions')) {
      const [sessionId] = params as [string];
      const row = [...sessionsByPrincipal.values()].find((s) => s.id === sessionId);
      return {
        rows: row ? [{ workspace_id: row.workspaceId, on_behalf_of: row.onBehalfOf }] : [],
        rowCount: row ? 1 : 0,
      };
    }

    // S2.13: governance/capability/grants.ts's listActiveGrantResourceScopes, called by
    // ensureEntryHandle below. docs/wire-contract-conventions.md §1/§2 (2026-09-08 decision):
    // `capability_grants.capability`/`scope->>'resourceScope'` renamed to the first-class
    // `resource_type`/`resource_id` columns (migrations/governance/
    // 0009_capability_grants_resource_type.sql) — this fake's SQL-prefix match and returned column
    // name follow the rename.
    if (sql.startsWith('select distinct resource_id')) {
      const [, principalId] = params as [string, string];
      const ids = grantedGatekeeperIdsByPrincipal.get(principalId) ?? [];
      return { rows: ids.map((id) => ({ resource_id: id })), rowCount: ids.length };
    }

    // S3.13: governance/agent-profile/store.ts's readAgentProfile.
    if (sql.startsWith('select workspace_id, principal_id, model, enabled_skills')) {
      const [workspaceId, principalId] = params as [string, string];
      const seed = agentProfilesByPrincipal.get(principalId);
      if (!seed) return { rows: [], rowCount: 0 };
      return {
        rows: [
          {
            workspace_id: workspaceId,
            principal_id: principalId,
            model: seed.model ?? null,
            enabled_skills: seed.enabledSkills ?? null,
            enabled_gatekeepers: seed.enabledGatekeepers ?? null,
            enabled_worker_definitions: seed.enabledWorkerDefinitions ?? null,
            prompt_addendum: seed.promptAddendum ?? null,
            auto_approve_low: seed.autoApproveLow ?? null,
            updated_by: null,
            updated_at: seed.updatedAt ?? new Date('2026-01-01T00:00:00Z'),
          },
        ],
        rowCount: 1,
      };
    }

    // S3.13: governance/agent-profile/store.ts's readAgentPolicy.
    if (sql.startsWith('select workspace_id, allowed_models')) {
      const [workspaceId] = params as [string];
      if (!agentPolicy) return { rows: [], rowCount: 0 };
      return {
        rows: [
          {
            workspace_id: workspaceId,
            allowed_models: agentPolicy.allowedModels ?? [],
            default_model: agentPolicy.defaultModel ?? null,
            member_can_edit_profile: agentPolicy.memberCanEditProfile ?? true,
            max_prompt_addendum_chars: agentPolicy.maxPromptAddendumChars ?? 2000,
            allowed_skills: agentPolicy.allowedSkills ?? [],
            allowed_gatekeepers: agentPolicy.allowedGatekeepers ?? [],
            allow_member_auto_approve_low: agentPolicy.allowMemberAutoApproveLow ?? false,
            updated_by: null,
            updated_at: agentPolicy.updatedAt ?? new Date('2026-01-01T00:00:00Z'),
          },
        ],
        rowCount: 1,
      };
    }

    // S3.13: application/worker/skills.ts's resolvePublishedSkills, called by
    // resolveSkillsInline below.
    if (sql.startsWith('select distinct on (id)')) {
      const [workspaceId, refs] = params as [string, string[]];
      const matched = publishedSkills.filter(
        (skill) => refs.includes(skill.id) || refs.includes(skill.name),
      );
      return {
        rows: matched.map((skill) => ({
          workspace_id: workspaceId,
          id: skill.id,
          version: 1,
          status: 'published',
          name: skill.name,
          description: `${skill.name} description`,
          markdown: `# ${skill.name}\n\nbody`,
          applicable: {},
          proposed_by: randomUUID(),
          published_by: randomUUID(),
          created_at: new Date('2026-01-01T00:00:00Z'),
          published_at: new Date('2026-01-01T00:00:00Z'),
        })),
        rowCount: matched.length,
      };
    }

    // S3.13: application/worker/skills.ts's listPublishedSkillIds, called by resolveAgentProfile
    // below (the "everything available" ceiling `enabledSkills === null` resolves to).
    if (sql.startsWith('select id from skills')) {
      return {
        rows: publishedSkills.map((skill) => ({ id: skill.id })),
        rowCount: publishedSkills.length,
      };
    }

    if (sql.startsWith('insert into capability_handles')) {
      // (workspace_id, jti, session_id, on_behalf_of, parent_jti, scope, expires_at) —
      // governance/capability/handles.ts's issueHandle; on_behalf_of is index 3, not jti (index 1).
      const onBehalfOf = params[3] as string;
      handleCount.set(onBehalfOf, (handleCount.get(onBehalfOf) ?? 0) + 1);
      return { rows: [], rowCount: 1 };
    }

    throw new Error(`fake pool: unhandled query: ${sql}`);
  });

  const client = { query, release: vi.fn() } as unknown as PoolClient;
  const pool: PoolLike = { connect: vi.fn(async () => client) };

  return { pool, handleCount, sessionCount: () => sessionsByPrincipal.size };
}

function createFakeSink() {
  const events: AgentRuntimeEvent[] = [];
  const sink: AgentRuntimeEventSink = {
    handle(event) {
      events.push(event);
    },
  };
  return { sink, events };
}

function createFakeLink() {
  const sent: KernelToAgentHostFrame[] = [];
  let throwOnSend = false;
  const link: AgentHostLink = {
    send(frame) {
      if (throwOnSend) throw new Error('socket is not open');
      sent.push(frame);
    },
  };
  return {
    link,
    sent,
    setThrowOnSend: (value: boolean) => {
      throwOnSend = value;
    },
  };
}

function startTurnInput(overrides: Partial<StartTurnInput> = {}): StartTurnInput {
  return {
    workspaceId: randomUUID(),
    chatId: randomUUID(),
    turnId: randomUUID(),
    principalId: randomUUID(),
    prompt: '<!--nexttime:turn_id=x-->\nhello',
    ...overrides,
  };
}

async function ephemeralPrivateKey(): Promise<CryptoKey> {
  const { privateKey } = await generateEphemeralHandleKeyPair();
  return privateKey;
}

describe('AgentHostRuntime — startTurn with no agent-host connected', () => {
  it('emits turnEnded {status: failed} without touching the database', async () => {
    const { pool } = createFakePool();
    const { sink, events } = createFakeSink();
    const privateKey = await ephemeralPrivateKey();
    const runtime = new AgentHostRuntime({
      pool,
      sink,
      privateKey,
      kernelLlmUrl: 'http://llm-proxy:8082',
      log: () => {},
    });

    const input = startTurnInput();
    await runtime.startTurn(input);

    expect(pool.connect).not.toHaveBeenCalled();
    expect(events).toEqual([
      {
        type: 'turnEnded',
        status: 'failed',
        workspaceId: input.workspaceId,
        chatId: input.chatId,
        turnId: input.turnId,
        principalId: input.principalId,
      },
    ]);
  });
});

describe('AgentHostRuntime — startTurn happy path', () => {
  it('issues an entry Handle, sends startTurn, and resolves once the frame is sent (does not wait for turnAccepted)', async () => {
    const { pool, handleCount, sessionCount } = createFakePool();
    const { sink, events } = createFakeSink();
    const privateKey = await ephemeralPrivateKey();
    const runtime = new AgentHostRuntime({
      pool,
      sink,
      privateKey,
      kernelLlmUrl: 'http://llm-proxy:8082',
      log: () => {},
    });
    const { link, sent } = createFakeLink();
    runtime.connect(link);

    const input = startTurnInput();
    const startPromise = runtime.startTurn(input);

    // lane-4 P2 fix: startTurn's returned promise resolves once the command frame is sent — it
    // does not wait for turnAccepted/turnRejected/timeout (that outcome is handled
    // asynchronously; see the dedicated describe block below). Send the acceptance anyway, to
    // prove it produces no event while still pending.
    await Promise.resolve(); // let the async handle-issuance microtasks run before asserting `sent`
    await vi.waitFor(() => expect(sent).toHaveLength(1));

    const command = sent[0] as Extract<KernelToAgentHostFrame, { type: 'startTurn' }>;
    expect(command.type).toBe('startTurn');
    expect(command.turnId).toBe(input.turnId);
    expect(command.principalId).toBe(input.principalId);
    expect(command.prompt).toBe(input.prompt);
    expect(command.kernelLlmUrl).toBe('http://llm-proxy:8082');
    expect(typeof command.handle).toBe('string');
    expect(command.handle.length).toBeGreaterThan(0);
    expect(sessionCount()).toBe(1);
    expect(handleCount.get(input.principalId)).toBe(1);

    runtime.handleFrame({ type: 'turnAccepted', turnId: input.turnId });
    await startPromise;

    // Accepted, not ended — no turnEnded (or any other) event yet.
    expect(events).toEqual([]);
  });

  it('S2.13: a connect_gatekeeper Grant populates the freshly issued entry Handle’s resources.gatekeeper', async () => {
    const principalId = randomUUID();
    const { pool } = createFakePool(new Map(), new Map([[principalId, ['gk-1', 'gk-2']]]));
    const { sink } = createFakeSink();
    const privateKey = await ephemeralPrivateKey();
    const runtime = new AgentHostRuntime({
      pool,
      sink,
      privateKey,
      kernelLlmUrl: 'http://llm-proxy:8082',
      log: () => {},
    });
    const { link, sent } = createFakeLink();
    runtime.connect(link);

    const input = startTurnInput({ principalId });
    const startPromise = runtime.startTurn(input);
    await vi.waitFor(() => expect(sent).toHaveLength(1));

    const command = sent[0] as Extract<KernelToAgentHostFrame, { type: 'startTurn' }>;
    // Decode the Handle's own JWT payload (no signature verification needed for this assertion —
    // governance/capability/handles.test.ts already covers signing/verification correctness) to
    // inspect the CapabilityScope ensureEntryHandle actually issued.
    const payloadSegment = command.handle.split('.')[1] ?? '';
    const claims = JSON.parse(Buffer.from(payloadSegment, 'base64url').toString('utf8')) as {
      scope: { resources: Record<string, readonly string[]> };
    };
    expect(new Set(claims.scope.resources.gatekeeper)).toEqual(new Set(['gk-1', 'gk-2']));

    runtime.handleFrame({ type: 'turnAccepted', turnId: input.turnId });
    await startPromise;
  });

  it('reuses a cached entry Handle for a second turn from the same principal', async () => {
    const { pool, handleCount } = createFakePool();
    const { sink } = createFakeSink();
    const privateKey = await ephemeralPrivateKey();
    const runtime = new AgentHostRuntime({
      pool,
      sink,
      privateKey,
      kernelLlmUrl: 'http://llm-proxy:8082',
      log: () => {},
    });
    const { link, sent } = createFakeLink();
    runtime.connect(link);

    const principalId = randomUUID();
    const workspaceId = randomUUID();

    const first = startTurnInput({ principalId, workspaceId });
    const firstPromise = runtime.startTurn(first);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    runtime.handleFrame({ type: 'turnAccepted', turnId: first.turnId });
    await firstPromise;

    const second = startTurnInput({ principalId, workspaceId });
    const secondPromise = runtime.startTurn(second);
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    runtime.handleFrame({ type: 'turnAccepted', turnId: second.turnId });
    await secondPromise;

    expect(handleCount.get(principalId)).toBe(1); // issued once, reused the second time
    const firstCommand = sent[0] as Extract<KernelToAgentHostFrame, { type: 'startTurn' }>;
    const secondCommand = sent[1] as Extract<KernelToAgentHostFrame, { type: 'startTurn' }>;
    expect(secondCommand.handle).toBe(firstCommand.handle);
  });

  it('reissues the entry Handle once its cached ttl has mostly elapsed', async () => {
    const { pool, handleCount } = createFakePool();
    const { sink } = createFakeSink();
    const privateKey = await ephemeralPrivateKey();
    let nowMs = Date.now();
    const runtime = new AgentHostRuntime({
      pool,
      sink,
      privateKey,
      kernelLlmUrl: 'http://llm-proxy:8082',
      entryHandleTtlSeconds: 100,
      now: () => nowMs,
      log: () => {},
    });
    const { link, sent } = createFakeLink();
    runtime.connect(link);

    const principalId = randomUUID();
    const workspaceId = randomUUID();

    const first = startTurnInput({ principalId, workspaceId });
    const firstPromise = runtime.startTurn(first);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    runtime.handleFrame({ type: 'turnAccepted', turnId: first.turnId });
    await firstPromise;

    nowMs += 95_000; // <10% of the 100s ttl remaining

    const second = startTurnInput({ principalId, workspaceId });
    const secondPromise = runtime.startTurn(second);
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    runtime.handleFrame({ type: 'turnAccepted', turnId: second.turnId });
    await secondPromise;

    expect(handleCount.get(principalId)).toBe(2);
  });

  // Authority-tightening fix (review job 652a4abc item 4): "Grant changes become visible" — a
  // Grant made or revoked between two Turns must be picked up on the very next `startTurn`, not
  // only once the cached Handle is close enough to its ttl to reissue anyway.
  it('reissues the entry Handle early when the principal’s gatekeeper Grant coverage changed since the last issuance, even with a fresh cache', async () => {
    const principalId = randomUUID();
    const workspaceId = randomUUID();
    const grantedGatekeeperIdsByPrincipal = new Map<string, readonly string[]>([
      [principalId, ['gk-1']],
    ]);
    const { pool, handleCount } = createFakePool(new Map(), grantedGatekeeperIdsByPrincipal);
    const { sink } = createFakeSink();
    const privateKey = await ephemeralPrivateKey();
    const runtime = new AgentHostRuntime({
      pool,
      sink,
      privateKey,
      kernelLlmUrl: 'http://llm-proxy:8082',
      entryHandleTtlSeconds: 3600, // deliberately long — ttl-based reissue would not fire here
      log: () => {},
    });
    const { link, sent } = createFakeLink();
    runtime.connect(link);

    const first = startTurnInput({ principalId, workspaceId });
    const firstPromise = runtime.startTurn(first);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    runtime.handleFrame({ type: 'turnAccepted', turnId: first.turnId });
    await firstPromise;

    // A Grant was added (workspace owner ran `grant_capability{resourceType:'gatekeeper', ...}`) —
    // simulated here by mutating the fake pool's own grant map, exactly as a real `capability_
    // grants` row appearing between two `ensureEntryHandle` reads would.
    grantedGatekeeperIdsByPrincipal.set(principalId, ['gk-1', 'gk-2']);

    const second = startTurnInput({ principalId, workspaceId });
    const secondPromise = runtime.startTurn(second);
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    runtime.handleFrame({ type: 'turnAccepted', turnId: second.turnId });
    await secondPromise;

    expect(handleCount.get(principalId)).toBe(2); // reissued despite a still-fresh ttl
    const secondCommand = sent[1] as Extract<KernelToAgentHostFrame, { type: 'startTurn' }>;
    const payloadSegment = secondCommand.handle.split('.')[1] ?? '';
    const claims = JSON.parse(Buffer.from(payloadSegment, 'base64url').toString('utf8')) as {
      scope: { resources: Record<string, readonly string[]> };
    };
    expect(new Set(claims.scope.resources.gatekeeper)).toEqual(new Set(['gk-1', 'gk-2']));
  });

  it("W5.5 (STATUS leftover 18): a member principal's issued entry Handle excludes propose_* and keeps get_object", async () => {
    const principalId = randomUUID();
    const rolesByPrincipal = new Map<string, Role>([[principalId, 'member']]);
    const { pool } = createFakePool(
      new Map(),
      new Map(),
      new Map(),
      undefined,
      [],
      rolesByPrincipal,
    );
    const { sink } = createFakeSink();
    const privateKey = await ephemeralPrivateKey();
    const runtime = new AgentHostRuntime({
      pool,
      sink,
      privateKey,
      kernelLlmUrl: 'http://llm-proxy:8082',
      log: () => {},
    });
    const { link, sent } = createFakeLink();
    runtime.connect(link);

    const input = startTurnInput({ principalId });
    const startPromise = runtime.startTurn(input);
    await vi.waitFor(() => expect(sent).toHaveLength(1));

    const command = sent[0] as Extract<KernelToAgentHostFrame, { type: 'startTurn' }>;
    const payloadSegment = command.handle.split('.')[1] ?? '';
    const claims = JSON.parse(Buffer.from(payloadSegment, 'base64url').toString('utf8')) as {
      scope: { capabilities: readonly string[] };
    };
    expect(claims.scope.capabilities.some((name) => name.startsWith('propose_'))).toBe(false);
    expect(claims.scope.capabilities).toContain('get_object');

    runtime.handleFrame({ type: 'turnAccepted', turnId: input.turnId });
    await startPromise;
  });

  it('W5.5 (STATUS leftover 18): a role change between two Turns reissues the entry Handle instead of reusing the cache', async () => {
    const principalId = randomUUID();
    const workspaceId = randomUUID();
    const rolesByPrincipal = new Map<string, Role>([[principalId, 'member']]);
    const { pool, handleCount } = createFakePool(
      new Map(),
      new Map(),
      new Map(),
      undefined,
      [],
      rolesByPrincipal,
    );
    const { sink } = createFakeSink();
    const privateKey = await ephemeralPrivateKey();
    const runtime = new AgentHostRuntime({
      pool,
      sink,
      privateKey,
      kernelLlmUrl: 'http://llm-proxy:8082',
      entryHandleTtlSeconds: 3600, // deliberately long — ttl-based reissue would not fire here
      log: () => {},
    });
    const { link, sent } = createFakeLink();
    runtime.connect(link);

    const first = startTurnInput({ principalId, workspaceId });
    const firstPromise = runtime.startTurn(first);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    runtime.handleFrame({ type: 'turnAccepted', turnId: first.turnId });
    await firstPromise;

    // Role changed (workspace owner ran `set_principal_role`) — simulated here by mutating the
    // fake pool's own role map, exactly as a real `principals.role` update between two
    // `ensureEntryHandle` reads would.
    rolesByPrincipal.set(principalId, 'builder');

    const second = startTurnInput({ principalId, workspaceId });
    const secondPromise = runtime.startTurn(second);
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    runtime.handleFrame({ type: 'turnAccepted', turnId: second.turnId });
    await secondPromise;

    expect(handleCount.get(principalId)).toBe(2); // reissued despite a still-fresh ttl
    const firstCommand = sent[0] as Extract<KernelToAgentHostFrame, { type: 'startTurn' }>;
    const secondCommand = sent[1] as Extract<KernelToAgentHostFrame, { type: 'startTurn' }>;
    expect(secondCommand.handle).not.toBe(firstCommand.handle);
  });

  it('reissues the entry Handle when the cached jti has been revoked DB-side, even though the role and gate set are unchanged (W5.5 review fix)', async () => {
    const principalId = randomUUID();
    const workspaceId = randomUUID();
    const revokedJtis = new Set<string>();
    const { pool, handleCount } = createFakePool(
      new Map(),
      new Map(),
      new Map(),
      undefined,
      [],
      new Map(),
      revokedJtis,
    );
    const { sink } = createFakeSink();
    const privateKey = await ephemeralPrivateKey();
    const runtime = new AgentHostRuntime({
      pool,
      sink,
      privateKey,
      kernelLlmUrl: 'http://llm-proxy:8082',
      entryHandleTtlSeconds: 3600, // deliberately long — ttl-based reissue would not fire here
      log: () => {},
    });
    const { link, sent } = createFakeLink();
    runtime.connect(link);

    const first = startTurnInput({ principalId, workspaceId });
    const firstPromise = runtime.startTurn(first);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    runtime.handleFrame({ type: 'turnAccepted', turnId: first.turnId });
    await firstPromise;

    const firstCommand = sent[0] as Extract<KernelToAgentHostFrame, { type: 'startTurn' }>;
    const firstPayloadSegment = firstCommand.handle.split('.')[1] ?? '';
    const firstClaims = JSON.parse(
      Buffer.from(firstPayloadSegment, 'base64url').toString('utf8'),
    ) as { jti: string };

    // The Handle was revoked DB-side since it was cached (e.g. `disable_principal`/
    // `set_principal_role` on some other, unrelated path) — role and gate set are both
    // unchanged, so a value comparison alone would wrongly reuse the cached token.
    revokedJtis.add(firstClaims.jti);

    const second = startTurnInput({ principalId, workspaceId });
    const secondPromise = runtime.startTurn(second);
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    runtime.handleFrame({ type: 'turnAccepted', turnId: second.turnId });
    await secondPromise;

    expect(handleCount.get(principalId)).toBe(2); // reissued despite unchanged role/gate set
    const secondCommand = sent[1] as Extract<KernelToAgentHostFrame, { type: 'startTurn' }>;
    expect(secondCommand.handle).not.toBe(firstCommand.handle);
  });
});

describe('AgentHostRuntime — startTurn resolves the published entry WorkerDefinition (S2.6)', () => {
  it('includes systemPrompt/model on the startTurn frame when the workspace has a published entry definition', async () => {
    const input = startTurnInput();
    const { pool } = createFakePool(
      new Map([
        [
          input.workspaceId,
          { systemPrompt: 'you are the entry agent', model: 'example-provider/example-model' },
        ],
      ]),
    );
    const { sink } = createFakeSink();
    const privateKey = await ephemeralPrivateKey();
    const runtime = new AgentHostRuntime({
      pool,
      sink,
      privateKey,
      kernelLlmUrl: 'http://llm-proxy:8082',
      log: () => {},
    });
    const { link, sent } = createFakeLink();
    runtime.connect(link);

    const startPromise = runtime.startTurn(input);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    runtime.handleFrame({ type: 'turnAccepted', turnId: input.turnId });
    await startPromise;

    const command = sent[0] as Extract<KernelToAgentHostFrame, { type: 'startTurn' }>;
    expect(command.systemPrompt).toBe('you are the entry agent');
    expect(command.model).toBe('example-provider/example-model');
  });

  it('omits systemPrompt/model (never fails the turn) when no entry definition has been published', async () => {
    const { pool } = createFakePool(); // no seeded definitions
    const { sink, events } = createFakeSink();
    const privateKey = await ephemeralPrivateKey();
    const runtime = new AgentHostRuntime({
      pool,
      sink,
      privateKey,
      kernelLlmUrl: 'http://llm-proxy:8082',
      log: () => {},
    });
    const { link, sent } = createFakeLink();
    runtime.connect(link);

    const input = startTurnInput();
    const startPromise = runtime.startTurn(input);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    runtime.handleFrame({ type: 'turnAccepted', turnId: input.turnId });
    await startPromise;

    const command = sent[0] as Extract<KernelToAgentHostFrame, { type: 'startTurn' }>;
    expect(command.systemPrompt).toBeUndefined();
    expect(command.model).toBeUndefined();
    expect(events).toEqual([]); // never a turnEnded — the lookup gap is not fatal
  });

  it('omits systemPrompt/model when the published definition has no model set', async () => {
    const input = startTurnInput();
    const { pool } = createFakePool(
      new Map([[input.workspaceId, { systemPrompt: 'you are the entry agent' }]]),
    );
    const { sink } = createFakeSink();
    const privateKey = await ephemeralPrivateKey();
    const runtime = new AgentHostRuntime({
      pool,
      sink,
      privateKey,
      kernelLlmUrl: 'http://llm-proxy:8082',
      log: () => {},
    });
    const { link, sent } = createFakeLink();
    runtime.connect(link);

    const startPromise = runtime.startTurn(input);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    runtime.handleFrame({ type: 'turnAccepted', turnId: input.turnId });
    await startPromise;

    const command = sent[0] as Extract<KernelToAgentHostFrame, { type: 'startTurn' }>;
    expect(command.systemPrompt).toBe('you are the entry agent');
    expect(command.model).toBeUndefined();
  });

  it('includes egressDeny on the startTurn frame when the published entry definition declares one (feat/egress-definition-lists)', async () => {
    const input = startTurnInput();
    const { pool } = createFakePool(
      new Map([
        [
          input.workspaceId,
          { systemPrompt: 'you are the entry agent', egressDeny: ['blocked.example.com'] },
        ],
      ]),
    );
    const { sink } = createFakeSink();
    const privateKey = await ephemeralPrivateKey();
    const runtime = new AgentHostRuntime({
      pool,
      sink,
      privateKey,
      kernelLlmUrl: 'http://llm-proxy:8082',
      log: () => {},
    });
    const { link, sent } = createFakeLink();
    runtime.connect(link);

    const startPromise = runtime.startTurn(input);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    runtime.handleFrame({ type: 'turnAccepted', turnId: input.turnId });
    await startPromise;

    const command = sent[0] as Extract<KernelToAgentHostFrame, { type: 'startTurn' }>;
    expect(command.egressDeny).toEqual(['blocked.example.com']);
  });

  it('omits egressDeny when the published definition declares none', async () => {
    const input = startTurnInput();
    const { pool } = createFakePool(
      new Map([[input.workspaceId, { systemPrompt: 'you are the entry agent' }]]),
    );
    const { sink } = createFakeSink();
    const privateKey = await ephemeralPrivateKey();
    const runtime = new AgentHostRuntime({
      pool,
      sink,
      privateKey,
      kernelLlmUrl: 'http://llm-proxy:8082',
      log: () => {},
    });
    const { link, sent } = createFakeLink();
    runtime.connect(link);

    const startPromise = runtime.startTurn(input);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    runtime.handleFrame({ type: 'turnAccepted', turnId: input.turnId });
    await startPromise;

    const command = sent[0] as Extract<KernelToAgentHostFrame, { type: 'startTurn' }>;
    expect(command.egressDeny).toBeUndefined();
  });
});

describe('AgentHostRuntime — turnRejected and accept timeout', () => {
  it('turnRejected produces turnEnded {status: failed}, asynchronously after startTurn already resolved', async () => {
    const { pool } = createFakePool();
    const { sink, events } = createFakeSink();
    const privateKey = await ephemeralPrivateKey();
    const runtime = new AgentHostRuntime({
      pool,
      sink,
      privateKey,
      kernelLlmUrl: 'http://llm-proxy:8082',
      log: () => {},
    });
    const { link, sent } = createFakeLink();
    runtime.connect(link);

    const input = startTurnInput();
    const startPromise = runtime.startTurn(input);
    await vi.waitFor(() => expect(sent).toHaveLength(1));

    // lane-4 P2 fix: startTurn already resolved once the frame was sent — no turnEnded yet.
    await startPromise;
    expect(events).toEqual([]);

    runtime.handleFrame({ type: 'turnRejected', turnId: input.turnId, reason: 'busy' });
    await vi.waitFor(() => expect(events).toHaveLength(1));

    expect(events).toEqual([
      {
        type: 'turnEnded',
        status: 'failed',
        workspaceId: input.workspaceId,
        chatId: input.chatId,
        turnId: input.turnId,
        principalId: input.principalId,
      },
    ]);
  });

  it('a turnAccepted timeout produces turnEnded {status: failed}, asynchronously after startTurn already resolved', async () => {
    const { pool } = createFakePool();
    const { sink, events } = createFakeSink();
    const privateKey = await ephemeralPrivateKey();
    const runtime = new AgentHostRuntime({
      pool,
      sink,
      privateKey,
      kernelLlmUrl: 'http://llm-proxy:8082',
      turnAcceptedTimeoutMs: 10,
      log: () => {},
    });
    const { link } = createFakeLink();
    runtime.connect(link);

    const input = startTurnInput();
    // lane-4 P2 fix: startTurn resolves once the frame is sent — well before the 10ms accept
    // timeout could possibly fire, proving it is no longer on startTurn's own critical path.
    await runtime.startTurn(input);
    expect(events).toEqual([]);

    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(events).toEqual([
      {
        type: 'turnEnded',
        status: 'failed',
        workspaceId: input.workspaceId,
        chatId: input.chatId,
        turnId: input.turnId,
        principalId: input.principalId,
      },
    ]);
  });

  it('a link.send failure produces turnEnded {status: failed} rather than throwing', async () => {
    const { pool } = createFakePool();
    const { sink, events } = createFakeSink();
    const privateKey = await ephemeralPrivateKey();
    const runtime = new AgentHostRuntime({
      pool,
      sink,
      privateKey,
      kernelLlmUrl: 'http://llm-proxy:8082',
      log: () => {},
    });
    const { link, setThrowOnSend } = createFakeLink();
    setThrowOnSend(true);
    runtime.connect(link);

    const input = startTurnInput();
    await expect(runtime.startTurn(input)).resolves.toBeUndefined();

    expect(events).toEqual([
      {
        type: 'turnEnded',
        status: 'failed',
        workspaceId: input.workspaceId,
        chatId: input.chatId,
        turnId: input.turnId,
        principalId: input.principalId,
      },
    ]);
  });
});

describe('AgentHostRuntime — stopTurn', () => {
  it('sends a stopTurn command with the tracked principalId for an active turn', async () => {
    const { pool } = createFakePool();
    const { sink } = createFakeSink();
    const privateKey = await ephemeralPrivateKey();
    const runtime = new AgentHostRuntime({
      pool,
      sink,
      privateKey,
      kernelLlmUrl: 'http://llm-proxy:8082',
      log: () => {},
    });
    const { link, sent } = createFakeLink();
    runtime.connect(link);

    const input = startTurnInput();
    const startPromise = runtime.startTurn(input);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    runtime.handleFrame({ type: 'turnAccepted', turnId: input.turnId });
    await startPromise;

    await expect(runtime.stopTurn(input.turnId)).resolves.toBe(true);

    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual({
      type: 'stopTurn',
      turnId: input.turnId,
      principalId: input.principalId,
    });
  });

  it('is a no-op for an unknown turnId, and reports (false) that it knew nothing (lane-4 P1 fix)', async () => {
    const { pool } = createFakePool();
    const { sink } = createFakeSink();
    const privateKey = await ephemeralPrivateKey();
    const runtime = new AgentHostRuntime({
      pool,
      sink,
      privateKey,
      kernelLlmUrl: 'http://llm-proxy:8082',
      log: () => {},
    });
    const { link, sent } = createFakeLink();
    runtime.connect(link);

    await expect(runtime.stopTurn(randomUUID())).resolves.toBe(false);
    expect(sent).toHaveLength(0);
  });

  it('reports true (it knew) for an active turn even while agent-host is disconnected', async () => {
    const { pool } = createFakePool();
    const { sink } = createFakeSink();
    const privateKey = await ephemeralPrivateKey();
    const runtime = new AgentHostRuntime({
      pool,
      sink,
      privateKey,
      kernelLlmUrl: 'http://llm-proxy:8082',
      log: () => {},
    });
    const { link, sent } = createFakeLink();
    runtime.connect(link);

    const input = startTurnInput();
    const startPromise = runtime.startTurn(input);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    runtime.handleFrame({ type: 'turnAccepted', turnId: input.turnId });
    await startPromise;

    runtime.disconnect(link); // agent-host currently unreachable, but the turn is still tracked
    await expect(runtime.stopTurn(input.turnId)).resolves.toBe(true);
    expect(sent).toHaveLength(1); // nothing new sent — there is no link to send it on
  });

  it('is a no-op for a turnId already ended (turnEnded clears it from the active set)', async () => {
    const { pool } = createFakePool();
    const { sink } = createFakeSink();
    const privateKey = await ephemeralPrivateKey();
    const runtime = new AgentHostRuntime({
      pool,
      sink,
      privateKey,
      kernelLlmUrl: 'http://llm-proxy:8082',
      log: () => {},
    });
    const { link, sent } = createFakeLink();
    runtime.connect(link);

    const input = startTurnInput();
    const startPromise = runtime.startTurn(input);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    runtime.handleFrame({ type: 'turnAccepted', turnId: input.turnId });
    await startPromise;

    const event: AgentHostToKernelFrame = {
      type: 'runtimeEvent',
      event: {
        type: 'turnEnded',
        status: 'completed',
        workspaceId: input.workspaceId,
        chatId: input.chatId,
        turnId: input.turnId,
        principalId: input.principalId,
      },
    };
    runtime.handleFrame(event);
    await Promise.resolve();

    await expect(runtime.stopTurn(input.turnId)).resolves.toBe(false);
    expect(sent).toHaveLength(1); // only the original startTurn — no stopTurn was sent
  });
});

describe('AgentHostRuntime — runtimeEvent forwarding', () => {
  it('forwards textDelta/toolCallStarted/toolCallEnded/message/turnEnded verbatim to the sink', async () => {
    const { pool } = createFakePool();
    const { sink, events } = createFakeSink();
    const privateKey = await ephemeralPrivateKey();
    const runtime = new AgentHostRuntime({
      pool,
      sink,
      privateKey,
      kernelLlmUrl: 'http://llm-proxy:8082',
      log: () => {},
    });
    const { link, sent } = createFakeLink();
    runtime.connect(link);

    const input = startTurnInput();
    const startPromise = runtime.startTurn(input);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    runtime.handleFrame({ type: 'turnAccepted', turnId: input.turnId });
    await startPromise;

    const base = {
      workspaceId: input.workspaceId,
      chatId: input.chatId,
      turnId: input.turnId,
      principalId: input.principalId,
    };
    const frames: AgentHostToKernelFrame[] = [
      { type: 'runtimeEvent', event: { type: 'textDelta', delta: 'hi', ...base } },
      {
        type: 'runtimeEvent',
        event: { type: 'toolCallStarted', toolCallId: 'c1', name: 'search', ...base },
      },
      { type: 'runtimeEvent', event: { type: 'toolCallEnded', toolCallId: 'c1', ...base } },
      {
        type: 'runtimeEvent',
        event: { type: 'message', role: 'assistant', content: { text: 'hi' }, ...base },
      },
      { type: 'runtimeEvent', event: { type: 'turnEnded', status: 'completed', ...base } },
    ];
    for (const frame of frames) runtime.handleFrame(frame);
    await Promise.resolve();

    expect(events).toHaveLength(5);
    expect(events[0]).toEqual({ type: 'textDelta', delta: 'hi', ...base });
    expect(events[4]).toEqual({ type: 'turnEnded', status: 'completed', ...base });
  });
});

describe('AgentHostRuntime — connect/disconnect', () => {
  it('a stale link disconnecting does not clear the current link', async () => {
    const { pool } = createFakePool();
    const { sink } = createFakeSink();
    const privateKey = await ephemeralPrivateKey();
    const runtime = new AgentHostRuntime({
      pool,
      sink,
      privateKey,
      kernelLlmUrl: 'http://llm-proxy:8082',
      log: () => {},
    });
    const oldLink = createFakeLink();
    const newLink = createFakeLink();

    runtime.connect(oldLink.link);
    runtime.connect(newLink.link);
    runtime.disconnect(oldLink.link); // stale — must not clear newLink

    const input = startTurnInput();
    void runtime.startTurn(input);
    await vi.waitFor(() => expect(newLink.sent).toHaveLength(1));
    expect(oldLink.sent).toHaveLength(0);
  });
});

describe('AgentHostRuntime — hello / instanceId restart detection', () => {
  it('a hello with the same instanceId as before does not disturb active turns', async () => {
    const { pool } = createFakePool();
    const { sink, events } = createFakeSink();
    const privateKey = await ephemeralPrivateKey();
    const runtime = new AgentHostRuntime({
      pool,
      sink,
      privateKey,
      kernelLlmUrl: 'http://llm-proxy:8082',
      log: () => {},
    });
    const { link, sent } = createFakeLink();
    runtime.connect(link);

    const instanceId = randomUUID();
    runtime.handleFrame({ type: 'hello', instanceId });

    const input = startTurnInput();
    const startPromise = runtime.startTurn(input);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    runtime.handleFrame({ type: 'turnAccepted', turnId: input.turnId });
    await startPromise;

    runtime.handleFrame({ type: 'hello', instanceId }); // same instance reconnecting — a mere blip
    await Promise.resolve();

    expect(events).toEqual([]); // turn still active, nothing abandoned

    await expect(runtime.stopTurn(input.turnId)).resolves.toBe(true);
    expect(sent).toHaveLength(2); // stopTurn actually sent — proves the turn is still tracked active
  });

  it('a hello with a new instanceId abandons every still-active turn as interrupted', async () => {
    const { pool } = createFakePool();
    const { sink, events } = createFakeSink();
    const privateKey = await ephemeralPrivateKey();
    const runtime = new AgentHostRuntime({
      pool,
      sink,
      privateKey,
      kernelLlmUrl: 'http://llm-proxy:8082',
      log: () => {},
    });
    const { link, sent } = createFakeLink();
    runtime.connect(link);

    runtime.handleFrame({ type: 'hello', instanceId: randomUUID() });

    const input = startTurnInput();
    const startPromise = runtime.startTurn(input);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    runtime.handleFrame({ type: 'turnAccepted', turnId: input.turnId });
    await startPromise;

    runtime.handleFrame({ type: 'hello', instanceId: randomUUID() }); // a genuinely new process
    await Promise.resolve();

    expect(events).toEqual([
      {
        type: 'turnEnded',
        status: 'interrupted',
        workspaceId: input.workspaceId,
        chatId: input.chatId,
        turnId: input.turnId,
        principalId: input.principalId,
      },
    ]);

    // The turn is no longer tracked active — a stopTurn call for it is now a no-op, and reports
    // (false) that this runtime knows nothing about it (lane-4 P1 fix).
    await expect(runtime.stopTurn(input.turnId)).resolves.toBe(false);
    expect(sent).toHaveLength(1);
  });

  it('a restart also fails any turn still waiting on turnAccepted, without waiting for its timeout', async () => {
    const { pool } = createFakePool();
    const { sink, events } = createFakeSink();
    const privateKey = await ephemeralPrivateKey();
    const runtime = new AgentHostRuntime({
      pool,
      sink,
      privateKey,
      kernelLlmUrl: 'http://llm-proxy:8082',
      turnAcceptedTimeoutMs: 60_000,
      log: () => {},
    });
    const { link, sent } = createFakeLink();
    runtime.connect(link);

    runtime.handleFrame({ type: 'hello', instanceId: randomUUID() });

    const input = startTurnInput();
    const startPromise = runtime.startTurn(input);
    await vi.waitFor(() => expect(sent).toHaveLength(1));

    // lane-4 P2 fix: startTurn already resolved once the frame was sent (see other describe
    // blocks) — the restart below and its abandon-as-failed side effect happen strictly after.
    await startPromise;

    // Restart arrives before turnAccepted ever does.
    runtime.handleFrame({ type: 'hello', instanceId: randomUUID() });
    await vi.waitFor(() => expect(events).toHaveLength(1));

    expect(events).toEqual([
      {
        type: 'turnEnded',
        status: 'failed',
        workspaceId: input.workspaceId,
        chatId: input.chatId,
        turnId: input.turnId,
        principalId: input.principalId,
      },
    ]);
  });
});

describe('AgentHostRuntime — S3.13 AgentProfile runtime projection', () => {
  it('effective.model overrides the published entry WorkerDefinition’s own model', async () => {
    const principalId = randomUUID();
    const { pool } = createFakePool(
      new Map([['ws', { model: 'anthropic/claude-haiku' }]]),
      new Map(),
      new Map([[principalId, { model: 'anthropic/claude-sonnet' }]]),
    );
    const { sink } = createFakeSink();
    const privateKey = await ephemeralPrivateKey();
    const runtime = new AgentHostRuntime({
      pool,
      sink,
      privateKey,
      kernelLlmUrl: 'http://llm-proxy:8082',
      log: () => {},
    });
    const { link, sent } = createFakeLink();
    runtime.connect(link);

    const input = startTurnInput({ principalId, workspaceId: 'ws' });
    const startPromise = runtime.startTurn(input);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    const command = sent[0] as Extract<KernelToAgentHostFrame, { type: 'startTurn' }>;
    expect(command.model).toBe('anthropic/claude-sonnet');

    runtime.handleFrame({ type: 'turnAccepted', turnId: input.turnId });
    await startPromise;
  });

  it('falls back to the published entry WorkerDefinition’s model when the profile sets none', async () => {
    const principalId = randomUUID();
    const { pool } = createFakePool(
      new Map([['ws', { model: 'anthropic/claude-haiku' }]]),
      new Map(),
      new Map([[principalId, { promptAddendum: 'be terse' }]]), // no model on the profile
    );
    const { sink } = createFakeSink();
    const privateKey = await ephemeralPrivateKey();
    const runtime = new AgentHostRuntime({
      pool,
      sink,
      privateKey,
      kernelLlmUrl: 'http://llm-proxy:8082',
      log: () => {},
    });
    const { link, sent } = createFakeLink();
    runtime.connect(link);

    const input = startTurnInput({ principalId, workspaceId: 'ws' });
    const startPromise = runtime.startTurn(input);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    const command = sent[0] as Extract<KernelToAgentHostFrame, { type: 'startTurn' }>;
    expect(command.model).toBe('anthropic/claude-haiku');

    runtime.handleFrame({ type: 'turnAccepted', turnId: input.turnId });
    await startPromise;
  });

  it('effective.promptAddendum is appended as a delimited final section, never replacing the platform prompt', async () => {
    const principalId = randomUUID();
    const { pool } = createFakePool(
      new Map([['ws', { systemPrompt: 'You are the NextTime entry agent.' }]]),
      new Map(),
      new Map([[principalId, { promptAddendum: 'Prefer concise answers.' }]]),
    );
    const { sink } = createFakeSink();
    const privateKey = await ephemeralPrivateKey();
    const runtime = new AgentHostRuntime({
      pool,
      sink,
      privateKey,
      kernelLlmUrl: 'http://llm-proxy:8082',
      log: () => {},
    });
    const { link, sent } = createFakeLink();
    runtime.connect(link);

    const input = startTurnInput({ principalId, workspaceId: 'ws' });
    const startPromise = runtime.startTurn(input);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    const command = sent[0] as Extract<KernelToAgentHostFrame, { type: 'startTurn' }>;
    expect(command.systemPrompt?.startsWith('You are the NextTime entry agent.')).toBe(true);
    expect(command.systemPrompt).toContain('Prefer concise answers.');
    // The platform section still comes first — the addendum can only ever follow it.
    expect(command.systemPrompt?.indexOf('You are the NextTime entry agent.')).toBeLessThan(
      command.systemPrompt?.indexOf('Prefer concise answers.') ?? -1,
    );

    runtime.handleFrame({ type: 'turnAccepted', turnId: input.turnId });
    await startPromise;
  });

  it('never widens the entry Handle’s gate scope past effective.enabledGatekeepers — only narrows the Grant-derived set', async () => {
    const principalId = randomUUID();
    const { pool } = createFakePool(
      new Map(),
      new Map([[principalId, ['gk-1', 'gk-2', 'gk-3']]]), // 3 active Grants
      new Map([[principalId, { enabledGatekeepers: ['gk-2'] }]]), // Profile narrows to just one
    );
    const { sink } = createFakeSink();
    const privateKey = await ephemeralPrivateKey();
    const runtime = new AgentHostRuntime({
      pool,
      sink,
      privateKey,
      kernelLlmUrl: 'http://llm-proxy:8082',
      log: () => {},
    });
    const { link, sent } = createFakeLink();
    runtime.connect(link);

    const input = startTurnInput({ principalId });
    const startPromise = runtime.startTurn(input);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    const command = sent[0] as Extract<KernelToAgentHostFrame, { type: 'startTurn' }>;
    const payloadSegment = command.handle.split('.')[1] ?? '';
    const claims = JSON.parse(Buffer.from(payloadSegment, 'base64url').toString('utf8')) as {
      scope: { resources: Record<string, readonly string[]> };
    };
    expect(claims.scope.resources.gatekeeper).toEqual(['gk-2']);

    runtime.handleFrame({ type: 'turnAccepted', turnId: input.turnId });
    await startPromise;
  });

  it('a null effective.enabledGatekeepers imposes no restriction beyond the Grant-derived ceiling', async () => {
    const principalId = randomUUID();
    const { pool } = createFakePool(
      new Map(),
      new Map([[principalId, ['gk-1', 'gk-2']]]),
      new Map([[principalId, { promptAddendum: 'no gate restriction set' }]]), // enabledGatekeepers omitted -> null
    );
    const { sink } = createFakeSink();
    const privateKey = await ephemeralPrivateKey();
    const runtime = new AgentHostRuntime({
      pool,
      sink,
      privateKey,
      kernelLlmUrl: 'http://llm-proxy:8082',
      log: () => {},
    });
    const { link, sent } = createFakeLink();
    runtime.connect(link);

    const input = startTurnInput({ principalId });
    const startPromise = runtime.startTurn(input);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    const command = sent[0] as Extract<KernelToAgentHostFrame, { type: 'startTurn' }>;
    const payloadSegment = command.handle.split('.')[1] ?? '';
    const claims = JSON.parse(Buffer.from(payloadSegment, 'base64url').toString('utf8')) as {
      scope: { resources: Record<string, readonly string[]> };
    };
    expect(new Set(claims.scope.resources.gatekeeper)).toEqual(new Set(['gk-1', 'gk-2']));

    runtime.handleFrame({ type: 'turnAccepted', turnId: input.turnId });
    await startPromise;
  });

  it('mounts effective.enabledSkills as skillsInline content, and mounts nothing when the profile is null', async () => {
    const principalId = randomUUID();
    const { pool } = createFakePool(
      new Map(),
      new Map(),
      new Map([[principalId, { enabledSkills: ['writing-tips'] }]]),
      undefined,
      [{ id: 'skill-1', name: 'writing-tips' }],
    );
    const { sink } = createFakeSink();
    const privateKey = await ephemeralPrivateKey();
    const runtime = new AgentHostRuntime({
      pool,
      sink,
      privateKey,
      kernelLlmUrl: 'http://llm-proxy:8082',
      log: () => {},
    });
    const { link, sent } = createFakeLink();
    runtime.connect(link);

    const input = startTurnInput({ principalId });
    const startPromise = runtime.startTurn(input);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    const command = sent[0] as Extract<KernelToAgentHostFrame, { type: 'startTurn' }>;
    expect(command.skillsInline).toEqual([
      { name: 'writing-tips', files: { 'SKILL.md': expect.stringContaining('writing-tips') } },
    ]);

    runtime.handleFrame({ type: 'turnAccepted', turnId: input.turnId });
    await startPromise;
  });

  it('mounts every currently-published Skill when the profile’s enabledSkills is null (inherit) — matches the already-shipped web console’s "everything available" reading', async () => {
    const principalId = randomUUID();
    const { pool } = createFakePool(new Map(), new Map(), new Map(), undefined, [
      { id: 'skill-1', name: 'writing-tips' },
      { id: 'skill-2', name: 'code-review' },
    ]);
    const { sink } = createFakeSink();
    const privateKey = await ephemeralPrivateKey();
    const runtime = new AgentHostRuntime({
      pool,
      sink,
      privateKey,
      kernelLlmUrl: 'http://llm-proxy:8082',
      log: () => {},
    });
    const { link, sent } = createFakeLink();
    runtime.connect(link);

    const input = startTurnInput({ principalId });
    const startPromise = runtime.startTurn(input);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    const command = sent[0] as Extract<KernelToAgentHostFrame, { type: 'startTurn' }>;
    expect(command.skillsInline?.map((s) => s.name).sort()).toEqual([
      'code-review',
      'writing-tips',
    ]);

    runtime.handleFrame({ type: 'turnAccepted', turnId: input.turnId });
    await startPromise;
  });

  it('reissues the entry Handle when the AgentProfile changes even though the gate scope stays identical', async () => {
    const principalId = randomUUID();
    const workspaceId = randomUUID();
    const profiles = new Map([
      [
        principalId,
        { model: 'anthropic/claude-haiku', updatedAt: new Date('2026-01-01T00:00:00Z') },
      ],
    ]);
    const { pool, handleCount } = createFakePool(new Map(), new Map(), profiles);
    const { sink } = createFakeSink();
    const privateKey = await ephemeralPrivateKey();
    const runtime = new AgentHostRuntime({
      pool,
      sink,
      privateKey,
      kernelLlmUrl: 'http://llm-proxy:8082',
      log: () => {},
    });
    const { link, sent } = createFakeLink();
    runtime.connect(link);

    const first = startTurnInput({ principalId, workspaceId });
    const firstPromise = runtime.startTurn(first);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    runtime.handleFrame({ type: 'turnAccepted', turnId: first.turnId });
    await firstPromise;
    expect(handleCount.get(principalId)).toBe(1);

    // Simulate set_agent_profile committing a change (a new updated_at) — the cached Handle must
    // not be reused even though `gatekeeperIds` (empty, unaffected) has not changed.
    profiles.set(principalId, {
      model: 'anthropic/claude-sonnet',
      updatedAt: new Date('2026-01-02T00:00:00Z'),
    });

    const second = startTurnInput({ principalId, workspaceId });
    const secondPromise = runtime.startTurn(second);
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    runtime.handleFrame({ type: 'turnAccepted', turnId: second.turnId });
    await secondPromise;

    expect(handleCount.get(principalId)).toBe(2); // reissued, not reused
    const firstCommand = sent[0] as Extract<KernelToAgentHostFrame, { type: 'startTurn' }>;
    const secondCommand = sent[1] as Extract<KernelToAgentHostFrame, { type: 'startTurn' }>;
    expect(secondCommand.handle).not.toBe(firstCommand.handle);
    expect(secondCommand.model).toBe('anthropic/claude-sonnet');
  });

  it('a caller with no AgentProfile row behaves exactly as before S3.13 (no override, cache still works)', async () => {
    const principalId = randomUUID();
    const { pool, handleCount } = createFakePool(
      new Map([['ws', { model: 'anthropic/claude-haiku', systemPrompt: 'platform prompt' }]]),
    );
    const { sink } = createFakeSink();
    const privateKey = await ephemeralPrivateKey();
    const runtime = new AgentHostRuntime({
      pool,
      sink,
      privateKey,
      kernelLlmUrl: 'http://llm-proxy:8082',
      log: () => {},
    });
    const { link, sent } = createFakeLink();
    runtime.connect(link);

    const first = startTurnInput({ principalId, workspaceId: 'ws' });
    const firstPromise = runtime.startTurn(first);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    runtime.handleFrame({ type: 'turnAccepted', turnId: first.turnId });
    await firstPromise;

    const second = startTurnInput({ principalId, workspaceId: 'ws' });
    const secondPromise = runtime.startTurn(second);
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    runtime.handleFrame({ type: 'turnAccepted', turnId: second.turnId });
    await secondPromise;

    expect(handleCount.get(principalId)).toBe(1); // still reused across turns
    const commands = sent as Extract<KernelToAgentHostFrame, { type: 'startTurn' }>[];
    for (const command of commands) {
      expect(command.model).toBe('anthropic/claude-haiku');
      expect(command.systemPrompt).toBe('platform prompt');
      expect(command.skillsInline).toBeUndefined();
    }
  });
});
