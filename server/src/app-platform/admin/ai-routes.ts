import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {getPublicAiRuntimeConfig,saveAiRuntimeConfig,resolveExternalProviderConfig,resolveExternalConnectionConfig,listExternalProviderModels,testExternalProviderConnection,AiRuntimeConfigError} from '../../core/integrations/ai/index.js';
import {appendAdminAudit,type AdminIdentityService} from '../../core/admin-identity/index.js';
import {createAdministratorContext} from './routes.js';

const schema=z.object({endpoint:z.string().trim().url().max(500),model:z.string().trim().max(120).default(''),apiKey:z.string().trim().max(4096).optional(),timeoutMs:z.number().int().min(5000).max(180000).default(120000),reasoningEffort:z.enum(['auto','low','medium','high']).default('auto')}).strict();
function normalizeEndpoint(value:string){const url=new URL(value);if(!/\/chat\/completions\/?$/.test(url.pathname))url.pathname=`${url.pathname.replace(/\/$/,'')}${url.pathname==='/'?'v1':''}/chat/completions`;return url.toString();}
export async function registerAdminAiRoutes(app:FastifyInstance,identity:AdminIdentityService){
 app.get('/ai',async()=>getPublicAiRuntimeConfig());
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
