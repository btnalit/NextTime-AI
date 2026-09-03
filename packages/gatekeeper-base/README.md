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

`JsonFileIdempotencyStore` (default in `main()`/`startGatekeeperServer`) keeps every stored
`apply` result in a single JSON file under `GATE_DATA_DIR`, loaded fully into memory and rewritten
atomically (write-to-temp-then-`rename`) on every write. **Durability limits**: safe for one gate
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
