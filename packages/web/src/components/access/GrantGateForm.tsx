import type { OperationSummaryWire } from '@nexttime/shared';
import { type ReactNode, useMemo, useState } from 'react';
import { useCapabilityList } from '../../hooks/useCapability.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { describeError } from '../../lib/errors.js';
import type { GatekeeperListRow, GrantRow, PrincipalRow } from '../../lib/governance.js';
import { useT } from '../../lib/i18n.js';
import { roleLabel } from '../../lib/labels.js';
import { type StatusMachine, labelText, statusChipStyle } from '../../lib/status-tone.js';
import { Button } from '../kit/button.js';
import { Confirm } from '../kit/confirm.js';
import { RefChip } from '../kit/ref-chip.js';

export interface GrantGateFormProps {
  readonly http: CapabilityCaller;
  /** Opened from a system card: the gate is fixed, no picker renders for it, and no "全部门" toggle
   *  — the audit's own "pre-selected when opened from a card" (J6/SY2). Omitted (opened from the
   *  Access page): a member+multi-gate picker with an explicit "全部门" toggle. */
  readonly lockedGatekeeper?: { readonly id: string; readonly name: string };
  readonly onGranted: (grants: readonly GrantRow[]) => void;
  readonly onCancel?: () => void;
  readonly submitLabel?: string;
  readonly testId?: string;
}

/**
 * components/access/GrantGateForm (S8 W2-U1, audit J6/SY2/R5/U2/AX1): the one grant flow the
 * Access page's primary action and every system card's own action open (`GrantGateDrawer` wraps
 * this in a `kit/sheet`; the launcher's step 3 embeds it inline, locked to the gate it just
 * enabled). Replaces `GrantCapabilityForm`'s free-text `resourceId`/JSON `scope` fields (Access
 * page) and `RegisteredSystemsSection`'s in-card expanding form (a bare principal id/select) — a
 * member picker (`list_principals` with `q`), a gate picker (`list_gatekeepers` with `q`,
 * multi-select, hidden entirely when `lockedGatekeeper` is given), and — only while the grant
 * targets exactly one gate — a read-only list of that gate's Operations the grant will cover
 * (`list_operations{gatekeeperId}`). No id or JSON is ever shown as an editable field: everything
 * submitted comes from a picked row.
 *
 * "全部门" (every gate, including ones registered later) is a distinct, explicit choice — ticking
 * it clears any gate selection and opens a `medium` confirm before it takes effect (J6: "「全部门」
 * 必须显式选择并走确认"); nothing here fires `grant_capability` until the caller presses 授予.
 *
 * One `grant_capability` call per selected gate (the capability takes one `resourceId` at a time);
 * `resourceId` omitted entirely for the "全部门" case. `scope` is never sent: nothing in the kernel
 * enforces `capability_grants.scope` today (it is stored and echoed back, never read by any
 * authorization check), so a per-Operation checklist would be a control that narrows nothing. A
 * grant covers the whole gate, and the Operations list says so instead of offering a choice.
 *
 * `components/kit/*` boundary (S8 risk ①): this file may not import `components/ui/*`, so its own
 * field/notice/error-banner/status-chip rendering are small local replicas of the `ui/*`
 * equivalents over the same CSS classes / `lib/status-tone.ts` data — not a new dependency, just
 * no component-wrapper import.
 */
