import type { GateAddressChangeImpactWire } from '@nexttime/shared';
import { describe, expect, it } from 'vitest';
import {
  approveGateAddressChangeErrors,
  gateAddressChangeImpactLines,
  gateAddressChangeStatusLabel,
  gateAddressManifestProblems,
} from './gate-address-change.js';
import type { Translate } from './i18n.js';

const zh: Translate = (text) => text;
const en: Translate = (_zh, text) => text;

const impact: GateAddressChangeImpactWire = {
  publishedOperationCount: 2,
  grantCount: 3,
  autoApprovedOperations: ['notes.list', 'notes.read'],
  workerDefinitionCount: 1,
  inFlightActionRequestCount: 0,
};

describe('gateAddressChangeImpactLines (legacy 701)', () => {
  it('names what follows the gate, in the order the owner checks it, and no in-flight line at zero', () => {
    expect(gateAddressChangeImpactLines(impact, zh)).toEqual([
      '2 个已发布的 Operation：新地址上的门必须原样提供',
      '3 个授权：被授权的成员在新地址照样能调用',
      '自动批准的 Operation：notes.list、notes.read，在新地址同样不经审批',
      '1 个已发布的 Worker 定义用到它',
    ]);
  });

  it('says when nothing is approved automatically, and that unrun requests stay at the old address', () => {
    const lines = gateAddressChangeImpactLines(
      { ...impact, autoApprovedOperations: [], inFlightActionRequestCount: 4 },
      zh,
    );
    expect(lines.some((line) => /^没有自动批准的 Operation$/.test(line))).toBe(true);
    expect(lines.at(-1)).toBe(
      '4 个请求还没执行：它们只在旧地址执行，换地址之后会被拒绝，要重新发起',
    );
  });

  it('reads in English too', () => {
    const en: Translate = (_zh, english) => english;
    expect(gateAddressChangeImpactLines(impact, en)[2]).toBe(
      'Approved automatically: notes.list, notes.read — at the new address too, without review',
    );
  });
});

describe('gateAddressManifestProblems (legacy 701)', () => {
  const base = { manifestDigest: 'd'.repeat(64), differing: [], notDescribed: [] };

  it('is empty when the new host matches', () => {
    expect(gateAddressManifestProblems({ ...base, matches: true }, zh)).toEqual([]);
  });

  it('says which names differ and which are not described, one line each', () => {
    const lines = gateAddressManifestProblems(
      { ...base, matches: false, differing: ['notes.write'], notDescribed: ['notes.archive'] },
      zh,
    );
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(
      /^新地址上的门描述得和已发布的不同，或者这个工作区没有：notes\.write$/,
    );
    expect(lines[1]).toMatch(/^已发布、但新地址上的门没有描述：notes\.archive$/);
  });

  it('still says why when the kernel names nothing', () => {
    expect(gateAddressManifestProblems({ ...base, matches: false }, zh)).toEqual([
      '新地址上的门描述的 Operation 和已发布的不一致',
    ]);
  });
});

describe('gateAddressChangeStatusLabel (legacy 701)', () => {
  it('labels every status', () => {
    expect(
      (['proposed', 'applied', 'rejected', 'withdrawn', 'expired'] as const).map((status) =>
        gateAddressChangeStatusLabel(status, zh),
      ),
    ).toEqual([
      '等平台管理员审批',
      '已换到新地址',
      '平台管理员驳回了',
      '已撤回',
      '过期了，没有生效',
    ]);
  });
});

describe('legacy 701: words UX acceptance of #1158 asked for', () => {
  it('a count of none says so, without the half that follows a count', () => {
    const none = { ...impact, publishedOperationCount: 0, grantCount: 0, workerDefinitionCount: 0 };
    const lines = gateAddressChangeImpactLines(none, zh);
    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatch(/^还没有已发布的 Operation$/);
    expect(lines[1]).toBe('没有授权');
    expect(lines[3]).toMatch(/^没有已发布的 Worker 定义用到它$/);
    expect(gateAddressChangeImpactLines(none, en)[0]).not.toMatch(/\b0\b/);
  });

  it('an approval refused in English keeps a space between its sentences', () => {
    for (const text of Object.values(approveGateAddressChangeErrors(en))) {
      expect(text).not.toMatch(/\.[A-Z]/);
      expect(text).toContain('nothing changed. ');
    }
  });
});
