import React,{useEffect,useMemo,useRef,useState,type ReactNode} from 'react';
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

/** Controlled directory selector; data loading and access rules remain with the caller. */
export function OrganizationPeoplePicker(p:OrganizationPeoplePickerProps){
 const initialRoots=()=>p.organizations.filter(org=>!org.parentId||!p.organizations.some(parent=>parent.id===org.parentId)).map(org=>org.id);
 const [expanded,setExpanded]=useState<Set<string>>(()=>new Set(initialRoots()));
 const seenRoots=useRef(new Set(initialRoots()));
 const {roots,children}=useMemo(()=>{
  const ids=new Set(p.organizations.map(org=>org.id));
  const descendants=new Map<string,PickerOrganization[]>();
  const roots:PickerOrganization[]=[];
  for(const org of p.organizations){
   if(!org.parentId||!ids.has(org.parentId))roots.push(org);
   else {const siblings=descendants.get(org.parentId)??[];siblings.push(org);descendants.set(org.parentId,siblings);}
  }
  return {roots,children:descendants};
 },[p.organizations]);
 useEffect(()=>{
  const fresh=roots.filter(org=>!seenRoots.current.has(org.id)).map(org=>org.id);
  if(fresh.length)setExpanded(old=>new Set([...old,...fresh]));
  for(const root of roots)seenRoots.current.add(root.id);
 },[roots]);
 function node(org:PickerOrganization,depth:number,seen:Set<string>):ReactNode{
  if(seen.has(org.id))return null;
  const next=new Set(seen).add(org.id),nested=children.get(org.id)??[],state=p.organizationSelection?.(org.id);
  return <li key={org.id}><div className="afc-people-picker__org" style={{paddingLeft:8+depth*14}}>
   <button type="button" disabled={p.disabled||!nested.length} aria-label={`${expanded.has(org.id)?'收起':'展开'}${org.name}`} aria-expanded={nested.length?expanded.has(org.id):undefined} onClick={()=>setExpanded(old=>{const updated=new Set(old);updated.has(org.id)?updated.delete(org.id):updated.add(org.id);return updated;})}>{nested.length?(expanded.has(org.id)?'⌄':'›'):''}</button>
   {p.organizationSelection&&<input type="checkbox" aria-label={`选择${org.name}`} aria-checked={state==='mixed'?'mixed':state} checked={state===true} ref={el=>{if(el)el.indeterminate=state==='mixed'}} disabled={p.disabled||!p.onOrganizationSelection} onChange={event=>p.onOrganizationSelection?.(org.id,event.target.checked)}/>}
   <button type="button" disabled={p.disabled} aria-current={p.organizationId===org.id?'true':undefined} onClick={()=>p.onOrganizationChange(org.id)}>{org.name}</button></div>
   {expanded.has(org.id)&&<ul>{nested.map(child=>node(child,depth+1,next))}</ul>}</li>;
 }
 const selectedCount=p.people.filter(p.selected).length;
 return <div className="afc-people-picker"><nav aria-label="选择组织"><Button type="button" variant="ghost" disabled={p.disabled} aria-current={!p.organizationId?'page':undefined} onClick={()=>p.onOrganizationChange('')}>全部组织</Button><ul>{roots.map(org=>node(org,0,new Set()))}</ul></nav><section aria-label="组织成员">
 <Input aria-label="搜索姓名或工号" placeholder="搜索姓名或工号" value={p.search} disabled={p.disabled} onChange={event=>p.onSearchChange(event.target.value)}/>
 <label className="afc-people-picker__page"><input type="checkbox" aria-label="选择本页成员" disabled={p.disabled||p.loading||!p.people.length} checked={p.people.length>0&&selectedCount===p.people.length} ref={el=>{if(el)el.indeterminate=selectedCount>0&&selectedCount<p.people.length}} onChange={event=>{const checked=event.target.checked;p.people.forEach(person=>p.onPersonChange(person,checked))}}/>选择本页成员</label>
 <div className="afc-people-picker__members" aria-busy={p.loading}>{p.loading?<p role="status">正在读取成员…</p>:p.people.length?p.people.map(person=><div key={person.id} className="afc-people-picker__person"><label><input type="checkbox" checked={p.selected(person)} disabled={p.disabled} onChange={event=>p.onPersonChange(person,event.target.checked)}/><span>{person.name}<small>{person.employeeNo}</small></span></label>{p.renderPersonAction?.(person)}</div>):<p>此组织暂无匹配成员</p>}</div>
 <ListPagination page={p.page} hasNext={p.hasNext} busy={p.loading||p.disabled} onPrevious={()=>p.onPageChange(p.page-1)} onNext={()=>p.onPageChange(p.page+1)}/>
 </section></div>;
}
