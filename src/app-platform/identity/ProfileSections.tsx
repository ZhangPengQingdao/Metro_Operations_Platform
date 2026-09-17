import React,{useState,type ReactNode} from 'react';
import {Button,PlatformIcon} from '../../components/ui';

export function ProfileSections({basic,password,busy=false}:{basic:ReactNode;password:ReactNode;busy?:boolean}){
 const [section,setSection]=useState<'basic'|'password'>('basic');
 return <div className="afc-profile-layout">
  <nav className="afc-profile-nav" aria-label="个人中心设置">
   <Button variant="ghost" shape="rounded" disabled={busy} aria-current={section==='basic'?'page':undefined} leadingIcon={<PlatformIcon name="userCircle" size={18}/>} onClick={()=>setSection('basic')}>基础资料</Button>
   <Button variant="ghost" shape="rounded" disabled={busy} aria-current={section==='password'?'page':undefined} leadingIcon={<PlatformIcon name="lock" size={18}/>} onClick={()=>setSection('password')}>修改密码</Button>
  </nav>
  <section className="afc-profile-content" aria-label={section==='basic'?'基础资料':'修改密码'}>
   <h3 className="afc-profile-section-title">{section==='basic'?'基础资料':'修改密码'}</h3>
   <div hidden={section!=='basic'}>{basic}</div><div hidden={section!=='password'}>{password}</div>
  </section>
 </div>;
}
