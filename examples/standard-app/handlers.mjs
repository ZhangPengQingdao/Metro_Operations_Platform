import {allowsAppResource} from '@metro/platform-sdk/app-backend';
import {createPlatformDirectoryClient} from '@metro/platform-sdk/app-directory';
import config from './app.json' with {type:'json'};
export function createHandlers(gateway){
 const directory=createPlatformDirectoryClient(gateway);
 return new Map([['members',{method:'POST',path:'/members',requireEmployeeContext:true,
  async execute(payload,signal,employee){
   const fail=code=>({ok:false,error:{code,writeOutcome:'not_started'}});
   if(!employee||!allowsAppResource(employee,`app.${config.id}.read`,{organizationUnitId:employee.organizationUnitId,ownerPersonId:employee.personId}))return fail('ACCESS_DENIED');
   if(!payload||typeof payload!=='object'||Array.isArray(payload)||Object.keys(payload).some(k=>k!=='search')||payload.search!==undefined&&(typeof payload.search!=='string'||payload.search.length>100))return fail('INVALID_PARAMS');
   const result=await directory.members({organizationUnitId:employee.organizationUnitId,...(payload.search?{search:payload.search}:{})},signal);
   return {ok:true,result};
  }
 }]]);
}
