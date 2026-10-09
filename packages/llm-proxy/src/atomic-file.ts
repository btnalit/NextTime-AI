import { randomUUID } from 'node:crypto';
import { open, rename, unlink } from 'node:fs/promises';
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
