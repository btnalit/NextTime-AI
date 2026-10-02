import type { PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import { ForbiddenError } from './authorize.js';
import type { CapabilityHandlerContext } from './capability-handler.js';
import { assertFactHandler, supersedeFactHandler } from './fact-handlers.js';
import { submitObservationsHandler } from './ingest-handlers.js';

/**
 * application/gateway/provenance-anchor-guard.test: pure unit tests (no database) for review
 * 2026-10-02 R-02 / D-03 — `submit_observations`, `assert_fact` and `supersede_fact` refuse a
 * Source the caller does not own and a caller-supplied Activity the caller did not start, *before*
 * any write. The DB-backed flows (a collector's Source and Activity vs a member, an agent acting
 * for a person) are in `ingest-handlers.integration.test.ts` and `fact-handlers.integration.test.ts`.
 */

const WS = '00000000-0000-4000-8000-0000000000a1';
const CALLER = '00000000-0000-4000-8000-0000000000a2';
const OTHER = '00000000-0000-4000-8000-0000000000a3';
const SOURCE = '00000000-0000-4000-8000-0000000000a4';
const ACTIVITY = '00000000-0000-4000-8000-0000000000a5';
const OBJECT_A = '00000000-0000-4000-8000-0000000000a6';
const OBJECT_B = '00000000-0000-4000-8000-0000000000a7';
const FACT = '00000000-0000-4000-8000-0000000000a8';

/** Thrown by the scripted client for any query past the two anchor lookups — reaching it proves the
 *  guards admitted the call. */
const PAST_THE_GUARDS = 'past the guards';

interface Script {
  /** `sources` row for SOURCE; `undefined` = no row visible. */
  readonly sourceOwner?: string;
  /** `activities` row for ACTIVITY: a `started_by` value, or `'none'` for no row visible. */
  readonly activityStartedBy?: string | null | 'none';
}

function scriptedClient(script: Script): { client: PoolClient; queries: string[] } {
  const queries: string[] = [];
  const client = {
    query: async (text: string) => {
      queries.push(text);
      if (text.includes('from sources')) {
        return {
          rows:
            script.sourceOwner === undefined
              ? []
              : [{ id: SOURCE, owner_principal_id: script.sourceOwner }],
        };
      }
      if (text.includes('from activities')) {
        return {
          rows:
            script.activityStartedBy === 'none' ? [] : [{ started_by: script.activityStartedBy }],
        };
      }
      // The fact handlers' I16 guard reads both endpoints first; "no such Object" skips it.
      if (text.includes('from objects')) return { rows: [] };
      throw new Error(PAST_THE_GUARDS);
    },
  } as unknown as PoolClient;
  return { client, queries };
}

const handleCtx: CapabilityHandlerContext = { channel: 'handle', principalId: CALLER };

const factParams = {
  sourceObjectId: OBJECT_A,
  targetObjectId: OBJECT_B,
  linkType: 'has_note',
  activityId: ACTIVITY,
};

function noWrites(queries: readonly string[]): boolean {
  return queries.every((text) => !/\b(insert|update|delete)\b/i.test(text));
}

describe('submit_observations: the Source must be the caller’s, a given Activity the caller’s', () => {
  const observations = [{ objectType: 'Host', identity: { hostname: 'h1' } }];

  it('refuses a Source owned by another principal (403) before anything else', async () => {
    const { client, queries } = scriptedClient({ sourceOwner: OTHER });
    await expect(
      submitObservationsHandler(client, WS, { sourceId: SOURCE, observations }, handleCtx),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(queries).toHaveLength(1);
  });

  it('keeps an invisible Source a 404 (SourceNotFoundError), not a 403', async () => {
    const { client } = scriptedClient({});
    await expect(
      submitObservationsHandler(client, WS, { sourceId: SOURCE, observations }, handleCtx),
    ).rejects.toMatchObject({ name: 'SourceNotFoundError' });
  });

  it.each([
    ['another principal', OTHER],
    ['nobody (a system Activity)', null],
    ['no visible row', 'none'],
  ] as const)(
    'refuses an own Source on an Activity started by %s (403), writing nothing',
    async (_label, startedBy) => {
      const { client, queries } = scriptedClient({
        sourceOwner: CALLER,
        activityStartedBy: startedBy,
      });
      await expect(
        submitObservationsHandler(
          client,
          WS,
          { sourceId: SOURCE, activityId: ACTIVITY, observations },
          handleCtx,
        ),
      ).rejects.toBeInstanceOf(ForbiddenError);
      expect(noWrites(queries)).toBe(true);
    },
  );

  it('admits an own Source with an own Activity, and an own Source with no Activity', async () => {
    const withActivity = scriptedClient({ sourceOwner: CALLER, activityStartedBy: CALLER });
    await expect(
      submitObservationsHandler(
        withActivity.client,
        WS,
        { sourceId: SOURCE, activityId: ACTIVITY, observations },
        handleCtx,
      ),
    ).rejects.toThrow(PAST_THE_GUARDS);

    const withoutActivity = scriptedClient({ sourceOwner: CALLER });
    await expect(
      submitObservationsHandler(
        withoutActivity.client,
        WS,
        { sourceId: SOURCE, observations },
        handleCtx,
      ),
    ).rejects.toThrow(PAST_THE_GUARDS);
    expect(withoutActivity.queries.some((text) => text.includes('from activities'))).toBe(false);
  });
});

describe('assert_fact / supersede_fact: a given activityId must be one the caller started', () => {
  it.each([
    ['assert_fact', assertFactHandler, factParams],
    ['supersede_fact', supersedeFactHandler, { ...factParams, factId: FACT }],
  ] as const)(
    '%s refuses another principal’s Activity (403), writing nothing',
    async (name, handler, params) => {
      const { client, queries } = scriptedClient({ activityStartedBy: OTHER });
      await expect(handler(client, WS, params, handleCtx)).rejects.toThrow(
        new RegExp(`^${name}: activityId ${ACTIVITY} is not an Activity the caller started`),
      );
      expect(noWrites(queries)).toBe(true);
    },
  );

  it.each([
    ['assert_fact', assertFactHandler, factParams],
    ['supersede_fact', supersedeFactHandler, { ...factParams, factId: FACT }],
  ] as const)('%s admits the caller’s own Activity', async (_name, handler, params) => {
    const { client } = scriptedClient({ activityStartedBy: CALLER });
    await expect(handler(client, WS, params, handleCtx)).rejects.toThrow(PAST_THE_GUARDS);
  });
});
