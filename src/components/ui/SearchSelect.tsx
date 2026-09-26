import React,{useRef,useState} from 'react';
import {CaretDown,Check} from '@phosphor-icons/react';
import {Input} from './FormControls';
import {FloatingPortal} from './FloatingPortal';

export interface SearchSelectOption {id:string;label:string;detail?:string;[key:string]:unknown}
export interface SearchSelectProps<T extends SearchSelectOption=SearchSelectOption> {
 id:string;value:string;options:readonly T[];onInput:(value:string)=>void;onSelect:(option:T)=>void;
 onSearch?:(value:string)=>void;placeholder:string;disabled?:boolean;required?:boolean;
 allowCustom?:boolean;emptyText?:string;
}

/** Search and selection share one L2 field; callers decide whether free text is valid. */
export function SearchSelect<T extends SearchSelectOption>({id,value,options,onInput,onSelect,onSearch,placeholder,disabled=false,required=false,allowCustom=true,emptyText='暂无可选项'}:SearchSelectProps<T>){
 const [open,setOpen]=useState(false),[query,setQuery]=useState<string|null>(null),[active,setActive]=useState(-1);
 const root=useRef<HTMLDivElement>(null);
 const visible=options.filter(option=>query===null||`${option.label} ${option.detail??''}`.toLowerCase().includes(query.toLowerCase())).slice(0,50);
 const show=()=>{if(disabled)return;setOpen(true);setQuery(null);setActive(-1);onSearch?.('');};
 const choose=(option:T)=>{onSelect(option);setOpen(false);setQuery(null);onSearch?.('');};
 const dismiss=()=>{setOpen(false);setQuery(null);onSearch?.('');};
 const handleKey=(event:React.KeyboardEvent<HTMLInputElement>)=>{
  if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();if(!open)show();else if(visible.length)setActive(index=>index<0?(event.key==='ArrowDown'?0:visible.length-1):(index+(event.key==='ArrowDown'?1:-1)+visible.length)%visible.length);}
  if(event.key==='Enter'&&open&&active>=0&&visible[active]){event.preventDefault();choose(visible[active]);}
  if(event.key==='Escape'&&open){event.preventDefault();dismiss();}
 };
 return <div className="afc-search-select" ref={root}>
  <Input id={id} role="combobox" aria-autocomplete="list" aria-expanded={open} aria-controls={`${id}-options`} aria-activedescendant={open&&active>=0&&visible[active]?`${id}-option-${active}`:undefined} autoComplete="off" value={open&&query!==null?query:value} required={required} disabled={disabled} placeholder={placeholder} onFocus={event=>{show();event.target.select();}} onChange={event=>{const text=event.target.value;setOpen(true);setQuery(text);setActive(-1);onInput(text);onSearch?.(text);}} onKeyDown={handleKey} onBlur={()=>{if(!allowCustom&&query!==null&&!visible.some(option=>option.label===query))onInput('');}}/>
  <button className="afc-search-select__arrow" type="button" aria-label={`展开${placeholder}`} aria-expanded={open} disabled={disabled} onMouseDown={event=>event.preventDefault()} onClick={()=>open?dismiss():show()} aria-controls={`${id}-options`}><CaretDown size={16} className={open?'afc-search-select__chevron--open':''} aria-hidden="true"/></button>
  <FloatingPortal open={open} anchorRef={root} onDismiss={dismiss} width={Math.max(180,Math.ceil(root.current?.getBoundingClientRect().width??240))} gap={4} inheritTheme ariaLabel={placeholder} className="afc-search-select__popover">
   <div id={`${id}-options`} className="afc-search-select__options" role="listbox">{visible.length?visible.map((option,index)=><button id={`${id}-option-${index}`} key={option.id} type="button" role="option" aria-selected={option.label===value} className={index===active?'active':''} onMouseDown={event=>event.preventDefault()} onClick={()=>choose(option)}><span>{option.label}{option.detail&&<small>（{option.detail}）</small>}</span>{option.label===value&&<Check size={16} weight="bold" aria-hidden="true"/>}</button>):<p className="afc-search-select__empty">{emptyText}</p>}</div>
  </FloatingPortal>
 </div>;
}
