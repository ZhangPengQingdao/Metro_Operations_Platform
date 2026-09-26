import * as XLSX from 'xlsx';
import {readSandboxFile,readSandboxTextFile} from '@metro/platform-sdk/app-files';

export const splitDevices=value=>String(value).split(/[\/\\,，、;；\s]+/).map(part=>part.trim()).filter(Boolean);
export const validDate=value=>/^\d{4}-\d{2}-\d{2}$/.test(value)&&!Number.isNaN(Date.parse(value+'T00:00:00Z'))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
const normalizeDate=value=>{
 if(typeof value==='number')return String(XLSX.SSF.format('yyyy-mm-dd',value));
 const match=String(value??'').trim().replace(/[./年]/g,'-').replace(/月/g,'-').replace(/日/g,'').match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
 return match?`${match[1]}-${match[2].padStart(2,'0')}-${match[3].padStart(2,'0')}`:'';
};

/** Parse a local spreadsheet into plan drafts; the original file stays in the sandbox. */
export async function parsePlanImportFile(file,organizationId){
 const options={maxBytes:2_000_000,extensions:['.xlsx','.xls','.csv']};
 const csv=typeof file?.name==='string'&&file.name.toLowerCase().endsWith('.csv');
 const data=csv?await readSandboxTextFile(file,options):await readSandboxFile(file,options);
 const book=XLSX.read(data,{type:csv?'string':'array',raw:csv,sheetRows:202}),sheet=book.Sheets[book.SheetNames[0]];
 if(!sheet)throw Error('文件中没有可读取的工作表');
 const raw=XLSX.utils.sheet_to_json(sheet,{defval:''});
 if(!raw.length||raw.length>200)throw Error('导入文件需包含 1–200 行计划');
 return raw.map((row,index)=>{
  const entry=Object.fromEntries(Object.entries(row).map(([key,value])=>[key.replace(/\s|[（(].*?[）)]/g,''),value]));
  const scheduledDate=normalizeDate(entry['日期']??entry['计划日期']??entry['检修日期']),stationName=String(entry['车站']??entry['站点']??'').trim(),deviceTypeName=String(entry['设备类型']??entry['类型']??'').trim(),deviceNumbers=splitDevices(entry['设备编号']??entry['设备号']??'');
  if(!validDate(scheduledDate)||!stationName||!deviceTypeName||!deviceNumbers.length||deviceNumbers.length>100)throw Error(`第 ${index+2} 行日期、车站、类型或设备编号不完整`);
  return {organizationId,scheduledDate,stationId:null,stationName,deviceTypeName,content:String(entry['检修内容']??entry['内容']??'').slice(0,500),items:deviceNumbers.map(deviceNumber=>({deviceNumber,operatorId:null,secondaryOperatorId:null,status:'pending'}))};
 });
}
