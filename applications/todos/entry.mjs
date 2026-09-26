import {createServer} from 'node:http';
import {createAppBackend} from '@metro/platform-sdk/app-backend';
import {createTodosHandlers} from './handlers.mjs';
import {createTodosService} from './service.mjs';

const backend=createAppBackend({input:process.stdin,output:process.stdout,handlers:createTodosHandlers({invoke:(...args)=>backend.gateway.invoke(...args)})});
const scheduler=createTodosService({invoke:(...args)=>backend.gateway.invoke(...args)});
const health=createServer((req,res)=>{res.writeHead(req.method==='GET'&&req.url==='/health'&&!backend.signal.aborted?200:503);res.end();});
health.listen(8080,'127.0.0.1');
let running=false;
async function sweep(){
 if(running||backend.signal.aborted)return;
 running=true;
 try{await scheduler.sweep(backend.signal);}catch(error){console.error('Todo recurrence scan failed',error?.code??error?.message??'UNKNOWN');}
 finally{running=false;}
}
const initial=setTimeout(sweep,3000),interval=setInterval(sweep,60_000);
let stopping=false;function stop(){if(stopping)return;stopping=true;clearTimeout(initial);clearInterval(interval);backend.close();health.close();void backend.drain();}
process.once('SIGTERM',stop);process.once('SIGINT',stop);void backend.whenClosed.then(stop);
