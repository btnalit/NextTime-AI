import type { AgentRuntimeEventWire, KernelToAgentHostFrame } from '@nexttime/shared';
import {
  buildAbortCommand,
  buildPromptCommand,
  buildSwitchSessionCommand,
  translatePiEvent,
} from './bridge.js';
import type { AttachedContainerIo, ContainerIoClient } from './container-io.js';
import type { KernelLink } from './kernel-link.js';
import type { SpawnInput, SupervisorClientPort } from './supervisor-client.js';

/**
 * host: orchestrates one principal's entry container across its whole lifecycle — spawn/reuse
 * (via `supervisor-client.ts`), attach/reattach (via `container-io.ts`), translate its stdout
 * (via `bridge.ts`), and relay to the kernel (via `kernel-link.ts`). This is the module every
 * other file in this package exists to support; `index.ts` only wires the four together and
 * starts the process.
 *
 * State (in-memory, does not survive an agent-host process restart — see `@nexttime/shared`'s
 * `agent-host-protocol.ts` doc comment on `hello`'s `instanceId` for how the kernel copes with
 * that):
 *   - one cached `AttachedContainerIo` per principal (`attachments`) — re-attached whenever
 *     `supervisor-client.spawn`'s returned `containerId` differs from the cached one (crash,
 *     `docker kill`, or an idle-timeout stop followed by a fresh spawn all look the same from
 *     here: a new container id). Each record also remembers which chat's pi session that pi
 *     process currently has loaded (`currentChatId`); a new container id (or a closed stdio pipe)
 *     means a fresh pi process whose session is unknown, so the record — and with it that memory
 *     — is dropped and the next Turn switches again.
 *   - at most one active Turn per principal (`activeTurns`) — matches pi's own RPC-mode
 *     constraint of one in-flight prompt per process (`docs/rpc.md` "prompt": streaming without
 *     `streamingBehavior` is rejected) and the fact that one entry container is one pi process
 *     for one user (design doc §7.2). A user's *second* chat sending a message while the first is
 *     still running is rejected outright (`turnRejected`) rather than silently corrupting which
 *     Turn a translated event gets attributed to — see `handleStartTurn`'s own comment.
 *
 * One entry container is still one pi *process* per user, but no longer one pi *session* across
 * that user's chats (leftover 33, docs/STATUS.md row 33): every Chat gets its own session file,
 * `/workspace/.pi/sessions/chat-<chatId>.jsonl` under the `--session-dir` the container's own
 * entrypoint sets (`deploy/worker-runtime/entrypoint.sh`), and `handleStartTurn` issues pi's
 * `switch_session` before the `prompt` whenever the process is not already on this chat's file
 * (`docs/rpc.md` "switch_session": a path that does not exist yet starts a new session there).
 * Two chats of the same user therefore never see each other's context; cross-chat memory is the
 * kernel's job through injected `context`, not pi's session files ("跨对话记忆靠 context 注入而非
 * pi 会话文件"). The switch is a round trip, so the `prompt` is written only once pi's own
 * `{"type":"response","command":"switch_session",...}` confirms it — `handleLine` below.
 *
 * **A Turn is bound to exactly one container, and only that container's stream may move it**
 * (docs/STATUS.md leftover 44 — "常驻入口容器重建撞上 Turn"). `handleStartTurn` reserves the
 * principal's `activeTurns` slot *before* `ensureAttachment` (the P2-6 race guard below), but
 * `ensureAttachment`'s `/resident/spawn` can legitimately replace the container underneath it:
 * worker-supervisor's `resident-service.ts` stops and recreates a running entry container when
 * the spec it was created with no longer matches (a Handle rotated because a gate was connected
 * — `connect_gatekeeper` → new Grant → the kernel's `ensureEntryHandle` reissues → a new `jti` —
 * a Skill-set change, or an egress-deny drift), and it does so *inside* that spawn call, before
 * returning the new container id. The old container's attach stream therefore closes while this
 * Turn is reserved but has been handed to no container at all; attributing that close to the
 * Turn (which is what an unqualified "the container closed mid-turn" lookup did) reported it
 * `interrupted` to the kernel and dropped it, so the `switch_session` later written to the *new*
 * container answered into a void — the Turn never reached pi. The same goes for a stray stdout
 * line the dying process emits during its SIGTERM window (an `agent_settled` from the old pi
 * would have "completed" a Turn that never started). Hence `ActiveTurn.containerId`: `undefined`
 * while the spawn is in flight, set the moment `ensureAttachment` resolves (before any command is
 * written), and every `onLine`/`onClose` listener is registered with the container id it belongs
 * to — `handleLine`/`handleContainerClosed` ignore anything from a container the active Turn is
 * not bound to, and drop the cached attachment only when it is the one that closed. The
 * supervisor's side already completes the recreate before it returns, so "recreate first, then
 * deliver" holds by construction once the stale stream can no longer end the Turn.
 *
 * Mid-Turn spec changes (a gate connected while a Turn is running) never touch the running
 * container: `/resident/spawn` is only ever called from `handleStartTurn`, and this module rejects
 * a second Turn per principal while one is active, so the recreate is deferred until the next
 * Turn starts — the running Turn keeps the Handle (and gate set) it started with, the next Turn
 * gets the recreated container with the new one. The supervisor's own `reconcile()` only restores
 * registries, it never stops a container.
 *
 * **Mid-Turn idle-clock refresh** (docs/STATUS.md leftover 46): worker-supervisor's `sweepIdle`
 * only knows a container is busy through `touch`, and `ensureAttachment` used to call it exactly
 * once, at Turn start — a Turn still running past `entryIdleTimeoutMs` (30 min default) later
 * could be stopped by the sweep out from under it. `handleLine` now calls `refreshTouch` for every
 * line pi emits while bound to the active Turn (switch/prompt responses and translated events
 * alike — see its own comment), throttled to at most once per `TOUCH_REFRESH_INTERVAL_MS` so a
 * fast token stream doesn't turn into a `touch` call per line. This only keeps the clock fresh for
 * a Turn that is still producing pi stdout; a Turn silently blocked for longer than the idle
 * timeout with no pi activity at all (e.g. a long `await_decision` gate wait) is not covered — out
 * of scope for this fix, same as before.
 */

