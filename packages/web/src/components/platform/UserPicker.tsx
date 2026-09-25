import type { UserWire } from '@nexttime/shared';
import { type ReactNode, useMemo, useState } from 'react';
import { useCapabilityList } from '../../hooks/useCapability.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { useT } from '../../lib/i18n.js';
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

/** S8 W4-C (ui-audit PW3 "'委托 owner' 下拉列出验收残留用户"): every call site of this picker so
 *  far is "pick a user to become an owner" — a not-yet-activated account (no password set: could
 *  be a real invite mid-onboarding, or an acceptance-run's leftover `create_user` nobody ever
 *  logged into) or an already-disabled one is never a sensible owner to delegate to. Narrower than
 *  the workspaces page's own `isResidueWorkspace` (that one is about *workspaces*, this is about
 *  *users*, and this component has no `list_workspaces` read to cross-reference a membership's
 *  purpose/expiry against) — but it is exactly the population an administrator would call
 *  "validation residue" showing up where it should not. */
function isResidueCandidate(user: UserWire): boolean {
  return !user.hasPassword || user.status === 'disabled';
}

/**
 * components/platform/UserPicker: "pick a platform user by login" — a search box over
 * `list_users`'s own `query` filter plus a `<select>` of what came back (P-A2, design §5 "成员"页
 * 语义: 按登录名搜索 → 选角色). Used by `CreateWorkspaceForm` (the first owner) and
 * `WorkspaceDetailPanel` (委托 owner). Both call sites pick a future *owner* — `isResidueCandidate`
 * above keeps not-yet-activated and disabled accounts out of the list for both.
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
  const t = useT();
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
      ? users.state.data.items.filter((row) => !excluded.has(row.id) && !isResidueCandidate(row))
      : [];

  function applyQuery(): void {
    setAppliedQuery(queryInput.trim());
  }

  return (
    <>
      <div className="row-wrap">
        <Field id={`${id}-query`} label={t('按登录名搜索', 'Search by login')}>
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
          {t('搜索', 'Search')}
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
          <option value="">{t('选择用户', 'Pick a user')}</option>
          {rows.map((row) => (
            // `isResidueCandidate` above already excludes disabled/not-yet-activated accounts —
            // every row here is active with a password set, so no status suffix is needed.
            <option key={row.id} value={row.id}>
              {row.login} — {row.displayName}
            </option>
          ))}
        </Select>
      </Field>

      <PlatformError
        error={users.state.status === 'error' ? users.state.error : null}
        title={t('无法读取用户目录', 'Could not load the user directory')}
      />
    </>
  );
}
