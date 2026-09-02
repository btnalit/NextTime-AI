import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations, splitSqlStatements } from '../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../adapters/db/pool.js';

/**
 * substrate/invariants: integration tests for the S1.1 core-table invariants (design doc §5.4
 * I1/I3/I4/I11/I12, §5.6 visibility) against a real Postgres, plus a static (no-DB) check that
 * every enum-shaped CHECK constraint in the core migrations matches its packages/shared
 * `*_VALUES` source of truth (docs/development-tasks.md S1.1: "test_invariants_db").
 *
 * The DB-backed suite auto-skips when `DATABASE_URL` is unset, matching the pattern already
 * established by packages/kernel/src/adapters/db/{migrate,pool}.test.ts.
 */

const DATABASE_URL = process.env.DATABASE_URL;

const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');
const CORE_MIGRATIONS_DIR = path.join(MIGRATIONS_DIR, 'core');
const SHARED_ENUMS_PATH = path.resolve(KERNEL_ROOT, '..', 'shared', 'src', 'enums.ts');

const CORE_MIGRATION_FILES = [
  '0001_identity.sql',
  '0002_substrate.sql',
  '0003_chat.sql',
  '0004_audit.sql',
  '0005_outbox.sql',
];

// ---------------------------------------------------------------------------------------------
// Static check: SQL CHECK (<col> IN (...)) constraints vs. packages/shared/src/enums.ts
// ---------------------------------------------------------------------------------------------

interface TableCheck {
  table: string;
  column: string;
  values: string[];
}

/**
 * `splitSqlStatements` splits on `;` only — a `--` comment block directly preceding a statement
 * (no blank statement/semicolon between them, e.g. every table's leading doc-comment in these
 * migrations) stays attached as a prefix of that statement's text. Strip full-line `--` comments
 * from the front before testing for `create table`, or every commented table would be missed.
 */
function stripLeadingLineComments(text: string): string {
  let result = text;
  for (;;) {
    const trimmed = result.replace(/^\s+/, '');
    if (!trimmed.startsWith('--')) return trimmed;
    const newlineIndex = trimmed.indexOf('\n');
    result = newlineIndex === -1 ? '' : trimmed.slice(newlineIndex + 1);
  }
}

/** Extracts every `check (<column> in (<'a', 'b', ...>))` constraint, grouped by table. */
function extractTableChecks(sql: string): TableCheck[] {
  const checks: TableCheck[] = [];
  const checkRe = /check\s*\(\s*(\w+)\s+in\s*\(([^()]*)\)\s*\)/gi;

  for (const statement of splitSqlStatements(sql)) {
    const table = /^create table (?:if not exists )?(\w+)/i.exec(
      stripLeadingLineComments(statement),
    )?.[1];
    if (!table) continue;

    checkRe.lastIndex = 0;
    let match: RegExpExecArray | null = checkRe.exec(statement);
    while (match !== null) {
      const column = match[1];
      const rawValues = match[2];
      if (column && rawValues !== undefined) {
        const values = rawValues
          .split(',')
          .map((v) => v.trim().replace(/^'|'$/g, ''))
          .filter((v) => v.length > 0);
        checks.push({ table, column, values });
      }
      match = checkRe.exec(statement);
    }
  }

  return checks;
}

/** Extracts every `export const XXX_VALUES = [...] as const;` array from packages/shared/src/enums.ts. */
function extractSharedEnumValues(source: string): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  const arrayRe = /export const (\w+_VALUES)\s*=\s*\[([\s\S]*?)\]\s*as const;/g;
  let match: RegExpExecArray | null = arrayRe.exec(source);
  while (match !== null) {
    const name = match[1];
    const body = match[2];
    if (name && body !== undefined) {
      const values = [...body.matchAll(/'([^']*)'/g)]
        .map((m) => m[1])
        .filter((v): v is string => v !== undefined);
      result[name] = values;
    }
    match = arrayRe.exec(source);
  }
  return result;
}

