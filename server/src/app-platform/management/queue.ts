/** Serialize management work using one dedicated database session, outside transaction callbacks. */
export function createManagementQueue(){
 let pending=Promise.resolve();let closing=false;
 return {
  run<T>(work:()=>Promise<T>):Promise<T>{
   if(closing)return Promise.reject(new Error('APP_MANAGEMENT_CLOSED'));
   const next=pending.then(work);pending=next.then(()=>undefined,()=>undefined);return next;
  },
  async close(work:()=>Promise<void>){closing=true;await pending;await work();},
 };
}
