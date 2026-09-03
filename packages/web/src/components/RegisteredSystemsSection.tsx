import { type FormEvent, useState } from 'react';
import type { CapabilityCaller } from '../lib/clients.js';
import {
  type GatekeeperView,
  type OperationView,
  groupOperationsByStatus,
} from '../lib/connections.js';
import { formatDateTime, formatRelative } from '../lib/format.js';
import { Button } from './ui/Button.js';
import { Card } from './ui/Card.js';
import { CopyId } from './ui/CopyId.js';
import { ErrorBanner } from './ui/ErrorBanner.js';
import { Field, Input } from './ui/Field.js';
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
}

/**
 * components/RegisteredSystemsSection: one registered Gatekeeper (a `Gatekeeper` graph Object)
 * with its Operations grouped by lifecycle, plus the two owner actions of the S2.13 flow:
 * `publish_manifest` (every draft → published, I16/I17) and `connect_gatekeeper` (a
 * CapabilityGrant letting a principal's entry agent use this gate). The principal id is typed
 * in — the kernel has no list-principals capability (gap, see the PR report).
 */
export function GatekeeperCard({
  http,
  gatekeeper,
  operations,
  canPublish,
  canGrant,
  onChanged,
  onForbidden,
}: GatekeeperCardProps) {
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
      if (isForbidden(err)) onForbidden('publish_manifest');
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
      if (isForbidden(err)) onForbidden('connect_gatekeeper');
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
        </dl>

        {grantOpen ? (
          <form className="inline-form" onSubmit={(event) => void grant(event)}>
            <Field
              id={`grant-${gatekeeper.id}`}
              label="Principal id"
              hint="Paste the principal's id (printed by bootstrap add-principal). The kernel has no principal directory to pick from yet."
            >
              <Input
                id={`grant-${gatekeeper.id}`}
                value={principalId}
                onChange={(event) => setPrincipalId(event.target.value)}
                disabled={granting}
                mono
              />
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
                    {operation.mode ? <span className="tag">{operation.mode}</span> : null}
                    {operation.blastRadius && operation.blastRadius !== 'low' ? (
                      <span
                        className={
                          operation.blastRadius === 'high'
                            ? 'text-danger text-small'
                            : 'text-3 text-small'
                        }
                      >
                        {operation.blastRadius}
                      </span>
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

function isForbidden(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'forbidden'
  );
}
