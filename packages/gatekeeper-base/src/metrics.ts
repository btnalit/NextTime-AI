import { MetricsRegistry } from '@nexttime/shared';

/**
 * metrics: a gate's own `GET /internal/metrics` series (docs/STATUS.md leftover 87) — one sample
 * per `/gate/*` protocol call, recorded by `server.ts`'s `registerGateRoutes`, so both a
 * single-gate server and the gate host get it. Labels stay bounded: `route` is the protocol route,
 * `operation` is only ever an Operation this gate actually publishes (anything else is empty),
 * `gate` is the hosted instance id on the gate host (empty on a single-gate server).
 *
 *   nexttime_gate_calls_total{gate,route,operation,status}           counter
 *   nexttime_gate_call_duration_seconds{gate,route,operation}        histogram
 *
 * `route` ∈ observe | simulate | apply | revert | describe_operations | health |
 * connected-accounts; `status` is the HTTP status the gate answered with.
 */

export interface GateCallSample {
  readonly gate: string;
  readonly route: string;
  readonly operation: string;
  readonly status: number;
  readonly durationSeconds: number;
}

export interface GateMetrics {
  recordCall(sample: GateCallSample): void;
  render(): string;
}

export function createGateMetrics(): GateMetrics {
  const registry = new MetricsRegistry();
  const calls = registry.counter(
    'nexttime_gate_calls_total',
    'Gate protocol calls, by route, published operation and HTTP status.',
    ['gate', 'route', 'operation', 'status'],
  );
  const duration = registry.histogram(
    'nexttime_gate_call_duration_seconds',
    'Gate protocol call time, by route and published operation.',
    ['gate', 'route', 'operation'],
  );
  return {
    recordCall(sample) {
      const labels = { gate: sample.gate, route: sample.route, operation: sample.operation };
      calls.inc({ ...labels, status: String(sample.status) });
      duration.observe(labels, sample.durationSeconds);
    },
    render: () => registry.render(),
  };
}
