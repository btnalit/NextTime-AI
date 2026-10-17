import { domainToASCII } from 'node:url';
import type { PrincipalKind } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { SqlGraphStore } from '../../substrate/graph/index.js';
import {
  registerGatekeeperObject,
  setGatekeeperConnectionSecretSaltObject,
} from '../../substrate/ontology/index.js';
// The rule module itself, not `../connections/index.js`: `connections/service.ts` calls this module.
import {
  assertConnectionParamsCarryNoCredentials,
  redactConnectionAddress,
} from '../connections/credentials.js';

/**
 * governance/gatekeepers/registry: Gatekeeper instance registration + lookup (design doc §5.1.4
 * Gatekeeper/Connection, §7.5; docs/development-tasks.md S2.4 "kernel gatekeepers/{client,
 * registry,manifest}.ts").
 *
 * Module placement (task brief: "governance/connections/ or a new governance/gatekeepers/ — pick
 * one, say why"): a new module. §7.1's module table assigns "门实例注册、清单导入草稿" to
 * `connections`, but `governance/connections/index.ts` is still S2.13's placeholder — that task's
 * own deliverable is the *human-facing* `request_connection` card flow (`request_connection` →
 * card → human fills credentials → `create_connection`/`publish_manifest`/`connect_gatekeeper`).
 * This module ships the *lower-level* primitives S2.13 will call into: register a Gatekeeper
 * instance's endpoint/transport, import/publish its Operation manifest. Keeping them in their own
 * module (rather than reaching into S2.13's not-yet-written module) avoids two tasks racing to
 * define the same module's internals, and matches the existing precedent of `governance/policy`
 * and `governance/capability` being separate sibling modules `governance/approval` calls into
 * through their own published service interfaces (§7.10 module contract) — S2.13 does the same
 * here once it lands, rather than this module reaching into `connections`.
 *
 * This module owns no table of its own (design doc §9.2 "gatekeeper_instances ... 作为平台元本体存于
 * objects / links" — S2.1's own deviation note already established there is no dedicated
 * `gatekeepers` relational table) — a registered Gatekeeper is entirely a graph Object
 * (`substrate/ontology`'s `registerGatekeeperObject`) plus a lazily-created shared service
 * Principal (`service-principal.ts`).
 */

const graphStore = new SqlGraphStore();

export interface RegisterGatekeeperInput {
  /** Omit to register a new instance; given, re-registers (upserts) the same one. */
  readonly gatekeeperId?: string;
  readonly name: string;
  readonly transportKind: 'http' | 'mcp' | 'cli' | 'ssh';
  readonly target: string;
  readonly endpoint: string;
  /** R-01 / D-01: a self-connected gate's connection-secret salt (`create_connection`); omitted for
   *  a gate the kernel provisioned. */
  readonly connectionSecretSalt?: string;
  /** The connected system's own Object id (design doc §5.1.4 Connection "产生 Gatekeeper 实例对象、
   *  系统对象与 connects_to 边"). When omitted, a lightweight `ConnectedSystem` Object is created
   *  from `name`/`target` — the common case for this task's own tests and for a gate registered
   *  without a prior, separately-modeled system Object; S2.13's real connection flow is expected
   *  to create a richer system Object first and pass its id here instead. */
  readonly systemObjectId?: string;
  readonly activityId: string;
  readonly registeredBy: { readonly id: string; readonly kind: PrincipalKind };
}

export interface RegisterGatekeeperResult {
  readonly gatekeeperId: string;
}

