// @vitest-environment jsdom
import type { OntologyTypeWire, OntologyVersionListItemWire } from '@nexttime/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { PermissionsProvider } from '../../hooks/usePermissions.js';
import { HttpError } from '../../lib/http-client.js';
import { OntologyTypesDrawer } from './OntologyTypesDrawer.js';
import { type ScriptedHttp, scriptedHttp } from './test-fixtures.js';

afterEach(() => cleanup());

const OBJECT_TYPE: OntologyTypeWire = {
  kind: 'object',
  name: 'Host',
  description: 'A machine',
  identityKey: ['hostname'],
};

const LINK_TYPE: OntologyTypeWire = {
  kind: 'link',
  name: 'runs_on',
  signatures: [
    { domain: 'Container', range: 'Host', description: 'Container runs on a Host' },
    { domain: 'WorkerRun', range: 'Host', description: 'A Worker run runs on a Host' },
  ],
};

const ACTION_TYPE: OntologyTypeWire = {
  kind: 'action',
  name: 'docker_restart',
  description: 'Restart a container',
  mode: 'execute',
  blastRadius: 'medium',
  reversibility: true,
  autoApprovable: false,
  awaitDecision: true,
  requesterCanApprove: false,
};

const TYPES: readonly OntologyTypeWire[] = [OBJECT_TYPE, LINK_TYPE, ACTION_TYPE];

/** Controlled-props harness — `OntologyTypesDrawer` takes `open`/`activeTab`/`selectedTypeName`/
 *  `selectedProposal` from its caller (the graph page's hash query in production); the test drives
 *  the same pieces of state a `useGraphQuery` consumer would. */
function Harness({
  http,
  startOpen = true,
  startTab = 'types',
}: {
  readonly http: ScriptedHttp;
  readonly startOpen?: boolean;
  readonly startTab?: 'types' | 'proposals';
}) {
  const [open, setOpen] = useState(startOpen);
  const [activeTab, setActiveTab] = useState<'types' | 'proposals'>(startTab);
  const [typeName, setTypeName] = useState<string | undefined>(undefined);
  const [proposal, setProposal] = useState<
    { readonly id: string; readonly version: number } | undefined
  >(undefined);
  return (
    <OntologyTypesDrawer
      http={http}
      open={open}
      activeTab={activeTab}
      selectedTypeName={typeName}
      selectedProposal={proposal}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setTypeName(undefined);
          setProposal(undefined);
        }
      }}
      onTabChange={(tab) => {
        setActiveTab(tab);
        setTypeName(undefined);
        setProposal(undefined);
      }}
      onSelectType={setTypeName}
      onSelectProposal={setProposal}
    />
  );
}

function typesHttp(overrides: Parameters<typeof scriptedHttp>[0] = {}) {
  return scriptedHttp({
    list_types: () => ({ items: TYPES }),
    get_type: (params) => {
      const { typeName } = params as { typeName: string };
      return TYPES.find((row) => row.name === typeName) ?? null;
    },
    ...overrides,
  });
}

// -------------------------------------------------------------------------------------------
// Proposals tab (closing wave C5b, coverage gap G1 part 2) fixtures.
// -------------------------------------------------------------------------------------------

const DRAFT_PROPOSAL: OntologyVersionListItemWire = {
  id: 'ov-1',
  version: 3,
  status: 'draft',
  proposedBy: { id: 'p-alice', kind: 'human', displayName: 'Alice' },
  createdAt: '2026-09-20T10:00:00.000Z',
  definition: {
    // Widget is new (added); Host/docker_restart are absent from this draft (removed); runs_on
    // keeps the exact same signature set as TYPES's own LINK_TYPE (unchanged, omitted from the
    // diff).
    objectTypes: [{ name: 'Widget', description: 'A widget.', identityKey: ['widgetId'] }],
    linkTypes: [
      {
        name: 'runs_on',
        domain: 'Container',
        range: 'Host',
        description: 'Container runs on a Host',
      },
      {
        name: 'runs_on',
        domain: 'WorkerRun',
        range: 'Host',
        description: 'A Worker run runs on a Host',
      },
    ],
  },
};

const PUBLISHED_ROW: OntologyVersionListItemWire = {
  ...DRAFT_PROPOSAL,
  id: 'ov-0',
  version: 1,
  status: 'published',
};

