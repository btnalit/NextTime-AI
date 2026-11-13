import type {
  GateAddressChangePreviewWire,
  GateAddressChangeWire,
  MintConnectionSecretResultWire,
} from '@nexttime/shared';
import { type FormEvent, useEffect, useState } from 'react';
import { useCapability } from '../../hooks/useCapability.js';
import { useFocusWhenLost } from '../../hooks/useFocusWhenLost.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { formatDateTime, formatRelative } from '../../lib/format.js';
import {
  gateAddressChangeImpactLines,
  gateAddressManifestProblems,
} from '../../lib/gate-address-change.js';
import {
  gateEndpointDefaultScheme,
  isAbsoluteUrl,
  withDefaultScheme,
} from '../../lib/gate-input.js';
import type { GatekeeperDetail } from '../../lib/governance.js';
import { useT } from '../../lib/i18n.js';
import { ConnectionSecretReveal } from '../connect/ConnectionSecretReveal.js';
import { Button } from '../kit/button.js';
import { Confirm } from '../kit/confirm.js';
import { ErrorBanner } from '../kit/error-banner.js';
import { Field, describedBy } from '../kit/field.js';
import { KeyValue } from '../kit/key-value.js';
import { Notice } from '../kit/notice.js';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '../kit/sheet.js';
import { SkeletonRows } from '../kit/skeleton.js';
import { StillNeeded } from '../kit/still-needed.js';

export interface GateAddressChangeSheetProps {
  readonly http: CapabilityCaller;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly gatekeeperId: string;
  readonly gateName: string;
}

/**
 * components/systems/GateAddressChangeSheet (legacy 701): 系统与授权 → ⋯ → 「更换地址」 for a gate
 * the workspace connected itself — `http://` to `https://`, or a new host — without connecting it
 * again. The gate keeps its id, so its published Operations, grants, automatic approvals and the
 * Worker definitions that use it all follow it; that is why the move is a proposal a platform
 * administrator decides, not an edit (kernel `gate-address-change-handlers.ts`).
 *
 * Three steps, top to bottom: ① a connection secret for the new address (`mint_connection_secret`,
 * shown once — the gate there needs it before anything can ask it), ② the new address, previewed
 * (`preview_gate_address_change` asks the gate there for its manifest with that secret and says
 * what follows the gate), ③ the proposal (`propose_gate_address_change`). An open proposal
 * replaces the steps with where it stands and 撤回 (`PendingGateAddressChange`, also in the gate's
 * 「健康与操作」).
 */
export function GateAddressChangeSheet({
  http,
  open,
  onOpenChange,
  gatekeeperId,
  gateName,
}: GateAddressChangeSheetProps) {
  const t = useT();
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent data-testid="gate-address-change">
        <SheetHeader>
          <SheetTitle>
            {t(`更换「${gateName}」的地址`, `Move “${gateName}” to a new address`)}
          </SheetTitle>
          <SheetDescription>
            {t(
              '门换地址后还是同一扇门：它已发布的 Operation、授权、自动批准和用到它的 Worker 定义都跟过去，不用重新接入。正因为这些都跟过去，换地址要平台管理员批准才生效。',
              'After the move it is the same gate: its published Operations, grants, automatic approvals and the Worker definitions that use it all follow it, with nothing to connect again. Because all of that follows it, a platform administrator has to approve the move before it takes effect.',
            )}
          </SheetDescription>
        </SheetHeader>
        {/* Mounted while the sheet is open only: each opening reads the gate afresh — a proposal
            an administrator decided meanwhile is gone — and the steps start with a new secret. */}
        <GateAddressChangeBody http={http} gatekeeperId={gatekeeperId} />
      </SheetContent>
    </Sheet>
  );
}

