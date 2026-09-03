import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Role, RoleSchema, type WorkerDefinitionKind } from '@nexttime/shared';
import { parse as parseYaml } from 'yaml';
import { createPool, withWorkspace } from '../adapters/db/pool.js';
import type { PoolLike } from '../adapters/db/pool.js';
import { hashApiKey } from '../application/gateway/index.js';
import { proposeWorkerDefinition, publishWorkerDefinition } from '../application/worker/index.js';
import { resolveOntologyDir, seedPlatformMetaOntology } from '../substrate/ontology/index.js';

/**
 * Bootstrap CLI (docs/development-tasks.md S1.3 item 6; needed by S1.8/S1.10; S2.6 extends
 * `create-workspace`). Wired to the kernel package.json `bootstrap` script.
 *
 * Usage:
 *   node dist/cli/bootstrap.js create-workspace --name <ws> --owner <display-name> [--entry-model <provider/id>]
 *   node dist/cli/bootstrap.js add-principal --workspace <id> --name <display-name> [--role <role>]
 *
 * `create-workspace` creates the Workspace and its first Principal (`kind='human'`,
 * `role='owner'` — design doc §5.1.1), generates an API key, and prints it exactly once: only its
 * sha256 hash (`application/gateway/auth.ts`'s `hashApiKey` — the same hashing the human channel
 * itself uses to look the key back up, so the two can never drift) is stored, in
 * `principals.api_key_hash`. `add-principal` (docs/development-tasks.md S1.10: "if the bootstrap
 * CLI cannot add a second principal, add a minimal add-principal subcommand ... same style, prints
 * the key once") does the same for a Principal in an *existing* Workspace — needed by
 * `scripts/accept_s1.sh` to create a second user (`bob`) in the same workspace as `alice` to
 * exercise isolation. `--role` defaults to `member` (§5.1.1 "对话、调用、观察" — the operational
 * floor a second acceptance user needs) and is validated against `@nexttime/shared`'s `Role`
 * enum, the same one `principals.role`'s own CHECK constraint (migrations/core/0001_identity.sql)
 * encodes. Reads `DATABASE_URL` from the environment via `createPool()`. `cli` is a standalone
 * entry point, like `index.ts`'s composition root — not part of the six-layer dependency-cruiser
 * rule (`.dependency-cruiser.cjs` matches only `substrate|governance|application|adapters|
 * interfaces`), so importing `application/gateway`, `application/worker`, `substrate/ontology`,
 * and `@nexttime/shared` here is unrestricted.
 *
 * S2.6 additions to `create-workspace` (design doc §7.2 "--system-prompt 来自该用户入口
 * WorkerDefinition 的已发布版本"; docs/development-tasks.md S2.6 deliverable 3): publishes
 * `ontology/platform-meta.yaml` as this workspace's platform meta-ontology
 * (`substrate/ontology`'s `seedPlatformMetaOntology`) and seeds `ontology/entry-agent.yaml` as
 * `worker_definitions` v1, published for the owner (`application/worker`'s
 * `proposeWorkerDefinition`/`publishWorkerDefinition`) — this is what turns S1's static
 * `entrypoint.sh` prompt into the workspace's real, governed entry definition from the very first
 * Turn. `--entry-model` sets the definition's `model` field (never a value baked into the
 * checked-in YAML template — §7.7 "厂商与模型是配置"). Both seed steps fail the whole
 * `create-workspace` call (no try/catch) rather than silently leaving a workspace with no entry
 * prompt — a missing/invalid `ontology/*.yaml` at bootstrap time is a deployment problem that
 * should surface immediately, not a soft-fail case like this file's own egress-registration
 * precedent elsewhere in the codebase (that precedent is for a *runtime* best-effort integration,
 * not a one-time setup step whose whole point is to leave the workspace correctly seeded).
 */

const API_KEY_BYTES = 32;

function generateApiKey(): string {
  return randomBytes(API_KEY_BYTES).toString('base64url');
}

