import type { Capability } from '@nexttime/shared';
import { roleSatisfiesMinRole } from '../../governance/capability/index.js';
import type { ResolvedCaller } from './caller.js';

/**
 * application/gateway/authorize: decides whether a `ResolvedCaller` may invoke one capability
 * (design doc §9.3 Capability contract, §5.1.1 Role, I13/I16/I17; docs/development-tasks.md
 * S1.3, item 3 "Authorization is decided from the shared registry"). Pure, no IO — every input is
 * already in hand by the time this runs.
 *
 * Channel admission (assumption — see PR body "假设"): `Capability.channel` in
 * packages/shared/src/capabilities.ts names a single value, but its own doc comment (enums.ts:
 * "human (web/API-key) vs handle (agent Handle, MCP/tool calls)") reads as "who typically uses
 * this channel", not an exclusive whitelist — and the task brief's own worked example only rejects
 * one direction ("human-only capability via a Handle → 403"), never the reverse. Combined with
 * `governance/capability/handles.ts`'s `assertValidScope` already rejecting any `channel:'human'`
 * capability from ever appearing in a Handle's scope (I16/I17: those capabilities publish platform
 * meta-objects or perform owner-only governance actions), the coherent reading is: `channel:
 * 'human'` capabilities are exclusively human; `channel:'handle'` capabilities are available to
 * *both* channels (a human/API-key caller — e.g. a future web "explain" or audit view — is at
 * least as trusted as a Handle, so it may call anything a Handle could). A Handle caller is
 * additionally narrowed by its own `scope.capabilities` (I13 "Handle 范围大于其来源" is a ceiling,
 * not a floor).
 *
 * Role hierarchy (assumption — see PR body "假设"): design doc §5.1.1 frames Role as "which door,"
 * not a linear ladder, and `owner` (§5.1.1: "授权与策略") is described as the tenant-root role —
 * consistent with the bootstrap CLI (item 6) creating the very first Principal as `owner`, who
 * must therefore be able to call every `minRole`-gated capability including `member`-level chat
 * (S1.4/S1.8 depend on this). Naively ranking `ROLE_VALUES`'s declared order (`owner > builder >
 * operator > member > auditor`) would let a `member` satisfy `minRole:'auditor'` (`audit_query`
 * etc.) purely by index comparison — wrong, since `auditor` is deliberately the one role scoped to
 * secret-including read access (§5.1.1 "只读含密钥元数据"), not the bottom rung everyone else
 * outranks. The rule implemented here: `owner` always satisfies every `minRole` (super-role);
 * every other role satisfies `minRole:'member'` (§5.1.1 "对话、调用、观察" — the operational floor
 * every principal needs regardless of specialization) or an exact match to its own role; nothing
 * else. This is exactly what makes "member 调 grant_capability 403" (minRole:'owner') hold, while
 * also keeping `builder`/`operator`/`auditor` able to use the base graph/chat capabilities.
 */

export class ForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ForbiddenError';
  }
}

/** Re-exported from governance (`governance/capability/roles.ts`, W5.5) so existing importers and
 *  `authorize.test.ts` keep working; the rule itself now lives one layer down because Handle
 *  issuance applies it too (see `authorizeCapabilityCall`'s doc comment). */
export { roleSatisfiesMinRole };

/**
 * Authorizes `caller` to invoke `capability`. Throws `ForbiddenError` (→ HTTP 403) if not — never
 * returns a boolean, so a call site cannot forget to check the result.
 *
 * **`minRole` on the handle channel is enforced at issuance, not here** (W5.5, STATUS leftover 18;
 * previously a documented gap — see this file's git history for the original ~40-line note). The
 * `channel === 'handle'` branch below still checks scope membership only, on purpose: this
 * function is pure/no-IO and a Handle's claims carry no role. What changed is the *ceiling*: every
 * entry Handle is now issued through `governance/capability/handles.ts`'s `entryScope({ role })`,
 * which drops from `ENTRY_CEILING_CAPABILITIES` every capability whose `minRole` the on-behalf-of
 * Principal's role does not satisfy (the same `roleSatisfiesMinRole` rule the human branch uses,
 * moved to governance so both layers share it). Both production issuers pass the role —
 * `application/host-bridge/agent-host-runtime.ts`'s `ensureEntryHandle` (resolved from the
 * principals row, and part of its cache-freshness key) and `issue-handle-handler.ts` (from the
 * calling Principal). `computeChildHandleScope` (application/task/handle-mint.ts) intersects a
 * Worker's scope with its parent's, so a `member`'s Workers inherit the same narrowing. A
 * `set_principal_role` change revokes the principal's entry-session Handles so the narrowing (or
 * widening) takes effect on the next Turn rather than at ttl. `authorize.test.ts`'s "does not
 * apply minRole to handle callers — scope alone governs" case therefore still holds: scope is the
 * whole contract here, and the scope is what became role-aware.
 */
export function authorizeCapabilityCall(caller: ResolvedCaller, capability: Capability): void {
  // P-A1 (docs/platform-admin-design.md §7): the platform plane is its own channel. A
  // `scope:'platform'` capability is reachable only by a platform caller (a console session whose
  // user is `platform_role = 'admin'`, resolved as such by resolve-caller.ts), and a platform
  // caller can reach nothing else — it has no workspace to act in. Principals and Handles get
  // 403 here regardless of role or scope.
  if (capability.scope === 'platform') {
    if (caller.channel !== 'platform') {
      throw new ForbiddenError(`capability "${capability.name}" requires a platform administrator`);
    }
    return;
  }
  if (caller.channel === 'platform') {
    throw new ForbiddenError(
      `capability "${capability.name}" is workspace-scoped; select a workspace to call it`,
    );
  }

  if (capability.channel === 'human' && caller.channel !== 'human') {
    throw new ForbiddenError(`capability "${capability.name}" is human-channel-only`);
  }

  if (caller.channel === 'handle') {
    if (!caller.claims.scope.capabilities.includes(capability.name)) {
      throw new ForbiddenError(
        `capability "${capability.name}" is not in the calling handle's scope`,
      );
    }
    return;
  }

  if (!roleSatisfiesMinRole(caller.principal.role, capability.minRole)) {
    throw new ForbiddenError(
      `principal role "${caller.principal.role}" does not satisfy capability "${capability.name}"'s minRole "${capability.minRole}"`,
    );
  }
}
