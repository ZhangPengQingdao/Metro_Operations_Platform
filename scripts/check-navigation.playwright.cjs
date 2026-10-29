// Run with playwright-cli run-code --filename=scripts/check-navigation.playwright.cjs
// Uses the real local frontend with intercepted API fixtures; never modifies platform data.
async (page) => {
  await page.goto('about:blank');
  const origin = 'http://127.0.0.1:4173';
  const check = (value, message) => { if (!value) throw new Error(message); };
  const app = {appId:'demo',name:'切换验收',description:'',version:'1',runtimeRevision:1,
    v2:{sha256:'a'.repeat(64),color:null,pages:[{path:'/records/:id',title:'记录'}]},
    navigation:[{id:'one',routeId:'one',label:'第一条'},{id:'two',routeId:'two',label:'第二条'}],
    routes:[{id:'one',path:'/records/one'},{id:'two',path:'/records/two'}]};
  let appsStatus=200,authStatus=200,adminStatus=503,managedStatus=200,appsVisible=true;
  let profileRequests=0,managedRequests=0,appsRequests=0;
  let releaseManaged;
  const managedGate=new Promise(resolve=>{releaseManaged=resolve;});
  const gates=new Map();
  const requests=[];
  const moduleSource=`
    const {createElement:h,useEffect}=globalThis.__MOP_SHARED__.react;
    const {defineApp,useApp}=globalThis.__MOP_SHARED__['@metro/platform-sdk/app'];
    function Page(){
      const app=useApp();
      useEffect(()=>{(window.__mounts??=[]).push(app.route.path);app.api.call('read',{path:app.route.path});},[app.api]);
      return h('div',null,h('p',{'data-testid':'record'},app.route.path),
        h('button',{onClick:()=>app.navigate('/records/two')},'打开第二条'),
        h('button',{onClick:async()=>{window.__confirmed=await app.confirm({title:'确认测试',message:'等待用户确认'});}},'打开确认'),
        h('button',{onClick:()=>app.toast('保存成功')},'显示提示'));
    }
    export default defineApp({pages:{'/records/:id':Page}});`;
  await page.route('**/api/**',async route=>{
    const url=new URL(route.request().url()),path=url.pathname;
    const json=(body,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
    if(path==='/api/platform/sites')return json({employee:origin,admin:origin});
    if(path==='/api/admin/auth/me')return json(adminStatus===200?{id:'admin',username:'admin',displayName:'验收管理员'}:{error:'ADMIN_SERVICE_UNAVAILABLE'},adminStatus);
    if(path==='/api/employee/auth/me')return json(authStatus===200?{id:'account',personId:'person',username:'worker',name:'验收员工'}:{error:authStatus===401?'EMPLOYEE_AUTH_REQUIRED':'EMPLOYEE_SERVICE_UNAVAILABLE'},authStatus);
    if(path==='/api/employee/profile'){profileRequests++;return json({error:'UNEXPECTED_PROFILE'},500);}
    if(path==='/api/employee/managed-apps'){managedRequests++;await managedGate;return json(managedStatus===200?{applications:[]}:{error:'EMPLOYEE_SERVICE_UNAVAILABLE'},managedStatus);}
    if(path==='/api/employee/apps'){appsRequests++;return json(appsStatus===200?{applications:appsVisible?[app]:[]}:{error:'EMPLOYEE_SERVICE_UNAVAILABLE'},appsStatus);}
    if(path.endsWith('/v2-session')){
      const target=url.searchParams.get('path');requests.push(target);
      if(gates.has(target))await gates.get(target).promise;
      if(target==='/records/denied')return json({error:{code:'ACCESS_DENIED'}},403);
      return json({appId:'demo',name:app.name,admissionKey:'fixture',sha256:app.v2.sha256,moduleUrl:'/api/employee/apps/demo/v2/fixture/ui.js',
        route:{path:target,pattern:'/records/:id',params:{id:target.split('/').at(-1)},title:'记录'},
        user:{personId:'person',name:'验收员工',organizationUnitId:'org',permissions:['read']}});
    }
    if(path.endsWith('/ui.js'))return route.fulfill({contentType:'text/javascript',body:moduleSource});
    if(path.endsWith('/api'))return json({result:{ok:true}});
    if(path.endsWith('/icon'))return route.fulfill({status:204});
    if(path.endsWith('/notifications'))return json({notifications:[]});
    if(path.endsWith('/dashboard-layout'))return json({layout:null,revision:0});
    if(path.endsWith('/chat/capabilities'))return json({capabilities:[]});
    if(path.endsWith('/chats'))return json({sessions:[]});
    if(path.endsWith('/overview'))return json({installed:0,enabled:0,attention:0,runtimeConfigured:true,installConfigured:true});
    return json({error:'UNEXPECTED_REQUEST'},500);
  });
  const hold=path=>{let release;const promise=new Promise(resolve=>{release=resolve;});gates.set(path,{promise,release});};
  const navigate=path=>page.evaluate(path=>{location.hash=`#/employee/app/demo${path}`;},path);
  const record=path=>page.getByTestId('record').filter({hasText:path}).waitFor();
  const mounts=()=>page.evaluate(()=>window.__mounts?.length??0);
  const waitRequest=async path=>{for(let i=0;i<100&&!requests.includes(path);i++)await new Promise(resolve=>setTimeout(resolve,20));check(requests.includes(path),`missing session request ${path}`);};

  try{
    await page.goto(`${origin}/#/employee/app/demo/records/one`);
    await record('/records/one');
    check(profileRequests===0,'app startup must not depend on profile');
    check(managedRequests>0,'management request should start independently');
    releaseManaged();
    const initial=await mounts();
    hold('/records/two');
    await page.getByRole('button',{name:'打开第二条'}).click();
    await waitRequest('/records/two');
    await page.getByText('正在打开切换验收…').waitFor();
    check(await page.getByTestId('record').count()===0,'old page must disappear during navigation');
    check(await mounts()===initial,'navigation must not remount the previous record');
    gates.get('/records/two').release();await record('/records/two');
    const beforeToast=await mounts();
    await page.getByRole('button',{name:'显示提示'}).click();
    await page.getByText('保存成功').waitFor();
    check(await mounts()===beforeToast,'toast must not recreate app API and trigger data reload');
    await page.getByRole('button',{name:'打开确认'}).click();
    await page.getByRole('dialog').waitFor();

    hold('/records/slow');await navigate('/records/slow');await waitRequest('/records/slow');
    check(await page.evaluate(()=>window.__confirmed)===false,'navigation must settle a pending confirmation as cancelled');
    await navigate('/records/fast');await record('/records/fast');
    gates.get('/records/slow').release();
    await page.waitForTimeout(100);
    check(await page.getByTestId('record').textContent()==='/records/fast','late session must not replace the current page');

    appsStatus=503;managedStatus=503;
    const priorApps=appsRequests;
    await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
    await page.getByRole('alert').filter({hasText:'服务暂时不可用'}).waitFor();
    check(appsRequests>priorApps,'background refresh must run');
    await record('/records/fast');
    appsStatus=200;managedStatus=200;
    await page.getByRole('button',{name:'重试读取应用列表'}).click();
    await page.getByRole('button',{name:'重试读取应用列表'}).waitFor({state:'hidden'});

    await navigate('/records/denied');
    await page.getByRole('alert').filter({hasText:'没有访问此页面的权限'}).waitFor();
    check(await page.getByTestId('record').count()===0,'real permission denial must not show old content');
    await navigate('/records/one');await record('/records/one');
    appsVisible=false;await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
    await page.getByText('应用不可用或访问权限已变更。').waitFor();
    check(await page.getByTestId('record').count()===0,'successful revocation must remove the app');
    appsVisible=true;

    authStatus=503;await page.reload();
    await page.getByRole('button',{name:'重试读取登录状态'}).waitFor();
    check(page.url().includes('/employee/app/demo/records/one'),'transient auth failure must preserve destination');
    authStatus=200;await page.getByRole('button',{name:'重试读取登录状态'}).click();await record('/records/one');
    for(let i=0;i<3;i++){await page.reload();await record('/records/one');}
    await page.screenshot({path:'output/playwright/navigation-stable.png',fullPage:true});
    const loadedAssets=await page.evaluate(()=>performance.getEntriesByType('resource').map(entry=>entry.name));
    check(!loadedAssets.some(url=>/\/(ChatPage|EmployeeDashboard|ManagedApplications)-/.test(url)),'business app startup must not load auxiliary pages');
    await page.evaluate(()=>{location.hash='#/employee/apps';});
    await page.getByRole('heading',{name:'应用管理',exact:true}).waitFor();
    await page.route('**/assets/ChatPage-*.js',route=>route.abort());
    await page.evaluate(()=>{location.hash='#/employee/chat';});
    await page.getByRole('alert').filter({hasText:'应用页面出错。'}).waitFor();
    check(await page.getByRole('complementary').count()>0,'chunk failure must preserve the shell');
    await page.unroute('**/assets/ChatPage-*.js');
    await page.getByRole('button',{name:'重新加载',exact:true}).click();
    await page.getByRole('heading',{name:'验收员工，今天有什么需要帮忙？'}).waitFor();
    await page.evaluate(()=>{location.hash='#/employee';});
    await page.getByRole('button',{name:'首页设置'}).waitFor({state:'visible'});
    check(await page.locator('.dashboard').count()>0||await page.getByRole('link',{name:'切换验收'}).count()>0,'dashboard should load after navigation');

    await page.goto(`${origin}/#/admin`);
    await page.getByRole('button',{name:'重试读取登录状态'}).waitFor();
    check(page.url().endsWith('#/admin'),'admin transient auth failure must preserve destination');
    adminStatus=200;await page.getByRole('button',{name:'重试读取登录状态'}).click();
    await page.getByRole('heading',{name:'系统总览'}).waitFor();
    authStatus=401;adminStatus=401;await page.goto(`${origin}/#/employee/app/demo/records/one`);
    await page.getByRole('form',{name:'登录'}).waitFor();
    check(page.url().endsWith('#/login'),'expired employee session must redirect to login');
    return {result:'PASS',profileRequests,checks:['independent startup','route isolation','stable toast runtime','confirmation cleanup','late response','transient catalog failure','403 denial','revocation','auth retry','repeated refresh','lazy pages','chunk failure recovery','admin retry','401 login']};
  }finally{
    releaseManaged();for(const gate of gates.values())gate.release();
    await page.unrouteAll({behavior:'wait'});
  }
}
