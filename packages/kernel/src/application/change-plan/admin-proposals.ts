import {
  ADMIN_PROPOSAL_DAILY_LIMIT,
  ADMIN_PROPOSAL_LIST_LIMIT,
  type AdminProposalAnyItemIntentWire,
  type AdminProposalItemIntentWire,
  type AdminProposalPlatformSegmentInputWire,
  type AdminProposalSegmentInputWire,
  type AdminProposalSegmentStatus,
  type AdminProposalSegmentWire,
  type AdminProposalStatus,
  type AdminProposalSummaryWire,
  type AdminProposalWire,
  type AdminProposalWithheldGateInstanceWire,
  type AdminProposalWorkspaceItemWire,
  type AgentAdminProposalWire,
  type ListEnvelope,
  adminProposalStatusOf,
  workerDefinitionContentSchemaFor,
} from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { ADVISORY_LOCK_NAMESPACES } from '../../adapters/db/advisory-lock-namespaces.js';
import { findConnectionParamsCredential } from '../../governance/connections/index.js';
import {
  RedactedTextSubmittedError,
  findCredentialValues,
  redactedPathsIn,
  shownFreeText,
} from '../../governance/redaction/index.js';
import { validateSkillContent } from '../worker/index.js';
import { assertTargetsNotRejectedRepeatedly } from './admin-proposal-breaker.js';
import { contentDigest } from './digest.js';

/**
 * application/change-plan/admin-proposals: what a platform administrator's admin agent proposes from its
 * trial workspace for people to apply elsewhere — an admin proposal and its segments (S11 AA3b-1;
 * docs/goal-orchestration-and-admin-agent-plan-2026-10-16.md §3.1–§3.3, §5.4, I-A4–I-A8; the AA3
 * default plan F4 / F5 / F9–F12). Owns migrations/governance/0032_admin_proposals.sql, whose header
 * has the model: where the rows live, who reads them, the lifecycle and the guards.
 *
 * What this cut does: propose (in the trial workspace, through the agent's Handle only), read back
 * and withdraw — by the agent for its own administrator's proposals (F12), and by a platform
 * administrator on the platform plane for any proposal. Previewing, applying and rejecting a segment in
 * its target workspace are AA3b-2's (`decided_by`, `applied_segment_id` stay null until then).
 *
 * A proposal writes nothing, and says why, when:
 *  - something in it is almost certainly a credential (`findCredentialValues`: F9 — the error says
 *    where, never the value; what only looks like one is counted when a segment is applied, which
 *    then needs the owner's confirmation);
 *  - it holds the `[redacted]` mark a read put where a suspected credential stood;
 *  - it names one target twice, or one item target twice in a segment, or content that would not
 *    publish (a Skill's rules, a Worker's definition — never its `gates` or `model`, the target
 *    workspace's own), or a source name a shipped pack has;
 *  - a Worker names a system (`systems`, S11 AA5f) that is neither a connector the platform has nor
 *    one the proposal's own platform segment creates (`unknownWorkerSystems`: what each target's
 *    owner binds it to when applying are that system's gates);
 *  - its administrator already proposed {@link ADMIN_PROPOSAL_DAILY_LIMIT} proposals today (F11, UTC,
 *    across every trial workspace, withdrawn ones included);
 *  - a target cannot take a proposal: unknown, disabled, or a trial workspace — all three refused alike
 *    (F10, coordinator 2026-11-02: one code and one text, so the agent cannot learn from the
 *    refusal whether a workspace it was not told about exists, or its state);
 *  - a target has rejected too many of the administrator's proposals lately (F6, S11 AA5a-2,
 *    `admin-proposal-breaker.ts`).
 */

// -------------------------------------------------------------------------------------------
// Errors
// -------------------------------------------------------------------------------------------

/** F10 / §3.2: a segment's target cannot take a proposal — unknown, disabled, or a trial workspace
 *  (proposing to one would be self-reference). One code and one message for the three, so the
 *  refusal says nothing about which: `segment` is the index into the call's own `segments`, the
 *  only thing it adds. Mapped to 400 `admin_proposal_target_unavailable`; nothing was written. */
export class AdminProposalTargetUnavailableError extends Error {
  readonly code = 'admin_proposal_target_unavailable' as const;
  readonly details: { readonly segment: number };
  constructor(segment: number) {
    super(
      `segments[${segment}].targetWorkspaceId: that workspace cannot take an admin proposal. Ask your administrator for the id of an active workspace that is not a trial workspace — nothing was proposed.`,
    );
    this.name = 'AdminProposalTargetUnavailableError';
    this.details = { segment };
  }
}

/** S11 AA4c (F5, the AA4c plan's D2): a segment's target is not among the workspaces the
 *  administrator lets their admin agent propose to in this trial workspace (`set_admin_agent_targets`
 *  on the platform plane; governance 0036). Checked before {@link AdminProposalTargetUnavailableError},
 *  so the refusal says nothing about the workspace itself — whether it exists or is disabled — only
 *  that it was not chosen: `segment` is the index into the call's own `segments`. Mapped to 400
 *  `admin_proposal_target_not_chosen`; nothing was written. */
export class AdminProposalTargetNotChosenError extends Error {
  readonly code = 'admin_proposal_target_not_chosen' as const;
  readonly details: { readonly segment: number };
  constructor(segment: number) {
    super(
      `segments[${segment}].targetWorkspaceId: your administrator has not chosen that workspace for you to propose to — nothing was proposed. agent_list_proposal_targets lists the ones they chose; ask them to add another on the platform's admin agent page.`,
    );
    this.name = 'AdminProposalTargetNotChosenError';
    this.details = { segment };
  }
}

/** F9: a value in the proposal that is almost certainly a credential (`findCredentialValues`).
 *  Mapped to 400 `admin_proposal_credential` with `details: { suspectedSecretValues,
 *  suspectedSecretPaths }` — where (field names and indices, at most 20), never a fragment of the
 *  value; nothing was written. */
