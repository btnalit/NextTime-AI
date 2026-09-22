import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type PurgeWorkspaceResultWire,
  type Role,
  RoleSchema,
  type WorkerDefinitionKind,
} from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { parse as parseYaml } from 'yaml';
import { createPool, withWorkspace } from '../adapters/db/pool.js';
import type { PoolLike } from '../adapters/db/pool.js';
import { HttpGatekeeperClient } from '../adapters/gatekeeper-client/index.js';
import type { GatekeeperClient } from '../adapters/gatekeeper-client/index.js';
import { generateApiKey, hashApiKey } from '../application/gateway/index.js';
import {
  createPlatformAdmin,
  derivedLogin,
  ensureUserForHumanPrincipal,
  findUserByLogin,
  setUserPassword,
} from '../application/identity/index.js';
import {
  PurgeWorkspaceRefusedError,
  assessPurgeEligibility,
  envAdminLogins,
  purgeWorkspace,
  readPlatformSettings,
} from '../application/platform/index.js';
import { proposeWorkerDefinition, publishWorkerDefinition } from '../application/worker/index.js';
import {
  WORKSPACE_PURPOSE_VALUES,
  createWorkspaceWithOwner,
} from '../application/workspace/index.js';
import type { WorkspacePurpose } from '../application/workspace/index.js';
import { issueHandle, loadHandleKeyPair } from '../governance/capability/index.js';
import {
  importManifest,
  publishOperation,
  registerGatekeeper,
} from '../governance/gatekeepers/index.js';
import { endActivity, startActivity } from '../substrate/epistemic/index.js';
import {
  publishOntologyDomainPack,
  resolveOntologyDir,
  seedPlatformMetaOntology,
} from '../substrate/ontology/index.js';

/**
 * Bootstrap CLI (docs/development-tasks.md S1.3 item 6; needed by S1.8/S1.10; S2.6 extends
 * `create-workspace`). Wired to the kernel package.json `bootstrap` script.
 *
 * Usage:
 *   node dist/cli/bootstrap.js create-workspace --name <ws> --owner <display-name> [--entry-model <provider/id>] [--purpose standard|ephemeral] [--ttl <n>h]
 *   node dist/cli/bootstrap.js add-principal --workspace <id> --name <display-name> [--role <role>]
 *   node dist/cli/bootstrap.js list-workspaces
 *   node dist/cli/bootstrap.js purge-workspace <workspaceId> [--yes | --dry-run] [--name <expected name>] [--actor <login>]
 *   node dist/cli/bootstrap.js purge-expired-workspaces [--yes] [--include-disabled] [--actor <login>]
 *   node dist/cli/bootstrap.js delete-workspace <workspaceId> --yes [--name <expected name>] [--allow-name-pattern <regex>] [--actor <login>]
 *   node dist/cli/bootstrap.js seed-domain-pack --workspace <id> --principal <id> --pack-name <name> [--file-name <file>] [--dir <dir>]
 *   node dist/cli/bootstrap.js issue-service-handle --workspace <id> --name <name> --scope <cap1,cap2,...> [--ttl-days <n>]
 *
 * `seed-domain-pack`/`issue-service-handle` (S3.3, docs/development-tasks.md S3.3 "collector auth
 * seam"): the operator-run bootstrap steps a collector needs before its first run — see this
 * file's own "seed-domain-pack" / "issue-service-handle" sections below for the full doc comments,
 * and `docs/runbooks/host-collector.md` for the end-to-end operator walkthrough.
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
 *
 * `purge-workspace` / `purge-expired-workspaces` / `delete-workspace` / `list-workspaces`
 * (operator-only, destructive workspace teardown — see the section doc comment below and
 * application/platform/purge-workspace.ts for the cascade, deletion-order and append-only-trigger
 * rationale): the host-operator cleanup path for the throwaway workspaces acceptance / smoke runs
 * accumulate. S6 (docs/console-completion-plan.md §5.2): `purge-workspace` is the governed
 * `purge_workspace` capability's operator twin — same preconditions (disabled ≥ 7 days or expired
 * ephemeral, never the default workspace), same cascade, same audit row — and
 * `purge-expired-workspaces` its bulk form; `delete-workspace` is the legacy override that skips
 * the preconditions, never registered as a capability, so no Handle/agent path can ever reach it.
 * `list-workspaces` prints every Workspace (id, name, created_at, principal/task counts, purpose,
 * expiry, status, disabled_at) so an operator can pick a target — or a `--allow-name-pattern` —
 * with real numbers in front of them, not guesswork. Every destructive subcommand refuses without
 * `--yes`, optionally cross-checks `--name` against the workspace's actual stored name (guards
 * against a pasted-wrong-id mistake), always prints what it found *before* checking any of that,
 * and — once every guard passes — purges the Workspace and every row any workspace-scoped table
 * holds for it in one transaction, then prints machine-readable `PRINCIPAL=<id>`/`TASK=<id>`
 * lines so `scripts/delete-workspace.sh` can remove the matching host-side container and data
 * directory (docs/runbooks/host-bootstrap.md "Deleting a workspace", docs/runbooks/operations.md).
 */

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
  /** S5.3: `--purpose ephemeral` (an acceptance run / demo workspace, retired by
   *  `delete-workspaces-matching.sh --expired` once `expiresAt` passes). Omitted → `standard`. */
  readonly purpose?: WorkspacePurpose;
  readonly expiresAt?: Date | null;
}

const TTL_PATTERN = /^(\d+)([mhd])$/;
const TTL_UNIT_MS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 };

/** `--ttl <n>m | <n>h | <n>d` → milliseconds (S5.3 `create-workspace --purpose ephemeral`). */
export function parseTtl(raw: string): number {
  const match = TTL_PATTERN.exec(raw.trim());
  const amount = match ? Number(match[1]) : Number.NaN;
  const unit = match?.[2];
  if (!match || !Number.isFinite(amount) || amount <= 0 || unit === undefined) {
    throw new BootstrapUsageError(`--ttl must be <n>m, <n>h or <n>d with n > 0 (got "${raw}")`);
  }
  return amount * (TTL_UNIT_MS[unit] ?? 0);
}

const DEFAULT_EPHEMERAL_TTL = '24h';

/** The directory `seed-domain-pack` reads packs from when `--dir` is not given (S5.3 "放文件 →
 *  seed"): `DOMAIN_PACK_DIR` when set and present (the deployment points it at the host data
 *  directory's `config/ontology`, mounted read-only under `/data/config`), else the image's
 *  bundled `ontology/` (`resolveOntologyDir`) — which stays the platform's own default examples,
 *  never something an operator edits in place. */
export function resolveDomainPackDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.DOMAIN_PACK_DIR;
  if (configured && existsSync(configured)) return configured;
  return resolveOntologyDir(env);
}

export interface CreateWorkspaceResult {
  readonly workspaceId: string;
  readonly ownerPrincipalId: string;
  readonly apiKey: string;
  /** S4.1: the derived login of the passwordless user `ensureUserForHumanPrincipal` linked to the
   *  owner principal below — an admin sets a real password later (`set-password`). */
  readonly ownerLogin: string;
}

/** Creates a Workspace and its owner Principal in one transaction, then seeds the platform
 *  meta-ontology and a published v1 entry WorkerDefinition (S2.6). P-A1: the body moved to
 *  `application/workspace/create.ts` (`createWorkspaceWithOwner`) so the kernel's first start
 *  and the console share it; this wrapper keeps the CLI's own contract — an owner API key,
 *  printed exactly once, and the derived login of the owner's passwordless user. Never logs the
 *  API key. */
