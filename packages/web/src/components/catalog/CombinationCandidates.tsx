import {
  COMBINATION_STEP_ONLY_FIELDS,
  type CombinationCandidateWire,
  type CombinationCandidatesWire,
  type CombinationEvidenceWire,
  type WorkerDefinitionDerivationWire,
  type WorkerDefinitionWire,
  type WorkerSpec,
} from '@nexttime/shared';
import { useState } from 'react';
import { useCapability } from '../../hooks/useCapability.js';
import { useRoleCan } from '../../hooks/useRoleCan.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { isForbiddenError } from '../../lib/errors.js';
import { formatRelative, prettyJsonVisible, zhJoin } from '../../lib/format.js';
import { workerSpecFieldLabel } from '../../lib/goals.js';
import { type Translate, useT } from '../../lib/i18n.js';
import { Button } from '../kit/button.js';
import { Confirm } from '../kit/confirm.js';
import { ErrorBanner } from '../kit/error-banner.js';
import { Field } from '../kit/field.js';
import { KeyValue } from '../kit/key-value.js';
import { RefChip } from '../kit/ref-chip.js';
import { SkeletonRows } from '../kit/skeleton.js';
import { contentFieldText } from './ChangesTab.js';

/**
 * components/catalog/CombinationCandidates (S11 GO16b; `@nexttime/shared` `combination.ts`, GO16
 * F1–F7 = A): 「可沉淀的组合」 on a published Worker's detail — the combinations of the family's
 * published versions with one goal step's adjustments that kept working
 * (`get_combination_candidates`), and 「沉淀为定义」, which turns one into the first draft of a new
 * Worker (`propose_definition_from_combination`). Builders and up; nothing for anyone else, or on
 * a 403.
 *
 *   - Each candidate: the version and the fields its adjustments set, then its number (as 「使用
 *     情况」 names it), its evidence (primary outcomes only — the executor's own report does not
 *     count), the step-only fields that do not carry over, and the families already made from it.
 *   - What the adjustments say, and the button, only for a reader of a goal they ran in (its
 *     requester, or the owner — F7); anyone else is told whom to ask.
 *   - 「沉淀为定义」 confirms next to the button with the definition it writes, a name, and the
 *     warning the coordinator asked for (2026-11-07): the content goes into a new draft, which
 *     everyone in the workspace sees once it is published. Proposing writes a draft only — it is
 *     reviewed and published like any other, and nothing here publishes or grants.
 */
export function CombinationCandidatesSection({
  http,
  definitionId,
  baseName,
  familyOf,
  onProposed,
}: {
  readonly http: CapabilityCaller;
  readonly definitionId: string;
  /** The family's name, for the new draft's default name. */
  readonly baseName: string;
  /** A family id's name and where its latest visible version is, when the page has read it. */
  readonly familyOf: (id: string) => { readonly name: string; readonly href: string } | null;
  /** The draft just proposed — the page selects it. */
  readonly onProposed: (draft: WorkerDefinitionWire) => void;
}) {
  const t = useT();
  const can = useRoleCan(http);
  const allowed = can('get_combination_candidates') === true;
  const read = useCapability<CombinationCandidatesWire | null>(
    http,
    'get_combination_candidates',
    { definitionId },
    { enabled: allowed },
  );
  const state = read.state;
  if (!allowed || (state.status === 'error' && isForbiddenError(state.error))) return null;
  if (state.status === 'ready' && state.data === null) return null;

  return (
    <div className="stack-s" data-testid="combination-candidates">
      <span className="section-title">{t('可沉淀的组合', 'Combinations worth keeping')}</span>
      {state.status === 'loading' ? (
        <SkeletonRows count={2} />
      ) : state.status === 'error' ? (
        <ErrorBanner error={state.error} onRetry={() => void read.reload()} />
      ) : state.data ? (
        <>
          <span className="text-3 text-small" data-testid="combination-candidates-rule">
            {thresholdsText(state.data.thresholds, t)}
          </span>
          {state.data.candidates.length === 0 ? (
            <span className="text-3 text-small" data-testid="combination-candidates-empty">
              {t('现在还没有达到门槛的组合。', 'No combination meets them yet.')}
            </span>
          ) : (
            state.data.candidates.map((candidate) => (
              <CandidateCard
                key={`${candidate.version}:${candidate.specRef}`}
                http={http}
                candidate={candidate}
                baseName={baseName}
                familyOf={familyOf}
                onProposed={(draft) => {
                  void read.reload();
                  onProposed(draft);
                }}
                onStale={() => void read.reload()}
                t={t}
              />
            ))
          )}
        </>
      ) : null}
    </div>
  );
}

