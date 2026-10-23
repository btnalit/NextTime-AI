import {
  CHANGE_VERIFICATION_COOLDOWN_SECONDS,
  type ChangeRequirementCheckWire,
  type ChangeSegmentWire,
  type ChangeVerificationResultWire,
  type ChangeVerificationWire,
  type PackRequirementState,
  type PackRequirementWire,
} from '@nexttime/shared';
import { type ReactNode, useEffect, useState } from 'react';
import { usePermissions } from '../../hooks/usePermissions.js';
import { useRoleCan } from '../../hooks/useRoleCan.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { isForbiddenError } from '../../lib/errors.js';
import { formatDateTime, shortId } from '../../lib/format.js';
import { HttpError } from '../../lib/http-client.js';
import { type Translate, useT } from '../../lib/i18n.js';
import { hrefs } from '../../lib/router.js';
import { Button } from '../kit/button.js';
import { ErrorBanner } from '../kit/error-banner.js';
import { Notice } from '../kit/notice.js';
import { RouteLink } from '../kit/route-link.js';
import { StatusChip } from '../kit/status-chip.js';

/**
 * components/catalog/ChangeVerification (S11 P1-E): the systems a pack needs and where each stands
 * in the workspace (`PackRequirementWire`: the 能力包 detail and install review), and an install
 * record's 核验 — the latest run (`ChangeVerificationWire`: are the changes still in effect, are
 * the systems connected and up) and, for the owner, running it again (`verify_change_segment`, at
 * most once every `CHANGE_VERIFICATION_COOLDOWN_SECONDS`).
 */

/** What the owner does about a system in `state`, or `null` when nothing is needed. */
export function requirementHint(state: PackRequirementState, t: Translate): string | null {
  switch (state) {
    case 'connected':
      return null;
    case 'can_enable':
      return t(
        '平台已经提供，工作区还没启用：所有者可以在「系统与授权」里启用。',
        'The platform offers it and the workspace has not enabled it: an owner can enable it under Systems.',
      );
    case 'can_connect':
      return t(
        '工作区还没接入：所有者可以在「系统与授权」里自行接入。',
        'The workspace has not connected it: an owner can connect it under Systems.',
      );
    case 'needs_platform':
      return t(
        '这个部署还没有提供它，需要平台管理员先接入。',
        'This deployment does not offer it yet; a platform administrator connects it first.',
      );
  }
}

/** The 「系统与授权」 link a hint points to, for the states an owner can act on themselves. */
function hintLink(state: PackRequirementState, t: Translate, testId: string): ReactNode {
  return state === 'can_enable' || state === 'can_connect' ? (
    <RouteLink href={hrefs.systems()} testId={testId}>
      {t('去「系统与授权」', 'Open Systems')}
    </RouteLink>
  ) : null;
}

/** The systems a pack needs, each with where it stands (the 能力包 detail and install review). */
export function PackRequirementList({
  requirements,
  testId,
}: {
  readonly requirements: readonly PackRequirementWire[];
  readonly testId: string;
}) {
  const t = useT();
  return (
    <div className="stack-s" data-testid={testId}>
      {requirements.map((requirement) => {
        const hint = requirementHint(requirement.state, t);
        return (
          <div
            className="stack-s"
            key={requirement.connector}
            data-testid={`${testId}-${requirement.connector}`}
          >
            <span className="row-wrap">
              <span className="mono">{requirement.connector}</span>
              <StatusChip machine="packRequirement" status={requirement.state} size="s" />
            </span>
            {hint ? (
              <span className="row-wrap text-3 text-small">
                <span>{hint}</span>
                {hintLink(requirement.state, t, `${testId}-${requirement.connector}-link`)}
              </span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function principalName(ref: ChangeVerificationWire['verifiedBy']): string {
  return ref.displayName ?? shortId(ref.id);
}

/** One system as the run found it: its state and, when connected, each gate's health. */
function RequirementCheck({ requirement }: { readonly requirement: ChangeRequirementCheckWire }) {
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
          {hintLink(requirement.state, t, `${testId}-link`)}
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
  const who = principalName(verification.verifiedBy);
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
            <RequirementCheck key={requirement.connector} requirement={requirement} />
          ))}
        </div>
      )}
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
            <span className="text-3 text-small" data-testid="catalog-change-verify-cooldown">
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
