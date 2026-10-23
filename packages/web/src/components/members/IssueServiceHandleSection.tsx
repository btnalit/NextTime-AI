import { type Capability, getCapability, listByChannel } from '@nexttime/shared';
import { useMemo, useState } from 'react';
import { capabilityModeLabel } from '../../lib/catalog-pickers.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import type { PrincipalRow } from '../../lib/governance.js';
import {
  SECONDS_PER_DAY,
  SERVICE_HANDLE_TTL_PRESET_DAYS,
  ttlDaysLabel,
  ttlPresetDaysWithin,
} from '../../lib/handle-ttl.js';
import { useT } from '../../lib/i18n.js';
import { sameNameIds, withSameNameId } from '../../lib/same-name.js';
import { Button } from '../kit/button.js';
import { Combobox } from '../kit/combobox.js';
import { CopyButton } from '../kit/copy-button.js';
import { Field, describedBy } from '../kit/field.js';
import { Notice } from '../kit/notice.js';
import { Select } from '../kit/select.js';
import { StillNeeded } from '../kit/still-needed.js';
import { PlatformError } from '../platform/PlatformError.js';

/** The registry's own ceiling (`issue_service_handle.ttlSeconds` `.max(...)`, one year) read
 *  from the Zod schema so this page cannot drift from the kernel; the literal is only the
 *  fallback if the schema shape ever changes (`serviceHandleMaxTtlSeconds` is unit-tested). */
const FALLBACK_MAX_TTL_SECONDS = 365 * SECONDS_PER_DAY;

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
 * `request_action` / `observe_operation`), and minus what is made only for a person
 * (`actsForPerson`, S11 GO5c: `propose_goal` — the kernel leaves it out of a service Handle).
 * Grouped by registry group for the checklist.
 */
export function handleScopeCapabilities(): readonly Capability[] {
  return listByChannel('handle').filter(
    (capability) => !capability.name.includes('<') && !capability.actsForPerson,
  );
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
  /** Every principal this workspace has (`MembersPage`'s own `list_principals` read) — filtered
   *  here to active `kind: 'service'` ones, the only Principal `issue_service_handle` accepts. */
  readonly principals: readonly PrincipalRow[];
  /** Fires once the reader has acknowledged the one-time Handle (`CreatePrincipalForm`'s own
   *  `onDone` precedent) — `MembersPage` closes the drawer this renders inside. */
  readonly onDone: () => void;
  /** Opens the "create a service account" flow — offered right in the notice when there is no
   *  service account yet, instead of pointing at a menu elsewhere on the page (#559 acceptance). */
  readonly onCreateServiceAccount?: () => void;
}

function parseNames(raw: string): readonly string[] {
  return Array.from(new Set(raw.split(/[\s,]+/).filter((name) => name.length > 0)));
}

/** Text typed / pasted into the name box is a list (taken in one go) rather than a search once it
 *  holds a separator after a name: "a b", "a,b" or "a " (a finished name). */
export function isNameList(raw: string): boolean {
  const names = parseNames(raw);
  return names.length > 1 || (names.length === 1 && /[\s,]$/.test(raw));
}

/**
 * components/members/IssueServiceHandleSection (console redesign P3-4 part B, on
 * `components/kit/*` only): "签发外部运行时凭证 Issue a service Handle" (`MembersPage`, P-B1,
 * design §6.3 "外部运行时") — `issue_service_handle{principalId, scope, ttlSeconds?}`, the
 * console-side alternative to the `issue-service-handle` CLI. Screenshot review of #305 (D3) moved
 * this behind a header button + `kit/sheet` — the full form (principal picker, TTL, the whole
 * capability tree) was too heavy to render inline under the member list. `MembersPage` owns the
 * one `Sheet`; this component renders only its body and swaps between the form and the
 * issued-result view itself (the `CreatePrincipalForm`/`created` precedent, right below it in
 * `MembersPage`'s own drawer stack) rather than opening a second, nested sheet for the result —
 * two open focus traps would fight each other, the same reasoning `TemporaryPasswordDialog`'s own
 * doc comment gives for never showing two one-time-secret dialogs at once.
 *
 * B7 (§2 B7, §5.6): the TTL defaults to 30 days under the registry's one-year cap, and the scope is
 * picked from the registry's handle-channel names (`handleScopeCapabilities`) — a checklist plus
 * a searchable name box (console-ux-3: picks instead of free text) that also takes a pasted list
 * copied from a runbook, validated against the same set, so a human-only
 * capability (or a typo) is refused here with the reason instead of by the kernel's 400.
 */
