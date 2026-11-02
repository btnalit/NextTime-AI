import type { DraftOrigin } from '@nexttime/shared';
import type { Translate } from '../../lib/i18n.js';
import type { OperationOrigin } from '../../lib/status-tone.js';
import type { KeyValueItem } from '../kit/key-value.js';
import { StatusChip } from '../kit/status-chip.js';

/**
 * components/catalog/DraftOrigin (legacy 597, S11 AA3a's draft origin): the 「起草方」 row on a
 * review page — whether a person, an agent or the platform's own template wrote the version being
 * read. The proposer row beside it names the Principal the version is for; an entry or admin agent
 * drafts for its person, so that Principal alone does not say an agent wrote it. The kernel records
 * `agent` for every agent session (entry, Worker, admin) and for an automation credential alike, so
 * the row says "an agent" and not which one. `null` (no row) for a version written before origins
 * were recorded.
 */
export function draftOriginItem(
  origin: DraftOrigin | undefined,
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
        {origin === 'agent' ? (
          <span className="text-3 text-small" data-testid={`${testId}-note`}>
            {t(
              '这一版是智能体（或自动化凭证）写的，不是人直接写的。发布前请逐项核对。',
              'An agent (or an automation credential) wrote this version, not a person directly. Check every part before publishing.',
            )}
          </span>
        ) : origin === 'platform' ? (
          <span className="text-3 text-small" data-testid={`${testId}-note`}>
            {t('平台自带的模板。', 'The platform’s own template.')}
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
              '这份草稿最后一次是智能体（或自动化凭证）写入的。智能体代提议者起草，可以改写提议者在控制台写的同名草稿，所以提议者之前写的内容可能已被替换。发布前请逐项核对。',
              'An agent (or an automation credential) last wrote this draft. An agent drafting for its proposer may rewrite a draft the proposer wrote in the console under the same name, so what the proposer wrote before may have been replaced. Check every part before publishing.',
            )}
          </span>
        ) : origin === 'agent' ? (
          <span className="text-3 text-small" data-testid="operation-detail-origin-note">
            {t(
              '这一版是智能体（或自动化凭证）写的，不是人直接写的。',
              'An agent (or an automation credential) wrote this version, not a person directly.',
            )}
          </span>
        ) : null}
      </span>
    ),
  };
}
