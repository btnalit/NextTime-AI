import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PoolLike } from '../../../adapters/db/pool.js';
import {
  type EgressObservationInput,
  type RecordEgressObservationsResult,
  recordEgressObservations,
} from '../../../application/host-bridge/index.js';

/**
 * interfaces/http/internal/egress: `POST /internal/egress` (design doc §7.9 "记录每个目标域名与
 * 字节数到该次 Activity 的 metadata", §7.10 `EgressObserved`; docs/development-tasks.md S1.10
 * kernel gap — `packages/egress-proxy/src/report.ts`'s `EgressReporter` already POSTs here, but
 * nothing on the kernel side received it until this task). Thin HTTP adapter — every actual
 * decision (parsing `sourceId`, finding the Turn to attribute to, the bounded `metadata.egress`
 * append, the `EgressObserved` outbox write) lives in `application/host-bridge/
 * egress-observations.ts`; see that module's doc comment for the full contract.
 *
 * Wire shape: copied field-for-field from egress-proxy's own `EgressObservation` interface
 * (`packages/egress-proxy/src/report.ts`) — the actual shape that package's `EgressReporter.flush`
 * POSTs (`{observations: EgressObservation[]}`), not `@nexttime/shared`'s `EgressObserved` domain
 * event (report.ts's own doc comment explains why those two deliberately differ: this proxy only
 * ever knows an opaque `sourceId`, never the `workspaceId`/`activityId` the domain event carries).
 * No package exports this shape for the kernel to import, so it is duplicated here as a zod
 * schema — keep the two in sync by hand if either changes.
 *
 * Trust boundary: same as `llm-usage.ts` and `handle-revocations.ts` — behind
 * `interfaces/internal-auth`'s shared-secret guard (installed once at the composition root, keyed
 * on the `/internal/` route prefix); this file performs no authentication of its own. See
 * llm-usage.ts's doc comment for why the earlier "control-network-only" assumption was retired.
 */

const EgressObservationWireSchema = z
  .object({
    type: z.literal('EgressObserved'),
    sourceId: z.string().min(1),
    clientIp: z.string().min(1),
    domain: z.string().min(1),
    port: z.number().int().nonnegative(),
    protocol: z.enum(['http', 'connect']),
    allowed: z.boolean(),
    reason: z.string().optional(),
    bytesUp: z.number().int().nonnegative(),
    bytesDown: z.number().int().nonnegative(),
    observedAt: z.string(),
  })
  .strict();

const EgressReportBodySchema = z
  .object({
    observations: z.array(EgressObservationWireSchema),
  })
  .strict();

/** Maps the wire shape's `bytesUp`/`bytesDown` (the proxy's own perspective: bytes sent *up* to
 *  the destination / received back *down* from it) to the entry container's perspective the
 *  application module and `metadata.egress` use (`bytesOut`/`bytesIn`) — `bytesUp` is bytes the
 *  container sent out, `bytesDown` is bytes it received back in. */
function toRecordInput(
  observation: z.infer<typeof EgressObservationWireSchema>,
): EgressObservationInput {
  return {
    sourceId: observation.sourceId,
    hostname: observation.domain,
    port: observation.port,
    bytesIn: observation.bytesDown,
    bytesOut: observation.bytesUp,
    allowed: observation.allowed,
    reason: observation.reason,
    at: observation.observedAt,
  };
}

export interface EgressRoutesDeps {
  readonly pool: PoolLike;
  /** Injectable for tests, so route-shape tests (validation, status codes) never touch Postgres.
   *  Defaults to the real `application/host-bridge`'s `recordEgressObservations`. */
  readonly recordEgressObservations?: (
    deps: { pool: PoolLike },
    observations: readonly EgressObservationInput[],
  ) => Promise<RecordEgressObservationsResult>;
}

export async function registerEgressRoutes(
  app: FastifyInstance,
  deps: EgressRoutesDeps,
): Promise<void> {
  const record = deps.recordEgressObservations ?? recordEgressObservations;

  app.post('/internal/egress', async (request, reply) => {
    const parsed = EgressReportBodySchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { ok: false, error: { code: 'invalid_body', message: parsed.error.message } };
    }

    try {
      const result = await record({ pool: deps.pool }, parsed.data.observations.map(toRecordInput));
      return { ok: true, result };
    } catch (err) {
      app.log?.error?.(err, 'egress: failed to record observation batch');
      reply.code(500);
      return {
        ok: false,
        error: { code: 'internal_error', message: 'failed to record egress observations' },
      };
    }
  });
}
