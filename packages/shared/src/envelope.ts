import { z } from 'zod';

/**
 * List-result envelope (docs/wire-contract-conventions.md §3, 2026-09-08 decision): every list-
 * shaped capability (`list_*`, `find_*`, `get_chat_history`, `query_*`) returns `{items,
 * nextCursor?}` — never a bare array, never a resource-named key like `{skills: [...]}`.
 *
 * `truncated: true` is added by the handler (not this schema — it is conditional on whether the
 * caller's own `limit` was clamped to the server-side ceiling, information this generic helper
 * does not have) when a page was cut short by that ceiling rather than by genuinely running out of
 * rows; omitted otherwise, never `false`.
 */
export function listEnvelope<ItemSchema extends z.ZodType>(itemSchema: ItemSchema) {
  return z.object({
    items: z.array(itemSchema),
    nextCursor: z.string().optional(),
    truncated: z.literal(true).optional(),
  });
}

export type ListEnvelope<T> = {
  readonly items: readonly T[];
  readonly nextCursor?: string;
  readonly truncated?: true;
};
