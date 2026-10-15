import {
  type ProcedureStep,
  type ProposeProcedureContent,
  ProposeProcedureContentSchema,
  type ProposeSkillContent,
  ProposeSkillContentSchema,
  PublishedSkillNameSchema,
  type WorkerDefinitionKind,
  workerDefinitionContentSchemaFor,
} from '@nexttime/shared';
import type { CapabilityNameRow } from './governance.js';
import type { Translate } from './i18n.js';
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
  readonly path: readonly (string | number)[];
  readonly message: string;
  readonly code?: string;
  readonly type?: string;
  readonly minimum?: unknown;
  readonly maximum?: unknown;
  readonly received?: unknown;
  readonly validation?: unknown;
  readonly options?: readonly unknown[];
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
 *  shared schemas carry zod's default English ("String must contain at least 1 character(s)"),
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
      return issue.received === 'undefined' || issue.received === 'null'
        ? t('必填', 'Required')
        : t('格式不对', 'Wrong format');
    case 'too_small':
      if (issue.type === 'string') {
        return min !== null && min <= 1
          ? t('必填', 'Required')
          : t(`至少 ${min} 个字符`, `At least ${min} characters`);
      }
      if (issue.type === 'array') {
        return t(`至少 ${min} 项`, `At least ${min} items`);
      }
      return t(`不能小于 ${min}`, `Must be at least ${min}`);
    case 'too_big':
      if (issue.type === 'string') return t(`最多 ${max} 个字符`, `At most ${max} characters`);
      if (issue.type === 'array') return t(`最多 ${max} 项`, `At most ${max} items`);
      return t(`不能大于 ${max}`, `Must be at most ${max}`);
    case 'invalid_enum_value': {
      const options = (issue.options ?? []).map(String).join('、');
      return t(`只能是：${options}`, `Must be one of: ${options}`);
    }
    case 'invalid_string':
      return issue.validation === 'url'
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

/** One step as the form edits it — every field a string so a half-typed step is representable;
 *  `procedureStepsFromForm` turns it into the wire shape. */
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
}

let stepCounter = 0;
/** A fresh client key per step (module-local counter — unique within a page load). */
export function nextStepKey(): string {
  stepCounter += 1;
  return `step-${stepCounter}`;
}

export const EMPTY_STEP: ProcedureStepForm = {
  key: 'step-0',
  kind: 'approval',
  gatekeeperId: '',
  operationName: '',
  definitionId: '',
  version: '1',
  description: '',
};

export interface ProcedureForm {
  readonly name: string;
  readonly description: string;
  readonly steps: readonly ProcedureStepForm[];
}

export const EMPTY_PROCEDURE_FORM: ProcedureForm = { name: '', description: '', steps: [] };

export function newProcedureStep(): ProcedureStepForm {
  return { ...EMPTY_STEP, key: nextStepKey() };
}

export function procedureStepFromWire(step: unknown): ProcedureStepForm {
  const record = (step && typeof step === 'object' ? step : {}) as Record<string, unknown>;
  const str = (key: string): string => (typeof record[key] === 'string' ? record[key] : '');
  const kind = PROCEDURE_STEP_KINDS.includes(record.kind as ProcedureStepKind)
    ? (record.kind as ProcedureStepKind)
    : 'approval';
  return {
    key: nextStepKey(),
    kind,
    gatekeeperId: str('gatekeeperId'),
    operationName: str('operationName'),
    definitionId: str('definitionId'),
    version: typeof record.version === 'number' ? String(record.version) : '1',
    description: str('description'),
  };
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
      return {
        kind: 'worker',
        definitionId: step.definitionId.trim(),
        version: Number.isNaN(version) ? step.version : version,
        ...(description ? { description } : {}),
      };
    }
    default:
      return { kind: step.kind, description };
  }
}

export function procedureContentFromForm(form: ProcedureForm): Record<string, unknown> {
  return {
    name: form.name.trim(),
    description: form.description.trim(),
    steps: form.steps.map(procedureStepToWire),
  };
}

export function validateProcedure(
  form: ProcedureForm,
  t: Translate,
): ValidationResult<ProposeProcedureContent> {
  const parsed = ProposeProcedureContentSchema.safeParse(procedureContentFromForm(form));
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, errors: fieldErrorsFromIssues(parsed.error.issues, t) };
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
  }
  if (egressDeny.length > 0) definition.egressDeny = egressDeny;
  return definition;
}

export function validateWorkerDefinition(
  form: WorkerDefinitionForm,
  t: Translate,
): ValidationResult<Record<string, unknown>> {
  const parsed = workerDefinitionContentSchemaFor(form.kind).safeParse(
    workerDefinitionContentFromForm(form),
  );
  return parsed.success
    ? { ok: true, value: parsed.data as Record<string, unknown> }
    : { ok: false, errors: fieldErrorsFromIssues(parsed.error.issues, t) };
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
 *  paragraphs (blank-line separated). Inline emphasis / links are left as literal text. */
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
    flushList();
    paragraph.push(line.trim());
  }
  if (code) blocks.push({ kind: 'code', lang: code.lang, text: code.lines.join('\n') });
  flushParagraph();
  flushList();
  return blocks;
}
