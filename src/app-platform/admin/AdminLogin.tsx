import React, {useState, type FormEvent} from 'react';
import {Button,Field,Input,IconButton,PlatformIcon} from '../../components/ui';

export function AdminLogin({onLogin,title='管理员登录'}: {onLogin: (username: string, password: string) => Promise<void>;title?:string}) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [visible,setVisible]=useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy) return;
    setBusy(true); setError('');
    try {await onLogin(username.trim(), password);} catch (cause) {setError(cause instanceof Error ? cause.message : '登录失败，请重试');} finally {setBusy(false);}
  }
  return <main className="afc-admin afc-theme-neutral afc-admin-login" data-theme="light"><div className="afc-login-container">
    <header><img src="/brand/afc-logo-green.svg" alt=""/><h1>运管开放平台</h1></header>
    <div className="afc-login-intro"><h2>{title}</h2></div>
    <form onSubmit={submit}>
      <Field htmlFor="admin-username" label="用户名"><Input id="admin-username" name="username" autoComplete="username" autoCapitalize="none" spellCheck={false} required maxLength={128} placeholder="请输入用户名" value={username} onChange={event => setUsername(event.target.value)} disabled={busy} leadingIcon={<PlatformIcon name="user"/>}/></Field>
      <Field htmlFor="admin-password" label="密码"><Input id="admin-password" name="password" type={visible?'text':'password'} autoComplete="current-password" required placeholder="请输入密码" value={password} onChange={event => setPassword(event.target.value)} disabled={busy} leadingIcon={<PlatformIcon name="lock"/>} trailingAction={<IconButton size="sm" label={visible?'隐藏密码':'显示密码'} aria-pressed={visible} disabled={busy} onClick={()=>setVisible(v=>!v)}><PlatformIcon name={visible?'eyeOff':'eye'} size={18}/></IconButton>}/></Field>
      {error && <p role="alert" className="afc-error">{error}</p>}
      <Button type="submit" fullWidth loading={busy} disabled={!username.trim() || !password} leadingIcon={<PlatformIcon name="login" size={18}/>}>{busy ? '正在登录…' : '登录'}</Button>
    </form>
  </div></main>;
}