export interface HostOptions {
  readonly supervisorClient: SupervisorClientPort;
  readonly containerIoClient: ContainerIoClient;
  readonly kernelLink: KernelLink;
  /** This agent-host process's own `KERNEL_URL` — forwarded as `spawn`'s `kernelUrl` so
   *  worker-supervisor's spawned container gets the same value agent-host itself was configured
   *  with, rather than worker-supervisor's own compose-level default (normally identical, but
   *  explicit beats implicit for a value this deployment-critical). */
  readonly kernelUrl: string;
  /** This agent-host process's own `KERNEL_LLM_URL` — used only as a defensive fallback for
   *  `spawn`'s `llmUrl`. The authoritative value for a given Turn is the `startTurn` command's own
   *  `kernelLlmUrl` field (the kernel already knows its configured `KERNEL_LLM_URL`; see
   *  `@nexttime/shared`'s `agent-host-protocol.ts` doc comment on that field) — this default only
   *  matters if that were ever empty, which the wire schema does not currently allow. Kept (and
   *  read from this process's own env in `index.ts`) so agent-host's env var list matches this
   *  task's own dispatch text verbatim, even though the per-turn value is what actually governs
   *  in practice — see PR body "假设与偏离". */
  readonly defaultKernelLlmUrl: string;
  readonly log?: (line: string) => void;
  /** Injectable clock for `refreshTouch`'s throttle window (module doc comment, leftover 46) —
   *  defaults to `Date.now`. Tests supply a fake clock instead of real timers. */
  readonly now?: () => number;
}

export interface Host {
  handleStartTurn(cmd: Extract<KernelToAgentHostFrame, { type: 'startTurn' }>): Promise<void>;
  handleStopTurn(cmd: Extract<KernelToAgentHostFrame, { type: 'stopTurn' }>): void;
}

interface AttachmentRecord {
  readonly containerId: string;
  readonly io: AttachedContainerIo;
  /** Which chat's pi session this container's pi process currently has loaded, as far as this
   *  process knows — `undefined` until the first confirmed `switch_session` (a freshly attached
   *  container is a freshly started pi process on whatever session `--session-dir` gave it). Set
   *  only when pi itself confirms the switch, never optimistically on write. */
  currentChatId: string | undefined;
}

