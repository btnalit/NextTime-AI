import type {
  EvalFixtureGateWire,
  EvalSuiteWire,
  GatekeeperSummaryWire,
  OperationSummaryWire,
} from '@nexttime/shared';
import { type RefObject, useCallback, useEffect, useRef, useState } from 'react';
import { useResource } from '../../hooks/useResource.js';
import { useRoleCan } from '../../hooks/useRoleCan.js';
import { workerItemId } from '../../lib/catalog.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { type ErrorOverrides, isVersionChangedError } from '../../lib/errors.js';
import {
  liveStateNotice,
  operationDiffParts,
  pinnedWorkerName,
  shownName,
  suiteChangeText,
  syncPreview,
} from '../../lib/evaluation.js';
import { actionKindTagText, formatDateTime, formatRelative } from '../../lib/format.js';
import { type Translate, useT } from '../../lib/i18n.js';
import { hrefs } from '../../lib/router.js';
import type { WorkerDefinitionSummary } from '../../lib/tasks.js';
import { Button } from '../kit/button.js';
import { Confirm } from '../kit/confirm.js';
import { CopyButton } from '../kit/copy-button.js';
import { ErrorBanner } from '../kit/error-banner.js';
import { Field, describedBy } from '../kit/field.js';
import { InlineError } from '../kit/inline-error.js';
import { KeyValue, type KeyValueItem } from '../kit/key-value.js';
import { Notice } from '../kit/notice.js';
import { RefChip } from '../kit/ref-chip.js';
import { Select } from '../kit/select.js';
import { SkeletonRows } from '../kit/skeleton.js';
import { StatusChip } from '../kit/status-chip.js';
import { StillNeeded } from '../kit/still-needed.js';
import { Textarea } from '../kit/textarea.js';

export interface SuiteDetailProps {
  readonly http: CapabilityCaller;
  readonly suiteId: string;
  /** `list_worker_definitions{kind:'worker'}` (published rows) — names the pinned Worker and offers
   *  the versions a repin can pick; `undefined` while it loads. */
  readonly definitions: readonly WorkerDefinitionSummary[] | undefined;
  readonly principalNames: ReadonlyMap<string, string>;
  /** The suite as a change (or a re-read after one) left it, for the list beside it. */
  readonly onChanged: (suite: EvalSuiteWire) => void;
}

const REASON_MAX = 500;

/** 「用例集版本 v2 → v3」: what every change does to the suite's version. */
function suiteVersionStep(version: number, t: Translate): string {
  const next = version + 1;
  return t(`用例集版本 v${version} → v${next}`, `Suite version v${version} → v${next}`);
}

/** Every write names the suite version the reader saw (`suiteVersion`); another change in between
 *  is refused (409 `version_changed`) and nothing is written. The detail re-reads the suite then. */
function writeErrors(t: Translate): ErrorOverrides {
  return {
    version_changed: t(
      '用例集在你打开之后被改过，什么也没有保存。已重新读取最新内容，看过后再操作。',
      'The suite changed after you opened it, and nothing was saved. The latest version has been loaded; look it over and try again.',
    ),
  };
}

/**
 * components/evaluation/SuiteDetail (S10 E3-1a): one evaluation suite — the Worker version it pins
 * (换版本), its canary (shown to people only; an agent never reads a suite), its fixture gates (the
 * real gates' published operations frozen into it, with whether each still matches its gate, 同步
 * and 移除), and every version's change. Each write moves the suite one version on; the console
 * names the version it showed, so a change somebody else made in between is never overwritten.
 */
