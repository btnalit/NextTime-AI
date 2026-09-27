import type { ConflictWire, FactWire } from '@nexttime/shared';
import { useId, useState } from 'react';
import type { CapabilityCaller } from '../../lib/clients.js';
import { formatDateTime, formatRelative } from '../../lib/format.js';
import { freshnessOf } from '../../lib/graph-freshness.js';
import { type FactDirection, factDirection, neighbourId } from '../../lib/graph-view.js';
import { useT } from '../../lib/i18n.js';
import { Confirm } from '../kit/confirm.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../kit/dropdown-menu.js';
import { Field, describedBy } from '../kit/field.js';
import { Textarea } from '../kit/textarea.js';
import { Button } from '../ui/Button.js';
import { RefChip } from '../ui/RefChip.js';
// `useToast` stays on `components/ui/Toast` — `App.tsx` mounts that provider (CatalogPage's note).
import { useToast } from '../ui/Toast.js';
import { AttestFactDialog } from './AttestFactDialog.js';
import { FreshnessChip } from './FreshnessChip.js';
import { useGraphObjects, useResolvedObjects } from './GraphObjectsContext.js';
import { SupersedeFactDialog } from './SupersedeFactDialog.js';

export interface FactRowProps {
  readonly fact: FactWire;
  /** The focused Object — decides which end is "the neighbour". */
  readonly objectId: string;
  readonly asOf: number;
  /** Open Conflicts this Fact is a side of (`lib/graph-view.ts` `conflictsByFactId`). */
  readonly conflicts?: readonly ConflictWire[];
  /** "展开 Expand": focus the neighbour (its own neighbours load; the trail grows). */
  readonly onExpand: (neighbourObjectId: string) => void;
  /** "溯源 Provenance": open the drawer with `explain{nodeId: fact.id}`. */
  readonly onProvenance: (fact: FactWire) => void;
  /** S8 W4-A (ui-audit epistemic gap "verify_fact"): present only when the row can offer its
   *  write actions (验证 Verify, and the 更多 menu: 附人工确认 / 取代 / 作废) — omitted (e.g. a
   *  read-only rendering, a test fixture) simply hides them, same degrade as `onExpand`'s own
   *  self-loop check above. */
  readonly http?: CapabilityCaller;
  /** Called after a write that changes the Fact row itself (`verify_fact`, `supersede_fact`,
   *  `invalidate_fact`) — the caller re-reads `state_at` so the Object's Facts reflect it without
   *  a full page reload. An attestation changes no Fact field and does not call it. */
  readonly onFactChanged?: () => void;
}

const DIRECTION_GLYPH: Readonly<Record<FactDirection, string>> = {
  out: '→',
  in: '←',
  self: '↺',
};

const DIRECTION_LABEL: Readonly<
  Record<FactDirection, { readonly zh: string; readonly en: string }>
> = {
  out: { zh: '出', en: 'outgoing' },
  in: { zh: '入', en: 'incoming' },
  self: { zh: '自', en: 'self' },
};

/**
 * components/graph/FactRow: one Fact (Link) touching the focused Object — direction glyph,
 * the neighbour as a `RefChip` (name from the page's Object cache, bare while unresolved),
 * `epistemicStatus`, `confidence`, validity, freshness (`lib/graph-freshness.ts`, judged as of
 * the page's frozen instant) and the open-Conflict mark, with the two row actions as real
 * buttons (§5.9 principle 6: every row action has a keyboard path — nothing here is a click-only
 * `<li>`). The Fact's own id is copyable through its chip so "溯源" can be cross-checked on the
 * audit page.
 */
