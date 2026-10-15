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
import ts from 'typescript';
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

/**
 * What one source file does, read from its syntax tree (TypeScript's own parser, legacy 235): a
 * comment is never code, a generic of any depth (`call<Page<Row>>('x')`) is still a call, and a
 * call whose name is a variable is either resolved to the literals the file gives it or reported.
 */
interface FileScan {
  readonly path: string;
  /** Capability names called: `<caller>.call('name')` (or a variable the file pins to literal
   *  names), `useCapability(…, 'name')` / `useCapabilityList(…, 'name')`, `useExecutionReadiness(`. */
  readonly calls: ReadonlySet<string>;
  /** `<caller>.call(name)` whose name the file does not pin to literals: `line: <expression>`. */
  readonly dynamicCalls: readonly string[];
  /** Names checked with `can('name')` in code. */
  readonly checked: ReadonlySet<string>;
  readonly usesIsDenied: boolean;
  /** Every literal capability name the file checks or calls, for the registry check. */
  readonly named: readonly string[];
  /** Calls that build an href to a gated route (`GATED_HREF_BUILDERS`): `line: <call>`. */
  readonly gatedLinks: readonly string[];
  /** The subset of `gatedLinks` no route-table check covers. */
  readonly unaskedLinks: readonly string[];
}

/** The route table's checks: `useCanOpen()`'s function and the sidebar's predicate. */
const ASKS = new Set(['canOpen', 'roleMayOpen']);

function literalText(node: ts.Node | undefined): string | undefined {
  return node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    ? node.text
    : undefined;
}

