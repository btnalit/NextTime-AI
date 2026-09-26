import { useRef } from 'react';
import { cn } from '../../lib/cn.js';

export interface TabOption<V extends string> {
  readonly value: V;
  readonly label: string;
  readonly count?: number;
  readonly testId?: string;
}

export interface TabsProps<V extends string> {
  readonly ariaLabel: string;
  readonly value: V;
  readonly options: readonly TabOption<V>[];
  readonly onChange: (value: V) => void;
  readonly className?: string;
}

/**
 * components/kit/tabs (console redesign P3-1, DesignSystem.dc.html): a segmented control — the
 * selected option is a raised surface chip on a recessed track (design system v2), the rest are
 * ghost. Same tablist contract as the legacy
 * `components/ui/Tabs` (`role="tablist"`/`role="tab"`, roving `tabIndex`, arrow keys move
 * selection) plus Home/End and DOM focus following the selection, so a page can adopt this look
 * without changing how it drives the component. Radix has no bare tablist/toggle-group primitive
 * in this project's dependency set (only dialog/dropdown-menu/popover/tooltip/alert-dialog/slot),
 * so this is hand-rolled — same trade-off `components/ui/Tabs` already made.
 */
export function Tabs<V extends string>({
  ariaLabel,
  value,
  options,
  onChange,
  className,
}: TabsProps<V>) {
  const buttonRefs = useRef<Partial<Record<V, HTMLButtonElement | null>>>({});

  function moveTo(index: number): void {
    const next = options[(index + options.length) % options.length];
    if (!next) return;
    onChange(next.value);
    buttonRefs.current[next.value]?.focus();
  }

  return (
    <div
      className={cn(
        'inline-flex gap-0.5 rounded-m border border-border bg-surface-3 p-0.5',
        className,
      )}
      role="tablist"
      aria-label={ariaLabel}
    >
      {options.map((option, index) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            ref={(el) => {
              buttonRefs.current[option.value] = el;
            }}
            type="button"
            role="tab"
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => {
              switch (event.key) {
                case 'ArrowRight':
                case 'ArrowDown':
                  event.preventDefault();
                  moveTo(index + 1);
                  break;
                case 'ArrowLeft':
                case 'ArrowUp':
                  event.preventDefault();
                  moveTo(index - 1);
                  break;
                case 'Home':
                  event.preventDefault();
                  moveTo(0);
                  break;
                case 'End':
                  event.preventDefault();
                  moveTo(options.length - 1);
                  break;
                default:
                  break;
              }
            }}
            className={cn(
              'inline-flex min-h-7 items-center gap-1.5 whitespace-nowrap rounded-s px-3 text-13 font-medium transition-colors',
              selected
                ? 'bg-surface-1 text-text shadow-card'
                : 'bg-transparent text-text-2 hover:text-text',
            )}
            data-value={option.value}
            data-testid={option.testId}
          >
            {option.label}
            {option.count !== undefined ? (
              <span className="tabular-nums">{option.count}</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
