import type { FastifyInstance } from 'fastify';
import type { PoolLike } from '../../../adapters/db/pool.js';
import { withWorkspace } from '../../../adapters/db/pool.js';
import { AnnounceBodySchema, upsertAnnouncement } from '../../../application/gates/index.js';

/**
 * interfaces/http/internal/gates: `POST /internal/gates/announce` (P-B1; docs/platform-admin-
 * design.md §6.3 "打包门自注册"). A gate container announces itself on start and then every
 * `GATE_ANNOUNCE_INTERVAL_SEC` as a heartbeat: stable `GATE_ID`, connector, transport kind, target,
 * its endpoint, its `describe_operations` manifest. Behind the internal-plane guard like every
 * `/internal/*` route (compose network + shared token; a Worker-subnet peer is refused).
 *
 * Never a credential: the body schema is `.strict()` and has no field for one; what a gate needs
 * to reach its system stays in the gate (design §7). The route runs on the admin client because a
 * gate is neither a user nor a Principal — the same shape `/internal/egress` uses; there is no
 * audit row (0019's actor-shape constraint needs a user for a platform row), the instance row's
 * `last_seen_at` / `updated_at` and the kernel log are the record.
 */

export interface GatesRoutesDeps {
  readonly pool: PoolLike;
}

const ADMIN_PLACEHOLDER = '00000000-0000-0000-0000-000000000000';

export async function registerGatesRoutes(
  app: FastifyInstance,
  deps: GatesRoutesDeps,
): Promise<void> {
  app.post('/internal/gates/announce', async (request, reply) => {
    const parsed = AnnounceBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        ok: false,
        error: {
          code: 'invalid_params',
          message: parsed.error.issues[0]?.message ?? 'invalid body',
        },
      });
    }
    const outcome = await withWorkspace(
      deps.pool,
      { workspaceId: ADMIN_PLACEHOLDER, principalId: ADMIN_PLACEHOLDER },
      (client) => upsertAnnouncement(client, parsed.data),
      { skipRoleSwitch: true },
    );
    if (outcome.created || outcome.endpointChanged) {
      request.log?.info?.(
        {
          gateId: outcome.gateId,
          connector: parsed.data.connector,
          status: outcome.status,
          created: outcome.created,
          endpointChanged: outcome.endpointChanged,
        },
        'gates/announce: gate instance recorded',
      );
    }
    return reply.status(200).send({
      ok: true,
      result: { gateId: outcome.gateId, status: outcome.status, created: outcome.created },
    });
  });
}
