import { describe, expect, it } from 'vitest';
import type { ProcFsReader, RawProcess } from './process-tree.js';
import { ProcNotAvailableError, collectProcessTree, subtreeOf } from './process-tree.js';

const P = (pid: number, ppid: number, commandLine: string): RawProcess => ({
  pid,
  ppid,
  commandLine,
  executablePath: commandLine.split(' ')[0] ?? '',
});

describe('subtreeOf (pure)', () => {
  it('returns just the root when it has no children', () => {
    const processes = [P(1, 0, 'init'), P(2, 1, 'other')];
    expect(subtreeOf(processes, 2).map((p) => p.pid)).toEqual([2]);
  });

  it('returns the root plus every transitive descendant', () => {
    const processes = [
      P(1, 0, 'init'),
      P(10, 1, 'pi entrypoint'),
      P(11, 10, 'node worker'),
      P(12, 11, 'sh -c build'),
      P(20, 1, 'unrelated'),
    ];
    const result = subtreeOf(processes, 10)
      .map((p) => p.pid)
      .sort((a, b) => a - b);
    expect(result).toEqual([10, 11, 12]);
  });

  it('returns an empty array when the root pid is not present', () => {
    expect(subtreeOf([P(1, 0, 'init')], 999)).toEqual([]);
  });

  it('does not loop forever on a cyclic ppid chain', () => {
    // Pathological/adversarial input — a should never occur from real /proc data, but the walk
    // must still terminate.
    const processes = [P(1, 2, 'a'), P(2, 1, 'b')];
    const result = subtreeOf(processes, 1)
      .map((p) => p.pid)
      .sort((a, b) => a - b);
    expect(result).toEqual([1, 2]);
  });
});

function fakeReader(processes: readonly RawProcess[]): ProcFsReader {
  const byPid = new Map(processes.map((p) => [p.pid, p]));
  return {
    listPids: async () => processes.map((p) => p.pid),
    readCmdline: async (pid) => byPid.get(pid)?.commandLine ?? null,
    readStatPpid: async (pid) => byPid.get(pid)?.ppid ?? null,
  };
}

describe('collectProcessTree', () => {
  it('returns the agent-runtime subtree when a matching process is visible', async () => {
    const reader = fakeReader([
      P(1, 0, 'init'),
      P(10, 1, 'pi entrypoint'),
      P(11, 10, 'node worker'),
      P(20, 1, 'unrelated'),
    ]);

    const result = await collectProcessTree({ reader });
    expect(result.skipped).toBe(false);
    expect(result.processes.map((p) => p.pid).sort((a, b) => a - b)).toEqual([10, 11]);
  });

  it('skips cleanly (does not throw) when no process matches the agent-runtime marker — the expected default (no pid: host)', async () => {
    const reader = fakeReader([P(1, 0, 'init'), P(2, 1, 'nginx')]);

    const result = await collectProcessTree({ reader, agentRuntimeMatch: 'pi' });
    expect(result.skipped).toBe(true);
    expect(result.processes).toEqual([]);
    expect(result.reason).toMatch(/no process matching/);
  });

  it('skips cleanly when /proc itself cannot be read', async () => {
    const reader: ProcFsReader = {
      listPids: async () => {
        throw new ProcNotAvailableError(new Error('ENOENT'));
      },
      readCmdline: async () => null,
      readStatPpid: async () => null,
    };

    const result = await collectProcessTree({ reader });
    expect(result.skipped).toBe(true);
    expect(result.reason).toMatch(/proc is not readable/);
  });

  it('the ProcFsReader contract exposes no way to read environ at all (type-level guard, not just documentation)', () => {
    // `ProcFsReader` only ever declares `listPids`/`readCmdline`/`readStatPpid` — there is no
    // `readEnviron` method for any implementation (real or fake) to provide, and
    // `readAllProcesses` (this module's own internal caller) never calls anything named it. This
    // test exists as a named place documenting that guarantee next to the behavioral tests above,
    // not to execute new logic.
    const reader: ProcFsReader = {
      listPids: async () => [],
      readCmdline: async () => null,
      readStatPpid: async () => null,
    };
    expect(Object.keys(reader).sort()).toEqual(['listPids', 'readCmdline', 'readStatPpid']);
  });
});
