import type { BlastRadius } from '@nexttime/shared';
import { humanizeKind } from './format.js';
import type { ActionPendingPush, ChatMessage } from './ws-client.js';

/**
 * lib/action-card: normalizes the three different shapes an ActionRequest can arrive in on the
 * web client into one `ActionCardData` a single detail component (`components/ActionRequestDetail`)
 * renders (docs/development-tasks.md S2.10 deliverable 2).
 *
 * The three sources, and why none of them alone is enough:
 *   - `action.pending` push (`ActionPendingPush`, ws-client.ts) — the *only* source carrying a
 *     `title`, a human-readable `description`, and `simulated`. Principal-scoped (no `chatId`),
 *     delivered once, live — never replayed on reload or by `list_pending` (the kernel builds these
 *     on the fly in `application/linkage/action-request-consumer.ts`).
 *   - persisted `system.action_pending` chat message content (`ChatMessage.content`,
 *     packages/shared/src/chat-message-content.ts `SystemActionPendingContent`) — durable, but only
 *     `text`, a bare `actionKind`, `resourceScope`, `blastRadius`, `awaitDecision`, `isHolder`.
 *   - a `list_pending`/`get_action` row (`governance/approval/types.ts` `ActionRequestRow` over
 *     HTTP — duplicated locally as `ActionRequestRowLike`, this module never imports kernel code)
 *     — the rawest and richest for governance fields: `status`, `params`, `onBehalfOf`,
 *     `actorRuntime`, `policyDecision`, timestamps. No title/description/simulated.
 *
 * Where a source lacks `title`, this module synthesizes one with `humanizeKind` (the kernel's own
 * label convention, `application/linkage/content.ts`) so a card looks the same whichever source
 * produced it. Presentation-only; the real text (a published Operation's `name`/`description`)
 * is S2.4/S2.13's to surface.
 */

/** Local mirror of `ActionRequestRow` as `list_pending`/`get_action` return it over the wire
 *  (camelCase; `Date` columns become ISO strings through `response.json()`). Fields beyond the
 *  S2.10 set are optional so an older row shape still renders. */
export interface ActionRequestRowLike {
  readonly id: string;
  readonly status: string;
  readonly gatekeeperId: string;
  readonly actionKind: string;
  readonly resourceScope: string | null;
  readonly blastRadius: BlastRadius;
  readonly awaitDecision: boolean;
  readonly params: Record<string, unknown>;
  readonly onBehalfOf?: string;
  readonly actorRuntime?: string;
  readonly policyDecision?: string | null;
  readonly parentWorkerRunId?: string | null;
  readonly requestedAt?: string;
  readonly executedAt?: string | null;
  readonly failedAt?: string | null;
}

export interface ActionCardData {
  readonly actionRequestId: string;
  readonly gatekeeperId: string;
  readonly title: string;
  /** Plain text (or, from a live push, whatever the kernel concatenated) — rendered with
   *  `white-space: pre-wrap`, never `dangerouslySetInnerHTML`. */
  readonly description: string;
  readonly actionKindTag: string;
  readonly actionKindLabel: string;
  readonly resourceScope: string | null;
  readonly blastRadius: BlastRadius | undefined;
  readonly awaitDecision: boolean;
  readonly simulated: unknown;
  /** `undefined` when the source carries no persisted status — callers building from a live push
   *  or a chat message pass their own known status (`'pending_approval'`, or an `action.updated`
   *  override). */
  readonly status: string | undefined;
  readonly isHolder: boolean;
  /** The Operation call's own arguments — only a `list_pending`/`get_action` row has them. */
  readonly params: Record<string, unknown> | undefined;
  readonly onBehalfOf: string | undefined;
  readonly actorRuntime: string | undefined;
  readonly policyDecision: string | null | undefined;
  readonly parentWorkerRunId: string | null | undefined;
  readonly requestedAt: string | undefined;
  readonly executedAt: string | null | undefined;
  readonly failedAt: string | null | undefined;
}

/** "docker.container_restart" -> "docker container restart" — the kernel's own convention
 *  (`application/linkage/content.ts` `humanizeActionKind`), re-exported for existing callers. */
export const humanizeActionKind = humanizeKind;

const NO_ROW_FIELDS = {
  params: undefined,
  onBehalfOf: undefined,
  actorRuntime: undefined,
  policyDecision: undefined,
  parentWorkerRunId: undefined,
  requestedAt: undefined,
  executedAt: undefined,
  failedAt: undefined,
} as const;

