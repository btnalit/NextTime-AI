import type { ContextEvent, ExtensionAPI } from '@earendil-works/pi-coding-agent';
import {
  type EntryContextResult,
  type EntryContextSection,
  changedSectionKeys,
  joinEntryContext,
  renderEntryContextSections,
  renderEntryContextUpdate,
} from './entry-context.js';
import { keepCacheBreakpointOnHistory } from './prompt-cache.js';

/**
 * Where the live context goes in each model call (legacy 229, entry and interactive mode).
 *
 * Before: the whole context (pending approvals, running tasks, graph overview, recent Facts) was
 * appended as the last message of every call. A prefix cache can only reuse what a later request
 * repeats at the same position, and the next request always has new messages before the context —
 * so the 4.5–5k token context was billed as fresh input on every call (v0.46.0 candidate run
 * 38030885497: about half the real-model cost), on every provider, explicit breakpoints or not.
 *
 * Now the context is a **snapshot placed once and repeated byte for byte**:
 *
 *   - It is placed right after the newest message of the call that takes it — at the start of a
 *     run, that is the user's prompt — and every later call of the session puts the identical
 *     message back right after that same message. Everything up to and including it is then part
 *     of the prefix the previous call already wrote, and the provider serves it from cache.
 *   - Every call still reads the kernel. If the context is unchanged, the snapshot is current and
 *     nothing else is sent. If a section changed in the middle of a run (a Task finished, an
 *     approval arrived), only the changed sections go last as an update that says it replaces them
 *     — uncached, like the whole context was before, but only what changed; the cache breakpoint
 *     stays on the history before it (`prompt-cache.ts`).
 *   - At the start of the next run (`startRun`, the mode's `before_agent_start`), a context that
 *     differs from the snapshot is placed again after the new prompt and the old one disappears,
 *     so a run never starts from an update stacked on stale state. That costs one cache write of
 *     every message after the old snapshot (they now follow different bytes), counted in the
 *     Turn's first call; an unchanged context keeps its old place and costs nothing. The snapshot
 *     is also placed again whenever the message it follows is gone from the history (pi compacted
 *     it away).
 *
 * The snapshot plus the update always read as the current state, so the model never acts on a
 * stale section. The context is still never persisted (pi's `context` result is per call) — the
 * snapshot is kept in this process only, and a restarted container simply places it again.
 *
 * Inserting after the newest message never splits a `tool_use` from its `tool_result`: when the
 * context hook runs, every tool result of the last assistant message is already in the history,
 * and the next message to follow it is an assistant message.
 */

type Message = ContextEvent['messages'][number];

export interface LiveContextOptions {
  /** The mode's heading (`NextTime entry context`). */
  readonly title: string;
  /** The injected message's `customType` (`nexttime-entry-context`). */
  readonly customType: string;
  /** Log prefix component: lines read `nexttime-<component> check=live_context ...`. */
  readonly component: string;
  /** This call's `get_entry_context` result, or `undefined` when the read failed (the mode has
   *  logged why). */
  readonly read: () => Promise<EntryContextResult | undefined>;
}

export interface LiveContext {
  /** A new run starts (the mode's `before_agent_start`): its first successful read decides
   *  whether the snapshot stays where it is. */
  startRun(): void;
}

interface Snapshot {
  /** Identity of the message the snapshot follows; `null` when it opens the conversation. */
  readonly afterKey: string | null;
  readonly sections: readonly EntryContextSection[];
  readonly message: Message;
}

/** A message's identity across calls — pi hands every `context` handler a structured clone of the
 *  history, so the same message is recognized by what it is, not by reference. */
function messageKey(message: Message): string {
  const { role, timestamp, content } = message as {
    role?: unknown;
    timestamp?: unknown;
    content?: unknown;
  };
  return JSON.stringify([role, timestamp, content]);
}

/** Index the snapshot goes at, or `-1` when the message it follows is gone. */
function insertionIndex(messages: readonly Message[], afterKey: string | null): number {
  if (afterKey === null) return 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messageKey(messages[index] as Message) === afterKey) return index + 1;
  }
  return -1;
}

