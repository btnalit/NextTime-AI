import type { ExecutionReadinessWire } from '@nexttime/shared';
import { useState } from 'react';
import type { CapabilityCaller } from '../../lib/clients.js';
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
 * components/readiness/ExecutionReadinessCard: 对话页顶部"我的智能体现在能用："状态条（console
 * redesign P2-b, docs/console-redesign-plan-2026-09-25.md §4/§6 P2 "对话状态条"）——原来 J1 的
 * "执行就绪" 大卡片收窄成一条常驻的紧凑状态条：一行标签 + 每个系统一枚 chip（名字 + 可直接调用 /
 * 需委派 / 用不了），有系统用不了时才出现"N 个用不了 · 查看原因"，点开是行内展开（不跳新页），复用
 * 原来逐门的详细行（原因 + 修复链接）。零系统时收成一行——先去接入一个系统。
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

function ExecutionReadinessStrip({ data }: { readonly data: ExecutionReadinessWire }) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const gateNames = new Map(data.gates.map((gate) => [gate.gateId, gate.name]));
  const workerNames = new Map(
    data.workers.map((worker) => [worker.definitionId, worker.name ?? worker.definitionId]),
  );

  // No system enabled in this workspace at all — nothing to break down system by system yet; one
  // line pointing at the first step, not a breakdown of a breakdown.
  if (data.gates.length === 0) {
    const first = data.missing.find((item) => item.code === 'no_enabled_gate');
    return (
      <Notice tone="warn" testId="execution-readiness-body">
        <ul
          className="stack-s"
          style={{ listStyle: 'none', margin: 0, padding: 0 }}
          data-testid="execution-readiness-missing"
        >
          {first ? (
            <li className="row-wrap" data-testid="execution-readiness-missing-item">
              <span>{missingCauseText(first, gateNames, t)}</span>
              <a href={missingLinkHref(first)}>{missingLinkLabel(first, t)}</a>
            </li>
          ) : null}
        </ul>
      </Notice>
    );
  }

  const unusable = data.gates.filter((gate) => gate.status === 'unreachable');
  // Workspace-wide gaps a per-gate chip cannot say on its own (no specific gate to pin them to) —
  // everything else in `missing[]` already restates one gate's own `status`/`reason` below, so
  // showing both would say the same sentence twice.
  const extraMissing = data.missing.filter(
    (item) => item.gateId === undefined && item.code !== 'no_enabled_gate',
  );

  return (
    <Notice tone={unusable.length > 0 ? 'warn' : 'info'} testId="execution-readiness-body">
      <div className="stack-s">
        <div className="row-wrap">
          <strong>{t('我的智能体现在能用：', 'My agent can use:')}</strong>
          {data.gates.map((gate) => (
            <span
              key={gate.gateId}
              className={`chip chip-s ${GATE_CHIP_TONE[gate.status]}`}
              data-testid="execution-readiness-gate-chip"
              data-gate-id={gate.gateId}
              data-status={gate.status}
            >
              {gate.name}
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
              <GateRow key={gate.gateId} gate={gate} workerNames={workerNames} />
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
                <a href={missingLinkHref(item)}>{missingLinkLabel(item, t)}</a>
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
  workerNames,
}: {
  readonly gate: GateWire;
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
      <strong>{gate.name}</strong>
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
          {gate.reason !== undefined ? (
            <a href={gateReasonHref(gate.reason)} style={{ textDecoration: 'underline' }}>
              {gateReasonLink(gate.reason, t)}
            </a>
          ) : null}
        </>
      )}
    </li>
  );
}
