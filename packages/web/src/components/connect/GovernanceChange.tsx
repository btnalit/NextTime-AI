import type {
  OperationGovernanceChangeDirectionWire,
  OperationGovernanceFieldsWire,
} from '@nexttime/shared';
import { actionKindRaw, actionKindTagText } from '../../lib/format.js';
import { type Translate, useT } from '../../lib/i18n.js';
import { labelText, statusChipStyle } from '../../lib/status-tone.js';
import { StatusChip } from '../kit/status-chip.js';

/**
 * components/connect/GovernanceChange (R-19, decision D-17): the one way the console shows a
 * change to an Operation's mode / blast radius / auto-approvable before a human confirms it — the
 * "align with the gate's announcement" confirm, a catalog publish, the onboarding wizard's
 * reclassification and a gate's held manifest on the integrations page. Every caller passes the
 * kernel's own `direction` (`operationGovernanceChangeDirection`, built on
 * `classifyOperationGovernanceChange`); nothing here ranks a change itself, so the danger styling
 * can never disagree with the audit row the kernel writes for the same change.
 *
 * The consequence lines (`governanceConsequences`) only spell out what a loosening field means in
 * practice, keyed on the exact old → new values: execute → observe needs neither approval nor a
 * grant; leaving `high` drops the mandatory human approval and lets the requester approve their own
 * request; a lower blast radius or auto-approvable switched on can let the workspace's
 * auto-approval policy run it with no person involved.
 */

export interface GovernanceChangeItem {
  readonly name: string;
  readonly before: OperationGovernanceFieldsWire;
  readonly after: OperationGovernanceFieldsWire;
  readonly direction: OperationGovernanceChangeDirectionWire;
}

/** `loosened` and `mixed` both lower the friction on at least one field — the danger case. */
export function isLoosening(direction: OperationGovernanceChangeDirectionWire): boolean {
  return direction === 'loosened' || direction === 'mixed';
}

interface FieldChange {
  readonly label: string;
  readonly before: string;
  readonly after: string;
}

/** Only the fields that actually differ — listing an unchanged one as "x → x" would misreport. */
export function governanceFieldChanges(
  before: OperationGovernanceFieldsWire,
  after: OperationGovernanceFieldsWire,
  t: Translate,
): readonly FieldChange[] {
  const changes: FieldChange[] = [];
  if (before.mode !== after.mode) {
    changes.push({
      label: t('模式', 'Mode'),
      before: labelText(statusChipStyle('operationMode', before.mode), t),
      after: labelText(statusChipStyle('operationMode', after.mode), t),
    });
  }
  if (before.blastRadius !== after.blastRadius) {
    changes.push({
      label: t('影响级', 'Blast radius'),
      before: labelText(statusChipStyle('blastRadius', before.blastRadius), t),
      after: labelText(statusChipStyle('blastRadius', after.blastRadius), t),
    });
  }
  if (before.autoApprovable !== after.autoApprovable) {
    changes.push({
      label: t('自动批准', 'Auto-approve'),
      before: labelText(statusChipStyle('autoApprovable', String(before.autoApprovable)), t),
      after: labelText(statusChipStyle('autoApprovable', String(after.autoApprovable)), t),
    });
  }
  return changes;
}

/** UX acceptance of #612 (P2-2): an Operation's governance as one short label —
 *  「执行 · 高影响 · 需人工审批」 — for a line that introduces it rather than changes it (an Operation
 *  new on the gate, imported as a draft). */
export function governanceFieldsText(fields: OperationGovernanceFieldsWire, t: Translate): string {
  return [
    labelText(statusChipStyle('operationMode', fields.mode), t),
    labelText(statusChipStyle('blastRadius', fields.blastRadius), t),
    labelText(statusChipStyle('autoApprovable', String(fields.autoApprovable)), t),
  ].join(' · ');
}

/** A draft whose publish would be its Operation's first version, with what it is classified as. */
export interface FirstPublish {
  readonly name: string;
  readonly fields: OperationGovernanceFieldsWire;
}

/** Legacy 349 (UX acceptance of #612): publishing an Operation's first version makes it callable
 *  with no review beyond the click. One that writes (`execute`) or is high impact is confirmed
 *  first; a low/medium observe call stays one click. */
export function firstPublishNeedsConfirm(fields: {
  readonly mode?: string;
  readonly blastRadius?: string;
}): boolean {
  return fields.mode === 'execute' || fields.blastRadius === 'high';
}

/** What a first published version lets happen, one line — read off the same approval rules
 *  `governanceConsequences` cites (`observe` needs no grant and never reaches approval; `high`
 *  always needs a person; below that an auto-approvable one may run on the workspace policy). */
export function firstPublishConsequence(
  name: string | null,
  fields: OperationGovernanceFieldsWire,
  t: Translate,
): string {
  // `null` when the confirm already names the operation in its target, so the line opens with
  // 「它」 instead of repeating a possibly long name (UX acceptance of #645).
  const shown = name === null ? 'It' : actionKindTagText(name);
  const zhShown = name === null ? '它' : `${shown} `;
  if (fields.mode === 'observe') {
    return t(
      `${zhShown}是只读调用：发布后不需要审批也不需要授权，每个成员的入口 agent 都能直接调用`,
      `${shown} is an observe call: once published it needs no approval and no grant — every member's agent can call it directly`,
    );
  }
  if (fields.blastRadius === 'high') {
    return t(
      `${zhShown}会写入系统、影响高：发布后有授权的成员可以请求调用，每次都要人工审批`,
      `${shown} writes to the system at high impact: once published, members with a grant can request it, and every call needs a person's approval`,
    );
  }
  return fields.autoApprovable
    ? t(
        `${zhShown}会写入系统，且标为可自动批准：发布后有授权的成员可以请求调用，工作区的自动批准策略可以不经人工审批放行它`,
        `${shown} writes to the system and is marked auto-approvable: once published, members with a grant can request it, and the workspace auto-approval policy can let it run without a person`,
      )
    : t(
        `${zhShown}会写入系统：发布后有授权的成员可以请求调用，每次按审批规则处理`,
        `${shown} writes to the system: once published, members with a grant can request it, and each call goes through approval`,
      );
}

