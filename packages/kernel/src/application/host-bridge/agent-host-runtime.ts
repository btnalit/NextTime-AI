import type {
  AgentHostToKernelFrame,
  AgentRuntimeEventWire,
  KernelToAgentHostFrame,
} from '@nexttime/shared';
import type { CryptoKey } from 'jose';
import type { PoolLike } from '../../adapters/db/pool.js';
import { withWorkspace } from '../../adapters/db/pool.js';
import type { EffectiveAgentProfile } from '../../governance/agent-profile/index.js';
import {
  readAgentPolicy,
  readAgentProfile,
  resolveEffectiveAgentProfile,
} from '../../governance/agent-profile/index.js';
import {
  entryScope,
  issueHandle,
  listActiveGrantResourceScopes,
} from '../../governance/capability/index.js';
import { GATEKEEPER_RESOURCE_SCOPE_KEY } from '../../governance/policy/index.js';
import {
  getPublishedEntryDefinition,
  listPublishedSkillIds,
  renderSkillMarkdownFile,
  resolvePublishedSkills,
} from '../worker/index.js';
import type {
  AgentRuntime,
  AgentRuntimeEvent,
  AgentRuntimeEventSink,
  StartTurnInput,
} from './agent-runtime.js';

/**
 * application/host-bridge/agent-host-runtime: `AgentHostRuntime`, the real `AgentRuntime`
 * implementation over agent-host's WebSocket (design doc §7.2, §7.10 "pi 是唯一计划的实现";
 * docs/development-tasks.md S1.5, second half). Wired by `packages/kernel/src/index.ts` when
 * `AGENT_RUNTIME=agent-host`; `FakeAgentRuntime` (fake-runtime.ts) remains the default and stays
 * fully functional.
 *
 * Transport split (mirrors why `FakeAgentRuntime` needs no transport at all): this class owns
 * every piece of *protocol* state — which turns are in flight, which are waiting on a
 * `turnAccepted`/`turnRejected` acknowledgement, the entry Handle cache — but never touches a
 * socket itself. `interfaces/ws/agent-host.ts` (interfaces layer) owns the one raw WebSocket
 * connection agent-host makes to `/internal/agent-host`, parses/validates every inbound frame
 * (zod, `@nexttime/shared`'s `AgentHostToKernelFrameSchema`) before calling `handleFrame` here,
 * and implements `AgentHostLink.send` as a thin `socket.send(JSON.stringify(frame))`. This keeps
 * the dependency direction the six-layer rule already requires (interfaces -> application, never
 * the reverse — .dependency-cruiser.cjs `kernel-application-may-not-depend-on-interfaces`): this
 * file exports the `AgentHostLink` port `interfaces/ws/agent-host.ts` implements, the same way
 * `agent-runtime.ts` exports `AgentRuntimeEventSink` for `application/chat` to implement.
 *
 * Entry session + Handle bootstrap (architecture point 2): `startTurn` ensures a `kind='entry'`
 * session for the calling principal (mirrors application/gateway/auth.ts's
 * `createOrReuseWebSession` one level down — see `ensureEntrySession`'s own doc comment for the
 * "no separate agent Principal" assumption) and issues/reuses an entry Capability Handle
 * (`governance/capability/handles.ts` `issueHandle` + `entryScope()`) via a per-principal
 * in-memory cache, reissuing once less than 10% of its ttl remains. The Handle travels to
 * agent-host only inside the `startTurn` command frame and is never logged by this class (every
 * structured log line below carries `turnId`/`principalId`/a reason string, never `handle`).
 *
 * Failure contract (matches `AgentRuntime.startTurn`'s own doc comment): `startTurn` never
 * throws. No agent-host connected or a Handle/session bootstrap failure are resolved synchronously
 * (before the command frame would even exist to send) and reported via one `turnEnded
 * {status:'failed'}` event before `startTurn` returns; a `link.send` failure is the same. A
 * `turnAccepted` timeout or an explicit `turnRejected`, by contrast, are *not* awaited by
 * `startTurn` itself (lane-4 P2 fix, docs/development-tasks.md — see `sendStartTurnFrame`'s own
 * doc comment for why) — `startTurn` resolves as soon as the command frame is sent, and the same
 * `turnEnded {status:'failed'}` event is emitted later, asynchronously, once the accept/reject/
 * timeout outcome is known. Either way, `application/host-bridge/turn-started-consumer.ts`'s
 * caller still has exactly one path to observe a Turn's outcome, per the port's own contract —
 * only the *timing* relative to `startTurn`'s own resolution has changed.
 *
 * agent-host restart vs. a mere reconnect (design doc §13 "agent-host 重启 | 入口容器不受影响；事件桥
 * 重连并从最后确认的事件续读；对话在 Postgres 无损"): agent-host is a single Node process with no
 * durable memory of its own turn bookkeeping — a WebSocket reconnect from the *same* live process
 * (e.g. a network blip) should not disturb turns this runtime still considers active, since
 * agent-host's own attached container streams and turn tracking survived; a reconnect after a
 * genuine process *restart* means agent-host has lost all of that and will never report on those
 * turns again. The two are told apart by `instanceId` on the `hello` frame (a `randomUUID()`
 * agent-host generates once per process, not per connection, per agent-host-protocol.ts's own doc
 * comment) — see `handleHello`.
 */

