# @nexttime/gatekeeper-base

Gatekeeper protocol, four transport kinds (`http`/`mcp`/`cli`/`ssh`), manifest model, credential
resolution, idempotent apply storage. See design doc §5.1.4 and §7.5 for the full model; this
README covers what a concrete接入包 (`gatekeepers/<system>/`, S2.5+) needs to know to use this
package.

## Protocol

An HTTP server (`createGatekeeperServer`, Fastify) exposes six operations under `/gate/<op>`:

| Method | Path | Body | Notes |
|---|---|---|---|
| GET | `/gate/describe_operations` | — | Returns the whole manifest. |
| GET | `/gate/health` | — | `{status: 'ok'\|'degraded'\|'down'}`. |
| POST | `/gate/observe` | `{operation, params, onBehalfOf?}` | Only `mode: 'observe'` Operations. |
| POST | `/gate/simulate` | `{operation, params, onBehalfOf?}` | Dry-run description, never executes. |
| POST | `/gate/apply` | `{operation, params, onBehalfOf?, idempotencyKey}` | Only `mode: 'execute'`; idempotent by `idempotencyKey`. |
| POST | `/gate/revert` | `{operation, params, onBehalfOf?, idempotencyKey?}` | Only `reversibility: true` Operations whose transport implements `revert`. |

Every response is `{ok: true, result}` or `{ok: false, error: {code, message}}` — the kernel's
`adapters/gatekeeper-client` (`packages/kernel/src/adapters/gatekeeper-client`) parses this shape.

## Auth

