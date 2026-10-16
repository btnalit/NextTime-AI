import type { OperationSummaryWire, PublishManifestResultWire } from '@nexttime/shared';
import { useState } from 'react';
import type { CapabilityCaller } from '../lib/clients.js';
import {
  CONNECTION_KIND_VALUES,
  type ConnectionKind,
  type CreateConnectionResult,
  type DraftAsRead,
  type ManifestPublishPlan,
  draftsAsRead,
  manifestPublishPlan,
} from '../lib/connections.js';
import { isDraftChangedError } from '../lib/errors.js';
import { actionKindTagText } from '../lib/format.js';
import { type Translate, useT } from '../lib/i18n.js';
import { transportKindLabel } from '../lib/labels.js';
import { CompleteConnectionForm } from './CompleteConnectionForm.js';
import { OnboardingWizardReview } from './OnboardingWizardReview.js';
import { ManifestPublishResultNotice } from './connect/GateOwnedParams.js';
import { Button } from './ui/Button.js';
import { ErrorBanner } from './ui/ErrorBanner.js';
import { Notice } from './ui/Notice.js';

export interface OnboardingWizardProps {
  readonly http: CapabilityCaller;
  readonly onCancel: () => void;
  /** Closes the wizard and opens the new gate's health/operations detail drawer
   *  (`GatekeeperDetailDrawer`, already on `/govern/systems/<id>`). */
  readonly onFinished: (gatekeeperId: string) => void;
}

type WizardStep = 'kind' | 'connect' | 'publish' | 'review' | 'done';

const STEP_LABELS: readonly {
  readonly step: WizardStep;
  readonly zh: string;
  readonly en: string;
}[] = [
  { step: 'kind', zh: '① 类型', en: '1 · Kind' },
  { step: 'connect', zh: '② 地址与凭证', en: '2 · Target & credential' },
  { step: 'publish', zh: '③ 导入清单', en: '3 · Import manifest' },
  { step: 'review', zh: '④ 审核', en: '4 · Review operations' },
  { step: 'done', zh: '⑤ 完成', en: '5 · Done' },
];

function kindCopy(kind: ConnectionKind, t: Translate): string {
  switch (kind) {
    case 'http':
      return t(
        '一个 HTTP/OpenAPI 服务：从 OpenAPI 文档或门自身的 describe_operations 导入 Operation。',
        'An HTTP/OpenAPI service: Operations are imported from its OpenAPI document or from the gate’s own describe_operations.',
      );
    case 'mcp':
      return t(
        '一个 MCP 服务器：导入时调用它的 tools/list，按 readOnlyHint 判定是只读（observe）还是会执行（execute）。',
        'An MCP server: the import calls its tools/list, and readOnlyHint decides whether each tool is read-only (observe) or executes.',
      );
    case 'cli':
      return t(
        '一个命令行目标（例如已部署的 docker 门）：从门自身的 describe_operations 导入。',
        'A command-line target (for example a deployed docker gate): Operations are imported from the gate’s own describe_operations.',
      );
    case 'ssh':
      return t(
        '一台通过 SSH 访问的主机：从门自身的 describe_operations 导入。',
        'A host reached over SSH: Operations are imported from the gate’s own describe_operations.',
      );
  }
}

/**
 * components/OnboardingWizard: 接入向导 (S3.12 deliverable) — a guided, five-step alternative to
 * ConnectionsPage's existing one-shot "Connect a system" drawer (`CompleteConnectionForm`, kept
 * unchanged and still available for the quick path). Reuses that same form for step ② rather than
 * duplicating its target/credential/manifestSource fields (task brief: "reuse, do not
 * duplicate") — only step ① (kind), ③ (publish_manifest), ④ (operations review + reclassification,
 * `OnboardingWizardReview.tsx`) and ⑤ (done) are new. Each step degrades gracefully on its own
 * (`CompleteConnectionForm`/`OnboardingWizardReview`'s own error handling) rather than blocking
 * the whole wizard on one capability.
 */
