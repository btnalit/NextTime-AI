import { useState } from 'react';
import type { CapabilityCaller } from '../lib/clients.js';
import type { PrincipalRow } from '../lib/governance.js';
import { hrefs } from '../lib/router.js';
import { PlatformError } from './platform/PlatformError.js';
import { Button } from './ui/Button.js';
import { CopyId } from './ui/CopyId.js';
import { Drawer } from './ui/Drawer.js';
import { Field, Input, Select } from './ui/Field.js';
import { Notice } from './ui/Notice.js';

const MAX_TTL_DAYS = 365;
const DEFAULT_TTL_DAYS = 365;

/** `issue_service_handle`'s result — an inline `capabilities.ts` schema with no `wire/*.ts`
 *  counterpart, so it is redefined locally (the `lib/governance.ts` precedent). */
interface IssueServiceHandleResult {
  readonly handle: string;
  readonly principalId: string;
  readonly sessionId: string;
  readonly expiresAt: string;
  readonly scope: readonly string[];
}

export interface IssueServiceHandleSectionProps {
  readonly http: CapabilityCaller;
  /** Every principal this workspace has (`AccessPage`'s own `list_principals` read) — filtered
   *  here to active `kind: 'service'` ones, the only Principal `issue_service_handle` accepts. */
  readonly principals: readonly PrincipalRow[];
}

function parseScope(raw: string): readonly string[] {
  return Array.from(new Set(raw.split(/[\s,]+/).filter((name) => name.length > 0)));
}

/**
 * components/IssueServiceHandleSection: "签发外部运行时凭证 Issue a service Handle" (`AccessPage`,
 * P-B1, design §6.3 "外部运行时") — `issue_service_handle{principalId, scope, ttlSeconds?}`, the
 * console-side alternative to the `issue-service-handle` CLI. Inline on the page (not a `Drawer`)
 * because `AccessPage` already opens one for "Grant capability" — two open focus traps would fight
 * each other, the same reasoning `TemporaryPasswordDialog`'s own doc comment gives for never
 * showing two one-time-secret dialogs at once. Only the resulting Handle — shown exactly once,
 * like `TemporaryPasswordDialog`'s password — opens in a `Drawer`.
 */
export function IssueServiceHandleSection({ http, principals }: IssueServiceHandleSectionProps) {
  const servicePrincipals = principals.filter(
    (principal) => principal.kind === 'service' && !principal.disabledAt,
  );

  const [principalId, setPrincipalId] = useState('');
  const [ttlDays, setTtlDays] = useState(String(DEFAULT_TTL_DAYS));
  const [scopeText, setScopeText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown | null>(null);
  const [issued, setIssued] = useState<IssueServiceHandleResult | null>(null);

  const scope = parseScope(scopeText);
  const ttlValid =
    /^\d+$/.test(ttlDays.trim()) && Number(ttlDays) >= 1 && Number(ttlDays) <= MAX_TTL_DAYS;
  const canSubmit = principalId !== '' && scope.length > 0 && ttlValid && !submitting;

  async function submit(): Promise<void> {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      setIssued(
        await http.call<IssueServiceHandleResult>('issue_service_handle', {
          principalId,
          scope,
          ttlSeconds: Number(ttlDays) * 86400,
        }),
      );
    } catch (err) {
      setError(err);
    } finally {
      setSubmitting(false);
    }
  }

  function closeIssued(): void {
    setIssued(null);
    setScopeText('');
  }

  return (
    <section
      className="section"
      aria-labelledby="issue-service-handle-title"
      data-testid="issue-service-handle-section"
    >
      <div className="section-header">
        <h2 id="issue-service-handle-title">签发外部运行时凭证 Issue a service Handle</h2>
      </div>

      {servicePrincipals.length === 0 ? (
        <Notice testId="issue-service-handle-no-principal">
          还没有 service Principal — 先在<a href={hrefs.members()}>成员与授权</a>创建一个。 No
          service Principal yet — create one on 成员与授权 Members first.
        </Notice>
      ) : null}

      <form
        className="stack"
        data-testid="issue-service-handle-form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Field id="ish-principal" label="Service principal" required>
          <Select
            id="ish-principal"
            value={principalId}
            onChange={(event) => setPrincipalId(event.target.value)}
            disabled={submitting || servicePrincipals.length === 0}
          >
            <option value="">选择 Pick one</option>
            {servicePrincipals.map((principal) => (
              <option key={principal.id} value={principal.id}>
                {principal.displayName}
              </option>
            ))}
          </Select>
        </Field>

        <Field
          id="ish-ttl"
          label="有效期（天）TTL (days)"
          hint={`默认 ${DEFAULT_TTL_DAYS}，最多 ${MAX_TTL_DAYS} Default ${DEFAULT_TTL_DAYS}, max ${MAX_TTL_DAYS}`}
          error={ttlValid ? null : '必须是 1 到 365 的整数 Must be an integer from 1 to 365'}
        >
          <Input
            id="ish-ttl"
            value={ttlDays}
            onChange={(event) => setTtlDays(event.target.value)}
            disabled={submitting}
            invalid={!ttlValid}
            inputMode="numeric"
            mono
          />
        </Field>

        <Field
          id="ish-scope"
          label="能力 Capabilities"
          required
          hint="用逗号或空格分隔的能力名。 Comma- or space-separated capability names."
        >
          <Input
            id="ish-scope"
            value={scopeText}
            onChange={(event) => setScopeText(event.target.value)}
            disabled={submitting}
            placeholder="list_gatekeepers get_gatekeeper"
            mono
          />
        </Field>

        <PlatformError error={error} title="无法签发 Could not issue the Handle" />

        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <Button type="submit" variant="primary" loading={submitting} disabled={!canSubmit}>
            签发 Issue
          </Button>
        </div>
      </form>

      {issued ? (
        <Drawer
          open
          onClose={closeIssued}
          title="外部运行时凭证 Service Handle"
          subtitle={<span className="mono">{issued.sessionId}</span>}
          testId="issued-handle-dialog"
        >
          <div className="stack">
            <Notice tone="warn">
              只显示这一次，控制台不会保存它；复制后交给要用它的运行时。 Shown once — the console
              never stores it; copy it now and hand it to the runtime that will use it.
            </Notice>
            <div className="code-block row" style={{ justifyContent: 'space-between' }}>
              <span className="mono" data-testid="issued-handle-token">
                {issued.handle}
              </span>
              <CopyId id={issued.handle} label="Handle" full />
            </div>
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <Button variant="primary" onClick={closeIssued}>
                我已保存 I have saved it
              </Button>
            </div>
          </div>
        </Drawer>
      ) : null}
    </section>
  );
}
