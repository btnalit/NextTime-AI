import { MetricsRegistry } from '@nexttime/shared';
import type { EgressObservation } from './report.js';

/**
 * metrics: egress-proxy's own `GET /internal/metrics` series (docs/STATUS.md leftover 87), served
 * by the loopback-only admin server (admin.ts) — never on the proxy port the `workers` network
 * reaches. One sample per egress decision this proxy records (`proxy.ts`'s `recordObservation`),
 * so the counters and the `EgressObserved` stream can never disagree.
 *
 *   nexttime_egress_requests_total{protocol,decision,reason}   counter
 *   nexttime_egress_bytes_total{protocol,direction}            counter
 *
 * `protocol` ∈ http | connect; `decision` ∈ allowed | denied; `reason` is policy.ts's fixed
 * `PolicyDenyReason` set plus `tunnel-limit` (empty when allowed); `direction` ∈ up | down.
 */

export interface EgressMetrics {
  recordObservation(observation: EgressObservation): void;
  render(): string;
}

export function createEgressMetrics(): EgressMetrics {
  const registry = new MetricsRegistry();
  const requests = registry.counter(
    'nexttime_egress_requests_total',
    'Egress requests decided by egress-proxy, by protocol, decision and deny reason.',
    ['protocol', 'decision', 'reason'],
  );
  const bytes = registry.counter(
    'nexttime_egress_bytes_total',
    'Bytes relayed for allowed egress, by protocol and direction.',
    ['protocol', 'direction'],
  );
  return {
    recordObservation(observation) {
      requests.inc({
        protocol: observation.protocol,
        decision: observation.allowed ? 'allowed' : 'denied',
        reason: observation.reason ?? '',
      });
      if (observation.bytesUp > 0) {
        bytes.inc({ protocol: observation.protocol, direction: 'up' }, observation.bytesUp);
      }
      if (observation.bytesDown > 0) {
        bytes.inc({ protocol: observation.protocol, direction: 'down' }, observation.bytesDown);
      }
    },
    render: () => registry.render(),
  };
}
