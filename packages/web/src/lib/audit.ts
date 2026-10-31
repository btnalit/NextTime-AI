import { CAPABILITY_REGISTRY, capabilityHasSideEffects, getCapability } from '@nexttime/shared';
import type { ExplainResultWire } from '@nexttime/shared';
import type {
  ProvenanceActivity,
  ProvenanceFact,
  ProvenanceSource,
} from '../components/ui/ProvenanceChain.js';
import { hrefs } from './router.js';

/**
 * lib/audit: the audit page's pure helpers (S6-A A4 / C27 — docs/console-completion-plan.md §5.5
 * "审计：上下文关联"). Entry points (`auditHref` / `auditEntryFromHash`), the resource-type and
 * action vocabularies the filter selectors offer, the `explain` → `ProvenanceChain` mapping, and
 * the client-side JSON download. No React, no capability calls — `components/AuditPage.tsx` does
 * the calling and the rendering.
 */

/** What a link into the audit page pre-fills and auto-runs (§5.5 "跳到审计页并预填 id、自动执行").
 *  `nodeId` → `explain`; `resourceType`/`resourceId`/`actorPrincipalId`/`action` → `audit_query`
 *  filter; `actionRequestId` → the approval context (`get_action`, then its decision's `explain`
 *  and the `action_request` audit rows). All optional; an empty entry is the plain page. */
export interface AuditEntry {
  readonly nodeId?: string;
  readonly resourceType?: string;
  readonly resourceId?: string;
  readonly actorPrincipalId?: string;
  readonly action?: string;
  readonly actionRequestId?: string;
}

const ENTRY_KEYS = [
  'nodeId',
  'resourceType',
  'resourceId',
  'actorPrincipalId',
  'action',
  'actionRequestId',
] as const satisfies readonly (keyof AuditEntry)[];

/** `#/govern/audit?nodeId=…` — the audit page's deep link. The route itself is `hrefs.audit()`
 *  (lib/router.ts); this appends the entry as a query string on the hash. NOTE: `routeFromHash`
 *  matches `#/govern/audit` exactly today — the router needs to accept the `?…` suffix for these
 *  links to land on the page (reported to the integrator; the page itself reads the entry from
 *  either a prop or the hash, `auditEntryFromHash`). */
export function auditHref(entry: AuditEntry): string {
  const params = new URLSearchParams();
  for (const key of ENTRY_KEYS) {
    const value = entry[key];
    if (value !== undefined && value !== '') params.set(key, value);
  }
  const query = params.toString();
  return query === '' ? hrefs.audit() : `${hrefs.audit()}?${query}`;
}

/** Inverse of `auditHref`: the entry carried by a `#/govern/audit?…` hash (empty for any other
 *  hash, including the bare route). */
export function auditEntryFromHash(hash: string): AuditEntry {
  const base = hrefs.audit();
  if (!hash.startsWith(base)) return {};
  const rest = hash.slice(base.length);
  if (!rest.startsWith('?')) return {};
  const params = new URLSearchParams(rest.slice(1));
  const entry: { -readonly [K in keyof AuditEntry]: AuditEntry[K] } = {};
  for (const key of ENTRY_KEYS) {
    const value = params.get(key);
    if (value !== null && value !== '') entry[key] = value;
  }
  return entry;
}

export function isEmptyEntry(entry: AuditEntry): boolean {
  return ENTRY_KEYS.every((key) => entry[key] === undefined);
}

