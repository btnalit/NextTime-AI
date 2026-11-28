import { randomUUID } from 'node:crypto';
import { SECRET_FIELD_MASK } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import type { PoolLike } from '../../adapters/db/pool.js';
import { withWorkspace } from '../../adapters/db/pool.js';
import { reasonAuditFields, resultAuditFields } from '../../governance/approval/index.js';
import {
  findConnectionParamsCredential,
  redactConnectionAddress,
} from '../../governance/connections/index.js';
import {
  STORED_REWRITE_SECRET_PATTERNS,
  type Scrubbed,
  findSuspectedSecrets,
  platformApiKeys,
  platformKeyShapes,
  redactSuspectedSecrets,
  repairSplitQuotedMasks,
  scrubSecretValues,
  tailChecked,
} from '../../governance/redaction/index.js';
import { writeAudit } from '../../substrate/audit/index.js';
import { scrubGraphProperties } from '../../substrate/graph/index.js';
import { KERNEL_AUTHORED_OBJECT_TYPES } from '../../substrate/ontology/index.js';
import {
  rescrubStoredToolCallResult,
  storedToolCallResultTailUnproven,
} from '../chat/tool-call-record.js';
import { selfConnectionAddressRewrite } from '../gates/self-connections.js';
import { hashApiKey } from '../gateway/auth.js';
import { GATE_OBSERVATION_ACTIVITY_KIND, gatePayloadKeptRaw } from '../task/gate-observation.js';