export class AdminProposalCredentialError extends Error {
  readonly code = 'admin_proposal_credential' as const;
  readonly details: {
    readonly suspectedSecretValues: number;
    readonly suspectedSecretPaths: readonly string[];
  };
  /** `withdrawal`: a withdrawal's reason (#916 review P3-2) — the one text an administrator writes
   *  after proposing that the target workspace reads. */
  constructor(
    count: number,
    paths: readonly string[],
    subject: 'proposal' | 'withdrawal' = 'proposal',
  ) {
    super(
      subject === 'proposal'
        ? `the admin proposal carries ${count} value(s) that are almost certainly credentials, at ${paths.join(', ')} — nothing was proposed. A proposal never carries a credential: a gate authenticates with what is configured on it. Leave the value out.`
        : `the withdrawal's reason carries ${count} value(s) that are almost certainly credentials, at ${paths.join(', ')} — nothing was withdrawn. The workspaces the proposal is addressed to read the reason: leave the value out.`,
    );
    this.name = 'AdminProposalCredentialError';
    this.details = { suspectedSecretValues: count, suspectedSecretPaths: paths };
  }
}

/** F11: the administrator already proposed {@link ADMIN_PROPOSAL_DAILY_LIMIT} proposals since 00:00 UTC,
 *  across every trial workspace (withdrawn ones count). Mapped to 429
 *  `admin_proposal_quota_exceeded` with `details: { dailyLimit, resetsAt }`; nothing was written. */
export class AdminProposalQuotaExceededError extends Error {
  readonly code = 'admin_proposal_quota_exceeded' as const;
  readonly details: { readonly dailyLimit: number; readonly resetsAt: string };
  constructor(resetsAt: string) {
    super(
      `your administrator has proposed ${ADMIN_PROPOSAL_DAILY_LIMIT} admin proposals today (UTC), the daily limit — nothing was proposed. The count starts again at ${resetsAt}.`,
    );
    this.name = 'AdminProposalQuotaExceededError';
    this.details = { dailyLimit: ADMIN_PROPOSAL_DAILY_LIMIT, resetsAt };
  }
}

/** I-A1, where the two readings of the administrator's platform role differ (#916 review P3-1,
 *  coordinator 11-02): the kernel's (`effectivePlatformRole` — a login `NEXTTIME_PLATFORM_ADMINS`
 *  pins is an administrator whatever is stored) lets the admin agent act, while the stored
 *  `users.platform_role`, the only one the database sees (0032's `admin_proposals_guard`), is not
 *  `admin`. The stricter one decides: refused before anything is counted or written, with what to
 *  do instead of the guard's bare exception. Mapped to 403 `admin_proposal_role_mismatch`. */
export class AdminProposalRoleMismatchError extends Error {
  readonly code = 'admin_proposal_role_mismatch' as const;
  constructor() {
    super(
      "your administrator's stored platform role is not admin, though NEXTTIME_PLATFORM_ADMINS makes them one: the two differ, and an admin proposal goes by the stricter — nothing was proposed. Ask a platform administrator to set the stored role to admin first.",
    );
    this.name = 'AdminProposalRoleMismatchError';
  }
}

/** A problem with what a proposal holds, by where in it (`segments[1].items[0].skill.name`). */
export interface AdminProposalProblem {
  readonly path: string;
  readonly message: string;
}

/** A proposal that would not apply as written: a target named twice, an item target named twice
 *  in a segment, content that would not publish, a source name a shipped pack has. Mapped to 400
 *  `invalid_params` with `details.problems` (each a path and why — never a value from the content);
 *  nothing was written. */
export class AdminProposalInvalidError extends Error {
  readonly problems: readonly AdminProposalProblem[];
  constructor(problems: readonly AdminProposalProblem[]) {
    super(
      `the admin proposal cannot be made as written — ${problems.map((p) => `${p.path}: ${p.message}`).join('; ')}. Nothing was proposed.`,
    );
    this.name = 'AdminProposalInvalidError';
    this.problems = problems;
  }
}

/** No proposal by that id the caller may read: on the agent's side, any proposal but one its own
 *  administrator proposed in this trial workspace (F12). Mapped to 404 `admin_proposal_not_found`. */
export class AdminProposalNotFoundError extends Error {
  readonly code = 'admin_proposal_not_found' as const;
  constructor(proposalId: string) {
    super(`admin proposal ${proposalId} not found`);
    this.name = 'AdminProposalNotFoundError';
  }
}

/** Withdrawing a proposal with no segment still proposed. Mapped to 409 `admin_proposal_not_open`;
 *  nothing was written. */
export class AdminProposalNotOpenError extends Error {
  readonly code = 'admin_proposal_not_open' as const;
  constructor(proposalId: string) {
    super(
      `admin proposal ${proposalId} has no segment still proposed — each was applied, rejected or withdrawn already, or its workspace is gone; nothing was withdrawn`,
    );
    this.name = 'AdminProposalNotOpenError';
  }
}

// -------------------------------------------------------------------------------------------
// Checking a proposal (pure)
// -------------------------------------------------------------------------------------------

export interface AdminProposalInput {
  readonly title: string;
  readonly description?: string;
  readonly sourceName: string;
  readonly segments: readonly AdminProposalSegmentInputWire[];
  /** S11 AA3c: the platform segment — new gate-host instances a platform administrator applies on
   *  the platform plane, which every workspace segment then depends on. */
  readonly platform?: AdminProposalPlatformSegmentInputWire;
}

/** A workspace segment as it is stored: `propose_admin_proposal`'s intents, or (S11 AA5g-2) one
 *  `pack_install` (`propose_pack_install`). */
