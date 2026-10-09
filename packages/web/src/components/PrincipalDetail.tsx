import { ROLE_VALUES, type Role } from '@nexttime/shared';
import { useState } from 'react';
import type { CapabilityCaller } from '../lib/clients.js';
import { isForbiddenError } from '../lib/errors.js';
import { formatDateTime, formatRelative } from '../lib/format.js';
import {
  type PrincipalRow,
  type RotateApiKeyResult,
  ownerCredentialConfirmCopy,
} from '../lib/governance.js';
import { useT } from '../lib/i18n.js';
import { principalKindLabel, roleLabel } from '../lib/labels.js';
import { Button } from './kit/button.js';
import { Confirm } from './kit/confirm.js';
import { CopyButton } from './kit/copy-button.js';
import { DrawerSection, DrawerSections } from './kit/drawer-section.js';
import { ErrorBanner } from './kit/error-banner.js';
import { Field } from './kit/field.js';
import { KeyValue, type KeyValueItem } from './kit/key-value.js';
import { Notice } from './kit/notice.js';
import { RefChip } from './kit/ref-chip.js';
import { Select } from './kit/select.js';
import { StatusChip } from './kit/status-chip.js';

export interface PrincipalDetailProps {
  readonly http: CapabilityCaller;
  readonly principal: PrincipalRow;
  readonly canManage: boolean;
  readonly onChanged: (principal: PrincipalRow) => void;
  readonly onForbidden: (capabilityName: string) => void;
}

