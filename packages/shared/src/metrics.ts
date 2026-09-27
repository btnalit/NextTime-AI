/**
 * metrics: a minimal Prometheus text-format (0.0.4) registry — counters, gauges and histograms with
 * fixed label names — for each long-running service's own `GET /internal/metrics` (docs/STATUS.md
 * leftover 87). Hand-rolled like the kernel's invariant metrics (`substrate/audit`'s
 * `renderInvariantMetricsPrometheus`) rather than a client library: seven processes need a few
 * counters each, and one small shared renderer keeps the exposition format identical everywhere
 * without a new runtime dependency in any service.
 *
 * Label values are caller-controlled strings, so every call site keeps them to a bounded set
 * (HTTP status, a configured provider/model, a published operation name, a fixed reason enum) —
 * never an id, a URL or free text. Values are escaped per the exposition format on render.
 *
 * IO-free (`packages/web` bundles this package); each service mounts `render()` behind its own
 * internal-plane guard.
 */

/** `Content-Type` of a Prometheus text-format exposition. */
export const PROMETHEUS_TEXT_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8' as const;

/** Upper bounds (seconds) for request / operation latencies — 5 ms to 5 min, covering both a
 *  cached gate read and a long LLM stream. */
export const DEFAULT_DURATION_BUCKETS_SECONDS: readonly number[] = [
  0.005, 0.025, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300,
];

export type MetricLabels = Readonly<Record<string, string>>;

const METRIC_NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LABEL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

function escapeHelp(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
}

function formatNumber(value: number): string {
  if (Number.isNaN(value)) return 'NaN';
  if (value === Number.POSITIVE_INFINITY) return '+Inf';
  if (value === Number.NEGATIVE_INFINITY) return '-Inf';
  return String(value);
}

function renderLabels(names: readonly string[], values: readonly string[], extra?: string): string {
  const parts = names.map((name, i) => `${name}="${escapeLabelValue(values[i] ?? '')}"`);
  if (extra !== undefined) parts.push(extra);
  return parts.length > 0 ? `{${parts.join(',')}}` : '';
}

abstract class Metric {
  readonly name: string;
  readonly help: string;
  readonly labelNames: readonly string[];

  constructor(name: string, help: string, labelNames: readonly string[]) {
    if (!METRIC_NAME.test(name)) throw new Error(`metrics: invalid metric name "${name}"`);
    for (const label of labelNames) {
      if (!LABEL_NAME.test(label) || label === 'le') {
        throw new Error(`metrics: invalid label name "${label}" on ${name}`);
      }
    }
    this.name = name;
    this.help = help;
    this.labelNames = labelNames;
  }

  /** Label values in `labelNames` order — a missing label renders as `""`, an extra one is
   *  ignored, so a call site can never produce a series with a different label set. */
  protected valuesOf(labels: MetricLabels | undefined): string[] {
    return this.labelNames.map((name) => labels?.[name] ?? '');
  }

  protected keyOf(values: readonly string[]): string {
    return JSON.stringify(values);
  }

  abstract readonly type: 'counter' | 'gauge' | 'histogram';
  abstract renderSeries(): string[];

  render(): string {
    const lines = [
      `# HELP ${this.name} ${escapeHelp(this.help)}`,
      `# TYPE ${this.name} ${this.type}`,
    ];
    lines.push(...this.renderSeries());
    return lines.join('\n');
  }
}

export class Counter extends Metric {
  readonly type = 'counter' as const;
  private readonly series = new Map<string, { values: string[]; value: number }>();

  inc(labels?: MetricLabels, by = 1): void {
    if (!(by >= 0)) throw new Error(`metrics: counter ${this.name} can only increase`);
    const values = this.valuesOf(labels);
    const key = this.keyOf(values);
    const current = this.series.get(key);
    if (current) current.value += by;
    else this.series.set(key, { values, value: by });
  }

  /** Current value of one series (0 when never incremented) — for tests and derived views. */
  get(labels?: MetricLabels): number {
    return this.series.get(this.keyOf(this.valuesOf(labels)))?.value ?? 0;
  }

  renderSeries(): string[] {
    return [...this.series.values()].map(
      (s) => `${this.name}${renderLabels(this.labelNames, s.values)} ${formatNumber(s.value)}`,
    );
  }
}

export class Gauge extends Metric {
  readonly type = 'gauge' as const;
  private readonly series = new Map<string, { values: string[]; value: number }>();

