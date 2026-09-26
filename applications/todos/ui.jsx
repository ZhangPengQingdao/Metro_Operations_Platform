import React,{useEffect,useMemo,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {Button,Input,Checkbox,DropdownSelect,TagDropdownPicker,Field,Dialog,DatePicker,TimePicker,FilterBar,DataList,ListPagination,TableActions,TableHeader,TableBody,TableRow,TableHead,TableCell,TableActionButton,Plus,PencilSimpleLine,Trash,Play,Pause,ArrowsClockwise,Eye} from '@metro/platform-sdk/ui';
import {platformUiCss} from '@metro/platform-sdk/ui-styles';
import {createAppSandboxClient,createAppApiClient} from '@metro/platform-sdk/app-sandbox';

const script=document.currentScript,origin=script?.dataset.platformOrigin;
if(!origin)throw Error('PLATFORM_ORIGIN_REQUIRED');
const sandbox=createAppSandboxClient({appId:'todos',timeoutMs:30_000,platformOrigin:origin,port:{parent:window.parent,send:(data,target)=>window.parent.postMessage(data,target),listen:fn=>{window.addEventListener('message',fn);return()=>window.removeEventListener('message',fn);}}});
const api=createAppApiClient(sandbox);
document.documentElement.classList.add('afc-theme-neutral');
const style=document.createElement('style');style.nonce=script?.nonce??'';
style.textContent=platformUiCss+`
body{margin:0;background:#fafafa;color:#18181b;font:14px system-ui,-apple-system,"Segoe UI",sans-serif}*{box-sizing:border-box}
.todos{max-width:1100px;margin:auto;padding:24px 20px 72px}.head{border-bottom:1px solid #e4e4e7;padding-bottom:18px;margin-bottom:20px}.head h1{font-size:21px;margin:0}.muted{color:#71717a;font-size:12px}.head p{margin:5px 0 0}.actions,.row-actions{display:flex;align-items:center;gap:9px;flex-wrap:wrap}.form select,.form input[type=number],.form textarea{border:1px solid #d4d4d8;background:white;color:#18181b;border-radius:8px;padding:8px;font:inherit;min-height:36px}.form textarea{width:100%;min-height:78px;resize:vertical}.meta{display:flex;gap:12px;flex-wrap:wrap;color:#71717a;font-size:12px}.badge{display:inline-block;background:#f4f4f5;border:1px solid #e4e4e7;border-radius:20px;padding:3px 9px;font-size:12px}.badge.done{background:#f0fdf4;border-color:#bbf7d0;color:#166534}.badge.late{background:#fef2f2;border-color:#fecaca;color:#991b1b}.notice{padding:11px 14px;margin-bottom:14px;border-radius:8px;background:#fef2f2;border:1px solid #fecaca;color:#991b1b}.item{border-top:1px solid #f4f4f5;padding:13px 0;display:flex;align-items:center;justify-content:space-between;gap:12px}.item:first-child{margin-top:0}.item strong{display:block;font-size:13px}.item small{color:#71717a}.form{display:grid;gap:15px}.formgrid{display:grid;grid-template-columns:1fr 1fr;gap:13px}.form .field>label,.fieldlabel{display:block;font-size:12px;font-weight:600;margin-bottom:5px}.form .field{min-width:0}.form .field>*:not(label){width:100%}.dialogbody{width:100%;padding:4px}.dialogactions{display:flex;justify-content:flex-end;gap:8px;margin-top:15px}.tiny{font-size:12px}.link{border:0;background:none;color:#18181b;text-decoration:underline;cursor:pointer;padding:4px}.todos-title{font-weight:600}.todos-description{margin-top:4px;white-space:pre-wrap;max-width:260px}.todos-row{cursor:pointer}.todos-row:hover{background:#fafafa}.detail-item{border-top:1px solid #e4e4e7;padding:15px 0}.detail-item:first-child{border-top:0}.detail-fields{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:10px}.detail-item .actions{justify-content:flex-end;margin-top:10px}.todos .afc-data-list__toolbar{margin-bottom:12px}@media(max-width:640px){.todos{padding:16px 12px 60px}.formgrid,.detail-fields{grid-template-columns:1fr}.item{align-items:flex-start;flex-direction:column}}
`;
document.head.append(style);
const ERR={INVALID_INPUT:'请检查填写内容和周期截止时间',INVALID_TARGET:'目标人员或车站已失效，请重新选择',ACCESS_DENIED:'没有此操作权限或数据范围',CONFLICT:'内容已被他人更新，请刷新后重试',INACTIVE_TEMPLATE:'模板已停用',PAYLOAD_LIMIT:'任务内容过长或目标过多，请精简后提交',READ_FAILED:'读取失败，请重试',OPERATION_UNCONFIRMED:'操作结果未确认，请先刷新核对，勿重复提交'};
const fresh=()=>crypto.randomUUID();
const localInput=iso=>iso?new Date(iso).toLocaleString('sv-SE',{timeZone:'Asia/Shanghai'}).replace(' ','T').slice(0,16):'';
const toIso=local=>local?new Date(local+'+08:00').toISOString():null;
const dateText=value=>value?new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):'未设置';
const has=(session,action,org)=>!!session?.grants?.some(grant=>grant.permission===`app.todos.${action}`&&(grant.all||grant.organizationIds.includes(org)||['read','handle','manage'].includes(action)&&grant.self&&org===session.organizationUnitId));
async function call(id,payload){try{const response=await api.invoke(id,payload);if(!response?.ok){const error=Error(ERR[response?.error?.code]??'操作失败');error.unknown=response?.error?.writeOutcome==='unknown';throw error;}return response.result;}catch(error){if(error.writeOutcome==='unknown'){const failure=Error(ERR.OPERATION_UNCONFIRMED);failure.unknown=true;throw failure;}throw error;}}

