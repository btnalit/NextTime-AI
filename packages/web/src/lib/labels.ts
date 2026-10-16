import type {
  ConflictType,
  DecisionStatus,
  EpistemicStatus,
  ExecutionReadinessMissingCode,
  GateTransportKindWire,
  PrincipalKind,
  TaskFailureReason,
  TurnStatus,
  WorkerDefinitionKind,
} from '@nexttime/shared';
import type { AuditResourceType, PlatformAuditResourceType } from './audit.js';
import type { Translate } from './i18n.js';
import { ownEntry } from './own.js';
import { labelText, statusChipStyle } from './status-tone.js';

/**
 * lib/labels: bilingual display labels for the wire enums the console renders as plain text
 * outside a `StatusChip` — table cells, `<option>` text, and inline chips (S8 W1-A10, audit S14
 * "内部术语外泄…原始枚举 platform_preset / self_serve / owner / entry"). `lib/status-tone.ts`
 * already owns the state-machine enums (their tone drives a chip's colour); this module covers
 * the enums that are not a lifecycle/state machine — a Worker definition's `kind`, a Principal's
 * `kind`, an audit row's `resourceType` — plus thin re-exports (`roleLabel`, `connectorModeLabel`)
 * for call sites that need a plain string built from a status-tone machine (e.g. inside an
 * `<option>` or a template literal) rather than a `<StatusChip>` element.
 *
 * Every map is `Record<<Enum>, BilingualLabel>`, typed against the enum's own union — a value
 * `@nexttime/shared` (or `lib/audit.ts`, for the kernel-implicit audit vocabulary) adds without a
 * matching entry here fails `tsc`, the same exhaustiveness guarantee `lib/status-tone.ts`'s
 * `Record<Status, ChipStyle>` maps already give the state machines.
 */
export interface BilingualLabel {
  readonly zh: string;
  readonly en: string;
}

/** Resolves a `BilingualLabel` (or one keyed by an enum lookup) to the active language's text —
 *  the one place a caller picks a language, so every map below stays pure data. */
export function label(entry: BilingualLabel, t: Translate): string {
  return t(entry.zh, entry.en);
}

// -------------------------------------------------------------------------------------------
// Principal kind (`@nexttime/shared` `PRINCIPAL_KIND_VALUES`) — MembersPage's non-human tag,
// PrincipalDetail's kind tag.
// -------------------------------------------------------------------------------------------

export const PRINCIPAL_KIND_LABELS: Readonly<Record<PrincipalKind, BilingualLabel>> = {
  human: { zh: '人类用户', en: 'Human' },
  agent: { zh: 'Agent', en: 'Agent' },
  service: { zh: '服务', en: 'Service' },
};

export function principalKindLabel(kind: PrincipalKind, t: Translate): string {
  return label(PRINCIPAL_KIND_LABELS[kind], t);
}

// -------------------------------------------------------------------------------------------
// WorkerDefinition kind (`@nexttime/shared` `WORKER_DEFINITION_KIND_VALUES`) — the catalog's
// Workers tab tag (audit S14's literal "entry" example).
// -------------------------------------------------------------------------------------------

export const WORKER_DEFINITION_KIND_LABELS: Readonly<Record<WorkerDefinitionKind, BilingualLabel>> =
  {
    entry: { zh: '入口定义', en: 'Entry' },
    worker: { zh: 'Worker 定义', en: 'Worker' },
  };

/** Takes a plain `string` (not the narrower `WorkerDefinitionKind`) because the catalog's own
 *  summary row type (`lib/tasks.ts` `WorkerDefinitionSummary.kind`) carries it looser over the
 *  wire — an unrecognized value still renders visibly (the raw value), never silently hidden. */
export function workerDefinitionKindLabel(kind: string, t: Translate): string {
  const entry = ownEntry(
    WORKER_DEFINITION_KIND_LABELS as Readonly<Record<string, BilingualLabel>>,
    kind,
  );
  return entry ? label(entry, t) : kind;
}

