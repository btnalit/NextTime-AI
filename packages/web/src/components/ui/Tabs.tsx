export interface TabOption<V extends string> {
  readonly value: V;
  readonly label: string;
  readonly count?: number;
}

export interface TabsProps<V extends string> {
  readonly ariaLabel: string;
  readonly value: V;
  readonly options: readonly TabOption<V>[];
  readonly onChange: (value: V) => void;
}

/** components/ui/Tabs: a segmented filter (Pending / All). Arrow keys move between tabs. */
export function Tabs<V extends string>({ ariaLabel, value, options, onChange }: TabsProps<V>) {
  return (
    <div className="tabs" role="tablist" aria-label={ariaLabel}>
      {options.map((option, index) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="tab"
            className="tab"
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => {
              if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
              event.preventDefault();
              const delta = event.key === 'ArrowRight' ? 1 : -1;
              const next = options[(index + delta + options.length) % options.length];
              if (next) onChange(next.value);
            }}
            data-value={option.value}
          >
            {option.label}
            {option.count !== undefined ? <span className="tab-count">{option.count}</span> : null}
          </button>
        );
      })}
    </div>
  );
}
