import type { Translate } from './i18n.js';

/**
 * Legacy 421: a Decision is shown only to whoever may see what it is about (kernel
 * substrate/epistemic/decision-visibility.ts, governance 0028) — an approval or reconcile Decision
 * to whoever can see its action request, a goal's outcome to the goal's requester and the owner, a
 * Decision from a private chat to that chat's owner, a conflict ruling to whoever sees both Facts.
 * A hidden Decision reads exactly like one that does not exist, so where a Decision may be missing
 * — a not-found, an empty list — the console says it may be one the reader cannot see, never that
 * it does not exist. Each text is one sentence pair the surfaces share.
 */

/** What the reader asked about when a node came back 404: a Decision, another kind of node, or a
 *  node of unknown kind (an id pasted into `explain`). */
export type NotFoundNodeKind = 'decision' | 'other' | 'unknown';

/** A node `explain` / `causal_chain` / `export_prov` answered 404 for (the `not_found` override).
 *  Legacy 430: the first sentence is about any node; the half about who may see a Decision only
 *  where the node is one — or may be one, said as such. */
export function decisionNotFoundText(t: Translate, kind: NotFoundNodeKind = 'unknown'): string {
  const first = t(
    '找不到这个节点，或者你无权查看它。',
    'This node was not found, or you may not see it.',
  );
  if (kind === 'other') return first;
  const visibility = t(
    '审批和核对的决定只对能看到那个动作请求的人显示，目标结果的决定只对目标的发起人和工作区所有者显示，别人私聊里的决定、你看不到的冲突的裁决也不显示。',
    "A Decision on an approval or a reconcile shows only to whoever can see its action request, a goal's outcome only to the goal's requester and the workspace owner; Decisions from someone else's private chat, and rulings on Conflicts you cannot see, do not show either.",
  );
  return kind === 'decision'
    ? `${first}${t('', ' ')}${visibility}`
    : `${first}${t('如果这是一个决定：', ' If it is a Decision: ')}${visibility}`;
}

/** An empty `query_decisions` / `find_precedents` list. */
export function noVisibleDecisionsText(t: Translate): string {
  return t(
    '没有你能查看的匹配决定。审批和核对的决定只对能看到那个动作请求的人显示，目标结果的决定只对目标的发起人和工作区所有者显示，别人私聊里的决定、你看不到的冲突的裁决也不显示。',
    "No matching Decisions you may see. A Decision on an approval or a reconcile shows only to whoever can see its action request, a goal's outcome only to the goal's requester and the workspace owner; Decisions from someone else's private chat, and rulings on Conflicts you cannot see, do not show either.",
  );
}

/** The recent-Decisions picker with nothing to offer. */
export function noVisibleRecentDecisionsText(t: Translate): string {
  return t(
    '还没有你能查看的决定；可直接粘贴 ID。审批、核对和目标结果的决定只对能看到那个请求或目标的人显示。',
    'No Decisions you may see yet — paste an id instead. Decisions on approvals, reconciles and goal outcomes show only to whoever can see that request or goal.',
  );
}
