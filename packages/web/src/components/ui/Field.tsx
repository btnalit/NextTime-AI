import {
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
  forwardRef,
} from 'react';

export interface FieldProps {
  /** The control's `id`; the label points at it and hint/error ids derive from it. */
  readonly id: string;
  readonly label: ReactNode;
  readonly hint?: ReactNode;
  readonly error?: string | null;
  readonly required?: boolean;
  readonly children: ReactNode;
}

/** `aria-describedby` value for a control inside `<Field id>` — hint and error ids, when shown. */
export function describedBy(id: string, hasHint: boolean, hasError: boolean): string | undefined {
  const ids = [hasHint ? `${id}-hint` : null, hasError ? `${id}-error` : null].filter(Boolean);
  return ids.length > 0 ? ids.join(' ') : undefined;
}

/**
 * components/ui/Field: label + control + hint + error. The control is passed as a child and
 * given `id` (and `aria-invalid`/`aria-describedby`, via `describedBy`) by the caller — keeps the
 * primitive dumb and the form code explicit about which control it is validating.
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

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  readonly invalid?: boolean;
  readonly mono?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { invalid, mono, className, ...rest },
  ref,
) {
  return (
    <input
      ref={ref}
      className={`input${mono ? ' input-mono' : ''}${className ? ` ${className}` : ''}`}
      aria-invalid={invalid || undefined}
      {...rest}
    />
  );
});

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  readonly invalid?: boolean;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { invalid, className, children, ...rest },
  ref,
) {
  return (
    <select
      ref={ref}
      className={`select${className ? ` ${className}` : ''}`}
      aria-invalid={invalid || undefined}
      {...rest}
    >
      {children}
    </select>
  );
});

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  readonly invalid?: boolean;
  readonly mono?: boolean;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { invalid, mono, className, ...rest },
  ref,
) {
  return (
    <textarea
      ref={ref}
      className={`textarea${mono ? ' textarea-mono' : ''}${className ? ` ${className}` : ''}`}
      aria-invalid={invalid || undefined}
      {...rest}
    />
  );
});
