import type {
  OperationGovernanceChangeDirectionWire,
  OperationGovernanceFieldsWire,
} from '@nexttime/shared';
import { actionKindRaw, actionKindTagText } from '../../lib/format.js';
import { type Translate, useT } from '../../lib/i18n.js';
import { operationFieldLabel } from '../../lib/labels.js';
import { operationQueueScopeShortText } from '../../lib/queue-scope.js';
import { labelText, statusChipStyle } from '../../lib/status-tone.js';
import { StatusChip } from '../kit/status-chip.js';

/**
 * components/connect/GovernanceChange (R-19, decision D-17): the one way the console shows a
 * change to an Operation's governance before a human confirms it — mode, blast radius and
 * auto-approvable always, and whichever of await-decision, reads / writes and the MCP hints changed
 * (STATUS leftover 344) — the
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
 * auto-approval policy run it with no person involved; no longer awaiting the decision lets the
 * caller go on before anyone decides; more types read or written reach further; MCP hints that now
 * say "not destructive" and "idempotent" let a vetted gate's call be auto-approved
 * (`governance/gatekeepers/trust.ts`); and the read-only hint, which no approval reads today, is
 * still confirmed as a loosening because no change of it is proven harmless.
 */

/** The three fields that classify an Operation for approval — what a first publish shows. */
export type OperationClassificationWire = Pick<
  OperationGovernanceFieldsWire,
  'mode' | 'blastRadius' | 'autoApprovable'
>;

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
  /** What a change that is not a loosening (so has no consequence line) means for the caller —
   *  said next to the field (UX acceptance of #710, P3-3). */
  readonly note?: string;
}

/** Whether mode, blast radius or auto-approvable changed — the list shows those three as chips
 *  only then (UX acceptance of #710, P2-1: three unchanged pairs hid the row that did change). */
export function classificationChanged(
  before: OperationClassificationWire,
  after: OperationClassificationWire,
): boolean {
  return (
    before.mode !== after.mode ||
    before.blastRadius !== after.blastRadius ||
    before.autoApprovable !== after.autoApprovable
  );
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
  return [...changes, ...otherFieldChanges(before, after, t)];
}

/** The governance fields beyond the classification, each with the manifest key the catalog's
 *  labels use (`lib/labels.ts` `OPERATION_FIELD_LABELS`). */
const OTHER_GOVERNANCE_FIELDS = [
  ['awaitDecision', 'await_decision'],
  ['reads', 'reads'],
  ['writes', 'writes'],
  ['readOnlyHint', 'read_only_hint'],
  ['destructiveHint', 'destructive_hint'],
  ['idempotentHint', 'idempotent_hint'],
] as const satisfies readonly (readonly [keyof OperationGovernanceFieldsWire, string])[];

type OtherGovernanceValue = boolean | null | readonly string[];

function sameValue(a: OtherGovernanceValue, b: OtherGovernanceValue): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    // Compared as sets, as the kernel compares them: a reorder is no change.
    const left = new Set(a);
    const right = new Set(b);
    return left.size === right.size && [...left].every((entry) => right.has(entry));
  }
  return a === b;
}

function otherValueText(value: OtherGovernanceValue, t: Translate): string {
  if (value === null) return t('未声明', 'not declared');
  if (typeof value === 'boolean') return value ? t('是', 'yes') : t('否', 'no');
  return value.length > 0 ? value.join(t('、', ', ')) : t('无', 'none');
}

type GovernanceTarget = OperationGovernanceFieldsWire['target'];

/** S11 GO12: the same declaration — type and params, in order (the params' order is the
 *  identity's). */
function sameTarget(a: GovernanceTarget, b: GovernanceTarget): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.objectType === b.objectType &&
    a.params.length === b.params.length &&
    a.params.every((param, index) => b.params[index] === param)
  );
}

/** S11 GO12: the queue scope, when it changes — removing it is a tightening, said next to it. */
function targetFieldChange(
  before: OperationGovernanceFieldsWire,
  after: OperationGovernanceFieldsWire,
  t: Translate,
): FieldChange[] {
  // `target` is absent from a kernel older than GO12: nothing to compare.
  if (before.target === undefined || after.target === undefined) return [];
  if (sameTarget(before.target, after.target)) return [];
  return [
    {
      label: operationFieldLabel('target', t),
      before: operationQueueScopeShortText(before.target, t),
      after: operationQueueScopeShortText(after.target, t),
      ...(after.target === null
        ? {
            note: t(
              '改回整个系统一个队列：这个系统上的所有请求又按提出顺序逐个执行',
              'back to one queue for the whole system: every request on this system again runs one at a time, in order',
            ),
          }
        : {}),
    },
  ];
}

