import type { Translate } from './i18n.js';

/**
 * lib/action-outcome (legacy 287, UX acceptance of #586): one reading of where a gate action
 * stands, shared by the chat's tool row (`components/ToolCallRowView`) and the approvals pages, so
 * the chip, the notice and the raw result never say different things about the same request.
 *
 * The kernel records a request whose outcome nobody can confirm as `failed` with a reason that
 * starts `outcome_unknown:` (GO1 will give it a structured category; until then the reason prefix
 * is the signal). A request that never ran fails `gate_unreachable:` (nothing was sent) or
 * `apply_not_received:` (the gate has no record of it running). An `executing` row whose call got
 * no answer carries `outcomeInDoubt`; an approved row held back by an earlier one carries
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
  /** failed, and nothing ran: not sent (`gate_unreachable`) or no record on the gate
   *  (`apply_not_received`). Safe to request again. */
  | 'not_run'
  /** failed with `outcome_unknown`: it may have run. Check the target before anything else. */
  | 'outcome_unknown'
  /** failed for any other reason the gate or its target gave. */
  | 'failed'
  /** executing with no answer from the gate yet: the platform will ask the gate. */
  | 'in_doubt'
  | 'running'
  /** approved / auto_approved, not run yet. */
  | 'queued'
  | 'pending_approval'
  | 'rejected'
  | 'expired';

export interface ActionOutcome extends ActionWaitingFields {
  readonly kind: ActionOutcomeKind;
  readonly status: string;
}

/** The code a failure reason starts with (`outcome_unknown: …`). */
const REASON_CODE = /^(outcome_unknown|gate_unreachable|apply_not_received):/;
/** A cut-short preview of the outcome object as the Worker's tool writes it
 *  (`JSON.stringify(result, null, 2)`, `id` then `status`): only its own top-level `status`, never
 *  one inside a simulated effect or the gate's data. */
const PREVIEW_STATUS = /^\{\s*"id":\s*"[^"]*",\s*"status":\s*"([a-z_]+)"/;
const PREVIEW_REASON_CODE =
  /\n {2}"reason":\s*"(outcome_unknown|gate_unreachable|apply_not_received):/;
const PREVIEW_IN_DOUBT = /\n {2}"outcomeInDoubt":\s*\{/;

function kindOf(
  status: string,
  reasonCode: string | undefined,
  inDoubt: boolean,
): ActionOutcomeKind | null {
  switch (status) {
    case 'executed':
    case 'verified':
      return 'done';
    case 'failed':
      if (reasonCode === 'outcome_unknown') return 'outcome_unknown';
      if (reasonCode === 'gate_unreachable' || reasonCode === 'apply_not_received')
        return 'not_run';
      return 'failed';
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
    const reason = typeof object.reason === 'string' ? object.reason : '';
    const waiting = object as ActionWaitingFields;
    const kind = kindOf(status, REASON_CODE.exec(reason)?.[1], Boolean(waiting.outcomeInDoubt));
    return kind
      ? {
          kind,
          status,
          outcomeInDoubt: waiting.outcomeInDoubt ?? null,
          queuedBehind: waiting.queuedBehind ?? null,
        }
      : null;
  }
  const status = PREVIEW_STATUS.exec(text)?.[1];
  if (status === undefined) return null;
  const kind = kindOf(status, PREVIEW_REASON_CODE.exec(text)?.[1], PREVIEW_IN_DOUBT.test(text));
  return kind ? { kind, status } : null;
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
      return { className: 'chip-danger', label: t('结果不明·查询中', 'outcome unknown · asking') };
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
  }
}

/** Why a request that has not finished is waiting, said in the viewer's language: an `executing`
 *  one in doubt (danger — it may have run), or an approved one queued behind an earlier request
 *  (info). `null` when the row says neither. */
export function waitingReason(
  row: { readonly status: string } & ActionWaitingFields,
  t: Translate,
): {
  readonly tone: 'danger' | 'info';
  readonly title: string;
  readonly message: string;
} | null {
  if (row.status === 'executing' && row.outcomeInDoubt) {
    return {
      tone: 'danger',
      title: t(
        '动作结果不明，平台正在向门查询',
        'Outcome unknown — the platform is asking the gate',
      ),
      message: t(
        '执行请求发出后没有收到门的答复，动作可能已经执行。平台约 10 分钟后向门查询这次请求，查到就记下结果，从不重新执行；查不到会标为「结果不明」交你核对。在这之前，同一个系统上排在它后面的请求都会等它。',
        'The call got no answer from the gate after it was sent, so the action may have run. About 10 minutes after the call the platform asks the gate about this request and records what it says — it never runs it again; if the gate cannot say, it is marked "outcome unknown" for you to check. Until then, later requests on the same system wait for it.',
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
): { readonly tone: 'danger' | 'info'; readonly label: string } | null {
  if (row.status === 'executing' && row.outcomeInDoubt) {
    return {
      tone: 'danger',
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
            return `${key}: ${text.length > 40 ? `${text.slice(0, 40)}…` : text}`;
          })
      : [];
  if (shown.length === 0) return operation;
  return t(`${operation}（${shown.join('，')}）`, `${operation} (${shown.join(', ')})`);
}