/**
 * application/platform/scrub-raw-secrets: the rows written before STATUS legacy 183–187 were fixed,
 * which can still hold a credential in plain text. The mechanism behind `cli/scrub-raw-secrets.ts`,
 * which `scripts/apply-release.sh` runs after the release's `BACKUP_NOW` — that dump is the
 * recovery point for every row this rewrites.
 *
 * **Rewritten** — copies people read, scrubbed the way the write path now scrubs them:
 *   - `turnReports`: an agent Turn's `activities.metadata.summary` / `.decisions` (`report_turn`,
 *     legacy 183) — a quoted value written with `\"` that an earlier release split rewritten as it
 *     is written now (`repairSplitQuotedMasks`), then every secret-looking value but a platform API
 *     key's shape (`STORED_REWRITE_SECRET_PATTERNS`; see `*KeyShapes` below);
 *   - `decisions`: the `summary` of a Decision whose Activity is an agent Turn (`record_decision`,
 *     legacy 183) — likewise;
 *   - `toolCallRecords`: a stored tool-call record's result preview (legacy 185) — a split quoted
 *     value rewritten likewise, the key rule over JSON text, its escaped strings scrubbed decoded
 *     (legacy 916), then the value patterns but the key's shape over the rest (application/chat's
 *     `rescrubStoredToolCallResult`);
 *   - `selfConnectionAddresses`: the copy of a self-connected gate's `target` / `endpoint` the
 *     platform plane shows (`workspace_self_connections`, core 0045) — copied from a Gatekeeper
 *     written before legacy 186, it can carry what the address rule refuses; it is cut out
 *     (`redactConnectionAddress`). Core 0045's backfill already cuts what the preflight patterns
 *     find; this holds the table to the exact rule. The Gatekeeper's own address is counted
 *     (`gatekeeperAddresses`), not rewritten — the gate is called there;
 *   - `gatekeeperNames`: a Gatekeeper's `name` (legacy 384) — a self-connected gate is named after
 *     the target its owner typed (application/gates/landing.ts), so one written before legacy 186
 *     can carry a credential in it. A label nothing calls: rewritten to what every read shows
 *     (`redactConnectionAddress`, the `target` rule — registry.ts `displayedGatekeeperName`);
 *   - `connectedSystems`: the ConnectedSystem Object a gate's landing writes beside it (legacy
 *     384) — its identity key's `name` (the gate's name) and its `target`, likewise; nothing calls
 *     it either. Its identity key is an upsert key (`objects_identity_key_uidx`), so two systems
 *     whose names differed only in a credential would collide once both are cut: the first in
 *     key order takes the shown name, and every later one gives its identity key up (`null`) and
 *     keeps the name as `properties.name` beside `properties.duplicateOf` (the holder's id).
 *     Nothing is merged into the holder: the `connects_to` Fact that names the duplicate is
 *     append-only (I4), so the duplicate stays the Object its Gatekeeper is linked to. Rewritten
 *     with the identity key and properties as read; a system that took the shown name in between
 *     fails the run (`objects_identity_key_uidx`), and a rerun makes this one its duplicate;
 *   - `connectionActivities`: the `governance.create_connection` Activity a self connection's
 *     landing records (legacy 375) — its `metadata.target` copies the address the owner typed
 *     (application/gates/landing.ts); nothing calls it. Rewritten to what every read shows
 *     (`redactConnectionAddress`, the `target` rule — `explain` / `causal_chain` cut it on read
 *     too, resource-wire.ts `toWireExplainResult`), conditional on the target as read. A count
 *     would never clear: the gate's own address is fixed by re-registering the gate
 *     (`gatekeeperAddresses`), which leaves this copy as it was.
 *
 * **Counted, never rewritten:**
 *   - `taskInputs`: a `tasks.input` carrying a suspected credential (legacy 184). The Worker runs
 *     on its input as given; every other reader now gets it masked;
 *   - `connectionTargets` / `gatekeeperAddresses`: a connection request's `target`, a Gatekeeper's
 *     `target` / `endpoint`, carrying a credential (legacy 186) — it is where the gate is called;
 *     its owner fixes it (cancel the request, re-register the gate);
 *   - `gateInstanceAddresses`: a platform gate instance's `target` / `endpoint`, or its gate-host
 *     definition's `target` / `manifestSource`, carrying a credential (review of #549) — the gate
 *     host calls the definition as stored; an administrator recreates the instance without it;
 *   - `factProperties` / `objectProperties`: a Fact's (`links.properties`) or an Object's
 *     properties the graph store would now scrub (`scrubGraphProperties`, review of #549) — an
 *     agent's `assert_fact` / `supersede_fact`, a gate's observed Objects, an ingest. A Fact is an
 *     append-only epistemic record and an observed Object is the next observation's to refresh, so
 *     neither is rewritten here; the Object types the kernel writes itself
 *     (`KERNEL_AUTHORED_OBJECT_TYPES`) are not counted;
 *   - `auditResults`: an `action_request.complete` / `.fail` audit row whose `resultMetadata` /
 *     `reason` the audit rule would now hide something in (legacy 187). Audit rows are append-only
 *     (I11) — the dump `BACKUP_NOW` takes is no worse a copy than the table itself;
 *   - `auditPayloads`: any audit row whose payload holds a value the value patterns would now hide
 *     (`findSuspectedSecrets`, without the field-name rule: a payload's own fields —
 *     `credentialReview`, `suspectedSecretValues` — are named after secrets) — a params copy
 *     written before legacy 180, say. A pre-prefix platform API key's bare shape is no longer one
 *     of those values (legacy 906 step 2): a row holding one is found only if the key is still
 *     issued (`liveApiKeys` below). Append-only like `auditResults`, so the count never clears; an
 *     `action_request.complete` / `.fail` row can be in both. What to act on is `liveApiKeys`
 *     below;
 *   - `gateCallObservations`: an Observation of a Worker's gate call (Activity kind
 *     `worker_gate_call`) written before legacy 237, which kept the gate's result as it came — one
 *     the rule it is now kept by would hide something in; a row written since is marked as that
 *     copy and never counted (application/task/gate-observation.ts `gatePayloadKeptRaw`; legacy
 *     817). No read returns an Observation's `content`, so the raw copy is in the table and in every
 *     dump only; Observations are insert-only (core 0035 revokes UPDATE), the provenance of what
 *     was observed, so — like a Fact — none is rewritten here;
 *   - `turnReportKeyShapes` / `decisionKeyShapes` / `toolCallRecordKeyShapes`: a row of the three
 *     rewritten categories above still holding a pre-prefix platform API key standing alone (43 base64url
 *     characters, `PLATFORM_KEY_SHAPE_PATTERNS`; legacy 168 review). The rewrite leaves that shape:
 *     it is any 32 bytes in base64url — a digest, a public key — and a rewrite cannot be undone, so
 *     the row is listed by id for the keys still valid among them to be found and rotated. Read
 *     after the rewrite of the same table, so a dry run also counts what the key rule would mask
 *     first;
 *   - `connectedSystemDuplicates`: not a credential — every ConnectedSystem a run (this one or an
 *     earlier one) made a duplicate (`connectedSystems` above), for the record. Read after the
 *     rewrites, so a dry run lists only earlier runs' duplicates: whether a cut name collides is
 *     known only once the names before it in key order have been rewritten.
 * A counted row is named by id, never by value: every one goes to `onCounted` (the CLI prints them
 * all, for the operator to go through row by row), and the first `MAX_EXAMPLES` per category are
 * kept as `examples` — the sample the audit row carries, which must stay bounded.
 *
 * **Tail unproven (`tailUnproven`, «收尾未证明»).** The rows above are found by the value rules as
 * they read a stored row (`tailCheck: false` where the reading is the write path's), the count
 * kept as it was: a row is counted, or rewritten, when that reading changes it — «密钥残留». Of
 * the rows that reading leaves as they are, in the three rewritten categories from agent text and
 * the five counted ones the value rules read (`TAIL_UNPROVEN_CATEGORIES`), those the tail check
 * would hide more in (`docs/redaction-boundary-design-2026-11-27.md` §4.2–§4.3; class legacy 962)
 * are counted apart, with their own ids and callback (`onTailUnproven`), so the few rows to look
 * at are not lost among them: the text after a mask there does not pass the check. That is not a
 * secret count — a value an earlier release hid only in part with harmless code after it
 * (`TOKEN = [redacted]'hex');`) is counted as `TOKEN="[redacted]"<secret>y` is, and the check
 * cannot tell them apart — so nothing is rewritten for it (design D3): the counts of the first
 * host upgrade decide whether a later release does. The three rewritten categories are read by the
 * check alone (`tailChecked`, a tool-call record's escaped JSON strings decoded as the rewrite
 * reads them, `storedToolCallResultTailUnproven`); the five counted ones by their reading with the
 * check (the write path's default). `gateCallObservations` is not split: a row is counted there
 * by the rule a raw copy is now kept by, the check included (`gatePayloadKeptRaw`).
 *
 * **Keys still issued (`liveApiKeys`).** Before anything is rewritten, every table in the `public`
 * schema is read once more, each text, JSON and text-array column of every row (but the two
 * credential hashes, `principals.api_key_hash` and `users.password_hash`): a person's chat message,
 * an agent's reply, an Operation call's `action_requests.params`, a Worker's report, a note, a
 * proposal — wherever a key could have been pasted or echoed, not only where the scans above look.
 * Every platform API key in them — a prefixed one (`ntk_…`, legacy 906) or a value of the shape
 * keys had before the prefix (`platformApiKeys`) — is hashed the way `principals.api_key_hash`
 * stores a key (`hashApiKey`) and looked up there. A match is a key still issued, listed
 * (`onLiveApiKey`, and the first `MAX_EXAMPLES` as `examples`) by ids only: the table and the row's
 * primary key (its `ctid` for a table without one), the Principal holding the key (one key per
 * Principal: the key's id) and, for a person's membership, their user (the account) — never the
 * key, never a hash, never which column. One line per row and key. A key the rewrite then hides
 * (`Bearer <key>`, a secret-named JSON field) is listed by that run only, so the keys to rotate are
 * the ones the first run lists; a later run listing none says no row of the database, as stored,
 * still holds an issued key's value standing alone. A key stops matching once its Principal is
 * re-keyed (`rotate_api_key`), loses it (its person changes their password or has it reset:
 * `revokeUserCredentials`) or is disabled (core 0059); a key on a disabled workspace or user still
 * matches, since re-enabling either would let it authenticate again. The hashes reach the database
 * only as the lookup's parameter, as every API call's key does (gateway/auth.ts
 * `lookupPrincipalByApiKeyHash`). Not compared: anything outside this database — the dump
 * `BACKUP_NOW` takes, the logs.
 *
 * **How.** Per table, windows of `batchSize` rows in primary-key order, each one short transaction
 * on the login role (`skipRoleSwitch`, RLS-bypassing like compact-observations: `nexttime_app` has
 * no UPDATE on `decisions` or `chat_messages`, core 0035 / 0008). A rewrite is conditional on the
 * value it read (`… and <column> = <what was read>`), so a row changed in between is left as it is
 * (`skipped`) for the next run. A rewrite only hides more of a value, as the mask. A second run
 * finds nothing to do in almost every row, but not in all: in a few, the rules read the rewritten
 * value on and hide a little more (release.md §3.219: a third run finds nothing more).
 *
 * **Audit.** An executing run writes one platform audit row, `cli.raw_secrets_scrubbed`, with the
 * counts — also when it fails part-way, so the windows that did commit are on record
 * (`completed: false` plus the error). Unattributed when no operator resolves (core 0040).
 */