/** `ontology/entry-agent.yaml`'s (and, in principle, any future `kind=worker` template's) shape:
 *  `kind` is a top-level sibling of the WorkerDefinition content, not a field of the content
 *  itself — see `ontology/entry-agent.yaml`'s own header comment and
 *  `packages/shared/src/worker-definition.ts`'s module doc for why. */
async function loadWorkerDefinitionTemplate(
  filePath: string,
): Promise<{ kind: WorkerDefinitionKind; definition: Record<string, unknown> }> {
  const text = await readFile(filePath, 'utf8');
  const parsed = parseYaml(text) as Record<string, unknown>;
  const { kind, ...definition } = parsed;
  return { kind: kind as WorkerDefinitionKind, definition };
}

export interface CreateWorkspaceOptions {
  /** `<provider>/<id>` for the seeded entry WorkerDefinition's `model` field — omitted leaves it
   *  unset (pi's own default model selection, same as the checked-in template). */
  readonly entryModel?: string;
}

export interface CreateWorkspaceResult {
  readonly workspaceId: string;
  readonly ownerPrincipalId: string;
  readonly apiKey: string;
}

/** Creates a Workspace and its owner Principal in one transaction, then seeds the platform
 *  meta-ontology and a published v1 entry WorkerDefinition (S2.6 — see this module's own doc
 *  comment). Never logs the API key. */
export async function createWorkspace(
  pool: PoolLike,
  name: string,
  ownerDisplayName: string,
  options: CreateWorkspaceOptions = {},
): Promise<CreateWorkspaceResult> {
  const workspaceId = randomUUID();
  const ownerPrincipalId = randomUUID();
  const apiKey = generateApiKey();
  const apiKeyHash = hashApiKey(apiKey);
  const ontologyDir = resolveOntologyDir();

  await withWorkspace(
    pool,
    { workspaceId, principalId: ownerPrincipalId },
    async (client) => {
      await client.query('insert into workspaces (id, name) values ($1, $2)', [workspaceId, name]);
      await client.query(
        `insert into principals (workspace_id, id, kind, role, display_name, api_key_hash)
         values ($1, $2, 'human', 'owner', $3, $4)`,
        [workspaceId, ownerPrincipalId, ownerDisplayName, apiKeyHash],
      );

      // S2.6: platform meta-ontology (§5.1.2 WorkerDefinition/Gatekeeper/Operation/Capability/
      // Skill/Procedure ObjectTypes + their LinkTypes).
      await seedPlatformMetaOntology(client, workspaceId, ownerPrincipalId, ontologyDir);

      // S2.6: the entry WorkerDefinition, proposed and immediately published as v1.
      const entryTemplate = await loadWorkerDefinitionTemplate(
        path.join(ontologyDir, 'entry-agent.yaml'),
      );
      const entryDefinition = options.entryModel
        ? { ...entryTemplate.definition, model: options.entryModel }
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
    // Bootstrap: neither the workspace nor the owner principal exists yet for RLS to scope
    // against — same admin/skip-role-switch pattern as application/gateway/auth.ts's
    // `withAdminClient` and substrate/invariants.test.ts's `adminInsertWorkspace`. The S2.6
    // ontology/worker-definition seed calls above run in this same transaction, under the same
    // admin context — see this module's own doc comment.
    { skipRoleSwitch: true },
  );

  return { workspaceId, ownerPrincipalId, apiKey };
}

export interface AddPrincipalResult {
  readonly principalId: string;
  readonly apiKey: string;
}

/**
 * Adds a `kind='human'` Principal to an *existing* Workspace, generates its own API key, and
 * prints it exactly once — same "hash only, never the raw key, is stored" contract as
 * `createWorkspace`. `skipRoleSwitch: true` for the same reason `createWorkspace` uses it: this
 * new principal does not exist yet for RLS to scope the insert against (`principals`' own RLS
 * policy is workspace-only — no owner/self check — so this is the narrowest correct escape hatch,
 * not a broader bypass; a caller with the workspace id already implicitly has bootstrap-level
 * trust, same as `create-workspace` itself).
 */
export async function addPrincipal(
  pool: PoolLike,
  workspaceId: string,
  displayName: string,
  role: Role = 'member',
): Promise<AddPrincipalResult> {
  const principalId = randomUUID();
  const apiKey = generateApiKey();
  const apiKeyHash = hashApiKey(apiKey);

  await withWorkspace(
    pool,
    { workspaceId, principalId },
    async (client) => {
      await client.query(
        `insert into principals (workspace_id, id, kind, role, display_name, api_key_hash)
         values ($1, $2, 'human', $3, $4, $5)`,
        [workspaceId, principalId, role, displayName, apiKeyHash],
      );
    },
    { skipRoleSwitch: true },
  );

  return { principalId, apiKey };
}

// -------------------------------------------------------------------------------------------
// CLI plumbing
// -------------------------------------------------------------------------------------------

interface ParsedFlags {
  readonly [flag: string]: string;
}

/** Parses `--flag value` / `--flag=value` pairs. Unknown-shaped tokens are ignored. */
function parseFlags(argv: readonly string[]): ParsedFlags {
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === undefined || !token.startsWith('--')) continue;
    const eq = token.indexOf('=');
    if (eq !== -1) {
      flags[token.slice(2, eq)] = token.slice(eq + 1);
      continue;
    }
    const name = token.slice(2);
    const value = argv[i + 1];
    if (value !== undefined && !value.startsWith('--')) {
      flags[name] = value;
      i++;
    }
  }
  return flags;
}

