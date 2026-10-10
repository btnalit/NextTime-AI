import type { FactWire } from '@nexttime/shared';
import { useEffect, useId, useState } from 'react';
import type { CapabilityCaller } from '../../lib/clients.js';
import { useT } from '../../lib/i18n.js';
import { Button } from '../kit/button.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../kit/dialog.js';
import { Field, describedBy } from '../kit/field.js';
import { InlineError } from '../kit/inline-error.js';
import { Notice } from '../kit/notice.js';
import { Textarea } from '../kit/textarea.js';

export interface SupersedeFactDialogProps {
  readonly http: CapabilityCaller;
  /** The Fact being superseded; `null` keeps the dialog closed. */
  readonly fact: FactWire | null;
  /** How the row names this Fact to a person (link type → neighbour), shown under the title. */
  readonly factLabel: string;
  readonly onClose: () => void;
  /** After a successful `supersede_fact` — the owner toasts and re-reads the Object's Facts. */
  readonly onSuperseded: (replacement: FactWire) => void;
}

type JsonRecord = Readonly<Record<string, unknown>>;

/** Key-order-independent JSON, so `{a,b}` and `{b,a}` compare equal. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export type ParsedValue =
  | { readonly ok: true; readonly value: JsonRecord }
  | { readonly ok: false; readonly reason: 'json' | 'object' };

/** The new value must be a JSON object — a Fact's `properties` (the kernel stores exactly that). */
export function parseFactValue(text: string): ParsedValue {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'json' };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'object' };
  }
  return { ok: true, value: parsed as JsonRecord };
}

export interface ValueChange {
  readonly key: string;
  readonly kind: 'added' | 'removed' | 'changed';
  readonly before?: string;
  readonly after?: string;
}

/** Top-level differences between the current and the new value, sorted by key. */
export function valueChanges(before: JsonRecord, after: JsonRecord): readonly ValueChange[] {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  const changes: ValueChange[] = [];
  for (const key of keys) {
    const had = Object.hasOwn(before, key);
    const has = Object.hasOwn(after, key);
    if (had && !has) changes.push({ key, kind: 'removed', before: canonical(before[key]) });
    else if (!had && has) changes.push({ key, kind: 'added', after: canonical(after[key]) });
    else if (canonical(before[key]) !== canonical(after[key])) {
      changes.push({
        key,
        kind: 'changed',
        before: canonical(before[key]),
        after: canonical(after[key]),
      });
    }
  }
  return changes;
}

/**
 * components/graph/SupersedeFactDialog (coverage gap G2, docs/kernel-console-coverage-2026-09-26.md):
 * 取代 — a person replaces a Fact's value with a new one on the same identity (same two Objects,
 * same link type — I5, the kernel refuses anything else), via `supersede_fact` on the human
 * channel. Two steps: edit the new value (the Fact's `properties`, as JSON), then review the
 * changes and confirm. The replacement is asserted by the person (`asserted`, §5.5), the old Fact
 * is kept as superseded, and the call is audited — all stated before the confirm.
 */
