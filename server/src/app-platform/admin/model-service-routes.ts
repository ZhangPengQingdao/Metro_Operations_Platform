import type {FastifyInstance,FastifyRequest} from 'fastify';
import {z} from 'zod';
import type {ConnectablePool,QueryableClient} from '../../core/database/index.js';
import {appendAdminAudit,type AdminIdentityService} from '../../core/admin-identity/index.js';
import {AiRuntimeConfigError,AiProviderTransportError} from '../../core/integrations/ai/index.js';
import {readModelServiceConfig,publicModelServiceConfig,prepareModelServiceConfig,saveModelServiceConfig,
 modelServiceSchema,testModelService,queryAsrTask,asrUrlAudioSchema,decodeTestAudio,testAudioSchema,MAX_TEST_AUDIO_BYTES,ModelServiceError} from '../../core/integrations/model-services/index.js';
import {createAdministratorContext} from './routes.js';

/** Registered inside the administrator scope: authentication, origin checks and no-store are inherited. */
export function registerAdminModelServiceRoutes(app:FastifyInstance,identity:AdminIdentityService,pool:ConnectablePool){
 const admitted=new Set<FastifyRequest>(),controllers=new Set<AbortController>();
 app.addHook('onResponse',async req=>{admitted.delete(req);});
 app.addHook('onRequestAbort',async req=>{admitted.delete(req);});
 app.addHook('onClose',async()=>{for(const controller of controllers)controller.abort();});
 async function read<T>(work:(db:QueryableClient)=>Promise<T>){
  const db=await pool.connect();try{return await work(db);}finally{db.release();}
 }
 for(const kind of ['rerank','asr','streaming-asr'] as const){
  app.get(`/${kind}`,async()=>publicModelServiceConfig(kind,await read(db=>readModelServiceConfig(db,kind))));
  for(const action of (kind==='asr'?['save','test','query']:['save','test']) as ('save'|'test'|'query')[]){
   app.post(`/${kind}/${action}`,{
    bodyLimit:kind!=='rerank'&&action==='test'?Math.ceil(MAX_TEST_AUDIO_BYTES/3)*4+16384:16384,
    onRequest:async(req,reply)=>{
     if(action==='save')return;
     if(admitted.size>=2)return reply.code(429).send({error:'MODEL_TEST_BUSY',message:'已有模型测试正在进行，请稍后再试。'});
     admitted.add(req);
    },
   },async(req,reply)=>{
    const context=await createAdministratorContext(req,identity);
    const shape:z.ZodRawShape=action==='save'?{requestId:z.string().uuid()}:action==='query'?{taskId:z.string().uuid()}:kind==='asr'?{audio:testAudioSchema.optional(),urlAudio:asrUrlAudioSchema.optional()}:kind==='streaming-asr'?{audio:testAudioSchema}:{};
    const {requestId,audio,urlAudio,taskId,...input}=modelServiceSchema(kind).extend(shape).parse(req.body) as
     Record<string,unknown>&{requestId?:string;audio?:unknown;urlAudio?:z.infer<typeof asrUrlAudioSchema>;taskId?:string};
    const controller=new AbortController();
    const abort=()=>controller.abort();
    if(action!=='save'){controllers.add(controller);req.raw.on('aborted',abort);reply.raw.on('close',abort);}
    try{
     if(action==='save')return await saveModelServiceConfig(pool,kind,input,requestId!,context.administrator.id,
      db=>appendAdminAudit(db,{actorId:context.administrator.id,action:`${kind}.configuration.update`,targetId:'system'}));
     const config=await read(db=>prepareModelServiceConfig(db,kind,input));
     if(action==='query')return await queryAsrTask(config,taskId!,controller.signal);
     if(kind==='asr'&&((config.protocol==='doubao-asr'&&audio)||(config.protocol!=='doubao-asr'&&urlAudio)))
      throw new ModelServiceError('ASR_AUDIO_PROTOCOL_MISMATCH','测试音频来源与所选协议不匹配。');
     const sample=kind!=='rerank'&&audio?decodeTestAudio(audio):undefined;
     return await testModelService(kind,config,controller.signal,sample,{},urlAudio);
    }catch(error){
     if(error instanceof z.ZodError)return reply.code(400).send({error:'ADMIN_INVALID_INPUT',message:'请检查模型参数和测试文件。'});
     if(error instanceof ModelServiceError||error instanceof AiProviderTransportError)
      return reply.code(error.statusCode).send({error:error.code,message:error.message});
     if(error instanceof AiRuntimeConfigError)return reply.code(503).send({error:error.code,message:error.message});
     return reply.code(action!=='save'?502:503).send({error:action!=='save'?'MODEL_TEST_FAILED':'MODEL_SAVE_UNCONFIRMED',
      message:action!=='save'?'模型测试失败或超时，请检查服务与接口协议。':'未能确认配置保存结果，请重新读取配置核对后再操作。'});
    }finally{controllers.delete(controller);req.raw.off('aborted',abort);reply.raw.off('close',abort);}
   });
  }
 }
}
