import React from "react";

export interface RadioOption {
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
}

export interface RadioProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: React.ReactNode;
  description?: React.ReactNode;
}

export const Radio = React.forwardRef<HTMLInputElement, RadioProps>(function Radio({
  label,
  description,
  className = "",
  disabled,
  ...props
}, ref) {
  return (
    <label className={`afc-radio ${disabled ? "opacity-50 cursor-not-allowed" : ""} ${className}`}>
      <input
        ref={ref}
        type="radio"
        className="afc-radio__control"
        disabled={disabled}
        {...props}
      />
      {(label || description) && (
        <div className="afc-radio__copy">
          {label && <span className="afc-radio__label">{label}</span>}
          {description && <span className="afc-radio__description">{description}</span>}
        </div>
      )}
    </label>
  );
});

export interface RadioGroupProps {
  name: string;
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  options: RadioOption[];
  direction?: "vertical" | "horizontal";
  className?: string;
}

export const RadioGroup: React.FC<RadioGroupProps> = ({
  name,
  value,
  defaultValue,
  onChange,
  options,
  direction = "vertical",
  className = ""
}) => {
  const [internalValue, setInternalValue] = React.useState(defaultValue || "");
  const currentValue = value !== undefined ? value : internalValue;

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const nextVal = e.target.value;
    if (value === undefined) {
      setInternalValue(nextVal);
    }
    onChange?.(nextVal);
  };

  return (
    <div
      className={`flex ${direction === "horizontal" ? "flex-row flex-wrap gap-6" : "flex-col gap-2"} ${className}`}
      role="radiogroup"
    >
      {options.map((opt) => (
        <Radio
          key={opt.value}
          name={name}
          value={opt.value}
          checked={currentValue === opt.value}
          disabled={opt.disabled}
          label={opt.label}
          description={opt.description}
          onChange={handleChange}
        />
      ))}
    </div>
  );
};