export interface StoredWorkspaceSegment {
  readonly targetWorkspaceId: string;
  readonly items: readonly AdminProposalWorkspaceItemWire[];
  /** S11 AA5g-2: a pack install segment's stored content digest — the digest of the pack version it
   *  asks for. Absent for a segment of intents, whose digest is {@link adminProposalSegmentDigest}. */
  readonly contentDigest?: string;
}

/** What {@link checkAdminProposal} returns: the segments as they will be stored. */
export interface CheckedAdminProposal {
  readonly segments: readonly StoredWorkspaceSegment[];
  readonly platform: AdminProposalPlatformSegmentInputWire | null;
}

/** The target an item changes in a workspace, as a key (two items for one target in a segment are
 *  refused: the second would overwrite what the first proposes). */
function itemTargetKey(item: AdminProposalItemIntentWire): string | null {
  switch (item.kind) {
    case 'skill_version':
      return `skill:${item.skill.name}`;
    case 'worker_definition_version': {
      const name = item.definition.name;
      return typeof name === 'string' ? `worker:${name}` : null;
    }
    case 'ontology_version':
      return `ontology:${item.family}`;
    case 'operation_version':
      return `operation:${item.gateId}\n${item.name}`;
  }
}

/** The fields of a Worker that are its workspace's own: a proposal never sets them, as a pack never
 *  ships them (application/packs `WORKSPACE_OWNED_WORKER_FIELDS`; not imported — packs installs
 *  through this module). */
const WORKSPACE_OWNED_WORKER_FIELDS = ['gates', 'model'] as const;

/** One item's content as publishing it would check it, and the item as stored (a Worker's
 *  definition parsed, so normalized like a pack's). */
function checkItem(
  item: AdminProposalItemIntentWire,
  at: string,
  problems: AdminProposalProblem[],
): AdminProposalItemIntentWire {
  if (item.kind === 'skill_version') {
    try {
      validateSkillContent(item.skill);
    } catch (err) {
      problems.push({ path: `${at}.skill`, message: (err as Error).message });
    }
    return item;
  }
  if (item.kind === 'worker_definition_version') {
    const owned = WORKSPACE_OWNED_WORKER_FIELDS.filter((field) => field in item.definition);
    for (const field of owned) {
      problems.push({
        path: `${at}.definition.${field}`,
        message: `a proposal never sets a Worker's ${field}: the workspace that applies it keeps its own`,
      });
    }
    if (typeof item.definition.name !== 'string' || item.definition.name.length === 0) {
      problems.push({
        path: `${at}.definition.name`,
        message:
          'a Worker in a proposal is named: its name is how each workspace finds its own version',
      });
    }
    const parsed = workerDefinitionContentSchemaFor('worker').safeParse(item.definition);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const where = issue.path.map(String).join('.');
        problems.push({
          path: where === '' ? `${at}.definition` : `${at}.definition.${where}`,
          message: issue.message,
        });
      }
      return item;
    }
    return {
      kind: item.kind,
      definition: parsed.data as Record<string, unknown>,
      ...(item.systems !== undefined ? { systems: [...item.systems] } : {}),
    };
  }
  return item;
}

/**
 * Everything about a proposal that needs no database: credentials and the redaction mark first
 * (their errors name places only), then the proposal's shape. Returns the segments as they will be
 * stored. `shippedPackNames`: the packs this deployment ships (the gateway reads the registry), a
 * name the proposal's own Skills and Workers must not be derived under.
 */
export function checkAdminProposal(
  input: AdminProposalInput,
  shippedPackNames: ReadonlySet<string>,
): CheckedAdminProposal {
  const credentials = findCredentialValues(input);
  if (credentials.count > 0) {
    throw new AdminProposalCredentialError(credentials.count, credentials.paths);
  }
  // AA3c: a gate instance's address is held to `create_gate_instance`'s rule (a URL's user name,
  // password, query or fragment, and anything else that could carry a credential), which is
  // stricter than the value patterns above — the address is sent to the gate host and shown to
  // every enabling workspace.
  for (const [i, item] of (input.platform?.items ?? []).entries()) {
    const found = findConnectionParamsCredential({
      target: item.target,
      manifestSource: item.manifestSource ?? null,
    });
    if (found !== null) {
      throw new AdminProposalCredentialError(1, [`platform.items[${i}].${found.field}`]);
    }
  }
  // Spelled from the document's name, as a goal proposal's are (`RedactedTextSubmittedError` names
  // the document by the first segment of `field`).
  const redacted = redactedPathsIn(input).map((path) => `proposal.${path}`);
  if (redacted.length > 0) throw new RedactedTextSubmittedError(redacted[0] as string, redacted);

  const problems: AdminProposalProblem[] = [];
  if (shippedPackNames.has(input.sourceName)) {
    problems.push({
      path: 'sourceName',
      message:
        'is the name of a pack this deployment ships: a proposal names its Skills and Workers under a name of its own',
    });
  }
  const targets = new Map<string, number>();
  const segments = input.segments.map((segment, s) => {
    const first = targets.get(segment.targetWorkspaceId);
    if (first !== undefined) {
      problems.push({
        path: `segments[${s}].targetWorkspaceId`,
        message: `names the workspace segments[${first}] does: one segment per workspace`,
      });
    } else {
      targets.set(segment.targetWorkspaceId, s);
    }
    const itemTargets = new Map<string, number>();
    const items = segment.items.map((item, i) => {
      const at = `segments[${s}].items[${i}]`;
      const key = itemTargetKey(item);
      const earlier = key === null ? undefined : itemTargets.get(key);
      if (key !== null && earlier !== undefined) {
        problems.push({
          path: at,
          message: `changes what items[${earlier}] of the same segment changes: one item per target`,
        });
      } else if (key !== null) {
        itemTargets.set(key, i);
      }
      return checkItem(item, at, problems);
    });
    return { targetWorkspaceId: segment.targetWorkspaceId, items };
  });
  const platform =
    input.platform === undefined ? null : checkPlatformSegment(input.platform, problems);
  if (problems.length > 0) throw new AdminProposalInvalidError(problems);
  return { segments, platform };
}

