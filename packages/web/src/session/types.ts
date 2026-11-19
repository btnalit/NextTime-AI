import type { WireMembership, WireUser } from '../lib/auth-api.js';
import type { HttpClient } from '../lib/http-client.js';
import type { WsClient } from '../lib/ws-client.js';

/**
 * session/types: the two states `App` renders from (C23 split of App.tsx, console-completion-plan
 * §5.8) — a published `Session` (a workspace-scoped WS + HTTP pair every page receives as props,
 * design doc §7.6 "一个 WebSocket") and the `PreSessionState` shown before one exists. The
 * transitions between them live in `useSessionMachine.ts`; the pages a session renders live in
 * `../routes.tsx`.
 */
export interface Session {
  readonly ws: WsClient;
  readonly http: HttpClient;
  /** Increments per sign-in/workspace-switch so per-session state (permissions, toasts) remounts. */
  readonly generation: number;
  readonly authMode: 'apiKey' | 'cookie';
  /** API-key mode only (C1, console-completion-plan §2b): the key this session authenticated
   *  with, captured in `connectApiKey` so `AccountPage`'s claim form (`POST /api/auth/claim`
   *  proves identity with the key itself) can actually submit — without it `canSubmit` is
   *  permanently false and the login page's own promise ("用 key 登录后可在「我的账户」设置密码")
   *  is broken. Never read anywhere else; `lib/session.ts` remains the persisted copy. */
  readonly apiKey?: string;
  // Cookie mode only (S4.1) — undefined for an apiKey session, which has no platform user.
  readonly user?: WireUser;
  readonly memberships?: readonly WireMembership[];
  readonly selectedWorkspaceId?: string;
}

/**
 * The pre-session state machine (S4.1; design doc §7.11) — everything `App` shows *before* a
 * `Session` exists. `boot` is the brief window while `GET /api/auth/me` is in flight (rendered as
 * nothing — see `App`'s own render switch: a login form flashing into existence and then
 * vanishing again is worse than a blank frame, and `e2e/approvals.spec.ts`'s login helper
 * explicitly treats "no login input in the DOM yet" as "still booting", not "ready to sign in").
 * `changePassword`/`noWorkspace` both carry the already-known `user`/`memberships` so
 * `AccountPage`/`ChangePasswordPage` never have to re-fetch them. `noWorkspace` is reached only by
 * a `platformRole === 'user'` cookie user with zero memberships (design doc §4/§6.7) — a platform
 * admin with zero memberships instead gets a `Session` with `selectedWorkspaceId` undefined
 * (`openPlatformOnlySession` in `useSessionMachine.ts`), since an administrator always has the
 * platform plane even with no workspace data access (§2 "平台管理员在业务工作区没有任何数据权限").
 */
export type PreSessionState =
  /** Legacy 868 (UX on #1504): `reconnecting` once the first read of `/api/auth/me` failed and
   *  is being tried again — the page then says it is connecting instead of staying blank. */
  | { readonly kind: 'boot'; readonly reconnecting?: true }
  | {
      readonly kind: 'login';
      /** Legacy 658: why the console is back at sign-in when it did not start there — the
       *  kernel stopped taking the session it had (`useSessionMachine` `sessionInvalid`): a
       *  console session that expired or was revoked, or an API key that no longer authenticates.
       *  Absent at boot and after a sign-out, where sign-in needs no explaining. */
      readonly reason?: 'sessionExpired' | 'keyInvalid';
    }
  | {
      readonly kind: 'changePassword';
      readonly user: WireUser;
      readonly memberships: readonly WireMembership[];
    }
  | {
      readonly kind: 'noWorkspace';
      readonly user: WireUser;
      readonly memberships: readonly WireMembership[];
    }
  /** Legacy 868: boot could not read `GET /api/auth/me` — no answer, or not the kernel's (a network
   *  error, a proxy's page, a 5xx) — even after retrying. Whether this browser is signed in is not
   *  known, so it is neither sign-in nor a session: the page says so and offers to try again.
   *  `retrying` while another round of tries is in flight. */
  | { readonly kind: 'unreachable'; readonly error: unknown; readonly retrying: boolean };
