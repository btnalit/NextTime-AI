import { type ReactNode, type SelectHTMLAttributes, forwardRef } from 'react';
import { cn } from '../../lib/cn.js';

type SelectBaseProps = Omit<
  SelectHTMLAttributes<HTMLSelectElement>,
  'aria-label' | 'id' | 'className'
> & {
  readonly invalid?: boolean;
  readonly className?: string;
};

/** Forces an accessible name at the type level — there is no prop shape that compiles to an
 *  unlabeled `<select>` (the PI1 audit gap, `select-name` axe rule, this primitive exists to
 *  close): either `aria-label` on its own, or a visible `label` paired with the `id` it points
 *  `htmlFor` at. */
export type SelectProps =
  | (SelectBaseProps & {
      readonly 'aria-label': string;
      readonly id?: string;
      readonly label?: undefined;
    })
  | (SelectBaseProps & {
      readonly label: ReactNode;
      readonly id: string;
      readonly 'aria-label'?: undefined;
    });

/**
 * components/kit/select (S8 W3 F1, docs/development-tasks.md §5e F3 / S8 risk ①): a styled native
 * `<select>` — not Radix Select, which renders its own listbox popup and would diverge from every
 * native `<select>` still styled by the legacy CSS (`styles/ui.css` `.select`). Reuses that same
 * class so it renders pixel-identical to `components/ui/Field`'s `Select` and to a bare
 * `className="select"` `<select>`.
 */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(props, ref) {
  const { invalid, className, children, label, id, ...rest } = props as SelectProps & {
    readonly label?: ReactNode;
    readonly id?: string;
  };
  const domProps = rest as Omit<SelectHTMLAttributes<HTMLSelectElement>, 'id' | 'className'>;

  const select = (
    <select
      ref={ref}
      id={id}
      className={cn('select', className)}
      aria-invalid={invalid || undefined}
      {...domProps}
    >
      {children}
    </select>
  );

  if (label === undefined) return select;

  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      {select}
    </div>
  );
});
