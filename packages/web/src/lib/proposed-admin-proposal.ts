/**
 * lib/proposed-admin-proposal (S11 AA4e, UX P2-2 on #945): the admin proposal a successful
 * `propose_admin_proposal` tool call made, read from the call's own result — so the chat links to
 * it on 平台 · 管理员提案 whatever the model writes in its reply.
 *
 * The result reaches the console in three shapes:
 * - a live row: pi's `{content: [{type: 'text', text}], details}`, `details` being the capability's
 *   result (`AgentAdminProposalWire`, whose `id` is the proposal's);
 * - a persisted record: the text parts only, that same JSON pretty-printed — cut short past the
 *   preview limit, when only its leading `"id"` can still be read;
 * - the CI-only fake runtime's `{proposalId, title, status}`.
 *
 * Only an id shaped like one is taken; the page it links to reads the proposal itself, under the
 * reader's own authority.
 */

const PROPOSAL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The leading `"id"` of the capability's result printed as JSON, however short it was cut. */
const LEADING_ID = /^\s*\{\s*"id"\s*:\s*"([0-9a-fA-F-]{36})"/;

export interface ProposedAdminProposal {
  readonly id: string;
  /** The proposal's title when the result still carries it. */
  readonly title: string | null;
}

/** The proposal `toolName`'s `result` made, or `null` (another tool, or no readable id). */
export function proposedAdminProposalOf(
  toolName: string | null | undefined,
  result: unknown,
): ProposedAdminProposal | null {
  if (toolName !== 'propose_admin_proposal' || result == null) return null;
  if (typeof result === 'string') return ofText(result);
  if (typeof result !== 'object') return null;
  const object = result as { details?: unknown; content?: unknown };
  if (object.details !== null && typeof object.details === 'object') {
    const fromDetails = ofObject(object.details);
    if (fromDetails !== null) return fromDetails;
  }
  if (Array.isArray(object.content)) {
    const first = object.content[0] as { type?: unknown; text?: unknown } | undefined;
    if (first?.type === 'text' && typeof first.text === 'string') return ofText(first.text);
  }
  return ofObject(result);
}

function ofText(text: string): ProposedAdminProposal | null {
  try {
    return ofObject(JSON.parse(text));
  } catch {
    const id = LEADING_ID.exec(text)?.[1];
    return id !== undefined && PROPOSAL_ID.test(id) ? { id, title: null } : null;
  }
}

function ofObject(value: unknown): ProposedAdminProposal | null {
  if (value === null || typeof value !== 'object') return null;
  const object = value as { id?: unknown; proposalId?: unknown; title?: unknown };
  const id = typeof object.id === 'string' ? object.id : object.proposalId;
  if (typeof id !== 'string' || !PROPOSAL_ID.test(id)) return null;
  return { id, title: typeof object.title === 'string' ? object.title : null };
}
