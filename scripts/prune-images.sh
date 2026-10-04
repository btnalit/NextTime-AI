#!/bin/sh
# prune-images.sh — image retention for THIS project's images on the host. POSIX sh, run ON THE
# HOST from the checkout root (same conventions as scripts/sweep-accept-entry-containers.sh: dry run
# by default, every candidate listed before anything is removed, `--yes` required to remove).
#
# Every release pulls (or builds) eleven images and keeps the previous ones: by v0.41.0 the host
# held eight releases of each (~2.8 GB per release, worker-runtime alone 1.2 GB) plus old
# worker-runtime rollback tags. scripts/apply-release.sh runs this with `--yes` after acceptance,
# so the host keeps a bounded set; it can also be run by hand.
#
# Scope — only images that are provably this project's:
#   - repositories named `nexttime-ai-*` (the compose names) or `ghcr.io/<owner>/nexttime-ai-*`
#     (the published images, scripts/pull-images.sh);
#   - dangling images carrying this project's `ai.nexttime.built-from` label.
#   Anything else on the host (other projects' images, unlabelled dangling images, the build
#   cache) is never touched — those are reported, and removing them is the operator's decision.
#
# Always kept:
#   - every image a container uses, running or stopped;
#   - every image with a `latest` tag (the compose names the running stack and the next `up` use;
#     the acceptance fixtures are rebuilt only when missing, so keeping them saves a build);
#   - every image tagged with one of the newest KEEP release versions (`vX.Y.Z`, default 2: the
#     current release and the one a rollback goes back to — release.md §5), plus the checkout's
#     own tag if it is an older one (a host that rolled back);
#   - the platform setting `activeRuntimeImage` and the previous distinct value in its history
#     (what `rollback_runtime_image` switches back to — docs/runbooks/pi-upgrade.md).
# Removed: every other tag in scope (old `vX.Y.Z`, `pi-*`, `pre-*` tags) whose image is not kept,
# then this project's labelled dangling images that no container uses. An image goes only when its
# last tag goes, so a kept image's extra tags (e.g. `pi-<version>` on the current runtime) stay.
#
# Usage:
#   sh scripts/prune-images.sh                 # dry run: prints what would be removed and why kept
#   sh scripts/prune-images.sh --yes           # removes the listed tags / dangling images
#   sh scripts/prune-images.sh --keep 3 --yes  # keep three releases instead of two
set -u

YES=0
KEEP=2
while [ "$#" -gt 0 ]; do
	case "$1" in
		--yes) YES=1 ;;
		--keep)
			shift
			KEEP=${1:-}
			case "$KEEP" in '' | *[!0-9]*) echo "prune-images: --keep needs a number" >&2; exit 2 ;; esac
			[ "$KEEP" -ge 1 ] || { echo "prune-images: --keep must be at least 1" >&2; exit 2; }
			;;
		*) echo "usage: sh scripts/prune-images.sh [--keep N] [--yes]" >&2; exit 2 ;;
	esac
	shift
done
[ -f docker-compose.yml ] || { echo "prune-images: run from the checkout root (docker-compose.yml not found)" >&2; exit 2; }

TMP=$(mktemp -d /tmp/prune-images.XXXXXX) || exit 1
trap 'rm -rf "$TMP"' EXIT

SCOPE='^(ghcr\.io/[^/]+/)?nexttime-ai-'

# All in-scope tags: "<repo>:<tag> <full image id>"
docker images --no-trunc --format '{{.Repository}}:{{.Tag}} {{.ID}}' |
	awk -v scope="$SCOPE" '{ n = split($1, p, ":"); repo = substr($1, 1, length($1) - length(p[n]) - 1) }
		repo ~ scope && $1 !~ /:<none>$/ { print }' >"$TMP/tags"

# Release versions present, newest KEEP kept (plus the checkout's own tag).
sed -n 's/^[^ ]*:\(v[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\) .*/\1/p' "$TMP/tags" | sort -u -V | tail -n "$KEEP" >"$TMP/versions"
current=$(git describe --tags --exact-match HEAD 2>/dev/null || true)
case "$current" in v[0-9]*) echo "$current" >>"$TMP/versions" ;; esac
sort -u "$TMP/versions" -o "$TMP/versions"

# Keep set (full image ids).
: >"$TMP/keep"
ids=$(docker ps -aq)
[ -n "$ids" ] && docker inspect --format '{{.Image}}' $ids >>"$TMP/keep" 2>/dev/null
awk '$1 ~ /:latest$/ { print $2 }' "$TMP/tags" >>"$TMP/keep"
while read -r v; do
	awk -v v="$v" '{ n = split($1, p, ":"); if (p[n] == v) print $2 }' "$TMP/tags" >>"$TMP/keep"
done <"$TMP/versions"
# activeRuntimeImage and its previous distinct value (rollback_runtime_image's target).
docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At' >"$TMP/runtime-refs" 2>/dev/null <<'SQL'
select settings ->> 'activeRuntimeImage' from platform_settings where settings ? 'activeRuntimeImage';
select settings ->> 'activeRuntimeImage' from platform_settings_history
 where settings ? 'activeRuntimeImage' order by version desc limit 3;
SQL
while read -r ref; do
	[ -n "$ref" ] || continue
	docker image inspect --format '{{.Id}}' "$ref" >>"$TMP/keep" 2>/dev/null || true
done <"$TMP/runtime-refs"
sort -u "$TMP/keep" -o "$TMP/keep"

# Tags to remove: in scope, image not kept.
awk 'NR == FNR { keep[$1] = 1; next } !($2 in keep) { print $1 }' "$TMP/keep" "$TMP/tags" | sort >"$TMP/remove-tags"
# This project's labelled dangling images no container uses.
docker images --no-trunc -q -f dangling=true -f label=ai.nexttime.built-from | sort -u |
	awk 'NR == FNR { keep[$1] = 1; next } !($1 in keep)' "$TMP/keep" - >"$TMP/remove-dangling"

bytes_of() { docker image inspect --format '{{.Size}}' "$1" 2>/dev/null || echo 0; }
total=0
while read -r t; do total=$((total + $(bytes_of "$t"))); done <"$TMP/remove-tags"
while read -r d; do total=$((total + $(bytes_of "$d"))); done <"$TMP/remove-dangling"

echo "prune-images: keeping releases $(tr '\n' ' ' <"$TMP/versions")(keep=$KEEP), $(wc -l <"$TMP/keep") image ids protected"
echo "prune-images: $(wc -l <"$TMP/remove-tags") tag(s) and $(wc -l <"$TMP/remove-dangling") dangling image(s) to remove, about $((total / 1048576)) MiB (shared layers count once on disk, so the real gain can be lower)"
sed 's/^/  remove tag /' "$TMP/remove-tags"
sed 's/^/  remove dangling /' "$TMP/remove-dangling"
others=$(docker images -q -f dangling=true | wc -l)
echo "prune-images: not touched — $((others - $(wc -l <"$TMP/remove-dangling"))) unlabelled dangling image(s) and the build cache (operator's decision: docker image prune / docker builder prune)"

if [ "$YES" -ne 1 ]; then
	echo "prune-images: dry run — re-run with --yes to remove"
	exit 0
fi
failed=0
while read -r t; do docker image rm "$t" >/dev/null 2>&1 || { echo "  could not remove $t"; failed=$((failed + 1)); }; done <"$TMP/remove-tags"
while read -r d; do docker image rm "$d" >/dev/null 2>&1 || { echo "  could not remove $d"; failed=$((failed + 1)); }; done <"$TMP/remove-dangling"
echo "prune-images: done, $failed failure(s)"
