import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { WorkerDefinitionKind } from '@nexttime/shared';
import { parse as parseYaml } from 'yaml';
import type { PoolLike } from '../../adapters/db/pool.js';
import { withWorkspace } from '../../adapters/db/pool.js';
import { setAgentPolicy } from '../../governance/agent-profile/index.js';
import { ONTOLOGY_ENFORCEMENT_VALUES } from '../../substrate/graph/index.js';
import type { OntologyEnforcement } from '../../substrate/graph/index.js';
import { resolveOntologyDir, seedPlatformMetaOntology } from '../../substrate/ontology/index.js';
import { generateApiKey, hashApiKey } from '../gateway/auth.js';
import { ensureUserForHumanPrincipal } from '../identity/users.js';
import { installOrUpgradeModule, loadModuleRegistry } from '../platform/modules.js';
import { proposeWorkerDefinition, publishWorkerDefinition } from '../worker/index.js';

/**
 * application/workspace/create: creating a Workspace — one transaction that inserts the row and
 * its first `owner` Principal, links that Principal to a platform user, seeds the platform
 * meta-ontology (§5.1.2) and publishes the v1 entry WorkerDefinition (S2.6). Lifted out of
 * `cli/bootstrap.ts` for P-A1 (docs/platform-admin-design.md §4 "全新安装时 kernel 启动即建默认
 * 工作区") so the CLI, the kernel's first start, and P-A2's `create_workspace` capability all run
 * the same code. The CLI keeps its "print the owner's API key once" contract by asking for
 * `issueApiKey: true`; the default workspace and the capability never mint one — a membership's
 * automation credential is issued later, on purpose, from the console.
 *
 * Runs with `skipRoleSwitch` (superuser): neither the workspace nor the owner Principal exists yet
 * for RLS to scope against — the same bootstrap pattern `application/gateway/auth.ts`'s
 * `withAdminClient` documents.
 */

/** S5.3 (`workspaces.purpose`, migration core 0028): `ephemeral` — an acceptance run, a demo —
 *  carries `expires_at` and is retired by `scripts/delete-workspaces-matching.sh --expired`;
 *  `standard` never expires. Decided at creation; the console shows it read-only. */
export const WORKSPACE_PURPOSE_VALUES = ['standard', 'ephemeral'] as const;
export type WorkspacePurpose = (typeof WORKSPACE_PURPOSE_VALUES)[number];

export interface CreateWorkspaceOwner {
  /** An existing platform user who becomes the owner. Omit to create a passwordless user with a
   *  derived login (the pre-S4.1 CLI shape — `ensureUserForHumanPrincipal`). */
  readonly userId?: string;
  readonly displayName: string;
  /** Mint an API key for the owner Principal and return it once. CLI only. */
  readonly issueApiKey?: boolean;
}

export interface CreateWorkspaceInput {
  readonly name: string;
  readonly owner: CreateWorkspaceOwner;
  /** `<provider>/<id>` for the seeded entry WorkerDefinition's `model`, `workspaces.entry_model`
   *  and (P-A2) the workspace AgentPolicy's `defaultModel` — the three stay in step from birth.
   *  Omitted leaves all unset (pi's own default model selection). */
  readonly entryModel?: string;
  /** P-A2: the AgentPolicy `allowedModels` cap (`[]` / omitted = unrestricted). */
  readonly allowedModels?: readonly string[];
  /** P-A2: let `create_workspace` pre-generate the id so its audit row (written in the platform
   *  transaction, before this bootstrap runs) can name the workspace. */
  readonly workspaceId?: string;
  readonly ontologyDir?: string;
  /** S5.1 (`workspaces.ontology_enforcement`, migration core 0025): what a Link write the
   *  published ontology does not license does. Omitted → `defaultOntologyEnforcement()`. */
  readonly ontologyEnforcement?: OntologyEnforcement;
  /** S5.3: omitted → `standard`. */
  readonly purpose?: WorkspacePurpose;
  /** S5.3: when the workspace may be retired; only meaningful with `purpose: 'ephemeral'`. */
  readonly expiresAt?: Date | null;
  /** P-B2b (design §6.4 "默认模块"; §5d S7-D 决定 D4): module family names to install — each at its
   *  own **latest** index version (`installOrUpgradeModule`'s own doc comment: a fresh workspace
   *  always takes the "family absent → publish the latest version" branch, never "v1" specifically)
   *  — in the same transaction, right after the platform meta-ontology. Omitted/`[]` = none. The
   *  caller (`platform-handlers.ts`'s `createWorkspaceHandler`) reads `PlatformSettings.
   *  defaultModules` and passes it through — this module does not read platform settings itself (no
   *  platform transaction is open here, see this file's own doc comment on `skipRoleSwitch`). */
  readonly defaultModules?: readonly string[];
}

/**
 * The enforcement a new workspace is born with when its creator names none: the kernel's
 * `ONTOLOGY_ENFORCEMENT` environment variable, else `reject`. The variable exists for a host
 * mid-rollout (S5.1 迁移: run `warn` for a round, switch to `reject` once I-S5-1 reads 0) that
 * creates workspaces during that round; tests and CI never set it. An unrecognised value fails
 * loudly here rather than silently meaning "reject".
 */
