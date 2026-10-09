import { BLAST_RADIUS_VALUES, type BlastRadius, type PolicyWire } from '@nexttime/shared';
import { useState } from 'react';
import type { CapabilityCaller } from '../../lib/clients.js';
import { type OperationChoice, useGateOperations } from '../../lib/gate-operations.js';
import type { GatekeeperListRow } from '../../lib/governance.js';
import { type Translate, useT } from '../../lib/i18n.js';
import { BLAST_RADIUS_TONES } from '../../lib/status-tone.js';
import { Button } from '../kit/button.js';
import { Combobox } from '../kit/combobox.js';
import { Confirm } from '../kit/confirm.js';
import { Field } from '../kit/field.js';
import { Notice } from '../kit/notice.js';
import { Select } from '../kit/select.js';
import { Sheet, SheetContent, SheetFooter, SheetHeader, SheetTitle } from '../kit/sheet.js';

const UNSET = '__unset__';
const REQUESTER_INHERIT = '__inherit__';
/** The scope select's "every gate" value — a workspace-wide rule (`gatekeeperId` omitted). */
const ALL_GATES = '__all_gates__';

function blastRadiusLabel(value: BlastRadius, t: Translate): string {
  const label = BLAST_RADIUS_TONES[value].label;
  return typeof label === 'string' ? label : t(label.zh, label.en);
}

/** The note beside an Operation in the picker: "中影响", plus how many gates publish it for a
 *  workspace-wide rule. */
function operationSecondary(choice: OperationChoice, allGates: boolean, t: Translate): string {
  const parts: string[] = [];
  if (choice.blastRadius !== null) parts.push(blastRadiusLabel(choice.blastRadius, t));
  if (allGates && choice.gateCount > 1) {
    parts.push(t(`${choice.gateCount} 个门`, `${choice.gateCount} gates`));
  }
  return parts.join(' · ');
}

export interface PolicyEditSheetProps {
  readonly http: CapabilityCaller;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** `undefined` — create a new Policy row: the gate first, then one of its published Operations
   *  (manual entry as a fallback). Given — edit
   *  this existing row, `actionKindTag` and the gate are read-only (`set_policy` upserts by
   *  `(gatekeeperId, actionKindTag)`, so changing either would silently create a second, unrelated
   *  row instead of editing this one). */
  readonly editing?: PolicyWire;
  /** The gates a new rule may be scoped to (R-20 / D-15) — also names an edited row's gate. */
  readonly gatekeepers: readonly GatekeeperListRow[];
  readonly onSaved: (policy: PolicyWire) => void;
}

/**
 * components/governance/PolicyEditSheet (S8 W4 item 1, leftover 12 界面缺口 "`set_policy` — 模型页
 * 只读策略表，owner 改不了"): the owner-only editor for one workspace Policy row
 * (`set_policy{policy:{actionKindTag,blastRadius?,autoApprove,requesterCanApprove?}}` —
 * `governance/policy/policies.ts`'s `SetPolicyPayloadSchema`, the real shape behind the registry's
 * opaque `paramsSchema:{policy:jsonRecord}`). Loosening the policy (turning auto-approval on, or
 * letting the requester approve their own request) confirms at the `irreversible` tier; tightening
 * (or any change to `blastRadius` alone) confirms at `medium` — mirrors the same "放松 / 收紧"
 * split `RegisteredSystemsSection`'s "按公告刷新治理字段" flow already established for a materially
 * identical decision (turning human review off is the one irreversible-tier action here).
 *
 * R-20 / D-15: a rule applies either to one gate's action kind or to the name on every gate. Only
 * a gate rule can turn auto-approval on (the kernel refuses it workspace-wide — the approver must
 * see which gate, since Operation names collide across gates), so the checkbox is disabled while
 * "every gate" is selected.
 */
