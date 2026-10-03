import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Role } from '@nexttime/shared';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import {
  OntologyBaseMovedError,
  OntologyDraftNotFoundError,
  loadPublishedLinkTypes,
  publishOntologyDomainPack,
  publishOntologyVersion,
} from '../../substrate/ontology/index.js';
import { dispatchCapability, isResultValidationEnabled } from './dispatch.js';
import type { ResolvedCaller } from './resolve-caller.js';

/**
 * application/gateway/ontology-handlers.integration.test: DB-gated (real Postgres; auto-skip
 * without DATABASE_URL) proof that the five `ontology`-group capabilities are wired end-to-end
 * through `dispatchCapability` — registry.ts's own unit/semantic coverage
 * (`substrate/ontology/registry.test.ts`) does not exercise `authorizeCapabilityCall`,
 * `paramsSchema` validation, or `resultSchema` validation (`KERNEL_VALIDATE_RESULTS=1`, set by
 * `vitest.base.ts`/CI — see dispatch.ts's own doc comment), all of which only run on this path.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');
const REPO_ROOT = path.resolve(KERNEL_ROOT, '..', '..');
const ONTOLOGY_DIR = path.join(REPO_ROOT, 'ontology');

function humanCaller(
  workspaceId: string,
  principalId: string,
  role: Role = 'owner',
): ResolvedCaller {
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

/** A fabricated Handle caller carrying exactly the ontology capability names it needs —
 *  `authorize.ts`'s handle-channel branch checks `scope.capabilities` only (no `minRole` check for
 *  the handle channel — that file's own documented gap), so this is enough to exercise the real
 *  `authorizeCapabilityCall` path without minting a real issued Handle
 *  (`invoke-worker-handler.integration.test.ts`'s own doc comment explains when a *real* issued
 *  Handle is required — spawning a child WorkerRun; none of these five capabilities do). */
function handleCaller(
  workspaceId: string,
  obo: string,
  capabilities: readonly string[],
): ResolvedCaller {
  const now = Math.floor(Date.now() / 1000);
  return {
    channel: 'handle',
    claims: {
      ws: workspaceId,
      sid: randomUUID(),
      obo,
      scope: { capabilities: [...capabilities], resources: {} },
      jti: randomUUID(),
      iat: now,
      exp: now + 600,
    },
  };
}

const ONTOLOGY_HANDLE_CAPABILITIES = [
  'get_type',
  'list_types',
  'validate',
  'propose_ontology_change',
  // Closing wave C5b (coverage gap G1 part 2).
  'list_ontology_versions',
];

