import type { UserWire } from '@nexttime/shared';
import { type ReactNode, useMemo, useState } from 'react';
import { useCapabilityList } from '../../hooks/useCapability.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { Button } from '../ui/Button.js';
import { Field, Input, Select } from '../ui/Field.js';
import { PlatformError } from './PlatformError.js';

export interface UserPickerProps {
  readonly http: CapabilityCaller;
  /** Prefix for the two control ids this renders (`<id>-query` and `<id>`). */
  readonly id: string;
  readonly label: string;
  readonly hint?: ReactNode;
  /** The picked user's id; `''` = nothing picked yet. */
  readonly value: string;
  readonly onChange: (userId: string) => void;
  readonly disabled?: boolean;
  /** User ids to leave out of the list — e.g. the workspace's existing owners. */
  readonly exclude?: readonly string[];
  readonly testId?: string;
}

const PAGE_SIZE = 50;

/**
 * components/platform/UserPicker: "pick a platform user by login" — a search box over
 * `list_users`'s own `query` filter plus a `<select>` of what came back (P-A2, design §5 "成员"页
 * 语义: 按登录名搜索 → 选角色). Used by `CreateWorkspaceForm` (the first owner) and
 * `WorkspaceDetailPanel` (委托 owner).
 *
 * The `list_users` read lives *here* rather than on the page so it is lazy in the only sense that
 * matters: this component is mounted only while a drawer that needs a user is open, so the
 * workspaces list costs two capability calls, not three, until an administrator actually opens
 * one. The search is applied on a button press, never per keystroke — a nested `<form>` is invalid
 * inside `CreateWorkspaceForm`'s own, so this is a plain button.
 */
export function UserPicker({
  http,
  id,
  label,
  hint,
  value,
  onChange,
  disabled = false,
  exclude,
  testId,
}: UserPickerProps) {
  const [queryInput, setQueryInput] = useState('');
  const [appliedQuery, setAppliedQuery] = useState('');

  // `list_users`'s `query` is `min(1)` — an empty box omits the field rather than sending `''`.
  const params = useMemo(() => {
    const next: Record<string, unknown> = { limit: PAGE_SIZE };
    if (appliedQuery !== '') next.query = appliedQuery;
    return next;
  }, [appliedQuery]);

  const users = useCapabilityList<UserWire>(http, 'list_users', params);
  const loading = users.state.status === 'loading';
  const excluded = new Set(exclude ?? []);
  const rows =
    users.state.status === 'ready'
      ? users.state.data.items.filter((row) => !excluded.has(row.id))
      : [];

  function applyQuery(): void {
    setAppliedQuery(queryInput.trim());
  }

  return (
    <>
      <div className="row-wrap">
        <Field id={`${id}-query`} label="按登录名搜索 Search by login">
          <Input
            id={`${id}-query`}
            value={queryInput}
            onChange={(event) => setQueryInput(event.target.value)}
            // Enter searches. Without this it would submit the surrounding
            // `CreateWorkspaceForm` instead — creating the workspace with whatever owner was
            // picked before, which is never what pressing Enter in a search box means.
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return;
              event.preventDefault();
              applyQuery();
            }}
            disabled={disabled}
            autoComplete="off"
            spellCheck={false}
            mono
          />
        </Field>
        <Button
          variant="secondary"
          icon="search"
          onClick={applyQuery}
          disabled={disabled}
          loading={loading}
        >
          搜索 Search
        </Button>
      </div>

      <Field id={id} label={label} hint={hint} required>
        <Select
          id={id}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          disabled={disabled || loading}
          data-testid={testId}
        >
          <option value="">选择用户 Pick a user</option>
          {rows.map((row) => (
            <option key={row.id} value={row.id}>
              {row.login} — {row.displayName}
              {row.status === 'disabled' ? '（已停用 disabled）' : ''}
            </option>
          ))}
        </Select>
      </Field>

      <PlatformError
        error={users.state.status === 'error' ? users.state.error : null}
        title="无法读取用户目录 Could not load the user directory"
      />
    </>
  );
}
