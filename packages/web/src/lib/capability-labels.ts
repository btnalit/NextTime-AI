import type { Translate } from './i18n.js';
import { ownEntry } from './own.js';

/**
 * lib/capability-labels: human copy for the names the kernel puts on the wire as identifiers —
 * every `CAPABILITY_REGISTRY` capability name (`list_platform_models`, `approve`, `<gate>.<op>`),
 * every lifecycle audit action (`lib/audit.ts` `AUDIT_LIFECYCLE_ACTIONS`: `action_request.approve`,
 * `task.complete`, …) and the other literal `action` strings the kernel (and its migrations) write
 * into audit rows — the platform audit stream's `platform.*` / `cli.*` / `workspace.created` rows
 * and a few workspace ones (`operation.description_updated`, `draft.expired`, …). The audit lists
 * and the Worker capability checklist show `actionLabel` (a short verb-first name) with
 * `actionHint` (one line of what it does / what it changes) instead of the raw snake_case name.
 *
 * Capabilities read as commands ("批准动作请求"); audit events that are not capability names read
 * as things that happened ("动作请求已批准"). Terminology follows the console: 门 / 门实例, 接入包,
 * 动作请求, 流程, Skill, 事实, 主体, 授权, 审批, 供应商, 外部运行时, 智能体.
 *
 * Pure data plus two lookups; the active language is picked by the caller's `t`, same as
 * `lib/labels.ts`. An unknown name (a capability added to the registry before its copy, an audit
 * action this table does not know yet) falls back to the raw name — never a blank cell.
 */
export interface ActionCopy {
  /** Short Chinese label, verb first (2–10 characters). */
  readonly zh: string;
  /** Short English label, sentence case (2–5 words). */
  readonly en: string;
  /** One Chinese sentence: what it does and, for a write, what it changes. */
  readonly zhHint: string;
  /** The English counterpart of `zhHint`. */
  readonly enHint: string;
}

