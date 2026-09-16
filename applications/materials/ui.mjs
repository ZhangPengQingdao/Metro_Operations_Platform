import {createAppSandboxClient,createAppApiClient} from '@metro/platform-sdk/app-sandbox';
const script=document.currentScript,origin=script?.dataset.platformOrigin;
const style=document.createElement('style');style.nonce=script?.nonce??'';style.textContent=':root{font-family:Manrope,system-ui,sans-serif;color:#27272a;background:#fafafa}body{margin:0;padding:24px}.afc-app-shell{max-width:1200px;margin:auto}.afc-card{background:#fff;border:1px solid #e4e4e7;border-radius:16px;padding:24px;margin:16px 0}.afc-form{display:grid;gap:14px}.afc-field{display:grid;gap:6px;font-size:13px}.afc-control,.afc-control--search{border:1px solid #d4d4d8;border-radius:8px;padding:9px 12px;font:inherit;background:#fff}.afc-button{border:1px solid #d4d4d8;border-radius:999px;padding:9px 16px;margin:8px 8px 0 0;background:#fff;font:inherit;cursor:pointer}.afc-button--primary{background:#18181b;color:#fff;border-color:#18181b}.afc-button--secondary{background:#fff;color:#27272a}.afc-button:disabled{opacity:.5;cursor:default}.afc-filter-bar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:16px 0}.afc-data-table{border-collapse:collapse;font-size:14px;width:100%;margin-top:16px}.afc-data-table td,.afc-data-table th{padding:10px;border-bottom:1px solid #e4e4e7;text-align:left;overflow-wrap:anywhere}.afc-sidebar-nav{display:flex;flex-direction:column;gap:6px;width:224px}.afc-sidebar-nav .afc-button{text-align:left;width:100%}#app{max-width:1200px;margin:auto}@media(max-width:700px){.afc-sidebar-nav{width:auto;flex-direction:row;flex-wrap:wrap}.afc-sidebar-nav .afc-button{width:auto}}';document.head.append(style);
const root=document.getElementById('app');root.className='afc-app-shell';
const element=(tag,text)=>{const node=document.createElement(tag);if(text)node.textContent=text;return node;};
const lastRequest=element('p');lastRequest.className='afc-muted';root.append(lastRequest);
const status=element('p');status.setAttribute('role','status');root.append(element('h1','物料管理'),status);
if(!origin)throw Error('PLATFORM_ORIGIN_REQUIRED');
const sandbox=createAppSandboxClient({appId:'materials',platformOrigin:origin,port:{parent:window.parent,send:(data,target)=>window.parent.postMessage(data,target),listen:listener=>{window.addEventListener('message',listener);return()=>window.removeEventListener('message',listener);}}});
const api=createAppApiClient(sandbox);let busy=false,uncertain=false;
const errors={ACCESS_DENIED:'没有此操作权限',SETTINGS_CONFLICT:'设置已变化，请刷新后重试',INVALID_INPUT:'请检查填写内容',INSUFFICIENT_STOCK:'库存不足',ALREADY_REVERSED:'该记录已冲销',REVERSAL_NOT_ALLOWED:'不能冲销冲销记录',MATERIAL_DENIED:'无权访问物料',MOVEMENT_DENIED:'无权访问记录'};
async function call(name,payload,write=false){
 if(busy||write&&uncertain)return null;busy=true;status.textContent='处理中…';
 try{const reply=await api.invoke(name,payload);if(!reply.ok){if(reply.error.writeOutcome==='unknown')uncertain=true;status.textContent=errors[reply.error.code]??'结果未确认，请核对记录并联系管理员，勿重复提交';return null;}status.textContent='已完成';return reply.result;}
 catch{if(write)uncertain=true;status.textContent='请求未完成，请核对原请求结果，勿重复提交';return null;}
 finally{busy=false;}
}
const layout=element('div'),sidebar=element('nav'),content=element('main');layout.className='afc-app-layout';sidebar.className='afc-sidebar-nav';sidebar.setAttribute('aria-label','物料应用导航');layout.append(sidebar,content);root.append(layout);
const sections=new Map();for(const name of ['库存','记录','新建物料','入库','出库','入库纠错','本人出库纠错','设置']){const section=element('section');section.hidden=true;content.append(section);sections.set(name,section);}
let capabilities={leader:false,manageMaterials:false},currentPage='库存';
const privilegedPages=new Set(['新建物料','入库','入库纠错']);
function allowed(name){return name==='设置'?capabilities.leader:!privilegedPages.has(name)||capabilities.manageMaterials;}
async function navigate(name){const fresh=await call('session',{});if(!fresh)return;capabilities=fresh;renderNavigation();currentPage=allowed(name)?name:'库存';for(const [key,section]of sections)section.hidden=key!==currentPage;if(currentPage==='库存'||currentPage==='记录'){kind=currentPage==='库存'?'materials':'movements';sections.get(currentPage).append(toolbar,output);search.hidden=kind!=='materials';cursor=null;await load();}if(currentPage==='设置')await loadMembers();}
function renderNavigation(){sidebar.replaceChildren();for(const name of sections.keys()){if(!allowed(name))continue;const button=element('button',name);button.className='afc-button afc-button--secondary';button.type='button';button.onclick=()=>void navigate(name);sidebar.append(button);}}
style.textContent+=' .layout{display:flex;gap:24px}.layout nav{width:224px;flex-shrink:0}.layout nav button{display:block;width:100%;text-align:left}.layout main{min-width:0;flex:1;overflow-x:auto}[hidden]{display:none!important}@media(max-width:700px){.layout{display:block}.layout nav{width:auto;display:flex;flex-wrap:wrap}.layout nav button{width:auto}}';
function form(title,fields,submit){
 const f=element('form');f.className='afc-form afc-card';f.append(element('h2',title));const inputs={};
 for(const [name,label,type='text']of fields){const l=element('label'),i=element('input');l.className='afc-field';l.append(element('span',label));i.type=type;i.name=name;i.required=true;i.className='afc-control';if(type==='number'){i.min='1';i.max='2147483647';i.step='1';}l.append(i);f.append(l,element('br'));inputs[name]=i;}
 const button=element('button','提交');button.className='afc-button afc-button--primary';button.type='submit';f.append(button);f.onsubmit=async event=>{event.preventDefault();if(busy||uncertain)return;button.disabled=true;const requestId=crypto.randomUUID();lastRequest.textContent=`请求编号：${requestId}`;try{await submit(Object.fromEntries(Object.entries(inputs).map(([k,i])=>[k,i.type==='number'?Number(i.value):i.value])),requestId);}finally{button.disabled=false;}};sections.get(title).append(f);
}
form('新建物料',[['name','名称'],['sku','SKU'],['unit','单位']],async(v,requestId)=>call('create',{...v,requestId},true));
for(const [direction,title]of [['in','入库'],['out','出库']])form(title,[['materialId','物料 ID'],['quantity','数量','number'],['remark','备注']],async(v,requestId)=>call(direction==='in'?'inbound':'outbound',{...v,requestId},true));
for(const [apiId,title]of [['reverse-inbound','入库纠错'],['reverse-outbound','本人出库纠错']])form(title,[['movementId','原流水 ID'],['reason','原因']],async(v,requestId)=>call(apiId,{...v,requestId},true));
const toolbar=element('div'),search=element('input');toolbar.className='afc-filter-bar';search.className='afc-control afc-control--search';search.placeholder='物料名称';toolbar.append(search);
const output=element('div');let kind='materials',cursor=null;
async function load(next=false){const result=await call('list',{kind,...(next&&cursor?{afterId:cursor}:{}),...(kind==='materials'&&search.value?{search:search.value}:{})});if(!result)return;cursor=result.nextCursor;output.replaceChildren();const table=element('table');table.className='afc-data-table';const columns=kind==='materials'?['id','name','sku','unit','quantity']:['id','material_id','kind','delta','operator_id','created_at','reverses_id','remark'];const tr=element('tr');const labels={id:'编号',name:'名称',sku:'SKU',unit:'单位',quantity:'库存',material_id:'物料编号',kind:'类型',delta:'变动数量',operator_id:'操作人编号',created_at:'时间',reverses_id:'原流水编号',remark:'备注'};for(const c of columns)tr.append(element('th',labels[c]));table.append(tr);for(const row of result.rows){const tr=element('tr');for(const c of columns)tr.append(element('td',String(row[c]??'')));table.append(tr);}output.append(table);nextButton.disabled=!cursor;}
const refresh=element('button','查询');refresh.className='afc-button afc-button--secondary';refresh.onclick=()=>void load();toolbar.append(refresh);
const nextButton=element('button','下一页');nextButton.className='afc-button afc-button--secondary';nextButton.disabled=true;nextButton.onclick=()=>void load(true);toolbar.append(nextButton);
window.addEventListener('pagehide',()=>sandbox.close(),{once:true});

