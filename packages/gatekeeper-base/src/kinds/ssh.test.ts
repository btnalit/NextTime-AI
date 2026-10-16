import type { Operation } from '@nexttime/shared';
import { describe, expect, it, vi } from 'vitest';
import {
  OperationRefusedError,
  TransportInvokeError,
  TransportOutcomeUnknownError,
  TransportTimeoutError,
} from '../errors.js';
import {
  SshCommandRejectedError,
  type SshPolicyRule,
  SshTransport,
  assertClassificationAllowed,
  assertCommandShape,
  classifyCommand,
  shellQuote,
  sshConnectionArgs,
  sshFailureMayHaveRun,
} from './ssh.js';

describe('ssh hardening (review lane 5 P0-1/2/3)', () => {
  it('shellQuote passes inert words through and single-quotes everything else', () => {
    expect(shellQuote('eth0')).toBe('eth0');
    expect(shellQuote('/var/log/app.log')).toBe('/var/log/app.log');
    expect(shellQuote('eth0; reload')).toBe("'eth0; reload'");
    expect(shellQuote("it's")).toBe("'it'\\''s'");
    expect(shellQuote('$(id)')).toBe("'$(id)'");
  });

  it('assertCommandShape refuses option-looking and multi-line commands', () => {
    expect(() => assertCommandShape('-oProxyCommand=id')).toThrow(/must not start with "-"/);
    expect(() => assertCommandShape('  --version')).toThrow(/must not start with "-"/);
    expect(() => assertCommandShape('uptime\nrm -rf /')).toThrow(/single line/);
    expect(() => assertCommandShape('uptime')).not.toThrow();
  });

  it('assertClassificationAllowed refuses execute/unclassified commands on an observe Operation and blast-radius escalation', () => {
    const observeOp = { name: 'host.show', mode: 'observe', blast_radius: 'low' } as never;
    const executeOp = { name: 'host.run', mode: 'execute', blast_radius: 'medium' } as never;
    const unclassified = {
      mode: 'execute',
      blastRadius: 'medium',
      autoApprovable: false,
      unclassified: true,
    } as const;
    const observeLow = {
      mode: 'observe',
      blastRadius: 'low',
      autoApprovable: true,
      unclassified: false,
    } as const;
    const executeHigh = {
      mode: 'execute',
      blastRadius: 'high',
      autoApprovable: false,
      unclassified: false,
    } as const;
    expect(() => assertClassificationAllowed(observeOp, unclassified)).toThrow(/observe-class/);
    expect(() => assertClassificationAllowed(observeOp, observeLow)).not.toThrow();
    expect(() => assertClassificationAllowed(executeOp, unclassified)).not.toThrow();
    expect(() => assertClassificationAllowed(executeOp, executeHigh)).toThrow(/blast radius/);
  });
});

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

  const BOUNDED_SESSION_ARGS = [
    '-o',
    'BatchMode=yes',
    '-o',
    'ConnectTimeout=10',
    '-o',
    'ServerAliveInterval=15',
  ];

  it('builds ssh argv with -n, BatchMode and connection bounds always, and host-key options only when configured', () => {
    expect(sshConnectionArgs({ host: 'h', user: 'u' })).toEqual([
      '-n',
      ...BOUNDED_SESSION_ARGS,
      'u@h',
    ]);
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
      '-n',
      '-i',
      '/k/id',
      '-p',
      '2222',
      '-o',
      'StrictHostKeyChecking=no',
      '-o',
      'UserKnownHostsFile=/dev/null',
      ...BOUNDED_SESSION_ARGS,
      'u@h',
    ]);
  });

  // R-51: a remote command waiting on stdin never returned, leaking the child and pinning the
  // apply key. `-n` (above) gives it EOF; the exec timeout is the backstop for anything else that
  // hangs — the child is killed (its signal aborted) and the call fails as a timeout.
  it('kills a command that never returns at the exec timeout and fails with TransportTimeoutError', async () => {
    let seenSignal: AbortSignal | undefined;
    const execImpl = vi.fn(
      (_target: unknown, _command: string, { signal }: { signal: AbortSignal }) =>
        new Promise<{ stdout: string; stderr: string }>(() => {
          seenSignal = signal; // waits forever, like a command blocked on stdin
        }),
    );
    const transport = new SshTransport({
      target: { host: '198.51.100.10', user: 'admin' },
      policyTable: POLICY_TABLE,
      execImpl,
      execTimeoutMs: 30,
    });
    const failure = transport.invoke(patternOperation, { command: 'read line' }, {});
    await expect(failure).rejects.toBeInstanceOf(TransportTimeoutError);
    await expect(failure).rejects.toThrow(/timed out after 30 ms and was killed/);
    expect(seenSignal?.aborted).toBe(true);
  });

  it('a command rejected before it runs is a refusal (403 path, key released), not a transport failure', async () => {
    const narrowOperation: Operation = {
      ...patternOperation,
      binding: { kind: 'ssh', command_pattern: '^show\\b' },
    };
    const execImpl = vi.fn();
    const transport = new SshTransport({
      target: { host: '198.51.100.10', user: 'admin' },
      policyTable: POLICY_TABLE,
      execImpl,
    });
    await expect(
      transport.invoke(narrowOperation, { command: 'reboot now' }, {}),
    ).rejects.toSatisfy(
      (err) => err instanceof SshCommandRejectedError && err instanceof OperationRefusedError,
    );
    await expect(
      transport.invoke(patternOperation, { command: '-oProxyCommand=id' }, {}),
    ).rejects.toBeInstanceOf(OperationRefusedError);
    expect(execImpl).not.toHaveBeenCalled();
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

  it('never repeats the command line Node puts in a failed command’s message (identity file, target, rendered params)', async () => {
    const execImpl = vi.fn(async () => {
      throw Object.assign(
        new Error(
          "Command failed: ssh -n -i /run/secrets/id_ed25519 -p 22 admin@198.51.100.10 -- mysql -p'hunter2-synthetic'\n",
        ),
        { stderr: '', code: 1, signal: null, cmd: 'ssh … mysql -p…' },
      );
    });
    const transport = new SshTransport({
      target: { host: '198.51.100.10', user: 'admin' },
      policyTable: POLICY_TABLE,
      execImpl,
    });
    const failure: unknown = await transport
      .invoke(patternOperation, { command: 'show interfaces' }, {})
      .then(
        () => undefined,
        (err: unknown) => err,
      );
    expect(failure).toBeInstanceOf(Error);
    const { message } = failure as Error;
    expect(message).toMatch(/the command failed with no output on stderr \(exit 1\)/);
    expect(message).not.toMatch(/hunter2|id_ed25519|198\.51\.100\.10|Command failed/);
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
      { signal: expect.any(AbortSignal) },
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
      { signal: expect.any(AbortSignal) },
    );
  });
});

