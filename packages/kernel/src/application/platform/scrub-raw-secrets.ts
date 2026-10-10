import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { PoolLike } from '../../adapters/db/pool.js';
import { withWorkspace } from '../../adapters/db/pool.js';
import { reasonAuditFields, resultAuditFields } from '../../governance/approval/index.js';
import { findConnectionParamsCredential } from '../../governance/connections/index.js';
import { redactSuspectedSecrets, scrubSecretValues } from '../../governance/redaction/index.js';
import { writeAudit } from '../../substrate/audit/index.js';
import { rescrubStoredToolCallResult } from '../chat/tool-call-record.js';

/**
 * application/platform/scrub-raw-secrets: the rows written before STATUS legacy 183–187 were fixed,
 * which can still hold a credential in plain text. The mechanism behind `cli/scrub-raw-secrets.ts`,
 * which `scripts/apply-release.sh` runs after the release's `BACKUP_NOW` — that dump is the
 * recovery point for every row this rewrites.
 *
 * **Rewritten** — copies people read, scrubbed the way the write path now scrubs them:
 *   - `turnReports`: an agent Turn's `activities.metadata.summary` / `.decisions` (`report_turn`,
 *     legacy 183) — every secret-looking value (`scrubSecretValues`);
 *   - `decisions`: the `summary` of a Decision whose Activity is an agent Turn (`record_decision`,
 *     legacy 183) — likewise;
 *   - `toolCallRecords`: a stored tool-call record's result preview (legacy 185) — the key rule
 *     over JSON text, then the value patterns (application/chat's `rescrubStoredToolCallResult`).
 *
 * **Counted, never rewritten:**
 *   - `taskInputs`: a `tasks.input` carrying a suspected credential (legacy 184). The Worker runs
 *     on its input as given; every other reader now gets it masked;
 *   - `connectionTargets` / `gatekeeperAddresses`: a connection request's `target`, a Gatekeeper's
 *     `target` / `endpoint`, carrying a credential (legacy 186) — it is where the gate is called;
 *     its owner fixes it (cancel the request, re-register the gate);
 *   - `auditResults`: an `action_request.complete` / `.fail` audit row whose `resultMetadata` /
 *     `reason` the audit rule would now hide something in (legacy 187). Audit rows are append-only
 *     (I11) — the dump `BACKUP_NOW` takes is no worse a copy than the table itself.
 * A counted row is listed by id (`examples`, at most `MAX_EXAMPLES` per category) — never a value.
 *
 * **How.** Per table, windows of `batchSize` rows in primary-key order, each one short transaction
 * on the login role (`skipRoleSwitch`, RLS-bypassing like compact-observations: `nexttime_app` has
 * no UPDATE on `decisions` or `chat_messages`, core 0035 / 0008). A rewrite is conditional on the
 * value it read (`… and <column> = <what was read>`), so a row changed in between is left as it is
 * (`skipped`) for the next run. A rewrite changes a value only to the mask, so a second run finds
 * nothing to do.
 *
 * **Audit.** An executing run writes one platform audit row, `cli.raw_secrets_scrubbed`, with the
 * counts — also when it fails part-way, so the windows that did commit are on record
 * (`completed: false` plus the error). Unattributed when no operator resolves (core 0040).
 */

export const RAW_SECRET_SCRUB_BATCH_SIZE = 500;
export const RAW_SECRET_SCRUB_AUDIT_ACTION = 'cli.raw_secrets_scrubbed';
/** Ids listed per counted category. */
export const MAX_EXAMPLES = 20;

export const REWRITTEN_CATEGORIES = ['turnReports', 'decisions', 'toolCallRecords'] as const;
export const COUNTED_CATEGORIES = [
  'taskInputs',
  'connectionTargets',
  'gatekeeperAddresses',
  'auditResults',
] as const;
export type RawSecretCategory =
  | (typeof REWRITTEN_CATEGORIES)[number]
  | (typeof COUNTED_CATEGORIES)[number];

