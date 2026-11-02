import type {
  AdminProposalGateInstanceIntentWire,
  AdminProposalPlatformItemBlocker,
  AdminProposalProposerWire,
  AdminProposalSegmentCountsWire,
  AdminProposalSegmentWire,
  AdminProposalWire,
  AdminProposalWithdrawnOrigin,
  GateHostedDefinitionWire,
  GateInstanceDriftField,
  GateInstanceNextStep,
  PlatformChangeRollbackItemWire,
  PlatformUserRefWire,
} from '@nexttime/shared';
import { shortId } from '../../../lib/format.js';
import type { Translate } from '../../../lib/i18n.js';
import type { PresetLabel } from './preset-labels.js';

/**
 * components/platform/admin-proposals/text: what 平台 · 管理员提案 (S11 AA4b, the AA4 plan F7) says
 * about an admin proposal and its parts, as words — kept apart from the components so each sentence
 * is written once and tested once.
 *
 * Vocabulary (F10-1, legacy 605): 管理员提案 / admin proposal; 平台部分 / platform part; 工作区部分 /
 * workspace part; 管理员智能体 / admin agent; 门宿主实例 / gate-host instance (the one English name
 * this console uses for it).
 */

/** A platform user by the name they had then, or a short id when they had none. */
export function userName(ref: AdminProposalProposerWire | PlatformUserRefWire): string {
  return ref.displayName || shortId(ref.userId);
}

/** 「平台管理员 Ada 的管理员智能体」 — who proposed it (I-A7: always an admin agent). */
export function proposerText(proposedBy: AdminProposalProposerWire, t: Translate): string {
  const name = userName(proposedBy);
  return t(`平台管理员 ${name} 的管理员智能体`, `${name}'s admin agent (platform administrator)`);
}

const SEGMENT_COUNT_LABELS: readonly {
  readonly key: keyof AdminProposalSegmentCountsWire;
  readonly zh: string;
  readonly en: string;
}[] = [
  { key: 'proposed', zh: '待确认', en: 'awaiting' },
  { key: 'applied', zh: '已应用', en: 'applied' },
  { key: 'rejected', zh: '已拒绝', en: 'rejected' },
  { key: 'withdrawn', zh: '已撤回', en: 'withdrawn' },
  { key: 'rolledBack', zh: '已撤销', en: 'rolled back' },
];

/** 「待确认 2 · 已应用 1」 — how many of its parts are in each status (the ones with any). */
export function segmentCountsText(counts: AdminProposalSegmentCountsWire, t: Translate): string {
  return SEGMENT_COUNT_LABELS.filter(({ key }) => counts[key] > 0)
    .map(({ key, zh, en }) => t(`${zh} ${counts[key]}`, `${counts[key]} ${en}`))
    .join(' · ');
}

/**
 * The header of a proposal whose parts did not all end the same way (F7 「部分应用」): 「平台部分已应用；
 * 3 个工作区里 1 个已应用、1 个已拒绝、1 个待确认」. `null` while nothing is decided yet, or every part
 * shares one status — the status chip says that already.
 */
export function partialApplicationText(proposal: AdminProposalWire, t: Translate): string | null {
  const statuses = new Set(proposal.segments.map((segment) => segment.status));
  if (statuses.size <= 1) return null;
  const platform = proposal.segments.find((segment) => segment.authority === 'platform');
  const workspaces = proposal.segments.filter((segment) => segment.authority === 'workspace');
  const parts: string[] = [];
  if (platform) {
    parts.push(
      t(
        `平台部分${segmentStatusWord(platform.status, t)}`,
        `platform part ${segmentStatusWord(platform.status, t)}`,
      ),
    );
  }
  if (workspaces.length > 0) {
    const tally = SEGMENT_COUNT_LABELS.map(({ key, zh, en }) => ({
      zh,
      en,
      count: workspaces.filter((segment) => countKeyOf(segment.status) === key).length,
    })).filter((entry) => entry.count > 0);
    parts.push(
      t(
        `${workspaces.length} 个工作区里 ${tally.map((entry) => `${entry.count} 个${entry.zh}`).join('、')}`,
        `of ${workspaces.length} workspace part${workspaces.length > 1 ? 's' : ''}: ${tally.map((entry) => `${entry.count} ${entry.en}`).join(', ')}`,
      ),
    );
  }
  const text = parts.join(t('；', '; '));
  return t(text, text.charAt(0).toUpperCase() + text.slice(1));
}

