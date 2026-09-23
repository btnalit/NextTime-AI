import type { PoolClient } from 'pg';
import type { GraphObject } from './store.js';

/**
 * substrate/graph/find-means: `find_operations` / `find_workers` / `find_procedures`'s pure graph
 * half (design doc §5.1.2 "入口 agent 找手段 = 一次 traverse（find_operations / find_workers /
 * find_procedures）", §8.4 "手段发现", §9.3 "find_* 与调用者 Grant 取交集"; docs/development-tasks.md
 * S2.7 "one traversal over the meta-ontology objects (published only) ... intersected with what
 * the caller may use").
 *
 * **Layering note (why this file never touches Grants):** substrate may depend only on the domain
 * layer (`.dependency-cruiser.cjs` `kernel-substrate-may-only-depend-on-domain`) — it cannot import
 * `governance/capability`'s `hasActiveGrant`/Handle-scope logic. The "intersected with the
 * caller's Grant" half of `find_*` is therefore the *handler's* job
 * (`application/gateway/handlers.ts`'s `findOperationsHandler`/`findWorkersHandler`/
 * `findProceduresHandler`, which may import both this module and `governance/capability`): this
 * file returns *candidates* (every matching, already-published meta-ontology Object — see below
 * for why no extra "published" filter is needed here), and the handler narrows that list to what
 * the caller may actually use.
 *
 * **"published only" is free for `WorkerDefinition` and `Procedure`, not for `Operation` (S2.13
 * correction of this file's own earlier claim):** every `WorkerDefinition` Object this file can
 * find was written by a *publish*-time projection (`substrate/ontology/meta-objects.ts`'s
 * `projectWorkerDefinitionObject`, called only from `application/worker/definitions.ts`'s
 * `publishWorkerDefinition` — never from `propose`), so a `WorkerDefinition` row in `objects` is
 * non-draft by construction (the same invariant `application/gateway/meta-ontology-guard.ts`'s own
 * doc comment relies on for I16) — no extra filter needed for that one type. `Procedure` (S2.14)
 * follows the identical shape: `projectProcedureObject` is called only from `application/worker/
 * procedures.ts`'s `publishProcedure`, never from `proposeProcedure`, and writes no `status`
 * property at all (`{name, description}` only) — a filter on `properties ->> 'status'` here would
 * therefore incorrectly exclude *every* Procedure, published or not (this was a real bug in an
 * earlier version of this file, caught by find-procedures.integration.test.ts once S2.14 landed
 * real Procedure fixtures to run it against). `Operation` turned out *not* to follow either shape
 * once S2.4 actually landed it: `registerOperationDraftObject` upserts the Object at
 * **import/propose** time, `status: 'draft'` in `properties`, and `setOperationStatusObject` only
 * flips that same row's `properties.status` in place — so a draft Operation is already sitting in
 * `objects` the moment it is imported, long before anyone publishes it. Returning it here would
 * violate I16/I17 ("未发布的清单对 agent 不可见" — docs/development-tasks.md S2.13 acceptance) the
 * first time a manifest is imported. This function therefore adds an explicit
 * `properties ->> 'status' = 'published'` filter for `Operation` only — never for
 * `WorkerDefinition`/`Procedure`, whose Objects carry no `status` property at all (adding the
 * filter there would silently return zero rows for every published one, not narrow correctly).
 *
 * **Tokenised keyword matching (S8 W2-K1, leftover 71 / audit B3 — "find_* 用 need 做子串 ILIKE，
 * 自然语言需求几乎不可能命中"):** `need` used to be ILIKE'd as one whole substring against the
 * entire `properties` blob — a multi-word natural-language need (English or Chinese) almost never
 * appears verbatim inside a `name`/`description`, so this almost always missed. `tokenizeNeed`
 * (below) splits `need` into keywords; `buildFindMeansQuery` matches *any* token against `name`,
 * `description` (and, for `Operation` only, `mode` and its Gatekeeper's own `name` — "operation
 * kind/gate name where available"), ranked by how many *distinct* tokens hit (not one combined
 * substring), ties broken by `updated_at desc`. This is a deliberate narrowing from the old
 * whole-`properties::text` search to just these named fields — a token that used to coincidentally
 * match some other property (e.g. a raw binding path) no longer does; every real field this
 * project's own manifests/console populate for discovery (name, description, mode, gate name) is
 * still covered. An empty/blank `need` still matches every candidate (S2.7's own "list everything
 * of this kind" default), bounded by `limit`.
 *
 * **Why bigrams for CJK, not just whole runs:** Chinese has no whitespace between words, so a
 * `need` like "重启容器" (“restart the container”) tokenises as one 4-character run with no
 * segmenter available (no new dependency — see this task's own scope note). Matching only the
 * whole run against a description like "重启一个容器" ("restarts a container") — which contains
 * "重启" and "容器" but not the contiguous "重启容器" — would still miss, reproducing B3's exact
 * complaint for the very audience ("中文为主") this fix targets. `tokenizeNeed` additionally emits
 * every 2-character sliding-window substring of a CJK run of length ≥ 2 ("重启容器" → "重启", "启容",
 * "容器" on top of the whole run) — each is matched (and ranked) as its own token, so "重启" and
 * "容器" both hit "重启一个描述里有容器的描述" even though the 4-character run as a whole does not.
 * A single CJK character is kept as its own one-character token (no shorter substring to add). Not
 * full segmentation — a cheap, no-dependency approximation good enough to fix the reported miss;
 * `MAX_FIND_MEANS_TOKENS` caps the total so a long pasted paragraph never blows out the query's
 * parameter list.
 *
 * **"one traversal" is a text search, not a graph walk, and that is deliberate for S2.7's actual
 * data shape:** a real `traverse` (`substrate/graph/store.ts`) walks Links outward from one
 * anchor Object — but "find something matching a free-text need" has no anchor to start from; the
 * anchor *is* the search itself. Once S2.4/S2.14 project real `exposes`/`can_act_on`/`steps` Links
 * (design doc §5.1.2) between these Objects, a genuine `traverse`-based `find_*` (e.g. "operations
 * reachable from Gatekeepers the caller can act on") can be layered on top of these same candidate
 * queries without changing this file's public shape.
 */