/** A platform segment's items as they will be stored: one instance per gate id (the second would
 *  be refused `gate_id_taken` by the first when applied). Whether each fits the platform now is
 *  the dry run's (`platform-segments.ts`), when an administrator previews it. */
function checkPlatformSegment(
  platform: AdminProposalPlatformSegmentInputWire,
  problems: AdminProposalProblem[],
): AdminProposalPlatformSegmentInputWire {
  const gateIds = new Map<string, number>();
  for (const [i, item] of platform.items.entries()) {
    const earlier = gateIds.get(item.gateId);
    if (earlier !== undefined) {
      problems.push({
        path: `platform.items[${i}].gateId`,
        message: `names the gate instance platform.items[${earlier}] does: one item per gate id`,
      });
    } else {
      gateIds.set(item.gateId, i);
    }
  }
  return { items: platform.items };
}

/** S11 AA5g-2: `propose_pack_install`'s params (already bounded by the capability). */
export interface PackInstallProposalInput {
  readonly pack: string;
  readonly version: number;
  readonly targetWorkspaceIds: readonly string[];
  readonly title: string;
  readonly description?: string;
}

/** What {@link checkPackInstallProposal} is told of a pack this deployment has: its name, its
 *  latest version and that version's digest (the gateway reads the registry; this module never
 *  does). */
export interface PackOnOffer {
  readonly name: string;
  readonly latestVersion: number;
  /** `PackVersion.digest` of the latest version: the source digest of every install of it. */
  readonly latestDigest: string;
}

/**
 * S11 AA5g-2 (#484 on #1002, must-fix 1): the source name of every pack install proposal. A
 * proposal's source name is the namespace its new Skills and Workers are derived under (0032), and
 * one asking for a pack install derives none — so it never names the pack (that lives in its one
 * `pack_install` item), and never a pack this deployment ships either: `checkAdminProposal`'s rule
 * holds for it as for any proposal.
 */
export const PACK_INSTALL_PROPOSAL_SOURCE_NAME = 'pack-install';

/**
 * S11 AA5g-2 (docs/admin-agent-packs-design-2026-11-06.md D2): `propose_pack_install` as the
 * proposal it writes — `sourceName` the pack, one workspace segment per target, each holding one
 * `pack_install` (governance 0040: alone in its segment) — checked as {@link checkAdminProposal}
 * checks the rest (credentials and the redaction mark in the free text first, naming places only).
 * Refused with {@link AdminProposalInvalidError} for a target named twice, a pack this deployment
 * does not have, or a version that is not its latest now: the owner installs the latest version
 * only (`install_pack`), so a proposal for another could never be installed.
 */
export function checkPackInstallProposal(
  input: PackInstallProposalInput,
  offered: PackOnOffer | null,
  shippedPackNames: ReadonlySet<string>,
): { readonly proposal: AdminProposalInput; readonly checked: CheckedAdminProposal } {
  const text = { title: input.title, description: input.description };
  const credentials = findCredentialValues(text);
  if (credentials.count > 0) {
    throw new AdminProposalCredentialError(credentials.count, credentials.paths);
  }
  const redacted = redactedPathsIn(text).map((path) => `proposal.${path}`);
  if (redacted.length > 0) throw new RedactedTextSubmittedError(redacted[0] as string, redacted);

  const problems: AdminProposalProblem[] = [];
  if (shippedPackNames.has(PACK_INSTALL_PROPOSAL_SOURCE_NAME)) {
    problems.push({
      path: 'pack',
      message: `this deployment ships a pack named "${PACK_INSTALL_PROPOSAL_SOURCE_NAME}", the source name pack install proposals are kept under: ask a platform administrator`,
    });
  }
  if (offered === null) {
    problems.push({
      path: 'pack',
      message: `this deployment has no pack named "${input.pack}": agent_list_packs lists those it has`,
    });
  } else if (offered.latestVersion !== input.version) {
    problems.push({
      path: 'version',
      message: `pack ${offered.name}'s latest version is ${offered.latestVersion}: an owner installs only the latest, so propose that one`,
    });
  }
  const seen = new Map<string, number>();
  for (const [i, id] of input.targetWorkspaceIds.entries()) {
    const first = seen.get(id);
    if (first !== undefined) {
      problems.push({
        path: `targetWorkspaceIds[${i}]`,
        message: `names the workspace targetWorkspaceIds[${first}] does: one segment per workspace`,
      });
    } else {
      seen.set(id, i);
    }
  }
  if (problems.length > 0) throw new AdminProposalInvalidError(problems);
  // #484 on #1002, must-fix 2: each segment's content digest is the digest of the pack version it
  // asks for, so an install of the same version number with other content (an extra pack replaced
  // in place) does not answer it (governance 0040 compares it with the install's source digest).
  const packDigest = (offered as PackOnOffer).latestDigest;
  const segments: StoredWorkspaceSegment[] = input.targetWorkspaceIds.map((id) => ({
    targetWorkspaceId: id,
    items: [{ kind: 'pack_install', pack: input.pack, version: input.version }],
    contentDigest: packDigest,
  }));
  return {
    proposal: {
      title: input.title,
      ...(input.description !== undefined ? { description: input.description } : {}),
      sourceName: PACK_INSTALL_PROPOSAL_SOURCE_NAME,
      segments: [],
    },
    checked: { segments, platform: null },
  };
}

/** `sha256:` of what a segment proposes: its target and its items. A pack install segment's own
 *  digest is the pack version's ({@link StoredWorkspaceSegment.contentDigest}); this is what the
 *  proposal's digest lists for it either way, so its target is in that digest too. */
