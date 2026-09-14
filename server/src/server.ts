import {buildApp} from './app.js';
import {getCoreConfig} from './core/config/index.js';
import {getDatabasePool} from './core/database/index.js';
const app=await buildApp();
try{await app.listen({port:getCoreConfig().runtime.port.value,host:process.env.HOST??'127.0.0.1'});}
catch(error){app.log.error(error);await app.close();await getDatabasePool()?.end();process.exitCode=1;}
let stopping=false;
async function stop(){if(stopping)return;stopping=true;try{await app.close();await getDatabasePool()?.end();}catch(error){app.log.error(error);process.exitCode=1;}}
process.once('SIGINT',()=>void stop());process.once('SIGTERM',()=>void stop());
