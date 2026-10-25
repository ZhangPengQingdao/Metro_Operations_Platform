import {PasswordInput,PasswordConfirmInput} from './PasswordInput';
import {isPasswordCompliant,PASSWORD_POLICY_MESSAGE} from './password-policy';
import React,{useEffect,useState} from 'react';
import {Button,Input,OrganizationPicker,type OrganizationOption,Field} from '../../components/ui';
import {AuthLayout} from './AuthLayout';
const messages:Record<string,string>={REGISTRATION_CONFLICT:'此工号已有账号或待审核申请，或企业微信 UserID 已被使用。',REGISTRATION_ORGANIZATION_INACTIVE:'所属组织已停用，请重新选择。',REGISTRATION_INVALID_INPUT:'请检查必填项；'+PASSWORD_POLICY_MESSAGE,REGISTRATION_RATE_LIMIT:'提交过于频繁，请稍后再试。'};
async function request<T>(path:string,body?:unknown):Promise<T>{const r=await fetch('/api/auth/registration'+path,{method:body===undefined?'GET':'POST',headers:body===undefined?undefined:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const v=await r.json();if(!r.ok)throw Error(messages[v.error]??'注册服务暂不可用，请稍后重试。');return v;}
export function Registration({onBack}:{onBack:()=>void}){
 const [form,setForm]=useState({employeeNo:'',name:'',phone:'',wecomUserId:'',password:'',organizationId:''});
 const [confirm,setConfirm]=useState(''),[orgs,setOrgs]=useState<OrganizationOption[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState(''),[done,setDone]=useState(false);
 useEffect(()=>{let live=true;async function load(){try{const all:OrganizationOption[]=[];let after='';while(live){const v=await request<{organizations:OrganizationOption[]}>('/organizations'+(after?'?after='+encodeURIComponent(after):''));all.push(...v.organizations);if(v.organizations.length<100)break;const next=v.organizations.at(-1)!.id;if(next===after)throw Error('组织列表读取失败');after=next;}if(live)setOrgs(all);}catch(e){if(live)setError((e as Error).message);}}void load();return()=>{live=false;};},[]);
 async function submit(e:React.FormEvent){e.preventDefault();if(busy)return;if(!isPasswordCompliant(form.password)){setError(PASSWORD_POLICY_MESSAGE);return;}if(form.password!==confirm){setError('两次输入的密码不一致。');return;}setBusy(true);setError('');try{await request('',form);setForm(v=>({...v,password:''}));setConfirm('');setDone(true);}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
 const set=(key:keyof typeof form)=>(e:React.ChangeEvent<HTMLInputElement>)=>setForm(v=>({...v,[key]:e.target.value}));
 if(done)return <AuthLayout title="申请已提交"><p className="afc-message--success">管理员审核通过后，使用工号和密码登录。</p><Button size="lg" fullWidth onClick={onBack}>返回登录</Button></AuthLayout>;
 return <AuthLayout title="注册员工账号" wide><form className="afc-auth-form afc-auth-form--grid" aria-label="员工注册" onSubmit={submit}>
  <Field htmlFor="register-employeeNo" label="工号" required><Input id="register-employeeNo" required minLength={3} maxLength={50} autoComplete="username" value={form.employeeNo} onChange={set('employeeNo')} disabled={busy}/></Field>
  <Field htmlFor="register-name" label="姓名" required><Input id="register-name" required maxLength={100} autoComplete="off" value={form.name} onChange={set('name')} disabled={busy}/></Field>
  <Field htmlFor="register-phone" label="手机号"><Input id="register-phone" type="tel" maxLength={50} autoComplete="off" value={form.phone} onChange={set('phone')} disabled={busy}/></Field>
  <Field htmlFor="register-wecomUserId" label="企业微信 UserID"><Input id="register-wecomUserId" maxLength={255} autoComplete="off" value={form.wecomUserId} onChange={set('wecomUserId')} disabled={busy}/></Field>
  <Field className="afc-auth-wide" htmlFor="register-org" label="所属组织" required><OrganizationPicker id="register-org" options={orgs} value={form.organizationId} onChange={organizationId=>setForm(v=>({...v,organizationId}))} required disabled={busy}/></Field>
  <Field htmlFor="register-password" label="密码" required><PasswordInput id="register-password" required value={form.password} onChange={set('password')} disabled={busy}/></Field>
  <Field htmlFor="register-confirm" label="确认密码" required><PasswordConfirmInput id="register-confirm" required password={form.password} value={confirm} onChange={e=>setConfirm(e.target.value)} disabled={busy}/></Field>
  {error&&<p role="alert" className="afc-error afc-auth-wide">{error}</p>}
  <Button className="afc-auth-wide" type="submit" size="lg" fullWidth loading={busy}>{busy?'提交中…':'提交注册申请'}</Button>
 </form><p className="afc-auth-switch">已有账号？<button type="button" className="afc-auth-link" onClick={onBack} disabled={busy}>返回登录</button></p></AuthLayout>;
}
