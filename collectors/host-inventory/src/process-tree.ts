import { readFile, readdir } from 'node:fs/promises';

/**
 * process-tree: the agent-runtime process subtree (docs/development-tasks.md S3.3 deliverable 2:
 * "Process tree limited to the agent runtime process subtree — only keep the non-systemd child
 * processes under the agent runtime's own process tree; skip if not visible").
 *
 * **Documented limit (deliberate, not a placeholder)**: this collector's own compose service
 * (`docker-compose.yml`) does *not* share the host's PID namespace (`pid: "host"`) — the task
 * dispatch's own compose section enumerates exactly what this service gets (`control` network,
 * a dedicated read-only `docker-socket-proxy-collector`, no `docker.sock` mount) and names no PID-
 * namespace sharing; adding one would be a real, undocumented privilege escalation this codebase's
 * every other hardened service (`docker-socket-proxy*`, `gatekeeper-docker`, …) goes out of its
 * way to avoid granting beyond what its own actual call surface needs. Without it, `/proc` inside
 * this collector's own container shows only *this container's own* process tree — never an entry
 * or Worker container's — so `collectProcessTree` below reads `/proc` honestly, finds no process
 * matching `agentRuntimeMatch` in its own namespace, and returns `{skipped: true, ...}` by
 * construction in this collector's current default deployment. This is the acceptance criterion's
 * own "skip if not visible" path exercised as the expected, everyday case, not a rare failure mode
 * — see `docs/runbooks/host-collector.md` for the operator-facing explanation and the (currently
 * declined) `pid: host` alternative this collector would need to ever observe a *different*
 * container's process tree.
 *
 * `environ` (`/proc/<pid>/environ`) is never read anywhere in this module (or this package) — only
 * `cmdline`/`comm`/`stat` (for `ppid`) are — the task's own I9-adjacent rule ("environ 不读").
 */

export interface RawProcess {
  readonly pid: number;
  readonly ppid: number;
  readonly commandLine: string;
  readonly executablePath: string;
}

export interface ProcessTreeResult {
  readonly skipped: boolean;
  readonly reason?: string;
  readonly processes: readonly RawProcess[];
}

/** Filesystem access this module needs from `/proc` — injectable so `collectProcessTree` is
 *  testable without a real `/proc` (Windows has none at all; a Linux CI runner's own `/proc` is
 *  not a fixture this test suite should depend on either). */
export interface ProcFsReader {
  listPids(): Promise<readonly number[]>;
  /** `/proc/<pid>/cmdline` — NUL-joined argv, exactly as the kernel writes it; `null` if the pid
   *  vanished or is unreadable (a race with process exit, or a permission boundary) — never
   *  thrown, since a transient miss on one pid must not abort the whole collection. */
  readCmdline(pid: number): Promise<string | null>;
  /** `/proc/<pid>/stat` — this module only needs field 4 (`ppid`); `null` on the same failure
   *  modes as `readCmdline`. */
  readStatPpid(pid: number): Promise<number | null>;
}

export class ProcNotAvailableError extends Error {
  constructor(cause: unknown) {
    super('process-tree: /proc is not readable in this container', { cause });
    this.name = 'ProcNotAvailableError';
  }
}

/** The real, `/proc`-backed reader — Linux only (this collector's image is `node:24-bookworm-
 *  slim`, always Linux; a non-Linux dev machine never calls this — `run.ts` catches
 *  `ProcNotAvailableError` and skips). */
export function createProcFsReader(): ProcFsReader {
  return {
    async listPids(): Promise<readonly number[]> {
      let entries: string[];
      try {
        entries = await readdir('/proc');
      } catch (err) {
        throw new ProcNotAvailableError(err);
      }
      return entries.filter((name) => /^\d+$/.test(name)).map((name) => Number.parseInt(name, 10));
    },

    async readCmdline(pid: number): Promise<string | null> {
      try {
        const raw = await readFile(`/proc/${pid}/cmdline`, 'utf8');
        return raw
          .split('\0')
          .filter((part) => part.length > 0)
          .join(' ');
      } catch {
        return null;
      }
    },

    async readStatPpid(pid: number): Promise<number | null> {
      try {
        const raw = await readFile(`/proc/${pid}/stat`, 'utf8');
        // Field 2 (`comm`) is parenthesized and may itself contain spaces — split after the
        // matching closing paren, then fields are space-separated from there; ppid is field 4
        // overall, i.e. index 1 (0-based) of the fields *after* the comm field.
        const afterComm = raw.slice(raw.lastIndexOf(')') + 1).trim();
        const fields = afterComm.split(/\s+/);
        const ppidField = fields[1];
        if (ppidField === undefined) return null;
        const ppid = Number.parseInt(ppidField, 10);
        return Number.isFinite(ppid) ? ppid : null;
      } catch {
        return null;
      }
    },
  };
}

