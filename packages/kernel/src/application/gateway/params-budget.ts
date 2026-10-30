/**
 * Legacy (#707 P2, GHSA-mrhx-c7xc-m3w5): Zod reports one issue per failing element of a collection
 * it has no size limit for — an array without `.max()` (zod 4.6.6+ stops at a failed `.max()`
 * before looking at elements) or a record with typed values. A 1 MiB call body of ~520,000 wrong
 * elements made ~520,000 issues: about 170 MB of heap and half a second per call. The budget below
 * counts a call's JSON values before Zod sees them and refuses the call past it, so no call can make
 * more issues than that.
 *
 * 128 Ki values sits under the 1 MiB body limit (`/api/cap/*`, `/mcp`, the WS frame limit), so a
 * dense body that fits that limit can still be refused: a 400 KB array of numbers or a 980 KB table
 * of small rows holds over 200,000 values. Such a call is new to refusal, so the refusal names the
 * budget in the error message the caller sees. It is a mitigation, not a cure: the worst call within
 * the budget still costs about 170 ms and 107 MB, against about 905 ms and 218 MB without it.
 */
export const MAX_PARAMS_VALUES = 128 * 1024;

/** `true` when `value` holds more than `limit` JSON values (every array element and object member,
 *  at any depth, plus the value itself). Stops counting as soon as it passes the limit. */
export function exceedsValueBudget(value: unknown, limit: number = MAX_PARAMS_VALUES): boolean {
  let count = 0;
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const next = pending.pop();
    count += 1;
    if (count > limit) return true;
    if (Array.isArray(next)) {
      for (const item of next) pending.push(item);
    } else if (next !== null && typeof next === 'object') {
      for (const member of Object.values(next)) pending.push(member);
    }
  }
  return false;
}