function thresholdsText(thresholds: CombinationCandidatesWire['thresholds'], t: Translate): string {
  const rate = Math.round(thresholds.minRate * 100);
  return t(
    `某个版本带着同一份步骤调整，近 ${thresholds.windowDays} 天至少达成 ${thresholds.minAchieved} 次、来自至少 ${thresholds.minGoals} 个目标、达成率不低于 ${rate}%，且没有建议复核，就可以沉淀成一个新的 Worker。只数请求人确认和平台检查的结果，执行者自报的不算。`,
    `A version run with the same step adjustments can become a Worker of its own once, over the last ${thresholds.windowDays} days, it was achieved at least ${thresholds.minAchieved} times in at least ${thresholds.minGoals} goals at a rate of at least ${rate}%, with no review suggested. Only the requester's word and platform checks count, never the executor's own report.`,
  );
}

/** 「近 90 天达成 3 次，来自 3 个目标，达成率 100%（3 / 3）」 */
export function evidenceText(evidence: CombinationEvidenceWire, t: Translate): string {
  const judged = evidence.achieved + evidence.notAchieved;
  const rate = evidence.rate === null ? null : Math.round(evidence.rate * 100);
  return t(
    `近 ${evidence.windowDays} 天达成 ${evidence.achieved} 次，来自 ${evidence.goals} 个目标，达成率 ${rate ?? '—'}%（${evidence.achieved} / ${judged}）`,
    `Over the last ${evidence.windowDays} days: achieved ${evidence.achieved} times in ${evidence.goals} goals, ${rate ?? '—'}% (${evidence.achieved} / ${judged})`,
  );
}

function candidateLabel(candidate: CombinationCandidateWire, t: Translate): string {
  const fields = candidate.fields.map((field) => workerSpecFieldLabel(field, t));
  return t(
    `v${candidate.version} · ${zhJoin('调整了', fields.join('、'))} · 编号 ${candidate.specRef}`,
    `v${candidate.version} · sets ${fields.join(', ')} · ref ${candidate.specRef}`,
  );
}

function CandidateCard({
  http,
  candidate,
  baseName,
  familyOf,
  onProposed,
  onStale,
  t,
}: {
  readonly http: CapabilityCaller;
  readonly candidate: CombinationCandidateWire;
  readonly baseName: string;
  readonly familyOf: (id: string) => { readonly name: string; readonly href: string } | null;
  readonly onProposed: (draft: WorkerDefinitionWire) => void;
  readonly onStale: () => void;
  readonly t: Translate;
}) {
  const testId = `combination-candidate-${candidate.version}-${candidate.specRef}`;
  const stepOnly = COMBINATION_STEP_ONLY_FIELDS.filter((field) => candidate.fields.includes(field));
  return (
    <div className="card stack-s" data-testid={testId}>
      <span className="wrap-anywhere" data-testid={`${testId}-label`}>
        <strong>{candidateLabel(candidate, t)}</strong>
      </span>
      <span className="text-small" data-testid={`${testId}-evidence`}>
        {evidenceText(candidate.evidence, t)}
      </span>
      {stepOnly.length > 0 ? (
        <span className="text-3 text-small" data-testid={`${testId}-step-only`}>
          {t(
            `${zhJoin(stepOnly.map((field) => workerSpecFieldLabel(field, t)).join('、'), '只对目标步骤生效')}，定义里没有这一项，沉淀时不带过去。`,
            `${stepOnly.map((field) => workerSpecFieldLabel(field, t)).join(', ')} ${stepOnly.length === 1 ? 'applies' : 'apply'} to a goal step only — a definition has no such field, so ${stepOnly.length === 1 ? 'it does' : 'they do'} not carry over.`,
          )}
        </span>
      ) : null}
      {candidate.derivedAs.length > 0 ? (
        <span className="row-wrap text-small" data-testid={`${testId}-derived`}>
          <span className="text-3">{t('已经沉淀为：', 'Already kept as:')}</span>
          {candidate.derivedAs.map((id) => {
            const family = familyOf(id);
            return (
              <RefChip
                key={id}
                kind="workerDefinition"
                id={id}
                name={family?.name}
                href={family?.href}
                size="s"
              />
            );
          })}
        </span>
      ) : null}
      {candidate.spec === null || candidate.definition === null || candidate.specDigest === null ? (
        <span className="text-3 text-small" data-testid={`${testId}-unreadable`}>
          {t(
            '这份调整只用在你看不到的目标里，所以看不到它写了什么，也不能由你沉淀。请工作区 owner 或这些目标的请求人来沉淀。',
            'These adjustments ran only in goals you cannot see, so what they say is not shown and you cannot keep them. Ask the workspace owner or one of those goals’ requesters.',
          )}
        </span>
      ) : (
        <KeepAsDefinition
          http={http}
          candidate={candidate}
          specDigest={candidate.specDigest}
          spec={candidate.spec}
          definition={candidate.definition}
          baseName={baseName}
          onProposed={onProposed}
          onStale={onStale}
          testId={testId}
          t={t}
        />
      )}
    </div>
  );
}