const DEFAULT_ENTRY_HANDLE_TTL_SECONDS = 24 * 60 * 60;
const DEFAULT_TURN_ACCEPTED_TIMEOUT_MS = 30_000;
/** Reissue a cached entry Handle once less than this fraction of its total ttl remains
 *  (architecture point 2: "reissue when < 10% left"). */
const HANDLE_REISSUE_THRESHOLD = 0.1;

/** The port `interfaces/ws/agent-host.ts` implements for the one currently-connected agent-host
 *  WebSocket — see this module's own doc comment for why the split exists. */
export interface AgentHostLink {
  send(frame: KernelToAgentHostFrame): void;
}

export interface AgentHostRuntimeDeps {
  readonly pool: PoolLike;
  readonly sink: AgentRuntimeEventSink;
  /** The kernel's own Handle-signing private key (governance/capability/keys.ts
   *  `loadHandleKeyPair`) — this runtime only ever issues Handles, never verifies one, so it
   *  never needs the public half. */
  readonly privateKey: CryptoKey;
  /** Forwarded verbatim as every `startTurn` command's `kernelLlmUrl` — the kernel already knows
   *  the configured `KERNEL_LLM_URL`; agent-host does not form its own opinion about it. */
  readonly kernelLlmUrl: string;
  readonly entryHandleTtlSeconds?: number;
  readonly turnAcceptedTimeoutMs?: number;
  readonly now?: () => number;
  /** Structured logger for warnings/failures only — never receives a Handle token or prompt text.
   *  Defaults to `console.error`. */
  readonly log?: (line: string) => void;
}

interface ActiveTurn {
  readonly workspaceId: string;
  readonly chatId: string;
  readonly principalId: string;
}

interface CachedHandle {
  readonly token: string;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
  /** The `resources.gatekeeper` ids baked into this cached Handle at issuance (S2.13) — compared
   *  against a fresh `listActiveGrantResourceScopes` read on every `ensureEntryHandle` call
   *  (authority-tightening fix, review job 652a4abc item 4: "Grant changes become visible") so a
   *  Grant made/revoked since this Handle was minted is picked up on this principal's very next
   *  Turn, not only once the cached Handle is close enough to its ttl to reissue anyway. Order-
   *  independent — compared via `sameGatekeeperScope` below, not array equality. Since S3.13 this
   *  is already the *narrowed* set (Grants ∩ AgentProfile.effective.enabledGatekeepers, see
   *  `ensureEntryHandle`), so a Profile-driven narrowing of the gate set is caught by this same
   *  comparison without any extra logic. */
  readonly gatekeeperIds: readonly string[];
  /** S3.13: `agent_profiles.updated_at`/`agent_policies.updated_at`, joined into one comparable
   *  string (`agentProfileVersionKey` below) — catches a Profile/Policy change that does *not*
   *  alter `gatekeeperIds` (a model/Skill-set/promptAddendum/autoApproveLow edit) so this
   *  in-memory cache never keeps serving a token minted under stale settings merely because the
   *  DB-side `revokeEntrySessionHandles` call (`application/gateway/agent-profile-handlers.ts`)
   *  already invalidated the underlying `capability_handles` row — the *cache* itself would
   *  otherwise never notice and hand back the now-revoked token on the caller's very next Turn. */
  readonly profileVersionKey: string;
}

/** Order-independent set equality for two `resources.gatekeeper` id lists — used by
 *  `ensureEntryHandle` to decide whether a Grant change since the cached Handle's issuance
 *  requires reissuing it early (item 4 fix, see `CachedHandle.gatekeeperIds`'s own doc comment). */
function sameGatekeeperScope(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const setA = new Set(a);
  return b.every((id) => setA.has(id));
}

/** S3.13: resolved AgentProfile/AgentPolicy for one principal, alongside a version key derived
 *  from both rows' own `updated_at` (see `CachedHandle.profileVersionKey`'s own doc comment for
 *  why a timestamp comparison — not a content hash — is the right freshness signal here: any
 *  committed `set_agent_profile`/`set_agent_policy` write always bumps its own row's `updated_at`,
 *  so a distinct key reliably means "something changed since this was last read", and an
 *  unresolved (`undefined`) sentinel below is itself a distinct, stable key. */
interface ResolvedAgentProfile {
  readonly effective: EffectiveAgentProfile;
  readonly versionKey: string;
}

/** `resolved` is `undefined` when `resolveAgentProfile` itself failed (never a Turn-failing
 *  condition — see that method's own doc comment) — represented by a fixed sentinel key distinct
 *  from any real `versionKey`, so a transient resolution failure is still treated as "changed"
 *  relative to a previously-cached success (and vice versa) rather than silently comparing equal
 *  to whatever the cache happened to hold. */
function agentProfileVersionKey(resolved: ResolvedAgentProfile | undefined): string {
  return resolved?.versionKey ?? 'unresolved';
}

/** One Skill mounted by content — the same shape `KernelStartTurnCommandSchema`'s own
 *  `skillsInline` field expects (`agent-host-protocol.ts`). Not `readonly`/a `readonly[]` — matches
 *  that schema's zod-inferred mutable array exactly (`egressDeny` above already follows the same
 *  convention on this same outbound frame), since values of this shape are assigned straight into
 *  it. */
