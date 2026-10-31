const readMessages={
 RATE_LIMITED:'请求较频繁，请稍后重新读取。',BUSY:'服务忙，请稍后重新读取。',
 TIMEOUT:'读取超时，请重新读取。',AUDIT_FAILED:'服务暂时未能确认读取结果，请稍后重试。',
 GATEWAY_FAILED:'平台服务暂不可用，请稍后重试。',READ_FAILED:'读取未完成，请重新读取。',
 ACCESS_DENIED:'没有此操作权限或数据不在授权范围内',
};
export const PUBLIC_READ_ERRORS=new Set(Object.keys(readMessages));
export function appResponseError(response,{messages={},write=false}={}){
 const detail=response?.error,code=typeof detail?.code==='string'?detail.code:'READ_FAILED';
 const error=Error(messages[code]??readMessages[code]??(write?'写入结果待核对':'读取未完成，请重新读取。'));
 error.code=code;error.definitive=detail?.writeOutcome==='not_started';
 if(typeof detail?.requestId==='string'&&/^[a-f0-9-]{36}$/i.test(detail.requestId))error.requestId=detail.requestId;
 return error;
}
