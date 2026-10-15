import { type FormEvent, useState } from 'react';
import type { CapabilityCaller } from '../lib/clients.js';
import { CONNECTION_KIND_VALUES, type ConnectionKind } from '../lib/connections.js';
import { presentError } from '../lib/errors.js';
import { useT } from '../lib/i18n.js';
import { ErrorDetails } from './kit/error-details.js';
import { Button } from './ui/Button.js';
import { ErrorBanner } from './ui/ErrorBanner.js';
import { Field, Input, Select, describedBy } from './ui/Field.js';

export interface RequestConnectionFormProps {
  readonly http: CapabilityCaller;
  readonly onDone: (result: { id: string; status: string }) => void;
  readonly onCancel: () => void;
}

/** components/RequestConnectionForm: `request_connection {kind, target}` — proposes a connection
 *  for the owner to complete later (the card an agent would otherwise raise from a chat). A target
 *  the kernel refuses for carrying a credential (legacy 186) is said on the target field, in this
 *  form's terms — a request has no credential field; the owner configures it when completing —
 *  with the kernel's own text in the field's collapsed 「技术细节」 (review of #549). */
export function RequestConnectionForm({ http, onDone, onCancel }: RequestConnectionFormProps) {
  const t = useT();
  const [kind, setKind] = useState<ConnectionKind>('http');
  const [target, setTarget] = useState('');
  const [error, setError] = useState<unknown | null>(null);
  /** A `credentials_in_connection_params` refusal, shown on the target field instead of the banner. */
  const [targetRefusal, setTargetRefusal] = useState<unknown | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const targetError = target.trim() ? null : t('目标是必填项。', 'Target is required.');
  const [touched, setTouched] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setTouched(true);
    if (targetError) return;
    setSubmitting(true);
    setError(null);
    setTargetRefusal(null);
    try {
      const result = await http.call<{ id: string; status: string }>('request_connection', {
        kind,
        target: target.trim(),
      });
      onDone(result);
    } catch (err) {
      if (presentError(err, t).code === 'credentials_in_connection_params') setTargetRefusal(err);
      else setError(err);
    } finally {
      setSubmitting(false);
    }
  }

  const refused = targetRefusal !== null ? presentError(targetRefusal, t) : null;
  const targetMessage = refused
    ? t(
        '目标系统里带了凭据（URL 里的密码、token 或 key），已拒绝，没有创建申请。目标系统里只写地址或名称；凭据不在申请里填，由所有者完成连接时配置在门上。',
        'The target system carries a credential (a URL password, a token or a key) — refused, no request was created. Enter only its address or name; a request takes no credential, the owner configures it on the gate when completing the connection.',
      )
    : touched
      ? targetError
      : null;

  return (
    <form className="stack" onSubmit={(event) => void handleSubmit(event)} noValidate>
      <Field id="rc-kind" label={t('类型', 'Kind')} required>
        <Select
          id="rc-kind"
          value={kind}
          onChange={(event) => setKind(event.target.value as ConnectionKind)}
          disabled={submitting}
        >
          {CONNECTION_KIND_VALUES.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </Select>
      </Field>
      <Field
        id="rc-target"
        label={t('目标系统', 'Target system')}
        required
        error={targetMessage}
        errorDetails={
          refused ? (
            <ErrorDetails code={refused.code} raw={refused.raw} testId="rc-target-error" />
          ) : null
        }
      >
        <Input
          id="rc-target"
          value={target}
          onChange={(event) => {
            setTarget(event.target.value);
            setTargetRefusal(null);
          }}
          onBlur={() => setTouched(true)}
          invalid={!!targetMessage}
          aria-describedby={describedBy('rc-target', false, !!targetMessage)}
          disabled={submitting}
          placeholder="https://erp.example.internal or a hostname"
          mono
        />
      </Field>
      {error !== null ? (
        <ErrorBanner error={error} title={t('无法创建申请', 'Could not create the request')} />
      ) : null}
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <Button variant="ghost" onClick={onCancel} disabled={submitting}>
          {t('取消', 'Cancel')}
        </Button>
        <Button type="submit" variant="primary" loading={submitting}>
          {t('申请连接', 'Request connection')}
        </Button>
      </div>
    </form>
  );
}
