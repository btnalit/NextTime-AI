import {
  ACTION_REQUEST_FAILURE_KIND_VALUES,
  type ActionRequestFailureKind,
  clipCodePoints,
  failureKindOfReason,
  visibleText,
} from '@nexttime/shared';
import { withPlaintextTlsHint } from './errors.js';
import { actionKindTagText } from './format.js';
import type { Translate } from './i18n.js';

/**
 * lib/action-outcome (legacy 287, UX acceptance of #586): one reading of where a gate action
 * stands, shared by the chat's tool row (`components/ToolCallRowView`) and the approvals pages, so
 * the chip, the notice and the raw result never say different things about the same request.
 *
 * A `failed` request says which kind of failure it was in `failureKind` (S11 GO1, the row's own
 * column): `not_delivered` (it never reached the gate, nothing ran), `refused` (the platform or the
 * gate said no, or its target answered with an error), `outcome_unknown` (it may have run). A tool
 * result from before that field reads its kind from its reason the way the 0021 backfill reads old
 * rows (shared `failureKindOfReason`): not delivered or refused only when the reason's code says
 * nothing ran, outcome unknown otherwise (review of #601, M1). An `executing` row whose call
 * got no answer carries `outcomeInDoubt`; an approved row held back by an earlier one carries
 * `queuedBehind` (`ActionRequestWireSchema`).
 */

/** `ActionRequestWireSchema.outcomeInDoubt` / `queuedBehind` (packages/shared/src/wire/governance.ts). */
export interface ActionWaitingFields {
  readonly outcomeInDoubt?: { readonly since: string; readonly reason: string | null } | null;
  readonly queuedBehind?: {
    readonly status: 'pending_approval' | 'executing';
    readonly outcomeInDoubt: boolean;
  } | null;
}

export type ActionOutcomeKind =
  /** executed / verified. */
  | 'done'
  /** failed, and nothing ran (`failureKind: 'not_delivered'`). Safe to request again. */
  | 'not_run'
  /** failed with `outcome_unknown`: it may have run. Check the target before anything else. */
  | 'outcome_unknown'
  /** failed: refused, by the platform or the gate, or its target answered with an error
   *  (`failureKind: 'refused'`). */
  | 'failed'
  /** executing with no answer from the gate yet: the platform will ask the gate. */
  | 'in_doubt'
  | 'running'
  /** approved / auto_approved, not run yet. */
  | 'queued'
  | 'pending_approval'
  | 'rejected'
  | 'expired'
  /** taken back before it ran (S11 GO1): its step was cancelled or revised away. */
  | 'withdrawn';

export interface ActionOutcome extends ActionWaitingFields {
  readonly kind: ActionOutcomeKind;
  readonly status: string;
  /** The ActionRequest's id, when the result shows it. */
  readonly id?: string;
}

/** What each failure kind reads as (S11 GO1). */
const FAILURE_KIND_OUTCOME: Readonly<Record<ActionRequestFailureKind, ActionOutcomeKind>> = {
  not_delivered: 'not_run',
  refused: 'failed',
  outcome_unknown: 'outcome_unknown',
};
/** A cut-short preview of the outcome object as the Worker's tool writes it
 *  (`JSON.stringify(result, null, 2)`, `id` then `status`): only its own top-level `status`, never
 *  one inside a simulated effect or the gate's data. */
