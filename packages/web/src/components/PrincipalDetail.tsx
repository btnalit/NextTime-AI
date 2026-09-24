import { ROLE_VALUES, type Role } from '@nexttime/shared';
import { useState } from 'react';
import type { CapabilityCaller } from '../lib/clients.js';
import { isForbiddenError } from '../lib/errors.js';
import { formatDateTime, formatRelative } from '../lib/format.js';
import type { PrincipalRow, RotateApiKeyResult } from '../lib/governance.js';
import { useT } from '../lib/i18n.js';
import { principalKindLabel, roleLabel } from '../lib/labels.js';
import { DrawerSection, DrawerSections } from './kit/drawer-section.js';
import { RefChip } from './kit/ref-chip.js';
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
 * `rotate_api_key`, `disable_principal` (S3.11). `disable_principal` keeps its same-drawer confirm
 * step (a two-click local toggle; the drawer-based `ConfirmTier` tiers would open a second focus
 * trap inside this drawer) since it revokes every Handle/session the member holds (S3.11
 * background: "撤销其全部 Handle 与入口会话"). B3 / B4 (S6-A): the Worker-definition reference is a
 * `RefChip` (S8 W1-A6, audit S10: this page loads no `list_worker_definitions` directory, so the
 * kit chip self-resolves its own name through `resolve_refs` instead of degrading to a bare id)
 * and the copy is bilingual.
 */
export function PrincipalDetail({
  http,
  principal,
  canManage,
  onChanged,
  onForbidden,
}: PrincipalDetailProps) {
  const t = useT();
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
      {/* S8 W1-A11 (audit L8): the drawer's fixed three sections — metadata / related links /
       *  edit form — replacing the old flat stack separated only by `.divider`s. */}
      <DrawerSections>
        <DrawerSection title={t('元数据 Metadata', 'Metadata')}>
          <dl className="definition-list">
            <dt>Id</dt>
            <dd>
              <CopyId id={principal.id} label="principal" />
            </dd>
            <dt>{t('类型', 'Kind')}</dt>
            <dd>
              <span className="tag">{principalKindLabel(principal.kind, t)}</span>
            </dd>
            <dt>{t('状态', 'Status')}</dt>
            <dd>
              <span
                className={`chip chip-s ${disabled ? 'chip-neutral' : 'chip-ok'}`}
                data-status={disabled ? 'disabled' : 'active'}
                data-testid="principal-status"
              >
                {disabled ? t('已停用', 'Disabled') : t('活跃', 'Active')}
              </span>
            </dd>
            <dt>API key</dt>
            <dd>{principal.hasApiKey ? t('已签发', 'issued') : t('无', 'none')}</dd>
            <dt>{t('创建', 'Created')}</dt>
            <dd>
              <time title={formatDateTime(principal.createdAt)}>
                {formatRelative(principal.createdAt)}
              </time>
            </dd>
            {principal.disabledAt ? (
              <>
                <dt>{t('停用于', 'Disabled')}</dt>
                <dd>
                  <time title={formatDateTime(principal.disabledAt)}>
                    {formatRelative(principal.disabledAt)}
                  </time>
                </dd>
              </>
            ) : null}
          </dl>
        </DrawerSection>

        {principal.workerDefinitionId ? (
          <DrawerSection title={t('相关链接 Related links', 'Related links')}>
            <dl className="definition-list">
              <dt>{t('Worker 定义', 'Worker definition')}</dt>
              <dd>
                <RefChip
                  kind="workerDefinition"
                  id={principal.workerDefinitionId}
                  http={http}
                  size="s"
                  testId="principal-worker-definition"
                />
              </dd>
            </dl>
          </DrawerSection>
        ) : null}

        {canManage ? (
          <DrawerSection title={t('编辑 Edit', 'Edit')}>
            <Field id="principal-role" label={t('角色', 'Role')}>
              <div className="row">
                <Select
                  id="principal-role"
                  value={role}
                  onChange={(event) => setRole(event.target.value as Role)}
                  disabled={savingRole || disabled}
                >
                  {ROLE_VALUES.map((value) => (
                    <option key={value} value={value}>
                      {roleLabel(value, t)}
                    </option>
                  ))}
                </Select>
                <Button
                  variant="secondary"
                  onClick={() => void saveRole()}
                  loading={savingRole}
                  disabled={role === principal.role || disabled}
                >
                  {t('保存', 'Save')}
                </Button>
              </div>
            </Field>
            {roleError !== null ? (
              <ErrorBanner
                error={roleError}
                title={t('无法修改角色', 'Could not change the role')}
              />
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
                  {t('轮换', 'API key Rotate API key')}
                </Button>
              )}
            </div>
            {rotateError !== null ? (
              <ErrorBanner error={rotateError} title={t('无法轮换', 'Could not rotate the key')} />
            ) : null}
            {rotated ? (
              <div className="stack-s" data-testid="rotated-api-key">
                <Notice tone="warn">
                  {t(
                    '新 API key 只显示一次；旧 key 立即失效。',
                    'New API key shown once — the previous key stops working immediately.',
                  )}
                </Notice>
                <div className="code-block row" style={{ justifyContent: 'space-between' }}>
                  <span className="mono">{rotated.apiKey}</span>
                  <CopyId id={rotated.apiKey} label="API key" full />
                </div>
                <div className="row" style={{ justifyContent: 'flex-end' }}>
                  <Button variant="secondary" size="s" onClick={() => setRotated(null)}>
                    {t('我已复制', "I've copied it")}
                  </Button>
                </div>
              </div>
            ) : null}

            <div className="divider" />

            {disabled ? null : confirmingDisable ? (
              <div className="stack-s">
                <Notice tone="warn">
                  {t(
                    '停用会吊销该成员持有的全部 Handle 与入口会话，且不能从这里撤销。',
                    'Disabling revokes every Handle and entry session this member holds. This cannot be undone from here.',
                  )}
                </Notice>
                {disableError !== null ? (
                  <ErrorBanner
                    error={disableError}
                    title={t('无法停用', 'Could not disable this member')}
                  />
                ) : null}
                <div className="row" style={{ justifyContent: 'flex-end' }}>
                  <Button variant="ghost" onClick={() => setConfirmingDisable(false)}>
                    {t('取消', 'Cancel')}
                  </Button>
                  <Button variant="danger" onClick={() => void disable()} loading={disabling}>
                    {t('确认停用', 'Confirm disable')}
                  </Button>
                </div>
              </div>
            ) : (
              <div className="row" style={{ justifyContent: 'flex-end' }}>
                <Button variant="danger" onClick={() => setConfirmingDisable(true)}>
                  {t('停用成员', 'Disable member')}
                </Button>
              </div>
            )}
          </DrawerSection>
        ) : null}
      </DrawerSections>
    </div>
  );
}
