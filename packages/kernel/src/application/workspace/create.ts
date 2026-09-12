import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { WorkerDefinitionKind } from '@nexttime/shared';
import { parse as parseYaml } from 'yaml';
import type { PoolLike } from '../../adapters/db/pool.js';
import { withWorkspace } from '../../adapters/db/pool.js';
import { setAgentPolicy } from '../../governance/agent-profile/index.js';
import { resolveOntologyDir, seedPlatformMetaOntology } from '../../substrate/ontology/index.js';
import { generateApiKey, hashApiKey } from '../gateway/auth.js';
import { ensureUserForHumanPrincipal } from '../identity/users.js';
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
      await client.query('insert into workspaces (id, name, entry_model) values ($1, $2, $3)', [
        workspaceId,
        input.name,
        input.entryModel ?? null,
      ]);
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
