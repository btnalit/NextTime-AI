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
 *   - `list_skills` / `list_procedures` are `noParams` and `list_worker_definitions` takes only
 *     `{kind?}` (both `.strict()`) — no `limit` / `cursor`, so the catalog stays single-page (B5
 *     does not apply; passing paging params would be a 400).
 */

/** `path → message` from a failed `safeParse`, first message per path (the form shows one). */
export type FieldErrors = Readonly<Record<string, string>>;

interface IssueLike {
  readonly path: readonly (string | number)[];
  readonly message: string;
}

export function fieldErrorsFromIssues(issues: readonly IssueLike[]): FieldErrors {
  const errors: Record<string, string> = {};
  for (const issue of issues) {
    const key = issue.path.length === 0 ? '_' : issue.path.map(String).join('.');
    if (!(key in errors)) errors[key] = issue.message;
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
export function validateSkill(form: SkillForm): ValidationResult<ProposeSkillContent> {
  const parsed = ProposeSkillContentSchema.safeParse(skillContentFromForm(form));
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, errors: fieldErrorsFromIssues(parsed.error.issues) };
}

/** Publish-time name rule (pi Agent Skills: 1-64 lowercase letters / digits / single hyphens) —
 *  surfaced as a warning while drafting so the later `publish_skill` does not surprise. */
export function skillNamePublishWarning(name: string): string | undefined {
  if (name.trim() === '') return undefined;
  const parsed = PublishedSkillNameSchema.safeParse(name.trim());
  return parsed.success
    ? undefined
    : '发布时要求：1–64 个小写字母 / 数字，单个连字符分隔，不能以连字符开头或结尾（pi Skill 命名规则）。 Publish requires 1–64 lowercase letters / digits with single hyphens, none leading or trailing (pi Agent Skills name rule).';
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

export function validateProcedure(form: ProcedureForm): ValidationResult<ProposeProcedureContent> {
  const parsed = ProposeProcedureContentSchema.safeParse(procedureContentFromForm(form));
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, errors: fieldErrorsFromIssues(parsed.error.issues) };
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
): ValidationResult<Record<string, unknown>> {
  const parsed = workerDefinitionContentSchemaFor(form.kind).safeParse(
    workerDefinitionContentFromForm(form),
  );
  return parsed.success
    ? { ok: true, value: parsed.data as Record<string, unknown> }
    : { ok: false, errors: fieldErrorsFromIssues(parsed.error.issues) };
}

// -------------------------------------------------------------------------------------------
// JSON view (the "YAML 视图" of §5.3, kept as JSON: no YAML dependency exists in this package)
// -------------------------------------------------------------------------------------------

export function parseJsonObject(
  text: string,
):
  | { readonly ok: true; readonly value: Record<string, unknown> }
  | { readonly ok: false; readonly error: string } {
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, error: '必须是一个 JSON 对象 Must be a JSON object' };
    }
    return { ok: true, value: value as Record<string, unknown> };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
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
