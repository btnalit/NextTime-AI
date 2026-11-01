import {
  type PlanHint,
  type PlanRevisionWire,
  type StepAdmission,
  type StepTrialApprovalWire,
  type WorkerSpec,
  stepAdmissionOf,
} from '@nexttime/shared';
import { shortId } from './format.js';
import { stepHintChipLabel } from './goals.js';
import type { Translate } from './i18n.js';

/**
 * lib/worker-spec-detail (S11 GO15a; `s11-w2/go15-default-plan.md` §2): a step's WorkerSpec read
 * against the WorkerDefinition version it sits on — what it keeps, drops and adds, field by field —
 * and the one admission verdict the page states for the step. Both are projections: the definition
 * version is immutable and read by version (`get_worker_definition`); the verdict is the kernel's
 * hints classed by `stepAdmissionOf` (shared), never the console's own judgment of authority.
 */

/** The fields of a WorkerDefinition's content a WorkerSpec can replace, read defensively (the
 *  wire carries the content as a record). A field absent here is one the definition leaves out. */
export interface WorkerSpecBase {
  readonly name: string | null;
  readonly skills?: readonly string[];
  readonly gates?: readonly string[];
  readonly capabilities?: readonly string[];
  readonly model?: string;
}

const strings = (value: unknown): readonly string[] | undefined =>
  Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? (value as string[])
    : undefined;

export function workerSpecBaseOf(definition: Readonly<Record<string, unknown>>): WorkerSpecBase {
  const name =
    typeof definition.name === 'string' && definition.name !== '' ? definition.name : null;
  const skills = strings(definition.skills);
  const gates = strings(definition.gates);
  const capabilities = strings(definition.capabilities);
  const model =
    typeof definition.model === 'string' && definition.model !== '' ? definition.model : undefined;
  return {
    name,
    ...(skills ? { skills } : {}),
    ...(gates ? { gates } : {}),
    ...(capabilities ? { capabilities } : {}),
    ...(model !== undefined ? { model } : {}),
  };
}

/** A list a WorkerSpec sets, against the definition's: what it keeps, drops and adds, each in the
 *  order its own list has it. `base` absent: the definition leaves the list out. */
export interface SpecListComparison {
  readonly kept: readonly string[];
  readonly removed: readonly string[];
  readonly added: readonly string[];
}

export function specListAgainst(
  base: readonly string[] | undefined,
  spec: readonly string[],
): SpecListComparison {
  const before = new Set(base ?? []);
  const after = new Set(spec);
  return {
    kept: spec.filter((item) => before.has(item)),
    removed: (base ?? []).filter((item) => !after.has(item)),
    added: spec.filter((item) => !before.has(item)),
  };
}

/** The fields of the definition a WorkerSpec leaves as they are — what the step keeps from its
 *  Worker besides its system prompt. Only fields the definition itself sets. */
export function inheritedBaseFields(
  spec: WorkerSpec,
  base: WorkerSpecBase,
): readonly ('skills' | 'gates' | 'capabilities' | 'model')[] {
  return (['skills', 'gates', 'capabilities', 'model'] as const).filter(
    (field) => base[field] !== undefined && spec[field] === undefined,
  );
}

// ---------------------------------------------------------------------------------------------
// The admission verdict
// ---------------------------------------------------------------------------------------------

/**
 * What the page says of a step's admission:
 *   - `checked`: the read checked the step's start (`checkedStepKeys`): the kernel's verdict now;
 *   - `admitted`: it started — its first attempt was admitted (`viaTrial`: with an approved trial
 *     of its draft Skills); a retry is checked again when it starts;
 *   - `at_start`: not checked now (the run is running, or the revision is no longer decided on) —
 *     the platform admits it when its first attempt would start.
 */
export type StepAdmissionView =
  | { readonly kind: 'checked'; readonly admission: StepAdmission }
  | { readonly kind: 'admitted'; readonly viaTrial: boolean }
  | { readonly kind: 'at_start' };

