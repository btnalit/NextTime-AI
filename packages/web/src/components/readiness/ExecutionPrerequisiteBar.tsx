import type { CapabilityCaller } from '../../lib/clients.js';
import { useT } from '../../lib/i18n.js';
import { executionReadinessMissingCodeLabel } from '../../lib/labels.js';
import { Notice } from '../ui/Notice.js';
import {
  missingCauseText,
  missingKey,
  missingLinkHref,
  missingLinkLabel,
} from './readiness-copy.js';
import { useExecutionReadiness } from './useExecutionReadiness.js';

export interface ExecutionPrerequisiteBarProps {
  readonly http: CapabilityCaller;
}

/**
 * components/readiness/ExecutionPrerequisiteBar: J1's shared "执行前提" hint bar (ui-audit
 * -2026-09-23 J1, console-completion-plan §5.9 控制塔; docs/development-tasks.md §5e F6
 * `execution_readiness`) — mounted at the top of 系统接入 / 能力目录 / 访问 (the three pages J1's
 * own audit row names) so a reader mid-setup sees the *same* "what's still missing" summary no
 * matter which of the three pages they landed on.
 *
 * Reads the signed-in caller's own readiness only (`useExecutionReadiness`, no `principalId`) and
 * renders nothing while loading, on a read error (this is a supplementary hint, not the page's own
 * content — a transient failure here must never block or clutter the host page), or once
 * `ready`. Only the not-ready case renders, one line per `missing[]` item — cause text plus a link
 * to the page that fixes it (`readiness-copy.ts`), gate ids resolved to names from this same
 * response's own `gates[]` (never a raw id, never the bare `code` — ui-audit S14).
 */
export function ExecutionPrerequisiteBar({ http }: ExecutionPrerequisiteBarProps) {
  const t = useT();
  const readiness = useExecutionReadiness(http);
  if (readiness.state.status !== 'ready' || readiness.state.data.ready) return null;

  const data = readiness.state.data;
  const gateNames = new Map(data.gates.map((gate) => [gate.gateId, gate.name]));

  return (
    <Notice tone="warn" testId="execution-prerequisite-bar">
      <div className="flex flex-col gap-1">
        <strong>{t('执行前提尚未满足', 'Execution prerequisites not met yet')}</strong>
        <ul className="flex flex-col gap-1" data-testid="execution-prerequisite-items">
          {data.missing.map((item) => (
            <li
              key={missingKey(item)}
              className="row-wrap"
              title={executionReadinessMissingCodeLabel(item.code, t)}
            >
              <span>{missingCauseText(item, gateNames, t)}</span>{' '}
              <a href={missingLinkHref(item)}>{missingLinkLabel(item, t)}</a>
            </li>
          ))}
        </ul>
      </div>
    </Notice>
  );
}
