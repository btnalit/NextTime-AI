/**
 * lib/router: hash routes (no router library, S1.8's own convention — a hard reload lands back on
 * the same view with no server-side routing). Detail drawers are addressable
 * (`#/approvals/<id>`, `#/tasks/<id>`) so a chat notice can deep-link straight into one.
 */
export type NavSection = 'chats' | 'approvals' | 'tasks' | 'connections';

export type Route =
  | { readonly kind: 'chats' }
  | { readonly kind: 'chat'; readonly chatId: string }
  | { readonly kind: 'approvals'; readonly actionRequestId?: string }
  | { readonly kind: 'tasks'; readonly taskId?: string }
  | { readonly kind: 'connections' };

export function routeFromHash(hash: string): Route {
  const chat = /^#\/chats\/(.+)$/.exec(hash);
  if (chat?.[1]) return { kind: 'chat', chatId: decodeURIComponent(chat[1]) };
  const approval = /^#\/approvals(?:\/(.+))?$/.exec(hash);
  if (approval) {
    return approval[1]
      ? { kind: 'approvals', actionRequestId: decodeURIComponent(approval[1]) }
      : { kind: 'approvals' };
  }
  const task = /^#\/tasks(?:\/(.+))?$/.exec(hash);
  if (task) {
    return task[1] ? { kind: 'tasks', taskId: decodeURIComponent(task[1]) } : { kind: 'tasks' };
  }
  if (hash === '#/connections') return { kind: 'connections' };
  return { kind: 'chats' };
}

export function sectionOf(route: Route): NavSection {
  return route.kind === 'chat' ? 'chats' : route.kind;
}

export const hrefs = {
  chats: () => '#/chats',
  chat: (chatId: string) => `#/chats/${encodeURIComponent(chatId)}`,
  approvals: () => '#/approvals',
  approval: (actionRequestId: string) => `#/approvals/${encodeURIComponent(actionRequestId)}`,
  tasks: () => '#/tasks',
  task: (taskId: string) => `#/tasks/${encodeURIComponent(taskId)}`,
  connections: () => '#/connections',
} as const;

export function navigate(href: string): void {
  window.location.hash = href;
}
