# @nexttime/egress-proxy

Forward proxy on the `control`/`workers` docker networks (design doc §7.9, §5.4 I10): plain HTTP
request forwarding and `CONNECT` tunnelling for HTTPS, no TLS interception, no content filtering.

## Env vars

| Var | Default | Meaning |
|---|---|---|
| `PROXY_PORT` | `3128` | Proxy listener, all interfaces. |
| `ADMIN_PORT` | `3129` | `GET /healthz`, loopback (`127.0.0.1`) only. |
| `KERNEL_URL` | — | Base URL for `POST ${KERNEL_URL}/internal/egress`; unset disables reporting. |
| `DENY_HOSTS` | `kernel,postgres,llm-proxy,egress-proxy,worker-supervisor,agent-host,caddy` | Comma-separated internal service names, always denied. Overriding it replaces only this list. |
| (built-in) | `localhost,local,lan,home.arpa,internal` | Private-network name suffixes (RFC 6761/6762/8375, ICANN `.internal`, de-facto `.lan`), always denied by name — needed because on a fake-IP host (below) a LAN name resolves into the trusted range too. |
| `EGRESS_DENY_HOST_SUFFIXES` | — | Comma-separated extra suffixes appended to the deny list (your site's own LAN domain, e.g. `corp.example`). |
| `NEXTTIME_SUBNET_CONTROL` / `NEXTTIME_SUBNET_WORKERS` | — | Platform subnets (CIDR), always denied. |
| `EGRESS_TRUSTED_RESOLVED_CIDRS` | — | Comma-separated CIDRs owned by a transparent ("fake-IP") proxy on the host network: a **hostname** resolving into one of them is treated as public (the range is the transparent proxy, not a real internal host). Literal-IP targets in the range and the platform subnets are still denied. Unset on a normal network. |
| `SOURCE_MAP_FILE` | — | Path to `{"<clientIp>": {"sourceId","allow"?,"deny"?}}`, hot-reloaded. |
| `MAX_TUNNELS_PER_SOURCE` | `32` | Concurrent tunnels per source. |
| `IDLE_TIMEOUT_MS` / `CONNECT_TIMEOUT_MS` | `120000` / `10000` | Per-tunnel idle and connect timeouts. |
| `ALLOW_LOOPBACK_FOR_TESTS` | unset | `1` treats loopback as allowed. **Test-only — never set in production.** |

## Policy (`src/policy.ts`)

Deny, in order (deny always beats allow): a source's own `deny` list (suffix match) → global
`DENY_HOSTS` + the built-in private suffixes + `EGRESS_DENY_HOST_SUFFIXES` (suffix match, before
any DNS lookup) → a bare hostname (no dot) unless explicitly on the source's `allow`
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