function countKeyOf(
  status: AdminProposalSegmentWire['status'],
): keyof AdminProposalSegmentCountsWire {
  return status === 'rolled_back' ? 'rolledBack' : status;
}

function segmentStatusWord(status: AdminProposalSegmentWire['status'], t: Translate): string {
  switch (status) {
    case 'proposed':
      return t('待确认', 'awaiting a decision');
    case 'applied':
      return t('已应用', 'applied');
    case 'rejected':
      return t('已拒绝', 'rejected');
    case 'withdrawn':
      return t('已撤回', 'withdrawn');
    case 'rolled_back':
      return t('已撤销', 'rolled back');
  }
}

/** Why a part was withdrawn, or `null` when it was not. */
export function withdrawnText(
  origin: AdminProposalWithdrawnOrigin | null,
  t: Translate,
): string | null {
  switch (origin) {
    case null:
      return null;
    case 'agent':
      return t(
        '提议它的平台管理员通过管理员智能体撤回了它',
        'The platform administrator who proposed it withdrew it through their admin agent',
      );
    case 'human':
      return t('平台管理员在控制台撤回了它', 'A platform administrator withdrew it in the console');
    case 'platform_segment':
      return t(
        '它依赖的平台部分被拒绝或撤销了，这一部分随之撤回',
        'The platform part it depends on was rejected or rolled back, so it was withdrawn with it',
      );
  }
}

/** Why a platform item cannot be created as proposed now, as what the administrator can do. */
export function platformBlockerText(
  reason: AdminProposalPlatformItemBlocker,
  subject: string,
  t: Translate,
): string {
  switch (reason) {
    case 'gate_id_taken':
      return t(
        `${subject}：平台上已经有这个 gate id 的门宿主实例。只能拒绝，或请提议它的平台管理员换个 id 重新提议。`,
        `${subject}: a gate-host instance with that gate id already exists on the platform. Reject it, or ask the platform administrator who proposed it to propose it again under another id.`,
      );
    case 'connector_preset_not_found':
      return t(
        `${subject}：它用的预设在这个部署里没有。只能拒绝，或请提议它的平台管理员改用已有的预设。`,
        `${subject}: this deployment ships no connector preset by that name. Reject it, or ask the platform administrator who proposed it to use a preset that exists.`,
      );
    case 'connector_kind_mismatch':
      return t(
        `${subject}：同名的接入包已经存在，但接入方式和它不同，不能把它加进去。只能拒绝，或换一个接入包重新提议。`,
        `${subject}: a connector by that name exists with another transport, so it cannot join it. Reject it, or propose it again with another connector.`,
      );
    case 'connector_packaged':
      return t(
        `${subject}：同名的接入包是随部署打包的，不接受新的门宿主实例。只能拒绝，或换一个接入包重新提议。`,
        `${subject}: the connector by that name ships with the deployment and takes no new gate-host instance. Reject it, or propose it again with another connector.`,
      );
    case 'connector_not_offerable':
      return t(
        `${subject}：同名的接入包存在，但不是「平台预置」，工作区没法从目录里启用它的实例。先在「集成 → 接入包」把它设为平台预置，再回来看；或拒绝它。`,
        `${subject}: a connector by that name exists but is not a platform preset, so workspaces could not enable its instances from the catalog. Set it to platform preset under Integrations → Connectors and come back, or reject it.`,
      );
  }
}

/** What the administrator does once an instance exists, before a workspace can enable it. */
export function nextStepText(step: GateInstanceNextStep, t: Translate): string {
  switch (step) {
    case 'enter_shared_credential':
      return t('在门宿主上录入共享凭据', 'enter the shared credential on the gate host');
    case 'await_announce':
      return t(
        '等门宿主接管它并上报 Operation 清单',
        'wait for the gate host to take it over and announce its Operations',
      );
    case 'review_and_enable':
      return t('审阅这些 Operation 后启用它', 'review those Operations, then enable it');
  }
}

export function transportText(definition: GateHostedDefinitionWire, t: Translate): string {
  return definition.transportKind === 'mcp' ? 'MCP' : t('HTTP（OpenAPI）', 'HTTP (OpenAPI)');
}

export function credentialModeText(definition: GateHostedDefinitionWire, t: Translate): string {
  return definition.credentialMode === 'shared'
    ? t(
        '共享凭据：平台管理员录入一份，所有工作区共用',
        'Shared: one credential a platform administrator enters, for every workspace',
      )
    : t('各自的账号：每个成员录入自己的', 'Connected account: each member enters their own');
}

