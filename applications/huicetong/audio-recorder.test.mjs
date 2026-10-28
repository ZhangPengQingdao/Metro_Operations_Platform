import test from 'node:test';
import assert from 'node:assert/strict';
import {createAudioRecorder,recordingLimits} from './src/audio-recorder.mjs';

function fixture(overrides={}){
 const states=[],times=[],audio=[],errors=[];let instance,stops=0,clock=0,tick,cancelled=0;
 const stream={getTracks:()=>[{stop:()=>stops++}]};
 class Recorder{
  static isTypeSupported(type){return type==='audio/mp4';}
  constructor(input,options){assert.equal(input,stream);this.mimeType=options.mimeType;this.state='inactive';instance=this;}
  start(){this.state='recording';}
  pause(){this.state='paused';}
  resume(){this.state='recording';}
  stop(){this.state='inactive';this.ondataavailable({data:new Blob(['audio bytes'],{type:this.mimeType})});this.onstop();}
 }
 const controller=createAudioRecorder({onState:value=>states.push(value),onTime:value=>times.push(value),onAudio:value=>audio.push(value),onError:value=>errors.push(value),mediaDevices:{getUserMedia:async()=>stream},Recorder,now:()=>clock,schedule:callback=>{tick=callback;return 1;},cancel:()=>cancelled++,...overrides});
 return {controller,states,times,audio,errors,stream,get instance(){return instance;},get stops(){return stops;},get cancelled(){return cancelled;},advance:ms=>{clock+=ms;tick?.();}};
}
test('recording pauses elapsed time, resumes and produces actual MIME with released tracks',async()=>{
 const f=fixture();await f.controller.start();f.advance(2100);f.controller.pause();f.advance(8000);assert.equal(f.times.at(-1),2);f.controller.resume();f.advance(1000);assert.equal(f.times.at(-1),3);f.controller.stop();assert.equal(f.audio.length,1);assert.equal(f.audio[0].type,'audio/mp4');assert.equal(await f.audio[0].text(),'audio bytes');assert.equal(f.stops,1);assert.equal(f.cancelled,1);assert.equal(f.states.at(-1),'ready');f.controller.dispose();assert.equal(f.audio.length,1);
});
test('closing while permission is pending releases the eventual microphone and never starts recording',async()=>{
 let resolve;const f=fixture({mediaDevices:{getUserMedia:()=>new Promise(done=>{resolve=done;})}});const pending=f.controller.start();f.controller.dispose();resolve(f.stream);await pending;assert.equal(f.stops,1);assert.equal(f.instance,undefined);assert.deepEqual(f.states,['requesting']);assert.equal(f.audio.length,0);
});
test('closing during recording prevents late audio and status callbacks',async()=>{
 const f=fixture();await f.controller.start();f.controller.dispose();assert.equal(f.stops,1);assert.equal(f.cancelled,1);assert.equal(f.audio.length,0);assert.equal(f.states.at(-1),'recording');
});
test('permission rejection and unsupported browsers remain actionable without creating audio',async()=>{
 const f=fixture({mediaDevices:{getUserMedia:async()=>{throw Object.assign(Error('denied'),{name:'NotAllowedError'});}}});await f.controller.start();assert.match(f.errors[0],/权限/);assert.equal(f.states.at(-1),'idle');assert.equal(f.audio.length,0);
 const unsupported=fixture({Recorder:null});await unsupported.controller.start();assert.match(unsupported.errors[0],/不支持录音/);
});
test('duration and byte bounds stop recording and preserve the captured audio',async()=>{
 const f=fixture();await f.controller.start();f.advance(recordingLimits.seconds*1000);assert.equal(f.states.at(-1),'ready');assert.match(f.errors[0],/20 分钟/);assert.equal(f.stops,1);
 const large=fixture();await large.controller.start();large.instance.ondataavailable({data:new Blob([new Uint8Array(recordingLimits.bytes)])});assert.equal(large.states.at(-1),'ready');assert.match(large.errors[0],/大小上限/);assert.equal(large.stops,1);
});
test('rapid starts request the microphone once and device errors release it',async()=>{
 const f=fixture();const first=f.controller.start();await f.controller.start();await first;assert.equal(f.states.filter(state=>state==='requesting').length,1);f.instance.onerror({error:{name:'NotReadableError'}});assert.match(f.errors[0],/麦克风/);assert.equal(f.stops,1);assert.equal(f.cancelled,1);
});