const PREVIEW_STATUS = /^\{\s*"id":\s*"([^"]*)",\s*"status":\s*"([a-z_]+)"/;
/** The start of the reason a cut-short preview still shows, as JSON string content. */
const PREVIEW_REASON = /\n {2}"reason":\s*"((?:[^"\\]|\\.)*)/;
const PREVIEW_IN_DOUBT = /\n {2}"outcomeInDoubt":\s*\{/;
const PREVIEW_FAILURE_KIND = /\n {2}"failureKind":\s*"([a-z_]+)"/;

/** `value` as a failure kind, or `undefined` for anything else (an older result has none). */
export function failureKindOf(value: unknown): ActionRequestFailureKind | undefined {
  return typeof value === 'string' &&
    (ACTION_REQUEST_FAILURE_KIND_VALUES as readonly string[]).includes(value)
    ? (value as ActionRequestFailureKind)
    : undefined;
}

/** A preview's reason as text — `null` when there is none; what a cut-short preview still shows
 *  (enough for its code: a reason cut before it ends reads as outcome unknown). */
function previewReason(text: string): string | null {
  const raw = PREVIEW_REASON.exec(text)?.[1];
  if (raw === undefined) return null;
  try {
    return JSON.parse(`"${raw}"`) as string;
  } catch {
    return raw;
  }
}

function kindOf(
  status: string,
  failureKind: ActionRequestFailureKind | undefined,
  reason: string | null,
  inDoubt: boolean,
): ActionOutcomeKind | null {
  switch (status) {
    case 'executed':
    case 'verified':
      return 'done';
    case 'failed':
      return FAILURE_KIND_OUTCOME[failureKind ?? failureKindOfReason(reason)];
    case 'executing':
      return inDoubt ? 'in_doubt' : 'running';
    case 'approved':
    case 'auto_approved':
      return 'queued';
    case 'pending_approval':
      return 'pending_approval';
    case 'rejected':
      return 'rejected';
    case 'expired':
      return 'expired';
    case 'withdrawn':
      return 'withdrawn';
    default:
      return null;
  }
}

/** The ActionRequest outcome object (`{id, status, …}`) a tool result carries, if any: the
 *  capability result itself, pi's `{content, details}` wrapper around it, or the text of its first
 *  content block. */
function outcomeObjectOf(value: unknown, depth = 0): Record<string, unknown> | null {
  if (depth > 2 || value === null || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id === 'string' && typeof record.status === 'string') return record;
  const details = outcomeObjectOf(record.details, depth + 1);
  if (details) return details;
  const content = record.content;
  if (Array.isArray(content)) {
    const first = content[0] as { text?: unknown } | undefined;
    if (typeof first?.text === 'string') {
      try {
        return outcomeObjectOf(JSON.parse(first.text), depth + 1);
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** Where a `request_action` tool result says the action stands — `null` for any other result
 *  (an observe call's data, a pending approval's simulated effect, which is not the outcome
 *  object). Reads the JSON when it parses; a preview cut short falls back to the top-level
 *  `status`, reason code and `outcomeInDoubt` it still shows. */
export function actionOutcomeOfToolResult(text: string): ActionOutcome | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  const object = outcomeObjectOf(parsed);
  if (object) {
    const status = object.status as string;
    const reason = typeof object.reason === 'string' ? object.reason : null;
    const waiting = object as ActionWaitingFields;
    const kind = kindOf(
      status,
      failureKindOf(object.failureKind),
      reason,
      Boolean(waiting.outcomeInDoubt),
    );
    return kind
      ? {
          kind,
          status,
          id: object.id as string,
          outcomeInDoubt: waiting.outcomeInDoubt ?? null,
          queuedBehind: waiting.queuedBehind ?? null,
        }
      : null;
  }
  const preview = PREVIEW_STATUS.exec(text);
  const id = preview?.[1];
  const status = preview?.[2];
  if (id === undefined || status === undefined) return null;
  const kind = kindOf(
    status,
    failureKindOf(PREVIEW_FAILURE_KIND.exec(text)?.[1]),
    previewReason(text),
    PREVIEW_IN_DOUBT.test(text),
  );
  return kind ? { kind, status, id } : null;
}

/** The chip a tool row shows for an action outcome — the same words as its notice. */
export function actionOutcomeChip(
  outcome: ActionOutcome,
  t: Translate,
): { readonly className: string; readonly label: string } {
  switch (outcome.kind) {
    case 'done':
      return { className: 'chip-neutral', label: t('完成', 'done') };
    case 'not_run':
      return { className: 'chip-neutral', label: t('没执行', 'did not run') };
    case 'outcome_unknown':
      return { className: 'chip-danger', label: t('结果不明', 'outcome unknown') };
    case 'failed':
      return { className: 'chip-danger', label: t('失败', 'failed') };
    case 'in_doubt':
      return { className: 'chip-warn', label: t('结果不明·查询中', 'outcome unknown · asking') };
    case 'running':
      return { className: 'chip-info', label: t('执行中', 'running') };
    case 'queued':
      return { className: 'chip-neutral', label: t('排队中', 'queued') };
    case 'pending_approval':
      return { className: 'chip-warn', label: t('待审批', 'awaiting approval') };
    case 'rejected':
      return { className: 'chip-danger', label: t('已拒绝', 'rejected') };
    case 'expired':
      return { className: 'chip-neutral', label: t('已过期', 'expired') };
    case 'withdrawn':
      return { className: 'chip-neutral', label: t('已撤回', 'withdrawn') };
  }
}

/**
 * S11 GO1: what a failed request's kind means for the reader, for the approvals pages and the chat
 * status line — `short` for a list row, `title` + `message` for a detail pane. `danger` only for
 * "outcome unknown", the one a person must check before doing anything (`kit/notice`'s "an action
 * that may already have run"); `null` when the row is not failed / compensated or carries no kind.
 * `check` names what to check where, when the caller knows it (UX acceptance of #586, P2-2 / P3-2):
 * the system by name and the action with its target, so "outcome unknown" says exactly what to look
 * at.
 */
export function failureReading(
  row: { readonly status: string; readonly failureKind?: string | null },
  t: Translate,
  check?: { readonly system?: string | null; readonly action?: string | null },
): {
  readonly kind: ActionRequestFailureKind;
  readonly tone: 'danger' | 'info';
  readonly short: string;
  readonly title: string;
  readonly message: string;
} | null {
  if (row.status !== 'failed' && row.status !== 'compensated') return null;
  const kind = failureKindOf(row.failureKind);
  switch (kind) {
    case 'not_delivered':
      return {
        kind,
        tone: 'info',
        short: t('没发出，什么都没执行', 'Not sent — nothing ran'),
        title: t(
          '请求没有到达门，什么都没执行',
          'The request never reached the gate — nothing ran',
        ),
        message: t(
          '连不上门、平台无法向门认证，或门确认从没收到这次请求。目标系统没有任何变化；仍然需要的话，可以重新发起。',
          'The gate could not be reached, the platform could not authenticate to it, or the gate confirmed it never received this request. Nothing changed on the target system; request it again if it is still wanted.',
        ),
      };
    case 'refused':
      return {
        kind,
        tone: 'info',
        short: t('被拒绝或执行失败', 'Refused or failed'),
        title: t(
          '平台或门明确答复：不执行或执行失败',
          'The platform or the gate answered: refused, or it failed',
        ),
        message: t(
          '例如操作已被停用、批准的定义已不存在、门拒绝了参数或凭据，或目标系统返回了错误。原样重试会得到同样的结果：先按原因处理，再决定是否重新发起。',
          'For example the Operation was disabled, the approved definition is gone, the gate refused the parameters or had no credential, or the target system answered with an error. Asking again unchanged gets the same answer: deal with the reason first, then decide whether to request it again.',
        ),
      };
    case 'outcome_unknown':
      return {
        kind,
        tone: 'danger',
        short: t('结果不明，需要核对', 'Outcome unknown — check it'),
        title: t('结果不明：动作可能已经执行', 'Outcome unknown: the action may have run'),
        message: outcomeUnknownMessage(t, check?.system ?? undefined, check?.action ?? undefined),
      };
    default:
      return null;
  }
}

/** The "outcome unknown" next step, naming the system and the action when known. */
function outcomeUnknownMessage(t: Translate, system?: string, action?: string): string {
  const where = system
    ? t(`到 ${system} 上`, `on ${system}`)
    : t('到目标系统', 'on the target system');
  const what = action
    ? t(`核对 ${action}${/）$/.test(action) ? '' : ' '}是否生效`, `whether ${action} took effect`)
    : t('核对它是否生效', 'whether it took effect');
  return t(
    `平台无法确认这个动作是否生效。不要直接重试：先${where}${what}，再决定要不要重新发起。`,
    `The platform cannot tell whether this action took effect. Do not just retry: check ${where} ${what}, then decide whether to request it again.`,
  );
}

/** Why a request that has not finished is waiting, said in the viewer's language: an `executing`
 *  one in doubt (warn — the platform is still asking the gate, nothing for the reader to do yet;
 *  danger is kept for the final "outcome unknown" a person has to check, UX acceptance of #586),
 *  or an approved one queued behind an earlier request (info). `null` when the row says neither. */
export function waitingReason(
  row: { readonly status: string } & ActionWaitingFields,
  t: Translate,
): {
  readonly tone: 'warn' | 'info';
  readonly title: string;
  readonly message: string;
} | null {
  if (row.status === 'executing' && row.outcomeInDoubt) {
    return {
      tone: 'warn',
      title: t(
        '动作结果不明，平台正在向门查询',
        'Outcome unknown — the platform is asking the gate',
      ),
      message: withPlaintextTlsHint(
        t(
          '执行请求发出后没有收到门的答复，动作可能已经执行。平台约 10 分钟后向门查询这次请求，查到就记下结果，从不重新执行；查不到会标为「结果不明」交你核对。在这之前，同一个系统上排在它后面的请求都会等它。',
          'The call got no answer from the gate after it was sent, so the action may have run. About 10 minutes after the call the platform asks the gate about this request and records what it says — it never runs it again; if the gate cannot say, it is marked "outcome unknown" for you to check. Until then, later requests on the same system wait for it.',
        ),
        row.outcomeInDoubt.reason,
        t,
      ),
    };
  }
  if ((row.status === 'approved' || row.status === 'auto_approved') && row.queuedBehind) {
    const behind = row.queuedBehind;
    return {
      tone: 'info',
      title: t('排队中', 'Queued'),
      message:
        behind.status === 'pending_approval'
          ? t(
              '同一个系统上更早的一条请求还在等审批。同一个系统的请求按提出顺序执行，它有了决定后这条才会执行。',
              'An earlier request on the same system is still awaiting approval. Requests on one system run in the order they were made, so this one runs once that one is decided.',
            )
          : behind.outcomeInDoubt
            ? t(
                '同一个系统上更早的一条请求结果不明，平台正在向门查询。它有结论后这条才会执行。',
                'An earlier request on the same system has an unknown outcome and the platform is asking the gate about it. This one runs once that one is settled.',
              )
            : t(
                '同一个系统上更早的一条请求正在执行，它结束后这条才会执行。',
                'An earlier request on the same system is still running; this one runs after it.',
              ),
    };
  }
  return null;
}

/** The same reason in a few words, for a list row: `null` when the row says neither. */
export function waitingShortLabel(
  row: { readonly status: string } & ActionWaitingFields,
  t: Translate,
): { readonly tone: 'warn' | 'info'; readonly label: string } | null {
  if (row.status === 'executing' && row.outcomeInDoubt) {
    return {
      tone: 'warn',
      label: t('结果不明，平台向门查询中', 'Outcome unknown — the platform is asking the gate'),
    };
  }
  if ((row.status === 'approved' || row.status === 'auto_approved') && row.queuedBehind) {
    const behind = row.queuedBehind;
    return {
      tone: 'info',
      label:
        behind.status === 'pending_approval'
          ? t(
              '排队中：同一系统上更早的请求在等审批',
              'Queued: an earlier request on this system awaits approval',
            )
          : behind.outcomeInDoubt
            ? t(
                '排队中：同一系统上更早的请求结果不明',
                'Queued: an earlier request on this system has an unknown outcome',
              )
            : t(
                '排队中：同一系统上更早的请求正在执行',
                'Queued: an earlier request on this system is running',
              ),
    };
  }
  return null;
}

/** "container.restart（id: media）": the Operation a gate call names and up to three of its
 *  plain parameters, for a sentence that says what to check. From a `request_action` call's
 *  `{operation, params}`, else the tool's own name and arguments. `undefined` when there is no
 *  name to give. */
export function actionTargetLabel(
  toolName: string | undefined,
  args: unknown,
  t: Translate,
): string | undefined {
  let value = args;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      value = undefined;
    }
  }
  const record =
    value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
  const operation = typeof record?.operation === 'string' ? record.operation : toolName;
  if (operation === undefined || operation === '') return undefined;
  // Legacy 232: the name and values are whatever the model sent — shown visibly (`format.ts`).
  const shownOperation = actionKindTagText(operation);
  const params =
    typeof record?.operation === 'string'
      ? record.params
      : record
        ? Object.fromEntries(Object.entries(record).filter(([key]) => key !== 'gatekeeperId'))
        : undefined;
  const shown =
    params !== null && typeof params === 'object'
      ? Object.entries(params as Record<string, unknown>)
          .filter(
            ([, v]) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean',
          )
          .slice(0, 3)
          .map(([key, v]) => {
            const text = String(v);
            return `${visibleText(key)}: ${visibleText(clipCodePoints(text, 40))}`;
          })
      : [];
  if (shown.length === 0) return shownOperation;
  return t(`${shownOperation}（${shown.join('，')}）`, `${shownOperation} (${shown.join(', ')})`);
}
