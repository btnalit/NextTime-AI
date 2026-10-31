import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import {
  FamilyDraftPendingError,
  SkillNameConflictError,
  discardDraft,
  proposeSkill,
  proposeWorkerDefinition,
  publishSkill,
  publishWorkerDefinition,
} from '../worker/index.js';
import {
  ChangeConfirmationRequiredError,
  ChangeRollbackConflictError,
  type SkillItemContent,
  type WorkspaceSegmentInput,
  applyWorkspaceSegment,
  contentDigest,
  inspectChangeSegment,
  loadFamilyProvenance,
  planWorkspaceSegment,
  previewSegmentRollback,
  rollBackWorkspaceSegment,
} from './index.js';

/**
 * application/change-plan — family-item.integration (S11 P1-D): the `skill_version` and
 * `worker_definition_version` items. Planned against the family's head (none: `added`, every field
 * changed), applied through the registry's own propose and publish under the person applying,
 * classified by the whitelist and confirmed one by one, recorded with the version they published
 * (provenance), and rolled back by retiring that version — the head is the version before again,
 * compare before writing (a version published since: refused, nothing written). A Skill name is
 * one family's: another family's published name is refused at plan, and `publish_skill` refuses a
 * name an installed Skill holds.
 *
 * Gated on `DATABASE_URL`.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

type Ws = { readonly workspaceId: string; readonly ownerId: string };

function skill(markdown: string, name = 'fix-it'): SkillItemContent {
  return { name, description: 'Fix the thing.', markdown, applicable: {} };
}

describe.runIf(DATABASE_URL !== undefined)(
  'application/change-plan — Skill and WorkerDefinition items (S11 P1-D, integration, real Postgres)',
  () => {
    let pool: Pool;

    async function newWorkspace(): Promise<Ws> {
      const workspaceId = randomUUID();
      const ownerId = randomUUID();
      await withWorkspace(
        pool,
        { workspaceId, principalId: ownerId },
        async (client) => {
          await client.query('insert into workspaces (id, name) values ($1, $2)', [
            workspaceId,
            'p1-family-items',
          ]);
          await client.query(
            "insert into principals (workspace_id, id, kind, role, display_name) values ($1, $2, 'human', 'owner', 'owner')",
            [workspaceId, ownerId],
          );
        },
        { skipRoleSwitch: true },
      );
      return { workspaceId, ownerId };
    }

    const inWorkspace = <T>(ws: Ws, fn: (client: PoolClient) => Promise<T>) =>
      withWorkspace(pool, { workspaceId: ws.workspaceId, principalId: ws.ownerId }, fn);

    const skillSegment = (skillId: string, content: SkillItemContent): WorkspaceSegmentInput => ({
      source: { kind: 'pack', name: 'kit', version: '1', digest: contentDigest(content) },
      items: [{ kind: 'skill_version', skillId, content }],
    });

    const workerSegment = (
      definitionId: string,
      definition: Readonly<Record<string, unknown>>,
    ): WorkspaceSegmentInput => ({
      source: { kind: 'pack', name: 'kit', version: '1', digest: contentDigest(definition) },
      items: [{ kind: 'worker_definition_version', definitionId, definition }],
    });

    const plan = (ws: Ws, input: WorkspaceSegmentInput) =>
      inWorkspace(ws, (client) => planWorkspaceSegment(client, ws.workspaceId, input));

    const apply = (ws: Ws, input: WorkspaceSegmentInput, confirmedOrdinals: number[] = [1]) =>
      inWorkspace(ws, async (client) => {
        const planned = await planWorkspaceSegment(client, ws.workspaceId, input);
        const applied = await applyWorkspaceSegment(client, ws.workspaceId, {
          ...input,
          reviewedDigest: planned.digest,
          proposedBy: ws.ownerId,
          appliedBy: ws.ownerId,
          channel: 'human',
          confirmedOrdinals,
        });
        if (!applied.segmentId) throw new Error('apply: nothing applied');
        return applied.segmentId;
      });

    const preview = (ws: Ws, segmentId: string) =>
      inWorkspace(ws, (client) => previewSegmentRollback(client, ws.workspaceId, segmentId));

    const rollBack = (ws: Ws, segmentId: string, confirmedOrdinals: readonly number[] = []) =>
      inWorkspace(ws, (client) =>
        rollBackWorkspaceSegment(client, ws.workspaceId, {
          segmentId,
          rolledBackBy: ws.ownerId,
          confirmedOrdinals,
        }),
      );

    const rows = (ws: Ws, text: string, params: readonly unknown[] = []) =>
      inWorkspace(
        ws,
        async (client) => (await client.query(text, [ws.workspaceId, ...params])).rows,
      );

    const skillVersions = (ws: Ws, skillId: string) =>
      rows(
        ws,
        'select version, status, proposed_by, published_by from skills where workspace_id = $1 and id = $2 order by version',
        [skillId],
      );

    const workerVersions = (ws: Ws, definitionId: string) =>
      rows(
        ws,
        'select version, status from worker_definitions where workspace_id = $1 and id = $2 order by version',
        [definitionId],
      );

    beforeAll(async () => {
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);
    });

    afterAll(async () => {
      await pool.end();
    });

    it('a Skill: installs as the next published version under the person applying, and rolls back to the version before', async () => {
      const ws = await newWorkspace();
      const skillId = randomUUID();
      const v1 = skill('# Fix it\n\nStep one.');

      const first = await plan(ws, skillSegment(skillId, v1));
      expect(first.items[0]).toMatchObject({
        kind: 'skill_version',
        target: { skillId, name: 'fix-it' },
        before: null,
        after: { contentDigest: contentDigest(v1) },
        classification: 'authority_widening',
        widening: [{ path: 'skill', reason: 'added' }],
        unchanged: false,
        detail: {
          kind: 'skill_version',
          content: v1,
          changedFields: ['applicable', 'description', 'markdown', 'name'],
        },
      });
      // A new prompt for every Worker that mounts it: confirmed one by one (I-A4).
      await expect(apply(ws, skillSegment(skillId, v1), [])).rejects.toBeInstanceOf(
        ChangeConfirmationRequiredError,
      );
      expect(await skillVersions(ws, skillId)).toEqual([]);

      const installed = await apply(ws, skillSegment(skillId, v1));
      expect(await skillVersions(ws, skillId)).toEqual([
        { version: 1, status: 'published', proposed_by: ws.ownerId, published_by: ws.ownerId },
      ]);
      expect(
        await inWorkspace(ws, (client) =>
          loadFamilyProvenance(client, ws.workspaceId, 'skill_version', skillId),
        ),
      ).toMatchObject({ status: 'recorded', segmentId: installed });
      expect((await plan(ws, skillSegment(skillId, v1))).unchanged).toBe(true);

      const v2 = skill('# Fix it\n\nStep one, then two.');
      const upgrade = await plan(ws, skillSegment(skillId, v2));
      expect(upgrade.items[0]).toMatchObject({
        before: { version: 1, contentDigest: contentDigest(v1) },
        widening: [{ path: 'skill.markdown', reason: 'changed' }],
        detail: { changedFields: ['markdown'] },
      });
      const upgraded = await apply(ws, skillSegment(skillId, v2));
      expect((await skillVersions(ws, skillId)).map((row) => row.version)).toEqual([1, 2]);
      const inspected = await inWorkspace(ws, (client) =>
        inspectChangeSegment(client, ws.workspaceId, upgraded),
      );
      expect(inspected.items[0]).toMatchObject({
        record: {
          kind: 'skill_version',
          target: { skillId, name: 'fix-it' },
          after: { version: 2, contentDigest: contentDigest(v2) },
        },
      });

      // The inverse goes back to v1's text: a prompt change again, confirmed by the person.
      const dryRun = await preview(ws, upgraded);
      expect(dryRun).toMatchObject({ possible: true });
      expect(dryRun.items[0]).toMatchObject({
        classification: 'authority_widening',
        widening: [{ path: 'skill.markdown', reason: 'changed' }],
        conflict: null,
        detail: {
          kind: 'skill_version',
          planned: {
            from: { version: 2, contentDigest: contentDigest(v2) },
            to: { version: 1, contentDigest: contentDigest(v1) },
            blocker: null,
          },
        },
      });
      await rollBack(ws, upgraded, [1]);
      expect((await skillVersions(ws, skillId)).map((row) => [row.version, row.status])).toEqual([
        [1, 'published'],
        [2, 'deprecated'],
      ]);
      expect(
        await inWorkspace(ws, (client) =>
          loadFamilyProvenance(client, ws.workspaceId, 'skill_version', skillId),
        ),
      ).toMatchObject({ status: 'recorded', segmentId: installed });
      expect(
        await rows(
          ws,
          "select count(*)::int as n from audit_records where workspace_id = $1 and action = 'change_item.roll_back'",
        ),
      ).toEqual([{ n: 1 }]);

      // Rolling back the first install leaves no published version, and widens nothing.
      const last = await preview(ws, installed);
      expect(last.items[0]).toMatchObject({
        classification: 'not_widening',
        detail: { planned: { from: { version: 1 }, to: null } },
      });
      await rollBack(ws, installed);
      expect((await skillVersions(ws, skillId)).map((row) => row.status)).toEqual([
        'deprecated',
        'deprecated',
      ]);
      expect(
        await inWorkspace(ws, (client) =>
          loadFamilyProvenance(client, ws.workspaceId, 'skill_version', skillId),
        ),
      ).toEqual({ status: 'not_installed' });
    });

    it('a WorkerDefinition: an upgrade keeps the earlier version published; rolling it back retires only its own', async () => {
      const ws = await newWorkspace();
      const definitionId = randomUUID();
      const w1 = { name: 'fixer', systemPrompt: 'You fix things.' };
      const w2 = { ...w1, systemPrompt: 'You fix things carefully.', skills: ['fix-it'] };
      // What v2 mounts is there: publishing a version that names a Skill with no published
      // version is refused (legacy 302).
      await inWorkspace(ws, async (client) => {
        const draft = await proposeSkill(client, ws.workspaceId, ws.ownerId, {
          name: 'fix-it',
          description: 'Fix the thing.',
          markdown: 'body',
        });
        await publishSkill(client, ws.workspaceId, ws.ownerId, draft.id);
      });

      expect((await plan(ws, workerSegment(definitionId, w1))).items[0]).toMatchObject({
        kind: 'worker_definition_version',
        target: { definitionId, name: 'fixer' },
        before: null,
        widening: [{ path: 'worker', reason: 'added' }],
      });
      const installed = await apply(ws, workerSegment(definitionId, w1));
      const upgrade = await plan(ws, workerSegment(definitionId, w2));
      expect(upgrade.items[0]).toMatchObject({
        widening: [
          { path: 'worker.skills', reason: 'loosened' },
          { path: 'worker.systemPrompt', reason: 'changed' },
        ],
        detail: { changedFields: ['skills', 'systemPrompt'] },
      });
      const upgraded = await apply(ws, workerSegment(definitionId, w2));
      expect(await workerVersions(ws, definitionId)).toEqual([
        { version: 1, status: 'published' },
        { version: 2, status: 'published' },
      ]);

      // Back to v1: fewer Skills narrows, the prompt change is confirmed.
      expect((await preview(ws, upgraded)).items[0]?.widening).toEqual([
        { path: 'worker.systemPrompt', reason: 'changed' },
      ]);
      await rollBack(ws, upgraded, [1]);
      expect(await workerVersions(ws, definitionId)).toEqual([
        { version: 1, status: 'published' },
        { version: 2, status: 'deprecated' },
      ]);
      expect(
        await inWorkspace(ws, (client) =>
          loadFamilyProvenance(client, ws.workspaceId, 'worker_definition_version', definitionId),
        ),
      ).toMatchObject({ status: 'recorded', segmentId: installed });
    });

    it('a version a person published since: the rollback is refused, nothing written', async () => {
      const ws = await newWorkspace();
      const skillId = randomUUID();
      const definitionId = randomUUID();
      const installed = await apply(
        ws,
        {
          source: { kind: 'pack', name: 'kit', version: '1', digest: contentDigest('kit v1') },
          items: [
            { kind: 'skill_version', skillId, content: skill('body') },
            {
              kind: 'worker_definition_version',
              definitionId,
              definition: { name: 'fixer', systemPrompt: 'p' },
            },
          ],
        },
        [1, 2],
      );
      await inWorkspace(ws, async (client) => {
        await proposeSkill(client, ws.workspaceId, ws.ownerId, {
          skillId,
          name: 'fix-it',
          description: 'Fix the thing.',
          markdown: 'body, edited by hand',
        });
        await publishSkill(client, ws.workspaceId, ws.ownerId, skillId);
        const draft = await proposeWorkerDefinition(client, ws.workspaceId, ws.ownerId, {
          definitionId,
          kind: 'worker',
          definition: { name: 'fixer', systemPrompt: 'edited by hand' },
        });
        await publishWorkerDefinition(client, ws.workspaceId, ws.ownerId, {
          definitionId,
          version: draft.version,
        });
      });
      const dryRun = await preview(ws, installed);
      expect(dryRun.possible).toBe(false);
      expect(dryRun.items.map((item) => item.conflict?.blocker)).toEqual(['replaced', 'replaced']);
      await expect(rollBack(ws, installed)).rejects.toBeInstanceOf(ChangeRollbackConflictError);
      expect((await skillVersions(ws, skillId)).map((row) => row.status)).toEqual([
        'published',
        'published',
      ]);
    });

    it('a Skill name is one family’s: refused at plan, and by publish_skill the other way round', async () => {
      const ws = await newWorkspace();
      // A person's Skill holds "fix-it": a pack's Skill of that name (another family) is refused.
      await inWorkspace(ws, async (client) => {
        const own = await proposeSkill(client, ws.workspaceId, ws.ownerId, {
          name: 'fix-it',
          description: 'Mine.',
          markdown: 'my body',
        });
        await publishSkill(client, ws.workspaceId, ws.ownerId, own.id);
      });
      await expect(plan(ws, skillSegment(randomUUID(), skill('body')))).rejects.toMatchObject({
        code: 'skill_name_conflict',
      });

      // A pack's "fix-that" installed: a person's new Skill of that name cannot be published.
      await apply(ws, skillSegment(randomUUID(), skill('body', 'fix-that')));
      const refused = inWorkspace(ws, async (client) => {
        const draft = await proposeSkill(client, ws.workspaceId, ws.ownerId, {
          name: 'fix-that',
          description: 'Mine too.',
          markdown: 'my body',
        });
        await publishSkill(client, ws.workspaceId, ws.ownerId, draft.id);
      });
      await expect(refused).rejects.toBeInstanceOf(SkillNameConflictError);
    });
    it('a person’s pending draft of an installed Skill’s next version (S11 W1a E2-0): the upgrade is refused at review, nothing written; once the draft is gone it goes ahead', async () => {
      const ws = await newWorkspace();
      const skillId = randomUUID();
      await apply(ws, skillSegment(skillId, skill('# Fix it\n\nStep one.')));
      const draft = await inWorkspace(ws, (client) =>
        proposeSkill(client, ws.workspaceId, ws.ownerId, {
          skillId,
          name: 'fix-it',
          description: 'Fix the thing, my way.',
          markdown: '# Fix it\n\nMy step.',
        }),
      );
      expect(draft.version).toBe(2);

      const upgrade = skillSegment(skillId, skill('# Fix it\n\nStep one, then two.'));
      // Publishing takes the latest version, so installing over the draft would strand it.
      await expect(plan(ws, upgrade)).rejects.toBeInstanceOf(FamilyDraftPendingError);
      await expect(apply(ws, upgrade)).rejects.toMatchObject({
        code: 'draft_pending',
        draftVersion: 2,
      });
      expect(await skillVersions(ws, skillId)).toMatchObject([
        { version: 1, status: 'published' },
        { version: 2, status: 'draft' },
      ]);

      await inWorkspace(ws, (client) =>
        discardDraft(client, ws.workspaceId, ws.ownerId, {
          kind: 'skill',
          id: skillId,
          version: 2,
        }),
      );
      await apply(ws, upgrade);
      expect(await skillVersions(ws, skillId)).toMatchObject([
        { version: 1, status: 'published' },
        { version: 2, status: 'published' },
      ]);
    });

    it('a segment with an ontology item and a Skill item locks the ontology first, applying and rolling back alike', async () => {
      const ws = await newWorkspace();
      const content = skill('# Lock order\n\nOne step.', 'lock-order');
      const input: WorkspaceSegmentInput = {
        source: { kind: 'pack', name: 'kit', version: '1', digest: contentDigest(content) },
        items: [
          {
            kind: 'ontology_version',
            family: 'fam-lock-order',
            definition: {
              objectTypes: [{ name: 'LockOrderThing', description: 'd' }],
              linkTypes: [
                {
                  name: 'lockorderthing_of',
                  domain: 'LockOrderThing',
                  range: '*',
                  description: 'd',
                },
              ],
            },
          },
          { kind: 'skill_version', skillId: randomUUID(), content },
        ],
      };

      /** Runs `fn` on one transaction's client and returns the advisory locks it took, in the
       *  order it first took each (taking one it holds again waits on nobody), by key prefix:
       *  `ontology_namespace`, `ontology_family`, `worker_registry`. */
      const locksTakenBy = (fn: (client: PoolClient) => Promise<unknown>) =>
        inWorkspace(ws, async (client) => {
          const taken: string[] = [];
          const query = client.query;
          client.query = ((text: unknown, params?: unknown) => {
            if (
              typeof text === 'string' &&
              text.includes('pg_advisory_xact_lock') &&
              Array.isArray(params)
            ) {
              const key = String(params[0]);
              if (!taken.includes(key)) taken.push(key);
            }
            return (query as (text: unknown, params?: unknown) => unknown).call(
              client,
              text,
              params,
            );
          }) as typeof client.query;
          try {
            await fn(client);
          } finally {
            client.query = query;
          }
          return taken.map((key) => key.split(':')[0] ?? '');
        });
      const ontologyFirst = (taken: readonly string[]) => {
        const registry = taken.indexOf('worker_registry');
        expect(registry).toBeGreaterThan(-1);
        expect(taken.slice(registry).filter((key) => key.startsWith('ontology_'))).toEqual([]);
        expect(taken.slice(0, registry)).toContain('ontology_namespace');
      };

      let segmentId: string | null = null;
      ontologyFirst(
        await locksTakenBy(async (client) => {
          const planned = await planWorkspaceSegment(client, ws.workspaceId, input);
          const applied = await applyWorkspaceSegment(client, ws.workspaceId, {
            ...input,
            reviewedDigest: planned.digest,
            proposedBy: ws.ownerId,
            appliedBy: ws.ownerId,
            channel: 'human',
            confirmedOrdinals: [1, 2],
          });
          segmentId = applied.segmentId;
        }),
      );
      if (!segmentId) throw new Error('apply: nothing applied');
      const applied: string = segmentId;
      // The rollback plans the Skill (item 2) first; its locks still come in the same order.
      ontologyFirst(
        await locksTakenBy((client) =>
          rollBackWorkspaceSegment(client, ws.workspaceId, {
            segmentId: applied,
            rolledBackBy: ws.ownerId,
            confirmedOrdinals: [1, 2],
          }),
        ),
      );
      expect(
        (
          await rows(ws, 'select status from change_segments where workspace_id = $1 and id = $2', [
            applied,
          ])
        ).map((row) => row.status),
      ).toEqual(['rolled_back']);
    });
  },
);