describe.runIf(DATABASE_URL !== undefined)(
  'ontology-handlers (integration, real Postgres, dispatchCapability)',
  () => {
    let pool: Pool;
    let workspaceId: string;
    let ownerId: string;
    let aliceId: string;
    let bobId: string;
    let carolId: string;
    let daveId: string;

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

    async function adminInsertPrincipal(displayName: string, role: Role): Promise<string> {
      const id = randomUUID();
      await withWorkspace(
        pool,
        { workspaceId, principalId: id },
        async (client) => {
          await client.query(
            'insert into principals (workspace_id, id, kind, role, display_name) values ($1, $2, $3, $4, $5)',
            [workspaceId, id, 'human', role, displayName],
          );
        },
        { skipRoleSwitch: true },
      );
      return id;
    }

    beforeAll(async () => {
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);
      workspaceId = await adminInsertWorkspace('ontology-handlers-test-workspace');
      ownerId = await adminInsertPrincipal('owner', 'owner');
      aliceId = await adminInsertPrincipal('alice', 'builder');
      bobId = await adminInsertPrincipal('bob', 'builder');
      carolId = await adminInsertPrincipal('carol', 'member');
      daveId = await adminInsertPrincipal('dave', 'auditor');

      // Publish the real ops-assets-v1.yaml domain pack so get_type/list_types have a stable,
      // workspace-visible-to-everyone type catalog to read (deliverable 4: "get_type for every
      // type in ops-assets-v1").
      await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        publishOntologyDomainPack(client, workspaceId, {
          packName: 'ops-assets',
          fileName: 'ops-assets-v1.yaml',
          dir: ONTOLOGY_DIR,
          principalId: ownerId,
        }),
      );
    });

    afterAll(async () => {
      await pool.end();
    });

    it('KERNEL_VALIDATE_RESULTS=1 is on for this test run (sanity check for the resultSchema assertions below)', () => {
      expect(isResultValidationEnabled()).toBe(true);
    });

    it('get_type (handle channel) resolves every ops-assets-v1 ObjectType and validates against resultSchema', async () => {
      const caller = handleCaller(workspaceId, bobId, ONTOLOGY_HANDLE_CAPABILITIES);
      for (const name of ['Host', 'Container', 'Repository']) {
        const result = (await dispatchCapability({ pool }, caller, 'get_type', {
          typeName: name,
        })) as { kind: string; name: string; identityKey?: string[] };
        expect(result.kind).toBe('object');
        expect(result.name).toBe(name);
      }
    });

    it('get_type returns null for an unknown type name', async () => {
      const caller = handleCaller(workspaceId, bobId, ONTOLOGY_HANDLE_CAPABILITIES);
      const result = await dispatchCapability({ pool }, caller, 'get_type', {
        typeName: 'DoesNotExist',
      });
      expect(result).toBeNull();
    });

    it('list_types{kind:"link"} returns the envelope shape and includes a multi-signature LinkType', async () => {
      const caller = handleCaller(workspaceId, bobId, ONTOLOGY_HANDLE_CAPABILITIES);
      const result = (await dispatchCapability({ pool }, caller, 'list_types', {
        kind: 'link',
      })) as { items: Array<{ kind: string; name: string; signatures?: unknown[] }> };
      expect(Array.isArray(result.items)).toBe(true);
      const runsOn = result.items.find((item) => item.name === 'runs_on');
      expect(runsOn?.kind).toBe('link');
      expect(runsOn?.signatures?.length ?? 0).toBeGreaterThanOrEqual(4);
    });

    it('validate accepts an enumerated pair and rejects an unlisted one, both via dispatchCapability', async () => {
      const caller = handleCaller(workspaceId, bobId, ONTOLOGY_HANDLE_CAPABILITIES);
      const accepted = (await dispatchCapability({ pool }, caller, 'validate', {
        link: { linkType: 'mounts', sourceType: 'Container', targetType: 'Volume' },
      })) as { valid: boolean };
      expect(accepted.valid).toBe(true);

      const rejected = (await dispatchCapability({ pool }, caller, 'validate', {
        link: { linkType: 'mounts', sourceType: 'Volume', targetType: 'Container' },
      })) as { valid: boolean; errors?: string[] };
      expect(rejected.valid).toBe(false);
      expect(rejected.errors?.length).toBeGreaterThan(0);
    });

    it('propose_ontology_change (handle) is rejected on the human-only publish_ontology_version capability', async () => {
      const caller = handleCaller(workspaceId, aliceId, ONTOLOGY_HANDLE_CAPABILITIES);
      await expect(
        dispatchCapability({ pool }, caller, 'publish_ontology_version', {
          id: randomUUID(),
          version: 1,
        }),
      ).rejects.toThrow(/human-channel-only/);
    });

    it("propose_ontology_change creates a draft invisible to another principal's get_type; its proposer's publish_ontology_version (human) makes it visible", async () => {
      const change = {
        objectTypes: [{ name: 'Gadget', description: 'A gadget.', identityKey: ['gadgetId'] }],
        linkTypes: [{ name: 'gadget_rel', domain: 'Gadget', range: 'Gadget', description: 'd' }],
      };

      const aliceCaller = handleCaller(workspaceId, aliceId, ONTOLOGY_HANDLE_CAPABILITIES);
      const proposeResult = (await dispatchCapability(
        { pool },
        aliceCaller,
        'propose_ontology_change',
        { change },
      )) as { id: string; version: number; status: string };
      expect(proposeResult.status).toBe('draft');

      // Alice sees her own draft.
      const aliceSees = await dispatchCapability({ pool }, aliceCaller, 'get_type', {
        typeName: 'Gadget',
      });
      expect(aliceSees).not.toBeNull();

      // Bob (a different Handle caller, same workspace) does not — I16.
      const bobCaller = handleCaller(workspaceId, bobId, ONTOLOGY_HANDLE_CAPABILITIES);
      const bobSees = await dispatchCapability({ pool }, bobCaller, 'get_type', {
        typeName: 'Gadget',
      });
      expect(bobSees).toBeNull();

      // Alice herself, in the console (human channel), publishes the draft her Handle proposed —
      // publish_ontology_version is channel:'human' only (I16) and proposer-only (leftover 100).
      const aliceHuman = humanCaller(workspaceId, aliceId, 'builder');
      const publishResult = (await dispatchCapability(
        { pool },
        aliceHuman,
        'publish_ontology_version',
        { id: proposeResult.id, version: proposeResult.version },
      )) as { id: string; version: number; status: string; publishedAt: string | null };
      expect(publishResult.status).toBe('published');
      expect(publishResult.publishedAt).not.toBeNull();

      // Now Bob sees it too.
      const bobSeesNow = await dispatchCapability({ pool }, bobCaller, 'get_type', {
        typeName: 'Gadget',
      });
      expect(bobSeesNow).not.toBeNull();
    });

    // STATUS leftover 100 (2026-10-01, maintainer: "builder + 只能发自己的"): a member or auditor is
    // refused by the role gate before any lookup; any other human — another builder, even the
    // owner — gets the same not-found as a missing row (they cannot see the draft, so they
    // cannot have reviewed it). The draft survives all of it and its proposer still publishes.
    it('publish_ontology_version: member/auditor 403 on minRole; another builder or the owner reads not-found; the proposer still publishes', async () => {
      const change = {
        objectTypes: [{ name: 'Flange', description: 'A flange.', identityKey: ['flangeId'] }],
        linkTypes: [{ name: 'flange_rel', domain: 'Flange', range: 'Flange', description: 'd' }],
      };
      const aliceCaller = handleCaller(workspaceId, aliceId, ONTOLOGY_HANDLE_CAPABILITIES);
      const draft = (await dispatchCapability({ pool }, aliceCaller, 'propose_ontology_change', {
        change,
      })) as { id: string; version: number };
      const params = { id: draft.id, version: draft.version };

      for (const [principalId, role] of [
        [carolId, 'member'],
        [daveId, 'auditor'],
      ] as const) {
        await expect(
          dispatchCapability(
            { pool },
            humanCaller(workspaceId, principalId, role),
            'publish_ontology_version',
            params,
          ),
        ).rejects.toThrow(/minRole "builder"/);
      }

      for (const [principalId, role] of [
        [bobId, 'builder'],
        [ownerId, 'owner'],
      ] as const) {
        await expect(
          dispatchCapability(
            { pool },
            humanCaller(workspaceId, principalId, role),
            'publish_ontology_version',
            params,
          ),
        ).rejects.toThrow(OntologyDraftNotFoundError);
      }

      const stillHidden = await dispatchCapability(
        { pool },
        handleCaller(workspaceId, bobId, ONTOLOGY_HANDLE_CAPABILITIES),
        'get_type',
        { typeName: 'Flange' },
      );
      expect(stillHidden).toBeNull();

      const published = (await dispatchCapability(
        { pool },
        humanCaller(workspaceId, aliceId, 'builder'),
        'publish_ontology_version',
        params,
      )) as { status: string };
      expect(published.status).toBe('published');
    });

    // R-60 (review 2026-10-02, L3-5): every version is a full replacement definition, so of two
    // drafts made from the same published version, whichever publishes second would silently
    // drop what the first added (or, with the lower number, publish into nothing). The second
    // publish is now refused 409 `ontology_base_moved` and the first one's types stay in force.
    describe('R-60: a draft whose base is no longer the published head is refused', () => {
      const BASE_CHANGE = {
        objectTypes: [{ name: 'Valve', description: 'A valve.', identityKey: ['valveId'] }],
        linkTypes: [{ name: 'valve_feeds', domain: 'Valve', range: 'Valve', description: 'd' }],
      };
      function withLinkType(...names: string[]) {
        return {
          ...BASE_CHANGE,
          linkTypes: [
            ...BASE_CHANGE.linkTypes,
            ...names.map((name) => ({
              name,
              domain: 'Valve',
              range: 'Valve',
              description: `${name} (R-60 fixture)`,
            })),
          ],
        };
      }

      /** A fresh family published at v1 by Alice — what both later drafts start from. */
      async function publishedFamily(): Promise<string> {
        const v1 = (await dispatchCapability(
          { pool },
          handleCaller(workspaceId, aliceId, ONTOLOGY_HANDLE_CAPABILITIES),
          'propose_ontology_change',
          { change: BASE_CHANGE },
        )) as { id: string; version: number };
        await dispatchCapability(
          { pool },
          humanCaller(workspaceId, aliceId, 'builder'),
          'publish_ontology_version',
          { id: v1.id, version: v1.version },
        );
        return v1.id;
      }

      async function propose(principalId: string, id: string, change: unknown) {
        return (await dispatchCapability(
          { pool },
          handleCaller(workspaceId, principalId, ONTOLOGY_HANDLE_CAPABILITIES),
          'propose_ontology_change',
          { id, change },
        )) as { id: string; version: number };
      }

      function publish(principalId: string, draft: { id: string; version: number }) {
        return dispatchCapability(
          { pool },
          humanCaller(workspaceId, principalId, 'builder'),
          'publish_ontology_version',
          { id: draft.id, version: draft.version },
        );
      }

      async function publishedLinkTypeNames(): Promise<string[]> {
        const linkTypes = await withWorkspace(pool, { workspaceId, principalId: ownerId }, (c) =>
          loadPublishedLinkTypes(c, workspaceId),
        );
        return [...linkTypes.keys()];
      }

      it('two drafts from the same base: the first publishes, the second gets 409 and the first’s LinkTypes survive', async () => {
        const familyId = await publishedFamily();
        const aliceDraft = await propose(aliceId, familyId, withLinkType('valve_alice_rel'));
        const bobDraft = await propose(bobId, familyId, withLinkType('valve_bob_rel'));
        expect([aliceDraft.version, bobDraft.version]).toEqual([2, 3]);

        await publish(aliceId, aliceDraft);
        const refused = publish(bobId, bobDraft);
        await expect(refused).rejects.toThrow(OntologyBaseMovedError);
        await expect(refused).rejects.toMatchObject({
          code: 'ontology_base_moved',
          baseVersion: 1,
          publishedVersion: 2,
        });

        // Enforcement still reads Alice's v2: her LinkType is declared, Bob's never was.
        const names = await publishedLinkTypeNames();
        expect(names).toContain('valve_alice_rel');
        expect(names).not.toContain('valve_bob_rel');
        // A third principal with no drafts of their own sees the same through `validate`.
        const carolValidates = (await dispatchCapability(
          { pool },
          handleCaller(workspaceId, carolId, ONTOLOGY_HANDLE_CAPABILITIES),
          'validate',
          { link: { linkType: 'valve_alice_rel', sourceType: 'Valve', targetType: 'Valve' } },
        )) as { valid: boolean };
        expect(carolValidates.valid).toBe(true);

        // Bob's draft is untouched (still his, still a draft) and he can propose again from v2.
        const bobList = (await dispatchCapability(
          { pool },
          handleCaller(workspaceId, bobId, ONTOLOGY_HANDLE_CAPABILITIES),
          'list_ontology_versions',
          {},
        )) as { items: Array<{ id: string; version: number; status: string }> };
        expect(
          bobList.items.find((i) => i.id === familyId && i.version === bobDraft.version)?.status,
        ).toBe('draft');
        const bobAgain = await propose(
          bobId,
          familyId,
          withLinkType('valve_alice_rel', 'valve_bob_rel'),
        );
        await publish(bobId, bobAgain);
        expect(await publishedLinkTypeNames()).toEqual(
          expect.arrayContaining(['valve_alice_rel', 'valve_bob_rel']),
        );
      });

      it('the other order: once the higher-numbered draft is published, the lower-numbered one is refused instead of publishing into nothing', async () => {
        const familyId = await publishedFamily();
        const aliceDraft = await propose(aliceId, familyId, withLinkType('valve_low_rel'));
        const bobDraft = await propose(bobId, familyId, withLinkType('valve_high_rel'));

        await publish(bobId, bobDraft);
        await expect(publish(aliceId, aliceDraft)).rejects.toMatchObject({
          code: 'ontology_base_moved',
          baseVersion: 1,
          publishedVersion: 3,
        });
        const names = await publishedLinkTypeNames();
        expect(names).toContain('valve_high_rel');
        expect(names).not.toContain('valve_low_rel');
      });

      it('a loader publish (domain pack / module) into the family moves its head the same way', async () => {
        const familyId = await publishedFamily();
        const aliceDraft = await propose(aliceId, familyId, withLinkType('valve_pack_rel'));
        await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
          publishOntologyVersion(client, workspaceId, {
            id: familyId,
            definition: BASE_CHANGE,
            principalId: ownerId,
          }),
        );
        await expect(publish(aliceId, aliceDraft)).rejects.toThrow(OntologyBaseMovedError);
      });

      it('a draft whose base is still the head publishes, including over another proposer’s discarded draft', async () => {
        const familyId = await publishedFamily();
        const bobDraft = await propose(bobId, familyId, withLinkType('valve_dropped_rel'));
        await dispatchCapability(
          { pool },
          humanCaller(workspaceId, bobId, 'builder'),
          'discard_draft',
          { kind: 'ontology_version', id: bobDraft.id, version: bobDraft.version },
        );
        const aliceDraft = await propose(aliceId, familyId, withLinkType('valve_kept_rel'));
        const published = (await publish(aliceId, aliceDraft)) as { status: string };
        expect(published.status).toBe('published');
      });

      it('another principal’s draft still reads not-found, never base-moved (nothing about the family leaks)', async () => {
        const familyId = await publishedFamily();
        const aliceDraft = await propose(aliceId, familyId, withLinkType('valve_private_rel'));
        const bobDraft = await propose(bobId, familyId, withLinkType('valve_other_rel'));
        await publish(bobId, bobDraft);
        await expect(publish(bobId, aliceDraft)).rejects.toThrow(OntologyDraftNotFoundError);
      });
    });

    // Closing wave C5b (coverage gap G1 part 2): `list_ontology_versions` end to end through
    // dispatchCapability — proves the resultSchema (`OntologyVersionListItemWireSchema`) matches
    // the handler's actual output under `KERNEL_VALIDATE_RESULTS=1`, and that a Handle's own
    // `obo` (I13) is exactly what `proposedBy` resolves to (the precedent this task's own dispatch
    // asked to verify end to end: an entry agent's Handle carries `obo` = the human principal it
    // acts for, and `proposeOntologyChangeHandler` records `proposedBy = ctx.principalId` — the
    // same `obo` — so the human sees their own agent's proposal via "own drafts", no cross-
    // principal visibility widening).
    it('list_ontology_versions (handle) mirrors list_worker_definitions/list_skills: own draft visible, another principal’s draft absent, published visible to all, proposedBy resolves to the Handle’s obo', async () => {
      const change = {
        objectTypes: [
          { name: 'Sprocket', description: 'A sprocket.', identityKey: ['sprocketId'] },
        ],
        linkTypes: [
          { name: 'sprocket_rel', domain: 'Sprocket', range: 'Sprocket', description: 'd' },
        ],
      };
      const aliceCaller = handleCaller(workspaceId, aliceId, ONTOLOGY_HANDLE_CAPABILITIES);
      const proposeResult = (await dispatchCapability(
        { pool },
        aliceCaller,
        'propose_ontology_change',
        { change },
      )) as { id: string; version: number; status: string };

      // Alice's own list includes her draft, proposedBy resolved to exactly her Handle's obo.
      const aliceList = (await dispatchCapability(
        { pool },
        aliceCaller,
        'list_ontology_versions',
        {},
      )) as {
        items: Array<{
          id: string;
          version: number;
          status: string;
          proposedBy: { id: string; kind: string; displayName: string | null };
        }>;
      };
      const aliceRow = aliceList.items.find(
        (item) => item.id === proposeResult.id && item.version === proposeResult.version,
      );
      expect(aliceRow?.status).toBe('draft');
      expect(aliceRow?.proposedBy).toEqual({ id: aliceId, kind: 'human', displayName: 'alice' });

      // Bob (a different Handle caller) does not see it — same I16 read-privacy predicate as
      // get_type/list_types.
      const bobCaller = handleCaller(workspaceId, bobId, ONTOLOGY_HANDLE_CAPABILITIES);
      const bobList = (await dispatchCapability(
        { pool },
        bobCaller,
        'list_ontology_versions',
        {},
      )) as { items: Array<{ id: string; version: number }> };
      expect(
        bobList.items.some(
          (item) => item.id === proposeResult.id && item.version === proposeResult.version,
        ),
      ).toBe(false);

      // Alice (human channel) publishes her own draft — now Bob sees the same row, published.
      const aliceHuman = humanCaller(workspaceId, aliceId, 'builder');
      await dispatchCapability({ pool }, aliceHuman, 'publish_ontology_version', {
        id: proposeResult.id,
        version: proposeResult.version,
      });
      const bobListAfterPublish = (await dispatchCapability(
        { pool },
        bobCaller,
        'list_ontology_versions',
        {},
      )) as { items: Array<{ id: string; version: number; status: string }> };
      const bobRow = bobListAfterPublish.items.find(
        (item) => item.id === proposeResult.id && item.version === proposeResult.version,
      );
      expect(bobRow?.status).toBe('published');
    });

    it('list_ontology_versions (human, owner) sees the same rows — channel:"handle" admits a human caller too', async () => {
      const ownerCaller = humanCaller(workspaceId, ownerId, 'owner');
      const result = (await dispatchCapability(
        { pool },
        ownerCaller,
        'list_ontology_versions',
        {},
      )) as { items: unknown[] };
      expect(Array.isArray(result.items)).toBe(true);
      expect(result.items.length).toBeGreaterThan(0);
    });
  },
);
