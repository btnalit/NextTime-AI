import type { HandleWire, RevokeHandleResultWire, SessionKind } from '@nexttime/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useCapabilityList } from '../../hooks/useCapability.js';
import { useRoleCan } from '../../hooks/useRoleCan.js';
import { actionLabel } from '../../lib/capability-labels.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { describeError } from '../../lib/errors.js';
import { formatDateTime, formatRelative } from '../../lib/format.js';
import { type Translate, useT } from '../../lib/i18n.js';
import { Button } from '../kit/button.js';
import { Confirm } from '../kit/confirm.js';
import { ErrorBanner } from '../kit/error-banner.js';
import { SkeletonRows } from '../kit/skeleton.js';

/** Whose Handles a list shows: the caller's own (every kind but a service account's), or — for a
 *  workspace owner — the workspace's service accounts'. `list_handles` returns both to an owner. */
export type HandlesScope = 'self' | 'service';

/** One session as listed: its Handles share how they are held, whom they act for and end
 *  together (`revoke_handle` ends the session). */
interface SessionGroup {
  readonly sessionId: string;
  readonly sessionKind: SessionKind;
  readonly holder: HandleWire['holder'];
  readonly onBehalfOfKind: HandleWire['onBehalfOfKind'];
  readonly onBehalfOfName: string | null;
  readonly handles: readonly HandleWire[];
}

/** The listed Handles by session, in the kernel's order (newest first, by a session's newest). */
function groupBySession(items: readonly HandleWire[]): readonly SessionGroup[] {
  const groups = new Map<string, HandleWire[]>();
  for (const item of items) {
    const group = groups.get(item.sessionId);
    if (group) group.push(item);
    else groups.set(item.sessionId, [item]);
  }
  return [...groups.values()].map((handles) => {
    const first = handles[0] as HandleWire;
    return {
      sessionId: first.sessionId,
      sessionKind: first.sessionKind,
      holder: first.holder,
      onBehalfOfKind: first.onBehalfOfKind,
      onBehalfOfName: first.onBehalfOfName,
      handles,
    };
  });
}

export function sessionKindLabel(kind: SessionKind, t: Translate): string {
  switch (kind) {
    case 'entry':
      return t('入口智能体（对话）', 'Entry agent (chat)');
    case 'worker_run':
      return t('Worker 运行', 'Worker run');
    case 'admin_agent':
      return t('管理员智能体', 'Admin agent');
    case 'mcp_session':
      return t('平台外客户端（MCP）', 'Client outside the platform (MCP)');
    case 'service':
      return t('服务账号会话', 'Service account session');
    case 'web':
      return t('控制台登录', 'Console sign-in');
  }
}

function When({ at }: { readonly at: string }) {
  const t = useT();
  return (
    <time dateTime={at} title={formatDateTime(at)}>
      {formatRelative(at, t)}
    </time>
  );
}

/** The earliest issue and the latest expiry among a session's Handles. */
function sessionSpan(handles: readonly HandleWire[]): { issuedAt: string; expiresAt: string } {
  let issuedAt = (handles[0] as HandleWire).issuedAt;
  let expiresAt = (handles[0] as HandleWire).expiresAt;
  for (const handle of handles) {
    if (Date.parse(handle.issuedAt) < Date.parse(issuedAt)) issuedAt = handle.issuedAt;
    if (Date.parse(handle.expiresAt) > Date.parse(expiresAt)) expiresAt = handle.expiresAt;
  }
  return { issuedAt, expiresAt };
}

/**
 * components/handles/HandlesList (legacy 168, console half): the live Capability Handles acting for
 * the reader (「我的账户」) or, for a workspace owner, for the workspace's service accounts
 * (「成员与授权」) — `list_handles`, never a token. Grouped by session, as they end: each says what
 * it is (its session kind), how it is held — the platform holds an agent's or a Worker's, which
 * ends with its conversation or Task; a client holds an MCP or service session's — when it was
 * issued and expires, and what it may call. A session a client holds can be ended here
 * (`revoke_handle`, which ends every Handle under it, so the confirm says how many); one the
 * platform holds says how it ends instead.
 */
