import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Role, RoleSchema, type WorkerDefinitionKind } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { parse as parseYaml } from 'yaml';
import { createPool, withWorkspace } from '../adapters/db/pool.js';
import type { PoolLike } from '../adapters/db/pool.js';
import { HttpGatekeeperClient } from '../adapters/gatekeeper-client/index.js';
import type { GatekeeperClient } from '../adapters/gatekeeper-client/index.js';
import { generateApiKey, hashApiKey } from '../application/gateway/index.js';
import { proposeWorkerDefinition, publishWorkerDefinition } from '../application/worker/index.js';
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
 *   node dist/cli/bootstrap.js create-workspace --name <ws> --owner <display-name> [--entry-model <provider/id>]
 *   node dist/cli/bootstrap.js add-principal --workspace <id> --name <display-name> [--role <role>]
 *   node dist/cli/bootstrap.js list-workspaces
 *   node dist/cli/bootstrap.js delete-workspace <workspaceId> --yes [--name <expected name>] [--allow-name-pattern <regex>]
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
 * `delete-workspace`/`list-workspaces` (operator-only, destructive workspace teardown — see the
 * doc comment above `discoverWorkspaceScopedSchema` below for the full deletion-order/append-only
 * -trigger rationale): the host-operator cleanup path for the throwaway workspaces acceptance/
 * smoke runs accumulate. Deliberately CLI-only — this is never registered as a capability, so no
 * Handle/agent path can ever reach it, regardless of what it is granted. `list-workspaces` prints
 * every Workspace (id, name, created_at, principal/task counts) so an operator can pick a target
 * — or a `--allow-name-pattern` — with real numbers in front of them, not guesswork.
 * `delete-workspace` refuses without `--yes`, optionally cross-checks `--name` against the
 * workspace's actual stored name (guards against a pasted-wrong-id mistake) and/or
 * `--allow-name-pattern` against it (a bulk-run safety net), always prints what it found *before*
 * checking any of that, and — once every guard passes — deletes the Workspace and every row any
 * workspace-scoped table holds for it in one transaction, then prints machine-readable
 * `PRINCIPAL=<id>`/`TASK=<id>` lines so `scripts/delete-workspace.sh` can remove the matching
 * host-side container and data directory (docs/runbooks/host-bootstrap.md "Deleting a workspace").
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
// delete-workspace / list-workspaces — operator-only, destructive workspace teardown. CLI-only
// by design (task brief: "CLI only, never a capability an agent can call"): the only entry point
// is this file's `run()` dispatch table below, driven by a human operator — directly, or via the
// host wrapper script that runs this file's compiled output inside the compose project's
// `kernel` service (scripts/delete-workspace.sh) — nothing in the governed Handle/capability
// system (`packages/shared/src/capabilities.ts`) ever names this operation, so no Worker or
// entry agent can reach it no matter what it is granted.
//
// Host-side cleanup (the workspace's stopped resident entry container,
// `${NEXTTIME_DATA}/workspaces/<principalId>` and `.../workspaces/tasks/<taskId>` data dirs) is
// deliberately NOT done here: this file lives under `packages/kernel/src`, which
// `scripts/check-kernel-purity.sh` scans for concrete system/vendor names — the kernel is
// mechanism, not content (design doc §7.10). That cleanup is `scripts/delete-workspace.sh`'s job,
// driven by this subcommand's own `PRINCIPAL=`/`TASK=` output lines (see `runDeleteWorkspace`).
//
// Deletion order (task brief): every table that carries a `workspace_id` column has a composite
// `(workspace_id, id[, version])` primary key and, wherever it references another such table, a
// matching composite foreign key — always the Postgres default `no action`, never `on delete
// cascade` (verified against every migrations/**/*.sql file: no `on delete` clause exists
// anywhere in this schema). So a bare `delete from workspaces where id = $1` fails on the first
// principal still referencing it, and a bare per-table sweep in the wrong order fails the same
// way one level down. `discoverWorkspaceScopedSchema` reads the *live* schema (information_schema
// + pg_constraint) rather than hardcoding a table list, so a future migration that adds a new
// workspace-scoped table is picked up automatically; `computeWorkspaceTableDeletionOrder`
// topologically sorts it into a safe order (children — the referencing side — before parents).
// -------------------------------------------------------------------------------------------

