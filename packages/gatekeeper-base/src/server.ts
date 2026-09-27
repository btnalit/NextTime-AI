import {
  CORRELATION_ID_HEADER,
  PROMETHEUS_TEXT_CONTENT_TYPE,
  resolveCorrelationId,
} from '@nexttime/shared';
import Fastify, { type FastifyInstance, type FastifyRequest, LogController } from 'fastify';
import type { ConnectedAccountStore } from './credentials/index.js';
import {
  ApplyRequiresIdempotencyKeyError,
  ConnectedAccountStoreNotConfiguredError,
  CredentialResolutionError,
  IdempotencyConflictError,
  OperationModeMismatchError,
  OperationNotFoundError,
  ParamsSchemaInvalidError,
  ParamsValidationError,
  RevertNotSupportedError,
  TransportInvokeError,
} from './errors.js';
import { registerGateAuthGuard } from './gate-auth.js';
import type { GatekeeperBase } from './gatekeeper-base.js';
import { type GateMetrics, createGateMetrics } from './metrics.js';
import {
  ApplyRequestSchema,
  DeleteConnectedAccountRequestSchema,
  DescribeOperationsResponseSchema,
  ObserveRequestSchema,
  RevertRequestSchema,
  SimulateRequestSchema,
  StoreConnectedAccountRequestSchema,
} from './protocol.js';

/**
 * The Fastify HTTP server exposing `GatekeeperBase`'s protocol under `/gate/<op>` (design doc
 * §5.1.4/§7.5, task brief deliverable A). `GET /gate/describe_operations`, `GET /gate/health`;
 * `POST /gate/observe`, `POST /gate/simulate`, `POST /gate/apply`, `POST /gate/revert`.
 *
 * Response envelope matches the kernel's own convention (`packages/shared/src/http.ts`):
 * `{ok:true,result}` / `{ok:false,error:{code,message}}` — the kernel's
 * `adapters/gatekeeper-client` (S2.4 deliverable B) parses this shape, never branching on HTTP
 * status alone.
 *
 * Every route is guarded by `gate-auth.ts`'s shared-secret check (review lane 5, P1-1) — a request
 * without a valid `Authorization: Bearer <token>` header gets 401 `{ok:false,error:{code:
 * 'unauthorized',message:'unauthorized'}}` before it ever reaches `gate`.
 *
 * S2.13 addition: `POST`/`DELETE /gate/connected-accounts` — the write-only ConnectedAccount
 * store endpoint the design brief asked this file to grow ("does the gate expose any HTTP
 * endpoint to *store* a ConnectedAccount? If not, add one"). Deliberately **no `GET`** — a
 * credential that entered a gate's `ConnectedAccountStore` (`credentials/connected-account.ts`)
 * must never be readable back out over the wire again (design doc §11 "凭证只在门"; I9). Only
 * present when `options.connectedAccountStore` is given — a gate started in shared-credential mode
 * (`credentials/shared-env.ts`) has nowhere to write one, and both routes 501
 * (`ConnectedAccountStoreNotConfiguredError`) rather than silently accepting and discarding a
 * credential.
 */

interface ErrorMapping {
  readonly status: number;
  readonly code: string;
  readonly message: string;
}

export function mapGatekeeperError(err: unknown): ErrorMapping {
  if (err instanceof OperationNotFoundError) {
    return { status: 404, code: 'operation_not_found', message: err.message };
  }
  if (
    err instanceof ParamsValidationError ||
    err instanceof OperationModeMismatchError ||
    err instanceof ApplyRequiresIdempotencyKeyError
  ) {
    return { status: 400, code: 'invalid_params', message: err.message };
  }
  if (err instanceof ParamsSchemaInvalidError) {
    return { status: 400, code: 'invalid_operation_schema', message: err.message };
  }
  if (err instanceof IdempotencyConflictError) {
    return { status: 409, code: 'idempotency_conflict', message: err.message };
  }
  if (err instanceof CredentialResolutionError) {
    return { status: 424, code: 'credential_unavailable', message: err.message };
  }
  if (err instanceof RevertNotSupportedError) {
    return { status: 400, code: 'revert_not_supported', message: err.message };
  }
  if (err instanceof TransportInvokeError) {
    return { status: 502, code: 'transport_error', message: err.message };
  }
  if (err instanceof ConnectedAccountStoreNotConfiguredError) {
    return { status: 501, code: 'connected_account_store_not_configured', message: err.message };
  }
  // A Zod .safeParse failure on the request envelope itself, before it ever reaches
  // GatekeeperBase — same 400/invalid_params shape as a params_schema failure, since a caller
  // can't distinguish the two usefully from the wire response alone.
  return { status: 500, code: 'internal_error', message: 'internal error' };
}

