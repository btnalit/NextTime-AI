import type { PrincipalKind, WorkerDefinitionKind } from '@nexttime/shared';
import type { AuditResourceType } from './audit.js';
import type { Translate } from './i18n.js';
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
  const entry = (WORKER_DEFINITION_KIND_LABELS as Readonly<Record<string, BilingualLabel>>)[kind];
  return entry ? label(entry, t) : kind;
}

// -------------------------------------------------------------------------------------------
// Audit resource type (`lib/audit.ts` `AUDIT_RESOURCE_TYPES` — the kernel does not publish this
// as a formal `@nexttime/shared` enum, see that file's own comment; typed against its union all
// the same). The audit page's resource-type `<select>` and the row's resource chip.
// -------------------------------------------------------------------------------------------

export const AUDIT_RESOURCE_TYPE_LABELS: Readonly<Record<AuditResourceType, BilingualLabel>> = {
  action_request: { zh: '审批请求', en: 'Action request' },
  activity: { zh: '活动', en: 'Activity' },
  agent_policy: { zh: '工作区策略', en: 'Agent policy' },
  agent_profile: { zh: '入口 / Worker 定义', en: 'Agent profile' },
  capability_grant: { zh: '能力授权', en: 'Capability grant' },
  chat: { zh: '对话', en: 'Chat' },
  conflict: { zh: '冲突', en: 'Conflict' },
  connection_request: { zh: '连接申请', en: 'Connection request' },
  decision: { zh: '决策', en: 'Decision' },
  fact: { zh: '事实', en: 'Fact' },
  gatekeeper: { zh: '门实例', en: 'Gatekeeper' },
  object: { zh: '对象', en: 'Object' },
  ontology_type: { zh: '本体类型', en: 'Ontology type' },
  ontology_version: { zh: '本体版本', en: 'Ontology version' },
  operation: { zh: 'Operation', en: 'Operation' },
  policy: { zh: '策略', en: 'Policy' },
  principal: { zh: '主体', en: 'Principal' },
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

export function auditResourceTypeLabel(resourceType: string, t: Translate): string {
  const entry = (AUDIT_RESOURCE_TYPE_LABELS as Readonly<Record<string, BilingualLabel>>)[
    resourceType
  ];
  return entry ? label(entry, t) : resourceType;
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

/** A connector's three-state mode (`disabled`/`self_serve`/`platform_preset`) as plain text — for
 *  the platform integrations page's mode `<select>` `<option>`s and its confirm dialog title
 *  (audit S14's literal "platform_preset / self_serve" example; `copy-guard-baseline.json`
 *  `platform-integrations`). */
export function connectorModeLabel(mode: string, t: Translate): string {
  return labelText(statusChipStyle('connectorMode', mode), t);
}
