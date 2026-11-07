import type { Counter } from '@nexttime/shared';
import { MetricsRegistry, actingThroughForSessionKind } from '@nexttime/shared';
import type { PoolLike } from '../../adapters/db/pool.js';
import { withWorkspace } from '../../adapters/db/pool.js';
import { ADMIN_AGENT_SESSION_KIND } from '../../governance/capability/index.js';
import type { ActingContext, ActingContextHandle } from '../../substrate/audit/index.js';
import { writeAudit } from '../../substrate/audit/index.js';
import type { CallRefusalReason } from './authorize.js';

/**
 * application/gateway/call-refusals: what becomes of a call `authorizeCapabilityCall` (or a
 * Handle's `assertActsForPerson`) refuses (batch D3, docs/test-coverage-gaps-2026-11-06.md G10/G11;
 * decided by the coordinating thread 2026-11-07):
 *
 *   - **a person's** (human channel, platform channel): as before — a 403, the transport's request
 *     log, no audit row — now also counted;
 *   - **a Handle's**: an audit row, `outcome: 'refused'`, written in its own transaction like the
 *     admin agent's refusals (AA1, dispatch.ts `auditAdminAgentRefusal`), since nothing else of the
 *     call is written. An agent that loops on a refused call would otherwise write one row per try,
 *     so rows are limited per session, capability and reason: the first
 *     {@link REFUSAL_AUDIT_LIMIT} in an hour are written; the rest are counted, and logged twice —
 *     once when the limit is reached, once with the number held back when that hour is over.
 *
 * The limit lives in this process: a restart starts every hour afresh. It keeps a looping agent
 * from flooding `audit_records`, it is not a quota, so losing the count on restart costs at most
 * another {@link REFUSAL_AUDIT_LIMIT} rows.
 *
 * Every refusal, written or not, is counted on `/internal/metrics`:
 * `nexttime_capability_refusals_total{channel, capability, reason, audit}` — `audit` is `written`,
 * `held_back` (over the limit), `failed` (the write failed; logged) or `none` (a person's).
 */

/** Audit rows per session, capability and reason in one {@link REFUSAL_AUDIT_WINDOW_MS}. */
export const REFUSAL_AUDIT_LIMIT = 20;
export const REFUSAL_AUDIT_WINDOW_MS = 60 * 60 * 1000;
/** Windows kept at once; past it the expired ones go first, then the oldest. */
const MAX_REFUSAL_WINDOWS = 10_000;
/** At most this many param keys are recorded on a refusal row; each at most 64 characters. */
const MAX_RECORDED_PARAM_KEYS = 32;
const RECORDABLE_PARAM_KEY = /^[A-Za-z0-9_.-]{1,64}$/;

const metrics = new MetricsRegistry();
const refusals: Counter = metrics.counter(
  'nexttime_capability_refusals_total',
  'Capability calls refused by authorization (role, channel, Handle scope, person-only), by whether an audit row was written.',
  ['channel', 'capability', 'reason', 'audit'],
);

type RefusalAudit = 'written' | 'held_back' | 'failed' | 'none';

function countRefusal(
  channel: string,
  capability: string,
  reason: CallRefusalReason,
  audit: RefusalAudit,
): void {
  refusals.inc({ channel, capability, reason, audit });
}

/** `/internal/metrics`' share from this module (the composition root concatenates it). */
export function renderCallRefusalMetrics(): string {
  return metrics.render();
}

/** Current value of one counter series — for tests. */
export function callRefusalCount(labels: {
  channel: string;
  capability: string;
  reason: CallRefusalReason;
  audit: RefusalAudit;
}): number {
  return refusals.get(labels);
}

export interface RefusalWindow {
  startedAt: number;
  written: number;
  heldBack: number;
}

type Admission =
  | { readonly admit: true }
  | { readonly admit: false; readonly limitReached: boolean; readonly until: number };

/**
 * The per-key fixed hour (see this module's doc comment). `now` is injectable for tests. A window
 * that held refusals back reports how many when it is replaced — by the key's next refusal after
 * the hour, or by eviction — through `onWindowClosed`.
 */
export interface RefusalAuditLimiterOptions {
  readonly limit?: number;
  readonly windowMs?: number;
  readonly maxWindows?: number;
  readonly now?: () => number;
  readonly onWindowClosed?: (key: string, window: Readonly<RefusalWindow>) => void;
}

export class RefusalAuditLimiter {
  private readonly windows = new Map<string, RefusalWindow>();
  private readonly options: RefusalAuditLimiterOptions;

  constructor(options: RefusalAuditLimiterOptions = {}) {
    this.options = options;
  }

  private get limit(): number {
    return this.options.limit ?? REFUSAL_AUDIT_LIMIT;
  }

  private get windowMs(): number {
    return this.options.windowMs ?? REFUSAL_AUDIT_WINDOW_MS;
  }

  private close(key: string, window: RefusalWindow): void {
    this.windows.delete(key);
    if (window.heldBack > 0) this.options.onWindowClosed?.(key, window);
  }

  private makeRoom(now: number): void {
    const max = this.options.maxWindows ?? MAX_REFUSAL_WINDOWS;
    if (this.windows.size < max) return;
    for (const [key, window] of this.windows) {
      if (now - window.startedAt >= this.windowMs) this.close(key, window);
    }
    // Insertion order is age order: a key is re-inserted only when its window restarts.
    for (const [key, window] of this.windows) {
      if (this.windows.size < max) break;
      this.close(key, window);
    }
  }

