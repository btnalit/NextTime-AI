// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { LangProvider } from '../../lib/i18n.js';
import { GovernanceChangeList } from './GovernanceChange.js';
import { governanceFields } from './governance-fixtures.test-helpers.js';

afterEach(cleanup);

/** Legacy 668 (UX acceptance of #1043): a classification field the draft does not change is
 *  shown once and said to be unchanged, not drawn as 「执行 → 执行」. */
describe('GovernanceChangeList: classification rows', () => {
  it('a changed field reads old → new; an unchanged one reads its value and 不变', () => {
    render(
      <LangProvider>
        <GovernanceChangeList
          single
          items={[
            {
              name: 'container.restart',
              before: governanceFields({
                mode: 'execute',
                blastRadius: 'medium',
                autoApprovable: false,
              }),
              after: governanceFields({
                mode: 'execute',
                blastRadius: 'high',
                autoApprovable: false,
              }),
              direction: 'tightened',
            },
          ]}
        />
      </LangProvider>,
    );
    const list = screen.getByTestId('governance-diff-list');
    const rows = [...list.querySelectorAll('li > div.row-wrap')];
    expect(rows).toHaveLength(3);
    const [mode, blast, auto] = rows as [HTMLElement, HTMLElement, HTMLElement];
    expect(mode.getAttribute('data-unchanged')).toBe('true');
    expect(mode.textContent).toContain('不变');
    expect(mode.textContent).not.toContain('→');
    expect(blast.getAttribute('data-unchanged')).toBeNull();
    expect(blast.textContent).toContain('→');
    expect(blast.textContent).not.toContain('不变');
    expect(auto.getAttribute('data-unchanged')).toBe('true');
  });
});
