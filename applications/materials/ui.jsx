import React,{useState,useEffect} from 'react';
import {createRoot} from 'react-dom/client';
import {Button,Input,QuantityInput,Select,Field,PencilSimpleLine,Trash,Plus,ArrowLineDown,ArrowLineUp,FilterBar,Table,TableHeader,TableBody,TableRow,TableHead,TableCell,TableActionButton,Dialog} from '@metro/platform-sdk/ui';
import {platformUiCss} from '@metro/platform-sdk/ui-styles';
import {createAppSandboxClient,createAppApiClient} from '@metro/platform-sdk/app-sandbox';
const script=document.currentScript,origin=script?.dataset.platformOrigin,route=decodeURIComponent(script?.dataset.appRoute??'/');
const style=document.createElement('style');style.nonce=script?.nonce??'';style.textContent=platformUiCss+'\nbody{margin:0;background:var(--afc-color-canvas)}.materials{padding:16px 24px;color:var(--afc-color-ink)}.materials h2{font-size:18px;font-weight:600;margin:0 0 16px}.materials-actions{display:flex;gap:8px;align-items:center}.materials-toolbar{margin-bottom:20px}.materials .materials-row-actions{gap:8px;flex-wrap:nowrap;min-width:160px}.materials .afc-table th{background:var(--afc-color-canvas)}.materials .afc-table td{height:76px}.materials .afc-table td:first-child{font-weight:500}.materials-pagination{display:flex;gap:12px;justify-content:flex-end;align-items:center;padding:16px 0}.materials-form{display:grid;gap:16px}.materials-error{padding:12px;background:#fff1f2;color:#9f1239;border-radius:8px;margin-bottom:12px}.materials-muted{color:var(--afc-color-muted);font-size:13px}.materials td{white-space:nowrap}.materials .materials-note{white-space:normal;min-width:120px;max-width:240px}@media(max-width:640px){.materials{padding:12px}.materials-actions{flex-wrap:wrap}}';document.head.append(style);
if(!origin)throw Error('PLATFORM_ORIGIN_REQUIRED');
const sandbox=createAppSandboxClient({appId:'materials',platformOrigin:origin,port:{parent:window.parent,send:(data,target)=>window.parent.postMessage(data,target),listen:listener=>{window.addEventListener('message',listener);return()=>window.removeEventListener('message',listener);}}});
const api=createAppApiClient(sandbox);
const errors={MATERIAL_CONFLICT:'物料已被其他人修改，请重新打开页面',ACCESS_DENIED:'没有此操作权限',SETTINGS_CONFLICT:'设置已变化，请重新打开页面',INVALID_INPUT:'请检查填写内容',INSUFFICIENT_STOCK:'库存不足',ALREADY_REVERSED:'该记录已修改，请重新打开页面',MATERIAL_DENIED:'无权访问物料',MOVEMENT_DENIED:'只能修改本人出库记录'};
let writing=false,uncertain=false;
function ActionIcon({kind}){const Icon={edit:PencilSimpleLine,delete:Trash,plus:Plus,in:ArrowLineDown,out:ArrowLineUp}[kind];return <Icon size={18} weight="regular"/>;}
function App(){
 useEffect(()=>{let active=true,running=false;async function sync(){if(!sandbox.ready()||running)return;running=true;try{const result=await sandbox.invoke('platform.ui.theme',{});if(active&&['light','dark'].includes(result.theme)){document.documentElement.classList.add('afc-theme-neutral');document.documentElement.dataset.theme=result.theme;}}finally{running=false;}}void sync();const timer=setInterval(()=>void sync().catch(()=>{}),1000);return()=>{active=false;clearInterval(timer);};},[]);

 const [caps,setCaps]=useState(null),[rows,setRows]=useState([]),[search,setSearch]=useState(''),[query,setQuery]=useState(''),[pages,setPages]=useState([null]),[next,setNext]=useState(null),[loading,setLoading]=useState(false),[error,setError]=useState(''),[dialog,setDialog]=useState(null),[form,setForm]=useState({}),[saving,setSaving]=useState(false);
 const [recipients,setRecipients]=useState([]),[materials,setMaterials]=useState([]),[optionsLoading,setOptionsLoading]=useState(false);
 const settings=route==='/settings',records=route==='/records',cursor=pages.at(-1);
 async function call(name,payload,write=false){
  if(write&&(writing||uncertain))throw Error('写入结果待核对，请联系管理员后再操作');
  if(write)writing=true;
  try{const reply=await api.invoke(name,payload);if(!reply.ok){if(write&&reply.error.writeOutcome==='unknown')uncertain=true;throw Error(errors[reply.error.code]??(write?'结果未确认，请联系管理员核对，勿重复提交':'读取失败，请重新打开应用'));}return reply.result;}
  catch(e){if(write&&!errors[Object.keys(errors).find(k=>errors[k]===e.message)])uncertain=true;throw e;}finally{if(write)writing=false;}
 }
 async function load(){if(!caps||settings&&!caps.leader)return;setLoading(true);setError('');try{const result=await call(settings?'members':'list',settings?(query?{search:query}:{}):{kind:records?'consumptions':'materials',pageSize:20,...(cursor?{afterId:cursor}:{}),...(query?{search:query}:{})});setRows(result.rows);setNext(result.nextCursor??null);}catch(e){setError(e.message);}finally{setLoading(false);}}
 useEffect(()=>{let cancelled=false;const deadline=Date.now()+10000,timer=setInterval(async()=>{if(sandbox.ready()){clearInterval(timer);try{const value=await call('session',{});if(cancelled)return;setCaps(value);await sandbox.invoke('platform.ui.navigation',{ids:['stock','records',...(value.leader?['settings']:[])]});}catch(e){if(!cancelled)setError(e.message);}}else if(Date.now()>deadline){clearInterval(timer);setError('应用连接未就绪，请重新打开');}},25);return()=>{cancelled=true;clearInterval(timer);};},[]);
 useEffect(()=>{if(!caps)return;void sandbox.invoke('platform.ui.modal',{open:!!dialog}).catch(()=>setError('弹窗显示状态未同步，请重新打开应用'));},[caps,!!dialog]);
 useEffect(()=>{void load();},[caps,query,cursor]);
 useEffect(()=>{const timer=setTimeout(()=>{setPages([null]);setQuery(search.trim());},300);return()=>clearTimeout(timer);},[search]);
 useEffect(()=>{
  if(!dialog||!['consume','outbound','correct'].includes(dialog.kind))return;
  let active=true;setOptionsLoading(true);
  const timer=setTimeout(async()=>{try{
   const people=await call('recipients',{});
   if(!active)return;setRecipients(people.rows);
   if(dialog.kind==='consume'){const stock=await call('list',{kind:'materials',pageSize:50});if(active)setMaterials(stock.rows);}
  }catch(e){if(active)setError(e.message);}finally{if(active)setOptionsLoading(false);}},250);
  return()=>{active=false;clearTimeout(timer);};
 },[dialog?.kind]);
 function open(kind,row){setRecipients([]);setMaterials([]);setDialog({kind,row});setForm(kind==='create'?{name:'',sku:'',unit:'个',quantity:1}:kind==='update'?{name:row.name,sku:row.sku,unit:row.unit}:kind==='correct'?{quantity:Math.abs(row.delta),receiverId:row.receiver_id??'',remark:row.remark??''}:{quantity:1,receiverId:'',remark:'',...(kind==='consume'?{materialId:''}:{})});setError('');}
 async function save(e){
  e.preventDefault();if(saving)return;setSaving(true);setError('');const requestId=crypto.randomUUID();
  try{
   const {kind,row}=dialog;let name=kind,payload={requestId,...form};
   if(kind==='delete'){name='reverse-outbound';payload={requestId,movementId:row.id,reason:'删除消耗记录，返还库存'};}
   else if(kind==='update'){payload.materialId=row.id;payload.version=row.version;}
   else {
    payload.quantity=Number(form.quantity);if(!payload.remark)delete payload.remark;
    if(kind==='consume')name='outbound';
    else if(kind==='correct'){name='correct-outbound';payload.movementId=row.id;}
    else if(kind!=='create')payload.materialId=row.id;
    if(!['consume','outbound','correct'].includes(kind))delete payload.receiverId;
   }
   await call(name,payload,true);setDialog(null);await load();
  }catch(e){setError(`${e.message}${uncertain?'（请求编号：'+requestId+'）':''}`);}finally{setSaving(false);}
 }

 async function manager(row){setSaving(true);setError('');try{await call('set-manager',{requestId:crypto.randomUUID(),personId:row.id,active:!row.manager,revision:row.revision},true);await load();}catch(e){setError(e.message);}finally{setSaving(false);}}
 const field=(key,label,type='text',required=false)=><Field key={key} label={label} htmlFor={'material-'+key}>{type==='number'?<QuantityInput id={'material-'+key} required={required} value={form[key]??''} onValueChange={value=>setForm({...form,[key]:value})}/>:<Input id={'material-'+key} value={form[key]??''} required={required} maxLength={key==='remark'?500:key==='name'?100:key==='sku'?64:100} onChange={e=>setForm({...form,[key]:e.target.value})}/>}</Field>;
 return <main className="materials"><h2>{settings?'工班物资管理员':records?'消耗记录':'库存列表'}</h2>{error&&<div role="alert" className="materials-error">{error}</div>}{settings&&!caps?.leader?<p>仅工班长可以管理物资管理员。</p>:<>
 <FilterBar className="materials-toolbar" showDateRange={false} searchValue={search} onSearchChange={setSearch} searchPlaceholder={settings?'搜索姓名或工号':records?'搜索备注':'搜索物料名称'} rightAction={<div className="materials-actions">{records&&<Button size="sm" leadingIcon={<ActionIcon kind="plus"/>} onClick={()=>open('consume')}>新增消耗</Button>}{!records&&!settings&&caps?.manageMaterials&&<Button size="sm" leadingIcon={<ActionIcon kind="plus"/>} onClick={()=>open('create')}>新建物料</Button>}</div>}/>
 <Table variant="directory" pinActions emptyState={loading?'加载中…':rows.length?null:next?'本页暂无有效记录，可继续下一页':'暂无记录'}><TableHeader><TableRow>{(settings?['姓名','工号','身份','操作']:records?['物料名称','型号','数量','领用人','时间','备注','操作']:['物料名称','型号','单位','库存','操作']).map(t=><TableHead key={t}>{t}</TableHead>)}</TableRow></TableHeader><TableBody>{rows.map(row=><TableRow key={row.id}>{settings?<><TableCell>{row.name}</TableCell><TableCell>{row.employeeNo}</TableCell><TableCell>{row.manager?'物资管理员':'工班成员'}</TableCell><TableCell><Button variant="ghost" size="sm" disabled={saving||uncertain} onClick={()=>void manager(row)}>{row.manager?'撤销':'设为管理员'}</Button></TableCell></>:records?<><TableCell>{row.material_name}</TableCell><TableCell>{row.material_sku||'—'}</TableCell><TableCell>{Math.abs(row.delta)} {row.unit}</TableCell><TableCell>{row.receiver||'—'}</TableCell><TableCell>{new Date(row.created_at).toLocaleString('zh-CN',{hour12:false})}</TableCell><TableCell className="materials-note">{row.remark||'—'}</TableCell><TableCell>{<div className="materials-actions materials-row-actions"><TableActionButton icon={<ActionIcon kind="edit"/>} disabled={!row.own&&!caps?.manageMaterials} title={row.own||caps?.manageMaterials?undefined:'仅可修改本人消耗记录'} onClick={()=>open('correct',row)}>修改</TableActionButton><TableActionButton icon={<ActionIcon kind="delete"/>} disabled={!row.own&&!caps?.manageMaterials} title={row.own||caps?.manageMaterials?undefined:'仅可删除本人消耗记录'} onClick={()=>open('delete',row)}>删除</TableActionButton></div>}</TableCell></>:<><TableCell>{row.name}</TableCell><TableCell>{row.sku||'—'}</TableCell><TableCell>{row.unit}</TableCell><TableCell>{row.quantity}</TableCell><TableCell><div className="materials-actions materials-row-actions">{caps?.manageMaterials&&<TableActionButton icon={<ActionIcon kind="in"/>} onClick={()=>open('inbound',row)}>入库</TableActionButton>}<TableActionButton icon={<ActionIcon kind="out"/>} disabled={!row.quantity} onClick={()=>open('outbound',row)}>出库</TableActionButton>{caps?.manageMaterials&&<TableActionButton icon={<ActionIcon kind="edit"/>} onClick={()=>open('update',row)}>修改</TableActionButton>}</div></TableCell></>}</TableRow>)}</TableBody></Table>
 {!settings&&<div className="materials-pagination"><span className="materials-muted">第 {pages.length} 页</span><Button variant="secondary" size="sm" disabled={loading||pages.length===1} onClick={()=>setPages(pages.slice(0,-1))}>上一页</Button><Button variant="secondary" size="sm" disabled={loading||!next} onClick={()=>setPages([...pages,next])}>下一页</Button></div>}</>}
 <Dialog open={!!dialog} onClose={()=>{if(!saving)setDialog(null);}} title={dialog?.kind==='delete'?'删除消耗':dialog?.kind==='consume'?'新增消耗':dialog?.kind==='update'?'修改物料':dialog?.kind==='create'?'新建物料':dialog?.kind==='correct'?'修改记录':dialog?.kind==='inbound'?'入库':'出库'} size="md" footer={<><Button variant="secondary" disabled={saving} onClick={()=>setDialog(null)}>取消</Button><Button onClick={e=>{if(document.getElementById("material-form").reportValidity())void save(e);}} variant={dialog?.kind==='delete'?'danger':'primary'} disabled={saving||uncertain||optionsLoading}>{saving?'处理中…':dialog?.kind==='delete'?'删除并返还':'保存'}</Button></>}><form id="material-form" className="materials-form" onSubmit={save}>{error&&<div role="alert" className="materials-error">{error}</div>}{dialog?.kind==='delete'?<p>删除这条「{dialog.row.material_name}」消耗记录，并返还 {Math.abs(dialog.row.delta)} {dialog.row.unit}？</p>:['create','update'].includes(dialog?.kind)?<>{field('name','物料名称','text',true)}{field('sku','型号','text',true)}{field('unit','单位','text',true)}{dialog?.kind==='create'&&field('quantity','入库数量','number',true)}</>:<>{dialog?.kind==='consume'?<Field label="物料" htmlFor="consume-material"><Select id="consume-material" required value={form.materialId??''} onChange={e=>setForm({...form,materialId:e.target.value})}><option value="">请选择物料</option>{materials.map(item=><option key={item.id} value={item.id} disabled={!item.quantity}>{item.name} · {item.sku}（库存 {item.quantity} {item.unit}）</option>)}</Select></Field>:<p>{dialog?.row?.name??dialog?.row?.material_name}</p>}{field('quantity','数量','number',true)}{['consume','outbound','correct'].includes(dialog?.kind)&&<Field label="领用人" htmlFor="consume-recipient"><Select id="consume-recipient" required value={form.receiverId??''} onChange={e=>setForm({...form,receiverId:e.target.value})}><option value="">请选择本班组人员</option>{recipients.map(person=><option key={person.id} value={person.id}>{person.name}（{person.employeeNo}）</option>)}</Select>{dialog?.kind==='correct'&&!dialog.row.receiver_id&&dialog.row.receiver&&<span className="materials-muted">原领用人：{dialog.row.receiver}，请重新选择</span>}</Field>}{field('remark','备注')}</>}</form></Dialog>
 </main>;
}
createRoot(document.getElementById('app')).render(<App/>);
window.addEventListener('pagehide',()=>sandbox.close(),{once:true});
