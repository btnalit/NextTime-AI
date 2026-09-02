#!/bin/sh
# host-preflight.sh — read-only target-host preflight check for NextTime-AI.
#
# The only exception to "read-only" is one throwaway container run
# (`docker run --rm --runtime=runsc alpine:3.20 true`), which is the E1
# gVisor verification itself. Nothing is written to the host filesystem.
#
# POSIX sh (tested against dash). Usage:
#   NEXTTIME_DATA=/path/to/data sh host-preflight.sh
#   ssh <TARGET_HOST> 'NEXTTIME_DATA=/path/to/data sh -s' < scripts/host-preflight.sh
#
# Exit code: 0 if no FAIL row was printed, 1 otherwise.

PASS_COUNT=0
WARN_COUNT=0
FAIL_COUNT=0

row() {
  # row STATUS CHECK DETAIL
  case "$1" in
    PASS) PASS_COUNT=$((PASS_COUNT + 1)) ;;
    WARN) WARN_COUNT=$((WARN_COUNT + 1)) ;;
    FAIL) FAIL_COUNT=$((FAIL_COUNT + 1)) ;;
  esac
  printf '%-4s | %-26s | %s\n' "$1" "$2" "$3"
}

if [ -z "${NEXTTIME_DATA:-}" ]; then
  echo "FAIL: NEXTTIME_DATA is required, e.g. NEXTTIME_DATA=/path/to/data sh $0" >&2
  exit 1
fi

echo "NextTime-AI host preflight"
echo "NEXTTIME_DATA=$NEXTTIME_DATA"
echo
printf '%-4s | %-26s | %s\n' "STAT" "CHECK" "DETAIL"
printf -- '-----+----------------------------+--------------------------------------------\n'

have_docker=0
if command -v docker >/dev/null 2>&1; then
  have_docker=1
fi

# 1. Docker Engine version + Compose v2 version
if [ "$have_docker" = 1 ]; then
  docker_version=$(docker version --format '{{.Server.Version}}' 2>/dev/null)
  if [ -n "$docker_version" ]; then
    row PASS "docker-engine-version" "Server $docker_version"
  else
    row FAIL "docker-engine-version" "docker present but daemon unreachable (permissions? not running?)"
    have_docker=0
  fi
else
  row FAIL "docker-engine-version" "docker not found in PATH"
fi

if [ "$have_docker" = 1 ]; then
  compose_version=$(docker compose version --short 2>/dev/null)
  if [ -n "$compose_version" ]; then
    row PASS "compose-v2-version" "$compose_version"
  else
    row FAIL "compose-v2-version" "'docker compose' (v2 plugin) not available"
  fi
else
  row FAIL "compose-v2-version" "skipped: docker unavailable"
fi

# 2. whether runsc is a configured runtime
runsc_configured=0
if [ "$have_docker" = 1 ]; then
  runtimes_json=$(docker info --format '{{json .Runtimes}}' 2>/dev/null)
  if echo "$runtimes_json" | grep -q '"runsc"'; then
    row PASS "runsc-configured" "runsc present in docker info Runtimes"
    runsc_configured=1
  else
    row WARN "runsc-configured" "runsc not listed in docker info Runtimes"
  fi
else
  row WARN "runsc-configured" "skipped: docker unavailable"
fi

# 3. actual run test (this is the E1 verification) + fallback WORKER_RUNTIME
worker_runtime=runc
if [ "$have_docker" = 1 ]; then
  runsc_output=$(docker run --rm --runtime=runsc alpine:3.20 true 2>&1)
  runsc_ec=$?
  if [ "$runsc_ec" -eq 0 ]; then
    row PASS "runsc-run-test (E1)" "docker run --rm --runtime=runsc alpine:3.20 true -> exit=0"
    worker_runtime=runsc
  else
    detail=$(printf '%s' "$runsc_output" | tr '\n' ' ' | cut -c1-180)
    row FAIL "runsc-run-test (E1)" "exit=$runsc_ec: $detail"
    worker_runtime=runc
  fi
else
  row FAIL "runsc-run-test (E1)" "skipped: docker unavailable"
fi
echo "WORKER_RUNTIME=$worker_runtime"