function KeepAsDefinition({
  http,
  candidate,
  specDigest,
  spec,
  definition,
  baseName,
  onProposed,
  onStale,
  testId,
  t,
}: {
  readonly http: CapabilityCaller;
  readonly candidate: CombinationCandidateWire;
  readonly specDigest: string;
  readonly spec: WorkerSpec;
  readonly definition: Readonly<Record<string, unknown>>;
  readonly baseName: string;
  readonly onProposed: (draft: WorkerDefinitionWire) => void;
  readonly onStale: () => void;
  readonly testId: string;
  readonly t: Translate;
}) {
  const can = useRoleCan(http);
  const [open, setOpen] = useState(false);
  const defaultName = t(`${baseName}（调整版）`, `${baseName} (adjusted)`);
  const [name, setName] = useState(defaultName);
  const nameId = `${testId}-name`;
  // Both capabilities start at builder today; the offer still asks for its own.
  if (can('propose_definition_from_combination') === false) return null;

  async function keep(): Promise<void> {
    try {
      const draft = await http.call<WorkerDefinitionWire>('propose_definition_from_combination', {
        definitionId: candidate.definitionId,
        version: candidate.version,
        specDigest,
        name: name.trim(),
      });
      onProposed(draft);
    } catch (err) {
      // It no longer qualifies, or its goals are no longer readable: show the list as it is now.
      onStale();
      throw err;
    }
  }

  return (
    <Confirm
      tier="medium"
      open={open}
      onOpenChange={setOpen}
      anchor={
        <span className="row-wrap">
          <Button
            variant="secondary"
            size="s"
            onClick={() => {
              setName(defaultName);
              setOpen(true);
            }}
            data-testid={`${testId}-keep`}
          >
            {candidate.derivedAs.length > 0
              ? t('再沉淀一份…', 'Keep another definition…')
              : t('沉淀为定义…', 'Keep as a definition…')}
          </Button>
        </span>
      }
      title={t('沉淀为新的 Worker 定义', 'Keep as a new Worker definition')}
      description={
        <span className="stack-s" data-testid={`${testId}-warning`}>
          <strong>
            {t(
              '这段内容会写进一份新的定义草稿；发布后，工作区里所有人都能看到它。',
              'This content goes into a new definition draft; once it is published, everyone in the workspace can see it.',
            )}
          </strong>
          <span>
            {t(
              '它原本只在目标里，只有目标的请求人和 owner 看得到。请先确认里面没有只该留在目标里的内容。',
              'Until now it was only in goals, seen by their requesters and the owner. Check it holds nothing that should stay in a goal.',
            )}
          </span>
        </span>
      }
      impact={[
        t(
          `新建一个 Worker 草稿：v${candidate.version} 的定义，加上这份步骤调整`,
          `A new Worker draft: v${candidate.version}'s definition with these step adjustments`,
        ),
        t(
          '草稿只有你看得到；审核后由你发布，和其他草稿一样',
          'Only you see the draft; you review and publish it like any other',
        ),
        t(
          '新定义会记下它从哪个版本、哪份调整来，以及当时的证据，以后不能改',
          'The new definition records which version and adjustments it came from, and the evidence then — never changed',
        ),
      ]}
      confirmLabel={t('写成草稿', 'Write the draft')}
      confirmDisabled={name.trim() === ''}
      onConfirm={keep}
      errorOverrides={{
        combination_not_eligible: t(
          '它现在已经不满足沉淀的条件（可能有了新的未达成结果，或旧的结果超出了时间窗口），什么也没有写。列表已经更新。',
          'It no longer qualifies (a new outcome was not achieved, or older ones left the window), so nothing was written. The list now shows how things are.',
        ),
        not_found: t(
          '你已经读不到这份调整所在的目标，什么也没有写。列表已经更新。',
          'You can no longer read a goal these adjustments ran in, so nothing was written. The list now shows how things are.',
        ),
      }}
      testId={`${testId}-confirm`}
    >
      <Field id={nameId} label={t('新定义的名称', 'Name of the new definition')} required>
        <input
          id={nameId}
          className="input"
          value={name}
          maxLength={200}
          onChange={(event) => setName(event.target.value)}
          data-testid={nameId}
          data-discard-guard
        />
      </Field>
      <details className="disclosure" data-testid={`${testId}-preview`}>
        <summary>{t('要写进草稿的定义', 'The definition the draft gets')}</summary>
        <div className="disclosure-body">
          <DefinitionPreview
            definition={definition}
            spec={spec}
            testId={`${testId}-preview`}
            t={t}
          />
        </div>
      </details>
    </Confirm>
  );
}