function proposalsHttp(overrides: Parameters<typeof scriptedHttp>[0] = {}) {
  return typesHttp({
    list_ontology_versions: () => ({ items: [PUBLISHED_ROW, DRAFT_PROPOSAL] }),
    ...overrides,
  });
}

describe('OntologyTypesDrawer — closed', () => {
  it('renders nothing when closed', () => {
    render(<Harness http={typesHttp()} startOpen={false} />);
    expect(screen.queryByTestId('graph-types-drawer')).toBeNull();
  });

  it('closes from its own 关闭 button (no Cancel of its own; a phone may have no overlay to tap)', async () => {
    render(<Harness http={typesHttp()} />);
    fireEvent.click(await screen.findByTestId('graph-types-close'));
    await waitFor(() => expect(screen.queryByTestId('graph-types-drawer')).toBeNull());
  });
});

describe('OntologyTypesDrawer — list view', () => {
  it('loads, lists every kind with counts, searches by name and filters by kind', async () => {
    const http = typesHttp();
    render(<Harness http={http} />);
    expect(screen.getByTestId('graph-types-loading')).toBeTruthy();

    const rows = await screen.findAllByTestId('graph-type-row');
    expect(rows).toHaveLength(3);
    expect(http.callsTo('list_types')).toEqual([{}]);

    // Kind tabs carry the total counts.
    expect(screen.getByRole('tab', { name: /全部/ }).textContent).toContain('3');
    expect(screen.getByRole('tab', { name: /对象/ }).textContent).toContain('1');
    expect(screen.getByRole('tab', { name: /关系/ }).textContent).toContain('1');
    expect(screen.getByRole('tab', { name: /动作/ }).textContent).toContain('1');

    // Search narrows by substring, case-insensitive.
    fireEvent.change(screen.getByTestId('graph-types-search'), { target: { value: 'HOST' } });
    expect(await screen.findAllByTestId('graph-type-row')).toHaveLength(1);
    expect(screen.getByText('Host')).toBeTruthy();
    fireEvent.change(screen.getByTestId('graph-types-search'), { target: { value: '' } });

    // Kind tab narrows to just Link rows.
    fireEvent.click(screen.getByRole('tab', { name: /关系/ }));
    const linkRows = await screen.findAllByTestId('graph-type-row');
    expect(linkRows).toHaveLength(1);
    expect(linkRows[0]?.textContent).toContain('runs_on');
    expect(linkRows[0]?.textContent).toContain('Container → Host');
    expect(linkRows[0]?.textContent).toContain('+1');
  });

  it('shows the empty state when nothing matches', async () => {
    render(<Harness http={typesHttp()} />);
    await screen.findAllByTestId('graph-type-row');
    fireEvent.change(screen.getByTestId('graph-types-search'), {
      target: { value: 'nope-nothing' },
    });
    expect(await screen.findByTestId('graph-types-empty')).toBeTruthy();
  });

  it('shows the error state with retry', async () => {
    let calls = 0;
    const http = typesHttp({
      list_types: () => {
        calls += 1;
        if (calls === 1) throw new HttpError('capability_error', 'boom', 'internal_error');
        return { items: TYPES };
      },
    });
    render(<Harness http={http} />);
    const banner = await screen.findByTestId('graph-types-error');
    expect(banner.getAttribute('data-error-code')).toBe('internal_error');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findAllByTestId('graph-type-row');
  });
});