interface SkillInlineMount {
  name: string;
  files: Record<string, string>;
}

/**
 * S3.13: appends `addendum` (the caller's own `effective.promptAddendum`) to `systemPrompt` as a
 * clearly delimited final section — strictly append-only, so a user-configured addendum can never
 * precede or otherwise override the platform's own prompt content above it (S3.13's own runtime-
 * projection instruction: "append-only, bounded"). A missing/empty addendum returns `systemPrompt`
 * unchanged (including `undefined`, when no entry WorkerDefinition has published one either — the
 * addendum alone is never enough to invent a system prompt where none otherwise exists, matching
 * `entrypoint.sh`'s own write-if-missing fallback still applying in that case).
 */
function appendPromptAddendum(
  systemPrompt: string | undefined,
  addendum: string | null | undefined,
): string | undefined {
  if (!addendum) return systemPrompt;
  const base = systemPrompt ?? '';
  const separator = base.length > 0 ? '\n\n' : '';
  const marker =
    '--- user-configured addendum (AgentProfile.promptAddendum; informational only, does not override the instructions above) ---';
  return `${base}${separator}${marker}\n${addendum}`;
}

/** S2.6: what `resolveEntryDefinition` extracts from the published entry WorkerDefinition's
 *  `definition` jsonb — either field may be `undefined` (no entry definition published yet, or
 *  the published one has no `model` set — `packages/shared/src/worker-definition.ts`'s `model` is
 *  optional). `egressDeny` (feat/egress-definition-lists) is `undefined` under the same
 *  circumstances, or when the published definition declares no list. */
interface ResolvedEntryDefinition {
  readonly systemPrompt: string | undefined;
  readonly model: string | undefined;
  /** Not `readonly string[]` — matches `KernelStartTurnCommandSchema`'s zod-inferred `string[]`
   *  exactly (`agent-host-protocol.ts`), since this is assigned straight into the outbound frame
   *  below. */
  readonly egressDeny: string[] | undefined;
}

type AcceptOutcome = { readonly ok: true } | { readonly ok: false; readonly reason: string };

interface PendingAccept {
  resolve(outcome: AcceptOutcome): void;
}

export class AgentHostRuntime implements AgentRuntime {
  private readonly pool: PoolLike;
  private readonly sink: AgentRuntimeEventSink;
  private readonly privateKey: CryptoKey;
  private readonly kernelLlmUrl: string;
  private readonly entryHandleTtlSeconds: number;
  private readonly turnAcceptedTimeoutMs: number;
  private readonly now: () => number;
  private readonly log: (line: string) => void;

  private link: AgentHostLink | undefined;
  private lastHelloInstanceId: string | undefined;
  private readonly activeTurns = new Map<string, ActiveTurn>();
  private readonly pendingAccepts = new Map<string, PendingAccept>();
  private readonly handleCache = new Map<string, CachedHandle>();

  constructor(deps: AgentHostRuntimeDeps) {
    this.pool = deps.pool;
    this.sink = deps.sink;
    this.privateKey = deps.privateKey;
    this.kernelLlmUrl = deps.kernelLlmUrl;
    this.entryHandleTtlSeconds = deps.entryHandleTtlSeconds ?? DEFAULT_ENTRY_HANDLE_TTL_SECONDS;
    this.turnAcceptedTimeoutMs = deps.turnAcceptedTimeoutMs ?? DEFAULT_TURN_ACCEPTED_TIMEOUT_MS;
    this.now = deps.now ?? (() => Date.now());
    this.log = deps.log ?? ((line) => console.error(line));
  }

  // -------------------------------------------------------------------------------------------
  // interfaces/ws/agent-host.ts calls these — see this module's doc comment for the split.
  // -------------------------------------------------------------------------------------------

  /** Registers the currently-connected agent-host link. A later `startTurn`/`stopTurn` sends
   *  through whichever link is registered at call time. */
  connect(link: AgentHostLink): void {
    this.link = link;
  }

  /** Unregisters `link` — a no-op unless `link` is still the current one (guards a stale
   *  connection's `close` event from clobbering a newer connection that already replaced it). */
  disconnect(link: AgentHostLink): void {
    if (this.link === link) this.link = undefined;
  }

  /** Handles one already-validated inbound frame. */
  handleFrame(frame: AgentHostToKernelFrame): void {
    switch (frame.type) {
      case 'hello':
        this.handleHello(frame.instanceId);
        return;
      case 'turnAccepted':
        this.resolvePendingAccept(frame.turnId, { ok: true });
        return;
      case 'turnRejected':
        this.resolvePendingAccept(frame.turnId, { ok: false, reason: frame.reason });
        return;
      case 'runtimeEvent':
        void this.handleRuntimeEvent(frame.event);
        return;
    }
  }

  // -------------------------------------------------------------------------------------------
  // AgentRuntime port
  // -------------------------------------------------------------------------------------------

