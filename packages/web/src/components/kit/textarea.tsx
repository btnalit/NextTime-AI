import {
  type ReactNode,
  type Ref,
  type TextareaHTMLAttributes,
  forwardRef,
  useLayoutEffect,
  useRef,
} from 'react';
import { cn } from '../../lib/cn.js';

type TextareaBaseProps = Omit<
  TextareaHTMLAttributes<HTMLTextAreaElement>,
  'aria-label' | 'id' | 'className' | 'rows'
> & {
  readonly invalid?: boolean;
  readonly className?: string;
  /** Rows shown before any content grows it. Default 2. */
  readonly minRows?: number;
  /** Rows the content can grow to before it scrolls instead of growing further. Default 8. */
  readonly maxRows?: number;
};

/** Forces an accessible name at the type level, same contract as `kit/select`'s `SelectProps` —
 *  either `aria-label` on its own, or a visible `label` paired with the `id` it points `htmlFor`
 *  at. There is no prop shape that compiles to an unlabeled `<textarea>`. */
export type TextareaProps =
  | (TextareaBaseProps & {
      readonly 'aria-label': string;
      readonly id?: string;
      readonly label?: undefined;
    })
  | (TextareaBaseProps & {
      readonly label: ReactNode;
      readonly id: string;
      readonly 'aria-label'?: undefined;
    });

function setRef<T>(ref: Ref<T> | undefined, value: T): void {
  if (typeof ref === 'function') ref(value);
  else if (ref) (ref as { current: T }).current = value;
}

/**
 * components/kit/textarea (console redesign P3-1): an auto-growing `<textarea>` — grows with
 * content between `minRows` and `maxRows`, then scrolls. Reuses the same `.textarea` legacy CSS
 * class `components/ui/Field`'s textarea and every bare `className="textarea"` already render
 * with (`kit/select` makes the identical choice for `.select`), so this looks pixel-identical to
 * the existing control while adding the auto-grow behaviour and the label/aria-label type
 * enforcement `kit/select`/`kit/field` already have.
 */
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  function Textarea(props, forwardedRef) {
    const {
      invalid,
      className,
      label,
      id,
      minRows = 2,
      maxRows = 8,
      onChange,
      ...rest
    } = props as TextareaProps & { readonly label?: ReactNode; readonly id?: string };
    const innerRef = useRef<HTMLTextAreaElement | null>(null);

    function resize(): void {
      const el = innerRef.current;
      if (!el) return;
      const style = window.getComputedStyle(el);
      const lineHeight = Number.parseFloat(style.lineHeight) || 20;
      const paddingY =
        (Number.parseFloat(style.paddingTop) || 0) + (Number.parseFloat(style.paddingBottom) || 0);
      const borderY =
        (Number.parseFloat(style.borderTopWidth) || 0) +
        (Number.parseFloat(style.borderBottomWidth) || 0);
      const minHeight = lineHeight * minRows + paddingY + borderY;
      const maxHeight = lineHeight * maxRows + paddingY + borderY;
      el.style.height = 'auto';
      const next = Math.min(Math.max(el.scrollHeight, minHeight), maxHeight);
      el.style.height = `${next}px`;
      el.style.overflowY = el.scrollHeight > maxHeight ? 'auto' : 'hidden';
    }

    // Re-measures on every value change; `resize` reads the live DOM node, not props, so it is
    // intentionally not a dependency here.
    // biome-ignore lint/correctness/useExhaustiveDependencies: see above
    useLayoutEffect(() => {
      resize();
    }, [props.value]);

    const textarea = (
      <textarea
        ref={(el) => {
          innerRef.current = el;
          setRef(forwardedRef, el);
        }}
        id={id}
        rows={minRows}
        className={cn('textarea', className)}
        aria-invalid={invalid || undefined}
        onChange={(event) => {
          onChange?.(event);
          resize();
        }}
        {...rest}
      />
    );

    if (label === undefined) return textarea;

    return (
      <div className="field">
        <label className="field-label" htmlFor={id}>
          {label}
        </label>
        {textarea}
      </div>
    );
  },
);
