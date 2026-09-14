import type { PlatformActorContext, PlatformRequestMetadata } from './index.js';
import type { AuthorizationDecision, AuthorizationResource } from '../authorization/index.js';
/** Control-plane identity; never a delegated employee or an application actor. */
export interface PlatformAdministratorContext {
 actorType: 'administrator';
 administrator: {id:string;username:string;displayName:string};
 execution: {type:'platform'};
 request: PlatformRequestMetadata;
 authorize(permission:string,resource?:AuthorizationResource):Promise<Omit<AuthorizationDecision,'subjectType'> & {subjectType:'administrator'}>;
}
export type PlatformManagementContext = PlatformActorContext | PlatformAdministratorContext;
export function isNativeManagementActor(context:PlatformManagementContext) {
 return (context.actorType==='person'||context.actorType==='administrator')&&context.execution.type==='platform';
}
export function managementActorId(context:PlatformManagementContext):string {
 if(context.actorType==='administrator')return context.administrator.id;
 if(context.actorType==='person')return context.person.id;
 throw Error('MANAGEMENT_IDENTITY_REQUIRED');
}
