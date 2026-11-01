import {
  type OutputSchema,
  type ProcedureStep,
  type ProposeProcedureContent,
  ProposeProcedureContentSchema,
  type ProposeSkillContent,
  ProposeSkillContentSchema,
  PublishedSkillNameSchema,
  StepOutputSchemaSchema,
  type WorkerDefinitionKind,
  workerDefinitionContentSchemaFor,
} from '@nexttime/shared';
import {
  type FactCheckDraft,
  emptyFactCheckDraft,
  factCheckDraftFrom,
  factCheckDraftProblems,
  factCheckFromDraft,
} from './fact-check-draft.js';
import type { CapabilityNameRow } from './governance.js';
import type { Translate } from './i18n.js';
import {
  type PredicateDraft,
  emptyPredicateDraft,
  predicateDraftFrom,
  predicateDraftProblems,
  predicateFromDraft,
} from './predicate-draft.js';
import {
  type SchemaDraft,
  schemaDraftFrom,
  schemaFromDraft,
  schemaRowProblems,
} from './schema-fields.js';
import { OPS_RUNNER_WORKER_TEMPLATE } from './templates/ops-runner.js';

/**
 * lib/catalog: pure helpers behind the catalog editors (S6-A A2 — docs/console-completion-plan.md
 * §5.3 "Skill / Procedure / Worker 编辑器"): form ↔ wire-content mapping, validation against the
 * shared Zod content schemas (`packages/shared/src/skill.ts` / `procedure.ts` /
 * `worker-definition.ts` — the same schemas the kernel's `propose_*` handlers parse the opaque
 * `skill` / `procedure` / `definition` records with), field-level error extraction, and a
 * minimal Markdown block parser for the SKILL.md preview (no dependency, no HTML — the preview
 * renders blocks as React elements, never `innerHTML`).
 *
 * Kernel shapes these helpers encode rather than paper over (verified in
 * `packages/shared/src/capabilities.ts` and the kernel handlers):
 *   - `propose_skill{skill}` / `propose_procedure{procedure}` carry no family id (the handler
 *     parses `.strict()` content schemas) — "编辑（生成新草稿版本）" for a Skill / Procedure can
 *     only start a **new family** (new id, version 1) pre-filled from the row; the editors say so.
 *   - `list_skills` rows have no `markdown` and there is no `get_skill` — a Skill copy pre-fills
 *     name / description / applicable but the body must be re-entered.
 *   - `propose_worker_definition{definitionId?, kind, definition}` does address a family:
 *     `definitionId` given → the next version under that id; `kind` is immutable per family.
 *   - S8 W1-C (#243, leftover 48 pagination list) made `list_skills` / `list_procedures` /
 *     `list_worker_definitions` keyset-paginated (`limit?`/`cursor?`, default 100, max 500,
 *     `{items, nextCursor?, truncated?}`) — the note this comment carried until S8 W1-A4 ("noParams
 *     / stays single-page / passing paging params would be a 400") predates that and no longer
 *     holds. `CatalogPage.tsx`'s three browsable tabs (Skills/Procedures/Workers) offer "加载更多"
 *     via `useCapabilityList`'s `loadMore`; the two picker directories it also reads
 *     (`ProcedureEditorHost`'s `list_worker_definitions`, this file's own callers via
 *     `AgentProfilePage`/`ModelsPage`) pass `{ autoLoadAll: true }` instead, since a step/skill
 *     picker silently missing rows past page one is a correctness bug, not a paging UX choice.
 */

/** `path → message` from a failed `safeParse`, first message per path (the form shows one). */
export type FieldErrors = Readonly<Record<string, string>>;

interface IssueLike {
  readonly path: readonly PropertyKey[];
  readonly message: string;
  readonly code?: string;
  /** What a size issue measured: `string`, `array`, `number`, ... */
  readonly origin?: string;
  readonly minimum?: unknown;
  readonly maximum?: unknown;
  /** Present only when the parse was asked to report it. */
  readonly input?: unknown;
  readonly format?: string;
  readonly values?: readonly unknown[];
}

/** An `invalid_type` issue for a value that is not there at all. Zod names what it received
 *  only in the message unless the parse reported its input. */
function isMissing(issue: IssueLike): boolean {
  return 'input' in issue
    ? issue.input === undefined || issue.input === null
    : /received (undefined|null)$/.test(issue.message);
}

/** The shared schemas' only `custom` issues are a Worker definition's `egressDeny` entries
 *  (`EgressDenyListSchema`, English by design: the kernel and CLI read it too). Each problem it
 *  can name gets its own sentence here, so the editor never shows that English (audit P3). */
const EGRESS_DENY_ISSUE = /^egressDeny entry "(.*)" (.*)$/s;

function customIssueMessage(message: string, t: Translate): string {
  const match = EGRESS_DENY_ISSUE.exec(message);
  if (!match) return t('这一项的值不被接受', 'This value is not accepted');
  const entry = match[1] ?? '';
  const problem = match[2] ?? '';
  if (problem.startsWith('is an IP address')) {
    return t(
      `「${entry}」是 IP 地址：这里只填主机名（私有网段已经按地址拦截）`,
      `"${entry}" is an IP address: list host names only (private ranges are already denied by address)`,
    );
  }
  if (problem.startsWith('starts with')) {
    return t(
      `「${entry}」不要以 *. 或 . 开头：直接写域名，它已包含所有子域名`,
      `"${entry}" must not start with *. or .: write the bare domain, which covers every subdomain`,
    );
  }
  if (problem.startsWith('contains "*"')) {
    return t(`「${entry}」里不支持通配符 *`, `"${entry}" contains *; wildcards are not supported`);
  }
  if (problem === 'is empty') return t('不能留空', 'Must not be empty');
  return t(
    `「${entry}」不是合法的主机名：不要带协议、端口、路径、网段或空格`,
    `"${entry}" is not a host name: no scheme, port, path, CIDR or spaces`,
  );
}