  async startTurn(input: StartTurnInput): Promise<void> {
    const link = this.link;
    if (!link) {
      this.log(
        JSON.stringify({
          level: 'error',
          msg: 'agent-host-runtime: startTurn with no agent-host connected',
          turnId: input.turnId,
        }),
      );
      await this.emitFailed(input);
      return;
    }

    // S3.13: the caller's own AgentProfile/AgentPolicy, resolved fresh on every startTurn (same
    // "cheap, never a stale-cache class of bug" convention `resolveEntryDefinition` below already
    // established) — computed once and threaded through `ensureEntryHandle` (gate narrowing +
    // cache freshness), the model/prompt-addendum merge, and the Skill-mount resolution below, so
    // no consumer re-reads `agent_profiles`/`agent_policies` a second time this Turn.
    const agentProfile = await this.resolveAgentProfile(input.workspaceId, input.principalId);

    let handleToken: string;
    try {
      handleToken = await this.ensureEntryHandle(
        input.workspaceId,
        input.principalId,
        agentProfile,
      );
    } catch (err) {
      this.log(
        JSON.stringify({
          level: 'error',
          msg: 'agent-host-runtime: failed to prepare the entry session/Handle',
          turnId: input.turnId,
          principalId: input.principalId,
          error: String(err),
        }),
      );
      await this.emitFailed(input);
      return;
    }

    // S2.6: the entry container's system prompt/model, from the workspace's currently published
    // `kind='entry'` WorkerDefinition — resolved fresh on every startTurn (publish is rare; the
    // extra read is cheap and avoids a stale-cache class of bug entirely) and never fatal: a
    // lookup failure, or no entry definition ever having been published, falls back to `undefined`
    // fields on the outbound frame, which `entrypoint.sh`'s own write-if-missing static prompt
    // (and pi's default model selection) already cover — see this class's own doc comment.
    const entryDefinition = await this.resolveEntryDefinition(
      input.workspaceId,
      input.principalId,
      input.turnId,
    );

    // S3.13: the caller's own `effective.enabledSkills`, rendered into mountable content the same
    // way `application/task/definition-content.ts`'s `resolveSkillsInline` already does for the
    // Task path — see `resolveSkillsInline` below for the "null means mount nothing" decision.
    const skillsInline = await this.resolveSkillsInline(
      input.workspaceId,
      input.principalId,
      agentProfile?.effective,
      input.turnId,
    );

    this.activeTurns.set(input.turnId, {
      workspaceId: input.workspaceId,
      chatId: input.chatId,
      principalId: input.principalId,
    });

    const sent = this.sendStartTurnFrame(
      link,
      input,
      handleToken,
      entryDefinition,
      agentProfile?.effective,
      skillsInline,
    );
    if (!sent.ok) {
      this.activeTurns.delete(input.turnId);
      this.log(
        JSON.stringify({
          level: 'error',
          msg: 'agent-host-runtime: failed to send startTurn to agent-host',
          turnId: input.turnId,
          reason: sent.reason,
        }),
      );
      await this.emitFailed(input);
      return;
    }

    // Do not await `sent.wait` — see this class's own doc comment / agent-runtime.ts's
    // `startTurn` doc comment (lane-4 P2 fix): resolving here, right after the frame is sent,
    // is the whole point — this call runs inside the outbox dispatcher's single-row transaction
    // (application/host-bridge/turn-started-consumer.ts), and awaiting up to
    // `turnAcceptedTimeoutMs` here would stall every other outbox event behind this one Turn.
    // The accept/reject/timeout outcome is instead handled asynchronously: a negative outcome
    // still produces exactly one `turnEnded {status:'failed'}` event, just later.
    void sent.wait.then((outcome) => {
      if (outcome.ok) return;
      this.activeTurns.delete(input.turnId);
      this.log(
        JSON.stringify({
          level: 'error',
          msg: 'agent-host-runtime: turn not accepted',
          turnId: input.turnId,
          reason: outcome.reason,
        }),
      );
      void this.emitFailed(input);
    });
  }

  /** Idempotent (port contract): stopping an unknown, already-ended, or never-accepted `turnId`
   *  is a no-op — there is nothing running for agent-host to abort. Resolves with whether this
   *  runtime had any record of `turnId` at all (lane-4 P1 fix — see `AgentRuntime.stopTurn`'s own
   *  doc comment): `false` only when `turnId` is not tracked as active at all (unknown, or
   *  already ended from this runtime's own point of view) — a caller gets `true` even when
   *  agent-host is not currently connected (`!this.link`), because the Turn is still tracked and
   *  will eventually resolve one way or another (a future `runtimeEvent`, or `abandonAllActive
   *  Turns` on the next `hello` if agent-host restarted) — only a *fully unknown* `turnId` means
   *  this runtime will never independently report a `turnEnded` for it. */
  async stopTurn(turnId: string): Promise<boolean> {
    const turn = this.activeTurns.get(turnId);
    if (!turn) return false;
    if (!this.link) return true;
    try {
      this.link.send({ type: 'stopTurn', turnId, principalId: turn.principalId });
    } catch (err) {
      this.log(
        JSON.stringify({
          level: 'warn',
          msg: 'agent-host-runtime: failed to send stopTurn to agent-host',
          turnId,
          error: String(err),
        }),
      );
    }
    return true;
  }

  // -------------------------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------------------------

