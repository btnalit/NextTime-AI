import type {
  AdminProposalGateInstanceIntentWire,
  AdminProposalSegmentWire,
  AdminProposalSummaryWire,
  AdminProposalWire,
  ConnectorPresetWire,
  PlatformChangeRollbackItemWire,
  PlatformChangeRollbackPreviewWire,
  PlatformChangeSegmentWire,
  PlatformSegmentPreviewItemWire,
  PlatformSegmentPreviewWire,
  PlatformWorkspaceWire,
} from '@nexttime/shared';
import { vi } from 'vitest';
import type { CapabilityCaller } from '../../../lib/clients.js';

/** Fixtures shared by 平台 · 管理员提案's tests (S11 AA4b): one admin proposal with a platform part
 *  that creates two gate-host instances, and workspace parts for a production and a trial
 *  workspace (`wire/admin-proposal.ts`, `wire/platform-change.ts` shapes). */

export const PROPOSAL = '66666666-6666-4666-8666-666666666666';
export const PLATFORM_SEGMENT = '77777777-7777-4777-8777-777777777777';
export const PROD_SEGMENT = '88888888-8888-4888-8888-888888888888';
export const TRIAL_SEGMENT = '99999999-9999-4999-8999-999999999999';
export const RECORD = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const WS_PROD = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export const WS_TRIAL = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

export const ADA = { userId: 'u-ada', displayName: 'Ada' };
export const ROOT = { userId: 'u-root', displayName: 'Root' };

/** From the `ragflow` preset: only the address is typed. */
export const KB_INTENT: AdminProposalGateInstanceIntentWire = {
  kind: 'gate_instance',
  gateId: 'kb-main',
  displayName: '知识库',
  preset: 'ragflow',
  target: 'https://kb.example.test',
};

/** An http instance with its own connector and OpenAPI document. */
export const OPS_INTENT: AdminProposalGateInstanceIntentWire = {
  kind: 'gate_instance',
  gateId: 'ops-api',
  displayName: '运维接口',
  transportKind: 'http',
  target: 'https://ops.example.test/api',
  credentialMode: 'shared',
  manifestSource: 'https://ops.example.test/openapi.json',
  connector: 'ops-console',
};

export function platformSegment(
  patch: Partial<AdminProposalSegmentWire> = {},
): AdminProposalSegmentWire {
  return {
    id: PLATFORM_SEGMENT,
    ordinal: 1,
    authority: 'platform',
    targetWorkspaceId: null,
    items: [KB_INTENT, OPS_INTENT],
    contentDigest: 'sha256:platform',
    status: 'proposed',
    decidedAt: null,
    withdrawnOrigin: null,
    reason: null,
    rolledBackAt: null,
    ...patch,
  };
}

export function workspaceSegment(
  patch: Partial<AdminProposalSegmentWire> = {},
): AdminProposalSegmentWire {
  return {
    id: PROD_SEGMENT,
    ordinal: 2,
    authority: 'workspace',
    targetWorkspaceId: WS_PROD,
    items: [
      {
        kind: 'skill_version',
        skill: { name: 'kb-search', description: '查知识库', markdown: '# 查知识库' },
      },
    ],
    contentDigest: 'sha256:prod',
    status: 'proposed',
    decidedAt: null,
    withdrawnOrigin: null,
    reason: null,
    rolledBackAt: null,
    ...patch,
  };
}

export function proposal(patch: Partial<AdminProposalWire> = {}): AdminProposalWire {
  return {
    id: PROPOSAL,
    title: '接入知识库',
    sourceName: 'kb-onboarding',
    origin: 'agent',
    proposedBy: ADA,
    proposedAt: '2026-11-01T08:00:00.000Z',
    status: 'proposed',
    segmentCounts: { proposed: 3, applied: 0, rejected: 0, withdrawn: 0, rolledBack: 0 },
    description: '给生产工作区接上知识库，并加一个查知识库的 Skill。',
    contentDigest: 'sha256:proposal',
    segments: [
      platformSegment(),
      workspaceSegment(),
      workspaceSegment({
        id: TRIAL_SEGMENT,
        ordinal: 3,
        targetWorkspaceId: WS_TRIAL,
        contentDigest: 'sha256:trial',
      }),
    ],
    ...patch,
  };
}

export function summary(patch: Partial<AdminProposalSummaryWire> = {}): AdminProposalSummaryWire {
  const { description: _d, contentDigest: _c, segments: _s, ...head } = proposal();
  return { ...head, ...patch };
}

export function previewItem(
  intent: AdminProposalGateInstanceIntentWire,
  ordinal: number,
  patch: Partial<PlatformSegmentPreviewItemWire> = {},
): PlatformSegmentPreviewItemWire {
  return {
    ordinal,
    kind: 'gate_instance',
    classification: 'authority_widening',
    widening: [{ path: 'gate_instance.target', reason: 'added' }],
    gateId: intent.gateId,
    displayName: intent.displayName ?? intent.gateId,
    connector:
      intent.preset !== undefined
        ? { name: intent.preset, created: false }
        : { name: intent.connector ?? 'http', created: true },
    definition:
      intent.preset !== undefined
        ? {
            transportKind: 'http',
            target: intent.target,
            credentialMode: 'shared',
            manifestSource: null,
            preset: intent.preset,
          }
        : {
            transportKind: intent.transportKind ?? 'http',
            target: intent.target,
            credentialMode: intent.credentialMode ?? 'shared',
            manifestSource: intent.manifestSource ?? null,
          },
    nextSteps: ['enter_shared_credential', 'await_announce', 'review_and_enable'],
    ...patch,
  };
}

