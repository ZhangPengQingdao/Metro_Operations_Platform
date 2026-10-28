import {defineServer} from '@metro/platform-sdk/server';
import {createReformHandlers} from './reform-service.mjs';

let platform,timer,pending;
const controller=new AbortController();
const gateway={invoke:(...args)=>platform.invoke(...args)};
const {handlers,scanReminders}=createReformHandlers(gateway);
export default defineServer(handlers,{
 start(context){
  platform=context.platform;
  const run=()=>{if(pending||controller.signal.aborted)return;pending=scanReminders(controller.signal).catch(()=>context.log('慧策通提醒扫描未完成，将在下次扫描核对；外部消息不自动重放')).finally(()=>{pending=null;});};
  context.signal.addEventListener('abort',()=>controller.abort(),{once:true});
  timer=setInterval(run,60_000);timer.unref?.();run();
 },
 async stop(){clearInterval(timer);controller.abort();await pending;}
});
