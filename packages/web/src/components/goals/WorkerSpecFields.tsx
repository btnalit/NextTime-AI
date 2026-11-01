import type { PlanStep, WorkerDefinitionWire, WorkerSpec } from '@nexttime/shared';
import type { ReactNode } from 'react';
import { useCapability } from '../../hooks/useCapability.js';
import { actionLabel } from '../../lib/capability-labels.js';
import { workerItemId } from '../../lib/catalog.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { shortId } from '../../lib/format.js';
import {
  skillRefShown,
  workerSpecCombination,
  workerSpecFieldLabel,
  workerSpecFields,
  workerSpecSummary,
} from '../../lib/goals.js';
import type { Translate } from '../../lib/i18n.js';
import { hrefs } from '../../lib/router.js';
import {
  type WorkerSpecBase,
  inheritedBaseFields,
  specListAgainst,
  workerSpecBaseOf,
} from '../../lib/worker-spec-detail.js';
import { KeyValue } from '../kit/key-value.js';
import { RefChip } from '../kit/ref-chip.js';

export interface WorkerSpecFieldsProps {
  readonly spec: WorkerSpec;
  /** S11 GO15a: the WorkerDefinition version the WorkerSpec sits on — read by version
   *  (`get_worker_definition`) so each field says what it changes of the definition's. */
  readonly worker: PlanStep['worker'];
  readonly http: CapabilityCaller;
  /** The workspace's gatekeepers by id, where already read; the others resolve themselves. */
  readonly gateNames: ReadonlyMap<string, string>;
  readonly t: Translate;
}

type ListField = 'skills' | 'gates' | 'capabilities';

/**
 * components/goals/WorkerSpecFields (S11 GO8a; plan §3.1, I-G8): what a step sets differently for
 * its Worker — the plan entry's WorkerSpec, field by field, each as the console names it (gates by
 * name, capabilities by their console names, Skills as the plan names them), under a line naming
 * what was set and over one saying how it combines with the Worker: lists and the model replace
 * the Worker's, the responsibility follows its prompt, and nothing reaches past the Worker ceiling,
 * the requester's authority now or the goal's budget. Shown on the confirmation card and with the
 * step after it, so what is confirmed is what the step was admitted with.
 *
 * S11 GO15a (`s11-w2/go15-default-plan.md` §4): each field against the definition version the step
 * names — what a list keeps, drops and adds, the definition's model, where the responsibility goes
 * — and what the step keeps of its Worker as it is. A version the reader cannot read (another's
 * draft, gone) leaves the WorkerSpec on its own, said in one line.
 */
