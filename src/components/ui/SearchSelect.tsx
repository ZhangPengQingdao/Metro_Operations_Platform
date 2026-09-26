import React,{useEffect,useRef,useState} from 'react';
import {CaretDown} from '@phosphor-icons/react';
import {Input} from './FormControls';

export interface SearchSelectOption {id:string;label:string;detail?:string;[key:string]:unknown}
export interface SearchSelectProps<T extends SearchSelectOption=SearchSelectOption> {
 id:string;value:string;options:readonly T[];onInput:(value:string)=>void;onSelect:(option:T)=>void;
 onSearch?:(value:string)=>void;placeholder:string;disabled?:boolean;required?:boolean;
 allowCustom?:boolean;emptyText?:string;
}

/** Search and selection share one L2 field; callers decide whether free text is valid. */
export function SearchSelect<T extends SearchSelectOption>({id,value,options,onInput,onSelect,onSearch,placeholder,disabled=false,required=false,allowCustom=true,emptyText='暂无可选项'}:SearchSelectProps<T>){
 const [open,setOpen]=useState(false),[query,setQuery]=useState<string|null>(null),[active,setActive]=useState(0);
 const root=useRef<HTMLDivElement>(null),search=useRef(onSearch);
 search.current=onSearch;
 useEffect(()=>{if(!open)return;const outside=(event:PointerEvent)=>{if(!root.current?.contains(event.target as Node)){setOpen(false);setQuery(null);search.current?.('');}};document.addEventListener('pointerdown',outside);return()=>document.removeEventListener('pointerdown',outside);},[open]);
 const visible=options.filter(option=>query===null||`${option.label} ${option.detail??''}`.toLowerCase().includes(query.toLowerCase())).slice(0,50);
 const show=()=>{if(disabled)return;setOpen(true);setQuery(null);setActive(0);onSearch?.('');};
 const choose=(option:T)=>{onSelect(option);setOpen(false);setQuery(null);onSearch?.('');};
 const handleKey=(event:React.KeyboardEvent<HTMLInputElement>)=>{
  if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();if(!open)show();else setActive(index=>(index+(event.key==='ArrowDown'?1:-1)+visible.length)%Math.max(visible.length,1));}
  if(event.key==='Enter'&&open&&visible[active]){event.preventDefault();choose(visible[active]);}
  if(event.key==='Escape'&&open){event.preventDefault();setOpen(false);setQuery(null);onSearch?.('');}
 };
 return <div className="afc-search-select" ref={root}>
  <Input id={id} role="combobox" aria-autocomplete="list" aria-expanded={open} aria-controls={`${id}-options`} aria-activedescendant={open&&visible[active]?`${id}-option-${active}`:undefined} autoComplete="off" value={open&&query!==null?query:value} required={required} disabled={disabled} placeholder={placeholder} onFocus={event=>{show();event.target.select();}} onChange={event=>{const text=event.target.value;setOpen(true);setQuery(text);setActive(0);onInput(text);onSearch?.(text);}} onKeyDown={handleKey} onBlur={()=>{if(!allowCustom&&query!==null&&!visible.some(option=>option.label===query))onInput('');}}/>
  <button className="afc-search-select__arrow" type="button" aria-label={`展开${placeholder}`} aria-expanded={open} disabled={disabled} onMouseDown={event=>event.preventDefault()} onClick={()=>{if(open){setOpen(false);setQuery(null);onSearch?.('');}else show();}} aria-controls={`${id}-options`}><CaretDown size={16} aria-hidden="true"/></button>
  {open&&<div id={`${id}-options`} className="afc-search-select__options" role="listbox">{visible.length?visible.map((option,index)=><button id={`${id}-option-${index}`} key={option.id} type="button" role="option" aria-selected={option.label===value} className={index===active?'active':''} onMouseDown={event=>event.preventDefault()} onClick={()=>choose(option)}>{option.label}{option.detail&&<small>{option.detail}</small>}</button>):<p className="afc-search-select__empty">{emptyText}</p>}</div>}
 </div>;
}
