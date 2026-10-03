import type { FastifyInstance } from 'fastify';
import type { PoolLike } from '../../../adapters/db/pool.js';
import { withWorkspace } from '../../../adapters/db/pool.js';
import {
  AnnounceBodySchema,
  listHostedGateDefinitions,
  upsertAnnouncement,
} from '../../../application/gates/index.js';

/**
 * interfaces/http/internal/gates: `POST /internal/gates/announce` (P-B1; docs/platform-admin-
 * design.md §6.3 "打包门自注册"). A gate container announces itself on start and then every
 * `GATE_ANNOUNCE_INTERVAL_SEC` as a heartbeat: stable `GATE_ID`, connector, transport kind, target,
 * its endpoint, its `describe_operations` manifest. Behind the internal-plane guard like every
 * `/internal/*` route (a Worker-subnet peer is refused), which admits two caller classes here —
 * the packaged gates' shared credential (`gate`) and the gate host's own (`gate-host`). Each may
 * announce only its own kind of instance (R-03 review, D-02): a packaged gate never a gate-host
 * (`hosted`) instance, the gate host never anything else — refused 403, nothing written.
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
    const announcer = request.internalCaller;
    if (announcer !== 'gate' && announcer !== 'gate-host') {
      // Unreachable behind the guard (INTERNAL_ROUTE_CALLERS admits only these two here) — fail
      // closed with the guard's own 401 rather than announce as an unknown class.
      return reply
        .status(401)
        .send({ ok: false, error: { code: 'unauthorized', message: 'unauthorized' } });
    }
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
      (client) => upsertAnnouncement(client, parsed.data, announcer),
      { skipRoleSwitch: true },
    );
    if (outcome.announcerMismatch) {
      request.log?.warn?.(
        { gateId: outcome.gateId, caller: announcer },
        'gates/announce: the caller class does not own this instance (packaged gate on a gate-host instance, or gate host on a non-hosted one) — refused',
      );
      return reply.status(403).send({
        ok: false,
        error: {
          code: 'forbidden',
          message:
            announcer === 'gate'
              ? 'a packaged gate cannot announce a gate-host instance'
              : 'the gate host announces only the instances an administrator created for it',
        },
      });
    }
    if (outcome.rejected) {
      request.log?.warn?.(
        { gateId: outcome.gateId, announcedConnector: parsed.data.connector },
        'gates/announce: first announcement for a gate-host instance does not match its definition — refused',
      );
      return reply.status(409).send({
        ok: false,
        error: {
          code: 'identity_mismatch',
          message: 'announced connector / transport kind differ from the instance definition',
        },
      });
    }
    if (outcome.identityMismatch) {
      request.log?.warn?.(
        {
          gateId: outcome.gateId,
          announcedConnector: parsed.data.connector,
          announcedEndpoint: parsed.data.endpoint,
          status: outcome.status,
        },
        'gates/announce: announcement for a decided instance carries a different identity — stored connector / endpoint / manifest / target kept, health set to unknown',
      );
    } else if (outcome.created) {
      request.log?.info?.(
        { gateId: outcome.gateId, connector: parsed.data.connector, status: outcome.status },
        'gates/announce: new gate instance discovered',
      );
    } else if (outcome.manifestHeld) {
      request.log?.info?.(
        { gateId: outcome.gateId, status: outcome.status },
        'gates/announce: the announced manifest changes what this decided instance can do — held for an administrator to confirm (confirm_gate_manifest); the manifest in effect is unchanged',
      );
    }
    return reply.status(200).send({
      ok: true,
      result: { gateId: outcome.gateId, status: outcome.status, created: outcome.created },
    });
  });

  // P-B2a (决定 ⑥): the generic gate host pulls the instances it must serve — the same trust
  // direction as announce (internal token, gate → kernel), so no kernel → host credential exists.
  // Definitions only (transport kind, target, credential mode, manifest source); never a credential.
  app.get('/internal/gate-host/instances', async (_request, reply) => {
    const items = await withWorkspace(
      deps.pool,
      { workspaceId: ADMIN_PLACEHOLDER, principalId: ADMIN_PLACEHOLDER },
      (client) => listHostedGateDefinitions(client),
      { skipRoleSwitch: true },
    );
    return reply.status(200).send({ ok: true, result: { items } });
  });
}
