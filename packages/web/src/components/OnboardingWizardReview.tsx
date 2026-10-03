import {
  BLAST_RADIUS_VALUES,
  OPERATION_MODE_VALUES,
  type OperationGovernanceChangeWire,
} from '@nexttime/shared';
import { useCallback, useRef, useState } from 'react';
import { useResource } from '../hooks/useResource.js';
import type { CapabilityCaller } from '../lib/clients.js';
import {
  type GraphObjectRow,
  type OperationDetailView,
  operationDetailFromObject,
  reclassifiedOperationPayload,
  searchItems,
} from '../lib/connections.js';
import { prettyJson } from '../lib/format.js';
import { useT } from '../lib/i18n.js';
import {
  GovernanceChangeList,
  governanceChangeSummary,
  governanceConsequences,
  isLoosening,
} from './connect/GovernanceChange.js';
import { Confirm } from './kit/confirm.js';
import { Button } from './ui/Button.js';
import { EmptyState } from './ui/EmptyState.js';
import { ErrorBanner } from './ui/ErrorBanner.js';
import { Field, Select } from './ui/Field.js';
import { Notice } from './ui/Notice.js';
import { SkeletonRows } from './ui/Skeleton.js';
import { StatusChip } from './ui/StatusChip.js';

export interface OnboardingWizardReviewProps {
  readonly http: CapabilityCaller;
  readonly gatekeeperId: string;
  readonly onDone: () => void;
  /** S6-C: the "接入一个系统" launcher (`connect/ConnectSystemLauncher.tsx`) composes this step
   *  inside `ui/Launcher`, whose own footer already carries 下一步 — `false` drops this component's
   *  Next button so the reader does not see two. Default `true` for the five-step wizard. */
  readonly showDone?: boolean;
}

/**
 * components/OnboardingWizardReview: wizard step ④ — review the newly-imported Operations (name,
 * mode, blast radius, auto-approvable, a params-schema preview) with a per-row "propose
 * reclassification" action. Sourced from `search{objectType:'Operation'}` filtered to this gate,
 * not `list_operations`: the latter's projection (`toWireOperationSummary`,
 * `gatekeeper-read-handlers.ts`) carries no `binding`/`params_schema`/`reversibility`/
 * `await_decision`/`reads`/`writes` — exactly the fields `propose_operation`'s `operation` param
 * (`@nexttime/shared`'s `OperationSchema`) requires in full, so only the raw graph Object read
 * carries enough to reclassify with (`lib/connections.ts`'s own doc comment on
 * `operationDetailFromObject`). Same 50-row `search` cap as the rest of this page.
 *
 * "Propose reclassification" is deliberately the two-step `propose_operation` → `publish_operation`
 * pair, never a direct edit (docs/wire-contract-conventions.md: "UI 不得提供'直接改分类'的捷径") —
 * same convention `CatalogPage`'s publish/deprecate buttons already follow. **R-19 (decision D-17)**:
 * the two steps are no longer chained blind. `propose_operation` answers with `governanceChange`
 * (the published version → this draft, with the kernel's direction); a non-`neutral` change opens
 * a confirm listing old → new — danger-styled, with what it means, when it loosens — and only
 * that confirm takes the `publish_operation` step. Cancelling leaves the draft unpublished (the
 * catalog shows it, with the same confirm on its Publish). **Narrower kernel
 * interaction gap than this screen used to have** (not a bug in this UI; fix/operation-revision-via-
 * propose, S3.12): `propose_operation`'s own conflict guard (`governance/gatekeepers/manifest.ts`'s
 * `isOwnProposalDraft`) only ever replaces a draft the *same* proposer already wrote through
 * `propose_operation` itself — an `origin:'import'` draft (what every Operation on this review
 * screen starts as, fresh out of step ③'s manifest import, before `publish_manifest` publishes it)
 * is never "the proposer's own draft," so reclassifying it here still throws
 * `OperationIdentityConflictError` (409 `conflict`) as long as it stays unpublished. Once
 * `publish_manifest` has published it, though, `propose_operation` no longer 409s: it opens a new
 * revision draft one version above the published row (`draftOf` pointing back at it), which the
 * existing "propose → publish" two-step then carries to publish normally — the row this screen
 * shows a reclassify attempt against on a *second* visit (or any row already published by the time
 * a reviewer gets to it) reclassifies successfully, not always 409. The button still calls the real
 * capability and surfaces whatever the kernel says via `ErrorBanner` either way — this screen does
 * not swallow, pre-empt, or special-case either outcome.
 */
