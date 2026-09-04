import type { Operation } from '@nexttime/shared';
import { describe, expect, it, vi } from 'vitest';
import { type SshPolicyRule, SshTransport, classifyCommand, sshConnectionArgs } from './ssh.js';

const POLICY_TABLE: SshPolicyRule[] = [
  { pattern: '^show\\b', mode: 'observe', blastRadius: 'low', autoApprovable: true },
  { pattern: '^rm -rf\\b', mode: 'execute', blastRadius: 'high', autoApprovable: false },
];

describe('classifyCommand', () => {
  it('auto-approves a read-only "show" command', () => {
    const classification = classifyCommand('show interfaces', POLICY_TABLE);
    expect(classification).toEqual({
      mode: 'observe',
      blastRadius: 'low',
      autoApprovable: true,
      unclassified: false,
    });
  });

  it('defaults an unknown command to require_approval semantics (I17)', () => {
    const classification = classifyCommand('reboot now', POLICY_TABLE);
    expect(classification).toEqual({
      mode: 'execute',
      blastRadius: 'medium',
      autoApprovable: false,
      unclassified: true,
    });
  });

  it('flags a destructive command as high blast radius', () => {
    const classification = classifyCommand('rm -rf /data', POLICY_TABLE);
    expect(classification.blastRadius).toBe('high');
    expect(classification.autoApprovable).toBe(false);
  });

  it('matches rules in order — first match wins', () => {
    const table: SshPolicyRule[] = [
      { pattern: '.*', mode: 'execute', blastRadius: 'medium', autoApprovable: false },
      { pattern: '^show\\b', mode: 'observe', blastRadius: 'low', autoApprovable: true },
    ];
    expect(classifyCommand('show version', table).mode).toBe('execute');
  });
});

describe('SshTransport', () => {
  const patternOperation: Operation = {
    name: 'run_command',
    binding: { kind: 'ssh', command_pattern: '.*' },
    params_schema: {},
    mode: 'execute',
    blast_radius: 'high',
    reversibility: false,
    auto_approvable: false,
    await_decision: true,
    reads: [],
    writes: [],
  };

  it('builds ssh argv with BatchMode always and host-key options only when configured', () => {
    expect(sshConnectionArgs({ host: 'h', user: 'u' })).toEqual(['-o', 'BatchMode=yes', 'u@h']);
    expect(
      sshConnectionArgs({
        host: 'h',
        user: 'u',
        port: 2222,
        identityFile: '/k/id',
        strictHostKeyChecking: 'no',
        knownHostsFile: '/dev/null',
      }),
    ).toEqual([
      '-i',
      '/k/id',
      '-p',
      '2222',
      '-o',
      'StrictHostKeyChecking=no',
      '-o',
      'UserKnownHostsFile=/dev/null',
      '-o',
      'BatchMode=yes',
      'u@h',
    ]);
  });

  it('surfaces ssh stderr and exit code in the transport error (diagnosable failure reason)', async () => {
    const execImpl = vi.fn(async () => {
      throw Object.assign(new Error('Command failed: ssh'), {
        stderr: 'Host key verification failed.\n',
        code: 255,
      });
    });
    const transport = new SshTransport({
      target: { host: '198.51.100.10', user: 'admin' },
      policyTable: POLICY_TABLE,
      execImpl,
    });
    await expect(
      transport.invoke(patternOperation, { command: 'show interfaces' }, {}),
    ).rejects.toThrow(/Host key verification failed\. \(exit 255\)/);
  });

  it('execFiles ssh with connection args and the literal command as the last argument (no local shell)', async () => {
    const execImpl = vi.fn(async () => ({ stdout: 'ok', stderr: '' }));
    const transport = new SshTransport({
      target: { host: '198.51.100.10', user: 'admin' },
      policyTable: POLICY_TABLE,
      execImpl,
    });

    const result = await transport.invoke(patternOperation, { command: 'show interfaces' }, {});

    expect(execImpl).toHaveBeenCalledWith(
      { host: '198.51.100.10', user: 'admin' },
      'show interfaces',
    );
    expect(result.data).toEqual({ stdout: 'ok', stderr: '' });
    expect((result.detail as { classification: unknown }).classification).toEqual({
      mode: 'observe',
      blastRadius: 'low',
      autoApprovable: true,
      unclassified: false,
    });
  });

  it('rejects a command that does not match its own operation command_pattern', async () => {
    const narrowOperation: Operation = {
      ...patternOperation,
      binding: { kind: 'ssh', command_pattern: '^show\\b' },
    };
    const transport = new SshTransport({
      target: { host: '198.51.100.10', user: 'admin' },
      policyTable: POLICY_TABLE,
      execImpl: vi.fn(),
    });
    await expect(transport.invoke(narrowOperation, { command: 'reboot now' }, {})).rejects.toThrow(
      /does not match operation/,
    );
  });

  it('renders a command_template binding like the cli transport', async () => {
    const templateOperation: Operation = {
      ...patternOperation,
      binding: { kind: 'ssh', command_template: 'show interface {name}' },
    };
    const execImpl = vi.fn(async () => ({ stdout: '', stderr: '' }));
    const transport = new SshTransport({
      target: { host: '198.51.100.10', user: 'admin' },
      policyTable: POLICY_TABLE,
      execImpl,
    });
    await transport.invoke(templateOperation, { name: 'eth0' }, {});
    expect(execImpl).toHaveBeenCalledWith(
      { host: '198.51.100.10', user: 'admin' },
      'show interface eth0',
    );
  });
});
