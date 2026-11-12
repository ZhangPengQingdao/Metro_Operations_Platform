import {useState} from 'react';
import {Button} from '@metro/platform-sdk/ui';

export function PlanAssistant({call,organizationId,month,form,setForm,disabled,onBusy,onReady,hints}){
 const [loading,setLoading]=useState(false),[error,setError]=useState('');
 async function suggest(){
  if(loading||disabled)return;setLoading(true);onBusy(true);setError('');
  try{const suggestion=await call('plan-suggest',{organizationId,month,rawText:form.originalText});
   setForm(old=>({...old,content:suggestion.content,qualityStandard:suggestion.qualityStandard,startDate:suggestion.startDate??old.startDate,endDate:suggestion.endDate??old.endDate,responsible:suggestion.responsible??null,annualId:old.responsible?.personId===suggestion.responsible?.personId?old.annualId:''}));onReady(suggestion);
  }catch(failure){setError(failure.message);}
  finally{setLoading(false);onBusy(false);}
 }
 return <div className="hct-compose">
  {hints.length>0&&<p id="hct-annual-suggestion" className="hct-compose-suggestion">根据年度计划，建议本月提报{hints.map(row=>`“${row.content}”`).join('、')}。</p>}
  <textarea id="hct-raw" className="hct-compose-input" aria-describedby={hints.length>0?'hct-annual-suggestion':undefined} maxLength={1500} value={form.originalText??''} disabled={disabled||loading} onChange={event=>{setForm(old=>({...old,originalText:event.target.value}));setError('');}}/>
  {error&&<p role="alert" className="hct-alert">{error}</p>}
  <div className="hct-compose-actions"><Button variant="ghost" disabled={disabled||loading} onClick={()=>{setForm(old=>({...old,content:old.content||old.originalText?.slice(0,500)||''}));onReady();}}>直接填写</Button><Button loading={loading} disabled={disabled||loading||(form.originalText??'').trim().length<4} onClick={()=>void suggest()}>整理计划</Button></div>
 </div>;
}

export function PlanReferences({reference}){
 if(!reference)return null;
 return (<details><summary>本次参考语料 · {reference.retrieval?.mode==='semantic'?'语义检索':'文本检索'}</summary>
   {reference.retrieval?.reason&&<p>{({unconfigured:'未配置向量模型，使用文本检索。',indexing:'索引建立中，暂用文本检索。',failed:'部分语料索引失败，暂用文本检索。'})[reference.retrieval.reason]}</p>}
   {reference.sources?.length?<ul>{reference.sources.map(source=><li key={`${source.libraryId}-${source.id}`}>{source.title} · v{source.version}<br/><small>{source.id}</small></li>)}</ul>:<p>未检索到参考语料。</p>}
  </details>);
}