/** One schema issue as a sentence in the viewer's language (console audit P1-1 follow-up): the
 *  shared schemas carry zod's default English ("Too small: expected string to have >=1 characters"),
 *  which an editor field must not show as is. A rule-specific refinement keeps its own words
 *  after a Chinese lead, since they name what exactly was refused. */
export function issueMessage(issue: IssueLike, t: Translate): string {
  const min =
    typeof issue.minimum === 'number' || typeof issue.minimum === 'bigint'
      ? Number(issue.minimum)
      : null;
  const max =
    typeof issue.maximum === 'number' || typeof issue.maximum === 'bigint'
      ? Number(issue.maximum)
      : null;
  switch (issue.code) {
    case 'invalid_type':
      return isMissing(issue) ? t('必填', 'Required') : t('格式不对', 'Wrong format');
    case 'too_small':
      if (issue.origin === 'string') {
        return min !== null && min <= 1
          ? t('必填', 'Required')
          : t(`至少 ${min} 个字符`, `At least ${min} characters`);
      }
      if (issue.origin === 'array') {
        return t(`至少 ${min} 项`, `At least ${min} items`);
      }
      return t(`不能小于 ${min}`, `Must be at least ${min}`);
    case 'too_big':
      if (issue.origin === 'string') return t(`最多 ${max} 个字符`, `At most ${max} characters`);
      if (issue.origin === 'array') return t(`最多 ${max} 项`, `At most ${max} items`);
      return t(`不能大于 ${max}`, `Must be at most ${max}`);
    case 'invalid_value': {
      const options = (issue.values ?? []).map(String).join('、');
      return t(`只能是：${options}`, `Must be one of: ${options}`);
    }
    case 'invalid_format':
      return issue.format === 'url'
        ? t('不是合法的网址', 'Not a valid URL')
        : t('格式不对', 'Wrong format');
    case 'custom':
      return customIssueMessage(issue.message, t);
    default:
      return t('这一项的值不被接受', 'This value is not accepted');
  }
}

export function fieldErrorsFromIssues(issues: readonly IssueLike[], t: Translate): FieldErrors {
  const errors: Record<string, string> = {};
  for (const issue of issues) {
    const key = issue.path.length === 0 ? '_' : issue.path.map(String).join('.');
    if (!(key in errors)) errors[key] = issueMessage(issue, t);
  }
  return errors;
}

/** "a, b\nc" → ['a', 'b', 'c'] — comma / newline separated, trimmed, blanks dropped. */
export function splitList(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

export function joinList(items: readonly string[] | undefined): string {
  return (items ?? []).join('\n');
}

// -------------------------------------------------------------------------------------------
// Skill (SKILL.md form: frontmatter fields + Markdown body)
// -------------------------------------------------------------------------------------------

export interface SkillForm {
  readonly name: string;
  readonly description: string;
  readonly markdown: string;
  /** Comma / newline separated Gatekeeper transport kinds (`applicable.gateKinds`). */
  readonly gateKinds: string;
  /** Comma / newline separated ObjectTypes (`applicable.objectTypes`). */
  readonly objectTypes: string;
}

export const EMPTY_SKILL_FORM: SkillForm = {
  name: '',
  description: '',
  markdown: '',
  gateKinds: '',
  objectTypes: '',
};

/** The `propose_skill{skill}` payload from the form — `applicable` only when either list is
 *  non-empty (an omitted array means "not specifically scoped", `SkillApplicableSchema`). */
export function skillContentFromForm(form: SkillForm): Record<string, unknown> {
  const gateKinds = splitList(form.gateKinds);
  const objectTypes = splitList(form.objectTypes);
  const applicable: Record<string, unknown> = {};
  if (gateKinds.length > 0) applicable.gateKinds = gateKinds;
  if (objectTypes.length > 0) applicable.objectTypes = objectTypes;
  return {
    name: form.name.trim(),
    description: form.description.trim(),
    markdown: form.markdown,
    ...(Object.keys(applicable).length > 0 ? { applicable } : {}),
  };
}

export type ValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly errors: FieldErrors };

/** Propose-time validation (`ProposeSkillContentSchema` — permissive, see skill.ts). */
export function validateSkill(
  form: SkillForm,
  t: Translate,
): ValidationResult<ProposeSkillContent> {
  const parsed = ProposeSkillContentSchema.safeParse(skillContentFromForm(form));
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, errors: fieldErrorsFromIssues(parsed.error.issues, t) };
}

/** Publish-time name rule (pi Agent Skills: 1-64 lowercase letters / digits / single hyphens) —
 *  surfaced as a warning while drafting so the later `publish_skill` does not surprise. */
export function skillNamePublishWarning(name: string, t: Translate): string | undefined {
  if (name.trim() === '') return undefined;
  const parsed = PublishedSkillNameSchema.safeParse(name.trim());
  return parsed.success
    ? undefined
    : t(
        '发布时要求：1–64 个小写字母 / 数字，单个连字符分隔，不能以连字符开头或结尾（pi Skill 命名规则）。',
        'Publish requires 1–64 lowercase letters / digits with single hyphens, none leading or trailing (pi Agent Skills name rule).',
      );
}

// -------------------------------------------------------------------------------------------
// Procedure (name + description + typed steps)
// -------------------------------------------------------------------------------------------

export type ProcedureStepKind = ProcedureStep['kind'];
export const PROCEDURE_STEP_KINDS: readonly ProcedureStepKind[] = [
  'operation',
  'worker',
  'approval',
  'verify',
];

