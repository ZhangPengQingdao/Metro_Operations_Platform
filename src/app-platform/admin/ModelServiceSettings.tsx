import {useEffect,useRef,useState} from 'react';
import {Button,Input,Select,Textarea} from '../../components/ui';
import {adminRequest} from './client';

type Kind='rerank'|'asr'|'streaming-asr';
type Protocol='openai'|'doubao-asr'|'doubao-streaming';
type Config={protocol?:Protocol;resourceId?:string;endpoint:string;model:string;timeoutMs:number;language?:string;hasApiKey:boolean;configured:boolean};
type TestResult={latencyMs:number;text?:string;taskId?:string;pending?:boolean;partialCount?:number;results?:{index:number;relevance_score:number;text:string}[]};
const labels={rerank:'重排序模型',asr:'语音识别模型','streaming-asr':'流式语音识别'};
const doubaoEndpoint='https://openspeech.bytedance.com/api/v3/auc/bigmodel/submit';
const streamingEndpoint='wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async';
const audioLimit=2*1024*1024;
function readAudio(file:File):Promise<string>{
 return new Promise((resolve,reject)=>{
  const reader=new FileReader();
  reader.onload=()=>resolve(String(reader.result).split(',')[1]);
  reader.onerror=()=>reject(new Error('读取音频失败，请重新选择文件。'));
  reader.readAsDataURL(file);
 });
}

