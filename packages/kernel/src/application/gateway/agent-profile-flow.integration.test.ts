import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Role } from '@nexttime/shared';
import { generateKeyPair } from 'jose';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { entryScope, grantCapability, issueHandle } from '../../governance/capability/index.js';
import { HANDLE_SIGNING_ALG } from '../../governance/capability/keys.js';
import { registerGatekeeper } from '../../governance/gatekeepers/index.js';
import { startActivity } from '../../substrate/epistemic/index.js';
import { proposeSkill, publishSkill } from '../worker/index.js';
import { AgentProfileValidationError } from './agent-profile-handlers.js';
import { hashApiKey } from './auth.js';
import { ForbiddenError } from './authorize.js';
import { dispatchCapability } from './dispatch.js';
import { authenticateHandle } from './handle-auth.js';
import { PrincipalNotFoundError } from './members-handlers.js';
import type { ResolvedCaller } from './resolve-caller.js';

/**
 * application/gateway/agent-profile-flow.integration.test: DB-gated (real Postgres; auto-skip
 * without DATABASE_URL, same `describe.runIf` pattern `members-flow.integration.test.ts`/
 * `connection-flow.integration.test.ts` already use) end-to-end coverage for the S3.13
 * capabilities (docs/development-tasks.md "每用户智能体配置"): `get_agent_profile`/
 * `set_agent_profile`/`get_agent_policy`/`set_agent_policy` — defaults, the write-side validation
 * matrix, authorization (self vs. another principal, `memberCanEditProfile`), effective
 * resolution (policy defaults/caps applied), and revoke-on-change (the target's entry Handle is
 * revoked in the same transaction as the write).
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

function humanCaller(workspaceId: string, principalId: string, role: Role): ResolvedCaller {
  return {
    channel: 'human',
    principal: { workspaceId, id: principalId, kind: 'human', role, displayName: null },
    session: {
      workspaceId,
      id: randomUUID(),
      principalId,
      kind: 'web',
      onBehalfOf: principalId,
      status: 'active',
      createdAt: new Date(),
      expiresAt: null,
    },
  };
}

interface WireAgentProfile {
  readonly principalId: string;
  readonly model: string | null;
  readonly enabledSkills: readonly string[] | null;
  readonly enabledGatekeepers: readonly string[] | null;
  readonly enabledWorkerDefinitions: readonly string[] | null;
  readonly promptAddendum: string | null;
  readonly autoApproveLow: boolean | null;
  readonly updatedAt: string | null;
  readonly updatedBy: string | null;
  /** Always concrete (never `null`) — `null` (inherit) on any raw list field above resolves to
   *  "every currently available resource" here, not to nothing (`governance/agent-profile/
   *  resolve.ts`'s own doc comment) — the already-shipped web console's `EffectivePanel` renders
   *  every one of these fields, including a `.length` call on each list, so a `null` here would
   *  break it. */
  readonly effective: {
    readonly model: string;
    readonly enabledSkills: readonly string[];
    readonly enabledGatekeepers: readonly string[];
    readonly enabledWorkerDefinitions: readonly string[];
    readonly promptAddendum: string;
    readonly autoApproveLow: boolean;
  };
}

interface WireAgentPolicy {
  readonly workspaceId: string;
  readonly allowedModels: readonly string[];
  readonly defaultModel: string | null;
  readonly memberCanEditProfile: boolean;
  readonly maxPromptAddendumChars: number;
  readonly allowedSkills: readonly string[];
  readonly allowedGatekeepers: readonly string[];
  readonly allowMemberAutoApproveLow: boolean;
  readonly updatedAt: string | null;
  readonly updatedBy: string | null;
}