export async function registerGatekeeper(
  client: PoolClient,
  workspaceId: string,
  input: RegisterGatekeeperInput,
): Promise<RegisterGatekeeperResult> {
  // Legacy 186, defense in depth: the one production caller — the landing
  // (application/gates/landing.ts, behind `create_connection` and `enable_gate_instance`) — checks
  // first; whatever the caller, no Gatekeeper or ConnectedSystem is written with a credential in its
  // address.
  assertConnectionParamsCarryNoCredentials('register_gatekeeper', {
    target: input.target,
    endpoint: input.endpoint,
  });
  const systemObjectId =
    input.systemObjectId ??
    (
      await graphStore.upsertObject(client, workspaceId, {
        objectType: 'ConnectedSystem',
        identity: { name: input.name },
        properties: { target: input.target },
      })
    ).id;

  const result = await registerGatekeeperObject(client, workspaceId, {
    gatekeeperId: input.gatekeeperId,
    transportKind: input.transportKind,
    target: input.target,
    name: input.name,
    endpoint: input.endpoint,
    ...(input.connectionSecretSalt !== undefined
      ? { connectionSecretSalt: input.connectionSecretSalt }
      : {}),
    systemObjectId,
    activityId: input.activityId,
    registeredBy: input.registeredBy,
  });

  return { gatekeeperId: result.gatekeeperObjectId };
}

/** R-01 / D-01 `rotate_connection_secret`: records `salt` as the Gatekeeper's current connection-
 *  secret salt — the previous secret stops working the moment this commits. Throws
 *  `GatekeeperNotFoundError` when there is no such Gatekeeper. Which Gatekeepers may carry a salt
 *  at all (never a platform-catalog one) is the caller's rule (application/gateway). */
export async function setGatekeeperConnectionSecretSalt(
  client: PoolClient,
  workspaceId: string,
  gatekeeperId: string,
  salt: string,
): Promise<void> {
  const updated = await setGatekeeperConnectionSecretSaltObject(
    client,
    workspaceId,
    gatekeeperId,
    salt,
  );
  if (!updated) throw new GatekeeperNotFoundError(gatekeeperId);
}

/** The id of the Gatekeeper in `workspaceId` whose connection-secret salt is `salt`, or `null` —
 *  `create_connection` refuses to reuse one connection's secret for another (R-01). */
export async function findGatekeeperIdByConnectionSecretSalt(
  client: PoolClient,
  workspaceId: string,
  salt: string,
): Promise<string | null> {
  const result = await client.query<{ id: string }>(
    `select id from objects
     where workspace_id = $1 and object_type = 'Gatekeeper'
       and properties ->> 'connectionSecretSalt' = $2
     limit 1`,
    [workspaceId, salt],
  );
  return result.rows[0]?.id ?? null;
}

/** A Gatekeeper's name as every reader of this module gets it (#620, review #493 P2): a self-
 *  connected gate is named after the target its owner typed (application/gates/landing.ts), so a
 *  name written before legacy 186 can carry the credential its address did — shown through
 *  `redactConnectionAddress`, the rule for every gate address someone reads. A name is a label:
 *  no gate is called and no row is found by it, so no reader needs the stored text. The stored
 *  value is untouched until the scrub rewrites it. */
function displayedGatekeeperName(name: string | undefined, gatekeeperId: string): string {
  return name === undefined ? gatekeeperId : redactConnectionAddress('target', name);
}

export interface GatekeeperRecord {
  readonly gatekeeperId: string;
  /** `displayedGatekeeperName`'s: redacted, never the stored text. */
  readonly name: string;
  readonly transportKind: 'http' | 'mcp' | 'cli' | 'ssh';
  readonly target: string;
  readonly endpoint: string;
  /** R-01 / D-01: the self-connected gate's connection-secret salt, when it has one
   *  (`application/gateway/gate-target.ts` reads it; never the secret). */
  readonly connectionSecretSalt?: string;
  /** S3.11 addition (`get_gatekeeper`'s own wire shape needs it) — the underlying Object's own
   *  `created_at`, purely additive to every pre-existing caller of this function. */
  readonly createdAt: Date;
}

/** Reads a registered Gatekeeper's connection config from its Object properties, or `null` if it
 *  does not exist / is not a `Gatekeeper`-typed Object. */