describe('OntologyTypesDrawer — detail view', () => {
  it('opens an ObjectType row via get_type and shows its identity key', async () => {
    const http = typesHttp();
    render(<Harness http={http} />);
    const rows = await screen.findAllByTestId('graph-type-row');
    const hostRow = rows.find((row) => row.textContent?.includes('Host'));
    fireEvent.click(hostRow as HTMLElement);

    const body = await screen.findByTestId('graph-type-detail-body');
    expect(http.callsTo('get_type')).toEqual([{ typeName: 'Host' }]);
    expect(body.textContent).toContain('A machine');
    expect(body.textContent).toContain('hostname');

    fireEvent.click(screen.getByTestId('graph-type-back'));
    await screen.findAllByTestId('graph-type-row');
    expect(screen.queryByTestId('graph-type-detail-body')).toBeNull();
  });

  it('opens a LinkType row and lists every domain → range signature', async () => {
    const http = typesHttp();
    render(<Harness http={http} />);
    const rows = await screen.findAllByTestId('graph-type-row');
    const linkRow = rows.find((row) => row.textContent?.includes('runs_on'));
    fireEvent.click(linkRow as HTMLElement);

    const signatures = await screen.findByTestId('graph-type-detail-signatures');
    expect(signatures.textContent).toContain('Container → Host');
    expect(signatures.textContent).toContain('WorkerRun → Host');
  });

  it('validates a candidate link against the LinkType’s signatures (gap G1’s `validate` half)', async () => {
    const http = typesHttp({
      validate: (params) => {
        const { link } = params as { link: { sourceType: string; targetType: string } };
        if (link.sourceType === 'Container' && link.targetType === 'Host') return { valid: true };
        return { valid: false, errors: ['unexpected pair'] };
      },
    });
    render(<Harness http={http} />);
    const rows = await screen.findAllByTestId('graph-type-row');
    const linkRow = rows.find((row) => row.textContent?.includes('runs_on'));
    fireEvent.click(linkRow as HTMLElement);
    await screen.findByTestId('graph-type-detail-signatures');

    const submit = screen.getByTestId('graph-type-validate-submit') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByTestId('graph-type-validate-source'), {
      target: { value: 'Container' },
    });
    fireEvent.change(screen.getByTestId('graph-type-validate-target'), {
      target: { value: 'Host' },
    });
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);

    const result = await screen.findByTestId('graph-type-validate-result');
    expect(result.textContent).toContain('符合');
    expect(http.callsTo('validate')).toEqual([
      { link: { linkType: 'runs_on', sourceType: 'Container', targetType: 'Host' } },
    ]);

    fireEvent.change(screen.getByTestId('graph-type-validate-target'), {
      target: { value: 'Wat' },
    });
    fireEvent.click(submit);
    const failed = await waitFor(() => {
      const el = screen.getByTestId('graph-type-validate-result');
      expect(el.textContent).toContain('不符合');
      return el;
    });
    expect(failed.textContent).toContain('unexpected pair');
  });

  it('opens an ActionType row and shows mode / blast radius / flags', async () => {
    const http = typesHttp();
    render(<Harness http={http} />);
    const rows = await screen.findAllByTestId('graph-type-row');
    const actionRow = rows.find((row) => row.textContent?.includes('docker_restart'));
    fireEvent.click(actionRow as HTMLElement);

    const body = await screen.findByTestId('graph-type-detail-body');
    expect(body.querySelector('[data-status="execute"]')).toBeTruthy();
    expect(body.querySelector('[data-status="medium"]')).toBeTruthy();
    expect(body.querySelector('[data-status="false"]')).toBeTruthy();
    const flags = screen.getByTestId('graph-type-detail-flags');
    expect(flags.textContent).toContain('是');
    expect(flags.textContent).toContain('否');
  });

  it('shows a missing state when get_type returns null (e.g. removed between list and open)', async () => {
    const http = typesHttp({ get_type: () => null });
    render(<Harness http={http} />);
    const rows = await screen.findAllByTestId('graph-type-row');
    fireEvent.click(rows[0] as HTMLElement);
    expect(await screen.findByTestId('graph-type-detail-missing')).toBeTruthy();
  });

  it('shows the error state with retry on the detail view', async () => {
    let calls = 0;
    const http = typesHttp({
      get_type: () => {
        calls += 1;
        if (calls === 1) throw new HttpError('capability_error', 'boom', 'forbidden');
        return OBJECT_TYPE;
      },
    });
    render(<Harness http={http} />);
    const rows = await screen.findAllByTestId('graph-type-row');
    fireEvent.click(rows[0] as HTMLElement);
    const banner = await screen.findByTestId('graph-type-detail-error');
    expect(banner.getAttribute('data-error-code')).toBe('forbidden');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByTestId('graph-type-detail-error')).toBeNull());
    await screen.findByTestId('graph-type-detail-body');
  });
});

describe('OntologyTypesDrawer — tabs', () => {
  it('defaults to the Types tab and switches to Proposals on click', async () => {
    const http = proposalsHttp();
    render(<Harness http={http} />);
    expect(await screen.findByTestId('graph-types-list-view')).toBeTruthy();
    fireEvent.click(screen.getByTestId('graph-ontology-tab-proposals'));
    expect(await screen.findByTestId('graph-proposals-list-view')).toBeTruthy();
    expect(screen.queryByTestId('graph-types-list-view')).toBeNull();
  });
});

