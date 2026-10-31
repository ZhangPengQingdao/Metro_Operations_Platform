import {useEffect,useRef,useState} from 'react';
import {Button,Input,Textarea} from '../../components/ui';
import {adminRequest} from './client';

type Kind='rerank'|'asr';
type Config={endpoint:string;model:string;timeoutMs:number;language?:string;hasApiKey:boolean;configured:boolean};
type TestResult={latencyMs:number;text?:string;results?:{index:number;relevance_score:number;text:string}[]};
const labels={rerank:'重排序模型',asr:'语音识别模型'};
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
 const [result,setResult]=useState<TestResult|null>(null),[audio,setAudio]=useState<File|null>(null),[reload,setReload]=useState(0);
 const form=useRef<HTMLFormElement>(null);
 const pendingSave=useRef<{signature:string;requestId:string}|null>(null);
 useEffect(()=>{
  const controller=new AbortController();
  adminRequest<Config>(`/${kind}`,{signal:controller.signal}).then(setConfig).catch(cause=>{
   if(!controller.signal.aborted)setError(cause instanceof Error?cause.message:'读取配置失败。');
  });
  return()=>controller.abort();
 },[kind,reload]);
 const clearFeedback=()=>{setError('');setStatus('');setResult(null);};
 const edit=(patch:Partial<Config>)=>{setConfig(current=>current?{...current,...patch}:current);clearFeedback();};
 async function run(action:'save'|'test'){
  if(!config||busy||!form.current?.reportValidity())return;
  if(action==='test'&&kind==='asr'&&!audio){setError('请先选择用于测试的短音频。');return;}
  setBusy(action);onBusy(true);clearFeedback();
  const input={endpoint:config.endpoint,model:config.model,timeoutMs:config.timeoutMs,
   ...(kind==='asr'?{language:config.language??''}:{}),...(apiKey.trim()?{apiKey:apiKey.trim()}:{})};
  try{
   if(action==='save'){
    const signature=JSON.stringify(input);
    if(pendingSave.current?.signature!==signature)pendingSave.current={signature,requestId:crypto.randomUUID()};
    const next=await adminRequest<Config>(`/${kind}/save`,{method:'POST',body:{...input,requestId:pendingSave.current.requestId}});
    setConfig(next);setApiKey('');pendingSave.current=null;setStatus('配置已保存。');
   }else{
    const sample=kind==='asr'&&audio?{audio:{format:audio.name.split('.').pop()!.toLowerCase(),data:await readAudio(audio)}}:{};
    const next=await adminRequest<TestResult>(`/${kind}/test`,{method:'POST',body:{...input,...sample}});
    setResult(next);setStatus(`测试完成 · ${next.latencyMs} ms${kind==='asr'&&!next.text?.trim()?' · 未识别到文字，请确认音频中包含清晰语音。':''}`);
   }
  }catch(cause){setError(cause instanceof Error?cause.message:'操作失败。');}
  finally{setBusy('');onBusy(false);}
 }
 return <section>
  <p className="admin-model-description">{kind==='rerank'?'用于检索候选的相关性排序。支持返回 results 的 Rerank 接口。当前提供配置与连接测试，尚未接入知识库检索。':'用于将音频转成文字。支持 OpenAI 兼容的音频转写接口。当前提供配置与转写测试，尚未替换应用内的语音识别。'}</p>
  {!config&&!error&&<p role="status">正在读取配置…</p>}
  {!config&&error&&<><p className="afc-error" role="alert">{error}</p><Button variant="secondary" onClick={()=>{setError('');setReload(value=>value+1);}}>重新读取</Button></>}
  {config&&<form ref={form} className="admin-form" autoComplete="off" onSubmit={event=>{event.preventDefault();void run('save');}}>
   <label>服务地址<Input required type="url" maxLength={500} value={config.endpoint} disabled={!!busy}
    placeholder={kind==='rerank'?'https://api.example.com/v1/rerank':'https://api.example.com/v1/audio/transcriptions'} onChange={event=>edit({endpoint:event.target.value})}/><small>填写完整接口地址；更换地址时需重新填写密钥。</small></label>
   <label>API Key<Input type="password" autoComplete="new-password" maxLength={4096} value={apiKey} disabled={!!busy}
    placeholder={config.hasApiKey?'已保存 · 留空保留':'请输入 API Key'} onChange={event=>{setApiKey(event.target.value);clearFeedback();}}/></label>
   <label>模型 ID<Input required maxLength={120} value={config.model} disabled={!!busy} onChange={event=>edit({model:event.target.value})}/></label>
   <label>请求超时（毫秒）<Input required type="number" min={5000} max={120000} step={1} value={config.timeoutMs} disabled={!!busy} onChange={event=>edit({timeoutMs:Number(event.target.value)})}/></label>
   {kind==='asr'&&<>
    <label>识别语言<Input maxLength={2} pattern="[a-z]{2}" placeholder="留空自动识别，例如 zh" value={config.language??''} disabled={!!busy} onChange={event=>edit({language:event.target.value})}/></label>
    <label>测试音频<Input type="file" accept=".wav,.mp3,.m4a,.webm,.ogg" disabled={!!busy} onChange={event=>{
     const file=event.target.files?.[0]??null;clearFeedback();
     if(file&&(!file.size||file.size>audioLimit||!/\.(wav|mp3|m4a|webm|ogg)$/i.test(file.name))){
      setAudio(null);event.target.value='';setError('请选择不超过 2 MiB 的 WAV、MP3、M4A、WebM 或 OGG 短音频。');return;
     }
     setAudio(file);
    }}/><small>最多 2 MiB。仅点击“测试转写”时发送到所填服务，保存配置不会上传音频。</small></label>
   </>}
   {kind==='rerank'&&<p className="afc-muted">连接测试使用两条内置示例，不发送知识库内容。</p>}
   {error&&<p className="afc-error" role="alert">{error}</p>}
   {status&&<p role="status">{status}</p>}
   {result?.results&&<ol className="admin-model-results">{result.results.map(row=><li key={row.index}>{row.text}<small>相关性分数：{row.relevance_score.toFixed(4)}</small></li>)}</ol>}
   {result?.text!==undefined&&<label>转写结果<Textarea readOnly rows={5} value={result.text}/></label>}
   <div className="admin-actions">
    <Button variant="secondary" disabled={!!busy||!config.endpoint||!config.model||(kind==='asr'&&!audio)} loading={busy==='test'} onClick={()=>void run('test')}>{kind==='asr'?'测试转写':'测试连接'}</Button>
    <Button type="submit" disabled={!!busy||!config.endpoint||!config.model} loading={busy==='save'}>保存{labels[kind]}配置</Button>
   </div>
  </form>}
 </section>;
}
