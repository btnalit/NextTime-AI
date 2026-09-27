import { HUMAN_ATTESTATION_EVIDENCE_KIND, getCapability } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import { ScopeValidationError, assertValidScope } from '../../governance/capability/index.js';
import {
  HumanAttestationRequiresHumanError,
  ReservedEvidenceKindError,
  attachEvidence,
  attachHumanAttestation,
} from '../../substrate/epistemic/index.js';
import { ForbiddenError, authorizeCapabilityCall } from './authorize.js';
import { attestFactHandler } from './epistemic-handlers.js';
import type { ResolvedCaller } from './resolve-caller.js';

/**
 * application/gateway/attest-fact.test: pure unit tests (no database) for STATUS leftover 89 —
 * every layer that keeps a human attestation a *person's* word: the registry/authorizer (no
 * Handle reaches `attest_fact`), Handle issuance (`assertValidScope` refuses it), the handler (no
 * non-human Principal), and the Evidence substrate (the machine-evidence writer refuses the
 * reserved kind; the attestation writer checks the attester's Principal kind itself). The DB-backed
 * end-to-end flow (Evidence row, Activity, audit row, verify_fact, explain) is
 * `attest-fact.integration.test.ts`.
 */

const WS = '00000000-0000-4000-8000-00000000000a';
const PERSON = '00000000-0000-4000-8000-00000000000b';
const FACT = '00000000-0000-4000-8000-00000000000c';

/** A client that fails the test the moment anything queries it — proves a refusal happened
 *  before any read or write. */
const untouchableClient = {
  query: () => {
    throw new Error('the client must not be touched');
  },
} as unknown as PoolClient;

interface RecordedQuery {
  readonly text: string;
  readonly values: readonly unknown[];
}

/** A scripted client: answers the `principals` kind lookup with `principalKind`, and the evidence
 *  insert with a row echoing the inserted values. */
function scriptedClient(principalKind: string): {
  client: PoolClient;
  queries: RecordedQuery[];
} {
  const queries: RecordedQuery[] = [];
  const client = {
    query: async (text: string, values: unknown[]) => {
      queries.push({ text, values });
      if (text.includes('from principals')) return { rows: [{ kind: principalKind }] };
      if (text.includes('insert into evidence')) {
        return {
          rows: [
            {
              workspace_id: values[0],
              id: '00000000-0000-4000-8000-00000000000d',
              link_id: values[1],
              kind: values[2],
              content: JSON.parse(values[3] as string),
              created_at: new Date('2026-09-27T00:00:00.000Z'),
              created_by: values[4],
            },
          ],
        };
      }
      throw new Error(`unexpected query: ${text}`);
    },
  } as unknown as PoolClient;
  return { client, queries };
}

function humanCaller(kind: 'human' | 'service'): ResolvedCaller {
  return {
    channel: 'human',
    principal: { workspaceId: WS, id: PERSON, kind, role: 'member', displayName: null },
    session: {
      workspaceId: WS,
      id: 's1',
      principalId: PERSON,
      kind: 'web',
      onBehalfOf: PERSON,
      status: 'active',
      createdAt: new Date(),
      expiresAt: null,
    },
  };
}

function handleCaller(capabilities: readonly string[]): ResolvedCaller {
  return {
    channel: 'handle',
    claims: {
      ws: WS,
      sid: 's1',
      obo: PERSON,
      scope: { capabilities: [...capabilities], resources: {} },
      jti: 'jti1',
      iat: 0,
      exp: 999999999999,
    },
  };
}

const attestFact = () => {
  const capability = getCapability('attest_fact');
  if (!capability) throw new Error('attest_fact is not registered');
  return capability;
};