// -------------------------------------------------------------------------------------------
// execution_readiness missing code (`@nexttime/shared` `ExecutionReadinessMissingCodeSchema`, S8
// W2 U3a, ui-audit-2026-09-23 J1/O1): the short machine-code label — `components/readiness/
// readiness-copy.ts` owns the longer per-item cause sentence and its fix-it link, this map is only
// for a place that needs the bare short label (a chip, a title attribute).
// -------------------------------------------------------------------------------------------

export const EXECUTION_READINESS_MISSING_CODE_LABELS: Readonly<
  Record<ExecutionReadinessMissingCode, BilingualLabel>
> = {
  no_enabled_gate: { zh: '没有已启用的门', en: 'No gate enabled' },
  no_grant: { zh: '未授权', en: 'Not granted' },
  no_published_worker: { zh: '没有已发布的 Worker 定义', en: 'No published Worker definition' },
  no_worker_gate: {
    zh: '已发布的 Worker 都没有可作用的门',
    en: 'No published Worker reaches a gate',
  },
  excluded_by_profile: { zh: '在我的智能体里被取消', en: 'Unticked on My Agent' },
  excluded_by_policy: { zh: '工作区策略未包含', en: 'Left out by workspace policy' },
  disabled_by_platform: { zh: '被平台停用', en: 'Disabled by the platform' },
  // Legacy 301: also a gate that no longer provides them (`droppedByGate`) — the cause line under
  // it (`missingCauseText`) says which.
  definition_mismatch: {
    zh: '门拒绝调用',
    en: 'Refused by the gate',
  },
};

export function executionReadinessMissingCodeLabel(
  code: ExecutionReadinessMissingCode,
  t: Translate,
): string {
  return label(EXECUTION_READINESS_MISSING_CODE_LABELS[code], t);
}

// -------------------------------------------------------------------------------------------
// Audit resource type (`lib/audit.ts` `AUDIT_RESOURCE_TYPES` — the kernel does not publish this
// as a formal `@nexttime/shared` enum, see that file's own comment; typed against its union all
// the same). The audit page's resource-type `<select>` and the row's resource chip.
// -------------------------------------------------------------------------------------------

export const AUDIT_RESOURCE_TYPE_LABELS: Readonly<Record<AuditResourceType, BilingualLabel>> = {
  action_request: { zh: '审批请求', en: 'Action request' },
  activity: { zh: '活动', en: 'Activity' },
  // Legacy 355: one term per concept, the same the pages use — 工作区策略 (the models page card),
  // 智能体配置 (「我的智能体」 and the purge counts), 审批策略 (an always-allow rule; the purge
  // counts), 流程 (every Procedure surface).
  agent_policy: { zh: '工作区策略', en: 'Agent policy' },
  agent_profile: { zh: '智能体配置', en: 'Agent profile' },
  capability_grant: { zh: '能力授权', en: 'Capability grant' },
  chat: { zh: '对话', en: 'Chat' },
  conflict: { zh: '冲突', en: 'Conflict' },
  connection_request: { zh: '连接申请', en: 'Connection request' },
  decision: { zh: '决策', en: 'Decision' },
  fact: { zh: '事实', en: 'Fact' },
  // Legacy sweep (console batch, 2026-10-16): `gatekeeper` reads 门 now that `gate_instance` (the
  // platform's instance, also written on workspace rows) has its own 门实例 option.
  gate_instance: { zh: '门实例', en: 'Gate instance' },
  gatekeeper: { zh: '门', en: 'Gatekeeper' },
  module: { zh: '模块', en: 'Module' },
  object: { zh: '对象', en: 'Object' },
  ontology_type: { zh: '本体类型', en: 'Ontology type' },
  ontology_version: { zh: '本体版本', en: 'Ontology version' },
  operation: { zh: 'Operation', en: 'Operation' },
  policy: { zh: '审批策略', en: 'Approval policy' },
  principal: { zh: '成员', en: 'Member' },
  procedure: { zh: '流程', en: 'Procedure' },
  quota: { zh: '配额', en: 'Quota' },
  session: { zh: '会话', en: 'Session' },
  skill: { zh: 'Skill', en: 'Skill' },
  source: { zh: '来源', en: 'Source' },
  task: { zh: '任务', en: 'Task' },
  worker_definition: { zh: 'Worker 定义', en: 'Worker definition' },
  worker_run: { zh: 'Worker 运行', en: 'Worker run' },
  workspace: { zh: '工作区', en: 'Workspace' },
};

