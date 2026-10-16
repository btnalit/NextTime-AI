import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Operation } from '@nexttime/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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
  sshFailureOutcomeUnknown,
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
    // Legacy 287: the ssh client's own log goes to its own file, before the destination.
    expect(
      sshConnectionArgs({ host: 'h', user: 'u' }, { clientLogFile: '/tmp/x/client.log' }),
    ).toEqual(['-n', ...BOUNDED_SESSION_ARGS, '-E', '/tmp/x/client.log', 'u@h']);
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

  it("surfaces ssh's own message and exit code in the transport error (diagnosable failure reason)", async () => {
    const execImpl = vi.fn(async () => {
      throw Object.assign(new Error('Command failed: ssh'), {
        stderr: '',
        sshClientLog: 'Host key verification failed.\n',
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
    ).rejects.toThrow(/ssh client: untrusted: Host key verification failed\. \(exit 255\)/);
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
// mid-command (it may have run). Only ssh's own last word, in its own log (`-E`), tells them apart.
describe('sshFailureOutcomeUnknown', () => {
  const exit255 = (sshClientLog: string | undefined, stderr = '') =>
    Object.assign(new Error('Command failed: ssh'), {
      code: 255,
      stderr,
      ...(sshClientLog !== undefined ? { sshClientLog } : {}),
    });

  it.each([
    ['ssh: Could not resolve hostname router-a: Name or service not known\n'],
    ['ssh: connect to host 198.51.100.10 port 22: Connection refused\n'],
    ['ssh: connect to host 198.51.100.10 port 22: Connection timed out\n'],
    [
      'Host key for [198.51.100.10]:22 has changed and you have requested strict checking.\nHost key verification failed.\n',
    ],
    [
      "Warning: Permanently added '198.51.100.10' (ED25519) to the list of known hosts.\nadmin@198.51.100.10: Permission denied (publickey).\n",
    ],
    ['root@127.0.0.1: Permission denied (publickey,keyboard-interactive).\n'],
    [
      'kex_exchange_identification: read: Connection reset by peer\nConnection reset by 198.51.100.10 port 22\n',
    ],
    [
      'Connection timed out during banner exchange\nConnection to 198.51.100.10 port 22 timed out\n',
    ],
    ['Unable to negotiate with 198.51.100.10 port 22: no matching host key type found.\n'],
    ['Bad owner or permissions on /root/.ssh/config\n'],
  ])('a session that never started ran nothing — client log %j', (log) => {
    expect(sshFailureOutcomeUnknown(exit255(log))).toBe(false);
  });

  it.each([
    // A session that dropped mid-command: ssh says so on stderr, not in its log.
    ['', 'Connection to 198.51.100.10 closed by remote host.\n'],
    ['client_loop: send disconnect: Broken pipe\n', ''],
    ['Timeout, server 198.51.100.10 not responding.\n', ''],
    // The same generic words end a session that dropped mid-command.
    ['Connection closed by 198.51.100.10 port 22\n', ''],
    ['Connection reset by 198.51.100.10 port 22\n', ''],
    // The remote command's own output that looks like ssh's never-started words: it is on stderr,
    // never in ssh's log (review of #586: a Rust program's `io::Error`, a nested ssh).
    ['', 'Error: Permission denied (os error 13)\nConnection reset by 198.51.100.10 port 22\n'],
    ['', 'root@x: Permission denied (publickey).\n'],
    ['', 'ssh: connect to host inner port 22: Connection refused\n'],
    // A remote command that exits 255 with no word from ssh.
    ['', ''],
  ])('a session that may have run its command — client log %j, stderr %j', (log, stderr) => {
    expect(sshFailureOutcomeUnknown(exit255(log, stderr))).toBe(true);
  });

  it('a lookalike line only counts whole: a near miss in the log reads as may-have-run', () => {
    expect(sshFailureOutcomeUnknown(exit255('Error: Permission denied (os error 13)\n'))).toBe(
      true,
    );
  });

  it('without a client log, ssh cannot be told from the remote command: outcome unknown', () => {
    expect(
      sshFailureOutcomeUnknown(
        exit255(undefined, 'ssh: connect to host 198.51.100.10 port 22: Connection refused\n'),
      ),
    ).toBe(true);
  });

  it("an exit code other than 255 is the command's own answer; a missing ssh binary ran nothing", () => {
    expect(
      sshFailureOutcomeUnknown(Object.assign(new Error('x'), { code: 1, stderr: 'no such file' })),
    ).toBe(false);
    expect(
      sshFailureOutcomeUnknown(
        Object.assign(new Error('spawn ssh ENOENT'), { code: 'ENOENT', syscall: 'spawn ssh' }),
      ),
    ).toBe(false);
  });

  it.each([
    [
      'output past the limit (#501 P2-2)',
      Object.assign(new Error('maxBuffer'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }),
    ],
    ['killed by a signal', Object.assign(new Error('killed'), { code: null, signal: 'SIGKILL' })],
    ['an error nobody recognises', new Error('something else')],
  ])('a command stopped before it answered is outcome unknown: %s', (_label, err) => {
    expect(sshFailureOutcomeUnknown(err)).toBe(true);
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
      exit255('', 'Connection to 198.51.100.10 closed by remote host.\n'),
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
      Object.assign(new Error('spawn ssh ENOENT'), { code: 'ENOENT', syscall: 'spawn ssh' }),
    ]) {
      const failure = transportFailingWith(err).invoke(operation, { command: 'show x' }, {});
      await expect(failure).rejects.toBeInstanceOf(TransportInvokeError);
      await expect(failure).rejects.not.toBeInstanceOf(TransportOutcomeUnknownError);
    }
  });

  it('the transport reports output past the limit as outcome unknown, naming why (#501 P2-2)', async () => {
    const failure = transportFailingWith(
      Object.assign(new Error('stdout maxBuffer length exceeded'), {
        code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
        stderr: '',
      }),
    ).invoke(operation, { command: 'cat /var/log/huge.log' }, {});
    await expect(failure).rejects.toBeInstanceOf(TransportOutcomeUnknownError);
    await expect(failure).rejects.toThrow(
      /was stopped before it answered \(its output passed the limit and the gate stopped it\)/,
    );
  });
});

// Legacy 287: the default exec gives ssh a private log file (`-E`) and reads it back on failure.
// A stand-in `ssh` on PATH plays the client: it writes its own words to the `-E` file and the
// "remote" words to stderr, so the plumbing is exercised without an ssh server.
describe('SshTransport default exec: the ssh client log (legacy 287)', () => {
  let fakeBinDir: string;
  let originalPath: string | undefined;
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

  beforeAll(() => {
    fakeBinDir = mkdtempSync(join(tmpdir(), 'nt-fake-ssh-'));
    const script = join(fakeBinDir, 'ssh');
    writeFileSync(
      script,
      `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const log = args[args.indexOf('-E') + 1];
const command = args[args.length - 1];
fs.writeFileSync(${JSON.stringify(join(fakeBinDir, 'last-log-path'))}, log);
if (command === 'auth-fails') {
  fs.appendFileSync(log, 'admin@router-a: Permission denied (publickey).\\n');
  process.exit(255);
}
if (command === 'drops') {
  process.stdout.write('started\\n');
  process.stderr.write('Connection to router-a closed by remote host.\\n');
  process.exit(255);
}
if (command === 'lookalike') {
  process.stderr.write('admin@router-a: Permission denied (publickey).\\n');
  process.exit(255);
}
process.stdout.write('ok\\n');
`,
    );
    chmodSync(script, 0o755);
    originalPath = process.env.PATH;
    process.env.PATH = `${fakeBinDir}:${originalPath ?? ''}`;
  });

  afterAll(() => {
    process.env.PATH = originalPath;
    rmSync(fakeBinDir, { recursive: true, force: true });
  });

  const transport = () =>
    new SshTransport({ target: { host: 'router-a', user: 'admin' }, policyTable: POLICY_TABLE });

  async function failureOf(command: string): Promise<Error> {
    const thrown = await transport()
      .invoke(operation, { command }, {})
      .then(
        () => undefined,
        (err: unknown) => err,
      );
    if (!(thrown instanceof Error)) throw new Error('expected the call to fail');
    return thrown;
  }

  it("reads a never-started session from ssh's own log: a plain failure", async () => {
    const err = await failureOf('auth-fails');
    expect(err).toBeInstanceOf(TransportInvokeError);
    expect(err).not.toBeInstanceOf(TransportOutcomeUnknownError);
    expect(err.message).toContain(
      'ssh client: untrusted: admin@router-a: Permission denied (publickey). (exit 255)',
    );
  });

  it('a session that dropped, or a remote command that only looks like ssh, is outcome unknown', async () => {
    for (const command of ['drops', 'lookalike']) {
      const err = await failureOf(command);
      expect(err).toBeInstanceOf(TransportOutcomeUnknownError);
    }
  });

  it('removes its log file either way', async () => {
    await failureOf('auth-fails');
    const failedLog = readFileSync(join(fakeBinDir, 'last-log-path'), 'utf8');
    await transport().invoke(operation, { command: 'show version' }, {});
    const okLog = readFileSync(join(fakeBinDir, 'last-log-path'), 'utf8');
    for (const logPath of [failedLog, okLog]) {
      const dir = logPath.slice(0, logPath.lastIndexOf('/'));
      expect(readdirSync(tmpdir())).not.toContain(dir.slice(dir.lastIndexOf('/') + 1));
    }
  });
});
