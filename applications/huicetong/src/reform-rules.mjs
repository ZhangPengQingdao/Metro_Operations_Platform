export const permissions={monthly:{read:'read',write:'fill',complete:'complete'},supervision:{read:'supervision_read',write:'supervision_manage',complete:'supervision_complete'},annual:{read:'annual_read',write:'annual_manage',complete:'annual_complete'}};
export const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
export const text=(value,max=500,required=true)=>typeof value==='string'&&value.length<=max&&(!required||!!value.trim())&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
export const day=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&!Number.isNaN(Date.parse(value+'T00:00:00Z'))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
export const validMonth=value=>typeof value==='string'&&/^(20\d{2}|2100)-(0[1-9]|1[0-2])$/.test(value);
export const shanghaiDay=(date=new Date())=>new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(date);
export const dayDistance=(from,to)=>Math.round((Date.parse(to+'T00:00:00Z')-Date.parse(from+'T00:00:00Z'))/86400000);
export const fail=code=>{throw Error(code);};
export function keys(value,allowed){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!allowed.includes(key)))fail('INVALID_INPUT');}
export function annualMonths(value){
 if(typeof value==='number'&&Number.isInteger(value)&&value>=1&&value<=12)return [value,value];
 if(typeof value==='number'&&value>=365&&value<80000){const month=new Date(Date.UTC(1899,11,30)+Math.floor(value)*86400000).getUTCMonth()+1;return [month,month];}
 const raw=String(value??'').trim();const date=/^(20\d{2}|2100)[-/](\d{1,2})[-/](\d{1,2})$/.exec(raw);if(date&&day(`${date[1]}-${date[2].padStart(2,'0')}-${date[3].padStart(2,'0')}`))return [Number(date[2]),Number(date[2])];if(/^(全年|每月|全年持续)$/.test(raw))return [1,12];
 const match=/^(\d{1,2})\s*月?\s*(?:[-—–~～至到]\s*(\d{1,2})\s*月?)?$/.exec(raw);
 if(!match)return null;const start=Number(match[1]),end=Number(match[2]??match[1]);return start>=1&&end<=12&&end>=start?[start,end]:null;
}
export function relevantAnnual(rows,month,personId){return rows.filter(row=>row.kind==='annual'&&!row.deleted&&row.status!=='completed'&&row.responsible_id===personId&&row.year===Number(month.slice(0,4))&&row.start_month<=Number(month.slice(5))&&row.end_month>=Number(month.slice(5)));}
export function reminderDue(row,settings,today){
 if(row.deleted||row.status!=='in_progress'||!row.end_date)return false;
 const remaining=dayDistance(today,row.end_date);return remaining===0||remaining===settings.advance_days||remaining<0&&(-remaining)%settings.overdue_every_days===0;
}
export function parseWebhook(value){
 try{const url=new URL(value);if(url.protocol==='https:'&&url.hostname==='qyapi.weixin.qq.com'&&!url.port&&!url.username&&!url.password&&url.pathname==='/cgi-bin/webhook/send'&&url.searchParams.get('key')&&!url.hash)return url.toString();}catch{}
 fail('INVALID_WEBHOOK');
}
export const safeArchiveName=value=>String(value).replace(/[\\/\u0000-\u001f\u007f<>:"|?*]/g,'_').replace(/^\.+/,'_').slice(0,140)||'材料';