export function adminProposalSegmentDigest(segment: StoredWorkspaceSegment): string {
  return contentDigest({ targetWorkspaceId: segment.targetWorkspaceId, items: segment.items });
}

/** `sha256:` of what a platform segment proposes: no target, and its items. */
export function adminProposalPlatformSegmentDigest(
  segment: AdminProposalPlatformSegmentInputWire,
): string {
  return contentDigest({ targetWorkspaceId: null, items: segment.items });
}

/** `sha256:` of what a proposal holds: its title, description, source name and each segment's
 *  digest, in order. */
export function adminProposalDigest(input: {
  readonly title: string;
  readonly description: string;
  readonly sourceName: string;
  readonly segmentDigests: readonly string[];
}): string {
  return contentDigest({
    title: input.title,
    description: input.description,
    sourceName: input.sourceName,
    segments: input.segmentDigests,
  });
}

/** The next 00:00 UTC after `now`, when F11's count starts again. */
export function adminProposalQuotaResetsAt(now: Date): string {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
  ).toISOString();
}

// -------------------------------------------------------------------------------------------
// Propose (the trial workspace, an admin agent's call)
// -------------------------------------------------------------------------------------------

/** Who proposes: the admin agent's session, and its administrator — their Principal in the trial
 *  workspace (the Handle's `obo`) and their platform user. */
export interface AdminProposalProposer {
  readonly workspaceId: string;
  readonly principalId: string;
  readonly userId: string;
  readonly sessionId: string;
}

/** The connector a platform segment's `gate_instance` item puts its instance under: its preset's
 *  (a preset is its connector, `hosted-plan.ts`), the one it names, or the generic one of its
 *  transport (`null` here: never a system a Worker names). Also which blocker of a workspace
 *  segment waits on the platform segment (`admin-proposal-segments.ts`, `fromPlatformSegment`). */
export function platformItemConnector(
  item: AdminProposalPlatformSegmentInputWire['items'][number],
): string | null {
  return item.preset ?? item.connector ?? null;
}

/**
 * S11 AA5f: each Worker's `systems` that is neither a connector the platform has (`connectors` is
 * readable by every transaction, core 0023) nor one the proposal's own platform segment creates —
 * one problem per such name, by where it stands. A Worker may name a system its proposal brings
 * (its platform segment is applied before any workspace segment), as the agent connected it in its
 * trial workspace; a name nothing will ever carry would leave every target's owner unable to bind
 * it.
 */
async function unknownWorkerSystems(
  client: PoolClient,
  segments: readonly StoredWorkspaceSegment[],
  platform: AdminProposalPlatformSegmentInputWire | null,
): Promise<AdminProposalProblem[]> {
  const named = segments.flatMap((segment, s) =>
    segment.items.flatMap((item, i) =>
      item.kind === 'worker_definition_version'
        ? (item.systems ?? []).map((system, j) => ({
            system,
            path: `segments[${s}].items[${i}].systems[${j}]`,
          }))
        : [],
    ),
  );
  if (named.length === 0) return [];
  const result = await client.query<{ name: string }>(
    'select name from connectors where name = any($1::text[])',
    [[...new Set(named.map((entry) => entry.system))]],
  );
  const known = new Set(result.rows.map((row) => row.name));
  for (const item of platform?.items ?? []) {
    const connector = platformItemConnector(item);
    if (connector !== null) known.add(connector);
  }
  return named
    .filter((entry) => !known.has(entry.system))
    .map((entry) => ({
      path: entry.path,
      message: `"${entry.system}" is no connector the platform has, nor one this proposal's platform segment creates: name the connector of the gate you reach the system through`,
    }));
}

/** F10: the first segment whose target cannot take a proposal, or none. One read of each, the same
 *  answer for unknown, disabled and trial (`workspaces` is readable by every transaction, core
 *  0001). */
async function firstUnavailableTarget(
  client: PoolClient,
  segments: readonly StoredWorkspaceSegment[],
): Promise<number | undefined> {
  const ids = segments.map((segment) => segment.targetWorkspaceId);
  const result = await client.query<{ id: string }>(
    `select id from workspaces
      where id = any($1::uuid[]) and status = 'active' and purpose <> 'admin_trial'`,
    [ids],
  );
  const available = new Set(result.rows.map((row) => row.id));
  const index = ids.findIndex((id) => !available.has(id));
  return index === -1 ? undefined : index;
}

/** S11 AA4c (F5, D2): the first segment whose target the administrator has not chosen for their
 *  admin agent here, or none. `admin_agent_chosen_targets()` (governance 0036) answers for the
 *  transaction's own Principal in this trial workspace only. */
async function firstTargetNotChosen(
  client: PoolClient,
  segments: readonly StoredWorkspaceSegment[],
): Promise<number | undefined> {
  if (segments.length === 0) return undefined;
  const result = await client.query<{ id: string }>('select admin_agent_chosen_targets() as id');
  const chosen = new Set(result.rows.map((row) => row.id));
  const index = segments.findIndex((segment) => !chosen.has(segment.targetWorkspaceId));
  return index === -1 ? undefined : index;
}

/**
 * Makes a proposal in the trial workspace `proposer.workspaceId`, in the caller's transaction (the
 * dispatcher's, which then writes the call's audit row). `segments` are
 * {@link checkAdminProposal}'s. The order of the database checks: F11's count under the
 * administrator's lock, then the targets — chosen (S11 AA4c), then available, then not closed by
 * repeated rejections (F6, S11 AA5a-2) — so a refused proposal never counts, and two at the limit
 * cannot both pass. Each workspace segment keeps the
 * target it names: changing the targets afterwards does not move a proposal made before.
 */