function TargetPicker({kind,organizationId,selectedIds,onChange,initialItems=[],onError}){
 const [visible,setVisible]=useState([]),[known,setKnown]=useState(initialItems),[next,setNext]=useState(null),[busy,setBusy]=useState(false),[search,setSearch]=useState('');
 useEffect(()=>{let active=true;setVisible([]);setNext(null);if(!organizationId)return;const timer=setTimeout(()=>{setBusy(true);call('directory',{kind,organizationId,...(search.trim()?{search:search.trim()}:{})}).then(page=>{if(active){setVisible(page.rows);setKnown(current=>[...new Map([...current,...page.rows].map(item=>[item.id,item])).values()]);setNext(page.nextCursor??null);}}).catch(error=>{if(active)onError(error);}).finally(()=>{if(active)setBusy(false);});},search?200:0);return()=>{active=false;clearTimeout(timer);};},[kind,organizationId,search]);
 async function load(after){setBusy(true);try{const page=await call('directory',{kind,organizationId,afterId:after,...(search.trim()?{search:search.trim()}:{})});setVisible(current=>[...current,...page.rows]);setKnown(current=>[...new Map([...current,...page.rows].map(item=>[item.id,item])).values()]);setNext(page.nextCursor??null);}catch(error){onError(error);}finally{setBusy(false);}}
 const noun=kind==='person'?'人员':'车站';
 const options=[...new Map([...known.filter(item=>selectedIds.includes(item.id)),...visible].map(item=>[item.id,item])).values()];
 return <div className="field">
  <Input aria-label={`搜索${noun}`} value={search} onChange={event=>setSearch(event.target.value.slice(0,100))} placeholder={`搜索${noun}`} />
  <TagDropdownPicker key={`${kind}:${organizationId}`} inline title={noun} showTagsBelow={false} emptyText={busy?'正在加载…':`暂无可选${noun}`} items={options.map(item=>({id:item.id,label:item.name,badge:kind==='person'?item.employeeNo:undefined}))} selectedIds={selectedIds} onChange={onChange} multiple />
  {next&&<button className="link" type="button" disabled={busy} onClick={()=>load(next)}>加载更多{noun}</button>}
 </div>;
}