/**
 * The `resourceType` values the kernel actually writes on workspace audit rows (every
 * `resourceType: '…'` literal under `packages/kernel/src/{application,governance,substrate}` as
 * of S6-A — `writeAudit` callers and the capability handlers' `resourceType` results). Offered
 * as a `<select>` on the audit page; the kernel does not publish this as an enum, so an unknown
 * value still works through the filter's free-text path. Legacy sweep (console batch,
 * 2026-10-16): `gate_instance` (`gate-instance-handlers.ts`) and `module`
 * (`platform-modules-handlers.ts`) are written on workspace rows too; S11 P1: `change_item`
 * (`application/change-plan`); P1-B: `change_segment` (`roll_back_change_segment`); S11 GO6: `goal_run`,
 * `plan_revision`, `step_run` (`application/goal`, written since GO1); S10 E3-1a: `eval_suite`
 * (`eval-handlers.ts`); E3-1b: `eval_case` (`get_eval_case`); E3-2a: `eval_run` (a run's start
 * and reads, and each trial's end); E3-2b: `draft_evaluation` (its start, stages, verdict, reads
 * and cancel); E3-2c: `eval_seal_hold` (a pause's opening and release).
 */
export const AUDIT_RESOURCE_TYPES = [
  'action_request',
  'activity',
  'agent_policy',
  'agent_profile',
  'capability_grant',
  'change_item',
  'change_segment',
  'chat',
  'conflict',
  'connection_request',
  'decision',
  'draft_evaluation',
  'eval_case',
  'eval_run',
  'eval_seal_hold',
  'eval_suite',
  'fact',
  'gate_instance',
  'gatekeeper',
  'goal_run',
  'module',
  'object',
  'ontology_type',
  'ontology_version',
  'operation',
  'plan_revision',
  'policy',
  'principal',
  'procedure',
  'quota',
  'session',
  'skill',
  'source',
  'step_run',
  'task',
  'worker_definition',
  'worker_run',
  'workspace',
] as const;
export type AuditResourceType = (typeof AUDIT_RESOURCE_TYPES)[number];

/**
 * Legacy sweep (console batch, 2026-10-16): the `resourceType` values only the platform audit
 * stream carries (`workspaceId: null` rows — user and connector administration, platform
 * settings, the LLM provider / admin-token events, `cli.*` maintenance). Not offered on the
 * workspace page's `<select>`; `lib/labels.ts` labels them so the platform audit list never
 * shows the raw value. A type both streams write (`gate_instance`, `workspace`, …) stays in
 * `AUDIT_RESOURCE_TYPES` above.
 */
export const PLATFORM_AUDIT_RESOURCE_TYPES = [
  'connector',
  'llm_admin_token',
  'llm_provider',
  'observations',
  'platform',
  'platform_settings',
  'user',
] as const;
export type PlatformAuditResourceType = (typeof PLATFORM_AUDIT_RESOURCE_TYPES)[number];

/**
 * Lifecycle audit actions the kernel writes *outside* a capability dispatch (which audits under
 * the capability's own name — `application/gateway/dispatch.ts` `action: name`): the state-
 * machine transitions of ActionRequest / Task / WorkerRun (`governance/approval/transition-log`,
 * `application/task/transition-log.ts`), the S6-A chat / connection actions and S11 P1's
 * `change_item.apply` / P1-B's `change_item.roll_back` (one row per ChangePlan item,
 * `application/change-plan`) and P1-E's `change_segment.verify` (one row per verification, also
 * the one an install runs right after it commits). Suggestions only —
 * the action filter is free text.
 */
