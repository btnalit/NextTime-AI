import type { HandleClaims } from '../../governance/capability/index.js';
import type { PlatformRole } from '../identity/index.js';
import type { PrincipalRow, SessionRow } from './auth.js';

/**
 * application/gateway/caller: the resolved-caller types, in a leaf module so `authorize.ts`
 * (which needs the type) and `resolve-caller.ts` (which needs `authorize.ts`'s `ForbiddenError`
 * for the S4.1 console-session channel) do not form a cycle. See resolve-caller.ts for the
 * channels and how each is resolved.
 */

/** The platform user behind a console-session caller (S4.1) — absent on the API-key path. */
export interface ConsoleUser {
  readonly id: string;
  readonly login: string;
  readonly displayName: string;
  readonly platformRole: PlatformRole;
  readonly mustChangePassword: boolean;
  /** The `user_sessions` row the cookie names — what `POST /api/auth/logout` revokes. */
  readonly consoleSessionId: string;
}

export type ResolvedCaller =
  | {
      readonly channel: 'human';
      readonly principal: PrincipalRow;
      readonly session: SessionRow;
      readonly user?: ConsoleUser;
    }
  | { readonly channel: 'handle'; readonly claims: HandleClaims }
  /** P-A1: a console-session administrator calling a `scope: 'platform'` capability — no
   *  workspace, no Principal; `user.platformRole` is already verified to be `admin`
   *  (resolve-caller.ts `resolvePlatformCaller`). */
  | { readonly channel: 'platform'; readonly user: ConsoleUser };