export function OnboardingWizard({ http, onCancel, onFinished }: OnboardingWizardProps) {
  const t = useT();
  const [step, setStep] = useState<WizardStep>('kind');
  const [kind, setKind] = useState<ConnectionKind>('http');
  const [connection, setConnection] = useState<CreateConnectionResult | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState<unknown | null>(null);
  const [published, setPublished] = useState<PublishManifestResultWire | null>(null);
  // Review #493 on #592: the drafts step ③ lists, as read — exactly what 「发布清单」 publishes.
  const [drafts, setDrafts] = useState<readonly DraftAsRead[] | null>(null);
  const [plan, setPlan] = useState<ManifestPublishPlan | null>(null);
  const [draftsError, setDraftsError] = useState<unknown | null>(null);

  async function loadDrafts(gatekeeperId: string): Promise<void> {
    setDrafts(null);
    setPlan(null);
    setDraftsError(null);
    try {
      const result = await http.call<{ readonly items: readonly OperationSummaryWire[] }>(
        'list_operations',
        { gatekeeperId },
      );
      setDrafts(draftsAsRead(result.items, gatekeeperId));
      setPlan(manifestPublishPlan(result.items, gatekeeperId));
    } catch (err) {
      setDraftsError(err);
    }
  }

  async function publish(): Promise<void> {
    if (!connection || drafts === null) return;
    setPublishing(true);
    setPublishError(null);
    try {
      setPublished(
        await http.call<PublishManifestResultWire>('publish_manifest', {
          gatekeeperId: connection.gatekeeperId,
          drafts,
        }),
      );
      setStep('review');
    } catch (err) {
      setPublishError(err);
      // A draft changed after the list below was read: nothing was published; show what is there now.
      if (isDraftChangedError(err)) void loadDrafts(connection.gatekeeperId);
    } finally {
      setPublishing(false);
    }
  }

  return (
    <div className="stack" data-testid="onboarding-wizard">
      <ol className="wizard-steps" aria-label={t('接入向导步骤', 'Onboarding steps')}>
        {STEP_LABELS.map((entry) => (
          <li
            key={entry.step}
            className={`wizard-step${entry.step === step ? ' wizard-step-active' : ''}`}
            aria-current={entry.step === step ? 'step' : undefined}
          >
            {t(entry.zh, entry.en)}
          </li>
        ))}
      </ol>

      {step === 'kind' ? (
        <div className="stack" data-testid="wizard-step-kind">
          <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="field-label">
              {t('选择要接入的系统类型', "Choose the system's kind")}
            </legend>
            <div className="radio-group" role="radiogroup" aria-label={t('类型', 'Kind')}>
              {CONNECTION_KIND_VALUES.map((option) => (
                <label className="radio-option" key={option}>
                  <input
                    type="radio"
                    name="wizard-kind"
                    value={option}
                    checked={kind === option}
                    onChange={() => setKind(option)}
                  />
                  {transportKindLabel(option, t)}
                </label>
              ))}
            </div>
          </fieldset>
          <Notice testId="wizard-kind-copy">{kindCopy(kind, t)}</Notice>
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <Button variant="ghost" onClick={onCancel}>
              {t('取消', 'Cancel')}
            </Button>
            <Button variant="primary" onClick={() => setStep('connect')}>
              {t('下一步', 'Next')}
            </Button>
          </div>
        </div>
      ) : null}

      {step === 'connect' ? (
        <div data-testid="wizard-step-connect">
          <CompleteConnectionForm
            http={http}
            initialKind={kind}
            hideKindField
            onCancel={() => setStep('kind')}
            onDone={(result) => {
              setConnection(result);
              setStep('publish');
              void loadDrafts(result.gatekeeperId);
            }}
          />
        </div>
      ) : null}

      {step === 'publish' && connection ? (
        <div className="stack" data-testid="wizard-step-publish">
          <Notice>
            {t(
              <>
                已注册门 <code>{connection.gatekeeperId.slice(0, 8)}</code>，导入了{' '}
                {connection.importedOperationNames.length} 个 Operation 草稿
                {kind === 'mcp'
                  ? '（来自 tools/list，readOnlyHint 为 true 的算 observe，其余算 execute）'
                  : null}
                。发布清单后，智能体才能找到它们。
              </>,
              <>
                Registered gate <code>{connection.gatekeeperId.slice(0, 8)}</code>; imported{' '}
                {connection.importedOperationNames.length} Operation drafts
                {kind === 'mcp'
                  ? ' (from tools/list: readOnlyHint true counts as observe, the rest as execute)'
                  : null}
                . Agents can only find them once the manifest is published.
              </>,
            )}
          </Notice>
          {drafts !== null && plan !== null ? (
            <div className="stack" data-testid="wizard-publish-drafts">
              <span className="field-label" data-testid="wizard-publish-count">
                {t(
                  `「发布清单」会发布这 ${plan.publishable.length} 个草稿：`,
                  `Publish manifest publishes these ${plan.publishable.length} drafts:`,
                )}
              </span>
              <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
                {plan.publishable.map((name) => (
                  <li key={name}>
                    <code>{actionKindTagText(name)}</code>
                  </li>
                ))}
              </ul>
              {plan.proposals.length > 0 ? (
                <p className="field-hint" data-testid="wizard-publish-proposals">
                  {t(
                    `另有 ${plan.proposals.length} 个提议草稿会被跳过：${plan.proposals.map(actionKindTagText).join('、')}。它们不是门自己声明的，而是智能体或成员提议的，要在能力目录里逐个审阅后发布，不会被整份清单一起发布。`,
                    `${plan.proposals.length} proposed draft(s) will be skipped: ${plan.proposals.map(actionKindTagText).join(', ')}. The gate did not declare them; an agent or a member proposed them, so each is reviewed and published on its own in the catalog, never with the whole manifest.`,
                  )}
                </p>
              ) : null}
              {plan.gateOwned.length > 0 ? (
                <p className="field-hint" data-testid="wizard-publish-gate-owned">
                  {t(
                    `另有 ${plan.gateOwned.length} 个草稿暂不发布：${plan.gateOwned.map(actionKindTagText).join('、')}。它们声明了只能由门设置的参数，发布后的结果页会说明怎么处理。`,
                    `${plan.gateOwned.length} draft(s) are held back: ${plan.gateOwned.map(actionKindTagText).join(', ')}. They declare params only the gate sets; the result page after publishing says what to do.`,
                  )}
                </p>
              ) : null}
            </div>
          ) : null}
          {draftsError !== null ? (
            <ErrorBanner
              error={draftsError}
              title={t('无法读取导入的草稿', 'Could not read the imported drafts')}
              onRetry={() => void loadDrafts(connection.gatekeeperId)}
            />
          ) : null}
          {publishError !== null ? (
            <ErrorBanner
              error={publishError}
              title={t('无法发布清单', 'Could not publish the manifest')}
            />
          ) : null}
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <Button variant="ghost" onClick={() => setStep('review')}>
              {t('暂不发布，稍后再说', 'Skip for now')}
            </Button>
            {/* ux-lint-allow-disabled: the draft list above is still loading, or its read failed (the banner says so). */}
            <Button
              variant="primary"
              loading={publishing}
              disabled={drafts === null}
              onClick={() => void publish()}
            >
              {t('发布清单', 'Publish manifest')}
            </Button>
          </div>
        </div>
      ) : null}

      {step === 'review' && connection ? (
        <div data-testid="wizard-step-review">
          {/* Console G4: what was published, and what was not — the gate's drafts held back for a
           *  gate-owned param, and proposals that wait for a one-by-one publish. This wizard
           *  connects a system for the workspace itself, so such a gate is connected again once
           *  its manifest is fixed. */}
          {published !== null ? (
            <ManifestPublishResultNotice
              result={published}
              fix="reconnect"
              testId="wizard-publish-result"
            />
          ) : null}
          <OnboardingWizardReview
            http={http}
            gatekeeperId={connection.gatekeeperId}
            onDone={() => setStep('done')}
          />
        </div>
      ) : null}

      {step === 'done' && connection ? (
        <div className="stack" data-testid="wizard-step-done">
          <Notice tone="info">
            {t('系统接入完成，门 ID：', 'System connected — gate ID:')}{' '}
            <code className="mono">{connection.gatekeeperId}</code>
          </Notice>
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <Button variant="ghost" onClick={onCancel}>
              {t('关闭', 'Close')}
            </Button>
            <Button variant="primary" onClick={() => onFinished(connection.gatekeeperId)}>
              {t('查看门详情', 'View gate detail')}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