export function HandlesList({
  http,
  scope,
  revision = 0,
}: {
  readonly http: CapabilityCaller;
  readonly scope: HandlesScope;
  /** Bumped when this page issued a Handle: the list reads again. */
  readonly revision?: number;
}) {
  const t = useT();
  const handles = useCapabilityList<HandleWire>(http, 'list_handles', LIST_PARAMS);
  const reload = handles.reload;
  const seen = useRef(revision);
  useEffect(() => {
    if (seen.current === revision) return;
    seen.current = revision;
    void reload();
  }, [revision, reload]);
  const [ended, setEnded] = useState<{ count: number; kind: SessionKind } | null>(null);
  const state = handles.state;
  const groups = useMemo(() => {
    if (state.status !== 'ready') return [];
    const mine = state.data.items.filter((item) =>
      scope === 'service' ? item.onBehalfOfKind === 'service' : item.onBehalfOfKind !== 'service',
    );
    return groupBySession(mine);
  }, [state, scope]);

  if (state.status === 'loading') {
    return (
      <SkeletonRows
        count={2}
        label={t('正在读取会话凭证', 'Loading Handles')}
        testId={`handles-${scope}-loading`}
      />
    );
  }
  if (state.status === 'error') {
    return (
      <ErrorBanner
        error={state.error}
        title={t('无法读取会话凭证', 'Could not read the Handles')}
        onRetry={() => void handles.reload()}
        testId={`handles-${scope}-error`}
      />
    );
  }
  const more = state.data.nextCursor !== undefined;

  return (
    <div className="stack-s" data-testid={`handles-${scope}`}>
      <p className="text-3 text-small" style={{ margin: 0 }}>
        {scope === 'service'
          ? t(
              '服务账号现在有效的会话凭证，按会话列出，最新的在前；不显示凭证本身。客户端持有的会话可以在这里撤销。',
              'The live Handles of the workspace’s service accounts, by session, newest first — never the token itself. A session a client holds can be revoked here.',
            )
          : t(
              '现在代表你的会话凭证，按会话列出，最新的在前；不显示凭证本身。平台为智能体和 Worker 持有的随对话或任务结束；平台外客户端（如 Claude Code）持有的可以在这里撤销。',
              'The Handles acting for you now, by session, newest first — never the token itself. Those the platform holds for your agents and Workers end with their chat or Task; one a client outside the platform holds (such as Claude Code) can be revoked here.',
            )}
      </p>
      {ended !== null ? (
        <output className="text-small" data-testid={`handles-${scope}-revoked`}>
          {t(
            `已撤销：这个${sessionKindLabel(ended.kind, t)}下的 ${ended.count} 个凭证已失效，用它们的客户端会被拒绝，要再用需要重新签发。`,
            `Revoked: the ${ended.count} Handle(s) of that ${sessionKindLabel(ended.kind, t).toLowerCase()} no longer work; a client using them is refused and needs a new one.`,
          )}
        </output>
      ) : null}
      {groups.length === 0 ? (
        <p
          className="text-3 text-small"
          style={{ margin: 0 }}
          data-testid={`handles-${scope}-empty`}
        >
          {scope === 'service'
            ? t('服务账号现在没有有效的会话凭证。', 'No service account has a live Handle now.')
            : t('现在没有代表你的会话凭证。', 'No Handle is acting for you now.')}
        </p>
      ) : (
        <ul className="stack-s" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {groups.map((group) => (
            <SessionRow
              key={group.sessionId}
              http={http}
              group={group}
              onRevoked={(result) => {
                setEnded({ count: result.revokedHandleCount, kind: result.sessionKind });
                void handles.reload();
              }}
              onGone={() => void handles.reload()}
            />
          ))}
        </ul>
      )}
      {more ? (
        <div className="row" style={{ justifyContent: 'center' }}>
          <Button
            variant="secondary"
            size="s"
            aria-busy={handles.loadingMore || undefined}
            disabled={handles.loadingMore}
            onClick={() => void handles.loadMore()}
            data-testid={`handles-${scope}-more`}
          >
            {t('加载更多', 'Load more')}
          </Button>
        </div>
      ) : null}
      {handles.loadMoreError !== null ? (
        <ErrorBanner
          error={handles.loadMoreError}
          title={t('无法加载更多会话凭证', 'Could not load more Handles')}
          testId={`handles-${scope}-more-error`}
        />
      ) : null}
    </div>
  );
}

const LIST_PARAMS: Readonly<Record<string, unknown>> = {};