export async function createWorkspace(
  pool: PoolLike,
  name: string,
  ownerDisplayName: string,
  options: CreateWorkspaceOptions = {},
): Promise<CreateWorkspaceResult> {
  const outcome = await createWorkspaceWithOwner(pool, {
    name,
    owner: { displayName: ownerDisplayName, issueApiKey: true },
    entryModel: options.entryModel,
    ontologyDir: resolveOntologyDir(),
    purpose: options.purpose,
    expiresAt: options.expiresAt,
  });
  if (!outcome.apiKey) throw new Error('createWorkspace: no API key was issued');
  return {
    workspaceId: outcome.workspaceId,
    ownerPrincipalId: outcome.ownerPrincipalId,
    apiKey: outcome.apiKey,
    ownerLogin: derivedLogin(ownerDisplayName, outcome.ownerPrincipalId),
  };
}

export interface AddPrincipalResult {
  readonly principalId: string;
  readonly apiKey: string;
  /** S4.1: the derived login of the passwordless user `ensureUserForHumanPrincipal` linked to
   *  this principal — same reasoning as `CreateWorkspaceResult.ownerLogin` above. */
  readonly login: string;
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

      // S4.1: every human Principal is a user's membership (principals.user_id, migration 0019);
      // the CLI-created owner gets a passwordless user with the derived login — an admin sets a
      // password later.
      await ensureUserForHumanPrincipal(client, { workspaceId, id: principalId, displayName });
    },
    { skipRoleSwitch: true },
  );

  return { principalId, apiKey, login: derivedLogin(displayName, principalId) };
}

// -------------------------------------------------------------------------------------------
// register-gatekeeper — S2.5's manual registration path for a running Gatekeeper instance (task
// brief: "if only service functions exist, provide a bootstrap.js register-gatekeeper subcommand
// ... that calls them and imports the gate's manifest by calling its describe_operations"). Real
// automated registration is S2.13's `request_connection` card flow (governance/gatekeepers'
// own doc comment) — this subcommand is the interim host-operator path.
// -------------------------------------------------------------------------------------------

const GATEKEEPER_TRANSPORT_KINDS = ['http', 'mcp', 'cli', 'ssh'] as const;
type GatekeeperTransportKind = (typeof GATEKEEPER_TRANSPORT_KINDS)[number];

function isGatekeeperTransportKind(value: string): value is GatekeeperTransportKind {
  return (GATEKEEPER_TRANSPORT_KINDS as readonly string[]).includes(value);
}

export interface RegisterGatekeeperCliInput {
  readonly workspaceId: string;
  readonly principalId: string;
  readonly name: string;
  readonly endpoint: string;
  readonly transportKind: GatekeeperTransportKind;
  /** The connected system's own identifying label — defaults to `name` (`registerGatekeeper`'s
   *  own `target` field, `governance/gatekeepers/registry.ts`). */
  readonly target?: string;
  /**
   * Publishes every imported Operation immediately instead of leaving it as a draft (I17: an
   * imported Operation always starts as a draft — `importManifest`'s own doc comment — so this is
   * an explicit second step, not the default, matching the design's owner-review gate).
   */
  readonly publish?: boolean;
}

export interface RegisterGatekeeperCliResult {
  readonly gatekeeperId: string;
  readonly importedOperationNames: readonly string[];
  /** Manifest entries `importManifest` refused to write over an already `published`/`deprecated`
   *  Operation of the same name (always empty for the fresh Gatekeeper this command registers). */
  readonly skippedOperationNames: readonly string[];
  readonly publishedOperationNames: readonly string[];
}

/** Fetches the target endpoint's `describe_operations`, registers it as a Gatekeeper instance,
 *  imports its manifest as drafts, and (only when `input.publish` is set) publishes every
 *  imported Operation. One Activity spans the whole registration. The HTTP fetch happens before
 *  any database work starts, so an unreachable endpoint fails fast without opening a transaction.
 *  `options.gatekeeperClient` defaults to a real `HttpGatekeeperClient` — overridable so tests
 *  can inject a fake `describeOperations` without a real gate listening on a port. */
export async function registerGatekeeperFromCli(
  pool: PoolLike,
  input: RegisterGatekeeperCliInput,
  options: { readonly gatekeeperClient?: GatekeeperClient } = {},
): Promise<RegisterGatekeeperCliResult> {
  const client = options.gatekeeperClient ?? new HttpGatekeeperClient();
  const described = await client.describeOperations(input.endpoint);

  return withWorkspace(
    pool,
    { workspaceId: input.workspaceId, principalId: input.principalId },
    async (dbClient) => {
      const activity = await startActivity(dbClient, input.workspaceId, {
        kind: 'governance.register_gatekeeper',
        principalId: input.principalId,
      });

      const { gatekeeperId } = await registerGatekeeper(dbClient, input.workspaceId, {
        name: input.name,
        transportKind: input.transportKind,
        target: input.target ?? input.name,
        endpoint: input.endpoint,
        activityId: activity.id,
        registeredBy: { id: input.principalId, kind: 'human' },
      });

      const imported = await importManifest(dbClient, input.workspaceId, {
        gatekeeperId,
        operations: described.operations,
        proposedBy: { id: input.principalId, kind: 'human' },
        activityId: activity.id,
      });

      const publishedOperationNames: string[] = [];
      if (input.publish) {
        for (const record of imported.imported) {
          await publishOperation(dbClient, input.workspaceId, { gatekeeperId, name: record.name });
          publishedOperationNames.push(record.name);
        }
      }

      await endActivity(dbClient, input.workspaceId, activity.id, 'completed');

      return {
        gatekeeperId,
        importedOperationNames: imported.imported.map((record) => record.name),
        skippedOperationNames: imported.skipped.map((entry) => entry.name),
        publishedOperationNames,
      };
    },
  );
}

// -------------------------------------------------------------------------------------------
// seed-domain-pack (S3.3): publishes an `ontology/<pack>.yaml` domain pack into a workspace — the
// operator-run step `substrate/ontology/loader.ts`'s own `publishOntologyDomainPack` doc comment
// names as its intended caller ("not wired into `create-workspace`... it is the seam a bootstrap
// follow-up or an operator-run CLI calls to publish `ontology/ops-assets-v1.yaml`... into a given
// workspace"). A collector like `collectors/host-inventory` needs the domain pack it observes
// against (S3.1's `ops-assets-v1.yaml`) published into the target workspace before its first run,
// or `submit_observations`' own identity-key validation (`application/gateway/ingest-handlers.ts`)
// rejects every observation as an unknown ObjectType — see `docs/runbooks/host-collector.md`.
// -------------------------------------------------------------------------------------------

export interface SeedDomainPackCliInput {
  readonly workspaceId: string;
  readonly principalId: string;
  readonly packName: string;
  readonly fileName?: string;
  readonly dir?: string;
}

export interface SeedDomainPackCliResult {
  readonly id: string;
  readonly version: number;
}

/** Publishes `<dir>/<fileName ?? packName>.yaml` as the next version of `packName`'s own id
 *  family. `principalId` must already exist in `workspaceId` (an owner/builder — this runs over
 *  the ordinary RLS-scoped path, not the admin/skip-role-switch one `createWorkspace` above uses,
 *  since both the workspace and the principal already exist by the time this is called). */
export async function seedDomainPackFromCli(
  pool: PoolLike,
  input: SeedDomainPackCliInput,
): Promise<SeedDomainPackCliResult> {
  return withWorkspace(
    pool,
    { workspaceId: input.workspaceId, principalId: input.principalId },
    (client) =>
      publishOntologyDomainPack(client, input.workspaceId, {
        packName: input.packName,
        fileName: input.fileName,
        dir: input.dir,
        principalId: input.principalId,
      }),
  );
}

