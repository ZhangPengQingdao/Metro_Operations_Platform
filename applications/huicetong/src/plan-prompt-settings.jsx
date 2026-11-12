import {useEffect,useRef,useState} from 'react';
import {Button,Input,Field} from '@metro/platform-sdk/ui';
import {PlanReferences} from './plan-assistant.jsx';
import {PLAN_PROMPT_MAX_LENGTH} from './plan-prompt.mjs';
import {shanghaiDay,validMonth} from './reform-rules.mjs';

export function PlanPromptSettings(props){
 const [kind,setKind]=useState('organize');
 return <div>
  <div className="hct-actions hct-prompt-types" role="group" aria-label="提示词类型">
   <Button size="sm" variant={kind==='organize'?'primary':'secondary'} aria-pressed={kind==='organize'} onClick={()=>setKind('organize')}>计划整理</Button>
   <Button size="sm" variant={kind==='summary'?'primary':'secondary'} aria-pressed={kind==='summary'} onClick={()=>setKind('summary')}>计划总结</Button>
  </div>
  <div hidden={kind!=='organize'}><PromptEditor {...props} kind="organize"/></div>
  <div hidden={kind!=='summary'}><PromptEditor {...props} kind="summary"/></div>
 </div>;
}

function PromptEditor({organizationId,call,perform,busy,blocked,externalError,kind}){
 const isSummary=kind==='summary',label=isSummary?'计划总结':'计划整理';
 const [config,setConfig]=useState(null),[prompt,setPrompt]=useState(''),[loading,setLoading]=useState(true),[reload,setReload]=useState(0);
 const [rawText,setRawText]=useState(isSummary?'已完成站台设备巡检并提交巡检记录。备件盘点仍在进行，计划月底完成。':'开展风险辨识工作'),[month,setMonth]=useState(shanghaiDay().slice(0,7)),[result,setResult]=useState(null),[testing,setTesting]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const testRequest=useRef(null),alive=useRef(true);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;testRequest.current?.abort();};},[]);
 useEffect(()=>{
  const controller=new AbortController();setLoading(true);setError('');setNotice('');setResult(null);
  call('plan-prompt-get',{organizationId,kind},false,{signal:controller.signal}).then(value=>{if(!controller.signal.aborted){setConfig(value);setPrompt(value.prompt);}}).catch(failure=>{if(!controller.signal.aborted)setError(failure.message);}).finally(()=>{if(!controller.signal.aborted)setLoading(false);});
  return()=>controller.abort();
 },[organizationId,call,reload,kind]);
 const disabled=busy||blocked||testing||loading,dirty=!!config&&prompt!==config.prompt;
 const changePrompt=value=>{setPrompt(value);setResult(null);setNotice('');setError('');};
 const save=()=>perform(async()=>{
  setNotice('');setError('');
  const value=await call('plan-prompt-save',{organizationId,kind,prompt,expectedVersion:config.version,requestId:crypto.randomUUID()},true);
  if(alive.current){setConfig(old=>({...old,...value}));setPrompt(value.prompt);setNotice(`已保存，后续${label}将使用此提示词。`);}
 });
 async function test(){
  if(disabled||testRequest.current)return;
  const controller=new AbortController();testRequest.current=controller;setTesting(true);setError('');setResult(null);setNotice('');
  try{const value=await call('plan-prompt-test',{organizationId,kind,prompt,rawText,month},false,{signal:controller.signal});if(!controller.signal.aborted)setResult(value);}
  catch(failure){if(!controller.signal.aborted)setError(failure.message);}
  finally{if(!controller.signal.aborted)setTesting(false);testRequest.current=null;}
 }
 return <div className="hct-prompt-settings">
  <p className="hct-muted">{isSummary?'设置本部门多选生成月度计划总结时使用的提示词。':'设置本部门月度计划的整理方式，月度提报和统一对话共用。'}</p>
  {(error||externalError)&&<p role="alert" className="hct-alert">{error||externalError}</p>}
  {loading?<p role="status">正在读取提示词…</p>:config?<>
   <Field label={label+'提示词'} htmlFor={kind+'-prompt'} hint={`${prompt.length} / ${PLAN_PROMPT_MAX_LENGTH} 字 · ${dirty?'有未保存修改':config.version?'已保存版本 '+config.version:'默认提示词'}`}>
    <textarea id={kind+'-prompt'} className="afc-control afc-control--textarea hct-prompt-editor" rows={14} value={prompt} maxLength={PLAN_PROMPT_MAX_LENGTH} disabled={disabled} onChange={event=>changePrompt(event.target.value)}/>
   </Field>
   <div className="hct-actions">
    <Button loading={busy} disabled={disabled||!dirty||!prompt.trim()} onClick={()=>void save()}>保存提示词</Button>
    <Button variant="secondary" disabled={disabled||prompt===config.defaultPrompt} onClick={()=>changePrompt(config.defaultPrompt)}>恢复默认</Button>
    <Button variant="ghost" disabled={disabled} onClick={()=>setReload(value=>value+1)}>重新读取</Button>
   </div>
   {notice&&<p role="status" className="hct-muted">{notice}</p>}
   <section className="hct-section" aria-label="提示词测试">
    <h2>测试{isSummary?'总结':'整理'}效果</h2>
    <p className="hct-muted">{isSummary?'使用示例计划内容和当前提示词生成预览。':'使用本部门语料和当前提示词生成预览。'}</p>
    <div className="hct-form">
     <Field label="计划月份" htmlFor={kind+'-test-month'}><Input id={kind+'-test-month'} type="month" min="2000-01" max="2100-12" value={month} disabled={disabled} onChange={event=>{setMonth(event.target.value);setResult(null);}}/></Field>
     <Field className="hct-wide" label={isSummary?'示例计划内容':'测试原话'} htmlFor={kind+'-test-text'}><textarea id={kind+'-test-text'} className="afc-control afc-control--textarea" maxLength={1500} value={rawText} disabled={disabled} onChange={event=>{setRawText(event.target.value);setResult(null);}}/></Field>
    </div>
    <Button variant="secondary" loading={testing} disabled={disabled||!prompt.trim()||!rawText.trim()||!validMonth(month)} onClick={()=>void test()}>测试当前提示词</Button>
    {result&&<div className="hct-prompt-result" aria-label="测试结果" role="region">
     <h2>测试结果</h2>
     {isSummary?<p className="hct-summary-text">{result.summary}</p>:<><dl className="hct-detail-fields"><dt>工作计划内容</dt><dd>{result.content}</dd><dt>完成质量标准</dt><dd>{result.qualityStandard}</dd><dt>开始日期 / 完成日期</dt><dd>{result.startDate} / {result.endDate}</dd></dl>
     <PlanReferences reference={result}/></>}
    </div>}
   </section>
  </>:<Button variant="secondary" disabled={disabled} onClick={()=>setReload(value=>value+1)}>重新读取提示词</Button>}
 </div>;
}