  set(labels: MetricLabels | undefined, value: number): void {
    const values = this.valuesOf(labels);
    this.series.set(this.keyOf(values), { values, value });
  }

  inc(labels?: MetricLabels, by = 1): void {
    this.set(labels, this.get(labels) + by);
  }

  dec(labels?: MetricLabels, by = 1): void {
    this.set(labels, this.get(labels) - by);
  }

  get(labels?: MetricLabels): number {
    return this.series.get(this.keyOf(this.valuesOf(labels)))?.value ?? 0;
  }

  renderSeries(): string[] {
    return [...this.series.values()].map(
      (s) => `${this.name}${renderLabels(this.labelNames, s.values)} ${formatNumber(s.value)}`,
    );
  }
}

interface HistogramSeries {
  readonly values: string[];
  readonly bucketCounts: number[];
  sum: number;
  count: number;
}

export class Histogram extends Metric {
  readonly type = 'histogram' as const;
  readonly buckets: readonly number[];
  private readonly series = new Map<string, HistogramSeries>();

  constructor(
    name: string,
    help: string,
    labelNames: readonly string[],
    buckets: readonly number[],
  ) {
    super(name, help, labelNames);
    const sorted = [...buckets].sort((a, b) => a - b);
    if (sorted.length === 0 || sorted.some((b, i) => i > 0 && b === sorted[i - 1])) {
      throw new Error(`metrics: histogram ${name} needs distinct buckets`);
    }
    this.buckets = sorted;
  }

  observe(labels: MetricLabels | undefined, value: number): void {
    const values = this.valuesOf(labels);
    const key = this.keyOf(values);
    let s = this.series.get(key);
    if (!s) {
      s = { values, bucketCounts: this.buckets.map(() => 0), sum: 0, count: 0 };
      this.series.set(key, s);
    }
    for (let i = 0; i < this.buckets.length; i++) {
      if (value <= (this.buckets[i] as number)) s.bucketCounts[i] = (s.bucketCounts[i] ?? 0) + 1;
    }
    s.sum += value;
    s.count += 1;
  }

  /** Observation count of one series — for tests. */
  count(labels?: MetricLabels): number {
    return this.series.get(this.keyOf(this.valuesOf(labels)))?.count ?? 0;
  }

  renderSeries(): string[] {
    const lines: string[] = [];
    for (const s of this.series.values()) {
      this.buckets.forEach((upper, i) => {
        lines.push(
          `${this.name}_bucket${renderLabels(this.labelNames, s.values, `le="${formatNumber(upper)}"`)} ${s.bucketCounts[i] ?? 0}`,
        );
      });
      lines.push(
        `${this.name}_bucket${renderLabels(this.labelNames, s.values, 'le="+Inf"')} ${s.count}`,
      );
      lines.push(
        `${this.name}_sum${renderLabels(this.labelNames, s.values)} ${formatNumber(s.sum)}`,
      );
      lines.push(`${this.name}_count${renderLabels(this.labelNames, s.values)} ${s.count}`);
    }
    return lines;
  }
}

/** One service's metric set. Registering a name twice is a programming error and throws. */
export class MetricsRegistry {
  private readonly metrics = new Map<string, Metric>();

  private add<M extends Metric>(metric: M): M {
    if (this.metrics.has(metric.name)) {
      throw new Error(`metrics: "${metric.name}" is already registered`);
    }
    this.metrics.set(metric.name, metric);
    return metric;
  }

  counter(name: string, help: string, labelNames: readonly string[] = []): Counter {
    return this.add(new Counter(name, help, labelNames));
  }

  gauge(name: string, help: string, labelNames: readonly string[] = []): Gauge {
    return this.add(new Gauge(name, help, labelNames));
  }

  histogram(
    name: string,
    help: string,
    labelNames: readonly string[] = [],
    buckets: readonly number[] = DEFAULT_DURATION_BUCKETS_SECONDS,
  ): Histogram {
    return this.add(new Histogram(name, help, labelNames, buckets));
  }

  /** The full exposition, newline-terminated. A metric with no series yet still renders its
   *  `# HELP` / `# TYPE` lines, so a scrape shows what the service exports from the first request. */
  render(): string {
    return `${[...this.metrics.values()].map((m) => m.render()).join('\n')}\n`;
  }
}