/** The changed governance fields beyond the classification — listed only when they change, so a
 *  confirm for a mode change is not a wall of unchanged rows. */
function otherFieldChanges(
  before: OperationGovernanceFieldsWire,
  after: OperationGovernanceFieldsWire,
  t: Translate,
): FieldChange[] {
  return [...otherListedFieldChanges(before, after, t), ...targetFieldChange(before, after, t)];
}

function otherListedFieldChanges(
  before: OperationGovernanceFieldsWire,
  after: OperationGovernanceFieldsWire,
  t: Translate,
): FieldChange[] {
  return OTHER_GOVERNANCE_FIELDS.filter(([field]) => !sameValue(before[field], after[field])).map(
    ([field, key]) => ({
      label: operationFieldLabel(key, t),
      before: otherValueText(before[field], t),
      after: otherValueText(after[field], t),
      ...(field === 'awaitDecision' && after.awaitDecision
        ? {
            note: t(
              '调用方提交请求后要等审批结果才往下做',
              'the caller waits for the decision after submitting a request before going on',
            ),
          }
        : {}),
    }),
  );
}

/** UX acceptance of #612 (P2-2): an Operation's governance as one short label —
 *  「执行 · 高影响 · 需人工审批」 — for a line that introduces it rather than changes it (an Operation
 *  new on the gate, imported as a draft). */
export function governanceFieldsText(fields: OperationClassificationWire, t: Translate): string {
  return [
    labelText(statusChipStyle('operationMode', fields.mode), t),
    labelText(statusChipStyle('blastRadius', fields.blastRadius), t),
    labelText(statusChipStyle('autoApprovable', String(fields.autoApprovable)), t),
  ].join(' · ');
}

