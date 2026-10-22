import type { UserWire } from '@nexttime/shared';
import { type ReactNode, useMemo, useRef, useState } from 'react';
import { useCapabilityList } from '../../hooks/useCapability.js';
import { useDebounced } from '../../lib/audit-id-picker.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { shortId } from '../../lib/format.js';
import { useT } from '../../lib/i18n.js';
import { Combobox, type ComboboxOption } from '../kit/combobox.js';
import { Field } from '../ui/Field.js';
import { PlatformError } from './PlatformError.js';

export interface UserPickerProps {
  readonly http: CapabilityCaller;
  /** The combobox input's id (its `<label>` points here). */
  readonly id: string;
  readonly label: string;
  readonly hint?: ReactNode;
  /** The picked user's id; `''` = nothing picked yet. */
  readonly value: string;
  readonly onChange: (userId: string) => void;
  readonly disabled?: boolean;
  /** User ids to leave out of the list — e.g. the workspace's existing owners. */
  readonly exclude?: readonly string[];
  /** Legacy 153 ⑤: a workspace whose members stay listed but cannot be picked, marked
   *  「已是本工作区成员」 — adding one again could only be refused. */
  readonly memberOf?: string;
  readonly testId?: string;
}

const PAGE_SIZE = 50;
const SEARCH_DEBOUNCE_MS = 250;

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
 * components/platform/UserPicker: "pick a platform user by login" — one `kit/combobox` over
 * `list_users` (P-A2, design §5 "成员"页语义: 按登录名搜索 → 选角色). Typing searches `list_users{query}`
 * (login or display name, kernel-side, debounced), so any user is reachable, not just the first
 * page; an empty box lists the directory's first page. Legacy 153 ①: this used to be a search box,
 * a 搜索 button and a `<select>` — two controls for one field. Used by `CreateWorkspaceForm` (the
 * first owner), `WorkspaceDetailPanel` (委托 owner), `UserDetailPanel` (merge target) and
 * `AddMemberForm` — `isResidueCandidate` above keeps not-yet-activated and disabled accounts out of
 * the list for all of them.
 *
 * The `list_users` read lives *here* rather than on the page so it is lazy in the only sense that
 * matters: this component is mounted only while a drawer that needs a user is open.
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
  memberOf,
  testId,
}: UserPickerProps) {
  const t = useT();
  const [typed, setTyped] = useState('');
  const query = useDebounced(typed.trim(), SEARCH_DEBOUNCE_MS);

  // `list_users`'s `query` is `min(1)` (and at most 100) — an empty box omits the field.
  const params = useMemo(() => {
    const next: Record<string, unknown> = { limit: PAGE_SIZE };
    if (query !== '') next.query = query.slice(0, 100);
    return next;
  }, [query]);

  const users = useCapabilityList<UserWire>(http, 'list_users', params);
  const loading = users.state.status === 'loading';
  const excluded = new Set(exclude ?? []);
  const rows =
    users.state.status === 'ready'
      ? users.state.data.items.filter((row) => !excluded.has(row.id) && !isResidueCandidate(row))
      : [];
  // The picked user keeps its option (and so its label in the box) after the search moves on.
  const known = useRef(new Map<string, UserWire>());
  for (const row of rows) known.current.set(row.id, row);
  const picked = value === '' ? undefined : known.current.get(value);
  const listed = picked && !rows.some((row) => row.id === picked.id) ? [picked, ...rows] : rows;

  const isMember = (user: UserWire): boolean =>
    memberOf !== undefined && user.memberships.some((m) => m.workspaceId === memberOf);
  const options: ComboboxOption[] = listed.map((user) => ({
    value: user.id,
    label: `${user.login} — ${user.displayName}`,
    disabled: isMember(user),
    secondary: isMember(user) ? t('已是本工作区成员', 'Already a member here') : undefined,
  }));
  // A value the directory has not named yet (a default owner past the first page, or still
  // loading) reads as a short id, never the whole raw id.
  if (value !== '' && picked === undefined) {
    options.unshift({
      value,
      label: loading
        ? t('正在读取…', 'Loading…')
        : t(`用户 ${shortId(value)}`, `User ${shortId(value)}`),
    });
  }

  return (
    <>
      <Field id={id} label={label} hint={hint} required>
        <Combobox
          id={id}
          options={options}
          value={value}
          onChange={(next) => {
            onChange(next);
            if (next === '') setTyped('');
          }}
          inputValue={typed}
          onInputValueChange={setTyped}
          onBlur={() => setTyped('')}
          loading={loading}
          disabled={disabled}
          mono
          placeholder={t('输入登录名或名称搜索', 'Type a login or name to search')}
          emptyText={
            query !== ''
              ? t('没有匹配的用户。', 'No matching users.')
              : t('目录里还没有可选的用户。', 'No users to pick yet.')
          }
          testId={testId}
        />
      </Field>

      <PlatformError
        error={users.state.status === 'error' ? users.state.error : null}
        title={t('无法读取用户目录', 'Could not load the user directory')}
      />
    </>
  );
}
