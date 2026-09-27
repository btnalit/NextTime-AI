import { timingSafeEqual } from 'node:crypto';
import type http from 'node:http';
import { MetricsRegistry, PROMETHEUS_TEXT_CONTENT_TYPE } from '@nexttime/shared';

/**
 * metrics: llm-proxy's own `GET /internal/metrics` series (docs/STATUS.md leftover 87), rendered by
 * `@nexttime/shared`'s Prometheus text registry. Labels stay bounded: `provider` is a configured
 * provider id (anything else is `unknown`), `model` is a model on that provider's allowlist (else
 * empty), `status` is the HTTP status this proxy answered with.
 *
 *   nexttime_llm_proxy_requests_total{provider,model,status}                counter
 *   nexttime_llm_proxy_upstream_duration_seconds{provider,model,outcome}    histogram
 *   nexttime_llm_proxy_tokens_total{provider,model,direction}               counter
 *
 * `outcome` ∈ completed | error (upstream non-2xx, a broken stream, or no connection at all);
 * `direction` ∈ input | output. Only model-traffic requests are counted — not `/healthz`,
 * `/internal/metrics` or the provider-admin API.
 */

export interface LlmProxyMetrics {
  recordRequest(provider: string, model: string, status: number): void;
  observeUpstream(provider: string, model: string, outcome: string, seconds: number): void;
  recordTokens(provider: string, model: string, input: number, output: number): void;
  render(): string;
}

export function createLlmProxyMetrics(): LlmProxyMetrics {
  const registry = new MetricsRegistry();
  const requests = registry.counter(
    'nexttime_llm_proxy_requests_total',
    'Model-traffic requests answered by llm-proxy, by provider, model and HTTP status.',
    ['provider', 'model', 'status'],
  );
  const upstream = registry.histogram(
    'nexttime_llm_proxy_upstream_duration_seconds',
    'Upstream provider call time, from sending the request to the end of the response stream.',
    ['provider', 'model', 'outcome'],
  );
  const tokens = registry.counter(
    'nexttime_llm_proxy_tokens_total',
    'Tokens reported by upstream providers, by direction.',
    ['provider', 'model', 'direction'],
  );
  return {
    recordRequest(provider, model, status) {
      requests.inc({ provider, model, status: String(status) });
    },
    observeUpstream(provider, model, outcome, seconds) {
      upstream.observe({ provider, model, outcome }, seconds);
    },
    recordTokens(provider, model, input, output) {
      if (input > 0) tokens.inc({ provider, model, direction: 'input' }, input);
      if (output > 0) tokens.inc({ provider, model, direction: 'output' }, output);
    },
    render: () => registry.render(),
  };
}

function headerMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Answers `GET /internal/metrics`: 200 Prometheus text for the internal-plane `Authorization`
 * value (`Bearer <internal_token>`, constant-time compared), 401 otherwise — including when this
 * proxy has no internal token at all (no `KERNEL_URL` configured): fail-closed, like the kernel's
 * own internal plane. The proxy port is reachable from the `workers` network, which never holds
 * the internal token.
 */
export function respondMetrics(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  options: { readonly authorizationHeader: string | undefined; readonly render: () => string },
): void {
  const presented = req.headers.authorization;
  if (
    options.authorizationHeader === undefined ||
    typeof presented !== 'string' ||
    !headerMatches(presented, options.authorizationHeader)
  ) {
    res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer' });
    res.end(JSON.stringify({ error: { code: 'unauthorized', message: 'unauthorized' } }));
    return;
  }
  res.writeHead(200, { 'content-type': PROMETHEUS_TEXT_CONTENT_TYPE });
  res.end(options.render());
}
