import type { ReactNode } from 'react';

export interface FieldProps {
  /** The control's `id`; the label points at it and hint/error ids derive from it. */
  readonly id: string;
  readonly label: ReactNode;
  readonly hint?: ReactNode;
  readonly error?: string | null;
  readonly required?: boolean;
  readonly children: ReactNode;
}

/** `aria-describedby` value for a control inside `<Field id>` — hint and error ids, when shown.
 *  Same contract as `components/ui/Field`'s own `describedBy` (S8 W3 F1). */
export function describedBy(id: string, hasHint: boolean, hasError: boolean): string | undefined {
  const ids = [hasHint ? `${id}-hint` : null, hasError ? `${id}-error` : null].filter(Boolean);
  return ids.length > 0 ? ids.join(' ') : undefined;
}

/**
 * components/kit/field (S8 W3 F1, docs/development-tasks.md §5e F3 / S8 risk ①): the kit
 * replacement for `components/ui/Field` — label + control + hint + error, over the same `field` /
 * `field-label` / `field-required` / `field-hint` / `field-error` CSS classes so a page swapping
 * from the legacy component or a local replica renders pixel-identical. The control is passed as a
 * child and given `id` (and `aria-invalid`/`aria-describedby`, via `describedBy` above) by the
 * caller — keeps the primitive dumb and the form code explicit about which control it is
 * validating.
 */
export function Field({ id, label, hint, error, required = false, children }: FieldProps) {
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {label}
        {required ? (
          <span className="field-required" aria-hidden>
            *
          </span>
        ) : null}
      </label>
      {children}
      {hint !== undefined && !error ? (
        <p className="field-hint" id={`${id}-hint`}>
          {hint}
        </p>
      ) : null}
      {error ? (
        <p className="field-error" id={`${id}-error`} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