describe('attest_fact authorization (leftover 89)', () => {
  it('refuses a Handle even one whose scope was forged to name attest_fact', () => {
    expect(() => authorizeCapabilityCall(handleCaller(['attest_fact']), attestFact())).toThrow(
      /human-channel-only/,
    );
  });

  it('admits a human member (the same role gate as verify_fact)', () => {
    expect(() => authorizeCapabilityCall(humanCaller('human'), attestFact())).not.toThrow();
  });

  it('can never be issued into a Handle scope', () => {
    expect(() => assertValidScope({ capabilities: ['attest_fact'], resources: {} })).toThrow(
      ScopeValidationError,
    );
  });
});

describe('attestFactHandler refusals (leftover 89)', () => {
  const params = { factId: FACT, note: 'checked it myself' };

  it('refuses a handle-channel context before touching the database', async () => {
    await expect(
      attestFactHandler(untouchableClient, WS, params, { channel: 'handle', principalId: PERSON }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('refuses a service Principal on the human channel (an API key is not a person)', async () => {
    await expect(
      attestFactHandler(untouchableClient, WS, params, {
        channel: 'human',
        principalId: PERSON,
        principal: { id: PERSON, kind: 'service', role: 'member', displayName: 'ci-bot' },
      }),
    ).rejects.toThrow(/only a person/);
  });

  it('refuses a human-channel context with no resolved Principal', async () => {
    await expect(
      attestFactHandler(untouchableClient, WS, params, { channel: 'human', principalId: PERSON }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('Evidence substrate — reserved human_attestation kind (leftover 89)', () => {
  it('attachEvidence (machine evidence) refuses the reserved kind before any write', async () => {
    await expect(
      attachEvidence(untouchableClient, WS, {
        linkId: FACT,
        kind: HUMAN_ATTESTATION_EVIDENCE_KIND,
        content: { note: 'a Worker pretending to be a person' },
        createdBy: PERSON,
      }),
    ).rejects.toBeInstanceOf(ReservedEvidenceKindError);
  });

  it('attachHumanAttestation refuses a non-human attester and writes nothing', async () => {
    for (const kind of ['agent', 'service']) {
      const { client, queries } = scriptedClient(kind);
      await expect(
        attachHumanAttestation(client, WS, {
          factId: FACT,
          attesterPrincipalId: PERSON,
          note: 'n',
          link: null,
          activityId: 'act-1',
        }),
      ).rejects.toBeInstanceOf(HumanAttestationRequiresHumanError);
      expect(queries.some((q) => q.text.includes('insert into evidence'))).toBe(false);
    }
  });

  it('attachHumanAttestation writes the reserved kind, attributed to the person', async () => {
    const { client, queries } = scriptedClient('human');
    const row = await attachHumanAttestation(client, WS, {
      factId: FACT,
      attesterPrincipalId: PERSON,
      note: 'confirmed on the rack',
      link: 'https://ticket.example/42',
      activityId: 'act-1',
    });
    const insert = queries.find((q) => q.text.includes('insert into evidence'));
    expect(insert?.values[2]).toBe(HUMAN_ATTESTATION_EVIDENCE_KIND);
    expect(insert?.values[4]).toBe(PERSON);
    expect(JSON.parse(insert?.values[3] as string)).toEqual({
      note: 'confirmed on the rack',
      link: 'https://ticket.example/42',
      activityId: 'act-1',
    });
    expect(row).toMatchObject({
      factId: FACT,
      note: 'confirmed on the rack',
      link: 'https://ticket.example/42',
      activityId: 'act-1',
      attestedBy: PERSON,
    });
  });

  it('attachHumanAttestation leaves link out of the content when none is given', async () => {
    const { client, queries } = scriptedClient('human');
    const row = await attachHumanAttestation(client, WS, {
      factId: FACT,
      attesterPrincipalId: PERSON,
      note: 'n',
      link: null,
      activityId: 'act-1',
    });
    const insert = queries.find((q) => q.text.includes('insert into evidence'));
    expect(JSON.parse(insert?.values[3] as string)).toEqual({ note: 'n', activityId: 'act-1' });
    expect(row.link).toBeNull();
  });
});