export const RAW_SECRET_SCRUB_BATCH_SIZE = 500;
export const RAW_SECRET_SCRUB_AUDIT_ACTION = 'cli.raw_secrets_scrubbed';
/** Ids kept per counted category in the result and on the audit row (`onCounted` gets all). */
export const MAX_EXAMPLES = 20;
/** Rows per window of the key comparison (`liveApiKeys`). It only reads and holds no lock a rewrite
 *  would, so its windows are not the rewrites' short ones (`batchSize`); but a window's rows are all
 *  held at once, and a row can be as large as an agent reply's stored cap: a thousand such rows
 *  peaked near 680 MB of the CLI's memory, two hundred near 400 MB (release.md §3.208). */
export const LIVE_API_KEY_COMPARE_WINDOW = 200;

export const REWRITTEN_CATEGORIES = [
  'turnReports',
  'decisions',
  'toolCallRecords',
  'selfConnectionAddresses',
  'gatekeeperNames',
  'connectedSystems',
  'connectionActivities',
] as const;
export const COUNTED_CATEGORIES = [
  'taskInputs',
  'connectionTargets',
  'gatekeeperAddresses',
  'gateInstanceAddresses',
  'factProperties',
  'objectProperties',
  'auditResults',
  'auditPayloads',
  'gateCallObservations',
  'turnReportKeyShapes',
  'decisionKeyShapes',
  'toolCallRecordKeyShapes',
  'connectedSystemDuplicates',
] as const;
export type CountedRawSecretCategory = (typeof COUNTED_CATEGORIES)[number];
/** The categories whose rows the reading above leaves as they are are read with the tail check too
 *  («收尾未证明», `tailUnproven`): the three rewritten from agent text and the five counted ones the
 *  value rules read. */
export const TAIL_UNPROVEN_CATEGORIES = [
  'turnReports',
  'decisions',
  'toolCallRecords',
  'taskInputs',
  'factProperties',
  'objectProperties',
  'auditResults',
  'auditPayloads',
] as const;
export type TailUnprovenCategory = (typeof TAIL_UNPROVEN_CATEGORIES)[number];
export type RawSecretCategory = (typeof REWRITTEN_CATEGORIES)[number] | CountedRawSecretCategory;

/** A counted row, by id only. */
export interface CountedRawSecretRow {
  readonly workspaceId: string | null;
  readonly id: string;
}

export interface RawSecretCategoryCounts {
  /** Rows read. */
  examined: number;
  /** Rows carrying something to hide — rewritten (`rewritten`), or that would be on `--yes`. */
  affected: number;
  /** Of `affected`, rows a run with `--yes` left as they were because they changed in between. */
  skipped: number;
  /** Values hidden (or that would be) — rewritten categories only. */
  values: number;
  /** The first `MAX_EXAMPLES` affected rows — counted categories only. */
  examples: CountedRawSecretRow[];
}

/** «收尾未证明» in one category: rows the reading of `RawSecretCategoryCounts` leaves as they are and
 *  the tail check would hide more in — a row to look at, not a secret found. */
export interface TailUnprovenCounts {
  rows: number;
  /** The first `MAX_EXAMPLES` (`onTailUnproven` gets all). */
  examples: CountedRawSecretRow[];
}

/** A row holding a platform API key still issued, by ids only — never the key, never its hash. */
export interface LiveApiKeyRow {
  /** The table (`public` schema). */
  readonly table: string;
  /** The row: its primary key's values as text, in the key's column order — `[workspaceId, id]`
   *  for most tables; `[ctid]` for a table without a primary key. A value that may hold a secret is
   *  `SECRET_FIELD_MASK` instead (`shownRowKey`). */
  readonly row: readonly string[];
  /** The Principal the key is issued to (`principals.api_key_hash`: one key per Principal). */
  readonly principalWorkspaceId: string;
  readonly principalId: string;
  /** `human` (a person's membership) or `service` — which way its key is rotated. */
  readonly principalKind: string;
  /** A `human` Principal's user — the account; `null` for a service Principal. */
  readonly userId: string | null;
}

