import { auditPayloadShown } from '../../lib/format.js';
import { useT } from '../../lib/i18n.js';
import { RedactedNote, showsRedaction } from '../kit/redacted-note.js';

/** A non-negative whole number at `record[key]`, else `undefined`. */
function countAt(record: Readonly<Record<string, unknown>>, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

/** S10 E3-1b: what each param an evaluation case write keeps out of its audit copy is called
 *  (`Capability.auditWithheldParamKeys`); anything else is named as sent. */
const WITHHELD_PARAM_LABELS: Readonly<
  Record<string, { readonly zh: string; readonly en: string }>
> = {
  title: { zh: '标题', en: 'title' },
  mechanism: { zh: '机制', en: 'mechanism' },
  input: { zh: '输入', en: 'input' },
  fixtures: { zh: '夹具规则', en: 'fixture rules' },
  assertions: { zh: '断言', en: 'assertions' },
};

/** The names in `record[key]` when it is a list of them, else `undefined`. */
function namesAt(record: Readonly<Record<string, unknown>>, key: string): string[] | undefined {
  const value = record[key];
  if (!Array.isArray(value)) return undefined;
  const names = value.filter((item): item is string => typeof item === 'string');
  return names.length > 0 ? names : undefined;
}

/** S10 E3-1c: where the evaluation seal stopped content on its way to an agent
 *  (`evaluation.content_withheld`'s `where`, kernel `application/eval-seal`) and what that left. */
function sealNote(
  record: Readonly<Record<string, unknown>>,
): { readonly zh: string; readonly en: string } | undefined {
  if (record.outcome !== 'withheld') return undefined;
  switch (record.where) {
    case 'capability_result':
      return record.rolledBack === false
        ? {
            zh: '这次调用的结果里有评测用例集保留的内容，没有交给智能体；调用本身已经生效。',
            en: 'The call’s result held content an evaluation suite keeps back, so it was not handed to the agent; the call itself took effect.',
          }
        : {
            zh: '这次调用的结果里有评测用例集保留的内容，没有交给智能体；调用写进平台的内容已撤回。',
            en: 'The call’s result held content an evaluation suite keeps back, so it was not handed to the agent; what the call wrote to the platform was rolled back.',
          };
    case 'capability_error':
      return {
        zh: '这次调用失败了，它的错误信息里有评测用例集保留的内容，没有交给智能体。',
        en: 'The call failed, and its error held content an evaluation suite keeps back, so the error was not handed to the agent.',
      };
    case 'worker_start':
      return {
        zh: '这个任务的 Worker 要拿到的内容（任务输入、系统提示词或技能）里有评测用例集保留的内容，Worker 没有启动，任务记为启动失败。',
        en: 'What this task’s Worker would have started with (its input, system prompt or Skills) held content an evaluation suite keeps back, so the Worker was not started and the task failed to start.',
      };
    case 'entry_turn':
      return {
        zh: '这条聊天消息里有评测用例集保留的内容，没有发给智能体，也没有保存。',
        en: 'This chat message held content an evaluation suite keeps back, so it was neither sent to the agent nor saved.',
      };
    case 'entry_start':
      return {
        zh: '入口智能体这一轮要读的系统提示词或技能里有评测用例集保留的内容，这一轮没有开始。',
        en: 'The system prompt or Skills the entry agent would have started this turn with held content an evaluation suite keeps back, so the turn did not start.',
      };
    default:
      return undefined;
  }
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

/**
 * What an audit row's payload says about credentials, in words above the raw payload (legacy 159,
 * 178): the kernel's `credentialReview` (a person confirmed N suspected credentials — or, for a
 * call that asks nobody, such as an observation or `invoke_worker`, only recorded them) and
 * `redactedValues` (N values hidden in this audit copy of the params; the call itself got them as
 * sent). Legacy 168 ③: `revokedHandleCount` (how many Handles an upgrade revoked, on
 * `principal.container_handles_revoked` / `principal.auditor_handles_revoked`) too. Legacy 420:
 * and what a `[redacted]` the payload below shows stands for, when `redactedValues` does not
 * already account for it — text the kernel reads out masked (an Operation description's before /
 * after, a row written before the params copy was redacted) or a value under a secret-named field
 * the console masks (`auditPayloadShown`, what the page shows below the notes). S10 E3-1b: and
 * which params the record leaves out (`withheldParams`, an evaluation case's content). S10 E3-1c:
 * and, on an `evaluation.content_withheld` row, where the seal stopped the content and what that
 * left. Renders nothing when the payload has none of them.
 */
export function AuditPayloadNotes({ payload }: { readonly payload: unknown }) {
  const t = useT();
  const record = asRecord(payload);
  if (record === undefined) return null;
  const review = asRecord(record.credentialReview);
  const reviewed = review !== undefined ? countAt(review, 'suspectedSecretValues') : undefined;
  const redacted = countAt(record, 'redactedValues');
  const revokedHandles = countAt(record, 'revokedHandleCount');
  const withheld = namesAt(record, 'withheldParams');
  const sealed = sealNote(record);
  // Looked for in what the page shows below.
  const { params, ...rest } = auditPayloadShown(record) as Record<string, unknown>;
  const masked = showsRedaction(rest) || (redacted === undefined && showsRedaction(params));
  if (
    reviewed === undefined &&
    redacted === undefined &&
    revokedHandles === undefined &&
    withheld === undefined &&
    sealed === undefined &&
    !masked
  ) {
    return null;
  }
  return (
    <ul
      className="m-0 flex list-none flex-col gap-0.5 p-0 text-13 text-text-2"
      data-testid="audit-payload-notes"
    >
      {reviewed !== undefined ? (
        <li data-testid="audit-credential-review" data-confirmed={review?.confirmed === true}>
          {review?.confirmed === true
            ? t(
                `内容含 ${reviewed} 处疑似凭据，操作人已确认「已核对凭据」。`,
                `The content held ${reviewed} suspected credential value(s); the actor confirmed they were reviewed.`,
              )
            : t(
                `参数含 ${reviewed} 处疑似凭据，已记录（这类调用不经人确认）。`,
                `The parameters held ${reviewed} suspected credential value(s), recorded (this kind of call asks nobody to confirm).`,
              )}
        </li>
      ) : null}
      {redacted !== undefined ? (
        <li data-testid="audit-redacted-values">
          {t(
            `审计记录里隐藏了参数中的 ${redacted} 处疑似凭据（只隐藏这份记录，调用本身按原样执行）。`,
            `${redacted} suspected credential value(s) are hidden in this audit copy of the parameters (the call itself ran with them as sent).`,
          )}
        </li>
      ) : null}
      {withheld !== undefined ? (
        <li data-testid="audit-withheld-params">
          {t(
            `评测用例的${withheld.map((name) => (Object.hasOwn(WITHHELD_PARAM_LABELS, name) ? WITHHELD_PARAM_LABELS[name]?.zh : name)).join('、')}不写进审计记录，只存在用例集里（智能体读不到），在「治理 → 评测」打开用例查看。`,
            `The evaluation case's ${withheld.map((name) => (Object.hasOwn(WITHHELD_PARAM_LABELS, name) ? WITHHELD_PARAM_LABELS[name]?.en : name)).join(', ')} are not kept in the audit record: they live in the suite only (no agent reads them); open the case under Govern → Evaluation.`,
          )}
        </li>
      ) : null}
      {sealed !== undefined ? (
        <li data-testid="audit-evaluation-withheld">
          {t(
            `${sealed.zh}记录里不写拦下的是哪段内容、属于哪个用例。`,
            `${sealed.en} The record never says which text it was or which case it belongs to.`,
          )}
        </li>
      ) : null}
      {revokedHandles !== undefined ? (
        <li data-testid="audit-revoked-handles">
          {t(`吊销了 ${revokedHandles} 个凭证（Handle）。`, `${revokedHandles} Handle(s) revoked.`)}
        </li>
      ) : null}
      {masked ? (
        <li>
          <RedactedNote value={auditPayloadShown(record)} testId="audit-payload-redacted" />
        </li>
      ) : null}
    </ul>
  );
}