export function defaultOntologyEnforcement(
  env: NodeJS.ProcessEnv = process.env,
): OntologyEnforcement {
  const raw = env.ONTOLOGY_ENFORCEMENT;
  if (raw === undefined || raw === '') return 'reject';
  if ((ONTOLOGY_ENFORCEMENT_VALUES as readonly string[]).includes(raw)) {
    return raw as OntologyEnforcement;
  }
  throw new Error(
    `ONTOLOGY_ENFORCEMENT must be one of ${ONTOLOGY_ENFORCEMENT_VALUES.join(' / ')}, got "${raw}"`,
  );
}

export interface CreateWorkspaceOutcome {
  readonly workspaceId: string;
  readonly ownerPrincipalId: string;
  /** Present only when `owner.issueApiKey` was set. Never logged. */
  readonly apiKey?: string;
}

async function loadWorkerDefinitionTemplate(
  filePath: string,
): Promise<{ kind: WorkerDefinitionKind; definition: Record<string, unknown> }> {
  const text = await readFile(filePath, 'utf8');
  const parsed = parseYaml(text) as Record<string, unknown>;
  const { kind, ...definition } = parsed;
  return { kind: kind as WorkerDefinitionKind, definition };
}

export async function createWorkspaceWithOwner(
  pool: PoolLike,
  input: CreateWorkspaceInput,
): Promise<CreateWorkspaceOutcome> {
  const workspaceId = input.workspaceId ?? randomUUID();
  const ownerPrincipalId = randomUUID();
  const apiKey = input.owner.issueApiKey ? generateApiKey() : undefined;
  const apiKeyHash = apiKey ? hashApiKey(apiKey) : null;
  const ontologyDir = input.ontologyDir ?? resolveOntologyDir();

  await withWorkspace(
    pool,
    { workspaceId, principalId: ownerPrincipalId },
    async (client) => {
      await client.query(
        `insert into workspaces (id, name, entry_model, ontology_enforcement, purpose, expires_at)
         values ($1, $2, $3, $4, $5, $6)`,
        [
          workspaceId,
          input.name,
          input.entryModel ?? null,
          input.ontologyEnforcement ?? defaultOntologyEnforcement(),
          input.purpose ?? 'standard',
          input.expiresAt ?? null,
        ],
      );
      await client.query(
        `insert into principals (workspace_id, id, kind, role, display_name, api_key_hash, user_id)
         values ($1, $2, 'human', 'owner', $3, $4, $5)`,
        [
          workspaceId,
          ownerPrincipalId,
          input.owner.displayName,
          apiKeyHash,
          input.owner.userId ?? null,
        ],
      );
      if (!input.owner.userId) {
        await ensureUserForHumanPrincipal(client, {
          workspaceId,
          id: ownerPrincipalId,
          displayName: input.owner.displayName,
        });
      }

      // P-A2: the AgentPolicy row is what the runtime reads for the entry model
      // (governance/agent-profile/resolve.ts `resolveModel`) and what "我的智能体" narrows to;
      // seed it here so `workspaces.entry_model` and `agent_policies.default_model` never
      // disagree, whichever path created the workspace.
      if (input.entryModel || (input.allowedModels && input.allowedModels.length > 0)) {
        await setAgentPolicy(client, workspaceId, ownerPrincipalId, {
          defaultModel: input.entryModel ?? null,
          allowedModels: input.allowedModels ?? [],
        });
      }

      await seedPlatformMetaOntology(client, workspaceId, ownerPrincipalId, ontologyDir);

      // P-B2b (决定 D4): default modules install the same way platform-meta just did — same
      // transaction, the new owner Principal as `proposed_by`/`published_by` (`ontology_versions`'
      // FK requires a real Principal; there is no system Principal, design §11 "不造系统 Principal").
      // Every name here is a fresh workspace's first install of that family, so
      // `installOrUpgradeModule` always takes its "family absent → publish the latest index
      // version" branch — never `confirm` (nothing installed yet to be `customized`, and a fresh
      // install is never a "breaking upgrade").
      if (input.defaultModules && input.defaultModules.length > 0) {
        const registry = await loadModuleRegistry(ontologyDir);
        for (const name of input.defaultModules) {
          await installOrUpgradeModule(
            client,
            workspaceId,
            ownerPrincipalId,
            registry,
            { name },
            ontologyDir,
          );
        }
      }

      const entryTemplate = await loadWorkerDefinitionTemplate(
        path.join(ontologyDir, 'entry-agent.yaml'),
      );
      const entryDefinition = input.entryModel
        ? { ...entryTemplate.definition, model: input.entryModel }
        : entryTemplate.definition;
      const draft = await proposeWorkerDefinition(client, workspaceId, ownerPrincipalId, {
        kind: entryTemplate.kind,
        definition: entryDefinition,
      });
      await publishWorkerDefinition(client, workspaceId, ownerPrincipalId, {
        definitionId: draft.id,
        version: draft.version,
      });
    },
    { skipRoleSwitch: true },
  );

  return apiKey ? { workspaceId, ownerPrincipalId, apiKey } : { workspaceId, ownerPrincipalId };
}