export interface FindMeansInput {
  readonly need: string;
  readonly limit?: number;
}

export const DEFAULT_FIND_MEANS_LIMIT = 20;

/** Hard cap on the number of keyword tokens one `need` can expand into (bigrams included) — bounds
 *  the generated SQL's parameter count against a long pasted paragraph; far above any real need. */
export const MAX_FIND_MEANS_TOKENS = 32;

const OBJECT_COLUMNS =
  'workspace_id, id, object_type, identity_key, properties, created_at, updated_at, last_observed_at';

interface ObjectRow {
  workspace_id: string;
  id: string;
  object_type: string;
  identity_key: Record<string, unknown> | null;
  properties: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
  last_observed_at: Date | null;
}

function mapObjectRow(row: ObjectRow): GraphObject {
  return {
    workspaceId: row.workspace_id,
    id: row.id,
    objectType: row.object_type,
    identityKey: row.identity_key,
    properties: row.properties,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastObservedAt: row.last_observed_at,
  };
}

// -------------------------------------------------------------------------------------------
// tokenizeNeed — pure, no IO. See this file's own module doc comment for the bigram rationale.
// -------------------------------------------------------------------------------------------

/** Any character from the CJK ideograph, Hiragana/Katakana, CJK compatibility, or Hangul syllable
 *  blocks — "CJK-ish" in the same deliberately-broad sense this project's other Chinese-first UI
 *  text guards use, not a strict Unicode-script boundary. */
