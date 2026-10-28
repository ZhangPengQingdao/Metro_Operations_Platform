import {useEffect,useRef,useState} from 'react';
import {Button,Dialog,Checkbox,Field,Input,Play,Pause,ArrowLineDown} from '@metro/platform-sdk/ui';
import {saveAs} from '@metro/platform-sdk/app';
import {PlanFields} from './plan-fields.jsx';
import {createAudioRecorder,recordingLimits} from './audio-recorder.mjs';
import {createSpeechTranscriber} from './speech-transcriber.mjs';

const time=value=>`${String(Math.floor(value/60)).padStart(2,'0')}:${String(value%60).padStart(2,'0')}`;
export function SupervisionCreate({form,setForm,session,organizationId,call,disabled,busy,error,onClose,onSave}){
 const [stage,setStage]=useState('recording'),[state,setState]=useState('idle'),[seconds,setSeconds]=useState(0),[audio,setAudio]=useState(null),[audioUrl,setAudioUrl]=useState(''),[audioError,setAudioError]=useState(''),[text,setText]=useState(''),[recognize,setRecognize]=useState(true),[speechState,setSpeechState]=useState('idle'),[speechError,setSpeechError]=useState(''),[interim,setInterim]=useState('');
 const player=useRef(null),controller=useRef(null),speech=useRef(null),textRef=useRef(text),recognizeRef=useRef(recognize);
 textRef.current=text;recognizeRef.current=recognize;
 const speechSupported=!!(globalThis.SpeechRecognition??globalThis.webkitSpeechRecognition);
 const active=['requesting','recording','paused','stopping'].includes(state);
 useEffect(()=>{
  const transcriber=createSpeechTranscriber({onText:value=>{textRef.current=value;setText(value);},onInterim:setInterim,onState:setSpeechState,onError:setSpeechError});speech.current=transcriber;
  const recorder=createAudioRecorder({onState:value=>{setState(value);if(value==='recording'&&recognizeRef.current&&(globalThis.SpeechRecognition??globalThis.webkitSpeechRecognition)){setSpeechError('');transcriber.start(textRef.current);}else if(['paused','stopping','ready','idle'].includes(value))transcriber.stop();},onTime:setSeconds,onAudio:blob=>setAudio({blob,name:`会议录音.${blob.type.includes('mp4')?'m4a':blob.type.includes('ogg')?'ogg':'webm'}`}),onError:setAudioError});
  controller.current=recorder;return()=>{recorder.dispose();transcriber.dispose();controller.current=null;speech.current=null;};
 },[]);
 useEffect(()=>{if(!audio){setAudioUrl('');return;}const url=URL.createObjectURL(audio.blob);setAudioUrl(url);return()=>URL.revokeObjectURL(url);},[audio]);
 const recognizing=['starting','listening'].includes(speechState);
 const manual=(useNotes=false)=>{player.current?.pause();if(useNotes)setForm(old=>({...old,content:text.trim()}));setStage('fields');};
 const choose=file=>{
  if(!file)return;
  if(!/\.(mp3|wav|m4a|mp4|webm|ogg|aac)$/i.test(file.name)){setAudioError('请选择 MP3、WAV、M4A、MP4、WebM、OGG 或 AAC 音频。');return;}
  if(!file.size||file.size>recordingLimits.bytes){setAudioError('录音文件不能为空，且不能超过 50 MiB。');return;}
  setAudio({blob:file,name:file.name});setAudioError('');setSeconds(0);
 };
 return <Dialog open closeOnBackdropClick={false} size="lg" title={stage==='fields'?'确认督办事项':'新增督办'} description={stage==='fields'?'核对督办要求、办结标准、时限和责任人后派发。':'录制会议事项，或直接手动填写督办内容。'} onClose={disabled?()=>{}:onClose} footer={<div className="hct-footer">
  {stage==='recording'?<><Button className="hct-back" variant="ghost" disabled={disabled||active||recognizing} onClick={()=>manual()}>手动填写</Button><Button variant="secondary" disabled={disabled} onClick={onClose}>取消</Button><Button disabled={disabled||active||speechState==='starting'||speechState==='listening'||!text.trim()||text.trim().length>500} onClick={()=>manual(true)}>下一步，确认事项</Button></>:<><Button className="hct-back" variant="ghost" disabled={disabled} onClick={()=>setStage('recording')}>返回录音</Button><Button variant="secondary" disabled={disabled} onClick={onClose}>取消</Button><Button type="submit" form="hct-supervision-form" disabled={disabled} loading={busy}>派发督办</Button></>}
 </div>}>
  {error&&<p className="hct-alert" role="alert">{error}</p>}
  <section hidden={stage!=='recording'}>
   <div className="hct-recorder" data-recording={state==='recording'}>
    <span className="hct-recorder-status" role="status">{state==='requesting'?'等待麦克风授权':state==='recording'?'正在录音':state==='paused'?'录音已暂停':state==='stopping'?'正在生成录音':audio?'录音已就绪':'准备好后，开始录音'}</span>
    <strong className="hct-recorder-time" aria-label={`录音时长 ${time(seconds)}`}>{time(seconds)}</strong>
    <div className="hct-actions">
     {active?<>{state==='paused'?<Button variant="secondary" leadingIcon={<Play size={16}/>} disabled={disabled} onClick={()=>controller.current.resume()}>继续录音</Button>:<Button variant="secondary" leadingIcon={<Pause size={16}/>} disabled={disabled||state!=='recording'} onClick={()=>controller.current.pause()}>暂停</Button>}<Button disabled={disabled||!['recording','paused'].includes(state)} onClick={()=>controller.current.stop()}>结束录音</Button></>:<Button leadingIcon={<span className="hct-record-dot" aria-hidden="true"/>} disabled={disabled} onClick={()=>{setAudioError('');void controller.current.start();}}>{audio?'重新录音':'开始录音'}</Button>}
    </div>
    <p className="hct-muted">最长录制 20 分钟 · 录音可回听并保存到本机</p>
   </div>
   {audioError&&<p role="alert" className="hct-alert">{audioError}</p>}
   {audioUrl&&!active&&<div className="hct-audio-preview"><div className="hct-audio-heading"><span>{audio.name}</span><Button variant="ghost" size="sm" leadingIcon={<ArrowLineDown size={16}/>} onClick={()=>saveAs(audio.blob,audio.name)}>保存录音</Button></div><audio ref={player} aria-label="回听会议录音" controls src={audioUrl} onError={()=>setAudioError('当前浏览器无法播放此音频，请更换音频格式。')}/></div>}
   <div className="hct-speech-options"><label><Checkbox checked={recognize&&speechSupported} disabled={disabled||active||!speechSupported} onChange={event=>setRecognize(event.target.checked)}/>实时转写</label><span className="hct-muted">{speechSupported?'使用浏览器联网识别服务处理语音，仅识别现场录音。':'当前浏览器不支持语音识别，仍可录音和手动填写。'}</span></div>
   {recognize&&speechSupported&&<div className="hct-speech-status"><span className="hct-muted" role="status">{speechState==='listening'?'正在识别，请清晰说出督办事项…':speechState==='starting'?'正在连接语音识别服务…':speechState==='ended'?'实时转写已结束，文字可编辑。':''}</span>{state==='recording'&&!recognizing&&<Button size="sm" variant="ghost" onClick={()=>{setSpeechError('');speech.current.start(textRef.current);}}>继续转写</Button>}</div>}
   {speechError&&<p className="hct-alert" role="alert">{speechError}</p>}
   <div className="hct-recording-file"><span className="hct-muted">已有录音文件？</span><label className="hct-upload-label">选择音频<Input aria-label="选择会议录音" type="file" accept="audio/*,.mp3,.wav,.m4a,.mp4,.webm,.ogg,.aac" disabled={disabled||active} onChange={event=>{choose(event.target.files?.[0]);event.target.value='';}}/></label></div>
   <Field label="转写文本 / 会议要点" htmlFor="hct-meeting-notes"><textarea id="hct-meeting-notes" className="afc-control afc-control--textarea" value={text} disabled={disabled||active||recognizing} placeholder="填写或粘贴需要督办的事项，下一步补充责任人与时限。" onChange={event=>setText(event.target.value)}/></Field>{interim&&<p className="hct-speech-interim" role="status">{interim}</p>}<p className={text.trim().length>500?"hct-alert":"hct-muted"}>已输入 {text.trim().length} 字 · 每次派发一条督办，确认前请将要点整理至 500 字以内。</p>
   <p className="hct-muted">录音仅保留在当前弹窗，关闭前请保存；会议要点确认后写入督办。</p>
  </section>
  {stage==='fields'&&<form id="hct-supervision-form" onSubmit={event=>{event.preventDefault();onSave();}}><PlanFields kind="supervision" form={form} setForm={setForm} session={session} organizationId={organizationId} call={call} disabled={disabled}/></form>}
 </Dialog>;
}