interface ActiveTurn {
  readonly turnId: string;
  readonly workspaceId: string;
  readonly chatId: string;
  /** The container this Turn has been handed to — `undefined` from the slot reservation in
   *  `handleStartTurn` until `ensureAttachment` resolves (see the module doc comment, leftover
   *  44): while it is `undefined`, no container's stream may end or advance this Turn, because
   *  none has been given it yet; once set, only that container's stream may. */
  containerId: string | undefined;
  stopRequested: boolean;
  /** The `id` of the `switch_session` command written for this Turn while its response is still
   *  outstanding, `undefined` once it has been answered (or when no switch was needed at all).
   *  While it is set, `pendingPrompt` holds the `prompt` text that `handleLine` writes as soon as
   *  pi confirms the switch — this Turn has not been sent to pi yet, so it is still `turnRejected`
   *  (not `turnEnded`) territory if the switch fails or a `stopTurn` overtakes it. */
  pendingSwitchId: string | undefined;
  pendingPrompt: string | undefined;
}

/** The `--session-dir` `deploy/worker-runtime/entrypoint.sh` starts pi with — writable and
 *  per-principal (it lives in the entry container's own `/workspace`). */
const PI_SESSION_DIR = '/workspace/.pi/sessions';

/** A `chatId` is a kernel-issued UUID, but it becomes part of a path inside the container
 *  (`chat-<chatId>.jsonl`), so it is checked against this conservative character class before that
 *  path is ever built — no `/`, no `..`, nothing that could point `switch_session` at a file
 *  outside the session dir. */
const SAFE_CHAT_ID = /^[A-Za-z0-9_-]+$/;

function piSessionPathForChat(chatId: string): string {
  return `${PI_SESSION_DIR}/chat-${chatId}.jsonl`;
}

/** Leftover 46 (module doc comment): how often `refreshTouch` is allowed to call
 *  `supervisorClient.touch` for the same principal while a Turn is active — comfortably under
 *  worker-supervisor's `entryIdleTimeoutMs` default (30 min, `ENTRY_IDLE_TIMEOUT_MS`) so a Turn
 *  producing any pi activity at all never goes idle-swept, without a `touch` per stdout line. */
const TOUCH_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

