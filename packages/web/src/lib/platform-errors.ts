import { HttpError } from './http-client.js';
import type { Translate } from './i18n.js';
import { ownEntry } from './own.js';

/**
 * lib/platform-errors: the platform plane's stable wire codes → the bilingual one-liner the
 * console shows inline for them (P-A1; `application/gateway/platform-handlers.ts`'s
 * `PlatformAdminError` union is the source of truth for the code list, and
 * `interfaces/http/auth-routes.ts` reuses three of them on `POST /api/auth/bind-api-key`).
 *
 * Same shape `BindApiKeyForm` already established for its own three codes: a mapped code renders
 * as a `field-error` next to the control that caused it, anything unmapped falls through to
 * `ErrorBanner` (which always prints the kernel's own message plus the raw code, so an unmapped
 * failure is still diagnosable from a screenshot). Never a `switch` inside a page — the users
 * page alone can raise ten of these from six different forms.
 *
 * S8 W1-A10 (i18n remainder + audit S14): every entry is `{zh, en}` now (`platformErrorMessage`
 * takes `t` and picks one), and `protected_admin` no longer names the `NEXTTIME_PLATFORM_ADMINS`
 * env var inline — an ordinary admin cannot act on it either way, and the operator who set it
 * already knows the variable's name.
 */
const PLATFORM_ERROR_MESSAGES: Readonly<
  Record<string, { readonly zh: string; readonly en: string }>
