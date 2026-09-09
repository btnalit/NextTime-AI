import { z } from 'zod';

/**
 * wire/ingest: `register_source` / `submit_observations` result shapes (design doc §5.1.3 Source/
 * Observation/Fact model, §7.8 采集器; docs/development-tasks.md S3.3). Distinct file from
 * `wire/graph.ts` — Source/ingest-batch-summary are a different resource family from
 * Object/Fact/AuditRecord/Explain, matching this directory's existing one-file-per-capability-
 * group convention (`connection.ts`, `governance.ts`, `task.ts`, …).
 */

/**
 * `register_source`'s result (docs/wire-contract-conventions.md §2 "创建类 capability 的结果 = 被
 * 创建的资源对象"). `sources` (migrations/core/0002_substrate.sql) has no `name` column of its own
 * — `application/gateway/ingest-handlers.ts`'s `registerSourceHandler` folds the caller's `name`
 * into `metadata.name` on write and projects it back out to this top-level field on read (see that
 * handler's own doc comment for why: adding a column would mean a migration this task's file
 * ownership does not include touching `substrate/epistemic/**`'s owning module to consume, and
 * `metadata` is already the table's designated free-form bag for exactly this kind of caller-
 * supplied label). `name` is therefore `nullable`, not required, on the wire shape — a Source
 * without a `metadata.name` (e.g. one written by a caller that never used this projection) still
 * satisfies it.
 */
export const SourceWireSchema = z
  .object({
    id: z.string(),
    kind: z.string(),
    name: z.string().nullable(),
    ownerPrincipalId: z.string(),
    visibility: z.enum(['workspace', 'private']),
    uri: z.string().nullable(),
    metadata: z.record(z.string(), z.unknown()),
    createdAt: z.string(),
  })
  .strict();
export type SourceWire = z.infer<typeof SourceWireSchema>;

/**
 * `submit_observations`'s result — a batch summary, not a single created resource (same shape
 * family as `wire/connection.ts`'s `PublishManifestResultWireSchema`: a bulk-write capability
 * reports what it did, not one resource object). `activityId` is a reference to the (new or
 * caller-supplied) Activity every Fact in this submission traces to (I3).
 *
 * `objects` — additive beyond the task dispatch's own literal `{activityId, objectsUpserted,
 * factsAsserted, factsSuperseded}` shape, one entry per distinct `(objectType, identity)` this
 * submission touched, carrying back the graph id `upsertObject` resolved it to. This exists to
 * close a real dependency-ordering need in ops-assets-v1's own identity scheme
 * (`ontology/ops-assets-v1.yaml`'s header comment: "a property named `<Type>Id`... holds *another
 * Object's own graph id*") — e.g. a ComposeProject's identity is `{hostId, projectName}`, where
 * `hostId` must be the Host Object's real `objects.id`, not a value the caller can invent ahead of
 * time. A caller (a collector) submits in dependency order across multiple calls that all share
 * one `activityId` (the second/third call passing back the `activityId` the first call returned —
 * see this capability's own `activityId?` param doc comment), reading each call's `objects` back to
 * learn the real ids it needs to construct the next layer's identity. `collectors/host-inventory`'s
 * own README documents the concrete phase order it submits in.
 */
export const SubmitObservationsResultWireSchema = z
  .object({
    activityId: z.string(),
    objectsUpserted: z.number().int().nonnegative(),
    factsAsserted: z.number().int().nonnegative(),
    factsSuperseded: z.number().int().nonnegative(),
    objects: z.array(
      z
        .object({
          objectType: z.string(),
          identity: z.record(z.string(), z.unknown()),
          id: z.string(),
        })
        .strict(),
    ),
  })
  .strict();
export type SubmitObservationsResultWire = z.infer<typeof SubmitObservationsResultWireSchema>;
