import { useState } from 'react';
import type { CapabilityCaller } from '../lib/clients.js';
import {
  CONNECTION_KIND_VALUES,
  type ConnectionKind,
  type CreateConnectionResult,
} from '../lib/connections.js';
import { CompleteConnectionForm } from './CompleteConnectionForm.js';
import { OnboardingWizardReview } from './OnboardingWizardReview.js';
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

const STEP_LABELS: readonly { readonly step: WizardStep; readonly label: string }[] = [
  { step: 'kind', label: '① 类型 Kind' },
  { step: 'connect', label: '② 地址与凭证 Target & credential' },
  { step: 'publish', label: '③ 导入清单 Import manifest' },
  { step: 'review', label: '④ 审核 Operations Review' },
  { step: 'done', label: '⑤ 完成 Done' },
];

const KIND_COPY: Readonly<Record<ConnectionKind, string>> = {
  http: '一个 HTTP/OpenAPI 服务 — 从 OpenAPI 文档或门自身的 describe_operations 导入 Operation。',
  mcp: '一个 MCP server — 本质上是 kind:"mcp" 的门；导入时调用其 tools/list，readOnlyHint 决定 observe/execute。',
  cli: '一个 CLI 目标（如已部署的 docker 门）— 从门自身的 describe_operations 导入。',
  ssh: '一个通过 SSH 访问的主机 — 从门自身的 describe_operations 导入。',
};

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
  const [step, setStep] = useState<WizardStep>('kind');
  const [kind, setKind] = useState<ConnectionKind>('http');
  const [connection, setConnection] = useState<CreateConnectionResult | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState<unknown | null>(null);
  const [publishedCount, setPublishedCount] = useState<number | null>(null);

  async function publish(): Promise<void> {
    if (!connection) return;
    setPublishing(true);
    setPublishError(null);
    try {
      const result = await http.call<{ publishedOperationNames?: readonly string[] }>(
        'publish_manifest',
        { gatekeeperId: connection.gatekeeperId },
      );
      setPublishedCount(result.publishedOperationNames?.length ?? 0);
      setStep('review');
    } catch (err) {
      setPublishError(err);
    } finally {
      setPublishing(false);
    }
  }

  return (
    <div className="stack" data-testid="onboarding-wizard">
      <ol className="wizard-steps" aria-label="接入向导步骤 Onboarding steps">
        {STEP_LABELS.map((entry) => (
          <li
            key={entry.step}
            className={`wizard-step${entry.step === step ? ' wizard-step-active' : ''}`}
            aria-current={entry.step === step ? 'step' : undefined}
          >
            {entry.label}
          </li>
        ))}
      </ol>

      {step === 'kind' ? (
        <div className="stack" data-testid="wizard-step-kind">
          <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="field-label">选择要接入的系统类型 Choose the system's kind</legend>
            <div className="radio-group" role="radiogroup" aria-label="Kind">
              {CONNECTION_KIND_VALUES.map((option) => (
                <label className="radio-option" key={option}>
                  <input
                    type="radio"
                    name="wizard-kind"
                    value={option}
                    checked={kind === option}
                    onChange={() => setKind(option)}
                  />
                  {option}
                </label>
              ))}
            </div>
          </fieldset>
          <Notice testId="wizard-kind-copy">{KIND_COPY[kind]}</Notice>
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <Button variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => setStep('connect')}>
              下一步 Next
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
            }}
          />
        </div>
      ) : null}

      {step === 'publish' && connection ? (
        <div className="stack" data-testid="wizard-step-publish">
          <Notice>
            已注册门 <code>{connection.gatekeeperId.slice(0, 8)}</code>，导入了{' '}
            {connection.importedOperationNames.length} 个 Operation 草稿
            {kind === 'mcp' ? '（来自 tools/list，readOnlyHint 为 observe，其余 execute）' : null}
            。发布清单后它们才会对 <code>find_operations</code> 可见（I16/I17）。
          </Notice>
          {publishError !== null ? (
            <ErrorBanner error={publishError} title="Could not publish the manifest" />
          ) : null}
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <Button variant="ghost" onClick={() => setStep('review')}>
              暂不发布，稍后再说 Skip for now
            </Button>
            <Button variant="primary" loading={publishing} onClick={() => void publish()}>
              发布清单 Publish manifest
            </Button>
          </div>
        </div>
      ) : null}

      {step === 'review' && connection ? (
        <div data-testid="wizard-step-review">
          {publishedCount !== null ? (
            <Notice tone="info">
              已发布 {publishedCount} 个 Operation Published {publishedCount}.
            </Notice>
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
            系统接入完成 System connected — gatekeeperId{' '}
            <code className="mono">{connection.gatekeeperId}</code>
          </Notice>
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <Button variant="ghost" onClick={onCancel}>
              关闭 Close
            </Button>
            <Button variant="primary" onClick={() => onFinished(connection.gatekeeperId)}>
              查看门详情 View gate detail
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
