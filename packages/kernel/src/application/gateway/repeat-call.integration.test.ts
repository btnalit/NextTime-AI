import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Capability, getCapability } from '@nexttime/shared';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool } from '../../adapters/db/pool.js';
import { mapCapabilityError } from '../../interfaces/http/capability-route.js';
import { dispatchCapability } from './dispatch.js';
import type { ResolvedCaller } from './resolve-caller.js';
import {
  type Seeded,
  humanCaller,
  newWorkspace,
  paramsFor,
  registerSeededGatekeeper,
  seedWorkspace,
  workspaceDigest,
} from './traversal-fixture.js';

/**
 * Batch D4 (docs/test-coverage-gaps-2026-11-06.md §5.7, gap G6): a capability with side effects,
 * called twice with the same params, does what docs/contracts/capability-matrix.yaml says it does
 * (`repeat`, guard rule M6). The table drives the test: every row that declares an answer is
 * exercised here, so a declaration nobody checks cannot exist — a row whose first call the
 * fixture cannot make succeed fails, and needs a recipe below (or stays `unclear`).
 *
 * What each answer means, as asserted (per #493 on batch D4):
 * - `idempotent`: the second call succeeds and returns the same entity (same `id`, when it has
 *   one); every row the workspace owns is unchanged — outbox included, since a second outbox event
 *   is an external action done twice — except `audit_records`, which gains exactly the second
 *   call's own dispatch row (each call is audited, "审计只增不减") and no domain row (an `x.y`
 *   action: a second one would record a transition that did not happen).
 * - `creates`: the second call succeeds and returns a different entity (a new `id`).
 * - `repeats`: the second call succeeds, on the same entity (same `id`), and changes its state.
 * - `conflict: <code>`: the second call is refused with that wire error code, as a typed 4xx
 *   (`mapCapabilityError`, what HTTP and WS send); nothing changes, and the audit gains nothing
 *   but refusal records (`outcome: 'refused'`).
 *
 * Each row runs in a fresh, seeded workspace (traversal-fixture.ts), as its owner by the human
 * channel. What a capability does inside its gatekeeper (an execution-level idempotency store) is
 * another layer, not this column.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');
const MATRIX = path.join(KERNEL_ROOT, '..', '..', 'docs', 'contracts', 'capability-matrix.yaml');

/** What a recipe gets: the seeded workspace, its owner's caller, its member, and the pool. */
interface RecipeContext {
  readonly pool: Pool;
  readonly caller: ResolvedCaller;
  readonly seed: Seeded;
  readonly memberId: string;
}

/** One extra case: sets the workspace up before the first call and returns the params; `first`
 *  is what the first call must answer, so the case provably took the path it is named for. */
interface Recipe {
  readonly setUp: (ctx: RecipeContext) => Promise<Record<string, unknown>>;
  readonly first?: unknown;
  /** This path's answer, when it is not the row's: a row declares what its default path does
   *  (the params a caller sends most), and a known, intended other path says its own here. */
  readonly repeat?: string;
}

/** A call as the recipe's owner, for setting a case up. */
function as<T = Record<string, unknown>>(
  ctx: RecipeContext,
  name: string,
  params: Record<string, unknown>,
): Promise<T> {
  return dispatchCapability({ pool: ctx.pool }, ctx.caller, name, params) as Promise<T>;
}

/** A Skill / Procedure body the walk cannot build (a name, a description, Markdown or steps). */
const skillBody = () => ({
  name: `repeat-skill-${randomUUID().slice(0, 8)}`,
  description: 'A Skill for the repeat walk.',
  markdown: '# Steps\n\nOne.',
});
const procedureBody = () => ({
  name: `repeat-procedure-${randomUUID().slice(0, 8)}`,
  description: 'A Procedure for the repeat walk.',
  steps: [{ kind: 'approval', description: 'A human approves the change.' }],
});

interface Proposed {
  readonly id: string;
  readonly draftDigest: string;
}