export function PolicyEditSheet({
  http,
  open,
  onOpenChange,
  editing,
  gatekeepers,
  onSaved,
}: PolicyEditSheetProps) {
  const t = useT();
  const isEdit = editing !== undefined;

  const [gateScope, setGateScope] = useState<string>(editing?.gatekeeperId ?? ALL_GATES);
  const [actionKindTag, setActionKindTag] = useState(editing?.actionKindTag ?? '');
  const [blastRadius, setBlastRadius] = useState<BlastRadius | typeof UNSET>(
    editing?.blastRadius ?? UNSET,
  );
  const [autoApprove, setAutoApprove] = useState(editing?.autoApprove ?? false);
  const [requesterCanApprove, setRequesterCanApprove] = useState<
    'true' | 'false' | typeof REQUESTER_INHERIT
  >(
    editing?.requesterCanApprove === true
      ? 'true'
      : editing?.requesterCanApprove === false
        ? 'false'
        : REQUESTER_INHERIT,
  );
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  /** The person chose "手动输入" over the Operation list. */
  const [manualKind, setManualKind] = useState(false);
  /** The Operation whose declared blast radius was copied into `blastRadius` (cleared once the
   *  person picks a radius themselves). */
  const [blastPrefilledFrom, setBlastPrefilledFrom] = useState<string | null>(null);

  // console-ux-2: the action kind is the Operation's own name (`request-action-handler.ts` passes
  // `operationName` as the request's `action_kind`), so a new rule offers the chosen gate's
  // published Operations — every gate's for a workspace-wide rule — instead of free text, where
  // a typo saved a rule that silently never matched. Manual entry stays as a fallback.
  const operations = useGateOperations(
    http,
    isEdit ? null : gateScope === ALL_GATES ? 'all' : { gatekeeperId: gateScope },
  );
  const choices: readonly OperationChoice[] =
    operations.state.status === 'ready' ? operations.state.choices : [];
  const listUnavailable =
    operations.state.status === 'error' ||
    (operations.state.status === 'ready' && choices.length === 0);
  const showManualInput = isEdit || manualKind || listUnavailable;
  const trimmedKind = actionKindTag.trim();
  const unknownManualKind =
    !isEdit &&
    showManualInput &&
    trimmedKind !== '' &&
    choices.length > 0 &&
    !choices.some((choice) => choice.name === trimmedKind);
  const caseInsensitiveMatch = unknownManualKind
    ? choices.find((choice) => choice.name.toLowerCase() === trimmedKind.toLowerCase())
    : undefined;

  function pickOperation(name: string): void {
    setActionKindTag(name);
    const choice = choices.find((row) => row.name === name);
    if (choice?.blastRadius) {
      setBlastRadius(choice.blastRadius);
      setBlastPrefilledFrom(name);
    } else if (blastPrefilledFrom !== null) {
      setBlastRadius(UNSET);
      setBlastPrefilledFrom(null);
    }
  }

  function changeGateScope(next: string): void {
    setGateScope(next);
    // A name picked from the previous gate's list may not exist on the new one; a typed name is
    // the person's own and stays.
    if (!manualKind) {
      setActionKindTag('');
      if (blastPrefilledFrom !== null) {
        setBlastRadius(UNSET);
        setBlastPrefilledFrom(null);
      }
    }
  }

  // I8 (`governance/policy/engine.ts` `assertPolicyWriteAllowed`): the kernel refuses
  // `autoApprove:true` at `blastRadius:'high'` — mirrored client-side so the confirm never opens
  // on a request the kernel will 400 anyway.
  const autoApproveBlockedByBlastRadius = blastRadius === 'high';
  const workspaceWide = gateScope === ALL_GATES;
  const gateName = workspaceWide
    ? null
    : (gatekeepers.find((gate) => gate.id === gateScope)?.name ?? gateScope);
  const effectiveAutoApprove =
    autoApproveBlockedByBlastRadius || workspaceWide ? false : autoApprove;

  const prevAutoApprove = editing?.autoApprove ?? false;
  const prevRequesterCanApprove = editing?.requesterCanApprove ?? null;
  const nextRequesterCanApprove =
    requesterCanApprove === REQUESTER_INHERIT ? null : requesterCanApprove === 'true';
  const isLoosening =
    (effectiveAutoApprove && !prevAutoApprove) ||
    (nextRequesterCanApprove === true && prevRequesterCanApprove !== true);

  const canSubmit = trimmedKind.length > 0 && !submitting;

  function resetAndClose(): void {
    setConfirmOpen(false);
    onOpenChange(false);
  }

  async function submit(): Promise<void> {
    const policy: Record<string, unknown> = {
      actionKindTag: actionKindTag.trim(),
      autoApprove: effectiveAutoApprove,
    };
    if (!workspaceWide) policy.gatekeeperId = gateScope;
    if (blastRadius !== UNSET) policy.blastRadius = blastRadius;
    if (nextRequesterCanApprove !== null) policy.requesterCanApprove = nextRequesterCanApprove;

    setSubmitting(true);
    try {
      const saved = await http.call<PolicyWire>('set_policy', { policy });
      onSaved(saved);
      resetAndClose();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Sheet open={open} onOpenChange={(next) => !submitting && onOpenChange(next)}>
      <SheetContent data-testid="policy-edit-sheet">
        <SheetHeader>
          <SheetTitle>
            {isEdit ? t('编辑策略', 'Edit policy') : t('新增策略', 'New policy')}
          </SheetTitle>
        </SheetHeader>

        <div className="stack">
          <Field
            id="pe-gate-scope"
            label={t('适用范围', 'Applies to')}
            hint={
              isEdit
                ? t('已有策略的键，不可修改。', 'The existing policy’s key — cannot be changed.')
                : gatekeepers.length === 0
                  ? t(
                      '工作区还没有接入任何门，目前只能建「所有门」的规则（只能收紧）。',
                      'No gate is connected to this workspace yet, so only an “Every gate” rule (tighten only) is possible.',
                    )
                  : t(
                      '先选门。选一个门：规则只作用于该门上的这个动作，对所有发起人生效。选「所有门」：作用于每个门上的同名动作，只能收紧（要求审批），不能开启自动批准。',
                      'Choose the gate first. One gate: the rule covers this action on that gate only, for every requester. “Every gate” covers the same name on every gate and can only tighten (require approval) — it cannot turn auto-approval on.',
                    )
            }
          >
            <Select
              id="pe-gate-scope"
              aria-label={t('适用范围', 'Applies to')}
              value={gateScope}
              onChange={(event) => changeGateScope(event.target.value)}
              disabled={isEdit || submitting}
              data-testid="policy-edit-gate-scope"
            >
              <option value={ALL_GATES}>
                {t('所有门（只能收紧）', 'Every gate (tighten only)')}
              </option>
              {isEdit && !workspaceWide && !gatekeepers.some((gate) => gate.id === gateScope) ? (
                <option value={gateScope}>{gateScope}</option>
              ) : null}
              {gatekeepers.map((gate) => (
                <option key={gate.id} value={gate.id}>
                  {gate.name}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            id="pe-action-kind"
            label={t('动作（Operation）', 'Action (Operation)')}
            required
            hint={
              isEdit
                ? t('已有策略的键，不可修改。', 'The existing policy’s key — cannot be changed.')
                : showManualInput
                  ? t(
                      '手动输入 Operation 名：必须与门发布的名称完全一致（区分大小写），否则规则不会命中任何请求。',
                      'Manual entry: type the Operation name exactly as the gate publishes it (case-sensitive) — otherwise the rule never matches a request.',
                    )
                  : workspaceWide
                    ? t(
                        '从所有门已发布的 Operation 中选择；规则作用于每个门上的同名 Operation。',
                        'Choose from the Operations published on every gate; the rule covers that name on every gate.',
                      )
                    : t(
                        `从门「${gateName}」已发布的 Operation 中选择。`,
                        `Choose one of the Operations gate “${gateName}” publishes.`,
                      )
            }
          >
            {showManualInput ? (
              <input
                id="pe-action-kind"
                className="input mono"
                value={actionKindTag}
                onChange={(event) => setActionKindTag(event.target.value)}
                onBlur={() => setActionKindTag((value) => value.trim())}
                disabled={isEdit || submitting}
                placeholder={isEdit ? undefined : t('Operation 名', 'Operation name')}
                aria-invalid={unknownManualKind || undefined}
                data-testid="policy-edit-action-kind-input"
              />
            ) : (
              // console-ux-3: a gate imported from OpenAPI publishes dozens to hundreds of
              // Operations — a searchable combobox instead of a native select.
              <Combobox
                id="pe-action-kind"
                options={choices.map((choice) => ({
                  value: choice.name,
                  label: choice.name,
                  secondary: operationSecondary(choice, workspaceWide, t) || undefined,
                }))}
                value={actionKindTag}
                onChange={pickOperation}
                loading={operations.state.status === 'loading'}
                disabled={submitting}
                mono
                placeholder={
                  operations.state.status === 'loading'
                    ? t('正在加载 Operation…', 'Loading Operations…')
                    : t('输入以搜索 Operation…', 'Type to search Operations…')
                }
                testId="policy-edit-operation"
              />
            )}
          </Field>
          {!isEdit && operations.state.status === 'error' ? (
            <Notice tone="warn" testId="policy-edit-operations-error">
              <span>
                {t(
                  '无法加载 Operation 列表，已切换为手动输入。',
                  'Could not load the Operation list — switched to manual entry.',
                )}
              </span>{' '}
              <Button variant="ghost" size="s" onClick={operations.reload}>
                {t('重试', 'Retry')}
              </Button>
            </Notice>
          ) : null}
          {!isEdit && operations.state.status === 'ready' && choices.length === 0 ? (
            <p className="field-hint" data-testid="policy-edit-operations-empty">
              {workspaceWide
                ? t(
                    '工作区还没有已发布的 Operation，请手动输入名称。',
                    'No Operation is published in this workspace yet — type the name manually.',
                  )
                : t(
                    `门「${gateName}」还没有已发布的 Operation，请手动输入名称。`,
                    `Gate “${gateName}” has no published Operation yet — type the name manually.`,
                  )}
            </p>
          ) : null}
          {unknownManualKind ? (
            <Notice tone="warn" testId="policy-edit-unknown-kind">
              <span>
                {workspaceWide
                  ? t(
                      `「${trimmedKind}」不是任何门上已发布的 Operation 名；在同名 Operation 发布之前，这条规则不会命中。`,
                      `“${trimmedKind}” is not a published Operation name on any gate; the rule matches nothing until one with that name is published.`,
                    )
                  : t(
                      `「${trimmedKind}」不是门「${gateName}」上已发布的 Operation 名；在同名 Operation 发布之前，这条规则不会命中。`,
                      `“${trimmedKind}” is not a published Operation name on gate “${gateName}”; the rule matches nothing until one with that name is published.`,
                    )}
              </span>
              {caseInsensitiveMatch ? (
                <>
                  {' '}
                  <Button
                    variant="ghost"
                    size="s"
                    onClick={() => pickOperation(caseInsensitiveMatch.name)}
                    data-testid="policy-edit-use-match"
                  >
                    {t(`改为 ${caseInsensitiveMatch.name}`, `Use ${caseInsensitiveMatch.name}`)}
                  </Button>
                </>
              ) : null}
            </Notice>
          ) : null}
          {!isEdit && !listUnavailable ? (
            <div>
              <Button
                variant="ghost"
                size="s"
                onClick={() => {
                  // Back to the list: a typed name that is not on it would sit hidden behind an
                  // empty select, so it is cleared.
                  if (manualKind && !choices.some((choice) => choice.name === trimmedKind)) {
                    setActionKindTag('');
                  }
                  setManualKind(!manualKind);
                }}
                disabled={submitting}
                data-testid="policy-edit-manual-toggle"
              >
                {manualKind
                  ? t('从列表选择', 'Choose from the list')
                  : t('手动输入', 'Type it manually')}
              </Button>
            </div>
          ) : null}

          <Field
            id="pe-blast-radius"
            label={t('影响', 'Blast radius')}
            hint={
              blastPrefilledFrom !== null && blastPrefilledFrom === trimmedKind
                ? t(
                    `已按 Operation「${blastPrefilledFrom}」声明的影响预填，可修改。影响越高，审批越严格；高影响不能与自动批准同时开启。`,
                    `Prefilled from the blast radius Operation “${blastPrefilledFrom}” declares — you can change it. Higher impact means stricter approval; high impact cannot be combined with auto-approve.`,
                  )
                : t(
                    '影响越高，审批越严格；高影响不能与自动批准同时开启。',
                    'Higher impact means stricter approval — high impact cannot be combined with auto-approve.',
                  )
            }
          >
            <Select
              id="pe-blast-radius"
              aria-label={t('影响', 'Blast radius')}
              value={blastRadius}
              onChange={(event) => {
                setBlastRadius(event.target.value as BlastRadius | typeof UNSET);
                setBlastPrefilledFrom(null);
              }}
              disabled={submitting}
              data-testid="policy-edit-blast-radius"
            >
              <option value={UNSET}>{t('（任意）', '(any)')}</option>
              {BLAST_RADIUS_VALUES.map((value) => (
                <option key={value} value={value}>
                  {blastRadiusLabel(value, t)}
                </option>
              ))}
            </Select>
          </Field>

          <label className="checkbox">
            <input
              type="checkbox"
              checked={effectiveAutoApprove}
              onChange={(event) => setAutoApprove(event.target.checked)}
              disabled={submitting || autoApproveBlockedByBlastRadius || workspaceWide}
              data-testid="policy-edit-auto-approve"
            />
            <span>{t('自动批准', 'Auto-approve')}</span>
          </label>
          <p className="field-hint">
            {workspaceWide
              ? t(
                  '自动批准只能按门开启：先在「适用范围」里选一个门。',
                  'Auto-approval is turned on per gate: pick a gate under “Applies to” first.',
                )
              : t(
                  `开启后，门「${gateName}」上这个动作的新请求，不论谁发起都会被自动批准，不再进入人工审批队列。`,
                  `When on, new requests for this action on gate “${gateName}” are approved automatically for every requester and never reach the human approval queue.`,
                )}
          </p>
          {autoApproveBlockedByBlastRadius ? (
            <Notice tone="warn">
              {t(
                '高影响的动作不能自动批准（内核会拒绝）。',
                'A high-impact action cannot be auto-approved — the kernel refuses this combination.',
              )}
            </Notice>
          ) : null}

          <Field
            id="pe-requester-can-approve"
            label={t('申请人可自批', 'Requester may approve')}
            hint={t(
              '是否允许发起这类请求的人批准自己的请求；不设置则按工作区默认规则。',
              'Whether the person who made the request may approve it themselves; unset falls back to the workspace default.',
            )}
          >
            <Select
              id="pe-requester-can-approve"
              aria-label={t('申请人可自批', 'Requester may approve')}
              value={requesterCanApprove}
              onChange={(event) =>
                setRequesterCanApprove(
                  event.target.value as 'true' | 'false' | typeof REQUESTER_INHERIT,
                )
              }
              disabled={submitting}
            >
              <option value={REQUESTER_INHERIT}>
                {t('（工作区默认）', '(workspace default)')}
              </option>
              <option value="true">{t('是', 'Yes')}</option>
              <option value="false">{t('否', 'No')}</option>
            </Select>
          </Field>
        </div>

        <SheetFooter>
          <Confirm
            tier={isLoosening ? 'irreversible' : 'medium'}
            open={confirmOpen}
            onOpenChange={setConfirmOpen}
            anchor={
              <Button
                variant="primary"
                onClick={() => setConfirmOpen(true)}
                disabled={!canSubmit}
                data-testid="policy-edit-submit"
              >
                {t('保存', 'Save')}
              </Button>
            }
            title={isLoosening ? t('放松策略', 'Loosen policy') : t('保存策略', 'Save policy')}
            description={
              isLoosening
                ? t(
                    '此改动会降低人工审批的强度，可能让原本需要审批的动作直接执行。',
                    'This change reduces human oversight — an action that used to need approval may now run without it.',
                  )
                : t(
                    '改动立即生效，并写入平台审计。',
                    'Takes effect immediately and is recorded in the platform audit.',
                  )
            }
            target={actionKindTag.trim() || undefined}
            impact={[
              `${t('适用范围', 'Applies to')}: ${gateName === null ? t('所有门上的同名动作', 'the same name on every gate') : t(`门「${gateName}」· 所有发起人`, `gate “${gateName}” · every requester`)}`,
              `${t('自动批准', 'Auto-approve')}: ${prevAutoApprove ? t('开', 'on') : t('关', 'off')} → ${effectiveAutoApprove ? t('开', 'on') : t('关', 'off')}`,
            ]}
            danger={isLoosening}
            confirmLabel={t('确认保存', 'Confirm save')}
            onConfirm={submit}
            testId="policy-edit-confirm"
          />
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
            {t('取消', 'Cancel')}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
