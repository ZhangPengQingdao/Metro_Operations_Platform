export class EmployeeRequestError extends Error{constructor(readonly status:number,readonly code:string,readonly writeOutcome?:'not_started'|'unknown'){super(({EMPLOYEE_SERVICE_UNAVAILABLE:'服务暂时不可用，请稍后重试。',EMPLOYEE_NETWORK_ERROR:'与服务器的连接中断，未能确认操作结果。请重新读取并核对状态，避免重复提交。',EMPLOYEE_RESPONSE_INCOMPLETE:'服务器响应不完整，未能确认操作结果。请重新读取并核对状态，避免重复提交。',CHAT_BUSY:'当前有任务正在处理，请稍后再发送。',CHAT_LIMIT:'本次对话已达到 50 轮，请新建对话。',CHAT_NOT_FOUND:'对话不存在或不属于当前账号。',REQUEST_ID_REUSED:'发送标识已被使用，请新建对话。',STALE_REVISION:'授权配置已变化，请重新打开应用管理后再保存。',APP_OWNER_REQUIRED:'只有当前应用负责人可以管理授权。',APP_SCOPE_UNSUPPORTED:'应用不支持所选操作或数据范围。',APP_SCOPE_LIMIT:'授权范围超过当前支持的组织数量，请缩小范围。',APP_DISABLED:'应用已停用。',EMPLOYEE_PERSON_INACTIVE:'人员或所属组织、岗位已停用。',EMPLOYEE_PASSWORD_CHANGE_REQUIRED:'请先修改密码，再使用系统。',EMPLOYEE_PASSWORD_INCORRECT:'当前密码不正确。',EMPLOYEE_WECOM_ID_EXISTS:'该企业微信 UserID 已被使用。',EMPLOYEE_INVALID_INPUT:'请检查填写内容；密码至少 8 位，且包含大写字母、小写字母、数字、特殊符号中的至少三类。',EMPLOYEE_LOGIN_FAILED:'用户名或密码不正确。',EMPLOYEE_AUTH_REQUIRED:'登录已失效，请重新登录。',EMPLOYEE_RATE_LIMIT:'尝试次数过多，请稍后再试。',EMPLOYEE_APP_ACCESS_DENIED:'当前不在该应用的人员范围内，或角色没有可用业务权限。请联系应用负责人核对。',APP_ACCESS_MANAGED_BY_ROLE:'此应用已由人员范围和业务角色控制访问，无需单独分配使用权限。',APP_CAPABILITY_NOT_DECLARED:'此接口未在当前应用版本中声明为可开放，请先更新应用包。',APP_CAPABILITY_NOT_PUBLISHED:'目标应用负责人尚未开放此接口，或已关闭开放。',TARGET_APP_ACCESS_DENIED:'当前员工在目标应用的角色权限或数据范围不足，请联系目标应用负责人核对。',APP_RESOURCE_ORIGIN_NOT_CONFIGURED:'应用资源域尚未配置。',ACCESS_DENIED:'当前操作超出应用角色权限或数据范围，请联系应用负责人核对。'} as Record<string,string>)[code]??`操作未确认（${code}），请核对后再操作。`);}}
export async function employeeRequest<T>(path:string,options:{method?:string;body?:unknown;signal?:AbortSignal;admissionKey?:string}={}):Promise<T>{
 const payload=options.body===undefined?undefined:JSON.stringify(options.body);
 let response:Response;
 try{
  response=await fetch(`/api/employee${path}`,{method:options.method??'GET',credentials:'same-origin',signal:options.signal,headers:{...(payload===undefined?{}:{'Content-Type':'application/json'}),...(options.admissionKey?{'X-Mop-Employee-Admission':options.admissionKey}:{})},body:payload});
 }catch(error){
  if(options.signal?.aborted)throw error;
  throw new EmployeeRequestError(0,'EMPLOYEE_NETWORK_ERROR','unknown');
 }
 options.signal?.throwIfAborted();
 // Authentication expiry is meaningful even if a proxy returned an incomplete body.
 if(response.status===401&&path!=='/auth/login')window.dispatchEvent(new Event('mop-employee-session-expired'));
 let value;
 try{value=await response.json();}
 catch(error){
  if(options.signal?.aborted)throw error;
  throw new EmployeeRequestError(response.status,'EMPLOYEE_RESPONSE_INCOMPLETE','unknown');
 }
 options.signal?.throwIfAborted();
 if(!response.ok)throw new EmployeeRequestError(response.status,typeof value?.error==='string'?value.error:value?.error?.code??'EMPLOYEE_REQUEST_FAILED',value?.error?.writeOutcome);
 return value as T;
}
