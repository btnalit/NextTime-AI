import { describe, expect, it } from 'vitest';
import type { Translate } from './i18n.js';
import { GOVERN_NAV, NAV_GROUPS, PLATFORM_NAV, WORK_NAV, breadcrumbFor } from './nav.js';

const ZH: Translate = (zh) => zh;
const EN: Translate = (_zh, en) => en;

describe('lib/nav', () => {
  it('NAV_GROUPS holds the three groups in 使用/治理/平台', () => {
    expect(NAV_GROUPS.map((g) => g.id)).toEqual(['use', 'govern', 'platform']);
    expect(NAV_GROUPS.map((g) => g.titleZh)).toEqual(['使用', '治理', '平台']);
    expect(NAV_GROUPS[0]?.items).toBe(WORK_NAV);
    expect(NAV_GROUPS[1]?.items).toBe(GOVERN_NAV);
    expect(NAV_GROUPS[2]?.items).toBe(PLATFORM_NAV);
  });

  it('breadcrumbFor resolves a 使用-group section to [使用, <page label>]', () => {
    expect(breadcrumbFor('chats', ZH)).toEqual([{ label: '使用' }, { label: '对话' }]);
    expect(breadcrumbFor('agent', ZH)).toEqual([{ label: '使用' }, { label: '我的智能体' }]);
  });

  it('breadcrumbFor resolves a 治理-group section to [治理, <page label>]', () => {
    expect(breadcrumbFor('members', ZH)).toEqual([{ label: '治理' }, { label: '成员与授权' }]);
    expect(breadcrumbFor('systems', ZH)).toEqual([{ label: '治理' }, { label: '系统与授权' }]);
  });

  it('breadcrumbFor resolves a 平台-group section to [平台, <page label>]', () => {
    expect(breadcrumbFor('platformOverview', ZH)).toEqual([{ label: '平台' }, { label: '概览' }]);
    expect(breadcrumbFor('platformAudit', ZH)).toEqual([{ label: '平台' }, { label: '平台审计' }]);
  });

  it('breadcrumbFor follows the console language: the English console reads English crumbs (legacy 611)', () => {
    expect(breadcrumbFor('approvals', EN)).toEqual([{ label: 'Use' }, { label: 'Approvals' }]);
    expect(breadcrumbFor('catalog', EN)).toEqual([{ label: 'Govern' }, { label: 'Catalog' }]);
    expect(breadcrumbFor('platformSettings', EN)).toEqual([
      { label: 'Platform' },
      { label: 'Platform settings' },
    ]);
  });

  it('group crumbs never carry an href (no group has a landing page of its own)', () => {
    for (const group of NAV_GROUPS) {
      for (const item of group.items) {
        const [groupCrumb] = breadcrumbFor(item.section, ZH);
        expect(groupCrumb?.href).toBeUndefined();
      }
    }
  });

  it('every NavItem across all three groups resolves to a non-empty breadcrumb', () => {
    for (const group of NAV_GROUPS) {
      for (const item of group.items) {
        expect(breadcrumbFor(item.section, ZH)).toHaveLength(2);
      }
    }
  });
});
