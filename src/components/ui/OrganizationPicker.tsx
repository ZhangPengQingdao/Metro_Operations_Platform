import React,{useId,useRef,useState} from 'react';
import {CaretDown,CaretRight,Check} from '@phosphor-icons/react';
import {Button} from './Button';
import {FloatingPortal} from './FloatingPortal';
export interface OrganizationOption {id:string;name:string;parentId?:string|null;status?:string}
export function organizationPath(options:readonly OrganizationOption[],id:string):OrganizationOption[]{
 const byId=new Map(options.map(o=>[o.id,o])),seen=new Set<string>(),path:OrganizationOption[]=[];
 let node=byId.get(id);while(node&&!seen.has(node.id)){seen.add(node.id);path.unshift(node);node=node.parentId?byId.get(node.parentId):undefined;}return path;
}
export interface OrganizationPickerProps {id?:string;options:readonly OrganizationOption[];value:string;onChange:(id:string)=>void;disabled?:boolean;required?:boolean;label?:string;excludeId?:string}
/** Select any enabled level; expanding a branch never changes the selected organization. */
export function OrganizationPicker({id,options,value,onChange,disabled,required,label='所属组织',excludeId}:OrganizationPickerProps){
 const generated=useId(),controlId=id??generated,anchor=useRef<HTMLButtonElement>(null),[open,setOpen]=useState(false),[expanded,setExpanded]=useState<Set<string>>(new Set());
 const byId=new Map(options.map(o=>[o.id,o]));
 const excluded=(o:OrganizationOption)=>!!excludeId&&organizationPath(options,o.id).some(p=>p.id===excludeId);
 const available=options.filter(o=>!excluded(o)),roots=available.filter(o=>!o.parentId||!byId.has(o.parentId));
 const path=organizationPath(options,value),selected=byId.get(value),valid=!!selected&&selected.status!=='inactive'&&!excluded(selected);
 function show(){setExpanded(new Set(path.map(o=>o.id)));setOpen(true);}
 function dismiss(){setOpen(false);}
 function choose(id:string){onChange(id);dismiss();anchor.current?.focus();}
 function branch(o:OrganizationOption,depth:number,seen:Set<string>):React.ReactNode{
  if(seen.has(o.id))return null;const next=new Set(seen).add(o.id),children=available.filter(c=>c.parentId===o.id),isOpen=expanded.has(o.id);
  return <React.Fragment key={o.id}><div className="afc-org-row" style={{paddingInlineStart:8+depth*16}}>{children.length?<button type="button" className="afc-org-expand" aria-label={`${isOpen?'收起':'展开'}${o.name}`} aria-expanded={isOpen} onClick={()=>setExpanded(old=>{const n=new Set(old);if(n.has(o.id))n.delete(o.id);else n.add(o.id);return n;})}>{isOpen?<CaretDown size={16}/>:<CaretRight size={16}/>}</button>:<span className="afc-org-spacer"/>}<button type="button" className="afc-org-option" disabled={o.status==='inactive'} aria-pressed={value===o.id} onClick={()=>choose(o.id)}><span>{o.name}{o.status==='inactive'?'（停用）':''}</span>{value===o.id&&<Check size={16}/>}</button></div>{isOpen&&children.map(c=>branch(c,depth+1,next))}</React.Fragment>;
 }
 return <span className="afc-org-picker"><button ref={anchor} id={controlId} type="button" className="afc-control afc-org-trigger" aria-label={label} aria-haspopup="dialog" aria-expanded={open} disabled={disabled} onClick={()=>open?dismiss():show()}><span>{path.length?path.map(o=>o.name).join(' / '):value?'原组织不可用':'请选择所属组织'}</span><CaretDown size={16}/></button><select className="afc-org-validation" aria-label={`${label}必填校验`} tabIndex={-1} required={required} disabled={disabled} value={valid?value:''} onChange={()=>{}} onInvalid={e=>{e.preventDefault();show();anchor.current?.focus();}}><option value=""/>{valid&&<option value={value}>{selected.name}</option>}</select><FloatingPortal inheritTheme open={open&&!disabled} anchorRef={anchor} onDismiss={dismiss} width={400} ariaLabel="选择组织" className="afc-org-panel"><div className="afc-org-tree">{roots.length?roots.map(o=>branch(o,0,new Set())):<p>暂无可选组织</p>}</div><div className="afc-org-footer">{!required&&<Button variant="ghost" size="sm" onClick={()=>choose('')}>清除选择</Button>}<Button variant="ghost" size="sm" onClick={()=>{dismiss();anchor.current?.focus();}}>关闭</Button></div></FloatingPortal></span>;
}