export async function getGatekeeper(
  client: PoolClient,
  workspaceId: string,
  gatekeeperId: string,
): Promise<GatekeeperRecord | null> {
  const object = await graphStore.getObject(client, workspaceId, gatekeeperId);
  if (!object || object.objectType !== 'Gatekeeper') return null;
  const props = object.properties as {
    transportKind?: string;
    target?: string;
    name?: string;
    endpoint?: string;
    connectionSecretSalt?: unknown;
  };
  if (!props.transportKind || !props.target || !props.endpoint) return null;
  return {
    gatekeeperId: object.id,
    name: displayedGatekeeperName(props.name, object.id),
    transportKind: props.transportKind as GatekeeperRecord['transportKind'],
    target: props.target,
    endpoint: props.endpoint,
    ...(typeof props.connectionSecretSalt === 'string'
      ? { connectionSecretSalt: props.connectionSecretSalt }
      : {}),
    createdAt: object.createdAt,
  };
}

/**
 * Thrown by callers that need a registered Gatekeeper and got `null` from `getGatekeeper`
 * (`application/gateway/request-action-handler.ts`, `governance/connections/service.ts`). One
 * class, owned here by the module that owns the Gatekeeper Object, so `interfaces/http` and
 * `interfaces/ws` map a single `instanceof` to 404 — before S2.13 each consumer declared its own
 * same-named class and only the request_action one was mapped.
 */
export class GatekeeperNotFoundError extends Error {
  constructor(gatekeeperId: string) {
    super(`Gatekeeper not found: ${gatekeeperId}`);
    this.name = 'GatekeeperNotFoundError';
  }
}

// -------------------------------------------------------------------------------------------
// listGatekeepers (S3.11, docs/development-tasks.md "中台控制面" — `list_gatekeepers`'s service
// half): every registered Gatekeeper instance, direct SQL over `objects` — same style
// `governance/gatekeepers/manifest.ts`'s `listPublishedOperationsForGatekeepers`/
// `listDraftOperationsForGatekeeper` already established for this table (no dedicated relational
// table exists for a Gatekeeper, §9.2 — see this file's own module doc comment).
// -------------------------------------------------------------------------------------------

export interface GatekeeperListEntry {
  readonly gatekeeperId: string;
  /** Redacted, as `GatekeeperRecord.name`. */
  readonly name: string;
  readonly transportKind: 'http' | 'mcp' | 'cli' | 'ssh';
  readonly endpoint: string | null;
  readonly createdAt: Date;
}

interface GatekeeperObjectRow {
  id: string;
  properties: Record<string, unknown>;
  created_at: Date;
}

/** Every `Gatekeeper` Object in the workspace, oldest first — the raw rows `application/gateway`'s
 *  `list_gatekeepers`/`get_gatekeeper` handlers project to the wire shape (operation counts and
 *  live health are that layer's concern, not this one's, same "governance owns storage,
 *  application projects" split `getGatekeeper`/`getOperation` above already follow). */
export async function listGatekeepers(
  client: PoolClient,
  workspaceId: string,
): Promise<readonly GatekeeperListEntry[]> {
  const result = await client.query<GatekeeperObjectRow>(
    `select id, properties, created_at
     from objects
     where workspace_id = $1 and object_type = 'Gatekeeper'
     order by created_at asc`,
    [workspaceId],
  );
  return result.rows.map((row) => {
    const props = row.properties as {
      transportKind?: string;
      name?: string;
      endpoint?: string;
    };
    return {
      gatekeeperId: row.id,
      name: displayedGatekeeperName(props.name, row.id),
      transportKind: (props.transportKind as GatekeeperListEntry['transportKind']) ?? 'http',
      endpoint: props.endpoint ?? null,
      createdAt: row.created_at,
    };
  });
}

/** `get_workspace`'s own summary count (S3.11, `application/gateway/members-handlers.ts`) — a
 *  plain count over the same `objects` slice `listGatekeepers` reads, kept as its own query
 *  (rather than `(await listGatekeepers(...)).length`) so a workspace with many registered
 *  Gatekeepers does not pay for every row's `properties` just to report a number. */
