import type { DraftEvaluationWire, SkillPublishRecordWire } from '@nexttime/shared';
import { useCapability } from '../../hooks/useCapability.js';
import { useRoleCan } from '../../hooks/useRoleCan.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { verdictReasonText } from '../../lib/draft-evaluations.js';
import { shortId } from '../../lib/format.js';
import { type Translate, useT } from '../../lib/i18n.js';
import { hrefs } from '../../lib/router.js';
import { CopyButton } from '../kit/copy-button.js';
import { Notice } from '../kit/notice.js';
import { RouteLink } from '../kit/route-link.js';
import { StatusChip } from '../kit/status-chip.js';

type Acknowledgement = SkillPublishRecordWire['acknowledgements'][number];

/**
 * components/catalog/SkillPublishRecord (legacy 539): on a published (or since deprecated) Skill
 * version's detail, what it was published on — `get_skill`'s `publishEvidence`, the record its
 * `publish_skill` kept: the evaluation the publisher reviewed (its verdict, why, and the graph's
 * summary Observation of it), and each failure the publish acknowledged with the reason given.
 * The draft's 「发布审阅」 (`SkillPublishReview`) is the same evidence before the publish; this is
 * it after, as the audit record keeps it.
 *
 * `record === null`: the version's publish recorded no evidence (published before it was kept, or
 * not through 「发布」). The caller leaves this out where `get_skill` did not say (`undefined`: a
 * Handle or a service Principal is not told).
 */
export function SkillPublishRecord({
  http,
  record,
}: {
  readonly http: CapabilityCaller;
  readonly record: SkillPublishRecordWire | null;
}) {
  const t = useT();
  return (
    <div className="stack-s" data-testid="skill-publish-record">
      <span className="section-title">{t('发布依据', 'Published on')}</span>
      {record === null ? (
        <p className="text-3 text-small" data-testid="skill-publish-record-none">
          {t(
            '这个版本的发布没有记下评测证据：它发布在开始记录发布证据之前，或者不是经「发布」发布的。',
            'This version’s publish recorded no evaluation evidence: it was published before that evidence was kept, or not through Publish.',
          )}
        </p>
      ) : (
        <RecordBody http={http} record={record} t={t} />
      )}
    </div>
  );
}

function RecordBody({
  http,
  record,
  t,
}: {
  readonly http: CapabilityCaller;
  readonly record: SkillPublishRecordWire;
  readonly t: Translate;
}) {
  const evaluation = record.evaluation;
  // Grouped by evaluation, in the order the record lists them, so each group reads its own
  // evaluation once for the cases' titles.
  const groups = new Map<string, Acknowledgement[]>();
  for (const item of record.acknowledgements) {
    const group = groups.get(item.evaluationId);
    if (group) group.push(item);
    else groups.set(item.evaluationId, [item]);
  }
  return (
    <>
      {evaluation === null ? (
        <p className="text-3 text-small" data-testid="skill-publish-record-unevaluated">
          {t(
            '发布时这份内容没有评测过。',
            'This content had not been evaluated when it was published.',
          )}
        </p>
      ) : (
        <section
          className="stack-s draft-eval-stage"
          data-testid="skill-publish-record-evaluation"
          data-evaluation-id={evaluation.id}
          data-verdict={evaluation.verdict ?? ''}
        >
          <div className="row-wrap">
            {evaluation.verdict !== null ? (
              <StatusChip
                machine="draftEvaluation"
                status={evaluation.verdict}
                size="s"
                testId="skill-publish-record-verdict"
              />
            ) : null}
            <span style={{ fontWeight: 600 }}>
              {t('发布人审阅的评测', 'The evaluation the publisher reviewed')}
            </span>
            <RouteLink
              href={hrefs.evaluation('drafts', evaluation.id)}
              className="link-inline"
              testId="skill-publish-record-link"
            >
              {t('查看评测详情', 'See the evaluation')}
            </RouteLink>
          </div>
          {evaluation.reason !== null ? (
            <p className="text-small" data-testid="skill-publish-record-reason">
              {verdictReasonText(evaluation.reason, t)}
            </p>
          ) : null}
          {evaluation.observationId !== null ? (
            <span
              className="row-wrap text-3 text-small"
              data-testid="skill-publish-record-observation"
            >
              {t('图谱里的评测摘要观察', 'Its summary Observation in the graph')}
              <span className="mono">{shortId(evaluation.observationId)}</span>
              <CopyButton
                value={evaluation.observationId}
                label={t('复制观察 ID', 'Copy observation id')}
              />
            </span>
          ) : null}
        </section>
      )}
      {record.acknowledgedFailures > 0 ? (
        <Notice tone="warn" testId="skill-publish-record-acknowledged">
          <div className="stack-s">
            <span>
              {t(
                `确认了 ${record.acknowledgedFailures} 条失败后发布：评测发现这些用例上不如基线，发布人逐条写下了仍然发布的理由。`,
                `Published after acknowledging ${record.acknowledgedFailures} failure${record.acknowledgedFailures === 1 ? '' : 's'}: the evaluation found it below the baseline on these cases, and the publisher gave a reason for each.`,
              )}
            </span>
            {[...groups].map(([evaluationId, items]) => (
              <AcknowledgedGroup
                key={evaluationId}
                http={http}
                evaluationId={evaluationId}
                items={items}
                t={t}
              />
            ))}
          </div>
        </Notice>
      ) : null}
    </>
  );
}

/** The cases' titles, from the evaluation they failed in; their short ids until (or unless) it is
 *  read. Anyone who reads the published version may read an evaluation of exactly its content. */
function AcknowledgedGroup({
  http,
  evaluationId,
  items,
  t,
}: {
  readonly http: CapabilityCaller;
  readonly evaluationId: string;
  readonly items: readonly Acknowledgement[];
  readonly t: Translate;
}) {
  const can = useRoleCan(http);
  const detail = useCapability<DraftEvaluationWire>(
    http,
    'get_draft_evaluation',
    { evaluationId },
    { enabled: can('get_draft_evaluation') === true },
  );
  const titles = new Map<string, string>();
  if (detail.state.status === 'ready') {
    for (const stage of detail.state.data.stages) {
      for (const row of stage.cases) titles.set(row.caseId, row.title);
    }
  }
  return (
    <ul className="stack-s" style={{ margin: 0, paddingInlineStart: '1.2em' }}>
      {items.map((item) => {
        const title = titles.get(item.caseId);
        return (
          <li
            key={item.caseId}
            data-testid="skill-publish-record-acknowledgement"
            data-case-id={item.caseId}
          >
            <span style={{ fontWeight: 600 }}>
              {title !== undefined ? (
                t(`用例「${title}」`, `Case “${title}”`)
              ) : (
                <>
                  {t('用例 ', 'Case ')}
                  <span className="mono">{shortId(item.caseId)}</span>
                </>
              )}
            </span>
            <span className="text-2">{t('：', ': ')}</span>
            <span className="wrap-anywhere" style={{ whiteSpace: 'pre-wrap' }}>
              {item.reason}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