export interface CreateGatekeeperServerOptions {
  readonly gate: GatekeeperBase;
  readonly logger?: boolean;
  /** S2.13: enables `POST`/`DELETE /gate/connected-accounts` — omit for a gate running in
   *  shared-credential mode (this module's own doc comment). */
  readonly connectedAccountStore?: ConnectedAccountStore;
  /** The shared secret every `/gate/*` request must present as `Authorization: Bearer <token>`
   *  (review lane 5, P1-1; `gate-auth.ts`). Required — every caller of this function loads one via
   *  `gate-auth.ts`'s `loadGateKernelToken` (or a fixed value in tests) before constructing the
   *  server, so a gate can never come up without the guard installed. */
  readonly token: string;
}

/** What one `/gate/*` request operates on. `forcedOnBehalfOf` (host mode, 决定 ⑩): the credential
 *  slot a verified platform token allows — the connected-account routes then ignore the body's
 *  `onBehalfOf` and write exactly that slot. */
export interface GateRouteContext {
  readonly gate: GatekeeperBase;
  readonly connectedAccountStore?: ConnectedAccountStore;
  readonly forcedOnBehalfOf?: string;
}

/** The fields of one `/gate/*` call's log line (leftover 87). */
export interface GateCallLogFields {
  readonly gateRoute: string;
  readonly operation: string;
  readonly gateId?: string;
  readonly status: number;
  readonly durationMs: number;
}

export interface RegisterGateRoutesOptions {
  /** Route prefix, `''` for a single-gate server, `'/i/:gateId'` for the gate host (决定 ⑫). */
  readonly prefix: string;
  /** Picks the gate for a request; `undefined` → 404 `gate_not_found`. */
  readonly resolve: (request: FastifyRequest) => GateRouteContext | undefined;
  /** Leftover 87: one sample per `/gate/*` call (metrics.ts); omitted → not counted. */
  readonly metrics?: GateMetrics;
  /** Leftover 87: writes one line per `/gate/*` call. Default: `request.log.info(fields)` — the
   *  request logger already carries the call's `correlationId` (Fastify's request id, set from
   *  the kernel's `x-correlation-id`). The gate host, whose Fastify logger is off, passes its own. */
  readonly logCall?: (request: FastifyRequest, fields: GateCallLogFields) => void;
}

/** Leftover 87: `genReqId` for every gate Fastify instance — the request id *is* the correlation
 *  id: the kernel's `x-correlation-id` when valid, else a minted one. */
export function gateRequestId(req: {
  headers: Record<string, string | string[] | undefined>;
}): string {
  return resolveCorrelationId(req.headers[CORRELATION_ID_HEADER]);
}

/**
 * The `/gate/*` protocol routes, registered once under `prefix`. `createGatekeeperServer` below
 * (single gate, `prefix ''`, `resolve` always the one gate) keeps its pre-P-B2a behaviour; the gate
 * host registers the same routes once under `/i/:gateId` and resolves per request from its
 * in-memory table — Fastify cannot add routes after `listen`, and the host adds and removes
 * instances while running.
 */