/** A binding of a `worker` step as the form edits it (S11 GO5d-2 `ProcedureBindingSchema`; legacy
 *  453): where in the input (`to`), from what (an earlier step's key, or
 *  {@link PROCEDURE_PARAMS_SOURCE}), read with `path`. */
export interface ProcedureBindingForm {
  /** React key; never sent. */
  readonly uid: string;
  readonly to: string;
  readonly from: string;
  readonly path: string;
}

/** What checks a `verify` step in a goal made from the Procedure (legacy 453): the requester, on
 *  its description (`none`); the platform observing a gate's Operation; the platform confirming on
 *  a gate that something is not there (S11 「门确认不存在」 B); the platform judging a Fact of the
 *  graph; or a check the form cannot read, kept as JSON. */
export type ProcedureCheckKind =
  | 'none'
  | 'observe_predicate'
  | 'observe_absent'
  | 'fact_predicate'
  | 'json';

/** One step as the form edits it — every field a string so a half-typed step is representable;
 *  `procedureStepToWire` turns it into the wire shape. A step keeps the fields of every kind while
 *  it is edited (changing its kind and back loses nothing); only its kind's are sent. */
export interface ProcedureStepForm {
  /** A client-side identity for React keys (steps are re-ordered and re-typed in place);
   *  never sent on the wire. */
  readonly key: string;
  readonly kind: ProcedureStepKind;
  readonly gatekeeperId: string;
  readonly operationName: string;
  readonly definitionId: string;
  readonly version: string;
  readonly description: string;
  // S11 GO5d-2 / legacy 453: what a `worker` step says of the plan step it becomes.
  /** Its key in the plan; `''`: `step-<n>` ({@link procedurePlanKey}). */
  readonly stepKey: string;
  /** The steps it waits for; `null`: the `worker` step before it. */
  readonly dependsOn: readonly string[] | null;
  /** `''`: the platform's default. */
  readonly maxAttempts: string;
  /** The input as JSON text; `''`: none. */
  readonly inputText: string;
  readonly bindings: readonly ProcedureBindingForm[];
  /** `null`: no output contract. */
  readonly outputSchema: SchemaDraft | null;
  // S11 GO5d-2 / legacy 453: a `verify` step's check.
  readonly checkKind: ProcedureCheckKind;
  readonly checkKey: string;
  readonly checkGatekeeperId: string;
  readonly checkOperation: string;
  /** JSON texts; `''`: absent. */
  readonly checkParamsText: string;
  /** Legacy 464: what the observed result must satisfy, as the predicate editor edits it. */
  readonly checkExpect: PredicateDraft;
  /** Legacy 464: the Fact judged, as the Fact check editor edits it. */
  readonly checkFact: FactCheckDraft;
  /** `checkKind: 'json'` only: the check as it came. */
  readonly checkJsonText: string;
}

let stepCounter = 0;
/** A fresh client key per step (module-local counter — unique within a page load). */
export function nextStepKey(): string {
  stepCounter += 1;
  return `step-${stepCounter}`;
}

let bindingCounter = 0;
export function newProcedureBinding(): ProcedureBindingForm {
  bindingCounter += 1;
  return { uid: `binding-${bindingCounter}`, to: '', from: '', path: '' };
}

export const EMPTY_STEP: ProcedureStepForm = {
  key: 'step-0',
  kind: 'approval',
  gatekeeperId: '',
  operationName: '',
  definitionId: '',
  version: '1',
  description: '',
  stepKey: '',
  dependsOn: null,
  maxAttempts: '',
  inputText: '',
  bindings: [],
  outputSchema: null,
  checkKind: 'none',
  checkKey: '',
  checkGatekeeperId: '',
  checkOperation: '',
  checkParamsText: '',
  checkExpect: emptyPredicateDraft(),
  checkFact: emptyFactCheckDraft(),
  checkJsonText: '',
};

export interface ProcedureForm {
  readonly name: string;
  readonly description: string;
  readonly steps: readonly ProcedureStepForm[];
  /** S11 GO5d-2 / legacy 453: the parameters a goal made from it is proposed with; absent or
   *  `null`: it takes none. */
  readonly parameters?: SchemaDraft | null;
}

export const EMPTY_PROCEDURE_FORM: ProcedureForm = { name: '', description: '', steps: [] };

/** The form for a Procedure's content (a row to copy, or the JSON view's) — its steps, and its
 *  parameters when it has any. */
export function procedureFormFrom(content: {
  readonly name?: unknown;
  readonly description?: unknown;
  readonly steps?: unknown;
  readonly parameters?: unknown;
}): ProcedureForm {
  return {
    name: typeof content.name === 'string' ? content.name : '',
    description: typeof content.description === 'string' ? content.description : '',
    steps: Array.isArray(content.steps) ? content.steps.map(procedureStepFromWire) : [],
    ...(content.parameters !== undefined && content.parameters !== null
      ? { parameters: schemaDraftFrom(content.parameters) }
      : {}),
  };
}

/** A `worker` step's key in the goal's plan — its own, else `step-<n>` with n its 1-based place
 *  among all the Procedure's steps (the kernel's `from-procedure.ts`). */
export function procedurePlanKey(step: ProcedureStepForm, index: number): string {
  return step.stepKey.trim() || `step-${index + 1}`;
}

/** The plan keys of the `worker` steps, in order, with each step's index. */
export function procedureWorkerKeys(
  steps: readonly ProcedureStepForm[],
): readonly { readonly index: number; readonly key: string }[] {
  return steps.flatMap((step, index) =>
    step.kind === 'worker' ? [{ index, key: procedurePlanKey(step, index) }] : [],
  );
}