/** Where its Operations come from: the preset's, the OpenAPI document's, or the MCP server's. */
export function operationSourceText(
  definition: GateHostedDefinitionWire,
  t: Translate,
  presetLabel: PresetLabel = (name) => name,
): string {
  if (definition.preset !== undefined) {
    const preset = presetLabel(definition.preset);
    return t(`预设 ${preset}`, `connector preset ${preset}`);
  }
  if (definition.manifestSource !== null) {
    return t(
      `OpenAPI 文档 ${definition.manifestSource}`,
      `the OpenAPI document ${definition.manifestSource}`,
    );
  }
  return t('MCP 服务自己列出的工具', 'the tools the MCP server lists');
}

/** 「新建门宿主实例 RAGFlow（预设 ragflow）」 — a platform intent as proposed. */
export function platformIntentText(
  intent: AdminProposalGateInstanceIntentWire,
  t: Translate,
  presetLabel: PresetLabel = (name) => name,
): string {
  const name = intent.displayName ?? intent.gateId;
  const from = intent.preset
    ? t(`预设 ${presetLabel(intent.preset)}`, `preset ${presetLabel(intent.preset)}`)
    : intent.connector
      ? t(`接入包 ${intent.connector}`, `connector ${intent.connector}`)
      : null;
  return from
    ? t(`新建门宿主实例 ${name}（${from}）`, `New gate-host instance ${name} (${from})`)
    : t(`新建门宿主实例 ${name}`, `New gate-host instance ${name}`);
}

const DRIFT_FIELD_LABEL: Readonly<
  Record<GateInstanceDriftField, { readonly zh: string; readonly en: string }>
> = {
  connector: { zh: '接入包', en: 'connector' },
  transportKind: { zh: '接入方式', en: 'transport' },
  target: { zh: '地址', en: 'address' },
  credentialMode: { zh: '凭据方式', en: 'credential mode' },
  manifestSource: { zh: '清单来源', en: 'manifest source' },
  preset: { zh: '预设', en: 'preset' },
};

/** 「地址、接入包」 — the fields changed since the instance was created. */
export function driftFieldsText(fields: readonly GateInstanceDriftField[], t: Translate): string {
  return fields
    .map((field) => t(DRIFT_FIELD_LABEL[field].zh, DRIFT_FIELD_LABEL[field].en))
    .join(t('、', ', '));
}

/**
 * An instance a platform change created, as it is now (F8 (b): read live from the rollback dry run,
 * every time the record opens — never a conclusion kept from before a rollback, legacy 603's
 * trap): changed since, gone, disabled, or as created.
 */
export function currentStateText(
  item: PlatformChangeRollbackItemWire,
  name: string,
  t: Translate,
): string {
  if (item.action === 'gone') return t(`${name}：已删除`, `${name}: deleted`);
  const drift =
    item.drift.length > 0
      ? t(
          `${driftFieldsText(item.drift, t)}在应用之后改过`,
          `${driftFieldsText(item.drift, t)} changed since it was applied`,
        )
      : t('定义和应用时一样', 'its definition is as it was applied');
  const disabled = item.action === 'already_disabled';
  const state = disabled ? t('已停用', 'disabled') : t('没有停用', 'not disabled');
  // #936 UX P3-2: a disabled instance still answers the workspaces that enabled it — say so, as
  // right after a rollback is when it is easiest to believe they were cut off.
  const used =
    item.linkedWorkspaceCount > 0
      ? disabled
        ? t(
            `${item.linkedWorkspaceCount} 个工作区启用了它，已启用的仍能调用`,
            `${item.linkedWorkspaceCount} workspace${item.linkedWorkspaceCount > 1 ? 's' : ''} enabled it and can still call it`,
          )
        : t(
            `${item.linkedWorkspaceCount} 个工作区启用了它`,
            `${item.linkedWorkspaceCount} workspace${item.linkedWorkspaceCount > 1 ? 's' : ''} enabled it`,
          )
      : t('没有工作区启用它', 'no workspace enabled it');
  return t(`${name}：${drift}；${state}；${used}`, `${name}: ${drift}; ${state}; ${used}`);
}

/** What rolling back does to one instance. */
export function rollbackActionText(
  item: PlatformChangeRollbackItemWire,
  name: string,
  t: Translate,
): string {
  switch (item.action) {
    case 'disable':
      return t(`停用 ${name}`, `Disables ${name}`);
    case 'already_disabled':
      return t(`${name} 已经停用，不改动`, `${name} is disabled already; left as is`);
    case 'gone':
      return t(`${name} 已删除，不改动`, `${name} was deleted; nothing to do`);
  }
}
