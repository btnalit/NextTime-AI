import {
  FRESHNESS_LEGEND,
  OBSERVATION_WINDOW_MS,
  formatWindow,
  freshnessLabel,
} from '../../lib/graph-freshness.js';
import { useT } from '../../lib/i18n.js';
import { Icon } from '../ui/Icon.js';

/**
 * components/graph/FreshnessLegend: what each freshness colour means and the window it is judged
 * against (`lib/graph-freshness.ts` — a documented client-side default, since no capability
 * exposes the deployment's observation window yet). Colour is never the only carrier: each row
 * shows the chip with its text (§5.9 principle 2).
 */
export function FreshnessLegend() {
  const t = useT();
  return (
    <details className="disclosure graph-legend" data-testid="graph-legend">
      <summary>
        <Icon name="chevron-right" size="s" className="icon-chevron" />
        {t('新鲜度图例', 'Freshness legend')} · {t('窗口', 'window')}{' '}
        {formatWindow(OBSERVATION_WINDOW_MS)}
      </summary>
      <div className="disclosure-body">
        <ul className="graph-legend-list">
          {FRESHNESS_LEGEND.map((row) => (
            <li key={row.kind} className="graph-legend-row">
              <span className={`chip chip-s chip-${row.tone}`} data-freshness={row.kind}>
                {freshnessLabel(row.label, t)}
              </span>
              <span className="text-2 text-small">{freshnessLabel(row.description, t)}</span>
            </li>
          ))}
        </ul>
        <p className="text-3 text-small">
          窗口取内核 <code>ops.collector_silent</code>{' '}
          {t('的默认值（2 小时）；内核尚未通过能力暴露该窗口。', 'The window mirrors the kernel’s')}{' '}
          <code>ops.collector_silent</code> default (2 h); no capability exposes the deployment’s
          own value yet.
        </p>
      </div>
    </details>
  );
}
