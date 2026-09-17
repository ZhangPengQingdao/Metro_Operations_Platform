export class EmployeeRequestError extends Error{constructor(readonly status:number,readonly code:string){super(({EMPLOYEE_PASSWORD_INCORRECT:'当前密码不正确。',EMPLOYEE_WECOM_ID_EXISTS:'该企业微信 UserID 已被使用。',EMPLOYEE_INVALID_INPUT:'请检查填写内容；新密码至少 12 位。',EMPLOYEE_LOGIN_FAILED:'用户名或密码不正确。',EMPLOYEE_AUTH_REQUIRED:'登录已失效，请重新登录。',EMPLOYEE_RATE_LIMIT:'尝试次数过多，请稍后再试。',EMPLOYEE_APP_ACCESS_DENIED:'此应用的使用权限已撤销。',APP_RESOURCE_ORIGIN_NOT_CONFIGURED:'应用资源域尚未配置。',ACCESS_DENIED:'当前无权执行此操作。'} as Record<string,string>)[code]??`操作未确认（${code}），请核对后再操作。`);}}
export async function employeeRequest<T>(path:string,options:{method?:string;body?:unknown;signal?:AbortSignal;admissionKey?:string}={}):Promise<T>{
 const response=await fetch(`/api/employee${path}`,{method:options.method??'GET',credentials:'same-origin',signal:options.signal,headers:{...(options.body===undefined?{}:{'Content-Type':'application/json'}),...(options.admissionKey?{'X-Mop-Employee-Admission':options.admissionKey}:{})},body:options.body===undefined?undefined:JSON.stringify(options.body)});
 const value=await response.json().catch(()=>null);
 if(!response.ok){if(response.status===401&&path!=='/auth/login')window.dispatchEvent(new Event('mop-employee-session-expired'));throw new EmployeeRequestError(response.status,typeof value?.error==='string'?value.error:value?.error?.code??'EMPLOYEE_REQUEST_FAILED');}
 return value as T;
}
