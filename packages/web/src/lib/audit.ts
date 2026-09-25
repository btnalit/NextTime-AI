import { CAPABILITY_REGISTRY, getCapability } from '@nexttime/shared';
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
 * value still works through the filter's free-text path.
 */
export const AUDIT_RESOURCE_TYPES = [
  'action_request',
  'activity',
  'agent_policy',
  'agent_profile',
  'capability_grant',
  'chat',
  'conflict',
  'connection_request',
  'decision',
  'fact',
  'gatekeeper',
  'object',
  'ontology_type',
  'ontology_version',
  'operation',
  'policy',
  'principal',
  'procedure',
  'quota',
  'session',
  'skill',
  'source',
  'task',
  'worker_definition',
  'worker_run',
  'workspace',
] as const;
export type AuditResourceType = (typeof AUDIT_RESOURCE_TYPES)[number];

/**
 * Lifecycle audit actions the kernel writes *outside* a capability dispatch (which audits under
 * the capability's own name — `application/gateway/dispatch.ts` `action: name`): the state-
 * machine transitions of ActionRequest / Task / WorkerRun (`governance/approval/transition-log`,
 * `application/task/transition-log.ts`) and the S6-A chat / connection actions. Suggestions
 * only — the action filter is free text.
 */
export const AUDIT_LIFECYCLE_ACTIONS = [
  'action_request.request',
  'action_request.approve',
  'action_request.reject',
  'action_request.start_execution',
  'action_request.complete',
  'action_request.fail',
  'action_request.compensate',
  'action_request.expire',
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
] as const;

/**
 * S8 W4-A (ui-audit S11/PA1 — "审计流默认只显示写与决策，读另设筛选"): whether `action` is a pure
 * read — `mode:'observe'` in the capability registry (`audit_query`/`explain`/`list_*`/`search`/…
 * itself, every read a dispatched capability call audits under its own name). An action the
 * registry does not recognise (every lifecycle-transition action in `AUDIT_LIFECYCLE_ACTIONS` —
 * `action_request.approve`, `task.complete`, …, none of which is a capability name) is never
 * treated as a read: those rows are exactly the "写与决策" the default view exists to keep
 * visible, so an unrecognised action fails open (shown), not hidden.
 */
export function isReadAuditAction(action: string): boolean {
  return getCapability(action)?.mode === 'observe';
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

/** The console route an audit row's `resourceType:resourceId` opens, when the console has a page
 *  for that resource; `undefined` otherwise (the chip stays a plain reference). */
export function resourceHref(
  resourceType: string | null,
  resourceId: string | null,
): string | undefined {
  if (!resourceId) return undefined;
  switch (resourceType) {
    case 'action_request':
      return hrefs.approval(resourceId);
    case 'task':
      return hrefs.task(resourceId);
    case 'chat':
      return hrefs.chat(resourceId);
    case 'gatekeeper':
      return hrefs.gatekeeper(resourceId);
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