export function registerGateRoutes(app: FastifyInstance, options: RegisterGateRoutesOptions): void {
  const { prefix, resolve } = options;
  const logCall =
    options.logCall ??
    ((request: FastifyRequest, fields: GateCallLogFields) => request.log.info(fields, 'gate call'));

  // Leftover 87: one metrics sample and one log line per `/gate/*` call, after the response —
  // the operation label only when this gate actually publishes that Operation, the gate label
  // only when the path names an instance this host actually serves (bounded labels: an
  // unauthenticated `/i/<anything>/gate/…` must not mint a new series per request).
  const gateRoutePrefix = `${prefix}/gate/`;
  app.addHook('onResponse', (request, reply, done) => {
    const url = request.routeOptions.url;
    if (typeof url === 'string' && url.startsWith(gateRoutePrefix)) {
      const gateRoute = url.slice(gateRoutePrefix.length);
      const requested = (request.body as { operation?: unknown } | undefined)?.operation;
      const resolved = resolve(request);
      const gate = resolved?.gate;
      const operation =
        typeof requested === 'string' &&
        gate?.describeOperations().some((o) => o.name === requested)
          ? requested
          : '';
      const gateId = resolved
        ? (request.params as { gateId?: string } | undefined)?.gateId
        : undefined;
      options.metrics?.recordCall({
        gate: gateId ?? '',
        route: gateRoute,
        operation,
        status: reply.statusCode,
        durationSeconds: reply.elapsedTime / 1000,
      });
      logCall(request, {
        gateRoute,
        operation,
        ...(gateId !== undefined ? { gateId } : {}),
        status: reply.statusCode,
        durationMs: Math.round(reply.elapsedTime),
      });
    }
    done();
  });

  function ok(
    reply: { code(status: number): void },
    result: unknown,
  ): { ok: true; result: unknown } {
    reply.code(200);
    return { ok: true, result };
  }

  function fail(
    reply: { code(status: number): void },
    err: unknown,
  ): { ok: false; error: { code: string; message: string } } {
    const mapped = mapGatekeeperError(err);
    reply.code(mapped.status);
    return { ok: false, error: { code: mapped.code, message: mapped.message } };
  }

  function notFound(reply: { code(status: number): void }) {
    reply.code(404);
    return { ok: false, error: { code: 'gate_not_found', message: 'no such gate instance' } };
  }

  app.get(`${prefix}/gate/describe_operations`, async (request, reply) => {
    const ctx = resolve(request);
    if (!ctx) return notFound(reply);
    const result = DescribeOperationsResponseSchema.parse({
      operations: ctx.gate.describeOperations(),
    });
    return ok(reply, result);
  });

  app.get(`${prefix}/gate/health`, async (request, reply) => {
    const ctx = resolve(request);
    if (!ctx) return notFound(reply);
    const result = await ctx.gate.health();
    return ok(reply, result);
  });

  app.post(`${prefix}/gate/observe`, async (request, reply) => {
    const ctx = resolve(request);
    if (!ctx) return notFound(reply);
    const parsed = ObserveRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { ok: false, error: { code: 'invalid_params', message: 'invalid observe request' } };
    }
    try {
      const result = await ctx.gate.observe(parsed.data.operation, parsed.data.params, {
        onBehalfOf: parsed.data.onBehalfOf,
      });
      return ok(reply, { data: result.data, observedFacts: result.observedFacts });
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post(`${prefix}/gate/simulate`, async (request, reply) => {
    const ctx = resolve(request);
    if (!ctx) return notFound(reply);
    const parsed = SimulateRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { ok: false, error: { code: 'invalid_params', message: 'invalid simulate request' } };
    }
    try {
      const result = await ctx.gate.simulate(parsed.data.operation, parsed.data.params, {
        onBehalfOf: parsed.data.onBehalfOf,
      });
      return ok(reply, result);
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post(`${prefix}/gate/apply`, async (request, reply) => {
    const ctx = resolve(request);
    if (!ctx) return notFound(reply);
    const parsed = ApplyRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { ok: false, error: { code: 'invalid_params', message: 'invalid apply request' } };
    }
    try {
      const result = await ctx.gate.apply(
        parsed.data.operation,
        parsed.data.params,
        parsed.data.actionRequestId,
        { onBehalfOf: parsed.data.onBehalfOf },
      );
      return ok(reply, result);
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post(`${prefix}/gate/revert`, async (request, reply) => {
    const ctx = resolve(request);
    if (!ctx) return notFound(reply);
    const parsed = RevertRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { ok: false, error: { code: 'invalid_params', message: 'invalid revert request' } };
    }
    try {
      const result = await ctx.gate.revert(parsed.data.operation, parsed.data.params, {
        onBehalfOf: parsed.data.onBehalfOf,
      });
      return ok(reply, result);
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post(`${prefix}/gate/connected-accounts`, async (request, reply) => {
    const ctx = resolve(request);
    if (!ctx) return notFound(reply);
    const parsed = StoreConnectedAccountRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return {
        ok: false,
        error: { code: 'invalid_params', message: 'invalid connected-account request' },
      };
    }
    try {
      if (!ctx.connectedAccountStore) throw new ConnectedAccountStoreNotConfiguredError();
      const slot = ctx.forcedOnBehalfOf ?? parsed.data.onBehalfOf;
      await ctx.connectedAccountStore.set(slot, parsed.data.credential);
      return ok(reply, { stored: true });
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.delete(`${prefix}/gate/connected-accounts`, async (request, reply) => {
    const ctx = resolve(request);
    if (!ctx) return notFound(reply);
    const parsed = DeleteConnectedAccountRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return {
        ok: false,
        error: { code: 'invalid_params', message: 'invalid connected-account request' },
      };
    }
    try {
      if (!ctx.connectedAccountStore) throw new ConnectedAccountStoreNotConfiguredError();
      const slot = ctx.forcedOnBehalfOf ?? parsed.data.onBehalfOf;
      await ctx.connectedAccountStore.delete(slot);
      return ok(reply, { deleted: true });
    } catch (err) {
      return fail(reply, err);
    }
  });
}

export function createGatekeeperServer(options: CreateGatekeeperServerOptions): FastifyInstance {
  // Leftover 87: the request id is the kernel's correlation id, logged as `correlationId`.
  const app = Fastify({
    logger: options.logger ?? false,
    genReqId: gateRequestId,
    logController: new LogController({ requestIdLogLabel: 'correlationId' }),
  });
  // `/gate/*` and (leftover 87) `/internal/*` — the same gate token, kernel-only.
  registerGateAuthGuard(app, options.token);
  const context: GateRouteContext = {
    gate: options.gate,
    connectedAccountStore: options.connectedAccountStore,
  };
  const metrics = createGateMetrics();
  registerGateRoutes(app, { prefix: '', resolve: () => context, metrics });
  app.get('/internal/metrics', async (_request, reply) => {
    reply.header('content-type', PROMETHEUS_TEXT_CONTENT_TYPE);
    return metrics.render();
  });
  return app;
}