export interface ForeignKeyEdge {
  readonly childTable: string;
  readonly parentTable: string;
}

export interface WorkspaceScopedSchema {
  readonly tables: readonly string[];
  readonly foreignKeys: readonly ForeignKeyEdge[];
}

/**
 * Reads every `public` table with a `workspace_id` column, and every foreign key constraint
 * between two such tables, from the live schema — the raw input
 * `computeWorkspaceTableDeletionOrder` turns into a safe per-table delete order. Runtime
 * discovery, not a table list maintained by hand in this file, so it never drifts from whatever
 * `packages/kernel/migrations/**\/*.sql` actually declares.
 */
export async function discoverWorkspaceScopedSchema(
  client: PoolClient,
): Promise<WorkspaceScopedSchema> {
  const tablesResult = await client.query<{ table_name: string }>(
    `select distinct table_name
     from information_schema.columns
     where table_schema = 'public' and column_name = 'workspace_id'`,
  );
  const tables = tablesResult.rows.map((row) => row.table_name).sort();

  const foreignKeysResult = await client.query<{ child_table: string; parent_table: string }>(
    `select child.relname as child_table, parent.relname as parent_table
     from pg_constraint c
     join pg_class child on child.oid = c.conrelid
     join pg_class parent on parent.oid = c.confrelid
     join pg_namespace ns on ns.oid = child.relnamespace
     where c.contype = 'f' and ns.nspname = 'public'`,
  );
  const foreignKeys = foreignKeysResult.rows.map((row) => ({
    childTable: row.child_table,
    parentTable: row.parent_table,
  }));

  return { tables, foreignKeys };
}

export class WorkspaceDeletionOrderCycleError extends Error {
  constructor(remainingTables: readonly string[]) {
    super(
      `delete-workspace: cannot compute a safe deletion order — cyclic foreign keys among: ${remainingTables.join(', ')}`,
    );
    this.name = 'WorkspaceDeletionOrderCycleError';
  }
}

/**
 * Topologically sorts `schema.tables` so that every table is deleted before every other table it
 * holds a foreign key to (Kahn's algorithm: a table becomes eligible once nothing still in the
 * graph references it) — exactly the order a bare `delete from <table> where workspace_id = $1`
 * per table needs to never hit a "no action" FK violation.
 *
 * Self-referencing foreign keys (`links.supersedes_id`, `capability_handles.parent_jti`,
 * `worker_runs.parent_worker_run_id`) need no ordering at all — a single `delete ... where
 * workspace_id = $1` statement removes every row of that table together, satisfying its own
 * self-FK regardless of which row the constraint machinery happens to check first — so an edge
 * from a table to itself is dropped before building the graph, not treated as a 1-node cycle.
 *
 * Pure — no DB access — so the topology (including the self-reference and multi-level-chain
 * cases) is unit-testable against a fabricated `WorkspaceScopedSchema`, independent of the live
 * schema `discoverWorkspaceScopedSchema` reads. Throws `WorkspaceDeletionOrderCycleError` if a
 * genuine (non-self) cycle makes no valid order possible — not expected against this codebase's
 * actual schema, but a real possibility for a fabricated/future one, so left as a hard failure
 * rather than a silently-wrong partial order.
 */
