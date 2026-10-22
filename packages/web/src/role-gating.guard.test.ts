import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
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
  /** Each call site: the name, where, and whether a role check holds that very site. */
  readonly callSites: readonly Site[];
  /** `.call` used other than as the callee (`http.call.bind(http)`, `const { call } = http`,
   *  `http['call'](…)`): a call the scan could not see. */
  readonly aliasedCalls: readonly string[];
  /** `hrefs` used other than as `hrefs.<name>(…)` (`const h = hrefs`, `const { audit } = hrefs`,
   *  `hrefs['audit']()`): a link the scan could not see (review of #559, L3–L5). */
  readonly aliasedHrefs: readonly string[];
  /** `can('name')` whose `can` is not the reader's role check (`useRoleCan`) — a local
   *  `function can() { return true }` checks nothing (review of #559, C2). */
  readonly foreignChecks: readonly string[];
  /** Modules this file imports, re-exports from, or `import()`s (`'../lib/audit-pickers.js'`). */
  readonly imports: readonly string[];
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

/** One capability call: its name, `line: <text>`, and whether a `can('<name>')` holds this very
 *  site — the branch it runs in, an early return before it, the `disabled` of the control that
 *  fires it, a read hook's own `enabled`, or every place that runs the function holding it
 *  (review of #554 P3-2 and of #559 C1: a check computed anywhere in the same component used to
 *  cover a call it never guarded). */
interface Site {
  readonly name: string;
  readonly where: string;
  readonly held: boolean;
}

/** Whether a call is a check that, when it returns true, allows what is being guarded. `strict`:
 *  the check is tri-state (`useRoleCan` returns `null` while the role is unknown) and only a
 *  definite `true` counts — a read waits for the role (#541), so `!== false` or an early return on
 *  `=== false` lets it through while the role is unknown and is no hold (review of #561, G1). */
type IsCheck = ((call: ts.CallExpression) => boolean) & { readonly strict?: boolean };

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

