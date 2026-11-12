import {fail,text} from './reform-rules.mjs';

export async function completeText(ai,input,signal){
 let response;
 try{response=await ai.complete(input,signal);}
 catch(error){
  signal?.throwIfAborted();
  const code=error?.code??error?.message;
  if(code==='ACCESS_DENIED'||code==='OPERATION_DENIED')fail('AI_PERMISSION_DENIED');
  if(code==='INVALID_RESULT')fail('AI_INVALID_RESULT');
  if(['AI_NOT_CONFIGURED','TIMEOUT','BUSY','RATE_LIMITED','AUDIT_FAILED','GATEWAY_FAILED'].includes(code))fail(code);
  fail('AI_UNAVAILABLE');
 }
 if(!text(response?.content,12000))fail('AI_INVALID_RESULT');
 return response.content.trim();
}