export function SuiteDetail({
  http,
  suiteId,
  definitions,
  principalNames,
  onChanged,
}: SuiteDetailProps) {
  const t = useT();
  const can = useRoleCan(http);
  const load = useCallback(
    () => http.call<EvalSuiteWire>('get_eval_suite', { suiteId }),
    [http, suiteId],
  );
  const suite = useResource(load);
  const mutate = suite.mutate;
  // A removed gate takes its card, and the 移除 that had focus, with it.
  const [gatesSection, focusGatesSection] = useFocusAfterChange<HTMLElement>();

  const reread = useCallback(async () => {
    const fresh = await http.call<EvalSuiteWire>('get_eval_suite', { suiteId });
    mutate(() => fresh);
    onChanged(fresh);
  }, [http, suiteId, mutate, onChanged]);

  if (suite.state.status === 'loading') {
    return (
      <SkeletonRows
        count={4}
        label={t('正在加载用例集', 'Loading evaluation suite')}
        testId="eval-suite-loading"
      />
    );
  }
  if (suite.state.status === 'error') {
    return (
      <ErrorBanner
        error={suite.state.error}
        title={t('无法加载用例集', 'Could not load the evaluation suite')}
        onRetry={() => void suite.reload()}
        testId="eval-suite-error"
      />
    );
  }
  const data = suite.state.data;

  /** The fields every change carries: the suite, and the version the reader saw. */
  const at = { suiteId: data.id, suiteVersion: data.version };

  /** One governed change at the version shown; the result replaces the suite. A stale version
   *  re-reads the suite and rethrows, so the confirm says what happened and stays open. */
  async function change(write: () => Promise<EvalSuiteWire>): Promise<void> {
    try {
      const next = await write();
      mutate(() => next);
      onChanged(next);
    } catch (err) {
      if (isVersionChangedError(err)) await reread().catch(() => undefined);
      throw err;
    }
  }

  const workerName = pinnedWorkerName(definitions, data.workerDefinition);
  const pinDeprecated = data.workerDefinition.status !== 'published';
  const liveGateIds = new Set(data.fixtureGates.map((gate) => gate.gatekeeperId));

  const overview: KeyValueItem[] = [
    {
      key: 'worker',
      label: t('钉住的 Worker', 'Pinned Worker'),
      value: (
        <span className="row-wrap">
          <RefChip
            kind="workerDefinition"
            id={data.workerDefinition.id}
            name={workerName ? `${workerName} v${data.workerDefinition.version}` : null}
            href={hrefs.catalog(
              'workers',
              workerItemId({
                id: data.workerDefinition.id,
                version: data.workerDefinition.version,
              }),
            )}
            http={http}
            size="s"
            testId="eval-suite-worker"
          />
          {workerName === undefined ? (
            <span className="text-3 text-small">v{data.workerDefinition.version}</span>
          ) : null}
          {pinDeprecated ? (
            <StatusChip
              machine="publishable"
              status={data.workerDefinition.status}
              size="s"
              testId="eval-suite-worker-status"
            />
          ) : null}
          {can('repin_eval_suite') !== false ? (
            <RepinConfirm
              suite={data}
              definitions={definitions}
              onRepin={(version, reason) =>
                change(() =>
                  http.call<EvalSuiteWire>('repin_eval_suite', {
                    ...at,
                    workerDefinitionVersion: version,
                    ...(reason !== '' ? { reason } : {}),
                  }),
                )
              }
            />
          ) : null}
        </span>
      ),
    },
    {
      key: 'version',
      label: t('用例集版本', 'Suite version'),
      value: <span className="tabular">v{data.version}</span>,
    },
    {
      key: 'canary',
      label: 'canary',
      value: (
        <span className="stack-s">
          <span className="row-wrap">
            <span className="mono wrap-anywhere" data-testid="eval-suite-canary">
              {data.canary}
            </span>
            <CopyButton value={data.canary} label={t('复制 canary', 'Copy canary')} />
          </span>
          <span className="text-3 text-small">
            {t(
              '这串标记只出现在用例集里。它若出现在智能体可读的地方（对话、图谱、Skill），说明评测内容泄露了。',
              'This marker exists only in the suite. If it ever shows up where an agent can read (a chat, the graph, a Skill), evaluation content has leaked.',
            )}
          </span>
        </span>
      ),
    },
    {
      key: 'created',
      label: t('创建', 'Created'),
      value: (
        <span className="row-wrap">
          <RefChip
            kind="principal"
            id={data.createdBy}
            name={principalNames.get(data.createdBy) ?? null}
            http={http}
            size="s"
          />
          <time className="text-3" title={formatDateTime(data.createdAt)}>
            {formatRelative(data.createdAt)}
          </time>
        </span>
      ),
    },
  ];

  return (
    <div className="stack" data-testid="eval-suite-detail" data-suite-id={data.id}>
      <header className="stack-s">
        <div className="row-wrap" style={{ justifyContent: 'space-between' }}>
          <h2 className="catalog-detail-title wrap-anywhere" data-testid="eval-suite-title">
            {data.name}
          </h2>
          <span className="text-3 tabular">
            {t(`用例集 v${data.version}`, `Suite v${data.version}`)}
          </span>
        </div>
        {data.description !== '' ? (
          <p className="pre-wrap text-2" data-testid="eval-suite-description">
            {data.description}
          </p>
        ) : null}
        <p className="text-3 text-small">
          {t(
            '用例集只给人看：智能体的搜索、图谱和工具都读不到它。',
            'A suite is shown to people only: no agent search, graph read or tool reaches it.',
          )}
        </p>
      </header>

      <section className="stack-s">
        <span className="section-title">{t('概览', 'Overview')}</span>
        <KeyValue items={overview} testId="eval-suite-overview" />
        {pinDeprecated ? (
          <Notice tone="warn" testId="eval-suite-worker-deprecated">
            {t(
              `钉住的 Worker v${data.workerDefinition.version} 已经弃用。用例集照旧按这个版本记录；需要时用「换版本」改钉一个已发布的版本。`,
              `The pinned Worker v${data.workerDefinition.version} is deprecated. The suite still records this version; repin a published one with “Change version” when needed.`,
            )}
          </Notice>
        ) : null}
      </section>

      <section
        ref={gatesSection}
        tabIndex={-1}
        aria-label={t('夹具门', 'Fixture gates')}
        className="stack-s"
        data-testid="eval-suite-fixture-gates"
      >
        <div className="row-wrap" style={{ justifyContent: 'space-between' }}>
          <span className="section-title">{t('夹具门', 'Fixture gates')}</span>
          {can('add_eval_fixture_gate') !== false ? (
            <AddFixtureGateConfirm
              http={http}
              liveGateIds={liveGateIds}
              suiteVersion={data.version}
              onAdd={(gatekeeperId) =>
                change(() =>
                  http.call<EvalSuiteWire>('add_eval_fixture_gate', { ...at, gatekeeperId }),
                )
              }
            />
          ) : null}
        </div>
        <p className="text-3 text-small">
          {t(
            '夹具门冻结一个门的名字和已发布操作：评测时 Worker 看到同样的工具，由夹具作答，不会调用真实系统。',
            'A fixture gate freezes a gate’s name and published operations: under evaluation the Worker sees the same tools, answered by fixtures, and no real system is called.',
          )}
        </p>
        {data.fixtureGates.length === 0 ? (
          <p className="text-3" data-testid="eval-suite-fixture-gates-empty">
            {t('还没有夹具门。', 'No fixture gate yet.')}
          </p>
        ) : (
          data.fixtureGates.map((gate) => (
            <FixtureGateCard
              key={gate.gatekeeperId}
              http={http}
              gate={gate}
              suiteVersion={data.version}
              principalNames={principalNames}
              onSync={
                can('sync_eval_fixture_gate') !== false
                  ? () =>
                      change(() =>
                        http.call<EvalSuiteWire>('sync_eval_fixture_gate', {
                          ...at,
                          gatekeeperId: gate.gatekeeperId,
                        }),
                      )
                  : undefined
              }
              onRemove={
                can('remove_eval_fixture_gate') !== false
                  ? async (reason) => {
                      await change(() =>
                        http.call<EvalSuiteWire>('remove_eval_fixture_gate', {
                          ...at,
                          gatekeeperId: gate.gatekeeperId,
                          reason,
                        }),
                      );
                      focusGatesSection();
                    }
                  : undefined
              }
            />
          ))
        )}
      </section>

      <section className="stack-s" data-testid="eval-suite-history">
        <span className="section-title">{t('变更记录', 'History')}</span>
        <ol className="eval-suite-history">
          {[...data.history]
            .sort((a, b) => b.version - a.version)
            .map((entry) => (
              <li
                key={entry.version}
                data-testid="eval-suite-history-entry"
                data-version={entry.version}
              >
                <span className="row-wrap">
                  <span className="tag tabular">v{entry.version}</span>
                  <span>{suiteChangeText(entry, t)}</span>
                </span>
                <span className="row-wrap text-3 text-small">
                  <RefChip
                    kind="principal"
                    id={entry.actorId}
                    name={principalNames.get(entry.actorId) ?? null}
                    http={http}
                    size="s"
                    testId="eval-suite-history-actor"
                  />
                  <span className="meta-sep" />
                  <time title={formatDateTime(entry.createdAt)}>
                    {formatRelative(entry.createdAt)}
                  </time>
                </span>
                {entry.reason !== null ? (
                  <span
                    className="pre-wrap text-2 text-small"
                    data-testid="eval-suite-history-reason"
                  >
                    {t('原因：', 'Reason: ')}
                    {entry.reason}
                  </span>
                ) : null}
              </li>
            ))}
        </ol>
      </section>
    </div>
  );
}

