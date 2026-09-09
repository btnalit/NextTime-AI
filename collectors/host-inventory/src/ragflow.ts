import type { KernelClient } from './kernel-client.js';
import type { IngestObservation } from './types.js';

/**
 * ragflow: optional S3.4 extension to this collector — when `config.ragflowGatekeeperId` is set
 * (`config.ts`'s own doc comment), calls the kernel's `observe_operation` capability for a RAGFlow
 * Gatekeeper's `kb.list`/`kb.documents` Operations and turns the result into
 * `ontology/ops-assets-v2.yaml`'s fully-scoped `KnowledgeBase`/`Document` Observations —
 * `identity: {gatekeeperId, kbId}` / `{gatekeeperId, kbId, documentId}`, plus `served_by`/`part_of`
 * links — submitted through the normal `submit_observations` path, same as every other domain this
 * collector observes.
 *
 * **Why `observe_operation`, not `request_action`**: both Operations are `mode: 'observe'`
 * (`gatekeepers/ragflow/manifest.json`) — pure reads, nothing to approve — and `observe_operation`
 * is exactly the capability built for that case (no ActionRequest, no policy engine, S2.12; see
 * `packages/kernel/src/application/gateway/request-action-handler.ts`'s own doc comment on
 * `observeOperationHandler`). This collector's own Handle must hold `observe_operation` in its
 * capability scope (`docs/runbooks/host-collector.md`).
 *
 * **Two independent write paths, by design — not deduplicated here**: every `observe_operation`
 * call *also*, unconditionally, writes its own low-fidelity `{id: <raw id>}`-identified
 * KnowledgeBase/Document facts via the gate's own `result_mapping`
 * (`request-action-handler.ts`'s `runObserve` -> `writeObservedFacts`), attributed to the shared
 * Gatekeeper service Principal — this collector cannot suppress that, and does not try to. This
 * module's own `submit_observations` call is the *second*, independent write: the fully-scoped
 * identity/links this file builds. `ontology/ops-assets-v2.yaml`'s own header comment has the full
 * reasoning for why this is an accepted, precedented shape (the same duality already exists for
 * `gatekeepers/docker`'s `Container`-typed observe facts against this collector's own
 * differently-scoped `Container` Observations).
 *
 * **No pagination loop**: `kb.list`/`kb.documents` both accept RAGFlow's own `page`/`page_size`
 * params; this module calls each once with a generously-sized `page_size`
 * (`DEFAULT_PAGE_SIZE`) rather than looping pages — a known, documented limitation (README /
 * `docs/runbooks/host-collector.md`), not a silent gap: a workspace with more KnowledgeBases or
 * Documents than one page holds gets a partial observation, not a crash.
 *
 * **Non-fatal**: unlike Docker (this collector's hard-required source), a RAGFlow Gatekeeper being
 * unreachable, unregistered, or erroring must not fail this collector's whole run — `run.ts`'s own
 * phase 4 wraps this module's entry point in a try/catch and logs a warning instead. Within one
 * successful `kb.list`, a single KnowledgeBase's `kb.documents` call failing degrades to "that
 * KnowledgeBase, zero Documents" rather than dropping the whole run.
 */

export interface RagflowLogger {
  warn(message: string, detail?: Record<string, unknown>): void;
}

// Raw RAGFlow response shapes — verified against `gatekeepers/ragflow/manifest.json`'s own
// `result_mapping` (the same fields that manifest's own JMESPath attributes pull out), duplicated
// here rather than imported for the same reason `types.ts`'s own doc comment gives for
// `IngestObservation`: this collector is an external HTTP client of the kernel, not a workspace
// dependent of the gate package.
interface RawKnowledgeBase {
  readonly id: string;
  readonly name?: string;
  readonly chunk_count?: number;
  readonly document_count?: number;
  readonly embedding_model?: string;
  readonly chunk_method?: string;
}

interface RawDocument {
  readonly id: string;
  readonly name?: string;
  readonly size?: number;
  readonly run?: string;
  readonly chunk_count?: number;
}

interface RagflowEnvelope<T> {
  readonly code: number;
  readonly data?: T;
  readonly message?: string;
}

/** Unwraps RAGFlow's own `{code, data}` envelope (`observe_operation`'s `data` field is this raw,
 *  untouched — `gatekeepers/ragflow/README.md`'s own documented limitation: "RAGFlow's own
 *  `{code, data}` error envelope is invisible to the protocol"). A non-zero `code`, or a response
 *  that is not even shaped like RAGFlow's envelope, logs a warning and yields `undefined` — the
 *  caller treats that the same as "nothing observed", never a thrown error. */
