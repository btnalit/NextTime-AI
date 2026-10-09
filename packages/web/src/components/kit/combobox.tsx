import {
  type FocusEvent,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { cn } from '../../lib/cn.js';
import { useT } from '../../lib/i18n.js';

/** One pickable row: `value` is what `onChange` receives, `label` what is shown (and matched),
 *  `secondary` a muted note on the right (a blast radius, a group, a kind) that is matched too. */
export interface ComboboxOption {
  readonly value: string;
  readonly label: string;
  readonly secondary?: string;
  readonly disabled?: boolean;
}

export interface ComboboxProps {
  /** The input's `id` — `kit/field`'s `<label htmlFor>` points at it, so the field label is the
   *  combobox's accessible name. Also seeds the listbox / option ids. */
  readonly id: string;
  /** Only when no `<label htmlFor={id}>` names the input. */
  readonly 'aria-label'?: string;
  readonly 'aria-describedby'?: string;
  readonly options: readonly ComboboxOption[];
  /** The committed value; `''` is "nothing chosen". */
  readonly value: string;
  readonly onChange: (value: string) => void;
  /** Keep text that matches no option: every keystroke is committed through `onChange` and the
   *  options are suggestions. Without it, only a picked option is ever committed and leaving the
   *  field puts the chosen option's label back. */
  readonly allowFreeEntry?: boolean;
  /** Controlled typed text (strict mode only) — for a caller that consumes what is typed itself,
   *  e.g. a paste of several names. `''` shows the chosen option's label. */
  readonly inputValue?: string;
  readonly onInputValueChange?: (text: string) => void;
  readonly placeholder?: string;
  readonly loading?: boolean;
  /** Shown in the list when nothing matches (or the list is empty). */
  readonly emptyText?: ReactNode;
  readonly disabled?: boolean;
  readonly invalid?: boolean;
  readonly mono?: boolean;
  /** Show the × button while a value is chosen (default true). */
  readonly clearable?: boolean;
  /** Rows rendered at once; the rest are reached by typing (default 200). */
  readonly maxVisible?: number;
  readonly onBlur?: () => void;
  /** `data-testid` of the input. */
  readonly testId?: string;
}

/** Case-insensitive substring match over label, value and secondary text; rows whose label or
 *  value starts with the query come first, otherwise the caller's order is kept. */
export function filterComboboxOptions(
  options: readonly ComboboxOption[],
  query: string,
): readonly ComboboxOption[] {
  const q = query.trim().toLowerCase();
  if (q === '') return options;
  const starts: ComboboxOption[] = [];
  const contains: ComboboxOption[] = [];
  for (const option of options) {
    const label = option.label.toLowerCase();
    const value = option.value.toLowerCase();
    if (label.startsWith(q) || value.startsWith(q)) starts.push(option);
    else if (
      label.includes(q) ||
      value.includes(q) ||
      (option.secondary ?? '').toLowerCase().includes(q)
    ) {
      contains.push(option);
    }
  }
  return [...starts, ...contains];
}

/**
 * components/kit/combobox (console-ux-3): a searchable single-select over a list the console
 * already has (a gate's Operations, ObjectTypes, capability names) — the WAI-ARIA 1.2 combobox
 * pattern with a listbox popup: type to filter, ArrowUp / ArrowDown to move, Enter to pick, Escape
 * to close (without also closing the sheet around it), × to clear. `kit/select` stays the native
 * `<select>` for short fixed lists; this is for lists long enough that scrolling a native select
 * is the problem. Focus never leaves the input (options are `aria-activedescendant` targets), so
 * screen readers and the Field's label / hint / error wiring work as for a plain input.
 */
export function Combobox({
  id,
  'aria-label': ariaLabel,
  'aria-describedby': ariaDescribedBy,
  options,
  value,
  onChange,
  allowFreeEntry = false,
  inputValue,
  onInputValueChange,
  placeholder,
  loading = false,
  emptyText,
  disabled = false,
  invalid = false,
  mono = false,
  clearable = true,
  maxVisible = 200,
  onBlur,
  testId,
}: ComboboxProps) {
  const t = useT();
  const listId = `${id}-listbox`;
  const optionId = (index: number) => `${id}-option-${index}`;
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  /** What the person typed since the last pick; `null` = not filtering (show every option). */
  const [ownQuery, setOwnQuery] = useState<string | null>(null);
  const controlled = !allowFreeEntry && inputValue !== undefined;
  const query = controlled ? (inputValue === '' ? null : inputValue) : ownQuery;

  function setQuery(next: string | null): void {
    if (controlled) onInputValueChange?.(next ?? '');
    else setOwnQuery(next);
  }

  const selected = options.find((option) => option.value === value);
  const displayText = query ?? (allowFreeEntry ? value : (selected?.label ?? value));
  const filtered = useMemo(() => filterComboboxOptions(options, query ?? ''), [options, query]);
  const visible = filtered.slice(0, maxVisible);
  const hidden = filtered.length - visible.length;

  // Escape closes the list only: a capture listener on `window` runs before the one Radix's
  // Sheet / Dialog puts on `document`, so the surrounding sheet stays open.
  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: globalThis.KeyboardEvent): void {
      if (event.key !== 'Escape') return;
      if (!rootRef.current?.contains(event.target as Node | null)) return;
      event.stopPropagation();
      event.preventDefault();
      setOpen(false);
      setActive(-1);
      if (!allowFreeEntry) setQuery(null);
    }
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  });

  useEffect(() => {
    if (!open || active < 0) return;
    const element = document.getElementById(optionId(active));
    element?.scrollIntoView?.({ block: 'nearest' });
  });

  function openList(highlight: number): void {
    if (disabled) return;
    setOpen(true);
    setActive(highlight);
  }

  function selectedIndex(): number {
    return visible.findIndex((option) => option.value === value);
  }

  function pick(option: ComboboxOption): void {
    if (option.disabled) return;
    onChange(option.value);
    setQuery(null);
    setOpen(false);
    setActive(-1);
  }

  function nextEnabled(from: number, step: 1 | -1): number {
    for (let index = from + step; index >= 0 && index < visible.length; index += step) {
      if (!visible[index]?.disabled) return index;
    }
    return from;
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (!open) openList(Math.max(selectedIndex(), nextEnabled(-1, 1)));
      else setActive((current) => nextEnabled(current, 1));
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) openList(Math.max(selectedIndex(), nextEnabled(-1, 1)));
      else setActive((current) => (current <= 0 ? current : nextEnabled(current, -1)));
      return;
    }
    if (event.key === 'Enter') {
      if (!open) return;
      // An open list owns Enter — it never submits the surrounding form.
      event.preventDefault();
      const option = visible[active];
      if (option) pick(option);
      else if (!allowFreeEntry && visible.length === 1 && visible[0]) pick(visible[0]);
      else setOpen(false);
      return;
    }
    if (event.key === 'Tab' && open) {
      setOpen(false);
      setActive(-1);
    }
  }

  function onType(text: string): void {
    setQuery(text);
    if (allowFreeEntry) onChange(text);
    setOpen(true);
    // Strict mode highlights the best match so Enter takes it; free entry keeps what was typed.
    if (allowFreeEntry || text.trim() === '') setActive(-1);
    else {
      const first = filterComboboxOptions(options, text).findIndex((option) => !option.disabled);
      setActive(first);
    }
  }

  function handleBlur(event: FocusEvent<HTMLInputElement>): void {
    if (rootRef.current?.contains(event.relatedTarget as Node | null)) return;
    setOpen(false);
    setActive(-1);
    // Strict: an unpicked half-typed text reverts to the chosen label. Free entry: the text is
    // already the value. A controlled caller keeps its own text.
    if (!controlled) setOwnQuery(null);
    onBlur?.();
  }

  function clear(): void {
    onChange('');
    setQuery(null);
    setActive(-1);
    inputRef.current?.focus();
  }

  const activeId = open && active >= 0 && active < visible.length ? optionId(active) : undefined;
  const showClear = clearable && !disabled && (value !== '' || (query ?? '') !== '');

  return (
    <div className="combobox" ref={rootRef}>
      <input
        ref={inputRef}
        id={id}
        type="text"
        role="combobox"
        className={cn('input', mono && 'input-mono', 'combobox-input')}
        aria-label={ariaLabel}
        aria-describedby={ariaDescribedBy}
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={activeId}
        aria-invalid={invalid || undefined}
        aria-busy={loading || undefined}
        autoComplete="off"
        spellCheck={false}
        value={displayText}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(event) => onType(event.target.value)}
        onKeyDown={onKeyDown}
        onClick={() => (open ? setOpen(false) : openList(selectedIndex()))}
        onBlur={handleBlur}
        data-testid={testId}
      />
      <span className="combobox-actions">
        {showClear ? (
          <button
            type="button"
            className="combobox-icon-btn"
            aria-label={t('清除', 'Clear')}
            tabIndex={-1}
            onMouseDown={(event) => event.preventDefault()}
            onClick={clear}
            data-testid={testId ? `${testId}-clear` : undefined}
          >
            <span aria-hidden>×</span>
          </button>
        ) : null}
        <button
          type="button"
          className="combobox-icon-btn"
          aria-label={open ? t('收起选项', 'Hide options') : t('展开选项', 'Show options')}
          tabIndex={-1}
          disabled={disabled}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            if (open) setOpen(false);
            else {
              setQuery(null);
              openList(selectedIndex());
            }
            inputRef.current?.focus();
          }}
        >
          <span aria-hidden>▾</span>
        </button>
      </span>
      {open ? (
        <div className="combobox-popup">
          {loading ? <output className="combobox-note">{t('正在加载…', 'Loading…')}</output> : null}
          {/* The WAI-ARIA combobox pattern: focus stays on the input and moves through the
           *  options via `aria-activedescendant`, so neither the listbox nor an option is
           *  focusable or has key handlers of its own, and a native <select> cannot be used. */}
          {/* biome-ignore lint/a11y/useSemanticElements: see above. */}
          {/* biome-ignore lint/a11y/useFocusableInteractive: see above. */}
          <div className="combobox-listbox" role="listbox" id={listId} aria-label={ariaLabel}>
            {visible.map((option, index) => (
              // biome-ignore lint/a11y/useFocusableInteractive: see above.
              // biome-ignore lint/a11y/useKeyWithClickEvents: see above.
              <div
                key={option.value}
                id={optionId(index)}
                // biome-ignore lint/a11y/useSemanticElements: see above.
                role="option"
                className="combobox-option"
                aria-selected={option.value === value}
                aria-disabled={option.disabled || undefined}
                data-active={index === active || undefined}
                onMouseDown={(event) => event.preventDefault()}
                onMouseMove={() => {
                  if (!option.disabled && index !== active) setActive(index);
                }}
                onClick={() => pick(option)}
              >
                <span className={cn('combobox-option-label', mono && 'mono')}>{option.label}</span>
                {option.secondary ? (
                  <span className="combobox-option-secondary">{option.secondary}</span>
                ) : null}
              </div>
            ))}
          </div>
          {!loading && visible.length === 0 ? (
            <p className="combobox-note" data-testid={testId ? `${testId}-empty` : undefined}>
              {emptyText ??
                (allowFreeEntry && (query ?? '').trim() !== ''
                  ? t('没有匹配项，将使用输入的值。', 'No match — the typed value is kept.')
                  : t('没有匹配项。', 'No match.'))}
            </p>
          ) : null}
          {hidden > 0 ? (
            <p className="combobox-note">
              {t(
                `还有 ${hidden} 项未显示，继续输入以缩小范围。`,
                `${hidden} more not shown — keep typing to narrow the list.`,
              )}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export interface ComboboxChipsProps {
  /** The chosen values, in order. */
  readonly values: readonly string[];
  readonly onRemove: (value: string) => void;
  /** Values the directory does not list (kept, shown dashed). */
  readonly unknown?: ReadonlySet<string>;
  readonly disabled?: boolean;
  readonly testId?: string;
}

/** The chosen values of a multi-pick built from `Combobox` + this list: one removable chip each. */
export function ComboboxChips({ values, onRemove, unknown, disabled, testId }: ComboboxChipsProps) {
  const t = useT();
  if (values.length === 0) return null;
  return (
    <ul className="pick-chips" data-testid={testId}>
      {values.map((value) => (
        <li
          key={value}
          className={cn('pick-chip', unknown?.has(value) && 'pick-chip-unknown')}
          title={unknown?.has(value) ? t('目录里没有这一项', 'Not in the directory') : undefined}
        >
          <span>{value}</span>
          <button
            type="button"
            className="pick-chip-remove"
            aria-label={t(`移除 ${value}`, `Remove ${value}`)}
            onClick={() => onRemove(value)}
            disabled={disabled}
          >
            <span aria-hidden>×</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
