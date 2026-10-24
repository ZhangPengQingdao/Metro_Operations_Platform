import {createAppDataClient} from '@metro/platform-sdk/app-gateway';
import {createManagedAppImageStore} from '@metro/platform-sdk/app-files-backend';
import {fail,requireAllowed,targetOrganization} from './policy.mjs';

/** The SDK owns image storage; this adapter supplies the hazards app's business permissions. */
export function createPhotoService(gateway,{clock}={}){
 const data=createAppDataClient(gateway);
 return createManagedAppImageStore(gateway,{
  ...(clock?{clock}:{}),
  authorizeWrite(employee,organizationId){
   targetOrganization(employee,'photo',organizationId);
   try{targetOrganization(employee,'create',organizationId);}
   catch(error){if(error?.message!=='ACCESS_DENIED')throw error;targetOrganization(employee,'update',organizationId);}
  },
  async resolveRead(employee,recordId,photoId,signal){
   const {row}=await data.get('records',recordId,signal);
   if(!row||![row.before_photo_id,row.after_photo_id].includes(photoId))fail('ACCESS_DENIED');
   requireAllowed(employee,'read',row);
   return {organizationId:row.organization_id};
  }
 });
}
