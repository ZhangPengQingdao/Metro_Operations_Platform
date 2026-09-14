import React from 'react';

const joinClasses = (...classes: Array<string | false | null | undefined>) => classes.filter(Boolean).join(' ');

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> { leadingIcon?: React.ReactNode; trailingAction?: React.ReactNode }

export const Input = React.forwardRef<HTMLInputElement, InputProps>(function Input({ className, leadingIcon, trailingAction, ...props }, ref) {
  const input=<input ref={ref} className={joinClasses('afc-control', Boolean(leadingIcon) && 'afc-control--leading', Boolean(trailingAction) && 'afc-control--trailing', className)} {...props} />;
  return leadingIcon || trailingAction ? <span className="afc-input-wrap">{leadingIcon && <span className="afc-input-leading">{leadingIcon}</span>}{input}{trailingAction && <span className="afc-input-trailing">{trailingAction}</span>}</span> : input;
});

export const Select = React.forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(function Select({ className, ...props }, ref) {
  return <select ref={ref} className={joinClasses('afc-control', 'afc-control--select', className)} {...props} />;
});

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...props }, ref) {
  return <textarea ref={ref} className={joinClasses('afc-control', 'afc-control--textarea', className)} {...props} />;
});

interface FieldProps {
  label: React.ReactNode;
  htmlFor: string;
  required?: boolean;
  hint?: React.ReactNode;
  error?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}

export function Field({ label, htmlFor, required, hint, error, className, children }: FieldProps) {
  return (
    <div className={joinClasses('afc-field', className)}>
      <label className="afc-field__label" htmlFor={htmlFor}>
        {label}{required && <span className="afc-field__required" aria-hidden="true">*</span>}
      </label>
      {children}
      {(error || hint) && (
        <p className={joinClasses('afc-field__message', Boolean(error) && 'afc-field__message--error')}>
          {error || hint}
        </p>
      )}
    </div>
  );
}
