import { BLAST_RADIUS_VALUES, type BlastRadius, type PolicyWire } from '@nexttime/shared';
import { useState } from 'react';
import type { CapabilityCaller } from '../../lib/clients.js';
import { type Translate, useT } from '../../lib/i18n.js';
import { BLAST_RADIUS_TONES } from '../../lib/status-tone.js';
import { Button } from '../kit/button.js';
import { Confirm } from '../kit/confirm.js';
import { Field } from '../kit/field.js';
import { Notice } from '../kit/notice.js';
import { Select } from '../kit/select.js';
import { Sheet, SheetContent, SheetFooter, SheetHeader, SheetTitle } from '../kit/sheet.js';

const UNSET = '__unset__';
const REQUESTER_INHERIT = '__inherit__';

function blastRadiusLabel(value: BlastRadius, t: Translate): string {
  const label = BLAST_RADIUS_TONES[value].label;
  return typeof label === 'string' ? label : t(label.zh, label.en);
}

export interface PolicyEditSheetProps {
  readonly http: CapabilityCaller;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** `undefined` — create a new Policy row, `actionKindTag` is a free-text field. Given — edit
   *  this existing row, `actionKindTag` is read-only (`set_policy` upserts by actionKindTag, so
   *  changing it would silently create a second, unrelated row instead of editing this one). */
  readonly editing?: PolicyWire;
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
 */
export function PolicyEditSheet({
  http,
  open,
  onOpenChange,
  editing,
  onSaved,
}: PolicyEditSheetProps) {
  const t = useT();
  const isEdit = editing !== undefined;

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

  // I8 (`governance/policy/engine.ts` `assertPolicyWriteAllowed`): the kernel refuses
  // `autoApprove:true` at `blastRadius:'high'` — mirrored client-side so the confirm never opens
  // on a request the kernel will 400 anyway.
  const autoApproveBlockedByBlastRadius = blastRadius === 'high';
  const effectiveAutoApprove = autoApproveBlockedByBlastRadius ? false : autoApprove;

  const prevAutoApprove = editing?.autoApprove ?? false;
  const prevRequesterCanApprove = editing?.requesterCanApprove ?? null;
  const nextRequesterCanApprove =
    requesterCanApprove === REQUESTER_INHERIT ? null : requesterCanApprove === 'true';
  const isLoosening =
    (effectiveAutoApprove && !prevAutoApprove) ||
    (nextRequesterCanApprove === true && prevRequesterCanApprove !== true);

  const canSubmit = actionKindTag.trim().length > 0 && !submitting;

  function resetAndClose(): void {
    setConfirmOpen(false);
    onOpenChange(false);
  }

  async function submit(): Promise<void> {
    const policy: Record<string, unknown> = {
      actionKindTag: actionKindTag.trim(),
      autoApprove: effectiveAutoApprove,
    };
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
            id="pe-action-kind"
            label={t('动作种类', 'Action kind')}
            required
            hint={
              isEdit
                ? t('已有策略的键，不可修改。', 'The existing policy’s key — cannot be changed.')
                : t(
                    '与审批队列 / 审计里看到的原始 tag 一致，例如某个门的 Operation 名。',
                    'Matches the raw tag shown in the approval queue / audit — e.g. a gate Operation’s name.',
                  )
            }
          >
            <input
              id="pe-action-kind"
              className="input mono"
              value={actionKindTag}
              onChange={(event) => setActionKindTag(event.target.value)}
              disabled={isEdit || submitting}
            />
          </Field>

          <Field
            id="pe-blast-radius"
            label={t('影响', 'Blast radius')}
            hint={t(
              '影响越高，审批越严格；高影响不能与自动批准同时开启。',
              'Higher impact means stricter approval — high impact cannot be combined with auto-approve.',
            )}
          >
            <Select
              id="pe-blast-radius"
              aria-label={t('影响', 'Blast radius')}
              value={blastRadius}
              onChange={(event) => setBlastRadius(event.target.value as BlastRadius | typeof UNSET)}
              disabled={submitting}
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
              disabled={submitting || autoApproveBlockedByBlastRadius}
            />
            <span>{t('自动批准', 'Auto-approve')}</span>
          </label>
          <p className="field-hint">
            {t(
              '开启后，匹配这个动作种类的新请求会被自动批准，不再进入人工审批队列。',
              'When on, new requests matching this action kind are approved automatically and never reach the human approval queue.',
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
