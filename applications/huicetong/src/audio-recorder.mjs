const MAX_SECONDS=20*60,MAX_BYTES=50*1024*1024;
export const recordingLimits={seconds:MAX_SECONDS,bytes:MAX_BYTES};
export function recordingError(error){
 return ({NotAllowedError:'麦克风权限未开启，请在浏览器中允许使用麦克风后重试。',NotFoundError:'未找到可用的麦克风，请连接设备后重试。',NotReadableError:'无法使用麦克风，请检查设备是否被其他应用占用。',SecurityError:'当前页面无法访问麦克风，请使用 HTTPS 或本机地址。'})[error?.name]??'录音失败，请检查麦克风后重试；也可直接手动填写。';
}

/** Owns microphone tracks and callbacks, including permission resolution after a dialog closes. */
export function createAudioRecorder({onState,onTime,onAudio,onError,mediaDevices=globalThis.navigator?.mediaDevices,Recorder=globalThis.MediaRecorder,now=()=>Date.now(),schedule=setInterval,cancel=clearInterval}){
 let disposed=false,state='idle',recorder=null,stream=null,timer=null,elapsed=0,started=0,chunks=[],bytes=0;
 const update=value=>{state=value;if(!disposed)onState(value);};
 const release=()=>{if(timer!==null){cancel(timer);timer=null;}stream?.getTracks().forEach(track=>track.stop());stream=null;};
 const duration=()=>elapsed+(state==='recording'?now()-started:0);
 function stop(){
  if(!recorder||!['recording','paused'].includes(state))return;
  elapsed=duration();update('stopping');
  try{recorder.stop();}catch(error){release();update('idle');if(!disposed)onError(recordingError(error));}
  release();
 }
 return {
  async start(){
   if(disposed||!['idle','ready'].includes(state))return;
   if(!mediaDevices?.getUserMedia||!Recorder){onError('当前浏览器不支持录音，请使用支持录音的浏览器，或手动填写。');return;}
   update('requesting');
   try{
    const acquired=await mediaDevices.getUserMedia({audio:true});
    if(disposed){acquired.getTracks().forEach(track=>track.stop());return;}
    stream=acquired;
    const mimeType=['audio/webm;codecs=opus','audio/mp4','audio/ogg;codecs=opus'].find(type=>Recorder.isTypeSupported?.(type));
    recorder=new Recorder(stream,mimeType?{mimeType,audioBitsPerSecond:64000}:undefined);
    chunks=[];bytes=0;elapsed=0;
    recorder.ondataavailable=event=>{if(disposed||!event.data?.size)return;chunks.push(event.data);bytes+=event.data.size;if(bytes>=MAX_BYTES){onError('录音已达到大小上限，已自动结束。');stop();}};
    recorder.onstop=()=>{
     release();if(disposed)return;
     if(chunks.length){const blob=new Blob(chunks,{type:recorder.mimeType||chunks[0].type});onAudio(blob);update('ready');}
     else{update('idle');onError('没有录到音频，请检查麦克风后重试。');}
     chunks=[];
    };
    recorder.onerror=event=>{if(!disposed)onError(recordingError(event.error));stop();};
    recorder.start(1000);started=now();update('recording');onTime(0);
    timer=schedule(()=>{if(disposed)return;const seconds=Math.floor(duration()/1000);onTime(seconds);if(seconds>=MAX_SECONDS){onError('已录制 20 分钟，录音已自动结束。');stop();}},250);
   }catch(error){release();if(!disposed){update('idle');onError(recordingError(error));}}
  },
  pause(){if(state!=='recording')return;recorder.pause();elapsed=duration();update('paused');},
  resume(){if(state!=='paused')return;recorder.resume();started=now();update('recording');},
  stop,
  dispose(){disposed=true;if(recorder&&recorder.state!=='inactive'){try{recorder.stop();}catch{/* Already stopped by the device. */}}release();chunks=[];},
 };
}
