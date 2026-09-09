import { describe, expect, it } from 'vitest';
import { collectSystemdServices, parseSystemctlOutput } from './systemd.js';

describe('parseSystemctlOutput (pure)', () => {
  it('parses a typical --no-legend --plain line into its four fixed columns plus description', () => {
    const stdout = 'docker.service    loaded active running Docker Application Container Engine\n';
    expect(parseSystemctlOutput(stdout)).toEqual([
      {
        unitName: 'docker.service',
        loadState: 'loaded',
        activeState: 'active',
        subState: 'running',
        description: 'Docker Application Container Engine',
      },
    ]);
  });

  it('parses multiple lines', () => {
    const stdout = [
      'docker.service    loaded active running Docker Engine',
      'ssh.service       loaded active running OpenBSD Secure Shell server',
    ].join('\n');
    expect(parseSystemctlOutput(stdout)).toHaveLength(2);
  });

  it('skips blank lines', () => {
    const stdout = '\n\ndocker.service loaded active running Docker Engine\n\n';
    expect(parseSystemctlOutput(stdout)).toHaveLength(1);
  });

  it('skips a line with fewer than four fields', () => {
    const stdout = 'garbage\ndocker.service loaded active running Docker Engine';
    expect(parseSystemctlOutput(stdout)).toHaveLength(1);
  });

  it('handles a unit with no description text', () => {
    const stdout = 'foo.service loaded inactive dead';
    expect(parseSystemctlOutput(stdout)).toEqual([
      {
        unitName: 'foo.service',
        loadState: 'loaded',
        activeState: 'inactive',
        subState: 'dead',
        description: '',
      },
    ]);
  });
});

describe('collectSystemdServices', () => {
  it('skips cleanly when /run/systemd is not visible (the optional-mount case)', async () => {
    const result = await collectSystemdServices({ runSystemdPath: '/definitely/does/not/exist' });
    expect(result.skipped).toBe(true);
    expect(result.services).toEqual([]);
    expect(result.reason).toMatch(/not mounted/);
  });

  it('runs systemctl and returns parsed services when /run/systemd is visible', async () => {
    // Use this test file's own directory as a stand-in for "/run/systemd is visible" — collect
    // SystemdServices only checks the path *exists*, not what it contains.
    const result = await collectSystemdServices({
      runSystemdPath: import.meta.dirname ?? process.cwd(),
      runner: async () => ({
        stdout: 'docker.service loaded active running Docker Engine\n',
      }),
    });
    expect(result.skipped).toBe(false);
    expect(result.services).toHaveLength(1);
    expect(result.services[0]?.unitName).toBe('docker.service');
  });

  it('skips cleanly (does not throw) when systemctl itself fails', async () => {
    const result = await collectSystemdServices({
      runSystemdPath: import.meta.dirname ?? process.cwd(),
      runner: async () => {
        throw new Error('systemctl: command not found');
      },
    });
    expect(result.skipped).toBe(true);
    expect(result.reason).toMatch(/systemctl failed/);
  });
});
