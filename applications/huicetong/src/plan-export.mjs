import * as XLSX from 'xlsx';

export const planColumns=['序号','模块','业务分类','业务模块','工作计划内容','完成质量标准','开始时间','完成时间','责任人','备注'];

export function planRows(items,scope='all'){
 const selected=items.filter(item=>scope==='all'||item.escalated).sort((left,right)=>left.root_name.localeCompare(right.root_name,'zh')||left.parent_name.localeCompare(right.parent_name,'zh')||left.category_name.localeCompare(right.category_name,'zh')||left.created_at.localeCompare(right.created_at)||left.id.localeCompare(right.id));
 return selected.map((item,index)=>[index+1,item.root_name,item.parent_name,item.category_name,item.content,item.quality_standard,item.start_date,item.end_date,[...(item.assignees??[])].sort((left,right)=>left.sort-right.sort).map(person=>person.personName).join('、'),[item.escalated?'拟提报中心计划':null,item.remark].filter(Boolean).join('；')]);
}

export function planWorkbook(title,rows){
 const sheet=XLSX.utils.aoa_to_sheet([[title],planColumns,...rows]);
 const merges=[{s:{r:0,c:0},e:{r:0,c:9}}];
 for(const column of [1,2])for(let start=0;start<rows.length;){let end=start;while(end+1<rows.length&&rows[end+1][column]===rows[start][column]&&(column===1||rows[end+1][1]===rows[start][1]))end++;if(end>start)merges.push({s:{r:start+2,c:column},e:{r:end+2,c:column}});start=end+1;}
 sheet['!merges']=merges;
 sheet['!cols']=[{wch:8},{wch:18},{wch:18},{wch:22},{wch:60},{wch:60},{wch:14},{wch:14},{wch:26},{wch:28}];
 const book=XLSX.utils.book_new();XLSX.utils.book_append_sheet(book,sheet,'月度工作计划');return book;
}
