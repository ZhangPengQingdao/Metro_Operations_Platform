import test from 'node:test';
import assert from 'node:assert/strict';
import {createSpeechTranscriber} from './src/speech-transcriber.mjs';
function fixture(){
 const sessions=[],text=[],interim=[],states=[],errors=[];
 class Recognition{
  constructor(){sessions.push(this);}
  start(){this.onstart();}
  stop(){this.stopped=true;}
  abort(){this.aborted=true;this.onend();}
  result(values){this.onresult({results:values.map(([transcript,isFinal])=>Object.assign([{transcript}],{isFinal}))});}
 }
 const controller=createSpeechTranscriber({Recognition,onText:value=>text.push(value),onInterim:value=>interim.push(value),onState:value=>states.push(value),onError:value=>errors.push(value)});
 return {controller,sessions,text,interim,states,errors};
}
test('interim text is separate and repeated final events do not duplicate transcript',()=>{
 const f=fixture();f.controller.start('已有要点');const r=f.sessions[0];assert.equal(r.lang,'zh-CN');r.result([['排查',false]]);assert.equal(f.text.at(-1),'已有要点');assert.equal(f.interim.at(-1),'排查');r.result([['排查设备。',true],['提交',false]]);r.result([['排查设备。',true],['提交报告。',true]]);assert.equal(f.text.at(-1),'已有要点\n排查设备。提交报告。');
});
test('resume waits for prior session to finish and retains its late final text',()=>{
 const f=fixture();f.controller.start('');const r=f.sessions[0];f.controller.stop();f.controller.start('');assert.equal(f.sessions.length,1);r.result([['第一段。',true]]);r.onend();assert.equal(f.sessions.length,2);f.sessions[1].result([['第二段。',true]]);assert.equal(f.text.at(-1),'第一段。\n第二段。');
});
test('network failures preserve final text, expose an actionable error, and do not retry automatically',()=>{
 const f=fixture();f.controller.start('');f.sessions[0].result([['已记录。',true]]);f.sessions[0].onerror({error:'network'});f.sessions[0].onend();assert.equal(f.text.at(-1),'已记录。');assert.match(f.errors[0],/连接失败/);assert.equal(f.states.at(-1),'error');assert.equal(f.sessions.length,1);
});
test('dispose aborts recognition and ignores late callbacks',()=>{
 const f=fixture();f.controller.start('');const r=f.sessions[0];f.controller.dispose();r.result([['不应写入',true]]);r.onerror({error:'network'});assert.equal(r.aborted,true);assert.equal(f.text.length,0);assert.equal(f.errors.length,0);assert.equal(f.states.at(-1),'listening');
});
test('unsupported speech API keeps manual entry available',()=>{
 const states=[],errors=[];const c=createSpeechTranscriber({Recognition:null,onText:()=>{},onInterim:()=>{},onState:value=>states.push(value),onError:value=>errors.push(value)});c.start();assert.deepEqual(states,['unsupported']);assert.match(errors[0],/手动填写/);c.dispose();
});
test('stalled service cannot keep manual entry locked after stopping',()=>{
 let tick,instance;const states=[],text=[];
 class Recognition{constructor(){instance=this;}start(){this.onstart();}stop(){}abort(){}}
 const c=createSpeechTranscriber({Recognition,onText:value=>text.push(value),onInterim:()=>{},onState:value=>states.push(value),onError:()=>{},schedule:fn=>{tick=fn;return 1;},cancel:()=>{}});
 c.start('已保存的文字');c.stop();tick();assert.equal(states.at(-1),'ended');instance.onresult({results:[Object.assign([{transcript:'已失效结果'}],{isFinal:true})]});assert.equal(text.length,0);c.dispose();
});