/** The WorkerDefinition fields a WorkerSpec replaces outright when kept (`mergeCombinationDefinition`). */
const REPLACED_FROM_SPEC = ['skills', 'gates', 'capabilities', 'model'] as const;

function previewFieldLabel(field: string, t: Translate): string {
  if (field === 'inputSchema') return t('输入约定', 'input contract');
  if (field === 'outputSchema') return t('输出约定', 'output contract');
  return contentFieldText(field, t);
}

/**
 * What the draft gets, field by field (UX acceptance of #1071, P2): the system prompt as wrapped
 * text with the part the step's adjustments add set apart and marked — the warning above asks the
 * person to check exactly that part, so it must never sit off to the right of a scrolled code
 * block — then every other field on its own line, marked where the adjustments set it.
 */
function DefinitionPreview({
  definition,
  spec,
  testId,
  t,
}: {
  readonly definition: Readonly<Record<string, unknown>>;
  readonly spec: WorkerSpec;
  readonly testId: string;
  readonly t: Translate;
}) {
  const prompt = typeof definition.systemPrompt === 'string' ? definition.systemPrompt : '';
  const instructions = spec.instructions?.trim() ?? '';
  const added = instructions !== '' && prompt.endsWith(`\n\n${instructions}`) ? instructions : null;
  const basePrompt = added === null ? prompt : prompt.slice(0, -(added.length + 2));
  const fromSpec = new Set<string>(REPLACED_FROM_SPEC.filter((field) => spec[field] !== undefined));
  const marker = (
    <span className="chip chip-accent chip-s">
      {t('来自步骤调整', 'From the step adjustments')}
    </span>
  );
  const others = Object.entries(definition).filter(([field]) => field !== 'systemPrompt');
  return (
    <div className="stack-s" data-testid={`${testId}-content`}>
      <span className="text-3 text-small">{contentFieldText('systemPrompt', t)}</span>
      {basePrompt !== '' ? <p className="pre-wrap wrap-anywhere">{basePrompt}</p> : null}
      {added !== null ? (
        <span className="stack-s" data-testid={`${testId}-added`}>
          {marker}
          <p className="pre-wrap wrap-anywhere">{added}</p>
        </span>
      ) : null}
      {others.length > 0 ? (
        <KeyValue
          testId={`${testId}-fields`}
          items={others.map(([field, value]) => ({
            key: field,
            label: previewFieldLabel(field, t),
            value: (
              <span className="row-wrap">
                {Array.isArray(value) && value.every((item) => typeof item === 'string') ? (
                  <span className="wrap-anywhere">{value.join('、')}</span>
                ) : typeof value === 'string' ? (
                  <span className="pre-wrap wrap-anywhere">{value}</span>
                ) : (
                  <pre className="code-block pre-wrap">{prettyJsonVisible(value)}</pre>
                )}
                {fromSpec.has(field) ? marker : null}
              </span>
            ),
          }))}
        />
      ) : null}
    </div>
  );
}

/** 「来历」 on a Worker derived from a combination: the base version, the evidence when it was
 *  proposed, and when (never the adjustments' digest — `WorkerDefinitionDerivationWire`). */
export function DerivedFromNote({
  derivedFrom,
  base,
  t,
}: {
  readonly derivedFrom: WorkerDefinitionDerivationWire;
  readonly base: { readonly name: string; readonly href: string } | null;
  readonly t: Translate;
}) {
  return (
    <span className="stack-s" data-testid="worker-detail-derived-from">
      <span className="row-wrap">
        <span>{t('由', 'Kept from')}</span>
        <RefChip
          kind="workerDefinition"
          id={derivedFrom.definitionId}
          name={base ? `${base.name} v${derivedFrom.version}` : undefined}
          href={base?.href}
          size="s"
        />
        <span>
          {t(
            `加一份步骤调整沉淀而来，${formatRelative(derivedFrom.derivedAt)}`,
            `with one goal step's adjustments, ${formatRelative(derivedFrom.derivedAt)}`,
          )}
        </span>
      </span>
      <span className="text-3 text-small">
        {t('当时：', 'At the time: ')}
        {evidenceText(derivedFrom.evidence, t)}
      </span>
    </span>
  );
}