export function ModelServiceSettings({kind,onBusy}:{kind:Kind;onBusy:(busy:boolean)=>void}){
 const [config,setConfig]=useState<Config|null>(null),[apiKey,setApiKey]=useState('');
 const [busy,setBusy]=useState(''),[error,setError]=useState(''),[status,setStatus]=useState('');
 const [result,setResult]=useState<TestResult|null>(null),[audio,setAudio]=useState<File|null>(null),[audioUrl,setAudioUrl]=useState(''),[audioFormat,setAudioFormat]=useState('mp3'),[reload,setReload]=useState(0);
 const form=useRef<HTMLFormElement>(null),active=useRef<AbortController|null>(null);
 const pendingSave=useRef<{signature:string;requestId:string}|null>(null);
 const streaming=kind==='streaming-asr',doubao=kind==='asr'&&config?.protocol==='doubao-asr';
 useEffect(()=>{
  const controller=new AbortController();
  adminRequest<Config>(`/${kind}`,{signal:controller.signal}).then(value=>setConfig(streaming&&!value.configured?{...value,endpoint:streamingEndpoint,model:'bigmodel'}:value)).catch(cause=>{
   if(!controller.signal.aborted)setError(cause instanceof Error?cause.message:'读取配置失败。');
  });
  return()=>{controller.abort();active.current?.abort();};
 },[kind,reload,streaming]);
 const clearFeedback=()=>{setError('');setStatus('');setResult(null);};
 const edit=(patch:Partial<Config>)=>{setConfig(current=>current?{...current,...patch}:current);clearFeedback();};
 async function run(action:'save'|'test'|'query'){
  if(!config||busy||!form.current?.reportValidity())return;
  if(action==='test'&&kind!=='rerank'&&(doubao?!audioUrl:!audio)){setError(doubao?'请填写用于测试的公网音频地址。':'请先选择用于测试的短音频。');return;}
  const taskId=result?.taskId;
  if(action==='query'&&!taskId)return;
  setBusy(action);onBusy(true);setError('');setStatus('');
  if(action==='test')setResult(null);
  const controller=new AbortController();active.current=controller;
  const input={endpoint:config.endpoint,model:config.model,timeoutMs:config.timeoutMs,
   ...(kind==='asr'?{protocol:config.protocol??'openai',language:doubao?'':config.language??'',...(doubao?{resourceId:config.resourceId??'volc.seedasr.auc'}:{})}:{}),
   ...(streaming?{protocol:'doubao-streaming',resourceId:config.resourceId??'volc.seedasr.sauc.duration'}:{}),...(apiKey.trim()?{apiKey:apiKey.trim()}:{})};
  try{
   if(action==='save'){
    const signature=JSON.stringify(input);
    if(pendingSave.current?.signature!==signature)pendingSave.current={signature,requestId:crypto.randomUUID()};
    const next=await adminRequest<Config>(`/${kind}/save`,{method:'POST',body:{...input,requestId:pendingSave.current.requestId},signal:controller.signal});
    setConfig(next);setApiKey('');pendingSave.current=null;setStatus('配置已保存。');
   }else{
    const sample=action==='query'?{taskId}:doubao?{urlAudio:{url:audioUrl,format:audioFormat}}:kind!=='rerank'&&audio?{audio:{format:audio.name.split('.').pop()!.toLowerCase(),data:await readAudio(audio)}}:{};
    let next=await adminRequest<TestResult>(`/${kind}/${action}`,{method:'POST',body:{...input,...sample},signal:controller.signal});
    setResult(next);
    // Querying is read-only. Submit exactly once, then retain the task for a later query if still queued.
    if(action==='test'&&doubao&&next.pending&&next.taskId){
     const id=next.taskId;
     for(let attempt=0;attempt<3&&next.pending;attempt++){
      await new Promise<void>(resolve=>setTimeout(resolve,1000));controller.signal.throwIfAborted();
      next=await adminRequest<TestResult>('/asr/query',{method:'POST',body:{...input,taskId:id},signal:controller.signal});setResult(next);
     }
    }
    setStatus(next.pending?'任务仍在处理，可点击“查询转写结果”继续查询，无需重复提交。':`测试完成 · ${next.latencyMs} ms${streaming?` · 收到 ${next.partialCount??0} 次识别结果`:''}${kind!=='rerank'&&!next.text?.trim()?' · 未识别到文字，请确认音频中包含清晰语音。':''}`);
   }
  }catch(cause){if(!controller.signal.aborted)setError(cause instanceof Error?cause.message:'操作失败。');}
  finally{active.current=null;setBusy('');onBusy(false);}
 }
 return <section>
  <p className="admin-model-description">{kind==='rerank'?'用于检索候选的相关性排序。当前提供配置与连接测试，尚未接入知识库检索。':streaming?'用于会议、语音输入等边说边转写场景。短音频测试会分段发送并检查最终结果；应用内实时录音需另外接入。':'用于会后录音等音频转文字场景。选择服务协议后填写对应密钥，当前提供配置与转写测试。'}</p>
  {!config&&!error&&<p role="status">正在读取配置…</p>}
  {!config&&error&&<><p className="afc-error" role="alert">{error}</p><Button variant="secondary" onClick={()=>{setError('');setReload(value=>value+1);}}>重新读取</Button></>}
  {config&&<form ref={form} className="admin-form" autoComplete="off" onSubmit={event=>{event.preventDefault();void run('save');}}>
   <label>接口协议<Select value={kind==='rerank'?'rerank':streaming?'doubao-streaming':config.protocol??'openai'} disabled={!!busy} onChange={event=>{
    const protocol=event.target.value as Protocol;setApiKey('');setAudio(null);setAudioUrl('');
    edit({protocol,endpoint:protocol==='doubao-asr'?doubaoEndpoint:'',model:protocol==='doubao-asr'?'bigmodel':'',language:'',resourceId:protocol==='doubao-asr'?'volc.seedasr.auc':undefined,hasApiKey:false});
   }}>{kind==='rerank'?<option value="rerank">Rerank 兼容</option>:streaming?<option value="doubao-streaming">豆包语音 · WebSocket 流式识别</option>:<><option value="openai">OpenAI 兼容</option><option value="doubao-asr">豆包语音 · 录音文件识别</option></>}</Select></label>
   <label>服务地址<Input required type={streaming?'text':'url'} pattern={streaming?'wss://.*':undefined} maxLength={500} value={config.endpoint} disabled={!!busy}
    placeholder={kind==='rerank'?'https://api.example.com/v1/rerank':streaming?streamingEndpoint:doubao?doubaoEndpoint:'https://api.example.com/v1/audio/transcriptions'} onChange={event=>edit({endpoint:event.target.value})}/><small>填写完整接口地址；更换协议或地址时需重新填写密钥。</small></label>
   <label>API Key<Input type="password" autoComplete="new-password" maxLength={4096} value={apiKey} disabled={!!busy}
    placeholder={config.hasApiKey?'已保存 · 留空保留':'请输入 API Key'} onChange={event=>{setApiKey(event.target.value);clearFeedback();}}/>{(doubao||streaming)&&<small>使用豆包语音控制台的 API Key，需开通所选资源。</small>}</label>
   {doubao||streaming?<label>识别资源<Select value={config.resourceId??(streaming?'volc.seedasr.sauc.duration':'volc.seedasr.auc')} disabled={!!busy} onChange={event=>edit({resourceId:event.target.value})}>
    {streaming?<><option value="volc.seedasr.sauc.duration">豆包 ASR 2.0 · 按时长</option><option value="volc.seedasr.sauc.concurrent">豆包 ASR 2.0 · 按并发</option><option value="volc.bigasr.sauc.duration">豆包 ASR 1.0 · 按时长</option><option value="volc.bigasr.sauc.concurrent">豆包 ASR 1.0 · 按并发</option></>:<><option value="volc.seedasr.auc">豆包录音识别 2.0</option><option value="volc.bigasr.auc">豆包录音识别 1.0</option></>}
   </Select></label>:<label>模型 ID<Input required maxLength={120} value={config.model} disabled={!!busy} onChange={event=>edit({model:event.target.value})}/></label>}
   <label>请求超时（毫秒）<Input required type="number" min={5000} max={120000} step={1} value={config.timeoutMs} disabled={!!busy} onChange={event=>edit({timeoutMs:Number(event.target.value)})}/></label>
   {kind==='asr'&&!doubao&&<label>识别语言<Input maxLength={2} pattern="[a-z]{2}" placeholder="留空自动识别，例如 zh" value={config.language??''} disabled={!!busy} onChange={event=>edit({language:event.target.value})}/></label>}
   {doubao?<>
    <label>测试音频 URL<Input type="url" maxLength={2048} placeholder="https://…/meeting.mp3" value={audioUrl} disabled={!!busy} onChange={event=>{setAudioUrl(event.target.value);clearFeedback();}}/><small>使用公网 HTTPS 音频直链，不含账号或查询参数。仅测试时发送给豆包，保存配置不会提交音频。</small></label>
    <label>测试音频格式<Select value={audioFormat} disabled={!!busy} onChange={event=>{setAudioFormat(event.target.value);clearFeedback();}}><option value="mp3">MP3</option><option value="wav">WAV</option><option value="ogg">OGG</option></Select></label>
   </>:kind!=='rerank'&&<label>测试音频<Input type="file" accept={streaming?'.wav':'.wav,.mp3,.m4a,.webm,.ogg'} disabled={!!busy} onChange={event=>{
    const file=event.target.files?.[0]??null;clearFeedback();
    if(file&&(!file.size||file.size>audioLimit||!(streaming?/\.wav$/i:/\.(wav|mp3|m4a|webm|ogg)$/i).test(file.name))){
     setAudio(null);event.target.value='';setError(streaming?'请选择不超过 2 MiB 的 WAV 短音频。':'请选择不超过 2 MiB 的 WAV、MP3、M4A、WebM 或 OGG 短音频。');return;
    }
    setAudio(file);
   }}/><small>{streaming?'使用不超过 30 秒、16 kHz、单声道、16 位 PCM 的 WAV；按实际语速分段发送。':'最多 2 MiB。'} 仅测试时发送音频，保存配置不会上传。</small></label>}
   {kind==='rerank'&&<p className="afc-muted">连接测试使用两条内置示例，不发送知识库内容。</p>}
   {error&&<p className="afc-error" role="alert">{error}</p>}
   {status&&<p role="status">{status}</p>}
   {result?.pending&&<p className="afc-muted admin-model-task">识别任务：{result.taskId}</p>}
   {result?.results&&<ol className="admin-model-results">{result.results.map(row=><li key={row.index}>{row.text}<small>相关性分数：{row.relevance_score.toFixed(4)}</small></li>)}</ol>}
   {result?.text!==undefined&&<label>转写结果<Textarea readOnly rows={5} value={result.text}/></label>}
   <div className="admin-actions">
    <Button variant="secondary" disabled={!!busy||!config.endpoint||!config.model||(kind!=='rerank'&&(doubao?!audioUrl:!audio))} loading={busy==='test'||busy==='query'} onClick={()=>void run(result?.pending?'query':'test')}>{result?.pending?'查询转写结果':kind==='rerank'?'测试连接':'测试转写'}</Button>
    <Button type="submit" disabled={!!busy||!config.endpoint||!config.model} loading={busy==='save'}>保存{labels[kind]}配置</Button>
   </div>
  </form>}
 </section>;
}
