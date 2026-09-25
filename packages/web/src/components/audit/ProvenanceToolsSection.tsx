import type {
  CausalChainResultWire,
  DecisionImpactResultWire,
  DecisionWire,
} from '@nexttime/shared';
import { type FormEvent, useState } from 'react';
import type { CapabilityCaller } from '../../lib/clients.js';
import { formatDateTime, formatRelative } from '../../lib/format.js';
import { auditHrefForNode } from '../../lib/graph-route.js';
import { useT } from '../../lib/i18n.js';
import { hrefs } from '../../lib/router.js';
import { Button } from '../kit/button.js';
import { ErrorBanner } from '../kit/error-banner.js';
import { Field } from '../kit/field.js';
import { RefChip } from '../kit/ref-chip.js';
import { Select } from '../kit/select.js';

export interface ProvenanceToolsSectionProps {
  readonly http: CapabilityCaller;
}

interface CausalState {
  readonly busy: boolean;
  readonly error: unknown | null;
  readonly chain: CausalChainResultWire | null;
  readonly impact: DecisionImpactResultWire | null;
}

const CAUSAL_IDLE: CausalState = { busy: false, error: null, chain: null, impact: null };

interface DecisionListState {
  readonly busy: boolean;
  readonly error: unknown | null;
  readonly items: readonly DecisionWire[] | null;
  readonly label: string | null;
}

const LIST_IDLE: DecisionListState = { busy: false, error: null, items: null, label: null };

/**
 * components/audit/ProvenanceToolsSection (S8 W4-A, ui-audit convergence-plan-2026-09-25 §2.1
 * "旅程④推理链" — `query_decisions`/`causal_chain`/`decision_impact`/`find_precedents` had a real
 * handler each (S3.2) but no console surface at all; the entry agent's own `find_*` equivalents
 * are Handle-channel and invisible here). Two tools, reusing `explain`'s own "click a chain link
 * to re-run it here" pattern (`auditHrefForNode` — the same href `ExplainSection`'s own chain
 * links use) rather than inventing a second navigation model:
 *
 *   - **因果链与影响 Causal chain & impact**: one id, tagged Fact or Decision — `causal_chain`
 *     always; `decision_impact` additionally when the id is a Decision (a Fact has no impact of
 *     its own to analyze). Each chain link is a clickable `RefChip`-style link into `explain`
 *     for that node (`#/govern/audit?nodeId=`), so "trace this Fact's own upstream chain" is one
 *     click away from any link in the result.
 *   - **先例与查询 Precedents & query**: `objectId`/`actionKindTag`/`since` feed either
 *     `find_precedents` (recency-ordered prior Decisions on the same Object/ActionType) or
 *     `query_decisions` (plain chronological query) into one shared Decision list.
 */
export function ProvenanceToolsSection({ http }: ProvenanceToolsSectionProps) {
  const t = useT();
  return (
    <section
      className="section"
      aria-labelledby="provenance-tools-title"
      data-testid="provenance-tools-section"
    >
      <div className="section-header">
        <h2 id="provenance-tools-title">{t('推理链工具', 'Reasoning-chain tools')}</h2>
      </div>
      <CausalChainTool http={http} />
      <PrecedentsTool http={http} />
    </section>
  );
}