export async function proposeAdminProposal(
  client: PoolClient,
  proposer: AdminProposalProposer,
  input: AdminProposalInput,
  checked: CheckedAdminProposal,
): Promise<AgentAdminProposalWire> {
  const { segments, platform } = checked;
  // The user is a member here, so the workspace transaction reads the row (core 0021).
  const user = await client.query<{ display_name: string; platform_role: string }>(
    'select display_name, platform_role from users where id = $1',
    [proposer.userId],
  );
  if (user.rows[0]?.platform_role !== 'admin') throw new AdminProposalRoleMismatchError();
  await client.query('select pg_advisory_xact_lock($1, hashtext($2::text))', [
    ADVISORY_LOCK_NAMESPACES.adminProposalQuota,
    proposer.userId,
  ]);
  const today = await client.query<{ count: number }>(
    'select admin_proposals_proposed_today() as count',
  );
  if ((today.rows[0]?.count ?? 0) >= ADMIN_PROPOSAL_DAILY_LIMIT) {
    throw new AdminProposalQuotaExceededError(adminProposalQuotaResetsAt(new Date()));
  }
  const notChosen = await firstTargetNotChosen(client, segments);
  if (notChosen !== undefined) throw new AdminProposalTargetNotChosenError(notChosen);
  const unavailable = await firstUnavailableTarget(client, segments);
  if (unavailable !== undefined) throw new AdminProposalTargetUnavailableError(unavailable);
  // F6 (S11 AA5a-2): a target that keeps rejecting this administrator's proposals is closed to them
  // for a while — read under the same lock, from the rejections already committed.
  await assertTargetsNotRejectedRepeatedly(
    client,
    segments.map((segment) => segment.targetWorkspaceId),
  );
  // AA5f: what a Worker names as its systems is bound to those systems' gates where it is applied.
  const unknownSystems = await unknownWorkerSystems(client, segments, platform);
  if (unknownSystems.length > 0) throw new AdminProposalInvalidError(unknownSystems);

  const displayName = (user.rows[0]?.display_name ?? '').slice(0, 200) || proposer.userId;
  const description = input.description ?? '';
  // The platform segment comes last (its ordinal after every workspace segment's), so the
  // proposal's digest lists the segments in the order they are read.
  const platformDigest = platform === null ? null : adminProposalPlatformSegmentDigest(platform);
  const segmentDigests = [
    ...segments.map(adminProposalSegmentDigest),
    ...(platformDigest === null ? [] : [platformDigest]),
  ];
  const digest = adminProposalDigest({
    title: input.title,
    description,
    sourceName: input.sourceName,
    segmentDigests,
  });
  const proposal = await client.query<{ id: string }>(
    `insert into admin_proposals
       (workspace_id, proposed_by, proposed_by_user, proposer_display_name, session_id, origin,
        title, description, source_name, content_digest)
     values ($1, $2, $3, $4, $5, 'agent', $6, $7, $8, $9)
     returning id`,
    [
      proposer.workspaceId,
      proposer.principalId,
      proposer.userId,
      displayName,
      proposer.sessionId,
      input.title,
      description,
      input.sourceName,
      digest,
    ],
  );
  const proposalId = proposal.rows[0]?.id;
  if (proposalId === undefined) throw new Error('proposeAdminProposal: the insert returned no row');
  for (const [index, segment] of segments.entries()) {
    await client.query(
      `insert into admin_proposal_segments
         (workspace_id, proposal_id, ordinal, authority, target_workspace_id, items, content_digest)
       values ($1, $2, $3, 'workspace', $4, $5::jsonb, $6)`,
      [
        proposer.workspaceId,
        proposalId,
        index + 1,
        segment.targetWorkspaceId,
        JSON.stringify(segment.items),
        segment.contentDigest ?? segmentDigests[index],
      ],
    );
  }
  if (platform !== null) {
    await client.query(
      `insert into admin_proposal_segments
         (workspace_id, proposal_id, ordinal, authority, target_workspace_id, items, content_digest)
       values ($1, $2, $3, 'platform', null, $4::jsonb, $5)`,
      [
        proposer.workspaceId,
        proposalId,
        segments.length + 1,
        JSON.stringify(platform.items),
        platformDigest,
      ],
    );
  }
  const read = await readAdminProposal(client, proposalId, {
    workspaceId: proposer.workspaceId,
    reader: 'agent',
  });
  if (read === null)
    throw new Error(`proposeAdminProposal: proposal ${proposalId} not readable after insert`);
  return agentProposalOf(read);
}

// -------------------------------------------------------------------------------------------
// Reads
// -------------------------------------------------------------------------------------------

/** Which proposals a read sees, and who reads them. The agent: its administrator's
 *  (`proposedByUser`) in its trial workspace (F12) — RLS already keeps it to the workspace's own.
 *  The platform plane: any. */
export interface AdminProposalScope {
  readonly workspaceId?: string;
  readonly proposedByUser?: string;
  /** What a target workspace's owner writes stays with them and the platform's people (coordinator
   *  2026-11-02, as for what their dry run finds): the agent reads that a segment was rejected,
   *  never why — a rejected segment's `reason` is `null` for `agent`. A withdrawal's reason is the
   *  administrator's own, and the agent reads it. */
  readonly reader: 'agent' | 'platform';
}

interface ProposalRow {
  id: string;
  title: string;
  description: string;
  source_name: string;
  origin: string;
  proposed_by_user: string;
  proposer_display_name: string;
  content_digest: string;
  created_at: Date;
  proposed: number;
  applied: number;
  rejected: number;
  withdrawn: number;
  rolled_back: number;
  platform_status: AdminProposalSegmentStatus | null;
}

interface SegmentRow {
  id: string;
  ordinal: number;
  authority: string;
  target_workspace_id: string | null;
  items: AdminProposalAnyItemIntentWire[];
  content_digest: string;
  status: AdminProposalSegmentStatus;
  decided_at: Date | null;
  withdrawn_origin: 'human' | 'agent' | 'platform_segment' | null;
  reason: string | null;
  rolled_back_at: Date | null;
}

