// @vitest-environment jsdom
import type { PackComponentStateWire, PackWire } from '@nexttime/shared';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CapabilityCaller } from '../../lib/clients.js';
import { PackOrigin, type PackOriginTarget } from './PackOrigin.js';

afterEach(() => {
  cleanup();
});

const SKILL = '11111111-2222-4333-8444-555555555555';
const WORKER = '66666666-7777-4888-8999-000000000000';

function pack(components: readonly PackComponentStateWire[]): PackWire {
  return {
    name: 'ops-base',
    summary: 'Hosts and the services on them',
    latestVersion: 3,
    versions: [],
    status: 'up_to_date',
    installedVersion: 3,
    components: [...components],
    requirements: [],
    dependencies: [],
  };
}

function skill(patch: Partial<PackComponentStateWire> = {}): PackComponentStateWire {
  return {
    kind: 'skill',
    name: 'ops-triage',
    skillId: SKILL,
    status: 'up_to_date',
    installedVersion: 3,
    provenance: { status: 'unrecorded' },
    ...patch,
  } as PackComponentStateWire;
}

function worker(patch: Partial<PackComponentStateWire> = {}): PackComponentStateWire {
  return {
    kind: 'worker',
    name: 'ops-operator',
    definitionId: WORKER,
    headVersion: 4,
    status: 'up_to_date',
    installedVersion: 3,
    systems: ['docker'],
    gates: [],
    gatesKept: false,
    bindable: false,
    provenance: { status: 'unrecorded' },
    ...patch,
  } as PackComponentStateWire;
}

function httpReturning(items: readonly PackWire[]): CapabilityCaller {
  // A caller of its own per test: the capability cache is per caller, so nothing leaks between tests.
  return {
    call: vi.fn(async (name: string) => {
      if (name !== 'list_packs') throw new Error(`unscripted capability ${name}`);
      return { items };
    }) as CapabilityCaller['call'],
  };
}

function show(http: CapabilityCaller, target: PackOriginTarget) {
  return render(<PackOrigin http={http} target={target} testId="origin" />);
}

describe('PackOrigin (STATUS leftover 418)', () => {
  it('names the pack and the version that installed a Skill, linking to the pack', async () => {
    show(httpReturning([pack([skill()])]), { kind: 'skill', skillId: SKILL });
    const origin = await screen.findByTestId('origin');
    expect(origin.textContent).toContain('来自能力包');
    expect(origin.textContent).toContain('v3');
    expect(screen.getByTestId('origin-link').textContent).toBe('ops-base');
    expect(screen.getByTestId('origin-link').getAttribute('href')).toContain('ops-base');
  });

  it('says a customized Skill was changed outside the pack', async () => {
    show(httpReturning([pack([skill({ status: 'customized', installedVersion: null })])]), {
      kind: 'skill',
      skillId: SKILL,
    });
    expect((await screen.findByTestId('origin')).textContent).toContain('在能力包之外改过');
  });

  it('marks only the Worker version that is the published head', async () => {
    const http = httpReturning([pack([worker()])]);
    const { unmount } = show(http, { kind: 'worker', definitionId: WORKER, version: 4 });
    expect((await screen.findByTestId('origin')).textContent).toContain('v3');
    unmount();
    show(http, { kind: 'worker', definitionId: WORKER, version: 3 });
    await waitFor(() => expect(http.call).toHaveBeenCalled());
    expect(screen.queryByTestId('origin')).toBeNull();
  });

  it('says nothing for something no pack installed, or a component not installed', async () => {
    const http = httpReturning([
      pack([skill({ status: 'not_installed', installedVersion: null })]),
    ]);
    show(http, { kind: 'skill', skillId: SKILL });
    await waitFor(() => expect(http.call).toHaveBeenCalled());
    expect(screen.queryByTestId('origin')).toBeNull();
  });

  it('says nothing when list_packs fails (a member the call refuses)', async () => {
    const http: CapabilityCaller = {
      call: vi.fn(async () => {
        throw new Error('forbidden');
      }) as CapabilityCaller['call'],
    };
    show(http, { kind: 'skill', skillId: SKILL });
    await waitFor(() => expect(http.call).toHaveBeenCalled());
    expect(screen.queryByTestId('origin')).toBeNull();
  });
});
