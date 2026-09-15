import {readFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
const secrets=JSON.parse(readFileSync('/run/secrets/api.json','utf8'));
const mode=process.argv[2];
if(!['dist/server.js','dist/setup/database.js','dist/core/admin-identity/bootstrap.js','probe.mjs'].includes(mode))throw Error('INVALID_ENTRYPOINT');
const child=spawn(process.execPath,[mode],{stdio:'inherit',env:{...process.env,...secrets}});
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>child.kill(signal));
child.on('exit',(code,signal)=>{process.exitCode=code??(signal?1:0);});
child.on('error',()=>{process.stderr.write('Platform startup failed.\n');process.exitCode=1;});
