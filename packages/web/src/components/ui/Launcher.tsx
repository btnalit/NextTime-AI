import type { ReactNode } from 'react';
import { useT } from '../../lib/i18n.js';
import { Button } from './Button.js';

/** The four transport kinds a system can be reached through (`GateTransportKindWireSchema`). */
export type LauncherKind = 'http' | 'mcp' | 'ssh' | 'cli';

export const LAUNCHER_KINDS: readonly LauncherKind[] = ['http', 'mcp', 'ssh', 'cli'];

const KIND_LABEL: Readonly<
  Record<LauncherKind, { readonly title: string; readonly hint: string }>
> = {
  http: { title: 'HTTP 门 HTTP gate', hint: 'REST / OpenAPI manifest behind a gatekeeper' },
  mcp: { title: 'MCP 服务器 MCP server', hint: 'Model Context Protocol tools' },
  ssh: { title: 'SSH 主机 SSH host', hint: 'Commands on a remote host' },
  cli: { title: '命令行 CLI', hint: 'A local command-line tool' },
};

/** §5.9 / §5.6: 选类型 → 连接与凭证 → 能力与策略 → 握手验证. */
export const LAUNCHER_STEPS = [
  { key: 'kind', zh: '选类型', en: 'Type' },
  { key: 'connection', zh: '连接与凭证', en: 'Connection & credentials' },
  { key: 'policy', zh: '能力与策略', en: 'Capabilities & policy' },
  { key: 'handshake', zh: '握手验证', en: 'Handshake' },
] as const;

export type LauncherStep = 0 | 1 | 2 | 3;

export interface LauncherProps {
  readonly step: LauncherStep;
  readonly kind: LauncherKind | null;
  readonly onKindChange: (kind: LauncherKind) => void;
  readonly onNext: () => void;
  readonly onBack: () => void;
  /** Gate for 下一步; defaults to "a kind is chosen" on step 0 and `true` afterwards. */
  readonly canNext?: boolean;
  /** Label of the forward button on the last step (defaults to 完成 Finish). */
  readonly finishLabel?: string;
  readonly busy?: boolean;
  /** Restrict the selectable kinds (e.g. the connectors the platform allows). */
  readonly kinds?: readonly LauncherKind[];
  /** The current step's content — the S6-C lane fills these; the shell only frames them. */
  readonly children?: ReactNode;
  readonly testId?: string;
}

/**
 * components/ui/Launcher (S6-A0, §5.9 "Launcher"; §5.6 shares it between the 系统接入 and 集成
 * pages): the four-step "接入一个系统" stepper shell — a numbered progress list with
 * `aria-current="step"`, the kind selector on step 0 (http / mcp / ssh / cli as radio options),
 * a content slot for the step's own form, and 上一步 / 下一步 navigation. Presentation only:
 * the steps' forms, calls and handshake live in the pages that mount it.
 */
export function Launcher({
  step,
  kind,
  onKindChange,
  onNext,
  onBack,
  canNext,
  finishLabel,
  busy = false,
  kinds = LAUNCHER_KINDS,
  children,
  testId,
}: LauncherProps) {
  const t = useT();
  const effectiveFinishLabel = finishLabel ?? t('完成', 'Finish');
  const last = step === LAUNCHER_STEPS.length - 1;
  const forwardEnabled = canNext ?? (step === 0 ? kind !== null : true);
  return (
    <section
      className="launcher"
      data-testid={testId}
      data-step={step}
      aria-label={t('接入启动器', 'Launcher')}
    >
      <ol className="launcher-steps">
        {LAUNCHER_STEPS.map((item, index) => {
          const state = index < step ? 'done' : index === step ? 'current' : 'todo';
          return (
            <li
              key={item.key}
              className={`launcher-step launcher-step-${state}`}
              aria-current={index === step ? 'step' : undefined}
              data-testid={`launcher-step-${item.key}`}
            >
              <span className="launcher-step-index" aria-hidden>
                {index + 1}
              </span>
              <span className="launcher-step-label">
                {item.zh}
                <span className="nav-label-sub">{item.en}</span>
              </span>
            </li>
          );
        })}
      </ol>

      <div className="launcher-body">
        {step === 0 ? (
          <fieldset className="launcher-kinds">
            <legend className="section-title">{t('类型', 'Kind')}</legend>
            <div className="radio-group" data-testid="launcher-kind-group">
              {kinds.map((option) => (
                <label key={option} className="radio-option launcher-kind">
                  <input
                    type="radio"
                    name="launcher-kind"
                    value={option}
                    checked={kind === option}
                    onChange={() => onKindChange(option)}
                    data-testid={`launcher-kind-${option}`}
                  />
                  <span className="stack-s">
                    <span>{KIND_LABEL[option].title}</span>
                    <span className="text-3 text-small">{KIND_LABEL[option].hint}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
        ) : null}
        {children}
      </div>

      <div className="launcher-footer">
        <Button
          variant="ghost"
          icon="arrow-left"
          onClick={onBack}
          disabled={step === 0 || busy}
          data-testid="launcher-back"
        >
          {t('上一步', 'Back')}
        </Button>
        <Button
          variant="primary"
          onClick={onNext}
          disabled={!forwardEnabled}
          loading={busy}
          data-testid="launcher-next"
        >
          {last ? effectiveFinishLabel : t('下一步', 'Next')}
        </Button>
      </div>
    </section>
  );
}