export function platformPreview(
  patch: Partial<PlatformSegmentPreviewWire> = {},
): PlatformSegmentPreviewWire {
  const { segments: _s, contentDigest: _c, status: _st, segmentCounts: _sc, ...head } = proposal();
  return {
    proposal: head,
    segment: platformSegment(),
    blockers: [],
    digest: 'sha256:reviewed',
    items: [previewItem(KB_INTENT, 1), previewItem(OPS_INTENT, 2)],
    dependents: [
      { segmentId: PROD_SEGMENT, targetWorkspaceId: WS_PROD, status: 'proposed' },
      { segmentId: TRIAL_SEGMENT, targetWorkspaceId: WS_TRIAL, status: 'proposed' },
    ],
    suspectedSecretValues: 0,
    suspectedSecretPaths: [],
    ...patch,
  };
}

export function changeRecord(
  patch: Partial<PlatformChangeSegmentWire> = {},
): PlatformChangeSegmentWire {
  const items = [previewItem(KB_INTENT, 1), previewItem(OPS_INTENT, 2)];
  return {
    id: RECORD,
    source: {
      kind: 'admin_proposal',
      name: 'kb-onboarding',
      proposalId: PROPOSAL,
      proposalSegmentId: PLATFORM_SEGMENT,
      digest: 'sha256:platform',
    },
    proposedBy: ADA,
    reviewedDigest: 'sha256:reviewed',
    status: 'applied',
    appliedBy: ROOT,
    appliedAt: '2026-11-02T08:00:00.000Z',
    rolledBackBy: null,
    rolledBackAt: null,
    items: items.map((item) => ({
      ordinal: item.ordinal,
      kind: item.kind,
      classification: item.classification,
      gateId: item.gateId,
      displayName: item.displayName,
      connector: item.connector,
      definition: item.definition,
      confirmedBy: ROOT,
    })),
    ...patch,
  };
}

export function rollbackItem(
  ordinal: number,
  gateId: string,
  patch: Partial<PlatformChangeRollbackItemWire> = {},
): PlatformChangeRollbackItemWire {
  return {
    ordinal,
    gateId,
    action: 'disable',
    drift: [],
    linkedWorkspaceCount: 0,
    enabledIn: [],
    ...patch,
  };
}

export function rollbackPreview(
  patch: Partial<PlatformChangeRollbackPreviewWire> = {},
): PlatformChangeRollbackPreviewWire {
  return {
    changeSegment: changeRecord(),
    items: [rollbackItem(1, 'kb-main'), rollbackItem(2, 'ops-api')],
    dependentsApplied: [],
    canRollBack: true,
    ...patch,
  };
}

export function workspace(patch: Partial<PlatformWorkspaceWire> = {}): PlatformWorkspaceWire {
  return {
    id: WS_PROD,
    name: '生产',
    status: 'active',
    entryModel: null,
    allowedModels: [],
    ontologyEnforcement: 'reject',
    purpose: 'standard',
    expiresAt: null,
    disabledAt: null,
    purgeable: false,
    isDefault: true,
    memberCount: 3,
    owners: [{ userId: 'u-1', login: 'alice', displayName: 'Alice', principalId: 'p-1' }],
    createdAt: '2026-09-01T00:00:00.000Z',
    ...patch,
  };
}

export const WORKSPACES = [
  workspace(),
  workspace({ id: WS_TRIAL, name: '试验场', purpose: 'admin_trial', isDefault: false }),
];

export function ragflowPreset(): ConnectorPresetWire {
  return {
    name: 'ragflow',
    displayName: 'RAGFlow',
    summary: '知识库检索',
    transportKind: 'http',
    credentialMode: 'shared',
    targetHint: 'RAGFlow 的地址',
    credentialHint: 'API key',
    operations: [],
    packagedConnector: false,
    instanceCount: 0,
  };
}

/** Reads every page of the platform plane shows around a proposal; a test adds its own. */
export const AMBIENT_READS: Record<string, (params: unknown) => unknown> = {
  list_workspaces: () => ({ items: WORKSPACES }),
  list_connector_presets: () => ({ items: [ragflowPreset()] }),
};

export function scriptedHttp(
  handlers: Record<string, (params: unknown) => unknown>,
): CapabilityCaller & { readonly calls: { readonly name: string; readonly params: unknown }[] } {
  const all = { ...AMBIENT_READS, ...handlers };
  const calls: { name: string; params: unknown }[] = [];
  return {
    calls,
    call: vi.fn(async (name: string, params?: unknown) => {
      calls.push({ name, params });
      const handler = all[name];
      if (!handler) throw new Error(`unscripted capability ${name}`);
      return handler(params);
    }) as CapabilityCaller['call'],
  };
}

export function named(calls: readonly { name: string; params: unknown }[], name: string) {
  return calls.filter((call) => call.name === name);
}