  /**
   * Sends the `startTurn` command frame and returns immediately (`{ok: true, wait}`) — `wait` is
   * a separate Promise the caller may observe *without* blocking on it (lane-4 P2 fix; see
   * `startTurn`'s own body for why it is not awaited there). `{ok: false, reason}` is returned
   * only for a failure known synchronously (the `link.send` call itself throwing, e.g. a closed
   * socket) — a `turnAccepted` timeout or an explicit `turnRejected` are reported later, through
   * `wait` resolving with `{ok: false, reason}` on its own schedule.
   *
   * S3.13: `agentProfile` (the caller's own `effective` AgentProfile, resolved once in `startTurn`
   * — `undefined` only when resolution itself failed) is merged in here — never re-derived —
   * against the published entry WorkerDefinition's own `entryDefinition`:
   *   - `model`: `agentProfile.model` wins when non-empty (`EffectiveAgentProfile.model` is always
   *     a concrete `string`, `''` meaning "nothing configured anywhere" —
   *     `governance/agent-profile/resolve.ts`'s own doc comment); otherwise the WorkerDefinition's
   *     own `model` applies, exactly as before this task.
   *   - `systemPrompt`: `agentProfile.promptAddendum`, when non-empty, is appended as a clearly
   *     delimited final section (`appendPromptAddendum` below) — strictly *after* the platform's
   *     own `entryDefinition.systemPrompt`, so it can never precede or otherwise override it.
   */
  private sendStartTurnFrame(
    link: AgentHostLink,
    input: StartTurnInput,
    handleToken: string,
    entryDefinition: ResolvedEntryDefinition | undefined,
    agentProfile: EffectiveAgentProfile | undefined,
    skillsInline: SkillInlineMount[],
  ): { ok: true; wait: Promise<AcceptOutcome> } | { ok: false; reason: string } {
    let resolveWait!: (outcome: AcceptOutcome) => void;
    const wait = new Promise<AcceptOutcome>((resolve) => {
      resolveWait = resolve;
    });

    const timeoutHandle = setTimeout(() => {
      this.pendingAccepts.delete(input.turnId);
      resolveWait({ ok: false, reason: 'agent-host did not accept the turn in time' });
    }, this.turnAcceptedTimeoutMs);
    timeoutHandle.unref?.();

    this.pendingAccepts.set(input.turnId, {
      resolve: (outcome) => {
        clearTimeout(timeoutHandle);
        resolveWait(outcome);
      },
    });

    const model = agentProfile?.model ? agentProfile.model : entryDefinition?.model;
    const systemPrompt = appendPromptAddendum(
      entryDefinition?.systemPrompt,
      agentProfile?.promptAddendum,
    );

    try {
      link.send({
        type: 'startTurn',
        workspaceId: input.workspaceId,
        chatId: input.chatId,
        turnId: input.turnId,
        principalId: input.principalId,
        prompt: input.prompt,
        handle: handleToken,
        kernelLlmUrl: this.kernelLlmUrl,
        ...(systemPrompt !== undefined ? { systemPrompt } : {}),
        ...(model !== undefined ? { model } : {}),
        ...(entryDefinition?.egressDeny !== undefined
          ? { egressDeny: entryDefinition.egressDeny }
          : {}),
        ...(skillsInline.length > 0 ? { skillsInline } : {}),
      });
    } catch (err) {
      this.pendingAccepts.delete(input.turnId);
      clearTimeout(timeoutHandle);
      return { ok: false, reason: `failed to send startTurn to agent-host: ${String(err)}` };
    }
    return { ok: true, wait };
  }

  private resolvePendingAccept(turnId: string, outcome: AcceptOutcome): void {
    const pending = this.pendingAccepts.get(turnId);
    if (!pending) return; // late/duplicate frame for a turn we are no longer waiting on — ignore
    this.pendingAccepts.delete(turnId);
    pending.resolve(outcome);
  }

  private async handleRuntimeEvent(event: AgentRuntimeEventWire): Promise<void> {
    // Untracked *before* the (possibly slow) sink call below — a stopTurn racing in for a turn
    // that has, from agent-host's point of view, already ended must see it as gone immediately,
    // not only once the sink has finished persisting it.
    if (event.type === 'turnEnded') {
      this.activeTurns.delete(event.turnId);
    }
    // AgentRuntimeEventWire (agent-host-protocol.ts, @nexttime/shared) is a hand-kept structural
    // mirror of AgentRuntimeEvent (agent-runtime.ts) — see the former's own doc comment for why
    // this package cannot import the latter directly.
    await this.safeSinkHandle(event as AgentRuntimeEvent);
  }

  private handleHello(instanceId: string): void {
    const isRestart =
      this.lastHelloInstanceId !== undefined && this.lastHelloInstanceId !== instanceId;
    this.lastHelloInstanceId = instanceId;
    if (!isRestart) return;

    this.log(
      JSON.stringify({
        level: 'warn',
        msg: 'agent-host-runtime: agent-host reconnected with a new instanceId — treating it as a restart and abandoning turns left active from before',
        abandonedTurnCount: this.activeTurns.size,
      }),
    );
    this.abandonAllActiveTurns();
  }

