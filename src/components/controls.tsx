/**
 * Phosphor form controls — custom-drawn {@link Checkbox}, {@link Radio}, and
 * {@link Select} that replace the native macOS widgets everywhere in the app
 * (PLAN.md §7). The checkbox and radio keep a real, visually hidden
 * `<input>` in the tree so focus order, labels, and screen readers behave
 * exactly like the native control; the select is an ARIA combobox with a
 * listbox popover (arrows, Enter/Space, Escape, Home/End, and type-ahead).
 */
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import "./controls.css";

/** Props shared by {@link Checkbox} and {@link Radio}. */
interface ToggleProps {
  /** Whether the control is currently on. */
  checked: boolean;
  /** Grays the control out and ignores input. */
  disabled?: boolean;
  /** Accessible name for controls whose label lives outside them. */
  "aria-label"?: string;
}

/** Props for {@link Checkbox}. */
export interface CheckboxProps extends ToggleProps {
  /** Called with the next checked state when the user toggles. */
  onChange: (checked: boolean) => void;
}

/**
 * A Phosphor-styled checkbox.
 *
 * Renders as an inline box that an enclosing `<label>` (the app-wide
 * pattern) still activates, because the real `<input type="checkbox">` is
 * present — just invisible.
 *
 * @param props - {@link CheckboxProps}
 * @returns The drawn checkbox with its hidden real input.
 * @example
 * ```tsx
 * <label>
 *   <Checkbox checked={auto} onChange={setAuto} /> auto
 * </label>
 * ```
 */
export function Checkbox({
  checked,
  onChange,
  disabled,
  "aria-label": ariaLabel,
}: CheckboxProps): ReactNode {
  return (
    <span className="ctl-check">
      <input
        type="checkbox"
        className="ctl-native"
        checked={checked}
        disabled={disabled}
        aria-label={ariaLabel}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="ctl-box" aria-hidden>
        <svg viewBox="0 0 10 10" fill="none">
          <path
            d="M1.5 5.5 4 8l4.5-6"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
    </span>
  );
}

/** Props for {@link Radio}. */
export interface RadioProps extends ToggleProps {
  /** Radio group name — buttons sharing a name are mutually exclusive. */
  name: string;
  /** Called when this button becomes the selected one. */
  onChange: () => void;
}

/**
 * A Phosphor-styled radio button. Same hidden-native-input approach as
 * {@link Checkbox}, so arrow-key group navigation keeps working.
 *
 * @param props - {@link RadioProps}
 * @returns The drawn radio with its hidden real input.
 * @example
 * ```tsx
 * <label>
 *   <Radio name="target" checked={t === "pane"} onChange={() => set("pane")} />
 *   Current pane
 * </label>
 * ```
 */
export function Radio({
  name,
  checked,
  onChange,
  disabled,
  "aria-label": ariaLabel,
}: RadioProps): ReactNode {
  return (
    <span className="ctl-radio">
      <input
        type="radio"
        className="ctl-native"
        name={name}
        checked={checked}
        disabled={disabled}
        aria-label={ariaLabel}
        onChange={onChange}
      />
      <span className="ctl-box" aria-hidden />
    </span>
  );
}

/** One entry in a {@link Select} menu. */
export interface SelectOption {
  /** Machine value reported through `onChange`. */
  value: string;
  /** Text shown in the trigger and the menu row. */
  label: string;
  /** Renders the row grayed out and unselectable. */
  disabled?: boolean;
}

/** Props for {@link Select}. */
export interface SelectProps {
  /** Currently selected {@link SelectOption.value}; "" selects none. */
  value: string;
  /** Menu entries in display order. */
  options: SelectOption[];
  /** Called with the chosen option's value. */
  onChange: (value: string) => void;
  /** Trigger text while no option matches `value`. */
  placeholder?: string;
  /** Grays the trigger out and keeps the menu closed. */
  disabled?: boolean;
  /** Extra class for the root, for layout hooks like widths. */
  className?: string;
  /** Focuses the trigger on mount, for dialog-opening flows. */
  autoFocus?: boolean;
  /** Accessible name for the trigger. */
  "aria-label"?: string;
}

/** How long a pause resets the type-ahead buffer, in milliseconds. */
const TYPEAHEAD_RESET_MS = 500;

/**
 * A Phosphor-styled replacement for `<select>`: a button trigger plus a
 * listbox popover. Fully keyboard-driven — Space/Enter/arrows open the
 * menu, arrows move, type-ahead jumps, Enter/Space picks, Escape closes —
 * and the active row follows the pointer.
 *
 * @param props - {@link SelectProps}
 * @returns The trigger button plus, while open, the listbox popover.
 * @example
 * ```tsx
 * <Select
 *   value={hostId}
 *   options={hosts.map((h) => ({ value: h.id, label: h.label }))}
 *   placeholder="Pick a host…"
 *   onChange={setHostId}
 * />
 * ```
 */
