import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { Button } from './Button.js';
import { Drawer } from './Drawer.js';
import { ErrorBanner } from './ErrorBanner.js';
import { Field, Input } from './Field.js';
import { useToast } from './Toast.js';

/** §5.9 principle 4 — confirmation by impact: low · reversible → do it, toast with undo;
 *  medium · reversible → inline card, one click; high · reversible → dialog listing the impact;
 *  irreversible → retype the target name + acknowledge, danger button disabled until both. */
export type ConfirmTierLevel = 'low' | 'medium' | 'high' | 'irreversible';

export interface ConfirmTierProps {
  readonly tier: ConfirmTierLevel;
  /** Controlled: the caller flips this on when the user asks for the action. For `low` the
   *  action runs the moment it opens. */
  readonly open: boolean;
  readonly title: string;
  readonly description?: ReactNode;
  /** The target's display name — listed in every tier; retyped for `irreversible`. */
  readonly target?: string;
  /** high / irreversible: what the action reaches (blast radius from the graph), one line each. */
  readonly impact?: readonly string[];
  readonly confirmLabel?: string;
  readonly cancelLabel?: string;
  /** Destructive styling on the confirm button (`irreversible` is always destructive). */
  readonly danger?: boolean;
  /** May be async — the confirm button shows a spinner; a thrown error is rendered inline and
   *  the confirm stays open. */
  readonly onConfirm: () => void | Promise<void>;
  /** Cancel, Escape, overlay click — and after a successful confirm. */
  readonly onClose: () => void;
  /** `low` only: the toast's undo action. */
  readonly undo?: { readonly label?: string; readonly onUndo: () => void | Promise<void> };
  /** Extra body content (parameters, an on-behalf-of RefChip, …). */
  readonly children?: ReactNode;
  readonly testId?: string;
}

const DEFAULT_CONFIRM = '确认 Confirm';
const DEFAULT_CANCEL = '取消 Cancel';

/**
 * components/ui/ConfirmTier (S6-A0, docs/console-completion-plan.md §5.9 "ConfirmTier"): the one
 * implementation of tiered confirmation, replacing the two-step confirms scattered per page.
 * Used the same way for ActionRequest approval, workspace / user purge, Handle revocation and
 * provider-key overwrite — the caller picks the tier from the action's blast radius.
 *
 * - `low`: executes immediately when opened, then a toast with "撤销 Undo" (when `undo` is
 *   given). No UI of its own.
 * - `medium`: an inline confirm card rendered in place (no overlay); focus moves to the confirm
 *   button, Escape cancels.
 * - `high` / `irreversible`: the existing `Drawer` (§5.8 "一律复用抽屉两步确认") — it already owns
 *   the focus trap, Escape and focus return. `irreversible` adds "type the target name" and an
 *   acknowledgement checkbox; the danger button stays disabled until both hold.
 */
export function ConfirmTier(props: ConfirmTierProps) {
  const { tier, open } = props;
  if (tier === 'low') return <LowTier {...props} />;
  if (!open) return null;
  if (tier === 'medium') return <MediumTier {...props} />;
  return <DrawerTier {...props} />;
}

/** Runs the action + undo toast; keeps the latest callbacks in refs so a re-render with a fresh
 *  closure never re-fires the effect (which keys on `open` alone). */
function LowTier({ open, title, onConfirm, onClose, undo }: ConfirmTierProps) {
  const toast = useToast();
  const latest = useRef({ onConfirm, onClose, undo, title, toast });
  latest.current = { onConfirm, onClose, undo, title, toast };
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      const { onConfirm, onClose, undo, title, toast } = latest.current;
      try {
        await onConfirm();
        if (cancelled) return;
        toast.push({
          tone: 'ok',
          title,
          key: `confirm-low:${title}`,
          action: undo
            ? { label: undo.label ?? '撤销 Undo', onClick: () => void undo.onUndo() }
            : undefined,
        });
      } catch (error) {
        if (cancelled) return;
        toast.push({
          tone: 'danger',
          title: `${title} — 失败 failed`,
          description: error instanceof Error ? error.message : String(error),
          key: `confirm-low:${title}`,
        });
      }
      onClose();
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);
  return null;
}

/** Shared confirm-button state machine for the medium / high / irreversible tiers. */
function useConfirmRun(onConfirm: () => void | Promise<void>, onClose: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function run(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, run };
}

