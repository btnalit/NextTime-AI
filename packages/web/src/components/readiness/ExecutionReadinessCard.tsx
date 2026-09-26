import type { ExecutionReadinessWire } from '@nexttime/shared';
import { useState } from 'react';
import type { CapabilityCaller } from '../../lib/clients.js';
import { shortId } from '../../lib/format.js';
import { type Translate, useT } from '../../lib/i18n.js';
import { executionReadinessMissingCodeLabel } from '../../lib/labels.js';
import { Button } from '../kit/button.js';
import { ErrorBanner } from '../kit/error-banner.js';
import { Notice } from '../kit/notice.js';
import {
  gateReasonHref,
  gateReasonLink,
  gateReasonText,
  missingCauseText,
  missingKey,
  missingLinkHref,
  missingLinkLabel,
} from './readiness-copy.js';
import { useExecutionReadiness } from './useExecutionReadiness.js';

export interface ExecutionReadinessCardProps {
  readonly http: CapabilityCaller;
}

/**
 * components/readiness/ExecutionReadinessCard: 对话页顶部就绪状态条（console redesign P2-b,
 * docs/console-redesign-plan-2026-09-25.md §4/§6 P2 "对话状态条"；P3-3 V2 重做）——原来 J1 的
 * "执行就绪" 大卡片先收窄成一条常驻状态条，P3-3 再去掉它默认的琥珀告警：容器永远中性
 * (`Notice` 不传 `tone`)，一行摘要"我的智能体能用 n/m 个系统"，每个系统一枚 chip（名字 + 可直接调用 /
 * 需委派 / 用不了——只有这枚 chip 本身在"用不了"时是琥珀，代表这个成员自己可以修或可以问的具体
 * 阻碍，不是整条状态条变成告警）。有系统用不了时才出现"N 个用不了 · 查看原因"，点开是行内展开
 * （不跳新页），复用原来逐门的详细行（原因 + 修复链接）。零系统时收成一行——先去接入一个系统，同样
 * 中性，不是"新工作区=出问题"。两个不同门实例恰好同名时，展示名附加短 id 后缀（`shortId`）区分。
 *
 * **Placement**（沿用 J1 时期的结论，见历史 PR 报告）：`execution_readiness` 是
 * `scope:'workspace'`，`PlatformOverviewPage` 没有当前工作区，也没有单独的工作区概览页——签入成员/
 * owner/operator 落地的就是 `#/work/chats`，这条状态条挂在这里（`ChatListPage.tsx`），紧跟页头。
 *
 * 读调用方自己的 readiness（`useExecutionReadiness`），不传 `principalId`——member 起就能读自己的
 * （`execution_readiness` 的 `minRole:'member'`）；operator/owner 才能读别人的，这条状态条不做那件
 * 事（可选的成员切换器留给后续）。
 */
export function ExecutionReadinessCard({ http }: ExecutionReadinessCardProps) {
  const t = useT();
  const readiness = useExecutionReadiness(http);

  if (readiness.state.status === 'loading') {
    return (
      <p className="text-3 text-small" data-testid="execution-readiness-loading">
        {t('正在检查智能体能用什么…', 'Checking what your agent can use…')}
      </p>
    );
  }
  if (readiness.state.status === 'error') {
    return (
      <ErrorBanner
        error={readiness.state.error}
        title={t('无法加载执行就绪状态', 'Could not load execution readiness')}
        onRetry={() => void readiness.reload()}
        retryLabel={t('重试', 'Retry')}
        testId="execution-readiness-error"
      />
    );
  }
  return <ExecutionReadinessStrip data={readiness.state.data} />;
}

type GateWire = ExecutionReadinessWire['gates'][number];

const GATE_CHIP_TONE: Readonly<Record<GateWire['status'], string>> = {
  direct: 'chip-ok',
  via_worker: 'chip-info',
  unreachable: 'chip-warn',
};

function gateChipLabel(status: GateWire['status'], t: Translate): string {
  switch (status) {
    case 'direct':
      return t('可直接调用', 'Direct');
    case 'via_worker':
      return t('需委派', 'Via a Worker');
    case 'unreachable':
      return t('用不了', 'Unusable');
  }
}

