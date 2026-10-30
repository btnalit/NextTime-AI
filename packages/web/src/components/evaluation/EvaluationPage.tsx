import type {
  DraftEvaluationSummaryWire,
  EvalSuiteSummaryWire,
  EvalSuiteWire,
} from '@nexttime/shared';
import { useCallback, useMemo, useState } from 'react';
import { type Resource, useResource } from '../../hooks/useResource.js';
import { useRoleCan } from '../../hooks/useRoleCan.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { pinnedWorkerName, suiteSummaryOf, workerChoices } from '../../lib/evaluation.js';
import { formatDateTime, formatRelative, shortId } from '../../lib/format.js';
import { type Translate, useT } from '../../lib/i18n.js';
import { breadcrumbFor } from '../../lib/nav.js';
import type { EvaluationTab } from '../../lib/router.js';
import type { WorkerDefinitionSummary } from '../../lib/tasks.js';
import { usePrincipalNames } from '../approvals/useDirectoryNames.js';
import { Button } from '../kit/button.js';
import { EmptyState } from '../kit/empty-state.js';
import { ErrorBanner } from '../kit/error-banner.js';
import { List, ListRow } from '../kit/list-row.js';
import { MasterDetail, nothingToPick } from '../kit/master-detail.js';
import { PageHeader } from '../kit/page-header.js';
import { SkeletonRows } from '../kit/skeleton.js';
import { Tabs } from '../kit/tabs.js';
import { CreateSuiteSheet } from './CreateSuiteSheet.js';
import { DraftEvaluationsTab } from './DraftEvaluations.js';
import { EvalBudgetCard, useEvalBudget, useIsOwner } from './EvalBudget.js';
import { SuiteDetail } from './SuiteDetail.js';

export interface EvaluationPageProps {
  readonly http: CapabilityCaller;
  readonly tab: EvaluationTab;
  /** The suite (用例集) or the draft evaluation (草稿评测) open in the tab's detail. */
  readonly itemId?: string;
  readonly onNavigate: (tab: EvaluationTab, itemId: string | null) => void;
}

/**
 * components/evaluation/EvaluationPage (S10 E3-1a, coordinator fork 7 = a): 治理 → 评测 — the
 * workspace's evaluation suites (`list_eval_suites`) as a master-detail page (`kit/master-detail`,
 * like 任务): the list, and one suite's detail (`SuiteDetail`). Every person reads them (an auditor
 * included); a builder or the owner creates one (`CreateSuiteSheet`) and changes it. A suite's cases
 * (E3-1b) and their 试跑 (E3-2a, in a case's sheet) are in its detail; the month's evaluation
 * budget (`EvalBudgetCard`, E3-2a) heads the page. E3-2b adds the 草稿评测 tab
 * (`DraftEvaluationsTab`, `#/govern/evaluation/drafts/<id>`): the Skill draft evaluations the
 * reader may see, and one whole.
 *
 * Worker names come from `list_worker_definitions{kind:'worker'}` (published rows, every version)
 * — the same list the create form picks from and a repin chooses a version in.
 */
