import { type ButtonHTMLAttributes, forwardRef } from 'react';
import { Icon, type IconName } from './Icon.js';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 's' | 'm';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  /** Shows a spinner in place of the label and disables the button. */
  readonly loading?: boolean;
  /** Leading icon. With `iconOnly`, the label is exposed via `aria-label` only. */
  readonly icon?: IconName;
  readonly iconOnly?: boolean;
}

/**
 * components/ui/Button: the one button. Four weights (primary = the page's single main action,
 * secondary = ordinary actions, ghost = toolbar/in-row actions, danger = destructive), two sizes.
 * `type` defaults to `button` so a stray click inside a form never submits it by accident.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'secondary',
    size = 'm',
    loading = false,
    icon,
    iconOnly = false,
    className,
    children,
    disabled,
    type = 'button',
    'aria-label': ariaLabel,
    ...rest
  },
  ref,
) {
  const classes = [
    'btn',
    `btn-${variant}`,
    size === 's' ? 'btn-s' : '',
    iconOnly ? 'btn-icon' : '',
    loading ? 'btn-loading' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');
  const label =
    iconOnly && ariaLabel === undefined && typeof children === 'string' ? children : ariaLabel;
  return (
    <button
      ref={ref}
      type={type}
      className={classes}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      aria-label={label}
      title={iconOnly ? label : rest.title}
      {...rest}
    >
      {icon ? <Icon name={icon} size={size === 's' ? 's' : 'm'} /> : null}
      {iconOnly ? null : <span className="btn-label">{children}</span>}
    </button>
  );
});
