import {useEffect,useRef,useState} from 'react';
import {Button,Dialog,Checkbox,Field,Input,Plus,ArrowLineUp,ArrowLineDown,Trash} from '@metro/platform-sdk/ui';
import {saveAs} from '@metro/platform-sdk/app';
import {PersonPicker,responsibleFor} from './plan-fields.jsx';
import {createAudioRecorder,recordingLimits} from './audio-recorder.mjs';
import {createSpeechTranscriber} from './speech-transcriber.mjs';
import {readMinutes} from './meeting-source.mjs';

const time=value=>`${String(Math.floor(value/60)).padStart(2,'0')}:${String(value%60).padStart(2,'0')}`;
const makeRow=(values={})=>({id:crypto.randomUUID(),content:'',qualityStandard:'',endDate:'',responsible:null,remark:'',...values});
const audioFormats=/\.(mp3|wav|m4a|mp4|webm|ogg|aac)$/i;
const sourceErrors={
 ASR_FILE_PROTOCOL:'本地录音需要支持文件上传的语音模型，请联系管理员或改用会议纪要。',
 ASR_NOT_CONFIGURED:'尚未配置语音识别模型，可改用会议纪要。',
 INVALID_TEXT:'请使用 UTF-8 文本或 Word 纪要。',FILE_TOO_LARGE:'文件超过大小限制。',
 MODEL_PROVIDER_FAILED:'语音服务未能识别该文件，请核对模型和音频格式。'
};

function DraftRow({row,index,disabled,call,change,remove}){
 const field=(key,value)=>change({...row,[key]:value});
 return <article className="hct-draft">
  <header><strong>事项 {String(index+1).padStart(2,'0')}</strong><Button size="xs" variant="ghost" aria-label={`删除事项 ${index+1}`} disabled={disabled} onClick={remove}><Trash size={16}/></Button></header>
  <div className="hct-draft-grid">
   <Field label="督办要求" htmlFor={row.id+'-content'} required><textarea className="afc-control afc-control--textarea" id={row.id+'-content'} required disabled={disabled} value={row.content} maxLength={500} onChange={e=>field('content',e.target.value)}/></Field>
   <Field label="办结标准" htmlFor={row.id+'-quality'} required><textarea className="afc-control afc-control--textarea" id={row.id+'-quality'} required disabled={disabled} value={row.qualityStandard} maxLength={500} onChange={e=>field('qualityStandard',e.target.value)}/></Field>
   <Field label="完成时限" htmlFor={row.id+'-date'} required><Input type="date" id={row.id+'-date'} required disabled={disabled} value={row.endDate} onChange={e=>field('endDate',e.target.value)}/></Field>
   <Field label="责任人" htmlFor={row.id+'-owner'} required><PersonPicker id={row.id+'-owner'} kind="supervision" call={call} disabled={disabled} responsible={row.responsible} suggestedName={row.ownerName} onChange={p=>field('responsible',p)}/></Field>
  </div>
  <details><summary>备注</summary><Input aria-label={`事项 ${index+1} 备注`} disabled={disabled} value={row.remark} maxLength={500} onChange={e=>field('remark',e.target.value)}/></details>
 </article>;
}