  /** A fresh agent-host process remembers nothing about any turn started before it restarted
   *  (see this module's doc comment) — every turn this runtime still considers active is
   *  reported `interrupted` (design doc §5.5 Turn states; §13's general "crashed mid-flight"
   *  handling), and every still-pending `startTurn` acceptance wait is failed outright rather than
   *  left to time out. */
  private abandonAllActiveTurns(): void {
    // A turn still waiting on turnAccepted is tracked in *both* maps (startTurn populates
    // activeTurns before it ever awaits the accept/reject outcome — see startTurn's own body).
    // Failing its pending accept below already makes startTurn's own continuation delete it from
    // activeTurns and emit exactly one turnEnded {status:'failed'} — excluded here so it does not
    // *also* get an `interrupted` event from the loop below (one terminal event per turn, never
    // two).
    const pendingTurnIds = new Set(this.pendingAccepts.keys());
    for (const pending of this.pendingAccepts.values()) {
      pending.resolve({ ok: false, reason: 'agent-host restarted before accepting this turn' });
    }
    this.pendingAccepts.clear();

    const abandoned = [...this.activeTurns.entries()].filter(
      ([turnId]) => !pendingTurnIds.has(turnId),
    );
    for (const [turnId] of abandoned) this.activeTurns.delete(turnId);
    for (const [turnId, turn] of abandoned) {
      void this.safeSinkHandle({
        type: 'turnEnded',
        status: 'interrupted',
        workspaceId: turn.workspaceId,
        chatId: turn.chatId,
        turnId,
        principalId: turn.principalId,
      });
    }
  }

  private async emitFailed(input: StartTurnInput): Promise<void> {
    await this.safeSinkHandle({
      type: 'turnEnded',
      status: 'failed',
      workspaceId: input.workspaceId,
      chatId: input.chatId,
      turnId: input.turnId,
      principalId: input.principalId,
    });
  }

  /** `AgentRuntimeEventSink.handle` is caller-supplied (application/chat's event sink in
   *  production) — never let it throw into a fire-and-forget call site (`handleFrame`'s
   *  `runtimeEvent` case, `abandonAllActiveTurns`) and become an unhandled rejection. */
  private async safeSinkHandle(event: AgentRuntimeEvent): Promise<void> {
    try {
      await this.sink.handle(event);
    } catch (err) {
      this.log(
        JSON.stringify({
          level: 'error',
          msg: 'agent-host-runtime: AgentRuntimeEventSink.handle threw',
          turnId: event.turnId,
          eventType: event.type,
          error: String(err),
        }),
      );
    }
  }

  /**
   * S2.6: resolves `{systemPrompt, model}` from the workspace's currently published `kind='entry'`
   * WorkerDefinition (`application/worker`'s `getPublishedEntryDefinition`) — a read-only
   * `withWorkspace` query, principled the same way `ensureEntrySession`'s own lookup is (RLS-scoped
   * to `workspaceId`), scoped to `principalId` itself only for the RLS session variable (I1) —
   * `worker_definitions` carries no `principal_id` column (see `application/worker/definitions.ts`'s
   * own doc comment: the entry WorkerDefinition is workspace-wide, not per-user). Never throws:
   * any failure (no DB reachable, no entry definition ever published, a malformed `definition`
   * missing `systemPrompt`) is logged and treated as "nothing to add to this frame" — see this
   * class's own doc comment on why a lookup here must never fail a Turn.
   *
   * feat/egress-definition-lists: also resolves `egressDeny` off the same definition read — no
   * second query, same never-throws contract (a malformed/missing `egressDeny` degrades to
   * `undefined`, exactly like a missing `model`, never to a Turn failure).
   */
  private async resolveEntryDefinition(
    workspaceId: string,
    principalId: string,
    turnId: string,
  ): Promise<ResolvedEntryDefinition | undefined> {
    try {
      const definition = await withWorkspace(this.pool, { workspaceId, principalId }, (client) =>
        getPublishedEntryDefinition(client, workspaceId),
      );
      if (!definition) return undefined;

      const content = definition.definition as {
        systemPrompt?: unknown;
        model?: unknown;
        egressDeny?: unknown;
      };
      const systemPrompt =
        typeof content.systemPrompt === 'string' && content.systemPrompt.length > 0
          ? content.systemPrompt
          : undefined;
      const model =
        typeof content.model === 'string' && content.model.length > 0 ? content.model : undefined;
      const egressDeny = Array.isArray(content.egressDeny)
        ? content.egressDeny.filter((d): d is string => typeof d === 'string')
        : undefined;
      return { systemPrompt, model, egressDeny };
    } catch (err) {
      this.log(
        JSON.stringify({
          level: 'warn',
          msg: 'agent-host-runtime: failed to resolve the published entry WorkerDefinition (falling back to entrypoint.sh’s static prompt/default model)',
          turnId,
          workspaceId,
          error: String(err),
        }),
      );
      return undefined;
    }
  }

