import type {AppManifest} from '../manifest/index.js';

/** Navigation and direct UI admission use the same declared route permissions. */
export async function readEmployeeNavigation(manifest:Pick<AppManifest,'routes'|'navigation'>,authorize:(permission:string)=>Promise<boolean>){
 const permissions=new Map<string,boolean>();
 for(const route of manifest.routes){
  if(route.permission&&!permissions.has(route.permission))permissions.set(route.permission,await authorize(route.permission));
 }
 const routes=manifest.routes.filter(route=>!route.permission||permissions.get(route.permission)===true);
 const ids=new Set(routes.map(route=>route.id));
 return {routes,navigation:manifest.navigation.filter(item=>ids.has(item.routeId))};
}
