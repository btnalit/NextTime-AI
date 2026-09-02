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
# (docs/graph-ai-middle-platform-design.md §7.7, §10.1; docs/development-tasks.md S1.7). Builds
# @nexttime/llm-proxy first — scripts/gen-models-json.ts imports its built dist output, not the
# TS source, so this works the same regardless of which Node 22.x patch runs it.
gen-models:
	corepack pnpm --filter @nexttime/llm-proxy build
	node scripts/gen-models-json.ts
