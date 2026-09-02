# @nexttime/egress-proxy

Forward proxy on the `control`/`workers` docker networks (design doc §7.9, §5.4 I10): plain HTTP
request forwarding and `CONNECT` tunnelling for HTTPS, no TLS interception, no content filtering.

## Env vars

| Var | Default | Meaning |
|---|---|---|
| `PROXY_PORT` | `3128` | Proxy listener, all interfaces. |
| `ADMIN_PORT` | `3129` | `GET /healthz`, loopback (`127.0.0.1`) only. |
| `KERNEL_URL` | — | Base URL for `POST ${KERNEL_URL}/internal/egress`; unset disables reporting. |
| `DENY_HOSTS` | `kernel,postgres,llm-proxy,egress-proxy,worker-supervisor,agent-host,caddy` | Comma-separated internal service names, always denied. |
| `NEXTTIME_SUBNET_CONTROL` / `NEXTTIME_SUBNET_WORKERS` | — | Platform subnets (CIDR), always denied. |
| `SOURCE_MAP_FILE` | — | Path to `{"<clientIp>": {"sourceId","allow"?,"deny"?}}`, hot-reloaded. |
| `MAX_TUNNELS_PER_SOURCE` | `32` | Concurrent tunnels per source. |
| `IDLE_TIMEOUT_MS` / `CONNECT_TIMEOUT_MS` | `120000` / `10000` | Per-tunnel idle and connect timeouts. |
| `ALLOW_LOOPBACK_FOR_TESTS` | unset | `1` treats loopback as allowed. **Test-only — never set in production.** |

## Policy (`src/policy.ts`)

Deny, in order (deny always beats allow): a source's own `deny` list (suffix match) → global
`DENY_HOSTS` (suffix match) → a bare hostname (no dot) unless explicitly on the source's `allow`
list → a source's `allow` list, when present, restricts to it. Otherwise: DNS is resolved *inside
the proxy*, every resolved address is classified, and only a public address (not RFC1918, loopback,
link-local, CGNAT, IPv6 unique-local, or a platform subnet) is connected to — always the address
just checked, never a re-resolved hostname, which defeats rebinding. Unknown source = public-allow.

## Agent containers / logging

Agent containers set `HTTP_PROXY`/`HTTPS_PROXY=http://egress-proxy:3128` and
`NO_PROXY=kernel,llm-proxy` (those reach `control` directly); `workers` stays `internal: true`, so
this proxy is the only route out. Every decision is a stdout JSON line — `sourceId`, `clientIp`,
`domain`, `port`, `protocol`, `allowed`, `reason`, `bytesUp`/`bytesDown`, `observedAt` — plus,
when `KERNEL_URL` is set, a best-effort batched `/internal/egress` POST (queued, retried with
backoff, never blocking a tunnel). `SOURCE_MAP_FILE` reloads via `fs.watch` on an in-place edit;
an atomic replace-by-rename may be missed — edit in place, or restart the container.
