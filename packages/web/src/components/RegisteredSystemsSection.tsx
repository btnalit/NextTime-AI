import type { AvailableGateInstanceWire } from '@nexttime/shared';
import { type FormEvent, useState } from 'react';
import type { CapabilityCaller } from '../lib/clients.js';
import {
  type GatekeeperView,
  type OperationView,
  groupOperationsByStatus,
} from '../lib/connections.js';
import { isForbiddenError } from '../lib/errors.js';
import { formatDateTime, formatRelative } from '../lib/format.js';
import { platformGateInstanceHref } from '../lib/gate-instances.js';
import type { PrincipalRow } from '../lib/governance.js';
import { useT } from '../lib/i18n.js';
import { roleLabel } from '../lib/labels.js';
import { hrefs } from '../lib/router.js';
import { Button } from './ui/Button.js';
import { Card } from './ui/Card.js';
import { CopyId } from './ui/CopyId.js';
import { ErrorBanner } from './ui/ErrorBanner.js';
import { Field, Input, Select } from './ui/Field.js';
import { Notice } from './ui/Notice.js';
import { StatusChip } from './ui/StatusChip.js';
import { useToast } from './ui/Toast.js';

export interface GatekeeperCardProps {
  readonly http: CapabilityCaller;
  readonly gatekeeper: GatekeeperView;
  readonly operations: readonly OperationView[];
  /** Owner-only actions hidden when the session has been told 403 for them. */
  readonly canPublish: boolean;
  readonly canGrant: boolean;
  readonly onChanged: () => void;
  readonly onForbidden: (capabilityName: string) => void;
  /** Opens the S3.11 health/operations detail drawer (`get_gatekeeper`) for this gate. Optional —
   *  omitted, the "Health & operations" action does not render (a page rendering the card without
   *  a drawer to open it into, e.g. a future embedded use). */
  readonly onOpenDetail?: (gatekeeperId: string) => void;
  /** S6-C (§5.6 "实例与连接之间的互相链接"): the platform gate instance this Gatekeeper was enabled
   *  from (`list_available_gate_instances` row whose `gatekeeperId` is this gate), when it was —
   *  a self-connected gate (`create_connection`) has none. */
  readonly platformInstance?: AvailableGateInstanceWire | null;
  /** The reader may open the platform 集成 page — the instance row links there only then. */
  readonly platformAdmin?: boolean;
  /** S8 W1-A6 (audit S10 "授权表单要粘贴 principal UUID"): populates the "Grant to principal"
   *  picker; falls back to a free-text id field when empty (the same degrade
   *  `GrantCapabilityForm`'s own principal field uses when `list_principals` has not loaded yet,
   *  or 403s for this session's role). */
  readonly principals?: readonly PrincipalRow[];
}

/**
 * components/RegisteredSystemsSection: one registered Gatekeeper (a `Gatekeeper` graph Object)
 * with its Operations grouped by lifecycle, plus the two owner actions of the S2.13 flow:
 * `publish_manifest` (every draft → published, I16/I17) and `connect_gatekeeper` (a
 * CapabilityGrant letting a principal's entry agent use this gate). S8 W1-A6: the principal
 * picker is `list_principals` (`ConnectionsPage` loads it once, passed down as `principals`) —
 * this module's doc comment used to say the kernel had no such capability; S8 W1-C added one.
 */
