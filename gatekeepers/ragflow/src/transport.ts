import {
  BindingKindMismatchError,
  HttpTransport,
  TransportInvokeError,
} from '@nexttime/gatekeeper-base';
import type {
  HttpTransportOptions,
  Transport,
  TransportInvokeContext,
  TransportInvokeResult,
} from '@nexttime/gatekeeper-base';
import type { Operation } from '@nexttime/shared';

/**
 * RagflowTransport (S3.4, docs/development-tasks.md "gatekeeper-ragflow 与本体 v2" deliverable 1:
 * "document.upload { kbId, name, content(base64 or text) }"). Wraps `@nexttime/gatekeeper-base`'s
 * `HttpTransport` for every Operation except `document.upload`, which this gate now binds to
 * RAGFlow's real `?type=local` upload (`multipart/form-data`, field `file` — verified against
 * RAGFlow's own HTTP API reference, https://ragflow.io/docs/http_api_reference, fetched 2026-09).
 *
 * `HttpTransport` only ever sends a JSON body (`@nexttime/gatekeeper-base`'s `kinds/http.ts` —
 * every non-path param goes through `JSON.stringify`), so it cannot express a multipart request —
 * the previous (S2.5) version of this gate's `document.upload` used RAGFlow's `?type=empty` mode
 * instead (a named placeholder Document with no file content) specifically to stay within that
 * limitation; see this package's README, "document.upload now sends real file content", for the
 * full history. This file is the "a custom Transport for this gate" escape hatch that README
 * always named as the fix — the same pattern `gatekeepers/docker/src/transport.ts` already
 * established (a hand-written `Transport` for the one thing the base package's kind cannot do),
 * applied narrowly to one Operation rather than the whole gate: every other Operation
 * (`kb.list`/`kb.documents`/`retrieve`/`document.parse`) delegates to an internal `HttpTransport`
 * instance unchanged — same TLS/timeout/credential options, same JSON-body behavior as before this
 * file existed.
 *
 * `content`/`encoding`: RAGFlow's multipart upload wants raw bytes, not a JSON string — this gate's
 * own `document.upload` params accept `content` as UTF-8 text (`encoding` omitted or `"utf8"`) or
 * base64 (`encoding: "base64"`), decoded into a `Buffer` here before building the multipart body.
 * Global `fetch`/`FormData`/`Blob` (no extra dependency) — this repo's own `engines.node` is
 * `>=22`, and `gatekeepers/ragflow/Dockerfile` builds on `node:24-bookworm-slim`.
 */

const DEFAULT_TIMEOUT_MS = 10_000;
const UPLOAD_OPERATION_NAME = 'document.upload';

export type RagflowTransportOptions = HttpTransportOptions;

/** Same `{token}` -> `Authorization: Bearer <token>` convention `kinds/http.ts`'s own (private,
 *  unexported) `credentialHeaders` implements for RAGFlow's bearer-token auth — this gate only ever
 *  resolves a credential via `SharedEnvCredentialResolver`, which always produces `{token}}` (see
 *  `src/index.ts`'s own doc comment), so the narrower re-implementation here (rather than importing
 *  a private helper) covers every credential shape this gate actually produces. */
function credentialAuthorizationHeader(credential: unknown): Record<string, string> {
  if (!credential || typeof credential !== 'object') return {};
  const token = (credential as Record<string, unknown>).token;
  return typeof token === 'string' ? { authorization: `Bearer ${token}` } : {};
}

function requireString(bag: Record<string, unknown>, key: string, operationName: string): string {
  const value = bag[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new TransportInvokeError(
      `ragflow transport: operation "${operationName}" requires a non-empty string param "${key}"`,
    );
  }
  return value;
}

/** Validates/decodes `content` per `encoding` (`"utf8"` default, or `"base64"`) — matches
 *  `manifest.json`'s own `document.upload.params_schema.encoding` enum; any other value is a
 *  params-schema violation the gate protocol should never let reach this far, guarded again here
 *  defensively since a manifest override (`GATE_MANIFEST_FILE`) could in principle loosen it. */