function GateAddressChangeBody({
  http,
  gatekeeperId,
}: {
  readonly http: CapabilityCaller;
  readonly gatekeeperId: string;
}) {
  const t = useT();
  const detail = useCapability<GatekeeperDetail>(http, 'get_gatekeeper', { gatekeeperId });
  // The proposal just made, shown at once rather than after the read that follows it.
  const [proposed, setProposed] = useState<GateAddressChangeWire | null>(null);
  // Review #501 of #1158: the proposal just withdrawn, hidden at once rather than after the read
  // that follows it (until then that read still answers with it).
  const [withdrawnId, setWithdrawnId] = useState<string | null>(null);

  if (detail.state.status === 'loading') {
    return (
      <SkeletonRows
        count={3}
        label={t('正在读取门的地址…', 'Reading the gate’s address')}
        testId="gate-address-change-loading"
      />
    );
  }
  if (detail.state.status === 'error') {
    return (
      <ErrorBanner
        error={detail.state.error}
        title={t('无法读取这个门', 'Could not read this gate')}
        onRetry={() => void detail.reload()}
        testId="gate-address-change-load-error"
      />
    );
  }
  const gate = detail.state.data;
  const stored = gate.pendingAddressChange ?? null;
  const pending = proposed ?? (stored !== null && stored.id !== withdrawnId ? stored : null);
  return (
    <div className="stack">
      <KeyValue
        items={[
          {
            label: t('现在的地址', 'Current address'),
            value: gate.endpoint ?? '—',
            mono: true,
          },
        ]}
        testId="gate-address-change-current"
      />
      {pending !== null ? (
        <PendingGateAddressChange
          http={http}
          change={pending}
          onWithdrawn={() => {
            setWithdrawnId(pending.id);
            setProposed(null);
            void detail.reload();
          }}
        />
      ) : (
        // Unmounted while a proposal is open, so after one is withdrawn the steps start again
        // with a new secret: the last one is spent.
        <ProposeGateAddressChange
          http={http}
          gatekeeperId={gatekeeperId}
          onProposed={(change) => {
            setProposed(change);
            void detail.reload();
          }}
        />
      )}
    </div>
  );
}

