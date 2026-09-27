import React, { useState } from 'react';
import { Button, Field, Input } from '../../components/ui';
import { adminRequest } from '../admin/client';
import { employeeRequest } from '../employee/client';
import { PasswordInput } from './PasswordInput';
import { isPasswordCompliant, PASSWORD_POLICY_MESSAGE } from './password-policy';
import { readThemePreference } from './theme';

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
 return <main className="afc-admin afc-theme-neutral afc-admin-login" data-theme={readThemePreference()}>
  <div className="afc-login-container"><header><img src="/brand/afc-logo-green.svg" alt=""/><h1>请先修改密码</h1></header>
   <p>当前密码不符合安全要求。完成修改并重新登录后，即可使用系统。</p>
   <form className="admin-form" aria-label="强制修改密码" onSubmit={submit}>
    <Field htmlFor="required-current-password" label="当前密码"><Input id="required-current-password" required type="password" autoComplete="current-password" value={currentPassword} onChange={e => setCurrent(e.target.value)} disabled={busy}/></Field>
    <Field htmlFor="required-new-password" label="新密码"><PasswordInput id="required-new-password" required value={newPassword} onChange={e => setNew(e.target.value)} disabled={busy}/></Field>
    <Field htmlFor="required-confirm-password" label="确认新密码"><Input id="required-confirm-password" required type="password" autoComplete="new-password" value={confirm} onChange={e => setConfirm(e.target.value)} disabled={busy}/></Field>
    {error && <p role="alert" className="afc-error">{error}</p>}
    <Button type="submit" fullWidth loading={busy}>修改密码并重新登录</Button>
    <Button variant="secondary" fullWidth disabled={busy} onClick={async () => {
     setBusy(true); setError('');
     try { await request('/auth/logout', { method: 'POST' }); onChanged(); }
     catch (cause) { setError(cause instanceof Error ? cause.message : '退出未确认，请重试。'); }
     finally { setBusy(false); }
    }}>退出登录</Button>
   </form>
  </div>
 </main>;
}