/**
 * Every enum-shaped CHECK the core migrations declare that has a direct packages/shared
 * `*_VALUES` counterpart. `sources.visibility` / `chats.visibility` are deliberately absent —
 * see PR body "假设": no `VISIBILITY_VALUES` export exists in packages/shared/src/enums.ts yet.
 */
const EXPECTED_ENUM_CHECKS: ReadonlyArray<{ table: string; column: string; enumExport: string }> = [
  { table: 'principals', column: 'kind', enumExport: 'PRINCIPAL_KIND_VALUES' },
  { table: 'principals', column: 'role', enumExport: 'ROLE_VALUES' },
  { table: 'sessions', column: 'kind', enumExport: 'SESSION_KIND_VALUES' },
  { table: 'ontology_versions', column: 'status', enumExport: 'PUBLISHABLE_STATUS_VALUES' },
  { table: 'links', column: 'epistemic_status', enumExport: 'EPISTEMIC_STATUS_VALUES' },
  { table: 'conflicts', column: 'conflict_type', enumExport: 'CONFLICT_TYPE_VALUES' },
  { table: 'conflicts', column: 'status', enumExport: 'CONFLICT_STATUS_VALUES' },
  { table: 'decisions', column: 'status', enumExport: 'DECISION_STATUS_VALUES' },
];

/** `table.column` pairs with a CHECK but no packages/shared counterpart — documented, not missed. */
const KNOWN_UNMAPPED_CHECKS = new Set(['sources.visibility', 'chats.visibility']);

