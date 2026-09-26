import { getCapability } from '@nexttime/shared';
import { useState } from 'react';
import { useCapabilityList } from '../../hooks/useCapability.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { entryCeilingCapabilities } from '../../lib/entry-ceiling.js';
import type { GatekeeperListRow } from '../../lib/governance.js';
import { useT } from '../../lib/i18n.js';
import { Button } from '../kit/button.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../kit/dialog.js';
import { ErrorBanner } from '../kit/error-banner.js';
import { Field } from '../kit/field.js';
import { Notice } from '../kit/notice.js';

const SECONDS_PER_HOUR = 3600;
/** Kernel default (`issue-handle-handler.ts`'s `DEFAULT_TTL_SECONDS`) — a short-lived dev-tool
 *  session, unlike the 30-day default a service Handle gets. */
const DEFAULT_TTL_HOURS = 24;
/** Fallback if the registry shape ever changes — `ISSUE_HANDLE_MAX_TTL_SECONDS` in
 *  `packages/shared/src/capabilities.ts` (30 days), read from the Zod schema below so this page
 *  cannot drift from the kernel ceiling. */
const FALLBACK_MAX_TTL_SECONDS = 30 * 24 * SECONDS_PER_HOUR;

function issueHandleMaxTtlSeconds(): number {
  const schema = getCapability('issue_handle')?.paramsSchema as
    | {
        readonly shape?: {
          readonly ttlSeconds?: { readonly unwrap?: () => { readonly maxValue?: number | null } };
        };
      }
    | undefined;
  const max = schema?.shape?.ttlSeconds?.unwrap?.().maxValue;
  return typeof max === 'number' && max > 0 ? max : FALLBACK_MAX_TTL_SECONDS;
}

/** `issue_handle`'s result — an inline `capabilities.ts` schema with no `wire/*.ts` counterpart
 *  (same precedent `IssueServiceHandleSection.tsx`'s own `IssueServiceHandleResult` follows). */
interface IssueHandleResult {
  readonly handle: string;
  readonly sessionId: string;
  readonly onBehalfOf: string;
  readonly expiresAt: string;
  readonly scope: {
    readonly capabilities: readonly string[];
    readonly resources: Readonly<Record<string, readonly string[]>>;
  };
}

export interface IssueOwnHandleSectionProps {
  readonly http: CapabilityCaller;
}

