import { z } from 'zod';

/**
 * handle-binding: source binding for container-held Handles (`HANDLE_HOLDERS` in handle-token.ts;
 * design doc §7.3 / §11 "来源绑定").
 *
 * Before this, an agent container's Handle sat in its own environment (`CAPABILITY_HANDLE`), where
 * the model's own shell could read it — `env`, `/proc/1/environ`, or the pi process's memory — and
 * whatever read it held a bearer token on its owner's behalf for up to a day, usable from anywhere.
 * No in-container arrangement fixes that: pi's built-in tools run as the same uid as pi itself.
 * So the Handle no longer enters the container at all:
 *
 *   1. worker-supervisor, which already places each container on the `workers` network and
 *      registers its address with egress-proxy, writes `{ <container ip>: { handle, … } }` into the
 *      bindings file when it starts (or reuses) the container, and removes the entry when it stops
 *      it (before the stop, while the container still holds the address). Only worker-supervisor
 *      mounts the file writable; the kernel and llm-proxy mount it read-only. Agent containers
 *      can't spoof an address: they run with every capability dropped (no `NET_RAW` /
 *      `NET_ADMIN`), and runsc keeps raw sockets off. Each running container has an address of its
 *      own on the `workers` bridge (runsc's `--network=host` still runs in the container's own
 *      network namespace); worker-supervisor refuses to bind an address another running container
 *      holds, and a container's entrypoint starts pi only once the kernel reports the binding at
 *      its address names that container — the moment after Docker reuses a crashed container's
 *      address, before worker-supervisor rebinds it, runs nothing model-controlled.
 *   2. The container calls the kernel and llm-proxy with no credential. Each verifier takes the
 *      Handle bound to the request's TCP peer address (`decideHandlePresentation` below) and
 *      verifies it as before — signature, expiry, revocation — and additionally requires it to be
 *      container-held. A request from the `workers` network with no binding is refused.
 *   3. A container-held Handle presented in a header (the bearer path) is refused everywhere, so a
 *      copy of one — out of a log line, a database row, a backup — authorizes nothing.
 *
 * `CAPABILITY_HANDLE` stays in the container's environment with the fixed, non-secret value
 * `SOURCE_BOUND_CAPABILITY_HANDLE`: the platform's `models.json` names `$CAPABILITY_HANDLE` as the
 * provider `apiKey`, and pi refuses a provider whose key template resolves to nothing. llm-proxy
 * ignores that header for a bound source.
 *
 * IO-free like the rest of this package (packages/web bundles it): the reader takes its file
 * access as `HandleBindingSource`, and the kernel and llm-proxy pass `node:fs` calls.
 */

/** The value of `CAPABILITY_HANDLE` inside every entry / Worker container — a marker, not a
 *  credential. The real Handle is held outside the container (this module's doc comment). */
export const SOURCE_BOUND_CAPABILITY_HANDLE = 'source-bound' as const;

/** Environment variable naming the bindings file in worker-supervisor, the kernel and llm-proxy. */
export const HANDLE_BINDINGS_FILE_ENV = 'HANDLE_BINDINGS_FILE' as const;

/** One bound container. `handle` is the compact JWT; `sourceId` is the egress source id of the
 *  same container (`entry:<ws>:<principal>` / `worker:<ws>:<workerRun>`), for log lines. */
export const HandleBindingSchema = z
  .object({
    handle: z.string().min(1),
    sourceId: z.string().min(1),
    containerId: z.string().min(1).optional(),
    boundAt: z.string().min(1),
  })
  .strict();
export type HandleBinding = z.infer<typeof HandleBindingSchema>;

/** The whole file, keyed by the container's IPv4 address on the `workers` network. */
export const HandleBindingFileSchema = z.record(z.string(), HandleBindingSchema);
export type HandleBindingFile = z.infer<typeof HandleBindingFileSchema>;

/** A socket's `remoteAddress` as the bindings file keys it: an IPv4-mapped IPv6 peer
 *  (`::ffff:a.b.c.d`, what Node reports on a dual-stack listener) becomes `a.b.c.d`. */
export function normalizePeerAddress(address: string): string {
  const trimmed = address.trim();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(trimmed);
  return mapped?.[1] ?? trimmed;
}

/**
 * How a verifier must authenticate one request (this module's doc comment, steps 2–3):
 *   - `source`: the peer is a bound container — use `binding.handle`, which must be
 *     container-held; anything the request presents itself is not a credential;
 *   - `bearer`: the peer is outside the `workers` network and unbound — read the request's own
 *     header; a container-held Handle found there is refused;
 *   - `refused`: the peer is on the `workers` network but nothing is bound to it.
 */
export type HandlePresentation =
  | { readonly kind: 'source'; readonly binding: HandleBinding }
  | { readonly kind: 'bearer' }
  | { readonly kind: 'refused'; readonly reason: 'unbound_source' };

export function decideHandlePresentation(input: {
  readonly binding: HandleBinding | undefined;
  readonly fromWorkersSubnet: boolean;
}): HandlePresentation {
  if (input.binding) return { kind: 'source', binding: input.binding };
  if (input.fromWorkersSubnet) return { kind: 'refused', reason: 'unbound_source' };
  return { kind: 'bearer' };
}

