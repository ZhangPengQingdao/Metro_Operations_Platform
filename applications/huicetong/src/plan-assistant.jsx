import {useState} from 'react';
import {Button} from '@metro/platform-sdk/ui';

export function PlanAssistant({call,organizationId,month,form,setForm,disabled,onBusy,onReady}){
 const [loading,setLoading]=useState(false),[error,setError]=useState(''),[reference,setReference]=useState(null);
 async function suggest(){
  if(loading||disabled)return;setLoading(true);onBusy(true);setError('');setReference(null);
  try{const suggestion=await call('plan-suggest',{organizationId,month,rawText:form.originalText});
   setReference({sources:suggestion.sources,retrieval:suggestion.retrieval});
   setForm(old=>({...old,content:suggestion.content,qualityStandard:suggestion.qualityStandard,startDate:suggestion.startDate??'',endDate:suggestion.endDate??''}));onReady(suggestion.missingInfo??[]);
  }catch(failure){setError(failure.message);}
  finally{setLoading(false);onBusy(false);}
 }
 return <section className="hct-compose" aria-label="一句话提报计划">
  <label htmlFor="hct-raw" className="hct-compose-title">这个月，准备做什么？</label>
  <textarea id="hct-raw" className="hct-compose-input" maxLength={1500} value={form.originalText??''} disabled={disabled||loading} placeholder="描述本月工作计划" onChange={event=>{setForm(old=>({...old,originalText:event.target.value}));setError('');setReference(null);}}/>
  {error&&<p role="alert" className="hct-alert">{error}</p>}
  {reference&&<details><summary>本次参考语料 · {reference.retrieval?.mode==='semantic'?'语义检索':'文本检索'}</summary>
   {reference.retrieval?.reason&&<p>{({unconfigured:'未配置向量模型，使用文本检索。',indexing:'索引建立中，暂用文本检索。',failed:'部分语料索引失败，暂用文本检索。'})[reference.retrieval.reason]}</p>}
   {reference.sources?.length?<ul>{reference.sources.map(source=><li key={`${source.libraryId}-${source.id}`}>{source.title} · v{source.version}<br/><small>{source.id}</small></li>)}</ul>:<p>未检索到参考语料。</p>}
  </details>}
  <div className="hct-compose-actions"><Button variant="ghost" disabled={disabled||loading} onClick={()=>{setForm(old=>({...old,content:old.content||old.originalText?.slice(0,500)||''}));onReady([]);}}>直接填写</Button><Button loading={loading} disabled={disabled||loading||(form.originalText??'').trim().length<4} onClick={()=>void suggest()}>整理计划</Button></div>
 </section>;
}