function TaskForm({session,initial,onClose,onSaved,onError}){
 const organizations=(session.organizations??[]).filter(o=>has(session,'create',o.id)),defaultOrg=initial?.organization_id??organizations[0]?.id??'';
 const localDue=localInput(initial?.due_at);
 const [org,setOrg]=useState(defaultOrg),[title,setTitle]=useState(initial?.title??''),[description,setDescription]=useState(initial?.description??''),[scope,setScope]=useState(initial?.scope_type??'station'),[dueDate,setDueDate]=useState(localDue.slice(0,10)),[dueTime,setDueTime]=useState(localDue.slice(11,16)||'18:00'),[scored,setScored]=useState(initial?.is_scored??false),[score,setScore]=useState(initial?.score_value??0),[selected,setSelected]=useState(initial?.items?.map(x=>x.target_id)??[]),[busy,setBusy]=useState(false),[uncertain,setUncertain]=useState(false),[formError,setFormError]=useState('');
 const canScore=has(session,'score',org);
 async function submit(){if(busy||uncertain)return;setBusy(true);setFormError('');
  try{const dueAt=dueDate?toIso(`${dueDate}T${dueTime}`):null;
   if(initial)await call('update-task',{requestId:fresh(),taskId:initial.id,revision:initial.revision,title,description,dueAt,isScored:scored,scoreValue:Number(score)});
   else await call('create-task',{requestId:fresh(),organizationId:org,title,description,scopeType:scope,targetIds:selected,dueAt,isScored:scored,scoreValue:Number(score)});
   onSaved();onClose();}
  catch(error){if(error.unknown)setUncertain(true);setFormError(error.message);onError(error);}finally{setBusy(false);}
 }
 return <Dialog open onClose={onClose} title={initial?'编辑任务':'发布普通任务'} size="lg"><div className="dialogbody"><div className="form">
  {!initial&&<div className="formgrid"><div className="field"><label>工班</label><DropdownSelect value={org} onChange={value=>{setOrg(value);setSelected([]);}} options={organizations.map(o=>({value:o.id,label:o.name}))}/></div><div className="field"><label>分配方式</label><DropdownSelect value={scope} onChange={value=>{setScope(value);setSelected([]);}} options={[{value:'station',label:'按车站'},{value:'person',label:'按人员'}]}/></div></div>}
  {!initial&&<TargetPicker kind={scope} organizationId={org} selectedIds={selected} onChange={ids=>{setSelected(ids);setFormError('');}} onError={error=>setFormError(error.message)}/>}
  <Field label="任务标题" htmlFor="todo-task-title"><Input id="todo-task-title" value={title} onChange={e=>setTitle(e.target.value)} maxLength={200} required /></Field>
  <div className="field"><label>任务说明</label><textarea value={description} onChange={e=>setDescription(e.target.value)} maxLength={2000}/></div>
  <div className="formgrid"><div className="field"><label>截止日期</label><DatePicker value={dueDate} onChange={setDueDate} placeholder="不设置截止日期"/></div><div className="field"><label>截止时间</label><TimePicker value={dueTime} onChange={setDueTime} minuteStep={1} clearable={false}/></div></div>
  <div className="field">{canScore?<div className="actions"><Checkbox label="计分任务" checked={scored} onChange={e=>setScored(e.target.checked)}/>{scored&&<Input aria-label="分值" type="number" min="0" max="10000" value={score} onChange={e=>setScore(e.target.value)}/>}</div>:<span className="muted">普通任务不计分</span>}</div>

  {formError&&<div className="notice" role="alert">{formError}</div>}
  {uncertain&&<div className="notice">提交结果未确认。请关闭窗口并刷新列表核对。</div>}
  <div className="dialogactions"><Button type="button" onClick={onClose}>取消</Button><Button type="button" onClick={()=>void submit()} disabled={busy||uncertain||!title.trim()||!org||!initial&&!selected.length}>{busy?'提交中…':'保存'}</Button></div>
 </div></div></Dialog>;
}

