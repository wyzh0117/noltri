'use client';

import type { ChangeEvent, ReactElement, ReactNode } from 'react';

/** Small form controls shared by the research panels, styled like the login / detail forms. */

export interface Choice {
  value: string;
  label: string;
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }): ReactElement {
  return (
    <div className="research-field">
      <span className="login-label">{label}</span>
      {children}
      {hint !== undefined ? <span className="field-hint">{hint}</span> : null}
    </div>
  );
}

export function TextInput({
  value,
  onChange,
  placeholder,
  type = 'text',
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: string;
}): ReactElement {
  return (
    <input
      className="field-input"
      type={type}
      value={value}
      placeholder={placeholder}
      onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value)}
    />
  );
}

export function TextArea({
  value,
  onChange,
  placeholder,
  rows = 3,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  rows?: number;
}): ReactElement {
  return (
    <textarea
      className="field-textarea"
      rows={rows}
      value={value}
      placeholder={placeholder}
      onChange={(event: ChangeEvent<HTMLTextAreaElement>) => onChange(event.target.value)}
    />
  );
}

export function SelectInput({
  value,
  onChange,
  choices,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  choices: readonly Choice[];
  placeholder?: string;
}): ReactElement {
  return (
    <select
      className="field-select"
      value={value}
      onChange={(event: ChangeEvent<HTMLSelectElement>) => onChange(event.target.value)}
    >
      {placeholder !== undefined ? <option value="">{placeholder}</option> : null}
      {choices.map((choice) => (
        <option key={choice.value} value={choice.value}>
          {choice.label}
        </option>
      ))}
    </select>
  );
}

export function FormError({ message }: { message: string | null }): ReactElement | null {
  return message === null ? null : <p className="error-note">{message}</p>;
}

export function BusyButton({
  busy,
  busyLabel,
  label,
  onClick,
  disabled = false,
  primary = true,
}: {
  busy: boolean;
  busyLabel: string;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  primary?: boolean;
}): ReactElement {
  return (
    <button
      type="button"
      className={primary ? 'btn btn-primary' : 'btn'}
      onClick={onClick}
      disabled={busy || disabled}
    >
      {busy ? busyLabel : label}
    </button>
  );
}