// -------------------------------------------------------------------------------------------
// issue-service-handle (S3.3): mints a Handle for a `kind='service'` Principal — the collector
// auth seam this task's own dispatch names ("if no path exists to mint a service Handle, add a CLI
// subcommand bootstrap issue-service-handle"). No capability exposes Handle issuance for a service
// Principal today (`issue_handle`, the one capability with that name, is `channel:'human'`-only
// and mints a Handle for an *existing session* — S3.6/W2-B territory, not this task's — and no
// mechanism anywhere creates a `service`-kind session at all); this is the interim, CLI-only,
// operator-run path, the same shape `register-gatekeeper` above already established for "no
// capability exists yet for this bootstrap need".
//
// `getOrCreateServicePrincipal` mirrors `governance/gatekeepers/service-principal.ts`'s
// `getOrCreateGatekeeperServicePrincipal` (lookup by `kind='service'` + `display_name`, insert on
// first use) — re-running this subcommand for the same `--name` reuses the same Principal (a fresh
// Session + Handle each time, e.g. to rotate a leaked token, never a second, differently-identified
// collector). `role: 'member'` — a service Principal calling `register_source`/`submit_observations`
// through its own scoped Handle needs no elevated role (role gates human-channel capability calls
// only, §5.1.1; a Handle caller is authorized by `scope.capabilities` alone, `authorize.ts`).
//
// The minted Handle's `ttlSeconds` defaults to one year (`DEFAULT_SERVICE_HANDLE_TTL_SECONDS`) —
// a collector is a long-running/periodically-scheduled process an operator does not want to re-
// bootstrap weekly; `--ttl-days` overrides it. `issueHandle` itself (`governance/capability/
// handles.ts`) already rejects any capability name in `--scope` that is unknown or human-channel-
// only (`assertValidScope`), so a typo'd scope fails loudly here rather than minting a Handle that
// can never call anything.
// -------------------------------------------------------------------------------------------

const DEFAULT_SERVICE_HANDLE_TTL_SECONDS = 365 * 24 * 60 * 60;

async function getOrCreateServicePrincipal(
  client: PoolClient,
  workspaceId: string,
  displayName: string,
): Promise<string> {
  const existing = await client.query<{ id: string }>(
    "select id from principals where workspace_id = $1 and kind = 'service' and display_name = $2 limit 1",
    [workspaceId, displayName],
  );
  const found = existing.rows[0];
  if (found) return found.id;

  const inserted = await client.query<{ id: string }>(
    `insert into principals (workspace_id, kind, role, display_name)
     values ($1, 'service', 'member', $2)
     returning id`,
    [workspaceId, displayName],
  );
  const row = inserted.rows[0];
  if (!row) {
    throw new Error('issue-service-handle: principal INSERT ... RETURNING produced no row');
  }
  return row.id;
}

export interface IssueServiceHandleCliInput {
  readonly workspaceId: string;
  readonly name: string;
  readonly scope: readonly string[];
  /** Defaults to `DEFAULT_SERVICE_HANDLE_TTL_SECONDS` (one year). */
  readonly ttlSeconds?: number;
}

export interface IssueServiceHandleCliResult {
  readonly principalId: string;
  readonly sessionId: string;
  readonly jti: string;
  readonly token: string;
  readonly expiresAt: Date;
}

/** Gets-or-creates a `kind='service'` Principal named `input.name`, opens a fresh `kind='service'`
 *  session for it (`on_behalf_of` = itself — a service Principal never acts "on behalf of" a
 *  human), and issues a Handle scoped to exactly `input.scope`. Runs over the admin/skip-role-
 *  switch path (same reasoning as `createWorkspace`/`addPrincipal` above): the service Principal
 *  may not exist yet for RLS to scope the `principals`/`sessions` inserts against. */
export async function issueServiceHandleFromCli(
  pool: PoolLike,
  input: IssueServiceHandleCliInput,
): Promise<IssueServiceHandleCliResult> {
  const keyPair = await loadHandleKeyPair();

  return withWorkspace(
    pool,
    { workspaceId: input.workspaceId, principalId: randomUUID() },
    async (client) => {
      const principalId = await getOrCreateServicePrincipal(client, input.workspaceId, input.name);

      const sessionResult = await client.query<{ id: string }>(
        `insert into sessions (workspace_id, principal_id, kind, on_behalf_of, status)
         values ($1, $2, 'service', $2, 'active')
         returning id`,
        [input.workspaceId, principalId],
      );
      const sessionRow = sessionResult.rows[0];
      if (!sessionRow) {
        throw new Error('issue-service-handle: session INSERT ... RETURNING produced no row');
      }

      const issued = await issueHandle(client, {
        sessionId: sessionRow.id,
        scope: { capabilities: [...input.scope], resources: {} },
        ttlSeconds: input.ttlSeconds ?? DEFAULT_SERVICE_HANDLE_TTL_SECONDS,
        privateKey: keyPair.privateKey,
      });

      return {
        principalId,
        sessionId: sessionRow.id,
        jti: issued.jti,
        token: issued.token,
        expiresAt: issued.expiresAt,
      };
    },
    { skipRoleSwitch: true },
  );
}

// -------------------------------------------------------------------------------------------
// delete-workspace / list-workspaces / purge-workspace / purge-expired-workspaces — operator-only,
// destructive workspace teardown. The only entry points are this file's `run()` dispatch table
// below, driven by a human operator — directly, or via the host wrapper scripts that run this
// file's compiled output inside the compose project's `kernel` service
// (scripts/delete-workspace.sh, scripts/delete-workspaces-matching.sh).
//
// S6 (docs/console-completion-plan.md §5.2 "脚本与页面同一条路径"): the cascade itself —
// live-schema discovery, the dependency-ordered per-table delete, the append-only-trigger
// override, the §4 edges (service-Handle warning, never-activated users cascading) and the
// `platform.workspace_purged` audit row — lives in application/platform/purge-workspace.ts and is
// shared with the governed `purge_workspace` platform capability. `purge-workspace` here is that
// capability's operator twin (same preconditions: disabled ≥ 7 days or expired ephemeral, never
// the default workspace); `delete-workspace` is the legacy override that skips the preconditions
// (`purgeWorkspace(..., {force: true})`) — kept for the one case an operator must remove a
// workspace the retention rule would still refuse, and never registered as a capability.
//
// Host-side cleanup (the workspace's stopped resident entry container,
// `${NEXTTIME_DATA}/workspaces/<principalId>` and `.../workspaces/tasks/<taskId>` data dirs) is
// deliberately NOT done here: this file lives under `packages/kernel/src`, which
// `scripts/check-kernel-purity.sh` scans for concrete system/vendor names — the kernel is
// mechanism, not content (design doc §7.10). That cleanup is `scripts/delete-workspace.sh`'s job,
// driven by these subcommands' own `PRINCIPAL=`/`TASK=` output lines (see `printHostCleanupLines`).
//
// The audit row: a CLI run names the acting administrator with `--actor <login>` or, failing
// that, takes the first login in `NEXTTIME_PLATFORM_ADMINS` (the anti-lockout administrator every
// host sets). 遗留 54: when neither resolves to a user, `purgeWorkspace` still always writes the
// `platform.workspace_purged` row — `actor_user_id` null, `payload.attributedActor: false`
// (`audit_records_actor_shape`, migration core 0032, legalizes that shape) — rather than leaving
// only the structured `workspace_purged` event line on stderr as the sole trail; that line is
// still printed either way, same as `delete-workspace` always did.
// -------------------------------------------------------------------------------------------

