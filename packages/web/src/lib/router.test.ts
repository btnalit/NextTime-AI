import { describe, expect, it } from 'vitest';
import { type Route, hrefs, routeFromHash, sectionOf } from './router.js';

describe('routeFromHash', () => {
  it('parses every S3.14 route, including optional trailing segments', () => {
    expect(routeFromHash('#/login')).toEqual({ kind: 'login' });
    expect(routeFromHash('#/work/chats')).toEqual({ kind: 'chats' });
    expect(routeFromHash('#/work/chats/c-1')).toEqual({ kind: 'chat', chatId: 'c-1' });
    expect(routeFromHash('#/work/approvals')).toEqual({ kind: 'approvals' });
    expect(routeFromHash('#/work/approvals/ar-1')).toEqual({
      kind: 'approvals',
      actionRequestId: 'ar-1',
    });
    expect(routeFromHash('#/work/tasks')).toEqual({ kind: 'tasks' });
    expect(routeFromHash('#/work/tasks/t-1')).toEqual({ kind: 'tasks', taskId: 't-1' });
    expect(routeFromHash('#/me/agent')).toEqual({ kind: 'agent' });
    expect(routeFromHash('#/me/account')).toEqual({ kind: 'account' });
    expect(routeFromHash('#/govern/members')).toEqual({ kind: 'members' });
    expect(routeFromHash('#/govern/access')).toEqual({ kind: 'access' });
    expect(routeFromHash('#/govern/systems')).toEqual({ kind: 'systems' });
    expect(routeFromHash('#/govern/systems/gk-1')).toEqual({
      kind: 'systems',
      gatekeeperId: 'gk-1',
    });
    expect(routeFromHash('#/govern/catalog')).toEqual({ kind: 'catalog', tab: 'operations' });
    expect(routeFromHash('#/govern/catalog/skills')).toEqual({ kind: 'catalog', tab: 'skills' });
    expect(routeFromHash('#/govern/models')).toEqual({ kind: 'models' });
    expect(routeFromHash('#/govern/audit')).toEqual({ kind: 'audit' });
    expect(routeFromHash('#/platform/overview')).toEqual({ kind: 'platformOverview' });
    expect(routeFromHash('#/platform/users')).toEqual({ kind: 'platformUsers' });
    expect(routeFromHash('#/platform/workspaces')).toEqual({ kind: 'platformWorkspaces' });
    expect(routeFromHash('#/platform/integrations')).toEqual({ kind: 'platformIntegrations' });
    expect(routeFromHash('#/platform/settings')).toEqual({ kind: 'platformSettings' });
    expect(routeFromHash('#/platform/audit')).toEqual({ kind: 'platformAudit' });
  });

  it('an unrecognized catalog tab segment falls back to "operations", not an error', () => {
    expect(routeFromHash('#/govern/catalog/not-a-tab')).toEqual({
      kind: 'catalog',
      tab: 'operations',
    });
  });

  it('decodes URI-encoded ids', () => {
    expect(routeFromHash(`#/work/chats/${encodeURIComponent('c/1')}`)).toEqual({
      kind: 'chat',
      chatId: 'c/1',
    });
  });

  it('an unknown or empty hash falls back to /work/chats (the default work view)', () => {
    expect(routeFromHash('')).toEqual({ kind: 'chats' });
    expect(routeFromHash('#/')).toEqual({ kind: 'chats' });
    expect(routeFromHash('#/nonsense')).toEqual({ kind: 'chats' });
    // Every pre-S3.14 hash (no work/me/govern prefix) also falls back — a stale bookmark never
    // 404s, it just lands on the default view.
    expect(routeFromHash('#/chats')).toEqual({ kind: 'chats' });
    expect(routeFromHash('#/connections')).toEqual({ kind: 'chats' });
  });
});

describe('sectionOf', () => {
  it('collapses route variants onto their one Sidebar nav item', () => {
    expect(sectionOf({ kind: 'chat', chatId: 'c-1' })).toBe('chats');
    expect(sectionOf({ kind: 'chats' })).toBe('chats');
    expect(sectionOf({ kind: 'approvals', actionRequestId: 'ar-1' })).toBe('approvals');
    expect(sectionOf({ kind: 'systems', gatekeeperId: 'gk-1' })).toBe('systems');
    expect(sectionOf({ kind: 'catalog', tab: 'skills' })).toBe('catalog');
    expect(sectionOf({ kind: 'login' })).toBe('chats');
    expect(sectionOf({ kind: 'platformOverview' })).toBe('platformOverview');
    expect(sectionOf({ kind: 'platformAudit' })).toBe('platformAudit');
  });
});

describe('hrefs', () => {
  it('every href round-trips through routeFromHash back to an equivalent route', () => {
    const cases: readonly Route[] = [
      { kind: 'login' },
      { kind: 'chats' },
      { kind: 'chat', chatId: 'c-1' },
      { kind: 'approvals' },
      { kind: 'approvals', actionRequestId: 'ar-1' },
      { kind: 'tasks' },
      { kind: 'tasks', taskId: 't-1' },
      { kind: 'agent' },
      { kind: 'account' },
      { kind: 'members' },
      { kind: 'access' },
      { kind: 'systems' },
      { kind: 'systems', gatekeeperId: 'gk-1' },
      { kind: 'catalog', tab: 'operations' },
      { kind: 'catalog', tab: 'workers' },
      { kind: 'models' },
      { kind: 'audit' },
      { kind: 'platformOverview' },
      { kind: 'platformUsers' },
      { kind: 'platformWorkspaces' },
      { kind: 'platformIntegrations' },
      { kind: 'platformSettings' },
      { kind: 'platformAudit' },
    ];
    for (const route of cases) {
      const href = hrefFor(route);
      expect(routeFromHash(href)).toEqual(route);
    }
  });
});

function hrefFor(route: Route): string {
  switch (route.kind) {
    case 'login':
      return hrefs.login();
    case 'chats':
      return hrefs.chats();
    case 'chat':
      return hrefs.chat(route.chatId);
    case 'approvals':
      return route.actionRequestId ? hrefs.approval(route.actionRequestId) : hrefs.approvals();
    case 'tasks':
      return route.taskId ? hrefs.task(route.taskId) : hrefs.tasks();
    case 'agent':
      return hrefs.agent();
    case 'account':
      return hrefs.account();
    case 'members':
      return hrefs.members();
    case 'access':
      return hrefs.access();
    case 'systems':
      return route.gatekeeperId ? hrefs.gatekeeper(route.gatekeeperId) : hrefs.systems();
    case 'catalog':
      return hrefs.catalog(route.tab);
    case 'models':
      return hrefs.models();
    case 'audit':
      return hrefs.audit();
    case 'platformOverview':
      return hrefs.platformOverview();
    case 'platformUsers':
      return hrefs.platformUsers();
    case 'platformWorkspaces':
      return hrefs.platformWorkspaces();
    case 'platformIntegrations':
      return hrefs.platformIntegrations();
    case 'platformSettings':
      return hrefs.platformSettings();
    case 'platformAudit':
      return hrefs.platformAudit();
  }
}
