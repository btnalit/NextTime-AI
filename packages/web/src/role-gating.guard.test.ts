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
  /** Each call site: the name, where, and the file's top-level declaration it sits in. */
  readonly callSites: readonly Site[];
  /** Each `can('name')` site, keyed the same way. */
  readonly checkSites: readonly Site[];
  /** `.call` used other than as the callee (`http.call.bind(http)`, `const { call } = http`): a
   *  call the scan could not see. */
  readonly aliasedCalls: readonly string[];
  /** Modules this file imports (`'../lib/audit-pickers.js'`, as written). */
  readonly imports: readonly string[];
  /** Each top-level declaration (by start offset): its name, whether it is exported, and the
   *  top-level declarations of this file that refer to it — so a check in the only place that
   *  renders a private body covers the body's calls (`LinkedApprovals` → `LinkedApprovalsList`). */
  readonly tops: ReadonlyMap<number, TopDeclaration>;
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

/** One capability call or check: its name, `line: <text>`, and the top-level declaration of the
 *  file it sits in (by start offset) — a check pairs with the calls in its own declaration only
 *  (review of #554, P3-2: one `can('x')` anywhere in a file used to cover every `call('x')`). */
interface Site {
  readonly name: string;
  readonly where: string;
  readonly top: number;
}

interface TopDeclaration {
  readonly name: string | undefined;
  readonly exported: boolean;
  readonly referencedFrom: ReadonlySet<number>;
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

  /** Which gate an href expression leads to — the route table's requirement for its route, so a
   *  check and a link agree when they lead to the same gate (`canOpen(hrefs.audit())` covers
   *  `hrefs.audit({ … })`, never `hrefs.members()`). A variable resolves through its initializer.
   *  `undefined` when the scan cannot tell. */
  const routeKey = (node: ts.Node | undefined, depth = 0): string | undefined => {
    if (node === undefined || depth > 2) return undefined;
    if (ts.isParenthesizedExpression(node)) return routeKey(node.expression, depth);
    if (ts.isIdentifier(node)) {
      const declaration = declarationInScope(node);
      return declaration && ts.isVariableDeclaration(declaration)
        ? routeKey(declaration.initializer, depth + 1)
        : undefined;
    }
    if (!ts.isCallExpression(node)) return undefined;
    return gatedBuilders.keyOf(node);
  };

  /** Whether `node` checks the route table about the gate `key` leads to: `canOpen(<same gate>)`,
   *  `roleMayOpen(role, <same gate>)`, or a variable computed from one. A bare `canOpen` handed
   *  nowhere is not a check (review of #554, P3-1). */
  const asksAbout = (node: ts.Node, key: string | undefined, depth = 0): boolean => {
    if (key === undefined) return false;
    let found = false;
    const visit = (child: ts.Node) => {
      if (found) return;
      if (ts.isCallExpression(child) && ASKS.has(calleeName(child) ?? '')) {
        const href = calleeName(child) === 'roleMayOpen' ? child.arguments[1] : child.arguments[0];
        if (routeKey(href) === key) found = true;
      } else if (ts.isIdentifier(child) && !ASKS.has(child.text) && depth < 2) {
        const declaration = declarationInScope(child);
        if (
          declaration &&
          ts.isVariableDeclaration(declaration) &&
          declaration.initializer &&
          declaration.initializer !== node &&
          asksAbout(declaration.initializer, key, depth + 1)
        ) {
          found = true;
        }
      }
      ts.forEachChild(child, visit);
    };
    visit(node);
    return found;
  };

  /** An identifier that reads a variable — not a property name (`x.href`, `{ href: … }`) or a
   *  JSX attribute name that merely spells the same word. */
  const isReference = (identifier: ts.Identifier) => {
    const parent = identifier.parent;
    if (ts.isPropertyAccessExpression(parent) && parent.name === identifier) return false;
    if (ts.isPropertyAssignment(parent) && parent.name === identifier) return false;
    if (ts.isJsxAttribute(parent)) return false;
    if (ts.isBindingElement(parent) && parent.propertyName === identifier) return false;
    return true;
  };

  /** `node` is the href a `canOpen` / `roleMayOpen` call asks about — the check itself. */
  const isAskedHref = (node: ts.Node) => {
    const parent = node.parent;
    if (!ts.isCallExpression(parent)) return false;
    const name = calleeName(parent) ?? '';
    if (!ASKS.has(name)) return false;
    return (name === 'roleMayOpen' ? parent.arguments[1] : parent.arguments[0]) === node;
  };

