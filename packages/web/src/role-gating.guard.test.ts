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
import { GOVERN_NAV, PLATFORM_NAV, WORK_NAV } from './lib/nav.js';

/**
 * #541 review M1/M3 guard: what a reader's role may do is decided by the kernel's own predicate
 * (`useRoleCan` → `roleMayUseCapability`), never by "it was refused once already"
 * (`permissions.isDenied`, which shows the control until the first refusal), and every
 * capability name the console checks or calls is one the registry knows.
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
  'components/OnboardingWizardReview.tsx': 'inside the wizard / a linked launcher (owner)',
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
  'components/access/GrantGateForm.tsx':
    'GrantGateDrawer and the linked launcher, both owner paths',
  'components/approvals/useApprovalQueue.ts':
    'the approvals page, a nav entry gated on list_pending (operator)',
  'components/chat/useActionCards.ts': "ChatPage's canDecide / canAlwaysAllow",
};

/** Files that read something some role may not, without a `can('<name>')` of their own: each is
 *  only reached by the roles that may read it — where is the reason. Only ever shrinks. */
const READ_GATED_AT_ENTRY: Readonly<Record<string, string>> = {
  'components/ApprovalQueuePage.tsx': 'the approvals page, a nav entry gated on list_pending',
  'components/approvals/useApprovalQueue.ts': 'the approvals page, as above',
  'components/MembersPage.tsx': 'a nav entry gated on list_principals',
  'components/AuditPage.tsx': 'a nav entry gated on audit_query (reconstruct: the same roles)',
  'components/audit/AuditLogSection.tsx': 'AuditPage, as above',
  'components/audit/ExplainSection.tsx': 'AuditPage, as above (export_prov: the same roles)',
  'components/audit/ApprovalContext.tsx':
    "AuditPage opened from an approval's provenance link (owner); ExplainSection gates get_action",
  'components/CompleteConnectionForm.tsx': "SystemsPage's complete / register, behind canCreate",
  'components/access/GrantGateForm.tsx':
    'GrantGateDrawer and the linked launcher, both owner paths',
  'components/connect/ConnectSystemLauncher.tsx': "SystemsPage's canCreate and the platform page",
  'components/connect/EnableGateConfirm.tsx': "SystemsPage's canEnable",
  'components/connect/RefreshOperationGovernanceConfirm.tsx': "SystemAccessCard's canManage",
  'components/readiness/useExecutionReadiness.ts':
    'the hook itself: each file using it is checked as reading execution_readiness',
  'components/systems/useMemberReachability.ts':
    "SystemsPage passes the grantees of list_grants, read only with can('list_grants')",
};

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

  it('every nav entry gated on a capability names a registered one', () => {
    const named = [...WORK_NAV, ...GOVERN_NAV, ...PLATFORM_NAV]
      .map((item) => item.capability)
      .filter((name): name is NonNullable<typeof name> => name !== undefined);
    expect(named.length).toBeGreaterThan(0);
    expect(named.filter((name) => getCapability(name) === undefined)).toEqual([]);
  });
});