export function GrantGateForm({
  http,
  lockedGatekeeper,
  onGranted,
  onCancel,
  submitLabel,
  testId,
}: GrantGateFormProps) {
  const t = useT();

  // ---- Member picker -----------------------------------------------------------------------
  const [memberQuery, setMemberQuery] = useState('');
  const principals = useCapabilityList<PrincipalRow>(
    http,
    'list_principals',
    memberQuery.trim() ? { q: memberQuery.trim() } : {},
    { autoLoadAll: true },
  );
  const memberOptions =
    principals.state.status === 'ready'
      ? principals.state.data.items.filter((row) => row.kind === 'human' && !row.disabledAt)
      : [];
  const [principalId, setPrincipalId] = useState('');
  const selectedPrincipal = memberOptions.find((row) => row.id === principalId);

  // ---- Gate picker (hidden entirely when locked) -------------------------------------------
  const [gateQuery, setGateQuery] = useState('');
  const gatekeepers = useCapabilityList<GatekeeperListRow>(
    http,
    'list_gatekeepers',
    gateQuery.trim() ? { q: gateQuery.trim() } : {},
    { autoLoadAll: true, load: lockedGatekeeper ? async () => ({ items: [] }) : undefined },
  );
  const gateOptions = gatekeepers.state.status === 'ready' ? gatekeepers.state.data.items : [];
  const [selectedGateIds, setSelectedGateIds] = useState<ReadonlySet<string>>(new Set());
  const [allGates, setAllGates] = useState(false);
  const [allGatesConfirmOpen, setAllGatesConfirmOpen] = useState(false);

  function toggleGate(id: string): void {
    setAllGates(false);
    setSelectedGateIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // ---- Effective target(s) — drives the covered-Operations list --------------------------------
  const targetGateIds: readonly string[] = lockedGatekeeper
    ? [lockedGatekeeper.id]
    : allGates
      ? []
      : [...selectedGateIds];
  const singleTargetGateId = targetGateIds.length === 1 ? targetGateIds[0] : null;

  const operations = useCapabilityList<OperationSummaryWire>(
    http,
    'list_operations',
    singleTargetGateId ? { gatekeeperId: singleTargetGateId } : { gatekeeperId: '__none__' },
    { autoLoadAll: true, load: singleTargetGateId ? undefined : async () => ({ items: [] }) },
  );
  // `list_operations` returns every version (drafts and superseded ones too); a grant only ever
  // lets the entry agent request the published one.
  const operationOptions =
    singleTargetGateId && operations.state.status === 'ready'
      ? operations.state.data.items.filter((operation) => operation.status === 'published')
      : [];

  // ---- Submit -------------------------------------------------------------------------------
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown | null>(null);
  const [granted, setGranted] = useState<readonly GrantRow[]>([]);

  const canSubmit =
    principalId !== '' &&
    (lockedGatekeeper !== undefined || allGates || selectedGateIds.size > 0) &&
    !submitting;

  async function submit(): Promise<void> {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const results: GrantRow[] = [];
      if (allGates) {
        results.push(
          await http.call<GrantRow>('grant_capability', {
            principalId,
            resourceType: 'gatekeeper',
          }),
        );
      } else {
        // No `scope`: `capability_grants.scope` is stored but never enforced by any authorization
        // path, so offering an operations checklist would present a narrowing that does not exist
        // (a grant always covers the whole gate). The list below is shown read-only instead.
        for (const gatekeeperId of targetGateIds) {
          results.push(
            await http.call<GrantRow>('grant_capability', {
              principalId,
              resourceType: 'gatekeeper',
              resourceId: gatekeeperId,
            }),
          );
        }
      }
      setGranted((current) => [...current, ...results]);
      onGranted(results);
      // Reset for another grant in the same drawer session — keep the drawer open so multi-gate
      // and repeat grants (a common "add another member" flow) do not each re-open it.
      setPrincipalId('');
      setSelectedGateIds(new Set());
      setAllGates(false);
    } catch (err) {
      setError(err);
    } finally {
      setSubmitting(false);
    }
  }

  const selectedGateNames = useMemo(
    () => [...selectedGateIds].map((id) => gateOptions.find((row) => row.id === id)?.name ?? id),
    [selectedGateIds, gateOptions],
  );

  return (
    <div className="stack" data-testid={testId ?? 'grant-gate-form'}>
      <LocalField
        id="ggf-member-query"
        label={t('成员', 'Member')}
        required
        hint={t(
          '按名字搜索，从下方选择一位。',
          'Search by name, then pick one from the list below.',
        )}
      >
        <input
          id="ggf-member-query"
          className="input"
          value={memberQuery}
          onChange={(event) => setMemberQuery(event.target.value)}
          placeholder={t('搜索成员…', 'Search members…')}
          disabled={submitting}
        />
      </LocalField>
      <select
        id="ggf-member-select"
        className="select"
        aria-label={t('选择成员', 'Choose a member')}
        value={principalId}
        onChange={(event) => setPrincipalId(event.target.value)}
        disabled={submitting || memberOptions.length === 0}
        data-testid="ggf-member-select"
      >
        <option value="">
          {memberOptions.length === 0
            ? t('没有匹配的成员', 'No matching member')
            : t('— 选择 —', '— Choose —')}
        </option>
        {memberOptions.map((row) => (
          <option key={row.id} value={row.id}>
            {row.displayName} ({roleLabel(row.role, t)})
          </option>
        ))}
      </select>
      {selectedPrincipal ? (
        <RefChip
          kind="principal"
          id={selectedPrincipal.id}
          name={selectedPrincipal.displayName}
          size="s"
          testId="ggf-member-chip"
        />
      ) : null}

      {lockedGatekeeper ? (
        <LocalField id="ggf-locked-gate" label={t('门', 'Gatekeeper')}>
          <RefChip
            kind="gatekeeper"
            id={lockedGatekeeper.id}
            name={lockedGatekeeper.name}
            testId="ggf-locked-gate-chip"
          />
        </LocalField>
      ) : (
        <div className="stack-s" data-testid="ggf-gate-picker">
          <LocalField
            id="ggf-gate-query"
            label={t('门', 'Gatekeeper')}
            required
            hint={t(
              '可多选；或授予全部门（见下）。',
              'Pick one or more — or grant every gate below.',
            )}
          >
            <input
              id="ggf-gate-query"
              className="input"
              value={gateQuery}
              onChange={(event) => setGateQuery(event.target.value)}
              placeholder={t('搜索门…', 'Search gates…')}
              disabled={submitting || allGates}
            />
          </LocalField>
          <div className="stack-s" data-testid="ggf-gate-list">
            {gatekeepers.state.status === 'loading' ? (
              <p className="text-3 text-small">{t('正在加载…', 'Loading…')}</p>
            ) : gateOptions.length === 0 ? (
              <p className="text-3 text-small">{t('没有匹配的门。', 'No matching gate.')}</p>
            ) : (
              gateOptions.map((row) => (
                <label className="checkbox" key={row.id}>
                  <input
                    type="checkbox"
                    checked={selectedGateIds.has(row.id)}
                    onChange={() => toggleGate(row.id)}
                    disabled={submitting || allGates}
                    data-testid={`ggf-gate-${row.id}`}
                  />
                  <span>{row.name}</span>
                  <span className="text-3 text-small">{row.kind}</span>
                </label>
              ))
            )}
          </div>
          {selectedGateIds.size > 0 ? (
            <p className="text-3 text-small" data-testid="ggf-gate-selected-summary">
              {t(
                `已选 ${selectedGateIds.size} 个门：`,
                `${selectedGateIds.size} gate(s) selected: `,
              )}
              {selectedGateNames.join('、')}
            </p>
          ) : null}

          <Confirm
            tier="medium"
            open={allGatesConfirmOpen}
            onOpenChange={setAllGatesConfirmOpen}
            anchor={
              <label className="checkbox" data-testid="ggf-all-gates-toggle">
                <input
                  type="checkbox"
                  checked={allGates}
                  onChange={(event) => {
                    if (event.target.checked) setAllGatesConfirmOpen(true);
                    else setAllGates(false);
                  }}
                  disabled={submitting}
                  data-testid="ggf-all-gates-checkbox"
                />
                <span>{t('全部门（含未来新增）', 'Every gate, including ones added later')}</span>
              </label>
            }
            title={t('授予全部门', 'Grant every gate')}
            description={t(
              '该成员的入口 agent 将能调用工作区里的每一个门，包括以后新接入的门——不限于当前列表。',
              "This member's entry agent will be able to call every gate in this workspace, including gates connected later — not just the ones listed today.",
            )}
            confirmLabel={t('我确认，授予全部门', 'Confirm — grant every gate')}
            onConfirm={() => {
              setAllGates(true);
              setSelectedGateIds(new Set());
            }}
            testId="ggf-all-gates-confirm"
          />
        </div>
      )}

      {singleTargetGateId && !allGates ? (
        <div className="stack-s" data-testid="ggf-operations-scope">
          <span className="field-label">
            {t('授权覆盖的 Operation', 'Operations this grant covers')}
          </span>
          <p className="field-hint">
            {t(
              '授权针对整个门：成员的入口 agent 可以请求这个门的全部已发布 Operation（包括以后新发布的）；执行类仍按审批规则处理。',
              'A grant covers the whole gate: the member’s entry agent may request every published operation of this gate, including ones published later; execute-class ones still follow the approval rules.',
            )}
          </p>
          {operations.state.status === 'loading' ? (
            <p className="text-3 text-small">{t('正在加载…', 'Loading…')}</p>
          ) : operationOptions.length === 0 ? (
            <p className="text-3 text-small">
              {t('这个门还没有已发布的 Operation。', 'This gate has no published operations yet.')}
            </p>
          ) : (
            <ul
              className="stack-s"
              style={{ listStyle: 'none', margin: 0, padding: 0 }}
              data-testid="ggf-operations-list"
            >
              {operationOptions.map((operation) => (
                <li key={operation.name} className="row-wrap">
                  <span className="mono">{operation.name}</span>
                  <LocalStatusChip machine="operationMode" status={operation.mode} />
                  <LocalStatusChip machine="blastRadius" status={operation.blastRadius} />
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}

      {allGates ? (
        <LocalNotice tone="warn" testId="ggf-all-gates-notice">
          {t(
            '已选择「全部门」：成员可以请求本工作区每个门的全部 Operation，包括以后新接入的门；执行类仍按审批规则处理。',
            'Every gate is selected: the member may request every operation of every gate in this workspace, including gates connected later; execute-class ones still follow the approval rules.',
          )}
        </LocalNotice>
      ) : null}

      {granted.length > 0 ? (
        <LocalNotice testId="ggf-granted-summary">
          {t('本次已授予：', 'Granted so far: ')}
          {granted.length}
        </LocalNotice>
      ) : null}

      {error !== null ? (
        <LocalErrorBanner
          error={error}
          title={t('无法授予', 'Could not grant')}
          testId="ggf-error"
        />
      ) : null}

      <div className="row" style={{ justifyContent: 'flex-end' }}>
        {onCancel ? (
          <Button variant="ghost" onClick={onCancel} disabled={submitting}>
            {t('取消', 'Cancel')}
          </Button>
        ) : null}
        <Button
          variant="primary"
          onClick={() => void submit()}
          disabled={!canSubmit}
          data-testid="ggf-submit"
        >
          {submitLabel ?? t('授予', 'Grant')}
        </Button>
      </div>
    </div>
  );
}

/** A small local `ui/Field` replica (label + control + hint) — this file may not import
 *  `components/ui/*`. */
function LocalField({
  id,
  label,
  hint,
  required = false,
  children,
}: {
  readonly id: string;
  readonly label: ReactNode;
  readonly hint?: ReactNode;
  readonly required?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {label}
        {required ? (
          <span className="field-required" aria-hidden>
            *
          </span>
        ) : null}
      </label>
      {children}
      {hint !== undefined ? (
        <p className="field-hint" id={`${id}-hint`}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/** A small local `ui/Notice` replica (no icon) — this file may not import `components/ui/*`. */
function LocalNotice({
  tone = 'info',
  testId,
  children,
}: {
  readonly tone?: 'info' | 'warn';
  readonly testId?: string;
  readonly children: ReactNode;
}) {
  return (
    <div className={`notice${tone === 'warn' ? ' notice-warn' : ''}`} data-testid={testId}>
      <div className="grow">{children}</div>
    </div>
  );
}

/** A small local `ui/ErrorBanner` replica (no retry) — this file may not import
 *  `components/ui/*`. */
function LocalErrorBanner({
  error,
  title,
  testId,
}: {
  readonly error: unknown;
  readonly title?: string;
  readonly testId?: string;
}) {
  const described = describeError(error);
  return (
    <div
      className="error-banner"
      role="alert"
      data-testid={testId}
      data-error-code={described.code}
    >
      <div className="error-banner-body">
        <div className="error-banner-title">
          <span>{title ?? described.title}</span>
          <code className="error-banner-code">{described.code}</code>
        </div>
        {described.message && described.message !== described.title ? (
          <p className="error-banner-message">{described.message}</p>
        ) : null}
      </div>
    </div>
  );
}

/** A small local `ui/StatusChip` replica over the same `lib/status-tone.ts` data — this file may
 *  not import `components/ui/*`. */
function LocalStatusChip({
  machine,
  status,
}: {
  readonly machine: StatusMachine;
  readonly status: string;
}) {
  const t = useT();
  const style = statusChipStyle(machine, status);
  const text = labelText(style, t);
  const classes = ['chip', `chip-${style.tone}`, 'chip-s', style.unknown ? 'chip-unknown' : '']
    .filter(Boolean)
    .join(' ');
  return (
    <span className={classes} data-status={status} data-tone={style.tone}>
      {text}
    </span>
  );
}
