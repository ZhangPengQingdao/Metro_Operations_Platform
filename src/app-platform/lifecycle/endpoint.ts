export function lifecycleEndpoint(appId:string){
 if(appId.length>64||!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(appId))throw Error('应用 ID 格式不正确');
 return `/api/v1/apps/${appId}/lifecycle`;
}
