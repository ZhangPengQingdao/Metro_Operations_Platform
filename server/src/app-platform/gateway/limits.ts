import { createFixedWindowRateLimiter, type RateLimitStore, type RateLimitRecord } from '../../core/security/index.js';
import { GatewayError } from './model.js';
export interface GatewayLimits { requestBytes: number; resultBytes: number; timeoutMs: number; concurrency: number; windowMs: number; globalRequests: number; appRequests: number; actorRequests: number; maxRateKeys: number }
export const DEFAULT_GATEWAY_LIMITS: Readonly<GatewayLimits> = Object.freeze({requestBytes:65536,resultBytes:262144,timeoutMs:10000,concurrency:32,windowMs:60000,globalRequests:1000,appRequests:120,actorRequests:60,maxRateKeys:4096});
/** Single-process quotas. Never evict a live window to admit a new key. */
export class GatewayAdmission {
  readonly limits: Readonly<GatewayLimits>;
  private active = 0;
  private readonly global;
  private readonly apps;
  private readonly actors;
  constructor(input: Partial<GatewayLimits> = {}) {
    this.limits = Object.freeze({...DEFAULT_GATEWAY_LIMITS,...input});
    for (const value of Object.values(this.limits)) if (!Number.isSafeInteger(value) || value < 1) throw new Error('Invalid gateway limit');
    if(this.limits.requestBytes>65536 || this.limits.resultBytes>524288 || this.limits.timeoutMs>30000 || this.limits.concurrency>128 || this.limits.maxRateKeys>65536 || this.limits.windowMs>3600000 || Math.max(this.limits.globalRequests,this.limits.appRequests,this.limits.actorRequests)>1000000) throw new Error('Gateway limit exceeds hard bound');
    const records = new Map<string,RateLimitRecord>();
    const store: RateLimitStore = { get:(key,now)=>{ for (const [k,v] of records) if(v.resetAt<=now) records.delete(k); return records.get(key)??null; },set:(key,value)=>{if(!records.has(key)&&records.size>=this.limits.maxRateKeys) throw new GatewayError('RATE_LIMITED',429);records.set(key,value);} };
    const make=(limit:number)=>createFixedWindowRateLimiter({limit,windowMs:this.limits.windowMs,store});
    this.global=make(this.limits.globalRequests);this.apps=make(this.limits.appRequests);this.actors=make(this.limits.actorRequests);
  }
  preauth() { if(!this.global.check('global').allowed) throw new GatewayError('RATE_LIMITED',429); }
  authenticated(appId:string,actor:string) { if(!this.apps.check(`app:${appId}`).allowed || !this.actors.check(`actor:${appId}:${actor}`).allowed) throw new GatewayError('RATE_LIMITED',429); }
  enter() { if(this.active>=this.limits.concurrency) throw new GatewayError('BUSY',503);this.active++;return ()=>{this.active--;}; }
}