/** Legacy sweep (console batch, 2026-10-16): the platform-only audit resource types
 *  (`lib/audit.ts` `PLATFORM_AUDIT_RESOURCE_TYPES`) — the platform audit list's row meta. */
export const PLATFORM_AUDIT_RESOURCE_TYPE_LABELS: Readonly<
  Record<PlatformAuditResourceType, BilingualLabel>
> = {
  connector: { zh: '连接器', en: 'Connector' },
  llm_admin_token: { zh: '模型管理令牌', en: 'LLM admin token' },
  llm_provider: { zh: '模型服务商', en: 'LLM provider' },
  observations: { zh: '观测', en: 'Observations' },
  platform: { zh: '平台', en: 'Platform' },
  platform_settings: { zh: '平台设置', en: 'Platform settings' },
  user: { zh: '用户', en: 'User' },
};

/** Either stream's resource type — a workspace one first, then a platform-only one; anything
 *  else stays visible as the raw value. */
export function auditResourceTypeLabel(resourceType: string, t: Translate): string {
  const entry =
    ownEntry(
      AUDIT_RESOURCE_TYPE_LABELS as Readonly<Record<string, BilingualLabel>>,
      resourceType,
    ) ??
    ownEntry(
      PLATFORM_AUDIT_RESOURCE_TYPE_LABELS as Readonly<Record<string, BilingualLabel>>,
      resourceType,
    );
  return entry ? label(entry, t) : resourceType;
}

/** Console audit P1-13: an ActionRequest's `policyDecision` (`POLICY_DECISION_VALUES`) — what the
 *  workspace policy decided when it was requested — never shown as the raw value. */
const POLICY_DECISION_LABELS: Readonly<Record<string, BilingualLabel>> = {
  allow: { zh: '策略允许直接执行', en: 'Allowed by policy' },
  require_approval: { zh: '策略要求人工审批', en: 'Policy requires approval' },
  deny: { zh: '策略拒绝', en: 'Denied by policy' },
};

export function policyDecisionLabel(decision: string, t: Translate): string {
  const entry = ownEntry(POLICY_DECISION_LABELS, decision);
  return entry ? label(entry, t) : decision;
}

/** Console audit P1-13: who proposed an ActionRequest — the kernel records `human` for a request
 *  made from the console and `pi` for one an agent made (`request-action-handler.ts`). */
const ACTOR_RUNTIME_LABELS: Readonly<Record<string, BilingualLabel>> = {
  human: { zh: '控制台里的人', en: 'A person in the console' },
  pi: { zh: '智能体', en: 'An agent' },
  worker: { zh: 'Worker（被委派执行）', en: 'A delegated Worker' },
};

export function actorRuntimeLabel(runtime: string, t: Translate): string {
  const entry = ownEntry(ACTOR_RUNTIME_LABELS, runtime);
  return entry ? label(entry, t) : runtime;
}

// -------------------------------------------------------------------------------------------
// Thin wrappers over `lib/status-tone.ts` machines, for a call site that needs a plain string
// (an `<option>` body, a confirm title's interpolation) rather than a `<StatusChip>` element.
// -------------------------------------------------------------------------------------------

/** A workspace `Role` (`owner`/`builder`/`operator`/`member`/`auditor`) as plain text — the same
 *  bilingual label `<StatusChip machine="role">` renders, for an `<option>` or template literal
 *  that cannot hold a chip element (audit S14's literal "owner" example). Takes a plain `string`
 *  (not the narrower `Role` type) because several call sites carry it over the wire as one
 *  (`WireMembership.role`, `PrincipalRow.role`'s siblings) — an unrecognized value still renders
 *  visibly, via `statusChipStyle`'s own `unknown` fallback (never silently blanked). */
export function roleLabel(role: string, t: Translate): string {
  return labelText(statusChipStyle('role', role), t);
}

/** Console audit P1-12: what each workspace `Role` can do, one line, shown next to every role
 *  picker so choosing one is not a guess. Derived from the registry's `minRole`s (an owner clears
 *  every one; `approve`/`reject`/`list_grants`/`list_policies` need operator; every `propose_*`/
 *  `publish_*`/`deprecate_*` needs builder; `audit_query`/`export_prov`/`reconstruct` are the
 *  auditor's, which may not write anything — kernel `roles.ts` D-07). */
