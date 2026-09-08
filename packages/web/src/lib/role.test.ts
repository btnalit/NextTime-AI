import { describe, expect, it } from 'vitest';
import { inferRole } from './role.js';

const NONE = { allowed: new Set<string>(), denied: new Set<string>() };

// Fixture capability names, chosen to already exist in `@nexttime/shared`'s `CAPABILITY_REGISTRY`
// with the `minRole` this test relies on — the S3.11 governance capabilities this PR's pages call
// (`list_principals`, `list_quotas`, ...) are landing in a parallel kernel PR and are not
// registered on this branch yet, so `inferRole` would see them as "no minRole" (not evidence of
// anything) until that PR merges. `grant_capability`/`list_pending` are the same two fixtures
// `hooks/usePermissions.test.tsx` already uses for "owner-minRole"/"operator-minRole".
const OWNER_ONLY = 'grant_capability';
const OPERATOR_ONLY = 'list_pending';

describe('inferRole', () => {
  it('is "unknown" with no evidence either way', () => {
    expect(inferRole(NONE)).toBe('unknown');
  });

  it('is "owner" once any owner-minRole capability has succeeded', () => {
    expect(inferRole({ allowed: new Set([OWNER_ONLY]), denied: new Set() })).toBe('owner');
  });

  it('is "member" once any operator-minRole capability has been denied — the strongest negative evidence', () => {
    expect(inferRole({ allowed: new Set(), denied: new Set([OPERATOR_ONLY]) })).toBe('member');
    // Even with unrelated positive evidence for a member-open capability, a proven operator-level
    // denial still wins — it is the more specific/confident signal.
    expect(inferRole({ allowed: new Set(['list_chats']), denied: new Set([OPERATOR_ONLY]) })).toBe(
      'member',
    );
  });

  it('is "operator+" once an operator-minRole capability succeeds with no owner-only denial yet', () => {
    expect(inferRole({ allowed: new Set([OPERATOR_ONLY]), denied: new Set() })).toBe('operator+');
  });

  it('a capability with no minRole (or not registered at all, e.g. S3.11 ones not merged yet) is not evidence either way', () => {
    expect(inferRole({ allowed: new Set(['list_chats']), denied: new Set() })).toBe('unknown');
    expect(inferRole({ allowed: new Set(['list_principals']), denied: new Set() })).toBe('unknown');
  });
});