function SessionRow({
  http,
  group,
  onRevoked,
  onGone,
}: {
  readonly http: CapabilityCaller;
  readonly group: SessionGroup;
  readonly onRevoked: (result: RevokeHandleResultWire) => void;
  /** The kernel no longer has it (revoked or expired meanwhile): the list reads again. */
  readonly onGone: () => void;
}) {
  const t = useT();
  const can = useRoleCan(http);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const { issuedAt, expiresAt } = sessionSpan(group.handles);
  const revocable = group.handles.find((handle) => handle.revocable);
  const capabilities = [...new Set(group.handles.flatMap((handle) => handle.capabilities))].sort();
  const kind = sessionKindLabel(group.sessionKind, t);
  const count = group.handles.length;
  const rowId = group.sessionId;

  return (
    <li className="data-row" data-testid={`handle-session-${rowId}`}>
      <div className="data-row-main stack-s">
        <div className="data-row-title">
          <strong>
            {kind}
            {group.onBehalfOfKind === 'service'
              ? ` · ${group.onBehalfOfName ?? t('服务账号', 'service account')}`
              : null}
          </strong>
          <span
            className={`chip chip-s ${group.holder === 'container' ? 'chip-neutral' : 'chip-info'}`}
            data-testid={`handle-session-holder-${rowId}`}
          >
            {group.holder === 'container'
              ? t('平台持有', 'Held by the platform')
              : t('客户端持有', 'Held by a client')}
          </span>
        </div>
        <span className="text-3 text-small">
          {t('签发于 ', 'Issued ')}
          <When at={issuedAt} />
          {t('，到期 ', '; expires ')}
          <When at={expiresAt} />
          {count > 1 ? t(` · ${count} 个凭证`, ` · ${count} Handles`) : null}
        </span>
        <details className="disclosure">
          <summary>
            {t(
              `能调用 ${capabilities.length} 项能力`,
              `May call ${capabilities.length} capabilities`,
            )}
          </summary>
          <p className="disclosure-body text-small" style={{ margin: 0 }}>
            {capabilities.map((name) => actionLabel(name, t)).join(t('、', ', '))}
          </p>
        </details>
        {revocable === undefined || can('revoke_handle') === false ? (
          <span className="text-3 text-small" data-testid={`handle-session-ends-${rowId}`}>
            {group.holder === 'container'
              ? t(
                  '随它的对话或任务结束，不能在这里撤销；要提前结束，停止那个对话或任务。',
                  'It ends with its chat or Task and cannot be revoked here; to end it sooner, stop that chat or Task.',
                )
              : revocable === undefined
                ? t('你不能撤销这个会话。', 'You cannot revoke this session.')
                : t(
                    '你的角色只能查看，不能撤销；要撤销，请工作区里其他角色的成员来做。',
                    'Your role can only look, not revoke; ask a member with another role in the workspace.',
                  )}
          </span>
        ) : (
          <div className="row">
            <Confirm
              tier="medium"
              open={confirmOpen}
              onOpenChange={setConfirmOpen}
              anchor={
                <Button
                  size="s"
                  variant="secondary"
                  onClick={() => setConfirmOpen(true)}
                  data-testid={`handle-session-revoke-${rowId}`}
                >
                  {t('撤销', 'Revoke')}
                </Button>
              }
              title={t(`撤销这个${kind}`, `Revoke this ${kind.toLowerCase()}`)}
              impact={[
                count > 1
                  ? t(
                      `会话下的 ${count} 个凭证立即失效`,
                      `Its ${count} Handles stop working at once`,
                    )
                  : t('这个凭证立即失效', 'Its Handle stops working at once'),
                t(
                  '用它的客户端（如 Claude Code）会被拒绝，要再用需要重新签发',
                  'A client using it (such as Claude Code) is refused and needs a new one',
                ),
              ]}
              confirmLabel={t('撤销', 'Revoke')}
              danger
              errorOverrides={{
                handle_container_held: t(
                  '这个凭证由平台为智能体或 Worker 持有，随它的对话或任务结束，不能在这里撤销。',
                  'The platform holds this Handle for an agent or a Worker; it ends with its chat or Task and cannot be revoked here.',
                ),
              }}
              onConfirm={async () => {
                try {
                  const result = await http.call<RevokeHandleResultWire>('revoke_handle', {
                    jti: revocable.jti,
                  });
                  onRevoked(result);
                } catch (err) {
                  // Revoked or expired meanwhile (or no longer visible): it is gone either way.
                  if (isNotFound(err)) {
                    setConfirmOpen(false);
                    onGone();
                    return;
                  }
                  throw err;
                }
              }}
              testId={`handle-session-revoke-confirm-${rowId}`}
            />
          </div>
        )}
      </div>
    </li>
  );
}

function isNotFound(err: unknown): boolean {
  return describeError(err).code === 'handle_not_found';
}
