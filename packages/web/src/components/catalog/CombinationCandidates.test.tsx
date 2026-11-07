// @vitest-environment jsdom
import type {
  CombinationCandidateWire,
  CombinationCandidatesWire,
  WorkerDefinitionDerivationWire,
} from '@nexttime/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PermissionsProvider } from '../../hooks/usePermissions.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { HttpError } from '../../lib/http-client.js';
import { useT } from '../../lib/i18n.js';
import { CombinationCandidatesSection, DerivedFromNote } from './CombinationCandidates.js';

afterEach(() => {
  cleanup();
});

const BASE = '11111111-2222-4333-8444-555555555555';
const DERIVED = '66666666-7777-4888-8999-000000000000';
const DIGEST = 'c'.repeat(64);

function workspaceAs(role: string) {
  return {
    id: 'ws-1',
    name: 'Acme',
    createdAt: '2026-01-01T00:00:00Z',
    principalCount: 1,
    gatekeeperCount: 0,
    caller: { id: 'p-1', role, displayName: 'Reader', kind: 'human' },
  };
}

const evidence = { achieved: 4, notAchieved: 1, goals: 3, rate: 0.8, windowDays: 90 };

function candidate(patch: Partial<CombinationCandidateWire> = {}): CombinationCandidateWire {
  return {
    definitionId: BASE,
    version: 2,
    specRef: DIGEST.slice(0, 12),
    specDigest: DIGEST,
    fields: ['instructions', 'capabilities', 'tokenBudget'],
    evidence,
    spec: { instructions: 'Check the logs first.', capabilities: ['get_object'], tokenBudget: 500 },
    definition: {
      systemPrompt: 'You fix services.\n\nCheck the logs first.',
      capabilities: ['get_object'],
    },
    derivedAs: [],
    ...patch,
  };
}

function candidates(list: readonly CombinationCandidateWire[]): CombinationCandidatesWire {
  return {
    definitionId: BASE,
    thresholds: { windowDays: 90, minAchieved: 3, minGoals: 2, minRate: 0.8 },
    candidates: [...list],
  };
}

function scriptedHttp(
  role: string,
  answers: { readonly list: () => unknown; readonly propose?: (params: unknown) => unknown },
): CapabilityCaller & { readonly calls: { name: string; params: unknown }[] } {
  const calls: { name: string; params: unknown }[] = [];
  return {
    calls,
    call: vi.fn(async (name: string, params?: unknown) => {
      calls.push({ name, params });
      if (name === 'get_workspace') return workspaceAs(role);
      if (name === 'get_combination_candidates') return answers.list();
      if (name === 'propose_definition_from_combination' && answers.propose) {
        return answers.propose(params);
      }
      throw new Error(`unscripted capability ${name}`);
    }) as CapabilityCaller['call'],
  };
}

function show(
  http: CapabilityCaller,
  onProposed: (draft: unknown) => void = () => undefined,
  familyOf: (id: string) => { name: string; href: string } | null = () => null,
) {
  return render(
    <PermissionsProvider>
      <CombinationCandidatesSection
        http={http}
        definitionId={BASE}
        baseName="Fixer"
        familyOf={familyOf}
        onProposed={onProposed}
      />
    </PermissionsProvider>,
  );
}

const cardId = `combination-candidate-2-${DIGEST.slice(0, 12)}`;

