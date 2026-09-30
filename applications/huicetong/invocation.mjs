/** Managed storage leases are exclusive; dispatch this frame's backend calls in order. */
export function serializeAppInvocations(invoke){
 let tail=Promise.resolve();
 return (name,payload)=>{
  const result=tail.then(()=>invoke(name,payload));
  // The caller still receives rejection; only the next distinct call may continue.
  tail=result.then(()=>undefined,()=>undefined);
  return result;
 };
}
