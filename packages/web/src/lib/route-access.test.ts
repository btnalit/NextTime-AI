import { describe, expect, it } from 'vitest';
import { auditHref } from './audit.js';
import { auditHrefForNode } from './graph-route.js';
import { roleMayOpen, routeRequirement } from './route-access.js';
import { hrefs } from './router.js';

describe('lib/route-access (#541 review N2)', () => {
  it('declares what the approvals, members, audit and platform routes need', () => {
    expect(routeRequirement(hrefs.approvals())).toEqual({ capability: 'list_pending' });
    expect(routeRequirement(hrefs.approval('ar-1'))).toEqual({ capability: 'list_pending' });
    expect(routeRequirement(hrefs.members())).toEqual({ capability: 'list_principals' });
    expect(routeRequirement(auditHref({ nodeId: 'n-1' }))).toEqual({ capability: 'audit_query' });
    expect(routeRequirement(auditHrefForNode('n-1'))).toEqual({ capability: 'audit_query' });
    expect(routeRequirement(hrefs.platformIntegrations())).toEqual({ platformAdmin: true });
    expect(routeRequirement(hrefs.platformModelsProvider('p'))).toEqual({ platformAdmin: true });
  });

  it('leaves every other route open to the workspace, and hrefs outside the hash router alone', () => {
    for (const href of [
      hrefs.chats(),
      hrefs.task('t'),
      hrefs.systems(),
      hrefs.catalog(),
      hrefs.models(),
    ]) {
      expect(routeRequirement(href), href).toBeUndefined();
    }
    expect(routeRequirement('/explorer/')).toBeUndefined();
  });

  it('opens a route to exactly the roles the kernel lets read its page', () => {
    expect(roleMayOpen('operator', hrefs.approval('ar-1'))).toBe(true);
    expect(roleMayOpen('member', hrefs.approval('ar-1'))).toBe(false);
    expect(roleMayOpen('operator', auditHrefForNode('n'))).toBe(false);
    expect(roleMayOpen('auditor', auditHrefForNode('n'))).toBe(true);
    expect(roleMayOpen('auditor', hrefs.members())).toBe(false);
    expect(roleMayOpen('member', hrefs.systems())).toBe(true);
  });
});