/** Every string literal (or literal type) under `node`. */
function literalsUnder(node: ts.Node): string[] {
  const found: string[] = [];
  const visit = (child: ts.Node) => {
    const text = literalText(child);
    if (text !== undefined) found.push(text);
    ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}

function calleeName(call: ts.CallExpression): string | undefined {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return undefined;
}

function scanFile(path: string, text: string, gatedBuilders: GatedBuilders): FileScan {
  const source = ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const line = (node: ts.Node) => source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
  const where = (node: ts.Node) =>
    `${line(node)}: ${node.getText().replace(/\s+/g, ' ').slice(0, 60)}`;

  // Declarations by name, for resolving `call(action)` and `const href = auditHref(…)`.
  const declarations = new Map<string, ts.Node[]>();
  const uses = new Map<string, ts.Identifier[]>();
  const index = (node: ts.Node) => {
    if ((ts.isVariableDeclaration(node) || ts.isParameter(node)) && ts.isIdentifier(node.name)) {
      declarations.set(node.name.text, [...(declarations.get(node.name.text) ?? []), node]);
    } else if (ts.isIdentifier(node)) {
      uses.set(node.text, [...(uses.get(node.text) ?? []), node]);
    }
    ts.forEachChild(node, index);
  };
  index(source);

  /** The declaration `identifier` refers to: the innermost one whose scope holds it. */
  const declarationInScope = (identifier: ts.Identifier): ts.Node | undefined => {
    const scopeOf = (declaration: ts.Node) => {
      let scope: ts.Node = declaration.parent;
      while (!ts.isFunctionLike(scope) && !ts.isBlock(scope) && !ts.isSourceFile(scope)) {
        scope = scope.parent;
      }
      return scope;
    };
    const at = identifier.getStart();
    return (declarations.get(identifier.text) ?? [])
      .filter((declaration) => {
        const scope = scopeOf(declaration);
        return scope.getStart() <= at && at < scope.getEnd();
      })
      .sort((a, b) => b.getStart() - a.getStart())[0];
  };

  /** Whether `node` contains a route-table check: `canOpen(…)`, `roleMayOpen(…)`, or a variable
   *  computed from one (`const opensApprovals = canOpen(…) !== false`). */
  const asksIn = (node: ts.Node, depth = 0): boolean => {
    let found = false;
    const visit = (child: ts.Node) => {
      if (found) return;
      // `canOpen(href)`, or the check itself handed on (`resourceHref(type, id, canOpen)`).
      if (ts.isCallExpression(child) && ASKS.has(calleeName(child) ?? '')) found = true;
      else if (ts.isIdentifier(child) && ASKS.has(child.text)) found = true;
      else if (ts.isIdentifier(child) && depth < 2) {
        const declaration = declarationInScope(child);
        if (
          declaration &&
          ts.isVariableDeclaration(declaration) &&
          declaration.initializer &&
          declaration.initializer !== node &&
          asksIn(declaration.initializer, depth + 1)
        ) {
          found = true;
        }
      }
      ts.forEachChild(child, visit);
    };
    visit(node);
    return found;
  };

  const isRouteLinkHref = (attribute: ts.JsxAttribute) => {
    const element = attribute.parent.parent;
    return (
      attribute.name.getText() === 'href' &&
      (ts.isJsxOpeningElement(element) || ts.isJsxSelfClosingElement(element)) &&
      element.tagName.getText() === 'RouteLink'
    );
  };

  /** Whether the href built at `node` only reaches the reader through the route table. */
  const asked = (node: ts.Node, following = new Set<ts.Node>()): boolean => {
    // `resourceHref(type, id, canOpen)` filters with the reader's check itself.
    if (
      ts.isCallExpression(node) &&
      calleeName(node) === 'resourceHref' &&
      node.arguments.some((argument) => asksIn(argument))
    ) {
      return true;
    }
    for (let child = node, parent = node.parent; parent; child = parent, parent = parent.parent) {
      if (ts.isJsxAttribute(parent) && isRouteLinkHref(parent)) return true;
      if (ts.isCallExpression(parent) && parent.arguments.includes(child as ts.Expression)) {
        const name = calleeName(parent) ?? '';
        if (ASKS.has(name)) return true;
      }
      if (
        ts.isConditionalExpression(parent) &&
        child === parent.whenTrue &&
        asksIn(parent.condition)
      ) {
        return true;
      }
      if (
        ts.isBinaryExpression(parent) &&
        parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
        child === parent.right &&
        asksIn(parent.left)
      ) {
        return true;
      }
      if (ts.isIfStatement(parent) && child === parent.thenStatement && asksIn(parent.expression)) {
        return true;
      }
      // `const href = auditHref(…)`, then `canOpen(href)` or `<RouteLink href={href}>`.
      if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
        if (following.has(parent)) return false;
        following.add(parent);
        return (uses.get(parent.name.text) ?? []).some(
          (use) => use !== parent.name && asked(use, following),
        );
      }
    }
    return false;
  };

  const calls = new Set<string>();
  const dynamicCalls: string[] = [];
  const checked = new Set<string>();
  const named: string[] = [];
  const gatedLinks: string[] = [];
  const unaskedLinks: string[] = [];
  let usesIsDenied = false;

  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const name = calleeName(node);
      const first = node.arguments[0];
      if (name === 'call' && ts.isPropertyAccessExpression(node.expression) && first) {
        const literal = literalText(first);
        if (literal !== undefined) {
          calls.add(literal);
          named.push(literal);
        } else {
          // A variable: the literals of its declaration (`action: 'publish_skill' | …`,
          // `const capability = confirm ? 'a' : 'b'`), or reported.
          const declaration = ts.isIdentifier(first) ? declarationInScope(first) : undefined;
          const pinned = declaration
            ? literalsUnder(declaration).filter((text) => getCapability(text) !== undefined)
            : [];
          if (pinned.length > 0) for (const text of pinned) calls.add(text);
          else dynamicCalls.push(where(node));
        }
      } else if ((name === 'useCapability' || name === 'useCapabilityList') && node.arguments[1]) {
        const literal = literalText(node.arguments[1]);
        if (literal !== undefined) {
          calls.add(literal);
          named.push(literal);
        }
      } else if (name === 'useExecutionReadiness') {
        calls.add('execution_readiness');
      } else if (
        first &&
        (name === 'can' ||
          // `useRoleCan(http)('get_action')`, called on the spot.
          (ts.isCallExpression(node.expression) && calleeName(node.expression) === 'useRoleCan'))
      ) {
        const literal = literalText(first);
        if (literal !== undefined) {
          checked.add(literal);
          named.push(literal);
        }
      } else if (name === 'isDenied' || name === 'markDenied' || name === 'invalidateCapability') {
        if (name === 'isDenied') usesIsDenied = true;
        const literal = literalText(name === 'invalidateCapability' ? node.arguments[1] : first);
        if (literal !== undefined) named.push(literal);
      }
      if (gatedBuilders.isGated(node)) {
        gatedLinks.push(where(node));
        if (!asked(node)) unaskedLinks.push(where(node));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { path, calls, dynamicCalls, checked, usesIsDenied, named, gatedLinks, unaskedLinks };
}

interface GatedBuilders {
  readonly names: readonly string[];
  readonly isGated: (call: ts.CallExpression) => boolean;
}

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
  'components/CompleteConnectionForm.tsx':
    "SystemsPage's complete / register and OnboardingWizard, both behind canCreate",
  'components/RequestConnectionForm.tsx':
    "SystemsPage's connect-a-system button, behind canRequest",
  'components/AgentPolicyForm.tsx': 'ModelsPage, owner only (isOwner)',
  'components/governance/QuotaEditSheet.tsx': 'ModelsPage, owner only (isOwner)',
  'components/governance/PolicyEditSheet.tsx': 'ModelsPage, owner only (isOwner)',
  'components/AgentProfileForm.tsx': "AgentProfilePage's editForbidden (role, then policy)",
  'components/AvailableGateInstancesSection.tsx':
    "SystemsPage's canEnterCredential / canEnable props",
  'components/connect/EnableGateConfirm.tsx':
    "SystemsPage's canEnable; ConnectSystemLauncher mounts it behind the same canEnable",
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
  'components/CompleteConnectionForm.tsx':
    "SystemsPage's complete / register and OnboardingWizard, both behind canCreate",
  'components/connect/EnableGateConfirm.tsx':
    "SystemsPage's canEnable; ConnectSystemLauncher mounts it behind the same canEnable",
  'components/connect/RefreshOperationGovernanceConfirm.tsx': "SystemAccessCard's canManage",
  'components/readiness/useExecutionReadiness.ts':
    'the hook itself: each file using it is checked as reading execution_readiness',
  'lib/audit-pickers.ts':
    'the audit pickers: only the audit pages (route needs audit_query) and the platform audit use them',
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
  'lib/audit.ts': "builds the audit deep links; resourceHref takes the caller's canOpen to filter",
  'routes.tsx':
    'in-page navigation on a route the reader already opened (approvals, platform integrations), ' +
    'and the platform-only landing redirect',
  'components/audit/ExplainSection.tsx':
    'an in-page re-explain on the audit route, which its reader already opened',
  'session/useSessionMachine.ts':
    'lands a platform-only session (an administrator, no workspace) on the platform overview',
};

