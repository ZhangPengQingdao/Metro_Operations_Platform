export type RetainedApp={accountId:string;appId:string;path:string;prefetch:boolean};

/** Keep only the two most recently visited applications for this employee. */
export function rememberApp(current:readonly RetainedApp[],next:RetainedApp):RetainedApp[]{
 return [...current.filter(item=>item.accountId===next.accountId&&item.appId!==next.appId),next].slice(-2);
}
