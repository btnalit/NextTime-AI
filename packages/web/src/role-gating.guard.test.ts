import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CAPABILITY_REGISTRY,
  ROLE_VALUES,
  capabilityHasSideEffects,
  getCapability,
  roleMayUseCapability,
} from '@nexttime/shared';
import { describe, expect, it } from 'vitest';
import { ROUTE_REQUIRES, routeRequirement } from './lib/route-access.js';
import { hrefs } from './lib/router.js';

/**
 * #541 review M1/M3/N1/N2 guard: what a reader's role may do is decided by the kernel's own predicate
 * (`useRoleCan` → `roleMayUseCapability`), never by "it was refused once already"
 * (`permissions.isDenied`, which shows the control until the first refusal), and every
 * capability name the console checks or calls is one the registry knows. Where a route leads is
 * decided by the route table (`lib/route-access`), never by "only X ever reaches this link".
 */

const SRC = fileURLToPath(new URL('.', import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

const FILES = sourceFiles(SRC).map((path) => ({
  path: relative(SRC, path).replaceAll('\\', '/'),
  text: readFileSync(path, 'utf8'),
}));

/** The places that may still decide on `isDenied`, each for a reason the role cannot express.
 *  Only ever shrinks: an entry that no longer matches fails the test until it is removed. */
const IS_DENIED_ALLOWED: Readonly<Record<string, string>> = {
  'components/AddMemberForm.tsx': '`list_users` is platform-scope: the channel decides, not a role',
  'components/chat/ModelSwitcher.tsx':
    '`set_agent_profile` is also refused by the workspace policy (`memberCanEditProfile`), past the role',
  'hooks/useRoleCan.ts': 'the fallback while the role is not known yet',
};

/** Files that make a write some role may not, without a `can('<name>')` of their own: each is
 *  only ever reached through an entry gated on the role elsewhere — where is the reason. Only
 *  ever shrinks, like `IS_DENIED_ALLOWED`. */
const WRITE_GATED_AT_ENTRY: Readonly<Record<string, string>> = {
  'components/AddMemberForm.tsx':
    "MembersPage's add-member button, behind canManage (create_principal)",
  'components/CreatePrincipalForm.tsx': "MembersPage's header menu, behind canManage",
  'components/PrincipalDetail.tsx':
    'MembersPage hands it canManage; the page needs list_principals',
  'components/members/IssueServiceHandleSection.tsx': "MembersPage's header menu, behind canManage",
  'components/OnboardingWizard.tsx': "SystemsPage's more-ways-to-connect menu, behind canCreate",
  'components/CompleteConnectionForm.tsx': "SystemsPage's complete / register, behind canCreate",
  'components/RequestConnectionForm.tsx':
    "SystemsPage's connect-a-system button, behind canRequest",
  'components/AgentPolicyForm.tsx': 'ModelsPage, owner only (isOwner)',
  'components/governance/QuotaEditSheet.tsx': 'ModelsPage, owner only (isOwner)',
  'components/governance/PolicyEditSheet.tsx': 'ModelsPage, owner only (isOwner)',
  'components/AgentProfileForm.tsx': "AgentProfilePage's editForbidden (role, then policy)",
  'components/AvailableGateInstancesSection.tsx':
    "SystemsPage's canEnterCredential / canEnable props",
  'components/connect/EnableGateConfirm.tsx': "SystemsPage's canEnable",
  'components/connect/RefreshOperationGovernanceConfirm.tsx': "SystemAccessCard's canManage",
  'components/account/IssueOwnHandleSection.tsx': "AccountPage's HandleCard, can('issue_handle')",
  'components/catalog/SkillEditor.tsx': 'CatalogPage opens it only with canPropose',
  'components/catalog/ProcedureEditor.tsx': 'CatalogPage opens it only with canPropose',
  'components/catalog/WorkerDefinitionEditor.tsx': 'CatalogPage opens it only with canPropose',
  'components/graph/SupersedeFactDialog.tsx': "FactRow's more-actions menu, can('supersede_fact')",
  'components/graph/AttestFactDialog.tsx': "FactRow's more-actions menu, can('attest_fact')",
  'components/systems/SystemsPage.tsx':
    'revoke via SystemAccessCard canRevoke (canManage); cancel inside the requests section (canRequest)',
  'components/systems/SystemAccessCard.tsx': 'SystemsPage hands it canPublish / canManage',
  'components/approvals/useApprovalQueue.ts':
    'the approvals route, which the route table gates on list_pending (the same roles)',
  'components/chat/useActionCards.ts': "ChatPage's canDecide / canAlwaysAllow",
};

/** Files that read something some role may not, without a `can('<name>')` of their own: each is
 *  only reached by the roles that may read it — where is the reason. Only ever shrinks. */
const READ_GATED_AT_ENTRY: Readonly<Record<string, string>> = {
  'components/ApprovalQueuePage.tsx':
    'the approvals route, gated on list_pending by the route table (list_action_requests: the same roles)',
  'components/approvals/useApprovalQueue.ts': 'the approvals route, as above',
  'components/MembersPage.tsx': 'the members route, gated on list_principals by the route table',
  'components/AuditPage.tsx':
    'the audit route, gated on audit_query by the route table (reconstruct: the same roles)',
  'components/audit/AuditLogSection.tsx': 'AuditPage, as above',
  'components/audit/ExplainSection.tsx': 'AuditPage, as above (export_prov: the same roles)',
  'components/audit/ApprovalContext.tsx':
    "AuditPage mounts it only when can('get_action') (an auditor gets a sentence instead)",
  'components/CompleteConnectionForm.tsx': "SystemsPage's complete / register, behind canCreate",
  'components/connect/EnableGateConfirm.tsx': "SystemsPage's canEnable",
  'components/connect/RefreshOperationGovernanceConfirm.tsx': "SystemAccessCard's canManage",
  'components/readiness/useExecutionReadiness.ts':
    'the hook itself: each file using it is checked as reading execution_readiness',
  'components/systems/useMemberReachability.ts':
    "SystemsPage passes the grantees of list_grants, read only with can('list_grants')",
};

/** Files that build an href to a route the table gates without asking the table (`RouteLink`,
 *  `useCanOpen`, `roleMayOpen`) — each for a reason the table cannot express. Only ever shrinks. */
const ROUTE_LINK_ALLOWED: Readonly<Record<string, string>> = {
  'lib/nav.ts': "the sidebar's items; Sidebar filters them with roleMayOpen",
  'lib/graph-route.ts': 'builds auditHrefForNode; its callers render it through the table',
  'lib/platform-workspaces.ts': 'builds the residue href for the platform pages',
  'components/platform/PlatformOverviewPage.tsx':
    'a platform page (requireAdmin): every platform route is open to its reader',
  'components/platform/PlatformModelsPage.tsx': 'a platform page, as above',
  'components/platform/PlatformSettingsPage.tsx': 'a platform page, as above',
  'components/platform/PlatformStatusPage.tsx': 'a platform page, as above',
  'session/useSessionMachine.ts':
    'lands a platform-only session (an administrator, no workspace) on the platform overview',
};

/** Every helper that builds an href to a route the table gates: the `hrefs` whose route has a
 *  requirement, plus the audit deep-link builders. */
const GATED_HREF_BUILDERS: readonly string[] = [
  ...Object.entries(hrefs)
    .filter(([, build]) => routeRequirement((build as (...args: string[]) => string)('x')))
    .map(([name]) => `hrefs.${name}(`),
  'auditHref(',
  'auditHrefForNode(',
  'resourceHref(',
];

/** Every write some workspace role may not make (`roleMayUseCapability`). */
const ROLE_LIMITED_WRITES: ReadonlySet<string> = new Set(
  CAPABILITY_REGISTRY.filter(
    (capability) =>
      capability.scope !== 'platform' &&
      capabilityHasSideEffects(capability) &&
      ROLE_VALUES.some((role) => !roleMayUseCapability(role, capability)),
  ).map((capability) => capability.name),
);

/** Every read some workspace role may not make. */
const ROLE_LIMITED_READS: ReadonlySet<string> = new Set(
  CAPABILITY_REGISTRY.filter(
    (capability) =>
      capability.scope !== 'platform' &&
      !capabilityHasSideEffects(capability) &&
      ROLE_VALUES.some((role) => !roleMayUseCapability(role, capability)),
  ).map((capability) => capability.name),
);

describe('role gating guard (#541 review M1/M3)', () => {
  it('every read some role may not make is held on the role where it is made', () => {
    const read =
      /\b(?:call(?:<[^>()]*>)?\(\s*|useCapability(?:List)?(?:<[^>()]*>)?\(\s*\w+,\s*)'([a-z][a-z0-9_]*)'/g;
    const readsOf = (text: string) => {
      const names = new Set([...text.matchAll(read)].map((match) => match[1] as string));
      // The readiness hook is the read, wherever it is used.
      if (/\buseExecutionReadiness\(/.test(text)) names.add('execution_readiness');
      return [...names].filter(
        (name) => ROLE_LIMITED_READS.has(name) && !text.includes(`can('${name}')`),
      );
    };
    const unheld = FILES.filter(({ path }) => !(path in READ_GATED_AT_ENTRY))
      .map(({ path, text }) => ({ path, names: readsOf(text) }))
      .filter(({ names }) => names.length > 0)
      .map(({ path, names }) => `${path}: ${names.join(', ')}`);
    expect(unheld, "hold it with `{ enabled: useRoleCan(http)('<name>') === true }`").toEqual([]);
    const stale = Object.keys(READ_GATED_AT_ENTRY).filter(
      (path) => readsOf(FILES.find((file) => file.path === path)?.text ?? '').length === 0,
    );
    expect(stale, 'remove these from READ_GATED_AT_ENTRY').toEqual([]);
  });

  it('every write some role may not make is gated on the role where it is offered', () => {
    const call = /\bcall(?:<[^>()]*>)?\(\s*'([a-z][a-z0-9_]*)'/g;
    const ungated: string[] = [];
    for (const { path, text } of FILES) {
      const names = [...new Set([...text.matchAll(call)].map((match) => match[1] as string))];
      const missing = names.filter(
        (name) => ROLE_LIMITED_WRITES.has(name) && !text.includes(`can('${name}')`),
      );
      if (missing.length > 0 && !(path in WRITE_GATED_AT_ENTRY)) {
        ungated.push(`${path}: ${missing.join(', ')}`);
      }
    }
    expect(ungated, "offer it behind `useRoleCan(http)('<name>') !== false`").toEqual([]);
    const stale = Object.keys(WRITE_GATED_AT_ENTRY).filter((path) => {
      const text = FILES.find((file) => file.path === path)?.text ?? '';
      return ![...text.matchAll(call)].some(
        (match) =>
          ROLE_LIMITED_WRITES.has(match[1] as string) && !text.includes(`can('${match[1]}')`),
      );
    });
    expect(stale, 'remove these from WRITE_GATED_AT_ENTRY').toEqual([]);
  });

  it('no control is gated on a past refusal (`isDenied`) outside the allow-list', () => {
    const using = FILES.filter(({ text }) => /\bisDenied\(/.test(text)).map(({ path }) => path);
    const unexpected = using.filter((path) => !(path in IS_DENIED_ALLOWED));
    expect(unexpected, 'use `useRoleCan(http)(name)` instead').toEqual([]);
    const stale = Object.keys(IS_DENIED_ALLOWED).filter((path) => !using.includes(path));
    expect(stale, 'remove these from IS_DENIED_ALLOWED').toEqual([]);
  });

  it('every capability name the console checks or calls is registered', () => {
    const literal =
      /\b(?:can|isDenied|markDenied|call(?:<[^>()]*>)?|useCapability(?:List)?(?:<[^>()]*>)?\(\s*\w+,|invalidateCapability\(\s*\w+,)\(?\s*'([a-z][a-z0-9_]*)'/g;
    const unknown: string[] = [];
    let seen = 0;
    for (const { path, text } of FILES) {
      for (const match of text.matchAll(literal)) {
        seen += 1;
        const name = match[1] as string;
        if (getCapability(name) === undefined) unknown.push(`${path}: ${name}`);
      }
    }
    // The pattern still finds the console's calls (a rename of the helpers would silently empty it).
    expect(seen).toBeGreaterThan(200);
    expect(unknown).toEqual([]);
  });

  it('every route requirement names a registered capability', () => {
    const named = Object.values(ROUTE_REQUIRES).flatMap((requirement) =>
      requirement && 'capability' in requirement ? [requirement.capability] : [],
    );
    expect(named.length).toBeGreaterThan(0);
    expect(named.filter((name) => getCapability(name) === undefined)).toEqual([]);
  });

  it('every in-app link to a gated route asks the route table (#541 review N2)', () => {
    // The table gates the approvals, members, audit and platform routes — if this list ever
    // empties, the builders were renamed and the scan below sees nothing.
    expect(GATED_HREF_BUILDERS.length).toBeGreaterThan(10);
    const builds = (text: string) => GATED_HREF_BUILDERS.some((name) => text.includes(name));
    const asks = (text: string) =>
      /\bRouteLink\b|\buseCanOpen\(|\bcanOpen\(|\broleMayOpen\(/.test(text);
    const unasked = FILES.filter(
      ({ path, text }) => !(path in ROUTE_LINK_ALLOWED) && builds(text) && !asks(text),
    ).map(({ path }) => path);
    expect(unasked, 'render it with `kit/route-link` or check `useCanOpen()(href)`').toEqual([]);
    const stale = Object.keys(ROUTE_LINK_ALLOWED).filter((path) => {
      const text = FILES.find((file) => file.path === path)?.text ?? '';
      return !builds(text) || asks(text);
    });
    expect(stale, 'remove these from ROUTE_LINK_ALLOWED').toEqual([]);
  });
});
