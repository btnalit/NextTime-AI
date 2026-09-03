import type { AgentRuntimeEventWire, KernelToAgentHostFrame } from '@nexttime/shared';
import { buildAbortCommand, buildPromptCommand, translatePiEvent } from './bridge.js';
import type { AttachedContainerIo, ContainerIoClient } from './container-io.js';
import type { KernelLink } from './kernel-link.js';
import type { SupervisorClientPort } from './supervisor-client.js';

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
 *     here: a new container id).
 *   - at most one active Turn per principal (`activeTurns`) — matches pi's own RPC-mode
 *     constraint of one in-flight prompt per process (`docs/rpc.md` "prompt": streaming without
 *     `streamingBehavior` is rejected) and the fact that one entry container is one pi process
 *     for one user (design doc §7.2). A user's *second* chat sending a message while the first is
 *     still running is rejected outright (`turnRejected`) rather than silently corrupting which
 *     Turn a translated event gets attributed to — see `handleStartTurn`'s own comment. Neither
 *     any prior S1 task nor the design doc resolves how multiple concurrent chats for the same
 *     user should share one entry container's single pi session; this is a known S1 limitation,
 *     not a decision made unilaterally here (see PR body "假设与偏离").
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
}

interface ActiveTurn {
  readonly turnId: string;
  readonly workspaceId: string;
  readonly chatId: string;
  stopRequested: boolean;
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

  /** One line of pi's stdout for `principalId`'s container. Handles the `prompt` RPC response
   *  correlation itself (not part of `bridge.ts`'s event vocabulary — see that module's own doc
   *  comment) before falling through to `translatePiEvent` for everything else. */
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
  ): Promise<AttachmentRecord> {
    const spawnResult = await supervisorClient.spawn({
      workspaceId,
      principalId,
      handle,
      kernelUrl,
      llmUrl,
      systemPrompt,
      model,
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
    const record: AttachmentRecord = { containerId: spawnResult.containerId, io };
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

      let record: AttachmentRecord;
      try {
        record = await ensureAttachment(
          cmd.principalId,
          cmd.workspaceId,
          cmd.handle,
          cmd.kernelLlmUrl || defaultKernelLlmUrl,
          cmd.systemPrompt,
          cmd.model,
        );
      } catch (err) {
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

      activeTurns.set(cmd.principalId, {
        turnId: cmd.turnId,
        workspaceId: cmd.workspaceId,
        chatId: cmd.chatId,
        stopRequested: false,
      });

      // turnAccepted is sent from handleLine, once pi's own {"type":"response","command":"prompt",
      // "id":cmd.turnId,"success":true} confirms it — not here (see bridge.ts's
      // buildPromptCommand doc comment for why that is the real acceptance signal).
      record.io.writeLine(buildPromptCommand(cmd.turnId, cmd.prompt));
    },

    handleStopTurn(cmd): void {
      const turn = activeTurns.get(cmd.principalId);
      if (!turn || turn.turnId !== cmd.turnId) return; // unknown/already-ended — idempotent no-op
      turn.stopRequested = true;
      const record = attachments.get(cmd.principalId);
      record?.io.writeLine(buildAbortCommand());
    },
  };
}
