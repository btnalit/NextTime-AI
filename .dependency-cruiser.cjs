/**
 * Enforces the six-layer kernel dependency rule and the module contract from
 * docs/graph-ai-middle-platform-design.md §7.10:
 *
 *   domain (packages/shared) <- substrate <- governance <- application <- adapters/interfaces
 *
 * plus:
 *   - adapters may be imported only by application and interfaces (they implement ports
 *     declared by those upper layers).
 *   - application/chat and application/host-bridge must never import governance/approval or
 *     application/task — they consume domain events and read-only views instead.
 *   - no package may reach into another package's internal src/ files; only the published
 *     @nexttime/<pkg> entry point is a legal cross-package import.
 *
 * Run: `pnpm depcruise` (root script) / `make depcruise`.
 */

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'warn',
      comment:
        'Circular imports make the six-layer rule meaningless — flagged, not yet hard-failed.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'shared-domain-has-no-internal-deps',
      severity: 'error',
      comment:
        'packages/shared is the domain layer (§7.10): it must not depend on any other @nexttime package.',
      from: { path: '^packages/shared/src/' },
      to: { path: '^packages/(?!shared/)[^/]+/src/' },
    },
    {
      name: 'kernel-substrate-may-only-depend-on-domain',
      severity: 'error',
      comment:
        'substrate (ontology/graph/epistemic/audit) may not depend on governance/application/adapters/interfaces.',
      from: { path: '^packages/kernel/src/substrate/' },
      to: { path: '^packages/kernel/src/(governance|application|adapters|interfaces)/' },
    },
    {
      name: 'kernel-governance-may-not-depend-on-upper-layers',
      severity: 'error',
      comment:
        'governance (capability/policy/approval/connections/llm-usage) may not depend on application/adapters/interfaces.',
      from: { path: '^packages/kernel/src/governance/' },
      to: { path: '^packages/kernel/src/(application|adapters|interfaces)/' },
    },
    {
      name: 'kernel-application-may-not-depend-on-interfaces',
      severity: 'error',
      comment:
        'application (chat/task/host-bridge/worker) may not depend on interfaces; it may depend on adapters only through the ports those adapters implement.',
      from: { path: '^packages/kernel/src/application/' },
      to: { path: '^packages/kernel/src/interfaces/' },
    },
    {
      name: 'kernel-adapters-imported-only-by-application-or-interfaces',
      severity: 'error',
      comment:
        'adapters implement ports declared by application/interfaces (§7.10) — substrate and governance must not import them directly.',
      from: { path: '^packages/kernel/src/(substrate|governance)/' },
      to: { path: '^packages/kernel/src/adapters/' },
    },
    {
      name: 'kernel-interfaces-must-not-reach-into-substrate-directly',
      severity: 'error',
      comment:
        'interfaces (http/ws/mcp/explorer-contract) depend on application and governance service interfaces, not substrate directly (§7.10 table).',
      from: { path: '^packages/kernel/src/interfaces/' },
      to: { path: '^packages/kernel/src/substrate/' },
    },
    {
      name: 'chat-and-host-bridge-must-not-import-approval-or-task',
      severity: 'error',
      comment:
        'chat and web only consume events and read-only views, never governance/approval or application/task directly (§7.10 rule paragraph). ' +
        'application/linkage (S2.11) is the one place allowed to read both — it exists precisely ' +
        'so chat/host-bridge never have to — so it is included here too: chat/host-bridge must ' +
        'not reach approval/task transitively through it either.',
      from: { path: '^packages/kernel/src/application/(chat|host-bridge)/' },
      to: {
        path: '^packages/kernel/src/(governance/approval|application/task|application/linkage)/',
      },
    },
    {
      name: 'no-cross-package-internal-import',
      severity: 'error',
      comment:
        "A package may only be consumed via its @nexttime/<pkg> entry point, never by reaching into " +
        "another package's src/ directly. Every workspace package's `exports` field (package.json) " +
        "resolves the bare `@nexttime/<pkg>` specifier straight to that package's own `src/index.ts` " +
        "under the `types`/`development` conditions (so typecheck and tests run against source, no " +
        "build required first) — with `tsPreCompilationDeps` on, dependency-cruiser's own resolver " +
        "follows that same condition and legitimately lands on `src/index.ts` for a plain package-root " +
        "import, which is exempted below. A deeper path (`@nexttime/<pkg>/src/...`) is not published in " +
        "`exports` at all and cannot resolve there through package resolution, so anything that does " +
        "land elsewhere under another package's `src/` only got there via a forbidden deep import.",
      from: { path: '^packages/([^/]+)/src/' },
      to: {
        path: '^packages/(?!$1/)[^/]+/src/',
        pathNot: '^packages/(?!$1/)[^/]+/src/index\\.ts$',
      },
    },
  ],
  options: {
    doNotFollow: {
      path: 'node_modules',
    },
    exclude: {
      // Test files are integration harnesses, not part of the layered production import graph —
      // e.g. packages/kernel/src/substrate/invariants.test.ts legitimately drives real Postgres
      // through adapters/db/{pool,migrate}.ts to verify RLS/trigger invariants, which the
      // substrate layer's own (non-test) source must never do (§7.10 six-layer rule below).
      path: '(^|/)(dist|node_modules)/|\\.test\\.tsx?$',
    },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'types', 'node', 'default'],
      mainFields: ['types', 'main'],
      extensions: ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json'],
    },
    tsConfig: {
      fileName: 'tsconfig.base.json',
    },
  },
};
