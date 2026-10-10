import type { OperationSummaryWire } from '@nexttime/shared';
import { useRef, useState } from 'react';
import { useCapabilityList } from '../../hooks/useCapability.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import {
  type GatekeeperListRow,
  type GrantRow,
  type PrincipalRow,
  gateGrantMakesApprover,
} from '../../lib/governance.js';
import { useT } from '../../lib/i18n.js';
import { roleLabel } from '../../lib/labels.js';
import { Button } from '../kit/button.js';
import { Confirm } from '../kit/confirm.js';
import { ErrorBanner } from '../kit/error-banner.js';
import { Field } from '../kit/field.js';
import { Notice } from '../kit/notice.js';
import { RefChip } from '../kit/ref-chip.js';
import { StatusChip } from '../kit/status-chip.js';

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
 * R-39 (D-13): a gate grant also makes an `operator` an approver of every action on that gate (the
 * kernel counts the grant as I14 approval scope). The covered-Operations hint says so, and picking
 * a member whose role makes the grant an approval grant (`gateGrantMakesApprover`) shows a notice
 * naming them before anything is submitted.
 *
 * One `grant_capability` call per selected gate (the capability takes one `resourceId` at a time);
 * `resourceId` omitted entirely for the "全部门" case. There is no `scope`: the kernel never
 * enforced `capability_grants.scope`, and since 2026-09-25 `grant_capability` no longer accepts it
 * (leftover 80). A grant covers the whole gate, and the Operations list says so.
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
  const [failedGate, setFailedGate] = useState<string | null>(null);
  /** What was granted in this drawer session, for the summary: who got which gates (`null` = every
   *  gate). Kept as display data so the summary survives the form resetting for the next grant. */
  const [grantedLog, setGrantedLog] = useState<
    readonly { readonly member: string; readonly gate: string | null }[]
  >([]);
  // Names of every gate row seen, so the summary can name a gate even after a later search hides it.
  const gateNames = useRef(new Map<string, string>());
  for (const row of gateOptions) gateNames.current.set(row.id, row.name);
  const gateName = (id: string): string =>
    lockedGatekeeper?.id === id ? lockedGatekeeper.name : (gateNames.current.get(id) ?? id);

  const canSubmit =
    principalId !== '' &&
    (lockedGatekeeper !== undefined || allGates || selectedGateIds.size > 0) &&
    !submitting;
  // Audit P1-9: a disabled 授予 says what it still waits for.
  const missing = [
    principalId === '' ? t('选择成员', 'choose a member') : null,
    lockedGatekeeper !== undefined || allGates || selectedGateIds.size > 0
      ? null
      : t('选择门', 'pick a gate'),
  ].filter((item): item is string => item !== null);

  async function submit(): Promise<void> {
    if (!canSubmit) return;
    const memberName = selectedPrincipal?.displayName ?? principalId;
    setSubmitting(true);
    setError(null);
    // Grants that already landed stay in the summary (and are reported to the caller) even if a
    // later gate in the same submit fails.
    const results: GrantRow[] = [];
    const doneGateIds: string[] = [];
    let failedGateId: string | null = null;
    try {
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
          failedGateId = gatekeeperId;
          results.push(
            await http.call<GrantRow>('grant_capability', {
              principalId,
              resourceType: 'gatekeeper',
              resourceId: gatekeeperId,
            }),
          );
          doneGateIds.push(gatekeeperId);
        }
        failedGateId = null;
      }
      setGrantedLog((current) => [
        ...current,
        ...(allGates
          ? [{ member: memberName, gate: null }]
          : doneGateIds.map((id) => ({ member: memberName, gate: gateName(id) }))),
      ]);
      onGranted(results);
      // Reset for another grant in the same drawer session — keep the drawer open so multi-gate
      // and repeat grants (a common "add another member" flow) do not each re-open it.
      setPrincipalId('');
      setSelectedGateIds(new Set());
      setAllGates(false);
    } catch (err) {
      setError(err);
      setFailedGate(failedGateId === null ? null : gateName(failedGateId));
      if (results.length > 0) {
        // Partial success: record what landed, tell the caller, and leave only the gates that did
        // not (the failed one and any not yet tried) selected so a retry does not re-grant.
        setGrantedLog((current) => [
          ...current,
          ...doneGateIds.map((id) => ({ member: memberName, gate: gateName(id) })),
        ]);
        onGranted(results);
        setSelectedGateIds(new Set(targetGateIds.filter((id) => !doneGateIds.includes(id))));
      }
    } finally {
      setSubmitting(false);
    }
  }

  const selectedGateNames = [...selectedGateIds].map((id) => gateName(id));

  return (
    <div className="stack" data-testid={testId ?? 'grant-gate-form'}>
      <Field
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
      </Field>
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
          {principals.state.status === 'loading'
            ? t('正在加载…', 'Loading…')
            : principals.state.status === 'error'
              ? t('成员列表加载失败', 'Could not load members')
              : memberOptions.length === 0
                ? t('没有匹配的成员', 'No matching member')
                : t('— 选择 —', '— Choose —')}
        </option>
        {memberOptions.map((row) => (
          <option key={row.id} value={row.id}>
            {row.displayName} ({roleLabel(row.role, t)})
          </option>
        ))}
      </select>
      {principals.state.status === 'error' ? (
        <ErrorBanner
          error={principals.state.error}
          title={t('无法加载成员', 'Could not load members')}
          onRetry={() => void principals.reload()}
          testId="ggf-members-error"
        />
      ) : null}
      {selectedPrincipal ? (
        // Wrapped so the chip keeps its own width instead of stretching across the column stack.
        <div>
          <RefChip
            kind="principal"
            id={selectedPrincipal.id}
            name={selectedPrincipal.displayName}
            size="s"
            testId="ggf-member-chip"
          />
        </div>
      ) : null}
      {selectedPrincipal && gateGrantMakesApprover(selectedPrincipal.role) ? (
        <Notice tone="warn" testId="ggf-approver-notice">
          {t(
            `${selectedPrincipal.displayName} 的角色是${roleLabel(selectedPrincipal.role, t)}：授予门的同时，他也会成为所授予门上所有动作的审批者——能批准或驳回其他成员经 Worker 提出的写操作。撤销授权会同时收回这份审批权。`,
            `${selectedPrincipal.displayName} has the ${roleLabel(selectedPrincipal.role, t)} role: a gate grant also makes them an approver of every action on the granted gate(s) — they can approve or reject the writes other members request through a Worker. Revoking the grant removes that approval right too.`,
          )}
        </Notice>
      ) : null}

      {lockedGatekeeper ? (
        <Field id="ggf-locked-gate" label={t('门', 'Gatekeeper')}>
          <div>
            <RefChip
              kind="gatekeeper"
              id={lockedGatekeeper.id}
              name={lockedGatekeeper.name}
              testId="ggf-locked-gate-chip"
            />
          </div>
        </Field>
      ) : (
        <div className="stack-s" data-testid="ggf-gate-picker">
          <Field
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
          </Field>
          <div className="stack-s" data-testid="ggf-gate-list">
            {gatekeepers.state.status === 'loading' ? (
              <p className="text-3 text-small">{t('正在加载…', 'Loading…')}</p>
            ) : gatekeepers.state.status === 'error' ? (
              <ErrorBanner
                error={gatekeepers.state.error}
                title={t('无法加载门列表', 'Could not load gates')}
                onRetry={() => void gatekeepers.reload()}
                testId="ggf-gates-error"
              />
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
              '该成员将能经 Worker 对工作区里的每一个门提出写操作（仍按审批规则处理），包括以后新接入的门——不限于当前列表。只读操作不需要授权。',
              'This member will be able to request write operations on every gate in this workspace through a Worker (still subject to approval), including gates connected later — not just the ones listed today. Read operations need no grant.',
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
              '授权针对整个门的执行类 Operation：成员的入口 agent 可以经 Worker 请求这个门的全部已发布执行类 Operation（包括以后新发布的），仍按审批规则处理。授予 operator 时，他同时成为这个门上所有动作的审批者。只读 Operation 不需要授权，工作区里每个成员都能调用。',
              'A grant covers the gate’s execute-class operations: the member’s entry agent may request every published one through a Worker, including ones published later, still following the approval rules. Granted to an operator, it also makes them an approver of every action on this gate. Read operations need no grant — every member of the workspace can call them.',
            )}
          </p>
          {operations.state.status === 'loading' ? (
            <p className="text-3 text-small">{t('正在加载…', 'Loading…')}</p>
          ) : operations.state.status === 'error' ? (
            <ErrorBanner
              error={operations.state.error}
              title={t('无法加载这个门的 Operation', "Could not load this gate's operations")}
              onRetry={() => void operations.reload()}
              testId="ggf-operations-error"
            />
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
                  <StatusChip machine="operationMode" status={operation.mode} size="s" />
                  <StatusChip machine="blastRadius" status={operation.blastRadius} size="s" />
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}

      {allGates ? (
        <Notice tone="warn" testId="ggf-all-gates-notice">
          {t(
            '已选择「全部门」：成员可以请求本工作区每个门的全部 Operation，包括以后新接入的门；执行类仍按审批规则处理。',
            'Every gate is selected: the member may request every operation of every gate in this workspace, including gates connected later; execute-class ones still follow the approval rules.',
          )}
        </Notice>
      ) : null}

      {grantedLog.length > 0 ? (
        <Notice testId="ggf-granted-summary">
          <span>{t('本次已授予：', 'Granted so far:')}</span>
          <ul style={{ margin: 0, paddingLeft: 'var(--space-4)' }}>
            {grantedLog.map((entry, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: an append-only log; entries may repeat
              <li key={index} data-testid="ggf-granted-entry">
                {entry.gate === null
                  ? t(`${entry.member} → 全部门`, `${entry.member} → every gate`)
                  : `${entry.member} → ${entry.gate}`}
              </li>
            ))}
          </ul>
        </Notice>
      ) : null}

      {error !== null ? (
        <ErrorBanner
          error={error}
          title={
            failedGate === null
              ? t('无法授予', 'Could not grant')
              : t(`无法授予“${failedGate}”`, `Could not grant “${failedGate}”`)
          }
          testId="ggf-error"
        />
      ) : null}

      <div className="row" style={{ justifyContent: 'flex-end' }}>
        {missing.length > 0 && !submitting ? (
          <span className="text-small text-3" data-testid="ggf-missing">
            {t(`还差：${missing.join('、')}`, `Still needed: ${missing.join(', ')}`)}
          </span>
        ) : null}
        {onCancel ? (
          <Button variant="ghost" onClick={onCancel} disabled={submitting}>
            {t('取消', 'Cancel')}
          </Button>
        ) : null}
        <Button
          variant="primary"
          onClick={() => void submit()}
          disabled={!canSubmit}
          aria-busy={submitting || undefined}
          data-testid="ggf-submit"
        >
          {submitting ? t('授予中…', 'Granting…') : (submitLabel ?? t('授予', 'Grant'))}
        </Button>
      </div>
    </div>
  );
}
