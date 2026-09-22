import { type ReactNode, createContext, useCallback, useContext, useEffect, useRef } from 'react';
import type { ChatSummary } from '../lib/chat-lifecycle.js';

/**
 * hooks/useChatUpdates (遗留 57): `ChatArchiveConfirm`'s 撤销 Undo toast is pushed through
 * `components/ui/Toast.tsx`'s provider, which is mounted once at the app root — the toast, and
 * the `onUndo` closure it carries, outlives whatever page rendered `ChatArchiveConfirm` in the
 * first place. `routes.tsx` renders one page at a time, so navigating away before clicking Undo
 * (list → a chat, or back to the list, or to a different chat) unmounts that page; the closure's
 * `onChanged` then updates a component nobody is looking at, and the now-mounted page — which
 * fetched its own data before the undo ran — has no way to learn its row is stale. Same failure
 * shape for the archive confirm itself if the owning page unmounts mid-flight.
 *
 * This is a tiny broadcast any currently-mounted page can subscribe to, so the fix does not
 * depend on which page happened to own the `ChatArchiveConfirm` that triggered it: whoever
 * confirms or undoes an archive calls `notify(updatedChat)`
 * (`useNotifyChatChanged`), and `ChatListPage` / `ChatPage` (whichever is mounted right now, via
 * `useChatChangeListener`) apply it to their own local state exactly the way their existing
 * `onChanged` callback already does. Same Context + hook shape as `hooks/usePermissions.tsx` /
 * `components/ui/Toast.tsx` (a no-op outside the provider, for tests rendering a page alone),
 * mounted once at the app root (`App.tsx`) so it survives page navigation the same way the toast
 * region does.
 */
interface ChatUpdatesApi {
  readonly subscribe: (listener: (chat: ChatSummary) => void) => () => void;
  readonly notify: (chat: ChatSummary) => void;
}

const ChatUpdatesContext = createContext<ChatUpdatesApi | null>(null);

export function ChatUpdatesProvider({ children }: { readonly children: ReactNode }) {
  const listeners = useRef(new Set<(chat: ChatSummary) => void>());
  const api = useRef<ChatUpdatesApi>({
    subscribe: (listener) => {
      listeners.current.add(listener);
      return () => {
        listeners.current.delete(listener);
      };
    },
    notify: (chat) => {
      for (const listener of listeners.current) listener(chat);
    },
  }).current;
  return <ChatUpdatesContext.Provider value={api}>{children}</ChatUpdatesContext.Provider>;
}

/** The broadcast side: call after a Chat row changes server-side (archive / undo). No-op outside
 *  the provider. */
export function useNotifyChatChanged(): (chat: ChatSummary) => void {
  const ctx = useContext(ChatUpdatesContext);
  return ctx?.notify ?? NOOP_NOTIFY;
}

const NOOP_NOTIFY = (_chat: ChatSummary): void => undefined;

/** The listener side: `onChanged` runs for every broadcast for as long as the calling component
 *  stays mounted. Reads the latest `onChanged` through a ref so a fresh closure each render never
 *  tears down and re-subscribes — same convention `components/ui/ConfirmTier.tsx`'s `LowTier`
 *  already uses for its own callbacks. */
export function useChatChangeListener(onChanged: (chat: ChatSummary) => void): void {
  const ctx = useContext(ChatUpdatesContext);
  const latest = useRef(onChanged);
  latest.current = onChanged;
  useEffect(() => {
    if (!ctx) return undefined;
    return ctx.subscribe((chat) => latest.current(chat));
  }, [ctx]);
}