const settings=sections.get('设置'),memberSearch=element('input'),memberList=element('div');memberSearch.className='afc-control afc-control--search';memberSearch.placeholder='姓名或工号';const findMembers=element('button','查询成员');findMembers.className='afc-button afc-button--secondary';settings.append(element('h2','工班物资管理员'),memberSearch,findMembers,memberList);findMembers.onclick=()=>void loadMembers();
async function loadMembers(){
 const result=await call('members',memberSearch.value?{search:memberSearch.value}:{});if(!result)return;memberList.replaceChildren();
 for(const member of result.rows){const row=element('p',`${member.name}（${member.employeeNo}）`),button=element('button',member.manager?'撤销物资管理员':'设为物资管理员');button.className='afc-button afc-button--secondary';button.type='button';button.onclick=async()=>{if(busy||uncertain)return;const requestId=crypto.randomUUID();lastRequest.textContent=`请求编号：${requestId}`;button.disabled=true;const saved=await call('set-manager',{requestId,personId:member.id,active:!member.manager,revision:member.revision},true);button.disabled=false;if(saved)await loadMembers();};row.append(button);memberList.append(row);}
 if(!result.rows.length)memberList.append(element('p','没有匹配的在职工班成员'));else if(result.rows.length===50)memberList.append(element('p','最多显示 50 人，请输入姓名或工号缩小范围'));
}
const readyDeadline=Date.now()+10000;
const readyTimer=setInterval(()=>{if(sandbox.ready()){clearInterval(readyTimer);void navigate('库存');}else if(Date.now()>readyDeadline){clearInterval(readyTimer);status.textContent='应用连接未就绪，请重新打开';}},25);
window.addEventListener('pagehide',()=>clearInterval(readyTimer),{once:true});