/** v1 of a Skill (or Procedure), proposed and — when `publish` — published. */
async function familyV1(
  ctx: RecipeContext,
  kind: 'skill' | 'procedure',
  body: Record<string, unknown>,
  publish: boolean,
): Promise<Proposed> {
  const v1 = await as<Proposed>(ctx, `propose_${kind}`, { [kind]: body });
  if (publish) {
    await as(ctx, `publish_${kind}`, {
      [`${kind}Id`]: v1.id,
      version: 1,
      draftDigest: v1.draftDigest,
    });
  }
  return v1;
}

/** v1 of a worker WorkerDefinition, proposed and — when `publish` — published. */
async function workerV1(ctx: RecipeContext, publish: boolean): Promise<{ id: string }> {
  const v1 = await as<{ id: string }>(ctx, 'propose_worker_definition', {
    kind: 'worker',
    definition: { systemPrompt: 'A worker for the repeat walk.' },
  });
  if (publish) await as(ctx, 'publish_worker_definition', { definitionId: v1.id, version: 1 });
  return v1;
}

/** An evaluation suite on a published worker v1; `withGate`: the seeded gate frozen into it (v2). */
async function evalSuite(
  ctx: RecipeContext,
  withGate: boolean,
): Promise<{ id: string; version: number; workerId: string }> {
  const worker = await workerV1(ctx, true);
  const suite = await as<{ id: string; version: number }>(ctx, 'create_eval_suite', {
    name: `repeat-suite-${randomUUID().slice(0, 8)}`,
    workerDefinitionId: worker.id,
    workerDefinitionVersion: 1,
  });
  if (!withGate) return { ...suite, workerId: worker.id };
  await registerSeededGatekeeper(ctx.pool, ctx.seed);
  const frozen = await as<{ id: string; version: number }>(ctx, 'add_eval_fixture_gate', {
    suiteId: suite.id,
    suiteVersion: suite.version,
    gatekeeperId: ctx.seed.gatekeeperId,
  });
  return { ...frozen, workerId: worker.id };
}

/** A case on the seeded gate's one Operation (named after the marker). */
const evalCase = (seed: Seeded) => ({
  title: 'Restart web-1 when it hangs',
  input: 'web-1 hangs',
  fixtures: [
    {
      gatekeeperId: seed.gatekeeperId,
      operation: seed.marker,
      answer: { kind: 'data', data: { restarted: true } },
    },
  ],
  assertions: [{ expect: { path: 'result.summary', op: 'contains', value: 'web-1' } }],
});

/** A suite with one case (v3), and that case's id. */
async function suiteWithCase(ctx: RecipeContext) {
  const suite = await evalSuite(ctx, true);
  const withCase = await as<{ id: string; version: number; cases: { id: string }[] }>(
    ctx,
    'add_eval_case',
    {
      suiteId: suite.id,
      suiteVersion: suite.version,
      partition: 'regression',
      split: 'dev',
      ...evalCase(ctx.seed),
    },
  );
  return { suiteId: withCase.id, suiteVersion: withCase.version, caseId: withCase.cases[0]?.id };
}

/** reject_draft's case: v1 published, v2 proposed — the pending draft the reviewer takes off. */
async function pendingV2(ctx: RecipeContext, kind: 'skill' | 'procedure') {
  const body = kind === 'skill' ? skillBody() : procedureBody();
  const v1 = await familyV1(ctx, kind, body, true);
  const next = kind === 'skill' ? { ...body, markdown: '# Two' } : { ...body, description: 'v2' };
  const v2 = await as<Proposed>(ctx, `propose_${kind}`, { [kind]: next, [`${kind}Id`]: v1.id });
  return { kind, id: v1.id, version: 2, draftDigest: v2.draftDigest, reason: 'Not this one.' };
}

/** Extra cases for a row, beyond the one with schema-built params on the bare seed. A declaration
 *  holds on every path, so a row whose answer depends on state gets a case per state (per #493 on
 *  batch D4). */