  /**
   * S2.13: flows every `connect_gatekeeper`/`grant_capability{resourceType:'gatekeeper'}` Grant this
   * principal holds into the entry Handle's own `resources.gatekeeper` scope
   * (governance/capability/handles.ts's own "Known seam for S2.4/S2.13" note — this is that seam,
   * closed). Item 4 fix (authority-tightening, review job 652a4abc: "Grant changes become
   * visible"): the principal's current Grant coverage is now read on **every** call — not only
   * when the cached Handle is already close enough to its ttl to reissue anyway — and compared
   * (`sameGatekeeperScope`) against what the cached Handle was actually minted with; a difference
   * forces an early reissue regardless of remaining ttl. `grants.ts`'s `grantCapability`/
   * `revokeCapabilityGrant` independently `revokeSession` the principal's entry session on the
   * same kind of change (belt: closes the window immediately, for any Handle verifier, not only
   * this cache) — this comparison is the suspenders: even if a `startTurn` races a Grant change
   * that already revoked the cached token, this method mints a fresh one instead of returning the
   * (now-revoked) cached one blindly.
   *
   * S3.13 addition: `agentProfile` (the caller's own resolved AgentProfile/AgentPolicy, computed
   * once in `startTurn`) narrows the Grant-derived `gatekeeperIds` down to
   * `effective.enabledGatekeepers` when the profile sets one (`null` = no restriction beyond the
   * Grant ceiling above — S3.13's own core invariant, "Profile 是 Grant 的子集投影，永不扩权": this
   * can only ever remove ids from the Grant-derived list, never add one that is not already
   * there). The cache-freshness comparison also now includes `agentProfileVersionKey` alongside
   * `sameGatekeeperScope`, so a Profile/Policy change that does not itself alter the gate set
   * (model, Skills, promptAddendum, autoApproveLow) still forces a fresh mint on the caller's very
   * next Turn — see `CachedHandle.profileVersionKey`'s own doc comment for why the in-memory cache
   * needs this in addition to the DB-side `revokeEntrySessionHandles` call.
   */
  private async ensureEntryHandle(
    workspaceId: string,
    principalId: string,
    agentProfile: ResolvedAgentProfile | undefined,
  ): Promise<string> {
    const sessionId = await this.ensureEntrySession(workspaceId, principalId);

    const grantedGatekeeperIds = await withWorkspace(
      this.pool,
      { workspaceId, principalId },
      (client) =>
        listActiveGrantResourceScopes(client, workspaceId, {
          principalId,
          resourceType: GATEKEEPER_RESOURCE_SCOPE_KEY,
        }),
    );
    const enabledGatekeepers = agentProfile?.effective.enabledGatekeepers;
    const gatekeeperIds = enabledGatekeepers
      ? grantedGatekeeperIds.filter((id) => enabledGatekeepers.includes(id))
      : grantedGatekeeperIds;
    const profileVersionKey = agentProfileVersionKey(agentProfile);

    const cached = this.handleCache.get(principalId);
    if (
      cached &&
      sameGatekeeperScope(cached.gatekeeperIds, gatekeeperIds) &&
      cached.profileVersionKey === profileVersionKey
    ) {
      const totalTtlMs = cached.expiresAtMs - cached.issuedAtMs;
      const remainingMs = cached.expiresAtMs - this.now();
      if (totalTtlMs <= 0 || remainingMs > totalTtlMs * HANDLE_REISSUE_THRESHOLD) {
        return cached.token;
      }
    }

    const issued = await withWorkspace(this.pool, { workspaceId, principalId }, (client) =>
      issueHandle(client, {
        sessionId,
        scope: entryScope(
          gatekeeperIds.length > 0 ? { resources: { gatekeeper: gatekeeperIds } } : {},
        ),
        ttlSeconds: this.entryHandleTtlSeconds,
        privateKey: this.privateKey,
      }),
    );
    this.handleCache.set(principalId, {
      token: issued.token,
      issuedAtMs: issued.issuedAt.getTime(),
      expiresAtMs: issued.expiresAt.getTime(),
      gatekeeperIds,
      profileVersionKey,
    });
    return issued.token;
  }

  /**
   * S3.13: resolves the caller's own AgentProfile/AgentPolicy and applies the pure resolution rule
   * (`governance/agent-profile`'s `resolveEffectiveAgentProfile`) — a read-only `withWorkspace`
   * query, same "resolved fresh on every startTurn, never fatal" convention `resolveEntryDefinition`
   * above already established (a lookup failure degrades to `undefined`, meaning "no override on
   * top of whatever the platform WorkerDefinition/entrypoint default already provides", never a
   * failed Turn).
   *
   * `available.publishedSkillIds`/`grantedGatekeeperIds` are resolved here too — `governance/
   * agent-profile/resolve.ts`'s own doc comment has the full rationale: a `null` (inherit)
   * `enabledSkills`/`enabledGatekeepers` resolves to "every currently available resource", not
   * "nothing" — matching the already-shipped web console's own reading of the same contract (its
   * `EffectivePanel` renders `effective.enabledSkills`/`enabledGatekeepers` as always-concrete
   * lists). `grantedGatekeeperIds` here is a second `listActiveGrantResourceScopes` call,
   * independent of `ensureEntryHandle`'s own — this method runs *before* that one (its result
   * feeds `ensureEntryHandle`'s own gate-narrowing), so there is no already-computed value to
   * reuse yet; the extra read is cheap and keeps the two methods independently callable/testable.
   */
  private async resolveAgentProfile(
    workspaceId: string,
    principalId: string,
  ): Promise<ResolvedAgentProfile | undefined> {
    try {
      return await withWorkspace(this.pool, { workspaceId, principalId }, async (client) => {
        const [profile, policy, publishedSkillIds, grantedGatekeeperIds] = await Promise.all([
          readAgentProfile(client, workspaceId, principalId),
          readAgentPolicy(client, workspaceId),
          listPublishedSkillIds(client, workspaceId),
          listActiveGrantResourceScopes(client, workspaceId, {
            principalId,
            resourceType: GATEKEEPER_RESOURCE_SCOPE_KEY,
          }),
        ]);
        return {
          effective: resolveEffectiveAgentProfile(profile, policy, {
            publishedSkillIds,
            grantedGatekeeperIds,
            // No consumer in this class reads `enabledWorkerDefinitions` — entry Turns never
            // mount/select a WorkerDefinition of their own — so the ceiling is left empty rather
            // than paying for a third query (`listWorkerDefinitions`) purely to fill a field
            // nothing here inspects.
            publishedWorkerDefinitionIds: [],
          }),
          versionKey: `${profile?.updatedAt?.getTime() ?? 0}:${policy.updatedAt?.getTime() ?? 0}`,
        };
      });
    } catch (err) {
      this.log(
        JSON.stringify({
          level: 'warn',
          msg: 'agent-host-runtime: failed to resolve the caller’s AgentProfile/AgentPolicy (falling back to no override)',
          workspaceId,
          principalId,
          error: String(err),
        }),
      );
      return undefined;
    }
  }

