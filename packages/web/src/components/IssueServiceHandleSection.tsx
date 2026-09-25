import { type Capability, getCapability, listByChannel } from '@nexttime/shared';
import { useMemo, useState } from 'react';
import type { CapabilityCaller } from '../lib/clients.js';
import type { PrincipalRow } from '../lib/governance.js';
import { useT } from '../lib/i18n.js';
import { hrefs } from '../lib/router.js';
import { DashboardCard } from './kit/section.js';
import { PlatformError } from './platform/PlatformError.js';
import { Button } from './ui/Button.js';
import { CopyId } from './ui/CopyId.js';
import { Drawer } from './ui/Drawer.js';
import { Field, Input, Select } from './ui/Field.js';
import { Notice } from './ui/Notice.js';

const SECONDS_PER_DAY = 86400;
/** The registry's own ceiling (`issue_service_handle.ttlSeconds` `.max(...)`, one year) read
 *  from the Zod schema so this page cannot drift from the kernel; the literal is only the
 *  fallback if the schema shape ever changes (`serviceHandleMaxTtlSeconds` is unit-tested). */
const FALLBACK_MAX_TTL_SECONDS = 365 * SECONDS_PER_DAY;
/** B7 (docs/console-completion-plan.md §5.6 "TTL 默认 30 天、上限 365"): the default sits well
 *  below the cap — a runtime credential that outlives its purpose by a year was the old default. */
const DEFAULT_TTL_DAYS = 30;

export function serviceHandleMaxTtlSeconds(): number {
  const schema = getCapability('issue_service_handle')?.paramsSchema as
    | {
        readonly shape?: {
          readonly ttlSeconds?: { readonly unwrap?: () => { readonly maxValue?: number | null } };
        };
      }
    | undefined;
  const max = schema?.shape?.ttlSeconds?.unwrap?.().maxValue;
  return typeof max === 'number' && max > 0 ? max : FALLBACK_MAX_TTL_SECONDS;
}

/**
 * B7: the capabilities a service Handle may carry — every `channel: 'handle'` registry entry
 * (`governance/capability/handles.ts` `assertValidScope` refuses anything else at issuance, and
 * `scripts/check-membership-capabilities-not-in-handle-scope.sh` guards the ceiling arrays the
 * same way), minus the two `<gate>.<op>` pattern rows, which are not names a scope can hold
 * (`assertValidScope` looks each name up verbatim; gate operations are reached through
 * `request_action` / `observe_operation`). Grouped by registry group for the checklist.
 */
export function handleScopeCapabilities(): readonly Capability[] {
  return listByChannel('handle').filter((capability) => !capability.name.includes('<'));
}

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

