/**
 * lib/tar (S11 AA5d-3): an uncompressed POSIX ustar archive of text files, written in the browser
 * so an exported pack (`export_admin_proposal_pack`) downloads as one file a maintainer unpacks
 * into the host's `config/packs/` with `tar -xf` (docs/runbooks/operations.md §14.10) — no new
 * dependency for a format this small.
 *
 * Regular files only (`tar` makes the directories a path needs), mode 0644, owner 0/0 with no
 * names, modification time 0: the same files give the same bytes, as the export itself is
 * deterministic. A path longer than the 100-byte name field is split at a `/` into the 155-byte
 * prefix field; one that cannot be split, an absolute path, one with a `..` segment, or one with a
 * control character (a NUL ends a ustar name early: `a/..\0/x` reads back as `a/..`) is refused
 * rather than written in a form that unpacks somewhere else.
 */

const BLOCK = 512;

export interface TarFile {
  /** Relative, `/`-separated. */
  readonly path: string;
  readonly content: string;
}

export class TarPathError extends Error {
  readonly path: string;
  constructor(path: string, why: string) {
    super(`cannot put ${JSON.stringify(path)} in a tar archive: ${why}`);
    this.name = 'TarPathError';
    this.path = path;
  }
}

/** A C0 control character or DEL anywhere in `text` (NUL included). */
function hasControlCharacter(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

const encoder = new TextEncoder();

/** `value` as `width - 1` zero-padded octal digits and a NUL. */
function octal(value: number, width: number): string {
  return `${value.toString(8).padStart(width - 1, '0')}\0`;
}

function writeField(header: Uint8Array, offset: number, width: number, text: string): void {
  const bytes = encoder.encode(text);
  if (bytes.length > width) throw new Error(`tar field overflow at ${offset}`);
  header.set(bytes, offset);
}

/** The ustar name and prefix fields for `path`. */
function splitPath(path: string): { readonly name: string; readonly prefix: string } {
  if (path === '' || path.startsWith('/')) throw new TarPathError(path, 'not a relative path');
  if (hasControlCharacter(path)) throw new TarPathError(path, 'a control character');
  if (path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new TarPathError(path, 'an empty, "." or ".." segment');
  }
  if (encoder.encode(path).length <= 100) return { name: path, prefix: '' };
  // The longest prefix that fits, so the name keeps as little as it can.
  for (let at = path.lastIndexOf('/'); at > 0; at = path.lastIndexOf('/', at - 1)) {
    const prefix = path.slice(0, at);
    const name = path.slice(at + 1);
    if (encoder.encode(prefix).length <= 155 && encoder.encode(name).length <= 100) {
      return { name, prefix };
    }
  }
  throw new TarPathError(path, 'too long for a ustar header');
}

function header(path: string, size: number): Uint8Array {
  const { name, prefix } = splitPath(path);
  const block = new Uint8Array(BLOCK);
  writeField(block, 0, 100, name);
  writeField(block, 100, 8, octal(0o644, 8));
  writeField(block, 108, 8, octal(0, 8));
  writeField(block, 116, 8, octal(0, 8));
  writeField(block, 124, 12, octal(size, 12));
  writeField(block, 136, 12, octal(0, 12));
  writeField(block, 148, 8, '        ');
  writeField(block, 156, 1, '0');
  writeField(block, 257, 6, 'ustar\0');
  writeField(block, 263, 2, '00');
  writeField(block, 345, 155, prefix);
  let sum = 0;
  for (const byte of block) sum += byte;
  writeField(block, 148, 8, `${sum.toString(8).padStart(6, '0')}\0 `);
  return block;
}

/** `files` as one ustar archive, in the order given (throws `TarPathError` for a path it cannot
 *  hold). */
export function ustarArchive(files: readonly TarFile[]): Uint8Array {
  const parts: Uint8Array[] = [];
  let length = 0;
  for (const file of files) {
    const content = encoder.encode(file.content);
    const padded = Math.ceil(content.length / BLOCK) * BLOCK;
    const body = new Uint8Array(padded);
    body.set(content);
    parts.push(header(file.path, content.length), body);
    length += BLOCK + padded;
  }
  // Two zero blocks end the archive.
  parts.push(new Uint8Array(BLOCK * 2));
  length += BLOCK * 2;
  const archive = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    archive.set(part, offset);
    offset += part.length;
  }
  return archive;
}

/**
 * Downloads `files` as `filename` (an ustar archive), the way `downloadJson` (lib/audit.ts) does:
 * a `Blob` behind an object URL clicked through a temporary `<a download>`. Returns `false` where
 * the API is missing; callers keep the files on screen too.
 */
export function downloadTar(filename: string, files: readonly TarFile[]): boolean {
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return false;
  const archive = ustarArchive(files);
  const blob = new Blob([archive.buffer as ArrayBuffer], { type: 'application/x-tar' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  if (typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(url);
  return true;
}
