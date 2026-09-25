import type { ConflictWire } from '@nexttime/shared';
import { useId, useState } from 'react';
import type { CapabilityCaller } from '../../lib/clients.js';
import { formatDateTime, formatRelative } from '../../lib/format.js';
import { useT } from '../../lib/i18n.js';
import { Button } from '../kit/button.js';
import { Confirm } from '../kit/confirm.js';
import { RefChip } from '../kit/ref-chip.js';
import { Select } from '../kit/select.js';

export interface ConflictsPanelProps {
  readonly http: CapabilityCaller;
  readonly conflicts: readonly ConflictWire[];
  readonly loading: boolean;
  /** Re-reads `list_conflicts` — called after a successful `resolve_conflict` so a resolved row
   *  leaves this list (it filtered on `status:'open'`) without a full page reload. */
  readonly onResolved: () => void;
}

type Resolution = 'keep_a' | 'keep_b' | 'invalidate_both';

const RESOLUTION_LABEL: Readonly<Record<Resolution, { readonly zh: string; readonly en: string }>> =
  {
    keep_a: { zh: '保留 Fact A（使 B 失效）', en: 'Keep Fact A (invalidate B)' },
    keep_b: { zh: '保留 Fact B（使 A 失效）', en: 'Keep Fact B (invalidate A)' },
    invalidate_both: { zh: '两者都失效', en: 'Invalidate both' },
  };

/**
 * components/graph/ConflictsPanel (S8 W4-A, ui-audit epistemic gap "resolve_conflict" — an open
 * Conflict could be *seen* on the graph page (the Fact row's own danger chip, `FactRow.tsx`) but
 * never *acted on* anywhere in the console; `open → resolved` had no UI entry, `resolve_conflict`
 * only ever ran from a script). Lists every open Conflict this session already has loaded
 * (`GraphPage`'s own `list_conflicts{status:'open'}`, reused rather than fetched a second time),
 * each with a "解决 Resolve" medium-tier confirm (§5.9 principle 4: reversible in the sense that a
 * later re-observation can still supersede the invalidated side, but not undoable from this UI, so
 * medium — not `low` — is the right tier) collecting the three-way choice `resolveConflictHandler`
 * accepts and a required reason, both written into the audit row and the Decision it also records.
 */
export function ConflictsPanel({ http, conflicts, loading, onResolved }: ConflictsPanelProps) {
  const t = useT();
  return (
    <details className="disclosure graph-conflicts-panel" data-testid="graph-conflicts-panel">
      <summary>
        {t('冲突', 'Conflicts')}{' '}
        <span className="text-3 text-small" data-testid="graph-conflicts-count">
          ({loading ? '…' : conflicts.length})
        </span>
      </summary>
      <div className="disclosure-body">
        {conflicts.length === 0 && !loading ? (
          <p className="text-3 text-small" data-testid="graph-conflicts-empty">
            {t('没有未解决的冲突。', 'No open Conflicts.')}
          </p>
        ) : (
          <ul className="stack-s" data-testid="graph-conflicts-list">
            {conflicts.map((conflict) => (
              <ConflictRow
                key={conflict.id}
                http={http}
                conflict={conflict}
                onResolved={onResolved}
              />
            ))}
          </ul>
        )}
      </div>
    </details>
  );
}

function ConflictRow({
  http,
  conflict,
  onResolved,
}: {
  readonly http: CapabilityCaller;
  readonly conflict: ConflictWire;
  readonly onResolved: () => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [resolution, setResolution] = useState<Resolution>('keep_a');
  const [reason, setReason] = useState('');
  const resolutionId = useId();
  const reasonId = useId();

  return (
    <li className="data-row" data-testid="graph-conflict-row" data-conflict-id={conflict.id}>
      <div className="data-row-main">
        <div className="data-row-title row-wrap">
          <span className="tag mono">{conflict.conflictType}</span>
          <RefChip kind="object" id={conflict.factAId} name="Fact A" size="s" />
          <RefChip kind="object" id={conflict.factBId} name="Fact B" size="s" />
        </div>
        <div className="data-row-meta">
          {conflict.description ? <span>{conflict.description}</span> : null}
          <span className="meta-sep" title={formatDateTime(conflict.openedAt)}>
            {t('发生于', 'Opened')} {formatRelative(conflict.openedAt)}
          </span>
        </div>
      </div>
      <div className="data-row-trailing">
        <Confirm
          tier="medium"
          open={open}
          onOpenChange={(next) => {
            setOpen(next);
            if (!next) {
              setResolution('keep_a');
              setReason('');
            }
          }}
          anchor={
            <Button
              variant="ghost"
              size="s"
              onClick={() => setOpen(true)}
              data-testid="graph-conflict-resolve"
            >
              {t('解决', 'Resolve')}
            </Button>
          }
          title={t('解决这个冲突', 'Resolve this Conflict')}
          description={t(
            '选择保留哪一侧（另一侧失效），或让两侧都失效；这个选择与理由会写入审计与一条 Decision。',
            'Choose which side to keep (the other is invalidated), or invalidate both; the choice and reason are recorded in the audit log and a Decision.',
          )}
          confirmLabel={t('解决', 'Resolve')}
          onConfirm={async () => {
            const trimmedReason = reason.trim();
            if (trimmedReason === '') {
              throw new Error(t('请填写理由。', 'A reason is required.'));
            }
            await http.call('resolve_conflict', {
              conflictId: conflict.id,
              resolution,
              reason: trimmedReason,
            });
            onResolved();
          }}
          testId="graph-conflict-resolve-confirm"
        >
          <Select
            id={resolutionId}
            label={t('处理方式', 'Resolution')}
            value={resolution}
            onChange={(event) => setResolution(event.target.value as Resolution)}
          >
            {(Object.keys(RESOLUTION_LABEL) as Resolution[]).map((value) => (
              <option key={value} value={value}>
                {t(RESOLUTION_LABEL[value].zh, RESOLUTION_LABEL[value].en)}
              </option>
            ))}
          </Select>
          <div className="field">
            <label className="field-label" htmlFor={reasonId}>
              {t('理由', 'Reason')}
              <span className="field-required" aria-hidden>
                *
              </span>
            </label>
            <textarea
              id={reasonId}
              className="textarea"
              rows={2}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              data-testid="graph-conflict-reason"
            />
          </div>
        </Confirm>
      </div>
    </li>
  );
}