const RECIPES: Readonly<Record<string, Readonly<Record<string, Recipe>>>> = {
  stop_agent: {
    // The bare seed has no Turn, so the schema-built case only walks the idle path
    // (`stopped: false` twice). Here a Turn is running first — `send_chat_message` starts one,
    // and with no agent runtime wired nothing ends it — so both calls take the stop path.
    'a running Turn': {
      setUp: async ({ pool, caller, seed }) => {
        await dispatchCapability({ pool }, caller, 'send_chat_message', {
          chatId: seed.chatId,
          text: 'run, so that it can be stopped',
        });
        return { chatId: seed.chatId };
      },
      first: { stopped: true },
    },
  },
  // Legacy 647: a second grant of one scope returns the first. Both name a person, which the
  // schema walk cannot pick (`principalId` falls back to an Operation's id), so these rows run their
  // recipes only (`RECIPES_ONLY`).
  grant_capability: {
    'the member, the seeded gate': {
      setUp: async ({ seed, memberId }) => ({
        principalId: memberId,
        resourceType: 'gatekeeper',
        resourceId: seed.gatekeeperId,
      }),
    },
  },
  connect_gatekeeper: {
    'the member, the seeded gate': {
      setUp: async ({ pool, seed, memberId }) => {
        await registerSeededGatekeeper(pool, seed);
        return { gatekeeperId: seed.gatekeeperId, principalId: memberId };
      },
    },
  },
  // Legacy 664, batch 1. The rows below name a person, a Grant, a request or a draft the walk
  // cannot pick, so they run their recipes only (`RECIPES_ONLY`).
  set_principal_role: {
    'the member, to builder': {
      setUp: async ({ memberId }) => ({ principalId: memberId, role: 'builder' }),
    },
  },
  disable_principal: {
    'the member': { setUp: async ({ memberId }) => ({ principalId: memberId }) },
  },
  rotate_api_key: {
    // People sign in with a password (a person's key is refused): a service Principal's key.
    'a service Principal': {
      setUp: async (ctx) => {
        const made = await as<{ principal: { id: string } }>(ctx, 'create_principal', {
          role: 'member',
          displayName: 'repeat service',
        });
        return { principalId: made.principal.id };
      },
    },
  },
  revoke_capability: {
    // An already revoked Grant is not offered again: grants.ts `revokeCapabilityGrant` matches
    // active rows only, on purpose, so the second revoke is the not-found of a missing one.
    'a Grant to the member': {
      setUp: async (ctx) => {
        const grant = await as<{ id: string }>(ctx, 'grant_capability', {
          principalId: ctx.memberId,
          resourceType: 'gatekeeper',
          resourceId: ctx.seed.gatekeeperId,
        });
        return { grantId: grant.id };
      },
    },
  },
  cancel_connection_request: {
    'a pending request': {
      setUp: async (ctx) => {
        const request = await as<{ id: string }>(ctx, 'request_connection', {
          kind: 'ssh',
          target: 'repeat.example',
        });
        return { connectionRequestId: request.id };
      },
    },
  },
  record_decision: {
    // A Decision is attributed to the running Turn; with no agent runtime nothing ends it.
    'a running Turn': {
      setUp: async (ctx) => {
        await as(ctx, 'send_chat_message', { chatId: ctx.seed.chatId, text: 'decide something' });
        return { summary: 'Restart web-1 tonight.' };
      },
    },
  },
  publish_skill: {
    'a v1 draft': {
      setUp: async (ctx) => {
        const v1 = await familyV1(ctx, 'skill', skillBody(), false);
        return { skillId: v1.id, version: 1, draftDigest: v1.draftDigest };
      },
    },
  },
  deprecate_skill: {
    'a published v1': {
      setUp: async (ctx) => ({ skillId: (await familyV1(ctx, 'skill', skillBody(), true)).id }),
    },
  },
  publish_procedure: {
    'a v1 draft': {
      setUp: async (ctx) => {
        const v1 = await familyV1(ctx, 'procedure', procedureBody(), false);
        return { procedureId: v1.id, version: 1, draftDigest: v1.draftDigest };
      },
    },
  },
  deprecate_procedure: {
    'a published v1': {
      setUp: async (ctx) => ({
        procedureId: (await familyV1(ctx, 'procedure', procedureBody(), true)).id,
      }),
    },
  },
  // Without an id, each call starts a new draft family — same name or not; two families with
  // one name are stopped at publish (`skill_name_conflict`), by design (#493 on 664 batch 1). An
  // agent retrying a lost answer leaves extra drafts, never an extra published Skill. With the id
  // of a published family, the first call proposes its next version and a second one is refused
  // while that draft is pending.
  propose_skill: {
    'a new family': { setUp: async () => ({ skill: skillBody() }) },
    'the next version of a published one': {
      setUp: async (ctx) => {
        const body = skillBody();
        const v1 = await familyV1(ctx, 'skill', body, true);
        return { skill: { ...body, markdown: '# Two' }, skillId: v1.id };
      },
      repeat: 'conflict: draft_pending',
    },
  },
  propose_procedure: {
    'a new family': { setUp: async () => ({ procedure: procedureBody() }) },
    'the next version of a published one': {
      setUp: async (ctx) => {
        const body = procedureBody();
        const v1 = await familyV1(ctx, 'procedure', body, true);
        return { procedure: { ...body, description: 'v2' }, procedureId: v1.id };
      },
      repeat: 'conflict: draft_pending',
    },
  },
  // Legacy 679: saving the same profile again rewrites updated_at / updated_by
  // and revokes the person's entry Handles. It should be idempotent; until it is, `repeats`.
  set_agent_profile: {
    "the owner's own": { setUp: async () => ({ promptAddendum: 'Be brief.' }) },
  },
  propose_worker_definition: {
    'a new family': {
      setUp: async () => ({
        kind: 'worker',
        definition: { systemPrompt: 'A worker for the repeat walk.' },
      }),
    },
    // Legacy 680: unlike Skills and Procedures (E2-0, one pending draft a family),
    // a WorkerDefinition family stacks drafts — the second call makes v3 beside a pending v2.
    // As it is: `repeats`; once it is aligned, `conflict: draft_pending`.
    'the next version of a published one': {
      setUp: async (ctx) => ({
        definitionId: (await workerV1(ctx, true)).id,
        kind: 'worker',
        definition: { systemPrompt: 'Version two.' },
      }),
      repeat: 'repeats',
    },
  },
  publish_worker_definition: {
    'a v1 draft': {
      setUp: async (ctx) => ({ definitionId: (await workerV1(ctx, false)).id, version: 1 }),
    },
  },
  deprecate_worker_definition: {
    'a published v1': {
      setUp: async (ctx) => ({ definitionId: (await workerV1(ctx, true)).id, version: 1 }),
    },
  },
  discard_draft: {
    // The discarded draft is gone, so the second call finds no such version.
    'a worker draft': {
      setUp: async (ctx) => ({
        kind: 'worker_definition',
        id: (await workerV1(ctx, false)).id,
        version: 1,
        reason: 'Not needed.',
      }),
    },
    'a Skill draft': {
      setUp: async (ctx) => ({
        kind: 'skill',
        id: (await familyV1(ctx, 'skill', skillBody(), false)).id,
        version: 1,
        reason: 'Not needed.',
      }),
    },
  },
  // Evaluation suites (S10): a suite has one name in a workspace, and every change names the
  // version it was made against — a second identical change finds the suite one version on.
  create_eval_suite: {
    'a published worker': {
      setUp: async (ctx) => ({
        name: 'Restart drills',
        workerDefinitionId: (await workerV1(ctx, true)).id,
        workerDefinitionVersion: 1,
      }),
    },
  },
  repin_eval_suite: {
    'the worker’s v2, published': {
      setUp: async (ctx) => {
        const suite = await evalSuite(ctx, false);
        await as(ctx, 'propose_worker_definition', {
          definitionId: suite.workerId,
          kind: 'worker',
          definition: { systemPrompt: 'Version two.' },
        });
        await as(ctx, 'publish_worker_definition', { definitionId: suite.workerId, version: 2 });
        return {
          suiteId: suite.id,
          suiteVersion: suite.version,
          workerDefinitionVersion: 2,
          reason: 'v2 is the one in use.',
        };
      },
    },
  },
  add_eval_fixture_gate: {
    'the seeded gate': {
      setUp: async (ctx) => {
        await registerSeededGatekeeper(ctx.pool, ctx.seed);
        const suite = await evalSuite(ctx, false);
        return {
          suiteId: suite.id,
          suiteVersion: suite.version,
          gatekeeperId: ctx.seed.gatekeeperId,
        };
      },
    },
  },
  remove_eval_fixture_gate: {
    'the frozen seeded gate': {
      setUp: async (ctx) => {
        const suite = await evalSuite(ctx, true);
        return {
          suiteId: suite.id,
          suiteVersion: suite.version,
          gatekeeperId: ctx.seed.gatekeeperId,
          reason: 'Not needed.',
        };
      },
    },
  },
  add_eval_case: {
    'a case on the frozen gate': {
      setUp: async (ctx) => {
        const suite = await evalSuite(ctx, true);
        return {
          suiteId: suite.id,
          suiteVersion: suite.version,
          partition: 'regression',
          split: 'dev',
          ...evalCase(ctx.seed),
        };
      },
    },
  },
  edit_eval_case: {
    'its one case': {
      setUp: async (ctx) => ({
        ...(await suiteWithCase(ctx)),
        reason: 'Tighter.',
        ...evalCase(ctx.seed),
        title: 'Restart web-1 once',
      }),
    },
  },
  retire_eval_case: {
    'its one case': {
      setUp: async (ctx) => ({ ...(await suiteWithCase(ctx)), reason: 'Obsolete.' }),
    },
  },
  // The seeded gate's one Operation (named after the marker), once the gate is registered.
  update_operation_description: {
    'the seeded Operation': {
      setUp: async ({ pool, seed }) => {
        await registerSeededGatekeeper(pool, seed);
        return { gatekeeperId: seed.gatekeeperId, name: seed.marker, description: 'Lists hosts.' };
      },
    },
  },
  deprecate_operation: {
    'the seeded Operation': {
      setUp: async ({ pool, seed }) => {
        await registerSeededGatekeeper(pool, seed);
        return { gatekeeperId: seed.gatekeeperId, name: seed.marker };
      },
    },
  },
  // A Turn: `send_chat_message` starts one; with no agent runtime wired, `report_turn` (what the
  // entry agent sends at the end) is what ends it.
  report_turn: {
    'a running Turn': {
      setUp: async (ctx) => {
        const sent = await as<{ turnId: string }>(ctx, 'send_chat_message', {
          chatId: ctx.seed.chatId,
          text: 'report back',
        });
        return { turnId: sent.turnId, summary: 'Done.' };
      },
    },
  },
  mark_turn_outcome: {
    'a finished Turn': {
      setUp: async (ctx) => {
        const sent = await as<{ turnId: string }>(ctx, 'send_chat_message', {
          chatId: ctx.seed.chatId,
          text: 'finish, then be judged',
        });
        await as(ctx, 'report_turn', { turnId: sent.turnId, summary: 'Done.' });
        return { turnId: sent.turnId, outcome: 'achieved' };
      },
    },
  },
  get_entry_context: {
    'a running Turn': {
      setUp: async (ctx) => {
        const sent = await as<{ turnId: string }>(ctx, 'send_chat_message', {
          chatId: ctx.seed.chatId,
          text: 'what is going on',
        });
        return { turnId: sent.turnId };
      },
    },
  },
  reject_draft: {
    // The rejected draft is taken off its family, so the second call finds no such version.
    'a pending Skill v2': { setUp: (ctx) => pendingV2(ctx, 'skill') },
    'a pending Procedure v2': { setUp: (ctx) => pendingV2(ctx, 'procedure') },
  },
};

