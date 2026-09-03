import Fastify, { type FastifyInstance } from 'fastify';
import type { ConnectedAccountStore } from './credentials/index.js';
import {
  ApplyRequiresIdempotencyKeyError,
  ConnectedAccountStoreNotConfiguredError,
  CredentialResolutionError,
  OperationModeMismatchError,
  OperationNotFoundError,
  ParamsValidationError,
  RevertNotSupportedError,
  TransportInvokeError,
} from './errors.js';
import type { GatekeeperBase } from './gatekeeper-base.js';
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
}

export function createGatekeeperServer(options: CreateGatekeeperServerOptions): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false });
  const gate = options.gate;

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

  app.get('/gate/describe_operations', async (_request, reply) => {
    const result = DescribeOperationsResponseSchema.parse({
      operations: gate.describeOperations(),
    });
    return ok(reply, result);
  });

  app.get('/gate/health', async (_request, reply) => {
    const result = await gate.health();
    return ok(reply, result);
  });

  app.post('/gate/observe', async (request, reply) => {
    const parsed = ObserveRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { ok: false, error: { code: 'invalid_params', message: 'invalid observe request' } };
    }
    try {
      const result = await gate.observe(parsed.data.operation, parsed.data.params, {
        onBehalfOf: parsed.data.onBehalfOf,
      });
      return ok(reply, { data: result.data, observedFacts: result.observedFacts });
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post('/gate/simulate', async (request, reply) => {
    const parsed = SimulateRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { ok: false, error: { code: 'invalid_params', message: 'invalid simulate request' } };
    }
    try {
      const result = await gate.simulate(parsed.data.operation, parsed.data.params, {
        onBehalfOf: parsed.data.onBehalfOf,
      });
      return ok(reply, result);
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post('/gate/apply', async (request, reply) => {
    const parsed = ApplyRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { ok: false, error: { code: 'invalid_params', message: 'invalid apply request' } };
    }
    try {
      const result = await gate.apply(
        parsed.data.operation,
        parsed.data.params,
        parsed.data.idempotencyKey,
        { onBehalfOf: parsed.data.onBehalfOf },
      );
      return ok(reply, result);
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post('/gate/revert', async (request, reply) => {
    const parsed = RevertRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { ok: false, error: { code: 'invalid_params', message: 'invalid revert request' } };
    }
    try {
      const result = await gate.revert(parsed.data.operation, parsed.data.params, {
        onBehalfOf: parsed.data.onBehalfOf,
      });
      return ok(reply, result);
    } catch (err) {
      return fail(reply, err);
    }
  });

  const connectedAccountStore = options.connectedAccountStore;

  app.post('/gate/connected-accounts', async (request, reply) => {
    const parsed = StoreConnectedAccountRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return {
        ok: false,
        error: { code: 'invalid_params', message: 'invalid connected-account request' },
      };
    }
    try {
      if (!connectedAccountStore) throw new ConnectedAccountStoreNotConfiguredError();
      await connectedAccountStore.set(parsed.data.onBehalfOf, parsed.data.credential);
      return ok(reply, { stored: true });
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.delete('/gate/connected-accounts', async (request, reply) => {
    const parsed = DeleteConnectedAccountRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return {
        ok: false,
        error: { code: 'invalid_params', message: 'invalid connected-account request' },
      };
    }
    try {
      if (!connectedAccountStore) throw new ConnectedAccountStoreNotConfiguredError();
      await connectedAccountStore.delete(parsed.data.onBehalfOf);
      return ok(reply, { deleted: true });
    } catch (err) {
      return fail(reply, err);
    }
  });

  return app;
}
