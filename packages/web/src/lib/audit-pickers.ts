import type {
  ActionRequestWire,
  AuditRecordWire,
  ChatWire,
  ConnectionRequestWire,
  DecisionWire,
  GatekeeperSummaryWire,
  ObjectWire,
  OntologyTypeWire,
  OperationSummaryWire,
  PrincipalWire,
  ProcedureSummaryWire,
  ResolvedRefWire,
  SkillSummaryWire,
  TaskWire,
  WorkerDefinitionWire,
} from '@nexttime/shared';
import { CAPABILITY_REGISTRY } from '@nexttime/shared';
import type { CapabilityCaller } from './clients.js';
import { formatRelative } from './format.js';
import { objectDisplayName } from './graph-view.js';
import type { Translate } from './i18n.js';
import { roleLabel } from './labels.js';
import { ownEntry } from './own.js';

/**
 * lib/audit-pickers: where the audit pages' id / name filters get their candidates from, so a
 * reader picks a value that already exists instead of typing it (field-inventory §11: "资源 id /
 * 节点 id / 对象 id / 动作种类 are bare text boxes"). Each `PickerSource` wraps one existing
 * read capability — no new kernel surface — and maps its rows to `{id, label, detail}`;
 * `lib/audit-id-picker.tsx` renders them. Every source that needs a role the caller may lack
 * carries a `fallback` the audit audience can always read (`audit_query`: ids that actually
 * appear in the audit log for that resource type).
 */

export interface PickerOption {
  /** The value the filter / capability receives. */
  readonly id: string;
  /** What the reader recognises (a name, a summary). */
  readonly label: string;
  /** A second, muted fact (status, kind, relative time). */
  readonly detail?: string;
}

export interface PickerSource {
  /** Identifies the request for the dedupe cache — same key and query, same call. */
  readonly key: string;
  /** `true`: the typed text is sent to the capability as its search parameter; `false`: the
   *  list is loaded once and filtered in the browser. */
  readonly searchable: boolean;
  readonly load: (http: CapabilityCaller, query: string) => Promise<readonly PickerOption[]>;
  /** Used when `load` is refused (403) — a source the caller can still read. */
  readonly fallback?: PickerSource;
}

/** One page is enough for a picker: past this the reader types to narrow (searchable sources)
 *  or pastes the id. */
export const PICKER_LIMIT = 50;
/** How many audit rows the "seen in the audit log" sources scan for distinct ids. */
export const AUDIT_SCAN_LIMIT = 200;

interface Page<T> {
  readonly items: readonly T[];
}

function dedupe(options: readonly PickerOption[]): readonly PickerOption[] {
  const seen = new Set<string>();
  const out: PickerOption[] = [];
  for (const option of options) {
    if (option.id === '' || seen.has(option.id)) continue;
    seen.add(option.id);
    out.push(option);
  }
  return out;
}

function withQuery(base: Record<string, unknown>, key: string, query: string) {
  const trimmed = query.trim();
  return trimmed === '' ? base : { ...base, [key]: trimmed };
}

/** Best-effort `resolve_refs` names for `ids` (auditor- and member-readable). A failure leaves
 *  the ids unnamed rather than failing the picker. */
async function resolveNames(
  http: CapabilityCaller,
  ids: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  if (ids.length === 0) return new Map();
  try {
    const page = await http.call<Page<ResolvedRefWire>>('resolve_refs', {
      ids: ids.slice(0, AUDIT_SCAN_LIMIT),
    });
    const names = new Map<string, string>();
    for (const ref of page.items) if (ref.name) names.set(ref.id, ref.name);
    return names;
  } catch {
    return new Map();
  }
}

/** Ids of `resourceType` that appear in the newest audit rows (`audit_query`, auditor), newest
 *  first, labelled with the action that touched them — and with a name when `resolve_refs`
 *  knows the kind (principal, chat, task, …). */
export function auditRecentSource(resourceType: string): PickerSource {
  return {
    key: `audit_query:resource:${resourceType}`,
    searchable: false,
    load: async (http) => {
      const page = await http.call<Page<AuditRecordWire>>('audit_query', {
        filter: { resourceType },
        limit: AUDIT_SCAN_LIMIT,
      });
      const rows = page.items.filter((row) => row.resourceId);
      const names = await resolveNames(http, [...new Set(rows.map((row) => row.resourceId ?? ''))]);
      return dedupe(
        rows.map((row) => {
          const id = row.resourceId ?? '';
          const name = names.get(id);
          return {
            id,
            label: name ?? row.action,
            detail: name
              ? `${row.action} · ${formatRelative(row.createdAt)}`
              : formatRelative(row.createdAt),
          };
        }),
      );
    },
  };
}

/** Principals that acted in the newest audit rows — the actor filter's candidates when
 *  `list_principals` (operator) is refused, e.g. for an auditor. Names via `resolve_refs`. */
