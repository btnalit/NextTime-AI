import { useCallback, useEffect, useRef, useState } from 'react';
import {
  type MeResult,
  type SessionResult,
  type WireMembership,
  type WireUser,
  logout as apiLogout,
  getMe,
  setWorkspaceCookie,
} from '../lib/auth-api.js';
import { HttpClient } from '../lib/http-client.js';
import { hrefs, navigate } from '../lib/router.js';
import {
  clearApiKey,
  loadApiKey,
  loadSelectedWorkspaceId,
  saveApiKey,
  saveSelectedWorkspaceId,
} from '../lib/session.js';
import { WsClient } from '../lib/ws-client.js';
import { wsUrl } from '../lib/ws-url.js';
import { isDefaultLanding } from '../routes.js';
import type { PreSessionState, Session } from './types.js';

/** What `App` renders from and wires into the login / pre-session / routed pages. */
export interface SessionMachine {
  readonly session: Session | null;
  readonly preSession: PreSessionState;
  readonly apiKeyConnecting: boolean;
  readonly apiKeyError: unknown | null;
  readonly switchingWorkspace: boolean;
  /** `LoginPage`'s API-key channel. */
  readonly connectApiKey: (apiKey: string) => Promise<void>;
  /** `LoginPage`'s password channel and every other cookie entry (`/api/auth/*` result). */
  readonly proceedAfterCookieAuth: (
    user: WireUser,
    memberships: readonly WireMembership[],
  ) => Promise<void>;
  /** "Forget key" (API-key session) — closes the socket, clears the stored key. */
  readonly forgetKey: () => void;
  /** "Sign out" (cookie session or pre-session) — closes the socket, revokes server-side. */
  readonly cookieLogout: () => Promise<void>;
  readonly switchWorkspace: (workspaceId: string, destination?: string) => Promise<void>;
  readonly userChanged: (user: WireUser) => void;
  readonly keyBound: (result: MeResult) => void;
  readonly claimed: (result: SessionResult) => void;
  readonly passwordChanged: (user: WireUser) => void;
}

export interface SessionMachineOptions {
  /** Re-reads the hash into the route state *synchronously* — called right after a `navigate`
   *  whose landing must be visible to the very next `setSession` (see `proceedAfterCookieAuth`).
   *  `App` passes `useHashRoute`'s own `syncRoute`. */
  readonly syncRoute: () => void;
}

/**
 * session/useSessionMachine: the session + connection state machine `App.tsx` used to inline
 * (C23 split, console-completion-plan §5.8; design doc §7.6, §7.11; S1.8, S2.10, S4.1). Owns the
 * single `WsClient` (§7.6 "一个 WebSocket") and the single `HttpClient` — every page receives
 * them through `Session`, never constructs its own.
 *
 * Two independent credential channels reach the same shell: the pre-existing API key
 * (`lib/session.ts` sessionStorage, re-used on reload to reconnect) and, S4.1, the console session
 * cookie (HttpOnly — this module never reads it, only `GET /api/auth/me`'s response). Boot sequence
 * (P-A1 revised — no setup token/page any more; the kernel pre-creates `admin`, design doc §4):
 *   1. `GET /api/auth/me`. 200 → cookie session (`proceedAfterCookieAuth` below decides
 *      changePassword / noWorkspace / platform-only / open-a-workspace from there). 401 (or any
 *      other failure — fails open rather than showing nothing forever) → `login`. Either way,
 *      also try the stored API key auto-connect — the two channels are independent.
 *   2. Workspace selection (`proceedAfterCookieAuth`): auto-select when there is exactly one
 *      active membership; else the last-selected workspace from this tab's sessionStorage if it is
 *      still a membership; else (deviation from a literal "none" — there is no separate workspace-
 *      chooser screen in this task's scope) the first membership, with the Sidebar's switcher
 *      (`>1` membership) covering the rest. Zero memberships: `platformRole === 'admin'` opens a
 *      platform-only session (`openPlatformOnlySession`) landing on `#/platform/overview`;
 *      `platformRole === 'user'` sees `NoWorkspacePage`.
 */