const CJK_CHAR_PATTERN = /[぀-ヿ㐀-䶿一-鿿가-힯豈-﫿]/u;

/** A maximal run of CJK-ish characters, or a maximal run of Unicode letters/numbers (covers
 *  accented Latin, digits, etc.) — everything else (whitespace, ASCII/CJK punctuation) is a
 *  separator and never appears in a token. */
const TOKEN_SPAN_PATTERN = /[぀-ヿ㐀-䶿一-鿿가-힯豈-﫿]+|[\p{L}\p{N}]+/gu;

/**
 * Splits `need` into keyword tokens for `buildFindMeansQuery` — see this file's own module doc
 * comment for the full rationale. A non-CJK span becomes one lower-cased token (ILIKE is already
 * case-insensitive at the DB level; lower-casing here only affects de-duplication). A CJK span
 * becomes the whole span as one token, plus every 2-character sliding-window substring when the
 * span is at least 2 characters long (a 1-character span has no shorter substring to add).
 * Duplicate tokens are dropped, first-seen order kept, and the result is capped at
 * `MAX_FIND_MEANS_TOKENS`. An empty/blank `need` returns `[]` (the caller's "match everything"
 * case — see `buildFindMeansQuery`).
 */
export function tokenizeNeed(need: string): readonly string[] {
  const trimmed = need.trim();
  if (trimmed.length === 0) return [];

  const tokens: string[] = [];
  const seen = new Set<string>();
  const push = (token: string): void => {
    if (token.length === 0 || seen.has(token)) return;
    seen.add(token);
    tokens.push(token);
  };

  for (const match of trimmed.matchAll(TOKEN_SPAN_PATTERN)) {
    const span = match[0];
    if (CJK_CHAR_PATTERN.test(span[0] ?? '')) {
      push(span);
      for (let i = 0; i + 2 <= span.length; i += 1) {
        push(span.slice(i, i + 2));
      }
    } else {
      push(span.toLowerCase());
    }
  }

  return tokens.slice(0, MAX_FIND_MEANS_TOKENS);
}

// -------------------------------------------------------------------------------------------
// buildFindMeansQuery — pure SQL-text-and-parameter builder (same "no IO, unit-testable"
// convention `substrate/graph/queries.ts` already establishes for the rest of this layer).
// -------------------------------------------------------------------------------------------

export interface SqlQuery {
  readonly text: string;
  readonly values: readonly unknown[];
}

type FindMeansObjectType = 'WorkerDefinition' | 'Operation' | 'Procedure';

/** The `properties ->> '<key>'` fields each object type's tokens are matched against. Every type
 *  gets `name`/`description`; `Operation` additionally gets `mode` ("operation kind" — observe vs
 *  execute) — its Gatekeeper's own `name` ("gate name") is matched separately below via a
 *  correlated `exists` (it lives on a different Object, not in these properties). */
const NAME_DESCRIPTION_FIELDS = ["properties ->> 'name'", "properties ->> 'description'"] as const;
const OPERATION_EXTRA_FIELDS = ["properties ->> 'mode'"] as const;

/**
 * Builds the parameterised SQL for `findMetaOntologyObjects` below: every candidate `objectType`
 * Object where *any* token in `tokens` matches `name`, `description` (Operation also: `mode`, and
 * its Gatekeeper's own `name` via a correlated `exists`), ranked by the count of *distinct* tokens
 * that matched (§ this file's own module doc comment), ties broken by `updated_at desc`. `tokens`
 * empty (blank `need`) matches every candidate of this type — `where` degrades to `true` and the
 * rank expression to the constant `0` (every row ties on rank, so `updated_at desc` alone orders
 * them — "list everything, most recent first"). `Operation` alone gets the `properties ->>
 * 'status' = 'published'` filter (I16/I17 — see this file's own module doc comment for why it
 * would be *wrong* to apply to `WorkerDefinition`/`Procedure`).
 */