export function Select({
  value,
  options,
  onChange,
  placeholder = "Choose…",
  disabled,
  className,
  autoFocus,
  "aria-label": ariaLabel,
}: SelectProps): ReactNode {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLUListElement | null>(null);
  const typeahead = useRef({ buffer: "", at: 0 });
  const listId = useId();

  const selectedIndex = useMemo(
    () => options.findIndex((option) => option.value === value),
    [options, value],
  );
  const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined;

  const openMenu = useCallback((): void => {
    setActive(selectedIndex >= 0 ? selectedIndex : firstEnabled(options));
    setOpen(true);
  }, [options, selectedIndex]);

  const pick = useCallback(
    (index: number): void => {
      const option = options[index];
      if (option !== undefined && option.disabled !== true) {
        onChange(option.value);
        setOpen(false);
      }
    },
    [onChange, options],
  );

  /* Close when the pointer goes down anywhere outside the control. */
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      if (!(event.target instanceof Node)) return;
      if (rootRef.current !== null && !rootRef.current.contains(event.target)) {
        setOpen(false);
      }
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  /* Keep the active row visible while arrowing through a long menu. */
  useEffect(() => {
    if (!open || active < 0) return;
    menuRef.current
      ?.querySelector(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  const move = (from: number, step: 1 | -1): void => {
    let index = from;
    for (let hop = 0; hop < options.length; hop += 1) {
      index += step;
      if (index < 0 || index >= options.length) return;
      if (options[index]?.disabled !== true) {
        setActive(index);
        return;
      }
    }
  };

  const jumpTo = (query: string): void => {
    const lower = query.toLowerCase();
    const index = options.findIndex(
      (option) =>
        option.disabled !== true && option.label.toLowerCase().startsWith(lower),
    );
    if (index >= 0) {
      setActive(index);
      if (!open) pick(index);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (disabled === true) return;
    const { key } = event;
    if (
      !open &&
      (key === "ArrowDown" || key === "ArrowUp" || key === " " || key === "Enter")
    ) {
      event.preventDefault();
      openMenu();
      return;
    }
    if (open) {
      if (key === "Escape") {
        /* Swallow it — Escape here closes the menu, not the enclosing
           dialog/drawer, matching how a native popup eats the key. */
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        return;
      }
      if (key === "Tab") {
        setOpen(false);
        return;
      }
      if (key === "ArrowDown" || key === "ArrowUp") {
        event.preventDefault();
        move(active, key === "ArrowDown" ? 1 : -1);
        return;
      }
      if (key === "Home" || key === "End") {
        event.preventDefault();
        setActive(key === "Home" ? firstEnabled(options) : lastEnabled(options));
        return;
      }
      if (key === "Enter" || key === " ") {
        event.preventDefault();
        pick(active);
        return;
      }
    }
    if (key.length === 1 && key !== " ") {
      const now = Date.now();
      const state = typeahead.current;
      state.buffer = now - state.at > TYPEAHEAD_RESET_MS ? key : state.buffer + key;
      state.at = now;
      jumpTo(state.buffer);
    }
  };

  return (
    <div
      className={className === undefined ? "ctl-select" : `ctl-select ${className}`}
      ref={rootRef}
    >
      <button
        type="button"
        className={
          selected === undefined
            ? "ctl-select-trigger ctl-select-trigger--placeholder"
            : "ctl-select-trigger"
        }
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={listId}
        aria-label={ariaLabel}
        disabled={disabled}
        autoFocus={autoFocus}
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={onKeyDown}
      >
        <span>{selected?.label ?? placeholder}</span>
        <svg className="ctl-select-caret" viewBox="0 0 10 10" fill="none" aria-hidden>
          <path
            d="M2 3.5 5 6.5 8 3.5"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      {open && (
        <ul className="ctl-select-menu" role="listbox" id={listId} ref={menuRef}>
          {options.map((option, index) => (
            <li
              key={option.value}
              role="option"
              data-index={index}
              aria-selected={index === selectedIndex}
              aria-disabled={option.disabled === true || undefined}
              className={optionClass(option, index === active)}
              onPointerEnter={() => {
                if (option.disabled !== true) setActive(index);
              }}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => pick(index)}
            >
              {option.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Index of the first enabled option, or -1 when every row is disabled.
 *
 * @param options - The menu entries to scan.
 * @returns The first enabled index, or -1.
 */
function firstEnabled(options: SelectOption[]): number {
  return options.findIndex((option) => option.disabled !== true);
}

/**
 * Index of the last enabled option, or -1 when every row is disabled.
 *
 * @param options - The menu entries to scan.
 * @returns The last enabled index, or -1.
 */
function lastEnabled(options: SelectOption[]): number {
  for (let index = options.length - 1; index >= 0; index -= 1) {
    if (options[index]?.disabled !== true) return index;
  }
  return -1;
}

/**
 * Class list for a menu row given its disabled/active state.
 *
 * @param option - The row's option.
 * @param isActive - Whether the row is the keyboard-active one.
 * @returns The space-joined class list.
 */
function optionClass(option: SelectOption, isActive: boolean): string {
  let name = "ctl-select-option";
  if (option.disabled === true) name += " ctl-select-option--disabled";
  else if (isActive) name += " ctl-select-option--active";
  return name;
}