describe('CombinationCandidatesSection (S11 GO16b)', () => {
  it('a candidate: its version, the fields it sets and its number, its evidence, the step-only fields that do not carry over', async () => {
    const http = scriptedHttp('builder', { list: () => candidates([candidate()]) });
    show(http);
    const card = await screen.findByTestId(cardId);
    expect(within(card).getByTestId(`${cardId}-label`).textContent).toBe(
      `v2 · 调整了职责说明、能力范围、每次尝试的 Token 上限 · 编号 ${DIGEST.slice(0, 12)}`,
    );
    expect(within(card).getByTestId(`${cardId}-evidence`).textContent).toBe(
      '近 90 天达成 4 次，来自 3 个目标，达成率 80%（4 / 5）',
    );
    expect(within(card).getByTestId(`${cardId}-step-only`).textContent).toContain(
      '每次尝试的 Token 上限只对目标步骤生效',
    );
    // The rule it was judged by, the executor's word excluded.
    expect(screen.getByTestId('combination-candidates-rule').textContent).toContain(
      '执行者自报的不算',
    );
    expect(http.calls.find((call) => call.name === 'get_combination_candidates')?.params).toEqual({
      definitionId: BASE,
    });
  });

  it('keeping one: the confirm warns the content becomes visible to the whole workspace once published, previews the definition, and proposes it with the name given', async () => {
    const onProposed = vi.fn();
    const draft = { id: DERIVED, version: 1, kind: 'worker', status: 'draft', definition: {} };
    const http = scriptedHttp('builder', {
      list: () => candidates([candidate()]),
      propose: () => draft,
    });
    show(http, onProposed);
    fireEvent.click(await screen.findByTestId(`${cardId}-keep`));

    const warning = await screen.findByTestId(`${cardId}-warning`);
    expect(warning.textContent).toContain(
      '这段内容会写进一份新的定义草稿；发布后，工作区里所有人都能看到它。',
    );
    const confirm = screen.getByTestId(`${cardId}-confirm`);
    expect(confirm.textContent).toContain('草稿只有你看得到');
    // Field by field, wrapped (UX acceptance of #1071): the base prompt, then what the step's
    // adjustments add, set apart and marked; the capabilities they replace, marked too.
    const preview = within(confirm).getByTestId(`${cardId}-preview`);
    expect(preview.querySelector('pre')).toBeNull();
    const added = within(preview).getByTestId(`${cardId}-preview-added`);
    expect(added.textContent).toBe('来自步骤调整Check the logs first.');
    expect(within(added).getByText('Check the logs first.').className).toContain('pre-wrap');
    expect(within(preview).getByText('You fix services.').className).toContain('pre-wrap');
    const fields = within(preview).getByTestId(`${cardId}-preview-fields`);
    expect(fields.textContent).toBe('能力范围get_object来自步骤调整');
    const name = within(confirm).getByTestId(`${cardId}-name`) as HTMLInputElement;
    expect(name.value).toBe('Fixer（调整版）');

    // No name, no proposal.
    fireEvent.change(name, { target: { value: '   ' } });
    expect(within(confirm).getByRole('button', { name: '写成草稿' })).toHaveProperty(
      'disabled',
      true,
    );
    fireEvent.change(name, { target: { value: '  Fixer · logs first  ' } });
    fireEvent.click(within(confirm).getByRole('button', { name: '写成草稿' }));

    await waitFor(() => expect(onProposed).toHaveBeenCalledWith(draft));
    expect(
      http.calls.find((call) => call.name === 'propose_definition_from_combination')?.params,
    ).toEqual({ definitionId: BASE, version: 2, specDigest: DIGEST, name: 'Fixer · logs first' });
  });

  it('one that no longer qualifies: says nothing was written and reads the list again', async () => {
    const http = scriptedHttp('builder', {
      list: () => candidates([candidate()]),
      propose: () => {
        throw new HttpError('capability_error', 'no longer', 'combination_not_eligible', {
          shortfalls: ['rate_too_low'],
          evidence,
        });
      },
    });
    show(http);
    fireEvent.click(await screen.findByTestId(`${cardId}-keep`));
    const confirm = await screen.findByTestId(`${cardId}-confirm`);
    fireEvent.click(within(confirm).getByRole('button', { name: '写成草稿' }));
    expect(await within(confirm).findByText(/它现在已经不满足沉淀的条件/)).toBeTruthy();
    await waitFor(() =>
      expect(http.calls.filter((call) => call.name === 'get_combination_candidates')).toHaveLength(
        2,
      ),
    );
  });

  it('a label that starts with a Latin field name spaces it from the Chinese (UX acceptance of #1069)', async () => {
    show(
      scriptedHttp('builder', {
        list: () =>
          candidates([
            candidate({ fields: ['skills'], spec: { skills: ['triage'] }, definition: null }),
          ]),
      }),
    );
    expect((await screen.findByTestId(`${cardId}-label`)).textContent).toBe(
      `v2 · 调整了 Skill · 编号 ${DIGEST.slice(0, 12)}`,
    );
  });

  it('a reader of none of its goals: numbers and field names only, no button, and whom to ask', async () => {
    const http = scriptedHttp('builder', {
      list: () =>
        candidates([candidate({ specRef: '#1', specDigest: null, spec: null, definition: null })]),
    });
    show(http);
    const id = 'combination-candidate-2-#1';
    const card = await screen.findByTestId(id);
    expect(within(card).getByTestId(`${id}-label`).textContent).toContain('编号 #1');
    expect(within(card).getByTestId(`${id}-unreadable`).textContent).toContain(
      '请工作区 owner 或这些目标的请求人来沉淀',
    );
    expect(within(card).queryByTestId(`${id}-keep`)).toBeNull();
  });

  it('the families already kept from it, linked where the page knows them', async () => {
    const http = scriptedHttp('builder', {
      list: () => candidates([candidate({ derivedAs: [DERIVED] })]),
    });
    show(http, undefined, (id) =>
      id === DERIVED ? { name: 'Fixer · logs', href: '#/build/catalog/workers/x' } : null,
    );
    const derived = await screen.findByTestId(`${cardId}-derived`);
    expect(derived.textContent).toContain('已经沉淀为');
    expect(derived.textContent).toContain('Fixer · logs');
    // Kept once already: the button says it makes another one (UX acceptance of #1071).
    expect(screen.getByTestId(`${cardId}-keep`).textContent).toBe('再沉淀一份…');
  });

  it('none meets the thresholds yet: says so under the rule', async () => {
    show(scriptedHttp('builder', { list: () => candidates([]) }));
    expect((await screen.findByTestId('combination-candidates-empty')).textContent).toBe(
      '现在还没有达到门槛的组合。',
    );
  });

  it('nothing for a family it does not list, a member, or a 403', async () => {
    const none = scriptedHttp('builder', { list: () => null });
    show(none);
    await waitFor(() =>
      expect(none.calls.some((call) => call.name === 'get_combination_candidates')).toBe(true),
    );
    expect(screen.queryByTestId('combination-candidates')).toBeNull();
    cleanup();

    const member = scriptedHttp('member', { list: () => candidates([candidate()]) });
    show(member);
    await waitFor(() =>
      expect(member.calls.some((call) => call.name === 'get_workspace')).toBe(true),
    );
    expect(screen.queryByTestId('combination-candidates')).toBeNull();
    expect(member.calls.some((call) => call.name === 'get_combination_candidates')).toBe(false);
    cleanup();

    const forbidden = scriptedHttp('builder', {
      list: () => {
        throw new HttpError('capability_error', 'no', 'forbidden');
      },
    });
    show(forbidden);
    await waitFor(() =>
      expect(forbidden.calls.some((call) => call.name === 'get_combination_candidates')).toBe(true),
    );
    expect(screen.queryByTestId('combination-candidates')).toBeNull();
  });
});

describe('DerivedFromNote (S11 GO16b)', () => {
  const derivedFrom: WorkerDefinitionDerivationWire = {
    definitionId: BASE,
    version: 2,
    evidence,
    derivedAt: new Date().toISOString(),
  };

  function Note({ base }: { readonly base: { name: string; href: string } | null }) {
    const t = useT();
    return <DerivedFromNote derivedFrom={derivedFrom} base={base} t={t} />;
  }

  it('names the version it was kept from and the evidence then — never the adjustments’ digest', () => {
    render(<Note base={{ name: 'Fixer', href: '#/build/catalog/workers/b' }} />);
    const note = screen.getByTestId('worker-detail-derived-from');
    expect(note.textContent).toContain('Fixer v2');
    expect(note.textContent).toContain('加一份步骤调整沉淀而来');
    expect(note.textContent).toContain(
      '当时：近 90 天达成 4 次，来自 3 个目标，达成率 80%（4 / 5）',
    );
    expect(note.textContent).not.toContain('编号');
  });
});
