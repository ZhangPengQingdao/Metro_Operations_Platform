import React,{useState} from 'react';
import {Button,PlatformIcon} from '../../components/ui';
import {AiSettings} from './AiSettings';
import {SystemUpdates} from './SystemUpdates';
import {AuditPanel} from './AdminPages';

type Section='ai'|'updates'|'audit';
const sections:{id:Section;label:string;icon:'cog'|'database'|'clock';title:string}[]=[
 {id:'ai',label:'大模型',icon:'cog' as const,title:'大模型接入'},
 {id:'updates',label:'系统更新',icon:'database' as const,title:'系统更新'},
 {id:'audit',label:'操作记录',icon:'clock' as const,title:'操作记录'},
];
export function SettingsSections({onSaved,onBusy}:{onSaved?:()=>void;onBusy?:(busy:boolean)=>void}){
 const [section,setSection]=useState<'ai'|'updates'|'audit'>('ai'),[busy,setBusy]=useState(false);
 const active=sections.find(item=>item.id===section)??sections[0];
 return <div className="afc-profile-layout">
  <nav className="afc-profile-nav" aria-label="系统设置">
   {sections.map(item=><Button key={item.id} disabled={busy} variant="ghost" shape="rounded" aria-current={section===item.id?'page':undefined} leadingIcon={<PlatformIcon name={item.icon} size={18}/>} onClick={()=>setSection(item.id)}>{item.label}</Button>)}
  </nav>
  <section className="afc-profile-content" aria-label={active.title}>
   <div className="flex items-center justify-between mr-10 mb-6">
    <h3 className="afc-profile-section-title !m-0">{active.title}</h3>
    {section==='ai'&&<span className="admin-status">OpenAI 兼容</span>}
   </div>
   {section==='ai'&&<AiSettings onSaved={onSaved} onBusy={value=>{setBusy(value);onBusy?.(value);}}/>}
   {section==='updates'&&<SystemUpdates/>}
   {section==='audit'&&<AuditPanel/>}
  </section>
 </div>;
}
