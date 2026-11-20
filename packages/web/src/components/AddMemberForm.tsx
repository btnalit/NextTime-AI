import { type LookedUpUserWire, ROLE_VALUES, type Role } from '@nexttime/shared';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { invalidateCapability } from '../hooks/useCapability.js';
import { useFocusWhenLost } from '../hooks/useFocusWhenLost.js';
import { usePermissions } from '../hooks/usePermissions.js';
import type { CapabilityCaller } from '../lib/clients.js';
import { isForbiddenError } from '../lib/errors.js';
import type { PrincipalRow } from '../lib/governance.js';
import { useT } from '../lib/i18n.js';
import { roleDescription, roleLabel } from '../lib/labels.js';
import {
  loginError,
  loginNormalizedNote,
  loginRuleText,
  normalizeLoginInput,
} from '../lib/login-input.js';
import { platformErrorMessage } from '../lib/platform-errors.js';
import { useUserDirectoryTap } from '../lib/users-directory.js';
import { Button } from './kit/button.js';
import { useGuardedClose } from './kit/discard-guard.js';
import { ErrorBanner } from './kit/error-banner.js';
import { Field, describedBy } from './kit/field.js';
import { Notice } from './kit/notice.js';
import { Select } from './kit/select.js';
import { StillNeeded } from './kit/still-needed.js';
import { UserLookup } from './members/UserLookup.js';
import { UserPicker } from './platform/UserPicker.js';

export interface AddMemberFormProps {
  readonly http: CapabilityCaller;
  readonly onDone: (principal: PrincipalRow) => void;
  readonly onCancel: () => void;
  /** Whether the signed-in user is a platform administrator (`session.user?.platformRole ===
   *  'admin'`). `true` opens straight on the user directory; `false` never tries it and opens on
   *  the owner's search (`lookup_users`). Omitted: the form opens on the search, tries
   *  `list_users` once in the background and switches to the directory only if it answers before
   *  anything was picked or typed (a 403 means "not a platform administrator" and is remembered
   *  for the session). */
  readonly platformAdmin?: boolean;
  /** This workspace — the directory marks its existing members and does not let them be
   *  picked (legacy 153 ⑤). */
  readonly workspaceId?: string;
}

/** The probe asks for exactly `UserPicker`'s first page. */
const DIRECTORY_PROBE = { limit: 50 } as const;

type Mode = 'directory' | 'lookup' | 'typed';

type DirectoryState =
  | { readonly kind: 'probing' }
  | { readonly kind: 'available' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'failed'; readonly error: unknown };

/**
 * components/AddMemberForm (console redesign P3-4 part B, on `components/kit/*` only):
 * `add_member{login, role}` (P-A1) — a person joins this workspace by their **platform login**,
 * not by having a credential minted for them: the capability creates the membership Principal
 * with no API key at all (`hasApiKey: false`), and the person signs in with the password their
 * platform account already has (design doc §5: "工作区配置里的成员页语义变为从平台用户中添加（按登录
 * 名搜索 → 选角色）"). `create_principal` is now only the service-credential path — see
 * `CreatePrincipalForm`.
 *
 * Who the login belongs to: the user directory (`list_users`, `scope:'platform'`) is readable only
 * by a platform administrator, so for one the form offers `UserPicker` (browse or search by login
 * or display name, then pick). A workspace owner who is not one searches with `lookup_users`
 * (legacy 150, `members/UserLookup`): at least 2 characters, at most 20 matches, only people this
 * workspace can add. Either can switch to typing the login — normalized the way the kernel will
 * (trim + lower-case, "将保存为 alice") and checked against the login rule before the round trip:
 * the directory leaves out accounts that have not set a password yet, the search leaves out
 * acceptance-run residue, and those can be added too.
 *
 * Two kernel refusals get their own bilingual line instead of a banner: `user_not_found` (404 —
 * no such platform login, or it is disabled) and `already_member` (409), the two a typo or a
 * double-click actually produces.
 */