function TargetLine({ target }: { readonly target: string | undefined }) {
  if (target === undefined) return null;
  return (
    <dl className="definition-list">
      <dt>目标 Target</dt>
      <dd>
        <strong data-testid="confirm-target">{target}</strong>
      </dd>
    </dl>
  );
}

function ImpactList({ impact }: { readonly impact: readonly string[] | undefined }) {
  if (impact === undefined || impact.length === 0) return null;
  return (
    <div className="stack-s">
      <span className="section-title">影响范围 Impact</span>
      <ul className="confirm-impact" data-testid="confirm-impact">
        {impact.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </div>
  );
}

function MediumTier({
  title,
  description,
  target,
  impact,
  confirmLabel = DEFAULT_CONFIRM,
  cancelLabel = DEFAULT_CANCEL,
  danger = false,
  onConfirm,
  onClose,
  children,
  testId,
}: ConfirmTierProps) {
  const { busy, error, run } = useConfirmRun(onConfirm, onClose);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  useEffect(() => {
    confirmRef.current?.focus();
  }, []);
  return (
    <section
      className={`confirm-card${danger ? ' confirm-card-danger' : ''}`}
      aria-labelledby={titleId}
      data-testid={testId}
      data-tier="medium"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !busy) {
          event.preventDefault();
          onClose();
        }
      }}
    >
      <div className="confirm-card-title" id={titleId}>
        {title}
      </div>
      {description !== undefined ? <div className="text-2 text-small">{description}</div> : null}
      <TargetLine target={target} />
      <ImpactList impact={impact} />
      {children}
      {error !== null ? <ErrorBanner error={error} testId="confirm-error" /> : null}
      <div className="confirm-card-actions">
        <Button
          ref={confirmRef}
          variant={danger ? 'danger' : 'primary'}
          loading={busy}
          onClick={() => void run()}
          data-testid="confirm-button"
        >
          {confirmLabel}
        </Button>
        <Button variant="ghost" onClick={onClose} disabled={busy} data-testid="confirm-cancel">
          {cancelLabel}
        </Button>
      </div>
    </section>
  );
}

function DrawerTier({
  tier,
  open,
  title,
  description,
  target,
  impact,
  confirmLabel = DEFAULT_CONFIRM,
  cancelLabel = DEFAULT_CANCEL,
  danger,
  onConfirm,
  onClose,
  children,
  testId,
}: ConfirmTierProps) {
  const irreversible = tier === 'irreversible';
  const destructive = irreversible || danger === true;
  const { busy, error, run } = useConfirmRun(onConfirm, onClose);
  const [typed, setTyped] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const typedId = useId();
  const nameMatches = target === undefined ? true : typed.trim() === target;
  const ready = !irreversible || (nameMatches && acknowledged);
  return (
    <Drawer
      open={open}
      title={title}
      subtitle={
        irreversible
          ? '不可逆 Irreversible — 请键入目标名称并确认知情'
          : '高影响 High impact — 请核对影响范围'
      }
      onClose={busy ? () => undefined : onClose}
      testId={testId}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy} data-testid="confirm-cancel">
            {cancelLabel}
          </Button>
          <Button
            variant={destructive ? 'danger' : 'primary'}
            loading={busy}
            disabled={!ready}
            onClick={() => void run()}
            data-testid="confirm-button"
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="stack" data-tier={tier}>
        {description !== undefined ? <div className="text-2">{description}</div> : null}
        <TargetLine target={target} />
        <ImpactList impact={impact} />
        {children}
        {irreversible ? (
          <>
            {target !== undefined ? (
              <Field
                id={typedId}
                label={`键入 "${target}" 以确认 Type the target name to confirm`}
                required
              >
                <Input
                  id={typedId}
                  value={typed}
                  onChange={(event) => setTyped(event.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  data-testid="confirm-typed-name"
                />
              </Field>
            ) : null}
            <label className="checkbox">
              <input
                type="checkbox"
                checked={acknowledged}
                onChange={(event) => setAcknowledged(event.target.checked)}
                data-testid="confirm-acknowledge"
              />
              <span>
                我知道此操作不可逆，且会写入平台审计。 I understand this cannot be undone and is
                recorded in the platform audit.
              </span>
            </label>
          </>
        ) : null}
        {error !== null ? <ErrorBanner error={error} testId="confirm-error" /> : null}
      </div>
    </Drawer>
  );
}
