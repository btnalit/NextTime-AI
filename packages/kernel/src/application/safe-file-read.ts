import { constants, type FileHandle, open } from 'node:fs/promises';

/**
 * application/safe-file-read: how the kernel reads a file another process writes into a directory
 * it only mounts — llm-proxy's `models.json` / `provider-health.json`, update-feed's
 * `channel.json`, the backup service's `last-success` marker (#530 review S2 and its follow-up).
 *
 * - the final path component must not be a symlink (`O_NOFOLLOW`);
 * - the opened file must be a regular file (`fstat`) — a FIFO or device is refused, and opening
 *   one never blocks (`O_NONBLOCK`), so a writer cannot park a libuv thread on every read;
 * - it may hold at most `maxBytes`, checked on `fstat` and again while reading, so a file growing
 *   after the check still cannot make the kernel buffer more than `maxBytes + 1`;
 * - the stat and the read use one handle, so the `mtime` returned is the content's.
 */

/** Why `readSmallRegularFile` refused a file. `code` keeps the errno-style code callers already
 *  map to messages (`ENOENT`, `EACCES`, `EISDIR`, …); `size` and `mtime` are set for `too_large`. */
export class UnsafeFileError extends Error {
  readonly reason: 'missing' | 'symlink' | 'not_regular' | 'too_large' | 'unreadable';
  readonly code: string;
  readonly size: number | undefined;
  readonly mtime: Date | undefined;

  constructor(
    reason: UnsafeFileError['reason'],
    code: string,
    message: string,
    options?: { cause?: unknown; size?: number; mtime?: Date },
  ) {
    super(message, options);
    this.name = 'UnsafeFileError';
    this.reason = reason;
    this.code = code;
    this.size = options?.size;
    this.mtime = options?.mtime;
  }
}

export interface SmallFileRead {
  readonly text: string;
  readonly mtime: Date;
}

export async function readSmallRegularFile(file: string, maxBytes: number): Promise<SmallFileRead> {
  let handle: FileHandle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? 'error';
    if (code === 'ENOENT') throw new UnsafeFileError('missing', code, `"${file}" does not exist`);
    if (code === 'ELOOP') throw new UnsafeFileError('symlink', code, `"${file}" is a symlink`);
    throw new UnsafeFileError('unreadable', code, `"${file}" could not be opened`, { cause: err });
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new UnsafeFileError(
        'not_regular',
        stat.isDirectory() ? 'EISDIR' : 'ENOTREG',
        `"${file}" is not a regular file`,
      );
    }
    const tooLarge = (size: number) =>
      new UnsafeFileError('too_large', 'EFBIG', `"${file}" is larger than ${maxBytes} bytes`, {
        size,
        mtime: stat.mtime,
      });
    if (stat.size > maxBytes) throw tooLarge(stat.size);
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length <= maxBytes) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > maxBytes) throw tooLarge(length);
    return { text: buffer.subarray(0, length).toString('utf8'), mtime: stat.mtime };
  } catch (err) {
    if (err instanceof UnsafeFileError) throw err;
    const code = (err as NodeJS.ErrnoException).code ?? 'error';
    throw new UnsafeFileError('unreadable', code, `"${file}" could not be read`, { cause: err });
  } finally {
    await handle.close();
  }
}
