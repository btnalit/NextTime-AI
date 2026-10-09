import { chmodSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { type HandleBinding, HandleBindingFileSchema } from '@nexttime/shared';

/**
 * handle-bindings: this process's half of the source binding (@nexttime/shared handle-binding.ts,
 * design doc §7.3 / §11 "来源绑定"). An entry container's or a WorkerRun's Handle no longer goes
 * into the container's environment (spawn-spec.ts / task-spawn-spec.ts); it is written here,
 * keyed by the container's address on the `workers` network, and the kernel and llm-proxy take it
 * from this file for a request from that address.
 *
 * Who writes what, when (resident-service.ts / task-service.ts / index.ts):
 *   - `bind` right after a container is created and started, and on every resident reuse (the
 *     incoming Handle may be a newer one for the same container) — *before* the spawn call
 *     returns. A failed `bind` fails the spawn: a container with no binding cannot call anything.
 *   - `unbind` wherever its egress registration is removed (stop, idle sweep, crash, exit event,
 *     Task reap) — before Docker can hand the address to another container.
 *   - `retainLive` at startup and after every docker-events reconnect: drops every binding whose
 *     container is gone or no longer at that address. This process may restart while the file
 *     (on the shared tmpfs volume) outlives it.
 *
 * The file is replaced by rename (write a sibling temp file, then `rename`), so a reader never
 * sees a half-written file, and it is `0600`: worker-supervisor, the kernel and llm-proxy all run
 * as uid 10001. The volume is tmpfs (docker-compose.yml `handle-bindings`) — the Handles never
 * touch a disk, and a host reboot starts from an empty file.
 */

export interface HandleBindingStore {
  /** Binds `handle` to `ip`, replacing whatever was bound there. Throws when the file cannot be
   *  written — the container would be unusable, so the caller must not report success. */
  bind(ip: string, binding: Omit<HandleBinding, 'boundAt'>): void;
  /** Removes the binding for `ip` (a no-op when there is none). Throws on a write failure. */
  unbind(ip: string): void;
  /** Keeps only the bindings `isLive(ip, binding)` confirms. Returns the addresses it dropped. */
  retainLive(
    isLive: (ip: string, binding: HandleBinding) => Promise<boolean>,
  ): Promise<readonly string[]>;
  /** The current bindings, by address (a copy). */
  snapshot(): ReadonlyMap<string, HandleBinding>;
}

export interface HandleBindingStoreOptions {
  readonly now?: () => Date;
  /** Called when the existing file cannot be loaded at startup (it is then treated as empty and
   *  replaced on the next write). Receives a reason, never the file's content. */
  readonly onLoadError?: (reason: string) => void;
}

function loadBindings(
  filePath: string,
  onLoadError: (reason: string) => void,
): Map<string, HandleBinding> {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') onLoadError(`unreadable (${code ?? 'error'})`);
    return new Map();
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    onLoadError('not valid JSON');
    return new Map();
  }
  const parsed = HandleBindingFileSchema.safeParse(json);
  if (!parsed.success) {
    onLoadError('does not match the bindings schema');
    return new Map();
  }
  return new Map(Object.entries(parsed.data));
}

export function createHandleBindingStore(
  filePath: string,
  options: HandleBindingStoreOptions = {},
): HandleBindingStore {
  const now = options.now ?? (() => new Date());
  const bindings = loadBindings(filePath, options.onLoadError ?? (() => {}));
  const tempPath = join(dirname(filePath), `.${basename(filePath)}.tmp`);

  function write(next: Map<string, HandleBinding>): void {
    const content = `${JSON.stringify(Object.fromEntries(next), null, 2)}\n`;
    writeFileSync(tempPath, content, { encoding: 'utf8', mode: 0o600 });
    // `mode` only applies when the temp file is created; a leftover one keeps its own.
    chmodSync(tempPath, 0o600);
    renameSync(tempPath, filePath);
  }

  /** Writes `next` and only then adopts it, so a failed write leaves the in-memory view equal to
   *  the file. */
  function commit(next: Map<string, HandleBinding>): void {
    write(next);
    bindings.clear();
    for (const [ip, binding] of next) bindings.set(ip, binding);
  }

  return {
    bind(ip, binding) {
      const next = new Map(bindings);
      next.set(ip, { ...binding, boundAt: now().toISOString() });
      commit(next);
    },
    unbind(ip) {
      if (!bindings.has(ip)) return;
      const next = new Map(bindings);
      next.delete(ip);
      commit(next);
    },
    async retainLive(isLive) {
      const dead: [string, HandleBinding][] = [];
      for (const [ip, binding] of [...bindings]) {
        if (!(await isLive(ip, binding))) dead.push([ip, binding]);
      }
      // A `bind` may have replaced an entry while `isLive` was awaiting Docker: drop only the
      // exact binding that was judged (every `bind` stores a new object).
      const next = new Map(bindings);
      const dropped = dead.filter(([ip, binding]) => next.get(ip) === binding).map(([ip]) => ip);
      if (dropped.length === 0) return dropped;
      for (const ip of dropped) next.delete(ip);
      commit(next);
      return dropped;
    },
    snapshot() {
      return new Map(bindings);
    },
  };
}