export function IssueServiceHandleSection({
  http,
  principals,
  onDone,
  onCreateServiceAccount,
}: IssueServiceHandleSectionProps) {
  const t = useT();
  // S8 W4 (leftover 88 "内部服务主体...会列出它们，可以给内部主体签 Handle"): the platform's own
  // internal service principals (`__gatekeeper_service__`, `__draft_reaper__`) never authenticate
  // as an external runtime — they never appear in this picker.
  const servicePrincipals = principals.filter(
    (principal) => principal.kind === 'service' && !principal.disabledAt && !principal.internal,
  );
  const serviceSame = sameNameIds(
    servicePrincipals,
    (p) => p.id,
    (p) => p.displayName,
  );
  const ttlPresets = ttlPresetDaysWithin(
    SERVICE_HANDLE_TTL_PRESET_DAYS,
    serviceHandleMaxTtlSeconds(),
  );
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

  const [chosenPrincipalId, setPrincipalId] = useState('');
  // console-ux-3: with exactly one service principal there is nothing to choose — it is selected.
  const onlyPrincipal = servicePrincipals.length === 1 ? servicePrincipals[0] : undefined;
  const principalId = chosenPrincipalId || (onlyPrincipal?.id ?? '');
  // Legacy 168 ②: picked from presets, the shortest by default (was 30 days, typed).
  const [ttlDays, setTtlDays] = useState(ttlPresets[0] ?? 1);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  /** The name box's text: a search over the handle-channel names, or a pasted list. */
  const [nameText, setNameText] = useState('');
  /** Names from the last pasted list that are not issuable (kept in the box, block submit). */
  const [unknownPasted, setUnknownPasted] = useState<readonly string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown | null>(null);
  const [issued, setIssued] = useState<IssueServiceHandleResult | null>(null);

  const scope = Array.from(picked);
  const canSubmit =
    principalId !== '' && scope.length > 0 && unknownPasted.length === 0 && !submitting;
  // Audit P1-9: a disabled 签发 says what it still waits for (the form's own label words).
  const missing = [
    principalId !== ''
      ? null
      : servicePrincipals.length === 0
        ? t('先创建服务账号', 'create a service account first')
        : t('选择服务账号', 'pick a service account'),
    scope.length > 0 ? null : t('勾选能力', 'tick at least one capability'),
    unknownPasted.length === 0
      ? null
      : t('去掉不可签发的能力名', 'remove the names that cannot be issued'),
  ].filter((item): item is string => item !== null);

  const readOnlyNames = catalog
    .filter((capability) => capability.mode === 'observe')
    .map((capability) => capability.name);

  function add(names: readonly string[]): void {
    if (names.length === 0) return;
    setPicked((current) => new Set([...current, ...names]));
  }

  /** A typed search just filters; a pasted / finished list is taken at once — issuable names are
   *  ticked, the rest stay in the box with the reason. */
  function typeNames(text: string): void {
    if (!isNameList(text)) {
      setNameText(text);
      setUnknownPasted([]);
      return;
    }
    const names = parseNames(text);
    add(names.filter((name) => allowed.has(name)));
    const unknown = names.filter((name) => !allowed.has(name));
    setUnknownPasted(unknown);
    setNameText(unknown.join(' '));
  }

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
          ttlSeconds: ttlDays * SECONDS_PER_DAY,
        }),
      );
    } catch (err) {
      setError(err);
    } finally {
      setSubmitting(false);
    }
  }

  // The result view replaces the form entirely (the `CreatePrincipalForm`/`created` precedent) —
  // no second, nested sheet: `MembersPage`'s one `Sheet` around this component is the only one.
  if (issued) {
    return (
      <div className="stack" data-testid="issued-handle-dialog">
        <p className="text-3 text-small">
          {t('会话', 'Session')}{' '}
          <span className="mono" data-testid="issued-handle-session-id">
            {issued.sessionId}
          </span>
        </p>
        <Notice tone="warn">
          {t(
            '只显示这一次，控制台不会保存它；复制后交给要用它的运行时。',
            'Shown once — the console never stores it; copy it now and hand it to the runtime that will use it.',
          )}
        </Notice>
        <div className="code-block row" style={{ justifyContent: 'space-between' }}>
          <span className="mono" data-testid="issued-handle-token">
            {issued.handle}
          </span>
          <CopyButton value={issued.handle} label="Handle" />
        </div>
        <div className="row overlay-actions" style={{ justifyContent: 'flex-end' }}>
          <Button variant="primary" onClick={onDone}>
            {t('我已保存', 'I have saved it')}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="stack" data-testid="issue-service-handle-section">
      {servicePrincipals.length === 0 ? (
        <Notice testId="issue-service-handle-no-principal">
          <span className="row-wrap">
            <span>
              {onCreateServiceAccount
                ? t(
                    '还没有服务账号。先创建一个，再回来签发。',
                    'No service account yet. Create one first, then come back to issue.',
                  )
                : t(
                    '还没有服务账号。先在「成员与授权」页右上角的「更多操作 → 服务凭证」里创建一个。',
                    'No service account yet. Create one first under Members → More actions → Service credential.',
                  )}
            </span>
            {onCreateServiceAccount ? (
              <Button
                variant="secondary"
                size="s"
                onClick={onCreateServiceAccount}
                data-testid="issue-service-handle-create-account"
              >
                {t('创建服务账号', 'Create a service account')}
              </Button>
            ) : null}
          </span>
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
        <Field
          id="ish-principal"
          label={t('服务账号', 'Service account')}
          required
          hint={
            onlyPrincipal
              ? t(
                  '工作区只有这一个服务账号，已自动选中。',
                  'The only service account in this workspace — selected for you.',
                )
              : undefined
          }
        >
          <Select
            id="ish-principal"
            aria-label={t('服务账号', 'Service account')}
            className="select-fit"
            value={principalId}
            onChange={(event) => setPrincipalId(event.target.value)}
            disabled={submitting || servicePrincipals.length === 0}
          >
            <option value="">{t('选择', 'Pick one')}</option>
            {servicePrincipals.map((principal) => (
              <option key={principal.id} value={principal.id}>
                {withSameNameId(principal.displayName, principal.id, serviceSame)}
              </option>
            ))}
          </Select>
        </Field>

        <Field
          id="ish-ttl"
          label={t('有效期', 'Valid for')}
          hint={t(
            '到期后要重新签发。运行时用多久选多久，越短越安全。',
            'Issue a new one after it expires. Pick only as long as the runtime needs; shorter is safer.',
          )}
        >
          <Select
            id="ish-ttl"
            aria-label={t('有效期', 'Valid for')}
            className="select-fit"
            value={String(ttlDays)}
            onChange={(event) => setTtlDays(Number(event.target.value))}
            disabled={submitting}
          >
            {ttlPresets.map((days) => (
              <option key={days} value={days}>
                {ttlDaysLabel(days, t)}
              </option>
            ))}
          </Select>
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
                '这里只列出允许服务 Handle 使用的能力；成员管理与平台能力永远不在此列。',
                'Only capabilities a service Handle may hold are listed; member-management and platform ones are never offered.',
              )}
            </span>
          </legend>
          {/* AX1 "能力勾选是页内嵌套滚动框": grouped `<details>` instead of a fixed-height scroll
           *  box — a reader opens the group they need rather than scrolling a tiny inner viewport. */}
          {/* field-inventory #4: the common starting point — every read-only capability — in one
           *  click. Write / execute ones are always ticked one by one: a long-lived Handle should
           *  not gain a mutation by a bulk button. */}
          <div className="row-wrap" data-testid="ish-scope-presets">
            {/* ux-lint-allow-disabled: grey only once every read-only box is already ticked. */}
            <Button
              variant="ghost"
              size="s"
              onClick={() => add(readOnlyNames)}
              disabled={submitting || readOnlyNames.every((name) => picked.has(name))}
              data-testid="ish-preset-observe"
            >
              {t(
                `勾选全部只读能力（${readOnlyNames.length}）`,
                `Tick every read-only capability (${readOnlyNames.length})`,
              )}
            </Button>
            {/* ux-lint-allow-disabled: grey only while nothing is ticked. */}
            <Button
              variant="ghost"
              size="s"
              onClick={() => setPicked(new Set())}
              disabled={submitting || picked.size === 0}
              data-testid="ish-preset-clear"
            >
              {t('全部取消', 'Clear all')}
            </Button>
          </div>
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
                      <span className="text-3 text-small">
                        {capabilityModeLabel(capability.mode, t)}
                      </span>
                    </label>
                  ))}
                </div>
              </details>
            ))}
          </div>
        </fieldset>

        <Field
          id="ish-scope"
          label={t('查找或粘贴能力名', 'Find or paste capability names')}
          hint={t(
            '输入以搜索，回车或点击加入；也可粘贴运行手册里的一串能力名（逗号或空格分隔），会一次勾选。',
            'Type to search, then Enter or click to add — or paste names from a runbook (comma- or space-separated) to tick them all at once.',
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
          <Combobox
            id="ish-scope"
            options={catalog
              .filter((capability) => !picked.has(capability.name))
              .map((capability) => ({
                value: capability.name,
                label: capability.name,
                secondary: `${capability.group} · ${capabilityModeLabel(capability.mode, t)}`,
              }))}
            value=""
            onChange={(name) => {
              if (name !== '') add([name]);
            }}
            inputValue={nameText}
            onInputValueChange={typeNames}
            disabled={submitting}
            invalid={unknownPasted.length > 0}
            clearable={false}
            mono
            aria-describedby={describedBy('ish-scope', true, unknownPasted.length > 0)}
            placeholder="get_task report_task_result"
            emptyText={t(
              '没有匹配的可签发能力（或已全部勾选）。',
              'No matching issuable capability (or all are ticked).',
            )}
            testId="ish-scope"
          />
        </Field>

        <p className="text-3 text-small" data-testid="ish-scope-summary">
          {t(
            `将签发 ${scope.length} 个能力${scope.length > 0 ? `：${scope.join(', ')}` : ''}`,
            `${scope.length} capabilities in scope${scope.length > 0 ? `: ${scope.join(', ')}` : ''}`,
          )}
        </p>

        <PlatformError error={error} title={t('无法签发', 'Could not issue the Handle')} />

        <div className="row overlay-actions" style={{ justifyContent: 'flex-end' }}>
          <StillNeeded items={missing} hidden={submitting} testId="ish-missing" />
          <Button type="submit" variant="primary" aria-busy={submitting} disabled={!canSubmit}>
            {t('签发', 'Issue')}
          </Button>
        </div>
      </form>
    </div>
  );
}