/** The proposal status `adminProposalStatusOf` derives, written in SQL over the counts below — for the
 *  list's `status` filter, which must narrow before the limit. The integration tests read each
 *  status back through the wire, which derives it with `adminProposalStatusOf` itself. */
const PLAN_STATUS_SQL = `case
    when c.applied > 0 and c.applied = c.total then 'applied'
    when c.applied > 0 then 'partially_applied'
    when c.proposed > 0 then 'proposed'
    else 'closed'
  end`;

const PLAN_SELECT = `
  select p.id, p.title, p.description, p.source_name, p.origin, p.proposed_by_user,
         p.proposer_display_name, p.content_digest, p.created_at,
         c.proposed, c.applied, c.rejected, c.withdrawn, c.rolled_back, c.platform_status
    from admin_proposals p
    cross join lateral (
      select count(s.id)::int as total,
             (count(*) filter (where s.status = 'proposed'))::int as proposed,
             (count(*) filter (where s.status = 'applied'))::int as applied,
             (count(*) filter (where s.status = 'rejected'))::int as rejected,
             (count(*) filter (where s.status = 'withdrawn'))::int as withdrawn,
             (count(*) filter (where s.status = 'rolled_back'))::int as rolled_back,
             -- Legacy 619: a proposal has at most one platform segment
             -- (admin_proposal_segments_one_platform), so max() is its status, or null.
             (max(s.status::text) filter (where s.authority = 'platform')) as platform_status
        from admin_proposal_segments s
       where s.workspace_id = p.workspace_id and s.proposal_id = p.id
    ) c`;

function scopeFilter(scope: AdminProposalScope, values: unknown[]): string {
  const where: string[] = [];
  if (scope.workspaceId !== undefined) {
    values.push(scope.workspaceId);
    where.push(`p.workspace_id = $${values.length}`);
  }
  if (scope.proposedByUser !== undefined) {
    values.push(scope.proposedByUser);
    where.push(`p.proposed_by_user = $${values.length}`);
  }
  return where.join(' and ');
}

function statusesOf(row: ProposalRow): AdminProposalSegmentStatus[] {
  return [
    ...Array<AdminProposalSegmentStatus>(row.proposed).fill('proposed'),
    ...Array<AdminProposalSegmentStatus>(row.applied).fill('applied'),
    ...Array<AdminProposalSegmentStatus>(row.rejected).fill('rejected'),
    ...Array<AdminProposalSegmentStatus>(row.withdrawn).fill('withdrawn'),
    ...Array<AdminProposalSegmentStatus>(row.rolled_back).fill('rolled_back'),
  ];
}

function summaryOf(row: ProposalRow): AdminProposalSummaryWire {
  return {
    id: row.id,
    // Legacy 420: free text reads as every read shows it (AA3b-2 brought the target's reads in line).
    title: shownFreeText(row.title),
    sourceName: row.source_name,
    origin: row.origin as AdminProposalSummaryWire['origin'],
    proposedBy: { userId: row.proposed_by_user, displayName: row.proposer_display_name },
    proposedAt: row.created_at.toISOString(),
    status: adminProposalStatusOf(statusesOf(row)),
    segmentCounts: {
      proposed: row.proposed,
      applied: row.applied,
      rejected: row.rejected,
      withdrawn: row.withdrawn,
      rolledBack: row.rolled_back,
    },
    platformSegmentStatus: row.platform_status,
  };
}

function segmentOf(
  row: SegmentRow,
  reader: AdminProposalScope['reader'],
): AdminProposalSegmentWire {
  return {
    id: row.id,
    ordinal: row.ordinal,
    authority: row.authority as AdminProposalSegmentWire['authority'],
    targetWorkspaceId: row.target_workspace_id,
    items: row.items,
    contentDigest: row.content_digest,
    status: row.status,
    decidedAt: row.decided_at?.toISOString() ?? null,
    withdrawnOrigin: row.withdrawn_origin,
    reason: row.status === 'rejected' && reader === 'agent' ? null : shownFreeText(row.reason),
    rolledBackAt: row.rolled_back_at?.toISOString() ?? null,
  };
}

/** What `list_admin_proposals` narrows to; both together when both are given. */
export interface AdminProposalListFilter {
  /** One derived proposal status. */
  readonly status?: AdminProposalStatus;
  /** Legacy 619: the proposals whose platform segment is in this status (`proposed`: awaiting a
   *  platform administrator). */
  readonly platformSegmentStatus?: AdminProposalSegmentStatus;
}

/** The proposals `scope` sees, newest first, at most {@link ADMIN_PROPOSAL_LIST_LIMIT} (`truncated` when
 *  there are more), narrowed by `filter` before the limit. */
export async function listAdminProposals(
  client: PoolClient,
  scope: AdminProposalScope,
  filter: AdminProposalListFilter = {},
): Promise<ListEnvelope<AdminProposalSummaryWire>> {
  const values: unknown[] = [];
  const conditions = [scopeFilter(scope, values)].filter((condition) => condition !== '');
  if (filter.status !== undefined) {
    values.push(filter.status);
    conditions.push(`${PLAN_STATUS_SQL} = $${values.length}`);
  }
  if (filter.platformSegmentStatus !== undefined) {
    values.push(filter.platformSegmentStatus);
    conditions.push(`c.platform_status = $${values.length}`);
  }
  values.push(ADMIN_PROPOSAL_LIST_LIMIT + 1);
  const result = await client.query<ProposalRow>(
    `${PLAN_SELECT}
     ${conditions.length > 0 ? `where ${conditions.join(' and ')}` : ''}
     order by p.created_at desc, p.id
     limit $${values.length}`,
    values,
  );
  const items = result.rows.slice(0, ADMIN_PROPOSAL_LIST_LIMIT).map(summaryOf);
  return result.rows.length > ADMIN_PROPOSAL_LIST_LIMIT ? { items, truncated: true } : { items };
}