export function GatekeeperCard({
  http,
  gatekeeper,
  operations,
  canPublish,
  canGrant,
  onChanged,
  onForbidden,
  onOpenDetail,
  platformInstance = null,
  platformAdmin = false,
  principals,
}: GatekeeperCardProps) {
  const t = useT();
  const toast = useToast();
  const [publishing, setPublishing] = useState(false);
  const [granting, setGranting] = useState(false);
  const [grantOpen, setGrantOpen] = useState(false);
  const [principalId, setPrincipalId] = useState('');
  const [error, setError] = useState<unknown | null>(null);
  const groups = groupOperationsByStatus(operations);
  const draftCount = operations.filter((operation) => operation.status === 'draft').length;

  async function publish(): Promise<void> {
    setPublishing(true);
    setError(null);
    try {
      const result = await http.call<{ publishedOperationNames?: readonly string[] }>(
        'publish_manifest',
        { gatekeeperId: gatekeeper.id },
      );
      const count = result.publishedOperationNames?.length ?? 0;
      toast.push({
        tone: 'ok',
        title:
          count > 0
            ? `Published ${count} operation${count === 1 ? '' : 's'}`
            : 'No drafts to publish',
        description: gatekeeper.name,
      });
      onChanged();
    } catch (err) {
      if (isForbiddenError(err)) onForbidden('publish_manifest');
      setError(err);
    } finally {
      setPublishing(false);
    }
  }

  async function grant(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const trimmed = principalId.trim();
    if (!trimmed) return;
    setGranting(true);
    setError(null);
    try {
      await http.call('connect_gatekeeper', { gatekeeperId: gatekeeper.id, principalId: trimmed });
      toast.push({
        tone: 'ok',
        title: 'Gatekeeper granted',
        description: `${gatekeeper.name} → principal ${trimmed.slice(0, 8)}`,
      });
      setPrincipalId('');
      setGrantOpen(false);
    } catch (err) {
      if (isForbiddenError(err)) onForbidden('connect_gatekeeper');
      setError(err);
    } finally {
      setGranting(false);
    }
  }

  return (
    <Card
      className="gatekeeper-card"
      title={
        <span className="row-wrap">
          <span>{gatekeeper.name}</span>
          <span className="tag">{gatekeeper.transportKind}</span>
        </span>
      }
      actions={
        <>
          {onOpenDetail ? (
            <Button
              variant="ghost"
              size="s"
              icon="search"
              onClick={() => onOpenDetail(gatekeeper.id)}
            >
              Health & operations
            </Button>
          ) : null}
          {canPublish ? (
            <Button
              variant={draftCount > 0 ? 'primary' : 'secondary'}
              size="s"
              onClick={() => void publish()}
              loading={publishing}
              disabled={draftCount === 0}
              title={draftCount === 0 ? 'No draft operations to publish' : undefined}
            >
              Publish manifest{draftCount > 0 ? ` (${draftCount})` : ''}
            </Button>
          ) : null}
          {canGrant ? (
            <Button
              variant="secondary"
              size="s"
              icon="user"
              onClick={() => setGrantOpen((open) => !open)}
              aria-expanded={grantOpen}
            >
              Grant to principal
            </Button>
          ) : null}
        </>
      }
      data-testid="gatekeeper-card"
      data-gatekeeper-id={gatekeeper.id}
    >
      <div className="stack">
        <dl className="definition-list">
          <dt>Gatekeeper</dt>
          <dd>
            <CopyId id={gatekeeper.id} label="gatekeeper" />
          </dd>
          <dt>Target</dt>
          <dd className="mono">{gatekeeper.target || '—'}</dd>
          <dt>Endpoint</dt>
          <dd className="mono">{gatekeeper.endpoint ?? '—'}</dd>
          <dt>Updated</dt>
          <dd>
            <time title={formatDateTime(gatekeeper.updatedAt)}>
              {formatRelative(gatekeeper.updatedAt)}
            </time>
          </dd>
          {platformInstance ? (
            <>
              <dt>{t('平台实例', 'Platform instance')}</dt>
              <dd className="row-wrap" data-testid="gatekeeper-platform-instance">
                {platformAdmin ? (
                  // Deep link to the instance's own drawer on 集成 (`lib/router.ts` parses
                  // `#/platform/integrations/<gateId>` since S6-C integration).
                  <a
                    className="mono"
                    href={platformGateInstanceHref(platformInstance.gateId)}
                    data-testid="gatekeeper-platform-instance-link"
                  >
                    {platformInstance.gateId}
                  </a>
                ) : (
                  <span className="mono">{platformInstance.gateId}</span>
                )}
                <span className="tag">{platformInstance.connector}</span>
                <StatusChip machine="gateInstance" status={platformInstance.status} size="s" />
                <StatusChip machine="gateHealth" status={platformInstance.health} size="s" />
                {!platformAdmin ? (
                  <span className="text-3 text-small">
                    {t('由平台管理员管理 managed on the platform 集成', 'page')}
                  </span>
                ) : null}
              </dd>
            </>
          ) : null}
        </dl>

        {grantOpen ? (
          <form className="inline-form" onSubmit={(event) => void grant(event)}>
            <Field
              id={`grant-${gatekeeper.id}`}
              label="Principal"
              hint={
                principals && principals.length > 0
                  ? undefined
                  : "No principal directory loaded — paste the principal's id."
              }
            >
              {principals && principals.length > 0 ? (
                <Select
                  id={`grant-${gatekeeper.id}`}
                  value={principalId}
                  onChange={(event) => setPrincipalId(event.target.value)}
                  disabled={granting}
                >
                  <option value="" disabled>
                    选择成员… Choose a member…
                  </option>
                  {principals.map((row) => (
                    <option key={row.id} value={row.id}>
                      {row.displayName} ({roleLabel(row.role, t)})
                    </option>
                  ))}
                </Select>
              ) : (
                <Input
                  id={`grant-${gatekeeper.id}`}
                  value={principalId}
                  onChange={(event) => setPrincipalId(event.target.value)}
                  disabled={granting}
                  mono
                  placeholder="principal id"
                />
              )}
            </Field>
            <Button
              type="submit"
              variant="primary"
              loading={granting}
              disabled={!principalId.trim()}
            >
              Grant
            </Button>
          </form>
        ) : null}

        {error !== null ? <ErrorBanner error={error} /> : null}

        {operations.length === 0 ? (
          <Notice>No operations imported for this gate yet.</Notice>
        ) : (
          groups.map((group) => (
            <div className="stack-s" key={group.status}>
              <div className="op-group-title">
                <StatusChip machine="publishable" status={group.status} size="s" />
                <span>{group.operations.length}</span>
              </div>
              <div className="gatekeeper-ops">
                {group.operations.map((operation) => (
                  <div className="op-item" key={operation.objectId} title={operation.name}>
                    <span className="op-name">{operation.name}</span>
                    {/* S8 W1-A11 (audit L3): mode/blastRadius through the shared StatusChip
                     *  machines — not bare tag/coloured text — same as the target catalog page. */}
                    {operation.mode ? (
                      <StatusChip machine="operationMode" status={operation.mode} size="s" />
                    ) : null}
                    {operation.blastRadius && operation.blastRadius !== 'low' ? (
                      <StatusChip machine="blastRadius" status={operation.blastRadius} size="s" />
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
          ))
        )}
      </div>
    </Card>
  );
}
