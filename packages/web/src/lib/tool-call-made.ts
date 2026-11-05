/**
 * lib/tool-call-made (S11 AA4e, UX P2-2 on #945; AA5b): what a successful tool call made, read from
 * the call's own result — so the chat links to it whatever the model writes in its reply:
 * - `propose_admin_proposal` → an admin proposal, reviewed on 平台 · 管理员提案;
 * - `invoke_worker` → a Task, whose page shows its progress and the approvals it waits on;
 * - `request_connection` → a connection request, which a person completes on 系统与授权.
 *
 * The result reaches the console in three shapes:
 * - a live row: pi's `{content: [{type: 'text', text}], details}`, `details` being the capability's
 *   result (`AgentAdminProposalWire`, `InvokeWorkerResultWire`, `ConnectionRequestCreatedWire` —
 *   each with the resource's own `id` as its first key);
 * - a persisted record: the text parts only, that same JSON pretty-printed — cut short past the
 *   preview limit, when only its leading `"id"` can still be read;
 * - the CI-only fake runtime's `{proposalId, title, status}` (admin proposals only).
 *
 * Only an id shaped like one is taken; the page it links to reads the resource itself, under the
 * reader's own authority.
 */

const RESOURCE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The leading `"id"` of the capability's result printed as JSON, however short it was cut. */
const LEADING_ID = /^\s*\{\s*"id"\s*:\s*"([0-9a-fA-F-]{36})"/;

export type MadeResource =
  | {
      readonly kind: 'admin_proposal';
      readonly id: string;
      /** The proposal's title when the result still carries it. */
      readonly title: string | null;
    }
  | { readonly kind: 'task'; readonly id: string }
  | {
      readonly kind: 'connection_request';
      readonly id: string;
      /** The connection kind (`http`, `mcp`, …) when the result still carries it. */
      readonly connectionKind: string | null;
    };

export type MadeResourceKind = MadeResource['kind'];

/** The tools whose result is a resource the chat links to. */
const MADE_BY: ReadonlyMap<string, MadeResourceKind> = new Map([
  ['propose_admin_proposal', 'admin_proposal'],
  ['invoke_worker', 'task'],
  ['request_connection', 'connection_request'],
]);

/** What `toolName`'s `result` made, or `null` (another tool, or no readable id). */
export function madeResourceOf(
  toolName: string | null | undefined,
  result: unknown,
): MadeResource | null {
  const kind = toolName == null ? undefined : MADE_BY.get(toolName);
  if (kind === undefined || result == null) return null;
  if (typeof result === 'string') return ofText(kind, result);
  if (typeof result !== 'object') return null;
  const object = result as { details?: unknown; content?: unknown };
  if (object.details !== null && typeof object.details === 'object') {
    const fromDetails = ofObject(kind, object.details);
    if (fromDetails !== null) return fromDetails;
  }
  if (Array.isArray(object.content)) {
    const first = object.content[0] as { type?: unknown; text?: unknown } | undefined;
    if (first?.type === 'text' && typeof first.text === 'string') return ofText(kind, first.text);
  }
  return ofObject(kind, result);
}

function ofText(kind: MadeResourceKind, text: string): MadeResource | null {
  try {
    return ofObject(kind, JSON.parse(text));
  } catch {
    const id = LEADING_ID.exec(text)?.[1];
    return id !== undefined && RESOURCE_ID.test(id) ? withFields(kind, id, {}) : null;
  }
}

function ofObject(kind: MadeResourceKind, value: unknown): MadeResource | null {
  if (value === null || typeof value !== 'object') return null;
  const object = value as Readonly<Record<string, unknown>>;
  const id =
    typeof object.id === 'string'
      ? object.id
      : kind === 'admin_proposal'
        ? object.proposalId
        : undefined;
  if (typeof id !== 'string' || !RESOURCE_ID.test(id)) return null;
  return withFields(kind, id, object);
}

function withFields(
  kind: MadeResourceKind,
  id: string,
  object: Readonly<Record<string, unknown>>,
): MadeResource {
  switch (kind) {
    case 'admin_proposal':
      return { kind, id, title: typeof object.title === 'string' ? object.title : null };
    case 'task':
      return { kind, id };
    case 'connection_request':
      return { kind, id, connectionKind: typeof object.kind === 'string' ? object.kind : null };
  }
}
