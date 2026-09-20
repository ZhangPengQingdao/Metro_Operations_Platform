import React,{useState,type ReactNode} from 'react';
import {Button} from './Button';
import {Input} from './FormControls';
import {ListPagination} from './DataList';
export interface PickerOrganization{id:string;name:string;parentId:string|null}
export interface PickerPerson{id:string;name:string;employeeNo:string;organizationId:string}
export interface OrganizationPeoplePickerProps{
 organizations:PickerOrganization[];people:PickerPerson[];organizationId:string;onOrganizationChange:(id:string)=>void;
 search:string;onSearchChange:(value:string)=>void;page:number;hasNext:boolean;onPageChange:(page:number)=>void;
 selected:(person:PickerPerson)=>boolean;onPersonChange:(person:PickerPerson,checked:boolean)=>void;
 organizationSelection?:(id:string)=>boolean|'mixed';onOrganizationSelection?:(id:string,checked:boolean)=>void;
 renderPersonAction?:(person:PickerPerson)=>ReactNode;disabled?:boolean;loading?:boolean;
}
/** Controlled L2 directory selector. Fetching, membership and role policies belong to callers. */
export function OrganizationPeoplePicker(p:OrganizationPeoplePickerProps){
 const [expanded,setExpanded]=useState<Set<string>>(()=>new Set(p.organizations.filter(o=>!o.parentId).map(o=>o.id)));
 const children=(parent:string|null)=>p.organizations.filter(o=>o.parentId===parent||parent===null&&!p.organizations.some(n=>n.id===o.parentId));
 function node(org:PickerOrganization,depth:number,seen:Set<string>):ReactNode{
  if(seen.has(org.id))return null;const next=new Set(seen).add(org.id),nested=children(org.id),state=p.organizationSelection?.(org.id);
  return <li key={org.id}><div className="afc-people-picker__org" style={{paddingLeft:8+depth*14}}>
   <button type="button" disabled={!nested.length} aria-label={`${expanded.has(org.id)?'收起':'展开'}${org.name}`} aria-expanded={nested.length?expanded.has(org.id):undefined} onClick={()=>setExpanded(old=>{const n=new Set(old);n.has(org.id)?n.delete(org.id):n.add(org.id);return n;})}>{nested.length?(expanded.has(org.id)?'⌄':'›'):''}</button>
   {p.organizationSelection&&<input type="checkbox" aria-label={`选择${org.name}`} aria-checked={state==='mixed'?'mixed':state} checked={state===true} ref={el=>{if(el)el.indeterminate=state==='mixed'}} disabled={p.disabled} onChange={e=>p.onOrganizationSelection?.(org.id,e.target.checked)}/>}
   <button type="button" aria-current={p.organizationId===org.id?'true':undefined} onClick={()=>p.onOrganizationChange(org.id)}>{org.name}</button></div>
   {expanded.has(org.id)&&<ul>{nested.map(o=>node(o,depth+1,next))}</ul>}</li>;
 }
 return <div className="afc-people-picker"><nav aria-label="选择组织"><Button variant="ghost" onClick={()=>p.onOrganizationChange('')}>全部组织</Button><ul>{children(null).map(o=>node(o,0,new Set()))}</ul></nav><section aria-label="组织成员">
 <Input aria-label="搜索姓名或工号" placeholder="搜索姓名或工号" value={p.search} onChange={e=>p.onSearchChange(e.target.value)}/>
 <label className="afc-people-picker__page"><input type="checkbox" aria-label="选择本页成员" disabled={p.disabled||p.loading||!p.people.length} checked={p.people.length>0&&p.people.every(p.selected)} ref={el=>{if(el)el.indeterminate=p.people.some(p.selected)&&!p.people.every(p.selected)}} onChange={e=>{const checked=e.target.checked;p.people.forEach(person=>p.onPersonChange(person,checked))}}/>选择本页成员</label>
 <div className="afc-people-picker__members" aria-busy={p.loading}>{p.loading?<p role="status">正在读取成员…</p>:p.people.length?p.people.map(person=><div key={person.id} className="afc-people-picker__person"><label><input type="checkbox" checked={p.selected(person)} disabled={p.disabled} onChange={e=>p.onPersonChange(person,e.target.checked)}/><span>{person.name}<small>{person.employeeNo}</small></span></label>{p.renderPersonAction?.(person)}</div>):<p>此组织暂无匹配成员</p>}</div>
 <ListPagination page={p.page} hasNext={p.hasNext} busy={p.loading||p.disabled} onPrevious={()=>p.onPageChange(p.page-1)} onNext={()=>p.onPageChange(p.page+1)}/>
 </section></div>;
}