describe('OntologyTypesDrawer — Proposals list view', () => {
  it('lists only drafts (published rows are not review targets), with proposer, status and version', async () => {
    const http = proposalsHttp();
    render(<Harness http={http} startTab="proposals" />);
    const rows = await screen.findAllByTestId('graph-proposal-row');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toContain('Alice');
    expect(rows[0]?.textContent).toContain('v3');
    expect(http.callsTo('list_ontology_versions')).toEqual([{}]);
  });

  it('shows the empty state when there are no drafts to review', async () => {
    const http = proposalsHttp({ list_ontology_versions: () => ({ items: [PUBLISHED_ROW] }) });
    render(<Harness http={http} startTab="proposals" />);
    expect(await screen.findByTestId('graph-proposals-empty')).toBeTruthy();
  });

  it('shows the error state with retry', async () => {
    let calls = 0;
    const http = proposalsHttp({
      list_ontology_versions: () => {
        calls += 1;
        if (calls === 1) throw new HttpError('capability_error', 'boom', 'internal_error');
        return { items: [DRAFT_PROPOSAL] };
      },
    });
    render(<Harness http={http} startTab="proposals" />);
    const banner = await screen.findByTestId('graph-proposals-error');
    expect(banner.getAttribute('data-error-code')).toBe('internal_error');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findAllByTestId('graph-proposal-row');
  });
});

describe('OntologyTypesDrawer — Proposal detail view', () => {
  it('opens a draft and diffs it against the currently-visible types', async () => {
    const http = proposalsHttp();
    render(<Harness http={http} startTab="proposals" />);
    const rows = await screen.findAllByTestId('graph-proposal-row');
    fireEvent.click(rows[0] as HTMLElement);

    const body = await screen.findByTestId('graph-proposal-detail-body');
    expect(body.textContent).toContain('Alice');
    expect(body.textContent).toContain('v3');

    const diffRows = await screen.findAllByTestId('graph-proposal-diff-row');
    const diffTexts = diffRows.map((row) => row.textContent ?? '');
    expect(diffTexts.some((text) => text.includes('Widget'))).toBe(true);
    expect(diffTexts.some((text) => text.includes('Host'))).toBe(true);
    // runs_on keeps the identical signature set in the draft — no diff row for it.
    expect(diffTexts.some((text) => text.includes('runs_on'))).toBe(false);
  });

  it('shows a missing state when the proposal is not (or no longer) visible', async () => {
    const http = proposalsHttp();
    function Harness2() {
      return (
        <OntologyTypesDrawer
          http={http}
          open
          activeTab="proposals"
          selectedTypeName={undefined}
          selectedProposal={{ id: 'does-not-exist', version: 1 }}
          onOpenChange={() => {}}
          onTabChange={() => {}}
          onSelectType={() => {}}
          onSelectProposal={() => {}}
        />
      );
    }
    render(<Harness2 />);
    expect(await screen.findByTestId('graph-proposal-detail-missing')).toBeTruthy();
  });
});

