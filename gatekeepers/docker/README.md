# gatekeepers/docker

Preset `cli`-kind Gatekeeper 接入包 (design doc §7.5, §7.10; docs/development-tasks.md S2.5) for
the host's own Docker Engine. Talks to `/var/run/docker.sock` via `dockerode` — **no `docker` CLI
binary in this image**.

## Which build (task brief: "a small TS package … or a config-only instance … say which")

A small TS package with its own `src/index.ts`, **not** `@nexttime/gatekeeper-base`'s
env-driven `main()`/`startGatekeeperServer()`. Reason: `main()`'s `GATE_TRANSPORT_KIND=cli` path
always constructs the base package's own `CliTransport` (`kinds/cli.ts`), which renders each
Operation's `binding.command_template` and runs it with `execFile` against a real binary on
`$PATH` — i.e. it shells out to `docker`, which this task explicitly forbids. `GatekeeperBase`
itself is transport-agnostic (one `Transport` instance for the whole manifest, chosen by the
caller, not derived from `binding.kind`), so this package supplies its own `Transport`
(`src/transport.ts`) backed by `dockerode` instead — the "construct `GatekeeperBase`/
`createGatekeeperServer` directly" escape hatch `@nexttime/gatekeeper-base`'s own README
documents for a gate needing "anything more specific" than the common single-transport case.
Every Operation still declares `binding.kind: 'cli'` (so it validates against `@nexttime/shared`'s
`CliBindingSchema` and the manifest's wire shape stays consistent with what a `cli`-kind gate
looks like from the outside) — `binding.command_template` is documentary/`simulate`-fallback text
only; it is never executed.

## Manifest (`manifest.json`)

| Operation | mode | blast_radius | auto_approvable | await_decision | notes |
|---|---|---|---|---|---|
| `containers.list` | observe | low | true | false | → `Container` facts (all containers, `all:false` filters to running only) |
| `container.inspect` | observe | low | true | false | → one `Container` fact |
| `compose.ls` | observe | low | true | false | groups containers by `com.docker.compose.project` label |
| `container.logs_tail` | observe | low | true | false | de-multiplexed stdout+stderr text |
| `container.restart` | execute | medium | **false** | **false** | `simulate` returns the target container; idempotent `apply` |
| `compose.up` | execute | high | **false** | true | starts existing stopped containers in the named project (see below) |
| `compose.down` | execute | high | **false** | true | stops running containers in the named project |

`reads`/`writes` on every Operation carry `Container` — the S2.6 meta-ontology `reads`/`writes`
LinkTypes this Gatekeeper's Operation objects expose.

### `compose.up`/`compose.down` — reduced semantics (known deviation)

Only the Docker Engine API (via `dockerode`) is available in this image — no `docker compose`
binary (forbidden: "no docker CLI in the image") and no bundled Compose-file parser. `compose.up`
starts every **already-existing** stopped container labelled
`com.docker.compose.project=<project>`; `compose.down` stops every running one. Neither pulls
images, creates/recreates services, nor manages networks/volumes — this is not a full Compose
reconciliation. A future task wanting real `docker compose up`/`down` semantics would need either
a bundled Compose binary (which reopens "no CLI in the image") or a from-scratch TS
implementation of Compose's file-parsing + reconciliation logic; out of scope here.

## Credentials

None — the trust boundary is the `/var/run/docker.sock` mount itself (`docker-compose.yml`'s
`gatekeeper-docker` service), not a bearer token. `src/index.ts`'s `NoCredentialResolver` always
resolves to `{}`.

## Idempotent `apply`

Handled entirely by `@nexttime/gatekeeper-base`'s `GatekeeperBase`/`JsonFileIdempotencyStore` — a
repeat `apply` for `container.restart` with the same `idempotencyKey` returns the stored result
without calling `dockerode` again (`src/transport.test.ts` asserts `client.restartCalls` stays at
length 1 across two `apply` calls with the same key).

## Env

| Var | Default | Notes |
|---|---|---|
| `DOCKER_SOCKET_PATH` | `/var/run/docker.sock` | passed to `dockerode`'s `socketPath` |
| `GATE_DATA_DIR` | `./data` | idempotency store JSON file (`@nexttime/gatekeeper-base`'s `resolveGateDataDir`) — mount a persistent volume here in production |
| `GATE_MANIFEST_FILE` | (bundled `manifest.json`) | override the manifest without rebuilding the image |
| `GATE_PORT` | `8083` | |
| `GATE_BIND_ADDR` | `0.0.0.0` | |

## Testing

`src/manifest.test.ts` validates `manifest.json` against `OperationSchema` and the task brief's
classification table above. `src/transport.test.ts` exercises the whole stack through
`GatekeeperBase` with a fake `DockerClient` (`src/test-support/fake-docker-client.ts`) — no real
socket. `src/docker-client.test.ts` unit-tests the log-frame de-multiplexer.
