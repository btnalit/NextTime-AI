import type {
  ActionRequestStatus,
  ConnectionRequestStatus,
  PublishableStatus,
  TaskStatus,
  WorkerRunStatus,
} from '@nexttime/shared';
import {
  ACTION_REQUEST_STATUS_VALUES,
  CONNECTION_REQUEST_STATUS_VALUES,
  PUBLISHABLE_STATUS_VALUES,
  TASK_STATUS_VALUES,
  WORKER_RUN_STATUS_VALUES,
} from '@nexttime/shared';

/**
 * lib/status-tone: the one status → visual-tone map per state machine, keyed by the enums
 * `@nexttime/shared` (`enums.ts`) owns. Every map is typed `Record<<Status>, ChipStyle>`, so a
 * state added to the kernel's enum fails `tsc` here until it is given a tone — and
 * `status-tone.test.ts` walks the runtime `*_STATUS_VALUES` arrays so the same holds at test time.
 * No status string is hand-typed anywhere in the UI: components pass the wire value through
 * `statusChipStyle(machine, value)` and get back tone + label.
 */

export type Tone = 'neutral' | 'ok' | 'warn' | 'danger' | 'info' | 'accent';

export interface ChipStyle {
  readonly tone: Tone;
  readonly label: string;
  /** Pulsing dot — the state is in motion (running, waiting on someone). */
  readonly live?: boolean;
}

export type StatusMachine =
  | 'actionRequest'
  | 'task'
  | 'workerRun'
  | 'connectionRequest'
  | 'publishable';

export const ACTION_REQUEST_TONES: Readonly<Record<ActionRequestStatus, ChipStyle>> = {
  proposed: { tone: 'neutral', label: 'Proposed' },
  policy_evaluated: { tone: 'neutral', label: 'Policy evaluated' },
  auto_approved: { tone: 'ok', label: 'Auto-approved' },
  pending_approval: { tone: 'warn', label: 'Pending approval', live: true },
  approved: { tone: 'ok', label: 'Approved' },
  rejected: { tone: 'danger', label: 'Rejected' },
  expired: { tone: 'neutral', label: 'Expired' },
  denied: { tone: 'danger', label: 'Denied by policy' },
  executing: { tone: 'info', label: 'Executing', live: true },
  executed: { tone: 'ok', label: 'Executed' },
  failed: { tone: 'danger', label: 'Failed' },
  verified: { tone: 'ok', label: 'Verified' },
  compensated: { tone: 'warn', label: 'Compensated' },
};

export const TASK_TONES: Readonly<Record<TaskStatus, ChipStyle>> = {
  created: { tone: 'neutral', label: 'Created' },
  queued: { tone: 'neutral', label: 'Queued' },
  running: { tone: 'info', label: 'Running', live: true },
  waiting_approval: { tone: 'warn', label: 'Waiting approval', live: true },
  completed: { tone: 'ok', label: 'Completed' },
  failed: { tone: 'danger', label: 'Failed' },
  cancelled: { tone: 'neutral', label: 'Cancelled' },
};

export const WORKER_RUN_TONES: Readonly<Record<WorkerRunStatus, ChipStyle>> = {
  provisioning: { tone: 'neutral', label: 'Provisioning', live: true },
  running: { tone: 'info', label: 'Running', live: true },
  suspended: { tone: 'warn', label: 'Suspended' },
  terminated: { tone: 'neutral', label: 'Terminated' },
};

export const CONNECTION_REQUEST_TONES: Readonly<Record<ConnectionRequestStatus, ChipStyle>> = {
  requested: { tone: 'warn', label: 'Requested', live: true },
  completed: { tone: 'ok', label: 'Completed' },
  cancelled: { tone: 'neutral', label: 'Cancelled' },
};

export const PUBLISHABLE_TONES: Readonly<Record<PublishableStatus, ChipStyle>> = {
  draft: { tone: 'neutral', label: 'Draft' },
  published: { tone: 'ok', label: 'Published' },
  deprecated: { tone: 'warn', label: 'Deprecated' },
};

const MACHINES: Readonly<
  Record<StatusMachine, { values: readonly string[]; tones: Readonly<Record<string, ChipStyle>> }>
> = {
  actionRequest: { values: ACTION_REQUEST_STATUS_VALUES, tones: ACTION_REQUEST_TONES },
  task: { values: TASK_STATUS_VALUES, tones: TASK_TONES },
  workerRun: { values: WORKER_RUN_STATUS_VALUES, tones: WORKER_RUN_TONES },
  connectionRequest: { values: CONNECTION_REQUEST_STATUS_VALUES, tones: CONNECTION_REQUEST_TONES },
  publishable: { values: PUBLISHABLE_STATUS_VALUES, tones: PUBLISHABLE_TONES },
};

export interface ResolvedChipStyle extends ChipStyle {
  /** `true` when `status` is not a value of that machine's enum — rendered as a dashed neutral
   *  chip with the raw value, never silently restyled as something it is not. */
  readonly unknown: boolean;
}

export function statusChipStyle(machine: StatusMachine, status: string): ResolvedChipStyle {
  const entry = MACHINES[machine];
  const style = entry.values.includes(status) ? entry.tones[status] : undefined;
  if (!style) return { tone: 'neutral', label: status, unknown: true };
  return { ...style, unknown: false };
}

/** The enum values of one machine, for filter tabs — always the shared array, never retyped. */
export function statusValues(machine: StatusMachine): readonly string[] {
  return MACHINES[machine].values;
}
