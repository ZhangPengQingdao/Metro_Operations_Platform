import React,{useId,useState} from 'react';
import {smoothDashboardPath,dashboardTone} from './dashboard-layout';
import type {AppDashboardSnapshot} from '@metro/platform-sdk/app-dashboard';

type Series=NonNullable<AppDashboardSnapshot['series']>;
const dayLabel=(date:string)=>date.slice(5).replace('-','/');

export function DailyChart({series}:{series:Series}){
 const gradient=useId(),[hover,setHover]=useState<number|null>(null);
 const points=series.points;
 if(series.kind==='heatmap'){
  const max=Math.max(1,...points.map(point=>point.value));
  const leading=(new Date(`${points[0].date}T00:00:00Z`).getUTCDay()+6)%7;
  const active=hover===null?null:points[hover];
  return <div className="dashboard-heatmap">
   <div className="dashboard-heatmap-period"><span>{points[0].date.replaceAll('-','/')} — {dayLabel(points[points.length-1].date)}</span><small>{series.unit} / 日</small></div>
   <div className="dashboard-heatmap-weekdays" aria-hidden="true">{['一','二','三','四','五','六','日'].map(day=><span key={day}>{day}</span>)}</div>
   <div className="dashboard-heatmap-grid">
    {Array.from({length:leading},(_,i)=><i key={`empty-${i}`} aria-hidden="true"/>)}
    {points.map((point,index)=><div key={point.date} tabIndex={0} className={`heat-level-${point.value===0?0:Math.ceil(point.value/max*4)}`} onMouseEnter={()=>setHover(index)} onMouseLeave={()=>setHover(null)} onFocus={()=>setHover(index)} onBlur={()=>setHover(null)} aria-label={`${point.date}：${point.value}${series.unit}`} title={`${point.date} · ${point.value}${series.unit}`}><span>{Number(point.date.slice(-2))===1?`${Number(point.date.slice(5,7))}月1日`:Number(point.date.slice(-2))}</span></div>)}
   </div>
   <div className="dashboard-heatmap-footer"><span className="dashboard-heatmap-readout" aria-live="polite">{active?`${dayLabel(active.date)} · ${active.value} ${series.unit}`:`近 ${points.length} 日新增`}</span><div className="dashboard-chart-caption dashboard-heatmap-scale"><span>少</span>{[0,1,2,3,4].map(level=><i key={level} className={`heat-level-${level}`}/>)}<span>多</span></div></div>
  </div>;
 }
 const current=points.slice(-7),previous=points.slice(-14,-7);
 const max=Math.max(2,Math.ceil(Math.max(...points.map(point=>point.value))/2)*2);
 const x=(index:number)=>44+index*480/Math.max(current.length-1,1),y=(value:number)=>178-value/max*142;
 const path=(values:typeof points)=>smoothDashboardPath(values.map((point,index)=>({x:x(index),y:y(point.value)})));
 const active=hover===null?null:current[hover];
 return <div className="dashboard-line-chart">
  <div className="dashboard-line-legend"><span><i/>近 7 日</span>{previous.length>0&&<span><i/>前 7 日</span>}<small>{series.unit} / 日</small></div>
  <svg viewBox="0 0 550 213" role="img" aria-label={`${series.label}：${current.map(p=>`${p.date} ${p.value}${series.unit}`).join('，')}`}>
   <defs><linearGradient id={gradient} x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor="var(--dashboard-accent)" stopOpacity=".28"/><stop offset="100%" stopColor="var(--dashboard-accent)" stopOpacity=".015"/></linearGradient></defs>
   {[0,.25,.5,.75,1].map(ratio=><g key={ratio}><line x1="44" x2="524" y1={y(max*ratio)} y2={y(max*ratio)} className="dashboard-grid-line"/><text x="34" y={y(max*ratio)+4} textAnchor="end">{Number((max*ratio).toFixed(1))}</text></g>)}
   {previous.length>0&&<path d={path(previous)} className="dashboard-previous-line"/>}
   <path d={`${path(current)} L${x(current.length-1)},178 L44,178 Z`} className="dashboard-line-area" style={{fill:`url(#${gradient})`}}/>
   <path d={path(current)} className="dashboard-current-line"/>
   {current.map((point,index)=><g key={point.date}><circle cx={x(index)} cy={y(point.value)} r={hover===index?6:3.5} tabIndex={0} onMouseEnter={()=>setHover(index)} onMouseLeave={()=>setHover(null)} onFocus={()=>setHover(index)} onBlur={()=>setHover(null)} aria-label={`${point.date}：${point.value}${series.unit}`}><title>{point.date} · {point.value}{series.unit}</title></circle><text x={x(index)} y="204" textAnchor="middle">{dayLabel(point.date)}</text></g>)}
   {hover!==null&&active&&<line x1={x(hover)} x2={x(hover)} y1="30" y2="178" className="dashboard-hover-line"/>}
  </svg>
  <div className="dashboard-chart-readout" aria-live="polite">{active?`${active.date} · ${active.value} ${series.unit}`:'近 7 日与前 7 日对比 · 移入数据点查看'}</div>
  <details className="dashboard-chart-values"><summary>查看每日数据</summary><table><thead><tr><th>日期</th><th>数量（{series.unit}）</th></tr></thead><tbody>{points.map(point=><tr key={point.date}><td>{point.date}</td><td>{point.value}</td></tr>)}</tbody></table></details>
 </div>;
}

export function CompletionChart({entries}:{entries:{id:string;name:string;completion:NonNullable<AppDashboardSnapshot['completion']>}[]}){
 return <div className="dashboard-rings">{entries.map(({id,name,completion})=>{
  const percent=completion.total?Math.round(completion.completed/completion.total*100):null;
  return <div className="dashboard-ring-item" data-tone={dashboardTone(id)} key={id}><div className="dashboard-ring"><svg viewBox="0 0 100 100" role="img" aria-label={`${name}：已完成 ${completion.completed}，共 ${completion.total}`}><circle cx="50" cy="50" r="40" className="dashboard-ring-track"/><circle cx="50" cy="50" r="40" pathLength="100" strokeDasharray={`${percent??0} 100`} className="dashboard-ring-value"/></svg><strong>{percent===null?'—':`${percent}%`}</strong></div><span>{name}</span><small>{completion.completed} / {completion.total}</small></div>;
 })}</div>;
}


export function Sparkline({series}:{series:Series}){
 const gradient=useId(),points=series.points.slice(-7),max=Math.max(1,...points.map(p=>p.value));
 const coordinates=points.map((point,index)=>({x:4+index*110/Math.max(points.length-1,1),y:42-point.value/max*32}));
 const path=smoothDashboardPath(coordinates);
 return <svg className="dashboard-sparkline" viewBox="0 0 120 48" role="img" aria-label={`${series.label}，近 7 日：${points.map(p=>p.value).join('、')}${series.unit}`}><defs><linearGradient id={gradient} x1="0" x2="0" y1="0" y2="1"><stop stopColor="var(--dashboard-accent)" stopOpacity=".23"/><stop offset="1" stopColor="var(--dashboard-accent)" stopOpacity="0"/></linearGradient></defs><path d={`${path} L${coordinates[coordinates.length-1].x},46 L4,46 Z`} fill={`url(#${gradient})`}/><path d={path} fill="none" stroke="var(--dashboard-accent)" strokeWidth="2.5" strokeLinecap="round"/><circle cx={coordinates[coordinates.length-1].x} cy={coordinates[coordinates.length-1].y} r="3" fill="var(--dashboard-accent)"/></svg>;
}