export async function countGatekeepers(client: PoolClient, workspaceId: string): Promise<number> {
  const result = await client.query<{ count: string }>(
    `select count(*)::bigint as count from objects where workspace_id = $1 and object_type = 'Gatekeeper'`,
    [workspaceId],
  );
  return Number(result.rows[0]?.count ?? 0);
}

// -------------------------------------------------------------------------------------------
// findGatekeepersByEndpoint (S8 W2-K2, leftover 73, ui-audit J3/J4/B7): the association key
// `enable_gate_instance`/`preview_gate_instance_enable` use to find a Gatekeeper a *prior*
// registration already created for the same running gate process — the legacy `register-
// gatekeeper` CLI path (`cli/bootstrap.ts`'s `registerGatekeeperFromCli`) most concretely, but any
// registration path converges here, since `endpoint` (the URL the kernel actually calls) is the
// one field that identifies "the same gate process" regardless of what name/target it was
// registered under. `name`/`target` are deliberately *not* part of this key — they are exactly the
// fields a legacy registration and a platform gate instance are expected to disagree on (a short
// operator-typed `target` vs. the instance's real upstream address, a renamed `name`), which is
// what `drift` (gate-instance-handlers.ts) surfaces without touching them.
// -------------------------------------------------------------------------------------------

export interface GatekeeperByEndpointEntry {
  readonly gatekeeperId: string;
  /** Redacted, as `GatekeeperRecord.name`. */
  readonly name: string;
  readonly target: string;
  readonly transportKind: 'http' | 'mcp' | 'cli' | 'ssh';
  readonly endpoint: string;
  readonly createdAt: Date;
}

/** RFC 3986 §2.3's unreserved characters: a percent-encoding of one of them means the character. */
const UNRESERVED = /^[A-Za-z0-9\-._~]$/;
/** Default ports `URL` does not know (it drops http / https / ws / wss / ftp's itself). */
const DEFAULT_PORTS: Readonly<Record<string, string>> = { 'ssh:': '22' };

/** The parts of a gate address that say which gate process is called, each in one canonical
 *  spelling — `null` for text that is not a URL with a host. `URL` already lower-cases the scheme,
 *  converts an http(s) host to punycode and drops a special scheme's default port; on top of it:
 *    - `ssh`'s default port (22) dropped too;
 *    - the host lower-cased and converted to punycode for a scheme `URL` does not know (`ssh`), and
 *      a trailing dot dropped (`gate.example.` is the same DNS name);
 *    - the user info, the query and the fragment dropped — the kernel never sends them (a call
 *      resolves a path against the base, which drops the query; an address with user info is
 *      refused on write, legacy 186), so they do not name another gate;
 *    - in the path, a percent-encoded unreserved character decoded and every other
 *      percent-encoding upper-cased (RFC 3986 §6.2.2), and every trailing `/` trimmed. */
function canonicalGateAddress(
  endpoint: string,
): { readonly scheme: string; readonly host: string; readonly path: string } | null {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return null;
  }
  if (url.hostname === '') return null;
  let hostname = url.hostname.toLowerCase();
  if (!hostname.startsWith('[')) {
    let decoded = hostname;
    try {
      decoded = decodeURIComponent(hostname);
    } catch {
      // Keep the encoded text.
    }
    hostname = domainToASCII(decoded) || decoded;
  }
  hostname = hostname.replace(/\.$/, '');
  const port = url.port === DEFAULT_PORTS[url.protocol] ? '' : url.port;
  const host = port !== '' ? `${hostname}:${port}` : hostname;
  const path = url.pathname
    .replace(/%[0-9A-Fa-f]{2}/g, (encoded) => {
      const char = String.fromCharCode(Number.parseInt(encoded.slice(1), 16));
      return UNRESERVED.test(char) ? char : encoded.toUpperCase();
    })
    .replace(/\/+$/, '');
  return { scheme: url.protocol, host, path };
}

