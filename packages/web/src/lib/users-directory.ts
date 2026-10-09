import type { UserWire } from '@nexttime/shared';
import { useMemo, useRef, useState } from 'react';
import type { ListEnvelope } from '../hooks/useCapability.js';
import type { CapabilityCaller } from './clients.js';

/**
 * lib/users-directory: what a form that embeds `components/platform/UserPicker` needs on top of the
 * picked user's id — the picked row itself (`add_member` takes a *login*, `merge_user`'s confirm
 * step retypes the target's login) and, optionally, a ranking of the rows the picker shows (the
 * merge picker puts accounts with the pending account's display name first).
 *
 * `UserPicker` owns its `list_users` read (search box, residue filter, error banner), so instead of
 * a second read this hands it a decorated `CapabilityCaller`: every `list_users` answer that
 * passes through is re-ordered by `rank` (stable — the kernel's own order breaks ties) and
 * remembered, so `find(id)` resolves whatever the picker just offered. Every other capability
 * passes through untouched.
 */

/** Lower rank sorts first; equal ranks keep the order the kernel returned. */
export type UserRank = (user: UserWire) => number;

export function rankUsers(rows: readonly UserWire[], rank: UserRank): UserWire[] {
  return rows
    .map((row, index) => ({ row, index, score: rank(row) }))
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .map((entry) => entry.row);
}

/** Display names compared the way a person reads them: case, surrounding and repeated
 *  whitespace ignored. Empty names never match. */
export function sameDisplayName(a: string, b: string): boolean {
  const norm = (value: string) => value.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
  const left = norm(a);
  return left.length > 0 && left === norm(b);
}

export interface UserDirectoryTap {
  /** Pass this, not the raw caller, to `UserPicker`. Stable for a given `http`. */
  readonly caller: CapabilityCaller;
  /** The rows of the most recent `list_users` answer, already ranked. */
  readonly rows: readonly UserWire[];
  /** Any row seen by this tap so far (every query the picker ran), by id. */
  readonly find: (userId: string) => UserWire | undefined;
}

export function useUserDirectoryTap(http: CapabilityCaller, rank?: UserRank): UserDirectoryTap {
  const [rows, setRows] = useState<readonly UserWire[]>([]);
  const seen = useRef(new Map<string, UserWire>());
  // Read at call time so a new `rank` closure per render never rebuilds the caller (a new caller
  // would be a cold `useCapability` cache and a reload).
  const rankRef = useRef(rank);
  rankRef.current = rank;

  const caller = useMemo<CapabilityCaller>(
    () => ({
      async call<T>(name: string, params?: unknown): Promise<T> {
        const result = await http.call<T>(name, params);
        if (name !== 'list_users') return result;
        const envelope = result as unknown as ListEnvelope<UserWire>;
        const ranked = rankRef.current
          ? rankUsers(envelope.items, rankRef.current)
          : [...envelope.items];
        for (const row of ranked) seen.current.set(row.id, row);
        setRows(ranked);
        return { ...envelope, items: ranked } as unknown as T;
      },
    }),
    [http],
  );

  return { caller, rows, find: (userId) => seen.current.get(userId) };
}