  /**
   * S3.13: renders the caller's own `effective.enabledSkills` into mountable content — same
   * `resolvePublishedSkills` + `renderSkillMarkdownFile` pair `application/task/
   * definition-content.ts`'s `resolveSkillsInline` already uses for the Task path, applied here to
   * the entry container instead. `effective.enabledSkills` is already fully resolved by
   * `resolveAgentProfile` above (never `null` — "every published Skill" when the principal's own
   * AgentProfile sets no explicit selection, `governance/agent-profile/resolve.ts`'s own doc
   * comment), so this method only ever renders whatever concrete list it is given; an empty list
   * mounts nothing. Never fatal: a lookup failure degrades to no Skills mounted, same convention
   * as `resolveEntryDefinition`/`resolveAgentProfile` above.
   */
  private async resolveSkillsInline(
    workspaceId: string,
    principalId: string,
    agentProfile: EffectiveAgentProfile | undefined,
    turnId: string,
  ): Promise<SkillInlineMount[]> {
    const refs = agentProfile?.enabledSkills;
    if (!refs || refs.length === 0) return [];
    try {
      return await withWorkspace(this.pool, { workspaceId, principalId }, async (client) => {
        const skills = await resolvePublishedSkills(client, workspaceId, refs);
        return skills.map((skill) => ({
          name: skill.name,
          files: { 'SKILL.md': renderSkillMarkdownFile(skill) },
        }));
      });
    } catch (err) {
      this.log(
        JSON.stringify({
          level: 'warn',
          msg: 'agent-host-runtime: failed to resolve effective.enabledSkills into mountable content (falling back to no Skills mounted)',
          turnId,
          workspaceId,
          principalId,
          error: String(err),
        }),
      );
      return [];
    }
  }

  /**
   * Finds or creates a `kind='entry'` session for `principalId` (`on_behalf_of = principalId`,
   * I13 — design doc S1.5b architecture point 2: "find or create a `sessions` row `kind='entry'`
   * for the principal"). Mirrors application/gateway/auth.ts's `createOrReuseWebSession`
   * (`kind='web'`) one level down.
   *
   * Assumption (see PR body "假设"): `principal_id` on this session row is the calling human
   * Principal itself, the same way a `web` session's `principal_id` is — not a separate synthetic
   * `kind='agent'` Principal representing "this user's entry-agent instance". `packages/
   * shared/src/enums.ts`'s own comment describes `agent` Principal kind as "one WorkerRun or one
   * entry agent instance", which would be the more literal reading of §5.1.1 — but minting one
   * such Principal per user (with its own `role`, its own creation lifecycle, and — per I13 — a
   * new `on_behalf_of` distinction between "acting as the agent" and "acting as the human") is a
   * modeling decision no S1 task has made yet, and doing it unilaterally here would be exactly the
   * kind of foundational-ontology change §A3 of the operator's own methodology says to raise, not
   * assume. The `sessions.kind` column alone already distinguishes "this human's web channel" from
   * "this human's entry-agent channel" without a second Principal identity — sufficient for I13's
   * actual requirement (`on_behalf_of` traces to the human) and for every consumer this task
   * touches (audit, Handle issuance, `chat`'s existing `principalId`-keyed Turn ownership). Left
   * for a future task to revisit if a real need for a distinct entry-agent identity emerges.
   */
  private async ensureEntrySession(workspaceId: string, principalId: string): Promise<string> {
    return withWorkspace(this.pool, { workspaceId, principalId }, async (client) => {
      const existing = await client.query<{ id: string }>(
        `select id from sessions
         where workspace_id = $1 and principal_id = $2 and kind = 'entry' and on_behalf_of = $2
           and (expires_at is null or expires_at > now())
         order by created_at desc
         limit 1`,
        [workspaceId, principalId],
      );
      const existingRow = existing.rows[0];
      if (existingRow) return existingRow.id;

      const inserted = await client.query<{ id: string }>(
        `insert into sessions (workspace_id, principal_id, kind, on_behalf_of, status)
         values ($1, $2, 'entry', $2, 'starting')
         returning id`,
        [workspaceId, principalId],
      );
      const row = inserted.rows[0];
      if (!row) throw new Error('ensureEntrySession: INSERT ... RETURNING produced no row');
      return row.id;
    });
  }
}