/** A read that runs whenever `key` is set and changes; idle while it is `null`. */
function useLoadWhen<T>(
  key: string | null,
  load: () => Promise<T>,
): {
  readonly status: 'idle' | 'loading' | 'ready' | 'error';
  readonly data?: T;
  readonly error?: unknown;
} {
  const [state, setState] = useState<{
    readonly key: string | null;
    readonly status: 'idle' | 'loading' | 'ready' | 'error';
    readonly data?: T;
    readonly error?: unknown;
  }>({ key: null, status: 'idle' });
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` decides when to read; `load` is a fresh closure every render
  useEffect(() => {
    if (key === null) {
      setState({ key: null, status: 'idle' });
      return;
    }
    let cancelled = false;
    setState({ key, status: 'loading' });
    load().then(
      (data) => !cancelled && setState({ key, status: 'ready', data }),
      (error: unknown) => !cancelled && setState({ key, status: 'error', error }),
    );
    return () => {
      cancelled = true;
    };
  }, [key]);
  return state.key === key ? state : { status: key === null ? 'idle' : 'loading' };
}

/** A change that takes away the control that had focus — the 同步 that leaves with its gate's
 *  mismatch, a removed gate's whole card (#802 UX P3-2) — hands focus to `target` instead of the
 *  page. `request` once the change is made; the move waits for the closing confirm's own focus
 *  return, which finds its control gone, and leaves alone any focus the reader has moved on to. */
function useFocusAfterChange<T extends HTMLElement>(): readonly [RefObject<T>, () => void] {
  const target = useRef<T>(null);
  const [requested, setRequested] = useState(0);
  useEffect(() => {
    if (requested === 0) return;
    const timer = window.setTimeout(() => {
      const active = document.activeElement;
      if (active === null || active === document.body || !active.isConnected) {
        target.current?.focus();
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [requested]);
  const request = useCallback(() => setRequested((n) => n + 1), []);
  return [target, request];
}

/** The gate's published Operations as `list_operations` shows the reader now (by name). */
async function publishedOperations(
  http: CapabilityCaller,
  gatekeeperId: string,
): Promise<readonly OperationSummaryWire[]> {
  const page = await http.call<{ items: readonly OperationSummaryWire[] }>('list_operations', {
    gatekeeperId,
  });
  return page.items
    .filter((op) => op.status === 'published')
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function RepinConfirm({
  suite,
  definitions,
  onRepin,
}: {
  readonly suite: EvalSuiteWire;
  readonly definitions: readonly WorkerDefinitionSummary[] | undefined;
  readonly onRepin: (version: number, reason: string) => Promise<void>;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [version, setVersion] = useState('');
  const [reason, setReason] = useState('');
  const pinned = suite.workerDefinition;
  const versions = (definitions ?? [])
    .filter(
      (row) =>
        row.id === pinned.id &&
        row.kind === 'worker' &&
        row.status === 'published' &&
        row.version !== pinned.version,
    )
    .map((row) => row.version)
    .sort((a, b) => b - a);
  const noOther = definitions !== undefined && versions.length === 0;
  const reasonId = 'eval-suite-repin-reason';
  return (
    <Confirm
      tier="medium"
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setReason('');
      }}
      anchor={
        <span className="row-wrap">
          <Button
            variant="ghost"
            size="s"
            disabled={noOther || definitions === undefined}
            onClick={() => {
              // The newest other published version is the usual pick.
              setVersion(versions[0] !== undefined ? String(versions[0]) : '');
              setOpen(true);
            }}
            data-testid="eval-suite-repin-trigger"
          >
            {t('换版本', 'Change version')}
          </Button>
          <StillNeeded
            reason={
              noOther
                ? t(
                    '这个 Worker 没有别的已发布版本可换。',
                    'This Worker has no other published version to pin.',
                  )
                : null
            }
            testId="eval-suite-repin-none"
          />
        </span>
      }
      title={t('换钉住的 Worker 版本', 'Change the pinned Worker version')}
      description={t(
        '用例集改钉同一个 Worker 的另一个已发布版本；之前的用例集版本仍记着原来的版本。',
        'The suite pins another published version of the same Worker; earlier suite versions still record the old one.',
      )}
      target={suite.name}
      impact={[
        `Worker v${pinned.version} → v${version === '' ? '?' : version}`,
        suiteVersionStep(suite.version, t),
      ]}
      confirmLabel={t('换版本', 'Change version')}
      confirmDisabled={version === ''}
      onConfirm={() => onRepin(Number(version), reason.trim())}
      errorOverrides={writeErrors(t)}
      testId="eval-suite-repin"
    >
      <Field id="eval-suite-repin-version" label={t('改钉的版本', 'Version to pin')} required>
        <Select
          id="eval-suite-repin-version"
          aria-label={t('改钉的版本', 'Version to pin')}
          value={version}
          onChange={(event) => setVersion(event.target.value)}
          data-testid="eval-suite-repin-version"
        >
          {versions.map((v) => (
            <option key={v} value={String(v)}>
              v{v}
            </option>
          ))}
        </Select>
      </Field>
      <Field
        id={reasonId}
        label={t('原因', 'Reason')}
        hint={t('可选，记入变更记录。', 'Optional; kept in the history.')}
      >
        <Textarea
          id={reasonId}
          aria-label={t('原因', 'Reason')}
          value={reason}
          maxLength={REASON_MAX}
          onChange={(event) => setReason(event.target.value)}
          aria-describedby={describedBy(reasonId, true, false)}
          data-testid={reasonId}
        />
      </Field>
    </Confirm>
  );
}

function AddFixtureGateConfirm({
  http,
  liveGateIds,
  suiteVersion,
  onAdd,
}: {
  readonly http: CapabilityCaller;
  readonly liveGateIds: ReadonlySet<string>;
  readonly suiteVersion: number;
  readonly onAdd: (gatekeeperId: string) => Promise<void>;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [gateId, setGateId] = useState('');
  const gates = useLoadWhen(open ? 'gates' : null, async () => {
    const page = await http.call<{ items: readonly GatekeeperSummaryWire[] }>(
      'list_gatekeepers',
      {},
    );
    return page.items;
  });
  const operations = useLoadWhen(open && gateId !== '' ? gateId : null, () =>
    publishedOperations(http, gateId),
  );
  const choices = (gates.data ?? [])
    .filter((gate) => !liveGateIds.has(gate.id))
    .sort((a, b) => a.name.localeCompare(b.name));
  const chosen = choices.find((gate) => gate.id === gateId);
  const nothingPublished = operations.status === 'ready' && (operations.data ?? []).length === 0;
  const missing = [
    gateId === '' ? t('选择一个门', 'choose a gate') : null,
    nothingPublished
      ? t('选一个有已发布操作的门', 'choose a gate with a published operation')
      : null,
  ].filter((item): item is string => item !== null);

  return (
    <Confirm
      tier="medium"
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setGateId('');
      }}
      anchor={
        <Button
          variant="secondary"
          size="s"
          onClick={() => setOpen(true)}
          data-testid="eval-suite-add-gate-trigger"
        >
          {t('添加夹具门', 'Add fixture gate')}
        </Button>
      }
      title={t('添加夹具门', 'Add fixture gate')}
      description={t(
        '把这个门的名字和它现在已发布的操作冻结进用例集。之后门再变，夹具门不跟着变，需要时再同步。',
        'Freezes the gate’s name and the operations it publishes now into the suite. Later changes to the gate do not follow; sync it when needed.',
      )}
      target={chosen === undefined ? undefined : shownName(chosen.name)}
      impact={[suiteVersionStep(suiteVersion, t)]}
      confirmLabel={t('添加', 'Add')}
      confirmDisabled={missing.length > 0 || operations.status !== 'ready'}
      onConfirm={() => onAdd(gateId)}
      errorOverrides={writeErrors(t)}
      testId="eval-suite-add-gate"
    >
      {gates.status === 'error' ? (
        <InlineError error={gates.error} testId="eval-suite-add-gate-gates-error" />
      ) : gates.status === 'ready' && choices.length === 0 ? (
        <p className="text-3" data-testid="eval-suite-add-gate-none">
          {t(
            '工作区的门都已经在这个用例集里了。',
            'Every gate in the workspace is already in this suite.',
          )}
        </p>
      ) : (
        <Field id="eval-suite-add-gate-select" label={t('门', 'Gate')} required>
          <Select
            id="eval-suite-add-gate-select"
            aria-label={t('门', 'Gate')}
            value={gateId}
            disabled={gates.status !== 'ready'}
            onChange={(event) => setGateId(event.target.value)}
            data-testid="eval-suite-add-gate-select"
          >
            <option value="">
              {gates.status === 'ready'
                ? t('选择一个门', 'Choose a gate')
                : t('加载中…', 'Loading…')}
            </option>
            {choices.map((gate) => (
              <option key={gate.id} value={gate.id}>
                {shownName(gate.name)}
              </option>
            ))}
          </Select>
        </Field>
      )}
      {operations.status === 'error' ? (
        <InlineError error={operations.error} testId="eval-suite-add-gate-ops-error" />
      ) : null}
      {operations.status === 'ready' ? (
        nothingPublished ? (
          <Notice tone="warn" testId="eval-suite-add-gate-unpublished">
            {t(
              '这个门还没有已发布的操作，没有可冻结的内容。先在「系统与授权」发布它的操作。',
              'This gate publishes no operation yet, so there is nothing to freeze. Publish its operations under Systems & access first.',
            )}
          </Notice>
        ) : (
          <div className="stack-s" data-testid="eval-suite-add-gate-preview">
            <span className="text-small text-2">
              {t('将冻结这些已发布的操作：', 'These published operations will be frozen:')}
            </span>
            <OperationList operations={operations.data ?? []} />
          </div>
        )
      ) : null}
      <StillNeeded items={missing} testId="eval-suite-add-gate-missing" />
    </Confirm>
  );
}

function OperationList({
  operations,
}: {
  readonly operations: readonly {
    readonly name: string;
    readonly version: number;
    readonly mode: string;
    readonly description?: string | null;
  }[];
}) {
  return (
    <ul className="stack-s eval-fixture-operations" data-testid="eval-fixture-operations">
      {operations.map((op) => (
        <li key={op.name} className="stack-s" data-testid="eval-fixture-operation">
          <span className="row-wrap">
            <span className="mono wrap-anywhere" data-testid="eval-fixture-operation-name">
              {actionKindTagText(op.name)}
            </span>
            <span className="text-3 text-small tabular">v{op.version}</span>
            <StatusChip machine="operationMode" status={op.mode} size="s" />
          </span>
          {op.description ? <span className="text-3 text-small">{op.description}</span> : null}
        </li>
      ))}
    </ul>
  );
}

function FixtureGateCard({
  http,
  gate,
  suiteVersion,
  principalNames,
  onSync,
  onRemove,
}: {
  readonly http: CapabilityCaller;
  readonly gate: EvalFixtureGateWire;
  readonly suiteVersion: number;
  readonly principalNames: ReadonlyMap<string, string>;
  /** Absent when the reader's role may not sync (or remove): no button then. */
  readonly onSync?: () => Promise<void>;
  readonly onRemove?: (reason: string) => Promise<void>;
}) {
  const t = useT();
  const notice = liveStateNotice(gate.liveState, t);
  const gateName = shownName(gate.gateName);
  // A sync that brings the gate back in line takes its 同步 button away.
  const [card, focusCard] = useFocusAfterChange<HTMLDivElement>();
  return (
    <div
      ref={card}
      tabIndex={-1}
      aria-label={t(`夹具门 ${gateName}`, `Fixture gate ${gateName}`)}
      className="stack-s rounded-m border border-border p-3"
      data-testid="eval-fixture-gate"
      data-gate-id={gate.gatekeeperId}
      data-live-state={gate.liveState}
    >
      <div className="row-wrap" style={{ justifyContent: 'space-between' }}>
        <span className="row-wrap">
          <RefChip
            kind="gatekeeper"
            id={gate.gatekeeperId}
            name={gateName}
            href={hrefs.gatekeeper(gate.gatekeeperId)}
            size="s"
          />
          <span className="text-3 text-small">
            {t(`用例集 v${gate.addedInVersion} 时冻结`, `frozen at suite v${gate.addedInVersion}`)}
          </span>
          <RefChip
            kind="principal"
            id={gate.addedBy}
            name={principalNames.get(gate.addedBy) ?? null}
            http={http}
            size="s"
            testId="eval-fixture-gate-added-by"
          />
        </span>
        <span className="row-wrap">
          {onSync !== undefined && gate.liveState === 'changed' ? (
            <SyncFixtureGateConfirm
              http={http}
              gate={gate}
              suiteVersion={suiteVersion}
              onSync={async () => {
                await onSync();
                focusCard();
              }}
            />
          ) : null}
          {onRemove !== undefined ? (
            <RemoveFixtureGateConfirm gate={gate} suiteVersion={suiteVersion} onRemove={onRemove} />
          ) : null}
        </span>
      </div>
      {notice !== null ? (
        <Notice tone="warn" testId="eval-fixture-gate-notice">
          {notice}
        </Notice>
      ) : null}
      <OperationList operations={gate.operations} />
    </div>
  );
}

function SyncFixtureGateConfirm({
  http,
  gate,
  suiteVersion,
  onSync,
}: {
  readonly http: CapabilityCaller;
  readonly gate: EvalFixtureGateWire;
  readonly suiteVersion: number;
  readonly onSync: () => Promise<void>;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const now = useLoadWhen(open ? gate.gatekeeperId : null, () =>
    publishedOperations(http, gate.gatekeeperId),
  );
  const preview = now.status === 'ready' ? syncPreview(gate.operations, now.data ?? []) : null;
  const gateName = shownName(gate.gateName);
  const parts = preview === null ? [] : operationDiffParts(preview, t);
  return (
    <Confirm
      tier="medium"
      open={open}
      onOpenChange={setOpen}
      anchor={
        <Button
          variant="secondary"
          size="s"
          onClick={() => setOpen(true)}
          data-testid="eval-fixture-gate-sync-trigger"
        >
          {t('同步', 'Sync')}
        </Button>
      }
      title={t(`同步夹具门 ${gateName}`, `Sync fixture gate ${gateName}`)}
      description={t(
        '按门现在已发布的操作重新冻结。之前的用例集版本仍保留原来冻结的定义。',
        'Freezes the gate again from the operations it publishes now. Earlier suite versions keep the definitions frozen before.',
      )}
      target={gateName}
      impact={[...parts, suiteVersionStep(suiteVersion, t)]}
      confirmLabel={t('同步', 'Sync')}
      onConfirm={onSync}
      errorOverrides={writeErrors(t)}
      testId="eval-fixture-gate-sync"
    >
      {now.status === 'error' ? (
        <InlineError error={now.error} testId="eval-fixture-gate-sync-preview-error" />
      ) : now.status === 'ready' && parts.length === 0 ? (
        <p className="text-3 text-small" data-testid="eval-fixture-gate-sync-same-names">
          {t(
            '操作的名字和版本都没有变，变的是门本身（比如门改了名字）；同步后以门现在的样子为准。',
            'No operation name or version changed; the gate itself did (it was renamed, for instance). After syncing, the gate as it is now applies.',
          )}
        </p>
      ) : null}
    </Confirm>
  );
}

function RemoveFixtureGateConfirm({
  gate,
  suiteVersion,
  onRemove,
}: {
  readonly gate: EvalFixtureGateWire;
  readonly suiteVersion: number;
  readonly onRemove: (reason: string) => Promise<void>;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const trimmed = reason.trim();
  const reasonId = `eval-fixture-gate-remove-reason-${gate.gatekeeperId}`;
  const gateName = shownName(gate.gateName);
  return (
    <Confirm
      tier="medium"
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setReason('');
      }}
      anchor={
        <Button
          variant="ghost"
          size="s"
          onClick={() => setOpen(true)}
          data-testid="eval-fixture-gate-remove-trigger"
        >
          {t('移除', 'Remove')}
        </Button>
      }
      title={t(`移除夹具门 ${gateName}`, `Remove fixture gate ${gateName}`)}
      description={t(
        '之后的评测不再有这个门的工具；之前的用例集版本仍保留它。原因记入变更记录。',
        'Later evaluation has none of this gate’s tools; earlier suite versions still hold it. The reason is kept in the history.',
      )}
      target={gateName}
      impact={[suiteVersionStep(suiteVersion, t)]}
      confirmLabel={t('移除', 'Remove')}
      danger
      confirmDisabled={trimmed === ''}
      onConfirm={() => onRemove(trimmed)}
      errorOverrides={writeErrors(t)}
      testId="eval-fixture-gate-remove"
    >
      <Field
        id={reasonId}
        label={t('移除原因', 'Reason')}
        hint={t('必填，记入变更记录。', 'Required; kept in the history.')}
        required
      >
        <Textarea
          id={reasonId}
          aria-label={t('移除原因', 'Removal reason')}
          aria-required
          value={reason}
          maxLength={REASON_MAX}
          onChange={(event) => setReason(event.target.value)}
          aria-describedby={describedBy(reasonId, true, false)}
          data-testid="eval-fixture-gate-remove-reason"
        />
      </Field>
    </Confirm>
  );
}
