import type { QuotaListEntryWire, QuotaWire } from '@nexttime/shared';
import { useState } from 'react';
import type { CapabilityCaller } from '../../lib/clients.js';
import { useT } from '../../lib/i18n.js';
import { QUOTA_KEY_INFO, type QuotaKey } from '../../lib/quotas.js';
import { Button } from '../kit/button.js';
import { Confirm } from '../kit/confirm.js';
import { Field } from '../kit/field.js';
import { Sheet, SheetContent, SheetFooter, SheetHeader, SheetTitle } from '../kit/sheet.js';

export interface QuotaEditSheetProps {
  readonly http: CapabilityCaller;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** `list_quotas` always reports all five keys (kernel doc comment: "every key is reported even
   *  when the workspace has never set_quota'd it") — this editor only ever edits an existing row,
   *  never creates one from scratch. */
  readonly row: QuotaListEntryWire;
  readonly onSaved: (row: QuotaListEntryWire) => void;
}

/**
 * components/governance/QuotaEditSheet (S8 W4 item 1, leftover 12 界面缺口 "`set_quota` — 模型页
 * 只读配额表，owner 改不了"): the owner-only editor for one I18 quota axis
 * (`set_quota{key, value}`). Raising a limit (or clearing it to "unlimited" on the two budget
 * axes) is a loosening change and confirms at the `irreversible` tier, same reasoning
 * `PolicyEditSheet` applies to auto-approval; lowering a limit confirms at `medium`.
 */
export function QuotaEditSheet({ http, open, onOpenChange, row, onSaved }: QuotaEditSheetProps) {
  const t = useT();
  const key = row.key as QuotaKey;
  const info = QUOTA_KEY_INFO[key];

  const [unlimited, setUnlimited] = useState(info?.nullable === true && row.value === null);
  const [value, setValue] = useState(row.value === null ? '' : String(row.value));
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  if (!info) {
    // A quota key this console build does not know about yet (kernel added a sixth axis) — still
    // lets the raw list render it read-only (`ModelsPage`'s own fallback), just no editor.
    return null;
  }

  // Thousands separators are accepted and stripped ("1,000" / "1 000" / "1_000"); nothing else is
  // guessed at ("10k" is not a number here — the error says what is).
  const cleaned = value.replace(/[,_\s]/g, '');
  const numeric = Number(cleaned);
  // "留空 = 不限": `set_quota`'s `value` is `z.unknown()` and the kernel accepts `null` on the two
  // nullable axes, so a blank field there is the same as ticking "不限" instead of an error.
  const blankMeansUnlimited = info.nullable && cleaned === '';
  const isUnlimited = unlimited || blankMeansUnlimited;
  const rangeText =
    info.max !== undefined
      ? t(
          `${info.min} 到 ${info.max} 的${info.integer ? '整数' : '数字'}`,
          `${info.integer ? 'an integer' : 'a number'} from ${info.min} to ${info.max}`,
        )
      : t(
          `不小于 ${info.min} 的${info.integer ? '整数' : '数字'}`,
          `${info.integer ? 'an integer' : 'a number'} of at least ${info.min}`,
        );
  const valueValid =
    isUnlimited ||
    (cleaned !== '' &&
      Number.isFinite(numeric) &&
      (!info.integer || Number.isInteger(numeric)) &&
      numeric >= info.min &&
      (info.max === undefined || numeric <= info.max));
  const valueError = valueValid
    ? null
    : cleaned === '' || !Number.isFinite(numeric)
      ? t(
          `“${value.trim()}”不是有效的数字，请输入${rangeText}（可用 , 或空格分隔千位）。`,
          `“${value.trim()}” is not a valid number — enter ${rangeText} (thousands separators , or spaces are fine).`,
        )
      : info.integer && !Number.isInteger(numeric)
        ? t(
            `这个配额只能是整数，请输入${rangeText}。`,
            `This quota must be a whole number — enter ${rangeText}.`,
          )
        : t(
            `${cleaned} 超出允许范围，请输入${rangeText}。`,
            `${cleaned} is out of range — enter ${rangeText}.`,
          );
  const canSubmit = valueValid && !submitting;

  const nextValue: number | null = isUnlimited ? null : numeric;
  // "Larger limit, or cleared to unlimited" = loosening; "smaller limit, or newly capped" =
  // tightening. `row.value === null` (currently unlimited) → anything finite is a tightening.
  const isLoosening =
    nextValue === null ? row.value !== null : row.value === null ? false : nextValue > row.value;

  function resetAndClose(): void {
    setConfirmOpen(false);
    onOpenChange(false);
  }

  async function submit(): Promise<void> {
    setSubmitting(true);
    try {
      // `set_quota`'s own result is `QuotaWireSchema` (`{key,value,updatedBy,updatedAt}`, no
      // `isDefault`) — a distinct, narrower shape from `list_quotas`'s `QuotaListEntryWire`
      // (`wire/governance.ts`'s own doc comment). A successful `set_quota` always upserts an
      // explicit row, so `isDefault: false` here is correct regardless of the value written.
      const saved = await http.call<QuotaWire>('set_quota', { key, value: nextValue });
      onSaved({ ...saved, isDefault: false });
      resetAndClose();
    } finally {
      setSubmitting(false);
    }
  }

  const label = t(info.zh, info.en);

  return (
    <Sheet open={open} onOpenChange={(next) => !submitting && onOpenChange(next)}>
      <SheetContent data-testid="quota-edit-sheet">
        <SheetHeader>
          <SheetTitle>{t(`编辑配额：${label}`, `Edit quota: ${label}`)}</SheetTitle>
        </SheetHeader>

        <div className="stack">
          <Field
            id="qe-value"
            label={label}
            hint={
              info.nullable
                ? t(
                    `留空或勾选“不限”表示没有上限；否则填${rangeText}。`,
                    `Leave empty or tick “unlimited” for no cap; otherwise enter ${rangeText}.`,
                  )
                : t(`必须是${rangeText}。`, `Must be ${rangeText}.`)
            }
            error={valueError}
          >
            <input
              id="qe-value"
              className="input mono"
              value={value}
              onChange={(event) => {
                setValue(event.target.value);
                // Typing a number is an explicit "not unlimited" — don't make the user untick first.
                if (event.target.value.trim() !== '') setUnlimited(false);
              }}
              disabled={submitting}
              inputMode={info.integer ? 'numeric' : 'decimal'}
              placeholder={info.nullable ? t('不限', 'Unlimited') : info.unit}
            />
          </Field>

          {info.nullable ? (
            <label className="checkbox">
              <input
                type="checkbox"
                checked={unlimited}
                onChange={(event) => setUnlimited(event.target.checked)}
                disabled={submitting}
              />
              <span>{t('不限', 'Unlimited')}</span>
            </label>
          ) : null}
        </div>

        <SheetFooter>
          <Confirm
            tier={isLoosening ? 'irreversible' : 'medium'}
            open={confirmOpen}
            onOpenChange={setConfirmOpen}
            anchor={
              <Button
                variant="primary"
                onClick={() => setConfirmOpen(true)}
                disabled={!canSubmit}
                data-testid="quota-edit-submit"
              >
                {t('保存', 'Save')}
              </Button>
            }
            title={
              isLoosening ? t('放宽配额', 'Loosen the quota') : t('保存配额', 'Save the quota')
            }
            description={
              isLoosening
                ? t(
                    '放宽配额会提高工作区的资源上限，立即生效。',
                    'Loosening this quota raises the workspace’s resource ceiling, effective immediately.',
                  )
                : t(
                    '改动立即生效，并写入平台审计。',
                    'Takes effect immediately and is recorded in the platform audit.',
                  )
            }
            target={label}
            impact={[
              `${row.value === null ? t('不限', 'unlimited') : row.value} → ${nextValue === null ? t('不限', 'unlimited') : nextValue}`,
            ]}
            danger={isLoosening}
            confirmLabel={t('确认保存', 'Confirm save')}
            onConfirm={submit}
            testId="quota-edit-confirm"
          />
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
            {t('取消', 'Cancel')}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
