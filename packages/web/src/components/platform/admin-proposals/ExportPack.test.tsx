// @vitest-environment jsdom
import type {
  AdminProposalPackExportWire,
  AdminProposalSegmentWire,
  AdminProposalWire,
} from '@nexttime/shared';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CapabilityCaller } from '../../../lib/clients.js';
import { HttpError } from '../../../lib/http-client.js';
import { ExportPack } from './ExportPack.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const SEGMENT: AdminProposalSegmentWire = {
  id: 'seg-1',
  ordinal: 2,
  authority: 'workspace',
  targetWorkspaceId: 'ws-target',
  items: [
    {
      kind: 'skill_version',
      skill: { name: 'ticket-triage', description: 'Triage a ticket.', markdown: '# Triage' },
    },
    { kind: 'operation_version', gateId: 'tickets-prod', name: 'ticket.close', set: {} },
  ],
  contentDigest: 'sha256:aa',
  status: 'applied',
  decidedAt: '2026-11-06T00:00:00.000Z',
  withdrawnOrigin: null,
  reason: null,
  rolledBackAt: null,
};

const PROPOSAL = {
  id: 'p-1',
  title: 'Ticket triage everywhere',
  sourceName: 'ticket-desk',
  segments: [SEGMENT],
} as unknown as AdminProposalWire;

const PACK: AdminProposalPackExportWire = {
  name: 'ticket-desk',
  version: 1,
  digest: `sha256:${'b'.repeat(64)}`,
  files: [
    { path: 'ticket-desk/1/pack.yaml', content: 'schema: 1\n' },
    { path: 'ticket-desk/1/skills/ticket-triage.md', content: '---\nname: ticket-triage\n---\n' },
  ],
  omitted: [{ index: 1, kind: 'operation_version', gateId: 'tickets-prod', name: 'ticket.close' }],
};

function httpWith(
  answer: () => unknown,
): CapabilityCaller & { readonly call: ReturnType<typeof vi.fn> } {
  return {
    call: vi.fn(async (name: string) => {
      if (name !== 'export_admin_proposal_pack') throw new Error(`unscripted capability ${name}`);
      return answer();
    }),
  } as unknown as CapabilityCaller & { readonly call: ReturnType<typeof vi.fn> };
}

function renderExport(http: CapabilityCaller) {
  render(<ExportPack http={http} proposal={PROPOSAL} segment={SEGMENT} testIdPrefix="part-2" />);
  fireEvent.click(screen.getByTestId('part-2-export-trigger'));
}

