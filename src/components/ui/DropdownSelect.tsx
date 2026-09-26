import React, { useRef, useState } from 'react';
import { CaretDown, Check } from '@phosphor-icons/react';
import { FloatingPortal } from './FloatingPortal';

export interface DropdownSelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface DropdownSelectProps {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  options: DropdownSelectOption[];
  placeholder?: string;
  disabled?: boolean;
  ariaLabel?: string;
  className?: string;
}

export function DropdownSelect({ id, value, onChange, options, placeholder = '请选择', disabled = false, ariaLabel, className = '' }: DropdownSelectProps) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);
  const selected = options.find(option => option.value === value);
  const label = ariaLabel ?? selected?.label ?? placeholder;

  return (
    <div ref={anchorRef} className={`relative w-full ${className}`}>
      <button
        id={id}
        type="button"
        disabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className={`flex h-10 w-full items-center justify-between gap-2 rounded-xl border bg-white px-3 text-left text-sm transition-colors ${
          disabled ? 'cursor-not-allowed border-neutral-200 bg-neutral-50 text-neutral-400' : open ? 'border-neutral-900 ring-2 ring-neutral-900/10 text-neutral-900' : 'cursor-pointer border-neutral-300 text-neutral-900 hover:border-neutral-900'
        }`}
      >
        <span className={`truncate ${selected ? '' : 'text-neutral-400'}`}>{selected?.label ?? placeholder}</span>
        <CaretDown size={15} className={`shrink-0 text-neutral-500 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
      </button>
      <FloatingPortal
        open={open}
        anchorRef={anchorRef}
        onDismiss={() => setOpen(false)}
        width={Math.max(180, Math.ceil(anchorRef.current?.getBoundingClientRect().width ?? 240))}
        gap={4}
        ariaLabel={label}
        className="overflow-y-auto rounded-xl border border-neutral-200 bg-white p-1.5 shadow-xl shadow-black/10"
      >
        <div role="listbox" aria-label={label} className="max-h-60 space-y-0.5 overflow-y-auto">
          {options.map(option => {
            const active = option.value === value;
            return (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={active}
                disabled={option.disabled}
                onClick={() => { onChange(option.value); setOpen(false); }}
                className={`flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                  option.disabled ? 'cursor-not-allowed text-neutral-400' : active ? 'bg-neutral-900 font-semibold text-white' : 'cursor-pointer text-neutral-800 hover:bg-neutral-100'
                }`}
              >
                <span className="truncate">{option.label}</span>
                {active && <Check size={15} weight="bold" aria-hidden="true" />}
              </button>
            );
          })}
        </div>
      </FloatingPortal>
    </div>
  );
}
