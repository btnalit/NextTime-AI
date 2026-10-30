import { BLAST_RADIUS_VALUES, type BlastRadius, type PolicyWire } from '@nexttime/shared';
import { useState } from 'react';
import type { CapabilityCaller } from '../../lib/clients.js';
import { isVersionChangedError } from '../../lib/errors.js';
import { actionKindTagText } from '../../lib/format.js';
import { type OperationChoice, useGateOperations } from '../../lib/gate-operations.js';
import { type GatekeeperListRow, operationKey } from '../../lib/governance.js';
import { type Translate, useT } from '../../lib/i18n.js';
import { hrefs } from '../../lib/router.js';
import { sameNameIds, withSameNameId } from '../../lib/same-name.js';
import { BLAST_RADIUS_TONES } from '../../lib/status-tone.js';
import { Button } from '../kit/button.js';
import { Combobox } from '../kit/combobox.js';
import { Confirm } from '../kit/confirm.js';
import { GuardedCancelButton } from '../kit/discard-guard.js';
import { Field, describedBy } from '../kit/field.js';
import { Notice } from '../kit/notice.js';
import { Select } from '../kit/select.js';
import { Sheet, SheetContent, SheetFooter, SheetHeader, SheetTitle } from '../kit/sheet.js';
import { StillNeeded } from '../kit/still-needed.js';

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
 *
 * Legacy 218: auto-approval on a gate allows one published definition — the version shown here
 * (`operationVersion`: the chosen Operation's, or for an edited row the one published now). An
 * "always allow" given for an earlier definition is suspended (`autoApproveConsent`); saving it
 * with auto-approval on reconfirms it for the version in force, which is a loosening. The kernel
 * refuses a rule naming no published Operation, so an unknown name cannot be saved.
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
  const gateSame = sameNameIds(
    gatekeepers,
    (gate) => gate.id,
    (gate) => gate.name,
  );
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
  /** Review #501 on #592 (P2-1): saving was refused because another version was published after
   *  this sheet read it — the version it was confirming. The read is reloaded in place. */
  const [versionMovedFrom, setVersionMovedFrom] = useState<number | null>(null);

  // console-ux-2: the action kind is the Operation's own name (`request-action-handler.ts` passes
  // `operationName` as the request's `action_kind`), so a new rule offers the chosen gate's
  // published Operations — every gate's for a workspace-wide rule — instead of free text, where
  // a typo saved a rule that silently never matched. Manual entry stays as a fallback.
  // Review #501 on #592 (P2-1): an edited gate rule reads its gate's Operations too — the version
  // it confirms is the one published now, not the one the policy list read when the page opened.
  const operations = useGateOperations(
    http,
    isEdit
      ? editing.gatekeeperId !== null
        ? { gatekeeperId: editing.gatekeeperId }
        : null
      : gateScope === ALL_GATES
        ? 'all'
        : { gatekeeperId: gateScope },
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
  /** Nothing published to name: the kernel refuses every new rule here. */
  const nothingPublished = !isEdit && operations.state.status === 'ready' && choices.length === 0;

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
  // Legacy 218: the published version an auto-approval would allow — `null` when there is none
  // to name (no longer published, or the list could not be read), which blocks turning it on. An
  // edited row uses its gate's read once it is in, and the policy list's until then.
  const liveChoice =
    operations.state.status === 'ready'
      ? choices.find((choice) => choice.name === trimmedKind)
      : undefined;
  const allowedVersion: number | null =
    isEdit && operations.state.status !== 'ready'
      ? (editing.publishedOperationVersion ?? null)
      : (liveChoice?.version ?? null);
  const autoApproveBlockedByVersion =
    !workspaceWide && allowedVersion === null && trimmedKind !== '';
  // I8 on the Operation itself (review #501 P3-2): a version published at high impact can never be
  // auto-approved, whatever this rule's own blast radius says.
  const operationIsHigh = !workspaceWide && liveChoice?.blastRadius === 'high';
  const effectiveAutoApprove =
    autoApproveBlockedByBlastRadius ||
    workspaceWide ||
    autoApproveBlockedByVersion ||
    operationIsHigh
      ? false
      : autoApprove;
  /** An "always allow" given for another definition (or none on record): suspended until saved. */
  const suspended = isEdit && editing.autoApprove && editing.autoApproveConsent !== 'current';
  /** Review #501 on #592 (P2-2): the gate no longer publishes this Operation, so nothing can be
   *  reconfirmed; saving turns the rule off (the kernel accepts only a tightening here). */
  const orphaned = isEdit && !workspaceWide && allowedVersion === null;

  const prevAutoApprove = editing?.autoApprove ?? false;
  const prevRequesterCanApprove = editing?.requesterCanApprove ?? null;
  const nextRequesterCanApprove =
    requesterCanApprove === REQUESTER_INHERIT ? null : requesterCanApprove === 'true';
  // #493 review of #592: back to the workspace default from 「否」 loosens too — the default lets
  // the requester approve anything below high.
  const isLoosening =
    (effectiveAutoApprove && (!prevAutoApprove || suspended)) ||
    (nextRequesterCanApprove === true && prevRequesterCanApprove !== true) ||
    (nextRequesterCanApprove === null && prevRequesterCanApprove === false);
  /** A rule the gate no longer backs may only be tightened, so 「否」 stays 「否」 there. */
  const requesterLocked = orphaned && prevRequesterCanApprove === false;

  const canSubmit =
    trimmedKind.length > 0 && !unknownManualKind && !nothingPublished && !submitting;

  const close = (): void => onOpenChange(false);

  function resetAndClose(): void {
    setConfirmOpen(false);
    onOpenChange(false);
  }

  async function submit(): Promise<void> {
    const confirming = allowedVersion;
    const policy: Record<string, unknown> = {
      actionKindTag: actionKindTag.trim(),
      autoApprove: effectiveAutoApprove,
    };
    if (!workspaceWide) policy.gatekeeperId = gateScope;
    if (effectiveAutoApprove && allowedVersion !== null) policy.operationVersion = allowedVersion;
    if (blastRadius !== UNSET) policy.blastRadius = blastRadius;
    // Omitted, the kernel keeps the rule's value; `null` clears it to the workspace default — so an
    // edit sends `null` only when the reader chose that, and a new rule sends only a real choice.
    if (nextRequesterCanApprove !== null || prevRequesterCanApprove !== null) {
      policy.requesterCanApprove = nextRequesterCanApprove;
    }

    setSubmitting(true);
    try {
      const saved = await http.call<PolicyWire>('set_policy', { policy });
      onSaved(saved);
      resetAndClose();
    } catch (err) {
      if (!isVersionChangedError(err)) throw err;
      // Nothing was written: read the gate's Operations again and say which version is now the
      // one being confirmed, instead of resending the stale one.
      setVersionMovedFrom(confirming);
      setConfirmOpen(false);
      operations.reload();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Sheet open={open} onOpenChange={(next) => !submitting && onOpenChange(next)}>
      <SheetContent data-testid="policy-edit-sheet" data-discard-guard>
        <SheetHeader>
          <SheetTitle>
            {isEdit ? t('编辑策略', 'Edit policy') : t('新增策略', 'New policy')}
          </SheetTitle>
        </SheetHeader>

        <div className="stack">
          {suspended ? (
            <Notice tone="warn" testId="policy-edit-suspended">
              {/* UX acceptance of #592 (P2): the version named here is the one just read, so a
                  re-read after a newer publish updates this sentence with the notice below. */}
              <span>
                {orphaned
                  ? orphanedText(editing, t)
                  : suspendedText({ ...editing, publishedOperationVersion: allowedVersion }, t)}
              </span>
              {/* UX acceptance of #592 (P2-2): the version to reconfirm is one click away. */}
              {!orphaned && allowedVersion !== null && editing.gatekeeperId !== null ? (
                <>
                  {' '}
                  <a
                    className="link-inline"
                    href={hrefs.catalog(
                      'operations',
                      operationKey({ gatekeeperId: editing.gatekeeperId, name: trimmedKind }),
                    )}
                    target="_blank"
                    rel="noreferrer"
                    data-testid="policy-edit-view-operation"
                  >
                    {t(
                      `在能力目录查看这个版本（v${allowedVersion}）`,
                      `View v${allowedVersion} in the catalog`,
                    )}
                  </a>
                </>
              ) : null}
            </Notice>
          ) : null}
          {versionMovedFrom !== null ? (
            <Notice tone="warn" testId="policy-edit-version-moved">
              {allowedVersion !== null && allowedVersion !== versionMovedFrom
                ? t(
                    `没有保存：你打开之后，门上发布了新版本。现在确认的是 v${allowedVersion}（刚读到的），不再是 v${versionMovedFrom ?? '?'}。先看过 v${allowedVersion}，再保存。`,
                    `Not saved: a new version was published after you opened this. You are now confirming v${allowedVersion} (just read), no longer v${versionMovedFrom ?? '?'}. Look at v${allowedVersion} before saving.`,
                  )
                : t(
                    '没有保存：你打开之后，门上发布的版本变了，正在重新读取。',
                    'Not saved: the published version changed after you opened this — reading it again.',
                  )}
            </Notice>
          ) : null}
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
                  {withSameNameId(gate.name, gate.id, gateSame)}
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
                aria-describedby={describedBy('pe-action-kind', true, false)}
                data-testid="policy-edit-action-kind-input"
              />
            ) : (
              // console-ux-3: a gate imported from OpenAPI publishes dozens to hundreds of
              // Operations — a searchable combobox instead of a native select.
              <Combobox
                id="pe-action-kind"
                options={choices.map((choice) => ({
                  value: choice.name,
                  label: actionKindTagText(choice.name),
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
                    '工作区还没有已发布的 Operation，策略要对应一个已发布的动作，所以现在还不能新增。先在「系统」里接入门并发布 Operation。',
                    'No Operation is published in this workspace yet, and a policy must name a published action, so none can be added yet. Connect a gate and publish its Operations under Systems first.',
                  )
                : t(
                    `门「${gateName}」还没有已发布的 Operation，不能为它新增策略。请换一个门，或先发布它的 Operation。`,
                    `Gate “${gateName}” has no published Operation yet, so no policy can be added for it. Pick another gate, or publish its Operations first.`,
                  )}
            </p>
          ) : null}
          {unknownManualKind ? (
            <Notice tone="warn" testId="policy-edit-unknown-kind">
              <span>
                {workspaceWide
                  ? t(
                      `「${actionKindTagText(trimmedKind)}」不是任何门上已发布的 Operation 名，不能保存。请从列表里选，或先发布同名 Operation。`,
                      `“${actionKindTagText(trimmedKind)}” is not a published Operation name on any gate, so it cannot be saved. Pick one from the list, or publish an Operation with that name first.`,
                    )
                  : t(
                      `「${actionKindTagText(trimmedKind)}」不是门「${gateName}」上已发布的 Operation 名，不能保存。请从列表里选，或先在这个门上发布它。`,
                      `“${actionKindTagText(trimmedKind)}” is not a published Operation name on gate “${gateName}”, so it cannot be saved. Pick one from the list, or publish it on this gate first.`,
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
              disabled={
                submitting ||
                autoApproveBlockedByBlastRadius ||
                workspaceWide ||
                autoApproveBlockedByVersion ||
                operationIsHigh
              }
              data-testid="policy-edit-auto-approve"
            />
            <span>
              {allowedVersion !== null && !workspaceWide
                ? t(`自动批准（v${allowedVersion}）`, `Auto-approve (v${allowedVersion})`)
                : t('自动批准', 'Auto-approve')}
            </span>
          </label>
          <p className="field-hint" data-testid="policy-edit-auto-approve-hint">
            {workspaceWide
              ? t(
                  '自动批准只能按门开启：先在「适用范围」里选一个门。',
                  'Auto-approval is turned on per gate: pick a gate under “Applies to” first.',
                )
              : operationIsHigh
                ? t(
                    `门「${gateName}」上现在发布的 v${allowedVersion ?? '?'} 是高影响，不能自动批准。`,
                    `The v${allowedVersion ?? '?'} gate “${gateName}” publishes now is high impact, so it cannot be auto-approved.`,
                  )
                : autoApproveBlockedByVersion
                  ? isEdit
                    ? t(
                        `门「${gateName}」上已经没有发布的「${actionKindTagText(trimmedKind)}」，不能开启自动批准。`,
                        `Gate “${gateName}” no longer publishes “${actionKindTagText(trimmedKind)}”, so auto-approval cannot be turned on.`,
                      )
                    : t(
                        '读不到这个 Operation 已发布的版本，暂时不能开启自动批准。请重试加载列表后从列表里选。',
                        'The published version of this Operation could not be read, so auto-approval cannot be turned on yet. Retry loading the list and pick it from there.',
                      )
                  : t(
                      `开启后，门「${gateName}」上这个动作的新请求，不论谁发起都会被自动批准，不再进入人工审批队列。只对现在发布的 v${allowedVersion ?? '?'} 生效：以后发布新版本，请求会重新走审批，直到有人再次确认。`,
                      `When on, new requests for this action on gate “${gateName}” are approved automatically for every requester and never reach the human approval queue. It covers the v${allowedVersion ?? '?'} published now: once a new version is published, requests go back through approval until someone confirms again.`,
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
            hint={
              requesterLocked
                ? t(
                    '门上已不再发布这个 Operation，这条规则只能收紧：现在是「否」，改回「工作区默认」会让发起人可以批准自己的请求（非高影响的动作默认如此），所以不能选。',
                    'The gate no longer publishes this Operation, so this rule can only be tightened: it is “No” now, and going back to the workspace default would let requesters approve their own requests (the default below high impact), so it is not offered.',
                  )
                : t(
                    '是否允许发起这类请求的人批准自己的请求；不设置则按工作区默认规则。',
                    'Whether the person who made the request may approve it themselves; unset falls back to the workspace default.',
                  )
            }
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
              <option value={REQUESTER_INHERIT} disabled={requesterLocked}>
                {t('（工作区默认）', '(workspace default)')}
              </option>
              {/* A rule the gate no longer backs can only be tightened (review #501 P2-2). */}
              <option value="true" disabled={orphaned && prevRequesterCanApprove !== true}>
                {t('是', 'Yes')}
              </option>
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
                {orphaned && suspended ? t('停用', 'Turn off') : t('保存', 'Save')}
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
              `${t('自动批准', 'Auto-approve')}: ${prevAutoApprove ? (suspended ? t('已暂停', 'suspended') : t('开', 'on')) : t('关', 'off')} → ${effectiveAutoApprove ? t('开', 'on') : t('关', 'off')}`,
              ...(effectiveAutoApprove && allowedVersion !== null
                ? [`${t('允许的版本', 'Allows version')}: v${allowedVersion}`]
                : []),
            ]}
            danger={isLoosening}
            confirmLabel={t('确认保存', 'Confirm save')}
            onConfirm={submit}
            testId="policy-edit-confirm"
          />
          <GuardedCancelButton variant="ghost" onCancel={close} disabled={submitting}>
            {t('取消', 'Cancel')}
          </GuardedCancelButton>
          {/* Audit P1-9: a disabled 保存 says what it still waits for. */}
          <StillNeeded
            items={
              nothingPublished
                ? [t('先发布一个 Operation', 'publish an Operation first')]
                : trimmedKind.length === 0
                  ? [t('选择动作', 'pick an action')]
                  : unknownManualKind
                    ? [t('选一个已发布的动作', 'pick a published action')]
                    : []
            }
            hidden={submitting}
            testId="policy-edit-missing"
          />
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

/** Review #501 on #592 (P2-2): a suspended rule whose Operation the gate no longer publishes —
 *  nothing to reconfirm; saving turns it off. */
export function orphanedText(policy: Pick<PolicyWire, 'operationVersion'>, t: Translate): string {
  const given =
    policy.operationVersion === null
      ? t('这条「始终允许」没有记录允许的版本，', 'This “Always allow” records no version, ')
      : t(
          `这条「始终允许」给的是 v${policy.operationVersion}，`,
          `This “Always allow” was given for v${policy.operationVersion}, `,
        );
  return (
    given +
    t(
      '门上已不再发布这个 Operation（工作区弃用了它，或门删掉了它），所以已暂停，也无法重新确认。停用它：自动批准关闭，规则保留为要求审批。',
      'and the gate no longer publishes this Operation (the workspace deprecated it, or the gate removed it), so it is suspended and cannot be reconfirmed. Turning it off sets auto-approval off and keeps the rule, requiring approval.',
    )
  );
}

/** Legacy 218: why an "always allow" rule is suspended — shown in the editor and the policy list. */
export function suspendedText(
  policy: Pick<PolicyWire, 'autoApproveConsent' | 'operationVersion' | 'publishedOperationVersion'>,
  t: Translate,
): string {
  if (policy.publishedOperationVersion === null) return orphanedText(policy, t);
  if (policy.autoApproveConsent === 'not_recorded') {
    return t(
      '这条「始终允许」是升级前写下的，没有记录当时允许的是哪个版本，所以已暂停：这个动作的请求照常走审批。勾选自动批准并保存，即对现在发布的版本重新确认。',
      'This “Always allow” was written before the platform recorded which version it allows, so it is suspended: requests for this action go through approval as usual. Save it with auto-approve on to reconfirm it for the version published now.',
    );
  }
  if (policy.operationVersion === policy.publishedOperationVersion) {
    return t(
      `这条「始终允许」给的是 v${policy.operationVersion}，之后这个版本的影响被调高了，所以已暂停：请求重新走审批。新的影响不是高影响时，勾选自动批准并保存，即按新的影响重新确认；高影响不能自动批准。`,
      `This “Always allow” was given for v${policy.operationVersion}, whose blast radius has since been raised, so it is suspended: requests go back through approval. Unless the new blast radius is high, save it with auto-approve on to reconfirm it at that blast radius; a high-impact action cannot be auto-approved.`,
    );
  }
  return t(
    `这条「始终允许」给的是 v${policy.operationVersion ?? '?'}，门上现在发布的是 v${policy.publishedOperationVersion}，所以已暂停：请求重新走审批。勾选自动批准并保存，即对 v${policy.publishedOperationVersion} 重新确认。`,
    `This “Always allow” was given for v${policy.operationVersion ?? '?'}, and the gate now publishes v${policy.publishedOperationVersion}, so it is suspended: requests go back through approval. Save it with auto-approve on to reconfirm it for v${policy.publishedOperationVersion}.`,
  );
}