describe('OntologyTypesDrawer — publish a proposal', () => {
  it('gates the danger button on the acknowledgement checkbox, publishes, then refreshes both lists and returns to the list view', async () => {
    let published = false;
    const http = proposalsHttp({
      list_ontology_versions: () =>
        published
          ? { items: [PUBLISHED_ROW, { ...DRAFT_PROPOSAL, status: 'published' }] }
          : { items: [PUBLISHED_ROW, DRAFT_PROPOSAL] },
      publish_ontology_version: (params) => {
        const { id, version } = params as { id: string; version: number };
        expect(id).toBe(DRAFT_PROPOSAL.id);
        expect(version).toBe(DRAFT_PROPOSAL.version);
        published = true;
        return { id, version, status: 'published', publishedAt: '2026-09-20T11:00:00.000Z' };
      },
    });
    render(<Harness http={http} startTab="proposals" />);
    const rows = await screen.findAllByTestId('graph-proposal-row');
    fireEvent.click(rows[0] as HTMLElement);
    await screen.findByTestId('graph-proposal-detail-body');

    fireEvent.click(screen.getByTestId('graph-proposal-publish'));
    const confirm = await screen.findByTestId('graph-proposal-publish-confirm');
    const confirmButton = within(confirm).getByTestId('confirm-button') as HTMLButtonElement;
    expect(confirmButton.disabled).toBe(true);
    fireEvent.click(within(confirm).getByTestId('confirm-acknowledge'));
    expect(confirmButton.disabled).toBe(false);
    fireEvent.click(confirmButton);

    // Back on the list view; the just-published draft no longer shows (only drafts are listed).
    await screen.findByTestId('graph-proposals-list-view');
    await waitFor(() => expect(screen.queryAllByTestId('graph-proposal-row')).toHaveLength(0));
    expect(http.callsTo('publish_ontology_version')).toEqual([
      { id: DRAFT_PROPOSAL.id, version: DRAFT_PROPOSAL.version },
    ]);
    // Both reads were re-fetched, not just invalidated-and-left-stale.
    expect(http.callsTo('list_ontology_versions').length).toBeGreaterThan(1);
    expect(http.callsTo('list_types').length).toBeGreaterThan(1);
  });

  it('shows the kernel’s own refusal inline in the confirm, and hides the button on the next visit', async () => {
    const http = proposalsHttp({
      publish_ontology_version: () =>
        Promise.reject(new HttpError('capability_error', 'already published', 'forbidden')),
    });
    render(
      <PermissionsProvider>
        <Harness http={http} startTab="proposals" />
      </PermissionsProvider>,
    );
    const rows = await screen.findAllByTestId('graph-proposal-row');
    fireEvent.click(rows[0] as HTMLElement);
    await screen.findByTestId('graph-proposal-detail-body');

    fireEvent.click(screen.getByTestId('graph-proposal-publish'));
    const confirm = await screen.findByTestId('graph-proposal-publish-confirm');
    fireEvent.click(within(confirm).getByTestId('confirm-acknowledge'));
    fireEvent.click(within(confirm).getByTestId('confirm-button'));

    const banner = await within(confirm).findByTestId('confirm-error');
    expect(banner.getAttribute('data-error-code')).toBe('forbidden');
    // The confirm the caller was already looking at stays open — never ripped away mid-flow.
    expect(screen.getByTestId('graph-proposal-publish-confirm')).toBeTruthy();

    fireEvent.click(within(confirm).getByTestId('confirm-cancel'));
    await waitFor(() => expect(screen.queryByTestId('graph-proposal-publish-confirm')).toBeNull());
    // A denial recorded for the session hides the entry point on this next visit.
    expect(screen.queryByTestId('graph-proposal-publish')).toBeNull();
  });
});

describe('OntologyTypesDrawer — discard a proposal', () => {
  it('shows Discard on a draft, calls discard_draft{kind:ontology_version,id,version} only after confirm, then refreshes the list', async () => {
    let discarded = false;
    const http = proposalsHttp({
      list_ontology_versions: () =>
        discarded ? { items: [PUBLISHED_ROW] } : { items: [PUBLISHED_ROW, DRAFT_PROPOSAL] },
      discard_draft: (params) => {
        discarded = true;
        return params;
      },
    });
    render(<Harness http={http} startTab="proposals" />);
    const rows = await screen.findAllByTestId('graph-proposal-row');
    fireEvent.click(rows[0] as HTMLElement);
    await screen.findByTestId('graph-proposal-detail-body');

    fireEvent.click(screen.getByTestId('graph-proposal-discard'));
    const confirm = await screen.findByTestId('graph-proposal-discard-confirm');
    expect(http.callsTo('discard_draft')).toHaveLength(0);
    fireEvent.click(within(confirm).getByTestId('confirm-button'));

    await screen.findByTestId('graph-proposals-list-view');
    await waitFor(() => expect(screen.queryAllByTestId('graph-proposal-row')).toHaveLength(0));
    expect(http.callsTo('discard_draft')).toEqual([
      { kind: 'ontology_version', id: DRAFT_PROPOSAL.id, version: DRAFT_PROPOSAL.version },
    ]);
    expect(http.callsTo('list_ontology_versions').length).toBeGreaterThan(1);
  });

  it('shows the kernel refusal inline in the confirm', async () => {
    const http = proposalsHttp({
      discard_draft: () =>
        Promise.reject(new HttpError('capability_error', 'not found', 'not_found')),
    });
    render(<Harness http={http} startTab="proposals" />);
    const rows = await screen.findAllByTestId('graph-proposal-row');
    fireEvent.click(rows[0] as HTMLElement);
    await screen.findByTestId('graph-proposal-detail-body');
    fireEvent.click(screen.getByTestId('graph-proposal-discard'));
    const confirm = await screen.findByTestId('graph-proposal-discard-confirm');
    fireEvent.click(within(confirm).getByTestId('confirm-button'));
    expect(await within(confirm).findByTestId('confirm-error')).toBeTruthy();
  });
});
