import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
const assetSchema=z.object({id:z.enum(['sdk','cli','docs','skill','example']),title:z.string().max(80),fileName:z.string().regex(/^metro-[a-z0-9.-]+\.(?:tgz|tar\.gz)$/),bytes:z.number().int().positive().max(50*1024*1024),sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
const indexSchema=z.object({version:z.string().regex(/^\d+\.\d+\.\d+$/),downloads:z.array(assetSchema).length(5)}).strict();
/** Register only inside the administrator-authenticated scope. Never accept a filesystem path. */
export function registerDeveloperDownloads(scoped:FastifyInstance,root=new URL('../../../developer-assets/',import.meta.url)) {
 const readIndex=async()=>{
  try{return indexSchema.parse(JSON.parse(await readFile(new URL('index.json',root),'utf8')));}catch(error){
   if(error&&typeof error==='object'&&'code' in error&&error.code==='ENOENT')return null;
   throw error;
  }
 };
 scoped.get('/developer/downloads',async()=>{
  const index=await readIndex();return index?{...index,available:true}:{available:false,version:null,downloads:[]};
 });
 scoped.get<{Params:{id:string}}>('/developer/downloads/:id',async(req,reply)=>{
  if(!['sdk','cli','docs','skill','example'].includes(req.params.id))return reply.code(404).send({error:'DEVELOPER_DOWNLOAD_NOT_FOUND'});
  const index=await readIndex(),asset=index?.downloads.find(item=>item.id===req.params.id);
  if(!asset)return reply.code(404).send({error:'DEVELOPER_DOWNLOAD_NOT_BUILT'});
  const bytes=await readFile(new URL(asset.fileName,root));
  if(bytes.length!==asset.bytes||createHash('sha256').update(bytes).digest('hex')!==asset.sha256)return reply.code(503).send({error:'DEVELOPER_DOWNLOAD_INTEGRITY_FAILED'});
  return reply.header('Content-Type','application/gzip').header('Content-Disposition',`attachment; filename="${asset.fileName}"`).header('X-Content-Type-Options','nosniff').send(bytes);
 });
}