  admit(key: string): Admission {
    const now = (this.options.now ?? Date.now)();
    let window = this.windows.get(key);
    if (window !== undefined && now - window.startedAt >= this.windowMs) {
      this.close(key, window);
      window = undefined;
    }
    if (window === undefined) {
      this.makeRoom(now);
      window = { startedAt: now, written: 0, heldBack: 0 };
      this.windows.set(key, window);
    }
    if (window.written < this.limit) {
      window.written += 1;
      return { admit: true };
    }
    window.heldBack += 1;
    return {
      admit: false,
      limitReached: window.heldBack === 1,
      until: window.startedAt + this.windowMs,
    };
  }
}

function logLine(message: string): void {
  console.error(message.replace(/\n|\r/g, ''));
}

const limiter = new RefusalAuditLimiter({
  onWindowClosed(key, window) {
    logLine(
      `[kernel] handle call refusals held back from the audit: ${window.heldBack} more than the ${REFUSAL_AUDIT_LIMIT} audited for ${key} in the hour from ${new Date(window.startedAt).toISOString()}`,
    );
  },
});

/** The param names a refused call carried, never their values: a refused call's params were not
 *  validated (authorization runs first, before even the params budget), so they are recorded only
 *  as names, and only names that read as one — the first {@link MAX_RECORDED_PARAM_KEYS} such, in
 *  the order the call sent them, then sorted. The scan stops there: a refused call with a huge
 *  object costs no more than one with 32 keys (#1028 review). */
export function refusedParamKeys(rawParams: unknown): {
  readonly paramKeys: readonly string[];
  readonly paramKeysOmitted?: number;
} {
  if (rawParams === null || typeof rawParams !== 'object' || Array.isArray(rawParams)) {
    return { paramKeys: [] };
  }
  const all = Object.keys(rawParams);
  const paramKeys: string[] = [];
  for (const key of all) {
    if (paramKeys.length === MAX_RECORDED_PARAM_KEYS) break;
    if (RECORDABLE_PARAM_KEY.test(key)) paramKeys.push(key);
  }
  paramKeys.sort();
  const omitted = all.length - paramKeys.length;
  return omitted > 0 ? { paramKeys, paramKeysOmitted: omitted } : { paramKeys };
}

/** A person's refusal (human or platform channel): counted, nothing written. */
export function countPersonRefusal(
  channel: 'human' | 'platform',
  capability: string,
  reason: CallRefusalReason,
): void {
  countRefusal(channel, capability, reason, 'none');
}

/**
 * The acting context of a Handle call issued under a session of `sessionKind` (`sessions.kind`),
 * or `undefined` when no Handle is issued under that kind.
 */
export function actingContextForHandle(
  sessionKind: string | undefined,
  sessionId: string,
): ActingContext | undefined {
  const actingThrough = actingThroughForSessionKind(sessionKind);
  return actingThrough === undefined ? undefined : { actingThrough, actingSessionId: sessionId };
}

/**
 * A Handle's refused call: the audit row (within {@link REFUSAL_AUDIT_LIMIT}) in its own
 * transaction, and the count. Reads the Handle's session kind there first and sets the call's
 * acting context from it — the refusal came before dispatch read it — unless the call already knew
 * it (`sessionKind` given: a refusal inside the call's own transaction). Never throws: a failed
 * write is logged and counted, and the refusal itself stands.
 */
export async function auditHandleCallRefusal(
  deps: { readonly pool: PoolLike },
  call: {
    readonly workspaceId: string;
    readonly principalId: string;
    readonly sessionId: string;
    readonly capability: string;
    readonly reason: CallRefusalReason;
    readonly rawParams: unknown;
    readonly acting: ActingContextHandle;
    readonly sessionKind?: string;
  },
): Promise<void> {
  const key = `session ${call.sessionId}, capability ${call.capability}, reason ${call.reason}`;
  const admission = limiter.admit(key);
  if (!admission.admit) {
    countRefusal('handle', call.capability, call.reason, 'held_back');
    if (admission.limitReached) {
      logLine(
        `[kernel] handle call refusals reached the audit limit (${REFUSAL_AUDIT_LIMIT} an hour) for ${key}; further ones are counted, not audited, until ${new Date(admission.until).toISOString()}`,
      );
    }
    return;
  }
  try {
    await withWorkspace(
      deps.pool,
      { workspaceId: call.workspaceId, principalId: call.principalId },
      async (client) => {
        let sessionKind = call.sessionKind;
        if (sessionKind === undefined) {
          const session = await client.query<{ kind: string }>(
            'select kind from sessions where workspace_id = $1 and id = $2',
            [call.workspaceId, call.sessionId],
          );
          sessionKind = session.rows[0]?.kind;
          call.acting.set(actingContextForHandle(sessionKind, call.sessionId));
        }
        await writeAudit(client, {
          workspaceId: call.workspaceId,
          actorPrincipalId: call.principalId,
          action: call.capability,
          payload: {
            channel: 'handle',
            onBehalfOf: call.principalId,
            // The same two fields every other row of an admin agent's call carries (AA1).
            ...(sessionKind === ADMIN_AGENT_SESSION_KIND
              ? { sessionKind: ADMIN_AGENT_SESSION_KIND, sessionId: call.sessionId }
              : {}),
            ...refusedParamKeys(call.rawParams),
            outcome: 'refused',
            refusal: { code: 'forbidden', status: 403, reason: call.reason },
          },
        });
      },
    );
    countRefusal('handle', call.capability, call.reason, 'written');
  } catch (auditErr) {
    countRefusal('handle', call.capability, call.reason, 'failed');
    const detail = auditErr instanceof Error ? auditErr.message : String(auditErr);
    logLine(
      `[kernel] audit of a refused handle call failed (capability=${call.capability}, reason=${call.reason}): ${detail}`,
    );
  }
}
