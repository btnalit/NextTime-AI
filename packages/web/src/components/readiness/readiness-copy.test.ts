import {
  ExecutionReadinessMissingCodeSchema,
  GateUnreachableReasonSchema,
  ROLE_VALUES,
  getCapability,
  roleMayUseCapability,
} from '@nexttime/shared';
import { describe, expect, it } from 'vitest';
import type { Translate } from '../../lib/i18n.js';
import { hrefs } from '../../lib/router.js';
import {
  type ReadinessReader,
  gateReasonAsk,
  gateReasonHref,
  missingAsk,
  missingCauseText,
  missingLinkHref,
  missingLinkLabel,
  refusalKind,
  refusalKindsOf,
} from './readiness-copy.js';

const t: Translate = (zh) => zh;

/** The capability behind each fix, written out here independently of `readiness-copy.ts` so a
 *  wrong mapping there fails this test (#541 review R1). `null`: nobody in the workspace can. */
const MISSING_FIX: Record<string, string | null> = {
  no_enabled_gate: 'request_connection',
  no_grant: 'grant_capability',
  excluded_by_policy: 'set_agent_policy',
  no_published_worker: 'publish_worker_definition',
  no_worker_gate: 'publish_worker_definition',
  excluded_by_profile: 'set_agent_profile',
  disabled_by_platform: null,
  // #538: the link opens the system's drawer, which says whose step it is — any reader may open it.
  definition_mismatch: 'get_gatekeeper',
};

const GATE_REASON_FIX: Record<string, string | null> = {
  not_granted: 'grant_capability',
  excluded_by_policy: 'set_agent_policy',
  no_published_operation: 'publish_operation',
  no_worker: 'publish_worker_definition',
  excluded_by_profile: 'set_agent_profile',
  disabled_by_platform: null,
  // Said on the system's own row (no link); no one to ask from here.
  definition_mismatch: null,
};

/** What the kernel would authorize: the role predicate, plus `set_agent_profile`'s own rule — a
 *  member edits only their own profile, and only when the policy allows it. */
function kernelAllows(
  capability: string | null,
  role: (typeof ROLE_VALUES)[number],
  memberCanEditProfile: boolean,
): boolean {
  if (capability === null) return false;
  if (!roleMayUseCapability(role, getCapability(capability))) return false;
  if (capability === 'set_agent_profile' && role !== 'owner') return memberCanEditProfile;
  return true;
}

