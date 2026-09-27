import { describe, expect, it } from 'vitest';
import { MetricsRegistry, PROMETHEUS_TEXT_CONTENT_TYPE } from './index.js';

describe('MetricsRegistry', () => {
  it('renders HELP/TYPE for a metric with no series yet', () => {
    const registry = new MetricsRegistry();
    registry.counter('svc_calls_total', 'Calls.', ['op']);
    expect(registry.render()).toBe(
      '# HELP svc_calls_total Calls.\n# TYPE svc_calls_total counter\n',
    );
    expect(PROMETHEUS_TEXT_CONTENT_TYPE).toContain('version=0.0.4');
  });

  it('counts per label set, in declared label order, with escaped values', () => {
    const registry = new MetricsRegistry();
    const calls = registry.counter('svc_calls_total', 'Calls.', ['op', 'status']);
    calls.inc({ status: '200', op: 'observe' });
    calls.inc({ op: 'observe', status: '200' });
    calls.inc({ op: 'a"b\\c\nd', status: '500' }, 3);
    expect(calls.get({ op: 'observe', status: '200' })).toBe(2);
    const text = registry.render();
    expect(text).toContain('svc_calls_total{op="observe",status="200"} 2');
    expect(text).toContain('svc_calls_total{op="a\\"b\\\\c\\nd",status="500"} 3');
  });

  it('ignores extra labels and fills missing ones, so the label set never varies', () => {
    const registry = new MetricsRegistry();
    const calls = registry.counter('svc_calls_total', 'Calls.', ['op']);
    calls.inc({ op: 'x', unexpected: 'y' });
    calls.inc({});
    const text = registry.render();
    expect(text).toContain('svc_calls_total{op="x"} 1');
    expect(text).toContain('svc_calls_total{op=""} 1');
    expect(text).not.toContain('unexpected');
  });

  it('refuses a decreasing counter, a duplicate name and an invalid name', () => {
    const registry = new MetricsRegistry();
    const calls = registry.counter('svc_calls_total', 'Calls.');
    expect(() => calls.inc(undefined, -1)).toThrow();
    expect(() => registry.counter('svc_calls_total', 'again')).toThrow();
    expect(() => registry.counter('bad-name', 'x')).toThrow();
    expect(() => registry.histogram('svc_h', 'x', ['le'])).toThrow();
  });

  it('tracks gauges up and down', () => {
    const registry = new MetricsRegistry();
    const active = registry.gauge('svc_active', 'Active.');
    active.inc();
    active.inc();
    active.dec();
    expect(active.get()).toBe(1);
    expect(registry.render()).toContain('svc_active 1');
  });

  it('renders cumulative histogram buckets, +Inf, sum and count', () => {
    const registry = new MetricsRegistry();
    const latency = registry.histogram('svc_seconds', 'Latency.', ['op'], [0.1, 1]);
    latency.observe({ op: 'x' }, 0.05);
    latency.observe({ op: 'x' }, 0.5);
    latency.observe({ op: 'x' }, 5);
    expect(latency.count({ op: 'x' })).toBe(3);
    const text = registry.render();
    expect(text).toContain('svc_seconds_bucket{op="x",le="0.1"} 1');
    expect(text).toContain('svc_seconds_bucket{op="x",le="1"} 2');
    expect(text).toContain('svc_seconds_bucket{op="x",le="+Inf"} 3');
    expect(text).toContain('svc_seconds_sum{op="x"} 5.55');
    expect(text).toContain('svc_seconds_count{op="x"} 3');
  });
});
