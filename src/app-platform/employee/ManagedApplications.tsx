import {SubmitApplication,AppSubmissions} from '../submissions/AppSubmissions';
import React,{useState} from 'react';
import {Users,Gear,UploadSimple,Plus} from '@phosphor-icons/react';
import {Button,QueryList,TableHeader,TableBody,TableRow,TableHead,TableCell,TableActions,TableActionButton} from '../../components/ui';
import {BusinessAuthorization} from './BusinessAuthorization';
export type ManagedApplication={appId:string;name:string;version?:string;enabled?:boolean};
export function ManagedApplications({applications}:{applications:ManagedApplication[]}){
 const [upload,setUpload]=useState<string|null>(null),[requests,setRequests]=useState(false);
 const [search,setSearch]=useState(''),[notice,setNotice]=useState('');
 const [selected,setSelected]=useState<{app:ManagedApplication;section:'people'|'roles'}|null>(null);
 const filtered=applications.filter(app=>`${app.name} ${app.appId}`.toLowerCase().includes(search.toLowerCase()));
 return <><div className="admin-heading"><h1>应用管理</h1></div>
 {notice&&<p role="status">{notice}</p>}<QueryList query={{showDateRange:false,searchValue:search,onSearchChange:setSearch,searchPlaceholder:'搜索应用名称'}} actions={<div className="app-toolbar-actions"><Button variant="secondary" size="sm" onClick={()=>setRequests(true)}>我的申请</Button><Button size="sm" leadingIcon={<Plus size={18}/>} onClick={()=>setUpload('')}>申请上架</Button></div>} emptyState={!filtered.length?'暂无负责的应用':undefined}>
 <TableHeader><TableRow><TableHead>应用</TableHead><TableHead>版本</TableHead><TableHead>启用状态</TableHead><TableHead>操作</TableHead></TableRow></TableHeader>
 <TableBody>{filtered.map(app=><TableRow key={app.appId}><TableCell><div className="app-name-cell"><strong>{app.name}</strong><span className="afc-muted">{app.appId}</span></div></TableCell><TableCell>{app.version??'—'}</TableCell><TableCell><span className="admin-status">{app.enabled===undefined?'待读取':app.enabled?'已启用':'已停用'}</span></TableCell><TableCell><TableActions><TableActionButton icon={<Users size={18}/>} onClick={()=>{setNotice('');setSelected({app,section:'people'});}}>人员管理</TableActionButton><TableActionButton icon={<Gear size={18}/>} onClick={()=>{setNotice('');setSelected({app,section:'roles'});}}>角色配置</TableActionButton><TableActionButton icon={<UploadSimple size={18}/>} onClick={()=>setUpload(app.appId)}>更新</TableActionButton></TableActions></TableCell></TableRow>)}</TableBody>
 </QueryList>{upload!==null&&<SubmitApplication appId={upload||undefined} onClose={()=>setUpload(null)} onDone={()=>{setUpload(null);setRequests(true)}}/>}{requests&&<AppSubmissions onClose={()=>setRequests(false)}/>} {selected&&<BusinessAuthorization key={selected.app.appId} appId={selected.app.appId} name={selected.app.name} initialSection={selected.section} onSaved={setNotice} onClose={()=>setSelected(null)}/>}</>;
}
