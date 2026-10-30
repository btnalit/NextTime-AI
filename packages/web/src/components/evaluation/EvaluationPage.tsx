import type { EvalSuiteSummaryWire, EvalSuiteWire } from '@nexttime/shared';
import { useCallback, useMemo, useState } from 'react';
import { type Resource, useResource } from '../../hooks/useResource.js';
import { useRoleCan } from '../../hooks/useRoleCan.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { pinnedWorkerName, suiteSummaryOf, workerChoices } from '../../lib/evaluation.js';
import { formatDateTime, formatRelative, shortId } from '../../lib/format.js';
import { type Translate, useT } from '../../lib/i18n.js';
import { breadcrumbFor } from '../../lib/nav.js';
import type { WorkerDefinitionSummary } from '../../lib/tasks.js';
import { usePrincipalNames } from '../approvals/useDirectoryNames.js';
import { Button } from '../kit/button.js';
import { EmptyState } from '../kit/empty-state.js';
import { ErrorBanner } from '../kit/error-banner.js';
import { List, ListRow } from '../kit/list-row.js';
import { MasterDetail, nothingToPick } from '../kit/master-detail.js';
import { PageHeader } from '../kit/page-header.js';
import { SkeletonRows } from '../kit/skeleton.js';
import { CreateSuiteSheet } from './CreateSuiteSheet.js';
import { SuiteDetail } from './SuiteDetail.js';

export interface EvaluationPageProps {
  readonly http: CapabilityCaller;
  readonly suiteId?: string;
  readonly onSelectSuite: (suiteId: string | null) => void;
}

/**
 * components/evaluation/EvaluationPage (S10 E3-1a, coordinator fork 7 = a): 治理 → 评测 — the
 * workspace's evaluation suites (`list_eval_suites`) as a master-detail page (`kit/master-detail`,
 * like 任务): the list, and one suite's detail (`SuiteDetail`). Every person reads them (an auditor
 * included); a builder or the owner creates one (`CreateSuiteSheet`) and changes it. Cases (E3-1b)
 * and evaluation runs (E3-2) will join a suite here; the route already carries a tab segment
 * (`#/govern/evaluation/suites/<id>`) for them.
 *
 * Worker names come from `list_worker_definitions{kind:'worker'}` (published rows, every version)
 * — the same list the create form picks from and a repin chooses a version in.
 */
export function EvaluationPage({ http, suiteId, onSelectSuite }: EvaluationPageProps) {
  const t = useT();
  const can = useRoleCan(http);
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
              aria-busy={suites.state.status === 'ready' && suites.state.refreshing}
              disabled={suites.state.status === 'ready' && suites.state.refreshing}
              onClick={() => void suites.reload()}
            >
              {t('刷新', 'Refresh')}
            </Button>
            {canCreate ? (
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