function CopyButton({ text, label }: { readonly text: string; readonly label: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  return (
    <Button variant="secondary" size="s" onClick={() => void copy()} data-testid={`copy-${label}`}>
      {copied ? t('已复制', 'Copied') : t('复制', 'Copy')}
    </Button>
  );
}

/**
 * components/access/IssueOwnHandleSection (S8 W4 item 2, leftover from `docs/
 * howto-connect-claude-code.md` §前提 "还没有对应的控制台按钮，需要 owner 自己的 API key 直接调用一次
 * 能力接口"): a console surface for `issue_handle` — an owner mints their own interactive-mode
 * Handle (Claude Code / `pi`) without hand-writing the curl call the howto doc used to require.
 * `issue_handle` is `minRole:'owner'` and always issues on behalf of the *caller* (`onBehalfOf` is
 * never a parameter — I13), so there is no principal picker, unlike the service-Handle form beside
 * it on this page.
 *
 * Scope defaults to unrestricted on both axes (howto doc: "不传 scope 时，默认拿到入口 agent 上限 ∩
 * 你的 Grant 的全集") — the two "不限" toggles below mirror `AgentProfileForm`'s inherit/override
 * checklists so unchecking one and ticking specific names is the same gesture a reader already
 * knows from 我的智能体. Submitting with a toggle still checked *omits* that `scope` key entirely
 * (never an empty array — an empty array means "zero", not "unrestricted", see
 * `issue-handle-handler.ts`'s `intersectScope`).
 *
 * The Handle is shown exactly once, in a `kit/dialog`, with copy buttons for the token and for the
 * ready-to-paste `claude mcp add` snippet from the howto doc — never stored beyond the copy action.
 * No `list_handles`/`revoke_handle` capability exists (checked against `packages/shared/src/
 * capabilities.ts`), so this section offers no history/revoke list — the howto doc's own
 * "排障"/撤销 section says the same.
 */
export function IssueOwnHandleSection({ http }: IssueOwnHandleSectionProps) {
  const t = useT();
  const maxTtlHours = Math.floor(issueHandleMaxTtlSeconds() / SECONDS_PER_HOUR);
  const entryCeiling = entryCeilingCapabilities();
  const gatekeepers = useCapabilityList<GatekeeperListRow>(http, 'list_gatekeepers');
  const gatekeeperOptions =
    gatekeepers.state.status === 'ready' ? gatekeepers.state.data.items : [];

  const [ttlHours, setTtlHours] = useState(String(DEFAULT_TTL_HOURS));
  const [capabilitiesUnrestricted, setCapabilitiesUnrestricted] = useState(true);
  const [pickedCapabilities, setPickedCapabilities] = useState<ReadonlySet<string>>(new Set());
  const [gatekeepersUnrestricted, setGatekeepersUnrestricted] = useState(true);
  const [pickedGatekeepers, setPickedGatekeepers] = useState<ReadonlySet<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown | null>(null);
  const [issued, setIssued] = useState<IssueHandleResult | null>(null);

  const ttlValid =
    /^\d+$/.test(ttlHours.trim()) && Number(ttlHours) >= 1 && Number(ttlHours) <= maxTtlHours;
  const canSubmit = ttlValid && !submitting;

  function toggleCapability(name: string): void {
    setPickedCapabilities((current) => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  function toggleGatekeeper(id: string): void {
    setPickedGatekeepers((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function submit(): Promise<void> {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const scope: {
        capabilities?: readonly string[];
        resources?: Record<string, readonly string[]>;
      } = {};
      if (!capabilitiesUnrestricted) scope.capabilities = Array.from(pickedCapabilities);
      if (!gatekeepersUnrestricted) scope.resources = { gatekeeper: Array.from(pickedGatekeepers) };
      const params: Record<string, unknown> = {
        sessionKind: 'interactive',
        ttlSeconds: Number(ttlHours) * SECONDS_PER_HOUR,
        ...(Object.keys(scope).length > 0 ? { scope } : {}),
      };
      setIssued(await http.call<IssueHandleResult>('issue_handle', params));
    } catch (err) {
      setError(err);
    } finally {
      setSubmitting(false);
    }
  }

  function closeIssued(): void {
    setIssued(null);
    setCapabilitiesUnrestricted(true);
    setPickedCapabilities(new Set());
    setGatekeepersUnrestricted(true);
    setPickedGatekeepers(new Set());
  }

  const mcpUrl = `${window.location.origin}/mcp`;
  const connectionSnippet = issued
    ? `claude mcp add --transport http nexttime "${mcpUrl}" --header "Authorization: Bearer ${issued.handle}"`
    : '';

  return (
    <div className="stack" data-testid="issue-own-handle-section">
      <p className="text-3 text-small">
        {t(
          '为 Claude Code、pi 等外部工具签发一个可直接使用的 Handle——等价于「接入指南」里手写的那次 curl 调用。',
          'Issue a Handle for Claude Code, pi, or another external MCP client — the same result the connection guide’s hand-written curl call produces.',
        )}
      </p>

      <Field
        id="ioh-ttl"
        label={t('有效期（小时）', 'TTL (hours)')}
        hint={t(
          `默认 ${DEFAULT_TTL_HOURS}，最多 ${maxTtlHours}；到期后需要重新签发（没有续期接口）。`,
          `Default ${DEFAULT_TTL_HOURS}, max ${maxTtlHours} — no renewal, issue a new one after it expires.`,
        )}
        error={
          ttlValid
            ? null
            : t(`必须是 1 到 ${maxTtlHours} 的整数`, `Must be an integer from 1 to ${maxTtlHours}`)
        }
      >
        <input
          id="ioh-ttl"
          className="input mono"
          value={ttlHours}
          onChange={(event) => setTtlHours(event.target.value)}
          disabled={submitting}
          inputMode="numeric"
        />
      </Field>

      <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
        <legend className="field-label">{t('能力范围', 'Capability scope')}</legend>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={capabilitiesUnrestricted}
            onChange={(event) => setCapabilitiesUnrestricted(event.target.checked)}
            disabled={submitting}
          />
          <span>
            {t(
              '不限（入口 agent 上限的观察类能力全集）',
              'Unrestricted (every observe-class capability the entry ceiling allows)',
            )}
          </span>
        </label>
        {!capabilitiesUnrestricted ? (
          <div className="stack-s" data-testid="ioh-capability-list" style={{ paddingTop: 8 }}>
            {entryCeiling.map((capability) => (
              <label className="checkbox" key={capability.name} title={capability.description}>
                <input
                  type="checkbox"
                  checked={pickedCapabilities.has(capability.name)}
                  onChange={() => toggleCapability(capability.name)}
                  disabled={submitting}
                />
                <span className="mono">{capability.name}</span>
              </label>
            ))}
          </div>
        ) : null}
      </fieldset>

      <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
        <legend className="field-label">{t('可用的门', 'Gatekeepers')}</legend>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={gatekeepersUnrestricted}
            onChange={(event) => setGatekeepersUnrestricted(event.target.checked)}
            disabled={submitting}
          />
          <span>{t('不限（你已被授权的全部门）', 'Unrestricted (every gate granted to you)')}</span>
        </label>
        {!gatekeepersUnrestricted ? (
          <div className="stack-s" data-testid="ioh-gatekeeper-list" style={{ paddingTop: 8 }}>
            {gatekeeperOptions.length === 0 ? (
              <p className="text-3 text-small">{t('没有可选的门。', 'No gates available.')}</p>
            ) : (
              gatekeeperOptions.map((row) => (
                <label className="checkbox" key={row.id}>
                  <input
                    type="checkbox"
                    checked={pickedGatekeepers.has(row.id)}
                    onChange={() => toggleGatekeeper(row.id)}
                    disabled={submitting}
                  />
                  <span>{row.name}</span>
                </label>
              ))
            )}
          </div>
        ) : null}
      </fieldset>

      {error !== null ? (
        <ErrorBanner error={error} title={t('无法签发', 'Could not issue the Handle')} />
      ) : null}

      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <Button
          variant="primary"
          onClick={() => void submit()}
          disabled={!canSubmit}
          data-testid="ioh-submit"
        >
          {t('签发', 'Issue')}
        </Button>
      </div>

      <Dialog open={issued !== null} onOpenChange={(open) => !open && closeIssued()}>
        {issued ? (
          <DialogContent data-testid="issue-own-handle-dialog">
            <DialogHeader>
              <DialogTitle>{t('你的 Handle', 'Your Handle')}</DialogTitle>
              <DialogDescription>
                {t(
                  '只显示这一次，控制台不会保存它；复制后交给要用它的运行时。',
                  'Shown once — the console never stores it. Copy it now and hand it to the runtime that will use it.',
                )}
              </DialogDescription>
            </DialogHeader>
            <Notice tone="warn">
              {t(
                `到期时间：${new Date(issued.expiresAt).toLocaleString()}`,
                `Expires: ${new Date(issued.expiresAt).toLocaleString()}`,
              )}
            </Notice>
            <div className="stack-s">
              <span className="field-label">{t('Handle', 'Handle')}</span>
              <div className="code-block row" style={{ justifyContent: 'space-between' }}>
                <span className="mono" data-testid="issue-own-handle-token">
                  {issued.handle}
                </span>
                <CopyButton text={issued.handle} label="handle" />
              </div>
            </div>
            <div className="stack-s">
              <span className="field-label">
                {t('Claude Code 接入命令', 'Claude Code connection command')}
              </span>
              <div className="code-block row" style={{ justifyContent: 'space-between' }}>
                <span className="mono" data-testid="issue-own-handle-snippet">
                  {connectionSnippet}
                </span>
                <CopyButton text={connectionSnippet} label="snippet" />
              </div>
            </div>
            <DialogFooter>
              <Button variant="primary" onClick={closeIssued} data-testid="issue-own-handle-done">
                {t('我已保存', 'I have saved it')}
              </Button>
            </DialogFooter>
          </DialogContent>
        ) : null}
      </Dialog>
    </div>
  );
}