/** One impact line: `name: Mode A → B; Blast radius X → Y`. `named: false` drops the leading
 *  name, for a confirm about a single Operation that already names it in its target. */
export function governanceChangeSummary(
  item: GovernanceChangeItem,
  t: Translate,
  named = true,
): string {
  const changes = governanceFieldChanges(item.before, item.after, t);
  const text = changes.map((c) => `${c.label} ${c.before} → ${c.after}`).join('; ');
  return named ? `${actionKindTagText(item.name)}: ${text}` : text;
}

const BLAST_RANK: Readonly<Record<OperationGovernanceFieldsWire['blastRadius'], number>> = {
  low: 0,
  medium: 1,
  high: 2,
};

/** What a loosening change means for who may run the Operation, one line per effect — read off
 *  the kernel's approval rules (`governance/policy/engine.ts`: `high` always needs a person, the
 *  requester may approve their own request below `high` by default, only an auto-approvable
 *  Operation can be auto-approved, `observe` never reaches approval and needs no grant). Empty
 *  unless the kernel's direction says the change loosens something. */
export function governanceConsequences(
  item: GovernanceChangeItem,
  t: Translate,
  named = true,
): string[] {
  if (!isLoosening(item.direction)) return [];
  const { before, after } = item;
  // `named: false` (a single-Operation confirm that names it in its target): lines open with 它.
  const name = named ? actionKindTagText(item.name) : 'It';
  const zhName = named ? `${name} ` : '它';
  const lines: string[] = [];
  if (before.mode === 'execute' && after.mode === 'observe') {
    lines.push(
      t(
        `${zhName}改为只读调用：不再需要审批，也不再需要授权，每个成员的入口 agent 都能直接调用它`,
        `${name} becomes an observe call: no approval and no grant needed — every member's agent can call it directly`,
      ),
    );
    return lines;
  }
  const lowered = BLAST_RANK[after.blastRadius] < BLAST_RANK[before.blastRadius];
  if (lowered && before.blastRadius === 'high') {
    lines.push(
      t(
        `${zhName}不再是高影响：不再强制人工审批，默认情况下请求者可以批准自己的请求`,
        `${name} is no longer high impact: a person's approval is no longer mandatory, and by default the requester may approve their own request`,
      ),
    );
  }
  const autoApproveSwitchedOn = !before.autoApprovable && after.autoApprovable;
  if ((lowered || autoApproveSwitchedOn) && after.autoApprovable) {
    lines.push(
      after.blastRadius === 'high'
        ? t(
            `${zhName}标为可自动批准，但高影响仍必须人工审批`,
            `${name} is marked auto-approvable, but high impact still always needs a person's approval`,
          )
        : t(
            `${zhName}可能不再需要人工审批：工作区的自动批准策略可以直接放行它`,
            `${name} may no longer need a person's approval: the workspace auto-approval policy can let it run`,
          ),
    );
  }
  if (lines.length === 0) {
    // Loosened on paper, with no effect under today's rules (e.g. medium → low while still not
    // auto-approvable) — still said, since a later change to the other fields would let it count.
    lines.push(
      t(
        `${zhName}的审批分类放宽了`,
        named ? `${name}'s approval classification loosens` : 'Its approval classification loosens',
      ),
    );
  }
  return lines;
}

/** Old → new chips per Operation (all three fields, so the reader sees the whole classification),
 *  tagged with the kernel's direction (`data-direction`). */
export function GovernanceChangeList({
  items,
  testId = 'governance-diff-list',
}: {
  readonly items: readonly GovernanceChangeItem[];
  readonly testId?: string;
}) {
  const t = useT();
  return (
    <div className="stack-s" data-testid={testId}>
      <span className="text-12 font-medium text-text-2">
        {t(`${items.length} 个 Operation 的分类变化`, `Classification changes (${items.length})`)}
      </span>
      <ul className="stack-s" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {items.map((item) => (
          <li
            key={item.name}
            className="stack-s"
            data-testid={`${testId}-item`}
            data-direction={item.direction}
          >
            <span className="mono" title={actionKindRaw(item.name)}>
              {actionKindTagText(item.name)}
            </span>
            <div className="row-wrap">
              <StatusChip machine="operationMode" status={item.before.mode} size="s" />
              <span aria-hidden="true">→</span>
              <StatusChip machine="operationMode" status={item.after.mode} size="s" />
            </div>
            <div className="row-wrap">
              <StatusChip machine="blastRadius" status={item.before.blastRadius} size="s" />
              <span aria-hidden="true">→</span>
              <StatusChip machine="blastRadius" status={item.after.blastRadius} size="s" />
            </div>
            <div className="row-wrap">
              <StatusChip
                machine="autoApprovable"
                status={String(item.before.autoApprovable)}
                size="s"
              />
              <span aria-hidden="true">→</span>
              <StatusChip
                machine="autoApprovable"
                status={String(item.after.autoApprovable)}
                size="s"
              />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