export function computeWorkspaceTableDeletionOrder(schema: WorkspaceScopedSchema): string[] {
  const tables = new Set(schema.tables);
  const inDegree = new Map<string, number>();
  // childTable -> the parentTables it must be deleted before (its own outgoing foreign keys).
  const mustPrecede = new Map<string, string[]>();

  for (const table of tables) {
    inDegree.set(table, 0);
    mustPrecede.set(table, []);
  }

  for (const edge of schema.foreignKeys) {
    if (edge.childTable === edge.parentTable) continue;
    if (!tables.has(edge.childTable) || !tables.has(edge.parentTable)) continue;
    mustPrecede.get(edge.childTable)?.push(edge.parentTable);
    inDegree.set(edge.parentTable, (inDegree.get(edge.parentTable) ?? 0) + 1);
  }

  // Nothing (still in the graph) references a zero-in-degree table — it is safe to delete first.
  const ready = [...tables].filter((table) => inDegree.get(table) === 0).sort();
  const order: string[] = [];

  while (ready.length > 0) {
    ready.sort();
    const table = ready.shift();
    if (table === undefined) break;
    order.push(table);
    for (const parent of mustPrecede.get(table) ?? []) {
      const remaining = (inDegree.get(parent) ?? 0) - 1;
      inDegree.set(parent, remaining);
      if (remaining === 0) ready.push(parent);
    }
  }

  if (order.length !== tables.size) {
    const remaining = [...tables].filter((table) => !order.includes(table));
    throw new WorkspaceDeletionOrderCycleError(remaining);
  }

  return order;
}

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
      }>(
        `select
           w.id,
           w.name,
           w.created_at,
           (select count(*) from principals p where p.workspace_id = w.id)::bigint as principal_count,
           (select count(*) from tasks t where t.workspace_id = w.id)::bigint as task_count
         from workspaces w
         order by w.created_at asc`,
      );
      return result.rows.map((row) => ({
        id: row.id,
        name: row.name,
        createdAt: row.created_at,
        principalCount: Number(row.principal_count),
        taskCount: Number(row.task_count),
      }));
    },
    { skipRoleSwitch: true },
  );
}

/** Thrown for `delete-workspace` refusals that depend on runtime state (workspace not found, a
 *  guard in `checkDeleteWorkspaceGuards` failed) — distinct from `BootstrapUsageError`, which
 *  this file reserves for a malformed invocation (bad flags/missing required args, independent of
 *  what is actually in the database). */
export class DeleteWorkspaceRefusedError extends Error {}

const LINKS_DELETE_TRIGGER = 'links_immutable_delete';
const AUDIT_RECORDS_DELETE_TRIGGER = 'audit_records_no_delete';

/** Matches a bare lowercase Postgres identifier. Every table name `deleteWorkspace` ever builds
 *  a dynamic `delete from "<table>"` statement for comes from `discoverWorkspaceScopedSchema`
 *  (information_schema/pg_constraint — real catalog data, never CLI input), so this is cheap
 *  defense-in-depth against building a malformed statement, not a real injection concern. */
const SAFE_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

export interface DeleteWorkspaceResult {
  readonly workspaceId: string;
  readonly name: string;
  /** Every `principals.id` that belonged to this workspace, read back before any row was
   *  deleted — `runDeleteWorkspace` prints these as `PRINCIPAL=<id>` lines so
   *  `scripts/delete-workspace.sh` can remove the matching `nexttime-entry-<id>` container and
   *  `${NEXTTIME_DATA}/workspaces/<id>` data dir (host-side; see this section's own doc comment
   *  for why that cleanup does not live here). */
  readonly principalIds: readonly string[];
  /** Every `tasks.id` that belonged to this workspace, read back the same way — printed as
   *  `TASK=<id>` lines for the matching `${NEXTTIME_DATA}/workspaces/tasks/<id>` data dir. */
  readonly taskIds: readonly string[];
  /** Rows actually deleted from each workspace-scoped table, in the order they were deleted
   *  (children before parents — see `computeWorkspaceTableDeletionOrder`). */
  readonly deletedCounts: ReadonlyMap<string, number>;
}

