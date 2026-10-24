import {useState} from 'react';
import {Button} from '@metro/platform-sdk/ui';

export function PlanAssistant({call,organizationId,month,form,setForm,disabled,onBusy,onReady}){
 const [loading,setLoading]=useState(false),[error,setError]=useState('');
 async function suggest(){
  if(loading||disabled)return;setLoading(true);onBusy(true);setError('');
  try{const suggestion=await call('plan-suggest',{organizationId,month,rawText:form.originalText});
   setForm(old=>({...old,content:suggestion.content,qualityStandard:suggestion.qualityStandard,categoryId:suggestion.categoryId??'',startDate:suggestion.startDate??'',endDate:suggestion.endDate??''}));onReady(suggestion.missingInfo??[]);
  }catch(failure){setError(failure.message+'，可直接填写。');}
  finally{setLoading(false);onBusy(false);}
 }
 return <section className="hct-compose" aria-label="一句话提报计划">
  <label htmlFor="hct-raw" className="hct-compose-title">这个月，准备做什么？</label>
  <textarea id="hct-raw" className="hct-compose-input" maxLength={1500} value={form.originalText??''} disabled={disabled||loading} placeholder="例如：月底前完成三号线设备隐患排查，形成问题清单和整改建议。" onChange={event=>{setForm(old=>({...old,originalText:event.target.value}));setError('');}}/>
  {error&&<p role="alert" className="hct-alert">{error}</p>}
  <div className="hct-compose-actions"><Button variant="ghost" disabled={disabled||loading} onClick={()=>onReady([])}>直接填写</Button><Button loading={loading} disabled={disabled||loading||(form.originalText??'').trim().length<4} onClick={()=>void suggest()}>整理计划</Button></div>
 </section>;
}
