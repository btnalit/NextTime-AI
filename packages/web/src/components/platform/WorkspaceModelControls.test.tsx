// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LangProvider } from '../../lib/i18n.js';
import { EntryModelSelect } from './WorkspaceModelControls.js';

afterEach(() => {
  cleanup();
  localStorage.removeItem('nexttime.lang');
});

function renderSelect() {
  return render(
    <LangProvider>
      <EntryModelSelect id="entry" options={[]} models={[]} value={null} onChange={vi.fn()} />
    </LangProvider>,
  );
}

// Legacy 598 / 622: the hint under 入口模型 was one fixed string holding both languages.
describe('EntryModelSelect hint', () => {
  it('reads Chinese only in the Chinese console', () => {
    renderSelect();
    const hint = document.getElementById('entry-hint');
    expect(hint?.textContent).toBe('成员在「我的智能体」里没有自己选模型时用它。');
  });

  it('reads English only in the English console', () => {
    localStorage.setItem('nexttime.lang', 'en');
    renderSelect();
    const hint = document.getElementById('entry-hint');
    expect(hint?.textContent).toBe('Used until a member picks their own model in My Agent.');
    expect(screen.getByLabelText('Entry model')).toBeTruthy();
  });
});
