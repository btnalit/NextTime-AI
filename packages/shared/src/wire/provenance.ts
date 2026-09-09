import { z } from 'zod';

/**
 * wire/provenance: the `export_prov` capability's PROV-JSON-style result shape (docs/wire-contract-
 * conventions.md §5, S3.5 "export_prov" — docs/development-tasks.md §S3.5 / design doc §9.5's
 * "只做这些" nine Explorer endpoints are a separate, Semantica-shaped surface;
 * `interfaces/explorer-contract` never imports this file — this is the capability registry's own
 * `channel:'human'` `export_prov` entry, dispatched through the ordinary `POST /api/cap/export_prov`
 * route like any other capability).
 *
 * W3C PROV-JSON (https://www.w3.org/Submission/prov-json/) models a provenance graph as a
 * `document` with typed record buckets keyed by a local id: `entity` / `activity` / `agent` for
 * nodes, and relation buckets (`wasGeneratedBy` / `used` / `wasAssociatedWith` / `wasAttributedTo`
 * / `wasDerivedFrom` / `actedOnBehalfOf` / `wasRevisionOf`) for edges — each relation record's own
 * fields point back at the two participant ids (`prov:entity`/`prov:activity`/`prov:agent`, the
 * standard's own attribute names) plus whatever descriptive attributes we have. This is "PROV-JSON
 * *style*" (the task's own wording) rather than a byte-exact implementation of the full submission
 * grammar (no bundles, no qualified names/namespaces beyond a flat `prefix` map) — it is built
 * entirely from `substrate/epistemic/explain.ts`'s `ExplainResult` chain (`application/gateway/
 * provenance-graph.ts`'s `buildProvJsonDocument`), which has no notion of RDF namespaces itself.
 */

const provAttributes = z.record(z.string(), z.unknown());

const provRecordBucket = z.record(z.string(), provAttributes);

export const ExportProvDocumentSchema = z
  .object({
    prefix: z.record(z.string(), z.string()),
    entity: provRecordBucket,
    activity: provRecordBucket,
    agent: provRecordBucket,
    wasGeneratedBy: provRecordBucket,
    used: provRecordBucket,
    wasAssociatedWith: provRecordBucket,
    wasAttributedTo: provRecordBucket,
    wasDerivedFrom: provRecordBucket,
    actedOnBehalfOf: provRecordBucket,
    wasRevisionOf: provRecordBucket,
  })
  .strict();
export type ExportProvDocument = z.infer<typeof ExportProvDocumentSchema>;

export const ExportProvResultSchema = z
  .object({
    format: z.literal('prov-json'),
    document: ExportProvDocumentSchema,
  })
  .strict();
export type ExportProvResult = z.infer<typeof ExportProvResultSchema>;
