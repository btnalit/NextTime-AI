import type { ReactNode } from 'react';
import { formatDateTime, formatRelative } from '../../lib/format.js';
import { useT } from '../../lib/i18n.js';
import { Icon } from './Icon.js';
import { RefChip } from './RefChip.js';

/**
 * A narrow, already-fetched shape of the kernel's `explain` result (`substrate/epistemic/
 * explain.ts` `ExplainResult`: `fact` / `activity` / `source` refs). Defined here rather than
 * imported from the kernel so the UI kit stays independent of kernel modules; the audit lane
 * maps `explain`'s output onto it. Every field beyond `id` is optional — the kernel's own shape
 * has nullable refs everywhere, and the chain degrades segment by segment.
 */
export interface ProvenancePrincipal {
  readonly id: string;
  readonly displayName?: string | null;
  readonly kind?: string;
  readonly role?: string | null;
}

export interface ProvenanceSource {
  readonly id: string;
  readonly kind?: string;
  readonly uri?: string | null;
  readonly visibility?: string;
  readonly ownerPrincipal?: ProvenancePrincipal | null;
}

export interface ProvenanceObservation {
  readonly id: string;
  readonly createdAt?: string;
  readonly source?: ProvenanceSource | null;
}

export interface ProvenanceActivity {
  readonly id: string;
  readonly kind?: string;
  readonly status?: string;
  readonly createdAt?: string;
  readonly endedAt?: string | null;
  readonly startedByPrincipal?: ProvenancePrincipal | null;
  readonly onBehalfOfPrincipal?: ProvenancePrincipal | null;
}

export interface ProvenanceFact {
  readonly id: string;
  readonly linkType?: string;
  readonly epistemicStatus?: string;
  readonly assertedByPrincipal?: ProvenancePrincipal | null;
  readonly verifiedByPrincipal?: ProvenancePrincipal | null;
  readonly invalidatedAt?: string | null;
  readonly invalidationReason?: string | null;
  readonly lastObservation?: ProvenanceObservation | null;
}

export interface ProvenanceChainProps {
  readonly fact?: ProvenanceFact | null;
  readonly activity?: ProvenanceActivity | null;
  /** The Source; when omitted, the Fact's `lastObservation.source` is used. */
  readonly source?: ProvenanceSource | null;
  /** The raw `explain` payload for the "原始证据 Raw evidence" disclosure. */
  readonly raw?: unknown;
  /** Object-page hrefs by id, for the RefChips (optional — bare chips otherwise). */
  readonly hrefFor?: (kind: 'object' | 'principal', id: string) => string | undefined;
  readonly testId?: string;
}

function principalChip(
  principal: ProvenancePrincipal | null | undefined,
  hrefFor: ProvenanceChainProps['hrefFor'],
): ReactNode {
  if (!principal) return <span className="text-3">—</span>;
  return (
    <RefChip
      kind="principal"
      id={principal.id}
      name={principal.displayName}
      href={hrefFor?.('principal', principal.id)}
      size="s"
    />
  );
}

function when(iso: string | null | undefined): ReactNode {
  if (!iso) return <span className="text-3">—</span>;
  return <time title={formatDateTime(iso)}>{formatRelative(iso)}</time>;
}

/**
 * components/ui/ProvenanceChain (S6-A0, §5.5 / §5.9 "ProvenanceChain"): the Fact → Activity →
 * Source lineage as a three-segment timeline, each segment a labelled block with its RefChip and
 * the who / when lines the audit page needs to answer "where did this come from", plus the raw
 * `explain` payload behind a disclosure. A segment the result lacks renders as "无 Not recorded"
 * rather than vanishing, so a broken chain is visible (§7: "溯源链不被切断").
 */
