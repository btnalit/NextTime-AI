import { MetricsRegistry } from '@nexttime/shared';
import type { TaskFinishedEvent } from './task-service.js';

/**
 * metrics: worker-supervisor's own `GET /internal/metrics` series (docs/STATUS.md leftover 87),
 * rendered by `@nexttime/shared`'s Prometheus text registry. Label values are bounded: a fixed
 * operation name, an outcome derived from the HTTP status, a terminal Task state.
 *
 *   nexttime_supervisor_operations_total{operation,outcome}      counter
 *   nexttime_supervisor_operation_duration_seconds{operation}    histogram
 *   nexttime_supervisor_task_exits_total{state}                  counter
 *
 * `operation` ∈ task_spawn | task_terminate | resident_spawn | resident_stop | resident_reclaim;
 * `outcome` ∈ ok | not_found | unauthorized | rejected (other 4xx: invalid body, image not
 * allowlisted) | error (5xx); `state` ∈ exited | failed | terminated.
 */

export type SupervisorOperation =
  | 'task_spawn'
  | 'task_terminate'
  | 'resident_spawn'
  | 'resident_stop'
  | 'resident_reclaim';

/** `<METHOD> <route pattern>` → operation, for the routes that change container state. */
export const SUPERVISOR_OPERATION_BY_ROUTE: Readonly<Record<string, SupervisorOperation>> = {
  'POST /task/spawn': 'task_spawn',
  'POST /task/:workerRunId/terminate': 'task_terminate',
  'POST /resident/spawn': 'resident_spawn',
  'POST /resident/stop': 'resident_stop',
  'POST /resident/reclaim': 'resident_reclaim',
};

export function outcomeOfStatus(status: number): string {
  if (status >= 200 && status < 300) return 'ok';
  if (status === 404) return 'not_found';
  if (status === 401) return 'unauthorized';
  if (status >= 400 && status < 500) return 'rejected';
  return 'error';
}

export interface SupervisorMetrics {
  recordOperation(operation: SupervisorOperation, status: number, durationSeconds: number): void;
  recordTaskFinished(event: TaskFinishedEvent): void;
  render(): string;
}

export function createSupervisorMetrics(): SupervisorMetrics {
  const registry = new MetricsRegistry();
  const operations = registry.counter(
    'nexttime_supervisor_operations_total',
    'Container-lifecycle API calls handled by worker-supervisor, by operation and outcome.',
    ['operation', 'outcome'],
  );
  const duration = registry.histogram(
    'nexttime_supervisor_operation_duration_seconds',
    'Wall time of worker-supervisor container-lifecycle API calls.',
    ['operation'],
  );
  const taskExits = registry.counter(
    'nexttime_supervisor_task_exits_total',
    'Worker (Task) containers reaching a terminal state, by state.',
    ['state'],
  );
  return {
    recordOperation(operation, status, durationSeconds) {
      operations.inc({ operation, outcome: outcomeOfStatus(status) });
      duration.observe({ operation }, durationSeconds);
    },
    recordTaskFinished(event) {
      taskExits.inc({ state: event.state });
    },
    render: () => registry.render(),
  };
}