export function createHost(options: HostOptions): Host {
  const { supervisorClient, containerIoClient, kernelLink, kernelUrl, defaultKernelLlmUrl } =
    options;
  const log = options.log ?? ((line: string) => console.error(line));
  const now = options.now ?? (() => Date.now());

  const attachments = new Map<string, AttachmentRecord>();
  const activeTurns = new Map<string, ActiveTurn>();
  /** Leftover 46 (module doc comment): last time `refreshTouch` (or the Turn-start touch in
   *  `ensureAttachment`) actually called `supervisorClient.touch` for this principal — the
   *  throttle window's own clock, distinct from worker-supervisor's `lastTouchedAt` registry. */
  const lastTouchAt = new Map<string, number>();

  /** Best-effort `supervisorClient.touch` — failures are logged, never thrown, since a missed
   *  touch only risks a future idle sweep, not this Turn's own correctness. */
  function performTouch(principalId: string, context: string): void {
    supervisorClient.touch(principalId).catch((err: unknown) => {
      log(
        JSON.stringify({
          level: 'warn',
          msg: `agent-host: supervisor touch failed (${context})`,
          principalId,
          error: String(err),
        }),
      );
    });
  }

  /** Leftover 46: called from `handleLine` for every line pi emits while bound to an active Turn.
   *  Throttled to `TOUCH_REFRESH_INTERVAL_MS` — `lastTouchAt` is set here (and by
   *  `ensureAttachment`'s own Turn-start touch below) so a burst of streamed events right after a
   *  Turn starts doesn't immediately re-touch on top of the touch `ensureAttachment` already sent. */
  function refreshTouch(principalId: string): void {
    const last = lastTouchAt.get(principalId) ?? 0;
    const nowMs = now();
    if (nowMs - last < TOUCH_REFRESH_INTERVAL_MS) return;
    lastTouchAt.set(principalId, nowMs);
    performTouch(principalId, 'mid-turn idle-clock refresh');
  }

  function handleContainerClosed(
    principalId: string,
    containerId: string,
    err: Error | undefined,
  ): void {
    // Only the attachment that actually closed is dropped — by the time a *replaced* container's
    // stream ends, `ensureAttachment` may already have cached the new one under this principal.
    if (attachments.get(principalId)?.containerId === containerId) attachments.delete(principalId);
    const turn = activeTurns.get(principalId);
    if (!turn) {
      // Not mid-turn (e.g. idle-timeout stop, or a stop this process itself requested) —
      // nothing to report; the next startTurn re-spawns and re-attaches.
      return;
    }
    if (turn.containerId !== containerId) {
      // Leftover 44 (module doc comment): a container this Turn was never handed to — the
      // previous container worker-supervisor retired inside this very Turn's `/resident/spawn`
      // (`containerId` still `undefined`), or one it already replaced. Its stream ending says
      // nothing about this Turn, which lives (or is about to live) in the new container.
      log(
        JSON.stringify({
          level: 'info',
          msg: 'agent-host: a container this turn is not bound to closed — ignoring (recreate in flight or already replaced)',
          principalId,
          turnId: turn.turnId,
          closedContainerId: containerId,
          boundContainerId: turn.containerId,
        }),
      );
      return;
    }
    activeTurns.delete(principalId);
    log(
      JSON.stringify({
        level: 'warn',
        msg: 'agent-host: entry container stdio closed mid-turn — reporting interrupted',
        principalId,
        turnId: turn.turnId,
        error: err ? String(err) : undefined,
      }),
    );
    kernelLink.sendRuntimeEvent({
      type: 'turnEnded',
      status: 'interrupted',
      workspaceId: turn.workspaceId,
      chatId: turn.chatId,
      turnId: turn.turnId,
      principalId,
    });
  }

  /** pi's answer to the `switch_session` `turn` is waiting on (see this module's doc comment).
   *  Success is the moment this Turn's prompt can finally be written; a failed or extension-
   *  cancelled switch — and a `stopTurn` that overtook the round trip — ends the Turn before pi
   *  ever saw its prompt, which the kernel is told as `turnRejected`, not `turnEnded`: no
   *  `turnAccepted` has been sent for it. */
  function handleSwitchSessionResponse(
    principalId: string,
    turn: ActiveTurn,
    response: Record<string, unknown>,
  ): void {
    const data = response.data;
    const cancelled =
      typeof data === 'object' &&
      data !== null &&
      (data as Record<string, unknown>).cancelled === true;
    const prompt = turn.pendingPrompt ?? '';
    turn.pendingSwitchId = undefined;
    turn.pendingPrompt = undefined;

    // `success !== true` rather than `=== false`: a malformed response must still settle the Turn
    // rather than leave it waiting on a switch that will never be answered again.
    if (response.success !== true || cancelled) {
      activeTurns.delete(principalId);
      const reason =
        typeof response.error === 'string' ? response.error : 'pi cancelled the session switch';
      kernelLink.sendTurnRejected(turn.turnId, reason);
      return;
    }

    // pi really did load this chat's session file — record that even if the Turn itself is dropped
    // just below: this flag tracks the pi *process*'s state, not the Turn's fate.
    const attachment = attachments.get(principalId);
    if (attachment) attachment.currentChatId = turn.chatId;

    if (turn.stopRequested) {
      activeTurns.delete(principalId);
      kernelLink.sendTurnRejected(turn.turnId, 'turn stopped before the session switch completed');
      return;
    }

    attachment?.io.writeLine(buildPromptCommand(turn.turnId, prompt));
  }

  /** One line of pi's stdout for `principalId`'s container `containerId`. Handles the
   *  `switch_session` and `prompt` RPC response correlation itself (not part of `bridge.ts`'s
   *  event vocabulary — see that module's own doc comment) before falling through to
   *  `translatePiEvent` for everything else. A line from a container the active Turn is not bound
   *  to (leftover 44, module doc comment — a container being retired by a recreate, or one
   *  already replaced) is dropped exactly like a line with no tracked Turn at all. */
  function handleLine(principalId: string, containerId: string, line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return; // not JSON — pi's own stdout is exclusively JSONL per docs/rpc.md; ignore stray output
    }
    if (typeof parsed !== 'object' || parsed === null) return;
    const record = parsed as Record<string, unknown>;

    const activeTurn = activeTurns.get(principalId);
    const turn = activeTurn && activeTurn.containerId === containerId ? activeTurn : undefined;

    // Leftover 46 (module doc comment): any stdout line from the container this Turn is actually
    // bound to is proof it is still alive and busy — refresh the idle clock (throttled) rather
    // than letting `sweepIdle` judge liveness solely by this Turn's own start time.
    if (turn) refreshTouch(principalId);

    if (
      record.type === 'response' &&
      record.command === 'switch_session' &&
      turn &&
      turn.pendingSwitchId !== undefined &&
      // pi 0.84.4 echoes the command's `id` (`rpc-mode.js`: `success(id, "switch_session", …)`,
      // `id = command.id`); tolerate a response without one while a switch is pending so a future
      // pi that drops the echo cannot leave this principal wedged.
      (record.id === turn.pendingSwitchId || record.id === undefined)
    ) {
      handleSwitchSessionResponse(principalId, turn, record);
      return;
    }

    if (
      record.type === 'response' &&
      record.command === 'prompt' &&
      turn &&
      record.id === turn.turnId
    ) {
      if (record.success === true) {
        kernelLink.sendTurnAccepted(turn.turnId);
      } else {
        activeTurns.delete(principalId);
        const reason = typeof record.error === 'string' ? record.error : 'pi rejected the prompt';
        kernelLink.sendTurnRejected(turn.turnId, reason);
      }
      return;
    }

    if (record.type === 'extension_error') {
      log(
        JSON.stringify({
          level: 'warn',
          msg: 'agent-host: pi extension_error',
          principalId,
          extensionPath: record.extensionPath,
          event: record.event,
          error: record.error,
        }),
      );
      return;
    }

    const result = translatePiEvent(parsed);
    if (result.kind === 'none') return;
    if (!turn) return; // an event with no tracked turn to correlate it to — drop it

    if (result.kind === 'turnSettled') {
      activeTurns.delete(principalId);
      kernelLink.sendRuntimeEvent({
        type: 'turnEnded',
        status: turn.stopRequested ? 'interrupted' : 'completed',
        workspaceId: turn.workspaceId,
        chatId: turn.chatId,
        turnId: turn.turnId,
        principalId,
      });
      return;
    }

    kernelLink.sendRuntimeEvent({
      ...result.fields,
      workspaceId: turn.workspaceId,
      chatId: turn.chatId,
      turnId: turn.turnId,
      principalId,
    } as AgentRuntimeEventWire);
  }

  async function ensureAttachment(
    principalId: string,
    workspaceId: string,
    handle: string,
    llmUrl: string,
    systemPrompt: string | undefined,
    model: string | undefined,
    egressDeny: readonly string[] | undefined,
    skillsInline: SpawnInput['skillsInline'],
  ): Promise<AttachmentRecord> {
    const spawnResult = await supervisorClient.spawn({
      workspaceId,
      principalId,
      handle,
      kernelUrl,
      llmUrl,
      systemPrompt,
      model,
      egressDeny,
      skillsInline,
    });

    // Best-effort — spawn() itself already refreshed worker-supervisor's idle clock for this
    // principal (resident-service.ts's own spawn() sets `lastTouchedAt` on every call, reuse or
    // fresh), so a failure here never blocks the turn; this call is the architecture's explicit
    // "touch the supervisor each Turn" requirement made visible even when spawn alone would have
    // sufficed. Also seeds `refreshTouch`'s own throttle window (leftover 46, module doc comment)
    // so the first pi stdout line right after this doesn't immediately re-touch on top of it.
    lastTouchAt.set(principalId, now());
    performTouch(principalId, 'spawn already refreshed the idle clock');

    const existing = attachments.get(principalId);
    if (existing && existing.containerId === spawnResult.containerId) return existing;
    if (existing) existing.io.close(); // stale — the container behind it is gone (new id returned)

    const io = await containerIoClient.attach(spawnResult.containerId);
    // Both listeners carry the id of the container they were attached to (module doc comment,
    // leftover 44): `handleLine`/`handleContainerClosed` compare it against the active Turn's own
    // binding rather than trusting "a stream for this principal" to mean "this Turn's stream".
    const { containerId } = spawnResult;
    io.onLine((line) => handleLine(principalId, containerId, line));
    io.onClose((err) => handleContainerClosed(principalId, containerId, err));
    const record: AttachmentRecord = {
      containerId: spawnResult.containerId,
      io,
      currentChatId: undefined, // fresh pi process — nothing is known about its loaded session
    };
    attachments.set(principalId, record);
    return record;
  }

  return {
    async handleStartTurn(cmd): Promise<void> {
      if (activeTurns.has(cmd.principalId)) {
        // See this module's own doc comment: at most one Turn in flight per principal at a time.
        kernelLink.sendTurnRejected(
          cmd.turnId,
          'entry container is already processing another turn for this principal',
        );
        return;
      }

      // Reserve the slot *synchronously*, before the first `await` below (lane-6 review P2-6).
      // JS runs everything up to an `await` without interruption, so this check-then-reserve is
      // atomic: no other `handleStartTurn` call for this principal can observe `activeTurns` in
      // between. Without this, two `startTurn` frames for the same principal arriving close
      // together could both pass the `has()` check above and both call `ensureAttachment`
      // concurrently — each would independently see no cached attachment yet, both would
      // `containerIoClient.attach()` the same container (duplicate stdio subscriptions, the first
      // `io` leaked/never closed), and whichever `activeTurns.set()` ran last would silently
      // overwrite the other's entry — the earlier Turn's `turnId` would then never match an
      // incoming `handleLine` event again and would simply never end. Reserving here instead of
      // after `ensureAttachment` closes that window entirely; on failure below the reservation is
      // released so a legitimate retry isn't blocked by a Turn that never actually started.
      const turn: ActiveTurn = {
        turnId: cmd.turnId,
        workspaceId: cmd.workspaceId,
        chatId: cmd.chatId,
        containerId: undefined, // bound below, once ensureAttachment says which container
        stopRequested: false,
        pendingSwitchId: undefined,
        pendingPrompt: undefined,
      };
      activeTurns.set(cmd.principalId, turn);

      let record: AttachmentRecord;
      try {
        record = await ensureAttachment(
          cmd.principalId,
          cmd.workspaceId,
          cmd.handle,
          cmd.kernelLlmUrl || defaultKernelLlmUrl,
          cmd.systemPrompt,
          cmd.model,
          cmd.egressDeny,
          cmd.skillsInline,
        );
      } catch (err) {
        activeTurns.delete(cmd.principalId); // release the reservation — this turn never started
        log(
          JSON.stringify({
            level: 'error',
            msg: 'agent-host: failed to spawn/attach the entry container',
            principalId: cmd.principalId,
            turnId: cmd.turnId,
            error: String(err),
          }),
        );
        kernelLink.sendTurnRejected(
          cmd.turnId,
          `failed to spawn/attach the entry container: ${String(err)}`,
        );
        return;
      }

      // Bind the Turn to the container it is about to be written to — before any command goes
      // out, so every response/event this container emits for it is accepted, and nothing the
      // previous container (if the spawn just replaced it) still emits is (leftover 44, module
      // doc comment).
      turn.containerId = record.containerId;

      // turnAccepted is sent from handleLine, once pi's own {"type":"response","command":"prompt",
      // "id":cmd.turnId,"success":true} confirms it — not here (see bridge.ts's
      // buildPromptCommand doc comment for why that is the real acceptance signal).
      //
      // Leftover 56 (docs/STATUS.md): `turn.stopRequested` must be checked here exactly like
      // `handleSwitchSessionResponse` already checks it before its own prompt write, above — a
      // `stopTurn` can arrive for this turnId while `ensureAttachment` was still awaiting (the
      // window between the synchronous reservation and this point). Without this check the prompt
      // still reached pi and the stop was silently swallowed: `handleStopTurn` had already run and
      // found no `pendingSwitchId` to fall through from, so it wrote an `abort` to whatever
      // attachment existed at that moment (stale or none) instead of this Turn's prompt, which
      // this branch would then send anyway.
      if (record.currentChatId === cmd.chatId) {
        if (turn.stopRequested) {
          activeTurns.delete(cmd.principalId);
          kernelLink.sendTurnRejected(cmd.turnId, 'turn stopped before the prompt was sent');
          return;
        }
        record.io.writeLine(buildPromptCommand(cmd.turnId, cmd.prompt));
        return;
      }

      if (!SAFE_CHAT_ID.test(cmd.chatId)) {
        activeTurns.delete(cmd.principalId); // release the reservation — this turn never started
        kernelLink.sendTurnRejected(cmd.turnId, 'chatId is not usable as a pi session file name');
        return;
      }

      // A chat this pi process is not on: switch its session first (see the module doc comment)
      // and let handleLine write the prompt once pi confirms.
      turn.pendingSwitchId = `switch:${cmd.turnId}`;
      turn.pendingPrompt = cmd.prompt;
      record.io.writeLine(
        buildSwitchSessionCommand(turn.pendingSwitchId, piSessionPathForChat(cmd.chatId)),
      );
    },

    handleStopTurn(cmd): void {
      const turn = activeTurns.get(cmd.principalId);
      if (!turn || turn.turnId !== cmd.turnId) return; // unknown/already-ended — idempotent no-op
      turn.stopRequested = true;
      // Mid-`switch_session`: pi has not been given this Turn's prompt yet, so there is nothing to
      // abort — handleSwitchSessionResponse drops the Turn when the switch lands instead.
      if (turn.pendingSwitchId !== undefined) return;
      const record = attachments.get(cmd.principalId);
      record?.io.writeLine(buildAbortCommand());
    },
  };
}
