import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PrincipalKind, Role } from '@nexttime/shared';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import {
  HumanAttestationRequiresHumanError,
  ReservedEvidenceKindError,
  attachEvidence,
  attachHumanAttestation,
  startActivity,
} from '../../substrate/epistemic/index.js';
import { SqlGraphStore } from '../../substrate/graph/index.js';
import { dispatchCapability, isResultValidationEnabled } from './dispatch.js';
import type { ResolvedCaller } from './resolve-caller.js';

/**
 * application/gateway/attest-fact.integration.test: DB-gated (real Postgres; auto-skip without
 * DATABASE_URL) proof of STATUS leftover 89 end-to-end through `dispatchCapability` — a person's
 * `attest_fact` writes Evidence of the reserved `human_attestation` kind attributed to that
 * person, under its own `epistemic.human_attestation` Activity, with an audit row in the same
 * transaction; `verify_fact` then accepts a Fact whose only Evidence is that attestation (and
 * still refuses one with none); `explain` returns it labelled, apart from machine evidence; a
 * Handle or a service Principal can never create one. The non-DB layers (registry, issuance,
 * handler refusals, substrate writer) are `attest-fact.test.ts`.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

function humanCaller(
  workspaceId: string,
  principalId: string,
  role: Role = 'member',
  kind: PrincipalKind = 'human',
): ResolvedCaller {
  return {
    channel: 'human',
    principal: { workspaceId, id: principalId, kind, role, displayName: null },
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

interface HumanAttestationResult {
  id: string;
  factId: string;
  kind: string;
  note: string;
  link: string | null;
  activityId: string;
  attestedBy: string;
  createdAt: string;
}

describe.runIf(DATABASE_URL !== undefined)(
  'attest_fact (integration, real Postgres, dispatchCapability) — leftover 89',
  () => {
    let pool: Pool;
    const store = new SqlGraphStore();
    let workspaceId: string;
    let ownerId: string;
    let memberId: string;
    let serviceId: string;

    async function insertPrincipal(
      displayName: string,
      role: Role,
      kind: PrincipalKind,
    ): Promise<string> {
      const id = randomUUID();
      await withWorkspace(
        pool,
        { workspaceId, principalId: id },
        async (client) => {
          await client.query(
            'insert into principals (workspace_id, id, kind, role, display_name) values ($1, $2, $3, $4, $5)',
            [workspaceId, id, kind, role, displayName],
          );
        },
        { skipRoleSwitch: true },
      );
      return id;
    }

    /** One fresh, active Fact asserted by the collector-shaped service Principal. */
    async function makeFact(): Promise<string> {
      return withWorkspace(pool, { workspaceId, principalId: ownerId }, async (client) => {
        const host = await store.upsertObject(client, workspaceId, {
          objectType: 'test.host',
          identity: { hostname: `attest-${randomUUID()}` },
        });
        const service = await store.upsertObject(client, workspaceId, {
          objectType: 'test.service',
          identity: { name: `attest-svc-${randomUUID()}` },
        });
        const activity = await startActivity(client, workspaceId, { kind: 'test.ingest' });
        const fact = await store.assertFact(
          client,
          workspaceId,
          { id: serviceId, kind: 'service' },
          {
            linkType: 'test.runs_on',
            sourceObjectId: service.id,
            targetObjectId: host.id,
            activityId: activity.id,
          },
        );
        return fact.id;
      });
    }

    async function evidenceRows(factId: string) {
      return withWorkspace(pool, { workspaceId, principalId: ownerId }, async (client) => {
        const result = await client.query<{
          id: string;
          kind: string;
          created_by: string;
          content: Record<string, unknown>;
        }>(
          'select id, kind, created_by, content from evidence where workspace_id = $1 and link_id = $2 order by created_at asc, id asc',
          [workspaceId, factId],
        );
        return result.rows;
      });
    }

    beforeAll(async () => {
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);
      workspaceId = randomUUID();
      await withWorkspace(
        pool,
        { workspaceId, principalId: randomUUID() },
        async (client) => {
          await client.query('insert into workspaces (id, name) values ($1, $2)', [
            workspaceId,
            'attest-fact-test-workspace',
          ]);
        },
        { skipRoleSwitch: true },
      );
      ownerId = await insertPrincipal('owner', 'owner', 'human');
      memberId = await insertPrincipal('Alice', 'member', 'human');
      serviceId = await insertPrincipal('collector', 'member', 'service');
    });

    afterAll(async () => {
      await pool.end();
    });

    it('KERNEL_VALIDATE_RESULTS=1 is on for this run (the resultSchema checks below rely on it)', () => {
      expect(isResultValidationEnabled()).toBe(true);
    });

    it('records a human_attestation Evidence row by the caller, under its own Activity, with an audit row', async () => {
      const factId = await makeFact();
      const result = (await dispatchCapability(
        { pool },
        humanCaller(workspaceId, memberId),
        'attest_fact',
        { factId, note: '  Checked the rack myself.  ', link: 'https://ticket.example/42' },
      )) as HumanAttestationResult;

      expect(result).toMatchObject({
        factId,
        kind: 'human_attestation',
        note: 'Checked the rack myself.',
        link: 'https://ticket.example/42',
        attestedBy: memberId,
      });

      const rows = await evidenceRows(factId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: result.id,
        kind: 'human_attestation',
        created_by: memberId,
        content: {
          note: 'Checked the rack myself.',
          link: 'https://ticket.example/42',
          activityId: result.activityId,
        },
      });

      await withWorkspace(pool, { workspaceId, principalId: ownerId }, async (client) => {
        const activity = await client.query<{ kind: string; status: string; started_by: string }>(
          'select kind, status, started_by from activities where workspace_id = $1 and id = $2',
          [workspaceId, result.activityId],
        );
        expect(activity.rows[0]).toEqual({
          kind: 'epistemic.human_attestation',
          status: 'completed',
          started_by: memberId,
        });

        const audit = await client.query<{
          actor_principal_id: string;
          resource_type: string;
          payload: { channel: string; params: { factId: string; note: string } };
        }>(
          `select actor_principal_id, resource_type, payload from audit_records
           where workspace_id = $1 and action = 'attest_fact' and resource_id = $2`,
          [workspaceId, factId],
        );
        expect(audit.rows).toHaveLength(1);
        expect(audit.rows[0]?.actor_principal_id).toBe(memberId);
        expect(audit.rows[0]?.resource_type).toBe('fact');
        expect(audit.rows[0]?.payload.channel).toBe('human');
        expect(audit.rows[0]?.payload.params.note).toBe('Checked the rack myself.');
      });
    });

    it('verify_fact accepts a Fact whose only Evidence is a human attestation, and still refuses one with none', async () => {
      const bare = await makeFact();
      const attested = await makeFact();
      const member = humanCaller(workspaceId, memberId);

      await expect(
        dispatchCapability({ pool }, member, 'verify_fact', { factId: bare }),
      ).rejects.toThrow(/no Evidence on file/);

      await dispatchCapability({ pool }, member, 'attest_fact', {
        factId: attested,
        note: 'Confirmed with the service owner.',
      });
      const verified = (await dispatchCapability({ pool }, member, 'verify_fact', {
        factId: attested,
      })) as { epistemicStatus: string; verifiedBy: string | null };
      expect(verified.epistemicStatus).toBe('verified');
      expect(verified.verifiedBy).toBe(memberId);

      // The bare Fact is untouched — still refused.
      await expect(
        dispatchCapability({ pool }, member, 'verify_fact', { factId: bare }),
      ).rejects.toThrow(/no Evidence on file/);
    });

    it('explain returns the attestation labelled and attributed, apart from machine evidence — for an agent too', async () => {
      const factId = await makeFact();
      await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        attachEvidence(client, workspaceId, {
          linkId: factId,
          kind: 'command_output',
          content: { stdout: 'service up' },
          createdBy: memberId,
        }),
      );
      const attestation = (await dispatchCapability(
        { pool },
        humanCaller(workspaceId, memberId),
        'attest_fact',
        { factId, note: 'Seen running on the console.' },
      )) as HumanAttestationResult;

      // The agent-facing read: an entry agent's Handle calling explain.
      const explained = (await dispatchCapability(
        { pool },
        handleCaller(workspaceId, ownerId, ['explain']),
        'explain',
        { nodeId: factId },
      )) as {
        fact: {
          humanAttestations: Array<{
            id: string;
            kind: string;
            note: string;
            link: string | null;
            activityId: string | null;
            attestedByPrincipal: { id: string; kind: string; displayName: string | null } | null;
            createdAt: string;
          }>;
        };
      };
      expect(explained.fact.humanAttestations).toEqual([
        {
          id: attestation.id,
          kind: 'human_attestation',
          note: 'Seen running on the console.',
          link: null,
          activityId: attestation.activityId,
          attestedByPrincipal: {
            id: memberId,
            kind: 'human',
            role: 'member',
            displayName: 'Alice',
          },
          createdAt: attestation.createdAt,
        },
      ]);
      // Two Evidence rows on file, only the human one is a human attestation.
      expect(await evidenceRows(factId)).toHaveLength(2);

      const bare = await makeFact();
      const bareExplained = (await dispatchCapability(
        { pool },
        humanCaller(workspaceId, memberId),
        'explain',
        { nodeId: bare },
      )) as { fact: { humanAttestations: unknown[] } };
      expect(bareExplained.fact.humanAttestations).toEqual([]);
    });

    it('a Handle can never create a human attestation — not even one whose scope names attest_fact', async () => {
      const factId = await makeFact();
      await expect(
        dispatchCapability(
          { pool },
          handleCaller(workspaceId, memberId, ['attest_fact']),
          'attest_fact',
          {
            factId,
            note: 'an agent speaking for a person',
          },
        ),
      ).rejects.toThrow(/human-channel-only/);
      expect(await evidenceRows(factId)).toEqual([]);
    });

    it('a service Principal on the human channel (an API key) is refused', async () => {
      const factId = await makeFact();
      await expect(
        dispatchCapability(
          { pool },
          humanCaller(workspaceId, serviceId, 'member', 'service'),
          'attest_fact',
          { factId, note: 'automation' },
        ),
      ).rejects.toThrow(/only a person/);
      expect(await evidenceRows(factId)).toEqual([]);
    });

    it('refuses a superseded or invalidated Fact (409 family) and an unknown Fact (404 family)', async () => {
      const factId = await makeFact();
      await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        store.invalidateFact(client, workspaceId, { id: ownerId }, { factId, reason: 'gone' }),
      );
      await expect(
        dispatchCapability({ pool }, humanCaller(workspaceId, memberId), 'attest_fact', {
          factId,
          note: 'late',
        }),
      ).rejects.toMatchObject({ name: 'FactNotActiveError' });

      await expect(
        dispatchCapability({ pool }, humanCaller(workspaceId, memberId), 'attest_fact', {
          factId: randomUUID(),
          note: 'nothing there',
        }),
      ).rejects.toMatchObject({ name: 'FactNotFoundError' });

      // Neither refusal left an audit row behind (the whole transaction rolled back).
      await withWorkspace(pool, { workspaceId, principalId: ownerId }, async (client) => {
        const audit = await client.query(
          `select 1 from audit_records where workspace_id = $1 and action = 'attest_fact' and resource_id = $2`,
          [workspaceId, factId],
        );
        expect(audit.rows).toHaveLength(0);
      });
    });

    it('the substrate refuses the reserved kind from the machine-evidence writer and a non-human attester', async () => {
      const factId = await makeFact();
      await withWorkspace(pool, { workspaceId, principalId: ownerId }, async (client) => {
        await expect(
          attachEvidence(client, workspaceId, {
            linkId: factId,
            kind: 'human_attestation',
            content: { note: 'a Worker pretending' },
            createdBy: memberId,
          }),
        ).rejects.toBeInstanceOf(ReservedEvidenceKindError);
        await expect(
          attachHumanAttestation(client, workspaceId, {
            factId,
            attesterPrincipalId: serviceId,
            note: 'a service pretending',
            link: null,
            activityId: randomUUID(),
          }),
        ).rejects.toBeInstanceOf(HumanAttestationRequiresHumanError);
      });
      expect(await evidenceRows(factId)).toEqual([]);
    });
  },
);
