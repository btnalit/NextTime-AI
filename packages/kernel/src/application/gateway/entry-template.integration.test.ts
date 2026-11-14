import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type CapabilityScope,
  EntryTemplateStatusWireSchema,
  type EntryTemplateUpgradeWire,
  EntryTemplateUpgradeWireSchema,
  type Role,
} from '@nexttime/shared';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { entryScope } from '../../governance/capability/index.js';
import { mapCapabilityError } from '../../interfaces/http/capability-route.js';
import {
  deprecateWorkerDefinition,
  getPublishedEntryDefinition,
  loadEntryTemplate,
  proposeWorkerDefinition,
  publishWorkerDefinition,
} from '../worker/index.js';
import { createWorkspaceWithOwner } from '../workspace/index.js';
import { dispatchCapability } from './dispatch.js';
import type { ResolvedCaller } from './resolve-caller.js';

/**
 * Integration tests (real Postgres; auto-skip without DATABASE_URL) for legacy 145: a workspace's
 * entry definition against the entry template this kernel ships (`get_entry_template_status`),
 * and the draft that brings it up to the template (`propose_entry_template_upgrade`) — the
 * template's prompt and capabilities over the workspace's own model and egress deny list, as the
 * caller's private draft that the owner then publishes; never automatic, never from an agent.
 * The "newer release" is a copy of `ontology/entry-agent.yaml` with one more paragraph, read from
 * a temporary `ONTOLOGY_DIR`.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  '..',
);
const KERNEL_ROOT = path.join(REPO_ROOT, 'packages', 'kernel');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');
const ONTOLOGY_DIR = path.join(REPO_ROOT, 'ontology');
const MODEL = 'anthropic/claude-test-model';
const ADDED = 'A paragraph a later release added to the entry prompt.';

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

function handleCaller(workspaceId: string, obo: string, scope: CapabilityScope): ResolvedCaller {
  const now = Math.floor(Date.now() / 1000);
  return {
    channel: 'handle',
    claims: {
      ws: workspaceId,
      sid: randomUUID(),
      obo,
      scope,
      jti: randomUUID(),
      iat: now,
      exp: now + 600,
    },
  };
}

async function refusal(call: Promise<unknown>) {
  let thrown: unknown;
  try {
    await call;
  } catch (err) {
    thrown = err;
  }
  if (thrown === undefined) throw new Error('expected the call to be refused');
  return mapCapabilityError(thrown);
}

describe.runIf(DATABASE_URL !== undefined)(
  'entry template upgrade — legacy 145 (integration, real Postgres)',
  () => {
    let pool: Pool;
    let workspaceId: string;
    let ownerId: string;
    let builderId: string;
    let memberId: string;
    let newerDir: string;
    let savedOntologyDir: string | undefined;
    let modelsDir: string;
    let savedModelsJsonFile: string | undefined;

    const as = <T>(principalId: string, fn: (client: PoolClient) => Promise<T>) =>
      withWorkspace(pool, { workspaceId, principalId }, fn);
    const human = (principalId: string, role: Role) => humanCaller(workspaceId, principalId, role);

    const status = async (role: Role = 'owner', principalId = ownerId) =>
      EntryTemplateStatusWireSchema.parse(
        await dispatchCapability(
          { pool },
          human(principalId, role),
          'get_entry_template_status',
          {},
        ),
      );

    /** Reads every template from the "newer release" while `fn` runs. */
    async function onNewerRelease<T>(fn: () => Promise<T>): Promise<T> {
      process.env.ONTOLOGY_DIR = newerDir;
      try {
        return await fn();
      } finally {
        if (savedOntologyDir === undefined) Reflect.deleteProperty(process.env, 'ONTOLOGY_DIR');
        else process.env.ONTOLOGY_DIR = savedOntologyDir;
      }
    }

    beforeAll(async () => {
      savedOntologyDir = process.env.ONTOLOGY_DIR;
      // The owner publishes through `publish_worker_definition`, which checks the version's model
      // against the catalog (legacy 302): one that offers MODEL.
      savedModelsJsonFile = process.env.MODELS_JSON_FILE;
      modelsDir = await mkdtemp(path.join(os.tmpdir(), 'entry-template-models-'));
      const [provider, model] = MODEL.split('/');
      await writeFile(
        path.join(modelsDir, 'models.json'),
        JSON.stringify({
          providers: {
            [provider as string]: {
              baseUrl: 'http://llm-proxy:8082/anthropic',
              apiKey: '$CAPABILITY_HANDLE',
              api: 'anthropic-messages',
              models: [{ id: model }],
            },
          },
        }),
      );
      process.env.MODELS_JSON_FILE = path.join(modelsDir, 'models.json');
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);
      const created = await createWorkspaceWithOwner(pool, {
        name: `entry-template-${randomUUID().slice(0, 8)}`,
        owner: { displayName: 'Entry Template Owner' },
        ontologyDir: ONTOLOGY_DIR,
        entryModel: MODEL,
      });
      workspaceId = created.workspaceId;
      ownerId = created.ownerPrincipalId;
      builderId = randomUUID();
      memberId = randomUUID();
      await withWorkspace(
        pool,
        { workspaceId, principalId: ownerId },
        (client) =>
          client.query(
            `insert into principals (workspace_id, id, kind, role, display_name)
             values ($1, $2, 'human', 'builder', 'builder'), ($1, $3, 'human', 'member', 'member')`,
            [workspaceId, builderId, memberId],
          ),
        { skipRoleSwitch: true },
      );
      newerDir = await mkdtemp(path.join(os.tmpdir(), 'entry-template-'));
      const shipped = await readFile(path.join(ONTOLOGY_DIR, 'entry-agent.yaml'), 'utf8');
      // `systemPrompt: |` is a block scalar: one more indented line at its top is one more paragraph.
      const marker = /^systemPrompt: \|\n/m;
      expect(shipped).toMatch(marker);
      await writeFile(
        path.join(newerDir, 'entry-agent.yaml'),
        shipped.replace(marker, (head) => `${head}  ${ADDED}\n\n`),
      );
    });

    afterAll(async () => {
      await pool.end();
      await rm(newerDir, { recursive: true, force: true });
      await rm(modelsDir, { recursive: true, force: true });
      if (savedOntologyDir === undefined) Reflect.deleteProperty(process.env, 'ONTOLOGY_DIR');
      else process.env.ONTOLOGY_DIR = savedOntologyDir;
      if (savedModelsJsonFile === undefined) {
        Reflect.deleteProperty(process.env, 'MODELS_JSON_FILE');
      } else {
        process.env.MODELS_JSON_FILE = savedModelsJsonFile;
      }
    });

    it('a new workspace is on the template it was made from: nothing differs, nothing to propose', async () => {
      const now = await status();
      expect(now.template.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(now.current?.digest).toBe(now.template.digest);
      expect(now.differs).toEqual([]);
      const mapped = await refusal(
        dispatchCapability({ pool }, human(ownerId, 'owner'), 'propose_entry_template_upgrade', {
          templateDigest: now.template.digest,
          basedOn: { definitionId: now.current?.definitionId, version: now.current?.version },
        }),
      );
      expect(mapped).toMatchObject({ status: 409, code: 'entry_template_current' });
    });

    it('a later template: the draft takes its prompt and capabilities and keeps the workspace’s own model and egress deny list; the owner publishes it', async () => {
      // The workspace's own settings, published before the release: a deny list over v1.
      const v1 = await as(ownerId, (client) => getPublishedEntryDefinition(client, workspaceId));
      if (!v1) throw new Error('no entry definition');
      const own = await as(ownerId, (client) =>
        proposeWorkerDefinition(client, workspaceId, ownerId, {
          origin: 'human',
          definitionId: v1.id,
          kind: 'entry',
          definition: { ...v1.definition, egressDeny: ['tracker.example'] },
        }),
      );
      await as(ownerId, (client) =>
        publishWorkerDefinition(client, workspaceId, ownerId, {
          definitionId: own.id,
          version: own.version,
        }),
      );

      await onNewerRelease(async () => {
        const before = await status('builder', builderId);
        expect(before.differs).toEqual(['systemPrompt']);
        expect(before.current).toMatchObject({ definitionId: v1.id, version: own.version });
        expect(before.current?.digest).not.toBe(before.template.digest);
        expect(before.template.systemPrompt.startsWith(ADDED)).toBe(true);
        const basedOn = { definitionId: v1.id, version: own.version };

        // What the caller looked at must be what is there.
        for (const params of [
          { templateDigest: `sha256:${'0'.repeat(64)}`, basedOn },
          { templateDigest: before.template.digest, basedOn: { ...basedOn, version: 1 } },
          { templateDigest: before.template.digest, basedOn: null },
        ]) {
          const mapped = await refusal(
            dispatchCapability(
              { pool },
              human(builderId, 'builder'),
              'propose_entry_template_upgrade',
              params,
            ),
          );
          expect(mapped).toMatchObject({ status: 409, code: 'entry_template_changed' });
        }

        const upgrade = EntryTemplateUpgradeWireSchema.parse(
          await dispatchCapability(
            { pool },
            human(builderId, 'builder'),
            'propose_entry_template_upgrade',
            { templateDigest: before.template.digest, basedOn },
          ),
        );
        expect(upgrade).toMatchObject({
          templateDigest: before.template.digest,
          basedOn,
          differs: ['systemPrompt'],
          created: true,
        });
        expect(upgrade.draft).toMatchObject({
          id: v1.id,
          version: own.version + 1,
          kind: 'entry',
          status: 'draft',
          proposedBy: builderId,
          // S11 AA3a (legacy 293): a person asked for it, over the human channel.
          origin: 'human',
        });
        expect(upgrade.draft.definition).toEqual({
          ...v1.definition,
          egressDeny: ['tracker.example'],
          systemPrompt: before.template.systemPrompt,
          capabilities: before.template.capabilities,
        });
        expect(upgrade.draft.definition.model).toBe(MODEL);

        // Asked again: the same draft, not a second one.
        const again = EntryTemplateUpgradeWireSchema.parse(
          await dispatchCapability(
            { pool },
            human(builderId, 'builder'),
            'propose_entry_template_upgrade',
            { templateDigest: before.template.digest, basedOn },
          ),
        );
        expect(again.created).toBe(false);
        expect(again.draft.version).toBe(upgrade.draft.version);

        // Audited with the template digest it was made from.
        const audits = await withWorkspace(
          pool,
          { workspaceId, principalId: ownerId },
          async (client) =>
            (
              await client.query<{ payload: Record<string, unknown> }>(
                `select payload from audit_records
                  where workspace_id = $1 and action = 'propose_entry_template_upgrade'
                  order by created_at`,
                [workspaceId],
              )
            ).rows,
          { skipRoleSwitch: true },
        );
        expect(audits.map((row) => row.payload)).toEqual([
          expect.objectContaining({
            templateDigest: before.template.digest,
            basedOn,
            draftVersion: upgrade.draft.version,
            created: true,
          }),
          expect.objectContaining({ templateDigest: before.template.digest, created: false }),
        ]);

        // Legacy 680: a family holds one pending draft of each proposer. The builder's hand-edited
        // next version beside their template draft is refused, naming it…
        const beside = await refusal(
          dispatchCapability({ pool }, human(builderId, 'builder'), 'propose_worker_definition', {
            definitionId: v1.id,
            kind: 'entry',
            definition: { ...upgrade.draft.definition, egressDeny: ['other.example'] },
          }),
        );
        expect(beside).toMatchObject({
          status: 409,
          code: 'draft_pending',
          details: { familyId: v1.id, draftVersion: upgrade.draft.version },
        });
        // …and the template's draft beside the owner's own hand-edited one is refused, naming
        // theirs; the builder's draft does not count for the owner (I16).
        const handEdited = await dispatchCapability(
          { pool },
          human(ownerId, 'owner'),
          'propose_worker_definition',
          {
            definitionId: v1.id,
            kind: 'entry',
            definition: { ...v1.definition, egressDeny: ['owner.example'] },
          },
        );
        const handEditedVersion = (handEdited as { version: number }).version;
        expect(handEditedVersion).toBe(upgrade.draft.version + 1);
        const overOwn = await refusal(
          dispatchCapability({ pool }, human(ownerId, 'owner'), 'propose_entry_template_upgrade', {
            templateDigest: before.template.digest,
            basedOn,
          }),
        );
        expect(overOwn).toMatchObject({
          status: 409,
          code: 'draft_pending',
          details: { familyId: v1.id, draftVersion: handEditedVersion },
        });
        // Review #493 on #1218: an agent acting for the owner (a Handle proposes as them) does not
        // replace the draft the owner wrote — refused as their pending draft, which stays (the
        // owner's own replace below takes it, under the next number).
        const agent = handleCaller(workspaceId, ownerId, {
          capabilities: ['propose_worker_definition'],
          resources: {},
        });
        const overPerson = await refusal(
          dispatchCapability({ pool }, agent, 'propose_worker_definition', {
            definitionId: v1.id,
            replacesDraft: handEditedVersion,
            kind: 'entry',
            definition: { ...v1.definition, egressDeny: ['agent.example'] },
          }),
        );
        expect(overPerson).toMatchObject({
          status: 409,
          code: 'draft_pending',
          details: { familyId: v1.id, draftVersion: handEditedVersion },
        });
        // Editing that draft replaces it, in one call and under the next number; the audit record
        // of the call names the draft it replaced.
        const reEdited = await dispatchCapability(
          { pool },
          human(ownerId, 'owner'),
          'propose_worker_definition',
          {
            definitionId: v1.id,
            replacesDraft: handEditedVersion,
            kind: 'entry',
            definition: { ...v1.definition, egressDeny: ['owner-edited.example'] },
          },
        );
        const reEditedVersion = (reEdited as { version: number }).version;
        expect(reEditedVersion).toBe(handEditedVersion + 1);
        const replaceAudit = await withWorkspace(
          pool,
          { workspaceId, principalId: ownerId },
          async (client) =>
            (
              await client.query<{ payload: { params?: Record<string, unknown> } }>(
                `select payload from audit_records
                  where workspace_id = $1 and action = 'propose_worker_definition'
                  order by created_at desc
                  limit 1`,
                [workspaceId],
              )
            ).rows[0],
          { skipRoleSwitch: true },
        );
        expect(replaceAudit?.payload.params).toMatchObject({
          definitionId: v1.id,
          replacesDraft: handEditedVersion,
        });
        await dispatchCapability({ pool }, human(ownerId, 'owner'), 'discard_draft', {
          kind: 'worker_definition',
          id: v1.id,
          version: reEditedVersion,
        });
        // Named again once it is gone: 409 draft_changed, nothing proposed.
        const stale = await refusal(
          dispatchCapability({ pool }, human(ownerId, 'owner'), 'propose_worker_definition', {
            definitionId: v1.id,
            replacesDraft: reEditedVersion,
            kind: 'entry',
            definition: v1.definition,
          }),
        );
        expect(stale).toMatchObject({
          status: 409,
          code: 'draft_changed',
          details: { familyId: v1.id, draftVersion: reEditedVersion },
        });
        // A draft the agent wrote, the agent replaces (then the owner discards it).
        const agentDraft = (await dispatchCapability({ pool }, agent, 'propose_worker_definition', {
          definitionId: v1.id,
          kind: 'entry',
          definition: { ...v1.definition, egressDeny: ['agent.example'] },
        })) as { version: number; origin?: string };
        expect(agentDraft.origin).toBe('agent');
        const agentRedraft = (await dispatchCapability(
          { pool },
          agent,
          'propose_worker_definition',
          {
            definitionId: v1.id,
            replacesDraft: agentDraft.version,
            kind: 'entry',
            definition: { ...v1.definition, egressDeny: ['agent-edited.example'] },
          },
        )) as { version: number; origin?: string };
        expect(agentRedraft).toMatchObject({ version: agentDraft.version + 1, origin: 'agent' });
        await dispatchCapability({ pool }, human(ownerId, 'owner'), 'discard_draft', {
          kind: 'worker_definition',
          id: v1.id,
          version: agentRedraft.version,
        });

        // Nothing runs differently until it is published — by the owner (the live version is
        // theirs, so the builder who proposed the draft cannot supersede it).
        expect((await status()).current?.version).toBe(own.version);
        const builderPublish = await refusal(
          dispatchCapability({ pool }, human(builderId, 'builder'), 'publish_worker_definition', {
            definitionId: v1.id,
            version: upgrade.draft.version,
          }),
        );
        expect(builderPublish.status).toBe(403);
        await dispatchCapability({ pool }, human(ownerId, 'owner'), 'publish_worker_definition', {
          definitionId: v1.id,
          version: upgrade.draft.version,
        });
        const after = await status();
        expect(after.current).toMatchObject({ version: upgrade.draft.version });
        expect(after.current?.digest).toBe(before.template.digest);
        expect(after.differs).toEqual([]);
      });
    });

    // Legacy 691: with no published entry the draft is the first version of a new entry family;
    // asked again, the caller gets that draft back rather than a second family.
    it('no published entry: asked again, the caller gets their own first draft back; another person gets their own', async () => {
      const bare = randomUUID();
      const bareOwner = randomUUID();
      const bareBuilder = randomUUID();
      await withWorkspace(
        pool,
        { workspaceId: bare, principalId: bareOwner },
        async (client) => {
          await client.query('insert into workspaces (id, name) values ($1, $2)', [
            bare,
            `entry-template-bare-${bare.slice(0, 8)}`,
          ]);
          await client.query(
            `insert into principals (workspace_id, id, kind, role, display_name)
             values ($1, $2, 'human', 'owner', 'bare owner'), ($1, $3, 'human', 'builder', 'bare builder')`,
            [bare, bareOwner, bareBuilder],
          );
        },
        { skipRoleSwitch: true },
      );
      const ask = async (principalId: string, role: Role) => {
        const caller = humanCaller(bare, principalId, role);
        const read = EntryTemplateStatusWireSchema.parse(
          await dispatchCapability({ pool }, caller, 'get_entry_template_status', {}),
        );
        expect(read.current).toBeNull();
        return EntryTemplateUpgradeWireSchema.parse(
          await dispatchCapability({ pool }, caller, 'propose_entry_template_upgrade', {
            templateDigest: read.template.digest,
            basedOn: null,
          }),
        );
      };
      const first = await ask(bareOwner, 'owner');
      expect(first).toMatchObject({ created: true, basedOn: null });
      const again = await ask(bareOwner, 'owner');
      expect(again).toMatchObject({ created: false, basedOn: null });
      expect(again.draft).toMatchObject({ id: first.draft.id, version: first.draft.version });
      const theirs = await ask(bareBuilder, 'builder');
      expect(theirs.created).toBe(true);
      expect(theirs.draft.id).not.toBe(first.draft.id);

      const families = await withWorkspace(
        pool,
        { workspaceId: bare, principalId: bareOwner },
        async (client) =>
          (
            await client.query<{ proposed_by: string; n: number }>(
              `select proposed_by, count(*)::int as n from worker_definitions
                where workspace_id = $1 and kind = 'entry' group by proposed_by order by n`,
              [bare],
            )
          ).rows,
        { skipRoleSwitch: true },
      );
      expect(families).toHaveLength(2);
      expect(families.every((row) => row.n === 1)).toBe(true);
    });

    /** A workspace with no entry definition at all, and an owner and a builder in it. */
    async function bareWorkspace(): Promise<{ id: string; owner: string; builder: string }> {
      const id = randomUUID();
      const owner = randomUUID();
      const builder = randomUUID();
      await withWorkspace(
        pool,
        { workspaceId: id, principalId: owner },
        async (client) => {
          await client.query('insert into workspaces (id, name) values ($1, $2)', [
            id,
            `entry-template-bare-${id.slice(0, 8)}`,
          ]);
          await client.query(
            `insert into principals (workspace_id, id, kind, role, display_name)
             values ($1, $2, 'human', 'owner', 'bare owner'), ($1, $3, 'human', 'builder', 'bare builder')`,
            [id, owner, builder],
          );
        },
        { skipRoleSwitch: true },
      );
      return { id, owner, builder };
    }

    const entryRows = (workspace: string, principalId: string) =>
      withWorkspace(
        pool,
        { workspaceId: workspace, principalId },
        async (client) =>
          (
            await client.query<{ id: string; version: number; status: string }>(
              `select id, version, status from worker_definitions
                where workspace_id = $1 and kind = 'entry' order by id, version`,
              [workspace],
            )
          ).rows,
        { skipRoleSwitch: true },
      );

    // Legacy 736: the identical-draft lookup runs under the WorkerDefinition registry lock, so the
    // same person asking twice at once gets one draft — the second call waits for the first and
    // finds its draft.
    it('the same person asking twice at once gets one draft: the second call waits for the registry lock and returns the first’s', async () => {
      const bare = await bareWorkspace();
      const caller = humanCaller(bare.id, bare.owner, 'owner');
      const read = EntryTemplateStatusWireSchema.parse(
        await dispatchCapability({ pool }, caller, 'get_entry_template_status', {}),
      );
      const ask = () =>
        dispatchCapability({ pool }, caller, 'propose_entry_template_upgrade', {
          templateDigest: read.template.digest,
          basedOn: null,
        }).then((result) => EntryTemplateUpgradeWireSchema.parse(result));

      // Another transaction holds the workspace's registry lock (as a publish would) while both
      // calls start: each has to wait for it before reading anything.
      const holder = await pool.connect();
      let calls: Promise<EntryTemplateUpgradeWire[]> | undefined;
      try {
        await holder.query('begin');
        await holder.query('select pg_advisory_xact_lock(hashtext($1::text))', [
          `worker_registry:${bare.id}`,
        ]);
        const holderPid = (await holder.query<{ pid: number }>('select pg_backend_pid() as pid'))
          .rows[0]?.pid;
        calls = Promise.all([ask(), ask()]);
        for (let attempt = 0; ; attempt += 1) {
          const { rows } = await pool.query<{ waiting: number }>(
            `select count(*)::int as waiting from pg_stat_activity
              where $1::int = any(pg_blocking_pids(pid))`,
            [holderPid],
          );
          if ((rows[0]?.waiting ?? 0) >= 2) break;
          if (attempt > 200)
            throw new Error('the two calls never both waited on the registry lock');
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      } finally {
        await holder.query('commit');
        holder.release();
      }
      const results = await calls;
      if (!results) throw new Error('the calls never started');
      expect(results.map((result) => result.created).sort()).toEqual([false, true]);
      const [one, other] = results;
      expect(one?.draft).toMatchObject({ id: other?.draft.id, version: other?.draft.version });
      expect(await entryRows(bare.id, bare.owner)).toHaveLength(1);
    });

    // #1200 review (#501 E3): a family that was published once and is deprecated now is not one
    // "nothing was ever published from" — the caller's identical draft in it is not handed back,
    // the call starts a new family.
    it('no published entry, but a deprecated family holding the caller’s identical draft: that draft is not handed back; a new family is proposed', async () => {
      const bare = await bareWorkspace();
      const template = await loadEntryTemplate();
      const deprecatedFamily = await withWorkspace(
        pool,
        { workspaceId: bare.id, principalId: bare.owner },
        async (client) => {
          const first = await proposeWorkerDefinition(client, bare.id, bare.owner, {
            kind: 'entry',
            definition: { ...template.definition },
            origin: 'human',
          });
          await publishWorkerDefinition(client, bare.id, bare.owner, {
            definitionId: first.id,
            version: first.version,
          });
          await deprecateWorkerDefinition(client, bare.id, {
            definitionId: first.id,
            version: first.version,
          });
          // The caller's draft of the next version, the same content the call would propose.
          await proposeWorkerDefinition(client, bare.id, bare.owner, {
            definitionId: first.id,
            kind: 'entry',
            definition: { ...template.definition },
            origin: 'human',
          });
          return first.id;
        },
        { skipRoleSwitch: true },
      );

      const caller = humanCaller(bare.id, bare.owner, 'owner');
      const read = EntryTemplateStatusWireSchema.parse(
        await dispatchCapability({ pool }, caller, 'get_entry_template_status', {}),
      );
      expect(read.current).toBeNull();
      const asked = EntryTemplateUpgradeWireSchema.parse(
        await dispatchCapability({ pool }, caller, 'propose_entry_template_upgrade', {
          templateDigest: read.template.digest,
          basedOn: null,
        }),
      );
      expect(asked).toMatchObject({ created: true, basedOn: null });
      expect(asked.draft.id).not.toBe(deprecatedFamily);
      expect(asked.draft.version).toBe(1);
      const rows = await entryRows(bare.id, bare.owner);
      expect(rows.filter((row) => row.id === deprecatedFamily).map((row) => row.status)).toEqual([
        'deprecated',
        'draft',
      ]);
    });

    it('is the people’s: a member cannot ask, and an agent cannot reach either', async () => {
      const now = await status();
      const member = await refusal(
        dispatchCapability({ pool }, human(memberId, 'member'), 'get_entry_template_status', {}),
      );
      expect(member.status).toBe(403);
      const agent = handleCaller(workspaceId, ownerId, entryScope({}, { role: 'owner' }));
      for (const [name, params] of [
        ['get_entry_template_status', {}],
        [
          'propose_entry_template_upgrade',
          {
            templateDigest: now.template.digest,
            basedOn: { definitionId: now.current?.definitionId, version: now.current?.version },
          },
        ],
      ] as const) {
        const mapped = await refusal(dispatchCapability({ pool }, agent, name, params));
        expect(mapped.status).toBe(403);
      }
    });
  },
);
