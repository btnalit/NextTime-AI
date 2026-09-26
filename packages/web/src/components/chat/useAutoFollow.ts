import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { TurnState } from '../../lib/streaming-reducer.js';
import type { ChatMessage } from '../../lib/ws-client.js';

/** How close to the live end (px) still counts as "at the bottom" — the reader may be a line or
 *  two up and still expects the thread to follow. Shared by the `IntersectionObserver` root
 *  margin and the `scroll`-event fallback below so both mechanisms agree. */
const AT_BOTTOM_THRESHOLD_PX = 48;

export interface AutoFollowState {
  readonly scrollRef: RefObject<HTMLDivElement>;
  readonly threadRef: RefObject<HTMLDivElement>;
  readonly sentinelRef: RefObject<HTMLDivElement>;
  readonly following: boolean;
  readonly setFollow: (next: boolean) => void;
  readonly unseen: number;
  readonly onScroll: () => void;
  readonly jumpToLatest: () => void;
}

/**
 * components/chat/useAutoFollow: `ChatPage`'s W3 auto-follow (console-completion-plan §2 row W3,
 * §5.1, §9). `followingRef` is the intent ("keep the live end in view") read synchronously by the
 * layout effect and the observers; `following` mirrors it for rendering the `FollowPill`.
 * `lastWrittenTop` is the scrollTop this hook itself last wrote — the way the `scroll`-event
 * fallback tells its own programmatic scroll (which must never stop following) from the reader's.
 *
 * Bottom sentinel + `IntersectionObserver` (W3 fix, plan §5.1 "改用 IntersectionObserver 判底"): the
 * sentinel is the last child of the thread, so "is it within `AT_BOTTOM_THRESHOLD_PX` of the
 * viewport" *is* "is the reader at the bottom". Because every content change scrolls before paint
 * (the layout effect) and every size change re-pins (`ResizeObserver` — resize steps run before
 * intersection steps in the same frame), the sentinel can only leave the viewport when the reader
 * scrolls away — and it re-entering is the reader coming back. Guarded: jsdom has neither observer,
 * so the `scroll` fallback carries the tests.
 */
export function useAutoFollow(messages: readonly ChatMessage[], turn: TurnState): AutoFollowState {
  const scrollRef = useRef<HTMLDivElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const followingRef = useRef(true);
  const lastWrittenTop = useRef(0);
  const [following, setFollowing] = useState(true);
  const [unseen, setUnseen] = useState(0);
  const seenCount = useRef(0);

  const scrollToBottom = useCallback((): void => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    // Read back rather than remember `scrollHeight`: the element clamps the write to its real
    // maximum, and that clamped value is what a later `scroll` event will report.
    lastWrittenTop.current = el.scrollTop;
  }, []);

  const setFollow = useCallback((next: boolean): void => {
    followingRef.current = next;
    setFollowing(next);
    if (next) setUnseen(0);
  }, []);

  // The follow write. A *layout* effect, keyed on the `messages` / `turn` object identities:
  //   - identity, not `${messages.length}:${streamingText.length}:${toolCalls.length}`, so a
  //     tool-call result landing in an already-rendered row (W3 mechanism b — `toolCalls.length`
  //     unchanged, the row grows in place) is a fresh `turn` object and still scrolls;
  //   - layout (before paint), so the observers below never get to see the un-scrolled frame —
  //     the sentinel is back in view before the browser measures intersections.
  // While the reader has scrolled away, count the persisted messages that arrived for the pill.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `turn` is the trigger (streamed text / tool rows grow it), not read in the body
  useLayoutEffect(() => {
    if (followingRef.current) {
      scrollToBottom();
      seenCount.current = messages.length;
      return;
    }
    if (messages.length > seenCount.current) {
      const delta = messages.length - seenCount.current;
      setUnseen((count) => count + delta);
    }
    seenCount.current = messages.length;
  }, [messages, turn, scrollToBottom]);

  useEffect(() => {
    const root = scrollRef.current;
    const sentinel = sentinelRef.current;
    if (!root || !sentinel || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[entries.length - 1];
        if (!entry) return;
        if (entry.isIntersecting !== followingRef.current) setFollow(entry.isIntersecting);
      },
      { root, rootMargin: `0px 0px ${AT_BOTTOM_THRESHOLD_PX}px 0px`, threshold: 0 },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [setFollow]);

  // In-place growth that no React state announces (an image or a `<details>` opening, fonts
  // arriving, the viewport shrinking): re-pin to the bottom while following.
  useEffect(() => {
    const root = scrollRef.current;
    const thread = threadRef.current;
    if (!root || !thread || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (followingRef.current) scrollToBottom();
    });
    observer.observe(thread);
    observer.observe(root);
    return () => observer.disconnect();
  }, [scrollToBottom]);

  // `scroll`-event fallback (no `IntersectionObserver`). The event a programmatic `scrollTop`
  // write produces is asynchronous: if the next chunk has already been committed by the time it
  // is dispatched, the naive "distance from bottom" reads that chunk's height and stops following
  // (W3 mechanism a). Our own write leaves `scrollTop` at `lastWrittenTop` (or beyond, if the
  // element grew and the browser kept the position) — a reader scrolling *up* is the only way
  // for it to read lower, so that is the one case measured.
  const onScroll = useCallback((): void => {
    const el = scrollRef.current;
    if (!el || typeof IntersectionObserver !== 'undefined') return;
    if (followingRef.current && el.scrollTop >= lastWrittenTop.current) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    const nowAtBottom = distance < AT_BOTTOM_THRESHOLD_PX;
    if (nowAtBottom !== followingRef.current) setFollow(nowAtBottom);
  }, [setFollow]);

  function jumpToLatest(): void {
    setFollow(true);
    scrollToBottom();
  }

  return {
    scrollRef,
    threadRef,
    sentinelRef,
    following,
    setFollow,
    unseen,
    onScroll,
    jumpToLatest,
  };
}
