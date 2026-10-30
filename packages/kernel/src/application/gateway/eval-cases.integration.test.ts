import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type EvalCaseWire,
  type EvalSuiteSummaryWire,
  type EvalSuiteWire,
  type Operation,
  type PrincipalKind,
  type Role,
  evalCallCountPath,
} from '@nexttime/shared';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { ReviewedVersionChangedError } from '../../governance/capability/index.js';
import {
  deprecateOperation,
  importManifest,
  publishOperation,
  registerGatekeeper,
} from '../../governance/gatekeepers/index.js';
import {
  RedactedTextSubmittedError,
  TextCarriesCredentialsError,
} from '../../governance/redaction/index.js';
import { startActivity } from '../../substrate/epistemic/index.js';
import { readLiveCases } from '../eval/case-reads.js';
import {
  EvalCaseNotFoundError,
  EvalFixtureGateInUseError,
  EvalSuiteInputError,
  EvalSuiteStateError,
} from '../eval/index.js';
import { purgeWorkspace } from '../platform/index.js';
import { ForbiddenError } from './authorize.js';
import { dispatchCapability } from './dispatch.js';
import type { ResolvedCaller } from './resolve-caller.js';

/**
 * application/gateway/eval-cases.integration.test: DB-gated (real Postgres; auto-skip without
 * DATABASE_URL) — S10 E3-1b, an evaluation suite's cases through the capabilities: adding, editing
 * (a new row superseding the old) and retiring one, each a suite version; what a case may hold;
 * who reads and changes them, that no agent or service reaches them (I-E4); how a fixture gate's
 * removal and sync meet the cases that use it; and what the database refuses whoever writes
 * (migrations/worker/0008).
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

function operation(name: string, extra: Partial<Operation> = {}): Operation {
  return {
    name,
    description: `reads ${name}`,
    binding: { kind: 'http', method: 'GET', path: `/${name}` },
    params_schema: { type: 'object', properties: { host: { type: 'string' } } },
    mode: 'observe',
    blast_radius: 'low',
    reversibility: false,
    auto_approvable: true,
    await_decision: false,
    reads: [],
    writes: [],
    ...extra,
  };
}

describe.runIf(DATABASE_URL !== undefined)(
  'evaluation cases (S10 E3-1b, integration, real Postgres)',
  () => {
    let pool: Pool;
    let workspaceId: string;
    const people: Record<'owner' | 'builder' | 'member' | 'auditor', string> = {
      owner: randomUUID(),
      builder: randomUUID(),
      member: randomUUID(),
      auditor: randomUUID(),
    };
    const serviceId = randomUUID();
    const workerDefinitionId = randomUUID();
    let gate: string;
    let otherGate: string;

    function caller(
      principalId: string,
      role: Role,
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
    const person = (role: keyof typeof people) => caller(people[role], role);

    /** The owner's agent, its Handle scoped to the capabilities — the channel still refuses it. */
    function ownerAgent(capabilities: string[]): ResolvedCaller {
      const now = Math.floor(Date.now() / 1000);
      return {
        channel: 'handle',
        claims: {
          ws: workspaceId,
          sid: randomUUID(),
          obo: people.owner,
          scope: { capabilities, resources: {} },
          jti: randomUUID(),
          iat: now,
          exp: now + 600,
        },
      };
    }

    async function asOwnerRole<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
      return withWorkspace(pool, { workspaceId, principalId: people.owner }, fn, {
        skipRoleSwitch: true,
      });
    }
    async function asApp<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
      return withWorkspace(pool, { workspaceId, principalId: people.owner }, fn);
    }

    async function registerGate(name: string): Promise<string> {
      return asApp(async (client) => {
        const activity = await startActivity(client, workspaceId, {
          kind: 'test.connection',
          principalId: people.owner,
        });
        const registered = await registerGatekeeper(client, workspaceId, {
          name,
          transportKind: 'http',
          target: `${name}-system`,
          endpoint: `http://${name}.invalid`,
          activityId: activity.id,
          registeredBy: { id: people.owner, kind: 'human' },
        });
        return registered.gatekeeperId;
      });
    }

    async function publishOn(gatekeeperId: string, operations: Operation[]): Promise<void> {
      await asApp(async (client) => {
        const activity = await startActivity(client, workspaceId, {
          kind: 'test.connection',
          principalId: people.owner,
        });
        await importManifest(client, workspaceId, {
          gatekeeperId,
          operations,
          proposedBy: { id: people.owner, kind: 'human' },
          activityId: activity.id,
        });
        for (const op of operations) {
          // A person publishes, confirming a declared "not there" answer (S11 B-a).
          await publishOperation(client, workspaceId, {
            gatekeeperId,
            name: op.name,
            actor: { principalId: people.owner, role: 'owner' },
            absentAnswersReviewed: true,
          });
        }
      });
    }

    async function call<T>(who: ResolvedCaller, capability: string, params: unknown): Promise<T> {
      return (await dispatchCapability({ pool }, who, capability, params)) as T;
    }

    /** A suite with `gate` frozen as its fixture gate, at version 2. */
    async function suiteWithGate(name: string, gatekeeperId = gate): Promise<EvalSuiteWire> {
      const suite = await call<EvalSuiteWire>(person('builder'), 'create_eval_suite', {
        name,
        workerDefinitionId,
        workerDefinitionVersion: 1,
      });
      return call<EvalSuiteWire>(person('builder'), 'add_eval_fixture_gate', {
        suiteId: suite.id,
        suiteVersion: 1,
        gatekeeperId,
      });
    }

    /** A case that restarts `web-1` when it is up, and must not restart anything else. */
    function restartCase(title = 'Restart web-1 when it hangs') {
      return {
        title,
        input: 'Restart the web-1 container if it is not answering.',
        fixtures: [
          {
            gatekeeperId: gate,
            operation: 'hosts.get',
            when: { path: 'host', op: 'eq', value: 'web-1' },
            answer: { kind: 'data', data: { host: 'web-1', state: 'hung' } },
          },
          { gatekeeperId: gate, operation: 'hosts.get', answer: { kind: 'absent' } },
          {
            gatekeeperId: gate,
            operation: 'hosts.restart',
            answer: { kind: 'data', data: { restarted: true } },
          },
        ],
        assertions: [
          {
            expect: { path: evalCallCountPath(gate, 'hosts.restart'), op: 'eq', value: 1 },
            note: 'restarts exactly once',
          },
          { expect: { path: 'result.summary', op: 'contains', value: 'web-1' } },
        ],
      };
    }

    async function addCase(
      suite: EvalSuiteWire,
      extra: Record<string, unknown> = {},
    ): Promise<EvalSuiteWire> {
      return call<EvalSuiteWire>(person('builder'), 'add_eval_case', {
        suiteId: suite.id,
        suiteVersion: suite.version,
        partition: 'regression',
        split: 'dev',
        ...restartCase(),
        ...extra,
      });
    }

    beforeAll(async () => {
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);
      workspaceId = randomUUID();
      await withWorkspace(
        pool,
        { workspaceId, principalId: people.owner },
        async (client) => {
          await client.query('insert into workspaces (id, name) values ($1, $2)', [
            workspaceId,
            'e3-1b-eval-cases',
          ]);
          for (const [role, id] of Object.entries(people)) {
            await client.query(
              "insert into principals (workspace_id, id, kind, role, display_name) values ($1, $2, 'human', $3, $3)",
              [workspaceId, id, role],
            );
          }
          await client.query(
            "insert into principals (workspace_id, id, kind, role, display_name) values ($1, $2, 'service', 'builder', 'collector')",
            [workspaceId, serviceId],
          );
          await client.query(
            `insert into worker_definitions
               (workspace_id, id, version, kind, status, definition, proposed_by, published_by, published_at)
             values ($1, $2, 1, 'worker', 'published', '{}'::jsonb, $3, $3, now())`,
            [workspaceId, workerDefinitionId, people.builder],
          );
        },
        { skipRoleSwitch: true },
      );
      gate = await registerGate('hosts');
      await publishOn(gate, [
        operation('hosts.list'),
        operation('hosts.get', {
          binding: { kind: 'http', method: 'GET', path: '/hosts/{host}', absent_statuses: [404] },
        }),
        operation('hosts.restart', {
          mode: 'execute',
          blast_radius: 'medium',
          auto_approvable: false,
          binding: { kind: 'http', method: 'POST', path: '/hosts/{host}/restart' },
        }),
      ]);
      otherGate = await registerGate('tickets');
      await publishOn(otherGate, [operation('tickets.list')]);
    });

    afterAll(async () => {
      await pool.end();
    });

    it('a builder adds a case: a new suite version holding it, its change in the history', async () => {
      const suite = await suiteWithGate('Adding');
      // What the editor offers: "not there" only for an Operation that declares it.
      expect(suite.fixtureGates[0]?.operations.map((op) => [op.name, op.answersAbsent])).toEqual([
        ['hosts.get', true],
        ['hosts.list', false],
        ['hosts.restart', false],
      ]);
      const added = await addCase(suite);
      expect(added.version).toBe(3);
      expect(added.caseCount).toBe(1);
      expect(added.casesNeedingAttention).toBe(0);
      expect(added.cases).toEqual([
        {
          id: expect.any(String),
          title: 'Restart web-1 when it hangs',
          partition: 'regression',
          split: 'dev',
          mechanism: null,
          origin: 'human',
          addedInVersion: 3,
          addedBy: people.builder,
          addedAt: expect.any(String),
          supersedes: null,
          fixtureRuleCount: 3,
          assertionCount: 2,
          fixtureOperations: [
            { gatekeeperId: gate, operation: 'hosts.get' },
            { gatekeeperId: gate, operation: 'hosts.restart' },
          ],
          fixtureProblems: [],
        },
      ]);
      const caseId = added.cases[0]?.id as string;
      // The brief read (#493 P3: no input, rule data or assertions) keeps what each rule answers,
      // in order — what `fixtureProblems` is worked out from.
      const brief = await asApp((client) => readLiveCases(client, workspaceId, added.id));
      expect(brief.map((row) => row.fixture_refs)).toEqual([
        [
          { gatekeeperId: gate, operation: 'hosts.get', answer: { kind: 'data' } },
          { gatekeeperId: gate, operation: 'hosts.get', answer: { kind: 'absent' } },
          { gatekeeperId: gate, operation: 'hosts.restart', answer: { kind: 'data' } },
        ],
      ]);
      expect(Object.keys(brief[0] ?? {})).not.toContain('input');
      expect(Object.keys(brief[0] ?? {})).not.toContain('assertions');
      expect(Object.keys(brief[0] ?? {})).not.toContain('fixtures');
      expect(added.history[0]).toEqual({
        version: 3,
        kind: 'case_added',
        actorId: people.builder,
        reason: null,
        createdAt: expect.any(String),
        caseId,
        title: 'Restart web-1 when it hangs',
        partition: 'regression',
        split: 'dev',
      });

      const whole = await call<EvalCaseWire>(person('member'), 'get_eval_case', {
        suiteId: suite.id,
        caseId,
      });
      expect(whole).toMatchObject({
        id: caseId,
        suiteId: suite.id,
        input: 'Restart the web-1 container if it is not answering.',
        fixtures: restartCase().fixtures,
        assertions: restartCase().assertions,
        retiredInVersion: null,
        retireReason: null,
        supersededBy: null,
      });
      expect(whole.contentDigest).toMatch(/^sha256:[0-9a-f]{64}$/);

      const listed = (
        await call<{ items: EvalSuiteSummaryWire[] }>(person('auditor'), 'list_eval_suites', {})
      ).items.find((s) => s.id === suite.id);
      expect(listed).toMatchObject({ caseCount: 1, casesNeedingAttention: 0 });
    });

    it('a mechanism case names its mechanism, and only a mechanism case does', async () => {
      const suite = await suiteWithGate('Mechanisms');
      await expect(addCase(suite, { partition: 'mechanism' })).rejects.toBeInstanceOf(
        EvalSuiteInputError,
      );
      await expect(addCase(suite, { mechanism: 'retries forever' })).rejects.toBeInstanceOf(
        EvalSuiteInputError,
      );
      const added = await addCase(suite, {
        partition: 'mechanism',
        split: 'holdout',
        mechanism: 'restarts the wrong host',
      });
      expect(added.version).toBe(3);
      expect(added.cases[0]).toMatchObject({
        partition: 'mechanism',
        split: 'holdout',
        mechanism: 'restarts the wrong host',
      });
    });

    it('refuses content the suite cannot answer or a reader cannot read, writing nothing', async () => {
      const suite = await suiteWithGate('Refusals');
      const [byWhen, absent, restart] = restartCase().fixtures as unknown as [
        Record<string, unknown>,
        Record<string, unknown>,
        Record<string, unknown>,
      ];
      const problems: Array<[string, Record<string, unknown>, RegExp]> = [
        [
          'a gate the suite does not have',
          { fixtures: [{ ...restart, gatekeeperId: otherGate }] },
          /fixtures\[0\]\.gatekeeperId: .* is not a fixture gate of the suite/,
        ],
        [
          'an Operation the gate does not publish',
          { fixtures: [{ ...restart, operation: 'hosts.reboot' }] },
          /has no Operation "hosts\.reboot"/,
        ],
        [
          'absent where the Operation declares no such answer',
          { fixtures: [{ ...absent, operation: 'hosts.list' }] },
          /fixtures\[0\]\.answer: "hosts\.list" does not declare answers that mean "not there"/,
        ],
        [
          'absent on an execute Operation',
          { fixtures: [{ ...absent, operation: 'hosts.restart' }] },
          /"hosts\.restart" does not declare/,
        ],
        [
          'a when path that does not compile',
          { fixtures: [{ ...byWhen, when: { path: 'host[', op: 'exists' } }] },
          /fixtures\[0\]\.when: path "host\[" is not a JMESPath expression/,
        ],
        [
          'an assertion reading neither result nor calls',
          { assertions: [{ expect: { path: 'summary', op: 'exists' } }] },
          /assertions\[0\]\.expect: path "summary" reads "summary" — the document has only result and calls/,
        ],
        [
          'an assertion reading the document itself',
          { assertions: [{ expect: { path: 'length(keys(@))', op: 'gt', value: 0 } }] },
          /reads the document itself/,
        ],
        [
          'an invisible character in the input',
          { input: 'Restart web‮-1' },
          /input holds a character a reader cannot see/,
        ],
        [
          'an invisible character in a fixture answer',
          {
            fixtures: [{ ...restart, answer: { kind: 'data', data: { 'a​b': 1 } } }],
          },
          /fixtures\[0\]\.answer\.data\.a.*\(its name\) holds a character/,
        ],
      ];
      for (const [what, extra, message] of problems) {
        await expect(addCase(suite, extra), what).rejects.toThrow(message);
        await expect(addCase(suite, extra), what).rejects.toBeInstanceOf(EvalSuiteInputError);
      }
      await expect(
        addCase(suite, { title: 'Two\nlines' }),
        'a title on two lines',
      ).rejects.toBeInstanceOf(EvalSuiteInputError);
      await expect(
        addCase(suite, {
          fixtures: [
            {
              ...restart,
              answer: {
                kind: 'data',
                data: { auth: 'Bearer abcdefghijklmnopqrstuvwxyz0123456789' },
              },
            },
          ],
        }),
      ).rejects.toBeInstanceOf(TextCarriesCredentialsError);
      await expect(
        addCase(suite, { input: 'Log in with [redacted] and restart' }),
      ).rejects.toBeInstanceOf(RedactedTextSubmittedError);

      const after = await call<EvalSuiteWire>(person('builder'), 'get_eval_suite', {
        suiteId: suite.id,
      });
      expect(after.version).toBe(2);
      expect(after.cases).toEqual([]);
    });

    it('an assertion may require an absence, and a when may read any param', async () => {
      const suite = await suiteWithGate('Absences');
      const added = await addCase(suite, {
        fixtures: [
          {
            gatekeeperId: gate,
            operation: 'hosts.get',
            when: {
              all: [
                { path: 'host', op: 'eq', value: 'db-1' },
                { path: 'verbose', op: 'exists' },
              ],
            },
            answer: { kind: 'error', message: 'connection refused' },
          },
        ],
        assertions: [
          {
            expect: { path: evalCallCountPath(gate, 'hosts.restart'), op: 'eq', value: 0 },
            note: 'never restarts a database host',
          },
        ],
      });
      expect(added.cases[0]).toMatchObject({ fixtureRuleCount: 1, assertionCount: 1 });
    });

    it('an edit retires the row and adds one superseding it, partition and split kept', async () => {
      const suite = await addCase(await suiteWithGate('Editing'), { split: 'holdout' });
      const original = suite.cases[0]?.id as string;
      await expect(
        call(person('builder'), 'edit_eval_case', {
          suiteId: suite.id,
          suiteVersion: suite.version,
          caseId: original,
          reason: 'no change',
          ...restartCase(),
        }),
      ).rejects.toBeInstanceOf(EvalSuiteStateError);
      const edited = await call<EvalSuiteWire>(person('builder'), 'edit_eval_case', {
        suiteId: suite.id,
        suiteVersion: suite.version,
        caseId: original,
        reason: 'the summary must name the host too',
        ...restartCase('Restart web-1 and say so'),
      });
      expect(edited.version).toBe(suite.version + 1);
      expect(edited.cases).toHaveLength(1);
      const replacement = edited.cases[0];
      expect(replacement).toMatchObject({
        title: 'Restart web-1 and say so',
        partition: 'regression',
        split: 'holdout',
        supersedes: original,
        addedInVersion: edited.version,
      });
      expect(edited.history[0]).toMatchObject({
        version: edited.version,
        kind: 'case_edited',
        reason: 'the summary must name the host too',
        caseId: replacement?.id,
        supersedes: original,
        title: 'Restart web-1 and say so',
        split: 'holdout',
      });

      // The old row reads as it was, retired at the edit's version, pointing at its successor.
      const old = await call<EvalCaseWire>(person('builder'), 'get_eval_case', {
        suiteId: suite.id,
        caseId: original,
      });
      expect(old).toMatchObject({
        title: 'Restart web-1 when it hangs',
        retiredInVersion: edited.version,
        retireReason: 'the summary must name the host too',
        supersededBy: replacement?.id,
        fixtureProblems: [],
      });
      await expect(
        call(person('builder'), 'edit_eval_case', {
          suiteId: suite.id,
          suiteVersion: edited.version,
          caseId: original,
          reason: 'again',
          ...restartCase('Once more'),
        }),
      ).rejects.toBeInstanceOf(EvalSuiteStateError);
    });

    it('a retirement takes a case out with a reason; earlier versions keep it', async () => {
      const suite = await addCase(await suiteWithGate('Retiring'));
      const caseId = suite.cases[0]?.id as string;
      const retired = await call<EvalSuiteWire>(person('owner'), 'retire_eval_case', {
        suiteId: suite.id,
        suiteVersion: suite.version,
        caseId,
        reason: 'the restart tool was dropped',
      });
      expect(retired.version).toBe(suite.version + 1);
      expect(retired.cases).toEqual([]);
      expect(retired.history[0]).toMatchObject({
        kind: 'case_retired',
        actorId: people.owner,
        reason: 'the restart tool was dropped',
        caseId,
      });
      await expect(
        call(person('owner'), 'retire_eval_case', {
          suiteId: suite.id,
          suiteVersion: retired.version,
          caseId,
          reason: 'twice',
        }),
      ).rejects.toBeInstanceOf(EvalSuiteStateError);
      const rows = await asApp((client) =>
        client.query<{ added_in_version: number; retired_in_version: number | null }>(
          'select added_in_version, retired_in_version from eval_cases where workspace_id = $1 and id = $2',
          [workspaceId, caseId],
        ),
      );
      expect(rows.rows).toEqual([
        { added_in_version: suite.version, retired_in_version: retired.version },
      ]);
    });

    it('every change names the suite version the person looked at, and a case of its suite', async () => {
      const suite = await addCase(await suiteWithGate('Versions'));
      const caseId = suite.cases[0]?.id as string;
      await expect(addCase({ ...suite, version: suite.version - 1 })).rejects.toBeInstanceOf(
        ReviewedVersionChangedError,
      );
      await expect(
        call(person('builder'), 'retire_eval_case', {
          suiteId: suite.id,
          suiteVersion: suite.version - 1,
          caseId,
          reason: 'stale',
        }),
      ).rejects.toBeInstanceOf(ReviewedVersionChangedError);
      const other = await suiteWithGate('Versions elsewhere');
      for (const [capability, params] of [
        ['get_eval_case', { suiteId: other.id, caseId }],
        ['get_eval_case', { suiteId: suite.id, caseId: randomUUID() }],
        [
          'retire_eval_case',
          { suiteId: other.id, suiteVersion: other.version, caseId, reason: 'not mine' },
        ],
      ] as const) {
        await expect(call(person('builder'), capability, params)).rejects.toBeInstanceOf(
          EvalCaseNotFoundError,
        );
      }
    });

    it('every person reads a case; only a builder or above changes one; no agent or service reaches it', async () => {
      const suite = await addCase(await suiteWithGate('Readers'));
      const caseId = suite.cases[0]?.id as string;
      for (const role of ['owner', 'builder', 'member', 'auditor'] as const) {
        const read = await call<EvalCaseWire>(person(role), 'get_eval_case', {
          suiteId: suite.id,
          caseId,
        });
        expect(read.id).toBe(caseId);
      }
      for (const role of ['member', 'auditor'] as const) {
        await expect(
          call(person(role), 'add_eval_case', {
            suiteId: suite.id,
            suiteVersion: suite.version,
            partition: 'full',
            split: 'dev',
            ...restartCase(),
          }),
        ).rejects.toBeInstanceOf(ForbiddenError);
        await expect(
          call(person(role), 'retire_eval_case', {
            suiteId: suite.id,
            suiteVersion: suite.version,
            caseId,
            reason: 'mine now',
          }),
        ).rejects.toBeInstanceOf(ForbiddenError);
      }
      const capabilities = ['get_eval_case', 'add_eval_case', 'edit_eval_case', 'retire_eval_case'];
      const agent = ownerAgent(capabilities);
      const service = caller(serviceId, 'builder', 'service');
      for (const who of [agent, service]) {
        await expect(
          call(who, 'get_eval_case', { suiteId: suite.id, caseId }),
        ).rejects.toBeInstanceOf(ForbiddenError);
        await expect(
          call(who, 'retire_eval_case', {
            suiteId: suite.id,
            suiteVersion: suite.version,
            caseId,
            reason: 'agent',
          }),
        ).rejects.toBeInstanceOf(ForbiddenError);
      }
    });

    it('a holdout case is read only through get_eval_case: no table but eval_* holds its content, the audit trail included', async () => {
      // One marker per place a case holds text: its title, mechanism, input, a rule's condition and
      // answer, an assertion's value and note — written, then edited.
      const mark = (place: string) => `HOLDOUT-${place}-${randomUUID().slice(0, 8)}`;
      const marks = {
        title: mark('title'),
        mechanism: mark('mechanism'),
        input: mark('input'),
        when: mark('when'),
        data: mark('data'),
        value: mark('value'),
        note: mark('note'),
        edited: mark('edited'),
      };
      const content = (input: string) => ({
        title: marks.title,
        input: { ask: input },
        fixtures: [
          {
            gatekeeperId: gate,
            operation: 'hosts.get',
            when: { path: 'host', op: 'eq', value: marks.when },
            answer: { kind: 'data', data: { note: marks.data } },
          },
        ],
        assertions: [
          {
            expect: { path: 'result.summary', op: 'contains', value: marks.value },
            note: marks.note,
          },
        ],
      });
      const added = await call<EvalSuiteWire>(person('builder'), 'add_eval_case', {
        suiteId: (await suiteWithGate('Holdout')).id,
        suiteVersion: 2,
        partition: 'mechanism',
        split: 'holdout',
        mechanism: marks.mechanism,
        ...content(marks.input),
      });
      const caseId = added.cases[0]?.id as string;
      const edited = await call<EvalSuiteWire>(person('builder'), 'edit_eval_case', {
        suiteId: added.id,
        suiteVersion: added.version,
        caseId,
        reason: 'ask it another way',
        ...content(marks.edited),
      });

      const holding = await asOwnerRole(async (client) => {
        const tables = await client.query<{ table_name: string }>(
          `select distinct table_name from information_schema.columns
            where table_schema = 'public' and column_name = 'workspace_id'
              and table_name not like 'eval\\_%'`,
        );
        const found: string[] = [];
        for (const { table_name: table } of tables.rows) {
          for (const [place, marker] of Object.entries(marks)) {
            const rows = await client.query<{ n: string }>(
              `select count(*)::text as n from "${table}" t where t.workspace_id = $1 and t::text like $2`,
              [workspaceId, `%${marker}%`],
            );
            if (rows.rows[0]?.n !== '0') found.push(`${table}: ${place}`);
          }
        }
        const audit = await client.query<{ action: string; payload: Record<string, unknown> }>(
          `select action, payload from audit_records
            where workspace_id = $1 and action in ('add_eval_case', 'edit_eval_case')
              and resource_id = $2 order by created_at`,
          [workspaceId, added.id],
        );
        return { tables: tables.rows.length, found, audit: audit.rows };
      });
      expect(holding.tables).toBeGreaterThan(30);
      expect(holding.found).toEqual([]);
      // The audit trail still records each call — who, which suite, its kind and the reason —
      // and names what it does not hold.
      expect(holding.audit.map((row) => row.action)).toEqual(['add_eval_case', 'edit_eval_case']);
      const [addRecord, editRecord] = holding.audit.map(
        (row) => row.payload as { params: Record<string, unknown>; withheldParams: string[] },
      );
      expect(addRecord?.params).toMatchObject({
        suiteId: added.id,
        partition: 'mechanism',
        split: 'holdout',
        mechanism: '[withheld]',
        title: '[withheld]',
        input: '[withheld]',
        fixtures: '[withheld]',
        assertions: '[withheld]',
      });
      expect([...(addRecord?.withheldParams ?? [])].sort()).toEqual([
        'assertions',
        'fixtures',
        'input',
        'mechanism',
        'title',
      ]);
      expect(editRecord?.params).toMatchObject({
        caseId,
        reason: 'ask it another way',
        input: '[withheld]',
      });
      expect([...(editRecord?.withheldParams ?? [])].sort()).toEqual([
        'assertions',
        'fixtures',
        'input',
        'title',
      ]);
      // A person reads it whole; the agent's search finds nothing of it.
      const read = await call<EvalCaseWire>(person('auditor'), 'get_eval_case', {
        suiteId: added.id,
        caseId: edited.cases[0]?.id as string,
      });
      expect(read.input).toEqual({ ask: marks.edited });
      for (const marker of [marks.title, marks.edited, marks.data]) {
        const searched = await call<{ items: unknown[] }>(ownerAgent(['search']), 'search', {
          query: marker,
        });
        expect(searched.items).toEqual([]);
      }
    });

    it('a fixture gate a case uses is not removed; a sync that drops an Operation flags the case', async () => {
      const used = await registerGate('hosts-sync');
      await publishOn(used, [
        operation('hosts.list'),
        operation('hosts.get', {
          binding: { kind: 'http', method: 'GET', path: '/hosts/{host}', absent_statuses: [404] },
        }),
      ]);
      const suite = await suiteWithGate('Gate changes', used);
      const added = await call<EvalSuiteWire>(person('builder'), 'add_eval_case', {
        suiteId: suite.id,
        suiteVersion: suite.version,
        partition: 'full',
        split: 'dev',
        title: 'Finds a missing host',
        input: 'Is web-9 there?',
        fixtures: [{ gatekeeperId: used, operation: 'hosts.get', answer: { kind: 'absent' } }],
        assertions: [{ expect: { path: 'result.summary', op: 'contains', value: 'not' } }],
      });
      const inUse = await call(person('builder'), 'remove_eval_fixture_gate', {
        suiteId: suite.id,
        suiteVersion: added.version,
        gatekeeperId: used,
        reason: 'not needed',
      }).then(
        () => undefined,
        (err: unknown) => err,
      );
      expect(inUse).toBeInstanceOf(EvalFixtureGateInUseError);
      expect((inUse as EvalFixtureGateInUseError).code).toBe('fixture_gate_in_use');
      expect((inUse as EvalFixtureGateInUseError).message).toMatch(
        /answers calls in 1 case\(s\) the suite holds \("Finds a missing host"\)/,
      );
      expect((inUse as EvalFixtureGateInUseError).details).toEqual({
        caseCount: 1,
        cases: [{ id: added.cases[0]?.id, title: 'Finds a missing host' }],
      });
      expect(added.cases[0]?.fixtureOperations).toEqual([
        { gatekeeperId: used, operation: 'hosts.get' },
      ]);

      // The gate stops publishing hosts.get; the sync freezes the gate without it.
      await asApp((client) =>
        deprecateOperation(client, workspaceId, { gatekeeperId: used, name: 'hosts.get' }),
      );
      const synced = await call<EvalSuiteWire>(person('builder'), 'sync_eval_fixture_gate', {
        suiteId: suite.id,
        suiteVersion: added.version,
        gatekeeperId: used,
      });
      expect(synced.cases[0]?.fixtureProblems).toEqual([
        { index: 0, problem: 'operation_not_on_gate' },
      ]);
      expect(synced.casesNeedingAttention).toBe(1);
      const listed = (
        await call<{ items: EvalSuiteSummaryWire[] }>(person('member'), 'list_eval_suites', {})
      ).items.find((s) => s.id === suite.id);
      expect(listed).toMatchObject({ caseCount: 1, casesNeedingAttention: 1 });

      // Retired, the case no longer holds the gate in the suite.
      const retired = await call<EvalSuiteWire>(person('builder'), 'retire_eval_case', {
        suiteId: suite.id,
        suiteVersion: synced.version,
        caseId: synced.cases[0]?.id,
        reason: 'the inventory no longer answers single hosts',
      });
      const removed = await call<EvalSuiteWire>(person('builder'), 'remove_eval_fixture_gate', {
        suiteId: suite.id,
        suiteVersion: retired.version,
        gatekeeperId: used,
        reason: 'not needed',
      });
      expect(removed.fixtureGates).toEqual([]);
    });

    describe('what the database refuses (worker/0008)', () => {
      let suite: EvalSuiteWire;
      let caseId: string;

      beforeAll(async () => {
        suite = await addCase(await suiteWithGate('Case guards'));
        caseId = suite.cases[0]?.id as string;
      });

      async function refused(sql: string, params: unknown[], message: RegExp): Promise<void> {
        await expect(asApp((client) => client.query(sql, params))).rejects.toThrow(message);
      }

      const insertCase = (
        version: number,
        extra: { split?: string; supersedes?: string | null; mechanism?: string | null } = {},
      ) => ({
        sql: `insert into eval_cases
                (workspace_id, suite_id, title, partition, split, mechanism, input, fixtures,
                 assertions, content_digest, added_in_version, supersedes, created_by)
              values ($1, $2, 'bare', 'regression', $3, $4, '"x"', '[]',
                      '[{"expect":{"path":"result","op":"exists"}}]', 'sha256:${'0'.repeat(64)}', $5, $6, $7)`,
        params: [
          workspaceId,
          suite.id,
          extra.split ?? 'dev',
          extra.mechanism ?? null,
          version,
          extra.supersedes ?? null,
          people.builder,
        ],
      });

      it('a case row never changes but for its retirement, and is never deleted', async () => {
        await refused(
          "update eval_cases set title = 'rewritten' where workspace_id = $1 and id = $2",
          [workspaceId, caseId],
          /a case row never changes/,
        );
        await refused(
          "update eval_cases set retired_in_version = 9, retire_reason = 'x' where workspace_id = $1 and id = $2",
          [workspaceId, caseId],
          /retired at its suite's current version/,
        );
        await refused(
          'update eval_cases set retired_in_version = $3 where workspace_id = $1 and id = $2',
          [workspaceId, caseId, suite.version],
          /eval_cases_retirement|already recorded/,
        );
        await refused(
          'delete from eval_cases where workspace_id = $1 and id = $2',
          [workspaceId, caseId],
          /permission denied/,
        );
      });

      it('a case joins or leaves only in a suite version not recorded yet', async () => {
        const bare = insertCase(suite.version);
        await refused(bare.sql, bare.params, /suite version \d+ is already recorded/);
        await refused(
          "update eval_cases set retired_in_version = $3, retire_reason = 'x' where workspace_id = $1 and id = $2",
          [workspaceId, caseId, suite.version],
          /suite version \d+ is already recorded/,
        );
        await refused(
          insertCase(suite.version + 1).sql,
          insertCase(suite.version + 1).params,
          /added at its suite's current version/,
        );
        const read = await call<EvalSuiteWire>(person('builder'), 'get_eval_suite', {
          suiteId: suite.id,
        });
        expect(read.version).toBe(suite.version);
        expect(read.cases.map((c) => c.id)).toEqual([caseId]);
      });

      it('an edit keeps the split and replaces one retired row once; a mechanism goes with its partition', async () => {
        // In one transaction, as the kernel does it: step the version, retire, add, record.
        const attempt = (extra: { split?: string; supersedes?: string | null }) =>
          asApp(async (client) => {
            const stepped = await client.query<{ version: number }>(
              'update eval_suites set version = version + 1 where workspace_id = $1 and id = $2 returning version',
              [workspaceId, suite.id],
            );
            const version = stepped.rows[0]?.version as number;
            await client.query(
              "update eval_cases set retired_in_version = $3, retire_reason = 'edit' where workspace_id = $1 and id = $2",
              [workspaceId, caseId, version],
            );
            const row = insertCase(version, extra);
            await client.query(row.sql, row.params);
          });
        await expect(attempt({ split: 'holdout', supersedes: caseId })).rejects.toThrow(
          /an edit keeps the case's partition, split, mechanism and origin/,
        );
        const elsewhere = await addCase(await suiteWithGate('Case guards elsewhere'));
        await expect(attempt({ supersedes: elsewhere.cases[0]?.id as string })).rejects.toThrow(
          /replaces a case of the same suite retired at the same suite version/,
        );
        const mechanismless = asApp(async (client) => {
          const stepped = await client.query<{ version: number }>(
            'update eval_suites set version = version + 1 where workspace_id = $1 and id = $2 returning version',
            [workspaceId, suite.id],
          );
          const row = insertCase(stepped.rows[0]?.version as number, { mechanism: 'loops' });
          await client.query(row.sql, row.params);
        });
        await expect(mechanismless).rejects.toThrow(/eval_cases_mechanism/);
        await refused(
          `insert into eval_suite_changes (workspace_id, suite_id, version, kind, actor_id)
           select $1, $2, version + 1, 'case_retired', $3 from eval_suites where workspace_id = $1 and id = $2`,
          [workspaceId, suite.id, people.builder],
          /eval_suite_changes_removal_reason|current version/,
        );
      });
    });

    // Last: it removes this test's workspace. The cascade runs with triggers off and finds
    // `eval_cases` by its `workspace_id` like any other table.
    it('the workspace purge removes cases with their suites', async () => {
      const result = await purgeWorkspace(pool, { workspaceId, confirm: true, force: true });
      expect(result.executed).toBe(true);
      expect(result.counts.evalCases).toBeGreaterThan(0);
      const left = await pool.query<{ count: string }>(
        'select count(*)::text as count from eval_cases where workspace_id = $1',
        [workspaceId],
      );
      expect(left.rows[0]?.count).toBe('0');
    });
  },
);
