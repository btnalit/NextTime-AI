// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RouteAccessProvider } from '../../hooks/useCanOpen.js';
import { PermissionsProvider } from '../../hooks/usePermissions.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { hrefs } from '../../lib/router.js';
import { RouteLink } from './route-link.js';

afterEach(cleanup);

function caller(role: string): CapabilityCaller {
  return {
    call: vi.fn(async (name: string) => {
      if (name === 'get_workspace')
        return { id: 'ws-1', name: 'Acme', caller: { id: 'p-1', role } };
      return {};
    }) as CapabilityCaller['call'],
  };
}

function renderLink(role: string, href: string, platformAdmin = false) {
  return render(
    <PermissionsProvider>
      <RouteAccessProvider http={caller(role)} platformAdmin={platformAdmin}>
        <RouteLink href={href} testId="link">
          查看溯源
        </RouteLink>
      </RouteAccessProvider>
    </PermissionsProvider>,
  );
}

describe('kit/route-link (#541 review N2)', () => {
  it('is a link for a role that can open the route', async () => {
    renderLink('auditor', hrefs.audit());
    expect(await screen.findByRole('link', { name: '查看溯源' })).toBeTruthy();
  });

  it('is text naming who can open it for a role that cannot', async () => {
    renderLink('operator', hrefs.audit());
    expect(await screen.findByText(/只有审计员和工作区所有者能打开/)).toBeTruthy();
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByTestId('link').getAttribute('data-route-refused')).toBe('true');
  });

  it('a platform route is the platform role’s to decide', async () => {
    renderLink('owner', hrefs.platformIntegrations());
    expect(await screen.findByText(/只有平台管理员能打开/)).toBeTruthy();
    cleanup();
    renderLink('member', hrefs.platformIntegrations(), true);
    expect(await screen.findByRole('link', { name: '查看溯源' })).toBeTruthy();
  });
});
