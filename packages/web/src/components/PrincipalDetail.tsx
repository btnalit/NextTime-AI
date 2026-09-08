import { ROLE_VALUES, type Role } from '@nexttime/shared';
import { useState } from 'react';
import type { CapabilityCaller } from '../lib/clients.js';
import { isForbiddenError } from '../lib/errors.js';
import { formatDateTime, formatRelative } from '../lib/format.js';
import type { PrincipalRow, RotateApiKeyResult } from '../lib/governance.js';
import { Button } from './ui/Button.js';
import { CopyId } from './ui/CopyId.js';
import { ErrorBanner } from './ui/ErrorBanner.js';
import { Field, Select } from './ui/Field.js';
import { Notice } from './ui/Notice.js';
import { StatusChip } from './ui/StatusChip.js';

export interface PrincipalDetailProps {
  readonly http: CapabilityCaller;
  readonly principal: PrincipalRow;
  readonly canManage: boolean;
  readonly onChanged: (principal: PrincipalRow) => void;
  readonly onForbidden: (capabilityName: string) => void;
}

/**
 * components/PrincipalDetail: one Member's drawer body — `set_principal_role`,
 * `rotate_api_key`, `disable_principal` (S3.11). `disable_principal` gets a same-drawer confirm
 * step (no confirm-dialog primitive exists in `components/ui` yet — adding one for a single call
 * site would be the kind of infrastructure-for-its-own-sake this console's constitution warns
 * against; a two-click local toggle is enough) since it revokes every Handle/session the member
 * holds (S3.11 background: "撤销其全部 Handle 与入口会话").
 */
export function PrincipalDetail({
  http,
  principal,
  canManage,
  onChanged,
  onForbidden,
}: PrincipalDetailProps) {
  const [role, setRole] = useState<Role>(principal.role);
  const [savingRole, setSavingRole] = useState(false);
  const [roleError, setRoleError] = useState<unknown | null>(null);

  const [rotating, setRotating] = useState(false);
  const [rotateError, setRotateError] = useState<unknown | null>(null);
  const [rotated, setRotated] = useState<RotateApiKeyResult | null>(null);

  const [confirmingDisable, setConfirmingDisable] = useState(false);
  const [disabling, setDisabling] = useState(false);
  const [disableError, setDisableError] = useState<unknown | null>(null);

  async function saveRole(): Promise<void> {
    if (role === principal.role) return;
    setSavingRole(true);
    setRoleError(null);
    try {
      const updated = await http.call<PrincipalRow>('set_principal_role', {
        principalId: principal.id,
        role,
      });
      onChanged(updated);
    } catch (err) {
      if (isForbiddenError(err)) onForbidden('set_principal_role');
      setRoleError(err);
      setRole(principal.role);
    } finally {
      setSavingRole(false);
    }
  }

  async function rotateKey(): Promise<void> {
    setRotating(true);
    setRotateError(null);
    try {
      const result = await http.call<RotateApiKeyResult>('rotate_api_key', {
        principalId: principal.id,
      });
      setRotated(result);
      onChanged({ ...principal, hasApiKey: true });
    } catch (err) {
      if (isForbiddenError(err)) onForbidden('rotate_api_key');
      setRotateError(err);
    } finally {
      setRotating(false);
    }
  }

  async function disable(): Promise<void> {
    setDisabling(true);
    setDisableError(null);
    try {
      const updated = await http.call<PrincipalRow>('disable_principal', {
        principalId: principal.id,
      });
      onChanged(updated);
    } catch (err) {
      if (isForbiddenError(err)) onForbidden('disable_principal');
      setDisableError(err);
    } finally {
      setDisabling(false);
      setConfirmingDisable(false);
    }
  }

  const disabled = Boolean(principal.disabledAt);

  return (
    <div className="stack" data-testid="principal-detail">
      <dl className="definition-list">
        <dt>Id</dt>
        <dd>
          <CopyId id={principal.id} label="principal" />
        </dd>
        <dt>Kind</dt>
        <dd>
          <span className="tag">{principal.kind}</span>
        </dd>
        <dt>Status</dt>
        <dd>
          <span
            className={`chip chip-s ${disabled ? 'chip-neutral' : 'chip-ok'}`}
            data-testid="principal-status"
          >
            {disabled ? 'Disabled' : 'Active'}
          </span>
        </dd>
        <dt>API key</dt>
        <dd>{principal.hasApiKey ? 'issued' : 'none'}</dd>
        <dt>Created</dt>
        <dd>
          <time title={formatDateTime(principal.createdAt)}>
            {formatRelative(principal.createdAt)}
          </time>
        </dd>
        {principal.disabledAt ? (
          <>
            <dt>Disabled</dt>
            <dd>
              <time title={formatDateTime(principal.disabledAt)}>
                {formatRelative(principal.disabledAt)}
              </time>
            </dd>
          </>
        ) : null}
        {principal.workerDefinitionId ? (
          <>
            <dt>Worker definition</dt>
            <dd className="mono">{principal.workerDefinitionId}</dd>
          </>
        ) : null}
      </dl>

      {canManage ? (
        <>
          <div className="divider" />

          <Field id="principal-role" label="Role">
            <div className="row">
              <Select
                id="principal-role"
                value={role}
                onChange={(event) => setRole(event.target.value as Role)}
                disabled={savingRole || disabled}
              >
                {ROLE_VALUES.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </Select>
              <Button
                variant="secondary"
                onClick={() => void saveRole()}
                loading={savingRole}
                disabled={role === principal.role || disabled}
              >
                Save
              </Button>
            </div>
          </Field>
          {roleError !== null ? (
            <ErrorBanner error={roleError} title="Could not change the role" />
          ) : null}

          <div className="row-wrap">
            <StatusChip machine="role" status={principal.role} size="s" />
            {rotated ? null : (
              <Button
                variant="secondary"
                size="s"
                icon="key"
                onClick={() => void rotateKey()}
                loading={rotating}
                disabled={disabled}
              >
                Rotate API key
              </Button>
            )}
          </div>
          {rotateError !== null ? (
            <ErrorBanner error={rotateError} title="Could not rotate the key" />
          ) : null}
          {rotated ? (
            <div className="stack-s" data-testid="rotated-api-key">
              <Notice tone="warn">
                New API key shown once — the previous key stops working immediately.
              </Notice>
              <div className="code-block row" style={{ justifyContent: 'space-between' }}>
                <span className="mono">{rotated.apiKey}</span>
                <CopyId id={rotated.apiKey} label="API key" full />
              </div>
              <div className="row" style={{ justifyContent: 'flex-end' }}>
                <Button variant="secondary" size="s" onClick={() => setRotated(null)}>
                  我已复制 I've copied it
                </Button>
              </div>
            </div>
          ) : null}

          <div className="divider" />

          {disabled ? null : confirmingDisable ? (
            <div className="stack-s">
              <Notice tone="warn">
                Disabling revokes every Handle and entry session this member holds. This cannot be
                undone from here.
              </Notice>
              {disableError !== null ? (
                <ErrorBanner error={disableError} title="Could not disable this member" />
              ) : null}
              <div className="row" style={{ justifyContent: 'flex-end' }}>
                <Button variant="ghost" onClick={() => setConfirmingDisable(false)}>
                  Cancel
                </Button>
                <Button variant="danger" onClick={() => void disable()} loading={disabling}>
                  Confirm disable
                </Button>
              </div>
            </div>
          ) : (
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <Button variant="danger" onClick={() => setConfirmingDisable(true)}>
                Disable member
              </Button>
            </div>
          )}
        </>
      ) : null}
    </div>
  );
}
