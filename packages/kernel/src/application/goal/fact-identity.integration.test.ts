import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { proposeWorkerDefinition, publishWorkerDefinition } from '../worker/index.js';
import { GoalPlanValidationError, validatePlan } from './plan.js';
import { createGoalRun } from './service.js';

/**
 * application/goal/fact-identity.integration (legacy 466): a fact check's Object named by
 * ObjectType and identity is matched as written (`objects.identity_key` equal as jsonb), so a plan
 * naming one is checked, when proposed or revised, for an identity that could never match — its
 * fields against the ObjectType's `identityKey`, its values' JSON types against the type's stored
 * Objects. An Object already there with exactly that identity settles it.
 *
 * Its own workspace, with a published ontology: the GO4c tests in `advancer.integration.test.ts`
 * run in one with none. Gated on `DATABASE_URL`.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

describe.runIf(DATABASE_URL !== undefined)(
  'application/goal fact check identities (legacy 466, integration, real Postgres)',
  () => {
    let pool: Pool;
    let workspaceId: string;
    let ownerId: string;
    let requesterId: string;
    let worker: { definitionId: string; version: number };
    const tag = randomUUID().slice(0, 8);
    /** Declared, with an identityKey of two fields. */
    const BOX = `test.l466.Box_${tag}`;
    /** Declared too: the Link's other end. */
    const SHELF = `test.l466.Shelf_${tag}`;
    /** Not declared by any ontology family. */
    const LOOSE = `test.l466.Loose_${tag}`;
    const LINK = `test_l466_holds_${tag}`;
    let shelfId: string;

    const admin = <T>(fn: (client: PoolClient) => Promise<T>) =>
      withWorkspace(pool, { workspaceId, principalId: ownerId }, fn, { skipRoleSwitch: true });
    const asRequester = <T>(fn: (client: PoolClient) => Promise<T>) =>
      withWorkspace(pool, { workspaceId, principalId: requesterId }, fn);

    async function insertObject(objectType: string, identity: unknown): Promise<string> {
      return admin(
        async (client) =>
          (
            await client.query<{ id: string }>(
              `insert into objects (workspace_id, object_type, identity_key)
               values ($1, $2, $3::jsonb) returning id`,
              [workspaceId, objectType, JSON.stringify(identity)],
            )
          ).rows[0]?.id as string,
      );
    }

    /** A one-step plan whose step's fact check names, as its target, `objectType` by `identity`. */
    const planNaming = (objectType: string, identity: Record<string, unknown>) => ({
      steps: [
        {
          key: 'a',
          worker,
          input: { step: 'a' },
          acceptance: [
            {
              kind: 'fact_predicate',
              key: 'holds',
              fact: {
                linkType: LINK,
                source: { objectId: shelfId },
                target: { objectType, identity },
              },
            },
          ],
        },
      ],
    });

    /** The problems `validatePlan` finds with `plan`, as the requester; `[]` when it passes. */
    async function problemsOf(plan: unknown): Promise<readonly string[]> {
      try {
        await asRequester((client) => validatePlan(client, workspaceId, plan, requesterId));
        return [];
      } catch (err) {
        if (!(err instanceof GoalPlanValidationError)) throw err;
        return err.problems;
      }
    }
    const WHERE = 'step "a": acceptance[0] "holds": fact: the target\'s';

    beforeAll(async () => {
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);
      workspaceId = randomUUID();
      ownerId = randomUUID();
      requesterId = randomUUID();
      await admin(async (client) => {
        await client.query('insert into workspaces (id, name) values ($1, $2)', [
          workspaceId,
          'l466-fact-identity',
        ]);
        await client.query(
          `insert into principals (workspace_id, id, kind, role, display_name)
           values ($1, $2, 'human', 'owner', 'owner'), ($1, $3, 'human', 'member', 'requester')`,
          [workspaceId, ownerId, requesterId],
        );
        await client.query(
          `insert into ontology_versions
             (workspace_id, id, version, status, definition, proposed_by, published_by,
              created_at, published_at)
           values ($1, $2, 1, 'published', $3::jsonb, $4, $4, now(), now())`,
          [
            workspaceId,
            randomUUID(),
            JSON.stringify({
              objectTypes: [
                { name: BOX, description: 'A box.', identityKey: ['boxId', 'zone'] },
                { name: SHELF, description: 'A shelf.', identityKey: ['name'] },
              ],
              linkTypes: [{ name: LINK, domain: SHELF, range: BOX, description: 'Holds.' }],
            }),
            ownerId,
          ],
        );
      });
      const proposed = await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        proposeWorkerDefinition(client, workspaceId, ownerId, {
          origin: 'human',
          kind: 'worker',
          definition: { systemPrompt: 'You do one step of a goal.' },
        }),
      );
      await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        publishWorkerDefinition(client, workspaceId, ownerId, {
          definitionId: proposed.id,
          version: proposed.version,
        }),
      );
      worker = { definitionId: proposed.id, version: proposed.version };
      shelfId = await insertObject(SHELF, { name: 'top' });
    });

    afterAll(async () => {
      await admin((client) =>
        client.query(
          `update goal_runs set status = 'cancelled', ended_at = now(), next_tick_at = null
            where workspace_id = $1 and status not in ('completed', 'cancelled', 'failed')`,
          [workspaceId],
        ),
      );
      await pool.end();
    });

    it('an identity with the identityKey’s fields passes before any Object of the type exists', async () => {
      expect(await problemsOf(planNaming(BOX, { boxId: 7, zone: 'a' }))).toEqual([]);
      // Key order is not part of an identity (jsonb).
      expect(await problemsOf(planNaming(BOX, { zone: 'a', boxId: 7 }))).toEqual([]);
    });

    it('an identity with a field fewer or more than the identityKey is refused, naming them', async () => {
      expect(await problemsOf(planNaming(BOX, { boxId: 7 }))).toEqual([
        `${WHERE} identity does not have the fields of ObjectType "${BOX}"'s identityKey ("boxId", "zone"): "zone" missing — and no "${BOX}" Object in this workspace is identified by these fields, so none could match`,
      ]);
      expect(await problemsOf(planNaming(BOX, { boxId: 7, zone: 'a', label: 'x' }))).toEqual([
        `${WHERE} identity does not have the fields of ObjectType "${BOX}"'s identityKey ("boxId", "zone"): "label" not part of it — and no "${BOX}" Object in this workspace is identified by these fields, so none could match`,
      ]);
      expect(await problemsOf(planNaming(BOX, { id: 7, zone: 'a' }))).toEqual([
        `${WHERE} identity does not have the fields of ObjectType "${BOX}"'s identityKey ("boxId", "zone"): "boxId" missing; "id" not part of it — and no "${BOX}" Object in this workspace is identified by these fields, so none could match`,
      ]);
    });

    it('a value of another JSON type than the type’s Objects store is refused; one already there passes', async () => {
      await insertObject(BOX, { boxId: 7, zone: 'a' });
      // Exactly an Object that is there.
      expect(await problemsOf(planNaming(BOX, { boxId: 7, zone: 'a' }))).toEqual([]);
      // Not there yet, but written as the type's Objects are.
      expect(await problemsOf(planNaming(BOX, { boxId: 8, zone: 'b' }))).toEqual([]);
      expect(await problemsOf(planNaming(BOX, { boxId: '7', zone: 'a' }))).toEqual([
        `${WHERE} identity field "boxId" is a string ("7"), but the "${BOX}" Objects in this workspace store it as a number — an identity is matched as written`,
      ]);
      // Both problems of one identity are named.
      expect(await problemsOf(planNaming(BOX, { boxId: '7' }))).toEqual([
        `${WHERE} identity does not have the fields of ObjectType "${BOX}"'s identityKey ("boxId", "zone"): "zone" missing — and no "${BOX}" Object in this workspace is identified by these fields, so none could match`,
        `${WHERE} identity field "boxId" is a string ("7"), but the "${BOX}" Objects in this workspace store it as a number — an identity is matched as written`,
      ]);
    });

    it('a shape the graph already holds passes though the ontology’s key differs (a gate writes identities as they come)', async () => {
      // What a gate's observe or a Worker's result can write: not held to the identityKey.
      await insertObject(BOX, { serial: 'S-1' });
      expect(await problemsOf(planNaming(BOX, { serial: 'S-2' }))).toEqual([]);
      // Its types are still checked.
      expect(await problemsOf(planNaming(BOX, { serial: 2 }))).toEqual([
        `${WHERE} identity field "serial" is a number (2), but the "${BOX}" Objects in this workspace store it as a string — an identity is matched as written`,
      ]);
      // A subset of a shape held is not that shape.
      await insertObject(BOX, { serial: 'S-3', rack: 4 });
      expect(await problemsOf(planNaming(BOX, { rack: 4 }))).toEqual([
        `${WHERE} identity does not have the fields of ObjectType "${BOX}"'s identityKey ("boxId", "zone"): "boxId", "zone" missing; "rack" not part of it — and no "${BOX}" Object in this workspace is identified by these fields, so none could match`,
      ]);
    });

    it('an ObjectType no ontology declares has no key to check, only its stored types', async () => {
      expect(await problemsOf(planNaming(LOOSE, { anything: 1 }))).toEqual([]);
      await insertObject(LOOSE, { n: 1 });
      await insertObject(LOOSE, { n: null });
      expect(await problemsOf(planNaming(LOOSE, { other: 'x' }))).toEqual([]);
      expect(await problemsOf(planNaming(LOOSE, { n: 2 }))).toEqual([]);
      expect(await problemsOf(planNaming(LOOSE, { n: '1' }))).toEqual([
        `${WHERE} identity field "n" is a string ("1"), but the "${LOOSE}" Objects in this workspace store it as null or number — an identity is matched as written`,
      ]);
    });

    // #493 P3: the exact match reads every Object of the type, not the sample. 1000 Objects store
    // `n` as a number; the one storing it as a boolean comes after them in both the insert order
    // and the (workspace, type, identity) index order (a jsonb boolean sorts after a number), so
    // it is past the sample either way — naming it still passes.
    it('an Object with exactly this identity settles it even past the sample of stored types', async () => {
      const many = `test.l466.Many_${tag}`;
      await admin((client) =>
        client.query(
          `insert into objects (workspace_id, object_type, identity_key)
           select $1, $2, jsonb_build_object('n', i) from generate_series(1, 1000) as i`,
          [workspaceId, many],
        ),
      );
      await insertObject(many, { n: true });
      expect(await problemsOf(planNaming(many, { n: true }))).toEqual([]);
      expect(await problemsOf(planNaming(many, { n: 1001 }))).toEqual([]);
      expect(await problemsOf(planNaming(many, { n: '1' }))).toHaveLength(1);
    });

    // Legacy 704: the Objects a fact check names are read for its requester, as every graph read
    // is (`operation-draft-visibility.ts`) — an Operation draft they may not see is not there:
    // neither "does not exist" nor an identity's stored types may tell it apart.
    it('an Operation draft the requester may not see is not there: by id it does not exist, and its identity shapes nothing; its proposer and a reviewer see it', async () => {
      const name = `l704-${tag}`;
      const draft = await admin(
        async (client) =>
          (
            await client.query<{ id: string }>(
              `insert into objects (workspace_id, object_type, identity_key, properties)
               values ($1, 'Operation', $2::jsonb, $3::jsonb) returning id`,
              [
                workspaceId,
                JSON.stringify({ name }),
                JSON.stringify({ status: 'draft', proposedBy: ownerId, proposedByKind: 'human' }),
              ],
            )
          ).rows[0]?.id as string,
      );
      const planNamingId = (objectId: string) => ({
        steps: [
          {
            key: 'a',
            worker,
            input: { step: 'a' },
            acceptance: [
              {
                kind: 'fact_predicate',
                key: 'holds',
                fact: { linkType: LINK, source: { objectId: shelfId }, target: { objectId } },
              },
            ],
          },
        ],
      });
      const problemsFor = async (principal: string, plan: unknown) => {
        try {
          await withWorkspace(pool, { workspaceId, principalId: principal }, (client) =>
            validatePlan(client, workspaceId, plan, principal),
          );
          return [];
        } catch (err) {
          if (!(err instanceof GoalPlanValidationError)) throw err;
          return err.problems;
        }
      };

      // The requester (a member, not its proposer): no such Object.
      expect(await problemsOf(planNamingId(draft))).toEqual([
        `step "a": acceptance[0] "holds": fact: the target Object ${draft} does not exist in this workspace`,
      ]);
      // And no Operation in the workspace stores `name` at all, for them.
      expect(await problemsOf(planNaming('Operation', { name: 7 }))).toEqual([]);

      // Its proposer, an owner (who sees every draft): it is there, and it stores `name` as a string.
      expect(await problemsFor(ownerId, planNamingId(draft))).toEqual([]);
      expect(await problemsFor(ownerId, planNaming('Operation', { name: 7 }))).toEqual([
        `${WHERE} identity field "name" is a number (7), but the "Operation" Objects in this workspace store it as a string — an identity is matched as written`,
      ]);

      // Published, it is everyone's.
      await admin((client) =>
        client.query(
          `update objects set properties = properties || '{"status": "published"}'::jsonb
            where workspace_id = $1 and id = $2`,
          [workspaceId, draft],
        ),
      );
      expect(await problemsOf(planNamingId(draft))).toEqual([]);
      expect(await problemsOf(planNaming('Operation', { name: 7 }))).toHaveLength(1);
    });

    it('proposing a goal refuses it, for a step’s check and the goal’s own alike', async () => {
      const plan = planNaming(BOX, { boxId: '7', zone: 'a' });
      const step = plan.steps[0];
      if (!step) throw new Error('no step');
      const withGoalCheck = {
        ...plan,
        acceptance: [{ ...step.acceptance[0], key: 'goal_holds' }],
      };
      let problems: readonly string[] = [];
      try {
        await asRequester((client) =>
          createGoalRun(client, workspaceId, {
            requesterId,
            proposedBy: requesterId,
            statement: 'shelve the box',
            plan: withGoalCheck,
            budget: {
              maxTokens: 1_000_000,
              maxSteps: 10,
              maxRevisions: 2,
              maxWallClockSeconds: 3600,
            },
          }),
        );
      } catch (err) {
        expect(err).toBeInstanceOf(GoalPlanValidationError);
        problems = (err as GoalPlanValidationError).problems;
      }
      const typeProblem = `identity field "boxId" is a string ("7"), but the "${BOX}" Objects in this workspace store it as a number — an identity is matched as written`;
      expect(problems).toEqual([
        `${WHERE} ${typeProblem}`,
        `acceptance[0] "goal_holds": fact: the target's ${typeProblem}`,
      ]);
      const runs = await admin((client) =>
        client.query('select 1 from goal_runs where workspace_id = $1', [workspaceId]),
      );
      expect(runs.rowCount).toBe(0);
    });
  },
);