class BootstrapUsageError extends Error {}

async function runCreateWorkspace(argv: readonly string[]): Promise<void> {
  const flags = parseFlags(argv);
  const name = flags.name;
  const owner = flags.owner;
  if (!name || !owner) {
    throw new BootstrapUsageError(
      'usage: bootstrap create-workspace --name <ws> --owner <display-name> [--entry-model <provider/id>]',
    );
  }

  const pool = createPool();
  try {
    const result = await createWorkspace(pool, name, owner, { entryModel: flags['entry-model'] });
    console.log(`workspace created: ${result.workspaceId}`);
    console.log(`owner principal:   ${result.ownerPrincipalId}`);
    console.log('');
    console.log('API key (shown once — store it securely, only its hash is kept):');
    console.log(result.apiKey);
  } finally {
    await pool.end();
  }
}

async function runAddPrincipal(argv: readonly string[]): Promise<void> {
  const flags = parseFlags(argv);
  const workspaceId = flags.workspace;
  const name = flags.name;
  const roleFlag = flags.role ?? 'member';
  if (!workspaceId || !name) {
    throw new BootstrapUsageError(
      'usage: bootstrap add-principal --workspace <id> --name <display-name> [--role <role>]',
    );
  }
  const roleResult = RoleSchema.safeParse(roleFlag);
  if (!roleResult.success) {
    throw new BootstrapUsageError(
      `usage: bootstrap add-principal --workspace <id> --name <display-name> [--role <role>] (invalid role "${roleFlag}")`,
    );
  }

  const pool = createPool();
  try {
    const result = await addPrincipal(pool, workspaceId, name, roleResult.data);
    console.log(`principal created: ${result.principalId}`);
    console.log('');
    console.log('API key (shown once — store it securely, only its hash is kept):');
    console.log(result.apiKey);
  } finally {
    await pool.end();
  }
}

async function run(): Promise<void> {
  const [, , command, ...rest] = process.argv;
  if (command === 'create-workspace') {
    await runCreateWorkspace(rest);
    return;
  }
  if (command === 'add-principal') {
    await runAddPrincipal(rest);
    return;
  }
  throw new BootstrapUsageError(
    'usage: bootstrap create-workspace --name <ws> --owner <display-name>\n' +
      '   or: bootstrap add-principal --workspace <id> --name <display-name> [--role <role>]',
  );
}

const isMainModule =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];

if (isMainModule) {
  run().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