export function SupervisionCreate({meeting,organizationId,call,files,confirm,disabled,onClose,onSaved,onDispatched}){
 const [stage,setStage]=useState(meeting?'record':'source'),[notes,setNotes]=useState(''),[audio,setAudio]=useState(null),[url,setUrl]=useState('');
 const [recordState,setRecordState]=useState('idle'),[seconds,setSeconds]=useState(0),[live,setLive]=useState(false),[speechState,setSpeechState]=useState('idle'),[interim,setInterim]=useState('');
 const [rows,setRows]=useState([]),[sent,setSent]=useState(0),[activity,setActivity]=useState(''),[error,setError]=useState('');
 const lock=useRef(false),recorder=useRef(null),lifetime=useRef(null),notesRef=useRef(''),liveRef=useRef(false);
 notesRef.current=notes;liveRef.current=live;
 const speechSupported=!!(globalThis.SpeechRecognition??globalThis.webkitSpeechRecognition);
 const recording=['requesting','recording','paused','stopping'].includes(recordState);
 const locked=disabled||!!activity,recognizing=['listening','starting'].includes(speechState);
 useEffect(()=>{
  const controller=new AbortController();lifetime.current=controller;
  const speech=createSpeechTranscriber({onText:setNotes,onInterim:setInterim,onState:setSpeechState,onError:setError});
  const mic=createAudioRecorder({onTime:setSeconds,onError:setError,onState:state=>{
   setRecordState(state);
   if(state==='recording'&&liveRef.current)speech.start(notesRef.current);
   else if(['paused','stopping','ready','idle'].includes(state))speech.stop();
  },onAudio:blob=>setAudio({blob,name:`会议录音.${blob.type.includes('mp4')?'m4a':blob.type.includes('ogg')?'ogg':'webm'}`})});
  recorder.current=mic;return()=>{controller.abort();mic.dispose();speech.dispose();};
 },[]);
 useEffect(()=>{if(!audio){setUrl('');return;}const src=URL.createObjectURL(audio.blob);setUrl(src);return()=>URL.revokeObjectURL(src);},[audio]);
 async function work(label,fn){
  if(lock.current||disabled)return;lock.current=true;setActivity(label);setError('');
  const signal=lifetime.current.signal;
  try{await fn(signal);}catch(e){if(!signal.aborted)setError(sourceErrors[e.code??e.message]??e.message);}
  finally{lock.current=false;if(!signal.aborted)setActivity('');}
 }
 async function close(){
  if(lock.current||disabled)return;
  if(recording||audio||notes.trim()||rows.length){
   if(!await confirm({title:'关闭本次督办？',message:recording?'录音将结束，尚未保存的内容会丢失。':'尚未派发的内容将不再保留。',confirmLabel:'关闭'}))return;
  }
  onClose();
 }
 function pickAudio(file){
  if(!file)return;
  if(!audioFormats.test(file.name)||!file.size||file.size>recordingLimits.bytes){setError('请选择 50 MiB 以内的有效音频文件。');return;}
  setError('');setAudio({blob:file,name:file.name});setNotes('');setStage('audio');
 }
 function pickMinutes(file){
  if(!file)return;
  void work('读取纪要',async signal=>{const value=await readMinutes(file);signal.throwIfAborted();setAudio(null);setNotes(value);setStage('notes');});
 }
 function extract(){
  void work('整理中',async signal=>{
   let source=notes.trim();
   if(!source&&audio){
    if(!files.transcribe)throw Error('请升级平台以启用录音转写。');
    setActivity('转写中');
    const result=await files.transcribe(audio.blob,audio.name.split('.').pop().toLowerCase(),{signal});
    signal.throwIfAborted();source=result.text.trim();setNotes(source);
    if(!source)throw Error('未识别到语音，可补充会议纪要。');
   }
   if(!source||source.length>11500)throw Error('每次可整理 1 至 11500 字，请调整会议纪要。');
   setActivity('整理中');
   const {items}=await call('supervision-extract',{notes:source},false,{signal});
   signal.throwIfAborted();
   if(!items.length)throw Error('未提取到督办事项，可补充会议纪要或手动填写。');
   const owners=new Map();
   for(const item of items){
    if(!item.ownerName||owners.has(item.ownerName))continue;
    const page=await call('members',{kind:'supervision',search:item.ownerName,exact:true},false,{signal});
    owners.set(item.ownerName,page.rows.length===1&&!page.nextCursor?responsibleFor(page.rows[0]):null);
   }
   signal.throwIfAborted();setRows(items.map(item=>makeRow({...item,responsible:owners.get(item.ownerName)??null})));setStage('review');
  });
 }
 function dispatch(event){
  event.preventDefault();
  void work('派发中',async signal=>{
   if(!rows.length)return;
   for(const [i,row] of rows.entries())if(!row.content.trim()||!row.qualityStandard.trim()||!row.endDate||!row.responsible)throw Error(`请补全事项 ${i+1} 的要求、标准、时限和责任人。`);
   for(const {id,ownerName,...draft} of rows){
    signal.throwIfAborted();
    await call('record-save',{kind:'supervision',id,requestId:crypto.randomUUID(),organizationId,draft},true);
    signal.throwIfAborted();setRows(old=>old.filter(row=>row.id!==id));setSent(n=>n+1);onDispatched();
   }
   onSaved();
  });
 }
 const manual=()=>{setRows([makeRow()]);setError('');setStage('review');};
 const fileInput=(label,accept,select)=> <label className="hct-upload-label">{label}<input aria-label={label} type="file" disabled={locked} accept={accept} onChange={e=>{const f=e.target.files?.[0];e.target.value='';select(f);}}/></label>;
 const title={source:'新增督办',record:'会议录音',notes:'会议纪要',audio:'会议录音',review:'确认督办'}[stage];
 return <Dialog open closeOnBackdropClick={false} onClose={()=>void close()} size={stage==='review'?'lg':'md'} title={title} footer={<div className="hct-footer">
  {stage==='review'?<><Button variant="ghost" className="hct-back" leadingIcon={<Plus size={15}/>} disabled={locked} onClick={()=>setRows(old=>[...old,makeRow()])}>新增一条</Button>{sent>0&&<small role="status">已派发 {sent} 条</small>}<Button type="submit" form="hct-dispatch" loading={!!activity} disabled={locked||!rows.length}>派发 {rows.length} 条</Button></>:
  stage!=='source'?<><Button variant="ghost" className="hct-back" disabled={locked||recording} onClick={manual}>手动填写</Button>{stage!=='record'&&<Button variant="secondary" disabled={locked} onClick={()=>{setError('');setStage('source');}}>返回</Button>}<Button disabled={locked||recording||recognizing||(!audio&&!notes.trim())} loading={!!activity} onClick={extract}>{activity||'整理为督办'}</Button></>:<Button variant="secondary" onClick={()=>void close()}>取消</Button>}
 </div>}>
  {error&&<p className="hct-alert" role="alert">{error}</p>}
  {stage==='source'&&<div className="hct-source">
   <label className="hct-source-choice"><ArrowLineUp size={20}/><span>上传录音</span><input type="file" aria-label="上传录音" accept="audio/*,.mp4,.m4a,.webm" disabled={locked} onChange={e=>pickAudio(e.target.files?.[0])}/></label>
   <Button variant="secondary" disabled={locked} onClick={()=>{setStage('notes');setAudio(null);setError('');}}>会议纪要</Button><Button variant="secondary" disabled={locked} onClick={manual}>手动填写</Button>
  </div>}
  {stage==='record'&&<>
   <div className="hct-recorder" data-recording={recordState==='recording'}><span role="status" className="hct-recorder-status">{{idle:'准备录音',requesting:'等待麦克风授权',recording:'正在录音',paused:'已暂停',stopping:'正在保存录音',ready:'录音已结束'}[recordState]}</span>
    <strong className="hct-recorder-time">{time(seconds)}</strong><div className="hct-actions">{recording?<><Button variant="secondary" disabled={locked||!['recording','paused'].includes(recordState)} onClick={()=>recordState==='paused'?recorder.current.resume():recorder.current.pause()}>{recordState==='paused'?'继续录音':'暂停'}</Button><Button disabled={locked||!['recording','paused'].includes(recordState)} onClick={()=>recorder.current.stop()}>结束录音</Button></>:<Button leadingIcon={<span className="hct-record-dot"/>} disabled={locked||recognizing} onClick={()=>{setError('');setNotes('');void recorder.current.start();}}>{audio?'重新录音':'开始录音'}</Button>}</div>
   </div>{speechSupported&&<div className="hct-speech-options"><label><Checkbox checked={live} disabled={locked||recording} onChange={e=>setLive(e.target.checked)}/>浏览器实时转写</label></div>}
  </>}
  {audio&&['audio','record'].includes(stage)&&!recording&&<div className="hct-audio-preview"><div className="hct-audio-heading"><span>{audio.name}</span><Button size="sm" variant="ghost" leadingIcon={<ArrowLineDown size={15}/>} onClick={()=>saveAs(audio.blob,audio.name)}>保存录音</Button></div><audio aria-label="回听会议录音" controls src={url}/></div>}
  {stage==='notes'&&fileInput('导入纪要 · Word / TXT / Markdown','.docx,.txt,.md',pickMinutes)}
  {(stage==='notes'||stage==='record'&&live||notes&&stage!=='review'&&stage!=='source'||audio&&error)&&stage!=='review'&&<Field label={stage==='notes'?'会议内容':'转写文本'} htmlFor="hct-meeting-notes"><textarea id="hct-meeting-notes" className="afc-control afc-control--textarea hct-notes" disabled={locked||recording||recognizing} value={notes} onChange={e=>setNotes(e.target.value)}/></Field>}
  {interim&&recording&&<p className="hct-muted" role="status">{interim}</p>}
  {stage==='review'&&<form id="hct-dispatch" onSubmit={dispatch}>{rows.map((row,index)=><DraftRow key={row.id} row={row} index={index} call={call} disabled={locked} change={value=>setRows(old=>old.map(r=>r.id===row.id?value:r))} remove={()=>setRows(old=>old.filter(r=>r.id!==row.id))}/>)}{!rows.length&&<p className="hct-muted">暂无待派发事项</p>}</form>}
 </Dialog>;
}
