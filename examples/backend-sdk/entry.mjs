import {createServer} from 'node:http';
import {createAppBackend} from '@metro/platform-sdk/app-backend';
import {echo} from './app.mjs';
const backend=createAppBackend({input:process.stdin,output:process.stdout,handlers:new Map([['echo',{method:'POST',path:'/echo',execute:echo}]])});
const health=createServer((req,res)=>{
 if(req.method!=='GET'||req.url!=='/health'){res.writeHead(404);res.end();return;}
 res.writeHead(backend.signal.aborted?503:200,{'content-type':'application/json'});res.end('{"status":"ready"}');
});
health.listen(8080,'127.0.0.1');
let stopping=false;
function stop(){if(stopping)return;stopping=true;backend.close();health.close();void backend.drain();}
process.once('SIGTERM',stop);process.once('SIGINT',stop);void backend.whenClosed.then(stop);
