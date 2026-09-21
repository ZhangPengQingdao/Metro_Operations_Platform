export class AdminRequestError extends Error {constructor(readonly status:number,readonly code:string,message:string){super(message);}}
const messages:Record<string,string>={REGISTRATION_PERSON_EXISTS:'此工号已有人事记录，请核对姓名、组织和岗位，或通过创建员工账号关联已有人员。',REGISTRATION_CONFLICT:'工号或企业微信 UserID 已被使用，请核对后处理。',REGISTRATION_ALREADY_REVIEWED:'申请已被处理，请重新打开审核列表。',REGISTRATION_ASSIGNMENT_INACTIVE:'请选择启用的组织和岗位。',ADMIN_AUTH_REQUIRED:'管理员登录已失效，请重新登录。',ADMIN_LOGIN_FAILED:'用户名或密码不正确。',ADMIN_DATABASE_UNAVAILABLE:'管理员数据库尚未配置。',ADMIN_SERVICE_UNAVAILABLE:'管理服务不可用，请检查数据库和迁移配置。',ADMIN_ORIGIN_DENIED:'当前访问地址与平台配置不一致。',ADMIN_RATE_LIMIT:'尝试次数过多，请稍后再试。',INSTALL_BUSY:'当前有安装包正在上传或处理，请稍后再试。',APP_RUNTIME_NOT_CONFIGURED:'应用运行宿主尚未配置。',APP_INSTALL_NOT_CONFIGURED:'安装服务尚未配置。',ADMIN_INVALID_INPUT:'请检查填写内容。',STALE_REVISION:'数据已变化，请刷新后重新核对。'};
export async function adminRequest<T>(path:string,options:{method?:string;body?:unknown;signal?:AbortSignal}={}):Promise<T>{
 const payload=options.body===undefined?undefined:JSON.stringify(options.body);
 let response:Response;
 try{response=await fetch(`/api/admin${path}`,{method:options.method??'GET',credentials:'same-origin',signal:options.signal,headers:options.body===undefined?undefined:{'Content-Type':'application/json'},body:payload});
 }catch(error){
  if(options.signal?.aborted)throw error;
  throw new AdminRequestError(0,'ADMIN_NETWORK_ERROR','与服务器的连接中断，未能确认操作结果。请刷新核对当前状态后再操作，避免重复提交。');
 }
 if(response.status===401&&path!=='/auth/login')window.dispatchEvent(new Event('afc-admin-session-expired'));
 const body:unknown=await response.json().catch(()=>{throw new AdminRequestError(response.status,'ADMIN_RESPONSE_INCOMPLETE','服务器响应不完整，未能确认操作结果。请刷新核对当前状态后再操作，避免重复提交。');});
 if(!response.ok){const value=body&&typeof body==='object'?body as {error?:unknown;message?:unknown}:{};const code=typeof value.error==='string'?value.error:'ADMIN_REQUEST_FAILED';throw new AdminRequestError(response.status,code,(code==='APP_CAPABILITIES_NOT_SUPPORTED'?'当前平台尚不支持应用申请的能力，请先升级平台后重新预览安装。':messages[code])??(typeof value.message==='string'?value.message:`操作未确认完成（${code}），请刷新核对状态后再操作。`));}
 return body as T;
}