const ROLE_DESCRIPTIONS: Readonly<Record<string, BilingualLabel>> = {
  owner: {
    zh: '管理成员、授权、策略、配额和系统接入，能审批一切动作。',
    en: 'Manages members, grants, policies, quotas and system connections; can approve every action.',
  },
  operator: {
    zh: '查看授权、策略和配额，处理审批队列（批准或驳回动作请求）。',
    en: 'Sees grants, policies and quotas; works the approval queue (approves or rejects action requests).',
  },
  builder: {
    zh: '在能力目录里提议、发布和下线 Operation、Skill、流程和 Worker。',
    en: 'Proposes, publishes and deprecates Operations, Skills, procedures and Workers in the catalog.',
  },
  member: {
    zh: '和自己的智能体对话、用已授权的系统，可以申请接入新系统。',
    en: 'Chats with their own agent, uses the systems granted to them, and can request a new connection.',
  },
  auditor: {
    zh: '只读：查审计、导出溯源、回放过程，不能改动任何东西。',
    en: 'Read-only: queries the audit, exports provenance, reconstructs runs; cannot change anything.',
  },
};

export function roleDescription(role: string, t: Translate): string | null {
  const entry = ownEntry(ROLE_DESCRIPTIONS, role);
  return entry ? label(entry, t) : null;
}

/** A connector's three-state mode (`disabled`/`self_serve`/`platform_preset`) as plain text — for
 *  the platform integrations page's mode `<select>` `<option>`s and its confirm dialog title
 *  (audit S14's literal "platform_preset / self_serve" example; `copy-guard-baseline.json`
 *  `platform-integrations`). */
export function connectorModeLabel(mode: string, t: Translate): string {
  return labelText(statusChipStyle('connectorMode', mode), t);
}

// -------------------------------------------------------------------------------------------
// Gate transport kind (`@nexttime/shared` `GateTransportKindWireSchema`) — the integrations
// page's connector table (S8 W4-C, ui-audit PI1 "显示原始枚举") and the gate instance detail
// drawer (ui-audit PI3). Not a state machine (no lifecycle, no tone) so it lives here rather than
// `lib/status-tone.ts` — same shape `workerDefinitionKindLabel` above already uses for a
// non-machine enum.
// -------------------------------------------------------------------------------------------

const GATE_TRANSPORT_KIND_LABELS: Readonly<Record<GateTransportKindWire, BilingualLabel>> = {
  http: { zh: 'HTTP', en: 'HTTP' },
  mcp: { zh: 'MCP', en: 'MCP' },
  cli: { zh: 'CLI', en: 'CLI' },
  ssh: { zh: 'SSH', en: 'SSH' },
};

/** Takes a plain `string` (not the narrower `GateTransportKindWire`) for the same reason
 *  `workerDefinitionKindLabel` does — an unrecognized value still renders visibly, never silently
 *  hidden. */
export function transportKindLabel(kind: string, t: Translate): string {
  const entry = ownEntry(
    GATE_TRANSPORT_KIND_LABELS as Readonly<Record<string, BilingualLabel>>,
    kind,
  );
  return entry ? label(entry, t) : kind;
}

// -------------------------------------------------------------------------------------------
// Operation fields (R-18 `otherChangedFields`, legacy K `definitionChange.changedFields`) — a
// manifest change or a revision names the fields it changes; the console says them in plain words
// instead of the manifest's own snake_case keys (UX acceptance of #538). Keyed by the manifest key,
// not an enum: a field this table does not know keeps its own name.
// -------------------------------------------------------------------------------------------