function ProposeGateAddressChange({
  http,
  gatekeeperId,
  onProposed,
}: {
  readonly http: CapabilityCaller;
  readonly gatekeeperId: string;
  readonly onProposed: (change: GateAddressChangeWire) => void;
}) {
  const t = useT();
  const [secret, setSecret] = useState<string | null>(null);
  const [secretError, setSecretError] = useState<unknown | null>(null);
  const [endpoint, setEndpoint] = useState('');
  const [endpointError, setEndpointError] = useState<string | null>(null);
  const [preview, setPreview] = useState<GateAddressChangePreviewWire | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [proposing, setProposing] = useState(false);
  const [error, setError] = useState<unknown | null>(null);
  // Legacy 500: the buttons are disabled while a call runs, so a refusal would leave focus on
  // <body> with its banner out of view — focus goes to the banner.
  const errorRef = useFocusWhenLost<HTMLDivElement>(error);

  // Step ①. Minting stores nothing: a secret only binds once a proposal carries it.
  useEffect(() => {
    let current = true;
    http.call<MintConnectionSecretResultWire>('mint_connection_secret', {}).then(
      (result) => {
        if (current) setSecret(result.connectionSecret);
      },
      (err: unknown) => {
        if (current) setSecretError(err);
      },
    );
    return () => {
      current = false;
    };
  }, [http]);

  /** What gets sent: a bare `host:port` gets `http://`, a public domain or IP `https://`, as
   *  直接注册门 does (legacy 152). */
  const endpointValue = withDefaultScheme(endpoint, gateEndpointDefaultScheme(endpoint));

  function changeEndpoint(value: string): void {
    setEndpoint(value);
    setEndpointError(null);
    // A preview is of one address: another one has to be previewed again.
    setPreview(null);
    setError(null);
  }

  async function runPreview(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (secret === null || previewing) return;
    if (!isAbsoluteUrl(endpointValue)) {
      setEndpointError(
        t(
          '新地址需要一个完整的地址，例如 https://gate.example.com（不能有空格）。',
          'The new address needs a full address, e.g. https://gate.example.com (no spaces).',
        ),
      );
      return;
    }
    setEndpoint(endpointValue);
    setPreviewing(true);
    setPreview(null);
    setError(null);
    try {
      setPreview(
        await http.call<GateAddressChangePreviewWire>('preview_gate_address_change', {
          gatekeeperId,
          endpoint: endpointValue,
          connectionSecret: secret,
        }),
      );
    } catch (err) {
      setError(err);
    } finally {
      setPreviewing(false);
    }
  }

  async function propose(): Promise<void> {
    if (secret === null || preview === null || proposing) return;
    setProposing(true);
    setError(null);
    try {
      onProposed(
        await http.call<GateAddressChangeWire>('propose_gate_address_change', {
          gatekeeperId,
          endpoint: endpointValue,
          connectionSecret: secret,
          previewDigest: preview.previewDigest,
        }),
      );
    } catch (err) {
      setError(err);
    } finally {
      setProposing(false);
    }
  }

  const problems = preview === null ? [] : gateAddressManifestProblems(preview.manifest, t);
  const stillNeeded: string[] = [];
  if (secret === null)
    stillNeeded.push(t('新地址的连接密钥', 'the new address’s connection secret'));
  if (endpoint.trim() === '') stillNeeded.push(t('填写新地址', 'enter the new address'));
  const proposeReason =
    preview === null
      ? t('先预览新地址', 'Preview the new address first')
      : problems.length > 0
        ? t(
            '已发布的 Operation，新地址上的门要先原样提供',
            'The gate at the new address has to describe the published Operations first',
          )
        : null;
  const endpointId = 'gate-address-change-endpoint';

  return (
    <div className="stack">
      <section className="stack-s" data-testid="gate-address-change-secret">
        <span className="field-label">
          {t('① 新地址用的连接密钥', '① A connection secret for the new address')}
        </span>
        <p className="field-hint">
          {t(
            '把它配给新地址上的门，门才答得出它的清单。批准之前，内核仍用现在的密钥调用现在的地址；如果新旧地址其实是同一扇门（比如只是从 http 换成 https），换上新密钥之后旧地址的调用会被门拒绝，直到批准——这种情况下，提交后请尽快联系平台管理员审批。',
            'Give it to the gate at the new address so it can answer for its manifest. Until the move is approved, the kernel keeps calling the current address with the current secret; if both addresses reach the same gate (only http to https, say), calls to the current address are refused by the gate once it holds the new secret, until the move is approved — so in that case, ask a platform administrator to decide it soon after you propose it.',
          )}
        </p>
        {secretError !== null ? (
          <ErrorBanner
            error={secretError}
            title={t('无法生成连接密钥', 'Could not issue a connection secret')}
            testId="gate-address-change-secret-error"
          />
        ) : secret === null ? (
          <SkeletonRows count={1} label={t('正在生成连接密钥…', 'Issuing a connection secret')} />
        ) : (
          <ConnectionSecretReveal secret={secret} testId="gate-address-change-secret-value" />
        )}
      </section>

      <form className="stack-s" onSubmit={(event) => void runPreview(event)} noValidate>
        <Field
          id={endpointId}
          label={t('② 新地址', '② The new address')}
          hint={t(
            '门自己的地址，例如 https://gate.example.com。公网地址要用 https。',
            'The gate’s own address, e.g. https://gate.example.com. A public address needs https.',
          )}
          error={endpointError}
          required
        >
          <input
            id={endpointId}
            className="input mono"
            value={endpoint}
            onChange={(event) => changeEndpoint(event.target.value)}
            aria-describedby={describedBy(endpointId, true, endpointError !== null)}
            aria-invalid={endpointError !== null ? true : undefined}
            autoComplete="off"
            spellCheck={false}
            data-testid="gate-address-change-endpoint"
          />
        </Field>
        <div className="row-wrap">
          <Button
            type="submit"
            size="s"
            disabled={previewing || secret === null || endpoint.trim() === ''}
            aria-busy={previewing || undefined}
            data-testid="gate-address-change-preview"
          >
            {previewing
              ? t('正在问新地址上的门…', 'Asking the gate at the new address…')
              : t('预览', 'Preview')}
          </Button>
          <StillNeeded items={stillNeeded} hidden={previewing} />
        </div>
      </form>

      {preview !== null ? (
        <section className="stack-s" data-testid="gate-address-change-preview-result">
          {problems.length > 0 ? (
            <Notice tone="danger" testId="gate-address-change-manifest-mismatch">
              <strong>
                {t(
                  '新地址上的门提供的 Operation 和已发布的不一致，不能换过去',
                  'The gate at the new address does not offer the published Operations — it cannot move there',
                )}
              </strong>
              <ul className="stack-s" style={{ margin: 0, paddingLeft: '1.2em' }}>
                {problems.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
              <p className="text-small">
                {t(
                  '换地址不改门做什么。先让新地址上的门原样提供已发布的 Operation，换过去之后，再用「重新读取门的清单」同步它的变化。',
                  'A move never changes what the gate does. Have the gate at the new address describe the published Operations as they are, move it, then bring in its changes with “Re-read the gate’s manifest”.',
                )}
              </p>
            </Notice>
          ) : (
            <Notice tone="info" testId="gate-address-change-manifest-match">
              {t(
                '新地址上的门原样提供了已发布的 Operation。',
                'The gate at the new address describes the published Operations as published.',
              )}
            </Notice>
          )}
          <span className="field-label">
            {t('换过去之后，这些跟着门走', 'What follows the gate to the new address')}
          </span>
          <ul
            className="stack-s"
            style={{ margin: 0, paddingLeft: '1.2em' }}
            data-testid="gate-address-change-impact"
          >
            {gateAddressChangeImpactLines(preview.impact, t).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {error !== null ? (
        <div ref={errorRef} tabIndex={-1}>
          <ErrorBanner
            error={error}
            title={t('没能提出更换地址', 'Could not propose the move')}
            testId="gate-address-change-error"
          />
        </div>
      ) : null}

      <div className="row-wrap">
        <Button
          variant="primary"
          size="s"
          onClick={() => void propose()}
          disabled={proposing || preview === null || problems.length > 0}
          aria-busy={proposing || undefined}
          data-testid="gate-address-change-propose"
        >
          {t('③ 提交给平台管理员审批', '③ Send to a platform administrator')}
        </Button>
        <StillNeeded reason={proposeReason} hidden={proposing} />
      </div>
    </div>
  );
}

export interface PendingGateAddressChangeProps {
  readonly http: CapabilityCaller;
  readonly change: GateAddressChangeWire;
  readonly onWithdrawn: () => void;
}

/** An open proposal to move this gate, as its owner sees it: from where to where, until when a
 *  platform administrator can decide it, and 撤回. Shown in 「更换地址」 and in the gate's
 *  「健康与操作」 (`GatekeeperDetailDrawer`); `get_gatekeeper` gives it to owners only. */
export function PendingGateAddressChange({
  http,
  change,
  onWithdrawn,
}: PendingGateAddressChangeProps) {
  const t = useT();
  const [confirmOpen, setConfirmOpen] = useState(false);
  return (
    <Notice tone="info" testId="gate-address-change-pending">
      <div className="stack-s">
        <strong>
          {t('换地址的申请在等平台管理员审批', 'A move is waiting for a platform administrator')}
        </strong>
        <KeyValue
          items={[
            { label: t('现在', 'Now'), value: change.fromEndpoint, mono: true },
            { label: t('换到', 'Moving to'), value: change.toEndpoint, mono: true },
            {
              label: t('提出于', 'Proposed'),
              value: (
                <time dateTime={change.createdAt} title={formatDateTime(change.createdAt)}>
                  {formatRelative(change.createdAt)}
                </time>
              ),
            },
            {
              label: t('没人审批就过期于', 'Expires unless decided'),
              value: (
                <time dateTime={change.expiresAt} title={formatDateTime(change.expiresAt)}>
                  {formatRelative(change.expiresAt)}
                </time>
              ),
            },
          ]}
        />
        <p className="text-small">
          {t(
            '批准之前门还在现在的地址，照常可用；过期或被驳回都不生效，要换就重新申请。',
            'Until it is approved the gate stays where it is and works as before; expired or rejected, nothing changes, and moving it takes a new proposal.',
          )}
        </p>
        <div className="row-wrap">
          <Confirm
            tier="medium"
            open={confirmOpen}
            onOpenChange={setConfirmOpen}
            anchor={
              <Button
                size="s"
                onClick={() => setConfirmOpen(true)}
                data-testid="gate-address-change-withdraw"
              >
                {t('撤回', 'Withdraw')}
              </Button>
            }
            title={t('撤回换地址的申请', 'Withdraw the move')}
            target={change.toEndpoint}
            impact={[
              t('门留在现在的地址', 'The gate stays at its current address'),
              t(
                '这次用的连接密钥作废：再申请要用新生成的',
                'The connection secret it used is spent: a new proposal needs a new one',
              ),
            ]}
            confirmLabel={t('撤回', 'Withdraw')}
            onConfirm={async () => {
              await http.call<GateAddressChangeWire>('withdraw_gate_address_change', {
                id: change.id,
              });
              onWithdrawn();
            }}
            testId="gate-address-change-withdraw-confirm"
          />
        </div>
      </div>
    </Notice>
  );
}