export type { ForeignKeyEdge, WorkspaceScopedSchema } from '../application/platform/index.js';
export {
  WorkspaceDeletionOrderCycleError,
  computeWorkspaceTableDeletionOrder,
  discoverWorkspaceScopedSchema,
} from '../application/platform/index.js';

export interface WorkspaceInspection {
  readonly workspaceId: string;
  readonly name: string;
  readonly createdAt: Date;
  readonly principalCount: number;
  readonly taskCount: number;
}

/** Read-only lookup used by `delete-workspace` to print "what is this, and how much does it
 *  hold" *before* any guard is checked or any row touched (task brief: "before acting") — `null`
 *  if no such workspace exists. Runs over the same admin/skip-role-switch path every other
 *  cross-workspace lookup in this file uses; a plain read needs no real workspace/principal GUCs
 *  (see `withAdminClient`'s doc comment, application/gateway/auth.ts, for why those two values
 *  are inert once `skipRoleSwitch` is set — not imported here only because this file is not part
 *  of the six-layer dependency-cruiser rule but still keeps its existing convention of calling
 *  `withWorkspace(..., { skipRoleSwitch: true })` directly, exactly as `createWorkspace`/
 *  `addPrincipal` above already do). */
export async function inspectWorkspace(
  pool: PoolLike,
  workspaceId: string,
): Promise<WorkspaceInspection | null> {
  return withWorkspace(
    pool,
    { workspaceId, principalId: randomUUID() },
    async (client) => {
      const workspaceRow = (
        await client.query<{ name: string; created_at: Date }>(
          'select name, created_at from workspaces where id = $1',
          [workspaceId],
        )
      ).rows[0];
      if (!workspaceRow) return null;

      const principalCount = Number(
        (
          await client.query<{ count: string }>(
            'select count(*)::bigint as count from principals where workspace_id = $1',
            [workspaceId],
          )
        ).rows[0]?.count ?? 0,
      );
      const taskCount = Number(
        (
          await client.query<{ count: string }>(
            'select count(*)::bigint as count from tasks where workspace_id = $1',
            [workspaceId],
          )
        ).rows[0]?.count ?? 0,
      );

      return {
        workspaceId,
        name: workspaceRow.name,
        createdAt: workspaceRow.created_at,
        principalCount,
        taskCount,
      };
    },
    { skipRoleSwitch: true },
  );
}

export interface WorkspaceListEntry {
  readonly id: string;
  readonly name: string;
  readonly createdAt: Date;
  readonly principalCount: number;
  readonly taskCount: number;
  /** S5.3: `scripts/delete-workspaces-matching.sh --expired` selects on these two. */
  readonly purpose: WorkspacePurpose;
  readonly expiresAt: Date | null;
  /** S6: what `purge-expired-workspaces` assesses eligibility from (with the two above). */
  readonly status: 'active' | 'disabled';
  readonly disabledAt: Date | null;
}

/** Every Workspace, oldest first, with its Principal/Task counts — `list-workspaces`' own
 *  deliverable ("make bulk selection safe"): an operator (or `scripts/delete-workspaces-matching.
 *  sh`) reviews this before choosing which ids/names to hand to `delete-workspace`. */
export async function listWorkspaces(pool: PoolLike): Promise<WorkspaceListEntry[]> {
  return withWorkspace(
    pool,
    { workspaceId: randomUUID(), principalId: randomUUID() },
    async (client) => {
      const result = await client.query<{
        id: string;
        name: string;
        created_at: Date;
        principal_count: string;
        task_count: string;
        purpose: WorkspacePurpose;
        expires_at: Date | null;
        status: 'active' | 'disabled';
        disabled_at: Date | null;
      }>(
        `select
           w.id,
           w.name,
           w.created_at,
           (select count(*) from principals p where p.workspace_id = w.id)::bigint as principal_count,
           (select count(*) from tasks t where t.workspace_id = w.id)::bigint as task_count,
           w.purpose,
           w.expires_at,
           w.status,
           w.disabled_at
         from workspaces w
         order by w.created_at asc`,
      );
      return result.rows.map((row) => ({
        id: row.id,
        name: row.name,
        createdAt: row.created_at,
        principalCount: Number(row.principal_count),
        taskCount: Number(row.task_count),
        purpose: row.purpose,
        expiresAt: row.expires_at,
        status: row.status,
        disabledAt: row.disabled_at,
      }));
    },
    { skipRoleSwitch: true },
  );
}

/** Thrown for `delete-workspace` / `purge-workspace` refusals that depend on runtime state
 *  (workspace not found, a guard in `checkDeleteWorkspaceGuards` failed, the purge preconditions
 *  not met) — distinct from `BootstrapUsageError`, which this file reserves for a malformed
 *  invocation (bad flags/missing required args, independent of what is actually in the
 *  database). */
export class DeleteWorkspaceRefusedError extends Error {}

export interface DeleteWorkspaceResult {
  readonly workspaceId: string;
  readonly name: string;
  /** Every `principals.id` that belonged to this workspace, read back before any row was
   *  deleted — printed as `PRINCIPAL=<id>` lines so `scripts/delete-workspace.sh` can remove the
   *  matching `nexttime-entry-<id>` container and `${NEXTTIME_DATA}/workspaces/<id>` data dir
   *  (host-side; see this section's own doc comment for why that cleanup does not live here). */
  readonly principalIds: readonly string[];
  /** Every `tasks.id` that belonged to this workspace, read back the same way — printed as
   *  `TASK=<id>` lines for the matching `${NEXTTIME_DATA}/workspaces/tasks/<id>` data dir. */
  readonly taskIds: readonly string[];
  /** Rows actually deleted from each workspace-scoped table, keyed by the wire (camel-cased)
   *  table name in the order they were deleted (children before parents —
   *  `computeWorkspaceTableDeletionOrder`); only tables that held rows. */
  readonly deletedCounts: ReadonlyMap<string, number>;
  /** S6 §4 edge (b): the never-activated users deleted with the workspace. */
  readonly purgedUsers: readonly { readonly id: string; readonly login: string }[];
}

/**
 * The legacy operator override: deletes a Workspace and every row any workspace-scoped table
 * holds for it, in one transaction, *without* the `purge_workspace` preconditions — the
 * application/platform `purgeWorkspace` cascade with `force: true`. No guard
 * (`--yes`/`--name`/`--allow-name-pattern`) is checked here — this function is the mechanism;
 * `checkDeleteWorkspaceGuards` is the policy, already applied by `runDeleteWorkspace` before this
 * is ever called. Kept separate so an integration test can drive the mechanism directly, exactly
 * like `createWorkspace`/`addPrincipal` above. `actorUserId` (when the CLI could resolve one)
 * makes the cascade leave its `platform.workspace_purged` audit row, `forced: true` in the payload.
 */
export async function deleteWorkspace(
  pool: PoolLike,
  workspaceId: string,
  options: { readonly actorUserId?: string } = {},
): Promise<DeleteWorkspaceResult> {
  let purged: PurgeWorkspaceResultWire;
  try {
    purged = await purgeWorkspace(pool, {
      workspaceId,
      confirm: true,
      force: true,
      ...(options.actorUserId !== undefined ? { actorUserId: options.actorUserId } : {}),
    });
  } catch (err) {
    if (err instanceof PurgeWorkspaceRefusedError) {
      throw new DeleteWorkspaceRefusedError(err.message);
    }
    throw err;
  }
  return {
    workspaceId: purged.workspaceId,
    name: purged.name,
    principalIds: purged.principalIds,
    taskIds: purged.taskIds,
    deletedCounts: new Map(Object.entries(purged.counts)),
    purgedUsers: purged.purgedUsers,
  };
}

