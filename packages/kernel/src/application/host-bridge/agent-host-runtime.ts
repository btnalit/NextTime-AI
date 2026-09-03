import type {
  AgentHostToKernelFrame,
  AgentRuntimeEventWire,
  KernelToAgentHostFrame,
} from '@nexttime/shared';
import type { CryptoKey } from 'jose';
import type { PoolLike } from '../../adapters/db/pool.js';
import { withWorkspace } from '../../adapters/db/pool.js';
import { entryScope, issueHandle } from '../../governance/capability/index.js';
import { getPublishedEntryDefinition } from '../worker/index.js';
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
 * throws. No agent-host connected, a Handle/session bootstrap failure, a `turnAccepted` timeout,
 * or an explicit `turnRejected` are all reported the same way — one `turnEnded {status:'failed'}`
 * event through the sink — so `application/host-bridge/turn-started-consumer.ts`'s caller has
 * exactly one path to observe a Turn's outcome, per the port's own contract.
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
}

/** S2.6: what `resolveEntryDefinition` extracts from the published entry WorkerDefinition's
 *  `definition` jsonb — either field may be `undefined` (no entry definition published yet, or
 *  the published one has no `model` set — `packages/shared/src/worker-definition.ts`'s `model` is
 *  optional). */
interface ResolvedEntryDefinition {
  readonly systemPrompt: string | undefined;
  readonly model: string | undefined;
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

    let handleToken: string;
    try {
      handleToken = await this.ensureEntryHandle(input.workspaceId, input.principalId);
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

    this.activeTurns.set(input.turnId, {
      workspaceId: input.workspaceId,
      chatId: input.chatId,
      principalId: input.principalId,
    });

    const outcome = await this.sendStartTurnAndAwaitAccept(
      link,
      input,
      handleToken,
      entryDefinition,
    );

    if (!outcome.ok) {
      this.activeTurns.delete(input.turnId);
      this.log(
        JSON.stringify({
          level: 'error',
          msg: 'agent-host-runtime: turn not accepted',
          turnId: input.turnId,
          reason: outcome.reason,
        }),
      );
      await this.emitFailed(input);
    }
  }

  /** Idempotent (port contract): stopping an unknown, already-ended, or never-accepted `turnId`
   *  is a no-op — there is nothing running for agent-host to abort. */
  async stopTurn(turnId: string): Promise<void> {
    const turn = this.activeTurns.get(turnId);
    if (!turn || !this.link) return;
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
  }

  // -------------------------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------------------------

  private sendStartTurnAndAwaitAccept(
    link: AgentHostLink,
    input: StartTurnInput,
    handleToken: string,
    entryDefinition: ResolvedEntryDefinition | undefined,
  ): Promise<AcceptOutcome> {
    return new Promise<AcceptOutcome>((resolve) => {
      const timeoutHandle = setTimeout(() => {
        this.pendingAccepts.delete(input.turnId);
        resolve({ ok: false, reason: 'agent-host did not accept the turn in time' });
      }, this.turnAcceptedTimeoutMs);
      timeoutHandle.unref?.();

      this.pendingAccepts.set(input.turnId, {
        resolve: (outcome) => {
          clearTimeout(timeoutHandle);
          resolve(outcome);
        },
      });

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
          ...(entryDefinition?.systemPrompt !== undefined
            ? { systemPrompt: entryDefinition.systemPrompt }
            : {}),
          ...(entryDefinition?.model !== undefined ? { model: entryDefinition.model } : {}),
        });
      } catch (err) {
        this.pendingAccepts.delete(input.turnId);
        clearTimeout(timeoutHandle);
        resolve({ ok: false, reason: `failed to send startTurn to agent-host: ${String(err)}` });
      }
    });
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

      const content = definition.definition as { systemPrompt?: unknown; model?: unknown };
      const systemPrompt =
        typeof content.systemPrompt === 'string' && content.systemPrompt.length > 0
          ? content.systemPrompt
          : undefined;
      const model =
        typeof content.model === 'string' && content.model.length > 0 ? content.model : undefined;
      return { systemPrompt, model };
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

  private async ensureEntryHandle(workspaceId: string, principalId: string): Promise<string> {
    const cached = this.handleCache.get(principalId);
    if (cached) {
      const totalTtlMs = cached.expiresAtMs - cached.issuedAtMs;
      const remainingMs = cached.expiresAtMs - this.now();
      if (totalTtlMs <= 0 || remainingMs > totalTtlMs * HANDLE_REISSUE_THRESHOLD) {
        return cached.token;
      }
    }

    const sessionId = await this.ensureEntrySession(workspaceId, principalId);
    const issued = await withWorkspace(this.pool, { workspaceId, principalId }, (client) =>
      issueHandle(client, {
        sessionId,
        scope: entryScope(),
        ttlSeconds: this.entryHandleTtlSeconds,
        privateKey: this.privateKey,
      }),
    );
    this.handleCache.set(principalId, {
      token: issued.token,
      issuedAtMs: issued.issuedAt.getTime(),
      expiresAtMs: issued.expiresAt.getTime(),
    });
    return issued.token;
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