/** Keyed by capability name or lifecycle / platform audit action. */
export const ACTION_COPY: Readonly<Record<string, ActionCopy>> = {
  // -----------------------------------------------------------------------------------------
  // Capabilities — chat
  // -----------------------------------------------------------------------------------------
  list_chats: {
    zh: '查看对话列表',
    en: 'List chats',
    zhHint: '列出你的对话，最新的在前。',
    enHint: 'Lists your chats, newest first.',
  },
  new_chat: {
    zh: '新建对话',
    en: 'New chat',
    zhHint: '为你创建一个新的私有对话。',
    enHint: 'Creates a new private chat for you.',
  },
  send_chat_message: {
    zh: '发送对话消息',
    en: 'Send chat message',
    zhHint: '在对话里发消息，并开始新一轮回复。',
    enHint: 'Sends a message on a chat and starts a new turn.',
  },
  stop_agent: {
    zh: '停止回复',
    en: 'Stop reply',
    zhHint: '停止对话里正在进行的这一轮。',
    enHint: 'Stops the turn in progress on a chat.',
  },
  get_chat_history: {
    zh: '读取对话记录',
    en: 'Read chat history',
    zhHint: '分页读取对话里已保存的消息。',
    enHint: "Pages through a chat's saved messages.",
  },
  subscribe_chat: {
    zh: '订阅对话更新',
    en: 'Subscribe to chat',
    zhHint: '订阅对话的实时事件，不漏掉消息。',
    enHint: "Subscribes to a chat's live events so nothing is missed.",
  },
  archive_chat: {
    zh: '归档对话',
    en: 'Archive chat',
    zhHint: '归档对话，默认列表里不再显示。',
    enHint: 'Archives a chat; it leaves the default list.',
  },
  unarchive_chat: {
    zh: '恢复对话',
    en: 'Restore chat',
    zhHint: '把已归档的对话恢复到列表。',
    enHint: 'Restores an archived chat to the list.',
  },
  rename_chat: {
    zh: '重命名对话',
    en: 'Rename chat',
    zhHint: '修改对话标题，之后不再自动改名。',
    enHint: "Sets a chat's title; it is no longer auto-titled.",
  },
  list_chat_turns: {
    zh: '查看对话轮次',
    en: 'List chat turns',
    zhHint: '列出对话每一轮的状态、所循流程与结果。',
    enHint: "Lists each turn's status, procedure followed and outcome.",
  },
  mark_turn_outcome: {
    zh: '标记本轮是否达成',
    en: 'Mark turn outcome',
    zhHint: '标记自己发起的一轮是否达成目标。',
    enHint: 'Marks whether your own turn achieved its goal.',
  },

  // -----------------------------------------------------------------------------------------
  // Capabilities — ontology
  // -----------------------------------------------------------------------------------------
  publish_ontology_version: {
    zh: '发布本体版本',
    en: 'Publish ontology version',
    zhHint: '把你的本体草稿发布为工作区生效版本。',
    enHint: 'Publishes your ontology draft as the live version.',
  },
  propose_ontology_change: {
    zh: '提议本体变更',
    en: 'Propose ontology change',
    zhHint: '起草一份本体变更，发布前只有你可见。',
    enHint: 'Drafts an ontology change only you can see until published.',
  },
  get_type: {
    zh: '查看类型定义',
    en: 'Read type definition',
    zhHint: '读取一个对象、关系或动作类型的定义。',
    enHint: 'Reads one object, link or action type definition.',
  },
  list_types: {
    zh: '查看类型清单',
    en: 'List types',
    zhHint: '列出已发布本体里的类型定义。',
    enHint: 'Lists the type definitions in the published ontology.',
  },
  validate: {
    zh: '校验关系类型',
    en: 'Validate link type',
    zhHint: '检查候选关系是否符合本体的类型约束。',
    enHint: "Checks a candidate link against the ontology's type rules.",
  },
  list_ontology_versions: {
    zh: '查看本体版本',
    en: 'List ontology versions',
    zhHint: '列出已发布的本体版本和你自己的草稿。',
    enHint: 'Lists published ontology versions and your own drafts.',
  },

  // -----------------------------------------------------------------------------------------
  // Capabilities — graph
  // -----------------------------------------------------------------------------------------
  get_object: {
    zh: '查看对象',
    en: 'Read object',
    zhHint: '读取一个对象及其当前属性。',
    enHint: 'Reads one object with its current properties.',
  },
  traverse: {
    zh: '沿关系遍历',
    en: 'Traverse links',
    zhHint: '从一个对象出发，沿关系向外走几跳。',
    enHint: 'Walks links outward from an object for a few hops.',
  },
  search: {
    zh: '搜索对象',
    en: 'Search objects',
    zhHint: '按属性或标识里的文字搜索对象。',
    enHint: 'Searches objects by text in their properties or identity.',
  },
  list_facts: {
    zh: '按关系查事实',
    en: 'List facts by link type',
    zhHint: '列出某一种关系的全部有效事实。',
    enHint: 'Lists every active fact of one link type.',
  },
  state_at: {
    zh: '查看历史状态',
    en: 'Read past state',
    zhHint: '读取对象在某一时刻的状态。',
    enHint: "Reads an object's state as of a given moment.",
  },
  graph_freshness: {
    zh: '查看数据新鲜度',
    en: 'Check data freshness',
    zhHint: '查看各来源最近一次观测是否已经过旧。',
    enHint: "Shows whether each source's latest observation is stale.",
  },
  graph_overview: {
    zh: '查看图谱概况',
    en: 'Graph overview',
    zhHint: '按关系类型统计当前有效的事实数。',
    enHint: 'Counts the active facts per link type.',
  },
  find_operations: {
    zh: '按需查找操作',
    en: 'Find operations',
    zhHint: '按需求关键词查找你有权使用的门操作。',
    enHint: 'Finds the gate operations you may use, by keyword.',
  },
  find_workers: {
    zh: '查找 Worker 定义',
    en: 'Find Worker definitions',
    zhHint: '按关键词查找已发布的 Worker 定义。',
    enHint: 'Finds published Worker definitions by keyword.',
  },
  find_procedures: {
    zh: '查找流程',
    en: 'Find procedures',
    zhHint: '按关键词查找已发布的流程。',
    enHint: 'Finds published procedures by keyword.',
  },

  // -----------------------------------------------------------------------------------------
  // Capabilities — gate
  // -----------------------------------------------------------------------------------------
  observe_operation: {
    zh: '运行门的读操作',
    en: 'Run gate read operation',
    zhHint: '在门上运行一个只读操作，并记录返回的数据。',
    enHint: 'Runs a read-only operation on a gate and records what it returns.',
  },
  '<gate>.<op>': {
    zh: '门的读操作工具',
    en: 'Gate read tool',
    zhHint: '门的只读操作映射成的工具，调用时直接执行。',
    enHint: "A gate's read-only operation exposed as a tool; runs directly.",
  },
  '<gate>.<op>:execute': {
    zh: '门的写操作工具',
    en: 'Gate write tool',
    zhHint: '门的写操作映射成的工具，每次调用都转为动作请求。',
    enHint: "A gate's write operation exposed as a tool; each call becomes an action request.",
  },

  // -----------------------------------------------------------------------------------------
  // Capabilities — connection
  // -----------------------------------------------------------------------------------------
  request_connection: {
    zh: '申请接入系统',
    en: 'Request connection',
    zhHint: '提议接入一个新系统，由人来填写凭证。',
    enHint: 'Proposes connecting a new system; a person fills in the credentials.',
  },
  create_connection: {
    zh: '注册门',
    en: 'Register gate',
    zhHint: '用地址和凭证注册一个门，凭证直接交给门。',
    enHint: 'Registers a gate by address; credentials go straight to the gate.',
  },
  mint_connection_secret: {
    zh: '生成连接密钥',
    en: 'Mint connection secret',
    zhHint: '为即将接入的门生成连接密钥，只显示一次。',
    enHint: 'Mints a connection secret for a gate about to connect; shown once.',
  },
  rotate_connection_secret: {
    zh: '重新签发连接密钥',
    en: 'Rotate connection secret',
    zhHint: '为门签发新的连接密钥，旧密钥立即失效。',
    enHint: 'Issues a new connection secret; the old one stops working at once.',
  },
  publish_manifest: {
    zh: '发布接口清单',
    en: 'Publish manifest',
    zhHint: '发布门接口清单里的全部草稿操作。',
    enHint: "Publishes every draft operation in a gate's manifest.",
  },
  connect_gatekeeper: {
    zh: '授权使用门',
    en: 'Grant gate to agent',
    zhHint: '允许某个用户的入口 agent 使用一个已有的门。',
    enHint: "Lets a user's entry agent use an existing gate.",
  },
  list_connection_requests: {
    zh: '查看连接申请',
    en: 'List connection requests',
    zhHint: '列出连接申请，可按状态筛选。',
    enHint: 'Lists connection requests, optionally by status.',
  },
  cancel_connection_request: {
    zh: '取消连接申请',
    en: 'Cancel connection request',
    zhHint: '取消一条仍在等待处理的连接申请。',
    enHint: 'Cancels a connection request that is still pending.',
  },
  list_gatekeepers: {
    zh: '查看门列表',
    en: 'List gates',
    zhHint: '列出本工作区注册的所有门。',
    enHint: 'Lists every gate registered in this workspace.',
  },
  issue_service_handle: {
    zh: '签发外部运行时凭证',
    en: 'Issue service Handle',
    zhHint: '为服务主体签发长期有效的 Handle 凭证。',
    enHint: 'Issues a long-lived Handle for a service principal.',
  },
  list_available_gate_instances: {
    zh: '查看可启用门实例',
    en: 'List available gate instances',
    zhHint: '列出平台预置、本工作区可以启用的门实例。',
    enHint: 'Lists the platform gate instances this workspace can enable.',
  },
  enable_gate_instance: {
    zh: '启用门实例',
    en: 'Enable gate instance',
    zhHint: '在本工作区启用平台门实例，并发布它的操作。',
    enHint: 'Enables a platform gate instance here and publishes its operations.',
  },
  preview_gate_instance_enable: {
    zh: '预览启用门实例',
    en: 'Preview gate enable',
    zhHint: '只读预览：启用这个门实例会做什么。',
    enHint: 'Read-only preview of what enabling a gate instance would do.',
  },
  refresh_operation_governance: {
    zh: '同步操作治理设置',
    en: 'Sync operation governance',
    zhHint: '按门当前的公告更新已部署操作的模式与影响面。',
    enHint: "Updates deployed operations' mode and blast radius to the gate's announcement.",
  },
  issue_gate_credential_token: {
    zh: '签发凭证录入令牌',
    en: 'Issue credential token',
    zhHint: '签发5分钟令牌，让浏览器把你的凭证直接交给门宿主。',
    enHint: 'A 5-minute token to post your own credential straight to the gate host.',
  },
  get_gatekeeper: {
    zh: '查看门详情',
    en: 'Read gate',
    zhHint: '读取一个门及其操作和健康状态。',
    enHint: 'Reads one gate with its operations and live health.',
  },
  list_operations: {
    zh: '查看操作目录',
    en: 'List operations',
    zhHint: '跨门列出操作，可按门或名称筛选。',
    enHint: 'Lists operations across gates, filterable by gate or name.',
  },
  get_operation_stats: {
    zh: '查看操作统计',
    en: 'Operation stats',
    zhHint: '统计近期每个操作的调用、批准与拒绝次数。',
    enHint: 'Counts recent calls, approvals and rejections per operation.',
  },

  // -----------------------------------------------------------------------------------------
  // Capabilities — meta (operations, skills, procedures, facts)
  // -----------------------------------------------------------------------------------------
  propose_operation: {
    zh: '提议新操作',
    en: 'Propose operation',
    zhHint: '探索门之后，起草一个私有的操作草稿。',
    enHint: 'Drafts a private operation after exploring a gate.',
  },
  publish_operation: {
    zh: '发布操作',
    en: 'Publish operation',
    zhHint: '发布一个操作草稿，使它可以被调用。',
    enHint: 'Publishes an operation draft so it can be called.',
  },
  deprecate_operation: {
    zh: '弃用操作',
    en: 'Deprecate operation',
    zhHint: '弃用一个已发布的操作。',
    enHint: 'Deprecates a published operation.',
  },
  update_operation_description: {
    zh: '修改操作说明',
    en: 'Edit operation description',
    zhHint: '直接修改操作的说明文字，不改治理字段。',
    enHint: "Edits an operation's description in place; governance is unchanged.",
  },
  propose_skill: {
    zh: '提议 Skill 草稿',
    en: 'Propose skill',
    zhHint: '起草私有 Skill，多在 Worker 运行成功后。',
    enHint: 'Drafts a private skill, usually after a successful Worker run.',
  },
  propose_procedure: {
    zh: '提议流程',
    en: 'Propose procedure',
    zhHint: '从一次成功的任务里提炼出流程草稿。',
    enHint: 'Distills a procedure draft from a successful task.',
  },
  publish_skill: {
    zh: '发布 Skill 草稿',
    en: 'Publish skill',
    zhHint: '发布你的 Skill 草稿；所有者可发布任何人的草稿。',
    enHint: "Publishes your skill draft; the owner may publish anyone's.",
  },
  publish_procedure: {
    zh: '发布流程',
    en: 'Publish procedure',
    zhHint: '发布你的流程草稿；所有者可发布任何人的草稿。',
    enHint: "Publishes your procedure draft; the owner may publish anyone's.",
  },
  deprecate_skill: {
    zh: '弃用 Skill 版本',
    en: 'Deprecate skill',
    zhHint: '弃用一个已发布的 Skill 版本。',
    enHint: 'Deprecates a published skill.',
  },
  deprecate_procedure: {
    zh: '弃用流程',
    en: 'Deprecate procedure',
    zhHint: '弃用一个已发布的流程。',
    enHint: 'Deprecates a published procedure.',
  },
  list_skills: {
    zh: '查看 Skill 列表',
    en: 'List skills',
    zhHint: '列出已发布的 Skill 和你可见的草稿。',
    enHint: 'Lists published skills and the drafts you can see.',
  },
  get_skill: {
    zh: '读取 Skill 内容',
    en: 'Read skill',
    zhHint: '读取一个 Skill 最新版本的完整正文。',
    enHint: "Reads a skill's latest version in full.",
  },
  list_procedures: {
    zh: '查看流程列表',
    en: 'List procedures',
    zhHint: '列出已发布的流程和你可见的草稿。',
    enHint: 'Lists published procedures and the drafts you can see.',
  },
  assert_fact: {
    zh: '断言事实',
    en: 'Assert fact',
    zhHint: '写入一条事实，须符合工作区的本体。',
    enHint: 'Writes a fact; it must fit the workspace ontology.',
  },
  supersede_fact: {
    zh: '取代事实',
    en: 'Supersede fact',
    zhHint: '用同一来源的新值取代一条事实。',
    enHint: 'Replaces a fact with a newer value from the same source.',
  },
  invalidate_fact: {
    zh: '作废事实',
    en: 'Invalidate fact',
    zhHint: '把一条事实标记为失效。',
    enHint: 'Marks a fact as no longer valid.',
  },

  // -----------------------------------------------------------------------------------------
  // Capabilities — epistemic (provenance, decisions, conflicts)
  // -----------------------------------------------------------------------------------------
  explain: {
    zh: '追溯来源',
    en: 'Explain origin',
    zhHint: '说明一条事实、决策或活动从何而来。',
    enHint: 'Shows where a fact, decision or activity came from.',
  },
  record_decision: {
    zh: '记录决策',
    en: 'Record decision',
    zhHint: '记录一项决策及其依据的事实。',
    enHint: 'Records a decision and the facts it rests on.',
  },
  query_decisions: {
    zh: '查询决策',
    en: 'Query decisions',
    zhHint: '按对象或时间查询已记录的决策。',
    enHint: 'Queries recorded decisions by object or time.',
  },
  find_precedents: {
    zh: '查找先例',
    en: 'Find precedents',
    zhHint: '查找同一对象或动作类型上的既往决策。',
    enHint: 'Finds earlier decisions on the same object or action type.',
  },
  causal_chain: {
    zh: '查看因果链',
    en: 'Causal chain',
    zhHint: '追溯导致一条事实或决策的来源链。',
    enHint: 'Traces the provenance chain behind a fact or decision.',
  },
  decision_impact: {
    zh: '查看决策影响',
    en: 'Decision impact',
    zhHint: '查看一项决策的下游影响。',
    enHint: "Shows a decision's downstream impact.",
  },
  list_conflicts: {
    zh: '查看冲突',
    en: 'List conflicts',
    zhHint: '列出你可见的事实冲突。',
    enHint: 'Lists the fact conflicts you can see.',
  },
  resolve_conflict: {
    zh: '解决冲突',
    en: 'Resolve conflict',
    zhHint: '保留其中一条事实，或把两条都作废。',
    enHint: 'Keeps one of the facts, or invalidates both.',
  },
  verify_fact: {
    zh: '验证事实',
    en: 'Verify fact',
    zhHint: '凭证据把一条事实标为已验证。',
    enHint: 'Marks a fact verified, backed by evidence.',
  },
  attest_fact: {
    zh: '人工确认事实',
    en: 'Attest fact',
    zhHint: '以你本人的名义为事实附上人工确认。',
    enHint: 'Attaches your own human confirmation to a fact.',
  },

  // -----------------------------------------------------------------------------------------
  // Capabilities — governance (approval, grants, policy, quotas)
  // -----------------------------------------------------------------------------------------
  request_action: {
    zh: '发起动作请求',
    en: 'Request action',
    zhHint: 'Worker 在门上执行写操作的唯一入口，生成动作请求。',
    enHint: "A Worker's only way to act on a gate; creates an action request.",
  },
  approve: {
    zh: '批准动作请求',
    en: 'Approve action',
    zhHint: '批准待审批的动作请求；高影响须写理由。',
    enHint: 'Approves a pending action request; high impact needs a reason.',
  },
  reject: {
    zh: '拒绝动作请求',
    en: 'Reject action',
    zhHint: '拒绝待审批的动作请求，可附理由。',
    enHint: 'Rejects a pending action request, optionally with a reason.',
  },
  list_pending: {
    zh: '查看待我审批',
    en: 'Pending approvals',
    zhHint: '列出等待你审批的动作请求。',
    enHint: 'Lists the action requests awaiting your approval.',
  },
  get_action: {
    zh: '查看动作请求',
    en: 'Read action request',
    zhHint: '读取一条你可见的动作请求。',
    enHint: 'Reads one action request you can see.',
  },
  list_action_requests: {
    zh: '查看审批历史',
    en: 'Approval history',
    zhHint: '列出各状态的动作请求，可按门或任务筛选。',
    enHint: 'Lists action requests in any status, filterable by gate or task.',
  },
  set_auto_approved_action_kind: {
    zh: '设为总是允许',
    en: 'Always allow',
    zhHint: '此后自动批准这个门上的这一操作。',
    enHint: 'Auto-approves this operation on this gate from now on.',
  },
  grant_capability: {
    zh: '授予门的使用权',
    en: 'Grant gate access',
    zhHint: '授权某个主体使用一个门。',
    enHint: 'Grants a principal access to one gate.',
  },
  revoke_capability: {
    zh: '撤销授权',
    en: 'Revoke grant',
    zhHint: '撤销一条能力授权。',
    enHint: 'Revokes a capability grant.',
  },
  set_policy: {
    zh: '设置审批策略',
    en: 'Set approval policy',
    zhHint: '写入一条策略规则：哪些动作自动批准。',
    enHint: 'Writes a policy rule on which actions auto-approve.',
  },
  set_quota: {
    zh: '设置配额',
    en: 'Set quota',
    zhHint: '设置委派深度、并发、用量或每日成本上限。',
    enHint: 'Sets delegation depth, concurrency, usage or daily cost limits.',
  },
  issue_handle: {
    zh: '签发会话凭证',
    en: 'Issue session Handle',
    zhHint: '为外部交互式客户端签发受限的 Handle 凭证。',
    enHint: 'Issues a scoped Handle for an external interactive client.',
  },
  list_grants: {
    zh: '查看授权',
    en: 'List grants',
    zhHint: '列出能力授权，可按主体筛选。',
    enHint: 'Lists capability grants, optionally for one principal.',
  },
  list_policies: {
    zh: '查看审批策略',
    en: 'List policies',
    zhHint: '列出工作区的全部策略规则。',
    enHint: 'Lists every policy rule in the workspace.',
  },
  list_quotas: {
    zh: '查看配额',
    en: 'List quotas',
    zhHint: '列出工作区当前生效的配额。',
    enHint: "Lists the workspace's quotas in effect.",
  },
  list_capability_names: {
    zh: '查看能力名称',
    en: 'List capability names',
    zhHint: '列出 Worker 定义可以声明的能力名称。',
    enHint: 'Lists the capability names a Worker definition may declare.',
  },
  execution_readiness: {
    zh: '检查委派就绪',
    en: 'Check execution readiness',
    zhHint: '检查入口 agent 当前能否委派执行工作。',
    enHint: 'Checks whether the entry agent can delegate execution work now.',
  },

  // -----------------------------------------------------------------------------------------
  // Capabilities — task
  // -----------------------------------------------------------------------------------------
  get_entry_context: {
    zh: '读取当前情况',
    en: 'Read entry context',
    zhHint: '汇总待审批、任务进展和最近的事实。',
    enHint: 'Summarises pending approvals, task progress and recent facts.',
  },
  report_turn: {
    zh: '汇报本轮结果',
    en: 'Report turn',
    zhHint: '记录一轮对话的结果与决策。',
    enHint: "Records a finished turn's outcome and decisions.",
  },
  record_procedure_followed: {
    zh: '记录所循流程',
    en: 'Record procedure followed',
    zhHint: '记录这一轮正在遵循哪个已发布的流程。',
    enHint: 'Records which published procedure this turn follows.',
  },
  report_task_outcome: {
    zh: '汇报任务是否达成',
    en: 'Report task outcome',
    zhHint: '在流程的核验步骤报告委派的任务是否达成目标。',
    enHint: 'Reports whether a delegated task achieved its goal.',
  },
  invoke_worker: {
    zh: '委派 Worker 任务',
    en: 'Invoke Worker',
    zhHint: '按已发布的 Worker 定义创建任务并启动 Worker。',
    enHint: 'Creates a task from a published Worker definition and starts a Worker.',
  },
  get_task: {
    zh: '查看任务',
    en: 'Read task',
    zhHint: '读取一个任务及其 Worker 运行记录。',
    enHint: 'Reads one task and its Worker runs.',
  },
  list_allowed_operations: {
    zh: '查看可调用操作',
    en: 'List allowed operations',
    zhHint: '列出当前凭证范围内可以调用的门操作。',
    enHint: "Lists the gate operations within the calling Handle's scope.",
  },
  report_task_result: {
    zh: '提交任务结果',
    en: 'Submit task result',
    zhHint: 'Worker 提交结果契约，任务随之完成。',
    enHint: 'A Worker posts its result contract and completes the task.',
  },
  list_tasks: {
    zh: '查看我的任务',
    en: 'List my tasks',
    zhHint: '列出你自己的任务，最新的在前。',
    enHint: 'Lists your own tasks, newest first.',
  },
  cancel_task: {
    zh: '取消任务',
    en: 'Cancel task',
    zhHint: '请求取消一个正在运行的任务。',
    enHint: 'Requests cancellation of a running task.',
  },

  // -----------------------------------------------------------------------------------------
  // Capabilities — Worker definitions and drafts
  // -----------------------------------------------------------------------------------------
  propose_worker_definition: {
    zh: '提议 Worker 定义',
    en: 'Propose Worker definition',
    zhHint: '起草一个 Worker 定义的私有草稿版本。',
    enHint: 'Drafts a private Worker definition version.',
  },
  publish_worker_definition: {
    zh: '发布 Worker 定义',
    en: 'Publish Worker definition',
    zhHint: '发布 Worker 定义草稿，发布后不可再改。',
    enHint: 'Publishes a Worker definition draft; it is immutable afterwards.',
  },
  deprecate_worker_definition: {
    zh: '弃用 Worker 定义',
    en: 'Deprecate Worker definition',
    zhHint: '弃用一个已发布的 Worker 定义版本。',
    enHint: 'Deprecates a published Worker definition version.',
  },
  discard_draft: {
    zh: '丢弃草稿',
    en: 'Discard draft',
    zhHint: '丢弃你自己的一份私有草稿，不可恢复。',
    enHint: 'Discards one of your own private drafts for good.',
  },
  list_worker_definitions: {
    zh: '查看 Worker 定义',
    en: 'List Worker definitions',
    zhHint: '列出已发布的 Worker 定义，可含你的草稿。',
    enHint: 'Lists published Worker definitions, optionally with your drafts.',
  },

  // -----------------------------------------------------------------------------------------
  // Capabilities — ingest
  // -----------------------------------------------------------------------------------------
  register_source: {
    zh: '登记来源',
    en: 'Register source',
    zhHint: '登记一个数据来源，如文档、数据库或接口。',
    enHint: 'Registers a data source such as a document, database or API.',
  },
  submit_observations: {
    zh: '提交观测数据',
    en: 'Submit observations',
    zhHint: '采集器批量提交一次观测，写入图谱。',
    enHint: 'A collector submits a batch of observations into the graph.',
  },

  // -----------------------------------------------------------------------------------------
  // Capabilities — audit
  // -----------------------------------------------------------------------------------------
  audit_query: {
    zh: '查询审计记录',
    en: 'Query audit log',
    zhHint: '按主体、动作或资源查询本工作区的审计。',
    enHint: "Queries this workspace's audit log by actor, action or resource.",
  },
  reconstruct: {
    zh: '重建变更历史',
    en: 'Reconstruct history',
    zhHint: '从审计记录重建某个实体的历史。',
    enHint: "Rebuilds an entity's history from the audit log.",
  },
  export_prov: {
    zh: '导出溯源图',
    en: 'Export provenance',
    zhHint: '导出以某个节点为根的溯源图。',
    enHint: 'Exports the provenance graph around one node.',
  },

  // -----------------------------------------------------------------------------------------
  // Capabilities — members
  // -----------------------------------------------------------------------------------------
  list_principals: {
    zh: '查看成员',
    en: 'List members',
    zhHint: '列出工作区里的全部主体。',
    enHint: 'Lists every principal in the workspace.',
  },
  create_principal: {
    zh: '创建服务主体',
    en: 'Create service principal',
    zhHint: '创建自动化用的服务主体及其 API 密钥。',
    enHint: 'Creates a service principal for automation, with its API key.',
  },
  add_member: {
    zh: '添加成员',
    en: 'Add member',
    zhHint: '按登录名把平台用户加入本工作区。',
    enHint: 'Adds a platform user to this workspace by login.',
  },
  set_principal_role: {
    zh: '修改成员角色',
    en: 'Change member role',
    zhHint: '修改成员或服务主体在本工作区的角色。',
    enHint: "Changes a member's or service principal's role here.",
  },
  rotate_api_key: {
    zh: '轮换 API 密钥',
    en: 'Rotate API key',
    zhHint: '为服务主体换新密钥，旧密钥立即失效。',
    enHint: "Rotates a service principal's key; the old one stops working at once.",
  },
  disable_principal: {
    zh: '停用成员',
    en: 'Disable member',
    zhHint: '停用主体，它的密钥和凭证立即失效。',
    enHint: 'Disables a principal; its key and Handles stop working at once.',
  },
  get_workspace: {
    zh: '查看工作区信息',
    en: 'Read workspace',
    zhHint: '读取当前工作区的标识、统计和你的角色。',
    enHint: "Reads the workspace's identity, counts and your role.",
  },
  resolve_refs: {
    zh: '解析引用名称',
    en: 'Resolve references',
    zhHint: '把一批 id 解析成可读的名称。',
    enHint: 'Resolves a batch of ids to readable names.',
  },
  list_models: {
    zh: '查看模型清单',
    en: 'List models',
    zhHint: '列出可以使用的模型白名单。',
    enHint: 'Lists the models on the allow-list.',
  },

  // -----------------------------------------------------------------------------------------
  // Capabilities — agent profile and policy
  // -----------------------------------------------------------------------------------------
  get_agent_profile: {
    zh: '查看智能体设置',
    en: 'Read agent profile',
    zhHint: '读取成员的智能体设置及实际生效的值。',
    enHint: "Reads a member's agent profile and its effective values.",
  },
  set_agent_profile: {
    zh: '修改智能体设置',
    en: 'Update agent profile',
    zhHint: '调整成员的智能体设置，只能收窄不能放宽。',
    enHint: "Updates a member's agent profile; it can only narrow access.",
  },
  get_agent_policy: {
    zh: '查看工作区策略',
    en: 'Read agent policy',
    zhHint: '读取工作区对所有智能体的统一策略。',
    enHint: "Reads the workspace's policy for every agent.",
  },
  set_agent_policy: {
    zh: '修改工作区策略',
    en: 'Update agent policy',
    zhHint: '修改工作区的智能体策略，仅所有者可改。',
    enHint: "Updates the workspace's agent policy; owner only.",
  },

  // -----------------------------------------------------------------------------------------
  // Capabilities — platform (administrator)
  // -----------------------------------------------------------------------------------------
  platform_overview: {
    zh: '查看平台概览',
    en: 'Platform overview',
    zhHint: '一次读取平台版本、规模、健康与待办。',
    enHint: "Reads the platform's version, size, health and backlog at once.",
  },
  list_users: {
    zh: '查看用户',
    en: 'List users',
    zhHint: '列出平台用户及其所属工作区。',
    enHint: 'Lists platform users and their memberships.',
  },
  create_user: {
    zh: '创建用户',
    en: 'Create user',
    zhHint: '创建平台用户，并给出一次性的临时密码。',
    enHint: 'Creates a platform user with a one-time temporary password.',
  },
  update_user: {
    zh: '修改用户',
    en: 'Update user',
    zhHint: '修改用户的显示名或平台角色。',
    enHint: "Changes a user's display name or platform role.",
  },
  set_user_status: {
    zh: '停用或启用用户',
    en: 'Disable or enable user',
    zhHint: '停用会立即吊销该用户的全部会话与凭证。',
    enHint: "Disabling revokes all of the user's sessions and credentials at once.",
  },
  reset_user_password: {
    zh: '重置用户密码',
    en: 'Reset user password',
    zhHint: '设置临时密码，并吊销该用户的全部凭证。',
    enHint: "Sets a temporary password and revokes all of the user's credentials.",
  },
  list_user_memberships: {
    zh: '查看用户所属工作区',
    en: 'List user memberships',
    zhHint: '列出一个用户在各工作区的成员身份。',
    enHint: "Lists one user's memberships across workspaces.",
  },
  add_membership: {
    zh: '把用户加入工作区',
    en: 'Add to workspace',
    zhHint: '以指定角色把用户加入一个工作区。',
    enHint: 'Adds a user to a workspace with a role.',
  },
  set_membership_role: {
    zh: '修改工作区角色',
    en: 'Change workspace role',
    zhHint: '修改用户在某个工作区的角色，立即生效。',
    enHint: "Changes a user's role in one workspace, effective at once.",
  },
  remove_membership: {
    zh: '移出工作区',
    en: 'Remove from workspace',
    zhHint: '把用户移出工作区，并吊销其会话与凭证。',
    enHint: 'Removes a user from a workspace and revokes their sessions.',
  },
  merge_user: {
    zh: '合并用户',
    en: 'Merge users',
    zhHint: '把待激活的用户并入一个已有账号。',
    enHint: 'Folds a user awaiting activation into an existing account.',
  },
  set_user_budget: {
    zh: '设置用户额度',
    en: 'Set user budget',
    zhHint: '设置用户每日调用次数与每月用量预算。',
    enHint: "Sets a user's daily call limit and monthly token budget.",
  },
  get_platform_settings: {
    zh: '查看平台设置',
    en: 'Read platform settings',
    zhHint: '读取平台设置。',
    enHint: 'Reads the platform settings.',
  },
  update_platform_settings: {
    zh: '修改平台设置',
    en: 'Update platform settings',
    zhHint: '部分更新平台设置，旧版本保留可回滚。',
    enHint: 'Partially updates platform settings; the previous version is kept.',
  },
  set_platform_default_model: {
    zh: '设置默认模型',
    en: 'Set default model',
    zhHint: '设置新建工作区默认使用的入口模型。',
    enHint: 'Sets the entry model new workspaces use by default.',
  },
  platform_audit_query: {
    zh: '查询平台审计',
    en: 'Query platform audit',
    zhHint: '查询平台层面的变更记录，最新的在前。',
    enHint: 'Queries who changed what on the platform, newest first.',
  },
  list_workspaces: {
    zh: '查看工作区',
    en: 'List workspaces',
    zhHint: '列出全部工作区及其状态、模型与所有者。',
    enHint: 'Lists every workspace with its status, models and owners.',
  },
  list_platform_models: {
    zh: '列出平台模型',
    en: 'List platform models',
    zhHint: '读取模型代理的模型目录，供管理员配置。',
    enHint: "Reads the model proxy's catalog for administrators.",
  },
  create_workspace: {
    zh: '创建工作区',
    en: 'Create workspace',
    zhHint: '新建一个隔离的工作区，并指定首个所有者。',
    enHint: 'Creates an isolated workspace with its first owner.',
  },
  update_workspace: {
    zh: '修改工作区',
    en: 'Update workspace',
    zhHint: '修改工作区的名称、入口模型或本体强制方式。',
    enHint: "Changes a workspace's name, entry model or ontology enforcement.",
  },
  set_workspace_status: {
    zh: '停用或启用工作区',
    en: 'Disable or enable workspace',
    zhHint: '停用会吊销其中全部会话，并对登录隐藏。',
    enHint: 'Disabling revokes every session in it and hides it from login.',
  },
  set_allowed_models: {
    zh: '设置可选模型',
    en: 'Set allowed models',
    zhHint: '设置工作区成员可以选择的模型。',
    enHint: "Sets the models a workspace's members may pick.",
  },
  purge_workspace: {
    zh: '彻底清除工作区',
    en: 'Purge workspace',
    zhHint: '删除已停用工作区的全部数据，不可恢复。',
    enHint: "Deletes all of a disabled workspace's data; cannot be undone.",
  },
  purge_user: {
    zh: '清除待激活用户',
    en: 'Purge pending users',
    zhHint: '删除已经没有任何成员身份的待激活用户。',
    enHint: 'Deletes users awaiting activation that hold no membership.',
  },
  list_connectors: {
    zh: '查看接入包',
    en: 'List connectors',
    zhHint: '列出接入包目录及各自的模式。',
    enHint: 'Lists the connector catalog and each mode.',
  },
  set_connector_mode: {
    zh: '设置接入包模式',
    en: 'Set connector mode',
    zhHint: '设置接入包的模式，以及禁止运行的操作。',
    enHint: "Sets a connector's mode and the operations it may never run.",
  },
  list_gate_instances: {
    zh: '查看门实例',
    en: 'List gate instances',
    zhHint: '列出已公告的门实例及其状态。',
    enHint: 'Lists the announced gate instances and their status.',
  },
  get_gate_instance: {
    zh: '查看门实例详情',
    en: 'Read gate instance',
    zhHint: '读取一个门实例及其公告的操作。',
    enHint: 'Reads one gate instance with its announced operations.',
  },
  update_gate_instance: {
    zh: '修改门实例',
    en: 'Update gate instance',
    zhHint: '为门实例改名、启用或停用，或标记为已审核。',
    enHint: 'Renames, enables or disables a gate instance, or marks it vetted.',
  },
  confirm_gate_manifest: {
    zh: '确认门清单',
    en: 'Confirm gate manifest',
    zhHint: '采用门实例待确认的新清单作为生效清单。',
    enHint: "Adopts a gate instance's pending manifest as the one in effect.",
  },
  create_gate_instance: {
    zh: '新建门宿主实例',
    en: 'Create gate instance',
    zhHint: '新建一个由门宿主托管的通用门实例。',
    enHint: 'Creates a generic gate instance served by the gate host.',
  },
  delete_gate_instance: {
    zh: '删除门实例',
    en: 'Delete gate instance',
    zhHint: '删除没有工作区启用的门宿主实例。',
    enHint: 'Removes a gate-host instance no workspace has enabled.',
  },
  issue_gate_host_token: {
    zh: '签发共享凭证令牌',
    en: 'Issue gate host token',
    zhHint: '签发5分钟令牌，用于向门宿主录入共享凭证。',
    enHint: 'A 5-minute token to post a shared credential to the gate host.',
  },
  test_gate_instance: {
    zh: '测试门实例',
    en: 'Test gate instance',
    zhHint: '探测门实例的健康状态并刷新操作描述。',
    enHint: "Probes a gate instance's health and asks for its operations.",
  },
  list_external_runtimes: {
    zh: '查看外部运行时',
    en: 'List external runtimes',
    zhHint: '列出各工作区里外部运行时的会话。',
    enHint: 'Lists external runtime sessions across workspaces.',
  },
  revoke_external_runtime: {
    zh: '吊销外部运行时',
    en: 'Revoke external runtime',
    zhHint: '立即吊销一个外部运行时的会话及其凭证。',
    enHint: "Revokes an external runtime's session and its Handles at once.",
  },
  issue_llm_admin_token: {
    zh: '签发模型管理令牌',
    en: 'Issue LLM admin token',
    zhHint: '签发5分钟令牌，用于管理模型供应商。',
    enHint: 'A 5-minute token for managing model providers.',
  },
  platform_draft_residue: {
    zh: '查看草稿残留',
    en: 'Draft residue',
    zhHint: '按类型统计各工作区的草稿数量。',
    enHint: 'Counts drafts across workspaces by kind.',
  },
  runtime_inventory: {
    zh: '查看运行时清单',
    en: 'Runtime inventory',
    zhHint: '列出活动镜像和各工作区的入口容器。',
    enHint: 'Lists the active image and every resident entry container.',
  },
  list_runtime_images: {
    zh: '查看运行时镜像',
    en: 'List runtime images',
    zhHint: '列出平台可用的运行时镜像。',
    enHint: 'Lists the runtime images the platform knows about.',
  },
  set_active_runtime_image: {
    zh: '切换活动镜像',
    en: 'Set active image',
    zhHint: '设定活动运行时镜像，容器下次启动时生效。',
    enHint: 'Sets the active runtime image; containers pick it up on next start.',
  },
  rollback_runtime_image: {
    zh: '回滚运行时镜像',
    en: 'Roll back runtime image',
    zhHint: '把活动镜像切回上一个不同的版本。',
    enHint: 'Switches the active image back to the previous different one.',
  },
  roll_entry_containers: {
    zh: '重建入口容器',
    en: 'Roll entry containers',
    zhHint: '停止需要重建且空闲的入口容器。',
    enHint: 'Stops idle entry containers that need a rebuild.',
  },
  pi_drift: {
    zh: '检查 pi 版本偏差',
    en: 'Check pi drift',
    zhHint: '比较预期的 pi 版本与活动镜像里的版本。',
    enHint: 'Compares the expected pi version with the active image.',
  },
  platform_updates: {
    zh: '检查平台更新',
    en: 'Check for updates',
    zhHint: '查看比当前部署更新的平台版本与升级步骤。',
    enHint: 'Shows newer platform releases and how to upgrade.',
  },
  platform_status: {
    zh: '查看服务状态',
    en: 'Service status',
    zhHint: '查看各服务健康，以及近30天模型用量。',
    enHint: 'Shows service health and 30-day model usage.',
  },
  list_modules: {
    zh: '查看模块',
    en: 'List modules',
    zhHint: '列出本部署附带的模块及安装情况。',
    enHint: 'Lists the modules this deployment ships and where they are installed.',
  },
  set_default_modules: {
    zh: '设置默认模块',
    en: 'Set default modules',
    zhHint: '设置新建工作区默认安装的模块。',
    enHint: 'Sets the modules every new workspace installs.',
  },

  // -----------------------------------------------------------------------------------------
  // Capabilities — workspace modules
  // -----------------------------------------------------------------------------------------
  list_workspace_modules: {
    zh: '查看工作区模块',
    en: 'List workspace modules',
    zhHint: '列出模块及其在本工作区的安装状态。',
    enHint: "Lists the modules and this workspace's install state.",
  },
  install_module: {
    zh: '安装模块',
    en: 'Install module',
    zhHint: '把模块的最新版本安装到本工作区。',
    enHint: "Installs a module's latest version into this workspace.",
  },
  upgrade_module: {
    zh: '升级模块',
    en: 'Upgrade module',
    zhHint: '把已安装的模块直接升到最新版本。',
    enHint: 'Advances an installed module straight to its latest version.',
  },

  // -----------------------------------------------------------------------------------------
  // Lifecycle audit events (`lib/audit.ts` AUDIT_LIFECYCLE_ACTIONS) — read as events
  // -----------------------------------------------------------------------------------------
  'action_request.request': {
    zh: '动作请求已提交',
    en: 'Action requested',
    zhHint: '发起了一条待审批的动作请求。',
    enHint: 'An action request was filed for approval.',
  },
  'action_request.approve': {
    zh: '动作请求已批准',
    en: 'Action approved',
    zhHint: '动作请求获得批准，等待执行。',
    enHint: 'The action request was approved and awaits execution.',
  },
  'action_request.reject': {
    zh: '动作请求已拒绝',
    en: 'Action rejected',
    zhHint: '动作请求被拒绝，不会执行。',
    enHint: 'The action request was rejected and will not run.',
  },
  'action_request.start_execution': {
    zh: '动作开始执行',
    en: 'Execution started',
    zhHint: '已批准的动作开始在门上执行。',
    enHint: 'The approved action started running on the gate.',
  },
  'action_request.complete': {
    zh: '动作执行完成',
    en: 'Action completed',
    zhHint: '动作在门上执行成功。',
    enHint: 'The action ran successfully on the gate.',
  },
  'action_request.fail': {
    zh: '动作执行失败',
    en: 'Action failed',
    zhHint: '动作在门上执行失败。',
    enHint: 'The action failed on the gate.',
  },
  'action_request.compensate': {
    zh: '动作已补偿',
    en: 'Action compensated',
    zhHint: '对已执行的动作做了补偿处理。',
    enHint: 'A compensating step was applied to the executed action.',
  },
  'action_request.expire': {
    zh: '动作请求已过期',
    en: 'Action expired',
    zhHint: '动作请求没有在时限内处理，已过期。',
    enHint: 'The action request was not decided in time and expired.',
  },
  'task.queue': {
    zh: '任务已排队',
    en: 'Task queued',
    zhHint: '任务已创建，等待开始。',
    enHint: 'The task was created and is waiting to start.',
  },
  'task.start': {
    zh: '任务开始运行',
    en: 'Task started',
    zhHint: '任务开始运行。',
    enHint: 'The task started running.',
  },
  'task.await_approval': {
    zh: '任务等待审批',
    en: 'Task awaiting approval',
    zhHint: '任务暂停，等待一条动作请求被审批。',
    enHint: 'The task paused until an action request is decided.',
  },
  'task.resume': {
    zh: '任务已恢复',
    en: 'Task resumed',
    zhHint: '审批有了结果，任务继续运行。',
    enHint: 'The approval was decided and the task resumed.',
  },
  'task.complete': {
    zh: '任务已完成',
    en: 'Task completed',
    zhHint: '任务运行结束并提交了结果。',
    enHint: 'The task finished and posted its result.',
  },
  'task.fail': {
    zh: '任务失败',
    en: 'Task failed',
    zhHint: '任务运行失败。',
    enHint: 'The task failed.',
  },
  'task.cancel': {
    zh: '任务已取消',
    en: 'Task cancelled',
    zhHint: '任务被取消。',
    enHint: 'The task was cancelled.',
  },
  'task.result_fact_rejected': {
    zh: '结果中的事实被拒',
    en: 'Result fact rejected',
    zhHint: '任务结果里的一条事实没有通过校验，未写入。',
    enHint: "A fact in the task's result failed validation and was not written.",
  },
  'task.result_proposal_rejected': {
    zh: '结果中的操作提议被拒',
    en: 'Result proposal rejected',
    zhHint: '任务结果里提议的操作没有被接受。',
    enHint: "An operation proposed in the task's result was not accepted.",
  },
  'worker_run.provision': {
    zh: 'Worker 准备启动',
    en: 'Worker provisioning',
    zhHint: '为任务创建了 Worker 运行，正在准备容器。',
    enHint: 'A Worker run was created for the task; its container is being prepared.',
  },
  'worker_run.start': {
    zh: 'Worker 已启动',
    en: 'Worker started',
    zhHint: 'Worker 容器已启动，开始工作。',
    enHint: "The Worker's container started.",
  },
  'worker_run.terminate': {
    zh: 'Worker 已终止',
    en: 'Worker terminated',
    zhHint: 'Worker 运行结束，容器已停止。',
    enHint: 'The Worker run ended and its container stopped.',
  },
  'worker_run.spawn_failed': {
    zh: 'Worker 启动失败',
    en: 'Worker failed to start',
    zhHint: 'Worker 容器没能启动。',
    enHint: "The Worker's container failed to start.",
  },
  'chat.archive': {
    zh: '对话已归档',
    en: 'Chat archived',
    zhHint: '对话被归档，默认列表里不再显示。',
    enHint: 'The chat was archived and left the default list.',
  },
  'chat.unarchive': {
    zh: '对话已恢复',
    en: 'Chat restored',
    zhHint: '已归档的对话被恢复到列表。',
    enHint: 'The archived chat was restored to the list.',
  },
  'chat.rename': {
    zh: '对话已改名',
    en: 'Chat renamed',
    zhHint: '对话标题被修改。',
    enHint: "The chat's title was changed.",
  },
  'connection.request_cancelled': {
    zh: '连接申请已取消',
    en: 'Connection request cancelled',
    zhHint: '一条待处理的连接申请被取消。',
    enHint: 'A pending connection request was cancelled.',
  },
  facts_not_reobserved: {
    zh: '未再观测的事实已作废',
    en: 'Unobserved facts retired',
    zhHint: '采集器本次没有再看到的事实被自动作废。',
    enHint: 'Facts the collector no longer saw were invalidated automatically.',
  },
  ontology_violation: {
    zh: '写入不符合本体',
    en: 'Ontology violation',
    zhHint: '写入的关系不符合本体约束，被拒绝或告警。',
    enHint: 'A link write did not fit the ontology; it was refused or flagged.',
  },

  // -----------------------------------------------------------------------------------------
  // Other workspace audit events (kernel handlers and migrations, not capability names)
  // -----------------------------------------------------------------------------------------
  'operation.description_updated': {
    zh: '操作说明已更新',
    en: 'Operation description updated',
    zhHint: '一个操作的说明文字被修改。',
    enHint: "An operation's description was edited.",
  },
  'operation.governance_refreshed': {
    zh: '操作治理设置已同步',
    en: 'Operation governance synced',
    zhHint: '操作的模式与影响面已按门的公告更新。',
    enHint: "An operation's mode and blast radius were aligned to the gate.",
  },
  'draft.expired': {
    zh: '过期草稿已清理',
    en: 'Stale draft removed',
    zhHint: '长期没有发布的草稿被定期清理删除。',
    enHint: 'A draft left unpublished too long was swept away.',
  },
  'agent_profile.lists_reset_to_follow_grants': {
    zh: '智能体清单已重置',
    en: 'Agent lists reset',
    zhHint: '升级时，智能体的启用清单改为跟随授权。',
    enHint: "An upgrade reset the agent's lists to follow its grants.",
  },
  'policy.auto_approve_rescoped': {
    zh: '自动批准规则已调整',
    en: 'Auto-approval rescoped',
    zhHint: '升级时调整了一条自动批准规则的适用范围。',
    enHint: "An upgrade changed an auto-approval rule's scope.",
  },
  'agent_policy.auto_approve_low_default_applied': {
    zh: '低影响自动批准已开启',
    en: 'Low-impact auto-approval on',
    zhHint: '升级时按新默认值开启了低影响动作的自动批准。',
    enHint: 'An upgrade turned on low-impact auto-approval by the new default.',
  },
  'principal.auditor_handles_revoked': {
    zh: '审计员凭证已吊销',
    en: 'Auditor Handles revoked',
    zhHint: '升级时吊销了审计员的旧凭证，下一轮重新签发。',
    enHint: "An upgrade revoked an auditor's old Handles; new ones come next turn.",
  },
  'principal.container_handles_revoked': {
    zh: '容器旧凭证已吊销',
    en: 'Container Handles revoked',
    zhHint: '升级时吊销了放在容器环境变量里的旧凭证。',
    enHint: "An upgrade revoked old Handles kept in a container's environment.",
  },

  // -----------------------------------------------------------------------------------------
  // Platform audit events (`workspace_id` null, not capability names)
  // -----------------------------------------------------------------------------------------
  'workspace.created': {
    zh: '工作区已创建',
    en: 'Workspace created',
    zhHint: '记录新工作区及其默认安装的模块。',
    enHint: 'Records a new workspace and the modules it installs by default.',
  },
  'user.identity_claimed': {
    zh: '账号已认领',
    en: 'Account claimed',
    zhHint: '一个 API 密钥身份被认领为平台登录账号。',
    enHint: 'An API-key identity was claimed as a platform login.',
  },
  'principal.user_rebound': {
    zh: '成员身份已转移',
    en: 'Membership moved',
    zhHint: '一个工作区成员身份被转到另一个用户账号。',
    enHint: 'A workspace membership moved to another user account.',
  },
  'connector.entry_handles_revoked': {
    zh: '入口凭证已吊销',
    en: 'Entry Handles revoked',
    zhHint: '接入包变更后，相关工作区的入口凭证被吊销。',
    enHint: "A connector change revoked the affected workspaces' entry Handles.",
  },
  'gate_instance.manifest_confirmed': {
    zh: '门清单已确认',
    en: 'Gate manifest confirmed',
    zhHint: '门实例待确认的新清单已生效。',
    enHint: "A gate instance's pending manifest took effect.",
  },
  'platform.llm_admin_token_issued': {
    zh: '模型管理令牌已签发',
    en: 'LLM admin token issued',
    zhHint: '为管理员签发了5分钟的模型管理令牌。',
    enHint: 'A 5-minute model administration token was issued.',
  },
  'platform.llm_provider_created': {
    zh: '模型供应商已添加',
    en: 'Model provider added',
    zhHint: '在模型代理里添加了一个供应商。',
    enHint: 'A provider was added to the model proxy.',
  },
  'platform.llm_provider_updated': {
    zh: '模型供应商已修改',
    en: 'Model provider updated',
    zhHint: '修改了一个模型供应商的配置。',
    enHint: "A model provider's settings were changed.",
  },
  'platform.llm_provider_deleted': {
    zh: '模型供应商已删除',
    en: 'Model provider deleted',
    zhHint: '从模型代理里删除了一个供应商。',
    enHint: 'A provider was removed from the model proxy.',
  },
  'platform.llm_provider_tested': {
    zh: '模型供应商已测试',
    en: 'Model provider tested',
    zhHint: '测试了一个模型供应商的连通性。',
    enHint: 'A model provider was tested.',
  },
  'platform.llm_provider_secret_set': {
    zh: '供应商密钥已设置',
    en: 'Provider key set',
    zhHint: '在控制台为模型供应商设置了密钥。',
    enHint: 'A key was set for a model provider from the console.',
  },
  'platform.llm_provider_secret_cleared': {
    zh: '供应商密钥已清除',
    en: 'Provider key cleared',
    zhHint: '清除了控制台为模型供应商设置的密钥。',
    enHint: "A model provider's console-set key was cleared.",
  },
  'platform.llm_provider_models_listed': {
    zh: '已读取供应商模型',
    en: 'Provider models listed',
    zhHint: '读取了一个供应商提供的模型清单。',
    enHint: "A provider's model list was read.",
  },
  'platform.llm_provider_models_probed': {
    zh: '已探测供应商模型',
    en: 'Provider models probed',
    zhHint: '逐个探测了供应商的模型是否可用。',
    enHint: "A provider's models were probed for availability.",
  },
  'platform.user_purged': {
    zh: '待激活用户已清除',
    en: 'Pending user purged',
    zhHint: '一个没有成员身份的待激活用户被删除。',
    enHint: 'A user awaiting activation with no membership was deleted.',
  },
  'platform.workspace_purged': {
    zh: '工作区已彻底清除',
    en: 'Workspace purged',
    zhHint: '一个已停用工作区的全部数据被删除。',
    enHint: "All of a disabled workspace's data was deleted.",
  },
  'cli.observations_compacted': {
    zh: '观测数据已压缩',
    en: 'Observations compacted',
    zhHint: '主机命令行压缩了历史观测数据。',
    enHint: 'The host CLI compacted old observations.',
  },
  'cli.workspace_created': {
    zh: '命令行创建工作区',
    en: 'Workspace created via CLI',
    zhHint: '主机命令行创建了一个工作区。',
    enHint: 'The host CLI created a workspace.',
  },
  'cli.principal_added': {
    zh: '命令行添加主体',
    en: 'Principal added via CLI',
    zhHint: '主机命令行向工作区添加了一个主体。',
    enHint: 'The host CLI added a principal to a workspace.',
  },
  'cli.service_handle_issued': {
    zh: '命令行签发服务凭证',
    en: 'Service Handle issued via CLI',
    zhHint: '主机命令行为服务主体签发了凭证。',
    enHint: 'The host CLI issued a Handle for a service principal.',
  },
  'cli.platform_admin_created': {
    zh: '命令行创建管理员',
    en: 'Admin created via CLI',
    zhHint: '主机命令行创建了一个平台管理员。',
    enHint: 'The host CLI created a platform administrator.',
  },
  'cli.password_set': {
    zh: '命令行设置密码',
    en: 'Password set via CLI',
    zhHint: '主机命令行为一个用户设置了密码。',
    enHint: "The host CLI set a user's password.",
  },
};

/** Short label for a capability name or audit action, e.g. 列出平台模型 / List platform models.
 *  An unknown name comes back as itself. */
export function actionLabel(name: string, t: Translate): string {
  const copy = ownEntry(ACTION_COPY, name);
  return copy ? t(copy.zh, copy.en) : name;
}

/** One-line description of a capability name or audit action, or null when the table has none. */
export function actionHint(name: string, t: Translate): string | null {
  const copy = ownEntry(ACTION_COPY, name);
  return copy ? t(copy.zhHint, copy.enHint) : null;
}
