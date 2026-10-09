import { lookup } from 'node:dns/promises';
import {
  type OutboundTargetPolicy,
  type OutboundTargetRefusalReason,
  type OutboundTargetResolver,
  decideOutboundTarget,
  describeOutboundTargetRefusal,
  hostPatternProblem,
  parseCidr,
} from '@nexttime/shared';

/**
 * adapters/outbound-target: the kernel's wiring of `@nexttime/shared`'s owner-supplied-URL
 * predicate (`outbound-target.ts` — the rules and why they are what they are live there; R-27,
 * 2026-10-02 review). This module only supplies what the pure predicate leaves out: the policy
 * from the kernel's environment and the real resolver.
 *
 *   - `NEXTTIME_SUBNET_CONTROL`, `NEXTTIME_SUBNET_WORKERS` — the platform's own subnets (the same
 *     values egress-proxy reads; the compose file passes both to the kernel). Unset in a unit
 *     test, which then simply has no subnet rule; a malformed value throws at construction, never
 *     a rule that quietly turned itself off.
 *   - `NEXTTIME_CONNECTION_ALLOW_HOSTS` — optional, comma-separated: hosts an operator allows as a
 *     self-connected gate even though they live on the platform's networks. A name matches itself
 *     and its subdomains; an IP literal only itself. An entry that could never match — notably a
 *     leading `.` / `*.` (fix/egress-suffix-match: the allow-side rule is strict, so such an entry
 *     used to be silently inert) — is logged as an `error` line naming the variable and the fix,
 *     and dropped. Dropped, not read as the bare name: widening an allow-list entry that has never
 *     matched would open the escape hatch for names nobody has seen it open for. Not fatal either,
 *     unlike a malformed subnet: a bad subnet silently loses a deny rule (fail-open), a bad allow
 *     entry only ever failed closed, and refusing to start would stop the whole stack — after an
 *     apply's migrations have already committed — over an entry that never allowed anything.
 *   - `NEXTTIME_CONNECTION_FIXTURE_HOSTS` — a constant the compose file sets: the acceptance
 *     fixtures (`accept-s2-*`) `scripts/accept_s2.sh` / `drill-add-gatekeeper.sh` connect through
 *     `create_connection`. Allowing them permanently grants nothing — they resolve only while their
 *     compose profile runs, hold no `gate_token`, and accept only a connection secret bound to the
 *     acceptance workspace — and it means a host acceptance run never restarts the kernel.
 *     `scripts/validate-compose.mjs` keeps every name on it an `accept-*` fixture service.
 *   The policy allows the union of the two lists.
 *
 * Callers: `create_connection` (its `endpoint` and `manifestSource`, before any fetch) and
 * `HttpGatekeeperClient` (every call to a self-connected gate — a `connection` / `none` credential
 * target; a gate the kernel provisioned is not owner-supplied and skips this).
 */

/** Refusal of an owner-supplied URL. `url` is the full URL the caller supplied; the message names
 *  only its host. Mapped to 400 `connection_target_refused` by the interfaces when it reaches them
 *  directly (`create_connection`). */
export class OutboundTargetRefusedError extends Error {
  readonly code = 'connection_target_refused' as const;
  readonly reason: OutboundTargetRefusalReason;
  readonly url: string;
  constructor(url: string, reason: OutboundTargetRefusalReason, host: string, subject = 'URL') {
    super(
      `${subject} ${host ? `"${host}"` : `"${url}"`} is refused: ${describeOutboundTargetRefusal(reason)}`,
    );
    this.name = 'OutboundTargetRefusedError';
    this.reason = reason;
    this.url = url;
  }
}

/** Throws `OutboundTargetRefusedError` unless `url` is an acceptable owner-supplied target.
 *  `subject` names the field in the message ("endpoint", "manifestSource"). */
export type OutboundTargetGuard = (url: string, subject?: string) => Promise<void>;

function splitList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** The policy the kernel's environment describes (see the module doc comment). */
export function outboundTargetPolicyFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): OutboundTargetPolicy {
  const subnets = [env.NEXTTIME_SUBNET_CONTROL, env.NEXTTIME_SUBNET_WORKERS]
    .map((value) => value?.trim())
    .filter((value): value is string => value !== undefined && value.length > 0);
  const allowHosts: string[] = [];
  for (const name of ['NEXTTIME_CONNECTION_ALLOW_HOSTS', 'NEXTTIME_CONNECTION_FIXTURE_HOSTS']) {
    for (const entry of splitList(env[name])) {
      const problem = hostPatternProblem(entry);
      if (problem) {
        console.error(
          JSON.stringify({
            level: 'error',
            msg: `outbound-target: ${name} entry "${entry}" ${problem} — ignored (it never matched a host)`,
          }),
        );
        continue;
      }
      allowHosts.push(entry);
    }
  }
  return {
    platformSubnets: subnets.map((cidr) => parseCidr(cidr)),
    allowHosts,
  };
}

/** Every address `hostname` resolves to, through the OS resolver (what `fetch` itself uses). */
export const systemOutboundTargetResolver: OutboundTargetResolver = async (hostname) => {
  const results = await lookup(hostname, { all: true, verbatim: true });
  return results.map((result) => result.address);
};

export interface OutboundTargetGuardOptions {
  /** Defaults to `outboundTargetPolicyFromEnv(process.env)`, read once, here. */
  readonly policy?: OutboundTargetPolicy;
  /** Defaults to `systemOutboundTargetResolver`. */
  readonly resolve?: OutboundTargetResolver;
}

export function createOutboundTargetGuard(
  options: OutboundTargetGuardOptions = {},
): OutboundTargetGuard {
  const policy = options.policy ?? outboundTargetPolicyFromEnv();
  const resolve = options.resolve ?? systemOutboundTargetResolver;
  return async (url, subject) => {
    const decision = await decideOutboundTarget(url, policy, resolve);
    if (!decision.allowed) {
      throw new OutboundTargetRefusedError(url, decision.reason, decision.host, subject);
    }
  };
}

/** A `fetch` that refuses to follow redirects — every fetch of an owner-supplied URL uses one, so a
 *  URL that passed the guard cannot hand the kernel a `Location:` pointing anywhere else. */
export function withoutRedirects(fetchImpl: typeof fetch): typeof fetch {
  return (input, init) => fetchImpl(input, { ...init, redirect: 'error' });
}
