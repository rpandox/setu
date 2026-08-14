/**
 * The SFTP panel's small dialogs (F5): a text prompt (new folder, rename),
 * a delete confirm, and the chmod dialog (octal field + rwx checkboxes).
 * All three follow the app dialog pattern (PasteGuardDialog,
 * FingerprintDialog): scrim, `role="dialog"`, Esc cancels, keyboard-first.
 */

import "./dialogs.css";
import { useEffect, useRef, useState } from "react";

import { Checkbox } from "../../components/controls";
import { parseOctal, toOctal } from "./listing";

/** Props for {@link InputDialog}. */
export interface InputDialogProps {
  /** Dialog title, e.g. `"New folder"`. */
  title: string;
  /** Confirm button label, e.g. `"Create"`. */
  confirmLabel: string;
  /** Starting field value (the current name for renames). */
  initial: string;
  /** Called with the trimmed value; the caller closes the dialog. */
  onConfirm(value: string): void;
  /** Closes without acting. */
  onCancel(): void;
}

/**
 * A one-field text prompt: new-folder and rename share it.
 *
 * @param props - {@link InputDialogProps}
 * @returns The dialog element.
 */
export function InputDialog({
  title,
  confirmLabel,
  initial,
  onConfirm,
  onCancel,
}: InputDialogProps) {
  const [value, setValue] = useState(initial);
  const fieldRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    requestAnimationFrame(() => {
      fieldRef.current?.focus();
      fieldRef.current?.select();
    });
  }, []);

  const submit = () => {
    const trimmed = value.trim();
    if (trimmed !== "" && !trimmed.includes("/")) onConfirm(trimmed);
  };

  return (
    <div className="sftp-dialog-scrim" onMouseDown={onCancel}>
      <div
        className="sftp-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            onCancel();
          }
        }}
      >
        <h2 className="sftp-dialog-title">{title}</h2>
        <input
          ref={fieldRef}
          className="sftp-dialog-field"
          value={value}
          spellCheck={false}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") submit();
          }}
        />
        <div className="sftp-dialog-actions">
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button className="sftp-dialog-confirm" type="button" onClick={submit}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Props for {@link ConfirmDialog}. */
export interface ConfirmDialogProps {
  /** Dialog title, e.g. `"Delete 3 items?"`. */
  title: string;
  /** The consequence line under the title. */
  body: string;
  /** Confirm button label, e.g. `"Delete"`. */
  confirmLabel: string;
  /** Runs the confirmed action; the caller closes the dialog. */
  onConfirm(): void;
  /** Closes without acting. */
  onCancel(): void;
}

/**
 * The destructive-action confirm (delete). Focus lands on Cancel — the
 * destructive path is never the default (same stance as the trust dialog).
 *
 * @param props - {@link ConfirmDialogProps}
 * @returns The dialog element.
 */
export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    requestAnimationFrame(() => cancelRef.current?.focus());
  }, []);

  return (
    <div className="sftp-dialog-scrim" onMouseDown={onCancel}>
      <div
        className="sftp-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            onCancel();
          }
        }}
      >
        <h2 className="sftp-dialog-title">{title}</h2>
        <p className="sftp-dialog-body">{body}</p>
        <div className="sftp-dialog-actions">
          <button ref={cancelRef} type="button" onClick={onCancel}>
            Cancel
          </button>
          <button className="sftp-dialog-danger" type="button" onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Props for {@link ChmodDialog}. */
export interface ChmodDialogProps {
  /** What's being changed, e.g. `"deploy.log"` or `"3 items"`. */
  subject: string;
  /** The starting mode (the selected entry's bits). */
  initialMode: number;
  /** Called with the new mode; the caller closes the dialog. */
  onConfirm(mode: number): void;
  /** Closes without acting. */
  onCancel(): void;
}

/** The chmod checkbox grid's rows and columns, in render order. */
const CHMOD_ROWS: Array<{ label: string; shift: number }> = [
  { label: "Owner", shift: 6 },
  { label: "Group", shift: 3 },
  { label: "Others", shift: 0 },
];
const CHMOD_COLS: Array<{ label: string; bit: number }> = [
  { label: "Read", bit: 0b100 },
  { label: "Write", bit: 0b010 },
  { label: "Execute", bit: 0b001 },
];

/**
 * The chmod dialog (F5): an octal field and the rwx checkbox grid, kept in
 * lockstep — editing either updates the other.
 *
 * @param props - {@link ChmodDialogProps}
 * @returns The dialog element.
 */
export function ChmodDialog({
  subject,
  initialMode,
  onConfirm,
  onCancel,
}: ChmodDialogProps) {
  const [mode, setMode] = useState(initialMode & 0o7777);
  const [octalDraft, setOctalDraft] = useState(toOctal(initialMode));
  const fieldRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    requestAnimationFrame(() => fieldRef.current?.focus());
  }, []);

  const applyMode = (next: number) => {
    setMode(next);
    setOctalDraft(toOctal(next));
  };

  const octalValid = parseOctal(octalDraft) !== null;

  return (
    <div className="sftp-dialog-scrim" onMouseDown={onCancel}>
      <div
        className="sftp-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={`Permissions for ${subject}`}
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            onCancel();
          }
        }}
      >
        <h2 className="sftp-dialog-title">Permissions — {subject}</h2>
        <table className="sftp-chmod-grid">
          <thead>
            <tr>
              <th />
              {CHMOD_COLS.map((col) => (
                <th key={col.label}>{col.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {CHMOD_ROWS.map((row) => (
              <tr key={row.label}>
                <th>{row.label}</th>
                {CHMOD_COLS.map((col) => {
                  const bit = col.bit << row.shift;
                  return (
                    <td key={col.label}>
                      <Checkbox
                        aria-label={`${row.label} ${col.label.toLowerCase()}`}
                        checked={(mode & bit) !== 0}
                        onChange={() => applyMode(mode ^ bit)}
                      />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        <label className="sftp-chmod-octal">
          Octal
          <input
            ref={fieldRef}
            className="sftp-dialog-field"
            value={octalDraft}
            spellCheck={false}
            onChange={(event) => {
              setOctalDraft(event.target.value);
              const parsed = parseOctal(event.target.value);
              if (parsed !== null) setMode(parsed);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && octalValid) onConfirm(mode);
            }}
          />
        </label>
        <div className="sftp-dialog-actions">
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="sftp-dialog-confirm"
            type="button"
            disabled={!octalValid}
            onClick={() => onConfirm(mode)}
          >
            Apply
          </button>
        </div>
      </div>
    </div>
  );
}