/** Builds an `ActionCardData` from a live `action.pending` push — the richest source for text. */
export function actionCardFromPush(
  push: ActionPendingPush,
  extra: {
    readonly resourceScope?: string | null;
    readonly isHolder: boolean;
    readonly status?: string;
  },
): ActionCardData {
  return {
    actionRequestId: push.actionRequestId,
    gatekeeperId: push.gatekeeperId,
    title: push.title,
    description: push.description,
    actionKindTag: push.actionKind.tag,
    actionKindLabel: push.actionKind.label,
    resourceScope: extra.resourceScope ?? null,
    blastRadius: undefined,
    awaitDecision: push.awaitDecision,
    simulated: push.simulated,
    status: extra.status ?? 'pending_approval',
    isHolder: extra.isHolder,
    ...NO_ROW_FIELDS,
  };
}

/** Builds an `ActionCardData` from a persisted `system.action_pending` chat message's `content`.
 *  `content.text` is the kernel's own one-line summary and serves as the description. Only
 *  `system.action_pending` ever renders as a card — `system.action_update`/`system.task_update`
 *  are compact status lines (`lib/system-status.ts`). */
export function actionCardFromPendingContent(
  content: Readonly<Record<string, unknown>>,
): ActionCardData | undefined {
  if (content.kind !== 'system.action_pending') return undefined;

  const actionRequestId = content.actionRequestId;
  const actionKind = content.actionKind;
  const isHolder = content.isHolder;
  if (
    typeof actionRequestId !== 'string' ||
    typeof actionKind !== 'string' ||
    typeof isHolder !== 'boolean'
  ) {
    return undefined;
  }

  const text = typeof content.text === 'string' ? content.text : humanizeKind(actionKind);
  const resourceScope = typeof content.resourceScope === 'string' ? content.resourceScope : null;
  const blastRadius =
    content.blastRadius === 'low' ||
    content.blastRadius === 'medium' ||
    content.blastRadius === 'high'
      ? content.blastRadius
      : undefined;
  const awaitDecision = typeof content.awaitDecision === 'boolean' ? content.awaitDecision : false;

  return {
    actionRequestId,
    gatekeeperId: typeof content.gatekeeperId === 'string' ? content.gatekeeperId : '',
    title: humanizeKind(actionKind),
    description: text,
    actionKindTag: actionKind,
    actionKindLabel: humanizeKind(actionKind),
    resourceScope,
    blastRadius,
    awaitDecision,
    simulated: undefined,
    status: 'pending_approval',
    isHolder,
    ...NO_ROW_FIELDS,
  };
}

/** Builds an `ActionCardData` from a `list_pending`/`get_action` row (the approval queue — always
 *  the caller's own, so `isHolder: true` unless told otherwise). */
export function actionCardFromRow(
  row: ActionRequestRowLike,
  extra: { readonly isHolder?: boolean } = {},
): ActionCardData {
  const label = humanizeKind(row.actionKind);
  return {
    actionRequestId: row.id,
    gatekeeperId: row.gatekeeperId,
    title: label,
    description: `${label}${row.resourceScope ? ` on ${row.resourceScope}` : ''}`,
    actionKindTag: row.actionKind,
    actionKindLabel: label,
    resourceScope: row.resourceScope,
    blastRadius: row.blastRadius,
    awaitDecision: row.awaitDecision,
    simulated: undefined,
    status: row.status,
    isHolder: extra.isHolder ?? true,
    params: row.params,
    onBehalfOf: row.onBehalfOf,
    actorRuntime: row.actorRuntime,
    policyDecision: row.policyDecision,
    parentWorkerRunId: row.parentWorkerRunId,
    requestedAt: row.requestedAt,
    executedAt: row.executedAt,
    failedAt: row.failedAt,
  };
}

/** Merges a richer `action.pending` push into an already-built card when both are in hand — the
 *  push arrives once, live; prefer its `title`/`description`/`simulated` over the synthesized
 *  fallback while keeping whatever the base card already knows (e.g. a live `status` override). */
export function enrichActionCard(base: ActionCardData, push: ActionPendingPush): ActionCardData {
  return {
    ...base,
    title: push.title,
    description: push.description,
    actionKindTag: push.actionKind.tag,
    actionKindLabel: push.actionKind.label,
    simulated: push.simulated,
  };
}

/** Whether `message` is the one system-message kind that renders as a full card
 *  (`system.action_pending`). */
export function isPendingCardMessage(message: ChatMessage): boolean {
  return message.kind === 'system.action_pending';
}

/** The one ActionRequest status in which a holder can still decide (`ACTION_REQUEST_TRANSITIONS`:
 *  `approve`/`reject` edges leave `pending_approval` only). */
export const DECIDABLE_STATUS = 'pending_approval';

export function isDecidable(status: string | undefined): boolean {
  return status === undefined || status === DECIDABLE_STATUS;
}