/** File access for `createHandleBindingReader`. `version()` returns a key that changes whenever
 *  the content may have (e.g. inode + mtime + size — the writer replaces the file by rename), or
 *  `undefined` when the file does not exist. */
export interface HandleBindingSource {
  version(): string | undefined;
  read(): string;
}

/** What `HandleBindingReaderOptions.onError` receives: the reason only — never the underlying
 *  error, whose message can quote the file's content (V8's `JSON.parse` errors include a snippet
 *  of the input, which here is a Handle). `code` is the errno code of a failed read. */
export class HandleBindingFileError extends Error {
  readonly reason: 'unreadable' | 'malformed' | 'invalid';
  readonly code: string | undefined;
  constructor(reason: HandleBindingFileError['reason'], code?: string) {
    super(
      reason === 'unreadable'
        ? `handle bindings file is unreadable${code ? ` (${code})` : ''}`
        : reason === 'malformed'
          ? 'handle bindings file is not valid JSON'
          : 'handle bindings file does not match the bindings schema',
    );
    this.name = 'HandleBindingFileError';
    this.reason = reason;
    this.code = code;
  }
}

function errnoCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

export interface HandleBindingReaderOptions {
  readonly source: HandleBindingSource;
  /** How long a lookup with `waitForRegistration` keeps re-reading for a missing address — the
   *  gap between Docker starting a container and worker-supervisor writing its binding. */
  readonly registrationWaitMs?: number;
  readonly pollMs?: number;
  /** How soon a version of the file that could not be read or parsed is read again although it
   *  has not changed — a read can fail for a moment (`EMFILE` under load) on a file that is fine. */
  readonly failedReadRetryMs?: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Called once per unreadable / malformed version of the file (not again on its retries). */
  readonly onError?: (err: HandleBindingFileError) => void;
}

export interface HandleBindingReader {
  /** The binding for `peerAddress`, re-reading the file when it changed. With
   *  `waitForRegistration`, a miss is retried for `registrationWaitMs` before it is final. */
  lookup(
    peerAddress: string,
    options?: { readonly waitForRegistration?: boolean },
  ): Promise<HandleBinding | undefined>;
}

export const DEFAULT_HANDLE_BINDING_REGISTRATION_WAIT_MS = 3000;
export const DEFAULT_HANDLE_BINDING_FAILED_READ_RETRY_MS = 1000;
const DEFAULT_POLL_MS = 100;

/**
 * A malformed or unreadable file binds nothing (fail closed): a verifier then refuses every
 * container until a read succeeds — never keeps serving a previous version, which could still bind
 * a container that has since been stopped. A failed version is read again at most once per
 * `failedReadRetryMs`, so a transient read error heals by itself without a read on every request;
 * a new version is read at once.
 */
export function createHandleBindingReader(
  options: HandleBindingReaderOptions,
): HandleBindingReader {
  const { source } = options;
  const registrationWaitMs =
    options.registrationWaitMs ?? DEFAULT_HANDLE_BINDING_REGISTRATION_WAIT_MS;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const failedReadRetryMs =
    options.failedReadRetryMs ?? DEFAULT_HANDLE_BINDING_FAILED_READ_RETRY_MS;
  const now = options.now ?? (() => Date.now());
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const onError = options.onError ?? (() => {});

  let loadedVersion: string | undefined | null = null;
  /** When reading `loadedVersion` last failed; `undefined` once it was read (or is missing). */
  let failedAt: number | undefined;
  let bindings = new Map<string, HandleBinding>();

  /** Parses the current file into `bindings`, or returns why it could not. */
  function load(): HandleBindingFileError | undefined {
    let raw: string;
    try {
      raw = source.read();
    } catch (err) {
      return new HandleBindingFileError('unreadable', errnoCode(err));
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return new HandleBindingFileError('malformed');
    }
    const parsed = HandleBindingFileSchema.safeParse(json);
    if (!parsed.success) return new HandleBindingFileError('invalid');
    bindings = new Map(Object.entries(parsed.data));
    return undefined;
  }

  function refresh(): void {
    let version: string | undefined;
    try {
      version = source.version();
    } catch (err) {
      version = undefined;
      if (loadedVersion !== undefined)
        onError(new HandleBindingFileError('unreadable', errnoCode(err)));
    }
    const retry = version === loadedVersion;
    if (retry) {
      if (failedAt === undefined) return;
      const sinceFailure = now() - failedAt;
      // A clock stepped backwards retries at once rather than waiting for it to catch up.
      if (sinceFailure >= 0 && sinceFailure < failedReadRetryMs) return;
    }
    loadedVersion = version;
    failedAt = undefined;
    bindings = new Map();
    if (version === undefined) return;
    const error = load();
    if (!error) return;
    failedAt = now();
    if (!retry) onError(error);
  }

  return {
    async lookup(peerAddress, lookupOptions = {}) {
      const address = normalizePeerAddress(peerAddress);
      refresh();
      let binding = bindings.get(address);
      if (binding || !lookupOptions.waitForRegistration) return binding;
      const deadline = now() + registrationWaitMs;
      while (now() < deadline) {
        await sleep(pollMs);
        refresh();
        binding = bindings.get(address);
        if (binding) return binding;
      }
      return undefined;
    },
  };
}