  const isRouteLinkHref = (attribute: ts.JsxAttribute) => {
    const element = attribute.parent.parent;
    return (
      attribute.name.getText() === 'href' &&
      (ts.isJsxOpeningElement(element) || ts.isJsxSelfClosingElement(element)) &&
      element.tagName.getText() === 'RouteLink'
    );
  };

  /** Whether the href built at `node` only reaches the reader through the route table: at a
   *  `RouteLink`, or under a check about the same gate (`key`). A variable holding it is asked only
   *  when every use other than the check itself is (review of #554, P3-1). */
  const asked = (
    node: ts.Node,
    key: string | undefined = routeKey(node),
    following = new Set<ts.Node>(),
  ): boolean => {
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
      if (isAskedHref(child)) return true;
      if (
        ts.isConditionalExpression(parent) &&
        child === parent.whenTrue &&
        asksAbout(parent.condition, key)
      ) {
        return true;
      }
      if (
        ts.isBinaryExpression(parent) &&
        parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
        child === parent.right &&
        asksAbout(parent.left, key)
      ) {
        return true;
      }
      if (
        ts.isIfStatement(parent) &&
        child === parent.thenStatement &&
        asksAbout(parent.expression, key)
      ) {
        return true;
      }
      // `const href = auditHref(…)`, then `<RouteLink href={href}>` / `canOpen(href) ? … : …`.
      if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
        if (following.has(parent)) return false;
        following.add(parent);
        const declaration = parent;
        return (uses.get(parent.name.text) ?? [])
          .filter(
            (use) =>
              use !== declaration.name &&
              isReference(use) &&
              declarationInScope(use) === declaration &&
              !isAskedHref(use),
          )
          .every((use) => asked(use, key, following));
      }
    }
    return false;
  };

  // Top-level declarations and who refers to them, for `paired` below.
  const topNames = new Map<number, { name: string | undefined; exported: boolean }>();
  for (const statement of source.statements) {
    const exported =
      ts.canHaveModifiers(statement) &&
      (ts.getModifiers(statement) ?? []).some(
        (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
      );
    let name: string | undefined;
    if (
      (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
      statement.name
    ) {
      name = statement.name.text;
    } else if (ts.isVariableStatement(statement)) {
      const [only, ...rest] = statement.declarationList.declarations;
      if (only && rest.length === 0 && ts.isIdentifier(only.name)) name = only.name.text;
    }
    topNames.set(statement.getStart(), { name, exported });
  }
  const exportedLater = new Set<string>();
  for (const statement of source.statements) {
    if (
      ts.isExportDeclaration(statement) &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause)
    ) {
      for (const element of statement.exportClause.elements) {
        exportedLater.add((element.propertyName ?? element.name).text);
      }
    } else if (ts.isExportAssignment(statement) && ts.isIdentifier(statement.expression)) {
      exportedLater.add(statement.expression.text);
    }
  }

  const calls = new Set<string>();
  const callSites: Site[] = [];
  const checkSites: Site[] = [];
  const aliasedCalls: string[] = [];
  const imports: string[] = [];
  /** The file's top-level statement holding `node` (its start offset). */
  const topOf = (node: ts.Node) => {
    let top = node;
    while (top.parent && !ts.isSourceFile(top.parent)) top = top.parent;
    return top.getStart();
  };
  const callSite = (name: string, node: ts.Node) => {
    calls.add(name);
    callSites.push({ name, where: where(node), top: topOf(node) });
  };
  const dynamicCalls: string[] = [];
  const checked = new Set<string>();
  const named: string[] = [];
  const gatedLinks: string[] = [];
  const unaskedLinks: string[] = [];
  let usesIsDenied = false;

  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node)) {
      const module = literalText(node.moduleSpecifier);
      if (module !== undefined) imports.push(module);
    }
    // `http.call` handed on instead of called (`.bind(http)`, `const call = http.call`), or
    // `const { call } = http`: the scan would never see what it calls (review of #554, P3-4).
    if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === 'call' &&
      !(ts.isCallExpression(node.parent) && node.parent.expression === node)
    ) {
      aliasedCalls.push(where(node));
    }
    if (
      ts.isBindingElement(node) &&
      ts.isObjectBindingPattern(node.parent) &&
      (node.propertyName ?? node.name).getText() === 'call'
    ) {
      aliasedCalls.push(where(node));
    }
    if (ts.isCallExpression(node)) {
      const name = calleeName(node);
      const first = node.arguments[0];
      if (name === 'call' && ts.isPropertyAccessExpression(node.expression) && first) {
        const literal = literalText(first);
        if (literal !== undefined) {
          callSite(literal, node);
          named.push(literal);
        } else {
          // A variable: the literals of its declaration (`action: 'publish_skill' | …`,
          // `const capability = confirm ? 'a' : 'b'`), or reported.
          const declaration = ts.isIdentifier(first) ? declarationInScope(first) : undefined;
          const pinned = declaration
            ? literalsUnder(declaration).filter((text) => getCapability(text) !== undefined)
            : [];
          if (pinned.length > 0) for (const text of pinned) callSite(text, node);
          else dynamicCalls.push(where(node));
        }
      } else if ((name === 'useCapability' || name === 'useCapabilityList') && node.arguments[1]) {
        const literal = literalText(node.arguments[1]);
        if (literal !== undefined) {
          callSite(literal, node);
          named.push(literal);
        }
      } else if (name === 'useExecutionReadiness') {
        callSite('execution_readiness', node);
      } else if (
        first &&
        (name === 'can' ||
          // `useRoleCan(http)('get_action')`, called on the spot.
          (ts.isCallExpression(node.expression) && calleeName(node.expression) === 'useRoleCan'))
      ) {
        const literal = literalText(first);
        if (literal !== undefined) {
          checked.add(literal);
          checkSites.push({ name: literal, where: where(node), top: topOf(node) });
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

  const tops = new Map<number, TopDeclaration>();
  for (const [start, { name, exported }] of topNames) {
    const referencedFrom = new Set<number>();
    if (name !== undefined) {
      for (const use of uses.get(name) ?? []) {
        if (!isReference(use)) continue;
        const from = topOf(use);
        if (from !== start) referencedFrom.add(from);
      }
    }
    tops.set(start, {
      name,
      exported: exported || (name !== undefined && exportedLater.has(name)),
      referencedFrom,
    });
  }

  return {
    path,
    tops,
    calls,
    callSites,
    checkSites,
    aliasedCalls,
    imports,
    dynamicCalls,
    checked,
    usesIsDenied,
    named,
    gatedLinks,
    unaskedLinks,
  };
}

interface GatedBuilders {
  readonly names: readonly string[];
  readonly isGated: (call: ts.CallExpression) => boolean;
  /** The gate a builder call leads to (its route's requirement), for pairing a check with a link. */
  readonly keyOf: (call: ts.CallExpression) => string | undefined;
}

/** An allow-list entry: the names a file may call without a check of its own, and why. */
interface AllowedNames {
  readonly names: readonly string[];
  readonly why: string;
}

/** Who may import `lib/audit-pickers` — its loaders read `audit_query`, which only the audit route
 *  (and the platform audit page, which uses only its static suggestions) reach (review of #554,
 *  P3-3). Only ever shrinks. */
const AUDIT_PICKER_IMPORTERS: Readonly<Record<string, string>> = {
  'components/AuditPage.tsx': 'the audit route',
  'components/audit/AuditLogSection.tsx': 'the audit route',
  'components/audit/ExplainSection.tsx': 'the audit route',
  'components/audit/ProvenanceToolsSection.tsx': 'the audit route',
  'components/platform/PlatformAuditPage.tsx': 'only the static platformAuditActionSuggestions()',
  'lib/audit-id-picker.tsx': 'the picker component: types and optionMatches, no loader',
};

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
const WRITE_GATED_AT_ENTRY: Readonly<Record<string, AllowedNames>> = {
  'components/AddMemberForm.tsx': {
    names: ['add_member'],
    why: "MembersPage's add-member button, behind canManage (create_principal)",
  },
  'components/CreatePrincipalForm.tsx': {
    names: ['create_principal'],
    why: "MembersPage's header menu, behind canManage",
  },
  'components/PrincipalDetail.tsx': {
    names: ['disable_principal', 'rotate_api_key', 'set_principal_role'],
    why: 'MembersPage hands it canManage; the page needs list_principals',
  },
  'components/members/IssueServiceHandleSection.tsx': {
    names: ['issue_service_handle'],
    why: "MembersPage's header menu, behind canManage",
  },
  'components/OnboardingWizard.tsx': {
    names: ['publish_manifest'],
    why: "SystemsPage's more-ways-to-connect menu, behind canCreate",
  },
  'components/CompleteConnectionForm.tsx': {
    names: ['create_connection', 'mint_connection_secret'],
    why: "SystemsPage's complete / register and OnboardingWizard, both behind canCreate",
  },
  'components/RequestConnectionForm.tsx': {
    names: ['request_connection'],
    why: "SystemsPage's connect-a-system button, behind canRequest",
  },
  'components/AgentPolicyForm.tsx': {
    names: ['set_agent_policy'],
    why: 'ModelsPage, owner only (isOwner)',
  },
  'components/governance/QuotaEditSheet.tsx': {
    names: ['set_quota'],
    why: 'ModelsPage, owner only (isOwner)',
  },
  'components/governance/PolicyEditSheet.tsx': {
    names: ['set_policy'],
    why: 'ModelsPage, owner only (isOwner)',
  },
  'components/AgentProfileForm.tsx': {
    names: ['set_agent_profile'],
    why: "AgentProfilePage's editForbidden (role, then policy)",
  },
  'components/AvailableGateInstancesSection.tsx': {
    names: ['issue_gate_credential_token'],
    why: "SystemsPage's canEnterCredential / canEnable props",
  },
  'components/connect/EnableGateConfirm.tsx': {
    names: ['enable_gate_instance'],
    why: "SystemsPage's canEnable; ConnectSystemLauncher mounts it behind the same canEnable",
  },
  'components/connect/RefreshOperationGovernanceConfirm.tsx': {
    names: ['refresh_operation_governance'],
    why: "SystemAccessCard's canManage",
  },
  'components/account/IssueOwnHandleSection.tsx': {
    names: ['issue_handle'],
    why: "AccountPage's HandleCard, can('issue_handle')",
  },
  'components/catalog/SkillEditor.tsx': {
    names: ['propose_skill'],
    why: 'CatalogPage opens it only with canPropose',
  },
  'components/catalog/ProcedureEditor.tsx': {
    names: ['propose_procedure'],
    why: 'CatalogPage opens it only with canPropose',
  },
  'components/catalog/WorkerDefinitionEditor.tsx': {
    names: ['propose_worker_definition'],
    why: 'CatalogPage opens it only with canPropose',
  },
  'components/graph/SupersedeFactDialog.tsx': {
    names: ['supersede_fact'],
    why: "FactRow's more-actions menu, can('supersede_fact')",
  },
  'components/graph/AttestFactDialog.tsx': {
    names: ['attest_fact'],
    why: "FactRow's more-actions menu, can('attest_fact')",
  },
  'components/systems/SystemsPage.tsx': {
    names: ['cancel_connection_request', 'revoke_capability'],
    why: 'revoke via SystemAccessCard canRevoke (canManage); cancel inside the requests section (canRequest)',
  },
  'components/systems/SystemAccessCard.tsx': {
    names: ['publish_manifest', 'rotate_connection_secret'],
    why: 'SystemsPage hands it canPublish / canManage',
  },
  'components/approvals/useApprovalQueue.ts': {
    names: ['approve', 'reject', 'set_auto_approved_action_kind'],
    why: 'the approvals route, which the route table gates on list_pending (the same roles)',
  },
  'components/chat/useActionCards.ts': {
    names: ['approve', 'reject', 'set_auto_approved_action_kind'],
    why: "ChatPage's canDecide / canAlwaysAllow",
  },
};

/** Files that read something some role may not, without a `can('<name>')` of their own: each is
 *  only reached by the roles that may read it — where is the reason. Only ever shrinks. */
const READ_GATED_AT_ENTRY: Readonly<Record<string, AllowedNames>> = {
  'components/ApprovalQueuePage.tsx': {
    names: ['list_action_requests'],
    why: 'the approvals route, gated on list_pending by the route table (list_action_requests: the same roles)',
  },
  'components/approvals/useApprovalQueue.ts': {
    names: ['get_action', 'list_pending'],
    why: 'the approvals route, as above',
  },
  'components/MembersPage.tsx': {
    names: ['list_principals'],
    why: 'the members route, gated on list_principals by the route table',
  },
  'components/AuditPage.tsx': {
    names: ['reconstruct'],
    why: 'the audit route, gated on audit_query by the route table (reconstruct: the same roles)',
  },
  'components/audit/AuditLogSection.tsx': { names: ['audit_query'], why: 'AuditPage, as above' },
  'components/audit/ExplainSection.tsx': {
    names: ['export_prov'],
    why: 'AuditPage, as above (export_prov: the same roles)',
  },
  'components/audit/ApprovalContext.tsx': {
    names: ['get_action'],
    why: "AuditPage mounts it only when can('get_action') (an auditor gets a sentence instead)",
  },
  'components/CompleteConnectionForm.tsx': {
    names: ['list_principals'],
    why: "SystemsPage's complete / register and OnboardingWizard, both behind canCreate",
  },
  'components/connect/EnableGateConfirm.tsx': {
    names: ['preview_gate_instance_enable'],
    why: "SystemsPage's canEnable; ConnectSystemLauncher mounts it behind the same canEnable",
  },
  'components/connect/RefreshOperationGovernanceConfirm.tsx': {
    names: ['preview_gate_instance_enable'],
    why: "SystemAccessCard's canManage",
  },
  'components/readiness/useExecutionReadiness.ts': {
    names: ['execution_readiness'],
    why: 'the hook itself: each file using it is checked as reading execution_readiness',
  },
  'lib/audit-pickers.ts': {
    names: ['audit_query'],
    why: 'the audit pickers: only the audit pages (route needs audit_query) and the platform audit use them',
  },
  'components/systems/useMemberReachability.ts': {
    names: ['execution_readiness'],
    why: "SystemsPage passes the grantees of list_grants, read only with can('list_grants')",
  },
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
/** The route requirement an `hrefs.<name>` leads to, as a key (`undefined`: not gated). */
const hrefKey = (name: string): string | undefined => {
  const build = (hrefs as Record<string, unknown>)[name];
  if (typeof build !== 'function') return undefined;
  const requirement = routeRequirement((build as (...args: string[]) => string)('x'));
  return requirement === undefined ? undefined : JSON.stringify(requirement);
};
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
  keyOf: (call) => {
    const callee = call.expression;
    if (ts.isIdentifier(callee)) {
      // The audit deep links land on the audit route; `resourceHref` may land on any route, so it
      // only pairs with a check about itself.
      if (callee.text === 'auditHref' || callee.text === 'auditHrefForNode')
        return hrefKey('audit');
      if (callee.text === 'resourceHref') return 'resourceHref';
      return undefined;
    }
    return ts.isPropertyAccessExpression(callee) &&
      ts.isIdentifier(callee.expression) &&
      callee.expression.text === 'hrefs'
      ? hrefKey(callee.name.text)
      : undefined;
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

/** Whether the calls of `name` in the top-level declaration `top` are held by a `can('<name>')`:
 *  in that declaration itself, or — for a declaration the file does not export — in every
 *  declaration of the file that refers to it (the gated wrapper rendering its private body). */
function paired(file: FileScan, name: string, top: number, seen = new Set<number>()): boolean {
  if (file.checkSites.some((check) => check.name === name && check.top === top)) return true;
  const declaration = file.tops.get(top);
  if (declaration === undefined || declaration.exported || seen.has(top)) return false;
  if (declaration.referencedFrom.size === 0) return false;
  seen.add(top);
  return [...declaration.referencedFrom].every((from) => paired(file, name, from, seen));
}

/** The role-limited names a file calls where no `can('<name>')` holds that call site. */
function unpaired(file: FileScan | undefined, limited: ReadonlySet<string>): string[] {
  if (file === undefined) return [];
  const names = file.callSites
    .filter((site) => limited.has(site.name) && !paired(file, site.name, site.top))
    .map((site) => site.name);
  return [...new Set(names)].sort();
}

function expectPairedOrAllowed(
  limited: ReadonlySet<string>,
  allowed: Readonly<Record<string, AllowedNames>>,
  fix: string,
  listName: string,
): void {
  const unheld = FILES.map((file) => ({
    path: file.path,
    names: unpaired(file, limited).filter((name) => !allowed[file.path]?.names.includes(name)),
  }))
    .filter(({ names }) => names.length > 0)
    .map(({ path, names }) => `${path}: ${names.join(', ')}`);
  expect(unheld, fix).toEqual([]);
  // Only ever shrinks: an allowed name the file no longer calls unpaired is an error until removed.
  const stale = Object.entries(allowed).flatMap(([path, { names }]) => {
    const actual = unpaired(scanOf(path), limited);
    return names.filter((name) => !actual.includes(name)).map((name) => `${path}: ${name}`);
  });
  expect(stale, `remove these from ${listName}`).toEqual([]);
}

describe('role gating guard (#541 review M1/M3, legacy 235: read from the syntax tree)', () => {
  it('every read some role may not make is held on the role where it is made', () => {
    expectPairedOrAllowed(
      ROLE_LIMITED_READS,
      READ_GATED_AT_ENTRY,
      "hold it with `{ enabled: useRoleCan(http)('<name>') === true }` in the same declaration",
      'READ_GATED_AT_ENTRY',
    );
  });

  it('every write some role may not make is gated on the role where it is offered', () => {
    expectPairedOrAllowed(
      ROLE_LIMITED_WRITES,
      WRITE_GATED_AT_ENTRY,
      "offer it behind `useRoleCan(http)('<name>') !== false` in the same declaration",
      'WRITE_GATED_AT_ENTRY',
    );
  });

  it('the audit pickers are only used on the audit pages (their audit_query is gated by that route)', () => {
    const importers = FILES.filter(({ imports }) =>
      imports.some((module) => /(^|\/)audit-pickers\.js$/.test(module)),
    ).map(({ path }) => path);
    expect(importers.length).toBeGreaterThan(0);
    expect(importers.filter((path) => !(path in AUDIT_PICKER_IMPORTERS))).toEqual([]);
    expect(
      Object.keys(AUDIT_PICKER_IMPORTERS).filter((path) => !importers.includes(path)),
      'remove these from AUDIT_PICKER_IMPORTERS',
    ).toEqual([]);
  });

  it('`.call` is only ever called, never handed on (a bound or destructured call is invisible)', () => {
    expect(
      FILES.flatMap(({ path, aliasedCalls }) => aliasedCalls.map((site) => `${path}:${site}`)),
      'call `<caller>.call(…)` directly',
    ).toEqual([]);
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

/** The bypasses the review of #554 probed by hand, kept as cases so the guard cannot regress. */
describe('role gating guard catches the probed bypasses (review of #554)', () => {
  const scan = (text: string) => scanFile('probe.tsx', text, GATED_BUILDERS);
  const linkOf = (body: string) =>
    scan(`export function Probe({ canOpen }) {\n${body}\n}`).unaskedLinks.length;

  it('a link is covered only by a check about its own gate, at every use', () => {
    expect(linkOf('const href = hrefs.audit(); canOpen(href); return <a href={href} />;')).toBe(1);
    expect(linkOf('return canOpen(hrefs.members()) ? <a href={hrefs.audit()} /> : null;')).toBe(1);
    expect(linkOf('return canOpen ? <a href={hrefs.audit()} /> : null;')).toBe(1);
    expect(linkOf('return canOpen(hrefs.audit()) ? <a href={hrefs.audit()} /> : null;')).toBe(0);
    expect(
      linkOf('const href = hrefs.audit(); return canOpen(href) ? <a href={href} /> : null;'),
    ).toBe(0);
    expect(
      linkOf(
        'const href = hrefs.audit(); const ok = canOpen(href); return ok && <a href={href} />;',
      ),
    ).toBe(0);
    expect(linkOf('return <RouteLink href={hrefs.audit()}>x</RouteLink>;')).toBe(0);
  });

  it('a bound or destructured `.call` is reported', () => {
    expect(
      scan('const call = http.call.bind(http); call("audit_query");').aliasedCalls,
    ).toHaveLength(1);
    expect(scan('const { call } = http; call("audit_query");').aliasedCalls).toHaveLength(1);
    expect(scan('http.call("audit_query");').aliasedCalls).toHaveLength(0);
  });

  it('a check pairs with calls in its own declaration, or a private body only it renders', () => {
    const limited = new Set(['audit_query']);
    const unheld = (text: string) => unpaired(scan(text), limited);
    expect(
      unheld(
        "function A({ http }) { const can = useRoleCan(http); can('audit_query'); return null; }\n" +
          "export function B({ http }) { http.call('audit_query'); return null; }",
      ),
    ).toEqual(['audit_query']);
    expect(
      unheld(
        "export function A({ http }) { const can = useRoleCan(http); return can('audit_query') ? <B http={http} /> : null; }\n" +
          "function B({ http }) { http.call('audit_query'); return null; }",
      ),
    ).toEqual([]);
    expect(
      unheld(
        "export function A({ http }) { const can = useRoleCan(http); return can('audit_query') ? <B http={http} /> : null; }\n" +
          'export function C({ http }) { return <B http={http} />; }\n' +
          "function B({ http }) { http.call('audit_query'); return null; }",
      ),
    ).toEqual(['audit_query']);
  });
});
