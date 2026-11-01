import { describe, expect, it } from 'vitest';
import type { Translate } from '../../lib/i18n.js';
import {
  type GovernanceChangeItem,
  governanceChangeSummary,
  governanceConsequences,
  governanceFieldChanges,
} from './GovernanceChange.js';
import { governanceFields } from './governance-fixtures.test-helpers.js';

const zh: Translate = (z) => z;
const en: Translate = (_z, e) => e;

const restart = governanceFields({ mode: 'execute', blastRadius: 'medium', autoApprovable: false });
const perContainer = { objectType: 'Container', params: ['id'] };

function item(
  before: GovernanceChangeItem['before'],
  after: GovernanceChangeItem['after'],
  direction: GovernanceChangeItem['direction'],
): GovernanceChangeItem {
  return { name: 'container.restart', before, after, direction };
}

describe('GovernanceChange: the queue scope (S11 GO12)', () => {
  it('declaring a target is a loosening: shown old → new, with what it lets run past it', () => {
    const change = item(restart, { ...restart, target: perContainer }, 'loosened');
    expect(governanceFieldChanges(change.before, change.after, zh)).toEqual([
      { label: '排队范围', before: '整个系统', after: '按 Container（id）' },
    ]);
    expect(governanceConsequences(change, zh)).toEqual([
      'container.restart 改为按 Container 排队：同一系统上别的 Container 的请求不再排在它后面，它等审批时也只挡同一个 Container 和作用于整个系统的请求',
    ]);
    expect(governanceConsequences(change, en, false)).toEqual([
      'It queues per Container: requests on another Container of the same system no longer wait behind it, and while it awaits approval it holds back only the same Container and requests on the whole system',
    ]);
    expect(governanceChangeSummary(change, en)).toBe(
      'container.restart: Queue scope Whole system → Per Container (id)',
    );
  });

  it('another declaration is a change the kernel loosens: said with what it means for queued requests', () => {
    const byName = { objectType: 'Container', params: ['name'] };
    const change = item(
      { ...restart, target: perContainer },
      { ...restart, target: byName },
      'loosened',
    );
    expect(governanceFieldChanges(change.before, change.after, zh)).toEqual([
      { label: '排队范围', before: '按 Container（id）', after: '按 Container（name）' },
    ]);
    expect(governanceConsequences(change, zh)).toEqual([
      'container.restart 的排队范围改为按 Container（name）：之后按新的参数判断两次调用是不是同一个 Container，已经在排队的请求不变',
    ]);
  });

  it('removing it is a tightening: no loosening line, a note on what changes', () => {
    const change = item({ ...restart, target: perContainer }, restart, 'tightened');
    expect(governanceFieldChanges(change.before, change.after, zh)).toEqual([
      {
        label: '排队范围',
        before: '按 Container（id）',
        after: '整个系统',
        note: '改为与整个系统排队：这个系统上的请求重新按提出顺序逐个执行',
      },
    ]);
    expect(governanceConsequences(change, zh)).toEqual([]);
  });

  it('the same declaration, or none from an older kernel, lists nothing', () => {
    const same = item(
      { ...restart, target: perContainer },
      { ...restart, target: { ...perContainer } },
      'neutral',
    );
    expect(governanceFieldChanges(same.before, same.after, zh)).toEqual([]);
    // A kernel before GO12 sends no `target` at all.
    const { target: _omitted, ...older } = restart;
    const fromOlder = item(
      older as GovernanceChangeItem['before'],
      { ...restart, target: perContainer },
      'neutral',
    );
    expect(governanceFieldChanges(fromOlder.before, fromOlder.after, zh)).toEqual([]);
  });
});