// Legacy 287: ssh exits 255 both when the session never started (nothing ran) and when it dropped
// mid-command (it may have run). Only ssh's own last word tells them apart.
describe('sshFailureMayHaveRun', () => {
  const exit255 = (stderr: string) =>
    Object.assign(new Error('Command failed: ssh'), { code: 255, stderr });

  it.each([
    ['ssh: Could not resolve hostname router-a: Name or service not known\n'],
    ['ssh: connect to host 198.51.100.10 port 22: Connection refused\n'],
    ['ssh: connect to host 198.51.100.10 port 22: Connection timed out\n'],
    [
      '@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\n@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\nHost key verification failed.\n',
    ],
    [
      "Warning: Permanently added '198.51.100.10' (ED25519) to the list of known hosts.\nadmin@198.51.100.10: Permission denied (publickey).\n",
    ],
    [
      'kex_exchange_identification: read: Connection reset by peer\nConnection reset by 198.51.100.10 port 22\n',
    ],
    [
      'Connection timed out during banner exchange\nConnection to 198.51.100.10 port 22 timed out\n',
    ],
    ['Unable to negotiate with 198.51.100.10 port 22: no matching host key type found.\n'],
    ['Bad owner or permissions on /root/.ssh/config\n'],
  ])('a session that never started ran nothing: %j', (stderr) => {
    expect(sshFailureMayHaveRun(exit255(stderr))).toBe(false);
  });

  it.each([
    ['Connection to 198.51.100.10 closed by remote host.\n'],
    ['client_loop: send disconnect: Broken pipe\n'],
    ['Timeout, server 198.51.100.10 not responding.\n'],
    // The same generic words end a session that dropped mid-command.
    ['Connection closed by 198.51.100.10 port 22\n'],
    ['Connection reset by 198.51.100.10 port 22\n'],
    // The remote command's own output that looks like a never-started session does not count:
    // ssh's last word is the drop.
    [
      'ssh: connect to host inner port 22: Connection refused\nConnection to 198.51.100.10 closed by remote host.\n',
    ],
    // A remote command that exits 255 with no word from ssh.
    [''],
  ])('a session that may have run its command: %j', (stderr) => {
    expect(sshFailureMayHaveRun(exit255(stderr))).toBe(true);
  });

  it("an exit code other than 255 is the command's own answer", () => {
    expect(
      sshFailureMayHaveRun(Object.assign(new Error('x'), { code: 1, stderr: 'no such file' })),
    ).toBe(false);
    expect(sshFailureMayHaveRun(Object.assign(new Error('x'), { code: 'ENOENT' }))).toBe(false);
    expect(sshFailureMayHaveRun(undefined)).toBe(false);
  });

  const operation: Operation = {
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

  function transportFailingWith(err: Error) {
    return new SshTransport({
      target: { host: '198.51.100.10', user: 'admin' },
      policyTable: POLICY_TABLE,
      execImpl: vi.fn(async () => {
        throw err;
      }),
    });
  }

  it('the transport reports a session dropped mid-command as outcome unknown', async () => {
    const failure = transportFailingWith(
      exit255('Connection to 198.51.100.10 closed by remote host.\n'),
    ).invoke(operation, { command: 'ip address set ether1 address=192.0.2.9/24' }, {});
    await expect(failure).rejects.toBeInstanceOf(TransportOutcomeUnknownError);
    await expect(failure).rejects.toThrow(
      /failed after the command may have started: .*closed by remote host\. \(exit 255\) — it may have partially or fully run/,
    );
  });

  it('the transport reports a session that never started, or a command that answered, as a plain failure', async () => {
    for (const err of [
      exit255('ssh: connect to host 198.51.100.10 port 22: Connection refused\n'),
      Object.assign(new Error('Command failed: ssh'), { code: 1, stderr: 'bad command\n' }),
    ]) {
      const failure = transportFailingWith(err).invoke(operation, { command: 'show x' }, {});
      await expect(failure).rejects.toBeInstanceOf(TransportInvokeError);
      await expect(failure).rejects.not.toBeInstanceOf(TransportOutcomeUnknownError);
    }
  });
});
