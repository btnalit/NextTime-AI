import { randomUUID } from 'node:crypto';
import { open, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

/**
 * atomic-file: replaces `filePath` whole — a reader (this process after a restart, or another
 * one) sees the old content or the new, never a torn or empty file, also across a power loss.
 * Writes a temp file with a random name in the same directory, fsyncs it, renames it over the
 * target and fsyncs the directory (best effort: not every filesystem allows it).
 *
 * The caller still serializes its own writes (the stores here chain them), so the last rename
 * to land is the newest snapshot. `mode` applies to a new file through the umask, as
 * `writeFile` does.
 */
export async function writeFileAtomic(
  filePath: string,
  content: string,
  mode = 0o666,
): Promise<void> {
  const tmp = join(dirname(filePath), `.${basename(filePath)}.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(tmp, 'wx', mode);
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
    // Directory fsync is not supported everywhere; the rename itself is already atomic.
  }
}