function unwrapEnvelope<T>(raw: unknown, operation: string, logger: RagflowLogger): T | undefined {
  if (!raw || typeof raw !== 'object' || typeof (raw as { code?: unknown }).code !== 'number') {
    logger.warn('ragflow: unexpected observe_operation response shape', { operation });
    return undefined;
  }
  const envelope = raw as RagflowEnvelope<T>;
  if (envelope.code !== 0) {
    logger.warn('ragflow: operation returned a non-zero RAGFlow code', {
      operation,
      code: envelope.code,
      message: envelope.message,
    });
    return undefined;
  }
  return envelope.data;
}

interface KnowledgeBaseWithDocuments {
  readonly kb: RawKnowledgeBase;
  readonly documents: readonly RawDocument[];
}

export interface BuildRagflowObservationsInput {
  readonly gatekeeperId: string;
  readonly knowledgeBases: readonly KnowledgeBaseWithDocuments[];
}

/** Pure — turns already-fetched RAGFlow data into `IngestObservation[]` (no IO), same split
 *  `observation-builder.ts` uses for the Docker/systemd/git domain: a builder function fully
 *  unit-testable without a network or a fake kernel client, orchestrated by `collectRagflowObservations`
 *  below. */
export function buildRagflowObservations(
  input: BuildRagflowObservationsInput,
): IngestObservation[] {
  const observations: IngestObservation[] = [];
  const gatekeeperTarget = {
    objectType: 'Gatekeeper',
    identity: { gatekeeperId: input.gatekeeperId },
  };

  for (const { kb, documents } of input.knowledgeBases) {
    if (!kb.id) continue; // KnowledgeBase identityKey = [gatekeeperId, kbId] — nothing to key an id-less entry by.
    const kbIdentity = { gatekeeperId: input.gatekeeperId, kbId: kb.id };

    observations.push({
      objectType: 'KnowledgeBase',
      identity: kbIdentity,
      properties: {
        name: kb.name,
        chunkCount: kb.chunk_count,
        documentCount: kb.document_count,
        embeddingModel: kb.embedding_model,
        chunkMethod: kb.chunk_method,
      },
      links: [{ linkType: 'served_by', target: gatekeeperTarget }],
    });

    for (const doc of documents) {
      if (!doc.id) continue; // Document identityKey's third component — same reasoning as KnowledgeBase.id above.
      observations.push({
        objectType: 'Document',
        identity: { ...kbIdentity, documentId: doc.id },
        properties: {
          name: doc.name,
          size: doc.size,
          run: doc.run,
          chunkCount: doc.chunk_count,
        },
        links: [
          { linkType: 'part_of', target: { objectType: 'KnowledgeBase', identity: kbIdentity } },
        ],
      });
    }
  }

  return observations;
}

/** One generously-sized page rather than a pagination loop — see this module's own doc comment. */
const DEFAULT_PAGE_SIZE = 1000;

export interface CollectRagflowObservationsInput {
  readonly kernelClient: KernelClient;
  readonly gatekeeperId: string;
  readonly logger: RagflowLogger;
}

/** Calls `kb.list` then, per KnowledgeBase, `kb.documents` — both via `observe_operation` — and
 *  builds the resulting `IngestObservation[]`. Lets a `kb.list` failure (network/kernel/gate error,
 *  a thrown `KernelClientError`) propagate to the caller (`run.ts`'s phase 4 wraps this whole call
 *  and treats any failure as "skip the RAGFlow phase this run" — this module's own doc comment); a
 *  per-KnowledgeBase `kb.documents` failure degrades to zero Documents for that one KnowledgeBase
 *  instead of failing the whole call. */
export async function collectRagflowObservations(
  input: CollectRagflowObservationsInput,
): Promise<IngestObservation[]> {
  const { kernelClient, gatekeeperId, logger } = input;

  const kbListResult = await kernelClient.observeOperation({
    gatekeeperId,
    operation: 'kb.list',
    params: { page_size: DEFAULT_PAGE_SIZE },
  });
  const knowledgeBases =
    unwrapEnvelope<RawKnowledgeBase[]>(kbListResult.data, 'kb.list', logger) ?? [];

  const withDocuments: KnowledgeBaseWithDocuments[] = [];
  for (const kb of knowledgeBases) {
    if (!kb.id) continue;
    try {
      const docsResult = await kernelClient.observeOperation({
        gatekeeperId,
        operation: 'kb.documents',
        params: { dataset_id: kb.id, page_size: DEFAULT_PAGE_SIZE },
      });
      const docsData = unwrapEnvelope<{ docs?: RawDocument[] }>(
        docsResult.data,
        'kb.documents',
        logger,
      );
      withDocuments.push({ kb, documents: docsData?.docs ?? [] });
    } catch (err) {
      logger.warn(
        'ragflow: kb.documents failed for one KnowledgeBase — keeping the KnowledgeBase, no Documents for it this run',
        { kbId: kb.id, error: err instanceof Error ? err.message : String(err) },
      );
      withDocuments.push({ kb, documents: [] });
    }
  }

  return buildRagflowObservations({ gatekeeperId, knowledgeBases: withDocuments });
}
