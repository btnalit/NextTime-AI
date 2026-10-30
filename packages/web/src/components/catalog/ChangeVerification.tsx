import {
  CHANGE_VERIFICATION_COOLDOWN_SECONDS,
  type ChangeRequirementCheckWire,
  type ChangeSegmentWire,
  type ChangeVerificationResultWire,
  type ChangeVerificationWire,
  type PackInstallStatus,
  type PackRequirementState,
  type PackRequirementWire,
} from '@nexttime/shared';
import { useEffect, useId, useRef, useState } from 'react';
import { usePermissions } from '../../hooks/usePermissions.js';
import { useRoleCan } from '../../hooks/useRoleCan.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { isForbiddenError } from '../../lib/errors.js';
import { formatDateTime, shortId } from '../../lib/format.js';
import { HttpError } from '../../lib/http-client.js';
import { type Translate, useT } from '../../lib/i18n.js';
import { principalShownName } from '../../lib/labels.js';
import { hrefs } from '../../lib/router.js';
import { EnableGateConfirm } from '../connect/EnableGateConfirm.js';
import { Button } from '../kit/button.js';
import { ErrorBanner } from '../kit/error-banner.js';
import { Notice } from '../kit/notice.js';
import { RouteLink } from '../kit/route-link.js';
import { StatusChip } from '../kit/status-chip.js';

/**
 * components/catalog/ChangeVerification (S11 P1-E / P1-E2): the systems a pack needs, where each
 * stands in the workspace and what to do about it (`PackRequirementWire`: the 能力包 detail and
 * install review), and an install
 * record's 核验 — the latest run (`ChangeVerificationWire`: are the changes still in effect, are
 * the systems connected and up, are the packs it builds on still installed at the version it
 * needs) and, for the owner, running it again (`verify_change_segment`, at
 * most once every `CHANGE_VERIFICATION_COOLDOWN_SECONDS`).
 */

/** Where a system in `state` stands, in a sentence, or `null` when it is connected. */
export function requirementHint(state: PackRequirementState, t: Translate): string | null {
  switch (state) {
    case 'connected':
      return null;
    case 'can_enable':
      return t(
        '平台已经提供，工作区还没启用。',
        'The platform offers it; the workspace has not enabled it yet.',
      );
    case 'needs_platform':
      // Also every instance of it disabled (UX acceptance of #705, P3-3).
      return t(
        '平台没有提供它，或者提供的门实例已经停用，需要平台管理员接入或重新启用。',
        'The platform does not offer it, or its gate instances are disabled; a platform administrator connects or re-enables one first.',
      );
  }
}

/** The version a pack needs of a pack it builds on (S11 P1-F): 「v2 或更高」. */
export function minVersionText(minVersion: number, t: Translate): string {
  return t(`v${minVersion} 或更高`, `v${minVersion} or later`);
}

/** How the workspace has a pack another builds on, in a few words: 「未安装」, 「已装 v1」. */
export function dependencyNowText(
  dependency: { readonly status: PackInstallStatus; readonly installedVersion: number | null },
  t: Translate,
): string {
  if (dependency.status === 'not_installed') return t('未安装', 'not installed');
  if (dependency.installedVersion === null) return t('已定制', 'customized');
  return t(`已装 v${dependency.installedVersion}`, `v${dependency.installedVersion} installed`);
}

/**
 * The systems a pack needs, each with where it stands (the 能力包 detail and install review). With
 * `onChanged` (the pack's detail) each one says what to do about it, right there (P1-E2): a
 * connected one names its gates; one the platform offers is enabled in place — the owner's
 * `enable_gate_instance`, behind the same preview-then-confirm the 系统 page uses; one the platform
 * has not set up sends a platform administrator to 平台 · 集成 and tells anyone else who does it.
 * Without it (inside the install review, itself a confirm) the list only says where each stands.
 */