export function auditActorSource(t: Translate): PickerSource {
  return {
    key: 'audit_query:actors',
    searchable: false,
    load: async (http) => {
      const page = await http.call<Page<AuditRecordWire>>('audit_query', {
        limit: AUDIT_SCAN_LIMIT,
      });
      const ids = [...new Set(page.items.map((row) => row.actorPrincipalId))];
      const names = await resolveNames(http, ids);
      return dedupe(
        page.items.map((row) => ({
          id: row.actorPrincipalId,
          label: names.get(row.actorPrincipalId) ?? t('未知主体', 'Unknown principal'),
          detail: t(
            `最近：${formatRelative(row.createdAt)}`,
            `Last seen ${formatRelative(row.createdAt)}`,
          ),
        })),
      );
    },
  };
}

/** Recent Decisions (`query_decisions`, member + auditor). */
export function decisionSource(t: Translate): PickerSource {
  return {
    key: 'query_decisions:recent',
    searchable: false,
    load: async (http) => {
      const page = await http.call<Page<DecisionWire>>('query_decisions', {
        limit: PICKER_LIMIT,
      });
      return dedupe(
        page.items.map((decision) => ({
          id: decision.id,
          label: decision.summary ?? t('（无摘要）', '(no summary)'),
          detail: `${decision.status} · ${formatRelative(decision.createdAt)}`,
        })),
      );
    },
  };
}

/** Graph Objects (`search{query}`, member + auditor) — an empty query browses the most recently
 *  updated ones. */
export function objectSource(): PickerSource {
  return {
    key: 'search:objects',
    searchable: true,
    load: async (http, query) => {
      const page = await http.call<Page<ObjectWire>>('search', {
        query: query.trim(),
        limit: PICKER_LIMIT,
      });
      return dedupe(
        page.items.map((object) => ({
          id: object.id,
          label: objectDisplayName(object) ?? object.objectType,
          detail: object.objectType,
        })),
      );
    },
  };
}

async function gatekeeperNames(http: CapabilityCaller): Promise<ReadonlyMap<string, string>> {
  try {
    const page = await http.call<Page<GatekeeperSummaryWire>>('list_gatekeepers', {});
    return new Map(page.items.map((gate) => [gate.id, gate.name]));
  } catch {
    return new Map();
  }
}

/** Operation names (`list_operations{q}`, member + auditor) — the value a Decision's
 *  `actionKind` (and so `find_precedents{actionKindTag}`) carries. One option per name; the
 *  detail lists the gates that offer it. */
export function operationNameSource(): PickerSource {
  return {
    key: 'list_operations:names',
    searchable: true,
    load: async (http, query) => {
      const [page, gates] = await Promise.all([
        http.call<Page<OperationSummaryWire>>('list_operations', withQuery({}, 'q', query)),
        gatekeeperNames(http),
      ]);
      const byName = new Map<string, Set<string>>();
      for (const op of page.items) {
        const set = byName.get(op.name) ?? new Set<string>();
        set.add(gates.get(op.gatekeeperId) ?? op.gatekeeperId.slice(0, 8));
        byName.set(op.name, set);
      }
      return [...byName.entries()].map(([name, gateSet]) => ({
        id: name,
        label: name,
        detail: [...gateSet].join(', '),
      }));
    },
  };
}

/** The explain / causal-chain node kinds and where their recent ids come from: Decisions from
 *  `query_decisions`; Facts and Activities from the audit log (no list capability exists). */
export type ProvenanceNodeKind = 'decision' | 'fact' | 'activity';

export function provenanceNodeSource(kind: ProvenanceNodeKind, t: Translate): PickerSource {
  return kind === 'decision' ? decisionSource(t) : auditRecentSource(kind);
}

type SourceFactory = (t: Translate) => PickerSource;

function listSource<T>(
  name: string,
  params: Record<string, unknown>,
  map: (row: T, t: Translate) => PickerOption,
  searchParam?: string,
): SourceFactory {
  return (t) => ({
    key: `${name}:${JSON.stringify(params)}`,
    searchable: searchParam !== undefined,
    load: async (http, query) => {
      const page = await http.call<Page<T>>(
        name,
        searchParam ? withQuery(params, searchParam, query) : params,
      );
      return dedupe(page.items.map((row) => map(row, t)));
    },
  });
}

/** `resourceType` → the list capability that names its ids (field-inventory §11 mapping). Types
 *  missing here (fact, activity, policy, …) use the audit log itself. */