function TemplateForm({session,initial,onClose,onSaved,onError}){
 const organizations=(session.organizations??[]).filter(o=>has(session,'recurring',o.id)),[org,setOrg]=useState(initial?.organization_id??organizations[0]?.id??''),[title,setTitle]=useState(initial?.title??''),[description,setDescription]=useState(initial?.description??''),[scope,setScope]=useState(initial?.scope_type??'station'),[selected,setSelected]=useState(initial?.targets?.map(x=>x.id)??[]),[type,setType]=useState(initial?.recurrence_type??'daily'),[day,setDay]=useState(initial?.recurrence_value??1),[dueDay,setDueDay]=useState(initial?.due_value??1),[time,setTime]=useState(initial?minutesTime(initial.trigger_minutes):'09:00'),[dueTime,setDueTime]=useState(initial?minutesTime(initial.due_minutes):'18:00'),[scored,setScored]=useState(initial?.is_scored??false),[score,setScore]=useState(initial?.score_value??0),[active,setActive]=useState(initial?.active??true),[busy,setBusy]=useState(false),[uncertain,setUncertain]=useState(false),[formError,setFormError]=useState('');
 async function submit(){if(busy||uncertain)return;setBusy(true);setFormError('');
  try{await call('save-template',{requestId:fresh(),organizationId:org,...(initial?{id:initial.id,revision:initial.revision}:{}),title,description,scopeType:scope,targetIds:selected,recurrenceType:type,recurrenceValue:type==='daily'?0:Number(day),dueValue:type==='daily'?0:Number(dueDay),triggerMinutes:timeMinutes(time),dueMinutes:timeMinutes(dueTime),isScored:scored,scoreValue:Number(score),active});onSaved();onClose();}
  catch(error){if(error.unknown)setUncertain(true);setFormError(error.message);onError(error);}finally{setBusy(false);}
 }
 return <Dialog open onClose={onClose} title={initial?'编辑周期模板':'新建周期模板'} size="lg"><div className="dialogbody"><div className="form">
  <div className="formgrid"><div className="field"><label>工班</label><DropdownSelect value={org} disabled={!!initial} onChange={value=>{setOrg(value);setSelected([]);}} options={organizations.map(o=>({value:o.id,label:o.name}))}/></div><div className="field"><label>分配方式</label><DropdownSelect value={scope} onChange={value=>{setScope(value);setSelected([]);}} options={[{value:'station',label:'按车站'},{value:'person',label:'按人员'}]}/></div></div>
  <TargetPicker kind={scope} organizationId={org} selectedIds={selected} onChange={ids=>{setSelected(ids);setFormError('');}} initialItems={initial?.targets??[]} onError={error=>setFormError(error.message)}/>
  <Field label="任务标题" htmlFor="todo-template-title"><Input id="todo-template-title" value={title} onChange={e=>setTitle(e.target.value)} maxLength={200} required/></Field><div className="field"><label>任务说明</label><textarea value={description} onChange={e=>setDescription(e.target.value)} maxLength={2000}/></div>
  <div className="formgrid"><div className="field"><label>周期</label><DropdownSelect value={type} onChange={value=>{setType(value);setDay(1);setDueDay(1);}} options={[{value:'daily',label:'每天'},{value:'weekly',label:'每周'},{value:'monthly',label:'每月'}]}/></div>{type!=='daily'&&<div className="field"><label>{type==='weekly'?'生成星期':'生成日期'}</label><DropdownSelect value={String(day)} onChange={setDay} options={Array.from({length:type==='weekly'?7:31},(_,i)=>({value:String(i+1),label:type==='weekly'?['周一','周二','周三','周四','周五','周六','周日'][i]:`${i+1} 日`}))}/></div>}</div>
  <div className="formgrid"><div className="field"><label>生成时间</label><TimePicker value={time} onChange={setTime} minuteStep={1} clearable={false}/></div><div className="field"><label>截止时间</label><TimePicker value={dueTime} onChange={setDueTime} minuteStep={1} clearable={false}/></div></div>
  {type!=='daily'&&<div className="field"><label>{type==='weekly'?'截止星期':'截止日期'}</label><DropdownSelect value={String(dueDay)} onChange={setDueDay} options={Array.from({length:type==='weekly'?7:31},(_,i)=>({value:String(i+1),label:type==='weekly'?['周一','周二','周三','周四','周五','周六','周日'][i]:`${i+1} 日`}))}/><span className="muted">截止日不得早于生成日；较短月份按月末截止。</span></div>}

  <div className="formgrid"><Checkbox label="启用模板" checked={active} onChange={e=>setActive(e.target.checked)}/><div>{has(session,'score',org)?<><Checkbox label="计分" checked={scored} onChange={e=>setScored(e.target.checked)}/>{scored&&<Input aria-label="分值" type="number" min="0" max="10000" value={score} onChange={e=>setScore(e.target.value)}/>}</>:<span className="muted">普通任务不计分</span>}</div></div>
  {formError&&<div className="notice" role="alert">{formError}</div>}
  {uncertain&&<div className="notice">提交结果未确认。请关闭窗口并刷新列表核对。</div>}
  <div className="dialogactions"><Button type="button" onClick={onClose}>取消</Button><Button type="button" onClick={()=>void submit()} disabled={busy||uncertain||!org||!title.trim()||!selected.length}>{busy?'提交中…':'保存'}</Button></div>
 </div></div></Dialog>;
}
function TaskDetailDialog({task,busy,uncertain,message,onClose,onSave,onError}){
 const [people,setPeople]=useState([]),[drafts,setDrafts]=useState({});
 useEffect(()=>{setDrafts({});setPeople([]);if(!task||task.scope_type!=='station'||!task.items.some(item=>item.can_handle))return;let active=true;call('directory',{kind:'person',organizationId:task.organization_id}).then(page=>{if(active)setPeople(page.rows);}).catch(error=>{if(active)onError(error);});return()=>{active=false;};},[task?.id,task?.organization_id]);
 const draft=(item)=>drafts[item.id]??{handlerId:item.handler_id??'',remarks:item.remarks??''};
 const change=(item,field,value)=>setDrafts(current=>({...current,[item.id]:{...(current[item.id]??{handlerId:item.handler_id??'',remarks:item.remarks??''}),[field]:value}}));
 return <Dialog open onClose={onClose} title={task?.title??'待办详情'} size="lg"><div className="dialogbody">
  {message&&<div className="notice" role="alert">{message}</div>}
  {!task?<p className="muted">正在加载子项…</p>:<><div className="meta"><span>{task.scope_type==='station'?'按车站':'按人员'}</span><span>{task.completed_items}/{task.total_items} 已完成</span><span>截止 {dateText(task.due_at)}</span></div>{task.description&&<p>{task.description}</p>}
   {task.items.map(item=>{const value=draft(item),changed=task.scope_type==='station'&&(value.handlerId||null)!==(item.handler_id??null)||value.remarks.trim()!==(item.remarks??'');return <section className="detail-item" key={item.id}><div className="actions"><strong>{item.target_name}</strong><span className={`badge ${item.status==='completed'?'done':''}`}>{item.status==='completed'?'已完成':'待办理'}</span></div>
    {item.can_handle?<><div className="detail-fields">{task.scope_type==='station'&&<div className="field"><label htmlFor={`handler-${item.id}`}>完成人</label><DropdownSelect id={`handler-${item.id}`} value={value.handlerId} onChange={selected=>change(item,'handlerId',selected)} options={[{value:'',label:'未指定'},...(item.handler_id&&!people.some(person=>person.id===item.handler_id)?[{value:item.handler_id,label:item.handler_name??'原完成人'}]:[]),...people.map(person=>({value:person.id,label:person.name}))]}/></div>}<div className="field"><label htmlFor={`remarks-${item.id}`}>办理备注</label><Input id={`remarks-${item.id}`} maxLength={100} value={value.remarks} onChange={event=>change(item,'remarks',event.target.value)} placeholder="可填写办理情况"/></div></div><div className="actions">{changed&&<Button type="button" size="sm" variant="secondary" disabled={busy||uncertain} onClick={()=>onSave(item,{completed:item.status==='completed',remarks:value.remarks,...(task.scope_type==='station'?{handlerId:value.handlerId||null}:{})})}>保存变更</Button>}<Button type="button" size="sm" disabled={busy||uncertain} onClick={()=>onSave(item,{completed:item.status!=='completed',remarks:value.remarks,...(task.scope_type==='station'?{handlerId:value.handlerId||null}:{})})}>{item.status==='completed'?'撤销完成':'标记完成'}</Button></div></>:<p className="muted">{item.handler_name&&`完成人：${item.handler_name} · `}{item.remarks||'暂无备注'}{item.completed_at&&` · 完成于 ${dateText(item.completed_at)}`}</p>}
   </section>;})}</>}
 </div></Dialog>;
}

