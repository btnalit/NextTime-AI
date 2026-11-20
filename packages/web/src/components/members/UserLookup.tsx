import {
  LOOKUP_USERS_LIMIT,
  type LookedUpUserWire,
  type LookupUsersResultWire,
} from '@nexttime/shared';
import { type ReactNode, useMemo, useState } from 'react';
import { useCapability } from '../../hooks/useCapability.js';
import { useRoleCan } from '../../hooks/useRoleCan.js';
import { useDebounced } from '../../lib/audit-id-picker.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { useT } from '../../lib/i18n.js';
import { Combobox, type ComboboxOption } from '../kit/combobox.js';
import { ErrorBanner } from '../kit/error-banner.js';
import { Field } from '../kit/field.js';

/** `lookup_users`'s `query` is `min(2)` and `max(100)`; the kernel trims it before counting. */
export const LOOKUP_QUERY_MIN = 2;
const LOOKUP_QUERY_MAX = 100;
const SEARCH_DEBOUNCE_MS = 250;

export interface UserLookupProps {
  readonly http: CapabilityCaller;
  /** The combobox input's id (its `<label>` points here). */
  readonly id: string;
  readonly label: string;
  readonly hint?: ReactNode;
  /** The picked user; `null` = nothing picked yet. Held by the caller, so the box still names
   *  the person after the search moves on or the field is shown again. */
  readonly value: LookedUpUserWire | null;
  readonly onChange: (user: LookedUpUserWire | null) => void;
  readonly disabled?: boolean;
  readonly testId?: string;
}

/**
 * components/members/UserLookup (legacy 150): a workspace owner's "pick the person to add" — one
 * `kit/combobox` over `lookup_users`, the owner's side of `add_member`. Unlike the platform
 * administrator's `UserPicker` (`list_users`, a browsable directory), this is a search only: the
 * kernel answers nothing under 2 characters, at most 20 users, login and display name only, and
 * only people `add_member` could add (no one already a member here, no disabled account). So an
 * empty box lists nothing and says how many characters to type, and a cut-off answer says to type
 * more instead of offering to page.
 */
export function UserLookup({
  http,
  id,
  label,
  hint,
  value,
  onChange,
  disabled = false,
  testId,
}: UserLookupProps) {
  const t = useT();
  const [typed, setTyped] = useState('');
  const query = useDebounced(typed.trim().slice(0, LOOKUP_QUERY_MAX), SEARCH_DEBOUNCE_MS);
  const active = query.length >= LOOKUP_QUERY_MIN;
  const params = useMemo(() => ({ query }), [query]);
  // Owner only, like `add_member` — the form is offered to owners, and the read waits on the role.
  const canLookUp = useRoleCan(http)('lookup_users') === true;
  const lookup = useCapability<LookupUsersResultWire>(http, 'lookup_users', params, {
    enabled: active && canLookUp,
  });

  // Held reads keep their last state, so a box cleared below 2 characters shows no stale rows.
  const ready = active && lookup.state.status === 'ready' ? lookup.state.data : undefined;
  const rows = ready?.items ?? [];
  const typedEnough = typed.trim().length >= LOOKUP_QUERY_MIN;
  // A search still waiting out its debounce counts as loading: its rows are the previous search's.
  const loading =
    typedEnough && (typed.trim().slice(0, LOOKUP_QUERY_MAX) !== query || ready === undefined);
  const failed = active && lookup.state.status === 'error' ? lookup.state.error : null;

  const option = (user: LookedUpUserWire): ComboboxOption => ({
    value: user.login,
    label: `${user.login} — ${user.displayName}`,
  });
  // The picked user keeps its option (and so its label in the box) after the search moves on.
  const options = rows.map(option);
  if (value !== null && !rows.some((row) => row.login === value.login)) {
    options.unshift(option(value));
  }

  return (
    <>
      <Field id={id} label={label} hint={hint} required>
        <Combobox
          id={id}
          options={options}
          value={value?.login ?? ''}
          onChange={(next) => {
            onChange(
              next === ''
                ? null
                : (rows.find((row) => row.login === next) ??
                    (value?.login === next ? value : null)),
            );
            if (next === '') setTyped('');
          }}
          inputValue={typed}
          onInputValueChange={setTyped}
          onBlur={() => setTyped('')}
          loading={loading}
          disabled={disabled}
          mono
          placeholder={t('输入登录名或显示名查找', 'Type a login or display name to search')}
          emptyText={
            typedEnough
              ? t(
                  '没有可以添加的匹配用户。已是本工作区成员的人和已停用的账户不会列出。',
                  'No user you can add matches. Members of this workspace and disabled accounts are not listed.',
                )
              : t(
                  `输入至少 ${LOOKUP_QUERY_MIN} 个字符开始查找。`,
                  `Type at least ${LOOKUP_QUERY_MIN} characters to search.`,
                )
          }
          footer={
            ready?.truncated
              ? t(
                  `只列出最先匹配的 ${LOOKUP_USERS_LIMIT} 个，输入更多字符缩小范围。`,
                  `Only the first ${LOOKUP_USERS_LIMIT} matches are listed. Type more to narrow them down.`,
                )
              : undefined
          }
          testId={testId}
        />
      </Field>

      {failed !== null ? (
        <ErrorBanner
          error={failed}
          title={t('无法查找用户', 'Could not look users up')}
          onRetry={() => void lookup.reload()}
          testId={testId ? `${testId}-error` : undefined}
        />
      ) : null}
    </>
  );
}
