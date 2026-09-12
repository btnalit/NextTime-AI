import type { GateHostTokenWire } from '@nexttime/shared';
import { type ReactNode, useEffect, useId, useState } from 'react';
import { postGateCredential } from '../../lib/gate-host.js';
import { Button } from '../ui/Button.js';
import { Field, Input, Textarea } from '../ui/Field.js';
import { Notice } from '../ui/Notice.js';
import { PlatformError } from './PlatformError.js';

export interface GateCredentialEntryProps {
  /** Mints the 5-minute token — `issue_gate_host_token{gateId}` on the 集成 page (shared credential,
   *  administrator), `issue_gate_credential_token{gateId}` on 系统接入 (connected_account,
   *  per-member). A 409 (e.g. `credential_mode_mismatch`) surfaces inline and leaves this idle. */
  readonly requestToken: () => Promise<GateHostTokenWire>;
  /** The button that starts the flow — on 集成 it only fetches the token ("获取 5 分钟令牌"); on
   *  系统接入 the click *is* the capability call ("录入我的凭证"). Either way the button becomes the
   *  countdown once a token comes back. */
  readonly tokenButtonLabel: ReactNode;
}

type Phase =
  | { readonly kind: 'idle' }
  | { readonly kind: 'ready'; readonly tokenResult: GateHostTokenWire }
  | { readonly kind: 'stored' };

function formatCountdown(secondsLeft: number): string {
  const minutes = Math.floor(secondsLeft / 60);
  const seconds = secondsLeft % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/**
 * components/platform/GateCredentialEntry: P-B2a 决定 ⑩'s browser → gate-host half, shared by
 * `GateInstanceDetailPanel` (管理员, `shared` credential) and `AvailableGateInstancesSection`
 * (成员, `connected_account` credential — every linked-instance row gets one; a 409
 * `credential_mode_mismatch` there just means the instance is not per-member, shown inline rather
 * than hidden, since `AvailableGateInstanceWire` carries no `definition` to gate the button on).
 * The only difference between the two call sites is which capability mints the token
 * (`requestToken`) and the button's label — the token shape, the countdown, the credential form
 * and the POST (`lib/gate-host.ts`) are identical either way.
 *
 * Never logs or persists the token or the credential: both live only in this component's own
 * state, and every field (plus the token itself) is dropped the instant the gate host confirms
 * `stored` (`clearFields` below) — a re-render after that shows only the success notice.
 */
export function GateCredentialEntry({ requestToken, tokenButtonLabel }: GateCredentialEntryProps) {
  // Unique per mount: `AvailableGateInstancesSection` renders one of these per linked row, so a
  // hardcoded id would make every row's label point at the first row's input.
  const domId = useId();
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [requesting, setRequesting] = useState(false);
  const [requestError, setRequestError] = useState<unknown | null>(null);

  const [advanced, setAdvanced] = useState(false);
  const [bearerToken, setBearerToken] = useState('');
  const [rawJson, setRawJson] = useState('');
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<unknown | null>(null);

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (phase.kind !== 'ready') return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [phase.kind]);

  function clearFields(): void {
    setBearerToken('');
    setRawJson('');
    setJsonError(null);
    setAdvanced(false);
  }

  async function getToken(): Promise<void> {
    if (requesting) return;
    setRequesting(true);
    setRequestError(null);
    try {
      const tokenResult = await requestToken();
      setNow(Date.now());
      setPhase({ kind: 'ready', tokenResult });
    } catch (err) {
      setRequestError(err);
    } finally {
      setRequesting(false);
    }
  }

  async function submit(): Promise<void> {
    if (phase.kind !== 'ready' || submitting) return;
    let credential: Record<string, unknown>;
    if (advanced) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawJson);
      } catch {
        setJsonError('不是合法的 JSON Not valid JSON');
        return;
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        setJsonError('必须是一个 JSON 对象 Must be a JSON object');
        return;
      }
      credential = parsed as Record<string, unknown>;
    } else {
      if (bearerToken.trim().length === 0) return;
      credential = { token: bearerToken.trim() };
    }
    setJsonError(null);
    setSubmitting(true);
    setSubmitError(null);
    try {
      await postGateCredential(phase.tokenResult, credential);
      clearFields();
      setPhase({ kind: 'stored' });
    } catch (err) {
      setSubmitError(err);
    } finally {
      setSubmitting(false);
    }
  }

  if (phase.kind === 'stored') {
    return (
      <div className="stack-s">
        <Notice testId="gate-credential-stored">
          已存入门宿主（内核未经手） Stored on the gate host — the kernel never saw it.
        </Notice>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <Button variant="ghost" size="s" onClick={() => setPhase({ kind: 'idle' })}>
            再录入一份 Enter another
          </Button>
        </div>
      </div>
    );
  }

  if (phase.kind === 'idle') {
    return (
      <div className="stack-s">
        <Button
          variant="secondary"
          size="s"
          icon="key"
          onClick={() => void getToken()}
          loading={requesting}
          data-testid="gate-credential-token-button"
        >
          {tokenButtonLabel}
        </Button>
        <PlatformError
          error={requestError}
          title="无法获取令牌 Could not get a token"
          testId="gate-credential-token-error"
        />
      </div>
    );
  }

  const secondsLeft = Math.max(
    0,
    Math.round((new Date(phase.tokenResult.expiresAt).getTime() - now) / 1000),
  );
  const expired = secondsLeft <= 0;

  return (
    <div className="stack-s">
      <Notice tone={expired ? 'warn' : 'info'}>
        {expired
          ? '令牌已过期，请重新获取 The token expired — get a new one.'
          : `令牌 ${formatCountdown(secondsLeft)} 后过期 Token expires in ${formatCountdown(secondsLeft)}`}
      </Notice>

      {expired ? (
        <Button variant="secondary" size="s" onClick={() => void getToken()} loading={requesting}>
          重新获取 Get a new token
        </Button>
      ) : (
        <>
          {!advanced ? (
            <Field id={`${domId}-token`} label="Bearer token">
              <Input
                id={`${domId}-token`}
                type="password"
                autoComplete="off"
                value={bearerToken}
                onChange={(event) => setBearerToken(event.target.value)}
                disabled={submitting}
                data-testid="gate-credential-token-input"
              />
            </Field>
          ) : (
            <Field
              id={`${domId}-json`}
              label="原始 JSON Raw JSON"
              error={jsonError ?? undefined}
              hint='任意凭证对象，例如 {"apiKey": "..."} Any credential object.'
            >
              <Textarea
                id={`${domId}-json`}
                mono
                rows={4}
                value={rawJson}
                onChange={(event) => setRawJson(event.target.value)}
                disabled={submitting}
                data-testid="gate-credential-json-input"
              />
            </Field>
          )}
          <label className="checkbox">
            <input
              type="checkbox"
              checked={advanced}
              onChange={(event) => setAdvanced(event.target.checked)}
              disabled={submitting}
            />
            <span>高级：原始 JSON Advanced: raw JSON</span>
          </label>

          <PlatformError
            error={submitError}
            title="无法存入门宿主 Could not store this on the gate host"
            testId="gate-credential-submit-error"
          />
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <Button
              variant="primary"
              size="s"
              onClick={() => void submit()}
              loading={submitting}
              disabled={!advanced && bearerToken.trim().length === 0}
              data-testid="gate-credential-submit"
            >
              存入 Submit
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
