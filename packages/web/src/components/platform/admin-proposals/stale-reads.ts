import type { CapabilityName } from '@nexttime/shared';

/**
 * The reads a decision on 平台 · 管理员提案 (S11 AA4b) makes stale: the proposals and their
 * platform part's review, the platform change records and their rollback dry run, and — applying
 * creates gate-host instances (and maybe a connector), rolling back disables them — 集成's lists.
 */
export const ADMIN_PROPOSAL_STALE_READS: readonly CapabilityName[] = [
  'list_admin_proposals',
  'get_admin_proposal',
  'preview_platform_segment',
  'list_platform_change_segments',
  'get_platform_change_segment',
  'preview_roll_back_platform_change_segment',
  'list_gate_instances',
  'list_connectors',
];