function parseNames(raw: string): readonly string[] {
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
 *
 * B7 (§2 B7, §5.6): the TTL defaults to 30 days under the registry's one-year cap, and the scope is
 * picked from the registry's handle-channel names (`handleScopeCapabilities`) — a checklist plus
 * a paste box for names copied from a runbook, validated against the same set, so a human-only
 * capability (or a typo) is refused here with the reason instead of by the kernel's 400.
 */
export function IssueServiceHandleSection({ http, principals }: IssueServiceHandleSectionProps) {
  const t = useT();
  // S8 W4 (leftover 88 "内部服务主体...会列出它们，可以给内部主体签 Handle"): the platform's own
  // internal service principals (`__gatekeeper_service__`, `__draft_reaper__`) never authenticate
  // as an external runtime — they never appear in this picker.
  const servicePrincipals = principals.filter(
    (principal) => principal.kind === 'service' && !principal.disabledAt && !principal.internal,
  );
  const maxTtlDays = Math.floor(serviceHandleMaxTtlSeconds() / SECONDS_PER_DAY);
  const catalog = useMemo(() => handleScopeCapabilities(), []);
  const allowed = useMemo(() => new Set(catalog.map((capability) => capability.name)), [catalog]);
  const groups = useMemo(() => {
    const byGroup = new Map<string, Capability[]>();
    for (const capability of catalog) {
      const list = byGroup.get(capability.group) ?? [];
      list.push(capability);
      byGroup.set(capability.group, list);
    }
    return [...byGroup.entries()];
  }, [catalog]);

  const [principalId, setPrincipalId] = useState('');
  const [ttlDays, setTtlDays] = useState(String(DEFAULT_TTL_DAYS));
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [pastedText, setPastedText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown | null>(null);
  const [issued, setIssued] = useState<IssueServiceHandleResult | null>(null);

  const pasted = parseNames(pastedText);
  const unknownPasted = pasted.filter((name) => !allowed.has(name));
  const scope = Array.from(new Set([...picked, ...pasted.filter((name) => allowed.has(name))]));
  const ttlValid =
    /^\d+$/.test(ttlDays.trim()) && Number(ttlDays) >= 1 && Number(ttlDays) <= maxTtlDays;
  const canSubmit =
    principalId !== '' && scope.length > 0 && unknownPasted.length === 0 && ttlValid && !submitting;

  function toggle(name: string): void {
    setPicked((current) => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  async function submit(): Promise<void> {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      setIssued(
        await http.call<IssueServiceHandleResult>('issue_service_handle', {
          principalId,
          scope,
          ttlSeconds: Number(ttlDays) * SECONDS_PER_DAY,
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
    setPicked(new Set());
    setPastedText('');
  }

  return (
    <DashboardCard
      title={t('签发外部运行时凭证', 'Issue a service Handle')}
      data-testid="issue-service-handle-section"
    >
      {servicePrincipals.length === 0 ? (
        <Notice testId="issue-service-handle-no-principal">
          {t('还没有 service Principal — 先在', 'No service Principal yet — first create one on ')}
          <a href={hrefs.members()}>{t('成员与授权', 'Members')}</a>
          {t('创建一个。', ' page.')}
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
        <Field id="ish-principal" label={t('服务主体', 'Service principal')} required>
          <Select
            id="ish-principal"
            value={principalId}
            onChange={(event) => setPrincipalId(event.target.value)}
            disabled={submitting || servicePrincipals.length === 0}
          >
            <option value="">{t('选择', 'Pick one')}</option>
            {servicePrincipals.map((principal) => (
              <option key={principal.id} value={principal.id}>
                {principal.displayName}
              </option>
            ))}
          </Select>
        </Field>

        <Field
          id="ish-ttl"
          label={t('有效期（天）', 'TTL (days)')}
          hint={t(
            `默认 ${DEFAULT_TTL_DAYS}，最多 ${maxTtlDays}`,
            `Default ${DEFAULT_TTL_DAYS}, max ${maxTtlDays}`,
          )}
          error={
            ttlValid
              ? null
              : t(`必须是 1 到 ${maxTtlDays} 的整数`, `Must be an integer from 1 to ${maxTtlDays}`)
          }
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

        <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
          {/* S8 W2-U1 (audit AX1 "标签与星号分离"): the label and its required asterisk are one
           *  unit now — the flex gap on `.field-label` used to sit *between* them because they
           *  were two separate flex children. */}
          <legend className="field-label">
            <span>
              {t('能力', 'Capabilities')}
              <span className="field-required" aria-hidden>
                *
              </span>
            </span>
            <span className="field-hint" style={{ margin: 0 }}>
              {t(
                '只有 handle 通道的能力可签给服务 Handle；成员管理与平台能力永远不在此列。',
                'Only handle-channel capabilities; member-management and platform ones are never offered.',
              )}
            </span>
          </legend>
          {/* AX1 "能力勾选是页内嵌套滚动框": grouped `<details>` instead of a fixed-height scroll
           *  box — a reader opens the group they need rather than scrolling a tiny inner viewport. */}
          <div className="stack-s" data-testid="ish-scope-checklist">
            {groups.map(([group, capabilities]) => (
              <details key={group}>
                <summary className="text-3 text-small">
                  {group} ({capabilities.length})
                </summary>
                <div className="stack-s" style={{ paddingTop: 8 }}>
                  {capabilities.map((capability) => (
                    <label
                      className="checkbox"
                      key={capability.name}
                      title={capability.description}
                    >
                      <input
                        type="checkbox"
                        checked={picked.has(capability.name)}
                        onChange={() => toggle(capability.name)}
                        disabled={submitting}
                        data-capability={capability.name}
                      />
                      <span className="mono">{capability.name}</span>
                      <span className="text-3 text-small">{capability.mode}</span>
                    </label>
                  ))}
                </div>
              </details>
            ))}
          </div>
        </fieldset>

        <Field
          id="ish-scope"
          label={t('粘贴能力名', 'Paste names')}
          hint={t(
            '从运行手册复制的能力名，逗号或空格分隔；与上面勾选的合并。',
            'Names copied from a runbook, comma- or space-separated; merged with the ticks above.',
          )}
          error={
            unknownPasted.length > 0
              ? t(
                  `不是可签发的能力名：${unknownPasted.join(', ')}`,
                  `Not issuable to a service Handle: ${unknownPasted.join(', ')}`,
                )
              : null
          }
        >
          <Input
            id="ish-scope"
            value={pastedText}
            onChange={(event) => setPastedText(event.target.value)}
            disabled={submitting}
            invalid={unknownPasted.length > 0}
            placeholder="get_task report_task_result"
            mono
          />
        </Field>

        <p className="text-3 text-small" data-testid="ish-scope-summary">
          将签发 {scope.length} 个能力 {scope.length} capabilities in scope
          {scope.length > 0 ? `: ${scope.join(', ')}` : ''}
        </p>

        <PlatformError error={error} title={t('无法签发', 'Could not issue the Handle')} />

        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <Button type="submit" variant="primary" loading={submitting} disabled={!canSubmit}>
            {t('签发', 'Issue')}
          </Button>
        </div>
      </form>

      {issued ? (
        <Drawer
          open
          onClose={closeIssued}
          title={t('外部运行时凭证', 'Service Handle')}
          subtitle={<span className="mono">{issued.sessionId}</span>}
          testId="issued-handle-dialog"
        >
          <div className="stack">
            <Notice tone="warn">
              {t(
                '只显示这一次，控制台不会保存它；复制后交给要用它的运行时。 Shown once —',
                'the console never stores it; copy it now and hand it to the runtime that will use it.',
              )}
            </Notice>
            <div className="code-block row" style={{ justifyContent: 'space-between' }}>
              <span className="mono" data-testid="issued-handle-token">
                {issued.handle}
              </span>
              <CopyId id={issued.handle} label="Handle" full />
            </div>
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <Button variant="primary" onClick={closeIssued}>
                {t('我已保存', 'I have saved it')}
              </Button>
            </div>
          </div>
        </Drawer>
      ) : null}
    </DashboardCard>
  );
}