export function stepAdmissionView(
  revision: Pick<PlanRevisionWire, 'hints' | 'checkedStepKeys'>,
  stepKey: string,
  run: { readonly attemptCount: number } | null,
  trials: readonly Pick<StepTrialApprovalWire, 'state'>[],
): StepAdmissionView {
  if (revision.checkedStepKeys.includes(stepKey)) {
    return { kind: 'checked', admission: stepAdmissionOf(revision.hints, stepKey) };
  }
  if (run !== null && run.attemptCount > 0) {
    return { kind: 'admitted', viaTrial: trials.some((trial) => trial.state === 'used') };
  }
  return { kind: 'at_start' };
}

/** The verdict, as the line under a step says it: 「准入：…」. */
export function stepAdmissionText(view: StepAdmissionView, t: Translate): string {
  switch (view.kind) {
    case 'checked':
      switch (view.admission.verdict) {
        case 'run':
          return t('准入：可以开始', 'Admission: it would start');
        case 'needs_approval':
          return t(
            '准入：要有人批准试用它的 Skill 草稿才会开始',
            'Admission: it starts once someone approves a trial of its draft Skills',
          );
        case 'refused':
          return t('准入：现在不会开始', 'Admission: it would not start now');
      }
      break;
    case 'admitted':
      return view.viaTrial
        ? t(
            '准入：第 1 次尝试开始时，经试用批准后准入',
            'Admission: its first attempt was admitted with an approved trial',
          )
        : t('准入：第 1 次尝试开始时已准入', 'Admission: admitted when its first attempt started');
    case 'at_start':
      return t(
        '准入：开始时由平台检查（现在不检查）',
        'Admission: the platform checks it when it starts (not checked now)',
      );
  }
  return '';
}

/** The hints a `checked` verdict rests on (none for `run` and the other kinds). */
export function stepAdmissionHints(view: StepAdmissionView): readonly PlanHint[] {
  return view.kind === 'checked' && view.admission.verdict !== 'run' ? view.admission.hints : [];
}

/** Why a `checked` verdict is not `run`, one short label per hint — the step's chips, a gate the
 *  requester cannot act on by name (UX P3-5 on #888), and for the one plan-wide hint that stops
 *  every step, what it says. */
export function stepAdmissionReasons(
  view: StepAdmissionView,
  t: Translate,
  gateNames: ReadonlyMap<string, string> = new Map(),
): readonly string[] {
  return [...new Set(stepAdmissionHints(view).map((hint) => admissionReason(hint, gateNames, t)))];
}

function admissionReason(
  hint: PlanHint,
  gateNames: ReadonlyMap<string, string>,
  t: Translate,
): string {
  const gates = hint.code === 'step_gate_not_held' ? (hint.gatekeeperIds ?? []) : [];
  if (gates.length > 0) {
    const names = gates.map((id) => gateNames.get(id) ?? shortId(id));
    return t(
      `请求人不能操作门 ${names.join('、')}`,
      `The requester cannot act on Gatekeeper${names.length > 1 ? 's' : ''} ${names.join(', ')}`,
    );
  }
  return (
    stepHintChipLabel(hint, t) ??
    t('请求人现在不能启动 Worker', 'The requester cannot start Workers now')
  );
}

/** UX P3-4 on #888: what accepting a revision leads to at a step the read checked and would not
 *  start as it is — the goal stops there — one confirm line per step, in the plan's order. */
export function admissionStopLines(
  revision: Pick<PlanRevisionWire, 'hints' | 'checkedStepKeys'>,
  gateNames: ReadonlyMap<string, string>,
  t: Translate,
): string[] {
  const lines: string[] = [];
  for (const key of revision.checkedStepKeys) {
    const view = stepAdmissionView(revision, key, null, []);
    if (view.kind !== 'checked') continue;
    if (view.admission.verdict === 'needs_approval') {
      lines.push(
        t(
          `步骤 ${key} 要有人批准试用它的 Skill 草稿才会开始，目标会停在这一步等批准`,
          `Step ${key} starts only once someone approves a trial of its draft Skills: the goal stops there until then`,
        ),
      );
    } else if (view.admission.verdict === 'refused') {
      const reasons = stepAdmissionReasons(view, t, gateNames);
      lines.push(
        t(
          `步骤 ${key} 现在不会开始（${reasons.join('、')}），目标会停在这一步`,
          `Step ${key} would not start now (${reasons.join('; ')}): the goal stops there`,
        ),
      );
    }
  }
  return lines;
}