export function WorkerSpecFields({ spec, worker, http, gateNames, t }: WorkerSpecFieldsProps) {
  const read = useCapability<WorkerDefinitionWire | null>(http, 'get_worker_definition', {
    definitionId: worker.definitionId,
    version: worker.version,
  });
  const definition = read.state.status === 'ready' ? read.state.data : undefined;
  const base: WorkerSpecBase | null | undefined =
    definition === undefined
      ? undefined
      : definition
        ? workerSpecBaseOf(definition.definition)
        : null;
  const unreadable = read.state.status === 'error' || base === null;
  const definitionHref = hrefs.catalog(
    'workers',
    workerItemId({ id: worker.definitionId, version: worker.version }),
  );

  const none = <span className="text-3">{t('无', 'None')}</span>;
  const gateChips = (ids: readonly string[], testId: string) =>
    ids.length === 0 ? (
      none
    ) : (
      <span className="row-wrap">
        {ids.map((id) => (
          <RefChip
            key={id}
            kind="gatekeeper"
            id={id}
            {...(gateNames.has(id) ? { name: gateNames.get(id) } : { http })}
            size="s"
            testId={testId}
          />
        ))}
      </span>
    );
  const joined = (field: ListField, items: readonly string[]) =>
    (field === 'skills'
      ? items.map(skillRefShown)
      : field === 'capabilities'
        ? items.map((name) => actionLabel(name, t))
        : items.map((id) => gateNames.get(id) ?? shortId(id))
    ).join(t('、', ', '));
  const against = (children: ReactNode, field: string) => (
    <span className="text-3 text-small" data-testid="goal-step-spec-base" data-field={field}>
      {children}
    </span>
  );
  const listAgainst = (field: ListField): ReactNode => {
    if (!base) return null;
    if (base[field] === undefined) {
      return against(
        field === 'capabilities'
          ? t(
              '定义没有列出能力（Worker 默认只有观察和提议类能力）；这一步改为上面这些',
              'The definition lists no capabilities (by default a Worker holds observe and propose ones only); this step sets the ones above',
            )
          : field === 'skills'
            ? t(
                '定义不装载 Skill；这一步装载上面这些',
                'The definition mounts no Skill; this step mounts the ones above',
              )
            : t(
                '定义不作用于任何门；这一步作用于上面这些',
                'The definition acts on no gate; this step acts on the ones above',
              ),
        field,
      );
    }
    const { kept, removed, added } = specListAgainst(base[field], spec[field] ?? []);
    const zh = [
      ...(kept.length > 0 ? [`保留 ${joined(field, kept)}`] : []),
      ...(removed.length > 0 ? [`去掉 ${joined(field, removed)}`] : []),
      ...(added.length > 0 ? [`加上 ${joined(field, added)}`] : []),
    ];
    const en = [
      ...(kept.length > 0 ? [`keeps ${joined(field, kept)}`] : []),
      ...(removed.length > 0 ? [`drops ${joined(field, removed)}`] : []),
      ...(added.length > 0 ? [`adds ${joined(field, added)}`] : []),
    ];
    return against(
      removed.length === 0 && added.length === 0
        ? t('和定义的一样', 'The same as the definition’s')
        : t(`相对定义：${zh.join('，')}`, `Against the definition: ${en.join('; ')}`),
      field,
    );
  };
  const value = (field: keyof WorkerSpec) => {
    switch (field) {
      case 'instructions':
        return (
          <span className="stack-s">
            <span className="pre-wrap wrap-anywhere" data-testid="goal-step-spec-instructions">
              {spec.instructions}
            </span>
            {against(
              <>
                {t(
                  '追加在定义的系统提示之后，不替换它 · ',
                  'Added after the definition’s system prompt, never in its place · ',
                )}
                <a href={definitionHref} data-testid="goal-step-spec-definition-link">
                  {t('查看定义', 'Open the definition')}
                </a>
              </>,
              'instructions',
            )}
          </span>
        );
      case 'skills':
        return (
          <span className="stack-s">
            {(spec.skills ?? []).length === 0 ? (
              none
            ) : (
              <span data-testid="goal-step-spec-skills">{joined('skills', spec.skills ?? [])}</span>
            )}
            {listAgainst('skills')}
          </span>
        );
      case 'gates':
        return (
          <span className="stack-s">
            {gateChips(spec.gates ?? [], 'goal-step-spec-gate')}
            {listAgainst('gates')}
          </span>
        );
      case 'capabilities':
        return (
          <span className="stack-s">
            {(spec.capabilities ?? []).length === 0 ? (
              none
            ) : (
              <span data-testid="goal-step-spec-capabilities">
                {joined('capabilities', spec.capabilities ?? [])}
              </span>
            )}
            {listAgainst('capabilities')}
          </span>
        );
      case 'model':
        return (
          <span className="stack-s">
            <span className="mono" data-testid="goal-step-spec-model">
              {spec.model}
            </span>
            {base
              ? against(
                  base.model === undefined
                    ? t('定义没有设定模型', 'The definition sets no model')
                    : base.model === spec.model
                      ? t('和定义的一样', 'The same as the definition’s')
                      : t(
                          `定义：${base.model} → 这一步：${spec.model}`,
                          `Definition: ${base.model} → this step: ${spec.model}`,
                        ),
                  'model',
                )
              : null}
          </span>
        );
      case 'observeScope':
        return (
          <span className="stack-s">
            {(spec.observeScope ?? []).length === 0 ? (
              <span className="text-3">{t('不读取任何门', 'Reads through no gatekeeper')}</span>
            ) : (
              gateChips(spec.observeScope ?? [], 'goal-step-spec-observe-gate')
            )}
            {against(
              t(
                'Worker 定义不限观察范围；这一步只读上面这些',
                'A Worker definition does not limit what is observed; this step reads only these',
              ),
              'observeScope',
            )}
          </span>
        );
      case 'tokenBudget':
        return (
          <span className="stack-s">
            <span className="tabular" data-testid="goal-step-spec-token-budget">
              {(spec.tokenBudget ?? 0).toLocaleString()}
            </span>
            {against(
              t(
                'Worker 定义不设上限，只受目标剩下的预算限制',
                'A Worker definition sets no cap; only what is left of the goal’s budget caps it',
              ),
              'tokenBudget',
            )}
          </span>
        );
    }
  };
  const inherited = base ? inheritedBaseFields(spec, base) : [];
  const inheritedValue = (field: (typeof inherited)[number]) =>
    field === 'model' ? (base?.model ?? '') : joined(field, base?.[field] ?? []) || t('无', 'none');
  return (
    <div className="stack-s" data-testid="goal-step-spec">
      <span className="text-small">{workerSpecSummary(spec, t)}</span>
      <KeyValue
        items={workerSpecFields(spec).map((field) => ({
          key: field,
          label: workerSpecFieldLabel(field, t),
          value: value(field),
        }))}
        testId="goal-step-spec-fields"
      />
      {inherited.length > 0 ? (
        <span className="text-small text-3" data-testid="goal-step-spec-inherited">
          {t(
            `其余沿用定义：${inherited.map((field) => `${workerSpecFieldLabel(field, t)}（${inheritedValue(field)}）`).join('，')}`,
            `Kept from the definition: ${inherited.map((field) => `${workerSpecFieldLabel(field, t)} (${inheritedValue(field)})`).join('; ')}`,
          )}
        </span>
      ) : null}
      {unreadable ? (
        <span className="text-small text-3" data-testid="goal-step-spec-base-unreadable">
          {t(
            `读不到这一步的 Worker 定义（v${worker.version}），这里只列出这一步的调整。`,
            `This step’s Worker definition (v${worker.version}) cannot be read, so only what the step sets is listed.`,
          )}
        </span>
      ) : null}
      <span className="text-3 text-small" data-testid="goal-step-spec-combination">
        {workerSpecCombination(spec, t)}
      </span>
    </div>
  );
}