export const AUDIT_LIFECYCLE_ACTIONS = [
  'action_request.request',
  'action_request.approve',
  'action_request.reject',
  'action_request.start_execution',
  'action_request.outcome_in_doubt',
  'action_request.complete',
  'action_request.fail',
  'action_request.compensate',
  'action_request.expire',
  'action_request.withdraw',
  'task.queue',
  'task.start',
  'task.await_approval',
  'task.resume',
  'task.complete',
  'task.fail',
  'task.cancel',
  'task.result_fact_rejected',
  'task.result_proposal_rejected',
  'worker_run.provision',
  'worker_run.start',
  'worker_run.terminate',
  'worker_run.spawn_failed',
  'chat.archive',
  'chat.unarchive',
  'chat.rename',
  'connection.request_cancelled',
  'facts_not_reobserved',
  'ontology_violation',
  'change_item.apply',
  'change_item.roll_back',
  'change_segment.verify',
  // S11 GO1–GO5 (legacy 366): a goal's lifecycle (`application/goal/moves.ts` `goal_run.<event>` /
  // `step_run.<event>`, `control.ts`, `revise.ts`, `service.ts`, the advancer and the acceptance
  // and reconcile checks), and the budget a goal step's Task takes from its parent.
  'goal_run.propose',
  'goal_run.confirm',
  'goal_run.reject',
  'goal_run.pause',
  'goal_run.hold',
  'goal_run.release_hold',
  'goal_run.resume',
  'goal_run.revise',
  'goal_run.verify',
  'goal_run.complete',
  'goal_run.fail',
  'goal_run.cancel',
  'goal_run.finish_cancel',
  'goal_run.cleanup_finished',
  'goal_run.pause_noted',
  'goal_run.advance_failing',
  'goal_run.acceptance_round',
  'goal_run.acceptance_check',
  'goal_run.step_acceptance_round',
  'goal_run.step_acceptance_check',
  'goal_run.absence_baseline',
  'step_run.create',
  'step_run.unblock',
  'step_run.start',
  'step_run.wait',
  'step_run.resume',
  'step_run.succeed',
  'step_run.fail',
  'step_run.retry',
  'step_run.supersede',
  'step_run.cancel',
  'step_run.skip',
  'plan_revision.accept',
  'plan_revision.reject',
  // S11 GO8b: a person approving one trial of a step's draft Skills (`trial-approvals.ts`).
  'step_trial.approve',
  'task.budget_handed_down',
  'action_request.release',
  'action_request.reconcile',
  'action_request.reexecute',
  'action_request.reconcile_check',
  // Legacy 245 a: workspace actions the kernel writes outside a dispatch that already had a label
  // (`capability-labels.ts`) but were missing here — a gate's governance and definition changes,
  // the draft reaper, and the one-off rows migrations write.
  'operation.description_updated',
  'operation.governance_refreshed',
  'operation.revision_drafted',
  'gatekeeper.self_connection_linked',
  'draft.expired',
  'agent_profile.lists_reset_to_follow_grants',
  'policy.auto_approve_rescoped',
  'agent_policy.auto_approve_low_default_applied',
  'principal.auditor_handles_revoked',
  'principal.container_handles_revoked',
  // S10 E3-1c: evaluation content stopped on its way to an agent (`application/eval-seal`).
  'evaluation.content_withheld',
  // S10 E3-2a: an evaluation trial's fixture call (`application/eval-session`) and its end
  // (`application/eval` runner).
  'evaluation.fixture_call',
  'evaluation.trial_end',
  // S10 E3-2b: a draft evaluation's stages and verdict (`application/eval` draft-evaluations).
  'evaluation.draft_stage',
  'evaluation.draft_verdict',
  // S10 E3-2c: the seal's pause of a Principal's agents, and what it refused
  // (`application/eval-seal` hold.ts).
  'evaluation.seal_hold_opened',
  'evaluation.seal_hold_refused',
] as const;

/**
 * S8 W4-A (ui-audit S11/PA1 — "审计流默认只显示写与决策，读另设筛选"): whether `action` is a pure
 * read — a registry capability with no side effects (`capabilityHasSideEffects`, the explicit flag
 * of review 2026-10-02 D-08: `audit_query`/`explain`/`list_*`/`search`/… itself, every read a
 * dispatched capability call audits under its own name). Not `mode === 'observe'`: an observe
 * call that writes — `observe_operation` recording the Facts a gate returned, `get_entry_context`
 * leasing context items — is a write the default view must keep showing (P3 L5-10). An action the
 * registry does not recognise (every lifecycle-transition action in `AUDIT_LIFECYCLE_ACTIONS` —
 * `action_request.approve`, `task.complete`, …, none of which is a capability name) is never
 * treated as a read: those rows are exactly the "写与决策" the default view exists to keep
 * visible, so an unrecognised action fails open (shown), not hidden.
 */
export function isReadAuditAction(action: string): boolean {
  const capability = getCapability(action);
  return capability !== undefined && !capabilityHasSideEffects(capability);
}