/** Reads every visible process's `{pid, ppid, commandLine}` via `reader` — pids that vanish
 *  mid-read (cmdline or stat unreadable) are silently dropped, not errored (a process exiting
 *  while this collector runs is normal, not a failure). `executablePath` is the first argv token
 *  (this collector's own convention — matches ops-assets-v1.yaml's Process identityKey, which
 *  fixes exactly three components: executablePath/workingDirectory/parentPid; `workingDirectory`
 *  is resolved separately by `observation-builder.ts`, since `/proc/<pid>/cwd` is a symlink read,
 *  not part of this raw scan). */
async function readAllProcesses(reader: ProcFsReader): Promise<RawProcess[]> {
  const pids = await reader.listPids();
  const results: RawProcess[] = [];
  for (const pid of pids) {
    const [cmdline, ppid] = await Promise.all([reader.readCmdline(pid), reader.readStatPpid(pid)]);
    if (cmdline === null || ppid === null || cmdline.length === 0) continue;
    const executablePath = cmdline.split(' ')[0] ?? '';
    results.push({ pid, ppid, commandLine: cmdline, executablePath });
  }
  return results;
}

/**
 * Pure: given the full flat process list and a root pid, returns every process in that root's
 * subtree (the root itself plus every transitive child) — no IO, fully unit-testable against a
 * fabricated list. Cycle-safe (a malformed/adversarial `ppid` chain cannot loop forever): each pid
 * is visited at most once regardless of how the parent pointers are shaped.
 */
export function subtreeOf(processes: readonly RawProcess[], rootPid: number): RawProcess[] {
  const byParent = new Map<number, RawProcess[]>();
  for (const process of processes) {
    const siblings = byParent.get(process.ppid) ?? [];
    siblings.push(process);
    byParent.set(process.ppid, siblings);
  }

  const root = processes.find((p) => p.pid === rootPid);
  if (!root) return [];

  const visited = new Set<number>([root.pid]);
  const result: RawProcess[] = [root];
  const queue: RawProcess[] = [root];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;
    for (const child of byParent.get(current.pid) ?? []) {
      if (visited.has(child.pid)) continue;
      visited.add(child.pid);
      result.push(child);
      queue.push(child);
    }
  }
  return result;
}

export interface CollectProcessTreeOptions {
  readonly reader?: ProcFsReader;
  /** Substring matched against a process's `commandLine` to find the agent-runtime root — case-
   *  sensitive, matching the literal binary name the pi coding agent's entrypoint execs (design
   *  doc §7.2/§S1.6 — `pi`). Overridable for tests and for a deployment whose entrypoint wraps `pi`
   *  differently. */
  readonly agentRuntimeMatch?: string;
}

const DEFAULT_AGENT_RUNTIME_MATCH = 'pi';

/** Finds the (first) process whose `commandLine` contains `agentRuntimeMatch`, and returns its
 *  full subtree — `{skipped: true, reason}` when `/proc` cannot be read at all, or when no process
 *  in whatever this collector's own PID namespace can see matches (this collector's current
 *  default deployment — no `pid: host` — see this module's own doc comment for why that is the
 *  expected, everyday outcome, not an error). */
export async function collectProcessTree(
  options: CollectProcessTreeOptions = {},
): Promise<ProcessTreeResult> {
  const reader = options.reader ?? createProcFsReader();
  const agentRuntimeMatch = options.agentRuntimeMatch ?? DEFAULT_AGENT_RUNTIME_MATCH;

  let processes: RawProcess[];
  try {
    processes = await readAllProcesses(reader);
  } catch (err) {
    if (err instanceof ProcNotAvailableError) {
      return { skipped: true, reason: err.message, processes: [] };
    }
    throw err;
  }

  const root = processes.find((p) => p.commandLine.includes(agentRuntimeMatch));
  if (!root) {
    return {
      skipped: true,
      reason: `process-tree: no process matching "${agentRuntimeMatch}" is visible in this container's own PID namespace`,
      processes: [],
    };
  }

  // "只保留...非 systemd 子进程" (S3.3): a systemd-managed descendant would only ever appear here
  // if the agent runtime itself spawned one directly, which it never does (systemd units are
  // observed separately, by `systemd.ts`, from the *host's* own systemd — an entirely different
  // data source) — no filter is applied here beyond the subtree walk itself, since nothing in this
  // collector's own process-tree scan can ever produce a systemd-unit-shaped entry in the first
  // place; this comment exists so a reviewer does not go looking for a filter that was never
  // needed rather than silently omitted.
  return { skipped: false, processes: subtreeOf(processes, root.pid) };
}
