import { randomUUID } from 'node:crypto';
import { lstat, open, readdir, rename, stat, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

/**
 * atomic-file: replaces `filePath` whole — a reader (this process after a restart, or another
 * one) sees the old content or the new, never a torn or empty file, also across a power loss.
 * Writes a temp file with a random name in the same directory, fsyncs it, renames it over the
 * target and fsyncs the directory (best effort: not every filesystem allows it).
 *
 * The caller still serializes its own writes (the stores here chain them), so the last rename
 * to land is the newest snapshot. `mode` applies to a new file through the umask, as
 * `writeFile` does; when the target exists, the temp file (and so the replacement) never gets a
 * permission bit the target lacks — an operator who narrowed `connected-accounts.json` to 0600
 * keeps 0600. A temp file a crash left behind is removed by `removeStaleTempFiles`.
 */
export async function writeFileAtomic(
  filePath: string,
  content: string,
  mode = 0o666,
): Promise<void> {
  const tmp = join(dirname(filePath), `.${basename(filePath)}.${randomUUID()}.tmp`);
  const targetMode = await stat(filePath).then(
    (info) => info.mode & 0o777,
    () => undefined,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(tmp, 'wx', targetMode === undefined ? mode : mode & targetMode);
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

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Removes the temp files a writer of `filePath` left behind when it crashed between creating one
 * and renaming it — `connected-accounts.json` holds encrypted credentials, so its debris must not
 * pile up. Matches only this module's own names for `filePath` (and the `<file>.<uuid>.tmp` names
 * the stores used before this module); removes a regular file or a symlink with such a name, never
 * a directory, and never follows a link.
 *
 * Call it only when no write of `filePath` can be in flight — at startup, before this process's
 * first write (`ConnectedAccountStore`'s first write, `JsonFileIdempotencyStore`'s load): it
 * cannot tell a crashed writer's temp file from a live one's. Each of these files has one writer
 * process. Never throws; returns the names it removed, for a log.
 */
export async function removeStaleTempFiles(filePath: string): Promise<string[]> {
  const dir = dirname(filePath);
  const base = escapeRegExp(basename(filePath));
  const patterns = [
    new RegExp(`^\\.${base}\\.${UUID}\\.tmp$`),
    new RegExp(`^${base}\\.${UUID}\\.tmp$`),
  ];
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
