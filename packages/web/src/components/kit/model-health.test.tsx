// @vitest-environment jsdom
import type { ProviderHealthStatus } from '@nexttime/shared';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type HealthAwareModel,
  ModelHealthNote,
  ModelHealthTag,
  ModelOption,
  modelOptionDisabled,
} from './model-health.js';

afterEach(cleanup);

function model(id: string, status?: ProviderHealthStatus): HealthAwareModel {
  const provider = id.split('/')[0] as string;
  return status === undefined
    ? { id, provider }
    : { id, provider, health: { status, testedAt: null } };
}

function options(models: readonly HealthAwareModel[], value: string) {
  render(
    <select value={value} onChange={() => undefined} data-testid="s">
      {models.map((m) => (
        <ModelOption key={m.id} model={m} selected={m.id === value} />
      ))}
    </select>,
  );
  return [...(screen.getByTestId('s') as HTMLSelectElement).options];
}

describe('kit/model-health', () => {
  it('a working model reads as before; unknown / untested / tools-failing ones carry the status; a blocked one is disabled', () => {
    const [ok, unknown, untested, tools, rejected] = options(
      [
        model('a/ok', 'ok'),
        model('b/unknown'),
        model('c/new', 'untested'),
        model('d/tools', 'tools_failed'),
        model('e/bad', 'key_rejected'),
      ],
      'a/ok',
    );
    expect(ok?.textContent).toBe('a/ok');
    expect(ok?.disabled).toBe(false);
    // Review M1: no health is 状态未知 — offered, never shown as working.
    expect(unknown?.textContent).toBe('b/unknown · 状态未知');
    expect(unknown?.disabled).toBe(false);
    expect(unknown?.getAttribute('data-health')).toBe('unknown');
    expect(untested?.textContent).toBe('c/new · 未测试');
    expect(untested?.disabled).toBe(false);
    expect(tools?.textContent).toBe('d/tools · 工具调用失败');
    expect(tools?.disabled).toBe(false);
    expect(rejected?.textContent).toBe('e/bad · 密钥被拒');
    expect(rejected?.disabled).toBe(true);
    expect(rejected?.getAttribute('data-health')).toBe('key_rejected');
  });

  it('keeps a blocked model enabled when it is the current value, so the select still shows it', () => {
    expect(modelOptionDisabled(model('e/bad', 'test_failed'), true)).toBe(false);
    expect(modelOptionDisabled(model('e/bad', 'test_failed'), false)).toBe(true);
    const [, chosen] = options([model('a/ok', 'ok'), model('e/bad', 'key_missing')], 'e/bad');
    expect(chosen?.disabled).toBe(false);
    expect(chosen?.selected).toBe(true);
  });

  it('the note names the chosen model’s provider problem and links to the fix on a platform page', () => {
    render(
      <ModelHealthNote
        models={[model('deepseek/chat', 'key_rejected'), model('a/ok', 'ok')]}
        selectedId="deepseek/chat"
        canFix
        testId="n"
      />,
    );
    expect(screen.getByTestId('n').textContent).toContain('「deepseek」：密钥被拒');
    // The link opens that provider's drawer (连通性测试 + 密钥) on 模型与供应商.
    expect(screen.getByTestId('n-fix').getAttribute('href')).toBe(
      '#/platform/models?provider=deepseek',
    );
    expect(screen.getByTestId('n-fix').textContent).toBe('去模型与供应商修复');
  });

  // #530 必修 2: an untested choice gets a next step too — test it, or ask who can.
  it('an untested or unknown choice gets a next step: 去测试供应商 on a platform page, who to ask elsewhere', () => {
    const { unmount } = render(
      <ModelHealthNote
        models={[model('fake/echo', 'untested')]}
        selectedId="fake/echo"
        canFix
        testId="n"
      />,
    );
    expect(screen.getByTestId('n-fix').textContent).toBe('去测试供应商');
    expect(screen.getByTestId('n-fix').getAttribute('href')).toBe(
      '#/platform/models?provider=fake',
    );
    unmount();
    const member = render(
      <ModelHealthNote
        models={[model('fake/echo', 'untested')]}
        selectedId="fake/echo"
        canFix={false}
        testId="n"
      />,
    );
    expect(screen.getByTestId('n').textContent).toContain('请平台管理员测试这个供应商');
    member.unmount();
    render(
      <ModelHealthNote models={[model('fake/echo')]} selectedId="fake/echo" canFix testId="n" />,
    );
    expect(screen.getByTestId('n').textContent).toContain('状态未知');
    expect(screen.getByTestId('n-fix').textContent).toBe('去模型与供应商检查');
  });

  it('on a member page the note says who fixes it, with no link', () => {
    render(
      <ModelHealthNote
        models={[model('deepseek/chat', 'test_failed')]}
        selectedId="deepseek/chat"
        canFix={false}
        testId="n"
      />,
    );
    expect(screen.getByTestId('n').textContent).toContain('请平台管理员');
    expect(screen.queryByTestId('n-fix')).toBeNull();
  });

  it('with a working choice, the note counts the models the picker could not offer; with none blocked it renders nothing', () => {
    const { unmount } = render(
      <ModelHealthNote
        models={[
          model('a/ok', 'ok'),
          model('deepseek/chat', 'key_rejected'),
          model('deepseek/coder', 'key_rejected'),
        ]}
        selectedId="a/ok"
        canFix
        testId="n"
      />,
    );
    expect(screen.getByTestId('n').textContent).toContain('2 个模型不能选');
    expect(screen.getByTestId('n').textContent).toContain('deepseek');
    unmount();
    const unknown = render(
      <ModelHealthNote
        models={[model('a/ok', 'ok'), model('b/unknown'), model('b/other')]}
        selectedId={null}
        canFix={false}
        testId="n"
      />,
    );
    // Review M1: models without a status are counted, with who can check.
    expect(screen.getByTestId('n').textContent).toContain('2 个模型状态未知');
    expect(screen.getByTestId('n').textContent).toContain('请平台管理员检查供应商状态');
    unknown.unmount();
    render(
      <ModelHealthNote
        models={[model('a/ok', 'ok'), model('c/new', 'untested')]}
        selectedId="a/ok"
        canFix
        testId="n"
      />,
    );
    expect(screen.queryByTestId('n')).toBeNull();
  });

  it('the checklist tag shows only a status that is not ok (状态未知 included), toned by usability', () => {
    const { container, rerender } = render(<ModelHealthTag model={model('a/ok', 'ok')} />);
    expect(container.textContent).toBe('');
    rerender(<ModelHealthTag model={model('a/x')} />);
    expect(container.textContent).toBe('状态未知');
    rerender(<ModelHealthTag model={undefined} />);
    expect(container.textContent).toBe('');
    rerender(<ModelHealthTag model={model('a/x', 'key_rejected')} testId="tag" />);
    expect(screen.getByTestId('tag').className).toContain('chip-danger');
    rerender(<ModelHealthTag model={model('a/x', 'untested')} testId="tag" />);
    expect(screen.getByTestId('tag').className).toContain('chip-warn');
    expect(screen.getByTestId('tag').textContent).toBe('未测试');
  });
});