export function ProvenanceChain({
  fact,
  activity,
  source,
  raw,
  hrefFor,
  testId,
}: ProvenanceChainProps) {
  const t = useT();
  const resolvedSource = source ?? fact?.lastObservation?.source ?? null;
  return (
    <div className="prov-chain" data-testid={testId}>
      <ol className="prov-segments">
        <Segment title={t('事实', 'Fact')} present={!!fact} testId="prov-fact">
          {fact ? (
            <>
              <RefChip
                kind="object"
                id={fact.id}
                name={fact.linkType ?? null}
                href={hrefFor?.('object', fact.id)}
                size="s"
              />
              <dl className="definition-list">
                {fact.epistemicStatus !== undefined ? (
                  <>
                    <dt>{t('状态', 'Status')}</dt>
                    <dd className="mono">{fact.epistemicStatus}</dd>
                  </>
                ) : null}
                <dt>{t('断言者', 'Asserted by')}</dt>
                <dd>{principalChip(fact.assertedByPrincipal, hrefFor)}</dd>
                {fact.verifiedByPrincipal ? (
                  <>
                    <dt>{t('验证者', 'Verified by')}</dt>
                    <dd>{principalChip(fact.verifiedByPrincipal, hrefFor)}</dd>
                  </>
                ) : null}
                {fact.lastObservation ? (
                  <>
                    <dt>{t('最近观测', 'Last observed')}</dt>
                    <dd>{when(fact.lastObservation.createdAt)}</dd>
                  </>
                ) : null}
                {fact.invalidatedAt ? (
                  <>
                    <dt className="text-danger">{t('失效', 'Invalidated')}</dt>
                    <dd>
                      {when(fact.invalidatedAt)}
                      {fact.invalidationReason ? (
                        <span className="text-2"> — {fact.invalidationReason}</span>
                      ) : null}
                    </dd>
                  </>
                ) : null}
              </dl>
            </>
          ) : null}
        </Segment>
        <Segment title={t('活动', 'Activity')} present={!!activity} testId="prov-activity">
          {activity ? (
            <>
              <RefChip
                kind="object"
                id={activity.id}
                name={activity.kind ?? null}
                href={hrefFor?.('object', activity.id)}
                size="s"
              />
              <dl className="definition-list">
                {activity.status !== undefined ? (
                  <>
                    <dt>{t('状态', 'Status')}</dt>
                    <dd className="mono">{activity.status}</dd>
                  </>
                ) : null}
                <dt>{t('发起者', 'Started by')}</dt>
                <dd>{principalChip(activity.startedByPrincipal, hrefFor)}</dd>
                {activity.onBehalfOfPrincipal ? (
                  <>
                    <dt>{t('代表', 'On behalf of')}</dt>
                    <dd>{principalChip(activity.onBehalfOfPrincipal, hrefFor)}</dd>
                  </>
                ) : null}
                <dt>{t('开始', 'Started')}</dt>
                <dd>{when(activity.createdAt)}</dd>
                {activity.endedAt ? (
                  <>
                    <dt>{t('结束', 'Ended')}</dt>
                    <dd>{when(activity.endedAt)}</dd>
                  </>
                ) : null}
              </dl>
            </>
          ) : null}
        </Segment>
        <Segment title={t('来源', 'Source')} present={!!resolvedSource} testId="prov-source">
          {resolvedSource ? (
            <>
              <RefChip
                kind="object"
                id={resolvedSource.id}
                name={resolvedSource.kind ?? null}
                href={hrefFor?.('object', resolvedSource.id)}
                size="s"
              />
              <dl className="definition-list">
                {resolvedSource.uri ? (
                  <>
                    <dt>URI</dt>
                    <dd className="mono truncate" title={resolvedSource.uri}>
                      {resolvedSource.uri}
                    </dd>
                  </>
                ) : null}
                {resolvedSource.visibility !== undefined ? (
                  <>
                    <dt>{t('可见性', 'Visibility')}</dt>
                    <dd className="mono">{resolvedSource.visibility}</dd>
                  </>
                ) : null}
                {resolvedSource.ownerPrincipal ? (
                  <>
                    <dt>{t('所有者', 'Owner')}</dt>
                    <dd>{principalChip(resolvedSource.ownerPrincipal, hrefFor)}</dd>
                  </>
                ) : null}
              </dl>
            </>
          ) : null}
        </Segment>
      </ol>
      {raw !== undefined ? (
        <details className="disclosure" data-testid="prov-raw">
          <summary>
            <Icon name="chevron-right" size="s" className="icon-chevron" />
            {t('原始证据', 'Raw evidence')}
          </summary>
          <div className="disclosure-body">
            <pre className="code-block">{JSON.stringify(raw, null, 2)}</pre>
          </div>
        </details>
      ) : null}
    </div>
  );
}

function Segment({
  title,
  present,
  testId,
  children,
}: {
  readonly title: string;
  readonly present: boolean;
  readonly testId: string;
  readonly children: ReactNode;
}) {
  const t = useT();
  return (
    <li
      className={`prov-segment${present ? '' : ' prov-segment-missing'}`}
      data-testid={testId}
      data-present={present}
    >
      <span className="prov-segment-dot" aria-hidden />
      <div className="prov-segment-body">
        <span className="section-title">{title}</span>
        {present ? children : <span className="text-3">{t('无', 'Not recorded')}</span>}
      </div>
    </li>
  );
}
