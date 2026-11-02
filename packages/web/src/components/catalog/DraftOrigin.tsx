import type { DraftOrigin } from '@nexttime/shared';
import { type Translate, useT } from '../../lib/i18n.js';
import type { OperationOrigin } from '../../lib/status-tone.js';
import type { KeyValueItem } from '../kit/key-value.js';
import { StatusChip } from '../kit/status-chip.js';

/**
 * components/catalog/DraftOrigin (legacy 597, S11 AA3a's draft origin): the 「起草方」 row on a
 * review page — whether a person, an agent or the platform's own template wrote the version being
 * read. The proposer row beside it names the Principal the version is for; an entry or admin agent
 * drafts for its person, so that Principal alone does not say an agent wrote it. The kernel records
 * `agent` for every Handle (an entry agent, a Worker, an admin agent, an external runtime) and for
 * a service account's API key alike (`draftOriginOf`), so the row says "an agent or a service
 * account" and not which one — the console's own words for both (#927 UX P3-1). Only a draft asks to be checked before
 * publishing; a version past that step just says who wrote it (#927 UX P2-1). `null` (no row) for
 * a version written before origins were recorded. The caller puts it right under the proposer row:
 * read together, whom the version is for and who wrote it (#927 UX P3-2).
 */
export function draftOriginItem(
  origin: DraftOrigin | undefined,
  status: string,
  t: Translate,
  testId: string,
): KeyValueItem | null {
  if (origin === undefined) return null;
  return {
    key: 'origin',
    label: t('起草方', 'Written by'),
    value: (
      <span className="stack-s" data-testid={testId} data-origin={origin}>
        <span>
          <StatusChip machine="draftOrigin" status={origin} size="s" />
        </span>
        {origin === 'agent' && status === 'draft' ? (
          <span className="text-3 text-small" data-testid={`${testId}-note`}>
            {t(
              '这一版是智能体或服务账号写的，不是人直接写的。发布前请逐项核对。',
              'An agent or a service account wrote this version, not a person directly. Check every part before publishing.',
            )}
          </span>
        ) : origin === 'agent' ? (
          <span className="text-3 text-small" data-testid={`${testId}-note`}>
            {t(
              '这一版是智能体或服务账号写的，不是人直接写的。',
              'An agent or a service account wrote this version, not a person directly.',
            )}
          </span>
        ) : origin === 'platform' ? (
          <span className="text-3 text-small" data-testid={`${testId}-note`}>
            {t(
              '平台自带的模板，建工作区时写入；提议者是建工作区时设定的所有者。',
              'The platform’s own template, written when the workspace was created; the proposer is the owner the workspace was created for.',
            )}
          </span>
        ) : null}
      </span>
    ),
  };
}

/**
 * The same row on an Operation's detail (`OperationSummaryWire.origin`): the gate's own manifest, or
 * a proposal by a person or an agent. A proposer revises their own draft in place, and an agent
 * session acting for that person counts as them (#914 review #493, note 1): an agent's write over a
 * draft the person wrote in the console keeps the version and turns its origin to `agent`. So an
 * agent-written draft says that it may have replaced what its proposer wrote — the digest a publish
 * names covers the origin, so a rewrite after the page was read is refused (409 `draft_changed`).
 */
export function operationOriginItem(
  origin: OperationOrigin | undefined,
  status: string,
  t: Translate,
): KeyValueItem | null {
  if (origin === undefined) return null;
  return {
    key: 'origin',
    label: t('起草方', 'Written by'),
    value: (
      <span className="stack-s" data-testid="operation-detail-origin" data-origin={origin}>
        <span>
          <StatusChip machine="operationOrigin" status={origin} size="s" />
        </span>
        {origin === 'import' ? (
          <span className="text-3 text-small" data-testid="operation-detail-origin-note">
            {t(
              '门自己声明的 Operation，导入它的清单时写入。',
              'An Operation the gate declares itself, written when its manifest was imported.',
            )}
          </span>
        ) : origin === 'agent' && status === 'draft' ? (
          <span className="text-3 text-small" data-testid="operation-detail-origin-note">
            {t(
              '这份草稿最后一次是智能体或服务账号写入的。智能体代提议者起草，可以改写提议者在控制台写的同名草稿，所以提议者之前写的内容可能已被替换。发布前请逐项核对。',
              'An agent or a service account last wrote this draft. An agent drafting for its proposer may rewrite a draft the proposer wrote in the console under the same name, so what the proposer wrote before may have been replaced. Check every part before publishing.',
            )}
          </span>
        ) : origin === 'agent' ? (
          <span className="text-3 text-small" data-testid="operation-detail-origin-note">
            {t(
              '这一版是智能体或服务账号写的，不是人直接写的。',
              'An agent or a service account wrote this version, not a person directly.',
            )}
          </span>
        ) : null}
      </span>
    ),
  };
}

/**
 * Legacy 602 (#927 UX P3-3): the amber 「智能体」 mark on a list row — Skill, 流程, Worker,
 * Operation, 本体提案 — for a draft an agent or a service account wrote, so a reviewer scanning the
 * list sees which drafts the detail's 「起草方」 row will ask them to check part by part
 * (`draftOriginItem`). Nothing for a person's draft, a gate manifest's or a version past draft:
 * the mark is a review cue, not a history, and the detail says who wrote any version. Same tone as
 * the detail's `draftOrigin` chip.
 */
export function AgentDraftMark({
  origin,
  status,
}: {
  readonly origin: string | undefined;
  readonly status: string;
}) {
  const t = useT();
  if (origin !== 'agent' || status !== 'draft') return null;
  return (
    <span
      className="chip chip-warn chip-s"
      data-testid="catalog-row-agent-draft"
      title={t(
        '这份草稿是智能体或服务账号写的，发布前请逐项核对。',
        'An agent or a service account wrote this draft. Check every part before publishing.',
      )}
    >
      {t('智能体', 'Agent')}
    </span>
  );
}