function decodeContent(bag: Record<string, unknown>, operationName: string): Buffer {
  const content = requireString(bag, 'content', operationName);
  const encoding = bag.encoding;
  if (encoding !== undefined && encoding !== 'utf8' && encoding !== 'base64') {
    throw new TransportInvokeError(
      `ragflow transport: operation "${operationName}" param "encoding" must be "utf8" or "base64" (got ${JSON.stringify(encoding)})`,
    );
  }
  return Buffer.from(content, (encoding as BufferEncoding | undefined) ?? 'utf8');
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

interface UploadRequest {
  readonly datasetId: string;
  readonly name: string;
  readonly bytes: Buffer;
}

function buildUploadRequest(operation: Operation, params: unknown): UploadRequest {
  if (operation.binding.kind !== 'http') {
    throw new BindingKindMismatchError(operation.name, 'http', operation.binding.kind);
  }
  const bag = (params ?? {}) as Record<string, unknown>;
  return {
    datasetId: requireString(bag, 'dataset_id', operation.name),
    name: requireString(bag, 'name', operation.name),
    bytes: decodeContent(bag, operation.name),
  };
}

export class RagflowTransport implements Transport {
  readonly kind = 'http' as const;
  private readonly inner: HttpTransport;
  private readonly options: RagflowTransportOptions;

  constructor(options: RagflowTransportOptions) {
    this.options = options;
    this.inner = new HttpTransport(options);
  }

  async invoke(
    operation: Operation,
    params: unknown,
    ctx: TransportInvokeContext,
  ): Promise<TransportInvokeResult> {
    if (operation.name !== UPLOAD_OPERATION_NAME) {
      return this.inner.invoke(operation, params, ctx);
    }

    const { datasetId, name, bytes } = buildUploadRequest(operation, params);
    const url = new URL(
      `/api/v1/datasets/${encodeURIComponent(datasetId)}/documents`,
      this.options.baseUrl,
    );
    url.searchParams.set('type', 'local');

    const form = new FormData();
    form.set('file', new Blob([bytes]), name);

    const fetchImpl = this.options.fetchImpl ?? fetch;
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: { ...credentialAuthorizationHeader(ctx.credential) },
        body: form,
        signal: controller.signal,
        // Same redirect policy as HttpTransport.invoke (kinds/http.ts) — never resend a credential
        // header to a 3xx-named host.
        redirect: 'error',
      });
      const text = await response.text();
      const data: unknown = text.length > 0 ? safeJsonParse(text) : undefined;
      if (!response.ok) {
        throw new TransportInvokeError(
          `ragflow transport: POST ${url.pathname} responded ${response.status}`,
        );
      }
      return { data };
    } catch (err) {
      if (err instanceof TransportInvokeError) throw err;
      throw new TransportInvokeError('ragflow transport: multipart upload request failed', {
        cause: err,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  async simulate(
    operation: Operation,
    params: unknown,
    ctx: TransportInvokeContext,
  ): Promise<{ description: string; detail?: unknown }> {
    if (operation.name !== UPLOAD_OPERATION_NAME) {
      if (this.inner.simulate) return this.inner.simulate(operation, params, ctx);
      return { description: `would ${operation.mode} "${operation.name}"` };
    }

    // No fetch here — a `simulate` call must never have a side effect (this task's own deliverable
    // 1: "the gate's simulate must describe uploads/parses without side effects"). Decoding
    // `content` only measures its byte length; it performs no IO.
    const { datasetId, name, bytes } = buildUploadRequest(operation, params);
    return {
      description: `would upload document "${name}" (${bytes.length} bytes) to dataset "${datasetId}" via multipart/form-data (type=local)`,
      detail: { datasetId, name, sizeBytes: bytes.length },
    };
  }
}