/** Every helper that builds an href to a route the table gates: the `hrefs` whose route has a
 *  requirement (read from the table), plus the audit deep-link builders. */
const GATED_HREFS: ReadonlySet<string> = new Set(
  Object.entries(hrefs)
    .filter(([, build]) => routeRequirement((build as (...args: string[]) => string)('x')))
    .map(([name]) => name),
);
const GATED_FUNCTIONS: ReadonlySet<string> = new Set([
  'auditHref',
  'auditHrefForNode',
  'resourceHref',
]);
const GATED_BUILDERS: GatedBuilders = {
  names: [...[...GATED_HREFS].map((name) => `hrefs.${name}`), ...GATED_FUNCTIONS],
  isGated: (call) => {
    const callee = call.expression;
    if (ts.isIdentifier(callee)) return GATED_FUNCTIONS.has(callee.text);
    return (
      ts.isPropertyAccessExpression(callee) &&
      ts.isIdentifier(callee.expression) &&
      callee.expression.text === 'hrefs' &&
      GATED_HREFS.has(callee.name.text)
    );
  },
};

const FILES: readonly FileScan[] = sourceFiles(SRC).map((path) =>
  scanFile(relative(SRC, path).replaceAll('\\', '/'), readFileSync(path, 'utf8'), GATED_BUILDERS),
);
const scanOf = (path: string) => FILES.find((file) => file.path === path);

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

/** `<caller>.call(name)` sites whose name is a variable the file does not pin to literals, each
 *  for a reason; the capability is checked where the name is chosen. Only ever shrinks. */
const DYNAMIC_CALL_ALLOWED: Readonly<Record<string, string>> = {
  'hooks/useCapability.ts': 'the generic hooks: each caller passes its literal name and is scanned',
  'lib/audit-pickers.ts': 'the picker loaders: each picker names its capability where it is used',
  'lib/gate-instances.ts': 'the loader takes the list capability its caller holds on the role',
  'lib/users-directory.ts': 'the directory loader: its caller names the capability',
};

