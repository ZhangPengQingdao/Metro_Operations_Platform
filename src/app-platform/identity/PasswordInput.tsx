import React, { useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import { CheckCircle, Circle, XCircle } from '@phosphor-icons/react';
import { IconButton, Input, PlatformIcon } from '../../components/ui';
import { isPasswordCompliant, passwordChecks, PASSWORD_POLICY_MESSAGE } from './password-policy';

function Rule({ ok, touched, children }: { ok: boolean; touched: boolean; children: React.ReactNode }) {
 const state = ok ? 'ok' : touched ? 'pending' : 'idle';
 return <li className={`afc-password-rule afc-password-rule--${state}`}>{ok ? <CheckCircle size={15} weight="fill" aria-hidden="true"/> : <Circle size={15} aria-hidden="true"/>}<span>{children}</span><span className="sr-only">{ok ? '已满足' : '未满足'}</span></li>;
}

/** New-password field with a live checklist of the password policy. */
export function PasswordInput({ onChange, value, ...props }: React.ComponentProps<typeof Input>) {
 const [visible, setVisible] = useState(false);
 const text = typeof value === 'string' ? value : '';
 const check = passwordChecks(text), touched = text.length > 0;
 return <div className="afc-password-field">
  <Input type={visible ? 'text' : 'password'} autoComplete="new-password" {...props} value={value} minLength={8} maxLength={72}
   trailingAction={<IconButton size="sm" label={visible ? '隐藏密码' : '显示密码'} aria-pressed={visible} disabled={props.disabled} onClick={() => setVisible(v => !v)}><PlatformIcon name={visible ? 'eyeOff' : 'eye'} size={18}/></IconButton>}
   onChange={event => {
    event.currentTarget.setCustomValidity(event.currentTarget.value && !isPasswordCompliant(event.currentTarget.value) ? PASSWORD_POLICY_MESSAGE : '');
    onChange?.(event);
   }}/>
  <ul className="afc-password-rules" aria-live="polite">
   <Rule ok={check.length} touched={touched}>至少 8 位</Rule>
   <Rule ok={check.categoriesOk} touched={touched}>至少包含 3 类字符
    <span className="afc-password-categories">{check.categories.map(item => <span key={item.id} className={item.ok ? 'is-on' : ''}>{item.label}</span>)}</span>
   </Rule>
   {!check.bytes && <li className="afc-password-rule afc-password-rule--error"><XCircle size={15} weight="fill" aria-hidden="true"/><span>不能超过 72 字节</span></li>}
  </ul>
 </div>;
}

/** Repeat-password field that shows whether it matches as soon as something is typed. */
export function PasswordConfirmInput({ password, value, ref, ...props }: React.ComponentProps<typeof Input> & { password: string }) {
 const input = useRef<HTMLInputElement>(null);
 useImperativeHandle(ref, () => input.current!);
 const text = typeof value === 'string' ? value : '';
 const matches = text.length > 0 && text === password;
 // The original password may change without another event on the confirmation field.
 useLayoutEffect(() => {
  input.current?.setCustomValidity(text && text !== password ? '两次输入的密码不一致' : '');
 }, [password, text]);
 return <div className="afc-password-field">
  <Input type="password" autoComplete="new-password" {...props} ref={input} value={value} aria-invalid={text.length > 0 && !matches || undefined}
   onChange={event => { event.currentTarget.setCustomValidity(event.currentTarget.value && event.currentTarget.value !== password ? '两次输入的密码不一致' : ''); props.onChange?.(event); }}/>
  {text.length > 0 && <p className={`afc-password-match afc-password-match--${matches ? 'ok' : 'error'}`} aria-live="polite">{matches ? <><CheckCircle size={15} weight="fill" aria-hidden="true"/>两次输入一致</> : <><XCircle size={15} weight="fill" aria-hidden="true"/>两次输入不一致</>}</p>}
 </div>;
}
