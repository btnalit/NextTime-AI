/**
 * substrate/graph/display-name: a graph Object's console-facing display name, computed server-side
 * (S8 W1-C — `traverse`'s new `nodeDetails` and `resolve_refs`'s `object`/`gatekeeper` kind both
 * need one, without a round trip back through the console).
 *
 * **Deliberately the same heuristic as the console's own `objectDisplayName`**
 * (`packages/web/src/lib/graph-view.ts`): a name-like property first, else the Object's identity-
 * key values (skipping uuid-shaped values — another Object's id, never a name a reader would
 * recognise), stored-key order (that function's own "else in stored order" fallback tier — the
 * `identityKeys`-from-`list_types` refinement is deliberately not reproduced here: an extra
 * `list_types` read for every `traverse`/`resolve_refs` call is not worth it purely to match
 * declared identityKey ordering, since stored-key order already gives a usable name in practice).
 * Two independent implementations of one small, pure heuristic (kernel and web are separate
 * packages/build graphs, so this is not literally shared code) — kept deliberately in lockstep
 * with the web copy; a change to one should be mirrored in the other.
 */

const UUID_LIKE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuidLike(value: unknown): boolean {
  return typeof value === 'string' && UUID_LIKE.test(value);
}

const NAME_PROPERTIES = ['name', 'displayName', 'title', 'label', 'hostname'] as const;

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/** `undefined` when nothing usable exists — the caller then omits `name` (RefChip/graph console
 *  render the bare-id fallback for that, same as today). */
export function objectDisplayName(object: {
  readonly identityKey: Record<string, unknown> | null;
  readonly properties: Record<string, unknown>;
}): string | undefined {
  for (const key of NAME_PROPERTIES) {
    const value = nonEmptyString(object.properties[key]);
    if (value !== undefined && !isUuidLike(value)) return value;
  }
  const identity = object.identityKey;
  if (!identity) return undefined;
  const parts: string[] = [];
  for (const key of Object.keys(identity)) {
    const value = identity[key];
    if (value === undefined || value === null || isUuidLike(value)) continue;
    const text = typeof value === 'string' ? value : String(value);
    if (text.trim() !== '') parts.push(text);
  }
  return parts.length > 0 ? parts.join(' / ') : undefined;
}
