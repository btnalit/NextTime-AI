import { UnstorableTextError } from '@nexttime/shared';
import type { FastifyInstance } from 'fastify';
import type { PoolLike } from '../../../adapters/db/pool.js';
import { withWorkspace } from '../../../adapters/db/pool.js';
import {
  type AnnounceBody,
  AnnounceBodySchema,
  type ConnectorFitRefusal,
  listHostedGateDefinitions,
  loadConnectorPresets,
  storableAnnouncement,
  upsertAnnouncement,
  withPresetOperations,
} from '../../../application/gates/index.js';
import {
  OperationNameInvalidError,
  OperationTargetInvalidError,
} from '../../../governance/gatekeepers/index.js';

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
 * to reach its system stays in the gate (design §7). A `target` or `endpoint` carrying one is
 * refused 400 `credentials_in_connection_params` with nothing written, unless the instance already
 * holds exactly that value (review of #549 — `upsertAnnouncement`). A connector that cannot hold the
 * instance — another transport kind, or the wrong class for the caller (P1, review of #644) — is
 * refused 409 with its code (`connector_kind_mismatch` / `connector_not_packaged`), nothing written.
 * The route runs on the admin client because a gate is neither a user nor a Principal — the same
 * shape `/internal/egress` uses; there is no audit row (0019's actor-shape constraint needs a user
 * for a platform row), the instance row's `last_seen_at` / `updated_at` and the kernel log are the
 * record.
 */

function connectorRefusedMessage(
  code: ConnectorFitRefusal,
  connector: string,
  transportKind: string,
): string {
  switch (code) {
    case 'connector_kind_mismatch':
      return `the connector "${connector}" is not a ${transportKind} connector — announce one of this gate's own kind`;
    case 'connector_not_packaged':
      return `the connector "${connector}" is not a packaged gate's (a generic connector, or one created for gate-host instances) — set GATE_CONNECTOR to a name of this system's own`;
    case 'connector_packaged':
      return `the connector "${connector}" belongs to a packaged gate`;
  }
}

export interface GatesRoutesDeps {
  readonly pool: PoolLike;
}

const ADMIN_PLACEHOLDER = '00000000-0000-0000-0000-000000000000';

/** The `name` of the Operation at `at` (`['operations', i]`) in an announcement body as sent. */
function operationNameAt(body: unknown, at: readonly PropertyKey[]): unknown {
  let value: unknown = body;
  for (const key of at) {
    if (value === null || typeof value !== 'object') return undefined;
    value = (value as Record<PropertyKey, unknown>)[key];
  }
  return value !== null && typeof value === 'object'
    ? (value as { readonly name?: unknown }).name
    : undefined;
}

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
      // S11 GO12 (I-Q4): an Operation whose `target` declaration is refused answers with its own
      // code and reason, as an import of it would; any other issue keeps `invalid_params`.
      const refused = OperationTargetInvalidError.fromIssues(parsed.error.issues, (at) =>
        operationNameAt(request.body, at),
      );
      if (refused) {
        return reply.status(400).send({
          ok: false,
          error: { code: refused.code, message: refused.message, details: refused.details },
        });
      }
      return reply.status(400).send({
        ok: false,
        error: {
          code: 'invalid_params',
          message: parsed.error.issues[0]?.message ?? 'invalid body',
        },
      });
    }
    let announcement: AnnounceBody;
    try {
      announcement = storableAnnouncement(parsed.data);
    } catch (err) {
      if (
        !(
          err instanceof UnstorableTextError ||
          err instanceof OperationNameInvalidError ||
          err instanceof OperationTargetInvalidError
        )
      ) {
        throw err;
      }
      // Legacy 320: U+0000 in a field the kernel acts on — refused with where, nothing written.
      request.log?.warn?.(
        { gateId: parsed.data.gateId, caller: announcer, code: err.code },
        `gates/announce: ${err.message}`,
      );
      return reply.status(400).send({
        ok: false,
        error: { code: err.code, message: err.message, details: err.details },
      });
    }
    const outcome = await withWorkspace(
      deps.pool,
      { workspaceId: ADMIN_PLACEHOLDER, principalId: ADMIN_PLACEHOLDER },
      (client) => upsertAnnouncement(client, announcement, announcer),
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
    if (outcome.credentialRefused) {
      // Review of #549 (legacy 186): the field only — the value is a credential.
      request.log?.warn?.(
        { gateId: outcome.gateId, caller: announcer, field: outcome.credentialRefused.field },
        'gates/announce: the announced address carries a credential — refused, nothing written; give the gate its credential through its own configuration and announce the plain address',
      );
      return reply.status(400).send({
        ok: false,
        error: {
          code: 'credentials_in_connection_params',
          message: `the announced ${outcome.credentialRefused.field} carries a credential — refused, nothing was stored; announce the plain address and keep the credential in the gate's own configuration`,
          details: { field: outcome.credentialRefused.field },
        },
      });
    }
    if (outcome.rejected) {
      request.log?.warn?.(
        { gateId: outcome.gateId, announcedConnector: parsed.data.connector },
        'gates/announce: announcement for an undecided gate-host instance does not match its definition (connector / transport kind) — refused',
      );
      return reply.status(409).send({
        ok: false,
        error: {
          code: 'identity_mismatch',
          message: 'announced connector / transport kind differ from the instance definition',
        },
      });
    }
    if (outcome.connectorRefused) {
      // P1 (review of #644): the announced connector cannot hold this instance (`fitConnector`).
      request.log?.warn?.(
        {
          gateId: outcome.gateId,
          caller: announcer,
          announcedConnector: parsed.data.connector,
          code: outcome.connectorRefused,
        },
        'gates/announce: the announced connector cannot hold this instance — refused, nothing written',
      );
      return reply.status(409).send({
        ok: false,
        error: {
          code: outcome.connectorRefused,
          message: connectorRefusedMessage(
            outcome.connectorRefused,
            parsed.data.connector,
            parsed.data.transportKind,
          ),
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
  // Definitions only (transport kind, target, credential mode, manifest source) and the connector
  // each instance announces (P1); never a credential. S11 P1-F: an instance made from a connector
  // preset also carries the preset's Operations (`withPresetOperations`). Presets that cannot be
  // read fail the whole pull: the host then keeps every instance as it is and retries, instead of
  // rebuilding preset instances from nothing.
  app.get('/internal/gate-host/instances', async (_request, reply) => {
    const items = await withWorkspace(
      deps.pool,
      { workspaceId: ADMIN_PLACEHOLDER, principalId: ADMIN_PLACEHOLDER },
      (client) => listHostedGateDefinitions(client),
      { skipRoleSwitch: true },
    );
    const presets = items.some((item) => item.definition.preset !== undefined)
      ? await loadConnectorPresets()
      : [];
    return reply
      .status(200)
      .send({ ok: true, result: { items: withPresetOperations(items, presets) } });
  });
}
