/**
 * interfaces/mcp/reference-tool-aliases: the Semantica 0.6.7 MCP tool-name/required-param contract
 * (design doc §9.3 "Semantica 的 17 个工具名与必填参数作为契约保留"; docs/development-tasks.md
 * S3.6 "Semantica 17 个工具名与必填参数别名").
 *
 * Semantica's real MCP surface (its top-level `mcp/tools/{decisions,export,extraction,graph,
 * reasoning}.py`, `D:\NextTime AI\semantica-0.6.7` — the read-only reference project this task
 * cites, not `semantica/mcp_server/__init__.py`'s older 15-tool duplicate) registers exactly 17
 * tools: `extract_entities`, `extract_relations`, `extract_all`, `record_decision`,
 * `query_decisions`, `find_precedents`, `get_causal_chain`, `analyze_decision_impact`,
 * `add_entity`, `add_relationship`, `search_graph`, `get_graph_summary`, `get_graph_analytics`,
 * `run_reasoning`, `abductive_reasoning`, `export_graph`, `get_provenance`.
 *
 * Mapping decision (per this task's own instruction — "map Semantica's tool names + required-
 * param names to our capabilities where semantically equal; document the table; unmapped
 * Semantica tools are omitted, not faked"), one row per Semantica tool:
 *
 *   | Semantica tool          | Our capability   | required-param rename        | why |
 *   |--------------------------|------------------|-------------------------------|-----|
 *   | `get_provenance`         | `explain`        | `entity_id` → `nodeId`        | design doc §9.3 names this pair explicitly ("get_provenance=explain"). |
 *   | `get_causal_chain`       | `causal_chain`   | `decision_id` → `decisionId`  | design doc §9.3 explicit pairing; Semantica's optional `direction`/`max_depth` have no counterpart on our side and are dropped (our `causal_chain` accepts only `decisionId`, `.strict()`). |
 *   | `analyze_decision_impact`| `decision_impact`| `decision_id` → `decisionId`  | design doc §9.3 explicit pairing. |
 *   | `search_graph`           | `search`         | `query` → `query` (identity); optional `node_type` → `objectType` | both are "find Objects matching a term, optionally filtered by type"; Semantica's optional `limit` has no counterpart and is dropped. |
 *   | `add_relationship`       | `assert_fact`    | `source` → `objectId`, `target` → `value`, optional `type` → `linkType` | our ontology models a relationship as a LinkType-typed Fact on the source Object whose value is the target's identity — the same shape `validate`'s own `{link:{linkType,sourceType,targetType}}` domain/range check assumes. Semantica's `type` is optional; our `linkType` is required (`.strict()`) — omitting it fails validation exactly as it would calling `assert_fact` directly, never silently defaulted. |
 *   | `record_decision`        | *(native, not aliased)* | — | the capability name is already `record_decision` — adding a second tool under the same name would collide. Semantica's required shape (`category`/`scenario`/`reasoning`/`outcome`/`confidence`) has no correspondence to ours (`summary`/optional `relatedFactIds`/`relatedTaskId`); a caller gets the *native* `record_decision` tool (our own schema), not a translated one. |
 *   | `query_decisions`        | *(native, not aliased)* | — | same name collision as `record_decision`; Semantica's optional `query`/`category`/`outcome`/`limit` vs. our optional `filter: object` — no clean rename. |
 *   | `find_precedents`        | *(native, not aliased)* | — | same name collision; Semantica's required `scenario` vs. our required `need` are the same concept, but adding a same-named alias tool is impossible — a client must use the native `find_precedents` tool's own `need` field. |
 *   | `extract_entities`, `extract_relations`, `extract_all` | — | — | NLP entity/relation extraction over free text — no equivalent capability (this platform's graph is populated by collectors/ontology publishing and agent `assert_fact` calls, never by extracting a plain-text blob). |
 *   | `add_entity`             | —                | —                              | no capability creates an arbitrary Object with a caller-chosen id/type/label — Object identity comes from a domain pack's `ObjectType` + a collector/ontology write path, not a generic "add a node" call. |
 *   | `get_graph_summary`, `get_graph_analytics` | — | — | no aggregate graph-statistics/analytics (PageRank, betweenness, …) capability exists. |
 *   | `run_reasoning`, `abductive_reasoning` | — | — | the design doc explicitly excludes Semantica's reasoning engine from this platform's scope (§14 "不要做": "Semantica 推理引擎与 Explorer Ontology 工作区"). |
 *   | `export_graph`           | —                | —                              | no RDF/turtle/json-ld graph-export capability exists; `export_prov` (audit group) is a different concept (a PROV-O provenance export, not the whole graph) and is itself still unimplemented. |
 *
 * Each alias below is registered as an *additional* MCP tool (under Semantica's own name) only
 * when its target capability is in the connecting Handle's scope — never a substitute for the
 * native, capability-named tool, which is always projected too (tool-projection.ts).
 */

