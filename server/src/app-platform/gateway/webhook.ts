import {z} from 'zod';
import {parseTrustedWebhookUrl,sendTrustedWebhookMessage} from '../../core/integrations/wecom/index.js';
import {GatewayError,type AppGatewayOperation} from './model.js';

const input=z.object({url:z.string().max(2048),message:z.string().trim().min(1).max(12000),messageType:z.enum(['text','markdown']).default('text')}).strict();
export function createWebhookOperation(send=sendTrustedWebhookMessage):AppGatewayOperation {
 return {name:'platform.webhook.send',permissionCode:'platform.notifications.create',mode:'write',
  validateParams:value=>input.safeParse(value).success,
  resolveResources:async context=>{if(context.actorType!=='service')throw new GatewayError('ACCESS_DENIED',403);return [{}];},
  async execute(context,value,signal){
   const p=input.parse(value),url=parseTrustedWebhookUrl(p.url);
   const wecom=url.hostname==='qyapi.weixin.qq.com';
   if(url.port||(wecom?url.pathname!=='/cgi-bin/webhook/send':url.pathname!=='/robot/send')||!url.searchParams.get(wecom?'key':'access_token')||(!wecom&&p.messageType!=='text'))throw new GatewayError('INVALID_PARAMS');
   if(!(await context.authorize('platform.notifications.create',{})).allowed)throw new GatewayError('ACCESS_DENIED',403);
   await send(p.url,p.message,{weComMessageType:p.messageType==='text'?'text':'auto',signal,timeoutMs:8000});
   return {sent:true};
  },validateResult:value=>!!value&&typeof value==='object'&&'sent' in value&&value.sent===true};
}