/**
 * components/PrincipalDetail (console redesign P3-4 part B, on `components/kit/*` only): one
 * Member's drawer body — `set_principal_role`, `rotate_api_key`, `disable_principal` (S3.11).
 * `disable_principal` keeps its same-drawer confirm step (a two-click local toggle; the drawer's
 * own `kit/confirm` `medium` tier would open a second popover inside an already-open `kit/sheet` —
 * kept as the existing simple toggle rather than layering another confirm surface) since it
 * revokes every Handle/session the member holds (S3.11 background: "撤销其全部 Handle 与入口会话").
 * The metadata section is `kit/key-value`; the Worker-definition reference and the on-drawer
 * identity are `kit/ref-chip` (S8 W1-A6, audit S10: this page loads no `list_worker_definitions`
 * directory, so the kit chip self-resolves its own name through `resolve_refs` instead of
 * degrading to a bare id).
 *
 * R-06 (review 2026-10-02, D-05): the edit section shows for a `human` member and a `service`
 * credential alike — the kernel disables, re-keys and re-roles both — and stays hidden for the
 * platform's own identities it refuses (`platform_managed`): a Worker's `agent` Principal and an
 * internal service Principal (`internal`, kernel-derived). Promoting a service credential to
 * owner goes through the same `kit/confirm tier="irreversible"` as creating one
 * (`CreatePrincipalForm`), so "create as member, then promote" cannot skip it; promoting a person,
 * or demoting anyone, saves straight away as before.
 *
 * Review 2026-10-02 D-25 (L8a-11): "Rotate API key" is a service credential's control only — the
 * kernel refuses to mint a key for a person (a key the owner could use to act as the member), so a
 * human member's drawer says why there is no button instead.
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
  const [confirmingOwner, setConfirmingOwner] = useState(false);

  const [rotating, setRotating] = useState(false);
  const [rotateError, setRotateError] = useState<unknown | null>(null);
  const [rotated, setRotated] = useState<RotateApiKeyResult | null>(null);

  const [confirmingDisable, setConfirmingDisable] = useState(false);
  const [disabling, setDisabling] = useState(false);
  const [disableError, setDisableError] = useState<unknown | null>(null);

  async function callSetRole(): Promise<void> {
    const updated = await http.call<PrincipalRow>('set_principal_role', {
      principalId: principal.id,
      role,
    });
    onChanged(updated);
  }

  async function saveRole(): Promise<void> {
    if (role === principal.role) return;
    if (principal.kind === 'service' && role === 'owner') {
      setRoleError(null);
      setConfirmingOwner(true);
      return;
    }
    setSavingRole(true);
    setRoleError(null);
    try {
      await callSetRole();
    } catch (err) {
      if (isForbiddenError(err)) onForbidden('set_principal_role');
      setRoleError(err);
      setRole(principal.role);
    } finally {
      setSavingRole(false);
    }
  }

  async function promoteServiceToOwner(): Promise<void> {
    try {
      await callSetRole();
    } catch (err) {
      if (isForbiddenError(err)) onForbidden('set_principal_role');
      throw err;
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
  const platformManaged = principal.kind === 'agent' || principal.internal === true;
  const ownerCopy = ownerCredentialConfirmCopy(t);

  const metadataItems: KeyValueItem[] = [
    {
      key: 'id',
      label: 'Id',
      value: <RefChip kind="principal" id={principal.id} name={principal.displayName} size="s" />,
    },
    { key: 'kind', label: t('类型', 'Kind'), value: principalKindLabel(principal.kind, t) },
    {
      key: 'status',
      label: t('状态', 'Status'),
      value: (
        <span
          className={`chip chip-s ${disabled ? 'chip-neutral' : 'chip-ok'}`}
          data-status={disabled ? 'disabled' : 'active'}
          data-testid="principal-status"
        >
          {disabled ? t('已停用', 'Disabled') : t('活跃', 'Active')}
        </span>
      ),
    },
    {
      key: 'apiKey',
      label: 'API key',
      value: principal.hasApiKey ? t('已签发', 'issued') : t('无', 'none'),
    },
    {
      key: 'createdAt',
      label: t('创建', 'Created'),
      value: (
        <time title={formatDateTime(principal.createdAt)}>
          {formatRelative(principal.createdAt)}
        </time>
      ),
    },
  ];
  if (principal.disabledAt) {
    metadataItems.push({
      key: 'disabledAt',
      label: t('停用于', 'Disabled'),
      value: (
        <time title={formatDateTime(principal.disabledAt)}>
          {formatRelative(principal.disabledAt)}
        </time>
      ),
    });
  }

  return (
    <div className="stack" data-testid="principal-detail">
      {/* S8 W1-A11 (audit L8): the drawer's fixed three sections — metadata / related links /
       *  edit form — replacing the old flat stack separated only by `.divider`s. */}
      <DrawerSections>
        <DrawerSection title={t('元数据', 'Metadata')}>
          <KeyValue items={metadataItems} />
        </DrawerSection>

        {principal.workerDefinitionId ? (
          <DrawerSection title={t('相关链接', 'Related links')}>
            <KeyValue
              items={[
                {
                  key: 'workerDefinition',
                  label: t('Worker 定义', 'Worker definition'),
                  value: (
                    <RefChip
                      kind="workerDefinition"
                      id={principal.workerDefinitionId}
                      http={http}
                      size="s"
                      testId="principal-worker-definition"
                    />
                  ),
                },
              ]}
            />
          </DrawerSection>
        ) : null}

        {canManage && !platformManaged ? (
          <DrawerSection title={t('编辑', 'Edit')}>
            <Field id="principal-role" label={t('角色', 'Role')}>
              <div className="row">
                <Select
                  id="principal-role"
                  aria-label={t('角色', 'Role')}
                  className="select-fit"
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
                <Confirm
                  tier="irreversible"
                  open={confirmingOwner}
                  onOpenChange={setConfirmingOwner}
                  anchor={
                    <Button
                      variant="secondary"
                      onClick={() => void saveRole()}
                      aria-busy={savingRole}
                      disabled={role === principal.role || disabled}
                    >
                      {t('保存', 'Save')}
                    </Button>
                  }
                  title={t('把服务凭证提升为 owner', 'Promote a service credential to owner')}
                  description={ownerCopy.description}
                  target={principal.displayName}
                  impact={ownerCopy.impact}
                  confirmLabel={t('提升为 owner', 'Promote to owner')}
                  onConfirm={promoteServiceToOwner}
                  testId="principal-owner-confirm"
                />
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
              {principal.kind === 'human' ? (
                <span className="text-3 text-small" data-testid="principal-no-person-key">
                  {t(
                    '成员用密码登录，不签发 API key；自动化请用服务凭证。',
                    'People sign in with a password and get no API key — use a service credential for automation.',
                  )}
                </span>
              ) : rotated ? null : (
                <Button
                  variant="secondary"
                  size="s"
                  onClick={() => void rotateKey()}
                  aria-busy={rotating}
                  disabled={disabled}
                >
                  {t('轮换 API key', 'Rotate API key')}
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
                  <CopyButton value={rotated.apiKey} label={t('API 密钥', 'API key')} />
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
                  <Button variant="danger" onClick={() => void disable()} aria-busy={disabling}>
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
