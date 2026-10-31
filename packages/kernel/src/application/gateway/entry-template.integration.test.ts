import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type CapabilityScope,
  EntryTemplateStatusWireSchema,
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
  getPublishedEntryDefinition,
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
