// @vitest-environment jsdom
import {
  ACTION_REQUEST_STATUS_VALUES,
  BLAST_RADIUS_VALUES,
  CONNECTION_REQUEST_STATUS_VALUES,
  ConnectorModeWireSchema,
  GRANT_STATUS_VALUES,
  GateHealthWireSchema,
  GateTrustWireSchema,
  OPERATION_MODE_VALUES,
  PUBLISHABLE_STATUS_VALUES,
  PlatformRoleWireSchema,
  ROLE_VALUES,
  ServiceHealthWireSchema,
  TASK_STATUS_VALUES,
  WORKER_RUN_STATUS_VALUES,
  WorkspacePurposeWireSchema,
  WorkspaceStatusWireSchema,
} from '@nexttime/shared';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  GATE_INSTANCE_STATUS_VALUES,
  type StatusMachine,
  USER_STATUS_VALUES,
  deriveGateInstanceStatus,
  deriveUserStatus,
  statusChipStyle,
  statusValues,
} from '../../lib/status-tone.js';
import { StatusChip } from './StatusChip.js';

afterEach(cleanup);

/**
 * StatusChip.test.tsx: exhaustive over every value of every `@nexttime/shared` status enum the
 * console renders — a state added to the kernel's vocabulary that the UI has not been given a
 * tone for fails here (and fails `tsc`, since the maps are `Record<<Status>, ...>`), instead of
 * silently rendering as an unstyled/unknown chip in production.
 */
const MACHINES: readonly { readonly machine: StatusMachine; readonly values: readonly string[] }[] =
  [
    { machine: 'actionRequest', values: ACTION_REQUEST_STATUS_VALUES },
    { machine: 'task', values: TASK_STATUS_VALUES },
    { machine: 'workerRun', values: WORKER_RUN_STATUS_VALUES },
    { machine: 'connectionRequest', values: CONNECTION_REQUEST_STATUS_VALUES },
    { machine: 'publishable', values: PUBLISHABLE_STATUS_VALUES },
    { machine: 'grant', values: GRANT_STATUS_VALUES },
    { machine: 'role', values: ROLE_VALUES },
    // S6-A0 / C17: governance scalars + the platform plane (wire/platform.ts Zod enums).
    { machine: 'operationMode', values: OPERATION_MODE_VALUES },
    { machine: 'blastRadius', values: BLAST_RADIUS_VALUES },
    { machine: 'userStatus', values: USER_STATUS_VALUES },
    { machine: 'workspaceStatus', values: WorkspaceStatusWireSchema.options },
    { machine: 'workspacePurpose', values: WorkspacePurposeWireSchema.options },
    { machine: 'gateInstance', values: GATE_INSTANCE_STATUS_VALUES },
    { machine: 'gateHealth', values: GateHealthWireSchema.options },
    { machine: 'gateTrust', values: GateTrustWireSchema.options },
    { machine: 'connectorMode', values: ConnectorModeWireSchema.options },
    { machine: 'serviceHealth', values: ServiceHealthWireSchema.shape.status.options },
    { machine: 'platformRole', values: PlatformRoleWireSchema.options },
  ];

describe('StatusChip', () => {
  it('covers the 13 ActionRequest states, and every other machine, with a known tone', () => {
    expect(ACTION_REQUEST_STATUS_VALUES).toHaveLength(13);
    for (const { machine, values } of MACHINES) {
      expect(statusValues(machine)).toEqual(values);
      for (const status of values) {
        const style = statusChipStyle(machine, status);
        expect(style.unknown, `${machine}:${status} has no tone`).toBe(false);
        expect(style.label.length, `${machine}:${status} has no label`).toBeGreaterThan(0);
        expect(style.label).not.toBe(status);

        const { container, unmount } = render(<StatusChip machine={machine} status={status} />);
        const chip = container.querySelector('.chip');
        expect(chip?.getAttribute('data-status')).toBe(status);
        expect(chip?.getAttribute('data-tone')).toBe(style.tone);
        expect(chip?.classList.contains(`chip-${style.tone}`)).toBe(true);
        expect(chip?.classList.contains('chip-unknown')).toBe(false);
        expect(chip?.textContent).toBe(style.label);
        unmount();
      }
    }
  });

  it('renders an unknown value visibly, dashed, with the raw string — never restyled', () => {
    const { container } = render(<StatusChip machine="task" status="teleported" />);
    const chip = container.querySelector('.chip');
    expect(chip?.classList.contains('chip-unknown')).toBe(true);
    expect(chip?.getAttribute('data-tone')).toBe('neutral');
    expect(chip?.textContent).toBe('teleported');
    expect(chip?.getAttribute('title')).toContain('Unknown task status');
  });

  it('maps the §5.9 six-colour semantics one colour per meaning', () => {
    expect(statusChipStyle('operationMode', 'observe').tone).toBe('observe');
    expect(statusChipStyle('operationMode', 'execute').tone).toBe('warn');
    expect(statusChipStyle('blastRadius', 'medium').tone).toBe('warn');
    expect(statusChipStyle('blastRadius', 'high').tone).toBe('danger');
    expect(statusChipStyle('actionRequest', 'rejected').tone).toBe('danger');
    expect(statusChipStyle('gateHealth', 'unreachable').tone).toBe('danger');
    expect(statusChipStyle('actionRequest', 'executed').tone).toBe('ok');
    expect(statusChipStyle('publishable', 'published').tone).toBe('ok');
    expect(statusChipStyle('serviceHealth', 'ok').tone).toBe('ok');
    expect(statusChipStyle('workspacePurpose', 'standard').tone).toBe('info');
    expect(statusChipStyle('workspacePurpose', 'ephemeral').tone).toBe('neutral');
    expect(statusChipStyle('publishable', 'deprecated').tone).toBe('warn');
    expect(statusChipStyle('userStatus', 'disabled').tone).toBe('neutral');
  });

  it('derives the two display-only platform states from their wire rows', () => {
    expect(deriveUserStatus({ status: 'active', hasPassword: true })).toBe('active');
    expect(deriveUserStatus({ status: 'active', hasPassword: false })).toBe('pending_activation');
    expect(deriveUserStatus({ status: 'disabled', hasPassword: false })).toBe('disabled');
    expect(deriveGateInstanceStatus({ status: 'discovered', hosted: true, lastSeenAt: null })).toBe(
      'awaiting_host',
    );
    expect(
      deriveGateInstanceStatus({
        status: 'enabled',
        hosted: true,
        lastSeenAt: '2026-01-01T00:00:00Z',
      }),
    ).toBe('enabled');
    expect(deriveGateInstanceStatus({ status: 'lost', hosted: false, lastSeenAt: null })).toBe(
      'lost',
    );
  });

  it('forwards testId as data-testid', () => {
    const { container } = render(
      <StatusChip machine="userStatus" status="active" testId="platform-user-status" />,
    );
    expect(container.querySelector('[data-testid="platform-user-status"]')?.textContent).toBe(
      '活跃 Active',
    );
  });

  it('marks in-motion states as live (pulsing dot)', () => {
    expect(statusChipStyle('actionRequest', 'pending_approval').live).toBe(true);
    expect(statusChipStyle('task', 'running').live).toBe(true);
    expect(statusChipStyle('task', 'completed').live).toBeUndefined();
    const { container } = render(<StatusChip machine="task" status="running" />);
    expect(container.querySelector('.chip-live')).toBeTruthy();
  });
});
