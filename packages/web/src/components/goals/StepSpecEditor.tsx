import type { WorkerDefinitionWire } from '@nexttime/shared';
import { type ReactNode, useEffect, useState } from 'react';
import { useCapability, useCapabilityList } from '../../hooks/useCapability.js';
import type { AgentPolicy } from '../../lib/agent-profile.js';
import { narrowByPolicyAllowList } from '../../lib/agent-profile.js';
import { actionLabel } from '../../lib/capability-labels.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { shortId } from '../../lib/format.js';
import {
  EMPTY_SPEC_DRAFT,
  type FieldKey,
  SPEC_FIELDS,
  type SpecDraft,
  type SpecField,
  type StepDraft,
  shownOnly,
  skillRefUse,
  specChanged,
  specFieldsSet,
} from '../../lib/goal-plan-draft.js';
import { skillRefShown, workerSpecFieldLabel } from '../../lib/goals.js';
import type { CapabilityNameRow, ModelRow, SkillRow } from '../../lib/governance.js';
import { type Translate, useT } from '../../lib/i18n.js';
import { type WorkerSpecBase, workerSpecBaseOf } from '../../lib/worker-spec-detail.js';
import { useGatekeeperDirectory } from '../approvals/useDirectoryNames.js';
import {
  CapabilityPickerField,
  CheckboxListField,
  type CheckboxOption,
  toggleListItem,
} from '../catalog/DirectoryPickers.js';
import { Button } from '../kit/button.js';
import { Field, describedBy } from '../kit/field.js';
import { ModelHealthNote, ModelOption, withModelHealthNote } from '../kit/model-health.js';
import { Select } from '../kit/select.js';
import { Textarea } from '../kit/textarea.js';

/** The Skill directory (`list_skills`) the plan editor reads once for every step: `complete` once
 *  every page is in — only then is a Skill that is not in it known not to be there. */
export interface SkillDirectory {
  readonly rows: readonly SkillRow[];
  readonly complete: boolean;
  readonly loading: boolean;
}

export interface StepSpecEditorProps {
  /** The step editor's id base (`useId`). */
  readonly id: string;
  readonly step: StepDraft;
  readonly http: CapabilityCaller;
  readonly skills: SkillDirectory;
  /** Called while the section is open: the editor reads the Skill directory from then on. */
  readonly onOpen: () => void;
  readonly errorOf: (key: FieldKey) => string | null;
  readonly onChange: (spec: SpecDraft) => void;
}

type ListField = 'skills' | 'gates' | 'capabilities';

/**
 * components/goals/StepSpecEditor (S11 GO15b; `s11-w2/go15-default-plan.md` F6): what one step of
 * the plan sets differently for its Worker — the WorkerSpec, field by field, in the plan editor.
 * Each field says what the Worker's definition (the version the step names, read by version) has,
 * and keeps it (「沿用定义」) until the person sets it here; what is set is picked from the
 * directories the kernel checks it against: Skills the person can see, the workspace's gates, the
 * capabilities a Worker may ever hold (`list_capability_names`), the models the catalog offers and
 * the workspace allows. Only the step's responsibility is typed, and the token cap is a number.
 *
 * The kernel decides: `revise_goal` validates the WorkerSpec (what it names must be there) and a
 * step whose WorkerSpec changes is admitted afresh when it starts — never beyond the Worker ceiling
 * and what the requester holds then, whatever is set here. Closed while the step sets nothing, so
 * the directories are read only when someone opens it.
 */