/** One proposal with its segments in order, or `null` when `scope` does not see it. */
export async function readAdminProposal(
  client: PoolClient,
  proposalId: string,
  scope: AdminProposalScope,
): Promise<AdminProposalWire | null> {
  const values: unknown[] = [proposalId];
  const filter = scopeFilter(scope, values);
  const proposal = await client.query<ProposalRow>(
    `${PLAN_SELECT} where p.id = $1${filter === '' ? '' : ` and ${filter}`}`,
    values,
  );
  const row = proposal.rows[0];
  if (row === undefined) return null;
  const segments = await client.query<SegmentRow>(
    `select id, ordinal, authority, target_workspace_id, items, content_digest, status,
            decided_at, withdrawn_origin, reason, rolled_back_at
       from admin_proposal_segments
      where proposal_id = $1
      order by ordinal`,
    [proposalId],
  );
  return {
    ...summaryOf(row),
    description: shownFreeText(row.description),
    contentDigest: row.content_digest,
    segments: segments.rows.map((row) => segmentOf(row, scope.reader)),
  };
}

/**
 * `proposal` as the agent that proposed it reads it (AA4-0, coordinator 2026-11-02): each of the
 * platform segment's `gate_instance` items without `target` and `manifestSource`, marked
 * `addressWithheld` — people read the addresses (the target workspace's owner and platform
 * administrators), the agent never does, not even those it typed. Every read on the agent's side
 * goes through here: `propose_admin_proposal`'s result, `agent_get_admin_proposal` and
 * `agent_withdraw_admin_proposal` (their `resultSchema`, `AgentAdminProposalWireSchema`, refuses an
 * item that still carries either under `KERNEL_VALIDATE_RESULTS`).
 *
 * The item is built field by field, never spread (#933 review R-1, as `platform-state.ts` builds
 * every agent projection): production does not validate results, so a field later added to the
 * `gate_instance` intent — another address among them — reaches the agent only once it is named
 * here.
 */
export function agentProposalOf(proposal: AdminProposalWire): AgentAdminProposalWire {
  return {
    ...proposal,
    segments: proposal.segments.map((segment) => ({
      ...segment,
      items: segment.items.map((item) =>
        item.kind === 'gate_instance' ? withheldGateInstanceOf(item) : item,
      ),
    })),
  };
}

/** A `gate_instance` item without its addresses: the fields the agent may read, each named. */
function withheldGateInstanceOf(
  item: Extract<AdminProposalAnyItemIntentWire, { kind: 'gate_instance' }>,
): AdminProposalWithheldGateInstanceWire {
  return {
    kind: 'gate_instance',
    gateId: item.gateId,
    ...(item.displayName !== undefined ? { displayName: item.displayName } : {}),
    ...(item.preset !== undefined ? { preset: item.preset } : {}),
    ...(item.transportKind !== undefined ? { transportKind: item.transportKind } : {}),
    ...(item.credentialMode !== undefined ? { credentialMode: item.credentialMode } : {}),
    ...(item.connector !== undefined ? { connector: item.connector } : {}),
    addressWithheld: true,
  };
}

/** {@link readAdminProposal}, or {@link AdminProposalNotFoundError}. */
export async function getAdminProposal(
  client: PoolClient,
  proposalId: string,
  scope: AdminProposalScope,
): Promise<AdminProposalWire> {
  const proposal = await readAdminProposal(client, proposalId, scope);
  if (proposal === null) throw new AdminProposalNotFoundError(proposalId);
  return proposal;
}

// -------------------------------------------------------------------------------------------
// Withdraw
// -------------------------------------------------------------------------------------------

/**
 * Withdraws every segment of `proposalId` still proposed, as `userId` — the administrator through their
 * agent (in the trial workspace, `scope` their own proposals) or a platform administrator on the
 * platform plane. The guard derives the channel (`withdrawn_origin`) from where the transaction
 * runs and stamps the time. Segments already decided keep their status; with none left proposed,
 * {@link AdminProposalNotOpenError}. Returns the proposal as it now reads.
 */
export async function withdrawAdminProposal(
  client: PoolClient,
  proposalId: string,
  scope: AdminProposalScope,
  userId: string,
  reason: string | undefined,
): Promise<AdminProposalWire> {
  // #916 review P3-2: the reason reaches every workspace the proposal is addressed to (F4's
  // segment read), so it is checked as the proposal was (F9), before anything is read.
  if (reason !== undefined) {
    const credentials = findCredentialValues({ reason });
    if (credentials.count > 0) {
      throw new AdminProposalCredentialError(credentials.count, credentials.paths, 'withdrawal');
    }
    const redacted = redactedPathsIn({ reason }).map((path) => `withdrawal.${path}`);
    if (redacted.length > 0) throw new RedactedTextSubmittedError(redacted[0] as string, redacted);
  }
  // Read in scope first, and keep it: without it another administrator's proposal in the same
  // trial workspace with nothing left open would answer 409 instead of 404 — whether it exists
  // would show (#916 review, note 2).
  await getAdminProposal(client, proposalId, scope);
  // Each open segment under its row lock, so a concurrent apply (AA3b-2) or withdrawal waits and
  // then sees the status this one leaves.
  const open = await client.query<{ id: string }>(
    `select id from admin_proposal_segments
      where proposal_id = $1 and status = 'proposed'
      order by ordinal
      for update`,
    [proposalId],
  );
  if (open.rows.length === 0) throw new AdminProposalNotOpenError(proposalId);
  await client.query(
    `update admin_proposal_segments
        set status = 'withdrawn', withdrawn_by_user = $2, reason = $3
      where id = any($1::uuid[]) and status = 'proposed'`,
    [open.rows.map((row) => row.id), userId, reason ?? null],
  );
  return getAdminProposal(client, proposalId, scope);
}
