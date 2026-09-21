import {createServer} from 'node:http';
import {createAppBackend} from '@metro/platform-sdk/app-backend';
import {createShiftsHandlers} from './handlers.mjs';
const backend=createAppBackend({input:process.stdin,output:process.stdout,handlers:createShiftsHandlers({invoke:(...args)=>backend.gateway.invoke(...args)})});
const health=createServer((req,res)=>{res.writeHead(req.method==='GET'&&req.url==='/health'&&!backend.signal.aborted?200:503);res.end();});
health.listen(8080,'127.0.0.1');
let stopping=false;function stop(){if(stopping)return;stopping=true;backend.close();health.close();void backend.drain();}
process.once('SIGTERM',stop);process.once('SIGINT',stop);void backend.whenClosed.then(stop);
