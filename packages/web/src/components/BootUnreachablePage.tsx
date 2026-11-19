import { describeError } from '../lib/errors.js';
import { useT } from '../lib/i18n.js';
import { Button } from './kit/button.js';
import { ErrorDetails } from './kit/error-details.js';

export interface BootUnreachablePageProps {
  readonly error: unknown;
  readonly retrying: boolean;
  readonly onRetry: () => void;
  readonly onSignIn: () => void;
}

/**
 * components/BootUnreachablePage (legacy 868): opening the console could not ask the platform who
 * is signed in — the network dropped or changed, or the platform is restarting — even after a few
 * tries. That says nothing about the session, so this is not the sign-in form: it says the
 * platform was not reached, keeps the reader's place (the address is untouched), and offers to try
 * again. 「去登录」 is there for a reader who wants to sign in anyway.
 */
export function BootUnreachablePage({
  error,
  retrying,
  onRetry,
  onSignIn,
}: BootUnreachablePageProps) {
  const t = useT();
  const described = describeError(error);
  return (
    <div className="login-screen">
      {/* The sign-in pages' card (`ui/Card`'s own markup — a new page imports no legacy `ui`). */}
      <section className="card login-card">
        <div className="card-body stack" role="alert" data-testid="boot-unreachable">
          <div className="login-brand">
            <div className="sidebar-mark" aria-hidden>
              N
            </div>
            <div>
              <h1 className="login-title">{t('连不上平台', 'Cannot reach the platform')}</h1>
              <p className="login-subtitle">
                {t(
                  '打开控制台时没能确认你的登录状态',
                  'Opening the console could not check whether you are signed in',
                )}
              </p>
            </div>
          </div>

          <p>
            {t(
              '网络刚断开或切换过，或者平台正在重启。已经重试了几次。这不代表你被登出了：恢复后点「重试」，会回到你刚才的页面。',
              'The network dropped or changed, or the platform is restarting. It was tried a few times already. This does not mean you were signed out: once it is back, choose Try again to return to the page you were on.',
            )}
          </p>
          <ErrorDetails
            code={described.code}
            raw={described.message === '' ? null : described.message}
            testId="boot-unreachable"
          />

          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <Button variant="ghost" onClick={onSignIn} disabled={retrying}>
              {t('去登录', 'Go to sign-in')}
            </Button>
            <Button
              variant="primary"
              onClick={onRetry}
              disabled={retrying}
              aria-busy={retrying || undefined}
              data-testid="boot-unreachable-retry"
            >
              {retrying ? t('正在重试…', 'Trying again…') : t('重试', 'Try again')}
            </Button>
          </div>
        </div>
      </section>
    </div>
  );
}

/**
 * Legacy 868 (UX on #1504): opening the console, the first read of who is signed in failed and is
 * being tried again (up to 3.5 s). Rather than a blank frame, one calm line says it is connecting —
 * shown only once a try failed, so an ordinary load still shows nothing before the console.
 */
export function BootConnecting() {
  const t = useT();
  return (
    <div className="login-screen">
      <output className="text-3" data-testid="boot-connecting">
        {t('正在连接平台…', 'Connecting to the platform…')}
      </output>
    </div>
  );
}
