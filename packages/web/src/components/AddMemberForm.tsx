import { ROLE_VALUES, type Role } from '@nexttime/shared';
import { type FormEvent, useState } from 'react';
import type { CapabilityCaller } from '../lib/clients.js';
import type { PrincipalRow } from '../lib/governance.js';
import { platformErrorMessage } from '../lib/platform-errors.js';
import { Button } from './ui/Button.js';
import { ErrorBanner } from './ui/ErrorBanner.js';
import { Field, Input, Select } from './ui/Field.js';

export interface AddMemberFormProps {
  readonly http: CapabilityCaller;
  readonly onDone: (principal: PrincipalRow) => void;
  readonly onCancel: () => void;
}

/**
 * components/AddMemberForm: `add_member{login, role}` (P-A1) — a person joins this workspace by
 * their **platform login**, not by having a credential minted for them: the capability creates the
 * membership Principal with no API key at all (`hasApiKey: false`), and the person signs in with
 * the password their platform account already has (design doc §5: "工作区配置里的成员页语义变为
 * 从平台用户中添加（按登录名搜索 → 选角色）"). `create_principal` is now only the service-
 * credential path — see `CreatePrincipalForm`.
 *
 * Two kernel refusals get their own bilingual line instead of a banner: `user_not_found` (404 —
 * no such platform login, or it is disabled) and `already_member` (409), the two a typo or a
 * double-click actually produces.
 */
export function AddMemberForm({ http, onDone, onCancel }: AddMemberFormProps) {
  const [login, setLogin] = useState('');
  const [role, setRole] = useState<Role>('member');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const trimmed = login.trim();
    if (!trimmed || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      onDone(await http.call<PrincipalRow>('add_member', { login: trimmed, role }));
    } catch (err) {
      setError(err);
    } finally {
      setSubmitting(false);
    }
  }

  const inline = platformErrorMessage(error);

  return (
    <form
      className="stack"
      onSubmit={(event) => void handleSubmit(event)}
      noValidate
      data-testid="add-member-form"
    >
      <Field
        id="am-login"
        label="登录名 Login"
        required
        hint="平台用户的登录名；这里不创建账户，也不签发 API key。 An existing platform user's login — this creates no account and no API key."
      >
        <Input
          id="am-login"
          value={login}
          onChange={(event) => setLogin(event.target.value)}
          disabled={submitting}
          autoComplete="off"
          spellCheck={false}
          mono
          autoFocus
        />
      </Field>

      <Field
        id="am-role"
        label="角色 Role"
        required
        hint="Can be changed later from the member's row."
      >
        <Select
          id="am-role"
          value={role}
          onChange={(event) => setRole(event.target.value as Role)}
          disabled={submitting}
        >
          {ROLE_VALUES.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </Select>
      </Field>

      {inline !== null ? (
        <p className="field-error" role="alert" data-testid="add-member-error">
          {inline}
        </p>
      ) : error !== null ? (
        <ErrorBanner
          error={error}
          title="无法添加成员 Could not add this member"
          testId="add-member-error"
        />
      ) : null}

      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <Button variant="ghost" onClick={onCancel} disabled={submitting}>
          取消 Cancel
        </Button>
        <Button type="submit" variant="primary" loading={submitting} disabled={!login.trim()}>
          添加 Add
        </Button>
      </div>
    </form>
  );
}