export function buildFindMeansQuery(
  objectType: FindMeansObjectType,
  workspaceId: string,
  tokens: readonly string[],
  limit: number,
): SqlQuery {
  const values: unknown[] = [workspaceId, objectType];
  const fields: readonly string[] =
    objectType === 'Operation'
      ? [...NAME_DESCRIPTION_FIELDS, ...OPERATION_EXTRA_FIELDS]
      : NAME_DESCRIPTION_FIELDS;

  const tokenClauses: string[] = [];
  const rankTerms: string[] = [];
  for (const token of tokens) {
    values.push(`%${token}%`);
    const p = values.length;
    const checks = fields.map((field) => `${field} ilike $${p}`);
    if (objectType === 'Operation') {
      checks.push(
        `exists (
           select 1 from objects gk
           where gk.workspace_id = objects.workspace_id
             and gk.object_type = 'Gatekeeper'
             and gk.id = (objects.identity_key ->> 'gatekeeperId')
             and gk.properties ->> 'name' ilike $${p}
         )`,
      );
    }
    const clause = `(${checks.join(' or ')})`;
    tokenClauses.push(clause);
    rankTerms.push(`case when ${clause} then 1 else 0 end`);
  }

  const whereMatch = tokenClauses.length > 0 ? `(${tokenClauses.join(' or ')})` : 'true';
  const rankExpr = rankTerms.length > 0 ? rankTerms.join(' + ') : '0';

  const publishedOnly = objectType === 'Operation';
  values.push(publishedOnly);
  const publishedParam = values.length;
  values.push(limit);
  const limitParam = values.length;

  const text = `select ${OBJECT_COLUMNS}
     from objects
     where workspace_id = $1
       and object_type = $2
       and ${whereMatch}
       and (not $${publishedParam}::boolean or properties ->> 'status' = 'published')
     order by (${rankExpr}) desc, updated_at desc
     limit $${limitParam}`;

  return { text, values };
}

async function findMetaOntologyObjects(
  client: PoolClient,
  workspaceId: string,
  objectType: FindMeansObjectType,
  input: FindMeansInput,
): Promise<readonly GraphObject[]> {
  const tokens = tokenizeNeed(input.need);
  const limit = input.limit ?? DEFAULT_FIND_MEANS_LIMIT;
  const query = buildFindMeansQuery(objectType, workspaceId, tokens, limit);
  const result = await client.query<ObjectRow>(query.text, [...query.values]);
  return result.rows.map(mapObjectRow);
}

/** Candidates for `find_operations` — `Gatekeeper --exposes--> Operation` (design doc §5.1.2),
 *  published only (I16/I17 — see `findMetaOntologyObjects`'s own doc comment above). */
export function findOperationCandidates(
  client: PoolClient,
  workspaceId: string,
  input: FindMeansInput,
): Promise<readonly GraphObject[]> {
  return findMetaOntologyObjects(client, workspaceId, 'Operation', input);
}

/** Candidates for `find_workers` — every published `WorkerDefinition@version` (design doc §5.1.4)
 *  matching `need`. */
export function findWorkerDefinitionCandidates(
  client: PoolClient,
  workspaceId: string,
  input: FindMeansInput,
): Promise<readonly GraphObject[]> {
  return findMetaOntologyObjects(client, workspaceId, 'WorkerDefinition', input);
}

/** Candidates for `find_procedures` — `Procedure --steps--> Operation | WorkerDefinition` (design
 *  doc §5.1.2), published only for free (S2.14's `projectProcedureObject` is publish-time-only,
 *  same shape as `WorkerDefinition` — see `findMetaOntologyObjects`'s own doc comment above). */
export function findProcedureCandidates(
  client: PoolClient,
  workspaceId: string,
  input: FindMeansInput,
): Promise<readonly GraphObject[]> {
  return findMetaOntologyObjects(client, workspaceId, 'Procedure', input);
}