export function StepSpecEditor({
  id,
  step,
  http,
  skills,
  onOpen,
  errorOf,
  onChange,
}: StepSpecEditorProps) {
  const t = useT();
  const set = specFieldsSet(step.spec);
  const errors = SPEC_FIELDS.filter((field) => errorOf(`step:${step.uid}:spec.${field}`) !== null);
  const [open, setOpen] = useState(set.length > 0);
  // A problem on one of its fields (the editor's, or the kernel's refusal) opens it, so it is seen.
  const anyError = errors.length > 0;
  useEffect(() => {
    if (anyError) setOpen(true);
  }, [anyError]);
  useEffect(() => {
    if (open) onOpen();
  }, [open, onOpen]);
  const summary =
    set.length === 0
      ? t('沿用 Worker 定义', 'As the Worker is')
      : t(
          `调整了：${set.map((field) => workerSpecFieldLabel(field, t)).join('、')}`,
          `Set here: ${set.map((field) => workerSpecFieldLabel(field, t)).join(', ')}`,
        );
  return (
    <details
      className="disclosure"
      data-testid="goal-plan-step-spec"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <span>{t('对 Worker 的调整', 'Adjustments to its Worker')}</span>
        <span className="meta-sep" />
        <span className="text-3" data-testid="goal-plan-step-spec-summary">
          {summary}
        </span>
      </summary>
      {open ? (
        <SpecFields
          id={id}
          step={step}
          http={http}
          skills={skills}
          onOpen={onOpen}
          errorOf={errorOf}
          onChange={onChange}
          t={t}
        />
      ) : null}
    </details>
  );
}

