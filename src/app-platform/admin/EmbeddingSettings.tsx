import {useEffect,useState} from 'react';
import {Button,Input,Switch} from '../../components/ui';
import {adminRequest} from './client';
type Config={enabled:boolean;endpoint:string;model:string;dimensions:number;minScore:number;timeoutMs:number;hasApiKey:boolean};
export function EmbeddingSettings({disabled,onBusy}:{disabled:boolean;onBusy:(busy:boolean)=>void}){
 const [form,setForm]=useState<Config|null>(null),[key,setKey]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[status,setStatus]=useState('');
 useEffect(()=>{const abort=new AbortController();adminRequest<Config>('/embedding',{signal:abort.signal}).then(setForm).catch(error=>{if(!abort.signal.aborted)setError(error.message);});return()=>abort.abort();},[]);
 async function run(action:'save'|'test'){
  if(!form)return;setBusy(true);onBusy(true);setError('');setStatus('');
  const input={enabled:form.enabled,endpoint:form.endpoint,model:form.model,dimensions:form.dimensions,timeoutMs:form.timeoutMs,minScore:form.minScore};
  try{const result=await adminRequest<Config&{dimensions:number}>(`/embedding/${action}`,{method:'POST',body:{...input,...(key?{apiKey:key}:{})}});
   if(action==='save'){setForm(result);setKey('');setStatus('已保存；模型变化后会自动重建索引。');}else setStatus(`连接正常，返回 ${result.dimensions} 维向量。`);
  }catch(error){setError(error instanceof Error?error.message:'操作失败');}finally{setBusy(false);onBusy(false);}
 }
 return <section><h3>知识库向量模型</h3><p>用于检索语料，独立于聊天模型。未启用时使用文本检索。维度填写模型原生输出维度。</p>{error&&<p role="alert" className="afc-error">{error}</p>}{form&&<form className="admin-form" autoComplete="off" onSubmit={e=>{e.preventDefault();void run('save');}}>
 <Switch label="启用语义检索" checked={form.enabled} disabled={disabled||busy} onChange={e=>setForm({...form,enabled:e.target.checked})}/>
 <label>向量服务地址<Input required type="url" placeholder="https://api.example.com/v1/embeddings" value={form.endpoint} disabled={disabled||busy} onChange={e=>setForm({...form,endpoint:e.target.value})}/></label>
 <label>向量 API Key<Input type="password" autoComplete="new-password" value={key} placeholder={form.hasApiKey?'已保存 · 留空保留':'请输入 API Key'} disabled={disabled||busy} onChange={e=>setKey(e.target.value)}/></label>
 <label>向量模型 ID<Input required value={form.model} disabled={disabled||busy} onChange={e=>setForm({...form,model:e.target.value})}/></label>
 <label>向量维度<Input required type="number" min={1} max={4096} value={form.dimensions} disabled={disabled||busy} onChange={e=>setForm({...form,dimensions:Number(e.target.value)})}/></label>
 <label>最低相似度<Input required type="number" min={0} max={1} step={0.01} value={form.minScore} disabled={disabled||busy} onChange={e=>setForm({...form,minScore:Number(e.target.value)})}/><small>按实际语料调节，越高越严格；调整后无需重建索引。</small></label>
 {status&&<p role="status">{status}</p>}<div className="admin-actions"><Button variant="secondary" disabled={disabled||busy||!form.model||!form.endpoint} onClick={()=>void run('test')}>测试向量连接</Button><Button type="submit" disabled={disabled||busy} loading={busy}>保存向量配置</Button></div>
 </form>}</section>;
}