function CausalChainTool({ http }: { readonly http: CapabilityCaller }) {
  const t = useT();
  const [kind, setKind] = useState<'fact' | 'decision'>('fact');
  const [nodeId, setNodeId] = useState('');
  const [state, setState] = useState<CausalState>(CAUSAL_IDLE);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const trimmed = nodeId.trim();
    if (!trimmed || state.busy) return;
    setState({ busy: true, error: null, chain: null, impact: null });
    try {
      const chain = await http.call<CausalChainResultWire>('causal_chain', {
        [kind === 'fact' ? 'factId' : 'decisionId']: trimmed,
      });
      const impact =
        kind === 'decision'
          ? await http.call<DecisionImpactResultWire>('decision_impact', { decisionId: trimmed })
          : null;
      setState({ busy: false, error: null, chain, impact });
    } catch (err) {
      setState({ busy: false, error: err, chain: null, impact: null });
    }
  }

  return (
    <div className="stack-s" data-testid="causal-chain-tool">
      <h3 className="section-title">{t('因果链与影响', 'Causal chain & impact')}</h3>
      <form
        className="inline-form"
        onSubmit={(event) => void handleSubmit(event)}
        data-testid="causal-chain-form"
      >
        <Select
          id="causal-chain-kind"
          label={t('节点类型', 'Node kind')}
          value={kind}
          onChange={(event) => setKind(event.target.value as 'fact' | 'decision')}
        >
          <option value="fact">{t('事实', 'Fact')}</option>
          <option value="decision">{t('决定', 'Decision')}</option>
        </Select>
        <Field id="causal-chain-node-id" label={t('id', 'id')}>
          <input
            id="causal-chain-node-id"
            className="input input-mono"
            value={nodeId}
            onChange={(event) => setNodeId(event.target.value)}
            disabled={state.busy}
          />
        </Field>
        <Button type="submit" variant="primary" disabled={!nodeId.trim() || state.busy}>
          {t('追溯', 'Trace')}
        </Button>
      </form>
      {state.error !== null ? (
        <ErrorBanner
          error={state.error}
          title={t('无法追溯因果链', 'Could not trace the causal chain')}
          testId="causal-chain-error"
        />
      ) : null}
      {state.chain ? (
        <div className="stack-s" data-testid="causal-chain-result">
          <p className="text-3 text-small">
            {t('根节点', 'Root')}: {state.chain.rootType} ·{' '}
            <a href={auditHrefForNode(state.chain.rootId)}>{t('在此解释', 'Explain here')}</a>
            {state.chain.truncated ? (
              <span className="text-3"> · {t('（链已截断）', '(chain truncated)')}</span>
            ) : null}
          </p>
          <ol className="stack-s" data-testid="causal-chain-links">
            {state.chain.chain.map((link, index) => {
              const linkNodeId = link.fact?.id ?? link.decision?.id ?? link.activity?.id;
              return (
                <li key={`${link.nodeType}-${linkNodeId || index}`} className="row-wrap text-small">
                  <span className="tag mono">{link.nodeType}</span>
                  {linkNodeId ? (
                    <a href={auditHrefForNode(linkNodeId)} className="mono">
                      {linkNodeId.slice(0, 8)}
                    </a>
                  ) : (
                    <span className="text-3">—</span>
                  )}
                </li>
              );
            })}
          </ol>
          {state.impact ? (
            <div className="stack-s" data-testid="decision-impact-result">
              <span className="section-title">{t('下游影响', 'Downstream impact')}</span>
              <div className="row-wrap">
                <span className="text-3 text-small">
                  {t('事实', 'Facts')} ({state.impact.facts.length})
                </span>
                {state.impact.facts.map((fact) => (
                  <RefChip key={fact.id} kind="object" id={fact.id} name="Fact" size="s" />
                ))}
              </div>
              <div className="row-wrap">
                <span className="text-3 text-small">
                  {t('动作请求', 'Action requests')} ({state.impact.actionRequests.length})
                </span>
                {state.impact.actionRequests.map((ar) => (
                  <RefChip
                    key={ar.id}
                    kind="actionRequest"
                    id={ar.id}
                    name={ar.actionKindTag}
                    href={hrefs.approval(ar.id)}
                    size="s"
                  />
                ))}
              </div>
              <div className="row-wrap">
                <span className="text-3 text-small">
                  {t('任务', 'Tasks')} ({state.impact.taskIds.length})
                </span>
                {state.impact.taskIds.map((taskId) => (
                  <RefChip
                    key={taskId}
                    kind="task"
                    id={taskId}
                    name="Task"
                    href={hrefs.task(taskId)}
                    size="s"
                  />
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function PrecedentsTool({ http }: { readonly http: CapabilityCaller }) {
  const t = useT();
  const [objectId, setObjectId] = useState('');
  const [actionKindTag, setActionKindTag] = useState('');
  const [since, setSince] = useState('');
  const [state, setState] = useState<DecisionListState>(LIST_IDLE);

  async function run(mode: 'precedents' | 'query'): Promise<void> {
    if (state.busy) return;
    setState({ busy: true, error: null, items: null, label: null });
    try {
      if (mode === 'precedents') {
        const result = await http.call<{ items: readonly DecisionWire[] }>('find_precedents', {
          ...(objectId.trim() ? { objectId: objectId.trim() } : {}),
          ...(actionKindTag.trim() ? { actionKindTag: actionKindTag.trim() } : {}),
        });
        setState({
          busy: false,
          error: null,
          items: result.items,
          label: t('先例', 'Precedents'),
        });
      } else {
        const result = await http.call<{ items: readonly DecisionWire[] }>('query_decisions', {
          ...(objectId.trim() ? { objectId: objectId.trim() } : {}),
          ...(since.trim() ? { since: since.trim() } : {}),
        });
        setState({
          busy: false,
          error: null,
          items: result.items,
          label: t('查询结果', 'Query results'),
        });
      }
    } catch (err) {
      setState({ busy: false, error: err, items: null, label: null });
    }
  }

  return (
    <div className="stack-s" data-testid="precedents-tool">
      <h3 className="section-title">{t('先例与查询', 'Precedents & query')}</h3>
      <form
        className="inline-form row-wrap"
        onSubmit={(event) => {
          event.preventDefault();
          void run('precedents');
        }}
        data-testid="precedents-form"
      >
        <Field id="precedents-object-id" label={t('对象 id', 'Object id')}>
          <input
            id="precedents-object-id"
            className="input input-mono"
            value={objectId}
            onChange={(event) => setObjectId(event.target.value)}
            disabled={state.busy}
          />
        </Field>
        <Field id="precedents-action-kind" label={t('动作种类', 'Action kind')}>
          <input
            id="precedents-action-kind"
            className="input"
            value={actionKindTag}
            onChange={(event) => setActionKindTag(event.target.value)}
            disabled={state.busy}
          />
        </Field>
        <Field id="precedents-since" label={t('起始时间（ISO）', 'Since (ISO)')}>
          <input
            id="precedents-since"
            className="input"
            value={since}
            onChange={(event) => setSince(event.target.value)}
            disabled={state.busy}
          />
        </Field>
        <Button type="submit" variant="secondary" disabled={state.busy}>
          {t('查找先例', 'Find precedents')}
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={state.busy}
          onClick={() => void run('query')}
        >
          {t('查询决定', 'Query decisions')}
        </Button>
      </form>
      {state.error !== null ? (
        <ErrorBanner
          error={state.error}
          title={t('查询失败', 'Query failed')}
          testId="precedents-error"
        />
      ) : null}
      {state.items !== null ? (
        <ul className="stack-s" data-testid="precedents-result">
          {state.items.length === 0 ? (
            <li className="text-3 text-small">{t('没有匹配的决定', 'No matching Decisions')}</li>
          ) : (
            state.items.map((decision) => (
              <li key={decision.id} className="data-row" data-testid="precedent-row">
                <div className="data-row-main">
                  <div className="data-row-title row-wrap">
                    <a href={auditHrefForNode(decision.id)} className="mono">
                      {decision.id.slice(0, 8)}
                    </a>
                    <span className="tag mono">{decision.status}</span>
                  </div>
                  <div className="data-row-meta">
                    {decision.summary ? <span>{decision.summary}</span> : null}
                    <span className="meta-sep" title={formatDateTime(decision.createdAt)}>
                      {formatRelative(decision.createdAt)}
                    </span>
                  </div>
                </div>
              </li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  );
}
