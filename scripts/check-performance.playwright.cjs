// Run with playwright-cli run-code --filename=scripts/check-performance.playwright.cjs.
// Real production frontend, intercepted API fixtures; no platform data is modified.
async (page) => {
  const origin='http://127.0.0.1:4173',requests=[],failures=[],durations=[];
  const check=(condition,message)=>{if(!condition)throw Error(message);};
  const apps=['faults','maintenance','todos','huicetong'].map(appId=>({appId,name:appId,description:'',version:'1',runtimeRevision:1,
    v2:{sha256:'a'.repeat(64),color:null,pages:[{path:'/',title:appId}]},dashboard:{routeId:'home'},
    navigation:[{id:'home',routeId:'home',label:appId}],routes:[{id:'home',path:'/'}]}));
  const moduleSource=`const {createElement:h}=globalThis.__MOP_SHARED__.react;
    const {defineApp,useApp}=globalThis.__MOP_SHARED__['@metro/platform-sdk/app'];
    function Page(){const app=useApp();return h('p',{'data-testid':'app-ready'},app.appId);}
    export default defineApp({pages:{'/':Page}});`;
  let holdSummaries=false,release,releaseHost;
  let gate=Promise.resolve();
  const resources=[];
  const recordError=error=>failures.push(error.message);
  const recordResource=response=>{if(response.url().includes('/assets/'))resources.push({name:response.url(),bytes:Number(response.headers()['content-length']??0)});};
  page.on('pageerror',recordError);page.on('response',recordResource);
  await page.route('**/api/**',async route=>{
    const path=new URL(route.request().url()).pathname;requests.push(path);
    const json=body=>route.fulfill({contentType:'application/json',body:JSON.stringify(body)});
    if(path==='/api/platform/sites')return json({employee:origin,admin:origin});
    if(path==='/api/employee/auth/me')return json({id:'account',personId:'person',username:'worker',name:'验收员工'});
    if(path==='/api/employee/apps')return json({applications:apps});
    if(path==='/api/employee/managed-apps')return json({applications:[]});
    if(path==='/api/employee/notifications/unread-count')return json({count:3});
    if(path==='/api/employee/dashboard-layout')return json({layout:null,revision:0});
    if(path.endsWith('/icon'))return route.fulfill({status:204});
    const appId=path.split('/')[4];
    if(path.endsWith('/dashboard')){
      if(holdSummaries)await gate;
      return json({version:'1.0',generatedAt:new Date().toISOString(),scopeLabel:'验收范围',
        metrics:[{id:'pending',label:`${appId}待处理`,value:3,unit:'项'}],items:[],completion:{completed:1,total:4}}).catch(()=>{});
    }
    if(path.endsWith('/v2-session'))return json({appId,name:appId,admissionKey:'fixture',sha256:'a'.repeat(64),
      moduleUrl:`/api/employee/apps/${appId}/v2/${'a'.repeat(64)}/ui.js`,
      route:{path:'/',pattern:'/',params:{},title:appId},user:{personId:'person',name:'验收员工',organizationUnitId:'org',permissions:['read']}});
    if(path.endsWith('/ui.js'))return route.fulfill({contentType:'text/javascript',body:moduleSource});
    if(path.endsWith('/notifications'))return json({notifications:[]});
    return route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({error:'UNEXPECTED_REQUEST'})});
  });
  const ready=()=>page.waitForFunction(()=>document.querySelectorAll('.dashboard-card[aria-busy="false"]').length===4);
  const count=path=>requests.filter(value=>value===path).length;
  try{
    await page.goto('about:blank');
    await page.goto(`${origin}/#/employee`);await ready();
    await page.evaluate(()=>document.fonts.ready);
    const assets=resources.slice();
    check(assets.some(entry=>/\/EmployeeApp-.*\.js/.test(entry.name)),'must observe real frontend resources');
    check(!assets.some(entry=>/\/AppPage-.*\.js/.test(entry.name)),'home must defer the app runtime');
    check(!assets.some(entry=>/chinese-simplified-400-normal/.test(entry.name)),'home must use font subsets');
    check(count('/api/employee/managed-apps')===0,'home must not fetch management');
    check(count('/api/employee/notifications')===0,'badge must not fetch notification bodies');
    const catalog=count('/api/employee/apps'),badge=count('/api/employee/notifications/unread-count');
    await page.evaluate(()=>{for(let i=0;i<20;i++){window.dispatchEvent(new Event('focus'));document.dispatchEvent(new Event('visibilitychange'));}});
    await page.waitForTimeout(100);
    check(count('/api/employee/apps')===catalog,'focus bursts must not repeat the catalogue');
    check(count('/api/employee/notifications/unread-count')===badge,'focus bursts must not repeat the badge');
    for(let i=0;i<8;i++){
      const started=Date.now();await page.reload();await ready();durations.push(Date.now()-started);
    }
    await page.screenshot({path:'output/playwright/performance-home.png',fullPage:true});
    holdSummaries=true;gate=new Promise(resolve=>{release=resolve;});
    const before=requests.filter(path=>path.endsWith('/dashboard')).length;
    await page.reload();await page.waitForFunction(()=>document.querySelectorAll('.dashboard-card').length===4);
    for(let i=0;i<50&&requests.filter(path=>path.endsWith('/dashboard')).length<before+2;i++)await page.waitForTimeout(20);
    check(requests.filter(path=>path.endsWith('/dashboard')).length===before+2,'summary concurrency must stay at two');
    await page.clock.setFixedTime(Date.now()+61000);
    await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));await page.waitForTimeout(100);
    check(requests.filter(path=>path.endsWith('/dashboard')).length===before+2,'in-flight summaries must not be restarted by visibility events');
    const hostGate=new Promise(resolve=>{releaseHost=resolve;});
    await page.route('**/assets/AppPage-*.js',async route=>{await hostGate;await route.continue();},{times:1});
    await Promise.all([
      page.waitForRequest('**/assets/AppPage-*.js'),
      page.waitForRequest('**/faults/v2-session?*'),
      page.evaluate(()=>{location.hash='#/employee/app/faults';}),
    ]);
    releaseHost();
    await page.getByTestId('app-ready').filter({hasText:'faults'}).waitFor();
    release();holdSummaries=false;await page.waitForTimeout(100);
    check(requests.filter(path=>path.endsWith('/dashboard')).length===before+2,'leaving home must cancel queued summaries');
    for(let i=0;i<12;i++){
      const appId=apps[(i+1)%apps.length].appId;
      await page.evaluate(id=>{location.hash=`#/employee/app/${id}`;},appId);
      await page.getByTestId('app-ready').filter({hasText:appId}).waitFor();
    }
    check(requests.filter(path=>path.endsWith('/ui.js')).length===apps.length,'each app version must load once during switching');
    check(count('/api/employee/managed-apps')===0,'app switching must not fetch management');
    await page.evaluate(()=>{location.hash='#/employee/apps';});
    await page.getByRole('heading',{name:'应用管理',exact:true}).waitFor();
    check(count('/api/employee/managed-apps')===1,'management must load when opened');
    check(failures.length===0,`page errors: ${failures.join('; ')}`);
    const fonts=assets.filter(entry=>/\.woff2?(\?|$)/.test(entry.name));
    return {reloads:durations,appSwitches:12,fontRequests:fonts.length,fontBytes:fonts.reduce((n,entry)=>n+entry.bytes,0),checks:'passed'};
  }finally{
    releaseHost?.();release?.();page.off('pageerror',recordError);page.off('response',recordResource);await page.unroute('**/api/**');
  }
}
