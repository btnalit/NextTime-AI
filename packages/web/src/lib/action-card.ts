import type { ActionPendingPush, ChatMessage } from './ws-client.js';

/**
 * lib/action-card: normalizes the three different shapes an ActionRequest can arrive in on the
 * web client into one `ActionCardData` a single `ActionRequestCard` component can render (docs/
 * development-tasks.md S2.10 deliverable 2: "title, Markdown description, simulate/effect block
 * when present, action kind tag").
 *
 * The three sources, and why none of them alone is enough:
 *   - `action.pending` push (`ActionPendingPush`, ws-client.ts) — the *only* source carrying a
 *     `title`, a human-readable `description`, and `simulated`. Principal-scoped (no `chatId`),
 *     delivered once, live, the moment the ActionRequest is created — never replayed on a page
 *     reload or a fresh `list_pending` call (S2.11 implementation note: the kernel builds these
 *     three fields on the fly from `actionKind`/`resourceScope`/`gatekeeperId` inside
 *     `application/linkage`, a kernel-internal module never exposed to `list_pending`/`get_action`
 *     or persisted onto the `system.action_pending` chat message content).
 *   - persisted `system.action_pending` chat message content (`ChatMessage.content`,
 *     packages/shared/src/chat-message-content.ts `SystemActionPendingContent`) — durable (survives
 *     reload, `get_chat_history` replay), but only carries a one-line `text`, `actionKind` as a bare
 *     string (not `{tag,label}`), `resourceScope`, `blastRadius`, `awaitDecision`, `isHolder`. No
 *     `title`/no `description`/no `simulated`.
 *   - a `list_pending`/`get_action` row (`ActionRequestRow`, governance/approval/types.ts, read over
 *     HTTP — this module never imports kernel code, so the shape is duplicated locally as
 *     `ActionRequestRowLike` below) — the rawest source: `actionKind`, `resourceScope`,
 *     `blastRadius`, `awaitDecision`, `status`, and the Operation call's own `params`. No title/
 *     description/simulated either — `action_requests` itself has no such columns (S2.1/S2.11's own
 *     "已知偏离" notes).
 *
 * Where a source lacks `title`/`description`, this module synthesizes them the same way the kernel
 * itself does today (S2.11: "由 actionKind 与 resourceScope/gatekeeperId 拼出") — `humanizeActionKind`
 * mirrors that convention (dot-segments joined by spaces) rather than inventing a different one, so
 * a card looks the same regardless of which source produced it. This is presentation-only
 * duplication of a *formatting* convention, not a governance decision — the real fix (real title/
 * description text from a published Operation's manifest) is S2.4/S2.13 scope, same as the kernel
 * side already documents.
 */

/** Local mirror of `governance/approval/types.ts`'s `ActionRequestRow`, narrowed to the fields this
 *  module needs, as the wire shape `list_pending`/`get_action` actually return (camelCase, ISO
 *  date strings — `application/gateway/handlers.ts`'s `getActionHandler`/`listPendingHandler`
 *  return the row as-is, `Date` fields included; `HttpClient.call`'s `response.json()` turns those
 *  into ISO strings on the wire, same as every other capability result in this codebase). */
export interface ActionRequestRowLike {
  readonly id: string;
  readonly status: string;
  readonly gatekeeperId: string;
  readonly actionKind: string;
  readonly resourceScope: string | null;
  readonly blastRadius: 'low' | 'medium' | 'high';
  readonly awaitDecision: boolean;
  readonly params: Record<string, unknown>;
}

export interface ActionCardData {
  readonly actionRequestId: string;
  readonly gatekeeperId: string;
  readonly title: string;
  /** Plain text (or, from a live push, whatever the kernel concatenated) — rendered with
   *  `white-space: pre-wrap`, never `dangerouslySetInnerHTML` (no real Markdown source exists yet
   *  on the kernel side either, per this module's own doc comment above). */
  readonly description: string;
  readonly actionKindTag: string;
  readonly actionKindLabel: string;
  readonly resourceScope: string | null;
  readonly blastRadius: 'low' | 'medium' | 'high' | undefined;
  readonly awaitDecision: boolean;
  readonly simulated: unknown;
  /** `undefined` when the source (a `list_pending`/`get_action` row) carries no persisted status —
   *  callers with a row always have one; callers building from a live push or a chat message
   *  should pass their own known status (`'pending_approval'`, or an `action.updated` override). */
  readonly status: string | undefined;
  readonly isHolder: boolean;
}

