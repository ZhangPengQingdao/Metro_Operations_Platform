import {getDatabasePool} from '../../core/database/index.js';
import {readEmbeddingConfig,publicEmbeddingConfig,prepareEmbeddingConfig,saveEmbeddingConfig,embedText,EmbeddingError} from '../../core/integrations/embeddings/index.js';
import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {getPublicAiRuntimeConfig,saveAiRuntimeConfig,resolveExternalProviderConfig,resolveExternalConnectionConfig,listExternalProviderModels,testExternalProviderConnection,AiRuntimeConfigError} from '../../core/integrations/ai/index.js';
import {appendAdminAudit,type AdminIdentityService} from '../../core/admin-identity/index.js';
import {createAdministratorContext} from './routes.js';

const schema=z.object({endpoint:z.string().trim().url().max(500),model:z.string().trim().max(120).default(''),apiKey:z.string().trim().max(4096).optional(),timeoutMs:z.number().int().min(5000).max(180000).default(120000),reasoningEffort:z.enum(['auto','low','medium','high']).default('auto')}).strict();
function normalizeEndpoint(value:string){const url=new URL(value);if(!/\/chat\/completions\/?$/.test(url.pathname))url.pathname=`${url.pathname.replace(/\/$/,'')}${url.pathname==='/'?'v1':''}/chat/completions`;return url.toString();}
export async function registerAdminAiRoutes(app:FastifyInstance,identity:AdminIdentityService){
 const pool=getDatabasePool()!;
 const embeddingSchema=z.object({enabled:z.boolean(),endpoint:z.string().trim().url().max(500),model:z.string().trim().min(1).max(120),dimensions:z.number().int().min(1).max(4096),minScore:z.number().min(0).max(1).default(0.3),timeoutMs:z.number().int().min(5000).max(60000).default(30000),apiKey:z.string().trim().max(4096).optional()}).strict();
 app.get('/embedding',async()=>publicEmbeddingConfig(await readEmbeddingConfig(pool)));
 for(const action of ['save','test'] as const)app.post(`/embedding/${action}`,{bodyLimit:8192},async(req,reply)=>{
  const context=await createAdministratorContext(req,identity),input=embeddingSchema.parse(req.body);
  const endpoint=new URL(input.endpoint);
  if(!/\/embeddings\/?$/.test(endpoint.pathname))endpoint.pathname=`${endpoint.pathname.replace(/\/$/,'')}${endpoint.pathname==='/'?'v1':''}/embeddings`;
  input.endpoint=endpoint.toString();
  try{
   if(action==='save')return await saveEmbeddingConfig(pool,input,db=>appendAdminAudit(db,{actorId:context.administrator.id,action:'embedding.configuration.update',targetId:'system'}));
   const vector=await embedText(await prepareEmbeddingConfig(pool,input),'知识库连接测试',new AbortController().signal);
   return {dimensions:vector.length};
  }catch(error){
   if(error instanceof EmbeddingError||error instanceof AiRuntimeConfigError)return reply.code(400).send({error:error.code,message:error.message});
   return reply.code(502).send({error:'EMBEDDING_CONNECTION_FAILED',message:'向量连接失败，请检查地址、密钥、模型及维度。'});
  }
 });
 app.get('/ai' ,async()=>getPublicAiRuntimeConfig());
 for(const action of ['save','models','test'] as const){
  app.post(`/ai/${action}`,{bodyLimit:8192},async(req,reply)=>{
   const context=await createAdministratorContext(req,identity);
   const parsed=schema.parse(req.body);
   const input={endpoint:normalizeEndpoint(parsed.endpoint),model:parsed.model,apiKey:parsed.apiKey,timeoutMs:parsed.timeoutMs,reasoningEffort:parsed.reasoningEffort};
   try {
    if(action==='save')return await saveAiRuntimeConfig(input,db=>appendAdminAudit(db,{actorId:context.administrator.id,action:'ai.configuration.update',targetId:'system'}));
    if(action==='models')return await listExternalProviderModels(await resolveExternalConnectionConfig(input));
    return await testExternalProviderConnection(await resolveExternalProviderConfig(input));
   }catch(error){
    if(error instanceof AiRuntimeConfigError)return reply.code(error.code==='AI_PROVIDER_ENCRYPTION_KEY_INVALID'?503:400).send({error:error.code,message:error.message});
    return reply.code(502).send({error:'AI_CONNECTION_FAILED',message:'连接失败，请检查地址、密钥和模型。'});
   }
  });
 }
}