function SpecFields({
  id,
  step,
  http,
  skills,
  errorOf,
  onChange,
  t,
}: StepSpecEditorProps & { readonly t: Translate }) {
  const ready = step.definitionId !== '' && step.version !== '';
  const read = useCapability<WorkerDefinitionWire | null>(
    http,
    'get_worker_definition',
    { definitionId: step.definitionId, version: Number(step.version) },
    { enabled: ready },
  );
  const definition = read.state.status === 'ready' ? read.state.data : undefined;
  const base: WorkerSpecBase | null | undefined = !ready
    ? null
    : definition === undefined
      ? read.state.status === 'error'
        ? null
        : undefined
      : definition
        ? workerSpecBaseOf(definition.definition)
        : null;
  const gatekeepers = useGatekeeperDirectory(http);
  const capabilityNames = useCapabilityList<CapabilityNameRow>(http, 'list_capability_names');
  const models = useCapabilityList<ModelRow>(http, 'list_models');
  const policy = useCapability<AgentPolicy>(http, 'get_agent_policy');

  const spec = step.spec;
  const at = (field: SpecField) => `step:${step.uid}:spec.${field}` as const;
  const patch = (next: Partial<SpecDraft>) => onChange({ ...spec, ...next });
  const gateName = (gateId: string) =>
    gatekeepers.rows?.find((row) => row.id === gateId)?.name ?? shortId(gateId);
  const joined = (items: readonly string[]) => items.join(t('、', ', '));

  /** What the definition has of a field, in a line under its label. */
  const definitionLine = (text: string, field: SpecField): ReactNode => (
    <span className="text-3 text-small" data-testid="goal-plan-spec-base" data-field={field}>
      {base === undefined
        ? t('正在读取 Worker 定义…', 'Reading the Worker definition…')
        : base === null
          ? ready
            ? t(
                '读不到这个 Worker 版本的定义，无法对照',
                'This Worker version’s definition cannot be read to compare with',
              )
            : t('先选 Worker 和版本', 'Pick a Worker and its version first')
          : text}
    </span>
  );
  const listText = (field: ListField): string => {
    const items = base?.[field];
    if (field === 'capabilities') {
      if (items === undefined) {
        return t(
          '定义：没有列出能力（Worker 默认只有观察和提议类能力）',
          'Definition: no capabilities listed (by default a Worker holds observe and propose ones only)',
        );
      }
      const shown = items.slice(0, 6).map((name) => actionLabel(name, t));
      return items.length === 0
        ? t('定义：没有能力', 'Definition: none')
        : items.length > shown.length
          ? t(
              `定义：${joined(shown)} 等 ${items.length} 个`,
              `Definition: ${joined(shown)} and more (${items.length})`,
            )
          : t(`定义：${joined(shown)}`, `Definition: ${joined(shown)}`);
    }
    if (items === undefined || items.length === 0) {
      return field === 'skills'
        ? t('定义：不装载 Skill', 'Definition: mounts no Skill')
        : t('定义：不作用于任何门', 'Definition: acts on no gate');
    }
    const names = field === 'skills' ? items.map(definitionSkillShown) : items.map(gateName);
    return t(`定义：${joined(names)}`, `Definition: ${joined(names)}`);
  };

  /** A Skill the definition names, as its line shows it: one a run would not mount (UX P2-1 on
   *  #889 — the definition's Skills mount published ones only, best effort) says so. */
  const definitionSkillShown = (ref: string): string => {
    const use = skills.complete ? skillRefUse(skills.rows, ref) : 'published';
    return use === 'published'
      ? skillRefShown(ref)
      : use === 'draft'
        ? t(
            `${skillRefShown(ref)}（只有草稿，沿用时不装载）`,
            `${skillRefShown(ref)} (only a draft: not mounted as the definition has it)`,
          )
        : t(
            `${skillRefShown(ref)}（已弃用或不在了，沿用时不装载）`,
            `${skillRefShown(ref)} (deprecated or gone: not mounted as the definition has it)`,
          );
  };
  /** What unticking 「沿用定义」 starts a list from: the definition's — for Skills, the ones a run
   *  mounts now (published), so the step starts as it would have run (UX P2-1 on #889). */
  const startFrom = (field: ListField): string[] => {
    const items = base?.[field] ?? [];
    return field === 'skills' && skills.complete
      ? items.filter((ref) => skillRefUse(skills.rows, ref) === 'published')
      : [...items];
  };
  /** 「沿用定义」 on a list: ticked, the step keeps the definition's; unticked, it starts from it. */
  const inherit = (field: ListField | 'observeScope', label: string) => {
    const value = spec[field];
    return (
      <label className="checkbox">
        <input
          type="checkbox"
          checked={value === null}
          onChange={(event) =>
            patch({
              [field]: event.target.checked
                ? null
                : field === 'observeScope'
                  ? []
                  : startFrom(field),
            })
          }
          data-testid="goal-plan-spec-inherit"
          data-field={field}
        />
        <span>{label}</span>
      </label>
    );
  };
  /** UX P3-2 on #889: a list set here with nothing ticked, said for what it means. */
  const noneNote = (field: ListField | 'observeScope', offered: boolean): ReactNode => {
    const value = spec[field];
    if (value === null || value.length > 0 || !offered) return null;
    const text =
      field === 'skills'
        ? t('一个都没选：这一步不装载 Skill。', 'None ticked: the step mounts no Skill.')
        : field === 'gates'
          ? t('一个都没选：这一步不作用于任何门。', 'None ticked: the step acts on no gate.')
          : field === 'capabilities'
            ? t(
                '一个都没选：这一步只有每个 Worker 都有的几项基础能力（报告结果、读自己的 Task 等）。',
                'None ticked: the step holds only what every Worker has (reporting its result, reading its Task and the like).',
              )
            : t('一个都没选：这一步不能观察任何门。', 'None ticked: the step may observe no gate.');
    return (
      <span className="text-3 text-small" data-testid="goal-plan-spec-none" data-field={field}>
        {text}
      </span>
    );
  };
  const listError = (field: SpecField) => {
    const error = errorOf(at(field));
    return error ? (
      <p className="field-error" role="alert">
        {error}
      </p>
    ) : null;
  };

  // Skills: one per name, as a WorkerSpec names them — published ones, and drafts the person can
  // see (a step using one waits for someone to approve a trial). A name only deprecated is not on
  // offer; one the step already names stays visible to untick.
  const skillOptions = skillChoices(skills, spec.skills ?? [], t);
  const gateRows = gatekeepers.rows ?? [];
  const gateOptions = (selected: readonly string[]): CheckboxOption[] => [
    ...gateRows.map((row) => ({ id: row.id, label: row.name })),
    ...selected
      .filter((gateId) => !gateRows.some((row) => row.id === gateId))
      .map((gateId) => ({ id: gateId, label: gateName(gateId) })),
  ];
  const modelRows = narrowByPolicyAllowList(
    models.state.status === 'ready' ? models.state.data.items : [],
    policy.state.status === 'ready' ? policy.state.data.allowedModels : undefined,
    (row) => row.id,
  );
  const modelKnown = spec.model === '' || modelRows.some((row) => row.id === spec.model);
  const instructionsError = errorOf(at('instructions'));
  const keptAsRead =
    step.original !== null &&
    spec.instructions === (step.original.spec?.instructions ?? '') &&
    !specChanged(step)
      ? shownOnly(spec.instructions)
      : null;
  const tokenError = errorOf(at('tokenBudget'));
  const modelError = errorOf(at('model'));

  return (
    <div className="disclosure-body stack" data-testid="goal-plan-spec-fields">
      <span className="text-3 text-small">
        {t(
          '只对这一步生效：设了的项按这里的跑，其余沿用 Worker 定义。无论这里怎么设，这一步都不会超出 Worker 能持有的能力和请求人到时的权限；改了任何一项，这一步会重新准入、按新定义从头开始。',
          'For this step only: what is set here applies, the rest is as the Worker is. Whatever is set, the step never goes beyond what a Worker may hold and what the requester holds then; changing any of it admits the step afresh, starting it again on its new definition.',
        )}
      </span>

      <Field
        id={`${id}-spec-instructions`}
        label={workerSpecFieldLabel('instructions', t)}
        hint={[
          t(
            '追加在 Worker 定义的系统提示之后，说这一步要它做什么；空着就不加。不要写凭据的值。',
            'Added after the Worker definition’s system prompt, saying what this step wants of it; blank adds nothing. Never a credential’s value.',
          ),
          keptAsRead === 'mask'
            ? t(
                '这里有遮蔽的原文：不改这一步对 Worker 的调整，提交时原文原样保留；改了任何一项，就要把这一段整段重写。',
                'This holds masked text: left with the step’s adjustments as they are, the original is kept; once any of them changes, write this whole.',
              )
            : keptAsRead === 'escape'
              ? t(
                  '这里有显示成 \\u{…} 的看不见的字符：不改这一步对 Worker 的调整，提交时原文原样保留；改了任何一项，就要把它们删掉或换成真正的字符。',
                  'This holds characters nobody can see, shown as \\u{…}: left with the step’s adjustments as they are, the original is kept; once any of them changes, delete them or type the real character.',
                )
              : null,
        ]
          .filter((part) => part !== null)
          .join(' ')}
        error={instructionsError}
      >
        <Textarea
          id={`${id}-spec-instructions`}
          aria-label={workerSpecFieldLabel('instructions', t)}
          value={spec.instructions}
          onChange={(event) => patch({ instructions: event.target.value })}
          minRows={2}
          maxRows={10}
          invalid={instructionsError !== null}
          data-testid="goal-plan-spec-instructions"
        />
      </Field>

      <div className="stack-s" data-testid="goal-plan-spec-field" data-field="skills">
        <span className="field-label">{workerSpecFieldLabel('skills', t)}</span>
        {definitionLine(listText('skills'), 'skills')}
        {inherit('skills', t('沿用定义', 'As the definition has it'))}
        {spec.skills !== null ? (
          <CheckboxListField
            legend={t('这一步装载这些 Skill', 'This step mounts these Skills')}
            options={skillOptions}
            selected={spec.skills}
            onToggle={(ref) => patch({ skills: toggleListItem(spec.skills ?? [], ref) })}
            testId="goal-plan-spec-skills"
            emptyHint={
              skills.loading
                ? t('正在读取 Skill…', 'Reading Skills…')
                : t(
                    '没有可用的 Skill：不勾选就是这一步不装载 Skill。',
                    'No Skill to pick: with none ticked the step mounts no Skill.',
                  )
            }
          />
        ) : null}
        {noneNote('skills', skillOptions.length > 0)}
        {listError('skills')}
      </div>

      <div className="stack-s" data-testid="goal-plan-spec-field" data-field="gates">
        <span className="field-label">{workerSpecFieldLabel('gates', t)}</span>
        {definitionLine(listText('gates'), 'gates')}
        {inherit('gates', t('沿用定义', 'As the definition has it'))}
        {spec.gates !== null ? (
          <CheckboxListField
            legend={t('这一步作用于这些门', 'This step acts on these gates')}
            options={gateOptions(spec.gates)}
            selected={spec.gates}
            onToggle={(gateId) => patch({ gates: toggleListItem(spec.gates ?? [], gateId) })}
            testId="goal-plan-spec-gates"
            emptyHint={t('工作区里还没有门。', 'The workspace has no gate yet.')}
          />
        ) : null}
        {noneNote('gates', gateOptions(spec.gates ?? []).length > 0)}
        {listError('gates')}
      </div>

      <div className="stack-s" data-testid="goal-plan-spec-field" data-field="capabilities">
        <span className="field-label">{workerSpecFieldLabel('capabilities', t)}</span>
        {definitionLine(listText('capabilities'), 'capabilities')}
        {inherit('capabilities', t('沿用定义', 'As the definition has it'))}
        {spec.capabilities !== null ? (
          <CapabilityPickerField
            label={t(
              '这一步的能力（Worker 能持有的）',
              'This step’s capabilities (ones a Worker may hold)',
            )}
            rows={capabilityNames.state.status === 'ready' ? capabilityNames.state.data.items : []}
            selected={spec.capabilities}
            onChange={(next) => patch({ capabilities: next })}
            testId="goal-plan-spec-capabilities"
            idPrefix={`${id}-spec-capabilities`}
            emptyHint={
              capabilityNames.state.status === 'loading'
                ? t('正在读取能力…', 'Reading capabilities…')
                : t('读不到能力目录。', 'The capability directory cannot be read.')
            }
          />
        ) : null}
        {noneNote(
          'capabilities',
          capabilityNames.state.status === 'ready' && capabilityNames.state.data.items.length > 0,
        )}
        {listError('capabilities')}
      </div>

      <Field
        id={`${id}-spec-model`}
        label={workerSpecFieldLabel('model', t)}
        hint={t(
          '从模型目录里这个工作区允许的模型中选。',
          'From the catalog’s models this workspace allows.',
        )}
        error={modelError}
      >
        {definitionLine(
          base?.model !== undefined
            ? t(`定义：${base.model}`, `Definition: ${base.model}`)
            : t(
                '定义：没有设定模型（由请求人的智能体设置来选）',
                'Definition: sets no model (the requester’s agent settings pick one)',
              ),
          'model',
        )}
        <Select
          id={`${id}-spec-model`}
          aria-label={workerSpecFieldLabel('model', t)}
          className="select-fit"
          value={spec.model}
          onChange={(event) => patch({ model: event.target.value })}
          invalid={modelError !== null}
          aria-describedby={withModelHealthNote(
            describedBy(`${id}-spec-model`, true, modelError !== null),
            `${id}-spec-model-health`,
            modelRows,
            spec.model,
          )}
          data-testid="goal-plan-spec-model"
        >
          <option value="">
            {base?.model !== undefined
              ? t(`沿用定义（${base.model}）`, `As the definition has it (${base.model})`)
              : base
                ? t(
                    '沿用定义（由请求人的智能体设置来选）',
                    'As the definition has it (the requester’s agent settings pick one)',
                  )
                : t('沿用定义', 'As the definition has it')}
          </option>
          {!modelKnown ? <option value={spec.model}>{spec.model}</option> : null}
          {modelRows.map((row) => (
            <ModelOption key={row.id} model={row} selected={row.id === spec.model} />
          ))}
        </Select>
        {/* UX P3-3 on #889: a model chosen whose provider is untested or fails tool calls says so. */}
        <ModelHealthNote
          models={modelRows}
          selectedId={spec.model}
          canFix={false}
          testId="goal-plan-spec-model-health"
          id={`${id}-spec-model-health`}
        />
      </Field>

      <div className="stack-s" data-testid="goal-plan-spec-field" data-field="observeScope">
        <span className="field-label">{workerSpecFieldLabel('observeScope', t)}</span>
        <span className="text-3 text-small">
          {t(
            '这一步的 Task 能观察哪些门：不限时就是请求人的智能体能观察的门；限定后只读勾选的门。',
            'The gates this step’s Task may observe: with no limit, the ones the requester’s agent may; limited, only the ones ticked.',
          )}
        </span>
        {inherit('observeScope', t('不限', 'No limit'))}
        {spec.observeScope !== null ? (
          <CheckboxListField
            legend={t('只观察这些门', 'Observe only these gates')}
            options={gateOptions(spec.observeScope)}
            selected={spec.observeScope}
            onToggle={(gateId) =>
              patch({ observeScope: toggleListItem(spec.observeScope ?? [], gateId) })
            }
            testId="goal-plan-spec-observe-scope"
            emptyHint={t('工作区里还没有门。', 'The workspace has no gate yet.')}
          />
        ) : null}
        {noneNote('observeScope', gateOptions(spec.observeScope ?? []).length > 0)}
        {listError('observeScope')}
      </div>

      <Field
        id={`${id}-spec-token-budget`}
        label={workerSpecFieldLabel('tokenBudget', t)}
        hint={t(
          '空着就不另设：每次尝试只受目标剩余的 Token 预算限制。',
          'Blank sets none: each attempt is held only to what is left of the goal’s token budget.',
        )}
        error={tokenError}
      >
        <input
          id={`${id}-spec-token-budget`}
          className="input input-mono"
          inputMode="numeric"
          value={spec.tokenBudget}
          onChange={(event) => patch({ tokenBudget: event.target.value })}
          aria-invalid={tokenError !== null}
          aria-describedby={describedBy(`${id}-spec-token-budget`, true, tokenError !== null)}
          autoComplete="off"
          data-testid="goal-plan-spec-token-budget"
        />
      </Field>

      {specFieldsSet(spec).length > 0 ? (
        <div>
          <Button
            variant="ghost"
            size="s"
            onClick={() => onChange(EMPTY_SPEC_DRAFT)}
            data-testid="goal-plan-spec-clear"
          >
            {t('清除全部调整，按 Worker 定义运行', 'Clear them all: run the Worker as it is')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** The Skills a step may pick, one per name, classed as the kernel classes a reference when the
 *  step starts (`skillRefUse`): a name with a published version as it is (a family whose latest is
 *  a draft still has its published one, `inUse`), one with only drafts the person can see said to
 *  be a draft; a reference the step already names and no option has kept to untick — once the
 *  directory is whole, one that is neither said to keep the step from starting (UX P2-1 on #889). */
export function skillChoices(
  directory: SkillDirectory,
  selected: readonly string[],
  t: Translate,
): CheckboxOption[] {
  const { rows } = directory;
  const names = new Set<string>();
  for (const row of rows) {
    names.add(row.name);
    if (row.inUse) names.add(row.inUse.name);
  }
  const draftLabel = (shown: string) =>
    t(
      `${shown}（草稿：要有人批准试用，这一步才会开始）`,
      `${shown} (a draft: the step starts once someone approves a trial)`,
    );
  const options: CheckboxOption[] = [];
  for (const name of names) {
    const use = skillRefUse(rows, name);
    if (use === 'published') options.push({ id: name, label: name });
    else if (use === 'draft') options.push({ id: name, label: draftLabel(name) });
  }
  for (const ref of selected) {
    if (options.some((option) => option.id === ref)) continue;
    // A reference by id (a family the step names by id) reads by its name and short id.
    const row = rows.find((candidate) => candidate.id === ref || candidate.inUse?.id === ref);
    const shown = row
      ? `${row.inUse?.id === ref ? row.inUse.name : row.name} · ${shortId(ref)}`
      : skillRefShown(ref);
    const use = directory.complete ? skillRefUse(rows, ref) : 'published';
    options.push({
      id: ref,
      label:
        use === 'draft'
          ? draftLabel(shown)
          : use === 'unusable'
            ? t(
                `${shown}（已弃用或不在了：留着它这一步就不会开始，取消勾选）`,
                `${shown} (deprecated or gone: the step does not start with it; untick it)`,
              )
            : shown,
    });
  }
  return options;
}