/** The key a `worker` step waits for when it names none: the `worker` step before it. */
export function procedurePreviousWorkerKey(
  steps: readonly ProcedureStepForm[],
  index: number,
): string | null {
  const before = procedureWorkerKeys(steps).filter((worker) => worker.index < index);
  return before.at(-1)?.key ?? null;
}

/** UX P2-2 on #738: each `worker` step's plan key → the keys it waits for (its own list, else the
 *  `worker` step before it). */
export function procedureWaits(
  steps: readonly ProcedureStepForm[],
): ReadonlyMap<string, readonly string[]> {
  const waits = new Map<string, readonly string[]>();
  let previous: string | null = null;
  for (const [index, step] of steps.entries()) {
    if (step.kind !== 'worker') continue;
    const key = procedurePlanKey(step, index);
    waits.set(key, step.dependsOn ?? (previous !== null ? [previous] : []));
    previous = key;
  }
  return waits;
}

/** UX P2-2 on #738: the keys of the `worker` steps that wait for `key`, directly or through
 *  others — a step `key` must not wait for (or take from) any of them: that is a cycle. `key`
 *  itself is among them when it already is in one. */
export function procedureWaiters(
  steps: readonly ProcedureStepForm[],
  key: string,
): ReadonlySet<string> {
  const waits = procedureWaits(steps);
  const waiters = new Set<string>();
  const queue = [key];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const [other, deps] of waits) {
      if (deps.includes(current) && !waiters.has(other)) {
        waiters.add(other);
        queue.push(other);
      }
    }
  }
  return waiters;
}

/** Keys that some step names — in an explicit `dependsOn` or a binding's `from`. */
function referencedKeys(steps: readonly ProcedureStepForm[]): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const step of steps) {
    if (step.kind !== 'worker') continue;
    for (const key of step.dependsOn ?? []) keys.add(key);
    for (const binding of step.bindings) keys.add(binding.from);
  }
  return keys;
}

/**
 * Legacy 453: the steps after a move or a removal, with every `worker` step that is named by its
 * default key (`step-<n>`, n its place) keeping the key it had — so a dependency or a binding that
 * named it still names it, and never silently names whichever step now sits at its old place. A
 * step keeps its key only when that key, or the one it would get, is named somewhere: a Procedure
 * whose steps simply follow one another gets no keys written into it.
 */
export function withPlanKeysKept(
  before: readonly ProcedureStepForm[],
  after: readonly ProcedureStepForm[],
): readonly ProcedureStepForm[] {
  const previous = new Map(before.map((step, index) => [step.key, procedurePlanKey(step, index)]));
  const named = referencedKeys(after);
  return after.map((step, index) => {
    if (step.kind !== 'worker' || step.stepKey.trim() !== '') return step;
    const was = previous.get(step.key);
    const now = procedurePlanKey(step, index);
    if (was === undefined || was === now || (!named.has(was) && !named.has(now))) return step;
    return { ...step, stepKey: was };
  });
}

/** Legacy 453: the steps with every dependency and binding that named `from` naming `to` instead —
 *  a `worker` step's key renamed in the form. */
export function withPlanKeyRenamed(
  steps: readonly ProcedureStepForm[],
  from: string,
  to: string,
): readonly ProcedureStepForm[] {
  if (from === to) return steps;
  return steps.map((step) =>
    step.kind !== 'worker'
      ? step
      : {
          ...step,
          dependsOn: step.dependsOn?.map((key) => (key === from ? to : key)) ?? null,
          bindings: step.bindings.map((binding) =>
            binding.from === from ? { ...binding, from: to } : binding,
          ),
        },
  );
}