describe.runIf(DATABASE_URL !== undefined)(
  'S3.13 AgentProfile/AgentPolicy capabilities (integration, real Postgres)',
  () => {
    let pool: Pool;
    let workspaceId: string;
    let ownerId: string;
    let modelsJsonDir: string | undefined;
    const originalModelsJsonFile = process.env.MODELS_JSON_FILE;

    async function adminInsertWorkspace(name: string): Promise<string> {
      const id = randomUUID();
      await withWorkspace(
        pool,
        { workspaceId: id, principalId: randomUUID() },
        async (client) => {
          await client.query('insert into workspaces (id, name) values ($1, $2)', [id, name]);
        },
        { skipRoleSwitch: true },
      );
      return id;
    }

    async function adminInsertPrincipal(
      ws: string,
      role: string,
      displayName: string,
      kind: 'human' | 'agent' | 'service' = 'human',
      apiKey?: string,
    ): Promise<string> {
      const id = randomUUID();
      await withWorkspace(
        pool,
        { workspaceId: ws, principalId: id },
        async (client) => {
          await client.query(
            `insert into principals (workspace_id, id, kind, role, display_name, api_key_hash)
             values ($1, $2, $3, $4, $5, $6)`,
            [ws, id, kind, role, displayName, apiKey ? hashApiKey(apiKey) : null],
          );
        },
        { skipRoleSwitch: true },
      );
      return id;
    }

    /** Publishes one Skill (workspace-wide) — for `enabledSkills` validation fixtures. */
    async function publishTestSkill(
      ws: string,
      byPrincipalId: string,
      name: string,
    ): Promise<string> {
      return withWorkspace(
        pool,
        { workspaceId: ws, principalId: byPrincipalId },
        async (client) => {
          const proposed = await proposeSkill(client, ws, byPrincipalId, {
            name,
            description: `${name} description`,
            markdown: `# ${name}\n\nbody`,
          });
          const published = await publishSkill(client, ws, byPrincipalId, proposed.id);
          return published.id;
        },
      );
    }

    /** Registers one Gatekeeper — for `enabledGatekeepers` validation fixtures. */
    async function registerTestGatekeeper(
      ws: string,
      byPrincipalId: string,
      name: string,
    ): Promise<string> {
      return withWorkspace(
        pool,
        { workspaceId: ws, principalId: byPrincipalId },
        async (client) => {
          const activity = await startActivity(client, ws, {
            kind: 'test.register_gatekeeper',
            principalId: byPrincipalId,
          });
          const { gatekeeperId } = await registerGatekeeper(client, ws, {
            name,
            transportKind: 'http',
            target: `agent-profile-test-${name}`,
            endpoint: `https://gate.agent-profile-test.invalid/${name}`,
            activityId: activity.id,
            registeredBy: { id: byPrincipalId, kind: 'human' },
          });
          return gatekeeperId;
        },
      );
    }

    /** Grants `principalId` a `'gatekeeper'`-resource-type Grant for `gatekeeperId`. */
    async function grantGatekeeper(
      ws: string,
      grantedBy: string,
      principalId: string,
      gatekeeperId: string,
    ): Promise<void> {
      await withWorkspace(pool, { workspaceId: ws, principalId: grantedBy }, (client) =>
        grantCapability(client, ws, {
          principalId,
          resourceType: 'gatekeeper',
          resourceId: gatekeeperId,
          grantedBy,
        }),
      );
    }

    /** Sets up an `entry` session + a real, verifiable Handle for `principalId` — same shape
     *  `members-flow.integration.test.ts`'s own `issueEntryHandle` uses for `disable_principal`'s
     *  Handle-revocation assertion; `set_agent_profile`'s own revoke-on-change needs the identical
     *  observation. */
    async function issueEntryHandle(
      ws: string,
      principalId: string,
      keyPair: Awaited<ReturnType<typeof generateKeyPair>>,
    ): Promise<{ token: string; jti: string }> {
      return withWorkspace(
        pool,
        { workspaceId: ws, principalId },
        async (client) => {
          const sessionResult = await client.query<{ id: string }>(
            `insert into sessions (workspace_id, principal_id, kind, on_behalf_of, status)
             values ($1, $2, 'entry', $2, 'active') returning id`,
            [ws, principalId],
          );
          const sessionId = sessionResult.rows[0]?.id;
          if (!sessionId) throw new Error('issueEntryHandle: failed to insert entry session');
          const issued = await issueHandle(client, {
            sessionId,
            scope: entryScope(),
            ttlSeconds: 3600,
            privateKey: keyPair.privateKey,
          });
          return { token: issued.token, jti: issued.jti };
        },
        { skipRoleSwitch: true },
      );
    }

    beforeAll(async () => {
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);
      workspaceId = await adminInsertWorkspace('agent-profile-flow-test-workspace');
      ownerId = await adminInsertPrincipal(workspaceId, 'owner', 'owner');

      // list_models / set_agent_profile's model validation both read models.json — seed a fixture
      // for the whole describe block (same convention members-flow.integration.test.ts's own
      // list_models describe block uses, just hoisted to beforeAll since every model-validation
      // test in this file needs the identical fixture).
      modelsJsonDir = await mkdtemp(join(tmpdir(), 'agent-profile-models-json-'));
      const file = join(modelsJsonDir, 'models.json');
      await writeFile(
        file,
        JSON.stringify({
          providers: {
            anthropic: {
              baseUrl: 'http://llm-proxy:8082/anthropic',
              apiKey: '$CAPABILITY_HANDLE',
              api: 'anthropic-messages',
              models: [{ id: 'claude-sonnet-5' }, { id: 'claude-haiku-5' }],
            },
          },
        }),
      );
      process.env.MODELS_JSON_FILE = file;
    });

    afterAll(async () => {
      if (modelsJsonDir) await rm(modelsJsonDir, { recursive: true, force: true });
      if (originalModelsJsonFile === undefined) {
        // biome-ignore lint/performance/noDelete: process.env coerces `= undefined` to the string "undefined" instead of unsetting the var; delete is the only way to make it actually absent.
        delete process.env.MODELS_JSON_FILE;
      } else {
        process.env.MODELS_JSON_FILE = originalModelsJsonFile;
      }
      await pool.end();
    });

    describe('get_agent_profile', () => {
      it('defaults: no row for a fresh principal in a fresh workspace — every raw field null, effective resolves to concrete "nothing configured" values', async () => {
        // Isolated workspace (not the shared top-level one) so "nothing currently available" is
        // actually true — the shared workspace accumulates published Skills/Gatekeepers from
        // other tests in this file.
        const freshWs = await adminInsertWorkspace('agent-profile-flow-defaults-workspace');
        const memberId = await adminInsertPrincipal(freshWs, 'member', 'Alice');
        const member = humanCaller(freshWs, memberId, 'member');

        const profile = (await dispatchCapability(
          { pool },
          member,
          'get_agent_profile',
          {},
        )) as WireAgentProfile;

        expect(profile.principalId).toBe(memberId);
        expect(profile.model).toBeNull();
        expect(profile.enabledSkills).toBeNull();
        expect(profile.enabledGatekeepers).toBeNull();
        expect(profile.enabledWorkerDefinitions).toBeNull();
        expect(profile.promptAddendum).toBeNull();
        expect(profile.autoApproveLow).toBeNull();
        expect(profile.updatedAt).toBeNull();
        expect(profile.updatedBy).toBeNull();
        // Always concrete — never null — see WireAgentProfile's own doc comment.
        expect(profile.effective).toEqual({
          model: '',
          enabledSkills: [],
          enabledGatekeepers: [],
          enabledWorkerDefinitions: [],
          promptAddendum: '',
          autoApproveLow: false,
        });
      });

      it('effective.enabledSkills/enabledGatekeepers resolve to "everything currently available" when the profile sets none — not to an empty list', async () => {
        const availWs = await adminInsertWorkspace('agent-profile-flow-available-workspace');
        const availOwnerId = await adminInsertPrincipal(availWs, 'owner', 'AvailOwner');
        const memberId = await adminInsertPrincipal(availWs, 'member', 'AvailMember');
        const member = humanCaller(availWs, memberId, 'member');

        const skillId = await publishTestSkill(
          availWs,
          availOwnerId,
          `avail-skill-${randomUUID()}`,
        );
        const gatekeeperId = await registerTestGatekeeper(
          availWs,
          availOwnerId,
          `avail-gate-${randomUUID()}`,
        );
        await grantGatekeeper(availWs, availOwnerId, memberId, gatekeeperId);

        const profile = (await dispatchCapability(
          { pool },
          member,
          'get_agent_profile',
          {},
        )) as WireAgentProfile;

        // The raw fields are still null (never touched) — only `effective` resolves the ceiling.
        expect(profile.enabledSkills).toBeNull();
        expect(profile.enabledGatekeepers).toBeNull();
        expect(profile.effective.enabledSkills).toEqual([skillId]);
        expect(profile.effective.enabledGatekeepers).toEqual([gatekeeperId]);
      });

      it('a member may read their own profile with no principalId given', async () => {
        const memberId = await adminInsertPrincipal(workspaceId, 'member', 'Bob');
        const member = humanCaller(workspaceId, memberId, 'member');

        const profile = (await dispatchCapability(
          { pool },
          member,
          'get_agent_profile',
          {},
        )) as WireAgentProfile;
        expect(profile.principalId).toBe(memberId);
      });

      it('a member may not read another principal’s profile (403)', async () => {
        const memberId = await adminInsertPrincipal(workspaceId, 'member', 'Carol');
        const otherId = await adminInsertPrincipal(workspaceId, 'member', 'Dan');
        const member = humanCaller(workspaceId, memberId, 'member');

        await expect(
          dispatchCapability({ pool }, member, 'get_agent_profile', { principalId: otherId }),
        ).rejects.toThrow(ForbiddenError);
      });

      it('an owner may read any principal’s profile', async () => {
        const memberId = await adminInsertPrincipal(workspaceId, 'member', 'Eve');
        const owner = humanCaller(workspaceId, ownerId, 'owner');

        const profile = (await dispatchCapability({ pool }, owner, 'get_agent_profile', {
          principalId: memberId,
        })) as WireAgentProfile;
        expect(profile.principalId).toBe(memberId);
      });

      it('a nonexistent principalId → PrincipalNotFoundError (404 family)', async () => {
        const owner = humanCaller(workspaceId, ownerId, 'owner');
        await expect(
          dispatchCapability({ pool }, owner, 'get_agent_profile', { principalId: randomUUID() }),
        ).rejects.toThrow(PrincipalNotFoundError);
      });
    });

    describe('set_agent_profile — write + get roundtrip', () => {
      it('a member may set their own promptAddendum; get reflects it and effective passes it through', async () => {
        const memberId = await adminInsertPrincipal(workspaceId, 'member', 'Frank');
        const member = humanCaller(workspaceId, memberId, 'member');

        const updated = (await dispatchCapability({ pool }, member, 'set_agent_profile', {
          promptAddendum: 'Prefer concise answers.',
        })) as WireAgentProfile;
        expect(updated.promptAddendum).toBe('Prefer concise answers.');
        expect(updated.updatedBy).toBe(memberId);
        expect(updated.updatedAt).not.toBeNull();
        expect(updated.effective.promptAddendum).toBe('Prefer concise answers.');

        const fetched = (await dispatchCapability(
          { pool },
          member,
          'get_agent_profile',
          {},
        )) as WireAgentProfile;
        expect(fetched.promptAddendum).toBe('Prefer concise answers.');
      });

      it('an explicit null resets a field back to inherit', async () => {
        const memberId = await adminInsertPrincipal(workspaceId, 'member', 'Grace');
        const member = humanCaller(workspaceId, memberId, 'member');

        await dispatchCapability({ pool }, member, 'set_agent_profile', {
          promptAddendum: 'first value',
        });
        const reset = (await dispatchCapability({ pool }, member, 'set_agent_profile', {
          promptAddendum: null,
        })) as WireAgentProfile;
        expect(reset.promptAddendum).toBeNull();
      });

      it('an omitted field leaves the existing value untouched (partial update)', async () => {
        const memberId = await adminInsertPrincipal(workspaceId, 'member', 'Heidi');
        const member = humanCaller(workspaceId, memberId, 'member');

        await dispatchCapability({ pool }, member, 'set_agent_profile', {
          promptAddendum: 'keep me',
          autoApproveLow: false,
        });
        const updated = (await dispatchCapability({ pool }, member, 'set_agent_profile', {
          autoApproveLow: null,
        })) as WireAgentProfile;
        expect(updated.promptAddendum).toBe('keep me'); // untouched by the second call
        expect(updated.autoApproveLow).toBeNull(); // reset
      });

      it('model: accepts a model in the llm-proxy whitelist', async () => {
        const memberId = await adminInsertPrincipal(workspaceId, 'member', 'Ivan');
        const member = humanCaller(workspaceId, memberId, 'member');

        const updated = (await dispatchCapability({ pool }, member, 'set_agent_profile', {
          model: 'anthropic/claude-sonnet-5',
        })) as WireAgentProfile;
        expect(updated.model).toBe('anthropic/claude-sonnet-5');
        expect(updated.effective.model).toBe('anthropic/claude-sonnet-5');
      });

      it('model: 400 invalid_params for a model not in the llm-proxy whitelist', async () => {
        const memberId = await adminInsertPrincipal(workspaceId, 'member', 'Judy');
        const member = humanCaller(workspaceId, memberId, 'member');

        await expect(
          dispatchCapability({ pool }, member, 'set_agent_profile', {
            model: 'nonexistent-provider/nonexistent-model',
          }),
        ).rejects.toThrow(AgentProfileValidationError);
      });

      it('enabledSkills: accepts a published Skill by id, rejects an unpublished/unknown one', async () => {
        const memberId = await adminInsertPrincipal(workspaceId, 'member', 'Kevin');
        const member = humanCaller(workspaceId, memberId, 'member');
        const skillId = await publishTestSkill(
          workspaceId,
          ownerId,
          `writing-tips-${randomUUID()}`,
        );

        const updated = (await dispatchCapability({ pool }, member, 'set_agent_profile', {
          enabledSkills: [skillId],
        })) as WireAgentProfile;
        expect(updated.enabledSkills).toEqual([skillId]);

        await expect(
          dispatchCapability({ pool }, member, 'set_agent_profile', {
            enabledSkills: [randomUUID()],
          }),
        ).rejects.toThrow(AgentProfileValidationError);
      });

      it('enabledGatekeepers: accepts a Gatekeeper the principal holds a Grant for, rejects an ungranted one', async () => {
        const memberId = await adminInsertPrincipal(workspaceId, 'member', 'Laura');
        const member = humanCaller(workspaceId, memberId, 'member');
        const gatekeeperId = await registerTestGatekeeper(
          workspaceId,
          ownerId,
          `gate-${randomUUID()}`,
        );

        await expect(
          dispatchCapability({ pool }, member, 'set_agent_profile', {
            enabledGatekeepers: [gatekeeperId],
          }),
        ).rejects.toThrow(AgentProfileValidationError);

        await grantGatekeeper(workspaceId, ownerId, memberId, gatekeeperId);
        const updated = (await dispatchCapability({ pool }, member, 'set_agent_profile', {
          enabledGatekeepers: [gatekeeperId],
        })) as WireAgentProfile;
        expect(updated.enabledGatekeepers).toEqual([gatekeeperId]);
      });

      it('enabledGatekeepers: an owner target may select any registered Gatekeeper without an explicit Grant (I14 owner override)', async () => {
        const secondOwnerId = await adminInsertPrincipal(workspaceId, 'owner', 'Owner Two');
        const owner = humanCaller(workspaceId, ownerId, 'owner');
        const gatekeeperId = await registerTestGatekeeper(
          workspaceId,
          ownerId,
          `owner-gate-${randomUUID()}`,
        );

        const updated = (await dispatchCapability({ pool }, owner, 'set_agent_profile', {
          principalId: secondOwnerId,
          enabledGatekeepers: [gatekeeperId],
        })) as WireAgentProfile;
        expect(updated.enabledGatekeepers).toEqual([gatekeeperId]);
      });

      it('authorization: a member editing another principal → 403', async () => {
        const memberId = await adminInsertPrincipal(workspaceId, 'member', 'Mallory');
        const otherId = await adminInsertPrincipal(workspaceId, 'member', 'Nathan');
        const member = humanCaller(workspaceId, memberId, 'member');

        await expect(
          dispatchCapability({ pool }, member, 'set_agent_profile', {
            principalId: otherId,
            promptAddendum: 'hijack attempt',
          }),
        ).rejects.toThrow(ForbiddenError);
      });

      it('authorization: an owner may edit any principal’s profile', async () => {
        const memberId = await adminInsertPrincipal(workspaceId, 'member', 'Oscar');
        const owner = humanCaller(workspaceId, ownerId, 'owner');

        const updated = (await dispatchCapability({ pool }, owner, 'set_agent_profile', {
          principalId: memberId,
          promptAddendum: 'set by owner',
        })) as WireAgentProfile;
        expect(updated.promptAddendum).toBe('set by owner');
      });

      it('a nonexistent principalId → PrincipalNotFoundError', async () => {
        const owner = humanCaller(workspaceId, ownerId, 'owner');
        await expect(
          dispatchCapability({ pool }, owner, 'set_agent_profile', {
            principalId: randomUUID(),
            promptAddendum: 'x',
          }),
        ).rejects.toThrow(PrincipalNotFoundError);
      });
    });

    describe('set_agent_profile — AgentPolicy-gated validation', () => {
      it('memberCanEditProfile=false: a member editing their own profile → 403; an owner still may', async () => {
        const policyWs = await adminInsertWorkspace('agent-profile-policy-workspace-1');
        const policyOwnerId = await adminInsertPrincipal(policyWs, 'owner', 'PolicyOwner1');
        const memberId = await adminInsertPrincipal(policyWs, 'member', 'Peggy');
        const owner = humanCaller(policyWs, policyOwnerId, 'owner');
        const member = humanCaller(policyWs, memberId, 'member');

        await dispatchCapability({ pool }, owner, 'set_agent_policy', {
          memberCanEditProfile: false,
        });

        await expect(
          dispatchCapability({ pool }, member, 'set_agent_profile', { promptAddendum: 'x' }),
        ).rejects.toThrow(ForbiddenError);

        const byOwner = (await dispatchCapability({ pool }, owner, 'set_agent_profile', {
          principalId: memberId,
          promptAddendum: 'set by owner despite the policy',
        })) as WireAgentProfile;
        expect(byOwner.promptAddendum).toBe('set by owner despite the policy');
      });

      it('maxPromptAddendumChars: rejects an addendum over the workspace cap', async () => {
        const policyWs = await adminInsertWorkspace('agent-profile-policy-workspace-2');
        const policyOwnerId = await adminInsertPrincipal(policyWs, 'owner', 'PolicyOwner2');
        const memberId = await adminInsertPrincipal(policyWs, 'member', 'Quentin');
        const owner = humanCaller(policyWs, policyOwnerId, 'owner');
        const member = humanCaller(policyWs, memberId, 'member');

        await dispatchCapability({ pool }, owner, 'set_agent_policy', {
          maxPromptAddendumChars: 10,
        });

        await expect(
          dispatchCapability({ pool }, member, 'set_agent_profile', {
            promptAddendum: 'this is definitely over ten characters',
          }),
        ).rejects.toThrow(AgentProfileValidationError);

        const ok = (await dispatchCapability({ pool }, member, 'set_agent_profile', {
          promptAddendum: 'short',
        })) as WireAgentProfile;
        expect(ok.promptAddendum).toBe('short');
      });

      it('allowMemberAutoApproveLow=false: rejects autoApproveLow:true', async () => {
        const policyWs = await adminInsertWorkspace('agent-profile-policy-workspace-3');
        const policyOwnerId = await adminInsertPrincipal(policyWs, 'owner', 'PolicyOwner3');
        const memberId = await adminInsertPrincipal(policyWs, 'member', 'Rupert');
        const owner = humanCaller(policyWs, policyOwnerId, 'owner');
        const member = humanCaller(policyWs, memberId, 'member');

        // Compiled-in default is already false — confirm the rejection with no policy row too.
        await expect(
          dispatchCapability({ pool }, member, 'set_agent_profile', { autoApproveLow: true }),
        ).rejects.toThrow(AgentProfileValidationError);

        await dispatchCapability({ pool }, owner, 'set_agent_policy', {
          allowMemberAutoApproveLow: true,
        });
        const ok = (await dispatchCapability({ pool }, member, 'set_agent_profile', {
          autoApproveLow: true,
        })) as WireAgentProfile;
        expect(ok.autoApproveLow).toBe(true);

        // autoApproveLow:false always allowed, regardless of the policy.
        const narrowed = (await dispatchCapability({ pool }, member, 'set_agent_profile', {
          autoApproveLow: false,
        })) as WireAgentProfile;
        expect(narrowed.autoApproveLow).toBe(false);
      });

      it('allowedModels: narrows the effective model whitelist beyond the raw llm-proxy list', async () => {
        const policyWs = await adminInsertWorkspace('agent-profile-policy-workspace-4');
        const policyOwnerId = await adminInsertPrincipal(policyWs, 'owner', 'PolicyOwner4');
        const memberId = await adminInsertPrincipal(policyWs, 'member', 'Sybil');
        const owner = humanCaller(policyWs, policyOwnerId, 'owner');
        const member = humanCaller(policyWs, memberId, 'member');

        // P-A2: a non-empty allow-list must come with a defaultModel that is in it — the same
        // rule the platform plane's `set_allowed_models` enforces (`modelPolicyViolation`).
        await expect(
          dispatchCapability({ pool }, owner, 'set_agent_policy', {
            allowedModels: ['anthropic/claude-haiku-5'],
          }),
        ).rejects.toThrow(AgentProfileValidationError);
        await expect(
          dispatchCapability({ pool }, owner, 'set_agent_policy', {
            allowedModels: ['anthropic/claude-haiku-5'],
            defaultModel: 'anthropic/claude-sonnet-5',
          }),
        ).rejects.toThrow(AgentProfileValidationError);
        await expect(
          dispatchCapability({ pool }, owner, 'set_agent_policy', {
            allowedModels: ['anthropic/not-in-catalog'],
            defaultModel: 'anthropic/not-in-catalog',
          }),
        ).rejects.toThrow(AgentProfileValidationError);
        await dispatchCapability({ pool }, owner, 'set_agent_policy', {
          allowedModels: ['anthropic/claude-haiku-5'],
          defaultModel: 'anthropic/claude-haiku-5',
        });
        // …and once restricted, the owner cannot move the defaultModel outside the list either.
        await expect(
          dispatchCapability({ pool }, owner, 'set_agent_policy', {
            defaultModel: 'anthropic/claude-sonnet-5',
          }),
        ).rejects.toThrow(AgentProfileValidationError);

        // Listed by llm-proxy, but not in this workspace's own AgentPolicy.allowedModels.
        await expect(
          dispatchCapability({ pool }, member, 'set_agent_profile', {
            model: 'anthropic/claude-sonnet-5',
          }),
        ).rejects.toThrow(AgentProfileValidationError);

        const ok = (await dispatchCapability({ pool }, member, 'set_agent_profile', {
          model: 'anthropic/claude-haiku-5',
        })) as WireAgentProfile;
        expect(ok.model).toBe('anthropic/claude-haiku-5');
      });

      it('allowedSkills/allowedGatekeepers cap the effective set without rejecting the write itself', async () => {
        const policyWs = await adminInsertWorkspace('agent-profile-policy-workspace-5');
        const policyOwnerId = await adminInsertPrincipal(policyWs, 'owner', 'PolicyOwner5');
        const memberId = await adminInsertPrincipal(policyWs, 'member', 'Trent');
        const owner = humanCaller(policyWs, policyOwnerId, 'owner');
        const member = humanCaller(policyWs, memberId, 'member');

        const skillA = await publishTestSkill(policyWs, policyOwnerId, `skill-a-${randomUUID()}`);
        const skillB = await publishTestSkill(policyWs, policyOwnerId, `skill-b-${randomUUID()}`);

        await dispatchCapability({ pool }, owner, 'set_agent_policy', {
          allowedSkills: [skillA],
        });

        // The write itself succeeds — enabledSkills is validated against published Skills, not
        // the policy cap (that cap only narrows the *effective* resolution).
        const updated = (await dispatchCapability({ pool }, member, 'set_agent_profile', {
          enabledSkills: [skillA, skillB],
        })) as WireAgentProfile;
        expect(updated.enabledSkills).toEqual([skillA, skillB]);
        // But the resolved effective value is capped to what the policy allows.
        expect(updated.effective.enabledSkills).toEqual([skillA]);
      });
    });

    describe('get_agent_policy / set_agent_policy', () => {
      it('get_agent_policy: compiled-in defaults when no row has ever been written', async () => {
        const policyWs = await adminInsertWorkspace('agent-profile-policy-workspace-defaults');
        const policyOwnerId = await adminInsertPrincipal(policyWs, 'owner', 'PolicyOwnerDefaults');
        const memberId = await adminInsertPrincipal(policyWs, 'member', 'MemberReader');
        const member = humanCaller(policyWs, memberId, 'member');

        const policy = (await dispatchCapability(
          { pool },
          humanCaller(policyWs, policyOwnerId, 'owner'),
          'get_agent_policy',
          {},
        )) as WireAgentPolicy;
        expect(policy).toMatchObject({
          workspaceId: policyWs,
          allowedModels: [],
          defaultModel: null,
          memberCanEditProfile: true,
          maxPromptAddendumChars: 2000,
          allowedSkills: [],
          allowedGatekeepers: [],
          allowMemberAutoApproveLow: false,
          updatedAt: null,
          updatedBy: null,
        });
        // Any authenticated role (member included, per registry minRole) may read it.
        const memberRead = (await dispatchCapability(
          { pool },
          member,
          'get_agent_policy',
          {},
        )) as WireAgentPolicy;
        expect(memberRead.workspaceId).toBe(policyWs);
      });

      it('set_agent_policy: a partial update leaves other fields unchanged; records updatedBy/updatedAt', async () => {
        const policyWs = await adminInsertWorkspace('agent-profile-policy-workspace-partial');
        const policyOwnerId = await adminInsertPrincipal(policyWs, 'owner', 'PolicyOwnerPartial');
        const owner = humanCaller(policyWs, policyOwnerId, 'owner');

        const first = (await dispatchCapability({ pool }, owner, 'set_agent_policy', {
          maxPromptAddendumChars: 500,
        })) as WireAgentPolicy;
        expect(first.maxPromptAddendumChars).toBe(500);
        expect(first.memberCanEditProfile).toBe(true); // untouched default
        expect(first.updatedBy).toBe(policyOwnerId);
        expect(first.updatedAt).not.toBeNull();

        const second = (await dispatchCapability({ pool }, owner, 'set_agent_policy', {
          memberCanEditProfile: false,
        })) as WireAgentPolicy;
        expect(second.maxPromptAddendumChars).toBe(500); // still 500 — untouched by this call
        expect(second.memberCanEditProfile).toBe(false);
      });

      it('set_agent_policy: a non-owner is refused at the registry level (403, minRole: owner)', async () => {
        const policyWs = await adminInsertWorkspace('agent-profile-policy-workspace-nonowner');
        const memberId = await adminInsertPrincipal(policyWs, 'member', 'NonOwner');
        const member = humanCaller(policyWs, memberId, 'member');

        await expect(
          dispatchCapability({ pool }, member, 'set_agent_policy', { maxPromptAddendumChars: 1 }),
        ).rejects.toThrow(ForbiddenError);
      });
    });

    describe('set_agent_profile — change propagation (revoke-on-change)', () => {
      it('revokes the target principal’s entry-session Handle in the same call', async () => {
        const memberId = await adminInsertPrincipal(workspaceId, 'member', 'Uma');
        const keyPair = await generateKeyPair(HANDLE_SIGNING_ALG, {
          crv: 'Ed25519',
          extractable: true,
        });
        const { token, jti } = await issueEntryHandle(workspaceId, memberId, keyPair);

        // Sanity: the Handle verifies before the profile change.
        await expect(
          authenticateHandle(pool, token, { publicKey: keyPair.publicKey }),
        ).resolves.toMatchObject({ obo: memberId });

        const member = humanCaller(workspaceId, memberId, 'member');
        await dispatchCapability({ pool }, member, 'set_agent_profile', {
          promptAddendum: 'trigger a revoke',
        });

        const revokedRow = await pool.query<{ revoked_at: Date | null }>(
          'select revoked_at from capability_handles where jti = $1',
          [jti],
        );
        expect(revokedRow.rows[0]?.revoked_at).not.toBeNull();
      });

      it('an owner changing another principal’s profile revokes that principal’s Handle, not the owner’s own', async () => {
        const memberId = await adminInsertPrincipal(workspaceId, 'member', 'Victor');
        const keyPair = await generateKeyPair(HANDLE_SIGNING_ALG, {
          crv: 'Ed25519',
          extractable: true,
        });
        const memberHandle = await issueEntryHandle(workspaceId, memberId, keyPair);
        const ownerHandle = await issueEntryHandle(workspaceId, ownerId, keyPair);

        const owner = humanCaller(workspaceId, ownerId, 'owner');
        await dispatchCapability({ pool }, owner, 'set_agent_profile', {
          principalId: memberId,
          promptAddendum: 'owner-driven change',
        });

        const memberRow = await pool.query<{ revoked_at: Date | null }>(
          'select revoked_at from capability_handles where jti = $1',
          [memberHandle.jti],
        );
        expect(memberRow.rows[0]?.revoked_at).not.toBeNull();

        const ownerRow = await pool.query<{ revoked_at: Date | null }>(
          'select revoked_at from capability_handles where jti = $1',
          [ownerHandle.jti],
        );
        expect(ownerRow.rows[0]?.revoked_at).toBeNull(); // the owner's own Handle is untouched
      });
    });
  },
);
