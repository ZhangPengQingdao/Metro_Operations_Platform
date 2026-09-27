import React from 'react';
import { Input } from '../../components/ui';
import { isPasswordCompliant, PASSWORD_POLICY_MESSAGE } from './password-policy';

export function PasswordInput({ onChange, ...props }: React.ComponentProps<typeof Input>) {
 return <><Input type="password" autoComplete="new-password" {...props} minLength={8} maxLength={72}
  onChange={event => {
   event.currentTarget.setCustomValidity(event.currentTarget.value && !isPasswordCompliant(event.currentTarget.value) ? PASSWORD_POLICY_MESSAGE : '');
   onChange?.(event);
  }}/><span className="afc-muted">{PASSWORD_POLICY_MESSAGE}</span></>;
}
