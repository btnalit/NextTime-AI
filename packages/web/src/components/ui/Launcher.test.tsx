// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LAUNCHER_STEPS, Launcher } from './Launcher.js';

afterEach(cleanup);

describe('Launcher', () => {
  it('shows four steps with the current one marked, the kind selector on step 0, and gates Next on a kind', () => {
    const onKindChange = vi.fn();
    const onNext = vi.fn();
    const { rerender } = render(
      <Launcher
        step={0}
        kind={null}
        onKindChange={onKindChange}
        onNext={onNext}
        onBack={vi.fn()}
        testId="launcher"
      >
        <p>step content</p>
      </Launcher>,
    );
    expect(LAUNCHER_STEPS.map((s) => s.zh)).toEqual([
      '选类型',
      '连接与凭证',
      '能力与策略',
      '握手验证',
    ]);
    expect(screen.getByTestId('launcher-step-kind').getAttribute('aria-current')).toBe('step');
    expect(screen.getByTestId('launcher-step-connection').getAttribute('aria-current')).toBeNull();
    expect(screen.getByText('step content')).toBeTruthy();
    for (const kind of ['http', 'mcp', 'ssh', 'cli']) {
      expect(screen.getByTestId(`launcher-kind-${kind}`)).toBeTruthy();
    }
    expect(screen.getByTestId('launcher-back').hasAttribute('disabled')).toBe(true);
    expect(screen.getByTestId('launcher-next').hasAttribute('disabled')).toBe(true);

    fireEvent.click(screen.getByTestId('launcher-kind-mcp'));
    expect(onKindChange).toHaveBeenCalledWith('mcp');

    rerender(
      <Launcher
        step={0}
        kind="mcp"
        onKindChange={onKindChange}
        onNext={onNext}
        onBack={vi.fn()}
        testId="launcher"
      />,
    );
    const next = screen.getByTestId('launcher-next');
    expect(next.hasAttribute('disabled')).toBe(false);
    expect(next.textContent).toBe('下一步 Next');
    fireEvent.click(next);
    expect(onNext).toHaveBeenCalledTimes(1);
  });

  it('hides the kind selector after step 0, honours canNext, and labels the last step Finish', () => {
    const onBack = vi.fn();
    const { rerender } = render(
      <Launcher
        step={1}
        kind="http"
        onKindChange={vi.fn()}
        onNext={vi.fn()}
        onBack={onBack}
        canNext={false}
      />,
    );
    expect(screen.queryByTestId('launcher-kind-group')).toBeNull();
    expect(screen.getByTestId('launcher-next').hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByTestId('launcher-back'));
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('launcher-step-kind').className).toContain('launcher-step-done');

    rerender(
      <Launcher
        step={3}
        kind="http"
        onKindChange={vi.fn()}
        onNext={vi.fn()}
        onBack={onBack}
        finishLabel="接入 Connect"
      />,
    );
    expect(screen.getByTestId('launcher-next').textContent).toBe('接入 Connect');
    expect(screen.getByTestId('launcher-step-handshake').getAttribute('aria-current')).toBe('step');
  });

  it('restricts the selectable kinds when given', () => {
    render(
      <Launcher
        step={0}
        kind={null}
        onKindChange={vi.fn()}
        onNext={vi.fn()}
        onBack={vi.fn()}
        kinds={['http', 'mcp']}
      />,
    );
    expect(screen.queryByTestId('launcher-kind-ssh')).toBeNull();
    expect(screen.getByTestId('launcher-kind-http')).toBeTruthy();
  });
});
