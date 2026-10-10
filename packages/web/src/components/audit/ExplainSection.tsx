import type { ExplainResultWire, ExportProvResult } from '@nexttime/shared';
import { type FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { useRoleCan } from '../../hooks/useRoleCan.js';
import { AuditIdPicker } from '../../lib/audit-id-picker.js';
import { type ProvenanceNodeKind, provenanceNodeSource } from '../../lib/audit-pickers.js';
import {
  type ExplainView,
  auditHref,
  downloadJson,
  downloadName,
  explainView,
} from '../../lib/audit.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { isForbiddenError } from '../../lib/errors.js';
import { useT } from '../../lib/i18n.js';
import { hrefs } from '../../lib/router.js';
import { nameOf } from '../approvals/useDirectoryNames.js';
import { Select } from '../kit/select.js';
import { Button } from '../ui/Button.js';
import { ErrorBanner } from '../ui/ErrorBanner.js';
import { Notice } from '../ui/Notice.js';
import { ProvenanceChain } from '../ui/ProvenanceChain.js';
import { RefChip } from '../ui/RefChip.js';
import { useToast } from '../ui/Toast.js';

export interface ExplainSectionProps {
  readonly http: CapabilityCaller;
  /** A node to explain right away (a deep link, or the approval context's decision id) — the
   *  section re-runs whenever it changes. */
  readonly requestedNodeId?: string;
  readonly principalNames?: ReadonlyMap<string, string>;
}

interface ExplainState {
  readonly busy: boolean;
  readonly error: unknown | null;
  readonly nodeId: string | null;
  readonly result: ExplainResultWire | null;
}

const IDLE: ExplainState = { busy: false, error: null, nodeId: null, result: null };

/**
 * components/audit/ExplainSection (S6-A A4 / C27 — docs/console-completion-plan.md §5.5): the
 * `explain{nodeId}` view — a Fact, Decision or Activity id — rendered as `ui/ProvenanceChain`
 * (Fact → Activity → Source), with the Decision segment the chain does not model rendered above
 * it and the Activity's `metadata` links (taskId / workerRunId / actionRequestId — the "→
 * WorkerRun" hop of §5.5's acceptance chain) rendered below it; the raw payload stays behind
 * the chain's own "原始证据" disclosure. "导出 Export" calls `export_prov{nodeId}` (S6-A C27:
 * the same untyped id, resolved like `explain`) and downloads the PROV-JSON document — auditor
 * only, so a member sees the 403 explained rather than a dead button. `explain` itself is
 * `minRole: 'member'`.
 */
export function ExplainSection({ http, requestedNodeId, principalNames }: ExplainSectionProps) {
  const t = useT();
  const can = useRoleCan(http);
  const toast = useToast();
  const [nodeId, setNodeId] = useState(requestedNodeId ?? '');
  // Which recent nodes the picker offers — `explain` itself takes any of the three untyped.
  const [kind, setKind] = useState<ProvenanceNodeKind>('decision');
  const source = useMemo(() => provenanceNodeSource(kind, t), [kind, t]);
  const [state, setState] = useState<ExplainState>(IDLE);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<unknown | null>(null);

  const run = useCallback(
    async (target: string): Promise<void> => {
      const trimmed = target.trim();
      if (!trimmed) return;
      setState({ busy: true, error: null, nodeId: trimmed, result: null });
      setExportError(null);
      try {
        const result = await http.call<ExplainResultWire>('explain', { nodeId: trimmed });
        setState({ busy: false, error: null, nodeId: trimmed, result });
      } catch (err) {
        setState({ busy: false, error: err, nodeId: trimmed, result: null });
      }
    },
    [http],
  );

  // Auto-run on a deep link / approval context (§5.5 "预填 id、自动执行").
  useEffect(() => {
    if (requestedNodeId === undefined || requestedNodeId === '') return;
    setNodeId(requestedNodeId);
    void run(requestedNodeId);
  }, [requestedNodeId, run]);

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (state.busy) return;
    void run(nodeId);
  }

  async function handleExport(): Promise<void> {
    if (!state.nodeId || exporting) return;
    setExporting(true);
    setExportError(null);
    try {
      const result = await http.call<ExportProvResult>('export_prov', { nodeId: state.nodeId });
      const saved = downloadJson(downloadName('provenance', state.nodeId), result);
      toast.push({
        tone: saved ? 'ok' : 'warn',
        title: saved
          ? t('已导出 PROV-JSON', 'Exported PROV-JSON')
          : t('浏览器不支持下载', 'Download not supported in this browser'),
      });
    } catch (err) {
      setExportError(err);
    } finally {
      setExporting(false);
    }
  }

  const view = state.result ? explainView(state.result) : null;

  return (
    <section className="section" aria-labelledby="explain-title" data-testid="explain-section">
      <div className="section-header">
        <h2 id="explain-title">{t('溯源', 'Provenance (explain)')}</h2>
        {state.nodeId && state.result ? (
          <Button
            variant="secondary"
            size="s"
            loading={exporting}
            onClick={() => void handleExport()}
            data-testid="explain-export"
          >
            {t('导出 PROV-JSON', 'Export PROV-JSON')}
          </Button>
        ) : null}
      </div>
      <form className="inline-form" onSubmit={handleSubmit} data-testid="explain-form">
        <Select
          id="explain-node-kind"
          label={t('候选类型', 'Suggest from')}
          value={kind}
          onChange={(event) => setKind(event.target.value as ProvenanceNodeKind)}
          disabled={state.busy}
          data-testid="explain-node-kind"
        >
          <option value="decision">{t('最近的决定', 'Recent decisions')}</option>
          <option value="fact">{t('审计中的事实', 'Facts in the audit log')}</option>
          <option value="activity">{t('审计中的活动', 'Activities in the audit log')}</option>
        </Select>
        <AuditIdPicker
          http={http}
          id="explain-node-id"
          label={t('节点 ID', 'Node id')}
          hint={t('Fact、Decision 或 Activity 的 ID。', 'A Fact, Decision, or Activity id.')}
          value={nodeId}
          onChange={setNodeId}
          source={source}
          refusedNote={t(
            '事实与活动的候选来自审计记录（需要 auditor 角色）；请粘贴 ID，或改为从最近的决定中选择。',
            'Fact and activity suggestions come from the audit log (auditor role) — paste an id, or suggest from recent decisions.',
          )}
          disabled={state.busy}
          testId="explain-node-id"
        />
        <Button type="submit" variant="primary" loading={state.busy} disabled={!nodeId.trim()}>
          {t('解释', 'Explain')}
        </Button>
      </form>
      {state.error !== null ? (
        <ErrorBanner
          error={state.error}
          title={t('无法解释该节点', 'Could not explain this node')}
          testId="explain-error"
        />
      ) : null}
      {exportError !== null ? (
        isForbiddenError(exportError) ? (
          <Notice tone="warn" testId="explain-export-forbidden">
            {t(
              '导出溯源只有审计员和工作区所有者能做；要导出，请工作区所有者把你的角色改为 auditor。',
              'Only auditors and the workspace owner can export provenance; to export, ask the workspace owner to make you an auditor.',
            )}
          </Notice>
        ) : (
          <ErrorBanner
            error={exportError}
            title={t('无法导出', 'Could not export')}
            testId="explain-export-error"
          />
        )
      ) : null}
      {view ? (
        <ExplainResultView
          view={view}
          raw={state.result}
          principalNames={principalNames}
          canOpenApproval={can('get_action') !== false}
        />
      ) : null}
    </section>
  );
}