export function FactRow({
  fact,
  objectId,
  asOf,
  conflicts,
  onExpand,
  onProvenance,
  http,
  onFactChanged,
}: FactRowProps) {
  const t = useT();
  const toast = useToast();
  const { nameOf, hrefFor } = useGraphObjects();
  const direction = factDirection(fact, objectId);
  const otherId = neighbourId(fact, objectId);
  // Only a rendered row asks for its neighbour's name — collapsed groups cost nothing.
  useResolvedObjects(otherId === objectId ? [] : [otherId]);
  const inConflict = conflicts !== undefined && conflicts.length > 0;
  const [verifyOpen, setVerifyOpen] = useState(false);
  // STATUS leftover 89 + coverage gap G2: the 更多 menu's three writes — each its own surface.
  const [attestOpen, setAttestOpen] = useState(false);
  const [supersedeOpen, setSupersedeOpen] = useState(false);
  const [invalidateOpen, setInvalidateOpen] = useState(false);
  const [invalidateReason, setInvalidateReason] = useState('');
  const reasonId = useId();
  // Only an active Fact can be attested, superseded or invalidated (the kernel refuses the rest:
  // `attest_fact`'s FactNotActiveError, the Fact lifecycle table for the other two).
  const isActive = fact.supersededAt === null && fact.invalidatedAt === null;
  const canChange = http !== undefined && isActive;
  const neighbourLabel =
    otherId === objectId ? t('自身', 'self') : (nameOf(otherId) ?? otherId.slice(0, 8));
  // How a person reads this Fact in a dialog: the relation, then the Object on the other end.
  const factLabel = `${fact.linkType} ${DIRECTION_GLYPH[direction]} ${neighbourLabel}`;
  // "验证 Verify" is offered only for an active, not-yet-verified Fact (I3.6's own `verify_fact`
  // check — no Evidence on file — is discovered at confirm time via the 409 the call returns, not
  // pre-checked here: this console has no read for "does this Fact have Evidence" cheaper than
  // just trying the write, and every other write-gap in this app degrades the same way, through
  // the confirm's own inline error rather than a second round trip first).
  const canVerify = canChange && fact.epistemicStatus !== 'verified';
  const freshness = freshnessOf(
    {
      lastObservedAt: fact.lastObservedAt,
      supersededAt: fact.supersededAt,
      invalidatedAt: fact.invalidatedAt,
      invalidationReason: fact.invalidationReason,
      epistemicStatus: fact.epistemicStatus,
      inConflict,
    },
    asOf,
  );
  const observedRelative = formatRelative(fact.lastObservedAt, asOf);
  const recordedRelative = formatRelative(fact.recordedAt, asOf);
  const clock = fact.lastObservedAt
    ? t(`观测 ${observedRelative}`, `Observed ${observedRelative}`)
    : t(`记录 ${recordedRelative}`, `Recorded ${recordedRelative}`);
  const validFrom = formatDateTime(fact.validFrom);
  const validity =
    fact.validUntil === null
      ? t(`自 ${validFrom}`, `from ${validFrom}`)
      : `${validFrom} – ${formatDateTime(fact.validUntil)}`;

  return (
    <li
      className="data-row graph-fact-row"
      data-testid="graph-fact-row"
      data-fact-id={fact.id}
      data-direction={direction}
      data-freshness={freshness.kind}
    >
      <div
        className="data-row-leading graph-fact-direction"
        title={t(DIRECTION_LABEL[direction].zh, DIRECTION_LABEL[direction].en)}
      >
        <span aria-hidden>{DIRECTION_GLYPH[direction]}</span>
        <span className="visually-hidden">
          {t(DIRECTION_LABEL[direction].zh, DIRECTION_LABEL[direction].en)}
        </span>
      </div>
      <div className="data-row-main">
        <div className="data-row-title row-wrap">
          <RefChip
            kind="object"
            id={otherId}
            name={otherId === objectId ? `（${t('自身', 'self')}）` : nameOf(otherId)}
            href={otherId === objectId ? undefined : hrefFor(otherId)}
            size="s"
            testId="graph-fact-neighbour"
          />
          <FreshnessChip freshness={freshness} size="s" testId="graph-fact-freshness" />
          {inConflict ? (
            <span className="chip chip-danger chip-s" data-testid="graph-fact-conflict">
              {t('冲突', 'Conflict')} ×{conflicts?.length}
            </span>
          ) : null}
        </div>
        <div className="data-row-meta">
          <span className="tag mono" title={t('认知状态', 'Epistemic status')}>
            {fact.epistemicStatus}
          </span>
          {fact.confidence !== null ? (
            <span className="meta-sep" title={t('置信度', 'Confidence')}>
              置信 {fact.confidence.toFixed(2)}
            </span>
          ) : null}
          <span className="meta-sep" title={t('有效期', 'Validity')}>
            {validity}
          </span>
          <span className="meta-sep" title={formatDateTime(fact.lastObservedAt ?? fact.recordedAt)}>
            {clock}
          </span>
          <span className="meta-sep">
            <RefChip kind="object" id={fact.id} name="Fact" size="s" />
          </span>
        </div>
      </div>
      <div className="data-row-trailing">
        <Button
          variant="ghost"
          size="s"
          icon="search"
          onClick={() => onProvenance(fact)}
          data-testid="graph-fact-provenance"
        >
          {t('溯源', 'Provenance')}
        </Button>
        {otherId === objectId ? null : (
          <Button
            variant="ghost"
            size="s"
            icon="chevron-right"
            onClick={() => onExpand(otherId)}
            data-testid="graph-fact-expand"
          >
            {t('展开', 'Expand')}
          </Button>
        )}
        {canVerify ? (
          <Confirm
            tier="medium"
            open={verifyOpen}
            onOpenChange={setVerifyOpen}
            anchor={
              <Button
                variant="ghost"
                size="s"
                icon="check"
                onClick={() => setVerifyOpen(true)}
                data-testid="graph-fact-verify"
              >
                {t('验证', 'Verify')}
              </Button>
            }
            title={t('把该事实标记为已验证', 'Mark this Fact as verified')}
            description={t(
              '把认知状态提升为“已验证”——需要该事实已经附有证据（机器证据，或「更多 → 附人工确认」），否则会被拒绝。此操作会写入审计。',
              'Promotes the epistemic status to “verified” — the Fact must already have Evidence on file (machine evidence, or More → Add a human attestation), or the call is refused. Recorded in the audit log.',
            )}
            confirmLabel={t('验证', 'Verify')}
            onConfirm={async () => {
              await (http as CapabilityCaller).call('verify_fact', { factId: fact.id });
              onFactChanged?.();
            }}
            testId="graph-fact-verify-confirm"
          />
        ) : null}
        {canChange ? (
          <Confirm
            tier="medium"
            danger
            open={invalidateOpen}
            onOpenChange={(open) => {
              setInvalidateOpen(open);
              if (!open) setInvalidateReason('');
            }}
            anchor={
              // `modal={false}`: the menu hands off to a dialog / popover on select — a modal menu
              // would keep its outside-pointer lock while the next surface opens.
              <DropdownMenu modal={false}>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="s"
                    icon="more"
                    iconOnly
                    aria-label={t('更多操作', 'More actions')}
                    data-testid="graph-fact-menu"
                  />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    data-testid="graph-fact-attest"
                    onSelect={() => setAttestOpen(true)}
                  >
                    {t('附人工确认', 'Add a human attestation')}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    data-testid="graph-fact-supersede"
                    onSelect={() => setSupersedeOpen(true)}
                  >
                    {t('取代…', 'Supersede…')}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    className="text-danger"
                    data-testid="graph-fact-invalidate"
                    onSelect={() => setInvalidateOpen(true)}
                  >
                    {t('作废…', 'Invalidate…')}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            }
            title={t('作废该事实', 'Invalidate this Fact')}
            target={factLabel}
            impact={[
              t(
                '该事实标记为失效，不再出现在当前图谱中（按时间点仍可回看）',
                'The Fact is marked invalid and leaves the current graph (still visible as of an earlier time)',
              ),
              t(
                '不能撤回：之后只能由新的断言或观测重新写入',
                'Cannot be undone — only a new assertion or observation can bring it back',
              ),
              t(
                '原因记为它的失效原因，并写入审计',
                'The reason is kept as its invalidation reason and recorded in the audit log',
              ),
            ]}
            confirmLabel={t('作废', 'Invalidate')}
            confirmDisabled={invalidateReason.trim() === ''}
            onConfirm={async () => {
              await (http as CapabilityCaller).call('invalidate_fact', {
                factId: fact.id,
                reason: invalidateReason.trim(),
              });
              toast.push({ tone: 'ok', title: t('已作废', 'Invalidated'), description: factLabel });
              onFactChanged?.();
            }}
            testId="graph-fact-invalidate-confirm"
          >
            <Field id={reasonId} label={t('原因', 'Reason')} required>
              <Textarea
                id={reasonId}
                aria-label={t('原因', 'Reason')}
                value={invalidateReason}
                onChange={(event) => setInvalidateReason(event.target.value)}
                minRows={2}
                maxRows={5}
                aria-required
                aria-describedby={describedBy(reasonId, false, false)}
                data-testid="graph-fact-invalidate-reason"
              />
            </Field>
          </Confirm>
        ) : null}
      </div>
      {http !== undefined ? (
        <>
          <AttestFactDialog
            http={http}
            fact={attestOpen ? fact : null}
            factLabel={factLabel}
            onClose={() => setAttestOpen(false)}
            onAttested={() =>
              toast.push({
                tone: 'ok',
                title: t('已附人工确认', 'Human attestation recorded'),
                description:
                  fact.epistemicStatus === 'verified'
                    ? factLabel
                    : t('现在可以「验证」该事实。', 'The Fact can now be verified.'),
              })
            }
          />
          <SupersedeFactDialog
            http={http}
            fact={supersedeOpen ? fact : null}
            factLabel={factLabel}
            onClose={() => setSupersedeOpen(false)}
            onSuperseded={() => {
              toast.push({ tone: 'ok', title: t('已取代', 'Superseded'), description: factLabel });
              onFactChanged?.();
            }}
          />
        </>
      ) : null}
    </li>
  );
}