function formatKeys(keys: readonly string[]): string {
  return keys.length > 0 ? keys.join(',') : '-';
}

export function installLiveContext(pi: ExtensionAPI, options: LiveContextOptions): LiveContext {
  const prefix = `nexttime-${options.component} check=live_context`;
  const noteAppendedUpdate = keepCacheBreakpointOnHistory(pi);
  let snapshot: Snapshot | undefined;
  /** The update sent with the snapshot on the last successful read (`''` when none). */
  let lastUpdate = '';
  let runStarted = false;

  function customMessage(content: string): Message {
    return {
      role: 'custom',
      customType: options.customType,
      content,
      display: false,
      timestamp: Date.now(),
    };
  }

  function place(
    messages: readonly Message[],
    sections: readonly EntryContextSection[],
    text: string,
  ): Message {
    const last = messages[messages.length - 1];
    const message = customMessage(text);
    snapshot = { afterKey: last ? messageKey(last) : null, sections, message };
    return message;
  }

  /** Whether the read is a usable `get_entry_context` result; anything else is a failed read. */
  function isResult(value: unknown): value is EntryContextResult {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  pi.on('context', async (event) => {
    noteAppendedUpdate(undefined);
    const messages = event.messages;
    const context = await options.read();
    const at = snapshot ? insertionIndex(messages, snapshot.afterKey) : -1;

    if (!isResult(context)) {
      // A failed read (kernel error, timeout, malformed result). Without a snapshot in this
      // conversation there is nothing to inject. With one, it stays in place — still the prefix
      // the previous call wrote — but this call cannot say it is current: the last update goes
      // last again, under a notice that neither is fresh (#575 review: without it the model read
      // the snapshot's older state, or a finished Turn's items, as the current one). A run that
      // starts on a failed read still decides at its first successful one (`runStarted` kept).
      if (!snapshot || at < 0) return undefined;
      const notice = [
        `## ${options.title} — not refreshed`,
        `The live context could not be read for this call. The ${options.title} above${
          lastUpdate ? ' and the update below are' : ' is'
        } from an earlier call and may be out of date: treat nothing in ${
          lastUpdate ? 'them' : 'it'
        } as new, and check with a tool before relying on an approval or task status shown there.`,
        ...(lastUpdate ? [lastUpdate] : []),
      ].join('\n\n');
      console.error(`${prefix} result=kept_on_read_error update_chars=${lastUpdate.length}`);
      noteAppendedUpdate(notice);
      return {
        messages: [
          ...messages.slice(0, at),
          snapshot.message,
          ...messages.slice(at),
          customMessage(notice),
        ],
      };
    }

    const sections = renderEntryContextSections(context);
    const changed = snapshot ? changedSectionKeys(snapshot.sections, sections) : [];
    const startsRun = runStarted;
    runStarted = false;

    if (!snapshot || at < 0 || (startsRun && changed.length > 0)) {
      const reason = !snapshot ? 'first' : at < 0 ? 'anchor_lost' : 'changed';
      lastUpdate = '';
      if (sections.length === 0) {
        snapshot = undefined;
        console.log(`${prefix} result=empty reason=${reason}`);
        return undefined;
      }
      const text = joinEntryContext(sections, options.title);
      console.log(
        `${prefix} result=placed reason=${reason} sections=${formatKeys(
          sections.map((section) => section.key),
        )} chars=${text.length}`,
      );
      return { messages: [...messages, place(messages, sections, text)] };
    }

    const withSnapshot = [...messages.slice(0, at), snapshot.message, ...messages.slice(at)];
    const update = renderEntryContextUpdate(snapshot.sections, sections, options.title);
    lastUpdate = update;
    console.log(
      `${prefix} result=reused changed=${formatKeys(changed)} update_chars=${update.length}`,
    );
    if (!update) return { messages: withSnapshot };
    noteAppendedUpdate(update);
    return { messages: [...withSnapshot, customMessage(update)] };
  });

  return {
    startRun() {
      runStarted = true;
    },
  };
}