describe('role gating guard (#541 review M1/M3, legacy 235: read from the syntax tree)', () => {
  it('every read some role may not make is held on the role where it is made', () => {
    const readsOf = (file: FileScan | undefined) =>
      [...(file?.calls ?? [])].filter(
        (name) => ROLE_LIMITED_READS.has(name) && !file?.checked.has(name),
      );
    const unheld = FILES.filter(({ path }) => !(path in READ_GATED_AT_ENTRY))
      .map((file) => ({ path: file.path, names: readsOf(file) }))
      .filter(({ names }) => names.length > 0)
      .map(({ path, names }) => `${path}: ${names.join(', ')}`);
    expect(unheld, "hold it with `{ enabled: useRoleCan(http)('<name>') === true }`").toEqual([]);
    const stale = Object.keys(READ_GATED_AT_ENTRY).filter(
      (path) => readsOf(scanOf(path)).length === 0,
    );
    expect(stale, 'remove these from READ_GATED_AT_ENTRY').toEqual([]);
  });

  it('every write some role may not make is gated on the role where it is offered', () => {
    const ungatedOf = (file: FileScan | undefined) =>
      [...(file?.calls ?? [])].filter(
        (name) => ROLE_LIMITED_WRITES.has(name) && !file?.checked.has(name),
      );
    const ungated = FILES.filter(({ path }) => !(path in WRITE_GATED_AT_ENTRY))
      .map((file) => ({ path: file.path, names: ungatedOf(file) }))
      .filter(({ names }) => names.length > 0)
      .map(({ path, names }) => `${path}: ${names.join(', ')}`);
    expect(ungated, "offer it behind `useRoleCan(http)('<name>') !== false`").toEqual([]);
    const stale = Object.keys(WRITE_GATED_AT_ENTRY).filter(
      (path) => ungatedOf(scanOf(path)).length === 0,
    );
    expect(stale, 'remove these from WRITE_GATED_AT_ENTRY').toEqual([]);
  });

  it('every call names its capability, or the file is allowed to pass one through', () => {
    const dynamic = FILES.filter(
      ({ path, dynamicCalls }) => dynamicCalls.length > 0 && !(path in DYNAMIC_CALL_ALLOWED),
    ).flatMap(({ path, dynamicCalls }) => dynamicCalls.map((site) => `${path}:${site}`));
    expect(
      dynamic,
      'call it with a literal name, or a variable typed as the literal names',
    ).toEqual([]);
    const stale = Object.keys(DYNAMIC_CALL_ALLOWED).filter(
      (path) => (scanOf(path)?.dynamicCalls.length ?? 0) === 0,
    );
    expect(stale, 'remove these from DYNAMIC_CALL_ALLOWED').toEqual([]);
  });

  it('no control is gated on a past refusal (`isDenied`) outside the allow-list', () => {
    const using = FILES.filter(({ usesIsDenied }) => usesIsDenied).map(({ path }) => path);
    const unexpected = using.filter((path) => !(path in IS_DENIED_ALLOWED));
    expect(unexpected, 'use `useRoleCan(http)(name)` instead').toEqual([]);
    const stale = Object.keys(IS_DENIED_ALLOWED).filter((path) => !using.includes(path));
    expect(stale, 'remove these from IS_DENIED_ALLOWED').toEqual([]);
  });

  it('every capability name the console checks or calls is registered', () => {
    const named = FILES.flatMap(({ path, named }) => named.map((name) => ({ path, name })));
    // The scan still finds the console's calls (a rename of the helpers would silently empty it).
    expect(named.length).toBeGreaterThan(200);
    expect(
      named
        .filter(({ name }) => getCapability(name) === undefined)
        .map(({ path, name }) => `${path}: ${name}`),
    ).toEqual([]);
  });

  it('every route requirement names a registered capability', () => {
    const named = Object.values(ROUTE_REQUIRES).flatMap((requirement) =>
      requirement && 'capability' in requirement ? [requirement.capability] : [],
    );
    expect(named.length).toBeGreaterThan(0);
    expect(named.filter((name) => getCapability(name) === undefined)).toEqual([]);
  });

  it('every in-app link to a gated route asks the route table, at the link (#541 review N2)', () => {
    // The table gates the approvals, members, audit and platform routes — if this list ever
    // empties, the builders were renamed and the scan below sees nothing.
    expect(GATED_BUILDERS.names.length).toBeGreaterThan(10);
    expect(FILES.flatMap(({ gatedLinks }) => gatedLinks).length).toBeGreaterThan(20);
    const unasked = FILES.filter(
      ({ path, unaskedLinks }) => unaskedLinks.length > 0 && !(path in ROUTE_LINK_ALLOWED),
    ).flatMap(({ path, unaskedLinks }) => unaskedLinks.map((site) => `${path}:${site}`));
    expect(
      unasked,
      'render it as `<RouteLink href={…}>`, or show it only where `useCanOpen()(href)` holds',
    ).toEqual([]);
    const stale = Object.keys(ROUTE_LINK_ALLOWED).filter(
      (path) => (scanOf(path)?.unaskedLinks.length ?? 0) === 0,
    );
    expect(stale, 'remove these from ROUTE_LINK_ALLOWED').toEqual([]);
  });
});