export function AddMemberForm({
  http,
  onDone,
  onCancel,
  platformAdmin,
  workspaceId,
}: AddMemberFormProps) {
  // Legacy 497: in a drawer whose form was edited, 取消 asks before discarding it.
  const guardedClose = useGuardedClose();
  const t = useT();
  const permissions = usePermissions();
  const directory = useUserDirectoryTap(http);

  // Decided once, on mount: a 403 from this very probe must not flip it mid-flight.
  const [shouldProbe] = useState(
    () => platformAdmin === undefined && !permissions.isDenied('list_users'),
  );
  const [directoryState, setDirectoryState] = useState<DirectoryState>(() =>
    platformAdmin === true
      ? { kind: 'available' }
      : shouldProbe
        ? { kind: 'probing' }
        : { kind: 'unavailable' },
  );
  const [mode, setMode] = useState<Mode>(platformAdmin === true ? 'directory' : 'lookup');
  const [probeAttempt, setProbeAttempt] = useState(0);
  const [pickedUserId, setPickedUserId] = useState('');
  const [lookedUp, setLookedUp] = useState<LookedUpUserWire | null>(null);
  const [login, setLogin] = useState('');
  const [role, setRole] = useState<Role>('member');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown | null>(null);
  // Legacy 500: the submit button is disabled while it runs, so a refusal left focus on <body>
  // and its banner, above the pinned action row, below the fold — focus goes to the banner.
  const submitErrorRef = useFocusWhenLost<HTMLDivElement>(error);

  // Read inside the probe's callback: a reader who already typed or picked keeps what they have.
  const startedRef = useRef(false);
  startedRef.current = login.trim() !== '' || lookedUp !== null;
  const markDeniedRef = useRef(permissions.markDenied);
  markDeniedRef.current = permissions.markDenied;

  // biome-ignore lint/correctness/useExhaustiveDependencies: `probeAttempt` is the retry trigger.
  useEffect(() => {
    if (!shouldProbe) return;
    let live = true;
    setDirectoryState({ kind: 'probing' });
    directory.caller.call('list_users', DIRECTORY_PROBE).then(
      () => {
        if (!live) return;
        setDirectoryState({ kind: 'available' });
        if (!startedRef.current) setMode('directory');
      },
      (err: unknown) => {
        if (!live) return;
        if (isForbiddenError(err)) {
          markDeniedRef.current('list_users');
          setDirectoryState({ kind: 'unavailable' });
        } else {
          setDirectoryState({ kind: 'failed', error: err });
        }
      },
    );
    return () => {
      live = false;
    };
  }, [shouldProbe, directory.caller, probeAttempt]);

  const picked = mode === 'directory' ? directory.find(pickedUserId) : undefined;
  // Legacy 725: a person removed from this workspace before is added back as a new membership.
  const removedHere =
    workspaceId !== undefined &&
    picked?.memberships.some((m) => m.workspaceId === workspaceId && m.disabled) === true;
  const normalizedLogin = normalizeLoginInput(login);
  const typedLoginError = mode === 'typed' ? loginError(normalizedLogin, t) : null;
  const typedLoginNote = mode === 'typed' ? loginNormalizedNote(login, t) : null;
  const submitLogin =
    mode === 'directory'
      ? (picked?.login ?? '')
      : mode === 'lookup'
        ? (lookedUp?.login ?? '')
        : normalizedLogin;
  const ready = submitLogin !== '' && typedLoginError === null;
  // DoD item 4: a disabled 添加 says what it still waits for (the field labels' own words).
  const missing =
    submitLogin === ''
      ? [
          mode === 'typed'
            ? t('填写登录名', 'enter a login')
            : mode === 'lookup'
              ? t('选择用户', 'pick a user')
              : t('选择平台用户', 'pick a platform user'),
        ]
      : typedLoginError !== null
        ? [t('改正登录名', 'fix the login')]
        : [];

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!ready || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const principal = await http.call<PrincipalRow>('add_member', { login: submitLogin, role });
      // The person just added is no longer someone this workspace can add.
      invalidateCapability(http, 'lookup_users');
      onDone(principal);
    } catch (err) {
      setError(err);
    } finally {
      setSubmitting(false);
    }
  }

  function switchMode(next: Mode): void {
    setMode(next);
    setError(null);
    // Carry the picked user into the text box, so typing starts from it rather than from empty.
    if (next === 'typed') {
      const carried =
        mode === 'directory' ? picked?.login : mode === 'lookup' ? lookedUp?.login : '';
      if (carried) setLogin(carried);
    }
  }

  const lookupInstead = (
    <div className="row">
      <Button
        variant="ghost"
        size="s"
        onClick={() => switchMode('lookup')}
        disabled={submitting}
        data-testid="add-member-lookup-instead"
      >
        {t('改为查找并选择', 'Search and pick instead')}
      </Button>
    </div>
  );

  const typeInstead = (
    <div className="row">
      <Button
        variant="ghost"
        size="s"
        onClick={() => switchMode('typed')}
        disabled={submitting}
        data-testid="add-member-type-instead"
      >
        {t('改为手动输入', 'Type a login instead')}
      </Button>
    </div>
  );

  const inline = platformErrorMessage(error, t);
  const typedHint = [
    t(
      '平台用户的登录名；这里不创建账户，也不签发 API key。',
      "An existing platform user's login — this creates no account and no API key.",
    ),
    loginRuleText(t),
    typedLoginNote,
  ]
    .filter((part) => part !== null)
    .join(' ');

  return (
    <form
      className="stack"
      onSubmit={(event) => void handleSubmit(event)}
      noValidate
      data-testid="add-member-form"
    >
      {mode === 'directory' ? (
        <>
          <UserPicker
            http={directory.caller}
            id="am-user"
            label={t('平台用户', 'Platform user')}
            hint={t(
              '从平台用户目录里选；还没设置过密码的账户不在列表里，可改为手动输入。',
              'Pick from the platform user directory. Accounts that have not set a password yet are not listed — type their login instead.',
            )}
            value={pickedUserId}
            onChange={setPickedUserId}
            disabled={submitting}
            memberOf={workspaceId}
            testId="add-member-user"
          />
          {removedHere ? (
            <Notice testId="add-member-readd">
              {t(
                '这个人曾被移出本工作区。添加会新建一条成员资格，原来那条留着供审计溯源；这个人看不到移出前的草稿和目标。',
                'This person was removed from this workspace before. Adding them creates a new membership and the removed one is kept for audit lineage; they will not see their drafts and goals from before the removal.',
              )}
            </Notice>
          ) : null}
          {typeInstead}
        </>
      ) : mode === 'lookup' ? (
        <>
          <UserLookup
            http={http}
            id="am-lookup"
            label={t('用户', 'User')}
            hint={t(
              '输入登录名或显示名的一部分，再从列表里选。只列出能加进本工作区的人；查不到的账户可改为手动输入登录名。',
              'Type part of a login or display name, then pick from the list. Only people who can be added to this workspace are listed. If someone is not found, type their login instead.',
            )}
            value={lookedUp}
            onChange={setLookedUp}
            disabled={submitting}
            testId="add-member-lookup"
          />
          {typeInstead}
        </>
      ) : (
        <>
          <Field
            id="am-login"
            label={t('登录名', 'Login')}
            required
            hint={typedHint}
            error={typedLoginError}
          >
            <input
              id="am-login"
              className="input input-mono"
              value={login}
              onChange={(event) => setLogin(event.target.value)}
              onBlur={() => setLogin(normalizeLoginInput(login))}
              disabled={submitting}
              aria-invalid={typedLoginError !== null || undefined}
              aria-describedby={describedBy(
                'am-login',
                typedHint !== undefined,
                typedLoginError !== null,
              )}
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
          {directoryState.kind === 'available' ? (
            <div className="row">
              <Button
                variant="ghost"
                size="s"
                onClick={() => switchMode('directory')}
                disabled={submitting}
                data-testid="add-member-pick-instead"
              >
                {t('从平台用户目录选择', 'Pick from the user directory')}
              </Button>
            </div>
          ) : directoryState.kind === 'failed' ? (
            <>
              {lookupInstead}
              <ErrorBanner
                error={directoryState.error}
                title={t(
                  '无法读取平台用户目录，可先手动输入',
                  'Could not load the platform user directory — type the login for now',
                )}
                onRetry={() => setProbeAttempt((n) => n + 1)}
                testId="add-member-directory-error"
              />
            </>
          ) : (
            lookupInstead
          )}
        </>
      )}

      <Field
        id="am-role"
        label={t('角色', 'Role')}
        required
        hint={`${roleDescription(role, t) ?? ''}${t('之后可在成员行里修改。', " Can be changed later from the member's row.")}`}
      >
        <Select
          id="am-role"
          aria-label={t('角色', 'Role')}
          className="select-fit"
          value={role}
          onChange={(event) => setRole(event.target.value as Role)}
          disabled={submitting}
        >
          {ROLE_VALUES.map((value) => (
            <option key={value} value={value}>
              {roleLabel(value, t)}
            </option>
          ))}
        </Select>
      </Field>

      {inline !== null ? (
        <p className="field-error" role="alert" data-testid="add-member-error">
          {inline}
        </p>
      ) : error !== null ? (
        <div ref={submitErrorRef} tabIndex={-1}>
          <ErrorBanner
            error={error}
            title={t('无法添加成员', 'Could not add this member')}
            testId="add-member-error"
          />
        </div>
      ) : null}

      <div className="row overlay-actions" style={{ justifyContent: 'flex-end' }}>
        <Button variant="ghost" onClick={() => guardedClose(onCancel)} disabled={submitting}>
          {t('取消', 'Cancel')}
        </Button>
        <Button type="submit" variant="primary" aria-busy={submitting} disabled={!ready}>
          {t('添加', 'Add')}
        </Button>
        <StillNeeded items={missing} hidden={submitting} testId="add-member-missing" />
      </div>
    </form>
  );
}
