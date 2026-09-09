# explorer/

Static-build mount point for the platform's Explorer UI (design doc §7.6/§9.5, S3;
`docs/development-tasks.md` §S3.5).

## What this is

The Explorer is a third-party, open-source Knowledge Explorer front-end
([`semantica-agi/semantica`](https://github.com/semantica-agi/semantica), the
`explorer/` subdirectory of that project — a Vite + React + TypeScript SPA). This
kernel implements that project's own Explorer API contract (nine endpoints:
`GET /api/graph/nodes`, `GET /api/graph/edges`, `POST /api/graph/search`,
`GET /api/temporal/bounds`, `GET /api/temporal/snapshot`, `GET /api/decisions`,
`GET /api/decisions/:id/chain`, `GET /api/provenance`, `GET /api/provenance/report`
— see `packages/kernel/src/interfaces/explorer-contract/`), so the *unmodified*
upstream Explorer static bundle can be pointed at this kernel and load our own
Graph / Decision / Lineage data.

**The upstream front-end source is not vendored into this repository.** `build.sh`
below clones (or reads from a local checkout via `SEMANTICA_SRC`) and builds it at
build time, on a host or in `deploy/caddy/Dockerfile`'s own build stage — never
committed here. Only two things live in this directory long-term:

- `build.sh` — the build script (below).
- Whatever `deploy/caddy/explorer-placeholder/` (siblings, not under `explorer/`
  itself — see "Deploy wiring" below) already holds: either the checked-in
  placeholder page, or a real built bundle after `build.sh` has been run locally.

## Was the reference project's own Explorer buildable standalone?

Yes — verified end-to-end (`npm ci && npx tsc -b && npx vite build`, against the
reference project's `v0.6.7` `explorer/` subdirectory). It is a pure front-end SPA:
`vite build` needs no backend, no network access beyond `npm install`, and produces
a fully static bundle. The "minimal static shell" fallback this task's brief
allowed for was therefore not needed.

Two things the build needs that its own defaults don't provide, both handled by
`build.sh`:

1. **`base` path.** The project's own `vite.config.ts` hard-codes `base: '/'`
   (production assets referenced as absolute `/assets/...`). Mounted at `/explorer/`
   (not the site root — this kernel/caddy also serve the platform's own web console
   at `/`), those references would 404. `build.sh` overrides this with
   `vite build --base=/explorer/`, matching the exact prefix
   `deploy/caddy/Caddyfile`'s `handle_path /explorer/*` strips before serving.
2. **`outDir`.** The project's own config writes to `../semantica/static` (relative
   to its own `explorer/` directory — i.e. its Python package's static directory,
   not `explorer/dist`). `build.sh` overrides this with `--outDir` to control
   exactly where the built files land.

## Usage

```sh
# Clone a pinned tag of the reference project and build (default ref: v0.6.7 — see
# build.sh's own comment on why that specific tag may need adjusting).
sh explorer/build.sh

# Or build from an existing local checkout (no clone, no network):
SEMANTICA_SRC=/path/to/semantica-checkout sh explorer/build.sh

# Build into a scratch directory instead of replacing the committed placeholder:
EXPLORER_OUT_DIR=/tmp/explorer-dist sh explorer/build.sh
```

Requires `node`/`npm` (the reference project's own `explorer/package.json`
`engines`), and `git` when `SEMANTICA_SRC` is not set. **Run this under WSL, a
Linux host, or the Docker build stage below — not native Windows Git-Bash/MSYS**:
MSYS's automatic path conversion mangles the `--base=/explorer/`/`--outDir`
arguments passed to `vite build` (a Git-Bash-only artifact; the Docker build stage
and any real Linux host are unaffected).

Default output: `deploy/caddy/explorer-placeholder/` — the exact directory
`deploy/caddy/Dockerfile`'s `explorer-src-0` stage `COPY`s from when the build
never runs inside the image (see below). Running this script directly and then
`docker compose build caddy && docker compose up -d caddy` (leaving `EXPLORER_BUILD`
unset) is one way to deploy an Explorer update — see the "W4 closeout" note in the
next section for the other, now more common one — either way ends with the same
`docker compose build caddy && docker compose up -d caddy`, see
`docs/runbooks/host-explorer.md`.

## W4 closeout: the build now also happens inside `deploy/caddy/Dockerfile` itself

`deploy/caddy/Dockerfile` gained its own `explorer-build` stage that runs this
exact script (`explorer/build.sh`, COPYed in and executed verbatim — not
re-implemented) on a host with **Docker only**, no node/npm/git needed on the host
itself. It is gated behind a build arg, `EXPLORER_BUILD` (default `0`), so both
paths documented in this file keep working:

- `EXPLORER_BUILD=0` (default, unset) — **unchanged from before this closeout**:
  `docker compose build caddy` never clones or builds anything; it copies whatever
  `deploy/caddy/explorer-placeholder/` already holds (the committed placeholder, or
  a bundle this script already wrote there directly on the host, per "Usage" above).
- `EXPLORER_BUILD=1` — the Dockerfile's own `explorer-build` stage clones
  `SEMANTICA_REF` (default `v0.6.7`, a separate build arg) and builds it, entirely
  inside the image; the repo's own `deploy/caddy/explorer-placeholder/` directory is
  never read or written in this path.

See `docs/runbooks/host-explorer.md` for the full walkthrough of both.

## CI does not build this

`deploy/caddy/explorer-placeholder/` ships committed with a small static
`index.html` that says the bundle has not been built ("explorer bundle not built —
run `sh explorer/build.sh`"), so with the default `EXPLORER_BUILD=0`,
`deploy/caddy/Dockerfile`'s `COPY deploy/caddy/explorer-placeholder /out` always
succeeds — in CI, in a fresh checkout, or on a host that has never run
`build.sh` — without ever cloning the reference project or needing network access.
CI never passes `EXPLORER_BUILD=1` (it does not have network access to a project
this repo does not own), so it always takes this path.

## Deploy wiring

- `deploy/caddy/Caddyfile`: `handle_path /explorer/*` serves whatever
  `deploy/caddy/Dockerfile` copied into the image's `/srv/explorer` (see below) as
  static files, and a second `handle` block reverse-proxies the nine Explorer API
  paths to `kernel:8080` with an injected `X-API-Key` header (the unmodified
  Explorer bundle sends none itself — see that file's own comment for why, and
  `docs/runbooks/host-explorer.md` for how the key is provisioned).
- `deploy/caddy/Dockerfile`: picks one of two candidate stages by the
  `EXPLORER_BUILD` build arg (see "W4 closeout" above for what each one does) and
  `COPY`s its output into the final image's `/srv/explorer`.
