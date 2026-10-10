import React,{useState} from 'react';
import type {DashboardLayout} from '@metro/platform-sdk/app-dashboard';
import {Button,Checkbox,Dialog,IconButton} from '../../components/ui';
import {defaultDashboardLayout,moveDashboardItem,type LayoutOptions} from './dashboard-layout';

export function DashboardCustomization({layout,options,onSave,onClose}:{layout:DashboardLayout;options:LayoutOptions;onSave:(layout:DashboardLayout)=>Promise<void>;onClose:()=>void}){
 const [draft,setDraft]=useState(layout),[tab,setTab]=useState<'cards'|'charts'|'shortcuts'>('cards'),[saving,setSaving]=useState(false),[error,setError]=useState('');
 const tabs=[['cards','顶部卡片',4],['charts','图表',16],['shortcuts','快捷入口',24]] as const;
 const limit=tabs.find(item=>item[0]===tab)![2],selected=draft[tab];
 const ordered=[...selected.flatMap(id=>options[tab].filter(o=>o.id===id)),...options[tab].filter(o=>!selected.includes(o.id))];
 const save=async()=>{setSaving(true);setError('');try{await onSave(draft);onClose();}catch(e){setError(e instanceof Error?e.message:'保存未确认，请重新打开配置核对。');}finally{setSaving(false);}};
 return <Dialog open onClose={()=>{if(!saving)onClose();}} title="首页设置" description="选择你关心的内容，按自己的工作习惯排列。配置仅影响你的首页。" size="md" className="dashboard-custom-dialog" footer={<><Button variant="ghost" disabled={saving} onClick={()=>setDraft(defaultDashboardLayout(options))}>恢复默认</Button><span className="dashboard-footer-spacer"/><Button variant="secondary" disabled={saving} onClick={onClose}>取消</Button><Button disabled={saving} onClick={()=>void save()}>{saving?'保存中…':'保存布局'}</Button></>}>
  <div className="dashboard-config-tabs" role="tablist" aria-label="首页配置区域">{tabs.map(([key,title])=><button type="button" role="tab" aria-selected={tab===key} aria-controls="dashboard-config-panel" key={key} onClick={()=>setTab(key)} disabled={saving}>{title}<span>{draft[key].length}</span></button>)}</div>
  <div id="dashboard-config-panel" role="tabpanel" aria-label={tabs.find(t=>t[0]===tab)![1]}><p className="dashboard-config-hint">{tab==='cards'?'最多展示 4 张卡片':'勾选需要展示的内容'} · 使用箭头调整顺序</p>
   <div className="dashboard-config-list">{ordered.map(option=>{const index=selected.indexOf(option.id),checked=index!==-1;return <div className={`dashboard-config-option${checked?' is-selected':''}`} key={option.id}>
    <Checkbox label={option.label} description={option.detail} checked={checked} disabled={saving||(!checked&&selected.length>=limit)} onChange={()=>setDraft(old=>({...old,[tab]:checked?old[tab].filter(id=>id!==option.id):[...old[tab],option.id]}))}/>
    {checked&&<div className="dashboard-config-order"><small>{index+1}</small><IconButton label={`上移${option.label}`} disabled={saving||index===0} onClick={()=>setDraft(old=>({...old,[tab]:moveDashboardItem(old[tab],option.id,-1)}))}>↑</IconButton><IconButton label={`下移${option.label}`} disabled={saving||index===selected.length-1} onClick={()=>setDraft(old=>({...old,[tab]:moveDashboardItem(old[tab],option.id,1)}))}>↓</IconButton></div>}
   </div>;})}{!ordered.length&&<p className="afc-muted">暂无可选内容，应用提供摘要后可在这里配置。</p>}</div>
  </div>{error&&<p role="alert" className="afc-error">{error}</p>}
 </Dialog>;
}
