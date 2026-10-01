import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import Fastify from 'fastify';
import {registerDeveloperDownloads} from '../src/app-platform/admin/developer-downloads.ts';
test('downloads use a bounded allowlist, verify content and report missing builds',async()=>{
 const root=await mkdtemp(join(tmpdir(),'developer-downloads-')),app=Fastify();registerDeveloperDownloads(app,pathToFileURL(root+'/'));
 try{
 assert.equal((await app.inject('/developer/downloads')).json().available,false);
 assert.equal((await app.inject('/developer/downloads/sdk')).statusCode,404);
 const data=Buffer.from('archive'),fileName='metro-platform-sdk-0.24.0.tgz';await writeFile(join(root,fileName),data);
 const downloads=['sdk','cli','docs','skill','example'].map(id=>({id,title:id,fileName,bytes:data.length,sha256:createHash('sha256').update(data).digest('hex')}));
 await writeFile(join(root,'index.json'),JSON.stringify({version:'0.24.0',downloads}));
 const response=await app.inject('/developer/downloads/sdk');assert.equal(response.statusCode,200);assert.deepEqual(response.rawPayload,data);assert.match(String(response.headers['content-disposition']),/attachment/);
 assert.equal((await app.inject('/developer/downloads/secret')).statusCode,404);
 await writeFile(join(root,fileName),'tampered');assert.equal((await app.inject('/developer/downloads/sdk')).statusCode,503);
 }finally{await app.close();await rm(root,{recursive:true,force:true});}
});
