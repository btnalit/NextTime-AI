/**
 * lib/ws-url: same-origin `/ws` URL (design doc §7.6 "一个 WebSocket"; deploy/caddy/Caddyfile
 * reverse-proxies `/ws` to the kernel on the same origin as the static site). Never a hard-coded
 * host — production is `wss://<host>:8443/ws` behind caddy, dev is `ws://localhost:<vite-port>/ws`
 * proxied to `KERNEL_DEV_URL` by vite.config.ts's dev server proxy.
 */
export function wsUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws`;
}
