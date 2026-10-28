const errors={
 'not-allowed':'语音识别权限未开启。录音会继续，可结束后手动填写。',
 'service-not-allowed':'浏览器未允许语音识别服务。录音会继续，可手动填写。',
 network:'语音识别服务连接失败，请检查网络。已识别文字和录音会保留。',
 'no-speech':'暂未识别到语音，可继续转写或手动填写。',
 'audio-capture':'语音识别无法读取麦克风，请检查设备。',
 'language-not-supported':'当前浏览器的识别服务不支持中文，请手动填写。',
};

/** One recognition session at a time; final results survive pause/resume and service failures. */
export function createSpeechTranscriber({Recognition=globalThis.SpeechRecognition??globalThis.webkitSpeechRecognition,onText,onInterim,onState,onError,schedule=setTimeout,cancel=clearTimeout}){
 let current=null,disposed=false,restart=false,committed='',finalText='',stopTimer=null;
 const clearStopTimer=()=>{if(stopTimer!==null){cancel(stopTimer);stopTimer=null;}};
 const joined=()=>[committed,finalText].filter(Boolean).join('\n');
 function start(text=''){
  if(disposed)return;
  if(!Recognition){onError('当前浏览器不支持实时语音识别，可录音后手动填写。');onState('unsupported');return;}
  if(current){if(current.stopping)restart=true;return;}
  committed=text;finalText='';restart=false;
  const instance=new Recognition();current=instance;
  instance.lang='zh-CN';instance.continuous=true;instance.interimResults=true;
  const valid=()=>!disposed&&current===instance;
  instance.onstart=()=>{if(valid())onState('listening');};
  instance.onresult=event=>{
   if(!valid())return;
   const finals=[],interim=[];
   for(let i=0;i<event.results.length;i++)(event.results[i].isFinal?finals:interim).push(event.results[i][0].transcript);
   finalText=finals.join('');onText(joined());onInterim(interim.join(''));
  };
  instance.onerror=event=>{if(!valid())return;restart=false;instance.failed=true;if(event.error==='aborted'&&instance.stopping)return;onError(errors[event.error]??'语音识别暂不可用，已识别文字和录音会保留。');onState('error');};
  instance.onend=()=>{
   if(!valid())return;
   clearStopTimer();
   const text=joined();current=null;onInterim('');onState(instance.failed?'error':'ended');
   if(restart)start(text);
  };
  try{onState('starting');instance.start();}catch(error){current=null;onState('error');onError(errors[error?.name==='NotAllowedError'?'not-allowed':'network']);}
 }
 return {
  start,
  stop(){restart=false;if(current&&!current.stopping){const ending=current;ending.stopping=true;try{
   ending.stop();
   // Some services never emit `end` after disconnecting. Do not leave manual entry locked.
   if(current===ending)stopTimer=schedule(()=>{if(disposed||current!==ending)return;const text=joined(),resume=restart;current=null;stopTimer=null;try{ending.abort();}catch{/* The service has already disconnected. */}onInterim('');onState('ended');if(resume)start(text);},2000);
  }catch{current=null;if(!disposed){onInterim('');onState('ended');}}}},
  dispose(){disposed=true;restart=false;clearStopTimer();if(current){try{current.abort();}catch{/* Browser already ended the session. */}current=null;}},
 };
}
