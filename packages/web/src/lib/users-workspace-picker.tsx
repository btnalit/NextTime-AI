import type { PlatformWorkspaceWire } from '@nexttime/shared';
import { type ReactNode, useState } from 'react';
import { ErrorBanner } from '../components/kit/error-banner.js';
import { Field } from '../components/kit/field.js';
import { Select } from '../components/kit/select.js';
import { type CapabilityListResult, useCapabilityList } from '../hooks/useCapability.js';
import type { CapabilityCaller } from './clients.js';
import { useT } from './i18n.js';

/**
 * lib/users-workspace-picker: the users page's "which workspace" picker (create-user's default
 * membership, the memberships drawer's "加入工作区"), fed by `list_workspaces` — every workspace
 * that can take a member right now — instead of the union of memberships of whichever users the
 * page happened to have loaded, and without a typed-id escape hatch: a brand-new workspace nobody
 * is a member of yet is in this list too.
 *
 * The page's own default view of the workspaces page (`{status:'active', includeExpired:false}`):
 * a disabled or expired-ephemeral workspace is not one to add a person to.
 */
const ACTIVE_WORKSPACES = { status: 'active', includeExpired: false } as const;

/** More options than this gets a filter box above the select. */
export const WORKSPACE_FILTER_THRESHOLD = 8;

export function useActiveWorkspaces(
  http: CapabilityCaller,
): CapabilityListResult<PlatformWorkspaceWire> {
  return useCapabilityList<PlatformWorkspaceWire>(http, 'list_workspaces', ACTIVE_WORKSPACES);
}

export interface WorkspacePickerProps {
  readonly id: string;
  readonly label: string;
  readonly hint?: ReactNode;
  readonly required?: boolean;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly disabled?: boolean;
  /** `useActiveWorkspaces(http)` — the caller owns the read so it can also look names up. */
  readonly workspaces: CapabilityListResult<PlatformWorkspaceWire>;
  /** Workspace ids to leave out (e.g. the ones the user already belongs to). */
  readonly exclude?: readonly string[];
  /** `<option>`s rendered before the workspaces — a placeholder, or "默认 / 无" choices. */
  readonly leading: ReactNode;
  /** Said when the list (after `exclude`) has no workspace at all. */
  readonly emptyText: string;
  readonly testId?: string;
}

export function WorkspacePicker({
  id,
  label,
  hint,
  required = false,
  value,
  onChange,
  disabled = false,
  workspaces,
  exclude,
  leading,
  emptyText,
  testId,
}: WorkspacePickerProps) {
  const t = useT();
  const [filter, setFilter] = useState('');
  const state = workspaces.state;
  const excluded = new Set(exclude ?? []);
  const candidates =
    state.status === 'ready' ? state.data.items.filter((ws) => !excluded.has(ws.id)) : [];
  const needle = filter.trim().toLocaleLowerCase();
  // The picked workspace always stays an option, whatever the filter says — otherwise the native
  // select would silently show (and submit) a different value.
  const visible =
    needle === ''
      ? candidates
      : candidates.filter(
          (ws) =>
            ws.id === value ||
            ws.name.toLocaleLowerCase().includes(needle) ||
            ws.id.toLocaleLowerCase().includes(needle),
        );

  let shownHint: ReactNode = hint;
  if (state.status === 'loading') {
    shownHint = t('正在读取工作区列表…', 'Loading the workspace list…');
  } else if (state.status === 'ready' && candidates.length === 0) {
    shownHint = (
      <span data-testid={testId ? `${testId}-empty` : undefined}>
        {emptyText}
        {hint ? <> {hint}</> : null}
      </span>
    );
  } else if (needle !== '' && visible.every((ws) => ws.id === value)) {
    shownHint = t(
      `没有名称或 id 含“${filter.trim()}”的工作区。`,
      `No workspace matches “${filter.trim()}”.`,
    );
  }

  return (
    <div className="stack-s">
      {candidates.length > WORKSPACE_FILTER_THRESHOLD ? (
        <input
          className="input"
          aria-label={t('筛选工作区', 'Filter workspaces')}
          placeholder={t('按名称或 id 筛选', 'Filter by name or id')}
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          disabled={disabled}
          autoComplete="off"
          spellCheck={false}
          data-testid={testId ? `${testId}-filter` : undefined}
        />
      ) : null}
      <Field id={id} label={label} hint={shownHint} required={required}>
        <Select
          id={id}
          aria-label={label}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          disabled={disabled || state.status === 'loading'}
          data-testid={testId}
        >
          {leading}
          {visible.map((ws) => (
            <option key={ws.id} value={ws.id}>
              {ws.purpose === 'ephemeral' ? `${ws.name}${t('（临时）', ' (ephemeral)')}` : ws.name}
            </option>
          ))}
        </Select>
      </Field>
      {state.status === 'error' ? (
        <ErrorBanner
          error={state.error}
          title={t('无法读取工作区列表', 'Could not load the workspace list')}
          onRetry={() => void workspaces.reload()}
          testId={testId ? `${testId}-error` : undefined}
        />
      ) : null}
    </div>
  );
}