/** Every workspace-scope capability name from `CAPABILITY_REGISTRY` (a dispatched call is
 *  audited under its own name) plus the lifecycle actions above, deduplicated and sorted — the
 *  action selector's suggestion list (§5.5 "action 用能力注册表做选择器"). */
export function auditActionSuggestions(): readonly string[] {
  const names = new Set<string>(AUDIT_LIFECYCLE_ACTIONS);
  for (const capability of CAPABILITY_REGISTRY) {
    if (capability.scope !== 'platform') names.add(capability.name);
  }
  return [...names].sort();
}

/** The `audit_query` filter the page sends — only the keys the kernel reads
 *  (`{actorPrincipalId?, action?, resourceType?, resourceId?}`), blanks dropped. */
export interface AuditFilter {
  readonly actorPrincipalId?: string;
  readonly action?: string;
  readonly resourceType?: string;
  readonly resourceId?: string;
}

export function auditFilterFromEntry(entry: AuditEntry): AuditFilter {
  const filter: { -readonly [K in keyof AuditFilter]: AuditFilter[K] } = {};
  if (entry.actorPrincipalId) filter.actorPrincipalId = entry.actorPrincipalId;
  if (entry.action) filter.action = entry.action;
  if (entry.resourceType) filter.resourceType = entry.resourceType;
  if (entry.resourceId) filter.resourceId = entry.resourceId;
  if (entry.actionRequestId && !entry.resourceId) {
    filter.resourceType = 'action_request';
    filter.resourceId = entry.actionRequestId;
  }
  return filter;
}

export function isEmptyFilter(filter: AuditFilter): boolean {
  return (
    filter.actorPrincipalId === undefined &&
    filter.action === undefined &&
    filter.resourceType === undefined &&
    filter.resourceId === undefined
  );
}

/** `audit_query` row (`AuditRecordWireSchema`, packages/shared/src/wire/graph.ts). */
export interface AuditRecordRow {
  readonly id: string;
  readonly actorPrincipalId: string;
  readonly action: string;
  readonly resourceType: string | null;
  readonly resourceId: string | null;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}

/** An audit row's `payload` — `resourceHref` reads a `change_item`'s `segmentId` from it. */
type AuditPayload = Readonly<Record<string, unknown>>;

/** The console route an audit row's `resourceType:resourceId` opens, when the console has a page
 *  for that resource and the reader may open it (`canOpen`, `hooks/useCanOpen` — the route table;
 *  an auditor may not open an ActionRequest, #541 acceptance); `undefined` otherwise (the chip
 *  stays a plain reference). */
export function resourceHref(
  resourceType: string | null,
  resourceId: string | null,
  canOpen: (href: string) => boolean | null = () => true,
  payload?: AuditPayload,
): string | undefined {
  const href = resourceRoute(resourceType, resourceId, payload);
  return href !== undefined && canOpen(href) !== false ? href : undefined;
}

function resourceRoute(
  resourceType: string | null,
  resourceId: string | null,
  payload: AuditPayload | undefined,
): string | undefined {
  if (!resourceId) return undefined;
  switch (resourceType) {
    // S11 P1-B: an install record opens in 能力目录 · 安装历史; one of its changes opens the record
    // it belongs to (the row's payload names it).
    case 'change_segment':
      return hrefs.catalog('changes', resourceId);
    case 'change_item': {
      const segmentId = payload ? stringField(payload, 'segmentId') : undefined;
      return segmentId ? hrefs.catalog('changes', segmentId) : undefined;
    }
    case 'action_request':
      return hrefs.approval(resourceId);
    case 'task':
      return hrefs.task(resourceId);
    case 'chat':
      return hrefs.chat(resourceId);
    case 'gatekeeper':
      return hrefs.gatekeeper(resourceId);
    // S10 E3-1b: a suite, or one of its cases or runs (the row's payload names the suite), opens
    // the suite.
    case 'eval_suite':
      return hrefs.evaluation('suites', resourceId);
    case 'eval_case':
    case 'eval_run': {
      const suiteId = payload ? stringField(payload, 'suiteId') : undefined;
      return suiteId ? hrefs.evaluation('suites', suiteId) : undefined;
    }
    // S10 E3-2b: a draft evaluation opens in 评测 · 草稿评测.
    case 'draft_evaluation':
      return hrefs.evaluation('drafts', resourceId);
    // S10 E3-2c: the seal's pauses are listed on the evaluation page, above its tabs.
    case 'eval_seal_hold':
      return hrefs.evaluation();
    default:
      return undefined;
  }
}