export function OnboardingWizardReview({
  http,
  gatekeeperId,
  onDone,
  showDone = true,
}: OnboardingWizardReviewProps) {
  const t = useT();
  const loadOperations = useCallback(
    () =>
      http.call<unknown>('search', { query: '', objectType: 'Operation' }).then((result) =>
        searchItems<GraphObjectRow>(result)
          .map(operationDetailFromObject)
          .filter((row): row is OperationDetailView => row !== undefined)
          .filter((row) => row.gatekeeperId === gatekeeperId),
      ),
    [http, gatekeeperId],
  );
  const operations = useResource(loadOperations);

  return (
    <div className="stack" data-testid="wizard-review">
      {operations.state.status === 'loading' ? (
        <SkeletonRows
          count={3}
          label={t('正在加载 Operation…', 'Loading operations')}
          testId="wizard-review-loading"
        />
      ) : operations.state.status === 'error' ? (
        <ErrorBanner
          error={operations.state.error}
          title={t('无法加载这个门的 Operation', "Could not load this gate's operations")}
          onRetry={() => void operations.reload()}
          testId="wizard-review-error"
        />
      ) : operations.state.data.length === 0 ? (
        <EmptyState
          icon="grid"
          title={t('这个门没有导入任何 Operation', 'No operations imported for this gate')}
        />
      ) : (
        <table className="data-table" data-testid="wizard-review-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Mode</th>
              <th>Blast radius</th>
              <th>Auto-approvable</th>
              <th>Params schema</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {operations.state.data.map((row) => (
              <OperationReviewRow
                key={row.objectId}
                http={http}
                row={row}
                onChanged={() => void operations.reload()}
              />
            ))}
          </tbody>
        </table>
      )}

      {showDone ? (
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <Button variant="primary" onClick={onDone}>
            {t('下一步', 'Next')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function OperationReviewRow({
  http,
  row,
  onChanged,
}: {
  readonly http: CapabilityCaller;
  readonly row: OperationDetailView;
  readonly onChanged: () => void;
}) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [mode, setMode] = useState(row.mode);
  const [blastRadius, setBlastRadius] = useState(row.blastRadius);
  const [autoApprovable, setAutoApprovable] = useState(row.autoApprovable);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown | null>(null);
  // R-19 (D-17): the proposed draft's change, waiting for the confirm before it is published.
  const [pendingChange, setPendingChange] = useState<OperationGovernanceChangeWire | null>(null);
  const [draftKept, setDraftKept] = useState(false);
  const publishedRef = useRef(false);

  async function publish(): Promise<void> {
    await http.call('publish_operation', { gatekeeperId: row.gatekeeperId, name: row.name });
    publishedRef.current = true;
    setPendingChange(null);
    setEditing(false);
    onChanged();
  }

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);
    setDraftKept(false);
    publishedRef.current = false;
    try {
      const operation = reclassifiedOperationPayload(row, { mode, blastRadius, autoApprovable });
      const proposed = await http.call<{ governanceChange: OperationGovernanceChangeWire | null }>(
        'propose_operation',
        { gatekeeperId: row.gatekeeperId, operation },
      );
      const change = proposed.governanceChange ?? null;
      if (change !== null && change.direction !== 'neutral') {
        setPendingChange(change);
        return;
      }
      await publish();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  function onConfirmOpenChange(open: boolean): void {
    if (open) return;
    // Closed without publishing (cancel / Escape): the draft stays, unpublished.
    if (!publishedRef.current) setDraftKept(true);
    setPendingChange(null);
  }

  const changeItem = pendingChange ? { name: row.name, ...pendingChange } : null;
  const consequences = changeItem ? governanceConsequences(changeItem, t) : [];

  return (
    <>
      <tr data-testid="wizard-review-row">
        <td className="mono">{row.name}</td>
        <td>
          <StatusChip machine="operationMode" status={row.mode} size="s" />
        </td>
        <td>
          <StatusChip machine="blastRadius" status={row.blastRadius} size="s" />
        </td>
        <td>
          <StatusChip machine="autoApprovable" status={String(row.autoApprovable)} size="s" />
        </td>
        <td>
          <details className="disclosure">
            <summary>schema</summary>
            <pre className="code-block">{prettyJson(row.paramsSchema)}</pre>
          </details>
        </td>
        <td>
          <Button variant="ghost" size="s" onClick={() => setEditing((v) => !v)}>
            {editing ? 'Cancel' : t('提议重分类', 'Propose reclassification')}
          </Button>
        </td>
      </tr>
      {editing ? (
        <tr>
          <td colSpan={6}>
            <div className="stack-s" data-testid="wizard-review-reclassify-form">
              <Notice>
                {t(
                  '先创建新草稿（propose_operation），确认分类变化后再发布（publish_operation）——分类变更永远经过这两步，不提供直接改的捷径。',
                  'First a new draft (propose_operation), then — after you confirm the classification change — the publish (publish_operation). A classification change always takes both steps; there is no direct edit.',
                )}
              </Notice>
              <div className="row">
                <Field id={`wizard-reclassify-mode-${row.objectId}`} label="Mode">
                  <Select
                    id={`wizard-reclassify-mode-${row.objectId}`}
                    value={mode}
                    onChange={(e) => setMode(e.target.value)}
                    disabled={busy}
                  >
                    {OPERATION_MODE_VALUES.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field id={`wizard-reclassify-blast-${row.objectId}`} label="Blast radius">
                  <Select
                    id={`wizard-reclassify-blast-${row.objectId}`}
                    value={blastRadius}
                    onChange={(e) => setBlastRadius(e.target.value)}
                    disabled={busy}
                  >
                    {BLAST_RADIUS_VALUES.map((b) => (
                      <option key={b} value={b}>
                        {b}
                      </option>
                    ))}
                  </Select>
                </Field>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={autoApprovable}
                    onChange={(e) => setAutoApprovable(e.target.checked)}
                    disabled={busy}
                  />
                  <span>Auto-approvable</span>
                </label>
              </div>
              {error !== null ? (
                <ErrorBanner
                  error={error}
                  title={t(
                    '无法提出/发布这次重分类',
                    'Could not propose/publish this reclassification',
                  )}
                />
              ) : null}
              {draftKept ? (
                <Notice testId="wizard-review-draft-kept">
                  {t(
                    '草稿已保留、未发布；可以稍后在能力目录里发布。',
                    'The draft is kept, not published — you can publish it from the catalog later.',
                  )}
                </Notice>
              ) : null}
              <div className="row" style={{ justifyContent: 'flex-end' }}>
                <Confirm
                  tier="medium"
                  open={changeItem !== null}
                  onOpenChange={onConfirmOpenChange}
                  anchor={
                    <Button variant="primary" size="s" loading={busy} onClick={() => void submit()}>
                      {t('提交', 'Submit')}
                    </Button>
                  }
                  title={t('发布这次重分类', 'Publish this reclassification')}
                  description={t(
                    '分类决定这个 Operation 要不要人工审批、要不要授权。确认后发布新版本，替换当前生效的版本。',
                    'The classification decides whether this operation needs a person’s approval and a grant. Confirming publishes the new version in place of the one in effect.',
                  )}
                  target={row.name}
                  impact={changeItem ? [governanceChangeSummary(changeItem, t)] : []}
                  confirmLabel={t('发布', 'Publish')}
                  danger={changeItem !== null && isLoosening(changeItem.direction)}
                  onConfirm={publish}
                  testId="wizard-review-reclassify-confirm"
                >
                  {consequences.length > 0 ? (
                    <Notice tone="warn" testId="wizard-review-reclassify-loosens">
                      <ul className="stack-s" style={{ margin: 0, paddingLeft: '1.2em' }}>
                        {consequences.map((line) => (
                          <li key={line}>{line}</li>
                        ))}
                      </ul>
                    </Notice>
                  ) : null}
                  {changeItem ? <GovernanceChangeList items={[changeItem]} /> : null}
                </Confirm>
              </div>
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}