export function newProcedureStep(): ProcedureStepForm {
  return { ...EMPTY_STEP, key: nextStepKey() };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function jsonText(value: unknown): string {
  return value === undefined ? '' : JSON.stringify(value, null, 2);
}

/** A `verify` step's check as the form edits it — the fields of the kind it is, or its JSON when
 *  the form cannot read it. */
function checkFormFrom(check: unknown): Partial<ProcedureStepForm> {
  if (check === undefined) return {};
  const shaped = (keys: readonly string[], value: Record<string, unknown>) =>
    Object.keys(value).every((key) => keys.includes(key));
  if (isRecord(check) && (check.key === undefined || typeof check.key === 'string')) {
    const key = typeof check.key === 'string' ? check.key : '';
    const observed = check.check;
    if (
      check.kind === 'observe_predicate' &&
      shaped(['kind', 'key', 'check'], check) &&
      (observed === undefined ||
        (isRecord(observed) &&
          shaped(['gatekeeperId', 'operation', 'params', 'expect'], observed) &&
          (observed.gatekeeperId === undefined || typeof observed.gatekeeperId === 'string') &&
          (observed.operation === undefined || typeof observed.operation === 'string')))
    ) {
      const fields = isRecord(observed) ? observed : {};
      return {
        checkKind: 'observe_predicate',
        checkKey: key,
        checkGatekeeperId: typeof fields.gatekeeperId === 'string' ? fields.gatekeeperId : '',
        checkOperation: typeof fields.operation === 'string' ? fields.operation : '',
        checkParamsText: jsonText(fields.params),
        checkExpect: predicateDraftFrom(fields.expect),
      };
    }
    if (
      check.kind === 'observe_absent' &&
      shaped(['kind', 'key', 'check'], check) &&
      (observed === undefined ||
        (isRecord(observed) &&
          shaped(['gatekeeperId', 'operation', 'params'], observed) &&
          (observed.gatekeeperId === undefined || typeof observed.gatekeeperId === 'string') &&
          (observed.operation === undefined || typeof observed.operation === 'string')))
    ) {
      const fields = isRecord(observed) ? observed : {};
      return {
        checkKind: 'observe_absent',
        checkKey: key,
        checkGatekeeperId: typeof fields.gatekeeperId === 'string' ? fields.gatekeeperId : '',
        checkOperation: typeof fields.operation === 'string' ? fields.operation : '',
        checkParamsText: jsonText(fields.params),
      };
    }
    if (check.kind === 'fact_predicate' && shaped(['kind', 'key', 'fact'], check)) {
      return {
        checkKind: 'fact_predicate',
        checkKey: key,
        checkFact: factCheckDraftFrom(check.fact),
      };
    }
  }
  return { checkKind: 'json', checkJsonText: jsonText(check) };
}

export function procedureStepFromWire(step: unknown): ProcedureStepForm {
  const record = isRecord(step) ? step : {};
  const str = (key: string): string => (typeof record[key] === 'string' ? record[key] : '');
  const kind = PROCEDURE_STEP_KINDS.includes(record.kind as ProcedureStepKind)
    ? (record.kind as ProcedureStepKind)
    : 'approval';
  const base: ProcedureStepForm = {
    ...EMPTY_STEP,
    key: nextStepKey(),
    kind,
    gatekeeperId: str('gatekeeperId'),
    operationName: str('operationName'),
    definitionId: str('definitionId'),
    version: typeof record.version === 'number' ? String(record.version) : '1',
    description: str('description'),
  };
  if (kind === 'worker') {
    const text = (value: unknown) => (typeof value === 'string' ? value : '');
    return {
      ...base,
      stepKey: str('key'),
      dependsOn: Array.isArray(record.dependsOn)
        ? record.dependsOn.filter((key): key is string => typeof key === 'string')
        : null,
      maxAttempts: typeof record.maxAttempts === 'number' ? String(record.maxAttempts) : '',
      inputText: jsonText(record.input),
      bindings: Array.isArray(record.bindings)
        ? record.bindings.map((binding) => {
            const fields = isRecord(binding) ? binding : {};
            return {
              ...newProcedureBinding(),
              to: text(fields.to),
              from: text(fields.from),
              path: text(fields.path),
            };
          })
        : [],
      outputSchema: record.outputSchema === undefined ? null : schemaDraftFrom(record.outputSchema),
    };
  }
  if (kind === 'verify') return { ...base, ...checkFormFrom(record.check) };
  return base;
}

/** A JSON text as the value it says — or, when it does not parse, the text itself (the JSON view
 *  shows it as typed, and validation says where). */
function parsedOr(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function schemaValue(draft: SchemaDraft): unknown {
  const schema = schemaFromDraft(draft);
  return schema.ok ? schema.value : schema.text;
}

function checkToWire(step: ProcedureStepForm): Record<string, unknown> {
  const key = step.checkKey.trim();
  switch (step.checkKind) {
    case 'none':
      return {};
    case 'json':
      return step.checkJsonText.trim() === '' ? {} : { check: parsedOr(step.checkJsonText) };
    case 'observe_predicate':
      return {
        check: {
          kind: 'observe_predicate',
          key,
          check: {
            gatekeeperId: step.checkGatekeeperId.trim(),
            operation: step.checkOperation.trim(),
            ...(step.checkParamsText.trim() !== ''
              ? { params: parsedOr(step.checkParamsText) }
              : {}),
            ...(predicateFromDraft(step.checkExpect) !== undefined
              ? { expect: predicateFromDraft(step.checkExpect) }
              : {}),
          },
        },
      };
    case 'observe_absent':
      return {
        check: {
          kind: 'observe_absent',
          key,
          check: {
            gatekeeperId: step.checkGatekeeperId.trim(),
            operation: step.checkOperation.trim(),
            ...(step.checkParamsText.trim() !== ''
              ? { params: parsedOr(step.checkParamsText) }
              : {}),
          },
        },
      };
    case 'fact_predicate':
      return {
        check: {
          kind: 'fact_predicate',
          key,
          ...(factCheckFromDraft(step.checkFact) !== undefined
            ? { fact: factCheckFromDraft(step.checkFact) }
            : {}),
        },
      };
  }
}

/** The wire step for a form step — only the fields its `kind` declares (`.strict()` schemas). */
export function procedureStepToWire(step: ProcedureStepForm): Record<string, unknown> {
  const description = step.description.trim();
  switch (step.kind) {
    case 'operation':
      return {
        kind: 'operation',
        gatekeeperId: step.gatekeeperId.trim(),
        operationName: step.operationName.trim(),
        ...(description ? { description } : {}),
      };
    case 'worker': {
      const version = Number.parseInt(step.version, 10);
      const attempts = Number(step.maxAttempts);
      return {
        kind: 'worker',
        definitionId: step.definitionId.trim(),
        version: Number.isNaN(version) ? step.version : version,
        ...(description ? { description } : {}),
        ...(step.stepKey.trim() !== '' ? { key: step.stepKey.trim() } : {}),
        ...(step.dependsOn !== null ? { dependsOn: step.dependsOn } : {}),
        ...(step.inputText.trim() !== '' ? { input: parsedOr(step.inputText) } : {}),
        ...(step.bindings.length > 0
          ? {
              bindings: step.bindings.map((binding) => ({
                to: binding.to.trim(),
                from: binding.from,
                path: binding.path.trim(),
              })),
            }
          : {}),
        ...(step.outputSchema !== null ? { outputSchema: schemaValue(step.outputSchema) } : {}),
        ...(step.maxAttempts !== ''
          ? { maxAttempts: Number.isNaN(attempts) ? step.maxAttempts : attempts }
          : {}),
      };
    }
    case 'verify':
      return { kind: 'verify', description, ...checkToWire(step) };
    default:
      return { kind: step.kind, description };
  }
}

export function procedureContentFromForm(form: ProcedureForm): Record<string, unknown> {
  return {
    name: form.name.trim(),
    description: form.description.trim(),
    steps: form.steps.map(procedureStepToWire),
    ...(form.parameters ? { parameters: schemaValue(form.parameters) } : {}),
  };
}

/** What the form can tell before the schema does: JSON that does not parse, and a field list's
 *  rows without a name or with one used twice — by the content path the problem is at
 *  (`steps.0.input`; a list row as `….fields.<row>`). */
function formProblems(form: ProcedureForm, t: Translate): Record<string, string> {
  const problems: Record<string, string> = {};
  const notJson = t('不是合法的 JSON', 'Not valid JSON');
  const json = (path: string, text: string) => {
    if (text.trim() === '') return;
    try {
      JSON.parse(text);
    } catch {
      problems[path] = notJson;
    }
  };
  const schema = (path: string, draft: SchemaDraft | null | undefined) => {
    if (!draft) return;
    if (draft.mode === 'json') json(path, draft.text);
    for (const [row, problem] of schemaRowProblems(draft, t)) {
      problems[`${path}.fields.${row}`] = problem;
    }
  };
  for (const [index, step] of form.steps.entries()) {
    const at = `steps.${index}`;
    if (step.kind === 'worker') {
      json(`${at}.input`, step.inputText);
      schema(`${at}.outputSchema`, step.outputSchema);
    } else if (step.kind === 'verify') {
      if (step.checkKind === 'json') json(`${at}.check`, step.checkJsonText);
      if (step.checkKind === 'observe_predicate') {
        json(`${at}.check.check.params`, step.checkParamsText);
        for (const [path, problem] of predicateDraftProblems(step.checkExpect, t)) {
          problems[path === '' ? `${at}.check.check.expect` : `${at}.check.check.expect.${path}`] =
            problem;
        }
      }
      if (step.checkKind === 'observe_absent') {
        json(`${at}.check.check.params`, step.checkParamsText);
      }
      if (step.checkKind === 'fact_predicate') {
        for (const [path, problem] of factCheckDraftProblems(step.checkFact, t)) {
          problems[path === '' ? `${at}.check.fact` : `${at}.check.fact.${path}`] = problem;
        }
      }
    }
  }
  schema('parameters', form.parameters);
  return problems;
}

export function validateProcedure(
  form: ProcedureForm,
  t: Translate,
): ValidationResult<ProposeProcedureContent> {
  const problems = formProblems(form, t);
  const parsed = ProposeProcedureContentSchema.safeParse(procedureContentFromForm(form));
  if (parsed.success && Object.keys(problems).length === 0) return { ok: true, value: parsed.data };
  // The form's own problem at a place wins: 「不是合法的 JSON」 says more than the schema's
  // complaint about the text standing in for it.
  const schemaErrors = parsed.success ? {} : fieldErrorsFromIssues(parsed.error.issues, t);
  const errors: Record<string, string> = { ...problems };
  for (const [path, message] of Object.entries(schemaErrors)) {
    if (!Object.keys(problems).some((own) => path === own || path.startsWith(`${own}.`))) {
      errors[path] = message;
    }
  }
  return { ok: false, errors };
}

/** Legacy 453: the errors at `prefix` and under it, each with the rest of its path (`''` for one
 *  at `prefix` itself) — what one part of the form shows. */
export function errorsUnder(
  errors: FieldErrors,
  prefix: string,
): readonly { readonly path: string; readonly message: string }[] {
  return Object.entries(errors).flatMap(([path, message]) =>
    path === prefix
      ? [{ path: '', message }]
      : path.startsWith(`${prefix}.`)
        ? [{ path: path.slice(prefix.length + 1), message }]
        : [],
  );
}

// -------------------------------------------------------------------------------------------
// WorkerDefinition (`kind` + the kind-specific `definition` record)
// -------------------------------------------------------------------------------------------

export interface WorkerDefinitionForm {
  readonly kind: WorkerDefinitionKind;
  readonly name: string;
  readonly description: string;
  readonly systemPrompt: string;
  readonly model: string;
  /** One per line: capability names (`capabilities`). */
  readonly capabilities: string;
  /** One per line: Gatekeeper ids (`gates`, worker only). */
  readonly gates: string;
  /** One per line: Skill names / ids (`skills`, worker only). */
  readonly skills: string;
  /** One per line: hostnames / `.suffix` entries (`egressDeny`). */
  readonly egressDeny: string;
  /** S11 GO13 (worker only): the input the Worker expects (`inputSchema`); `null` = none declared. */
  readonly inputSchema: SchemaDraft | null;
  /** S11 GO13 (worker only): what the Worker reports (`outputSchema`); `null` = none declared. */
  readonly outputSchema: SchemaDraft | null;
}

/** A 「Worker」 tab row's item id — the tab lists each published version of a definition as its
 *  own row, so an id names one version: `id@version` (`hrefs.catalog('workers', …)`). */
export function workerItemId(row: { readonly id: string; readonly version: number }): string {
  return `${row.id}@${row.version}`;
}

export const EMPTY_WORKER_DEFINITION_FORM: WorkerDefinitionForm = {
  kind: 'worker',
  name: '',
  description: '',
  systemPrompt: '',
  model: '',
  capabilities: '',
  gates: '',
  skills: '',
  egressDeny: '',
  inputSchema: null,
  outputSchema: null,
};

export function workerDefinitionFormFromWire(
  kind: WorkerDefinitionKind,
  definition: Readonly<Record<string, unknown>>,
): WorkerDefinitionForm {
  const str = (key: string): string =>
    typeof definition[key] === 'string' ? (definition[key] as string) : '';
  const list = (key: string): string =>
    Array.isArray(definition[key])
      ? joinList((definition[key] as unknown[]).filter((v): v is string => typeof v === 'string'))
      : '';
  return {
    kind,
    name: str('name'),
    description: str('description'),
    systemPrompt: str('systemPrompt'),
    model: str('model'),
    capabilities: list('capabilities'),
    gates: list('gates'),
    skills: list('skills'),
    egressDeny: list('egressDeny'),
    inputSchema:
      kind === 'worker' && definition.inputSchema !== undefined
        ? schemaDraftFrom(definition.inputSchema)
        : null,
    outputSchema:
      kind === 'worker' && definition.outputSchema !== undefined
        ? schemaDraftFrom(definition.outputSchema)
        : null,
  };
}

/** J7/CW1 "从模板创建（ops-runner）": the checked-in `ontology/ops-runner.yaml` template
 *  (`lib/templates/ops-runner.ts` — kept drift-checked against the real YAML by that module's own
 *  test) as a prefilled `WorkerDefinitionForm`. `name: 'ops-runner'` is set here rather than on
 *  the template constant itself — the raw template carries no `name` field (F1: this button only
 *  exposes the existing template through the existing propose/publish path, it does not invent
 *  new template content), so the editor's own "从模板创建" affordance is what chooses the name a
 *  reader sees pre-filled, same as it would if they typed it by hand.
 *
 * S8 W3 K2 (leftover 84): the template's own YAML carries no `capabilities` either — omitted
 * meant "kernel default" (`defaultWorkerCapabilities`, `packages/kernel/src/application/task/
 * handle-mint.ts`: the worker ceiling minus every execute-class capability), which silently
 * dropped `request_action` — a Worker spawned from this template could observe everything but
 * never propose an execute-class action through the approval flow. `capabilities`, once present,
 * *replaces* that default rather than adding to it, so this must submit the full non-execute set
 * plus `request_action`, never `['request_action']` alone (that would drop every observe
 * capability instead).
 *
 * No hardcoded capability list: `capabilityNames` is `list_capability_names`'s own rows
 * (`{name, mode}` — the same `CapabilityMode` union `packages/shared/src/capabilities.ts`
 * defines), already filtered to the worker ceiling minus the two gate-projection placeholder
 * patterns by the kernel handler itself. Within that returned set, the *only* execute-mode name is
 * `request_action` (every other execute-mode capability in the registry belongs to a group
 * `list_capability_names` never includes — chat/ontology/connection/meta-publish/governance/
 * worker-publish, none of which are `graph`-group, `propose_*`, or in `WORKER_CEILING_EXTRA_
 * CAPABILITY_NAMES`); filtering out `mode === 'execute'` and then explicitly re-adding
 * `request_action` is therefore exactly `defaultWorkerCapabilities(WORKER_CEILING_CAPABILITIES) ∪
 * {'request_action'}` — computed here from the loaded directory, not a name this function invents
 * or hardcodes. */
export function opsRunnerTemplateForm(
  capabilityNames: readonly Pick<CapabilityNameRow, 'name' | 'mode'>[],
  /** Audit P1-7: the gates already granted to the reader (`execution_readiness.gates[].granted`)
   *  start ticked, so the template's Worker reaches the systems its author can use instead of
   *  none. */
  grantedGateIds: readonly string[] = [],
): WorkerDefinitionForm {
  const { kind, ...definition } = OPS_RUNNER_WORKER_TEMPLATE;
  const capabilities = capabilityNames
    .filter((capability) => capability.mode !== 'execute')
    .map((capability) => capability.name);
  if (!capabilities.includes('request_action')) capabilities.push('request_action');
  return {
    ...workerDefinitionFormFromWire(kind, definition),
    name: 'ops-runner',
    capabilities: joinList(capabilities),
    gates: joinList(grantedGateIds),
  };
}

/** The `definition` record for `propose_worker_definition` — optional strings omitted when
 *  blank, optional lists omitted when empty (the kind schemas are `.strict()` and `.min(1)`);
 *  `capabilities` is always sent for `entry` (required there) and only when non-empty for
 *  `worker` (omitted = the observe / propose-only ceiling, worker-definition.ts). */
export function workerDefinitionContentFromForm(
  form: WorkerDefinitionForm,
): Record<string, unknown> {
  const definition: Record<string, unknown> = { systemPrompt: form.systemPrompt };
  const model = form.model.trim();
  const name = form.name.trim();
  const description = form.description.trim();
  if (model) definition.model = model;
  if (name) definition.name = name;
  if (description) definition.description = description;
  const capabilities = splitList(form.capabilities);
  const egressDeny = splitList(form.egressDeny);
  if (form.kind === 'entry') {
    definition.capabilities = capabilities;
  } else {
    if (capabilities.length > 0) definition.capabilities = capabilities;
    const gates = splitList(form.gates);
    const skills = splitList(form.skills);
    if (gates.length > 0) definition.gates = gates;
    if (skills.length > 0) definition.skills = skills;
    // S11 GO13: the contract, as the schema the draft says (JSON that does not parse stands as
    // its text, so validation says where).
    if (form.inputSchema) definition.inputSchema = schemaValue(form.inputSchema);
    if (form.outputSchema) definition.outputSchema = schemaValue(form.outputSchema);
  }
  if (egressDeny.length > 0) definition.egressDeny = egressDeny;
  return definition;
}

/** S11 GO13: what a `worker` WorkerDefinition version declares as its contract — read from its
 *  content as the kernel reads it (`workerContractOf`, application/task/worker-discovery.ts): a
 *  field that does not parse as a contract is left out, never shown as if it were one. */
export interface WorkerContract {
  readonly inputSchema?: OutputSchema;
  readonly outputSchema?: OutputSchema;
}

export function workerContractOf(definition: Readonly<Record<string, unknown>>): WorkerContract {
  const read = (value: unknown): OutputSchema | undefined => {
    if (value === undefined) return undefined;
    const parsed = StepOutputSchemaSchema.safeParse(value);
    return parsed.success ? parsed.data : undefined;
  };
  const inputSchema = read(definition.inputSchema);
  const outputSchema = read(definition.outputSchema);
  return {
    ...(inputSchema ? { inputSchema } : {}),
    ...(outputSchema ? { outputSchema } : {}),
  };
}

/** S11 GO13: what the form can tell about a Worker's contract before the schema does — JSON that
 *  does not parse, a list row without a name or with one used twice (`inputSchema.fields.<row>`). */
function workerContractProblems(form: WorkerDefinitionForm, t: Translate): Record<string, string> {
  const problems: Record<string, string> = {};
  if (form.kind !== 'worker') return problems;
  for (const path of ['inputSchema', 'outputSchema'] as const) {
    const draft = form[path];
    if (!draft) continue;
    if (draft.mode === 'json' && !schemaFromDraft(draft).ok) {
      problems[path] = t('不是合法的 JSON', 'Not valid JSON');
    }
    for (const [row, problem] of schemaRowProblems(draft, t)) {
      problems[`${path}.fields.${row}`] = problem;
    }
  }
  return problems;
}

export function validateWorkerDefinition(
  form: WorkerDefinitionForm,
  t: Translate,
): ValidationResult<Record<string, unknown>> {
  const problems = workerContractProblems(form, t);
  const parsed = workerDefinitionContentSchemaFor(form.kind).safeParse(
    workerDefinitionContentFromForm(form),
  );
  if (parsed.success && Object.keys(problems).length === 0) {
    return { ok: true, value: parsed.data as Record<string, unknown> };
  }
  // The form's own problem at a place wins over the schema's complaint about the same place.
  const errors: Record<string, string> = { ...problems };
  const schemaErrors = parsed.success ? {} : fieldErrorsFromIssues(parsed.error.issues, t);
  for (const [path, message] of Object.entries(schemaErrors)) {
    if (!Object.keys(problems).some((own) => path === own || path.startsWith(`${own}.`))) {
      errors[path] = message;
    }
  }
  return { ok: false, errors };
}

// -------------------------------------------------------------------------------------------
// JSON view (the "YAML 视图" of §5.3, kept as JSON: no YAML dependency exists in this package)
// -------------------------------------------------------------------------------------------

export function parseJsonObject(
  text: string,
  t: Translate,
):
  | { readonly ok: true; readonly value: Record<string, unknown> }
  | { readonly ok: false; readonly error: string } {
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, error: t('必须是一个 JSON 对象', 'Must be a JSON object') };
    }
    return { ok: true, value: value as Record<string, unknown> };
  } catch (err) {
    // The parser's own words name the position; the sentence around them is the viewer's.
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, error: t(`不是合法的 JSON（${detail}）`, `Not valid JSON (${detail})`) };
  }
}

