# `@nexttime/collector-host-inventory`

Structural host-inventory collector (design doc §7.8 采集器, §10.1, §10.2; `docs/development-tasks.md`
S3.3). Observes Docker/systemd/git structural facts on one Host and writes them into the graph
through the kernel's `register_source`/`submit_observations` capabilities. Read-only: this
collector never restarts, starts, stops, or otherwise mutates anything it observes — no approval
gate applies to it (S3.3's own acceptance: "批准：否（只读）").

For the operator-facing deploy/verify walkthrough, see `docs/runbooks/host-collector.md`. This file
covers the package's own internals.

## Data sources

| Source | Module | Notes |
|---|---|---|
| Docker Engine API | `docker-client.ts` | `dockerode` over `DOCKER_HOST` (a dedicated `docker-socket-proxy-collector` instance — no `docker.sock` mount, no docker CLI in the image). Containers, images, networks, volumes, host info. |
| systemd | `systemd.ts` | `systemctl list-units --type=service`, only when `/run/systemd` is mounted (optional — skips cleanly otherwise). |
| Process tree | `process-tree.ts` | Limited to the agent-runtime process's own subtree. **Current default deployment has no `pid: host`**, so this collector's own `/proc` never shows a different container's processes — `collectProcessTree` legitimately returns `skipped: true` every run in that shape; this is documented, not a bug. See that module's own doc comment for the full reasoning and the (declined) alternative. |
| git remotes | `repository.ts` | `git remote -v` for each path in `HOST_INVENTORY_REPOSITORY_PATHS` (optional, empty by default). |

## Ontology mapping

Every ObjectType/LinkType this collector writes comes from `ontology/ops-assets-v1.yaml` (S3.1) —
`observation-builder.ts` is the pure module that maps raw collected data onto that scheme. Some
identity fields (`ComposeProject.hostId`, `Container.composeProjectId`, …) must hold *another
Object's own graph id* (that YAML file's own header comment) — a value this collector cannot invent
ahead of time. It resolves this with a three-phase submission, all sharing one Activity
(`run.ts`'s own doc comment has the full phase table):

1. **Phase 1** — Host, Repository, Image, Process (no dependency on any resolved id). The response's
   `objects[]` gives back Host's real graph id.
2. **Phase 2** — ComposeProject, Volume, Network, SystemdService (need Host's resolved id from
   phase 1). The response gives back each ComposeProject's real graph id.
3. **Phase 3** — Container (needs its ComposeProject's resolved id from phase 2), with every link
   hanging off it (`uses_image`, `mounts`, `attached_to`, `exposes`, `depends_on`, `part_of`,
   `runs_on`).

## Sanitization (`redact.ts`)

Every process command line is sanitized **before** it is ever placed into an Observation — never
after. Two tiers, both fail closed:

1. Structural redaction: `--token=X` / `password=X` / `key=X` / `Bearer <token>` → `***`.
2. A broad "still looks like a live secret" sniff (JWT-shaped tokens, or any other long opaque
   32+ character run) applied to the *already-redacted* text — catches anything tier 1 missed.

If **either tier fails for any single process**, this collector drops the **whole batch** for this
run — no partial submission, no network call to the kernel at all for this cycle — and the process
exits non-zero (`run.ts`'s own ordering: sanitization happens before `register_source`, the very
first kernel call this collector ever makes). `environ` (`/proc/<pid>/environ`) is never read
anywhere in this package.

## Identity persistence across runs

`register_source` always inserts a fresh Source row (it never de-duplicates by name — see
`ingest-handlers.ts`'s own doc comment for why that is the right default for a general-purpose
capability). This collector calls it only on its very first-ever run and caches the returned id in
a local state file (`HOST_INVENTORY_SOURCE_STATE_FILE`, default `/data/state/host-inventory-
source.json`) — every later run reads the cached id instead. This is not just an optimization: it
is what keeps every run's Facts resolving to the *same* origin (`resolveFactOrigin`, S3.2's
`substrate/epistemic/conflicts.ts`), which is the actual mechanism behind the acceptance criterion
"两遍无重复无 Conflict — a second identical run never opens a Conflict, only supersedes".

## Configuration

See `src/config.ts` for the authoritative list; summary:

| Env var | Required | Default | Meaning |
|---|---|---|---|
| `KERNEL_URL` | yes | — | Kernel HTTP base URL, e.g. `http://kernel:8080`. |
| `NEXTTIME_HANDLE_TOKEN_FILE` | no | `/run/secrets/collector_host_inventory_token` | This collector's Handle bearer token (minted by `bootstrap.js issue-service-handle`), read fresh on every call. |
| `DOCKER_HOST` | no | (Unix socket fallback) | `tcp://docker-socket-proxy-collector:2375` in compose. |
| `HOST_INVENTORY_RUN_SYSTEMD_PATH` | no | `/run/systemd` | Presence check gating `systemctl` calls. |
| `HOST_INVENTORY_REPOSITORY_PATHS` | no | (none) | `:`-separated list of git repo paths to observe `git remote` for. |
| `HOST_INVENTORY_INTERVAL_MS` | no | `900000` (15 min) | Loop interval when not run with `--once`. |
| `HOST_INVENTORY_SOURCE_STATE_FILE` | no | `/data/state/host-inventory-source.json` | Local Source-id cache (see above). |
| `HOST_INVENTORY_SOURCE_NAME` / `HOST_INVENTORY_SOURCE_KIND` | no | `host-inventory` / `host-inventory-collector` | `register_source`'s own `name`/`kind`. |

CLI: `--once` runs a single cycle and exits with that cycle's own exit code (for a host cron/
systemd-timer-driven invocation); omitted, this process loops until `SIGTERM`/`SIGINT`.

## Testing

`pnpm --filter @nexttime/collector-host-inventory test` — pure-function/fake-backed unit tests only
(no real Docker/`/proc`/kernel needed; this machine has neither Docker nor a real `/proc`). Every
IO boundary (`DockerClient`, `KernelClient`, `ProcFsReader`, `SystemctlRunner`, `GitRunner`) is an
injectable interface for exactly this reason.
