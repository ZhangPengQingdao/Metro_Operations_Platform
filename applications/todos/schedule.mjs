const ZONE='Asia/Shanghai';
const parts=new Intl.DateTimeFormat('en-CA',{timeZone:ZONE,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
export function localParts(date){
 const p=Object.fromEntries(parts.formatToParts(date).filter(x=>x.type!=='literal').map(x=>[x.type,Number(x.value)]));
 const weekday=new Date(Date.UTC(p.year,p.month-1,p.day)).getUTCDay()||7;
 return {...p,weekday,key:`${p.year}-${String(p.month).padStart(2,'0')}-${String(p.day).padStart(2,'0')}`,minutes:p.hour*60+p.minute};
}
export function dueAt(template,date){
 const p=localParts(date),{year,month,day,weekday}=p;
 let offset=0;
 if(template.recurrence_type==='daily')offset=template.due_minutes<template.trigger_minutes?1:0;
 if(template.recurrence_type==='weekly')offset=(template.due_value-weekday+7)%7|| (template.due_minutes<template.trigger_minutes?7:0);
 if(template.recurrence_type==='monthly'){
  const last=new Date(Date.UTC(year,month,0)).getUTCDate(),dueDay=Math.min(template.due_value,last);
  if(dueDay>day||dueDay===day&&template.due_minutes>=template.trigger_minutes)offset=dueDay-day;
  else {const nextDay=Math.min(template.due_value,new Date(Date.UTC(year,month+1,0)).getUTCDate());offset=Math.round((Date.UTC(year,month,nextDay)-Date.UTC(year,month-1,day))/86400000);}
 }
 const d=new Date(Date.UTC(year,month-1,day+offset,0,template.due_minutes-480));
 return d.toISOString();
}
export function occurrence(template,date){
 const p=localParts(date);
 if(!template.active||template.deleted||p.minutes<template.trigger_minutes)return null;
 if(template.recurrence_type==='weekly'&&p.weekday!==template.recurrence_value)return null;
 if(template.recurrence_type==='monthly'&&p.day!==template.recurrence_value)return null;
 return p.key;
}
