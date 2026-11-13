/**
 * Every fixed Postgres advisory-lock key the kernel takes, in one place (STATUS legacy 565), so a
 * new lock cannot quietly take a number another one already holds. `advisory-lock-namespaces.test.ts`
 * scans `src/` and `migrations/` for literal keys and fails on one missing here or on two names
 * sharing a number.
 *
 * Postgres keeps three key spaces that never meet:
 *
 *  1. **One key, text** — `pg_advisory_xact_lock(hashtext('<prefix>:' || ...))`. `hashtext`
 *     returns an int4, so these sit in [-2^31, 2^31). Their uniqueness is the text prefix each
 *     call site writes (`task:...`, `goal:...`); they are not listed here.
 *  2. **One key, fixed bigint** — `ADVISORY_LOCK_KEYS`. Every value is above 2^31, so no `hashtext`
 *     lock can take it. `72410` and five digits: `00001` the migration runner, `00M01` the
 *     bootstrap key of migration module M (the convention `migrations/core/0001_identity.sql`'s
 *     header describes; migration SQL repeats the number because it cannot import this file),
 *     `1NNNN` runtime locks.
 *  3. **Two keys** — `pg_advisory_xact_lock(<class id>, <int4>)`, `ADVISORY_LOCK_NAMESPACES`. The
 *     first key names the class of lock, the second the instance (usually a `hashtext` of its
 *     scope). Postgres records them apart from one-key locks (`pg_locks.objsubid` 2 vs 1), so a
 *     class id may equal a one-key value without meeting it; the ids still stay distinct from
 *     each other, and seven digits (`72410NN`) of their own so a reader does not confuse them.
 *
 * A new lock takes the next free number in its space here first, then uses it.
 */

/** Space 2: one fixed bigint per lock. */
export const ADVISORY_LOCK_KEYS = {
  /** `adapters/db/migrate.ts`: session lock around a whole migration run. */
  migrationRun: 7241000001,
  /** First statement of every `migrations/core/` file. */
  migrationsCore: 7241000101,
  /** First statement of every `migrations/governance/` file. */
  migrationsGovernance: 7241000201,
  /** First statement of every `migrations/llm-usage/` file. */
  migrationsLlmUsage: 7241000301,
  /** First statement of every `migrations/task/` file. */
  migrationsTask: 7241000401,
  /** First statement of every `migrations/worker/` file. */
  migrationsWorker: 7241000501,
  /** First statement of every `migrations/linkage/` file. */
  migrationsLinkage: 7241000601,
  /** First statement of every `migrations/goal/` file. */
  migrationsGoal: 7241000701,
  /** `application/platform/compact-observations.ts`: one compaction window at a time. */
  observationCompaction: 7241010301,
} as const;

/** Space 3: the class id (first key) of each two-key lock. */
export const ADVISORY_LOCK_NAMESPACES = {
  /**
   * `governance/0031_action_request_execution_guard.sql` (`action_request_execution_lock`): every
   * start of an ActionRequest on one Gatekeeper; second key `hashtext(workspace_id || ':' ||
   * gatekeeper_id)`. Serializes starts per Gatekeeper so the guard sees every earlier start.
   */
  actionRequestExecution: 7241031,
  /**
   * `application/change-plan/admin-proposals.ts` (`proposeAdminProposal`, S11 AA3b F11): every proposal
   * by one platform user; second key `hashtext(user_id)`. Taken before counting the user's proposals
   * of the day (`admin_proposals_proposed_today()`, governance/0032), so two proposals at the limit
   * cannot both pass — they may come from different trial workspaces.
   */
  adminProposalQuota: 7241032,
  /**
   * `application/change-plan/proposal-dependency.ts` and governance/0035 (S11 AA3c-2 F-c4): an admin
   * proposal's workspace segments depending on its platform segment; second key
   * `hashtext(proposal_id::text)`. Applying a workspace segment takes it shared, rolling back the
   * platform change segment its platform segment recorded takes it exclusive — each before any row
   * lock, and 0035's triggers again before they check — so a workspace segment is never applied
   * while that rollback commits, nor the other way round.
   */
  adminProposalDependency: 7241033,
  /**
   * governance/0043 (legacy 702): one authority a Handle is issued under — a workspace, a platform
   * user or a Principal; second key `authority_lock_instance(kind, id)` = `hashtext(kind || ':' ||
   * id)`. Every issuer takes the three it issues under shared (`lock_issuing_authority`, from
   * `issueHandle`), every change of one takes it exclusive (0043's BEFORE UPDATE triggers, and
   * `lock_authorities` for a writer that changes several) — in the order workspace, user,
   * Principal, each before any row lock it relates to.
   */
  authority: 7241034,
} as const;
