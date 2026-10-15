import type { ModelRow } from '../lib/governance.js';
import { useT } from '../lib/i18n.js';
import { ModelHealthTag } from './kit/model-health.js';
import { EmptyState } from './ui/EmptyState.js';

export interface ModelsTableProps {
  readonly models: readonly ModelRow[];
}

/** components/ModelsTable: the llm-proxy allow-list `list_models` (S3.11) projects — read-only
 *  everywhere it appears (`/govern/models`'s own table and `/me/agent`'s placeholder preview,
 *  S3.13 not being built yet). No provider keys, no pricing — just what a caller may pick. */
export function ModelsTable({ models }: ModelsTableProps) {
  const t = useT();
  if (models.length === 0) {
    return (
      <EmptyState
        icon="cpu"
        title={t('清单里还没有模型', 'No models on the allow-list')}
        body={t(
          '由工作区所有者配置可用的模型。',
          'The workspace owner configures the model allow-list.',
        )}
        testId="models-empty"
      />
    );
  }
  return (
    <table className="data-table" data-testid="models-table">
      <thead>
        <tr>
          <th>{t('模型', 'Model')}</th>
          <th>{t('供应商', 'Provider')}</th>
          <th>{t('模型 ID', 'Model ID')}</th>
          <th>{t('状态', 'Status')}</th>
        </tr>
      </thead>
      <tbody>
        {models.map((row) => (
          <tr key={row.id}>
            <td className="mono">{row.model}</td>
            <td>
              <span className="tag">{row.provider}</span>
            </td>
            <td className="mono text-3">{row.id}</td>
            <td>
              {/* No health from the kernel reads 状态未知 (review M1), never a blank. */}
              <ModelHealthTag model={row} showOk testId={`model-health-${row.id}`} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
