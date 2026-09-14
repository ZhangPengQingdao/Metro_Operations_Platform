import React from 'react';

export interface SegmentedOption<T extends string> {
  value: T;
  label: React.ReactNode;
  icon?: React.ReactNode;
  badge?: React.ReactNode;
}

export interface SegmentedControlProps<T extends string> {
  value: T;
  options: Array<SegmentedOption<T>>;
  onChange: (value: T) => void;
  label?: string;
  className?: string;
}

export function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  label,
  className = ''
}: SegmentedControlProps<T>) {
  return (
    <div className={`afc-segmented ${className}`.trim()} role="tablist" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="tab"
          aria-selected={value === option.value}
          onClick={() => onChange(option.value)}
          className="afc-segment"
        >
          {option.icon}
          <span className="afc-segment__label">{option.label}</span>
          {option.badge !== undefined && <span className="afc-segment__badge">{option.badge}</span>}
        </button>
      ))}
    </div>
  );
}