export interface LiveApiKeyCounts {
  /** Tables read, and their rows: what was compared. */
  tables: number;
  rows: number;
  /** Rows holding a key still issued, once per row and key. */
  found: number;
  /** The Principals among them: the keys still to rotate. */
  keys: number;
  /** The first `MAX_EXAMPLES` found (`onLiveApiKey` gets all). */
  examples: LiveApiKeyRow[];
}

export interface ScrubRawSecretsInput {
  readonly confirm: boolean;
  readonly batchSize?: number;
  /** The operator, when one resolves; else the audit row is unattributed. */
  readonly actorUserId?: string;
  /** Called with every counted row, uncapped, once its window is read. */
  readonly onCounted?: (category: CountedRawSecretCategory, row: CountedRawSecretRow) => void;
  /** Called with every row found holding a key still issued, uncapped, once its window is read. */
  readonly onLiveApiKey?: (row: LiveApiKeyRow) => void;
  /** Called with every row «收尾未证明» (`tailUnproven`), uncapped, once its window is read. */
  readonly onTailUnproven?: (category: TailUnprovenCategory, row: CountedRawSecretRow) => void;
}

export interface ScrubRawSecretsResult {
  readonly executed: boolean;
  readonly batchSize: number;
  readonly batches: number;
  readonly categories: Readonly<Record<RawSecretCategory, RawSecretCategoryCounts>>;
  /** «收尾未证明», apart from `categories` (theirs is «密钥残留»). */
  readonly tailUnproven: Readonly<Record<TailUnprovenCategory, TailUnprovenCounts>>;
  readonly liveApiKeys: Readonly<LiveApiKeyCounts>;
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

/** What one row needs: nothing (`null`), a count, or a conditional rewrite — or, where nothing
 *  else is found, a count apart (`tailUnproven`). */
interface Finding {
  readonly values: number;
  readonly rewrite?: { readonly sql: string; readonly params: readonly unknown[] };
  readonly tailUnproven?: true;
}

/** «收尾未证明»: nothing to rewrite or count, a row the tail check would hide more in. */
const TAIL_UNPROVEN: Finding = { values: 0, tailUnproven: true };

/** Whether the tail check alone would hide more in any of `texts` (non-strings skipped). */
function tailUnproven(texts: readonly unknown[]): boolean {
  return texts.some((text) => typeof text === 'string' && tailChecked(text).value !== text);
}

interface Scan {
  readonly category: RawSecretCategory;
  /** Where the keyset starts; the nil `(workspace_id, id)` when omitted. */
  readonly start?: Cursor;
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

/**
 * `connectedSystems`' rewrite: `write` when no other ConnectedSystem in the workspace holds
 * `write.identityKey`; else the duplicate's shape (identity key released, the shown name and
 * `duplicateOf` in its properties). Conditional on the identity key and properties as read.
 */
function connectedSystemRewrite(
  key: { readonly workspaceId: string; readonly id: string },
  read: {
    readonly identityKey: Record<string, unknown> | null;
    readonly properties: Record<string, unknown>;
  },
  write: {
    readonly identityKey: Record<string, unknown> | null;
    readonly properties: Record<string, unknown>;
  },
): { readonly sql: string; readonly params: readonly unknown[] } {
  return {
    sql: `with holder as (
            select id from objects
             where workspace_id = $1 and object_type = 'ConnectedSystem'
               and identity_key = $3::jsonb and id <> $2
          )
          update objects
             set identity_key = case when exists (select 1 from holder) then null else $3::jsonb end,
                 properties = case when exists (select 1 from holder)
                   then $4::jsonb || jsonb_build_object(
                     'name', $3::jsonb ->> 'name', 'duplicateOf', (select id::text from holder))
                   else $4::jsonb end
           where workspace_id = $1 and id = $2 and object_type = 'ConnectedSystem'
             and identity_key is not distinct from $5::jsonb and properties = $6::jsonb`,
    params: [
      key.workspaceId,
      key.id,
      write.identityKey === null ? null : JSON.stringify(write.identityKey),
      JSON.stringify(write.properties),
      read.identityKey === null ? null : JSON.stringify(read.identityKey),
      JSON.stringify(read.properties),
    ],
  };
}

/** What a rewrite of these rows hides: every value pattern but a platform API key's shape. */
const STORED_REWRITE = { patterns: STORED_REWRITE_SECRET_PATTERNS } as const;

/** Agent text as stored, scrubbed the way it is written now: a quoted value an earlier release
 *  split (`[redacted]"…\"`) written whole first (`repairSplitQuotedMasks`), then `STORED_REWRITE`. */
function rescrubStoredText(text: string): Scrubbed<string> {
  const repaired = repairSplitQuotedMasks(text);
  const scrubbed = scrubSecretValues(repaired.value, STORED_REWRITE);
  return {
    value: scrubbed.value,
    redactedValues: repaired.redactedValues + scrubbed.redactedValues,
  };
}

/** How many values of a platform API key's shape `text` holds (0 for a non-string). */
function keyShapes(text: unknown): number {
  return typeof text === 'string' ? platformKeyShapes(text).length : 0;
}

/** A run of base64url characters as long as a platform API key or longer. A key may sit inside one
 *  (`call_<key>`), where the value rules, which want a key standing alone, do not see it; a uuid
 *  (36 characters) is never one. */
const KEY_LENGTH_RUN = /[A-Za-z0-9_-]{43,}/;

/** `row`'s primary key values as output: one a value rule would cut (a platform API key's shape, a
 *  Handle, any other) or that holds a `KEY_LENGTH_RUN` is masked whole, so a secret used as (part
 *  of) a text primary key (`connectors.name`, `quotas.key`, a `tool_call_id`) reaches neither the
 *  log nor the append-only audit row. Paging goes on from the values as read. */
function shownRowKey(row: readonly string[]): string[] {
  return row.map((value) =>
    KEY_LENGTH_RUN.test(value) || scrubSecretValues(value).redactedValues > 0
      ? SECRET_FIELD_MASK
      : value,
  );
}

/** The hash `principals.api_key_hash` would hold (`hashApiKey`) of every platform API key in
 *  `value` as read, prefixed or of the pre-prefix shape (`platformApiKeys`): every string at any
 *  depth, object keys included. The keys themselves go no further than this function. */
function keyShapeHashes(value: unknown): Set<string> {
  const hashes = new Set<string>();
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const next = stack.pop();
    if (typeof next === 'string') {
      for (const key of platformApiKeys(next)) hashes.add(hashApiKey(key));
    } else if (Array.isArray(next)) {
      for (const item of next) stack.push(item);
    } else if (next !== null && typeof next === 'object') {
      for (const [key, item] of Object.entries(next)) stack.push(key, item);
    }
  }
  return hashes;
}

interface IssuedKeyRow {
  readonly workspace_id: string;
  readonly id: string;
  readonly kind: string;
  readonly user_id: string | null;
  readonly api_key_hash: string;
}

/** The Principals holding a key whose hash is among `hashes`, by hash — read here and dropped. */
async function issuedKeysAmong(
  client: PoolClient,
  hashes: readonly string[],
): Promise<Map<string, IssuedKeyRow>> {
  const { rows } = await client.query<IssuedKeyRow>(
    `select workspace_id, id, kind, user_id, api_key_hash from principals
      where api_key_hash = any($1::text[])`,
    [hashes],
  );
  return new Map(rows.map((row) => [row.api_key_hash, row]));
}

/** Never compared: the credentials' own hashes, which are not where a key is copied. */
const NOT_COMPARED_COLUMNS: ReadonlySet<string> = new Set([
  'principals.api_key_hash',
  'users.password_hash',
]);

interface ComparedTable {
  readonly name: string;
  /** The primary key's columns and types, in key order; `ctid` for a table without one. */
  readonly key: readonly { readonly name: string; readonly type: string }[];
  /** The text, JSON and text-array columns compared. */
  readonly columns: readonly string[];
}

function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** Every table of the `public` schema (a partitioned one once, not per partition) with a column a
 *  key could be copied into: a string type (`text`, `varchar`, …), `json`, `jsonb`, or an array of
 *  one. Read from the catalog, so a table a later migration adds is compared without a change here. */
async function comparedTables(client: PoolClient): Promise<ComparedTable[]> {
  const { rows } = await client.query<{
    name: string;
    key: { name: string; type: string }[];
    columns: string[];
  }>(
    `select c.relname as name,
            coalesce((select json_agg(json_build_object(
                               'name', a.attname, 'type', format_type(a.atttypid, a.atttypmod))
                             order by k.ord)
                        from pg_index i
                       cross join unnest(i.indkey) with ordinality as k(attnum, ord)
                        join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
                       where i.indrelid = c.oid and i.indisprimary), '[]') as key,
            coalesce((select json_agg(a.attname order by a.attnum)
                        from pg_attribute a
                        join pg_type t on t.oid = a.atttypid
                        left join pg_type e on t.typcategory = 'A' and e.oid = t.typelem
                       where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
                         and (t.typcategory = 'S' or t.typname in ('json', 'jsonb')
                              or e.typcategory = 'S' or e.typname in ('json', 'jsonb'))), '[]')
              as columns
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relispartition
      order by c.relname`,
  );
  return rows
    .map((row) => ({
      name: row.name,
      key: row.key.length > 0 ? row.key : [{ name: 'ctid', type: 'tid' }],
      columns: row.columns.filter((column) => !NOT_COMPARED_COLUMNS.has(`${row.name}.${column}`)),
    }))
    .filter((table) => table.columns.length > 0);
}

/** `table`'s rows after `after` (its key's values as text; `null` from the start) in key order, at
 *  most `limit`: each one's key as text and its compared columns' values. */
async function comparedWindow(
  client: PoolClient,
  table: ComparedTable,
  after: readonly string[] | null,
  limit: number,
): Promise<{ row: string[]; values: unknown[] }[]> {
  const key = table.key.map((column) => quoteIdent(column.name)).join(', ');
  const bound =
    after === null
      ? ''
      : `where (${key}) > (${table.key.map((column, i) => `$${i + 2}::${column.type}`).join(', ')})`;
  const { rows } = await client.query<Record<string, unknown>>(
    `select ${table.key.map((column, i) => `${quoteIdent(column.name)}::text as k${i}`).join(', ')},
            ${table.columns.map((column, i) => `${quoteIdent(column)} as v${i}`).join(', ')}
       from public.${quoteIdent(table.name)} ${bound}
      order by ${key} limit $1`,
    [limit, ...(after ?? [])],
  );
  return rows.map((row) => ({
    row: table.key.map((_, i) => row[`k${i}`] as string),
    values: table.columns.map((_, i) => row[`v${i}`]),
  }));
}

/** A counted Finding for `count` key shapes, or `null` for none. */
function keyShapeFinding(count: number): Finding | null {
  return count > 0 ? { values: count } : null;
}

function scrubbedStrings(values: readonly unknown[]): { values: unknown[]; hidden: number } {
  let hidden = 0;
  const out = values.map((value) => {
    if (typeof value !== 'string') return value;
    const scrubbed = rescrubStoredText(value);
    hidden += scrubbed.redactedValues;
    return scrubbed.value;
  });
  return { values: out, hidden };
}

const turnReportWindow = workspaceKeyset(
  'activities',
  'workspace_id, id, metadata',
  `kind = 'agent_turn' and (metadata ? 'summary' or metadata ? 'decisions')`,
);

async function decisionWindow(
  client: PoolClient,
  after: Cursor,
  limit: number,
): Promise<ScannedRow[]> {
  return (
    await client.query<ScannedRow>(
      `select d.workspace_id, d.id, d.summary from decisions d
         join activities a on a.workspace_id = d.workspace_id and a.id = d.activity_id
        where (d.workspace_id, d.id) > ($1::uuid, $2::uuid) and a.kind = 'agent_turn'
          and d.summary is not null
        order by d.workspace_id, d.id limit $3`,
      [after.workspaceId, after.id, limit],
    )
  ).rows;
}

const toolCallRecordWindow = workspaceKeyset(
  'chat_messages',
  'workspace_id, id, content',
  `role = 'tool' and content ->> 'kind' = 'tool_call' and content ? 'result'`,
);

const SCANS: readonly Scan[] = [
  {
    category: 'turnReports',
    window: turnReportWindow,
    inspect: (row) => {
      const metadata = (row as ScannedRow & { metadata: Record<string, unknown> }).metadata;
      const patch: Record<string, unknown> = {};
      let hidden = 0;
      if (typeof metadata.summary === 'string') {
        const scrubbed = rescrubStoredText(metadata.summary);
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
      if (Object.keys(patch).length === 0) {
        return tailUnproven([metadata.summary, ...(Array.isArray(decisions) ? decisions : [])])
          ? TAIL_UNPROVEN
          : null;
      }
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
    window: decisionWindow,
    inspect: (row) => {
      const summary = (row as ScannedRow & { summary: string }).summary;
      const scrubbed = rescrubStoredText(summary);
      if (scrubbed.value === summary) return tailUnproven([summary]) ? TAIL_UNPROVEN : null;
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
    window: toolCallRecordWindow,
    inspect: (row) => {
      const content = (row as ScannedRow & { content: Record<string, unknown> }).content;
      const scrubbed = rescrubStoredToolCallResult(content);
      if (scrubbed.value === content) {
        return storedToolCallResultTailUnproven(content) ? TAIL_UNPROVEN : null;
      }
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
  // After the rewrite of each table: what it leaves of a platform API key's shape, by row id. The
  // keys still issued among them were compared by the rewrite scan, as read.
  {
    category: 'turnReportKeyShapes',
    window: turnReportWindow,
    inspect: (row) => {
      const metadata = (row as ScannedRow & { metadata: Record<string, unknown> }).metadata;
      const decisions: unknown = metadata.decisions;
      return keyShapeFinding(
        keyShapes(metadata.summary) +
          (Array.isArray(decisions) ? decisions.reduce((sum, d) => sum + keyShapes(d), 0) : 0),
      );
    },
  },
  {
    category: 'decisionKeyShapes',
    window: decisionWindow,
    inspect: (row) => keyShapeFinding(keyShapes((row as ScannedRow & { summary: string }).summary)),
  },
  {
    category: 'toolCallRecordKeyShapes',
    window: toolCallRecordWindow,
    inspect: (row) => {
      const content = (row as ScannedRow & { content: Record<string, unknown> }).content;
      const result = content.result as { text?: unknown } | null | undefined;
      return keyShapeFinding(keyShapes(result?.text));
    },
  },
  {
    category: 'selfConnectionAddresses',
    // Keyed on `(workspace_id, gatekeeper_object_id)` (core 0045).
    window: async (client, after, limit) =>
      (
        await client.query<ScannedRow>(
          `select workspace_id, gatekeeper_object_id as id, target, endpoint
             from workspace_self_connections
            where (workspace_id, gatekeeper_object_id) > ($1::uuid, $2::uuid)
            order by workspace_id, gatekeeper_object_id limit $3`,
          [after.workspaceId, after.id, limit],
        )
      ).rows,
    inspect: (row) => {
      const read = row as ScannedRow & { target: string; endpoint: string };
      const write = {
        target: redactConnectionAddress('target', read.target),
        endpoint: redactConnectionAddress('endpoint', read.endpoint),
      };
      const values =
        (write.target === read.target ? 0 : 1) + (write.endpoint === read.endpoint ? 0 : 1);
      if (values === 0) return null;
      return {
        values,
        rewrite: selfConnectionAddressRewrite(
          { workspaceId: read.workspace_id as string, gatekeeperObjectId: read.id },
          { target: read.target, endpoint: read.endpoint },
          write,
        ),
      };
    },
  },
  {
    category: 'gatekeeperNames',
    window: workspaceKeyset(
      'objects',
      `workspace_id, id, properties ->> 'name' as name`,
      `object_type = 'Gatekeeper' and properties ->> 'name' is not null`,
    ),
    inspect: (row) => {
      const { name } = row as ScannedRow & { name: string };
      const shown = redactConnectionAddress('target', name);
      if (shown === name) return null;
      return {
        values: 1,
        rewrite: {
          sql: `update objects set properties = jsonb_set(properties, '{name}', to_jsonb($3::text))
                 where workspace_id = $1 and id = $2 and object_type = 'Gatekeeper'
                   and properties ->> 'name' = $4`,
          params: [row.workspace_id, row.id, shown, name],
        },
      };
    },
  },
  {
    category: 'connectedSystems',
    window: workspaceKeyset(
      'objects',
      'workspace_id, id, identity_key, properties',
      `object_type = 'ConnectedSystem'`,
    ),
    inspect: (row) => {
      const read = row as ScannedRow & {
        identity_key: Record<string, unknown> | null;
        properties: Record<string, unknown>;
      };
      let values = 0;
      // The fields every read shows cut (resource-wire.ts `displayedObject`), by the `target` rule.
      const shownFields = (record: Record<string, unknown>, fields: readonly string[]) => {
        const shown = { ...record };
        for (const field of fields) {
          const value = record[field];
          if (typeof value !== 'string') continue;
          shown[field] = redactConnectionAddress('target', value);
          if (shown[field] !== value) values += 1;
        }
        return shown;
      };
      const identityKey = read.identity_key && shownFields(read.identity_key, ['name']);
      const properties = shownFields(read.properties, ['target', 'name']);
      if (values === 0) return null;
      return {
        values,
        rewrite: connectedSystemRewrite(
          { workspaceId: read.workspace_id as string, id: read.id },
          { identityKey: read.identity_key, properties: read.properties },
          { identityKey, properties },
        ),
      };
    },
  },
  {
    category: 'connectionActivities',
    window: workspaceKeyset(
      'activities',
      `workspace_id, id, metadata ->> 'target' as target`,
      `kind = 'governance.create_connection' and jsonb_typeof(metadata -> 'target') = 'string'`,
    ),
    inspect: (row) => {
      const { target } = row as ScannedRow & { target: string };
      const shown = redactConnectionAddress('target', target);
      if (shown === target) return null;
      return {
        values: 1,
        rewrite: {
          sql: `update activities set metadata = jsonb_set(metadata, '{target}', to_jsonb($3::text))
                 where workspace_id = $1 and id = $2 and kind = 'governance.create_connection'
                   and metadata ->> 'target' = $4`,
          params: [row.workspace_id, row.id, shown, target],
        },
      };
    },
  },
  {
    category: 'taskInputs',
    window: workspaceKeyset('tasks', 'workspace_id, id, input', 'input is not null'),
    inspect: (row) => {
      const input = (row as ScannedRow & { input: unknown }).input;
      const changes = (tailCheck: boolean) => {
        const masked = redactSuspectedSecrets(input, { secretFields: true, tailCheck });
        return JSON.stringify(masked.value) === JSON.stringify(input) ? null : masked.count;
      };
      const count = changes(false);
      if (count !== null) return { values: count };
      return changes(true) === null ? null : TAIL_UNPROVEN;
    },
  },
  {
    category: 'connectionTargets',
    // Legacy 254 (governance 0047): a gate instance enable request names no address.
    window: workspaceKeyset(
      'connection_requests',
      'workspace_id, id, target',
      'target is not null',
    ),
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
    category: 'gateInstanceAddresses',
    // The platform catalog, keyed on `gate_id` (text, `^[a-z0-9]…`): every id sorts after ''.
    start: { workspaceId: NIL_UUID, id: '' },
    window: async (client, after, limit) =>
      (
        await client.query<ScannedRow>(
          `select null::uuid as workspace_id, gate_id as id, target, endpoint,
                  definition ->> 'target' as definition_target,
                  definition ->> 'manifestSource' as manifest_source
             from gate_instances
            where gate_id > $1 collate "C"
            order by gate_id collate "C" limit $2`,
          [after.id, limit],
        )
      ).rows,
    inspect: (row) => {
      const instance = row as ScannedRow & {
        target: string;
        endpoint: string;
        definition_target: string | null;
        manifest_source: string | null;
      };
      return findConnectionParamsCredential({
        target: instance.target,
        endpoint: instance.endpoint,
        manifestSource: instance.manifest_source,
      }) !== null || findConnectionParamsCredential({ target: instance.definition_target }) !== null
        ? { values: 1 }
        : null;
    },
  },
  {
    category: 'factProperties',
    window: workspaceKeyset('links', 'workspace_id, id, properties', `properties <> '{}'::jsonb`),
    inspect: (row) =>
      graphPropertiesFinding(
        (row as ScannedRow & { properties: Record<string, unknown> }).properties,
      ),
  },
  {
    category: 'objectProperties',
    window: workspaceKeyset(
      'objects',
      'workspace_id, id, properties',
      `properties <> '{}'::jsonb and object_type not in (${KERNEL_AUTHORED_OBJECT_TYPES.map((type) => `'${type}'`).join(', ')})`,
    ),
    inspect: (row) =>
      graphPropertiesFinding(
        (row as ScannedRow & { properties: Record<string, unknown> }).properties,
      ),
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
      let hides: (tailCheck: boolean) => boolean;
      if (action === 'action_request.complete') {
        const metadata = payload.resultMetadata;
        if (metadata === null || typeof metadata !== 'object') return null;
        hides = (tailCheck) =>
          JSON.stringify(
            resultAuditFields(metadata as Record<string, unknown>, requestParams, { tailCheck })
              .resultMetadata,
          ) !== JSON.stringify(metadata);
      } else {
        const reason = payload.reason;
        if (typeof reason !== 'string') return null;
        hides = (tailCheck) =>
          reasonAuditFields(reason, requestParams, { tailCheck }).reason !== reason;
      }
      if (hides(false)) return { values: 1 };
      return hides(true) ? TAIL_UNPROVEN : null;
    },
  },
  {
    category: 'auditPayloads',
    // Every audit row, keyed on `id` alone like `auditResults`.
    window: async (client, after, limit) =>
      (
        await client.query<ScannedRow>(
          `select workspace_id, id, payload from audit_records
            where id > $1::uuid order by id limit $2`,
          [after.id, limit],
        )
      ).rows,
    inspect: (row) => {
      const payload = (row as ScannedRow & { payload: unknown }).payload;
      const { count } = findSuspectedSecrets(payload, { tailCheck: false });
      if (count > 0) return { values: count };
      return findSuspectedSecrets(payload).count > 0 ? TAIL_UNPROVEN : null;
    },
  },
  {
    category: 'gateCallObservations',
    // Keyed on the Observation; its Activity says whose gate call it observed.
    window: async (client, after, limit) =>
      (
        await client.query<ScannedRow>(
          `select o.workspace_id, o.id, o.content from observations o
             join activities a on a.workspace_id = o.workspace_id and a.id = o.activity_id
            where (o.workspace_id, o.id) > ($1::uuid, $2::uuid) and a.kind = $4
            order by o.workspace_id, o.id limit $3`,
          [after.workspaceId, after.id, limit, GATE_OBSERVATION_ACTIVITY_KIND],
        )
      ).rows,
    inspect: (row) =>
      gatePayloadKeptRaw((row as ScannedRow & { content: Record<string, unknown> }).content)
        ? { values: 1 }
        : null,
  },
  {
    category: 'connectedSystemDuplicates',
    window: workspaceKeyset(
      'objects',
      'workspace_id, id',
      `object_type = 'ConnectedSystem' and properties ? 'duplicateOf'`,
    ),
    inspect: () => ({ values: 0 }),
  },
];

/** A Fact's or an Object's properties: counted as the graph store's value rules would now scrub
 *  them, else «收尾未证明» where its reading with the tail check would. */
function graphPropertiesFinding(properties: Record<string, unknown>): Finding | null {
  const { redactedValues } = scrubGraphProperties(properties, { tailCheck: false });
  if (redactedValues > 0) return { values: redactedValues };
  return scrubGraphProperties(properties).redactedValues > 0 ? TAIL_UNPROVEN : null;
}

const TAIL_UNPROVEN_SET: ReadonlySet<RawSecretCategory> = new Set(TAIL_UNPROVEN_CATEGORIES);

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
  const tailUnprovenCounts = Object.fromEntries(
    TAIL_UNPROVEN_CATEGORIES.map((name): [TailUnprovenCategory, TailUnprovenCounts] => [
      name,
      { rows: 0, examples: [] },
    ]),
  ) as Record<TailUnprovenCategory, TailUnprovenCounts>;
  const liveApiKeys: LiveApiKeyCounts = { tables: 0, rows: 0, found: 0, keys: 0, examples: [] };
  const livePrincipals = new Set<string>();
  let batches = 0;
  const result = (auditRecordId: string | null): ScrubRawSecretsResult => ({
    executed: input.confirm,
    batchSize,
    batches,
    categories,
    tailUnproven: tailUnprovenCounts,
    liveApiKeys,
    auditRecordId,
  });

  let failure: unknown;
  try {
    // First, every row as stored: before any rewrite below hides a key in it.
    for (const table of await onLoginRole(pool, comparedTables)) {
      liveApiKeys.tables += 1;
      let after: readonly string[] | null = null;
      for (;;) {
        const from = after;
        const outcome = await onLoginRole(pool, async (client) => {
          const rows = await comparedWindow(client, table, from, LIVE_API_KEY_COMPARE_WINDOW);
          const last = rows.at(-1);
          if (!last) return null;
          const read = rows.map(({ row, values }) => ({ row, hashes: keyShapeHashes(values) }));
          const hashes = new Set(read.flatMap((entry) => [...entry.hashes]));
          const issued =
            hashes.size > 0
              ? await issuedKeysAmong(client, [...hashes])
              : new Map<string, IssuedKeyRow>();
          const live: LiveApiKeyRow[] = [];
          for (const { row, hashes: rowHashes } of read) {
            const shown = shownRowKey(row);
            for (const hash of rowHashes) {
              const key = issued.get(hash);
              if (!key) continue;
              live.push({
                table: table.name,
                row: shown,
                principalWorkspaceId: key.workspace_id,
                principalId: key.id,
                principalKind: key.kind,
                userId: key.user_id,
              });
            }
          }
          return {
            examined: rows.length,
            live,
            after: last.row,
            done: rows.length < LIVE_API_KEY_COMPARE_WINDOW,
          };
        });
        if (outcome === null) break;
        batches += 1;
        after = outcome.after;
        liveApiKeys.rows += outcome.examined;
        for (const found of outcome.live) {
          input.onLiveApiKey?.(found);
          liveApiKeys.found += 1;
          livePrincipals.add(`${found.principalWorkspaceId}/${found.principalId}`);
          liveApiKeys.keys = livePrincipals.size;
          if (liveApiKeys.examples.length < MAX_EXAMPLES) liveApiKeys.examples.push(found);
        }
        if (outcome.done) break;
      }
    }
    for (const scan of SCANS) {
      const counts = categories[scan.category];
      let cursor: Cursor = scan.start ?? { workspaceId: NIL_UUID, id: NIL_UUID };
      for (;;) {
        const outcome = await onLoginRole(pool, async (client) => {
          const rows = await scan.window(client, cursor, batchSize);
          const last = rows.at(-1);
          if (!last) return null;
          const window = { ...emptyCounts(), examined: rows.length };
          const unproven: CountedRawSecretRow[] = [];
          for (const row of rows) {
            const finding = scan.inspect(row);
            if (finding === null) continue;
            if (finding.tailUnproven === true) {
              if (!TAIL_UNPROVEN_SET.has(scan.category)) {
                throw new Error(`scrub-raw-secrets: ${scan.category} has no tail-unproven count`);
              }
              unproven.push({ workspaceId: row.workspace_id, id: row.id });
              continue;
            }
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
            unproven,
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
          input.onCounted?.(scan.category as CountedRawSecretCategory, example);
          if (counts.examples.length < MAX_EXAMPLES) counts.examples.push(example);
        }
        for (const example of outcome.unproven) {
          const category = scan.category as TailUnprovenCategory;
          const unproven = tailUnprovenCounts[category];
          input.onTailUnproven?.(category, example);
          unproven.rows += 1;
          if (unproven.examples.length < MAX_EXAMPLES) unproven.examples.push(example);
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
        // Counts and ids only — never a value, never a key's hash.
        categories,
        tailUnproven: tailUnprovenCounts,
        liveApiKeys,
      },
    }),
  );
  if (failure !== undefined) throw new RawSecretScrubFailedError(failure, result(audit.id));
  return result(audit.id);
}