/** Rows whose schema-built params cannot make a first call succeed on the bare seed — a param
 *  naming something the walk has no value for — run their recipes instead of that case. */
const RECIPES_ONLY: ReadonlySet<string> = new Set([
  'grant_capability',
  'connect_gatekeeper',
  'set_principal_role',
  'disable_principal',
  'rotate_api_key',
  'revoke_capability',
  'cancel_connection_request',
  'record_decision',
  'publish_skill',
  'deprecate_skill',
  'publish_procedure',
  'deprecate_procedure',
  'reject_draft',
  'propose_skill',
  'propose_procedure',
  'set_agent_profile',
  'propose_worker_definition',
  'publish_worker_definition',
  'deprecate_worker_definition',
  'discard_draft',
  'create_eval_suite',
  'repin_eval_suite',
  'add_eval_fixture_gate',
  'remove_eval_fixture_gate',
  'add_eval_case',
  'edit_eval_case',
  'retire_eval_case',
  'update_operation_description',
  'deprecate_operation',
  'report_turn',
  'mark_turn_outcome',
  'get_entry_context',
]);

interface Declared {
  readonly capability: Capability;
  readonly repeat: string;
  /** The recipe case this is, or undefined for schema-built params on the bare seed. */
  readonly recipe?: string;
}

