import { AccountPage } from './components/AccountPage.js';
import { ChangePasswordPage } from './components/ChangePasswordPage.js';
import { LoginPage } from './components/LoginPage.js';
import { NoWorkspacePage } from './components/NoWorkspacePage.js';
import { ToastProvider } from './components/ui/Toast.js';
import { PermissionsProvider } from './hooks/usePermissions.js';
import { hrefs, navigate } from './lib/router.js';
import { Routed, useHashRoute } from './routes.js';
import { useSessionMachine } from './session/useSessionMachine.js';

/**
 * App: the render switch over `useSessionMachine`'s state (C23 split, console-completion-plan
 * §5.8; design doc §7.6, §7.11). A published `Session` renders the shell through the route table
 * (`routes.tsx` — "add new pages here"); otherwise the pre-session state picks the login,
 * change-password, no-workspace or (its own `#/me/account`) account page. Everything about
 * *how* a session comes to exist — the two credential channels, the boot sequence, workspace
 * selection and switching, logout — lives in `session/useSessionMachine.ts`.
 */
export function App() {
  const { route, syncRoute } = useHashRoute();
  const machine = useSessionMachine({ syncRoute });
  const { session, preSession } = machine;

  if (session) {
    return (
      <PermissionsProvider key={session.generation}>
        <ToastProvider>
          <Routed
            session={session}
            route={route}
            onLogout={
              session.authMode === 'cookie' ? () => void machine.cookieLogout() : machine.forgetKey
            }
            onSwitchWorkspace={(workspaceId, destination) =>
              void machine.switchWorkspace(workspaceId, destination)
            }
            switchingWorkspace={machine.switchingWorkspace}
            onUserChanged={machine.userChanged}
            onKeyBound={machine.keyBound}
            onClaimed={machine.claimed}
          />
        </ToastProvider>
      </PermissionsProvider>
    );
  }

  switch (preSession.kind) {
    case 'boot':
      return null;
    case 'login':
      return (
        <LoginPage
          onApiKeyLogin={(key) => void machine.connectApiKey(key)}
          apiKeyPending={machine.apiKeyConnecting}
          apiKeyError={machine.apiKeyError}
          onLoggedIn={(result) =>
            void machine.proceedAfterCookieAuth(result.user, result.memberships)
          }
        />
      );
    case 'changePassword':
      return (
        <ChangePasswordPage
          user={preSession.user}
          onChanged={machine.passwordChanged}
          onLogout={() => void machine.cookieLogout()}
        />
      );
    case 'noWorkspace':
      if (route.kind === 'account') {
        return (
          <AccountPage
            user={preSession.user}
            memberships={preSession.memberships}
            onUserChanged={machine.userChanged}
            onBound={machine.keyBound}
          />
        );
      }
      return (
        <NoWorkspacePage
          user={preSession.user}
          onOpenAccount={() => navigate(hrefs.account())}
          onLogout={() => void machine.cookieLogout()}
        />
      );
  }
}
