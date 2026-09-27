import { ROLE_VALUES, type Role } from '@nexttime/shared';
import { type FormEvent, useState } from 'react';
import type { CapabilityCaller } from '../lib/clients.js';
import type { CreatePrincipalResult } from '../lib/governance.js';
import { useT } from '../lib/i18n.js';
import { roleLabel } from '../lib/labels.js';
import { Button } from './kit/button.js';
import { CopyButton } from './kit/copy-button.js';
import { ErrorBanner } from './kit/error-banner.js';
import { Field } from './kit/field.js';
import { Notice } from './kit/notice.js';
import { Select } from './kit/select.js';

export interface CreatePrincipalFormProps {
  readonly http: CapabilityCaller;
  /** Called once the reader has acknowledged the one-time key and the drawer should close. */
  readonly onDone: (principal: CreatePrincipalResult['principal']) => void;
  readonly onCancel: () => void;
}

/**
 * components/CreatePrincipalForm (console redesign P3-4 part B, on `components/kit/*` only):
 * `create_principal{role, displayName}` (S3.11; relabelled in P-A1) — always a `kind: 'service'`
 * principal: an automation credential for scripts and acceptance harnesses, never a person.
 * People join a workspace through `add_member` (`AddMemberForm`) / `add_membership`, which mint
 * no key at all (design doc §5, and `create_principal`'s own capability description). Two phases:
 * `form` (role + display name) → `created` (the returned API key, shown exactly once —
 * `docs/development-tasks.md` §S3.11: "API key 只显示一次"). The key never touches
 * `lib/session.ts`/`sessionStorage` and is dropped from this component's own state the moment the
 * drawer closes (mirrors `CompleteConnectionForm`'s credential-clearing discipline for the
 * shared-credential field).
 */
export function CreatePrincipalForm({ http, onDone, onCancel }: CreatePrincipalFormProps) {
  const t = useT();
  const [displayName, setDisplayName] = useState('');
  const [role, setRole] = useState<Role>('member');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown | null>(null);
  const [created, setCreated] = useState<CreatePrincipalResult | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const trimmed = displayName.trim();
    if (!trimmed || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await http.call<CreatePrincipalResult>('create_principal', {
        role,
        displayName: trimmed,
      });
      setCreated(result);
    } catch (err) {
      setError(err);
    } finally {
      setSubmitting(false);
    }
  }

  if (created) {
    return (
      <div className="stack" data-testid="create-principal-key">
        <Notice tone="warn">
          {t(
            '这个 API key 只显示一次：现在复制并交给这个凭证的持有者，控制台不会再显示。',
            'This API key is shown once. Copy it now and hand it to whoever will use it — the console never displays it again.',
          )}
        </Notice>
        <div className="code-block row" style={{ justifyContent: 'space-between' }}>
          <span className="mono" data-testid="created-api-key">
            {created.apiKey}
          </span>
          <CopyButton value={created.apiKey} label="API key" />
        </div>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <Button
            variant="primary"
            onClick={() => {
              setAcknowledged(true);
              onDone(created.principal);
            }}
            disabled={acknowledged}
          >
            {t('我已复制', "I've copied it — Done")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <form
      className="stack"
      onSubmit={(event) => void handleSubmit(event)}
      noValidate
      data-testid="create-principal-form"
    >
      <Notice>
        {t(
          <>
            创建的是 <code className="mono">kind: 'service'</code> Principal —— 脚本与验收工具用的
            自动化凭证，不是人；添加人请用「添加成员」。
          </>,
          <>
            Creates a <code className="mono">kind: 'service'</code> Principal — an automation
            credential for scripts and harnesses, never a person. Add a person with Add member.
          </>,
        )}
      </Notice>

      <Field id="cp-name" label={t('显示名', 'Display name')} required>
        <input
          id="cp-name"
          className="input"
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
          disabled={submitting}
        />
      </Field>

      <Field
        id="cp-role"
        label={t('角色', 'Role')}
        required
        hint={t('之后可在成员行里修改。', "Can be changed later from the member's row.")}
      >
        <Select
          id="cp-role"
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

      {error !== null ? (
        <ErrorBanner
          error={error}
          title={t('无法创建', 'Could not create this service credential')}
        />
      ) : null}

      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <Button variant="ghost" onClick={onCancel} disabled={submitting}>
          {t('取消', 'Cancel')}
        </Button>
        <Button
          type="submit"
          variant="primary"
          aria-busy={submitting}
          disabled={!displayName.trim()}
        >
          {t('创建', 'Create')}
        </Button>
      </div>
    </form>
  );
}
