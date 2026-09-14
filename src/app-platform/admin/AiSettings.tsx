import React,{useEffect,useState} from 'react';
import {Button,Input} from '../../components/ui';
import {adminRequest} from './client';
type Config={external:{endpoint:string;model:string;has_api_key:boolean;api_key_mask:string;timeout_ms:number;reasoning_effort:string;configured:boolean}};
export function AiSettings(){
 const [config,setConfig]=useState<Config|null>(null),[endpoint,setEndpoint]=useState(''),[apiKey,setKey]=useState(''),[model,setModel]=useState(''),[models,setModels]=useState<string[]>([]),[busy,setBusy]=useState(''),[error,setError]=useState(''),[status,setStatus]=useState('');
 useEffect(()=>{const abort=new AbortController();adminRequest<Config>('/ai',{signal:abort.signal}).then(value=>{setConfig(value);setEndpoint(value.external.endpoint);setModel(value.external.model);}).catch(e=>{if(!abort.signal.aborted)setError(e instanceof Error?e.message:'读取失败');});return()=>abort.abort();},[]);
 async function run(action:'save'|'models'|'test'){
  if(busy)return;setBusy(action);setError('');setStatus('');
  const body={endpoint,model,...(apiKey?{apiKey}:{}),timeoutMs:config?.external.timeout_ms??120000,reasoningEffort:config?.external.reasoning_effort??'auto'};
  try{
   if(action==='save'){const next=await adminRequest<Config>('/ai/save',{method:'POST',body});setConfig(next);setEndpoint(next.external.endpoint);setKey('');setStatus('已保存');}
   if(action==='models'){const next=await adminRequest<{models:string[]}>('/ai/models',{method:'POST',body});setModels(next.models);setStatus(`已获取 ${next.models.length} 个模型`);}
   if(action==='test'){const next=await adminRequest<{latency_ms:number}>('/ai/test',{method:'POST',body});setStatus(`连接正常 · ${next.latency_ms} ms`);}
  }catch(e){setError(e instanceof Error?e.message:'操作失败');}finally{setBusy('');}
 }
 return <section><div className="admin-heading"><h2>大模型接入</h2><span className="admin-status">OpenAI 兼容</span></div><form autoComplete="off" className="admin-form" onSubmit={e=>{e.preventDefault();void run('save');}}>
  <label>服务地址<Input required name="ai-provider-endpoint" autoComplete="off" type="url" placeholder="https://api.example.com/v1" maxLength={500} value={endpoint} onChange={e=>{setEndpoint(e.target.value);setModels([]);setStatus('');}} disabled={!!busy}/></label>
  <label>API Key<Input name="ai-provider-key" type="password" autoComplete="new-password" placeholder={config?.external.has_api_key?'已保存 · 留空保留':'请输入 API Key'} value={apiKey} onChange={e=>setKey(e.target.value)} disabled={!!busy}/></label>
  <label>模型<Input required list="admin-ai-models" placeholder="模型 ID" value={model} onChange={e=>setModel(e.target.value)} disabled={!!busy}/><datalist id="admin-ai-models">{models.map(id=><option value={id} key={id}/>)}</datalist></label>
  {error&&<p className="afc-error" role="alert">{error}</p>}{status&&<p role="status">{status}</p>}
  <div className="admin-actions"><Button variant="secondary" disabled={!!busy||!endpoint} onClick={()=>void run('models')}>获取模型</Button><Button variant="secondary" disabled={!!busy||!endpoint||!model} onClick={()=>void run('test')}>测试连接</Button><Button type="submit" loading={busy==='save'} disabled={!!busy||!endpoint||!model}>保存</Button></div>
 </form></section>;
}