export function EvaluationPage({ http, tab, itemId, onNavigate }: EvaluationPageProps) {
  const t = useT();
  const can = useRoleCan(http);
  const suiteId = tab === 'suites' ? itemId : undefined;
  const onSelectSuite = useCallback((id: string | null) => onNavigate('suites', id), [onNavigate]);
  const loadEvaluations = useCallback(async () => {
    const page = await http.call<{ items: readonly DraftEvaluationSummaryWire[] }>(
      'list_draft_evaluations',
      {},
    );
    return page.items;
  }, [http]);
  const evaluations = useResource(loadEvaluations);
  const load = useCallback(async () => {
    const page = await http.call<{ items: readonly EvalSuiteSummaryWire[] }>(
      'list_eval_suites',
      {},
    );
    return page.items;
  }, [http]);
  const suites = useResource(load);
  const loadDefinitions = useCallback(async () => {
    let items: readonly WorkerDefinitionSummary[] = [];
    let cursor: string | undefined;
    do {
      const page = await http.call<{
        items: readonly WorkerDefinitionSummary[];
        nextCursor?: string;
      }>('list_worker_definitions', { kind: 'worker', ...(cursor ? { cursor } : {}) });
      items = [...items, ...page.items];
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    return items;
  }, [http]);
  const definitions = useResource(loadDefinitions);
  const principalNames = usePrincipalNames(http);
  const budget = useEvalBudget(http);
  const isOwner = useIsOwner(http);
  const [creating, setCreating] = useState(false);

  const rows = suites.state.status === 'ready' ? suites.state.data : [];
  const definitionRows = definitions.state.status === 'ready' ? definitions.state.data : undefined;
  const workers = useMemo(
    () => (definitionRows === undefined ? undefined : workerChoices(definitionRows)),
    [definitionRows],
  );
  const mutateSuites = suites.mutate;

  const onChanged = useCallback(
    (suite: EvalSuiteWire) => {
      const summary = suiteSummaryOf(suite);
      mutateSuites((current) =>
        current.some((row) => row.id === summary.id)
          ? current.map((row) => (row.id === summary.id ? summary : row))
          : [summary, ...current],
      );
    },
    [mutateSuites],
  );

  const canCreate = can('create_eval_suite') !== false;
  const reloadBudget = budget.reload;
  const onEvaluationChanged = useCallback(() => void reloadBudget(), [reloadBudget]);
  const current = tab === 'suites' ? suites : evaluations;
  const evaluationCount =
    evaluations.state.status === 'ready' ? evaluations.state.data.length : undefined;

  return (
    <div className="page evaluation-page">
      <PageHeader
        breadcrumb={breadcrumbFor('evaluation')}
        title={t('评测', 'Evaluation')}
        description={t(
          '用例集钉住一个 Worker 版本，把它要用的门冻结成夹具门，评测时不调用真实系统。用例集只给人看，智能体读不到。',
          'A suite pins a Worker version and freezes the gates it uses as fixture gates, so evaluation never calls a real system. Suites are shown to people only, never to an agent.',
        )}
        actions={
          <>
            <Button
              variant="ghost"
              aria-busy={current.state.status === 'ready' && current.state.refreshing}
              disabled={current.state.status === 'ready' && current.state.refreshing}
              onClick={() => {
                void current.reload();
                void budget.reload();
              }}
            >
              {t('刷新', 'Refresh')}
            </Button>
            {canCreate && tab === 'suites' ? (
              <Button
                variant="primary"
                onClick={() => setCreating(true)}
                data-testid="eval-suite-create-open"
              >
                {t('新建用例集', 'New suite')}
              </Button>
            ) : null}
          </>
        }
      />

      <EvalBudgetCard budget={budget} isOwner={isOwner} />

      <Tabs<EvaluationTab>
        ariaLabel={t('评测', 'Evaluation')}
        value={tab}
        options={[
          {
            value: 'suites',
            label: t('用例集', 'Suites'),
            ...(suites.state.status === 'ready' ? { count: rows.length } : {}),
            testId: 'eval-tab-suites',
          },
          {
            value: 'drafts',
            label: t('草稿评测', 'Draft evaluations'),
            ...(evaluationCount !== undefined ? { count: evaluationCount } : {}),
            testId: 'eval-tab-drafts',
          },
        ]}
        onChange={(next) => onNavigate(next, null)}
      />

      {tab === 'drafts' ? (
        <DraftEvaluationsTab
          http={http}
          evaluations={evaluations}
          evaluationId={itemId}
          onSelect={(id) => onNavigate('drafts', id)}
          definitions={definitionRows}
          principalNames={principalNames}
          onEvaluationChanged={onEvaluationChanged}
        />
      ) : (
        <MasterDetail
          list={
            <SuitesList
              t={t}
              suites={suites}
              rows={rows}
              definitionRows={definitionRows}
              selectedId={suiteId}
              onSelect={onSelectSuite}
            />
          }
          detail={
            nothingToPick(suites.state.status, rows.length, suiteId) ? null : suiteId !==
              undefined ? (
              <SuiteDetail
                key={suiteId}
                http={http}
                suiteId={suiteId}
                definitions={definitionRows}
                principalNames={principalNames}
                onChanged={onChanged}
              />
            ) : (
              <EmptyState
                title={t('还没有选择用例集', 'No suite selected yet')}
                body={t(
                  '选择左侧一个用例集，查看钉住的 Worker、夹具门和变更记录。',
                  'Pick a suite on the left to see its pinned Worker, fixture gates and history.',
                )}
                testId="eval-suite-detail-empty"
              />
            )
          }
          open={suiteId !== undefined}
          onClose={() => onSelectSuite(null)}
          sheetTitle={t('用例集详情', 'Suite detail')}
          detailTestId="eval-suite-drawer"
        />
      )}

      {canCreate ? (
        <CreateSuiteSheet
          http={http}
          open={creating}
          onOpenChange={setCreating}
          workers={workers}
          onCreated={(suite) => {
            onChanged(suite);
            setCreating(false);
            onSelectSuite(suite.id);
          }}
        />
      ) : null}
    </div>
  );
}

interface SuitesListProps {
  readonly t: Translate;
  readonly suites: Resource<readonly EvalSuiteSummaryWire[]>;
  readonly rows: readonly EvalSuiteSummaryWire[];
  readonly definitionRows: readonly WorkerDefinitionSummary[] | undefined;
  readonly selectedId: string | undefined;
  readonly onSelect: (suiteId: string | null) => void;
}

function SuitesList({ t, suites, rows, definitionRows, selectedId, onSelect }: SuitesListProps) {
  if (suites.state.status === 'loading') {
    return (
      <SkeletonRows
        count={4}
        label={t('正在加载用例集', 'Loading evaluation suites')}
        testId="eval-suites-loading"
      />
    );
  }
  if (suites.state.status === 'error') {
    return (
      <ErrorBanner
        error={suites.state.error}
        title={t('无法加载用例集', 'Could not load evaluation suites')}
        onRetry={() => void suites.reload()}
        testId="eval-suites-error"
      />
    );
  }
  if (rows.length === 0) {
    return (
      <EmptyState
        title={t('还没有用例集', 'No evaluation suite yet')}
        body={t(
          '用例集钉住一个已发布的 Worker 版本，把它要用的门冻结成夹具门；之后的用例和评测运行都挂在用例集上。',
          'A suite pins a published Worker version and freezes the gates it uses as fixture gates; cases and evaluation runs will hang off it.',
        )}
        testId="eval-suites-empty"
      />
    );
  }
  return (
    <div className="stack-s">
      {suites.state.refreshError ? (
        <ErrorBanner error={suites.state.refreshError} onRetry={() => void suites.reload()} />
      ) : null}
      <List ariaLabel="Evaluation suites" testId="eval-suites-list">
        {rows.map((suite) => {
          const worker = pinnedWorkerName(definitionRows, suite.workerDefinition);
          return (
            <ListRow
              key={suite.id}
              testId="eval-suite-row"
              selected={suite.id === selectedId}
              onSelect={() => onSelect(suite.id)}
            >
              <span className="row-wrap" style={{ justifyContent: 'space-between' }}>
                <span className="truncate" style={{ fontWeight: 600 }}>
                  {suite.name}
                </span>
                <span className="text-3 text-small tabular">v{suite.version}</span>
              </span>
              <span className="row-wrap text-3">
                <span className="truncate">
                  {worker ?? <span data-volatile="">{shortId(suite.workerDefinition.id)}</span>}
                </span>
                <span className="text-small">v{suite.workerDefinition.version}</span>
                {suite.workerDefinition.status !== 'published' ? (
                  <span className="text-warn text-small" data-testid="eval-suite-row-deprecated">
                    {t('已弃用', 'deprecated')}
                  </span>
                ) : null}
                <span className="meta-sep" />
                <span>
                  {t(
                    `${suite.fixtureGateCount} 个夹具门`,
                    `${suite.fixtureGateCount} fixture gate${suite.fixtureGateCount === 1 ? '' : 's'}`,
                  )}
                </span>
                {suite.fixtureGatesNeedingAttention > 0 ? (
                  <>
                    <span className="meta-sep" />
                    <span className="text-warn" data-testid="eval-suite-row-attention">
                      {t(
                        `${suite.fixtureGatesNeedingAttention} 个和门不一致`,
                        `${suite.fixtureGatesNeedingAttention} no longer match their gate`,
                      )}
                    </span>
                  </>
                ) : null}
                <span className="meta-sep" />
                <time title={formatDateTime(suite.updatedAt)}>
                  {formatRelative(suite.updatedAt)}
                </time>
              </span>
            </ListRow>
          );
        })}
      </List>
    </div>
  );
}