/** A draft whose publish would be its Operation's first version, with what it is classified as. */
export interface FirstPublish {
  readonly name: string;
  readonly fields: OperationClassificationWire;
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
  fields: OperationClassificationWire,
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

/** One line with every changed field, old → new — 「stock.get：读取的资源 无 → Stock；…」 — for a
 *  place that shows no `GovernanceChangeList` (a held manifest's summary on the integrations page). */
export function governanceChangeSummary(item: GovernanceChangeItem, t: Translate): string {
  const changes = governanceFieldChanges(item.before, item.after, t);
  return `${actionKindTagText(item.name)}${t('：', ': ')}${changes
    .map((c) => `${c.label} ${c.before} → ${c.after}`)
    .join(t('；', '; '))}`;
}

/** One impact line naming what changes — 「stock.get 的 3 个治理字段」 — for a confirm whose
 *  `GovernanceChangeList` gives the values right under it (UX acceptance of #710, P3-1: the line
 *  repeated them). */
export function governanceChangeHeadline(item: GovernanceChangeItem, t: Translate): string {
  const changes = governanceFieldChanges(item.before, item.after, t);
  const name = actionKindTagText(item.name);
  const [only] = changes;
  return changes.length === 1 && only !== undefined
    ? t(`${name} 的${only.label}`, `${name}: ${only.label}`)
    : t(
        `${name} 的 ${changes.length} 个治理字段`,
        `${changes.length} governance fields of ${name}`,
      );
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
  if (before.awaitDecision && !after.awaitDecision) {
    lines.push(
      t(
        `${zhName}不再等审批结果：调用方提交请求后直接往下做，不等有人批准`,
        `${name} no longer waits for the decision: the caller goes on as soon as it submits the request, before anyone has approved it`,
      ),
    );
  }
  for (const [field, zhLabel, enLabel] of [
    ['reads', '读取', 'reads'],
    ['writes', '写入', 'writes'],
  ] as const) {
    const added = after[field].filter((entry) => !before[field].includes(entry));
    if (added.length > 0) {
      lines.push(
        t(
          `${zhName}还会${zhLabel} ${added.join('、')}`,
          `${name} also ${enLabel} ${added.join(', ')}`,
        ),
      );
    }
  }
  const mcpHintLoosened =
    (before.destructiveHint !== false && after.destructiveHint === false) ||
    (before.idempotentHint !== true && after.idempotentHint === true);
  if (mcpHintLoosened) {
    lines.push(
      after.destructiveHint === false && after.idempotentHint === true
        ? t(
            `${zhName}现在声明为不具破坏性且幂等：在经过平台审核的门上，只要它可自动批准，工作区的自动批准策略就可以不经人工审批放行它`,
            `${name} now declares itself not destructive and idempotent: on a gate the platform vetted, the workspace auto-approval policy can let it run without a person whenever it is auto-approvable`,
          )
        : t(
            `${zhName}的 MCP 提示放宽了，但还不满足自动批准的条件（要同时声明不具破坏性、幂等）`,
            `${name}'s MCP hints loosen, but not yet enough for auto-approval (it must declare both not destructive and idempotent)`,
          ),
    );
  }
  // S11 GO12: declaring a target (or another one) lets calls on other instances run past it.
  const target = after.target;
  if (
    target !== undefined &&
    target !== null &&
    before.target !== undefined &&
    !sameTarget(before.target, target)
  ) {
    lines.push(
      before.target === null
        ? t(
            `${zhName}改为按 ${target.objectType} 排队：同一系统上别的 ${target.objectType} 的请求不再排在它后面，它等审批时也只挡同一个 ${target.objectType} 和作用于整个系统的请求`,
            `${name} queues per ${target.objectType}: requests on another ${target.objectType} of the same system no longer wait behind it, and while it awaits approval it holds back only the same ${target.objectType} and requests on the whole system`,
          )
        : t(
            `${zhName}的排队范围改为${operationQueueScopeShortText(target, t)}：之后按新的参数判断两次调用是不是同一个 ${target.objectType}，已经在排队的请求不变`,
            `${name}'s queue scope becomes ${operationQueueScopeShortText(target, t)}: from now on the new params decide whether two calls are on the same ${target.objectType}; requests already queued keep theirs`,
          ),
    );
  }
  if (before.readOnlyHint !== after.readOnlyHint) {
    lines.push(
      t(
        `${zhName}的只读提示变了：审批目前不看它，但这个改动没有被证明无害，所以当作放宽，需要你确认`,
        `${name}'s read-only hint changes: approval does not read it today, but the change is not proven harmless, so it counts as a loosening and needs your confirmation`,
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

/** Old → new per Operation, tagged with the kernel's direction (`data-direction`): the three
 *  classification fields as chips when any of them changed (all three, so the reader sees the
 *  whole classification), then a line per other governance field that changed. `single`: a confirm
 *  about one Operation
 *  that already names it in its target — the heading drops the count and the item its name
 *  (legacy 400: the name and the change were each said twice in that confirm). */
export function GovernanceChangeList({
  items,
  testId = 'governance-diff-list',
  single = false,
}: {
  readonly items: readonly GovernanceChangeItem[];
  readonly testId?: string;
  readonly single?: boolean;
}) {
  const t = useT();
  return (
    <div className="stack-s" data-testid={testId}>
      <span className="text-12 font-medium text-text-2">
        {single
          ? t('治理字段的变化', 'Governance changes')
          : t(
              `${items.length} 个 Operation 的治理字段变化`,
              `Governance changes (${items.length} operations)`,
            )}
      </span>
      <ul className="stack-s" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {items.map((item) => (
          <li
            key={item.name}
            className="stack-s"
            data-testid={`${testId}-item`}
            data-direction={item.direction}
          >
            {single ? null : (
              <span className="mono" title={actionKindRaw(item.name)}>
                {actionKindTagText(item.name)}
              </span>
            )}
            {classificationChanged(item.before, item.after) ? (
              <>
                <div className="row-wrap" data-testid={`${testId}-classification`}>
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
              </>
            ) : null}
            {otherFieldChanges(item.before, item.after, t).map((change) => (
              <span
                key={change.label}
                className="text-12 text-text-2"
                data-testid={`${testId}-field`}
              >
                {`${change.label}${t('：', ': ')}${change.before} → ${change.after}`}
                {change.note ? t(`（${change.note}）`, ` (${change.note})`) : null}
              </span>
            ))}
          </li>
        ))}
      </ul>
    </div>
  );
}