> = {
  user_not_found: { zh: '找不到该用户', en: 'No such user' },
  workspace_not_found: { zh: '找不到该工作区', en: 'No such workspace' },
  membership_not_found: {
    zh: '该用户不在这个工作区',
    en: 'That user is not a member of this workspace',
  },
  login_taken: { zh: '这个登录名已被占用', en: 'That login is already taken' },
  already_member: { zh: '已经是该工作区的成员', en: 'Already a member of that workspace' },
  already_claimed: {
    zh: '该账户已设置密码，不能被合并',
    en: 'That account already has a password — it cannot be merged',
  },
  last_admin: {
    zh: '不能停用或降级最后一个活跃管理员',
    en: 'The last active administrator cannot be disabled or demoted',
  },
  // C10 (console-completion-plan §2b): the kernel split "you cannot disable yourself" out of
  // `last_admin` into its own code; until a kernel carrying that split is deployed the older
  // `last_admin` copy above still shows, with the kernel's own `message` as the secondary line
  // (`PlatformError.tsx`) so the two cases stay distinguishable either way.
  self_disable: { zh: '不能停用自己', en: 'You cannot disable your own account' },
  last_owner: {
    zh: '不能移出或降级工作区的最后一位有效的所有者',
    en: 'The last owner of a workspace cannot be removed or demoted',
  },
  protected_admin: {
    zh: '这是由主机环境配置指定的管理员，不能在控制台里改',
    en: 'This administrator is set by the host configuration — it cannot be changed here',
  },
  weak_password: {
    zh: '密码不满足平台的最短长度要求',
    en: 'Password is shorter than the platform minimum',
  },
  invalid_login: {
    zh: '登录名不合法：3–64 个字符，只能用小写字母、数字和 . _ -',
    en: 'Invalid login — 3–64 characters of a-z 0-9 . _ -, e.g. alice',
  },
  workspace_disabled: { zh: '该工作区已停用', en: 'That workspace is disabled' },
  // P-A2 (workspace configuration): the four codes the workspace capabilities add.
  user_disabled: {
    zh: '该用户已停用，不能作为所有者',
    en: 'That user is disabled and cannot be made an owner',
  },
  default_workspace: {
    zh: '默认工作区不能停用',
    en: 'The platform default workspace cannot be disabled — point the default at another workspace first',
  },
  unknown_model: { zh: '模型不在目录里', en: 'No such model in the catalog' },
  entry_model_not_allowed: {
    zh: '允许的模型列表必须包含入口模型；限制模型前要先设置入口模型',
    en: 'A non-empty allowed list must contain the entry model, and an entry model must be set before restricting',
  },
  // S6-A A1 (`purge_workspace`, console-completion-plan §5.2): the two 409s of the
  // preconditions. `default_workspace` (above) and `workspace_not_found` (top) are reused by it
  // verbatim.
  workspace_active: {
    zh: '该工作区仍在启用中，先停用（停用满 7 天后可清除）或等临时工作区到期',
    en: 'The workspace is still active — disable it first (purgeable 7 days later), or wait for an ephemeral one to expire',
  },
  retention_not_elapsed: {
    zh: '停用未满 7 天，还不能清除',
    en: 'Disabled less than 7 days ago — not purgeable yet',
  },
  // P-B1 (集成 Integrations): connectors, gate instances, external runtimes, and the workspace
  // "enable from platform catalog" flow.
  connector_not_found: { zh: '找不到该接入包', en: 'No such connector' },
  connector_mode_not_allowed: {
    zh: '通用类接入包（cli/ssh）不能设为平台预置',
    en: 'A generic cli/ssh connector cannot be set to platform preset',
  },
  gate_not_found: { zh: '找不到该门实例', en: 'No such gate instance' },
  trust_not_applicable: {
    zh: '只有 MCP 类型的实例可以设置信任级别',
    en: 'Only an MCP instance can be marked vetted',
  },
  runtime_not_found: { zh: '找不到该外部运行时会话', en: 'No such external runtime session' },
  gate_not_enabled: {
    zh: '该门实例尚未启用，工作区不能启用它',
    en: 'That gate instance is not enabled — a workspace cannot enable it',
  },
  connector_not_preset: {
    zh: '该接入包不是平台预置模式，工作区不能从目录启用它',
    en: 'That connector is not in platform-preset mode — a workspace cannot enable it from the catalog',
  },
  // P-B2a（门宿主 gate host）：管理员建实例、录入凭证的失败码。
  gate_id_taken: { zh: '这个 gate ID 已被占用', en: 'That gate id is already taken' },
  gate_in_use: {
    zh: '还有工作区启用着这个实例，先禁用它们再删除',
    en: 'A workspace still has this instance enabled — disable it there first',
  },
  gate_not_hosted: {
    zh: '只有门宿主实例才能这样操作；打包的门由它自己的容器管理',
    en: 'Only a gate-host instance supports this — a packaged gate manages itself',
  },
  credential_mode_mismatch: {
    zh: '该实例不需要每人的凭证',
    en: 'This instance does not take a per-member credential',
  },
  // P1：门宿主实例归到按系统命名的接入包。
  connector_kind_mismatch: {
    zh: '这个接入包是另一种类型的，不能放这个实例：换一个名字新建，或选同类型的接入包',
    en: 'That connector is of another kind and cannot hold this instance — name a new one, or pick one of the same kind',
  },
  connector_packaged: {
    zh: '这个接入包属于一个打包的门，不能放门宿主实例：换一个名字新建',
    en: 'That connector belongs to a packaged gate and cannot hold a gate-host instance — name a new one',
  },
  // S11 P1-F: `create_gate_instance` named a preset this platform version does not ship (the
  // console only offers what `list_connector_presets` lists — a stale tab after a downgrade).
  connector_preset_not_found: {
    zh: '这个平台版本没有这个接入预设，什么也没创建：刷新页面后重新选择',
    en: 'This platform version does not ship that connector preset — nothing was created; reload the page and choose again',
  },
  gate_not_ready: {
    zh: '门宿主尚未接管该实例，请稍候',
    en: 'The gate host has not taken over this instance yet — wait a moment',
  },
  gate_not_linked: {
    zh: '这个工作区还没有启用该实例',
    en: 'This workspace has not enabled that instance',
  },
  // S8 W2-U1 (audit J4): `preview_gate_instance_enable` blocks the confirm before this can fire in
  // the ordinary flow — kept as a defense-in-depth mapping for the race (another tab enables a
  // second matching Gatekeeper between the preview and the confirm).
  ambiguous_existing_gatekeeper: {
    zh: '工作区里有不止一个门与该实例端点相同，无法确定关联哪一个；先在已注册系统里合并或清理重复的注册',
    en: 'More than one Gatekeeper in this workspace shares that endpoint — merge or clean up the duplicates in Registered systems first',
  },
  // L4-13 (S10 K4): the existing Gatekeeper at this endpoint is already linked to another gate
  // instance (the same endpoint redeployed under a new gate id). Nothing was written.
  gatekeeper_already_linked: {
    zh: '这个端点上已有的门已经关联到另一个平台门实例；一个门只能关联一个实例，本次没有写入任何内容。请先解除旧实例的关联',
    en: 'The existing Gatekeeper at this endpoint is already linked to another platform gate instance — one Gatekeeper takes one instance, and nothing was written. Remove the old instance’s link first',
  },
  // P0b (one landing path): `create_connection` at an address this workspace already connected —
  // a second Gatekeeper there was leftover 73's duplicate. Nothing was written, the minted secret
  // included (legacy 382): the gate there keeps its own.
  endpoint_already_connected: {
    zh: '这个工作区已经接入了这个地址上的门，没有再接一次，什么也没保存——这里生成的连接密钥也没有保存，那个门用的仍是它原来的密钥。到「系统与授权」打开它：要更新清单点「重新读取门的清单」；如果已经把这次的新密钥配到了门上，门会连不上，在 ⋯ 里「重新签发连接密钥」，把签发的密钥换到门上',
    en: 'This workspace already connected the gate at this address, so nothing was saved — not the connection secret generated here either; that gate still uses its own. Open it in Systems & access: “Re-read the gate’s manifest” updates its manifest; if you already put this new secret on the gate, it will not connect — use ⋯ → “Issue a new connection secret” and put that one on the gate instead',
  },
  // P0b (leftover 118 remainder ①): the platform administrator suspended this self-connected gate;
  // enabling the platform instance at its address (or re-reading its manifest) would get around
  // that. Nothing was written.
  self_connection_suspended: {
    zh: '平台管理员暂停了这个工作区自己接入的门，暂停期间不能启用同地址的平台实例，也不能重新读取它的清单；本次没有写入任何内容。请联系平台管理员',
    en: 'The platform administrator suspended this self-connected gate — while it is suspended, the platform instance at its address cannot be enabled and its manifest cannot be re-read. Nothing was written; contact the platform administrator',
  },
  // Legacy 377 (review #493 on #620): mostly the workspace enabled the catalog instance at that
  // address after this list was read, and the gate now comes from it; a purged workspace is the
  // other way it goes. The kernel does not say which, so the likely one leads.
  self_connection_not_found: {
    zh: '这个门已不在「自己接入的门」里：多半是工作区从目录启用了同地址的平台实例，它已改由那个实例接入（也可能是工作区已被清除）。本次没有写入任何内容；刷新列表，到「门实例」里看那个实例',
    en: 'This gate is no longer self-connected: most likely the workspace enabled the platform instance at the same address and the gate now comes from that instance (or the workspace was purged). Nothing was written; refresh the list and look at that instance under Gate instances',
  },
  // S8 W3-K1 (leftover 79, closing wave C6, G3); legacy 214 narrowed it: the Gatekeeper sits at a
  // platform gate instance's address but was never enabled from the catalog (a CLI registration),
  // so neither the instance's announcement nor the gate's own description is its manifest. A gate
  // the workspace connected itself re-syncs from its own description instead.
  no_announced_manifest: {
    zh: '这个门在平台门实例的地址上，但不是从能力目录启用的，没有可对齐的清单；请到能力目录启用这个平台门',
    en: 'This Gatekeeper is at a platform gate instance’s address but was never enabled from the catalog, so there is no manifest to align with — enable that platform gate from the catalog',
  },
  // Legacy 214: re-reading the gate's own manifest was asked of a Gatekeeper enabled from a platform
  // gate instance (the link appeared between page load and the click). Nothing was written.
  gatekeeper_linked: {
    zh: '这个门是从平台门实例启用的，要按平台公告对齐，不能直接读门的清单；本次没有写入任何内容。请用「与门公告对齐」',
    en: 'This Gatekeeper was enabled from a platform gate instance — it aligns with the platform’s announcement, not the gate’s own description, and nothing was written. Use “Align with the gate’s announcement”',
  },
  // R-18 (D-18): the manifest shown is no longer the one that would be applied — a workspace
  // enable / refresh after an administrator confirmed a newer manifest, or a platform confirm
  // after the gate announced again. Nothing was written; reload and look again.
  manifest_changed: {
    zh: '门的清单在你查看之后变了，没有写入任何内容；请重新打开查看',
    en: "The gate's manifest changed after you looked at it — nothing was written; open it again to review",
  },
  // Review #493 on #583: an Operation draft was revised in place (its proposer re-proposing, a gate
  // re-import) after it was read — discarding or publishing it would have acted on content the
  // reader never saw. Nothing was written; the catalog reloads it.
  draft_changed: {
    zh: '这份草稿在你查看之后被修改过，本次没有写入任何内容。请先看它现在的内容，再决定是否操作',
    en: 'This draft was changed after you looked at it — nothing was written. Look at what it says now before acting on it',
  },
  // Legacy 300: a publish / install named the version the person looked at, and what it would
  // write now is a newer one (another draft under the same Skill or Procedure, a newer module
  // index). Nothing was written; the page reloads it.
  version_changed: {
    zh: '在你查看之后它有了新版本，本次没有写入任何内容。请先看最新版本，再决定是否操作',
    en: 'A newer version appeared after you looked at it — nothing was written. Look at the latest version before acting on it',
  },
  no_pending_manifest: {
    zh: '这个门实例没有待确认的公告清单',
    en: 'This gate instance has no announced manifest awaiting confirmation',
  },
  // R-60: the ontology draft was proposed against a published version that is no longer the
  // family's latest — publishing it would drop what the newer version added. Nothing was
  // published; the proposer proposes again from the current version (or discards this draft).
  ontology_base_moved: {
    zh: '这份草稿提出之后，该本体又发布了新版本；本次没有发布任何内容。请基于当前版本重新提议，或丢弃这份草稿',
    en: 'A newer version of this ontology was published after this draft was proposed — nothing was published. Propose the change again from the current version, or discard this draft',
  },
  // I-P1 (S10 P0): an ObjectType / ActionType name in this version is already declared by another
  // published ontology family of the workspace. Nothing was published; rename the type, or change
  // the family that owns it.
  ontology_namespace_conflict: {
    zh: '这个版本里有对象类型或动作类型与本工作区另一个已发布的本体族重名；本次没有发布任何内容。请改名，或改动拥有该类型的那个本体族',
    en: 'An object type or action type in this version is already declared by another published ontology family in this workspace — nothing was published. Rename it, or change the family that owns it',
  },
  // Legacy 145: `propose_entry_template_upgrade`. Nothing was proposed in either.
  entry_template_current: {
    zh: '当前生效的入口定义已经和平台模板一致，没有可生成的草稿',
    en: 'The entry definition in use already matches the platform template — there is no draft to propose',
  },
  entry_template_changed: {
    zh: '在你查看之后，平台模板或当前生效的入口版本变了，本次没有生成草稿。已重新读取，请再看一遍差异',
    en: 'The platform template or the entry version in use changed after you looked — no draft was proposed. It has been read again; look at the difference once more',
  },
  // S11 P1-D: a Skill name another Skill already has published in this workspace (a Worker mounts
  // Skills by name, so a name has one Skill) — `publish_skill`, a pack's install review and
  // install. Nothing was published.
  skill_name_conflict: {
    zh: '工作区里已经有另一个同名的 Skill 在用；Worker 按名字挂载 Skill，同名会让它挂错，所以本次没有发布任何内容。请改名，或先停用另一个',
    en: 'Another Skill of this name is already in use in this workspace; a Worker mounts Skills by name, so two of one name would mix them up — nothing was published. Rename it, or deprecate the other one first',
  },
  // S11 W1a E2-0: `propose_skill{skillId}` / `propose_procedure{procedureId}` — the family's
  // latest version is still a draft, or a Skill's next version under another name. Nothing was
  // proposed.
  draft_pending: {
    zh: '它的最新版本还是一份没有发布、也没有丢弃的草稿；发布总是取最新版本，再提议一份会顶替那份草稿，所以这次没有提议。先发布或丢弃那份草稿（只有它的提议者能丢弃），再提议新版本',
    en: 'Its latest version is still a draft that has been neither published nor discarded; publishing always takes the latest version, so another draft would take its place — nothing was proposed. Publish or discard that draft first (only its proposer can discard it), then propose the new version',
  },
  skill_name_changed: {
    zh: '新版本要沿用这个 Skill 的名称：Worker 按名称挂载 Skill，旧版本也仍是已发布的，换了名称挂载它的 Worker 就会停在旧版本，所以这次没有提议。要用别的名称，就另存为一个新的 Skill 再提议',
    en: 'A new version keeps this Skill’s name: a Worker mounts Skills by name and the earlier version stays published, so under another name the Workers that mount it would stay on the old version — nothing was proposed. To use another name, save it as a new Skill',
  },
  // S11 P1 (`application/change-plan`): the module install path's two refusals, and P1-B's install
  // record rollback. Nothing was written in any of them.
  change_confirmation_required: {
    zh: '这次改动里有会改变权限边界的项（例如新增或去掉一个动作类型），要逐项确认后才能进行；本次没有写入任何内容',
    en: 'Part of this change moves an authority boundary (such as adding or taking out an action type) and has to be confirmed item by item — nothing was written',
  },
  change_plan_changed: {
    zh: '在你查看之后，要改动的内容或工作区里的现状变了，本次没有写入任何内容。刷新后重新查看，再决定是否继续',
    en: 'What would change, or what the workspace has now, moved after you looked — nothing was written. Refresh, look again, then decide',
  },
  change_segment_not_found: {
    zh: '这个工作区里没有这条安装记录，它可能属于另一个工作区。回到「安装历史」重新选择',
    en: 'This workspace has no such install record — it may belong to another workspace. Pick it again from Install history',
  },
  change_segment_rolled_back: {
    zh: '这条安装记录已经撤销过了，本次没有写入任何内容。刷新后查看它现在的状态',
    en: 'This install record was already rolled back — nothing was written. Refresh to see where it stands now',
  },
  change_rollback_conflict: {
    zh: '其中有改动现在撤销不了（之后又被改过、要退回的那一版已经不在，或类型名已被别的本体占用），本次没有写入任何内容。刷新后按撤销预览里列出的原因处理',
    en: 'Some of its changes cannot be rolled back now (changed again since, the version to return to is gone, or a type name is taken by another ontology) — nothing was written. Refresh and deal with the reasons the rollback preview lists',
  },
  // S7-E (`application/platform/runtime.ts`): the 运行层 page's refusals. Nothing changed in any of
  // them. The allowlist is the host's configuration, so the operator is who widens it.
  image_not_in_inventory: {
    zh: '这个镜像不在已构建的镜像列表里，没有设为活动；先在主机或 CI 上构建它（见运维手册），再回来设置',
    en: 'That image is not in the list of built images, so it was not set active — build it on the host or in CI first (see the operations runbook), then come back',
  },
  image_not_allowed: {
    zh: '这个镜像不在运行层的镜像允许列表里，用它启动的容器都会被拒绝，所以没有改动；请运维把它加进主机配置的允许列表后再试',
    en: 'That image is not in the runtime’s image allowlist — every container started from it would be refused, so nothing changed. Ask the operator to add it to the host’s allowlist, then retry',
  },
  // STATUS leftover 422: the image was built before the whitelist start's mount layout.
  runtime_image_incompatible: {
    zh: '这个镜像是本版之前构建的，和现在的挂载布局对不上，用它起不了任何容器，所以没有改动；把本版构建的镜像设为活动（清单里还没有的话，先在主机上构建运行层镜像）',
    en: 'That image was built before this release’s mount layout — no container can start from it, so nothing changed. Set an image built from this release active (build the runtime image on the host first if the list has none)',
  },
  runtime_unreachable: {
    zh: '连不上运行层（worker-supervisor），没有做任何改动；稍后重试，反复出现时到「运行状态」查看它是否在运行',
    en: 'The runtime (worker-supervisor) could not be reached, so nothing changed — retry shortly; if it keeps happening, check under Status whether it is running',
  },
  no_previous_settings_version: {
    zh: '平台设置的历史里没有另一个活动镜像可以回滚，没有改动',
    en: 'The platform settings history has no other active image to roll back to, so nothing changed',
  },
};