export interface RawSecretCategoryCounts {
  /** Rows read. */
  examined: number;
  /** Rows carrying something to hide — rewritten (`rewritten`), or that would be on `--yes`. */
  affected: number;
  /** Of `affected`, rows a run with `--yes` left as they were because they changed in between. */
  skipped: number;
  /** Values hidden (or that would be) — rewritten categories only. */
  values: number;
  /** Up to `MAX_EXAMPLES` affected rows — counted categories only. */
  examples: { readonly workspaceId: string | null; readonly id: string }[];
}

export interface ScrubRawSecretsInput {
  readonly confirm: boolean;
  readonly batchSize?: number;
  /** The operator, when one resolves; else the audit row is unattributed. */
  readonly actorUserId?: string;
}

export interface ScrubRawSecretsResult {
  readonly executed: boolean;
  readonly batchSize: number;
  readonly batches: number;
  readonly categories: Readonly<Record<RawSecretCategory, RawSecretCategoryCounts>>;
  readonly auditRecordId: string | null;
}

export class RawSecretScrubFailedError extends Error {
  readonly partial: ScrubRawSecretsResult;
  constructor(cause: unknown, partial: ScrubRawSecretsResult) {
    super(
      `scrub-raw-secrets: failed after ${partial.batches} window(s): ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = 'RawSecretScrubFailedError';
    this.partial = partial;
  }
}

const NIL_UUID = '00000000-0000-0000-0000-000000000000';

interface Cursor {
  readonly workspaceId: string;
  readonly id: string;
}

interface ScannedRow {
  readonly workspace_id: string | null;
  readonly id: string;
}

/** What one row needs: nothing (`null`), a count, or a conditional rewrite. */
interface Finding {
  readonly values: number;
  readonly rewrite?: { readonly sql: string; readonly params: readonly unknown[] };
}

interface Scan {
  readonly category: RawSecretCategory;
  /** Rows after `after` in key order, at most `limit`. */
  readonly window: (client: PoolClient, after: Cursor, limit: number) => Promise<ScannedRow[]>;
  readonly inspect: (row: ScannedRow) => Finding | null;
}

/** Keyset over a `(workspace_id, id)` primary key: `filter` narrows the rows (no parameters). */
function workspaceKeyset(table: string, columns: string, filter: string) {
  return async (client: PoolClient, after: Cursor, limit: number): Promise<ScannedRow[]> =>
    (
      await client.query<ScannedRow>(
        `select ${columns} from ${table}
          where (workspace_id, id) > ($1::uuid, $2::uuid) and ${filter}
          order by workspace_id, id limit $3`,
        [after.workspaceId, after.id, limit],
      )
    ).rows;
}

function scrubbedStrings(values: readonly unknown[]): { values: unknown[]; hidden: number } {
  let hidden = 0;
  const out = values.map((value) => {
    if (typeof value !== 'string') return value;
    const scrubbed = scrubSecretValues(value);
    hidden += scrubbed.redactedValues;
    return scrubbed.value;
  });
  return { values: out, hidden };
}

const SCANS: readonly Scan[] = [
  {
    category: 'turnReports',
    window: workspaceKeyset(
      'activities',
      'workspace_id, id, metadata',
      `kind = 'agent_turn' and (metadata ? 'summary' or metadata ? 'decisions')`,
    ),
    inspect: (row) => {
      const metadata = (row as ScannedRow & { metadata: Record<string, unknown> }).metadata;
      const patch: Record<string, unknown> = {};
      let hidden = 0;
      if (typeof metadata.summary === 'string') {
        const scrubbed = scrubSecretValues(metadata.summary);
        if (scrubbed.value !== metadata.summary) patch.summary = scrubbed.value;
        hidden += scrubbed.redactedValues;
      }
      const decisions: unknown = metadata.decisions;
      if (Array.isArray(decisions)) {
        const scrubbed = scrubbedStrings(decisions);
        if (scrubbed.values.some((value, i) => value !== decisions[i])) {
          patch.decisions = scrubbed.values;
        }
        hidden += scrubbed.hidden;
      }
      if (Object.keys(patch).length === 0) return null;
      return {
        values: hidden,
        rewrite: {
          sql: `update activities set metadata = $3::jsonb
                 where workspace_id = $1 and id = $2 and metadata = $4::jsonb`,
          params: [
            row.workspace_id,
            row.id,
            JSON.stringify({ ...metadata, ...patch }),
            JSON.stringify(metadata),
          ],
        },
      };
    },
  },
  {
    category: 'decisions',
    window: async (client, after, limit) =>
      (
        await client.query<ScannedRow>(
          `select d.workspace_id, d.id, d.summary from decisions d
             join activities a on a.workspace_id = d.workspace_id and a.id = d.activity_id
            where (d.workspace_id, d.id) > ($1::uuid, $2::uuid) and a.kind = 'agent_turn'
              and d.summary is not null
            order by d.workspace_id, d.id limit $3`,
          [after.workspaceId, after.id, limit],
        )
      ).rows,
    inspect: (row) => {
      const summary = (row as ScannedRow & { summary: string }).summary;
      const scrubbed = scrubSecretValues(summary);
      if (scrubbed.value === summary) return null;
      return {
        values: scrubbed.redactedValues,
        rewrite: {
          sql: `update decisions set summary = $3
                 where workspace_id = $1 and id = $2 and summary = $4`,
          params: [row.workspace_id, row.id, scrubbed.value, summary],
        },
      };
    },
  },
  {
    category: 'toolCallRecords',
    window: workspaceKeyset(
      'chat_messages',
      'workspace_id, id, content',
      `role = 'tool' and content ->> 'kind' = 'tool_call' and content ? 'result'`,
    ),
    inspect: (row) => {
      const content = (row as ScannedRow & { content: Record<string, unknown> }).content;
      const scrubbed = rescrubStoredToolCallResult(content);
      if (scrubbed.value === content) return null;
      return {
        values: scrubbed.redactedValues,
        rewrite: {
          sql: `update chat_messages set content = $3::jsonb
                 where workspace_id = $1 and id = $2 and content = $4::jsonb`,
          params: [
            row.workspace_id,
            row.id,
            JSON.stringify(scrubbed.value),
            JSON.stringify(content),
          ],
        },
      };
    },
  },
  {
    category: 'taskInputs',
    window: workspaceKeyset('tasks', 'workspace_id, id, input', 'input is not null'),
    inspect: (row) => {
      const input = (row as ScannedRow & { input: unknown }).input;
      const masked = redactSuspectedSecrets(input, { secretFields: true });
      return JSON.stringify(masked.value) === JSON.stringify(input)
        ? null
        : { values: masked.count };
    },
  },
  {
    category: 'connectionTargets',
    window: workspaceKeyset('connection_requests', 'workspace_id, id, target', 'true'),
    inspect: (row) =>
      findConnectionParamsCredential({ target: (row as ScannedRow & { target: string }).target })
        ? { values: 1 }
        : null,
  },
  {
    category: 'gatekeeperAddresses',
    window: workspaceKeyset(
      'objects',
      `workspace_id, id, properties ->> 'target' as target, properties ->> 'endpoint' as endpoint`,
      `object_type = 'Gatekeeper'`,
    ),
    inspect: (row) =>
      findConnectionParamsCredential(
        row as ScannedRow & { target: string | null; endpoint: string | null },
      )
        ? { values: 1 }
        : null,
  },
  {
    category: 'auditResults',
    // `audit_records` is keyed on `id` alone (core 0019: platform rows have no workspace).
    window: async (client, after, limit) =>
      (
        await client.query<ScannedRow>(
          `select r.workspace_id, r.id, r.action, r.payload, ar.params
             from audit_records r
             left join action_requests ar
               on ar.workspace_id = r.workspace_id and ar.id = r.resource_id
            where r.id > $1::uuid
              and r.action in ('action_request.complete', 'action_request.fail')
            order by r.id limit $2`,
          [after.id, limit],
        )
      ).rows,
    inspect: (row) => {
      const { action, payload, params } = row as ScannedRow & {
        action: string;
        payload: Record<string, unknown>;
        params: Record<string, unknown> | null;
      };
      const requestParams = params ?? {};
      if (action === 'action_request.complete') {
        const metadata = payload.resultMetadata;
        if (metadata === null || typeof metadata !== 'object') return null;
        const now = resultAuditFields(metadata as Record<string, unknown>, requestParams);
        return JSON.stringify(now.resultMetadata) === JSON.stringify(metadata)
          ? null
          : { values: 1 };
      }
      if (typeof payload.reason !== 'string') return null;
      return reasonAuditFields(payload.reason, requestParams).reason === payload.reason
        ? null
        : { values: 1 };
    },
  },
];

function emptyCounts(): RawSecretCategoryCounts {
  return { examined: 0, affected: 0, skipped: 0, values: 0, examples: [] };
}

/** One transaction on the login role, RLS-bypassing like the purge and the compaction; the random
 *  workspace id only fills the session variables `withWorkspace` requires. */
function onLoginRole<T>(pool: PoolLike, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return withWorkspace(pool, { workspaceId: randomUUID(), principalId: randomUUID() }, fn, {
    skipRoleSwitch: true,
  });
}

export async function scrubRawSecrets(
  pool: PoolLike,
  input: ScrubRawSecretsInput,
): Promise<ScrubRawSecretsResult> {
  const batchSize = input.batchSize ?? RAW_SECRET_SCRUB_BATCH_SIZE;
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new Error(`scrub-raw-secrets: batchSize must be a positive integer, got ${batchSize}`);
  }
  const categories = Object.fromEntries(
    [...REWRITTEN_CATEGORIES, ...COUNTED_CATEGORIES].map((name) => [name, emptyCounts()]),
  ) as Record<RawSecretCategory, RawSecretCategoryCounts>;
  const rewrites = new Set<RawSecretCategory>(REWRITTEN_CATEGORIES);
  let batches = 0;
  const result = (auditRecordId: string | null): ScrubRawSecretsResult => ({
    executed: input.confirm,
    batchSize,
    batches,
    categories,
    auditRecordId,
  });

  let failure: unknown;
  try {
    for (const scan of SCANS) {
      const counts = categories[scan.category];
      let cursor: Cursor = { workspaceId: NIL_UUID, id: NIL_UUID };
      for (;;) {
        const outcome = await onLoginRole(pool, async (client) => {
          const rows = await scan.window(client, cursor, batchSize);
          const last = rows.at(-1);
          if (!last) return null;
          const window = { ...emptyCounts(), examined: rows.length };
          for (const row of rows) {
            const finding = scan.inspect(row);
            if (finding === null) continue;
            window.affected += 1;
            if (!rewrites.has(scan.category)) {
              window.examples.push({ workspaceId: row.workspace_id, id: row.id });
              continue;
            }
            window.values += finding.values;
            if (input.confirm && finding.rewrite) {
              const updated = await client.query(finding.rewrite.sql, [...finding.rewrite.params]);
              if ((updated.rowCount ?? 0) === 0) window.skipped += 1;
            }
          }
          return {
            window,
            cursor: { workspaceId: last.workspace_id ?? NIL_UUID, id: last.id },
            done: rows.length < batchSize,
          };
        });
        if (outcome === null) break;
        // Merged only once the window's transaction committed.
        batches += 1;
        cursor = outcome.cursor;
        counts.examined += outcome.window.examined;
        counts.affected += outcome.window.affected;
        counts.skipped += outcome.window.skipped;
        counts.values += outcome.window.values;
        for (const example of outcome.window.examples) {
          if (counts.examples.length < MAX_EXAMPLES) counts.examples.push(example);
        }
        if (outcome.done) break;
      }
    }
  } catch (err) {
    failure = err;
  }

  if (!input.confirm) {
    if (failure !== undefined) throw failure;
    return result(null);
  }

  const audit = await onLoginRole(pool, (client) =>
    writeAudit(client, {
      workspaceId: null,
      actorPrincipalId: null,
      ...(input.actorUserId !== undefined ? { actorUserId: input.actorUserId } : {}),
      action: RAW_SECRET_SCRUB_AUDIT_ACTION,
      resourceType: 'platform',
      payload: {
        channel: 'cli',
        attributedActor: input.actorUserId !== undefined,
        batchSize,
        completed: failure === undefined,
        ...(failure !== undefined
          ? { error: failure instanceof Error ? failure.message : String(failure) }
          : {}),
        batches,
        // Counts and ids only — never a value.
        categories,
      },
    }),
  );
  if (failure !== undefined) throw new RawSecretScrubFailedError(failure, result(audit.id));
  return result(audit.id);
}
