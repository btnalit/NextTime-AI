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
 * **All or nothing (R-70)**: `run.ts` submits this phase with an S5.2 observation window — "this is
 * this Source's complete view of KnowledgeBase / Document" — so the kernel retires every such Fact
 * this run did not re-observe. "Could not read" must therefore never look like "does not exist".
 * Every page of `kb.list`, and every page of every KnowledgeBase's `kb.documents`, is read
 * (`readAllPages`); anything short of that throws `RagflowReadError` (or the kernel client's own
 * error) — a non-zero RAGFlow `code` (RAGFlow reports its errors in a `200` body), a response not
 * shaped like the listing, a listing that changed while it was being read, one that never ends —
 * and `run.ts` then submits nothing for this phase and commits no window: the existing Facts stay
 * as they are until a later run reads everything.
 *
 * **Non-fatal**: unlike Docker (this collector's hard-required source), a RAGFlow Gatekeeper being
 * unreachable, unregistered, or erroring must not fail this collector's whole run — `run.ts`'s own
 * phase 4 wraps this module's entry point in a try/catch and logs a warning instead.
 */

/** Anything short of a complete read of the RAGFlow listings (R-70) — see this module's doc. */
export class RagflowReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RagflowReadError';
  }
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

interface RagflowEnvelope {
  readonly code: number;
  readonly data?: unknown;
  readonly message?: unknown;
}

/** Unwraps RAGFlow's own `{code, data}` envelope (`observe_operation`'s `data` field is this raw,
 *  untouched — `gatekeepers/ragflow/README.md`'s own documented limitation: "RAGFlow's own
 *  `{code, data}` error envelope is invisible to the protocol"). R-70: a non-zero `code`, or a
 *  response not even shaped like RAGFlow's envelope, throws — it is a failed read, not an empty one. */
function unwrapEnvelope(raw: unknown, what: string): RagflowEnvelope {
  if (!raw || typeof raw !== 'object' || typeof (raw as { code?: unknown }).code !== 'number') {
    throw new RagflowReadError(`ragflow: ${what}: unexpected observe_operation response shape`);
  }
  const envelope = raw as RagflowEnvelope;
  if (envelope.code !== 0) {
    const message = typeof envelope.message === 'string' ? envelope.message.slice(0, 200) : '';
    throw new RagflowReadError(
      `ragflow: ${what}: RAGFlow answered code ${envelope.code}${message ? ` (${message})` : ''}`,
    );
  }
  return envelope;
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

/** RAGFlow's current server answers at most 100 items per page on the document list and silently
 *  falls back to 10 for any larger `page_size` — the former single 1000-sized page therefore saw
 *  ten Documents per KnowledgeBase, and the window retired the rest (R-70). Used for both listings. */
const RAGFLOW_PAGE_SIZE = 100;
/** A listing still not ended after this many pages is a failed read (e.g. a server ignoring `page`). */
const MAX_PAGES = 1000;

interface ListingPage {
  readonly items: readonly unknown[];
  /** The listing's own total, when RAGFlow reports one. */
  readonly total: number | undefined;
}

/** RAGFlow's total for a listing: `total` (the document list), or `total_datasets` (the dataset
 *  list, and the document list as RAGFlow's own HTTP reference documents it). */
function reportedTotal(holder: unknown): number | undefined {
  if (!holder || typeof holder !== 'object') return undefined;
  const { total, total_datasets: totalDatasets } = holder as {
    total?: unknown;
    total_datasets?: unknown;
  };
  if (typeof total === 'number') return total;
  if (typeof totalDatasets === 'number') return totalDatasets;
  return undefined;
}

/**
 * R-70: reads one listing page by page (1-based) until it ends — an empty page, or, when RAGFlow
 * reports a total, once that many distinct items were read. Throws `RagflowReadError` unless the
 * read is complete and consistent:
 *   - an item that is not an object with a non-empty string `id` (nothing to key it by — and an
 *     item left out would be retired);
 *   - a total that differs between pages (the listing changed mid-read, so an offset page may have
 *     skipped an item) or from the number of distinct items read;
 *   - a page holding only items already read (paging not honoured), or no end after `MAX_PAGES`.
 */
async function readAllPages<T extends { readonly id: string }>(
  what: string,
  fetchPage: (page: number) => Promise<ListingPage>,
): Promise<T[]> {
  const byId = new Map<string, T>();
  let firstTotal: number | undefined;
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const { items, total } = await fetchPage(page);
    if (page === 1) {
      firstTotal = total;
    } else if (total !== firstTotal) {
      throw new RagflowReadError(`ragflow: ${what}: the listing changed while it was being read`);
    }
    let added = 0;
    for (const item of items) {
      const id =
        typeof item === 'object' && item !== null ? (item as { id?: unknown }).id : undefined;
      if (typeof id !== 'string' || id === '') {
        throw new RagflowReadError(`ragflow: ${what}: an item without an id on page ${page}`);
      }
      if (!byId.has(id)) {
        byId.set(id, item as T);
        added += 1;
      }
    }
    if (items.length === 0 || (total !== undefined && byId.size >= total)) {
      if (total !== undefined && byId.size !== total) {
        throw new RagflowReadError(
          `ragflow: ${what}: read ${byId.size} items, the listing reports ${total}`,
        );
      }
      return [...byId.values()];
    }
    if (added === 0) {
      throw new RagflowReadError(
        `ragflow: ${what}: page ${page} held only items already read — paging not honoured`,
      );
    }
  }
  throw new RagflowReadError(`ragflow: ${what}: no end after ${MAX_PAGES} pages`);
}

