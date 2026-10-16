import { describe, expect, it } from 'vitest';
import {
  ACTION_REQUEST_FAILURE_KIND_VALUES,
  ACTION_REQUEST_STATUS_VALUES,
  ActionRequestFailureKindSchema,
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
  GOAL_OUTCOME_BASIS_VALUES,
  GOAL_RUN_PAUSE_REASON_VALUES,
  GOAL_RUN_STATUS_VALUES,
  GRANT_STATUS_VALUES,
  GoalOutcomeBasisSchema,
  GoalRunPauseReasonSchema,
  GoalRunStatusSchema,
  GrantStatusSchema,
  META_ONTOLOGY_OBJECT_TYPE_VALUES,
  MetaOntologyObjectTypeSchema,
  OPERATION_MODE_VALUES,
  OPERATION_STATUS_VALUES,
  OperationModeSchema,
  OperationStatusSchema,
  PLAN_REVISION_STATUS_VALUES,
  POLICY_DECISION_VALUES,
  PRINCIPAL_KIND_VALUES,
  PUBLISHABLE_STATUS_VALUES,
  PlanRevisionStatusSchema,
  PolicyDecisionSchema,
  PrincipalKindSchema,
  PublishableStatusSchema,
  ROLE_VALUES,
  RoleSchema,
  SESSION_KIND_VALUES,
  STEP_RUN_FAILURE_CATEGORY_VALUES,
  STEP_RUN_STATUS_VALUES,
  STEP_RUN_WAITING_REASON_VALUES,
  SessionKindSchema,
  StepRunFailureCategorySchema,
  StepRunStatusSchema,
  StepRunWaitingReasonSchema,
  TASK_FAILURE_REASON_VALUES,
  TASK_STATUS_VALUES,
  TURN_STATUS_VALUES,
  TaskFailureReasonSchema,
  TaskStatusSchema,
  TurnStatusSchema,
  WORKER_DEFINITION_KIND_VALUES,
  WORKER_RUN_STATUS_VALUES,
  WorkerDefinitionKindSchema,
  WorkerRunStatusSchema,
  isMetaOntologyObjectType,
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
      'withdrawn',
    ],
  ],
  [
    'ActionRequestFailureKind',
    ACTION_REQUEST_FAILURE_KIND_VALUES,
    ActionRequestFailureKindSchema,
    ['not_delivered', 'refused', 'outcome_unknown'],
  ],
  [
    'TaskStatus',
    TASK_STATUS_VALUES,
    TaskStatusSchema,
    ['created', 'queued', 'running', 'waiting_approval', 'completed', 'failed', 'cancelled'],
  ],
  [
    'TaskFailureReason',
    TASK_FAILURE_REASON_VALUES,
    TaskFailureReasonSchema,
    [
      'timeout',
      'no_result',
      'worker_failed',
      'spawn_failed',
      'spawn_lost',
      'run_lost',
      'budget_exhausted',
      'terminated',
    ],
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
    'TurnStatus',
    TURN_STATUS_VALUES,
    TurnStatusSchema,
    ['running', 'completed', 'interrupted', 'failed'],
  ],
  [
    'PublishableStatus',
    PUBLISHABLE_STATUS_VALUES,
    PublishableStatusSchema,
    ['draft', 'published', 'deprecated'],
  ],
  [
    'OperationStatus',
    OPERATION_STATUS_VALUES,
    OperationStatusSchema,
    ['draft', 'published', 'deprecated', 'discarded'],
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
  [
    'MetaOntologyObjectType',
    META_ONTOLOGY_OBJECT_TYPE_VALUES,
    MetaOntologyObjectTypeSchema,
    ['WorkerDefinition', 'Gatekeeper', 'Operation', 'Capability', 'Skill', 'Procedure'],
  ],
  [
    'PolicyDecision',
    POLICY_DECISION_VALUES,
    PolicyDecisionSchema,
    ['allow', 'require_approval', 'deny'],
  ],
  [
    'GoalRunStatus',
    GOAL_RUN_STATUS_VALUES,
    GoalRunStatusSchema,
    [
      'proposed',
      'running',
      'paused',
      'verifying',
      'completed',
      'cancelling',
      'cancelled',
      'failed',
    ],
  ],
  [
    'GoalRunPauseReason',
    GOAL_RUN_PAUSE_REASON_VALUES,
    GoalRunPauseReasonSchema,
    [
      'requested',
      'budget_exhausted',
      'no_progress',
      'authority_lost',
      'needs_decision',
      'awaiting_reconcile',
    ],
  ],
  [
    'GoalOutcomeBasis',
    GOAL_OUTCOME_BASIS_VALUES,
    GoalOutcomeBasisSchema,
    ['verified_by_check', 'requester', 'reviewer_assessed'],
  ],
  [
    'PlanRevisionStatus',
    PLAN_REVISION_STATUS_VALUES,
    PlanRevisionStatusSchema,
    ['proposed', 'accepted', 'rejected'],
  ],
  [
    'StepRunStatus',
    STEP_RUN_STATUS_VALUES,
    StepRunStatusSchema,
    [
      'pending',
      'ready',
      'running',
      'waiting',
      'succeeded',
      'failed',
      'superseded',
      'cancelled',
      'skipped',
    ],
  ],
  [
    'StepRunWaitingReason',
    STEP_RUN_WAITING_REASON_VALUES,
    StepRunWaitingReasonSchema,
    ['approval', 'reconcile', 'external'],
  ],
  [
    'StepRunFailureCategory',
    STEP_RUN_FAILURE_CATEGORY_VALUES,
    StepRunFailureCategorySchema,
    [
      'transient',
      'authority_lost',
      'contract_violation',
      'verification_failed',
      'outcome_unknown',
      'action_refused',
    ],
  ],
] as const;

describe('enums', () => {
  it('covers all 30 domain enums required by R4 + S2.2 + S2.6 + R-55 (TurnStatus) + legacy 278 (OperationStatus) + S11 GO1 (ActionRequestFailureKind and the GoalRun / PlanRevision / StepRun vocabulary)', () => {
    expect(enumsUnderTest).toHaveLength(30);
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

describe('isMetaOntologyObjectType', () => {
  it('accepts every meta-ontology ObjectType', () => {
    for (const value of META_ONTOLOGY_OBJECT_TYPE_VALUES) {
      expect(isMetaOntologyObjectType(value)).toBe(true);
    }
  });

  it('rejects a non-meta-ontology ObjectType', () => {
    expect(isMetaOntologyObjectType('SomeOtherObjectType')).toBe(false);
  });
});