# 4. host ports free: 8443 8080 5432 8081
if command -v ss >/dev/null 2>&1; then
  ss_output=$(ss -tlnp 2>/dev/null || ss -tln 2>/dev/null)
  for port in 8443 8080 5432 8081; do
    hit=$(printf '%s\n' "$ss_output" | awk -v want=":$port" '
      { f = $4; n = length(f); m = length(want)
        if (n >= m && substr(f, n - m + 1) == want) print }' | head -1)
    if [ -n "$hit" ]; then
      row WARN "port-$port-free" "in use: $hit"
    else
      row PASS "port-$port-free" "free"
    fi
  done
else
  row WARN "ports-check" "ss not found; skipped 8443/8080/5432/8081"
fi

# 5. free disk at the parent of $NEXTTIME_DATA (warn < 50G)
parent_dir=$(dirname "$NEXTTIME_DATA")
check_dir="$parent_dir"
while [ ! -d "$check_dir" ] && [ "$check_dir" != "/" ] && [ -n "$check_dir" ]; do
  check_dir=$(dirname "$check_dir")
done
if [ -d "$check_dir" ] && command -v df >/dev/null 2>&1; then
  avail_kb=$(df -Pk "$check_dir" 2>/dev/null | awk 'NR==2{print $4}')
  if [ -n "$avail_kb" ]; then
    avail_gb=$((avail_kb / 1024 / 1024))
    if [ "$avail_gb" -lt 50 ]; then
      row WARN "free-disk-at-parent" "${avail_gb}G available at $check_dir (< 50G)"
    else
      row PASS "free-disk-at-parent" "${avail_gb}G available at $check_dir"
    fi
  else
    row WARN "free-disk-at-parent" "df failed for $check_dir"
  fi
else
  row WARN "free-disk-at-parent" "no existing ancestor dir found / df missing"
fi

# 6. memory available (warn < 4G)
if [ -r /proc/meminfo ]; then
  mem_avail_kb=$(awk '/^MemAvailable:/{print $2}' /proc/meminfo)
  if [ -n "$mem_avail_kb" ]; then
    gb_x10=$((mem_avail_kb * 10 / 1024 / 1024))
    whole=$((gb_x10 / 10))
    dec=$((gb_x10 % 10))
    if [ "$gb_x10" -lt 40 ]; then
      row WARN "memory-available" "${whole}.${dec}G available (< 4G)"
    else
      row PASS "memory-available" "${whole}.${dec}G available"
    fi
  else
    row WARN "memory-available" "MemAvailable not found in /proc/meminfo"
  fi
else
  row WARN "memory-available" "/proc/meminfo not readable"
fi

# 7. existing Docker network subnets in use
if [ "$have_docker" = 1 ]; then
  net_ids=$(docker network ls -q 2>/dev/null)
  if [ -n "$net_ids" ]; then
    subnets=""
    for net in $net_ids; do
      name=$(docker network inspect "$net" --format '{{.Name}}' 2>/dev/null)
      subs=$(docker network inspect "$net" --format '{{range .IPAM.Config}}{{.Subnet}} {{end}}' 2>/dev/null)
      if [ -n "$subs" ]; then
        subnets="${subnets}${name}=${subs}; "
      fi
    done
    if [ -n "$subnets" ]; then
      row PASS "docker-network-subnets" "$subnets"
    else
      row PASS "docker-network-subnets" "no subnets configured on existing networks"
    fi
  else
    row WARN "docker-network-subnets" "docker network ls returned nothing"
  fi
else
  row WARN "docker-network-subnets" "skipped: docker unavailable"
fi

# 8. nproc
if command -v nproc >/dev/null 2>&1; then
  row PASS "cpu-count" "$(nproc) cores"
else
  cpus=$(grep -c ^processor /proc/cpuinfo 2>/dev/null)
  row PASS "cpu-count" "${cpus:-unknown} cores (via /proc/cpuinfo)"
fi

# 9. whether $NEXTTIME_DATA exists yet (info only, never fails)
if [ -d "$NEXTTIME_DATA" ]; then
  row PASS "nexttime-data-exists" "$NEXTTIME_DATA exists"
else
  row PASS "nexttime-data-exists" "$NEXTTIME_DATA does not exist yet (expected before E2)"
fi

echo
echo "SUMMARY: PASS=$PASS_COUNT WARN=$WARN_COUNT FAIL=$FAIL_COUNT"

if [ "$FAIL_COUNT" -gt 0 ]; then
  exit 1
fi
exit 0