/** Console redesign P3-3 (V2 "按系统去重"): two gate *instances* can share a display `name` — a
 *  chip list built straight off `name` would then show the same label twice with no way to tell
 *  them apart. Only the names that actually collide get a short id suffix, so the common case (no
 *  collision) stays exactly the bare name. */
function gateDisplayNames(gates: readonly GateWire[]): ReadonlyMap<string, string> {
  const counts = new Map<string, number>();
  for (const gate of gates) counts.set(gate.name, (counts.get(gate.name) ?? 0) + 1);
  const names = new Map<string, string>();
  for (const gate of gates) {
    names.set(
      gate.gateId,
      (counts.get(gate.name) ?? 0) > 1 ? `${gate.name} · ${shortId(gate.gateId)}` : gate.name,
    );
  }
  return names;
}

function ExecutionReadinessStrip({ data }: { readonly data: ExecutionReadinessWire }) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const gateNames = new Map(data.gates.map((gate) => [gate.gateId, gate.name]));
  const displayNames = gateDisplayNames(data.gates);
  const workerNames = new Map(
    data.workers.map((worker) => [worker.definitionId, worker.name ?? worker.definitionId]),
  );

  // No system enabled in this workspace at all — a fresh workspace's normal Day-1 state, not a
  // blocker this member caused, so the strip stays neutral (no `tone`) and just points at the
  // first step.
  if (data.gates.length === 0) {
    const first = data.missing.find((item) => item.code === 'no_enabled_gate');
    return (
      <Notice testId="execution-readiness-body">
        <ul
          className="stack-s"
          style={{ listStyle: 'none', margin: 0, padding: 0 }}
          data-testid="execution-readiness-missing"
        >
          {first ? (
            <li className="row-wrap" data-testid="execution-readiness-missing-item">
              <span>{missingCauseText(first, gateNames, t)}</span>
              {missingLinkHref(first) !== undefined ? (
                <a href={missingLinkHref(first)} className="link-inline">
                  {missingLinkLabel(first, t)}
                </a>
              ) : null}
            </li>
          ) : null}
        </ul>
      </Notice>
    );
  }

  const usableCount = data.gates.filter((gate) => gate.status !== 'unreachable').length;
  const unusable = data.gates.filter((gate) => gate.status === 'unreachable');
  // Workspace-wide gaps a per-gate chip cannot say on its own (no specific gate to pin them to) —
  // everything else in `missing[]` already restates one gate's own `status`/`reason` below, so
  // showing both would say the same sentence twice.
  const extraMissing = data.missing.filter(
    (item) => item.gateId === undefined && item.code !== 'no_enabled_gate',
  );

  return (
    // Console redesign P3-3 (V2): the strip itself is always calm — never `tone="warn"` — even
    // when some systems are unusable. Amber lives only on that specific chip/row (the member's
    // own, fixable-or-askable blocker), never on the whole container.
    <Notice testId="execution-readiness-body">
      <div className="stack-s">
        <div className="row-wrap">
          <strong data-testid="execution-readiness-summary">
            {t(
              `我的智能体能用 ${usableCount}/${data.gates.length} 个系统`,
              `Your agent can use ${usableCount}/${data.gates.length} system(s)`,
            )}
          </strong>
          {/* Bugfix (PR #324 review): an inline chip per unusable gate turned "0/5 usable" into a
           *  wall of amber. Usable systems still get their own chip; every unusable one folds into
           *  the single "N 个用不了 · 查看原因" disclosure below instead of repeating itself once
           *  per gate. */}
          {data.gates
            .filter((gate) => gate.status !== 'unreachable')
            .map((gate) => (
              <span
                key={gate.gateId}
                className={`chip chip-s ${GATE_CHIP_TONE[gate.status]}`}
                data-testid="execution-readiness-gate-chip"
                data-gate-id={gate.gateId}
                data-status={gate.status}
              >
                {displayNames.get(gate.gateId) ?? gate.name}
                {'：'}
                {gateChipLabel(gate.status, t)}
              </span>
            ))}
          {unusable.length > 0 ? (
            <Button
              variant="ghost"
              size="s"
              onClick={() => setExpanded((value) => !value)}
              aria-expanded={expanded}
              data-testid="execution-readiness-toggle"
            >
              {expanded
                ? t('收起', 'Collapse')
                : t(
                    `${unusable.length} 个用不了 · 查看原因`,
                    `${unusable.length} unusable · See why`,
                  )}
            </Button>
          ) : null}
        </div>

        {expanded ? (
          <ul
            className="stack-s"
            style={{ listStyle: 'none', margin: 0, padding: 0 }}
            data-testid="execution-readiness-gates"
          >
            {data.gates.map((gate) => (
              <GateRow
                key={gate.gateId}
                gate={gate}
                displayName={displayNames.get(gate.gateId) ?? gate.name}
                workerNames={workerNames}
              />
            ))}
          </ul>
        ) : null}

        {data.ready ? (
          <div className="row" data-testid="execution-readiness-ready">
            <span className="chip chip-ok chip-s">{t('可委派', 'Can delegate')}</span>
            <span>
              {t(
                '需要多步或写操作的任务，入口 agent 已经可以委派给 Worker。',
                'Your entry agent can already delegate multi-step or write tasks to a Worker.',
              )}
            </span>
          </div>
        ) : extraMissing.length > 0 ? (
          <ul
            className="stack-s"
            style={{ listStyle: 'none', margin: 0, padding: 0 }}
            data-testid="execution-readiness-missing"
          >
            {extraMissing.map((item) => (
              <li
                key={missingKey(item)}
                className="row-wrap"
                data-testid="execution-readiness-missing-item"
              >
                <span className="chip chip-warn chip-s">
                  {executionReadinessMissingCodeLabel(item.code, t)}
                </span>
                <span>{missingCauseText(item, gateNames, t)}</span>
                {missingLinkHref(item) !== undefined ? (
                  <a href={missingLinkHref(item)} className="link-inline">
                    {missingLinkLabel(item, t)}
                  </a>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </Notice>
  );
}

function GateRow({
  gate,
  displayName,
  workerNames,
}: {
  readonly gate: GateWire;
  readonly displayName: string;
  readonly workerNames: ReadonlyMap<string, string>;
}) {
  const t = useT();
  const workers = gate.workerDefinitionIds.map((id) => workerNames.get(id) ?? id).join('、');
  return (
    <li
      className="row-wrap"
      data-testid="execution-readiness-gate"
      data-gate-id={gate.gateId}
      data-status={gate.status}
    >
      <strong>{displayName}</strong>
      {gate.status === 'direct' ? (
        <>
          <span className="chip chip-ok chip-s">{t('可直接调用', 'Callable directly')}</span>
          <span>
            {t(
              `你的智能体可以直接调用它的 ${gate.observeOperationCount} 个只读操作${
                gate.workerDefinitionIds.length > 0 ? `，也可委派给 ${workers}` : ''
              }。`,
              `Your agent can call its ${gate.observeOperationCount} read operation(s) itself${
                gate.workerDefinitionIds.length > 0 ? `, or delegate to ${workers}` : ''
              }.`,
            )}
          </span>
        </>
      ) : gate.status === 'via_worker' ? (
        <>
          <span className="chip chip-info chip-s">{t('需委派', 'Via a Worker')}</span>
          <span>
            {t(
              `你的智能体要委派给 ${workers} 才能用它。`,
              `Your agent has to delegate to ${workers} to use it.`,
            )}
          </span>
        </>
      ) : (
        <>
          <span className="chip chip-warn chip-s">{t('用不了', 'Not usable')}</span>
          <span>{gateReasonText(gate.reason, t)}</span>
          {gate.reason !== undefined && gateReasonHref(gate.reason) !== undefined ? (
            <a href={gateReasonHref(gate.reason)} className="link-inline">
              {gateReasonLink(gate.reason, t)}
            </a>
          ) : null}
        </>
      )}
    </li>
  );
}
