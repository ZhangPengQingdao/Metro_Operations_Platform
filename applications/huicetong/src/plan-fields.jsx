import {useEffect,useState} from 'react';
import {Input,Field,DropdownSelect,SearchSelect} from '@metro/platform-sdk/ui';

export const responsibleFor=person=>({personId:person.id,organizationUnitId:person.organizationUnitId,name:person.name});

export function PersonPicker({id,kind,call,disabled,responsible,onChange,suggestedName=''}){
 const [query,setQuery]=useState(responsible?.name??''),[search,setSearch]=useState(null),[after,setAfter]=useState(null);
 const [page,setPage]=useState({rows:[],nextCursor:null}),[loading,setLoading]=useState(false),[error,setError]=useState('');
 useEffect(()=>{
  if(search===null)return;
  const controller=new AbortController();
  setLoading(true);setError('');
  const timer=setTimeout(async()=>{
   try{
    const result=await call('members',{kind,search,...(after?{afterId:after}:{})},false,{signal:controller.signal});
    if(!controller.signal.aborted)setPage(old=>({rows:after?[...old.rows,...result.rows]:result.rows,nextCursor:result.nextCursor}));
   }catch(e){if(!controller.signal.aborted)setError(e.message);}
   finally{if(!controller.signal.aborted)setLoading(false);}
  },search?180:0);
  return()=>{clearTimeout(timer);controller.abort();};
 },[kind,search,after,call]);
 function find(value){
  if(value===search)return;
  setPage({rows:[],nextCursor:null});setAfter(null);setSearch(value.slice(0,100));
 }
 return <div><SearchSelect id={id} value={query} options={page.rows.map(p=>({...p,label:p.name,detail:p.employeeNo}))}
  required allowCustom={false} disabled={disabled} placeholder={!responsible&&suggestedName?`核对责任人 · ${suggestedName}`:'搜索姓名或工号'}
  emptyText={loading?'正在读取…':'没有匹配人员'} onSearch={find} loadingMore={loading}
  onLoadMore={page.nextCursor?()=>setAfter(page.nextCursor):undefined}
  onInput={value=>{setQuery(value);onChange(null);}} onSelect={p=>{setQuery(p.name);onChange(responsibleFor(p));}}/>
  {error&&<p role="alert" className="hct-alert">{error}</p>}</div>;
}
export function PlanFields({form,setForm,session,organizationId,call,disabled,kind='monthly',hints=[],suggestedResponsibleName=''}){
 const update=(key,value)=>setForm(old=>({...old,[key]:value}));
 return <fieldset className="hct-fields" disabled={disabled}>
  <><div className="hct-form">
   <Field className="hct-wide" label={kind==='supervision'?'督办要求':'工作计划内容'} required htmlFor="hct-content"><textarea id="hct-content" className="afc-control afc-control--textarea" maxLength={500} required value={form.content} onChange={e=>update('content',e.target.value)}/></Field>
   <Field className="hct-wide" label={kind==='supervision'?'办结标准':'完成质量标准'} required={kind!=='annual'} htmlFor="hct-quality"><textarea id="hct-quality" className="afc-control afc-control--textarea" maxLength={500} required={kind!=='annual'} value={form.qualityStandard} onChange={e=>update('qualityStandard',e.target.value)}/></Field>
   {kind==='monthly'&&<Field label="开始日期" required htmlFor="hct-start"><Input required id="hct-start" type="date" max={form.endDate||undefined} value={form.startDate} onChange={e=>update('startDate',e.target.value)}/></Field>}
   {kind!=='annual'&&<Field label={kind==='supervision'?'督办时限':'完成日期'} required htmlFor="hct-end"><Input required id="hct-end" type="date" min={kind==='monthly'?form.startDate||undefined:undefined} value={form.endDate} onChange={e=>update('endDate',e.target.value)}/></Field>}
   {kind==='annual'&&<><Field label="年度" required htmlFor="hct-year"><Input required id="hct-year" type="number" min="2000" max="2100" value={form.year} onChange={e=>update('year',Number(e.target.value))}/></Field><Field label="开始月份" required htmlFor="hct-start-month"><Input required id="hct-start-month" type="number" min="1" max="12" value={form.startMonth} onChange={e=>update('startMonth',Number(e.target.value))}/></Field><Field label="结束月份" required htmlFor="hct-end-month"><Input required id="hct-end-month" type="number" min={form.startMonth||1} max="12" value={form.endMonth} onChange={e=>update('endMonth',Number(e.target.value))}/></Field></>}
   <Field className="hct-wide" label="责任人" required htmlFor="hct-person"><PersonPicker id="hct-person" kind={kind} call={call} disabled={disabled} responsible={form.responsible} suggestedName={suggestedResponsibleName} onChange={responsible=>setForm(old=>({...old,responsible,annualId:old.responsible?.personId===responsible?.personId?old.annualId:''}))}/></Field>
   {kind==='monthly'&&hints.length>0&&<Field className="hct-wide" label="关联年度计划（可选）"><DropdownSelect ariaLabel="关联年度计划" disabled={disabled} value={form.annualId??''} options={[{value:'',label:'不关联'},...hints.filter(row=>!form.responsible||row.responsible_id===form.responsible.personId).map(row=>({value:row.id,label:row.content}))]} onChange={value=>update('annualId',value)}/></Field>}
   {kind==='supervision'&&<Field className="hct-wide" label="备注" htmlFor="hct-remark"><textarea id="hct-remark" className="afc-control afc-control--textarea" value={form.remark??''} maxLength={500} onChange={e=>update('remark',e.target.value)}/></Field>}
  </div></>
 </fieldset>;
}