/**
 * Resolves the acting administrator for a CLI-driven purge's audit row: `--actor <login>` when
 * given (must exist — a typo must not silently drop the audit row), else the first login of
 * `NEXTTIME_PLATFORM_ADMINS` if that user exists, else `undefined` (no audit row; the caller
 * prints the structured stderr event and says so).
 */
async function resolveCliActor(
  pool: PoolLike,
  actorLogin: string | undefined,
): Promise<{ readonly id: string; readonly login: string } | undefined> {
  if (actorLogin !== undefined) {
    const user = await findUserByLogin(pool, actorLogin);
    if (!user) throw new BootstrapUsageError(`--actor: no user with login "${actorLogin}"`);
    return { id: user.id, login: user.login };
  }
  const [envAdmin] = envAdminLogins();
  if (envAdmin === undefined) return undefined;
  const user = await findUserByLogin(pool, envAdmin);
  return user ? { id: user.id, login: user.login } : undefined;
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

export class BootstrapUsageError extends Error {}

export interface DeleteWorkspaceCliArgs {
  readonly workspaceId: string;
  readonly yes: boolean;
  readonly expectedName?: string;
  readonly allowNamePattern?: RegExp;
}

/**
 * Parses `delete-workspace <workspaceId> --yes [--name <expected name>]
 * [--allow-name-pattern <regex>]`. Throws `BootstrapUsageError` only for what makes the
 * invocation itself malformed (no positional workspaceId, an `--allow-name-pattern` that is not
 * a valid regular expression) — never for a guard that depends on the workspace's actual stored
 * name; that is `checkDeleteWorkspaceGuards`'s job, run only once the name has been read back
 * from the database. Exported (unlike the other subcommands' inline `parseFlags` calls) so it —
 * and the guard function below — are unit-testable without a database, matching this
 * subcommand's own higher bar (destructive, operator-only) for argument-guard test coverage.
 */
export function parseDeleteWorkspaceArgs(argv: readonly string[]): DeleteWorkspaceCliArgs {
  const workspaceId = argv[0];
  if (workspaceId === undefined || workspaceId.startsWith('--')) {
    throw new BootstrapUsageError(
      'usage: bootstrap delete-workspace <workspaceId> --yes [--name <expected name>] ' +
        '[--allow-name-pattern <regex>]',
    );
  }

  const flags = parseFlags(argv.slice(1));
  const yes = argv.includes('--yes');
  const expectedName = flags.name;
  const allowNamePatternSource = flags['allow-name-pattern'];

  let allowNamePattern: RegExp | undefined;
  if (allowNamePatternSource !== undefined) {
    try {
      allowNamePattern = new RegExp(allowNamePatternSource);
    } catch (err) {
      throw new BootstrapUsageError(
        `usage: bootstrap delete-workspace: --allow-name-pattern is not a valid regular expression: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return { workspaceId, yes, expectedName, allowNamePattern };
}

export type DeleteWorkspaceGuardResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/**
 * The three refusal conditions `delete-workspace`'s own contract names, checked against the
 * workspace's *actual* stored name — never trust `--name` alone; catching a pasted-wrong-id
 * mistake is the whole point of that flag. Pure — no DB access — so every branch (missing
 * `--yes`, a `--name` mismatch, an `--allow-name-pattern` mismatch, and the passing case) is
 * unit-testable directly.
 */
export function checkDeleteWorkspaceGuards(
  args: DeleteWorkspaceCliArgs,
  actualName: string,
): DeleteWorkspaceGuardResult {
  if (!args.yes) {
    return { ok: false, reason: 'refusing to delete without --yes' };
  }
  if (args.expectedName !== undefined && args.expectedName !== actualName) {
    return {
      ok: false,
      reason:
        `--name "${args.expectedName}" does not match this workspace's stored name ` +
        `"${actualName}" — refusing in case the wrong id was pasted`,
    };
  }
  if (args.allowNamePattern !== undefined && !args.allowNamePattern.test(actualName)) {
    return {
      ok: false,
      reason:
        `workspace name "${actualName}" does not match --allow-name-pattern ` +
        `${args.allowNamePattern.source}`,
    };
  }
  return { ok: true };
}

async function runCreateWorkspace(argv: readonly string[]): Promise<void> {
  const flags = parseFlags(argv);
  const name = flags.name;
  const owner = flags.owner;
  const usage = `usage: bootstrap create-workspace --name <ws> --owner <display-name> [--entry-model <provider/id>] [--purpose standard|ephemeral] [--ttl <n>m|<n>h|<n>d, ephemeral only, default ${DEFAULT_EPHEMERAL_TTL}]`;
  if (!name || !owner) {
    throw new BootstrapUsageError(usage);
  }
  const purposeFlag = flags.purpose ?? 'standard';
  if (!(WORKSPACE_PURPOSE_VALUES as readonly string[]).includes(purposeFlag)) {
    throw new BootstrapUsageError(
      `${usage}\n--purpose must be standard or ephemeral (got "${purposeFlag}")`,
    );
  }
  const purpose = purposeFlag as WorkspacePurpose;
  if (flags.ttl !== undefined && purpose !== 'ephemeral') {
    throw new BootstrapUsageError(`${usage}\n--ttl is only valid with --purpose ephemeral`);
  }
  const expiresAt =
    purpose === 'ephemeral'
      ? new Date(Date.now() + parseTtl(flags.ttl ?? DEFAULT_EPHEMERAL_TTL))
      : null;

  const pool = createPool();
  try {
    const result = await createWorkspace(pool, name, owner, {
      entryModel: flags['entry-model'],
      purpose,
      expiresAt,
    });
    console.log(`workspace created: ${result.workspaceId}`);
    console.log(`owner principal:   ${result.ownerPrincipalId}`);
    console.log(`owner login:       ${result.ownerLogin}`);
    console.log(
      `purpose:           ${purpose}${expiresAt ? ` (expires ${expiresAt.toISOString()})` : ''}`,
    );
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
    console.log(`principal login:   ${result.login}`);
    console.log('');
    console.log('API key (shown once — store it securely, only its hash is kept):');
    console.log(result.apiKey);
  } finally {
    await pool.end();
  }
}

async function runRegisterGatekeeper(argv: readonly string[]): Promise<void> {
  const flags = parseFlags(argv);
  const workspaceId = flags.workspace;
  const principalId = flags.principal;
  const name = flags.name;
  const endpoint = flags.endpoint;
  const kindFlag = flags.kind;
  if (
    !workspaceId ||
    !principalId ||
    !name ||
    !endpoint ||
    !kindFlag ||
    !isGatekeeperTransportKind(kindFlag)
  ) {
    throw new BootstrapUsageError(
      'usage: bootstrap register-gatekeeper --workspace <id> --principal <id> --name <name> ' +
        '--endpoint <url> --kind <http|mcp|cli|ssh> [--target <target>] [--publish true]',
    );
  }

  const pool = createPool();
  try {
    const result = await registerGatekeeperFromCli(pool, {
      workspaceId,
      principalId,
      name,
      endpoint,
      transportKind: kindFlag,
      target: flags.target,
      publish: flags.publish === 'true',
    });
    console.log(`gatekeeper registered: ${result.gatekeeperId}`);
    console.log(
      `imported operations (draft): ${result.importedOperationNames.join(', ') || '(none)'}`,
    );
    if (result.skippedOperationNames.length > 0) {
      console.log(
        `skipped operations (already published/deprecated, left unchanged): ${result.skippedOperationNames.join(', ')}`,
      );
    }
    console.log(
      result.publishedOperationNames.length > 0
        ? `published operations: ${result.publishedOperationNames.join(', ')}`
        : 'published operations: (none — pass --publish true to publish every imported operation)',
    );
  } finally {
    await pool.end();
  }
}

async function runSeedDomainPack(argv: readonly string[]): Promise<void> {
  const flags = parseFlags(argv);
  const workspaceId = flags.workspace;
  const principalId = flags.principal;
  const packName = flags['pack-name'];
  if (!workspaceId || !principalId || !packName) {
    throw new BootstrapUsageError(
      'usage: bootstrap seed-domain-pack --workspace <id> --principal <id> --pack-name <name> ' +
        '[--file-name <file>] [--dir <dir>]',
    );
  }

  const dir = flags.dir ?? resolveDomainPackDir();
  const pool = createPool();
  try {
    const result = await seedDomainPackFromCli(pool, {
      workspaceId,
      principalId,
      packName,
      fileName: flags['file-name'],
      dir,
    });
    console.log(
      `domain pack published: ${packName} (id=${result.id}, version=${result.version}, from ${dir})`,
    );
  } finally {
    await pool.end();
  }
}

async function runIssueServiceHandle(argv: readonly string[]): Promise<void> {
  const flags = parseFlags(argv);
  const workspaceId = flags.workspace;
  const name = flags.name;
  const scopeFlag = flags.scope;
  if (!workspaceId || !name || !scopeFlag) {
    throw new BootstrapUsageError(
      'usage: bootstrap issue-service-handle --workspace <id> --name <name> ' +
        '--scope <cap1,cap2,...> [--ttl-days <n>]',
    );
  }
  const scope = scopeFlag
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const ttlDaysFlag = flags['ttl-days'];
  const ttlSeconds = ttlDaysFlag ? Number(ttlDaysFlag) * 24 * 60 * 60 : undefined;
  if (ttlDaysFlag && (!Number.isFinite(ttlSeconds) || (ttlSeconds ?? 0) <= 0)) {
    throw new BootstrapUsageError(
      `usage: bootstrap issue-service-handle: --ttl-days must be a positive number (got "${ttlDaysFlag}")`,
    );
  }

  const pool = createPool();
  try {
    const result = await issueServiceHandleFromCli(pool, { workspaceId, name, scope, ttlSeconds });
    console.log(`service principal: ${result.principalId}`);
    console.log(`session:            ${result.sessionId}`);
    console.log(`handle jti:         ${result.jti}`);
    console.log(`expires at:         ${result.expiresAt.toISOString()}`);
    console.log('');
    console.log(
      'Handle token (shown once — capture it now, e.g.: ... > ' +
        '${NEXTTIME_DATA}/secrets/<collector>.token — never printed again by this command):',
    );
    console.log(result.token);
  } finally {
    await pool.end();
  }
}

// -------------------------------------------------------------------------------------------
// create-platform-admin / set-password (S4.1): operator-run fallbacks for the platform users
// directory (docs/development-tasks.md S4.1, design doc §7.11) — reachable only by whoever can
// run a command inside the kernel container, same trust level as every other subcommand in this
// file. Neither ever takes a password on the command line (shell history, `ps`, process-list
// snapshots): both read the whole of stdin instead, trimmed of a single trailing newline.
// -------------------------------------------------------------------------------------------

/** Reads all of stdin and returns it decoded as UTF-8, with a single trailing `\n` (or `\r\n`)
 *  stripped — the password itself is never echoed, logged, or included in any error message. */
async function readStdinPassword(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks)
    .toString('utf8')
    .replace(/\r?\n$/, '');
}

const CREATE_PLATFORM_ADMIN_USAGE =
  'usage: bootstrap create-platform-admin --login <login> [--display-name <name>] ' +
  '[--temporary] (password is read from stdin)';

/** `create-platform-admin --login <login> [--display-name <name>] [--temporary]`: the CLI
 *  fallback for minting the first (or an additional) platform administrator without going
 *  through `POST /api/platform/setup` — see `application/identity/setup.ts`'s own doc comment on
 *  `createPlatformAdmin`. `--temporary` sets `must_change_password`, same shape as an admin
 *  setting someone else's password via the console. Never prints the password. */
async function runCreatePlatformAdmin(argv: readonly string[]): Promise<void> {
  const flags = parseFlags(argv);
  const login = flags.login;
  const displayName = flags['display-name'];
  const temporary = argv.includes('--temporary');
  if (!login) {
    throw new BootstrapUsageError(CREATE_PLATFORM_ADMIN_USAGE);
  }

  const password = await readStdinPassword();
  if (password.length === 0) {
    throw new BootstrapUsageError(CREATE_PLATFORM_ADMIN_USAGE);
  }

  const pool = createPool();
  try {
    const user = await createPlatformAdmin(pool, {
      login,
      displayName: displayName ?? login,
      password,
      mustChangePassword: temporary,
    });
    console.log(`platform admin created: ${user.id}`);
    console.log(`login: ${login}`);
  } finally {
    await pool.end();
  }
}

const SET_PASSWORD_USAGE =
  'usage: bootstrap set-password --login <login> [--temporary] (password is read from stdin)';

/** `set-password --login <login> [--temporary]`: gives an existing user (e.g. a backfilled or
 *  CLI-created passwordless one — `ensureUserForHumanPrincipal`'s own doc comment) a first, or
 *  replacement, password. `--temporary` sets `must_change_password`. Refuses (exit 1) if no user
 *  has that login. Never prints the password. */
async function runSetPassword(argv: readonly string[]): Promise<void> {
  const flags = parseFlags(argv);
  const login = flags.login;
  const temporary = argv.includes('--temporary');
  if (!login) {
    throw new BootstrapUsageError(SET_PASSWORD_USAGE);
  }

  const password = await readStdinPassword();
  if (password.length === 0) {
    throw new BootstrapUsageError(SET_PASSWORD_USAGE);
  }

  const pool = createPool();
  try {
    const user = await findUserByLogin(pool, login);
    if (!user) {
      throw new Error(`no such user: ${login}`);
    }
    await setUserPassword(pool, user.id, password, { mustChangePassword: temporary });
    console.log(`password set for: ${login}`);
    if (temporary) {
      console.log('must_change_password: true');
    }
  } finally {
    await pool.end();
  }
}

/** The `PRINCIPAL=<id>` / `TASK=<id>` stdout contract `scripts/delete-workspace.sh` reads: the
 *  last thing written to **stdout**, nothing after it, so a caller that captures only stdout gets
 *  a clean, trailing, greppable id list. `PURGED_USER=<login>` lines are informational (no
 *  host-side state belongs to a user). */
function printHostCleanupLines(result: {
  readonly principalIds: readonly string[];
  readonly taskIds: readonly string[];
  readonly purgedUsers: readonly { readonly login: string }[];
}): void {
  for (const user of result.purgedUsers) {
    console.log(`PURGED_USER=${user.login}`);
  }
  for (const principalId of result.principalIds) {
    console.log(`PRINCIPAL=${principalId}`);
  }
  for (const taskId of result.taskIds) {
    console.log(`TASK=${taskId}`);
  }
}

function printInspection(info: WorkspaceInspection): void {
  console.log(`workspace:  ${info.workspaceId}`);
  console.log(`name:       ${info.name}`);
  console.log(`created_at: ${info.createdAt.toISOString()}`);
  console.log(`principals: ${info.principalCount}`);
  console.log(`tasks:      ${info.taskCount}`);
}

function printPurgeSummary(purged: PurgeWorkspaceResultWire, verb: string): void {
  console.log('');
  console.log(`${verb} rows per table:`);
  for (const [table, count] of Object.entries(purged.counts)) {
    console.log(`  ${table}: ${count}`);
  }
  console.log(`  total: ${purged.totalRows}`);
  if (purged.activeHandles > 0) {
    console.log(`  live CapabilityHandles revoked: ${purged.activeHandles}`);
  }
  for (const warning of purged.warnings) {
    console.log(
      `WARNING ${warning.kind}: service Principal ${warning.principalId} (${warning.name ?? '-'}) ` +
        `has ${warning.activeHandles} live Handle(s) — a collector or external runtime presenting one starts failing with 401 now`,
    );
  }
  if (purged.purgedUsers.length > 0) {
    console.log(
      `${verb} never-activated users: ${purged.purgedUsers.map((u) => u.login).join(', ')}`,
    );
  }
}

/** The structured stderr event — always printed alongside the `platform.workspace_purged` audit
 *  row `purgeWorkspace` itself now always writes (遗留 54), whether or not a real administrator
 *  could be named (see the section doc comment). */
function printPurgeEvent(
  purged: PurgeWorkspaceResultWire,
  actor: { readonly login: string } | undefined,
  forced: boolean,
): void {
  console.error(
    JSON.stringify({
      event: 'workspace_purged',
      workspaceId: purged.workspaceId,
      workspaceName: purged.name,
      purpose: purged.purpose,
      reason: purged.reason,
      forced,
      purgedAt: new Date().toISOString(),
      actorLogin: actor?.login ?? null,
      attributedActor: actor !== undefined,
      principalCount: purged.principalIds.length,
      taskCount: purged.taskIds.length,
      purgedUsers: purged.purgedUsers.map((u) => u.login),
      counts: purged.counts,
    }),
  );
  if (actor === undefined) {
    console.error(
      'purge: no acting administrator resolved (pass --actor <login> or set NEXTTIME_PLATFORM_ADMINS) — the platform audit row was still written, recorded as an unattributed host-operator action (payload.attributedActor: false)',
    );
  }
}

/**
 * `delete-workspace <workspaceId> --yes [--name <expected name>] [--allow-name-pattern <regex>]
 * [--actor <login>]` — the legacy operator override (no purge preconditions). Always reads and
 * prints the workspace's info first (name/created_at/principal count/task count — "before
 * acting"), *then* checks every guard, *then* — only if every guard passes — calls
 * `deleteWorkspace`. A guard failure (including "not found") throws
 * `DeleteWorkspaceRefusedError` after the info is printed but before anything is deleted.
 *
 * Output contract for `scripts/delete-workspace.sh`: the structured `workspace_purged` event
 * line goes to **stderr**; the `PRINCIPAL=<id>` / `TASK=<id>` lines are the last thing written
 * to **stdout** (`printHostCleanupLines`).
 */
async function runDeleteWorkspace(argv: readonly string[]): Promise<void> {
  const args = parseDeleteWorkspaceArgs(argv);
  const flags = parseFlags(argv.slice(1));

  const pool = createPool();
  try {
    const info = await inspectWorkspace(pool, args.workspaceId);
    if (!info) {
      throw new DeleteWorkspaceRefusedError(`workspace not found: ${args.workspaceId}`);
    }
    printInspection(info);

    const guard = checkDeleteWorkspaceGuards(args, info.name);
    if (!guard.ok) {
      throw new DeleteWorkspaceRefusedError(`delete-workspace refused: ${guard.reason}`);
    }

    const actor = await resolveCliActor(pool, flags.actor);
    console.log('');
    console.log(
      'delete-workspace: operator override — the purge preconditions (disabled >= 7 days, or expired ephemeral) are NOT checked',
    );
    let purged: PurgeWorkspaceResultWire;
    try {
      purged = await purgeWorkspace(pool, {
        workspaceId: args.workspaceId,
        confirm: true,
        force: true,
        ...(actor ? { actorUserId: actor.id } : {}),
      });
    } catch (err) {
      if (err instanceof PurgeWorkspaceRefusedError) {
        throw new DeleteWorkspaceRefusedError(err.message);
      }
      throw err;
    }

    printPurgeSummary(purged, 'deleted');
    console.log('');
    console.log(`workspace deleted: ${purged.workspaceId} (${purged.name})`);
    printPurgeEvent(purged, actor, true);
    console.log('');
    printHostCleanupLines(purged);
  } finally {
    await pool.end();
  }
}

export interface PurgeWorkspaceCliArgs {
  readonly workspaceId: string;
  readonly yes: boolean;
  readonly dryRun: boolean;
  readonly expectedName?: string;
  readonly actorLogin?: string;
}

/**
 * Parses `purge-workspace <workspaceId> [--yes | --dry-run] [--name <expected name>]
 * [--actor <login>]`. Neither `--yes` nor `--dry-run` is the same as `--dry-run` (the safe
 * default — nothing deleted); `--yes` executes. Exported for the same reason
 * `parseDeleteWorkspaceArgs` is (destructive, operator-only: unit-tested without a database).
 */
export function parsePurgeWorkspaceArgs(argv: readonly string[]): PurgeWorkspaceCliArgs {
  const workspaceId = argv[0];
  if (workspaceId === undefined || workspaceId.startsWith('--')) {
    throw new BootstrapUsageError(
      'usage: bootstrap purge-workspace <workspaceId> [--yes | --dry-run] [--name <expected name>] [--actor <login>]',
    );
  }
  const flags = parseFlags(argv.slice(1));
  const yes = argv.includes('--yes');
  const dryRun = argv.includes('--dry-run');
  if (yes && dryRun) {
    throw new BootstrapUsageError(
      'usage: bootstrap purge-workspace: --yes and --dry-run are exclusive',
    );
  }
  return {
    workspaceId,
    yes,
    dryRun: !yes,
    ...(flags.name !== undefined ? { expectedName: flags.name } : {}),
    ...(flags.actor !== undefined ? { actorLogin: flags.actor } : {}),
  };
}

/**
 * `purge-workspace <workspaceId> [--yes | --dry-run] [--name <expected name>] [--actor <login>]`
 * — the governed `purge_workspace` capability's operator twin (S6 §5.2): same preconditions,
 * same cascade, same `platform.workspace_purged` audit row (when an actor resolves). Without
 * `--yes` it is the capability's preview — the counts, warnings and users a purge would remove,
 * nothing written — printed and exit 0; a precondition failure prints the refusal and exits 1
 * either way. Same stdout / stderr contract as `delete-workspace` above.
 */
async function runPurgeWorkspace(argv: readonly string[]): Promise<void> {
  const args = parsePurgeWorkspaceArgs(argv);
  const pool = createPool();
  try {
    const info = await inspectWorkspace(pool, args.workspaceId);
    if (!info) {
      throw new DeleteWorkspaceRefusedError(`workspace not found: ${args.workspaceId}`);
    }
    printInspection(info);
    if (args.expectedName !== undefined && args.expectedName !== info.name) {
      throw new DeleteWorkspaceRefusedError(
        `purge-workspace refused: --name "${args.expectedName}" does not match this workspace's stored name "${info.name}" — refusing in case the wrong id was pasted`,
      );
    }
    const actor = args.yes ? await resolveCliActor(pool, args.actorLogin) : undefined;

    let purged: PurgeWorkspaceResultWire;
    try {
      purged = await purgeWorkspace(pool, {
        workspaceId: args.workspaceId,
        confirm: args.yes,
        ...(actor ? { actorUserId: actor.id } : {}),
      });
    } catch (err) {
      if (err instanceof PurgeWorkspaceRefusedError) {
        throw new DeleteWorkspaceRefusedError(
          `purge-workspace refused (${err.code}): ${err.message}`,
        );
      }
      throw err;
    }

    console.log(`eligible:   ${purged.reason}`);
    if (!purged.executed) {
      printPurgeSummary(purged, 'would delete');
      console.log('');
      console.log(
        `dry run — nothing deleted. Re-run with --yes to purge workspace ${purged.workspaceId} (${purged.name}).`,
      );
      return;
    }
    printPurgeSummary(purged, 'deleted');
    console.log('');
    console.log(`workspace purged: ${purged.workspaceId} (${purged.name})`);
    printPurgeEvent(purged, actor, false);
    console.log('');
    printHostCleanupLines(purged);
  } finally {
    await pool.end();
  }
}

/**
 * `purge-expired-workspaces [--yes] [--include-disabled] [--actor <login>]` — the bulk form
 * `scripts/delete-workspaces-matching.sh --expired` drives. Selects every `ephemeral` workspace
 * whose `expires_at` has passed (the S5.3 `--expired` rule, unchanged) and, with
 * `--include-disabled`, every workspace `purge_workspace` would accept for having been disabled
 * for 7 days (or before migration 0030); never the platform default workspace — the same
 * `assessPurgeEligibility` the capability uses, on the database's own clock.
 *
 * Without `--yes`: prints one `WORKSPACE=<id>\t<name>\t<reason>` line per candidate to stdout and
 * exits 0 — the wrapper script reads these and drives `scripts/delete-workspace.sh` per row (so
 * each purge gets the `--name` guard and its own host-side cleanup). With `--yes`: purges them
 * one by one, continuing past a refusal, and prints every purged workspace's `PRINCIPAL=` /
 * `TASK=` lines; exits 1 if any purge failed.
 */
async function runPurgeExpiredWorkspaces(argv: readonly string[]): Promise<void> {
  const flags = parseFlags(argv);
  const yes = argv.includes('--yes');
  const includeDisabled = argv.includes('--include-disabled');
  const pool = createPool();
  try {
    const workspaces = await listWorkspaces(pool);
    const defaultWorkspaceId = await withWorkspace(
      pool,
      { workspaceId: randomUUID(), principalId: randomUUID() },
      async (client) => (await readPlatformSettings(client)).settings.defaultWorkspaceId,
      { skipRoleSwitch: true },
    );
    const candidates = workspaces.flatMap((ws) => {
      if (ws.id === defaultWorkspaceId) return [];
      const eligibility = assessPurgeEligibility({
        status: ws.status,
        purpose: ws.purpose,
        expiresAt: ws.expiresAt,
        disabledAt: ws.disabledAt,
      });
      if (!eligibility.eligible) return [];
      if (eligibility.reason === 'disabled_retention_elapsed' && !includeDisabled) return [];
      return [{ ws, reason: eligibility.reason }];
    });

    if (candidates.length === 0) {
      console.error('purge-expired-workspaces: no purgeable workspace');
      return;
    }
    if (!yes) {
      for (const { ws, reason } of candidates) {
        console.log(`WORKSPACE=${ws.id}\t${ws.name}\t${reason}`);
      }
      console.error(
        `purge-expired-workspaces: ${candidates.length} purgeable workspace(s) listed — dry run, nothing deleted (re-run with --yes)`,
      );
      return;
    }

    const actor = await resolveCliActor(pool, flags.actor);
    let failed = 0;
    for (const { ws } of candidates) {
      try {
        const purged = await purgeWorkspace(pool, {
          workspaceId: ws.id,
          confirm: true,
          ...(actor ? { actorUserId: actor.id } : {}),
        });
        console.error(
          `purge-expired-workspaces: purged ${ws.id} (${ws.name}) — ${purged.totalRows} row(s)`,
        );
        printPurgeEvent(purged, actor, false);
        printHostCleanupLines(purged);
      } catch (err) {
        failed += 1;
        console.error(
          `purge-expired-workspaces: failed to purge ${ws.id} (${ws.name}): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (failed > 0) {
      throw new DeleteWorkspaceRefusedError(
        `purge-expired-workspaces: ${failed}/${candidates.length} purge(s) failed — see above`,
      );
    }
    console.error(`purge-expired-workspaces: done — ${candidates.length} workspace(s) purged`);
  } finally {
    await pool.end();
  }
}

async function runListWorkspaces(): Promise<void> {
  const pool = createPool();
  try {
    const workspaces = await listWorkspaces(pool);
    // Columns are appended, never reordered: scripts/delete-workspaces-matching.sh reads $1 / $2
    // for the regex mode; $6 / $7 (`--expired`, S5.3) are kept for anyone still selecting on them,
    // and S6 appends $8 / $9 (`status`, `disabled_at`).
    console.log(
      'id\tname\tcreated_at\tprincipals\ttasks\tpurpose\texpires_at\tstatus\tdisabled_at',
    );
    for (const ws of workspaces) {
      console.log(
        `${ws.id}\t${ws.name}\t${ws.createdAt.toISOString()}\t${ws.principalCount}\t${ws.taskCount}` +
          `\t${ws.purpose}\t${ws.expiresAt ? ws.expiresAt.toISOString() : '-'}` +
          `\t${ws.status}\t${ws.disabledAt ? ws.disabledAt.toISOString() : '-'}`,
      );
    }
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
  if (command === 'register-gatekeeper') {
    await runRegisterGatekeeper(rest);
    return;
  }
  if (command === 'delete-workspace') {
    await runDeleteWorkspace(rest);
    return;
  }
  if (command === 'list-workspaces') {
    await runListWorkspaces();
    return;
  }
  if (command === 'purge-workspace') {
    await runPurgeWorkspace(rest);
    return;
  }
  if (command === 'purge-expired-workspaces') {
    await runPurgeExpiredWorkspaces(rest);
    return;
  }
  if (command === 'seed-domain-pack') {
    await runSeedDomainPack(rest);
    return;
  }
  if (command === 'issue-service-handle') {
    await runIssueServiceHandle(rest);
    return;
  }
  if (command === 'create-platform-admin') {
    await runCreatePlatformAdmin(rest);
    return;
  }
  if (command === 'set-password') {
    await runSetPassword(rest);
    return;
  }
  throw new BootstrapUsageError(
    'usage: bootstrap create-workspace --name <ws> --owner <display-name> [--entry-model <provider/id>] ' +
      '[--purpose standard|ephemeral] [--ttl <n>m|<n>h|<n>d]\n' +
      '   or: bootstrap add-principal --workspace <id> --name <display-name> [--role <role>]\n' +
      '   or: bootstrap register-gatekeeper --workspace <id> --principal <id> --name <name> ' +
      '--endpoint <url> --kind <http|mcp|cli|ssh> [--target <target>] [--publish true]\n' +
      '   or: bootstrap delete-workspace <workspaceId> --yes [--name <expected name>] ' +
      '[--allow-name-pattern <regex>] [--actor <login>]\n' +
      '   or: bootstrap list-workspaces\n' +
      '   or: bootstrap purge-workspace <workspaceId> [--yes | --dry-run] [--name <expected name>] ' +
      '[--actor <login>]\n' +
      '   or: bootstrap purge-expired-workspaces [--yes] [--include-disabled] [--actor <login>]\n' +
      '   or: bootstrap seed-domain-pack --workspace <id> --principal <id> --pack-name <name> ' +
      '[--file-name <file>] [--dir <dir>]\n' +
      '   or: bootstrap issue-service-handle --workspace <id> --name <name> ' +
      '--scope <cap1,cap2,...> [--ttl-days <n>]\n' +
      '   or: bootstrap create-platform-admin --login <login> [--display-name <name>] ' +
      '[--temporary] (password is read from stdin)\n' +
      '   or: bootstrap set-password --login <login> [--temporary] (password is read from stdin)',
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
