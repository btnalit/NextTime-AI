import type { WireUser } from '../lib/auth-api.js';
import { Button } from './ui/Button.js';
import { Card } from './ui/Card.js';

export interface NoWorkspacePageProps {
  readonly user: WireUser;
  readonly onOpenAccount: () => void;
  readonly onLogout: () => void;
}

/**
 * components/NoWorkspacePage: a cookie-authenticated user with zero active workspace memberships
 * (design doc §7.11 "平台管理员在业务工作区没有任何数据权限" — the common case is a platform admin,
 * created via `/api/platform/setup`, who by design starts with no business-workspace access; a
 * regular user can also land here if every membership was removed). No shell, no capability
 * calls — there is no workspace to scope them to.
 */
export function NoWorkspacePage({ user, onOpenAccount, onLogout }: NoWorkspacePageProps) {
  return (
    <div className="login-screen">
      <Card className="login-card">
        <div className="stack">
          <div className="login-brand">
            <div className="sidebar-mark" aria-hidden>
              N
            </div>
            <div>
              <h1 className="login-title">你还不属于任何工作区</h1>
              <p className="login-subtitle">You are not a member of any workspace yet</p>
            </div>
          </div>

          <p>
            已登录为 Signed in as <strong>{user.displayName}</strong> (<code>{user.login}</code>).
          </p>
          <p>
            工作区所有者或平台管理员需要先把你加入某个工作区，你才能使用控制台。A workspace owner or
            platform administrator must add you to a workspace before you can use the console.
          </p>

          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <Button variant="ghost" onClick={onOpenAccount}>
              我的账户 My Account
            </Button>
            <Button variant="secondary" icon="logout" onClick={onLogout}>
              登出 Sign out
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}
