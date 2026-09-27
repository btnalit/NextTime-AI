// @vitest-environment jsdom
import type { OntologyTypeWire } from '@nexttime/shared';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
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

/** Controlled-props harness — `OntologyTypesDrawer` takes `open`/`selectedTypeName` from its
 *  caller (the graph page's hash query in production); the test drives the same two pieces of
 *  state a `useGraphQuery` consumer would. */
function Harness({
  http,
  startOpen = true,
}: { readonly http: ScriptedHttp; readonly startOpen?: boolean }) {
  const [open, setOpen] = useState(startOpen);
  const [typeName, setTypeName] = useState<string | undefined>(undefined);
  return (
    <OntologyTypesDrawer
      http={http}
      open={open}
      selectedTypeName={typeName}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setTypeName(undefined);
      }}
      onSelectType={setTypeName}
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

describe('OntologyTypesDrawer — closed', () => {
  it('renders nothing when closed', () => {
    render(<Harness http={typesHttp()} startOpen={false} />);
    expect(screen.queryByTestId('graph-types-drawer')).toBeNull();
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
