.PHONY: lint test build typecheck depcruise ci migrate up down gen-models

lint:
	corepack pnpm -r lint

test:
	corepack pnpm -r test

build:
	corepack pnpm -r build

typecheck:
	corepack pnpm -r typecheck

depcruise:
	corepack pnpm depcruise

# R3 CI (docs/development-tasks.md R3): everything the `quality`/`test` GitHub Actions jobs run,
# plus the local guards (kernel purity + shell script LF/executable checks; gitleaks and the
# internal-IP guard run only in CI - see .github/workflows/ci.yml `guards` job).
ci: lint typecheck test build depcruise
	corepack pnpm ci:guards

# Runs the idempotent migration runner (packages/kernel/src/adapters/db/migrate.ts) against
# DATABASE_URL. Pass MIGRATE_ARGS=--dry-run to list pending migrations without applying them.
migrate:
	corepack pnpm --filter @nexttime/kernel build
	corepack pnpm --filter @nexttime/kernel run migrate -- $(MIGRATE_ARGS)

up:
	docker compose up -d

down:
	docker compose down

# Generates ${NEXTTIME_DATA}/config/models.json from ${NEXTTIME_DATA}/config/llm-providers.yaml
# (docs/graph-ai-middle-platform-design.md §7.7, §10.1; docs/development-tasks.md S1.5, second
# half, deliverable 5). Runs entirely through the built llm-proxy image
# (packages/llm-proxy/src/cli/gen-models.ts), not a local Node/corepack toolchain — the target
# deployment host has neither (docs/runbooks/host-worker-runtime.md §10 "the host has no
# corepack"). Requires NEXTTIME_DATA already exported in the calling shell (e.g. `set -a; . ./.env;
# set +a` first, same convention every host runbook already uses) — docker compose's own
# `${NEXTTIME_DATA}` substitution resolves the llm-proxy service's `llm-providers.yaml` read-only
# mount, and this recipe's redirect writes the result straight to the host path, no separate
# read-write mount needed (see gen-models.ts's own doc comment for why stdout, not a file).
gen-models:
	docker compose build llm-proxy
	docker compose run --rm --no-deps -T llm-proxy node dist/cli/gen-models.js > "$${NEXTTIME_DATA}/config/models.json"