export function PackRequirementList({
  http,
  requirements,
  platformAdmin = false,
  onChanged,
  testId,
}: {
  readonly http: CapabilityCaller;
  readonly requirements: readonly PackRequirementWire[];
  /** `session.user?.platformRole === 'admin'`. */
  readonly platformAdmin?: boolean;
  /** Something was enabled: read the pack again. */
  readonly onChanged?: () => void;
  readonly testId: string;
}) {
  const t = useT();
  const can = useRoleCan(http);
  const canEnable = can('enable_gate_instance') !== false;
  // Enabling one takes its button away (UX acceptance of #705, P3-1): once the pack is read
  // again, focus moves to its row, whose state line announces where it stands now.
  const [enabled, setEnabled] = useState<string | null>(null);
  const rows = useRef(new Map<string, HTMLDivElement>());
  useEffect(() => {
    if (enabled === null) return;
    const now = requirements.find((requirement) => requirement.connector === enabled);
    if (now?.state === 'can_enable') return;
    rows.current.get(enabled)?.focus();
    setEnabled(null);
  }, [enabled, requirements]);
  return (
    <div className="stack-s" data-testid={testId}>
      {requirements.map((requirement) => {
        const hint = requirementHint(requirement.state, t);
        const rowId = `${testId}-${requirement.connector}`;
        return (
          <div
            className="stack-s"
            key={requirement.connector}
            data-testid={rowId}
            tabIndex={-1}
            ref={(row) => {
              if (row) rows.current.set(requirement.connector, row);
              else rows.current.delete(requirement.connector);
            }}
          >
            <span className="row-wrap" role={onChanged ? 'status' : undefined}>
              <span className="mono">{requirement.connector}</span>
              <StatusChip machine="packRequirement" status={requirement.state} size="s" />
            </span>
            {requirement.state === 'connected' && requirement.gatekeepers.length > 0 ? (
              <span className="row-wrap text-3 text-small" data-testid={`${rowId}-gates`}>
                <span>{t('已接好的门：', 'Connected gates: ')}</span>
                {requirement.gatekeepers.map((gate) =>
                  onChanged ? (
                    <RouteLink
                      key={gate.id}
                      href={hrefs.gatekeeper(gate.id)}
                      testId={`${rowId}-gate-${gate.id}`}
                    >
                      {gate.name}
                    </RouteLink>
                  ) : (
                    <span key={gate.id}>{gate.name}</span>
                  ),
                )}
              </span>
            ) : null}
            {hint ? <span className="text-3 text-small">{hint}</span> : null}
            {onChanged && requirement.state === 'can_enable' ? (
              canEnable ? (
                requirement.offered.map((offer) => (
                  <span className="row-wrap text-small" key={offer.gateId}>
                    <span>{offer.displayName}</span>
                    <EnableGateConfirm
                      key={offer.gateId}
                      http={http}
                      gateId={offer.gateId}
                      gateDisplayName={offer.displayName}
                      platformAdmin={platformAdmin}
                      onEnabled={() => {
                        setEnabled(requirement.connector);
                        onChanged();
                      }}
                      testId={`${rowId}-enable-${offer.gateId}`}
                    />
                  </span>
                ))
              ) : (
                <span className="text-3 text-small" data-testid={`${rowId}-owner-only`}>
                  {t(
                    '工作区所有者可以在这里直接启用。',
                    'A workspace owner can enable it right here.',
                  )}
                </span>
              )
            ) : null}
            {onChanged && requirement.state === 'needs_platform' ? (
              platformAdmin ? (
                // S11 P1-F: a system the platform ships a connector preset for opens 新建门宿主实例
                // on that preset — the administrator types its address only.
                requirement.platformPreset ? (
                  <RouteLink
                    href={hrefs.platformConnectorPreset(requirement.connector)}
                    testId={`${rowId}-preset`}
                  >
                    {/* UX acceptance of #715 (P3-3): the row names the system above; the link
                     *  does not repeat its connector name in place of the preset's own name. */}
                    {t(
                      '去「平台 · 集成」按它的接入预设接入（只填地址）',
                      'Connect it from its preset under Platform · Integrations (address only)',
                    )}
                  </RouteLink>
                ) : (
                  <RouteLink
                    href={hrefs.platformIntegrationsTab('instances')}
                    testId={`${rowId}-platform`}
                  >
                    {t(
                      `去「平台 · 集成」看 ${requirement.connector} 门实例`,
                      `See the ${requirement.connector} gate instances under Platform · Integrations`,
                    )}
                  </RouteLink>
                )
              ) : (
                <span className="text-3 text-small" data-testid={`${rowId}-ask-platform`}>
                  {requirement.platformPreset
                    ? t(
                        '平台自带它的接入预设：请平台管理员在「平台 · 集成」按预设接入（只要它的地址和凭证），之后这里就能启用。',
                        'The platform ships a connector preset for it: ask a platform administrator to connect it from that preset under Platform · Integrations (only its address and credential are needed); it can then be enabled here.',
                      )
                    : t(
                        '请平台管理员在「平台 · 集成」里添加或重新启用它的门实例，之后这里就能启用。',
                        'Ask a platform administrator to add or re-enable a gate instance for it under Platform · Integrations; it can then be enabled here.',
                      )}
                </span>
              )
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function principalName(ref: ChangeVerificationWire['verifiedBy'], t: Translate): string {
  return principalShownName(ref.displayName, t) ?? shortId(ref.id);
}

/** One system as the run found it: its state and, when connected, each gate's health. One the
 *  platform offers is enabled from the pack's page (`packHref`). */
function RequirementCheck({
  requirement,
  packHref,
}: {
  readonly requirement: ChangeRequirementCheckWire;
  readonly packHref: string;
}) {
  const t = useT();
  const testId = `catalog-change-requirement-${requirement.connector}`;
  const hint = requirementHint(requirement.state, t);
  return (
    <div className="stack-s" data-testid={testId}>
      <span className="row-wrap">
        <span className="mono">{requirement.connector}</span>
        <StatusChip machine="packRequirement" status={requirement.state} size="s" />
        {requirement.state === 'connected' && !requirement.met ? (
          <span className="text-small">{t('但没有一个能连通', 'but none of them answers')}</span>
        ) : null}
      </span>
      {requirement.gates.map((gate) => (
        <span className="row-wrap text-small" key={gate.id}>
          <RouteLink href={hrefs.gatekeeper(gate.id)} testId={`${testId}-gate-${gate.id}`}>
            {gate.name}
          </RouteLink>
          <StatusChip machine="gateHealth" status={gate.health} size="s" />
        </span>
      ))}
      {hint ? (
        <span className="row-wrap text-3 text-small">
          <span>{hint}</span>
          {requirement.state === 'can_enable' ? (
            <RouteLink href={packHref} testId={`${testId}-link`}>
              {t('去能力包页启用', 'Enable it on the pack’s page')}
            </RouteLink>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}

/** The latest run: passed or not, who ran it and how, and what it found. */
function VerificationResult({
  segment,
  verification,
  itemSubject,
}: {
  readonly segment: ChangeSegmentWire;
  readonly verification: ChangeVerificationWire;
  readonly itemSubject: (ordinal: number) => string;
}) {
  const t = useT();
  const who = principalName(verification.verifiedBy, t);
  const notInEffect = verification.items.filter((item) => item.state !== 'in_effect');
  return (
    <div className="stack-s" data-testid="catalog-change-verification-result">
      <span className="row-wrap">
        <StatusChip
          machine="changeSegment"
          status={verification.passed ? 'verified' : 'verification_failed'}
          size="s"
          testId="catalog-change-verification-status"
        />
        <span className="text-small">
          {verification.trigger === 'system'
            ? t(
                `安装后自动核验（记在 ${who} 名下）`,
                `Verified after the install (recorded under ${who})`,
              )
            : t(`${who} 手动核验`, `Verified by ${who}`)}
          {' · '}
          <span data-volatile="">{formatDateTime(verification.verifiedAt)}</span>
        </span>
      </span>
      {notInEffect.length === 0 ? (
        <span className="text-3 text-small">
          {t('这次写入的改动项都还在生效。', 'Every change this install wrote is still in effect.')}
        </span>
      ) : (
        notInEffect.map((checked) => (
          <span
            className="row-wrap text-small"
            key={checked.ordinal}
            data-testid={`catalog-change-verification-item-${checked.ordinal}`}
          >
            <span>{itemSubject(checked.ordinal)}</span>
            <StatusChip machine="changeItemState" status={checked.state} size="s" />
          </span>
        ))
      )}
      {!verification.sourceFound ? (
        <Notice tone="warn" testId="catalog-change-verification-source-missing">
          {t(
            `这个部署里已经没有和记录一致的能力包 ${segment.source.name} v${segment.source.version}，不知道它要用到哪些系统，所以核验不能通过。`,
            `This deployment no longer ships pack ${segment.source.name} v${segment.source.version} as recorded, so the systems it needs are unknown and the verification cannot pass.`,
          )}
        </Notice>
      ) : verification.requirements.length === 0 ? (
        <span className="text-3 text-small">
          {t('这个能力包没有写明要用到的系统。', 'This pack names no systems it needs.')}
        </span>
      ) : (
        <div className="stack-s" data-testid="catalog-change-requirements">
          <span className="text-small">{t('要用到的系统：', 'Systems it needs:')}</span>
          {verification.requirements.map((requirement) => (
            <RequirementCheck
              key={requirement.connector}
              requirement={requirement}
              packHref={hrefs.catalog('packs', segment.source.name)}
            />
          ))}
        </div>
      )}
      {verification.dependencies.length > 0 ? (
        <div className="stack-s" data-testid="catalog-change-dependencies">
          <span className="text-small">{t('依赖的能力包：', 'Packs it builds on:')}</span>
          {verification.dependencies.map((dependency) => (
            <span
              className="row-wrap text-small"
              key={dependency.name}
              data-testid={`catalog-change-dependency-${dependency.name}`}
            >
              <RouteLink
                href={hrefs.catalog('packs', dependency.name)}
                testId={`catalog-change-dependency-${dependency.name}-link`}
              >
                <span className="mono">{dependency.name}</span>
              </RouteLink>
              <span>{minVersionText(dependency.minVersion, t)}</span>
              <span className={`chip chip-s ${dependency.met ? 'chip-ok' : 'chip-warn'}`}>
                {dependency.met ? t('已满足', 'Met') : t('不满足', 'Not met')}
              </span>
              <span className="text-3">
                {t(
                  `现在${dependencyNowText(dependency, t)}`,
                  `now ${dependencyNowText(dependency, t)}`,
                )}
              </span>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** Seconds until the record can be verified again, by this browser's clock (the kernel's decides). */
function cooldownLeft(verification: ChangeVerificationWire | null, now: number): number {
  if (verification === null) return 0;
  const until = Date.parse(verification.verifiedAt) + CHANGE_VERIFICATION_COOLDOWN_SECONDS * 1000;
  return Math.max(Math.ceil((until - now) / 1000), 0);
}

/** The later record a `change_segment_superseded` refusal names. */
function supersededBy(error: unknown): string | null {
  const id = error instanceof HttpError ? error.details?.supersededBy : undefined;
  return typeof id === 'string' ? id : null;
}

/** 安装记录 · 核验: the latest run, and the owner's 「再核验一次」. */
export function ChangeVerificationSection({
  http,
  segment,
  verification,
  itemSubject,
  onVerified,
}: {
  readonly http: CapabilityCaller;
  readonly segment: ChangeSegmentWire;
  readonly verification: ChangeVerificationWire | null;
  /** 「Skill docker-triage」 — the record's change with this ordinal. */
  readonly itemSubject: (ordinal: number) => string;
  readonly onVerified: (result: ChangeVerificationResultWire) => void;
}) {
  const t = useT();
  const can = useRoleCan(http);
  const permissions = usePermissions();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const left = cooldownLeft(verification, now);
  // Legacy 424: the button turns busy and then cools down, so the focus would fall to the page —
  // it moves to the result instead, which is what changed.
  const resultRef = useRef<HTMLDivElement>(null);
  const cooldownId = useId();
  const [focusResult, setFocusResult] = useState(false);
  useEffect(() => {
    if (!focusResult) return;
    resultRef.current?.focus();
    setFocusResult(false);
  }, [focusResult]);

  // Ticks only while the cooldown runs, so the button comes back on its own.
  useEffect(() => {
    if (left === 0) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [left]);

  async function verify(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const result = await http.call<ChangeVerificationResultWire>('verify_change_segment', {
        segmentId: segment.id,
      });
      permissions.markAllowed('verify_change_segment');
      setNow(Date.now());
      onVerified(result);
      setFocusResult(true);
    } catch (err) {
      if (isForbiddenError(err)) permissions.markDenied('verify_change_segment');
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const later = supersededBy(error);
  const canVerify = segment.status !== 'rolled_back' && can('verify_change_segment') !== false;
  return (
    <div className="stack-s" data-testid="catalog-change-verification">
      <span className="section-title">{t('核验', 'Verification')}</span>
      <p className="text-3 text-small">
        {t(
          '核验会检查这次安装写入的内容是否还在生效，以及能力包要用到的系统是否已接入、能连通。它只问系统是否在线，不会执行任何操作。',
          'Verification checks that what this install wrote is still in effect, and that the systems the pack needs are connected and answering. It only asks whether each system is up; it runs nothing.',
        )}
      </p>
      {/* The cooldown describes the result the focus lands on — not a live region, which would
       *  read every second of the countdown out. */}
      <div
        ref={resultRef}
        tabIndex={-1}
        aria-describedby={left > 0 && canVerify ? cooldownId : undefined}
        data-testid="catalog-change-verification-outcome"
      >
        {verification === null ? (
          <span className="text-small" data-testid="catalog-change-verification-none">
            {t('还没有核验过。', 'Not verified yet.')}
          </span>
        ) : (
          <VerificationResult
            segment={segment}
            verification={verification}
            itemSubject={itemSubject}
          />
        )}
      </div>
      {canVerify ? (
        <span className="row-wrap">
          {/* ux-lint-allow-disabled: running, or the cooldown hint beside it says when it comes back. */}
          <Button
            variant="secondary"
            aria-busy={busy || undefined}
            disabled={busy || left > 0}
            onClick={() => void verify()}
            data-testid="catalog-change-verify"
          >
            {verification === null ? t('核验', 'Verify') : t('再核验一次', 'Verify again')}
          </Button>
          {left > 0 ? (
            <span
              id={cooldownId}
              className="text-3 text-small"
              data-testid="catalog-change-verify-cooldown"
            >
              {t(`刚核验过，${left} 秒后可以再核验。`, `Verified just now; again in ${left} s.`)}
            </span>
          ) : null}
        </span>
      ) : null}
      {error !== null ? (
        <ErrorBanner
          error={error}
          title={t('核验没有完成', 'Could not verify')}
          overrides={{
            change_verification_cooldown: t(
              '刚核验过，稍等一会儿再核验。',
              'It was verified moments ago; try again shortly.',
            ),
            change_segment_superseded: t(
              '同一个能力包之后又安装过一次，现在生效的是那条安装记录；请核验那一条。',
              'The same pack was installed again since; the later install record is the one in effect, so verify that one.',
            ),
          }}
          testId="catalog-change-verify-error"
        />
      ) : null}
      {later ? (
        <RouteLink href={hrefs.catalog('changes', later)} testId="catalog-change-verify-later">
          {t('查看那条安装记录', 'Open that install record')}
        </RouteLink>
      ) : null}
    </div>
  );
}