/**
 * Deletes a Workspace and every row any workspace-scoped table holds for it, in one transaction,
 * over the admin/skip-role-switch path `createWorkspace` above already establishes (bypasses RLS
 * the same way). No guard (`--yes`/`--name`/`--allow-name-pattern`) is checked here — this
 * function is the mechanism; `checkDeleteWorkspaceGuards` is the policy, already applied by
 * `runDeleteWorkspace` before this is ever called. Kept separate so an integration test can drive
 * the mechanism directly, exactly like `createWorkspace`/`addPrincipal` above.
 *
 * `links` (I4) and `audit_records` (I11) are append-only — each has a `before delete` trigger
 * (`links_immutable_delete` / `audit_records_no_delete`, migrations/core/0002_substrate.sql and
 * 0004_audit.sql) that unconditionally raises, regardless of role, so even this RLS-bypassing
 * admin connection cannot delete a row in either table without first disabling that trigger. This
 * is the one deliberate, audited override of those two invariants anywhere in this codebase: full
 * workspace teardown is an operator-only, machine-logged action (`runDeleteWorkspace`'s stderr
 * `workspace_deleted` line), never something application code can trigger — nothing else in
 * `packages/kernel/src` ever runs this statement. Both triggers are re-enabled before COMMIT
 * (`alter table ... enable trigger` is DDL, so it must happen inside the same transaction that
 * disabled them — leaving either disabled past COMMIT would silently and permanently remove that
 * invariant for every future write, not just this one).
 */
