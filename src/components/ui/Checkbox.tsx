import React from 'react';

const joinClasses = (...classes: Array<string | false | null | undefined>) => classes.filter(Boolean).join(' ');

export interface CheckboxProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label?: React.ReactNode;
  description?: React.ReactNode;
  containerClassName?: string;
}

export const Checkbox = React.forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox({
  label,
  description,
  className,
  containerClassName,
  ...props
}, ref) {
  return (
    <label className={joinClasses('afc-checkbox', containerClassName)}>
      <input ref={ref} type="checkbox" className={joinClasses('afc-checkbox__control', className)} {...props} />
      {(label || description) && (
        <span className="afc-checkbox__copy">
          {label && <span className="afc-checkbox__label">{label}</span>}
          {description && <span className="afc-checkbox__description">{description}</span>}
        </span>
      )}
    </label>
  );
});