export const OPERATION_FIELD_LABELS: Readonly<Record<string, BilingualLabel>> = {
  binding: { zh: '调用目标', en: 'Call target' },
  params_schema: { zh: '参数定义', en: 'Parameters' },
  result_mapping: { zh: '结果映射', en: 'Result mapping' },
  mode: { zh: '模式', en: 'Mode' },
  reversibility: { zh: '可撤销性', en: 'Reversibility' },
  blast_radius: { zh: '影响级', en: 'Blast radius' },
  auto_approvable: { zh: '是否可自动批准', en: 'Auto-approvable' },
  await_decision: { zh: '是否等审批结果', en: 'Waits for the decision' },
  reads: { zh: '读取的资源', en: 'Reads' },
  writes: { zh: '写入的资源', en: 'Writes' },
  read_only_hint: { zh: '只读提示', en: 'Read-only hint' },
  destructive_hint: { zh: '破坏性提示', en: 'Destructive hint' },
  idempotent_hint: { zh: '幂等提示', en: 'Idempotent hint' },
};

export function operationFieldLabel(field: string, t: Translate): string {
  const entry = ownEntry(OPERATION_FIELD_LABELS, field);
  return entry ? label(entry, t) : field;
}

// -------------------------------------------------------------------------------------------
// Task failure reason (`@nexttime/shared` `TASK_FAILURE_REASON_VALUES`, legacy 324) — the task
// list row, TaskDetail's overview, and the chat status line of a failed Task.
// -------------------------------------------------------------------------------------------

export const TASK_FAILURE_REASON_LABELS: Readonly<
  Record<TaskFailureReason, { readonly short: BilingualLabel; readonly detail: BilingualLabel }>
> = {
  timeout: {
    short: { zh: '超时', en: 'Timed out' },
    detail: {
      zh: '运行超过了任务的时长上限，平台把它结束了。',
      en: 'The run went past the task’s duration limit, and the platform ended it.',
    },
  },
  no_result: {
    short: { zh: '没有交回结果', en: 'No result' },
    detail: {
      zh: 'Worker 的运行结束了，但没有交回结果。',
      en: 'The Worker’s run ended without handing back a result.',
    },
  },
  worker_failed: {
    short: { zh: 'Worker 运行失败', en: 'Worker failed' },
    detail: {
      zh: 'Worker 的运行出错，自动重试也没有成功。',
      en: 'The Worker’s run failed, and the automatic retry did not succeed either.',
    },
  },
  spawn_failed: {
    short: { zh: 'Worker 没能启动', en: 'Worker did not start' },
    detail: {
      zh: '平台没能启动这次 Worker 运行，什么都没执行。',
      en: 'The platform could not start the Worker run; nothing ran.',
    },
  },
  spawn_lost: {
    short: { zh: '排队后没有启动', en: 'Never started' },
    detail: {
      zh: '任务排队后一直没有启动（平台在启动它之前中断了），平台把它结束了，不会自动重试。',
      en: 'The task was queued but never started (the platform stopped before starting it); the platform ended it and will not retry it.',
    },
  },
  run_lost: {
    short: { zh: '运行丢失', en: 'Run lost' },
    detail: {
      zh: '任务还显示在运行，但它的 Worker 运行都已经结束了，平台把它结束了。',
      en: 'The task still showed as running, but every Worker run of it had already ended; the platform ended it.',
    },
  },
  budget_exhausted: {
    short: { zh: 'token 预算用完', en: 'Token budget used up' },
    detail: {
      zh: '任务用完了它的 token 预算，平台把它结束了。',
      en: 'The task used up its token budget, and the platform ended it.',
    },
  },
  terminated: {
    short: { zh: '运行被终止', en: 'Run terminated' },
    detail: {
      zh: '运行环境结束了这次 Worker 运行。',
      en: 'The runtime ended the Worker run.',
    },
  },
};

/** A failed Task's reason as a short label and one sentence. A value an earlier release wrote and
 *  this one does not know reads as "another reason", never as the raw value. */
export function taskFailureReasonText(
  reason: string,
  t: Translate,
): { readonly short: string; readonly detail: string } {
  const entry = ownEntry(TASK_FAILURE_REASON_LABELS, reason);
  if (entry) return { short: label(entry.short, t), detail: label(entry.detail, t) };
  return {
    short: t('其他原因', 'Another reason'),
    detail: t(
      '这个失败原因是平台的较早版本记下的，当前版本没有它的说明。',
      'An earlier platform release recorded this failure reason, and this release has no description for it.',
    ),
  };
}

