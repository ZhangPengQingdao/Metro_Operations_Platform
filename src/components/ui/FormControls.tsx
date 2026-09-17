import React from 'react';
import {CaretDown,Minus,Plus} from '@phosphor-icons/react';
import {IconButton} from './Button';

const joinClasses = (...classes: Array<string | false | null | undefined>) => classes.filter(Boolean).join(' ');

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> { leadingIcon?: React.ReactNode; trailingAction?: React.ReactNode }

export const Input = React.forwardRef<HTMLInputElement, InputProps>(function Input({ className, leadingIcon, trailingAction, ...props }, ref) {
  const input=<input ref={ref} className={joinClasses('afc-control', props.type === 'file' && 'afc-control--file', Boolean(leadingIcon) && 'afc-control--leading', Boolean(trailingAction) && 'afc-control--trailing', className)} {...props} />;
  return leadingIcon || trailingAction ? <span className="afc-input-wrap">{leadingIcon && <span className="afc-input-leading">{leadingIcon}</span>}{input}{trailingAction && <span className="afc-input-trailing">{trailingAction}</span>}</span> : input;
});

export const Select = React.forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(function Select({ className, ...props }, ref) {
  return <span className="afc-select-wrap"><select ref={ref} className={joinClasses('afc-control', 'afc-control--select', className)} {...props} /><CaretDown className="afc-select-arrow" size={16} aria-hidden="true"/></span>;
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

export function QuantityInput({value,onValueChange,min=1,max=2147483647,disabled,...props}:Omit<React.InputHTMLAttributes<HTMLInputElement>,'value'|'onChange'|'min'|'max'|'type'>&{value:number|string;onValueChange:(value:string)=>void;min?:number;max?:number}){
 const number=Number(value);
 const change=(delta:number)=>onValueChange(String(Math.max(min,Math.min(max,(value===''||!Number.isFinite(number)?min:number)+delta))));
 return <span className="afc-quantity-control"><IconButton label="减少数量" disabled={disabled||value!==''&&number<=min} onClick={()=>change(-1)}><Minus size={16}/></IconButton><Input {...props} type="number" step={1} min={min} max={max} value={value} disabled={disabled} onChange={event=>onValueChange(event.target.value)}/><IconButton label="增加数量" disabled={disabled||number>=max} onClick={()=>change(1)}><Plus size={16}/></IconButton></span>;
}