Every `/gate/*` route requires `Authorization: Bearer <token>`, checked in constant time
(`gate-auth.ts`). The token is read from `GATE_KERNEL_TOKEN_FILE` (default
`/run/secrets/gate_token`, `gate-token.ts`'s `DEFAULT_GATE_TOKEN_FILE`) — `createGatekeeperServer`
and `startGatekeeperServer`/`main()` both refuse to start without a readable, valid one. A missing
or wrong token gets 401 `{ok:false,error:{code:'unauthorized',message:'unauthorized'}}`, and the
guard never echoes the presented or expected token anywhere (body or logs). The kernel's
`HttpGatekeeperClient` reads its own copy of the same secret from `NEXTTIME_GATE_TOKEN_FILE` (same
default path) and sends the header automatically — a concrete接入包 (`gatekeepers/<system>/`)
that composes `GatekeeperBase`/`createGatekeeperServer` directly (rather than using this package's
own `main()`) must load its own token via `loadGateKernelToken` and pass it as
`createGatekeeperServer`'s `token` option, same as `gatekeepers/docker`/`gatekeepers/ragflow` do.

**Which token** (R-01, maintainer decision D-01): the platform `gate_token` belongs only to gates
the platform provisioned — the packaged gates on the compose network and gate-host instances, i.e.
the platform gate-instance catalog. A **self-connected** gate (one a workspace owner registers with
`create_connection`, wherever it runs) is never sent the platform token: the kernel presents that
gate's own connection secret instead. The owner gets it once — the console's 直接注册门 / Register a
gate form shows it, or `mint_connection_secret` — writes it into a file, points
`GATE_KERNEL_TOKEN_FILE` at it, (re)starts the gate, and then connects it (passing the same secret
as `create_connection`'s `connectionSecret`). Nothing else changes for the gate: it just holds a
different token. `rotate_connection_secret` issues a new one (the old one stops working at once).

## Manifest format

A manifest is an array of `Operation` (`@nexttime/shared`'s `OperationSchema`):
`{name, binding, params_schema, mode, blast_radius, reversibility, auto_approvable,
await_decision, reads, writes, result_mapping?}`. `binding.kind` matches the gate's own transport
kind:

- `http`: `{kind:'http', method, path}` — `{name}` segments in `path` are substituted from `params`.
- `mcp`: `{kind:'mcp', tool_name}`.
- `cli`: `{kind:'cli', command_template}` — `{name}` tokens substituted, one argv element each.
- `ssh`: `{kind:'ssh', command_template?, command_pattern?}` — a fixed template, or a regex class
  matched against a literal `params.command` (see "Command policy table" below).

`importOpenApi(document)` and `importMcpTools(toolsListResponse)` produce a manifest **draft**
from an OpenAPI 3.x document / an MCP `tools/list` response: `GET`/`readOnlyHint` → `observe`,
everything else → `execute`; every imported `execute` Operation is `auto_approvable: false,
await_decision: true` — an owner must review and publish before it takes effect (I17).

## Command policy table (`ssh`/`cli`)

`classifyCommand(command, policyTable)` (`src/kinds/ssh.ts`) matches an ordered list of
`{pattern, mode, blastRadius, autoApprovable}` rules against a literal command string; the first
match wins. No match → the unclassified default (`mode: 'execute', blastRadius: 'medium',
autoApprovable: false, unclassified: true`) — I17's "unclassified操作一律 require_approval".

## Credential resolution

Exactly one `CredentialResolver` per gate instance (a gate backs one target system/account):

- `SharedEnvCredentialResolver` — reads `GATE_CREDENTIAL_<NAME>` (`NAME` defaults to `DEFAULT`)
  from the gate's own env. Every caller gets the same credential — for infrastructure/inventory
  systems, never systems that must act as a specific person.
- `ConnectedAccountCredentialResolver` (+ `ConnectedAccountStore`) — one AES-256-GCM-encrypted
  credential per `on_behalf_of` Principal, stored in a JSON file under `GATE_DATA_DIR`. The
  encryption key is read from `GATE_STORE_KEY_FILE` (a file, never an env var value — so it never
  appears in `docker inspect`); the key file's raw bytes are used directly if exactly 32 bytes,
  else SHA-256-hashed to derive one.

The kernel never receives credential material — every `request_action` call carries only
`on_behalf_of`; the gate resolves the actual credential itself.

## Idempotent apply store

`JsonFileIdempotencyStore` (default in `main()`/`startGatekeeperServer`) keeps every `apply` key
in a single JSON file under `GATE_DATA_DIR`, loaded fully into memory and rewritten atomically
(write-to-temp-then-`rename`, writes serialized) on every change. A key is reserved on disk
*before* the transport runs, then ends as a stored result (a repeat `apply` replays it), a stored
failure (a repeat gets the same 502, never a second run), or is released when nothing ran (a
refusal, 403 `operation_refused`; an unresolvable credential, 424). A key still reserved when the
gate process stopped is loaded back as outcome-unknown: every later `apply` for it answers 409
`apply_outcome_unknown` and the call is never re-run automatically — the kernel marks the
ActionRequest `failed: outcome_unknown` for a person to reconcile. The same answer follows an
`ssh`/`cli` command killed by the exec timeout (50 s, below the kernel's 60 s `apply` budget).
**Durability limits**: safe for one gate
process; not safe for multiple gate processes sharing the same data directory (no cross-process
locking); no compaction — an operator wanting bounded growth should prune old entries
out-of-band. `InMemoryIdempotencyStore` is available for tests or a gate that deliberately opts
out of on-disk idempotency.

## Data directory

`GATE_DATA_DIR` (default `./data`) holds the idempotency store and the ConnectedAccount store —
mount it as a persistent volume in a concrete gate's compose service (S2.5).

## Building a concrete gate

The common single-transport case (`http`/`mcp`/`cli`/`ssh`) is entirely env-driven —
`startGatekeeperServer()` / `main()` in `src/index.ts` build the transport, credential resolver,
and manifest from env vars (`GATE_TRANSPORT_KIND`, `GATE_TARGET_BASE_URL` / `GATE_TARGET_ENDPOINT`
/ `GATE_SSH_HOST` etc., `GATE_MANIFEST_FILE`, `GATE_CREDENTIAL_MODE`). A gate that needs anything
more specific (a non-file manifest source, multiple transports, custom credential logic)
constructs `GatekeeperBase` / `createGatekeeperServer` directly instead — see
`src/gatekeeper-base.ts` and any of the `kinds/*.test.ts` files for the shape.

## SSH host keys (`ssh`)

The `ssh` transport shells out to the system `ssh` client with `BatchMode=yes`, so an unknown or
changed host key fails closed instead of prompting. Two env vars control the policy:

| Var | Effect |
|---|---|
| `GATE_SSH_KNOWN_HOSTS_FILE` | `-o UserKnownHostsFile=<path>` — the pinned host key(s) for the target. Put it under the gate's data dir. |
| `GATE_SSH_STRICT_HOST_KEY_CHECKING` | `yes` (pinned key required — production), `accept-new` (pin on first contact, refuse changes), or `no` (test fixtures only, e.g. `deploy/accept-s2`). Unset → OpenSSH default, which under BatchMode refuses unknown hosts. |

A failed command surfaces `ssh`'s own stderr in the error message (host-key refusal, permission
denied, unprotected private key file) so the ActionRequest's failure reason is diagnosable.

## TLS to the target (`http`/`mcp`)

A target behind a private or self-signed certificate is trusted explicitly, never by disabling
verification (`src/tls.ts`):

| Var | Effect |
|---|---|
| `GATE_TLS_CA_FILE` | PEM file whose certificates become the trust anchors for this gate's target connections (for a self-signed target: that certificate itself). Unreadable file → the gate refuses to start. |
| `GATE_TLS_SERVERNAME` | Name the certificate is verified against (and sent as SNI) when the target is reached by an address that is not in its SAN list — e.g. a LAN IP for a certificate issued to a DNS name. |

Either may be set alone; neither set → the plain global `fetch` with the system trust store. A
gate started with `NODE_TLS_REJECT_UNAUTHORIZED=0` logs a startup warning pointing at these two
vars — that switch disables verification for every outbound TLS connection of the process and is
not a supported configuration. `buildTlsFetch`/`gateTlsOptionsFromEnv` are exported for gates
that compose `HttpTransport` themselves (e.g. `gatekeepers/ragflow`).