describe('core migrations — CHECK enum lists match packages/shared (static, no DB)', () => {
  it('every enum-shaped CHECK constraint matches its packages/shared *_VALUES array exactly', async () => {
    const allChecks: TableCheck[] = [];
    for (const filename of CORE_MIGRATION_FILES) {
      const content = await readFile(path.join(CORE_MIGRATIONS_DIR, filename), 'utf8');
      allChecks.push(...extractTableChecks(content));
    }

    const enumsSource = await readFile(SHARED_ENUMS_PATH, 'utf8');
    const sharedEnums = extractSharedEnumValues(enumsSource);

    for (const expectation of EXPECTED_ENUM_CHECKS) {
      const found = allChecks.find(
        (c) => c.table === expectation.table && c.column === expectation.column,
      );
      expect(
        found,
        `expected a CHECK on ${expectation.table}.${expectation.column} in the core migrations`,
      ).toBeDefined();

      const expectedValues = sharedEnums[expectation.enumExport];
      expect(
        expectedValues,
        `expected packages/shared/src/enums.ts to export ${expectation.enumExport}`,
      ).toBeDefined();

      expect(new Set(found?.values ?? [])).toEqual(new Set(expectedValues ?? []));
    }

    // Fails loudly if a new enum-shaped CHECK is added without updating this test — every check
    // must be either explicitly verified above or explicitly documented as unmapped.
    const expectedKeys = new Set(EXPECTED_ENUM_CHECKS.map((e) => `${e.table}.${e.column}`));
    for (const check of allChecks) {
      const key = `${check.table}.${check.column}`;
      if (!expectedKeys.has(key)) {
        expect(KNOWN_UNMAPPED_CHECKS.has(key), `unexpected/unmapped CHECK: ${key}`).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------------------------
// DB-backed invariant tests (auto-skip without DATABASE_URL)
// ---------------------------------------------------------------------------------------------

describe.runIf(DATABASE_URL !== undefined)(
  'substrate invariants (integration, real Postgres)',
  () => {
    let pool: Pool;

    // Two principals in the same workspace (A-owner / A-member) for §5.6 visibility; one
    // principal in a second workspace, for I1 cross-workspace isolation.
    let workspaceA: string;
    let workspaceB: string;
    let ownerA: string;
    let memberA: string;
    let memberB: string;

    async function adminInsertWorkspace(name: string): Promise<string> {
      const workspaceId = randomUUID();
      await withWorkspace(
        pool,
        { workspaceId, principalId: randomUUID() },
        async (client) => {
          await client.query('insert into workspaces (id, name) values ($1, $2)', [
            workspaceId,
            name,
          ]);
        },
        { skipRoleSwitch: true },
      );
      return workspaceId;
    }

    async function adminInsertPrincipal(
      workspaceId: string,
      opts: { kind: string; role: string; displayName: string },
    ): Promise<string> {
      const principalId = randomUUID();
      await withWorkspace(
        pool,
        { workspaceId, principalId },
        async (client) => {
          await client.query(
            'insert into principals (workspace_id, id, kind, role, display_name) values ($1, $2, $3, $4, $5)',
            [workspaceId, principalId, opts.kind, opts.role, opts.displayName],
          );
        },
        { skipRoleSwitch: true },
      );
      return principalId;
    }

    async function insertObject(workspaceId: string, principalId: string): Promise<string> {
      return withWorkspace(pool, { workspaceId, principalId }, async (client) => {
        const id = randomUUID();
        await client.query(
          "insert into objects (workspace_id, id, object_type) values ($1, $2, 'test.thing')",
          [workspaceId, id],
        );
        return id;
      });
    }

    async function insertActivity(workspaceId: string, principalId: string): Promise<string> {
      return withWorkspace(pool, { workspaceId, principalId }, async (client) => {
        const id = randomUUID();
        await client.query(
          "insert into activities (workspace_id, id, kind, status, started_by) values ($1, $2, 'test.run', 'completed', $3)",
          [workspaceId, id, principalId],
        );
        return id;
      });
    }

    beforeAll(async () => {
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);

      workspaceA = await adminInsertWorkspace('invariants-test-workspace-a');
      workspaceB = await adminInsertWorkspace('invariants-test-workspace-b');
      ownerA = await adminInsertPrincipal(workspaceA, {
        kind: 'human',
        role: 'owner',
        displayName: 'owner-a',
      });
      memberA = await adminInsertPrincipal(workspaceA, {
        kind: 'human',
        role: 'member',
        displayName: 'member-a',
      });
      memberB = await adminInsertPrincipal(workspaceB, {
        kind: 'human',
        role: 'member',
        displayName: 'member-b',
      });
    });

    afterAll(async () => {
      await pool.end();
    });

    describe('I1 — workspace isolation', () => {
      it('rows inserted for workspace A are invisible in a session scoped to workspace B', async () => {
        const objectId = await insertObject(workspaceA, ownerA);

        const seenFromB = await withWorkspace(
          pool,
          { workspaceId: workspaceB, principalId: memberB },
          async (client) => {
            const result = await client.query('select id from objects where id = $1', [objectId]);
            return result.rows;
          },
        );

        expect(seenFromB).toHaveLength(0);
      });

      it('rows are invisible with no workspace set at all', async () => {
        const objectId = await insertObject(workspaceA, ownerA);

        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          await client.query('set local role nexttime_app');
          // app.workspace_id / app.principal_id are deliberately never set on this connection.
          const result = await client.query('select id from objects where id = $1', [objectId]);
          expect(result.rows).toHaveLength(0);
        } finally {
          await client.query('ROLLBACK').catch(() => {});
          client.release();
        }
      });

      it('a cross-workspace reference fails at the composite foreign key', async () => {
        const objectInB = await insertObject(workspaceB, memberB);

        await expect(
          withWorkspace(pool, { workspaceId: workspaceA, principalId: ownerA }, async (client) => {
            const sourceId = randomUUID();
            await client.query(
              "insert into objects (workspace_id, id, object_type) values ($1, $2, 'test.thing')",
              [workspaceA, sourceId],
            );
            const activityId = randomUUID();
            await client.query(
              "insert into activities (workspace_id, id, kind, status) values ($1, $2, 'test.run', 'completed')",
              [workspaceA, activityId],
            );
            // target_object_id points at an object that only exists in workspace B — no
            // (workspaceA, objectInB) row exists in `objects`, so the composite FK must reject it.
            await client.query(
              `insert into links
               (workspace_id, id, link_type, source_object_id, target_object_id, epistemic_status, activity_id, asserted_by)
             values ($1, $2, 'test.rel', $3, $4, 'asserted', $5, $6)`,
              [workspaceA, randomUUID(), sourceId, objectInB, activityId, ownerA],
            );
          }),
        ).rejects.toThrow();
      });
    });

    describe('I3 — Fact must have activity_id', () => {
      it('inserting a link without activity_id fails', async () => {
        await expect(
          withWorkspace(pool, { workspaceId: workspaceA, principalId: ownerA }, async (client) => {
            const sourceId = randomUUID();
            const targetId = randomUUID();
            await client.query(
              `insert into objects (workspace_id, id, object_type)
             values ($1, $2, 'test.thing'), ($1, $3, 'test.thing')`,
              [workspaceA, sourceId, targetId],
            );
            await client.query(
              `insert into links
               (workspace_id, id, link_type, source_object_id, target_object_id, epistemic_status, asserted_by)
             values ($1, $2, 'test.rel', $3, $4, 'asserted', $5)`,
              [workspaceA, randomUUID(), sourceId, targetId, ownerA],
            );
          }),
        ).rejects.toThrow();
      });
    });

    describe('I4 — Fact content is append-only', () => {
      async function insertLink(): Promise<{
        linkId: string;
        sourceId: string;
        targetId: string;
        otherTargetId: string;
      }> {
        return withWorkspace(
          pool,
          { workspaceId: workspaceA, principalId: ownerA },
          async (client) => {
            const sourceId = randomUUID();
            const targetId = randomUUID();
            const otherTargetId = randomUUID();
            await client.query(
              `insert into objects (workspace_id, id, object_type)
           values ($1, $2, 'test.thing'), ($1, $3, 'test.thing'), ($1, $4, 'test.thing')`,
              [workspaceA, sourceId, targetId, otherTargetId],
            );
            const activityId = randomUUID();
            await client.query(
              "insert into activities (workspace_id, id, kind, status) values ($1, $2, 'test.run', 'completed')",
              [workspaceA, activityId],
            );
            const linkId = randomUUID();
            await client.query(
              `insert into links
             (workspace_id, id, link_type, source_object_id, target_object_id, epistemic_status, activity_id, asserted_by)
           values ($1, $2, 'test.rel', $3, $4, 'asserted', $5, $6)`,
              [workspaceA, linkId, sourceId, targetId, activityId, ownerA],
            );
            return { linkId, sourceId, targetId, otherTargetId };
          },
        );
      }

      it('UPDATE of target_object_id fails, but UPDATE of superseded_at succeeds', async () => {
        const { linkId, otherTargetId } = await insertLink();

        await expect(
          withWorkspace(pool, { workspaceId: workspaceA, principalId: ownerA }, async (client) => {
            await client.query(
              'update links set target_object_id = $1 where workspace_id = $2 and id = $3',
              [otherTargetId, workspaceA, linkId],
            );
          }),
        ).rejects.toThrow();

        await withWorkspace(
          pool,
          { workspaceId: workspaceA, principalId: ownerA },
          async (client) => {
            const result = await client.query(
              'update links set superseded_at = now() where workspace_id = $1 and id = $2',
              [workspaceA, linkId],
            );
            expect(result.rowCount).toBe(1);
          },
        );
      });

      it('DELETE fails — links are append-only', async () => {
        const { linkId } = await insertLink();

        await expect(
          withWorkspace(pool, { workspaceId: workspaceA, principalId: ownerA }, async (client) => {
            await client.query('delete from links where workspace_id = $1 and id = $2', [
              workspaceA,
              linkId,
            ]);
          }),
        ).rejects.toThrow();
      });
    });

    describe('§5.3 item 6 — a verified Fact must have verified_by (CHECK)', () => {
      it('inserting a link with epistemic_status = verified and no verified_by fails', async () => {
        await expect(
          withWorkspace(pool, { workspaceId: workspaceA, principalId: ownerA }, async (client) => {
            const sourceId = randomUUID();
            const targetId = randomUUID();
            await client.query(
              `insert into objects (workspace_id, id, object_type)
             values ($1, $2, 'test.thing'), ($1, $3, 'test.thing')`,
              [workspaceA, sourceId, targetId],
            );
            const activityId = randomUUID();
            await client.query(
              "insert into activities (workspace_id, id, kind, status) values ($1, $2, 'test.run', 'completed')",
              [workspaceA, activityId],
            );
            await client.query(
              `insert into links
               (workspace_id, id, link_type, source_object_id, target_object_id, epistemic_status, activity_id, asserted_by)
             values ($1, $2, 'test.rel', $3, $4, 'verified', $5, $6)`,
              [workspaceA, randomUUID(), sourceId, targetId, activityId, ownerA],
            );
          }),
        ).rejects.toThrow();
      });
    });

    describe('I12 — a published OntologyVersion is immutable', () => {
      it('UPDATE of definition fails once status = published', async () => {
        const versionId = await withWorkspace(
          pool,
          { workspaceId: workspaceA, principalId: ownerA },
          async (client) => {
            const id = randomUUID();
            await client.query(
              `insert into ontology_versions (workspace_id, id, version, status, definition, proposed_by, published_by)
             values ($1, $2, 1, 'published', $3, $4, $4)`,
              [workspaceA, id, JSON.stringify({ objectTypes: [] }), ownerA],
            );
            return id;
          },
        );

        await expect(
          withWorkspace(pool, { workspaceId: workspaceA, principalId: ownerA }, async (client) => {
            await client.query(
              'update ontology_versions set definition = $1 where workspace_id = $2 and id = $3 and version = 1',
              [JSON.stringify({ objectTypes: ['tampered'] }), workspaceA, versionId],
            );
          }),
        ).rejects.toThrow();
      });
    });

    describe('audit_records — append-only (I11)', () => {
      async function insertAuditRecord(): Promise<string> {
        return withWorkspace(
          pool,
          { workspaceId: workspaceA, principalId: ownerA },
          async (client) => {
            const id = randomUUID();
            await client.query(
              "insert into audit_records (workspace_id, id, actor_principal_id, action) values ($1, $2, $3, 'test.action')",
              [workspaceA, id, ownerA],
            );
            return id;
          },
        );
      }

      it('UPDATE and DELETE both fail as nexttime_app', async () => {
        const recordId = await insertAuditRecord();

        await expect(
          withWorkspace(pool, { workspaceId: workspaceA, principalId: ownerA }, async (client) => {
            await client.query(
              'update audit_records set action = $1 where workspace_id = $2 and id = $3',
              ['tampered', workspaceA, recordId],
            );
          }),
        ).rejects.toThrow();

        await expect(
          withWorkspace(pool, { workspaceId: workspaceA, principalId: ownerA }, async (client) => {
            await client.query('delete from audit_records where workspace_id = $1 and id = $2', [
              workspaceA,
              recordId,
            ]);
          }),
        ).rejects.toThrow();
      });

      it('UPDATE and DELETE both fail via the trigger even on the superuser/table-owner path', async () => {
        const recordId = await insertAuditRecord();

        await expect(
          withWorkspace(
            pool,
            { workspaceId: workspaceA, principalId: ownerA },
            async (client) => {
              await client.query(
                'update audit_records set action = $1 where workspace_id = $2 and id = $3',
                ['tampered', workspaceA, recordId],
              );
            },
            { skipRoleSwitch: true },
          ),
        ).rejects.toThrow();

        await expect(
          withWorkspace(
            pool,
            { workspaceId: workspaceA, principalId: ownerA },
            async (client) => {
              await client.query('delete from audit_records where workspace_id = $1 and id = $2', [
                workspaceA,
                recordId,
              ]);
            },
            { skipRoleSwitch: true },
          ),
        ).rejects.toThrow();
      });
    });

    describe('§5.6 visibility — chats and sources', () => {
      it('a second principal in the same workspace cannot see private chats/sources, but can see workspace-visible ones', async () => {
        const fixtures = await withWorkspace(
          pool,
          { workspaceId: workspaceA, principalId: ownerA },
          async (client) => {
            const privateChatId = randomUUID();
            await client.query(
              "insert into chats (workspace_id, id, owner_principal_id, visibility) values ($1, $2, $3, 'private')",
              [workspaceA, privateChatId, ownerA],
            );
            const workspaceChatId = randomUUID();
            await client.query(
              "insert into chats (workspace_id, id, owner_principal_id, visibility) values ($1, $2, $3, 'workspace')",
              [workspaceA, workspaceChatId, ownerA],
            );
            const privateSourceId = randomUUID();
            await client.query(
              "insert into sources (workspace_id, id, kind, owner_principal_id, visibility) values ($1, $2, 'test', $3, 'private')",
              [workspaceA, privateSourceId, ownerA],
            );
            const workspaceSourceId = randomUUID();
            await client.query(
              "insert into sources (workspace_id, id, kind, owner_principal_id, visibility) values ($1, $2, 'test', $3, 'workspace')",
              [workspaceA, workspaceSourceId, ownerA],
            );
            return { privateChatId, workspaceChatId, privateSourceId, workspaceSourceId };
          },
        );

        const seenByMemberA = await withWorkspace(
          pool,
          { workspaceId: workspaceA, principalId: memberA },
          async (client) => {
            const chats = await client.query('select id from chats');
            const sources = await client.query('select id from sources');
            return {
              chatIds: chats.rows.map((r) => r.id as string),
              sourceIds: sources.rows.map((r) => r.id as string),
            };
          },
        );

        expect(seenByMemberA.chatIds).not.toContain(fixtures.privateChatId);
        expect(seenByMemberA.chatIds).toContain(fixtures.workspaceChatId);
        expect(seenByMemberA.sourceIds).not.toContain(fixtures.privateSourceId);
        expect(seenByMemberA.sourceIds).toContain(fixtures.workspaceSourceId);

        // The owner always sees their own rows regardless of visibility.
        const seenByOwnerA = await withWorkspace(
          pool,
          { workspaceId: workspaceA, principalId: ownerA },
          async (client) => {
            const chats = await client.query('select id from chats');
            return chats.rows.map((r) => r.id as string);
          },
        );
        expect(seenByOwnerA).toContain(fixtures.privateChatId);
        expect(seenByOwnerA).toContain(fixtures.workspaceChatId);
      });

      it('observations and decisions derive visibility from their source', async () => {
        const activityId = await insertActivity(workspaceA, ownerA);

        const fixtures = await withWorkspace(
          pool,
          { workspaceId: workspaceA, principalId: ownerA },
          async (client) => {
            const privateSourceId = randomUUID();
            await client.query(
              "insert into sources (workspace_id, id, kind, owner_principal_id, visibility) values ($1, $2, 'test', $3, 'private')",
              [workspaceA, privateSourceId, ownerA],
            );
            const privateObservationId = randomUUID();
            await client.query(
              'insert into observations (workspace_id, id, source_id, activity_id) values ($1, $2, $3, $4)',
              [workspaceA, privateObservationId, privateSourceId, activityId],
            );
            const privateDecisionId = randomUUID();
            await client.query(
              'insert into decisions (workspace_id, id, activity_id, source_id) values ($1, $2, $3, $4)',
              [workspaceA, privateDecisionId, activityId, privateSourceId],
            );
            return { privateObservationId, privateDecisionId };
          },
        );

        const seenByMemberA = await withWorkspace(
          pool,
          { workspaceId: workspaceA, principalId: memberA },
          async (client) => {
            const observations = await client.query('select id from observations');
            const decisions = await client.query('select id from decisions');
            return {
              observationIds: observations.rows.map((r) => r.id as string),
              decisionIds: decisions.rows.map((r) => r.id as string),
            };
          },
        );

        expect(seenByMemberA.observationIds).not.toContain(fixtures.privateObservationId);
        expect(seenByMemberA.decisionIds).not.toContain(fixtures.privateDecisionId);
      });
    });
  },
);