const RESOURCE_SOURCES: Readonly<Record<string, SourceFactory>> = {
  gatekeeper: listSource<GatekeeperSummaryWire>(
    'list_gatekeepers',
    {},
    (gate) => ({ id: gate.id, label: gate.name, detail: gate.kind }),
    'q',
  ),
  operation: (t) => ({
    key: 'list_operations:ids',
    searchable: true,
    load: async (http, query) => {
      const [page, gates] = await Promise.all([
        http.call<Page<OperationSummaryWire>>('list_operations', withQuery({}, 'q', query)),
        gatekeeperNames(http),
      ]);
      // The kernel audits an Operation as `${gatekeeperId}:${name}`.
      return dedupe(
        page.items.map((op) => ({
          id: `${op.gatekeeperId}:${op.name}`,
          label: op.name,
          detail: `${gates.get(op.gatekeeperId) ?? t('未知门', 'Unknown gate')} · ${op.status}`,
        })),
      );
    },
  }),
  principal: listSource<PrincipalWire>(
    'list_principals',
    { limit: PICKER_LIMIT },
    (principal, t) => ({
      id: principal.id,
      label: principal.displayName ?? principal.id.slice(0, 8),
      detail: roleLabel(principal.role, t),
    }),
    'q',
  ),
  skill: listSource<SkillSummaryWire>('list_skills', { limit: PICKER_LIMIT }, (skill) => ({
    id: skill.id,
    label: skill.name,
    detail: skill.status,
  })),
  procedure: listSource<ProcedureSummaryWire>(
    'list_procedures',
    { limit: PICKER_LIMIT },
    (procedure) => ({ id: procedure.id, label: procedure.name, detail: procedure.status }),
  ),
  worker_definition: listSource<WorkerDefinitionWire>(
    'list_worker_definitions',
    { limit: PICKER_LIMIT },
    (definition) => {
      const name = definition.definition.name;
      return {
        id: definition.id,
        label: typeof name === 'string' && name !== '' ? name : definition.id.slice(0, 8),
        detail: definition.kind,
      };
    },
  ),
  action_request: listSource<ActionRequestWire>(
    'list_action_requests',
    { limit: PICKER_LIMIT },
    (request) => ({ id: request.id, label: request.actionKindTag, detail: request.status }),
  ),
  chat: listSource<ChatWire>('list_chats', { includeArchived: true }, (chat, t) => ({
    id: chat.id,
    label: chat.title ?? t('未命名对话', 'Untitled chat'),
    detail: formatRelative(chat.lastActivityAt),
  })),
  object: () => objectSource(),
  ontology_type: listSource<OntologyTypeWire>('list_types', {}, (type) => ({
    // The kernel audits an ontology type by its name.
    id: type.name,
    label: type.name,
    detail: type.kind,
  })),
  connection_request: listSource<ConnectionRequestWire>(
    'list_connection_requests',
    {},
    (request) => ({ id: request.id, label: request.target, detail: request.status }),
  ),
  task: listSource<TaskWire>('list_tasks', { limit: PICKER_LIMIT }, (task) => ({
    id: task.id,
    label: task.status,
    detail: formatRelative(task.createdAt),
  })),
  decision: (t) => decisionSource(t),
};

/** The audit filter's resource-id candidates for `resourceType` — its list capability with the
 *  audit log as the fallback, or the audit log alone. `null` until a type is chosen. */
export function resourceIdSource(resourceType: string, t: Translate): PickerSource | null {
  if (resourceType.trim() === '') return null;
  const recent = auditRecentSource(resourceType);
  const factory = ownEntry(RESOURCE_SOURCES, resourceType);
  return factory ? { ...factory(t), fallback: recent } : recent;
}

/**
 * Platform audit actions the kernel writes outside a capability dispatch (every one with
 * `workspaceId: null`): workspace creation, purges, identity claims and gate / LLM-admin events.
 * `platform.llm_*` mirrors `interfaces/http/internal/llm-admin-audit.ts`'s event enum prefixed by
 * `application/platform/llm-admin-audit.ts`. Suggestions only — the filter stays free text.
 */
export const PLATFORM_LIFECYCLE_ACTIONS = [
  'workspace.created',
  'platform.user_purged',
  'platform.workspace_purged',
  'platform.llm_admin_token_issued',
  'platform.llm_provider_created',
  'platform.llm_provider_updated',
  'platform.llm_provider_deleted',
  'platform.llm_provider_tested',
  'platform.llm_provider_secret_set',
  'platform.llm_provider_secret_cleared',
  'platform.llm_provider_models_listed',
  'platform.llm_provider_models_probed',
  'user.identity_claimed',
  'principal.user_rebound',
  'gate_instance.manifest_confirmed',
  'connector.entry_handles_revoked',
] as const;

/** Every `scope: 'platform'` capability name (a platform dispatch is audited under its own name)
 *  plus the lifecycle actions above, sorted — the platform audit page's action suggestions. */
export function platformAuditActionSuggestions(): readonly string[] {
  const names = new Set<string>(PLATFORM_LIFECYCLE_ACTIONS);
  for (const capability of CAPABILITY_REGISTRY) {
    if (capability.scope === 'platform') names.add(capability.name);
  }
  return [...names].sort();
}

/** Quick "since" presets for the provenance tools' time filter. */
export const SINCE_PRESETS = [
  { key: '1h', ms: 60 * 60 * 1000, zh: '最近 1 小时', en: 'Last hour' },
  { key: '24h', ms: 24 * 60 * 60 * 1000, zh: '最近 24 小时', en: 'Last 24 hours' },
  { key: '7d', ms: 7 * 24 * 60 * 60 * 1000, zh: '最近 7 天', en: 'Last 7 days' },
] as const;

/** Case-insensitive match of `text` against an option's id, label and detail. */
export function optionMatches(option: PickerOption, text: string): boolean {
  const needle = text.trim().toLowerCase();
  if (needle === '') return true;
  return [option.id, option.label, option.detail ?? ''].some((value) =>
    value.toLowerCase().includes(needle),
  );
}
