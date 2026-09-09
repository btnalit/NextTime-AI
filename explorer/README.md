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
`deploy/caddy/Dockerfile`'s `caddy` build stage already `COPY`s into `/srv/explorer`
(see that Dockerfile's own comment). Running this script and then
`docker compose build caddy && docker compose up -d caddy` is the whole deploy step
for an Explorer update — see `docs/runbooks/host-explorer.md`.

## CI does not build this

`deploy/caddy/explorer-placeholder/` ships committed with a small static
`index.html` that says the bundle has not been built ("explorer bundle not built —
run `sh explorer/build.sh`"), so `deploy/caddy/Dockerfile`'s `COPY
deploy/caddy/explorer-placeholder /srv/explorer` always succeeds — in CI, in a
fresh checkout, or on a host that has never run `build.sh` — without ever cloning
the reference project or needing network access from CI. Running `build.sh`
replaces that placeholder's contents with the real built bundle; nothing about the
Dockerfile changes either way.

## Deploy wiring

- `deploy/caddy/Caddyfile`: `handle_path /explorer/*` serves
  `deploy/caddy/explorer-placeholder`'s built contents (via the image's
  `/srv/explorer`, see below) as static files, and a second `handle` block
  reverse-proxies the nine Explorer API paths to `kernel:8080` with an injected
  `X-API-Key` header (the unmodified Explorer bundle sends none itself — see that
  file's own comment for why, and `docs/runbooks/host-explorer.md` for how the key
  is provisioned).
- `deploy/caddy/Dockerfile`: a `caddy` build stage `COPY`s
  `deploy/caddy/explorer-placeholder` (whatever it currently holds — placeholder or
  real build) into the image's `/srv/explorer`.