export interface JsonSchemaObject {
  readonly type: 'object';
  readonly properties: Readonly<Record<string, unknown>>;
  readonly required?: readonly string[];
}

export interface ReferenceToolAlias {
  /** The tool name a Semantica-familiar MCP client (or its own skills/docs) expects. */
  readonly aliasName: string;
  /** The capability this alias dispatches to once `translate` has renamed the caller's args. */
  readonly capability: string;
  /** `Tool.inputSchema` — Semantica's own field names, so a caller following Semantica's own docs
   *  sees a schema that matches them, not our internal param names. */
  readonly inputSchema: JsonSchemaObject;
  readonly description: string;
  /** Renames Semantica-style argument keys to the target capability's own param keys. Keys with
   *  no Semantica-side value present are simply omitted — never defaulted or fabricated (a
   *  omitted-but-required field on the target capability's own paramsSchema surfaces as that
   *  capability's own ordinary `invalid_params` error, exactly as a direct call would). */
  readonly translate: (args: Record<string, unknown>) => Record<string, unknown>;
}

function renamed(
  args: Record<string, unknown>,
  mapping: Readonly<Record<string, string>>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [fromKey, toKey] of Object.entries(mapping)) {
    if (args[fromKey] !== undefined) out[toKey] = args[fromKey];
  }
  return out;
}

export const MCP_TOOL_ALIASES: readonly ReferenceToolAlias[] = [
  {
    aliasName: 'get_provenance',
    capability: 'explain',
    inputSchema: {
      type: 'object',
      properties: {
        entity_id: { type: 'string', description: 'Entity or node ID to get provenance for' },
      },
      required: ['entity_id'],
    },
    description:
      'Fact/Decision/Turn → Observation → Activity → Source + Principal provenance chain ' +
      '(Semantica get_provenance; our capability: explain).',
    translate: (args) => renamed(args, { entity_id: 'nodeId' }),
  },
  {
    aliasName: 'get_causal_chain',
    capability: 'causal_chain',
    inputSchema: {
      type: 'object',
      properties: {
        decision_id: { type: 'string', description: 'ID of the decision to trace' },
      },
      required: ['decision_id'],
    },
    description:
      'Causal chain leading to a Decision (Semantica get_causal_chain; our capability: ' +
      'causal_chain — Semantica\u2019s optional direction/max_depth have no counterpart here).',
    translate: (args) => renamed(args, { decision_id: 'decisionId' }),
  },
  {
    aliasName: 'analyze_decision_impact',
    capability: 'decision_impact',
    inputSchema: {
      type: 'object',
      properties: {
        decision_id: { type: 'string', description: 'ID of the decision to analyse' },
      },
      required: ['decision_id'],
    },
    description:
      'Downstream impact of a Decision (Semantica analyze_decision_impact; our capability: ' +
      'decision_impact).',
    translate: (args) => renamed(args, { decision_id: 'decisionId' }),
  },
  {
    aliasName: 'search_graph',
    capability: 'search',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search term or phrase' },
        node_type: { type: 'string', description: 'Filter by node type (optional)' },
      },
      required: ['query'],
    },
    description:
      'Search Objects/Facts (Semantica search_graph; our capability: search — Semantica\u2019s ' +
      'optional limit has no counterpart here).',
    translate: (args) => renamed(args, { query: 'query', node_type: 'objectType' }),
  },
  {
    aliasName: 'add_relationship',
    capability: 'assert_fact',
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'Source node ID' },
        target: { type: 'string', description: 'Target node ID' },
        type: { type: 'string', description: 'Relationship type, e.g. \u2018WORKS_AT\u2019' },
      },
      required: ['source', 'target'],
    },
    description:
      'Add a relationship between two Objects (Semantica add_relationship; our capability: ' +
      'assert_fact — a LinkType-typed Fact on the source Object whose value is the target\u2019s ' +
      'identity key. Our assert_fact requires linkType; Semantica\u2019s type is optional there — ' +
      'omitting it fails the underlying assert_fact call, it is never defaulted.)',
    translate: (args) => renamed(args, { source: 'objectId', target: 'value', type: 'linkType' }),
  },
];
