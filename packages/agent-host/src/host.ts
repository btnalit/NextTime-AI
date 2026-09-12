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

export function createHost(options: HostOptions): Host {
  const { supervisorClient, containerIoClient, kernelLink, kernelUrl, defaultKernelLlmUrl } =
    options;
  const log = options.log ?? ((line: string) => console.error(line));

  const attachments = new Map<string, AttachmentRecord>();
  const activeTurns = new Map<string, ActiveTurn>();

  function handleContainerClosed(principalId: string, err: Error | undefined): void {
    attachments.delete(principalId);
    const turn = activeTurns.get(principalId);
    if (!turn) {
      // Not mid-turn (e.g. idle-timeout stop, or a stop this process itself requested) —
      // nothing to report; the next startTurn re-spawns and re-attaches.
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

  /** One line of pi's stdout for `principalId`'s container. Handles the `switch_session` and
   *  `prompt` RPC response correlation itself (not part of `bridge.ts`'s event vocabulary — see
   *  that module's own doc comment) before falling through to `translatePiEvent` for everything
   *  else. */
  function handleLine(principalId: string, line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return; // not JSON — pi's own stdout is exclusively JSONL per docs/rpc.md; ignore stray output
    }
    if (typeof parsed !== 'object' || parsed === null) return;
    const record = parsed as Record<string, unknown>;

    const turn = activeTurns.get(principalId);

    if (
      record.type === 'response' &&
      record.command === 'switch_session' &&
      turn &&
      turn.pendingSwitchId !== undefined &&
      record.id === turn.pendingSwitchId
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
    // sufficed.
    supervisorClient.touch(principalId).catch((err: unknown) => {
      log(
        JSON.stringify({
          level: 'warn',
          msg: 'agent-host: supervisor touch failed (spawn already refreshed the idle clock)',
          principalId,
          error: String(err),
        }),
      );
    });

    const existing = attachments.get(principalId);
    if (existing && existing.containerId === spawnResult.containerId) return existing;
    if (existing) existing.io.close(); // stale — the container behind it is gone (new id returned)

    const io = await containerIoClient.attach(spawnResult.containerId);
    io.onLine((line) => handleLine(principalId, line));
    io.onClose((err) => handleContainerClosed(principalId, err));
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

      // turnAccepted is sent from handleLine, once pi's own {"type":"response","command":"prompt",
      // "id":cmd.turnId,"success":true} confirms it — not here (see bridge.ts's
      // buildPromptCommand doc comment for why that is the real acceptance signal).
      if (record.currentChatId === cmd.chatId) {
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