export function useSessionMachine({ syncRoute }: SessionMachineOptions): SessionMachine {
  const [session, setSession] = useState<Session | null>(null);
  const [preSession, setPreSession] = useState<PreSessionState>({ kind: 'boot' });
  const [apiKeyConnecting, setApiKeyConnecting] = useState(false);
  const [apiKeyError, setApiKeyError] = useState<unknown | null>(null);
  const [switchingWorkspace, setSwitchingWorkspace] = useState(false);
  const generation = useRef(0);
  // Fence for every in-flight connect/authenticate continuation (review finding, S4.1): each
  // attempt takes the next number, and only a continuation whose number is still current may
  // publish a session. A logout, a "Forget key", or a newer attempt bumps the counter, so the
  // loser of a race closes its own socket instead of leaking it or resurrecting a signed-out
  // shell. `preSessionRef` mirrors `preSession` for callbacks that fire after an await.
  const attempt = useRef(0);
  const preSessionRef = useRef<PreSessionState>({ kind: 'boot' });
  preSessionRef.current = preSession;

  const connectApiKey = useCallback(async (apiKey: string): Promise<void> => {
    setApiKeyConnecting(true);
    setApiKeyError(null);
    const myAttempt = ++attempt.current;
    const ws = new WsClient({ url: wsUrl() });
    try {
      await ws.connect();
      await ws.authenticate({ token: apiKey });
      if (attempt.current !== myAttempt) {
        ws.close();
        return;
      }
      saveApiKey(apiKey);
      generation.current += 1;
      setSession({
        ws,
        http: new HttpClient({ auth: { kind: 'apiKey', apiKey } }),
        generation: generation.current,
        authMode: 'apiKey',
        apiKey,
      });
    } catch (err) {
      ws.close();
      if (attempt.current !== myAttempt) return;
      clearApiKey();
      setApiKeyError(err);
    } finally {
      setApiKeyConnecting(false);
    }
  }, []);

  /** Opens a workspace-scoped WS + HTTP session for an already-authenticated cookie user. Sets
   *  the `nexttime_workspace` selector cookie (Explorer, `lib/auth-api.ts`) *before* `setSession`
   *  so any capability call a just-rendered page fires (or a same-tab Explorer navigation) always
   *  sees it. `replacing` is the previous session's socket on a workspace switch: it stays open
   *  (pages still hold it) until the new one is authenticated, then is closed — on success or
   *  failure — by whichever continuation is still current. */
  const openCookieSession = useCallback(
    async (
      user: WireUser,
      memberships: readonly WireMembership[],
      workspaceId: string,
      replacing?: WsClient,
    ): Promise<void> => {
      const myAttempt = ++attempt.current;
      const ws = new WsClient({ url: wsUrl() });
      try {
        await ws.connect();
        await ws.authenticate({ workspaceId });
        if (attempt.current !== myAttempt) {
          ws.close();
          return;
        }
        replacing?.close();
        setWorkspaceCookie(workspaceId);
        saveSelectedWorkspaceId(workspaceId);
        generation.current += 1;
        setSession({
          ws,
          http: new HttpClient({ auth: { kind: 'cookie', workspaceId } }),
          generation: generation.current,
          authMode: 'cookie',
          user,
          memberships,
          selectedWorkspaceId: workspaceId,
        });
      } catch (err) {
        ws.close();
        if (attempt.current !== myAttempt) return;
        replacing?.close();
        // The named membership disappeared, or some other race lost the cookie session between
        // GET /api/auth/me and this WS authenticate — fall back to an always-renderable state
        // rather than a blank screen.
        console.warn('openCookieSession: authenticate failed', err);
        setSession(null);
        setPreSession(
          memberships.length === 0 ? { kind: 'noWorkspace', user, memberships } : { kind: 'login' },
        );
      }
    },
    [],
  );

  /** Opens a session for a cookie-authenticated platform admin with zero workspace memberships —
   *  the normal state before anyone else exists / has been added anywhere (design doc §4 "平台管
   *  理员在业务工作区没有任何数据权限"). There is no workspace to open a WS session against — the
   *  kernel's `authenticate {workspaceId}` always requires one and throws `WorkspaceRequiredError`
   *  otherwise (`resolve-caller.ts`) — so unlike `openCookieSession` this never calls `connect()`/
   *  `authenticate()` at all: the `WsClient` stays `closed` (the Sidebar honestly shows
   *  "Disconnected"), and every page this session can reach (`platform_overview`,
   *  `platform_audit_query`, ...) calls over `http` only, never `session.ws.call()`. `http` uses
   *  `workspaceId: null` — `scope:'platform'` capabilities ignore the workspace header entirely
   *  (`resolvePlatformCaller`), so this degrades cleanly. `replacing` mirrors `openCookieSession`'s
   *  own — the previous socket, closed once this session publishes. */
  const openPlatformOnlySession = useCallback(
    (user: WireUser, memberships: readonly WireMembership[], replacing?: WsClient): void => {
      attempt.current += 1;
      replacing?.close();
      setWorkspaceCookie(null);
      generation.current += 1;
      setSession({
        ws: new WsClient({ url: wsUrl() }),
        http: new HttpClient({ auth: { kind: 'cookie', workspaceId: null } }),
        generation: generation.current,
        authMode: 'cookie',
        user,
        memberships,
        selectedWorkspaceId: undefined,
      });
    },
    [],
  );

  const proceedAfterCookieAuth = useCallback(
    async (
      user: WireUser,
      memberships: readonly WireMembership[],
      replacing?: WsClient,
    ): Promise<void> => {
      // Landing on a pre-session state while a session is still published (C1: the claim form
      // runs inside a live API-key session, and the claimed user may have no membership yet, or
      // a temporary password) must tear that session down, or `App`'s render switch — which
      // prefers `session` — would keep showing the old shell over the new state.
      const landPreSession = (state: PreSessionState): void => {
        if (replacing) {
          attempt.current += 1;
          replacing.close();
          setSession(null);
        }
        setPreSession(state);
      };
      if (user.mustChangePassword) {
        landPreSession({ kind: 'changePassword', user, memberships });
        return;
      }
      // Administrators land on the platform plane, everyone else on chats (design doc §6.7:
      // "概览是管理员的落地页；普通用户落在对话页"). Only when the hash carries no deliberate
      // destination — a reload on `#/work/chats`, a bookmarked `#/govern/audit`, and the
      // `#/platform/overview` this very function is re-entered with after a bind (below) are all
      // left exactly where they are. `syncRoute` is called alongside `navigate` because the
      // `hashchange` event is asynchronous and `openPlatformOnlySession` right below is not: a
      // session published against the *old* route would otherwise be redirected by `Routed`'s own
      // stale-`#/login` effect before the hash change ever arrives.
      if (user.platformRole === 'admin' && isDefaultLanding(window.location.hash)) {
        navigate(hrefs.platformOverview());
        syncRoute();
      }
      if (memberships.length === 0) {
        if (user.platformRole === 'admin') {
          openPlatformOnlySession(user, memberships, replacing);
          return;
        }
        landPreSession({ kind: 'noWorkspace', user, memberships });
        return;
      }
      const stored = loadSelectedWorkspaceId();
      const firstMembership = memberships[0];
      if (!firstMembership) {
        landPreSession({ kind: 'noWorkspace', user, memberships });
        return;
      }
      const chosen =
        memberships.length === 1
          ? firstMembership.workspaceId
          : stored && memberships.some((m) => m.workspaceId === stored)
            ? stored
            : firstMembership.workspaceId;
      await openCookieSession(user, memberships, chosen, replacing);
    },
    [openCookieSession, openPlatformOnlySession, syncRoute],
  );

  const bootUnauthenticated = useCallback(async (): Promise<void> => {
    setPreSession({ kind: 'login' });
    const stored = loadApiKey();
    if (stored) void connectApiKey(stored);
  }, [connectApiKey]);

  // `bootAttempted` guards React 18 StrictMode's dev-only double effect invocation from firing
  // GET /api/auth/me (and, transitively, opening a second WS) twice — same pattern S1.8's own
  // API-key auto-connect always used.
  const bootAttempted = useRef(false);
  useEffect(() => {
    if (bootAttempted.current) return;
    bootAttempted.current = true;
    void (async () => {
      try {
        const me = await getMe();
        await proceedAfterCookieAuth(me.user, me.memberships);
      } catch {
        await bootUnauthenticated();
      }
    })();
  }, [proceedAfterCookieAuth, bootUnauthenticated]);

  const forgetKey = useCallback((): void => {
    attempt.current += 1;
    session?.ws.close();
    setSession(null);
    clearApiKey();
    setApiKeyError(null);
    window.location.hash = '';
  }, [session]);

  const cookieLogout = useCallback(async (): Promise<void> => {
    attempt.current += 1;
    session?.ws.close();
    setSession(null);
    setWorkspaceCookie(null);
    setPreSession({ kind: 'login' });
    try {
      await apiLogout();
    } catch {
      // Best-effort — server-side revoke (§7.11) is not required for the client to consider
      // itself signed out; the cookie is cleared client-side above either way.
    }
  }, [session]);

  /** `destination` is where to land *after* the new workspace is authenticated — the Sidebar's own
   *  switcher takes the default (`#/work/chats`), P-A2's "打开工作区配置" passes `#/govern/members`.
   *  It has to be navigated here rather than by the caller: the caller's `navigate` would run
   *  while the old session is still published and this function would then overwrite it. */
  const switchWorkspace = useCallback(
    async (workspaceId: string, destination: string = hrefs.chats()): Promise<void> => {
      if (!session || session.authMode !== 'cookie' || !session.user || !session.memberships)
        return;
      if (workspaceId === session.selectedWorkspaceId || switchingWorkspace) return;
      setSwitchingWorkspace(true);
      try {
        // The old socket is handed over, not closed here: pages keep a working `ws` until the
        // new workspace is authenticated (or the switch fails), and a switch that loses to a
        // later attempt never publishes.
        await openCookieSession(session.user, session.memberships, workspaceId, session.ws);
        navigate(destination);
      } finally {
        setSwitchingWorkspace(false);
      }
    },
    [session, switchingWorkspace, openCookieSession],
  );

  const userChanged = useCallback((user: WireUser): void => {
    setSession((s) => (s && s.authMode === 'cookie' ? { ...s, user } : s));
    setPreSession((p) =>
      p.kind === 'noWorkspace' || p.kind === 'changePassword' ? { ...p, user } : p,
    );
  }, []);

  /** `BindApiKeyForm` (platform overview, or 我的账户 in cookie mode — C1) just folded an existing
   *  API key's membership into this account (`POST /api/auth/bind-api-key` answers with the
   *  caller's refreshed `{user, memberships}`). Route it through the same `proceedAfterCookieAuth`
   *  the change-password path uses, handing over the current socket: a platform-only admin (no
   *  memberships, no WS at all) is thereby upgraded to a real workspace session and can open the
   *  workspace it just bound without reloading the page. */
  const keyBound = useCallback(
    (result: MeResult): void => {
      void proceedAfterCookieAuth(result.user, result.memberships, session?.ws);
    },
    [proceedAfterCookieAuth, session],
  );

  /** `ClaimPasswordCard` (`AccountPage`, API-key mode) just set a login + password on this key's
   *  own identity and the kernel installed the console session cookie (`POST /api/auth/claim`,
   *  C1). Swap the API-key session for that cookie session through the same
   *  `proceedAfterCookieAuth` every other cookie entry uses, handing over the current socket. The
   *  stored key is cleared first: the holder now signs in by password, and leaving it in
   *  `sessionStorage` would let a later cookie logout + reload silently re-sign them in over the
   *  key channel (`bootUnauthenticated`'s auto-connect). */
  const claimed = useCallback(
    (result: SessionResult): void => {
      clearApiKey();
      void proceedAfterCookieAuth(result.user, result.memberships, session?.ws);
    },
    [proceedAfterCookieAuth, session],
  );

  const passwordChanged = useCallback(
    (user: WireUser): void => {
      // Read the *current* state, not the render this callback was created in: a "Sign out"
      // clicked while the change-password request was in flight has already moved us to `login`,
      // and the late success must not reopen a session on a cookie that is being revoked.
      const current = preSessionRef.current;
      if (current.kind !== 'changePassword') return;
      void proceedAfterCookieAuth(user, current.memberships);
    },
    [proceedAfterCookieAuth],
  );

  return {
    session,
    preSession,
    apiKeyConnecting,
    apiKeyError,
    switchingWorkspace,
    connectApiKey,
    proceedAfterCookieAuth,
    forgetKey,
    cookieLogout,
    switchWorkspace,
    userChanged,
    keyBound,
    claimed,
    passwordChanged,
  };
}