// -------------------------------------------------------------------------------------------
// Minimal Markdown blocks for the SKILL.md preview
// -------------------------------------------------------------------------------------------

export type MarkdownBlock =
  | { readonly kind: 'heading'; readonly level: number; readonly text: string }
  | { readonly kind: 'paragraph'; readonly text: string }
  | { readonly kind: 'code'; readonly lang: string; readonly text: string }
  | { readonly kind: 'list'; readonly ordered: boolean; readonly items: readonly string[] };

/** Headings (`#`…`######`), fenced code (```), `-` / `*` bullets, `1.` numbered lists and
 *  paragraphs (blank-line separated); a line wrapped under a list item joins that item, as a
 *  wrapped paragraph line joins its paragraph. Inline emphasis / links are left as literal text. */
export function parseMarkdownBlocks(markdown: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let code: { lang: string; lines: string[] } | null = null;

  const flushParagraph = (): void => {
    if (paragraph.length > 0) {
      blocks.push({ kind: 'paragraph', text: paragraph.join(' ') });
      paragraph = [];
    }
  };
  const flushList = (): void => {
    if (list) {
      blocks.push({ kind: 'list', ordered: list.ordered, items: list.items });
      list = null;
    }
  };

  for (const line of lines) {
    if (code) {
      if (/^```/.test(line)) {
        blocks.push({ kind: 'code', lang: code.lang, text: code.lines.join('\n') });
        code = null;
      } else {
        code.lines.push(line);
      }
      continue;
    }
    const fence = /^```\s*(\S*)/.exec(line);
    if (fence) {
      flushParagraph();
      flushList();
      code = { lang: fence[1] ?? '', lines: [] };
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      blocks.push({ kind: 'heading', level: heading[1]?.length ?? 1, text: heading[2] ?? '' });
      continue;
    }
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      flushParagraph();
      const ordered = !bullet;
      const text = (bullet ?? numbered)?.[1] ?? '';
      if (!list || list.ordered !== ordered) {
        flushList();
        list = { ordered, items: [] };
      }
      list.items.push(text);
      continue;
    }
    if (line.trim() === '') {
      flushParagraph();
      flushList();
      continue;
    }
    if (list) {
      // A line that starts no block of its own continues the item above it, indented or not
      // (CommonMark's lazy continuation): SKILL.md bodies wrap long items onto the next line.
      const last = list.items.length - 1;
      list.items[last] = `${list.items[last]} ${line.trim()}`;
      continue;
    }
    paragraph.push(line.trim());
  }
  if (code) blocks.push({ kind: 'code', lang: code.lang, text: code.lines.join('\n') });
  flushParagraph();
  flushList();
  return blocks;
}