// -------------------------------------------------------------------------------------------
// Legacy sweep (console batch, 2026-10-16): the provenance / graph / audit vocabulary that still
// rendered as the kernel's raw value — a Fact's epistemic status, a Conflict's type, a Decision's
// status, an Activity's kind and status, a Source's kind and visibility — and the Docker state of
// a platform container. Every lookup falls back to the raw value for a value this table does not
// know (visible, never blanked), the same as `auditResourceTypeLabel` above.
// -------------------------------------------------------------------------------------------

function lookup(
  map: Readonly<Record<string, BilingualLabel>>,
  value: string,
  t: Translate,
): string {
  const entry = ownEntry(map, value);
  return entry ? label(entry, t) : value;
}

/** `@nexttime/shared` `EPISTEMIC_STATUS_VALUES` (§5.6) — how a Fact came to be believed. */
export const EPISTEMIC_STATUS_LABELS: Readonly<Record<EpistemicStatus, BilingualLabel>> = {
  observed: { zh: '观测', en: 'Observed' },
  extracted: { zh: '抽取', en: 'Extracted' },
  inferred: { zh: '推断', en: 'Inferred' },
  asserted: { zh: '断言', en: 'Asserted' },
  verified: { zh: '已验证', en: 'Verified' },
  contradicted: { zh: '被反驳', en: 'Contradicted' },
};

export function epistemicStatusLabel(status: string, t: Translate): string {
  return lookup(EPISTEMIC_STATUS_LABELS, status, t);
}

/** `@nexttime/shared` `CONFLICT_TYPE_VALUES` (§5.5, Semantica's taxonomy). */
export const CONFLICT_TYPE_LABELS: Readonly<Record<ConflictType, BilingualLabel>> = {
  value: { zh: '取值冲突', en: 'Value conflict' },
  type: { zh: '类型冲突', en: 'Type conflict' },
  relationship: { zh: '关系冲突', en: 'Relationship conflict' },
  temporal: { zh: '时间冲突', en: 'Temporal conflict' },
  logical: { zh: '逻辑冲突', en: 'Logical conflict' },
};

export function conflictTypeLabel(type: string, t: Translate): string {
  return lookup(CONFLICT_TYPE_LABELS, type, t);
}

/** `@nexttime/shared` `DECISION_STATUS_VALUES` (§5.5). */
export const DECISION_STATUS_LABELS: Readonly<Record<DecisionStatus, BilingualLabel>> = {
  proposed: { zh: '已提议', en: 'Proposed' },
  approved: { zh: '已批准', en: 'Approved' },
  rejected: { zh: '已拒绝', en: 'Rejected' },
  executed: { zh: '已执行', en: 'Executed' },
  verified: { zh: '已验证', en: 'Verified' },
  failed: { zh: '失败', en: 'Failed' },
  superseded: { zh: '已被取代', en: 'Superseded' },
  archived: { zh: '已归档', en: 'Archived' },
};

export function decisionStatusLabel(status: string, t: Translate): string {
  return lookup(DECISION_STATUS_LABELS, status, t);
}

/** An Activity's `status` (`substrate/epistemic/activities.ts`: `startActivity` writes `running`,
 *  `endActivity` / Turn recovery write `completed` / `failed` / `interrupted`) — the same four
 *  values as `@nexttime/shared` `TURN_STATUS_VALUES`, a Turn being one kind of Activity. */
export const ACTIVITY_STATUS_LABELS: Readonly<Record<TurnStatus, BilingualLabel>> = {
  running: { zh: '运行中', en: 'Running' },
  completed: { zh: '已完成', en: 'Completed' },
  failed: { zh: '失败', en: 'Failed' },
  interrupted: { zh: '已中断', en: 'Interrupted' },
};

export function activityStatusLabel(status: string, t: Translate): string {
  return lookup(ACTIVITY_STATUS_LABELS, status, t);
}

/** An Activity's `kind` — the kernel names it freely (no enum, no DB CHECK), so this keys the
 *  kinds the kernel writes today; a new one keeps its raw name. */
