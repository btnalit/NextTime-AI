#!/bin/sh
# update-feed.sh — the `update-feed` compose service (S10 U1, docs/s10-evolution-plan-2026-10-04.md
# §4.2): downloads the ReleaseChannel record `channel.json` from the repository's rolling `channel`
# pre-release once a day and drops it where the kernel reads it (`platform_updates`). A dumb fetch
# on purpose: it never parses the file — the kernel validates it on every read — and it holds no
# credential, no Docker socket and no other mount than its own output directory.
#
# Never overwrites a good file with a bad download: curl writes a temp file in the same directory,
# which replaces channel.json (atomic rename) only after curl succeeded within the size cap. A
# failed download keeps the previous file and therefore its old modification time, which is what
# the kernel's freshness check ("版本信息已 2 天未更新") reads. Failures retry hourly.
#
# Env: UPDATE_FEED_URL (required, https only), UPDATE_FEED_DIR (default /data/update-feed),
#      UPDATE_FEED_INTERVAL_SECONDS (default 86400), UPDATE_FEED_RETRY_SECONDS (default 3600).
set -u

URL=${UPDATE_FEED_URL:?UPDATE_FEED_URL is required}
OUT_DIR=${UPDATE_FEED_DIR:-/data/update-feed}
INTERVAL=${UPDATE_FEED_INTERVAL_SECONDS:-86400}
RETRY=${UPDATE_FEED_RETRY_SECONDS:-3600}
# Kept equal to RELEASE_CHANNEL_MAX_BYTES (@nexttime/shared release-channel.ts).
MAX_BYTES=65536

log() {
  printf '%s update-feed: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"
}

fetch_once() {
  tmp="$OUT_DIR/.channel.json.tmp"
  rm -f "$tmp"
  if ! curl --fail --silent --show-error --location --max-redirs 5 \
    --proto '=https' --proto-redir '=https' --max-time 60 --max-filesize "$MAX_BYTES" \
    --output "$tmp" "$URL"; then
    log "download failed; keeping the previous channel.json"
    rm -f "$tmp"
    return 1
  fi
  size=$(wc -c <"$tmp")
  if [ "$size" -eq 0 ] || [ "$size" -gt "$MAX_BYTES" ]; then
    log "rejected a ${size}-byte download (limit ${MAX_BYTES}); keeping the previous channel.json"
    rm -f "$tmp"
    return 1
  fi
  chmod 0644 "$tmp"
  mv -f "$tmp" "$OUT_DIR/channel.json"
  log "downloaded channel.json (${size} bytes)"
}

case "$URL" in
  https://*) ;;
  *)
    log "UPDATE_FEED_URL must be https:// — refusing to start"
    exit 1
    ;;
esac

# The shell is PID 1: without a trap it ignores SIGTERM and `docker compose stop` waits its full
# timeout before SIGKILL. Sleep in the background and `wait` so the trap runs at once.
trap 'log "stopping"; [ -n "${pause:-}" ] && kill "$pause" 2>/dev/null; exit 0' TERM INT

log "fetching $URL every ${INTERVAL}s into $OUT_DIR"
while :; do
  if fetch_once; then
    sleep "$INTERVAL" &
  else
    sleep "$RETRY" &
  fi
  pause=$!
  wait "$pause"
done