export async function deleteWorkspace(
  pool: PoolLike,
  workspaceId: string,
): Promise<DeleteWorkspaceResult> {
  return withWorkspace(
    pool,
    { workspaceId, principalId: randomUUID() },
    async (client) => {
      const name = (
        await client.query<{ name: string }>('select name from workspaces where id = $1', [
          workspaceId,
        ])
      ).rows[0]?.name;
      if (name === undefined) {
        throw new DeleteWorkspaceRefusedError(`workspace not found: ${workspaceId}`);
      }

      const principalIds = (
        await client.query<{ id: string }>('select id from principals where workspace_id = $1', [
          workspaceId,
        ])
      ).rows.map((row) => row.id);
      const taskIds = (
        await client.query<{ id: string }>('select id from tasks where workspace_id = $1', [
          workspaceId,
        ])
      ).rows.map((row) => row.id);

      const schema = await discoverWorkspaceScopedSchema(client);
      const order = computeWorkspaceTableDeletionOrder(schema);

      if (order.includes('links')) {
        await client.query(`alter table links disable trigger ${LINKS_DELETE_TRIGGER}`);
      }
      if (order.includes('audit_records')) {
        await client.query(
          `alter table audit_records disable trigger ${AUDIT_RECORDS_DELETE_TRIGGER}`,
        );
      }

      const deletedCounts = new Map<string, number>();
      for (const table of order) {
        if (!SAFE_IDENTIFIER.test(table)) {
          throw new Error(
            `delete-workspace: refusing to delete from unexpected table name "${table}"`,
          );
        }
        const result = await client.query(`delete from "${table}" where workspace_id = $1`, [
          workspaceId,
        ]);
        deletedCounts.set(table, result.rowCount ?? 0);
      }

      if (order.includes('audit_records')) {
        await client.query(
          `alter table audit_records enable trigger ${AUDIT_RECORDS_DELETE_TRIGGER}`,
        );
      }
      if (order.includes('links')) {
        await client.query(`alter table links enable trigger ${LINKS_DELETE_TRIGGER}`);
      }

      const deletedWorkspace = await client.query('delete from workspaces where id = $1', [
        workspaceId,
      ]);
      if ((deletedWorkspace.rowCount ?? 0) !== 1) {
        throw new DeleteWorkspaceRefusedError(
          `workspace row vanished during its own deletion: ${workspaceId}`,
        );
      }

      return { workspaceId, name, principalIds, taskIds, deletedCounts };
    },
    { skipRoleSwitch: true },
  );
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

  const pool = createPool();
  try {
    const result = await seedDomainPackFromCli(pool, {
      workspaceId,
      principalId,
      packName,
      fileName: flags['file-name'],
      dir: flags.dir,
    });
    console.log(`domain pack published: ${packName} (id=${result.id}, version=${result.version})`);
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

/**
 * `delete-workspace <workspaceId> --yes [--name <expected name>] [--allow-name-pattern <regex>]`.
 * Always reads and prints the workspace's info first (name/created_at/principal count/task
 * count — task brief: "before acting"), *then* checks every guard, *then* — only if every guard
 * passes — calls `deleteWorkspace`. A guard failure (including "not found") throws
 * `DeleteWorkspaceRefusedError` after the info is printed but before anything is deleted.
 *
 * Output contract for `scripts/delete-workspace.sh`: the structured `workspace_deleted` audit
 * line (task brief: "log a structured line to stdout/stderr" in place of an `audit_records` row,
 * since that table is itself being deleted) goes to **stderr**, and the `PRINCIPAL=<id>` /
 * `TASK=<id>` lines are the last thing written to **stdout** — so a caller that captures only
 * stdout gets a clean, trailing, greppable id list with nothing after it.
 */
async function runDeleteWorkspace(argv: readonly string[]): Promise<void> {
  const args = parseDeleteWorkspaceArgs(argv);

  const pool = createPool();
  try {
    const info = await inspectWorkspace(pool, args.workspaceId);
    if (!info) {
      throw new DeleteWorkspaceRefusedError(`workspace not found: ${args.workspaceId}`);
    }

    console.log(`workspace:  ${info.workspaceId}`);
    console.log(`name:       ${info.name}`);
    console.log(`created_at: ${info.createdAt.toISOString()}`);
    console.log(`principals: ${info.principalCount}`);
    console.log(`tasks:      ${info.taskCount}`);

    const guard = checkDeleteWorkspaceGuards(args, info.name);
    if (!guard.ok) {
      throw new DeleteWorkspaceRefusedError(`delete-workspace refused: ${guard.reason}`);
    }

    const result = await deleteWorkspace(pool, args.workspaceId);

    console.log('');
    console.log('deleted rows per table:');
    for (const [table, count] of result.deletedCounts) {
      console.log(`  ${table}: ${count}`);
    }
    console.log('');
    console.log(`workspace deleted: ${result.workspaceId} (${result.name})`);

    // Audit trail replacement for the audit_records row this action cannot itself write (its own
    // table is one of the ones just deleted) — see this file's delete-workspace section doc
    // comment. Deliberately stderr, not stdout — see this function's own doc comment above.
    console.error(
      JSON.stringify({
        event: 'workspace_deleted',
        workspaceId: result.workspaceId,
        workspaceName: result.name,
        deletedAt: new Date().toISOString(),
        principalCount: result.principalIds.length,
        taskCount: result.taskIds.length,
        deletedCounts: Object.fromEntries(result.deletedCounts),
      }),
    );

    console.log('');
    for (const principalId of result.principalIds) {
      console.log(`PRINCIPAL=${principalId}`);
    }
    for (const taskId of result.taskIds) {
      console.log(`TASK=${taskId}`);
    }
  } finally {
    await pool.end();
  }
}

async function runListWorkspaces(): Promise<void> {
  const pool = createPool();
  try {
    const workspaces = await listWorkspaces(pool);
    console.log('id\tname\tcreated_at\tprincipals\ttasks');
    for (const ws of workspaces) {
      console.log(
        `${ws.id}\t${ws.name}\t${ws.createdAt.toISOString()}\t${ws.principalCount}\t${ws.taskCount}`,
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
  if (command === 'seed-domain-pack') {
    await runSeedDomainPack(rest);
    return;
  }
  if (command === 'issue-service-handle') {
    await runIssueServiceHandle(rest);
    return;
  }
  throw new BootstrapUsageError(
    'usage: bootstrap create-workspace --name <ws> --owner <display-name>\n' +
      '   or: bootstrap add-principal --workspace <id> --name <display-name> [--role <role>]\n' +
      '   or: bootstrap register-gatekeeper --workspace <id> --principal <id> --name <name> ' +
      '--endpoint <url> --kind <http|mcp|cli|ssh> [--target <target>] [--publish true]\n' +
      '   or: bootstrap delete-workspace <workspaceId> --yes [--name <expected name>] ' +
      '[--allow-name-pattern <regex>]\n' +
      '   or: bootstrap list-workspaces\n' +
      '   or: bootstrap seed-domain-pack --workspace <id> --principal <id> --pack-name <name> ' +
      '[--file-name <file>] [--dir <dir>]\n' +
      '   or: bootstrap issue-service-handle --workspace <id> --name <name> ' +
      '--scope <cap1,cap2,...> [--ttl-days <n>]',
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
