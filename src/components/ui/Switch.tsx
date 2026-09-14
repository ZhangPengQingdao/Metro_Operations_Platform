import React from "react";

export type SwitchSize = "sm" | "md";

export interface SwitchProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "size"> {
  label?: React.ReactNode;
  description?: React.ReactNode;
  size?: SwitchSize;
}

export const Switch = React.forwardRef<HTMLInputElement, SwitchProps>(function Switch({
  label,
  description,
  size = "md",
  className = "",
  disabled,
  ...props
}, ref) {
  return (
    <label className={`afc-switch afc-switch--${size} ${disabled ? "opacity-50 cursor-not-allowed" : ""} ${className}`}>
      <span className="relative inline-flex items-center">
        <input
          ref={ref}
          type="checkbox"
          role="switch"
          className="afc-switch__input"
          disabled={disabled}
          {...props}
        />
        <span className="afc-switch__track">
          <span className="afc-switch__thumb" />
        </span>
      </span>
      {(label || description) && (
        <div className="flex flex-col">
          {label && <span className="afc-switch__label">{label}</span>}
          {description && <span className="text-xs text-gray-500">{description}</span>}
        </div>
      )}
    </label>
  );
});
