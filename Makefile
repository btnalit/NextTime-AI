.PHONY: lint test build typecheck depcruise ci migrate up down gen-models demo

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
# Needs Node/corepack on this machine (dev box, CI) — a target host without them instead uses the
# containerized equivalent `docker compose run --rm --no-deps -T kernel node dist/cli/migrate.js`
# (docs/runbooks/operations.md §4.1; scripts/accept_s1.sh, scripts/accept_s2.sh).
migrate:
	corepack pnpm --filter @nexttime/kernel build
	corepack pnpm --filter @nexttime/kernel run migrate -- $(MIGRATE_ARGS)

up:
	docker compose up -d

down:
	docker compose down

# Generates ${NEXTTIME_DATA}/models/models.json from ${NEXTTIME_DATA}/config/llm-providers.yaml
# (docs/graph-ai-middle-platform-design.md §7.7, §10.1; docs/development-tasks.md S1.5, second
# half, deliverable 5; S7-A, docs/STATUS.md 维护者决定 2026-09-22 ⑤: models.json moved out of
# config/ into its own directory — do not chown config/). Runs entirely through the built
# llm-proxy image (packages/llm-proxy/src/cli/gen-models.ts), not a local Node/corepack toolchain
# — the target deployment host has neither (docs/runbooks/host-worker-runtime.md §10 "the host has
# no corepack"). Requires NEXTTIME_DATA already exported in the calling shell (e.g. `set -a; .
# ./.env; set +a` first, same convention every host runbook already uses) — docker compose's own
# `${NEXTTIME_DATA}` substitution resolves the llm-proxy service's `llm-providers.yaml` read-only
# mount, and this recipe's redirect writes the result straight to the host path, no separate
# read-write mount needed (see gen-models.ts's own doc comment for why stdout, not a file).
# `${NEXTTIME_DATA}/models/` itself is created by scripts/host-env-init.sh (0755, owned 10001).
#
# Writes to a `.tmp` sibling first, then `mv`s it into place (lane-6 review P3) — `models.json` is
# bind-mounted read-only into every entry/Worker container this Task/resident spawns; a direct
# redirect (`>`) truncates the real file the instant the shell opens it, so any failure partway
# through `docker compose run` (a crashed container, an interrupted `make gen-models`, a bad
# `llm-providers.yaml` the CLI only detects after writing some output) would previously leave a
# truncated/invalid `models.json` in place for every subsequent spawn to fail against, until the
# next successful `make gen-models`. `mv` within the same filesystem (both paths share
# `${NEXTTIME_DATA}`) is atomic — readers only ever see the old complete file or the new complete
# file, never a partial one. The `.tmp` file is removed on any failure so a failed run doesn't
# leave debris for the next one to trip over.
gen-models:
	docker compose build llm-proxy
	docker compose run --rm --no-deps -T llm-proxy node dist/cli/gen-models.js > "$${NEXTTIME_DATA}/models/models.json.tmp" \
		&& mv "$${NEXTTIME_DATA}/models/models.json.tmp" "$${NEXTTIME_DATA}/models/models.json" \
		|| { rm -f "$${NEXTTIME_DATA}/models/models.json.tmp"; exit 1; }

# S5.8 交付与演示闭环 item 3 (docs/development-tasks.md §S5.8): a 15-minute, single-command demo —
# ephemeral workspace → host-inventory collector run → three preset questions through the real
# entry agent → one-page Markdown result under ${NEXTTIME_DATA}/demo/. Doubles as an S5.7
# real-model scenario, so DEMO_MODEL is a real `<provider/model>` id and is never defaulted (same
# rule as scripts/accept_s2.sh/accept_s3.sh's own --real). See docs/runbooks/demo.md.
demo:
	@if [ -z "$(DEMO_MODEL)" ]; then \
		echo "make demo: DEMO_MODEL is required, e.g. DEMO_MODEL=<provider/model> make demo (see docs/runbooks/demo.md)" >&2; \
		exit 1; \
	fi
	sh scripts/demo.sh --model "$(DEMO_MODEL)"