function declaredRows(): Declared[] {
  const matrix = parse(readFileSync(MATRIX, 'utf8')) as {
    capabilities: Record<string, { repeat?: string }>;
  };
  const out: Declared[] = [];
  for (const [name, row] of Object.entries(matrix.capabilities)) {
    if (row.repeat === undefined || row.repeat.startsWith('unclear:')) continue;
    const capability = getCapability(name);
    if (capability === undefined) throw new Error(`matrix row ${name} has no capability`);
    const recipes = Object.keys(RECIPES[name] ?? {});
    if (RECIPES_ONLY.has(name) && recipes.length === 0) {
      throw new Error(`matrix row ${name} runs its recipes only, and has none`);
    }
    if (!RECIPES_ONLY.has(name)) out.push({ capability, repeat: row.repeat });
    for (const recipe of recipes) {
      out.push({ capability, repeat: RECIPES[name]?.[recipe]?.repeat ?? row.repeat, recipe });
    }
  }
  return out;
}

/** The entity a result names: its own `id`, or the `id` of its one object-valued field, or else
 *  its one `…Id` field (`rotate_api_key` answers `{ principalId, apiKey }`). */
function entityId(result: unknown): string | undefined {
  if (result === null || typeof result !== 'object') return undefined;
  const record = result as Record<string, unknown>;
  if (typeof record.id === 'string') return record.id;
  const nested = Object.values(record).filter(
    (value): value is Record<string, unknown> =>
      value !== null &&
      typeof value === 'object' &&
      typeof (value as { id?: unknown }).id === 'string',
  );
  if (nested.length === 1) return nested[0]?.id as string;
  if (nested.length > 1) return undefined;
  const ids = Object.entries(record).filter(
    ([key, value]) => key.endsWith('Id') && typeof value === 'string',
  );
  return ids.length === 1 ? (ids[0]?.[1] as string) : undefined;
}