/** The one address comparison for gates (P0b, #620 review P2-1): two spellings of one gate's
 *  address compare equal — `canonicalGateAddress` has the rule. Used for "one address, one
 *  Gatekeeper" (the landing's `endpoint_already_connected`, its lock and core 0045's
 *  `endpoint_key`), for leftover 73's association (`findGatekeepersByEndpoint`, which the catalog
 *  claim of a self connection goes through), and — by host, `gateEndpointHost` — for the
 *  platform-gate rule. Text that is not a URL with a host keeps the older rule: one trailing `/`
 *  trimmed. A different name or IP for the same host is a different address: what the platform's
 *  per-connection suspension means for it is in `suspend_self_connection`'s description. */
export function normalizeGateEndpoint(endpoint: string): string {
  const address = canonicalGateAddress(endpoint);
  if (address === null) return endpoint.endsWith('/') ? endpoint.slice(0, -1) : endpoint;
  return `${address.scheme}//${address.host}${address.path}`;
}

/** The host (name plus a non-default port) of a gate address in `normalizeGateEndpoint`'s
 *  spelling, or `null` for text that is not a URL with a host — the platform-gate rule's key
 *  (application/gateway/gate-target.ts `platformGateIdForEndpoint`). */
export function gateEndpointHost(endpoint: string): string | null {
  return canonicalGateAddress(endpoint)?.host ?? null;
}

/** What the platform plane shows of an address a workspace connected itself (#620 review): the
 *  scheme, host and a non-default port in `normalizeGateEndpoint`'s spelling — never the path,
 *  query, fragment or user info, where a token can sit that the credential rule does not look for.
 *  Text that is not a URL with a host (a target may be a host or a service name) keeps what comes
 *  before its first `/`, `?` or `#`, after any `…@`. The full address stays in the workspace's
 *  own views. */
export function gateAddressOrigin(address: string): string {
  const canonical = canonicalGateAddress(address);
  if (canonical !== null) return `${canonical.scheme}//${canonical.host}`;
  return address.replace(/^[^@/?#]*@/, '').split(/[/?#]/, 1)[0] ?? '';
}

/** Every `Gatekeeper` Object in `workspaceId` whose own `endpoint` property equals `endpoint`
 *  (both sides run through `normalizeGateEndpoint` — an exact match otherwise, never a prefix/
 *  substring match). Reads the same `objects` rows `listGatekeepers` above does; kept as its own
 *  query (rather than filtering `listGatekeepers`' result) because that function's own
 *  `GatekeeperListEntry` does not carry `target`, which the caller needs for `drift`. Oldest first,
 *  `id` breaking a `created_at` tie, so a caller that takes the first match (`landing.ts`'s
 *  `endpoint_already_connected`) names the same Gatekeeper every time (legacy 340 class). */
export async function findGatekeepersByEndpoint(
  client: PoolClient,
  workspaceId: string,
  endpoint: string,
): Promise<readonly GatekeeperByEndpointEntry[]> {
  const target = normalizeGateEndpoint(endpoint);
  const result = await client.query<GatekeeperObjectRow>(
    `select id, properties, created_at
     from objects
     where workspace_id = $1 and object_type = 'Gatekeeper' and properties ->> 'endpoint' is not null
     order by created_at asc, id asc`,
    [workspaceId],
  );
  const matches: GatekeeperByEndpointEntry[] = [];
  for (const row of result.rows) {
    const props = row.properties as {
      transportKind?: string;
      name?: string;
      endpoint?: string;
      target?: string;
    };
    if (!props.endpoint || normalizeGateEndpoint(props.endpoint) !== target) continue;
    matches.push({
      gatekeeperId: row.id,
      name: displayedGatekeeperName(props.name, row.id),
      target: props.target ?? '',
      transportKind: (props.transportKind as GatekeeperByEndpointEntry['transportKind']) ?? 'http',
      endpoint: props.endpoint,
      createdAt: row.created_at,
    });
  }
  return matches;
}
