import { describe, expect, it } from 'vitest';
import {
  ACTION_REQUEST_STATUS_VALUES,
  ActionRequestStatusSchema,
  BLAST_RADIUS_VALUES,
  BlastRadiusSchema,
  CAPABILITY_CHANNEL_VALUES,
  CONFLICT_STATUS_VALUES,
  CONFLICT_TYPE_VALUES,
  CapabilityChannelSchema,
  ConflictStatusSchema,
  ConflictTypeSchema,
  DECISION_STATUS_VALUES,
  DecisionStatusSchema,
  ENTRY_AGENT_SESSION_STATUS_VALUES,
  EPISTEMIC_STATUS_VALUES,
  EXTENSION_MODE_VALUES,
  EntryAgentSessionStatusSchema,
  EpistemicStatusSchema,
  ExtensionModeSchema,
  GRANT_STATUS_VALUES,
  GrantStatusSchema,
  OPERATION_MODE_VALUES,
  OperationModeSchema,
  PRINCIPAL_KIND_VALUES,
  PUBLISHABLE_STATUS_VALUES,
  PrincipalKindSchema,
  PublishableStatusSchema,
  ROLE_VALUES,
  RoleSchema,
  SESSION_KIND_VALUES,
  SessionKindSchema,
  TASK_STATUS_VALUES,
  TaskStatusSchema,
  WORKER_DEFINITION_KIND_VALUES,
  WORKER_RUN_STATUS_VALUES,
  WorkerDefinitionKindSchema,
  WorkerRunStatusSchema,
} from './enums.js';

const enumsUnderTest = [
  ['PrincipalKind', PRINCIPAL_KIND_VALUES, PrincipalKindSchema, ['human', 'agent', 'service']],
  ['Role', ROLE_VALUES, RoleSchema, ['owner', 'builder', 'operator', 'member', 'auditor']],
  [
    'SessionKind',
    SESSION_KIND_VALUES,
    SessionKindSchema,
    ['web', 'entry', 'worker_run', 'mcp_session', 'service'],
  ],
  [
    'EpistemicStatus',
    EPISTEMIC_STATUS_VALUES,
    EpistemicStatusSchema,
    ['observed', 'extracted', 'inferred', 'asserted', 'verified', 'contradicted'],
  ],
  [
    'ConflictType',
    CONFLICT_TYPE_VALUES,
    ConflictTypeSchema,
    ['value', 'type', 'relationship', 'temporal', 'logical'],
  ],
  [
    'ConflictStatus',
    CONFLICT_STATUS_VALUES,
    ConflictStatusSchema,
    ['open', 'resolved', 'accepted_both', 'dismissed'],
  ],
  [
    'DecisionStatus',
    DECISION_STATUS_VALUES,
    DecisionStatusSchema,
    [
      'proposed',
      'approved',
      'rejected',
      'executed',
      'verified',
      'failed',
      'superseded',
      'archived',
    ],
  ],
  [
    'ActionRequestStatus',
    ACTION_REQUEST_STATUS_VALUES,
    ActionRequestStatusSchema,
    [
      'proposed',
      'policy_evaluated',
      'auto_approved',
      'pending_approval',
      'approved',
      'rejected',
      'expired',
      'denied',
      'executing',
      'executed',
      'failed',
      'verified',
      'compensated',
    ],
  ],
  [
    'TaskStatus',
    TASK_STATUS_VALUES,
    TaskStatusSchema,
    ['created', 'queued', 'running', 'waiting_approval', 'completed', 'failed', 'cancelled'],
  ],
  [
    'WorkerRunStatus',
    WORKER_RUN_STATUS_VALUES,
    WorkerRunStatusSchema,
    ['provisioning', 'running', 'suspended', 'terminated'],
  ],
  [
    'EntryAgentSessionStatus',
    ENTRY_AGENT_SESSION_STATUS_VALUES,
    EntryAgentSessionStatusSchema,
    ['starting', 'ready', 'busy', 'crashed', 'stopped'],
  ],
  [
    'PublishableStatus',
    PUBLISHABLE_STATUS_VALUES,
    PublishableStatusSchema,
    ['draft', 'published', 'deprecated'],
  ],
  ['GrantStatus', GRANT_STATUS_VALUES, GrantStatusSchema, ['active', 'revoked', 'expired']],
  ['OperationMode', OPERATION_MODE_VALUES, OperationModeSchema, ['observe', 'execute']],
  ['BlastRadius', BLAST_RADIUS_VALUES, BlastRadiusSchema, ['low', 'medium', 'high']],
  ['CapabilityChannel', CAPABILITY_CHANNEL_VALUES, CapabilityChannelSchema, ['human', 'handle']],
  [
    'WorkerDefinitionKind',
    WORKER_DEFINITION_KIND_VALUES,
    WorkerDefinitionKindSchema,
    ['entry', 'worker'],
  ],
  ['ExtensionMode', EXTENSION_MODE_VALUES, ExtensionModeSchema, ['entry', 'worker', 'interactive']],
] as const;

describe('enums', () => {
  it('covers all 18 domain enums required by R4', () => {
    expect(enumsUnderTest).toHaveLength(18);
  });

  for (const [name, values, schema, expected] of enumsUnderTest) {
    describe(name, () => {
      it('matches the exact expected value list and order', () => {
        expect(values).toEqual(expected);
      });

      it('has no duplicate values', () => {
        expect(new Set(values).size).toBe(values.length);
      });

      it('accepts every value via its Zod schema', () => {
        for (const value of values) {
          expect(schema.parse(value)).toBe(value);
        }
      });

      it('rejects a value outside the enum', () => {
        expect(() => schema.parse('__not_a_real_value__')).toThrow();
      });
    });
  }
});
