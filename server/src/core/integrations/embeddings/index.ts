import {env} from '../../../config/env.js';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {assertSafeAiProviderEndpoint, encryptApiKey, decryptApiKey, maskApiKey} from '../ai/index.js';
import {runDatabaseTransaction, type ConnectablePool, type QueryableClient} from '../../database/index.js';

const key='embedding_runtime_global';
export const embeddingSchema=z.object({
  protocol:z.enum(['openai','volcengine-ark']).default('openai'),enabled:z.boolean(),
  endpoint:z.string().trim().url().max(500).refine(value=>{try{const url=new URL(value);return ['http:','https:'].includes(url.protocol)&&!url.username&&!url.password&&!url.search&&!url.hash;}catch{return false;}},'服务地址不能包含凭据、查询参数或片段'),
  model:z.string().trim().min(1).max(120),dimensions:z.number().int().min(1).max(4096),
  minScore:z.number().min(0).max(1).default(0.3),timeoutMs:z.number().int().min(5000).max(60000).default(30000),apiKey:z.string().trim().max(4096).optional(),
}).strict();
export type EmbeddingProtocol=z.infer<typeof embeddingSchema>['protocol'];
export interface EmbeddingConfig {revision:string;protocol?:EmbeddingProtocol;enabled:boolean;endpoint:string;model:string;dimensions:number;timeoutMs:number;minScore?:number;apiKey:ReturnType<typeof encryptApiKey>;apiKeyMask:string}
export interface EmbeddingInput {protocol?:EmbeddingProtocol;enabled:boolean;endpoint:string;model:string;dimensions:number;timeoutMs:number;minScore?:number;apiKey?:string}
export function normalizeEmbeddingEndpoint(value:string,protocol:EmbeddingProtocol){
  const url=new URL(value),suffix=protocol==='volcengine-ark'?'/embeddings/multimodal':'/embeddings';
  const path=url.pathname.replace(/\/$/,'');
  if(!path.endsWith(suffix))url.pathname=`${path.replace(/\/embeddings(?:\/multimodal)?$/,'')}${path===''?(protocol==='volcengine-ark'?'/api/v3':'/v1'):''}${suffix}`;
  return url.toString();
}
export class EmbeddingError extends Error {
  constructor(readonly code:string, message:string){super(message);}
}
/** Operator-approved local/private endpoints may use HTTP(S); other endpoints retain public HTTPS checks. */
export async function assertSafeEmbeddingEndpoint(endpoint:string):Promise<void>{
  if(env.MOP_EMBEDDING_ALLOWED_ENDPOINTS.includes(endpoint))return;
  await assertSafeAiProviderEndpoint(endpoint);
}
export async function readEmbeddingConfig(db:QueryableClient):Promise<EmbeddingConfig|null>{
  const result=await db.query('SELECT value FROM system_configs WHERE key=$1',[key]) as {rows:{value:EmbeddingConfig}[]};
  return result.rows[0]?.value??null;
}
export function publicEmbeddingConfig(config:EmbeddingConfig|null){
  if(!config)return {protocol:'openai' as const,enabled:false,endpoint:'',model:'',dimensions:1024,timeoutMs:30000,minScore:0.3,hasApiKey:false,apiKeyMask:''};
  const {apiKey,revision:_,...rest}=config;return {...rest,protocol:config.protocol??'openai',minScore:config.minScore??0.3,hasApiKey:!!apiKey};
}
export async function prepareEmbeddingConfig(db:QueryableClient,input:EmbeddingInput):Promise<EmbeddingConfig>{
  const parsed=embeddingSchema.parse(input);input={...parsed,endpoint:normalizeEmbeddingEndpoint(parsed.endpoint,parsed.protocol)};
  const previous=await readEmbeddingConfig(db);
  if((!previous?.apiKey||previous.endpoint!==input.endpoint||(previous.protocol??'openai')!==input.protocol)&&!input.apiKey)throw new EmbeddingError('EMBEDDING_KEY_REQUIRED','首次配置或更换协议、地址后，请填写 API Key');
  const secret=input.apiKey?encryptApiKey(input.apiKey):previous!.apiKey;
  if(input.enabled)await assertSafeEmbeddingEndpoint(input.endpoint);
  const same=previous?.endpoint===input.endpoint&&(previous.protocol??'openai')===input.protocol&&previous.model===input.model&&previous.dimensions===input.dimensions;
  return {...input,apiKey:secret,apiKeyMask:input.apiKey?maskApiKey(input.apiKey):previous!.apiKeyMask,revision:same?previous.revision:randomUUID()};
}
export async function saveEmbeddingConfig(pool:ConnectablePool&QueryableClient,input:EmbeddingInput,audit:(db:QueryableClient)=>Promise<void>){
  const db=await pool.connect();
  try{return await runDatabaseTransaction(db,async()=>{
    await db.query('SELECT pg_advisory_xact_lock(6013016)');
    const config=await prepareEmbeddingConfig(db,input);
    await db.query(`INSERT INTO system_configs(key,value,description) VALUES($1,$2,'知识库向量模型')
      ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=now()`,[key,JSON.stringify(config)]);
    await audit(db);return publicEmbeddingConfig(config);
  });}finally{db.release();}
}
/** Protocol selection applies to diagnostics, indexing and query vectors alike. */
export async function embedText(config:EmbeddingConfig,text:string,signal:AbortSignal,dependencies:{fetch?:typeof fetch;safety?:(endpoint:string)=>Promise<unknown>}={}):Promise<number[]>{
  const protocol=config.protocol??'openai';
  if(!['openai','volcengine-ark'].includes(protocol))throw new EmbeddingError('EMBEDDING_PROTOCOL_INVALID','不支持此向量协议');
  signal.throwIfAborted();
  await (dependencies.safety??assertSafeEmbeddingEndpoint)(config.endpoint);
  const response=await (dependencies.fetch??fetch)(config.endpoint,{method:'POST',redirect:'error',
    headers:{'Content-Type':'application/json',Authorization:`Bearer ${decryptApiKey(config.apiKey)}`},
    body:JSON.stringify({model:config.model,input:protocol==='volcengine-ark'?[{type:'text',text}]:text,encoding_format:'float'}),
    signal:AbortSignal.any([signal,AbortSignal.timeout(config.timeoutMs)])});
  if(!response.ok)throw new EmbeddingError('EMBEDDING_PROVIDER_FAILED','向量服务请求失败，请检查连接配置');
  const payload=await response.json() as {data?:{embedding?:unknown}[]|{embedding?:unknown}};
  const vector=protocol==='volcengine-ark'?(!Array.isArray(payload?.data)?payload?.data?.embedding:undefined):(Array.isArray(payload?.data)?payload.data[0]?.embedding:undefined);
  if(!Array.isArray(vector)||vector.length!==config.dimensions||!vector.every(value=>typeof value==='number'&&Number.isFinite(value)))
    throw new EmbeddingError('EMBEDDING_VECTOR_INVALID','向量返回格式或维度与配置不一致');
  const norm=Math.hypot(...vector);
  if(!norm||!Number.isFinite(norm))throw new EmbeddingError('EMBEDDING_VECTOR_INVALID','向量返回值无效');
  return vector.map(value=>value/norm);
}
export interface EmbeddingProvider {configuration():Promise<EmbeddingConfig|null>;embed(config:EmbeddingConfig,text:string,signal:AbortSignal):Promise<number[]>}
export function createEmbeddingProvider(db:QueryableClient):EmbeddingProvider{return {configuration:()=>readEmbeddingConfig(db),embed:embedText};}