export interface CollectRagflowObservationsInput {
  readonly kernelClient: KernelClient;
  readonly gatekeeperId: string;
}

/** Calls `kb.list` then, per KnowledgeBase, `kb.documents` — both via `observe_operation`, every
 *  page of each (`readAllPages`) — and builds the resulting `IngestObservation[]`. Any failure — a
 *  thrown `KernelClientError` (network / kernel / gate) or a `RagflowReadError` — propagates to the
 *  caller and nothing is returned: `run.ts`'s phase 4 then skips this phase for this run, window
 *  included (this module's own doc comment). */
export async function collectRagflowObservations(
  input: CollectRagflowObservationsInput,
): Promise<IngestObservation[]> {
  const { kernelClient, gatekeeperId } = input;

  const knowledgeBases = await readAllPages<RawKnowledgeBase>('kb.list', async (page) => {
    const result = await kernelClient.observeOperation({
      gatekeeperId,
      operation: 'kb.list',
      params: { page, page_size: RAGFLOW_PAGE_SIZE },
    });
    const envelope = unwrapEnvelope(result.data, 'kb.list');
    if (!Array.isArray(envelope.data)) {
      throw new RagflowReadError('ragflow: kb.list: `data` is not a list');
    }
    return { items: envelope.data, total: reportedTotal(envelope) };
  });

  const withDocuments: KnowledgeBaseWithDocuments[] = [];
  for (const kb of knowledgeBases) {
    const what = `kb.documents ${kb.id}`;
    const documents = await readAllPages<RawDocument>(what, async (page) => {
      const result = await kernelClient.observeOperation({
        gatekeeperId,
        operation: 'kb.documents',
        params: { dataset_id: kb.id, page, page_size: RAGFLOW_PAGE_SIZE },
      });
      const envelope = unwrapEnvelope(result.data, what);
      const docs = (envelope.data as { docs?: unknown } | null | undefined)?.docs;
      if (!Array.isArray(docs)) {
        throw new RagflowReadError(`ragflow: ${what}: \`data.docs\` is not a list`);
      }
      return { items: docs, total: reportedTotal(envelope.data) };
    });
    withDocuments.push({ kb, documents });
  }

  return buildRagflowObservations({ gatekeeperId, knowledgeBases: withDocuments });
}
