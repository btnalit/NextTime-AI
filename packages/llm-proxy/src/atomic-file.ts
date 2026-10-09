import { randomUUID } from 'node:crypto';
import { lstat, open, readdir, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

/**
 * atomic-file: the one way llm-proxy writes a file another process (the kernel, pi in a Worker
 * container) or a later request reads — `models.json`, `provider-health.json`, `providers.json`,
 * `keys.json`. A reader sees either the previous file or the complete new one, never a torn or
 * empty one, even with concurrent writers in this process or a crash mid-write:
 *
 *   - the temp file sits in the target's directory (same filesystem, so `rename` is atomic) and
 *     has a random name, so two writers never share one (`<file>.tmp-<pid>` did: in a container
 *     the pid is constant, and two concurrent rewrites renamed each other's half-written file);
 *   - it is created exclusively (`wx`), written, `fsync`ed and closed before the `rename`, so a
 *     crash cannot publish a file whose data never reached the disk;
 *   - `mode` is applied with `chmod` after creation, so the umask cannot loosen or tighten it;
 *     the temp file is never looser than the file it becomes — created with `mode` (the umask
 *     only narrows it), then set to exactly `mode`, the target's mode after the rename — so
 *     `keys.json`'s temp file is 0600 from its first byte;
 *   - a temp file a crash left behind is removed at the next startup (`removeStaleTempFiles`);
 *   - the directory is `fsync`ed after the rename (best effort) so the rename itself survives a
 *     crash.
 *
 * Callers still serialize their own writes (`Mutex`): this makes each write safe, it does not
 * order them — the last writer to rename wins, so the writer must build its snapshot inside the
 * lock.
 */
export async function writeFileAtomic(
  filePath: string,
  content: string,
  mode: number,
): Promise<void> {
  const tmp = join(dirname(filePath), `.${basename(filePath)}.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(tmp, 'wx', mode);
    await handle.chmod(mode);
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(tmp, filePath);
  } catch (err) {
    await handle?.close().catch(() => undefined);
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
  try {
    const dir = await open(dirname(filePath), 'r');
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  } catch {
    // Some filesystems refuse a directory fsync; the rename already happened.
  }
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Removes the temp files a writer of `filePath` left behind when it crashed between creating one
 * and renaming it — for `keys.json` that file holds provider keys, so it must not outlive the
 * crash. Matches only this module's own names for `filePath` (and the `<file>.tmp-<pid>` names the
 * writers used before this module); removes a regular file or a symlink with such a name, never a
 * directory, and never follows a link.
 *
 * Call it only when no write of `filePath` can be in flight — at startup, before this process's
 * first write (index.ts, before the stores load): it cannot tell a crashed writer's temp file from
 * a live one's. Each of these files has one writer process. Never throws; returns the names it
 * removed, for a log.
 */
export async function removeStaleTempFiles(filePath: string): Promise<string[]> {
  const dir = dirname(filePath);
  const base = escapeRegExp(basename(filePath));
  const patterns = [new RegExp(`^\\.${base}\\.${UUID}\\.tmp$`), new RegExp(`^${base}\\.tmp-\\d+$`)];
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const name of names) {
    if (!patterns.some((pattern) => pattern.test(name))) continue;
    const entry = join(dir, name);
    try {
      const info = await lstat(entry);
      if (!info.isFile() && !info.isSymbolicLink()) continue;
      await unlink(entry);
      removed.push(name);
    } catch {
      // Gone already, or not ours to remove: the next startup tries again.
    }
  }
  return removed;
}
