import { useT } from '../../lib/i18n.js';
import { Field } from '../kit/field.js';
import { Textarea } from '../kit/textarea.js';

/**
 * components/catalog/DiscardReasonField (S10 E1 结果归因): the optional "why discard" field both
 * discard confirms share (`CatalogPage`'s `DiscardDraftConfirm`, `graph/OntologyTypesDrawer`'s
 * proposal discard). The reason rides on `discard_draft`'s params, so it lands in that call's own
 * AuditRecord; capped at the capability's 500 characters.
 */
export function DiscardReasonField({
  id,
  value,
  onChange,
}: {
  readonly id: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  const t = useT();
  return (
    <Field
      id={id}
      label={t('丢弃原因（可选）', 'Reason (optional)')}
      hint={t('记入审计，帮助以后判断这类草稿为什么没用上', 'Kept in the audit trail')}
    >
      <Textarea
        id={id}
        value={value}
        maxLength={500}
        onChange={(event) => onChange(event.target.value)}
        aria-label={t('丢弃原因', 'Discard reason')}
        aria-describedby={`${id}-hint`}
        data-testid={id}
      />
    </Field>
  );
}