/** Whether `specifier`, imported from the file at `path`, is this console's `src/<module>`. */
function importsModule(path: string, specifier: ts.Expression, module: string): boolean {
  const text = literalText(specifier);
  if (text === undefined || !text.startsWith('.')) return false;
  return resolve(dirname(path), text).split(sep).join('/').endsWith(`/${module}`);
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

  // Declarations by name, for resolving `call(action)`, `const href = auditHref(…)`, `can` and the
  // functions a guarded call sits in.
  const declarations = new Map<string, ts.Node[]>();
  const uses = new Map<string, ts.Identifier[]>();
  const index = (node: ts.Node) => {
    if (
      (ts.isVariableDeclaration(node) ||
        ts.isParameter(node) ||
        ts.isFunctionDeclaration(node) ||
        ts.isBindingElement(node)) &&
      node.name &&
      ts.isIdentifier(node.name)
    ) {
      declarations.set(node.name.text, [...(declarations.get(node.name.text) ?? []), node]);
    } else if (ts.isIdentifier(node)) {
      uses.set(node.text, [...(uses.get(node.text) ?? []), node]);
    }
    ts.forEachChild(node, index);
  };
  index(source);

  /** `import { useRoleCan } from '…/hooks/useRoleCan.js'` (review of #561, G2). */
  const roleCanImported = source.statements.some(
    (statement) =>
      ts.isImportDeclaration(statement) &&
      importsModule(path, statement.moduleSpecifier, 'hooks/useRoleCan.js') &&
      statement.importClause?.namedBindings !== undefined &&
      ts.isNamedImports(statement.importClause.namedBindings) &&
      statement.importClause.namedBindings.elements.some(
        (element) => element.name.text === 'useRoleCan' && element.propertyName === undefined,
      ),
  );
  /** A `const` — a `let` may be reassigned after its initializer was checked (review of #561,
   *  G3), so only a `const` reads as its initializer. */
  const isConst = (declaration: ts.VariableDeclaration): boolean =>
    (ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const) !== 0;

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

  /** An identifier that reads a variable — not a property name (`x.href`, `{ href: … }`) or a
   *  JSX attribute name that merely spells the same word. */
  const isReference = (identifier: ts.Identifier) => {
    const parent = identifier.parent;
    if (ts.isPropertyAccessExpression(parent) && parent.name === identifier) return false;
    if (ts.isPropertyAssignment(parent) && parent.name === identifier) return false;
    if (ts.isJsxAttribute(parent)) return false;
    if (ts.isBindingElement(parent) && parent.propertyName === identifier) return false;
    // A member of a type (`readonly onPublish: () => …`) names a property, not the variable.
    if (
      (ts.isPropertySignature(parent) || ts.isMethodSignature(parent)) &&
      parent.name === identifier
    ) {
      return false;
    }
    return true;
  };

  /** Whether `expr` being truthy (`want`), or falsy, implies `isCheck` returned true — so the
   *  direction counts: `!canOpen(href) && <a href={href}>` is no check (review of #559, L1/L2).
   *  `x === true` / `x !== false` read as `x`; `x === false` / `x !== true` as `!x`; a variable
   *  reads as its initializer. */
  const implies = (
    expr: ts.Node | undefined,
    want: boolean,
    isCheck: IsCheck,
    depth = 0,
  ): boolean => {
    if (expr === undefined || depth > 6) return false;
    if (
      ts.isParenthesizedExpression(expr) ||
      ts.isAsExpression(expr) ||
      ts.isNonNullExpression(expr)
    ) {
      return implies(expr.expression, want, isCheck, depth);
    }
    if (ts.isPrefixUnaryExpression(expr) && expr.operator === ts.SyntaxKind.ExclamationToken) {
      return implies(expr.operand, !want, isCheck, depth);
    }
    if (ts.isBinaryExpression(expr)) {
      const op = expr.operatorToken.kind;
      const { left, right } = expr;
      if (op === ts.SyntaxKind.AmpersandAmpersandToken) {
        return want
          ? implies(left, true, isCheck, depth) || implies(right, true, isCheck, depth)
          : implies(left, false, isCheck, depth) && implies(right, false, isCheck, depth);
      }
      if (op === ts.SyntaxKind.BarBarToken) {
        return want
          ? implies(left, true, isCheck, depth) && implies(right, true, isCheck, depth)
          : implies(left, false, isCheck, depth) || implies(right, false, isCheck, depth);
      }
      const equal =
        op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.EqualsEqualsToken;
      const unequal =
        op === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
        op === ts.SyntaxKind.ExclamationEqualsToken;
      if (!equal && !unequal) return false;
      const bool = (node: ts.Node) =>
        node.kind === ts.SyntaxKind.TrueKeyword
          ? true
          : node.kind === ts.SyntaxKind.FalseKeyword
            ? false
            : undefined;
      const value = bool(right) ?? bool(left);
      const other = bool(right) !== undefined ? left : bool(left) !== undefined ? right : undefined;
      if (value === undefined || other === undefined) return false;
      const operandWant = equal === value ? want : !want;
      // Against `false`, a tri-state check only learns "not false" — `true` or `null`.
      if (isCheck.strict && value === false && operandWant) return false;
      return implies(other, operandWant, isCheck, depth);
    }
    if (ts.isCallExpression(expr)) return want && isCheck(expr);
    if (ts.isIdentifier(expr)) {
      const declaration = declarationInScope(expr);
      if (declaration !== undefined && ts.isVariableDeclaration(declaration)) {
        return isConst(declaration) && implies(declaration.initializer, want, isCheck, depth + 1);
      }
      // A prop of a component this file does not export: what every `<Component prop={…}>` of
      // the file passes (`canResolve={canResolve}` down to the private body that resolves).
      if (declaration !== undefined && ts.isBindingElement(declaration)) {
        const passed = propValues(declaration);
        return (
          passed !== undefined &&
          passed.length > 0 &&
          passed.every((value) => implies(value, want, isCheck, depth + 1))
        );
      }
    }
    return false;
  };

  /** The name of the component a function is (`function Row(…)`, `const Row = (…) => …`). */
  const componentDeclaration = (
    fn: ts.Node,
  ): ts.FunctionDeclaration | ts.VariableDeclaration | undefined => {
    if (ts.isFunctionDeclaration(fn) && fn.name) return fn;
    if (
      (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) &&
      ts.isVariableDeclaration(fn.parent) &&
      ts.isIdentifier(fn.parent.name)
    ) {
      return fn.parent;
    }
    return undefined;
  };

  /** For a destructured prop of a component the file does not export: the value expression of
   *  that prop at every `<Component …>` in the file (`undefined` when one is missing or not an
   *  expression — then nothing is implied). */
  const propValues = (binding: ts.BindingElement): ts.Expression[] | undefined => {
    if (!ts.isObjectBindingPattern(binding.parent) || !ts.isParameter(binding.parent.parent)) {
      return undefined;
    }
    const component = componentDeclaration(binding.parent.parent.parent);
    if (component === undefined || isExportedTop(component)) return undefined;
    const prop = (binding.propertyName ?? binding.name).getText();
    const name = (component.name as ts.Identifier).text;
    const values: ts.Expression[] = [];
    for (const use of uses.get(name) ?? []) {
      const element = use.parent;
      if (use === component.name || (ts.isJsxClosingElement(element) && element.tagName === use)) {
        continue;
      }
      // Any other use (`const Alias = Row`, `Row({ … })`, `[Row].map(…)`) passes props the scan
      // cannot read, so nothing is implied (review of #561, G4).
      if (
        !(ts.isJsxOpeningElement(element) || ts.isJsxSelfClosingElement(element)) ||
        element.tagName !== use
      ) {
        return undefined;
      }
      const attribute = element.attributes.properties.find(
        (each): each is ts.JsxAttribute => ts.isJsxAttribute(each) && each.name.getText() === prop,
      );
      const value =
        attribute?.initializer && ts.isJsxExpression(attribute.initializer)
          ? attribute.initializer.expression
          : undefined;
      if (value === undefined) return undefined;
      values.push(value);
    }
    return values;
  };

  /** A statement that leaves its block: `return`, `throw`, or a block ending in one. */
  const exits = (statement: ts.Statement): boolean =>
    ts.isReturnStatement(statement) ||
    ts.isThrowStatement(statement) ||
    (ts.isBlock(statement) &&
      statement.statements.length > 0 &&
      exits(statement.statements[statement.statements.length - 1] as ts.Statement));

  const isFunctionValue = (node: ts.Node | undefined): boolean =>
    node !== undefined &&
    (ts.isArrowFunction(node) ||
      ts.isFunctionExpression(node) ||
      // `useCallback(async () => …, deps)`
      (ts.isCallExpression(node) && isFunctionValue(node.arguments[0])));

  const isExportedTop = (declaration: ts.Node) =>
    ts.isSourceFile(declaration.parent) ||
    (ts.isVariableDeclarationList(declaration.parent) &&
      ts.isSourceFile(declaration.parent.parent.parent))
      ? exportedNames.has(
          (declaration as ts.FunctionDeclaration | ts.VariableDeclaration).name?.getText() ?? '',
        )
      : false;

  /**
   * Whether `node` only runs (or, for a link's href value, only reaches the reader) where
   * `isCheck` holds: in the branch of a condition that implies it, after an early return on its
   * failure, as an action of a control `disabled` unless it holds, or inside a function every one
   * of whose uses is held — an exported declaration has uses the file cannot see, so it is not.
   * `values`: also follow a plain variable's uses (an href stored, then rendered).
   */
  const heldBy = (
    node: ts.Node,
    isCheck: IsCheck,
    values: boolean,
    extra: (child: ts.Node, parent: ts.Node) => boolean = () => false,
    following = new Set<ts.Node>(),
    capability?: string,
  ): boolean => {
    const followUses = (declaration: ts.Node, name: ts.Identifier): boolean => {
      // Per path, so two uses reaching the same declaration are both followed; a cycle is not.
      if (following.has(declaration)) return false;
      const path = new Set(following).add(declaration);
      if (isExportedTop(declaration)) return false;
      const refs = (uses.get(name.text) ?? []).filter(
        (use) =>
          use !== name &&
          isReference(use) &&
          declarationInScope(use) === declaration &&
          !runsOtherCapability(use, capability),
      );
      return (
        refs.length > 0 &&
        refs.every((use) => heldBy(use, isCheck, values, extra, path, capability))
      );
    };
    for (let child = node, parent = node.parent; parent; child = parent, parent = parent.parent) {
      if (extra(child, parent)) return true;
      if (ts.isConditionalExpression(parent)) {
        if (child === parent.whenTrue && implies(parent.condition, true, isCheck)) return true;
        if (child === parent.whenFalse && implies(parent.condition, false, isCheck)) return true;
      }
      if (ts.isBinaryExpression(parent) && child === parent.right) {
        const op = parent.operatorToken.kind;
        if (op === ts.SyntaxKind.AmpersandAmpersandToken && implies(parent.left, true, isCheck))
          return true;
        if (op === ts.SyntaxKind.BarBarToken && implies(parent.left, false, isCheck)) return true;
      }
      if (ts.isIfStatement(parent)) {
        if (child === parent.thenStatement && implies(parent.expression, true, isCheck))
          return true;
        if (child === parent.elseStatement && implies(parent.expression, false, isCheck))
          return true;
      }
      if (ts.isBlock(parent) || ts.isSourceFile(parent)) {
        const statements = parent.statements as ts.NodeArray<ts.Statement>;
        const at = statements.indexOf(child as ts.Statement);
        if (
          statements
            .slice(0, Math.max(at, 0))
            .some(
              (earlier) =>
                ts.isIfStatement(earlier) &&
                exits(earlier.thenStatement) &&
                implies(earlier.expression, false, isCheck),
            )
        ) {
          return true;
        }
      }
      // An action of a control that stays disabled unless the check holds.
      if (ts.isJsxAttribute(parent) && ts.isJsxAttributes(parent.parent)) {
        const disabled = parent.parent.properties.find(
          (attribute): attribute is ts.JsxAttribute =>
            ts.isJsxAttribute(attribute) && attribute.name.getText() === 'disabled',
        );
        const value =
          disabled?.initializer && ts.isJsxExpression(disabled.initializer)
            ? disabled.initializer.expression
            : undefined;
        if (value && implies(value, false, isCheck)) return true;
      }
      if (
        ts.isVariableDeclaration(parent) &&
        ts.isIdentifier(parent.name) &&
        child === parent.initializer &&
        (values || isFunctionValue(parent.initializer))
      ) {
        return followUses(parent, parent.name);
      }
      if (ts.isFunctionDeclaration(parent) && parent.name) return followUses(parent, parent.name);
      // A function handed to a component of this file as a prop (`onPublish={() => act(…)}`):
      // held where that component runs it — or, failing that, where the element is rendered.
      if (ts.isJsxExpression(child) && ts.isJsxAttribute(parent) && !values) {
        const binding = propBinding(parent);
        if (binding && followUses(binding, binding.name as ts.Identifier)) return true;
      }
    }
    return false;
  };

  /** A call of a shared function that passes a different capability name than the one being
   *  followed (`act(row, 'deprecate_skill')` when following `publish_skill`) never runs it. */
  const runsOtherCapability = (use: ts.Identifier, capability: string | undefined) => {
    if (capability === undefined) return false;
    const call = use.parent;
    if (!ts.isCallExpression(call) || call.expression !== use) return false;
    const names = call.arguments
      .map((argument) => literalText(argument))
      .filter((text): text is string => text !== undefined && getCapability(text) !== undefined);
    return names.length > 0 && !names.includes(capability);
  };

  /** The destructured prop a JSX attribute feeds, on a component this file declares and does not
   *  export (`<SkillDetailView onPublish={…}>` → `function SkillDetailView({ onPublish })`). */
  const propBinding = (attribute: ts.JsxAttribute): ts.BindingElement | undefined => {
    const element = attribute.parent.parent;
    if (!ts.isJsxOpeningElement(element) && !ts.isJsxSelfClosingElement(element)) return undefined;
    if (!ts.isIdentifier(element.tagName)) return undefined;
    const declaration = declarationInScope(element.tagName);
    if (declaration === undefined || isExportedTop(declaration)) return undefined;
    const fn = ts.isVariableDeclaration(declaration) ? declaration.initializer : declaration;
    if (fn === undefined || !ts.isFunctionLike(fn)) return undefined;
    const props = fn.parameters[0]?.name;
    if (props === undefined || !ts.isObjectBindingPattern(props)) return undefined;
    const prop = attribute.name.getText();
    return props.elements.find(
      (element) =>
        (element.propertyName ?? element.name).getText() === prop && ts.isIdentifier(element.name),
    );
  };

  /** `useRoleCan(…)` — the hook `hooks/useRoleCan` exports, imported under its own name; a
   *  `useRoleCan` the file declares itself checks nothing (review of #561, G2). */
  const isRoleCanCall = (call: ts.CallExpression): boolean =>
    ts.isIdentifier(call.expression) &&
    call.expression.text === 'useRoleCan' &&
    roleCanImported &&
    !declarations.has('useRoleCan');
  /** `can` as the reader's role check: `const can = useRoleCan(…)`, or a parameter typed as one. */
  const isRoleCheck = (callee: ts.Expression): boolean => {
    if (ts.isCallExpression(callee)) return isRoleCanCall(callee);
    if (!ts.isIdentifier(callee)) return false;
    const declaration = declarationInScope(callee);
    if (declaration === undefined) return false;
    if (ts.isVariableDeclaration(declaration)) {
      return (
        isConst(declaration) &&
        declaration.initializer !== undefined &&
        ts.isCallExpression(declaration.initializer) &&
        isRoleCanCall(declaration.initializer)
      );
    }
    return (
      ts.isParameter(declaration) &&
      roleCanImported &&
      !declarations.has('useRoleCan') &&
      /\buseRoleCan\b/.test(declaration.type?.getText() ?? '')
    );
  };
  /** A `can('<name>')` (or `useRoleCan(http)('<name>')`) from the reader's role. */
  const isRead = (name: string) => {
    const capability = getCapability(name);
    return capability !== undefined && !capabilityHasSideEffects(capability);
  };
  /** A role check on `name`; strict for a read (it must wait for the role, review of #561 G1). */
  const checksCapability = (name: string): IsCheck =>
    Object.assign(
      (call: ts.CallExpression) =>
        literalText(call.arguments[0]) === name &&
        (calleeName(call) === 'can' || ts.isCallExpression(call.expression)) &&
        isRoleCheck(call.expression),
      { strict: isRead(name) },
    );

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

  /** A route-table check (`canOpen(<href>)`, `roleMayOpen(role, <href>)`) about the gate `key`. A
   *  bare `canOpen` handed nowhere is not a check (review of #554, P3-1). */
  const asksAbout =
    (key: string | undefined): IsCheck =>
    (call) => {
      const name = calleeName(call) ?? '';
      if (key === undefined || !ASKS.has(name)) return false;
      return routeKey(name === 'roleMayOpen' ? call.arguments[1] : call.arguments[0]) === key;
    };

  /** Whether `node` contains the route check handed on whole (`resourceHref(type, id, canOpen)`). */
  const handsOnCheck = (node: ts.Node): boolean => {
    let found = false;
    const visit = (child: ts.Node) => {
      if (found) return;
      if (ts.isIdentifier(child) && ASKS.has(child.text)) found = true;
      ts.forEachChild(child, visit);
    };
    visit(node);
    return found;
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
   *  `RouteLink`, or where a check about the same gate holds (every use of a variable holding it,
   *  other than the check itself — review of #554, P3-1). */
  const asked = (node: ts.Node): boolean => {
    // `resourceHref(type, id, canOpen)` filters with the reader's check itself.
    if (
      ts.isCallExpression(node) &&
      calleeName(node) === 'resourceHref' &&
      node.arguments.some((argument) => handsOnCheck(argument))
    ) {
      return true;
    }
    return heldBy(
      node,
      asksAbout(routeKey(node)),
      true,
      (child, parent) =>
        (ts.isJsxAttribute(parent) && isRouteLinkHref(parent)) || isAskedHref(child),
    );
  };

  // Names this file exports: `export function`, `export const`, `export { … }`, `export default`.
  const exportedNames = new Set<string>();
  for (const statement of source.statements) {
    const exported =
      ts.canHaveModifiers(statement) &&
      (ts.getModifiers(statement) ?? []).some(
        (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
      );
    if (exported && ts.isFunctionDeclaration(statement) && statement.name) {
      exportedNames.add(statement.name.text);
    } else if (exported && ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) exportedNames.add(declaration.name.text);
      }
    } else if (
      ts.isExportDeclaration(statement) &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause)
    ) {
      for (const element of statement.exportClause.elements) {
        exportedNames.add((element.propertyName ?? element.name).text);
      }
    } else if (ts.isExportAssignment(statement) && ts.isIdentifier(statement.expression)) {
      exportedNames.add(statement.expression.text);
    }
  }

  const calls = new Set<string>();
  const callSites: Site[] = [];
  const aliasedCalls: string[] = [];
  const aliasedHrefs: string[] = [];
  const foreignChecks: string[] = [];
  const imports: string[] = [];
  /** A read hook held by its own `enabled` option (`{ enabled: can('<name>') === true }`). */
  const enabledBy = (call: ts.CallExpression, name: string) =>
    call.arguments.some(
      (argument) =>
        ts.isObjectLiteralExpression(argument) &&
        argument.properties.some(
          (property) =>
            ts.isPropertyAssignment(property) &&
            property.name.getText() === 'enabled' &&
            implies(property.initializer, true, checksCapability(name)),
        ),
    );
  const callSite = (name: string, node: ts.CallExpression, hook = false) => {
    calls.add(name);
    const held =
      (hook && enabledBy(node, name)) ||
      heldBy(node, checksCapability(name), false, undefined, undefined, name);
    callSites.push({ name, where: where(node), held });
  };
  const dynamicCalls: string[] = [];
  const checked = new Set<string>();
  const named: string[] = [];
  const gatedLinks: string[] = [];
  const unaskedLinks: string[] = [];
  let usesIsDenied = false;

  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const module = literalText(node.moduleSpecifier);
      if (module !== undefined) imports.push(module);
    }
    // `import('…')` — the same module, loaded later (review of #559, I3).
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      imports.push(literalText(node.arguments[0]) ?? `<dynamic> ${where(node)}`);
    }
    // `http.call` handed on instead of called (`.bind(http)`, `const call = http.call`),
    // `const { call } = http`, or `http['call'](…)`: the scan would never see what it calls
    // (review of #554 P3-4, of #559 C3).
    if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === 'call' &&
      !(ts.isCallExpression(node.parent) && node.parent.expression === node)
    ) {
      aliasedCalls.push(where(node));
    }
    if (ts.isElementAccessExpression(node) && literalText(node.argumentExpression) === 'call') {
      aliasedCalls.push(where(node));
    }
    if (
      ts.isBindingElement(node) &&
      ts.isObjectBindingPattern(node.parent) &&
      (node.propertyName ?? node.name).getText() === 'call'
    ) {
      aliasedCalls.push(where(node));
    }
    // `import * as router from '…/lib/router.js'`: `router.hrefs.audit()` builds a link the scan
    // does not see (review of #561, G6).
    if (
      ts.isImportDeclaration(node) &&
      importsModule(path, node.moduleSpecifier, 'lib/router.js') &&
      node.importClause?.namedBindings !== undefined &&
      ts.isNamespaceImport(node.importClause.namedBindings)
    ) {
      aliasedHrefs.push(where(node));
    }
    // `hrefs` used other than `hrefs.<name>(…)`: an aliased builder (review of #559, L3–L5) —
    // including `import { hrefs as h }` (review of #561, G5).
    if (
      ts.isIdentifier(node) &&
      node.text === 'hrefs' &&
      isReference(node) &&
      !(
        (ts.isImportSpecifier(node.parent) || ts.isExportSpecifier(node.parent)) &&
        node.parent.name === node &&
        node.parent.propertyName === undefined
      ) &&
      !(ts.isVariableDeclaration(node.parent) && node.parent.name === node) &&
      !(
        ts.isPropertyAccessExpression(node.parent) &&
        node.parent.expression === node &&
        ts.isCallExpression(node.parent.parent) &&
        node.parent.parent.expression === node.parent
      )
    ) {
      aliasedHrefs.push(where(node));
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
          callSite(literal, node, true);
          named.push(literal);
        }
      } else if (name === 'useExecutionReadiness') {
        callSite('execution_readiness', node, true);
      } else if (
        first &&
        (name === 'can' ||
          // `useRoleCan(http)('get_action')`, called on the spot.
          (ts.isCallExpression(node.expression) && calleeName(node.expression) === 'useRoleCan'))
      ) {
        const literal = literalText(first);
        if (literal !== undefined) {
          if (isRoleCheck(node.expression)) checked.add(literal);
          else foreignChecks.push(where(node));
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

  return {
    path,
    calls,
    callSites,
    aliasedCalls,
    aliasedHrefs,
    foreignChecks,
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
    why: "SystemAccessCard's canManage; the catalog's GateOwnedParamsNotice mounts it only when can('refresh_operation_governance') !== false",
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
  'components/CatalogPage.tsx': {
    names: ['update_operation_description'],
    why: "saveDescription runs from the description dialog, opened only behind can('update_operation_description') && mayEditOperationDescription",
  },
  'components/TasksPage.tsx': {
    names: ['cancel_task'],
    why: "the cancel call is TaskDetail's confirm, shown only with canCancel = can('cancel_task') !== false",
  },
  'components/chat/ModelSwitcher.tsx': {
    names: ['set_agent_profile'],
    why: 'the select is disabled by roleRefused once the role is known, and before that by the policy / the 403 this session learned (isDenied)',
  },
  'components/graph/OntologyTypesDrawer.tsx': {
    names: ['discard_draft', 'publish_ontology_version'],
    why: 'the confirm opens only from the button rendered past can(x) === false; `&& !open` keeps an already opened confirm on screen',
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
    names: ['preview_gate_instance_enable', 'preview_gatekeeper_resync'],
    why: "SystemAccessCard's canManage; the catalog's GateOwnedParamsNotice mounts it only after list_available_gate_instances (=== true) found the gate linked, or (legacy 214) found it not linked — a gate the workspace connected itself",
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
  'components/platform/PlatformIntegrationsPage.tsx':
    'a platform page, as above: its own tab in the URL (legacy 380)',
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

/** The role-limited names a file calls at a site no `can('<name>')` holds. */
function unpaired(file: FileScan | undefined, limited: ReadonlySet<string>): string[] {
  if (file === undefined) return [];
  const names = file.callSites
    .filter((site) => limited.has(site.name) && !site.held)
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
      "hold it with `{ enabled: useRoleCan(http)('<name>') === true }`, or call it only where that check holds",
      'READ_GATED_AT_ENTRY',
    );
  });

  it('every write some role may not make is gated on the role where it is offered', () => {
    expectPairedOrAllowed(
      ROLE_LIMITED_WRITES,
      WRITE_GATED_AT_ENTRY,
      "offer it only where `useRoleCan(http)('<name>') !== false` holds at the call (a condition, an early return or a disabled control around it)",
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

  it('`hrefs` is only ever called as `hrefs.<route>(…)` (an alias or `hrefs[…]` hides the link)', () => {
    expect(
      FILES.flatMap(({ path, aliasedHrefs }) => aliasedHrefs.map((site) => `${path}:${site}`)),
      'call `hrefs.<route>(…)` directly',
    ).toEqual([]);
  });

  it('every `can(…)` is the one `useRoleCan` returns (a local `can` decides nothing)', () => {
    expect(
      FILES.flatMap(({ path, foreignChecks }) => foreignChecks.map((site) => `${path}:${site}`)),
      'check with `const can = useRoleCan(http)`',
    ).toEqual([]);
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
  /** A probe file at `src/probe.tsx` that imports the real role hook. */
  const ROLE_CAN_IMPORT = "import { useRoleCan } from './hooks/useRoleCan.js';\n";
  const scanBare = (text: string) => scanFile(join(SRC, 'probe.tsx'), text, GATED_BUILDERS);
  const scan = (text: string) => scanBare(ROLE_CAN_IMPORT + text);
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

  it('a check covers a private component only where every place rendering it is held', () => {
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

  // Review of #559 (the 501 reviewer's probes): each of these got a call past the guard.
  // `set_quota` is a write (held by `!== false`), `audit_query` a read (held only by `=== true`).
  const limited = new Set(['set_quota', 'audit_query']);
  const unheld = (text: string) => unpaired(scan(text), limited);
  const inComponent = (body: string) =>
    `export function A({ http }) {\n  const can = useRoleCan(http);\n${body}\n}`;

  it('a check pairs with the call it holds, not with any call in the same component', () => {
    expect(
      unheld(
        inComponent(
          "  can('set_quota');\n  useEffect(() => { void http.call('set_quota'); }, []);\n  return null;",
        ),
      ),
    ).toEqual(['set_quota']);
    expect(
      unheld(
        inComponent(
          "  return can('set_quota') !== false ? <button onClick={() => http.call('set_quota')} /> : null;",
        ),
      ),
    ).toEqual([]);
  });

  it('a check held the wrong way round holds nothing', () => {
    expect(
      unheld(
        inComponent(
          "  return can('set_quota') === false ? <button onClick={() => http.call('set_quota')} /> : null;",
        ),
      ),
    ).toEqual(['set_quota']);
    expect(
      unheld(
        inComponent(
          "  return can('set_quota') !== false ? null : <button onClick={() => http.call('set_quota')} />;",
        ),
      ),
    ).toEqual(['set_quota']);
    expect(
      unheld(
        inComponent(
          "  if (can('set_quota') !== false) return null;\n  return <button onClick={() => http.call('set_quota')} />;",
        ),
      ),
    ).toEqual(['set_quota']);
    expect(
      unheld(
        inComponent(
          "  if (can('set_quota') === false) return null;\n  return <button onClick={() => http.call('set_quota')} />;",
        ),
      ),
    ).toEqual([]);
    expect(
      unheld(
        inComponent(
          "  return <button disabled={can('set_quota') !== false} onClick={() => http.call('set_quota')} />;",
        ),
      ),
    ).toEqual(['set_quota']);
  });

  it('a read is held only once the role is known: `=== true`, never `!== false` (review of #561, G1)', () => {
    const read = (enabled: string) =>
      unheld(
        inComponent(
          `  const rows = useCapabilityList(http, 'audit_query', {}, { enabled: ${enabled} });\n  return null;`,
        ),
      );
    expect(read("can('audit_query') === true")).toEqual([]);
    expect(read("can('audit_query') !== false")).toEqual(['audit_query']);
    expect(read("!(can('audit_query') === false)")).toEqual(['audit_query']);
    expect(
      unheld(
        inComponent(
          "  if (can('audit_query') === false) return null;\n  useEffect(() => { void http.call('audit_query'); }, []);\n  return null;",
        ),
      ),
    ).toEqual(['audit_query']);
    expect(
      unheld(
        inComponent(
          "  if (can('audit_query') !== true) return null;\n  useEffect(() => { void http.call('audit_query'); }, []);\n  return null;",
        ),
      ),
    ).toEqual([]);
  });

  it('a `can` the file defines itself holds nothing, and is reported', () => {
    const text =
      'function can(name) { return true; }\n' +
      "export function A({ http }) { return can('audit_query') ? <button onClick={() => http.call('audit_query')} /> : null; }";
    expect(unheld(text)).toEqual(['audit_query']);
    expect(scan(text).foreignChecks).toHaveLength(1);
  });

  // Review of #561 (the 501 reviewer's probes G2–G6): each of these got past the guard.
  it('a `useRoleCan` the file declares, or one not imported from hooks/useRoleCan, holds nothing (G2)', () => {
    const body = inComponent(
      "  return can('set_quota') !== false ? <button onClick={() => http.call('set_quota')} /> : null;",
    );
    expect(unpaired(scanBare(body), limited)).toEqual(['set_quota']);
    expect(
      unpaired(scan(`function useRoleCan() { return () => true; }\n${body}`), limited),
    ).toEqual(['set_quota']);
    expect(
      unpaired(scanBare(`import { useRoleCan } from './lib/fake.js';\n${body}`), limited),
    ).toEqual(['set_quota']);
    expect(unheld(body)).toEqual([]);
  });

  it('a `let` reassigned after its check holds nothing; a `const` does (G3)', () => {
    expect(
      unheld(
        inComponent(
          "  let ok = can('set_quota') !== false;\n  ok = true;\n  return ok ? <button onClick={() => http.call('set_quota')} /> : null;",
        ),
      ),
    ).toEqual(['set_quota']);
    expect(
      unheld(
        inComponent(
          "  const ok = can('set_quota') !== false;\n  return ok ? <button onClick={() => http.call('set_quota')} /> : null;",
        ),
      ),
    ).toEqual([]);
  });

  it('a private component also used other than as a JSX tag implies nothing from its props (G4)', () => {
    const row =
      "function Row({ http, allowed }) { return allowed ? <button onClick={() => http.call('set_quota')} /> : null; }";
    const held = inComponent("  return <Row http={http} allowed={can('set_quota') !== false} />;");
    expect(unheld(`${held}\n${row}`)).toEqual([]);
    expect(
      unheld(
        `${held}\nconst Alias = Row;\nexport function B({ http }) { return <Alias http={http} allowed={true} />; }\n${row}`,
      ),
    ).toEqual(['set_quota']);
    expect(
      unheld(
        `${held}\nexport function C({ http }) { return Row({ http, allowed: true }); }\n${row}`,
      ),
    ).toEqual(['set_quota']);
  });

  it('`hrefs` imported under another name, or the router imported as a namespace, is reported (G5, G6)', () => {
    expect(
      scan("import { hrefs as h } from './lib/router.js';\nh.audit();").aliasedHrefs,
    ).toHaveLength(1);
    expect(
      scan("import * as router from './lib/router.js';\nrouter.hrefs.audit();").aliasedHrefs,
    ).toHaveLength(1);
    expect(
      scan("import { hrefs } from './lib/router.js';\nhrefs.audit();").aliasedHrefs,
    ).toHaveLength(0);
  });

  it("`http['call']` is reported like a bound `.call`", () => {
    expect(scan("http['call']('audit_query');").aliasedCalls).toHaveLength(1);
  });

  it('an alias of `hrefs`, or `hrefs[…]`, is reported', () => {
    expect(scan('const h = hrefs; h.audit();').aliasedHrefs).toHaveLength(1);
    expect(scan("hrefs['audit']();").aliasedHrefs).toHaveLength(1);
    expect(scan('const { audit } = hrefs; audit();').aliasedHrefs).toHaveLength(1);
    expect(scan('hrefs.audit();').aliasedHrefs).toHaveLength(0);
  });

  it('a re-export or a dynamic `import()` counts as importing the module', () => {
    expect(scan("export { auditActorSource } from '../lib/audit-pickers.js';").imports).toContain(
      '../lib/audit-pickers.js',
    );
    expect(scan("export * from '../lib/audit-pickers.js';").imports).toContain(
      '../lib/audit-pickers.js',
    );
    expect(
      scan("async function f() { await import('../lib/audit-pickers.js'); }").imports,
    ).toContain('../lib/audit-pickers.js');
  });
});