/** S11 AA5d-3: exporting an applied workspace part as a pack from the platform's proposal page. */
describe('ExportPack', () => {
  it('starts from the title and the Operation changes it leaves out, exports, and downloads one tar', async () => {
    const http = httpWith(() => PACK);
    renderExport(http);
    const summary = screen.getByTestId('part-2-export-summary') as HTMLTextAreaElement;
    const notes = screen.getByTestId('part-2-export-notes') as HTMLTextAreaElement;
    expect(summary.value).toBe('Ticket triage everywhere');
    expect(notes.value).toContain('不带下面这些 Operation 改动');
    expect(notes.value).toContain('- tickets-prod · ticket.close');
    expect(screen.getByText(/已经写好了它不带的 Operation 改动/)).toBeTruthy();
    expect(screen.getByTestId('part-2-export-dialog').textContent).toContain('ticket-desk');

    fireEvent.change(summary, { target: { value: '  Ticket triage, from the admin agent.  ' } });
    fireEvent.click(screen.getByTestId('part-2-export-submit'));
    await screen.findByTestId('part-2-export-result');
    expect(http.call).toHaveBeenCalledWith('export_admin_proposal_pack', {
      segmentId: 'seg-1',
      summary: 'Ticket triage, from the admin agent.',
      notes: notes.value.trim(),
    });
    expect(screen.getByTestId('part-2-export-files').textContent).toContain(
      'ticket-desk/1/skills/ticket-triage.md',
    );
    expect(screen.getByTestId('part-2-export-omitted').textContent).toContain(
      'tickets-prod · ticket.close',
    );

    const createObjectURL = vi.fn((_blob: Blob) => 'blob:pack');
    const revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const download = screen.getByTestId('part-2-export-download');
    expect(download.textContent).toContain('ticket-desk-1.tar');
    fireEvent.click(download);
    expect(click).toHaveBeenCalledTimes(1);
    const blob = createObjectURL.mock.calls[0]?.[0];
    expect(blob?.type).toBe('application/x-tar');
    // Two files, each a header and one block, then two zero blocks.
    expect(blob?.size).toBe(512 * 6);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:pack');
  });

  it('a path the tar cannot hold downloads nothing and says which (#501 on #977)', async () => {
    const http = httpWith(() => ({
      ...PACK,
      files: [...PACK.files, { path: 'ticket-desk/1/skills/a\0b.md', content: '' }],
    }));
    renderExport(http);
    fireEvent.click(screen.getByTestId('part-2-export-submit'));
    await screen.findByTestId('part-2-export-result');
    const createObjectURL = vi.fn((_blob: Blob) => 'blob:pack');
    Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    fireEvent.click(screen.getByTestId('part-2-export-download'));
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(click).not.toHaveBeenCalled();
    const notice = screen.getByTestId('part-2-export-download-failed').textContent ?? '';
    expect(notice).toContain('有一个文件的路径放不进');
    expect(notice).toContain('ticket-desk/1/skills/a\\u0000b.md');
  });

  it('a summary is required; empty notes are not sent', async () => {
    const http = httpWith(() => PACK);
    render(
      <ExportPack
        http={http}
        proposal={PROPOSAL}
        segment={{ ...SEGMENT, items: [SEGMENT.items[0] as AdminProposalSegmentWire['items'][0]] }}
        testIdPrefix="part-2"
      />,
    );
    fireEvent.click(screen.getByTestId('part-2-export-trigger'));
    expect((screen.getByTestId('part-2-export-notes') as HTMLTextAreaElement).value).toBe('');
    // Nothing left out, so the hint does not say the notes already list it.
    expect(screen.getByText('选填，写进能力包，给工作区所有者看。')).toBeTruthy();
    expect(screen.queryByText(/已经写好了/)).toBeNull();
    fireEvent.change(screen.getByTestId('part-2-export-summary'), { target: { value: '   ' } });
    const submit = screen.getByTestId('part-2-export-submit') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    expect(submit.title).toBe('先写一句简介');
    fireEvent.change(screen.getByTestId('part-2-export-summary'), { target: { value: 'Triage.' } });
    fireEvent.click(submit);
    await screen.findByTestId('part-2-export-result');
    expect(http.call).toHaveBeenCalledWith('export_admin_proposal_pack', {
      segmentId: 'seg-1',
      summary: 'Triage.',
    });
  });

  it('a refusal lists every reason in the console’s words, with where it is', async () => {
    const http = httpWith(() => {
      throw new HttpError(
        'capability_error',
        'admin proposal segment seg-1 is not exported as a pack: suspected_credentials, not_a_valid_pack',
        'admin_proposal_pack_not_exportable',
        {
          problems: [
            {
              code: 'suspected_credentials',
              path: 'items[0].skill.markdown',
              message: 'looks like a credential',
            },
            {
              code: 'not_a_valid_pack',
              path: 'items[0]',
              message: 'Skill "ticket-triage" reads back with another content digest',
            },
          ],
        },
      );
    });
    renderExport(http);
    fireEvent.click(screen.getByTestId('part-2-export-submit'));
    const problems = await screen.findByTestId('part-2-export-problems');
    expect(problems.textContent).toContain('没有导出');
    const credential = screen.getByTestId('part-2-export-problem-suspected_credentials');
    expect(credential.textContent).toContain('像是凭证');
    expect(credential.textContent).toContain('items[0].skill.markdown');
    expect(credential.textContent).not.toContain('looks like a credential');
    expect(screen.getByTestId('part-2-export-problem-not_a_valid_pack').textContent).toContain(
      'reads back with another content digest',
    );
    expect(screen.queryByTestId('part-2-export-result')).toBeNull();
  });

  it('a pack of that name already here: why, and what to do next', async () => {
    const http = httpWith(() => {
      throw new HttpError(
        'capability_error',
        'admin proposal segment seg-1 is not exported as a pack: pack_name_taken',
        'admin_proposal_pack_not_exportable',
        {
          problems: [
            {
              code: 'pack_name_taken',
              path: 'sourceName',
              message: 'pack "ticket-desk" is already in this deployment with other content',
            },
          ],
        },
      );
    });
    renderExport(http);
    fireEvent.click(screen.getByTestId('part-2-export-submit'));
    const taken = await screen.findByTestId('part-2-export-problem-pack_name_taken');
    // The same proposal exported again with another summary is this case too.
    expect(taken.textContent).toContain('上次导出时的简介、说明和这次不同');
    expect(taken.textContent).toContain('config/packs/ 里同名的目录移走');
    expect(taken.textContent).toContain('「重新读取」');
    expect(taken.textContent).toContain('§14.1 加一个新版本');
  });

  it('any other failure shows as an error, the form kept', async () => {
    const http = httpWith(() => {
      throw new HttpError(
        'capability_error',
        'admin proposal segment seg-1 not found on this platform',
        'admin_proposal_segment_not_found',
      );
    });
    renderExport(http);
    fireEvent.click(screen.getByTestId('part-2-export-submit'));
    await waitFor(() => expect(screen.getByTestId('part-2-export-error')).toBeTruthy());
    expect(screen.getByTestId('part-2-export-summary')).toBeTruthy();
  });
});