describe('readiness fix links follow the kernel authorization (#541 review R1)', () => {
  it('maps every code to a capability the registry knows', () => {
    for (const capability of [...Object.values(MISSING_FIX), ...Object.values(GATE_REASON_FIX)]) {
      if (capability !== null) expect(getCapability(capability), capability).toBeDefined();
    }
    expect(Object.keys(MISSING_FIX).sort()).toEqual(
      [...ExecutionReadinessMissingCodeSchema.options].sort(),
    );
    expect(Object.keys(GATE_REASON_FIX).sort()).toEqual(
      [...GateUnreachableReasonSchema.options].sort(),
    );
  });

  for (const memberCanEditProfile of [true, false]) {
    it(`missing[] links: every code × role (memberCanEditProfile ${memberCanEditProfile})`, () => {
      for (const code of ExecutionReadinessMissingCodeSchema.options) {
        for (const role of ROLE_VALUES) {
          const reader: ReadinessReader = { role, memberCanEditProfile };
          const allowed = kernelAllows(MISSING_FIX[code] ?? null, role, memberCanEditProfile);
          const label = `${code} / ${role}`;
          expect(missingLinkHref({ code }, reader) !== undefined, label).toBe(allowed);
          // A reader with no link is told who to ask — unless nobody in the workspace can fix it.
          const ask = missingAsk({ code }, reader, t);
          expect(ask === undefined, label).toBe(allowed || MISSING_FIX[code] === null);
        }
      }
    });

    it(`gate reasons about the reader: every reason × role (memberCanEditProfile ${memberCanEditProfile})`, () => {
      for (const reason of GateUnreachableReasonSchema.options) {
        for (const role of ROLE_VALUES) {
          const reader: ReadinessReader = { role, memberCanEditProfile };
          const allowed = kernelAllows(GATE_REASON_FIX[reason] ?? null, role, memberCanEditProfile);
          expect(gateReasonHref(reason, reader) !== undefined, `${reason} / ${role}`).toBe(allowed);
        }
      }
    });
  }

  it('a member whose policy forbids editing 我的智能体 is told to ask an owner, not sent there', () => {
    const reader: ReadinessReader = { role: 'member', memberCanEditProfile: false };
    expect(missingLinkHref({ code: 'excluded_by_profile' }, reader)).toBeUndefined();
    expect(missingAsk({ code: 'excluded_by_profile' }, reader, t)).toContain('工作区所有者');
    expect(
      missingLinkHref(
        { code: 'excluded_by_profile' },
        { role: 'owner', memberCanEditProfile: false },
      ),
    ).toBe(hrefs.agent());
  });

  it('another member’s own 我的智能体 setting gets no link to the reader’s page (review R2)', () => {
    for (const role of ROLE_VALUES) {
      const reader: ReadinessReader = { role, memberCanEditProfile: true };
      expect(gateReasonHref('excluded_by_profile', reader, 'them'), role).toBeUndefined();
      expect(gateReasonAsk('excluded_by_profile', reader, t, 'them'), role).toBe(
        '要这位成员自己重新勾选。',
      );
    }
    // Their grant is still the owner's to make, on the reader's own access page.
    expect(gateReasonHref('not_granted', { role: 'owner' }, 'them')).toBe(hrefs.access());
  });

  it('an unknown role or policy keeps the link; the page it opens says what this role cannot do', () => {
    expect(missingLinkHref({ code: 'no_grant' }, { role: null })).toBe(hrefs.access());
    expect(missingLinkHref({ code: 'excluded_by_profile' }, { role: 'member' })).toBe(
      hrefs.agent(),
    );
  });

  it('no Worker published: an owner is sent to install ops-base, a builder to the 「Worker」 tab (UX acceptance of #679 P3-4)', () => {
    const item = { code: 'no_published_worker' } as const;
    expect(missingLinkHref(item, { role: 'owner' })).toBe(hrefs.catalog('packs', 'ops-base'));
    expect(missingLinkLabel(item, t, { role: 'owner' })).toMatch(/^去安装\s+ops-base$/);
    expect(missingAsk(item, { role: 'owner' }, t)).toBeUndefined();
    expect(missingLinkHref(item, { role: 'builder' })).toBe(hrefs.catalog('workers'));
    expect(missingLinkLabel(item, t, { role: 'builder' })).toBe('去能力目录');
    expect(missingAsk(item, { role: 'builder' }, t)).toBeUndefined();
    expect(missingLinkHref(item, { role: 'member' })).toBeUndefined();
    expect(missingAsk(item, { role: 'member' }, t)).toBeDefined();
    expect(missingCauseText(item, new Map(), t)).toMatch(/安装能力包\s+ops-base/);
  });

  it('never links to the page the reader is already on', () => {
    expect(
      missingLinkHref({ code: 'no_grant' }, { role: 'owner', currentHref: hrefs.access() }),
    ).toBeUndefined();
  });
});

describe('legacy 301: definition_mismatch copy says what the refused Operations have in common', () => {
  const changed = { operation: 'stock.get', awaiting: 'platform_adoption' as const };
  const dropped = { ...changed, operation: 'orders.cancel', droppedByGate: true as const };

  it('classifies a gate’s refused Operations', () => {
    expect(refusalKind([])).toBe('changed');
    expect(refusalKind([changed])).toBe('changed');
    expect(refusalKind([dropped])).toBe('dropped');
    expect(refusalKind([changed, dropped])).toBe('mixed');
  });

  it('the readiness strip’s cause line names a dropped gate as no longer providing them', () => {
    const kinds = refusalKindsOf([
      { gateId: 'g-dropped', definitionMismatch: [dropped] },
      { gateId: 'g-mixed', definitionMismatch: [changed, dropped] },
      { gateId: 'g-changed', definitionMismatch: [changed] },
    ]);
    const names = new Map([
      ['g-dropped', '库存'],
      ['g-mixed', '订单'],
      ['g-changed', '工单'],
    ]);
    const cause = (gateId: string) =>
      missingCauseText({ code: 'definition_mismatch', gateId }, names, t, kinds);
    expect(cause('g-dropped')).toBe(
      '门「库存」已不再提供其中一些已发布的操作，对它们的调用正被拒绝。',
    );
    expect(cause('g-mixed')).toContain('已不再提供其中一些已发布的操作，另一些运行的定义');
    expect(cause('g-changed')).toBe(
      '门「工单」运行的定义和已发布的不一样，对其中的操作调用正被拒绝。',
    );
  });
});