/** What `ProvenanceChain` renders from one `explain` result — the three segments it takes, plus
 *  the pieces it does not (the Decision, and the Activity's `metadata` links: `taskId` /
 *  `workerRunId` / `actionRequestId`, the "→ WorkerRun" hop of §5.5's acceptance chain). */
export interface ExplainView {
  readonly nodeType: ExplainResultWire['nodeType'];
  readonly fact: ProvenanceFact | null;
  readonly activity: ProvenanceActivity | null;
  readonly source: ProvenanceSource | null;
  readonly decision: NonNullable<ExplainResultWire['decision']> | null;
  readonly links: {
    readonly taskId?: string;
    readonly workerRunId?: string;
    readonly actionRequestId?: string;
    readonly onBehalfOf?: string;
  };
}

function stringField(record: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** Maps the kernel's `ExplainResultWire` (packages/shared/src/wire/graph.ts) onto
 *  `ProvenanceChain`'s narrower props. The Fact's own Source comes through `lastObservation`
 *  (the chain resolves it itself); a Decision root contributes its `source`; an Activity root
 *  contributes the first Observation's Source. Tolerant of an older kernel's shape — every
 *  segment is optional in the chain. */
export function explainView(result: ExplainResultWire): ExplainView {
  const activity = result.activity ?? null;
  const metadata = activity?.metadata ?? {};
  const fact = result.fact
    ? {
        id: result.fact.id,
        linkType: result.fact.linkType,
        epistemicStatus: result.fact.epistemicStatus,
        assertedByPrincipal: result.fact.assertedByPrincipal,
        verifiedByPrincipal: result.fact.verifiedByPrincipal,
        invalidatedAt: result.fact.invalidatedAt,
        invalidationReason: result.fact.invalidationReason,
        lastObservation: result.fact.lastObservation,
        // Leftover 89: the Fact's human attestations (`?? []` — an older kernel has none).
        humanAttestations: result.fact.humanAttestations ?? [],
      }
    : null;
  const source =
    result.decision?.source ??
    result.fact?.lastObservation?.source ??
    activity?.observations[0]?.source ??
    null;
  return {
    nodeType: result.nodeType,
    fact,
    activity: activity
      ? {
          id: activity.id,
          kind: activity.kind,
          status: activity.status,
          createdAt: activity.createdAt,
          endedAt: activity.endedAt,
          startedByPrincipal: activity.startedByPrincipal,
          onBehalfOfPrincipal: activity.onBehalfOfPrincipal,
        }
      : null,
    source,
    decision: result.decision ?? null,
    links: {
      taskId: stringField(metadata, 'taskId'),
      workerRunId: stringField(metadata, 'workerRunId'),
      actionRequestId: stringField(metadata, 'actionRequestId'),
      onBehalfOf: stringField(metadata, 'onBehalfOf'),
    },
  };
}

/** A safe file name from an id or filter for the JSON downloads. */
export function downloadName(prefix: string, key: string): string {
  const safe = key
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `${prefix}${safe ? `-${safe}` : ''}.json`;
}

/**
 * Client-side JSON download: a `Blob` behind `URL.createObjectURL` clicked through a temporary
 * `<a download>` (works under the strict CSP of C21 — a blob download is not a resource load).
 * The object URL is revoked once the click has been dispatched. Returns `false` where the API is
 * missing (older jsdom) — callers keep the payload on screen too, so nothing is lost.
 */
export function downloadJson(filename: string, value: unknown): boolean {
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return false;
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  if (typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(url);
  return true;
}
