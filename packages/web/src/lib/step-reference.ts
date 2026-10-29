import { HttpError } from './http-client.js';
import type { Translate } from './i18n.js';

/**
 * Legacy 493: `propose_procedure` / `publish_procedure`'s 400 `invalid_step_reference` read as what
 * it is — which step, which Operation or Worker, and why — instead of one sentence for every case.
 * The kernel's message is `Procedure step <index> does not resolve: <reason>`
 * (`application/worker/procedures.ts`, `ProcedureStepReferenceError`); a `details.stepIndex` is
 * read first should the kernel come to send one. Anything not recognized stays `unresolved`, so
 * the kernel's own text still shows under 「技术细节」.
 */
export interface StepReferenceRefusal {
  /** The step, counted from 0; `null` when the refusal is about the Procedure as a whole. */
  readonly stepIndex: number | null;
  readonly reason:
    | 'operation_not_published'
    | 'worker_not_published'
    | 'not_worker_kind'
    | 'no_steps'
    | 'unresolved';
  /** `operation_not_published`: the Operation's name as the kernel quoted it. */
  readonly operationName?: string;
  /** `worker_not_published` / `not_worker_kind`: the version the step names. */
  readonly version?: number;
}

const STEP_MESSAGE = /^Procedure step (-?\d+) does not resolve: ([\s\S]*)$/;

export function stepReferenceRefusalOf(err: unknown): StepReferenceRefusal | null {
  if (!(err instanceof HttpError) || err.code !== 'invalid_step_reference') return null;
  const matched = STEP_MESSAGE.exec(err.message);
  const fromDetails = err.details?.stepIndex;
  const index =
    typeof fromDetails === 'number' ? fromDetails : matched ? Number(matched[1]) : Number.NaN;
  const stepIndex = Number.isInteger(index) && index >= 0 ? index : null;
  const reason = matched?.[2] ?? '';
  if (/at least one step/.test(reason)) return { stepIndex: null, reason: 'no_steps' };
  const operation = /^Operation "((?:[^"\\]|\\.)*)" on Gatekeeper \S+ is not published/.exec(
    reason,
  );
  if (operation) {
    return {
      stepIndex,
      reason: 'operation_not_published',
      operationName: jsonString(operation[1] ?? ''),
    };
  }
  const worker = /^WorkerDefinition \S+@(\d+) is (not published|\w+-kind)/.exec(reason);
  if (worker) {
    return {
      stepIndex,
      reason: worker[2] === 'not published' ? 'worker_not_published' : 'not_worker_kind',
      version: Number(worker[1]),
    };
  }
  return { stepIndex, reason: 'unresolved' };
}

/** The kernel quotes a name as a JSON string (`quotedName`): read it back, or keep it as sent. */
function jsonString(body: string): string {
  try {
    const parsed: unknown = JSON.parse(`"${body}"`);
    return typeof parsed === 'string' ? parsed : body;
  } catch {
    return body;
  }
}

/** Why the step does not resolve, and what to do — said of the step's own field, so the field
 *  already names the step and what it refers to. */
export function stepReferenceReasonText(refusal: StepReferenceRefusal, t: Translate): string {
  switch (refusal.reason) {
    case 'operation_not_published':
      return t(
        '这个 Operation 没有发布，或已不存在。先到能力目录发布它，或换一个已发布的 Operation。',
        'This Operation is not published, or no longer exists. Publish it in the catalog first, or choose a published one.',
      );
    case 'worker_not_published':
      return t(
        `这个 Worker 定义的 v${refusal.version} 没有发布，或已弃用、已丢弃。换一个已发布的版本。`,
        `Version ${refusal.version} of this Worker definition is not published, or was deprecated or discarded. Choose a published version.`,
      );
    case 'not_worker_kind':
      return t(
        '这是入口定义，流程的步骤只能交给 Worker 执行。换一个 Worker 定义。',
        'This is an entry definition; a Procedure step runs on a Worker. Choose a Worker definition.',
      );
    case 'no_steps':
      return t(
        '流程至少要有一步才能发布。',
        'A Procedure needs at least one step to be published.',
      );
    case 'unresolved':
      return t(
        '这一步引用的对象现在无法解析。检查后再试。',
        'What this step refers to cannot be resolved now. Check it and try again.',
      );
  }
}

/** The whole refusal in one sentence, step and object named, for a place that shows no step
 *  fields (a toast, a banner): 「第 2 步：……」. */
export function stepReferenceText(refusal: StepReferenceRefusal, t: Translate): string {
  const reason = stepReferenceReasonText(refusal, t);
  if (refusal.stepIndex === null) return reason;
  const step = refusal.stepIndex + 1;
  const what =
    refusal.reason === 'operation_not_published' && refusal.operationName !== undefined
      ? t(`（Operation「${refusal.operationName}」）`, ` (Operation “${refusal.operationName}”)`)
      : refusal.reason === 'worker_not_published' || refusal.reason === 'not_worker_kind'
        ? t('（Worker 定义）', ' (Worker definition)')
        : '';
  return t(`第 ${step} 步${what}：${reason}`, `Step ${step}${what}: ${reason}`);
}
