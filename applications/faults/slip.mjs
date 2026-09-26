// Pasted text is only a draft. Every recognized value stays editable before saving.
const labels={occurredAt:['接报时间','故障时间','发生时间','上报时间'],reporter:['接报人','上报人','报告人'],stationName:['故障车站','车站','地点'],deviceTypeName:['设备类型','设备类别'],deviceNumber:['设备编号','设备号','设备编码','设备'],description:['故障现象','故障描述','故障情况','现象'],reason:['故障原因','原因'],solution:['处置措施','处理措施','解决措施','处置'],arrivalAt:['到达时间','到场时间'],fixedAt:['修复时间','完全修复时间'],status:['是否完全修复','完全修复','修复状态'],powerSwitchRelated:['是否为工电倒切原因','是否工电倒切','工电倒切原因']};
const lookup=new Map(Object.entries(labels).flatMap(([field,names])=>names.map(name=>[name,field])));
function date(value){const match=String(value).match(/(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?\s*(\d{1,2}):(\d{2})/);if(!match)return '';const [,y,m,d,h,min]=match;return `${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}T${h.padStart(2,'0')}:${min}`;}
export function parseSlip(raw){
 const form={},recognized=[],warnings=[];
 for(const line of String(raw).replace(/\r/g,'').split(/[\n；;]/)){
  const match=line.trim().match(/^([^：:]{1,20})[：:]\s*(.+)$/);if(!match)continue;
  const field=lookup.get(match[1].trim());if(!field)continue;
  const value=match[2].trim();if(!value)continue;
  if(['occurredAt','arrivalAt','fixedAt'].includes(field)){const parsed=date(value);if(parsed)form[field]=parsed;else warnings.push(`${match[1]}未识别，请手工核对`);}
  else if(field==='status')form.status=/^(是|已修复|完全修复|已完成|完成)/.test(value)?'fixed':/^(否|未修复|未完成)/.test(value)?'pending':undefined;
  else if(field==='powerSwitchRelated')form.powerSwitchRelated=/^是/.test(value)?'yes':/^否/.test(value)?'no':'';
  else form[field]=value;
  recognized.push({label:match[1].trim(),value});
 }
 if(!recognized.length)warnings.push('未识别到字段，请检查小单格式');
 return {form,recognized,warnings};
}