const timeMinutes=value=>{const [h,m]=value.split(':').map(Number);return h*60+m;};
const minutesTime=value=>`${String(Math.floor(value/60)).padStart(2,'0')}:${String(value%60).padStart(2,'0')}`;
const scheduleText=row=>`${row.recurrence_type==='daily'?'每天':row.recurrence_type==='weekly'?`每周${'一二三四五六日'[row.recurrence_value-1]}`:`每月 ${row.recurrence_value} 日`} ${minutesTime(row.trigger_minutes)} 生成`;

function App(){
 const [route,setRoute]=useState(decodeURIComponent(script?.dataset.appRoute??'/'));
 const [session,setSession]=useState(null),[rows,setRows]=useState([]),[after,setAfter]=useState(null),[history,setHistory]=useState([]),[next,setNext]=useState(null);
 const [org,setOrg]=useState(''),[status,setStatus]=useState(''),[search,setSearch]=useState(''),[detail,setDetail]=useState(null),[dialog,setDialog]=useState(null);
 const [message,setMessage]=useState(''),[loading,setLoading]=useState(false),[busy,setBusy]=useState(false),[uncertain,setUncertain]=useState(false);
 const requestSequence=useRef(0),recurring=route==='/recurring';
 useEffect(()=>sandbox.onRouteChange(path=>{setRoute(path);setRows([]);setAfter(null);setHistory([]);setNext(null);setDetail(null);setDialog(null);setMessage('');setSearch('');}),[]);
 useEffect(()=>{let cancelled=false;const deadline=Date.now()+10000,timer=setInterval(async()=>{if(sandbox.ready()){clearInterval(timer);try{const data=await call('session',{});if(cancelled)return;setSession(data);const ids=['tasks',...(data.grants?.some(grant=>grant.permission==='app.todos.recurring')?['recurring']:[])];await sandbox.invoke('platform.ui.navigation',{ids}).catch(()=>{});}catch(error){if(!cancelled)setMessage(error.message);}}else if(Date.now()>deadline){clearInterval(timer);if(!cancelled)setMessage('应用连接未就绪，请重新打开');}},25);return()=>{cancelled=true;clearInterval(timer);};},[]);
 useEffect(()=>{if(session&&org&&!has(session,recurring?'recurring':'read',org))setOrg('');},[session,route,org]);
 useEffect(()=>{if(!session||!sandbox.ready())return;void sandbox.invoke('platform.ui.modal',{open:!!dialog}).catch(()=>{});},[session,!!dialog]);
 async function refresh(cursor=null,kind=recurring?'templates':'tasks',organization=org,filter=status,query=search){
  if(!session)return;
  const sequence=++requestSequence.current;setLoading(true);setMessage('');
  try{
   const page=await call('list',{kind,...(organization?{organizationId:organization}:{}),...(cursor?{after:cursor}:{}),...(kind==='tasks'&&filter?{status:filter}:{}),...(query.trim()?{search:query.trim()}:{})});
   if(sequence!==requestSequence.current)return;
   setRows(page.rows);setAfter(cursor);setNext(page.nextCursor??null);
   if(detail&&kind==='tasks'){
    const updated=await call('detail',{taskId:detail.id}).catch(()=>null);
    if(sequence===requestSequence.current)setDetail(updated);
   }
  }catch(error){if(sequence===requestSequence.current)setMessage(error.message);}
  finally{if(sequence===requestSequence.current)setLoading(false);}
 }
 useEffect(()=>{if(!session)return;requestSequence.current++;setRows([]);setAfter(null);setHistory([]);setNext(null);setDetail(null);const timer=setTimeout(()=>void refresh(null,recurring?'templates':'tasks',org,status,search),search?250:0);return()=>{clearTimeout(timer);requestSequence.current++;};},[session,route,org,status,search]);
 const scoped=useMemo(()=>session?.organizations?.filter(o=>has(session,recurring?'recurring':'read',o.id))??[],[session,recurring]);
 const filterGroups=[...(scoped.length?[{id:'org',title:'所属工班',isMulti:false,options:scoped.map(o=>({id:o.id,label:o.name}))}]:[]),...(!recurring?[{id:'status',title:'任务状态',isMulti:false,options:[{id:'active',label:'待完成'},{id:'completed',label:'已完成'}]}]:[])];
 async function openDetail(id){setDetail(null);setDialog({type:'detail',taskId:id});try{setDetail(await call('detail',{taskId:id}));}catch(error){setMessage(error.message);}}
 async function write(id,payload,success){if(busy||uncertain)return false;setBusy(true);setMessage('');try{await call(id,{requestId:fresh(),...payload});if(success)await success();else await refresh();return true;}catch(error){if(error.unknown)setUncertain(true);setMessage(error.message);return false;}finally{setBusy(false);}}
 async function saveItem(item,changes){if(!detail)return;await write('handle-item',{taskId:detail.id,itemId:item.id,revision:detail.revision,...changes},async()=>{await refresh();});}
 const title=recurring?'周期待办':'待办事项';
 const action=recurring
  ?scoped.some(o=>has(session,'recurring',o.id))&&<Button size="sm" leadingIcon={<Plus size={16}/>} disabled={uncertain} onClick={()=>setDialog({type:'template'})}>新建模板</Button>
  :session?.organizations?.some(o=>has(session,'create',o.id))&&<Button size="sm" leadingIcon={<Plus size={16}/>} disabled={uncertain} onClick={()=>setDialog({type:'task'})}>发布任务</Button>;
 return <main className="todos">
  <header className="head"><h1>{title}</h1><p className="muted">{recurring?'按日、周、月自动生成普通待办':'按工班发布，按车站或人员逐项办理'}</p></header>
  {message&&<div className="notice" role="alert">{message}</div>}
  <DataList
   toolbar={<FilterBar showDateRange={false} searchValue={search} onSearchChange={value=>setSearch(value.slice(0,100))} searchPlaceholder={recurring?'搜索模板标题':'搜索任务标题'} filterGroups={filterGroups} activeFilters={{selectedOptions:{org:org?[org]:[],status:status?[status]:[]}}} onApplyFilters={filters=>{setOrg(filters.selectedOptions.org?.[0]??'');setStatus(filters.selectedOptions.status?.[0]??'');}} onResetFilters={()=>{setOrg('');setStatus('');}} rightAction={action}/>}
   emptyState={loading?'正在加载…':rows.length?null:next?'本页暂无有效记录，可继续下一页':recurring?'暂无周期模板':'暂无待办任务'}
   pagination={(next||history.length>0)&&<ListPagination page={history.length+1} hasNext={!!next} busy={loading} onPrevious={()=>{const previous=history.at(-1);setHistory(history.slice(0,-1));void refresh(previous);}} onNext={()=>{setHistory([...history,after]);void refresh(next);}}/>}
  >
   <TableHeader><TableRow><TableHead>{recurring?'模板':'任务'}</TableHead><TableHead>所属工班</TableHead><TableHead>分配方式</TableHead><TableHead>{recurring?'生成周期':'办理进度'}</TableHead><TableHead>截止时间 / 分值</TableHead><TableHead>状态</TableHead><TableHead>操作</TableHead></TableRow></TableHeader>
   <TableBody>{rows.map(row=><React.Fragment key={row.id}>
    <TableRow className={!recurring?"todos-row":undefined} onClick={!recurring?()=>void openDetail(row.id):undefined} onKeyDown={!recurring?event=>{if(event.target===event.currentTarget&&(event.key==='Enter'||event.key===' ')){event.preventDefault();void openDetail(row.id);}}:undefined} tabIndex={!recurring?0:undefined}>
     <TableCell><div className="todos-title">{row.title}</div>{row.description&&<div className="muted todos-description">{row.description}</div>}</TableCell>
     <TableCell>{session?.organizations?.find(o=>o.id===row.organization_id)?.name??'工班'}</TableCell>
     <TableCell>{row.scope_type==='station'?'按车站':'按人员'} · {recurring?row.targets?.length:row.total_items} 项</TableCell>
     <TableCell>{recurring?scheduleText(row):`${row.completed_items}/${row.total_items} 已完成`}</TableCell>
     <TableCell><div>{recurring?minutesTime(row.due_minutes):dateText(row.due_at)}</div>{row.is_scored&&<span className="badge">{row.score_value} 分</span>}</TableCell>
     <TableCell><span className={`badge ${!recurring&&row.status==='completed'?'done':''}`}>{recurring?row.active?'启用':'停用':row.status==='completed'?'已完成':'进行中'}</span></TableCell>
     <TableCell><TableActions>{recurring?<>
      <TableActionButton icon={<PencilSimpleLine size={16}/>} disabled={uncertain} onClick={()=>setDialog({type:'template',row})}>编辑</TableActionButton>
      <TableActionButton icon={row.active?<Pause size={16}/>:<Play size={16}/>} disabled={busy||uncertain} onClick={()=>void write('template-state',{templateId:row.id,revision:row.revision,action:'active',active:!row.active})}>{row.active?'停用':'启用'}</TableActionButton>
      <TableActionButton icon={<ArrowsClockwise size={16}/>} disabled={busy||uncertain||!row.active} onClick={()=>void write('trigger',{templateId:row.id})}>立即生成</TableActionButton>
      <TableActionButton icon={<Trash size={16}/>} disabled={busy||uncertain} onClick={()=>{if(window.confirm('确定删除该模板？已生成的任务仍保留。'))void write('template-state',{templateId:row.id,revision:row.revision,action:'delete'});}}>删除</TableActionButton>
     </>:<>
      <TableActionButton icon={<Eye size={16}/>} onClick={event=>{event.stopPropagation();void openDetail(row.id);}}>查看详情</TableActionButton>
      {row.can_manage&&<><TableActionButton icon={<PencilSimpleLine size={16}/>} disabled={uncertain} onClick={event=>{event.stopPropagation();setDialog({type:'task',row});}}>编辑</TableActionButton><TableActionButton icon={<Trash size={16}/>} disabled={busy||uncertain} onClick={event=>{event.stopPropagation();if(window.confirm('确定删除该任务？'))void write('delete-task',{taskId:row.id,revision:row.revision});}}>删除</TableActionButton></>}
     </>}</TableActions></TableCell>
    </TableRow>

   </React.Fragment>)}</TableBody>
  </DataList>
  {dialog?.type==='task'&&session&&<TaskForm session={session} initial={dialog.row} onClose={()=>setDialog(null)} onSaved={()=>refresh()} onError={error=>{if(error.unknown)setUncertain(true);setMessage(error.message);}}/>}
  {dialog?.type==='template'&&session&&<TemplateForm session={session} initial={dialog.row} onClose={()=>setDialog(null)} onSaved={()=>refresh()} onError={error=>{if(error.unknown)setUncertain(true);setMessage(error.message);}}/>}
  {dialog?.type==='detail'&&<TaskDetailDialog task={detail?.id===dialog.taskId?detail:null} busy={busy} uncertain={uncertain} message={message} onClose={()=>{setDialog(null);setDetail(null);}} onSave={saveItem} onError={error=>setMessage(error.message)}/>}

 </main>;
}
createRoot(document.getElementById('app')).render(<App/>);