export const ACTIVITY_KIND_LABELS: Readonly<Record<string, BilingualLabel>> = {
  agent_turn: { zh: '入口 agent 回合', en: 'Entry agent turn' },
  gatekeeper_apply: { zh: '门执行', en: 'Gate apply' },
  gatekeeper_observe: { zh: '门观测', en: 'Gate observation' },
  worker_run: { zh: 'Worker 运行', en: 'Worker run' },
  worker_session: { zh: 'Worker 会话', en: 'Worker session' },
  worker_result: { zh: 'Worker 结果', en: 'Worker result' },
  worker_gate_call: { zh: 'Worker 调用门', en: 'Worker gate call' },
  operation_proposal: { zh: 'Operation 提议', en: 'Operation proposal' },
  operation_publish: { zh: 'Operation 发布', en: 'Operation publish' },
  skill_publish: { zh: 'Skill 发布', en: 'Skill publish' },
  procedure_publish: { zh: '流程发布', en: 'Procedure publish' },
  'governance.approval_decision': { zh: '审批决定', en: 'Approval decision' },
  'governance.create_connection': { zh: '建立连接', en: 'Connection created' },
  'governance.enable_gate_instance': { zh: '启用门实例', en: 'Gate instance enabled' },
  'governance.refresh_operation_governance': {
    zh: '刷新 Operation 治理',
    en: 'Operation governance refreshed',
  },
  'governance.register_gatekeeper': { zh: '注册门', en: 'Gatekeeper registered' },
  'epistemic.conflict_resolution': { zh: '冲突裁决', en: 'Conflict resolution' },
  'epistemic.human_attestation': { zh: '人工确认', en: 'Human attestation' },
  'ingest.submit_observations': { zh: '提交观测', en: 'Observations submitted' },
};

export function activityKindLabel(kind: string, t: Translate): string {
  return lookup(ACTIVITY_KIND_LABELS, kind, t);
}

/** A Source's `kind` the kernel registers itself (`observed-facts.ts` `gatekeeper`,
 *  `worker-run-source.ts` `worker_run`, `task/result.ts`'s private `worker_session` transcript);
 *  an ingest client names its own kinds freely, and those keep their raw name. */
export const SOURCE_KIND_LABELS: Readonly<Record<string, BilingualLabel>> = {
  gatekeeper: { zh: '门', en: 'Gatekeeper' },
  worker_run: { zh: 'Worker 运行', en: 'Worker run' },
  worker_session: { zh: 'Worker 会话', en: 'Worker session' },
};

export function sourceKindLabel(kind: string, t: Translate): string {
  return lookup(SOURCE_KIND_LABELS, kind, t);
}

/** A Source's `visibility` (`substrate/epistemic/sources.ts`: `'private' | 'workspace'`; the shared
 *  `wire/ingest.ts` schema's own `z.enum`). */
export const SOURCE_VISIBILITY_VALUES = ['workspace', 'private'] as const;
export type SourceVisibility = (typeof SOURCE_VISIBILITY_VALUES)[number];
export const SOURCE_VISIBILITY_LABELS: Readonly<Record<SourceVisibility, BilingualLabel>> = {
  workspace: { zh: '工作区可见', en: 'Workspace' },
  private: { zh: '仅自己', en: 'Private' },
};

export function sourceVisibilityLabel(visibility: string, t: Translate): string {
  return lookup(SOURCE_VISIBILITY_LABELS, visibility, t);
}

/** A platform container's Docker state (`platform_status` runtime containers — Docker's own
 *  `State.Status` vocabulary, not a kernel enum). */
export const CONTAINER_STATE_VALUES = [
  'created',
  'running',
  'paused',
  'restarting',
  'removing',
  'exited',
  'dead',
] as const;
export type ContainerState = (typeof CONTAINER_STATE_VALUES)[number];
export const CONTAINER_STATE_LABELS: Readonly<Record<ContainerState, BilingualLabel>> = {
  created: { zh: '已创建', en: 'Created' },
  running: { zh: '运行中', en: 'Running' },
  paused: { zh: '已暂停', en: 'Paused' },
  restarting: { zh: '重启中', en: 'Restarting' },
  removing: { zh: '删除中', en: 'Removing' },
  exited: { zh: '已退出', en: 'Exited' },
  dead: { zh: '已失效', en: 'Dead' },
};

export function containerStateLabel(state: string, t: Translate): string {
  return lookup(CONTAINER_STATE_LABELS, state, t);
}