/** "docker.container_restart" -> "docker container restart" — the same convention the kernel's
 *  `application/linkage` title-builder uses (S2.11 implementation note), duplicated here as a pure
 *  formatting helper (see this module's own doc comment for why duplication, not import, is the
 *  right call). */
export function humanizeActionKind(actionKind: string): string {
  return actionKind.split('.').join(' ');
}

function formatParams(params: Record<string, unknown> | undefined): string {
  if (!params || Object.keys(params).length === 0) return '';
  try {
    return `\n\n\`\`\`\n${JSON.stringify(params, null, 2)}\n\`\`\``;
  } catch {
    return '';
  }
}

/** Builds an `ActionCardData` from a live `action.pending` push — the richest source, used as-is. */
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
  };
}

/** Builds an `ActionCardData` from a persisted `system.action_pending` chat message's `content`
 *  (loosened to a bare record on `ChatMessage`, per that field's own doc comment) — the fields
 *  `SystemActionPendingContent` guarantees. Title/description are synthesized (see module doc
 *  comment); `content.text` is used as the description since it is already the kernel's own
 *  one-line summary — better than fabricating a longer one from fields the kernel itself decided
 *  not to expose here.
 *
 *  Only `system.action_pending` ever renders as a card (docs/development-tasks.md S2.10
 *  deliverable 2: "system.action_update 和 system.task_update 作为紧凑状态行") — `system.action_update`
 *  is always a compact status line regardless of `isHolder`, formatted by
 *  `lib/system-status.ts` instead, never by this function. */
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

  const text = typeof content.text === 'string' ? content.text : humanizeActionKind(actionKind);
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
    title: humanizeActionKind(actionKind),
    description: text,
    actionKindTag: actionKind,
    actionKindLabel: humanizeActionKind(actionKind),
    resourceScope,
    blastRadius,
    awaitDecision,
    simulated: undefined,
    status: 'pending_approval',
    isHolder,
  };
}

/** Builds an `ActionCardData` from a `list_pending`/`get_action` row (the approval queue view —
 *  always the caller's own, so always `isHolder: true`). */
export function actionCardFromRow(row: ActionRequestRowLike): ActionCardData {
  return {
    actionRequestId: row.id,
    gatekeeperId: row.gatekeeperId,
    title: humanizeActionKind(row.actionKind),
    description: `${humanizeActionKind(row.actionKind)}${row.resourceScope ? ` on ${row.resourceScope}` : ''}${formatParams(row.params)}`,
    actionKindTag: row.actionKind,
    actionKindLabel: humanizeActionKind(row.actionKind),
    resourceScope: row.resourceScope,
    blastRadius: row.blastRadius,
    awaitDecision: row.awaitDecision,
    simulated: undefined,
    status: row.status,
    isHolder: true,
  };
}

/** Merges a richer `action.pending` push into an already-built card (from a chat message or a row)
 *  when both are available in the same page session — the push arrives once, live; a page that has
 *  it in hand should prefer its `title`/`description`/`simulated` over the synthesized fallback,
 *  while keeping whatever the base card already knows (e.g. a live `status` override the push
 *  itself does not carry). */
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
 *  (`system.action_pending`) — a small helper so `ChatPage.tsx` does not need to know
 *  `chat-message-content.ts`'s discriminant literal string itself. `system.action_update`/
 *  `system.task_update` are compact status lines instead (`lib/system-status.ts`). */
export function isPendingCardMessage(message: ChatMessage): boolean {
  return message.kind === 'system.action_pending';
}
