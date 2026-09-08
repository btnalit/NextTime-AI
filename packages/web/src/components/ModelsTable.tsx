import type { ModelRow } from '../lib/governance.js';
import { EmptyState } from './ui/EmptyState.js';

export interface ModelsTableProps {
  readonly models: readonly ModelRow[];
}

/** components/ModelsTable: the llm-proxy allow-list `list_models` (S3.11) projects — read-only
 *  everywhere it appears (`/govern/models`'s own table and `/me/agent`'s placeholder preview,
 *  S3.13 not being built yet). No provider keys, no pricing — just what a caller may pick. */
export function ModelsTable({ models }: ModelsTableProps) {
  if (models.length === 0) {
    return (
      <EmptyState
        icon="cpu"
        title="No models on the allow-list"
        body="The workspace owner configures llm-proxy's model allow-list (config/models.json)."
        testId="models-empty"
      />
    );
  }
  return (
    <table className="data-table" data-testid="models-table">
      <thead>
        <tr>
          <th>Model</th>
          <th>Provider</th>
          <th>Id</th>
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
          </tr>
        ))}
      </tbody>
    </table>
  );
}