function ExplainResultView({
  view,
  raw,
  principalNames,
  canOpenApproval,
}: {
  readonly view: ExplainView;
  readonly raw: unknown;
  readonly principalNames?: ReadonlyMap<string, string>;
  /** The reader's role may open an ActionRequest (`get_action`); otherwise its chip is not a link. */
  readonly canOpenApproval: boolean;
}) {
  const t = useT();
  const { decision, links } = view;
  const hasLinks =
    links.taskId !== undefined ||
    links.workerRunId !== undefined ||
    links.actionRequestId !== undefined ||
    links.onBehalfOf !== undefined;
  return (
    <div className="stack" data-testid="explain-result" data-node-type={view.nodeType}>
      {decision ? (
        <div className="stack-s" data-testid="explain-decision">
          <span className="section-title">{t('决定', 'Decision')}</span>
          <dl className="definition-list">
            <dt>{t('决定', 'Decision')}</dt>
            <dd>
              <RefChip kind="object" id={decision.id} name={decision.summary} size="s" />
            </dd>
            <dt>{t('状态', 'Status')}</dt>
            <dd className="mono">{decision.status}</dd>
            <dt>{t('决定者', 'Decided by')}</dt>
            <dd>
              {decision.decidedByPrincipal ? (
                <RefChip
                  kind="principal"
                  id={decision.decidedByPrincipal.id}
                  name={
                    decision.decidedByPrincipal.displayName ??
                    nameOf(principalNames, decision.decidedByPrincipal.id)
                  }
                  size="s"
                />
              ) : (
                <span className="text-3">—</span>
              )}
            </dd>
          </dl>
        </div>
      ) : null}
      <ProvenanceChain
        fact={view.fact}
        activity={view.activity}
        source={view.source}
        raw={raw}
        hrefFor={(kind, id) =>
          // Only the two explainable segments link (an in-page re-explain); a Source id is
          // neither a Fact nor an Activity, so `explain` would answer 404 for it.
          kind === 'object' && (id === view.fact?.id || id === view.activity?.id)
            ? auditHref({ nodeId: id })
            : undefined
        }
        testId="explain-chain"
      />
      {hasLinks ? (
        <div className="stack-s" data-testid="explain-links">
          <span className="section-title">{t('关联', 'Links')}</span>
          <dl className="definition-list">
            {links.taskId ? (
              <>
                <dt>{t('任务', 'Task')}</dt>
                <dd>
                  <RefChip
                    kind="object"
                    id={links.taskId}
                    name="Task"
                    href={hrefs.task(links.taskId)}
                    size="s"
                    testId="explain-link-task"
                  />
                </dd>
              </>
            ) : null}
            {links.workerRunId ? (
              <>
                <dt>{t('Worker 运行', 'Worker run')}</dt>
                <dd>
                  <RefChip
                    kind="object"
                    id={links.workerRunId}
                    name="WorkerRun"
                    href={links.taskId ? hrefs.task(links.taskId) : undefined}
                    size="s"
                    testId="explain-link-worker-run"
                  />
                </dd>
              </>
            ) : null}
            {links.actionRequestId ? (
              <>
                <dt>{t('动作请求', 'Action request')}</dt>
                <dd>
                  <RefChip
                    kind="actionRequest"
                    id={links.actionRequestId}
                    name="ActionRequest"
                    href={canOpenApproval ? hrefs.approval(links.actionRequestId) : undefined}
                    size="s"
                    testId="explain-link-action-request"
                  />
                </dd>
              </>
            ) : null}
            {links.onBehalfOf && !view.activity?.onBehalfOfPrincipal ? (
              <>
                <dt>{t('代表', 'On behalf of')}</dt>
                <dd>
                  <RefChip
                    kind="principal"
                    id={links.onBehalfOf}
                    name={nameOf(principalNames, links.onBehalfOf)}
                    size="s"
                  />
                </dd>
              </>
            ) : null}
          </dl>
        </div>
      ) : null}
    </div>
  );
}
