import React, { useState } from 'react';
import { Button, Field, Input } from '../../components/ui';
import { adminRequest } from '../admin/client';
import { employeeRequest } from '../employee/client';
import { PasswordConfirmInput, PasswordInput } from './PasswordInput';
import { isPasswordCompliant, PASSWORD_POLICY_MESSAGE } from './password-policy';
import { AuthLayout } from './AuthLayout';

export function PasswordChangeRequired({ kind, onChanged }: { kind: 'admin' | 'employee'; onChanged: () => void }) {
 const [currentPassword, setCurrent] = useState(''), [newPassword, setNew] = useState(''), [confirm, setConfirm] = useState('');
 const [busy, setBusy] = useState(false), [error, setError] = useState('');
 const request = kind === 'admin' ? adminRequest : employeeRequest;
 async function submit(event: React.FormEvent) {
  event.preventDefault();
  if (busy) return;
  if (!isPasswordCompliant(newPassword)) { setError(PASSWORD_POLICY_MESSAGE); return; }
  if (newPassword !== confirm) { setError('两次输入的新密码不一致。'); return; }
  setBusy(true); setError('');
  try {
   await request('/auth/password', { method: 'PATCH', body: { currentPassword, newPassword } });
   setCurrent(''); setNew(''); setConfirm(''); onChanged();
  } catch (cause) { setError(cause instanceof Error ? cause.message : '修改未确认，请核对后再操作。'); }
  finally { setBusy(false); }
 }
 return <AuthLayout title="修改密码" subtitle="当前密码不符合安全要求，修改后重新登录。">
  <form className="afc-auth-form" aria-label="修改密码" onSubmit={submit}>
   <Field htmlFor="required-current-password" label="当前密码"><Input id="required-current-password" required type="password" autoComplete="current-password" value={currentPassword} onChange={e => setCurrent(e.target.value)} disabled={busy}/></Field>
   <Field htmlFor="required-new-password" label="新密码"><PasswordInput id="required-new-password" required value={newPassword} onChange={e => setNew(e.target.value)} disabled={busy}/></Field>
   <Field htmlFor="required-confirm-password" label="确认新密码"><PasswordConfirmInput id="required-confirm-password" required password={newPassword} value={confirm} onChange={e => setConfirm(e.target.value)} disabled={busy}/></Field>
   {error && <p role="alert" className="afc-error">{error}</p>}
   <Button type="submit" size="lg" fullWidth loading={busy}>修改密码并重新登录</Button>
  </form>
  <p className="afc-auth-switch"><button type="button" className="afc-auth-link" disabled={busy} onClick={async () => {
   setBusy(true); setError('');
   try { await request('/auth/logout', { method: 'POST' }); onChanged(); }
   catch (cause) { setError(cause instanceof Error ? cause.message : '退出未确认，请重试。'); }
   finally { setBusy(false); }
  }}>退出登录</button></p>
 </AuthLayout>;
}