/** The bilingual message for a platform capability failure, or `null` when the code is not one of
 *  ours (a transport failure, a 403, an unmapped kernel code) and the caller should fall back to
 *  `ErrorBanner`. A pure helper, not a component — takes `t` from its caller. */
/** UX acceptance of #620 (P2-3): `endpoint_already_connected` naming the system already at that
 *  address (`details.gatekeeperName`) — the 系统与授权 cards show names, not addresses, so the
 *  sentence above alone cannot say which card. Without a name (`details` is additive,
 *  docs/wire-contract-conventions.md) it is that sentence. */
export function endpointAlreadyConnectedMessage(name: string | null, t: Translate): string {
  if (name === null) {
    const entry = ownEntry(PLATFORM_ERROR_MESSAGES, 'endpoint_already_connected');
    return entry ? t(entry.zh, entry.en) : '';
  }
  return t(
    `这个地址已经接入为「${name}」，没有再接一次，什么也没保存——这里生成的连接密钥也没有保存，「${name}」用的仍是它原来的密钥。在「系统与授权」里找到「${name}」：要更新清单点「重新读取门的清单」；如果已经把这次的新密钥配到了门上，门会连不上，在 ⋯ 里「重新签发连接密钥」，把签发的密钥换到门上`,
    `This address is already connected as “${name}”, so nothing was saved — not the connection secret generated here either; “${name}” still uses its own. Find “${name}” in Systems & access: “Re-read the gate’s manifest” updates its manifest; if you already put this new secret on the gate, it will not connect — use ⋯ → “Issue a new connection secret” and put that one on the gate instead`,
  );
}

export function platformErrorMessage(err: unknown, t: Translate): string | null {
  if (!(err instanceof HttpError) || err.kind !== 'capability_error') return null;
  if (err.code === undefined) return null;
  const entry = err.code !== undefined ? ownEntry(PLATFORM_ERROR_MESSAGES, err.code) : undefined;
  return entry ? t(entry.zh, entry.en) : null;
}

/** The tooltip an env-listed administrator's disabled affordances carry (design §6.6: those
 *  accounts are always administrators and the page must say why it will not act on them). A pure
 *  helper, not a component — takes `t` from its caller. */
export function envAdminTitle(t: Translate): string {
  return t('由主机环境配置指定的管理员', 'Administrator set by the host configuration');
}

/** `create_user`'s login rule, mirrored client-side so the field can say so before the kernel
 *  does (`platform-handlers.ts` `LOGIN_PATTERN`). */
export const LOGIN_PATTERN = /^[a-z0-9][a-z0-9._-]{2,63}$/;

/** `create_gate_instance`'s `gateId` rule, mirrored client-side (`capabilities.ts`'s own regex on
 *  that param — becomes the instance's `GATE_ID` and its gate-host path). */
export const GATE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;
