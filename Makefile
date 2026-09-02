.PHONY: lint test build typecheck depcruise migrate up down gen-models

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

# Runs the idempotent migration runner (packages/kernel/src/adapters/db/migrate.ts) against
# DATABASE_URL. Pass MIGRATE_ARGS=--dry-run to list pending migrations without applying them.
migrate:
	corepack pnpm --filter @nexttime/kernel build
	corepack pnpm --filter @nexttime/kernel run migrate -- $(MIGRATE_ARGS)

up:
	docker compose up -d

down:
	docker compose down

# TODO(S3): scripts/gen-models-json.ts (docs/graph-ai-middle-platform-design.md §7.7, §10.1).
gen-models:
	@echo "TODO(S3): generate models.json from \$$NEXTTIME_DATA/config/llm-providers.yaml (scripts/gen-models-json.ts)"
