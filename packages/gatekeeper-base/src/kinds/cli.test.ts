import type { Operation } from '@nexttime/shared';
import { describe, expect, it, vi } from 'vitest';
import { CliTransport, renderCommandTemplate } from './cli.js';

describe('renderCommandTemplate', () => {
  it('tokenizes on whitespace and substitutes {name} placeholders as single argv elements', () => {
    const argv = renderCommandTemplate('kubectl get pods -n {namespace}', { namespace: 'default' });
    expect(argv).toEqual(['kubectl', 'get', 'pods', '-n', 'default']);
  });

  it('never lets a param value be split into multiple argv elements, even with shell metacharacters', () => {
    const argv = renderCommandTemplate('echo {msg}', { msg: 'a; rm -rf / && b' });
    expect(argv).toEqual(['echo', 'a; rm -rf / && b']);
    expect(argv).toHaveLength(2);
  });

  it('throws when a referenced param is missing', () => {
    expect(() => renderCommandTemplate('echo {msg}', {})).toThrow(/missing param "msg"/);
  });

  it('refuses a positional value that starts with "-" (flag injection, review lane 5 P1-2)', () => {
    expect(() =>
      renderCommandTemplate('fake-cli restart {container}', { container: '--privileged' }),
    ).toThrow(/flag injection/);
    expect(() =>
      renderCommandTemplate('fake-cli restart {container}', { container: '-f' }),
    ).toThrow(/flag injection/);
  });

  it('allows a "-"-prefixed rendered value when the template token itself is a flag', () => {
    const argv = renderCommandTemplate('fake-cli run --name={container}', {
      container: '--privileged',
    });
    expect(argv).toEqual(['fake-cli', 'run', '--name=--privileged']);
  });

  it('allows a plain positional value that does not start with "-"', () => {
    const argv = renderCommandTemplate('fake-cli restart {container}', { container: 'c1' });
    expect(argv).toEqual(['fake-cli', 'restart', 'c1']);
  });
});

describe('CliTransport', () => {
  const operation: Operation = {
    name: 'container.restart',
    binding: { kind: 'cli', command_template: 'fake-cli restart {container}' },
    params_schema: {},
    mode: 'execute',
    blast_radius: 'medium',
    reversibility: false,
    auto_approvable: false,
    await_decision: false,
    reads: [],
    writes: [],
  };

  it('invokes execFile with the rendered argv, never a shell string', async () => {
    const execFileImpl = vi.fn(async (file: string, args: readonly string[]) => {
      expect(file).toBe('fake-cli');
      expect(args).toEqual(['restart', 'c1']);
      return { stdout: 'restarted', stderr: '' };
    });
    const transport = new CliTransport({ execFileImpl });
    const result = await transport.invoke(operation, { container: 'c1' }, {});
    expect(result.data).toEqual({ stdout: 'restarted', stderr: '' });
    expect(execFileImpl).toHaveBeenCalledTimes(1);
  });

  it('simulate describes the argv without executing', async () => {
    const execFileImpl = vi.fn();
    const transport = new CliTransport({ execFileImpl });
    const result = await transport.simulate?.(operation, { container: 'c1' }, {});
    expect(result?.description).toContain('fake-cli restart c1');
    expect(execFileImpl).not.toHaveBeenCalled();
  });
});
