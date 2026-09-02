#!/usr/bin/env bash
# Starts an ephemeral pgvector/pgvector:pg17 container for integration tests (R2+). Degrades
# gracefully with a clear message when Docker is not available, instead of failing the whole
# test run — see docs/development-tasks.md §0.3 and R1's acceptance notes.
set -euo pipefail

CONTAINER_NAME="${TEST_DB_CONTAINER_NAME:-nexttime-test-db}"
IMAGE="pgvector/pgvector:pg17"
PORT="${TEST_DB_PORT:-55432}"
DB_NAME="${TEST_DB_NAME:-nexttime_test}"
DB_USER="${TEST_DB_USER:-nexttime}"
DB_PASSWORD="${TEST_DB_PASSWORD:-nexttime}"

if ! command -v docker >/dev/null 2>&1; then
  echo "scripts/test-db.sh: docker is not installed on this host." >&2
  echo "scripts/test-db.sh: skipping — tests that need Postgres will be skipped or must point" >&2
  echo "scripts/test-db.sh: TEST_DATABASE_URL at an already-running Postgres instance." >&2
  exit 0
fi

if ! docker info >/dev/null 2>&1; then
  echo "scripts/test-db.sh: docker is installed but the daemon is not reachable." >&2
  echo "scripts/test-db.sh: skipping — tests that need Postgres will be skipped." >&2
  exit 0
fi

docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true

echo "scripts/test-db.sh: starting ephemeral $IMAGE as $CONTAINER_NAME on port $PORT ..."
docker run -d \
  --name "$CONTAINER_NAME" \
  -e "POSTGRES_DB=$DB_NAME" \
  -e "POSTGRES_USER=$DB_USER" \
  -e "POSTGRES_PASSWORD=$DB_PASSWORD" \
  -p "127.0.0.1:${PORT}:5432" \
  "$IMAGE" >/dev/null

echo "scripts/test-db.sh: waiting for Postgres to accept connections ..."
ready=0
for _ in $(seq 1 30); do
  if docker exec "$CONTAINER_NAME" pg_isready -U "$DB_USER" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done

if [ "$ready" -ne 1 ]; then
  echo "scripts/test-db.sh: Postgres did not become ready in time." >&2
  docker logs "$CONTAINER_NAME" >&2 || true
  exit 1
fi

echo "scripts/test-db.sh: ready."
echo "scripts/test-db.sh: TEST_DATABASE_URL=postgres://${DB_USER}:${DB_PASSWORD}@127.0.0.1:${PORT}/${DB_NAME}"