interface AuditRow {
  readonly id: string;
  readonly action: string;
  readonly actor_principal_id: string | null;
  readonly payload: Record<string, unknown>;
}

describe.runIf(DATABASE_URL !== undefined)(
  'a second identical call does what capability-matrix.yaml says — batch D4 / G6 (integration, real Postgres)',
  () => {
    let pool: Pool;

    beforeAll(async () => {
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);
    });

    afterAll(async () => {
      await pool?.end();
    });

    async function rowsBut(workspaceId: string): Promise<Record<string, string>> {
      const { audit_records: _audit, ...rest } = await workspaceDigest(pool, workspaceId);
      return rest;
    }

    async function auditRows(workspaceId: string): Promise<AuditRow[]> {
      const result = await pool.query<AuditRow>(
        'select id, action, actor_principal_id, payload from audit_records where workspace_id = $1',
        [workspaceId],
      );
      return result.rows;
    }

    const declared = declaredRows();

    it('the matrix declares some rows (the walk is not empty)', () => {
      expect(declared.length).toBeGreaterThan(0);
    });

    it.each(
      declared.map(
        (row) =>
          [
            row.recipe === undefined
              ? row.capability.name
              : `${row.capability.name} — ${row.recipe}`,
            row,
          ] as const,
      ),
    )('%s', async (_name, { capability, repeat, recipe }) => {
      expect(capability.scope, 'a platform row needs a platform fixture first').not.toBe(
        'platform',
      );
      const workspace = await newWorkspace(pool, `repeat-${capability.name}`, ['owner', 'member']);
      const ownerId = workspace.principals.get('owner') as string;
      const seed = await seedWorkspace(
        pool,
        workspace.workspaceId,
        ownerId,
        `repeat-${randomUUID()}`,
      );
      const caller = humanCaller(workspace.workspaceId, ownerId, 'owner');
      const chosen = recipe === undefined ? undefined : RECIPES[capability.name]?.[recipe];
      const params =
        chosen === undefined
          ? paramsFor(capability.paramsSchema, seed)
          : await chosen.setUp({
              pool,
              caller,
              seed,
              memberId: workspace.principals.get('member') as string,
            });
      const call = () => dispatchCapability({ pool }, caller, capability.name, params);

      let first: unknown;
      try {
        first = await call();
      } catch (error) {
        throw new Error(
          `${capability.name} declares repeat: ${repeat}, but its first call failed (${String(error)}) — fix the recipe or add one to RECIPES, or declare it unclear`,
        );
      }
      if (chosen?.first !== undefined) expect(first).toEqual(chosen.first);
      const rowsAfterFirst = await rowsBut(workspace.workspaceId);
      const auditAfterFirst = new Set(
        (await auditRows(workspace.workspaceId)).map((row) => row.id),
      );

      let second: unknown;
      let refusal: unknown;
      try {
        second = await call();
      } catch (error) {
        refusal = error;
      }
      const rowsAfterSecond = await rowsBut(workspace.workspaceId);
      const newAudit = (await auditRows(workspace.workspaceId)).filter(
        (row) => !auditAfterFirst.has(row.id),
      );

      if (repeat.startsWith('conflict: ')) {
        expect(refusal, 'the second call must be refused').toBeDefined();
        const mapped = mapCapabilityError(refusal);
        expect(mapped.code).toBe(repeat.slice('conflict: '.length));
        expect(mapped.status).toBeGreaterThanOrEqual(400);
        expect(mapped.status).toBeLessThan(500);
        expect(rowsAfterSecond).toEqual(rowsAfterFirst);
        expect(newAudit.filter((row) => row.payload.outcome !== 'refused')).toEqual([]);
        return;
      }

      expect(refusal, 'the second call must succeed').toBeUndefined();
      if (repeat === 'idempotent') {
        const firstId = entityId(first);
        if (firstId !== undefined) expect(entityId(second)).toBe(firstId);
        expect(rowsAfterSecond).toEqual(rowsAfterFirst);
        expect(newAudit.map((row) => row.action)).toEqual([capability.name]);
        expect(newAudit[0]?.actor_principal_id).toBe(ownerId);
      } else if (repeat === 'creates') {
        const firstId = entityId(first);
        expect(firstId, 'creates: the result names the entity it made').toBeDefined();
        expect(entityId(second)).not.toBe(firstId);
        // A new id with nothing stored for it would not be a second entity (per #488).
        expect(rowsAfterSecond).not.toEqual(rowsAfterFirst);
      } else if (repeat === 'repeats') {
        const firstId = entityId(first);
        expect(firstId, 'repeats: the result names the entity it acted on').toBeDefined();
        expect(entityId(second)).toBe(firstId);
        expect(rowsAfterSecond).not.toEqual(rowsAfterFirst);
      } else {
        throw new Error(`unknown repeat declaration ${repeat} (guard M6 should have refused it)`);
      }
    });
  },
);