export function SupersedeFactDialog({
  http,
  fact,
  factLabel,
  onClose,
  onSuperseded,
}: SupersedeFactDialogProps) {
  const t = useT();
  const valueId = useId();
  const [text, setText] = useState('');
  const [step, setStep] = useState<'edit' | 'review'>('edit');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const factId = fact?.id ?? null;
  const current: JsonRecord = fact?.properties ?? {};
  // A string, so a re-render of the row with the same Fact never resets what is being typed.
  const initialText = JSON.stringify(current, null, 2);
  useEffect(() => {
    if (factId === null) return;
    setText(initialText);
    setStep('edit');
    setError(null);
  }, [factId, initialText]);

  const parsed = parseFactValue(text);
  const changes = parsed.ok ? valueChanges(current, parsed.value) : [];
  const unchanged = parsed.ok && changes.length === 0;
  const valueError = !parsed.ok
    ? parsed.reason === 'json'
      ? t('不是有效的 JSON', 'Not valid JSON')
      : t('新值必须是一个 JSON 对象', 'The new value must be a JSON object')
    : unchanged
      ? t('新值与当前值相同', 'The new value is the same as the current one')
      : null;

  async function confirm(): Promise<void> {
    if (!fact || !parsed.ok || unchanged) return;
    setBusy(true);
    setError(null);
    try {
      const replacement = await http.call<FactWire>('supersede_fact', {
        factId: fact.id,
        sourceObjectId: fact.sourceObjectId,
        targetObjectId: fact.targetObjectId,
        linkType: fact.linkType,
        properties: parsed.value,
      });
      onSuperseded(replacement);
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={fact !== null}
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent data-testid="supersede-fact-dialog" data-step={step}>
        <DialogHeader>
          <DialogTitle>
            {step === 'edit'
              ? t('取代该事实', 'Supersede this Fact')
              : t('确认取代', 'Confirm the replacement')}
          </DialogTitle>
          <DialogDescription className="mono">{factLabel}</DialogDescription>
        </DialogHeader>
        {step === 'edit' ? (
          <div className="stack">
            <Notice>
              {t(
                '写入一条新事实（同样两个对象、同一关系），由你本人断言；原事实保留为「已取代」。',
                'Writes a new Fact on the same two Objects and relation, asserted by you; the current one is kept as superseded.',
              )}
            </Notice>
            <Field
              id={valueId}
              label={t('新值（JSON 对象）', 'New value (JSON object)')}
              required
              hint={t(
                '该事实的属性。只能改值，不能改对象或关系。',
                "The Fact's properties. Only the value changes — never the Objects or the relation.",
              )}
              error={valueError}
            >
              <Textarea
                id={valueId}
                aria-label={t('新值', 'New value')}
                className="mono"
                value={text}
                onChange={(event) => setText(event.target.value)}
                minRows={4}
                maxRows={12}
                spellCheck={false}
                invalid={valueError !== null}
                aria-describedby={describedBy(valueId, true, valueError !== null)}
                data-testid="supersede-fact-value"
              />
            </Field>
          </div>
        ) : (
          <div className="stack">
            <div className="stack-s">
              <span className="section-title">
                {t('变更', 'Changes')} · {changes.length}
              </span>
              <ul className="fact-value-changes" data-testid="supersede-fact-changes">
                {changes.map((change) => (
                  <li key={change.key} data-change={change.kind}>
                    <span className="fact-value-key">{change.key}</span>
                    {': '}
                    {change.kind === 'added' ? (
                      <span className="fact-value-added">+ {change.after}</span>
                    ) : change.kind === 'removed' ? (
                      <span className="fact-value-removed">− {change.before}</span>
                    ) : (
                      <>
                        <span className="fact-value-before">{change.before}</span>
                        {' → '}
                        <span className="fact-value-key">{change.after}</span>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            </div>
            <div className="stack-s">
              <span className="section-title">{t('影响范围', 'Impact')}</span>
              <ul className="fact-dialog-impact" data-testid="supersede-fact-impact">
                <li>
                  {t(
                    '新事实以你的名义断言（认知状态 asserted），原事实标记为「已取代」，两者都留在历史里',
                    'The new Fact is asserted by you (status asserted); the current one is marked superseded — both stay in history',
                  )}
                </li>
                <li>
                  {t(
                    '若它来自采集器，下次采集到不同的值会形成冲突，由人裁决',
                    'If a collector feeds it, its next differing observation opens a Conflict for a person to resolve',
                  )}
                </li>
                <li>{t('此操作会写入审计', 'Recorded in the audit log')}</li>
              </ul>
            </div>
            <InlineError error={error} testId="supersede-fact-error" />
          </div>
        )}
        <DialogFooter>
          {step === 'edit' ? (
            <>
              <Button
                variant="primary"
                size="s"
                disabled={valueError !== null}
                onClick={() => setStep('review')}
                data-testid="supersede-fact-review"
              >
                {t('检查变更', 'Review changes')}
              </Button>
              <Button variant="ghost" size="s" onClick={onClose}>
                {t('取消', 'Cancel')}
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="primary"
                size="s"
                disabled={busy}
                aria-busy={busy || undefined}
                onClick={() => void confirm()}
                data-testid="supersede-fact-confirm"
              >
                {t('确认取代', 'Supersede')}
              </Button>
              <Button variant="ghost" size="s" disabled={busy} onClick={() => setStep('edit')}>
                {t('返回修改', 'Back')}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
